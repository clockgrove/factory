import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";

import {
  assertRuntimeBundleReceipt,
  type ManagedRuntimeAsset,
  type ManagedToolchainPlan,
  type RuntimeBundleReceipt,
  sha256Bytes,
} from "../runtime/toolchain-bundle.js";
import { runtimeComponentPaths, verifyRuntimeBundle } from "../runtime/toolchain-store.js";

export const BUN_ADAPTER_ID = "javascript-bun";
export const BUN_ADAPTER_CONTRACT = 1;
export const BUN_PACKAGE_REGISTRY = "registry.npmjs.org";

const SCRIPT_NAME =
  /^(?:typecheck|test|lint|check|verify|build)(?:[:._-][A-Za-z0-9][A-Za-z0-9:_.-]{0,63})?$/;
const WORKSPACE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];
const MIXED_LOCKS = [
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const PACKAGE_MANAGER_CONFIGS = [
  "bunfig.toml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "pnpm-workspace.yaml",
];
const BUN_ENVIRONMENT_FILES = [
  ".env",
  ".env.local",
  ".env.test",
  ".env.development",
  ".env.production",
];

export interface BunCapabilityOperation {
  kind: "package-script";
  key: string;
}

export interface BunValidationCommand {
  manager: "bun";
  workspace: "." | string;
  script: string;
  operation: BunCapabilityOperation;
}

type PackageManifest = {
  name?: unknown;
  version?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  trustedDependencies?: unknown;
  overrides?: unknown;
  resolutions?: unknown;
  patchedDependencies?: unknown;
  catalog?: unknown;
  catalogs?: unknown;
  peerDependenciesMeta?: unknown;
  bun?: unknown;
};

interface ManifestRecord {
  path: string;
  directory: "." | string;
  manifest: PackageManifest;
}

export interface BunAuthorityInspection {
  adapter: typeof BUN_ADAPTER_ID;
  version: string;
  command: BunValidationCommand;
  authorityPaths: string[];
  manifestPath: string;
  scriptBody: string;
  workspaceManifests: string[];
}

function operationKey(workspace: string, script: string): string {
  return workspace === "." ? script : `${workspace}:${script}`;
}

export function bunCapabilityOperation(
  command: string | BunValidationCommand,
): BunCapabilityOperation | null {
  const parsed = normalizeBunCommand(command);
  return parsed ? { ...parsed.operation } : null;
}

/** Reconstruct the one canonical command represented by a persisted operation. */
export function bunValidationCommandForOperation(operation: {
  kind: string;
  key: string;
}): BunValidationCommand | null {
  if (operation.kind !== "package-script") return null;
  const root = parseBunValidationCommand(`bun run ${operation.key}`);
  if (root?.operation.key === operation.key) return root;
  const separator = operation.key.indexOf(":");
  if (separator <= 0) return null;
  const workspace = operation.key.slice(0, separator);
  const script = operation.key.slice(separator + 1);
  const parsed = parseBunValidationCommand(`bun --cwd ${workspace} run ${script}`);
  return parsed?.operation.key === operation.key ? parsed : null;
}

/** Parse only the two canonical Bun package-script forms; no shell grammar is accepted. */
export function parseBunValidationCommand(command: string): BunValidationCommand | null {
  if (command !== command.trim() || /[\0\r\n\t]/.test(command) || command.includes("  "))
    return null;
  const tokens = command.split(/ +/);
  let workspace: "." | string;
  let script: string | undefined;
  if (tokens.length === 3 && tokens[0] === "bun" && tokens[1] === "run") {
    workspace = ".";
    script = tokens[2];
  } else if (
    tokens.length === 5 &&
    tokens[0] === "bun" &&
    tokens[1] === "--cwd" &&
    tokens[3] === "run"
  ) {
    workspace = tokens[2]!;
    script = tokens[4];
    if (
      workspace === "." ||
      workspace.length > 96 ||
      !WORKSPACE_PATH.test(workspace) ||
      posix.normalize(workspace) !== workspace ||
      workspace.split("/").some((part) => part === "." || part === "..")
    )
      return null;
  } else {
    return null;
  }
  if (!script || script.length > 72 || !SCRIPT_NAME.test(script)) return null;
  const operation = { kind: "package-script", key: operationKey(workspace, script) } as const;
  if (operation.key.length > 160) return null;
  return { manager: "bun", workspace, script, operation };
}

function normalizeBunCommand(command: string | BunValidationCommand): BunValidationCommand | null {
  if (typeof command === "string") return parseBunValidationCommand(command);
  const display =
    command.workspace === "."
      ? `bun run ${command.script}`
      : `bun --cwd ${command.workspace} run ${command.script}`;
  const parsed = parseBunValidationCommand(display);
  return parsed &&
    command.manager === parsed.manager &&
    command.operation.kind === parsed.operation.kind &&
    command.operation.key === parsed.operation.key
    ? parsed
    : null;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Bun ${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const record = objectRecord(value, label);
  if (Object.keys(record).length > 512)
    throw new Error(`Bun ${label} exceeds the supported entry bound`);
  for (const [name, specifier] of Object.entries(record)) {
    if (!PACKAGE_NAME.test(name) || typeof specifier !== "string" || specifier.length > 512)
      throw new Error(`Bun ${label} contains an invalid dependency`);
  }
  return record as Record<string, string>;
}

async function readBoundedRegularFile(
  root: string,
  relativePath: string,
  maximumBytes = 256 * 1024,
): Promise<string> {
  const target = join(root, relativePath);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Bun authority file is missing: ${relativePath}`);
    throw error;
  }
  if (!stat.isFile() || stat.size > maximumBytes)
    throw new Error(`Bun authority is not a bounded regular file: ${relativePath}`);
  return readFile(target, "utf8");
}

async function readManifest(root: string, path: string): Promise<PackageManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedRegularFile(root, path));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`Bun package manifest is invalid JSON: ${path}`);
    throw error;
  }
  return objectRecord(parsed, `package manifest ${path}`) as PackageManifest;
}

async function pathExists(root: string, relativePath: string): Promise<boolean> {
  try {
    await lstat(join(root, relativePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoConfiguration(root: string, directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    for (const name of [...PACKAGE_MANAGER_CONFIGS, ...BUN_ENVIRONMENT_FILES]) {
      const path = directory === "." ? name : posix.join(directory, name);
      if (await pathExists(root, path))
        throw new Error(
          `Bun authority forbids package-manager configuration or environment files: ${path}`,
        );
    }
    for (const lock of MIXED_LOCKS) {
      const path = directory === "." ? lock : posix.join(directory, lock);
      if (await pathExists(root, path))
        throw new Error(`Bun authority forbids mixed package-manager lockfile: ${path}`);
    }
  }
}

function authorityDirectories(manifests: readonly ManifestRecord[]): string[] {
  const directories = new Set<string>(["."]);
  for (const { directory } of manifests) {
    if (directory === ".") continue;
    const parts = directory.split("/");
    for (let length = 1; length <= parts.length; length += 1)
      directories.add(parts.slice(0, length).join("/"));
  }
  return [...directories].sort();
}

function workspacePatterns(manifest: PackageManifest): string[] {
  if (manifest.workspaces === undefined) return [];
  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.length > 64)
    throw new Error("Bun workspaces must be a bounded array of direct-child patterns");
  const patterns = manifest.workspaces.map((value) => {
    if (
      typeof value !== "string" ||
      value.length > 96 ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/\*$/.test(value) ||
      value.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Bun workspace patterns must select direct child directories");
    return value;
  });
  if (new Set(patterns).size !== patterns.length)
    throw new Error("Bun workspace patterns must be unique");
  return patterns;
}

async function assertDirectoryChain(root: string, directory: string): Promise<void> {
  let current = "";
  for (const part of directory.split("/")) {
    current = current ? `${current}/${part}` : part;
    const stat = await lstat(join(root, current));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Bun workspace path is not a real directory: ${current}`);
  }
}

