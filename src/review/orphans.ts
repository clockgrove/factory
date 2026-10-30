/**
 * Modules a change leaves unreachable (#2253): a file that some file the
 * change edits or removes imported at the base, that the result still
 * holds, and that no tracked source file of the result imports. Result and
 * final review get them as evidence and judge each one (result.ts
 * `UNREACHABLE_GUIDANCE`): removed, kept with a reason the handoff records,
 * or a fix finding. Live, an item rewrote a web client's entry point, left
 * four modules nothing imported any more, and both reviews passed.
 *
 * It reads Git only, with no network and no repository configuration: the
 * tracked files with a source extension are the source. Import forms read:
 * JS/TS `import … from`, `export … from`, side-effect `import`, `import()`
 * and `require()` with a string argument; CSS `@import`, `@use` and
 * `@forward`; Python `from .x import y`. A relative specifier resolves
 * against the tree's regular files the way bundlers do: the exact path,
 * a TypeScript source for a `.js` name, an added extension, then a
 * directory's index (Python: `x.py`, then `x/__init__.py`).
 *
 * Unknown is never unreachable. At the base, a specifier that doesn't
 * resolve (a package, an alias, a computed import) names no target. In the
 * result, every reference that might reach a target keeps it off the list:
 * a computed relative `import()`/`require()` covers every path under its
 * static prefix, and a non-relative specifier (an alias such as `@/x`, a
 * baseUrl path, a Python absolute import) covers each target whose path,
 * without extension or index, ends with it.
 *
 * Bounded like the candidate export: files over 1 MiB are not read, and a
 * result whose source files hold more than 64 MiB is not scanned
 * (undefined: the caller says so in its log).
 */
import { posix } from "node:path";
import { readBlobs } from "../git.js";
import { ownsPath } from "../planning/graph.js";
import { treeFiles } from "../repair.js";
import { hostGit } from "../worktree.js";

const SCRIPT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const STYLE = [".css", ".scss", ".sass", ".less"];
/** Script, style and Python sources, plus single-file components whose imports read as script. */
const SOURCE = new Set([...SCRIPT, ...STYLE, ".py", ".vue", ".svelte"]);
/** The candidate export's per-file and total bounds (result.ts). */
const FILE_BYTES = 1_048_576;
const TOTAL_BYTES = 67_108_864;

/** What one file's imports reach: resolved paths, and what keeps a target unknown. */
interface References {
  paths: string[];
  /** Paths under a computed relative import's static prefix. */
  prefixes: string[];
  /** Module paths a non-relative specifier may name, by suffix. */
  hints: string[];
}

/**
 * The files `changed` left unreachable between `base` and `commit`, within
 * the `scope` owned-path scopes, sorted; undefined when the result's
 * sources exceed the bound.
 */
export async function unreachableModules(input: {
  checkout: string;
  base: string;
  commit: string;
  /** The paths the change touched. */
  changed: readonly string[];
  /** Owned-path scopes (planning/graph.ts ownsPath). */
  scope: readonly string[];
  signal: AbortSignal;
}): Promise<string[] | undefined> {
  const { checkout, signal } = input;
  const scope = [...input.scope];
  const read = async (files: { path: string; oid: string }[]) =>
    readBlobs(
      (args, stdin) => hostGit(checkout, args, { input: stdin, signal }),
      files.map((file) => file.oid),
    );
  const atBase = await treeFiles(checkout, input.base, signal);
  const baseTracked = new Set(atBase.map((file) => file.path));
  const changed = new Set(input.changed);
  const edited = sources(atBase.filter((file) => changed.has(file.path)));
  if (!edited) return undefined;
  const targets = new Set<string>();
  for (const [index, body] of (await read(edited)).entries()) {
    const from = edited[index]!.path;
    for (const path of references(from, body.toString("utf8"), baseTracked)
      .paths)
      if (path !== from && ownsPath(path, scope)) targets.add(path);
  }
  if (!targets.size) return [];
  const atResult = await treeFiles(checkout, input.commit, signal);
  const tracked = new Set(atResult.map((file) => file.path));
  const left = [...targets].filter((path) => tracked.has(path));
  if (!left.length) return [];
  const scanned = sources(atResult);
  if (!scanned) return undefined;
  const reached = new Set<string>();
  const prefixes: string[] = [];
  const hints: string[] = [];
  for (const [index, body] of (await read(scanned)).entries()) {
    const found = references(
      scanned[index]!.path,
      body.toString("utf8"),
      tracked,
    );
    for (const path of found.paths) reached.add(path);
    prefixes.push(...found.prefixes);
    hints.push(...found.hints);
  }
  return left
    .filter(
      (path) =>
        !reached.has(path) &&
        !prefixes.some((prefix) => path.startsWith(prefix)) &&
        !hints.some((hint) => named(path, hint)),
    )
    .sort();
}

/** The source files among `files` within the per-file bound; undefined past the total. */
function sources<T extends { path: string; size: number }>(
  files: T[],
): T[] | undefined {
  const kept = files.filter(
    (file) => SOURCE.has(posix.extname(file.path)) && file.size <= FILE_BYTES,
  );
  const total = kept.reduce((sum, file) => sum + file.size, 0);
  return total <= TOTAL_BYTES ? kept : undefined;
}

/** Whether a non-relative specifier's module path `hint` may name `path`. */
function named(path: string, hint: string): boolean {
  const want = stem(hint);
  if (!want) return false;
  const own = stem(path);
  return [own, own.replace(/\/(?:index|__init__)$/, "")].some(
    (form) => form === want || form.endsWith(`/${want}`),
  );
}

