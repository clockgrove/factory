/**
 * Dispatch and integration: assign, confirm, retry, escalate (§4), then merge
 * and close (§6) once a PR clears `evaluate.ts`'s mechanical checks.
 *
 * Two layers, deliberately kept apart:
 *
 *   - Pure decision functions (`confirmAction`, `attemptAction`) take a
 *     derived Work Item and the snapshot's `now` and return what to do. No
 *     I/O, so the decision boundaries are unit-tested without a network.
 *   - `Dispatcher` performs the GitHub writes those decisions call for. Every
 *     one is routed through `platform.ts`'s `CircuitBreaker`,
 *     `ContentCreationPacer`, and `ConcurrencyLimiter` (Finding 4; GitHub's
 *     own rate-limit guidance) — no call site may reach the network directly.
 *
 * Nothing here stores a retry count. §4.2's "on second confirm failure,
 * escalate" is answered by `confirmFailureStreak` (state.ts), recomputed
 * fresh from the assignment timeline every cycle. That keeps a Dispatcher
 * restart from ever losing or duplicating a retry decision (§1) — the same
 * guarantee `state.ts` already gives the rest of the state machine.
 *
 * `Dispatcher`'s writes are also deliberately ordered so a call failing
 * partway through never leaves a Work Item in a state nothing can recover
 * from — see the comments on `#escalate` and `confirm`'s retry branch. A
 * partial failure just makes the next cycle redo (part of) the same step,
 * which is safe because every write here is either idempotent or reduces to
 * a state `ready()`/`confirm()` already knows how to handle from scratch.
 *
 * Integration (§6, `integrate()`) reuses that same "no stored retry state"
 * discipline: a merge conflict is resolved or rejected inline, in the same
 * cycle it is observed, by attempting `updatePullRequestBranch` once and
 * closing/re-dispatching on failure — never by remembering "we already tried
 * this PR once" across cycles.
 */

import { Octokit } from "@octokit/core";

import type { MechanicalVerdict } from "./evaluate.js";
import type { BlastRadiusVerdict } from "./approval.js";
import {
  createOctokit,
  type GitHubOptions,
  type PendingApprovalRun,
} from "./github.js";

/** Result of `Dispatcher.approveChecks`, reported verbatim to Director. */
export interface ApprovalOutcome {
  action: "approved" | "partially_approved" | "escalated" | "no_runs_held";
  approvedRunIds: number[];
  /** Present only when the review declined; the reasons it declined. */
  blockers?: string[];
}
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  PlatformUnavailableError,
  classifyRefusal,
} from "./platform.js";
import {
  attemptCount,
  confirmFailureStreak,
  currentOpenPullRequest,
  withinConfirmWindow,
} from "./state.js";
import type { DerivedWorkItem } from "./state.js";
import type { LinkedPullRequest } from "./types.js";

/**
 * What to do about a Work Item sitting in `dispatched` state (§4.2).
 *
 *  - `wait`: still inside the 90s confirm window; a real session may yet
 *    produce a PR (measured assignment→draft-PR latency was 3–7s).
 *  - `retry`: the window elapsed with zero PRs, and this is the first such
 *    failure for the current assignment. Unassign and reassign — the
 *    platform only starts a fresh session on an actual assignment
 *    *transition* (PRD F8), not a repeated assignment.
 *  - `escalate`: this is the second consecutive PR-less assignment. §4.2
 *    caps the confirm mechanism at one retry.
 */
export function confirmAction(
  wi: DerivedWorkItem,
  now: Date,
): "wait" | "retry" | "escalate" {
  if (withinConfirmWindow(wi, now)) return "wait";
  return confirmFailureStreak(wi) >= 2 ? "escalate" : "retry";
}

/**
 * What to do about a Work Item sitting in `failed` state (§4.4): an open PR
 * that turned out to be a no-op once the confirm window elapsed.
 */
export function attemptAction(wi: DerivedWorkItem): "retry" | "escalate" {
  return attemptCount(wi) >= 3 ? "escalate" : "retry";
}

/**
 * The GraphQL mutations `Dispatcher` needs, each verified against the
 * current schema (docs.github.com/en/graphql/reference/input-objects,
 * 2026-08-30) except where noted.
 *
 * `replaceActorsForAssignable`/`agentAssignment` was confirmed live in an
 * earlier session (PRD F8). `addAssigneesToAssignable`, `addComment`, and
 * `closePullRequest` were each confirmed live this session too (2026-08-31,
 * against clockgrove/factory-gate0, ahead of Gate 0 itself) — every mutation
 * this file's escalate/retry paths depend on has now actually been exercised
 * against a real repository, not just verified against docs.
 */
