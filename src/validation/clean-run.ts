import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { executionAffectingReason } from "../approval.js";
import {
  assertArtifactScope,
  verifyArtifact,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { IsolatedValidationResult } from "../execution/backend.js";
import {
  cleanupLocalWorktree,
  createLocalWorktree,
  type LocalWorktree,
} from "../runtime/local-worktree.js";
import {
  runContainedProcess,
  sanitizedWorkerEnvironment,
} from "../runtime/process-group.js";
import {
  createValidationEvidence,
  type ValidationEvidence,
} from "./evidence.js";
import { validationPlanFromPacket } from "./plan.js";

async function git(worktree: LocalWorktree, args: string[]): Promise<string> {
  const result = await runContainedProcess({
    command: "git",
    args,
    cwd: worktree.path,
    env: sanitizedWorkerEnvironment(process.env),
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`validation git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export interface CleanValidationInput {
  repository: string;
  artifact: NormalizedArtifact;
  packet: WorkerPacket;
  isolatedValidator?: () => Promise<IsolatedValidationResult>;
}

export interface CleanValidationResult {
  evidence: ValidationEvidence;
  worktree: LocalWorktree;
}

async function hasNpmLockfile(worktree: LocalWorktree): Promise<boolean> {
  for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
    try {
      await access(join(worktree.path, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Try the next npm lockfile name.
    }
  }
  return false;
}

export async function validateArtifactClean(
  input: CleanValidationInput,
): Promise<CleanValidationResult> {
  const artifact = verifyArtifact(input.artifact);
  if (artifact.outcome !== "succeeded" || !artifact.patch.trim()) {
    throw new Error(`artifact is not executable work: ${artifact.reason ?? artifact.outcome}`);
  }
  if (artifact.baseSha !== input.packet.baseSha) {
    throw new Error("artifact base SHA does not match Worker Packet");
  }
  assertArtifactScope(artifact, input.packet.allowedPaths);
  const sensitive = artifact.changedPaths.filter(
    (path) => executionAffectingReason(path) !== null,
  );
  if (sensitive.length > 0) {
    throw new Error(`artifact touches a sensitive surface: ${sensitive.join(", ")}`);
  }
  assertNoSecretMaterial({ patch: artifact.patch, logs: artifact.logs }, "artifact");

  const plan = validationPlanFromPacket(input.packet);
  if (plan.isolation === "isolated" && !input.isolatedValidator) {
    throw new Error("untrusted validation requires an isolated validation backend");
  }

  const startedAt = new Date();
  const worktree = await createLocalWorktree(input.repository, artifact.baseSha);
  const commands: Array<{ command: string; exitCode: number; durationMs: number }> = [];
  let passed = false;
  let failureReason: string | undefined;
  try {
    const patchPath = join(worktree.root, "artifact.patch");
    await writeFile(patchPath, artifact.patch, { mode: 0o600 });
    const apply = await runContainedProcess({
      command: "git",
      args: ["apply", "--index", "--binary", "--whitespace=error-all", patchPath],
      cwd: worktree.path,
      env: sanitizedWorkerEnvironment(process.env),
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });
    if (apply.exitCode !== 0) {
      throw new Error(`artifact did not apply cleanly: ${apply.stderr || apply.stdout}`);
    }
    const changed = (await git(worktree, ["diff", "--cached", "--name-only", "-z"]))
      .split("\0")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(changed) !== JSON.stringify([...artifact.changedPaths].sort())) {
      throw new Error("applied artifact paths do not match its manifest");
    }

    const outputTreeSha = await git(worktree, ["write-tree"]);
    let evidenceStartedAt = startedAt.toISOString();
    let evidenceCompletedAt: string;
    if (plan.isolation === "isolated") {
      const isolated = await input.isolatedValidator!();
      if (isolated.outputTreeSha !== outputTreeSha) {
        throw new Error(
          `isolated validator tree ${isolated.outputTreeSha} does not match host tree ${outputTreeSha}`,
        );
      }
      for (let index = 0; index < isolated.commands.length; index += 1) {
        if (isolated.commands[index]?.command !== plan.commands[index]) {
          throw new Error("isolated validator command evidence does not match the plan");
        }
      }
      if (isolated.passed && isolated.commands.length !== plan.commands.length) {
        throw new Error("isolated validator omitted commands from a passing result");
      }
      if (!isolated.passed && !isolated.failureReason) {
        throw new Error("isolated validator omitted the failure reason");
      }
      commands.push(...isolated.commands);
      passed = isolated.passed;
      failureReason = isolated.failureReason;
      evidenceStartedAt = isolated.startedAt;
      evidenceCompletedAt = isolated.completedAt;
    } else {
      const localCommands = (await hasNpmLockfile(worktree))
        ? [{ command: "npm ci --no-audit --no-fund", executable: "npm", args: ["ci", "--no-audit", "--no-fund"] }]
        : [];
      for (const setup of localCommands) {
        const result = await runContainedProcess({
          command: setup.executable,
          args: setup.args,
          cwd: worktree.path,
          env: sanitizedWorkerEnvironment(process.env),
          timeoutMs: plan.timeoutMsPerCommand,
        });
        commands.push({
          command: setup.command,
          exitCode: result.exitCode ?? (result.timedOut ? 124 : 1),
          durationMs: result.durationMs,
        });
        if (result.exitCode !== 0) {
          failureReason = result.timedOut
            ? `validation setup timed out: ${setup.command}`
            : `validation setup failed (${result.exitCode}): ${setup.command}`;
          break;
        }
      }
      for (const command of failureReason ? [] : plan.commands) {
        const result = await runContainedProcess({
          command: "/bin/sh",
          args: ["-lc", command],
          cwd: worktree.path,
          env: sanitizedWorkerEnvironment(process.env),
          timeoutMs: plan.timeoutMsPerCommand,
        });
        commands.push({
          command,
          exitCode: result.exitCode ?? (result.timedOut ? 124 : 1),
          durationMs: result.durationMs,
        });
        if (result.exitCode !== 0) {
          failureReason = result.timedOut
            ? `validation timed out: ${command}`
            : `validation failed (${result.exitCode}): ${command}`;
          break;
        }
      }
      passed = failureReason === undefined;
      evidenceCompletedAt = new Date().toISOString();
    }
    const evidence = createValidationEvidence({
      protocol: "clockgrove.factory/validation-v1",
      artifactDigest: artifact.digest,
      baseSha: artifact.baseSha,
      outputTreeSha,
      commands,
      passed,
      ...(failureReason ? { failureReason } : {}),
      startedAt: evidenceStartedAt,
      completedAt: evidenceCompletedAt,
    });
    return { evidence, worktree };
  } catch (error) {
    await cleanupLocalWorktree(worktree);
    throw error;
  }
}

export async function discardValidationResult(result: CleanValidationResult): Promise<void> {
  await cleanupLocalWorktree(result.worktree);
}
