import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Dispatcher,
  attemptAction,
  confirmAction,
  type DispatcherOptions,
  type GitHubWriter,
} from "../src/dispatch.js";
import {
  CircuitBreaker,
  ContentCreationPacer,
  PlatformUnavailableError,
} from "../src/platform.js";
import { attemptCount, deriveState, DISPATCH_CONFIRM_WINDOW_MS } from "../src/state.js";
import type { DerivedWorkItem } from "../src/state.js";
import {
  COPILOT_ASSIGNEE_LOGIN,
  INITIAL_PLAN_COMMIT,
  type LinkedPullRequest,
  type WorkItemSnapshot,
} from "../src/types.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function pr(over: Partial<LinkedPullRequest> = {}): LinkedPullRequest {
  return {
    id: "PR_1",
    number: 1,
    state: "OPEN",
    isDraft: true,
    title: "Initial plan",
    body: "",
    changedLines: 0,
    changedFiles: 0,
    changedFilePaths: [],
    commitSubjects: [INITIAL_PLAN_COMMIT],
    checks: "PENDING",
    mergeable: "UNKNOWN",
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
    assignees: [COPILOT_ASSIGNEE_LOGIN],
    blockedBy: [],
    linkedPullRequests: [],
    copilotAssignments: [],
    ...over,
  };
}

/** Builds a `DerivedWorkItem` without going through a full `ObjectiveSnapshot`. */
function derivedWi(over: Partial<WorkItemSnapshot> = {}, now = NOW): DerivedWorkItem {
  const snap = wi(over);
  return { ...snap, state: deriveState(snap, now), attempts: attemptCount(snap) };
}

/** Records every call made to it, and can be configured to reject on a given method. */
class FakeWriter implements GitHubWriter {
  calls: string[] = [];
  comments: string[] = [];
  failing: Partial<Record<keyof GitHubWriter, unknown>>;

  constructor(failing: Partial<Record<keyof GitHubWriter, unknown>> = {}) {
    this.failing = failing;
  }

  async assignCopilot(args: {
    issueId: string;
    botId: string;
    repositoryId: string;
    baseRef: string;
  }): Promise<void> {
    this.calls.push(`assignCopilot:${args.issueId}:${args.botId}`);
    if (this.failing.assignCopilot) throw this.failing.assignCopilot;
  }

  async clearActors(issueId: string): Promise<void> {
    this.calls.push(`clearActors:${issueId}`);
    if (this.failing.clearActors) throw this.failing.clearActors;
  }

  async approveWorkflowRun(runId: number): Promise<void> {
    this.calls.push(`approveWorkflowRun:${runId}`);
    if (this.failing.approveWorkflowRun) throw this.failing.approveWorkflowRun;
  }

  async addHumanAssignee(issueId: string, userId: string): Promise<void> {
    this.calls.push(`addHumanAssignee:${issueId}:${userId}`);
    if (this.failing.addHumanAssignee) throw this.failing.addHumanAssignee;
  }

  async addComment(subjectId: string, body: string): Promise<void> {
    this.calls.push(`addComment:${subjectId}`);
    this.comments.push(body);
    if (this.failing.addComment) throw this.failing.addComment;
  }

  async closePullRequest(pullRequestId: string): Promise<void> {
    this.calls.push(`closePullRequest:${pullRequestId}`);
    if (this.failing.closePullRequest) throw this.failing.closePullRequest;
  }

  async closeIssue(issueId: string): Promise<void> {
    this.calls.push(`closeIssue:${issueId}`);
    if (this.failing.closeIssue) throw this.failing.closeIssue;
  }

  async markPullRequestReady(pullRequestId: string): Promise<void> {
    this.calls.push(`markPullRequestReady:${pullRequestId}`);
    if (this.failing.markPullRequestReady) throw this.failing.markPullRequestReady;
  }

  async mergePullRequest(pullRequestId: string): Promise<void> {
    this.calls.push(`mergePullRequest:${pullRequestId}`);
    if (this.failing.mergePullRequest) throw this.failing.mergePullRequest;
  }

  async updatePullRequestBranch(pullRequestId: string): Promise<void> {
    this.calls.push(`updatePullRequestBranch:${pullRequestId}`);
    if (this.failing.updatePullRequestBranch) throw this.failing.updatePullRequestBranch;
  }
}

