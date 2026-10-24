import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  CapturedAssetSet,
  ContentStore,
  ExecutionContext,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  HarnessResult,
} from "../contracts.js";
import { attachedFault } from "../fault.js";
import {
  hasUnresolvedSubprocesses,
  pinnedGit,
  pinnedGitAsync,
  pinnedGitRaw,
  removeWorktree,
} from "../process.js";
import {
  isCheckpointAdmissionFailure,
  privateCheckpointBounds,
} from "../recovery-checkpoint.js";
import { readProducedAssets } from "./harness-support.js";
import {
  collectWorktreeResult,
  freezeRejectedCollection,
  type RejectedCollectionReceipt,
} from "./local.js";

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

/** The state a managed driver checkpoints around an admitted effect. */
interface ManagedCheckpointed {
  phase: string;
  checkpointAdmission?: {
    phase: string;
    boundary: "before-effect" | "settled";
    knownNotDispatched: boolean;
    at: string;
  };
}

/** Cleanup proceeds when checkpoint admission is refused; other faults still stop it. */
export function managedCessationContext(
  context?: ExecutionContext,
): ExecutionContext | undefined {
  if (!context) return undefined;
  return {
    ...context,
    admitEffect: async (reason) => {
      try {
        await context.admitEffect?.(reason);
      } catch (error) {
        if (!isCheckpointAdmissionFailure(error)) throw error;
      }
    },
  };
}

/** Checkpoint the handle and admit the next effect, recording a refused admission. */
export async function saveManagedHandle(
  handle: ExecutionHandle,
  data: ManagedCheckpointed,
  context?: ExecutionContext,
  reason: "before-effect" | "settled" = "settled",
): Promise<void> {
  if (!context)
    throw new Error(
      "Managed execution requires controller checkpoint authority",
    );
  if (data.checkpointAdmission && data.checkpointAdmission.phase !== data.phase)
    delete data.checkpointAdmission;
  context.checkpoint(handle);
  try {
    await context.admitEffect?.(reason);
  } catch (error) {
    if (isCheckpointAdmissionFailure(error) && context.checkpointedEffects) {
      data.checkpointAdmission = {
        phase: data.phase,
        boundary: reason,
        knownNotDispatched: reason === "before-effect",
        at: new Date().toISOString(),
      };
      context.checkpoint(handle);
    }
    throw error;
  }
}

/** Save before a cleanup effect; a refused admission still lets cleanup proceed. */
export async function saveManagedCessation(
  handle: ExecutionHandle,
  data: ManagedCheckpointed,
  context?: ExecutionContext,
): Promise<void> {
  try {
    await saveManagedHandle(handle, data, context, "before-effect");
  } catch (error) {
    if (!isCheckpointAdmissionFailure(error)) throw error;
    delete data.checkpointAdmission;
    context?.checkpoint(handle);
  }
}

/** The collection state a managed driver keeps on its handle. */
interface ManagedCollection {
  request: ExecutionRequest;
  result?: ExecutionResult;
  rejectedCollection?: RejectedCollectionReceipt;
  collectedAssets?: CapturedAssetSet[];
}

/**
 * Collect the provider's materialized result from `worktree` once, or freeze
 * a rejected one, acknowledging either before the worktree is removed.
 * `populate` fills the worktree and returns the provider's evidence.
 */
export async function collectManagedResult(args: {
  handle: ExecutionHandle;
  data: ManagedCollection;
  context: ExecutionContext;
  checkout: string;
  contentStore: ContentStore;
  worktree: string;
  artifact: { identity: string; bytes: Buffer };
  save: () => Promise<void>;
  populate: () => Promise<HarnessResult["evidence"]>;
}): Promise<ExecutionResult> {
  const { handle, data, context, checkout, worktree } = args;
  let collectionAcknowledged = false;
  try {
    const evidence = await args.populate();
    return await collectWorktreeResult(
      checkout,
      worktree,
      data.request,
      args.contentStore,
      {
        assets: readProducedAssets({ item: data.request.item, worktree }),
        evidence,
      },
      async (collected) => {
        data.result = collected;
        await args.save();
        await context.admitEffect?.("explicit");
        collectionAcknowledged = true;
      },
      undefined,
      async (assets) => {
        if (!privateCheckpointBounds() || !assets.length) return;
        data.collectedAssets = structuredClone(assets);
        // Freeze source or rejection before requiring a complete remote ACK.
        context.checkpoint(handle);
      },
    );
  } catch (error) {
    if (
      privateCheckpointBounds() &&
      attachedFault(error)?.kind === "work" &&
      !hasUnresolvedSubprocesses()
    ) {
      data.rejectedCollection = await freezeRejectedCollection({
        checkout,
        worktree,
        request: data.request,
        store: args.contentStore,
        error,
        capturedAssets: data.collectedAssets,
        rawReturn: {
          provenance: "managed-original-artifact",
          identity: args.artifact.identity,
          bytes: args.artifact.bytes,
        },
      });
      await args.save();
      await context.admitEffect?.("explicit");
      collectionAcknowledged = true;
    }
    throw error;
  } finally {
    if (
      (data.result || data.rejectedCollection) &&
      collectionAcknowledged &&
      !hasUnresolvedSubprocesses()
    ) {
      await args.save();
      await context.admitEffect?.("explicit");
      await removeWorktree(checkout, worktree);
    }
  }
}
