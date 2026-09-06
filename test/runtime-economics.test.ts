import { describe, expect, it } from "vitest";
import { summarizeRun, summarizeRuntimeEconomics } from "../src/economics/index.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const base = "a".repeat(40);
const artifact = "b".repeat(64);
const policy = policyDigest(DEFAULT_RUN_POLICY);
const at = (seconds: number) => new Date(Date.parse("2026-09-06T12:00:00.000Z") + seconds * 1000).toISOString();

function event(sequence: number, seconds: number, value: Record<string, unknown>): FactoryEvent {
  return parseFactoryEvent({ protocol: "clockgrove.factory/v2", objective: 7, runId: "runtime-7", sequence, at: at(seconds), ...value });
}
function attempt(name: string, sequence: number, seconds: number, workItem = 8, overrides: Record<string, unknown> = {}): FactoryEvent {
  return event(sequence, seconds, { kind: "attempt", event: name, workItem, attempt: 1, backend: "codex-cli/local-worktree",
    baseSha: base, directorEpoch: 1, policyDigest: policy, ...overrides });
}
function capacity(name: string, sequence: number, seconds: number, workItem = 8, overrides: Record<string, unknown> = {}): FactoryEvent {
  return event(sequence, seconds, { kind: "capacity", event: name, workItem, attempt: 1, phase: "validation",
    backend: "factory/local-validation", requestedCpu: 1, requestedMemoryMb: 256, directorEpoch: 1, policyDigest: policy, ...overrides });
}
function validation(sequence: number, seconds: number, workItem = 8, passed = true): FactoryEvent {
  // Production validation receipts do not carry artifactDigest or command output.
  return event(sequence, seconds, { kind: "validation", event: "ValidationRecorded", workItem, attempt: 1,
    baseSha: base, outputTreeSha: "c".repeat(40), evidenceDigest: "d".repeat(64), passed });
}
function budget(sequence: number, workItem: number, amount: number, overrides: Record<string, unknown> = {}): FactoryEvent {
  return event(sequence, sequence, { kind: "budget", event: "BudgetReconciled", workItem, attempt: 1,
    phase: "execution", unit: "model_tokens", amount, ...overrides });
}
function start(): FactoryEvent {
  return event(1, 0, { kind: "run", event: "FactoryRunStarted", actor: "operator", repository: "example/project",
    objectiveAuthor: "operator", fork: false, baseBranch: "main", policy: DEFAULT_RUN_POLICY, policyDigest: policy });
}
function terminal(name = "FactoryRunCompleted", sequence = 20, seconds = 20): FactoryEvent {
  return event(sequence, seconds, { kind: "run", event: name });
}
function concurrent(): FactoryEvent[] {
  return [start(),
    attempt("AttemptReserved", 2, 1), attempt("AttemptStarted", 3, 2),
    attempt("AttemptReserved", 4, 3, 9), attempt("AttemptStarted", 5, 4, 9),
    attempt("AttemptSucceeded", 6, 6), capacity("CapacityReserved", 7, 7),
    attempt("AttemptCollected", 8, 8, 8, { artifactDigest: artifact }),
    attempt("AttemptSucceeded", 9, 9, 9), capacity("CapacityReserved", 10, 10, 9),
    attempt("AttemptCollected", 11, 11, 9, { artifactDigest: artifact }),
    validation(12, 12), capacity("CapacityReconciled", 13, 13),
    validation(14, 14, 9), capacity("CapacityReconciled", 15, 15, 9),
    attempt("AttemptIntegrated", 16, 16), attempt("AttemptIntegrated", 17, 17, 9),
    budget(18, 8, 100), budget(19, 9, 200), terminal()];
}
function summarize(events: FactoryEvent[], finishedAt: string | undefined = at(20)) {
  return summarizeRuntimeEconomics(events, "runtime-7", at(0), finishedAt);
}

