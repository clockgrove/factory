/** Independent evidence consumer for the existing installed checkpoint runner. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertQualificationCheckpoint,
  nativeProofReader,
} from "./qualification-sibling-refresh-proof.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const one = (rows) => {
  assert.equal(rows.length, 1, "one exact App Server receipt required");
  return rows[0];
};
const keys = [
  "repository",
  "objective",
  "workItem",
  "attempt",
  "runId",
  "directorEpoch",
  "policyDigest",
  "baseSha",
];
const sessionPath = ".clockgrove-factory/control/app-server-session.json";
export const appServerCheckpointPath = (unit, invocationId, uid = process.getuid()) =>
  join(
    tmpdir(),
    `factory-qualification-checkpoints-${uid}`,
    `${hash(`${unit}\0${invocationId}`)}.json`,
  );
export function appServerCheckpointArm(authority, original, objective) {
  assert.equal(authority.sessionRecovery, true);
  const objectiveTimeoutMinutes = authority.policy.objectiveTimeoutMinutes,
    workItemTimeoutMinutes = authority.policy.workItemTimeoutMinutes;
  assert.ok(
    Number.isInteger(objectiveTimeoutMinutes) &&
      objectiveTimeoutMinutes >= 1 &&
      objectiveTimeoutMinutes <= 30 * 24 * 60,
  );
  assert.ok(
    Number.isInteger(workItemTimeoutMinutes) &&
      workItemTimeoutMinutes >= 1 &&
      workItemTimeoutMinutes <= 24 * 60,
  );
  return {
    protocol: "clockgrove.factory/app-server-checkpoint-arm-v2",
    repository: authority.repository,
    objective,
    activationRequestId: `${authority.namespace}-activate`,
    policyDigest: hash(canonical(authority.policy)),
    unit: original.unit,
    invocationId: original.invocationId,
    hostIdentity: original.hostIdentity,
    producerPid: original.pid,
    producerStartTicks: original.startTicks,
    eligibilityDurationMs: objectiveTimeoutMinutes * 60_000,
    holdDurationMs: workItemTimeoutMinutes * 60_000,
  };
}
function identities(authority, reserved) {
  const identity = Object.fromEntries(
    keys.map((key) => [key, key === "repository" ? authority.repository : reserved[key]]),
  );
  const attemptId = hash(
    JSON.stringify([
      "clockgrove.factory/attempt-v2",
      authority.repository,
      reserved.runId,
      reserved.objective,
      reserved.workItem,
      reserved.attempt,
      reserved.directorEpoch,
    ]),
  );
  return {
    identity,
    sessionRef: `refs/clockgrove-factory/sessions/${attemptId}`,
    attemptId,
    reservationRef: `refs/clockgrove-factory/attempts/objective-${reserved.objective}/work-item-${reserved.workItem}/attempt-${reserved.attempt}`,
    transferRef: `refs/clockgrove-factory/artifact-transfers/${hash(JSON.stringify(identity))}`,
  };
}
function document(proof, ref, path, parents, maxBytes = 196608) {
  return assertQualificationCheckpoint(proof, { ref, path, maxBytes }, parents);
}
export function assertAppServerCheckpoint(observation, authority, proof, witness) {
  const events = observation.receipts.map(({ event }) => event),
    runId = observation.status.run.runId;
  const start = one(events.filter((event) => event.event === "FactoryRunStarted"));
  assert.equal(start.runId, runId);
  assert.equal(start.activationRequestId, `${authority.namespace}-activate`);
  assert.deepEqual(start.policy, authority.policy);
  assert.equal(start.policyDigest, hash(canonical(authority.policy)));
  const reserved = one(
    events.filter(
      (event) =>
        event.event === "AttemptReserved" &&
        event.runId === runId &&
        event.workItem === proof.workItem,
    ),
  );
  assert.equal(reserved.backend, "codex-app-server/local-worktree");
  assert.equal(reserved.attempt, 1);
  const { identity, sessionRef, reservationRef, transferRef, attemptId } = identities(
    authority,
    reserved,
  );
  assert.equal(proof.reservationRef, reservationRef);
  assert.match(proof.reservationOid, /^[a-f0-9]{40}$/);
  assert.equal(proof.reservationCommit.oid, proof.reservationOid);
  assert.deepEqual(proof.reservationCommit.parentOids, [reserved.baseSha]);
  const trailer = one(
    proof.reservationCommit.message
      .split(/\r?\n/)
      .filter((line) => line.startsWith("Factory-Event: ")),
  );
  assert.deepEqual(JSON.parse(Buffer.from(trailer.slice(15), "base64url").toString()), reserved);
  const stages = Object.fromEntries(
    ["prepared", "turn", "terminal"].map((stage) => {
      const value = document(proof[stage], `${sessionRef}/${stage}`, sessionPath, [
        proof.reservationOid,
      ]);
      assert.equal(value.protocol, "clockgrove.factory/app-server-session-v1");
      assert.equal(value.stage, stage);
      return [stage, value];
    }),
  );
  const { binding, packet } = stages.prepared;
  assert.equal(stages.prepared.turnId, undefined);
  for (const key of keys) assert.equal(binding[key], identity[key], `session ${key} differs`);
  assert.equal(binding.attemptId, attemptId);
  assert.equal(binding.cliVersion, "0.153.0");
  assert.deepEqual(binding.localScopeBatch, reserved.localScopeBatch);
  assert.equal(binding.hostIdentity, reserved.localScopeBatch.identity.hostIdentity);
  assert.equal(binding.packetDigest, hash(canonical(packet)));
  assert.equal(packet.baseSha, reserved.baseSha);
  assert.equal(binding.packetDigest, reserved.localScopeBatch.identity.invocationDigest);
  assert.deepEqual(binding.priorTurnIds, []);
  for (const value of [stages.turn, stages.terminal]) {
    assert.deepEqual(value.binding, binding);
    assert.deepEqual(value.packet, packet);
    assert.ok(typeof value.turnId === "string" && value.turnId.length > 0);
  }
  const terminal = stages.terminal;
  assert.equal(stages.turn.turnId, terminal.turnId);
  assert.equal(terminal.state, "succeeded");
  assert.equal(terminal.providerStatus, "completed");
  assert.equal(terminal.final.outcome, "succeeded");
  const started = one(
    events.filter(
      (event) =>
        event.event === "AttemptStarted" &&
        event.runId === runId &&
        event.workItem === reserved.workItem,
    ),
  );
  assert.equal(started.backend, reserved.backend);
  assert.equal(started.attempt, 1);
  assert.equal(started.providerResourceId, binding.threadId);
  assert.equal(started.resourceHostIdentity, binding.hostIdentity);
  assert.equal(terminal.usageStreamComplete, true);
  assert.ok(
    Array.isArray(terminal.responseUsage) &&
      terminal.responseUsage.length > 0 &&
      terminal.responseUsage.length <= 1000,
  );
  assert.equal(
    new Set(terminal.responseUsage.map((entry) => entry.responseId)).size,
    terminal.responseUsage.length,
  );
  const sums = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ]) {
    assert.equal(binding.usageBaseline[key], 0);
    sums[key] = terminal.responseUsage.reduce((total, response) => {
      assert.ok(typeof response.responseId === "string" && response.responseId.length > 0);
      assert.ok(
        Number.isSafeInteger(response.usage?.[key]) && response.usage[key] >= 0,
        "unknown response usage",
      );
      return total + response.usage[key];
    }, 0);
    assert.ok(Number.isSafeInteger(sums[key]));
    assert.equal(terminal.rawTokenUsage.total[key], sums[key]);
  }
  assert.ok(sums.cachedInputTokens <= sums.inputTokens);
  assert.deepEqual(terminal.usage, {
    inputTokens: sums.inputTokens,
    outputTokens: sums.outputTokens,
    cachedInputTokens: sums.cachedInputTokens,
  });
  const item = events.filter(
    (event) => event.runId === runId && event.workItem === reserved.workItem && event.attempt === 1,
  );
  const worker = one(
    item.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.unit === "model_tokens" &&
        event.phase === "execution",
    ),
  );
  assert.equal(worker.usageId, `worker-${reserved.workItem}-1`);
  assert.equal(worker.amount, sums.inputTokens + sums.outputTokens);
  const native = one(
    item.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.unit === "local_milliseconds" &&
        event.phase === "execution",
    ),
  );
  assert.ok(Number.isSafeInteger(native.amount) && native.amount >= 0);
  assert.notEqual(native.usageEvidence, "conservative-reservation");
  const intent = document(
    proof.intent,
    `${transferRef}/intent`,
    "artifact-transfer.json",
    [],
    1048576,
  );
  const ready = document(
    proof.ready,
    `${transferRef}/ready`,
    "artifact-transfer.json",
    [proof.intent.commit.oid],
    1048576,
  );
  assert.deepEqual(intent, ready);
  assert.equal(ready.protocol, "clockgrove.factory/artifact-transfer-v1");
  assert.deepEqual(ready.identity, identity);
  assert.equal(ready.retention, "repository-audit");
  // This small fixture does not qualify externalized multi-chunk payload transport.
  assert.deepEqual(ready.chunks, []);
  assert.equal(ready.artifact.payload, undefined);
  const artifact = ready.artifact;
  assert.equal(artifact.baseSha, reserved.baseSha);
  assert.equal(artifact.outcome, "succeeded");
  const digest = createHash("sha256")
    .update(artifact.baseSha)
    .update("\0")
    .update(artifact.changedPaths.slice().sort().join("\0"))
    .update("\0")
    .update(artifact.patch);
  if (artifact.fileManifest)
    digest.update("\0content-v1\0").update(JSON.stringify({ fileManifest: artifact.fileManifest }));
  assert.equal(artifact.digest, digest.digest("hex"));
  const succeeded = one(item.filter((event) => event.event === "AttemptSucceeded"));
  assert.equal(succeeded.artifactDigest, artifact.digest);
  assert.equal(succeeded.reportedModelTokens, worker.amount);
  if (witness) {
    assert.ok(
      [
        "clockgrove.factory/app-server-checkpoint-reached-v1",
        "clockgrove.factory/app-server-checkpoint-reached-v2",
      ].includes(witness.protocol),
      "unsupported App Server checkpoint witness",
    );
    for (const key of keys) assert.equal(witness[key], identity[key]);
    assert.equal(witness.activationRequestId, `${authority.namespace}-activate`);
    assert.equal(witness.artifactDigest, artifact.digest);
    assert.equal(witness.threadId, binding.threadId);
    assert.equal(witness.turnId, terminal.turnId);
    assert.deepEqual(witness.batch, reserved.localScopeBatch);
    assert.equal(witness.modelTokens, worker.amount);
    assert.equal(witness.nativeMilliseconds, native.amount);
    assert.ok(Date.parse(witness.reachedAt) >= Date.parse(native.at));
    if (witness.protocol === "clockgrove.factory/app-server-checkpoint-reached-v2") {
      assert.equal(witness.startedAt, start.at);
      assert.equal(
        Date.parse(witness.eligibleUntil),
        Date.parse(start.at) + authority.policy.objectiveTimeoutMinutes * 60_000,
      );
      assert.ok(Date.parse(witness.eligibleUntil) > Date.parse(witness.reachedAt));
      assert.equal(
        Date.parse(witness.holdUntil) - Date.parse(witness.reachedAt),
        authority.policy.workItemTimeoutMinutes * 60_000,
      );
    } else assert.ok(Date.parse(witness.expiresAt) > Date.parse(witness.reachedAt));
  }
  return {
    workItem: reserved.workItem,
    runId,
    attempt: 1,
    threadId: binding.threadId,
    turnId: terminal.turnId,
    modelTokens: worker.amount,
    artifactDigest: artifact.digest,
    sessionRef,
    terminalOid: proof.terminal.commit.oid,
    readyOid: proof.ready.commit.oid,
  };
}
export async function observeAppServerCheckpoints(request, observation, authority, witness) {
  const read = nativeProofReader(request),
    proofs = [];
  const reservations = observation.receipts
    .map(({ event }) => event)
    .filter(
      (event) => event.event === "AttemptReserved" && event.runId === observation.status.run.runId,
    );
  assert.ok(reservations.length > 0 && reservations.length <= 3);
  for (const reserved of reservations) {
    const refs = identities(authority, reserved),
      reservationOid = await read({ kind: "ref", ref: refs.reservationRef });
    const proof = {
      workItem: reserved.workItem,
      reservationRef: refs.reservationRef,
      reservationOid,
      reservationCommit: await read({ kind: "commit", oid: reservationOid }),
    };
    for (const stage of ["prepared", "turn", "terminal"])
      proof[stage] = await read({
        kind: "checkpoint",
        ref: `${refs.sessionRef}/${stage}`,
        path: sessionPath,
        maxBytes: 196608,
      });
    for (const stage of ["intent", "ready"])
      proof[stage] = await read({
        kind: "checkpoint",
        ref: `${refs.transferRef}/${stage}`,
        path: "artifact-transfer.json",
        maxBytes: 1048576,
      });
    assertAppServerCheckpoint(
      observation,
      authority,
      proof,
      witness?.workItem === reserved.workItem ? witness : undefined,
    );
    proofs.push(proof);
  }
  return proofs;
}
