/**
 * When a verified dependency install may use the network: registry-only.
 * The network itself (pasta in the sandbox's own namespace, behind a
 * release gate) is sandbox.ts; this decides whether an install gets it.
 * A candidate controls its lockfile, and a lockfile can name tarball URLs
 * that carry the repository's contents to any host. So the install reaches
 * the network only when the registry and package-manager configuration is
 * the base's, byte for byte (of pnpm-workspace.yaml, every setting but its
 * package membership, overrides and catalogs), and every package the
 * candidate's lockfile resolves comes from a configured registry origin.
 * Lockfiles are read structurally (YAML and JSON), never matched as text.
 * Package names still reach the registry in its lookups: that channel
 * remains. Factory's own lockfile resolution (validate.ts) fetches what the
 * manifests name, with no lockfile to check, so it also needs every
 * manifest it reads that the candidate changed, and the workspace's
 * overrides and catalogs, to name registry specifiers only.
 */
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { satisfies } from "semver";
import { isScalar, parse, parseAllDocuments, visit } from "yaml";
import { GitRefusal } from "./git.js";
import { hostGit } from "./worktree.js";

const WORKSPACE = "pnpm-workspace.yaml";
/**
 * Files that choose where an install fetches from and what it runs. Of
 * pnpm-workspace.yaml, only the settings (workspaceSettings) count.
 */
const CONFIGURATION = [
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  ".pnpmfile.js",
];

/**
 * The pnpm-workspace.yaml keys a dependency change may move (#2099): which
 * versions resolve (`overrides`, `catalog`, `catalogs`). They name packages
 * the way package.json's dependencies do, so the same checks hold them: a
 * frozen install fetches only what its verified lockfile names, and a
 * resolution takes the network only when each names the registry
 * (resolutionNetworkRefusal). Every other key (registries, release age,
 * trust policy, build approvals, hooks, patches) is the operator's.
 */
export const WORKSPACE_DEPENDENCY_KEYS = [
  "overrides",
  "catalog",
  "catalogs",
] as const;

/**
 * A pnpm-workspace.yaml mapping's settings: everything but its package
 * membership (`packages`, checked apart) and the dependency keys.
 */
export function workspaceSettings(
  workspace: Record<string, unknown>,
): Record<string, unknown> {
  const settings = { ...workspace };
  delete settings.packages;
  for (const key of WORKSPACE_DEPENDENCY_KEYS) delete settings[key];
  return settings;
}
const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
];
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

async function changed(
  worktree: string,
  base: string,
  commit: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  const names = await hostGit(
    worktree,
    [
      "diff-tree",
      "-r",
      "--name-only",
      "-z",
      "--no-renames",
      base,
      commit,
      "--",
      ...paths,
    ],
    { signal },
  );
  return names.length !== 0;
}

