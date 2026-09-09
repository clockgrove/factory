import { access, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

import { executionAffectingReason } from "../approval.js";
import {
  assertArtifactScope,
  verifyArtifact,
  materializeArtifactPatch,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import {
  assertFilesystemArtifactManifest,
  verifyMaterializedFiles,
} from "../execution/artifact-content.js";
import { inspectPatchManifest } from "../runtime/artifact-patch.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { IsolatedValidationResult } from "../execution/backend.js";
import {
  cleanupLocalWorktree,
  createLocalWorktree,
  type LocalWorktree,
} from "../runtime/local-worktree.js";
import {
  runContainedProcess,
  sanitizedWorkerEnvironment,
  type StartProcessOptions,
} from "../runtime/process-group.js";
import {
  LocalScopeCleanupError,
  parseLocalScopeIdentity,
  runScopedLocalProcess,
  type LocalScopeIdentity,
} from "../runtime/local-scope.js";
import { createValidationEvidence, type ValidationEvidence } from "./evidence.js";
import {
  assertSafeValidationCommand,
  bootstrapPackageValidationCommand,
  NPM_VALIDATION_SETUP_COMMAND,
  PNPM_BOOTSTRAP_REGISTRY,
  PNPM_BOOTSTRAP_VERSION_COMMAND,
  PNPM_BOOTSTRAP_VALIDATION_SETUP_COMMAND,
  validationPlanFromPacket,
} from "./plan.js";

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
  /** The Supervisor journals each exact scope before launch and fences each
   * command. This never authorizes a local substitute for isolated validation. */
  localScope?: {
    identity: Omit<LocalScopeIdentity, "commandIndex">;
    deadline: string;
    beforeLaunch(identity: LocalScopeIdentity): Promise<void>;
    afterStop(identity: LocalScopeIdentity): Promise<void>;
  };
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

const PINNED_PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

type PackageManifest = {
  name?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  pnpm?: unknown;
};

async function readBoundedRegularFile(
  root: string,
  path: string,
  maxBytes = 256 * 1024,
): Promise<string> {
  const target = join(root, path);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > maxBytes)
    throw new Error(`bootstrap configuration is not a bounded regular file: ${path}`);
  return readFile(target, "utf8");
}

async function readPackageManifest(root: string, path: string): Promise<PackageManifest> {
  const parsed: unknown = JSON.parse(await readBoundedRegularFile(root, path));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`bootstrap package manifest is invalid: ${path}`);
  return parsed as PackageManifest;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`bootstrap package ${label} is invalid`);
  const entries = Object.entries(value);
  if (
    entries.length > 256 ||
    entries.some(
      ([key, item]) =>
        !/^[A-Za-z0-9@][A-Za-z0-9@/_.-]{0,213}$/.test(key) ||
        typeof item !== "string" ||
        item.length > 2_000,
    )
  )
    throw new Error(`bootstrap package ${label} is invalid`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function pinnedDependency(manifest: PackageManifest, dependency: string): boolean {
  const declared = {
    ...stringRecord(manifest.dependencies, "dependencies"),
    ...stringRecord(manifest.devDependencies, "devDependencies"),
  }[dependency];
  return typeof declared === "string" && PINNED_PACKAGE_VERSION.test(declared);
}

const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

function assertPackageManifestSafety(manifest: PackageManifest, path: string): void {
  const scripts = stringRecord(manifest.scripts, `scripts in ${path}`);
  const lifecycle = INSTALL_LIFECYCLE_SCRIPTS.find((name) => scripts[name]);
  if (lifecycle)
    throw new Error(`bootstrap package manifest has lifecycle hook ${lifecycle}: ${path}`);
  if (manifest.pnpm !== undefined) {
    if (
      !manifest.pnpm ||
      typeof manifest.pnpm !== "object" ||
      Array.isArray(manifest.pnpm) ||
      Object.keys(manifest.pnpm).length !== 1 ||
      !Array.isArray(
        (manifest.pnpm as { onlyBuiltDependencies?: unknown }).onlyBuiltDependencies,
      ) ||
      (manifest.pnpm as { onlyBuiltDependencies: unknown[] }).onlyBuiltDependencies.length !== 0
    )
      throw new Error(`bootstrap package manifest has unsupported pnpm authority: ${path}`);
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    for (const [name, version] of Object.entries(
      stringRecord(manifest[field], `${field} in ${path}`),
    )) {
      if (!PINNED_PACKAGE_VERSION.test(version) && version !== "workspace:*")
        throw new Error(
          `bootstrap package dependency is not exact or workspace-bound: ${name} in ${path}`,
        );
    }
  }
}

function pathIsAllowed(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) =>
    allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
  );
}

