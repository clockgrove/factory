import { setTimeout } from "node:timers/promises";
import { Octokit } from "@octokit/core";
import { attachFault, decision, transient, type Fault } from "./fault.js";
import { commandAsync, currentProcessSignal } from "./process.js";

/** A mutation may have reached GitHub even when its response was lost. */
export class GitHubOutcomeUnknown extends Error {
  constructor() {
    super(
      "GitHub mutation outcome unknown; reconcile authenticated evidence before retrying",
    );
  }
}

/**
 * GitHub refusals recognised by their documented message or error code.
 * Only this code is kept: the server's prose is never retained.
 */
export type GitHubRefusal =
  | "merge-method-not-allowed"
  | "base-modified"
  | "already-exists";

/** A completed HTTP rejection exposes only its status, never transport data. */
export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly refusal?: GitHubRefusal,
  ) {
    super(`GitHub request failed (HTTP ${status})`);
  }
}

/** GitHub's documented minimum wait when a limit gives no reset time. */
const RATE_LIMIT_FALLBACK_MS = 60_000;

/** How long GitHub may not yet show an object Factory just created. */
export const GITHUB_LAG_MS = 120_000;

const GITHUB_LOGIN: Extract<Fault, { kind: "config" }> = {
  kind: "config",
  detail: "GitHub CLI has no usable login on the controller host",
  fix: "Run `gh auth login --hostname github.com`, then `factory run`",
};

function refusal(status: number, data: unknown): GitHubRefusal | undefined {
  const body = data as
    | { message?: unknown; errors?: { code?: unknown; message?: unknown }[] }
    | null
    | undefined;
  const message = typeof body?.message === "string" ? body.message : "";
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (status === 405) {
    if (
      /\b(merge commits|squash merges|rebase merges) are not allowed\b/i.test(
        message,
      )
    )
      return "merge-method-not-allowed";
    if (/\bbase branch was modified\b/i.test(message)) return "base-modified";
  }
  if (
    status === 422 &&
    errors.some(
      (error) =>
        error?.code === "already_exists" ||
        (typeof error?.message === "string" &&
          /\bpull request already exists\b/i.test(error.message)),
    )
  )
    return "already-exists";
  return undefined;
}

/** What a gateway method knows about one of its requests. */
export interface GitHubCall {
  method: string;
  /** Route below `repos/{owner}/{name}/`; "" is the repository itself. */
  path: string;
  /** When Factory created the object the route names (epoch ms), if it just did. */
  createdAt?: number;
  /** For a merge refused over its head: whether GitHub holds the head Factory pushed. */
  head?: "ours" | "foreign";
}

const GITHUB_PERMISSION_FIX =
  "Give the GitHub login write access to the repository's contents, issues and pull requests, then `factory run`";

/** Routes whose 404 means the repository lacks the feature, not the object. */
const FEATURE_ROUTE = /^(stacks\b|issues\/\d+\/(dependencies|sub_issues)\b)/;

/**
 * Classify a GitHub rejection with the calling gateway method's context.
 * Rate limits, 5xx and lost responses were already classified by the client;
 * this handles statuses whose meaning depends on the call.
 */
