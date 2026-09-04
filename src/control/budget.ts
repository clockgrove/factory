import type { FactoryEvent } from "../protocol/events.js";
import type { RunPolicy } from "../protocol/policy.js";
import { deduplicateFactoryEvents } from "./receipts.js";

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
    if (event.kind !== "budget") continue;
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
    if (event.kind !== "budget") continue;
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
    .map(({ reserved }) => reserved);
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
