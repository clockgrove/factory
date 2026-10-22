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

  private async send(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
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
      return this.send(method, path, body, signal, true);
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          /rate limit/i.test(text)));
    if (limited || response.status >= 500 || response.status === 401)
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
