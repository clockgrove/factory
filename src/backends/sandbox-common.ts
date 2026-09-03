import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  AttemptContext,
  IsolatedValidationContext,
  IsolatedValidationResult,
  StaleAttemptIdentity,
} from "../execution/backend.js";
import {
  CODEX_WORKER_OUTPUT_SCHEMA,
  workerPacketPrompt,
} from "./codex-cli-local.js";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const SANDBOX_CODEX_PACKAGE = "@openai/codex@0.153.0";

export interface SandboxBootstrapFile {
  path: string;
  content: Buffer;
  mode?: number;
}

export function sandboxIdentity(context: AttemptContext | StaleAttemptIdentity): string {
  const raw = `factory-o${context.objective}-w${context.workItem}-a${context.attempt}-${context.runId.slice(0, 12)}`;
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 63);
}

export async function repositoryArchive(repository: string, baseSha: string): Promise<Buffer> {
  const path = join(
    tmpdir(),
    `clockgrove-factory-source-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tar`,
  );
  try {
    await execFileAsync(
      "git",
      ["archive", "--format=tar", "-o", path, baseSha],
      { cwd: repository, timeout: 120_000, maxBuffer: 256 * 1024 },
    );
    const archive = await readFile(path);
    if (archive.byteLength > MAX_SOURCE_ARCHIVE_BYTES) {
      throw new Error(`source archive exceeds ${MAX_SOURCE_ARCHIVE_BYTES} bytes`);
    }
    return archive;
  } finally {
    await rm(path, { force: true });
  }
}

export function sandboxBootstrapFiles(
  context: AttemptContext,
  archive: Buffer,
): SandboxBootstrapFile[] {
  const script = `#!/usr/bin/env bash
set -euo pipefail
factory_root="$PWD/factory"
workspace="$PWD/workspace"
mkdir -p "$workspace"
tar -xf "$factory_root/source.tar" -C "$workspace"
cd "$workspace"
git init -q
git config user.name clockgrove-factory
git config user.email factory@invalid.local
git add -A
git commit -qm factory-base
set +e
npx --yes ${SANDBOX_CODEX_PACKAGE} --dangerously-bypass-approvals-and-sandbox -c 'web_search="disabled"' exec --ephemeral --ignore-user-config --ignore-rules --json --output-schema "$factory_root/output.schema.json" -C "$workspace" - < "$factory_root/prompt.txt" > "$factory_root/worker.stdout" 2> "$factory_root/worker.stderr"
worker_status=$?
set -e
git diff --binary --no-ext-diff HEAD > "$factory_root/artifact.patch"
git diff --name-only -z HEAD > "$factory_root/changed-paths"
printf '%s' "$worker_status" > "$factory_root/exit-code"
`;
  return [
    { path: "factory/source.tar", content: archive },
    {
      path: "factory/output.schema.json",
      content: Buffer.from(JSON.stringify(CODEX_WORKER_OUTPUT_SCHEMA), "utf8"),
    },
    {
      path: "factory/prompt.txt",
      content: Buffer.from(workerPacketPrompt(context), "utf8"),
    },
    { path: "factory/run.sh", content: Buffer.from(script, "utf8"), mode: 0o700 },
  ];
}

export function sandboxValidationFiles(
  context: IsolatedValidationContext,
  archive: Buffer,
): SandboxBootstrapFile[] {
  const configuration = {
    expectedPaths: [...context.artifact.changedPaths].sort(),
    commands: context.packet.validationCommands,
    timeoutMsPerCommand: Math.min(
      (context.packet.requirements.timeoutMinutes ?? 30) * 60_000,
      60 * 60_000,
    ),
  };
  const validator = String.raw`import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL(".", import.meta.url).pathname;
const workspace = new URL("../workspace/", import.meta.url).pathname;
const config = JSON.parse(readFileSync(new URL("config.json", import.meta.url), "utf8"));
const startedAt = new Date().toISOString();
const commands = [];
const childEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/factory-home", CI: "true", FACTORY_SUPERVISED: "1" };

function git(args) {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8", maxBuffer: 1024 * 1024 });
}

try {
  mkdirSync(workspace, { recursive: true });
  mkdirSync("/tmp/factory-home", { recursive: true });
  execFileSync("tar", ["-xf", root + "source.tar", "-C", workspace]);
  git(["init", "-q"]);
  git(["config", "user.name", "clockgrove-factory"]);
  git(["config", "user.email", "factory@invalid.local"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "factory-base"]);
  git(["apply", "--index", "--binary", "--whitespace=error-all", root + "artifact.patch"]);
  const changed = Buffer.from(execFileSync("git", ["diff", "--cached", "--name-only", "-z"], { cwd: workspace }))
    .toString("utf8").split("\0").filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify(config.expectedPaths)) {
    throw new Error("applied artifact paths do not match its manifest");
  }
  let failureReason;
  if (existsSync(workspace + "package-lock.json") || existsSync(workspace + "npm-shrinkwrap.json")) {
    const command = "npm ci --no-audit --no-fund";
    const began = Date.now();
    const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: workspace,
      timeout: config.timeoutMsPerCommand,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: childEnv,
    });
    const exitCode = install.status ?? (install.error?.code === "ETIMEDOUT" ? 124 : 1);
    commands.push({ command, exitCode, durationMs: Date.now() - began });
    if (exitCode !== 0) {
      failureReason = exitCode === 124 ? "validation setup timed out: " + command : "validation setup failed (" + exitCode + "): " + command;
    }
  }
  for (const command of failureReason ? [] : config.commands) {
    const began = Date.now();
    const result = spawnSync("/bin/sh", ["-lc", command], {
      cwd: workspace,
      timeout: config.timeoutMsPerCommand,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: childEnv,
    });
    const exitCode = result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1);
    commands.push({ command, exitCode, durationMs: Date.now() - began });
    if (exitCode !== 0) {
      failureReason = exitCode === 124 ? "validation timed out: " + command : "validation failed (" + exitCode + "): " + command;
      break;
    }
  }
  const result = {
    outputTreeSha: git(["write-tree"]).trim(), commands,
    passed: failureReason === undefined, ...(failureReason ? { failureReason } : {}),
    startedAt, completedAt: new Date().toISOString(),
  };
  writeFileSync(new URL("validation-result.json", import.meta.url), JSON.stringify(result));
} catch (error) {
  writeFileSync(new URL("validation-error.txt", import.meta.url), error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
`;
  return [
    { path: "factory/source.tar", content: archive },
    { path: "factory/artifact.patch", content: Buffer.from(context.artifact.patch, "utf8") },
    {
      path: "factory/config.json",
      content: Buffer.from(JSON.stringify(configuration), "utf8"),
    },
    { path: "factory/validate.mjs", content: Buffer.from(validator, "utf8"), mode: 0o700 },
  ];
}

export function parseIsolatedValidationResult(buffer: Buffer): IsolatedValidationResult {
  const value = JSON.parse(buffer.toString("utf8")) as IsolatedValidationResult;
  if (
    !/^[0-9a-f]{40}$/.test(value.outputTreeSha) ||
    !Array.isArray(value.commands) ||
    typeof value.passed !== "boolean" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.completedAt))
  ) {
    throw new Error("isolated validator returned a malformed result");
  }
  return value;
}

export function parseSandboxPaths(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}
