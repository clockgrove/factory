/** Independent, read-only resolution of an authenticated AttemptReserved receipt. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const SHA = /^[a-f0-9]{40}$/;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY = 4096;
const MAX_PARENTS = 16384;
const marker = "Factory-Issue-Admission: ";
const eventMarker = "Factory-Event: ";
const barrierMarker = "Factory-Admission-Barrier: ";

const sha = (value, message = "invalid Git object identity") => assert.match(value, SHA, message);
const positive = (value, message = "invalid positive identity") =>
  assert.ok(Number.isSafeInteger(value) && value > 0, message);
const text = (value, maximum = 1024, message = "invalid bounded text") =>
  assert.ok(
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum,
    message,
  );
const exactKeys = (value, required, optional = []) => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  assert.ok(
    actual.every((key) => allowed.has(key)),
    "unknown issue admission field",
  );
  assert.ok(
    required.every((key) => Object.hasOwn(value, key)),
    "issue admission field missing",
  );
};
const decode = (encoded, label) => {
  assert.ok(
    typeof encoded === "string" &&
      encoded.length > 0 &&
      /^[A-Za-z0-9_-]+$/.test(encoded) &&
      encoded.length <= Math.ceil((MAX_LEDGER_BYTES * 4) / 3),
    `${label} encoding is invalid`,
  );
  const bytes = Buffer.from(encoded, "base64url");
  assert.equal(bytes.toString("base64url"), encoded, `${label} encoding is noncanonical`);
  assert.ok(bytes.length <= MAX_LEDGER_BYTES, `${label} exceeds byte bound`);
  const source = bytes.toString("utf8");
  assert.ok(Buffer.from(source).equals(bytes), `${label} is not UTF-8`);
  return JSON.parse(source);
};
const onlyMarker = (message, prefix, label) => {
  assert.ok(typeof message === "string", `${label} message unavailable`);
  const lines = message.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, `${label} marker missing or ambiguous`);
  return decode(lines[0].slice(prefix.length), label);
};
const sameJson = (left, right, message) => assert.deepEqual(left, right, message);
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
const digest = (value) => createHash("sha256").update(value).digest("hex");
const digestValue = (value, message = "invalid digest") =>
  assert.match(value, /^[a-f0-9]{64}$/, message);
const safeId = (value) => {
  text(value, 160, "invalid safe identity");
  assert.match(value, /^[A-Za-z0-9._:/+-]+$/, "invalid safe identity");
};
const isoDate = (value) => {
  text(value, 64, "invalid timestamp");
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "invalid timestamp");
  assert.ok(Number.isFinite(Date.parse(value)), "invalid timestamp");
};
const repositoryPath = (value) => {
  text(value, 500, "invalid runtime path");
  assert.ok(
    !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      !value.includes("//") &&
      !value.includes("*") &&
      !value.includes("?") &&
      !value.includes("[") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "invalid runtime path",
  );
};

export function qualificationReservationRefs(reserved) {
  positive(reserved?.objective, "invalid reservation Objective");
  positive(reserved?.workItem, "invalid reservation Work Item");
  positive(reserved?.attempt, "invalid reservation attempt");
  return {
    logicalRef: `refs/clockgrove-factory/attempts/objective-${reserved.objective}/work-item-${reserved.workItem}/attempt-${reserved.attempt}`,
    authorityRef: `refs/clockgrove-factory/admission/work-item-${reserved.workItem}`,
  };
}

function settlement(entry, evidence) {
  exactKeys(
    evidence,
    [
      "reservationOid",
      "resourceIdentity",
      "capacityReservationId",
      "budgetReservationId",
      "producerStopped",
      "resourcesReleased",
      "capacityReleased",
      "accountingSettled",
      "evidenceOid",
    ],
    ["unknownModelUsageRetained"],
  );
  sha(evidence.reservationOid);
  sha(evidence.evidenceOid);
  for (const key of ["resourceIdentity", "capacityReservationId", "budgetReservationId"])
    text(evidence[key]);
  assert.equal(evidence.producerStopped, true);
  assert.equal(evidence.resourcesReleased, true);
  assert.equal(evidence.capacityReleased, true);
  assert.equal(typeof evidence.accountingSettled, "boolean");
  if (evidence.unknownModelUsageRetained !== undefined)
    assert.equal(evidence.unknownModelUsageRetained, true);
  assert.notEqual(
    evidence.accountingSettled,
    Boolean(evidence.unknownModelUsageRetained),
    "issue admission accounting settlement is contradictory",
  );
  assert.equal(evidence.reservationOid, entry.reservation.oid);
  assert.equal(evidence.resourceIdentity, entry.resourceIdentity);
  assert.equal(evidence.capacityReservationId, entry.capacityReservationId);
  assert.equal(evidence.budgetReservationId, entry.budgetReservationId);
}

function runtimePlatform(value) {
  exactKeys(value, ["os", "architecture", "libc"]);
  assert.deepEqual(value, { os: "linux", architecture: "x64", libc: "glibc" });
}

function runtimeRequirement(value) {
  exactKeys(value, [
    "tool",
    "adapter",
    "adapterContract",
    "platform",
    "releaseChannel",
    "bundleDigest",
  ]);
  assert.ok(["npm", "pnpm", "bun", "uv"].includes(value.tool));
  safeId(value.adapter);
  assert.ok(Number.isSafeInteger(value.adapterContract) && value.adapterContract > 0);
  assert.ok(value.adapterContract <= 1000);
  runtimePlatform(value.platform);
  assert.equal(value.releaseChannel, "ga");
  digestValue(value.bundleDigest);
}

function runtimeReceipt(value) {
  exactKeys(value, [
    "protocol",
    "tool",
    "adapter",
    "adapterContract",
    "platform",
    "components",
    "resolvedAt",
    "digest",
  ]);
  assert.equal(value.protocol, "clockgrove.factory/toolchain-runtime-bundle-v1");
  assert.ok(["npm", "pnpm", "bun", "uv"].includes(value.tool));
  safeId(value.adapter);
  assert.ok(
    Number.isSafeInteger(value.adapterContract) &&
      value.adapterContract > 0 &&
      value.adapterContract <= 1000,
  );
  runtimePlatform(value.platform);
  assert.ok(Array.isArray(value.components) && value.components.length > 0);
  assert.ok(value.components.length <= 8);
  for (const component of value.components) {
    exactKeys(
      component,
      ["id", "version", "release", "asset", "executablePath", "executableSha256", "treeSha256"],
      ["executableOnly", "entrypoints"],
    );
    safeId(component.id);
    text(component.version, 160);
    exactKeys(
      component.release,
      ["provider", "repository", "releaseId", "tag", "publishedAt"],
      ["channel"],
    );
    assert.ok(["github", "nodejs"].includes(component.release.provider));
    text(component.release.repository, 200);
    text(component.release.releaseId, 500);
    text(component.release.tag, 200);
    isoDate(component.release.publishedAt);
    if (component.release.channel !== undefined) text(component.release.channel, 160);
    exactKeys(component.asset, ["assetId", "name", "url", "size", "sha256", "archive"]);
    text(component.asset.assetId, 2048);
    text(component.asset.name, 500);
    text(component.asset.url, 2048);
    assert.ok(
      Number.isSafeInteger(component.asset.size) &&
        component.asset.size > 0 &&
        component.asset.size <= 512 * 1024 * 1024,
    );
    digestValue(component.asset.sha256);
    assert.ok(["raw", "tar.gz", "tar.xz", "zip"].includes(component.asset.archive));
    repositoryPath(component.executablePath);
    digestValue(component.executableSha256);
    digestValue(component.treeSha256);
    if (component.executableOnly !== undefined) assert.equal(component.executableOnly, true);
    if (component.entrypoints !== undefined) {
      assert.ok(
        Array.isArray(component.entrypoints) &&
          component.entrypoints.length > 0 &&
          component.entrypoints.length <= 16,
      );
      for (const entrypoint of component.entrypoints) {
        exactKeys(entrypoint, ["id", "version", "path", "sha256"], ["interpreter"]);
        safeId(entrypoint.id);
        text(entrypoint.version, 160);
        repositoryPath(entrypoint.path);
        digestValue(entrypoint.sha256);
        if (entrypoint.interpreter !== undefined) safeId(entrypoint.interpreter);
      }
    }
  }
  assert.equal(
    new Set(value.components.map(({ id }) => id)).size,
    value.components.length,
    "runtime receipt components are duplicated",
  );
  isoDate(value.resolvedAt);
  digestValue(value.digest);
  const { digest: observed, resolvedAt: _resolvedAt, ...identity } = value;
  assert.equal(observed, digest(canonical(identity)), "runtime receipt digest mismatch");
}

function optionalBinding(value, kind) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  const encoded = JSON.stringify(value);
  assert.ok(encoded && Buffer.byteLength(encoded) <= 1024 * 1024, `${kind} exceeds bound`);
  if (kind === "artifactConsumer") {
    exactKeys(value, [
      "sourceRunId",
      "sourceReservationOid",
      "sourceAttempt",
      "artifactDigest",
      "recoveryPlanCommitOid",
      "recoveryClaimOid",
    ]);
    safeId(value.sourceRunId);
    sha(value.sourceReservationOid);
    positive(value.sourceAttempt);
    digestValue(value.artifactDigest);
    sha(value.recoveryPlanCommitOid);
    sha(value.recoveryClaimOid);
  } else {
    exactKeys(value, [
      "protocol",
      "baseSha",
      "sourceRef",
      "requirements",
      "receipts",
      "packetDigest",
      "proofDigests",
      "digest",
    ]);
    assert.equal(value.protocol, "clockgrove.factory/managed-runtime-activation-v1");
    sha(value.baseSha);
    text(value.sourceRef, 500);
    assert.ok(
      Array.isArray(value.requirements) &&
        value.requirements.length > 0 &&
        value.requirements.length <= 8,
    );
    value.requirements.forEach(runtimeRequirement);
    assert.ok(
      Array.isArray(value.receipts) &&
        value.receipts.length > 0 &&
        value.receipts.length === value.requirements.length,
    );
    value.receipts.forEach(runtimeReceipt);
    assert.ok(Array.isArray(value.proofDigests) && value.proofDigests.length <= 32);
    for (const item of [value.packetDigest, value.digest, ...value.proofDigests]) digestValue(item);
    assert.equal(
      new Set(value.requirements.map(({ adapter, tool }) => `${adapter}\0${tool}`)).size,
      value.requirements.length,
      "managed runtime activation is duplicated",
    );
    assert.equal(
      new Set(value.proofDigests).size,
      value.proofDigests.length,
      "managed runtime activation is duplicated",
    );
    for (const requirement of value.requirements) {
      const matches = value.receipts.filter(
        (receipt) =>
          receipt.tool === requirement.tool &&
          receipt.adapter === requirement.adapter &&
          receipt.adapterContract === requirement.adapterContract &&
          canonical(receipt.platform) === canonical(requirement.platform) &&
          receipt.digest === requirement.bundleDigest,
      );
      assert.equal(matches.length, 1, "managed runtime activation receipt differs");
    }
    const { digest: observed, ...identity } = value;
    assert.equal(
      observed,
      digest(canonical(identity)),
      "managed runtime activation digest mismatch",
    );
  }
}

function parseLedger(commit, reserved, authorityRef) {
  assert.ok(Buffer.byteLength(commit.message) <= MAX_LEDGER_BYTES, "issue admission exceeds bound");
  const record = onlyMarker(commit.message, marker, "issue admission");
  exactKeys(
    record,
    ["protocol", "workItem", "workItemNodeId", "revision", "priorRevisionOid", "history"],
    ["operationId"],
  );
  assert.equal(record.protocol, "clockgrove.factory/issue-admission-v1");
  assert.equal(record.workItem, reserved.workItem);
  positive(record.revision, "invalid issue admission revision");
  text(record.workItemNodeId);
  if (record.operationId !== undefined)
    assert.match(
      record.operationId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  if (record.priorRevisionOid !== null) sha(record.priorRevisionOid);
  assert.ok(
    Array.isArray(record.history) &&
      record.history.length > 0 &&
      record.history.length <= MAX_HISTORY,
    "issue admission history exceeds bound",
  );
  assert.equal(record.revision === 1, record.priorRevisionOid === null);
  assert.ok(Array.isArray(commit.parentOids) && commit.parentOids.length <= MAX_PARENTS);
  assert.equal(
    commit.parentOids[0],
    record.priorRevisionOid ?? record.history[0]?.reservation?.baseSha,
    "issue admission prior ancestry changed",
  );
  if (record.revision === 1) {
    assert.ok(
      commit.parentOids.length >= record.history.length + 1,
      "initial admission metadata is not retained",
    );
    record.history.forEach((entry, index) =>
      assert.equal(
        commit.parentOids[index + 1],
        entry?.reservation?.oid,
        "initial admission metadata is not retained",
      ),
    );
  }
  let priorAttempt = 0;
  const reservationOids = new Set();
  for (const entry of record.history) {
    exactKeys(
      entry,
      [
        "workItem",
        "workItemNodeId",
        "objective",
        "runId",
        "directorEpoch",
        "writerHolder",
        "policyDigest",
        "graphDigest",
        "graphCommitOid",
        "projectionCommitOid",
        "reservation",
        "capacityReservationId",
        "budgetReservationId",
        "resourceIdentity",
        "compatibilityClaimOid",
        "disposition",
        "writerEpoch",
        "currentWriterHolder",
        "dispatchPossible",
      ],
      [
        "artifactConsumer",
        "managedRuntimeActivation",
        "evidence",
        "imported",
        "reassignmentReceiptOid",
        "settledBySuccessor",
      ],
    );
    assert.equal(entry.workItem, record.workItem);
    assert.equal(entry.workItemNodeId, record.workItemNodeId);
    positive(entry.objective);
    positive(entry.directorEpoch);
    positive(entry.writerEpoch);
    assert.ok(entry.writerEpoch >= entry.directorEpoch, "issue admission writer epoch regressed");
    for (const key of [
      "runId",
      "writerHolder",
      "policyDigest",
      "graphDigest",
      "capacityReservationId",
      "budgetReservationId",
      "resourceIdentity",
      "currentWriterHolder",
    ])
      text(entry[key]);
    for (const key of ["graphCommitOid", "projectionCommitOid", "compatibilityClaimOid"])
      sha(entry[key]);
    assert.match(entry.policyDigest, /^[a-f0-9]{64}$/);
    assert.match(entry.graphDigest, /^[a-f0-9]{64}$/);
    exactKeys(entry.reservation, ["ref", "oid", "attempt", "backend", "baseSha"]);
    text(entry.reservation.ref);
    sha(entry.reservation.oid);
    positive(entry.reservation.attempt);
    text(entry.reservation.backend);
    sha(entry.reservation.baseSha);
    assert.ok(
      entry.reservation.attempt > priorAttempt && !reservationOids.has(entry.reservation.oid),
      "invalid issue admission history",
    );
    priorAttempt = entry.reservation.attempt;
    reservationOids.add(entry.reservation.oid);
    assert.ok(
      ["prepared", "dispatching", "terminal", "reconciled", "released"].includes(entry.disposition),
      "unknown issue admission disposition",
    );
    assert.equal(typeof entry.dispatchPossible, "boolean");
    assert.ok(
      !(entry.disposition === "prepared" && entry.dispatchPossible) &&
        !(entry.disposition === "dispatching" && !entry.dispatchPossible) &&
        !(entry.imported && !entry.dispatchPossible),
      "issue admission dispatch evidence changed",
    );
    if (entry.imported !== undefined) assert.equal(entry.imported, true);
    if (entry.reassignmentReceiptOid !== undefined) sha(entry.reassignmentReceiptOid);
    if (entry.artifactConsumer !== undefined)
      optionalBinding(entry.artifactConsumer, "artifactConsumer");
    if (entry.managedRuntimeActivation !== undefined)
      optionalBinding(entry.managedRuntimeActivation, "managedRuntimeActivation");
    if (["reconciled", "released"].includes(entry.disposition)) settlement(entry, entry.evidence);
    else if (entry.evidence !== undefined) settlement(entry, entry.evidence);
    if (entry.settledBySuccessor !== undefined) {
      exactKeys(entry.settledBySuccessor, [
        "objective",
        "runId",
        "directorEpoch",
        "writerHolder",
        "policyDigest",
        "graphDigest",
        "graphCommitOid",
        "projectionCommitOid",
        "authorityReceiptOid",
      ]);
      const successor = entry.settledBySuccessor;
      positive(successor.objective);
      positive(successor.directorEpoch);
      for (const key of ["runId", "writerHolder", "policyDigest", "graphDigest"])
        text(successor[key]);
      assert.match(successor.policyDigest, /^[a-f0-9]{64}$/);
      assert.match(successor.graphDigest, /^[a-f0-9]{64}$/);
      for (const key of ["graphCommitOid", "projectionCommitOid", "authorityReceiptOid"])
        sha(successor[key]);
      assert.ok(
        entry.disposition === "released" &&
          successor.objective === entry.objective &&
          successor.runId !== entry.runId,
        "successor settlement identity changed",
      );
    }
  }
  const { logicalRef } = qualificationReservationRefs(reserved);
  const matches = record.history.filter(
    (entry) =>
      entry.reservation.ref === logicalRef &&
      entry.reservation.attempt === reserved.attempt &&
      entry.workItem === reserved.workItem &&
      entry.objective === reserved.objective &&
      entry.runId === reserved.runId,
  );
  assert.equal(matches.length, 1, "issue admission target missing or ambiguous");
  const entry = matches[0];
  assert.equal(entry.directorEpoch, reserved.directorEpoch);
  assert.equal(entry.policyDigest, reserved.policyDigest);
  assert.equal(entry.reservation.backend, reserved.backend);
  assert.equal(entry.reservation.baseSha, reserved.baseSha);
  if (entry.artifactConsumer !== undefined || reserved.artifactConsumer !== undefined)
    sameJson(
      entry.artifactConsumer,
      reserved.artifactConsumer,
      "artifact consumer binding differs",
    );
  if (
    entry.managedRuntimeActivation !== undefined ||
    reserved.managedRuntimeActivation !== undefined
  )
    sameJson(
      entry.managedRuntimeActivation,
      reserved.managedRuntimeActivation,
      "managed runtime activation differs",
    );
  return { record, entry, authorityRef };
}

function reservationCommit(commit, oid, reserved) {
  sha(oid);
  assert.equal(commit.oid, oid, "reservation commit OID changed");
  assert.deepEqual(commit.parentOids, [reserved.baseSha], "reservation source parent differs");
  const event = onlyMarker(commit.message, eventMarker, "reservation event");
  sameJson(event, reserved, "reservation Git proof differs from authenticated receipt");
  return commit;
}

function admissionBarrierCommit(commit, oid, logicalRef, compatibilityClaimOid, reserved) {
  sha(oid);
  assert.equal(commit?.oid, oid, "admission compatibility barrier OID changed");
  assert.deepEqual(
    commit.parentOids,
    [compatibilityClaimOid],
    "admission compatibility barrier lost its authenticated claim binding",
  );
  const barrier = onlyMarker(commit.message, barrierMarker, "admission compatibility barrier");
  exactKeys(barrier, ["protocol", "objective", "workItem", "attempt"]);
  assert.equal(barrier.protocol, "clockgrove.factory/admission-barrier-v1");
  positive(barrier.objective);
  positive(barrier.workItem);
  positive(barrier.attempt);
  assert.equal(
    logicalRef,
    `refs/clockgrove-factory/attempts/objective-${barrier.objective}/work-item-${barrier.workItem}/attempt-${barrier.attempt}`,
    "admission compatibility barrier binding differs",
  );
  assert.deepEqual(
    [barrier.objective, barrier.workItem, barrier.attempt],
    [reserved.objective, reserved.workItem, reserved.attempt],
    "admission compatibility barrier reservation identity differs",
  );
  return commit;
}

export function assertQualificationReservationAuthority(proof, reserved) {
  assert.ok(proof && typeof proof === "object");
  const refs = qualificationReservationRefs(reserved);
  assert.equal(proof.logicalRef, refs.logicalRef);
  sha(proof.reservationOid);
  reservationCommit(proof.reservationCommit, proof.reservationOid, reserved);
  exactKeys(proof.authority, ["source", "canonical", "legacy"]);
  const { canonical, legacy } = proof.authority;
  exactKeys(canonical, ["ref", "openingOid", "closingOid"], ["commit"]);
  exactKeys(legacy, ["ref", "openingOid", "closingOid"], ["commit"]);
  assert.equal(canonical.ref, refs.authorityRef);
  assert.equal(legacy.ref, refs.logicalRef);
  assert.equal(canonical.openingOid, canonical.closingOid, "canonical authority moved");
  assert.equal(legacy.openingOid, legacy.closingOid, "legacy authority moved");
  for (const oid of [canonical.openingOid, legacy.openingOid]) if (oid !== null) sha(oid);
  if (proof.authority.source === "issue-admission") {
    assert.equal(canonical.openingOid, canonical.commit?.oid);
    const parsed = parseLedger(canonical.commit, reserved, refs.authorityRef);
    assert.equal(parsed.entry.reservation.oid, proof.reservationOid);
    if (legacy.openingOid === null || legacy.openingOid === proof.reservationOid)
      assert.equal(legacy.commit, undefined, "unexpected legacy authority commit");
    else
      admissionBarrierCommit(
        legacy.commit,
        legacy.openingOid,
        refs.logicalRef,
        parsed.entry.compatibilityClaimOid,
        reserved,
      );
  } else {
    assert.equal(proof.authority.source, "legacy-attempt");
    assert.equal(canonical.openingOid, null, "legacy fallback has canonical authority");
    assert.equal(canonical.commit, undefined);
    assert.equal(legacy.openingOid, proof.reservationOid);
    assert.equal(legacy.commit, undefined, "unexpected legacy authority commit");
  }
  return proof;
}

/** Transport-independent precedence and stable-snapshot core. */
export async function resolveQualificationReservationAuthority(port, reserved) {
  const refs = qualificationReservationRefs(reserved);
  const canonicalOpening = await port.readRef(refs.authorityRef);
  if (canonicalOpening !== null) {
    sha(canonicalOpening);
    const ledgerCommit = await port.readCommit(canonicalOpening);
    assert.equal(ledgerCommit.oid, canonicalOpening, "issue admission commit OID changed");
    const parsed = parseLedger(ledgerCommit, reserved, refs.authorityRef);
    const oid = parsed.entry.reservation.oid;
    const commit = reservationCommit(await port.readCommit(oid), oid, reserved);
    const legacyOpening = await port.readRef(refs.logicalRef);
    const legacyCommit =
      legacyOpening !== null && legacyOpening !== oid
        ? await port.readCommit(legacyOpening)
        : undefined;
    const legacyClosing = await port.readRef(refs.logicalRef);
    const canonicalClosing = await port.readRef(refs.authorityRef);
    return assertQualificationReservationAuthority(
      {
        logicalRef: refs.logicalRef,
        reservationOid: oid,
        reservationCommit: commit,
        authority: {
          source: "issue-admission",
          canonical: {
            ref: refs.authorityRef,
            openingOid: canonicalOpening,
            closingOid: canonicalClosing,
            commit: ledgerCommit,
          },
          legacy: {
            ref: refs.logicalRef,
            openingOid: legacyOpening,
            closingOid: legacyClosing,
            ...(legacyCommit ? { commit: legacyCommit } : {}),
          },
        },
      },
      reserved,
    );
  }
  const legacyOpening = await port.readRef(refs.logicalRef);
  assert.notEqual(legacyOpening, null, "reservation authority is absent");
  const commit = reservationCommit(await port.readCommit(legacyOpening), legacyOpening, reserved);
  const legacyClosing = await port.readRef(refs.logicalRef);
  const canonicalClosing = await port.readRef(refs.authorityRef);
  return assertQualificationReservationAuthority(
    {
      logicalRef: refs.logicalRef,
      reservationOid: legacyOpening,
      reservationCommit: commit,
      authority: {
        source: "legacy-attempt",
        canonical: {
          ref: refs.authorityRef,
          openingOid: null,
          closingOid: canonicalClosing,
        },
        legacy: {
          ref: refs.logicalRef,
          openingOid: legacyOpening,
          closingOid: legacyClosing,
        },
      },
    },
    reserved,
  );
}

