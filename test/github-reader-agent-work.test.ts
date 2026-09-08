import { describe, expect, it } from "vitest";

import { encodeEventComment } from "../src/control/receipts.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { writerAuthority } from "../src/control/authority.js";
import { hasCurrentWriterAuthority, latestRunReceipts } from "../src/control/receipts.js";
import type { LeaseState } from "../src/control/lease.js";

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

function fixture(
  workItems: ReturnType<typeof item>[],
  v2 = true,
  objectiveReceipts: FactoryEvent[] = v2 ? [runStarted()] : [],
  authorityLease?: LeaseState | null,
) {
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
          totalCount: objectiveReceipts.length,
          nodes: objectiveReceipts.map(trusted),
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
      if (
        authorityLease !== undefined &&
        url.pathname.includes("/git/ref/") &&
        url.pathname.endsWith(`objective-${OBJECTIVE}`)
      ) {
        if (authorityLease === null) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        return Response.json(
          { object: { sha: authorityLease.oid } },
          { headers: { date: "Tue, 08 Sep 2026 00:05:00 GMT" } },
        );
      }
      if (authorityLease && url.pathname.endsWith(`/git/commits/${authorityLease.oid}`)) {
        const event = {
          protocol: "clockgrove.factory/v2",
          kind: "lease",
          event: "LeaseAcquired",
          objective: authorityLease.objective,
          runId: authorityLease.runId,
          sequence: authorityLease.sequence,
          at: "2026-09-08T00:04:00.000Z",
          holder: authorityLease.holder,
          epoch: authorityLease.epoch,
          expiresAt: authorityLease.expiresAt.toISOString(),
          policyDigest: authorityLease.policyDigest,
        };
        const trailer = Buffer.from(JSON.stringify(event), "utf8").toString("base64url");
        return Response.json({
          sha: authorityLease.oid,
          tree: { sha: authorityLease.treeOid },
          parents: [{ sha: BASE_SHA }],
          message: `Factory lease LeaseAcquired for Objective #${OBJECTIVE}\n\nFactory-Event: ${trailer}`,
        });
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

  it("binds fresh receipt authority to the custom lease ref observed after comments", async () => {
    const oldLease = {
      objective: OBJECTIVE,
      runId: RUN,
      holder: "old-writer",
      epoch: 1,
      policyDigest: POLICY_DIGEST,
    } as LeaseState;
    const currentLease = {
      ref: `refs/clockgrove-factory/leases/objective-${OBJECTIVE}`,
      oid: "e".repeat(40),
      treeOid: "f".repeat(40),
      objective: OBJECTIVE,
      runId: RUN,
      holder: "current-writer",
      epoch: 2,
      sequence: 8,
      expiresAt: new Date("2026-09-08T00:10:00.000Z"),
      policyDigest: POLICY_DIGEST,
    } satisfies LeaseState;
    const delayed = parseFactoryEvent({
      ...publication(8, 23, 1, 3),
      ...writerAuthority(oldLease, 3),
    });
    const f = fixture([item(8, 23, [delayed])], true, [runStarted()], currentLease);

    const snapshot = await f.reader.readObjective(OBJECTIVE);

    expect(snapshot.objectiveAuthority).toMatchObject({
      holder: "current-writer",
      epoch: 2,
      oid: currentLease.oid,
    });
    const events = snapshot.workItems[0]!.factoryEvents!;
    expect(events.some((event) => event.kind === "lease")).toBe(true);
    expect(hasCurrentWriterAuthority(delayed, events)).toBe(false);
    expect(events).toContainEqual(delayed);
  });

  it("fails closed when a writer-bound receipt has no authoritative Objective ref", async () => {
    const writer = {
      objective: OBJECTIVE,
      runId: RUN,
      holder: "missing-writer",
      epoch: 1,
      policyDigest: POLICY_DIGEST,
    } as LeaseState;
    const started = parseFactoryEvent({ ...runStarted(), ...writerAuthority(writer, 1) });
    const f = fixture([], true, [started], null);

    await expect(f.reader.readObjective(OBJECTIVE)).rejects.toThrow(
      "writer-bound receipts but no authoritative lease ref",
    );
  });

  it("retains a matching epoch-only terminal after the last canonical lease expires", async () => {
    const terminal = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "FactoryRunCompleted",
      objective: OBJECTIVE,
      runId: RUN,
      sequence: 7,
      at: "2026-09-08T00:03:00.000Z",
      writerEpoch: 2,
    });
    const released = {
      ref: `refs/clockgrove-factory/leases/objective-${OBJECTIVE}`,
      oid: "9".repeat(40),
      treeOid: "8".repeat(40),
      objective: OBJECTIVE,
      runId: RUN,
      holder: "legacy-writer",
      epoch: 2,
      sequence: 8,
      expiresAt: new Date("2026-09-08T00:04:00.000Z"),
      policyDigest: POLICY_DIGEST,
    } satisfies LeaseState;
    const f = fixture([], true, [runStarted(), terminal], released);

    const snapshot = await f.reader.readObjective(OBJECTIVE);

    expect(latestRunReceipts(snapshot.factoryEvents!)?.terminal).toEqual(terminal);
    expect(snapshot.objectiveAuthority?.observedAt.toISOString()).toBe("2026-09-08T00:05:00.000Z");
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
