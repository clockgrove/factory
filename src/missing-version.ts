/**
 * A dependency change's lockfile resolution refused for a version no
 * published release satisfies (#2099 item 5). pnpm 12 reports a missing
 * version as `ERR_PNPM_NO_MATCHING_VERSION` and npm as `ETARGET`, and npm
 * reports a release-age refusal with the same code. So Factory reads the
 * package and range from the message, matches them to a specifier the
 * candidate itself declares, and asks the registry, through the package
 * manager's own metadata lookup run exactly as the resolution ran
 * (validate.ts), which versions it publishes. Only when none satisfies the
 * range is it the worker's to repair; every other answer, and every step
 * Factory can't read exactly, keeps the hold. Factory never guesses.
 *
 * What reaches the worker is Factory's own text: the package name and
 * range the candidate declared (checked), and at most NEWEST_SHOWN of the
 * registry's release versions, each one semver parsed and printed only as
 * its digits and dots (a prerelease's tag is free text whoever published
 * it chose, so no prerelease is named).
 */
import { posix } from "node:path";
import { parse as parseVersion, rcompare, satisfies, validRange } from "semver";
import { parse as parseYaml } from "yaml";
import { hostGit } from "./worktree.js";

export type PackageManager = "npm" | "pnpm";

/** npm's longest package name. */
const NAME_LIMIT = 214;
/** The longest range Factory looks up. */
const RANGE_LIMIT = 128;
/** The newest published versions a repair names. */
export const NEWEST_SHOWN = 10;
/**
 * A version a repair may name: a release, `major.minor.patch` and nothing
 * else (semver's canonical form has already dropped build metadata). A
 * prerelease tag is free text its publisher chose, so it never reaches the
 * worker.
 */
const RELEASE = /^\d+\.\d+\.\d+$/;

/**
 * An npm package name Factory passes to the lookup: scoped or not, starting
 * with a letter or digit (never `-`, which would read as an option, or
 * `.`), within npm's length limit.
 */