export function qualificationReservationAuthorityExpectation(proof, reserved) {
  const checked = assertQualificationReservationAuthority(proof, reserved);
  return {
    source: checked.authority.source,
    canonical: {
      ref: checked.authority.canonical.ref,
      oid: checked.authority.canonical.closingOid,
    },
    legacy: {
      ref: checked.authority.legacy.ref,
      oid: checked.authority.legacy.closingOid,
      kind:
        checked.authority.legacy.closingOid === null
          ? "absent"
          : checked.authority.legacy.closingOid === checked.reservationOid
            ? "reservation"
            : "compatibility-barrier",
    },
    reservationOid: checked.reservationOid,
  };
}

function checkedAuthorityExpectation(expectation) {
  exactKeys(expectation, ["source", "canonical", "legacy", "reservationOid"]);
  exactKeys(expectation.canonical, ["ref", "oid"]);
  exactKeys(expectation.legacy, ["ref", "oid", "kind"]);
  assert.ok(["issue-admission", "legacy-attempt"].includes(expectation.source));
  assert.match(
    expectation.canonical.ref,
    /^refs\/clockgrove-factory\/admission\/work-item-[1-9][0-9]*$/,
  );
  assert.match(
    expectation.legacy.ref,
    /^refs\/clockgrove-factory\/attempts\/objective-[1-9][0-9]*\/work-item-[1-9][0-9]*\/attempt-[1-9][0-9]*$/,
  );
  sha(expectation.reservationOid);
  for (const oid of [expectation.canonical.oid, expectation.legacy.oid]) if (oid !== null) sha(oid);
  if (expectation.source === "issue-admission") {
    assert.notEqual(expectation.canonical.oid, null, "canonical authority is absent");
    assert.equal(
      expectation.legacy.kind,
      expectation.legacy.oid === null
        ? "absent"
        : expectation.legacy.oid === expectation.reservationOid
          ? "reservation"
          : "compatibility-barrier",
      "legacy authority classification differs",
    );
  } else {
    assert.equal(expectation.canonical.oid, null, "legacy fallback has canonical authority");
    assert.equal(expectation.legacy.oid, expectation.reservationOid);
    assert.equal(expectation.legacy.kind, "reservation");
  }
  return expectation;
}

