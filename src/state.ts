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
  COPILOT_LOGIN,
  INITIAL_PLAN_COMMIT,
  type LinkedPullRequest,
  type ObjectiveSnapshot,
  type WorkItemSnapshot,
  type WorkItemState,
} from "./types.js";

/**
 * A PR that changed nothing (§5.1).
 *
 * PROBE-001 measured the failure this defends against: an impossible task
 * returned `conclusion: success`. The agent's self-report is not evidence, so a
 * no-op is detected from the artifact instead — an empty diff and no commit
 * beyond the agent's automatic "Initial plan".
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
  return wi.assignees.includes(COPILOT_LOGIN);
}

/**
 * The dispatch-confirmation window (§4.2): how long an assignment is given
 * the benefit of the doubt before an evidence-free attempt is treated as
 * failed rather than merely slow.
 *
 * There is no reliable, per-issue session-status API to poll instead (PRD
 * F8, measured live 2026-08-30): the Agent Tasks REST API's task objects
 * carry no issue reference, so a task cannot be matched back to the issue
 * that triggered it once more than one Work Item is dispatched concurrently.
 * PROBE-001 measured 8 trivial parallel sessions completing in ~80s wall
 * clock; 90s gives a single session headroom beyond that without letting a
 * genuinely stuck attempt sit unaddressed for long.
 */
export const DISPATCH_CONFIRM_WINDOW_MS = 90_000;

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
  return wi.assignees.filter((a) => a !== COPILOT_LOGIN);
}

/**
 * Attempts are counted, never stored (§4.4): one linked PR is one attempt.
 * A failed attempt's PR is closed before retry, so the count stays honest.
 */
export function attemptCount(wi: WorkItemSnapshot): number {
  return wi.linkedPullRequests.length;
}

/**
 * The PR judged as the current attempt: the newest open one, if any.
 * `deriveState` and `dispatch.ts`'s retry path (§4.4, which needs to close
 * this exact PR) both need this same judgment, so it lives in one place.
 */
export function currentOpenPullRequest(
  wi: WorkItemSnapshot,
): LinkedPullRequest | null {
  const open = wi.linkedPullRequests.filter((p) => p.state === "OPEN");
  return open.length > 0 ? open[open.length - 1]! : null;
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
    if (isNoOp(current)) {
      // No diff yet is not evidence of failure while the session may still
      // be pushing commits (§4.2) — only call it once the confirm window
      // has elapsed without a real diff appearing.
      return withinConfirmWindow(wi, now) ? "in_flight" : "failed";
    }
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
    items: snapshot.workItems.map((wi) => ({
      ...wi,
      state: deriveState(wi, snapshot.readAt),
      attempts: attemptCount(wi),
    })),
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
 * Dependencies are re-asserted here anyway: this predicate gates dispatch, and
 * a silent change to precedence upstream should not silently start work.
 */
export function ready(o: DerivedObjective): DerivedWorkItem[] {
  return o.items.filter(
    (i) => i.state === "unstarted" && i.blockedBy.every((d) => d.closed),
  );
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

  const moving = inState(o, "dispatched", "in_flight", "for_review", "failed");
  return moving.length === 0 && ready(o).length === 0;
}

export interface StateCounts {
  unstarted: number;
  dispatched: number;
  in_flight: number;
  failed: number;
  for_review: number;
  blocked: number;
  escalated: number;
  done: number;
}

/** One-line cycle summary for the log Gate 0 depends on (§10). */
export function counts(o: DerivedObjective): StateCounts {
  const c: StateCounts = {
    unstarted: 0,
    dispatched: 0,
    in_flight: 0,
    failed: 0,
    for_review: 0,
    blocked: 0,
    escalated: 0,
    done: 0,
  };
  for (const i of o.items) c[i.state] += 1;
  return c;
}
