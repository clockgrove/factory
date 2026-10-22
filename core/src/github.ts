import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Network trouble, 5xx, rate limits, timeouts: try again later. */
export class TransientError extends Error {
  constructor(
    message: string,
    /** When GitHub said to come back, if it did. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** GitHub answered, and the answer won't change by asking again: 404, 422. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 60_000;

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

/**
 * A small GitHub client. The token comes from the GitHub CLI login and stays
 * in the service; workers never see it. Every request has a deadline, and
 * every failure is either a TransientError (retry) or a GitHubError.
 */
export class GitHub {
  private token: string | undefined;

  constructor(
    readonly repository: string,
    private readonly api = "https://api.github.com",
  ) {}

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

  /** The id of the issue comment Factory marked with `marker`, if it exists. */
  async findComment(
    issue: number,
    marker: string,
    since?: string,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    return (await this.comments(issue, since, signal)).find((c) =>
      c.body.startsWith(marker),
    )?.id;
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.send(
      "POST",
      "/graphql",
      { query, variables },
      signal,
    );
    const result = (await response.json()) as {
      data?: T;
      errors?: { type?: string; message: string }[];
    };
    if (result.errors?.length) {
      const message = result.errors.map((e) => e.message).join("; ");
      if (result.errors.some((e) => e.type === "RATE_LIMITED"))
        throw new TransientError(`GitHub GraphQL: ${message}`);
      throw new GitHubError(`GitHub GraphQL: ${message}`, 200);
    }
    if (!result.data) throw new TransientError("GitHub GraphQL: no data");
    return result.data;
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

  async commit(
    sha: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; parents: string[]; committer?: string }> {
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
  }> {
    const data = await this.graphql<{
      repository?: {
        pullRequest?: {
          headRefOid: string;
          headRefName: string;
          baseRefName: string;
          mergeStateStatus: string;
        } | null;
      } | null;
    }>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            headRefOid headRefName baseRefName mergeStateStatus
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
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TransientError(
        `GitHub ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.ok) return response;
    const text = await response.text().catch(() => "");
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
    if (response.status === 401) throw new GitHubError(detail, 401);
    if (limited || response.status >= 500)
      throw new TransientError(
        detail,
        retryAfter > 0
          ? retryAfter * 1000
          : reset > 0
            ? Math.max(0, reset * 1000 - Date.now())
            : undefined,
      );
    throw new GitHubError(detail, response.status);
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
      throw new TransientError(
        `GitHub login unavailable (run \`gh auth login\`): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!this.token)
      throw new TransientError(
        "GitHub login unavailable (run `gh auth login`)",
      );
    return this.token;
  }
}