export function gitHubFault(
  error: unknown,
  call: GitHubCall,
  now = Date.now(),
): Fault | undefined {
  if (!(error instanceof GitHubRequestError)) return undefined;
  const path = call.path.split("?")[0]!;
  const what = `${call.method} ${path || "repository"}`;
  const merge = /^pulls\/\d+\/merge(-async)?$/.test(path);
  switch (error.status) {
    case 401:
      return { ...GITHUB_LOGIN, detail: `GitHub rejected the login (${what})` };
    case 403:
      return {
        kind: "config",
        detail: `GitHub login lacks permission (${what})`,
        fix: GITHUB_PERMISSION_FIX,
      };
    case 404:
      if (!path)
        return {
          kind: "config",
          detail: "GitHub does not show the repository to this login",
          fix: GITHUB_PERMISSION_FIX,
        };
      // An object Factory created moments ago may not be visible yet,
      // even through its dependency or sub-issue routes.
      if (call.createdAt !== undefined && now - call.createdAt < GITHUB_LAG_MS)
        return transient(`GitHub does not show ${what} yet`, false);
      if (FEATURE_ROUTE.test(path))
        return {
          kind: "config",
          detail: `GitHub does not offer ${what} for this repository`,
          fix: "Enable issue dependencies, sub-issues and stacked pull requests for the repository, then `factory run`",
        };
      return decision(
        "GitHub no longer shows an object Factory recorded. Was it deleted or transferred? Inspect it, then retry or cancel.",
        `${what} returned 404`,
      );
    case 405:
      if (!merge) return undefined;
      if (error.refusal === "merge-method-not-allowed")
        return {
          kind: "config",
          detail: "The repository does not allow merge commits",
          fix: "Allow merge commits in the repository settings, then `factory run`",
        };
      // Re-observe and repeat with the same head.
      if (error.refusal === "base-modified")
        return transient(`The base branch moved during ${what}`, false);
      return decision(
        "GitHub refused the merge (not mergeable, or a repository rule). Inspect the pull request, then retry or cancel.",
        `${what} returned 405`,
      );
    case 409:
      if (!merge) return undefined;
      return call.head === "foreign"
        ? decision(
            "The pull request head differs from what Factory recorded. Inspect it, then retry or cancel.",
            `${what} returned 409`,
          )
        : transient(`GitHub has not settled the PR head (${what})`, false);
    case 410:
      return {
        kind: "config",
        detail: `GitHub refused ${what} (HTTP 410)`,
        fix: "Enable issues for the repository, then `factory run`",
      };
    case 422:
      // An existing object may be our own lost write: read it back. Any other
      // validation failure rejects a value (often model-derived) as given.
      return error.refusal === "already-exists"
        ? transient(`GitHub already has ${what}; read it back`, true)
        : decision(
            "GitHub rejected a value Factory submitted. Inspect it, then retry or cancel.",
            `${what} returned 422`,
          );
    default:
      return undefined;
  }
}

/**
 * Whether a 404 came from lost repository access. Probed only on the failure
 * path; `issues/{n}/parent` answers 404 for "no parent", so it is not probed.
 */
async function lostAccess(
  client: GitHubClient,
  repository: string,
  error: unknown,
  call: GitHubCall,
): Promise<Fault | undefined> {
  const path = call.path.split("?")[0]!;
  if (
    !(error instanceof GitHubRequestError) ||
    error.status !== 404 ||
    !path ||
    FEATURE_ROUTE.test(path) ||
    /\/parent$/.test(path)
  )
    return undefined;
  try {
    await client.request("GET", `repos/${repository}/`);
    return undefined;
  } catch (probe) {
    if (
      probe instanceof GitHubRequestError &&
      [401, 403, 404].includes(probe.status)
    )
      return {
        kind: "config",
        detail: `GitHub no longer shows the repository to this login (${call.method} ${path} returned 404)`,
        fix: GITHUB_PERMISSION_FIX,
      };
    return transient("GitHub could not confirm repository access", false);
  }
}

/** Run one gateway request and classify its rejection with the call's context. */
export async function classifiedGitHubCall<T>(
  client: GitHubClient,
  repository: string,
  call: GitHubCall,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw attachFault(
      error,
      (await lostAccess(client, repository, error, call)) ??
        gitHubFault(error, call),
    );
  }
}

/** One account/host gate shared by ordinary and native-stack delivery. No retries. */
export class GitHubClient {
  private client?: Promise<Octokit>;
  private queue: Promise<void> = Promise.resolve();
  private notBefore = 0;

  constructor(private readonly supplied?: Octokit) {}

  private octokit(): Promise<Octokit> {
    if (!this.client) {
      this.client = (async () => {
        if (this.supplied) return this.supplied;
        let token: string;
        try {
          token = await commandAsync("gh", [
            "auth",
            "token",
            "--hostname",
            "github.com",
          ]);
        } catch {
          throw attachFault(
            new Error("GitHub credential lookup failed"),
            GITHUB_LOGIN,
          );
        }
        if (!token)
          throw attachFault(
            new Error("GitHub credential lookup returned no credential"),
            GITHUB_LOGIN,
          );
        return new Octokit({ auth: token, baseUrl: "https://api.github.com" });
      })();
      void this.client.catch(() => {
        this.client = undefined;
      });
    }
    return this.client;
  }

