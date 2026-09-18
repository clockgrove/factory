import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { qualificationModelAccounting } from "./qualification-model-accounting.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");

const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .filter((key) => value[key] !== undefined)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

const one = (rows, reason) => {
  assert.equal(rows.length, 1, reason);
  return rows[0];
};

const attemptKey = (event) =>
  `${event.runId}:${event.workItem}:${event.attempt}:${event.phase ?? "attempt"}`;
const accountingKey = (event) => `${attemptKey(event)}:${event.unit}:${event.usageId ?? "default"}`;
const normalizedPath = (path) =>
  path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
const pathsOverlap = (left, right) =>
  left.some((a) =>
    right.some((b) => {
      const x = normalizedPath(a),
        y = normalizedPath(b);
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
    }),
  );

function assertDistinct(values, reason) {
  assert.equal(new Set(values).size, values.length, reason);
}

function assertAccounting(events) {
  const accounting = qualificationModelAccounting(events, { requireMarkers: true });
  assert.deepEqual(accounting.unresolved, [], "model accounting remains unresolved");
  assertDistinct(accounting.usage.map(accountingKey), "duplicate model accounting identity");
  const native = events.filter(
    (event) => event.event === "BudgetReconciled" && event.unit !== "model_tokens",
  );
  assertDistinct(native.map(accountingKey), "duplicate native accounting identity");
  return accounting;
}

/**
 * Prove two independently installed Directors reached the absent Objective lease together.
 * A held-lease refusal, outer repository lease, or later serial takeover cannot satisfy this shape.
 */
export function assertInnerDirectorCollision(input) {
  assert.equal(input.beforeLease, null, "inner collision did not start from an absent lease");
  assert.equal(input.contenders.length, 2, "exactly two inner Directors are required");
  assertDistinct(
    input.contenders.map((entry) => entry.clientInvocationId),
    "inner contenders share one client incarnation",
  );
  assertDistinct(
    input.contenders.map((entry) => `${entry.pid}:${entry.startTicks}`),
    "inner contenders share one process incarnation",
  );
  assert.equal(
    new Set(input.contenders.map((entry) => entry.barrierDigest)).size,
    1,
    "inner contenders did not leave one start barrier",
  );
  for (const contender of input.contenders) {
    assert.match(contender.barrierDigest, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(contender.pid) && contender.pid > 1);
    assert.match(contender.startTicks, /^\d+$/);
  }
  const winner = one(
    input.contenders.filter((entry) => entry.outcome === "won"),
    "one inner Director must win",
  );
  const loser = one(
    input.contenders.filter((entry) => entry.outcome === "lease-cas-lost"),
    "one inner Director must return the exact lease CAS loss",
  );
  assert.equal(winner.automaticRetry, false);
  assert.equal(loser.automaticRetry, false);
  assert.equal(loser.errorCode, "inner-lease-cas-lost");
  assert.ok(
    input.leaseChain.length >= 2 && input.leaseChain.length <= 256,
    "bounded acquired-to-released lease chain required",
  );
  assertDistinct(
    input.leaseChain.map((lease) => lease.oid),
    "lease chain repeats a commit",
  );
  const terminalLease = input.leaseChain[0],
    lease = input.leaseChain.at(-1);
  assert.equal(terminalLease.event.event, "LeaseReleased", "terminal lease is not released");
  for (const [index, current] of input.leaseChain.entries()) {
    assert.match(current.oid, /^[a-f0-9]{40}$/);
    assert.equal(current.event.protocol, "clockgrove.factory/v2");
    assert.equal(current.event.kind, "lease");
    assert.equal(current.event.objective, input.objective);
    assert.equal(current.event.runId, input.runId);
    assert.equal(current.event.policyDigest, input.policyDigest);
    assert.equal(current.event.holder, winner.observedHolder);
    assert.ok(
      Number.isSafeInteger(current.event.epoch) && current.event.epoch > 0,
      "lease epoch is not a positive integer",
    );
    assert.equal(current.event.epoch, 1, "absent-ref lease must start at epoch one");
    assert.ok(
      Number.isSafeInteger(current.event.sequence) && current.event.sequence > 0,
      "lease sequence is not a positive integer",
    );
    assert.equal(current.parents.length, 1, "lease commit must have one parent");
    const previous = input.leaseChain[index + 1];
    if (previous) {
      assert.equal(
        current.event.event,
        index === 0 ? "LeaseReleased" : "LeaseRenewed",
        "lease chain contains an invalid transition",
      );
      assert.equal(current.event.previousOid, previous.oid, "lease previousOid differs from chain");
      assert.deepEqual(current.parents, [previous.oid]);
      assert.equal(current.event.epoch, previous.event.epoch);
      assert.equal(current.event.sequence, previous.event.sequence + 1);
    }
  }
  assert.equal(lease.event.event, "LeaseAcquired");
  assert.equal(loser.observedHolder, "unavailable-before-winning-CAS");
  assert.equal(
    lease.event.previousOid,
    undefined,
    "absent-lease CAS unexpectedly has a predecessor",
  );
  assert.deepEqual(lease.parents, [input.baseSha]);
  const run = input.events.filter((event) => event.runId === input.runId);
  const start = one(
    run.filter((event) => event.event === "FactoryRunStarted"),
    "collision produced more than one run start",
  );
  assert.equal(start.objective, input.objective);
  assert.equal(start.policyDigest, input.policyDigest);
  const reservations = run.filter((event) => event.event === "AttemptReserved");
  assert.ok(reservations.length > 0, "winning Director admitted no Work Item");
  assertDistinct(
    reservations.map((event) => attemptKey(event)),
    "collision duplicated an attempt reservation",
  );
  const accounting = assertAccounting(run);
  const peerProgress = input.peer.events.filter(
    (event) =>
      event.sequence > input.peer.beforeSequence &&
      ["AttemptReserved", "AttemptStarted", "AttemptSucceeded", "AttemptIntegrated"].includes(
        event.event,
      ),
  );
  assert.ok(peerProgress.length > 0, "peer Objective made no progress through the inner collision");
  assert.equal(input.peer.outerLeaseEvidence, "separate");
  return {
    boundary: "inner-Director-create-ref-CAS",
    objective: input.objective,
    runId: input.runId,
    leaseOid: lease.oid,
    terminalLeaseOid: terminalLease.oid,
    leaseTransitions: input.leaseChain.length,
    winner: winner.clientInvocationId,
    loser: loser.clientInvocationId,
    loserOutcome: loser.outcome,
    reservations: reservations.length,
    modelTokens: accounting.total,
    peerObjective: input.peer.objective,
    peerProgressEvents: peerProgress.length,
    outerLeaseEvidence: "separate",
  };
}

