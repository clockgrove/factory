import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { batchObjects, pinnedGitExit } from "../git.js";
import { markdownLines } from "../markdown.js";

/**
 * The planner and graph reviewer read the repository at the exact base
 * commit. Factory exports its tracked regular files into a read-only
 * directory (no Git metadata, no untracked or ignored files, no network) and
 * renders a compact path map and a conventions map for orientation. All are
 * pure functions of the base commit, so a repeated step renders the same
 * bytes and the provider cache keeps its prefix.
 */
export const REPOSITORY_DIRECTORY = "repository";

/** What the planner or graph reviewer can see of the repository at the base. */
export interface RepositoryView {
  /** Deterministic path map of the base tree. */
  map: string;
  /** Exported symbols and duplicated helpers of the base tree. */
  conventions: string;
  /** `repository/` in the read directory holds the exported base files. */
  reads: boolean;
}

/** The map and conventions at `base`; `reads` when the call gets the exported tree. */
export async function repositoryView(
  checkout: string,
  base: string,
  reads: boolean,
  signal?: AbortSignal,
): Promise<RepositoryView> {
  const entries = await treeEntries(checkout, base, signal);
  return {
    map: await renderMap(checkout, base, entries, signal),
    conventions: await renderConventions(checkout, base, entries, signal),
    reads,
  };
}

// ---------------------------------------------------------------------------
// Git

/** Run pinned Git and collect its raw standard output. */
async function git(
  checkout: string,
  args: string[],
  input?: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const result = await pinnedGitExit(checkout, args, { input, signal });
  if (result.code === 0) return result.stdout;
  throw new Error(`git ${args[0]} exited ${result.code}: ${result.stderr}`);
}

// ---------------------------------------------------------------------------
// Tree

/** Larger blobs stay listed in the map but are not exported. */
const MAX_FILE_BYTES = 1_048_576;
/** Total exported bytes; later paths past the bound stay listed only. */
const MAX_TREE_BYTES = 67_108_864;
/** Rendered map bound; the remainder is counted, not listed. */
const MAX_MAP_BYTES = 49_152;
/** Exported Markdown files above this size get a heading outline in the map. */
const OUTLINE_MIN_FILE_BYTES = 32_768;
/**
 * Total outline bound. Deeper heading levels are dropped first (3, then 2);
 * level-1 headings past the bound are counted, not listed.
 */
const MAX_OUTLINE_BYTES = 8192;

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number;
  exported: boolean;
  note?: string;
}

async function treeEntries(
  checkout: string,
  base: string,
  signal?: AbortSignal,
): Promise<TreeEntry[]> {
  let total = 0;
  const listing = await git(
    checkout,
    ["ls-tree", "-rzl", "--full-tree", base],
    undefined,
    signal,
  );
  return listing
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, sha, size] = line.slice(0, tab).trim().split(/\s+/);
      const entry: TreeEntry = {
        path: line.slice(tab + 1),
        mode: mode!,
        type: type!,
        sha: sha!,
        size: type === "blob" ? Number(size) : 0,
        exported: false,
      };
      if (type === "commit") entry.note = "submodule, not exported";
      else if (mode === "120000") entry.note = "symlink, not exported";
      else if (entry.size > MAX_FILE_BYTES)
        entry.note = "over 1 MiB, not exported";
      else if (total + entry.size > MAX_TREE_BYTES)
        entry.note = "past the 64 MiB export bound, not exported";
      else {
        entry.exported = true;
        total += entry.size;
      }
      return entry;
    });
}

/** The exact bytes of these base-tree blobs, in order. */
async function readBlobs(
  checkout: string,
  files: readonly TreeEntry[],
  signal?: AbortSignal,
): Promise<Buffer[]> {
  if (!files.length) return [];
  const output = await git(
    checkout,
    ["cat-file", "--batch"],
    files.map((entry) => `${entry.sha}\n`).join(""),
    signal,
  );
  const objects = batchObjects(output, files.length);
  return files.map((entry, index) => {
    const { header, body } = objects[index]!;
    if (header !== `${entry.sha} blob ${entry.size}`)
      throw new Error(
        `git cat-file returned "${header}" for ${entry.path}; expected ${entry.sha} blob ${entry.size}`,
      );
    return body;
  });
}

