import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertExplainReplayEvidence,
  assertInnerDirectorCollision,
  assertPhaseKillRecovery,
  assertResourceCeilingEvidence,
} from "../scripts/qualification-director-contention.mjs";

const policyDigest = "a".repeat(64);
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : JSON.stringify(value);
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function modelEvents(runId = "run-7", workItem = 11, sequence = 3) {
  const common = {
    protocol: "clockgrove.factory/v2",
    kind: "budget",
    objective: 7,
    runId,
    workItem,
    attempt: 1,
    phase: "execution",
    unit: "model_tokens",
    modelInvocationId: `worker-${workItem}-1`,
    policyDigest,
    directorEpoch: 1,
    at: "2026-09-18T12:00:03.000Z",
  };
  return [
    {
      ...common,
      event: "BudgetReserved",
      sequence,
      amount: 0,
      usageId: `invocation-worker-${workItem}-1`,
    },
    {
      ...common,
      event: "BudgetReconciled",
      sequence: sequence + 1,
      amount: 37,
      usageId: `worker-${workItem}-1`,
    },
  ];
}

function runEvents() {
  return [
    {
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "FactoryRunStarted",
      objective: 7,
      runId: "run-7",
      policyDigest,
      sequence: 1,
      at: "2026-09-18T12:00:00.000Z",
    },
    {
      protocol: "clockgrove.factory/v2",
      kind: "attempt",
      event: "AttemptReserved",
      objective: 7,
      runId: "run-7",
      workItem: 11,
      attempt: 1,
      backend: "codex-sdk/local-worktree",
      sequence: 2,
      at: "2026-09-18T12:00:02.000Z",
    },
    ...modelEvents(),
  ];
}

function collision() {
  const barrierDigest = "b".repeat(64);
  return {
    objective: 7,
    runId: "run-7",
    policyDigest,
    baseSha: "c".repeat(40),
    beforeLease: null,
    afterLease: {
      oid: "d".repeat(40),
      parents: ["c".repeat(40)],
      event: {
        kind: "lease",
        event: "LeaseAcquired",
        objective: 7,
        runId: "run-7",
        policyDigest,
        holder: "winner-holder",
      },
    },
    contenders: [
      {
        clientInvocationId: "client-a",
        pid: 101,
        startTicks: "1001",
        barrierDigest,
        automaticRetry: false,
        outcome: "won",
        observedHolder: "winner-holder",
      },
      {
        clientInvocationId: "client-b",
        pid: 102,
        startTicks: "1002",
        barrierDigest,
        automaticRetry: false,
        outcome: "lease-cas-lost",
        errorCode: "inner-lease-cas-lost",
        observedHolder: "unavailable-before-winning-CAS",
      },
    ],
    events: runEvents(),
    peer: {
      objective: 8,
      beforeSequence: 4,
      outerLeaseEvidence: "separate",
      events: [
        {
          event: "AttemptStarted",
          objective: 8,
          runId: "run-8",
          workItem: 21,
          attempt: 1,
          sequence: 5,
        },
      ],
    },
  };
}

function phaseRecovery() {
  const events = [
    ...runEvents(),
    {
      kind: "attempt",
      event: "AttemptStarted",
      objective: 7,
      runId: "run-7",
      workItem: 11,
      attempt: 1,
      sequence: 5,
    },
    {
      kind: "attempt",
      event: "AttemptSucceeded",
      objective: 7,
      runId: "run-7",
      workItem: 11,
      attempt: 1,
      sequence: 6,
    },
  ];
  return {
    kill: { signal: "SIGKILL", restart: "systemd-on-failure", originalAbsent: true },
    original: {
      unit: "factory.service",
      hostIdentity: "host-a",
      configDigest: "config-a",
      invocationId: "invocation-a",
      pid: 101,
    },
    replacement: {
      unit: "factory.service",
      hostIdentity: "host-a",
      configDigest: "config-a",
      invocationId: "invocation-b",
      pid: 102,
    },
    automaticProviderRetry: false,
    automaticLifecycleRetry: false,
    beforeEvents: events,
    afterEvents: [...events],
    sessionIdentityBefore: [{ attemptId: "attempt-11", terminalOid: "e".repeat(40) }],
    sessionIdentityAfter: [{ attemptId: "attempt-11", terminalOid: "e".repeat(40) }],
  };
}

