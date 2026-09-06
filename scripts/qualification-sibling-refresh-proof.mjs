/** Independent, read-only proof of a sibling's advanced delivery head in either delivery mode. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";
import {
  readQualificationMergeProofForIdentity,
  selectQualificationPublicationRecord,
} from "./qualification-merge-proof.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const sha = (value) => assert.match(value, /^[a-f0-9]{40}$/);
const digest = (value) => assert.match(value, /^[a-f0-9]{64}$/);
const exactKeys = (value, fields) => assert.deepEqual(Object.keys(value).sort(), fields.sort());
const one = (values, message) => {
  assert.equal(values.length, 1, message);
  return values[0];
};
const sameAttempt = (left, right) =>
  ["runId", "objective", "workItem", "attempt"].every((key) => left[key] === right[key]);
const prefix = (kind, event) =>
  `refs/clockgrove-factory/${kind}/objective-${event.objective}/work-item-${event.workItem}/attempt-${event.attempt}/`;

export function nativeQualificationEvents(evidence) {
  assert.ok(Array.isArray(evidence.events) && evidence.events.length <= 50000);
  const runId = evidence.runResult.runId;
  assert.ok(Number.isSafeInteger(evidence.actor.id) && evidence.actor.id > 0);
  const locations = new Set([
    evidence.objective.number,
    ...evidence.children.map((child) => child.number),
  ]);
  return deduplicateQualificationReceipts(
    evidence.events
      .filter((event) => event.runId === runId)
      .map((raw) => {
        assert.equal(raw.authorId, evidence.actor.id, "foreign receipt actor");
        assert.equal(raw.author.toLowerCase(), evidence.actor.login.toLowerCase());
        const base = `https://github.com/${evidence.repository}/issues/`;
        assert.ok(raw.receiptUrl.startsWith(base), "foreign receipt location");
        const match = /^([1-9][0-9]*)#issuecomment-[1-9][0-9]*$/.exec(
          raw.receiptUrl.slice(base.length),
        );
        assert.ok(
          match && locations.has(Number(match[1])),
          "receipt outside observed Objective graph",
        );
        const event = { ...raw };
        delete event.author;
        delete event.authorId;
        delete event.receiptUrl;
        return { event };
      }),
  ).map(({ event }) => event);
}

function commit(value, oid) {
  sha(oid);
  assert.equal(value.oid, oid);
  sha(value.treeOid);
  assert.ok(Array.isArray(value.parentOids) && value.parentOids.length <= 2);
  value.parentOids.forEach(sha);
  assert.ok(typeof value.message === "string" && Buffer.byteLength(value.message) <= 131072);
  return value;
}
function checkpoint(value, request, target) {
  assert.equal(value.ref, request.ref);
  const head = commit(value.commit, value.commit.oid);
  assert.deepEqual(head.parentOids, [target], "checkpoint target parent differs");
  assert.equal(value.observedRefOid, head.oid, "checkpoint ref changed during observation");
  sha(value.blobOid);
  assert.ok(
    Array.isArray(value.treePaths) && value.treePaths.length === 3,
    "checkpoint path proof missing",
  );
  let treeOid = head.treeOid;
  const parts = request.path.split("/");
  for (const [index, path] of parts.entries()) {
    const tree = value.treePaths[index];
    assert.equal(tree.sha, treeOid, "checkpoint tree linkage differs");
    assert.ok(
      Array.isArray(tree.entries) && tree.entries.length > 0 && tree.entries.length <= 10000,
    );
    const seen = new Set();
    const entries = tree.entries
      .map((entry) => {
        assert.ok(
          typeof entry.path === "string" &&
            entry.path.length > 0 &&
            Buffer.byteLength(entry.path) <= 4096 &&
            !entry.path.includes("/") &&
            !entry.path.includes("\0") &&
            !seen.has(entry.path),
        );
        seen.add(entry.path);
        sha(entry.sha);
        assert.ok(["100644", "100755", "120000", "040000", "160000"].includes(entry.mode));
        assert.equal(
          entry.type,
          entry.mode === "040000" ? "tree" : entry.mode === "160000" ? "commit" : "blob",
        );
        return entry;
      })
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.path + (left.type === "tree" ? "/" : "")),
          Buffer.from(right.path + (right.type === "tree" ? "/" : "")),
        ),
      );
    const bytes = Buffer.concat(
      entries.flatMap((entry) => [
        Buffer.from(`${entry.mode.replace(/^0/, "")} ${entry.path}\0`),
        Buffer.from(entry.sha, "hex"),
      ]),
    );
    assert.ok(bytes.length <= 2 * 1024 * 1024);
    assert.equal(
      createHash("sha1")
        .update(Buffer.from(`tree ${bytes.length}\0`))
        .update(bytes)
        .digest("hex"),
      tree.sha,
      "checkpoint tree content differs from Git identity",
    );
    const entry = one(
      tree.entries.filter((entry) => entry.path === path),
      "checkpoint path missing or repeated",
    );
    assert.equal(entry.mode, index === parts.length - 1 ? "100644" : "040000");
    treeOid = entry.sha;
  }
  assert.equal(treeOid, value.blobOid, "checkpoint content is not at its bound tree path");
  assert.ok(
    typeof value.content === "string" && Buffer.byteLength(value.content) <= request.maxBytes,
  );
  const bytes = Buffer.from(value.content);
  assert.equal(
    createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex"),
    value.blobOid,
    "checkpoint blob content differs from Git identity",
  );
  return JSON.parse(value.content);
}
function* readCommit(oid) {
  return commit(yield { kind: "commit", oid }, oid);
}
function* readCheckpoint(ref, path, target, maxBytes = 65536) {
  const request = {
    kind: "checkpoint",
    ref,
    path: `.clockgrove-factory/control/${path}.json`,
    maxBytes,
  };
  const read = yield request;
  return { document: checkpoint(read, request, target), read };
}
function validationProof(value) {
  const fields = [
    "protocol",
    "artifactDigest",
    "baseSha",
    "outputTreeSha",
    "commands",
    "passed",
    "startedAt",
    "completedAt",
    ...(value.environmentIdentity === undefined ? [] : ["environmentIdentity"]),
    "digest",
  ];
  exactKeys(value, fields);
  assert.equal(value.protocol, "clockgrove.factory/validation-v1");
  digest(value.artifactDigest);
  sha(value.baseSha);
  sha(value.outputTreeSha);
  assert.equal(value.passed, true);
  assert.ok(
    Array.isArray(value.commands) && value.commands.length > 0 && value.commands.length <= 128,
  );
  for (const command of value.commands) {
    exactKeys(command, ["command", "exitCode", "durationMs"]);
    assert.ok(
      typeof command.command === "string" &&
        command.command.length > 0 &&
        command.command.length <= 1000,
    );
    assert.equal(command.exitCode, 0);
    assert.ok(Number.isSafeInteger(command.durationMs) && command.durationMs >= 0);
  }
  const duration = Date.parse(value.completedAt) - Date.parse(value.startedAt);
  assert.ok(Number.isSafeInteger(duration) && duration >= 0);
  const ordered = {
    protocol: value.protocol,
    artifactDigest: value.artifactDigest,
    baseSha: value.baseSha,
    outputTreeSha: value.outputTreeSha,
    commands: value.commands,
    passed: true,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    ...(value.environmentIdentity === undefined
      ? {}
      : { environmentIdentity: value.environmentIdentity }),
  };
  assert.equal(value.digest, hash(JSON.stringify(ordered)), "full validation digest differs");
  return duration;
}

/** Generator keeps collection and retained-evidence assessment on the same bounded read recipe. */
function* readPinnedPacket(evidence, events, publication, start) {
  const graphEvent = one(
    events.filter((event) => event.event === "GraphCompiled"),
    "fresh immutable graph receipt missing or repeated",
  );
  const graphRef = `refs/clockgrove-factory/graphs/objective-${publication.objective}/run-${hash(start.runId).slice(0, 32)}`;
  assert.equal(graphEvent.graphRef, graphRef);
  assert.equal(graphEvent.baseSha, evidence.base);
  const { document: graph, read: graphRead } = yield* readCheckpoint(
    graphRef,
    "compiled-objective",
    evidence.base,
    2 * 1024 * 1024,
  );
  assert.equal(graphRead.blobOid, graphEvent.graphBlobSha);
  assert.equal(hash(canonical(graph)), graphEvent.graphDigest, "compiled graph digest differs");
  assert.equal(graphRead.content, canonical(graph), "compiled graph bytes are not canonical");
  assert.ok(Array.isArray(graph.workItems) && graph.workItems.length === 3);
  const packet = one(
    graph.workItems.filter((item) => item.id === publication.itemId),
    "source publication does not bind a unique compiled Work Item",
  );
  assert.ok(
    Array.isArray(packet.validationCommands) &&
      packet.validationCommands.length > 0 &&
      packet.validationCommands.length <= 128,
  );
  const originals = events.filter((event) => event.event === "PublicationRecorded");
  const publications = [...new Set(originals.map((event) => event.workItem))].map((workItem) =>
    selectQualificationPublicationRecord(originals.filter((event) => event.workItem === workItem)),
  );
  assert.equal(publications.length, 3);
  for (const item of graph.workItems) {
    const itemPublication = one(
      publications.filter((event) => event.itemId === item.id),
      "graph publication binding is not bijective",
    );
    const dependencies = one(
      evidence.dependencies.filter((entry) => entry.workItem === itemPublication.workItem),
      "graph dependency observation missing",
    );
    assert.deepEqual(
      dependencies.blockedBy.map((entry) => entry.number).sort((a, b) => a - b),
      item.dependsOn
        .map(
          (id) =>
            one(
              publications.filter((event) => event.itemId === id),
              "compiled parent publication missing",
            ).workItem,
        )
        .sort((a, b) => a - b),
    );
  }
  return packet;
}