async function discoverWorkspaceManifests(
  root: string,
  patterns: readonly string[],
): Promise<ManifestRecord[]> {
  const records = new Map<string, ManifestRecord>();
  let entryCount = 0;
  for (const pattern of patterns) {
    const parent = pattern.slice(0, -2);
    await assertDirectoryChain(root, parent);
    const entries = await readdir(join(root, parent), { withFileTypes: true });
    entryCount += entries.length;
    if (entryCount > 10_000) throw new Error("Bun workspace exceeds the supported directory bound");
    for (const entry of entries) {
      const directory = posix.join(parent, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Bun workspace contains a symlink: ${directory}`);
      if (!entry.isDirectory()) continue;
      const path = posix.join(directory, "package.json");
      if (!(await pathExists(root, path))) continue;
      if (records.has(directory))
        throw new Error(`Bun workspace membership is ambiguous: ${directory}`);
      records.set(directory, { path, directory, manifest: await readManifest(root, path) });
    }
  }
  return [...records.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function assertManifestSafety(
  record: ManifestRecord,
  exactVersion: string,
  workspaceNames: ReadonlyMap<string, string>,
): void {
  const { manifest, path } = record;
  if (
    record.directory === "."
      ? manifest.packageManager !== `bun@${exactVersion}`
      : manifest.packageManager !== undefined && manifest.packageManager !== `bun@${exactVersion}`
  )
    throw new Error(`Bun root must pin packageManager to bun@${exactVersion}: ${path}`);
  for (const field of [
    "trustedDependencies",
    "overrides",
    "resolutions",
    "patchedDependencies",
    "catalog",
    "catalogs",
    "peerDependenciesMeta",
    "bun",
  ] as const)
    if (manifest[field] !== undefined)
      throw new Error(`Bun package manifest has unsupported ${field} authority: ${path}`);

  const scripts = stringRecord(manifest.scripts, `scripts in ${path}`);
  const hook = INSTALL_HOOKS.find((name) => scripts[name] !== undefined);
  if (hook) throw new Error(`Bun package manifest has lifecycle hook ${hook}: ${path}`);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, specifier] of Object.entries(
      stringRecord(manifest[field], `${field} in ${path}`),
    )) {
      if (EXACT_VERSION.test(specifier)) continue;
      if (specifier === "workspace:*" && workspaceNames.has(name)) continue;
      throw new Error(`Bun dependency is not exact or workspace-bound: ${name} in ${path}`);
    }
  }
}

function assertSafeSelectedScript(body: string, path: string): void {
  const bunTest =
    /^bun test(?: [A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|jsx|ts|tsx))*(?: --run-in-band)?$/.test(body);
  if (!bunTest && !["tsc --noEmit", "vitest run", "eslint .", "prettier --check ."].includes(body))
    throw new Error(`Bun script is outside the finite validation allowlist: ${path}`);
  if (/[;&|`$<>\\\n\r]/.test(body) || body.includes(".."))
    throw new Error(`Bun script contains unsafe shell or path syntax: ${path}`);
}

function assertSelectedScriptDependency(
  body: string,
  manifest: PackageManifest,
  path: string,
): void {
  const required = new Map([
    ["tsc --noEmit", "typescript"],
    ["vitest run", "vitest"],
    ["eslint .", "eslint"],
    ["prettier --check .", "prettier"],
  ]).get(body);
  if (!required) return;
  const dependencies = {
    ...stringRecord(manifest.dependencies, `dependencies in ${path}`),
    ...stringRecord(manifest.devDependencies, `devDependencies in ${path}`),
  };
  if (!EXACT_VERSION.test(dependencies[required] ?? ""))
    throw new Error(`Bun validation binary ${required} must be an exact local dependency: ${path}`);
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/"))
        index += 1;
      if (index >= input.length) throw new Error("Bun lockfile contains an unterminated comment");
      index += 1;
    } else {
      output += character;
    }
  }
  if (inString) throw new Error("Bun lockfile contains an unterminated string");
  return output;
}

function removeTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(input[lookahead] ?? "")) lookahead += 1;
      if (input[lookahead] === "}" || input[lookahead] === "]") continue;
    }
    output += character;
  }
  return output;
}

function lockWorkspaceSpecifier(
  actual: unknown,
  expected: string,
  dependency: string,
  workspaceNames: ReadonlyMap<string, string>,
): boolean {
  if (actual === expected) return true;
  if (expected !== "workspace:*" || typeof actual !== "string") return false;
  const directory = workspaceNames.get(dependency);
  return actual === "workspace:" || actual === `workspace:${directory}`;
}

function assertNoExoticLockValues(value: unknown): void {
  if (typeof value === "string") {
    if (
      /^(?:git(?:\+[A-Za-z0-9+.-]+)?|github|ssh|file|link|portal|patch|catalog|npm):/i.test(
        value,
      ) ||
      (/^https?:/i.test(value) && !value.startsWith(`https://${BUN_PACKAGE_REGISTRY}/`)) ||
      value.includes("../")
    )
      throw new Error("Bun lockfile contains an exotic dependency source");
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoExoticLockValues(entry);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>))
      assertNoExoticLockValues(entry);
  }
}

async function assertBunLock(
  root: string,
  manifests: readonly ManifestRecord[],
  workspaceNames: ReadonlyMap<string, string>,
): Promise<void> {
  const raw = await readBoundedRegularFile(root, "bun.lock", 4 * 1024 * 1024);
  if (raw.includes("\0") || raw.length === 0)
    throw new Error("Bun lockfile contains unsupported syntax");
  let parsed: unknown;
  try {
    parsed = JSON.parse(removeTrailingCommas(stripJsonComments(raw)));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Bun lockfile is not bounded JSONC");
    throw error;
  }
  const lock = objectRecord(parsed, "lockfile");
  const allowedTopLevel = new Set(["lockfileVersion", "configVersion", "workspaces", "packages"]);
  if (Object.keys(lock).some((key) => !allowedTopLevel.has(key)))
    throw new Error("Bun lockfile has unsupported top-level authority");
  if (lock.lockfileVersion !== 1 || ![undefined, 0, 1].includes(lock.configVersion as never))
    throw new Error("Bun lockfile version is unsupported");
  const workspaces = objectRecord(lock.workspaces, "lockfile workspaces");
  const packages = objectRecord(lock.packages, "lockfile packages");
  if (Object.keys(workspaces).length !== manifests.length || Object.keys(packages).length > 50_000)
    throw new Error("Bun lockfile workspace set differs from package manifests");
  assertNoExoticLockValues(lock);

  const externalDependencies = new Set<string>();
  for (const record of manifests) {
    const lockKey = record.directory === "." ? "" : record.directory;
    const lockManifest = objectRecord(workspaces[lockKey], `lock workspace ${record.directory}`);
    const allowedWorkspaceFields = new Set(["name", "version", ...DEPENDENCY_FIELDS]);
    if (Object.keys(lockManifest).some((key) => !allowedWorkspaceFields.has(key)))
      throw new Error(`Bun lockfile workspace has unsupported authority: ${record.directory}`);
    if (
      record.manifest.name !== undefined &&
      lockManifest.name !== undefined &&
      lockManifest.name !== record.manifest.name
    )
      throw new Error(`Bun lockfile workspace name differs from package manifest: ${record.path}`);
    for (const field of DEPENDENCY_FIELDS) {
      const expected = stringRecord(record.manifest[field], `${field} in ${record.path}`);
      const actual = stringRecord(
        lockManifest[field],
        `${field} in lock workspace ${record.directory}`,
      );
      if (
        Object.keys(expected).length !== Object.keys(actual).length ||
        Object.entries(expected).some(
          ([name, specifier]) =>
            !lockWorkspaceSpecifier(actual[name], specifier, name, workspaceNames),
        )
      )
        throw new Error(`Bun lockfile ${field} differs from package manifest: ${record.path}`);
      for (const [name, specifier] of Object.entries(expected))
        if (EXACT_VERSION.test(specifier)) externalDependencies.add(`${name}@${specifier}`);
    }
  }

  const resolvedPackages = new Set<string>();
  for (const [key, candidate] of Object.entries(packages)) {
    if (!Array.isArray(candidate))
      throw new Error(`Bun lockfile has malformed package resolution: ${key}`);
    const identity = candidate[0];
    if (typeof identity !== "string")
      throw new Error(`Bun lockfile has malformed package identity: ${key}`);
    const workspaceMarker = identity.lastIndexOf("@workspace:");
    if (workspaceMarker > 0) {
      const name = identity.slice(0, workspaceMarker);
      const directory = identity.slice(workspaceMarker + "@workspace:".length);
      if (
        candidate.length !== 1 ||
        !PACKAGE_NAME.test(name) ||
        workspaceNames.get(name) !== directory
      )
        throw new Error(`Bun lockfile has malformed workspace resolution: ${key}`);
      continue;
    }
    if (candidate.length < 4 || candidate.length > 8)
      throw new Error(`Bun lockfile has malformed package resolution: ${key}`);
    const separator = identity.lastIndexOf("@");
    const name = identity.slice(0, separator);
    const version = identity.slice(separator + 1);
    if (!PACKAGE_NAME.test(name) || !EXACT_VERSION.test(version))
      throw new Error(`Bun lockfile has unsafe package identity: ${key}`);
    const source = candidate[1];
    if (
      source !== "" &&
      (typeof source !== "string" || !source.startsWith(`https://${BUN_PACKAGE_REGISTRY}/`))
    )
      throw new Error(`Bun lockfile package uses a non-registry source: ${name}`);
    const integrity = candidate.at(-1);
    if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity))
      throw new Error(`Bun lockfile package lacks SHA-512 integrity: ${name}`);
    resolvedPackages.add(identity);
  }
  for (const identity of externalDependencies)
    if (!resolvedPackages.has(identity))
      throw new Error(`Bun lockfile lacks exact package resolution: ${identity}`);
}

