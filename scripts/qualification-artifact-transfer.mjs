/** Independent installed large-output proof. No runtime imports, writes, or execution authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";
import {
  assertQualificationCheckpoint,
  nativeProofReader,
} from "./qualification-sibling-refresh-proof.mjs";
import {
  assertQualificationReservationAuthority,
  assertQualificationReservationAuthorityReobservation,
  observeQualificationReservationAuthority,
  qualificationReservationAuthorityExpectation,
  reobserveQualificationReservationAuthority,
} from "./qualification-reservation-authority.mjs";

const MAX_PATCH = 256 * 1024 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_DESCRIPTOR = 8 * 1024 * 1024;
const SESSION_PATH = ".clockgrove-factory/control/app-server-session.json";
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
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (kind, bytes) =>
  createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
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
const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const sha = (value) => assert.match(value, /^[a-f0-9]{40}$/);
const digest = (value) => assert.match(value, /^[a-f0-9]{64}$/);
const integer = (value, min, max) =>
  assert.ok(
    Number.isSafeInteger(value) && value >= min && value <= max,
    "integer exceeds proof bound",
  );
const exact = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
const same = (left, right, fields = keys) => {
  for (const key of fields) assert.equal(left[key], right[key], `original ${key} binding differs`);
};
function budgetIdentity(event, reserved) {
  same(event, reserved, ["objective", "workItem", "attempt", "runId"]);
  // Ordinary recorder budgets omit epoch/policy; conservative recovery receipts carry them.
  // The accepted run and exact original reservation supply the immutable authority otherwise.
  for (const key of ["policyDigest", "directorEpoch"])
    if (event[key] !== undefined) assert.equal(event[key], reserved[key], `budget ${key} differs`);
}
const when = (value) => {
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed));
  return parsed;
};
function eventsFor(observation, workItem) {
  // The caller authenticates raw GitHub actor/location envelopes, as in the checkpoint runner.
  // Deduplication below is identity normalization, not substitute authentication.
  const events = deduplicateQualificationReceipts(observation.receipts).map(({ event }) => event);
  const runId = observation.status.run.runId;
  return events.filter(
    (event) =>
      event.runId === runId && (event.workItem === workItem || event.event === "FactoryRunStarted"),
  );
}
function identities(authority, reservation) {
  const identity = Object.fromEntries(
    keys.map((key) => [
      key,
      key === "repository" ? authority.repository.toLowerCase() : reservation[key],
    ]),
  );
  assert.match(identity.repository, /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  for (const key of ["objective", "workItem", "attempt"])
    integer(identity[key], 1, Number.MAX_SAFE_INTEGER);
  integer(identity.directorEpoch, 0, Number.MAX_SAFE_INTEGER);
  assert.ok(
    typeof identity.runId === "string" && identity.runId.length > 0 && identity.runId.length <= 160,
  );
  digest(identity.policyDigest);
  sha(identity.baseSha);
  const attemptId = hash(
    JSON.stringify([
      "clockgrove.factory/attempt-v2",
      identity.repository,
      identity.runId,
      identity.objective,
      identity.workItem,
      identity.attempt,
      identity.directorEpoch,
    ]),
  );
  return {
    identity,
    attemptId,
    sessionRef: `refs/clockgrove-factory/sessions/${attemptId}`,
    reservationRef: `refs/clockgrove-factory/attempts/objective-${identity.objective}/work-item-${identity.workItem}/attempt-${identity.attempt}`,
    transferRef: `refs/clockgrove-factory/artifact-transfers/${hash(JSON.stringify(identity))}`,
  };
}
function session(events, authority, proof) {
  const reserved = one(
    events.filter((event) => event.event === "AttemptReserved"),
    "one original reservation, no replacement",
  );
  assert.equal(reserved.backend, "codex-app-server/local-worktree");
  assert.equal(reserved.attempt, 1, "this qualification covers one original attempt");
  const refs = identities(authority, reserved),
    { identity } = refs;
  const start = one(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "one accepted run",
  );
  assert.equal(start.objective, identity.objective);
  assert.equal(hash(canonical(start.policy)), identity.policyDigest);
  assert.deepEqual(start.policy, authority.policy);
  assert.equal(start.activationRequestId, `${authority.namespace}-activate`);
  const reservationAuthority = {
    logicalRef: proof.reservationRef,
    reservationOid: proof.reservationOid,
    reservationCommit: proof.reservationCommit,
    authority: proof.reservationAuthority,
  };
  assertQualificationReservationAuthority(reservationAuthority, reserved);
  assertQualificationReservationAuthorityReobservation(
    proof.observedReservationAuthority,
    qualificationReservationAuthorityExpectation(reservationAuthority, reserved),
  );
  assert.equal(proof.reservationRef, refs.reservationRef);
  sha(proof.reservationOid);
  assert.equal(proof.reservationCommit.oid, proof.reservationOid);
  assert.equal(proof.observedReservationOid, proof.reservationOid);
  assert.deepEqual(proof.reservationCommit.parentOids, [identity.baseSha]);
  assert.ok(
    typeof proof.reservationCommit.message === "string" &&
      Buffer.byteLength(proof.reservationCommit.message) <= 131072,
  );
  const trailer = one(
    proof.reservationCommit.message
      .split(/\r?\n/)
      .filter((line) => line.startsWith("Factory-Event: ")),
    "exact reservation trailer",
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(trailer.slice(15), "base64url").toString("utf8")),
    reserved,
  );
  const stages = Object.fromEntries(
    ["prepared", "turn", "terminal"].map((stage) => {
      const value = assertQualificationCheckpoint(
        proof[stage],
        { ref: `${refs.sessionRef}/${stage}`, path: SESSION_PATH, maxBytes: 196608 },
        [proof.reservationOid],
      );
      assert.equal(value.protocol, "clockgrove.factory/app-server-session-v1");
      assert.equal(value.stage, stage);
      return [stage, value];
    }),
  );
  const { binding, packet } = stages.prepared;
  same(binding, identity);
  assert.equal(binding.attemptId, refs.attemptId);
  assert.equal(binding.cliVersion, "0.153.0");
  assert.equal(binding.packetDigest, hash(canonical(packet)));
  assert.equal(packet.baseSha, identity.baseSha);
  assert.deepEqual(binding.localScopeBatch, reserved.localScopeBatch);
  same(
    binding.localScopeBatch.identity,
    identity,
    keys.filter((key) => key !== "baseSha"),
  );
  assert.equal(binding.localScopeBatch.identity.protocol, "clockgrove.factory/local-scope-v1");
  integer(binding.localScopeBatch.producerPid, 1, Number.MAX_SAFE_INTEGER);
  assert.match(binding.localScopeBatch.producerStartTicks, /^[0-9]{1,30}$/);
  when(binding.localScopeBatch.deadline);
  digest(binding.hostIdentity);
  assert.equal(binding.localScopeBatch.identity.phase, "execution");
  assert.equal(binding.localScopeBatch.identity.commandIndex, 0);
  assert.equal(binding.localScopeBatch.commandCount, 1);
  assert.equal(binding.localScopeBatch.identity.invocationDigest, binding.packetDigest);
  assert.equal(binding.hostIdentity, binding.localScopeBatch.identity.hostIdentity);
  assert.deepEqual(binding.priorTurnIds, []);
  assert.equal(stages.prepared.turnId, undefined);
  for (const value of [stages.turn, stages.terminal]) {
    assert.deepEqual(value.binding, binding);
    assert.deepEqual(value.packet, packet);
    assert.ok(
      typeof value.turnId === "string" && value.turnId.length > 0 && value.turnId.length <= 160,
    );
  }
  const terminal = stages.terminal;
  assert.equal(stages.turn.turnId, terminal.turnId);
  assert.equal(terminal.state, "succeeded");
  assert.equal(terminal.providerStatus, "completed");
  assert.equal(terminal.final.outcome, "succeeded");
  assert.equal(terminal.usageStreamComplete, true);
  const started = one(
    events.filter((event) => event.event === "AttemptStarted"),
    "one original provider start, no replacement",
  );
  same(started, reserved, [
    "objective",
    "workItem",
    "attempt",
    "runId",
    "directorEpoch",
    "policyDigest",
    "backend",
  ]);
  assert.equal(started.providerResourceId, binding.threadId);
  assert.equal(started.resourceHostIdentity, binding.hostIdentity);
  assert.ok(started.sequence > reserved.sequence && reserved.sequence > start.sequence);
  assert.ok(
    Array.isArray(terminal.responseUsage) &&
      terminal.responseUsage.length > 0 &&
      terminal.responseUsage.length <= 1000,
  );
  assert.equal(
    new Set(terminal.responseUsage.map((row) => row.responseId)).size,
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
    assert.equal(binding.usageBaseline[key], 0, "fresh thread usage baseline required");
    sums[key] = terminal.responseUsage.reduce((sum, row) => {
      assert.ok(
        typeof row.responseId === "string" &&
          row.responseId.length > 0 &&
          row.responseId.length <= 160,
      );
      integer(row.usage?.[key], 0, Number.MAX_SAFE_INTEGER);
      return sum + row.usage[key];
    }, 0);
    integer(sums[key], 0, Number.MAX_SAFE_INTEGER);
    assert.equal(terminal.rawTokenUsage.total[key], sums[key]);
  }
  assert.ok(sums.cachedInputTokens <= sums.inputTokens);
  assert.deepEqual(terminal.usage, {
    inputTokens: sums.inputTokens,
    outputTokens: sums.outputTokens,
    cachedInputTokens: sums.cachedInputTokens,
  });
  const worker = one(
    events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.unit === "model_tokens" &&
        event.phase === "execution",
    ),
    "one exact original model accounting receipt",
  );
  budgetIdentity(worker, reserved);
  assert.equal(worker.usageId, `worker-${identity.workItem}-${identity.attempt}`);
  assert.equal(worker.amount, sums.inputTokens + sums.outputTokens);
  assert.ok(worker.sequence > started.sequence);
  if (worker.reportedModelUsage !== undefined)
    assert.deepEqual(worker.reportedModelUsage, terminal.usage);
  return { ...refs, start, reserved, started, terminal, binding, worker };
}
function descriptor(proof, ref, parents, identity, phase, externalRequired = true) {
  const value = assertQualificationCheckpoint(
    proof,
    { ref, path: "artifact-transfer.json", maxBytes: MAX_DESCRIPTOR },
    parents,
  );
  exact(value, ["protocol", "identity", "artifact", "retention", "chunks"]);
  assert.equal(value.protocol, "clockgrove.factory/artifact-transfer");
  assert.deepEqual(value.identity, identity);
  assert.equal(value.retention, "repository-audit");
  const artifact = value.artifact,
    payload = artifact.payload,
    manifest = artifact.fileManifest,
    lfsObjects = artifact.lfsObjects ?? [];
  assert.equal(artifact.protocol, "clockgrove.factory/artifact");
  assert.equal(artifact.outcome, "succeeded");
  assert.equal(artifact.baseSha, identity.baseSha);
  digest(artifact.digest);
  if (externalRequired || payload || lfsObjects.length)
    assert.ok(
      manifest && (payload || lfsObjects.length),
      "large-file proof requires retained content and manifest",
    );
  let normalizedPayload;
  if (payload) {
    exact(payload, ["kind", "digest", "bytes", "chunks"]);
    assert.equal(payload.kind, "content-chunks");
    digest(payload.digest);
    integer(payload.bytes, 5 * 1024 * 1024 + 1, MAX_PATCH);
    assert.ok(Array.isArray(value.chunks) && value.chunks.length > 1 && value.chunks.length <= 64);
    let total = 0;
    const byDigest = new Map();
    for (const [index, chunk] of value.chunks.entries()) {
      exact(chunk, ["digest", "bytes", "oid"]);
      digest(chunk.digest);
      sha(chunk.oid);
      integer(chunk.bytes, 1, MAX_CHUNK);
      if (index < value.chunks.length - 1) assert.equal(chunk.bytes, MAX_CHUNK);
      if (byDigest.has(chunk.digest))
        assert.deepEqual(
          chunk,
          byDigest.get(chunk.digest),
          "conflicting repeated content identity",
        );
      byDigest.set(chunk.digest, chunk);
      total += chunk.bytes;
    }
    assert.equal(total, payload.bytes);
    assert.deepEqual(
      payload.chunks,
      value.chunks.map(({ digest, bytes }) => ({ digest, bytes })),
    );
    assert.equal(
      artifact.patch,
      `# Factory content-addressed Git patch sha256:${payload.digest} bytes:${payload.bytes}\n`,
    );
    normalizedPayload = {
      kind: payload.kind,
      digest: payload.digest,
      bytes: payload.bytes,
      chunks: value.chunks.map(({ digest, bytes }) => ({ digest, bytes })),
    };
  } else {
    assert.equal(artifact.payload, undefined);
    assert.deepEqual(value.chunks, []);
    assert.ok(
      typeof artifact.patch === "string" && Buffer.byteLength(artifact.patch) <= 5 * 1024 * 1024,
    );
  }
  assert.ok(Array.isArray(artifact.changedPaths) && artifact.changedPaths.length <= 5000);
  assert.equal(new Set(artifact.changedPaths).size, artifact.changedPaths.length);
  for (const path of artifact.changedPaths) {
    assert.ok(
      typeof path === "string" &&
        path.length <= 500 &&
        !path.includes("\\") &&
        Array.from(path).every((character) => {
          const code = character.codePointAt(0);
          return code > 31 && code !== 127;
        }),
    );
    assert.ok(
      path
        .split("/")
        .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
    );
  }
  let normalizedManifest;
  if (manifest) {
    exact(manifest, ["baseTreeSha", "resultTreeSha", "files"]);
    sha(manifest.baseTreeSha);
    sha(manifest.resultTreeSha);
    assert.ok(
      Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 5000,
    );
    let resultBytes = 0;
    const files = manifest.files.map((file) => {
      exact(file, ["path", "action", "mode", "bytes", "digest", "mediaType", "generated"]);
      assert.ok(
        typeof file.path === "string" &&
          file.path.length <= 500 &&
          !file.path.includes("\\") &&
          Array.from(file.path).every((character) => {
            const code = character.codePointAt(0);
            return code > 31 && code !== 127;
          }),
      );
      assert.ok(
        file.path
          .split("/")
          .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
      );
      assert.ok(["write", "delete"].includes(file.action));
      assert.ok(["100644", "100755", "120000"].includes(file.mode));
      integer(file.bytes, 0, 100000000);
      digest(file.digest);
      assert.ok(
        typeof file.mediaType === "string" &&
          file.mediaType.length <= 160 &&
          /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i.test(
            file.mediaType,
          ),
      );
      assert.equal(typeof file.generated, "boolean");
      if (file.mode === "120000") assert.equal(file.mediaType, "application/octet-stream");
      if (file.action === "delete") {
        assert.equal(file.bytes, 0);
        assert.equal(file.digest, hash(Buffer.alloc(0)));
        assert.equal(file.mediaType, "application/octet-stream");
      }
      resultBytes += file.bytes;
      return {
        path: file.path,
        action: file.action,
        mode: file.mode,
        bytes: file.bytes,
        digest: file.digest,
        mediaType: file.mediaType,
        generated: file.generated,
      };
    });
    assert.ok(resultBytes <= MAX_PATCH);
    assert.equal(new Set(files.map((file) => file.path)).size, files.length);
    assert.deepEqual([...artifact.changedPaths].sort(), files.map((file) => file.path).sort());
    normalizedManifest = {
      baseTreeSha: manifest.baseTreeSha,
      resultTreeSha: manifest.resultTreeSha,
      files,
    };
  }
  const normalizedLfsObjects = lfsObjects.map((receipt) => {
    exact(receipt, [
      "protocol",
      "path",
      "mode",
      "oid",
      "size",
      "assignmentDigest",
      "payload",
      "rawTransfer",
      "toolVersion",
      "remoteDigest",
      "uploadOutcome",
      "readVerified",
      "receiptRef",
      "digest",
    ]);
    assert.equal(receipt.protocol, "clockgrove.factory/lfs-object-receipt");
    assert.ok(["100644", "100755"].includes(receipt.mode));
    digest(receipt.oid);
    digest(receipt.assignmentDigest);
    digest(receipt.remoteDigest);
    digest(receipt.digest);
    integer(receipt.size, 1, 100_000_000);
    assert.equal(receipt.readVerified, true);
    assert.ok(["uploaded", "already-present"].includes(receipt.uploadOutcome));
    assert.ok(typeof receipt.toolVersion === "string" && receipt.toolVersion.length <= 200);
    const raw = receipt.rawTransfer;
    exact(raw, ["identity", "ref", "intentCommit", "readyCommit"]);
    exact(raw.identity, [
      "domain",
      "repository",
      "objective",
      "baseSha",
      "requestId",
      "subjectDigest",
    ]);
    assert.equal(raw.identity.domain, "worker-artifact");
    assert.equal(raw.identity.repository.toLowerCase(), identity.repository);
    assert.equal(raw.identity.objective, identity.objective);
    assert.equal(raw.identity.baseSha, identity.baseSha);
    assert.equal(raw.identity.subjectDigest, receipt.oid);
    sha(raw.intentCommit);
    sha(raw.readyCommit);
    assert.equal(receipt.payload.kind, "content-chunks");
    assert.equal(receipt.payload.digest, receipt.oid);
    assert.equal(receipt.payload.bytes, receipt.size);
    assert.ok(receipt.payload.chunks.length > 0 && receipt.payload.chunks.length <= 64);
    for (const chunk of receipt.payload.chunks) {
      exact(chunk, ["digest", "bytes"]);
      digest(chunk.digest);
      integer(chunk.bytes, 1, MAX_CHUNK);
    }
    const pointer = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${receipt.oid}\nsize ${receipt.size}\n`,
    );
    const file = manifest?.files.find((candidate) => candidate.path === receipt.path);
    assert.ok(file, "LFS receipt lacks its pointer manifest entry");
    assert.equal(file.mode, receipt.mode);
    assert.equal(file.bytes, pointer.length);
    assert.equal(file.digest, hash(pointer));
    const assignment = hash(
      JSON.stringify({ baseSha: identity.baseSha, path: receipt.path, filter: "lfs" }),
    );
    assert.equal(receipt.assignmentDigest, assignment);
    const transferIdentity = { ...raw.identity, repository: raw.identity.repository.toLowerCase() };
    assert.equal(
      raw.ref,
      `refs/clockgrove-factory/content-transfers/${hash(JSON.stringify(transferIdentity))}`,
    );
    const { digest: receiptDigest, ...core } = receipt;
    assert.equal(receiptDigest, hash(JSON.stringify(core)));
    return receipt;
  });
  const content =
    normalizedPayload || normalizedManifest || normalizedLfsObjects.length
      ? `\0content\0${JSON.stringify({
          ...(normalizedPayload ? { payload: normalizedPayload } : {}),
          ...(normalizedManifest ? { fileManifest: normalizedManifest } : {}),
          ...(normalizedLfsObjects.length ? { lfsObjects: normalizedLfsObjects } : {}),
        })}`
      : "";
  assert.equal(
    hash(
      `${artifact.baseSha}\0${artifact.changedPaths.slice().sort().join("\0")}\0${artifact.patch}${content}`,
    ),
    artifact.digest,
    "original artifact digest differs",
  );
  assert.equal(
    proof.commit.message.trim(),
    `Factory artifact transfer ${phase}\n\nFactory-Artifact: ${artifact.digest}\nFactory-Descriptor: ${hash(Buffer.from(proof.content))}\nFactory-Retention: repository-audit`,
  );
  return value;
}

function tree(value, expected, maxEntries) {
  assert.equal(value.sha, expected);
  assert.ok(
    Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= maxEntries,
  );
  assert.equal(new Set(value.entries.map((entry) => entry.path)).size, value.entries.length);
  const entries = value.entries
    .map((entry) => {
      assert.ok(
        typeof entry.path === "string" &&
          entry.path.length <= 500 &&
          !entry.path.includes("/") &&
          !entry.path.includes("\0"),
      );
      sha(entry.sha);
      assert.ok(["100644", "040000"].includes(entry.mode));
      assert.equal(entry.type, entry.mode === "040000" ? "tree" : "blob");
      return entry;
    })
    .sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.path + (a.type === "tree" ? "/" : "")),
        Buffer.from(b.path + (b.type === "tree" ? "/" : "")),
      ),
    );
  const bytes = Buffer.concat(
    entries.flatMap((entry) => [
      Buffer.from(`${entry.mode.replace(/^0/, "")} ${entry.path}\0`),
      Buffer.from(entry.sha, "hex"),
    ]),
  );
  assert.equal(git("tree", bytes), expected, "reachable chunk tree Git identity differs");
  return entries;
}
function patchBytes(proof, value) {
  if (!value.artifact.payload) {
    const root = tree(proof.ready.treePaths[0], proof.ready.commit.treeOid, 1);
    assert.equal(root[0].path, "artifact-transfer.json");
    assert.deepEqual(proof.chunks, []);
    assert.equal(proof.chunkTree, undefined);
    return Buffer.from(value.artifact.patch);
  }
  const root = tree(proof.ready.treePaths[0], proof.ready.commit.treeOid, 2);
  assert.deepEqual(root.map((entry) => entry.path).sort(), ["artifact-transfer.json", "chunks"]);
  const branch = one(
    root.filter((entry) => entry.path === "chunks"),
    "reachable chunks tree",
  );
  assert.equal(branch.type, "tree");
  const entries = tree(proof.chunkTree, branch.sha, 64);
  const unique = [...new Map(value.chunks.map((chunk) => [chunk.digest, chunk])).values()];
  assert.equal(entries.length, unique.length);
  assert.ok(Array.isArray(proof.chunks) && proof.chunks.length === unique.length);
  const bytesByDigest = new Map();
  for (const chunk of unique) {
    const entry = one(
      entries.filter((entry) => entry.path === chunk.digest),
      "chunk reachability",
    );
    assert.equal(entry.sha, chunk.oid);
    assert.equal(entry.mode, "100644");
    const observed = one(
      proof.chunks.filter((row) => row.digest === chunk.digest),
      "one actual chunk body",
    );
    assert.equal(observed.oid, chunk.oid);
    assert.equal(observed.bytes, chunk.bytes);
    assert.ok(
      typeof observed.base64 === "string" && observed.base64.length <= Math.ceil(MAX_CHUNK / 3) * 4,
    );
    const bytes = Buffer.from(observed.base64, "base64");
    assert.equal(bytes.toString("base64"), observed.base64, "noncanonical chunk encoding");
    assert.equal(bytes.length, chunk.bytes);
    assert.equal(hash(bytes), chunk.digest);
    assert.equal(git("blob", bytes), chunk.oid);
    bytesByDigest.set(chunk.digest, bytes);
  }
  const patch = Buffer.concat(
    value.chunks.map((chunk) => bytesByDigest.get(chunk.digest)),
    value.artifact.payload.bytes,
  );
  assert.equal(hash(patch), value.artifact.payload.digest, "whole patch digest differs");
  return patch;
}

/** Pure retained-proof recheck. Caller supplies actor-authenticated observation receipts. */
export function assertArtifactTransferProof(observation, authority, proof, options) {
  assert.ok(["intent", "ready", "direct"].includes(options.phase));
  assert.equal(proof.phase, options.phase);
  if (options.workItem !== undefined) assert.equal(proof.workItem, options.workItem);
  const events = eventsFor(observation, proof.workItem);
  const context = session(events, authority, proof);
  const { identity, transferRef, start, reserved, started, worker, terminal, binding } = context;
  assert.deepEqual(proof.receipts, events, "retained receipt snapshot differs");
  if (options.phase === "direct") {
    assert.equal(proof.intent, undefined);
    assert.deepEqual(proof.chunks, []);
    const ready = descriptor(proof.ready, `${transferRef}/ready`, [], identity, "ready", true);
    const witness = options.witness;
    const recovered = Boolean(options.priorDirect);
    if (options.priorDirect) {
      assert.equal(options.priorDirect.phase, "direct");
      assert.deepEqual(
        proof.ready,
        options.priorDirect.ready,
        "recovery changed direct ready proof",
      );
      for (const event of options.priorDirect.receipts)
        assert.ok(
          events.some((current) => canonical(current) === canonical(event)),
          "original direct-ready receipt disappeared or changed",
        );
    }
    if (witness)
      assert.ok(
        ready.artifact.lfsObjects?.length > 0,
        "witnessed direct checkpoint lacks produced LFS content",
      );
    assert.deepEqual(
      proof.lfs?.map(({ path, oid, size, receiptRef, transferRef, intentCommit, readyCommit }) => ({
        path,
        oid,
        size,
        receiptRef,
        transferRef,
        intentCommit,
        readyCommit,
      })),
      ready.artifact.lfsObjects.map((receipt) => ({
        path: receipt.path,
        oid: receipt.oid,
        size: receipt.size,
        receiptRef: receipt.receiptRef,
        transferRef: receipt.rawTransfer.ref,
        intentCommit: receipt.rawTransfer.intentCommit,
        readyCommit: receipt.rawTransfer.readyCommit,
      })),
      "produced LFS retained proofs differ from artifact receipts",
    );
    if (witness) {
      same(witness, identity);
      assert.equal(witness.protocol, "clockgrove.factory/artifact-transfer-checkpoint-reached");
      assert.equal(witness.phase, "ready");
      assert.equal(witness.ref, `${transferRef}/ready`);
      assert.equal(witness.commitSha, proof.ready.commit.oid);
      assert.equal(witness.descriptorDigest, hash(proof.ready.content));
      assert.equal(witness.artifactDigest, ready.artifact.digest);
      assert.deepEqual(
        witness.content,
        ready.artifact.lfsObjects.map((receipt) => ({
          digest: receipt.oid,
          bytes: receipt.size,
          chunks: receipt.payload.chunks.length,
        })),
      );
      assert.equal(
        witness.contentBytes,
        ready.artifact.lfsObjects.reduce((sum, receipt) => sum + receipt.size, 0),
      );
      assert.equal(witness.terminal.reservationReceiptDigest, hash(canonical(reserved)));
      assert.equal(witness.terminal.startedReceiptDigest, hash(canonical(started)));
      assert.equal(witness.terminal.modelReceiptDigest, hash(canonical(worker)));
      assert.equal(witness.terminal.modelTokens, worker.amount);
      assert.equal(witness.terminal.usageId, worker.usageId);
      assert.deepEqual(witness.terminal.session, {
        threadId: binding.threadId,
        turnId: terminal.turnId,
        checkpointDigest: hash(JSON.stringify(terminal)),
      });
      const succeeded = events.filter((event) => event.event === "AttemptSucceeded");
      if (recovered) {
        assert.equal(
          succeeded.length,
          1,
          "recovery did not continue the original retained attempt",
        );
        assert.equal(succeeded[0].artifactDigest, ready.artifact.digest);
        assert.equal(succeeded[0].reportedModelTokens, worker.amount);
        assert.equal(
          events.some((event) =>
            [
              "AttemptFailed",
              "AttemptCancelled",
              "AttemptDeferred",
              "PublicationRecorded",
            ].includes(event.event),
          ),
          false,
          "recovered direct checkpoint crossed a failure or publication boundary",
        );
      } else
        assert.equal(
          events.some((event) =>
            [
              "AttemptSucceeded",
              "AttemptCollected",
              "AttemptFailed",
              "AttemptCancelled",
              "ValidationRecorded",
              "PublicationRecorded",
            ].includes(event.event),
          ),
          false,
          "direct retained checkpoint was observed after attempt continuation",
        );
    }
    return {
      artifact: ready.artifact,
      patch: Buffer.from(ready.artifact.patch),
      summary: {
        phase: "direct",
        workItem: identity.workItem,
        runId: identity.runId,
        attempt: identity.attempt,
        artifactDigest: ready.artifact.digest,
        payloadDigest: witness?.content[0]?.digest ?? null,
        payloadBytes: witness?.contentBytes ?? null,
        payloadChunks: witness?.content.reduce((sum, subject) => sum + subject.chunks, 0) ?? 0,
        representation: ready.artifact.lfsObjects?.length ? "produced-lfs" : "inline",
        intentOid: proof.ready.commit.oid,
        readyOid: proof.ready.commit.oid,
        threadId: binding.threadId,
        turnId: terminal.turnId,
        terminalOid: proof.terminal.commit.oid,
        modelTokens: worker.amount,
        nativeUsage: {
          state: "unavailable",
          amount: null,
          evidence: "not-measured-by-checkpoint",
        },
        executionAuthority: false,
        continuation: recovered
          ? "same-attempt-retained-ready"
          : witness
            ? "retained-ready-checkpoint"
            : "not-demonstrated",
        resourceAbsence: "requires-independent-observation",
        manifestBehavior: "requires-independent-Git-and-LFS-readback",
      },
    };
  }
  const externalRequired =
    options.phase === "intent" || Boolean(options.witness || options.priorIntent);
  const intent = descriptor(
    proof.intent,
    `${transferRef}/intent`,
    [],
    identity,
    "intent",
    externalRequired,
  );
  const intentEntries = tree(proof.intent.treePaths[0], proof.intent.commit.treeOid, 1);
  assert.equal(intentEntries[0].path, "artifact-transfer.json");
  const succeeded = events.filter((event) => event.event === "AttemptSucceeded");
  for (const event of succeeded) {
    assert.equal(event.artifactDigest, intent.artifact.digest);
    assert.equal(event.reportedModelTokens, worker.amount);
  }
  assert.ok(succeeded.length <= 1);
  assert.equal(
    events.some((event) =>
      ["AttemptFailed", "AttemptCancelled", "AttemptTimedOut", "AttemptDeferred"].includes(
        event.event,
      ),
    ),
    false,
  );
  const natives = events.filter(
    (event) =>
      event.event === "BudgetReconciled" &&
      event.unit === "local_milliseconds" &&
      event.phase === "execution",
  );
  assert.ok(natives.length <= 1);
  let nativeUsage = { state: "unavailable", amount: null, evidence: "not-measured-by-checkpoint" };
  if (natives.length) {
    const native = natives[0];
    budgetIdentity(native, reserved);
    integer(native.amount, 0, Number.MAX_SAFE_INTEGER);
    assert.ok(
      native.usageEvidence === undefined ||
        ["as-recorded", "conservative-reservation"].includes(native.usageEvidence),
    );
    if (native.usageEvidence === "conservative-reservation") {
      const allocation = one(
        events.filter(
          (event) =>
            event.event === "BudgetReserved" &&
            event.unit === native.unit &&
            event.phase === "execution" &&
            event.attempt === reserved.attempt,
        ),
        "original native allocation",
      );
      budgetIdentity(allocation, reserved);
      assert.equal(native.amount, allocation.amount);
      assert.ok(native.sequence > allocation.sequence);
    }
    nativeUsage = {
      state: "known",
      amount: native.amount,
      evidence: native.usageEvidence ?? "as-recorded",
    };
  }
  const witness = options.witness;
  if (witness) {
    assert.equal(
      witness.protocol,
      "clockgrove.factory/artifact-transfer-checkpoint-reached",
      "unsupported artifact transfer checkpoint witness",
    );
    same(witness, identity);
    assert.equal(witness.activationRequestId, `${authority.namespace}-activate`);
    assert.equal(witness.artifactDigest, intent.artifact.digest);
    assert.equal(witness.phase, "intent");
    assert.deepEqual(witness.content, [
      {
        digest: intent.artifact.payload.digest,
        bytes: intent.artifact.payload.bytes,
        chunks: intent.chunks.length,
      },
    ]);
    assert.equal(witness.contentBytes, intent.artifact.payload.bytes);
    assert.equal(witness.ref, `${transferRef}/intent`);
    assert.equal(witness.commitSha, proof.intent.commit.oid);
    assert.equal(witness.descriptorDigest, hash(proof.intent.content));
    assert.deepEqual(witness.batch, reserved.localScopeBatch);
    const reported = witness.terminal;
    exact(reported, [
      "reservationReceiptDigest",
      "startedReceiptDigest",
      "modelReceiptDigest",
      "modelTokens",
      "usageId",
      "session",
    ]);
    assert.equal(reported.reservationReceiptDigest, hash(canonical(reserved)));
    assert.equal(reported.startedReceiptDigest, hash(canonical(started)));
    assert.equal(reported.modelReceiptDigest, hash(canonical(worker)));
    assert.equal(reported.modelTokens, worker.amount);
    assert.equal(reported.usageId, worker.usageId);
    assert.deepEqual(reported.session, {
      threadId: binding.threadId,
      turnId: terminal.turnId,
      checkpointDigest: hash(JSON.stringify(terminal)),
    });
    digest(witness.armDigest);
    assert.ok(when(witness.reachedAt) >= when(worker.at));
    assert.equal(witness.startedAt, start.at);
    assert.equal(
      when(witness.eligibleUntil),
      when(start.at) + authority.policy.objectiveTimeoutMinutes * 60_000,
    );
    assert.ok(when(witness.eligibleUntil) > when(witness.reachedAt));
    assert.equal(
      when(witness.holdUntil) - when(witness.reachedAt),
      authority.policy.workItemTimeoutMinutes * 60_000,
    );
    assert.equal(witness.executionCleanup, "not-proven-by-checkpoint");
    assert.equal(witness.nativeUsage, "not-measured-by-checkpoint");
  }
  let patch = null;
  if (options.phase === "intent") {
    assert.equal(proof.ready, null);
    assert.deepEqual(proof.readyAbsence, { ref: `${transferRef}/ready`, status: 404 });
    assert.deepEqual(proof.chunks, []);
    assert.equal(succeeded.length, 0, "intent-only hold must precede AttemptSucceeded");
    assert.equal(
      events.some(
        (event) =>
          [
            "AttemptCollected",
            "ValidationRecorded",
            "AttemptValidated",
            "AttemptPublished",
            "AttemptIntegrated",
          ].includes(event.event) ||
          (event.event === "CapacityReserved" && event.phase === "validation"),
      ),
      false,
      "intent hold must precede validation",
    );
  } else {
    if (witness)
      assert.ok(
        options.priorIntent,
        "witnessed continuation requires retained original intent proof",
      );
    const prior = options.priorIntent;
    if (prior) {
      assert.equal(prior.workItem, proof.workItem);
      for (const event of prior.receipts)
        assert.ok(
          events.some((current) => canonical(current) === canonical(event)),
          "original receipt disappeared or changed",
        );
      assertArtifactTransferProof(
        { receipts: prior.receipts.map((event) => ({ event })), status: observation.status },
        authority,
        prior,
        { phase: "intent", witness },
      );
      for (const field of [
        "reservationOid",
        "reservationCommit",
        "prepared",
        "turn",
        "terminal",
        "intent",
      ])
        assert.deepEqual(proof[field], prior[field], `recovery changed original ${field}`);
    }
    const ready = descriptor(
      proof.ready,
      `${transferRef}/ready`,
      [proof.intent.commit.oid],
      identity,
      "ready",
      externalRequired,
    );
    assert.deepEqual(ready, intent);
    assert.equal(succeeded.length, 1);
    assert.equal(nativeUsage.state, "known", "recovery native accounting unavailable");
    patch = patchBytes(proof, ready);
  }
  return {
    artifact: intent.artifact,
    patch,
    summary: {
      phase: options.phase,
      workItem: identity.workItem,
      runId: identity.runId,
      attempt: identity.attempt,
      artifactDigest: intent.artifact.digest,
      payloadDigest: intent.artifact.payload?.digest ?? null,
      payloadBytes: intent.artifact.payload?.bytes ?? null,
      payloadChunks: intent.chunks.length,
      representation: intent.artifact.payload ? "externalized" : "inline",
      intentOid: proof.intent.commit.oid,
      readyOid: proof.ready?.commit.oid ?? null,
      threadId: binding.threadId,
      turnId: terminal.turnId,
      terminalOid: proof.terminal.commit.oid,
      modelTokens: worker.amount,
      nativeUsage,
      executionAuthority: false,
      continuation:
        options.phase === "ready" && options.priorIntent
          ? "same-attempt-intent-to-ready"
          : "not-demonstrated",
      resourceAbsence: "requires-independent-observation",
      manifestBehavior: "requires-independent-Git-application",
    },
  };
}

