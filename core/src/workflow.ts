import {
  errored,
  hold,
  type Outcome,
  objectiveWide,
  type Step,
  type StepContext,
  type Workflow,
} from "./engine.js";
import { GitRefusal } from "./git.js";
import { githubOutcome } from "./github.js";
import { currentPlan } from "./planning/plan.js";
import {
  type PlanningDeps,
  planningReplan,
  planningStep,
  REOPENED,
  readObjective,
} from "./planning/steps.js";
import { PlannerError, providerOutcome } from "./providers/planner.js";
import type { ObjectiveState, ObjectiveStatus } from "./state.js";
import { errorMessage } from "./text.js";
import {
  type BuildDeps,
  built,
  cancelCleanupStep,
  deliverySteps,
  layersBelow,
  RERUN,
  RERUN_CLEANUP,
  replanOutcome,
  rerunCleanupStep,
} from "./work/steps.js";

const MINUTE = 60_000;

/**
 * The Objective workflow: check → plan → build → final → report, then
 * cleanup after cancel. Steps are ported onto the core slice by slice; a
 * step that isn't ported yet holds with an honest question, so an Objective
 * on this build always has an answer that works. `deps` is absent when
 * Factory has no configuration.
 */
export function objectiveWorkflow(deps?: BuildDeps): Workflow {
  const check = deps ? checkStep(deps) : unavailable("check");
  return {
    steps(state: ObjectiveState): Step[] {
      if (state.status === "cancelled") {
        const step = deps ? cancelCleanupStep(deps) : cleanup;
        return state.done[step.key] ? [] : [step];
      }
      if (state.status === "done") return [];
      if (deps && state.kept?.[RERUN]) return [rerunCleanupStep(deps)];
      if (!state.done.check) return [check];
      if (!currentPlan(state)) {
        const step = deps ? planningStep(state, deps) : unavailable("plan");
        return step ? [step] : [];
      }
      if (!deps) return [unavailable("build")];
      return deliverySteps(state, deps);
    },

    upstream: (state, item) => (deps ? layersBelow(state, deps, item) : []),

    status(state: ObjectiveState): ObjectiveStatus {
      if (!state.done.check) return "checking";
      if (!currentPlan(state)) return "planning";
      if (!built(state)) return "building";
      if (!state.done.report) return "finishing";
      return "done";
    },

    outcomeOf: (error, step) =>
      errorOutcome(error, deps?.config.repository ?? "", step.redo),

    replannable: (state, key) =>
      currentPlan(state)
        ? /^(item|build):/.test(key) ||
          ["final", "final-review", "report"].includes(key)
        : /^(plan|review|decide):\d+:\d+$/.test(key),

    // Before acceptance a new planning generation re-reads the issue;
    // after it, the plan and the build are forgotten and the Objective is
    // checked again.
    replan: (state, key, answer) =>
      currentPlan(state)
        ? replanOutcome(state)
        : planningReplan(state, key, answer),
  };
}

/**
 * An error that escaped a step as its outcome (CORE.md#Waits), the one
 * place errors are classified: a full disk, and a Git refusal (the
 * checkout's configuration, or an origin that no longer names the
 * target), hold for the whole Objective; a provider's classified failure
 * and GitHub's answers map as providers/planner.ts `providerOutcome` and
 * github.ts `githubOutcome` say; anything else is an error. `redo` is the
 * answer that gets past a call too large for the model (`Step.redo`).
 */
export function errorOutcome(
  error: unknown,
  repository: string,
  redo: "replan" | "refuse" = "replan",
): Outcome {
  // A full disk needs a person; retrying can't free it.
  if ((error as NodeJS.ErrnoException | null)?.code === "ENOSPC")
    return objectiveWide(
      hold(
        `The service host's disk is full (${errorMessage(error)}). Free space, then answer retry; or cancel.`,
      ),
    );
  if (error instanceof GitRefusal) return objectiveWide(hold(error.message));
  // A usage limit waits for its reset; an idle model is an error; a hold
  // takes the provider error's scope. Too large for the model, or refused:
  // the Objective (or the step's input) has to change.
  if (error instanceof PlannerError)
    return providerOutcome(error, (message) =>
      objectiveWide({
        ...hold(
          redo === "replan"
            ? `${message}\n\nEdit the Objective (for example, pin smaller Sources) and answer \`replan\`.`
            : `${message}\n\n\`refuse\` rejects this amendment, so it can be replaced or the plan can continue without it.`,
          [redo, "retry", "cancel"],
        ),
        cause: "failure",
      }),
    );
  return (
    githubOutcome(error, repository) ?? errored(`error: ${errorMessage(error)}`)
  );
}

/** The issue is open, the Objective passes its checks, and the base is the default branch head. */
function checkStep(deps: PlanningDeps): Step {
  return {
    key: "check",
    resource: "github",
    deadlineMs: 10 * MINUTE,
    run: async (context: StepContext): Promise<Outcome> => {
      const read = await readObjective(deps, "recheck", context);
      return "hold" in read
        ? read.hold
        : { kind: "done", result: read.inputs, keep: { [REOPENED]: null } };
    },
  };
}

function unavailable(key: string): Step {
  return {
    key,
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return hold(
        "Factory has no configuration for this repository, so it can't reach GitHub. Run setup and restart the service; then answer `retry`.",
      );
    },
  };
}

const cleanup: Step = {
  key: "cancel:cleanup",
  deadlineMs: 10 * MINUTE,
  neverAsks: true,
  async run(): Promise<Outcome> {
    // Closing open PRs and removing worktrees arrive with delivery.
    return { kind: "done" };
  },
};

/**
 * Whether the Objective has started: a step past the check (and a
 * re-run's cleanup) is done, waiting, asking or running. The one rule for
 * queue order and for withdrawal before start.
 */
export function started(state: ObjectiveState): boolean {
  return [
    ...Object.keys(state.done),
    ...Object.keys(state.retries),
    ...Object.keys(state.asking),
    ...Object.keys(state.attempts),
  ].some((key) => key !== "check" && key !== RERUN_CLEANUP);
}