/** Exact crash generation and same-attempt recovery at the retained artifact boundary. */
export function assertPhaseKillRecovery(input) {
  assert.equal(input.kill.signal, "SIGKILL");
  assert.equal(input.kill.restart, "systemd-on-failure");
  assert.equal(input.kill.originalAbsent, true);
  for (const key of ["unit", "hostIdentity", "configDigest"])
    assert.equal(input.original[key], input.replacement[key], `phase recovery changed ${key}`);
  assert.notEqual(input.original.invocationId, input.replacement.invocationId);
  assert.notEqual(input.original.pid, input.replacement.pid);
  assert.equal(input.automaticProviderRetry, false);
  assert.equal(input.automaticLifecycleRetry, false);
  const after = new Set(input.afterEvents.map(canonical));
  for (const event of input.beforeEvents)
    assert.ok(after.has(canonical(event)), "durable pre-kill receipt changed or disappeared");
  const priorAttempts = new Set(
    input.beforeEvents
      .filter((event) => event.event === "AttemptReserved")
      .map((event) => attemptKey(event)),
  );
  assert.ok(priorAttempts.size > 0, "phase kill has no retained attempt");
  assert.ok(input.sessionIdentityBefore.length > 0, "phase kill has no retained session");
  const uniqueBoundaries = new Set([
    "AttemptReserved",
    "AttemptStarted",
    "AttemptSucceeded",
    "PublicationRecorded",
    "AttemptValidated",
    "ValidationRecorded",
    "AttemptIntegrated",
  ]);
  for (const key of priorAttempts)
    for (const name of uniqueBoundaries)
      assert.ok(
        input.afterEvents.filter((event) => event.event === name && attemptKey(event) === key)
          .length <= 1,
        `phase recovery duplicated ${name}`,
      );
  assert.deepEqual(input.sessionIdentityAfter, input.sessionIdentityBefore);
  const accounting = assertAccounting(input.afterEvents);
  return {
    boundary: "retained-artifact-phase-kill-recovery",
    unit: input.original.unit,
    originalInvocationId: input.original.invocationId,
    originalPid: input.original.pid,
    replacementInvocationId: input.replacement.invocationId,
    replacementPid: input.replacement.pid,
    hostIdentity: input.original.hostIdentity,
    configDigest: input.original.configDigest,
    retainedAttempts: priorAttempts.size,
    modelTokens: accounting.total,
    providerInvocationRepeated: false,
    publicationRepeated: false,
    integrationRepeated: false,
  };
}

