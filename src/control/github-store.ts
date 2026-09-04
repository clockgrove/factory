import { createOctokit, type GitHubOptions } from "../github.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  MutationScheduler,
  PlatformUnavailableError,
  classifyRefusal,
  type MutationAdmission,
  type MutationClass,
} from "../platform.js";
import type { AttemptStore } from "./attempts.js";
import type { GitCommitObject, LeaseStore } from "./lease.js";
import { decodeEventComments } from "./receipts.js";
import { classicBranchProtectionRules } from "../publication/branch-policy.js";

const UPDATE_REFS = `
mutation FactoryUpdateRefs(
  $repositoryId: ID!
  $name: GitRefname!
  $beforeOid: GitObjectID!
  $afterOid: GitObjectID!
) {
  updateRefs(input: {
    repositoryId: $repositoryId
    refUpdates: [{
      name: $name
      beforeOid: $beforeOid
      afterOid: $afterOid
      force: false
    }]
  }) { clientMutationId }
}`;

type FactoryOctokit = ReturnType<typeof createOctokit>;

/**
 * Factory's durable comment envelopes already carry their destination issue
 * number. Derive the REST route from that validated payload instead of
 * spending scarce GraphQL points on addComment mutations.
 */
export function factoryCommentIssueNumber(body: string): number {
  const events = decodeEventComments(body);
  if (events.length !== 1) {
    throw new Error("Factory comment must contain exactly one event envelope");
  }
  const event = events[0]!;
  return "workItem" in event && typeof event.workItem === "number"
    ? event.workItem
    : event.objective;
}

function stripRefs(ref: string): string {
  if (!ref.startsWith("refs/")) throw new Error(`ref must be fully qualified: ${ref}`);
  return ref.slice("refs/".length);
}

