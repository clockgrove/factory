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
  action:
    | "approved"
    | "partially_approved"
    | "not_approvable"
    | "escalated"
    | "no_runs_held";
  approvedRunIds: number[];
  /** Present only when the review declined; the reasons it declined. */
  blockers?: string[];
  /**
   * Every run that was held and did not get approved, with GitHub's own reason.
   *
   * Reporting only `approvedRunIds` made a total failure look like a success:
   * Gate 4 saw `{action: "partially_approved", approvedRunIds: []}` with one run
   * held and no error anywhere, and could only detect the failure by comparing
   * two arrays. GitHub's message is the diagnosis, so it has to reach the caller.
   */
  failures?: { runId: number; message: string }[];
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

/** The result of one `integrate` call, so a caller can tell a merge from a wait. */
export interface IntegrateOutcome {
  merged: boolean;
  /** Set when a merge was attempted and GitHub declined for a transient reason. */
  deferred?: string;
}

/**
 * Merge refusals that mean "not right now" rather than "not ever".
 *
 * Matched on message text because GitHub returns these through GraphQL, where
 * there is no distinguishing status code — a `GraphqlResponseError` carries no
 * numeric `status`, so `classifyRefusal` correctly reports `not_refusal` and
 * the error would otherwise propagate as a hard failure.
 *
 * Kept to an explicit list rather than a catch-all: a merge that fails because
 * of branch protection, a missing permission, or a required review is a real
 * problem a human must see, and swallowing it would make the loop retry
 * silently forever.
 */
const MERGE_DEFERRALS: ReadonlyArray<readonly [needle: string, because: string]> = [
  [
    "base branch was modified",
    "the base branch moved between GitHub computing mergeability and the merge itself, " +
      "which happens when a sibling pull request merges in the same window",
  ],
  [
    "head branch was modified",
    "the agent pushed to the branch between the snapshot and the merge",
  ],
  [
    "not mergeable",
    "GitHub had not finished recomputing mergeability when the merge was attempted",
  ],
  [
    "base branch modified",
    "the base branch moved between GitHub computing mergeability and the merge itself",
  ],
];

