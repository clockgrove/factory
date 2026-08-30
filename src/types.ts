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
   * Whether a coding-agent session is currently executing for this item.
   * Sourced from workflow runs, not from the issue itself.
   */
  sessionActive: boolean;
  /** True when the most recent agent session reached a failure conclusion. */
  sessionFailed: boolean;
}

export interface ObjectiveSnapshot {
  number: number;
  title: string;
  closed: boolean;
  workItems: WorkItemSnapshot[];
  /** When the snapshot was taken. One snapshot serves a whole cycle (§4.1). */
  readAt: Date;
}
