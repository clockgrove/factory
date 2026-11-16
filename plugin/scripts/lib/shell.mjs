// Shell commands (the `setup` and `install` settings, and the package.json scripts they run), read with the `unbash`
// library (vendored: plugin/vendor/unbash, pinned in tools/deps), which parses GNU Bash's own grammar. The library
// parses; what a command refers to in the repository is Factory's own reading of that tree, so every rule sits in one
// place (commandRefs).
import { posix } from "node:path";
import { forEachChild, parse } from "../../vendor/unbash/dist/parser.js";

// Builtins that run nothing and read no file: their words are data, so a variable among them resolves nothing.
const DATA_BUILTINS = new Set(["echo", "printf", "export", "readonly", "declare", "typeset", "local", "set", "unset", "shift", "true", "false", ":", "test", "[", "exit", "return", "wait", "umask", "ulimit", "type", "hash", "read"]);
// Shells: a `-c` option before the script operand makes the first operand shell code; options that take a value.
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const SHELL_CODE = /^-[A-Za-z]*c[A-Za-z]*$/;
const SHELL_VALUED = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
// Programs that run the word after `-c` as shell code wherever it stands (`su -c '…' user`), and sudo, whose `-s` or
// `-i` makes the words after its options one shell command.
const SU = new Set(["su", "runuser"]);
const SUDO_SHELL = /^-[A-Za-z]*[si][A-Za-z]*$/;
// Interpreters whose first operand is a script, `-` or no operand a script on stdin; the options that make a word
// inline code (word-scanned) or a module (`python -m`), and those that take a value.
const PYTHON = /^(python|pypy)(\d+(\.\d+)*)?$|^py$/;
const INTERPRETERS = {
  python: { code: /^-[A-Za-z]*c$/, module: true, valued: new Set(["-W", "-X", "-Q"]) },
  node: { code: /^(-e|-p|--eval|--print)$/, valued: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-C", "--conditions", "--input-type"]) },
  ruby: { code: /^-[A-Za-z]*e$/, valued: new Set(["-I", "-r", "-C"]) },
  perl: { code: /^-[A-Za-z]*[eE]$/, valued: new Set(["-I", "-M", "-m"]) },
};
const interpreterOf = (base) => (PYTHON.test(base) ? INTERPRETERS.python : base === "node" || base === "nodejs" ? INTERPRETERS.node : INTERPRETERS[base] ?? null);
// Commands that run the command after their own options; the options that take a value, so the command is found.
const WRAPPERS = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout"]),
  exec: new Set(["-a"]), command: new Set(), builtin: new Set(), nohup: new Set(), time: new Set(["-f", "-o"]), nice: new Set(["-n"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]), stdbuf: new Set(["-i", "-o", "-e"]), ionice: new Set(["-c", "-n", "-p"]),
  xargs: new Set(["-a", "-d", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars"]),
};
// `timeout` and `nice -n` take a positional value before the command.
const POSITIONAL = { timeout: 1 };
// The package managers whose `run X`, or `X` alone, runs package.json's `scripts.X` with its `preX` and `postX`, from
// the package.json in the working directory or the nearest above it. The words naming the run are no script; npm's
// `t`/`tst` are `test`, and `restart` runs `stop` and `start` where no `restart` script is.
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUN_WORDS = new Set(["run", "run-script", "rum", "urn"]);
const SCRIPT_ALIASES = { t: ["test"], tst: ["test"], restart: ["stop", "start"] };
// Options that move a package manager to another package: a directory (exact when literal) or the workspace's packages.
const PM_DIR = new Set(["--prefix", "-C", "--dir", "--cwd"]);
const PM_WORKSPACE = /^(-r|--recursive|-w|--workspace|-ws|--workspaces|--workspace-root|-F|--filter|--include-workspace-root)(=|$)/;
const PM_VALUED = new Set(["--filter", "-F", "--workspace", "-w", "--loglevel", "--registry", "--reporter", "--cache", "--userconfig", "--tag"]);
// What a package manager reads beside each package.json it runs from: its configuration and hook files.
const PM_FILES = { npm: [".npmrc"], pnpm: [".npmrc", ".pnpmfile.cjs", "pnpm-workspace.yaml"], yarn: [".yarnrc", ".yarnrc.yml", ".npmrc"], bun: ["bunfig.toml", ".npmrc"] };
// Script runners other than the package managers: `node --run X`, `turbo run X` (every workspace package, with
// turbo.json), `npm-run-all`/`run-s`/`run-p` (the names given).
const RUN_ALL = new Set(["npm-run-all", "run-s", "run-p"]);
// pip's install sources: a directory is built through its build backend files.
const BACKEND = ["pyproject.toml", "setup.py", "setup.cfg"];
// A literal argument holding one of these may be shell code another program runs (`flock /l -c './x.sh'`): it is read
// as a command too, for the paths it names, and word-scanned when it does not parse.
const MAYBE_CODE = /[\s;&|<>()`$]/;
const MAX_DEPTH = 8;
const MAX_DIRS = 1024;
// A URL (`https://…`) is no path; a requirement or package spec (`uv==${V}`, `zod@${V}`) is none either.
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SPEC = /^(@[\w.-]+\/)?[A-Za-z0-9][\w.-]*(\[[^\]]*\])?\s*(===|==|>=|<=|~=|!=|<|>|@)/;
const NAME_VALUE = /^[A-Za-z_][A-Za-z0-9_.-]*=/;
// Variables whose value is a file a shell or node reads at start.
const FILE_VARS = new Set(["BASH_ENV", "ENV"]);

const literalPart = (p) => p.type === "Literal" || p.type === "SingleQuoted" || p.type === "AnsiCQuoted" || (p.type === "DoubleQuoted" && p.parts.every((c) => c.type === "Literal"));
/** Whether a word is one fixed string: no expansion, substitution, glob or brace. */
const literal = (w) => !w.parts || w.parts.every(literalPart);
/** An unquoted leading `~`. */
const tilde = (w) => w.text.startsWith("~");
const clip = (s) => (s.length > 100 ? `${s.slice(0, 97)}...` : s);
const base = (v) => v.split("/").pop().replace(/@[^/]*$/, "");
/** A word as a run of fixed text and expansions: [{lit}|{exp}], double quotes opened. */
const segments = (w) => {
  if (!w.parts) return [{ lit: w.value }];
  const out = [];
  for (const p of w.parts) {
    if (p.type === "DoubleQuoted") for (const c of p.parts) out.push(c.type === "Literal" ? { lit: c.value } : { exp: c });
    else out.push(literalPart(p) ? { lit: p.value } : { exp: p });
  }
  return out;
};
/** A word written `NAME=value` (an `env` argument): {name, value} with the value as a word, else null. */
const assignment = (w) => {
  const segs = segments(w);
  const m = "lit" in (segs[0] ?? {}) ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(segs[0].lit) : null;
  if (!m) return null;
  const parts = [{ type: "Literal", value: segs[0].lit.slice(m[0].length) }, ...segs.slice(1).map((x) => ("lit" in x ? { type: "Literal", value: x.lit } : x.exp))].filter((p) => p.type !== "Literal" || p.value !== "");
  return { name: m[1], value: { type: "Word", text: w.text.slice(w.text.indexOf("=") + 1), value: "", parts } };
};
/** The path-looking words of `text`, as Factory read a command before it parsed one: a word with a directory, an extension or a leading `./`. */
export function wordScan(text) {
  const out = [];
  for (const segment of String(text || "").split(/[;&|()<>`\n]+/)) {
    for (let w of segment.split(/\s+/)) {
      w = w.replace(/^['"]+|['"]+$/g, "");
      if (w.startsWith("-") && w.includes("=")) w = w.slice(w.indexOf("=") + 1);
      if (!w || w.startsWith("-") || /[=$~*?{}\\]|:\/\//.test(w) || w.startsWith("/")) continue;
      const dotted = /^\.\//.test(w);
      w = w.replace(/^(\.\/)+/, "");
      if (!w || w.split("/").some((s) => s === ".." || s === "")) continue;
      if (dotted || w.includes("/") || /\.[A-Za-z0-9]+$/.test(w)) out.push(w);
    }
  }
  return out;
}
const pathLooking = (v) => v.includes("/") || /\.[A-Za-z0-9]+$/.test(v);

/**
 * What a shell command refers to in the repository, read from its bash syntax tree. `ctx`: `cwd` (from the root, where
 * it runs), `errexit` (it runs under `bash -e`, as setup and install do; a package.json script does not), `env` (the
 * environment it starts with) and `roots` (absolute directories that are the repository: an absolute path under one is
 * a path in it). Returns {paths, maybe, guarded, scripts, unresolved}:
 * - `paths`: what a word names as a file, from the root: the command run (`./x.sh`), a script operand (`bash x.sh`), a
 *   path-looking argument (a directory, an extension, `./`), an option's or `NAME=`'s value, an input redirection, and
 *   the same inside code the command runs (`bash -c`, `su -c`, `sudo -s`, `eval`, `trap`, `$(…)`, a here-document fed to
 *   a shell), in each directory a literal `cd` may leave it (under `bash -e` a failing `cd` stops the command, except
 *   in an `&&`/`||` list). Every path-looking word of the text, as Factory read it before it parsed commands, counts
 *   too, and of a here-document, an assignment's value or inline code of another language.
 * - `maybe`: any other literal argument: a path only if the repository holds it.
 * - `guarded`: what the command runs without naming it: a PATH entry in the repository (a directory) and the commands
 *   it finds there, the files `python -m` may run, node's candidates for an extensionless script, the build files of a
 *   directory `pip install` builds, a package manager's configuration and hook files where it runs.
 * - `scripts`: package.json scripts it runs, {pkg, name}: `pkg` a package.json path, or `*` for any (a workspace option,
 *   `turbo`).
 * - `unresolved`: what may name a file and is not one fixed string (a variable, a substitution's output, a glob, a brace
 *   expansion), code it cannot read (a shell reading a pipe, remote code), a `cd` it cannot follow, `.` (the whole
 *   repository) outside `pip install`, a command that does not parse: each with why.
 * A word whose fixed start is a URL, `~/`, `$HOME/`, an absolute path outside `roots`, or a variable `env` holds as such
 * a path, names no repository file, and neither does a requirement spec (`uv==${V}`).
 */
export function commandRefs(command, { cwd = "", errexit = true, env = null, roots = [] } = {}) {
  const out = { paths: new Set(), maybe: new Set(), guarded: new Set(), scripts: new Set(), unresolved: new Set() };
  const vars = new Map();
  const pathDirs = new Set();
  const deferred = [];
  const allDirs = new Set([cwd]);

  const unknown = (what, why, spec) => {
    if (!spec) out.unresolved.add(`${clip(what)}${why ? ` (${why})` : ""}`);
  };
  const inRoot = (abs) => {
    for (const r of roots) {
      const root = r.replace(/\/+$/, "");
      if (abs === root) return "";
      if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
    }
    return null;
  };
  /** Whether an absolute directory prefix may lead into a root (`/` does; `/tmp/` does not, but for a checkout under it). */
  const mayLeadIn = (prefix) => roots.some((r) => `${r.replace(/\/+$/, "")}/`.startsWith(prefix) || prefix.startsWith(`${r.replace(/\/+$/, "")}/`));

  /** A word's value as a path: {path, rel} (rel: relative to the working directory), {outside}, {spec} or {unknown}. */
  const resolve = (w, segs = segments(w)) => {
    const allLit = segs.every((s) => "lit" in s);
    if (allLit) {
      const v = segs.map((s) => s.lit).join("");
      if (tilde(w)) {
        if (v === "~+" || v.startsWith("~+/")) return { path: v.slice(3), rel: true };
        if (v === "~-" || v.startsWith("~-/")) return { unknown: true };
        return { outside: true };
      }
      if (URL_SCHEME.test(v)) return { outside: true };
      if (v.startsWith("/")) {
        const r = inRoot(posix.normalize(v));
        return r === null ? { outside: true } : { path: r, rel: false };
      }
      return { path: v, rel: true, value: v };
    }
    let i = 0;
    let prefix = "";
    while (i < segs.length && "lit" in segs[i]) prefix += segs[(i += 1) - 1].lit;
    const rest = segs.slice(i + 1);
    const restLit = rest.every((s) => "lit" in s) ? rest.map((s) => s.lit).join("") : null;
    if (URL_SCHEME.test(prefix) || (tilde(w) && (prefix === "~" || prefix.startsWith("~/")))) return { outside: true };
    if (SPEC.test(prefix)) return { spec: true };
    if (prefix.startsWith("/")) return mayLeadIn(prefix.slice(0, prefix.lastIndexOf("/") + 1)) ? { unknown: true } : { outside: true };
    if (prefix !== "") return { unknown: true };
    const e = segs[0].exp;
    const name = e.type === "SimpleExpansion" ? e.text.replace(/^\$\{?|\}$/g, "") : e.type === "ParameterExpansion" && !e.operation && !e.prefix && !e.index ? e.parameter : null;
    if (!name || (restLit !== null && restLit !== "" && !restLit.startsWith("/"))) return { unknown: true };
    if (name === "HOME") return { outside: true };
    const tail = restLit === null ? null : restLit.replace(/^\/+/, "");
    if (name === "PWD") return tail === null ? { unknown: true } : { path: tail || ".", rel: true };
    const known = vars.get(name);
    if (known) {
      if (known.outside) return { outside: true };
      if (known.path !== undefined && tail !== null) return { path: tail ? `${known.path}/${tail}` : known.path, rel: false };
      return { unknown: true };
    }
    const value = env?.[name];
    if (typeof value === "string" && value.startsWith("/")) {
      const r = inRoot(posix.normalize(value));
      if (r === null) return mayLeadIn(`${posix.normalize(value)}/`) && tail === null ? { unknown: true } : { outside: true };
      if (tail !== null) return { path: tail ? `${r ? `${r}/` : ""}${tail}` : r || ".", rel: false };
    }
    return { unknown: true };
  };

  /** Each repository path `value` names from the working directories `cwds` (root-relative when !rel); null: none can be followed. */
  const join = (value, rel, cwds) => {
    if (!rel) {
      const p = posix.normalize(value || ".").replace(/\/+$/, "");
      return p === ".." || p.startsWith("../") ? [] : [p === "." ? "" : p];
    }
    if (!cwds) return null;
    const got = [];
    for (const c of cwds) {
      const p = posix.normalize(c ? `${c}/${value}` : value).replace(/\/+$/, "");
      if (p !== ".." && !p.startsWith("../")) got.push(p === "." ? "" : p);
    }
    return got;
  };
  /** Records a word that names a file, into `into` (`paths`, `maybe` or `guarded`); the whole repository is unresolved. */
  const add = (into, value, rel, cwds, spec, what) => {
    const ps = join(value, rel, cwds);
    if (ps === null) return;
    for (const p of ps) {
      if (p === "") unknown(what ?? value, "names the whole repository", spec);
      else out[into].add(p);
    }
  };
  const addWord = (w, cwds, spec, into = null) => {
    const r = resolve(w);
    if (r.outside || r.spec) return;
    if (r.unknown) return unknown(w.text, "not a fixed path", spec);
    add(into ?? (pathLooking(r.path) || !r.rel || w.text.includes("/") ? "paths" : "maybe"), r.path, r.rel, cwds, spec, w.text);
  };
  const scan = (text, cwds) => {
    for (const p of wordScan(text)) add("paths", p, true, cwds, true);
  };
  const addScript = (pkgs, name) => {
    for (const n of new Set([name, ...(SCRIPT_ALIASES[name] ?? [])])) for (const x of [n, `pre${n}`, `post${n}`]) for (const pkg of pkgs) out.scripts.add(`${pkg}\0${x}`);
  };
  /** The package.json files a package manager running in `dirs` may read: each one's and every directory's above. */
  const packages = (dirs) => {
    const got = new Set();
    for (const d of dirs) {
      const parts = d ? d.split("/") : [];
      for (let k = parts.length; k >= 0; k -= 1) got.add(parts.slice(0, k).join("/"));
    }
    return [...got];
  };

  /** A string a program runs as shell code; `spec` (only maybe code) adds paths only, and scans it where it does not parse. */
  const code = (text, cwds, mode) => {
    if (mode.depth >= MAX_DEPTH) return unknown(`shell code nested past ${MAX_DEPTH} levels`, "", mode.spec);
    const ast = parse(text);
    if (mode.spec && ast.errors?.length) return scan(text, cwds);
    run(ast, cwds, { ...mode, depth: mode.depth + 1, errexit: false });
  };

  /** Walks the expansions of a node's words (or of each node in a list): the commands a substitution runs, wherever it stands. */
  const subs = (node, cwds, mode) => {
    const look = (n) => {
      if (n.type === "Script") return run(n, cwds ? new Set(cwds) : null, { ...mode, errexit: false });
      // A substitution inside a parameter expansion's pattern is read from its text (the parser splits it at a `/`).
      if (n.type === "ParameterExpansion" && n.operation && /\$\(|`/.test(n.text)) {
        for (const m of n.text.matchAll(/\$\(|`/g)) code(n.text.slice(m.index + m[0].length), cwds, { ...mode, spec: true });
        scan(n.text, cwds);
      }
      forEachChild(n, look);
    };
    if (Array.isArray(node)) node.filter(Boolean).forEach(look);
    else forEachChild(node, look);
  };

  /** An assignment (`NAME=value`, `export NAME=value`, `env NAME=value`): PATH entries, files a shell reads, tracked values. */
  const assign = (name, w, cwds, mode) => {
    if (!w) return;
    const segs = segments(w);
    if (name === "PATH") {
      // Entries split at fixed `:`; each one in the repository is a directory the commands after it are found in.
      const entries = [[]];
      for (const s of segs) {
        if ("lit" in s) {
          const pieces = s.lit.split(":");
          entries.at(-1).push({ lit: pieces[0] });
          for (const piece of pieces.slice(1)) entries.push([{ lit: piece }]);
        } else entries.at(-1).push(s);
      }
      for (const e of entries.map((x) => x.filter((s) => !("lit" in s) || s.lit !== ""))) {
        if (!e.length) continue;
        if (e.length === 1 && "exp" in e[0] && /^\$\{?PATH\}?$/.test(e[0].exp.text)) continue;
        const r = resolve({ text: e.map((s) => ("lit" in s ? s.lit : s.exp.text)).join(""), parts: e.map((s) => ("lit" in s ? { type: "Literal", value: s.lit } : s.exp)) }, e);
        if (r.outside) continue;
        if (r.unknown || r.spec) {
          unknown(`PATH entry ${e.map((s) => ("lit" in s ? s.lit : s.exp.text)).join("")}`, "not a fixed directory", mode.spec);
          continue;
        }
        const ps = join(r.path, r.rel, cwds);
        for (const p of ps ?? []) {
          if (p === "") unknown("PATH entry", "the whole repository", mode.spec);
          else {
            out.guarded.add(p);
            pathDirs.add(p);
          }
        }
      }
      return;
    }
    if (FILE_VARS.has(name)) addWord(w, cwds, mode.spec, "paths");
    for (const s of segs) if ("lit" in s) scan(s.lit, cwds);
    const r = resolve(w, segs);
    vars.set(name, r.outside ? { outside: true } : r.path !== undefined && !r.unknown ? { path: (join(r.path, r.rel, cwds) ?? [])[0] } : {});
  };

  /** cd/pushd: the directories the command after it may run in, {ok, ko}: ok when it succeeded, ko when it failed. */
  const cd = (node, cwds, mode) => {
    const args = node.args.filter((a) => a.type === "Word");
    let k = 0;
    while (k < args.length && literal(args[k]) && /^-[A-Za-z@]+$/.test(args[k].value)) k += 1;
    if (k < args.length && literal(args[k]) && args[k].value === "--") k += 1;
    const arg = args[k];
    const lost = (what) => {
      unknown(what, "a directory Factory cannot follow", mode.spec);
      return { ok: null, ko: cwds };
    };
    if (mode.spec) return { ok: cwds, ko: cwds };
    if (!arg) return lost(node.name.text);
    // `cd -` goes back where it was: a directory the command reached before.
    if (literal(arg) && arg.value === "-") return { ok: new Set(allDirs), ko: cwds };
    const r = resolve(arg);
    if (r.unknown || r.spec || r.outside) return lost(`${node.name.text} ${arg.text}`);
    if (!cwds && r.rel) return { ok: null, ko: cwds };
    const next = new Set();
    for (const c of r.rel ? cwds : [""]) {
      const p = posix.normalize(c ? `${c}/${r.path}` : r.path).replace(/\/+$/, "");
      if (p === ".." || p.startsWith("../")) return lost(`${node.name.text} ${arg.text}`);
      next.add(p === "." ? "" : p);
    }
    for (const p of next) allDirs.add(p);
    if (allDirs.size > MAX_DIRS) return lost(`${node.name.text} ${arg.text}`);
    return { ok: next, ko: cwds };
  };

  /** One simple command: what it names, runs and changes. Returns {ok, ko}. */
  const simple = (node, cwds, mode, piped) => {
    const same = { ok: cwds, ko: cwds };
    for (const a of node.prefix) if (a.type === "Assignment" && a.value?.type === "Word") assign(a.name, a.value, cwds, mode);
    subs(node, cwds, mode);
    const redirects = node.redirects;
    for (const r of redirects) {
      if (r.type === "Redirect" && (r.operator === "<" || r.operator === "<>") && r.target) addWord(r.target, cwds, mode.spec, "paths");
    }
    const name = node.name;
    if (!name) return same;
    const words = [name, ...node.args.filter((a) => a.type === "Word")];
    const nv = literal(name) ? name.value : null;
    if (nv === "cd" || nv === "pushd") return cd(node, cwds, mode);
    if (nv === "popd") return { ok: new Set(allDirs), ko: cwds };

    // The command word: a path in the repository, one found on a PATH entry in it, or a program elsewhere.
    if (nv === null) {
      const r = resolve(name);
      if (r.unknown) unknown(name.text, "not a fixed command", mode.spec);
      else if (r.path !== undefined) add("paths", r.path, r.rel, cwds, mode.spec, name.text);
    } else if (nv.includes("/")) addWord(name, cwds, mode.spec, "paths");
    else for (const d of pathDirs) out.guarded.add(`${d}/${nv}`);

    // `export NAME=value` and the like: after the command word, so a PATH it sets finds the commands after it.
    for (const a of node.args) if (a.type === "Assignment" && a.value?.type === "Word") assign(a.name, a.value, cwds, mode);
    if (nv === "eval" || nv === "trap") {
      const args = nv === "trap" ? words.slice(1, 2) : words.slice(1);
      if (args.every(literal)) code(args.map((w) => w.value).join(" "), cwds, mode);
      else unknown(node.args.map((a) => a.text).join(" "), "shell code Factory cannot read", mode.spec);
      return same;
    }
    if (nv !== null && DATA_BUILTINS.has(nv)) return same;

    // Find the command each wrapper runs (`sudo -u x env K=v timeout 5 bash -c '…'`), reading the words they hold.
    const role = new Map(); // word -> "code" | "skip" | "named" | "guard"
    let i = 0;
    let xargs = false;
    const at = (k) => (k < words.length ? words[k] : null);
    const lv = (k) => (at(k) && literal(at(k)) ? at(k).value : null);
    for (;;) {
      const b = lv(i) === null ? null : base(lv(i));
      if (b === "env") {
        for (i += 1; at(i); i += 1) {
          const v = lv(i);
          const named = assignment(at(i));
          if (named) {
            role.set(at(i), "skip");
            assign(named.name, named.value, cwds, mode);
            continue;
          }
          if (v === null) break;
          if (v === "--") continue;
          if (v === "-u" || v === "--unset") {
            role.set(at(i + 1), "skip");
            i += 1;
          } else if (v === "-C" || v === "--chdir" || v.startsWith("--chdir=")) {
            const dir = v.startsWith("--chdir=") ? v.slice(8) : lv(i + 1);
            if (!v.startsWith("--chdir=")) role.set(at((i += 1)), "skip");
            if (dir === null || dir.startsWith("/")) unknown(`env ${v}`, "a directory Factory cannot follow", mode.spec);
            else if (cwds) cwds = new Set([...cwds, ...(join(dir, true, cwds) ?? [])]);
          } else if (v === "-S" || v === "--split-string" || v.startsWith("--split-string=")) {
            const str = v.startsWith("--split-string=") ? v.slice(15) : lv(i + 1);
            if (!v.startsWith("--split-string=")) role.set(at((i += 1)), "code");
            if (str === null) unknown(`env ${v}`, "a command Factory cannot read", mode.spec);
            else code(str, cwds, mode);
          } else if (!v.startsWith("-")) break;
        }
        continue;
      }
      if (b !== null && Object.hasOwn(WRAPPERS, b)) {
        if (b === "xargs") xargs = true;
        const valued = WRAPPERS[b];
        if (b === "sudo") {
          // sudo -s/-i: the words after its options are one shell command.
          let k = i + 1;
          let shell = false;
          for (; lv(k) !== null && lv(k).startsWith("-"); k += 1) {
            if (SUDO_SHELL.test(lv(k))) shell = true;
            if (valued.has(lv(k))) k += 1;
          }
          if (shell && at(k)) {
            const rest = words.slice(k);
            for (const w of rest) role.set(w, "code");
            if (rest.every(literal)) code(rest.map((w) => w.value).join(" "), cwds, mode);
            else unknown(rest.map((w) => w.text).join(" "), "shell code Factory cannot read", mode.spec);
            break;
          }
          i = k;
          continue;
        }
        i += 1;
        for (; lv(i) !== null && lv(i).startsWith("-") && lv(i) !== "-"; i += 1) if (valued.has(lv(i))) i += 1;
        i += POSITIONAL[b] ?? 0;
        continue;
      }
      break;
    }
    const cmdAt = i;
    const cmd = lv(cmdAt);
    const cb = cmd === null ? null : base(cmd);
    if (cmdAt > 0 && at(cmdAt)) {
      // The wrapped command is a command word too.
      if (cmd === null) {
        const r = resolve(at(cmdAt));
        if (r.unknown) unknown(at(cmdAt).text, "not a fixed command", mode.spec);
        else if (r.path !== undefined) add("paths", r.path, r.rel, cwds, mode.spec, at(cmdAt).text);
      } else if (cmd.includes("/")) addWord(at(cmdAt), cwds, mode.spec, "paths");
      else for (const d of pathDirs) out.guarded.add(`${d}/${cmd}`);
      role.set(at(cmdAt), "named");
    }
    const stdin = piped || xargs;

    if (cb !== null && SHELLS.has(cb)) {
      let k = cmdAt + 1;
      let codeMode = false;
      for (; lv(k) !== null && /^[-+]./.test(lv(k)) && lv(k) !== "--"; k += 1) {
        if (SHELL_CODE.test(lv(k))) codeMode = true;
        if (SHELL_VALUED.has(lv(k))) k += 1;
      }
      if (lv(k) === "--") k += 1;
      const operand = at(k);
      if (codeMode) {
        if (!operand) unknown(words.map((w) => w.text).join(" "), "a shell given -c and no code", mode.spec);
        else if (literal(operand)) {
          role.set(operand, "code");
          code(operand.value, cwds, mode);
        } else {
          role.set(operand, "code");
          unknown(operand.text, /curl|wget/.test(operand.text) ? "remote code, which nothing in the repository can protect" : "shell code Factory cannot read", mode.spec);
        }
      } else if (operand) {
        role.set(operand, "named");
        if (!literal(operand) && operand.parts?.some((p) => p.type === "ProcessSubstitution")) unknown(operand.text, /curl|wget/.test(operand.text) ? "remote code, which nothing in the repository can protect" : "a script Factory cannot read", mode.spec);
        else addWord(operand, cwds, mode.spec, "paths");
      } else if (stdin) unknown(words.map((w) => w.text).join(" "), "a shell reading its script from a pipe runs code Factory cannot see", mode.spec);
      for (const r of redirects) {
        if (r.type === "HereDoc") {
          if (!operand && !codeMode && (r.body.parts ?? []).every(literalPart)) code(r.body.text, cwds, mode);
          else if (!operand && !codeMode) unknown(`a here-document fed to ${cmd}`, "shell code Factory cannot read", mode.spec);
        } else if (r.type === "HereString" && r.target && !operand && !codeMode) {
          if (literal(r.target)) code(r.target.value, cwds, mode);
          else unknown(r.target.text, "shell code Factory cannot read", mode.spec);
        }
      }
    } else if (cb !== null && SU.has(cb)) {
      for (let k = cmdAt + 1; at(k); k += 1) {
        if (lv(k) !== null && SHELL_CODE.test(lv(k)) && at(k + 1)) {
          role.set(at(k + 1), "code");
          if (literal(at(k + 1))) code(at(k + 1).value, cwds, mode);
          else unknown(at(k + 1).text, "shell code Factory cannot read", mode.spec);
        }
      }
    } else if (cb !== null && interpreterOf(cb)) {
      const spec = interpreterOf(cb);
      let k = cmdAt + 1;
      if (cb.startsWith("node") && lv(k) === "--run") {
        // `node --run X`: package.json's scripts.X, from the working directory's package.json or the nearest above.
        role.set(at(k + 1), "skip");
        if (at(k + 1) && literal(at(k + 1))) addScript(packages(cwds ?? []).map((d) => (d ? `${d}/package.json` : "package.json")), lv(k + 1));
        else unknown(words.map((w) => w.text).join(" "), "a script Factory cannot name", mode.spec);
        k = words.length;
      }
      let operand = null;
      let inline = false;
      for (; at(k); k += 1) {
        const v = lv(k);
        if (v === null) break;
        if (v === "--") {
          k += 1;
          break;
        }
        if (v === "-") {
          inline = "stdin";
          break;
        }
        if (!v.startsWith("-")) break;
        if (spec.code.test(v) && at(k + 1)) {
          inline = true;
          role.set(at(k + 1), "code");
          if (literal(at(k + 1))) scan(at(k + 1).value, cwds);
          k += 1;
          break;
        }
        if (spec.module && /^-[A-Za-z]*m/.test(v)) {
          inline = true;
          const m = v.replace(/^-[A-Za-z]*m/, "") || lv(k + 1);
          if (!v.replace(/^-[A-Za-z]*m/, "")) role.set(at(k + 1), "skip");
          if (m === null) unknown(words.map((w) => w.text).join(" "), "a module Factory cannot name", mode.spec);
          else module(m, cwds, mode);
          if (m === "pip" || m === "pip3") pip(words, v.replace(/^-[A-Za-z]*m/, "") ? k + 1 : k + 2, cwds, mode, role);
          break;
        }
        if (spec.valued.has(v)) {
          if (at(k + 1) && literal(at(k + 1)) && cb.startsWith("node")) add("paths", lv(k + 1), true, cwds, mode.spec);
          k += 1;
        }
      }
      if (!inline && k < words.length && at(k)) operand = at(k);
      if (operand) {
        role.set(operand, "named");
        addWord(operand, cwds, mode.spec, "paths");
        // node resolves an extensionless script as a file with each extension, or a directory.
        if (cb.startsWith("node") && literal(operand) && !/\.[A-Za-z0-9]+$/.test(operand.value)) for (const ext of [".js", ".mjs", ".cjs", ".json", ".node"]) add("guarded", `${operand.value}${ext}`, true, cwds, mode.spec);
      } else if ((inline === "stdin" || (!inline && k <= words.length && !(cb.startsWith("node") && lv(cmdAt + 1) === "--run"))) && stdin) unknown(words.map((w) => w.text).join(" "), "an interpreter reading its script from a pipe runs code Factory cannot see", mode.spec);
      if (inline === "stdin" || (!inline && !operand)) for (const r of redirects) if (r.type === "HereDoc") scan(r.body.text, cwds);
    } else if (cb !== null && (PACKAGE_MANAGERS.has(cb) || cb === "corepack" || cb === "turbo" || RUN_ALL.has(cb) || cb === "uv" || cb === "pip" || cb === "pip3")) {
      if (cb === "pip" || cb === "pip3") pip(words, cmdAt + 1, cwds, mode, role);
      else if (cb === "uv") {
        if (lv(cmdAt + 1) === "pip") pip(words, cmdAt + 2, cwds, mode, role);
        if (lv(cmdAt + 1) === "run") {
          for (let k = cmdAt + 2; at(k); k += 1) {
            if (lv(k) !== null && /^-[A-Za-z]*m/.test(lv(k))) {
              const m = lv(k).replace(/^-[A-Za-z]*m/, "") || lv(k + 1);
              if (m) module(m, cwds, mode);
              break;
            }
          }
        }
      } else packageManager(words, cmdAt, cwds, mode, role);
    }

    // Every other argument: a path when it names one, unresolved when it may and cannot be read.
    for (let k = 1; k < words.length; k += 1) {
      const w = words[k];
      const r0 = role.get(w);
      if (r0 === "code" || r0 === "skip" || r0 === "named") continue;
      if (!literal(w)) {
        const segs = segments(w);
        const lead = "lit" in (segs[0] ?? {}) ? segs[0].lit : "";
        if (lead.startsWith("-")) {
          // An option's computed value: a count from a substitution (`-j$(nproc)`) names no file; a long one's value is a path.
          if (/^-[A-Za-z]$/.test(lead) && segs.slice(1).every((s) => "exp" in s && (s.exp.type === "CommandExpansion" || s.exp.type === "ArithmeticExpansion"))) continue;
          if (lead.includes("=")) {
            const value = { type: "Word", text: w.text.slice(w.text.indexOf("=") + 1), parts: [{ type: "Literal", value: lead.slice(lead.indexOf("=") + 1) }, ...segs.slice(1).map((s) => ("lit" in s ? { type: "Literal", value: s.lit } : s.exp))].filter((p) => p.type !== "Literal" || p.value !== "") };
            if (!value.parts.length) continue;
            const r = resolve(value);
            if (r.unknown) unknown(w.text, "not a fixed path", mode.spec);
            else if (r.path !== undefined) add("paths", r.path, r.rel, cwds, mode.spec, w.text);
            continue;
          }
          unknown(w.text, "not a fixed path", mode.spec);
          continue;
        }
        if (NAME_VALUE.test(lead)) {
          for (const s of segs) if ("lit" in s) scan(s.lit, cwds);
          continue;
        }
        if (segs.some((s) => "exp" in s && s.exp.type === "ProcessSubstitution") && /curl|wget/.test(w.text)) unknown(w.text, "remote code, which nothing in the repository can protect", mode.spec);
        else addWord(w, cwds, mode.spec);
        continue;
      }
      const v = w.value;
      if (tilde(w) && !v.startsWith("~+")) continue;
      if (v.startsWith("-")) {
        if (v.includes("=")) add("paths", v.slice(v.indexOf("=") + 1), true, cwds, mode.spec);
        continue;
      }
      if (NAME_VALUE.test(v)) {
        const value = v.slice(v.indexOf("=") + 1);
        if (value && !URL_SCHEME.test(value) && !value.startsWith("/")) add(pathLooking(value) ? "paths" : "maybe", value, true, cwds, true);
        continue;
      }
      if (SPEC.test(v) && !v.includes("/")) continue;
      addWord(w, cwds, mode.spec, r0 === "guard" ? "guarded" : null);
      if (MAYBE_CODE.test(v)) code(v, cwds, { ...mode, spec: true });
    }
    // A here-document fed to anything else: its fixed text is read for paths.
    if (!(cb !== null && (SHELLS.has(cb) || interpreterOf(cb)))) for (const r of redirects) if (r.type === "HereDoc") scan(r.body.text, cwds);
    return same;
  };

  /** `python -m module`: the files it may run from the working directory. */
  const module = (m, cwds) => {
    const parts = m.split(".");
    if (parts.some((s) => !s)) return;
    const dir = parts.join("/");
    add("guarded", `${dir}.py`, true, cwds, true);
    add("guarded", `${dir}/__main__.py`, true, cwds, true);
    for (let k = 1; k <= parts.length; k += 1) add("guarded", `${parts.slice(0, k).join("/")}/__init__.py`, true, cwds, true);
  };

  /** `pip install …` from word `from`: a directory it builds is its build files; a requirements file a path; a spec none. */
  const pip = (words, from, cwds, mode, role) => {
    const install = words.slice(from).some((w) => literal(w) && w.value === "install");
    if (!install) return;
    for (let k = from; k < words.length; k += 1) {
      const w = words[k];
      if (!literal(w)) continue;
      const v = w.value;
      if (v === "-r" || v === "-c" || v === "--requirement" || v === "--constraint") {
        k += 1;
        continue;
      }
      const dir = v === "-e" || v === "--editable" ? words[k + 1] : v.startsWith("-") ? null : w;
      if (v === "-e" || v === "--editable") k += 1;
      if (!dir || !literal(dir)) continue;
      const d = dir.value.replace(/\[[^\]]*\]$/, "");
      if (d !== "." && !d.startsWith("./") && !d.startsWith("../") && !d.includes("/")) continue;
      if (/\.(whl|zip|tar\.gz|tgz)$/.test(d)) continue;
      role.set(dir, "skip");
      for (const f of BACKEND) add("guarded", d === "." ? f : `${d}/${f}`, true, cwds, mode.spec);
    }
  };

  /** A package manager, turbo or npm-run-all at word `at`: the package.json scripts it runs, and its own files. */
  const packageManager = (words, at, cwds, mode, role) => {
    let k = at;
    let pm = base(words[k].value);
    if (pm === "corepack") {
      k += 1;
      const next = words[k] && literal(words[k]) ? base(words[k].value) : null;
      if (!next || !PACKAGE_MANAGERS.has(next)) return;
      role.set(words[k], "skip");
      pm = next;
    }
    let dirs = cwds ?? [];
    let anyPackage = pm === "turbo";
    const names = [];
    let first = true;
    for (k += 1; k < words.length; k += 1) {
      const w = words[k];
      if (!literal(w)) {
        role.set(w, "skip");
        const r = resolve(w);
        if (!r.spec && !r.outside) unknown(w.text, "a script or option Factory cannot read", mode.spec);
        continue;
      }
      const v = w.value;
      role.set(w, "skip");
      if (v === "--") break;
      if (v.startsWith("-")) {
        const opt = v.split("=")[0];
        if (PM_DIR.has(opt)) {
          const value = v.includes("=") ? v.slice(v.indexOf("=") + 1) : words[k + 1] && literal(words[k + 1]) ? words[k + 1].value : null;
          if (!v.includes("=")) {
            if (words[k + 1]) role.set(words[k + 1], "skip");
            k += 1;
          }
          if (value === null) unknown(v, "a package directory Factory cannot follow", mode.spec);
          else dirs = join(value, true, dirs) ?? [];
        } else if (PM_WORKSPACE.test(v)) anyPackage = true;
        if (PM_VALUED.has(opt) && !v.includes("=")) {
          if (words[k + 1]) role.set(words[k + 1], "skip");
          k += 1;
        }
        continue;
      }
      if ((pm === "yarn" && (v === "workspace" || v === "workspaces")) || (pm === "pnpm" && v === "-r")) anyPackage = true;
      if (RUN_ALL.has(pm) && /[*?{]/.test(v)) unknown(v, "scripts Factory cannot name", mode.spec);
      if (!RUN_WORDS.has(v) || !first) names.push(v);
      first = false;
    }
    const pkgs = anyPackage ? ["*"] : packages(dirs).map((d) => (d ? `${d}/package.json` : "package.json"));
    for (const n of names) addScript(pkgs, n);
    for (const d of packages(dirs)) for (const f of PM_FILES[pm] ?? []) out.guarded.add(d ? `${d}/${f}` : f);
    if (pm === "turbo") out.guarded.add("turbo.json");
  };

  /** Whether `node` holds a `cd`, `pushd` or `popd` anywhere: one inside a loop or a function moves the commands around it. */
  const movesDir = (node) => {
    let found = false;
    const look = (n) => {
      if (found) return;
      if (n.type === "Command" && n.name && literal(n.name) && ["cd", "pushd", "popd"].includes(n.name.value)) found = true;
      else forEachChild(n, look);
    };
    look(node);
    return found;
  };
  const union = (a, b) => (a && b ? new Set([...a, ...b]) : null);

  /** Runs a node from the directories `cwds` (null: unknown), returning where the next command may be: {ok, ko}. */
  function run(node, cwds, mode, piped = false) {
    switch (node.type) {
      case "Script":
      case "CompoundList": {
        if (node.type === "Script" && node.errors?.length) unknown(`the command does not parse as bash (${node.errors[0].message})`, "", mode.spec);
        let cur = cwds;
        for (const st of node.commands) {
          if (st.background) {
            run(st.command, cur ? new Set(cur) : null, mode);
            continue;
          }
          const r = run(st.command, cur, mode);
          cur = mode.errexit && st.command.type !== "AndOr" ? r.ok : union(r.ok, r.ko);
        }
        return { ok: cur, ko: union(cur, cwds) };
      }
      case "Statement":
        return run(node.command, cwds, mode);
      case "AndOr": {
        let r = run(node.commands[0], cwds, mode);
        node.operators.forEach((op, k) => {
          const next = node.commands[k + 1];
          if (op === "&&") {
            const e = run(next, r.ok, mode);
            r = { ok: e.ok, ko: union(r.ko, e.ko) };
          } else {
            const e = run(next, r.ko, mode);
            r = { ok: union(r.ok, e.ok), ko: e.ko };
          }
        });
        return r;
      }
      case "Pipeline": {
        if (node.commands.length === 1) {
          const r = run(node.commands[0], cwds, mode);
          return { ok: union(r.ok, r.ko), ko: union(r.ok, r.ko) };
        }
        node.commands.forEach((c, k) => run(c, cwds ? new Set(cwds) : null, mode, k > 0));
        return { ok: cwds, ko: cwds };
      }
      case "Command":
        return simple(node, cwds, mode, piped);
      case "Redirected": {
        for (const r of node.redirects) if (r.type === "Redirect" && (r.operator === "<" || r.operator === "<>") && r.target) addWord(r.target, cwds, mode.spec, "paths");
        subs(node.redirects, cwds, mode);
        return run(node.command, cwds, mode, piped);
      }
      case "Subshell":
        run(node.body, cwds ? new Set(cwds) : null, mode);
        return { ok: cwds, ko: cwds };
      case "BraceGroup":
        return run(node.body, cwds, mode);
      case "If": {
        const c = run(node.clause, cwds, { ...mode, errexit: false });
        let ok = run(node.then, c.ok, mode).ok;
        let ko = c.ko;
        for (const e of node.elif) {
          const ec = run(e.clause, ko, { ...mode, errexit: false });
          ok = union(ok, run(e.then, ec.ok, mode).ok);
          ko = ec.ko;
        }
        if (node.else) ko = run(node.else, ko, mode).ok;
        return { ok: union(ok, ko), ko: union(ok, ko) };
      }
      case "For":
      case "ArithmeticFor":
      case "Select":
      case "While": {
        const moves = movesDir(node);
        if (moves) unknown(`a ${node.type === "While" ? "loop" : "loop"} that changes directory`, "", mode.spec);
        subs(node.wordlist ?? [], cwds, mode);
        if (node.clause) run(node.clause, cwds, { ...mode, errexit: false });
        run(node.body, moves ? null : cwds, mode);
        return { ok: moves ? null : cwds, ko: moves ? null : cwds };
      }
      case "Case": {
        subs([node.word], cwds, mode);
        let ok = cwds;
        for (const item of node.items) ok = union(ok, run(item.body, cwds, mode).ok);
        return { ok, ko: ok };
      }
      case "Function": {
        const moves = movesDir(node.body);
        if (moves) unknown(`function ${node.name.text}, which changes directory`, "", mode.spec);
        deferred.push({ node: node.body, mode });
        return { ok: moves ? null : cwds, ko: moves ? null : cwds };
      }
      case "Coproc":
        run(node.body, cwds ? new Set(cwds) : null, mode);
        return { ok: cwds, ko: cwds };
      default:
        subs(node, cwds, mode);
        return { ok: cwds, ko: cwds };
    }
  }

  const text = String(command || "");
  const start = new Set([cwd]);
  const end = run(parse(text), start, { spec: false, depth: 0, errexit });
  // A function's body runs where it is called: in any directory the command reached.
  const reached = end.ok && end.ko ? new Set([...allDirs]) : null;
  while (deferred.length) {
    const { node, mode } = deferred.shift();
    run(node, reached, mode);
  }
  // Every path-looking word of the text, as Factory read a command before it parsed one: never fewer files than that.
  for (const p of wordScan(text)) add("paths", p, true, start, true);
  const scripts = [...out.scripts].map((s) => ({ pkg: s.split("\0")[0], name: s.split("\0")[1] }));
  for (const p of out.paths) out.maybe.delete(p);
  return { paths: [...out.paths], maybe: [...out.maybe], guarded: [...out.guarded], scripts, unresolved: [...out.unresolved] };
}