async function file(
  worktree: string,
  revision: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (
    !(await hostGit(worktree, ["ls-tree", revision, "--", path], { signal }))
      .length
  )
    return undefined;
  return (
    await hostGit(worktree, ["show", `${revision}:${path}`], { signal })
  ).toString("utf8");
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
async function configuredRegistries(
  worktree: string,
  base: string,
  signal?: AbortSignal,
): Promise<Set<string> | undefined> {
  const origins = new Set<string>();
  let defaultSet = false;
  const add = (value: unknown, isDefault: boolean): boolean => {
    const found = origin(value);
    if (!found || String(value).includes("${")) return false;
    origins.add(found);
    if (isDefault) defaultSet = true;
    return true;
  };
  const npmrc = await file(worktree, base, ".npmrc", signal);
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
  const workspace = await file(worktree, base, "pnpm-workspace.yaml", signal);
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

/** A registry range or version (`^1.2.0`, `1.2.0(peer@2.0.0)`) names no protocol. */
function plainRange(value: string): boolean {
  const colon = value.indexOf(":");
  return colon < 0 || (colon > value.indexOf("(") && value.indexOf("(") >= 0);
}

/** An npm package name, scoped or not, with no leading dot (legacy uppercase included). */
const NPM_PACKAGE_NAME = /^(?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/;

/**
 * Whether an importer's specifier or resolved version may stand beside a
 * registry-only install. A registry range or version may, and so may an
 * `npm:<name>@<range>` alias: it resolves from the registry like the range
 * would. `workspace:` ranges and `link:` paths to directories inside the
 * checkout (sibling workspace packages) may too: they fetch nothing. Any
 * other protocol (`file:`, git, hosted, an http URL) or a link out of the
 * checkout may not.
 */
function importerEntryAllowed(importer: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  if (value.startsWith("workspace:")) return true;
  if (value.startsWith("link:"))
    return insideCheckout(importer, value.slice("link:".length));
  if (value.startsWith("npm:")) {
    const aliased = value.slice("npm:".length);
    // `name` or `name@range`; a scoped name starts with its own `@`.
    const at = aliased.indexOf("@", 1);
    const name = at < 0 ? aliased : aliased.slice(0, at);
    return (
      NPM_PACKAGE_NAME.test(name) &&
      (at < 0 || plainRange(aliased.slice(at + 1)))
    );
  }
  return plainRange(value);
}

/** Why the install stays offline, and whether Factory could not check. */
export interface NetworkRefusal {
  reason: string;
  /**
   * Factory could not read or check the package inputs: the environment's
   * limit, not something the candidate's policy broke.
   */
  unverified?: true;
}

/**
 * Each YAML document as plain data, or why not. A document Factory and a
 * package manager could read differently is never read as data: pnpm's
 * YAML reader applies `<<` merge keys, which YAML 1.2 does not, so merge
 * keys, anchors, aliases and explicit tags are refused. pnpm 12 writes its
 * lockfile as two documents when `packageManager` is pinned (the package
 * manager's own, then the project's); each is read under the same rules.
 */
function plainYaml(text: string, path: string): unknown[] | NetworkRefusal {
  const documents = parseAllDocuments(text, { uniqueKeys: true, merge: false });
  if (!documents.length) return { reason: `${path} has no YAML document` };
  const plain: unknown[] = [];
  for (const document of documents) {
    if (document.errors.length)
      return {
        reason: `Factory could not read ${path} as YAML: ${document.errors[0]?.message.split("\n")[0]}`,
        unverified: true,
      };
    let found: string | undefined;
    visit(document, {
      Alias: () => {
        found = "an alias";
        return visit.BREAK;
      },
      Node: (_key, node) => {
        if (node.anchor || node.tag) {
          found = node.anchor ? "an anchor" : "a tag";
          return visit.BREAK;
        }
      },
      Pair: (_key, pair) => {
        if (isScalar(pair.key) && pair.key.value === "<<") {
          found = "a merge key";
          return visit.BREAK;
        }
      },
    });
    if (found)
      return {
        reason: `${path} is not plain YAML: it has ${found}`,
      };
    plain.push(document.toJS());
  }
  return plain;
}

/**
 * The package manager package.json pins, as the name pnpm records it under
 * `packageManagerDependencies` and what its locked version must satisfy: the
 * root `packageManager` (`name@version`, optionally `+sha...`), else
 * `devEngines.packageManager` (`{ name, version }`, an exact version or a
 * range). Undefined when neither pins one Factory can read.
 */
function pinnedPackageManager(
  packageManager: unknown,
  devEngines: unknown,
): { name: string; accepts: (version: unknown) => boolean } | undefined {
  if (typeof packageManager === "string") {
    const found = /^((?:@[^@/]+\/)?[^@]+)@([^+]+)(?:\+.*)?$/.exec(
      packageManager,
    );
    return found
      ? {
          name: found[1] as string,
          accepts: (version) => version === found[2],
        }
      : undefined;
  }
  const entry = (devEngines as Record<string, unknown> | null | undefined)
    ?.packageManager as Record<string, unknown> | null | undefined;
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.name !== "string" ||
    typeof entry.version !== "string"
  )
    return undefined;
  const range = entry.version;
  return {
    name: entry.name,
    accepts: (version) =>
      typeof version === "string" && satisfies(version, range),
  };
}

/**
 * Why pnpm-lock.yaml is not registry-only, or undefined: in every document,
 * importers name registry ranges, aliases or sibling packages, the package
 * manager pinned is the one `packageManager` (or, without it,
 * `devEngines.packageManager`) names, and every package resolves by
 * integrity from a registry origin.
 */
function pnpmLockfileRefusal(
  text: string,
  registries: Set<string>,
  packageManager: unknown,
  devEngines: unknown,
): NetworkRefusal | undefined {
  const path = "pnpm-lock.yaml";
  const documents = plainYaml(text, path);
  if (!Array.isArray(documents)) return documents;
  const pinned = pinnedPackageManager(packageManager, devEngines);
  for (const document of documents) {
    const lock = document as Record<string, unknown> | null;
    if (!lock || typeof lock !== "object")
      return { reason: `${path} has a document that is not a mapping` };
    const importers = lock.importers;
    if (importers !== undefined) {
      if (!importers || typeof importers !== "object")
        return { reason: `${path} has malformed importers` };
      for (const [importer, entries] of Object.entries(importers)) {
        if (!entries || typeof entries !== "object")
          return { reason: `${path} has a malformed importer ${importer}` };
        if (!insideCheckout(".", importer))
          return { reason: `${path} has an importer outside the checkout` };
        const groups = entries as Record<string, unknown>;
        for (const group of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "configDependencies",
          "packageManagerDependencies",
        ]) {
          const dependencies = groups[group];
          if (dependencies === undefined) continue;
          if (!dependencies || typeof dependencies !== "object")
            return { reason: `${path} has malformed ${group}` };
          for (const [name, entry] of Object.entries(dependencies)) {
            const { specifier, version } = (entry ?? {}) as Record<
              string,
              unknown
            >;
            if (
              !importerEntryAllowed(importer, specifier) ||
              !importerEntryAllowed(importer, version)
            )
              return {
                reason: `${path} has ${name} in ${importer} from outside the registry (${String(specifier)})`,
              };
            // Only the package manager package.json pins, at its version.
            if (
              group === "packageManagerDependencies" &&
              (!pinned || name !== pinned.name || !pinned.accepts(version))
            )
              return {
                reason: `${path} pins ${name}@${String(version)} as the package manager, not the one package.json names (packageManager or devEngines.packageManager)`,
              };
          }
        }
      }
    }
    const packages = lock.packages ?? {};
    if (!packages || typeof packages !== "object")
      return { reason: `${path} has malformed packages` };
    for (const [name, entry] of Object.entries(packages)) {
      const refused = {
        reason: `${path} resolves ${name} other than by integrity from a configured registry`,
      };
      if (!entry || typeof entry !== "object") return refused;
      const resolution = (entry as Record<string, unknown>).resolution;
      if (!resolution || typeof resolution !== "object") return refused;
      const fields = resolution as Record<string, unknown>;
      // Only a registry resolution: its integrity and, at most, its tarball.
      // Git, directory and other typed resolutions carry other keys.
      if (
        Object.keys(fields).some(
          (key) => key !== "integrity" && key !== "tarball",
        ) ||
        typeof fields.integrity !== "string"
      )
        return refused;
      // pnpm omits the tarball for the default registry's own URL.
      if (fields.tarball !== undefined) {
        const found = origin(fields.tarball);
        if (!found || !registries.has(found)) return refused;
      }
    }
  }
  return undefined;
}

/** Why package-lock.json is not registry-only, or undefined. */
function npmLockfileRefusal(
  text: string,
  registries: Set<string>,
): NetworkRefusal | undefined {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    return {
      reason: `Factory could not read package-lock.json as JSON: ${(error as Error).message}`,
      unverified: true,
    };
  }
  if (!lock || typeof lock !== "object")
    return { reason: "package-lock.json is not an object" };
  const packages = (lock as Record<string, unknown>).packages;
  if (!packages || typeof packages !== "object")
    return { reason: "package-lock.json has no packages" };
  for (const [path, entry] of Object.entries(packages)) {
    const refused = {
      reason: `package-lock.json resolves ${path} other than by integrity from a configured registry`,
    };
    if (!entry || typeof entry !== "object") return refused;
    const fields = entry as Record<string, unknown>;
    if (path === "") continue;
    if (!insideCheckout(".", path)) return refused;
    // A workspace link points at a directory inside the checkout: no fetch.
    if (fields.link === true) {
      if (
        typeof fields.resolved !== "string" ||
        !insideCheckout(".", fields.resolved)
      )
        return refused;
      continue;
    }
    // A workspace package's own folder is checkout source, not a download.
    if (!path.split("/").includes("node_modules")) continue;
    if (fields.resolved === undefined) {
      // Only bundled packages arrive without a resolved URL.
      if (fields.inBundle !== true) return refused;
      continue;
    }
    const found = origin(fields.resolved);
    if (
      !found ||
      !registries.has(found) ||
      typeof fields.integrity !== "string"
    )
      return refused;
  }
  return undefined;
}

