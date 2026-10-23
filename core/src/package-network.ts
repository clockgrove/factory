/**
 * When a verified dependency install may use the network: registry-only.
 * The network itself (pasta in the sandbox's own namespace, behind a
 * release gate) is sandbox.ts; this decides whether an install gets it.
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
import { isScalar, parse, parseAllDocuments, visit } from "yaml";
import { GitRefusal } from "./git.js";
import { hostGit } from "./worktree.js";

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
 * `major.minor.patch` with no prerelease or build, as numbers: no whitespace,
 * `v` prefix or leading zeros.
 */
function releaseVersion(value: string): number[] | undefined {
  const found = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return found ? found.slice(1).map(Number) : undefined;
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * Whether a release version satisfies one comparator set of an npm range:
 * `^`, `~`, `>=`, `>`, `<=`, `<`, `=`, an exact version, or a partial
 * (`12`, `12.6`, `12.x`, `*`). Anything else is not read: unknown is refused.
 */
function satisfiesComparators(version: number[], set: string): boolean {
  for (const token of set.trim().split(/\s+/).filter(Boolean)) {
    const found =
      /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(
        token,
      );
    if (!found) return false;
    const parts = found.slice(2, 5);
    // The numbers before the first wildcard or missing part; a number after
    // a wildcard (`1.x.3`) is not a range.
    const given: number[] = [];
    for (const part of parts) {
      if (part === undefined || !/^\d+$/.test(part)) break;
      given.push(Number(part));
    }
    if (parts.slice(given.length).some((part) => /^\d+$/.test(part ?? "")))
      return false;
    const low = [0, 1, 2].map((index) => given[index] ?? 0);
    // The first version past everything sharing the first `length` parts.
    const past = (length: number) =>
      low.map((part, index) =>
        index < length - 1 ? part : index === length - 1 ? part + 1 : 0,
      );
    const operator = found[1] ?? "";
    const n = given.length;
    let ok: boolean;
    if (operator === ">=") ok = n === 0 || compareVersions(version, low) >= 0;
    else if (operator === "<=")
      ok =
        n === 0 ||
        (n === 3
          ? compareVersions(version, low) <= 0
          : compareVersions(version, past(n)) < 0);
    else if (operator === ">")
      ok =
        n > 0 &&
        (n === 3
          ? compareVersions(version, low) > 0
          : compareVersions(version, past(n)) >= 0);
    else if (operator === "<") ok = n > 0 && compareVersions(version, low) < 0;
    else {
      // `=`, none, `^` and `~` are all a half-open interval from `low`.
      let length = n;
      if (operator === "^" && n > 0)
        length = low[0] !== 0 || n === 1 ? 1 : low[1] !== 0 || n === 2 ? 2 : 3;
      else if (operator === "~" && n > 0) length = n === 1 ? 1 : 2;
      ok =
        n === 0 ||
        (compareVersions(version, low) >= 0 &&
          compareVersions(version, past(length)) < 0);
    }
    if (!ok) return false;
  }
  return true;
}

/** Whether `version` is `range` or satisfies it; unknown is refused. */
function satisfiesRange(version: unknown, range: string): boolean {
  if (typeof version !== "string") return false;
  if (version === range) return true;
  const release = releaseVersion(version);
  if (!release) return false;
  return range
    .split("||")
    .some((set) => !/[-+]/.test(set) && satisfiesComparators(release, set));
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
    accepts: (version) => satisfiesRange(version, range),
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
        ["package.json", ...CONFIGURATION, ...LOCKFILES],
        signal,
      ))
    )
      return undefined;
    if (await changed(worktree, base, commit, CONFIGURATION, signal))
      return {
        reason:
          "its package-manager configuration (.npmrc, pnpm-workspace.yaml, pnpmfiles) differs from the base",
      };
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
