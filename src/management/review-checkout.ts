import { join } from "node:path";
import { executionAffectingReason } from "../approval.js";
import {
  assertArtifactScope,
  materializeArtifactPatch,
  verifyArtifact,
} from "../execution/artifacts.js";
import {
  assertFilesystemArtifactManifest,
  verifyMaterializedFiles,
} from "../execution/artifact-content.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import { inspectPatchManifest } from "../runtime/artifact-patch.js";
import { materializePinnedCompilationTree } from "../execution/pinned-compilation-tree.js";
import { materializeLocalLfsAssets } from "../repository-profiles/git-lfs.js";
import { runContainedProcess, sanitizedWorkerEnvironment } from "../runtime/process-group.js";
import { verifyValidationEvidence } from "../validation/evidence.js";
import type { ReviewContext } from "./backend.js";
import { ReviewCheckoutCleanupError } from "./backend.js";
import { pinnedGitEnvironment } from "../runtime/pinned-git-environment.js";

/** Reconstruct exactly the already-validated artifact, without running validation,
 * setup, hooks, filters, or a model. Neither a mutable controller checkout nor a
 * stale validation directory is review evidence. */
export async function withVerifiedReviewCheckout<T>(
  input: ReviewContext & { requiresIsolation: boolean },
  review: (repository: string) => Promise<T>,
): Promise<T> {
  if (input.requiresIsolation || input.packet.requirements.trust !== "trusted_local")
    throw new Error(
      "semantic review requires isolated management execution; the local read-only management backend cannot provide that boundary",
    );
  const artifact = verifyArtifact(input.artifact);
  verifyValidationEvidence(input.evidence);
  if (
    !input.evidence.passed ||
    artifact.outcome !== "succeeded" ||
    artifact.baseSha !== input.packet.baseSha ||
    input.evidence.baseSha !== artifact.baseSha ||
    input.evidence.artifactDigest !== artifact.digest
  )
    throw new Error("semantic review artifact and passed validation identities differ");
  assertArtifactScope(artifact, input.packet.allowedPaths);
  if (artifact.changedPaths.some((path) => executionAffectingReason(path) !== null))
    throw new Error("semantic review artifact touches a sensitive surface");
  assertNoSecretMaterial(
    { patch: artifact.patch, logs: artifact.logs },
    "semantic review artifact",
  );
  const worktree = await materializePinnedCompilationTree(input.repository, artifact.baseSha, {
    purpose: "worktree",
  });
  const deadline = Date.now() + 120_000;
  const git = async (args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("semantic review materialization deadline expired");
    const result = await runContainedProcess({
      command: "git",
      args: [
        "--no-optional-locks",
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      cwd: worktree.path,
      env: pinnedGitEnvironment(sanitizedWorkerEnvironment(process.env)),
      timeoutMs: remaining,
      maxOutputBytes: 256 * 1024,
    });
    if (result.exitCode !== 0)
      throw new Error("semantic review artifact Git materialization failed");
    return result.stdout.trim();
  };
  let reviewFailure: unknown;
  try {
    await materializeLocalLfsAssets(input.repository, worktree.path, artifact.baseSha);
    const patchPath = join(worktree.root, "semantic-review.patch");
    await materializeArtifactPatch(artifact, patchPath);
    const manifest = await inspectPatchManifest(
      worktree.path,
      artifact.baseSha,
      patchPath,
      artifact.changedPaths,
    );
    if (artifact.fileManifest && JSON.stringify(artifact.fileManifest) !== JSON.stringify(manifest))
      throw new Error("semantic review manifest differs from actual artifact content");
    assertFilesystemArtifactManifest(manifest);
    await git(["apply", "--index", "--binary", "--whitespace=error-all", patchPath]);
    const changed = (await git(["diff", "--cached", "--name-only", "-z"]))
      .split("\0")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(changed) !== JSON.stringify([...artifact.changedPaths].sort()))
      throw new Error("semantic review materialized paths differ from artifact");
    const tree = await git(["write-tree"]);
    if (
      tree !== input.evidence.outputTreeSha ||
      manifest.resultTreeSha !== tree ||
      manifest.baseTreeSha !== (await git(["rev-parse", `${artifact.baseSha}^{tree}`]))
    )
      throw new Error("semantic review materialized tree differs from validated output tree");
    await verifyMaterializedFiles(worktree.path, manifest);
    return await review(worktree.path);
  } catch (error) {
    reviewFailure = error;
    throw error;
  } finally {
    try {
      await worktree.dispose();
    } catch (cause) {
      // biome-ignore lint/correctness/noUnsafeFinally: unresolved private checkout cleanup must retain known review usage and prevent acceptance
      throw new ReviewCheckoutCleanupError(cause, reviewFailure);
    }
  }
}
