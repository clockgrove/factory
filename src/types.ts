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
  /** GraphQL node ID, needed to address `closePullRequest` at retry time. */
  id: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
  /** Total lines added + deleted across the PR. */
  changedLines: number;
  changedFiles: number;
  /** Commit subjects, oldest first. */
  commitSubjects: string[];
  checks: CheckRollup;
  createdAt: Date;
}

export interface IssueRef {
  number: number;
  closed: boolean;
}

/**
 * One raw Work Item snapshot. Everything needed to derive state, plus `id`
 * and `number` for addressing it in write calls — nothing else should be
 * fetched here if `deriveState` and the dispatcher don't both need it.
 */
export interface WorkItemSnapshot {
  /** GraphQL node ID, needed to address `replaceActorsForAssignable` etc. */
  id: string;
  number: number;
  title: string;
  closed: boolean;
  assignees: string[];
  blockedBy: IssueRef[];
  /** PRs that would close this issue, via `closedByPullRequestsReferences`. */
  linkedPullRequests: LinkedPullRequest[];
  /**
   * Every time the coding agent was assigned, from the issue's `AssignedEvent`
   * timeline (§4.2), oldest first. Empty when it has never been assigned.
   *
   * There is no queryable, per-issue session-status API (verified live,
   * 2026-08-30 — see PRD F8): the Agent Tasks REST API exposes a task `state`
   * but no issue-reference field, so a task cannot be matched back to the
   * issue that triggered it once more than one Work Item is in flight. This
   * history is the load-bearing signal instead: `state.ts` derives both "is a
   * still-evidence-free attempt within its grace period" and "how many
   * consecutive assignments produced no pull request at all" from it — a pure
   * function of GitHub's own event log, needing no separate storage.
   */
  copilotAssignments: Date[];
}

export interface ObjectiveSnapshot {
  number: number;
  title: string;
  closed: boolean;
  workItems: WorkItemSnapshot[];
  /** When the snapshot was taken. One snapshot serves a whole cycle (§4.1). */
  readAt: Date;
  /** GraphQL node ID of the repository (§4.2's `agentAssignment.targetRepositoryId`). */
  repositoryId: string;
  /** The repository's default branch, used as `agentAssignment.baseRef`. */
  defaultBranch: string;
  /**
   * Node ID of the coding agent's bot actor, discovered via
   * `suggestedActors(capabilities: [CAN_BE_ASSIGNED])` (verified live,
   * 2026-08-30). `null` if the repository has no assignable coding agent.
   */
  copilotBotId: string | null;
}