const COPILOT_ASSIGNMENT_HEADERS = {
  "GraphQL-Features":
    "issues_copilot_assignment_api_support,coding_agent_model_selection",
};

const ASSIGN_COPILOT_MUTATION = `
mutation AssignCopilot($assignableId: ID!, $botId: ID!, $repositoryId: ID!, $baseRef: String!) {
  replaceActorsForAssignable(input: {
    assignableId: $assignableId
    actorIds: [$botId]
    agentAssignment: { targetRepositoryId: $repositoryId, baseRef: $baseRef }
  }) {
    clientMutationId
  }
}`;

const CLEAR_ACTORS_MUTATION = `
mutation ClearActors($assignableId: ID!) {
  replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: [] }) {
    clientMutationId
  }
}`;

const ADD_HUMAN_ASSIGNEE_MUTATION = `
mutation AddAssignee($assignableId: ID!, $userId: ID!) {
  addAssigneesToAssignable(input: { assignableId: $assignableId, assigneeIds: [$userId] }) {
    clientMutationId
  }
}`;

const ADD_COMMENT_MUTATION = `
mutation AddComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    clientMutationId
  }
}`;

const CLOSE_PULL_REQUEST_MUTATION = `
mutation ClosePullRequest($pullRequestId: ID!) {
  closePullRequest(input: { pullRequestId: $pullRequestId }) {
    clientMutationId
  }
}`;

/**
 * Closes the Objective issue itself once every Work Item is `done` (§4,
 * Gate 0 finding: GitHub does not auto-close a parent issue just because all
 * its sub-issues closed — `subIssuesSummary` reaching 100% on a live
 * Objective left it OPEN with an empty `closedByPullRequestsReferences`,
 * confirmed 2026-09-01 against clockgrove/factory-gate0#6. `CloseIssueInput`
 * and its `stateReason` enum (`COMPLETED`/`NOT_PLANNED`/`DUPLICATE`) verified
 * live via GraphQL introspection the same day.
 */
const CLOSE_ISSUE_MUTATION = `
mutation CloseIssue($issueId: ID!) {
  closeIssue(input: { issueId: $issueId, stateReason: COMPLETED }) {
    clientMutationId
  }
}`;

/**
 * Integration mutations (§6), verified against
 * docs.github.com/en/graphql/reference/pulls (2026-08-30). Not yet exercised
 * live — same known gap noted above for the retry/escalate mutations.
 */
const MARK_READY_FOR_REVIEW_MUTATION = `
mutation MarkReady($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    clientMutationId
  }
}`;

const MERGE_PULL_REQUEST_MUTATION = `
mutation MergePullRequest($pullRequestId: ID!) {
  mergePullRequest(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
    clientMutationId
  }
}`;

/**
 * `updatePullRequestBranch`'s payload carries no success flag (verified live
 * against the schema, 2026-08-30) — only `pullRequest`/`clientMutationId`.
 * Whether the update actually resolved anything is read back on the *next*
 * cycle's snapshot (`mergeable` recomputed); a thrown error here is the only
 * same-cycle signal that GitHub could not apply it at all (§6).
 */
const UPDATE_PULL_REQUEST_BRANCH_MUTATION = `
mutation UpdatePullRequestBranch($pullRequestId: ID!) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId }) {
    clientMutationId
  }
}`;

/**
 * The GitHub write surface `Dispatcher` needs. An interface, not a concrete
 * class, so `Dispatcher`'s own tests inject a fake and never touch the
 * network (see `test/dispatch.test.ts`). `GithubOctokitWriter` below is the
 * real implementation.
 */
