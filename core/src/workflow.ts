import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CoreConfig } from "./config.js";
import type { Outcome, Step, StepContext, Workflow } from "./engine.js";
import { type GitHub, GitHubError, TransientError } from "./github.js";
import { checkSources, parseObjective } from "./objective.js";
import type { ObjectiveState, ObjectiveStatus } from "./state.js";

const run = promisify(execFile);
const MINUTE = 60_000;

/** What steps need from the installation. Absent when Factory has no configuration. */
export interface WorkflowDeps {
  config: CoreConfig;
  github: GitHub;
}

/**
 * The Objective workflow: check → plan → build → final → report, then
 * cleanup after cancel. Steps are ported onto the core slice by slice; a
 * step that isn't ported yet holds with an honest question, so an Objective
 * on this build always has an answer that works.
 */
export function objectiveWorkflow(deps?: WorkflowDeps): Workflow {
  const check = deps ? checkStep(deps) : unavailable("check");
  return {
    steps(state: ObjectiveState): Step[] {
      if (state.status === "cancelled")
        return state.done[cleanup.key] ? [] : [cleanup];
      if (state.status === "done" || state.status === "failed") return [];
      if (!state.done.check) return [check];
      for (const key of ["plan", "build", "final", "report"])
        if (!state.done[key]) return [notBuilt(key)];
      return [];
    },

    status(state: ObjectiveState): ObjectiveStatus {
      if (!state.done.check) return "checking";
      if (!state.done.plan) return "planning";
      if (!state.done.build) return "building";
      if (!state.done.report) return "finishing";
      return "done";
    },
  };
}

/** The check result that planning starts from. */
export interface CheckResult {
  base: string;
  title: string;
  body: string;
}

function checkStep({ config, github }: WorkflowDeps): Step {
  return {
    key: "check",
    deadlineMs: 10 * MINUTE,
    async run({ state, signal }: StepContext): Promise<Outcome> {
      try {
        const issue = await github.rest<{
          title: string;
          body: string | null;
          state: string;
        }>(
          "GET",
          `/repos/${config.repository}/issues/${state.issue}`,
          undefined,
          signal,
        );
        if (issue.state !== "open")
          return {
            kind: "hold",
            question: `Issue #${state.issue} is closed. Reopen it and answer \`recheck\`, or cancel.`,
            answers: ["recheck", "cancel"],
            recommended: "cancel",
          };
        const body = issue.body ?? "";
        const { objective, problems } = parseObjective(body);
        const base = await defaultHead(config.checkout, signal);
        problems.push(
          ...(await checkSources(
            config.checkout,
            base,
            objective.sources,
            signal,
          )),
        );
        if (problems.length)
          return {
            kind: "hold",
            question: `This Objective needs fixing before Factory can plan it:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nEdit the issue, then answer \`recheck\`.`,
            answers: ["recheck", "cancel"],
            recommended: "recheck",
          };
        const result: CheckResult = { base, title: issue.title, body };
        return { kind: "done", result };
      } catch (error) {
        return transientOrThrow(error);
      }
    },
  };
}

/** Fetch the target and return its default branch head. */
async function defaultHead(
  checkout: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    await run(
      "git",
      ["-C", checkout, "fetch", "--quiet", "--prune", "origin"],
      {
        timeout: 5 * MINUTE,
        signal,
      },
    );
    await run(
      "git",
      ["-C", checkout, "remote", "set-head", "origin", "--auto"],
      {
        timeout: MINUTE,
        signal,
      },
    );
    const { stdout } = await run(
      "git",
      [
        "-C",
        checkout,
        "rev-parse",
        "--verify",
        "refs/remotes/origin/HEAD^{commit}",
      ],
      { timeout: MINUTE, signal },
    );
    return stdout.trim();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientError(
      `git fetch in ${checkout}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Transient trouble retries with backoff; anything else counts as an escaped error. */
function transientOrThrow(error: unknown): Outcome {
  if (error instanceof TransientError)
    return {
      kind: "retry",
      reason: error.message,
      ...(error.retryAfterMs !== undefined
        ? { afterMs: error.retryAfterMs }
        : {}),
    };
  if (error instanceof GitHubError && error.status === 404)
    return {
      kind: "hold",
      question: `GitHub says the issue doesn't exist or Factory can't see it (${error.message}).`,
      answers: ["retry", "cancel"],
      recommended: "cancel",
    };
  throw error;
}

function unavailable(key: string): Step {
  return {
    key,
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return {
        kind: "hold",
        question:
          "Factory has no configuration for this repository, so it can't reach GitHub. Run setup, then answer `retry`.",
        answers: ["retry", "cancel"],
        recommended: "retry",
      };
    },
  };
}

function notBuilt(key: string): Step {
  return {
    key,
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return {
        kind: "hold",
        question: `This Factory build can't run the \`${key}\` step yet.`,
        answers: ["retry", "cancel"],
        recommended: "cancel",
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
