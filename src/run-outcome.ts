import { objectiveComplete } from "./completion.js";
import type { IntakeAuthorization } from "./intake.js";
import { objectiveCandidate } from "./qa.js";
import type { ContinuationState } from "./state.js";
import { shortPlanDigest } from "./status-summary.js";

/** Process exit codes for run, supervisor serve and intake run. */
export const EXIT_COMPLETE = 0;
export const EXIT_FAILED = 1;
export const EXIT_NEEDS_DECISION = 2;

/** How a run ended: the exit code and one message naming the next command. */
export function runOutcome(state: ContinuationState): {
  code: number;
  message: string;
} {
  const objective = state.objective;
  const rerun = `factory run --objective ${objective}`;
  if (state.schemaVersion === 7)
    return {
      code: EXIT_NEEDS_DECISION,
      message: state.plan
        ? `Objective #${objective} plan ${shortPlanDigest(state.plan)} needs a decision: ${state.coordinator.waitReason ?? "inspect the plan review"}\nDecide with \`factory decide --objective ${objective} --plan ${shortPlanDigest(state.plan)} --outcome accept|refuse --answer "…" --reason "…"\`, then rerun \`${rerun}\``
        : `Objective #${objective} planning stopped for a decision: ${state.coordinator.waitReason ?? "inspect status"}\nResolve it in the Objective, discard the stopped planning with \`factory decide --objective ${objective} --outcome refuse --reason "…"\`, then rerun \`${rerun}\``,
    };
  if (objectiveComplete(state))
    return {
      code: EXIT_COMPLETE,
      message: `Objective #${objective} completed at ${objectiveCandidate(state)!.commitSha} (${objectiveCandidate(state)!.basis}); final validation passed`,
    };
  if (state.cancelledAt)
    return {
      code: EXIT_FAILED,
      message: `Objective #${objective} was cancelled`,
    };
  return {
    code: EXIT_NEEDS_DECISION,
    message: `Objective #${objective} needs a human decision: ${state.coordinator?.waitReason ?? "inspect status"}\nUse \`factory status --objective ${objective}\` for the pending criterion, AssetSet or failed Work Item, then rerun \`${rerun}\``,
  };
}

/** Intake exits 2 when an Objective stopped the queue for a decision, 1 when a failure paused it. */
export function intakeExitCode(record: IntakeAuthorization): number {
  if (record.observation?.needsDecision) return EXIT_NEEDS_DECISION;
  return record.mode === "paused" && record.observation?.error
    ? EXIT_FAILED
    : EXIT_COMPLETE;
}
