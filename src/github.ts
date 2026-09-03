/**
 * GitHub reader (§2).
 *
 * The only job of this module is to turn GitHub into a snapshot. It performs no
 * judgement — every classification lives in `state.ts` — and it performs no
 * writes, which keeps the read path safe to run against a live repository at
 * any time.
 *
 * One GraphQL round trip per cycle where possible (§4.1). Naive polling can
 * trigger a client-side 429, so throttling and retry are configured rather than
 * optional.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

import type {
  AgentWorkEvent,
  AgentWorkEventKind,
  CheckRollup,
  IssueRef,
  LinkedPullRequest,
  MergeableState,
  ObjectiveSnapshot,
  PullRequestDiff,
  RepositoryLayout,
  RepositoryFile,
  PullRequestDiffFile,
  WorkItemSnapshot,
} from "./types.js";
import { COPILOT_LOGIN } from "./types.js";
import type { WorkflowSafetyProfile } from "./approval.js";
import {
  referencedSecretNames,
  triggersOnPullRequest,
  usesSelfHostedRunner,
} from "./approval.js";
import { decodeEventComments, latestSupportedRun } from "./control/receipts.js";
import type { FactoryEvent } from "./protocol/events.js";

/** A workflow run parked in `action_required`, awaiting a maintainer's approval. */
export interface PendingApprovalRun {
  id: number;
  name: string;
  event: string;
}

const FactoryOctokit = Octokit.plugin(retry, throttling);

export interface GitHubOptions {
  token: string;
  owner: string;
  repo: string;
  /** Called on throttle/abuse events so the loop can log pacing decisions. */
  onThrottle?: (message: string) => void;
}

/**
 * Fetches the Objective and its Work Items in a single query.
 *
 * `subIssues`, `blockedBy` and `closedByPullRequestsReferences` are all native
 * GitHub relationships (verified against the live schema), which is what makes
 * the "no sidecar state" claim in §3.1 hold.
 */
