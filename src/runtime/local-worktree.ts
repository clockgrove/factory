import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import {
  MAX_ARTIFACT_PATCH_BYTES,
  assertChangedPathScope,
  normalizeArtifact,
  materializeArtifactPatch,
  verifyArtifact,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import { runContainedProcess, sanitizedWorkerEnvironment } from "./process-group.js";
import { materializePinnedCompilationTree } from "../execution/pinned-compilation-tree.js";
import { assertLocalLfsAvailable, inspectPinnedLfs, materializeLocalLfsAssets } from "../repository-profiles/git-lfs.js";
import { inspectContentFile, regularContentPath } from "../execution/artifact-content.js";
import { artifactFromPatchFile, streamGitFile } from "./artifact-patch.js";

const MARKER = ".factory-worktree";

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
  maxOutputBytes = 256 * 1024,
): Promise<string> {
  const result = await runContainedProcess({
    command: "git",
    args,
    cwd,
    env: sanitizedWorkerEnvironment(process.env),
    timeoutMs,
    maxOutputBytes,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export interface LocalWorktree {
  root: string;
  path: string;
  repository: string;
  baseSha: string;
}

export async function createLocalWorktree(
  repository: string,
  baseSha: string,
): Promise<LocalWorktree> {
  const repo = resolve(repository);
  const verified = (await git(repo, ["rev-parse", "--verify", `${baseSha}^{commit}`])).trim();
  if (verified !== baseSha) throw new Error(`base SHA did not resolve exactly: ${baseSha}`);
  await assertLocalLfsAvailable(repo, baseSha);
  const prepared = await materializePinnedCompilationTree(repo, baseSha, { purpose: "worktree" });
  const { root, path } = prepared;
  await writeFile(join(root, MARKER), `${repo}\n${baseSha}\nraw-tree-v1\n`, { mode: 0o600 });
  try {
    await materializeLocalLfsAssets(repo, path, baseSha);
    return { root, path, repository: repo, baseSha };
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}

function assertOwnedWorktree(worktree: LocalWorktree): void {
  const root = resolve(worktree.root);
  const prefix = resolve(tmpdir(), "clockgrove-factory-worktree-");
  if (!basename(root).startsWith("clockgrove-factory-worktree-") || !root.startsWith(prefix)) {
    throw new Error(`refusing to clean unowned worktree root: ${root}`);
  }
  if (resolve(worktree.path) !== join(root, "worktree")) {
    throw new Error("worktree path is outside its owned root");
  }
}

export async function collectLocalArtifact(
  worktree: LocalWorktree,
  logs = "",
  allowedPaths?: string[],
): Promise<NormalizedArtifact> {
  const untrackedRaw = await git(worktree.path, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untracked = untrackedRaw.split("\0").filter(Boolean);
  if (untracked.length > 0) {
    await git(worktree.path, ["add", "--intent-to-add", "--", ...untracked]);
  }
  const pathsRaw = await git(
    worktree.path,
    ["diff", "--name-only", "-z", worktree.baseSha],
    120_000,
    MAX_ARTIFACT_PATCH_BYTES + 1024,
  );
  const changedPaths = pathsRaw.split("\0").filter(Boolean);
  const lfs = await inspectPinnedLfs(worktree.path, worktree.baseSha);
  for (const asset of lfs.assets) {
    const index = changedPaths.indexOf(asset.path);
    if (index < 0) continue;
    const actual = await inspectContentFile(await regularContentPath(worktree.path, asset.path));
    if (actual.digest !== asset.oid || actual.bytes !== asset.size)
      throw new Error(`changed LFS asset ${asset.path} requires unsupported authenticated LFS upload; restore the original asset or publish it explicitly outside Factory`);
    changedPaths.splice(index, 1);
  }
  if (allowedPaths) assertChangedPathScope(changedPaths, allowedPaths);
  if (!changedPaths.length) return normalizeArtifact({ baseSha: worktree.baseSha, patch: "", changedPaths, logs,
    outcome: "declined", reason: "worker produced no repository changes" });
  const root = await mkdtemp(join(tmpdir(), "factory-collected-patch-"));
  try {
    const patchPath = join(root, "artifact.patch");
    await streamGitFile(worktree.path, ["diff", "--binary", "--no-ext-diff", "--no-textconv", worktree.baseSha, "--", ...changedPaths], patchPath);
    return await artifactFromPatchFile({ repository: worktree.path, baseSha: worktree.baseSha, patchPath, changedPaths, logs, outcome: "succeeded" });
  } finally { await rm(root, { recursive: true, force: true }); }
}

/**
 * Seed a fresh retry worktree with a previously host-validated artifact. The
 * base remains unchanged, so later collection still emits one complete patch
 * against the pinned GitHub SHA rather than a chain of private deltas.
 */
export async function seedLocalWorktree(
  worktree: LocalWorktree,
  artifact: NormalizedArtifact,
): Promise<void> {
  const verified = verifyArtifact(artifact);
  if (verified.baseSha !== worktree.baseSha) {
    throw new Error("retry checkpoint base SHA does not match the worktree");
  }
  const patchPath = join(worktree.root, "retry-checkpoint.patch");
  await materializeArtifactPatch(verified, patchPath);
  try {
    await git(worktree.path, ["apply", "--binary", "--whitespace=error-all", patchPath]);
  } finally {
    await rm(patchPath, { force: true });
  }
}

export async function cleanupLocalWorktree(worktree: LocalWorktree): Promise<void> {
  assertOwnedWorktree(worktree);
  const marker = await readFile(join(worktree.root, MARKER), "utf8");
  const [repository, baseSha, kind] = marker.trim().split("\n");
  if (repository !== worktree.repository || baseSha !== worktree.baseSha) {
    throw new Error("worktree ownership marker does not match cleanup request");
  }
  try {
    if (kind !== "raw-tree-v1") await git(worktree.repository, ["worktree", "remove", "--force", worktree.path]);
  } finally {
    // The exact root was created by us, is marker-verified, and has no sibling
    // content. This is deliberately narrower than deleting a supplied path.
    await rm(worktree.root, { recursive: true, force: true });
  }
}

export function worktreeContains(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}
