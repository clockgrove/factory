import { describe, expect, it } from "vitest";

import {
  DISPATCH_CONFIRM_WINDOW_MS,
  EMPTY_PULL_REQUEST_GRACE_MS,
  allDone,
  attemptCount,
  confirmFailureStreak,
  counts,
  currentOpenPullRequest,
  derive,
  deriveState,
  isNoOp,
  isStalled,
  ready,
} from "../src/state.js";
import {
  COPILOT_ASSIGNEE_LOGIN,
  INITIAL_PLAN_COMMIT,
  type LinkedPullRequest,
  type ObjectiveSnapshot,
  type WorkItemSnapshot,
} from "../src/types.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function pr(over: Partial<LinkedPullRequest> = {}): LinkedPullRequest {
  return {
    id: "PR_1",
    number: 1,
    state: "OPEN",
    isDraft: true,
    title: "Add slugify",
    body: "",
    changedLines: 40,
    changedFiles: 2,
    changedFilePaths: ["src/slugify.ts"],
    commitSubjects: [INITIAL_PLAN_COMMIT, "Add slugify"],
    checks: "SUCCESS",
    mergeable: "MERGEABLE",
    createdAt: NOW,
    headSha: "deadbeef",
    ...over,
  };
}

let nextId = 1;

function wi(over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return {
    id: `WI_${nextId++}`,
    number: 10,
    title: "Add slugify",
    closed: false,
    assignees: [],
    blockedBy: [],
    linkedPullRequests: [],
    copilotAssignments: [],
    ...over,
  };
}

function objective(items: WorkItemSnapshot[]): ObjectiveSnapshot {
  return {
    id: "I_OBJ",
    number: 1,
    title: "Add three utilities",
    body: "Add three pure utility functions, each with tests.",
    closed: false,
    workItems: items,
    readAt: NOW,
    repositoryId: "R_1",
    defaultBranch: "main",
    copilotBotId: "BOT_1",
    ciExpectedOnPullRequests: false,
  };
}

/**
 * The no-op detector is the single most important classifier in Factory:
 * PROBE-001 measured an impossible task returning `conclusion: success`, so
 * this is what stands between "the agent said it worked" and "it worked".
 */
describe("isNoOp", () => {
  it("treats an empty PR containing only the agent's plan commit as a no-op", () => {
    expect(
      isNoOp(
        pr({
          changedLines: 0,
          changedFiles: 0,
          commitSubjects: [INITIAL_PLAN_COMMIT],
        }),
      ),
    ).toBe(true);
  });

  it("treats a PR with no commits at all as a no-op", () => {
    expect(
      isNoOp(pr({ changedLines: 0, changedFiles: 0, commitSubjects: [] })),
    ).toBe(true);
  });

  it("does not treat a real diff as a no-op", () => {
    expect(isNoOp(pr({ changedLines: 12, changedFiles: 1 }))).toBe(false);
  });

  it("trusts the diff over the commit list", () => {
    // A rebase or squash can leave only the plan commit visible while the diff
    // is real. The artifact is the evidence, so the diff wins.
    expect(
      isNoOp(
        pr({
          changedLines: 30,
          changedFiles: 1,
          commitSubjects: [INITIAL_PLAN_COMMIT],
        }),
      ),
    ).toBe(false);
  });

  it("counts a real commit even when the diff is empty", () => {
    // A pure rename or mode change can report zero changed lines.
    expect(
      isNoOp(
        pr({
          changedLines: 0,
          changedFiles: 0,
          commitSubjects: [INITIAL_PLAN_COMMIT, "Rename module"],
        }),
      ),
    ).toBe(false);
  });
});