const OBJECTIVE_QUERY = `
query Objective($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    id
    defaultBranchRef { name }
    workItemLabel: label(name: "factory:work-item") { id }
    suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 10) {
      nodes {
        login
        ... on Bot { id }
      }
    }
    issue(number: $number) {
      id
      number
      title
      body
      state
      author { login }
      authorAssociation
      comments(last: 100) {
        totalCount
        nodes { body author { login } authorAssociation }
      }
      subIssues(first: 100) {
        totalCount
        nodes {
          id
          number
          title
          body
          state
          comments(last: 100) {
            totalCount
            nodes { body author { login } authorAssociation }
          }
          assignees(first: 10) { nodes { login } }
          labels(first: 20) { nodes { name } }
          blockedBy(first: 50) { totalCount nodes { number state } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
            nodes {
              id
              number
              state
              isDraft
              title
              body
              mergeable
              createdAt
              mergedAt
              closedAt
              additions
              deletions
              changedFiles
              files(first: 100) {
                nodes { path }
              }
              commits(first: 100) {
                nodes { commit { messageHeadline } }
              }
              statusCheckRollup: commits(last: 1) {
                nodes {
                  commit {
                    oid
                    committedDate
                    statusCheckRollup { state }
                    checkSuites(first: 20) {
                      nodes {
                        status
                        conclusion
                        checkRuns { totalCount }
                      }
                    }
                  }
                }
              }
            }
          }
          timelineItems(last: 10, itemTypes: [ASSIGNED_EVENT]) {
            nodes {
              ... on AssignedEvent {
                createdAt
                assignee {
                  ... on Bot { login }
                  ... on User { login }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface GqlIssueState {
  state: "OPEN" | "CLOSED";
}

interface GqlPr {
  id: string;
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  title: string;
  body: string;
  mergeable: MergeableState;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { nodes: { path: string }[] };
  commits: { nodes: { commit: { messageHeadline: string } }[] };
  statusCheckRollup: {
    nodes: {
      commit: {
        oid: string;
        committedDate: string;
        statusCheckRollup: { state: string } | null;
        checkSuites: {
          nodes: {
            status: string;
            conclusion: string | null;
            checkRuns: { totalCount: number };
          }[];
        };
      };
    }[];
  };
}

/**
 * A Copilot event from the REST issue-timeline endpoint. GitHub removed the
 * equivalent public GraphQL enum values and object types in September 2026,
 * while retaining these REST events.
 */
export interface RestAgentWorkEvent {
  event?: string;
  created_at?: string;
  failure_message?: string | null;
  message?: string | null;
}

interface GqlAssignedEvent {
  createdAt: string;
  assignee: { login?: string } | null;
}

interface GqlWorkItem extends GqlIssueState {
  id: string;
  number: number;
  title: string;
  body?: string;
  assignees: { nodes: { login: string }[] };
  labels: { nodes: { name: string }[] } | null;
  blockedBy: { totalCount: number; nodes: ({ number: number } & GqlIssueState)[] };
  closedByPullRequestsReferences: { nodes: GqlPr[] };
  timelineItems: { nodes: GqlAssignedEvent[] };
  comments?: GqlComments;
}

interface GqlComment {
  body: string;
  author?: { login?: string } | null;
  authorAssociation?: string;
}

interface GqlComments {
  totalCount: number;
  nodes: GqlComment[];
}

interface GqlSuggestedActor {
  login: string;
  id?: string;
}

interface GqlResponse {
  repository: {
    id: string;
    defaultBranchRef: { name: string } | null;
    workItemLabel: { id: string } | null;
    suggestedActors: { nodes: GqlSuggestedActor[] };
    issue: {
      id: string;
      number: number;
      title: string;
      body: string;
      state: "OPEN" | "CLOSED";
      author?: { login?: string } | null;
      authorAssociation?: string;
      comments?: GqlComments;
      subIssues: { totalCount: number; nodes: GqlWorkItem[] };
    } | null;
  } | null;
}

/**
 * GitHub reports a rich set of rollup states; the loop only needs to know
 * whether checks have settled and, if so, whether they passed.
 *
 * `statusCheckRollup` alone is not sufficient. It is computed from the head
 * commit's check *runs* and status contexts, so a check *suite* that concludes
 * without ever producing a run contributes nothing to it and leaves it `null` —
 * indistinguishable from a repository that has no CI at all. A workflow that
 * fails at startup produces zero jobs, so its `github-actions` suite can report
 * `conclusion: FAILURE` and `latest_check_runs_count: 0` while the rollup stays
 * null. Suites are therefore consulted whenever the rollup is silent.
 */
function normalizeChecks(pr: GqlPr): CheckRollup {
  const commit = pr.statusCheckRollup.nodes[0]?.commit;
  const raw = commit?.statusCheckRollup?.state;
  if (raw) {
    switch (raw) {
      case "PENDING":
      case "EXPECTED":
        return "PENDING";
      case "SUCCESS":
        return "SUCCESS";
      default:
        // FAILURE, ERROR — terminal and unsuccessful.
        return "FAILURE";
    }
  }
  return runlessSuiteVerdict(commit?.checkSuites.nodes ?? []);
}

/**
 * The verdict implied by check suites the rollup could not see — those that
 * produced no check runs. A suite still in flight means checks are coming; a
 * suite that finished badly without emitting a run means CI broke before it
 * could report, which is a failure and must never be read as an absence.
 */
export function runlessSuiteVerdict(
  suites: { status: string; conclusion: string | null; checkRuns: { totalCount: number } }[],
): CheckRollup {
  const runless = suites.filter((s) => s.checkRuns.totalCount === 0);
  if (runless.length === 0) return null;
  if (runless.some((s) => s.status !== "COMPLETED")) return "PENDING";
  // `SUCCESS`/`NEUTRAL`/`SKIPPED` with no runs means nothing was required of
  // this commit — genuinely nothing to report, so stay silent. Anything else
  // (FAILURE, STARTUP_FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED) is CI
  // telling us it did not pass.
  const benign = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", null]);
  return runless.some((s) => !benign.has(s.conclusion)) ? "FAILURE" : null;
}

/**
 * Map GitHub's GraphQL pull request shape onto Factory's own. Exported for
 * tests: every field here is either read by a derivation or reported to a
 * Director, and a silently wrong mapping (a timestamp that never populates, a
 * fallback that never fires) is invisible until it matters.
 */
export function toPullRequest(
  pr: GqlPr,
  agentWorkEvents: AgentWorkEvent[] = [],
): LinkedPullRequest {
  const commit = pr.statusCheckRollup.nodes[0]?.commit;
  const checks = normalizeChecks(pr);
  return {
    id: pr.id,
    number: pr.number,
    state: pr.state,
    isDraft: pr.isDraft,
    title: pr.title,
    body: pr.body ?? "",
    changedLines: pr.additions + pr.deletions,
    changedFiles: pr.changedFiles,
    changedFilePaths: pr.files.nodes.map((n) => n.path),
    commitSubjects: pr.commits.nodes.map((n) => n.commit.messageHeadline),
    checks,
    checksNeverStarted:
      checks === "FAILURE" && !commit?.statusCheckRollup?.state,
    mergeable: pr.mergeable,
    createdAt: new Date(pr.createdAt),
    mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
    closedAt: pr.closedAt ? new Date(pr.closedAt) : null,
    headSha: commit?.oid ?? "",
    // Falling back to the PR's own creation time keeps the field a real Date
    // even for the (unobserved) case of a pull request with no commits: a
    // brand-new PR is then trivially "recently active", which errs toward
    // waiting rather than toward closing something live.
    headCommittedAt: commit?.committedDate
      ? new Date(commit.committedDate)
      : new Date(pr.createdAt),
    agentWorkEvents,
  };
}

/** REST event name to the kind `state.ts` reasons about. */
const AGENT_EVENT_KINDS: Record<string, AgentWorkEventKind> = {
  copilot_work_started: "started",
  copilot_work_finished: "finished",
  copilot_work_finished_failure: "failed",
};

/**
 * Map REST issue-timeline entries to `AgentWorkEvent`s, oldest first.
 *
 * Unrecognised event names are dropped rather than guessed at: GitHub may add
 * event types, and a node whose meaning Factory does not know must not be
 * allowed to look like a completion or a failure. Sorted explicitly rather than
 * trusting GitHub's ordering, because "which event came last" is the entire
 * basis of the liveness read (§5.1) and must not depend on an unstated
 * guarantee.
 */
export function toAgentWorkEvents(nodes: RestAgentWorkEvent[]): AgentWorkEvent[] {
  return nodes
    .flatMap((n) => {
      const kind = n.event ? AGENT_EVENT_KINDS[n.event] : undefined;
      const at = new Date(n.created_at ?? "");
      if (!kind || !Number.isFinite(at.getTime())) return [];
      return [{
        kind,
        at,
        message: n.failure_message ?? n.message ?? null,
      }];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Every time the coding agent was assigned, from the issue's `AssignedEvent`
 * timeline (§4.2), oldest first. GitHub auto-assigns the requesting human
 * alongside Copilot, so this filters to the agent's own events rather than
 * trusting timeline order or count.
 */
function copilotAssignments(wi: GqlWorkItem): Date[] {
  return wi.timelineItems.nodes
    .filter((e) => e.assignee?.login === COPILOT_LOGIN)
    .map((e) => new Date(e.createdAt))
    .sort((a, b) => a.getTime() - b.getTime());
}

function toWorkItem(
  wi: GqlWorkItem,
  eventsByPullRequest: ReadonlyMap<number, AgentWorkEvent[]>,
  v2: boolean,
  actorsByRun: ReadonlyMap<string, string> = new Map(),
  activeRunId?: string,
): WorkItemSnapshot {
  if (wi.blockedBy.totalCount > wi.blockedBy.nodes.length) {
    throw new Error(`Work Item #${wi.number} has too many dependencies for a complete snapshot`);
  }
  const blockedBy: IssueRef[] = wi.blockedBy.nodes.map((d) => ({
    number: d.number,
    closed: d.state === "CLOSED",
  }));

  const result: WorkItemSnapshot = {
    id: wi.id,
    number: wi.number,
    title: wi.title,
    body: wi.body ?? "",
    closed: wi.state === "CLOSED",
    assignees: wi.assignees.nodes.map((a) => a.login),
    labels: wi.labels?.nodes.map((l) => l.name) ?? [],
    blockedBy,
    linkedPullRequests: wi.closedByPullRequestsReferences.nodes.map((pr) =>
      toPullRequest(pr, eventsByPullRequest.get(pr.number) ?? []),
    ),
    copilotAssignments: copilotAssignments(wi),
  };
  if (v2) {
    result.factoryEvents = factoryEvents(
      wi.comments,
      `Work Item #${wi.number}`,
      actorsByRun,
    ).filter((event) => !activeRunId || event.runId === activeRunId);
  }
  return result;
}

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function factoryEvents(
  comments: GqlComments | undefined,
  subject: string,
  actorsByRun?: ReadonlyMap<string, string>,
): FactoryEvent[] {
  if (!comments) return [];
  if (comments.totalCount > comments.nodes.length) {
    throw new Error(`${subject} Factory event history is incomplete`);
  }
  const parsed = comments.nodes.flatMap((comment) => {
    const events = decodeEventComments(comment.body);
    if (events.length === 0) return [];
    const login = comment.author?.login;
    if (!login || !TRUSTED_ASSOCIATIONS.has(comment.authorAssociation ?? "")) {
      return [];
    }
    return events.map((event) => ({ event, login }));
  });

  // The activating identity is authenticated by GitHub as the author of the
  // RunStarted comment. Every later receipt must come from that same identity;
  // an issue participant cannot forge state by pasting a Factory envelope.
  const runActors = actorsByRun
    ? new Map(actorsByRun)
    : new Map(
        parsed.flatMap(({ event, login }) =>
          event.kind === "run" &&
          event.event === "FactoryRunStarted" &&
          event.actor.toLowerCase() === login.toLowerCase()
            ? [[event.runId, login] as const]
            : [],
        ),
      );
  return parsed
    .filter(({ event, login }) =>
      runActors.get(event.runId)?.toLowerCase() === login.toLowerCase(),
    )
    .map(({ event }) => event);
}