function* prove(evidence, input) {
  const { repository, pull } = input;
  const envelope = (raw) => {
    const value = { ...raw };
    delete value.author;
    delete value.authorId;
    delete value.receiptUrl;
    return value;
  };
  const publication = envelope(input.publication);
  const integration = envelope(input.integration);
  assert.equal(repository, evidence.repository);
  assert.equal(publication.event, "PublicationRecorded");
  assert.equal(integration.event, "AttemptIntegrated");
  assert.ok(sameAttempt(publication, integration));
  const events = nativeQualificationEvents(evidence);
  const start = one(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "fresh run start missing or repeated",
  );
  assert.equal(start.runId, publication.runId);
  assert.equal(start.activationRequestId, undefined);
  assert.equal(start.recoveryRequestId, undefined);
  assert.equal(start.policyDigest, hash(canonical(start.policy)));
  assert.ok(
    !events.some((event) => event.kind === "recovery"),
    "successor evidence is outside this fresh qualification",
  );
  const originalPublications = events.filter(
    (event) => event.event === "PublicationRecorded" && sameAttempt(event, publication),
  );
  selectQualificationPublicationRecord(originalPublications, publication);
  assert.deepEqual(
    one(
      events.filter(
        (event) => event.event === "AttemptIntegrated" && sameAttempt(event, integration),
      ),
      "integration missing or repeated",
    ),
    integration,
  );
  const reservation = one(
    events.filter((event) => event.event === "AttemptReserved" && sameAttempt(event, publication)),
    "source reservation missing or repeated",
  );
  const validation = one(
    events.filter(
      (event) =>
        event.event === "ValidationRecorded" &&
        sameAttempt(event, publication) &&
        event.evidenceDigest === publication.validationDigest,
    ),
    "source validation missing or repeated",
  );
  assert.equal(validation.passed, true);
  assert.equal(validation.baseSha, publication.baseSha);
  assert.equal(reservation.baseSha, publication.baseSha);
  assert.equal(reservation.policyDigest, start.policyDigest);
  assert.ok(
    reservation.sequence < validation.sequence &&
      validation.sequence < publication.sequence &&
      publication.sequence < integration.sequence,
  );
  const sourceCore = {
    protocol: "clockgrove.factory/exact-head-validation-v1",
    validationDigest: publication.validationDigest,
    baseSha: publication.baseSha,
    outputTreeSha: validation.outputTreeSha,
    publishedHeadSha: publication.headSha,
  };
  const source = { ...sourceCore, digest: hash(JSON.stringify(sourceCore)) };
  assert.equal(publication.exactHeadValidationDigest, source.digest);
  const selections = events.filter((event) => event.event === "DeliverySelected");
  assert.ok(selections.length <= 1, "ambiguous delivery selection");
  const selected = selections[0]?.selected ?? (start.policy.delivery.mode === "regular-prs" ? "regular-prs" : "native-stacks");
  assert.ok(["native-stacks", "regular-prs"].includes(selected));
  assert.equal(publication.mode, selected, "sibling proof escaped selected delivery mode");
  const branch = `factory/objective-${publication.objective}/work-item-${publication.workItem}/attempt-${publication.attempt}`;
  assert.equal(publication.branch, branch);
  assert.equal(
    publication.position,
    0,
    "fixture only qualifies independent native roots/join units",
  );
  assert.equal(publication.parentItemId, undefined);
  const published = one(
    events.filter(
      (event) =>
        event.event === "AttemptPublished" &&
        sameAttempt(event, publication) &&
        event.headSha === publication.headSha,
    ),
    "original artifact publication is missing or repeated",
  );
  digest(published.artifactDigest);
  const collected = one(
    events.filter((event) => event.event === "AttemptCollected" && sameAttempt(event, publication)),
    "actual collected artifact missing or repeated",
  );
  assert.equal(
    collected.artifactDigest,
    published.artifactDigest,
    "published artifact differs from actual collection",
  );
  assert.ok(
    collected.sequence < validation.sequence,
    "collection does not precede source validation",
  );
  const actualStart = one(
    events.filter((event) => event.event === "AttemptStarted" && sameAttempt(event, publication)),
    "actual source worker launch missing or repeated",
  );
  assert.equal(actualStart.backend, reservation.backend);
  assert.ok(
    reservation.sequence < actualStart.sequence && actualStart.sequence < collected.sequence,
    "source execution/collection chronology differs",
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "AttemptValidated" &&
        sameAttempt(event, publication) &&
        event.artifactDigest === published.artifactDigest &&
        event.sequence < publication.sequence,
    ),
    "original artifact acceptance is not bound",
  );
  const originalCapacity = one(
    events.filter(
      (event) =>
        event.event === "CapacityReserved" &&
        sameAttempt(event, publication) &&
        event.phase === "validation" &&
        event.backend === "factory/local-validation" &&
        event.localScopeBatch?.identity.invocationDigest === published.artifactDigest,
    ),
    "original validator artifact ownership is missing or repeated",
  );
  assert.ok(originalCapacity.sequence < validation.sequence);
  const packet = yield* readPinnedPacket(evidence, events, publication, start);
  assert.equal(
    originalCapacity.localScopeBatch.commandCount,
    packet.validationCommands.length + 1,
    "original validation scope coverage differs from pinned plan",
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "CapacityReconciled" &&
        sameAttempt(event, publication) &&
        event.phase === "validation" &&
        event.backend === originalCapacity.backend &&
        event.sequence > originalCapacity.sequence &&
        event.sequence < publication.sequence,
    ),
    "original validator release missing",
  );
  const originalReviewIdentity = {
    kind: "artifact",
    runId: start.runId,
    objective: publication.objective,
    workItem: publication.workItem,
    attempt: publication.attempt,
    artifactDigest: published.artifactDigest,
    baseSha: source.baseSha,
    outputTreeSha: source.outputTreeSha,
    evidenceDigest: source.validationDigest,
  };
  const originalReviewDigest = hash(canonical(originalReviewIdentity));
  const { document: originalReview } = yield* readCheckpoint(
    `${prefix("reviews", publication)}artifact-${originalReviewDigest}`,
    "semantic-review",
    source.baseSha,
  );
  exactKeys(originalReview, ["protocol", "identityDigest", "identity", "review", "usage"]);
  assert.equal(originalReview.protocol, "clockgrove.factory/review-checkpoint-v1");
  assert.deepEqual(originalReview.identity, originalReviewIdentity);
  assert.equal(originalReview.identityDigest, originalReviewDigest);
  assert.equal(originalReview.review.accepted, true);
  assert.deepEqual(originalReview.review.unmetCriteria, []);
  for (const key of ["inputTokens", "outputTokens"])
    assert.ok(Number.isSafeInteger(originalReview.usage[key]) && originalReview.usage[key] >= 0);
  const originalUsage = one(
    events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        sameAttempt(event, publication) &&
        event.phase === "management" &&
        event.unit === "model_tokens" &&
        event.usageId === `review-${originalReviewDigest}`,
    ),
    "original review accounting missing or repeated",
  );
  assert.equal(
    originalUsage.amount,
    originalReview.usage.inputTokens + originalReview.usage.outputTokens,
  );
  assert.ok(originalUsage.sequence < publication.sequence);
  assert.ok(
    events.some(
      (event) =>
        event.event === "StackLinked" &&
        sameAttempt(event, publication) &&
        [
          "unitId",
          "itemId",
          "branch",
          "baseBranch",
          "headSha",
          "baseSha",
          "pullRequest",
          "validationDigest",
          "exactHeadValidationDigest",
        ].every((key) => event[key] === publication[key]) &&
        Number.isSafeInteger(event.stackNumber) &&
        event.stackNumber > 0,
    ),
    "original native stack linkage is missing",
  );
  assert.equal(pull.number, publication.pullRequest);
  assert.equal(pull.head.ref, branch);
  assert.equal(pull.head.repo.full_name, repository);
  assert.equal(pull.base.repo.full_name, repository);
  assert.equal(pull.base.ref, evidence.nativeDefaultBranch ?? evidence.preflight?.defaultBranch);
  assert.equal(pull.state, "closed");
  assert.equal(pull.merged, true);
  const reservationRef = prefix("attempts", publication).slice(0, -1);
  const reservationOid = yield { kind: "ref", ref: reservationRef };
  const reservedCommit = yield* readCommit(reservationOid);
  const trailers = reservedCommit.message
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Factory-Event: "));
  assert.equal(trailers.length, 1);
  assert.deepEqual(
    JSON.parse(Buffer.from(trailers[0].slice(15), "base64url").toString("utf8")),
    reservation,
    "reservation Git proof differs from authenticated receipt",
  );
  const base = yield* readCommit(source.baseSha);
  assert.deepEqual(reservedCommit.parentOids, [source.baseSha]);
  assert.equal(reservedCommit.treeOid, base.treeOid);
  const original = yield* readCommit(source.publishedHeadSha);
  assert.deepEqual(original.parentOids, [source.baseSha]);
  assert.equal(original.treeOid, source.outputTreeSha);
  const final = yield* readCommit(pull.head.sha);
  const merged = yield* readCommit(integration.headSha);
  let deliveryTree = source.outputTreeSha;
  let target = source.baseSha;
  let current = final;
  let next;
  let refreshed = 0;
  let pinnedSourceDigest;
  const targetIntegrationSequences = [];
  while (current.oid !== source.publishedHeadSha) {
    assert.ok(++refreshed <= 100, "refresh lineage exceeds bound");
    assert.equal(current.parentOids.length, 2, "refreshed head requires exact ordered parents");
    // The planned commit names an immutable intent; its content must still prove the full identity.
    const trailers = [...current.message.matchAll(/^Factory-Sibling-Refresh: ([a-f0-9]{64})$/gm)];
    assert.equal(trailers.length, 1, "planned refresh intent trailer missing or repeated");
    const identityDigest = trailers[0][1];
    const ref = `${prefix("sibling-refreshes", publication)}refresh-${identityDigest}`;
    const { document: record, read } = yield* readCheckpoint(
      ref,
      "sibling-refresh",
      current.parentOids[1],
    );
    const pinned = one(
      originalPublications.filter(
        (event) => hash(canonical(event)) === record.identity.sourcePublicationDigest,
      ),
      "immutable intent source publication is not exact authenticated history",
    );
    selectQualificationPublicationRecord(originalPublications, pinned);
    if (pinnedSourceDigest !== undefined)
      assert.equal(
        record.identity.sourcePublicationDigest,
        pinnedSourceDigest,
        "refresh lineage changed its source receipt",
      );
    pinnedSourceDigest = record.identity.sourcePublicationDigest;
    assert.ok(pinned.sequence < integration.sequence, "source receipt postdates integration");
    const identity = {
      repository,
      runId: start.runId,
      sourceRunId: start.runId,
      controllingPolicyDigest: start.policyDigest,
      objective: publication.objective,
      workItem: publication.workItem,
      attempt: publication.attempt,
      pullRequest: publication.pullRequest,
      pullRequestNodeId: pull.node_id,
      branch,
      reservationRef,
      reservationOid,
      leaseEpoch: reservation.directorEpoch,
      policyDigest: reservation.policyDigest,
      sourcePublicationDigest: pinnedSourceDigest,
      sourceHeadSha: source.publishedHeadSha,
      sourceExactHeadValidationDigest: source.digest,
      targetBaseSha: current.parentOids[1],
    };
    assert.equal(
      identityDigest,
      hash(JSON.stringify(identity)),
      "planned commit intent identity differs",
    );
    exactKeys(record, [
      "protocol",
      "identity",
      "identityDigest",
      "source",
      "expectedOldHeadSha",
      "outputTreeSha",
      "plannedHeadSha",
      ...(record.previous ? ["previous"] : []),
    ]);
    assert.equal(record.protocol, "clockgrove.factory/sibling-refresh-v1");
    assert.deepEqual(record.identity, identity);
    assert.equal(record.identityDigest, identityDigest);
    assert.deepEqual(record.source, source);
    assert.deepEqual(current.parentOids, [record.expectedOldHeadSha, identity.targetBaseSha]);
    assert.equal(record.plannedHeadSha, current.oid);
    assert.equal(record.outputTreeSha, current.treeOid);
    assert.notEqual(identity.targetBaseSha, source.baseSha);
    assert.notEqual(record.expectedOldHeadSha, identity.targetBaseSha);
    if (next)
      assert.deepEqual(
        next,
        { ref, commitOid: read.commit.oid, identityDigest },
        "refresh predecessor binding differs",
      );
    if (refreshed === 1) {
      deliveryTree = record.outputTreeSha;
      target = identity.targetBaseSha;
    }
    // Every target advance must be an earlier, different Work Item's exact same-run squash.
    let ancestor = identity.targetBaseSha;
    const visited = new Set();
    while (ancestor !== source.baseSha) {
      assert.ok(
        visited.size < evidence.children.length && !visited.has(ancestor),
        "target ancestry is not bounded own-run integration",
      );
      visited.add(ancestor);
      const own = one(
        events.filter(
          (event) =>
            event.event === "AttemptIntegrated" &&
            event.headSha === ancestor &&
            event.workItem !== publication.workItem &&
            event.sequence < integration.sequence,
        ),
        "target lacks exact prior same-run integration",
      );
      assert.ok(evidence.children.some((child) => child.number === own.workItem));
      if (refreshed === 1) targetIntegrationSequences.push(own.sequence);
      const ancestorCommit = yield* readCommit(ancestor);
      assert.equal(ancestorCommit.parentOids.length, 1);
      ancestor = ancestorCommit.parentOids[0];
    }
    next = record.previous;
    if (record.expectedOldHeadSha === source.publishedHeadSha)
      assert.equal(next, undefined, "unexpected lineage before original source");
    else assert.ok(next, "missing earlier refresh checkpoint");
    current = yield* readCommit(record.expectedOldHeadSha);
  }
  if (refreshed > 0) {
    const identity = {
      runId: start.runId,
      objective: publication.objective,
      workItem: publication.workItem,
      attempt: publication.attempt,
      pullRequest: publication.pullRequest,
      sourceHeadSha: source.publishedHeadSha,
      sourceExactHeadValidationDigest: source.digest,
      targetBaseSha: target,
      deliveryHeadSha: final.oid,
    };
    const identityDigest = hash(JSON.stringify(identity));
    const ref = `${prefix("merge-candidates", publication)}candidate-${identityDigest}`;
    const { document: candidate } = yield* readCheckpoint(
      ref,
      "merge-candidate",
      target,
      512 * 1024,
    );
    exactKeys(candidate, [
      "protocol",
      "identityDigest",
      "identity",
      "source",
      "validation",
      "evidence",
    ]);
    assert.equal(candidate.protocol, "clockgrove.factory/merge-candidate-checkpoint-v1");
    assert.deepEqual(candidate.identity, identity);
    assert.equal(candidate.identityDigest, identityDigest);
    assert.deepEqual(candidate.source, source);
    const duration = validationProof(candidate.validation);
    const actualCommands = candidate.validation.commands.map((entry) => entry.command);
    if (actualCommands[0] === "npm ci --no-audit --no-fund") actualCommands.shift();
    assert.deepEqual(
      actualCommands,
      packet.validationCommands,
      "full pinned validation plan was not rerun",
    );
    assert.equal(candidate.validation.baseSha, target);
    assert.equal(candidate.validation.outputTreeSha, deliveryTree);
    const capacityBackend = `factory/integration-validation-${identityDigest}`;
    const capacity = one(
      events.filter(
        (event) =>
          event.event === "CapacityReserved" &&
          sameAttempt(event, publication) &&
          event.phase === "validation" &&
          event.backend === capacityBackend,
      ),
      "candidate validator ownership unavailable or repeated",
    );
    const released = one(
      events.filter(
        (event) =>
          event.event === "CapacityReconciled" &&
          sameAttempt(event, publication) &&
          event.phase === "validation" &&
          event.backend === capacityBackend,
      ),
      "candidate validator release unavailable or repeated",
    );
    assert.ok(
      capacity.sequence > publication.sequence &&
        released.sequence > capacity.sequence &&
        released.sequence < integration.sequence,
    );
    assert.ok(
      originalPublications.find((event) => hash(canonical(event)) === pinnedSourceDigest).sequence <
        capacity.sequence,
      "candidate predates its pinned publication receipt",
    );
    assert.ok(capacity.localScopeBatch, "candidate validator exact scope batch unavailable");
    assert.ok(
      targetIntegrationSequences.every((sequence) => sequence < capacity.sequence),
      "candidate was admitted before its target integration authority",
    );
    assert.equal(
      capacity.localScopeBatch.identity.invocationDigest,
      candidate.validation.artifactDigest,
      "candidate validator belongs to another artifact",
    );
    assert.ok(
      capacity.localScopeBatch.commandCount === packet.validationCommands.length + 1,
      "candidate validation scope coverage differs",
    );
    const bound = {
      protocol: "clockgrove.factory/merge-candidate-validation-v1",
      sourceExactHeadValidationDigest: source.digest,
      sourceBaseSha: source.baseSha,
      sourceHeadSha: source.publishedHeadSha,
      sourceTreeSha: source.outputTreeSha,
      targetBaseSha: target,
      candidateOutputTreeSha: deliveryTree,
      candidateArtifactDigest: candidate.validation.artifactDigest,
      candidateValidationDigest: candidate.validation.digest,
    };
    assert.deepEqual(candidate.evidence, { ...bound, digest: hash(JSON.stringify(bound)) });
    const reviewIdentity = {
      kind: "integration-candidate",
      runId: start.runId,
      objective: publication.objective,
      workItem: publication.workItem,
      attempt: publication.attempt,
      artifactDigest: candidate.validation.artifactDigest,
      baseSha: target,
      outputTreeSha: deliveryTree,
      evidenceDigest: candidate.validation.digest,
      headSha: final.oid,
    };
    const reviewDigest = hash(canonical(reviewIdentity));
    const { document: review } = yield* readCheckpoint(
      `${prefix("reviews", publication)}integration-candidate-${reviewDigest}`,
      "semantic-review",
      target,
    );
    exactKeys(review, ["protocol", "identityDigest", "identity", "review", "usage"]);
    assert.equal(review.protocol, "clockgrove.factory/review-checkpoint-v1");
    assert.deepEqual(review.identity, reviewIdentity);
    assert.equal(review.identityDigest, reviewDigest);
    assert.equal(review.review.accepted, true);
    assert.deepEqual(review.review.unmetCriteria, []);
    for (const name of ["inputTokens", "outputTokens"])
      assert.ok(Number.isSafeInteger(review.usage[name]) && review.usage[name] >= 0);
    if (review.usage.cachedInputTokens !== undefined)
      assert.ok(
        Number.isSafeInteger(review.usage.cachedInputTokens) &&
          review.usage.cachedInputTokens >= 0 &&
          review.usage.cachedInputTokens <= review.usage.inputTokens,
      );
    for (const [usageId, unit, phase, amount] of [
      [
        `integration-validation-${identityDigest}`,
        "validation_milliseconds",
        "validation",
        duration,
      ],
      [
        `integration-review-${reviewDigest}`,
        "model_tokens",
        "management",
        review.usage.inputTokens + review.usage.outputTokens,
      ],
    ]) {
      const receipt = one(
        events.filter(
          (event) =>
            event.event === "BudgetReconciled" &&
            sameAttempt(event, publication) &&
            event.usageId === usageId &&
            event.phase === phase &&
            event.unit === unit,
        ),
        "refresh accounting unavailable or repeated",
      );
      assert.equal(receipt.amount, amount);
      assert.ok(receipt.sequence < integration.sequence);
    }
  }
  assert.deepEqual(
    merged.parentOids,
    [target],
    "actual squash parent differs from validated target",
  );
  assert.equal(
    merged.treeOid,
    deliveryTree,
    "actual squash differs from independently validated tree",
  );
  return {
    expected: {
      runId: publication.runId,
      objective: publication.objective,
      workItem: publication.workItem,
      attempt: publication.attempt,
      pullRequestNodeId: pull.node_id,
      pullRequest: pull.number,
      repository,
      repositoryNodeId: pull.base.repo.node_id,
      headSha: final.oid,
      mergeSha: merged.oid,
    },
    refreshed,
  };
}

