import { GitHubClient, sharedGitHubClient } from "../github-client.js";

type Pull = {
  number: number;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  merge_commit_sha?: string | null;
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
  ): Promise<T> {
    return this.client.request<T>(method, route, body);
  }

  private async pull(number: number): Promise<Pull> {
    return this.api<Pull>(`repos/${this.repository}/pulls/${number}`);
  }

  private async mergedSha(number: number): Promise<string> {
    const detail = await this.pull(number);
    if (detail.state !== "closed" || !detail.merged || !detail.merge_commit_sha)
      throw new Error(
        `Native stack PR #${number} has no integrated commit yet`,
      );
    return detail.merge_commit_sha;
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
        throw new Error(
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
        throw new Error(
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

  async mergeStack(
    layers: StackLayer[],
    baseBranch: string,
    expectedStack: number,
    options: {
      resumeUuid?: string;
      onPending: (uuid: string) => void;
      cancelled: () => boolean;
    },
  ): Promise<string> {
    const already = await Promise.all(
      layers.map((layer) => this.pull(layer.pullRequest)),
    );
    if (
      already.every(
        (pull) =>
          pull.state === "closed" && pull.merged === true && pull.merged_at,
      )
    ) {
      for (const [index, pull] of already.entries())
        if (
          pull.head.ref !== layers[index]!.branch ||
          pull.head.sha !== layers[index]!.headSha
        )
          throw new Error(
            "Merged native stack head changed; operator direction required",
          );
      const merged = await Promise.all(
        layers.map((layer) => this.mergedSha(layer.pullRequest)),
      );
      if (new Set(merged).size !== 1)
        throw new Error("Native stack layers have different merge commits");
      return merged[0]!;
    }
    if (
      !options.resumeUuid &&
      (await this.ensureStack(layers, baseBranch)) !== expectedStack
    )
      throw new Error("Native stack identity changed before merge");
    const top = layers.at(-1)!;
    type AsyncResult = {
      status: string;
      details: { uuid?: string; sha?: string; message?: string };
    };
    let uuid = options.resumeUuid;
    let observed: AsyncResult;
    if (uuid) {
      observed = await this.api(
        `repos/${this.repository}/pulls/${top.pullRequest}/merge-async/${uuid}`,
      );
    } else {
      observed = await this.api<AsyncResult>(
        `repos/${this.repository}/pulls/${top.pullRequest}/merge-async`,
        "PUT",
        {
          sha: top.headSha,
          merge_method: "merge",
          merge_action: "default",
        },
      );
      if (observed.status === "pending" && observed.details.uuid) {
        uuid = observed.details.uuid;
        options.onPending(uuid);
      }
    }
    while (observed.status === "pending" || observed.status === "queued") {
      if (options.cancelled())
        throw new Error("Objective cancelled during native merge observation");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (uuid)
        observed = await this.api(
          `repos/${this.repository}/pulls/${top.pullRequest}/merge-async/${uuid}`,
        );
      else {
        const pull = await this.pull(top.pullRequest);
        if (pull.state === "closed" && pull.merged === true)
          observed = {
            status: "merged",
            details: { sha: await this.mergedSha(top.pullRequest) },
          };
      }
    }
    if (observed.status !== "merged" || !observed.details.sha)
      throw new Error(
        `Native stack merge failed: ${observed.details.message ?? observed.status}`,
      );
    for (;;) {
      if (options.cancelled())
        throw new Error("Objective cancelled during native merge observation");
      const pulls = await Promise.all(
        layers.map((layer) => this.pull(layer.pullRequest)),
      );
      if (
        pulls.every(
          (pull) =>
            pull.state === "closed" && pull.merged === true && pull.merged_at,
        )
      )
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    const merged = await Promise.all(
      layers.map((layer) => this.mergedSha(layer.pullRequest)),
    );
    if (new Set(merged).size !== 1 || merged[0] !== observed.details.sha)
      throw new Error(
        "Native stack merge commit differs from the async result",
      );
    return observed.details.sha;
  }
}