export interface GitHubWriter {
  /** Set the coding agent as the issue's sole actor — triggers a session. */
  assignCopilot(args: {
    issueId: string;
    botId: string;
    repositoryId: string;
    baseRef: string;
  }): Promise<void>;
  /**
   * Remove every actor. Not optional cleanup: a bare reassignment onto an
   * already-assigned issue is not a transition, and only a transition is
   * measured to trigger a fresh session (PRD F8).
   */
  clearActors(issueId: string): Promise<void>;
  /** Add a human assignee via the standard, non-preview assignment mutation. */
  addHumanAssignee(issueId: string, userId: string): Promise<void>;
  addComment(subjectId: string, body: string): Promise<void>;
  closePullRequest(pullRequestId: string): Promise<void>;
  /** §4: close the Objective issue itself once every Work Item is `done`. */
  closeIssue(issueId: string): Promise<void>;
  /** Convert a draft PR to ready-for-review; a precondition for merging (§6). */
  markPullRequestReady(pullRequestId: string): Promise<void>;
  /** Squash-merge. GitHub auto-closes the linked issue (§6, PROBE-001 §12). */
  mergePullRequest(pullRequestId: string): Promise<void>;
  /**
   * Merge the base branch into the PR branch (§6's "attempt rebase"). Throws
   * if GitHub cannot apply it — a real conflict, not merely being behind.
   */
  updatePullRequestBranch(pullRequestId: string): Promise<void>;
  /**
   * Approve a workflow run held in `action_required` (§10.6). The API
   * equivalent of a maintainer clicking "Approve and run workflows"; valid only
   * on a held run.
   */
  approveWorkflowRun(runId: number): Promise<void>;
}

/** `GitHubWriter` backed by a real Octokit GraphQL client. */
export class GithubOctokitWriter implements GitHubWriter {
  readonly #octokit: Octokit;
  readonly #owner: string;
  readonly #repo: string;

  constructor(opts: GitHubOptions) {
    this.#octokit = createOctokit(opts);
    this.#owner = opts.owner;
    this.#repo = opts.repo;
  }

  async assignCopilot(args: {
    issueId: string;
    botId: string;
    repositoryId: string;
    baseRef: string;
  }): Promise<void> {
    await this.#octokit.graphql(ASSIGN_COPILOT_MUTATION, {
      assignableId: args.issueId,
      botId: args.botId,
      repositoryId: args.repositoryId,
      baseRef: args.baseRef,
      headers: COPILOT_ASSIGNMENT_HEADERS,
    });
  }

  async clearActors(issueId: string): Promise<void> {
    await this.#octokit.graphql(CLEAR_ACTORS_MUTATION, {
      assignableId: issueId,
      headers: COPILOT_ASSIGNMENT_HEADERS,
    });
  }

  async addHumanAssignee(issueId: string, userId: string): Promise<void> {
    await this.#octokit.graphql(ADD_HUMAN_ASSIGNEE_MUTATION, {
      assignableId: issueId,
      userId,
    });
  }

  async addComment(subjectId: string, body: string): Promise<void> {
    await this.#octokit.graphql(ADD_COMMENT_MUTATION, { subjectId, body });
  }

  async closePullRequest(pullRequestId: string): Promise<void> {
    await this.#octokit.graphql(CLOSE_PULL_REQUEST_MUTATION, {
      pullRequestId,
    });
  }

  async closeIssue(issueId: string): Promise<void> {
    await this.#octokit.graphql(CLOSE_ISSUE_MUTATION, { issueId });
  }

  async markPullRequestReady(pullRequestId: string): Promise<void> {
    await this.#octokit.graphql(MARK_READY_FOR_REVIEW_MUTATION, {
      pullRequestId,
    });
  }

  async mergePullRequest(pullRequestId: string): Promise<void> {
    await this.#octokit.graphql(MERGE_PULL_REQUEST_MUTATION, {
      pullRequestId,
    });
  }

  async updatePullRequestBranch(pullRequestId: string): Promise<void> {
    await this.#octokit.graphql(UPDATE_PULL_REQUEST_BRANCH_MUTATION, {
      pullRequestId,
    });
  }

  async approveWorkflowRun(runId: number): Promise<void> {
    // REST-only: there is no GraphQL mutation for run approval.
    await this.#octokit.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
      { owner: this.#owner, repo: this.#repo, run_id: runId },
    );
  }
}

