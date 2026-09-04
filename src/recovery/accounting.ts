import {
  type BudgetUsage,
  deriveBudgetUsage,
  remainingBudget,
  unreconciledBudgetReservations,
} from "../control/budget.js";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";
import { type RunPolicy, parseRunPolicy, policyDigest } from "../protocol/policy.js";

type BudgetEvent = Extract<FactoryEvent, { kind: "budget" }>;
type AttemptEvent = Extract<FactoryEvent, { kind: "attempt" }>;
type Source = { runId: string; workItem?: number; attempt?: number };
export interface RecoveryAccountingAssessment {
  scope: "historical-assessment";
  runIds: string[];
  /** Recorded subtotal only; consult unknownModelUsage before interpreting coverage. */
  usage: BudgetUsage | null;
  remaining: ReturnType<typeof remainingBudget> | null;
  unreconciledReservations: BudgetEvent[];
  unreconciledReservationCount: number;
  unreconciledReservationsTruncated: boolean;
  attemptCount: number;
  attemptWorkItemCount: number;
  attemptCountsTruncated: boolean;
  attemptCounts: Array<{
    workItem: number;
    count: number;
    remaining: number;
    sources: Array<{ runId: string; attempt: number }>;
    sourcesTruncated: boolean;
  }>;
  unknownModelUsage: Array<Source & { phase?: string; reason: string }>;
  unknownModelUsageCount: number;
  diagnosticsTruncated: boolean;
  blockers: Array<{ code: string; reason: string; runId?: string; workItem?: number }>;
  blockerCount: number;
}

const terminalRuns = new Set(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);
const terminalWorkers = new Set([
  "AttemptSucceeded",
  "AttemptFailed",
  "AttemptTimedOut",
  "AttemptCancelled",
  "AttemptDeferred",
]);
const identity = (event: BudgetEvent) =>
  JSON.stringify([
    event.runId,
    event.workItem,
    event.attempt,
    event.phase,
    event.unit,
    event.usageId ?? "default",
  ]);
const safe = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const compilationUsage = (event: BudgetEvent) =>
  event.event === "BudgetReconciled" &&
  event.phase === "management" &&
  event.unit === "model_tokens" &&
  event.workItem === undefined &&
  event.attempt === undefined &&
  /^(?:compile-[0-9a-f]{64}|failed-compile-[0-9a-f]{40})$/.test(event.usageId ?? "");
const reservationSource = (event: BudgetEvent): BudgetEvent => ({
  protocol: event.protocol,
  kind: event.kind,
  event: event.event,
  objective: event.objective,
  runId: event.runId,
  sequence: event.sequence,
  at: event.at,
  phase: event.phase,
  unit: event.unit,
  amount: event.amount,
  ...(event.workItem === undefined ? {} : { workItem: event.workItem }),
  ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
  ...(event.usageId === undefined ? {} : { usageId: event.usageId }),
});

