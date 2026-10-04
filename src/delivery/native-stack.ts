import { setTimeout as sleep } from "node:timers/promises";
import { attachFault, attachedFault, decision } from "../fault.js";
import {
  classifiedGitHubCall,
  type GitHubClient,
  type GitHubCall,
  GitHubRequestError,
  sharedGitHubClient,
  timelineMergeCommit,
} from "../github-client.js";
import { currentProcessSignal } from "../process.js";
import { notYet, settled } from "./lag.js";

/** The stack no longer matches what Factory recorded; ownership is not checked. */
function foreignChange(message: string): Error {
  return attachFault(
    new Error(message),
    decision(
      "The native stack no longer matches what Factory recorded. Inspect it, then retry or cancel.",
      message,
    ),
  );
}

type Pull = {
  number: number;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
};
type Stack = {
  number: number;
  base: { ref: string };
  pull_requests: Pull[];
};

export interface StackLayer {
  pullRequest: number;
  branch: string;
  headSha: string;
}

export class NativeStackDelivery {
  constructor(
    private repository: string,
    private readonly client: GitHubClient = sharedGitHubClient,
  ) {}

  private async api<T>(
    route: string,
    method = "GET",
    body?: Record<string, unknown>,
    call: Omit<GitHubCall, "method" | "path"> = {},
  ): Promise<T> {
    const prefix = `repos/${this.repository}/`;
    return classifiedGitHubCall(
      this.client,
      this.repository,
      {
        method,
        path: route.startsWith(prefix) ? route.slice(prefix.length) : route,
        ...call,
      },
      () => this.client.request<T>(method, route, body),
    );
  }

  private async pull(number: number): Promise<Pull> {
    return this.api<Pull>(`repos/${this.repository}/pulls/${number}`);
  }

  /** A layer's merge: shown on the PR, and its commit on the timeline. */
  private async mergedSha(layer: StackLayer): Promise<string> {
    const detail = await this.pull(layer.pullRequest);
    const key = `stack-layer:${layer.pullRequest}:${layer.headSha}`;
    if (
      detail.state !== "closed" ||
      detail.merged !== true ||
      detail.head.sha !== layer.headSha ||
      detail.head.ref !== layer.branch
    )
      throw notYet(
        key,
        `Native stack PR #${layer.pullRequest} does not show its merge yet`,
      );
    const sha = await classifiedGitHubCall(
      this.client,
      this.repository,
      { method: "GET", path: `issues/${layer.pullRequest}/timeline` },
      () =>
        timelineMergeCommit(this.client, this.repository, layer.pullRequest),
    );
    if (!sha)
      throw notYet(
        key,
        `Native stack PR #${layer.pullRequest} merge is not on its timeline yet`,
      );
    settled(key);
    return sha;
  }

  /** The one merge commit of a stack whose layers all merged. */
  private async stackMergeCommit(layers: StackLayer[]): Promise<string> {
    const merged = await Promise.all(
      layers.map((layer) => this.mergedSha(layer)),
    );
    if (new Set(merged).size !== 1)
      throw new Error("Native stack layers have different merge commits");
    return merged[0]!;
  }

  private async assertLayers(
    layers: StackLayer[],
    baseBranch: string,
  ): Promise<void> {
    for (const [index, layer] of layers.entries()) {
      const observed = await this.pull(layer.pullRequest);
      const expectedBase = index ? layers[index - 1]!.branch : baseBranch;
      if (
        observed.head.ref !== layer.branch ||
        observed.head.sha !== layer.headSha ||
        observed.base.ref !== expectedBase ||
        observed.state !== "open"
      ) {
        throw foreignChange(
          `Native stack PR #${layer.pullRequest} changed head, base, or state; operator direction required`,
        );
      }
    }
  }

  async ensureStack(layers: StackLayer[], baseBranch: string): Promise<number> {
    if (layers.length < 2)
      throw new Error("Native stack requires two or more PRs");
    await this.assertLayers(layers, baseBranch);
    const numbers = layers.map((layer) => layer.pullRequest);
    const existing = await this.api<Stack[]>(
      `repos/${this.repository}/stacks?pull_request=${numbers[0]}`,
    );
    if (existing.length) {
      const stack = existing[0]!;
      if (
        existing.length !== 1 ||
        stack.base.ref !== baseBranch ||
        JSON.stringify(stack.pull_requests.map((pull) => pull.number)) !==
          JSON.stringify(numbers)
      )
        throw foreignChange(
          "Native stack topology changed; operator direction required",
        );
      return stack.number;
    }
    const created = await this.api<Stack>(
      `repos/${this.repository}/stacks`,
      "POST",
      {
        pull_requests: numbers,
      },
    );
    if (
      created.base.ref !== baseBranch ||
      JSON.stringify(created.pull_requests.map((pull) => pull.number)) !==
        JSON.stringify(numbers)
    )
      throw new Error("GitHub created an unexpected native stack topology");
    return created.number;
  }

