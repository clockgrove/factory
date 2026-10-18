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
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isScalar, parse, parseDocument, visit } from "yaml";
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

/** A relative path that, from `from`, stays inside the checkout. */
function insideCheckout(from: string, target: string): boolean {
  if (!target || target.includes("\0") || posix.isAbsolute(target))
    return false;
  const resolved = posix.normalize(posix.join(from, target));
  return resolved !== ".." && !resolved.startsWith("../");
}

/**
 * Whether an importer's specifier or resolved version may stand beside a
 * registry-only install. A registry range or version may. `workspace:` ranges
 * and `link:` paths to directories inside the checkout (sibling workspace
 * packages) may too: they fetch nothing. Any other protocol (`file:`, git,
 * hosted, an http URL) or a link out of the checkout may not.
 */
function importerEntryAllowed(importer: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  if (value.startsWith("workspace:")) return true;
  if (value.startsWith("link:"))
    return insideCheckout(importer, value.slice("link:".length));
  const colon = value.indexOf(":");
  // A plain range or version (`^1.2.0`, `1.2.0(peer@2.0.0)`) names no protocol.
  return colon < 0 || (colon > value.indexOf("(") && value.indexOf("(") >= 0);
}

/**
 * The YAML as plain data, or undefined when Factory and a package manager
 * could read it differently: pnpm's YAML reader applies `<<` merge keys,
 * which YAML 1.2 does not, so a lockfile with merge keys, anchors, aliases,
 * explicit tags or duplicate keys is never read as data here.
 */
function plainYaml(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true, merge: false });
  if (document.errors.length) return undefined;
  let plain = true;
  visit(document, {
    Alias: () => {
      plain = false;
      return visit.BREAK;
    },
    Node: (_key, node) => {
      if (node.anchor || node.tag) {
        plain = false;
        return visit.BREAK;
      }
    },
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        plain = false;
        return visit.BREAK;
      }
    },
  });
  return plain ? document.toJS() : undefined;
}

/** pnpm-lock.yaml: every package resolves by integrity from a registry origin. */
function pnpmLockfileFromRegistries(
  text: string,
  registries: Set<string>,
): boolean {
  const lock = plainYaml(text) as Record<string, unknown> | null;
  if (!lock || typeof lock !== "object") return false;
  const importers = lock.importers;
  if (importers !== undefined) {
    if (!importers || typeof importers !== "object") return false;
    for (const [path, importer] of Object.entries(importers)) {
      if (!importer || typeof importer !== "object") return false;
      if (!insideCheckout(".", path)) return false;
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
          if (
            !importerEntryAllowed(path, specifier) ||
            !importerEntryAllowed(path, version)
          )
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
    // Only a registry resolution: its integrity and, at most, its tarball.
    // Git, directory and other typed resolutions carry other keys.
    if (
      Object.keys(fields).some(
        (key) => key !== "integrity" && key !== "tarball",
      ) ||
      typeof fields.integrity !== "string"
    )
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
    if (!insideCheckout(".", path)) return false;
    // A workspace link points at a directory inside the checkout: no fetch.
    if (fields.link === true) {
      if (
        typeof fields.resolved !== "string" ||
        !insideCheckout(".", fields.resolved)
      )
        return false;
      continue;
    }
    // A workspace package's own folder is checkout source, not a download.
    if (!path.split("/").includes("node_modules")) continue;
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
    // package.json may change here, but not the package manager it pins:
    // pnpm would download and run that version.
    const manager = (revision: string) => {
      const text = file(worktree, revision, "package.json");
      if (text === undefined) return {};
      const manifest = JSON.parse(text) as Record<string, unknown>;
      return {
        packageManager: manifest.packageManager,
        devEngines: manifest.devEngines,
      };
    };
    if (!isDeepStrictEqual(manager(base), manager(commit))) return false;
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