/**
 * Shared low-level client construction. Exported so `dispatch.ts` can build
 * its own client for writes without duplicating the retry/throttle config —
 * this is plumbing, not a reader method, so it does not compromise the "no
 * writes" contract above.
 */
export function createOctokit(opts: GitHubOptions): Octokit {
  const notify = opts.onThrottle ?? (() => {});
  return new FactoryOctokit({
    auth: opts.token,
    throttle: {
      onRateLimit: (after: number, o: { method: string; url: string }) => {
        notify(`rate limit on ${o.method} ${o.url}; retrying in ${after}s`);
        return true;
      },
      onSecondaryRateLimit: (
        after: number,
        o: { method: string; url: string },
      ) => {
        notify(`secondary limit on ${o.method} ${o.url}; retrying in ${after}s`);
        return true;
      },
    },
  });
}

/**
 * Apply a total size budget across a pull request's file patches (§7.3).
 *
 * Pure, so the budgeting rules are testable without touching the network —
 * `readPullRequestDiff` is then a thin fetch around this. Files are consumed in
 * order and each one either fits, is cut short, or is dropped once the budget
 * is gone; every case that withholds content sets `patchOmitted`, so a caller
 * can always distinguish "this file changed nothing worth showing" from "this
 * file's changes were withheld from you".
 */
