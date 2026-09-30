import { setTimeout } from "node:timers/promises";
import { Octokit } from "@octokit/core";
import { commandAsync, currentProcessSignal } from "./process.js";

/** A mutation may have reached GitHub even when its response was lost. */
export class GitHubOutcomeUnknown extends Error {
  constructor() {
    super(
      "GitHub mutation outcome unknown; reconcile authenticated evidence before retrying",
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
          throw new Error("GitHub credential lookup failed");
        }
        if (!token)
          throw new Error("GitHub credential lookup returned no credential");
        return new Octokit({ auth: token, baseUrl: "https://api.github.com" });
      })();
      void this.client.catch(() => {
        this.client = undefined;
      });
    }
    return this.client;
  }

  private observeRate(
    headers: Record<string, string | number | undefined>,
    status: number,
    message = "",
  ): void {
    const now = Date.now();
    const retry = headers["retry-after"];
    if (retry !== undefined) {
      const seconds = Number(retry);
      const until = Number.isFinite(seconds)
        ? now + seconds * 1000
        : Date.parse(String(retry));
      if (Number.isFinite(until))
        this.notBefore = Math.max(this.notBefore, until);
    }
    if (String(headers["x-ratelimit-remaining"]) === "0") {
      const reset = Number(headers["x-ratelimit-reset"]);
      // Missing reset cannot establish permission to immediately retry.
      this.notBefore = Math.max(
        this.notBefore,
        Number.isFinite(reset) && reset > 0
          ? reset * 1000
          : Number.POSITIVE_INFINITY,
      );
    }
    if (
      retry === undefined &&
      String(headers["x-ratelimit-remaining"]) !== "0" &&
      (status === 403 || status === 429) &&
      (status === 429 || /secondary rate|abuse detection/i.test(message))
    )
      this.notBefore = Math.max(this.notBefore, now + 60_000);
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
      if (!Number.isFinite(this.notBefore))
        throw new Error("GitHub rate reset unavailable; requests stopped");
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
          response?: { headers?: Record<string, string | number | undefined> };
        };
        this.observeRate(
          error.response?.headers ?? {},
          error.status ?? 0,
          error.message,
        );
        if (observation && method === "GET" && error.status === 304)
          return { status: 304, etag: error.response?.headers?.etag } as T;
        if (
          !readOnly &&
          (!error.status || error.status >= 500 || signal?.aborted)
        )
          throw new GitHubOutcomeUnknown();
        throw new Error(
          `GitHub request failed${error.status ? ` (HTTP ${error.status})` : ""}`,
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