function responseDate(response: {
  headers: Record<string, string | number | undefined>;
}): Date {
  const value = response.headers.date;
  if (!value) throw new Error("GitHub response did not contain a Date header");
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid GitHub Date header: ${value}`);
  return parsed;
}

export interface GitHubControlStoreOptions extends GitHubOptions {
  circuitBreaker?: CircuitBreaker;
  pacer?: ContentCreationPacer;
  concurrency?: ConcurrencyLimiter;
  mutationScheduler?: MutationAdmission;
  beforeMutation?: (kind: MutationClass, waitedMs: number) => Promise<void>;
}

/** GitHub-backed v2 control store. Every mutation shares v1's pacing controls. */
export class GitHubControlStore implements LeaseStore, AttemptStore {
  readonly #octokit: FactoryOctokit;
  readonly #owner: string;
  readonly #repo: string;
  readonly #breaker: CircuitBreaker;
  readonly #pacer: ContentCreationPacer;
  readonly #concurrency: ConcurrencyLimiter;
  readonly #mutations: MutationAdmission;
  readonly #beforeMutation: (kind: MutationClass, waitedMs: number) => Promise<void>;
  #repositoryId: string | null = null;

  constructor(options: GitHubControlStoreOptions) {
    this.#octokit = createOctokit(options);
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#breaker = options.circuitBreaker ?? new CircuitBreaker();
    this.#pacer = options.pacer ?? new ContentCreationPacer();
    this.#concurrency = options.concurrency ?? new ConcurrencyLimiter();
    this.#mutations = options.mutationScheduler ?? new MutationScheduler({
      pacer: this.#pacer,
      ...(options.onThrottle ? { onThrottle: options.onThrottle } : {}),
    });
    this.#beforeMutation = options.beforeMutation ?? (async () => {});
  }

  async #call<T>(
    operation: () => Promise<T>,
    mutating = false,
    mutationClass: MutationClass = "normal",
  ): Promise<T> {
    if (this.#breaker.isOpen()) {
      throw new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: this.#breaker.waitMs() },
        new Error("Factory GitHub circuit is open"),
      );
    }
    const mutationPermit = mutating
      ? await this.#mutations.acquire(mutationClass)
      : undefined;
    const release = await this.#concurrency.acquire();
    try {
      if (this.#breaker.isOpen()) {
        throw new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: this.#breaker.waitMs() },
          new Error("Factory GitHub circuit opened while the request was queued"),
        );
      }
      if (mutationPermit) {
        await this.#beforeMutation(mutationClass, mutationPermit.waitedMs);
      }
      const result = await operation();
      this.#breaker.recordSuccess();
      return result;
    } catch (error) {
      const refusal = classifyRefusal(error);
      if (refusal.kind !== "not_refusal") {
        this.#breaker.recordRefusal(refusal);
        throw new PlatformUnavailableError(refusal, error);
      }
      throw error;
    } finally {
      release();
      mutationPermit?.release();
    }
  }

  async readRef(ref: string): Promise<string | null> {
    try {
      const response = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          owner: this.#owner,
          repo: this.#repo,
          ref: stripRefs(ref),
        }),
      );
      return response.data.object.sha;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async readRefWithServerTime(
    ref: string,
  ): Promise<{ oid: string | null; serverTime: Date }> {
    try {
      const response = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          owner: this.#owner,
          repo: this.#repo,
          ref: stripRefs(ref),
        }),
      );
      return {
        oid: response.data.object.sha,
        serverTime: responseDate(response),
      };
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return { oid: null, serverTime: new Date() };
      }
      throw error;
    }
  }

  async listRefs(prefix: string): Promise<Array<{ ref: string; oid: string }>> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
        owner: this.#owner,
        repo: this.#repo,
        ref: stripRefs(prefix),
      }),
    );
    return response.data.map((item) => ({ ref: item.ref, oid: item.object.sha }));
  }

  async readCommit(oid: string): Promise<GitCommitObject> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner: this.#owner,
        repo: this.#repo,
        commit_sha: oid,
      }),
    );
    return {
      oid: response.data.sha,
      treeOid: response.data.tree.sha,
      parentOids: response.data.parents.map((parent) => parent.sha),
      message: response.data.message,
      serverTime: responseDate(response),
    };
  }

  async createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string> {
    const response = await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/git/commits", {
          owner: this.#owner,
          repo: this.#repo,
          message: args.message,
          tree: args.treeOid,
          parents: args.parentOids,
        }),
      true,
      args.message.startsWith("Factory lease ") ? "lease" : "normal",
    );
    return response.data.sha;
  }

  async createRef(ref: string, oid: string): Promise<boolean> {
    try {
      await this.#call(
        () =>
          this.#octokit.request("POST /repos/{owner}/{repo}/git/refs", {
            owner: this.#owner,
            repo: this.#repo,
            ref,
            sha: oid,
          }),
        true,
        ref.startsWith("refs/clockgrove-factory/leases/") ? "lease" : "normal",
      );
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 409 && status !== 422) throw error;
      return (await this.readRef(ref)) === oid;
    }
  }

  async compareAndSwapRef(args: {
    ref: string;
    beforeOid: string;
    afterOid: string;
  }): Promise<boolean> {
    const repositoryId = await this.#getRepositoryId();
    try {
      await this.#call(
        () =>
          this.#octokit.graphql(UPDATE_REFS, {
            repositoryId,
            name: args.ref,
            beforeOid: args.beforeOid,
            afterOid: args.afterOid,
          }),
        true,
        args.ref.startsWith("refs/clockgrove-factory/leases/") ? "lease" : "normal",
      );
      return true;
    } catch (error) {
      // GitHub's stale-beforeOid response is currently a generic GraphQL
      // execution error. Re-read: our unique child OID proves success even if
      // the response was lost; every other value proves we lost the fence.
      const current = await this.readRef(args.ref);
      if (current === args.afterOid) return true;
      if (current !== args.beforeOid) return false;
      throw error;
    }
  }

  async addIssueComment(_issueNodeId: string, body: string): Promise<void> {
    const issueNumber = factoryCommentIssueNumber(body);
    await this.#call(
      () =>
        this.#octokit.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner: this.#owner,
            repo: this.#repo,
            issue_number: issueNumber,
            body,
          },
        ),
      true,
    );
  }

  async serverTime(): Promise<Date> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}", {
        owner: this.#owner,
        repo: this.#repo,
      }),
    );
    return responseDate(response);
  }

  async getAuthenticatedLogin(): Promise<string> {
    const response = await this.#call(() => this.#octokit.request("GET /user"));
    return response.data.login;
  }

  async getRepositoryFacts(): Promise<{
    fullName: string;
    fork: boolean;
    private: boolean;
    defaultBranch: string;
    canPush: boolean;
  }> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}", {
        owner: this.#owner,
        repo: this.#repo,
      }),
    );
    return {
      fullName: response.data.full_name,
      fork: response.data.fork,
      private: response.data.private,
      defaultBranch: response.data.default_branch,
      canPush: response.data.permissions?.push === true,
    };
  }

  async readBranchRules(branch: string): Promise<Array<{ type: string; parameters?: unknown }>> {
    const rules: Array<{ type: string; parameters?: unknown }> = [];
    try {
      for (let page = 1; page <= 10; page += 1) {
        const response = await this.#call(() =>
          this.#octokit.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
            owner: this.#owner,
            repo: this.#repo,
            branch,
            per_page: 100,
            page,
          }),
        );
        rules.push(...response.data.map((rule) => {
          const record = rule as { type: string; parameters?: unknown };
          return {
            type: record.type,
            ...(record.parameters === undefined ? {} : { parameters: record.parameters }),
          };
        }));
        if (response.data.length < 100) break;
        if (page === 10) {
          throw new Error("branch rule result exceeds Factory's 1000-rule snapshot limit");
        }
      }
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }

    // GitHub rulesets and classic branch protection are separate APIs. A
    // repository may use either or both, so omitting this read could bypass a
    // classic review/check requirement until the merge request fails.
    try {
      const response = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
          owner: this.#owner,
          repo: this.#repo,
          branch,
        }),
      );
      rules.push(...classicBranchProtectionRules(response.data));
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    return rules;
  }

  async getBranchHead(branch: string): Promise<GitCommitObject> {
    const oid = await this.readRef(`refs/heads/${branch}`);
    if (!oid) throw new Error(`branch ${branch} does not exist`);
    return this.readCommit(oid);
  }

  async createBlob(content: Buffer): Promise<string> {
    const response = await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
          owner: this.#owner,
          repo: this.#repo,
          content: content.toString("base64"),
          encoding: "base64",
        }),
      true,
    );
    return response.data.sha;
  }

  async readBlob(oid: string): Promise<Buffer> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner: this.#owner,
        repo: this.#repo,
        file_sha: oid,
      }),
    );
    if (response.data.encoding !== "base64") {
      throw new Error(`unsupported GitHub blob encoding ${response.data.encoding}`);
    }
    return Buffer.from(response.data.content.replace(/\s/g, ""), "base64");
  }

  async createTree(args: {
    baseTreeOid?: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }): Promise<string> {
    const response = await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/git/trees", {
          owner: this.#owner,
          repo: this.#repo,
          ...(args.baseTreeOid ? { base_tree: args.baseTreeOid } : {}),
          tree: args.entries,
        }),
      true,
    );
    return response.data.sha;
  }

  async readTreeEntry(treeOid: string, path: string): Promise<string | null> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: this.#owner,
        repo: this.#repo,
        tree_sha: treeOid,
        recursive: "1",
      }),
    );
    if (response.data.truncated) {
      throw new Error("GitHub truncated the compiled graph control tree");
    }
    const entry = response.data.tree.find((candidate) => candidate.path === path);
    if (!entry) return null;
    if (entry.type !== "blob" || !entry.sha) {
      throw new Error(`compiled graph tree entry ${path} is not a blob`);
    }
    return entry.sha;
  }

  async findPullRequestForBranch(branch: string): Promise<{
    number: number;
    htmlUrl: string;
    state: string;
    merged: boolean;
    headSha: string;
  } | null> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/pulls", {
        owner: this.#owner,
        repo: this.#repo,
        state: "all",
        head: `${this.#owner}:${branch}`,
        per_page: 10,
      }),
    );
    const pull = response.data[0];
    return pull
      ? {
          number: pull.number,
          htmlUrl: pull.html_url,
          state: pull.state,
          merged: Boolean(pull.merged_at),
          headSha: pull.head.sha,
        }
      : null;
  }

  async createPullRequest(args: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number: number; htmlUrl: string; headSha: string }> {
    const response = await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/pulls", {
          owner: this.#owner,
          repo: this.#repo,
          title: args.title,
          body: args.body,
          head: args.head,
          base: args.base,
        }),
      true,
    );
    return {
      number: response.data.number,
      htmlUrl: response.data.html_url,
      headSha: response.data.head.sha,
    };
  }

  async readPullRequest(number: number): Promise<{
    state: string;
    merged: boolean;
    mergeable: boolean | null;
    mergeableState: string;
    draft: boolean;
    headSha: string;
    baseSha: string;
  }> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: this.#owner,
        repo: this.#repo,
        pull_number: number,
      }),
    );
    return {
      state: response.data.state,
      merged: response.data.merged,
      mergeable: response.data.mergeable,
      mergeableState: response.data.mergeable_state,
      draft: response.data.draft ?? false,
      headSha: response.data.head.sha,
      baseSha: response.data.base.sha,
    };
  }

  async readChecks(sha: string): Promise<{
    pending: string[];
    failed: string[];
    observed: string[];
    observedChecks: Array<{ context: string; integrationId: number | null }>;
  }> {
    const [checks, statuses] = await Promise.all([
      (async () => {
        const result: Array<{
          name: string;
          status: string;
          conclusion: string | null;
          appId: number | null;
        }> = [];
        for (let page = 1; page <= 30; page += 1) {
          const response = await this.#call(() =>
            this.#octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
              owner: this.#owner,
              repo: this.#repo,
              ref: sha,
              per_page: 100,
              page,
              filter: "latest",
            }),
          );
          result.push(...response.data.check_runs.map((check) => ({
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            appId: check.app?.id ?? null,
          })));
          if (result.length >= response.data.total_count) return result;
          if (response.data.check_runs.length < 100) return result;
        }
        throw new Error("check-run result exceeds GitHub's 3000-item snapshot limit");
      })(),
      (async () => {
        const result: Array<{ context: string; state: string }> = [];
        for (let page = 1; page <= 30; page += 1) {
          const response = await this.#call(() =>
            this.#octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/statuses", {
              owner: this.#owner,
              repo: this.#repo,
              ref: sha,
              per_page: 100,
              page,
            }),
          );
          result.push(...response.data);
          if (response.data.length < 100) return result;
        }
        throw new Error("commit-status result exceeds Factory's 3000-item snapshot limit");
      })(),
    ]);
    const pending: string[] = [];
    const failed: string[] = [];
    const observed: string[] = [];
    const observedChecks: Array<{ context: string; integrationId: number | null }> = [];
    for (const check of checks) {
      observed.push(check.name);
      observedChecks.push({ context: check.name, integrationId: check.appId });
      if (check.status !== "completed") pending.push(check.name);
      else if (!new Set(["success", "neutral", "skipped"]).has(check.conclusion ?? "")) {
        failed.push(check.name);
      }
    }
    const latestStatuses = new Map<string, { context: string; state: string }>();
    // GitHub returns commit statuses newest first. Only the newest result for
    // a context participates in the combined status; an older failed retry
    // must not override a newer success.
    for (const status of statuses) {
      if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status);
    }
    for (const status of latestStatuses.values()) {
      observed.push(status.context);
      observedChecks.push({ context: status.context, integrationId: null });
      if (status.state === "pending") pending.push(status.context);
      else if (status.state !== "success") failed.push(status.context);
    }
    return {
      pending: [...new Set(pending)],
      failed: [...new Set(failed)],
      observed: [...new Set(observed)],
      observedChecks: observedChecks.filter(
        (check, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.context === check.context &&
              candidate.integrationId === check.integrationId,
          ) === index,
      ),
    };
  }

  async mergePullRequest(args: {
    number: number;
    headSha: string;
    commitTitle: string;
  }): Promise<string> {
    let response;
    try {
      response = await this.#call(
        () =>
          this.#octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
            owner: this.#owner,
            repo: this.#repo,
            pull_number: args.number,
            sha: args.headSha,
            merge_method: "squash",
            commit_title: args.commitTitle,
          }),
        true,
      );
    } catch (error) {
      const current = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: this.#owner,
          repo: this.#repo,
          pull_number: args.number,
        }),
      );
      if (current.data.merged && current.data.merge_commit_sha) {
        return current.data.merge_commit_sha;
      }
      throw error;
    }
    if (!response.data.merged || !response.data.sha) {
      throw new Error(response.data.message || `pull request #${args.number} was not merged`);
    }
    return response.data.sha;
  }

  async closePullRequest(number: number): Promise<void> {
    await this.#call(
      () =>
        this.#octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: this.#owner,
          repo: this.#repo,
          pull_number: number,
          state: "closed",
        }),
      true,
    );
  }

  async closeIssue(number: number): Promise<void> {
    await this.#call(
      () =>
        this.#octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
          owner: this.#owner,
          repo: this.#repo,
          issue_number: number,
          state: "closed",
          state_reason: "completed",
        }),
      true,
    );
  }

  async assignIssue(number: number, login: string): Promise<void> {
    await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
          owner: this.#owner,
          repo: this.#repo,
          issue_number: number,
          assignees: [login],
        }),
      true,
    );
  }

  async #getRepositoryId(): Promise<string> {
    if (this.#repositoryId) return this.#repositoryId;
    const data = await this.#call(() =>
      this.#octokit.graphql<{ repository: { id: string } }>(
        "query FactoryRepositoryId($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }",
        { owner: this.#owner, repo: this.#repo },
      ),
    );
    this.#repositoryId = data.repository.id;
    return this.#repositoryId;
  }
}
