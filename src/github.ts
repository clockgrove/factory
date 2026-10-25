import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crashPoint } from "./crash.js";
import { redactDeep } from "./display.js";
import { hold, type Outcome, objectiveWide } from "./engine.js";
import {
  type NotedRequest,
  networkCategory,
  newTransport,
  note,
  statusCategory,
  type Transport,
  transport,
} from "./github-trace.js";
import { errorMessage } from "./text.js";

const run = promisify(execFile);

/** Network trouble, 5xx, rate limits, timeouts: try again later. */
export class TransientError extends Error {
  constructor(
    message: string,
    /** When GitHub said to come back, if it did. */
    readonly retryAfterMs?: number,
    /**
     * A rate limit (429, or a 403 with GitHub's rate-limit headers):
     * `retryAfterMs` is when it resets. Otherwise it is only a backoff hint
     * (a 5xx's retry-after).
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
  /** The permission the refused call needs, for its hold (`needing`). */
  permission?: string;
  /**
   * A 404 of an issue (or what GitHub serves under one): the issue is
   * missing, not a refusal; set by the client from the request's path.
   */
  missingIssue?: number;
  constructor(
    message: string,
    readonly status: number,
    /** The response body as JSON, when it was JSON. */
    readonly body?: unknown,
    /** Where a redirect points; never followed (see `moved`). */
    readonly location?: string,
  ) {
    super(message);
  }
}

/**
 * The configured repository answers under another name: renamed or
 * transferred (GitHub.checkIdentity). The client then refuses every
 * request, so no card, comment, close or merge lands until the
 * configuration names the repository and the service restarts. It is
 * transient: no step fails or holds on it, and no issue counts as gone.
 */
export class RepositoryMoved extends TransientError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(
      `repository ${from} is now ${to}; update the configuration's repository and restart`,
    );
  }
}

/**
 * GitHub redirects what moved: an issue transferred to another repository,
 * a renamed repository. The client never follows a redirect, so Factory
 * never acts outside its configured repository; a redirect is an answer.
 * A redirect under the repository is checked against its identity first,
 * so a renamed repository is RepositoryMoved, never a moved issue.
 */
export function moved(error: unknown): boolean {
  return (
    error instanceof GitHubError && [301, 302, 307, 308].includes(error.status)
  );
}

/** The error, naming the permission its call needs if GitHub refused it. */
export function needing(error: unknown, permission: string): unknown {
  if (error instanceof GitHubError) error.permission = permission;
  return error;
}

/** An issue GitHub no longer has here: deleted (404, 410) or moved away. */
export function issueGone(error: unknown): error is GitHubError {
  return (
    moved(error) ||
    (error instanceof GitHubError &&
      (error.status === 404 || error.status === 410))
  );
}

const TIMEOUT_MS = 60_000;

/**
 * What `send` measured for each answer it returned, and its trace line
 * when it noted one: a GraphQL rate limit, found in the body, retags it.
 */
const answers = new WeakMap<
  Response,
  {
    answered: {
      method: string;
      path: string;
      status: number;
      attempt: number;
      ms: number;
    };
    noted: NotedRequest | undefined;
  }
>();
/** How long GitHub may lag behind what Factory made (`GitHub.made`). */
const FRESH_MS = 2 * 60_000;
/** How long a 403 without rate-limit headers retries before it asks. */
const REFUSED_MS = 2 * 60_000;

/**
 * A GitHub failure as a step outcome (docs/reference/steps.md#Waits): only what a person
 * must fix holds, at once: a rejected login (401), a refusal (a 404 of
 * anything but an issue; rate limits, and a 403 or 404 of what Factory
 * just made, are TransientErrors: `GitHub.made`) naming the permission
 * the call needs (`needing`), and a missing issue (404). Any other 403
 * asks the same after REFUSED_MS of retries, since a secondary rate limit
 * can come without headers. A rate limit waits for its reset. Everything
 * else (5xx, timeouts, 409, 410, 422, GraphQL errors) may change, so it
 * retries as an unknown transient wait; a 5xx's retry-after only sets its
 * backoff. Undefined for an error that isn't GitHub's.
 */