async function observeProducedLfsReceipt(request, read, receipt) {
  const retained = await read({
    kind: "checkpoint",
    ref: receipt.receiptRef,
    path: "lfs-object-receipt.json",
    maxBytes: MAX_DESCRIPTOR,
  });
  const retainedValue = assertQualificationCheckpoint(
    retained,
    { ref: receipt.receiptRef, path: "lfs-object-receipt.json", maxBytes: MAX_DESCRIPTOR },
    [],
  );
  assert.deepEqual(retainedValue, receipt, "durable LFS upload receipt differs from artifact");
  assert.equal(
    retained.commit.message,
    `Factory LFS object receipt\n\nFactory-LFS-Object: ${receipt.digest}`,
  );
  const intent = await read({
    kind: "checkpoint",
    ref: `${receipt.rawTransfer.ref}/intent`,
    path: "content-transfer.json",
    maxBytes: MAX_DESCRIPTOR,
  });
  const ready = await read({
    kind: "checkpoint",
    ref: `${receipt.rawTransfer.ref}/ready`,
    path: "content-transfer.json",
    maxBytes: MAX_DESCRIPTOR,
  });
  const intentValue = assertQualificationCheckpoint(
    intent,
    {
      ref: `${receipt.rawTransfer.ref}/intent`,
      path: "content-transfer.json",
      maxBytes: MAX_DESCRIPTOR,
    },
    [],
  );
  const readyValue = assertQualificationCheckpoint(
    ready,
    {
      ref: `${receipt.rawTransfer.ref}/ready`,
      path: "content-transfer.json",
      maxBytes: MAX_DESCRIPTOR,
    },
    [intent.commit.oid],
  );
  assert.deepEqual(readyValue, intentValue, "LFS content ready differs from intent");
  assert.equal(intentValue.protocol, "clockgrove.factory/content-transfer");
  assert.deepEqual(intentValue.identity, receipt.rawTransfer.identity);
  assert.deepEqual(intentValue.payload, receipt.payload);
  assert.equal(intent.commit.oid, receipt.rawTransfer.intentCommit);
  assert.equal(ready.commit.oid, receipt.rawTransfer.readyCommit);
  assert.equal(
    intent.commit.message,
    `Factory content transfer intent\n\nFactory-Content: ${receipt.oid}`,
  );
  assert.equal(
    ready.commit.message,
    `Factory content transfer ready\n\nFactory-Content: ${receipt.oid}`,
  );
  const root = tree(ready.treePaths[0], ready.commit.treeOid, 2);
  const branch = one(
    root.filter((entry) => entry.path === "chunks" && entry.type === "tree"),
    "LFS ready chunk tree missing",
  );
  const get = async (route, args) =>
    (await request(route, { ...args, request: { signal: AbortSignal.timeout(15000) } })).data;
  const remoteTree = await get("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    tree_sha: branch.sha,
  });
  assert.equal(remoteTree.truncated, false);
  const entries = tree(
    {
      sha: remoteTree.sha,
      entries: remoteTree.tree.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
    },
    branch.sha,
    64,
  );
  const bodies = new Map();
  for (const chunk of intentValue.chunks) {
    const entry = one(
      entries.filter(
        (candidate) =>
          candidate.path === chunk.digest &&
          candidate.sha === chunk.oid &&
          candidate.mode === "100644",
      ),
      "LFS retained content chunk missing",
    );
    if (bodies.has(chunk.digest)) continue;
    const blob = await get("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
      file_sha: entry.sha,
    });
    const bytes = Buffer.from(blob.content, "base64");
    assert.equal(blob.encoding, "base64");
    assert.equal(bytes.length, chunk.bytes);
    assert.equal(hash(bytes), chunk.digest);
    assert.equal(git("blob", bytes), chunk.oid);
    bodies.set(chunk.digest, bytes);
  }
  const raw = Buffer.concat(intentValue.chunks.map((chunk) => bodies.get(chunk.digest)));
  assert.equal(raw.length, receipt.size);
  assert.equal(hash(raw), receipt.oid);
  return {
    path: receipt.path,
    oid: receipt.oid,
    size: receipt.size,
    receiptRef: receipt.receiptRef,
    receiptCommit: retained.commit.oid,
    transferRef: receipt.rawTransfer.ref,
    intentCommit: intent.commit.oid,
    readyCommit: ready.commit.oid,
    chunkCount: intentValue.chunks.length,
  };
}

