import { describe, expect, it } from "vitest";

import { attemptCount, deriveState, queuedSince, type DerivedWorkItem } from "../src/state.js";
import type { FactoryEvent } from "../src/protocol/events.js";
import type { LinkedPullRequest, WorkItemSnapshot } from "../src/types.js";

const NOW = new Date("2026-09-03T00:10:00.000Z");
const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function item(over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return {
    id: "WI_2",
    number: 2,
    title: "Invitation API",
    closed: false,
    assignees: [],
    labels: ["factory:work-item"],
    blockedBy: [],
    linkedPullRequests: [],
    copilotAssignments: [],
    factoryEvents: [],
    ...over,
  };
}

function derivedItem(over: Partial<WorkItemSnapshot> = {}): DerivedWorkItem {
  const snapshot = item(over);
  return {
    ...snapshot,
    state: deriveState(snapshot, NOW),
    attempts: attemptCount(snapshot),
    doneWithoutMergedPullRequest: false,
  };
}

function attempt(
  event: Extract<FactoryEvent, { kind: "attempt" }>["event"],
  over: Partial<Extract<FactoryEvent, { kind: "attempt" }>> = {},
): Extract<FactoryEvent, { kind: "attempt" }> {
  return {
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event,
    objective: 1,
    runId: "run-1",
    sequence: 1,
    at: "2026-09-03T00:09:00.000Z",
    workItem: 2,
    attempt: 1,
    backend: "codex-cli/local-worktree",
    baseSha: SHA,
    directorEpoch: 1,
    policyDigest: DIGEST,
    ...over,
  };
}

function queued(sequence: number, at: string): Extract<FactoryEvent, { kind: "scheduling" }> {
  return {
    protocol: "clockgrove.factory/v2",
    kind: "scheduling",
    event: "WorkItemQueued",
    objective: 1,
    runId: "run-1",
    sequence,
    at,
    workItem: 2,
    directorEpoch: 1,
    policyDigest: DIGEST,
    reason: "local capacity saturated",
    observedPriorityRank: 10,
    observedSubIssuePosition: 1,
  };
}