describe("deriveState", () => {
  it("is unstarted with no assignee and no PR", () => {
    expect(deriveState(wi(), NOW)).toBe("unstarted");
  });

  it("is dispatched once Copilot is assigned but nothing exists yet", () => {
    expect(deriveState(wi({ assignees: [COPILOT_ASSIGNEE_LOGIN] }), NOW)).toBe(
      "dispatched",
    );
  });

  it("is blocked while a dependency is open", () => {
    expect(
      deriveState(wi({ blockedBy: [{ number: 9, closed: false }] }), NOW),
    ).toBe("blocked");
  });

  it("is unstarted once every dependency is closed", () => {
    expect(
      deriveState(wi({ blockedBy: [{ number: 9, closed: true }] }), NOW),
    ).toBe("unstarted");
  });

  it("is escalated when a human holds it and Copilot does not", () => {
    expect(deriveState(wi({ assignees: ["kirkmarple"] }), NOW)).toBe(
      "escalated",
    );
  });

  it("is not escalated while Copilot is still an assignee", () => {
    // Escalation is defined as a handoff (§7.2): Copilot must be removed.
    // GitHub also auto-assigns the requesting human alongside Copilot
    // (verified live, 2026-08-30) — this is exactly that shape.
    expect(
      deriveState(wi({ assignees: [COPILOT_ASSIGNEE_LOGIN, "kirkmarple"] }), NOW),
    ).toBe("dispatched");
  });

  it("is in_flight when a no-op PR is still within the confirm window", () => {
    // No diff yet is not evidence of failure: the session (PRD F8 — there is
    // no reliable per-issue session-status API) may still be pushing commits.
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      copilotAssignments: [new Date(NOW.getTime() - 30_000)],
      linkedPullRequests: [
        pr({ changedLines: 0, changedFiles: 0, commitSubjects: [] }),
      ],
    });
    expect(deriveState(item, NOW)).toBe("in_flight");
  });

  it("is failed once the confirm window elapses with only a no-op PR", () => {
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      copilotAssignments: [
        new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1),
      ],
      linkedPullRequests: [
        pr({
          changedLines: 0,
          changedFiles: 0,
          commitSubjects: [INITIAL_PLAN_COMMIT],
          // The PR must also be past its own grace period; an empty PR that is
          // merely older than the *dispatch* confirm window is not yet
          // evidence of failure (§10.5, F3).
          createdAt: new Date(NOW.getTime() - EMPTY_PULL_REQUEST_GRACE_MS - 1),
        }),
      ],
    });
    expect(deriveState(item, NOW)).toBe("failed");
  });

  // Gate 3, F3 (§10.5). The agent opens its draft PR within seconds and then
  // works for minutes. Judging that PR on the assignment clock declared a live
  // session failed, and the skill's "retry every failed item" guidance would
  // have closed a PR that was actively being written.
  it("is in_flight when an empty PR is past the confirm window but still young", () => {
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      copilotAssignments: [
        new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1),
      ],
      linkedPullRequests: [
        pr({
          changedLines: 0,
          changedFiles: 0,
          commitSubjects: [INITIAL_PLAN_COMMIT],
          createdAt: new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1),
        }),
      ],
    });
    expect(deriveState(item, NOW)).toBe("in_flight");
  });

  it("does not extend the grace to a PR that explicitly declined", () => {
    // An explicit decline is the agent's final answer, not silence, so there
    // is nothing to wait for.
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      copilotAssignments: [
        new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1),
      ],
      linkedPullRequests: [
        pr({
          title: "No-op: impossible task — target file does not exist",
          changedLines: 0,
          changedFiles: 0,
          commitSubjects: [INITIAL_PLAN_COMMIT],
          createdAt: NOW,
        }),
      ],
    });
    expect(deriveState(item, NOW)).toBe("failed");
  });

  it("is failed when a settled no-op PR has no assignment timestamp at all", () => {
    // Defensive default: no evidence of a recent dispatch, so a no-op is not
    // excused. Should not occur in practice — a linked PR implies Copilot
    // was assigned at some point — but the fallback stays conservative.
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      linkedPullRequests: [
        pr({
          changedLines: 0,
          changedFiles: 0,
          commitSubjects: [INITIAL_PLAN_COMMIT],
          createdAt: new Date(NOW.getTime() - EMPTY_PULL_REQUEST_GRACE_MS - 1),
        }),
      ],
    });
    expect(deriveState(item, NOW)).toBe("failed");
  });

  it("is for_review when a real diff has settled checks", () => {
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      linkedPullRequests: [pr({ checks: "SUCCESS" })],
    });
    expect(deriveState(item, NOW)).toBe("for_review");
  });

  it("reaches for_review even while the PR is still a draft", () => {
    // PROBE-001: agents never undraft and never self-merge. Requiring a
    // ready-for-review PR here would stall every item forever.
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      linkedPullRequests: [pr({ isDraft: true, checks: "SUCCESS" })],
    });
    expect(deriveState(item, NOW)).toBe("for_review");
  });

  it("reaches for_review when the repo has no checks configured", () => {
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      linkedPullRequests: [pr({ checks: null })],
    });
    expect(deriveState(item, NOW)).toBe("for_review");
  });

  it("sends a failing-check PR to review rather than calling it failed", () => {
    // A red check is a review signal, not a no-op. Integration (§6) decides.
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      linkedPullRequests: [pr({ checks: "FAILURE" })],
    });
    expect(deriveState(item, NOW)).toBe("for_review");
  });

  it("is in_flight while checks are still pending", () => {
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      linkedPullRequests: [pr({ checks: "PENDING" })],
    });
    expect(deriveState(item, NOW)).toBe("in_flight");
  });

  it("is done when the issue is closed", () => {
    expect(deriveState(wi({ closed: true }), NOW)).toBe("done");
  });

  it("is done when a linked PR merged even if closure has not propagated", () => {
    const item = wi({ linkedPullRequests: [pr({ state: "MERGED" })] });
    expect(deriveState(item, NOW)).toBe("done");
  });

  it("judges the newest open PR, not a closed earlier attempt", () => {
    const item = wi({
      assignees: [COPILOT_ASSIGNEE_LOGIN],
      linkedPullRequests: [
        pr({ number: 1, state: "CLOSED", changedLines: 0, changedFiles: 0, commitSubjects: [] }),
        pr({ number: 2, state: "OPEN", changedLines: 50, checks: "SUCCESS" }),
      ],
    });
    expect(deriveState(item, NOW)).toBe("for_review");
  });
});