/** Read-only caller-selected, reader-authenticated history; neither predecessor authority nor resource cleanup proof. */
export function assessRecoveryAccounting(input: {
  objective: number;
  repository: string;
  events: FactoryEvent[];
  runIds: readonly string[];
  policy: RunPolicy;
}): RecoveryAccountingAssessment {
  const result: RecoveryAccountingAssessment = {
    scope: "historical-assessment",
    runIds: [],
    usage: null,
    remaining: null,
    unreconciledReservations: [],
    unreconciledReservationCount: 0,
    unreconciledReservationsTruncated: false,
    attemptCount: 0,
    attemptWorkItemCount: 0,
    attemptCountsTruncated: false,
    attemptCounts: [],
    unknownModelUsage: [],
    unknownModelUsageCount: 0,
    diagnosticsTruncated: false,
    blockers: [],
    blockerCount: 0,
  };
  const block = (
    code: string,
    reason: string,
    source: { runId?: string; workItem?: number } = {},
  ) => {
    result.blockerCount++;
    if (result.blockers.length < 200) result.blockers.push({ code, reason, ...source });
    else result.diagnosticsTruncated = true;
  };
  const unknown = (entry: RecoveryAccountingAssessment["unknownModelUsage"][number]) => {
    result.unknownModelUsageCount++;
    if (result.unknownModelUsage.length < 200) result.unknownModelUsage.push(entry);
    else result.diagnosticsTruncated = true;
  };
  if (
    !Number.isSafeInteger(input.objective) ||
    input.objective <= 0 ||
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !Array.isArray(input.runIds) ||
    !Array.isArray(input.events) ||
    input.runIds.length === 0 ||
    input.runIds.length > 100 ||
    input.events.length > 50_000 ||
    input.runIds.some((id) => typeof id !== "string" || !id || id.length > 300) ||
    new Set(input.runIds).size !== input.runIds.length
  ) {
    block(
      "invalid-history-selection",
      "Require a bounded, nonempty, unique run selection and exact Objective/repository identity; repeated runs cannot form a chain.",
    );
    return result;
  }
  result.runIds = [...input.runIds];
  let events: FactoryEvent[];
  let digest: string;
  try {
    parseRunPolicy(input.policy);
    digest = policyDigest(input.policy);
    const selected = new Set(input.runIds);
    events = deduplicateFactoryEvents(
      input.events.filter((event) => selected.has(event.runId)).map(parseFactoryEvent),
    );
  } catch {
    block(
      "invalid-receipts-or-policy",
      "Selected history contains malformed/conflicting authenticated receipts or an invalid policy.",
    );
    return result;
  }
  if (
    events.some(
      (event) => event.objective !== input.objective || !Number.isSafeInteger(event.sequence),
    )
  ) {
    block(
      "history-binding-mismatch",
      "A selected receipt names a different Objective or unsafe sequence.",
    );
    return result;
  }
  let previousTerminal = -1;
  for (const runId of input.runIds) {
    const runEvents = events.filter((event) => event.runId === runId);
    const starts = runEvents.filter(
      (event) => event.kind === "run" && event.event === "FactoryRunStarted",
    );
    const terminals = runEvents.filter((event) => terminalRuns.has(event.event));
    const start = starts[0];
    const terminal = terminals[0];
    if (
      starts.length !== 1 ||
      !start ||
      start.kind !== "run" ||
      start.event !== "FactoryRunStarted" ||
      terminals.length !== 1 ||
      !terminal ||
      terminal.sequence <= start.sequence ||
      start.sequence <= previousTerminal ||
      start.repository.toLowerCase() !== input.repository.toLowerCase() ||
      policyDigest(start.policy) !== start.policyDigest ||
      runEvents.some(
        (event) => "policyDigest" in event && event.policyDigest !== start.policyDigest,
      ) ||
      runEvents.some((event) => event.sequence < start.sequence)
    ) {
      block(
        "invalid-run-history",
        "Each run requires one matching start and later terminal receipt, matching repository/policy, and chronological nonoverlapping selection.",
        { runId },
      );
      continue;
    }
    previousTerminal = terminal.sequence;
  }
  if (result.blockers.length) return result;
  for (const event of events) {
    if (
      event.kind === "run" &&
      event.event === "FactoryRunStarted" &&
      event.policyDigest !== digest
    )
      block(
        "historical-policy-difference",
        "Historical usage remains counted under its source policy; different candidate ceilings require separate explicit authority, not this assessment.",
        { runId: event.runId },
      );
  }

  const budgets = events.filter((event): event is BudgetEvent => event.kind === "budget");
  const ledger = new Map<
    string,
    { reserved: number; reconciled?: number; unit: BudgetEvent["unit"] }
  >();
  for (const event of budgets) {
    if (
      !safe(event.amount) ||
      (["model_tokens", "managed_sessions"].includes(event.unit) &&
        !Number.isSafeInteger(event.amount))
    ) {
      block(
        "unsafe-budget-arithmetic",
        "Historical native-unit amount is not safely representable.",
        { runId: event.runId },
      );
      return result;
    }
    const entry = ledger.get(identity(event)) ?? { reserved: 0, unit: event.unit };
    if (event.event === "BudgetReserved") entry.reserved += event.amount;
    else entry.reconciled = event.amount;
    if (!safe(entry.reserved)) {
      block("unsafe-budget-arithmetic", "Historical reservation sum exceeds safe arithmetic.", {
        runId: event.runId,
      });
      return result;
    }
    ledger.set(identity(event), entry);
  }
  const nativeTotals = new Map<BudgetEvent["unit"], number>();
  for (const entry of ledger.values()) {
    const total = (nativeTotals.get(entry.unit) ?? 0) + (entry.reconciled ?? entry.reserved);
    if (!safe(total)) {
      block("unsafe-budget-arithmetic", "Cumulative native-unit total exceeds safe arithmetic.");
      return result;
    }
    nativeTotals.set(entry.unit, total);
  }
  result.usage = deriveBudgetUsage(events);
  result.remaining = remainingBudget(input.policy, result.usage);
  const outstanding = unreconciledBudgetReservations(events);
  result.unreconciledReservationCount = outstanding.length;
  result.unreconciledReservationsTruncated = outstanding.length > 100;
  result.unreconciledReservations = outstanding.slice(0, 100).map(reservationSource);
  if (outstanding.length)
    block(
      "unreconciled-budget-reservations",
      "Original reservations remain chargeable until independently reconciled; terminal runs do not prove provider cleanup.",
    );

  const attempts = new Map<string, AttemptEvent[]>();
  const workerBudgets = new Map<string, BudgetEvent>();
  const reviewBudgets = new Set<string>();
  const attemptKey = (event: {
    runId: string;
    workItem?: number | undefined;
    attempt?: number | undefined;
  }) => JSON.stringify([event.runId, event.workItem, event.attempt]);
  for (const event of budgets) {
    if (
      event.phase === "management" &&
      event.unit === "model_tokens" &&
      event.event === "BudgetReconciled" &&
      event.workItem !== undefined
    )
      reviewBudgets.add(attemptKey(event));
    if (
      event.phase === "execution" &&
      event.unit === "model_tokens" &&
      event.event === "BudgetReconciled"
    )
      workerBudgets.set(attemptKey(event), event);
  }
  for (const event of events) {
    if (event.kind !== "attempt") continue;
    const key = attemptKey(event);
    const group = attempts.get(key) ?? [];
    group.push(event);
    attempts.set(key, group);
  }
  const counts = new Map<number, RecoveryAccountingAssessment["attemptCounts"][number]>();
  for (const group of attempts.values()) {
    const first = group[0]!;
    const source = { runId: first.runId, workItem: first.workItem, attempt: first.attempt };
    if (
      group.some((event) => event.event === "AttemptValidated") &&
      !reviewBudgets.has(attemptKey(first))
    )
      unknown({
        ...source,
        phase: "management",
        reason:
          "An accepted artifact has no matching semantic-review model-token reconciliation; compilation usage alone does not prove review usage.",
      });
    // Infrastructure-deferred attempts preserve spend but do not consume implementation retries.
    if (!group.some((event) => event.event === "AttemptDeferred")) {
      const entry = counts.get(first.workItem) ?? {
        workItem: first.workItem,
        count: 0,
        remaining: 0,
        sources: [],
        sourcesTruncated: false,
      };
      entry.count++;
      entry.sources.push({ runId: first.runId, attempt: first.attempt });
      counts.set(first.workItem, entry);
    }
    if (!group.some((event) => event.event === "AttemptStarted")) continue;
    const workerUsage = workerBudgets.get(attemptKey(first));
    const terminals = group.filter((event) => terminalWorkers.has(event.event));
    const observed = terminals.filter((event) => event.reportedModelTokens !== undefined);
    if (!terminals.length || !workerUsage || !observed.length) {
      unknown({
        ...source,
        phase: "execution",
        reason:
          "Worker terminal counters or their model-token reconciliation are absent; recorded subtotal is not complete usage.",
      });
    } else if (
      observed.some(
        (event) =>
          !safe(event.reportedModelTokens!) || event.reportedModelTokens !== workerUsage.amount,
      )
    ) {
      block(
        "conflicting-worker-usage",
        "Terminal counters disagree with corresponding recorded model-token usage.",
        source,
      );
    }
  }
  for (const runId of input.runIds) {
    if (!budgets.some((event) => event.runId === runId && compilationUsage(event))) {
      unknown({
        runId,
        phase: "management",
        reason:
          "No Objective-scoped compilation or failed-compilation model-token reconciliation was observed; review receipts cannot establish compilation usage or zero cost.",
      });
    }
  }
  const completeCounts = [...counts.values()].sort((left, right) => left.workItem - right.workItem);
  for (const entry of completeCounts) {
    entry.remaining = Math.max(0, input.policy.maxAttemptsPerItem - entry.count);
    if (entry.remaining === 0)
      block(
        "implementation-attempt-limit",
        "Cumulative attempt ceiling leaves no further implementation retry for this Work Item.",
        { workItem: entry.workItem },
      );
    result.attemptCount += entry.count;
    entry.sourcesTruncated = entry.sources.length > 20;
    entry.sources = entry.sources.slice(0, 20);
  }
  result.attemptWorkItemCount = completeCounts.length;
  result.attemptCountsTruncated = completeCounts.length > 100;
  result.attemptCounts = completeCounts.slice(0, 100);
  if (result.unknownModelUsage.length)
    block(
      "unknown-model-usage",
      "Model usage coverage is incomplete; remaining recorded allowance is not a spending grant.",
    );
  if (result.remaining.modelTokens === 0)
    block(
      "model-token-limit",
      "Cumulative observed model-token threshold is exhausted; no further model invocation is admitted.",
    );
  if (input.policy.maxSandboxMinutes > 0 && result.remaining.sandboxMinutes === 0)
    block("sandbox-minute-limit", "Cumulative sandbox-minute ceiling is exhausted.");
  if (input.policy.maxManagedAgentSessions > 0 && result.remaining.managedAgentSessions === 0)
    block("managed-session-limit", "Cumulative managed-session ceiling is exhausted.");
  return result;
}