function nodeTestTargets(script: string): string[] | null {
  if (!/^node --test(?: [A-Za-z0-9_][A-Za-z0-9_./-]*)+$/.test(script)) return null;
  const targets = script.split(" ").slice(2);
  return targets.every(
    (target) =>
      /\.(?:js|mjs|cjs)$/.test(target) &&
      target.split("/").every((part) => part !== "." && part !== ".." && part !== ""),
  )
    ? targets
    : null;
}

function assertSafeBootstrapLeafScript(
  script: string,
  manifest: PackageManifest,
  manifestPath: string,
  allowedPaths: string[],
): void {
  const targets = nodeTestTargets(script);
  const allowed: readonly [string | null, string] | null =
    script === "tsc --noEmit"
      ? ["typescript", "tsc"]
      : script === "vitest run"
        ? ["vitest", "vitest"]
        : script === "eslint ."
          ? ["eslint", "eslint"]
          : script === "prettier --check ."
            ? ["prettier", "prettier"]
            : targets
              ? [null, "node"]
              : null;
  if (!allowed)
    throw new Error(
      `bootstrap package script is outside the finite validation allowlist: ${manifestPath}`,
    );
  const [dependency, executable] = allowed;
  if (dependency && !pinnedDependency(manifest, dependency))
    throw new Error(`bootstrap package script runner is not pinned: ${manifestPath}`);
  for (const target of targets ?? []) {
    const repositoryPath = posix.normalize(posix.join(posix.dirname(manifestPath), target));
    if (!pathIsAllowed(repositoryPath, allowedPaths))
      throw new Error(
        `bootstrap package script target is outside Work Item scope: ${repositoryPath}`,
      );
  }
  assertSafeValidationCommand(script, [executable]);
}

