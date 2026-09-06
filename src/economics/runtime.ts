import { createHash } from "node:crypto";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import { queuedReasonCode } from "../explanations/index.js";
import type { FactoryEvent } from "../protocol/events.js";
import type { EvidenceMetric, NativeBudgetUnit } from "./index.js";

type Attempt = Extract<FactoryEvent, { kind: "attempt" }>;
type Capacity = Extract<FactoryEvent, { kind: "capacity" }>;
type Budget = Extract<FactoryEvent, { kind: "budget" }>;
type Location = "local" | "cloud" | "unclassified";
type Interval = { start: number; end: number; location: Location };
type Locations = Record<Location, number> & { total: number };

export interface RuntimeEconomics {
  scope: "current-run-recorded-receipts";
  execution: {
    startedAttempts: EvidenceMetric<Locations>;
    completeIntervals: number;
    unresolvedOrConflictingAttempts: number;
    unresolvedCapacityIntervals: number;
    unsupportedExecutionCapacityReceipts: number;
    closedIntervalTime: EvidenceMetric<{
      summedWorkerMilliseconds: number;
      wallMillisecondsWithAnyWorker: number;
      method: "AttemptStarted-to-first-execution-terminal; closed intervals only; GitHub observation time, not CPU time";
    }>;
  };
  validation: {
    admittedInvocations: EvidenceMetric<Locations>;
    completedCapacityIntervals: number;
    unresolvedOrConflictingInvocations: number;
    validationResultsWithoutAdmissionEvidence: number;
  };
  admittedLocalConcurrency: EvidenceMetric<{
    peak: number;
    average: number;
    localReservationMilliseconds: number;
    denominatorMilliseconds: number;
    windowStart: string;
    windowEnd: string;
    intervals: number;
    method: "time-weighted execution-and-validation reservations over the terminal run window; idle time included";
  }>;
  retries: EvidenceMetric<{
    observedStartsAfterFailedAttempt: number;
    otherAdditionalStarts: number;
    startsWithMissingEarlierAttemptEvidence: number;
  }>;
  deferredAttempts: EvidenceMetric<number>;
  rejectedValidationArtifacts: EvidenceMetric<{
    distinctArtifacts: number;
    failedResults: number;
    failedResultsWithoutArtifactBinding: number;
  }>;
  consumptionByDeliveryOutcome: EvidenceMetric<Array<{
    unit: NativeBudgetUnit;
    integrated: number;
    unintegratedAtTerminalRun: number;
    unresolvedDelivery: number;
    unattributed: number;
    usageIdentities: number;
  }>>;
  executionModelUsageCoverage: {
    startedAttemptsWithReceipt: number;
    startedAttemptsWithoutReceipt: number;
  };
  nativeUsageCoverage: {
    attemptsWithReceipt: number;
    attemptsWithoutReceipt: number;
    reservedUsageIdentitiesWithoutReconciliation: number;
  };
  interventions: EvidenceMetric<{
    operatorRequests: number;
    escalationBoundaries: number;
    entries: Array<{
      event: string;
      sequence: number;
      at: string;
      workItem?: number;
      reason: { availability: "observed"; code: string | null; sha256: string } | { availability: "unavailable" };
    }>;
    omittedEntries: number;
  }>;
  actualArtifactDisposal: EvidenceMetric<number>;
  modelAuthoredYield: EvidenceMetric<number>;
  measuredSavings: EvidenceMetric<number>;
}

const localBackends = new Set([
  "codex-sdk/local-worktree", "codex-cli/local-worktree", "codex-app-server/local-worktree",
  "factory/local-validation",
]);
const cloudBackends = new Set([
  "codex-cli/daytona", "codex-cli/vercel-sandbox", "github-copilot/github-managed",
  "openai-codex/github-managed",
]);
const executionTerminals = new Set([
  "AttemptSucceeded", "AttemptFailed", "AttemptTimedOut", "AttemptCancelled", "AttemptDeferred",
]);
const capacityTerminals = new Set([
  "AttemptFailed", "AttemptTimedOut", "AttemptCancelled", "AttemptDeferred", "AttemptIntegrated",
]);
const operatorEvents = new Set([
  "FactoryRunCancellationRequested", "RunPauseRequested", "RunDrainRequested", "RunResumeRequested",
  "CloudPauseRequested", "WorkItemRetryRequested", "WorkItemPriorityChanged",
]);

