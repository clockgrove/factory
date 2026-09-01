/**
 * Shapes returned by the GitHub reader and consumed by the pure state deriver.
 *
 * These mirror GitHub primitives deliberately (§3.1). Nothing here is Factory's
 * own vocabulary for status — the only Factory concept is `WorkItemState`, and
 * that is computed, never stored.
 */

/**
 * The coding agent's login as it appears in `suggestedActors` (a `Bot` actor)
 * and in `AssignedEvent.assignee` on the issue timeline. Used to find the bot
 * to assign, and to filter the assignment timeline to the agent's own events.
 */
export const COPILOT_LOGIN = "copilot-swe-agent";

/**
 * The coding agent's login as it appears in the *current* `assignees`
 * connection once actually assigned — a distinct, `User`-typed identity from
 * `COPILOT_LOGIN`, not a typo (verified live against a real assignment,
 * 2026-08-31, clockgrove/factory-gate0: `suggestedActors`/`AssignedEvent`
 * both report `{login: "copilot-swe-agent", __typename: "Bot"}` for the same
 * actor that `issue.assignees` reports back as `{login: "Copilot",
 * __typename: "User"}`). `state.ts`'s `isAssignedToCopilot`/`humanAssignees`
 * — which read `assignees`, not the timeline or `suggestedActors` — must use
 * this constant, or every dispatched Work Item misclassifies as `escalated`
 * the moment it has any assignee at all (Gate 0 finding, 2026-08-31).
 */
export const COPILOT_ASSIGNEE_LOGIN = "Copilot";

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

/**
 * GitHub's own three-way mergeability verdict (schema: `PullRequest.mergeable`,
 * verified against docs.github.com/en/graphql/reference/pulls, 2026-08-30).
 * `UNKNOWN` is not a failure — GitHub computes this asynchronously and has not
 * finished yet, so it must not be read as `CONFLICTING` (§5.1 "conflict").
 */
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/**
 * One file's worth of a pull request's actual patch, for the semantic half of
 * the confidence bar (§7.3). `patch` is null when GitHub declined to return it
 * (binary/oversized) or when this read's size budget was exhausted — in both
 * cases `patchOmitted` says which, so a reader can tell "no changes worth
 * showing" apart from "changes withheld".
 */
export interface PullRequestDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  patchOmitted?: string;
}

export interface PullRequestDiff {
  pullNumber: number;
  files: PullRequestDiffFile[];
  /** True when any patch was shortened or withheld for size. */
  truncated: boolean;
}

export interface LinkedPullRequest {
  /** GraphQL node ID, needed to address `closePullRequest` at retry time. */
  id: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
  title: string;
  /** PR description. Used only as a secondary signal (§5.1 "declined") — the
   * diff and commit list remain the primary evidence, per PROBE-001's finding
   * that PR text (e.g. `[WIP]` titles) is not reliable on its own. */
  body: string;
  /** Total lines added + deleted across the PR. */
  changedLines: number;
  changedFiles: number;
  /** Repo-relative paths touched by the PR, up to the first page (§5.1
   * "untouched"). */
  changedFilePaths: string[];
  /** Commit subjects, oldest first. */
  commitSubjects: string[];
  checks: CheckRollup;
  /**
   * True when `checks` is `FAILURE` only because a check *suite* concluded
   * badly without ever producing a check run — CI that never started, rather
   * than CI that ran and failed.
   *
   * Worth distinguishing because the two demand opposite responses from a
   * human, and the overwhelmingly common cause is not a bug at all: GitHub
   * requires a maintainer to click "Approve and run workflows" on a pull
   * request authored by the coding agent before any workflow executes
   * (verified against docs.github.com, 2026-09-02; the setting lives under
   * Settings → Copilot → Coding agent). Unapproved, the run is created and
   * then *waits* in `action_required`, executing nothing. It only concludes
   * `failure` when the pull request is closed or merged, which cancels it.
   *
   * That ordering is load-bearing and was verified live on the Gate 3 fixture:
   * every run on a branch shares one `updated_at` 1–2s after that branch's
   * `merged_at`, regardless of having been created minutes apart. So while the
   * pull request is open the honest reading is "checks expected, awaiting
   * approval" (`PENDING`) — `FAILURE` here is an artifact observable only after
   * the fact. Reporting either as "required checks failed" sends a human
   * hunting for a broken test that does not exist, so escalation names the real
   * cause instead (§10.5, F1).
   */
  checksNeverStarted?: boolean;
  mergeable: MergeableState;
  createdAt: Date;
  /**
   * Head commit SHA. Needed to address the workflow runs belonging to this pull
   * request, which the REST API filters by `head_sha` rather than by PR number.
   */
  headSha: string;
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
  /** GraphQL node ID of the Objective issue itself, needed to address it as
   * `graph.ts`'s `objectiveIssueId` (`CreateIssueInput.parentIssueId`) when
   * applying a compiled Work Item graph (§9 build order step 6). */
  id: string;
  number: number;
  title: string;
  /** Issue description, exactly as the human wrote it. `objective-compilation`
   * reads this — and only this, plus `title` — as the stated intent (§2); the
   * compile-if-needed step of the loop cannot function without it. */
  body: string;
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
  /**
   * Whether this repository is known to run CI on pull requests, so a PR with
   * *no* checks at all should be read as "CI has not reported yet", not as
   * "this repository has no CI".
   *
   * Gate 3 finding (2026-09-02, clockgrove/factory-gate3): all four PRs merged
   * with `checks: null` even though the repository ships a real workflow. The
   * workflow runs were created and then failed at *startup* — zero jobs — so
   * they never attached a check to the head commit, and `statusCheckRollup`
   * stayed null with zero contexts. A CI that cannot start is therefore
   * byte-for-byte indistinguishable from a repository with no CI, and the
   * evaluator merged straight through it. This flag is the missing
   * distinction; see `evaluateMechanical`'s `checks_missing` verdict.
   */
  ciExpectedOnPullRequests: boolean;
}