/** A plain YAML file's one mapping, or why it is not one. */
function plainMapping(
  text: string,
  path: string,
): { mapping: Record<string, unknown> } | { refused: NetworkRefusal } {
  const documents = plainYaml(text, path);
  if (!Array.isArray(documents)) return { refused: documents };
  const [document] = documents;
  if (
    documents.length !== 1 ||
    !document ||
    typeof document !== "object" ||
    Array.isArray(document)
  )
    return { refused: { reason: `${path} is not one YAML mapping` } };
  return { mapping: document as Record<string, unknown> };
}

/**
 * Why a changed pnpm-workspace.yaml takes the install's network away, or
 * undefined: only its package membership and dependency keys
 * (WORKSPACE_DEPENDENCY_KEYS) may differ from the base's. Members the change
 * adds are importers of the lockfile, which is verified on its own, and the
 * dependency keys choose versions the lockfile then pins. A workspace the
 * candidate added or removed is configuration.
 */
async function workspaceRefusal(
  worktree: string,
  base: string,
  commit: string,
  signal?: AbortSignal,
): Promise<NetworkRefusal | undefined> {
  const configuration = {
    reason:
      "its package-manager configuration (.npmrc, pnpm-workspace.yaml, pnpmfiles) differs from the base",
  };
  const before = await file(worktree, base, WORKSPACE, signal);
  const after = await file(worktree, commit, WORKSPACE, signal);
  if (before === undefined || after === undefined) return configuration;
  // The candidate changed the file: what can't be read is its to fix.
  const baseline = plainMapping(before, WORKSPACE);
  if ("refused" in baseline)
    return { reason: `the base's ${baseline.refused.reason}` };
  const result = plainMapping(after, WORKSPACE);
  if ("refused" in result)
    return { reason: `the candidate's ${result.refused.reason}` };
  if (
    !isDeepStrictEqual(
      workspaceSettings(baseline.mapping),
      workspaceSettings(result.mapping),
    )
  )
    return {
      reason: `its ${WORKSPACE} changes settings other than package membership and ${WORKSPACE_DEPENDENCY_KEYS.join(", ")}`,
    };
  return undefined;
}