/**
 * Decide what one contents-API response actually says, separated from the fetch
 * so every branch is testable — the reader builds its own Octokit and cannot be
 * exercised from a unit test.
 *
 * Each branch here matches a contents API response shape rather than an assumed
 * one. The distinctions matter:
 *
 *   - A **directory** comes back as a JSON *array* of entries, with no `type`
 *     field on the response at all. Checking `type` first misreports it.
 *   - A **genuinely empty file** returns `type: "file"`, `content: ""` and
 *     `size: 0`. A file **over 1 MB** returns `type: "file"` and `content: ""`
 *     as well — `size` is the only thing separating "this file is empty" from
 *     "this file was too big to send you", and conflating them would report a
 *     large file's contents as empty.
 */
export function interpretContentsResponse(
  path: string,
  body: unknown,
  maxBytes: number,
): RepositoryFile {
  if (Array.isArray(body)) {
    return {
      path,
      exists: true,
      truncated: false,
      unreadable: `not a file (directory with ${body.length} entries) — use read_repository_layout with pathPrefix instead`,
    };
  }
  const data = (body ?? {}) as {
    content?: string;
    type?: string;
    size?: number;
    target?: string | null;
    submodule_git_url?: string | null;
  };
  if (data.type !== "file" || typeof data.content !== "string") {
    // A symlink to a *directory* comes back `type: "symlink"` with `content: null` and the link
    // in `target`; a submodule comes back `type: "submodule"` with
    // `submodule_git_url`. Both land here rather than being mistaken for files.
    // A symlink to a *file* never reaches this branch at all — GitHub resolves
    // it and returns `type: "file"` with the target's real content and size,
    // which is what a caller wants.
    const where = data.target ?? data.submodule_git_url;
    return {
      path,
      exists: true,
      truncated: false,
      unreadable: `not a file (${data.type ?? "unknown"})${where ? ` — points at ${where}` : ""}`,
    };
  }
  if (data.content === "" && (data.size ?? 0) > 0) {
    return {
      path,
      exists: true,
      truncated: true,
      unreadable: `no content returned for a ${data.size}-byte file — the contents API omits it above 1 MB`,
    };
  }
  const text = Buffer.from(data.content, "base64").toString("utf8");
  const clipped = text.length > maxBytes;
  return {
    path,
    exists: true,
    content: clipped ? text.slice(0, maxBytes) : text,
    truncated: clipped,
  };
}

/**
 * Whether `path` was asked for. Mirrors the Work Item `scope` matching in
 * `evaluate.ts` so a caller can pass a Work Item's declared scope straight
 * through: an entry ending in `/` selects a directory, anything else must match
 * exactly.
 */
function isRequested(path: string, paths: string[]): boolean {
  return paths.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );
}

export function budgetPatches(
  files: RawDiffFile[],
  maxPatchBytes: number,
  paths?: string[],
): { files: PullRequestDiffFile[]; truncated: boolean } {
  let budget = maxPatchBytes;
  let truncated = false;
  const filtering = paths !== undefined && paths.length > 0;

  const out = files.map((f): PullRequestDiffFile => {
    const base = {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    };

    // Spend no budget on a file the caller did not ask for. `package-lock.json`
    // sorts first and can consume the entire allowance, leaving the files
    // actually under review as `patch: null` — on any pull request carrying a
    // lockfile, generated file or vendored bundle, the review-critical files are
    // precisely the ones you cannot see.
    //
    // Deliberately still *listed*, with `additions`/`deletions` intact: the
    // blast-radius review and the scope checks reason about the complete file
    // list, and silently dropping entries here would tell them the pull request
    // is smaller than it is.
    if (filtering && !isRequested(f.filename, paths)) {
      return {
        ...base,
        patch: null,
        patchOmitted: "not requested; add this path to `paths` to read it",
      };
    }

    if (f.patch === null || f.patch === undefined) {
      return {
        ...base,
        patch: null,
        patchOmitted: "binary, or too large for GitHub to return a patch",
      };
    }
    if (budget <= 0) {
      truncated = true;
      return {
        ...base,
        patch: null,
        patchOmitted: "read budget exhausted; re-read this file with a larger maxPatchBytes",
      };
    }

    const slice = f.patch.length > budget ? f.patch.slice(0, budget) : f.patch;
    budget -= slice.length;
    if (slice.length < f.patch.length) {
      truncated = true;
      return { ...base, patch: slice, patchOmitted: "truncated mid-file" };
    }
    return { ...base, patch: slice };
  });

  return { files: out, truncated };
}

/** The subset of GitHub's PR-files REST payload that `budgetPatches` reads. */
export interface RawDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | null | undefined;
}

export class GitHubReader {
  readonly #octokit: Octokit;
  readonly #owner: string;
  readonly #repo: string;
  /** Latched once true by `#ciExpectedOnPullRequests`. */
  #ciExpected = false;
  /** Cached for the process lifetime by `readWorkflowSafetyProfile`. */
  #safetyProfile: WorkflowSafetyProfile | undefined;
  #cachedDefaultBranch: string | undefined;

  constructor(opts: GitHubOptions) {
    this.#owner = opts.owner;
    this.#repo = opts.repo;
    this.#octokit = createOctokit(opts);
  }