function parsePnpmWorkspacePatterns(text: string): string[] {
  const significant = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  if (significant[0] !== "packages:" || significant.length < 2 || significant.length > 65)
    throw new Error("bootstrap pnpm workspace must contain only a bounded packages list");
  const patterns = significant.slice(1).map((line) => {
    const match = /^\s{2}-\s+['"]?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/\*)['"]?$/.exec(line);
    const pattern = match?.[1];
    if (!pattern || pattern.split("/").some((part) => part === "." || part === ".."))
      throw new Error("bootstrap pnpm workspace contains an unsafe package pattern");
    return pattern;
  });
  if (new Set(patterns).size !== patterns.length)
    throw new Error("bootstrap pnpm workspace contains duplicate package patterns");
  return patterns;
}

async function workspaceManifestPaths(root: string, patterns: string[]): Promise<string[]> {
  const manifests: string[] = [];
  let entriesSeen = 0;
  for (const pattern of patterns) {
    const parent = pattern.slice(0, -2);
    let entries;
    try {
      entries = await readdir(join(root, parent), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    entriesSeen += entries.length;
    if (entriesSeen > 10_000) throw new Error("bootstrap pnpm workspace exceeds directory bound");
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        throw new Error(`bootstrap pnpm workspace contains a symlink: ${parent}/${entry.name}`);
      if (!entry.isDirectory()) continue;
      const manifestPath = posix.join(parent, entry.name, "package.json");
      try {
        const stat = await lstat(join(root, manifestPath));
        if (!stat.isFile())
          throw new Error(`bootstrap package manifest is not a regular file: ${manifestPath}`);
        manifests.push(manifestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return [...new Set(manifests)].sort();
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

function manifestDirectory(path: string): string {
  const directory = posix.dirname(path);
  return directory === "." ? "." : directory;
}

async function assertNoBootstrapPackageManagerConfig(
  root: string,
  manifestPaths: string[],
): Promise<void> {
  const directories = new Set(manifestPaths.map(manifestDirectory));
  for (const directory of directories) {
    for (const name of [".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs", ".pnpmfile.js"]) {
      const path = directory === "." ? name : posix.join(directory, name);
      try {
        await lstat(join(root, path));
        throw new Error(`bootstrap validation forbids package-manager configuration: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

/**
 * This is deliberately not a general YAML parser. It recognizes the bounded
 * pnpm v9 lock shape that a greenfield packet may introduce, rejects YAML
 * composition and exotic sources, and requires registry package integrity.
 * pnpm's frozen install remains the authoritative manifest/lock consistency
 * check after this pre-execution authority check passes.
 */
async function assertPnpmBootstrapLock(
  root: string,
  manifests: Array<{ path: string; manifest: PackageManifest }>,
): Promise<void> {
  const raw = await readBoundedRegularFile(root, "pnpm-lock.yaml", 4 * 1024 * 1024);
  if (raw.includes("\0") || raw.includes("\t") || raw.includes("${"))
    throw new Error("bootstrap pnpm lockfile contains unsupported syntax");
  const lines = raw.split(/\r?\n/);
  if (lines.length > 200_000 || lines.some((line) => line.length > 16_384))
    throw new Error("bootstrap pnpm lockfile exceeds structural bounds");

  const allowedTopLevel = new Set([
    "lockfileVersion",
    "settings",
    "importers",
    "packages",
    "snapshots",
  ]);
  const topLevel = new Set<string>();
  let section = "";
  let importer: string | null = null;
  const expectedImporters = new Set(manifests.map(({ path }) => manifestDirectory(path)));
  const seenImporters = new Set<string>();
  const packageBlocks: Array<{ key: string; lines: string[] }> = [];
  let packageBlock: { key: string; lines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (
      /^(?:---|\.\.\.)$/.test(trimmed) ||
      /(^|[\s:[{,])[&*][A-Za-z_][A-Za-z0-9_-]*/.test(line) ||
      /(^|\s)![A-Za-z<]/.test(line)
    )
      throw new Error("bootstrap pnpm lockfile may not use YAML composition");
    if (
      /(?:^|[\s{[,])(?:https?|git(?:\+[A-Za-z0-9+.-]+)?|ssh|file|portal|patch|npm|catalog):/i.test(
        line,
      ) ||
      /\btarball\s*:/i.test(line) ||
      /workspace:(?!\*)/.test(line)
    )
      throw new Error("bootstrap pnpm lockfile contains an exotic dependency source");

    const top = /^([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(line);
    if (top) {
      const key = top[1]!;
      if (!allowedTopLevel.has(key) || topLevel.has(key))
        throw new Error(`bootstrap pnpm lockfile has unsupported top-level authority: ${key}`);
      topLevel.add(key);
      section = key;
      importer = null;
      packageBlock = null;
      if (key === "lockfileVersion" && !/^\s*['"]9\.0['"]\s*$/.test(top[2]!))
        throw new Error("bootstrap pnpm lockfile must use lockfileVersion 9.0");
      continue;
    }

    if (section === "settings" && /^ {2}\S/.test(line)) {
      if (
        !/^ {2}(?:autoInstallPeers|excludeLinksFromLockfile|injectWorkspacePackages): (?:true|false)$/.test(
          line,
        )
      )
        throw new Error("bootstrap pnpm lockfile has unsupported settings authority");
      continue;
    }

    if (section === "importers") {
      const entry = /^ {2}(.+):(?:\s*\{\})?\s*$/.exec(line);
      if (entry) {
        importer = unquoteYamlScalar(entry[1]!);
        if (!expectedImporters.has(importer) || seenImporters.has(importer))
          throw new Error(`bootstrap pnpm lockfile has an unexpected importer: ${importer}`);
        seenImporters.add(importer);
      }
      for (const match of line.matchAll(/\blink:([^\s'",}\]]+)/g)) {
        if (!importer || !/^[A-Za-z0-9_./-]+$/.test(match[1]!))
          throw new Error("bootstrap pnpm lockfile contains an unsafe workspace link");
        const source = importer === "." ? "." : importer;
        const linked = posix.normalize(posix.join(source, match[1]!));
        if (linked.startsWith("../") || linked === ".." || !expectedImporters.has(linked))
          throw new Error(`bootstrap pnpm lockfile link escapes its workspace: ${match[1]}`);
      }
      if (line.includes("link:") && !/\blink:[^\s'",}\]]+/.test(line))
        throw new Error("bootstrap pnpm lockfile contains an unsafe workspace link");
      continue;
    }

    if (section === "packages") {
      const entry = /^ {2}(.+):\s*$/.exec(line);
      if (entry) {
        packageBlock = { key: unquoteYamlScalar(entry[1]!), lines: [] };
        packageBlocks.push(packageBlock);
      } else if (packageBlock) {
        packageBlock.lines.push(line);
      } else {
        throw new Error("bootstrap pnpm lockfile has malformed package entries");
      }
    }
  }

  for (const required of ["lockfileVersion", "importers"])
    if (!topLevel.has(required)) throw new Error(`bootstrap pnpm lockfile lacks ${required}`);
  for (const expected of expectedImporters)
    if (!seenImporters.has(expected))
      throw new Error(`bootstrap pnpm lockfile lacks workspace importer: ${expected}`);

  const packageKeys = new Set<string>();
  for (const block of packageBlocks) {
    if (
      !/^(?:@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?@)\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\(.+\))?$/.test(
        block.key,
      )
    )
      throw new Error(`bootstrap pnpm lockfile has an unsafe package identity: ${block.key}`);
    if (
      !block.lines.some((line) =>
        /\bresolution:\s*\{\s*integrity:\s*sha512-[A-Za-z0-9+/]{86}==\s*}\s*$/.test(line),
      )
    )
      throw new Error(`bootstrap pnpm lockfile package lacks sha512 integrity: ${block.key}`);
    packageKeys.add(block.key);
  }

  const externalDependencies = new Set<string>();
  for (const { manifest } of manifests) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [name, version] of Object.entries(
        stringRecord(manifest[field], `${field} in pnpm lockfile`),
      ))
        if (version !== "workspace:*") externalDependencies.add(`${name}@${version}`);
    }
  }
  if (externalDependencies.size > 0 && !topLevel.has("packages"))
    throw new Error("bootstrap pnpm lockfile lacks integrity-bound packages");
  for (const dependency of externalDependencies)
    if (![...packageKeys].some((key) => key === dependency || key.startsWith(`${dependency}(`)))
      throw new Error(`bootstrap pnpm lockfile lacks exact dependency: ${dependency}`);
}

async function assertTurboTaskConfiguration(root: string, script: string): Promise<void> {
  const parsed: unknown = JSON.parse(await readBoundedRegularFile(root, "turbo.json"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("bootstrap turbo configuration is invalid");
  const config = parsed as Record<string, unknown>;
  if (Object.keys(config).some((key) => key !== "$schema" && key !== "tasks"))
    throw new Error("bootstrap turbo configuration has unsupported top-level authority");
  if (!config.tasks || typeof config.tasks !== "object" || Array.isArray(config.tasks))
    throw new Error("bootstrap turbo configuration lacks tasks");
  const task = (config.tasks as Record<string, unknown>)[script];
  if (!task || typeof task !== "object" || Array.isArray(task))
    throw new Error(`bootstrap turbo configuration lacks task ${script}`);
  const taskConfig = task as Record<string, unknown>;
  if (Object.keys(taskConfig).some((key) => key !== "dependsOn"))
    throw new Error(`bootstrap turbo task ${script} has unsupported execution authority`);
  const dependsOn = taskConfig.dependsOn ?? [];
  if (
    !Array.isArray(dependsOn) ||
    dependsOn.length > 1 ||
    dependsOn.some((dependency) => dependency !== `^${script}`)
  )
    throw new Error(`bootstrap turbo task ${script} has an unsafe dependency closure`);
}

export interface BootstrapPackageValidation {
  manager: "pnpm";
  expectedVersion: string;
  versionCommand: typeof PNPM_BOOTSTRAP_VERSION_COMMAND;
  setupCommand: typeof PNPM_BOOTSTRAP_VALIDATION_SETUP_COMMAND;
  permittedSensitivePaths: Set<string>;
}

export async function assertBootstrapPackageValidation(
  worktree: Pick<LocalWorktree, "path">,
  artifact: NormalizedArtifact,
  packet: WorkerPacket,
  commands: string[],
): Promise<BootstrapPackageValidation | null> {
  const packageCommands = commands
    .map((command) => ({ command, parsed: bootstrapPackageValidationCommand(command) }))
    .filter(
      (
        value,
      ): value is {
        command: string;
        parsed: NonNullable<ReturnType<typeof bootstrapPackageValidationCommand>>;
      } => value.parsed !== null,
    );
  if (packageCommands.length === 0) return null;
  if (commands.length !== 1 || packageCommands.length !== 1)
    throw new Error("bootstrap validation requires exactly one pnpm package script");
  if (
    !artifact.changedPaths.includes("package.json") ||
    !packet.allowedPaths.includes("package.json")
  )
    throw new Error("bootstrap validation is not bound to a scoped package.json artifact");

  const changedManifestPaths = artifact.changedPaths.filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  const root = await readPackageManifest(worktree.path, "package.json");
  if (!root) throw new Error("bootstrap validation lacks its root package manifest");
  const { parsed } = packageCommands[0]!;
  if (!packet.requirements.tools.includes(parsed.manager))
    throw new Error("bootstrap validation package manager is not a declared tool");
  if (!packet.requirements.networkDestinations.includes(PNPM_BOOTSTRAP_REGISTRY))
    throw new Error("bootstrap validation must declare registry.npmjs.org network access");
  if (
    typeof root.packageManager !== "string" ||
    !/^pnpm@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(root.packageManager) ||
    !artifact.changedPaths.includes("pnpm-lock.yaml") ||
    !packet.allowedPaths.includes("pnpm-lock.yaml")
  )
    throw new Error(
      "bootstrap pnpm validation requires a pinned packageManager and scoped lockfile",
    );

  assertPackageManifestSafety(root, "package.json");
  const rootScripts = stringRecord(root.scripts, "scripts in package.json");
  const rootScript = rootScripts[parsed.script];
  if (!rootScript) throw new Error(`bootstrap validation script is absent: ${parsed.script}`);
  if (rootScripts[`pre${parsed.script}`] || rootScripts[`post${parsed.script}`])
    throw new Error(`bootstrap validation script has lifecycle hooks: ${parsed.script}`);

  const turbo = new RegExp(`^turbo run ${parsed.script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const permittedSensitivePaths = new Set(["package.json", "pnpm-lock.yaml"]);
  if (turbo.test(rootScript)) {
    if (!pinnedDependency(root, "turbo"))
      throw new Error("bootstrap turbo runner is not pinned in the root package manifest");
    assertSafeValidationCommand(rootScript, ["turbo"]);
    for (const path of ["pnpm-workspace.yaml", "turbo.json"])
      if (!artifact.changedPaths.includes(path) || !packet.allowedPaths.includes(path))
        throw new Error(`bootstrap validation is not bound to a scoped ${path} artifact`);
    const patterns = parsePnpmWorkspacePatterns(
      await readBoundedRegularFile(worktree.path, "pnpm-workspace.yaml"),
    );
    await assertTurboTaskConfiguration(worktree.path, parsed.script);
    const workspaceManifests = await workspaceManifestPaths(worktree.path, patterns);
    const materializedManifests: Array<{ path: string; manifest: PackageManifest }> = [
      { path: "package.json", manifest: root },
    ];
    const expectedManifests = new Set(["package.json", ...workspaceManifests]);
    for (const path of changedManifestPaths)
      if (!expectedManifests.has(path))
        throw new Error(`bootstrap package manifest is outside the declared workspace: ${path}`);
    for (const path of workspaceManifests) {
      if (!pathIsAllowed(path, packet.allowedPaths))
        throw new Error(`bootstrap workspace package is outside Work Item scope: ${path}`);
      const manifest = await readPackageManifest(worktree.path, path);
      assertPackageManifestSafety(manifest, path);
      materializedManifests.push({ path, manifest });
      permittedSensitivePaths.add(path);
      const scripts = stringRecord(manifest.scripts, `scripts in ${path}`);
      const body = scripts[parsed.script];
      if (!body) continue;
      if (scripts[`pre${parsed.script}`] || scripts[`post${parsed.script}`])
        throw new Error(`bootstrap package script has lifecycle hooks: ${path}`);
      assertSafeBootstrapLeafScript(body, { ...root, ...manifest }, path, packet.allowedPaths);
    }
    await assertNoBootstrapPackageManagerConfig(worktree.path, [...expectedManifests]);
    await assertPnpmBootstrapLock(worktree.path, materializedManifests);
    permittedSensitivePaths.add("pnpm-workspace.yaml");
    permittedSensitivePaths.add("turbo.json");
  } else {
    if (changedManifestPaths.some((path) => path !== "package.json"))
      throw new Error("bootstrap leaf validation may not authorize unrelated package manifests");
    assertSafeBootstrapLeafScript(rootScript, root, "package.json", packet.allowedPaths);
    await assertNoBootstrapPackageManagerConfig(worktree.path, ["package.json"]);
    await assertPnpmBootstrapLock(worktree.path, [{ path: "package.json", manifest: root }]);
  }
  return {
    manager: "pnpm",
    expectedVersion: root.packageManager.slice("pnpm@".length),
    versionCommand: PNPM_BOOTSTRAP_VERSION_COMMAND,
    setupCommand: PNPM_BOOTSTRAP_VALIDATION_SETUP_COMMAND,
    permittedSensitivePaths,
  };
}

export function isBootstrapDependencySurface(
  paths: string[],
  validation: Pick<BootstrapPackageValidation, "permittedSensitivePaths"> | null,
): boolean {
  return Boolean(validation && paths.every((path) => validation.permittedSensitivePaths.has(path)));
}

function isPotentialBootstrapDependencySurface(paths: string[], managers: Set<"pnpm">): boolean {
  return (
    managers.has("pnpm") &&
    paths.every(
      (path) =>
        path === "package.json" ||
        path === "pnpm-lock.yaml" ||
        path === "pnpm-workspace.yaml" ||
        path === "turbo.json" ||
        path.endsWith("/package.json"),
    )
  );
}

async function pnpmBootstrapEnvironment(
  source: NodeJS.ProcessEnv,
  worktreeRoot: string,
): Promise<NodeJS.ProcessEnv> {
  const environment = sanitizedWorkerEnvironment(source);
  for (const key of Object.keys(environment))
    if (/^(?:npm_config_|pnpm_)/i.test(key)) delete environment[key];
  const configRoot = join(worktreeRoot, "pnpm-config");
  await mkdir(configRoot, { recursive: true });
  return {
    ...environment,
    BASH_ENV: "/dev/null",
    CI: "true",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    ENV: "/dev/null",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    XDG_CONFIG_HOME: configRoot,
    NPM_CONFIG_USERCONFIG: "/dev/null",
    npm_config_dangerously_allow_all_builds: "false",
    npm_config_enable_global_virtual_store: "false",
    npm_config_enable_pre_post_scripts: "false",
    npm_config_frozen_lockfile: "true",
    npm_config_ignore_scripts: "true",
    npm_config_lockfile: "true",
    npm_config_manage_package_manager_versions: "false",
    npm_config_modules_dir: "node_modules",
    npm_config_node_linker: "isolated",
    npm_config_package_import_method: "copy",
    npm_config_registry: `https://${PNPM_BOOTSTRAP_REGISTRY}/`,
    npm_config_script_shell: "/bin/sh",
    npm_config_side_effects_cache: "false",
    npm_config_strict_store_pkg_content_check: "true",
    npm_config_symlink: "true",
    npm_config_use_running_store_server: "false",
    npm_config_verify_deps_before_run: "error",
    npm_config_verify_store_integrity: "true",
    npm_config_virtual_store_dir: "node_modules/.pnpm",
  };
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
  assertNoSecretMaterial({ patch: artifact.patch, logs: artifact.logs }, "artifact");

  const plan = validationPlanFromPacket(input.packet);
  const potentialBootstrapManagers = new Set(
    plan.commands.flatMap((command) => {
      const parsed = bootstrapPackageValidationCommand(command);
      return parsed ? [parsed.manager] : [];
    }),
  );
  if (
    sensitive.length > 0 &&
    (!artifact.changedPaths.includes("package.json") ||
      !input.packet.allowedPaths.includes("package.json") ||
      !isPotentialBootstrapDependencySurface(sensitive, potentialBootstrapManagers))
  )
    throw new Error(`artifact touches a sensitive surface: ${sensitive.join(", ")}`);
  if (plan.isolation === "isolated" && !input.isolatedValidator) {
    throw new Error("untrusted validation requires an isolated validation backend");
  }
  if (
    input.localScope &&
    (plan.isolation === "isolated" ||
      input.isolatedValidator !== undefined ||
      input.localScope.identity.phase !== "validation" ||
      input.localScope.identity.invocationDigest !== artifact.digest)
  ) {
    throw new Error("local validation scope must bind this exact trusted-local artifact");
  }

  let commandIndex = 0;
  const runLocalCommand = async (options: StartProcessOptions) => {
    if (!input.localScope) return runContainedProcess(options);
    const identity = parseLocalScopeIdentity({
      ...input.localScope.identity,
      commandIndex: commandIndex++,
    });
    await input.localScope.beforeLaunch(identity);
    const remaining = Date.parse(input.localScope.deadline) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new Error("local validation launch deadline expired");
    const result = await runScopedLocalProcess(identity, {
      ...options,
      timeoutMs: Math.min(options.timeoutMs, remaining),
      launchDeadline: new Date(input.localScope.deadline),
    });
    await input.localScope.afterStop(identity);
    return result;
  };

  const startedAt = new Date();
  const worktree = await createLocalWorktree(input.repository, artifact.baseSha);
  const basePackageJsonPresent = await access(join(worktree.path, "package.json")).then(
    () => true,
    () => false,
  );
  const commands: Array<{ command: string; exitCode: number; durationMs: number }> = [];
  let passed = false;
  let failureReason: string | undefined;
  try {
    const patchPath = join(worktree.root, "artifact.patch");
    await materializeArtifactPatch(artifact, patchPath);
    const trustedManifest = await inspectPatchManifest(
      input.repository,
      artifact.baseSha,
      patchPath,
      artifact.changedPaths,
    );
    if (
      artifact.fileManifest &&
      JSON.stringify(artifact.fileManifest) !== JSON.stringify(trustedManifest)
    )
      throw new Error("artifact manifest differs from actual Git blob identities");
    assertFilesystemArtifactManifest(trustedManifest);
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
    if (trustedManifest) {
      if (
        trustedManifest.resultTreeSha !== outputTreeSha ||
        trustedManifest.baseTreeSha !==
          (await git(worktree, ["rev-parse", `${artifact.baseSha}^{tree}`]))
      )
        throw new Error("applied artifact tree differs from trusted collection manifest");
      await verifyMaterializedFiles(worktree.path, trustedManifest);
    }
    const bootstrapValidation = basePackageJsonPresent
      ? null
      : await assertBootstrapPackageValidation(worktree, artifact, input.packet, plan.commands);
    const bootstrapDependencySurface = isBootstrapDependencySurface(sensitive, bootstrapValidation);
    if (sensitive.length > 0 && !bootstrapDependencySurface)
      throw new Error(`artifact touches a sensitive surface: ${sensitive.join(", ")}`);
    const setupCommands = bootstrapValidation
      ? [bootstrapValidation.versionCommand, bootstrapValidation.setupCommand]
      : (await hasNpmLockfile(worktree))
        ? [NPM_VALIDATION_SETUP_COMMAND]
        : [];
    const bootstrapEnvironment = bootstrapValidation
      ? await pnpmBootstrapEnvironment(process.env, worktree.root)
      : null;
    let evidenceStartedAt = startedAt.toISOString();
    let evidenceCompletedAt: string;
    let environmentIdentity: string | undefined;
    if (plan.isolation === "isolated" || input.isolatedValidator) {
      const isolated = await input.isolatedValidator!();
      if (isolated.outputTreeSha !== outputTreeSha) {
        throw new Error(
          `isolated validator tree ${isolated.outputTreeSha} does not match host tree ${outputTreeSha}`,
        );
      }
      const expectedCommands = [...setupCommands, ...plan.commands];
      assertIsolatedValidationMatchesPlan(isolated, expectedCommands);
      commands.push(...isolated.commands);
      passed = isolated.passed;
      failureReason = isolated.failureReason;
      evidenceStartedAt = isolated.startedAt;
      evidenceCompletedAt = isolated.completedAt;
      environmentIdentity = isolated.environmentIdentity;
    } else {
      const localCommands = setupCommands.map((command) =>
        command === NPM_VALIDATION_SETUP_COMMAND
          ? {
              command,
              executable: "npm",
              args: ["ci", "--no-audit", "--no-fund"],
            }
          : command === PNPM_BOOTSTRAP_VERSION_COMMAND
            ? {
                command,
                executable: "pnpm",
                args: ["--version"],
              }
            : {
                command,
                executable: "pnpm",
                args: [
                  "install",
                  "--frozen-lockfile",
                  "--ignore-scripts",
                  `--registry=https://${PNPM_BOOTSTRAP_REGISTRY}/`,
                ],
              },
      );
      for (const setup of localCommands) {
        const result = await runLocalCommand({
          command: setup.executable,
          args: setup.args,
          cwd: worktree.path,
          env: bootstrapEnvironment ?? sanitizedWorkerEnvironment(process.env),
          timeoutMs: plan.timeoutMsPerCommand,
        });
        const versionMismatch =
          setup.command === PNPM_BOOTSTRAP_VERSION_COMMAND &&
          result.exitCode === 0 &&
          result.stdout.trim() !== bootstrapValidation?.expectedVersion;
        const exitCode = versionMismatch ? 1 : (result.exitCode ?? (result.timedOut ? 124 : 1));
        commands.push({
          command: setup.command,
          exitCode,
          durationMs: result.durationMs,
        });
        if (exitCode !== 0) {
          failureReason = versionMismatch
            ? `validation setup used pnpm ${JSON.stringify(result.stdout.trim().slice(0, 100))}, expected ${bootstrapValidation?.expectedVersion}`
            : validationFailureReason("validation setup", setup.command, result);
          break;
        }
      }
      for (const command of failureReason ? [] : plan.commands) {
        const result = await runLocalCommand({
          command: "/bin/sh",
          args: ["-c", command],
          cwd: worktree.path,
          env: bootstrapEnvironment ?? sanitizedWorkerEnvironment(process.env),
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
    // Do not remove a workspace while an escaped command may still be using it.
    // The unresolved scope remains a recovery liability, not successful validation.
    if (error instanceof LocalScopeCleanupError) throw error;
    await cleanupLocalWorktree(worktree);
    throw error;
  }
}

export async function discardValidationResult(result: CleanValidationResult): Promise<void> {
  await cleanupLocalWorktree(result.worktree);
}
