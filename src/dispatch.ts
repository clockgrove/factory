/**
 * Dispatch: assign, confirm, retry, escalate (§4).
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
 */

import { Octokit } from "@octokit/core";

import { createOctokit, type GitHubOptions } from "./github.js";
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
 * `replaceActorsForAssignable`/`agentAssignment` was additionally confirmed
 * *live* this session (PRD F8) — the only one of these actually exercised
 * against a real repository so far. `addAssigneesToAssignable`, `addComment`
 * and `closePullRequest` are long-stable, pre-agent GraphQL mutations
 * verified against current docs but not yet exercised live; this is a known
 * gap to close (a single cheap live check per mutation) before Gate 0
 * depends on the escalate/retry paths for real.
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
}

/** `GitHubWriter` backed by a real Octokit GraphQL client. */
export class GithubOctokitWriter implements GitHubWriter {
  readonly #octokit: Octokit;

  constructor(opts: GitHubOptions) {
    this.#octokit = createOctokit(opts);
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

  /** §4.4: a no-op PR sat past its confirm window. Retry or escalate. */
  async retryOrEscalate(wi: DerivedWorkItem): Promise<void> {
    if (attemptAction(wi) === "escalate") {
      await this.#escalate(
        wi,
        `${attemptCount(wi)} attempts produced no usable diff`,
      );
      return;
    }

    const current = currentOpenPullRequest(wi);
    if (current) {
      // Comment before closing: if closing then fails, the retry is only
      // reattempted next cycle (the PR is still open and no-op, so the Work
      // Item is still `failed`) — a duplicate comment is noise, never harm.
      await this.#call(() =>
        this.#writer.addComment(
          current.id,
          "Closing: no diff appeared before the confirm window elapsed (§4.4). Retrying.",
        ),
      );
      await this.#call(() => this.#writer.closePullRequest(current.id));
    }

    await this.#call(() => this.#writer.clearActors(wi.id));
    await this.#assign(wi.id);
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
