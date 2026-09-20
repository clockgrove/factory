/** Durable terminal delivery proof. Disposable review refs are already retired. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assertQualificationMergeProof,
  readQualificationMergeProofForIdentity,
} from "./qualification-merge-proof.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
const one = (values, reason) => {
  assert.equal(values.length, 1, reason);
  return values[0];
};
const sameAttempt = (a, b) =>
  ["objective", "runId", "workItem", "attempt"].every((key) => a[key] === b[key]);
const latestPublication = (events, integration) => {
  const publications = events
    .filter((event) => event.event === "PublicationRecorded" && sameAttempt(event, integration))
    .sort((left, right) => left.sequence - right.sequence);
  assert.ok(publications.length > 0 && publications.length <= 100, "publication proof missing");
  assert.equal(
    new Set(publications.map((event) => event.sequence)).size,
    publications.length,
    "publication generations repeat a sequence",
  );
  return publications.at(-1);
};

/** Terminal Factory cleanup retires disposable review refs; merged PRs and receipts stay durable. */
export async function observeSettledQualificationMergeProofs({ entry, request, repository }) {
  const runId = entry.runResult.runId;
  assert.equal(entry.status.run.runId, runId);
  assert.ok(Array.isArray(entry.children) && entry.children.length <= 100);
  const events = entry.events.filter((event) => event.runId === runId);
  const proofs = [];
  const seen = new Set();
  for (const child of entry.children) {
    assert.ok(!seen.has(child.number), "duplicate merge proof Work Item");
    seen.add(child.number);
    const integration = one(
      events.filter(
        (event) => event.event === "AttemptIntegrated" && event.workItem === child.number,
      ),
      "integration missing",
    );
    const publication = latestPublication(events, integration);
    const published = one(
      events.filter(
        (event) =>
          event.event === "AttemptPublished" &&
          sameAttempt(event, integration) &&
          event.headSha === publication.headSha,
      ),
      "published source head missing",
    );
    const validation = one(
      events.filter(
        (event) =>
          event.event === "ValidationRecorded" &&
          sameAttempt(event, integration) &&
          event.evidenceDigest === publication.validationDigest &&
          event.baseSha === publication.baseSha &&
          event.sequence < publication.sequence,
      ),
      "validation proof missing",
    );
    const validated = one(
      events.filter(
        (event) =>
          event.event === "AttemptValidated" &&
          sameAttempt(event, integration) &&
          event.sequence > validation.sequence &&
          event.sequence < published.sequence,
      ),
      "semantic review proof missing",
    );
    assert.equal(validated.artifactDigest, published.artifactDigest);
    assert.ok(
      !events.some(
        (event) =>
          event.event === "AttemptValidated" &&
          sameAttempt(event, integration) &&
          event.sequence > published.sequence,
      ),
      "semantic review advanced after the final publication",
    );
    assert.equal(validation.passed, true);
    assert.equal(validation.baseSha, publication.baseSha);
    assert.match(validation.outputTreeSha, /^[a-f0-9]{40}$/);
    assert.match(published.artifactDigest, /^[a-f0-9]{64}$/);
    assert.equal(validated.artifactDigest, published.artifactDigest);
    assert.match(publication.validationDigest, /^[a-f0-9]{64}$/);
    assert.match(publication.exactHeadValidationDigest, /^[a-f0-9]{64}$/);
    assert.equal(publication.validationDigest, validation.evidenceDigest);
    const sourceValidation = {
      protocol: "clockgrove.factory/exact-head-validation-v1",
      validationDigest: publication.validationDigest,
      baseSha: publication.baseSha,
      outputTreeSha: validation.outputTreeSha,
      publishedHeadSha: publication.headSha,
    };
    assert.equal(publication.exactHeadValidationDigest, hash(sourceValidation));
    assert.ok(
      validation.sequence < validated.sequence &&
        validated.sequence < published.sequence &&
        published.sequence < publication.sequence &&
        publication.sequence < integration.sequence,
      "validation/publication/integration chronology differs",
    );
    const pull = one(
      entry.pulls.filter((candidate) => candidate.number === publication.pullRequest),
      "pull missing",
    );
    assert.equal(pull.state, "closed");
    assert.equal(pull.merged, true);
    assert.equal(pull.base.repo.full_name, repository);
    assert.equal(pull.head.repo.full_name, repository);
    assert.equal(pull.head.ref, publication.branch);
    assert.match(publication.headSha, /^[a-f0-9]{40}$/);
    assert.match(pull.head.sha, /^[a-f0-9]{40}$/);
    assert.match(integration.headSha, /^[a-f0-9]{40}$/);
    const refreshCommitShas = [];
    let cursor = pull.head.sha;
    while (cursor !== publication.headSha) {
      assert.ok(refreshCommitShas.length < 100, "refresh lineage exceeds bound");
      const commit = (
        await request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
          commit_sha: cursor,
        })
      ).data;
      assert.equal(commit.sha, cursor);
      assert.ok(typeof commit.message === "string" && Buffer.byteLength(commit.message) <= 131072);
      const trailers = [...commit.message.matchAll(/^Factory-Sibling-Refresh: ([a-f0-9]{64})$/gm)];
      assert.equal(trailers.length, 1, "refresh intent trailer missing or repeated");
      assert.ok(Array.isArray(commit.parents) && commit.parents.length === 2);
      for (const parent of commit.parents) assert.match(parent.sha, /^[a-f0-9]{40}$/);
      refreshCommitShas.push(cursor);
      cursor = commit.parents[0].sha;
    }
    const expected = {
      runId: publication.runId,
      objective: publication.objective,
      workItem: publication.workItem,
      attempt: publication.attempt,
      pullRequestNodeId: pull.node_id,
      pullRequest: pull.number,
      repository,
      repositoryNodeId: pull.base.repo.node_id,
      headSha: pull.head.sha,
      mergeSha: integration.headSha,
    };
    const proof = await readQualificationMergeProofForIdentity({ request }, expected);
    proofs.push({ ...proof, sourceHeadSha: publication.headSha, refreshCommitShas });
  }
  return proofs;
}

/** Recheck retained terminal evidence without requiring any disposable review ref. */
export function assertSettledQualificationMergeProof(proof, input) {
  const { sourceHeadSha, refreshCommitShas, ...mergeProof } = proof;
  assert.match(sourceHeadSha, /^[a-f0-9]{40}$/);
  assert.equal(sourceHeadSha, input.publication.headSha, "settled source publication differs");
  assert.ok(
    Array.isArray(refreshCommitShas) && refreshCommitShas.length <= 100,
    "unbounded or missing refresh lineage",
  );
  assert.equal(
    new Set(refreshCommitShas).size,
    refreshCommitShas.length,
    "duplicate refresh commit identity",
  );
  for (const sha of refreshCommitShas) assert.match(sha, /^[a-f0-9]{40}$/);
  if (mergeProof.headSha === sourceHeadSha) assert.deepEqual(refreshCommitShas, []);
  else {
    assert.equal(refreshCommitShas[0], mergeProof.headSha, "refresh lineage lacks delivery head");
    assert.ok(!refreshCommitShas.includes(sourceHeadSha), "refresh lineage repeats source head");
  }
  assertQualificationMergeProof(mergeProof, {
    ...input,
    publication: { ...input.publication, headSha: mergeProof.headSha },
  });
}