  /**
   * Gate later requests on this response's rate-limit headers. Returns the
   * time the gate opens when a 403 or 429 was a rate limit, so the rejection
   * can be classified as transient rather than as a permission failure.
   */
  private observeRate(
    headers: Record<string, string | number | undefined>,
    status: number,
    message = "",
  ): number | undefined {
    const now = Date.now();
    let limited = false;
    const retry = headers["retry-after"];
    if (retry !== undefined) {
      const seconds = Number(retry);
      const until = Number.isFinite(seconds)
        ? now + seconds * 1000
        : Date.parse(String(retry));
      if (Number.isFinite(until)) {
        this.notBefore = Math.max(this.notBefore, until);
        limited = true;
      }
    }
    if (String(headers["x-ratelimit-remaining"]) === "0") {
      const reset = Number(headers["x-ratelimit-reset"]);
      // Without a reset time, wait GitHub's documented minimum. A missing
      // header once stopped every later request for the process lifetime.
      this.notBefore = Math.max(
        this.notBefore,
        Number.isFinite(reset) && reset > 0
          ? reset * 1000
          : now + RATE_LIMIT_FALLBACK_MS,
      );
      limited = true;
    }
    if (
      retry === undefined &&
      String(headers["x-ratelimit-remaining"]) !== "0" &&
      (status === 403 || status === 429) &&
      (status === 429 || /secondary rate|abuse detection/i.test(message))
    ) {
      this.notBefore = Math.max(this.notBefore, now + RATE_LIMIT_FALLBACK_MS);
      limited = true;
    }
    return limited && (status === 403 || status === 429)
      ? this.notBefore
      : undefined;
  }

