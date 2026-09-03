import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import type { NormalizedArtifact } from "../execution/artifacts.js";
import type { GitCommitObject } from "../control/lease.js";
import type { CleanValidationResult } from "../validation/clean-run.js";
import { verifyValidationEvidence } from "../validation/evidence.js";
import { runContainedProcess, sanitizedWorkerEnvironment } from "../runtime/process-group.js";

export interface PublicationStore {
  createBlob(content: Buffer): Promise<string>;
  createTree(args: {
    baseTreeOid: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }): Promise<string>;
  createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string>;
  createRef(ref: string, oid: string): Promise<boolean>;
  findPullRequestForBranch(branch: string): Promise<{
    number: number;
    htmlUrl: string;
    state: string;
    merged: boolean;
    headSha: string;
  } | null>;
  createPullRequest(args: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number: number; htmlUrl: string; headSha: string }>;
  readPullRequest(number: number): Promise<{
    state: string;
    merged: boolean;
    mergeable: boolean | null;
    mergeableState: string;
    draft: boolean;
    headSha: string;
    baseSha: string;
  }>;
  readChecks(sha: string): Promise<{ pending: string[]; failed: string[] }>;
  mergePullRequest(args: {
    number: number;
    headSha: string;
    commitTitle: string;
  }): Promise<string>;
  closeIssue(number: number): Promise<void>;
  closePullRequest(number: number): Promise<void>;
}

export interface PublishedPullRequest {
  branch: string;
  commitSha: string;
  number: number;
  htmlUrl: string;
}

export type IntegrationReadiness =
  | { state: "ready"; headSha: string }
  | { state: "wait"; reason: string }
  | { state: "failed"; reason: string }
  | { state: "integrated"; headSha: string };

export function publicationBranch(objective: number, workItem: number, attempt: number): string {
  return `factory/objective-${objective}/work-item-${workItem}/attempt-${attempt}`;
}

async function indexMode(worktree: string, path: string): Promise<"100644" | "100755" | "120000" | null> {
  const result = await runContainedProcess({
    command: "git",
    args: ["ls-files", "-s", "--", path],
    cwd: worktree,
    env: sanitizedWorkerEnvironment(process.env),
    timeoutMs: 30_000,
    maxOutputBytes: 8_000,
  });
  if (result.exitCode !== 0) throw new Error(`cannot inspect index mode for ${path}`);
  if (!result.stdout.trim()) return null;
  const mode = result.stdout.trim().slice(0, 6);
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    throw new Error(`unsupported Git object mode ${mode} for ${path}`);
  }
  return mode;
}

async function blobContent(worktree: string, path: string, mode: string): Promise<Buffer> {
  const absolute = join(worktree, path);
  const stat = await lstat(absolute);
  if (mode === "120000") {
    if (!stat.isSymbolicLink()) throw new Error(`${path} index says symlink but workspace does not`);
    return Buffer.from(await readlink(absolute), "utf8");
  }
  if (!stat.isFile()) throw new Error(`${path} is not a publishable regular file`);
  return readFile(absolute);
}

