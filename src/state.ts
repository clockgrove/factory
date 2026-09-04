/**
 * Derived state (§1, §3.2).
 *
 * Every function here is pure. Given the same snapshot they return the same
 * answer, which is what makes crash recovery free: there is no stored state to
 * reconcile, so "resume" and "start" are the same code path.
 *
 * Nothing in this file performs I/O. That is deliberate and worth preserving —
 * it is why the state machine can be tested exhaustively without a network.
 */

import {
  COPILOT_ASSIGNEE_LOGIN,
  INITIAL_PLAN_COMMIT,
  type AgentWorkEvent,
  type LinkedPullRequest,
  type ObjectiveSnapshot,
  type WorkItemSnapshot,
  type WorkItemState,
} from "./types.js";
import { deriveV2State } from "./control/v2-state.js";

/**
 * A PR that changed nothing (§5.1).
 *
 * The agent's self-report is not evidence, so a no-op is detected from the
 * artifact instead — an empty diff and no commit beyond the agent's automatic
 * "Initial plan".
 */
export function isNoOp(pr: LinkedPullRequest): boolean {
  const hasDiff = pr.changedLines > 0 || pr.changedFiles > 0;
  if (hasDiff) return false;

  const realCommits = pr.commitSubjects.filter(
    (s) => s.trim() !== INITIAL_PLAN_COMMIT,
  );
  return realCommits.length === 0;
}

/** A PR carrying actual work. The inverse of `isNoOp` for open PRs. */
export function hasRealWork(pr: LinkedPullRequest): boolean {
  return !isNoOp(pr);
}

/**
 * Checks have settled when they have reached a terminal rollup, or when the
 * repository has no checks configured at all (`null`).
 */
export function checksSettled(pr: LinkedPullRequest): boolean {
  return pr.checks !== "PENDING";
}

export function isAssignedToCopilot(wi: WorkItemSnapshot): boolean {
  return wi.assignees.includes(COPILOT_ASSIGNEE_LOGIN);
}

/**
 * The dispatch-confirmation window (§4.2): how long an assignment is given
 * the benefit of the doubt before an evidence-free attempt is treated as
 * failed rather than merely slow.
 *
 * There is no reliable, per-issue session-status API to poll instead: the
 * Agent Tasks REST API's task objects carry no issue reference, so a task
 * cannot be matched back to the issue that triggered it once more than one Work
 * Item is dispatched concurrently. Measured trivial parallel sessions complete
 * in ~80s wall clock; 90s gives a single session headroom beyond that without
 * letting a genuinely stuck attempt sit unaddressed for long.
 */
export const DISPATCH_CONFIRM_WINDOW_MS = 90_000;

/**
 * A PR title that explicitly declines the Work Item as not actionable. Lives
 * here, next to the no-op classification it qualifies, so `deriveState` can
 * tell "the agent said no" apart from "the agent has not spoken yet" without
 * importing from `evaluate.ts` and creating a cycle. `evaluate.ts` owns the
 * `isDeclined` predicate built on it.
 */
export const DECLINE_TITLE_PATTERN = /^\s*no-?op\s*:/i;

/**
 * The coding agent's "I am not finished" marker.
 *
 * Measured, not assumed. Across observed coding-agent pull requests (12/12 in a
 * representative batch, plus additional repositories) the agent opens its pull
 * request titled `[WIP] <title>` and emits a `RenamedTitleEvent` dropping the
 * prefix at the moment it finishes.
 *
 * This is the completion signal Factory has to use, because the obvious
 * candidate does not work: **the agent never clears the draft flag.** Every
 * observed `ReadyForReviewEvent`s are emitted by Factory's own token, not by
 * the agent; finished-and-renamed coding-agent pull requests can remain
 * `isDraft: true`. Waiting on `isDraft` waits for something that never happens.
 *
 * Absence of the prefix is treated as "finished", which is the safe default in
 * the one direction that matters: a pull request that never used the convention
 * is judged on its diff as before, rather than waiting forever for a rename
 * that was never coming.
 */
export const WIP_TITLE_PATTERN = /^\s*\[wip\]/i;

