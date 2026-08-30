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
 * Derive a Work Item's state.
 *
 * Precedence matters and is ordered most-terminal first, so that a single
 * unambiguous answer falls out. The ordering rationale:
 *
 *  1. `done` and `escalated` are terminal for the loop — nothing to dispatch.
 *  2. An active session outranks PR inspection: the artifact is still moving,
 *     so judging it now would judge an intermediate state.
 *  3. PR evidence outranks assignment, because a PR proves work began whereas
 *     an assignee only proves work was requested (§4.2).
 *  4. `blocked` is checked before `unstarted` so the loop never treats a
 *     dependency-blocked item as ready.
 */
export function deriveState(wi: WorkItemSnapshot): WorkItemState {
  if (wi.closed) return "done";

  const open = wi.linkedPullRequests.filter((p) => p.state === "OPEN");
  const merged = wi.linkedPullRequests.filter((p) => p.state === "MERGED");

  // A merged PR whose issue is still open: GitHub has not yet propagated the
  // closure, or the link does not auto-close. Treat as done — the work landed.
  if (merged.length > 0) return "done";

  if (!isAssignedToCopilot(wi) && humanAssignees(wi).length > 0) {
    return "escalated";
  }

  // Work in motion is not yet evidence. Judge it when it stops.
  if (wi.sessionActive) return "in_flight";

  if (wi.sessionFailed) return "failed";

  if (open.length > 0) {
    // Newest PR is the current attempt; earlier ones are closed-out retries.
    const current = open[open.length - 1]!;
    if (isNoOp(current)) return "failed";
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
  number: number;
  title: string;
  closed: boolean;
  readAt: Date;
  items: DerivedWorkItem[];
}

export function derive(snapshot: ObjectiveSnapshot): DerivedObjective {
  return {
    number: snapshot.number,
    title: snapshot.title,
    closed: snapshot.closed,
    readAt: snapshot.readAt,
    items: snapshot.workItems.map((wi) => ({
      ...wi,
      state: deriveState(wi),
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
