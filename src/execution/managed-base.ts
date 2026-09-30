import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pinnedGit, pinnedGitAsync, pinnedGitRaw } from "../process.js";

/** Exact shallow base objects only, without source history, configuration or credentials. */
export async function prepareManagedBase(
  checkout: string,
  repo: string,
  baseSha: string,
): Promise<void> {
  if (pinnedGit(checkout, "rev-parse", `${baseSha}^{commit}`) !== baseSha)
    throw new Error("Managed input base does not resolve exactly");
  const tree = pinnedGitRaw(checkout, "ls-tree", "-r", "-z", baseSha)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (tree.some((entry) => !/^(100644|100755) blob /.test(entry)))
    throw new Error(
      "Managed input supports regular files only; symlinks and submodules are unsupported",
    );
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  pinnedGit(repo, "init", "--quiet");
  await pinnedGitAsync(
    repo,
    "fetch",
    "--depth=1",
    "--no-tags",
    "--no-write-fetch-head",
    checkout,
    `${baseSha}:refs/heads/input`,
  );
  pinnedGit(repo, "checkout", "--quiet", "--detach", baseSha);
  for (const entry of ["config", "logs", "hooks", "FETCH_HEAD"])
    rmSync(join(repo, ".git", entry), { recursive: true, force: true });
}