/**
 * Why a verified install of `commit` may not reach the network, judged
 * against the attempt's `base`, or undefined when it may: its package
 * inputs unchanged (the fast path), or its configuration unchanged and
 * every lockfile resolving only from the configured registry origins.
 * Unknown is offline. Unverified marks what Factory could not check: the
 * base's registry configuration, a base lockfile or a Git read.
 */
export async function installNetworkRefusal(
  worktree: string,
  base: string,
  commit: string,
  signal?: AbortSignal,
): Promise<NetworkRefusal | undefined> {
  try {
    if (
      !(await changed(
        worktree,
        base,
        commit,
        ["package.json", WORKSPACE, ...CONFIGURATION, ...LOCKFILES],
        signal,
      ))
    )
      return undefined;
    if (await changed(worktree, base, commit, CONFIGURATION, signal))
      return {
        reason:
          "its package-manager configuration (.npmrc, pnpm-workspace.yaml, pnpmfiles) differs from the base",
      };
    if (await changed(worktree, base, commit, [WORKSPACE], signal)) {
      const refused = await workspaceRefusal(worktree, base, commit, signal);
      if (refused) return refused;
    }
    // package.json may change here, but not the package manager it pins:
    // pnpm would download and run that version.
    const manager = async (revision: string) => {
      const text = await file(worktree, revision, "package.json", signal);
      if (text === undefined) return {};
      const manifest = JSON.parse(text) as Record<string, unknown>;
      return {
        packageManager: manifest.packageManager,
        devEngines: manifest.devEngines,
      };
    };
    let pinned: Awaited<ReturnType<typeof manager>>;
    try {
      pinned = await manager(commit);
    } catch (error) {
      // Unreadable is Factory's limit only when the candidate left the file
      // as the base has it; one the candidate changed is its to fix.
      if (!(await changed(worktree, base, commit, ["package.json"], signal)))
        throw error;
      return { reason: "the candidate's package.json cannot be read" };
    }
    if (!isDeepStrictEqual(await manager(base), pinned))
      return {
        reason: "package.json changes its packageManager or devEngines",
      };
    const registries = await configuredRegistries(worktree, base, signal);
    if (!registries)
      return {
        reason:
          "Factory could not read the base's registry configuration exactly (an environment reference or a non-http registry)",
        unverified: true,
      };
    if (
      (await file(worktree, commit, "npm-shrinkwrap.json", signal)) !==
      undefined
    )
      return { reason: "it has an npm-shrinkwrap.json" };
    const pnpm = await file(worktree, commit, "pnpm-lock.yaml", signal);
    const npm = await file(worktree, commit, "package-lock.json", signal);
    if (pnpm === undefined && npm === undefined)
      return { reason: "no lockfile pins what it fetches" };
    // Only the base's own lockfile, unreadable here, is Factory's limit; one
    // the candidate changed is the candidate's to make verifiable.
    const lockfile = async (
      path: string,
      refusal: NetworkRefusal | undefined,
    ) =>
      refusal?.unverified &&
      (await changed(worktree, base, commit, [path], signal))
        ? {
            reason: `the candidate's ${path} cannot be verified: ${refusal.reason}`,
          }
        : refusal;
    return (
      (pnpm !== undefined
        ? await lockfile(
            "pnpm-lock.yaml",
            pnpmLockfileRefusal(
              pnpm,
              registries,
              pinned.packageManager,
              pinned.devEngines,
            ),
          )
        : undefined) ??
      (npm !== undefined
        ? await lockfile(
            "package-lock.json",
            npmLockfileRefusal(npm, registries),
          )
        : undefined)
    );
  } catch (error) {
    // Refused Git is the operator's to fix, and an abort is not a refusal.
    if (error instanceof GitRefusal) throw error;
    signal?.throwIfAborted();
    return {
      reason: `Factory could not check its package inputs: ${(error as Error).message}`,
      unverified: true,
    };
  }
}

