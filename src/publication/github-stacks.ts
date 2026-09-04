import type { StackCapability } from "./delivery.js";

export const GITHUB_STACKS_API_VERSION = "2026-03-10" as const;

export interface GitHubStackTransport {
  request(
    route: string,
    parameters: Record<string, unknown>,
    mutating?: boolean,
  ): Promise<{ status: number; data: unknown }>;
}

export interface GitHubStackPullRequest {
  number: number;
  state: string;
  draft: boolean;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
  baseRef?: string;
  baseSha?: string;
}

export interface GitHubStack {
  number: number;
  baseRef: string;
  open: boolean;
  pullRequests: GitHubStackPullRequest[];
}

export type AsyncMergeResult =
  | {
      state: "pending";
      uuid: string;
      expectedHeadSha: string;
      mergeAction: "default" | "direct_merge" | "merge_queue";
      mergeMethod: "merge" | "squash" | "rebase";
    }
  | { state: "queued"; expectedHeadSha: string }
  | { state: "merged"; mergeSha: string }
  | { state: "failed"; reason: string };

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub ${label} response is malformed`);
  }
  return value as JsonRecord;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`GitHub ${label} is malformed`);
  }
  return Number(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`GitHub ${label} is malformed`);
  }
  return value;
}

function gitSha(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[0-9a-f]{40}$/i.test(result)) {
    throw new Error(`GitHub ${label} is malformed`);
  }
  return result;
}

function parsePull(value: unknown): GitHubStackPullRequest {
  const pull = record(value, "stack pull request");
  const head = record(pull.head, "stack pull request head");
  const base = pull.base === undefined ? undefined : record(pull.base, "stack pull request base");
  return {
    number: integer(pull.number, "stack pull request number"),
    state: string(pull.state, "stack pull request state"),
    draft: pull.draft === true,
    mergedAt:
      pull.merged_at === null || pull.merged_at === undefined
        ? null
        : string(pull.merged_at, "stack pull request merged_at"),
    headRef: string(head.ref, "stack pull request head ref"),
    headSha: gitSha(head.sha, "stack pull request head SHA"),
    ...(base && base.ref !== undefined
      ? { baseRef: string(base.ref, "stack pull request base ref") }
      : {}),
    ...(base && base.sha !== undefined
      ? { baseSha: gitSha(base.sha, "stack pull request base SHA") }
      : {}),
  };
}

function parseStack(value: unknown): GitHubStack {
  const stack = record(value, "stack");
  const base = record(stack.base, "stack base");
  if (!Array.isArray(stack.pull_requests)) {
    throw new Error("GitHub stack pull_requests response is malformed");
  }
  return {
    number: integer(stack.number, "stack number"),
    baseRef: string(base.ref, "stack base ref"),
    open: stack.open === true,
    pullRequests: stack.pull_requests.map(parsePull),
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function exactPulls(stack: GitHubStack, expected: readonly number[]): boolean {
  return (
    stack.pullRequests.length === expected.length &&
    stack.pullRequests.every((pull, index) => pull.number === expected[index])
  );
}

function mergeDetails(data: unknown): JsonRecord {
  const root = record(data, "asynchronous merge");
  return record(root.details, "asynchronous merge details");
}

function normalizeAsyncMerge(data: unknown): AsyncMergeResult {
  const root = record(data, "asynchronous merge");
  const state = string(root.status, "asynchronous merge status");
  const details = mergeDetails(root);
  if (state === "merged") {
    return { state: "merged", mergeSha: gitSha(details.sha, "merge SHA") };
  }
  if (state === "pending") {
    const action = string(details.merge_action, "merge action");
    if (!new Set(["default", "direct_merge", "merge_queue"]).has(action)) {
      throw new Error(`GitHub returned unknown asynchronous merge action ${action}`);
    }
    const method = string(details.merge_method, "merge method");
    if (!new Set(["merge", "squash", "rebase"]).has(method)) {
      throw new Error(`GitHub returned unknown asynchronous merge method ${method}`);
    }
    return {
      state: "pending",
      uuid: string(details.uuid, "asynchronous merge UUID"),
      expectedHeadSha: gitSha(details.expected_head_sha, "expected head SHA"),
      mergeAction: action as "default" | "direct_merge" | "merge_queue",
      mergeMethod: method as "merge" | "squash" | "rebase",
    };
  }
  if (state === "queued") {
    return {
      state: "queued",
      expectedHeadSha: gitSha(details.expected_head_sha, "queued expected head SHA"),
    };
  }
  if (state === "failed") {
    return {
      state: "failed",
      reason: string(details.message, "asynchronous merge failure message"),
    };
  }
  throw new Error(`GitHub returned unknown asynchronous merge status ${state}`);
}

/** Isolates every versioned stack route and schema from the rest of Factory. */
export class GitHubStacks {
  constructor(
    private readonly transport: GitHubStackTransport,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  #parameters(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      owner: this.owner,
      repo: this.repo,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_STACKS_API_VERSION,
      },
      ...extra,
    };
  }

  async probe(): Promise<StackCapability> {
    try {
      const response = await this.transport.request(
        "GET /repos/{owner}/{repo}/stacks",
        this.#parameters({ per_page: 1 }),
      );
      if (response.status !== 200 || !Array.isArray(response.data)) {
        throw new Error("GitHub stack capability probe returned an unexpected response");
      }
      response.data.forEach(parseStack);
      return {
        available: true,
        observed: true,
        version: GITHUB_STACKS_API_VERSION,
        reason: `repository accepted GitHub stacks API ${GITHUB_STACKS_API_VERSION}`,
      };
    } catch (error) {
      if (status(error) === 404 || status(error) === 403) {
        return {
          available: false,
          observed: true,
          version: GITHUB_STACKS_API_VERSION,
          reason:
            status(error) === 404
              ? `repository did not expose GitHub stacks API ${GITHUB_STACKS_API_VERSION}`
              : `GitHub denied stack capability inspection for this repository`,
        };
      }
      throw error;
    }
  }

  async list(pullRequest?: number): Promise<GitHubStack[]> {
    const response = await this.transport.request(
      "GET /repos/{owner}/{repo}/stacks",
      this.#parameters({ per_page: 100, ...(pullRequest ? { pull_request: pullRequest } : {}) }),
    );
    if (response.status !== 200 || !Array.isArray(response.data)) {
      throw new Error("GitHub list stacks response is malformed");
    }
    return response.data.map(parseStack);
  }

  async get(stackNumber: number): Promise<GitHubStack> {
    const response = await this.transport.request(
      "GET /repos/{owner}/{repo}/stacks/{stack_number}",
      this.#parameters({ stack_number: stackNumber }),
    );
    if (response.status !== 200)
      throw new Error(`GitHub returned ${response.status} reading stack`);
    return parseStack(response.data);
  }

  async ensureStack(pullRequests: readonly number[]): Promise<GitHubStack> {
    if (pullRequests.length < 2 || new Set(pullRequests).size !== pullRequests.length) {
      throw new Error("a native stack requires at least two distinct pull requests");
    }
    const recover = async (): Promise<GitHubStack | null> => {
      const stacks = await this.list(pullRequests[0]);
      const exact = stacks.find((stack) => exactPulls(stack, pullRequests));
      if (exact) return exact;
      if (stacks.length > 0) {
        throw new Error("pull request already belongs to a different GitHub stack topology");
      }
      return null;
    };
    const existing = await recover();
    if (existing) return existing;
    try {
      const response = await this.transport.request(
        "POST /repos/{owner}/{repo}/stacks",
        this.#parameters({ pull_requests: [...pullRequests] }),
        true,
      );
      if (response.status !== 201)
        throw new Error(`GitHub returned ${response.status} creating stack`);
      const created = parseStack(response.data);
      if (!exactPulls(created, pullRequests)) {
        throw new Error("GitHub created a stack with unexpected pull request order");
      }
      return created;
    } catch (error) {
      const recovered = await recover();
      if (recovered) return recovered;
      throw error;
    }
  }

  async ensureExtended(
    stackNumber: number,
    existingPullRequests: readonly number[],
    addedPullRequests: readonly number[],
  ): Promise<GitHubStack> {
    if (addedPullRequests.length === 0) return this.get(stackNumber);
    const expected = [...existingPullRequests, ...addedPullRequests];
    const recover = async (): Promise<GitHubStack | null> => {
      const current = await this.get(stackNumber);
      if (exactPulls(current, expected)) return current;
      if (!exactPulls(current, existingPullRequests)) {
        throw new Error("GitHub stack changed while extension was being recovered");
      }
      return null;
    };
    const existing = await recover();
    if (existing) return existing;
    try {
      const response = await this.transport.request(
        "POST /repos/{owner}/{repo}/stacks/{stack_number}/add",
        this.#parameters({
          stack_number: stackNumber,
          pull_requests: [...addedPullRequests],
        }),
        true,
      );
      if (response.status !== 200)
        throw new Error(`GitHub returned ${response.status} extending stack`);
      const extended = parseStack(response.data);
      if (!exactPulls(extended, expected)) {
        throw new Error("GitHub extended a stack with unexpected pull request order");
      }
      return extended;
    } catch (error) {
      const recovered = await recover();
      if (recovered) return recovered;
      throw error;
    }
  }

  async requestMerge(args: {
    pullRequest: number;
    expectedHeadSha: string;
    title: string;
    action: "default" | "direct_merge" | "merge_queue";
  }): Promise<AsyncMergeResult> {
    const response = await this.transport.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async",
      this.#parameters({
        pull_number: args.pullRequest,
        sha: args.expectedHeadSha,
        merge_method: "squash",
        merge_action: args.action,
        commit_title: args.title,
      }),
      true,
    );
    if (![200, 202, 409].includes(response.status)) {
      throw new Error(`GitHub returned ${response.status} requesting asynchronous merge`);
    }
    const result = normalizeAsyncMerge(response.data);
    if (
      result.state !== "failed" &&
      result.state !== "merged" &&
      result.expectedHeadSha !== args.expectedHeadSha
    ) {
      throw new Error("asynchronous merge is bound to a stale pull request head");
    }
    if (
      result.state === "pending" &&
      (result.mergeAction !== args.action || result.mergeMethod !== "squash")
    ) {
      throw new Error(
        "asynchronous merge recovery returned options that differ from the requested merge",
      );
    }
    return result;
  }

  async mergeResult(
    pullRequest: number,
    uuid: string,
    expectedHeadSha: string,
  ): Promise<AsyncMergeResult> {
    const response = await this.transport.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}",
      this.#parameters({ pull_number: pullRequest, uuid }),
    );
    if (response.status !== 200) {
      throw new Error(`GitHub returned ${response.status} reading asynchronous merge`);
    }
    const result = normalizeAsyncMerge(response.data);
    if (
      result.state !== "failed" &&
      result.state !== "merged" &&
      result.expectedHeadSha !== expectedHeadSha
    ) {
      throw new Error("asynchronous merge poll is bound to a stale pull request head");
    }
    return result;
  }

  async unstack(stackNumber: number): Promise<void> {
    try {
      const current = await this.get(stackNumber);
      if (!current.open) return;
    } catch (error) {
      if (status(error) === 404) return;
      throw error;
    }
    try {
      const response = await this.transport.request(
        "POST /repos/{owner}/{repo}/stacks/{stack_number}/unstack",
        this.#parameters({ stack_number: stackNumber }),
        true,
      );
      if (response.status === 200) {
        const remaining = parseStack(response.data);
        const pullRequests = remaining.pullRequests.map((pull) => `#${pull.number}`).join(", ");
        throw new Error(
          `GitHub could not completely unstack stack ${stackNumber}; locked or unmergeable pull requests remain${pullRequests ? ` (${pullRequests})` : ""}`,
        );
      }
      if (response.status !== 204) {
        throw new Error(`GitHub returned ${response.status} unstacking pull requests`);
      }
    } catch (error) {
      try {
        const observed = await this.get(stackNumber);
        if (!observed.open) return;
      } catch (readError) {
        if (status(readError) === 404) return;
      }
      throw error;
    }
  }
}
