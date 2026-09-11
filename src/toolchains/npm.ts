import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { satisfies, validRange } from "semver";

import type { RepositoryCapabilityOperation } from "../protocol/worker-packet.js";
import type {
  ManagedExecutionStep,
  ManagedRuntimeAsset,
  ManagedToolchainPlan,
  RuntimeBundleReceipt,
} from "../runtime/toolchain-bundle.js";

export const NPM_ADAPTER_ID = "node-npm";
export const NPM_ADAPTER_CONTRACT = 1;
export const NPM_PACKAGE_REGISTRY = "registry.npmjs.org";
export const NPM_NODE_VERSION_COMMAND = "node --version";
export const NPM_VERSION_COMMAND = "npm --version";
const NPM_INSTALL_ARGS = [
  "ci",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  `--registry=https://${NPM_PACKAGE_REGISTRY}/`,
  "--install-strategy=hoisted",
  "--install-links=false",
  "--legacy-peer-deps=false",
  "--include-workspace-root=true",
  "--include=dev",
  "--include=optional",
  "--include=peer",
] as const;
export const NPM_INSTALL_COMMAND = `npm ${NPM_INSTALL_ARGS.join(" ")}`;

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const SAFE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_SCRIPT =
  /^(?:typecheck|test|lint|check|verify|build)(?:[:._-][A-Za-z0-9][A-Za-z0-9:_.-]{0,111})?$/;
const SAFE_MEMBER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
];
const MIXED_MANAGER_PATHS = [
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "bunfig.toml",
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  ".pnpmfile.js",
  ".yarnrc",
  ".yarnrc.yml",
];

type JsonRecord = Record<string, unknown>;
type Manifest = JsonRecord & {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  packageManager?: unknown;
  devEngines?: unknown;
  engines?: unknown;
  workspaces?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
};

export interface NpmValidationCommand {
  workspace: string;
  script: string;
}

export interface NpmAuthorityInspection {
  authorityPaths: string[];
  manifestPaths: string[];
  operations: RepositoryCapabilityOperation[];
  nodeVersion: string;
  npmVersion: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`npm ${label} must be an object`);
  return value as JsonRecord;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const result = record(value, label);
  if (
    Object.keys(result).length > 512 ||
    Object.entries(result).some(
      ([name, version]) =>
        !SAFE_NAME.test(name) || typeof version !== "string" || version.length > 512,
    )
  )
    throw new Error(`npm ${label} is invalid`);
  return result as Record<string, string>;
}

function scriptMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const result = record(value, label);
  if (
    Object.keys(result).length > 512 ||
    Object.entries(result).some(
      ([name, body]) =>
        !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(name) ||
        typeof body !== "string" ||
        body.length > 1_000,
    )
  )
    throw new Error(`npm ${label} is invalid`);
  return result as Record<string, string>;
}

function exactDevEngine(
  manifest: Manifest,
  kind: "runtime" | "packageManager",
  name: "node" | "npm",
): string {
  const devEngines = record(manifest.devEngines, "devEngines");
  const engine = record(devEngines[kind], `devEngines.${kind}`);
  if (
    Object.keys(engine).some((key) => !["name", "version", "onFail"].includes(key)) ||
    engine.name !== name ||
    typeof engine.version !== "string" ||
    !STABLE_VERSION.test(engine.version) ||
    engine.onFail !== "error"
  )
    throw new Error(`npm devEngines.${kind} must exactly pin ${name} with onFail error`);
  return engine.version;
}

