import { describe, expect, it } from "vitest";

import {
  allDone,
  attemptCount,
  counts,
  derive,
  deriveState,
  isNoOp,
  isStalled,
  ready,
} from "../src/state.js";
import {
  COPILOT_LOGIN,
  INITIAL_PLAN_COMMIT,
  type LinkedPullRequest,
  type ObjectiveSnapshot,
  type WorkItemSnapshot,
} from "../src/types.js";

function pr(over: Partial<LinkedPullRequest> = {}): LinkedPullRequest {
  return {
    number: 1,
    state: "OPEN",
    isDraft: true,
    changedLines: 40,
    changedFiles: 2,
    commitSubjects: [INITIAL_PLAN_COMMIT, "Add slugify"],
    checks: "SUCCESS",
    ...over,
  };
}

function wi(over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return {
    number: 10,
    title: "Add slugify",
    closed: false,
    assignees: [],
    blockedBy: [],
    linkedPullRequests: [],
    sessionActive: false,
    sessionFailed: false,
    ...over,
  };
}

function objective(items: WorkItemSnapshot[]): ObjectiveSnapshot {
  return {
    number: 1,
    title: "Add three utilities",
    closed: false,
    workItems: items,
    readAt: new Date("2026-01-01T00:00:00Z"),
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
    expect(deriveState(wi())).toBe("unstarted");
  });

  it("is dispatched once Copilot is assigned but nothing exists yet", () => {
    expect(deriveState(wi({ assignees: [COPILOT_LOGIN] }))).toBe("dispatched");
  });

  it("is blocked while a dependency is open", () => {
    expect(deriveState(wi({ blockedBy: [{ number: 9, closed: false }] }))).toBe(
      "blocked",
    );
  });

  it("is unstarted once every dependency is closed", () => {
    expect(deriveState(wi({ blockedBy: [{ number: 9, closed: true }] }))).toBe(
      "unstarted",
    );
  });

  it("is escalated when a human holds it and Copilot does not", () => {
    expect(deriveState(wi({ assignees: ["kirkmarple"] }))).toBe("escalated");
  });

  it("is not escalated while Copilot is still an assignee", () => {
    // Escalation is defined as a handoff (§7.2): Copilot must be removed.
    expect(
      deriveState(wi({ assignees: [COPILOT_LOGIN, "kirkmarple"] })),
    ).toBe("dispatched");
  });

  it("is in_flight while a session is running, regardless of PR contents", () => {
    const item = wi({
      assignees: [COPILOT_LOGIN],
      sessionActive: true,
      linkedPullRequests: [pr({ changedLines: 0, changedFiles: 0, commitSubjects: [] })],
    });
    // Judging an empty PR mid-session would judge an intermediate state.
    expect(deriveState(item)).toBe("in_flight");
  });

  it("is failed when a settled PR changed nothing", () => {
    const item = wi({
      assignees: [COPILOT_LOGIN],
      linkedPullRequests: [
        pr({ changedLines: 0, changedFiles: 0, commitSubjects: [INITIAL_PLAN_COMMIT] }),
      ],
    });
    expect(deriveState(item)).toBe("failed");
  });

  it("is failed when the session reported failure", () => {
    expect(
      deriveState(wi({ assignees: [COPILOT_LOGIN], sessionFailed: true })),
    ).toBe("failed");
  });

  it("is for_review when a real diff has settled checks", () => {
    const item = wi({
      assignees: [COPILOT_LOGIN],
      linkedPullRequests: [pr({ checks: "SUCCESS" })],
    });
    expect(deriveState(item)).toBe("for_review");
  });

  it("reaches for_review even while the PR is still a draft", () => {
    // PROBE-001: agents never undraft and never self-merge. Requiring a
    // ready-for-review PR here would stall every item forever.
    const item = wi({
      assignees: [COPILOT_LOGIN],
      linkedPullRequests: [pr({ isDraft: true, checks: "SUCCESS" })],
    });
    expect(deriveState(item)).toBe("for_review");
  });

  it("reaches for_review when the repo has no checks configured", () => {
    const item = wi({
      assignees: [COPILOT_LOGIN],
      linkedPullRequests: [pr({ checks: null })],
    });
    expect(deriveState(item)).toBe("for_review");
  });

  it("sends a failing-check PR to review rather than calling it failed", () => {
    // A red check is a review signal, not a no-op. Integration (§6) decides.
    const item = wi({
      assignees: [COPILOT_LOGIN],
      linkedPullRequests: [pr({ checks: "FAILURE" })],
    });
    expect(deriveState(item)).toBe("for_review");
  });

  it("is in_flight while checks are still pending", () => {
    const item = wi({
      assignees: [COPILOT_LOGIN],
      linkedPullRequests: [pr({ checks: "PENDING" })],
    });
    expect(deriveState(item)).toBe("in_flight");
  });

  it("is done when the issue is closed", () => {
    expect(deriveState(wi({ closed: true }))).toBe("done");
  });

  it("is done when a linked PR merged even if closure has not propagated", () => {
    const item = wi({ linkedPullRequests: [pr({ state: "MERGED" })] });
    expect(deriveState(item)).toBe("done");
  });

  it("judges the newest open PR, not a closed earlier attempt", () => {
    const item = wi({
      assignees: [COPILOT_LOGIN],
      linkedPullRequests: [
        pr({ number: 1, state: "CLOSED", changedLines: 0, changedFiles: 0, commitSubjects: [] }),
        pr({ number: 2, state: "OPEN", changedLines: 50, checks: "SUCCESS" }),
      ],
    });
    expect(deriveState(item)).toBe("for_review");
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

describe("ready", () => {
  it("returns only unstarted items whose dependencies are closed", () => {
    const o = derive(
      objective([
        wi({ number: 1 }),
        wi({ number: 2, blockedBy: [{ number: 1, closed: false }] }),
        wi({ number: 3, assignees: [COPILOT_LOGIN] }),
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
      wi({ number: 2, assignees: [COPILOT_LOGIN], linkedPullRequests: [pr()] }),
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
        wi({ number: 1, assignees: [COPILOT_LOGIN] }),
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
        wi({ number: 2, assignees: [COPILOT_LOGIN] }),
        wi({ number: 3 }),
      ]),
    );
    const c = counts(o);
    expect(c).toMatchObject({ done: 1, dispatched: 1, unstarted: 1 });
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(3);
  });
});
