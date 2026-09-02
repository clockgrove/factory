import { afterEach, describe, expect, it, vi } from "vitest";

/** A clean mechanical verdict: in scope, whole file list seen. */
const READY = {
  kind: "ready" as const,
  outOfScopeFiles: [] as string[],
  fileListComplete: true,
};

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
    headCommittedAt: NOW,
    mergedAt: null,
    closedAt: null,
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
    labels: [],
    blockedBy: [],
    linkedPullRequests: [],
    copilotAssignments: [],
    ...over,
  };
}

/** Builds a `DerivedWorkItem` without going through a full `ObjectiveSnapshot`. */
function derivedWi(over: Partial<WorkItemSnapshot> = {}, now = NOW): DerivedWorkItem {
  const snap = wi(over);
  const state = deriveState(snap, now);
  return {
    ...snap,
    state,
    attempts: attemptCount(snap),
    doneWithoutMergedPullRequest:
      state === "done" && !snap.linkedPullRequests.some((p) => p.state === "MERGED"),
  };
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

  async assignHumanOnly(issueId: string, userId: string): Promise<void> {
    this.calls.push(`assignHumanOnly:${issueId}:${userId}`);
    if (this.failing.assignHumanOnly) throw this.failing.assignHumanOnly;
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
  const SAFE = {
    safe: true,
    blockers: [],
    assurances: ["read-only token"],
    repoScopeSafe: true,
    repoScopeBlockers: [],
  };
  const UNSAFE = {
    safe: false,
    blockers: ["the diff edits .github/workflows/ci.yml"],
    assurances: [],
    // Diff-scoped only: the repository itself is still bounded, which is what
    // makes this distinct from REPO_UNSAFE below.
    repoScopeSafe: true,
    repoScopeBlockers: [],
  };
  const REPO_UNSAFE = {
    safe: false,
    blockers: ["workflow runs in this repository get a write-scoped GITHUB_TOKEN by default"],
    assurances: [],
    repoScopeSafe: false,
    repoScopeBlockers: [
      "workflow runs in this repository get a write-scoped GITHUB_TOKEN by default",
    ],
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

    expect(writer.calls).toContain(`assignHumanOnly:${item.id}:U_human`);
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

  it("still records what it did when approval fails partway through", async () => {
    // Approval is irreversible: run 42 is already executing. If the throw
    // escaped, that approval would exist with no trace on the Work Item.
    class HalfFailingWriter extends FakeWriter {
      override async approveWorkflowRun(runId: number): Promise<void> {
        this.calls.push(`approveWorkflowRun:${runId}`);
        if (runId === 43) throw new Error("boom");
      }
    }
    const writer = new HalfFailingWriter();
    const d = makeDispatcher(writer);
    const outcome = await d.approveChecks(derivedWi(), RUNS, SAFE);

    expect(outcome.action).toBe("partially_approved");
    expect(outcome.approvedRunIds).toEqual([42]);

    const comment = writer.comments.join("\n");
    expect(comment).toContain("Approved: 42.");
    expect(comment).toContain("boom");
    expect(comment).toContain("still held");
  });

  it("records the attempt even when no run could be approved at all", async () => {
    const writer = new FakeWriter({ approveWorkflowRun: new Error("403 forbidden") });
    const d = makeDispatcher(writer);
    const outcome = await d.approveChecks(derivedWi(), RUNS, SAFE);

    expect(outcome.approvedRunIds).toEqual([]);
    expect(writer.comments.join("\n")).toContain("none were approved");
  });

  // GitHub's approve endpoint is scoped to fork pull requests (§9)
  // and refuses a coding-agent branch with this exact message. There is no
  // second endpoint: the repository setting that governs the hold is readable
  // over REST and has no write, so Factory genuinely cannot release it. What
  // matters is that it says so instead of reporting a permanent, total failure
  // as a success-shaped `partially_approved` with an empty `approvedRunIds`.
  const FORK_ONLY = new Error(
    "This run is not from a fork pull request or queued by the Actions bot.",
  );

  it("reports a fork-only refusal as permanent and escalates", async () => {
    const writer = new FakeWriter({ approveWorkflowRun: FORK_ONLY });
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const outcome = await d.approveChecks(item, RUNS, SAFE);

    expect(outcome.action).toBe("not_approvable");
    expect(outcome.approvedRunIds).toEqual([]);
    expect(outcome.failures).toEqual(
      RUNS.map((r) => ({ runId: r.id, message: FORK_ONLY.message })),
    );
    expect(writer.calls).toContain(`assignHumanOnly:${item.id}:U_human`);
    expect(writer.comments.join("\n")).toContain("has no write API");
  });

  // The repository-scoped findings are the input to the decision the human now
  // has to make, so the escalation states a recommendation rather than leaving
  // them to re-derive one from a bullet list.
  it("tells the human the setting is low-risk when the repository is bounded", async () => {
    const writer = new FakeWriter({ approveWorkflowRun: FORK_ONLY });
    const d = makeDispatcher(writer);
    await d.approveChecks(derivedWi(), RUNS, SAFE);
    expect(writer.comments.join("\n")).toContain("low-risk *for this repository*");
  });

  it("warns instead when the repository is not bounded", async () => {
    const writer = new FakeWriter({ approveWorkflowRun: FORK_ONLY });
    const d = makeDispatcher(writer);
    // `safe` is false here, so this exercises the record's repo-scope branch via
    // a verdict that still reached the approve attempt.
    await d.approveChecks(derivedWi(), RUNS, {
      ...REPO_UNSAFE,
      safe: true,
      blockers: [],
    });
    const comment = writer.comments.join("\n");
    expect(comment).toContain("Be careful before turning that requirement off");
    expect(comment).toContain("write-scoped GITHUB_TOKEN");
  });

  // A permission failure is as permanent as the fork refusal, and used to be
  // reported as `partially_approved` — which Director reads as retryable, so it
  // would re-approve every cycle forever against a token that will never be
  // allowed, writing a fresh audit comment each time.
  it("treats an authorization failure as permanent, not retryable", async () => {
    const denied = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
    });
    const writer = new FakeWriter({ approveWorkflowRun: denied });
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const outcome = await d.approveChecks(item, RUNS, SAFE);

    expect(outcome.action).toBe("not_approvable");
    expect(writer.calls).toContain(`assignHumanOnly:${item.id}:U_human`);
    const comment = writer.comments.join("\n");
    // Named for what it is: the fork story would send the human to the wrong
    // setting entirely.
    expect(comment).toContain("HTTP 403");
    expect(comment).toContain("write access to Actions");
    expect(comment).not.toContain("only covers fork pull requests");
    expect(comment).not.toContain("low-risk *for this repository*");
  });

  // platform.ts routes rate-limit 403s to PlatformUnavailableError, so a 403
  // reaching the classifier really is a permission problem. But the loop used
  // to swallow PlatformUnavailableError itself, which would have classified a
  // secondary rate limit as a permanent refusal and escalated it to a human —
  // the precise "refusal misread as work failure" platform.ts exists to stop.
  it("lets platform exhaustion propagate instead of escalating it", async () => {
    const writer = new FakeWriter({
      approveWorkflowRun: new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: 1000 },
        new Error("secondary rate limit"),
      ),
    });
    const d = makeDispatcher(writer);
    const item = derivedWi();

    await expect(d.approveChecks(item, RUNS, SAFE)).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
    expect(writer.calls).not.toContain(`assignHumanOnly:${item.id}:U_human`);
    expect(writer.comments).toEqual([]);
  });

  it("reports an ordinary failure as retryable rather than permanent", async () => {
    const writer = new FakeWriter({ approveWorkflowRun: new Error("502 bad gateway") });
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const outcome = await d.approveChecks(item, RUNS, SAFE);

    expect(outcome.action).toBe("partially_approved");
    expect(outcome.failures?.[0]?.message).toContain("502");
    expect(writer.calls).not.toContain(`assignHumanOnly:${item.id}:U_human`);
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
    // Order matters: a bare reassignment is not a transition.
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
      `assignHumanOnly:${item.id}:U_human`,
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
      `assignHumanOnly:${item.id}:U_human`,
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
    await d.integrate(item, p, READY);
    expect(writer.calls).toEqual(["mergePullRequest:PR_ready"]);
  });

  it("un-drafts before merging, because the agent never does", async () => {
    // The agent opens every pull request as a draft and never clears the flag:
    // observed `ReadyForReviewEvent`s are Factory's own token, and a finished
    // pull request can remain a draft.
    // GitHub refuses to merge a draft, so without this call every merge fails.
    // Safe because the completion signal is the `[WIP]` prefix, not draftness
    // (§5.1) — nothing unfinished reaches here.
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const p = pr({ id: "PR_draft", isDraft: true });
    await d.integrate(item, p, READY);
    expect(writer.calls).toEqual([
      "markPullRequestReady:PR_draft",
      "mergePullRequest:PR_draft",
    ]);
  });

  it("waits on unfinished work without closing, retrying or merging it", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const outcome = await d.integrate(
      item,
      pr({ id: "PR_wip", title: "[WIP] Add slugify" }),
      { kind: "in_progress" },
    );
    expect(outcome).toEqual({ merged: false, action: "waiting" });
    // Nothing at all: no merge, and crucially no close/reassign, because the
    // agent is plausibly still writing into this pull request.
    expect(writer.calls).toEqual([]);
  });

  it("waits on checks_pending without writing anything", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const outcome = await d.integrate(item, pr(), { kind: "checks_pending" });
    expect(writer.calls).toEqual([]);
    expect(outcome.merged).toBe(false);
  });

  // Acting on a guess would either merge something conflicting or rebase
  // something clean. GitHub settles this on its own within a cycle.
  it("waits on mergeability_unknown without writing anything", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const outcome = await d.integrate(derivedWi(), pr({ mergeable: "UNKNOWN" }), {
      kind: "mergeability_unknown",
    });
    expect(writer.calls).toEqual([]);
    expect(outcome.merged).toBe(false);
  });

  it("reports a successful merge", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const outcome = await d.integrate(derivedWi(), pr({ isDraft: false }), READY);
    expect(outcome).toEqual({ merged: true, action: "merged" });
  });

  it("escalates a sensitive surface instead of merging or retrying it", async () => {
    // Agents can add files nobody asked for. When the extra file is one that
    // redefines what CI runs, §7.3 makes it a human's call — and retrying would
    // be actively wrong: the work is correct, so a replacement pull request
    // would arrive with the same diff and burn an attempt.
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const outcome = await d.integrate(item, pr({ isDraft: false }), {
      kind: "sensitive_surface",
      files: [{ path: "package-lock.json", reason: "controls the dependency tree" }],
    });

    expect(outcome.merged).toBe(false);
    // Not merged, and above all not closed.
    expect(writer.calls).toEqual([
      `assignHumanOnly:${item.id}:U_human`,
      `addComment:${item.id}`,
    ]);
    expect(writer.comments.join("\n")).toContain("dependency tree");
  });

  it("defers rather than throwing when the base branch moved under the merge", async () => {
    // This happens when a sibling PR merges in the same window. Throwing here
    // invites a Director to read it as the Work Item failing and close a
    // perfectly good pull request.
    const writer = new FakeWriter({
      mergePullRequest: new Error("Base branch was modified. Review and try the merge again."),
    });
    const d = makeDispatcher(writer);
    const outcome = await d.integrate(derivedWi(), pr({ isDraft: false }), READY);

    expect(outcome.merged).toBe(false);
    expect(outcome.deferred).toContain("base branch moved");
    // Critically: no retry, no close, no re-dispatch. The PR stays open.
    expect(writer.calls).toEqual(["mergePullRequest:PR_1"]);
  });

  it("defers while GitHub is still recomputing mergeability", async () => {
    const writer = new FakeWriter({
      mergePullRequest: new Error("Pull Request is not mergeable"),
    });
    const d = makeDispatcher(writer);
    const outcome = await d.integrate(derivedWi(), pr({ isDraft: false }), READY);
    expect(outcome.merged).toBe(false);
    expect(outcome.deferred).toBeTruthy();
  });

  it("still throws a merge refusal that a human must see", async () => {
    // Branch protection, a missing permission, or a required review are not
    // races. Swallowing them would make the loop retry silently forever.
    const writer = new FakeWriter({
      mergePullRequest: new Error("At least 1 approving review is required by reviewers."),
    });
    const d = makeDispatcher(writer);
    await expect(
      d.integrate(derivedWi(), pr({ isDraft: false }), READY),
    ).rejects.toThrow("approving review");
  });

  it("rethrows a platform refusal from the merge rather than deferring it", async () => {
    const writer = new FakeWriter({ mergePullRequest: rateLimitError() });
    const d = makeDispatcher(writer);
    await expect(
      d.integrate(derivedWi(), pr({ isDraft: false }), READY),
    ).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  // The three §6 conflict branches — rebase, close-and-redispatch, escalate —
  // would all look like a bare `{ merged: false }` without `action`. A caller
  // would have to diff the *next* `read_objective` for PR state, which is
  // exactly how a rebase that resolves nothing would hide a repeat forever.
  // `action` is what makes the branch taken visible to the caller (§10).
  it("resolves a conflict by updating the branch when GitHub accepts it", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const p = pr({ id: "PR_conflict" });
    const outcome = await d.integrate(item, p, { kind: "conflict" });
    expect(writer.calls).toEqual(["updatePullRequestBranch:PR_conflict"]);
    expect(outcome.action).toBe("rebased");
  });

  it("closes and re-dispatches when the branch update is rejected as unresolvable", async () => {
    const boom = new Error("merge conflict between base and head");
    const writer = new FakeWriter({ updatePullRequestBranch: boom });
    const d = makeDispatcher(writer);
    const item = derivedWi();
    const p = pr({ id: "PR_conflict" });
    const outcome = await d.integrate(item, p, { kind: "conflict" });
    expect(outcome.action).toBe("redispatched");
    expect(writer.calls).toEqual([
      "updatePullRequestBranch:PR_conflict",
      "addComment:PR_conflict",
      "closePullRequest:PR_conflict",
      `clearActors:${item.id}`,
      `assignCopilot:${item.id}:BOT_1`,
    ]);
  });

  it("stops re-dispatching a conflict once attempts are exhausted, and blames the graph", async () => {
    // Without this bound the conflict path never terminates: a rebase that
    // cannot fix the conflict means the next attempt branches from the same
    // base and conflicts identically, forever.
    const boom = new Error("merge conflict between base and head");
    const writer = new FakeWriter({ updatePullRequestBranch: boom });
    const d = makeDispatcher(writer);
    const item = derivedWi({
      linkedPullRequests: [pr({ id: "PR_1" }), pr({ id: "PR_2" }), pr({ id: "PR_3" })],
    });
    const outcome = await d.integrate(item, pr({ id: "PR_3" }), { kind: "conflict" });

    expect(outcome.action).toBe("escalated");
    expect(writer.calls).toEqual([
      "updatePullRequestBranch:PR_3",
      `assignHumanOnly:${item.id}:U_human`,
      `addComment:${item.id}`,
    ]);
    expect(writer.calls.some((c) => c.startsWith("assignCopilot"))).toBe(false);
    expect(writer.comments.join("\n")).toContain("replan");
  });

  it("still re-dispatches a conflict while attempts remain", async () => {
    const boom = new Error("merge conflict between base and head");
    const writer = new FakeWriter({ updatePullRequestBranch: boom });
    const d = makeDispatcher(writer);
    const item = derivedWi({ linkedPullRequests: [pr({ id: "PR_1" }), pr({ id: "PR_2" })] });
    await d.integrate(item, pr({ id: "PR_2" }), { kind: "conflict" });

    expect(writer.calls).toContain(`assignCopilot:${item.id}:BOT_1`);
  });

  it("does not consume an attempt when the rebase succeeds", async () => {
    // A successful rebase opens no new pull request, so an item that keeps
    // rebasing cleanly must never be escalated for exhausting attempts.
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({
      linkedPullRequests: [pr({ id: "PR_1" }), pr({ id: "PR_2" }), pr({ id: "PR_3" })],
    });
    await d.integrate(item, pr({ id: "PR_3" }), { kind: "conflict" });

    expect(writer.calls).toEqual(["updatePullRequestBranch:PR_3"]);
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

  // Held CI must never cost the work: a replacement pull request is held
  // identically, so a retry cannot succeed and only discards a correct diff
  // (§9).
  it("escalates held checks instead of closing the pull request", async () => {
    const writer = new FakeWriter();
    const d = makeDispatcher(writer);
    const item = derivedWi({ linkedPullRequests: [pr({ id: "PR_held" })] });
    const outcome = await d.integrate(
      item,
      pr({ id: "PR_held", checks: "FAILURE", checksNeverStarted: true }),
      { kind: "checks_held" },
    );
    expect(outcome).toEqual({ merged: false, action: "escalated" });
    expect(writer.calls).toEqual([
      `assignHumanOnly:${item.id}:U_human`,
      `addComment:${item.id}`,
    ]);
    expect(writer.calls).not.toContain("closePullRequest:PR_held");
    const comment = writer.comments.join("\n");
    expect(comment).toContain("Approve and run workflows");
    expect(comment).toContain("fork-only");
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
