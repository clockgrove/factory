import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crashPoint } from "./crash.js";
import { hold, type Outcome, objectiveWide } from "./engine.js";
import { redact } from "./log.js";
import { errorMessage } from "./text.js";

const run = promisify(execFile);

/** Network trouble, 5xx, rate limits, timeouts: try again later. */
export class TransientError extends Error {
  constructor(
    message: string,
    /** When GitHub said to come back, if it did. */
    readonly retryAfterMs?: number,
    /**
     * A rate limit (429, or a 403 rate limit): `retryAfterMs` is when it
     * resets. Otherwise it is only a backoff hint (a 5xx's retry-after).
     */
    readonly limited = false,
  ) {
    super(message);
  }
}

/**
 * A preview-API answer (native stacks) in a shape Factory can't read. It
 * is a TransientError, so it retries wherever it escapes; delivery turns a
 * run of them into a question after GitHub's lag window.
 */
export class Unreadable extends TransientError {}

/** GitHub answered, and the answer won't change by asking again: 404, 422. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The response body as JSON, when it was JSON. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 60_000;

/**
 * A GitHub failure as a step outcome (CORE.md#Waits): only what a person
 * must fix holds, at once: a rejected login (401), a refusal (403; rate
 * limits are TransientErrors) naming the `permission` the call needs, and
 * a missing repository or issue (404, `missing`). A rate limit waits for
 * its reset. Everything else (5xx, timeouts, 409, 410, 422, GraphQL
 * errors) may change, so it retries as an unknown transient wait; a 5xx's
 * retry-after only sets its backoff. Undefined for an error that isn't
 * GitHub's.
 */
export function githubOutcome(
  error: unknown,
  repository: string,
  permission = "read access to the repository, its issues, pull requests and checks",
  missing?: string,
): Outcome | undefined {
  if (error instanceof TransientError)
    return {
      kind: "retry",
      reason: error.message,
      ...(error.retryAfterMs === undefined
        ? {}
        : error.limited
          ? {
              wait: {
                kind: "reset",
                at: new Date(Date.now() + error.retryAfterMs).toISOString(),
              },
            }
          : { afterMs: error.retryAfterMs }),
    };
  if (!(error instanceof GitHubError)) return undefined;
  const detail = error.message.slice(0, 500);
  if (error.status === 401)
    return objectiveWide(
      hold(
        `GitHub rejected Factory's login on ${repository} (${detail}). Log in again with \`gh auth login\` (or replace FACTORY_GITHUB_TOKEN), then answer retry; or cancel.`,
      ),
    );
  if (error.status === 403 || (error.status === 404 && !missing))
    return objectiveWide(
      hold(
        `${detail}. Give Factory's login ${permission} on ${repository}, then answer retry; or cancel.`,
      ),
    );
  if (error.status === 404)
    return objectiveWide(
      hold(`${missing} (${detail}).`, ["retry", "cancel"], "cancel"),
    );
  return { kind: "retry", reason: error.message };
}

export interface GraphQLError {
  type?: string;
  message: string;
  /** Where in the data it applies: field names and aliases, then indexes. */
  path?: (string | number)[];
}

export interface IssueComment {
  id: number;
  body: string;
  created_at: string;
  user: { login: string } | null;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  body?: string | null;
  html_url?: string;
}

export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { id?: number; slug?: string } | null;
}

export interface CommitStatus {
  context?: unknown;
  state?: unknown;
  target_url?: unknown;
  updated_at?: unknown;
}

export interface WorkflowRun {
  status?: unknown;
  conclusion?: unknown;
}

/** A native stack of PRs: its base branch and its PRs, bottom first. */
export interface Stack {
  number: number;
  base: string;
  pulls: number[];
}

/**
 * A merge-async request: `pending` with the uuid to poll, `queued` (a
 * merge queue holds it, nothing to poll), `merged` with the merge commit,
 * or `failed` with GitHub's reason.
 */
export interface AsyncMerge {
  status: string;
  uuid?: string;
  sha?: string;
  message?: string;
}

