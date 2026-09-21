import type { AttemptEvent, FactoryEvent } from "../protocol/events.js";
import type { RunPolicy } from "../protocol/policy.js";
import { deduplicateFactoryEvents } from "./receipts.js";
import { assertSupportedModelTokenBudgetIntent } from "../protocol/budget-intent.js";

type BudgetEvent = Extract<FactoryEvent, { kind: "budget" }>;
export type ModelInvocationMarker = BudgetEvent & { modelInvocationId: string };
type ModelInvocationBudgetDisposition = BudgetEvent & { modelInvocationId: string };
export type TerminalUnavailableModelInvocation = AttemptEvent & {
  event: "AttemptCancelled";
  modelInvocationId: string;
  producerState: "absent";
  modelUsageAccounting: "terminal-unavailable";
};
export type RecoveryBlockedModelInvocation = AttemptEvent & {
  event: "AttemptRecoveryBlocked";
  modelInvocationId: string;
  producerState: "absent";
  modelUsageAccounting: "unknown";
};

type ModelInvocationClassificationBase = {
  key: string;
  marker: ModelInvocationMarker;
};

export type ModelInvocationAccountingClassification =
  | (ModelInvocationClassificationBase & { status: "open" })
  | (ModelInvocationClassificationBase & {
      status: "ambiguous";
      disposition:
        | ModelInvocationBudgetDisposition
        | TerminalUnavailableModelInvocation
        | RecoveryBlockedModelInvocation;
    })
  | (ModelInvocationClassificationBase & {
      status: "exact";
      disposition: ModelInvocationBudgetDisposition;
    })
  | (ModelInvocationClassificationBase & {
      status: "abandoned";
      disposition: ModelInvocationBudgetDisposition;
    })
  | (ModelInvocationClassificationBase & {
      status: "terminal-unavailable";
      disposition: TerminalUnavailableModelInvocation;
    });

/** A completed read may predate another in-process write; it cannot revoke known receipts. */
export function mergeAccountingSnapshot(
  known: FactoryEvent[],
  observed: FactoryEvent[],
  accountingRunIds: ReadonlySet<string>,
): FactoryEvent[] {
  return deduplicateFactoryEvents(
    [...known, ...observed].filter((event) => accountingRunIds.has(event.runId)),
  );
}

export type ModelInvocationIdentity = Pick<
  BudgetEvent,
  "objective" | "runId" | "workItem" | "attempt" | "phase"
> & { modelInvocationId: string };

export function modelInvocationKey(identity: ModelInvocationIdentity): string {
  return JSON.stringify([
    identity.objective,
    identity.runId,
    identity.workItem ?? null,
    identity.attempt ?? null,
    identity.phase,
    identity.modelInvocationId,
  ]);
}

export function isModelInvocationMarker(event: FactoryEvent): event is ModelInvocationMarker {
  return (
    event.kind === "budget" &&
    event.event === "BudgetReserved" &&
    event.unit === "model_tokens" &&
    event.modelInvocationId !== undefined
  );
}

function sameBudgetDisposition(
  left: ModelInvocationBudgetDisposition,
  right: ModelInvocationBudgetDisposition,
): boolean {
  return (
    left.event === right.event &&
    left.amount === right.amount &&
    left.usageId === right.usageId &&
    left.policyDigest === right.policyDigest &&
    left.directorEpoch === right.directorEpoch &&
    JSON.stringify(left.reportedModelUsage) === JSON.stringify(right.reportedModelUsage)
  );
}

function isTerminalUnavailableDisposition(
  event: FactoryEvent,
): event is TerminalUnavailableModelInvocation {
  return (
    event.kind === "attempt" &&
    event.event === "AttemptCancelled" &&
    event.modelInvocationId !== undefined &&
    event.producerState === "absent" &&
    event.modelUsageAccounting === "terminal-unavailable"
  );
}

function isRecoveryBlockedDisposition(
  event: FactoryEvent,
): event is RecoveryBlockedModelInvocation {
  return (
    event.kind === "attempt" &&
    event.event === "AttemptRecoveryBlocked" &&
    event.modelInvocationId !== undefined &&
    event.producerState === "absent" &&
    event.modelUsageAccounting === "unknown"
  );
}

/**
 * Classifies every durable model dispatch without converting missing counters to zero.
 * Conflicting terminal dispositions or changed immutable bindings fail closed.
 */