/** Whether the coding agent still considers `pr` unfinished (§5.1). */
export function isWorkInProgress(pr: LinkedPullRequest): boolean {
  return WIP_TITLE_PATTERN.test(pr.title);
}

/**
 * How long a pull request that exists but carries no diff is given before it
 * is judged, measured from the *pull request's* creation rather than from the
 * assignment.
 *
 * The two windows answer different questions. Conflating them can derive
 * `failed` while the coding agent is actively writing, because
 * `DISPATCH_CONFIRM_WINDOW_MS` may have elapsed since assignment even though an
 * existing pull request is still receiving work:
 *
 *  - The confirm window asks *did dispatch take?* Its evidence is a PR
 *    appearing at all, so it is rightly short and measured from assignment.
 *  - Once a PR exists, dispatch demonstrably took. The remaining question is
 *    *is the agent still working?* — and the agent opens its draft PR within
 *    seconds and then works for minutes (PRs opened 5–40s after dispatch in a
 *    measured batch; one Objective took ~17 minutes end to end). Judging that
 *    from the assignment clock declares failure while work is visibly in
 *    progress.
 *
 * Ten minutes is comfortably beyond every session measured so far while still
 * bounding a genuinely dead attempt. The clock restarts naturally on retry,
 * because a retry closes the old PR and the next attempt opens a new one.
 */
export const EMPTY_PULL_REQUEST_GRACE_MS = 600_000;

/**
 * Whether an evidence-free pull request is young enough that its emptiness is
 * not yet meaningful. An explicit decline is exempt: the agent has given its
 * final answer, so there is nothing to wait for (§5.1).
 */
export function withinEmptyPullRequestGrace(
  pr: LinkedPullRequest,
  now: Date,
): boolean {
  if (DECLINE_TITLE_PATTERN.test(pr.title)) return false;
  return now.getTime() - pr.createdAt.getTime() < EMPTY_PULL_REQUEST_GRACE_MS;
}

/**
 * How long a pull request the agent still calls `[WIP]` may go without a push
 * before its attempt is judged dead.
 *
 * This window exists because of the ordering in §5.1. Once Factory stopped merging
 * work the agent had not finished, an unfinished pull request became something
 * it *waits* on — and an agent that pushes a partial commit and then dies
 * leaves a pull request that is neither empty (so the empty-PR grace never
 * applies) nor ever finished. Without a bound, that item waits forever: no
 * merge, no retry, no escalation, and no human is told. A silent stall is worse
 * than a loud escalation, so the wait has to end.
 *
 * Measured from the head commit, not from the pull request's creation. Age
 * alone would close live work because a real Work Item can legitimately take
 * longer to write than any age bound
 * short enough to be useful. Inactivity is the honest signal: an agent that is
 * still working pushes, and one that has died does not.
 *
 * Twenty minutes is deliberately generous. The two errors are not symmetric:
 * judging too early closes a live session's work irrecoverably, while judging
 * too late merely delays a human by minutes. It is set well beyond the largest
 * gap measured between an agent's first push and its completion rename
 * (~6 minutes; most complete in under 3).
 *
 * **If this ever needs tuning, tune it upward.** The dangerous case is a pull
 * request that is *finished but not yet renamed*: it derives `failed`, gets
 * retried, and the retry closes correct completed work. Shrinking this bound to
 * catch dead agents sooner buys minutes and risks destroying a finished Work
 * Item; growing it costs only the delay before a human hears about a genuinely
 * dead one. A measured late push-to-rename gap was ~100 seconds, so the current
 * value carries roughly a twelvefold margin over that case — there is no
 * evidence-backed reason to reduce it.
 */
export const WIP_INACTIVITY_GRACE_MS = 1_200_000;

/**
 * Whether `pr` is work the agent appears to have abandoned: still marked
 * `[WIP]`, with no push for longer than the grace window.
 */
export function isAbandonedAttempt(pr: LinkedPullRequest, now: Date): boolean {
  if (!isWorkInProgress(pr)) return false;
  return now.getTime() - pr.headCommittedAt.getTime() >= WIP_INACTIVITY_GRACE_MS;
}

