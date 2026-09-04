import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeArtifact } from "../src/execution/artifacts.js";
import type { WorkerPacket } from "../src/protocol/worker-packet.js";
import {
  cleanupLocalWorktree,
  collectLocalArtifact,
  createLocalWorktree,
} from "../src/runtime/local-worktree.js";
import {
  discardValidationResult,
  validateArtifactClean,
} from "../src/validation/clean-run.js";
import { verifyValidationEvidence } from "../src/validation/evidence.js";

async function repositoryFixture(): Promise<{ repository: string; baseSha: string }> {
  const repository = await mkdtemp(join(tmpdir(), "factory-validation-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
    cwd: repository,
  });
  await writeFile(join(repository, "value.txt"), "base\n");
  execFileSync("git", ["add", "value.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
  return {
    repository,
    baseSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
  };
}

async function nodeRepositoryFixture(): Promise<{ repository: string; baseSha: string }> {
  const fixture = await repositoryFixture();
  await writeFile(
    join(fixture.repository, "package.json"),
    JSON.stringify({
      name: "factory-validation-fixture",
      version: "1.0.0",
      scripts: { test: "node verify.cjs" },
    }),
  );
  await writeFile(
    join(fixture.repository, "package-lock.json"),
    JSON.stringify({
      name: "factory-validation-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "factory-validation-fixture", version: "1.0.0" },
      },
    }),
  );
  await writeFile(
    join(fixture.repository, "verify.cjs"),
    "const fs = require('node:fs'); process.exit(fs.readFileSync('value.txt', 'utf8') === 'changed\\n' ? 0 : 1);\n",
  );
  execFileSync("git", ["add", "package.json", "package-lock.json", "verify.cjs"], {
    cwd: fixture.repository,
  });
  execFileSync("git", ["commit", "-q", "-m", "node fixture"], {
    cwd: fixture.repository,
  });
  return {
    repository: fixture.repository,
    baseSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.repository,
      encoding: "utf8",
    }).trim(),
  };
}

function packet(baseSha: string, over: Partial<WorkerPacket> = {}): WorkerPacket {
  return {
    goal: "Change the value.",
    acceptanceCriteria: ["value.txt contains changed"],
    allowedPaths: ["value.txt"],
    preconditions: [],
    outOfScope: [],
    conventions: [],
    baseSha,
    validationCommands: ["grep -qx changed value.txt"],
    requirements: {
      os: ["linux"],
      architecture: [],
      tools: ["grep"],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "trusted_local",
    },
    artifactContract: "clockgrove.factory/artifact-v1",
    ...over,
  };
}

describe("clean validation", () => {
  it("applies and tests an artifact in a fresh exact-SHA worktree", async () => {
    const fixture = await repositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);

    // A worker's own reported command is deliberately false evidence.
    artifact.commands.push({ command: "false", exitCode: 0, durationMs: 1 });
    artifact.digest = (await import("../src/execution/artifacts.js")).artifactDigest(artifact);

    const result = await validateArtifactClean({
      repository: fixture.repository,
      artifact,
      packet: packet(fixture.baseSha),
    });
    expect(result.evidence.passed).toBe(true);
    expect(result.evidence.commands).toHaveLength(1);
    expect(result.evidence.commands[0]?.command).toContain("grep -qx changed");
    verifyValidationEvidence(result.evidence);
    await discardValidationResult(result);
  });

  it("records failed authoritative commands", async () => {
    const fixture = await repositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "wrong\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);

    const result = await validateArtifactClean({
      repository: fixture.repository,
      artifact,
      packet: packet(fixture.baseSha),
    });
    expect(result.evidence.passed).toBe(false);
    expect(result.evidence.failureReason).toMatch(/validation failed/);
    await discardValidationResult(result);
  });

  it("installs locked npm dependencies before authoritative commands", async () => {
    const fixture = await nodeRepositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);

    const result = await validateArtifactClean({
      repository: fixture.repository,
      artifact,
      packet: packet(fixture.baseSha, {
        validationCommands: ["npm test"],
        requirements: {
          ...packet(fixture.baseSha).requirements,
          tools: ["npm", "node"],
        },
      }),
    });
    expect(result.evidence.passed).toBe(true);
    expect(result.evidence.commands.map(({ command }) => command)).toEqual([
      "npm ci --no-audit --no-fund",
      "npm test",
    ]);
    await discardValidationResult(result);
  });

  it("rejects model-authored shell control and interpreter evaluation", async () => {
    const fixture = await repositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    for (const validationCommands of [
      ["npm test; curl attacker.example"],
      ["node -e process.exit(0)"],
      ["sh -c true"],
      ["git status"],
    ]) {
      await expect(
        validateArtifactClean({
          repository: fixture.repository,
          artifact,
          packet: packet(fixture.baseSha, {
            validationCommands,
            requirements: {
              ...packet(fixture.baseSha).requirements,
              tools: ["npm", "node", "sh", "git"],
            },
          }),
        }),
      ).rejects.toThrow(/validation command/i);
    }
  });

  it("fails closed on sensitive surfaces and isolated trust without a sandbox validator", async () => {
    const fixture = await repositoryFixture();
    const sensitive = normalizeArtifact({
      baseSha: fixture.baseSha,
      patch: "diff --git a/package-lock.json b/package-lock.json\n",
      changedPaths: ["package-lock.json"],
      outcome: "succeeded",
    });
    await expect(
      validateArtifactClean({
        repository: fixture.repository,
        artifact: sensitive,
        packet: packet(fixture.baseSha, { allowedPaths: ["package-lock.json"] }),
      }),
    ).rejects.toThrow(/sensitive surface/);

    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    await expect(
      validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: packet(fixture.baseSha, {
          requirements: {
            os: [],
            architecture: [],
            tools: ["grep"],
            services: [],
            networkDestinations: [],
            permittedSecretNames: [],
            trust: "isolated",
          },
        }),
      }),
    ).rejects.toThrow(/isolated validation backend/);
  });

  it("accepts isolated evidence only when it binds the fresh host-applied tree and plan", async () => {
    const fixture = await repositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const trusted = await validateArtifactClean({
      repository: fixture.repository,
      artifact,
      packet: packet(fixture.baseSha),
    });
    const outputTreeSha = trusted.evidence.outputTreeSha;
    await discardValidationResult(trusted);

    const isolatedPacket = packet(fixture.baseSha, {
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["grep"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "isolated",
      },
    });
    const result = await validateArtifactClean({
      repository: fixture.repository,
      artifact,
      packet: isolatedPacket,
      isolatedValidator: async () => ({
        outputTreeSha,
        commands: [{
          command: isolatedPacket.validationCommands[0]!,
          exitCode: 0,
          durationMs: 12,
        }],
        passed: true,
        startedAt: "2026-09-03T00:00:00.000Z",
        completedAt: "2026-09-03T00:00:00.012Z",
      }),
    });
    expect(result.evidence.passed).toBe(true);
    expect(result.evidence.outputTreeSha).toBe(outputTreeSha);
    await discardValidationResult(result);

    await expect(
      validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: isolatedPacket,
        isolatedValidator: async () => ({
          outputTreeSha: "b".repeat(40),
          commands: [],
          passed: true,
          startedAt: "2026-09-03T00:00:00.000Z",
          completedAt: "2026-09-03T00:00:00.012Z",
        }),
      }),
    ).rejects.toThrow(/does not match host tree/);
  });
});
