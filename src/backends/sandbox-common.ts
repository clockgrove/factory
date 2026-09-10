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
import { isolatedManagedToolchainPlan } from "../toolchains/authority.js";
import type {
  ManagedToolchainPlan,
  RuntimeBundleRequirement,
} from "../runtime/toolchain-bundle.js";
import { CODEX_WORKER_OUTPUT_SCHEMA, workerPacketPrompt } from "./codex-cli-local.js";
import { validationInvocationOwnership } from "./validation-invocation.js";

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

function managedConfiguration(plan: ManagedToolchainPlan) {
  return {
    tool: plan.tool,
    bundleDigest: plan.bundleDigest,
    assets: plan.assets.map(({ content: _content, ...asset }) => asset),
    executables: plan.executables,
    setup: plan.setup,
    validation: plan.validation,
    environment: plan.environment,
  };
}

function packetRuntimeRequirements(packet: AttemptContext["packet"]): RuntimeBundleRequirement[] {
  return packet.managedRuntimes ?? [];
}

function managedAssetFiles(plan: ManagedToolchainPlan): SandboxBootstrapFile[] {
  return plan.assets.map((asset) => ({
    path: `factory/${asset.path}`,
    content: asset.content,
    mode: 0o400,
  }));
}

export function sandboxManagedToolchainFiles(plan: ManagedToolchainPlan): SandboxBootstrapFile[] {
  return [
    {
      path: "factory/managed-toolchain.json",
      content: Buffer.from(JSON.stringify(managedConfiguration(plan)), "utf8"),
    },
    {
      path: "factory/materialize-toolchain.mjs",
      content: Buffer.from(MANAGED_TOOLCHAIN_MATERIALIZER, "utf8"),
      mode: 0o500,
    },
    ...managedAssetFiles(plan),
  ];
}