export interface DispatcherOptions {
  writer: GitHubWriter;
  repositoryId: string;
  copilotBotId: string;
  defaultBranch: string;
  /** Node ID of the human to escalate to (§7.2), resolved once at startup. */
  escalateToId: string;
  onThrottle?: (message: string) => void;
  circuitBreaker?: CircuitBreaker;
  pacer?: ContentCreationPacer;
  concurrency?: ConcurrencyLimiter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Dispatcher {
  readonly #writer: GitHubWriter;
  readonly #repositoryId: string;
  readonly #copilotBotId: string;
  readonly #defaultBranch: string;
  readonly #escalateToId: string;
  readonly #notify: (message: string) => void;
  readonly #breaker: CircuitBreaker;
  readonly #pacer: ContentCreationPacer;
  readonly #concurrency: ConcurrencyLimiter;

  constructor(opts: DispatcherOptions) {
    this.#writer = opts.writer;
    this.#repositoryId = opts.repositoryId;
    this.#copilotBotId = opts.copilotBotId;
    this.#defaultBranch = opts.defaultBranch;
    this.#escalateToId = opts.escalateToId;
    this.#notify = opts.onThrottle ?? (() => {});
    this.#breaker = opts.circuitBreaker ?? new CircuitBreaker();
    this.#pacer = opts.pacer ?? new ContentCreationPacer();
    this.#concurrency = opts.concurrency ?? new ConcurrencyLimiter();
  }

  /** True once the circuit has tripped repeatedly enough to need a human (§7.3). */
  exhausted(): boolean {
    return this.#breaker.exhausted();
  }

  /** §4: dispatch a ready Work Item for the first time. */
  async start(wi: DerivedWorkItem): Promise<void> {
    await this.#assign(wi.id);
  }

  /** §4.2: check a dispatched Work Item and act per `confirmAction`. */
  async confirm(wi: DerivedWorkItem, now: Date): Promise<void> {
    const action = confirmAction(wi, now);
    if (action === "wait") return;

    if (action === "escalate") {
      await this.#escalate(
        wi,
        "two consecutive assignments produced no pull request",
      );
      return;
    }

    // Retry: clear first, then reassign. If reassignment then fails (e.g. a
    // platform refusal), the Work Item is left unassigned — which `derive()`
    // reads back as `unstarted`, so the next cycle's `ready()`/`start()`
    // simply redispatches it. No stuck state, no duplicate work.
    await this.#call(() => this.#writer.clearActors(wi.id));
    await this.#assign(wi.id);
  }

  /**
   * §4.4 / §5.1: the current attempt was judged unusable — a no-op, a
   * decline, a diff outside the declared scope, or failed checks. Retry or
   * escalate. `reason` is surfaced in both the escalation comment (§7.2) and
   * the close comment, so the log answers "what did Director believe and
   * why" (§10) without needing to store which mechanical check fired.
   */
  async retryOrEscalate(
    wi: DerivedWorkItem,
    reason = "no diff appeared before the confirm window elapsed",
  ): Promise<void> {
    if (attemptAction(wi) === "escalate") {
      await this.#escalate(
        wi,
        `${attemptCount(wi)} attempts produced no usable result (${reason})`,
      );
      return;
    }