export function assertQualificationReservationAuthorityReobservation(observation, expectation) {
  checkedAuthorityExpectation(expectation);
  exactKeys(observation, ["source", "canonical", "legacy", "reservationOid"]);
  for (const name of ["canonical", "legacy"]) {
    exactKeys(observation[name], ["ref", "openingOid", "closingOid"]);
    assert.equal(observation[name].ref, expectation[name].ref);
    assert.equal(
      observation[name].openingOid,
      observation[name].closingOid,
      `${name} reservation authority moved during final observation`,
    );
    assert.equal(
      observation[name].closingOid,
      expectation[name].oid,
      `${name} reservation authority changed after dependent proof reads`,
    );
  }
  assert.equal(observation.source, expectation.source);
  assert.equal(observation.reservationOid, expectation.reservationOid);
  const selected =
    observation.source === "issue-admission"
      ? observation.canonical.closingOid
      : observation.legacy.closingOid;
  assert.notEqual(selected, null, "selected reservation authority disappeared");
  if (observation.source === "legacy-attempt")
    assert.equal(observation.canonical.closingOid, null, "canonical authority appeared");
  return observation;
}

/** Reobserve both mutable locators after all dependent immutable proof reads. */
export async function revalidateQualificationReservationAuthority(port, expectation) {
  checkedAuthorityExpectation(expectation);
  const canonicalOpening = await port.readRef(expectation.canonical.ref);
  const legacyOpening = await port.readRef(expectation.legacy.ref);
  const legacyClosing = await port.readRef(expectation.legacy.ref);
  const canonicalClosing = await port.readRef(expectation.canonical.ref);
  return assertQualificationReservationAuthorityReobservation(
    {
      source: expectation.source,
      canonical: {
        ref: expectation.canonical.ref,
        openingOid: canonicalOpening,
        closingOid: canonicalClosing,
      },
      legacy: {
        ref: expectation.legacy.ref,
        openingOid: legacyOpening,
        closingOid: legacyClosing,
      },
      reservationOid: expectation.reservationOid,
    },
    expectation,
  );
}