const unavailable = (reason: string): EvidenceMetric<never> => ({ availability: "unavailable", reason });
const observed = <T>(value: T, evidenceCount: number): EvidenceMetric<T> => ({
  availability: "observed", value, source: "github-receipts", evidenceCount,
});
const key = (event: { runId: string; objective: number; workItem?: number; attempt?: number }) =>
  JSON.stringify([event.runId, event.objective, event.workItem, event.attempt]);
const capacityKey = (event: Capacity) => JSON.stringify([
  key(event), event.phase, event.backend, event.sourceRunId ?? null, event.targetBaseSha ?? null,
]);
function location(backend: string, admissionClass?: Attempt["admissionClass"]): Location {
  // Candidate capacity IDs encode the actual local/sandbox validator protocol,
  // not an arbitrary backend-name heuristic (Supervisor candidate/rebase paths).
  const known = localBackends.has(backend) || /^factory\/integration-validation-[a-f0-9]{64}$/.test(backend)
    ? "local" : cloudBackends.has(backend) || /^factory\/integration-sandbox-[a-f0-9]{64}$/.test(backend) ? "cloud" : "unclassified";
  if (admissionClass !== undefined && known !== "unclassified" && (admissionClass === "local") !== (known === "local")) return "unclassified";
  return known;
}
function counts(values: readonly Location[]): EvidenceMetric<Locations> {
  if (!values.length) return unavailable("no matching invocation receipts are present; missing evidence is not zero activity");
  const result: Locations = { local: 0, cloud: 0, unclassified: 0, total: values.length };
  for (const value of values) result[value]++;
  return observed(result, values.length);
}
function sameAttempt(left: Attempt, right: Attempt): boolean {
  return ["backend", "baseSha", "directorEpoch", "policyDigest", "recoveryEpoch"].every(
    (field) => left[field as keyof Attempt] === right[field as keyof Attempt],
  );
}
/** Ignore only repeat observations, not transplanted process or attempt identities. */
function uniqueStart(values: Attempt[], event: "AttemptReserved" | "AttemptStarted"): Attempt | undefined {
  const selected = values.filter((value) => value.event === event);
  const first = selected[0];
  if (!first || selected.some((value) => !sameAttempt(first, value) ||
    value.providerResourceId !== first.providerResourceId || value.resourceHostIdentity !== first.resourceHostIdentity ||
    value.environmentIdentity !== first.environmentIdentity || value.admissionClass !== first.admissionClass ||
    value.requestedCpu !== first.requestedCpu || value.requestedMemoryMb !== first.requestedMemoryMb ||
    JSON.stringify(value.localScopeBatch) !== JSON.stringify(first.localScopeBatch))) return undefined;
  return first;
}
function sweep(intervals: readonly Interval[]) {
  const edges = new Map<number, number>();
  let sum = 0;
  for (const interval of intervals) {
    sum += interval.end - interval.start;
    edges.set(interval.start, (edges.get(interval.start) ?? 0) + 1);
    edges.set(interval.end, (edges.get(interval.end) ?? 0) - 1);
  }
  let active = 0, peak = 0, union = 0, prior: number | undefined;
  for (const [at, delta] of [...edges].sort(([a], [b]) => a - b)) {
    if (prior !== undefined && active > 0) union += at - prior;
    active += delta;
    peak = Math.max(peak, active);
    prior = at;
  }
  return { sum, union, peak };
}