describe("durable runtime economics", () => {
  it("separates active worker time from all admitted execution/validation occupancy", () => {
    const result = summarize(concurrent());
    expect(result.execution.startedAttempts).toMatchObject({ availability: "observed", value: { local: 2, cloud: 0, unclassified: 0, total: 2 } });
    expect(result.execution.closedIntervalTime).toMatchObject({ availability: "observed", value: {
      summedWorkerMilliseconds: 9000, wallMillisecondsWithAnyWorker: 7000,
    } });
    expect(result.execution.completeIntervals).toBe(2);
    expect(result.validation.admittedInvocations).toMatchObject({ value: { local: 2, total: 2 } });
    // Adjacent execution→validation transitions never briefly count both slots.
    expect(result.admittedLocalConcurrency).toMatchObject({ availability: "observed", value: {
      peak: 2, average: 1.2, localReservationMilliseconds: 24000, denominatorMilliseconds: 20000,
      windowStart: at(0), windowEnd: at(20), intervals: 4,
    } });
    expect(summarizeRun(concurrent())?.runtime).toEqual(result);
  });

  it("reconstructs duplicate transport observations and a fresh restart without doubling work", () => {
    const history = concurrent();
    const duplicate = history.filter((value) => value.kind === "attempt" || value.kind === "capacity");
    expect(summarize([...history, ...duplicate].reverse())).toEqual(summarize(history));
    expect(summarize(JSON.parse(JSON.stringify(history)) as FactoryEvent[])).toEqual(summarize(history));
    const old = history.map((value) => parseFactoryEvent({ ...value, runId: "predecessor-run" }));
    expect(summarize([...old, ...history])).toEqual(summarize(history));
  });

  it("does not turn an empty or open history into zero measured activity", () => {
    const empty = summarize([start(), terminal()]);
    expect(empty.execution.startedAttempts.availability).toBe("unavailable");
    expect(empty.validation.admittedInvocations.availability).toBe("unavailable");
    expect(empty.admittedLocalConcurrency.availability).toBe("unavailable");
    expect(empty.consumptionByDeliveryOutcome.availability).toBe("unavailable");
    const open = summarizeRuntimeEconomics(concurrent().filter((value) => value.event !== "FactoryRunCompleted"), "runtime-7", at(0));
    expect(open.execution.closedIntervalTime.availability).toBe("observed");
    expect(open.admittedLocalConcurrency.availability).toBe("unavailable");
    expect(summarize(concurrent(), at(0)).admittedLocalConcurrency.availability).toBe("unavailable");
  });

  it("retains closed subtotals but exposes missing starts, cleanup and validation admission", () => {
    const result = summarize(concurrent().filter((value) => !("workItem" in value && value.workItem === 9 && ["AttemptStarted", "CapacityReconciled"].includes(value.event))));
    expect(result.execution.completeIntervals).toBe(1);
    expect(result.execution.unresolvedOrConflictingAttempts).toBe(1);
    expect(result.validation.unresolvedOrConflictingInvocations).toBe(1);
    expect(result.admittedLocalConcurrency.availability).toBe("unavailable");
    const missing = summarize(concurrent().filter((value) => value.event !== "CapacityReserved"));
    expect(missing.validation.validationResultsWithoutAdmissionEvidence).toBe(2);
    expect(missing.admittedLocalConcurrency.availability).toBe("unavailable");
  });

  it.each(["policyDigest", "directorEpoch", "requestedCpu"])("does not close capacity using a mismatched %s", (field) => {
    const result = summarize(concurrent().map((value) => value.kind === "capacity" && value.event === "CapacityReconciled" && value.workItem === 8
      ? parseFactoryEvent({ ...value, [field]: field === "policyDigest" ? "e".repeat(64) : 2 }) : value));
    expect(result.validation.unresolvedOrConflictingInvocations).toBe(1);
    expect(result.admittedLocalConcurrency.availability).toBe("unavailable");
  });

  it("counts sequential candidate validators independently and leaves ambiguous overlapping reservations unresolved", () => {
    const again = concurrent().filter((value) => value.event !== "FactoryRunCompleted");
    again.push(capacity("CapacityReserved", 21, 21), capacity("CapacityReconciled", 22, 23), terminal("FactoryRunCompleted", 24, 24));
    const result = summarize(again, at(24));
    expect(result.validation.admittedInvocations).toMatchObject({ value: { total: 3, local: 3 } });
    expect(result.validation.completedCapacityIntervals).toBe(3);
    expect(result.admittedLocalConcurrency).toMatchObject({ value: { localReservationMilliseconds: 26000 } });
    const ambiguous = summarize([...concurrent(), capacity("CapacityReserved", 8, 7.5)]);
    expect(ambiguous.validation.unresolvedOrConflictingInvocations).toBeGreaterThan(0);
    expect(ambiguous.admittedLocalConcurrency.availability).toBe("unavailable");
  });

  it("does not classify unknown backend identities as local or use unsupported execution capacity", () => {
    const unknown = summarize(concurrent().map((value) => value.kind === "attempt" && value.workItem === 8 ? parseFactoryEvent({ ...value, backend: "future/worker" }) : value));
    expect(unknown.execution.startedAttempts).toMatchObject({ value: { local: 1, unclassified: 1, total: 2 } });
    expect(unknown.admittedLocalConcurrency.availability).toBe("unavailable");
    const unsupported = summarize([...concurrent(), capacity("CapacityReserved", 21, 21, 10, { phase: "execution" })]);
    expect(unsupported.execution.unsupportedExecutionCapacityReceipts).toBe(1);
    expect(unsupported.admittedLocalConcurrency.availability).toBe("unavailable");
  });

  it("classifies actual cloud execution and local independent validation separately", () => {
    const mixed = summarize(concurrent().map((value) => value.kind === "attempt" && value.workItem === 8
      ? parseFactoryEvent({ ...value, backend: "codex-cli/daytona" }) : value));
    expect(mixed.execution.startedAttempts).toMatchObject({ value: { local: 1, cloud: 1, total: 2 } });
    expect(mixed.validation.admittedInvocations).toMatchObject({ value: { local: 2, cloud: 0, total: 2 } });
    expect(mixed.admittedLocalConcurrency).toMatchObject({ value: { localReservationMilliseconds: 18000, average: 0.9 } });
  });

  it("refuses negative timestamps and conflicting repeated starts instead of inventing durations", () => {
    const backwards = summarize(concurrent().map((value) => value.event === "AttemptSucceeded" && value.workItem === 8 ? parseFactoryEvent({ ...value, at: at(1) }) : value));
    expect(backwards.execution.completeIntervals).toBe(1);
    expect(backwards.execution.unresolvedOrConflictingAttempts).toBe(1);
    const conflict = summarize([...concurrent(), attempt("AttemptStarted", 21, 2, 8, { providerResourceId: "different-process" })]);
    expect(conflict.execution.unresolvedOrConflictingAttempts).toBe(1);
  });

  it("reports retry launches, not maximum attempt numbers or deferrals as new worker starts", () => {
    const values = [start(), attempt("AttemptReserved", 2, 1), attempt("AttemptStarted", 3, 2), attempt("AttemptFailed", 4, 3),
      attempt("AttemptReserved", 5, 4, 8, { attempt: 2 }), attempt("AttemptStarted", 6, 5, 8, { attempt: 2 }),
      attempt("AttemptFailed", 7, 6, 8, { attempt: 2 }), attempt("AttemptDeferred", 8, 7, 9),
      attempt("AttemptStarted", 9, 8, 10, { attempt: 4 }), terminal("FactoryRunEscalated")];
    const result = summarize(values);
    expect(result.retries).toMatchObject({ value: { observedStartsAfterFailedAttempt: 1, otherAdditionalStarts: 0, startsWithMissingEarlierAttemptEvidence: 1 } });
    expect(result.deferredAttempts).toMatchObject({ value: 1 });
    expect(result.execution.startedAttempts).toMatchObject({ value: { total: 3 } });
  });

  it("partitions known native consumption by exact run/attempt delivery without zero filling missing usage", () => {
    const values = concurrent().filter((value) => !(value.event === "AttemptIntegrated" && value.workItem === 9));
    values.push(budget(21, 8, 150), budget(22, 9, 3, { unit: "validation_milliseconds", phase: "validation", usageId: "candidate-1" }),
      budget(23, 100, 7), budget(24, 9, 1000, { event: "BudgetReserved", usageId: "unobserved" }),
      budget(25, 8, 9999, { phase: "management", usageId: "compiler" }));
    const result = summarize(values);
    expect(result.consumptionByDeliveryOutcome).toMatchObject({ value: [
      { unit: "model_tokens", integrated: 150, unintegratedAtTerminalRun: 200, unresolvedDelivery: 0, unattributed: 7, usageIdentities: 3 },
      { unit: "validation_milliseconds", integrated: 0, unintegratedAtTerminalRun: 3, usageIdentities: 1 },
    ] });
    expect(result.nativeUsageCoverage.reservedUsageIdentitiesWithoutReconciliation).toBe(1);
    const sparse = summarize(concurrent().filter((value) => value.kind !== "budget"));
    expect(sparse.executionModelUsageCoverage).toEqual({ startedAttemptsWithReceipt: 0, startedAttemptsWithoutReceipt: 2 });
    expect(sparse.consumptionByDeliveryOutcome.availability).toBe("unavailable");
    const open = summarizeRuntimeEconomics(values.filter((value) => value.event !== "FactoryRunCompleted"), "runtime-7", at(0));
    expect(open.consumptionByDeliveryOutcome).toMatchObject({ value: [ { unit: "model_tokens", unresolvedDelivery: 200, unintegratedAtTerminalRun: 0 }, { unit: "validation_milliseconds", unresolvedDelivery: 3 } ] });
  });

  it("records known zero usage, rejects arithmetic overflow, and never adds attempt token copies", () => {
    const values: FactoryEvent[] = concurrent().filter((value) => value.kind !== "budget");
    values.push(budget(18, 8, 0));
    const zero = summarize(values);
    expect(zero.executionModelUsageCoverage).toEqual({ startedAttemptsWithReceipt: 1, startedAttemptsWithoutReceipt: 1 });
    expect(zero.consumptionByDeliveryOutcome).toMatchObject({ value: [{ integrated: 0, usageIdentities: 1 }] });
    expect(summarize([...values, budget(21, 8, Number.MAX_VALUE), budget(22, 9, Number.MAX_VALUE)]).consumptionByDeliveryOutcome.availability).toBe("unavailable");
    expect(summarize(concurrent().map((value) => value.event === "AttemptSucceeded" ? parseFactoryEvent({ ...value, reportedModelTokens: 500 }) : value)).consumptionByDeliveryOutcome).toEqual(summarize(concurrent()).consumptionByDeliveryOutcome);
  });

  it("binds successor candidate validation without inventing a successor worker or importing predecessor cost", () => {
    const candidate = "f".repeat(64);
    const source = { sourceRunId: "original-run", targetBaseSha: base, backend: `factory/integration-validation-${candidate}` };
    const outcome = event(5, 5, { kind: "recovery", event: "RecoverySourceIntegrated", recoveryRequestId: "request-1", planDigest: artifact,
      claimRef: "refs/factory/recovery/claim", claimOid: base, workItem: 8, sourceRunId: "original-run", sourceAttempt: 1,
      sourceReservationRef: "refs/factory/attempt", sourceReservationCommitOid: base, sourceReservationReceiptDigest: artifact,
      sourcePublicationReceiptDigest: artifact, sourceHeadSha: base, mergeCommitSha: "e".repeat(40), mergeCandidateIdentityDigest: candidate });
    const usage = event(4, 4, { kind: "budget", event: "BudgetReconciled", workItem: 8, phase: "validation",
      unit: "validation_milliseconds", amount: 1500, usageId: `integration-validation-${candidate}` });
    const values = [start(), capacity("CapacityReserved", 2, 1, 8, source), capacity("CapacityReconciled", 3, 3, 8, source), usage, outcome, terminal()];
    const result = summarize(values);
    expect(result.execution.startedAttempts.availability).toBe("unavailable");
    expect(result.validation.admittedInvocations).toMatchObject({ value: { total: 1, local: 1 } });
    expect(result.admittedLocalConcurrency).toMatchObject({ value: { peak: 1, average: 0.1, intervals: 1 } });
    expect(result.consumptionByDeliveryOutcome).toMatchObject({ value: [{ unit: "validation_milliseconds", integrated: 1500, unattributed: 0 }] });
    const wrongCandidate = summarize(values.map((value) => value.event === "RecoverySourceIntegrated" ? parseFactoryEvent({ ...value, mergeCandidateIdentityDigest: "e".repeat(64) }) : value));
    expect(wrongCandidate.consumptionByDeliveryOutcome).toMatchObject({ value: [{ integrated: 0, unintegratedAtTerminalRun: 1500 }] });
    const unbound = summarize(values.filter((value) => value.kind !== "capacity"));
    expect(unbound.consumptionByDeliveryOutcome).toMatchObject({ value: [{ integrated: 0, unattributed: 1500 }] });
  });

  it("distinguishes rejected artifacts from deletion and never claims generated output as authored yield", () => {
    const values = concurrent().map((value) => value.kind === "validation" ? parseFactoryEvent({ ...value, passed: false }) : value);
    const result = summarize([...values, validation(21, 18, 8, false)]);
    expect(result.rejectedValidationArtifacts).toMatchObject({ value: { distinctArtifacts: 2, failedResults: 2, failedResultsWithoutArtifactBinding: 0 } });
    expect(result.actualArtifactDisposal.availability).toBe("unavailable");
    expect(result.modelAuthoredYield.availability).toBe("unavailable");
    expect(result.measuredSavings.availability).toBe("unavailable");
    const sparse = summarize(values.filter((value) => value.event !== "AttemptCollected"));
    expect(sparse.rejectedValidationArtifacts).toMatchObject({ value: { distinctArtifacts: 0, failedResults: 2, failedResultsWithoutArtifactBinding: 2 } });
  });

  it("reports evidenced intervention codes without echoing free-form reasons or claiming human effort", () => {
    const secret = "private-path-or-provider-secret";
    const values = [start(), event(2, 1, { kind: "run", event: "CloudPauseRequested", requestedBy: "operator", requestId: "pause-1", reason: secret,
      workItem: { unknownFutureField: secret } }),
      event(3, 2, { kind: "run", event: "WorkItemPriorityChanged", requestedBy: "operator", requestId: "priority-1", workItem: 8, priorityRank: 1, prioritySource: "operator-command" }),
      event(4, 3, { kind: "run", event: "FactoryRunEscalated", reason: `budget-exhausted: ${secret}` })];
    const result = summarize(values);
    expect(result.interventions).toMatchObject({ value: { operatorRequests: 2, escalationBoundaries: 1, entries: [
      { reason: { availability: "observed", code: null } }, { workItem: 8, reason: { availability: "unavailable" } },
      { reason: { availability: "observed", code: "budget-exhausted" } },
    ] } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