function resourceEvidence() {
  return {
    snapshots: [
      {
        observedAt: "2026-09-18T12:00:00.000Z",
        reservations: [
          { paths: ["src/shared/"], exclusiveResources: [], workItem: 11 },
          { paths: ["src/other/"], exclusiveResources: ["gpu:0"], workItem: 12 },
        ],
      },
      { observedAt: "2026-09-18T12:01:00.000Z", reservations: [] },
    ],
    events: [
      {
        event: "WorkItemQueued",
        reasonCode: "path-conflict",
        runId: "run-7",
        workItem: 11,
        sequence: 1,
      },
      {
        event: "AttemptReserved",
        runId: "run-7",
        workItem: 11,
        attempt: 1,
        sequence: 2,
      },
      {
        event: "WorkItemQueued",
        reasonCode: "exclusive-resource-conflict",
        runId: "run-7",
        workItem: 12,
        sequence: 3,
      },
      {
        event: "AttemptReserved",
        runId: "run-7",
        workItem: 12,
        attempt: 1,
        sequence: 4,
      },
      {
        event: "AttemptStarted",
        runId: "run-7",
        workItem: 11,
        attempt: 1,
        at: "2026-09-18T12:00:00.000Z",
      },
      {
        event: "AttemptSucceeded",
        runId: "run-7",
        workItem: 11,
        attempt: 1,
        at: "2026-09-18T12:00:05.000Z",
      },
      {
        event: "AttemptStarted",
        runId: "run-7",
        workItem: 12,
        attempt: 1,
        at: "2026-09-18T12:00:00.000Z",
      },
      {
        event: "AttemptSucceeded",
        runId: "run-7",
        workItem: 12,
        attempt: 1,
        at: "2026-09-18T12:00:09.000Z",
      },
    ],
  };
}

function readOnlyEvidence() {
  const events = runEvents();
  const decisions = [
    {
      decision: "admitted",
      workItem: 11,
      attempt: 1,
      backendId: "codex-sdk/local-worktree",
    },
  ];
  return {
    repository: "example/repo",
    objective: 7,
    events,
    explain: {
      operation: "explain",
      repository: "example/repo",
      objective: 7,
      explanations: [{ workItem: 11, code: "factory.execution.complete" }],
    },
    replay: {
      operation: "replay",
      repository: "example/repo",
      objective: 7,
      writeFree: true,
      run: {
        availability: "observed",
        runId: "run-7",
        receiptDigest: digest(decisions),
        decisions,
        summary: {
          economics: {
            usage: { model_tokens: { availability: "observed", value: 37 } },
          },
        },
      },
    },
  };
}