  /**
   * Merge the stack through its top PR, observing first: a merged stack is
   * confirmed, and a merge request already pending (recorded, or named by
   * GitHub's 409 after a lost response) is polled instead of sent again.
   */
  /** The stack's merge commit when every layer already merged, else undefined. */
  private async alreadyMerged(
    layers: StackLayer[],
  ): Promise<string | undefined> {
    const already = await Promise.all(
      layers.map((layer) => this.pull(layer.pullRequest)),
    );
    if (!already.every((pull) => pull.state === "closed" && pull.merged))
      return undefined;
    for (const [index, pull] of already.entries())
      if (
        pull.head.ref !== layers[index]!.branch ||
        pull.head.sha !== layers[index]!.headSha
      )
        throw foreignChange(
          "Merged native stack head changed; operator direction required",
        );
    return this.stackMergeCommit(layers);
  }

  async mergeStack(
    layers: StackLayer[],
    baseBranch: string,
    expectedStack: number,
    options: {
      resumeUuid?: string;
      onPending: (uuid: string) => void;
      progress?: () => void;
      queued: (detail: string) => never;
      failed?: () => Promise<void>;
      requireMergeCommits: () => Promise<void>;
    },
  ): Promise<string> {
    const merged = await this.alreadyMerged(layers);
    if (merged) return merged;
    if (
      !options.resumeUuid &&
      (await this.ensureStack(layers, baseBranch)) !== expectedStack
    )
      throw foreignChange("Native stack identity changed before merge");
    const top = layers.at(-1)!;
    type AsyncResult = {
      status: string;
      details: { uuid?: string; sha?: string; message?: string };
    };
    const route = `repos/${this.repository}/pulls/${top.pullRequest}/merge-async`;
    let uuid = options.resumeUuid;
    let observed: AsyncResult;
    // A merge submitted in this call may not be readable by its UUID yet.
    let submittedAt: number | undefined;
    if (uuid) observed = await this.api<AsyncResult>(`${route}/${uuid}`);
    else {
      await options.requireMergeCommits();
      try {
        observed = await this.api<AsyncResult>(
          route,
          "PUT",
          {
            sha: top.headSha,
            merge_method: "merge",
            merge_action: "default",
          },
          // ensureStack has just confirmed every layer holds Factory's head.
          { head: "ours" },
        );
      } catch (error) {
        // GitHub refuses to merge layers that already merged (a lost
        // response): read the layers again and confirm (#627).
        if (
          error instanceof GitHubRequestError &&
          error.status === 403 &&
          attachedFault(error)?.kind !== "transient"
        ) {
          const sha = await this.alreadyMerged(layers);
          if (sha) return sha;
        }
        if (!(error instanceof GitHubRequestError && error.pendingMerge))
          throw error;
        observed = { status: "pending", details: { uuid: error.pendingMerge } };
      }
      if (observed.status === "pending" && observed.details.uuid) {
        submittedAt = Date.now();
        uuid = observed.details.uuid;
        options.onPending(uuid);
      }
    }
    while (observed.status === "pending" || observed.status === "queued") {
      // Queued without a request to poll: a CI wait; the repeat observes the
      // layers first and confirms the merge once it lands.
      if (!uuid)
        options.queued(
          `Native stack PR #${top.pullRequest} is queued to merge`,
        );
      await sleep(500, undefined, { signal: currentProcessSignal() });
      observed = await this.api<AsyncResult>(
        `${route}/${uuid}`,
        "GET",
        undefined,
        { createdAt: submittedAt },
      );
      options.progress?.();
    }
    // A merge that failed while a required check was still pending waits
    // for CI instead (#626); `failed` throws that wait.
    if (observed.status === "failed") await options.failed?.();
    if (observed.status !== "merged" || !observed.details.sha)
      throw attachFault(
        new Error(
          `Native stack merge failed: ${observed.details.message ?? observed.status}`,
        ),
        decision(
          "GitHub did not merge the native stack. Inspect it, then retry or cancel.",
          `merge-async ended ${observed.status}: ${observed.details.message ?? "no detail"}`,
        ),
      );
    if ((await this.stackMergeCommit(layers)) !== observed.details.sha)
      throw new Error(
        "Native stack merge commit differs from the async result",
      );
    return observed.details.sha;
  }
}
