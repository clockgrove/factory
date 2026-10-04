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

/**
 * A run stopped on a decision or a prerequisite before the Objective had any
 * state. Nothing records it, so `factory retry` has nothing to clear: the
 * operator resolves it and runs the Objective again.
 */
export class AwaitingBeforeState extends Error {
  constructor(
    readonly objective: number,
    readonly detail: string,
    readonly fix?: string,
  ) {
    super(`Objective #${objective} waits before it starts: ${detail}`);
    this.name = "AwaitingBeforeState";
  }
}

/** Exit code and message for a run that stopped before any state existed. */
export function awaitingOutcome(wait: AwaitingBeforeState): {
  code: number;
  message: string;
} {
  return {
    code: EXIT_NEEDS_DECISION,
    message: `Objective #${wait.objective} waits before it starts: ${wait.detail}${wait.fix ? `\nFix: ${wait.fix}` : ""}\nResolve it, then run \`factory run --objective ${wait.objective}\` again`,
  };
}

/**
 * The retry that answers a stop by a defect. A failed Work Item that ended
 * the attempt needs its own new attempt (`--item`); a defect outside any
 * item runs the Objective's step again.
 */
export function stopRetryCommand(state: ContinuationState): string {
  const retry = `factory retry --objective ${state.objective}`;
  if (!("work" in state) || state.error === undefined) return retry;
  // `retry --item` accepts only a failed or cancelled item; an item that
  // finished since the stop (done, published) is answered by the Objective's retry.
  const item = state.errorItem;
  const status = item === undefined ? undefined : state.work[item]?.status;
  return item !== undefined && (status === "failed" || status === "cancelled")
    ? `${retry} --item ${item}`
    : retry;
}

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
    // A failed item whose diagnosis waits repeats it on the next run; a
    // retry would start a new attempt without it.
    if (
      work.status === "failed" &&
      work.recovery?.phase === "diagnosing" &&
      work.wait!.kind === "prerequisite"
    )
      return {
        code: EXIT_NEEDS_DECISION,
        message: `Objective #${objective} Work Item ${id} waits for a prerequisite: ${work.wait!.detail}\nFix: ${work.wait!.fix ?? "see the detail"}; then \`${rerun}\` asks the diagnosis again`,
      };
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
      message: `Objective #${objective} stopped: ${state.error}\nFix the cause, then \`${stopRetryCommand(state)}\` and \`${rerun}\`; or \`factory cancel --objective ${objective}\``,
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