export function githubOutcome(
  error: unknown,
  repository: string,
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
  if (moved(error))
    return objectiveWide(
      hold(
        `GitHub says this moved out of ${repository} (${detail}${error.location ? `; now at ${error.location}` : ""}). The repository itself still answers as ${repository}, so this was transferred away, and Factory acts only on ${repository}: cancel; or answer retry once it is back.`,
        ["cancel", "retry"],
      ),
    );
  if (error.status === 401)
    return objectiveWide(
      hold(
        `GitHub rejected Factory's login on ${repository} (${detail}). Log in again with \`gh auth login\` (or replace FACTORY_GITHUB_TOKEN), then answer retry; or cancel.`,
      ),
    );
  if (error.status === 404 && error.missingIssue !== undefined)
    return objectiveWide(
      hold(
        `GitHub says issue #${error.missingIssue} doesn't exist or Factory can't see it (${detail}).`,
        ["cancel", "retry"],
      ),
    );
  const refused = `${detail}. Give Factory's login ${error.permission ?? "read access to the repository, its issues, pull requests and checks"} on ${repository}, then answer retry; or cancel.`;
  // A 403 without rate-limit headers may be a secondary limit, which
  // passes: it asks only once it outlasts one.
  if (error.status === 403)
    return {
      kind: "retry",
      reason: error.message,
      holdAfter: { ms: REFUSED_MS, question: refused, scope: "objective" },
    };
  if (error.status === 404) return objectiveWide(hold(refused));
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
  updated_at?: string;
  user: { login: string } | null;
  html_url?: string;
}

/** An issue as the issue lists show it. */
export interface IssueSummary {
  /** The issue's database id: sub-issue and blocked-by links take it. */
  id: number;
  number: number;
  state: string;
  title: string;
  body: string | null;
  user: { login: string } | null;
  created_at?: string;
  /** Its native issue type, where the repository has them. */
  type?: { name: string } | null;
  /** Why a closed issue closed: `completed`, `not_planned`, `duplicate`. */
  state_reason?: string | null;
  /** The API URL of the issue's repository: a blocked-by link may name another one. */
  repository_url?: string;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged?: boolean;
  created_at?: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  closed_at?: string | null;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  body?: string | null;
  html_url?: string;
  user?: { login: string } | null;
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

/**
 * Statuses the running read's caller takes as an answer (a 404 for "no
 * such user", for "unprotected"): `send` neither counts nor traces them
 * as failed (a step's trace still lists them, with no category). Set with
 * `expecting`.
 */
const expectedStatuses = new AsyncLocalStorage<readonly number[]>();

function expecting<T>(
  statuses: readonly number[],
  read: () => Promise<T>,
): Promise<T> {
  return expectedStatuses.run(statuses, read);
}

export class GitHub {
  /** Requests outside a step or a sync job: the service run's own (`takeAmbient`). */
  private ambient = newTransport();
  private token: string | undefined;
  private secrets: readonly string[] = [];
  private self: string | undefined;
  private readonly writers = new Map<string, { ok: boolean; at: number }>();
  /** Set once the repository is found under another name; never cleared (a restart reads the configuration again). */
  private renamed: RepositoryMoved | undefined;
  /** What Factory made lately, and when (`made`): a 403 or 404 under one is GitHub's lag. */
  private readonly fresh = new Map<string, number>();

  constructor(
    readonly repository: string,
    private readonly api = "https://api.github.com",
  ) {}

  /**
   * Redact these secret values (config.secrets) from every text Factory
   * writes to GitHub: comments, PR bodies, titles. One choke point, so no
   * hold, report or log excerpt can carry a value a worker saw.
   */
  /**
   * The requests made outside any step or sync job since the last take,
   * and a fresh tally for the next; undefined when there were none.
   */
  takeAmbient(): Transport | undefined {
    if (!this.ambient.calls) return undefined;
    const taken = this.ambient;
    this.ambient = newTransport();
    return taken;
  }

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

  /** The repository's rename or transfer, once found: every request is refused. */
  get moved(): RepositoryMoved | undefined {
    return this.renamed;
  }

  /**
   * The repository's identity: `GET /repos/{owner}/{repo}`, never
   * redirected. Its 301 means the repository was renamed or transferred
   * (see `send`), as does a 200 that names another repository. Throws
   * RepositoryMoved then, and from then on.
   */
  async checkIdentity(signal?: AbortSignal): Promise<void> {
    const found = await this.rest<{ full_name?: unknown }>(
      "GET",
      `/repos/${this.repository}`,
      undefined,
      signal,
    );
    if (typeof found?.full_name === "string")
      this.sameRepository(found.full_name);
  }

