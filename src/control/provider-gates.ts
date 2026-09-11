import type { FactoryEvent, ProviderQuotaEvent } from "../protocol/events.js";

/** Authenticate every provider gate against its exact durable dispatch and, when claimed, usage receipt. */
export function providerQuotaGates(
  events: readonly FactoryEvent[],
  runId: string,
): ProviderQuotaEvent[] {
  const gates = events
    .filter(
      (event): event is ProviderQuotaEvent =>
        event.kind === "provider" &&
        event.event === "ProviderQuotaBlocked" &&
        event.runId === runId,
    )
    .sort((left, right) => left.sequence - right.sequence);
  for (const gate of gates) {
    const markers = events.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReserved" &&
        event.runId === runId &&
        event.phase === gate.phase &&
        event.modelInvocationId === gate.modelInvocationId &&
        event.workItem === gate.workItem &&
        event.attempt === gate.attempt,
    );
    if (markers.length !== 1)
      throw new Error("provider quota evidence lacks one exact model dispatch marker");
    if (
      gate.accounting === "exact" &&
      !events.some(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.runId === runId &&
          event.phase === gate.phase &&
          event.modelInvocationId === gate.modelInvocationId &&
          event.workItem === gate.workItem &&
          event.attempt === gate.attempt,
      )
    )
      throw new Error("provider quota evidence claims exact accounting without its usage receipt");
  }
  return gates;
}

export function latestProviderQuotaGate(
  events: readonly FactoryEvent[],
  runId: string,
): ProviderQuotaEvent | undefined {
  return providerQuotaGates(events, runId).at(-1);
}