/** The manifest fields whose values name what a resolution fetches. */
const MANIFEST_DEPENDENCIES = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
/** Manifest fields that replace specifiers anywhere in the tree, nested by package. */
const MANIFEST_OVERRIDES = ["overrides", "resolutions"];

/**
 * Whether a manifest's specifier resolves only from a registry: a range,
 * version or tag, an `npm:` alias of one, a pnpm catalog, or a sibling
 * package (`workspace:`, or a `link:` inside the checkout). A hosted
 * shorthand (`owner/repo`), git, `file:` or a URL may not: resolving it
 * would fetch from wherever it names.
 */
function manifestSpecifierAllowed(importer: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^catalog:[\w.-]*$/.test(value)) return true;
  if (value.startsWith("workspace:") || value.startsWith("link:"))
    return importerEntryAllowed(importer, value);
  const aliased = value.startsWith("npm:") ? value.slice("npm:".length) : "";
  const at = aliased.indexOf("@", 1);
  const range = !value.startsWith("npm:")
    ? value
    : at < 0
      ? ""
      : aliased.slice(at + 1);
  return importerEntryAllowed(importer, value) && !/[/#\\]/.test(range);
}

/**
 * The first override value, at any depth, that is not a registry
 * specifier or an npm `$name` reference to a direct dependency.
 */
