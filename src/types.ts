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
 * `COPILOT_LOGIN`, not a typo. GitHub reports the same actor as
 * `{login: "copilot-swe-agent", __typename: "Bot"}` through
 * `suggestedActors`/`AssignedEvent`, but as `{login: "Copilot",
 * __typename: "User"}` through `issue.assignees`. `state.ts`'s
 * `isAssignedToCopilot`/`humanAssignees` — which read `assignees`, not the
 * timeline or `suggestedActors` — must use this constant, or every dispatched
 * Work Item misclassifies as `escalated` the moment it has any assignee at all.
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
 * GitHub's own three-way mergeability verdict (schema: `PullRequest.mergeable`).
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

/**
 * The default branch's file list, used to ground a compiled Work Item's `scope`
 * in the repository as it actually is rather than as its Objective's prose
 * implies.
 */
export interface RepositoryLayout {
  defaultBranch: string;
  /** Blob paths only, sorted. Directories are implied. */
  files: string[];
  /** How many files matched before any cap was applied. */
  totalFiles: number;
  /** True if this list is incomplete for any reason. */
  truncated: boolean;
  /**
   * True when GitHub itself could not return the whole tree, as distinct from
   * this reader having capped it. Kept separate because the remedies differ: a
   * caller can lower its own scope with `pathPrefix`, but cannot make a
   * repository small enough for GitHub to return whole.
   */
  treeTruncatedByGitHub: boolean;
}

/** One file's text from the default branch. */
export interface RepositoryFile {
  path: string;
  /** False means the path is simply not in the repository — not an error. */
  exists: boolean;
  content?: string;
  /**
   * True when there is more text than `content` holds — either this reader
   * clipped it at `maxBytes`, or the file is over the contents API's 1 MB limit
   * and GitHub returned none of it.
   *
   * Deliberately false when the path is not a file at all. A directory has no
   * text to truncate, and reporting one as truncated conflates
   * "I refused to read this" with "there is more of it" — which would send a
   * caller that pages or retries on `truncated` into a loop that can never make
   * progress. Check `unreadable` first; `content` is absent whenever it is set.
   */
  truncated: boolean;
  /** Why content is absent despite the path existing (directory, symlink, >1MB). */
  unreadable?: string;
}

export interface LinkedPullRequest {
  /** GraphQL node ID, needed to address `closePullRequest` at retry time. */
  id: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
  title: string;
  /** PR description. Used only as a secondary signal (§5.1 "declined") — the
   * diff and commit list remain the primary evidence because PR text (e.g.
   * `[WIP]` titles) is not reliable on its own. */
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
   * (Settings → Copilot → Coding agent). Unapproved, the run is created and
   * then *waits* in `action_required`, executing nothing. It only concludes
   * `failure` when the pull request is closed or merged, which cancels it.
   *
   * That ordering is load-bearing: runs on a held branch share one `updated_at`
   * 1–2s after that branch's `merged_at`, regardless of having been created
   * minutes apart. So while the pull request is open the honest reading is
   * "checks expected, awaiting approval" (`PENDING`) — `FAILURE` here is an
   * artifact observable only after the fact. Reporting either as "required
   * checks failed" sends a human hunting for a broken test that does not exist,
   * so escalation names the real cause instead (§9).
   */
  checksNeverStarted?: boolean;
  mergeable: MergeableState;
  createdAt: Date;
  /**
   * Head commit SHA. Needed to address the workflow runs belonging to this pull
   * request, which the REST API filters by `head_sha` rather than by PR number.
   */
  headSha: string;
  /**
   * When the head commit was authored — the closest available proxy for "when
   * did the coding agent last push".
   *
   * Deliberately *not* the pull request's `updatedAt`. A PR is touched by
   * comments, labels and review requests, and Factory itself comments on pull
   * requests (§6), so `updatedAt` would be refreshed by Factory's own activity
   * and a dead attempt would look alive forever. The head commit moves only
   * when the agent actually pushes.
   *
   * Also not `pushedDate`: GitHub's GraphQL API can return `null` there, so
   * depending on it would silently produce no timestamp at all.
   */
  headCommittedAt: Date;
  /**
   * When this pull request was merged, or `null` if it never was.
   *
   * Factory does not read this — every decision it makes is about the *present*
   * state, per §1. It exists because without it the tool surface cannot answer
   * ordering questions after the fact: "was this Work Item dispatched only
   * after its dependency merged?" requires the merge timestamp rather than
   * inference from diff context lines and assignment gaps (§10).
   */
  mergedAt: Date | null;
  /**
   * When this pull request was closed, merged or not, or `null` if it is open.
   *
   * Distinct from `mergedAt`: a closed-unmerged PR is the signature of an
   * abandoned or superseded attempt, and telling that apart from a merge is the
   * whole point of recording both.
   */
  closedAt: Date | null;
  /**
   * The coding agent's own account of how its sessions on this pull request
   * began and ended, oldest first, from GitHub's `CopilotWork*` timeline
   * events. Empty when GitHub has published none.
   *
   * This is the only *authoritative* liveness signal available. Everything else
   * Factory reads about an in-flight attempt is a proxy — a `[WIP]` title
   * prefix, an absent diff, a stale head commit — and each proxy costs a grace
   * window to interpret, because a proxy cannot distinguish "still working"
   * from "died quietly". These events say which it is, in GitHub's own words,
   * at the moment it happens.
   *
   * A `failed` event carries `message`, GitHub's plain-English reason. That
   * matters beyond latency: some failures are not the Work Item's fault and no
   * number of retries can fix them (an exhausted request quota being the
   * measured case). Retrying those burns the attempt budget and then escalates
   * with a misleading reason, sending a human to debug a brief when the real
   * fix is a billing page.
   */
  agentWorkEvents: AgentWorkEvent[];
}