export async function inspectBunAuthority(input: {
  root: string;
  command: string | BunValidationCommand;
  exactVersion: string;
}): Promise<BunAuthorityInspection> {
  if (!EXACT_VERSION.test(input.exactVersion)) throw new Error("Bun runtime version must be exact");
  const command = normalizeBunCommand(input.command);
  if (!command) throw new Error("Bun validation command is not a finite package script");
  const rootManifest: ManifestRecord = {
    path: "package.json",
    directory: ".",
    manifest: await readManifest(input.root, "package.json"),
  };
  const workspaces = await discoverWorkspaceManifests(
    input.root,
    workspacePatterns(rootManifest.manifest),
  );
  const manifests = [rootManifest, ...workspaces];
  const names = new Map<string, string>();
  for (const record of workspaces) {
    const name = record.manifest.name;
    if (typeof name !== "string" || !PACKAGE_NAME.test(name) || names.has(name))
      throw new Error(`Bun workspace must have a unique package name: ${record.path}`);
    names.set(name, record.directory);
  }
  for (const record of manifests) assertManifestSafety(record, input.exactVersion, names);
  await assertNoConfiguration(input.root, authorityDirectories(manifests));
  await assertBunLock(input.root, manifests, names);

  const selected = manifests.find(({ directory }) => directory === command.workspace);
  if (!selected)
    throw new Error(`Bun command workspace is not a declared direct child: ${command.workspace}`);
  const scripts = stringRecord(selected.manifest.scripts, `scripts in ${selected.path}`);
  const body = scripts[command.script];
  if (!body) throw new Error(`Bun validation script is absent: ${command.script}`);
  if (scripts[`pre${command.script}`] || scripts[`post${command.script}`])
    throw new Error(`Bun validation script has pre/post lifecycle companions: ${command.script}`);
  assertSafeSelectedScript(body, selected.path);
  assertSelectedScriptDependency(body, selected.manifest, selected.path);
  return {
    adapter: BUN_ADAPTER_ID,
    version: input.exactVersion,
    command,
    authorityPaths: ["package.json", "bun.lock", ...workspaces.map(({ path }) => path)],
    manifestPath: selected.path,
    scriptBody: body,
    workspaceManifests: workspaces.map(({ path }) => path),
  };
}

