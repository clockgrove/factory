import { describe, expect, it } from "vitest";

import { encodeEventComment } from "../src/control/receipts.js";
import { deriveV2State } from "../src/control/v2-state.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const POLICY_DIGEST = policyDigest(DEFAULT_RUN_POLICY);
const ACTOR = "operator";

function trustedComment(
  summary: string,
  event: ReturnType<typeof parseFactoryEvent>,
) {
  return {
    body: encodeEventComment(summary, event),
    author: { login: ACTOR },
    authorAssociation: "OWNER",
  };
}

function runStarted(runId: string, sequence: number, at: string) {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunStarted",
    objective: 14,
    runId,
    sequence,
    at,
    actor: ACTOR,
    repository: "clockgrove/factory",
    objectiveAuthor: ACTOR,
    fork: false,
    baseBranch: "main",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: POLICY_DIGEST,
  });
}

describe("GitHubReader Work Item history", () => {
  it("preserves a completed Work Item when a later Objective run is active", async () => {
    const priorRun = "prior-run";
    const activeRun = "active-run";
    const objectiveEvents = [
      runStarted(priorRun, 1, "2026-09-03T00:00:00.000Z"),
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunCompleted",
        objective: 14,
        runId: priorRun,
        sequence: 2,
        at: "2026-09-03T00:10:00.000Z",
      }),
      runStarted(activeRun, 3, "2026-09-03T01:00:00.000Z"),
    ];
    const workItemEvents = [
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "attempt",
        event: "AttemptPublished",
        objective: 14,
        workItem: 22,
        attempt: 23,
        runId: priorRun,
        sequence: 20,
        at: "2026-09-03T00:05:00.000Z",
        backend: "codex-cli/local-worktree",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        directorEpoch: 1,
        policyDigest: POLICY_DIGEST,
      }),
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "attempt",
        event: "AttemptIntegrated",
        objective: 14,
        workItem: 22,
        attempt: 23,
        runId: priorRun,
        sequence: 21,
        at: "2026-09-03T00:09:00.000Z",
        backend: "codex-cli/local-worktree",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        directorEpoch: 1,
        policyDigest: POLICY_DIGEST,
      }),
    ];
    const detail = {
      rateLimit: {
        cost: 4,
        limit: 5_000,
        remaining: 4_900,
        resetAt: "2026-09-03T02:00:00.000Z",
      },
      repository: {
        id: "R_1",
        defaultBranchRef: { name: "main" },
        workItemLabel: { id: "L_1" },
        suggestedActors: { nodes: [] },
        issue: {
          id: "I_14",
          number: 14,
          title: "Build Factory vNext",
          body: "Objective",
          state: "OPEN",
          author: { login: ACTOR },
          authorAssociation: "OWNER",
          comments: {
            totalCount: objectiveEvents.length,
            nodes: objectiveEvents.map((event) =>
              trustedComment("run event", event),
            ),
          },
          subIssues: {
            totalCount: 1,
            nodes: [
              {
                id: "I_22",
                number: 22,
                title: "Completed work",
                body: "Work Item",
                state: "CLOSED",
                comments: {
                  totalCount: workItemEvents.length,
                  nodes: workItemEvents.map((event) =>
                    trustedComment("attempt event", event),
                  ),
                },
                assignees: { nodes: [] },
                labels: { nodes: [{ name: "factory:work-item" }] },
                blockedBy: { totalCount: 0, nodes: [] },
                closedByPullRequestsReferences: {
                  nodes: [
                    {
                      id: "PR_39",
                      number: 39,
                      state: "MERGED",
                      isDraft: false,
                      title: "Complete work",
                      body: "Closes #22",
                      mergeable: "MERGEABLE",
                      createdAt: "2026-09-03T00:06:00.000Z",
                      mergedAt: "2026-09-03T00:08:00.000Z",
                      closedAt: "2026-09-03T00:08:00.000Z",
                      additions: 1,
                      deletions: 0,
                      changedFiles: 1,
                      files: { nodes: [{ path: "src/example.ts" }] },
                      commits: {
                        nodes: [
                          { commit: { messageHeadline: "Complete work" } },
                        ],
                      },
                      statusCheckRollup: {
                        nodes: [
                          {
                            commit: {
                              oid: HEAD_SHA,
                              committedDate: "2026-09-03T00:07:00.000Z",
                              statusCheckRollup: { state: "SUCCESS" },
                              checkSuites: { nodes: [] },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                timelineItems: { nodes: [] },
              },
            ],
          },
        },
      },
    };
    const requestFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method === "GET" &&
        request.url.endsWith("/actions/runs?event=pull_request&per_page=1")
      ) {
        return Response.json({ total_count: 0, workflow_runs: [] });
      }
      if (request.method !== "POST" || !request.url.endsWith("/graphql")) {
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }
      const body = (await request.json()) as { query: string };
      const data = body.query.includes("ObjectiveCardinality")
        ? { repository: { issue: { subIssues: { totalCount: 1 } } } }
        : detail;
      return Response.json(
        { data },
        {
          headers: { date: "Thu, 03 Sep 2026 01:01:00 GMT" },
        },
      );
    };

    const snapshot = await new GitHubReader({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch,
    }).readObjective(14);
    const [workItem] = snapshot.workItems;

    expect(workItem?.factoryEvents?.map((event) => event.runId)).toEqual([
      priorRun,
      priorRun,
    ]);
    expect(deriveV2State(workItem!, snapshot.readAt)).toBe("done");
  });
});