/**
 * The agent's failure event for the *current* session on `pr`, or `null` if its
 * latest word is anything else.
 *
 * "Latest event wins" would be wrong in the other direction: a `finished` event
 * can be followed by a fresh `started` when the agent is re-invoked on the same
 * pull request (measured on two merged pull requests, both restarted minutes
 * after completing). So this asks only the narrow question the graces exist to
 * answer — *has the current session ended in failure* — and reports nothing
 * when the answer is no. Completion is still read from the `[WIP]` rename,
 * which is what the integrator has always keyed on.
 *
 * A push after the failure also clears it: commits are ground truth about work
 * having happened, and an event contradicted by a later commit is stale.
 */
export function agentFailure(pr: LinkedPullRequest): AgentWorkEvent | null {
  // Ordered here rather than trusting the caller: "which event came last" is
  // the whole basis of this read, so it must not depend on an upstream mapper
  // preserving an ordering GitHub never promised. Ties break toward the later
  // array position, matching GitHub's own timeline order.
  let last: AgentWorkEvent | null = null;
  for (const event of pr.agentWorkEvents) {
    if (!last || event.at.getTime() >= last.at.getTime()) last = event;
  }
  if (!last || last.kind !== "failed") return null;
  if (pr.headCommittedAt.getTime() > last.at.getTime()) return null;
  return last;
}

/**
 * Failure reasons no retry can fix.
 *
 * The retry loop assumes a failed attempt is *this attempt's* misfortune — a
 * confused session, a transient platform fault — so another dispatch is worth
 * a try. An exhausted request quota breaks that assumption: the next two
 * attempts fail identically and in seconds, and the Work Item then escalates
 * citing "no usable result", which points a human at the brief instead of at
 * the billing page GitHub already named. Measured on Gate 8, where both
 * attempts died ~40s in with exactly these messages.
 *
 * Matched on GitHub's prose because there is no machine-readable code on the
 * event. Kept deliberately narrow: an unmatched message simply retries as
 * before, so a missed pattern costs latency, while an over-broad one would
 * escalate genuinely retryable failures to a human. Anchored on the two
 * measured messages plus the entitlement vocabulary around them.
 */
const NON_RETRYABLE_FAILURE_PATTERNS: RegExp[] = [
  /exceeded your .*\bquota\b/i,
  /\busage limit\b/i,
  /\bpremium request/i,
  /\bquota\b.*\bexceeded\b/i,
];

/** Whether GitHub's stated failure reason is one no further attempt can fix. */
export function isNonRetryableFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return NON_RETRYABLE_FAILURE_PATTERNS.some((p) => p.test(message));
}

/** The most recent time the coding agent was assigned, or `null` if never. */
export function latestCopilotAssignment(wi: WorkItemSnapshot): Date | null {
  if (wi.copilotAssignments.length === 0) return null;
  return wi.copilotAssignments[wi.copilotAssignments.length - 1]!;
}

/**
 * Whether `wi` was assigned to the coding agent recently enough that a
 * still-evidence-free attempt should not yet be judged. `now` is threaded in
 * rather than read from the clock so the answer stays a pure function of its
 * inputs (§1) — callers pass the snapshot's `readAt` (§4.1).
 */
export function withinConfirmWindow(wi: WorkItemSnapshot, now: Date): boolean {
  const assignedAt = latestCopilotAssignment(wi);
  if (!assignedAt) return false;
  return now.getTime() - assignedAt.getTime() < DISPATCH_CONFIRM_WINDOW_MS;
}

/**
 * How many consecutive, most-recent coding-agent assignments produced no
 * pull request at all (§4.2's "unassign, reassign; on second failure
 * escalate"), counted purely from GitHub's own event history.
 *
 * Every confirm-retry (unassign then reassign) leaves a fresh `AssignedEvent`,
 * so the assignment timeline already partitions into windows: from one
 * assignment up to the next (or "now", for the latest). A window "produced a
 * PR" if any linked PR's `createdAt` falls inside it — regardless of whether
 * that PR was later closed as a no-op by a *different* retry path (§4.4);
 * this only counts the narrower "assigned and nothing ever showed up" case.
 * Walking backward from the most recent assignment and stopping at the first
 * window that produced a PR keeps the count from conflating the two retry
 * mechanisms. This needs no stored counter and survives a restart for free —
 * the same guarantee every other derived fact in this module has (§1).
 */
