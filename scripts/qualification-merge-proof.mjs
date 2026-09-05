/** Read-only exact merge evidence shared by installed qualification harnesses. */
import assert from "node:assert/strict";

function expectedProof({ repository, pull, publication, integration }) {
  assert.equal(publication.event, "PublicationRecorded");
  assert.equal(integration.event, "AttemptIntegrated");
  assert.ok(typeof publication.runId === "string" && publication.runId.length > 0);
  for (const field of ["runId", "objective", "workItem", "attempt"])
    assert.equal(
      integration[field],
      publication[field],
      "integration/publication identity mismatch",
    );
  for (const field of ["objective", "workItem", "attempt", "pullRequest"])
    assert.ok(Number.isSafeInteger(publication[field]) && publication[field] > 0);
  assert.equal(pull.number, publication.pullRequest);
  assert.ok(
    typeof pull.node_id === "string" && pull.node_id.length > 0 && pull.node_id.length <= 256,
  );
  assert.equal(pull.base.repo.full_name, repository);
  assert.ok(typeof pull.base.repo.node_id === "string" && pull.base.repo.node_id.length > 0);
  assert.equal(pull.merged, true);
  assert.equal(pull.state, "closed");
  assert.match(publication.headSha, /^[a-f0-9]{40}$/);
  assert.equal(
    pull.head.sha,
    publication.headSha,
    "merge commit proof belongs to another published head",
  );
  assert.match(integration.headSha, /^[a-f0-9]{40}$/);
  return {
    runId: publication.runId,
    objective: publication.objective,
    workItem: publication.workItem,
    attempt: publication.attempt,
    pullRequestNodeId: pull.node_id,
    pullRequest: pull.number,
    repository,
    repositoryNodeId: pull.base.repo.node_id,
    headSha: publication.headSha,
    mergeSha: integration.headSha,
  };
}

export function assertQualificationMergeProof(proof, input) {
  assert.deepEqual(
    proof,
    expectedProof(input),
    "integration receipt differs from exact GraphQL merge commit proof",
  );
}

export async function readQualificationMergeProof(hooks, input) {
  const expected = expectedProof(input);
  const response = await hooks.request("POST /graphql", {
    query: `query QualificationMergeProof($id: ID!) {
      node(id: $id) { __typename ... on PullRequest {
        id number repository { id nameWithOwner } headRefOid merged state mergeCommit { oid }
      } }
    }`,
    variables: { id: expected.pullRequestNodeId },
    request: { signal: AbortSignal.timeout(15000) },
  });
  assert.ok(
    response.data.errors === undefined ||
      (Array.isArray(response.data.errors) && response.data.errors.length === 0),
    "GraphQL merge proof unavailable",
  );
  const node = response.data.data?.node;
  assert.equal(node?.__typename, "PullRequest");
  assert.equal(node.id, expected.pullRequestNodeId);
  assert.equal(node.number, expected.pullRequest);
  assert.equal(node.repository.id, expected.repositoryNodeId);
  assert.equal(node.repository.nameWithOwner, expected.repository);
  assert.equal(node.headRefOid, expected.headSha);
  assert.equal(node.merged, true);
  assert.equal(node.state, "MERGED");
  assert.match(node.mergeCommit?.oid ?? "", /^[a-f0-9]{40}$/);
  assert.equal(
    node.mergeCommit.oid,
    expected.mergeSha,
    "actual merge differs from integration receipt",
  );
  return expected;
}

/** One query per integrated Work Item, preserving the unmodified REST payloads. */
export async function observeQualificationMergeProofs(hooks, evidence) {
  const runId = evidence.runResult.runId;
  assert.equal(evidence.status.run.runId, runId);
  assert.ok(Array.isArray(evidence.children) && evidence.children.length <= 100);
  const events = evidence.events.filter((event) => event.runId === runId);
  const proofs = [];
  const seen = new Set();
  for (const child of evidence.children) {
    assert.ok(!seen.has(child.number), "duplicate merge proof Work Item");
    seen.add(child.number);
    const integration = events.find(
      (event) => event.event === "AttemptIntegrated" && event.workItem === child.number,
    );
    assert.ok(integration, "integration identity missing");
    const published = events.find(
      (event) =>
        event.event === "AttemptPublished" &&
        event.workItem === child.number &&
        event.attempt === integration.attempt,
    );
    const publication = events.find(
      (event) =>
        event.event === "PublicationRecorded" &&
        event.workItem === child.number &&
        event.attempt === integration.attempt &&
        event.headSha === published?.headSha,
    );
    assert.ok(publication, "publication identity missing");
    const pulls = evidence.pulls.filter((pull) => pull.number === publication.pullRequest);
    assert.equal(pulls.length, 1, "exact REST PR identity missing or repeated");
    proofs.push(
      await readQualificationMergeProof(hooks, {
        repository: evidence.repository,
        pull: pulls[0],
        publication,
        integration,
      }),
    );
  }
  return proofs;
}