/** Shape `classifyRefusal` (platform.ts) recognizes as a secondary rate limit. */
function rateLimitError(): unknown {
  return {
    status: 403,
    message: "API rate limit exceeded for user ID 1.",
    response: { headers: { "x-ratelimit-remaining": "5000" } },
  };
}

function makeDispatcher(
  writer: GitHubWriter,
  overrides: Partial<DispatcherOptions> = {},
): Dispatcher {
  return new Dispatcher({
    writer,
    repositoryId: "R_1",
    copilotBotId: "BOT_1",
    defaultBranch: "main",
    escalateToId: "U_human",
    // No gap between calls, so tests run fast rather than pacing for real.
    pacer: new ContentCreationPacer(10_000, 100_000, 0),
    ...overrides,
  });
}

describe("confirmAction", () => {
  it("waits inside the confirm window", () => {
    const item = derivedWi({ copilotAssignments: [new Date(NOW.getTime() - 30_000)] });
    expect(confirmAction(item, NOW)).toBe("wait");
  });

  it("retries on the first PR-less assignment past the window", () => {
    const item = derivedWi({
      copilotAssignments: [new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1)],
    });
    expect(confirmAction(item, NOW)).toBe("retry");
  });

  it("escalates on the second consecutive PR-less assignment", () => {
    const item = derivedWi({
      copilotAssignments: [
        new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 120_000),
        new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1),
      ],
    });
    expect(confirmAction(item, NOW)).toBe("escalate");
  });
});

describe("attemptAction", () => {
  it("retries under three attempts", () => {
    const item = derivedWi({
      linkedPullRequests: [pr({ number: 1, state: "CLOSED" }), pr({ number: 2 })],
    });
    expect(attemptAction(item)).toBe("retry");
  });

  it("escalates at three attempts", () => {
    const item = derivedWi({
      linkedPullRequests: [
        pr({ number: 1, state: "CLOSED" }),
        pr({ number: 2, state: "CLOSED" }),
        pr({ number: 3 }),
      ],
    });
    expect(attemptAction(item)).toBe("escalate");
  });
});

describe("Dispatcher.start", () => {
  it("assigns Copilot to the issue", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    await d.start(item);
    expect(writer.calls).toEqual([`assignCopilot:${item.id}:BOT_1`]);
  });
});

describe("Dispatcher.closeObjective", () => {
  it("closes the Objective issue", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    await d.closeObjective("OBJECTIVE_1");
    expect(writer.calls).toEqual(["closeIssue:OBJECTIVE_1"]);
  });
});

describe("Dispatcher.approveChecks", () => {
  const SAFE = { safe: true, blockers: [], assurances: ["read-only token"] };
  const UNSAFE = {
    safe: false,
    blockers: ["the diff edits .github/workflows/ci.yml"],
    assurances: [],
  };
  const RUNS = [
    { id: 42, name: "CI", event: "pull_request" },
    { id: 43, name: "Lint", event: "pull_request" },
  ];

  it("approves every held run when the review passes", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const outcome = await d.approveChecks(item, RUNS, SAFE);

    expect(outcome.action).toBe("approved");
    expect(outcome.approvedRunIds).toEqual([42, 43]);
    expect(writer.calls).toContain("approveWorkflowRun:42");
    expect(writer.calls).toContain("approveWorkflowRun:43");
  });

  it("records the reasoning on the Work Item, so the decision outlives the session", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    await d.approveChecks(derivedWi(), RUNS, SAFE);

    const comment = writer.comments.join("\n");
    expect(comment).toContain("read-only token");
    expect(comment).toContain("#42");
  });

  it("does not approve anything when the review declines", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const outcome = await d.approveChecks(derivedWi(), RUNS, UNSAFE);

    expect(outcome.action).toBe("escalated");
    expect(outcome.approvedRunIds).toEqual([]);
    expect(writer.calls.some((c) => c.startsWith("approveWorkflowRun"))).toBe(false);
  });

  it("escalates to a human, naming the specific blocker", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    await d.approveChecks(item, RUNS, UNSAFE);

    expect(writer.calls).toContain(`addHumanAssignee:${item.id}:U_human`);
    expect(writer.comments.join("\n")).toContain(".github/workflows/ci.yml");
  });

  it("is a no-op when nothing is held, rather than escalating", async () => {
    // An unsafe verdict is irrelevant if GitHub is not waiting on us: there is
    // no decision to make, so neither approving nor escalating is warranted.
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const outcome = await d.approveChecks(derivedWi(), [], UNSAFE);

    expect(outcome.action).toBe("no_runs_held");
    expect(writer.calls).toEqual([]);
  });
});

