import type { Outcome, Step, StepContext, Workflow } from "./engine.js";
import {
  guarded,
  type PlanningDeps,
  planningStep,
  readObjective,
} from "./planning/steps.js";
import type { ObjectiveState, ObjectiveStatus } from "./state.js";
import {
  type BuildDeps,
  buildSteps,
  built,
  cancelCleanupStep,
  finalReviewStep,
  finalStep,
  reportStep,
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
      if (state.status === "done" || state.status === "failed") return [];
      if (!state.done.check) return [check];
      if (!state.done.plan) {
        const step = deps ? planningStep(state, deps) : unavailable("plan");
        return step ? [step] : [];
      }
      if (!deps) return [unavailable("build")];
      if (!built(state)) return buildSteps(state, deps);
      if (!state.done.final) return [finalStep(deps)];
      if (!state.done["final-review"]) return [finalReviewStep(deps)];
      if (!state.done.report) return [reportStep(deps)];
      return [];
    },

    status(state: ObjectiveState): ObjectiveStatus {
      if (!state.done.check) return "checking";
      if (!state.done.plan) return "planning";
      if (!built(state)) return "building";
      if (!state.done.report) return "finishing";
      return "done";
    },
  };
}

/** The issue is open, the Objective passes its checks, and the base is the default branch head. */
function checkStep(deps: PlanningDeps): Step {
  return {
    key: "check",
    deadlineMs: 10 * MINUTE,
    run: ({ state, signal }: StepContext) =>
      guarded(async (): Promise<Outcome> => {
        const read = await readObjective(state.issue, deps, "recheck", signal);
        return "hold" in read
          ? read.hold
          : { kind: "done", result: read.inputs };
      }),
  };
}

function unavailable(key: string): Step {
  return {
    key,
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return {
        kind: "hold",
        question:
          "Factory has no configuration for this repository, so it can't reach GitHub. Run setup and restart the service; then answer `retry`.",
        answers: ["retry", "cancel"],
        recommended: "retry",
      };
    },
  };
}

const cleanup: Step = {
  key: "cancel:cleanup",
  deadlineMs: 10 * MINUTE,
  async run(): Promise<Outcome> {
    // Closing open PRs and removing worktrees arrive with delivery.
    return { kind: "done" };
  },
};