/**
 * A small GitHub client. The token comes from the GitHub CLI login and stays
 * in the service; workers never see it. Every request has a deadline, and
 * every failure is either a TransientError (retry) or a GitHubError.
 */
/** How long a write-access answer counts (canWrite). */
const WRITER_TTL_MS = 10 * 60_000;

export class GitHub {
  private token: string | undefined;
  private secrets: readonly string[] = [];
  private self: string | undefined;
  private readonly writers = new Map<string, { ok: boolean; at: number }>();

  constructor(
    readonly repository: string,
    private readonly api = "https://api.github.com",
  ) {}

  /**
   * Redact these secret values (config.secrets) from every text Factory
   * writes to GitHub: comments, PR bodies, titles. One choke point, so no
   * hold, report or log excerpt can carry a value a worker saw.
   */
  redacting(secrets: readonly string[]): this {
    this.secrets = secrets;
    return this;
  }

  get owner(): string {
    return this.repository.split("/")[0]!;
  }

  get name(): string {
    return this.repository.split("/")[1]!;
  }

  async rest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.send(method, path, body, signal);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** An issue's comments, oldest first; from `since` on when given. */
  async comments(
    issue: number,
    since?: string,
    signal?: AbortSignal,
  ): Promise<IssueComment[]> {
    const all: IssueComment[] = [];
    const from = since ? `since=${encodeURIComponent(since)}&` : "";
    for (let page = 1; page <= 20; page++) {
      const batch = await this.rest<IssueComment[]>(
        "GET",
        `/repos/${this.repository}/issues/${issue}/comments?${from}per_page=100&page=${page}`,
        undefined,
        signal,
      );
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  async issue(
    issue: number,
    signal?: AbortSignal,
  ): Promise<{
    title: string;
    body: string | null;
    state: string;
    /** The issue's author; null for a deleted account. */
    user: { login: string } | null;
    /** Who closed it last, and why: set on a closed issue. */
    closed_by?: { login: string } | null;
    state_reason?: string | null;
  }> {
    return this.rest(
      "GET",
      `/repos/${this.repository}/issues/${issue}`,
      undefined,
      signal,
    );
  }

  /**
   * The issue with GitHub's own rendering of its body (`body_html`, from the
   * same read, so the two always match): planning reads only what it shows.
   * A non-empty body without one is Unreadable (transient, so the step
   * retries); the raw body never stands in for it.
   */
  async renderedIssue(
    issue: number,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<GitHub["issue"]>> & { body_html: string }> {
    const response = await this.send(
      "GET",
      `/repos/${this.repository}/issues/${issue}`,
      undefined,
      signal,
      { accept: "application/vnd.github.full+json" },
    );
    const found = (await response.json()) as Awaited<
      ReturnType<GitHub["issue"]>
    > & { body_html?: unknown };
    if (typeof found.body_html === "string")
      return { ...found, body_html: found.body_html };
    if (!found.body) return { ...found, body_html: "" };
    throw new Unreadable(`GitHub sent issue #${issue} without body_html`);
  }

  async postComment(
    issue: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.rest(
      "POST",
      `/repos/${this.repository}/issues/${issue}/comments`,
      { body },
      signal,
    );
  }

  /** The id of the issue comment Factory marked with `marker`, if it exists. */
  async findComment(
    issue: number,
    marker: string,
    since?: string,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    return (await this.markedComment(issue, marker, since, signal))?.id;
  }

  /**
   * The issue comment Factory marked with `marker`, if it exists. Markers
   * are predictable, so only a comment by Factory's own login counts:
   * anyone else's comment that carries one is ignored.
   */
  async markedComment(
    issue: number,
    marker: string,
    since?: string,
    signal?: AbortSignal,
  ): Promise<IssueComment | undefined> {
    const self = await this.login(signal);
    return (await this.comments(issue, since, signal)).find(
      (c) =>
        c.body.startsWith(marker) &&
        c.user !== null &&
        sameLogin(c.user.login, self),
    );
  }

  /** The login Factory acts as, read once per process. */
  async login(signal?: AbortSignal): Promise<string> {
    if (this.self) return this.self;
    const user = await this.rest<{ login?: unknown }>(
      "GET",
      "/user",
      undefined,
      signal,
    );
    if (typeof user.login !== "string" || !user.login)
      throw new TransientError("GitHub GET /user: no login");
    this.self = user.login;
    return this.self;
  }

  /**
   * Post the marked comment, or edit the one already there: found first,
   * so a post whose answer was lost is never repeated. `point` names the
   * crash points before and after the write.
   */
  async upsertComment(
    issue: number,
    marker: string,
    body: string,
    point: string,
    signal?: AbortSignal,
    /** Read comments from here on (a little before the comment was first due). */
    since?: string,
  ): Promise<void> {
    const existing = await this.markedComment(issue, marker, since, signal);
    if (existing?.body === body) return;
    crashPoint(`${point}:before`);
    if (existing)
      await this.rest(
        "PATCH",
        `/repos/${this.repository}/issues/comments/${existing.id}`,
        { body },
        signal,
      );
    else await this.postComment(issue, body, signal);
    crashPoint(`${point}:after`);
  }

  /** Close an issue with a reason, unless it is closed already. */
  async closeIssue(
    issue: number,
    reason: "completed" | "not_planned",
    point: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if ((await this.issue(issue, signal)).state !== "open") return;
    crashPoint(`${point}:before`);
    await this.rest(
      "PATCH",
      `/repos/${this.repository}/issues/${issue}`,
      { state: "closed", state_reason: reason },
      signal,
    );
    crashPoint(`${point}:after`);
  }

  /** Reopen a closed issue, unless it is open already. */
  async reopenIssue(
    issue: number,
    point: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if ((await this.issue(issue, signal)).state === "open") return;
    crashPoint(`${point}:before`);
    await this.rest(
      "PATCH",
      `/repos/${this.repository}/issues/${issue}`,
      { state: "open" },
      signal,
    );
    crashPoint(`${point}:after`);
  }

  /** Branch names under `prefix` (such as `factory/12/`) on the repository. */
  async branches(prefix: string, signal?: AbortSignal): Promise<string[]> {
    const refs = await this.pages<{ ref?: unknown }>(
      `/repos/${this.repository}/git/matching-refs/heads/${prefix.split("/").map(encodeURIComponent).join("/")}`,
      signal,
    );
    return refs
      .map((ref) => (typeof ref.ref === "string" ? ref.ref : ""))
      .filter((ref) => ref.startsWith(`refs/heads/${prefix}`))
      .map((ref) => ref.slice("refs/heads/".length));
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return (await this.graphqlPartial<T>(query, variables, signal, () => false))
      .data;
  }

  /**
   * A GraphQL read that may come back partial: errors that `accept` takes
   * (such as one missing issue among many) are returned with the data;
   * any other error throws as `graphql` does.
   */
  async graphqlPartial<T>(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal | undefined,
    accept: (error: GraphQLError) => boolean,
  ): Promise<{ data: T; errors: GraphQLError[] }> {
    const response = await this.send(
      "POST",
      "/graphql",
      { query, variables },
      signal,
    );
    const result = (await response.json()) as {
      data?: T;
      errors?: GraphQLError[];
    };
    const errors = result.errors ?? [];
    const refused = errors.filter((e) => !accept(e));
    if (refused.length) {
      const message = refused.map((e) => e.message).join("; ");
      if (refused.some((e) => e.type === "RATE_LIMITED")) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        throw new TransientError(
          `GitHub GraphQL: ${message}`,
          reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined,
          true,
        );
      }
      throw new GitHubError(`GitHub GraphQL: ${message}`, 200);
    }
    if (!result.data) throw new TransientError("GitHub GraphQL: no data");
    return { data: result.data, errors };
  }

  /** Every item of a paginated list of 100 per page, up to `maxPages` pages. */
  async pages<T>(
    path: string,
    signal?: AbortSignal,
    pick: (body: unknown) => unknown = (body) => body,
    maxPages = 50,
  ): Promise<T[]> {
    const all: T[] = [];
    const join = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const listed = pick(
        await this.rest<unknown>(
          "GET",
          `${path}${join}per_page=100&page=${page}`,
          undefined,
          signal,
        ),
      );
      if (!Array.isArray(listed))
        throw new TransientError(`GitHub GET ${path}: not a list`);
      all.push(...(listed as T[]));
      if (listed.length < 100) break;
    }
    return all;
  }

  // ── Pull request delivery (delivery.ts) ─────────────────────────────────

  private repo(path: string): string {
    return `/repos/${this.repository}${path ? `/${path}` : ""}`;
  }

  /** A read the login may not be allowed: 403 or 404 is undefined. */
  private async optional<T>(read: Promise<T>): Promise<T | undefined> {
    try {
      return await read;
    } catch (error) {
      if (
        error instanceof GitHubError &&
        (error.status === 403 || error.status === 404)
      )
        return undefined;
      throw error;
    }
  }

  /** The repository as the login sees it. */
  private about(signal?: AbortSignal): Promise<{
    default_branch?: string;
    allow_merge_commit?: boolean;
    permissions?: { push?: unknown };
  }> {
    return this.rest("GET", this.repo(""), undefined, signal);
  }

  async defaultBranch(signal?: AbortSignal): Promise<string> {
    const repository = await this.about(signal);
    if (!repository.default_branch)
      throw new TransientError(
        `GitHub shows no default branch for ${this.repository}`,
      );
    return repository.default_branch;
  }

  /** Whether the login may push to the repository; undefined when GitHub doesn't say. */
  async canPush(signal?: AbortSignal): Promise<boolean | undefined> {
    const push = (await this.about(signal)).permissions?.push;
    return typeof push === "boolean" ? push : undefined;
  }

  /**
   * Whether `login` may write to the repository (admin, maintain or write);
   * throws when GitHub can't say now. An answer is kept for 10 minutes, so
   * revoked access stops counting within that, without a restart.
   */
  async canWrite(login: string, signal?: AbortSignal): Promise<boolean> {
    const known = this.writers.get(login);
    if (known && Date.now() - known.at < WRITER_TTL_MS) return known.ok;
    let permission: string;
    try {
      ({ permission } = await this.rest<{ permission: string }>(
        "GET",
        this.repo(`collaborators/${encodeURIComponent(login)}/permission`),
        undefined,
        signal,
      ));
    } catch (error) {
      // No such user: a definite no. Anything else may pass.
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
      permission = "none";
    }
    const ok = ["admin", "maintain", "write"].includes(permission);
    this.writers.set(login, { ok, at: Date.now() });
    return ok;
  }

  /** Every PR, open or closed, whose head is `branch` of this repository. */
  pullsByHead(branch: string, signal?: AbortSignal): Promise<PullRequest[]> {
    return this.pages<PullRequest>(
      this.repo(
        `pulls?state=all&head=${encodeURIComponent(`${this.owner}:${branch}`)}`,
      ),
      signal,
    );
  }

  pull(number: number, signal?: AbortSignal): Promise<PullRequest> {
    return this.rest("GET", this.repo(`pulls/${number}`), undefined, signal);
  }

  createPull(
    pull: { head: string; base: string; title: string; body: string },
    signal?: AbortSignal,
  ): Promise<PullRequest> {
    return this.rest("POST", this.repo("pulls"), pull, signal);
  }

  /** GitHub merges the base into the PR's head, if it is still `expectedHead`. */
  async requestBranchUpdate(
    number: number,
    expectedHead: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.rest(
      "PUT",
      this.repo(`pulls/${number}/update-branch`),
      { expected_head_sha: expectedHead },
      signal,
    );
  }

  /** Merge with a merge commit, only if the PR's head is still `sha`. */
  mergePull(
    number: number,
    sha: string,
    signal?: AbortSignal,
  ): Promise<{ merged?: boolean; sha?: string }> {
    return this.rest(
      "PUT",
      this.repo(`pulls/${number}/merge`),
      { sha, merge_method: "merge" },
      signal,
    );
  }

  // ── Native stacks (preview API; only this file calls it) ──────────────

  /** The stacks that hold `pull`: none, or the one stack it is a layer of. */
  async findStack(pull: number, signal?: AbortSignal): Promise<Stack[]> {
    const listed = await this.rest<unknown>(
      "GET",
      this.repo(`stacks?pull_request=${pull}`),
      undefined,
      signal,
    );
    if (!Array.isArray(listed))
      throw new Unreadable(`GitHub GET stacks of PR #${pull}: not a list`);
    return listed.map((stack) => stackOf(stack));
  }

  /** Register `pulls`, bottom first, as one native stack. */
  async createStack(pulls: number[], signal?: AbortSignal): Promise<Stack> {
    return stackOf(
      await this.rest<unknown>(
        "POST",
        this.repo("stacks"),
        { pull_requests: pulls },
        signal,
      ),
    );
  }

  /**
   * Merge a native stack through its top PR with one merge commit, only if
   * the top's head is still `sha`. A request already pending (an earlier
   * one whose answer was lost) comes back as `pending` with its uuid.
   */
  async mergeAsync(
    top: number,
    sha: string,
    signal?: AbortSignal,
  ): Promise<AsyncMerge> {
    try {
      return asyncMergeOf(
        await this.rest<unknown>(
          "PUT",
          this.repo(`pulls/${top}/merge-async`),
          { sha, merge_method: "merge", merge_action: "default" },
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) {
        const pending = asyncMergeOf(error.body);
        if (pending.status === "pending" && pending.uuid) return pending;
      }
      throw error;
    }
  }

  /** Where a merge-async request on `top` stands. */
  async mergeStatus(
    top: number,
    uuid: string,
    signal?: AbortSignal,
  ): Promise<AsyncMerge> {
    return asyncMergeOf(
      await this.rest<unknown>(
        "GET",
        this.repo(`pulls/${top}/merge-async/${encodeURIComponent(uuid)}`),
        undefined,
        signal,
      ),
    );
  }

  async commit(
    sha: string,
    signal?: AbortSignal,
  ): Promise<{
    sha: string;
    parents: string[];
    committer?: string;
  }> {
    const commit = await this.rest<{
      sha?: string;
      parents?: { sha?: unknown }[];
      committer?: { login?: unknown } | null;
    }>("GET", this.repo(`commits/${sha}`), undefined, signal);
    return {
      sha: String(commit.sha),
      parents: (commit.parents ?? []).map((parent) => String(parent?.sha)),
      ...(typeof commit.committer?.login === "string"
        ? { committer: commit.committer.login }
        : {}),
    };
  }

  /** How `head` relates to `base`: identical, ahead, behind or diverged. */
  async compare(
    base: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const ref = (name: string) =>
      name.split("/").map(encodeURIComponent).join("/");
    const result = await this.rest<{ status?: unknown }>(
      "GET",
      this.repo(`compare/${ref(base)}...${ref(head)}`),
      undefined,
      signal,
    );
    return typeof result.status === "string" ? result.status : undefined;
  }

  /**
   * The commits on `head` that `base` doesn't have, up to `max` of them,
   * with GitHub's count of all of them: each with its parents, its
   * committer's email, and its committer's login when GitHub knows it.
   */
  async commitsBeyond(
    base: string,
    head: string,
    max: number,
    signal?: AbortSignal,
  ): Promise<{
    total: number;
    commits: {
      sha: string;
      parents: string[];
      committerEmail?: string;
      committer?: string;
    }[];
  }> {
    const ref = (name: string) =>
      name.split("/").map(encodeURIComponent).join("/");
    let total = 0;
    const commits: Awaited<ReturnType<GitHub["commitsBeyond"]>>["commits"] = [];
    for (let page = 1; commits.length < max; page++) {
      const result = await this.rest<{
        total_commits?: unknown;
        commits?: {
          sha?: unknown;
          parents?: { sha?: unknown }[];
          committer?: { login?: unknown } | null;
          commit?: { committer?: { email?: unknown } | null } | null;
        }[];
      }>(
        "GET",
        this.repo(
          `compare/${ref(base)}...${ref(head)}?per_page=100&page=${page}`,
        ),
        undefined,
        signal,
      );
      if (typeof result.total_commits !== "number" || !result.commits)
        throw new TransientError(
          `GitHub compare ${base}...${head}: no commits`,
        );
      total = result.total_commits;
      for (const commit of result.commits) {
        const email = commit.commit?.committer?.email;
        commits.push({
          sha: String(commit.sha),
          parents: (commit.parents ?? []).map((parent) => String(parent?.sha)),
          ...(typeof email === "string" ? { committerEmail: email } : {}),
          ...(typeof commit.committer?.login === "string"
            ? { committer: commit.committer.login }
            : {}),
        });
      }
      if (result.commits.length < 100 || commits.length >= total) break;
    }
    return { total, commits: commits.slice(0, max) };
  }

  /** The latest check run of each check suite on the commit. */
  checkRuns(sha: string, signal?: AbortSignal): Promise<CheckRun[]> {
    return this.pages<CheckRun>(
      this.repo(`commits/${sha}/check-runs?filter=latest`),
      signal,
      (body) => (body as { check_runs?: unknown }).check_runs,
    );
  }

  /** The latest status of each context on the commit. */
  commitStatuses(sha: string, signal?: AbortSignal): Promise<CommitStatus[]> {
    return this.pages<CommitStatus>(
      this.repo(`commits/${sha}/status`),
      signal,
      (body) => (body as { statuses?: unknown }).statuses ?? [],
    );
  }

  /** The commit's Actions workflow runs; undefined without Actions read access. */
  workflowRuns(
    sha: string,
    signal?: AbortSignal,
  ): Promise<WorkflowRun[] | undefined> {
    return this.optional(
      this.pages<WorkflowRun>(
        this.repo(`actions/runs?head_sha=${sha}`),
        signal,
        (body) => (body as { workflow_runs?: unknown }).workflow_runs ?? [],
      ),
    );
  }

  /**
   * The check names the repository requires on `branch`: its rulesets and
   * its classic branch protection (from the protection route, else from the
   * branch read, which shows them with read access).
   */
  async requiredChecks(
    branch: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const name = encodeURIComponent(branch);
    const rules =
      (await this.optional(
        this.pages<{
          type?: string;
          parameters?: { required_status_checks?: { context?: unknown }[] };
        }>(this.repo(`rules/branches/${name}`), signal),
      )) ?? [];
    type Required = { contexts?: unknown; checks?: unknown } | null | undefined;
    let classic: Required;
    try {
      classic = await this.rest<Required>(
        "GET",
        this.repo(`branches/${name}/protection/required_status_checks`),
        undefined,
        signal,
      );
    } catch (error) {
      if (!(error instanceof GitHubError && [403, 404].includes(error.status)))
        throw error;
      // 404: unprotected, or no required checks. 403: the login may not read
      // protection settings; the branch read shows the same checks.
      if (error.status === 403)
        classic = (
          await this.rest<{
            protection?: { required_status_checks?: Required };
          }>("GET", this.repo(`branches/${name}`), undefined, signal)
        ).protection?.required_status_checks;
    }
    return [
      ...new Set(
        [
          ...rules.flatMap((rule) =>
            rule.type === "required_status_checks"
              ? (rule.parameters?.required_status_checks ?? []).map(
                  (check) => check.context,
                )
              : [],
          ),
          ...(Array.isArray(classic?.contexts) ? classic.contexts : []),
          ...(Array.isArray(classic?.checks) ? classic.checks : []).map(
            (check) => (check as { context?: unknown } | null)?.context,
          ),
        ].filter((name): name is string => typeof name === "string" && !!name),
      ),
    ];
  }

  /**
   * Whether a PR into `branch` may merge with a merge commit: the
   * repository allows them, and no ruleset or classic protection requires
   * linear history or leaves merge out of the allowed methods. Classic
   * protection needs admin to read; unreadable, the merge itself tests it.
   */
  async mergeCommitsAllowed(
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const repository = await this.about(signal);
    if (repository.allow_merge_commit !== true) return false;
    const name = encodeURIComponent(branch);
    const rules =
      (await this.optional(
        this.pages<{
          type?: unknown;
          parameters?: { allowed_merge_methods?: unknown } | null;
        }>(this.repo(`rules/branches/${name}`), signal),
      )) ?? [];
    if (
      rules.some(
        (rule) =>
          rule?.type === "required_linear_history" ||
          (rule?.type === "pull_request" &&
            Array.isArray(rule.parameters?.allowed_merge_methods) &&
            !rule.parameters.allowed_merge_methods.includes("merge")),
      )
    )
      return false;
    const classic = await this.optional(
      this.rest<{ required_linear_history?: { enabled?: unknown } }>(
        "GET",
        this.repo(`branches/${name}/protection`),
        undefined,
        signal,
      ),
    );
    return classic?.required_linear_history?.enabled !== true;
  }

  /**
   * When `sha` was pushed to `branch`, from the repository's activity;
   * undefined when GitHub does not show it (not yet, or not to this login).
   */
  async pushTime(
    branch: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const activity = await this.optional(
      this.rest<{ after?: unknown; timestamp?: unknown }[]>(
        "GET",
        this.repo(
          `activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=100`,
        ),
        undefined,
        signal,
      ),
    );
    const push = Array.isArray(activity)
      ? activity.find((event) => event?.after === sha)
      : undefined;
    return typeof push?.timestamp === "string" ? push.timestamp : undefined;
  }

  /** GitHub's merge readiness of a PR, which REST does not show. */
  async mergeState(
    number: number,
    signal?: AbortSignal,
  ): Promise<{
    headRefOid: string;
    headRefName: string;
    baseRefName: string;
    mergeStateStatus: string;
    reviewDecision?: string | null;
  }> {
    const data = await this.graphql<{
      repository?: {
        pullRequest?: {
          headRefOid: string;
          headRefName: string;
          baseRefName: string;
          mergeStateStatus: string;
          reviewDecision?: string | null;
        } | null;
      } | null;
    }>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            headRefOid headRefName baseRefName mergeStateStatus reviewDecision
          }
        }
      }`,
      { owner: this.owner, name: this.name, number },
      signal,
    );
    const pull = data.repository?.pullRequest;
    if (!pull)
      throw new TransientError(`GitHub GraphQL shows no PR #${number} yet`);
    return pull;
  }

  /**
   * The merge commit of a merged PR, from its timeline (PR responses in the
   * pinned API version may omit it). Undefined while the timeline does not
   * show the merge yet.
   */
  async mergeCommitOf(
    number: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const events = await this.pages<{ event?: string; commit_id?: unknown }>(
      this.repo(`issues/${number}/timeline`),
      signal,
    );
    const merged = events.find(
      (event) =>
        event?.event === "merged" &&
        typeof event.commit_id === "string" &&
        /^[a-f0-9]{40}$/.test(event.commit_id),
    );
    return merged?.commit_id as string | undefined;
  }

  /** Up to five failure annotations of a check run, as `path:line message`. */
  async failureAnnotations(
    checkRun: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const annotations = await this.rest<
      {
        path?: unknown;
        start_line?: unknown;
        annotation_level?: unknown;
        message?: unknown;
      }[]
    >(
      "GET",
      this.repo(`check-runs/${checkRun}/annotations?per_page=50`),
      undefined,
      signal,
    );
    return (Array.isArray(annotations) ? annotations : [])
      .filter((note) => note?.annotation_level === "failure")
      .slice(0, 5)
      .map((note) =>
        `${typeof note.path === "string" ? note.path : ""}${typeof note.start_line === "number" ? `:${note.start_line}` : ""} ${String(note.message ?? "").slice(0, 300)}`.trim(),
      );
  }

  /**
   * The tail of an Actions job's log: the last 64 KiB asked for, never more
   * than 1 MiB read. A log longer than that without the range is undefined,
   * since its first bytes are not its tail.
   */
  async jobLogTail(
    job: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const response = await this.send(
      "GET",
      this.repo(`actions/jobs/${job}/logs`),
      undefined,
      signal,
      { range: `bytes=-${64 * 1024}` },
    );
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) return undefined;
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    headers: Record<string, string> = {},
    refreshed = false,
  ): Promise<Response> {
    const token = await this.auth(refreshed);
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(
                method === "GET" ? body : redactDeep(body, this.secrets),
              ),
            }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TransientError(
        `GitHub ${method} ${path}: ${errorMessage(error)}`,
      );
    }
    if (response.ok) return response;
    const text = await response.text().catch(() => "");
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = undefined;
    }
    const detail = `GitHub ${method} ${path}: ${response.status} ${text.slice(0, 300)}`;
    if (response.status === 401 && !refreshed)
      return this.send(method, path, body, signal, headers, true);
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          /rate limit/i.test(text)));
    // A 401 that a fresh token didn't fix is a login problem, not a hiccup.
    if (response.status === 401) throw new GitHubError(detail, 401, answer);
    if (limited)
      throw new TransientError(
        detail,
        retryAfter > 0
          ? retryAfter * 1000
          : reset > 0
            ? Math.max(0, reset * 1000 - Date.now())
            : undefined,
        true,
      );
    // A 5xx is an outage, not a limit: GitHub sends x-ratelimit-* headers on
    // every answer, so only its retry-after counts, and only as a backoff.
    if (response.status >= 500)
      throw new TransientError(
        detail,
        retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    throw new GitHubError(detail, response.status, answer);
  }

  /** The service token, for downloads outside the REST API (media attachments). */
  serviceToken(): Promise<string> {
    return this.auth(false);
  }

  private async auth(refresh: boolean): Promise<string> {
    if (this.token && !refresh) return this.token;
    if (process.env.FACTORY_GITHUB_TOKEN) {
      this.token = process.env.FACTORY_GITHUB_TOKEN;
      return this.token;
    }
    try {
      const { stdout } = await run(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        { timeout: 30_000 },
      );
      this.token = stdout.trim();
    } catch (error) {
      const message = `GitHub login unavailable (run \`gh auth login\`): ${errorMessage(error)}`;
      // gh ran and said no, or isn't installed: a person must log in. A
      // timeout may pass.
      if ((error as { killed?: boolean }).killed)
        throw new TransientError(message);
      throw new GitHubError(message, 401);
    }
    if (!this.token)
      throw new GitHubError(
        "GitHub login unavailable (run `gh auth login`)",
        401,
      );
    return this.token;
  }
}

