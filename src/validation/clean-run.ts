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
import { runContainedProcess, sanitizedWorkerEnvironment } from "../runtime/process-group.js";
import { createValidationEvidence, type ValidationEvidence } from "./evidence.js";
import { NPM_VALIDATION_SETUP_COMMAND, validationPlanFromPacket } from "./plan.js";

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

export function validationFailureReason(
  phase: "validation" | "validation setup",
  command: string,
  result: {
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
): string {
  const summary = result.timedOut
    ? `${phase} timed out: ${command}`
    : `${phase} failed (${result.exitCode ?? 1}): ${command}`;
  const rawOutput = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  if (!rawOutput) return summary;
  // The failure is persisted to GitHub and sent to the next worker. Scan the
  // complete bounded command output before retaining only its useful tail.
  assertNoSecretMaterial(rawOutput, `${phase} output`);
  const tail = Array.from(rawOutput).slice(-6_000).join("");
  return `${summary}\nOutput tail:\n${tail}`;
}

/**
 * Treat provider-produced validation evidence as an untrusted attestation. A
 * passing result must cover the complete plan with zero exits. A failing
 * result may stop early, but must be the exact plan prefix through its first
 * failed command.
 */
export function assertIsolatedValidationMatchesPlan(
  isolated: IsolatedValidationResult,
  expectedCommands: string[],
): void {
  for (let index = 0; index < isolated.commands.length; index += 1) {
    if (isolated.commands[index]?.command !== expectedCommands[index]) {
      throw new Error("isolated validator command evidence does not match the plan");
    }
  }

  const firstFailure = isolated.commands.findIndex(({ exitCode }) => exitCode !== 0);
  if (isolated.passed) {
    if (isolated.commands.length !== expectedCommands.length) {
      throw new Error("isolated validator omitted commands from a passing result");
    }
    if (firstFailure !== -1 || isolated.failureReason !== undefined) {
      throw new Error("isolated validator marked failed command evidence as passing");
    }
    return;
  }

  if (!isolated.failureReason) {
    throw new Error("isolated validator omitted the failure reason");
  }
  if (firstFailure === -1) {
    throw new Error("isolated validator marked all-zero command evidence as failing");
  }
  if (isolated.commands.length !== firstFailure + 1) {
    throw new Error("isolated validator continued after a failed command");
  }
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
  const sensitive = artifact.changedPaths.filter((path) => executionAffectingReason(path) !== null);
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
    let environmentIdentity: string | undefined;
    if (plan.isolation === "isolated") {
      const isolated = await input.isolatedValidator!();
      if (isolated.outputTreeSha !== outputTreeSha) {
        throw new Error(
          `isolated validator tree ${isolated.outputTreeSha} does not match host tree ${outputTreeSha}`,
        );
      }
      const expectedCommands = (await hasNpmLockfile(worktree))
        ? [NPM_VALIDATION_SETUP_COMMAND, ...plan.commands]
        : plan.commands;
      assertIsolatedValidationMatchesPlan(isolated, expectedCommands);
      commands.push(...isolated.commands);
      passed = isolated.passed;
      failureReason = isolated.failureReason;
      evidenceStartedAt = isolated.startedAt;
      evidenceCompletedAt = isolated.completedAt;
      environmentIdentity = isolated.environmentIdentity;
    } else {
      const localCommands = (await hasNpmLockfile(worktree))
        ? [
            {
              command: NPM_VALIDATION_SETUP_COMMAND,
              executable: "npm",
              args: ["ci", "--no-audit", "--no-fund"],
            },
          ]
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
          failureReason = validationFailureReason("validation setup", setup.command, result);
          break;
        }
      }
      for (const command of failureReason ? [] : plan.commands) {
        const result = await runContainedProcess({
          command: "/bin/sh",
          args: ["-c", command],
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
          failureReason = validationFailureReason("validation", command, result);
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
      ...(environmentIdentity ? { environmentIdentity } : {}),
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
