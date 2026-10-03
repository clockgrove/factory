import { assertDeliveryReady } from "./readiness.js";
import type {
  DeliveryObservation,
  DeliveryRequest,
  DeliveryResult,
  DeliveryStrategy,
  GitHubGateway,
  MergeResult,
} from "../contracts.js";
import { gitAsync } from "../process.js";

export class RegularDelivery implements DeliveryStrategy {
  constructor(
    private checkout: string,
    private github: GitHubGateway,
    private requiredChecks: string[] = [],
  ) {}

  async publish(request: DeliveryRequest): Promise<DeliveryResult> {
    const commit = request.changeRef;
    const base = request.baseBranch ?? (await this.github.defaultBranch());
    const existing = await this.github.findOpenPullRequest(
      request.branch,
      base,
      commit,
    );
    if (existing)
      return {
        branch: existing.branch,
        pullRequest: existing.number,
        headSha: existing.headSha,
      };
    if (request.lfs)
      await gitAsync(this.checkout, "lfs", "push", "origin", commit);
    await gitAsync(
      this.checkout,
      "push",
      "origin",
      `${commit}:refs/heads/${request.branch}`,
    );
    const pr = await this.github.publish({
      branch: request.branch,
      base,
      treeSha: request.treeSha,
      title: request.item.title,
      body: `Implements Work Item ${request.item.id}.\n\nValidated tree: ${request.treeSha}`,
    });
    if (pr.headSha !== commit)
      throw new Error("Published PR head differs from validated commit");
    return {
      branch: request.branch,
      pullRequest: pr.number,
      headSha: pr.headSha,
    };
  }

  async observe(result: DeliveryResult): Promise<DeliveryObservation> {
    return this.github.observe({
      number: result.pullRequest,
      branch: result.branch,
      headSha: result.headSha,
      baseBranch: await this.github.defaultBranch(),
    });
  }

  async merge(
    result: DeliveryResult,
    beforeMerge?: (observation: DeliveryObservation) => void,
  ): Promise<MergeResult> {
    const identity = {
      number: result.pullRequest,
      branch: result.branch,
      headSha: result.headSha,
    };
    const observation = await this.observe(result);
    // A merge that already happened (its response was lost) is confirmed by
    // the gateway; its readiness evidence was recorded before it was sent.
    if (observation.state === "merged")
      return this.github.merge(identity, result.headSha);
    assertDeliveryReady(observation, this.requiredChecks, result.headSha);
    beforeMerge?.(observation);
    return this.github.merge(identity, result.headSha);
  }
}