/** Deterministic orientation text: every tracked path with its byte size, bounded. */
async function renderMap(
  checkout: string,
  base: string,
  entries: TreeEntry[],
  signal?: AbortSignal,
): Promise<string> {
  const treeSha = (
    await git(checkout, ["rev-parse", `${base}^{tree}`], undefined, signal)
  )
    .toString("utf8")
    .trim();
  const exported = entries.filter((entry) => entry.exported);
  const header = `Repository map at base ${base} (tree ${treeSha}): ${entries.length} tracked entries, ${entries.reduce((sum, entry) => sum + entry.size, 0)} bytes; ${exported.length} files (${exported.reduce((sum, entry) => sum + entry.size, 0)} bytes) are exported for reading. One line per path: path, tab, bytes, then a note when the file is not exported.\n`;
  const lines: string[] = [];
  let bytes = Buffer.byteLength(header) + 256;
  for (const entry of entries) {
    const line = `${entry.path}\t${entry.size}${entry.note ? `\t${entry.note}` : ""}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_MAP_BYTES) break;
    lines.push(line);
  }
  const omitted = entries.length - lines.length;
  return `${header}${lines.join("")}${omitted ? `... ${omitted} more paths are not listed (map bound ${MAX_MAP_BYTES} bytes); find them with your read tools.\n` : ""}${await markdownOutline(checkout, exported, signal)}`;
}

/**
 * Heading outlines of large exported Markdown files, so a reader opens the
 * section it needs instead of searching the file for headings. Bounded by
 * MAX_OUTLINE_BYTES; fenced code is not scanned for headings.
 */
async function markdownOutline(
  checkout: string,
  exported: TreeEntry[],
  signal?: AbortSignal,
): Promise<string> {
  const large = exported.filter(
    (entry) => entry.size > OUTLINE_MIN_FILE_BYTES && /\.md$/i.test(entry.path),
  );
  if (!large.length) return "";
  const files = (await readBlobs(checkout, large, signal)).map((body, at) => {
    const headings = markdownLines(body.toString("utf8")).flatMap(
      ({ heading }, index) =>
        heading?.text
          ? [
              {
                level: heading.level,
                line: `${index + 1}\t${"#".repeat(heading.level)} ${heading.text.slice(0, 160)}\n`,
              },
            ]
          : [],
    );
    return { path: large[at]!.path, headings };
  });
  const header = (level: number) =>
    `Heading outlines of exported Markdown files over ${OUTLINE_MIN_FILE_BYTES} bytes, levels 1-${level}: the path, then one line per heading: 1-based line number, tab, heading.\n`;
  for (let level = 3; level >= 1; level--) {
    const parts = [header(level)];
    let bytes = Buffer.byteLength(parts[0]!) + 128;
    let omitted = 0;
    for (const file of files) {
      const selected = file.headings.filter((entry) => entry.level <= level);
      if (!selected.length) continue;
      for (const [at, line] of [`${file.path}\n`, ...selected].entries()) {
        const text = typeof line === "string" ? line : line.line;
        if (omitted || bytes + Buffer.byteLength(text) > MAX_OUTLINE_BYTES) {
          omitted += selected.length - Math.max(0, at - 1);
          break;
        }
        bytes += Buffer.byteLength(text);
        parts.push(text);
      }
    }
    if (!omitted) return parts.join("");
    if (level === 1)
      return `${parts.join("")}... ${omitted} more headings are not listed (outline bound ${MAX_OUTLINE_BYTES} bytes).\n`;
  }
  return "";
}

/**
 * Write the exported files of the base tree under `dir/repository`, read-only.
 * An existing directory is the same export (the base never changes) and is
 * kept, so a repeated step reuses it. A crash mid-export leaves only the
 * staging directory, which the next run replaces.
 */
export async function exportTree(
  checkout: string,
  base: string,
  dir: string,
  signal?: AbortSignal,
): Promise<string> {
  const root = join(resolve(dir), REPOSITORY_DIRECTORY);
  const existing = await lstat(root).catch(() => undefined);
  if (existing?.isDirectory() && !existing.isSymbolicLink()) return root;
  if (existing) await rm(root, { recursive: true, force: true });
  const files = (await treeEntries(checkout, base, signal)).filter(
    (entry) => entry.exported,
  );
  const bodies = await readBlobs(checkout, files, signal);
  const staging = `${root}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const [index, entry] of files.entries()) {
    const path = resolve(staging, entry.path);
    // Git never stores such a path; skip rather than write outside.
    if (!path.startsWith(`${staging}${sep}`)) continue;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bodies[index]!, { flag: "wx", mode: 0o444 });
  }
  await rename(staging, root);
  return root;
}