function refusedOverride(importer: string, value: unknown): string | undefined {
  if (typeof value === "string")
    return /^\$[\w@./-]+$/.test(value) ||
      manifestSpecifierAllowed(importer, value)
      ? undefined
      : value;
  if (!value || typeof value !== "object") return String(value);
  for (const nested of Object.values(value)) {
    const refused = refusedOverride(importer, nested);
    if (refused !== undefined) return refused;
  }
  return undefined;
}

/**
 * A regular expression for one pnpm-workspace.yaml `packages` pattern, or
 * undefined when Factory can't read the pattern exactly: `*` and `?` within
 * a path segment, `**` for any number of segments, nothing else.
 */
function memberPattern(pattern: string): RegExp | undefined {
  const path = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path || /[[\]{}()!+@\\]/.test(path) || path.startsWith("/"))
    return undefined;
  const segments = path.split("/").map((segment) => {
    if (segment === "**") return "(?:[^/]+/)*";
    if (segment.includes("**")) return undefined;
    return `${segment
      .replace(/[.^$|]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")}/`;
  });
  if (segments.some((segment) => segment === undefined)) return undefined;
  return new RegExp(`^${segments.join("")}$`);
}

/** Whether the manifest at a path is one a resolution reads. */
type Members = (path: string) => boolean;

/**
 * Which changed package.json files the resolution reads: the root's, and
 * the workspace members'. Members are what `commit`'s pnpm-workspace.yaml
 * `packages` names; negated patterns are left out of the judgement, which
 * can only add members. Every manifest counts when Factory can't tell: a
 * workspace without a readable `packages` list, a pattern it can't read
 * exactly, or package.json `workspaces` (npm's, which its bootstrap
 * refuses anyway).
 */
async function workspaceMembers(
  worktree: string,
  commit: string,
  signal?: AbortSignal,
): Promise<Members> {
  const every: Members = () => true;
  const root = await file(worktree, commit, "package.json", signal);
  try {
    const manifest = root === undefined ? {} : JSON.parse(root);
    if (manifest && typeof manifest === "object" && "workspaces" in manifest)
      return every;
  } catch {
    // Unreadable: refused where it is checked.
    return every;
  }
  const text = await file(worktree, commit, WORKSPACE, signal);
  if (text === undefined) return (path) => path === "package.json";
  const workspace = plainMapping(text, WORKSPACE);
  if ("refused" in workspace) return every;
  const packages = workspace.mapping.packages;
  if (
    !Array.isArray(packages) ||
    packages.some((entry) => typeof entry !== "string")
  )
    return every;
  const patterns: RegExp[] = [];
  for (const entry of packages as string[]) {
    if (entry.startsWith("!")) continue;
    const pattern = memberPattern(entry);
    if (!pattern) return every;
    patterns.push(pattern);
  }
  return (path) =>
    path === "package.json" ||
    patterns.some((pattern) => pattern.test(`${posix.dirname(path)}/`));
}

/**
 * Why `commit`'s pnpm-workspace.yaml dependency keys (overrides, catalogs)
 * name a package from outside the registry, or undefined.
 */
