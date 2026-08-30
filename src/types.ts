/**
 * Shapes returned by the GitHub reader and consumed by the pure state deriver.
 *
 * These mirror GitHub primitives deliberately (§3.1). Nothing here is Factory's
 * own vocabulary for status — the only Factory concept is `WorkItemState`, and
 * that is computed, never stored.
 */

export const COPILOT_LOGIN = "copilot-swe-agent";

/** The commit GitHub's coding agent pushes before doing any real work. */
export const INITIAL_PLAN_COMMIT = "Initial plan";

export type WorkItemState =
  | "unstarted"
  | "dispatched"
  | "in_flight"
  | "failed"
  | "for_review"
  | "blocked"
  | "escalated"
  | "done";

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

/** Aggregate status of a PR's checks. `null` when no checks are configured. */
export type CheckRollup = "PENDING" | "SUCCESS" | "FAILURE" | null;

export interface LinkedPullRequest {
  number: number;
  state: PullRequestState;
  isDraft: boolean;
  /** Total lines added + deleted across the PR. */
  changedLines: number;
  changedFiles: number;
  /** Commit subjects, oldest first. */
  commitSubjects: string[];
  checks: CheckRollup;
}

export interface IssueRef {
  number: number;
  closed: boolean;
}

/**
 * One raw Work Item snapshot. Everything needed to derive state, and nothing
 * else — if a field here is unused by `deriveState`, it should not be fetched.
 */
export interface WorkItemSnapshot {
  number: number;
  title: string;
  closed: boolean;
  assignees: string[];
  blockedBy: IssueRef[];
  /** PRs that would close this issue, via `closedByPullRequestsReferences`. */
  linkedPullRequests: LinkedPullRequest[];
  /**
   * When the coding agent was most recently assigned, from the issue's
   * `AssignedEvent` timeline (§4.2). `null` when it has never been assigned.
   *
   * There is no queryable, per-issue session-status API (verified live,
   * 2026-08-30 — see PRD F8): the Agent Tasks REST API exposes a task `state`
   * but no issue-reference field, so a task cannot be matched back to the
   * issue that triggered it once more than one Work Item is in flight. This
   * timestamp is the load-bearing signal instead: it gates how long a
   * still-evidence-free attempt is given the benefit of the doubt before
   * `deriveState` calls it `failed` and before the dispatcher retries it.
   */
  copilotAssignedAt: Date | null;
}

export interface ObjectiveSnapshot {
  number: number;
  title: string;
  closed: boolean;
  workItems: WorkItemSnapshot[];
  /** When the snapshot was taken. One snapshot serves a whole cycle (§4.1). */
  readAt: Date;
}
