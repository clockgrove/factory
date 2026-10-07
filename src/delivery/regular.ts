import type {
  DeliveryObservation,
  DeliveryRequest,
  DeliveryResult,
  DeliveryStrategy,
  GitHubGateway,
  MergeResult,
} from "../contracts.js";
import { attachFault, decision, transient } from "../fault.js";
import { addsLfsPointers } from "../media.js";
import { gitAsync, pushRejected } from "../process.js";
import { deliveryDescription } from "./description.js";

/** The commit a remote branch holds, or undefined when it does not exist. */
export async function remoteHead(
  checkout: string,
  branch: string,
): Promise<string | undefined> {
  const listed = await gitAsync(
    checkout,
    "ls-remote",
    "origin",
    `refs/heads/${branch}`,
  );
  return listed.split(/\s+/)[0] || undefined;
}

/**
 * Put `commit` on Factory's branch. The remote is observed first: holding
 * the commit already, the push is done; holding a head an earlier attempt
 * pushed, or nothing, it is pushed with a lease on exactly that; holding
 * anything else, it is a change Factory did not make.
 */
export async function pushBranch(
  checkout: string,
  branch: string,
  commit: string,
  earlierHeads: string[] = [],
): Promise<void> {
  const remote = await remoteHead(checkout, branch);
  if (remote === commit) return;
  if (remote && !earlierHeads.includes(remote))
    throw attachFault(
      new Error(`Remote branch ${branch} holds a commit Factory did not push`),
      decision(
        `Remote branch ${branch} holds a commit Factory has no record of. Inspect it, then retry or cancel.`,
        `remote head ${remote}; Factory pushed ${[commit, ...earlierHeads].join(", ")}`,
      ),
    );
  try {
    await gitAsync(
      checkout,
      "push",
      `--force-with-lease=refs/heads/${branch}:${remote ?? ""}`,
      "origin",
      `${commit}:refs/heads/${branch}`,
    );
  } catch (error) {
    if (pushRejected(error)) {
      // The branch moved after it was observed: observe it again. If it did
      // not move, the remote refuses the lease itself (no force pushes).
      const after = await remoteHead(checkout, branch);
      attachFault(
        error,
        after === remote
          ? {
              kind: "config",
              detail: `The remote refused a leased push of ${branch} although the branch did not move`,
              fix: "Allow Factory's login to force-push its own branches (factory/*), then `factory run`",
            }
          : transient(`Remote branch ${branch} moved during the push`, false),
      );
    }
    throw error;
  }
}

export class RegularDelivery implements DeliveryStrategy {
  constructor(
    private checkout: string,
    private github: GitHubGateway,
  ) {}

  /** Only a fresh owner-bound request may prepare effects; retained intent is read-only. */
  async publish(request: DeliveryRequest): Promise<DeliveryResult> {
    const publication = request.publication;
    if (!publication)
      throw attachFault(
        new Error("Publication has no durable owner control"),
        decision(
          "Publication requires its existing exclusive snapshot owner",
          "No publication control was supplied",
        ),
      );
    const commit = request.changeRef;
    const body = request.body ?? deliveryDescription(this.checkout, request);
    const base = request.baseBranch ?? (await this.github.defaultBranch());
    const pullRequest = {
      branch: request.branch,
      base,
      headSha: commit,
      earlierHeads: request.earlierHeads,
      treeSha: request.treeSha,
      title: request.item.title,
      body,
    };
    publication.assertRequest(pullRequest);
    const reconcileOnly = publication.reconcileOnly;
    if (!reconcileOnly) {
      // Only initial preparation: an unresolved PR intent forbids even LFS/branch replay.
      if (
        request.lfs ||
        (await addsLfsPointers(this.checkout, request.baseSha, commit))
      )
        await gitAsync(this.checkout, "lfs", "push", "origin", commit);
      await pushBranch(
        this.checkout,
        request.branch,
        commit,
        request.earlierHeads,
      );
    }
    const pr = await this.github.publish({
      ...pullRequest,
      reconcileOnly,
      ...(publication.expectedPublication
        ? { expectedPublication: publication.expectedPublication }
        : {}),
      ...(reconcileOnly
        ? {}
        : { beforeCreate: () => publication.beforeCreate(pullRequest) }),
    });
    publication.observed(pullRequest, pr);
    return {
      branch: request.branch,
      pullRequest: pr.number,
      headSha: pr.headSha,
      ...(request.earlierHeads?.length
        ? { earlierHeads: request.earlierHeads }
        : {}),
    };
  }

  async observe(result: DeliveryResult): Promise<DeliveryObservation> {
    return this.github.observe({
      number: result.pullRequest,
      branch: result.branch,
      headSha: result.headSha,
      earlierHeads: result.earlierHeads,
      baseBranch: await this.github.defaultBranch(),
    });
  }

  /** Merge (or confirm the merge of) the published head. */
  async merge(result: DeliveryResult): Promise<MergeResult> {
    return this.github.merge(
      {
        number: result.pullRequest,
        branch: result.branch,
        headSha: result.headSha,
        earlierHeads: result.earlierHeads,
      },
      result.headSha,
    );
  }
}