describe("inner Director qualification assertions", () => {
  it("accepts one absent-ref CAS winner and one exact loser while a peer progresses", () => {
    expect(assertInnerDirectorCollision(collision())).toMatchObject({
      boundary: "inner-Director-create-ref-CAS",
      loserOutcome: "lease-cas-lost",
      modelTokens: 37,
      outerLeaseEvidence: "separate",
    });
    const lostResponse = collision();
    Object.assign(lostResponse.contenders[1]!, {
      outcome: "response-lost",
      errorCode: undefined,
      processAbsent: true,
      remoteSettlement: "reconciled-to-winning-run",
    });
    expect(assertInnerDirectorCollision(lostResponse)).toMatchObject({
      loserOutcome: "response-lost",
    });
    const reversed = collision();
    reversed.contenders.reverse();
    expect(assertInnerDirectorCollision(reversed)).toMatchObject({
      winner: "client-a",
      loser: "client-b",
    });
  });

  it("rejects duplicate winners, duplicate admission, and absent peer progress", () => {
    const twoWinners = collision();
    Object.assign(twoWinners.contenders[1]!, {
      outcome: "won",
      observedHolder: "winner-holder",
    });
    expect(() => assertInnerDirectorCollision(twoWinners)).toThrow(/one inner Director must win/);
    const duplicate = collision();
    duplicate.events.push({ ...duplicate.events[1]!, sequence: 9 });
    expect(() => assertInnerDirectorCollision(duplicate)).toThrow(/duplicated an attempt/);
    const stalled = collision();
    stalled.peer.events = [];
    expect(() => assertInnerDirectorCollision(stalled)).toThrow(/peer Objective made no progress/);
    const duplicateAccounting = collision();
    duplicateAccounting.events.push({ ...duplicateAccounting.events[3]!, sequence: 10 });
    expect(() => assertInnerDirectorCollision(duplicateAccounting)).toThrow(/usage repeated/);
  });
});

describe("phase-kill recovery qualification assertions", () => {
  it("accepts a new systemd generation with identical durable session identity", () => {
    expect(assertPhaseKillRecovery(phaseRecovery())).toMatchObject({
      boundary: "retained-artifact-phase-kill-recovery",
      providerInvocationRepeated: false,
      modelTokens: 37,
    });
  });

  it("rejects same-generation restart, lost receipts, and duplicate publication", () => {
    const sameGeneration = phaseRecovery();
    sameGeneration.replacement.invocationId = sameGeneration.original.invocationId;
    expect(() => assertPhaseKillRecovery(sameGeneration)).toThrow();
    const missing = phaseRecovery();
    missing.afterEvents.pop();
    expect(() => assertPhaseKillRecovery(missing)).toThrow(/disappeared/);
    const duplicate = phaseRecovery();
    duplicate.beforeEvents.push({
      kind: "attempt",
      event: "PublicationRecorded",
      objective: 7,
      runId: "run-7",
      workItem: 11,
      attempt: 1,
      sequence: 7,
    });
    duplicate.afterEvents.push(duplicate.beforeEvents.at(-1)!, {
      ...duplicate.beforeEvents.at(-1)!,
      sequence: 8,
    });
    expect(() => assertPhaseKillRecovery(duplicate)).toThrow(/duplicated PublicationRecorded/);
  });
});

describe("resource and read-only evidence assertions", () => {
  it("proves path/resource serialization, refill, asymmetric work, and replay binding", () => {
    expect(assertResourceCeilingEvidence(resourceEvidence())).toMatchObject({
      boundary: "shared-capacity-path-and-exclusive-ceilings",
      durationRangeMs: [5000, 9000],
    });
    expect(assertExplainReplayEvidence(readOnlyEvidence())).toMatchObject({
      boundary: "authenticated-read-only-explain-replay",
      runId: "run-7",
      modelTokens: 37,
    });
  });

  it("rejects overlapping active claims, missing refill, and replay identity drift", () => {
    const overlap = resourceEvidence();
    overlap.snapshots[0]!.reservations[1]!.paths = ["src/shared/nested"];
    expect(() => assertResourceCeilingEvidence(overlap)).toThrow(/overlapping paths/);
    const noRefill = resourceEvidence();
    noRefill.events = noRefill.events.filter(
      (event) => !(event.event === "AttemptReserved" && event.workItem === 12),
    );
    expect(() => assertResourceCeilingEvidence(noRefill)).toThrow(/did not continuously refill/);
    const drift = readOnlyEvidence();
    drift.replay.run.decisions[0]!.backendId = "codex-cli/local-worktree";
    drift.replay.run.receiptDigest = digest(drift.replay.run.decisions);
    expect(() => assertExplainReplayEvidence(drift)).toThrow(/admissions differ/);
  });
});
