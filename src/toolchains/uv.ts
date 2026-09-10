import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, posix, resolve } from "node:path";

import {
  assertRuntimeBundleReceipt,
  type ManagedExecutionStep,
  type ManagedRuntimeAsset,
  type ManagedToolchainPlan,
  type RuntimeBundleReceipt,
  type RuntimeComponentReceipt,
} from "../runtime/toolchain-bundle.js";
import { runtimeComponentPaths, verifyRuntimeBundle } from "../runtime/toolchain-store.js";

const EXACT_UV_VERSION = /^\d+\.\d+\.\d+$/;
const EXACT_PYTHON_VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_PROJECT_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MARKER = /^[A-Za-z0-9_. ,'"<>=!()-]+$/;
const PYPI_REGISTRY = "https://pypi.org/simple";
const SHA256 = /^sha256:[a-f0-9]{64}$/;

export const UV_ADAPTER_ID = "python-uv";
export const UV_PYTEST_OPERATION_KIND = "python-test";

export interface UvPytestCommand {
  runner: "uv";
  projectDirectory: string;
  argv: readonly ["run", "--locked", "--no-sync", "python", "-m", "pytest"];
}

export interface UvCapabilityOperation {
  kind: typeof UV_PYTEST_OPERATION_KIND;
  key: string;
}

export interface UvAuthorityInspectionInput {
  command: UvPytestCommand;
  /** Repository-relative text files, keyed by canonical `/`-separated paths. */
  files: Readonly<Record<string, string>>;
  /** All repository paths are required so alternate managers and configuration cannot hide. */
  repositoryPaths: readonly string[];
  uvVersion: string;
  pythonVersion: string;
}

export interface UvAuthorityInspection {
  adapter: typeof UV_ADAPTER_ID;
  operation: UvCapabilityOperation;
  projectDirectory: string;
  projectName: string;
  authorityPaths: string[];
  uvVersion: string;
  pythonVersion: string;
  dependencyGroups: string[];
  lockedPackages: number;
}

export interface UvManagedExecutionStep extends ManagedExecutionStep {
  executable: string;
}

export interface UvManagedExecutionPlan {
  adapter: typeof UV_ADAPTER_ID;
  receiptDigest: string;
  uvVersion: string;
  pythonVersion: string;
  environment: Record<string, string>;
  setup: UvManagedExecutionStep[];
  validation: UvManagedExecutionStep[];
}

export interface UvManagedExecutionPlanInput {
  receipt: RuntimeBundleReceipt;
  storeRoot: string;
  privateRoot: string;
  projectDirectory?: string;
}

interface TomlDocument {
  sections: Map<string, Map<string, string>>;
}

interface ProjectAuthority {
  name: string;
  dependencies: string[];
  dependencyGroups: Map<string, string[]>;
}

function safeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

export function normalizeUvProjectDirectory(value: string): string | null {
  if (value === ".") return value;
  if (!safeRepositoryPath(value)) return null;
  const parts = value.split("/");
  return parts.every((part) => SAFE_PROJECT_PART.test(part)) ? parts.join("/") : null;
}

/** Parse one canonical uv/pytest entry point without invoking or emulating a shell. */
export function parseUvPytestCommand(command: string): UvPytestCommand | null {
  const tokens = command.trim().split(/\s+/);
  const root = ["uv", "run", "--locked", "--no-sync", "python", "-m", "pytest"];
  if (tokens.length === root.length && tokens.every((token, index) => token === root[index])) {
    return {
      runner: "uv",
      projectDirectory: ".",
      argv: ["run", "--locked", "--no-sync", "python", "-m", "pytest"],
    };
  }
  if (
    tokens.length !== root.length + 2 ||
    tokens[0] !== "uv" ||
    tokens[1] !== "run" ||
    tokens[2] !== "--project" ||
    tokens.slice(4).some((token, index) => token !== root[index + 2])
  )
    return null;
  const projectDirectory = normalizeUvProjectDirectory(tokens[3]!);
  if (!projectDirectory || projectDirectory === ".") return null;
  return {
    runner: "uv",
    projectDirectory,
    argv: ["run", "--locked", "--no-sync", "python", "-m", "pytest"],
  };
}

export function uvPytestOperation(command: string | UvPytestCommand): UvCapabilityOperation | null {
  const parsed = typeof command === "string" ? parseUvPytestCommand(command) : command;
  const projectDirectory = parsed ? normalizeUvProjectDirectory(parsed.projectDirectory) : null;
  if (!parsed || parsed.runner !== "uv" || !projectDirectory) return null;
  return { kind: UV_PYTEST_OPERATION_KIND, key: projectDirectory };
}

/** Reconstruct the one canonical pytest command represented by a persisted operation. */
export function uvPytestCommandForOperation(operation: {
  kind: string;
  key: string;
}): UvPytestCommand | null {
  if (operation.kind !== UV_PYTEST_OPERATION_KIND) return null;
  const command =
    operation.key === "."
      ? "uv run --locked --no-sync python -m pytest"
      : `uv run --project ${operation.key} --locked --no-sync python -m pytest`;
  const parsed = parseUvPytestCommand(command);
  return parsed && uvPytestOperation(parsed)?.key === operation.key ? parsed : null;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = null;
      else if (quote === null) quote = character;
      continue;
    }
    if (character === "#" && quote === null) return line.slice(0, index);
  }
  if (quote !== null) throw new Error("multiline or unterminated TOML strings are unsupported");
  return line;
}

