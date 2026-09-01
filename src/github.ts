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
import type { WorkflowSafetyProfile } from "./approval.js";
import { referencedSecretNames, triggersOnPullRequest } from "./approval.js";

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
                nodes {
                  commit {
                    oid
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
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { nodes: { path: string }[] };
  commits: { nodes: { commit: { messageHeadline: string } }[] };
  statusCheckRollup: {
    nodes: {
      commit: {
        oid: string;
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
 *
 * `statusCheckRollup` alone is not sufficient, and Gate 3 proved it the
 * expensive way. It is computed from the head commit's check *runs* and status
 * contexts, so a check *suite* that concludes without ever producing a run
 * contributes nothing to it and leaves it `null` — indistinguishable from a
 * repository that has no CI at all. That is not hypothetical: every one of
 * clockgrove/factory-gate3's four pull requests had a `github-actions` check
 * suite with `conclusion: FAILURE` and `latest_check_runs_count: 0` (the
 * workflow failed at startup, so it produced zero jobs), a null rollup, and was
 * merged as `ready`. GitHub had explicitly said "CI failed"; Factory read
 * "no CI". So the suites are consulted whenever the rollup is silent.
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

function toPullRequest(pr: GqlPr): LinkedPullRequest {
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
    headSha: commit?.oid ?? "",
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
  /** Latched once true by `#ciExpectedOnPullRequests`. */
  #ciExpected = false;
  /** Cached for the process lifetime by `readWorkflowSafetyProfile`. */
  #safetyProfile: WorkflowSafetyProfile | undefined;

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
      ciExpectedOnPullRequests: await this.#ciExpectedOnPullRequests(),
    };
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
   * run is created, which is exactly the window Gate 3 merged through.
   */
  async #ciExpectedOnPullRequests(): Promise<boolean> {
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
    } catch {
      // Actions disabled, or no permission to read them. Either way there is no
      // evidence CI is expected, so the flag stays false and the evaluator
      // behaves exactly as it did before this check existed.
      return false;
    }
    return this.#ciExpected;
  }

  /**
   * Read the facts a blast-radius review needs about what an approved workflow
   * run would be *allowed* to do (§10.6).
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
      const workflows = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/actions/workflows",
        { owner: this.#owner, repo: this.#repo, per_page: 100 },
      );
      for (const workflow of workflows.data.workflows) {
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
          if (!data.content) continue;
          const yaml = Buffer.from(data.content, "base64").toString("utf8");
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
   * for "runs belonging to this pull request" — runs carry no PR number.
   *
   * The `action_required` status is the whole signal: it is what GitHub sets on
   * a run it created but refuses to start until a maintainer approves it. A run
   * in any other state needs nothing from us.
   */
  async listRunsAwaitingApproval(headSha: string): Promise<PendingApprovalRun[]> {
    const runs = await this.#octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs",
      {
        owner: this.#owner,
        repo: this.#repo,
        head_sha: headSha,
        status: "action_required",
        per_page: 50,
      },
    );
    return runs.data.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name ?? String(run.id),
      event: run.event,
    }));
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
