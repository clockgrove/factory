import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import {
  MAX_ARTIFACT_PATCH_BYTES,
  assertChangedPathScope,
  normalizeArtifact,
  verifyArtifact,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import { runContainedProcess, sanitizedWorkerEnvironment } from "./process-group.js";

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
  const root = await mkdtemp(join(tmpdir(), "clockgrove-factory-worktree-"));
  const path = join(root, "worktree");
  await writeFile(join(root, MARKER), `${repo}\n${baseSha}\n`, { mode: 0o600 });
  try {
    await git(repo, ["worktree", "add", "--detach", path, baseSha]);
    return { root, path, repository: repo, baseSha };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
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
  if (allowedPaths) assertChangedPathScope(changedPaths, allowedPaths);
  // Allow the complete protocol-sized payload through the process collector.
  // A smaller generic command-output cap would silently turn a valid large
  // patch or manifest into an invalid tail fragment.
  const artifactOutputLimit = MAX_ARTIFACT_PATCH_BYTES + 1024;
  const patch = await git(
    worktree.path,
    ["diff", "--binary", "--no-ext-diff", worktree.baseSha],
    120_000,
    artifactOutputLimit,
  );
  return normalizeArtifact({
    baseSha: worktree.baseSha,
    patch,
    changedPaths,
    logs,
    outcome: patch.trim() ? "succeeded" : "declined",
    ...(patch.trim() ? {} : { reason: "worker produced no repository changes" }),
  });
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
  await writeFile(patchPath, verified.patch, { mode: 0o600 });
  try {
    await git(worktree.path, ["apply", "--binary", "--whitespace=error-all", patchPath]);
  } finally {
    await rm(patchPath, { force: true });
  }
}

export async function cleanupLocalWorktree(worktree: LocalWorktree): Promise<void> {
  assertOwnedWorktree(worktree);
  const marker = await readFile(join(worktree.root, MARKER), "utf8");
  const [repository, baseSha] = marker.trim().split("\n");
  if (repository !== worktree.repository || baseSha !== worktree.baseSha) {
    throw new Error("worktree ownership marker does not match cleanup request");
  }
  try {
    await git(worktree.repository, ["worktree", "remove", "--force", worktree.path]);
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
