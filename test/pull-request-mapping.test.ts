import { describe, expect, it } from "vitest";

import { toAgentWorkEvents, toPullRequest } from "../src/github.js";

/**
 * Tests for the GraphQL-to-Factory pull request mapping.
 *
 * Director must be able to reconstruct ordering after the fact — "was this
 * Work Item dispatched only after its dependency merged?" needs merge and close
 * timestamps from the tool surface (§10).
 *
 * These are deliberately mapping tests rather than derivation tests: nothing in
 * the state machine reads `mergedAt`/`closedAt`, which is precisely why they
 * need their own coverage. A reported-but-unread field that silently stops
 * populating produces no failing derivation — it just quietly answers every
 * future ordering question with `null`.
 */

const COMMIT = {
  oid: "deadbeef",
  committedDate: "2026-01-01T10:00:00Z",
  statusCheckRollup: { state: "SUCCESS" },
  checkSuites: { nodes: [] },
};

function gqlPr(over: Record<string, unknown> = {}) {
  return {
    id: "PR_1",
    number: 7,
    state: "OPEN" as const,
    isDraft: false,
    title: "Add slugify",
    body: "",
    mergeable: "MERGEABLE" as const,
    createdAt: "2026-01-01T09:00:00Z",
    mergedAt: null,
    closedAt: null,
    additions: 30,
    deletions: 10,
    changedFiles: 1,
    files: { nodes: [{ path: "src/slugify.ts" }] },
    commits: { nodes: [{ commit: { messageHeadline: "Add slugify" } }] },
    statusCheckRollup: { nodes: [{ commit: COMMIT }] },
    ...over,
  };
}

describe("pull request timestamps", () => {
  it("maps a merged pull request's merge and close times", () => {
    const pr = toPullRequest(
      gqlPr({
        state: "MERGED",
        mergedAt: "2026-01-01T12:00:00Z",
        closedAt: "2026-01-01T12:00:00Z",
      }) as never,
    );

    expect(pr.mergedAt?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(pr.closedAt?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });

  it("reports an open pull request as neither merged nor closed", () => {
    const pr = toPullRequest(gqlPr() as never);

    expect(pr.mergedAt).toBeNull();
    expect(pr.closedAt).toBeNull();
  });

  // A pull request closed without merging is the signature of an abandoned or
  // superseded attempt. Collapsing the two timestamps into one would make it
  // indistinguishable from an integration, which is the whole reason both are
  // recorded rather than a single "finished at".
  it("distinguishes a closed-unmerged pull request from a merged one", () => {
    const pr = toPullRequest(
      gqlPr({ state: "CLOSED", closedAt: "2026-01-01T11:00:00Z" }) as never,
    );

    expect(pr.mergedAt).toBeNull();
    expect(pr.closedAt?.toISOString()).toBe("2026-01-01T11:00:00.000Z");
  });
});

describe("head commit time", () => {
  it("reports when the agent last pushed, not when the pull request opened", () => {
    const pr = toPullRequest(gqlPr() as never);

    expect(pr.headCommittedAt.toISOString()).toBe("2026-01-01T10:00:00.000Z");
    expect(pr.createdAt.toISOString()).toBe("2026-01-01T09:00:00.000Z");
  });

  // The abandoned-attempt bound (§5.1) measures staleness from this field, so
  // a pull request with no commits must still produce a real Date. Falling back
  // to the PR's own creation time makes a brand-new empty PR trivially "recently
  // active", which errs toward waiting rather than toward judging live work.
  it("falls back to the pull request's creation time when there are no commits", () => {
    const pr = toPullRequest(gqlPr({ statusCheckRollup: { nodes: [] } }) as never);

    expect(pr.headCommittedAt.toISOString()).toBe("2026-01-01T09:00:00.000Z");
    expect(pr.headSha).toBe("");
  });
});

describe("Copilot REST timeline events", () => {
  it("maps known events, preserves failure detail, and sorts them", () => {
    const events = toAgentWorkEvents([
      {
        event: "copilot_work_finished_failure",
        created_at: "2026-01-01T10:03:00Z",
        failure_message: "quota exceeded",
      },
      { event: "copilot_work_started", created_at: "2026-01-01T10:00:00Z" },
      { event: "copilot_work_finished", created_at: "2026-01-01T10:02:00Z" },
    ]);

    expect(events.map((event) => event.kind)).toEqual(["started", "finished", "failed"]);
    expect(events[2]?.message).toBe("quota exceeded");
  });

  it("drops unknown events and entries without valid timestamps", () => {
    expect(toAgentWorkEvents([
      { event: "renamed", created_at: "2026-01-01T10:00:00Z" },
      { event: "copilot_work_started", created_at: "not-a-date" },
    ])).toEqual([]);
  });

  it("attaches separately hydrated events to a pull request", () => {
    const events = toAgentWorkEvents([
      { event: "copilot_work_started", created_at: "2026-01-01T10:00:00Z" },
    ]);

    expect(toPullRequest(gqlPr() as never, events).agentWorkEvents).toEqual(events);
  });
});