    const current = currentOpenPullRequest(wi);
    if (current) {
      // Comment before closing: if closing then fails, the retry is only
      // reattempted next cycle (the PR is still open and no-op, so the Work
      // Item is still `failed`) — a duplicate comment is noise, never harm.
      await this.#call(() =>
        this.#writer.addComment(current.id, `Closing: ${reason} (§4.4/§5.1). Retrying.`),
      );
      await this.#call(() => this.#writer.closePullRequest(current.id));
    }

    await this.#call(() => this.#writer.clearActors(wi.id));
    await this.#assign(wi.id);
  }

  /**
   * §6: act on `evaluate.ts`'s mechanical verdict for a Work Item's current
   * PR. Only meaningful once the Work Item is `for_review` (a real diff with
   * settled checks) — `no_op`/`declined` cannot occur there (state.ts already
   * routes those to `failed` before this is ever called), but are handled
   * defensively rather than assumed unreachable.
   */
  async integrate(
    wi: DerivedWorkItem,
    pr: LinkedPullRequest,
    verdict: MechanicalVerdict,
  ): Promise<void> {
    switch (verdict.kind) {
      case "ready":
        await this.#mergeReady(pr);
        return;
      case "conflict":
        await this.#resolveConflict(wi, pr);
        return;
      case "untouched":
        await this.retryOrEscalate(
          wi,
          "the diff did not touch the Work Item's declared file scope",
        );
        return;
      case "checks_failed":
        await this.retryOrEscalate(
          wi,
          pr.checksNeverStarted
            ? "CI concluded without running a single job. On a pull request authored by " +
              "the coding agent this normally means workflow runs were held awaiting a " +
              "maintainer's 'Approve and run workflows' click and were then cancelled, " +
              "not that a test failed. Call `approve_held_workflow_runs` while the pull " +
              "request is open rather than retrying — a retry produces a fresh pull " +
              "request whose runs are held in exactly the same way"
            : "required checks failed",
        );
        return;
      case "declined":
        await this.retryOrEscalate(
          wi,
          "the agent declined the task as not actionable",
        );
        return;
      case "no_op":
        await this.retryOrEscalate(wi);
        return;
      case "checks_pending":
        return; // wait for the next cycle; nothing to do yet
      case "checks_missing":
        // The repository runs CI on pull requests but this PR carries no checks
        // at all (§10.5, F1). Usually a timing race that resolves within a
        // cycle, so waiting is right — but if it persists, the repository's CI
        // is failing to attach checks (e.g. a workflow that fails at startup
        // produces zero jobs and therefore zero checks) and no amount of waiting
        // will fix it. That is a human problem, not a Work Item problem, so it
        // is deliberately never auto-merged and never auto-retried; the Director
        // skill escalates it after it survives several cycles.
        return;
    }
  }

  /** §6: "mark ready → checks green → squash merge → issue auto-closes". */
  async #mergeReady(pr: LinkedPullRequest): Promise<void> {
    if (pr.isDraft) {
      await this.#call(() => this.#writer.markPullRequestReady(pr.id));
    }
    await this.#call(() => this.#writer.mergePullRequest(pr.id));
  }

  /**
   * §6: "attempt rebase; if clean, proceed; if not, close the PR and
   * re-dispatch against the new base." `updatePullRequestBranch`'s payload
   * carries no success flag (verified live against the schema, 2026-08-30),
   * so a thrown, non-refusal error is the only same-cycle signal that GitHub
   * could not apply it — a genuine content conflict, not merely being
   * behind. A refusal (rate limit, etc.) is rethrown rather than treated as
   * an unresolvable conflict, so platform pacing is never mistaken for a
   * graph defect.
   *
   * Unmeasured live: Gate 0's Work Items are independent by design (PRD §7),
   * so this path has not yet been exercised against a real conflicting PR.
   */
  async #resolveConflict(
    wi: DerivedWorkItem,
    pr: LinkedPullRequest,
  ): Promise<void> {
    try {
      await this.#call(() => this.#writer.updatePullRequestBranch(pr.id));
      // Success: the branch was updated. The next cycle's snapshot rereads
      // `mergeable`; if it is now MERGEABLE, `integrate()` proceeds normally,
      // and if GitHub still reports CONFLICTING, this method runs again.
    } catch (error) {
      if (error instanceof PlatformUnavailableError) throw error;
      await this.#call(() =>
        this.#writer.addComment(
          pr.id,
          "Closing: could not automatically resolve a merge conflict against the base branch (§6). Re-dispatching.",
        ),
      );
      await this.#call(() => this.#writer.closePullRequest(pr.id));
      await this.#call(() => this.#writer.clearActors(wi.id));
      await this.#assign(wi.id);
    }
  }

  /**
   * §4: close the Objective issue once `allDone()` (state.ts) confirms every
   * Work Item is `done`. Routed through `#call` like every other write here
   * — same breaker/pacer/concurrency discipline, no special case.
   */
  async closeObjective(objectiveId: string): Promise<void> {
    await this.#call(() => this.#writer.closeIssue(objectiveId));
  }

  async #assign(issueId: string): Promise<void> {
    await this.#call(() =>
      this.#writer.assignCopilot({
        issueId,
        botId: this.#copilotBotId,
        repositoryId: this.#repositoryId,
        baseRef: this.#defaultBranch,
      }),
    );
  }

  /**
   * §7.2. Ordered so a partial failure is always safely re-driven by a later
   * cycle: adding the human first is idempotent if repeated; if clearing
   * Copilot then fails, the Work Item still reads as `dispatched` (Copilot
   * remains an assignee) with an unchanged, already-past-window assignment
   * history, so `confirm()` calls `#escalate` again next cycle rather than
   * silently reverting to "unstarted". The comment goes last: if it never
   * lands, the escalation itself still took effect (`derive()` reads
   * Copilot-absent + human-present as `escalated`), which the loop stops
   * revisiting — an acceptable, visible degradation rather than a stuck loop.
   */
  /**
   * §10.6: decide whether to approve workflow runs that GitHub is holding, and
   * act on that decision.
   *
   * GitHub parks runs on coding-agent pull requests in `action_required` until
   * a maintainer clicks "Approve and run workflows". Left alone this deadlocks
   * Factory: the evaluator correctly reports `checks_pending` forever, because
   * the checks genuinely never arrive. Merging anyway is worse — it is the
   * CI-bypass this whole area exists to prevent.
   *
   * So Factory makes the call itself, but only behind a blast-radius review
   * (`assessBlastRadius`) proving that approving cannot escalate privilege
   * beyond "run the tests". The verdict is computed by the caller and passed in
   * whole, so this method is purely the act-and-record half.
   *
   * Both outcomes are written down on the Work Item. An approval is a decision
   * a human would otherwise have made by hand, so the reasoning has to survive
   * in the record rather than only in Director's context.
   */
  async approveChecks(
    wi: DerivedWorkItem,
    runs: PendingApprovalRun[],
    verdict: BlastRadiusVerdict,
  ): Promise<ApprovalOutcome> {
    if (runs.length === 0) {
      return { action: "no_runs_held", approvedRunIds: [] };
    }

    if (!verdict.safe) {
      await this.#escalate(
        wi,
        `workflow runs are held awaiting approval, and the blast-radius review declined to approve them automatically: ${verdict.blockers.join("; ")}`,
      );
      return { action: "escalated", approvedRunIds: [], blockers: verdict.blockers };
    }

    const approvedRunIds: number[] = [];
    let failure: unknown;
    for (const run of runs) {
      try {
        await this.#call(() => this.#writer.approveWorkflowRun(run.id));
        approvedRunIds.push(run.id);
      } catch (error) {
        // Stop, but do not throw past the record below. Approval is
        // irreversible: any run already approved is running now, and the next
        // cycle will not see it as held, so if the throw escaped here those
        // approvals would exist with no trace on the Work Item and Director
        // would believe nothing had been approved.
        failure = error;
        break;
      }
    }

    const record = [
      approvedRunIds.length > 0
        ? `Approved ${approvedRunIds.length} held workflow run(s) so CI can execute (§10.6).`
        : "Attempted to approve held workflow runs (§10.6); none were approved.",
      "",
      "GitHub holds workflow runs on coding-agent pull requests until a maintainer approves them. Blast-radius review passed before approving:",
      ...verdict.assurances.map((a) => `- ${a}`),
      "",
      `Runs considered: ${runs.map((r) => `${r.name} (#${r.id})`).join(", ")}.`,
      approvedRunIds.length > 0 ? `Approved: ${approvedRunIds.join(", ")}.` : "",
      failure
        ? `Stopped early: ${failure instanceof Error ? failure.message : String(failure)}. Remaining runs are still held and will be retried next cycle.`
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
    await this.#call(() => this.#writer.addComment(wi.id, record));

    return {
      action: failure ? "partially_approved" : "approved",
      approvedRunIds,
    };
  }

  async #escalate(wi: DerivedWorkItem, reason: string): Promise<void> {
    await this.#call(() =>
      this.#writer.addHumanAssignee(wi.id, this.#escalateToId),
    );
    await this.#call(() => this.#writer.clearActors(wi.id));
    await this.#call(() =>
      this.#writer.addComment(wi.id, `Escalating to a human: ${reason} (§7.2).`),
    );
  }

  /**
   * Routes one mutating call through the breaker, pacer, and concurrency
   * limiter (Finding 4) — the same discipline for every write this class
   * makes, so no call site can bypass it by accident.
   */
  async #call(fn: () => Promise<void>): Promise<void> {
    if (this.#breaker.isOpen()) {
      const wait = this.#breaker.waitMs();
      this.#notify(`circuit open; waiting ${wait}ms before the next call`);
      await sleep(wait);
    }

    const pacerWait = this.#pacer.waitMs();
    if (pacerWait > 0) await sleep(pacerWait);

    const release = await this.#concurrency.acquire();
    try {
      await fn();
      this.#pacer.recordCall();
      this.#breaker.recordSuccess();
    } catch (error) {
      const refusal = classifyRefusal(error);
      if (refusal.kind === "not_refusal") throw error;
      this.#breaker.recordRefusal(refusal);
      throw new PlatformUnavailableError(refusal, error);
    } finally {
      release();
    }
  }
}
