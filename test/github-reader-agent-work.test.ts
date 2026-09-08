import { describe, expect, it } from "vitest";

import { encodeEventComment } from "../src/control/receipts.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const OBJECTIVE = 7;
const RUN = "runtime-read-count";
const ACTOR = "operator";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const OTHER_HEAD_SHA = "c".repeat(40);
const DIGEST = "d".repeat(64);
const POLICY_DIGEST = policyDigest(DEFAULT_RUN_POLICY);

function trusted(event: FactoryEvent) {
  return {
    body: encodeEventComment(event.event, event),
    author: { login: ACTOR },
    authorAssociation: "OWNER",
  };
}

function runStarted(): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunStarted",
    objective: OBJECTIVE,
    runId: RUN,
    sequence: 1,
    at: "2026-09-08T00:00:00.000Z",
    actor: ACTOR,
    repository: "fixture/project",
    objectiveAuthor: ACTOR,
    fork: false,
    baseBranch: "main",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: POLICY_DIGEST,
  });
}

function reservation(workItem: number, attempt: number, backend: string, sequence: number) {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event: "AttemptReserved",
    objective: OBJECTIVE,
    workItem,
    attempt,
    runId: RUN,
    sequence,
    at: `2026-09-08T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    backend,
    baseSha: BASE_SHA,
    directorEpoch: 1,
    policyDigest: POLICY_DIGEST,
  });
}

function publication(
  workItem: number,
  pullRequest: number,
  attempt: number,
  sequence: number,
  headSha = HEAD_SHA,
) {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "publication",
    event: "PublicationRecorded",
    objective: OBJECTIVE,
    workItem,
    attempt,
    runId: RUN,
    sequence,
    at: `2026-09-08T00:01:${String(sequence).padStart(2, "0")}.000Z`,
    unitId: `unit-${workItem}`,
    itemId: `item-${workItem}`,
    mode: "regular-prs",
    position: 0,
    branch: `factory/item-${workItem}`,
    baseBranch: "main",
    baseSha: BASE_SHA,
    headSha,
    pullRequest,
    capabilityVersion: "regular-prs/v1",
    validationDigest: DIGEST,
    exactHeadValidationDigest: DIGEST,
  });
}

function pull(number: number) {
  return {
    id: `PR_${number}`,
    number,
    state: "OPEN",
    isDraft: false,
    title: `PR ${number}`,
    body: "fixture",
    mergeable: "MERGEABLE",
    createdAt: "2026-09-08T00:01:00.000Z",
    mergedAt: null,
    closedAt: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    files: { nodes: [{ path: `src/${number}.ts` }] },
    commits: { nodes: [{ commit: { messageHeadline: `PR ${number}` } }] },
    statusCheckRollup: {
      nodes: [
        {
          commit: {
            oid: HEAD_SHA,
            committedDate: "2026-09-08T00:01:00.000Z",
            statusCheckRollup: { state: "SUCCESS" },
            checkSuites: { nodes: [] },
          },
        },
      ],
    },
  };
}

function item(number: number, pullRequest: number, events: FactoryEvent[]) {
  return {
    id: `I_${number}`,
    number,
    title: `Work Item ${number}`,
    body: "fixture",
    state: "OPEN",
    comments: { totalCount: events.length, nodes: events.map(trusted) },
    assignees: { nodes: [] },
    labels: { nodes: [{ name: "factory:work-item" }] },
    blockedBy: { totalCount: 0, nodes: [] },
    closedByPullRequestsReferences: { nodes: [pull(pullRequest)] },
    timelineItems: { nodes: [] },
  };
}

function fixture(workItems: ReturnType<typeof item>[], v2 = true) {
  const timelinePulls: number[] = [];
  const detail = {
    rateLimit: {
      cost: 3,
      limit: 5_000,
      remaining: 4_000,
      resetAt: "2026-09-08T01:00:00.000Z",
    },
    repository: {
      id: "R_fixture",
      defaultBranchRef: { name: "main" },
      workItemLabel: { id: "L_work_item" },
      suggestedActors: { nodes: [] },
      issue: {
        id: "I_7",
        number: OBJECTIVE,
        title: "Objective",
        body: "fixture",
        state: "OPEN",
        author: { login: ACTOR },
        authorAssociation: "OWNER",
        comments: {
          totalCount: v2 ? 1 : 0,
          nodes: v2 ? [trusted(runStarted())] : [],
        },
        subIssues: { totalCount: workItems.length, nodes: workItems },
      },
    },
  };
  const reader = new GitHubReader({
    token: "test-token",
    owner: "fixture",
    repo: "project",
    requestFetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/graphql") {
        const body = (await request.json()) as { query: string };
        return Response.json({
          data: body.query.includes("ObjectiveCardinality")
            ? {
                repository: {
                  owner: { __typename: "Organization" },
                  issue: { subIssues: { totalCount: workItems.length } },
                },
              }
            : detail,
        });
      }
      if (url.pathname.endsWith("/timeline")) {
        timelinePulls.push(Number(url.pathname.split("/").at(-2)));
        return Response.json([
          { event: "copilot_work_started", created_at: "2026-09-08T00:01:01.000Z" },
        ]);
      }
      if (url.pathname.endsWith("/actions/runs")) {
        return Response.json({ total_count: 0, workflow_runs: [] });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    },
  });
  return { reader, timelinePulls };
}

describe("GitHubReader Agent Work timeline reads", () => {
  it("omits the timeline for an exact current non-managed publication", async () => {
    const events = [reservation(8, 1, "codex-sdk/local-worktree", 2), publication(8, 23, 1, 3)];
    const f = fixture([item(8, 23, events)]);

    const snapshot = await f.reader.readObjective(OBJECTIVE);

    expect(f.timelinePulls).toEqual([]);
    expect(snapshot.workItems[0]?.linkedPullRequests[0]?.agentWorkEvents).toEqual([]);
  });

  it("turns the captured three-local-PR shape from three timeline reads into zero", async () => {
    const workItems = [
      item(8, 23, [reservation(8, 1, "codex-sdk/local-worktree", 2), publication(8, 23, 1, 3)]),
      item(9, 24, [reservation(9, 1, "codex-cli/local-worktree", 4), publication(9, 24, 1, 5)]),
      item(10, 25, [reservation(10, 1, "codex-sdk/local-worktree", 6), publication(10, 25, 1, 7)]),
    ];
    const f = fixture(workItems);

    await f.reader.readObjective(OBJECTIVE);

    expect(f.timelinePulls).toEqual([]);
  });

  it.each([
    ["legacy history", false, "codex-sdk/local-worktree"],
    ["a managed attempt", true, "github-copilot/github-managed"],
  ])("retains the timeline for %s", async (_name, v2, backend) => {
    const events = [reservation(8, 1, backend, 2), publication(8, 23, 1, 3)];
    const f = fixture([item(8, 23, events)], v2);

    const snapshot = await f.reader.readObjective(OBJECTIVE);

    expect(f.timelinePulls).toEqual([23]);
    expect(snapshot.workItems[0]?.linkedPullRequests[0]?.agentWorkEvents).toHaveLength(1);
  });

  it("reads only the managed member of a mixed v2 Objective", async () => {
    const local = [reservation(8, 1, "codex-cli/local-worktree", 2), publication(8, 23, 1, 3)];
    const managed = [
      reservation(9, 1, "github-copilot/github-managed", 4),
      publication(9, 24, 1, 5),
    ];
    const f = fixture([item(8, 23, local), item(9, 24, managed)]);

    await f.reader.readObjective(OBJECTIVE);

    expect(f.timelinePulls).toEqual([24]);
  });

  it("does not omit a timeline on the strength of untrusted receipt comments", async () => {
    const events = [reservation(8, 1, "codex-sdk/local-worktree", 2), publication(8, 23, 1, 3)];
    const workItem = item(8, 23, events);
    for (const comment of workItem.comments.nodes) comment.authorAssociation = "CONTRIBUTOR";
    const f = fixture([workItem]);

    await f.reader.readObjective(OBJECTIVE);

    expect(f.timelinePulls).toEqual([23]);
  });

  it.each([
    [
      "a stale published head",
      [reservation(8, 1, "codex-sdk/local-worktree", 2), publication(8, 23, 1, 3, OTHER_HEAD_SHA)],
    ],
    [
      "a publication for a superseded attempt",
      [
        reservation(8, 1, "codex-sdk/local-worktree", 2),
        publication(8, 23, 1, 3),
        reservation(8, 2, "codex-sdk/local-worktree", 4),
      ],
    ],
    [
      "ambiguous publication identity",
      [
        reservation(8, 1, "codex-sdk/local-worktree", 2),
        publication(8, 23, 1, 3),
        publication(8, 23, 1, 4),
      ],
    ],
  ])("retains the timeline for %s", async (_name, events) => {
    const f = fixture([item(8, 23, events)]);

    await f.reader.readObjective(OBJECTIVE);

    expect(f.timelinePulls).toEqual([23]);
  });
});