function bracketBalance(value: string): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let balance = 0;
  for (const character of value) {
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = null;
      else if (quote === null) quote = character;
    } else if (quote === null && character === "[") balance += 1;
    else if (quote === null && character === "]") balance -= 1;
  }
  return balance;
}

function parseToml(text: string, label: string): TomlDocument {
  const sections = new Map<string, Map<string, string>>([["", new Map()]]);
  let section = "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]!).trim();
    if (!line) continue;
    if (line.startsWith("[[")) throw new Error(`${label} contains unsupported array tables`);
    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      if (sections.has(section)) throw new Error(`${label} repeats TOML section [${section}]`);
      sections.set(section, new Map());
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) throw new Error(`${label} contains unsupported TOML syntax`);
    const key = assignment[1]!;
    let value = assignment[2]!;
    let balance = bracketBalance(value);
    while (balance > 0 && index + 1 < lines.length) {
      index += 1;
      const continuation = stripTomlComment(lines[index]!).trim();
      value += `\n${continuation}`;
      balance = bracketBalance(value);
    }
    if (balance !== 0) throw new Error(`${label} contains an unbalanced TOML array`);
    const values = sections.get(section)!;
    if (values.has(key)) throw new Error(`${label} repeats TOML key ${key}`);
    values.set(key, value.trim());
  }
  return { sections };
}

function tomlString(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`${label} is required`);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // Emit the stable authority error below.
    }
  } else if (value.startsWith("'") && value.endsWith("'") && !value.slice(1, -1).includes("'")) {
    return value.slice(1, -1);
  }
  throw new Error(`${label} must be one plain TOML string`);
}