function safeMember(value: string): boolean {
  const parts = value.split("/");
  return (
    SAFE_MEMBER.test(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[*!?[\]{}]/.test(value) &&
    parts.every(
      (part) =>
        part !== "" && part !== "." && part !== ".." && part !== ".git" && part !== "node_modules",
    )
  );
}

function dependencyMaps(manifest: Manifest): Record<string, string> {
  return {
    ...stringMap(manifest.dependencies, "dependencies"),
    ...stringMap(manifest.devDependencies, "devDependencies"),
    ...stringMap(manifest.optionalDependencies, "optionalDependencies"),
  };
}

function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const entries = (value: Record<string, string>) =>
    Object.entries(value).sort(([leftName], [rightName]) =>
      leftName < rightName ? -1 : leftName > rightName ? 1 : 0,
    );
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function assertManifest(
  manifest: Manifest,
  path: string,
  expected: { node: string; npm: string },
  root: boolean,
): void {
  if (
    [
      "overrides",
      "resolutions",
      "pnpm",
      "trustedDependencies",
      "onlyBuiltDependencies",
      "ignoredBuiltDependencies",
      "patchedDependencies",
      "publishConfig",
      "bundleDependencies",
      "bundledDependencies",
      "config",
      "bin",
    ].some((key) => manifest[key] !== undefined)
  )
    throw new Error(`npm manifest has unsupported dependency or execution authority: ${path}`);
  if (typeof manifest.name !== "string" || !SAFE_NAME.test(manifest.name))
    throw new Error(`npm manifest has an invalid package name: ${path}`);
  if (typeof manifest.version !== "string" || !SAFE_VERSION.test(manifest.version))
    throw new Error(`npm manifest must pin an exact package version: ${path}`);
  const scripts = scriptMap(manifest.scripts, `scripts in ${path}`);
  const hook = LIFECYCLE.find((name) => scripts[name]);
  if (hook) throw new Error(`npm manifest has lifecycle hook ${hook}: ${path}`);
  for (const [name, version] of Object.entries(dependencyMaps(manifest)))
    if (!SAFE_VERSION.test(version))
      throw new Error(`npm direct dependency ${name} must use an exact version: ${path}`);
  if (Object.keys(stringMap(manifest.peerDependencies, `peerDependencies in ${path}`)).length > 0)
    throw new Error(`npm peer dependencies are unsupported: ${path}`);
  if (!root) {
    if (
      manifest.packageManager !== undefined ||
      manifest.devEngines !== undefined ||
      manifest.workspaces !== undefined
    )
      throw new Error(`npm workspace may not redefine runtime authority: ${path}`);
    return;
  }
  const devEngines = record(manifest.devEngines, "devEngines");
  if (
    Object.keys(devEngines).length !== 2 ||
    !Object.hasOwn(devEngines, "runtime") ||
    !Object.hasOwn(devEngines, "packageManager")
  )
    throw new Error("npm root devEngines must contain only runtime and packageManager pins");
  if (manifest.packageManager !== `npm@${expected.npm}`)
    throw new Error(`npm root packageManager must pin npm@${expected.npm}`);
  if (
    exactDevEngine(manifest, "runtime", "node") !== expected.node ||
    exactDevEngine(manifest, "packageManager", "npm") !== expected.npm
  )
    throw new Error("npm root devEngines differs from the activated Node/npm runtime");
  if (manifest.engines !== undefined) {
    const engines = stringMap(manifest.engines, "engines");
    if (
      Object.keys(engines).some((name) => name !== "node" && name !== "npm") ||
      (engines.node !== undefined && engines.node !== expected.node) ||
      (engines.npm !== undefined && engines.npm !== expected.npm)
    )
      throw new Error("npm advisory engines must exactly agree with devEngines");
  }
}

function parseJson(bytes: string, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error(`npm ${label} is not valid JSON`);
  }
  return record(value, label);
}

async function boundedJson(root: string, path: string): Promise<JsonRecord> {
  const target = join(root, path);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES)
    throw new Error(`npm authority is not a bounded regular file: ${path}`);
  return parseJson(await readFile(target, "utf8"), path);
}

async function assertAbsent(root: string, path: string): Promise<void> {
  try {
    await lstat(join(root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`npm authority conflicts with ${path}`);
}

async function assertRegularDirectoryPath(root: string, directory: string): Promise<void> {
  let current = root;
  for (const part of directory.split("/")) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`npm workspace traverses a non-directory or symlink: ${directory}`);
  }
}

export function parseNpmValidationCommand(command: string): NpmValidationCommand | null {
  const tokens = command.trim().split(/\s+/);
  if (
    tokens.length === 3 &&
    tokens[0] === "npm" &&
    tokens[1] === "run" &&
    SAFE_SCRIPT.test(tokens[2]!)
  )
    return { workspace: ".", script: tokens[2]! };
  if (
    tokens.length === 4 &&
    tokens[0] === "npm" &&
    tokens[1] === "run" &&
    SAFE_SCRIPT.test(tokens[2]!) &&
    tokens[3]!.startsWith("--workspace=")
  ) {
    const workspace = tokens[3]!.slice("--workspace=".length);
    if (safeMember(workspace)) return { workspace, script: tokens[2]! };
  }
  return null;
}

