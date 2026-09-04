import type { FactoryEvent } from "../protocol/events.js";
import type { RunPolicy } from "../protocol/policy.js";
import { deduplicateFactoryEvents, latestRunReceipts } from "../control/receipts.js";

export type EvidenceMetric<T> =
  | {
      availability: "observed";
      value: T;
      source: "github-receipts" | "provider-receipt";
      evidenceCount: number;
    }
  | {
      availability: "conservative-estimate";
      value: T;
      source: "matching-history";
      evidenceCount: number;
      method: string;
    }
  | { availability: "unavailable"; reason: string };

export interface DurationFingerprint {
  taskClass: string;
  backendId: string;
  trust: "trusted_local" | "isolated";
  os: readonly string[];
  architecture: readonly string[];
  tools: readonly string[];
}

export interface DurationEvidenceSample extends DurationFingerprint {
  evidenceId: string;
  completedAt: string;
  durationMs: number;
  outcome: "succeeded" | "failed" | "cancelled";
  durable: boolean;
}

export interface DurationEstimate {
  durationMs: EvidenceMetric<number>;
  matchingEvidenceIds: string[];
}

function normalizedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameFingerprint(query: DurationFingerprint, sample: DurationEvidenceSample): boolean {
  return (
    query.taskClass === sample.taskClass &&
    query.backendId === sample.backendId &&
    query.trust === sample.trust &&
    JSON.stringify(normalizedSet(query.os)) === JSON.stringify(normalizedSet(sample.os)) &&
    JSON.stringify(normalizedSet(query.architecture)) ===
      JSON.stringify(normalizedSet(sample.architecture)) &&
    JSON.stringify(normalizedSet(query.tools)) === JSON.stringify(normalizedSet(sample.tools))
  );
}

/**
 * Historical duration feedback is exact-match only. The estimate never falls
 * below the slowest matching success, and sparse evidence receives a larger
 * safety margin instead of being presented with false precision.
 */
export function estimateDuration(
  query: DurationFingerprint,
  samples: readonly DurationEvidenceSample[],
): DurationEstimate {
  const matching = samples
    .filter(
      (sample) =>
        sample.durable &&
        sample.outcome === "succeeded" &&
        Number.isFinite(sample.durationMs) &&
        sample.durationMs > 0 &&
        Number.isFinite(Date.parse(sample.completedAt)) &&
        sameFingerprint(query, sample),
    )
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
  if (matching.length === 0) {
    return {
      durationMs: {
        availability: "unavailable",
        reason:
          "no durable successful sample matches task class, backend, trust, OS, architecture, and tools",
      },
      matchingEvidenceIds: [],
    };
  }
  const slowest = Math.max(...matching.map((sample) => sample.durationMs));
  const multiplier = matching.length === 1 ? 1.5 : matching.length === 2 ? 1.25 : 1.1;
  return {
    durationMs: {
      availability: "conservative-estimate",
      value: Math.ceil(slowest * multiplier),
      source: "matching-history",
      evidenceCount: matching.length,
      method: `slowest matching success plus ${Math.round((multiplier - 1) * 100)}% sparse-evidence margin`,
    },
    matchingEvidenceIds: matching.map((sample) => sample.evidenceId),
  };
}

export type NativeBudgetUnit =
  | "model_tokens"
  | "local_milliseconds"
  | "sandbox_milliseconds"
  | "managed_sessions"
  | "validation_milliseconds";

export interface NativeUnitLedger {
  unit: NativeBudgetUnit;
  reserved: number;
  reconciled: number;
  outstanding: number;
  reservations: number;
  reconciliations: number;
}

interface LedgerEntry {
  reserved: number;
  reconciled?: number;
}

function budgetUsageKey(event: Extract<FactoryEvent, { kind: "budget" }>): string {
  return [
    event.runId,
    event.workItem ?? "management",
    event.attempt ?? "management",
    event.phase,
    event.unit,
    event.usageId ?? "default",
  ].join(":");
}

