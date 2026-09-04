import { execFile } from "node:child_process";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type {
  AttemptContext,
  IsolatedValidationContext,
  IsolatedValidationResult,
  StaleAttemptIdentity,
} from "../execution/backend.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import { NPM_VALIDATION_SETUP_COMMAND } from "../validation/plan.js";
import { CODEX_WORKER_OUTPUT_SCHEMA, workerPacketPrompt } from "./codex-cli-local.js";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ISOLATED_VALIDATION_RESULT_BYTES = 64 * 1024;
export const SANDBOX_CODEX_PACKAGE = "@openai/codex@0.153.0";

const IsolatedValidationResultSchema = z
  .object({
    outputTreeSha: z.string().regex(/^[0-9a-f]{40}$/),
    commands: z
      .array(
        z
          .object({
            command: z.string().min(1).max(1_000),
            exitCode: z.number().int().min(0).max(255),
            durationMs: z
              .number()
              .int()
              .nonnegative()
              .max(24 * 60 * 60 * 1_000),
          })
          .strict(),
      )
      .max(128),
    passed: z.boolean(),
    failureReason: z.string().min(1).max(8_000).optional(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    environmentIdentity: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt must not precede startedAt",
      });
    }
    const hasFailedCommand = value.commands.some(({ exitCode }) => exitCode !== 0);
    if (value.passed && (hasFailedCommand || value.failureReason !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passed"],
        message: "passing evidence must contain only successful commands and no failure reason",
      });
    }
    if (!value.passed && (!hasFailedCommand || value.failureReason === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passed"],
        message: "failing evidence must identify a failed command and a failure reason",
      });
    }
  });

export interface SandboxBootstrapFile {
  path: string;
  content: Buffer;
  mode?: number;
}

export function sandboxIdentity(context: AttemptContext | StaleAttemptIdentity): string {
  const raw = `factory-o${context.objective}-w${context.workItem}-a${context.attempt}-${context.runId.slice(0, 12)}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 63);
}

export function sandboxResourceName(
  context: AttemptContext | StaleAttemptIdentity,
  phase: "execution" | "validation" = "phase" in context
    ? (context.phase ?? "execution")
    : "execution",
): string {
  const identity = sandboxIdentity(context);
  return phase === "validation" ? `${identity.slice(0, 54)}-validate` : identity;
}

export async function repositoryArchive(repository: string, baseSha: string): Promise<Buffer> {
  const path = join(
    tmpdir(),
    `clockgrove-factory-source-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tar`,
  );
  try {
    await execFileAsync("git", ["archive", "--format=tar", "-o", path, baseSha], {
      cwd: repository,
      timeout: 120_000,
      maxBuffer: 256 * 1024,
    });
    const file = await open(path, "r");
    try {
      const before = await file.stat();
      if (before.size > MAX_SOURCE_ARCHIVE_BYTES) {
        throw new Error(`source archive exceeds ${MAX_SOURCE_ARCHIVE_BYTES} bytes`);
      }
      const archive = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < archive.byteLength) {
        const { bytesRead } = await file.read(archive, offset, archive.byteLength - offset, offset);
        if (bytesRead === 0) throw new Error("source archive was truncated while reading");
        offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== before.size) {
        throw new Error("source archive changed while reading");
      }
      return archive;
    } finally {
      await file.close();
    }
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
model_args=()
if [[ -f "$factory_root/model.txt" ]]; then
  model_args+=(--model "$(<"$factory_root/model.txt")")
fi
if [[ -f "$factory_root/reasoning-config.txt" ]]; then
  model_args+=(-c "$(<"$factory_root/reasoning-config.txt")")
fi
set +e
npx --yes ${SANDBOX_CODEX_PACKAGE} --dangerously-bypass-approvals-and-sandbox -c 'web_search="disabled"' exec --ephemeral --ignore-user-config --ignore-rules --json --output-schema "$factory_root/output.schema.json" -C "$workspace" "\${model_args[@]}" - < "$factory_root/prompt.txt" > "$factory_root/worker.stdout" 2> "$factory_root/worker.stderr"
worker_status=$?
set -e
git add --intent-to-add --all
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
    ...(context.modelSelection
      ? [
          {
            path: "factory/model.txt",
            content: Buffer.from(context.modelSelection.model, "utf8"),
          },
          {
            path: "factory/reasoning-config.txt",
            content: Buffer.from(
              `model_reasoning_effort=${JSON.stringify(context.modelSelection.reasoning)}`,
              "utf8",
            ),
          },
        ]
      : []),
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
    const command = ${JSON.stringify(NPM_VALIDATION_SETUP_COMMAND)};
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
    const result = spawnSync("/bin/sh", ["-c", command], {
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
  if (buffer.byteLength > MAX_ISOLATED_VALIDATION_RESULT_BYTES) {
    throw new Error("isolated validator result exceeds the maximum size");
  }
  let parsed: z.infer<typeof IsolatedValidationResultSchema>;
  try {
    parsed = IsolatedValidationResultSchema.parse(JSON.parse(buffer.toString("utf8")) as unknown);
  } catch {
    throw new Error("isolated validator returned a malformed result");
  }
  const value: IsolatedValidationResult = {
    outputTreeSha: parsed.outputTreeSha,
    commands: parsed.commands,
    passed: parsed.passed,
    ...(parsed.failureReason !== undefined ? { failureReason: parsed.failureReason } : {}),
    startedAt: parsed.startedAt,
    completedAt: parsed.completedAt,
    ...(parsed.environmentIdentity !== undefined
      ? { environmentIdentity: parsed.environmentIdentity }
      : {}),
  };
  assertNoSecretMaterial(value, "isolated validator result");
  return value;
}

export function parseSandboxPaths(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}
