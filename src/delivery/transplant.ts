import { pinnedGitAsync } from "../process.js";

/** Replay one independently prepared result on the observed integration head. */
export async function transplantIndependentChange(
  checkout: string,
  originalBase: string,
  changeRef: string,
  integratedBase: string,
): Promise<{ changeRef: string; treeSha: string }> {
  if (
    (await pinnedGitAsync(checkout, "rev-parse", `${changeRef}^`)) !==
    originalBase
  )
    throw new Error(
      "Prepared change has a different parent than its execution base",
    );
  const treeSha = await pinnedGitAsync(
    checkout,
    "merge-tree",
    "--write-tree",
    `--merge-base=${originalBase}`,
    integratedBase,
    changeRef,
  );
  if (!/^[0-9a-f]{40}$/.test(treeSha))
    throw new Error("Prepared change did not replay to one unconflicted tree");
  const rebased = await pinnedGitAsync(
    checkout,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@users.noreply.github.com",
    "commit-tree",
    treeSha,
    "-p",
    integratedBase,
    "-m",
    "Factory: replay independently prepared Work Item",
  );
  return { changeRef: rebased, treeSha };
}
