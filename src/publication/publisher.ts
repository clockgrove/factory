import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";

import { canonicalLfsPointer, type NormalizedArtifact } from "../execution/artifacts.js";
import {
  MAX_CONTENT_FILE_BYTES,
  regularContentPath,
  sha256,
  verifyMaterializedFiles,
} from "../execution/artifact-content.js";
import type { GitCommitContent, GitCommitObject } from "../control/lease.js";
import {
  verifyPlannedSiblingRefreshCommit,
  type SiblingRefreshRecord,
} from "../control/sibling-refreshes.js";
import { assertNoSecretMaterial, gitSha } from "../protocol/limits.js";
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
import {
  GitLfsOutputTransport,
  assertLfsReceiptRemoteIdentity,
  verifyMaterializedLfsContent,
  type LfsOutputTransport,
} from "./git-lfs-output.js";
import { destinationAllowedByPolicy } from "../protocol/policy.js";

export interface PublicationStore {
  listRefs?(prefix: string): Promise<Array<{ ref: string; oid: string }>>;
  /**
   * The concrete transport rechecks Objective authority immediately before
   * authoritative publication. Immutable object preparation remains guarded
   * by transport safety controls without spending a lease read per object.
   */
  readonly objectivePublicationFenceAtDispatch?: boolean;
  /** Run mutable publication policy inside the concrete transport fence,
   * after queue admission and authority validation. */
  withPublicationSafetyFence?<T>(
    fence: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T>;
  readRef(ref: string): Promise<string | null>;
  readCommit(oid: string): Promise<GitCommitObject>;
  readCommitContent?(oid: string): Promise<GitCommitContent>;
  /** Required only for independent immutable sibling-refresh verification. */
  readTreeEntry?(treeOid: string, path: string): Promise<string | null>;
  readBlob?(oid: string): Promise<Buffer>;
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

/** Avoid a duplicate remote preflight only when the mutation transport itself
 * guarantees a fresh Objective fence at dispatch. */
export async function assertPublicationMutationAuthorized(
  store: Pick<PublicationStore, "objectivePublicationFenceAtDispatch">,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  if (!store.objectivePublicationFenceAtDispatch) await assertCurrent();
}

/** Dispatch one externally visible publication effect with both Objective
 * authority and mutable content policy as fresh as the transport permits. */
export async function dispatchPublicationMutation<T>(args: {
  store: PublicationStore;
  assertCurrent: () => Promise<void>;
  assertSafety?: () => Promise<void>;
  mutate: () => Promise<T>;
}): Promise<T> {
  if (
    args.assertSafety &&
    args.store.objectivePublicationFenceAtDispatch &&
    !args.store.withPublicationSafetyFence
  )
    throw new Error("transport-bound publication safety fence is unavailable");
  await assertPublicationMutationAuthorized(args.store, args.assertCurrent);
  if (args.assertSafety && args.store.withPublicationSafetyFence) {
    return args.store.withPublicationSafetyFence(args.assertSafety, args.mutate);
  }
  await args.assertSafety?.();
  return args.mutate();
}

export interface PublishedPullRequest {
  branch: string;
  commitSha: string;
  number: number;
  htmlUrl: string;
  exactHeadValidation: ExactHeadValidationEvidence;
}

export interface IntegrationWait {
  state: "wait";
  reason: string;
  code: "checks-pending" | "checks-missing" | "mergeability-pending" | "refreshed-head-pending";
  headSha: string;
  baseSha: string;
}

export type IntegrationReadiness =
  | { state: "ready"; headSha: string }
  | IntegrationWait
  | { state: "failed"; reason: string }
  | { state: "integrated"; headSha: string };

export interface IntegrationReadinessOptions {
  ciExpected?: boolean | "unknown";
  /** Separate validation of this unchanged source PR against an advanced target branch. */
  mergeCandidateValidation?: MergeCandidateValidationEvidence;
  /** Observed native-stack rewrite; requires the original source-bound candidate proof. */
  mergeCandidateDeliveryHeadSha?: string;
  /** Separate FF sibling lineage, never the singleton-parent native linear rewrite. */
  siblingRefresh?: SiblingRefreshRecord;
}

export async function verifySquashIntegration(
  store: PublicationStore,
  pull: PublishedPullRequest,
  mergeCommitSha: string,
  expectedBaseSha = pull.exactHeadValidation.baseSha,
): Promise<void> {
  const commit = await (store.readCommitContent?.(mergeCommitSha) ??
    store.readCommit(mergeCommitSha));
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
  if (stat.size > MAX_CONTENT_FILE_BYTES)
    throw new Error(`${path} exceeds the ordinary Git blob publication ceiling`);
  await regularContentPath(worktree, path);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_CONTENT_FILE_BYTES)
      throw new Error("publication file changed before bounded read");
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const result = await file.read(content, offset, content.length - offset, offset);
      if (!result.bytesRead) throw new Error("publication file was truncated");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("publication file changed during bounded read");
    return content;
  } finally {
    await file.close();
  }
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
  repositoryPath?: string;
  allowedNetworkDestinations?: string[];
  lfsTransport?: LfsOutputTransport;
  /** Deterministic content-policy checks replayed at the actual remote effects. */
  beforeRefMutation?: () => Promise<void>;
  beforePullRequestMutation?: () => Promise<void>;
}): Promise<PublishedPullRequest> {
  verifyValidationEvidence(args.validation.evidence);
  if (!args.validation.evidence.passed) throw new Error("cannot publish failed validation");
  if (args.validation.evidence.artifactDigest !== args.artifact.digest) {
    throw new Error("validation evidence does not bind the artifact being published");
  }
  if (args.base.oid !== args.artifact.baseSha) {
    throw new Error("publication base does not match the artifact");
  }
  if (args.artifact.fileManifest) {
    if (
      args.artifact.fileManifest.baseTreeSha !== args.base.treeOid ||
      args.artifact.fileManifest.resultTreeSha !== args.validation.evidence.outputTreeSha
    )
      throw new Error("publication content manifest does not match exact validated trees");
    const lfsPaths = new Set((args.artifact.lfsObjects ?? []).map((receipt) => receipt.path));
    await verifyMaterializedFiles(args.validation.worktree.path, {
      ...args.artifact.fileManifest,
      files: args.artifact.fileManifest.files.filter((file) => !lfsPaths.has(file.path)),
    });
    await verifyMaterializedLfsContent(args.validation.worktree.path, args.artifact);
  }
  const branch = publicationBranch(args.objective, args.workItem, args.attempt);
  const expectedMessage = `${args.title}\n\nCloses #${args.workItem}\nFactory-Artifact: ${args.artifact.digest}\nFactory-Validation: ${args.validation.evidence.digest}`;
  let commitSha = await args.store.readRef(`refs/heads/${branch}`);
  let treeOid: string;
  if (commitSha) {
    const commit = await (args.store.readCommitContent?.(commitSha) ??
      args.store.readCommit(commitSha));
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
      const lfs = args.artifact.lfsObjects?.find((receipt) => receipt.path === path);
      const content = lfs
        ? canonicalLfsPointer(lfs.oid, lfs.size)
        : await blobContent(args.validation.worktree.path, path, mode);
      const manifest = args.artifact.fileManifest?.files.find((file) => file.path === path);
      if (
        manifest &&
        (manifest.action !== "write" ||
          manifest.mode !== mode ||
          manifest.bytes !== content.length ||
          manifest.digest !== sha256(content))
      )
        throw new Error("publication bytes changed after validation");
      assertNoSecretMaterial(content.toString("latin1"), "publication content");
      await assertPublicationMutationAuthorized(args.store, args.assertLease);
      const sha = await args.store.createBlob(content);
      entries.push({ path, mode, type: "blob", sha });
    }
    await assertPublicationMutationAuthorized(args.store, args.assertLease);
    treeOid = await args.store.createTree({ baseTreeOid: args.base.treeOid, entries });
    if (treeOid !== args.validation.evidence.outputTreeSha) {
      throw new Error(
        `uploaded tree ${treeOid} does not match validated tree ${args.validation.evidence.outputTreeSha}`,
      );
    }
    await assertPublicationMutationAuthorized(args.store, args.assertLease);
    commitSha = await args.store.createCommit({
      treeOid,
      parentOids: [args.base.oid],
      message: expectedMessage,
    });
    const preparedCommitSha = commitSha;
    let branchCreated: boolean;
    try {
      branchCreated = await dispatchPublicationMutation({
        store: args.store,
        assertCurrent: args.assertLease,
        ...{
          assertSafety: async () => {
            await args.beforeRefMutation?.();
            if (args.artifact.lfsObjects?.length) {
              if (!args.repositoryPath)
                throw new Error("LFS publication requires the authenticated repository path");
              const transport = args.lfsTransport ?? new GitLfsOutputTransport();
              const remote = await transport.preflight(
                args.repositoryPath,
                args.artifact.lfsObjects[0]!.rawTransfer.identity.repository,
                args.allowedNetworkDestinations ?? [],
              );
              if (
                !destinationAllowedByPolicy(
                  remote.remoteHost,
                  args.allowedNetworkDestinations ?? [],
                )
              )
                throw new Error("Git LFS publication endpoint is outside run-policy egress");
              assertLfsReceiptRemoteIdentity(args.artifact, remote);
              for (const receipt of args.artifact.lfsObjects) {
                const bytes = await transport.read({
                  repository: args.repositoryPath,
                  object: receipt,
                  resultTreeSha: args.validation.evidence.outputTreeSha,
                  baseSha: args.artifact.baseSha,
                  endpoint: remote.endpoint,
                });
                if (bytes.length !== receipt.size || sha256(bytes) !== receipt.oid)
                  throw new Error("remote LFS object changed before pointer publication");
              }
            }
          },
        },
        mutate: () => args.store.createRef(`refs/heads/${branch}`, preparedCommitSha),
      });
    } catch (error) {
      const recoveredSha = await args.store.readRef(`refs/heads/${branch}`);
      if (recoveredSha !== preparedCommitSha) throw error;
      branchCreated = true;
    }
    if (!branchCreated) {
      const recoveredSha = await args.store.readRef(`refs/heads/${branch}`);
      if (!recoveredSha) throw new Error(`publication branch ${branch} was not created`);
      const recovered = await (args.store.readCommitContent?.(recoveredSha) ??
        args.store.readCommit(recoveredSha));
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
    pull = await dispatchPublicationMutation({
      store: args.store,
      assertCurrent: args.assertLease,
      assertSafety: async () => {
        await args.beforePullRequestMutation?.();
        const observedHead = await args.store.readRef(`refs/heads/${branch}`);
        if (observedHead !== commitSha) {
          // Keep absence distinct from contradictory identity. A later compatible
          // ref cannot establish what this dispatch fence actually observed.
          const observed = observedHead === null ? "absent" : gitSha.parse(observedHead);
          throw new Error(
            `publication branch ${branch} changed after policy admission ` +
              `(stage=before-pull-request expected=${commitSha} observed=${observed})`,
          );
        }
      },
      mutate: () =>
        args.store.createPullRequest({
          title: args.title,
          body:
            `Implements Work Item #${args.workItem} for Objective #${args.objective}.\n\n` +
            `Closes #${args.workItem}\n\n` +
            `Artifact: \`${args.artifact.digest}\`\n\n` +
            `Validation: \`${args.validation.evidence.digest}\``,
          head: branch,
          base: args.baseBranch,
        }),
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
  const refresh = options.siblingRefresh;
  if (refresh) {
    if (
      options.mergeCandidateDeliveryHeadSha ||
      !candidate ||
      refresh.source.digest !== pull.exactHeadValidation.digest ||
      refresh.identity.sourceHeadSha !== pull.commitSha ||
      refresh.identity.pullRequest !== pull.number ||
      refresh.identity.branch !== pull.branch ||
      refresh.identity.targetBaseSha !== candidate.targetBaseSha ||
      refresh.outputTreeSha !== candidate.candidateOutputTreeSha
    )
      throw new Error("sibling refresh does not bind this original source and candidate");
    if (!store.readTreeEntry || !store.readBlob || !store.listRefs)
      throw new Error("sibling refresh requires immutable record read capability");
    await verifyPlannedSiblingRefreshCommit(
      {
        readRef: (ref) => store.readRef(ref),
        listRefs: (prefix) => store.listRefs!(prefix),
        readCommit: (oid) => store.readCommit(oid),
        ...(store.readCommitContent
          ? { readCommitContent: (oid: string) => store.readCommitContent!(oid) }
          : {}),
        readTreeEntry: (tree, path) => store.readTreeEntry!(tree, path),
        readBlob: (oid) => store.readBlob!(oid),
      },
      refresh,
    );
  }
  const deliveryHeadSha = refresh?.plannedHeadSha ?? options.mergeCandidateDeliveryHeadSha;
  if (deliveryHeadSha !== undefined) {
    if (!candidate) throw new Error("merge candidate delivery head requires candidate validation");
    gitSha.parse(deliveryHeadSha);
  }
  const validatedBaseSha = candidate?.targetBaseSha ?? expectedBaseSha;
  const current = await store.readPullRequest(pull.number);
  if (current.headSha !== (deliveryHeadSha ?? pull.commitSha))
    return { state: "failed", reason: "pull request head changed after validation" };
  if (deliveryHeadSha !== undefined && candidate && !refresh) {
    const delivery = await (store.readCommitContent?.(deliveryHeadSha) ??
      store.readCommit(deliveryHeadSha));
    if (
      delivery.oid !== deliveryHeadSha ||
      delivery.parentOids.length !== 1 ||
      delivery.parentOids[0] !== candidate.targetBaseSha ||
      delivery.treeOid !== candidate.candidateOutputTreeSha
    )
      return {
        state: "failed",
        reason: "delivery head does not preserve the merge candidate tree on its target base",
      };
  }
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
    return {
      state: "wait",
      code: "checks-pending",
      headSha: current.headSha,
      baseSha: current.baseSha,
      reason: `checks pending: ${checks.pending.join(", ")}`,
    };
  const noChecksObserved = (checks.observed?.length ?? 0) === 0;
  if (noChecksObserved && options.ciExpected !== false && options.ciExpected !== undefined) {
    return {
      state: "wait",
      code: "checks-missing",
      headSha: current.headSha,
      baseSha: current.baseSha,
      reason:
        options.ciExpected === "unknown"
          ? "cannot determine whether repository CI is expected and no checks have appeared"
          : "repository CI is expected but no checks have appeared",
    };
  }
  if (current.mergeable === null || current.mergeableState === "unknown") {
    return {
      state: "wait",
      code: "mergeability-pending",
      headSha: current.headSha,
      baseSha: current.baseSha,
      reason: "GitHub is still computing mergeability",
    };
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
