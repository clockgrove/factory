import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import type { NormalizedArtifact } from "../execution/artifacts.js";
import type { GitCommitObject } from "../control/lease.js";
import type { CleanValidationResult } from "../validation/clean-run.js";
import { verifyValidationEvidence } from "../validation/evidence.js";
import {
  bindValidationToPublishedHead,
  verifyExactHeadValidation,
  type ExactHeadValidationEvidence,
} from "../validation/plan.js";
import { runContainedProcess, sanitizedWorkerEnvironment } from "../runtime/process-group.js";
import {
  verifyMergeCandidateSquash,
  verifyMergeCandidateValidation,
  type MergeCandidateValidationEvidence,
} from "./merge-candidate.js";

export interface PublicationStore {
  readRef(ref: string): Promise<string | null>;
  readCommit(oid: string): Promise<GitCommitObject>;
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
  createCommit(args: { treeOid: string; parentOids: string[]; message: string }): Promise<string>;
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
    baseRef: string;
    mergeCommitSha: string | null;
    createdAt?: Date;
  }>;
  readChecks(sha: string): Promise<{
    pending: string[];
    failed: string[];
    observed?: string[];
  }>;
  mergePullRequest(args: { number: number; headSha: string; commitTitle: string }): Promise<string>;
  closeIssue(number: number): Promise<void>;
  closePullRequest(number: number): Promise<void>;
}

export interface PublishedPullRequest {
  branch: string;
  commitSha: string;
  number: number;
  htmlUrl: string;
  exactHeadValidation: ExactHeadValidationEvidence;
}

export type IntegrationReadiness =
  | { state: "ready"; headSha: string }
  | { state: "wait"; reason: string }
  | { state: "failed"; reason: string }
  | { state: "integrated"; headSha: string };

/**
 * GitHub creates a pull request before Actions necessarily attaches its first
 * check. Keep a freshly-created PR out of the merge path while that evidence
 * is still allowed to arrive. Repositories that demonstrably run PR CI remain
 * blocked without checks after this grace period; only a repository with a
 * negative CI probe may proceed once the ambiguity window has elapsed.
 */
export const FIRST_CHECK_DISCOVERY_GRACE_MS = 60_000;

export interface IntegrationReadinessOptions {
  ciExpected?: boolean | "unknown";
  now?: Date;
  firstCheckDiscoveryGraceMs?: number;
  /** Separate validation of this unchanged source PR against an advanced target branch. */
  mergeCandidateValidation?: MergeCandidateValidationEvidence;
}

export async function verifySquashIntegration(
  store: PublicationStore,
  pull: PublishedPullRequest,
  mergeCommitSha: string,
  expectedBaseSha = pull.exactHeadValidation.baseSha,
): Promise<void> {
  const commit = await store.readCommit(mergeCommitSha);
  if (
    commit.parentOids.length !== 1 ||
    commit.parentOids[0] !== expectedBaseSha ||
    commit.treeOid !== pull.exactHeadValidation.outputTreeSha
  ) {
    throw new Error(
      "merged squash commit does not preserve the validated tree on the expected base",
    );
  }
}

export function publicationBranch(objective: number, workItem: number, attempt: number): string {
  return `factory/objective-${objective}/work-item-${workItem}/attempt-${attempt}`;
}