export function confirmFailureStreak(wi: WorkItemSnapshot): number {
  if (wi.copilotAssignments.length === 0) return 0;

  const assigns = [...wi.copilotAssignments].sort(
    (a, b) => a.getTime() - b.getTime(),
  );
  const prCreatedAts = wi.linkedPullRequests.map((pr) => pr.createdAt.getTime());

  let streak = 0;
  for (let i = assigns.length - 1; i >= 0; i--) {
    const windowStart = assigns[i]!.getTime();
    const windowEnd = i + 1 < assigns.length ? assigns[i + 1]!.getTime() : Infinity;
    const producedPr = prCreatedAts.some((t) => t >= windowStart && t < windowEnd);
    if (producedPr) break;
    streak++;
  }
  return streak;
}

/** Human assignees, i.e. everyone who is not the coding agent. */
export function humanAssignees(wi: WorkItemSnapshot): string[] {
  return wi.assignees.filter((a) => a !== COPILOT_ASSIGNEE_LOGIN);
}

/**
 * Attempts are counted, never stored (§4.4). A v2 infrastructure interruption
 * is represented by AttemptDeferred: its immutable reservation remains useful
 * audit evidence, but it does not spend the Work Item's implementation retry
 * allowance. Real time/provider usage remains accounted in the budget ledger.
 */
export function attemptCount(wi: WorkItemSnapshot): number {
  if (wi.factoryEvents !== undefined) {
    const attempts = new Map<string, Set<string>>();
    for (const event of wi.factoryEvents) {
      if (event.kind !== "attempt" || event.workItem !== wi.number) continue;
      const key = `${event.runId}:${event.attempt}`;
      const names = attempts.get(key) ?? new Set<string>();
      names.add(event.event);
      attempts.set(key, names);
    }
    return [...attempts.values()].filter((events) => !events.has("AttemptDeferred")).length;
  }
  return wi.linkedPullRequests.length;
}

/**
 * The PR judged as the current attempt: the newest open one, if any.
 * `deriveState` and `dispatch.ts`'s retry path (§4.4, which needs to close
 * this exact PR) both need this same judgment, so it lives in one place.
 *
 * "Newest" is resolved by `createdAt`, not by array position. GitHub does not
 * document an ordering for `closedByPullRequestsReferences`, so the last
 * element is not the newest by any guarantee. Ordering bugs become dangerous on
 * the retry path,
 * where this function chooses which pull request gets *closed*: picking the
 * wrong one closes live work and leaves the stale attempt open to be merged.
 *
 * Ties break on `number` descending, so the answer is total and deterministic
 * rather than dependent on sort stability — two pull requests can share a
 * `createdAt` at second granularity, and issue numbers are monotonic.
 */
export function currentOpenPullRequest(
  wi: WorkItemSnapshot,
): LinkedPullRequest | null {
  const open = wi.linkedPullRequests.filter((p) => p.state === "OPEN");
  if (open.length === 0) return null;
  return open.reduce((newest, p) =>
    p.createdAt.getTime() !== newest.createdAt.getTime()
      ? p.createdAt > newest.createdAt
        ? p
        : newest
      : p.number > newest.number
        ? p
        : newest,
  );
}

/**
 * Derive a Work Item's state.
 *
 * `now` is the snapshot's read time (§4.1), not the wall clock, so the
 * function stays a pure mapping from its inputs to a single answer.
 *
 * Precedence matters and is ordered most-terminal first, so that a single
 * unambiguous answer falls out. The ordering rationale:
 *
 *  1. `done` and `escalated` are terminal for the loop — nothing to dispatch.
 *  2. PR evidence outranks assignment, because a PR proves work began whereas
 *     an assignee only proves work was requested (§4.2).
 *  3. `blocked` is checked before `unstarted` so the loop never treats a
 *     dependency-blocked item as ready.
 */