/** Exact GET-only observer. Errors other than the exact ready-ref 404 propagate unchanged. */
export async function observeArtifactTransfer(request, observation, authority, options) {
  const events = eventsFor(observation, options.workItem);
  const reservation = one(
    events.filter((event) => event.event === "AttemptReserved"),
    "one original reservation",
  );
  const refs = identities(authority, reservation),
    read = nativeProofReader(request),
    resolved = await observeQualificationReservationAuthority(request, reservation);
  const proof = {
    phase: options.phase,
    workItem: options.workItem,
    receipts: events,
    reservationRef: resolved.logicalRef,
    reservationOid: resolved.reservationOid,
    reservationCommit: resolved.reservationCommit,
    reservationAuthority: resolved.authority,
    chunks: [],
    ready: null,
  };
  for (const stage of ["prepared", "turn", "terminal"])
    proof[stage] = await read({
      kind: "checkpoint",
      ref: `${refs.sessionRef}/${stage}`,
      path: SESSION_PATH,
      maxBytes: 196608,
    });
  if (options.phase === "direct") {
    proof.ready = await read({
      kind: "checkpoint",
      ref: `${refs.transferRef}/ready`,
      path: "artifact-transfer.json",
      maxBytes: MAX_DESCRIPTOR,
    });
    const value = descriptor(
      proof.ready,
      `${refs.transferRef}/ready`,
      [],
      refs.identity,
      "ready",
      true,
    );
    proof.lfs = [];
    for (const receipt of value.artifact.lfsObjects ?? [])
      proof.lfs.push(await observeProducedLfsReceipt(request, read, receipt));
  } else {
    proof.intent = await read({
      kind: "checkpoint",
      ref: `${refs.transferRef}/intent`,
      path: "artifact-transfer.json",
      maxBytes: MAX_DESCRIPTOR,
    });
  }
  if (options.phase === "intent") {
    let absent = false;
    try {
      await read({ kind: "ref", ref: `${refs.transferRef}/ready` });
    } catch (error) {
      if (error?.status !== 404) throw error;
      absent = true;
    }
    assert.ok(absent, "ready already exists; not a partial-transfer hold");
    proof.readyAbsence = { ref: `${refs.transferRef}/ready`, status: 404 };
  } else if (options.phase === "ready") {
    assert.equal(options.phase, "ready");
    proof.ready = await read({
      kind: "checkpoint",
      ref: `${refs.transferRef}/ready`,
      path: "artifact-transfer.json",
      maxBytes: MAX_DESCRIPTOR,
    });
    const value = descriptor(
      proof.ready,
      `${refs.transferRef}/ready`,
      [proof.intent.commit.oid],
      refs.identity,
      "ready",
      Boolean(options.witness || options.priorIntent),
    );
    if (value.artifact.payload) {
      const root = tree(proof.ready.treePaths[0], proof.ready.commit.treeOid, 2);
      const branch = one(
        root.filter((entry) => entry.path === "chunks" && entry.type === "tree"),
        "ready chunks tree missing",
      );
      const get = async (route, args) =>
        (await request(route, { ...args, request: { signal: AbortSignal.timeout(15000) } })).data;
      const data = await get("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        tree_sha: branch.sha,
      });
      assert.equal(data.truncated, false);
      proof.chunkTree = {
        sha: data.sha,
        entries: data.tree.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
      };
      tree(proof.chunkTree, branch.sha, 64);
      for (const chunk of [
        ...new Map(value.chunks.map((chunk) => [chunk.digest, chunk])).values(),
      ]) {
        const entry = one(
          proof.chunkTree.entries.filter(
            (entry) =>
              entry.path === chunk.digest && entry.sha === chunk.oid && entry.mode === "100644",
          ),
          "bound chunk missing",
        );
        const blob = await get("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          file_sha: entry.sha,
        });
        assert.equal(blob.sha, chunk.oid);
        assert.equal(blob.encoding, "base64");
        assert.equal(blob.size, chunk.bytes);
        assert.ok(typeof blob.content === "string" && blob.content.length <= MAX_CHUNK * 2);
        const bytes = Buffer.from(blob.content, "base64");
        assert.equal(bytes.length, chunk.bytes);
        assert.equal(hash(bytes), chunk.digest);
        assert.equal(git("blob", bytes), chunk.oid);
        proof.chunks.push({
          digest: chunk.digest,
          oid: chunk.oid,
          bytes: chunk.bytes,
          base64: bytes.toString("base64"),
        });
      }
    }
    assert.equal(
      await read({ kind: "ref", ref: `${refs.transferRef}/ready` }),
      proof.ready.commit.oid,
    );
  }
  if (proof.intent)
    assert.equal(
      await read({ kind: "ref", ref: `${refs.transferRef}/intent` }),
      proof.intent.commit.oid,
    );
  if (proof.ready)
    assert.equal(
      await read({ kind: "ref", ref: `${refs.transferRef}/ready` }),
      proof.ready.commit.oid,
    );
  proof.observedReservationAuthority = await reobserveQualificationReservationAuthority(
    request,
    resolved,
    reservation,
  );
  proof.observedReservationOid = proof.observedReservationAuthority.reservationOid;
  return { proof, ...assertArtifactTransferProof(observation, authority, proof, options) };
}