function stem(path: string): string {
  const ext = posix.extname(path);
  return ext ? path.slice(0, -ext.length) : path;
}

const SCRIPT_STATIC =
  /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"'\n]+)["']|\bimport\s*["']([^"'\n]+)["']/g;
const SCRIPT_CALL =
  /\b(?:import|require)\s*\(\s*(?:["']([^"'\n]+)["']|`([^`]*)`)/g;
const STYLE_IMPORT =
  /@(?:import|use|forward)\s+(?:url\(\s*)?["']?([^"'()\s;]+)["']?/g;
const PYTHON_RELATIVE =
  /^[ \t]*from[ \t]+(\.+)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)/gm;
const PYTHON_ABSOLUTE =
  /^[ \t]*(?:from[ \t]+(\w[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)|import[ \t]+([^\n#;]+))/gm;

/** What the imports in `text`, the file at `from`, reach among `tracked`. */
function references(
  from: string,
  text: string,
  tracked: ReadonlySet<string>,
): References {
  const found: References = { paths: [], prefixes: [], hints: [] };
  const dir = posix.dirname(from);
  const ext = posix.extname(from);
  const add = (path: string | undefined) => {
    if (path) found.paths.push(path);
  };
  if (STYLE.includes(ext)) {
    for (const [, spec] of text.matchAll(STYLE_IMPORT))
      add(styleTarget(dir, ext, spec!, tracked));
    return found;
  }
  if (ext === ".py") {
    for (const [, dots, module, list] of text.matchAll(PYTHON_RELATIVE))
      for (const path of pythonTargets(dir, dots!, module!, list!, tracked))
        add(path);
    for (const [, module, list, plain] of text.matchAll(PYTHON_ABSOLUTE)) {
      const modules = module
        ? [module, ...names(list!).map((name) => `${module}.${name}`)]
        : names(plain!);
      found.hints.push(...modules.map((name) => name.replaceAll(".", "/")));
    }
    return found;
  }
  const specifier = (spec: string) => {
    const clean = spec.replace(/[?#].*$/s, "");
    if (relative(clean)) add(scriptTarget(dir, clean, tracked));
    else if (!/^[a-z][\w+.-]*:/i.test(clean)) {
      // An alias or scope's first segment (@/x, ~/x, #x/y, @scope/x) names no path.
      const path = clean.replace(/^\//, "");
      found.hints.push(
        /^[@~#$]/.test(path) ? path.slice(path.indexOf("/") + 1) : path,
      );
    }
  };
  for (const [, quoted, bare] of text.matchAll(SCRIPT_STATIC))
    specifier(quoted ?? bare!);
  for (const [, quoted, template] of text.matchAll(SCRIPT_CALL)) {
    const computed = template?.indexOf("${") ?? -1;
    if (computed < 0) specifier(quoted ?? template!);
    else if (relative(template!)) {
      const prefix = posix.join(dir, template!.slice(0, computed));
      found.prefixes.push(prefix.startsWith("..") ? "" : prefix);
    }
  }
  return found;
}

function relative(spec: string): boolean {
  return /^\.\.?(?:\/|$)/.test(spec);
}

/** A path relative to `dir`, or undefined when it leaves the tree. */
function within(dir: string, spec: string): string | undefined {
  const path = posix.join(dir, spec).replace(/\/$/, "");
  return path === ".." || path.startsWith("../") ? undefined : path;
}

const TYPESCRIPT_FOR: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

function scriptTarget(
  dir: string,
  spec: string,
  tracked: ReadonlySet<string>,
): string | undefined {
  const path = within(dir, spec);
  if (path === undefined) return undefined;
  const ext = posix.extname(path);
  const swapped = (TYPESCRIPT_FOR[ext] ?? []).map(
    (typed) => path.slice(0, -ext.length) + typed,
  );
  const index = path === "." ? "index" : `${path}/index`;
  return [
    path,
    ...swapped,
    ...[...SCRIPT, ".json"].map((added) => path + added),
    ...SCRIPT.map((added) => index + added),
  ].find((candidate) => tracked.has(candidate));
}

function styleTarget(
  dir: string,
  ext: string,
  spec: string,
  tracked: ReadonlySet<string>,
): string | undefined {
  if (/^(?:[a-z][\w+.-]*:|\/|~)/i.test(spec)) return undefined;
  const path = within(dir, spec);
  if (path === undefined) return undefined;
  const partial = posix.join(posix.dirname(path), `_${posix.basename(path)}`);
  return [path, path + ext, partial, partial + ext].find((candidate) =>
    tracked.has(candidate),
  );
}

function pythonTargets(
  dir: string,
  dots: string,
  module: string,
  list: string,
  tracked: ReadonlySet<string>,
): (string | undefined)[] {
  const pkg = within(dir, "../".repeat(dots.length - 1) || ".");
  if (pkg === undefined) return [];
  const join = (...parts: string[]) =>
    parts.filter((part) => part && part !== ".").join("/");
  const resolve = (path: string) =>
    [`${path}.py`, join(path, "__init__.py")].find((file) => tracked.has(file));
  const base = join(pkg, module.replaceAll(".", "/"));
  const submodules = names(list).map((name) => resolve(join(base, name)));
  return module
    ? [resolve(base), ...submodules]
    : submodules.map(
        (path) =>
          path ??
          (tracked.has(join(pkg, "__init__.py"))
            ? join(pkg, "__init__.py")
            : undefined),
      );
}

/** The imported names of a Python import list, without aliases or `*`. */
function names(list: string): string[] {
  return list
    .replace(/[()\\]/g, " ")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((name) => /^\w[\w.]*$/.test(name));
}