export function deriveState(wi: WorkItemSnapshot, now: Date): WorkItemState {
  if (wi.factoryEvents !== undefined) return deriveV2State(wi, now);
  if (wi.closed) return "done";

  const merged = wi.linkedPullRequests.filter((p) => p.state === "MERGED");

  // A merged PR whose issue is still open: GitHub has not yet propagated the
  // closure, or the link does not auto-close. Treat as done — the work landed.
  if (merged.length > 0) return "done";

  if (!isAssignedToCopilot(wi) && humanAssignees(wi).length > 0) {
    return "escalated";
  }

  const current = currentOpenPullRequest(wi);
  if (current) {
    // The agent's own report that its session died outranks every grace below.
    // Those windows exist only because a proxy cannot tell "still working" from
    // "died quietly"; once GitHub has answered that question there is nothing
    // left to wait for, and waiting anyway cost a measured 27m50s across one
    // Work Item's two dead attempts — 80% of its elapsed life.
    const failure = agentFailure(current);
    if (isNoOp(current)) {
      // No diff yet is not evidence of failure while the session may still be
      // pushing commits (§4.2). Two independent reasons to keep waiting: the
      // dispatch is too fresh to judge at all, or the PR itself is young
      // enough that the agent is plausibly still writing into it.
      const stillPlausiblyWorking =
        !failure &&
        (withinConfirmWindow(wi, now) || withinEmptyPullRequestGrace(current, now));
      return stillPlausiblyWorking ? "in_flight" : "failed";
    }
    // Same reasoning for a partially-written attempt: if the agent has said it
    // failed and pushed nothing since, the inactivity bound is measuring a
    // question already answered.
    if (failure && isWorkInProgress(current)) return "failed";
    // Work the agent still calls `[WIP]` but has stopped pushing to is a dead
    // attempt. Since §5.1 Factory no longer merges unfinished work, so
    // without this the item would wait on a pull request nobody is writing —
    // forever. Routing it to `failed` reuses the existing retry path (close,
    // re-dispatch, escalate on the third attempt) rather than inventing a
    // fourth outcome for the same underlying fact: dispatch died.
    if (isAbandonedAttempt(current, now)) return "failed";
    // Still `[WIP]` and still being pushed to: the agent is working. Not
    // `for_review` — that would hand a half-written change to the integrator.
    if (isWorkInProgress(current)) return "in_flight";
    if (checksSettled(current)) return "for_review";
    return "in_flight";
  }

  if (isAssignedToCopilot(wi)) return "dispatched";

  if (wi.blockedBy.some((d) => !d.closed)) return "blocked";

  return "unstarted";
}

export interface DerivedWorkItem extends WorkItemSnapshot {
  state: WorkItemState;
  attempts: number;
  /**
   * True when this item is `done` purely because its issue is closed, with no
   * merged pull request to show for it.
   *
   * `done` deliberately conflates two things — "the work landed" and "someone
   * decided this is finished" — and honouring a closed issue is correct: GitHub
   * is the source of truth (§1), and a loop that reopened items a human closed
   * would be fighting its operator. Factory itself never closes a Work Item, so
   * this can only arrive from outside the loop.
   *
   * What is *not* correct is reporting it as delivered work. Without this flag,
   * an Objective every one of whose items was closed by hand closes itself and
   * reports success, and nothing in the output distinguishes that from code
   * that actually shipped. The behaviour is unchanged; the claim is now
   * checkable.
   */
  doneWithoutMergedPullRequest: boolean;
}

export interface DerivedObjective {
  id: string;
  number: number;
  title: string;
  body: string;
  closed: boolean;
  readAt: Date;
  repositoryId: string;
  defaultBranch: string;
  copilotBotId: string | null;
  ciExpectedOnPullRequests: boolean | "unknown";
  items: DerivedWorkItem[];
}

