// Shell commands (the `setup` and `install` settings), read with the `unbash` library (vendored: plugin/vendor/unbash,
// pinned in tools/deps), which parses GNU Bash's own grammar. The library parses; what a command refers to in the
// repository is Factory's own reading of that tree, so every rule sits in one place (commandRefs).
import { posix } from "node:path";
import { forEachChild, parse } from "../../vendor/unbash/dist/parser.js";

// Builtins that run nothing and read no file: their words are data, so a variable among them resolves nothing.
const DATA_BUILTINS = new Set(["echo", "printf", "export", "readonly", "declare", "typeset", "local", "set", "unset", "shift", "true", "false", ":", "test", "[", "exit", "return", "wait", "umask", "ulimit", "type", "hash", "read", "popd"]);
// Programs that run a later word as shell code after a `-c` option (`bash -c '…'`, `su -c '…' user`), and sudo, which
// does after `-s` or `-i`.
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh", "su", "runuser"]);
const SHELL_CODE = /^-[A-Za-z]*c[A-Za-z]*$/;
const SUDO_SHELL = /^-[A-Za-z]*[si][A-Za-z]*$/;
// `python -m module` runs the module from the working directory first.
const PYTHON = /^python(\d+(\.\d+)*)?$/;
const PYTHON_MODULE = /^-[A-Za-z]*m$/;
// The package managers whose `run X` (or `X`) runs package.json's `scripts.X`, with its `preX` and `postX`. The
// words naming the run itself are no script; npm's `t` and `tst` are `test`.
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUN_WORDS = new Set(["run", "run-script", "rum", "urn"]);
const SCRIPT_ALIASES = { t: "test", tst: "test" };
// A literal argument holding one of these may be shell code another program runs (`flock /l -c './x.sh'`): it is read
// as a command too, for the paths it names alone.
const MAYBE_CODE = /[\s;&|<>()`$]/;
const MAX_DEPTH = 8;
const MAX_DIRS = 64;
// A URL (`https://…`) is no path.
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

const literalPart = (p) => p.type === "Literal" || p.type === "SingleQuoted" || p.type === "AnsiCQuoted" || (p.type === "DoubleQuoted" && p.parts.every((c) => c.type === "Literal"));
/** Whether a word is one fixed string: no expansion, substitution, glob or brace. */
const literal = (w) => !w.parts || w.parts.every(literalPart);
/** An unquoted leading `~`: the home directory, outside the repository. */
const home = (w) => w.text.startsWith("~");
const clip = (s) => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

/**
 * What a shell command refers to in the repository, read from its bash syntax tree: {paths, scripts, unresolved}.
 * `paths`: each repository path, from its root, a literal word names: the command run (`./x.sh`), each argument
 * (`bash scripts/setup.sh`, `--dir=vendor/x`), an input redirection (`< file`), the files `python -m module` may run,
 * and the same inside code the command runs (`bash -c '…'`, `eval`, `$(…)`), each against every directory a literal
 * `cd` may have left (`cd web && ./x.sh` is `web/x.sh`). An absolute path, `~` and a path out of the root are none.
 * Every argument counts, not only the ones that look like a path: a word naming no file is matched against nothing.
 * `scripts`: the package.json `scripts` entries a package manager runs (`npm run build`: `build`, `prebuild`,
 * `postbuild`), in any package.json, since its options may pick another. `unresolved`: each word or construct that
 * may name a file and is not one fixed string (a variable, a substitution's output, a glob, a brace expansion, a
 * here-document fed to a shell), a `cd` Factory cannot follow, and a command that does not parse: the command may run
 * any file, and every caller treats it so. What a named file or program reads in turn (a Makefile, a script's own
 * `source`, an install's lifecycle scripts) is no reference here.
 */
export function commandRefs(command) {
  const paths = new Set();
  const scripts = new Set();
  const unresolved = new Set();
  let cwds = new Set([""]);
  const deferred = [];

  const unknown = (what, spec) => {
    if (!spec) unresolved.add(clip(what));
  };
  const lost = (what, spec) => {
    if (spec) return;
    unknown(what, spec);
    cwds = null;
  };
  const addPath = (value) => {
    if (!value || value.startsWith("/") || value.startsWith("~") || URL_SCHEME.test(value) || !cwds) return;
    for (const c of cwds) {
      const p = posix.normalize(c ? `${c}/${value}` : value).replace(/\/+$/, "");
      if (p && p !== "." && p !== ".." && !p.startsWith("../")) paths.add(p);
    }
  };
  const addModule = (module) => {
    const parts = module.split(".");
    if (parts.some((s) => !s)) return;
    const dir = parts.join("/");
    addPath(`${dir}.py`);
    addPath(`${dir}/__main__.py`);
    for (let i = 1; i <= parts.length; i += 1) addPath(`${parts.slice(0, i).join("/")}/__init__.py`);
  };
  const addScript = (name) => {
    const s = SCRIPT_ALIASES[name] ?? name;
    for (const n of new Set([name, s])) for (const x of [n, `pre${n}`, `post${n}`]) scripts.add(x);
  };

  /** A string a program runs as shell code: `spec` (only maybe code) adds what it names, never an unresolved word. */
  const code = (text, spec, depth) => {
    if (depth > MAX_DEPTH) return unknown(`shell code nested past ${MAX_DEPTH} levels`, spec);
    walk(parse(text), spec, depth + 1);
  };

  const cd = (node, spec) => {
    if (spec) return;
    const arg = node.args.find((a) => a.type === "Word" && !(literal(a) && /^-[A-Za-z@]+$/.test(a.value)));
    if (!arg) return lost(node.name.text, spec);
    if (literal(arg) && arg.value === "-") return;
    if (arg.type !== "Word" || !literal(arg) || home(arg) || arg.value.startsWith("/")) return lost(`${node.name.text} ${arg.text}`, spec);
    if (!cwds) return;
    const next = new Set(cwds);
    for (const c of cwds) {
      const p = posix.normalize(c ? `${c}/${arg.value}` : arg.value).replace(/\/+$/, "");
      if (p === ".." || p.startsWith("../")) return lost(`${node.name.text} ${arg.text}`, spec);
      next.add(p === "." ? "" : p);
    }
    // Each cd may fail, so the directories double at most per cd; past a bound the command is not followed.
    if (next.size > MAX_DIRS) return lost(`${node.name.text} ${arg.text} (more than ${MAX_DIRS} directories it may be in)`, spec);
    cwds = next;
  };

  const simple = (node, spec, depth) => {
    const name = node.name;
    if (!name) return;
    const words = [name, ...node.args.filter((a) => a.type === "Word")];
    const nameValue = literal(name) ? name.value : null;
    if (nameValue === null) unknown(name.text, spec);
    else if (nameValue.includes("/") && !home(name)) addPath(nameValue);
    if (nameValue === "cd" || nameValue === "pushd") return cd(node, spec);
    if (nameValue === "eval" || nameValue === "trap") {
      const args = nameValue === "trap" ? words.slice(1, 2) : words.slice(1);
      if (args.every(literal)) code(args.map((w) => w.value).join(" "), spec, depth);
      else unknown(node.args.map((a) => a.text).join(" "), spec);
      return;
    }
    // The words that run code or files by name, wherever they stand (`sudo -u x sh -c '…'`, `corepack pnpm build`).
    // A word run as shell code is read as code, not as a file name (`bash -c configure` runs a command).
    const codeWords = new Set();
    let shell = false;
    for (let i = 0; i < words.length; i += 1) {
      if (!literal(words[i])) continue;
      const base = words[i].value.split("/").pop();
      const later = words.slice(i + 1);
      const after = (re) => {
        const j = later.findIndex((w) => literal(w) && re.test(w.value));
        return j < 0 ? null : later.slice(j + 1);
      };
      if (SHELLS.has(base) || base === "sudo") {
        if (base !== "sudo") shell = true;
        for (const w of after(base === "sudo" ? SUDO_SHELL : SHELL_CODE) ?? []) if (literal(w) && !w.value.startsWith("-")) codeWords.add(w);
      } else if (PYTHON.test(base)) {
        const rest = after(PYTHON_MODULE);
        if (rest?.[0] && literal(rest[0])) addModule(rest[0].value);
      } else if (PACKAGE_MANAGERS.has(base)) {
        for (const w of later) {
          if (!literal(w)) continue;
          if (w.value === "--") break;
          if (!w.value.startsWith("-") && !RUN_WORDS.has(w.value)) addScript(w.value);
        }
      }
    }
    for (const w of codeWords) code(w.value, spec, depth);
    if (nameValue === null || !DATA_BUILTINS.has(nameValue)) {
      for (const w of words.slice(1)) {
        if (!literal(w)) {
          unknown(w.text, spec);
          continue;
        }
        if (home(w) || codeWords.has(w)) continue;
        const v = w.value;
        if (v.startsWith("-")) {
          if (v.includes("=")) addPath(v.slice(v.indexOf("=") + 1));
          continue;
        }
        addPath(v);
        if (MAYBE_CODE.test(v)) code(v, true, depth);
      }
    }
    for (const r of node.redirects) {
      if (r.type === "Redirect" && (r.operator === "<" || r.operator === "<>") && r.target) {
        if (!literal(r.target)) unknown(r.target.text, spec);
        else if (!home(r.target)) addPath(r.target.value);
      } else if (shell && r.type === "HereDoc") {
        if ((r.body.parts ?? []).every(literalPart)) code(r.body.text, spec, depth);
        else unknown(`a here-document fed to ${name.text}`, spec);
      } else if (shell && r.type === "HereString" && r.target) {
        if (literal(r.target)) code(r.target.value, spec, depth);
        else unknown(r.target.text, spec);
      }
    }
  };

  /** Whether `node` holds a `cd` or `pushd` anywhere: one inside a loop or a function moves later and earlier commands alike. */
  const movesDir = (node) => {
    let found = false;
    const look = (n) => {
      if (found) return;
      if (n.type === "Command" && n.name && literal(n.name) && (n.name.value === "cd" || n.name.value === "pushd")) found = true;
      else forEachChild(n, look);
    };
    look(node);
    return found;
  };

  function walk(node, spec, depth) {
    switch (node.type) {
      case "Script":
        if (node.errors?.length) unknown(`the command does not parse as bash (${node.errors[0].message})`, spec);
        break;
      case "Command":
        simple(node, spec, depth);
        break;
      case "Redirected":
        // A compound command's own input (`while read f; do …; done < list.txt`).
        for (const r of node.redirects) {
          if (r.type !== "Redirect" || (r.operator !== "<" && r.operator !== "<>") || !r.target) continue;
          if (!literal(r.target)) unknown(r.target.text, spec);
          else if (!home(r.target)) addPath(r.target.value);
        }
        break;
      case "Function":
        // Its body runs where it is called, so in any directory the command reaches: read once the rest is.
        if (movesDir(node.body)) lost(`function ${node.name.text}, which changes directory`, spec);
        deferred.push({ node: node.body, spec, depth });
        return;
      case "For":
      case "ArithmeticFor":
      case "While":
      case "Select":
        if (movesDir(node)) lost(`a loop that changes directory`, spec);
        break;
    }
    forEachChild(node, (child) => walk(child, spec, depth));
  }

  walk(parse(String(command || "")), false, 0);
  while (deferred.length) {
    const { node, spec, depth } = deferred.shift();
    walk(node, spec, depth);
  }
  return { paths: [...paths], scripts: [...scripts], unresolved: [...unresolved] };
}