async function workspaceDependencyRefusal(
  worktree: string,
  base: string,
  commit: string,
  signal?: AbortSignal,
): Promise<NetworkRefusal | undefined> {
  if (!(await changed(worktree, base, commit, [WORKSPACE], signal)))
    return undefined;
  const text = await file(worktree, commit, WORKSPACE, signal);
  if (text === undefined) return undefined;
  const workspace = plainMapping(text, WORKSPACE);
  if ("refused" in workspace)
    return { reason: `the candidate's ${workspace.refused.reason}` };
  for (const key of WORKSPACE_DEPENDENCY_KEYS) {
    const entries = workspace.mapping[key];
    if (entries === undefined) continue;
    const value = refusedOverride(".", entries);
    if (value !== undefined)
      return {
        reason: `the candidate's ${WORKSPACE} ${key} name a package from outside the registry (${value})`,
      };
  }
  return undefined;
}

/**
 * Why a lockfile-only resolution of `commit` may not reach the network, or
 * undefined when it may. A resolution has no lockfile to verify: it reads
 * the manifests and fetches what they name. So it takes the network only
 * as the install would on the inputs it starts from (installNetworkRefusal),
 * and only when every package.json the candidate changed that the
 * resolution reads (the root's and the workspace members') names its
 * dependencies and overrides from the registry alone, and so do the
 * overrides and catalogs of a pnpm-workspace.yaml it changed. A changed
 * manifest outside the workspace, such as a test fixture's, fetches
 * nothing (#2099).
 */
export async function resolutionNetworkRefusal(
  worktree: string,
  base: string,
  commit: string,
  signal?: AbortSignal,
): Promise<NetworkRefusal | undefined> {
  const refused = await installNetworkRefusal(worktree, base, commit, signal);
  if (refused) return refused;
  try {
    const workspace = await workspaceDependencyRefusal(
      worktree,
      base,
      commit,
      signal,
    );
    if (workspace) return workspace;
    const member = await workspaceMembers(worktree, commit, signal);
    const manifests = (
      await hostGit(
        worktree,
        [
          "diff-tree",
          "-r",
          "--name-only",
          "-z",
          "--no-renames",
          "--diff-filter=AM",
          base,
          commit,
        ],
        { signal },
      )
    )
      .toString("utf8")
      .split("\0")
      .filter(
        (path) =>
          (path === "package.json" || path.endsWith("/package.json")) &&
          member(path),
      );
    for (const path of manifests) {
      const importer = posix.dirname(path);
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(
          (await file(worktree, commit, path, signal)) ?? "{}",
        );
      } catch {
        return { reason: `the candidate's ${path} cannot be read` };
      }
      if (!manifest || typeof manifest !== "object")
        return { reason: `the candidate's ${path} is not an object` };
      for (const group of MANIFEST_DEPENDENCIES) {
        const entries = manifest[group];
        if (entries === undefined) continue;
        if (!entries || typeof entries !== "object")
          return { reason: `the candidate's ${path} has malformed ${group}` };
        for (const [name, specifier] of Object.entries(entries))
          if (!manifestSpecifierAllowed(importer, specifier))
            return {
              reason: `the candidate's ${path} names ${name} from outside the registry (${String(specifier)})`,
            };
      }
      const settings = manifest.pnpm as Record<string, unknown> | undefined;
      for (const [field, entries] of [
        ...MANIFEST_OVERRIDES.map((field) => [field, manifest[field]] as const),
        ["pnpm.overrides", settings?.overrides] as const,
      ]) {
        if (entries === undefined) continue;
        const value = refusedOverride(importer, entries);
        if (value !== undefined)
          return {
            reason: `the candidate's ${path} ${field} name a package from outside the registry (${value})`,
          };
      }
    }
    return undefined;
  } catch (error) {
    if (error instanceof GitRefusal) throw error;
    signal?.throwIfAborted();
    return {
      reason: `Factory could not check its package inputs: ${(error as Error).message}`,
      unverified: true,
    };
  }
}