export function derive(snapshot: ObjectiveSnapshot): DerivedObjective {
  return {
    id: snapshot.id,
    number: snapshot.number,
    title: snapshot.title,
    body: snapshot.body,
    closed: snapshot.closed,
    readAt: snapshot.readAt,
    repositoryId: snapshot.repositoryId,
    defaultBranch: snapshot.defaultBranch,
    copilotBotId: snapshot.copilotBotId,
    ciExpectedOnPullRequests: snapshot.ciExpectedOnPullRequests,
    items: snapshot.workItems.map((wi) => {
      const state = deriveState(wi, snapshot.readAt);
      return {
        ...wi,
        state,
        attempts: attemptCount(wi),
        doneWithoutMergedPullRequest:
          state === "done" &&
          !wi.linkedPullRequests.some((p) => p.state === "MERGED"),
      };
    }),
  };
}

/** Work Items in a given state. */
export function inState(
  o: DerivedObjective,
  ...states: WorkItemState[]
): DerivedWorkItem[] {
  return o.items.filter((i) => states.includes(i.state));
}

/**
 * Ready = unstarted, every `blocked by` closed, not escalated (§3.2).
 *
 * `deriveState` already folds the dependency and escalation checks into the
 * `blocked` and `escalated` states, so readiness reduces to `unstarted`.
 * Dependencies are re-asserted here anyway: this predicate controls dispatch, and
 * a silent change to precedence upstream should not silently start work.
 */
export function ready(o: DerivedObjective): DerivedWorkItem[] {
  return o.items.filter(
    (i) =>
      (i.state === "unstarted" ||
        (i.factoryEvents !== undefined && i.state === "failed")) &&
      i.blockedBy.every((d) => d.closed),
  );
}

/** GitHub-server timestamp for the current durable ready-but-queued episode. */
export function queuedSince(
  item: DerivedWorkItem,
  runId: string,
): string | undefined {
  const events = (item.factoryEvents ?? [])
    .filter((event) => event.runId === runId && "workItem" in event)
    .sort((left, right) => left.sequence - right.sequence);
  const latestAdmission = [...events]
    .reverse()
    .find(
      (event) =>
        event.kind === "attempt" && event.event === "AttemptReserved",
    );
  const queued = [...events]
    .reverse()
    .find(
      (event) =>
        event.kind === "scheduling" &&
        event.event === "WorkItemQueued" &&
        (!latestAdmission || event.sequence > latestAdmission.sequence),
    );
  if (
    queued &&
    item.blockedBy.some(
      (dependency) =>
        dependency.closed &&
        dependency.updatedAt !== undefined &&
        dependency.updatedAt.getTime() > new Date(queued.at).getTime(),
    )
  ) {
    // A dependency changed after the queue receipt. Conservatively treat this
    // as a new ready episode: a reopen/reclose must never inherit an old delay
    // and become immediately eligible for paid burst after restart.
    return undefined;
  }
  return queued?.at;
}

/** Every Work Item is done, so the Objective itself can close (§4). */
export function allDone(o: DerivedObjective): boolean {
  return o.items.length > 0 && o.items.every((i) => i.state === "done");
}

/**
 * Nothing can progress without intervention: no work is running, none is
 * ready, and at least one item remains open. This is the replanning trigger
 * (§7) — including the deadlock case where every remaining item is blocked.
 */
export function isStalled(o: DerivedObjective): boolean {
  if (allDone(o)) return false;

  const moving = inState(
    o,
    "reserved",
    "dispatched",
    "in_flight",
    "validating",
    "for_review",
    "failed",
  );
  return moving.length === 0 && ready(o).length === 0;
}

export interface StateCounts {
  unstarted: number;
  reserved: number;
  dispatched: number;
  in_flight: number;
  validating: number;
  failed: number;
  for_review: number;
  blocked: number;
  escalated: number;
  inconsistent: number;
  done: number;
}

/** One-line cycle summary for the log (§10). */
export function counts(o: DerivedObjective): StateCounts {
  const c: StateCounts = {
    unstarted: 0,
    reserved: 0,
    dispatched: 0,
    in_flight: 0,
    validating: 0,
    failed: 0,
    for_review: 0,
    blocked: 0,
    escalated: 0,
    inconsistent: 0,
    done: 0,
  };
  for (const i of o.items) c[i.state] += 1;
  return c;
}
