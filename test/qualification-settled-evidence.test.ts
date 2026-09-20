import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertSettledQualificationMergeProof,
  observeSettledQualificationMergeProofs,
} from "../scripts/qualification-settled-merge-proof.mjs";

const sha = (value: string) => value.repeat(40);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture() {
  const common = { runId: "run", objective: 1, workItem: 2, attempt: 1 };
  const generation = (sequence: number, headSha: string, baseSha: string) => {
    const validation = {
      ...common,
      event: "ValidationRecorded",
      sequence,
      evidenceDigest: digest([sequence, "validation"]),
      baseSha,
      outputTreeSha: sha(String(sequence)),
      passed: true,
    };
    const published = {
      ...common,
      event: "AttemptPublished",
      sequence: sequence + 2,
      headSha,
      artifactDigest: digest([sequence, "artifact"]),
    };
    const publication = {
      ...common,
      event: "PublicationRecorded",
      sequence: sequence + 3,
      pullRequest: 7,
      branch: "factory/work-item-2",
      headSha,
      baseSha,
      validationDigest: validation.evidenceDigest,
      exactHeadValidationDigest: digest({
        protocol: "clockgrove.factory/exact-head-validation-v1",
        validationDigest: validation.evidenceDigest,
        baseSha,
        outputTreeSha: validation.outputTreeSha,
        publishedHeadSha: headSha,
      }),
    };
    return [
      validation,
      {
        ...common,
        event: "AttemptValidated",
        sequence: sequence + 1,
        artifactDigest: published.artifactDigest,
      },
      published,
      publication,
    ];
  };
  const old = generation(1, sha("a"), sha("0"));
  const current = generation(6, sha("b"), sha("1"));
  const integration = {
    ...common,
    event: "AttemptIntegrated",
    sequence: 10,
    headSha: sha("c"),
  };
  const pull = {
    number: 7,
    node_id: "pull-node",
    state: "closed",
    merged: true,
    head: { sha: sha("b"), ref: "factory/work-item-2", repo: { full_name: "example/repo" } },
    base: { repo: { full_name: "example/repo", node_id: "repo-node" } },
  };
  const request = vi.fn(async (route: string) => {
    expect(route).toBe("POST /graphql");
    return {
      data: {
        data: {
          node: {
            __typename: "PullRequest",
            id: "pull-node",
            number: 7,
            repository: { id: "repo-node", nameWithOwner: "example/repo" },
            headRefOid: sha("b"),
            merged: true,
            state: "MERGED",
            mergeCommit: { oid: sha("c") },
          },
        },
      },
    };
  });
  return {
    entry: {
      runResult: { runId: "run" },
      status: { run: { runId: "run" } },
      children: [{ number: 2 }],
      events: [...old, ...current, integration],
      pulls: [pull],
    },
    request,
    pull,
    integration,
    publication: current.at(-1)!,
  };
}

describe("settled qualification evidence", () => {
  it("selects the final publication generation without reading retired refs", async () => {
    const value = fixture();
    const proofs = await observeSettledQualificationMergeProofs({
      entry: value.entry,
      request: value.request,
      repository: "example/repo",
    });
    expect(value.request).toHaveBeenCalledTimes(1);
    expect(proofs).toEqual([
      expect.objectContaining({ sourceHeadSha: sha("b"), refreshCommitShas: [] }),
    ]);
    expect(() =>
      assertSettledQualificationMergeProof(proofs[0], {
        repository: "example/repo",
        pull: value.pull,
        publication: value.publication,
        integration: value.integration,
      }),
    ).not.toThrow();
  });

  it("rejects ambiguous final-generation receipts deterministically", async () => {
    const value = fixture();
    value.entry.events.push({ ...value.entry.events[4]! });
    await expect(
      observeSettledQualificationMergeProofs({
        entry: value.entry,
        request: value.request,
        repository: "example/repo",
      }),
    ).rejects.toThrow(/validation proof/);
  });
});