describe("Dispatcher.confirm", () => {
  it("does nothing inside the confirm window", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({ copilotAssignments: [new Date(NOW.getTime() - 30_000)] });
    await d.confirm(item, NOW);
    expect(writer.calls).toEqual([]);
  });

  it("clears then reassigns on the first confirm failure", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({
      copilotAssignments: [new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1)],
    });
    await d.confirm(item, NOW);
    // Order matters: a bare reassignment is not a transition (PRD F8).
    expect(writer.calls).toEqual([`clearActors:${item.id}`, `assignCopilot:${item.id}:BOT_1`]);
  });

  it("escalates instead of retrying on the second confirm failure", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({
      copilotAssignments: [
        new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 120_000),
        new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1),
      ],
    });
    await d.confirm(item, NOW);
    expect(writer.calls).toEqual([
      `addHumanAssignee:${item.id}:U_human`,
      `clearActors:${item.id}`,
      `addComment:${item.id}`,
    ]);
  });

  it("stops after the failing call and never reaches the reassignment", async () => {
    // A partial failure here must not paper over the refusal by continuing
    // on to assignCopilot — the next cycle re-derives state and retries.
    const writer = new FakeWriter({ clearActors: rateLimitError() });
    const d = makeDispatcher(writer);
    const item = derivedWi({
      copilotAssignments: [new Date(NOW.getTime() - DISPATCH_CONFIRM_WINDOW_MS - 1)],
    });
    await expect(d.confirm(item, NOW)).rejects.toBeInstanceOf(PlatformUnavailableError);
    expect(writer.calls).toEqual([`clearActors:${item.id}`]);
  });
});

describe("Dispatcher.retryOrEscalate", () => {
  it("comments, closes the current PR, then reassigns when under the attempt cap", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({ linkedPullRequests: [pr({ id: "PR_current" })] });
    await d.retryOrEscalate(item);
    expect(writer.calls).toEqual([
      "addComment:PR_current",
      "closePullRequest:PR_current",
      `clearActors:${item.id}`,
      `assignCopilot:${item.id}:BOT_1`,
    ]);
  });

  it("skips the PR steps when no open PR remains and still reassigns", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    // Two closed attempts already, no currently open PR (an edge case, but
    // `retryOrEscalate` should still make forward progress).
    const item = derivedWi({
      linkedPullRequests: [
        pr({ number: 1, state: "CLOSED" }),
        pr({ number: 2, state: "CLOSED" }),
      ],
    });
    await d.retryOrEscalate(item);
    expect(writer.calls).toEqual([`clearActors:${item.id}`, `assignCopilot:${item.id}:BOT_1`]);
  });

  it("escalates by issue, not by PR, once attempts are exhausted", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({
      linkedPullRequests: [
        pr({ number: 1, state: "CLOSED" }),
        pr({ number: 2, state: "CLOSED" }),
        pr({ number: 3, id: "PR_current" }),
      ],
    });
    await d.retryOrEscalate(item);
    expect(writer.calls).toEqual([
      `addHumanAssignee:${item.id}:U_human`,
      `clearActors:${item.id}`,
      `addComment:${item.id}`,
    ]);
  });
});