export function npmCapabilityOperation(command: string): RepositoryCapabilityOperation | null {
  const parsed = parseNpmValidationCommand(command);
  if (!parsed) return null;
  const key = npmOperationKey(parsed.workspace, parsed.script);
  if (key.length > 160) return null;
  return {
    kind: "package-script",
    key,
  };
}

function npmOperationKey(workspace: string, script: string): string {
  return `${workspace.length}:${workspace}:${script}`;
}

export function npmValidationCommandForOperation(
  operation: RepositoryCapabilityOperation,
): NpmValidationCommand | null {
  if (operation.kind !== "package-script") return null;
  const lengthSeparator = operation.key.indexOf(":");
  if (lengthSeparator <= 0) return null;
  const encodedLength = operation.key.slice(0, lengthSeparator);
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(encodedLength)) return null;
  const workspaceLength = Number(encodedLength);
  const workspaceStart = lengthSeparator + 1;
  const scriptSeparator = workspaceStart + workspaceLength;
  if (operation.key[scriptSeparator] !== ":") return null;
  const workspace = operation.key.slice(workspaceStart, scriptSeparator);
  const script = operation.key.slice(scriptSeparator + 1);
  return (workspace === "." || safeMember(workspace)) && SAFE_SCRIPT.test(script)
    ? { workspace, script }
    : null;
}

function workspaceMembers(manifest: Manifest): string[] {
  if (manifest.workspaces === undefined) return [];
  if (
    !Array.isArray(manifest.workspaces) ||
    manifest.workspaces.length === 0 ||
    manifest.workspaces.length > 128 ||
    manifest.workspaces.some((value) => typeof value !== "string" || !safeMember(value))
  )
    throw new Error("npm workspaces must be exact repository-relative member directories");
  const members = manifest.workspaces as string[];
  if (new Set(members).size !== members.length)
    throw new Error("npm workspace members must be unique");
  return [...members].sort();
}

