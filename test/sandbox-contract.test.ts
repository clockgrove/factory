import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_ISOLATED_VALIDATION_RESULT_BYTES,
  SANDBOX_CODEX_PACKAGE,
  parseIsolatedValidationResult,
  sandboxBootstrapFiles,
  sandboxResourceName,
  sandboxValidationFiles,
} from "../src/backends/sandbox-common.js";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import type { AttemptContext, IsolatedValidationContext } from "../src/execution/backend.js";
import { assertIsolatedValidationMatchesPlan } from "../src/validation/clean-run.js";
import { selectedManagedRuntimeRequirements } from "./helpers/managed-runtime.js";

const SHA = "a".repeat(40);

function context(): AttemptContext {
  return {
    repository: "clockgrove/factory",
    objective: 1,
    workItem: 2,
    attempt: 3,
    runId: "run-123",
    directorEpoch: 1,
    policyDigest: "b".repeat(64),
    workspace: "/not-shared",
    deadline: new Date("2026-09-03T01:00:00.000Z"),
    packet: {
      goal: "change one file",
      acceptanceCriteria: ["done"],
      allowedPaths: ["src/"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: SHA,
      validationCommands: ["npm test"],
      requirements: {
        os: ["linux"],
        architecture: ["x64"],
        tools: ["git", "node"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "isolated",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    },
  };
}

async function runUnmanagedIsolatedValidation(firstCommand: string) {
  const root = await mkdtemp(join(tmpdir(), "factory-sandbox-prefix-"));
  const source = join(root, "source");
  await mkdir(source);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source });
  execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: source });
  execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
    cwd: source,
  });
  await writeFile(join(source, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: source });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: source });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  const archive = execFileSync("git", ["archive", "HEAD"], { cwd: source });
  await writeFile(join(source, "tracked.txt"), "after\n");
  const patch = execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
    cwd: source,
    encoding: "utf8",
  });
  const marker = join(root, "later-command-ran");
  const laterCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)}`;
  const commands = [firstCommand, laterCommand];
  const base = context();
  base.packet.baseSha = baseSha;
  base.packet.allowedPaths = ["tracked.txt"];
  base.packet.validationCommands = commands;
  const files = sandboxValidationFiles(
    {
      ...base,
      artifact: normalizeArtifact({
        baseSha,
        patch,
        changedPaths: ["tracked.txt"],
        outcome: "succeeded",
      }),
    },
    archive,
  );
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
    if (file.mode !== undefined) await chmod(path, file.mode);
  }
  execFileSync(process.execPath, [join(root, "factory", "validate.mjs")], { cwd: root });
  return {
    commands,
    marker,
    result: parseIsolatedValidationResult(
      await readFile(join(root, "factory", "validation-result.json")),
    ),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

describe("sandbox bootstrap contracts", () => {
  it("derives distinct deterministic execution and validation resource names", () => {
    const execution = sandboxResourceName(context());
    const validation = sandboxResourceName(context(), "validation");
    expect(execution).toBe("factory-o1-w2-a3-run-123");
    expect(validation).toBe("factory-o1-w2-a3-run-123-validate");
    expect(
      sandboxResourceName({
        repository: "clockgrove/factory",
        objective: 1,
        workItem: 2,
        attempt: 3,
        runId: "run-123",
        directorEpoch: 1,
        phase: "validation",
      }),
    ).toBe(validation);
  });

  it("deeply validates and bounds isolated validation results", () => {
    const valid = {
      outputTreeSha: SHA,
      commands: [{ command: "npm test", exitCode: 0, durationMs: 12 }],
      passed: true,
      startedAt: "2026-09-03T00:00:00.000Z",
      completedAt: "2026-09-03T00:00:00.012Z",
    };
    expect(parseIsolatedValidationResult(Buffer.from(JSON.stringify(valid)))).toEqual(valid);
    expect(() =>
      parseIsolatedValidationResult(
        Buffer.from(
          JSON.stringify({ ...valid, commands: [{ ...valid.commands[0], exitCode: "0" }] }),
        ),
      ),
    ).toThrow(/malformed result/);
    expect(() =>
      parseIsolatedValidationResult(Buffer.alloc(MAX_ISOLATED_VALIDATION_RESULT_BYTES + 1, 0x20)),
    ).toThrow(/maximum size/);
  });

  it("rejects a provider claim that failed commands passed validation", () => {
    expect(() =>
      assertIsolatedValidationMatchesPlan(
        {
          outputTreeSha: SHA,
          commands: [{ command: "npm test", exitCode: 1, durationMs: 12 }],
          passed: true,
          startedAt: "2026-09-03T00:00:00.000Z",
          completedAt: "2026-09-03T00:00:00.012Z",
        },
        ["npm test"],
      ),
    ).toThrow(/failed command evidence as passing/);
  });

  it("pins the worker CLI and never embeds host credentials", () => {
    const rendered = sandboxBootstrapFiles(context(), Buffer.from("archive"))
      .map((file) => file.content.toString("utf8"))
      .join("\n");
    expect(rendered).toContain(SANDBOX_CODEX_PACKAGE);
    expect(rendered).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(rendered).toContain('web_search="disabled"');
    expect(rendered).toContain("git add --intent-to-add --all");
    expect(rendered).not.toContain("--approve-for-me");
    expect(rendered).not.toContain("ghp_");
    expect(rendered).not.toContain("GITHUB_TOKEN");
  });

  it("builds a validator without a model or GitHub credential", () => {
    const base = context();
    const validation: IsolatedValidationContext = {
      ...base,
      artifact: normalizeArtifact({
        baseSha: SHA,
        patch: "diff --git a/src/a.ts b/src/a.ts\n",
        changedPaths: ["src/a.ts"],
        outcome: "succeeded",
      }),
    };
    const rendered = sandboxValidationFiles(validation, Buffer.from("archive"))
      .map((file) => file.content.toString("utf8"))
      .join("\n");
    expect(rendered).toContain("npm ci --no-audit --no-fund");
    expect(rendered).toContain("package-lock.json");
    expect(rendered).toContain("npm test");
    expect(rendered).not.toContain("OPENAI_API_KEY");
    expect(rendered).not.toContain("GITHUB_TOKEN");
    expect(rendered).not.toContain("@openai/codex");
  });

  it("stops unmanaged isolated validation at the first failure", async () => {
    const run = await runUnmanagedIsolatedValidation("false");
    try {
      expect(run.result.commands).toEqual([
        expect.objectContaining({ command: "false", exitCode: 1 }),
      ]);
      expect(run.result.passed).toBe(false);
      expect(() => assertIsolatedValidationMatchesPlan(run.result, run.commands)).not.toThrow();
      await expect(access(run.marker)).rejects.toThrow();
    } finally {
      await run.dispose();
    }
  });

  it("runs the complete unmanaged validation plan when every command succeeds", async () => {
    const run = await runUnmanagedIsolatedValidation("true");
    try {
      expect(run.result.commands).toEqual([
        expect.objectContaining({ command: "true", exitCode: 0 }),
        expect.objectContaining({ command: run.commands[1], exitCode: 0 }),
      ]);
      expect(run.result.passed).toBe(true);
      expect(() => assertIsolatedValidationMatchesPlan(run.result, run.commands)).not.toThrow();
      await expect(access(run.marker)).resolves.toBeUndefined();
    } finally {
      await run.dispose();
    }
  });

  it("renders the exact version and offline setup gates for isolated bootstrap validation", () => {
    const base = context();
    base.packet.allowedPaths = ["package.json", "pnpm-lock.yaml"];
    base.packet.validationCommands = ["pnpm check"];
    base.packet.managedRuntimes = selectedManagedRuntimeRequirements(["pnpm check"]);
    base.packet.requirements.tools = ["node", "pnpm"];
    base.packet.requirements.networkDestinations = ["registry.npmjs.org"];
    const validation: IsolatedValidationContext = {
      ...base,
      artifact: normalizeArtifact({
        baseSha: SHA,
        patch: "diff --git a/package.json b/package.json\n",
        changedPaths: ["package.json", "pnpm-lock.yaml"],
        outcome: "succeeded",
      }),
    };
    const files = sandboxValidationFiles(validation, Buffer.from("archive"));
    const config = JSON.parse(
      files.find((file) => file.path === "factory/config.json")!.content.toString("utf8"),
    ) as {
      managedToolchain: { tool: string; assets: Array<{ path: string; sha256: string }> };
    };
    const rendered = files
      .filter((file) => !file.path.endsWith(".asset"))
      .map((file) => file.content.toString("utf8"))
      .join("\n");
    const managed = files.find((file) => file.path.endsWith("/pnpm.asset"));
    expect(managed?.content.byteLength).toBeGreaterThan(100);
    expect(config.managedToolchain.tool).toBe("pnpm");
    expect(config.managedToolchain.assets.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/node\.asset$/),
        expect.stringMatching(/\/pnpm\.asset$/),
      ]),
    );
    expect(config.managedToolchain.assets[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered).toContain("pnpm --version");
    expect(rendered).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/",
    );
    expect(rendered).toContain('"COREPACK_ENABLE_NETWORK":"0"');
    expect(rendered).toContain('"npm_config_verify_store_integrity":"true"');
    expect(rendered).toContain("spawnSync(executable.path, args");
    expect(rendered).not.toContain('spawnSync("pnpm"');
  });
});