export function qualificationReservationReadPort(
  request,
  { deadline = Date.now() + 15_000, now = Date.now } = {},
) {
  assert.ok(Number.isSafeInteger(deadline), "invalid qualification read deadline");
  const get = async (route, parameters) => {
    const remaining = deadline - now();
    assert.ok(remaining > 0, "qualification reservation observation deadline exceeded");
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("qualification reservation observation deadline exceeded")),
        Math.max(1, Math.ceil(remaining)),
      );
    });
    let response;
    try {
      response = await Promise.race([
        request(route, { ...parameters, request: { signal } }),
        timeout,
      ]);
    } catch (error) {
      assert.ok(deadline - now() > 0, "qualification reservation observation deadline exceeded");
      throw error;
    } finally {
      clearTimeout(timer);
    }
    assert.ok(deadline - now() > 0, "qualification reservation observation deadline exceeded");
    assert.ok(response && typeof response === "object" && response.data);
    return response.data;
  };
  return {
    async readRef(ref) {
      assert.ok(
        /^refs\/clockgrove-factory\/(?:admission\/work-item-[1-9][0-9]*|attempts\/objective-[1-9][0-9]*\/work-item-[1-9][0-9]*\/attempt-[1-9][0-9]*)$/.test(
          ref,
        ),
        "invalid reservation authority ref",
      );
      let data;
      try {
        data = await get("GET /repos/{owner}/{repo}/git/ref/{ref}", { ref: ref.slice(5) });
      } catch (error) {
        if (error?.status === 404) return null;
        throw error;
      }
      assert.equal(data.ref, ref);
      assert.equal(data.object?.type, "commit");
      sha(data.object.sha);
      return data.object.sha;
    },
    async readCommit(oid) {
      sha(oid);
      const data = await get("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        commit_sha: oid,
      });
      assert.equal(data.sha, oid);
      sha(data.tree?.sha);
      assert.ok(Array.isArray(data.parents) && data.parents.length <= MAX_PARENTS);
      const parentOids = data.parents.map((parent) => {
        sha(parent?.sha);
        return parent.sha;
      });
      assert.ok(
        typeof data.message === "string" && Buffer.byteLength(data.message) <= MAX_LEDGER_BYTES,
        "qualification commit message exceeds bound",
      );
      return { oid, treeOid: data.tree.sha, parentOids, message: data.message };
    },
  };
}

/** One absolute deadline covers every GET in this observation. */
export function observeQualificationReservationAuthority(request, reserved, options) {
  return resolveQualificationReservationAuthority(
    qualificationReservationReadPort(request, options),
    reserved,
  );
}

export function reobserveQualificationReservationAuthority(request, proof, reserved, options) {
  return revalidateQualificationReservationAuthority(
    qualificationReservationReadPort(request, options),
    qualificationReservationAuthorityExpectation(proof, reserved),
  );
}