  async request<T>(
    method: string,
    route: string,
    body?: Record<string, unknown>,
    observation?: { etag?: string },
  ): Promise<T> {
    if (
      !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(route) ||
      route.includes("#") ||
      route.includes("\\")
    )
      throw new Error("GitHub route is outside the approved repository API");
    if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method))
      throw new Error("Unsupported GitHub method");
    return this.dispatch<T>(method, route, body, observation, method === "GET");
  }

  /** The login of the token's user: the author of everything Factory creates. */
  async viewer(): Promise<string> {
    const user = await this.dispatch<{ login?: unknown }>(
      "GET",
      "user",
      undefined,
      undefined,
      true,
    );
    if (typeof user?.login !== "string" || !user.login)
      throw new Error("GitHub returned no login for the token's user");
    return user.login;
  }

  /** Fixed repository-scoped observation; callers cannot submit arbitrary GraphQL. */
  async pullRequestReadiness(
    repository: string,
    number: number,
  ): Promise<{
    number: number;
    headRefOid: string;
    headRefName: string;
    baseRefName: string;
    mergeStateStatus: string;
  }> {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(number) ||
      number <= 0
    )
      throw new Error("Invalid PR readiness identity");
    const [owner, name] = repository.split("/");
    const response = await this.dispatch<{
      errors?: unknown[];
      data?: {
        repository?: {
          pullRequest?: {
            number: number;
            headRefOid: string;
            headRefName: string;
            baseRefName: string;
            mergeStateStatus: string;
          } | null;
        } | null;
      } | null;
    }>(
      "POST",
      "graphql",
      {
        query: `query FactoryPullRequestReadiness($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            number headRefOid headRefName baseRefName mergeStateStatus
          }
        }
      }`,
        variables: { owner, name, number },
      },
      undefined,
      true,
    );
    const pull = response.data?.repository?.pullRequest;
    // GraphQL reports its rate limit inside an HTTP 200, so gate later
    // requests here as the REST headers would.
    if (
      Array.isArray(response.errors) &&
      response.errors.some(
        (error) =>
          (error as { type?: unknown } | null)?.type === "RATE_LIMITED",
      )
    ) {
      this.notBefore = Math.max(
        this.notBefore,
        Date.now() + RATE_LIMIT_FALLBACK_MS,
      );
      throw attachFault(
        new Error("GitHub PR readiness observation is unavailable"),
        transient(
          "GitHub GraphQL rate limit",
          false,
          new Date(this.notBefore).toISOString(),
        ),
      );
    }
    if (
      (response.errors !== undefined &&
        (!Array.isArray(response.errors) || response.errors.length)) ||
      !pull ||
      pull.number !== number ||
      typeof pull.headRefOid !== "string" ||
      typeof pull.headRefName !== "string" ||
      typeof pull.baseRefName !== "string" ||
      typeof pull.mergeStateStatus !== "string"
    )
      throw new Error("GitHub PR readiness observation is unavailable");
    return pull;
  }

  private async dispatch<T>(
    method: string,
    route: string,
    body: Record<string, unknown> | undefined,
    observation: { etag?: string } | undefined,
    readOnly: boolean,
  ): Promise<T> {
    const signal = currentProcessSignal();
    signal?.throwIfAborted();
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () =>
        reject(new Error("GitHub request cancelled before dispatch"));
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    try {
      await Promise.race([previous, aborted]);
      signal?.throwIfAborted();
      const client = await this.octokit();
      while (Date.now() < this.notBefore)
        await setTimeout(this.notBefore - Date.now(), undefined, { signal });
      signal?.throwIfAborted();
      try {
        const response = await client.request(`${method} /${route}`, {
          ...body,
          baseUrl: "https://api.github.com",
          headers: {
            "x-github-api-version": "2026-03-10",
            ...(observation?.etag ? { "if-none-match": observation.etag } : {}),
          },
          request: { signal },
        });
        this.observeRate(response.headers, response.status);
        return (
          observation
            ? {
                status: response.status,
                etag: response.headers.etag,
                data: response.data,
              }
            : response.data
        ) as T;
      } catch (cause) {
        const error = cause as {
          status?: number;
          message?: string;
          response?: {
            headers?: Record<string, string | number | undefined>;
            data?: unknown;
          };
        };
        const limitedUntil = this.observeRate(
          error.response?.headers ?? {},
          error.status ?? 0,
          error.message,
        );
        if (observation && method === "GET" && error.status === 304)
          return { status: 304, etag: error.response?.headers?.etag } as T;
        // Only facts that mean the same for every caller are classified
        // here; the gateway classifies statuses whose meaning depends on it.
        if (
          !readOnly &&
          (!error.status || error.status >= 500 || signal?.aborted)
        )
          throw attachFault(
            new GitHubOutcomeUnknown(),
            transient(
              error.status
                ? `GitHub answered HTTP ${error.status} to a ${method}; it may have taken effect`
                : `GitHub ${method} response was lost; it may have taken effect`,
              true,
            ),
          );
        if (error.status) {
          const rejection = new GitHubRequestError(
            error.status,
            refusal(error.status, error.response?.data),
          );
          throw attachFault(
            rejection,
            limitedUntil !== undefined
              ? transient(
                  `GitHub rate limit (HTTP ${error.status})`,
                  false,
                  new Date(limitedUntil).toISOString(),
                )
              : error.status >= 500
                ? transient(`GitHub HTTP ${error.status}`, false)
                : undefined,
          );
        }
        throw attachFault(
          new Error("GitHub request failed"),
          transient("GitHub request failed in transit", false),
        );
      }
    } finally {
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      void previous.then(release);
    }
  }

  async paginate<T>(route: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const values = await this.request<T[]>(
        "GET",
        `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(values))
        throw new Error("GitHub returned an invalid paginated response");
      result.push(...values);
      if (values.length < 100) return result;
    }
  }
}

export const sharedGitHubClient = new GitHubClient();

/**
 * The merge commit of a merged pull request, read from its issue timeline.
 * PR responses in the pinned API version omit `merge_commit_sha`.
 */
export async function timelineMergeCommit(
  client: GitHubClient,
  repository: string,
  pullRequest: number,
): Promise<string> {
  const events = await client.paginate<{ event?: string; commit_id?: unknown }>(
    `repos/${repository}/issues/${pullRequest}/timeline`,
  );
  const commits = new Set<string>();
  for (const event of events) {
    if (event?.event !== "merged") continue;
    if (
      typeof event.commit_id !== "string" ||
      !/^[a-f0-9]{40}$/.test(event.commit_id)
    )
      throw new Error(`PR #${pullRequest} has malformed merge evidence`);
    commits.add(event.commit_id);
  }
  if (commits.size !== 1)
    throw attachFault(
      new Error(`PR #${pullRequest} has missing or conflicting merge evidence`),
      // A merge the timeline does not show yet is read-after-write lag; two
      // merge commits for one PR is a broken invariant.
      commits.size === 0
        ? transient(
            `PR #${pullRequest} merge is not on its timeline yet`,
            false,
          )
        : undefined,
    );
  return [...commits][0]!;
}
