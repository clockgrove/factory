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
import { MANAGED_SYSTEM_TOOLS } from "../runtime/system-tools.js";
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
import { dirname, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

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
const canonical = value => Array.isArray(value)
  ? "[" + value.map(canonical).join(",") + "]"
  : value !== null && typeof value === "object"
    ? "{" + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
    : JSON.stringify(value);
const treeDigest = root => {
  const absoluteRoot = resolve(root);
  const entries = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      const name = relative(absoluteRoot, path).split(sep).join("/");
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        const target = resolve(directory, link);
        if (link.startsWith("/") || (target !== absoluteRoot && !target.startsWith(absoluteRoot + "/"))) throw new Error("managed runtime tree contains an escaping symbolic link");
        entries.push({ path: name, link });
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) entries.push({ path: name, sha256: digest(path) });
      else throw new Error("managed runtime tree contains an unsupported entry");
    }
  };
  visit(absoluteRoot);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return createHash("sha256").update(Buffer.from(canonical(entries), "utf8")).digest("hex");
};
const validateListing = (listing, requiredPaths) => {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > 100000) throw new Error("managed runtime archive has an invalid entry count");
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    if (normalized && !safeRelative(normalized)) throw new Error("managed runtime archive contains an unsafe path");
  }
  for (const requiredPath of requiredPaths) if (!entries.some(entry => entry.replace(/\/$/, "") === requiredPath)) throw new Error("managed runtime archive lacks a declared entrypoint");
};
const zipCrc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const zipEntries = archive => {
  let eocd = -1;
  const minimum = Math.max(0, archive.length - 65557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("ZIP archive lacks a valid central directory");
  const count = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0 || archive.readUInt16LE(eocd + 8) !== count) throw new Error("multi-disk ZIP archives are unsupported");
  if (count === 0 || count === 0xffff || count > 100000 || centralOffset + centralSize > eocd) throw new Error("ZIP archive central directory is invalid");
  const entries = [];
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP central directory is malformed");
    const madeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const crc32 = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const external = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length || (flags & 1) !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || (compression !== 0 && compression !== 8)) throw new Error("ZIP entry metadata is unsupported");
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const name = rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
    if (!safeRelative(name) || name.includes("\0")) throw new Error("ZIP archive contains an unsafe path");
    const unixType = (external >>> 16) & 0o170000;
    const directory = rawName.endsWith("/") || (external & 0x10) !== 0 || unixType === 0o040000;
    if ((madeBy >>> 8) === 3 && unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000) throw new Error("ZIP archive contains a symbolic link or special file");
    total += uncompressedSize;
    if (total > 512 * 1024 * 1024) throw new Error("ZIP archive expands beyond the supported bound");
    entries.push({ name, flags, compression, crc32, compressedSize, uncompressedSize, localOffset, directory });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new Error("ZIP central directory size is inconsistent");
  return entries;
};
const extractZip = (archivePath, target, executablePath) => {
  const archive = readFileSync(archivePath);
  const entries = zipEntries(archive);
  if (!entries.some(entry => !entry.directory && entry.name === executablePath)) throw new Error("managed runtime archive lacks its declared executable");
  for (const entry of entries) {
    const destination = safeChild(target, entry.name);
    if (entry.directory) { mkdirSync(destination, { recursive: true, mode: 0o700 }); continue; }
    const offset = entry.localOffset;
    if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw new Error("ZIP local header is malformed");
    const flags = archive.readUInt16LE(offset + 6);
    const compression = archive.readUInt16LE(offset + 8);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    const localName = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8").replace(/\/$/, "");
    if (dataEnd > archive.length || flags !== entry.flags || compression !== entry.compression || localName !== entry.name) throw new Error("ZIP local metadata is inconsistent");
    const compressed = archive.subarray(dataOffset, dataEnd);
    const bytes = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
    if (bytes.length !== entry.uncompressedSize || zipCrc32(bytes) !== entry.crc32) throw new Error("ZIP entry failed size or CRC verification");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" });
  }
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
const assetEntrypoints = new Map();
for (const asset of config.assets) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(asset.id) || !safeRelative(asset.path) || !safeRelative(asset.executablePath) || !/^[a-f0-9]{64}$/.test(asset.treeSha256)) throw new Error("managed runtime asset metadata is invalid");
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
    validateListing(listing, (asset.entrypoints ?? [{ path: asset.executablePath }]).map(entrypoint => entrypoint.path));
    execFileSync("tar", ["-x" + compression + "f", archive, "-C", target, "--no-same-owner", "--no-same-permissions", ...(asset.executableOnly ? [asset.executablePath] : [])], { maxBuffer: 1024 * 1024 });
  } else if (asset.archive === "zip") {
    extractZip(archive, target, asset.executablePath);
  } else throw new Error("managed runtime archive format is unsupported");
  assertRegularTree(target);
  const executable = safeChild(target, asset.executablePath);
  if (!statSync(executable).isFile() || digest(executable) !== asset.executableSha256) throw new Error("managed runtime executable digest mismatch");
  const declaredEntrypoints = asset.entrypoints ?? [{ id: asset.id, version: "0.0.0", path: asset.executablePath, sha256: asset.executableSha256 }];
  if (declaredEntrypoints.length === 0 || new Set(declaredEntrypoints.map(entrypoint => entrypoint.id)).size !== declaredEntrypoints.length) throw new Error("managed runtime entrypoint metadata is invalid");
  const verifiedEntrypoints = new Map();
  for (const entrypoint of declaredEntrypoints) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entrypoint.id) || !safeRelative(entrypoint.path) || !/^[a-f0-9]{64}$/.test(entrypoint.sha256) || (entrypoint.interpreter !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entrypoint.interpreter))) throw new Error("managed runtime entrypoint metadata is invalid");
    const relativePath = entrypoint.path;
    const path = safeChild(target, relativePath);
    if (!statSync(path).isFile() || digest(path) !== entrypoint.sha256) throw new Error("managed runtime entrypoint digest mismatch");
    if (entrypoint.interpreter === undefined) chmodSync(path, 0o700);
    verifiedEntrypoints.set(entrypoint.id, { ...entrypoint, path, relativePath, componentId: asset.id });
  }
  if (treeDigest(target) !== asset.treeSha256) throw new Error("managed runtime tree digest mismatch");
  assetEntrypoints.set(asset.id, verifiedEntrypoints);
}
for (const entrypoints of assetEntrypoints.values()) {
  for (const entrypoint of entrypoints.values()) {
    if (entrypoint.interpreter === undefined) continue;
    const interpreter = entrypoints.get(entrypoint.interpreter);
    if (!interpreter || interpreter.interpreter !== undefined) throw new Error("managed runtime interpreter relation is invalid");
  }
}