export function classifyModelInvocationAccounting(
  events: FactoryEvent[],
  runId?: string,
): ModelInvocationAccountingClassification[] {
  const markers = new Map<string, ModelInvocationMarker>();
  const budgetDispositions = new Map<string, ModelInvocationBudgetDisposition>();
  const terminalDispositions = new Map<string, TerminalUnavailableModelInvocation>();
  const recoveryDispositions = new Map<string, RecoveryBlockedModelInvocation>();
  for (const event of deduplicateFactoryEvents(events)) {
    if (runId && event.runId !== runId) continue;
    if (event.kind === "budget" && event.modelInvocationId) {
      const key = modelInvocationKey({ ...event, modelInvocationId: event.modelInvocationId });
      if (isModelInvocationMarker(event)) {
        const prior = markers.get(key);
        if (
          prior &&
          (prior.policyDigest !== event.policyDigest || prior.directorEpoch !== event.directorEpoch)
        )
          throw new Error("model invocation has conflicting dispatch bindings");
        if (!prior || event.sequence < prior.sequence) markers.set(key, event);
      } else if (
        (event.event === "BudgetReconciled" || event.event === "BudgetAbandoned") &&
        event.unit === "model_tokens"
      ) {
        const disposition: ModelInvocationBudgetDisposition = {
          ...event,
          modelInvocationId: event.modelInvocationId,
        };
        const prior = budgetDispositions.get(key);
        if (prior && !sameBudgetDisposition(prior, disposition))
          throw new Error("model invocation has conflicting actual usage receipts");
        if (!prior || disposition.sequence < prior.sequence)
          budgetDispositions.set(key, disposition);
      }
    } else if (isTerminalUnavailableDisposition(event)) {
      const key = modelInvocationKey({
        ...event,
        phase: "execution",
        modelInvocationId: event.modelInvocationId,
      });
      const prior = terminalDispositions.get(key);
      if (
        prior &&
        (prior.policyDigest !== event.policyDigest ||
          prior.directorEpoch !== event.directorEpoch ||
          prior.baseSha !== event.baseSha ||
          prior.backend !== event.backend)
      )
        throw new Error("model invocation has conflicting terminal-unavailable receipts");
      if (!prior || event.sequence < prior.sequence) terminalDispositions.set(key, event);
    } else if (isRecoveryBlockedDisposition(event)) {
      const key = modelInvocationKey({
        ...event,
        phase: "execution",
        modelInvocationId: event.modelInvocationId,
      });
      const prior = recoveryDispositions.get(key);
      if (
        prior &&
        (prior.policyDigest !== event.policyDigest ||
          prior.directorEpoch !== event.directorEpoch ||
          prior.baseSha !== event.baseSha ||
          prior.backend !== event.backend)
      )
        throw new Error("model invocation has conflicting recovery-blocked receipts");
      if (!prior || event.sequence < prior.sequence) recoveryDispositions.set(key, event);
    }
  }

  for (const key of new Set([...terminalDispositions.keys(), ...recoveryDispositions.keys()]))
    if (!markers.has(key))
      throw new Error(
        "terminal model-accounting disposition has no exact execution dispatch marker",
      );

  return [...markers.entries()].map(([key, marker]) => {
    const budgetDisposition = budgetDispositions.get(key);
    const terminalDisposition = terminalDispositions.get(key);
    const recoveryDisposition = recoveryDispositions.get(key);
    if (
      budgetDisposition &&
      (budgetDisposition.policyDigest !== marker.policyDigest ||
        budgetDisposition.directorEpoch !== marker.directorEpoch)
    )
      throw new Error("model invocation usage conflicts with its dispatch binding");
    if (
      terminalDisposition &&
      (terminalDisposition.policyDigest !== marker.policyDigest ||
        terminalDisposition.directorEpoch !== marker.directorEpoch)
    )
      throw new Error("terminal-unavailable usage conflicts with its dispatch binding");
    if (
      recoveryDisposition &&
      (recoveryDisposition.policyDigest !== marker.policyDigest ||
        recoveryDisposition.directorEpoch !== marker.directorEpoch)
    )
      throw new Error("recovery-blocked usage conflicts with its dispatch binding");
    if (
      (budgetDisposition && terminalDisposition) ||
      (recoveryDisposition && (budgetDisposition || terminalDisposition))
    )
      throw new Error("model invocation has conflicting terminal accounting dispositions");
    const disposition = budgetDisposition ?? terminalDisposition ?? recoveryDisposition;
    if (!disposition) return { key, marker, status: "open" };
    if (terminalDisposition && terminalDisposition.sequence <= marker.sequence)
      throw new Error("terminal-unavailable usage must follow its exact execution dispatch marker");
    if (disposition.sequence <= marker.sequence)
      return { key, marker, status: "ambiguous", disposition };
    if (terminalDisposition)
      return { key, marker, status: "terminal-unavailable", disposition: terminalDisposition };
    if (recoveryDisposition)
      return { key, marker, status: "ambiguous", disposition: recoveryDisposition };
    return {
      key,
      marker,
      status: budgetDisposition!.event === "BudgetAbandoned" ? "abandoned" : "exact",
      disposition: budgetDisposition!,
    };
  });
}

export function terminalUnavailableModelInvocations(
  events: FactoryEvent[],
  runId?: string,
): Array<Extract<ModelInvocationAccountingClassification, { status: "terminal-unavailable" }>> {
  return classifyModelInvocationAccounting(events, runId).filter(
    (
      classification,
    ): classification is Extract<
      ModelInvocationAccountingClassification,
      { status: "terminal-unavailable" }
    > => classification.status === "terminal-unavailable",
  );
}

/** Open or ambiguous consumption is not zero. Terminal-unavailable is reported separately. */
export function unresolvedModelInvocations(
  events: FactoryEvent[],
  runId?: string,
): ModelInvocationMarker[] {
  return classifyModelInvocationAccounting(events, runId)
    .filter(({ status }) => status === "open" || status === "ambiguous")
    .map(({ marker }) => marker);
}

export function assertModelInvocationAdmission(
  events: FactoryEvent[],
  policy: RunPolicy,
  activeInvocationKeys: ReadonlySet<string> = new Set(),
): void {
  assertSupportedModelTokenBudgetIntent(policy);
  if (
    classifyModelInvocationAccounting(events).some(
      ({ key, status }) =>
        status === "terminal-unavailable" ||
        status === "ambiguous" ||
        (status === "open" && !activeInvocationKeys.has(key)),
    )
  )
    throw new Error("model invocation consumption is unknown; refusing another model invocation");
  const remaining = remainingBudget(policy, deriveBudgetUsage(events));
  if (remaining.modelTokens !== null && remaining.modelTokens <= 0)
    throw new Error(
      "observed model-token threshold is exhausted; refusing another model invocation",
    );
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
    if (
      event.kind !== "budget" ||
      isModelInvocationMarker(event) ||
      event.event === "BudgetAbandoned"
    )
      continue;
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
    } else if (event.event === "BudgetReconciled" || event.event === "BudgetAbandoned") {
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