  /**
   * The repository answered its identity read with a 301: it moved. Its new
   * name is read over GraphQL, which resolves the old one; the redirect's
   * location stands in when that read fails. Always throws RepositoryMoved.
   */
  private async repositoryMoved(
    location: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<never> {
    const name = await this.graphql<{
      repository: { nameWithOwner: string } | null;
    }>(
      "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner } }",
      { owner: this.owner, name: this.name },
      signal,
    ).then(
      (data) => data.repository?.nameWithOwner,
      () => undefined,
    );
    this.sameRepository(
      name && name.toLowerCase() !== this.repository.toLowerCase()
        ? name
        : (location ?? "a new name"),
    );
    throw this.renamed;
  }

  /**
   * A repository's `nameWithOwner` as GitHub reports it now (GraphQL
   * resolves an old name): one that differs from the configured repository
   * is a rename or transfer, and throws RepositoryMoved.
   */
  sameRepository(nameWithOwner: string): void {
    if (
      !this.renamed &&
      nameWithOwner.toLowerCase() !== this.repository.toLowerCase()
    )
      this.renamed = new RepositoryMoved(this.repository, nameWithOwner);
    if (this.renamed) throw this.renamed;
  }

  async rest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.send(method, path, body, signal);
    if (response.status === 204) return undefined as T;
    const result = await this.body(response, method, path, signal, "json");
    // A resource Factory just created (an issue, a PR, a comment): GitHub
    // may not serve it, or what is under it, for a moment.
    const url = (result as { url?: unknown } | null)?.url;
    if (
      response.status === 201 &&
      typeof url === "string" &&
      url.startsWith(`${this.api}/`)
    )
      this.made(url.slice(this.api.length));
    return result as T;
  }