export function createBunManagedExecutionPlan(input: {
  receipt: RuntimeBundleReceipt;
  privateRoot: string;
  commands: readonly (string | BunValidationCommand)[];
  assets: ManagedRuntimeAsset[];
}): ManagedToolchainPlan {
  if (!isAbsolute(input.privateRoot)) throw new Error("Bun private runtime root must be absolute");
  assertRuntimeBundleReceipt(input.receipt);
  if (
    input.receipt.tool !== "bun" ||
    input.receipt.adapter !== BUN_ADAPTER_ID ||
    input.receipt.adapterContract !== BUN_ADAPTER_CONTRACT
  )
    throw new Error("Bun runtime receipt does not satisfy the adapter contract");
  if (input.receipt.components.length !== 1 || input.receipt.components[0]?.id !== "bun")
    throw new Error("Bun runtime receipt must contain exactly the Bun component");
  const commands = input.commands.map(normalizeBunCommand);
  if (commands.length === 0 || commands.some((command) => command === null))
    throw new Error("Bun execution plan requires finite package-script commands");
  const component = input.receipt.components[0]!;
  const asset = input.assets.find(({ id }) => id === component.id);
  if (
    input.assets.length !== 1 ||
    !asset ||
    asset.sha256 !== component.asset.sha256 ||
    asset.archive !== component.asset.archive ||
    asset.executablePath !== component.executablePath ||
    asset.executableSha256 !== component.executableSha256 ||
    asset.treeSha256 !== component.treeSha256
  )
    throw new Error("Bun managed plan assets differ from its runtime receipt");

  const privatePath = (name: string) => join(input.privateRoot, name);
  return {
    tool: "bun",
    bundleDigest: input.receipt.digest,
    assets: input.assets,
    executables: [
      {
        id: "bun",
        assetId: "bun",
        kind: "native",
        relativePath: component.executablePath,
        argsPrefix: [],
      },
    ],
    setup: [
      {
        display: "bun --version",
        executableId: "bun",
        args: ["--version"],
        expectedStdout: component.version,
        network: "none",
      },
      {
        display: `bun install --frozen-lockfile --ignore-scripts --backend=copyfile --linker=isolated --registry=https://${BUN_PACKAGE_REGISTRY}/`,
        executableId: "bun",
        args: [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--backend=copyfile",
          "--linker=isolated",
          `--registry=https://${BUN_PACKAGE_REGISTRY}/`,
        ],
        network: "package-registry",
      },
    ],
    validation: (commands as BunValidationCommand[]).map((command) => ({
      display:
        command.workspace === "."
          ? `bun run ${command.script}`
          : `bun --cwd ${command.workspace} run ${command.script}`,
      executableId: "bun",
      args: ["run", command.script],
      ...(command.workspace === "." ? {} : { cwd: command.workspace }),
      network: "none",
    })),
    environment: {
      PATH: privatePath("bin"),
      HOME: privatePath("home"),
      TMPDIR: privatePath("tmp"),
      XDG_CACHE_HOME: privatePath("xdg-cache"),
      XDG_CONFIG_HOME: privatePath("xdg-config"),
      XDG_DATA_HOME: privatePath("xdg-data"),
      BUN_INSTALL: privatePath("bun-install"),
      BUN_INSTALL_CACHE_DIR: privatePath("bun-cache"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: privatePath("bun-transpiler-cache"),
      BUN_CONFIG_REGISTRY: `https://${BUN_PACKAGE_REGISTRY}/`,
      BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER: "1",
      NPM_CONFIG_USERCONFIG: "/dev/null",
      npm_config_registry: `https://${BUN_PACKAGE_REGISTRY}/`,
      CI: "true",
      NO_COLOR: "1",
    },
  };
}

export async function buildBunManagedExecutionPlan(input: {
  receipt: RuntimeBundleReceipt;
  storeRoot: string;
  privateRoot: string;
  commands: readonly (string | BunValidationCommand)[];
}): Promise<ManagedToolchainPlan> {
  await verifyRuntimeBundle(input.storeRoot, input.receipt);
  const [componentPath] = runtimeComponentPaths(input.storeRoot, input.receipt);
  if (!componentPath) throw new Error("Bun runtime component is unavailable");
  const content = await readFile(componentPath.asset);
  if (sha256Bytes(content) !== componentPath.component.asset.sha256)
    throw new Error("Bun runtime asset changed after verification");
  return createBunManagedExecutionPlan({
    receipt: input.receipt,
    privateRoot: input.privateRoot,
    commands: input.commands,
    assets: [
      {
        id: "bun",
        path: `toolchains/bun/${componentPath.component.asset.name}`,
        content,
        sha256: componentPath.component.asset.sha256,
        archive: componentPath.component.asset.archive,
        executablePath: componentPath.component.executablePath,
        executableSha256: componentPath.component.executableSha256,
        treeSha256: componentPath.component.treeSha256,
      },
    ],
  });
}