/** Prove path and exclusive-resource claims serialized, then refilled from durable queue evidence. */
export function assertResourceCeilingEvidence(input) {
  assert.ok(input.snapshots.length >= 2 && input.snapshots.length <= 256);
  const observedClaims = [];
  for (const snapshot of input.snapshots) {
    assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
    assert.ok(snapshot.reservations.length <= 64);
    observedClaims.push(...snapshot.reservations);
    for (let left = 0; left < snapshot.reservations.length; left++)
      for (let right = left + 1; right < snapshot.reservations.length; right++) {
        const a = snapshot.reservations[left],
          b = snapshot.reservations[right];
        assert.equal(
          pathsOverlap(a.paths, b.paths),
          false,
          "overlapping paths were admitted together",
        );
        assert.equal(
          a.exclusiveResources.some((resource) => b.exclusiveResources.includes(resource)),
          false,
          "exclusive resources were admitted together",
        );
      }
  }
  assert.ok(
    observedClaims.some((reservation) => reservation.paths.length > 0),
    "no active path claim was observed",
  );
  assert.ok(
    observedClaims.some((reservation) => reservation.exclusiveResources.length > 0),
    "no active exclusive-resource claim was observed",
  );
  const proofs = {};
  for (const code of ["path-conflict", "exclusive-resource-conflict"]) {
    const queued = input.events.filter(
      (event) => event.event === "WorkItemQueued" && event.reasonCode === code,
    );
    assert.ok(queued.length > 0, `${code} was not durably observed`);
    const refill = queued.find((blocked) =>
      input.events.some(
        (event) =>
          event.event === "AttemptReserved" &&
          event.runId === blocked.runId &&
          event.workItem === blocked.workItem &&
          event.sequence > blocked.sequence,
      ),
    );
    assert.ok(refill, `${code} did not continuously refill after release`);
    proofs[code] = { queued: queued.length, refilledWorkItem: refill.workItem };
  }
  const durations = input.events
    .filter((event) => event.event === "AttemptStarted")
    .map((start) => {
      const end = input.events.find(
        (event) =>
          event.event === "AttemptSucceeded" &&
          event.runId === start.runId &&
          event.workItem === start.workItem &&
          event.attempt === start.attempt,
      );
      return end ? Date.parse(end.at) - Date.parse(start.at) : null;
    })
    .filter((value) => value !== null);
  assert.ok(durations.length >= 2, "asymmetric worker durations are unavailable");
  assert.ok(
    Math.max(...durations) > Math.min(...durations),
    "work did not produce asymmetric timing",
  );
  return {
    boundary: "shared-capacity-path-and-exclusive-ceilings",
    snapshots: input.snapshots.length,
    ...proofs,
    durationRangeMs: [Math.min(...durations), Math.max(...durations)],
  };
}

/** Bind both read-only surfaces to the same authenticated run and accounting identities. */
export function assertExplainReplayEvidence(input) {
  const start = one(
    input.events.filter((event) => event.event === "FactoryRunStarted"),
    "one authenticated run start required",
  );
  for (const report of [input.explain, input.replay]) {
    assert.equal(report.repository, input.repository);
    assert.equal(report.objective, input.objective);
  }
  assert.equal(input.explain.operation, "explain");
  assert.equal(input.replay.operation, "replay");
  assert.equal(input.replay.writeFree, true);
  assert.equal(input.replay.run.availability, "observed");
  assert.equal(input.replay.run.runId, start.runId);
  assert.equal(
    input.replay.run.receiptDigest,
    hash(input.replay.run.decisions),
    "replay receipt digest differs from its decisions",
  );
  const reservations = input.events.filter((event) => event.event === "AttemptReserved");
  assert.ok(reservations.length > 0, "authenticated run has no admissions");
  assertDistinct(reservations.map(attemptKey), "authenticated run has duplicate admissions");
  const decisions = input.replay.run.decisions.filter(
    (decision) => decision.decision === "admitted",
  );
  assert.deepEqual(
    decisions
      .map((decision) => `${decision.workItem}:${decision.attempt}:${decision.backendId}`)
      .sort(),
    reservations.map((event) => `${event.workItem}:${event.attempt}:${event.backend}`).sort(),
    "replay admissions differ from authenticated reservations",
  );
  assert.ok(
    input.explain.explanations.length > 0 && input.explain.explanations.length <= 64,
    "explain evidence is empty or unbounded",
  );
  assert.ok(
    input.explain.explanations.every(
      (entry) =>
        entry.workItem === undefined || reservations.some((r) => r.workItem === entry.workItem),
    ),
    "explain selected an unrelated Work Item",
  );
  const accounting = assertAccounting(input.events);
  const replayTokens = input.replay.run.summary.economics.usage.model_tokens;
  assert.equal(replayTokens.availability, "observed");
  assert.equal(replayTokens.value, accounting.total);
  const eventBinding = {
    runId: start.runId,
    policyDigest: start.policyDigest,
    eventDigest: hash(input.events),
    reservationIdentities: reservations.map(attemptKey).sort(),
    attemptIdentities: input.events
      .filter((event) => event.kind === "attempt")
      .map(attemptKey)
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort(),
    accountingIdentities: accounting.usage.map(accountingKey).sort(),
  };
  return {
    boundary: "authenticated-read-only-explain-replay",
    ...eventBinding,
    explainDigest: hash(input.explain),
    replayDigest: hash(input.replay),
    replayReceiptDigest: input.replay.run.receiptDigest,
    modelTokens: accounting.total,
  };
}