// ---------------------------------------------------------------------------
// Conventions

/**
 * Planners and workers reuse a repository's shared helpers only when they know
 * them. Factory derives a compact conventions map from the exact base tree:
 * the top-level export declarations of TypeScript/JavaScript source files (a
 * line scan, no type checker), ranked by how many files import them, plus
 * top-level helpers defined in several files. It is reference data for
 * planning and self-review, never instructions or authority.
 */

/**
 * Rendered bound, about 1.5k tokens: small next to the path map (48 KiB) and
 * the worker instructions, yet room for the most-imported modules of a
 * medium monorepo. Entries past it are counted, not listed.
 */
const MAX_CONVENTIONS_BYTES = 6144;
/** Duplicate helpers take at most this share, so exports always appear. */
const MAX_DUPLICATE_BYTES = 1536;
/** Larger sources are generated or bundled, not hand-written helpers. */
const MAX_SOURCE_BYTES = 262_144;
const MAX_TOTAL_SOURCE_BYTES = 33_554_432;
/** Helpers (functions, classes, values) come before types within this bound. */
const MAX_NAMES_PER_MODULE = 10;
const MAX_FILES_PER_DUPLICATE = 5;

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"];
/** Tests, declarations, generated and vendored files are not shared helpers. */
const SKIPPED =
  /(?:^|\/)(?:node_modules|dist|build|out|coverage|vendor|tests?|__tests__|__mocks__|fixtures?)\/|\.(?:test|spec)\.[^/]+$|\.d\.[cm]?ts$|\.min\.js$/;
