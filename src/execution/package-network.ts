/**
 * When a verified dependency install may use the network: registry-only.
 * A candidate controls its lockfile, and a lockfile can name tarball URLs
 * that carry the repository's contents to any host. So the install reaches
 * the network only when the registry and package-manager configuration is
 * the base's, byte for byte, and every package the candidate's lockfile
 * resolves comes from a configured registry origin. Lockfiles are read
 * structurally (YAML and JSON), never matched as text. Package names still
 * reach the registry in its lookups: that channel remains.
 */
import { parse } from "yaml";
import { pinnedGitRaw } from "../process.js";

/** Files that choose where an install fetches from and what it runs. */
const CONFIGURATION = [
  ".npmrc",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  ".pnpmfile.js",
];
const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
];
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

function changed(
  worktree: string,
  base: string,
  commit: string,
  paths: readonly string[],
): boolean {
  return (
    pinnedGitRaw(
      worktree,
      "diff-tree",
      "-r",
      "--name-only",
      "-z",
      "--no-renames",
      base,
      commit,
      "--",
      ...paths,
    ).length !== 0
  );
}

function file(
  worktree: string,
  revision: string,
  path: string,
): string | undefined {
  if (!pinnedGitRaw(worktree, "ls-tree", revision, "--", path).length)
    return undefined;
  return pinnedGitRaw(worktree, "show", `${revision}:${path}`).toString("utf8");
}

/** scheme://host[:port] of an http(s) URL, or undefined. */
function origin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The registry origins the base configuration names: `registry` and scoped
 * `@scope:registry` entries of `.npmrc`, and `registry`/`registries` in
 * pnpm-workspace.yaml; the public registry when no default is set. An entry
 * whose value Factory cannot read exactly (an environment reference, a
 * non-http URL) makes the set unknown.
 */
function configuredRegistries(
  worktree: string,
  base: string,
): Set<string> | undefined {
  const origins = new Set<string>();
  let defaultSet = false;
  const add = (value: unknown, isDefault: boolean): boolean => {
    const found = origin(value);
    if (!found || String(value).includes("${")) return false;
    origins.add(found);
    if (isDefault) defaultSet = true;
    return true;
  };
  const npmrc = file(worktree, base, ".npmrc");
  if (npmrc !== undefined)
    for (const raw of npmrc.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const equals = line.indexOf("=");
      if (equals < 0) continue;
      const key = line.slice(0, equals).trim();
      const value = line.slice(equals + 1).trim();
      if (key === "registry" || /^@[^:]+:registry$/.test(key))
        if (!add(value, key === "registry")) return undefined;
    }
  const workspace = file(worktree, base, "pnpm-workspace.yaml");
  if (workspace !== undefined) {
    const document = parse(workspace) as Record<string, unknown> | null;
    if (document && typeof document === "object") {
      if (document.registry !== undefined && !add(document.registry, true))
        return undefined;
      const registries = document.registries;
      if (registries !== undefined) {
        if (!registries || typeof registries !== "object") return undefined;
        for (const [scope, value] of Object.entries(registries))
          if (!add(value, scope === "default")) return undefined;
      }
    }
  }
  if (!defaultSet) origins.add(new URL(DEFAULT_REGISTRY).origin);
  return origins;
}

/** A local or VCS specifier: never fetched from a registry. */
const localSpecifier = (value: unknown) =>
  typeof value === "string" &&
  /^(?:link|file|git|git\+[a-z]+|github|gitlab|bitbucket|workspace):/i.test(
    value,
  );

/** pnpm-lock.yaml: every package resolves by integrity from a registry origin. */
function pnpmLockfileFromRegistries(
  text: string,
  registries: Set<string>,
): boolean {
  const lock = parse(text) as Record<string, unknown> | null;
  if (!lock || typeof lock !== "object") return false;
  const importers = lock.importers;
  if (importers !== undefined) {
    if (!importers || typeof importers !== "object") return false;
    for (const importer of Object.values(importers)) {
      if (!importer || typeof importer !== "object") return false;
      for (const group of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ]) {
        const dependencies = (importer as Record<string, unknown>)[group];
        if (dependencies === undefined) continue;
        if (!dependencies || typeof dependencies !== "object") return false;
        for (const entry of Object.values(dependencies)) {
          const { specifier, version } = (entry ?? {}) as Record<
            string,
            unknown
          >;
          if (localSpecifier(specifier) || localSpecifier(version))
            return false;
        }
      }
    }
  }
  const packages = lock.packages ?? {};
  if (!packages || typeof packages !== "object") return false;
  for (const entry of Object.values(packages)) {
    if (!entry || typeof entry !== "object") return false;
    const resolution = (entry as Record<string, unknown>).resolution;
    if (!resolution || typeof resolution !== "object") return false;
    const fields = resolution as Record<string, unknown>;
    // Git, directory and other typed resolutions are not registry packages.
    if (fields.type !== undefined || typeof fields.integrity !== "string")
      return false;
    // pnpm omits the tarball for the default registry's own URL.
    if (fields.tarball !== undefined) {
      const found = origin(fields.tarball);
      if (!found || !registries.has(found)) return false;
    }
  }
  return true;
}

/** package-lock.json: every resolved package comes from a registry origin. */
function npmLockfileFromRegistries(
  text: string,
  registries: Set<string>,
): boolean {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return false;
  }
  if (!lock || typeof lock !== "object") return false;
  const packages = (lock as Record<string, unknown>).packages;
  if (!packages || typeof packages !== "object") return false;
  for (const [path, entry] of Object.entries(packages)) {
    if (!entry || typeof entry !== "object") return false;
    const fields = entry as Record<string, unknown>;
    if (path === "") continue;
    if (fields.link === true) return false;
    if (fields.resolved === undefined) {
      // Only bundled packages arrive without a resolved URL.
      if (fields.inBundle !== true) return false;
      continue;
    }
    const found = origin(fields.resolved);
    if (
      !found ||
      !registries.has(found) ||
      typeof fields.integrity !== "string"
    )
      return false;
  }
  return true;
}

/**
 * Whether a verified install of `commit` may reach the network, judged
 * against the attempt's `base`: its package inputs unchanged (the fast
 * path), or its configuration unchanged and every lockfile resolving only
 * from the configured registry origins. Unknown is offline.
 */
export function installMayUseNetwork(
  worktree: string,
  base: string,
  commit: string,
): boolean {
  try {
    if (
      !changed(worktree, base, commit, [
        "package.json",
        ...CONFIGURATION,
        ...LOCKFILES,
      ])
    )
      return true;
    if (changed(worktree, base, commit, CONFIGURATION)) return false;
    const registries = configuredRegistries(worktree, base);
    if (!registries) return false;
    if (file(worktree, commit, "npm-shrinkwrap.json") !== undefined)
      return false;
    const pnpm = file(worktree, commit, "pnpm-lock.yaml");
    if (pnpm !== undefined && !pnpmLockfileFromRegistries(pnpm, registries))
      return false;
    const npm = file(worktree, commit, "package-lock.json");
    if (npm !== undefined && !npmLockfileFromRegistries(npm, registries))
      return false;
    return pnpm !== undefined || npm !== undefined;
  } catch {
    return false;
  }
}