describe("provider-neutral v2 state", () => {
  it("restarts queue delay after a dependency was reopened and closed", () => {
    const receipt = queued(1, "2026-09-03T00:01:00.000Z");
    expect(queuedSince(derivedItem({ factoryEvents: [receipt] }), "run-1")).toBe(receipt.at);
    expect(
      queuedSince(
        derivedItem({
          blockedBy: [
            {
              number: 1,
              closed: true,
              updatedAt: new Date("2026-09-03T00:02:00.000Z"),
            },
          ],
          factoryEvents: [receipt],
        }),
        "run-1",
      ),
    ).toBeUndefined();
  });

  it("derives readiness and blocking before the first attempt", () => {
    expect(deriveState(item(), NOW)).toBe("unstarted");
    expect(deriveState(item({ blockedBy: [{ number: 1, closed: false }] }), NOW)).toBe("blocked");
  });

  it("moves through reserved, in-flight, validating, and for-review", () => {
    const reserved = attempt("AttemptReserved");
    expect(deriveState(item({ factoryEvents: [reserved] }), NOW)).toBe("reserved");
    const started = attempt("AttemptStarted", { sequence: 2 });
    expect(deriveState(item({ factoryEvents: [reserved, started] }), NOW)).toBe("in_flight");
    const collected = attempt("AttemptCollected", { sequence: 3 });
    expect(deriveState(item({ factoryEvents: [reserved, started, collected] }), NOW)).toBe(
      "validating",
    );
    const validated = attempt("AttemptValidated", { sequence: 4 });
    expect(
      deriveState(item({ factoryEvents: [reserved, started, collected, validated] }), NOW),
    ).toBe("validating");
    const validation: Extract<FactoryEvent, { kind: "validation" }> = {
      protocol: "clockgrove.factory/v2",
      kind: "validation",
      event: "ValidationRecorded",
      objective: 1,
      runId: "run-1",
      sequence: 5,
      at: "2026-09-03T00:09:30.000Z",
      workItem: 2,
      attempt: 1,
      baseSha: SHA,
      outputTreeSha: "c".repeat(40),
      passed: true,
      evidenceDigest: "d".repeat(64),
    };
    const published = attempt("AttemptPublished", {
      sequence: 6,
      artifactDigest: DIGEST,
      headSha: "e".repeat(40),
    });
    expect(
      deriveState(
        item({
          factoryEvents: [reserved, started, collected, validation, validated, published],
        }),
        NOW,
      ),
    ).toBe("for_review");
  });

  it("fails stale reservations and terminal attempts", () => {
    const stale = attempt("AttemptReserved", { at: "2026-09-03T00:00:00.000Z" });
    expect(deriveState(item({ factoryEvents: [stale] }), NOW)).toBe("failed");
    expect(
      deriveState(
        item({
          factoryEvents: [
            attempt("AttemptReserved"),
            attempt("AttemptFailed", { sequence: 2, reason: "worker crashed" }),
          ],
        }),
        NOW,
      ),
    ).toBe("failed");
  });

  it("requeues infrastructure-deferred work without consuming its retry allowance", () => {
    const firstFailure = [
      attempt("AttemptReserved"),
      attempt("AttemptFailed", { sequence: 2, reason: "worker failed" }),
    ];
    const deferred = [
      attempt("AttemptReserved", { sequence: 3, attempt: 2 }),
      attempt("AttemptStarted", { sequence: 4, attempt: 2 }),
      attempt("AttemptDeferred", { sequence: 5, attempt: 2, reason: "GitHub unavailable" }),
    ];
    const workItem = item({ factoryEvents: [...firstFailure, ...deferred] });
    expect(deriveState(workItem, NOW)).toBe("unstarted");
    expect(attemptCount(workItem)).toBe(1);
    expect(
      deriveState(
        item({
          blockedBy: [{ number: 1, closed: false }],
          factoryEvents: deferred,
        }),
        NOW,
      ),
    ).toBe("blocked");
  });

  it("fails closed if an event appears after an attempt was deferred", () => {
    expect(
      deriveState(
        item({
          factoryEvents: [
            attempt("AttemptReserved"),
            attempt("AttemptDeferred", { sequence: 2 }),
            attempt("AttemptStarted", { sequence: 3 }),
          ],
        }),
        NOW,
      ),
    ).toBe("inconsistent");
  });

  it("fails closed on mixed backend ownership or Copilot assignment", () => {
    expect(
      deriveState(
        item({
          factoryEvents: [
            attempt("AttemptReserved"),
            attempt("AttemptStarted", {
              sequence: 2,
              backend: "codex-cli/daytona",
            }),
          ],
        }),
        NOW,
      ),
    ).toBe("inconsistent");
    expect(
      deriveState(
        item({
          assignees: ["Copilot"],
          factoryEvents: [attempt("AttemptReserved")],
        }),
        NOW,
      ),
    ).toBe("inconsistent");
  });

  it("accepts native merged-and-closed completion without inventing an integration receipt", () => {
    const published = attempt("AttemptPublished", {
      sequence: 2,
      artifactDigest: DIGEST,
      headSha: "e".repeat(40),
    });
    const integrated = attempt("AttemptIntegrated", {
      sequence: 3,
      headSha: "f".repeat(40),
    });
    const mergedPull: LinkedPullRequest = {
      id: "PR_7",
      number: 7,
      state: "MERGED",
      isDraft: false,
      title: "Implement value",
      body: "",
      changedLines: 1,
      changedFiles: 1,
      changedFilePaths: ["src/value.ts"],
      commitSubjects: ["Implement value"],
      checks: "SUCCESS",
      mergeable: "MERGEABLE",
      createdAt: NOW,
      headSha: "e".repeat(40),
      headCommittedAt: NOW,
      agentWorkEvents: [],
      mergedAt: NOW,
      closedAt: NOW,
    };
    expect(
      deriveState(item({ closed: true, factoryEvents: [attempt("AttemptReserved")] }), NOW),
    ).toBe("inconsistent");
    expect(deriveState(item({ closed: true }), NOW)).toBe("inconsistent");
    expect(deriveState(item({ linkedPullRequests: [mergedPull] }), NOW)).toBe("inconsistent");
    expect(deriveState(item({ closed: true, linkedPullRequests: [mergedPull] }), NOW)).toBe("done");
    expect(
      deriveState(
        item({
          closed: true,
          linkedPullRequests: [mergedPull],
          factoryEvents: [attempt("AttemptReserved"), attempt("AttemptFailed", { sequence: 2 })],
        }),
        NOW,
      ),
    ).toBe("done");
    expect(
      deriveState(item({ linkedPullRequests: [mergedPull], factoryEvents: [published] }), NOW),
    ).toBe("for_review");
    expect(
      deriveState(
        item({
          closed: true,
          linkedPullRequests: [mergedPull],
          factoryEvents: [published, integrated],
        }),
        NOW,
      ),
    ).toBe("done");
  });
});