/** What the coding agent reported about one of its sessions. */
export type AgentWorkEventKind = "started" | "finished" | "failed";

/**
 * One `copilot_work_started` / `copilot_work_finished` /
 * `copilot_work_finished_failure` entry from a pull request's REST timeline.
 */
export interface AgentWorkEvent {
  kind: AgentWorkEventKind;
  at: Date;
  /**
   * GitHub's stated reason, present only on `failed` (`failureMessage`), and
   * `null` otherwise. Quoted verbatim into close and escalation comments — a
   * paraphrase would lose the request ID and the settings URL a human needs.
   */
  message: string | null;
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
  /**
   * The issue's label names. Carried so that `graph_apply`'s `labelled: true`
   * is checkable rather than merely self-reported: a caller that cannot observe
   * labels has no way to tell a successful labelling from a silently unlabelled
   * one.
   */
  labels: string[];
  blockedBy: IssueRef[];
  /** PRs that would close this issue, via `closedByPullRequestsReferences`. */
  linkedPullRequests: LinkedPullRequest[];
  /**
   * Every time the coding agent was assigned, from the issue's `AssignedEvent`
   * timeline (§4.2), oldest first. Empty when it has never been assigned.
   *
   * There is no queryable, per-issue session-status API: the Agent Tasks REST
   * API exposes a task `state` but no issue-reference field, so a task cannot be
   * matched back to the
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
   * applying a compiled Work Item graph (§3). */
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
   * GraphQL node ID of the repository's `factory:work-item` label, or null when
   * the repository has no such label.
   *
   * Resolved here rather than asked of the caller. The label is structural
   * identity — it is how a Work Item is recognisable as one to anything reading
   * the repository from outside Factory — so it belongs on every Work Item
   * automatically rather than on request. The reader resolves the node ID
   * because callers should not have to know how to turn the name
   * `factory:work-item` into a label ID before applying a graph.
   *
   * Null is reported rather than repaired: creating the label here would put
   * Factory in the business of defining a repository's taxonomy behind the
   * operator's back. `graph_apply` says so in its result instead.
   */
  workItemLabelId: string | null;
  /**
   * Node ID of the coding agent's bot actor, discovered via
   * `suggestedActors(capabilities: [CAN_BE_ASSIGNED])`. `null` if the
   * repository has no assignable coding agent.
   */
  copilotBotId: string | null;
  /**
   * Whether this repository is known to run CI on pull requests, so a PR with
   * *no* checks at all should be read as "CI has not reported yet", not as
   * "this repository has no CI".
   *
   * `statusCheckRollup` is computed from check *runs*, so workflow runs that
   * fail at *startup* — zero jobs — never attach a check to the head commit and
   * leave the rollup null with zero contexts. A CI run that cannot start is
   * therefore byte-for-byte indistinguishable from a repository with no CI.
   * This flag supplies the missing distinction; see `evaluateMechanical`'s
   * `checks_missing` verdict.
   *
   * Tri-state, because "I could not find out" is not the same answer as "no".
   * The probe is a REST call, and a 5xx, a rate-limit or a dropped connection
   * says nothing about whether CI exists. Reporting that as `false` reads as
   * "this repository has no CI" and lets a pull request carrying zero checks
   * merge unverified. `"unknown"` therefore blocks like `true` does: the cost
   * of being wrong is a stall a human resolves, against merging untested code.
   */
  ciExpectedOnPullRequests: boolean | "unknown";
}
