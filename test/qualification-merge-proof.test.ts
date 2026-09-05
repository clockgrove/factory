import { describe, expect, it, vi } from "vitest";
import {
  assertQualificationMergeProof,
  observeQualificationMergeProofs,
  readQualificationMergeProof,
} from "../scripts/qualification-merge-proof.mjs";
import { readCheckpointMergeProof } from "../scripts/verify-local-checkpoint-restart.mjs";

function fixture() {
  const repository = "example/fixture";
  const publication = {
    event: "PublicationRecorded",
    runId: "run",
    objective: 1,
    workItem: 2,
    attempt: 1,
    pullRequest: 3,
    headSha: "a".repeat(40),
  };
  const integration = { ...publication, event: "AttemptIntegrated", headSha: "b".repeat(40) };
  const pull = {
    node_id: "PR_exact",
    number: 3,
    state: "closed",
    merged: true,
    head: { sha: publication.headSha },
    base: { repo: { full_name: repository, node_id: "R_exact" } },
  };
  const node = {
    __typename: "PullRequest",
    id: pull.node_id,
    number: 3,
    state: "MERGED",
    merged: true,
    headRefOid: publication.headSha,
    mergeCommit: { oid: integration.headSha },
    repository: { id: "R_exact", nameWithOwner: repository },
  };
  const request = vi.fn(async () => ({ data: { data: { node } } }));
  const evidence = {
    repository,
    runResult: { runId: "run" },
    status: { run: { runId: "run" } },
    children: [{ number: 2 }],
    pulls: [pull],
    events: [publication, integration, { ...publication, event: "AttemptPublished" }],
  };
  return { repository, publication, integration, pull, node, request, evidence };
}

describe("shared installed qualification merge proof", () => {
  it("checkpoint uses exactly the shared reader", () =>
    expect(readCheckpointMergeProof).toBe(readQualificationMergeProof));
  it("collects one exact proof without adding the removed field to raw REST evidence", async () => {
    const f = fixture();
    const before = structuredClone(f.evidence.pulls);
    const proofs = await observeQualificationMergeProofs({ request: f.request }, f.evidence);
    expect(proofs).toHaveLength(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.evidence.pulls).toEqual(before);
    expect(f.pull).not.toHaveProperty("merge_commit_sha");
    expect(() => assertQualificationMergeProof(proofs[0], f)).not.toThrow();
    expect(proofs[0]).toMatchObject({
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      repositoryNodeId: "R_exact",
    });
  });
  it.each([
    "runId",
    "objective",
    "workItem",
    "attempt",
    "pullRequest",
    "pullRequestNodeId",
    "repository",
    "repositoryNodeId",
    "headSha",
    "mergeSha",
  ])("rejects a substituted stored %s proof", async (field) => {
    const f = fixture();
    const proof = await readQualificationMergeProof({ request: f.request }, f);
    expect(() => assertQualificationMergeProof({ ...proof, [field]: "other" }, f)).toThrow(
      /merge commit proof/,
    );
  });
  it("rejects missing or duplicate PR identity before any GraphQL query", async () => {
    for (const duplicate of [false, true]) {
      const f = fixture();
      f.evidence.pulls = duplicate ? [f.pull, f.pull] : [];
      await expect(
        observeQualificationMergeProofs({ request: f.request }, f.evidence),
      ).rejects.toThrow(/REST PR/);
      expect(f.request).not.toHaveBeenCalled();
    }
  });
  it("does not turn an unknown GraphQL read into a raw REST fallback", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      observeQualificationMergeProofs({ request: f.request }, f.evidence),
    ).rejects.toThrow(/unavailable/);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