/** Host-owned publication: upload the independently validated tree, then open a PR. */
export async function publishValidated(args: {
  store: PublicationStore;
  assertLease: () => Promise<void>;
  base: GitCommitObject;
  validation: CleanValidationResult;
  artifact: NormalizedArtifact;
  objective: number;
  workItem: number;
  attempt: number;
  title: string;
  baseBranch: string;
}): Promise<PublishedPullRequest> {
  verifyValidationEvidence(args.validation.evidence);
  if (!args.validation.evidence.passed) throw new Error("cannot publish failed validation");
  if (args.validation.evidence.artifactDigest !== args.artifact.digest) {
    throw new Error("validation evidence does not bind the artifact being published");
  }
  if (args.base.oid !== args.artifact.baseSha) {
    throw new Error("publication base does not match the artifact");
  }

  const entries: Array<{
    path: string;
    mode: "100644" | "100755" | "120000";
    type: "blob";
    sha: string | null;
  }> = [];
  for (const path of args.artifact.changedPaths) {
    const mode = await indexMode(args.validation.worktree.path, path);
    if (!mode) {
      entries.push({ path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const content = await blobContent(args.validation.worktree.path, path, mode);
    await args.assertLease();
    const sha = await args.store.createBlob(content);
    entries.push({ path, mode, type: "blob", sha });
  }
  await args.assertLease();
  const treeOid = await args.store.createTree({ baseTreeOid: args.base.treeOid, entries });
  if (treeOid !== args.validation.evidence.outputTreeSha) {
    throw new Error(
      `uploaded tree ${treeOid} does not match validated tree ${args.validation.evidence.outputTreeSha}`,
    );
  }
  await args.assertLease();
  const commitSha = await args.store.createCommit({
    treeOid,
    parentOids: [args.base.oid],
    message: `${args.title}\n\nCloses #${args.workItem}\nFactory-Artifact: ${args.artifact.digest}\nFactory-Validation: ${args.validation.evidence.digest}`,
  });
  const branch = publicationBranch(args.objective, args.workItem, args.attempt);
  await args.assertLease();
  const branchCreated = await args.store.createRef(`refs/heads/${branch}`, commitSha);
  if (!branchCreated) throw new Error(`publication branch ${branch} exists at a different commit`);

  await args.assertLease();
  const existing = await args.store.findPullRequestForBranch(branch);
  if (existing) {
    if (existing.headSha !== commitSha) {
      throw new Error(`existing pull request #${existing.number} has an unexpected head`);
    }
    return { branch, commitSha, number: existing.number, htmlUrl: existing.htmlUrl };
  }
  let pull;
  try {
    pull = await args.store.createPullRequest({
      title: args.title,
      body:
        `Implements Work Item #${args.workItem} for Objective #${args.objective}.\n\n` +
        `Closes #${args.workItem}\n\n` +
        `Artifact: \`${args.artifact.digest}\`\n\n` +
        `Validation: \`${args.validation.evidence.digest}\``,
      head: branch,
      base: args.baseBranch,
    });
  } catch (error) {
    // The create may have committed even when its response was lost. Recover
    // by deterministic branch before treating this as a failed publication.
    const recovered = await args.store.findPullRequestForBranch(branch);
    if (!recovered || recovered.headSha !== commitSha || recovered.state !== "open") {
      throw error;
    }
    pull = {
      number: recovered.number,
      htmlUrl: recovered.htmlUrl,
      headSha: recovered.headSha,
    };
  }
  if (pull.headSha !== commitSha) throw new Error("new pull request head changed during publication");
  return { branch, commitSha, number: pull.number, htmlUrl: pull.htmlUrl };
}

export async function integrationReadiness(
  store: PublicationStore,
  pull: PublishedPullRequest,
  expectedBaseSha?: string,
): Promise<IntegrationReadiness> {
  const current = await store.readPullRequest(pull.number);
  if (current.headSha !== pull.commitSha) return { state: "failed", reason: "pull request head changed after validation" };
  if (current.merged) return { state: "integrated", headSha: current.headSha };
  if (current.state !== "open") return { state: "failed", reason: "pull request closed without merge" };
  if (expectedBaseSha && current.baseSha !== expectedBaseSha) {
    return {
      state: "failed",
      reason: `base branch advanced from validated commit ${expectedBaseSha} to ${current.baseSha}`,
    };
  }
  if (current.draft) return { state: "failed", reason: "Factory publication unexpectedly became draft" };
  const checks = await store.readChecks(current.headSha);
  if (checks.failed.length > 0) return { state: "failed", reason: `checks failed: ${checks.failed.join(", ")}` };
  if (checks.pending.length > 0) return { state: "wait", reason: `checks pending: ${checks.pending.join(", ")}` };
  if (current.mergeable === null || current.mergeableState === "unknown") {
    return { state: "wait", reason: "GitHub is still computing mergeability" };
  }
  if (!current.mergeable || current.mergeableState === "dirty") {
    return { state: "failed", reason: "pull request conflicts with the base branch" };
  }
  if (["blocked", "behind", "unstable"].includes(current.mergeableState)) {
    return { state: "failed", reason: `merge is ${current.mergeableState}; revalidation or human policy action is required` };
  }
  return { state: "ready", headSha: current.headSha };
}
