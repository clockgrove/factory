import type { Outcome, Step, Workflow } from "./engine.js";
import type { ObjectiveState, ObjectiveStatus } from "./state.js";

/**
 * The Objective workflow: check → plan → Work Items → final → report, then
 * cleanup after cancel. Steps are ported onto the core slice by slice; a
 * step that isn't ported yet holds with an honest question, so an Objective
 * on this build always has an answer that works.
 */
const MINUTE = 60_000;

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

export const objectiveWorkflow: Workflow = {
  steps(state: ObjectiveState): Step[] {
    if (state.status === "cancelled")
      return state.done[cleanup.key] ? [] : [cleanup];
    if (state.status === "done" || state.status === "failed") return [];
    for (const key of ["check", "plan", "build", "final", "report"])
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