/** Reconcile native-unit reservations exactly as the durable GitHub ledger records them. */
export function nativeUnitLedgers(
  events: readonly FactoryEvent[],
  runId?: string,
): NativeUnitLedger[] {
  const units: readonly NativeBudgetUnit[] = [
    "model_tokens",
    "local_milliseconds",
    "sandbox_milliseconds",
    "managed_sessions",
    "validation_milliseconds",
  ];
  const ledgers = new Map<NativeBudgetUnit, Map<string, LedgerEntry>>(
    units.map((unit) => [unit, new Map()]),
  );
  const counts = new Map<NativeBudgetUnit, { reservations: number; reconciliations: number }>(
    units.map((unit) => [unit, { reservations: 0, reconciliations: 0 }]),
  );
  for (const event of deduplicateFactoryEvents([...events]).sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (event.kind !== "budget" || (runId && event.runId !== runId)) continue;
    const key = budgetUsageKey(event);
    const ledger = ledgers.get(event.unit)!;
    const current = ledger.get(key) ?? { reserved: 0 };
    const count = counts.get(event.unit)!;
    if (event.event === "BudgetReserved") {
      current.reserved += event.amount;
      count.reservations += 1;
    } else {
      current.reconciled = event.amount;
      count.reconciliations += 1;
    }
    ledger.set(key, current);
  }
  return units.map((unit) => {
    const entries = [...ledgers.get(unit)!.values()];
    const reserved = entries.reduce((sum, entry) => sum + entry.reserved, 0);
    const reconciled = entries.reduce((sum, entry) => sum + (entry.reconciled ?? 0), 0);
    const committed = entries.reduce((sum, entry) => sum + (entry.reconciled ?? entry.reserved), 0);
    return {
      unit,
      reserved,
      reconciled,
      outstanding: Math.max(0, committed - reconciled),
      ...counts.get(unit)!,
    };
  });
}

function observedUsage(ledger: NativeUnitLedger): EvidenceMetric<number> {
  return ledger.reconciliations > 0
    ? {
        availability: "observed",
        value: ledger.reconciled,
        source: "github-receipts",
        evidenceCount: ledger.reconciliations,
      }
    : {
        availability: "unavailable",
        reason: `no reconciled ${ledger.unit} receipt is available`,
      };
}

export interface ReportedTokenSubtotal {
  /** Sum only supplied counters; missing counters are not inferred as zero. */
  tokens: EvidenceMetric<number>;
  receiptsWithValue: number;
  receiptsWithoutValue: number;
}

export interface ModelTokenBreakdown {
  /** Coverage is of recorded model-token calls, not all provider activity. */
  source: "model-token-reconciliations";
  reconciledCalls: number;
  inputTokens: ReportedTokenSubtotal;
  outputTokens: ReportedTokenSubtotal;
  cachedInputTokens: ReportedTokenSubtotal;
}

export function modelTokenBreakdown(
  events: readonly FactoryEvent[],
  runId?: string,
): ModelTokenBreakdown {
  const calls = new Map<string, Extract<FactoryEvent, { kind: "budget" }>>();
  for (const event of deduplicateFactoryEvents([...events]).sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (
      event.kind !== "budget" ||
      event.event !== "BudgetReconciled" ||
      event.unit !== "model_tokens" ||
      (runId && event.runId !== runId)
    ) {
      continue;
    }
    // Use the same latest-per-usage identity as the scalar ledger. An Attempt
    // receipt is a second copy of the evidence, not another billable call.
    calls.set(budgetUsageKey(event), event);
  }
  const subtotal = (
    field: "inputTokens" | "outputTokens" | "cachedInputTokens",
  ): ReportedTokenSubtotal => {
    let value = 0;
    let receiptsWithValue = 0;
    for (const call of calls.values()) {
      const count = call.reportedModelUsage?.[field];
      if (count !== undefined) {
        value += count;
        receiptsWithValue += 1;
      }
    }
    return {
      tokens:
        receiptsWithValue > 0
          ? {
              availability: "observed",
              value,
              source: "github-receipts",
              evidenceCount: receiptsWithValue,
            }
          : {
              availability: "unavailable",
              reason: `no reconciled model-token receipt reports ${field}`,
            },
      receiptsWithValue,
      receiptsWithoutValue: calls.size - receiptsWithValue,
    };
  };
  return {
    source: "model-token-reconciliations",
    reconciledCalls: calls.size,
    inputTokens: subtotal("inputTokens"),
    outputTokens: subtotal("outputTokens"),
    cachedInputTokens: subtotal("cachedInputTokens"),
  };
}