describe("currentOpenPullRequest", () => {
  const older = pr({
    id: "PR_old",
    number: 10,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const newer = pr({
    id: "PR_new",
    number: 11,
    createdAt: new Date("2026-01-02T00:00:00Z"),
  });

  it("picks the newest open pull request by createdAt, not array position", () => {
    // GitHub does not document an ordering for `closedByPullRequestsReferences`,
    // so the newest is not reliably last. This matters most on the retry path,
    // which closes whichever pull request this returns: choosing the older one
    // kills live work and leaves the stale attempt open to be merged.
    expect(currentOpenPullRequest(wi({ linkedPullRequests: [newer, older] }))?.id).toBe(
      "PR_new",
    );
    expect(currentOpenPullRequest(wi({ linkedPullRequests: [older, newer] }))?.id).toBe(
      "PR_new",
    );
  });

  it("breaks createdAt ties on the higher number", () => {
    const a = pr({ id: "PR_a", number: 20, createdAt: NOW });
    const b = pr({ id: "PR_b", number: 21, createdAt: NOW });
    expect(currentOpenPullRequest(wi({ linkedPullRequests: [b, a] }))?.id).toBe("PR_b");
    expect(currentOpenPullRequest(wi({ linkedPullRequests: [a, b] }))?.id).toBe("PR_b");
  });

  it("ignores closed pull requests even when they are newer", () => {
    const closedNewer = pr({
      id: "PR_closed",
      number: 12,
      state: "CLOSED",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    expect(
      currentOpenPullRequest(wi({ linkedPullRequests: [older, closedNewer] }))?.id,
    ).toBe("PR_old");
  });

  it("returns null when nothing is open", () => {
    expect(currentOpenPullRequest(wi({ linkedPullRequests: [] }))).toBeNull();
    expect(
      currentOpenPullRequest(
        wi({ linkedPullRequests: [pr({ state: "MERGED" })] }),
      ),
    ).toBeNull();
  });
});

describe("attemptCount", () => {
  it("derives attempts from linked PRs rather than a stored counter", () => {
    const item = wi({
      linkedPullRequests: [
        pr({ number: 1, state: "CLOSED" }),
        pr({ number: 2, state: "OPEN" }),
      ],
    });
    expect(attemptCount(item)).toBe(2);
  });

  it("is zero before any attempt", () => {
    expect(attemptCount(wi())).toBe(0);
  });
});

/**
 * §4.2's "unassign, reassign; on second failure escalate" needs to know how
 * many assignments in a row produced zero pull requests. This is derived
 * purely from the assignment timeline and each PR's `createdAt` — no stored
 * retry counter, so it survives a restart and needs no coordination even if
 * more than one process ever evaluated it (2026-08-30 design decision).
 */
describe("confirmFailureStreak", () => {
  it("is zero when Copilot has never been assigned", () => {
    expect(confirmFailureStreak(wi())).toBe(0);
  });

  it("is one after a single assignment that produced no PR", () => {
    const item = wi({ copilotAssignments: [new Date("2026-01-01T00:00:00Z")] });
    expect(confirmFailureStreak(item)).toBe(1);
  });

  it("is zero when the only assignment produced a PR", () => {
    const item = wi({
      copilotAssignments: [new Date("2026-01-01T00:00:00Z")],
      linkedPullRequests: [pr({ createdAt: new Date("2026-01-01T00:05:00Z") })],
    });
    expect(confirmFailureStreak(item)).toBe(0);
  });

  it("counts two consecutive PR-less assignments as a streak of two", () => {
    const item = wi({
      copilotAssignments: [
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T01:00:00Z"),
      ],
    });
    expect(confirmFailureStreak(item)).toBe(2);
  });

  it("stops the streak at the first earlier window that produced a PR", () => {
    // First assignment made a (later closed) no-op PR; the second, more
    // recent reassignment has produced nothing yet. Only the second should
    // count — conflating this with §4.4's separate attempt-count escalation
    // would escalate a fresh reassignment prematurely.
    const item = wi({
      copilotAssignments: [
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T02:00:00Z"),
      ],
      linkedPullRequests: [
        pr({
          number: 1,
          state: "CLOSED",
          createdAt: new Date("2026-01-01T00:05:00Z"),
        }),
      ],
    });
    expect(confirmFailureStreak(item)).toBe(1);
  });

  it("does not count a PR created before the assignment window it is checked against", () => {
    // A PR from an even earlier attempt must not be misattributed to a later
    // assignment window it predates.
    const item = wi({
      copilotAssignments: [
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T02:00:00Z"),
      ],
      linkedPullRequests: [
        pr({
          number: 1,
          state: "CLOSED",
          createdAt: new Date("2025-12-31T23:00:00Z"),
        }),
      ],
    });
    expect(confirmFailureStreak(item)).toBe(2);
  });
});

describe("ready", () => {
  it("returns only unstarted items whose dependencies are closed", () => {
    const o = derive(
      objective([
        wi({ number: 1 }),
        wi({ number: 2, blockedBy: [{ number: 1, closed: false }] }),
        wi({ number: 3, assignees: [COPILOT_ASSIGNEE_LOGIN] }),
      ]),
    );
    expect(ready(o).map((i) => i.number)).toEqual([1]);
  });

  it("excludes escalated items", () => {
    const o = derive(objective([wi({ number: 1, assignees: ["kirkmarple"] })]));
    expect(ready(o)).toHaveLength(0);
  });
});

describe("determinism", () => {
  it("derives the same result from the same snapshot", () => {
    // The property that makes crash recovery free (§1): no stored state means
    // "resume" and "start" are the same code path.
    const snapshot = objective([
      wi({ number: 1, closed: true }),
      wi({ number: 2, assignees: [COPILOT_ASSIGNEE_LOGIN], linkedPullRequests: [pr()] }),
      wi({ number: 3, blockedBy: [{ number: 2, closed: false }] }),
    ]);
    expect(derive(snapshot)).toEqual(derive(snapshot));
  });
});

describe("objective-level rollups", () => {
  it("reports allDone only when every item is done", () => {
    expect(allDone(derive(objective([wi({ closed: true })])))).toBe(true);
    expect(
      allDone(derive(objective([wi({ closed: true }), wi({ number: 2 })]))),
    ).toBe(false);
  });

  it("does not report allDone for an empty Objective", () => {
    // An Objective with no Work Items has not succeeded; it was never planned.
    expect(allDone(derive(objective([])))).toBe(false);
  });

  it("detects a stall when nothing is moving and nothing is ready", () => {
    const o = derive(
      objective([
        wi({ number: 1, assignees: ["kirkmarple"] }),
        wi({ number: 2, blockedBy: [{ number: 1, closed: false }] }),
      ]),
    );
    expect(isStalled(o)).toBe(true);
  });

  it("detects mutual deadlock", () => {
    const o = derive(
      objective([
        wi({ number: 1, blockedBy: [{ number: 2, closed: false }] }),
        wi({ number: 2, blockedBy: [{ number: 1, closed: false }] }),
      ]),
    );
    expect(isStalled(o)).toBe(true);
  });

  it("is not stalled while work is dispatched", () => {
    const o = derive(
      objective([
        wi({ number: 1, assignees: [COPILOT_ASSIGNEE_LOGIN] }),
        wi({ number: 2, blockedBy: [{ number: 1, closed: false }] }),
      ]),
    );
    expect(isStalled(o)).toBe(false);
  });

  it("is not stalled when everything is done", () => {
    expect(isStalled(derive(objective([wi({ closed: true })])))).toBe(false);
  });

  it("counts every state exactly once", () => {
    const o = derive(
      objective([
        wi({ number: 1, closed: true }),
        wi({ number: 2, assignees: [COPILOT_ASSIGNEE_LOGIN] }),
        wi({ number: 3 }),
      ]),
    );
    const c = counts(o);
    expect(c).toMatchObject({ done: 1, dispatched: 1, unstarted: 1 });
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(3);
  });
});
