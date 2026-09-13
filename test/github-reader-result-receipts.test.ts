import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { gitBlobOid } from "../src/control/graphs.js";
import { encodeEventComment, encodeEventTrailer } from "../src/control/receipts.js";
import {
  encodeResultReceiptComment,
  RESULT_RECORD_PROTOCOL,
  resultEventsDigest,
  type ResultReceiptObservation,
} from "../src/control/result-receipts.js";
import { validationIdentityDigest } from "../src/control/validation-checkpoints.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { createValidationEvidence } from "../src/validation/evidence.js";

afterEach(() => vi.restoreAllMocks());
it.each([false, true])(
  "publishes only completed authenticated snapshot observations, valid=%s",
  async (valid) => {
    const baseSha = "a".repeat(40),
      commitOid = "b".repeat(40),
      treeOid = "c".repeat(40),
      leaseOid = "d".repeat(40);
    const at = "2026-09-13T00:00:00.000Z";
    const policy = policyDigest(DEFAULT_RUN_POLICY);
    const writer = {
      writerEpoch: 1,
      writerHolder: "holder",
      writerOperationId: "operation",
      writerPolicyDigest: policy,
    };
    const identity = {
      objective: 7,
      workItem: 8,
      runId: "reader-result",
      attempt: 1,
      artifactDigest: "e".repeat(64),
      baseSha,
      directorEpoch: 1,
      policyDigest: policy,
    };
    const evidence = createValidationEvidence({
      protocol: "clockgrove.factory/validation-v1",
      artifactDigest: identity.artifactDigest,
      baseSha,
      outputTreeSha: treeOid,
      commands: [],
      passed: valid,
      ...(valid ? {} : { failureReason: "failed" }),
      startedAt: at,
      completedAt: at,
      environmentIdentity: "independent",
    });
    const digest = validationIdentityDigest(identity);
    const bytes = Buffer.from(
      JSON.stringify({
        protocol: "clockgrove.factory/validation-checkpoint-v1",
        identityDigest: digest,
        identity,
        writerEpoch: 1,
        evidence,
      }),
    );
    const blobOid = gitBlobOid(bytes);
    const validation = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "validation",
      event: "ValidationRecorded",
      objective: 7,
      workItem: 8,
      runId: identity.runId,
      sequence: 3,
      at,
      ...writer,
      attempt: 1,
      baseSha,
      outputTreeSha: treeOid,
      passed: true,
      evidenceDigest: evidence.digest,
    });
    const body = encodeResultReceiptComment(
      "Validation",
      {
        protocol: RESULT_RECORD_PROTOCOL,
        kind: "validation",
        objective: 7,
        workItem: 8,
        runId: identity.runId,
        identityDigest: digest,
        baseSha,
        sequence: 3,
        at,
        ...writer,
        eventsDigest: resultEventsDigest([validation]),
        content: {
          kind: "git",
          ref: "refs/clockgrove-factory/results/validation/test",
          commitOid,
          blobOid,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
      [validation],
    );
    const start = encodeEventComment(
      "Start",
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunStarted",
        objective: 7,
        runId: identity.runId,
        sequence: 1,
        at,
        actor: "operator",
        repository: "o/r",
        objectiveAuthor: "operator",
        fork: false,
        baseBranch: "main",
        policy: DEFAULT_RUN_POLICY,
        policyDigest: policy,
        recordProtocol: RESULT_RECORD_PROTOCOL,
      }),
    );
    const comment = (body: string) => ({
      fullDatabaseId: "4294967297",
      body,
      author: { login: "operator" },
      authorAssociation: "OWNER",
    });
    const detail = {
      rateLimit: { cost: 4, limit: 5000, remaining: 4900, resetAt: "2026-09-13T01:00:00.000Z" },
      repository: {
        id: "repo",
        defaultBranchRef: { name: "main" },
        workItemLabel: { id: "label" },
        suggestedActors: { nodes: [] },
        issue: {
          id: "issue-7",
          number: 7,
          title: "Objective",
          body: "Objective",
          state: "OPEN",
          author: { login: "operator" },
          authorAssociation: "OWNER",
          comments: { totalCount: 1, nodes: [comment(start)] },
          subIssues: {
            totalCount: 1,
            nodes: [
              {
                id: "issue-8",
                number: 8,
                title: "Work",
                body: "Work",
                state: "OPEN",
                comments: { totalCount: 1, nodes: [comment(body)] },
                assignees: { nodes: [] },
                labels: { nodes: [{ name: "factory:work-item" }] },
                issueFieldValues: { totalCount: 0, nodes: [] },
                blockedBy: { totalCount: 0, nodes: [] },
                closedByPullRequestsReferences: { nodes: [] },
                timelineItems: { nodes: [] },
              },
            ],
          },
        },
      },
    };
    vi.spyOn(GitHubControlStore.prototype, "readRef").mockResolvedValue(commitOid);
    vi.spyOn(GitHubControlStore.prototype, "readCommit").mockResolvedValue({
      oid: commitOid,
      treeOid,
      parentOids: [baseSha],
      message: "result",
      serverTime: new Date(at),
    });
    vi.spyOn(GitHubControlStore.prototype, "readCommitContent").mockResolvedValue({
      oid: commitOid,
      treeOid,
      parentOids: [baseSha],
      message: "result",
    });
    vi.spyOn(GitHubControlStore.prototype, "readTreeEntry").mockResolvedValue(blobOid);
    const readBlob = vi.spyOn(GitHubControlStore.prototype, "readBlob").mockResolvedValue(bytes);
    const observations: ResultReceiptObservation[] = [];
    const reader = new GitHubReader({
      onResultReceiptObservation: (observation) => observations.push(observation),
      token: "reader-result-fixture",
      owner: "o",
      repo: "r",
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const headers = { date: "Sun, 13 Sep 2026 00:00:00 GMT" };
        if (url.pathname.includes("/git/ref/"))
          return Response.json({ object: { sha: leaseOid } }, { headers });
        if (url.pathname.includes("/git/commits/"))
          return Response.json(
            {
              sha: leaseOid,
              tree: { sha: treeOid },
              parents: [],
              message: encodeEventTrailer(
                parseFactoryEvent({
                  protocol: "clockgrove.factory/v2",
                  kind: "lease",
                  event: "LeaseAcquired",
                  objective: 7,
                  runId: identity.runId,
                  holder: "holder",
                  epoch: 1,
                  sequence: 1,
                  at,
                  expiresAt: "2026-09-13T00:10:00.000Z",
                  policyDigest: policy,
                }),
              ),
            },
            { headers },
          );
        if (url.pathname.endsWith("/actions/runs"))
          return Response.json({ total_count: 0 }, { headers });
        if (url.pathname === "/graphql") {
          const payload = (await request.json()) as { query: string };
          return Response.json(
            {
              data: payload.query.includes("ObjectiveCardinality")
                ? {
                    repository: {
                      owner: { __typename: "Organization" },
                      issue: { subIssues: { totalCount: 1 } },
                    },
                  }
                : detail,
            },
            { headers },
          );
        }
        throw new Error(`unexpected fixture transport ${url.pathname}`);
      },
    });
    if (!valid) {
      await expect(reader.readObjective(7)).rejects.toThrow("validation result projection differs");
      expect(observations).toEqual([]);
    } else {
      await reader.readObjective(7);
      expect(observations).toHaveLength(1);
      expect(observations[0]!.receipts).toHaveLength(1);
      expect(observations[0]!.receipts[0]!.commentId).toBe("4294967297");
      detail.repository.issue.subIssues.nodes[0]!.comments = { totalCount: 0, nodes: [] };
      await reader.readObjective(7);
      expect(observations.at(-1)).toEqual({ generation: 2, objective: 7, receipts: [] });
    }
    expect(readBlob).toHaveBeenCalledOnce();
  },
);