function tomlBoolean(value: string | undefined, label: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be a TOML boolean`);
}

function tomlStringArray(value: string | undefined, label: string): string[] {
  if (value === undefined) return [];
  const source = value.trim();
  if (!source.startsWith("[") || !source.endsWith("]"))
    throw new Error(`${label} must be an array of plain strings`);
  const result: string[] = [];
  let index = 1;
  while (index < source.length - 1) {
    while (/[,\s]/.test(source[index] ?? "")) index += 1;
    if (index >= source.length - 1) break;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") throw new Error(`${label} may contain only plain strings`);
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length - 1) {
      const character = source[index]!;
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) break;
      index += 1;
    }
    if (source[index] !== quote) throw new Error(`${label} contains an unterminated string`);
    result.push(tomlString(source.slice(start, index + 1), label));
    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index < source.length - 1 && source[index] !== ",")
      throw new Error(`${label} must separate values with commas`);
  }
  return result;
}

function section(document: TomlDocument, name: string): Map<string, string> {
  return document.sections.get(name) ?? new Map();
}

function exactRequirement(requirement: string, label: string): { name: string; version: string } {
  if (/[@/\\]|\b(?:git|https?|file|path|editable)\b/i.test(requirement))
    throw new Error(`${label} contains a URL, VCS, path, or editable dependency`);
  const match =
    /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?==([^;\s*]+)(?:\s*;\s*(.+))?$/.exec(
      requirement,
    );
  if (!match || !SAFE_PACKAGE_NAME.test(match[1]!))
    throw new Error(`${label} must pin every dependency with ==`);
  if (match[3] && !SAFE_MARKER.test(match[3]))
    throw new Error(`${label} contains an unsupported environment marker`);
  return { name: match[1]!.toLowerCase().replaceAll("_", "-"), version: match[2]! };
}

function inspectProject(
  text: string,
  label: string,
  uvVersion: string,
  requireRuntimePin: boolean,
): ProjectAuthority {
  const document = parseToml(text, label);
  for (const name of document.sections.keys()) {
    if (
      name === "build-system" ||
      name === "project.scripts" ||
      name === "project.gui-scripts" ||
      name === "project.entry-points" ||
      name.startsWith("project.entry-points.") ||
      name === "tool.uv.sources" ||
      name.startsWith("tool.uv.sources.") ||
      name === "tool.uv.index" ||
      name.startsWith("tool.uv.index.")
    )
      throw new Error(`${label} contains a build, executable, custom-index, or source surface`);
  }
  const project = section(document, "project");
  if (project.has("dynamic")) throw new Error(`${label} may not use dynamic project metadata`);
  const name = tomlString(project.get("name"), `${label} project.name`);
  if (!SAFE_PACKAGE_NAME.test(name)) throw new Error(`${label} project.name is invalid`);

  const toolUv = section(document, "tool.uv");
  if (tomlBoolean(toolUv.get("package"), `${label} tool.uv.package`) !== false)
    throw new Error(`${label} must set tool.uv.package = false`);
  const allowedUvKeys = new Set(["package", "required-version"]);
  if ([...toolUv.keys()].some((key) => !allowedUvKeys.has(key)))
    throw new Error(`${label} contains unsupported uv configuration`);
  if (requireRuntimePin) {
    const required = tomlString(
      toolUv.get("required-version"),
      `${label} tool.uv.required-version`,
    );
    if (required !== `==${uvVersion}`)
      throw new Error(`${label} must require the exact managed uv version ==${uvVersion}`);
  } else if (toolUv.has("required-version")) {
    throw new Error(`${label} member must inherit the root uv runtime pin`);
  }

  const dependencies = tomlStringArray(project.get("dependencies"), `${label} dependencies`);
  for (const dependency of dependencies) exactRequirement(dependency, `${label} dependencies`);
  const groups = new Map<string, string[]>();
  for (const [group, raw] of section(document, "dependency-groups")) {
    const dependencies = tomlStringArray(raw, `${label} dependency group ${group}`);
    for (const dependency of dependencies)
      exactRequirement(dependency, `${label} dependency group ${group}`);
    groups.set(group, dependencies);
  }
  return { name, dependencies, dependencyGroups: groups };
}

const FORBIDDEN_AUTHORITY_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".uv.toml",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pdm.lock",
  "pip.conf",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "requirements.txt",
  "setup.cfg",
  "setup.py",
  "uv.toml",
  "yarn.lock",
]);

function uvAuthorityDirectories(projectDirectory: string): Set<string> {
  const directories = new Set(["."]);
  if (projectDirectory === ".") return directories;
  const parts = projectDirectory.split("/");
  for (let index = 1; index <= parts.length; index += 1)
    directories.add(parts.slice(0, index).join("/"));
  return directories;
}

function assertNoAlternateAuthority(paths: readonly string[], projectDirectory: string): void {
  const authorityDirectories = uvAuthorityDirectories(projectDirectory);
  for (const path of paths) {
    if (!safeRepositoryPath(path)) throw new Error(`repository path escapes authority: ${path}`);
    const name = path.split("/").at(-1)!.toLowerCase();
    const directory = posix.dirname(path);
    if (authorityDirectories.has(directory) && FORBIDDEN_AUTHORITY_NAMES.has(name))
      throw new Error(
        `uv authority may not mix package managers or external configuration: ${path}`,
      );
  }
}

function declaredWorkspaceMembers(rootText: string): string[] {
  const workspace = section(parseToml(rootText, "pyproject.toml"), "tool.uv.workspace");
  if (workspace.size === 0) return [];
  if ([...workspace.keys()].some((key) => key !== "members"))
    throw new Error("uv workspace contains unsupported selection configuration");
  const members = tomlStringArray(workspace.get("members"), "tool.uv.workspace.members");
  if (
    members.length === 0 ||
    members.some((member) => normalizeUvProjectDirectory(member) !== member) ||
    new Set(members).size !== members.length
  )
    throw new Error("uv workspace must declare exact unique members");
  return members;
}

/** Load root and complete declared-workspace authority plus config-search ancestors. */
export async function loadUvAuthoritySurface(
  root: string,
  projectDirectories: readonly string[],
): Promise<{ files: Record<string, string>; repositoryPaths: string[] }> {
  if (!isAbsolute(root)) throw new Error("uv repository root must be absolute");
  const absoluteRoot = resolve(root);
  const selected = [...new Set(projectDirectories.map(normalizeUvProjectDirectory))];
  if (selected.some((directory) => directory === null))
    throw new Error("uv project directory escapes repository authority");
  const rootManifest = join(absoluteRoot, "pyproject.toml");
  const rootStat = await lstat(rootManifest);
  if (!rootStat.isFile() || rootStat.isSymbolicLink() || rootStat.size > 4 * 1024 * 1024)
    throw new Error("uv authority is not a bounded regular file: pyproject.toml");
  const rootText = await readFile(rootManifest, "utf8");
  const workspaceMembers = declaredWorkspaceMembers(rootText);
  if (
    selected.some(
      (directory) => directory !== "." && !workspaceMembers.includes(directory as string),
    )
  )
    throw new Error("uv project is not an exact declared workspace member");
  const authorityDirectories = new Set([
    ...(selected as string[]),
    ...(selected.some((directory) => directory !== ".") ? workspaceMembers : []),
  ]);
  const directories = new Set<string>();
  for (const directory of authorityDirectories)
    for (const ancestor of uvAuthorityDirectories(directory)) directories.add(ancestor);
  const repositoryPaths = new Set<string>();
  for (const directory of directories) {
    const absolute = directory === "." ? absoluteRoot : join(absoluteRoot, directory);
    if (directory !== ".") {
      const stat = await lstat(absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`uv authority ancestor is not a real directory: ${directory}`);
    }
    const entries = await readdir(absolute, { withFileTypes: true });
    if (entries.length > 10_000)
      throw new Error(`uv authority directory exceeds bound: ${directory}`);
    for (const entry of entries) {
      const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
      repositoryPaths.add(path);
    }
  }
  const authorityFiles = new Set(["pyproject.toml", "uv.lock", ".python-version"]);
  for (const directory of authorityDirectories)
    if (directory !== ".") authorityFiles.add(`${directory}/pyproject.toml`);
  const files: Record<string, string> = { "pyproject.toml": rootText };
  for (const path of authorityFiles) {
    if (path === "pyproject.toml") {
      repositoryPaths.add(path);
      continue;
    }
    const absolute = join(absoluteRoot, path);
    if (!absolute.startsWith(`${absoluteRoot}/`))
      throw new Error(`uv authority file escapes repository root: ${path}`);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`uv authority is not a bounded regular file: ${path}`);
    if (stat.size > 4 * 1024 * 1024) throw new Error(`uv authority file exceeds bound: ${path}`);
    files[path] = await readFile(absolute, "utf8");
    repositoryPaths.add(path);
  }
  return { files, repositoryPaths: [...repositoryPaths].sort() };
}

function parseInlineSource(
  block: string,
  label: string,
): { kind: "registry" | "virtual"; value: string } {
  const match = /^\s*source\s*=\s*\{([^}]+)\}\s*$/m.exec(block);
  if (!match) throw new Error(`${label} must declare one lock source`);
  const fields = [...match[1]!.matchAll(/([A-Za-z-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)];
  if (fields.length !== 1) throw new Error(`${label} contains an unsupported lock source`);
  const key = fields[0]![1]!;
  const value = tomlString(fields[0]![2], `${label} source`);
  if (key === "registry") return { kind: "registry", value };
  if (key === "virtual") return { kind: "virtual", value };
  throw new Error(`${label} contains a VCS, URL, path, editable, or workspace source`);
}

function inspectLock(
  text: string,
  pythonVersion: string,
  permittedVirtualPaths: ReadonlySet<string>,
  requirements: readonly { name: string; version: string }[],
): number {
  if (/^\s*sdist\s*=/m.test(text)) throw new Error("uv.lock contains a source distribution");
  const markerAssignments = [...text.matchAll(/\bmarker\s*=/g)];
  const markers = [...text.matchAll(/\bmarker\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)];
  if (
    markerAssignments.length !== markers.length ||
    markers.some((match) => !SAFE_MARKER.test(tomlString(match[1], "uv.lock marker")))
  )
    throw new Error("uv.lock contains an unsupported environment marker");
  const chunks = text.replace(/\r\n?/g, "\n").split(/^\[\[package\]\]\s*$/m);
  const header = chunks.shift()!;
  if (!/^\s*version\s*=\s*1\s*$/m.test(header)) throw new Error("uv.lock version 1 is required");
  const lockedPython = /^\s*requires-python\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$/m.exec(header);
  if (
    !lockedPython ||
    tomlString(lockedPython[1], "uv.lock requires-python") !== `==${pythonVersion}`
  )
    throw new Error(`uv.lock must require the exact managed Python version ==${pythonVersion}`);

  const packages = new Map<string, Set<string>>();
  for (const [index, block] of chunks.entries()) {
    const label = `uv.lock package ${index + 1}`;
    if (/^\s*(?:sdist|editable|git|directory|path)\s*=/m.test(block))
      throw new Error(`${label} contains a build, VCS, path, editable, or sdist surface`);
    const nameMatch = /^\s*name\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$/m.exec(block);
    const versionMatch = /^\s*version\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$/m.exec(block);
    const name = tomlString(nameMatch?.[1], `${label} name`).toLowerCase().replaceAll("_", "-");
    const version = tomlString(versionMatch?.[1], `${label} version`);
    const source = parseInlineSource(block, label);
    if (source.kind === "registry") {
      if (source.value !== PYPI_REGISTRY) throw new Error(`${label} uses a custom package index`);
      const wheels = /^\s*wheels\s*=\s*\[([\s\S]*?)\]\s*$/m.exec(block);
      if (!wheels) throw new Error(`${label} is not wheel-only`);
      const records = [...wheels[1]!.matchAll(/\{([^}]+)\}/g)];
      if (records.length === 0) throw new Error(`${label} is not wheel-only`);
      for (const record of records) {
        const hash = /\bhash\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(record[1]!);
        const url = /\burl\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(record[1]!);
        if (!hash || !SHA256.test(tomlString(hash[1], `${label} wheel hash`)))
          throw new Error(`${label} wheel is missing an exact SHA-256 hash`);
        if (
          !url ||
          !tomlString(url[1], `${label} wheel URL`).startsWith("https://files.pythonhosted.org/")
        )
          throw new Error(`${label} wheel does not use the canonical PyPI file host`);
      }
    } else if (!permittedVirtualPaths.has(source.value)) {
      throw new Error(`${label} escapes the declared project or workspace`);
    }
    const versions = packages.get(name) ?? new Set<string>();
    versions.add(version);
    packages.set(name, versions);
  }
  if (chunks.length === 0) throw new Error("uv.lock has no locked packages");
  for (const requirement of requirements) {
    if (!packages.get(requirement.name)?.has(requirement.version))
      throw new Error(
        `uv.lock does not contain exact dependency ${requirement.name}==${requirement.version}`,
      );
  }
  return chunks.length;
}

function authorityPath(directory: string, name: string): string {
  return directory === "." ? name : `${directory}/${name}`;
}

export function inspectUvAuthority(input: UvAuthorityInspectionInput): UvAuthorityInspection {
  if (!EXACT_UV_VERSION.test(input.uvVersion)) throw new Error("managed uv version must be exact");
  if (!EXACT_PYTHON_VERSION.test(input.pythonVersion))
    throw new Error("managed Python version must be an exact stable patch");
  const projectDirectory = normalizeUvProjectDirectory(input.command.projectDirectory);
  if (!projectDirectory) throw new Error("uv project directory escapes repository authority");
  assertNoAlternateAuthority(input.repositoryPaths, projectDirectory);
  const knownPaths = new Set(input.repositoryPaths);
  if (Object.keys(input.files).some((path) => !knownPaths.has(path)))
    throw new Error("uv authority file inventory is incomplete");

  const rootText = input.files["pyproject.toml"];
  const lockText = input.files["uv.lock"];
  const pythonText = input.files[".python-version"];
  if (rootText === undefined || lockText === undefined || pythonText === undefined)
    throw new Error(
      "uv authority requires pyproject.toml, uv.lock, and .python-version at the root",
    );
  if (pythonText.trim() !== input.pythonVersion || pythonText.trim().split(/\s+/).length !== 1)
    throw new Error(`.python-version must contain only ${input.pythonVersion}`);

  const root = inspectProject(rootText, "pyproject.toml", input.uvVersion, true);
  const authorityPaths = ["pyproject.toml", "uv.lock", ".python-version"];
  const projects = [root];
  const permittedVirtualPaths = new Set(["."]);
  let selected = root;
  const workspaceMembers = declaredWorkspaceMembers(rootText);
  if (projectDirectory === ".") {
    if (workspaceMembers.length > 0)
      throw new Error("root uv validation may not implicitly select a workspace");
  } else {
    if (!workspaceMembers.includes(projectDirectory))
      throw new Error("uv project is not an exact declared workspace member");
    for (const member of workspaceMembers) {
      const memberPath = authorityPath(member, "pyproject.toml");
      const memberText = input.files[memberPath];
      if (memberText === undefined) throw new Error(`uv workspace member is missing ${memberPath}`);
      const project = inspectProject(memberText, memberPath, input.uvVersion, false);
      projects.push(project);
      permittedVirtualPaths.add(member);
      authorityPaths.push(memberPath);
      if (member === projectDirectory) selected = project;
    }
  }

  const requiresPython = tomlString(
    section(
      parseToml(
        input.files[authorityPath(projectDirectory, "pyproject.toml")]!,
        "selected pyproject.toml",
      ),
      "project",
    ).get("requires-python"),
    "project.requires-python",
  );
  if (requiresPython !== `==${input.pythonVersion}`)
    throw new Error(`project.requires-python must equal ==${input.pythonVersion}`);
  const dev = selected.dependencyGroups.get("dev") ?? [];
  if (!dev.some((dependency) => exactRequirement(dependency, "dev dependency").name === "pytest"))
    throw new Error("the selected project must pin pytest in dependency-groups.dev");

  const requirements = projects
    .flatMap((project) => [
      ...project.dependencies,
      ...[...project.dependencyGroups.values()].flat(),
    ])
    .map((requirement) => exactRequirement(requirement, "project dependency"));
  const lockedPackages = inspectLock(
    lockText,
    input.pythonVersion,
    permittedVirtualPaths,
    requirements,
  );
  return {
    adapter: UV_ADAPTER_ID,
    operation: { kind: UV_PYTEST_OPERATION_KIND, key: projectDirectory },
    projectDirectory,
    projectName: selected.name,
    authorityPaths,
    uvVersion: input.uvVersion,
    pythonVersion: input.pythonVersion,
    dependencyGroups: [...selected.dependencyGroups.keys()].sort(),
    lockedPackages,
  };
}

function componentById(
  receipt: RuntimeBundleReceipt,
  id: "uv" | "python",
): RuntimeComponentReceipt {
  const component = receipt.components.find((candidate) => candidate.id === id);
  if (!component) throw new Error(`uv runtime bundle is missing ${id}`);
  return component;
}

function normalizeUvCommand(command: string | UvPytestCommand): UvPytestCommand | null {
  if (typeof command === "string") return parseUvPytestCommand(command);
  const operation = uvPytestOperation(command);
  if (!operation) return null;
  const parsed = uvPytestCommandForOperation(operation);
  return parsed &&
    command.runner === parsed.runner &&
    command.argv.length === parsed.argv.length &&
    command.argv.every((value, index) => value === parsed.argv[index])
    ? parsed
    : null;
}

/** Build the one adapter-owned plan consumed by local and isolated execution. */
export function createUvManagedToolchainPlan(input: {
  receipt: RuntimeBundleReceipt;
  privateRoot: string;
  commands: readonly (string | UvPytestCommand)[];
  assets: ManagedRuntimeAsset[];
}): ManagedToolchainPlan {
  if (!isAbsolute(input.privateRoot)) throw new Error("uv private runtime root must be absolute");
  assertRuntimeBundleReceipt(input.receipt);
  if (input.receipt.tool !== "uv" || input.receipt.adapter !== UV_ADAPTER_ID)
    throw new Error("runtime receipt is not for the uv adapter");
  const uv = componentById(input.receipt, "uv");
  const python = componentById(input.receipt, "python");
  if (input.receipt.components.length !== 2)
    throw new Error("uv runtime receipt must contain exactly uv and Python");
  if (!EXACT_UV_VERSION.test(uv.version) || !EXACT_PYTHON_VERSION.test(python.version))
    throw new Error("uv runtime receipt does not contain exact stable versions");
  for (const component of input.receipt.components) {
    const asset = input.assets.find(({ id }) => id === component.id);
    if (
      !asset ||
      asset.sha256 !== component.asset.sha256 ||
      asset.archive !== component.asset.archive ||
      asset.executablePath !== component.executablePath ||
      asset.executableSha256 !== component.executableSha256 ||
      asset.treeSha256 !== component.treeSha256
    )
      throw new Error(`uv managed plan asset differs from its runtime receipt: ${component.id}`);
  }
  if (input.assets.length !== input.receipt.components.length)
    throw new Error("uv managed plan assets differ from its runtime receipt");
  const commands = input.commands.map(normalizeUvCommand);
  if (commands.length === 0 || commands.some((command) => command === null))
    throw new Error("uv execution plan requires canonical pytest commands");
  const projectDirectories = new Set(commands.map((command) => command!.projectDirectory));
  if (projectDirectories.size !== 1)
    throw new Error("one uv validation may not mix project directories");
  const projectDirectory = commands[0]!.projectDirectory;
  const privatePath = (name: string) => join(input.privateRoot, name);
  const environmentRoot = privatePath("environment");
  const projectArgs = projectDirectory === "." ? [] : ["--project", projectDirectory];
  return {
    tool: "uv",
    bundleDigest: input.receipt.digest,
    assets: input.assets,
    executables: [
      { id: "uv", assetId: "uv", kind: "native", relativePath: uv.executablePath, argsPrefix: [] },
      {
        id: "python",
        assetId: "python",
        kind: "native",
        relativePath: python.executablePath,
        argsPrefix: [],
      },
      {
        id: "venv-python",
        kind: "generated",
        relativePath: join(environmentRoot, "bin", "python"),
        argsPrefix: [],
        generatedFrom: "python",
      },
    ],
    setup: [
      {
        display: "uv --version",
        executableId: "uv",
        args: ["--version"],
        expectedStdout: `uv ${uv.version}`,
        network: "none",
      },
      {
        display: "python --version",
        executableId: "python",
        args: ["--version"],
        expectedStdout: `Python ${python.version}`,
        network: "none",
      },
      {
        display: "uv sync --locked --no-build --no-install-workspace",
        executableId: "uv",
        args: [
          "sync",
          ...projectArgs,
          "--locked",
          "--no-build",
          "--no-cache",
          "--no-install-workspace",
          "--python",
          "__FACTORY_PYTHON__",
          "--group",
          "dev",
        ],
        network: "package-registry",
      },
    ],
    validation: commands.map((command) => ({
      display: "python -m pytest",
      executableId: "venv-python",
      args: ["-m", "pytest"],
      ...(command!.projectDirectory === "." ? {} : { cwd: command!.projectDirectory }),
      network: "none" as const,
    })),
    environment: {
      PATH: privatePath("bin"),
      HOME: privatePath("home"),
      PIP_CONFIG_FILE: "/dev/null",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      UV_CACHE_DIR: privatePath("cache"),
      UV_INDEX_URL: PYPI_REGISTRY,
      UV_LINK_MODE: "copy",
      UV_NO_CACHE: "1",
      UV_NO_CONFIG: "1",
      UV_NO_ENV_FILE: "1",
      UV_PROJECT_ENVIRONMENT: environmentRoot,
      UV_PYTHON_DOWNLOADS: "never",
      XDG_CACHE_HOME: privatePath("xdg-cache"),
      XDG_CONFIG_HOME: privatePath("xdg-config"),
      XDG_DATA_HOME: privatePath("xdg-data"),
    },
  };
}

/** Build direct-executable setup and validation steps from one verified uv/Python receipt. */
export async function buildUvManagedExecutionPlan(
  input: UvManagedExecutionPlanInput,
): Promise<UvManagedExecutionPlan> {
  const paths = runtimeComponentPaths(input.storeRoot, input.receipt);
  const uvPath = paths.find(({ component }) => component.id === "uv");
  const pythonPath = paths.find(({ component }) => component.id === "python");
  if (!uvPath || !pythonPath) throw new Error("uv runtime component paths are incomplete");
  await verifyRuntimeBundle(input.storeRoot, input.receipt);
  const assets = await Promise.all(
    paths.map(async ({ component, asset }) => ({
      id: component.id,
      path: `toolchains/uv/${component.asset.name}`,
      content: await readFile(asset),
      sha256: component.asset.sha256,
      archive: component.asset.archive,
      executablePath: component.executablePath,
      executableSha256: component.executableSha256,
      treeSha256: component.treeSha256,
      ...(component.executableOnly ? { executableOnly: true as const } : {}),
    })),
  );
  const projectDirectory = normalizeUvProjectDirectory(input.projectDirectory ?? ".");
  if (!projectDirectory) throw new Error("uv project directory escapes repository authority");
  const command = uvPytestCommandForOperation({
    kind: UV_PYTEST_OPERATION_KIND,
    key: projectDirectory,
  });
  if (!command) throw new Error("uv project directory cannot form a canonical pytest command");
  const plan = createUvManagedToolchainPlan({
    receipt: input.receipt,
    privateRoot: input.privateRoot,
    commands: [command],
    assets,
  });
  const executablePaths = new Map([
    ["uv", uvPath.executable],
    ["python", pythonPath.executable],
    ["venv-python", join(input.privateRoot, "environment", "bin", "python")],
  ]);
  return {
    adapter: UV_ADAPTER_ID,
    receiptDigest: input.receipt.digest,
    uvVersion: uvPath.component.version,
    pythonVersion: pythonPath.component.version,
    environment: plan.environment,
    setup: plan.setup.map((step) => ({
      ...step,
      executable: executablePaths.get(step.executableId)!,
      args: step.args.map((arg) => (arg === "__FACTORY_PYTHON__" ? pythonPath.executable : arg)),
    })),
    validation: plan.validation.map((step) => ({
      ...step,
      executable: executablePaths.get(step.executableId)!,
      ...(step.cwd ? {} : { cwd: "." }),
    })),
  };
}