function assertSafeScriptBody(
  body: string,
  manifest: Manifest,
  path: string,
  binProviders: ReadonlyMap<string, string>,
): void {
  if (body.length > 1_000 || /[;&|`$<>\n\r]/.test(body))
    throw new Error(`npm package script is outside the finite validation allowlist: ${path}`);
  const allowed =
    /^(?:tsc --noEmit|vitest run|eslint \.|prettier --check \.|node --test(?: [A-Za-z0-9._/-]+\.m?[c]?js)*)$/.test(
      body,
    );
  if (!allowed)
    throw new Error(`npm package script is outside the finite validation allowlist: ${path}`);
  const tokens = body.split(/\s+/);
  const binary = tokens[0]!;
  if (
    binary === "node" &&
    tokens.slice(2).some((target) => !safeMember(target) || !/\.(?:[mc]?js)$/.test(target))
  )
    throw new Error(`npm node test target escapes its selected workspace: ${path}`);
  if (binary !== "node") {
    const provider = binProviders.get(binary);
    if (!provider || !Object.hasOwn(dependencyMaps(manifest), provider))
      throw new Error(
        `npm package script uses an undeclared or ambiguous binary ${binary}: ${path}`,
      );
  }
}

function packageBins(value: unknown, packageName: string, path: string): Record<string, string> {
  if (value === undefined) return {};
  const bins =
    typeof value === "string"
      ? {
          [packageName.includes("/")
            ? packageName.slice(packageName.lastIndexOf("/") + 1)
            : packageName]: value,
        }
      : record(value, `bin mapping in ${path}`);
  if (
    Object.keys(bins).length > 64 ||
    Object.entries(bins).some(
      ([name, target]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ||
        typeof target !== "string" ||
        !safeMember(target),
    )
  )
    throw new Error(`npm lock package has an unsafe bin mapping: ${path}`);
  return bins as Record<string, string>;
}

function installPathIdentity(
  path: string,
  workspaceDirectories: ReadonlySet<string>,
): { name: string; ancestors: string[] } | null {
  if (
    path.length === 0 ||
    path.length > 1_000 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return null;
  const segments = path.split("/");
  const firstModules = segments.indexOf("node_modules");
  if (firstModules < 0) return null;
  const prefix = segments.slice(0, firstModules).join("/");
  if (prefix && !workspaceDirectories.has(prefix)) return null;
  let index = firstModules;
  let name = "";
  const packageRoots: string[] = [];
  while (index < segments.length) {
    if (segments[index++] !== "node_modules") return null;
    const first = segments[index++];
    if (!first) return null;
    if (first.startsWith("@")) {
      const second = segments[index++];
      if (!second) return null;
      name = `${first}/${second}`;
    } else name = first;
    if (!SAFE_NAME.test(name)) return null;
    packageRoots.push(segments.slice(0, index).join("/"));
    if (index < segments.length && segments[index] !== "node_modules") return null;
  }
  return { name, ancestors: packageRoots.slice(0, -1) };
}

function dependencyResolutionPaths(importer: string, name: string): string[] {
  const candidates: string[] = [];
  let current = importer;
  while (current) {
    candidates.push(`${current}/node_modules/${name}`);
    const marker = current.lastIndexOf("/node_modules/");
    if (marker < 0) break;
    current = current.slice(0, marker);
  }
  candidates.push(`node_modules/${name}`);
  return [...new Set(candidates)];
}

function dependencySpecSatisfies(spec: string, version: string): boolean {
  if (
    spec.length > 512 ||
    /(?:file:|git|https?:|npm:|workspace:|link:|patch:|github:|gitlab:|bitbucket:)/i.test(spec)
  )
    return false;
  const range = validRange(spec, { loose: false });
  return range !== null && satisfies(version, range, { loose: false });
}

function platformSelectorAllows(value: unknown, target: string, label: string): boolean {
  if (value === undefined) return true;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((entry) => typeof entry !== "string" || !/^!?[A-Za-z0-9._-]+$/.test(entry))
  )
    throw new Error(`npm lock ${label} selector is invalid`);
  const selectors = value as string[];
  if (selectors.includes(`!${target}`)) return false;
  const positive = selectors.filter((entry) => !entry.startsWith("!"));
  return positive.length === 0 || positive.includes(target);
}

function packageRunsOnFactory(descriptor: JsonRecord, path: string): boolean {
  return (
    platformSelectorAllows(descriptor.os, "linux", `os in ${path}`) &&
    platformSelectorAllows(descriptor.cpu, "x64", `cpu in ${path}`) &&
    platformSelectorAllows(descriptor.libc, "glibc", `libc in ${path}`)
  );
}

function assertLock(
  lock: JsonRecord,
  manifests: Array<{ path: string; directory: string; manifest: Manifest }>,
): Map<string, Map<string, string>> {
  if (lock.lockfileVersion !== 3 || lock.requires !== true)
    throw new Error("npm lockfile must use complete lockfileVersion 3 authority");
  const packages = record(lock.packages, "lockfile packages");
  if (Object.keys(packages).length === 0 || Object.keys(packages).length > 100_000)
    throw new Error("npm lockfile packages closure is empty or too large");
  const byDirectory = new Map(manifests.map((entry) => [entry.directory, entry]));
  const workspaceDirectories = new Set(
    manifests.filter(({ directory }) => directory !== ".").map(({ directory }) => directory),
  );
  const names = new Set<string>();
  const packageBinsByPath = new Map<string, Record<string, string>>();
  const platformCompatibility = new Map<string, boolean>();
  const outgoing = new Map<
    string,
    Array<{ name: string; spec: string; peer: boolean; optional: boolean }>
  >();
  for (const { directory, manifest } of manifests) {
    if (names.has(manifest.name as string))
      throw new Error("npm workspace package names must be unique");
    names.add(manifest.name as string);
    const descriptor = record(
      packages[directory === "." ? "" : directory],
      `lock descriptor ${directory}`,
    );
    if (descriptor.link !== undefined)
      throw new Error(`npm workspace descriptor may not be a link: ${directory}`);
    if (descriptor.name !== manifest.name || descriptor.version !== manifest.version)
      throw new Error(`npm lock descriptor differs from ${directory}/package.json`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const)
      if (
        !sameStringMap(
          stringMap(descriptor[field], `${field} in lock ${directory}`),
          stringMap(manifest[field], `${field} in ${directory}`),
        )
      )
        throw new Error(`npm lock ${field} differs from ${directory}/package.json`);
  }
  for (const [path, raw] of Object.entries(packages)) {
    const descriptor = record(raw, `lock package ${path || "."}`);
    if (path === "" || byDirectory.has(path)) continue;
    const installedIdentity = installPathIdentity(path, workspaceDirectories);
    if (!installedIdentity)
      throw new Error(`npm lock package has an unsafe or unresolvable installed path: ${path}`);
    const { name: installedName } = installedIdentity;
    if (installedIdentity.ancestors.some((ancestor) => !packages[ancestor]))
      throw new Error(`npm lock package lacks its installed ancestor: ${path}`);
    if (descriptor.link === true) {
      const member =
        typeof descriptor.resolved === "string" ? byDirectory.get(descriptor.resolved) : undefined;
      if (!member || member.directory === "." || member.manifest.name !== installedName)
        throw new Error(`npm workspace link escapes the enumerated workspace: ${path}`);
      continue;
    }
    if (
      descriptor.link !== undefined ||
      (descriptor.name !== undefined && descriptor.name !== installedName) ||
      typeof descriptor.version !== "string" ||
      !SAFE_VERSION.test(descriptor.version)
    )
      throw new Error(`npm lock package has an invalid installed identity: ${path}`);
    if (
      typeof descriptor.resolved !== "string" ||
      !canonicalRegistryTarball(descriptor.resolved, installedName, descriptor.version) ||
      typeof descriptor.integrity !== "string" ||
      !INTEGRITY.test(descriptor.integrity)
    )
      throw new Error(`npm lock package lacks canonical registry SHA-512 authority: ${path}`);
    if (
      descriptor.hasInstallScript === true ||
      descriptor.hasShrinkwrap === true ||
      descriptor.inBundle === true ||
      descriptor.bundled === true
    )
      throw new Error(`npm lock package requires unsupported install/build authority: ${path}`);
    const compatible = packageRunsOnFactory(descriptor, path);
    platformCompatibility.set(path, compatible);
    if (!compatible && descriptor.optional !== true)
      throw new Error(`npm lock package is incompatible with Linux x64 glibc: ${path}`);
    const bins = compatible ? packageBins(descriptor.bin, installedName, path) : {};
    packageBinsByPath.set(path, bins);
    if (compatible)
      for (const name of Object.keys(bins)) {
        if (["node", "npm", "npx", "corepack"].includes(name))
          throw new Error(`npm lock package bin ${name} is reserved: ${path}`);
      }
    const dependencies = {
      ...stringMap(descriptor.dependencies, `dependencies in ${path}`),
      ...stringMap(descriptor.optionalDependencies, `optionalDependencies in ${path}`),
    };
    const peerDependencies = stringMap(descriptor.peerDependencies, `peerDependencies in ${path}`);
    const peerMeta =
      descriptor.peerDependenciesMeta === undefined
        ? {}
        : record(descriptor.peerDependenciesMeta, `peerDependenciesMeta in ${path}`);
    if (Object.keys(peerMeta).some((name) => !Object.hasOwn(peerDependencies, name)))
      throw new Error(`npm lock peer metadata is not bound to a peer dependency: ${path}`);
    const peerEdges = Object.entries(peerDependencies).map(([name, spec]) => {
      const metadata = peerMeta[name];
      if (metadata === undefined) return { name, spec, peer: true, optional: false };
      const fields = record(metadata, `peer metadata for ${name} in ${path}`);
      if (Object.keys(fields).some((key) => key !== "optional") || fields.optional !== true)
        throw new Error(`npm lock peer metadata is unsupported: ${path}`);
      return { name, spec, peer: true, optional: true };
    });
    outgoing.set(path, [
      ...Object.entries(dependencies).map(([name, spec]) => ({
        name,
        spec,
        peer: false,
        optional: Object.hasOwn(
          stringMap(descriptor.optionalDependencies, `optionalDependencies in ${path}`),
          name,
        ),
      })),
      ...peerEdges,
    ]);
  }
  for (const member of manifests.filter(({ directory }) => directory !== ".")) {
    const canonicalLink = `node_modules/${member.manifest.name as string}`;
    const links = Object.entries(packages).filter(([, raw]) => {
      const descriptor = raw as JsonRecord;
      return descriptor.link === true && descriptor.resolved === member.directory;
    });
    if (
      links.length !== 1 ||
      links[0]![0] !== canonicalLink ||
      (links[0]![1] as JsonRecord).link !== true
    )
      throw new Error(`npm workspace ${member.directory} lacks one canonical root link`);
  }
  const directBinProviders = new Map<string, Map<string, string>>();
  for (const { directory, manifest } of manifests) {
    const directBins = new Map<string, string>();
    for (const [name, version] of Object.entries(dependencyMaps(manifest))) {
      const member = manifests.find((entry) => entry.manifest.name === name);
      const installedPath = dependencyResolutionPaths(
        directory === "." ? "" : directory,
        name,
      ).find((candidate) => packages[candidate]);
      const installed = installedPath
        ? record(packages[installedPath], `direct dependency ${name}`)
        : undefined;
      if (member) {
        if (version !== member.manifest.version)
          throw new Error(`npm workspace dependency ${name} must pin the exact member version`);
        if (installed?.link !== true || installed.resolved !== member.directory)
          throw new Error(`npm lock lacks the resolved workspace link for ${name}`);
      } else {
        if (installed?.version !== version || installed.link !== undefined)
          throw new Error(`npm lock lacks exact direct dependency ${name}@${version}`);
      }
      for (const bin of Object.keys(
        (installedPath && packageBinsByPath.get(installedPath)) ?? {},
      )) {
        if (directBins.has(bin))
          throw new Error(`npm importer ${directory} has an ambiguous direct binary ${bin}`);
        directBins.set(bin, name);
      }
    }
    directBinProviders.set(directory, directBins);
  }
  const importerBinProviders = new Map<string, Map<string, string>>();
  const rootBins = directBinProviders.get(".") ?? new Map<string, string>();
  for (const { directory } of manifests) {
    // npm-run-path layers node_modules/.bin from the selected workspace up to
    // the repository root. A nearer workspace link therefore shadows a root
    // link with the same name; collisions within either direct layer were
    // rejected above.
    importerBinProviders.set(
      directory,
      directory === "."
        ? new Map(rootBins)
        : new Map([...rootBins, ...(directBinProviders.get(directory) ?? new Map())]),
    );
  }
  for (const { directory, manifest } of manifests) {
    const importer = directory === "." ? "" : directory;
    outgoing.set(importer, [
      ...Object.entries(stringMap(manifest.dependencies, `dependencies in ${directory}`)).map(
        ([name, spec]) => ({ name, spec, peer: false, optional: false }),
      ),
      ...Object.entries(stringMap(manifest.devDependencies, `devDependencies in ${directory}`)).map(
        ([name, spec]) => ({ name, spec, peer: false, optional: false }),
      ),
      ...Object.entries(
        stringMap(manifest.optionalDependencies, `optionalDependencies in ${directory}`),
      ).map(([name, spec]) => ({ name, spec, peer: false, optional: true })),
    ]);
  }
  // `true` means the package is only reachable beneath an incompatible optional
  // dependency. Its recorded closure must still be complete, but it is omitted
  // from this platform and cannot provide binaries or satisfy a required edge.
  const reachability = new Map<string, boolean>(
    ["", ...workspaceDirectories].map((path) => [path, false]),
  );
  const pending = [...reachability.keys()];
  for (const member of manifests.filter(({ directory }) => directory !== "."))
    reachability.set(`node_modules/${member.manifest.name as string}`, false);
  while (pending.length > 0) {
    const importer = pending.pop()!;
    const importerOmitted = reachability.get(importer) ?? false;
    for (const edge of outgoing.get(importer) ?? []) {
      const candidates = dependencyResolutionPaths(importer, edge.name);
      if (edge.peer) candidates.shift();
      const targetPath = candidates.find((candidate) => packages[candidate] !== undefined);
      if (!targetPath && edge.optional) continue;
      if (!targetPath)
        throw new Error(
          `npm lock dependency closure is incomplete for ${edge.name} from ${importer || "."}`,
        );
      const target = record(packages[targetPath], `resolved dependency ${edge.name}`);
      const targetVersion =
        target.link === true && typeof target.resolved === "string"
          ? (byDirectory.get(target.resolved)?.manifest.version as string | undefined)
          : typeof target.version === "string"
            ? target.version
            : undefined;
      if (!targetVersion || !dependencySpecSatisfies(edge.spec, targetVersion))
        throw new Error(`npm lock dependency ${edge.name} does not satisfy ${edge.spec}`);
      const compatible = target.link === true || platformCompatibility.get(targetPath) !== false;
      if (!compatible && !edge.optional && !importerOmitted)
        throw new Error(
          `npm required dependency ${edge.name} is incompatible with Linux x64 glibc`,
        );
      const targetOmitted = importerOmitted || (!compatible && edge.optional);
      const previousState = reachability.get(targetPath);
      if (previousState === undefined || (previousState && !targetOmitted)) {
        reachability.set(targetPath, targetOmitted);
        pending.push(targetPath);
      }
      if (
        target.link === true &&
        typeof target.resolved === "string" &&
        (reachability.get(target.resolved) === undefined ||
          (reachability.get(target.resolved) === true && !targetOmitted))
      ) {
        reachability.set(target.resolved, targetOmitted);
        pending.push(target.resolved);
      }
    }
  }
  const orphan = Object.keys(packages).find((path) => !reachability.has(path));
  if (orphan !== undefined)
    throw new Error(`npm lock package is unreachable from an importer: ${orphan}`);
  return importerBinProviders;
}

function canonicalRegistryTarball(value: string, name: string, version: string): boolean {
  try {
    const parsed = new URL(value);
    const leafName = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === NPM_PACKAGE_REGISTRY &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname === `/${name}/-/${leafName}-${version}.tgz` &&
      !/%(?:2e|2f|5c)/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export async function inspectNpmAuthority(input: {
  root: string;
  commands: readonly NpmValidationCommand[];
  nodeVersion: string;
  npmVersion: string;
}): Promise<NpmAuthorityInspection> {
  await Promise.all(MIXED_MANAGER_PATHS.map((path) => assertAbsent(input.root, path)));
  const rootManifest = (await boundedJson(input.root, "package.json")) as Manifest;
  assertManifest(
    rootManifest,
    "package.json",
    { node: input.nodeVersion, npm: input.npmVersion },
    true,
  );
  const members = workspaceMembers(rootManifest);
  const manifests: Array<{ path: string; directory: string; manifest: Manifest }> = [
    { path: "package.json", directory: ".", manifest: rootManifest },
  ];
  for (const directory of members) {
    const path = posix.join(directory, "package.json");
    await assertRegularDirectoryPath(input.root, directory);
    const manifest = (await boundedJson(input.root, path)) as Manifest;
    assertManifest(manifest, path, { node: input.nodeVersion, npm: input.npmVersion }, false);
    manifests.push({ path, directory, manifest });
  }
  const lock = await boundedJson(input.root, "package-lock.json");
  const binProviders = assertLock(lock, manifests);
  for (const command of input.commands) {
    const selected = manifests.find(({ directory }) => directory === command.workspace);
    if (!selected)
      throw new Error(`npm validation selects an undeclared workspace: ${command.workspace}`);
    const scripts = scriptMap(selected.manifest.scripts, `scripts in ${selected.path}`);
    const body = scripts[command.script];
    if (!body) throw new Error(`npm validation script is absent: ${command.script}`);
    if (scripts[`pre${command.script}`] || scripts[`post${command.script}`])
      throw new Error(`npm validation script has lifecycle companions: ${command.script}`);
    const scriptManifest =
      selected.directory === "."
        ? rootManifest
        : {
            ...selected.manifest,
            // npm exposes root dependencies to workspace scripts, while a
            // nearer workspace dependency of the same name takes precedence.
            dependencies: {
              ...dependencyMaps(rootManifest),
              ...dependencyMaps(selected.manifest),
            },
            devDependencies: undefined,
            optionalDependencies: undefined,
          };
    assertSafeScriptBody(
      body,
      scriptManifest,
      selected.path,
      binProviders.get(selected.directory) ?? new Map(),
    );
  }
  const manifestPaths = manifests.map(({ path }) => path);
  return {
    authorityPaths: ["package.json", "package-lock.json", ...manifestPaths.slice(1)].sort(),
    manifestPaths,
    operations: input.commands.map((command) => ({
      kind: "package-script",
      key: npmOperationKey(command.workspace, command.script),
    })),
    nodeVersion: input.nodeVersion,
    npmVersion: input.npmVersion,
  };
}

export function npmEnvironment(privateRoot = "/tmp/factory-toolchain"): Record<string, string> {
  return {
    PATH: `${privateRoot}/bin`,
    HOME: `${privateRoot}/home`,
    ALL_PROXY: "",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    LD_AUDIT: "",
    LD_LIBRARY_PATH: "",
    LD_PRELOAD: "",
    NO_PROXY: "",
    NODE_ENV: "",
    NODE_EXTRA_CA_CERTS: "",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    SSL_CERT_DIR: "",
    SSL_CERT_FILE: "",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    npm_config_audit: "false",
    npm_config_cache: `${privateRoot}/cache`,
    npm_config_fund: "false",
    npm_config_globalconfig: "/dev/null",
    npm_config_ignore_scripts: "true",
    npm_config_install_links: "false",
    npm_config_install_strategy: "hoisted",
    npm_config_legacy_peer_deps: "false",
    npm_config_node_gyp: "/dev/null",
    npm_config_omit: "",
    npm_config_prefix: `${privateRoot}/prefix`,
    npm_config_registry: `https://${NPM_PACKAGE_REGISTRY}/`,
    npm_config_update_notifier: "false",
  };
}

export function createNpmManagedToolchainPlan(input: {
  receipt: RuntimeBundleReceipt;
  assets: ManagedRuntimeAsset[];
  commands: readonly string[];
}): ManagedToolchainPlan {
  const component = input.receipt.components.find(({ id }) => id === "npm");
  const entrypoints = component?.entrypoints ?? [];
  const node = entrypoints.find(({ id }) => id === "node");
  const npm = entrypoints.find(({ id }) => id === "npm");
  if (!component || !node || !npm || npm.interpreter !== "node")
    throw new Error("npm runtime bundle lacks its exact Node/npm entrypoint relationship");
  const validation: ManagedExecutionStep[] = input.commands.map((command) => {
    const parsed = parseNpmValidationCommand(command);
    if (!parsed) throw new Error("npm managed plan contains an unsupported command");
    return {
      display: command,
      executableId: "npm",
      args: [
        "run",
        parsed.script,
        ...(parsed.workspace === "." ? [] : [`--workspace=${parsed.workspace}`]),
      ],
      network: "none",
    };
  });
  return {
    tool: "npm",
    bundleDigest: input.receipt.digest,
    assets: input.assets,
    executables: [
      {
        id: "node",
        assetId: "npm",
        entrypointId: "node",
        kind: "native",
        relativePath: node.path,
        argsPrefix: [],
      },
      {
        id: "npm",
        assetId: "npm",
        entrypointId: "npm",
        kind: "interpreted",
        interpreterId: "node",
        relativePath: npm.path,
        argsPrefix: [],
      },
    ],
    setup: [
      {
        display: NPM_NODE_VERSION_COMMAND,
        executableId: "node",
        args: ["--version"],
        expectedStdout: `v${node.version}`,
        network: "none",
      },
      {
        display: NPM_VERSION_COMMAND,
        executableId: "npm",
        args: ["--version"],
        expectedStdout: npm.version,
        network: "none",
      },
      {
        display: NPM_INSTALL_COMMAND,
        executableId: "npm",
        args: [...NPM_INSTALL_ARGS],
        network: "package-registry",
      },
    ],
    validation,
    environment: npmEnvironment(),
  };
}

export async function findNestedNpmRoots(
  root: string,
  members: readonly string[],
): Promise<string[]> {
  const permitted = new Set(members.map((member) => posix.join(member, "package.json")));
  const found: string[] = [];
  let observedEntries = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      observedEntries += 1;
      if (observedEntries > 100_000)
        throw new Error("npm repository authority exceeds the bounded traversal limit");
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const relative = directory ? posix.join(directory, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(relative);
      else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        (entry.name === "binding.gyp" || MIXED_MANAGER_PATHS.includes(entry.name))
      )
        found.push(relative);
      else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name === "package-lock.json" &&
        dirname(relative) !== "."
      )
        found.push(relative);
      else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name === "package.json" &&
        relative !== "package.json" &&
        !permitted.has(relative)
      )
        found.push(relative);
    }
  };
  await visit("");
  return found.sort();
}
