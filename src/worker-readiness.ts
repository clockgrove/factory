import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
  ExecutionRequest,
  HarnessRequest,
  ValidationCommandReceipt,
  WorkItem,
} from "./contracts.js";
import {
  hasUnresolvedSubprocesses,
  localValidationEnvironment,
  pinnedGit,
  pinnedGitRaw,
} from "./process.js";
import {
  assertValidationWorktreeObservation,
  type ValidationEvidence,
} from "./validation-evidence.js";

/** An observation at dispatch, not a cache, lease or future runtime guarantee. */
export interface WorkerReadinessReceipt {
  producer: "controller";
  workerIdentity: string;
  worktree: string;
  gitDirectory: string;
  commitSha: string;
  /** Binds all tracked dependency/configuration/source inputs, not ignored installs. */
  treeSha: string;
  observedAt: string;
  environment: {
    control: "local-validation-environment";
    sha256: string;
    controllerNode: {
      executable: string;
      version: string;
      platform: string;
      arch: string;
    };
    workerToolEnvironment: "unobserved";
  };
  runtime: {
    availability: "declared-commands-passed-at-dispatch";
    ignoredArtifacts: "root-entries-observed-nested-and-external-unobserved";
    ignoredEntries: {
      path: string;
      device: number;
      inode: number;
      mode: number;
      bytes: number;
      mtimeMs: number;
      ctimeMs: number;
    }[];
    subprocessOwnership: "settled";
  };
  commands: (ValidationCommandReceipt & {
    validationIndex: number;
    provenance: WorkItem["validation"][number]["provenance"];
    source?: string;
    reusable: boolean;
  })[];
  digest: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Directory identities detect missing roots, not all nested or external runtime bytes. */
function ignoredEntries(
  worktree: string,
): WorkerReadinessReceipt["runtime"]["ignoredEntries"] {
  return pinnedGitRaw(
    worktree,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((path) => {
      const entry = lstatSync(join(worktree, path));
      return {
        path,
        device: entry.dev,
        inode: entry.ino,
        mode: entry.mode,
        bytes: entry.size,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
      };
    });
}

/** Called only after the controller's source-authorized sequence has settled. */
export function workerReadinessReceipt(args: {
  request: ExecutionRequest;
  workerIdentity: string;
  worktree: string;
  validationRoot: string;
  evidence: ValidationEvidence;
}): WorkerReadinessReceipt {
  const readiness = args.request.environmentReadiness;
  if (!readiness) throw new Error("Worker readiness has no graph selection");
  const treeSha = pinnedGit(args.worktree, "rev-parse", "HEAD^{tree}");
  assertValidationWorktreeObservation(
    args.evidence.worktreeObservation,
    treeSha,
    args.evidence.selectedLfs,
  );
  if (
    args.evidence.treeSha !== treeSha ||
    !args.evidence.worktreeObservation ||
    pinnedGit(args.worktree, "rev-parse", "HEAD") !== args.request.baseSha ||
    hasUnresolvedSubprocesses() ||
    args.evidence.commands.length !== readiness.validationIndices.length
  )
    throw new Error(
      "Worker readiness is not the settled actual checkout sequence",
    );
  const reusable = new Set(readiness.reusableValidationIndices ?? []);
  if (
    reusable.size !== (readiness.reusableValidationIndices ?? []).length ||
    [...reusable].some((index) => !readiness.validationIndices.includes(index))
  )
    throw new Error("Reusable readiness is outside the graph selection");
  const commands = args.evidence.commands.map((entry, index) => {
    const validationIndex = readiness.validationIndices[index]!;
    const check = args.request.item.validation[validationIndex];
    if (
      !check ||
      entry.index !== index ||
      entry.command !== check.command ||
      entry.treeSha !== treeSha ||
      !entry.passed ||
      entry.exitCode !== 0
    )
      throw new Error(
        "Worker readiness differs from its literal command authority",
      );
    return {
      ...entry,
      validationIndex,
      provenance: check.provenance,
      ...(check.source && { source: check.source }),
      reusable: reusable.has(validationIndex),
    };
  });
  const environment = localValidationEnvironment(
    join(args.validationRoot, "empty-gh-config"),
  );
  const value: Omit<WorkerReadinessReceipt, "digest"> = {
    producer: "controller",
    workerIdentity: args.workerIdentity,
    worktree: realpathSync(args.worktree),
    gitDirectory: realpathSync(
      pinnedGit(args.worktree, "rev-parse", "--absolute-git-dir"),
    ),
    commitSha: args.request.baseSha,
    treeSha,
    observedAt: new Date().toISOString(),
    environment: {
      control: "local-validation-environment",
      sha256: digest(
        Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
      ),
      controllerNode: {
        executable: realpathSync(process.execPath),
        version: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      workerToolEnvironment: "unobserved",
    },
    runtime: {
      availability: "declared-commands-passed-at-dispatch",
      ignoredArtifacts: "root-entries-observed-nested-and-external-unobserved",
      ignoredEntries: ignoredEntries(args.worktree),
      subprocessOwnership: "settled",
    },
    commands,
  };
  return { ...value, digest: digest(value) };
}

/** Recheck identity at prompt rendering; never reuse a copied historical receipt. */
export function currentWorkerReadiness(
  request: HarnessRequest,
): WorkerReadinessReceipt | undefined {
  const receipt = request.workerReadiness;
  if (!receipt) return undefined;
  const { digest: expectedDigest, ...value } = receipt;
  try {
    if (
      expectedDigest !== digest(value) ||
      receipt.producer !== "controller" ||
      receipt.workerIdentity !== request.attemptId ||
      receipt.worktree !== realpathSync(request.worktree) ||
      receipt.gitDirectory !==
        realpathSync(
          pinnedGit(request.worktree, "rev-parse", "--absolute-git-dir"),
        ) ||
      receipt.commitSha !== pinnedGit(request.worktree, "rev-parse", "HEAD") ||
      receipt.treeSha !==
        pinnedGit(request.worktree, "rev-parse", "HEAD^{tree}") ||
      pinnedGitRaw(request.worktree, "diff", "--name-only", "HEAD", "--")
        .length ||
      receipt.runtime.subprocessOwnership !== "settled" ||
      digest(receipt.runtime.ignoredEntries) !==
        digest(ignoredEntries(request.worktree)) ||
      receipt.commands.some((entry) => {
        const check = request.item.validation[entry.validationIndex];
        return (
          !check ||
          check.command !== entry.command ||
          check.provenance !== entry.provenance ||
          check.source !== entry.source ||
          entry.treeSha !== receipt.treeSha ||
          !entry.passed ||
          entry.exitCode !== 0
        );
      })
    )
      return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

export function workerReadinessInstructions(
  receipt: WorkerReadinessReceipt,
): string {
  return `\n\nController readiness in this exact checkout (current at dispatch, not implementation acceptance):\n${JSON.stringify(receipt)}\nRows marked reusable are preparation/probes already executed by the controller, not by you. Reuse them only while their dependency, configuration, command-source and probe inputs remain unchanged from this pinned commit/tree, the effective toolchain/environment is compatible, and needed ignored installations/runtime artifacts remain available. The controller's Node/environment observation does not prove your shell's tools or environment; only ignored root-entry identities were observed, so nested or external runtime availability remains unproved. Inspect relevant changed inputs or use the authorized probe when freshness is uncertain. A new checkout, changed prerequisite inputs or toolchain/environment, missing runtime, source-required post-edit execution, or uncertain validity requires the original authorized setup and probe again in their declared order before dependent checks. Changes unrelated to prerequisite inputs alone do not require repeating setup. Do not omit substantive/post-edit commands, infer installation transfer from Git, or call these controller commands personally executed. Report reuse or invalidation and commands you actually ran separately. Factory still performs fresh exact-result validation independently.`;
}