const MANAGED_TOOLCHAIN_MATERIALIZER = String.raw`import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const configPath = resolve(process.argv[2]);
const outputPath = resolve(process.argv[3]);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const factoryRoot = dirname(configPath);
const runtimeRoot = "/tmp/factory-toolchain/runtime";
const binRoot = "/tmp/factory-toolchain/bin";
const safeRelative = value => typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== "..");
const safeChild = (root, relative) => {
  if (!safeRelative(relative)) throw new Error("managed runtime path is unsafe");
  const target = resolve(root, relative);
  if (!target.startsWith(resolve(root) + "/")) throw new Error("managed runtime path escaped its root");
  return target;
};
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const validateListing = (listing, executablePath) => {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > 100000) throw new Error("managed runtime archive has an invalid entry count");
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    if (normalized && !safeRelative(normalized)) throw new Error("managed runtime archive contains an unsafe path");
  }
  if (!entries.some(entry => entry.replace(/\/$/, "") === executablePath)) throw new Error("managed runtime archive lacks its declared executable");
};
const assertRegularTree = root => {
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        const target = resolve(directory, link);
        if (link.startsWith("/") || (target !== resolve(root) && !target.startsWith(resolve(root) + "/"))) throw new Error("managed runtime archive contains an escaping symbolic link");
      } else if (stat.isDirectory()) visit(path);
      else if (!stat.isFile()) throw new Error("managed runtime archive contains an unsupported entry");
    }
  };
  visit(root);
};

mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
mkdirSync(binRoot, { recursive: true, mode: 0o700 });
const assetExecutables = new Map();
for (const asset of config.assets) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(asset.id) || !safeRelative(asset.path) || !safeRelative(asset.executablePath)) throw new Error("managed runtime asset metadata is invalid");
  const archive = safeChild(factoryRoot, asset.path);
  if (digest(archive) !== asset.sha256) throw new Error("managed runtime archive digest mismatch");
  const target = safeChild(runtimeRoot, asset.id);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (asset.archive === "raw") {
    if (asset.executablePath.includes("/")) throw new Error("raw managed runtime executable must be top-level");
    copyFileSync(archive, safeChild(target, asset.executablePath));
  } else if (asset.archive === "tar.gz" || asset.archive === "tar.xz") {
    const compression = asset.archive === "tar.gz" ? "z" : "J";
    const listing = execFileSync("tar", ["-t" + compression + "f", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    validateListing(listing, asset.executablePath);
    execFileSync("tar", ["-x" + compression + "f", archive, "-C", target, "--no-same-owner", "--no-same-permissions", ...(asset.executableOnly ? [asset.executablePath] : [])], { maxBuffer: 1024 * 1024 });
  } else if (asset.archive === "zip") {
    const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    validateListing(listing, asset.executablePath);
    execFileSync("unzip", ["-q", archive, "-d", target], { maxBuffer: 1024 * 1024 });
  } else throw new Error("managed runtime archive format is unsupported");
  assertRegularTree(target);
  const executable = safeChild(target, asset.executablePath);
  if (!statSync(executable).isFile() || digest(executable) !== asset.executableSha256) throw new Error("managed runtime executable digest mismatch");
  chmodSync(executable, 0o700);
  assetExecutables.set(asset.id, executable);
}

const executables = {};
for (const executable of config.executables) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(executable.id) || !Array.isArray(executable.argsPrefix)) throw new Error("managed executable metadata is invalid");
  if (executable.kind === "generated") {
    const path = resolve(executable.relativePath);
    if (!path.startsWith("/tmp/factory-toolchain/")) throw new Error("generated executable escaped the private runtime root");
    executables[executable.id] = { path, argsPrefix: executable.argsPrefix, generated: true };
    continue;
  }
  const assetPath = assetExecutables.get(executable.assetId);
  if (!assetPath) throw new Error("managed executable names a missing asset");
  executables[executable.id] = executable.kind === "node"
    ? { path: process.execPath, argsPrefix: [assetPath, ...executable.argsPrefix], generated: false }
    : { path: assetPath, argsPrefix: executable.argsPrefix, generated: false };
  const shim = safeChild(binRoot, executable.id);
  try { symlinkSync(assetPath, shim); } catch (error) { if (error?.code !== "EEXIST") throw error; }
}
writeFileSync(outputPath, JSON.stringify({ binRoot, executables }), { mode: 0o600 });
`;

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
  if ("validationInvocation" in context && context.validationInvocation) {
    if (phase !== "validation") throw new Error("validation invocation cannot identify execution");
    const owner = validationInvocationOwnership(
      context as IsolatedValidationContext | StaleAttemptIdentity,
    )!;
    return `factory-candidate-${owner.slice(0, 45)}`;
  }
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
  options: { managedToolchains?: boolean } = {},
): SandboxBootstrapFile[] {
  const managedToolchain = options.managedToolchains
    ? isolatedManagedToolchainPlan(
        context.packet.validationCommands,
        packetRuntimeRequirements(context.packet),
      )
    : null;
  const managedEnvironment = managedToolchain
    ? Object.entries(managedToolchain.environment)
        .map(([key, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error("managed toolchain environment contains an invalid key");
          return `export ${key}=${JSON.stringify(value)}`;
        })
        .join("\n")
    : "";
  const managedBootstrap = managedToolchain
    ? String.raw`mkdir -p /tmp/factory-toolchain-config
node "$factory_root/materialize-toolchain.mjs" "$factory_root/managed-toolchain.json" "$factory_root/toolchain-paths.json"
export PATH="/tmp/factory-toolchain/bin:$PATH"
${managedEnvironment}
export PATH="/tmp/factory-toolchain/bin:$PATH"
`
    : "";
  const script = `#!/usr/bin/env bash
set -euo pipefail
factory_root="$PWD/factory"
workspace="$PWD/workspace"
${managedBootstrap}mkdir -p "$workspace"
tar -xf "$factory_root/source.tar" -C "$workspace"
cd "$workspace"
git init -q
git config user.name clockgrove-factory
git config user.email factory@invalid.local
git add --force --all
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
node --input-type=module - "$factory_root/artifact.patch" <<'FACTORY_PATCH_CAPTURE'
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const child = spawn('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], {stdio:['ignore','pipe','inherit']});
const outcome = new Promise(resolve => { child.once('error', resolve); child.once('close', code => resolve(code === 0 ? null : new Error('artifact diff failed'))); });
let bytes = 0;
try {
  await pipeline(child.stdout, new Transform({transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > 268435456 ? new Error('artifact patch exceeds 256 MiB') : null, chunk);
  }}), createWriteStream(process.argv[2], {flags:'wx',mode:0o600}));
  const error = await outcome; if (error) throw error;
} catch (error) { child.kill('SIGKILL'); await outcome; throw error; }
FACTORY_PATCH_CAPTURE
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
    ...(managedToolchain ? sandboxManagedToolchainFiles(managedToolchain.plan) : []),
    { path: "factory/run.sh", content: Buffer.from(script, "utf8"), mode: 0o700 },
  ];
}

export function sandboxValidationFiles(
  context: IsolatedValidationContext,
  archive: Buffer,
  options: { externalizedPatchUpload?: boolean } = {},
): SandboxBootstrapFile[] {
  if (context.artifact.payload && !options.externalizedPatchUpload)
    throw new Error(
      "externalized artifact requires a verified file upload; a payload marker is not a patch",
    );
  const managedToolchain = isolatedManagedToolchainPlan(
    context.packet.validationCommands,
    packetRuntimeRequirements(context.packet),
  );
  const configuration = {
    expectedPaths: [...context.artifact.changedPaths].sort(),
    commands: context.packet.validationCommands,
    managedToolchain: managedToolchain ? managedConfiguration(managedToolchain.plan) : null,
    timeoutMsPerCommand: Math.min(
      (context.packet.requirements.timeoutMinutes ?? 30) * 60_000,
      60 * 60_000,
    ),
  };
  const validator = String.raw`import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const workspace = new URL("../workspace/", import.meta.url).pathname;
const config = JSON.parse(readFileSync(new URL("config.json", import.meta.url), "utf8"));
if (config.managedToolchain) execFileSync(process.execPath, [
  new URL("materialize-toolchain.mjs", import.meta.url).pathname,
  new URL("managed-toolchain.json", import.meta.url).pathname,
  new URL("toolchain-paths.json", import.meta.url).pathname,
]);
const managedPaths = config.managedToolchain
  ? JSON.parse(readFileSync(new URL("toolchain-paths.json", import.meta.url), "utf8"))
  : null;
const startedAt = new Date().toISOString();
const commands = [];
const childEnv = {
  HOME: "/tmp/factory-home",
  CI: "true",
  FACTORY_SUPERVISED: "1",
  ...(config.managedToolchain?.environment ?? {}),
  PATH: managedPaths
    ? managedPaths.binRoot + ":" + (config.managedToolchain.environment.PATH ?? "/usr/bin:/bin")
    : process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
};

function git(args) {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8", maxBuffer: 1024 * 1024 });
}

function stepCwd(step) {
  if (!step.cwd) return workspace;
  if (typeof step.cwd !== "string" || step.cwd.startsWith("/") || step.cwd.includes("\\") || step.cwd.split("/").some(part => !part || part === "." || part === "..")) throw new Error("managed command cwd is unsafe");
  const target = resolve(workspace, step.cwd);
  if (!target.startsWith(resolve(workspace) + "/")) throw new Error("managed command cwd escaped the workspace");
  return target;
}

function executeManagedStep(step, setup) {
  const executable = managedPaths.executables[step.executableId];
  if (!executable) throw new Error("managed command names an unknown executable");
  if (!Array.isArray(step.args) || step.args.some(arg => typeof arg !== "string")) throw new Error("managed command argv is invalid");
  if (executable.generated && (!existsSync(executable.path) || !lstatSync(executable.path).isFile())) throw new Error("generated managed executable is missing");
  const python = managedPaths.executables.python?.path;
  const args = [...executable.argsPrefix, ...step.args.map(arg => arg === "__FACTORY_PYTHON__" ? python : arg)];
  if (args.some(arg => typeof arg !== "string")) throw new Error("managed command requires an unavailable Python executable");
  const began = Date.now();
  const result = spawnSync(executable.path, args, {
    cwd: stepCwd(step), timeout: config.timeoutMsPerCommand, encoding: "utf8",
    maxBuffer: 1024 * 1024, env: childEnv,
  });
  let exitCode = result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1);
  if (exitCode === 0 && step.expectedStdout !== undefined && result.stdout.trim() !== step.expectedStdout) exitCode = 1;
  commands.push({ command: step.display, exitCode, durationMs: Date.now() - began });
  return exitCode === 0 ? undefined : exitCode === 124
    ? (setup ? "validation setup timed out: " : "validation timed out: ") + step.display
    : (setup ? "validation setup failed (" : "validation failed (") + exitCode + "): " + step.display;
}

try {
  mkdirSync(workspace, { recursive: true });
  mkdirSync("/tmp/factory-home", { recursive: true });
  if (config.managedToolchain) mkdirSync("/tmp/factory-toolchain-config", { recursive: true });
  execFileSync("tar", ["-xf", root + "source.tar", "-C", workspace]);
  git(["init", "-q"]);
  git(["config", "user.name", "clockgrove-factory"]);
  git(["config", "user.email", "factory@invalid.local"]);
  git(["add", "--force", "--all"]);
  git(["commit", "-qm", "factory-base"]);
  git(["apply", "--index", "--binary", "--whitespace=error-all", root + "artifact.patch"]);
  const changed = Buffer.from(execFileSync("git", ["diff", "--cached", "--name-only", "-z"], { cwd: workspace }))
    .toString("utf8").split("\0").filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify(config.expectedPaths)) {
    throw new Error("applied artifact paths do not match its manifest");
  }
  let failureReason;
  if (config.managedToolchain) {
    for (const setup of config.managedToolchain.setup) {
      failureReason = executeManagedStep(setup, true);
      if (failureReason) break;
    }
  } else if (existsSync(workspace + "package-lock.json") || existsSync(workspace + "npm-shrinkwrap.json")) {
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
  for (const command of failureReason ? [] : config.managedToolchain?.validation ?? config.commands) {
    if (config.managedToolchain) {
      failureReason = executeManagedStep(command, false);
      if (failureReason) break;
      continue;
    }
    const began = Date.now();
    const result = spawnSync("/bin/sh", ["-c", command], { cwd: workspace, timeout: config.timeoutMsPerCommand, encoding: "utf8", maxBuffer: 1024 * 1024, env: childEnv });
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
    ...(options.externalizedPatchUpload
      ? []
      : [{ path: "factory/artifact.patch", content: Buffer.from(context.artifact.patch, "utf8") }]),
    {
      path: "factory/config.json",
      content: Buffer.from(JSON.stringify(configuration), "utf8"),
    },
    ...(managedToolchain ? sandboxManagedToolchainFiles(managedToolchain.plan) : []),
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