const LOOKUP_NAME = /^(?:@[A-Za-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*$/;

/**
 * A plain semver range's characters: versions, `x`/`*`, operators,
 * hyphen ranges and `||`. No `:` (a protocol or alias), `/` (a path or
 * hosted shorthand), `@` (an alias) or quote.
 */
const RANGE_CHARACTERS = /^[\w.*^~<>=|+ -]+$/;

const squeeze = (text: string) => text.replace(/\s+/g, "");

/**
 * The `name@range` a no-matching-version refusal names, with whitespace
 * removed (pnpm wraps its message at hyphens and spaces), or undefined
 * when the output isn't exactly one such refusal or is pnpm's release-age
 * refusal.
 *
 * pnpm 12.6:
 *   Error: ERR_PNPM_NO_MATCHING_VERSION … No matching version found for is-
 *         number@99.0.0 while fetching it from https://registry.npmjs.org/
 * (a release-age refusal is ERR_PNPM_NO_MATURE_MATCHING_VERSION). npm 11.19:
 *   npm error code ETARGET
 *   npm error notarget No matching version found for is-number@99.0.0.
 * Under a release-age policy (`min-release-age`, `before`) npm adds
 * ` with a date before <date>` to every ETARGET, a version that was never
 * published included, so the suffix can't say whose refusal it is: the
 * request is read through it and the lookup tells them apart (a version
 * the policy keeps out still satisfies the range, which holds).
 */
export function refusedRequest(
  manager: PackageManager,
  output: string,
): string | undefined {
  const flat = output.replace(/\s+/g, " ");
  let found: RegExpMatchArray[];
  if (manager === "pnpm") {
    if (!/\bERR_PNPM_NO_MATCHING_VERSION\b/.test(output)) return undefined;
    if (
      /\bERR_PNPM_NO_MATURE_MATCHING_VERSION\b|minimumReleaseAge|published before|release age/i.test(
        flat,
      )
    )
      return undefined;
    found = [
      ...flat.matchAll(
        /No matching version found for (.+?) while fetching it from /g,
      ),
    ];
  } else {
    if (!/^npm error code ETARGET$/m.test(output)) return undefined;
    if (/min-release-age|release age/i.test(flat)) return undefined;
    found = [
      ...output.matchAll(
        /^npm error notarget No matching version found for (.+?)(?: with a date before .+)?\.$/gm,
      ),
    ];
  }
  if (found.length !== 1) return undefined;
  const request = squeeze(found[0]![1]!);
  return request && request.length <= NAME_LIMIT + 1 + RANGE_LIMIT
    ? request
    : undefined;
}

/** A specifier the candidate declares: a package and the range it asks for. */
export interface Declared {
  name: string;
  range: string;
}

/** The package an override key replaces: `name`, `name@range`, `parent>name`. */
function overriddenName(key: string): string | undefined {
  const last = key.split(">").pop()!.trim();
  return /^(@[^@/\s]+\/[^@/\s]+|[^@/\s]+)(?:@.*)?$/.exec(last)?.[1];
}

/** Every override value at any depth, by the package it replaces (npm's nesting, `.` for the parent). */
function overrides(entries: unknown, into: Declared[], parent?: string): void {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
  for (const [key, value] of Object.entries(entries)) {
    const name = key === "." ? parent : overriddenName(key);
    if (typeof value === "string") {
      if (name) into.push({ name, range: value });
    } else overrides(value, into, name);
  }
}

/** Name-to-string entries of a mapping. */
function entries(value: unknown, into: Declared[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [name, range] of Object.entries(value))
    if (typeof range === "string") into.push({ name, range });
}

const MANIFEST_DEPENDENCIES = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * The specifiers `commit` declares in the package inputs it changed from
 * `base`: each changed package.json's dependencies and overrides, and a
 * changed pnpm-workspace.yaml's overrides, catalog and catalogs. Undefined
 * when one of them can't be read.
 */
export async function declaredRequests(
  worktree: string,
  base: string,
  commit: string,
  signal?: AbortSignal,
): Promise<Declared[] | undefined> {
  const changed = (
    await hostGit(
      worktree,
      ["diff-tree", "-r", "--name-only", "-z", "--no-renames", base, commit],
      { signal },
    )
  )
    .toString("utf8")
    .split("\0")
    .filter(
      (path) =>
        posix.basename(path) === "package.json" ||
        path === "pnpm-workspace.yaml",
    );
  const declared: Declared[] = [];
  for (const path of changed) {
    const listed = await hostGit(worktree, ["ls-tree", commit, "--", path], {
      signal,
    });
    // Removed: it asks for nothing.
    if (!listed.length) continue;
    const text = (
      await hostGit(worktree, ["show", `${commit}:${path}`], { signal })
    ).toString("utf8");
    let document: unknown;
    try {
      document = path.endsWith(".yaml") ? parseYaml(text) : JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!document || typeof document !== "object" || Array.isArray(document))
      return undefined;
    const fields = document as Record<string, unknown>;
    if (path === "pnpm-workspace.yaml") {
      overrides(fields.overrides, declared);
      entries(fields.catalog, declared);
      const catalogs = fields.catalogs;
      if (catalogs && typeof catalogs === "object" && !Array.isArray(catalogs))
        for (const catalog of Object.values(catalogs))
          entries(catalog, declared);
      continue;
    }
    for (const group of MANIFEST_DEPENDENCIES) entries(fields[group], declared);
    overrides(fields.overrides, declared);
    const pnpm = fields.pnpm as Record<string, unknown> | undefined;
    if (pnpm && typeof pnpm === "object") overrides(pnpm.overrides, declared);
  }
  return declared;
}

/**
 * The one declared specifier the refusal names (whitespace aside), or
 * undefined when none does or several different ones do.
 */
export function matchRequest(
  request: string,
  declared: readonly Declared[],
): Declared | undefined {
  const matches = new Map<string, Declared>();
  for (const entry of declared)
    if (squeeze(`${entry.name}@${entry.range}`) === request)
      matches.set(`${entry.name}\0${entry.range}`, entry);
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

/**
 * Why Factory won't look a declared specifier up, or undefined when it
 * may: a name it can pass to the lookup, and a plain semver range with no
 * prerelease. A dist-tag, an `npm:` alias, a protocol (`workspace:`,
 * `catalog:`, git, `file:`, a URL) or a prerelease range holds.
 */
export function lookupRefusal(request: Declared): string | undefined {
  const { name, range } = request;
  if (name.length > NAME_LIMIT || !LOOKUP_NAME.test(name))
    return "its package name isn't one Factory looks up";
  if (
    !range.trim() ||
    range.length > RANGE_LIMIT ||
    !RANGE_CHARACTERS.test(range)
  )
    return "the requested version isn't a plain semver range";
  // A prerelease tag hangs on its version (`1.0.0-beta`); a hyphen range
  // has spaces around its hyphen. (semver's own comparators can't tell:
  // they bound `^1.0.0` by `<2.0.0-0`.)
  if (/[^\s-]-/.test(range)) return "the requested range names a prerelease";
  if (validRange(range, { loose: true }) === null)
    return "the requested version isn't a semver range (a dist-tag, say)";
  return undefined;
}

/** The package manager's metadata lookup for `name` (checked by lookupRefusal). */
export function lookupCommand(manager: PackageManager, name: string): string {
  return `${manager} view '${name}' versions time --json`;
}

/** What the registry's answer says about the requested range. */
export type Lookup =
  /** No published version satisfies it: the worker's to repair. */
  | { kind: "missing"; published: number; newest: string[] }
  /** One does: the package manager's policy or the registry refused it. */
  | { kind: "satisfied"; version: string; published?: string }
  /** Factory can't tell. */
  | { kind: "unknown"; reason: string };

const unknown = (reason: string): Lookup => ({ kind: "unknown", reason });

/** An ISO time from a registry value, or undefined. */
function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

/**
 * Judge `pnpm view`/`npm view <name> versions time --json` output
 * against `range`. The published versions are `versions` and the keys of
 * `time` together (a version either names counts), parsed loosely, and
 * one satisfies the range when semver says so with prereleases included:
 * every doubt counts as satisfying, which holds. Output that isn't one
 * JSON object with a list of versions, an `error` object (pnpm prints one
 * and exits 0 for a package the registry lacks) or no readable version is
 * unknown.
 */
export function judgeLookup(range: string, stdout: string): Lookup {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return unknown("its output isn't JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return unknown("its output isn't one JSON object");
  const fields = data as Record<string, unknown>;
  if ("error" in fields) return unknown("it reported an error");
  const listed =
    typeof fields.versions === "string" ? [fields.versions] : fields.versions;
  if (
    !Array.isArray(listed) ||
    listed.some((version) => typeof version !== "string")
  )
    return unknown("it listed no versions");
  const time = fields.time ?? {};
  if (!time || typeof time !== "object" || Array.isArray(time))
    return unknown("its publish times aren't a mapping");
  const times = time as Record<string, unknown>;
  const published = new Map<string, string | undefined>();
  for (const raw of [
    ...(listed as string[]),
    ...Object.keys(times).filter(
      (key) => key !== "created" && key !== "modified",
    ),
  ]) {
    const version = parseVersion(raw, { loose: true })?.version;
    if (!version) continue;
    published.set(version, published.get(version) ?? isoTime(times[raw]));
  }
  if (!published.size) return unknown("it listed no version Factory can read");
  const matching = [...published.keys()]
    .filter((version) =>
      satisfies(version, range, { loose: true, includePrerelease: true }),
    )
    .sort(rcompare);
  if (matching.length) {
    const version = matching[0]!;
    const at = published.get(version);
    return { kind: "satisfied", version, ...(at ? { published: at } : {}) };
  }
  return {
    kind: "missing",
    published: published.size,
    newest: [...published.keys()]
      .filter((version) => RELEASE.test(version))
      .sort(rcompare)
      .slice(0, NEWEST_SHOWN),
  };
}

/** What the worker reads when no published version satisfies its range. */
export function repairMessage(
  manager: PackageManager,
  request: Declared,
  lookup: Extract<Lookup, { kind: "missing" }>,
): string {
  const { name, range } = request;
  const newest = lookup.newest.length
    ? ` The newest releases are ${lookup.newest.join(", ")}.`
    : "";
  return `no published version of ${name} satisfies \`${range}\`. Factory looked ${name} up in the configured registry (\`${lookupCommand(manager, name)}\`): none of its ${lookup.published} published version${lookup.published === 1 ? "" : "s"} satisfies the range your change requests.${newest} Request a version of ${name} that is published; leave the lockfile as it is, since Factory resolves it again.`;
}

/** What the hold adds about the lookup. */
export function holdNote(
  request: Declared,
  lookup: Exclude<Lookup, { kind: "missing" }>,
): string {
  const { name, range } = request;
  if (lookup.kind === "satisfied")
    return `Factory looked ${name} up in the registry: ${lookup.version}${lookup.published ? `, published ${lookup.published},` : ""} satisfies \`${range}\`, so the version exists and the repository's package policy (such as its minimum release age) or the registry refused it.`;
  return `Factory looked ${name} up in the registry and couldn't tell whether a published version satisfies \`${range}\`: ${lookup.reason}.`;
}