export function mergeDeferral(error: unknown): string | null {
  const message = (error as { message?: string } | null)?.message?.toLowerCase() ?? "";
  if (message === "") return null;
  for (const [needle, because] of MERGE_DEFERRALS) {
    if (message.includes(needle)) return because;
  }
  return null;
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

/**
 * Escalation (§7.2) must leave the human as the *only* assignee, in one write.
 *
 * `addAssigneesToAssignable` followed by `clearActors` looks equivalent and is
 * not: "actors" and "assignees" are one list on GitHub, so `actorIds: []`
 * removes the human that was just added along with Copilot. That left the Work
 * Item with no assignees at all, which `deriveState` reads as `unstarted`
 * (or `failed`, if the pull request is still open) rather than the terminal
 * `escalated` — so the loop re-dispatched the item to Copilot on the very next
 * cycle instead of stopping for a human. The safety valve inverted into an
 * infinite retry.
 *
 * A single replace expresses the actual intent — "Copilot off, human on" — and
 * has no intermediate state to be interrupted in.
 */
const ASSIGN_HUMAN_ONLY_MUTATION = `
mutation AssignHumanOnly($assignableId: ID!, $userId: ID!) {
  replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: [$userId] }) {
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
  /**
   * Make the human the sole assignee, replacing Copilot in the same write.
   *
   * Deliberately not "add the human": actors and assignees are one list, so an
   * add followed by a clear removes the human too (see
   * `ASSIGN_HUMAN_ONLY_MUTATION`), and a bare add would leave Copilot assigned,
   * which `deriveState` reads as `dispatched` rather than `escalated`.
   */
  assignHumanOnly(issueId: string, userId: string): Promise<void>;
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

  async assignHumanOnly(issueId: string, userId: string): Promise<void> {
    await this.#octokit.graphql(ASSIGN_HUMAN_ONLY_MUTATION, {
      assignableId: issueId,
      userId,
      headers: COPILOT_ASSIGNMENT_HEADERS,
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
    //
    // This covers *fork* pull requests only. It is kept because that case is
    // real, but it cannot release the hold Factory actually meets on a
    // coding-agent branch — see §10.7, and note that the repository setting
    // which governs that hold is readable over REST and not writable, so there
    // is deliberately no second call attempted here.
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
  ): Promise<IntegrateOutcome> {
    switch (verdict.kind) {
      case "ready":
        return await this.#mergeReady(pr);
      case "conflict":
        await this.#resolveConflict(wi, pr);
        return { merged: false };
      case "untouched":
        await this.retryOrEscalate(
          wi,
          "the diff did not touch the Work Item's declared file scope",
        );
        return { merged: false };
      case "checks_failed":
        await this.retryOrEscalate(wi, "required checks failed");
        return { merged: false };
      case "checks_held":
        // GitHub held this pull request's workflow runs awaiting a maintainer's
        // "Approve and run workflows", and there is no API that clears this
        // hold class: `POST /actions/runs/{id}/approve` is scoped to fork pull
        // requests and refuses a coding-agent branch outright with "This run is
        // not from a fork pull request or queued by the Actions bot" (observed
        // live in Gate 4, §10.7). Only a human with write access can release it,
        // or the repository's Copilot workflow-approval setting must be turned
        // off up front.
        //
        // So this escalates rather than retrying or waiting. Retrying would
        // close good work and produce an identically-held pull request; waiting
        // would wait forever, because nothing in the loop can change the
        // outcome. A human is genuinely required, which is what `escalated`
        // means.
        await this.#escalate(
          wi,
          "CI never ran: GitHub is holding this pull request's workflow runs awaiting a " +
            "maintainer's 'Approve and run workflows'. No API can release a coding-agent " +
            "hold (the approve endpoint is fork-only), so Factory cannot clear it and " +
            "must not merge without CI evidence. Either approve the runs on the pull " +
            "request, or disable the repository's Copilot Actions workflow-approval " +
            "requirement so future Work Items are not blocked the same way",
        );
        return { merged: false };
      case "declined":
        await this.retryOrEscalate(
          wi,
          "the agent declined the task as not actionable",
        );
        return { merged: false };
      case "no_op":
        await this.retryOrEscalate(wi);
        return { merged: false };
      case "checks_pending":
        return { merged: false }; // wait for the next cycle; nothing to do yet
      case "mergeability_unknown":
        // GitHub has not finished computing mergeability. Waiting is the whole
        // response: there is nothing to act on, and acting on a guess would
        // either merge something conflicting or rebase something clean.
        return { merged: false };
      case "checks_missing":
        // The repository runs CI on pull requests but this PR carries no checks
        // at all (§10.5, F1). Usually a timing race that resolves within a
        // cycle, so waiting is right — but if it persists, the repository's CI
        // is failing to attach checks (e.g. a workflow that fails at startup
        // produces zero jobs and therefore zero checks) and no amount of waiting
        // will fix it. That is a human problem, not a Work Item problem, so it
        // is deliberately never auto-merged and never auto-retried; the Director
        // skill escalates it after it survives several cycles.
        return { merged: false };
    }
  }

  /**
   * §6: "mark ready → checks green → squash merge → issue auto-closes".
   *
   * GitHub refuses a merge whose base moved between the mergeability
   * computation and the merge itself, with "Base branch was modified. Review
   * and try the merge again." Observed live in Gate 3 (§10.5) when a sibling
   * pull request merged in the same window. That is a benign race, not a
   * failure: nothing is wrong with this pull request, and the next cycle
   * re-reads and merges it. Letting it escape as a thrown tool error invites
   * the exact misreading it caused in Gate 3 — a Director that treats a throw
   * from `dispatch_integrate` as the Work Item failing would close a perfectly
   * good pull request and re-dispatch it.
   *
   * Deferring is safe for the whole family of "not right now" merge refusals,
   * including a mergeability recompute still in flight, because deferring
   * decides nothing: the next cycle re-derives state and re-evaluates from a
   * fresh snapshot, so a race resolves into a merge and a genuine conflict
   * resolves into `conflict` and the §6 rebase path. Anything not recognised
   * here is still thrown, so a real permission or branch-protection failure
   * surfaces instead of being retried silently forever.
   */
  async #mergeReady(pr: LinkedPullRequest): Promise<IntegrateOutcome> {
    if (pr.isDraft) {
      await this.#call(() => this.#writer.markPullRequestReady(pr.id));
    }
    try {
      await this.#call(() => this.#writer.mergePullRequest(pr.id));
    } catch (error) {
      if (error instanceof PlatformUnavailableError) throw error;
      const deferral = mergeDeferral(error);
      if (!deferral) throw error;
      return { merged: false, deferred: deferral };
    }
    return { merged: true };
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
   * Re-dispatch is bounded by the same attempt count as every other retry
   * (§4.4). Without that bound this path never terminates: a conflict that a
   * rebase cannot fix is almost always a *graph* defect rather than a bad
   * attempt — two Work Items editing one file with no edge between them — so
   * the agent's next attempt branches from the same base and conflicts the
   * same way, forever, burning an agent run and a pull request each cycle.
   * §6 names the correct exit ("repeated conflict on one file ⇒ the graph
   * wrongly modelled two items as independent ⇒ replan"), and escalating with
   * that diagnosis is how a human is told to replan.
   *
   * Measured live at last (Gate 5, `factory-gate2` #22, 2026-09-02). Three Work
   * Items were deliberately compiled with overlapping scope — each had to create
   * the same new `src/index.ts` barrel — with no edges between them, producing a
   * guaranteed add/add conflict. The first merged; the other two then hit this
   * method, and **`updatePullRequestBranch` threw**. So the catch below is the
   * branch a real content conflict takes, and it is bounded. Both pull requests
   * were closed with the audit comment and re-dispatched, and because the base
   * had by then moved to include the barrel, the replacement attempts modified
   * the existing file instead of creating it — the conflict resolved itself in
   * one retry, exactly as §6 intends.
   *
   * That measurement also settles the success path, which had looked unbounded.
   * It is unbounded, and that is correct rather than a defect: GitHub refuses
   * the mutation outright when the merge would conflict, so success means the
   * conflict is gone. For this method to run again the base must have moved
   * *again* between the update and the next read — in which case rebasing again
   * is the right response, each pass does real work against a genuinely newer
   * base, and it terminates as soon as the base stops moving. The loop only
   * persists while the repository is under continuous merge, consumes no
   * attempt, opens no pull request, and its writes are paced by the same
   * breaker as everything else. A counter here would abort legitimate work.
   */
  async #resolveConflict(
    wi: DerivedWorkItem,
    pr: LinkedPullRequest,
  ): Promise<void> {
    try {
      await this.#call(() => this.#writer.updatePullRequestBranch(pr.id));
      // Success: the branch was updated, which GitHub only permits when the
      // merge applies cleanly — so the conflict is resolved and the next
      // cycle's snapshot reads MERGEABLE (or UNKNOWN while it recomputes,
      // which `mergeability_unknown` holds on). Reaching here again means the
      // base moved a second time; see the note above for why re-rebasing then
      // is correct and deliberately unbounded.
    } catch (error) {
      if (error instanceof PlatformUnavailableError) throw error;

      if (attemptAction(wi) === "escalate") {
        await this.#escalate(
          wi,
          `${attemptCount(wi)} attempts have each ended in a merge conflict that a rebase could not resolve. ` +
            "Per §6 a conflict that survives re-dispatch is a graph defect, not a bad attempt: " +
            "another Work Item is almost certainly editing the same file with no dependency edge " +
            "between them. Retrying cannot fix that — the fix is to replan (add the missing edge, " +
            "or merge the two items) before dispatching this one again.",
        );
        return;
      }

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

    // Platform exhaustion is not an approval verdict, and every other write
    // path here re-throws it (`#resolveConflict` does so explicitly). Swallowed,
    // a secondary rate limit would be classified below as a permanent refusal
    // and escalated to a human as though GitHub had declined — the exact
    // "misreading a refusal as work failure" that platform.ts exists to prevent.
    //
    // Nothing is recorded on the way out: the breaker is open, so the audit
    // comment would itself be refused. That trades a lost trace for not
    // escalating a rate limit, which is the right way round — the next cycle
    // re-reads GitHub, which is the source of truth for what was approved.
    if (failure instanceof PlatformUnavailableError) throw failure;

    const failureMessage =
      failure instanceof Error ? failure.message : failure ? String(failure) : "";
    const failureStatus = (failure as { status?: number } | undefined)?.status;
    // GitHub refuses the per-run endpoint outright for a coding-agent branch:
    // it is scoped to fork pull requests, while this hold comes from the
    // repository's Copilot Actions workflow-approval requirement (§10.7).
    //
    // There is no second endpoint to fall back to. The REST surface exposes a
    // GET for `copilot/cloud-agent/configuration` and no write of any kind, and
    // the setting is documented as an administrator action in the UI. An
    // invented `PATCH` against that path returns a route-level 404, which is
    // how this was established (§10.7). So Factory cannot release the hold, and
    // saying so plainly is the whole job here.
    //
    // An authorization failure is equally permanent and was previously reported
    // as `partially_approved`, which Director reads as retryable: it would
    // re-approve every cycle forever, writing a fresh audit comment each time,
    // against a token that will never be permitted. A 403 reaching this point
    // is definitely a permission problem rather than a rate limit, because
    // `classifyRefusal` routes rate-limit 403s to the branch above.
    const forkOnly =
      /not from a fork pull request|queued by the Actions bot/i.test(failureMessage);
    const notApprovable =
      forkOnly ||
      failureStatus === 401 ||
      failureStatus === 403 ||
      failureStatus === 404;

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
      notApprovable
        ? forkOnly
          ? `GitHub refused: ${failureMessage} The approve endpoint only covers fork pull requests, and ` +
            "this is a coding-agent branch held by the repository's Copilot Actions workflow-approval " +
            "requirement, which has no write API — so Factory cannot release it and a human must. " +
            "Either click \"Approve and run workflows\" on the pull request, or turn the requirement " +
            "off in Settings → Copilot → Coding agent so future Work Items are not blocked the same way."
          : `GitHub refused with HTTP ${failureStatus}: ${failureMessage} That is an authorization ` +
            "failure, not a rate limit, so it will return the identical answer on every retry. The " +
            "token Factory is running under needs write access to Actions on this repository, or a " +
            "human must approve the runs on the pull request by hand."
        : failure
          ? `Stopped early: ${failureMessage} Remaining runs are still held and will be retried next cycle.`
          : "",
      // The repository-scoped findings are the input to the decision the human
      // now has to make, so state the recommendation rather than leaving them
      // to re-derive it from a bullet list. Only meaningful for the fork-only
      // refusal: an authorization failure is fixed by granting the token
      // Actions write access, not by relaxing a repository-wide control.
      notApprovable && forkOnly
        ? verdict.repoScopeSafe
          ? "On the evidence above, turning that requirement off is low-risk *for this repository*: " +
            "the default workflow token is read-only, no pull-request workflow reaches a secret, and " +
            "no job runs on a self-hosted runner, so any run here is bounded to reporting a result. " +
            "That is a judgement about the repository, and it stops holding if any of those change."
          : "Be careful before turning that requirement off in this repository: " +
            `${verdict.repoScopeBlockers.join("; ")}. Approving this one run is the narrower action.`
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
    await this.#call(() => this.#writer.addComment(wi.id, record));

    if (notApprovable) {
      // Permanent, not transient. Returning a success-shaped `partially_approved`
      // here let Gate 4 read "1 held, 0 approved" as something a later cycle
      // might fix, when in fact nothing in the loop can ever fix it.
      await this.#escalate(
        wi,
        forkOnly
          ? "workflow runs are held and Factory cannot release them: the per-run approve endpoint " +
            "covers only fork pull requests and refuses coding-agent branches, and the repository " +
            "setting that governs this hold has no write API. A human must click \"Approve and run " +
            "workflows\" on the pull request, or turn the requirement off in Settings → Copilot → " +
            "Coding agent" +
            (verdict.repoScopeSafe
              ? " — which the repository-scoped review found low-risk here: read-only default " +
                "workflow token, no secrets reachable from a pull-request workflow, no self-hosted runner"
              : `. Note before doing so: ${verdict.repoScopeBlockers.join("; ")}`)
          : `workflow runs are held and GitHub refused to approve them with HTTP ${failureStatus}: ` +
            `${failureMessage} This is an authorization failure rather than a rate limit, so every ` +
            "retry returns the same answer. Grant the token Factory runs under write access to " +
            "Actions on this repository, or approve the runs on the pull request by hand",
      );
      return {
        action: "not_approvable",
        approvedRunIds,
        failures: runs
          .filter((r) => !approvedRunIds.includes(r.id))
          .map((r) => ({ runId: r.id, message: failureMessage })),
      };
    }

    return {
      action: failure ? "partially_approved" : "approved",
      approvedRunIds,
      ...(failure
        ? {
            failures: runs
              .filter((r) => !approvedRunIds.includes(r.id))
              .map((r) => ({ runId: r.id, message: failureMessage })),
          }
        : {}),
    };
  }

  /**
   * §7.2. One assignment write, then the record.
   *
   * The assignment is what makes `escalated` terminal (`deriveState` reads
   * "no Copilot, at least one human"), so it goes first: if the comment then
   * fails, the Work Item is still correctly parked for a human and the loop
   * has stopped touching it. The reverse order would leave a Work Item that
   * announces an escalation it is not actually in, and keeps being retried.
   */
  async #escalate(wi: DerivedWorkItem, reason: string): Promise<void> {
    await this.#call(() =>
      this.#writer.assignHumanOnly(wi.id, this.#escalateToId),
    );
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
