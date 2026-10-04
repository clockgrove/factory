import { faultOf, StepFault } from "../fault.js";
import { fetchHead, gitAsync } from "../process.js";
import { notYet, settled } from "./lag.js";

/**
 * Postcondition of a merge: its commit is on the default branch. Other work
 * may have merged since, so only ancestry is required. Until GitHub's lag
 * window passes a missing merge is "not yet"; then it is a defect, since the
 * default branch lost a merge GitHub confirmed.
 */
export async function assertIntegrated(
  checkout: string,
  defaultBranch: string,
  sha: string,
  what: string,
): Promise<void> {
  const head = await fetchHead(checkout, defaultBranch);
  const key = `integrated:${sha}`;
  try {
    await gitAsync(checkout, "merge-base", "--is-ancestor", sha, head);
  } catch (error) {
    // A local git failure classified as transient (a lock) is not lag.
    if (faultOf(error).kind === "transient") throw error;
    throw notYet(
      key,
      `Default branch does not contain the merge of ${what} (${sha})`,
    );
  }
  settled(key);
}

/**
 * The integrated head after a merge: whichever of the recorded head and the
 * merge descends from the other. Merges can be recorded out of order (a
 * restart records an earlier merge after a later one), so the recorded head
 * never moves back.
 */
export async function laterIntegration(
  checkout: string,
  recorded: string | undefined,
  merged: string,
): Promise<string> {
  if (!recorded || recorded === merged) return merged;
  const contains = (ancestor: string, descendant: string) =>
    gitAsync(
      checkout,
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ).then(
      () => true,
      (error: unknown) => {
        if (faultOf(error).kind === "transient") throw error;
        return false;
      },
    );
  if (await contains(recorded, merged)) return merged;
  if (await contains(merged, recorded)) return recorded;
  throw new StepFault({
    kind: "defect",
    detail: `Merge ${merged} and the integrated head ${recorded} have diverged`,
  });
}