const executables = {};
const executableDefinitions = new Map(config.executables.map(executable => [executable.id, executable]));
if (executableDefinitions.size !== config.executables.length) throw new Error("managed executable identity is duplicate");
const resolving = new Set();
const resolveExecutable = id => {
  if (executables[id]) return executables[id];
  const executable = executableDefinitions.get(id);
  if (!executable || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(executable.id) || !Array.isArray(executable.argsPrefix) || executable.argsPrefix.some(arg => typeof arg !== "string")) throw new Error("managed executable metadata is invalid");
  if (resolving.has(id)) throw new Error("managed executable interpreter relation is cyclic");
  resolving.add(id);
  if (executable.kind === "generated") {
    const path = resolve(executable.relativePath);
    if (!path.startsWith("/tmp/factory-toolchain/")) throw new Error("generated executable escaped the private runtime root");
    if (typeof executable.generatedFrom !== "string") throw new Error("generated executable lacks its verified source");
    executables[executable.id] = { path, argsPrefix: executable.argsPrefix, generated: true, generatedFrom: executable.generatedFrom };
    resolving.delete(id);
    return executables[id];
  }
  const assetEntries = assetEntrypoints.get(executable.assetId);
  const matches = assetEntries ? [...assetEntries.values()].filter(entrypoint => executable.entrypointId ? entrypoint.id === executable.entrypointId : entrypoint.relativePath === executable.relativePath) : [];
  const entrypoint = matches.length === 1 ? matches[0] : undefined;
  if (!entrypoint || executable.relativePath !== entrypoint.relativePath) throw new Error("managed executable differs from its verified entrypoint");
  if (executable.kind === "native") {
    if (entrypoint.interpreter !== undefined || executable.interpreterId !== undefined) throw new Error("managed native executable has an invalid entrypoint relation");
    executables[id] = { path: entrypoint.path, argsPrefix: executable.argsPrefix, generated: false, componentId: entrypoint.componentId, entrypointId: entrypoint.id };
    const shim = safeChild(binRoot, executable.id);
    try { symlinkSync(entrypoint.path, shim); } catch (error) { if (error?.code !== "EEXIST") throw error; }
  } else if (executable.kind === "interpreted") {
    if (entrypoint.interpreter === undefined || typeof executable.interpreterId !== "string") throw new Error("managed interpreted executable lacks its verified interpreter");
    const interpreter = resolveExecutable(executable.interpreterId);
    if (interpreter.generated || entrypoint.componentId !== interpreter.componentId || entrypoint.interpreter !== interpreter.entrypointId) throw new Error("managed interpreted executable differs from its attested interpreter");
    executables[id] = { path: interpreter.path, argsPrefix: [...interpreter.argsPrefix, entrypoint.path, ...executable.argsPrefix], generated: false, componentId: entrypoint.componentId, entrypointId: entrypoint.id };
    const shim = safeChild(binRoot, executable.id);
    const launcher = "#!/bin/sh\nexec " + JSON.stringify(interpreter.path) + " " + JSON.stringify(entrypoint.path) + " \"$@\"\n";
    writeFileSync(shim, launcher, { mode: 0o700, flag: "wx" });
  } else throw new Error("managed executable kind requires an ambient interpreter and is unsupported");
  resolving.delete(id);
  return executables[id];
};
for (const executable of config.executables) resolveExecutable(executable.id);
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
    ? String.raw`factory_system_tools="/tmp/factory-system-tools"
mkdir -p "$factory_system_tools"
for factory_system_tool in ${MANAGED_SYSTEM_TOOLS.join(" ")}; do
  factory_system_tool_path="$(PATH="$factory_bootstrap_path" command -v "$factory_system_tool" || true)"
  if [[ "$factory_system_tool_path" == /* && -x "$factory_system_tool_path" ]]; then
    ln -s "$factory_system_tool_path" "$factory_system_tools/$factory_system_tool"
  fi
done
mkdir -p /tmp/factory-toolchain-config
node "$factory_root/materialize-toolchain.mjs" "$factory_root/managed-toolchain.json" "$factory_root/toolchain-paths.json"
export PATH="/tmp/factory-toolchain/bin:$factory_system_tools"
${managedEnvironment}
export PATH="/tmp/factory-toolchain/bin:$factory_system_tools"
`
    : "";
  const script = `#!/usr/bin/env bash
set -euo pipefail
factory_root="$PWD/factory"
workspace="$PWD/workspace"
factory_bootstrap_path="$PATH"
factory_bootstrap_npx="$(command -v npx)"
if [[ "$factory_bootstrap_npx" != /* || ! -x "$factory_bootstrap_npx" ]]; then
  printf 'Factory could not resolve the sandbox bootstrap npx executable\n' >&2
  exit 1
fi
${managedBootstrap}factory_worker_path="$PATH"
export PATH="$factory_bootstrap_path"
mkdir -p "$workspace"
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
PATH="$factory_worker_path" "$factory_bootstrap_npx" --yes ${SANDBOX_CODEX_PACKAGE} --dangerously-bypass-approvals-and-sandbox -c 'web_search="disabled"' exec --ephemeral --ignore-user-config --ignore-rules --json --output-schema "$factory_root/output.schema.json" -C "$workspace" "\${model_args[@]}" - < "$factory_root/prompt.txt" > "$factory_root/worker.stdout" 2> "$factory_root/worker.stderr"
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
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
  if (executable.generated) {
    if (!existsSync(executable.path)) throw new Error("generated managed executable is missing");
    const resolved = realpathSync(executable.path);
    if (!resolved.startsWith("/tmp/factory-toolchain/") || !statSync(resolved).isFile()) throw new Error("generated managed executable escaped the private runtime root");
    const source = managedPaths.executables[executable.generatedFrom];
    if (!source || source.generated || realpathSync(source.path) !== resolved) throw new Error("generated managed executable differs from its verified source");
  }
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