async function indexMode(
  worktree: string,
  path: string,
): Promise<"100644" | "100755" | "120000" | null> {
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
    if (!stat.isSymbolicLink())
      throw new Error(`${path} index says symlink but workspace does not`);
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
  const branch = publicationBranch(args.objective, args.workItem, args.attempt);
  const expectedMessage = `${args.title}\n\nCloses #${args.workItem}\nFactory-Artifact: ${args.artifact.digest}\nFactory-Validation: ${args.validation.evidence.digest}`;
  let commitSha = await args.store.readRef(`refs/heads/${branch}`);
  let treeOid: string;
  if (commitSha) {
    const commit = await args.store.readCommit(commitSha);
    if (
      commit.treeOid !== args.validation.evidence.outputTreeSha ||
      commit.parentOids.length !== 1 ||
      commit.parentOids[0] !== args.base.oid ||
      commit.message.trim() !== expectedMessage
    ) {
      throw new Error(`publication branch ${branch} exists with incompatible content`);
    }
    treeOid = commit.treeOid;
  } else {
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
    treeOid = await args.store.createTree({ baseTreeOid: args.base.treeOid, entries });
    if (treeOid !== args.validation.evidence.outputTreeSha) {
      throw new Error(
        `uploaded tree ${treeOid} does not match validated tree ${args.validation.evidence.outputTreeSha}`,
      );
    }
    await args.assertLease();
    commitSha = await args.store.createCommit({
      treeOid,
      parentOids: [args.base.oid],
      message: expectedMessage,
    });
    await args.assertLease();
    let branchCreated: boolean;
    try {
      branchCreated = await args.store.createRef(`refs/heads/${branch}`, commitSha);
    } catch (error) {
      const recoveredSha = await args.store.readRef(`refs/heads/${branch}`);
      if (recoveredSha !== commitSha) throw error;
      branchCreated = true;
    }
    if (!branchCreated) {
      const recoveredSha = await args.store.readRef(`refs/heads/${branch}`);
      if (!recoveredSha) throw new Error(`publication branch ${branch} was not created`);
      const recovered = await args.store.readCommit(recoveredSha);
      if (
        recovered.treeOid !== treeOid ||
        recovered.parentOids.length !== 1 ||
        recovered.parentOids[0] !== args.base.oid ||
        recovered.message.trim() !== expectedMessage
      ) {
        throw new Error(`publication branch ${branch} exists at a different commit`);
      }
      commitSha = recoveredSha;
    }
  }
  const exactHeadValidation = bindValidationToPublishedHead({
    validation: args.validation.evidence,
    publishedHeadSha: commitSha,
    publishedTreeSha: treeOid,
    publishedBaseSha: args.base.oid,
  });
  await args.assertLease();
  const existing = await args.store.findPullRequestForBranch(branch);
  if (existing) {
    if (existing.headSha !== commitSha) {
      throw new Error(`existing pull request #${existing.number} has an unexpected head`);
    }
    if (existing.state !== "open" && !existing.merged) {
      throw new Error(`existing pull request #${existing.number} was closed without merge`);
    }
    return {
      branch,
      commitSha,
      number: existing.number,
      htmlUrl: existing.htmlUrl,
      exactHeadValidation,
    };
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
  if (pull.headSha !== commitSha)
    throw new Error("new pull request head changed during publication");
  return {
    branch,
    commitSha,
    number: pull.number,
    htmlUrl: pull.htmlUrl,
    exactHeadValidation,
  };
}

export async function integrationReadiness(
  store: PublicationStore,
  pull: PublishedPullRequest,
  expectedBaseSha?: string,
  expectedBaseRef?: string,
  options: IntegrationReadinessOptions = {},
): Promise<IntegrationReadiness> {
  verifyExactHeadValidation(pull.exactHeadValidation, pull.commitSha);
  const candidate = options.mergeCandidateValidation;
  if (candidate)
    verifyMergeCandidateValidation(candidate, pull.exactHeadValidation, expectedBaseSha);
  const validatedBaseSha = candidate?.targetBaseSha ?? expectedBaseSha;
  const current = await store.readPullRequest(pull.number);
  if (current.headSha !== pull.commitSha)
    return { state: "failed", reason: "pull request head changed after validation" };
  if (expectedBaseRef && current.baseRef !== expectedBaseRef) {
    return {
      state: "failed",
      reason: `pull request targets ${current.baseRef}, expected ${expectedBaseRef}`,
    };
  }
  if (current.merged) {
    if (!current.mergeCommitSha) {
      return { state: "failed", reason: "merged pull request has no merge commit identity" };
    }
    try {
      if (candidate) {
        await verifyMergeCandidateSquash(
          store,
          pull.exactHeadValidation,
          candidate,
          current.mergeCommitSha,
        );
      } else {
        await verifySquashIntegration(
          store,
          pull,
          current.mergeCommitSha,
          expectedBaseSha ?? pull.exactHeadValidation.baseSha,
        );
      }
    } catch (error) {
      return {
        state: "failed",
        reason:
          `irreversible merge could not be proven against validated state: ` +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    return { state: "integrated", headSha: current.mergeCommitSha };
  }
  if (current.state !== "open")
    return { state: "failed", reason: "pull request closed without merge" };
  if (validatedBaseSha && current.baseSha !== validatedBaseSha) {
    return {
      state: "failed",
      reason: `base branch advanced from validated commit ${validatedBaseSha} to ${current.baseSha}`,
    };
  }
  if (current.draft)
    return { state: "failed", reason: "Factory publication unexpectedly became draft" };
  const checks = await store.readChecks(current.headSha);
  if (checks.failed.length > 0)
    return { state: "failed", reason: `checks failed: ${checks.failed.join(", ")}` };
  if (checks.pending.length > 0)
    return { state: "wait", reason: `checks pending: ${checks.pending.join(", ")}` };
  const noChecksObserved = (checks.observed?.length ?? 0) === 0;
  if (noChecksObserved && options.ciExpected !== false && options.ciExpected !== undefined) {
    return {
      state: "wait",
      reason:
        options.ciExpected === "unknown"
          ? "cannot determine whether repository CI is expected and no checks have appeared"
          : "repository CI is expected but no checks have appeared",
    };
  }
  if (noChecksObserved && current.createdAt) {
    const now = options.now ?? new Date();
    const graceMs = options.firstCheckDiscoveryGraceMs ?? FIRST_CHECK_DISCOVERY_GRACE_MS;
    if (now.getTime() - current.createdAt.getTime() < graceMs) {
      return {
        state: "wait",
        reason: "waiting for the pull request's first checks to appear",
      };
    }
  }
  if (current.mergeable === null || current.mergeableState === "unknown") {
    return { state: "wait", reason: "GitHub is still computing mergeability" };
  }
  if (!current.mergeable || current.mergeableState === "dirty") {
    return { state: "failed", reason: "pull request conflicts with the base branch" };
  }
  if (["blocked", "behind", "unstable"].includes(current.mergeableState)) {
    return {
      state: "failed",
      reason: `merge is ${current.mergeableState}; revalidation or human policy action is required`,
    };
  }
  return { state: "ready", headSha: current.headSha };
}
