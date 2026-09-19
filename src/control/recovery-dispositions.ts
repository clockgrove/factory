import type { AttemptEvent, FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents } from "./receipts.js";

export type AttemptRecoveryBlockedEvent = AttemptEvent & {
  event: "AttemptRecoveryBlocked";
  modelInvocationId: string;
  producerState: "absent";
  sameAttemptResume: "unavailable";
  terminalEvidence: "unavailable";
  artifactEvidence: "unavailable";
  modelUsageAccounting: "unknown";
  nextDisposition: "explicit-recovery";
};

/**
 * Read one fail-closed recovery disposition only when its original model
 * dispatch marker is present. The event schema fixes every outcome field; this
 * reader supplies the cross-event binding that a single event cannot prove.
 */
export function attemptRecoveryBlocks(
  events: readonly FactoryEvent[],
  runId: string,
): AttemptRecoveryBlockedEvent[] {
  const scoped = deduplicateFactoryEvents([...events]).filter((event) => event.runId === runId);
  const blocks = scoped.filter(
    (event): event is AttemptRecoveryBlockedEvent =>
      event.kind === "attempt" && event.event === "AttemptRecoveryBlocked",
  );
  const identities = new Set<string>();
  for (const block of blocks) {
    const identity = `${block.workItem}:${block.attempt}`;
    if (identities.has(identity))
      throw new Error("attempt recovery-blocked evidence is duplicated");
    identities.add(identity);
    const markers = scoped.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReserved" &&
        event.phase === "execution" &&
        event.unit === "model_tokens" &&
        event.workItem === block.workItem &&
        event.attempt === block.attempt &&
        event.modelInvocationId === block.modelInvocationId &&
        event.directorEpoch === block.directorEpoch &&
        event.policyDigest === block.policyDigest,
    );
    if (markers.length !== 1)
      throw new Error(
        "attempt recovery-blocked evidence lacks one exact original model dispatch marker",
      );
  }
  return blocks;
}

export function attemptRecoveryBlockForAttempt(
  events: readonly FactoryEvent[],
  runId: string,
  workItem: number,
  attempt: number,
): AttemptRecoveryBlockedEvent | undefined {
  return attemptRecoveryBlocks(events, runId).find(
    (event) => event.workItem === workItem && event.attempt === attempt,
  );
}