  /**
   * The response's body. Its headers came, but the body can still fail
   * (a socket reset, the deadline, truncated JSON): that is a
   * TransientError like any network failure, so it retries.
   */
  private async body(
    response: Response,
    method: string,
    path: string,
    signal: AbortSignal | undefined,
    as: "json" | "text",
  ): Promise<unknown> {
    try {
      return as === "json" ? await response.json() : await response.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TransientError(
        `GitHub ${method} ${path}: the answer's body didn't arrive whole: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Factory made `what` at `at` (now, or a saved time on a restart): an API
   * path (a created issue, PR or comment; what is under it counts too), or
   * a pushed branch or commit (a path naming it as a whole segment, or as
   * one side of a compare). For FRESH_MS after, a 403 or 404 there is
   * GitHub's lag, a TransientError, never a missing permission or resource.
   */
  made(what: string, at = Date.now()): void {
    const now = Date.now();
    for (const [mark, when] of this.fresh)
      if (now - when >= FRESH_MS) this.fresh.delete(mark);
    if (now - at < FRESH_MS)
      this.fresh.set(what, Math.max(at, this.fresh.get(what) ?? at));
  }

  /** Whether `path` is under, or names, something Factory made within FRESH_MS. */
  private isFresh(path: string): boolean {
    const now = Date.now();
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      // Not encoded: compared as it is.
    }
    const asked = decoded.toLowerCase().split("?")[0]!;
    for (const [mark, at] of this.fresh) {
      if (now - at >= FRESH_MS) continue;
      const made = mark.toLowerCase();
      if (made.startsWith("/")) {
        if (asked === made || asked.startsWith(`${made}/`)) return true;
        continue;
      }
      const named = new RegExp(
        `(?:^|/|\\.\\.\\.)${made.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|/|\\.\\.\\.)`,
      );
      if (named.test(asked)) return true;
    }
    return false;
  }

  /** An issue's comments, oldest first; from `since` on when given. */
  async comments(
    issue: number,
    since?: string,
    signal?: AbortSignal,
  ): Promise<IssueComment[]> {
    return this.pages<IssueComment>(
      `/repos/${this.repository}/issues/${issue}/comments${since ? `?since=${encodeURIComponent(since)}` : ""}`,
      signal,
      undefined,
      20,
    );
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
    const found = (await this.body(
      response,
      "GET",
      `/repos/${this.repository}/issues/${issue}`,
      signal,
      "json",
    )) as Awaited<ReturnType<GitHub["issue"]>> & { body_html?: unknown };
    if (typeof found.body_html === "string")
      return { ...found, body_html: found.body_html };
    if (!found.body) return { ...found, body_html: "" };
    throw new Unreadable(`GitHub sent issue #${issue} without body_html`);
  }

  /**
   * `text` as GitHub renders an issue body in this repository (GFM, the
   * same renderer and sanitizer as `body_html`). A read: it writes nothing.
   */
  async renderMarkdown(text: string, signal?: AbortSignal): Promise<string> {
    const response = await this.send(
      "POST",
      "/markdown",
      { text, mode: "gfm", context: this.repository },
      signal,
      { accept: "text/html" },
    );
    return (await this.body(
      response,
      "POST",
      "/markdown",
      signal,
      "text",
    )) as string;
  }

  async postComment(
    issue: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<IssueComment> {
    return await this.rest<IssueComment>(
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
   * Make sure the marked comment exists: found first (by Factory's own
   * login), and posted only when it isn't there, so a post whose answer was
   * lost is never repeated. It is never edited (see `upsertComment` for a
   * comment kept current). `point` names the crash points before and after
   * the post. Returns the comment as GitHub shows it, with its times.
   */
  async ensureComment(
    issue: number,
    marker: string,
    body: string,
    point: string,
    signal?: AbortSignal,
    /** Read comments from here on (a little before the comment was first due). */
    since?: string,
  ): Promise<IssueComment> {
    const existing = await this.markedComment(issue, marker, since, signal);
    if (existing) return existing;
    crashPoint(`${point}:before`);
    const posted = await this.postComment(issue, body, signal);
    crashPoint(`${point}:after`);
    return posted;
  }

  /**
   * Post the marked comment, or edit the one already there: found first,
   * so a post whose answer was lost is never repeated. `point` names the
   * crash points before and after the write. Returns the comment as GitHub
   * shows it now, with its times by GitHub's clock.
   */
  async upsertComment(
    issue: number,
    marker: string,
    body: string,
    point: string,
    signal?: AbortSignal,
    /** Read comments from here on (a little before the comment was first due). */
    since?: string,
  ): Promise<IssueComment> {
    const existing = await this.markedComment(issue, marker, since, signal);
    if (existing?.body === body) return existing;
    crashPoint(`${point}:before`);
    const written = existing
      ? await this.rest<IssueComment>(
          "PATCH",
          `/repos/${this.repository}/issues/comments/${existing.id}`,
          { body },
          signal,
        )
      : await this.postComment(issue, body, signal);
    crashPoint(`${point}:after`);
    return written;
  }

  /**
   * Edit the marked comment if it exists, between the crash points
   * `<point>:before` and `<point>:after`; never post one. Returns whether
   * it exists.
   */
  async editComment(
    issue: number,
    marker: string,
    body: string,
    point: string,
    signal?: AbortSignal,
    since?: string,
  ): Promise<boolean> {
    const existing = await this.markedComment(issue, marker, since, signal);
    if (!existing) return false;
    if (existing.body === body) return true;
    crashPoint(`${point}:before`);
    await this.rest(
      "PATCH",
      `/repos/${this.repository}/issues/comments/${existing.id}`,
      { body },
      signal,
    );
    crashPoint(`${point}:after`);
    return true;
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

  /** Close a PR, between the crash points `<point>:before` and `<point>:after`. */
  async closePull(
    number: number,
    point: string,
    signal?: AbortSignal,
  ): Promise<void> {
    crashPoint(`${point}:before`);
    await this.rest(
      "PATCH",
      this.repo(`pulls/${number}`),
      { state: "closed" },
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

  // ── Issue primitives (tracking.ts) ──────────────────────────────────────
  //
  // Each is found before it is made: an issue by the marker on its body's
  // first line (Factory's own login only), a sub-issue or blocked-by link
  // by the issue's links. A write whose answer was lost is found by the
  // next run, never made twice.

  /**
   * Issues (with `label`, when given) that Factory's login opened, updated
   * from `since` on, newest first: one bounded, paginated list that stops
   * at the first page reaching issues created before `since`. Past
   * `maxPages` pages it throws (see `pages`).
   */
  async issuesByLabel(
    label: string | undefined,
    since: string | undefined,
    signal?: AbortSignal,
    maxPages = 10,
  ): Promise<IssueSummary[]> {
    const self = await this.login(signal);
    const query = [
      ...(label ? [`labels=${encodeURIComponent(label)}`] : []),
      "state=all",
      `creator=${encodeURIComponent(self)}`,
      "sort=created",
      "direction=desc",
      ...(since ? [`since=${encodeURIComponent(since)}`] : []),
    ].join("&");
    const found = await this.pages<IssueSummary & { pull_request?: unknown }>(
      `/repos/${this.repository}/issues?${query}`,
      signal,
      undefined,
      maxPages,
      (listed) =>
        !since ||
        !(Date.parse(listed.at(-1)?.created_at ?? "") < Date.parse(since)),
    );
    return found.filter((issue) => issue.pull_request === undefined);
  }

  /** The issue among `found` whose body Factory marked with `marker`. */
  async markedIssue(
    found: readonly IssueSummary[],
    marker: string,
    signal?: AbortSignal,
  ): Promise<IssueSummary | undefined> {
    return (await this.markedIssues(found, marker, signal))[0];
  }

  /** Every issue in `found` that Factory's login opened with `marker` first. */
  async markedIssues(
    found: readonly IssueSummary[],
    marker: string,
    signal?: AbortSignal,
  ): Promise<IssueSummary[]> {
    const self = await this.login(signal);
    return found.filter(
      (issue) =>
        (issue.body ?? "").startsWith(marker) &&
        issue.user !== null &&
        sameLogin(issue.user.login, self),
    );
  }

  /**
   * Make sure the marked issue exists: found first among `found` (a
   * lookup by label, or the parent's sub-issues), and created only when it
   * isn't there. `body` starts with `marker`.
   */
  async ensureIssue(
    found: readonly IssueSummary[],
    marker: string,
    issue: { title: string; body: string; labels: string[] },
    point: string,
    signal?: AbortSignal,
  ): Promise<IssueSummary> {
    const existing = await this.markedIssue(found, marker, signal);
    if (existing) return existing;
    crashPoint(`${point}:before`);
    const created = await this.rest<IssueSummary>(
      "POST",
      `/repos/${this.repository}/issues`,
      issue,
      signal,
    );
    crashPoint(`${point}:after`);
    return created;
  }

  /** Edit an issue's title, body or native type; unchanged fields are left out. */
  async editIssue(
    issue: number,
    fields: { title?: string; body?: string; type?: string },
    point: string,
    signal?: AbortSignal,
  ): Promise<void> {
    crashPoint(`${point}:before`);
    await this.rest(
      "PATCH",
      `/repos/${this.repository}/issues/${issue}`,
      fields,
      signal,
    );
    crashPoint(`${point}:after`);
  }

  /** An issue's sub-issues, bounded (GitHub allows 100 per parent). */
  subIssues(parent: number, signal?: AbortSignal): Promise<IssueSummary[]> {
    return this.pages<IssueSummary>(
      `/repos/${this.repository}/issues/${parent}/sub_issues`,
      signal,
      undefined,
      3,
    );
  }

  /** Make `child` a sub-issue of `parent`, unless it is among `existing` (the parent's sub-issues). */
  async ensureSubIssue(
    parent: number,
    child: Pick<IssueSummary, "id" | "number">,
    existing: readonly IssueSummary[],
    point: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (existing.some((issue) => issue.number === child.number)) return;
    crashPoint(`${point}:before`);
    await this.rest(
      "POST",
      `/repos/${this.repository}/issues/${parent}/sub_issues`,
      { sub_issue_id: child.id },
      signal,
    );
    crashPoint(`${point}:after`);
  }

  /**
   * Make `issue`'s blocked-by links mirror `blockers`: the links it has are
   * read first, missing ones are added, and a link to one of `owned` (the
   * issues these links are Factory's to manage) that isn't wanted is
   * removed. Links to other issues are never touched.
   */
  async ensureBlockedBy(
    issue: number,
    blockers: readonly Pick<IssueSummary, "id" | "number">[],
    owned: ReadonlySet<number>,
    point: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = `/repos/${this.repository}/issues/${issue}/dependencies/blocked_by`;
    const linked = await this.blockedBy(issue, signal);
    const want = new Set(blockers.map((blocker) => blocker.number));
    const has = new Set(linked.map((blocker) => blocker.number));
    for (const blocker of blockers)
      if (!has.has(blocker.number)) {
        crashPoint(`${point}:before`);
        await this.rest("POST", path, { issue_id: blocker.id }, signal);
        crashPoint(`${point}:after`);
      }
    for (const blocker of linked)
      if (owned.has(blocker.number) && !want.has(blocker.number)) {
        crashPoint(`${point}:before`);
        await this.rest("DELETE", `${path}/${blocker.id}`, undefined, signal);
        crashPoint(`${point}:after`);
      }
  }

  /** The issues `issue` is blocked by (its native blocked-by links), bounded. */
  blockedBy(issue: number, signal?: AbortSignal): Promise<IssueSummary[]> {
    return this.pages<IssueSummary>(
      `/repos/${this.repository}/issues/${issue}/dependencies/blocked_by`,
      signal,
      undefined,
      3,
    );
  }

  /** Whether `found` is an issue of this repository, not one a link names elsewhere. */
  ownIssue(found: Pick<IssueSummary, "repository_url">): boolean {
    return (
      found.repository_url === undefined ||
      found.repository_url
        .toLowerCase()
        .endsWith(`/repos/${this.repository.toLowerCase()}`)
    );
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
    const result = (await this.body(
      response,
      "POST",
      "/graphql",
      signal,
      "json",
    )) as {
      data?: T;
      errors?: GraphQLError[];
    } | null;
    if (!result) throw new TransientError("GitHub GraphQL: no answer");
    const errors = result.errors ?? [];
    const refused = errors.filter((e) => !accept(e));
    if (refused.length) {
      const message = refused.map((e) => e.message).join("; ");
      if (refused.some((e) => e.type === "RATE_LIMITED")) {
        const counted = transport.getStore() ?? this.ambient;
        counted.rateLimited += 1;
        // One line per answer: the one send() traced becomes the rate-limit.
        const { answered, noted } = answers.get(response)!;
        if (noted) counted.requests?.splice(counted.requests.indexOf(noted), 1);
        note(
          counted,
          { ...answered, category: "rate-limit", rateLimited: true },
          response,
        );
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

  /**
   * Every item of a paginated list of 100 per page, up to `maxPages` pages.
   * A list that goes on past them throws (not transient: asking again
   * finds as many), so a lookup by marker never misses what it looks for
   * and makes it again.
   */
  async pages<T>(
    path: string,
    signal?: AbortSignal,
    pick: (body: unknown) => unknown = (body) => body,
    maxPages = 50,
    /** Whether to read on past this full page. */
    more: (listed: T[]) => boolean = () => true,
  ): Promise<T[]> {
    const all: T[] = [];
    const join = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
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
      if (page > maxPages) {
        if (listed.length)
          throw new Error(
            `GitHub GET ${path}: more than ${maxPages * 100} to look up, past the ${maxPages}-page cap`,
          );
        return all;
      }
      all.push(...(listed as T[]));
      if (listed.length < 100 || !more(listed as T[])) return all;
    }
  }

  // ── Pull request delivery (delivery.ts) ─────────────────────────────────

  private repo(path: string): string {
    return `/repos/${this.repository}${path ? `/${path}` : ""}`;
  }

  /** A read the login may not be allowed: 403 or 404 is undefined. */
  private async optional<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await expecting([403, 404], read);
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
      ({ permission } = await expecting([404], () =>
        this.rest<{ permission: string }>(
          "GET",
          this.repo(`collaborators/${encodeURIComponent(login)}/permission`),
          undefined,
          signal,
        ),
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

  /** Set PR `pull`'s body, unless it already reads `body`. */
  async updatePull(
    pull: Pick<PullRequest, "number" | "body">,
    body: string,
    point: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (pull.body === body) return;
    crashPoint(`${point}:before`);
    await this.rest(
      "PATCH",
      this.repo(`pulls/${pull.number}`),
      { body },
      signal,
    );
    crashPoint(`${point}:after`);
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
    return this.optional(() =>
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
    return (await this.checksPolicy(branch, signal)).names;
  }

  /**
   * `requiredChecks`, and whether a rule or the classic protection requires
   * a branch to be up to date before it merges (strict); undefined when
   * no rule does and the login can't read the classic protection's.
   */
  async checksPolicy(
    branch: string,
    signal?: AbortSignal,
  ): Promise<{ names: string[]; strict: boolean | undefined }> {
    const name = encodeURIComponent(branch);
    const rules =
      (await this.optional(() =>
        this.pages<{
          type?: string;
          parameters?: {
            required_status_checks?: { context?: unknown }[];
            strict_required_status_checks_policy?: unknown;
          };
        }>(this.repo(`rules/branches/${name}`), signal),
      )) ?? [];
    type Required =
      | { contexts?: unknown; checks?: unknown; strict?: unknown }
      | null
      | undefined;
    let classic: Required;
    // The branch read's protection never shows `strict`.
    let strictKnown = true;
    try {
      classic = await expecting([403, 404], () =>
        this.rest<Required>(
          "GET",
          this.repo(`branches/${name}/protection/required_status_checks`),
          undefined,
          signal,
        ),
      );
    } catch (error) {
      if (!(error instanceof GitHubError && [403, 404].includes(error.status)))
        throw error;
      // 404: unprotected, or no required checks. 403: the login may not read
      // protection settings; the branch read shows the same checks.
      strictKnown = error.status === 404;
      if (error.status === 403)
        classic = (
          await this.rest<{
            protection?: { required_status_checks?: Required };
          }>("GET", this.repo(`branches/${name}`), undefined, signal)
        ).protection?.required_status_checks;
    }
    const names = [
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
    const strict =
      classic?.strict === true ||
      rules.some(
        (rule) =>
          rule.type === "required_status_checks" &&
          rule.parameters?.strict_required_status_checks_policy === true,
      )
        ? true
        : strictKnown
          ? false
          : undefined;
    return { names, strict };
  }

  /**
   * The rules on `branch` that require approving reviews: each ruleset
   * whose pull_request rule requires one, and the classic protection's
   * required reviews. A bypass doesn't count: GitHub reports the PR BLOCKED
   * with REVIEW_REQUIRED even to a login that may bypass the rule, so
   * delivery waits all the same. A rule the login can't read is left out.
   */
  async requiredReviews(
    branch: string,
    signal?: AbortSignal,
  ): Promise<{ rule: string; count: number }[]> {
    const name = encodeURIComponent(branch);
    const rules =
      (await this.optional(() =>
        this.pages<{
          type?: string;
          ruleset_id?: number;
          parameters?: { required_approving_review_count?: unknown };
        }>(this.repo(`rules/branches/${name}`), signal),
      )) ?? [];
    const found: { rule: string; count: number }[] = [];
    for (const rule of rules) {
      const count = rule.parameters?.required_approving_review_count;
      if (rule.type !== "pull_request" || typeof count !== "number" || !count)
        continue;
      const ruleset = await this.optional(() =>
        this.rest<{ name?: unknown }>(
          "GET",
          this.repo(`rulesets/${rule.ruleset_id}`),
          undefined,
          signal,
        ),
      );
      found.push({
        rule: `ruleset "${String(ruleset?.name ?? rule.ruleset_id)}"`,
        count,
      });
    }
    const count = (
      await this.optional(() =>
        this.rest<{
          required_pull_request_reviews?: {
            required_approving_review_count?: unknown;
          };
        }>("GET", this.repo(`branches/${name}/protection`), undefined, signal),
      )
    )?.required_pull_request_reviews?.required_approving_review_count;
    if (typeof count === "number" && count > 0)
      found.push({ rule: "branch protection", count });
    return found;
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
      (await this.optional(() =>
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
    const classic = await this.optional(() =>
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
    const activity = await this.optional(() =>
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
   * The merge commit of a merged PR, from GraphQL (PR responses in the
   * pinned REST version may omit it). Undefined while GitHub does not show
   * the PR merged with its commit yet.
   */
  async mergeCommitOf(
    number: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const data = await this.graphql<{
      repository?: {
        pullRequest?: {
          merged?: boolean;
          mergeCommit?: { oid?: unknown } | null;
        } | null;
      } | null;
    }>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) { merged mergeCommit { oid } }
        }
      }`,
      { owner: this.owner, name: this.name, number },
      signal,
    );
    const pull = data.repository?.pullRequest;
    const oid = pull?.mergeCommit?.oid;
    return pull?.merged && typeof oid === "string" && /^[a-f0-9]{40}$/.test(oid)
      ? oid
      : undefined;
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
    const range = { range: `bytes=-${64 * 1024}` };
    let response: Response;
    try {
      response = await this.send(
        "GET",
        this.repo(`actions/jobs/${job}/logs`),
        undefined,
        signal,
        range,
      );
    } catch (error) {
      // The log is served from a signed link to storage: read without
      // Factory's login, and never redirected again.
      if (!(error instanceof GitHubError && error.status === 302)) throw error;
      if (!error.location) return undefined;
      const deadline = AbortSignal.timeout(TIMEOUT_MS);
      try {
        response = await fetch(error.location, {
          headers: range,
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
      } catch (failure) {
        if (signal?.aborted) throw failure;
        throw new TransientError(`job ${job} log: ${errorMessage(failure)}`);
      }
      if (!response.ok) return undefined;
    }
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
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TransientError(`job ${job} log: ${errorMessage(error)}`);
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
    if (this.renamed) throw this.renamed;
    const token = await this.auth(refreshed);
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const sent =
      body === undefined
        ? undefined
        : JSON.stringify(
            method === "GET" ? body : redactDeep(body, this.secrets),
          );
    // A step's or a sync job's scope, else the service run's own.
    const counted = transport.getStore() ?? this.ambient;
    counted.calls += 1;
    if (refreshed) counted.retries += 1;
    counted.bytes += sent === undefined ? 0 : Buffer.byteLength(sent);
    const attempt = refreshed ? 2 : 1;
    const sentAt = Date.now();
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
        ...(sent === undefined ? {} : { body: sent }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        // Never followed: a redirect is an answer (see `moved`).
        redirect: "manual",
      });
    } catch (error) {
      const ms = Date.now() - sentAt;
      counted.requestMs += ms;
      counted.failed += 1;
      note(
        counted,
        {
          method,
          path,
          status: null,
          attempt,
          ms,
          category: networkCategory(error, Boolean(signal?.aborted)),
        },
        undefined,
      );
      if (signal?.aborted) throw error;
      throw new TransientError(
        `GitHub ${method} ${path}: ${errorMessage(error)}`,
      );
    }
    const ms = Date.now() - sentAt;
    counted.requestMs += ms;
    counted.bytes += Number(response.headers.get("content-length")) || 0;
    const answered = { method, path, status: response.status, attempt, ms };
    if (response.ok) {
      // A re-send that worked is traced too: it was retried.
      answers.set(response, {
        answered,
        noted:
          refreshed || counted.every
            ? note(counted, answered, response)
            : undefined,
      });
      return response;
    }
    const text = await response.text().catch(() => "");
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = undefined;
    }
    const detail = `GitHub ${method} ${path}: ${response.status} ${text.slice(0, 300)}`;
    if (response.status === 401 && !refreshed) {
      note(counted, { ...answered, category: "credential" }, response);
      return this.send(method, path, body, signal, headers, true);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    // GitHub marks a 403 rate limit (primary or secondary) by its headers;
    // a 403 without them may still be a secondary limit (githubOutcome).
    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")));
    const expected =
      !limited && expectedStatuses.getStore()?.includes(response.status);
    if (!expected) {
      if (limited) counted.rateLimited += 1;
      else counted.failed += 1;
    }
    if (!expected || counted.every)
      note(
        counted,
        {
          ...answered,
          ...(expected
            ? {}
            : { category: statusCategory(response.status, limited) }),
          ...(limited ? { rateLimited: true as const } : {}),
        },
        response,
      );
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
    // A 301 for the repository itself is its move; one under it is an
    // issue (or other resource) moved away only while the repository still
    // answers under its configured name. An identity that can't be read
    // now leaves the answer to a later try: never a gone issue.
    const root = `/repos/${this.repository}`;
    if (response.status === 301 && path.split("?")[0] === root)
      await this.repositoryMoved(
        response.headers.get("location") ?? undefined,
        signal,
      );
    if (response.status === 301 && path.startsWith(`${root}/`))
      await this.checkIdentity(signal).catch((error: unknown) => {
        if (error instanceof TransientError) throw error;
        throw new TransientError(
          `${detail}; the repository's identity is unreadable: ${errorMessage(error)}`,
        );
      });
    // A 5xx is an outage, not a limit: GitHub sends x-ratelimit-* headers on
    // every answer, so only its retry-after counts, and only as a backoff.
    if (response.status >= 500)
      throw new TransientError(
        detail,
        retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    // Something Factory just made may not show yet (GitHub's lag): a
    // refusal or a 404 there retries; past FRESH_MS it stands.
    if (
      (response.status === 403 || response.status === 404) &&
      this.isFresh(path)
    )
      throw new TransientError(
        `${detail} (Factory made this within the last ${FRESH_MS / 60_000} min, so GitHub may not show it yet)`,
      );
    const failed = new GitHubError(
      detail,
      response.status,
      answer,
      response.headers.get("location") ?? undefined,
    );
    const issue = path.startsWith(`${root}/issues/`)
      ? /^(\d+)(?:[/?]|$)/.exec(path.slice(root.length + 8))
      : null;
    if (issue) failed.missingIssue = Number(issue[1]);
    throw failed;
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
export function sameLogin(a: string, b: string): boolean {
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