/** Descriptive only: accepted caller history supplies authentication; this never admits work. */
export function summarizeRuntimeEconomics(
  input: readonly FactoryEvent[], runId: string, startedAt: string, finishedAt?: string,
): RuntimeEconomics {
  const events = deduplicateFactoryEvents([...input]).filter((event) => event.runId === runId)
    .sort((a, b) => a.sequence - b.sequence);
  const startMs = Date.parse(startedAt), endMs = finishedAt === undefined ? undefined : Date.parse(finishedAt);
  const interval = (start: FactoryEvent, end: FactoryEvent, where: Location): Interval | undefined => {
    const a = Date.parse(start.at), b = Date.parse(end.at);
    if (!Number.isFinite(startMs) || !Number.isFinite(a) || !Number.isFinite(b) || a < startMs || b < a ||
      end.sequence <= start.sequence || (endMs !== undefined && b > endMs)) return undefined;
    return { start: a, end: b, location: where };
  };
  const attempts = new Map<string, Attempt[]>();
  for (const event of events) if (event.kind === "attempt") {
    const group = attempts.get(key(event)) ?? [];
    group.push(event); attempts.set(key(event), group);
  }
  const starts: Attempt[] = [], executionIntervals: Interval[] = [], capacityIntervals: Interval[] = [];
  let unresolvedExecution = 0, unresolvedCapacity = 0, executionReservations = 0;
  const validationReservations = events.filter((event): event is Capacity => event.kind === "capacity" && event.phase === "validation" && event.event === "CapacityReserved");
  for (const group of attempts.values()) {
    const started = uniqueStart(group, "AttemptStarted");
    const reserved = uniqueStart(group, "AttemptReserved");
    if (started) starts.push(started);
    const terminal = started && group.find((event) => event.sequence > started.sequence && executionTerminals.has(event.event));
    const active = started && terminal && sameAttempt(started, terminal) &&
      !(terminal.providerResourceId && started.providerResourceId !== terminal.providerResourceId) &&
      interval(started, terminal, location(started.backend));
    if (active) executionIntervals.push(active);
    else if (group.some((event) => event.event === "AttemptStarted" || executionTerminals.has(event.event))) unresolvedExecution++;
    if (!reserved) { unresolvedCapacity++; continue; }
    executionReservations++;
    const releases: FactoryEvent[] = [
      ...group.filter((event) => capacityTerminals.has(event.event) && sameAttempt(reserved, event)),
      ...validationReservations.filter((event) => key(event) === key(reserved) && event.sourceRunId === undefined && event.directorEpoch === reserved.directorEpoch && event.policyDigest === reserved.policyDigest),
    ].filter((event) => event.sequence > reserved.sequence).sort((a, b) => a.sequence - b.sequence);
    const occupied = releases[0] && interval(reserved, releases[0], location(reserved.backend, reserved.admissionClass));
    if (occupied) capacityIntervals.push(occupied); else unresolvedCapacity++;
  }

  const open = new Map<string, { receipt: Capacity; conflicting: boolean }>();
  const validationLocations: Location[] = [];
  let validationCompleted = 0, validationUnresolved = 0;
  for (const event of events) {
    if (event.kind !== "capacity" || event.phase !== "validation") continue;
    const identity = capacityKey(event), prior = open.get(identity);
    if (event.event === "CapacityReserved") {
      if (prior) {
        // Same exact scoped invocation can be repaired. Without that discriminator
        // repeated reservations might be separate validators and cannot be guessed away.
        if (!event.localScopeBatch || JSON.stringify(event.localScopeBatch) !== JSON.stringify(prior.receipt.localScopeBatch) ||
          event.directorEpoch !== prior.receipt.directorEpoch || event.policyDigest !== prior.receipt.policyDigest ||
          event.recoveryEpoch !== prior.receipt.recoveryEpoch || event.requestedCpu !== prior.receipt.requestedCpu ||
          event.requestedMemoryMb !== prior.receipt.requestedMemoryMb) prior.conflicting = true;
      } else {
        open.set(identity, { receipt: event, conflicting: false });
        validationLocations.push(location(event.backend));
      }
      continue;
    }
    if (!prior) { validationUnresolved++; continue; }
    const bound = !prior.conflicting && event.directorEpoch === prior.receipt.directorEpoch &&
      event.policyDigest === prior.receipt.policyDigest && event.recoveryEpoch === prior.receipt.recoveryEpoch &&
      event.requestedCpu === prior.receipt.requestedCpu && event.requestedMemoryMb === prior.receipt.requestedMemoryMb;
    const occupied = bound && interval(prior.receipt, event, location(event.backend));
    if (occupied) { capacityIntervals.push(occupied); validationCompleted++; } else validationUnresolved++;
    open.delete(identity);
  }
  validationUnresolved += open.size;
  // Adopted-source or future execution-capacity protocols are not ordinary
  // AttemptReserved intervals. Retain the gap instead of silently ignoring it.
  const unsupportedExecutionCapacityReceipts = events.filter((event) => event.kind === "capacity" && event.phase === "execution").length;
  const validations = events.filter((event): event is Extract<FactoryEvent, { kind: "validation" }> => event.kind === "validation");
  const missingValidationAdmissions = validations.filter((event) => !validationReservations.some((reserved) => key(reserved) === key(event) && reserved.sequence < event.sequence)).length;
  const localIntervals = capacityIntervals.filter((value) => value.location === "local");
  const localTime = sweep(localIntervals), activeTime = sweep(executionIntervals);
  const unknownLocations = capacityIntervals.some((value) => value.location === "unclassified");
  const finiteWindow = endMs !== undefined && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;

  let retries = 0, additionalStarts = 0, missingEarlier = 0;
  for (const started of starts) {
    const earlier = starts.filter((prior) => prior.workItem === started.workItem && prior.attempt < started.attempt && prior.sequence < started.sequence);
    if (earlier.length) {
      const last = earlier.at(-1)!;
      if ((attempts.get(key(last)) ?? []).some((event) => sameAttempt(last, event) && ["AttemptFailed", "AttemptTimedOut"].includes(event.event) && event.sequence < started.sequence)) retries++;
      else additionalStarts++;
    } else if (started.attempt > 1) missingEarlier++;
  }
  const deferred = [...attempts.values()].filter((group) => group.some((event) => event.event === "AttemptDeferred"));
  const rejected = new Set<string>();
  let failedResults = 0, unboundFailures = 0;
  const seenValidation = new Set<string>();
  for (const value of validations) {
    const identity = JSON.stringify([key(value), value.baseSha, value.outputTreeSha, value.evidenceDigest, value.passed]);
    if (seenValidation.has(identity)) continue;
    seenValidation.add(identity);
    if (value.passed) continue;
    failedResults++;
    const artifacts = new Set((attempts.get(key(value)) ?? []).filter((event) => event.event === "AttemptCollected" && event.sequence < value.sequence && event.baseSha === value.baseSha && event.artifactDigest).map((event) => event.artifactDigest!));
    if (artifacts.size === 1) rejected.add(JSON.stringify([key(value), [...artifacts][0]])); else unboundFailures++;
  }

  // Exactly the scalar budget ledger's latest-per-invocation semantics. Attempt
  // usage copies are not added, and management calls are not assigned to workers.
  const usage = new Map<string, Budget>();
  const usageKey = (event: Budget) => JSON.stringify([key(event), event.phase, event.unit, event.usageId ?? "default"]);
  const usageReservations = new Set<string>();
  for (const event of events) if (event.kind === "budget" && event.event === "BudgetReserved" && event.phase !== "management") usageReservations.add(usageKey(event));
  for (const event of events) if (event.kind === "budget" && event.event === "BudgetReconciled" && event.phase !== "management")
    usage.set(usageKey(event), event);
  const consumption = new Map<NativeBudgetUnit, { unit: NativeBudgetUnit; integrated: number; unintegratedAtTerminalRun: number; unresolvedDelivery: number; unattributed: number; usageIdentities: number }>();
  for (const value of usage.values()) {
    const row = consumption.get(value.unit) ?? { unit: value.unit, integrated: 0, unintegratedAtTerminalRun: 0, unresolvedDelivery: 0, unattributed: 0, usageIdentities: 0 };
    const group = attempts.get(key(value));
    let bound = group !== undefined;
    let integrated = group?.some((event) => event.event === "AttemptIntegrated") ?? false;
    // Successors deliberately do not manufacture AttemptIntegrated or an
    // attempt number on source-validation usage. Bind that one supported shape
    // through its candidate digest and exact source capacity/outcome instead.
    if (!bound && value.attempt === undefined && value.phase === "validation" &&
      /^integration-validation-[a-f0-9]{64}$/.test(value.usageId ?? "")) {
      const candidates = validationReservations.filter((reserved) => reserved.workItem === value.workItem &&
        reserved.sourceRunId !== undefined && reserved.backend === `factory/${value.usageId}` && reserved.sequence < value.sequence);
      const identities = new Set(candidates.map((reserved) => JSON.stringify([reserved.sourceRunId, reserved.attempt, reserved.targetBaseSha])));
      const source = candidates[0];
      if (identities.size === 1 && source) {
        bound = true;
        integrated = events.some((outcome) => outcome.event === "RecoverySourceIntegrated" &&
          outcome.workItem === value.workItem && outcome.sourceRunId === source.sourceRunId &&
          outcome.sourceAttempt === source.attempt && outcome.mergeCandidateIdentityDigest === value.usageId!.slice("integration-validation-".length));
      }
    }
    const category = !bound ? "unattributed" : integrated ? "integrated" : finishedAt ? "unintegratedAtTerminalRun" : "unresolvedDelivery";
    row[category] += value.amount; row.usageIdentities++; consumption.set(value.unit, row);
  }
  const withModel = starts.filter((started) => [...usage.values()].some((value) => key(value) === key(started) && value.phase === "execution" && value.unit === "model_tokens")).length;
  const attemptsWithUsage = [...attempts.keys()].filter((identity) => [...usage.values()].some((value) => key(value) === identity)).length;
  const finiteConsumption = [...consumption.values()].every((row) => [row.integrated, row.unintegratedAtTerminalRun, row.unresolvedDelivery, row.unattributed].every(Number.isFinite));
  const interventionEvents = events.filter((event) => operatorEvents.has(event.event) || event.event === "FactoryRunEscalated");
  const entries = interventionEvents.slice(0, 100).map((event) => ({
    event: event.event, sequence: event.sequence, at: event.at,
    ...("workItem" in event && event.workItem !== undefined ? { workItem: event.workItem } : {}),
    reason: "reason" in event && typeof event.reason === "string" ? {
      availability: "observed" as const, code: queuedReasonCode(event.reason),
      sha256: createHash("sha256").update(event.reason).digest("hex"),
    } : { availability: "unavailable" as const },
  }));
  return {
    scope: "current-run-recorded-receipts",
    execution: {
      startedAttempts: counts(starts.map((value) => location(value.backend))),
      completeIntervals: executionIntervals.length, unresolvedOrConflictingAttempts: unresolvedExecution,
      unresolvedCapacityIntervals: unresolvedCapacity, unsupportedExecutionCapacityReceipts,
      closedIntervalTime: executionIntervals.length ? observed({ summedWorkerMilliseconds: activeTime.sum, wallMillisecondsWithAnyWorker: activeTime.union,
        method: "AttemptStarted-to-first-execution-terminal; closed intervals only; GitHub observation time, not CPU time" }, executionIntervals.length * 2) : unavailable("no complete bound execution intervals"),
    },
    validation: { admittedInvocations: counts(validationLocations), completedCapacityIntervals: validationCompleted,
      unresolvedOrConflictingInvocations: validationUnresolved, validationResultsWithoutAdmissionEvidence: missingValidationAdmissions },
    admittedLocalConcurrency: finiteWindow && executionReservations + validationLocations.length > 0 &&
      unresolvedCapacity === 0 && unsupportedExecutionCapacityReceipts === 0 && validationUnresolved === 0 && missingValidationAdmissions === 0 && !unknownLocations
      ? observed({ peak: localTime.peak, average: localTime.sum / (endMs! - startMs), localReservationMilliseconds: localTime.sum,
        denominatorMilliseconds: endMs! - startMs, windowStart: startedAt, windowEnd: finishedAt!, intervals: localIntervals.length,
        method: "time-weighted execution-and-validation reservations over the terminal run window; idle time included" }, capacityIntervals.length * 2)
      : unavailable("terminal run window and complete classified execution/validation capacity intervals are required; missing or conflicting receipts are not zero occupancy"),
    retries: starts.length ? observed({ observedStartsAfterFailedAttempt: retries, otherAdditionalStarts: additionalStarts, startsWithMissingEarlierAttemptEvidence: missingEarlier }, starts.length) : unavailable("no actual worker starts are recorded"),
    deferredAttempts: attempts.size ? observed(deferred.length, attempts.size) : unavailable("no attempt evidence"),
    rejectedValidationArtifacts: validations.length ? observed({ distinctArtifacts: rejected.size, failedResults, failedResultsWithoutArtifactBinding: unboundFailures }, seenValidation.size) : unavailable("no independent validation results; rejection is not physical disposal"),
    consumptionByDeliveryOutcome: usage.size && finiteConsumption ? observed([...consumption.values()].sort((a, b) => a.unit.localeCompare(b.unit)), usage.size) : unavailable("finite execution/validation usage receipts required; no zero consumption inferred"),
    executionModelUsageCoverage: { startedAttemptsWithReceipt: withModel, startedAttemptsWithoutReceipt: starts.length - withModel },
    nativeUsageCoverage: { attemptsWithReceipt: attemptsWithUsage, attemptsWithoutReceipt: attempts.size - attemptsWithUsage,
      reservedUsageIdentitiesWithoutReconciliation: [...usageReservations].filter((identity) => !usage.has(identity)).length },
    interventions: interventionEvents.length ? observed({ operatorRequests: interventionEvents.filter((event) => operatorEvents.has(event.event)).length,
      escalationBoundaries: interventionEvents.filter((event) => event.event === "FactoryRunEscalated").length, entries, omittedEntries: interventionEvents.length - entries.length }, interventionEvents.length)
      : unavailable("no operator-request or escalation receipts; actual human effort is not measured"),
    actualArtifactDisposal: unavailable("no durable physical-disposal receipt; rejected or unintegrated artifacts may remain reusable"),
    modelAuthoredYield: unavailable("no durable authored/generated byte or line attribution; generated output cannot be counted as authored yield"),
    measuredSavings: unavailable("no controlled comparison or counterfactual runtime measurement; overlap is not demonstrated savings"),
  };
}