describe("Dispatcher.integrate", () => {
  it("merges a ready, non-draft PR without marking it ready first", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const p = pr({ id: "PR_ready", isDraft: false });
    await d.integrate(item, p, { kind: "ready" });
    expect(writer.calls).toEqual(["mergePullRequest:PR_ready"]);
  });

  it("marks a draft PR ready before merging", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const p = pr({ id: "PR_draft", isDraft: true });
    await d.integrate(item, p, { kind: "ready" });
    expect(writer.calls).toEqual(["markPullRequestReady:PR_draft", "mergePullRequest:PR_draft"]);
  });

  it("waits on checks_pending without writing anything", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    await d.integrate(item, pr(), { kind: "checks_pending" });
    expect(writer.calls).toEqual([]);
  });

  it("resolves a conflict by updating the branch when GitHub accepts it", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const p = pr({ id: "PR_conflict" });
    await d.integrate(item, p, { kind: "conflict" });
    expect(writer.calls).toEqual(["updatePullRequestBranch:PR_conflict"]);
  });

  it("closes and re-dispatches when the branch update is rejected as unresolvable", async () => {
    const boom = new Error("merge conflict between base and head");
    const writer = new FakeWriter({ updatePullRequestBranch: boom });
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const p = pr({ id: "PR_conflict" });
    await d.integrate(item, p, { kind: "conflict" });
    expect(writer.calls).toEqual([
      "updatePullRequestBranch:PR_conflict",
      "addComment:PR_conflict",
      "closePullRequest:PR_conflict",
      `clearActors:${item.id}`,
      `assignCopilot:${item.id}:BOT_1`,
    ]);
  });

  it("rethrows a platform refusal from the branch update rather than treating it as unresolvable", async () => {
    const writer = new FakeWriter({ updatePullRequestBranch: rateLimitError() });
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const p = pr({ id: "PR_conflict" });
    await expect(d.integrate(item, p, { kind: "conflict" })).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
    expect(writer.calls).toEqual(["updatePullRequestBranch:PR_conflict"]);
  });

  it("routes untouched through retryOrEscalate with a scope-specific reason", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({ linkedPullRequests: [pr({ id: "PR_untouched" })] });
    await d.integrate(item, pr({ id: "PR_untouched" }), {
      kind: "untouched",
      touchedFiles: ["unrelated.ts"],
    });
    expect(writer.calls).toEqual([
      "addComment:PR_untouched",
      "closePullRequest:PR_untouched",
      `clearActors:${item.id}`,
      `assignCopilot:${item.id}:BOT_1`,
    ]);
  });

  it("routes checks_failed through retryOrEscalate", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({ linkedPullRequests: [pr({ id: "PR_failed" })] });
    await d.integrate(item, pr({ id: "PR_failed" }), { kind: "checks_failed" });
    expect(writer.calls).toEqual([
      "addComment:PR_failed",
      "closePullRequest:PR_failed",
      `clearActors:${item.id}`,
      `assignCopilot:${item.id}:BOT_1`,
    ]);
    expect(writer.comments.join("\n")).toContain("required checks failed");
  });

  // Gate 3, §10.5 F1. GitHub requires a maintainer to click "Approve and run
  // workflows" on a coding-agent PR, so an unapproved run concludes `failure`
  // having executed nothing. Reporting that as a failed test sends whoever
  // reads the escalation hunting for a bug that does not exist.
  it("names the real cause when CI concluded without running a job", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({ linkedPullRequests: [pr({ id: "PR_failed" })] });
    await d.integrate(
      item,
      pr({ id: "PR_failed", checks: "FAILURE", checksNeverStarted: true }),
      { kind: "checks_failed" },
    );
    const comment = writer.comments.join("\n");
    expect(comment).toContain("without running a single job");
    expect(comment).toContain("Approve and run workflows");
    expect(comment).not.toContain("required checks failed");
  });

  it("waits rather than acting when checks are expected but absent", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({ linkedPullRequests: [pr({ id: "PR_missing" })] });
    await d.integrate(item, pr({ id: "PR_missing", checks: null }), {
      kind: "checks_missing",
    });
    expect(writer.calls).toEqual([]);
  });
});

describe("Dispatcher / platform.ts integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps a classified refusal rather than swallowing it", async () => {
    const writer = new FakeWriter({ assignCopilot: rateLimitError() });
    const d = makeDispatcher(writer);
    await expect(d.start(derivedWi())).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  it("propagates a genuine, non-refusal error unchanged", async () => {
    const boom = new Error("issue not found");
    const writer = new FakeWriter({ assignCopilot: boom });
    const d = makeDispatcher(writer);
    await expect(d.start(derivedWi())).rejects.toBe(boom);
  });

  it("waits out an open circuit before making the next call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const writer = new FakeWriter({ assignCopilot: rateLimitError() });
    const breaker = new CircuitBreaker({
      openAfterConsecutiveRefusals: 1,
      baseCooldownMs: 60_000,
      maxCooldownMs: 60_000,
    });
    const d = makeDispatcher(writer, { circuitBreaker: breaker });

    await expect(d.start(derivedWi())).rejects.toBeInstanceOf(PlatformUnavailableError);
    expect(breaker.isOpen(new Date())).toBe(true);

    writer.failing.assignCopilot = undefined;
    const second = d.start(derivedWi());
    await vi.advanceTimersByTimeAsync(60_000);
    await second;

    expect(writer.calls.filter((c) => c.startsWith("assignCopilot")).length).toBe(2);
  });
});
