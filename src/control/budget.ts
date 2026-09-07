import type { FactoryEvent } from "../protocol/events.js";
import type { RunPolicy } from "../protocol/policy.js";
import { deduplicateFactoryEvents } from "./receipts.js";
import { assertSupportedModelTokenBudgetIntent } from "../protocol/budget-intent.js";

type BudgetEvent = Extract<FactoryEvent, { kind: "budget" }>;

/** A completed read may predate another in-process write; it cannot revoke known receipts. */
export function mergeAccountingSnapshot(
  known: FactoryEvent[],
  observed: FactoryEvent[],
  accountingRunIds: ReadonlySet<string>,
): FactoryEvent[] {
  return deduplicateFactoryEvents(
    [...known, ...observed].filter((event) => accountingRunIds.has(event.runId)),
  );

export type ModelInvocationIdentity = Pick<BudgetEvent, "objective" | "runId" | "workItem" | "attempt" | "phase"> & { modelInvocationId: string };

export function modelInvocationKey(identity: ModelInvocationIdentity): string {
  return JSON.stringify([identity.objective, identity.runId, identity.workItem ?? null,
    identity.attempt ?? null, identity.phase, identity.modelInvocationId]);
}

export function isModelInvocationMarker(event: FactoryEvent): event is BudgetEvent & { modelInvocationId: string } {
  return event.kind === "budget" && event.event === "BudgetReserved" &&
    event.unit === "model_tokens" && event.modelInvocationId !== undefined;
}

/** Unknown consumption is not zero. Only the exact actual-usage link closes intent. */
export function unresolvedModelInvocations(events: FactoryEvent[], runId?: string): Array<BudgetEvent & { modelInvocationId: string }> {
  const markers = new Map<string, BudgetEvent & { modelInvocationId: string }>();
  const closures = new Map<string, BudgetEvent>();
  for (const event of deduplicateFactoryEvents(events)) {
    if (event.kind !== "budget" || !event.modelInvocationId || (runId && event.runId !== runId)) continue;
    const key = modelInvocationKey({ ...event, modelInvocationId: event.modelInvocationId });
    if (isModelInvocationMarker(event)) {
      const prior = markers.get(key);
      if (prior && (prior.policyDigest !== event.policyDigest || prior.directorEpoch !== event.directorEpoch))
        throw new Error("model invocation has conflicting dispatch bindings");
      if (!prior || event.sequence < prior.sequence) markers.set(key, event);
    } else if (event.event === "BudgetReconciled" && event.unit === "model_tokens") {
      const prior = closures.get(key);
      if (prior && (prior.amount !== event.amount || prior.usageId !== event.usageId || prior.policyDigest !== event.policyDigest || prior.directorEpoch !== event.directorEpoch))
        throw new Error("model invocation has conflicting actual usage receipts");
      closures.set(key, event);
    }
  }
  return [...markers.entries()].filter(([key, marker]) => {
    const closure = closures.get(key);
    if (closure && (closure.policyDigest !== marker.policyDigest || closure.directorEpoch !== marker.directorEpoch))
      throw new Error("model invocation usage conflicts with its dispatch binding");
    return !closure || closure.sequence <= marker.sequence;
  }).map(([, event]) => event);
}

export function assertModelInvocationAdmission(events: FactoryEvent[], policy: RunPolicy, activeInvocationKeys: ReadonlySet<string> = new Set()): void {
  assertSupportedModelTokenBudgetIntent(policy);
  if (unresolvedModelInvocations(events).some((event) => !activeInvocationKeys.has(modelInvocationKey(event))))
    throw new Error("model invocation consumption is unknown; refusing another model invocation");
  const remaining = remainingBudget(policy, deriveBudgetUsage(events));
  if (remaining.modelTokens !== null && remaining.modelTokens <= 0)
    throw new Error("observed model-token threshold is exhausted; refusing another model invocation");
}

export interface BudgetUsage {
  sandboxMinutesReserved: number;
  managedSessionsReserved: number;
  localMilliseconds: number;
  validationMilliseconds: number;
  modelTokens: number;
}

export function deriveBudgetUsage(events: FactoryEvent[]): BudgetUsage {
  const usage: BudgetUsage = {
    sandboxMinutesReserved: 0,
    managedSessionsReserved: 0,
    localMilliseconds: 0,
    validationMilliseconds: 0,
    modelTokens: 0,
  };
  const ledger = new Map<
    string,
    { reserved: number; reconciled?: number; event: Extract<FactoryEvent, { kind: "budget" }> }
  >();
  for (const event of deduplicateFactoryEvents(events).sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (event.kind !== "budget" || isModelInvocationMarker(event)) continue;
    const key = `${event.runId}:${event.workItem}:${event.attempt}:${event.phase}:${event.unit}:${event.usageId ?? "default"}`;
    const entry = ledger.get(key) ?? { reserved: 0, event };
    if (event.event === "BudgetReserved") entry.reserved += event.amount;
    else entry.reconciled = event.amount;
    entry.event = event;
    ledger.set(key, entry);
  }
  for (const { reserved, reconciled, event } of ledger.values()) {
    const amount = reconciled ?? reserved;
    if (event.unit === "sandbox_milliseconds") {
      usage.sandboxMinutesReserved += amount / 60_000;
    } else if (event.unit === "managed_sessions") {
      usage.managedSessionsReserved += amount;
    } else if (event.unit === "local_milliseconds") {
      usage.localMilliseconds += amount;
    } else if (event.unit === "validation_milliseconds") {
      usage.validationMilliseconds += amount;
    } else if (event.unit === "model_tokens") {
      usage.modelTokens += amount;
    }
  }
  return usage;
}

export function unreconciledBudgetReservations(
  events: FactoryEvent[],
): Array<Extract<FactoryEvent, { kind: "budget" }>> {
  const ledger = new Map<
    string,
    {
      reserved: Extract<FactoryEvent, { kind: "budget" }>;
      reconciled: boolean;
    }
  >();
  for (const event of deduplicateFactoryEvents(events).sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (event.kind !== "budget" || isModelInvocationMarker(event)) continue;
    const key = `${event.runId}:${event.workItem}:${event.attempt}:${event.phase}:${event.unit}:${event.usageId ?? "default"}`;
    if (event.event === "BudgetReserved") {
      const prior = ledger.get(key);
      ledger.set(key, { reserved: event, reconciled: prior?.reconciled ?? false });
    } else {
      const prior = ledger.get(key);
      if (prior) prior.reconciled = true;
    }
  }
  return [...ledger.values()]
    .filter(({ reconciled }) => !reconciled)
    .map(({ reserved }) => reserved)
    .concat(unresolvedModelInvocations(events));
}

export function remainingBudget(policy: RunPolicy, usage: BudgetUsage) {
  return {
    sandboxMinutes: Math.max(0, policy.maxSandboxMinutes - usage.sandboxMinutesReserved),
    managedAgentSessions: Math.max(
      0,
      policy.maxManagedAgentSessions - usage.managedSessionsReserved,
    ),
    modelTokens:
      policy.economics === undefined
        ? null
        : Math.max(0, policy.economics.maxModelTokens - usage.modelTokens),
  };
}