/** One account, as a user (`name`) or as its app's bot (`name[bot]`). */
function sameLogin(a: string, b: string): boolean {
  const plain = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");
  return plain(a) === plain(b);
}

/** A stack as GitHub returns it; a shape Factory can't read is Unreadable. */
function stackOf(value: unknown): Stack {
  const stack = value as {
    number?: unknown;
    base?: { ref?: unknown } | null;
    pull_requests?: unknown;
  } | null;
  const pulls = Array.isArray(stack?.pull_requests)
    ? stack.pull_requests.map(
        (pull) => (pull as { number?: unknown } | null)?.number,
      )
    : [];
  if (
    typeof stack?.number !== "number" ||
    typeof stack.base?.ref !== "string" ||
    !pulls.length ||
    !pulls.every((number) => typeof number === "number")
  )
    throw new Unreadable("GitHub returned a native stack Factory can't read");
  return {
    number: stack.number,
    base: stack.base.ref,
    pulls: pulls as number[],
  };
}

function asyncMergeOf(value: unknown): AsyncMerge {
  const body = value as {
    status?: unknown;
    details?: { uuid?: unknown; sha?: unknown; message?: unknown } | null;
  } | null;
  const details = body?.details;
  return {
    status: typeof body?.status === "string" ? body.status : "unknown",
    ...(typeof details?.uuid === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(details.uuid)
      ? { uuid: details.uuid }
      : {}),
    ...(typeof details?.sha === "string" && /^[a-f0-9]{40}$/.test(details.sha)
      ? { sha: details.sha }
      : {}),
    ...(typeof details?.message === "string"
      ? { message: details.message.slice(0, 500) }
      : {}),
  };
}

/** Every string inside `value`, redacted; the shape is kept. */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]),
    );
  return value;
}
