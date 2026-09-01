/**
 * GitHub reader (§2).
 *
 * The only job of this module is to turn GitHub into a snapshot. It performs no
 * judgement — every classification lives in `state.ts` — and it performs no
 * writes, which keeps the read path safe to run against a live repository at
 * any time.
 *
 * One GraphQL round trip per cycle where possible (§4.1). PROBE-001 triggered a
 * client-side 429 from naive polling, so throttling and retry are configured
 * rather than optional.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

import type {
  CheckRollup,
  IssueRef,
  LinkedPullRequest,
  MergeableState,
  ObjectiveSnapshot,
  PullRequestDiff,
  PullRequestDiffFile,
  WorkItemSnapshot,
} from "./types.js";
import { COPILOT_LOGIN } from "./types.js";

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
      subIssues(first: 100) {
        nodes {
          id
          number
          title
          state
          assignees(first: 10) { nodes { login } }
          blockedBy(first: 50) { nodes { number state } }
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
                nodes { commit { statusCheckRollup { state } } }
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
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { nodes: { path: string }[] };
  commits: { nodes: { commit: { messageHeadline: string } }[] };
  statusCheckRollup: {
    nodes: { commit: { statusCheckRollup: { state: string } | null } }[];
  };
}

interface GqlAssignedEvent {
  createdAt: string;
  assignee: { login?: string } | null;
}

interface GqlWorkItem extends GqlIssueState {
  id: string;
  number: number;
  title: string;
  assignees: { nodes: { login: string }[] };
  blockedBy: { nodes: ({ number: number } & GqlIssueState)[] };
  closedByPullRequestsReferences: { nodes: GqlPr[] };
  timelineItems: { nodes: GqlAssignedEvent[] };
}

interface GqlSuggestedActor {
  login: string;
  id?: string;
}

interface GqlResponse {
  repository: {
    id: string;
    defaultBranchRef: { name: string } | null;
    suggestedActors: { nodes: GqlSuggestedActor[] };
    issue: {
      id: string;
      number: number;
      title: string;
      body: string;
      state: "OPEN" | "CLOSED";
      subIssues: { nodes: GqlWorkItem[] };
    } | null;
  } | null;
}

/**
 * GitHub reports a rich set of rollup states; the loop only needs to know
 * whether checks have settled and, if so, whether they passed.
 */
function normalizeChecks(pr: GqlPr): CheckRollup {
  const raw = pr.statusCheckRollup.nodes[0]?.commit.statusCheckRollup?.state;
  if (!raw) return null;
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

function toPullRequest(pr: GqlPr): LinkedPullRequest {
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
    checks: normalizeChecks(pr),
    mergeable: pr.mergeable,
    createdAt: new Date(pr.createdAt),
  };
}

/**
 * Every time the coding agent was assigned, from the issue's `AssignedEvent`
 * timeline (§4.2), oldest first. GitHub auto-assigns the requesting human
 * alongside Copilot (verified live, 2026-08-30), so this filters to the
 * agent's own events rather than trusting timeline order or count.
 */
function copilotAssignments(wi: GqlWorkItem): Date[] {
  return wi.timelineItems.nodes
    .filter((e) => e.assignee?.login === COPILOT_LOGIN)
    .map((e) => new Date(e.createdAt))
    .sort((a, b) => a.getTime() - b.getTime());
}

function toWorkItem(wi: GqlWorkItem): WorkItemSnapshot {
  const blockedBy: IssueRef[] = wi.blockedBy.nodes.map((d) => ({
    number: d.number,
    closed: d.state === "CLOSED",
  }));

  return {
    id: wi.id,
    number: wi.number,
    title: wi.title,
    closed: wi.state === "CLOSED",
    assignees: wi.assignees.nodes.map((a) => a.login),
    blockedBy,
    linkedPullRequests:
      wi.closedByPullRequestsReferences.nodes.map(toPullRequest),
    copilotAssignments: copilotAssignments(wi),
  };
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
export function budgetPatches(
  files: RawDiffFile[],
  maxPatchBytes: number,
): { files: PullRequestDiffFile[]; truncated: boolean } {
  let budget = maxPatchBytes;
  let truncated = false;

  const out = files.map((f): PullRequestDiffFile => {
    const base = {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    };

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
   * (§5.1 is mechanical only). Before this method the snapshot exposed
   * `changedFilePaths` but no content, so that half of the bar was unmet by
   * construction: a criterion like "must import and actually call `truncate`,
   * not reimplement it" was uncheckable, and Gate 2 merged four such Work
   * Items on file-path evidence alone (see IMPLEMENTATION-PLAN.md §10.2, F1).
   *
   * Uses the REST files endpoint rather than the `.diff` media type because it
   * returns per-file `additions`/`deletions`/`status` alongside the patch,
   * which is what the bar actually reasons about. GitHub omits `patch` for
   * binary files and for individual files above its own size limit; those come
   * back with `patch: null`, reported honestly rather than silently dropped.
   */
  async readPullRequestDiff(
    pullNumber: number,
    maxPatchBytes = 60_000,
  ): Promise<PullRequestDiff> {
    const files = await this.#octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      {
        owner: this.#owner,
        repo: this.#repo,
        pull_number: pullNumber,
        per_page: 100,
      },
    );

    const { files: entries, truncated } = budgetPatches(files.data, maxPatchBytes);
    return { pullNumber, files: entries, truncated };
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

    const bot = repository.suggestedActors.nodes.find(
      (a) => a.login === COPILOT_LOGIN,
    );

    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      closed: issue.state === "CLOSED",
      workItems: issue.subIssues.nodes.map(toWorkItem),
      readAt: new Date(),
      repositoryId: repository.id,
      defaultBranch: repository.defaultBranchRef.name,
      copilotBotId: bot?.id ?? null,
    };
  }

  /**
   * Resolve a login to its GraphQL node ID, needed once at startup to
   * configure `Dispatcher`'s escalation target (§7.2). A plain, stable
   * `user(login:)` lookup — not part of the per-cycle snapshot.
   */
  async resolveUserId(login: string): Promise<string> {
    const data = await this.#octokit.graphql<{ user: { id: string } | null }>(
      `query ResolveUser($login: String!) { user(login: $login) { id } }`,
      { login },
    );
    if (!data.user) {
      throw new Error(
        `GitHub user '${login}' not found. Check the exact account login — it is not ` +
          `necessarily the prefix of a branch name, an email local-part, or a display name.`,
      );
    }
    return data.user.id;
  }
}