function proofInput(evidence, child) {
  const events = nativeQualificationEvents(evidence);
  const integration = one(
    events.filter(
      (event) => event.event === "AttemptIntegrated" && event.workItem === child.number,
    ),
    "integration coverage differs",
  );
  const publication = selectQualificationPublicationRecord(
    events.filter(
      (event) => event.event === "PublicationRecorded" && sameAttempt(event, integration),
    ),
  );
  const pull = one(
    evidence.pulls.filter((pull) => pull.number === publication.pullRequest),
    "exact PR coverage differs",
  );
  return { repository: evidence.repository, pull, publication, integration };
}

/** No mutation route is exposed; refs are reread after their bounded immutable content. */
export function nativeProofReader(request) {
  const get = async (route, parameters) =>
    (await request(route, { ...parameters, request: { signal: AbortSignal.timeout(15000) } })).data;
  const readCommit = async (oid) => {
    sha(oid);
    const data = await get("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      commit_sha: oid,
    });
    return commit(
      {
        oid: data.sha,
        treeOid: data.tree.sha,
        parentOids: data.parents.map((parent) => parent.sha),
        message: data.message,
      },
      oid,
    );
  };
  const readRef = async (ref) => {
    assert.ok(
      /^refs\/clockgrove-factory\/[a-z-]+\/objective-[1-9][0-9]*\/work-item-[1-9][0-9]*\/attempt-[1-9][0-9]*(?:\/[a-z-]+[a-f0-9]{64})?$/.test(
        ref,
      ) || /^refs\/clockgrove-factory\/graphs\/objective-[1-9][0-9]*\/run-[a-f0-9]{32}$/.test(ref),
    );
    const data = await get("GET /repos/{owner}/{repo}/git/ref/{ref}", { ref: ref.slice(5) });
    assert.equal(data.ref, ref);
    assert.equal(data.object.type, "commit");
    sha(data.object.sha);
    return data.object.sha;
  };
  return async (demand) => {
    if (demand.kind === "commit") return readCommit(demand.oid);
    if (demand.kind === "ref") return readRef(demand.ref);
    assert.equal(demand.kind, "checkpoint");
    assert.ok(
      ["sibling-refresh", "merge-candidate", "semantic-review", "compiled-objective"].some(
        (name) => demand.path === `.clockgrove-factory/control/${name}.json`,
      ),
    );
    const head = await readCommit(await readRef(demand.ref));
    let tree = head.treeOid;
    const parts = demand.path.split("/");
    let blob;
    const treePaths = [];
    for (const [index, path] of parts.entries()) {
      const data = await get("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { tree_sha: tree });
      assert.equal(data.sha, tree);
      assert.equal(data.truncated, false);
      assert.ok(Array.isArray(data.tree) && data.tree.length <= 10000);
      treePaths.push({
        sha: data.sha,
        entries: data.tree.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
      });
      const entry = one(
        data.tree.filter((entry) => entry.path === path),
        "checkpoint path missing or repeated",
      );
      sha(entry.sha);
      assert.equal(entry.type, index === parts.length - 1 ? "blob" : "tree");
      assert.equal(entry.mode, index === parts.length - 1 ? "100644" : "040000");
      tree = entry.sha;
      blob = entry.sha;
    }
    const data = await get("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { file_sha: blob });
    assert.equal(data.sha, blob);
    assert.equal(data.encoding, "base64");
    assert.ok(Number.isSafeInteger(data.size) && data.size > 0 && data.size <= demand.maxBytes);
    assert.ok(typeof data.content === "string" && data.content.length <= demand.maxBytes * 2);
    const bytes = Buffer.from(data.content, "base64");
    assert.equal(bytes.length, data.size);
    const value = {
      ref: demand.ref,
      commit: head,
      blobOid: blob,
      content: bytes.toString("utf8"),
      observedRefOid: await readRef(demand.ref),
      treePaths,
    };
    checkpoint(value, demand, head.parentOids[0]);
    return value;
  };
}

export async function observeNativeMergeProofs(
  { evidence, request },
  read = nativeProofReader(request),
) {
  assert.ok(Array.isArray(evidence.children) && evidence.children.length === 3);
  evidence.nativeMergeEvidence = [];
  const proofs = [];
  for (const child of evidence.children) {
    const input = proofInput(evidence, child);
    const recipe = prove(evidence, input);
    const reads = [];
    let step = recipe.next();
    while (!step.done) {
      assert.ok(reads.length < 2000, "native evidence read bound exceeded");
      const value = await read(step.value);
      reads.push({ request: step.value, value });
      step = recipe.next(value);
    }
    // The changed expected head is authorized by the independent proof above, never a relabelled publication.
    const proof = await readQualificationMergeProofForIdentity({ request }, step.value.expected);
    evidence.nativeMergeEvidence.push({
      workItem: child.number,
      attempt: input.integration.attempt,
      reads,
      refreshed: step.value.refreshed,
    });
    proofs.push(proof);
  }
  return proofs;
}

export function assertNativeMergeProof(evidence, proof, input) {
  assert.ok(
    Array.isArray(evidence.nativeMergeEvidence) &&
      evidence.nativeMergeEvidence.length === evidence.children.length,
  );
  const record = one(
    evidence.nativeMergeEvidence.filter(
      (record) =>
        record.workItem === input.integration.workItem &&
        record.attempt === input.integration.attempt,
    ),
    "native proof coverage differs",
  );
  assert.ok(Array.isArray(record.reads) && record.reads.length < 2000);
  const recipe = prove(evidence, input);
  let step = recipe.next();
  let index = 0;
  while (!step.done) {
    const read = record.reads[index++];
    assert.ok(read, "native immutable read missing");
    assert.deepEqual(read.request, step.value, "native read identity differs");
    step = recipe.next(read.value);
  }
  assert.equal(index, record.reads.length, "extra unbound native reads");
  assert.equal(record.refreshed, step.value.refreshed);
  assert.deepEqual(
    proof,
    step.value.expected,
    "exact GraphQL proof differs from native delivery evidence",
  );
}