  /**
   * Read the actual patch text of a pull request, per file (§7.3).
   *
   * This exists because the confidence bar requires Director to judge that
   * "the diff satisfies the Work Item's acceptance criteria and nothing more"
   * — a *semantic* check that `evaluate_mechanical` deliberately does not make
   * (§5.1 is mechanical only). Without patch text the snapshot exposes
   * `changedFilePaths` but no content, so that half of the bar is unmet by
   * construction: a criterion like "must import and actually call `truncate`,
   * not reimplement it" is uncheckable from file-path evidence alone (§10).
   *
   * Uses the REST files endpoint rather than the `.diff` media type because it
   * returns per-file `additions`/`deletions`/`status` alongside the patch,
   * which is what the bar actually reasons about. GitHub omits `patch` for
   * binary files and for individual files above its own size limit; those come
   * back with `patch: null`, reported honestly rather than silently dropped.
   *
   * `paths` restricts which files spend the byte budget (§10). The
   * budget is otherwise first-come-first-served in GitHub's ordering, so one
   * large file early in the alphabet starves every file after it —
   * `package-lock.json` consumed a 4000-byte allowance whole and left the three
   * files under review with `patch: null`. Pass a Work Item's declared `scope`
   * (the matching rules are the same: a trailing `/` selects a directory) to
   * spend the whole budget on the files the review is about.
   *
   * Filtered-out files are still listed, with `status`, `additions` and
   * `deletions` intact and `patchOmitted` explaining why — the complete file
   * list is what the blast-radius review and the scope checks reason about, and
   * shortening it would misreport the size of the change. For the same reason
   * `truncated` stays `false` when content is withheld only by `paths`: it means
   * "content you asked for was cut", and a filtered file was not asked for.
   */
  async readPullRequestDiff(
    pullNumber: number,
    maxPatchBytes = 60_000,
    paths?: string[],
  ): Promise<PullRequestDiff> {
    // Paginated, not a single page. A one-page read made `truncated: false`
    // assert only "you have every patch I fetched" while callers — the
    // blast-radius review above all — read it as "you have every file in the
    // pull request". A PR with 101 files, all patches small enough to stay
    // inside the byte budget, would then be reported as complete with the 101st
    // file silently absent.
    const raw: RawDiffFile[] = [];
    let incomplete = false;
    // GitHub caps this endpoint at 3000 files however hard you paginate, so 30
    // pages is the real ceiling rather than an arbitrary one. A pull request
    // larger than that cannot be enumerated, which is exactly the case a
    // deny-by-default caller must be told about.
    const maxPages = 30;
    for (let page = 1; page <= maxPages; page++) {
      const response = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          owner: this.#owner,
          repo: this.#repo,
          pull_number: pullNumber,
          per_page: 100,
          page,
        },
      );
      raw.push(...response.data);
      if (response.data.length < 100) break;
      if (page === maxPages) incomplete = true;
    }

    const { files: entries, truncated } = budgetPatches(raw, maxPatchBytes, paths);
    return { pullNumber, files: entries, truncated: truncated || incomplete };
  }

  /**
   * List every file on the default branch, so compilation can ground a Work
   * Item's `scope` in the repository as it actually is.
   *
   * Without this, `scope` is compiled purely by inferring conventional
   * structure from the Objective's prose. A wrong guess does not fail at compile
   * time — it fails several steps later as an `untouched` verdict, after an
   * agent run has been spent, and reads like the agent ignored its brief rather
   * than like the brief named a path that was never there.
   *
   * One recursive tree request rather than walking directories: `truncated`
   * here is GitHub's own flag, raised on repositories too large to return in
   * one response, and is reported rather than worked around. Blobs only —
   * directory entries are implied by the paths and would only spend budget.
   */
  async readRepositoryLayout(
    pathPrefix?: string,
    maxEntries = 2_000,
  ): Promise<RepositoryLayout> {
    const branch = await this.#defaultBranch();
    const tree = await this.#octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      {
        owner: this.#owner,
        repo: this.#repo,
        tree_sha: branch,
        recursive: "1",
      },
    );
    const all = tree.data.tree
      .filter((e) => e.type === "blob" && typeof e.path === "string")
      .map((e) => e.path as string);
    const matched = pathPrefix ? all.filter((p) => p.startsWith(pathPrefix)) : all;
    matched.sort();
    const files = matched.slice(0, maxEntries);
    return {
      defaultBranch: branch,
      files,
      totalFiles: matched.length,
      // Either GitHub could not return the whole tree, or we cut it ourselves.
      // Collapsing both into one flag would let a caller believe it had seen
      // every file when it had not, which is the mistake this whole method
      // exists to prevent.
      truncated: Boolean(tree.data.truncated) || files.length < matched.length,
      treeTruncatedByGitHub: Boolean(tree.data.truncated),
    };
  }

  /**
   * Read one file's text from the default branch, for the questions a layout
   * cannot answer — whether a helper already exists, what a test file's
   * conventions are, which runner `package.json` declares.
   *
   * Returns `exists: false` rather than throwing on 404, because "this path is
   * not in the repository" is a normal, informative answer during compilation
   * and not an error worth aborting a cycle over.
   *
   * But the contents API answers 404 to two very different questions — "no such
   * path" and "no such repository, or none you can see" — and compilation acts
   * on the difference. A bad `owner`/`repo` or a token without access would
   * otherwise return a confident `exists: false` for every path asked about, and
   * the graph would be compiled to create files that already exist. So a 404 is
   * only reported as a missing path once the repository itself is confirmed
   * readable; `#defaultBranch()` caches, so this costs one request per reader.
   */
  async readRepositoryFile(
    path: string,
    maxBytes = 40_000,
  ): Promise<RepositoryFile> {
    let response;
    try {
      response = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner: this.#owner, repo: this.#repo, path },
      );
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        try {
          await this.#defaultBranch();
        } catch {
          throw new Error(
            `cannot read ${this.#owner}/${this.#repo} — the repository does not ` +
              `exist or this token cannot see it. Not reporting "${path}" as ` +
              `missing, because every path would look missing.`,
          );
        }
        return { path, exists: false, truncated: false };
      }
      throw error;
    }
    return interpretContentsResponse(path, response.data, maxBytes);
  }

  async #defaultBranch(): Promise<string> {
    if (this.#cachedDefaultBranch) return this.#cachedDefaultBranch;
    const repo = await this.#octokit.request("GET /repos/{owner}/{repo}", {
      owner: this.#owner,
      repo: this.#repo,
    });
    this.#cachedDefaultBranch = repo.data.default_branch;
    return this.#cachedDefaultBranch;
  }

  /** Read one Objective and everything derivable about its Work Items. */
  async readObjective(number: number): Promise<ObjectiveSnapshot> {
    const data = await this.#octokit.graphql<GqlResponse>(OBJECTIVE_QUERY, {
      owner: this.#owner,
      repo: this.#repo,
      number,
    });

    const repository = data.repository;
    const issue = repository?.issue;
    if (!repository || !issue) {
      throw new Error(
        `Objective #${number} not found in ${this.#owner}/${this.#repo}`,
      );
    }

    if (!repository.defaultBranchRef) {
      throw new Error(
        `${this.#owner}/${this.#repo} has no default branch (empty repository?)`,
      );
    }
    if (issue.subIssues.totalCount > issue.subIssues.nodes.length) {
      throw new Error(`Objective #${number} has more than 100 Work Items`);
    }

    const bot = repository.suggestedActors.nodes.find(
      (a) => a.login === COPILOT_LOGIN,
    );
    const hydratedObjectiveComments = await this.#completeComments(
      issue.number,
      issue.comments,
    );
    if (hydratedObjectiveComments) issue.comments = hydratedObjectiveComments;
    for (const workItem of issue.subIssues.nodes) {
      const hydrated = await this.#completeComments(
        workItem.number,
        workItem.comments,
      );
      if (hydrated) workItem.comments = hydrated;
    }
    const objectiveEvents = factoryEvents(issue.comments, `Objective #${issue.number}`);
    const v2 = objectiveEvents.some((event) => event.protocol === "clockgrove.factory/v2");
    const actorsByRun = new Map(
      objectiveEvents.flatMap((event) =>
        event.kind === "run" && event.event === "FactoryRunStarted"
          ? [[event.runId, event.actor] as const]
          : [],
      ),
    );
    const activeRun = latestSupportedRun(objectiveEvents);
    const agentWorkEvents = await this.#readAgentWorkEvents(issue.subIssues.nodes);

    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      ...(issue.author?.login ? { authorLogin: issue.author.login } : {}),
      ...(issue.authorAssociation ? { authorAssociation: issue.authorAssociation } : {}),
      body: issue.body,
      closed: issue.state === "CLOSED",
      workItems: issue.subIssues.nodes.map((wi) =>
        toWorkItem(wi, agentWorkEvents, v2, actorsByRun, activeRun?.runId),
      ),
      readAt: new Date(),
      repositoryId: repository.id,
      defaultBranch: repository.defaultBranchRef.name,
      workItemLabelId: repository.workItemLabel?.id ?? null,
      copilotBotId: bot?.id ?? null,
      ciExpectedOnPullRequests: await this.#ciExpectedOnPullRequests(),
      ...(v2 ? { factoryEvents: objectiveEvents } : {}),
    };
  }

  /**
   * GraphQL keeps the common one-request snapshot fast. If a subject exceeds
   * that bounded page, hydrate the complete durable event log through REST
   * instead of failing or silently dropping older receipts.
   */
  async #completeComments(
    issueNumber: number,
    comments: GqlComments | undefined,
  ): Promise<GqlComments | undefined> {
    if (!comments || comments.totalCount <= comments.nodes.length) return comments;
    const nodes: GqlComment[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: this.#owner,
          repo: this.#repo,
          issue_number: issueNumber,
          per_page: 100,
          page,
        },
      );
      nodes.push(
        ...response.data.map((comment) => ({
          body: comment.body ?? "",
          author: comment.user ? { login: comment.user.login } : null,
          authorAssociation: comment.author_association,
        })),
      );
      if (response.data.length < 100) break;
    }
    if (nodes.length !== comments.totalCount) {
      throw new Error(
        `Issue #${issueNumber} comment history changed during reconstruction; retry the snapshot`,
      );
    }
    return { totalCount: nodes.length, nodes };
  }

  /**
   * Read Copilot session events for current attempts through REST.
   *
   * GitHub's public GraphQL schema no longer contains the Copilot timeline
   * types, so mentioning them makes the entire Objective query invalid even
   * when there are no Work Items. The REST issue timeline still reports the
   * measured event names. Only open linked pull requests can be a current
   * attempt, which keeps the companion reads proportional to active work and
   * avoids re-reading every closed historical attempt on every cycle.
   */
  async #readAgentWorkEvents(
    workItems: GqlWorkItem[],
  ): Promise<Map<number, AgentWorkEvent[]>> {
    const openPullRequests = new Set<number>();
    for (const workItem of workItems) {
      for (const pullRequest of workItem.closedByPullRequestsReferences.nodes) {
        if (pullRequest.state === "OPEN") openPullRequests.add(pullRequest.number);
      }
    }

    const result = new Map<number, AgentWorkEvent[]>();
    for (const pullNumber of openPullRequests) {
      const timeline: RestAgentWorkEvent[] = [];
      for (let page = 1; ; page++) {
        const response = await this.#octokit.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
          {
            owner: this.#owner,
            repo: this.#repo,
            issue_number: pullNumber,
            per_page: 100,
            page,
            headers: { accept: "application/vnd.github+json" },
          },
        );
        timeline.push(...(response.data as RestAgentWorkEvent[]));
        if (response.data.length < 100) break;
      }
      result.set(pullNumber, toAgentWorkEvents(timeline));
    }
    return result;
  }

  /**
   * Whether this repository has ever run a workflow on a `pull_request` event.
   *
   * One cheap REST call (`per_page=1`, only `total_count` is read), and the
   * answer is latched once true — a repository that runs CI on pull requests
   * does not stop being one mid-Objective, so the call is made at most once per
   * process after the first positive.
   *
   * Deliberately evidence-based rather than configuration-based: listing
   * workflows would say a repository *has* Actions, but not whether any of them
   * apply to pull requests (a release-only or schedule-only workflow would then
   * block every merge forever). Asking whether a `pull_request` run has ever
   * existed answers the question that actually matters. It also degrades
   * gracefully — the run created for the PR under review counts, so even the
   * first pull request a repository ever receives is covered as soon as its own
   * run is created, which is the window before checks attach to the commit.
   *
   * Returns `"unknown"` rather than `false` when the probe itself fails. A 5xx,
   * a rate-limit or a dropped connection says nothing about whether CI exists,
   * and reporting it as `false` told the evaluator "this repository has no CI"
   * — merging a pull request with zero checks on the strength of a network
   * error. `"unknown"` is not latched: the next cycle asks again, so a
   * transient failure costs one cycle of caution rather than poisoning the
   * process.
   */
  async #ciExpectedOnPullRequests(): Promise<boolean | "unknown"> {
    if (this.#ciExpected) return true;
    try {
      const runs = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/actions/runs",
        {
          owner: this.#owner,
          repo: this.#repo,
          event: "pull_request",
          per_page: 1,
        },
      );
      if (runs.data.total_count > 0) this.#ciExpected = true;
    } catch (error) {
      // 404 and 403 are the API answering: Actions is disabled for this
      // repository, or this token may not read it. Both are settled facts about
      // what evidence is obtainable, and a repository with Actions off genuinely
      // has no pull-request CI — so `false` is honest and the loop proceeds.
      //
      // Anything else — 5xx, a rate limit, a socket error — is the probe
      // failing, not an answer. Those become `"unknown"`, which blocks.
      const status = (error as { status?: number } | null)?.status;
      if (status === 404 || status === 403) return false;
      return "unknown";
    }
    return this.#ciExpected;
  }

  /**
   * Read the facts a blast-radius review needs about what an approved workflow
   * run would be *allowed* to do (§9).
   *
   * Two questions, two sources: the repo's default token scope, and whether any
   * pull-request workflow pulls in a real secret. Both are properties of the
   * base branch, not of the pull request, which is the point — they describe the
   * job the diff would be run *by*, and the review separately proves the diff
   * cannot change that job.
   *
   * Cached for the process lifetime: these are settings, they do not move
   * within a cycle, and re-reading them per Work Item would burn rate limit for
   * no new information.
   *
   * Fails closed. Any error leaves `defaultWorkflowPermissions: "unknown"`,
   * which `assessBlastRadius` treats as a blocker — a review that cannot see the
   * token scope has not established anything.
   */
  async readWorkflowSafetyProfile(): Promise<WorkflowSafetyProfile> {
    if (this.#safetyProfile) return this.#safetyProfile;

    let defaultWorkflowPermissions: WorkflowSafetyProfile["defaultWorkflowPermissions"] =
      "unknown";
    try {
      const perms = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/actions/permissions/workflow",
        { owner: this.#owner, repo: this.#repo },
      );
      const value = perms.data.default_workflow_permissions;
      if (value === "read" || value === "write") defaultWorkflowPermissions = value;
    } catch {
      // Leave it "unknown" so the assessor denies rather than assuming "read".
    }

    const referencedSecrets = new Set<string>();
    try {
      const workflows: { state: string; path: string }[] = [];
      for (let page = 1; page <= 10; page++) {
        const response = await this.#octokit.request(
          "GET /repos/{owner}/{repo}/actions/workflows",
          { owner: this.#owner, repo: this.#repo, per_page: 100, page },
        );
        workflows.push(...response.data.workflows);
        if (response.data.workflows.length < 100) break;
      }
      for (const workflow of workflows) {
        // A disabled workflow cannot be started by approving a run.
        if (workflow.state !== "active") continue;
        // Not every listed workflow is a file in the repository. GitHub reports
        // its own managed workflows — the Copilot coding agent and the Copilot
        // reviewer — with synthetic `dynamic/...` paths that 404 on the contents
        // API (verified live against a Copilot-enabled repo). They are also not
        // interesting: a pull request cannot edit them, and they are not what an
        // approved `pull_request` run executes. Skipping them by path is what
        // keeps this method from failing closed on every repo Factory works on.
        if (!workflow.path.startsWith(".github/")) continue;
        try {
          const file = await this.#octokit.request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            { owner: this.#owner, repo: this.#repo, path: workflow.path },
          );
          const data = file.data as { content?: string };
          if (!data.content) {
            // Not a success case. The contents API returns 200 with empty
            // content for files over 1 MB, and omits the field entirely for
            // submodules and symlinks — none of which reach the catch below. A
            // `continue` here would drop a real workflow from the scan while
            // still reporting "no secrets found".
            referencedSecrets.add(`<unreadable: ${workflow.path}>`);
            continue;
          }
          const yaml = Buffer.from(data.content, "base64").toString("utf8");
          if (usesSelfHostedRunner(yaml)) {
            referencedSecrets.add(`<self-hosted runner: ${workflow.path}>`);
          }
          if (!triggersOnPullRequest(yaml)) continue;
          for (const name of referencedSecretNames(yaml)) referencedSecrets.add(name);
        } catch {
          // Scoped to this one workflow: a real repository workflow we cannot
          // read is a genuine gap in the review, so it denies — but it must not
          // be conflated with the managed-workflow case handled above.
          referencedSecrets.add(`<unreadable: ${workflow.path}>`);
        }
      }
    } catch {
      // Cannot even list the workflows, so cannot claim they hold no secrets.
      referencedSecrets.add("<unreadable: workflows could not be listed>");
    }

    this.#safetyProfile = {
      defaultWorkflowPermissions,
      referencedSecrets: [...referencedSecrets].sort(),
    };
    return this.#safetyProfile;
  }

  /**
   * List workflow runs for a head commit that are parked awaiting approval.
   *
   * Filtered by `head_sha` because that is the only handle the REST API offers
   * for "runs belonging to this pull request" — runs carry no PR number. An
   * empty SHA is refused rather than sent: GitHub treats an empty `head_sha` as
   * an absent filter, which would return every held run in the repository and
   * turn "unknown head commit" into "match everything" inside a write path.
   *
   * The `action_required` status is the whole signal: it is what GitHub sets on
   * a run it created but refuses to start until a maintainer approves it. A run
   * in any other state needs nothing from us.
   *
   * Only pull-request events are returned. `readWorkflowSafetyProfile` scopes
   * its secret scan to pull-request-triggered workflows, so approving a `push`
   * or `workflow_dispatch` run would act on a wider set than the review covered
   * — the two must describe the same set or the assurances are false. Held runs
   * from other events are reported separately so Director can escalate them.
   */
  async listRunsAwaitingApproval(headSha: string): Promise<{
    approvable: PendingApprovalRun[];
    otherEvents: PendingApprovalRun[];
  }> {
    if (!headSha) {
      throw new Error(
        "cannot list held workflow runs without a head commit SHA; an empty SHA would match every held run in the repository",
      );
    }
    const runs = await this.#octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs",
      {
        owner: this.#owner,
        repo: this.#repo,
        head_sha: headSha,
        status: "action_required",
        per_page: 100,
      },
    );
    const all = runs.data.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name ?? String(run.id),
      event: run.event,
    }));
    return {
      approvable: all.filter(
        (r) => r.event === "pull_request" || r.event === "pull_request_target",
      ),
      otherEvents: all.filter(
        (r) => r.event !== "pull_request" && r.event !== "pull_request_target",
      ),
    };
  }

  /**
   * Resolve a login to its GraphQL node ID, needed once at startup to
   * configure `Dispatcher`'s escalation target (§7.2). A plain, stable
   * `user(login:)` lookup — not part of the per-cycle snapshot.
   */
  async resolveUserId(login: string): Promise<string> {
    // GitHub does not return `user: null` for an unknown login — it fails the
    // whole GraphQL request with a NOT_FOUND error, so the guidance below has
    // to be attached to a thrown error, not to a null check. (Verified live:
    // an unknown login yields "Could not resolve to a User with the login of
    // '<x>'." rather than a null field.) The null branch is kept anyway, since
    // it costs nothing and the schema does declare the field nullable.
    let data: { user: { id: string } | null };
    try {
      data = await this.#octokit.graphql<{ user: { id: string } | null }>(
        `query ResolveUser($login: String!) { user(login: $login) { id } }`,
        { login },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not resolve to a User/i.test(message)) {
        throw new Error(`${notFoundMessage(login)} (GitHub said: ${message.trim()})`);
      }
      throw error;
    }
    if (!data.user) throw new Error(notFoundMessage(login));
    return data.user.id;
  }
}

function notFoundMessage(login: string): string {
  return (
    `GitHub user '${login}' not found. Check the exact account login: it is not necessarily ` +
    `the prefix of a branch name, an email local-part, or a display name. If this login was ` +
    `going to be used as an escalation target, it would have failed at the moment a human was ` +
    `needed — resolve it now instead.`
  );
}