export interface ProviderBillingEvidence {
  provider: string;
  receiptId: string;
  amount: number;
  currency: string;
}

export interface EconomicSummary {
  nativeUnits: NativeUnitLedger[];
  usage: Record<NativeBudgetUnit, EvidenceMetric<number>>;
  modelTokenBreakdown: ModelTokenBreakdown;
  budgets: {
    sandboxMilliseconds: { configured: number; committed: number; remaining: number };
    managedSessions: { configured: number; committed: number; remaining: number };
    modelTokens: EvidenceMetric<{
      configured: number;
      committed: number;
      remaining: number;
    }>;
  };
  providerCost: EvidenceMetric<Array<{ provider: string; amount: number; currency: string }>>;
}

export function summarizeEconomics(input: {
  events: readonly FactoryEvent[];
  policy: RunPolicy;
  runId?: string;
  billing?: readonly ProviderBillingEvidence[];
}): EconomicSummary {
  const nativeUnits = nativeUnitLedgers(input.events, input.runId);
  const byUnit = new Map(nativeUnits.map((ledger) => [ledger.unit, ledger]));
  const sandbox = byUnit.get("sandbox_milliseconds")!;
  const managed = byUnit.get("managed_sessions")!;
  const tokens = byUnit.get("model_tokens")!;
  const sandboxCommitted = sandbox.reconciled + sandbox.outstanding;
  const managedCommitted = managed.reconciled + managed.outstanding;
  const tokenCommitted = tokens.reconciled + tokens.outstanding;
  const configuredTokens = input.policy.economics?.maxModelTokens;
  const validBilling = (input.billing ?? []).filter(
    (item) =>
      item.provider.length > 0 &&
      item.receiptId.length > 0 &&
      Number.isFinite(item.amount) &&
      item.amount >= 0 &&
      /^[A-Z]{3}$/.test(item.currency),
  );
  const groupedBilling = new Map<string, { provider: string; amount: number; currency: string }>();
  for (const item of validBilling) {
    const key = `${item.provider}:${item.currency}`;
    const current = groupedBilling.get(key) ?? {
      provider: item.provider,
      amount: 0,
      currency: item.currency,
    };
    current.amount += item.amount;
    groupedBilling.set(key, current);
  }
  return {
    nativeUnits,
    modelTokenBreakdown: modelTokenBreakdown(input.events, input.runId),
    usage: Object.fromEntries(
      nativeUnits.map((ledger) => [ledger.unit, observedUsage(ledger)]),
    ) as Record<NativeBudgetUnit, EvidenceMetric<number>>,
    budgets: {
      sandboxMilliseconds: {
        configured: input.policy.maxSandboxMinutes * 60_000,
        committed: sandboxCommitted,
        remaining: Math.max(0, input.policy.maxSandboxMinutes * 60_000 - sandboxCommitted),
      },
      managedSessions: {
        configured: input.policy.maxManagedAgentSessions,
        committed: managedCommitted,
        remaining: Math.max(0, input.policy.maxManagedAgentSessions - managedCommitted),
      },
      modelTokens:
        configuredTokens === undefined
          ? {
              availability: "unavailable",
              reason: "the run policy has no enforceable model-token ceiling",
            }
          : {
              availability: "observed",
              value: {
                configured: configuredTokens,
                committed: tokenCommitted,
                remaining: Math.max(0, configuredTokens - tokenCommitted),
              },
              source: "github-receipts",
              evidenceCount: tokens.reservations + tokens.reconciliations,
            },
    },
    providerCost:
      validBilling.length === 0
        ? {
            availability: "unavailable",
            reason: "no provider billing receipt is present; Factory does not infer dollar cost",
          }
        : {
            availability: "observed",
            value: [...groupedBilling.values()].sort((left, right) =>
              `${left.provider}:${left.currency}`.localeCompare(
                `${right.provider}:${right.currency}`,
              ),
            ),
            source: "provider-receipt",
            evidenceCount: validBilling.length,
          },
  };
}