const DECLARATION =
  /^(export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(function\*?|abstract\s+class|class|interface|type|const\s+enum|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
/** A non-exported `const name = (...) =>` or `= function` is a helper too. */
const FUNCTION_VALUE =
  /^\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}\s*;?\s*$/gm;
const IMPORT =
  /^\s*(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/gm;

type Kind = "function" | "class" | "value" | "type";
const KIND_ORDER: Record<Kind, number> = {
  function: 0,
  class: 1,
  value: 2,
  type: 3,
};

interface Module {
  path: string;
  exports: Map<string, Kind>;
  /** Top-level functions and classes, exported or not. */
  helpers: Set<string>;
  importers: Set<string>;
  symbolImporters: Map<string, Set<string>>;
}

function kindOf(keyword: string): Kind {
  if (keyword.startsWith("function")) return "function";
  if (keyword.endsWith("class")) return "class";
  if (/^(?:const|let|var)$/.test(keyword)) return "value";
  return "type";
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function namedImports(clause: string): string[] {
  const list = /\{([^}]*)\}/.exec(clause)?.[1];
  if (!list) return [];
  return list
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]!
        .trim(),
    )
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

function scan(path: string, text: string): Module {
  const module: Module = {
    path,
    exports: new Map(),
    helpers: new Set(),
    importers: new Set(),
    symbolImporters: new Map(),
  };
  const local = new Map<string, Kind>();
  for (const match of text.matchAll(DECLARATION)) {
    const [, exported, keyword, name] = match;
    let kind = kindOf(keyword!);
    if (
      kind === "value" &&
      FUNCTION_VALUE.test(
        text.slice(
          match.index + match[0].length,
          match.index + match[0].length + 400,
        ),
      )
    )
      kind = "function";
    if (exported) module.exports.set(name!, kind);
    else local.set(name!, kind);
    if (kind === "function" || kind === "class") module.helpers.add(name!);
  }
  for (const match of text.matchAll(EXPORT_LIST))
    for (const entry of match[1]!.split(",")) {
      const [name, alias] = entry
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      if (name && local.has(name))
        module.exports.set((alias ?? name).trim(), local.get(name)!);
    }
  return module;
}

function workspacePackages(
  files: readonly { path: string; body: string }[],
): { name: string; root: string }[] {
  const packages: { name: string; root: string }[] = [];
  for (const { path, body } of files) {
    let name: unknown;
    try {
      name = (JSON.parse(body) as { name?: unknown }).name;
    } catch {
      continue;
    }
    if (typeof name === "string" && name)
      packages.push({ name, root: posix.dirname(path) });
  }
  // Longest name first, so `@a/b-c` wins over `@a/b` for `@a/b-c/x`.
  return packages.sort(
    (left, right) =>
      right.name.length - left.name.length || compare(left.name, right.name),
  );
}

/** Deterministic bounded text naming the base tree's shared helpers; "" when none. */
async function renderConventions(
  checkout: string,
  base: string,
  tree: TreeEntry[],
  signal?: AbortSignal,
): Promise<string> {
  const entries = tree.filter(
    (entry) => entry.type === "blob" && entry.mode !== "120000",
  );
  const sources: TreeEntry[] = [];
  let total = 0;
  for (const entry of entries)
    if (
      SOURCE.test(entry.path) &&
      !SKIPPED.test(entry.path) &&
      entry.size <= MAX_SOURCE_BYTES &&
      total + entry.size <= MAX_TOTAL_SOURCE_BYTES
    ) {
      sources.push(entry);
      total += entry.size;
    }
  if (!sources.length) return "";
  const manifests = entries.filter(
    (entry) =>
      posix.basename(entry.path) === "package.json" &&
      !SKIPPED.test(entry.path) &&
      entry.size <= MAX_SOURCE_BYTES,
  );
  const bodies = (
    await readBlobs(checkout, [...sources, ...manifests], signal)
  ).map((body) => body.toString("utf8"));
  const modules = new Map<string, Module>();
  for (const [index, entry] of sources.entries())
    modules.set(entry.path, scan(entry.path, bodies[index]!));
  const packages = workspacePackages(
    manifests.map((entry, index) => ({
      path: entry.path,
      body: bodies[sources.length + index]!,
    })),
  );
  const packageOf = (path: string) =>
    packages.find(
      (entry) => entry.root !== "." && path.startsWith(`${entry.root}/`),
    );

  // The first module, by path, under `root` that exports `name`.
  const definer = (root: string, name: string) => {
    for (const module of modules.values())
      if (
        (root === "." || module.path.startsWith(`${root}/`)) &&
        module.exports.has(name)
      )
        return module;
    return undefined;
  };
  const resolveRelative = (from: string, specifier: string) => {
    const joined = posix.join(posix.dirname(from), specifier);
    const stem = joined.replace(/\.(?:[cm]?js|jsx)$/, "");
    for (const candidate of [
      joined,
      ...EXTENSIONS.map((extension) => stem + extension),
      ...EXTENSIONS.map((extension) => `${joined}/index${extension}`),
    ]) {
      const module = modules.get(candidate);
      if (module) return module;
    }
    return undefined;
  };
  for (const [index, entry] of sources.entries())
    for (const match of bodies[index]!.matchAll(IMPORT)) {
      const [, clause, specifier] = match;
      const names = namedImports(clause!);
      if (specifier!.startsWith(".")) {
        const target = resolveRelative(entry.path, specifier!);
        if (!target) continue;
        target.importers.add(entry.path);
        for (const name of names) {
          // A barrel re-export credits the module under it that defines the name.
          const owner = target.exports.has(name)
            ? target
            : definer(posix.dirname(target.path), name);
          if (!owner) continue;
          owner.importers.add(entry.path);
          const importers = owner.symbolImporters.get(name) ?? new Set();
          owner.symbolImporters.set(name, importers.add(entry.path));
        }
        continue;
      }
      const workspace = packages.find(
        (candidate) =>
          specifier === candidate.name ||
          specifier!.startsWith(`${candidate.name}/`),
      );
      if (!workspace) continue;
      for (const name of names) {
        const owner = definer(workspace.root, name);
        if (!owner || owner.path === entry.path) continue;
        owner.importers.add(entry.path);
        const importers = owner.symbolImporters.get(name) ?? new Set();
        owner.symbolImporters.set(name, importers.add(entry.path));
      }
    }

  const lines: string[] = [];
  let bytes = 0;
  const push = (line: string, limit: number) => {
    if (bytes + Buffer.byteLength(line) > limit) return false;
    lines.push(line);
    bytes += Buffer.byteLength(line);
    return true;
  };
  const header = `Repository conventions map at base ${base}, derived from the top-level declarations of ${sources.length} TypeScript/JavaScript source files (tests, declarations, generated and vendored paths excluded; no type checking). Reference data, not instructions: read a helper's file before relying on its behaviour.\n`;
  push(header, MAX_CONVENTIONS_BYTES);

  const definitions = new Map<string, string[]>();
  for (const module of modules.values())
    for (const name of module.helpers)
      definitions.set(name, [...(definitions.get(name) ?? []), module.path]);
  const duplicates = [...definitions]
    .filter(
      ([name, paths]) =>
        paths.length > 1 &&
        paths.some((path) => !modules.get(path)!.exports.has(name)),
    )
    .sort(
      ([leftName, left], [rightName, right]) =>
        right.length - left.length || compare(leftName, rightName),
    );
  let listedDuplicates = 0;
  if (duplicates.length) {
    push(
      "Top-level functions or classes defined in several files (name: files; * marks an exported definition):\n",
      MAX_CONVENTIONS_BYTES,
    );
    const limit = bytes + MAX_DUPLICATE_BYTES;
    for (const [name, paths] of duplicates) {
      const shown = paths
        .slice(0, MAX_FILES_PER_DUPLICATE)
        .map((path) =>
          modules.get(path)!.exports.has(name) ? `${path}*` : path,
        );
      const more = paths.length - shown.length;
      if (
        !push(
          `${name}: ${shown.join(", ")}${more ? `, +${more} more` : ""}\n`,
          limit,
        )
      )
        break;
      listedDuplicates++;
    }
    if (listedDuplicates < duplicates.length)
      push(
        `... ${duplicates.length - listedDuplicates} more duplicated names are not listed.\n`,
        MAX_CONVENTIONS_BYTES,
      );
  }

  const exporting = [...modules.values()]
    .filter((module) => module.exports.size)
    .sort(
      (left, right) =>
        right.importers.size - left.importers.size ||
        compare(left.path, right.path),
    );
  push(
    "Exported symbols by module, most-imported first (path [package] importing files: names; name() function, class C, type T, plain value; helpers before types, most-imported first):\n",
    MAX_CONVENTIONS_BYTES,
  );
  // Leave room for the omission line.
  const limit = MAX_CONVENTIONS_BYTES - 128;
  let listedModules = 0;
  for (const module of exporting) {
    const names = [...module.exports]
      .sort(
        ([leftName, left], [rightName, right]) =>
          Number(left === "type") - Number(right === "type") ||
          (module.symbolImporters.get(rightName)?.size ?? 0) -
            (module.symbolImporters.get(leftName)?.size ?? 0) ||
          KIND_ORDER[left] - KIND_ORDER[right] ||
          compare(leftName, rightName),
      )
      .map(([name, kind]) =>
        kind === "function"
          ? `${name}()`
          : kind === "class"
            ? `class ${name}`
            : kind === "type"
              ? `type ${name}`
              : name,
      );
    const shown = names.slice(0, MAX_NAMES_PER_MODULE);
    const workspace = packageOf(module.path);
    if (
      !push(
        `${module.path}${workspace ? ` [${workspace.name}]` : ""} ${module.importers.size}: ${shown.join(", ")}${names.length > shown.length ? `, +${names.length - shown.length} more` : ""}\n`,
        limit,
      )
    )
      break;
    listedModules++;
  }
  if (listedModules < exporting.length)
    push(
      `... ${exporting.length - listedModules} more exporting modules are not listed (map bound ${MAX_CONVENTIONS_BYTES} bytes); search the repository for them.\n`,
      MAX_CONVENTIONS_BYTES,
    );
  return lines.join("");
}
