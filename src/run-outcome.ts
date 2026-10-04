import { objectiveComplete } from "./completion.js";
import type { IntakeAuthorization } from "./intake.js";
import { objectiveCandidate } from "./qa.js";
import type { ContinuationState } from "./state.js";
import { shortPlanDigest } from "./status-summary.js";
import { awaitsOperator } from "./step.js";

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
  // A step's decision stands until the operator's retry clears it.
  const retry = `factory retry --objective ${objective}`;
  // An Objective step waits for the operator: a prerequisite to fix, or a decision.
  const wait = state.wait;
  if (
    wait?.kind === "prerequisite" &&
    !(state.schemaVersion === 7 && objectiveComplete(state))
  )
    return {
      code: EXIT_NEEDS_DECISION,
      message: `Objective #${objective} waits for a prerequisite: ${wait.detail}\nFix: ${wait.fix ?? "see the detail"}; then \`${retry}\` and \`${rerun}\``,
    };
  if (
    wait?.kind === "decision" &&
    !(state.schemaVersion === 7 && objectiveComplete(state))
  )
    return {
      code: EXIT_NEEDS_DECISION,
      message: `Objective #${objective} needs a decision: ${wait.detail}\nAnswer with \`${retry}\` (the step runs again on \`${rerun}\`), or \`factory cancel --objective ${objective}\``,
    };
  if (state.schemaVersion === 8)
    return {
      code: EXIT_NEEDS_DECISION,
      message: state.plan
        ? state.plan.review.acceptable === false
          ? `Objective #${objective} plan ${shortPlanDigest(state.plan)} cannot be accepted: ${state.coordinator.waitReason ?? "inspect status"}\nRefuse it with \`factory decide --objective ${objective} --plan ${shortPlanDigest(state.plan)} --outcome refuse --reason "…"\`, then rerun \`${rerun}\``
          : `Objective #${objective} plan ${shortPlanDigest(state.plan)} needs a decision: ${state.coordinator.waitReason ?? "inspect the plan review"}\nDecide with \`factory decide --objective ${objective} --plan ${shortPlanDigest(state.plan)} --outcome accept|refuse --answer "…" --reason "…"\`, then rerun \`${rerun}\``
        : `Objective #${objective}: ${state.coordinator.waitReason ?? "planning stopped for a decision; inspect status"}\nResolve it in the Objective, discard the stopped planning with \`factory decide --objective ${objective} --outcome refuse --reason "…"\`, then rerun \`${rerun}\``,
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
  // A Work Item step waits for the operator: its question or fix names the answer.
  const asked = Object.entries(state.work).find(([, work]) =>
    awaitsOperator(work.wait),
  );
  if (asked) {
    const [id, work] = asked;
    const itemRetry = `${retry} --item ${id}`;
    return {
      code: EXIT_NEEDS_DECISION,
      message:
        work.wait!.kind === "prerequisite"
          ? `Objective #${objective} Work Item ${id} waits for a prerequisite: ${work.wait!.detail}\nFix: ${work.wait!.fix ?? "see the detail"}; then \`${itemRetry}\` and \`${rerun}\``
          : `Objective #${objective} Work Item ${id} needs a decision: ${work.wait!.detail}\nAnswer with \`${itemRetry}\` (the step runs again on \`${rerun}\`), or \`factory cancel --objective ${objective}\``,
    };
  }
  if (state.error)
    return {
      code: EXIT_FAILED,
      message: `Objective #${objective} stopped: ${state.error}\nFix the cause, then \`${retry}\` and \`${rerun}\`; or \`factory cancel --objective ${objective}\``,
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