export interface RunSummary {
  runId: string;
  outcome: "active" | "completed" | "cancelled" | "escalated";
  startedAt: string;
  finishedAt?: string;
  elapsedMilliseconds: EvidenceMetric<number>;
  attempts: {
    total: number;
    active: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    cancelled: number;
    deferred: number;
    integrated: number;
  };
  validation: { recorded: number; passed: number; failed: number };
  delivery: {
    selected: "regular-prs" | "native-stacks" | "escalate" | "unavailable";
    publications: number;
    integrationsCompleted: number;
  };
  economics: EconomicSummary;
  evidence: { eventCount: number; firstSequence: number; lastSequence: number };
}

function terminalAttemptName(events: readonly FactoryEvent[]): string | null {
  const attemptEvents = events.filter((event) => event.kind === "attempt");
  for (const name of [
    "AttemptIntegrated",
    "AttemptDeferred",
    "AttemptCancelled",
    "AttemptTimedOut",
    "AttemptFailed",
    "AttemptSucceeded",
  ] as const) {
    if (attemptEvents.some((event) => event.event === name)) return name;
  }
  return null;
}

/** Reconcile one run solely from durable, deduplicated GitHub evidence. */
export function summarizeRun(
  events: readonly FactoryEvent[],
  policy?: RunPolicy,
): RunSummary | null {
  const receiptSet = latestRunReceipts([...events]);
  if (!receiptSet) return null;
  const runEvents = receiptSet.events;
  const attemptGroups = new Map<string, FactoryEvent[]>();
  for (const event of runEvents) {
    if (event.kind !== "attempt") continue;
    const key = `${event.workItem}:${event.attempt}`;
    const group = attemptGroups.get(key) ?? [];
    group.push(event);
    attemptGroups.set(key, group);
  }
  const terminalNames = [...attemptGroups.values()].map(terminalAttemptName);
  const count = (name: string) => terminalNames.filter((value) => value === name).length;
  const terminal = receiptSet.terminal;
  const outcome = !terminal
    ? "active"
    : terminal.event === "FactoryRunCompleted"
      ? "completed"
      : terminal.event === "FactoryRunCancelled"
        ? "cancelled"
        : "escalated";
  const startMs = Date.parse(receiptSet.start.at);
  const finishMs = terminal ? Date.parse(terminal.at) : null;
  const effectivePolicy = policy ?? receiptSet.start.policy;
  const validations = runEvents.filter((event) => event.kind === "validation");
  const delivery = [...runEvents].reverse().find((event) => event.kind === "delivery");
  const publications = runEvents.filter(
    (event) => event.kind === "publication" && event.event === "PublicationRecorded",
  );
  return {
    runId: receiptSet.runId,
    outcome,
    startedAt: receiptSet.start.at,
    ...(terminal ? { finishedAt: terminal.at } : {}),
    elapsedMilliseconds:
      finishMs === null
        ? {
            availability: "unavailable",
            reason: "the run is active and has no terminal GitHub receipt",
          }
        : {
            availability: "observed",
            value: Math.max(0, finishMs - startMs),
            source: "github-receipts",
            evidenceCount: 2,
          },
    attempts: {
      total: attemptGroups.size,
      active: terminalNames.filter((value) => value === null).length,
      succeeded: count("AttemptSucceeded"),
      failed: count("AttemptFailed"),
      timedOut: count("AttemptTimedOut"),
      cancelled: count("AttemptCancelled"),
      deferred: count("AttemptDeferred"),
      integrated: count("AttemptIntegrated"),
    },
    validation: {
      recorded: validations.length,
      passed: validations.filter((event) => event.kind === "validation" && event.passed).length,
      failed: validations.filter((event) => event.kind === "validation" && !event.passed).length,
    },
    delivery: {
      selected: delivery?.kind === "delivery" ? delivery.selected : "unavailable",
      publications: publications.length,
      integrationsCompleted: runEvents.filter(
        (event) => event.kind === "publication" && event.event === "IntegrationCompleted",
      ).length,
    },
    economics: summarizeEconomics({
      events: runEvents,
      policy: effectivePolicy,
      runId: receiptSet.runId,
    }),
    evidence: {
      eventCount: runEvents.length,
      firstSequence: runEvents[0]?.sequence ?? receiptSet.start.sequence,
      lastSequence: runEvents.at(-1)?.sequence ?? receiptSet.start.sequence,
    },
  };
}
