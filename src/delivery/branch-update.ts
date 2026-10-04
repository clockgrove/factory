import type { GitHubGateway, PullRequestIdentity } from "../contracts.js";
import { earlierHeads } from "../repair-policy.js";
import type { WorkState } from "../state.js";

/** The head the item's PR delivers: GitHub's update of the result, else the result. */
export function deliveredHead(work: WorkState): string | undefined {
  return work.deliveredHead ?? work.changeRef;
}

/**
 * Heads a read of the PR may still show, and a lease accepts: earlier
 * attempts' heads, and replaced heads of this attempt or earlier ones.
 */
export function deliveryEarlierHeads(work: WorkState): string[] {
  const replaced = (attempt: WorkState) => [
    ...(attempt.replacedHeads ?? []),
    ...(attempt.deliveredHead ? [attempt.deliveredHead] : []),
  ];
  return [
    ...new Set([
      ...earlierHeads(work),
      ...(work.recovery?.history ?? []).flatMap((attempt) =>
        replaced(attempt.work),
      ),
      ...(work.replacedHeads ?? []),
    ]),
  ];
}

/**
 * A new result will replace the PR's head (a replay onto a repaired lower
 * layer): the current head becomes a replaced head, and any branch update
 * of it no longer applies.
 */
export function retireDeliveredHead(work: WorkState): void {
  const head = deliveredHead(work);
  if (head)
    work.replacedHeads = [...new Set([...(work.replacedHeads ?? []), head])];
  delete work.deliveredHead;
  delete work.branchUpdateFrom;
}

/**
 * Bring a BEHIND PR up to date with its base from exactly `from` (GitHub's
 * update-branch), or finish the update already in flight. The request is
 * marked before it is sent; the gateway returns the verified new head (our
 * head merged with the base tip) once GitHub shows it, and until then
 * throws a lag transient, so the repeat comes back here. The new head is
 * the delivered head; its checks run again. Returns it.
 */
export async function updateBehindBranch(args: {
  github: GitHubGateway;
  work: WorkState;
  save: () => void;
  identity: Pick<PullRequestIdentity, "number" | "branch">;
  from: string;
}): Promise<string> {
  const { github, work, save, identity, from } = args;
  if (work.branchUpdateFrom !== from) {
    work.branchUpdateFrom = from;
    save();
  }
  const head = await github.updateBranch({
    number: identity.number,
    branch: identity.branch,
    headSha: from,
    earlierHeads: deliveryEarlierHeads(work),
  });
  work.replacedHeads = [...new Set([...(work.replacedHeads ?? []), from])];
  work.deliveredHead = head;
  delete work.branchUpdateFrom;
  save();
  return head;
}
