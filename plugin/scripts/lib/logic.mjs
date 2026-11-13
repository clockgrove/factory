// Pure logic shared by the Factory scripts: no I/O, no GitHub, no harness.
// Everything here is covered by test/ with `node --test`.

import { parseToml } from "./toml.mjs";
import { parseYaml } from "./yaml.mjs";
import { refusalFields } from "./usage.mjs";
import { missingSecretsOf } from "./worker-secrets.mjs";

// ---------------------------------------------------------------- validation commands

/** An adopter marks a validation command `parallel:` when it may run at the same time as the marked ones beside it. */
const PARALLEL = /^parallel:\s*/;

/** A validation command as it runs, without its `parallel:` mark. */
export const commandText = (command) => String(command).replace(PARALLEL, "");

/** The commands in run order as groups: each run of consecutive `parallel:` commands is one group, every other command its own. */
export function validationGroups(commands) {
  const groups = [];
  for (const command of commands || []) {
    const parallel = PARALLEL.test(command);
    if (parallel && groups.at(-1)?.parallel) groups.at(-1).commands.push(commandText(command));
    else groups.push({ parallel, commands: [commandText(command)] });
  }
  return groups.map((g) => g.commands);
}

// ---------------------------------------------------------------- task card

/** Render a `{{key}}` template. Every placeholder must be supplied; none may be left. */
export function renderTaskCard(template, values) {
  const missing = new Set();
  const out = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) {
      missing.add(key);
      return "";
    }
    return String(values[key]);
  });
  if (missing.size) throw new Error(`task card: missing values for ${[...missing].join(", ")}`);
  return out;
}

/** The values the task card needs, from the job's inputs. */
export function taskCardValues({ issue, maxUsd, timeoutMinutes, validation, budgetCommand, protectedPaths, ciChecks = [] }) {
  const hours = Math.round((Number(timeoutMinutes) / 60) * 10) / 10;
  const checks = (ciChecks || []).filter(Boolean);
  return {
    issue: String(issue),
    usd: String(maxUsd),
    hours: String(hours),
    validation: (validation || []).length ? validation.map(commandText).join("; ") : "none",
    validation_note: checks.length
      ? `Factory's validation pass is the repository's required check${checks.length > 1 ? "s" : ""} (${checks.join(", ")}) on the head Factory pushes, run by CI in parallel; before you stop, run the tests your change touches, not the whole suite.`
      : "Run the validation commands before you stop; Factory runs them again.",
    budget_command: budgetCommand && budgetCommand.trim() ? budgetCommand.trim() : "none",
    protected_paths: protectedPaths.join(", "),
    branch: `factory/${issue}`,
  };
}

/** The protected list: Factory's fixed entries plus the repository's additions, deduped. */
export const FACTORY_PROTECTED = [
  ".github/",
  "CODEOWNERS",
  ".agents/skills/",
  ".claude/",
  ".codex/",
];

export function protectedPaths(additions = []) {
  const all = [...FACTORY_PROTECTED, ...additions.map((p) => p.trim()).filter(Boolean)];
  return [...new Set(all)];
}

/**
 * Whether a red validation pass gets a fix run: `maxPasses` passes at most, plus one when the red is the first the
 * required checks found. Locally the commands run before the checks, so a change they do not exercise (a browser test
 * only CI runs) is first red in the checks, possibly on the last pass; that red gets its fix run. Each later red stops
 * at `maxPasses`. `catchUps`: the catch-up merges of Factory's own (outbox.mjs catchUp) found red so far, each one
 * pass more: a pass on a merge Factory chose is not the change's, so it never takes the change's last pass.
 */
export const fixRunAllowed = ({ passes, maxPasses, fromChecks, checksFixed, catchUps = 0 }) => passes < maxPasses + catchUps + (fromChecks && !checksFixed ? 1 : 0);

/**
 * Whether a protected entry covers `path` (from the repository root). A directory entry ends with `/` and matches from
 * the root; a file entry matches at any depth (`build.mjs` covers `packages/web/build.mjs`) unless it starts with `/`,
 * which anchors it at the root (`/build.mjs` covers `build.mjs` only). A leading `./` is dropped and anchors nothing.
 * session.mjs configureGit's commit hook matches the same way.
 */
export function protectedCovers(rule, path) {
  const kept = rule.replace(/^\.\//, "");
  const root = kept.startsWith("/");
  const clean = kept.replace(/^\/+/, "");
  if (!clean) return false;
  if (clean.endsWith("/")) return path.startsWith(clean);
  return path === clean || (!root && path.endsWith(`/${clean}`));
}

/** Changed files that fall under a protected path (protectedCovers). */
export function protectedTouched(files, protectedList) {
  const hits = [];
  for (const file of files) {
    const path = file.replace(/^\.\//, "");
    if (protectedList.some((rule) => protectedCovers(rule, path))) hits.push(path);
  }
  return hits;
}

// ------------------------------------------------------------ fix-pass scope

// Toolchain, lockfile and CI configuration: what a fix pass (after a red, or answering the review) may change only when
// its scope reaches it (fixScopeRefused). `.github/` is not here: it is a protected path, refused for every pass.
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "deno.lock", "Cargo.lock", "go.sum", "go.work.sum", "poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock", "pixi.lock", "conda-lock.yml", "Gemfile.lock", "composer.lock", "mix.lock", "pubspec.lock", "Package.resolved", "Podfile.lock", "flake.lock", "gradle.lockfile", "packages.lock.json"]);
// Each lockfile and the manifests it is regenerated from: a lockfile beside one of its own manifests in scope is in
// scope (a Cargo.lock beside a package.json is not). packages.lock.json (NuGet) pairs with a project file of any name,
// so it has none here and stays toolchain.
const LOCK_PAIRS = {
  "package-lock.json": ["package.json"], "npm-shrinkwrap.json": ["package.json"], "yarn.lock": ["package.json"], "pnpm-lock.yaml": ["package.json"], "bun.lock": ["package.json"], "bun.lockb": ["package.json"],
  "deno.lock": ["deno.json", "deno.jsonc"], "Cargo.lock": ["Cargo.toml"], "go.sum": ["go.mod"], "go.work.sum": ["go.work"],
  "uv.lock": ["pyproject.toml"], "poetry.lock": ["pyproject.toml"], "pdm.lock": ["pyproject.toml"], "Pipfile.lock": ["Pipfile"], "pixi.lock": ["pixi.toml", "pyproject.toml"], "conda-lock.yml": ["environment.yml"],
  "Gemfile.lock": ["Gemfile"], "composer.lock": ["composer.json"], "mix.lock": ["mix.exs"], "pubspec.lock": ["pubspec.yaml"], "Package.resolved": ["Package.swift"], "Podfile.lock": ["Podfile"], "flake.lock": ["flake.nix"],
  "gradle.lockfile": ["build.gradle", "build.gradle.kts"],
};
const MANIFESTS = new Set(Object.values(LOCK_PAIRS).flat());
const TOOLCHAIN_FILES = new Set([
  // version pins and package-manager configuration
  ".nvmrc", ".node-version", ".bun-version", ".tool-versions", ".python-version", ".ruby-version", ".java-version", ".go-version", ".terraform-version", ".sdkmanrc", "mise.toml", ".mise.toml", "rust-toolchain", "rust-toolchain.toml", "global.json", ".npmrc", ".yarnrc", ".yarnrc.yml", "gradle-wrapper.properties", "maven-wrapper.properties",
  // pnpm 10's settings (overrides, onlyBuiltDependencies, catalogs, patchedDependencies) live here; a change to its
  // `packages` list alone is workspace membership, not toolchain (membershipOnly, fixScopeRefused `membership`)
  "pnpm-workspace.yaml",
  // CI outside .github/, and the hooks git runs
  ".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "Jenkinsfile", "appveyor.yml", ".drone.yml", ".woodpecker.yml", ".pre-commit-config.yaml", "lefthook.yml",
]);
const TOOLCHAIN_DIRS = [".devcontainer/", ".circleci/", ".buildkite/", ".woodpecker/", ".husky/"];
const fileName = (p) => p.split("/").at(-1);
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");

/** Whether a path is toolchain, lockfile or CI configuration (a pin, a lockfile, a CI file, a container, a `*toolchain*` file other than prose, a file under a `toolchain/` directory). */
export function toolchainFile(path) {
  const p = String(path).replace(/^\.\//, "");
  const name = fileName(p);
  if (LOCKFILES.has(name) || TOOLCHAIN_FILES.has(name)) return true;
  if (/toolchain/i.test(name) && !/\.(md|mdx|markdown|txt|rst|adoc)$/i.test(name)) return true;
  if (/^(Dockerfile|Containerfile)(\..+)?$|\.(Dockerfile|Containerfile)$/.test(name)) return true;
  if (p.split("/").slice(0, -1).some((d) => /^toolchains?$/i.test(d))) return true;
  return TOOLCHAIN_DIRS.some((d) => p.startsWith(d) || p.includes(`/${d}`));
}

// Dependency lists an install command reads (`pip install -r requirements.txt`): a fix pass adding a dependency changes
// one, so commandPaths leaves them out. Lockfiles stay toolchain through toolchainFile. A list is a `.txt` or `.in` file
// named requirements or constraints (`requirements-dev.txt`, `dev-requirements.txt`, `test_constraints.in`) or under a
// `requirements/` or `constraints/` directory (`requirements/dev.txt`).
const DEPENDENCY_LIST = /^(?:[\w.-]*[-_.])?(?:requirements|constraints)(?:[-_.][\w.-]*)?\.(?:txt|in)$/;
const dependencyFile = (path) => {
  const name = fileName(path);
  if (MANIFESTS.has(name) || LOCKFILES.has(name) || DEPENDENCY_LIST.test(name)) return true;
  return /\.(?:txt|in)$/.test(name) && path.split("/").slice(0, -1).some((d) => d === "requirements" || d === "constraints");
};

/**
 * The repository paths a shell command names (`setup`, an explicit `install`): each word that is a relative path with a
 * directory, an extension or a leading `./` (`scripts/setup.sh`, `./tools/install-deps.sh`, `setup.sh`, `./setup`), or
 * the script an interpreter runs (`sh configure`, `bash -e bootstrap`; interpreterScript),
 * quotes and a leading `./` dropped; flags, assignments, variables, absolute paths, URLs and `..` are not, nor are
 * manifests, lockfiles and requirements files (dependencyFile). A fix pass changing one is changing the toolchain (fixScopeRefused `extra`).
 */
export function commandPaths(command) {
  const out = new Set();
  for (const segment of String(command || "").split(/[;&|()<>`\n]+/)) {
    const script = interpreterScript(segment);
    for (let w of segment.split(/\s+/)) {
      w = w.replace(/^['"]+|['"]+$/g, "");
      if (w.startsWith("-") && w.includes("=")) w = w.slice(w.indexOf("=") + 1);
      if (!w || w.startsWith("-") || /[=$~*?{}\\]|:\/\//.test(w) || w.startsWith("/")) continue;
      const dotted = /^\.\//.test(w);
      const named = w === script;
      w = w.replace(/^(\.\/)+/, "");
      if (!w || w.split("/").some((s) => s === ".." || s === "")) continue;
      if ((dotted || named || w.includes("/") || /\.[A-Za-z0-9]+$/.test(w)) && !dependencyFile(w)) out.add(w);
    }
  }
  return [...out];
}

// Interpreters whose first operand is a script file (`sh configure`, `bash -e bootstrap`); the options that make the
// next word inline code or a module instead (`node -e`, `python -m`) mean no script. `sudo`, `env` and assignments may
// come first.
const SHELL_INLINE = /^-[A-Za-z]*c$/;
const INTERPRETERS = {
  bash: SHELL_INLINE, sh: SHELL_INLINE, dash: SHELL_INLINE, zsh: SHELL_INLINE, ksh: SHELL_INLINE,
  node: /^(-e|-p|--eval|--print)$/, python: /^-[A-Za-z]*[cm]$/, python3: /^-[A-Za-z]*[cm]$/, ruby: /^-[A-Za-z]*e$/, perl: /^-[A-Za-z]*[eE]$/,
};
const PREFIXES = new Set(["sudo", "env", "exec", "command", "nice", "time"]);

/** The script word an interpreter runs in one simple command (`sh configure` → `configure`), quotes kept off; else null. */
function interpreterScript(segment) {
  const words = segment.trim().split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, "")).filter(Boolean);
  let i = 0;
  let prefixed = false;
  for (; i < words.length; i += 1) {
    if (PREFIXES.has(words[i])) prefixed = true;
    else if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) && !(prefixed && words[i].startsWith("-"))) break;
  }
  const name = (words[i] ?? "").split("/").pop();
  if (!Object.hasOwn(INTERPRETERS, name)) return null;
  const inline = INTERPRETERS[name];
  for (i += 1; i < words.length && words[i].startsWith("-"); i += 1) if (inline.test(words[i])) return null;
  return words[i] ?? null;
}

/** The repository paths the `setup` command and an explicit `install` command name (commandPaths): toolchain to a fix pass. */
export const setupPaths = ({ setup = "", install = "auto" } = {}) => [...new Set([...commandPaths(setup), ...(install && install !== "auto" && install !== "none" ? commandPaths(install) : [])])];

/**
 * The repository files the `setup` command names (commandPaths) that are files in the checkout (`isFile`, given a path
 * from its root). Setup runs as the runner, beside the App's key (with sudo on Actions, as root into a sandbox's image),
 * on every route, so each must be a protected path: no worker or fix pass may change what it runs.
 */
export const setupFiles = (setup, isFile) => commandPaths(setup).filter((p) => isFile(p));
/** The setup files no entry of the protected list covers (protectedTouched): doctor FAILs on any, setup adds them. */
export const unprotectedFiles = (files, protectedList) => files.filter((f) => !protectedTouched([f], protectedList).length);

/** Whether `text` names `path` as a whole token (a path or file name in a log line, a plan item, a comment). */
export function namesPath(text, path) {
  if (!text || !path) return false;
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.-])${esc}(?![\\w-]|\\.\\w)`).test(text);
}

// A workspace's lockfile sits at its root, not beside a member's manifest. Each declaration file, the lockfiles at its
// root it brings and the member manifest name; the members are the ones the declaration itself lists.
const WORKSPACE_KINDS = [
  { file: "pnpm-workspace.yaml", locks: ["pnpm-lock.yaml"], manifest: "package.json", read: (t) => boundedYaml(t).doc?.packages ?? null },
  {
    file: "package.json",
    locks: ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"],
    manifest: "package.json",
    read: (t) => {
      const w = JSON.parse(t)?.workspaces;
      return Array.isArray(w) ? w : (w?.packages ?? null);
    },
  },
  { file: "pyproject.toml", locks: ["uv.lock"], manifest: "pyproject.toml", read: (t) => parseToml(bounded(t).text)?.tool?.uv?.workspace ?? null, toml: true },
  { file: "Cargo.toml", locks: ["Cargo.lock"], manifest: "Cargo.toml", read: (t) => parseToml(bounded(t).text)?.workspace ?? null, toml: true },
];
/** The declaration files a workspace root may hold (workspaceDeclarations reads them). */
export const WORKSPACE_FILES = [...new Set(WORKSPACE_KINDS.map((k) => k.file))];
const WORKSPACE_LOCKS = new Set(WORKSPACE_KINDS.flatMap((k) => k.locks));

/** The directories (`""` the root, else ending in `/`) of the workspace lockfiles among `paths`: where a declaration would sit. */
export const workspaceLockDirs = (paths) => [...new Set(paths.map((p) => String(p).replace(/^\.\//, "")).filter((p) => WORKSPACE_LOCKS.has(fileName(p))).map(dirOf))];

const strings = (v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null);

/**
 * The workspaces declared in directory `dir` (`""` or ending in `/`), from `files` (declaration file name to its text, or
 * null when absent): pnpm-workspace.yaml `packages`, package.json `workspaces` (a list, or `{packages}`), pyproject.toml
 * `[tool.uv.workspace]` `members`/`exclude`, Cargo.toml `[workspace]` `members`/`exclude`. A `!` pattern in a JS list
 * excludes. Each is {dir, locks, manifest, members, exclude}. A declaration that does not parse, a YAML or TOML one past
 * the bounds (DECLARATION_MAX), or one whose lists are not lists of strings, declares nothing.
 */
export function workspaceDeclarations(dir, files = {}) {
  const out = [];
  for (const k of WORKSPACE_KINDS) {
    const text = files[k.file];
    if (typeof text !== "string") continue;
    let decl;
    try {
      decl = k.read(text);
    } catch {
      continue;
    }
    let members;
    let exclude;
    if (k.toml) {
      members = strings(decl?.members);
      exclude = decl?.exclude === undefined ? [] : strings(decl.exclude);
    } else {
      const all = strings(decl);
      members = all?.filter((g) => !g.startsWith("!"));
      exclude = all?.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
    }
    if (members?.length && exclude) out.push({ dir, locks: k.locks, manifest: k.manifest, members, exclude });
  }
  return out;
}

// One path segment against one glob segment: `*` any run of characters, `?` one; everything else literal. A two-pointer
// wildcard match that only ever resumes from the latest `*`: O(glob × segment) at worst, never exponential, since member
// globs come from a file a worker can write.
function segmentMatch(glob, seg) {
  let g = 0, s = 0, star = -1, mark = 0;
  while (s < seg.length) {
    if (g < glob.length && (glob[g] === "?" || (glob[g] !== "*" && glob[g] === seg[s]))) { g++; s++; }
    else if (g < glob.length && glob[g] === "*") { star = g++; mark = s; }
    else if (star >= 0) { g = star + 1; s = ++mark; }
    else return false;
  }
  while (g < glob.length && glob[g] === "*") g++;
  return g === glob.length;
}
// A glob relative to the workspace root against a directory relative to it: `**` any number of segments. A pattern
// that leaves the root (`..`, absolute) matches nothing.
function globMatch(glob, rel) {
  const g = glob.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!g || g.startsWith("/")) return false;
  const gs = g.split("/");
  if (gs.some((x) => x === ".." || x === "" || x === ".")) return false;
  const ps = rel.split("/");
  // Memoised over (glob segment, path segment): each pair is decided once, so repeated `**` stays polynomial.
  const seen = new Map();
  const at = (a, b) => {
    const key = a * (ps.length + 1) + b;
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    let r;
    if (a === gs.length) r = b === ps.length;
    else if (gs[a] === "**") r = at(a + 1, b) || (b < ps.length && at(a, b + 1));
    else r = b < ps.length && segmentMatch(gs[a], ps[b]) && at(a + 1, b + 1);
    seen.set(key, r);
    return r;
  };
  return at(0, 0);
}

/** Whether `path` is a member manifest of workspace `w` (workspaceDeclarations): its manifest name, in a member directory below the root, not excluded. */
export function workspaceMember(w, path) {
  const p = String(path).replace(/^\.\//, "");
  if (fileName(p) !== w.manifest || !p.startsWith(w.dir)) return false;
  const rel = dirOf(p.slice(w.dir.length)).replace(/\/$/, "");
  return !!rel && w.members.some((g) => globMatch(g, rel)) && !w.exclude.some((g) => globMatch(g, rel));
}

// pnpm-workspace.yaml and the TOML workspace declarations are read from files a worker can write: bounded before the
// parser sees them (bounded), so its cost stays small and its recursion shallow (a line per nesting level at most, a
// bracketed collection a few levels deep). Past a bound the text throws: a declaration then declares nothing, a
// pnpm-workspace.yaml change is toolchain. package.json goes to JSON.parse, linear and not recursive, unbounded.
const SETTINGS_FILE = "pnpm-workspace.yaml";
const DECLARATION_MAX = { bytes: 64 * 1024, lines: 1000, line: 1024, depth: 32 };
function bounded(text) {
  const t = String(text).replace(/\r\n?/g, "\n");
  if (t.length > DECLARATION_MAX.bytes) throw new Error("too large");
  const lines = t.split("\n");
  if (lines.length > DECLARATION_MAX.lines || lines.some((l) => l.length > DECLARATION_MAX.line)) throw new Error("too many or too long lines");
  // Every bracket counts, quoted or not: an over-count only refuses.
  let depth = 0;
  for (const c of t) {
    if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    if (depth > DECLARATION_MAX.depth) throw new Error("collections nested too deep");
  }
  return { text: t, lines };
}
function boundedYaml(text) {
  const { text: t, lines } = bounded(text);
  return { doc: parseYaml(t), lines };
}
// The lines outside the top-level `packages` entry (its key line at column 0 and every line up to the next line at
// column 0 that is not blank, a comment or a list item), blank lines and column-0 comments dropped.
function outsidePackages(lines) {
  const out = [];
  let inPackages = false;
  for (const l of lines) {
    if (l === "" || l[0] === "#") continue;
    if (l[0] !== " " && l !== "-" && !l.startsWith("- ")) inPackages = l.startsWith("packages:") && (l.length === 9 || l[9] === " ");
    if (!inPackages) out.push(l);
  }
  return out.join("\n");
}
const plainMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Whether a change to a pnpm-workspace.yaml from `before` to `after` (its texts; null when absent) touches only the
 * `packages` list: both parse, as mappings at column 0, `packages` a list of strings or absent after it, and every other
 * entry the same, parsed and as written (a new file holds `packages` only). A deleted file, a parse failure, a file past
 * the bounds, or any other key added, removed or changed is not: the change is toolchain (fixScopeRefused).
 */
export function membershipOnly(before, after) {
  if (typeof after !== "string" || (before !== null && typeof before !== "string")) return false;
  try {
    const was = before === null ? { doc: null, lines: [] } : boundedYaml(before);
    const now = boundedYaml(after);
    const a = was.doc ?? {};
    const b = now.doc ?? {};
    if (!plainMapping(a) || !plainMapping(b)) return false;
    if (b.packages != null && !strings(b.packages)) return false;
    const rest = (m) => JSON.stringify(Object.entries(m).filter(([k]) => k !== "packages"));
    return rest(a) === rest(b) && outsidePackages(was.lines) === outsidePackages(now.lines);
  } catch {
    return false;
  }
}
/** Whether `path` is a pnpm-workspace.yaml, toolchain unless its change touches only `packages` (membershipOnly). */
export const settingsFile = (path) => fileName(String(path)) === SETTINGS_FILE;

/**
 * The toolchain files (toolchainFile) a fix pass changed that its scope does not reach; outbox.mjs fences the pass with
 * it. In scope: a file the branch had changed before the fix passes began (`prior`), a path one of `texts` names, by
 * its path or its file name (the plan as it stood before the pass, the issue, the maintainers' decisions, the failing
 * checks' output, the review comments the pass answers), and a lockfile beside one of its own manifests (LOCK_PAIRS)
 * that is in scope: changed before, named, or changed by this pass too (a manifest is not toolchain, so a pass adding a
 * dependency may change it, and its lockfile follows). A workspace's root lockfile (`workspaces`, from
 * workspaceDeclarations) is in scope when one of its member manifests is changed before or by this pass. A lockfile
 * changed without its manifest or a member manifest in scope is refused. `extra` (the files the repository's `setup`
 * and `install` commands name, commandPaths) counts as toolchain too. A pnpm-workspace.yaml in `membership` (its change
 * touches only the `packages` list, membershipOnly) is not. Everything else a fix pass may change as before.
 */
export function fixScopeRefused(changed, { prior = [], texts = [], extra = [], workspaces = [], membership = [] } = {}) {
  const clean = (p) => String(p).replace(/^\.\//, "");
  const before = new Set(prior.map(clean));
  const setupPaths = new Set([...extra].map(clean));
  const named = (p) => texts.some((t) => namesPath(t, p) || namesPath(t, fileName(p)));
  const now = new Set(changed.map(clean));
  const manifestIn = (p) => (Object.hasOwn(LOCK_PAIRS, fileName(p)) ? LOCK_PAIRS[fileName(p)] : []).some((m) => [before, now].some((s) => s.has(`${dirOf(p)}${m}`)) || named(`${dirOf(p)}${m}`));
  const memberIn = (p) => workspaces.some((w) => w.dir === dirOf(p) && w.locks.includes(fileName(p)) && [before, now].some((s) => [...s].some((m) => workspaceMember(w, m))));
  const members = new Set(membership.map(clean));
  const membersOnly = (p) => settingsFile(p) && members.has(p) && !setupPaths.has(p);
  return [...now].filter((p) => (toolchainFile(p) || setupPaths.has(p)) && !before.has(p) && !named(p) && !manifestIn(p) && !memberIn(p) && !membersOnly(p));
}

/** The Blocked reason (and the push refusal) for toolchain files a fix pass changed outside its scope. */
export const fixScopeReason = (files) =>
  `a fix pass changed ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""} (toolchain, lockfile or CI configuration), which neither the plan nor the failing check names; to allow it, name the file in the issue or a maintainer comment and re-apply factory:objective`;

/**
 * The Blocked reason for a push GitHub refused because it would create or update a workflow file, which a token
 * without the Workflows permission (the local token, the Factory App) may not do. `paths`: the workflow files the branch
 * has unlike the default branch; `own`: those the branch itself changed. Fixed text: GitHub's own message goes to the
 * job log only.
 */
export const workflowScopeReason = ({ branch, defaultBranch, paths = [], own = [] }) => {
  const list = (p) => `${p.slice(0, 3).join(", ")}${p.length > 3 ? ` and ${p.length - 3} more` : ""}`;
  if (own.length) return `push rejected (workflow scope): GitHub refused ${branch} because it changes ${list(own)}, and Factory's token may not create or update workflow files; a person makes workflow changes, so take them out of the Objective or push them yourself, then re-apply the label`;
  if (paths.length) return `push rejected (workflow scope): GitHub refused ${branch} because its ${list(paths)} is not the version ${defaultBranch} has, and Factory's token may not create or update workflow files; bring the branch up to date with ${defaultBranch} (re-apply the label to rerun)`;
  // The branch's workflow files match the default branch as Factory last read it: it moved again before the push.
  return `push rejected (workflow scope): GitHub refused ${branch} for a workflow file Factory's token may not create or update, though its workflow files matched ${defaultBranch} when Factory read it; ${defaultBranch} likely changed one again during the push (re-apply the label to rerun)`;
};

/**
 * Whether `line` is git's porcelain line for refs/heads/`branch` carrying GitHub's refusal of a workflow file a token may
 * not write ("refusing to allow a Personal Access Token / a GitHub App / an OAuth App to create or update workflow ...").
 * Only GitHub's own phrase on the ref's own line counts: a `remote:` line or another reason that mentions a workflow does not.
 */
export const workflowScopeRefused = (line, branch) => {
  const [flag, refs, rest = ""] = String(line).split("\t");
  return flag === "!" && !!refs?.endsWith(`:refs/heads/${branch}`) && /^\[remote rejected\] \(refusing to allow an? [A-Za-z ]{2,40} to create or update workflow /.test(rest);
};

/** The reasons git itself gives on a refused ref's porcelain line; anything else on it is the remote's text. */
const GIT_REASONS = ["non-fast-forward", "fetch first", "stale info", "already exists"];

/**
 * The Blocked reason for any other push GitHub or git refused: fixed text and codes only. `out`: the push's porcelain and
 * stderr lines, read only for git's own status word (`[rejected]`, `[remote rejected]`, `[remote failure]`) and git's
 * own reasons; GitHub's text (the remote's URL, `remote:` lines, ruleset or push-protection messages) stays in the job log.
 */
export const pushRefusal = ({ branch, out = [], code = 1 }) => {
  const line = out.find((l) => l.startsWith("!\t")) || "";
  const status = /\[(remote rejected|remote failure|rejected)\]/.exec(line)?.[1] || "";
  const why = status === "rejected" ? GIT_REASONS.find((r) => line.includes(`(${r})`)) || "" : "";
  const kind = [status, why === "stale info" ? "GitHub's head moved since Factory read it" : why].filter(Boolean).join(", ");
  return `push rejected: GitHub refused refs/heads/${branch} (${kind ? `${kind}, ` : ""}exit ${code}); its message is in the job log`;
};

/** The PR label the App applies after validation is green; `pull_request(labeled)` on it fires the review job. */
export const REVIEW_LABEL = "factory:review";

// ----------------------------------------------------------------- dispatch

const PRIORITY = { P0: 0, P1: 1, P2: 2 };

/** 0 for P0, 1 for P1, 2 for P2, 3 for no priority label. */
export function priorityOf(issue) {
  const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  let best = 3;
  for (const n of names) if (n in PRIORITY && PRIORITY[n] < best) best = PRIORITY[n];
  return best;
}

/** Issue numbers named by `Blocked by #N` (or `blocked-by: #N, #M`) lines in a body. */
export function parseBlockedBy(body) {
  const out = new Set();
  for (const line of String(body || "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s*)?blocked[\s-]*by\s*:?\s*(.+)$/i.exec(line);
    if (!m) continue;
    for (const ref of m[1].matchAll(/#(\d+)/g)) out.add(Number(ref[1]));
  }
  return [...out];
}

/** The statuses that keep an issue out of the ready list, as the card shows them or the label says. */
export const NOT_READY_STATUSES = new Set(["Running", "Blocked", "Question", "In review", "Done"]);
export const STATE_LABELS = {
  "factory:running": "Running",
  "factory:blocked": "Blocked",
  "factory:question": "Question",
  "factory:in-review": "In review",
};

/**
 * The issue's state from its Project card, else from its fallback label, else Queued. The board has no Question
 * column: a Question's card sits in In review (applyExit), and its `factory:question` label says which it is, so a
 * card In review with that label is a Question, as the label alone says without a board.
 */
export function stateOf(issue, cardStatus) {
  const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  if (cardStatus === "In review" && names.includes("factory:question")) return "Question";
  if (cardStatus && cardStatus !== "Queued") return cardStatus;
  for (const n of names) if (STATE_LABELS[n]) return STATE_LABELS[n];
  return cardStatus || "Queued";
}

/**
 * The Done pass's work (dispatch.mjs): each recently closed Objective this process tends (its backend's `tends`) that
 * still carries a state label, or whose card is not Done, with the state labels it removes. A local loop tends only
 * the Objectives it routes: another route's are that route's to tidy (#2668).
 */
export function doneTidies(closed, { cards = {}, project = false, tends = () => true } = {}) {
  const out = [];
  for (const issue of closed) {
    if (!tends(issue)) continue;
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter((n) => STATE_LABELS[n]);
    const card = project ? (cards[issue.number] ?? null) : null;
    if (!labels.length && (!card || card === "Done")) continue;
    out.push({ number: issue.number, labels });
  }
  return out;
}

/**
 * The record a Done pass acting under a person's login posts (marker `done`) before it removes `labels`: the scorer
 * (bench/lib/objective.mjs) reads its `removed:` line, so those removals count as Factory's, not that person's.
 */
export const doneRecord = (labels) => `Factory: this Objective is closed, so its state label is cleared and its card moves to Done.\nremoved: ${labels.join(" ")}`;

/**
 * Choose the issues to start. Pure: the caller supplies what GitHub said.
 *  issues:      open issues with the objective label; each {number, labels, body, blockedBy?: [{number, state}], relationsUnread?}
 *  statuses:    {number: cardStatus|null}
 *  openIssues:  Set of open issue numbers (to resolve body references)
 *  held:        {number: reason} for Queued issues the caller holds back for now (a requeue's backoff)
 *  maxConcurrent, dailyUsd, spentToday
 *  deferred:    {number: reason} for issues that wait before their next start (a vendor quota's backoff)
 * Returns {ready: [numbers], skipped: [{number, reason}], running, reason}
 */
export function selectReady({ issues, statuses = {}, openIssues = new Set(), held = {}, maxConcurrent, dailyUsd, spentToday = 0, deferred = {} }) {
  const skipped = [];
  let running = 0;
  const candidates = [];
  for (const issue of issues) {
    const state = stateOf(issue, statuses[issue.number] ?? null);
    if (state === "Running") running += 1;
    if (NOT_READY_STATUSES.has(state)) {
      skipped.push({ number: issue.number, reason: state });
      continue;
    }
    // Its REST relations were rate limited this tick: unknown, never "none"; the next tick reads them again.
    if (issue.relationsUnread) {
      skipped.push({ number: issue.number, reason: "blocked-by relations not read (rate limited); next tick" });
      continue;
    }
    if (deferred[issue.number]) {
      skipped.push({ number: issue.number, reason: deferred[issue.number] });
      continue;
    }
    const relations = issue.blockedBy ?? parseBlockedBy(issue.body).map((n) => ({ number: n, state: openIssues.has(n) ? "open" : "closed" }));
    const open = relations.filter((r) => r.state === "open").map((r) => r.number);
    if (open.length) {
      skipped.push({ number: issue.number, reason: `blocked by #${open.join(", #")}` });
      continue;
    }
    if (Object.hasOwn(held, issue.number)) {
      skipped.push({ number: issue.number, reason: held[issue.number] });
      continue;
    }
    candidates.push(issue);
  }
  candidates.sort((a, b) => priorityOf(a) - priorityOf(b) || a.number - b.number);

  if (dailyUsd !== undefined && dailyUsd !== null && Number(dailyUsd) > 0 && spentToday >= Number(dailyUsd)) {
    for (const c of candidates) skipped.push({ number: c.number, reason: `daily_usd reached ($${spentToday.toFixed(2)} of $${Number(dailyUsd)})` });
    return { ready: [], skipped, running, reason: "daily_usd reached" };
  }
  const slots = Math.max(0, Number(maxConcurrent) - running);
  const ready = candidates.slice(0, slots).map((c) => c.number);
  for (const c of candidates.slice(slots)) skipped.push({ number: c.number, reason: "max_concurrent reached" });
  return { ready, skipped, running, reason: ready.length ? "" : slots === 0 ? "max_concurrent reached" : "nothing ready" };
}

/** Sum today's dollars from usage records; unmetered (null) counts as zero. */
export function sumSpend(records) {
  let total = 0;
  // A negative figure (a forged or broken usage report) is no spend: it never lowers the job's or the day's total.
  for (const r of records) if (r && typeof r.usd === "number" && Number.isFinite(r.usd)) total += Math.max(0, r.usd);
  return total;
}

/**
 * Whether a run left max_usd unenforceable: a Copilot run that did work (turns) but reported no priced AI credits.
 * Its caller stops further passes rather than spend blind (logic.mjs decideExit names it).
 */
export const unmeteredRun = (rec) => rec?.harness === "copilot" && (rec.usd === null || rec.usd === undefined) && (rec.turns ?? 0) > 0;

// --------------------------------------------------------------- exit logic

/** How long a worker's Block or Question reason may run in a notice before it is shortened (clip). */
export const REASON_MAX = 200;

/**
 * `text` cut to at most `max` characters on a word boundary, ending in "…" when anything was cut; a single word longer
 * than half of `max` (a URL, a path) is cut inside it instead. Shorter text comes back trimmed and otherwise unchanged.
 */
export function clip(text, max = REASON_MAX) {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  // Room for the "…": a space at max - 1 is itself a boundary, otherwise the last space before it.
  const at = /\s/.test(s[max - 1]) ? max - 1 : s.slice(0, max - 1).search(/\s\S*$/);
  let cut = s.slice(0, at > max / 2 ? at : max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.replace(/[\s,;:.\-\u2013\u2014]+$/, "")}…`;
}

/**
 * Why a stage Blocked, as a code: a closed list, written on each Blocked notice (blockMarker) so the bench scorer decides
 * the External bucket on structure, never on the reason's words. `external`: outside Factory and outside the work, so
 * the 1.0 streak skips an Objective whose only stops were these (docs/PLAN.md, Job one). Anything Factory cannot place
 * is `factory`, never external.
 */
export const BLOCK_CAUSES = Object.freeze({
  "max-usd": Object.freeze({ external: true, what: "Factory's max_usd cap reached" }),
  "gateway-budget": Object.freeze({ external: true, what: "the AI Gateway refused for its own budget or credits" }),
  "provider-quota": Object.freeze({ external: true, what: "a provider's quota, plan limit or billing refusal: the model provider, GitHub's Git LFS storage, or the sandbox vendor's plan" }),
  outage: Object.freeze({ external: true, what: "a provider or GitHub outage Factory waited or retried through by its rules" }),
  setup: Object.freeze({ external: false, what: "a setup gap: a credential or payment method, a secret, a host, an install, any other Git LFS refusal, the repository's settings or rules, the author's access" }),
  work: Object.freeze({ external: false, what: "the work: the worker's own Block, validation red, review findings, a protected path, the Objective's size" }),
  factory: Object.freeze({ external: false, what: "Factory itself: a crash, a lost or stuck stage, an exit it could not apply, or a cause it did not place" }),
});

/** The Blocked notice's cause line; a code outside BLOCK_CAUSES is written as `factory`. */
export const blockMarker = (cause) => `<!-- factory:block ${JSON.stringify({ cause: Object.hasOwn(BLOCK_CAUSES, cause) ? cause : "factory" })} -->`;

const BLOCK_LINE = /^<!-- factory:block (\{[^\n]*\}) -->$/gm;
/**
 * The cause a Blocked notice records (blockMarker), or null: none written (an older notice) or not on the list. The
 * notice's last cause line is Factory's (applyExit writes it after the sanitised reason and output).
 */
export function blockCauseOf(body) {
  const m = [...String(body || "").matchAll(BLOCK_LINE)].at(-1);
  if (!m) return null;
  try {
    const cause = JSON.parse(m[1])?.cause;
    return typeof cause === "string" && Object.hasOwn(BLOCK_CAUSES, cause) ? cause : null;
  } catch {
    return null;
  }
}

/** Provider error types and codes (usage.mjs REFUSED_KINDS) that are a quota or billing refusal, by whose account. */
const PROVIDER_QUOTA_KINDS = new Set(["insufficient_quota", "billing_error", "quota"]);
const GATEWAY_BUDGET_KINDS = new Set(["quota_for_entity_exceeded", "insufficient_funds"]);

/**
 * A provider refusal's cause (usage.mjs providerRefusal): the AI Gateway's budget or credits, the provider's quota or
 * billing (those kinds, or HTTP 402), else a setup gap (a key, an authorization, a payment method, a request the
 * settings make).
 */
export function refusalCause(r) {
  const kinds = [r?.type, r?.code];
  if (kinds.some((k) => GATEWAY_BUDGET_KINDS.has(k))) return "gateway-budget";
  if (kinds.some((k) => PROVIDER_QUOTA_KINDS.has(k)) || r?.status === 402) return "provider-quota";
  return "setup";
}

/**
 * The Blocked reason for a provider's refusal (usage.mjs providerRefusal): the harness, the status, type and code, and the
 * provider's own message shortened (clip). Retrying cannot pass it, so the fix is the credential's account or the settings.
 */
export function refusalReason(r) {
  const fields = refusalFields(r);
  return `${r.harness} was refused by its provider${fields ? ` (${fields})` : ""}${r.message ? `: ${clip(r.message)}` : ""}; not retried: the fix is on the credential's account or in the harness settings, not in the code`;
}

/** A Question from the worker's exit record: its first question, else the generic line. */
const openQuestion = (record) => ({ exit: "question", reason: record?.questions?.length ? `question: ${clip(record.questions[0])}` : "an assumption would change a public contract or a recorded decision" });

/**
 * A worker's own Block: its reason, shortened, the hosts its sandbox denied and the variables its shell lacked when it
 * named them.
 */
const workerBlocked = (record) => ({ exit: "blocked", reason: `worker blocked: ${clip(record.reason || "no reason given")}`, cause: record.deniedHosts?.length || record.missingSecrets?.length ? "setup" : "work", ...(record.deniedHosts?.length ? { deniedHosts: record.deniedHosts } : {}), ...(record.missingSecrets?.length ? { missingSecrets: record.missingSecrets } : {}) });

/**
 * A host name as DNS spells it, in lower case: two or more labels of letters, digits and inner hyphens, at most 63
 * characters each and 253 in all, the last starting with a letter. No IP address, port, path, wildcard or space, so a
 * value that passes is safe to quote in a GitHub comment.
 */
export const isHostName = (h) => typeof h === "string" && h.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(h);

/** At most this many denied hosts are kept from an exit record. */
export const DENIED_HOSTS_MAX = 10;

/** An exit record's `deniedHosts`: its strings that are host names (isHostName, after trim and lower case), once each. */
export const deniedHostsOf = (v) => [...new Set((Array.isArray(v) ? v : []).filter((h) => typeof h === "string").map((h) => h.trim().toLowerCase()).filter(isHostName))].slice(0, DENIED_HOSTS_MAX);

/** Whether `host` is on a sandbox allow list: named exactly, or under a `*.` entry. */
const allowedBy = (host, domains) => domains.some((d) => d === host || (typeof d === "string" && d.startsWith("*.") && host.endsWith(d.slice(1))));

/**
 * The fix line of a Block whose worker named the hosts its sandbox denied: allow them in FACTORY_LOCAL_DOMAINS (local
 * mode) or the `allowed_domains` input (`route` "runner": Claude Code on Actions or in a cloud sandbox), then re-apply
 * the label. Hosts the sandboxes already allow (`domains`) are left out, since allowing them again fixes
 * nothing; null when none is left, so the Block keeps the generic fix.
 */
export function deniedHostsFix(hosts, domains = [], route = "local") {
  const left = deniedHostsOf(hosts).filter((h) => !allowedBy(h, domains));
  if (!left.length) return null;
  const them = left.length === 1 ? "it" : "them";
  const named = left.map((h) => `\`${h}\``).join(", ");
  // On Actions and in a cloud sandbox, Claude Code's or Codex's sandbox: the workflow's `allowed_domains` input
  // (harness.mjs claudeRunner, codexRunner).
  if (route === "runner") return `The harness's sandbox denied ${named}. If the Objective needs ${them}, add ${them} to the Factory workflow's \`allowed_domains\` input (or \`FACTORY_ALLOWED_DOMAINS\` in its env block), then re-apply \`factory:objective\`.`;
  return `The local sandbox denied ${named}. If the Objective needs ${them}, add ${them} to \`FACTORY_LOCAL_DOMAINS\` (a running \`serve\` reads it when it restarts), then re-apply \`factory:objective\`.`;
}

/**
 * The worker's exit, from what the run left behind.
 *  harness:    {ok: boolean, error?: string, budgetExceeded?: boolean, timedOut?: boolean, died?: number, refusal?: object}
 *  pr:         {exists, draft, body} | null
 *  commits:    number of commits on the branch beyond the base
 *  validation: {passes: number, green: boolean, lastOutput?: string, baseFailure?: string, notStarted?: string, stuck?: string (a wait with
 *              nothing failed: checksNotStarted's reason), triageRefused?: string (refusedRerunText), scope?: string (fixScopeReason)}
 *  protectedHits: string[]
 *  record:     the harness's exit record {exit, reason, questions, deniedHosts?, missingSecrets?} (parseExitRecord), or null
 *  recordBasis: where the record came from (session.mjs exitRecord `basis`); "none" when Factory filled it in because
 *              the harness left none and the ask could not run or got none, so it is not the worker's own reason
 *  question:   boolean, when the caller has already decided whether a question is open
 *              (the review job: the PR's draft state after the answer pass, so a human's
 *              "mark ready" answers it)
 *  reviewUnaddressed: number (review pass: comments without a worker reply)
 *  pushRejected: why Factory's push was refused or rejected (outbox.mjs); any such push Blocks
 *  lfsRefused: boolean, the refusal was Git LFS's (quota, storage, cap, pointers)
 *  lfsQuota:   boolean, that refusal was GitHub's Git LFS quota or storage (outbox.mjs errorKind "lfs-quota")
 *  lfsPlain:   string[], files .gitattributes routes to Git LFS but committed as plain blobs
 *  planNeeds:  string, why the plan needs another repository (one-repo.mjs planNeeds): a
 *              Question, asked whether or not the run committed, before any other check but the hard stops
 *  sessionCap: string, sessionCapNote: the sandbox vendor's session cut this stage's wall clock; a time cap names it
 * Nothing here reads prose: the record is JSON the harness wrote (or answered with), the
 * rest are GitHub fields, exit codes and counts.
 * Returns {exit: 'delivered'|'question'|'blocked', reason}, a blocked one with its `cause` (BLOCK_CAUSES), plus `deniedHosts` when the worker Blocked on hosts its
 * sandbox denied (its exit record's): the stage's backend turns them into the notice's fix (backend.mjs deniedFix);
 * likewise `missingSecrets`, the variables its shell lacked (worker-secrets.mjs missingSecretsFix).
 * A worker's reason and question are shortened on a word boundary (clip).
 */
export function decideExit({ harness, pr, commits = 0, validation, protectedHits = [], record = null, recordBasis = "", question, reviewUnaddressed = 0, pushRejected = "", lfsRefused = false, lfsQuota = false, lfsPlain = [], planNeeds = "", sessionCap = "" }) {
  // Git LFS first: the branch on GitHub lacks the work (a refused upload) or carries a binary LFS should hold.
  // GitHub's Git LFS quota or storage (the outbox's `lfs-quota` refusal) is a plan limit a person raises; any other LFS refusal is setup.
  if (lfsRefused) return { exit: "blocked", reason: pushRejected || "Git LFS refused the upload (quota or storage)", cause: lfsQuota ? "provider-quota" : "setup" };
  if (lfsPlain.length) return { exit: "blocked", reason: `committed as plain git blobs though .gitattributes routes them to Git LFS: ${lfsPlain.slice(0, 5).join(", ")}`, cause: "work" };
  // Factory refused or GitHub rejected a push (outbox.mjs): what GitHub holds is not what was checked. Always Blocked.
  if (pushRejected) return { exit: "blocked", reason: /^push rejected/.test(pushRejected) ? pushRejected : `push refused: ${pushRejected}`, cause: "work" };
  // A provider's refusal (usage.mjs providerRefusal) is never retried: it Blocks at once, naming the refusal.
  if (harness?.refusal) return { exit: "blocked", reason: refusalReason(harness.refusal), cause: refusalCause(harness.refusal) };
  if (harness?.died >= 2) return { exit: "blocked", reason: "worker process died twice", cause: "factory" };
  // In a sandbox whose vendor session cut the stage's wall clock (sessionCapNote), the reason names that cap.
  if (harness?.timedOut) return { exit: "blocked", reason: sessionCap ? `time cap reached: ${sessionCap}` : "time cap reached", cause: "work" };
  if (harness?.budgetExceeded) return { exit: "blocked", reason: harness.unmetered ? "unmetered: max_usd cannot be enforced" : "dollar cap reached", cause: harness.unmetered ? "factory" : "max-usd" };
  if (protectedHits.length) return { exit: "blocked", reason: `touched protected path ${protectedHits.join(", ")}`, cause: "work" };
  // The plan needs another repository: the owner decides, so no commit (the plan-time stop) is no Block.
  if (planNeeds) return { exit: "question", reason: planNeeds };
  if (!pr?.exists) {
    // A worker that stopped because the sandbox denied a host it needs, or its shell lacked a secret: its own reason and
    // the names, not the missing commits.
    if (record?.exit === "blocked" && (record.deniedHosts?.length || record.missingSecrets?.length)) return workerBlocked(record);
    if (commits === 0) {
      // A worker that stopped on purpose before any commit: its own Block or Question, with the reason it gave. A record
      // Factory filled in because the ask could not run or got no record (recordBasis "none") is not the worker's.
      const own = record && recordBasis !== "none";
      if (own && record.exit === "blocked" && record.reason) return workerBlocked(record);
      if (own && record.exit === "question") return openQuestion(record);
      const why = harness?.error ? `worker ended without commits: ${harness.error}` : "worker ended without commits or a PR";
      return { exit: "blocked", reason: record?.exit === "blocked" && !own && record.reason ? `${why}; ${clip(record.reason)}` : why, cause: "factory" };
    }
    return { exit: "blocked", reason: "no PR could be opened for the branch", cause: "factory" };
  }
  if (validation && !validation.green) {
    // Every failing job fails the same way on the default branch (reds.mjs): handed back as the base's, not this change's.
    if (validation.baseFailure) return { exit: "blocked", reason: validation.baseFailure, cause: "work" };
    // A required job GitHub never started (triage.mjs notStartedJobs): infrastructure, Blocked quoting GitHub's annotation.
    if (validation.notStarted) return { exit: "blocked", reason: validation.notStarted, cause: "outage" };
    // A wait that ended with no required check failed (triage.mjs checksNotStarted): no red at all, so never "validation red".
    if (validation.stuck) return { exit: "blocked", reason: validation.stuck, cause: "factory" };
    // A fix pass kept toolchain changes its scope does not reach (fixScopeRefused): nothing of it was pushed.
    if (validation.scope) return { exit: "blocked", reason: validation.scope, cause: "work" };
    const red = `validation red after Factory's ${["first", "second", "third"][Math.min(Math.max(validation.passes, 1), 3) - 1]} pass${validation.command ? ` (${validation.command})` : ""}`;
    // The last red's triage read it as a flake and GitHub refused the rerun (triage.mjs refusedRerunText): said, with the remedy.
    return { exit: "blocked", reason: validation.triageRefused ? `${red}; ${validation.triageRefused}` : red, cause: "work" };
  }
  if (reviewUnaddressed > 0) return { exit: "blocked", reason: `${reviewUnaddressed} reviewer finding(s) unaddressed after the one pass`, cause: "work" };
  if (record?.exit === "blocked") return workerBlocked(record);
  const open = question !== undefined ? question : record?.exit === "question";
  if (open) return openQuestion(record);
  if (harness && !harness.ok) return { exit: "blocked", reason: harness.error || "harness reported an error", cause: "factory" };
  return { exit: "delivered", reason: "" };
}

export const EXITS = ["delivered", "question", "blocked"];

/** Whether a job's dollar cap is spent: max_usd set and the runs so far at or past it (no cap when max_usd is 0). */
export const capReached = (maxUsd, records) => maxUsd > 0 && sumSpend(records) >= maxUsd;

/**
 * Whether Factory's max_usd was in fact reached, not only a pass ended over budget for another cause (the gateway relay
 * shut, gateway-relay.mjs): the spend at the cap, the relay's refusal at it (`relayTotals.capped`), or a harness's own cap
 * (Claude Code's error_max_budget_usd, Copilot's start refused under its credit floor).
 */
export const maxUsdReached = (maxUsd, records, relayTotals = null) => capReached(maxUsd, records) || !!relayTotals?.capped || records.some((r) => r?.subtype === "error_max_budget_usd" || r?.error === "dollar cap reached");

/** The exit line's dollars: the figure, else "unmetered" with why (its basis), so no reader takes it for a missing price. */
export const usdText = (usage) => (typeof usage?.usd === "number" ? `${usage.usd}${usage.workerKeyUsd > 0 ? ` (harness ${usage.harnessUsd ?? "unmetered"}, worker key ${usage.workerKeyUsd})` : ""}` : `unmetered${/^unmetered: ./.test(usage?.basis || "") ? ` (${usage.basis.slice("unmetered: ".length)})` : ""}`);

/** Copilot's own units beside the dollars on the progress line: "; 3 premium requests, 41.2 AI credits"; "" for others. */
export function copilotCount(usage) {
  if (typeof usage?.premiumRequests !== "number" && typeof usage?.aiCredits !== "number") return "";
  const parts = [];
  if (typeof usage.premiumRequests === "number") parts.push(`${usage.premiumRequests} premium request${usage.premiumRequests === 1 ? "" : "s"}`);
  if (typeof usage.aiCredits === "number") parts.push(`${usage.aiCredits} AI credits`);
  return `; ${parts.join(", ")}`;
}

/** " (work-1 7.90, validation-fix-1 0.54)": each harness run's cost by its label, for the exit line; empty with one or no priced run. */
export function costByPhase(records) {
  const parts = (records || []).filter((r) => r && typeof r.usd === "number" && r.label).map((r) => `${r.label} ${r.usd.toFixed(2)}`);
  return parts.length > 1 ? ` (${parts.join(", ")})` : "";
}

/**
 * What a running harness is doing, from its own event stream (Claude stream-json, Codex JSONL,
 * Copilot JSON): turns, tool calls, sub-agents started and finished, tokens, the last event's
 * time. Pure: feed(line) per stdout line, snapshot() at any time. The one line this renders is
 * the progress comment's status while the harness runs, so a reader needs no log. Claude and Codex
 * report a resumed session's running total: since(session, prior) names the total it had already
 * reported, so the line shows the pass's own share (as runHarness counts it).
 */
export function harnessActivity(now = () => Date.now()) {
  const s = { startedAt: now(), lastEventAt: null, events: 0, turns: 0, toolCalls: 0, lastTool: null, subagents: new Map(), tokens: { input: 0, output: 0, written: 0 }, usd: null, ended: false, lastText: "" };
  // Each resumed session's prior total; for Codex, the one the current pass's first turn.completed is counted from.
  const priors = new Map();
  let base = null;
  const brief = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const feed = (line) => {
    const t = String(line || "").trim();
    if (!t.startsWith("{")) return;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      return;
    }
    s.events += 1;
    s.lastEventAt = now();
    // Claude
    if (e.type === "assistant" && e.message) {
      if (!e.parent_tool_use_id) s.turns += 1;
      for (const c of e.message.content || []) {
        if (c.type === "tool_use") {
          s.toolCalls += 1;
          s.lastTool = c.name === "Bash" && c.input?.command ? `Bash: ${brief(c.input.command)}` : c.input?.description ? `${c.name}: ${brief(c.input.description)}` : c.name;
        } else if (c.type === "text" && c.text) s.lastText = brief(c.text);
      }
      const u = e.message.usage;
      if (u) {
        s.tokens.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        s.tokens.output += u.output_tokens || 0;
        s.tokens.written += u.cache_creation_input_tokens || 0;
      }
    } else if (e.type === "system" && e.subtype === "task_started" && e.task_id) {
      s.subagents.set(e.task_id, { description: brief(e.description), type: e.subagent_type || e.task_type || "agent", kind: e.task_type === "local_bash" ? "command" : "agent", startedAt: now(), done: false });
    } else if (e.type === "system" && e.subtype === "task_notification" && e.task_id) {
      const a = s.subagents.get(e.task_id);
      if (a) {
        a.done = true;
        a.status = e.status || "completed";
        a.endedAt = now();
      }
    } else if (e.type === "result") {
      s.ended = true;
      // A total below the prior one is not a running total (usage.mjs sinceSession): as reported.
      const prior = priors.get(e.session_id)?.usd;
      if (typeof e.total_cost_usd === "number") s.usd = typeof prior === "number" && e.total_cost_usd >= prior ? e.total_cost_usd - prior : e.total_cost_usd;
    }
    // Codex: input_tokens already includes the cached and written parts and output_tokens the reasoning part.
    else if (e.type === "thread.started") base = priors.get(e.thread_id) ?? null;
    else if (e.type === "turn.started") s.turns += 1;
    else if (e.type === "turn.completed" && e.usage) {
      s.tokens.input += Math.max(0, (e.usage.input_tokens || 0) - (base?.input ?? 0));
      s.tokens.output += Math.max(0, (e.usage.output_tokens || 0) - (base?.output ?? 0));
      s.tokens.written += Math.max(0, (e.usage.cache_write_input_tokens || 0) - (base?.written ?? 0));
      base = null;
    } else if (e.type === "item.started" && e.item) {
      s.toolCalls += 1;
      s.lastTool = e.item.type === "command_execution" && e.item.command ? `command: ${brief(e.item.command)}` : e.item.type || "item";
    } else if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) s.lastText = brief(e.item.text);
  };
  const snapshot = () => {
    const t = now();
    const all = [...s.subagents.values()];
    const active = all.filter((a) => !a.done && a.kind !== "command").map((a) => ({ ...a, minutes: Math.round((t - a.startedAt) / 60000) }));
    const done = all.filter((a) => a.done && a.kind !== "command").length;
    const commands = all.filter((a) => !a.done && a.kind === "command").length;
    return { elapsedMin: Math.round((t - s.startedAt) / 60000), idleMin: s.lastEventAt ? Math.round((t - s.lastEventAt) / 60000) : null, events: s.events, turns: s.turns, toolCalls: s.toolCalls, lastTool: s.lastTool, lastText: s.lastText, subagentsActive: active, subagentsDone: done, backgroundCommands: commands, tokens: { ...s.tokens }, usd: s.usd, ended: s.ended };
  };
  const since = (thread, prior) => {
    if (thread && prior) priors.set(thread, { input: prior.tokens?.input ?? 0, output: prior.tokens?.output ?? 0, written: prior.tokens?.written ?? 0, usd: prior.usd ?? null });
  };
  return { feed, snapshot, since };
}

/** The status line for a running or finished harness, from a snapshot. */
export function activityLine(snap, { harness = "harness", model = null, label = "working" } = {}) {
  const who = `${harness}${model ? ` (${model})` : ""}`;
  if (!snap.events) return `${who} started ${snap.elapsedMin} min ago; no event from it yet`;
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const agents = snap.subagentsActive.length ? `; sub-agents ${snap.subagentsActive.length} active (${snap.subagentsActive.map((a) => `${a.type}: ${a.description || "?"}, ${a.minutes} min`).join("; ")})${snap.subagentsDone ? `, ${snap.subagentsDone} done` : ""}` : snap.subagentsDone ? `; sub-agents ${snap.subagentsDone} done` : "";
  const bg = snap.backgroundCommands ? `; ${snap.backgroundCommands} background command${snap.backgroundCommands > 1 ? "s" : ""} running` : "";
  const last = snap.ended ? "ended" : snap.idleMin === null ? "" : snap.idleMin === 0 ? "active now" : `last event ${snap.idleMin} min ago`;
  const cost = snap.usd !== null ? `, $${snap.usd.toFixed(2)}` : "";
  return `${who} ${snap.ended ? "finished" : label}: ${snap.elapsedMin} min, ${snap.turns} turns, ${snap.toolCalls} tool calls${agents}${bg}; ${last}; ${k(snap.tokens.input)} tokens in, ${k(snap.tokens.output)} out${cost}${snap.lastTool ? `; last tool ${snap.lastTool}` : ""}`;
}

/**
 * Required checks on a head, from the check-runs GitHub lists for it:
 *   { done, green, missing: [name], failed: [{name, conclusion, id}], pending: [name] }
 * Only the latest run of each name counts (a re-run supersedes). A check with no run yet is
 * missing, not red: the caller decides how long to wait for it.
 */
export function evaluateChecks(names, checkRuns) {
  const latest = new Map();
  for (const r of checkRuns || []) {
    const have = latest.get(r.name);
    if (!have || String(r.started_at || "") > String(have.started_at || "") || (r.id ?? 0) > (have.id ?? 0)) latest.set(r.name, r);
  }
  const out = { done: true, green: true, missing: [], failed: [], pending: [] };
  for (const name of names) {
    const r = latest.get(name);
    if (!r) {
      out.missing.push(name);
      out.done = false;
      continue;
    }
    if (r.status !== "completed") {
      out.pending.push(name);
      out.done = false;
      continue;
    }
    if (!["success", "neutral", "skipped"].includes(r.conclusion)) out.failed.push({ name, conclusion: r.conclusion, id: r.id });
  }
  if (out.failed.length) out.green = false;
  if (!out.done) out.green = false;
  return out;
}

/**
 * The harness's exit record: the first JSON object in `text` (a file the task card names, or
 * the harness's answer to EXIT_PROMPT) with `exit` in EXITS. `questions` and `reason` are
 * normalized to strings; a blocked record's `deniedHosts` keeps host names only (deniedHostsOf), its `missingSecrets`
 * environment variable names only (worker-secrets.mjs missingSecretsOf). Null when there is
 * no such object: the caller then asks the harness.
 */
export function parseExitRecord(text) {
  const s = String(text || "");
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < s.length; i += 1) {
      const c = s[i];
      if (inString) {
        if (c === "\\") i += 1;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          let v;
          try {
            v = JSON.parse(s.slice(start, i + 1));
          } catch {
            break;
          }
          if (v && typeof v === "object" && EXITS.includes(v.exit)) {
            const text = (q) => (typeof q === "string" ? q : q?.question ?? q?.item ?? JSON.stringify(q));
            const items = (Array.isArray(v.questions) ? v.questions : []).filter((q) => text(q));
            const questions = items.map(text);
            // A split Objective's part: the items left for the next PR (implement-split). `part.remaining: []` says this
            // is the last part; no `part` at all says nothing, and the part Factory recorded stands.
            const part = Array.isArray(v.part?.remaining) ? { remaining: v.part.remaining.map(text).filter(Boolean) } : null;
            // A question exit's questions that name no test of the Question rule (questionFounded); none at all is one.
            const unfounded = v.exit === "question" ? (items.length ? items.filter((q) => !questionFounded(q)).map(text) : [typeof v.reason === "string" && v.reason ? v.reason : "a question exit with no question"]) : [];
            // A Block's hosts the sandbox denied (deniedHostsOf: host names only), which the Blocked notice names.
            const deniedHosts = v.exit === "blocked" ? deniedHostsOf(v.deniedHosts) : [];
            // A Block's variables the worker's shell lacked (missingSecretsOf: names only), which the notice names.
            const missingSecrets = v.exit === "blocked" ? missingSecretsOf(v.missingSecrets) : [];
            return { exit: v.exit, reason: typeof v.reason === "string" ? v.reason : "", questions, ...(part ? { part } : {}), ...(unfounded.length ? { unfounded } : {}), ...(deniedHosts.length ? { deniedHosts } : {}), ...(missingSecrets.length ? { missingSecrets } : {}) };
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * The three tests of objective-plan's Question rule: the choice changes or removes an existing public contract (a use
 * that works on the base commit breaks or behaves differently), contradicts a decision recorded in the issue, or grants
 * new access (a permission, a credential, a newly exposed service). Any other addition that leaves every existing use
 * working, and a reversible choice the issue leaves open, meet none.
 */
export const QUESTION_TESTS = ["contract", "decision", "access"];

/** One exit-record question in the shape QUESTION_SHAPE names: a test from QUESTION_TESTS and what it changes. */
export const questionFounded = (q) =>
  !!q && typeof q === "object" && QUESTION_TESTS.includes(q.test) && typeof q.existing === "string" && q.existing.trim().length > 0 && typeof q.question === "string" && q.question.trim().length > 0;

const QUESTION_SHAPE = '{"question": "the question a human must answer, verbatim", "test": "contract" | "decision" | "access", "existing": "the existing contract it changes or removes, the recorded decision it contradicts, or the access it grants"}';

/** What Factory asks a harness that left no exit record (resumed in its own session where it can). */
export const EXIT_PROMPT = `Reply with only one JSON object and nothing else: {"exit": "delivered" | "question" | "blocked", "questions": [${QUESTION_SHAPE}], "reason": "why you are blocked, else empty", "deniedHosts": ["each host the sandbox denied that blocked you"], "missingSecrets": ["each environment variable your shell lacked that blocked you"], "part": {"remaining": ["each checklist item left for the next PR"]}}. "question" means an assumption in your plan still needs a human decision; "blocked" means you stopped short of the acceptance; otherwise "delivered". Leave out "deniedHosts" unless the sandbox denying a host is why you are blocked, "missingSecrets" unless a secret or API key missing from your shell is, and "part" unless you split the Objective and items remain for a later PR.`;

/** The questions of a question exit that already name a test of the Question rule: they stand whatever the check says. */
export const standingQuestions = (record) => (record?.questions || []).filter((q) => !(record.unfounded || []).includes(q));

/**
 * What Factory asks a harness whose question exit names no test for some questions (parseExitRecord `unfounded`),
 * once, resumed in its own session where it can: keep each that meets a test, record the rest as assumptions. The
 * record's questions that already name a test (standingQuestions) are listed as staying. With `file`, the session
 * that runs `factory deliver` itself writes the new record to exit.json and runs deliver again.
 */
export function questionCheckPrompt(record, { file = false } = {}) {
  const line = (q, i) => `${i + 1}. ${String(q).replace(/\s+/g, " ").slice(0, 500)}`;
  const list = (record.unfounded || []).map(line).join("\n");
  const standing = standingQuestions(record);
  const stays = standing.length ? `\n\nThese questions already name a test and stay in the record as raised; keep their QUESTION: markers and include each unchanged in "questions":\n${standing.map(line).join("\n")}` : "";
  return `Your exit record raises a Question without naming which test of the Question rule it meets:\n${list}${stays}\n\nA Question stands only when the choice changes or removes an existing public contract, so that a use that works on the base commit breaks or behaves differently ("contract"), contradicts a decision recorded in the issue ("decision"), or grants new access: a permission, a credential, a service reachable from outside that was not ("access"). Any other addition that leaves every existing use working (a new command, endpoint, export, file or optional field) is an assumption, and so is a reversible choice the issue leaves open. For each question in the first list: if it meets a test, keep it and name the existing contract, the decision or the access; otherwise drop its QUESTION: marker in $FACTORY_OUT/pr.md and $FACTORY_OUT/plan.md, so it reads as a recorded assumption. Change no code${file ? "" : " and run nothing else"}. Then ${file ? "write $FACTORY_OUT/exit.json as" : "reply with"} only one JSON object and nothing else: {"exit": "delivered" | "question", "questions": [${QUESTION_SHAPE}], "reason": ""}, "delivered" only when no question is left${standing.length ? ' (the questions that stay make it "question")' : ""}.`;
}

/**
 * The exit record after the question check: `again` is the check's parsed answer. Null when the answer is not a
 * delivered or question record, so the Question stands as raised. Questions that already named a test stay whatever
 * the answer says, so a check that answers "delivered" never drops a founded Question; a split part the answer leaves
 * out carries over from the record.
 */
export function mergeChecked(record, again) {
  if (!again || !["delivered", "question"].includes(again.exit)) return null;
  const standing = standingQuestions(record);
  const questions = [...new Set([...standing, ...(again.questions || [])])];
  const exit = standing.length || again.exit === "question" ? "question" : "delivered";
  const part = again.part || record.part;
  const unfounded = exit === "question" ? (again.unfounded || []).filter((q) => questions.includes(q)) : [];
  return { exit, reason: again.reason || "", questions, ...(part ? { part } : {}), ...(unfounded.length ? { unfounded } : {}) };
}

/** Factory's own line comment when a review pass has nothing line-tied to say; the worker never answers it. */
export const PLACEHOLDER_MARKER = "<!-- factory:placeholder -->";
export const isPlaceholder = (body) => String(body || "").includes(PLACEHOLDER_MARKER);

// -------------------------------------------------------------- review diff

/** The right-side line numbers a unified diff touches, per file: {path: Set(lines)} and first changed line. */
export function diffLines(diff) {
  const files = {};
  let path = null;
  let line = 0;
  let inHeader = false; // between `diff --git` and the first hunk: `---`/`+++` are file names, not content
  for (const raw of String(diff || "").split("\n")) {
    if (raw.startsWith("diff ")) {
      inHeader = true;
      continue;
    }
    if (inHeader && raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "").trim();
      path = p === "/dev/null" ? null : p;
      if (path) files[path] ??= { lines: new Set(), first: null };
      continue;
    }
    if (inHeader && (raw.startsWith("--- ") || raw.startsWith("index ") || /^(new|deleted) file mode|^similarity|^rename|^old mode|^new mode|^Binary/.test(raw))) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHeader = false;
      line = Number(hunk[1]);
      continue;
    }
    if (!path) continue;
    if (raw.startsWith("+")) {
      files[path].lines.add(line);
      if (files[path].first === null) files[path].first = line;
      line += 1;
    } else if (raw.startsWith("-")) {
      // removed line: no right-side number
    } else if (raw.startsWith(" ")) {
      files[path].lines.add(line);
      line += 1;
    }
    // anything else ("\ No newline", "new file mode", "similarity index", "") is metadata
  }
  return files;
}

/** A path or line as review text shows it: on one line, no backtick to break the code span. */
const shownPath = (p) => String(p ?? "").replace(/[`\r\n]/g, "'");
const findingAt = (path, line) => (path ? `\`${shownPath(path)}\`${Number.isInteger(line) ? ` line ${line}` : ""}` : "the PR as a whole (no file named)");

/**
 * Place each comment on a line GitHub takes. `shown` maps each path that takes comments to {lines (Set), first}, in
 * the diff's order. A comment on a line its file shows stays; one on its file elsewhere moves to the file's first line;
 * one on a file that takes none moves to the first file (the same line when that file shows it, else its first). A
 * moved comment starts with a note naming the file and line the finding is about and `why` it moved, and carries them
 * and its own text as `at`, so a second fitting keeps that note and a review body sets the finding out without it.
 * Factory's placeholder moves without a note. Returns {inline, aside: those with nowhere to go}.
 */
function fitComments(comments, shown, why) {
  const paths = [...shown.keys()];
  const inline = [];
  const aside = [];
  for (const c of comments || []) {
    const line = Number(c?.line);
    if (shown.get(c?.path)?.lines.has(line)) {
      inline.push(c);
      continue;
    }
    if (!paths.length) {
      aside.push(c);
      continue;
    }
    const path = shown.has(c?.path) ? c.path : paths[0];
    const to = shown.get(path);
    const placed = { ...c, path, line: path !== c?.path && to.lines.has(line) ? line : to.first };
    if (!c.at && !isPlaceholder(c.body)) {
      placed.at = { path: c.path, line: Number.isInteger(line) && line > 0 ? line : null, body: c.body };
      placed.body = `**Finding on ${findingAt(c.path, placed.at.line)}**, ${why}, so it is placed here:\n\n${c.body}`;
    }
    inline.push(placed);
  }
  return { inline, aside };
}

/** The right-side lines each file shows, from [path, diffLines entry] pairs in order: context lines take comments as added ones do. */
function shownFiles(entries) {
  const shown = new Map();
  for (const [path, v] of entries) if (v?.lines.size) shown.set(path, { lines: v.lines, first: v.first ?? Math.min(...v.lines) });
  return shown;
}

/**
 * Fit reviewer findings to the diff: a comment on a line the diff does not show moves to the file's first changed
 * line (or its first shown line, when it only deletes); a comment on a file outside the diff moves to the first shown
 * file. A moved comment starts with a note naming the file and line the finding is about (`at`). When the diff shows
 * no line at all (it only deletes), the findings come back unplaced, each with its own path and line: postReview sets
 * them out in the review body, where they count until answered. Returns the comments.
 */
export function snapComments(findings, diff) {
  const shown = shownFiles(Object.entries(diffLines(diff)));
  const first = shown.keys().next().value ?? null;
  const clean = [];
  for (const f of findings || []) {
    if (!f || typeof f.body !== "string" || !f.body.trim()) continue;
    // A finding with no path names no place to point at: it goes to the first shown line as it is.
    const path = typeof f.path === "string" ? f.path.replace(/^\.\//, "") : null;
    if (!first) clean.push({ path, line: Number.isInteger(Number(f.line)) && Number(f.line) > 0 ? Number(f.line) : null, side: "RIGHT", body: f.body.trim() });
    else clean.push({ path: path ?? first, line: path ? f.line : shown.get(first).first, side: "RIGHT", body: f.body.trim() });
  }
  return first ? fitComments(clean, shown, "which this PR's diff does not show").inline : clean;
}

/**
 * Fit `comments` to the lines GitHub takes comments on, by the PR's file listing (`files`, its files API): a file listed
 * with a patch, on a line that patch shows on the new side. GitHub refuses a whole review (422) for one comment on a
 * file it lists without a patch ("diff is too large") or on a line outside the patch ("Line could not be resolved"),
 * and a file past the listing is not known to take one. Each such comment moves as snapComments moves one (to the same
 * file's first line when it has a patch, else the first file's), with the note naming where the finding is. Returns
 * {inline, moved (how many of inline moved), aside (no file in the listing takes a comment: these go in the body)}.
 */
export function fitToFiles(comments, files) {
  const listed = [];
  for (const f of files || []) {
    if (typeof f?.filename !== "string" || typeof f.patch !== "string" || !f.patch) continue;
    const d = diffLines(`diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`)[f.filename];
    if (d) listed.push([f.filename, d]);
  }
  const { inline, aside } = fitComments(comments, shownFiles(listed), "where GitHub takes no line comment");
  const kept = new Set(comments || []);
  return { inline, moved: inline.filter((c) => !kept.has(c)).length, aside };
}

/** A comment as GitHub's review API takes it (Factory's own fields, such as `at`, left off). */
export const reviewComment = (c) => ({ path: c.path, line: c.line, side: c.side || "RIGHT", body: c.body });

/** The most of a review body Factory writes in full (GitHub refuses one over 65,536 characters). */
export const REVIEW_BODY_MAX = 60_000;

/** The marker before each finding Factory sets out in a review body: its number, file and line, as JSON. */
const FINDING = /^<!-- factory:finding (\{[^\n]*\}) -->$/;
const markerJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * A review's body with the comments that cannot be line comments set out under it, each under its file and line and
 * after a marker (bodyFindings reads them back, so the answer pass gets them and they count until answered). A `<!--`
 * in a comment is escaped so no text in the body reads as a marker. Past `max`, a finding keeps its marker and place
 * but not its text; past `hard`, the rest are one marker that says how many were cut, itself a finding to answer.
 * Factory's placeholder goes in as plain text: it is no finding.
 */
export function reviewBody(body, comments, max = REVIEW_BODY_MAX, hard = max + 5_000) {
  // Factory's placeholder is no finding: its text goes in as it is, with nothing to answer.
  const aside = (comments || []).filter((c) => !isPlaceholder(c?.body));
  const head = `${String(body ?? "")}${(comments || []).filter((c) => isPlaceholder(c?.body)).map((c) => `\n\n${String(c.body).replace(PLACEHOLDER_MARKER, "").trim()}`).join("")}`;
  if (!aside.length) return head;
  let out = `${head}\n\n${aside.length} finding(s) GitHub cannot take as a line comment (it shows no patch for the file, or not that line), so they are here:`;
  for (let i = 0; i < aside.length; i += 1) {
    const c = aside[i];
    const at = c?.at || { path: c?.path, line: Number.isInteger(c?.line) ? c.line : null };
    const top = `\n\n<!-- factory:finding ${markerJson({ n: i + 1, path: String(at.path ?? ""), line: at.line })} -->\n**${findingAt(at.path, at.line)}**\n\n`;
    const full = `${top}${String(c?.at?.body ?? c?.body ?? "").replace(/<!--/g, "&lt;!--")}`;
    const short = `${top}(This finding's text is cut: past GitHub's size limit for a review body.)`;
    if (out.length + full.length <= max) out += full;
    else if (out.length + short.length <= hard) out += short;
    else {
      out += `\n\n<!-- factory:finding ${markerJson({ n: i + 1, cut: aside.length - i })} -->\n(${aside.length - i} more finding(s) are cut: past GitHub's size limit for a review body)`;
      break;
    }
  }
  return out;
}

/** The id of a finding in a review body, as the answer pass and its reply marker name it. */
export const bodyFindingId = (reviewId, n) => `r${reviewId}-${n}`;
export const isBodyFindingId = (id) => typeof id === "string" && /^r\d+-\d+$/.test(id);

/**
 * The findings Factory set out in a review body (reviewBody), in order: {n, path, line, body}; a cut tail is one finding
 * whose `cut` says how many it stands for. Read only from a review Factory trusts as its own.
 */
export function bodyFindings(body) {
  const out = [];
  let cur = null;
  for (const raw of String(body ?? "").split("\n")) {
    const m = FINDING.exec(raw);
    if (m) {
      let v = null;
      try {
        v = JSON.parse(m[1]);
      } catch {
        // not Factory's marker shape: read as text of the finding before it
      }
      if (v && Number.isInteger(v.n) && v.n > 0) {
        cur = { n: v.n, path: typeof v.path === "string" ? v.path : null, line: Number.isInteger(v.line) ? v.line : null, ...(Number.isInteger(v.cut) ? { cut: v.cut } : {}), lines: [] };
        out.push(cur);
        continue;
      }
    }
    if (cur) cur.lines.push(raw);
  }
  return out.map(({ lines, ...f }) => ({ ...f, body: lines.join("\n").trim() }));
}

/**
 * A patch's hunks as git (and GitHub's diff media type) cut them: three lines of context around each change, and two
 * hunks only where their context meets. The files API's patches join hunks a little further apart, which would show
 * (and take comments on) lines GitHub's diff does not.
 */
export function gitHunks(patch, context = 3) {
  const out = [];
  const lines = String(patch).split("\n");
  for (let i = 0; i < lines.length; ) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[i]);
    if (!h) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    // The hunk's body, each line with its old and new numbers ("\ No newline" rides with the line before it).
    const body = [];
    // A side with no lines names the line before it (-0,0 for a new file): its next line is one on.
    let [o, n] = [Number(h[1]) + (h[2] === "0" ? 1 : 0), Number(h[3]) + (h[4] === "0" ? 1 : 0)];
    for (i += 1; i < lines.length && !lines[i].startsWith("@@ "); i += 1) {
      const l = lines[i];
      if (l.startsWith("\\") && body.length) {
        body.at(-1).tail.push(l);
        continue;
      }
      const kind = l[0] === "+" || l[0] === "-" ? l[0] : " ";
      body.push({ l, kind, o, n, tail: [] });
      if (kind !== "+") o += 1;
      if (kind !== "-") n += 1;
    }
    // A line is shown when a change is at most `context` lines from it (one pass each way).
    const near = body.map(() => Infinity);
    for (let k = 0, last = -Infinity; k < body.length; k += 1) {
      if (body[k].kind !== " ") last = k;
      near[k] = k - last;
    }
    for (let k = body.length - 1, next = Infinity; k >= 0; k -= 1) {
      if (body[k].kind !== " ") next = k;
      near[k] = Math.min(near[k], next - k);
    }
    const keep = near.map((d) => d <= context);
    let first = true;
    for (let k = 0; k < body.length; ) {
      if (!keep[k]) {
        k += 1;
        continue;
      }
      let e = k;
      while (e < body.length && keep[e]) e += 1;
      const part = body.slice(k, e);
      const olds = part.filter((b) => b.kind !== "+").length;
      const news = part.filter((b) => b.kind !== "-").length;
      const oStart = olds ? part.find((b) => b.kind !== "+").o : part[0].o - 1;
      const nStart = news ? part.find((b) => b.kind !== "-").n : part[0].n - 1;
      out.push(`@@ -${oStart},${olds} +${nStart},${news} @@${first ? h[5] : ""}`);
      for (const b of part) out.push(b.l, ...b.tail);
      first = false;
      k = e;
    }
  }
  return out.join("\n");
}

/**
 * A unified diff made from GitHub's per-file listing (a PR's files or a comparison's), as GitHub's diff media type
 * shows it less the index lines; diffLines and snapComments read it the same. A file listed without a patch (binary,
 * a pure rename, or too large for the API) gets its header and a note in place of hunks, so no comment lands on it.
 */
export function filesDiff(files) {
  const out = [];
  for (const f of files || []) {
    const name = typeof f?.filename === "string" ? f.filename : "";
    if (!name) continue;
    const old = typeof f.previous_filename === "string" && f.previous_filename ? f.previous_filename : name;
    out.push(`diff --git a/${old} b/${name}`);
    if (f.status === "renamed" && old !== name) out.push(`rename from ${old}`, `rename to ${name}`);
    out.push(`--- ${f.status === "added" ? "/dev/null" : `a/${old}`}`, `+++ ${f.status === "removed" ? "/dev/null" : `b/${name}`}`);
    if (typeof f.patch === "string" && f.patch) out.push(gitHunks(f.patch.replace(/\n$/, "")));
    else if (f.changes || f.status !== "renamed") out.push("(GitHub lists this file without a patch: binary, or too large for its API)");
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** The files the API lists with changes but no patch (too large for it): a diff made from them never shows those. */
export const unpatchedFiles = (files) => (files || []).filter((f) => !(typeof f?.patch === "string" && f.patch) && Number(f?.changes) > 0).length;

/** The most of a PR's diff the reviewer's prompt carries (about what GitHub's own diff media type served: 20,000 lines). */
export const REVIEW_DIFF_CAP = 1_000_000;

/**
 * The diff as the reviewer's prompt shows it: whole up to `cap` characters; past that, cut before the first file that
 * does not fit (mid-file only when the first file alone is over), with a line saying how many files are left to read
 * in the checkout. Findings are still fitted to the whole diff.
 */
export function promptDiff(diff, cap = REVIEW_DIFF_CAP) {
  const s = String(diff ?? "");
  if (s.length <= cap) return s;
  const starts = [...s.matchAll(/^diff --git /gm)].map((m) => m.index);
  let cut = starts.filter((i) => i > 0 && i <= cap).at(-1);
  if (cut === undefined) cut = s.lastIndexOf("\n", cap - 1) + 1 || cap;
  const left = starts.filter((i) => i >= cut).length + (starts.includes(cut) ? 0 : 1);
  return `${s.slice(0, cut)}(the diff is cut here at ${cut} of ${s.length} characters; ${left} file(s) are not shown in full: read them in the checkout with \`git diff\` against the base branch)\n`;
}

/** Find the reviewer's JSON findings in free text: a fenced ```json block or a bare {"comments": [...]}. */
export function parseFindings(text) {
  return parseReview(text).comments;
}

/**
 * The reviewer's whole answer: `comments` (line-tied findings) and `acceptance` (one judgment per acceptance entry,
 * {entry, met, path, line, evidence}; null when the answer has no such list), and `parsed`: whether any JSON answer was
 * found. From a fenced ```json block or a bare object.
 */
export function parseReview(text) {
  const s = String(text || "");
  const candidates = [];
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  // A bare object, compact or pretty-printed, up to the last closing brace (prose may follow it).
  const end = s.lastIndexOf("}");
  for (const m of s.matchAll(/\{\s*"(?:acceptance|comments)"/g)) if (m.index < end) candidates.push(s.slice(m.index, end + 1));
  for (const c of candidates.reverse()) {
    try {
      const v = JSON.parse(c.trim());
      if (Array.isArray(v)) return { comments: v, acceptance: null, parsed: true };
      if (v && (Array.isArray(v.comments) || Array.isArray(v.acceptance))) {
        const acceptance = Array.isArray(v.acceptance)
          ? v.acceptance.filter((a) => a && (typeof a.entry === "string" || typeof a.entry === "number") && typeof a.met === "boolean").map((a) => ({ entry: String(a.entry).trim(), met: a.met, path: typeof a.path === "string" ? a.path : null, line: Number.isInteger(a.line) ? a.line : null, evidence: typeof a.evidence === "string" ? a.evidence : "" }))
          : null;
        return { comments: Array.isArray(v.comments) ? v.comments : [], acceptance, parsed: true };
      }
    } catch {
      // try the next candidate
    }
  }
  return { comments: [], acceptance: null, parsed: false };
}

/** An entry id as written ("acceptance B", "**B**", "b.") reduced to its key ("B"), for matching judgments to entries; inner dots stay ("1.2" is not "12"). */
export const entryKey = (id) =>
  String(id ?? "")
    .replace(/^\s*(?:acceptance|entry|criterion)\s+/i, "")
    .replace(/[*_`()\s]/g, "")
    .replace(/[:.]+$/, "")
    .toUpperCase();

const ACCEPTANCE_HEADING = /\b(?:acceptance|must be true|done when|definition of done|criteria)\b/i;

/**
 * The acceptance entries an issue states, so the reviewer judges each one: the top-level list items under a heading
 * (Markdown `#`, or a line that is only bold text) naming acceptance ("Acceptance", "What must be true", "Done when",
 * "Definition of done", "criteria"). Each is {id, text}: the id is the item's own label ("- **B:** ..." is B) or else its
 * 1-based position; nested items and continuation lines join their entry's text. [] when the issue has no such section;
 * the reviewer then names the entries from the issue text itself.
 */
export function acceptanceEntries(body) {
  const entries = [];
  let inSection = false;
  let current = null;
  let fence = false;
  for (const raw of String(body || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw) || /^\s{0,3}\*\*([^*]+)\*\*:?\s*$/.exec(raw);
    if (heading) {
      inSection = ACCEPTANCE_HEADING.test(heading[1]);
      current = null;
      continue;
    }
    if (!inSection) continue;
    const item = /^\s{0,1}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(raw);
    if (item) {
      const label = /^\*\*([A-Za-z0-9]{1,3})[:.)]?\*\*:?\s*|^([A-Z]|\d{1,2})[:.)]\s+/.exec(item[1]);
      current = { id: label ? label[1] || label[2] : null, text: item[1].trim() };
      entries.push(current);
    } else if (current && raw.trim()) {
      current.text += ` ${raw.trim()}`;
    } else if (!raw.trim()) {
      current = null;
    }
  }
  const seen = new Set();
  return entries.map((e, i) => {
    let id = e.id ?? String(i + 1);
    if (seen.has(entryKey(id))) id = String(i + 1);
    seen.add(entryKey(id));
    return { id, text: e.text };
  });
}

// ------------------------------------------------------- no-queue fallback

/**
 * The dispatcher's decision for an In-review PR (its review pass is done) that cannot merge:
 *  - with a merge queue, a conflicting PR ("dirty") is evicted by the queue; a PR merely behind
 *    is the queue's own job and is left alone;
 *  - without a queue, strict required checks refuse a PR that is behind or conflicting and
 *    nothing updates it.
 * A PR merely behind without a queue is "update": GitHub merges the default branch into it in
 * one API call (no runner, no model) and its checks re-run; only a conflicting PR needs a worker.
 * "rebase" sends it back to a worker job once; "blocked" is the second time (integration failed
 * twice); "ignore" covers drafts, clean and unknown states.
 */
export function staleDecision({ pr, rebaseMarkers = 0, queue = false, reviewing = false, reviewRunning = false }) {
  if (!pr || pr.draft) return "ignore";
  // A review job is running on it (the label comes off at that job's exit): its answer pass may
  // push and its own validation decides; a send-back now would race it (two jobs on one branch).
  // A conflicting PR fires no new pull_request run, but a review job that began before a sibling's merge made it
  // conflict is still running: only when none is (reviewRunning, from the live jobs) does it go back for the rebase.
  if (reviewing && (pr.mergeable_state !== "dirty" || reviewRunning)) return "ignore";
  const stale = queue ? pr.mergeable_state === "dirty" : ["behind", "dirty"].includes(pr.mergeable_state);
  if (!stale) return "ignore";
  if (!queue && pr.mergeable_state === "behind") return "update";
  return rebaseMarkers >= 1 ? "blocked" : "rebase";
}

/**
 * Whether the PR conflicts with its base at `sha`, the head this stage pushed. GitHub builds no merge ref for a
 * conflicting PR, so no `pull_request` run starts and its required checks never report. Only a read of that head
 * counts: right after a push GitHub may still answer for the one before it.
 */
export function conflictsAt(pr, sha) {
  return !!pr && !!sha && pr.head?.sha === sha && pr.mergeable_state === "dirty";
}

/** Times one reviewed PR is put in the merge queue: the first enqueue and one more after the queue drops it. */
export const QUEUE_TRIES = 2;
/** How long a merge queue commit may wait with no CI begun on it (gateStarted) before Factory reads it as stalled (#295). */
export const QUEUE_STALL_MS = 10 * 60_000;
/** The code Factory gives a stalled queue entry it took out itself: GitHub started no check on the queue's commit. */
export const STALL_CODE = "checks_never_started";
/** The code Factory gives a queue entry it took out because a required check started and did not finish in time (#2683). */
export const HUNG_CODE = "checks_hung";
/** The merge queue's check timeout setup writes (github.mjs ensureRuleset), assumed when the ruleset is unread. */
export const SETUP_QUEUE_TIMEOUT_MIN = 60;
/** The shortest fallback bound for a running required check on a queue commit, whatever the queue's own timeout. */
export const QUEUE_HUNG_FLOOR_MS = 20 * 60_000;

/**
 * The fallback bound for a running required check on a queue commit (#2683), used where its progress cannot be judged
 * (a step with no history, a check that is no Actions job): the later of half the merge queue's check timeout
 * (`check_response_timeout_minutes`) and 10 minutes before it, never under QUEUE_HUNG_FLOOR_MS; SETUP_QUEUE_TIMEOUT_MIN's
 * when the timeout is unread. At 60 that is 50 minutes, counted from the job's own start.
 */
export function queueHungMs(timeoutMinutes) {
  const t = Number(timeoutMinutes);
  const m = Number.isFinite(t) && t > 0 ? t : SETUP_QUEUE_TIMEOUT_MIN;
  return Math.max(QUEUE_HUNG_FLOOR_MS, Math.round((m * 60_000) / 2), (m - 10) * 60_000);
}
/** The fallback bound when the queue's timeout is unread (50 minutes). */
export const QUEUE_HUNG_MS = queueHungMs(null);

/**
 * The margin over a step's normal duration: a step is stalled only past max(3 x its baseline, its baseline + this), so
 * never under this, whatever its history (a warm-cache baseline is too tight for an install or a build).
 */
export const STEP_STALL_FLOOR_MS = 15 * 60_000;

/** How long a step with normal duration `baselineMs` may run before it is stalled: max(3 x it, it + 15 min). */
export const stepStallMs = (baselineMs) => Math.max(3 * baselineMs, baselineMs + STEP_STALL_FLOOR_MS);
/** How many recent green runs of the workflow give a step's normal duration. */
export const STEP_BASELINE_RUNS = 15;

/** A step's normal duration: the longest of its recent green durations (ms), or null with none. */
export function stepBaselineMs(durations) {
  const d = (durations || []).filter((x) => Number.isFinite(x) && x >= 0);
  return d.length ? Math.max(...d) : null;
}

/**
 * Where a running Actions job is (`actions/jobs/{id}`): `{step, since}` for the step running now and its start, or
 * `{step: null, since}` between steps (the last step's start or end). Null for a job that is not running yet (queued or
 * waiting for a runner), has no steps yet, or is done: such a job is never stalled. Progress is a step completing or a
 * new step starting; the job's log is not read.
 */
export function jobPosition(job) {
  if (!job || job.status !== "in_progress") return null;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (!steps.length) return null;
  const cur = steps.find((x) => x?.status === "in_progress");
  // A running step with no start time has `since` NaN: jobStall then judges the job by the fallback bound.
  if (cur) return { step: String(cur.name ?? ""), since: Date.parse(cur.started_at) };
  const times = steps.flatMap((x) => [x?.completed_at, x?.started_at]).map((t) => Date.parse(t)).filter(Number.isFinite);
  return { step: null, since: times.length ? Math.max(...times) : Date.parse(job.started_at) };
}

/**
 * Whether a running Actions job needs its step's baseline read: only once the step could be stalled by it (past
 * STEP_STALL_FLOOR_MS, the least stepStallMs gives) or the job is past the fallback bound, so a healthy queue reads no
 * history. A step with no start time needs none: the fallback judges it.
 */
export function needsBaseline(job, { fallbackMs = QUEUE_HUNG_MS, now = Date.now() }) {
  const pos = jobPosition(job);
  if (!pos?.step || !Number.isFinite(pos.since)) return false;
  return now - pos.since > STEP_STALL_FLOOR_MS || now - Date.parse(job.started_at) > fallbackMs;
}

/**
 * Whether a running Actions job is stalled (#2683): its current step has run past stepStallMs(`baselineMs`), that is
 * max(3 x the step's normal duration, it + 15 min), the normal duration from the workflow's recent green runs. With no
 * baseline (a new step, no history) the job is stalled once `fallbackMs` (queueHungMs) has passed since the job's own
 * start; between steps, once it has passed since the last step's progress. A step or job whose start GitHub does not
 * give is judged by the fallback from the check run's start (`checkStartedAt`), then the job's: never left unjudged.
 * Returns `{name, step, elapsedMs, baselineMs}` or null; a job not running yet is never stalled.
 */
export function jobStall(job, { baselineMs = null, fallbackMs = QUEUE_HUNG_MS, now = Date.now(), checkStartedAt = null }) {
  const pos = jobPosition(job);
  if (!pos) return null;
  const name = String(job.name ?? "");
  if (!Number.isFinite(pos.since)) {
    const from = [checkStartedAt, job.started_at].map((t) => Date.parse(t)).find(Number.isFinite);
    if (!Number.isFinite(from)) return null;
    return now - from > fallbackMs ? { name, step: pos.step, elapsedMs: now - from, baselineMs: null } : null;
  }
  const elapsed = now - pos.since;
  if (pos.step && Number.isFinite(baselineMs) && baselineMs >= 0) return elapsed > stepStallMs(baselineMs) ? { name, step: pos.step, elapsedMs: elapsed, baselineMs } : null;
  const from = pos.step ? [job.started_at, checkStartedAt].map((t) => Date.parse(t)).find(Number.isFinite) : pos.since;
  const total = now - (Number.isFinite(from) ? from : pos.since);
  return total > fallbackMs ? { name, step: pos.step, elapsedMs: pos.step ? elapsed : total, baselineMs: null } : null;
}

/** The key a step's baseline is kept under: its workflow's name, its job's (an actions/jobs record) and its own. */
export const stepKey = (job, stepName) => `${job?.workflow_name ?? ""}\u0000${job?.name ?? ""}\u0000${stepName}`;

/**
 * The running check runs on a queue commit whose progress decides a hang: each required check in progress, and, when a
 * required check has no run at all (an aggregate job behind `needs:`), every Actions run in progress there (its
 * upstream jobs). `checks` are `{id, name, status, started_at, app}`; `names` the required ones (every one when empty).
 */
export function queueTargets(names, checks) {
  const latest = new Map();
  for (const c of checks || []) {
    const have = latest.get(c?.name);
    if (!have || String(c.started_at || "") > String(have.started_at || "") || (c.id ?? 0) > (have.id ?? 0)) latest.set(c?.name, c);
  }
  const want = names?.length ? [...new Set(names)] : [...latest.keys()];
  const missing = want.filter((n) => !latest.has(n));
  const running = (c) => c?.status === "in_progress";
  const targets = want.map((n) => latest.get(n)).filter(running);
  if (missing.length) for (const c of latest.values()) if (running(c) && c.app === ACTIONS_APP_ID && !targets.includes(c)) targets.push(c);
  return { latest, missing, targets };
}

/**
 * The hung required checks on a queue commit (#2683), from progress, not only time: each target (queueTargets) that is
 * an Actions job read from `jobs` (id -> actions/jobs record) is hung by jobStall, its step's baseline from `baselines`
 * (stepKey -> ms); one that is no Actions job, or whose job is unread (no Actions read, as on the local route), once
 * `hungMs` has passed since its own start. A
 * check queued or waiting for a runner never is. A required check with no run at all, and nothing in progress or
 * waiting there, is hung once `hungMs` has passed since CI first started on the commit (`headAt` when nothing has).
 * Returns `[{name, step, elapsedMs, baselineMs}]`. Decided on statuses, names and times only.
 */
export function queueHangs({ names, checks, jobs = new Map(), baselines = new Map(), headAt, now = Date.now(), hungMs = QUEUE_HUNG_MS }) {
  const { latest, missing, targets } = queueTargets(names, checks);
  const out = [];
  for (const t of targets) {
    const job = jobs.get(t.id);
    if (job) {
      const pos = jobPosition(job);
      const stall = jobStall(job, { baselineMs: pos?.step ? (baselines.get(stepKey(job, pos.step)) ?? null) : null, fallbackMs: hungMs, now, checkStartedAt: t.started_at });
      if (stall) out.push({ ...stall, name: String(t.name) });
      continue;
    }
    const since = Date.parse(t.started_at);
    if (Number.isFinite(since) && now - since > hungMs) out.push({ name: String(t.name), step: null, elapsedMs: now - since, baselineMs: null });
  }
  const all = [...latest.values()];
  const busy = all.some((c) => c.status !== "completed");
  const starts = all.map((c) => Date.parse(c.started_at)).filter(Number.isFinite);
  const first = starts.length ? Math.min(...starts) : Date.parse(headAt);
  if (!busy && Number.isFinite(first) && now - first > hungMs) for (const n of missing) out.push({ name: String(n), step: null, elapsedMs: now - first, baselineMs: null });
  return out;
}

const QUEUE_BOT = "github-merge-queue";
const botless = (l) => String(l ?? "").trim().replace(/^@/, "").replace(/\[bot\]$/i, "").toLowerCase();
const queueCode = (c) => (typeof c === "string" && /^[a-z_]{1,40}$/i.test(c) ? c.toLowerCase() : "unknown");

/**
 * From when the merge queue's removals of a PR count (queueRetry's `since`): the latest of `times` (ISO strings or null:
 * the review the merge rests on, the current head's commit, the issue's last re-entry or Block), or null when none is
 * known. A time after `now` is not one GitHub recorded (a commit date can be set by whoever made the commit) and is
 * left out, so it can never put every drop out of count.
 */
export function queueSince(times, now = Date.now()) {
  const known = (times || []).map((t) => [t, Date.parse(t)]).filter(([, ms]) => Number.isFinite(ms) && ms <= now);
  return known.length ? known.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null;
}

/**
 * What the merge pass does with a reviewed, green PR that is not in the merge queue, from GitHub's own record of its
 * removals from the queue (timeline `removed_from_merge_queue` events: `{at, reason, actor, person}`, or `{self: true}`
 * for a removal Factory made this pass that the timeline does not show yet). Only removals after `since` (queueSince:
 * the review the merge rests on, the head's push, the last re-entry or Block) count, and a removal because it merged is
 * none. Who removed it decides what it is:
 * - Factory (`self`, or its App's login): a drop it made of a stalled entry, with its `code` (STALL_CODE or HUNG_CODE:
 *   this pass's own, or the one Factory's requeue record holds for it, session.mjs requeueRecords), else STALL_CODE;
 * - a person's account (`person`: only writers can dequeue): a hold. When the newest removal is a hold, Factory leaves
 *   the PR out (`{hold}`) until a person enqueues it again or a new review, head, re-entry or Block moves `since`;
 * - the queue itself (`github-merge-queue`) or any other bot: a drop, with GitHub's reason code.
 * Under QUEUE_TRIES drops it is enqueued (`{enqueue: true, drops, last}`, `last` the newest drop `{at, code}`); at
 * QUEUE_TRIES it Blocks with why (`{block: reason, drops, last, codes}`, `codes` the distinct drop codes); `last` has
 * `factory: true` when Factory made that removal. Codes are
 * GitHub's (`checks_timed_out`, `failed_checks`, ...); anything else reads `unknown`.
 */
export function queueRetry(removals, { since, self = null }) {
  const from = Date.parse(since);
  const me = botless(self);
  const after = (removals || [])
    .filter((r) => r && r.reason !== "merged" && Date.parse(r.at) > (Number.isFinite(from) ? from : -Infinity))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((r) => {
      const who = botless(r.actor);
      // Factory's own removal names why: this pass's (`self`), or one read back from Factory's requeue record (`code`).
      if (r.self === true || (me && who === me)) return { at: r.at, code: r.code ? queueCode(r.code) : STALL_CODE, drop: true, factory: true };
      return { at: r.at, code: queueCode(r.reason), drop: r.person !== true || who === QUEUE_BOT };
    });
  const newest = after.at(-1);
  if (newest && !newest.drop) return { hold: { at: newest.at, code: newest.code }, drops: after.filter((r) => r.drop).length };
  const drops = after.filter((r) => r.drop);
  const last = drops.length ? { at: drops.at(-1).at, code: drops.at(-1).code, ...(drops.at(-1).factory ? { factory: true } : {}) } : null;
  if (drops.length < QUEUE_TRIES) return { enqueue: true, drops: drops.length, last };
  const codes = [...new Set(drops.map((d) => d.code))];
  return { block: `the merge queue dropped the reviewed PR ${drops.length} times without merging it (${codes.join(", ")}); Factory re-enqueued it once. Check that the required checks run on the queue's merge_group commits`, drops: drops.length, last, codes };
}

/** GitHub Actions' app id: a required check's integration when the ruleset names none. */
export const ACTIONS_APP_ID = 15368;

/**
 * Whether CI began on a queue commit, from what GitHub holds on it. `gate` is the required checks (`{name, app}`, `app`
 * the ruleset's integration id or null; a bare name is `{name, app: null}`). It began when one of these exists:
 * - a check run or commit status named like a required check;
 * - a check run from a required check's integration, or from Actions when the ruleset names none;
 * - a check suite (`suites`, `{app: {id}, latest_check_runs_count}`) from a required check's integration, or from
 *   Actions when the ruleset names none. A required job behind `needs:` has no check run until its upstream jobs
 *   finish (clockgrove's `quality`: 15 min after the commit), but its workflow's suite exists within seconds. Any
 *   Actions suite counts, since Actions makes one only for a workflow run (one waiting on a concurrency group has no
 *   check run yet); another app's counts only with a check run in it, since every installed app gets an empty
 *   queued suite on each commit (#295's commit had Claude's and Vercel's).
 * Any Actions run on the queue commit counts, required or not: code scanning's `dynamic` run, a `push` workflow with no
 * branch filter that fires on `gh-readonly-queue/**`, another `merge_group` workflow, a startup failure. One that never
 * produces the required check is bounded by queueStall's hung rule (queueHangs) and the drop handling
 * (queueRetry), not here.
 * With an empty gate (the required checks unread, e.g. protection the App cannot read), any check run, any status or
 * any suite with a check run in it counts, as well as any Actions suite, so CI from a third-party app or statuses alone
 * is not read as a stall. Otherwise code scanning's own app is none of these unless a required check names it.
 * Decided on names and app ids only.
 */
export function gateStarted(gate, { runs = [], statuses = [], suites = [] } = {}) {
  const specs = (gate || []).map((g) => (typeof g === "string" ? { name: g, app: null } : { name: String(g?.name ?? ""), app: Number.isInteger(g?.app) && g.app > 0 ? g.app : null })).filter((g) => g.name);
  const names = new Set(specs.map((g) => g.name));
  const apps = new Set(specs.map((g) => g.app ?? ACTIONS_APP_ID));
  if (!specs.length) return runs.length > 0 || statuses.length > 0 || suites.some((c) => c?.app?.id === ACTIONS_APP_ID || Number(c?.latest_check_runs_count) > 0);
  if (runs.some((r) => names.has(String(r?.name)) || apps.has(r?.app?.id))) return true;
  if (statuses.some((x) => names.has(String(x?.context)))) return true;
  return suites.some((c) => apps.has(c?.app?.id) && (c.app.id === ACTIONS_APP_ID || Number(c.latest_check_runs_count) > 0));
}

/** How long after its enqueue an entry with no queue commit yet is still watched: GitHub makes the commit within seconds. */
export const QUEUE_FRESH_MS = 2 * 60_000;

/**
 * Whether a PR's merge queue entry is stalled: its merge_group commit exists (`entry.head`, made at `entry.headAt`) and
 * the entry waits on checks, and either CI did not begin on that commit (`started`: gateStarted) within QUEUE_STALL_MS,
 * or it began and a required check hung there (`hung`: queueHangs' entries, read once the commit is STEP_STALL_FLOOR_MS
 * old, before which no step can be stalled). Returns `{stalled: true}` (no CI began), `{stalled: true, hung}`, `{waitMs}`
 * (read again then: no check yet, a started one too young to judge, or an entry enqueued under QUEUE_FRESH_MS ago with no
 * commit yet) or `{}` (nothing to decide now: the entry is past checks, waits its turn behind others, or nothing hung).
 * The queue watch keeps any PR still in the queue whatever this says; only the merge pass acts on `stalled`.
 */
export function queueStall(entry, { started, now = Date.now(), hung = null }) {
  if (entry && !entry.head && (!entry.state || entry.state === "QUEUED")) {
    const queuedAt = Date.parse(entry.enqueuedAt);
    return Number.isFinite(queuedAt) && now - queuedAt < QUEUE_FRESH_MS ? { waitMs: QUEUE_STALL_MS } : {};
  }
  if (!entry?.head || entry.state !== "AWAITING_CHECKS") return {};
  const at = Date.parse(entry.headAt ?? entry.enqueuedAt);
  if (!Number.isFinite(at)) return {};
  if (!started) {
    const left = at + QUEUE_STALL_MS - now;
    return left <= 0 ? { stalled: true } : { waitMs: left };
  }
  const left = at + STEP_STALL_FLOOR_MS - now;
  if (left > 0) return { waitMs: left };
  const named = new Map();
  for (const h of Array.isArray(hung) ? hung : []) {
    const e = typeof h === "string" ? { name: h, step: null, elapsedMs: null, baselineMs: null } : h;
    if (e?.name && !named.has(String(e.name))) named.set(String(e.name), e);
  }
  return named.size ? { stalled: true, hung: [...named.values()] } : {};
}

/**
 * Whether a PR head beyond the one Factory recorded as mergeable is GitHub's own "Update branch" merge: a merge commit
 * whose first parent is the recorded head and whose second is on the default branch (`secondOnDefault`), committed and
 * signed by GitHub's web-flow key. Any other new head (a push by anyone) goes back to review.
 */
export function updateBranchHead(commit, recorded, secondOnDefault) {
  const parents = (commit?.parents || []).map((p) => p.sha);
  return parents.length === 2 && parents[0] === recorded && !!secondOnDefault && commit?.commit?.verification?.verified === true && commit?.committer?.login === "web-flow";
}

// ---------------------------------------------------------------- markers

export const marker = (issue, kind, id = "") => `<!-- factory:${issue}:${kind}${id ? `:${id}` : ""} -->`;

/** People who can push; on a public repository anyone else may still comment and review. */
export const PUSH_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/**
 * The writers of the one repository this process works on, by login (primeWriters in github.mjs fills and refreshes
 * it). author_association alone is not enough: an App's token sees an organization member whose membership is private
 * as CONTRIBUTOR or NONE. Set for another repository, the list starts over, so one repository's writers never count in
 * another.
 */
let WRITERS = { repo: null, logins: new Set(), maintainers: new Set(), unpinned: [] };
// GitHub logins are unique ignoring case, so they are compared lowercased; a leading @ is dropped.
const loginKey = (l) => String(l ?? "").trim().replace(/^@/, "").toLowerCase();
const loginSet = (logins) => new Set((logins || []).map(loginKey).filter(Boolean));
export const setWriters = (repoFull, logins) => {
  WRITERS = { repo: repoFull, logins: loginSet(logins), maintainers: WRITERS.repo === repoFull ? WRITERS.maintainers : new Set(), unpinned: WRITERS.repo === repoFull ? WRITERS.unpinned : [] };
};
/** A maintainers entry as `{login, id}`: `login#id` pins the account by its numeric id; a bare login has id null. */
export function parseMaintainer(entry) {
  const m = /^@?([A-Za-z0-9-]+)(?:#(\d+))?$/.exec(String(entry ?? "").trim());
  return m ? { login: m[1], id: m[2] ? Number(m[2]) : null } : null;
}
/**
 * The workflow's own maintainers (FACTORY_NOTIFY and FACTORY_MAINTAINERS): trusted because only a writer can change
 * the workflow file. This does not depend on what the reading token can see: an App sees an org owner whose membership
 * is private as CONTRIBUTOR, and lists no collaborators at all for org-derived access. Each is trusted by its numeric
 * user id (`login#id`), never by the login string: a login renamed away and registered by someone else is a stranger.
 * A bare login is trusted for nothing (doctor names the `login#id` to write).
 */
export const setMaintainers = (repoFull, entries) => {
  if (WRITERS.repo !== repoFull) WRITERS = { repo: repoFull, logins: new Set() };
  const parsed = (entries || []).map(parseMaintainer).filter(Boolean);
  WRITERS.maintainers = new Set(parsed.filter((m) => m.id).map((m) => m.id));
  WRITERS.unpinned = parsed.filter((m) => !m.id).map((m) => m.login);
};
/** The maintainers named without an id, so trusted for nothing. */
export const unpinnedMaintainers = () => [...(WRITERS.unpinned || [])];
/** The repository the writer list is for: a process that serves another repository reads it again for that one. */
export const writersRepo = () => WRITERS.repo;
/** Whether this login is on the writer list (true), or unknown (null). The writer list is never complete, so never false. */
export const knownWriter = (login) => (login && WRITERS.logins?.has(loginKey(login)) ? true : null);
/** Whether this user is one of the workflow's maintainers, by numeric id. */
export const pinnedMaintainer = (user) => Number.isInteger(user?.id) && !!WRITERS.maintainers?.has(user.id);

/** A person who can push: by the association the reader sees, the writer list, or the workflow's pinned maintainers. */
export const pushAuthor = (item) => PUSH_ASSOCIATIONS.has(item?.author_association) || knownWriter(item?.user?.login) === true || pinnedMaintainer(item?.user);

/**
 * The login Factory itself writes as in this process: the App's `<slug>[bot]` on Actions, the token's owner in local
 * mode (github.mjs primeSelf sets it). Null until known.
 */
let SELF = null;
export const setSelf = (login) => {
  SELF = login ? loginKey(login) : null;
};
export const selfLogin = () => SELF;
/** Whether this comment or review is Factory's own, by its exact login. */
export const isSelf = (item) => !!SELF && loginKey(item?.user?.login) === SELF;
/**
 * Whether Factory may act on a marker in this comment or review: written by Factory's own login or by someone who can
 * push. Any other App, the job's own token (github-actions[bot]) included, is a stranger. Anyone can paste a marker.
 */
export const trustedAuthor = (item) => isSelf(item) || pushAuthor(item);

/**
 * Candidate decisions on an Objective: comments on its issue and PR by a person (never a bot, never a Factory marker
 * comment), oldest first. Who may decide is not read from author_association: an App's token sees an organization
 * member whose membership is private as CONTRIBUTOR or NONE. objectiveDecisions checks each author's write access.
 */
export function maintainerDecisions(comments) {
  const all = comments || [];
  // Factory's own review threads: inline comments of a review whose body carries the review marker, and replies in
  // those threads by the review's own author. In local mode the reviewer and the worker post as the developer's login,
  // with no bot type to tell them apart; a reply by anyone else in the thread is still a decision.
  const factoryReviews = new Map(all.filter((c) => c?.kind === "review" && REVIEW_BODY.test(c.body || "") && trustedAuthor(c)).map((r) => [r.id, loginKey(r.user?.login)]));
  const lines = new Map(all.filter((c) => c?.kind === "line").map((c) => [c.id, c]));
  const factoryThread = (c) => {
    if (c?.kind !== "line") return false;
    if (factoryReviews.has(c.pull_request_review_id)) return true;
    const root = lines.get(c.in_reply_to_id);
    return !!root && factoryReviews.has(root.pull_request_review_id) && factoryReviews.get(root.pull_request_review_id) === loginKey(c.user?.login);
  };
  return all
    .filter((c) => c?.user?.type !== "Bot" && !(c.body || "").includes("<!-- factory:") && (c.body || "").trim() && !factoryThread(c))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((c) => ({ author: c.user?.login ?? "?", authorId: c.user?.id ?? null, at: c.created_at, body: c.body.trim(), key: `${c.kind || "comment"}:${c.id}`, seen: latest(c.created_at, c.updated_at) }));
}
const REVIEW_BODY = /<!-- factory:\d+:review -->/;
const latest = (...times) => times.filter((t) => Number.isFinite(Date.parse(t))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;

/**
 * What a pass that fed the decisions to a model read: each decision's key and the time of the version it read
 * (created, or last edited). Recorded as a hidden line in the run's progress comment on the issue.
 */
export const decisionsRead = (decisions) => Object.fromEntries((decisions || []).filter((d) => d.key).map((d) => [d.key, d.seen ?? d.at]));
export const decisionsReadMarker = (read) => `<!-- factory:decisions-read ${JSON.stringify(read || {})} -->`;
const DECISIONS_READ = /^<!-- factory:decisions-read (\{[^\n]*\}) -->$/m;
/** Merge read records (maps of key to time): the latest time read per key. */
export function mergeRead(...reads) {
  const out = {};
  for (const r of reads) for (const [k, t] of Object.entries(r || {})) if (!out[k] || Date.parse(t) > Date.parse(out[k])) out[k] = t;
  return out;
}
/**
 * Every read record on the issue, merged: only from Factory's own progress comments, written by `self` (the login
 * Factory posts as: the App's bot on Actions, the developer's login in local mode). Anyone else's record, a record
 * outside a progress comment, or one that does not parse counts for nothing: its decisions stay unread.
 */
export function decisionsReadOf(comments, { issue, self }) {
  if (!self) throw new Error("Factory's own login is unknown, so its read records cannot be told from anyone else's");
  const progress = `<!-- factory:${issue}:progress:`;
  const reads = [];
  for (const c of comments || []) {
    if (loginKey(c?.user?.login) !== loginKey(self) || !(c.body || "").startsWith(progress)) continue;
    const m = DECISIONS_READ.exec(c.body || "");
    if (!m) continue;
    try {
      const r = JSON.parse(m[1]);
      if (r && typeof r === "object" && !Array.isArray(r)) reads.push(Object.fromEntries(Object.entries(r).filter(([, t]) => Number.isFinite(Date.parse(t)))));
    } catch {
      // a malformed record: nothing read
    }
  }
  return mergeRead(...reads);
}
/**
 * The plan-time Questions a run asked (one-repo.mjs planNeeds): each repository asked about (lower-cased) and
 * when. Recorded as a hidden line in the run's progress comment on the issue, read back by planAskedOf.
 */
export const planAskedMarker = (asked) => `<!-- factory:plan-asked ${JSON.stringify(asked || {}).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
const PLAN_ASKED = /^<!-- factory:plan-asked (\{[^\n]*\}) -->$/m;
/**
 * Every plan-time Question record on the issue, merged (the latest time per repository): only from Factory's own
 * progress comments, written by `self`, as decisionsReadOf. Anyone else's record counts for nothing. Without `self`, none.
 */
export function planAskedOf(comments, { issue, self }) {
  if (!self) return {};
  const progress = `<!-- factory:${issue}:progress:`;
  const asked = [];
  for (const c of comments || []) {
    if (loginKey(c?.user?.login) !== loginKey(self) || !(c.body || "").startsWith(progress)) continue;
    const m = PLAN_ASKED.exec(c.body || "");
    if (!m) continue;
    try {
      const r = JSON.parse(m[1]);
      if (r && typeof r === "object" && !Array.isArray(r)) asked.push(Object.fromEntries(Object.entries(r).filter(([k, t]) => typeof k === "string" && Number.isFinite(Date.parse(t))).map(([k, t]) => [k.toLowerCase(), t])));
    } catch {
      // a malformed record: nothing asked
    }
  }
  return mergeRead(...asked);
}
/**
 * The decisions no pass has read yet: never read, or edited after the version a pass read. These have not reached
 * the code, so Factory applies them before it merges.
 */
export function unreadDecisions(decisions, read) {
  return (decisions || []).filter((d) => {
    const at = read?.[d.key];
    return !at || Date.parse(d.seen ?? d.at) > Date.parse(at);
  });
}

/**
 * A Question answered while the review job that raised it ran, which its Question exit must not revert: both a
 * decision by a writer (`writers`, logins confirmed to have write access) that no pass has read, posted or edited
 * after the job read the decisions (`readAt`, ms), and the PR marked ready by a person after the job started
 * (`startedAt`, ms; `events`, the PR's timeline). Factory's own ready marks are not a person's: a bot's, or the token's
 * own login (`self`; in local mode that is the developer's). Either one alone keeps the Question. In local mode
 * (`local`) the Question always stands: nothing there runs the review a ready mark alone would start. Returns what
 * arrived, or "" when the Question stands.
 */
export function answerDuring({ unread = [], writers = new Set(), events = [], readAt, startedAt, self = null, local = false }) {
  if (local) return "";
  const answers = unread.filter((d) => writers.has(loginKey(d.author)) && Date.parse(d.seen ?? d.at) > readAt);
  const ready = events.filter((e) => e.event === "ready_for_review" && e.actor?.type !== "Bot" && !(self && loginKey(e.actor?.login) === loginKey(self)) && Date.parse(e.created_at) > startedAt).at(-1);
  return answers.length && ready ? `${ready.actor.login} marked the PR ready and ${answers.length} maintainer decision(s) arrived during the review` : "";
}

const decisionText = (d) => `### ${d.author}, ${String(d.at).slice(0, 16).replace("T", " ")}Z\n\n${d.body}`;
/**
 * The decisions that fit a prompt section: the newest whole ones within `cap` characters (the newest always), oldest
 * first. Only these reach the model, so only these are recorded as read; the cut ones stay unread.
 */
export function decisionsShown(decisions, cap = 12_000) {
  const shown = [];
  let size = 0;
  for (const d of [...(decisions || [])].reverse()) {
    size += decisionText(d).length + 2;
    if (shown.length && size > cap) break;
    shown.unshift(d);
  }
  return shown;
}
/** The decisions as a prompt section ("" when none), capped so a long thread cannot crowd out the task. */
export function decisionsSection(decisions, cap = 12_000) {
  if (!decisions?.length) return "";
  const shown = decisionsShown(decisions, cap);
  const cut = decisions.length - shown.length;
  const note = cut ? `${cut} earlier decision(s) are not shown here for length; read them all in \`$FACTORY_IN/decisions.md\` before you change anything.\n\n` : "";
  return `## Decisions recorded by maintainers (comments on the issue and PR, oldest first)\n\nWhere one answers a question or differs from the issue body, it wins: it is the owner's later word.\n\n${note}${shown.map(decisionText).join("\n\n")}`;
}

/**
 * The spend line a run without a usage artifact (local mode) writes into its progress comment: structured, so a
 * dispatcher reads the number, never the prose exit line. Parsed by spendOf().
 */
export const spendMarker = (usd, parts = null) => `<!-- factory:spend ${JSON.stringify({ usd, ...(parts || {}) })} -->`;
/**
 * The harness a stage runs, written into its progress comment from the stage's start: structured, so the bench scorer
 * (the 1.0 streak counts per harness) reads it whatever the stage's model or exit, never from the prose phase lines.
 */
export const harnessMarker = (harness, model = "") => `<!-- factory:harness ${JSON.stringify({ harness, ...(model ? { model } : {}) })} -->`;
const SPEND = /^<!-- factory:spend (\{[^\n]*\}) -->$/m;
/** The dollars a progress comment's spend line records, or 0: the total, model and sandbox vendor together. */
export function spendOf(body) {
  const usd = spendParts(body)?.usd;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}
/**
 * The spend line's parts: `usd` (the total the daily sum counts), and for a sandbox stage `modelUsd` (the harness's)
 * and `vendorUsd` (the sandbox's, booked by the launcher at the stage's end). Null when the body has no spend line.
 */
export function spendParts(body) {
  const m = SPEND.exec(body || "");
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    return { usd: n(r?.usd) ?? 0, modelUsd: n(r?.modelUsd), vendorUsd: n(r?.vendorUsd) };
  } catch {
    return null;
  }
}

const money = (n) => (Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "?");
const word = (s) => (typeof s === "string" && /^[A-Za-z0-9._:/-]{1,40}$/.test(s) ? s : "?");
/**
 * The vendor comment's line for a sandbox stage's end (vendorBody; codes, numbers and the vendor's dated rates only):
 * the sandbox's state, its active CPU and wall seconds, its size, the list rates and the stage's vendor dollars with the
 * stopped stretch's storage. `cost` is adapters/sandbox.mjs stageVendorCost's; `error` a code when the usage could not be read.
 */
export function vendorLine({ id, state, cost, rates, at = new Date().toISOString(), error = null }) {
  const clock = `${new Date(Date.parse(at) || Date.now()).toISOString().slice(11, 16)}Z`;
  const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "?");
  const size = Number.isFinite(cost.vcpus) || Number.isFinite(cost.memoryMb) ? `${cost.vcpus ?? "?"} vCPU / ${Number.isFinite(cost.memoryMb) ? Math.round(cost.memoryMb / 1024) : "?"} GB` : "size unknown";
  const r = rates || {};
  const rate = `${word(r.vendor)} ${word(r.plan)} list rates (${word(r.region)}, read ${word(r.date)}): ${money(r.activeCpuHour)}/CPU-hour, ${money(r.memoryGbHour)}/GB-hour, ${money(r.snapshotGbMonth)}/GB-month stored`;
  const use = cost.upperBound
    ? `usage not settled${error ? ` (${word(error)})` : ""}, counted at the session's ceiling`
    : cost.usd === null
      ? `usage not read${error ? ` (${word(error)})` : ""}`
      : `${secs(cost.activeCpuMs)} active CPU in ${secs(cost.wallMs)}`;
  const stored = cost.storedMs > 0 ? `; stopped ${(cost.storedMs / 3_600_000).toFixed(1)} h before it with ${Number.isFinite(cost.storedBytes) ? `${(cost.storedBytes / 1e9).toFixed(2)} GB` : "? GB"} saved: ${money(cost.storedUsd)}` : "";
  const id_ = typeof id === "string" && /^factory-[A-Za-z0-9_-]{1,60}$/.test(id) ? id : "?";
  return `- ${clock} sandbox \`${id_}\` ${word(state)}: ${use}, ${size}; ${rate}; vendor ${cost.upperBound ? "at most " : ""}${money(cost.usd)} this stage${stored}`;
}

/**
 * The vendor comment's body (`<!-- factory:<n>:vendor:<stage>:<key> -->`, one per stage, written by its one booker):
 * `line` (vendorLine) and a spend line of the vendor's dollars, which `daily_usd` adds to the stage's progress comment's
 * model dollars. `modelUsd`: the harness's dollars from the usage record, for a stage that left no progress comment.
 */
export function vendorBody({ line, vendorUsd, modelUsd = null }) {
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const vendor = round(Number.isFinite(vendorUsd) ? vendorUsd : 0);
  const model = Number.isFinite(modelUsd) ? round(modelUsd) : null;
  return `Factory's sandbox cost for this stage:\n${line}\n${spendMarker(round(vendor + (model ?? 0)), { ...(model === null ? {} : { modelUsd: model }), vendorUsd: vendor })}`;
}

// ----------------------------------------------------------------- launch

/** The Objective an event's branch names (`factory/<n>`), or null. */
const branchIssue = (ref) => {
  const m = /^factory\/(\d+)$/.exec(String(ref || ""));
  return m ? Number(m[1]) : null;
};
/** An ISO time from a payload or a record, normalised; null when it is not a time. */
const isoOrNull = (t) => (t && Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : null);

/**
 * What a launcher was started for, from the event GitHub delivered (pure; the caller reads GITHUB_EVENT_NAME and the
 * payload). `issue` is set when the dispatcher named the Objective (the launch job's matrix: a pick or a sweep's
 * re-launch): kind `swept`, whatever event ticked the dispatcher. Otherwise one of:
 *   comment  a new comment on an Objective issue (not a PR), not one of Factory's own marker comments
 *   checks   a finished check suite (an App's CI) or workflow run (CI on Actions) on a factory/<n> branch
 *   review   the review label on a factory/<n> PR, or the PR marked ready
 * Returns {kind, issue, at, sha?, pr?, author?, human?} with `at` the event's own time where the payload has one
 * (null where it has none: the caller uses the workflow run's creation time), or {skip: reason}.
 */
export function launchEvent(name, payload = {}, { issue = null, repoFull = "" } = {}) {
  if (issue) return { kind: "swept", issue: Number(issue), at: null };
  const sameRepo = (full) => !repoFull || full === repoFull;
  if (name === "issue_comment") {
    if (payload.action !== "created") return { skip: `issue_comment ${payload.action}` };
    if (payload.issue?.pull_request) return { skip: "a comment on a pull request" };
    const c = payload.comment || {};
    // A local loop posts its progress and markers with a person's token: they are Factory's records, not an answer.
    if (String(c.body || "").startsWith("<!-- factory:")) return { skip: "one of Factory's own marker comments" };
    return { kind: "comment", issue: payload.issue?.number ?? null, at: isoOrNull(c.created_at), author: { user: c.user ?? null, author_association: c.author_association ?? null }, human: c.user?.type !== "Bot" };
  }
  if (name === "check_suite" || name === "workflow_run") {
    const s = name === "check_suite" ? payload.check_suite : payload.workflow_run;
    if (payload.action !== "completed" || !s) return { skip: `${name} ${payload.action}` };
    const n = branchIssue(s.head_branch);
    if (!n) return { skip: `${name} on a branch that is not factory/<issue>` };
    // A fork's run can carry a factory/<n> branch name too; only this repository's own branch is an Objective's. A
    // check suite names no repository: the caller compares its head with the branch's (launchDecision headSha).
    if (name === "workflow_run" && !sameRepo(s.head_repository?.full_name)) return { skip: "a workflow run from another repository" };
    return { kind: "checks", issue: n, at: isoOrNull(s.updated_at), sha: s.head_sha ?? null };
  }
  if (name === "pull_request") {
    const pr = payload.pull_request || {};
    const n = branchIssue(pr.head?.ref);
    if (!n) return { skip: "not a factory/<issue> branch" };
    if (!sameRepo(pr.head?.repo?.full_name)) return { skip: "a PR from another repository" };
    const labelled = payload.action === "labeled" && payload.label?.name === REVIEW_LABEL;
    if (!labelled && payload.action !== "ready_for_review") return { skip: `pull_request ${payload.action}` };
    return { kind: "review", issue: n, pr: pr.number ?? null, at: isoOrNull(pr.updated_at), sha: pr.head?.sha ?? null, ready: payload.action === "ready_for_review", human: payload.sender?.type !== "Bot", draft: !!pr.draft };
  }
  if (name === "repository_dispatch") {
    // A stage in a sandbox asks the launcher for fresh tokens or for its next step (stage.mjs): only Factory sends these.
    const p = payload.client_payload || {};
    if (payload.action !== "factory-stage") return { skip: `repository_dispatch ${payload.action}` };
    if (!Number.isSafeInteger(p.issue) || p.issue < 1 || typeof p.claim !== "string" || !["token", "ended"].includes(p.want)) return { skip: "a stage event without its issue, claim or want" };
    // `ask`: when a token request was made (seconds), naming that one request; absent on an end.
    const ask = p.want === "token" && Number.isSafeInteger(p.ask) && p.ask > 0 ? p.ask : null;
    return { kind: "stage", issue: p.issue, claim: p.claim, want: p.want, ask, sender: payload.sender ?? null, at: null };
  }
  return { skip: `${name} names no Objective` };
}

/**
 * The sandbox marker comment's JSON line; its first line is marker(issue, "sandbox"). `<` and `>` are escaped inside
 * the JSON (\u003c, \u003e), so no value can close the HTML comment or open markup.
 */
export const sandboxMarkerLine = (rec) => `<!-- factory:sandbox ${JSON.stringify(rec).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
const SANDBOX = /^<!-- factory:sandbox (\{[^\n]*\}) -->$/m;
/** The record in a sandbox marker comment body, or null. */
export function sandboxRecordOf(body) {
  const m = SANDBOX.exec(body || "");
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    return r && typeof r === "object" && !Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}
/** The stage's own part of the sandbox record: one comment per stage claim, written by that stage alone (stage.mjs). */
export const stageMarker = (issue, claim) => marker(issue, "stage", claim);
const ownOldest = (comments, head, self) => (comments || []).filter((x) => self(x) && (x.body || "").startsWith(`${head}\n`)).sort((a, b) => a.id - b.id)[0];
/**
 * The stage's own comment for `claim` among `comments`, or undefined: the one written last (its record's `at`, then
 * its id), should a list that lagged the stage's first write ever have left two.
 */
export function stagePartComment(comments, issue, claim, { self = isSelf } = {}) {
  const head = `${stageMarker(issue, claim)}\n`;
  const at = (c) => Date.parse(sandboxRecordOf(c.body)?.at) || 0;
  return (comments || []).filter((x) => self(x) && (x.body || "").startsWith(head)).sort((a, b) => at(b) - at(a) || b.id - a.id)[0];
}

/**
 * The Objective's sandbox record, merged from its single-writer parts (docs/ADAPTERS.md, Records): the claim comment
 * `<!-- factory:<n>:sandbox -->` (launchers and the sweep, under the Objective's record lock) and, while it says
 * `running`, the comment of the stage holding its claim (`<!-- factory:<n>:stage:<claim> -->`, that stage alone): its
 * fields over the claim comment's, its launch entry added where the launcher's is missing, a quota streak over (a
 * stage that writes has started). Factory's own comments only (anyone can paste a marker into theirs), the oldest when
 * there are two. Carries the claim comment's id and updated_at.
 */
export function sandboxRecord(comments, issue, { self = isSelf } = {}) {
  const c = ownOldest(comments, marker(issue, "sandbox"), self);
  if (!c) return null;
  const base = { ...sandboxRecordOf(c.body), commentId: c.id, updatedAt: c.updated_at ?? null };
  const part = base.state === "running" && typeof base.claim === "string" ? sandboxRecordOf(stagePartComment(comments, issue, base.claim, { self })?.body) : null;
  if (!part) return base;
  const { launch, claim, quota, ...fields } = part;
  const { quota: _, ...kept } = base;
  return { ...kept, ...fields, launches: launch && typeof launch === "object" ? withLaunch(base.launches, launch) : base.launches };
}

/** How many launches a sandbox record keeps, the latest last. */
export const KEEP_LAUNCHES = 10;
/**
 * `launches` with a started stage's entry in it. A start is one entry per cue and launch run, which both parts of the
 * record carry: the launcher's after the start, and the stage's from its first beat (which can come first). `replace`: the launcher's own entry, with its timings, takes the place
 * of the stage's; without it an entry already there is kept.
 */
const sameStart = (entry) => (l) => l?.ok === true && l.cue === entry.cue && l.run === entry.run;
export function withLaunch(launches, entry, { replace = false } = {}) {
  const list = Array.isArray(launches) ? launches : [];
  const same = sameStart(entry);
  if (!replace && list.some(same)) return list;
  return [...list.filter((l) => !same(l)), entry].slice(-KEEP_LAUNCHES);
}

/** The tags an Objective's sandbox carries: the vendor-side half of finding it (docs/ADAPTERS.md). */
export const sandboxTags = (repoId, issue) => ({ factory: "objective", "factory-repo": String(repoId), "factory-issue": String(issue) });
/** A sandbox id Factory made and may adopt: its own prefix and plain characters (the vendor's names, sandbox-vercel.mjs). */
export const factorySandboxId = (id) => typeof id === "string" && /^factory-[A-Za-z0-9_-]{1,60}$/.test(id);

/**
 * The sandbox to use: the one the record names, when the vendor still lists it with this Objective's tags in a usable
 * state (stopped or running). Anything else, an unrecorded sandbox with matching tags included, is not adopted: the
 * launcher creates a new one. Reason: only Factory's own record says which sandbox holds the Objective's work.
 */
export function pickSandbox(listed, { repoId, issue, recordedId = null }) {
  if (!factorySandboxId(recordedId)) return null;
  const want = sandboxTags(repoId, issue);
  const s = (listed || []).find((x) => x.id === recordedId);
  if (!s || !["stopped", "running"].includes(s.state)) return null;
  return Object.entries(want).every(([k, v]) => s.tags?.[k] === v) ? s.id : null;
}

/**
 * When a PR's review was last asked for, from its issue timeline: the review label's last `labeled` event (counted only
 * while the PR carries the label, `labelled`) or a person's last `ready_for_review` (an App's is the worker's own
 * transition, never a cue), whichever is later. Every launcher (the Action, the sweep) reads the same
 * timeline, so one request is one cue (`since`) whichever event or process saw it. Times are ISO strings or null.
 */
export function reviewRequestOf(events, { labelled }) {
  let labelledAt = null;
  let readyAt = null;
  for (const e of events || []) {
    if (e?.event === "labeled" && e.label?.name === REVIEW_LABEL && isoOrNull(e.created_at)) labelledAt = e.created_at;
    if (e?.event === "ready_for_review" && e.actor && e.actor.type !== "Bot" && isoOrNull(e.created_at)) readyAt = e.created_at;
  }
  const later = (a, b) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);
  return { labelledAt: labelled ? labelledAt : null, readyAt, since: labelled ? later(labelledAt, readyAt) : readyAt };
}

/** Whether the record shows a successful start of `stage` at or after `since` (an ISO time). */
export function launchedSince(record, stage, since) {
  const t = Date.parse(since);
  return (record?.launches || []).some((l) => l.ok === true && l.stage === stage && Number.isFinite(t) && Date.parse(l.at) >= t);
}

/**
 * Whether the record says a stage holds the sandbox now: running, within its lease (the launcher's claim, then the
 * stage's heartbeat, extend it ten minutes at a time). A record with no lease falls back to `staleMs` from its time.
 */
export const stageHolds = (record, now, staleMs) => record?.state === "running" && (record.leaseUntil ? now < Date.parse(record.leaseUntil) : now - Date.parse(record.at) < staleMs);

/** How long past its wall clock a stage may run before the stage's watchdog ends it (stage.mjs). */
export const STAGE_GRACE_MS = 3 * 60_000;
/** What a sandbox session keeps after a stage's wall clock: the watchdog's grace, then packing and announcing the end. */
export const SESSION_RESERVE_MS = STAGE_GRACE_MS + 3 * 60_000;

/**
 * The launcher's note for a stage whose wall clock one vendor session cut below timeout_minutes (launch.mjs
 * startInSandbox): the stage's environment carries it as FACTORY_STAGE_SESSION_CAP, so a time cap there Blocks naming
 * the vendor's cap (sessionCapNote), not a bare "time cap reached". Empty when nothing was cut.
 */
export const sessionCapEnv = ({ vendor, setting, minutes }) => (Number(setting) > Number(minutes) && Number(minutes) > 0 && vendor ? { FACTORY_STAGE_SESSION_CAP: JSON.stringify({ vendor: String(vendor), setting: Number(setting), minutes: Number(minutes) }) } : {});
/** What a time-cap Block adds when the vendor's session cut the stage (FACTORY_STAGE_SESSION_CAP); "" otherwise. */
export function sessionCapNote(cap) {
  let c = null;
  try {
    c = JSON.parse(cap || "null");
  } catch {
    return "";
  }
  if (!c || typeof c.vendor !== "string" || !/^[a-z0-9-]{1,40}$/.test(c.vendor) || !(c.minutes > 0) || !(c.setting > c.minutes)) return "";
  return `the ${c.vendor} sandbox's session cap: one vendor session gave this stage ${c.minutes} of timeout_minutes ${c.setting} (docs/ADAPTERS.md, "Fresh session per stage")`;
}

/**
 * A started stage's end by its own clock: `minutes` from the start (`commandAt`), never past the session's end less
 * SESSION_RESERVE_MS. The launcher and the stage both write it (launch.mjs startInSandbox, stage.mjs startedFields), so
 * whichever writer lands last, the record has it. Null without a start time or a wall clock.
 */
export function stageDeadline(commandAt, minutes, sessionEnd) {
  const start = Date.parse(commandAt);
  if (!Number.isFinite(start) || !(Number(minutes) > 0)) return null;
  const end = Date.parse(sessionEnd);
  return new Date(Math.min(start + Number(minutes) * 60_000, Number.isFinite(end) ? end - SESSION_RESERVE_MS : Infinity)).toISOString();
}

/**
 * A stage's wall clock in whole minutes: its setting, cut so that it ends SESSION_RESERVE_MS before the sandbox's session
 * does (`sessionEnd`, the vendor's own time); 0 when the session leaves no room. An unknown end keeps the setting.
 */
export function stageMinutes({ sessionEnd, timeoutMinutes, now = Date.now() }) {
  const setting = Number(timeoutMinutes) > 0 ? Number(timeoutMinutes) : Infinity;
  const left = Date.parse(sessionEnd) - now - SESSION_RESERVE_MS;
  if (!Number.isFinite(left)) return Number.isFinite(setting) ? setting : 0;
  return Math.max(0, Math.min(setting, Math.floor(left / 60_000)));
}

/** When the stage's watchdog fires, in ms from `now`: its wall clock plus the grace, and never later than 3 minutes before the session ends. */
export function watchdogMs({ minutes, sessionEnd, now = Date.now() }) {
  const byClock = minutes * 60_000 + STAGE_GRACE_MS;
  const bySession = Date.parse(sessionEnd) - now - 3 * 60_000;
  return Math.max(0, Number.isFinite(bySession) ? Math.min(byClock, bySession) : byClock);
}

/** Failed starts in one Running stint (or one review request) before the Objective is Blocked instead of tried again. */
export const MAX_FAILED_STARTS = 3;
/**
 * Start failures that say nothing about the Objective: the vendor (or the launch job's clock) failed it. They are
 * retried with a growing pause and never Block; a vendor's outage holds new picks instead (transientHold).
 */
export const TRANSIENT_START = Object.freeze(["rate_limited", "unavailable", "timeout"]);
/** A launch job's limit (5 minutes) plus its wait for a runner: a starting marker this old with no outcome was lost. */
export const START_LOST_MS = 10 * 60_000;
/**
 * `since` (the Running label, the review request) is GitHub's time, in whole seconds; a launch entry's `at` is the
 * writing runner's clock. A runner behind GitHub's by a few seconds writes its marker or failure "before" the stint it
 * belongs to, so entries this much older than `since` still count as the stint's. A stint follows a Block and a
 * person's re-label, never seconds after the last one, so no earlier stint's entry lands inside it.
 */
export const CLOCK_SKEW_MS = 60_000;
/** The first pause after a failed start; each later one doubles it, up to START_RETRY_MAX_MS: 2, 4, 8, 16, then 30 minutes. */
export const START_RETRY_MS = 2 * 60_000;
export const START_RETRY_MAX_MS = 30 * 60_000;
/** The pause before the next try after `n` failed starts. */
export const startBackoffMs = (n) => (n >= 5 ? START_RETRY_MAX_MS : Math.min(START_RETRY_MAX_MS, START_RETRY_MS * 2 ** Math.max(0, n - 1)));

/**
 * The record with every launch attempt that ended unseen stored as a failed start: the one place a failure is read from
 * an absence. Every claim-comment write applies it first (launch.mjs writeSandboxRecord), and every reader counts
 * through it (startFailures), so a later write never erases an attempt and the count only grows:
 * - a starting marker (`ok: null`, the dispatcher's as it names a stage) older than START_LOST_MS is replaced by
 *   `{ok: false, code: "lost"}` at its expiry: its launch never ran its course;
 * - a claim (`running`, a launcher's nonce) whose lease ran out with no start since it was made gets
 *   `{ok: false, code: "timeout"}` at the lease's end, and the record says `failed`: its launcher was cut off.
 * Returns the same object when nothing was due.
 */
export function settleStale(record, now = Date.now()) {
  if (!record) return record;
  const launches = Array.isArray(record.launches) ? record.launches : [];
  let changed = false;
  const kept = [];
  for (const l of launches) {
    const at = Date.parse(l?.at);
    if (l?.ok === null && Number.isFinite(at) && now - at > START_LOST_MS) {
      kept.push({ stage: l.stage, event: l.event, ok: false, run: l.run, at: new Date(at + START_LOST_MS).toISOString(), code: "lost" });
      changed = true;
    } else kept.push(l);
  }
  let rec = changed ? { ...record, launches: kept } : record;
  // "No start since the claim": by the launcher's claim time (`claimedAt`), never the merged record's `at`, which the
  // started stage's own beats override; for a claim written before `claimedAt` was, by its launch run (the start's
  // entry carries the claim's run).
  const claimedAt = Date.parse(rec.claimedAt);
  const started = kept.some((l) => l?.ok === true && ((Number.isFinite(claimedAt) && Date.parse(l.at) >= claimedAt) || (!!rec.run && l.run === rec.run && l.stage === rec.stage)));
  const leaseEnd = Date.parse(rec.leaseUntil);
  // Only a launcher's claim (work or review): the sweep's claim is no launch attempt.
  if (rec.state === "running" && rec.claim && (rec.stage === "work" || rec.stage === "review") && Number.isFinite(leaseEnd) && now >= leaseEnd && !started && (Number.isFinite(claimedAt) || !!rec.run)) {
    const entry = { stage: rec.stage, event: rec.event, ok: false, run: rec.run, at: new Date(leaseEnd).toISOString(), code: "timeout" };
    rec = { ...rec, state: "failed", leaseUntil: null, error: { code: "timeout", status: null }, launches: [...kept, entry].slice(-KEEP_LAUNCHES) };
  }
  return rec;
}

/**
 * The failed starts at or after `since` (the Running stint, or the review request), each `{at, code}`, oldest first:
 * the stored failures of the record as settleStale leaves it, but a quota refusal (its own streak and limit,
 * quotaBackoff). An entry with no code, written before codes were recorded, says nothing and is not counted.
 */
export function startFailures(record, since, now = Date.now()) {
  const t = Date.parse(since) - CLOCK_SKEW_MS;
  if (!Number.isFinite(t) || !record) return [];
  return (settleStale(record, now).launches || [])
    .filter((l) => l?.ok === false && typeof l.code === "string" && l.code !== "quota" && Date.parse(l.at) >= t)
    .map((l) => ({ at: Date.parse(l.at), code: l.code }))
    .sort((a, b) => a.at - b.at);
}
/** Starts in a row that ran past the launch job's limit before it counts as a real failure: a launch that always does is not transient. */
export const MAX_TIMEOUTS = 3;
/** How many of the latest failed starts since `since` in a row were cut off (`timeout`). */
export const timeoutsInRow = (record, since, now = Date.now()) => {
  const fails = startFailures(record, since, now);
  let n = 0;
  for (let i = fails.length - 1; i >= 0 && fails[i].code === "timeout"; i -= 1) n += 1;
  return n;
};
/** The real failed starts since `since`: every stored failure but a vendor's transient one (TRANSIENT_START); three Block. */
export const failedSince = (record, since, now = Date.now()) => startFailures(record, since, now).filter((f) => !TRANSIENT_START.includes(f.code)).length;
/** Why the starts since `since` Block, or null: three real failures, or MAX_TIMEOUTS cut-offs in a row. */
export function startsBlock(record, since, now = Date.now()) {
  if (failedSince(record, since, now) >= MAX_FAILED_STARTS) return `${MAX_FAILED_STARTS} sandbox starts failed`;
  if (timeoutsInRow(record, since, now) >= MAX_TIMEOUTS) return `${MAX_TIMEOUTS} sandbox starts in a row ran past the launch job's limit (timeout)`;
  return null;
}
/**
 * When the stage whose starts failed since `since` is tried again: the last failure plus startBackoffMs of how many
 * failed so far, or at once when the starts Block (startsBlock: the launcher then Blocks). Null when nothing failed
 * since. The Objective stays Running meanwhile (a review stays labelled), so `since` never moves.
 */
export function startRetryAt(record, since, now = Date.now()) {
  const fails = startFailures(record, since, now);
  if (!fails.length) return null;
  const last = fails.at(-1).at;
  return startsBlock(record, since, now) ? last : last + startBackoffMs(fails.length);
}
/** The vendor's own refusals: these alone hold a route's new picks (a cut-off launch says nothing about the vendor). */
export const VENDOR_DOWN = Object.freeze(["rate_limited", "unavailable"]);
/**
 * Vendor refusals in a row after which one Objective's failure looks like its own, not the vendor's: its retries go on
 * every 30 minutes, but it no longer holds the route (4 refusals: about 30 minutes of backoff).
 */
export const VENDOR_HOLD_MAX = 4;
/** How many of the latest failed starts since `since` in a row were the vendor refusing (VENDOR_DOWN). */
export const refusalsInRow = (record, since, now = Date.now()) => {
  const fails = startFailures(record, since, now);
  let n = 0;
  for (let i = fails.length - 1; i >= 0 && VENDOR_DOWN.includes(fails[i].code); i -= 1) n += 1;
  return n;
};
/** Whether this stage's latest starts were refused by the vendor, at most VENDOR_HOLD_MAX in a row: the route's new picks wait. */
export const transientHold = (record, since, now = Date.now()) => {
  const n = refusalsInRow(record, since, now);
  return n >= 1 && n <= VENDOR_HOLD_MAX;
};
/**
 * A launch the dispatcher named less than START_LOST_MS ago with no outcome yet: still in flight (its job may wait for
 * a runner, or threw before it could record anything). Returns when its marker turns into a `lost` failure, the
 * earliest moment it may be named again, or null when none is in flight since `since`.
 */
export function inFlightUntil(record, since, now = Date.now()) {
  const t = Date.parse(since) - CLOCK_SKEW_MS;
  const young = (record?.launches || []).filter((l) => l?.ok === null && Date.parse(l.at) >= t && now - Date.parse(l.at) <= START_LOST_MS);
  return young.length ? Math.max(...young.map((l) => Date.parse(l.at))) + START_LOST_MS + 1000 : null;
}

/**
 * The stage an Objective is due for, from its state alone: work for a Running Objective with no work start since it
 * became Running, review for a non-draft PR whose review was asked for (reviewRequestOf `since`) with no review start
 * since. Null when neither. When it became Running is unknown, no work is due: a sweep fails closed.
 */
export function dueStage({ state, record, runningSince = null, review = null }) {
  if (state === "Running" && runningSince && !launchedSince(record, "work", runningSince)) return { stage: "work" };
  if (review && !review.draft && review.since && !launchedSince(record, "review", review.since)) return { stage: "review", pr: review.pr ?? null };
  return null;
}

/**
 * Which stage, if any, an event starts for an Objective (pure; the caller supplies what GitHub said):
 *   ev           launchEvent()'s result
 *   state        the Objective's state (stateOf: card first, then the label)
 *   record       its sandbox record (sandboxRecord), or null
 *   trusted      whether a comment's author is a maintainer (pushAuthor), and not Factory itself
 *   runningSince when the Objective last became Running (its label event)
 *   review       {pr, labelled, labelledAt, readyAt, since, draft} for its PR (reviewRequestOf): a sweep's or a stage
 *                end's only when the PR carries factory:review, a review event's always; null when unread
 *   headSha      the factory/<n> branch's head now (for a finished check)
 *   staleMs      how long a stage the record says is running holds the sandbox before it counts as gone
 * Returns {stage}, {requeue: reason} or {skip: reason}. Nothing here takes a slot: an answered Question goes back to
 * Queued and the dispatcher, the one place max_concurrent and daily_usd are decided, starts it.
 */
export function launchDecision({ ev, state, record = null, trusted = false, fromSelf = false, closed = false, runningSince = null, review = null, headSha = null, checksDone = false, now = Date.now(), staleMs = 4 * 3600_000 }) {
  if (ev.skip) return { skip: ev.skip };
  if (ev.kind === "stage") {
    // The running stage's own requests: only Factory's, and only for the claim the record still carries.
    if (!fromSelf) return { skip: "a stage event Factory did not send" };
    if (!record || record.claim !== ev.claim) return { skip: "not the claim the sandbox record carries" };
    if (ev.want === "token") return record.state === "running" ? { token: true } : { skip: `no stage runs (${record.state})` };
    if (record.state !== "ended") return { skip: `the stage has not ended (${record.state})` };
    if (closed) return { stop: true };
    // The next step: a stage now due (the review the work asked for, a pick that came while the work ran), else stop.
    return dueStage({ state, record, runningSince, review }) || { stop: true };
  }
  // The per-Objective concurrency group serialises launchers; a stage still running in the sandbox outlives its
  // launcher, so the record says whether one holds it. Past staleMs the holder is taken for gone.
  if (stageHolds(record, now, staleMs)) return { skip: `stage ${record.stage} is running in the sandbox since ${record.at}` };
  if (ev.kind === "swept") {
    // A stage that stopped to wait for CI on its branch's head, whose checks finished with no launch (the event lost).
    if (record?.waiting === "checks" && record.head && record.head === headSha && checksDone) return { stage: record.stage };
    // The dispatcher's pick, or its sweep re-launching an event that was lost: each stage once per cue.
    if (state === "Running" && !runningSince) return { skip: "Running since an unknown time: nothing starts on a guess" };
    if (state === "Running" && launchedSince(record, "work", runningSince)) return { skip: "work already started for this Running stint" };
    const stuck = state === "Running" ? startsBlock(record, runningSince, now) : null;
    if (stuck) return { block: `${stuck} since it became Running` };
    // A review whose starts keep failing Blocks too: one request, three strikes. A vendor's refusals never do.
    const stuckReview = state === "In review" && review?.since && !launchedSince(record, "review", review.since) ? startsBlock(record, review.since, now) : null;
    if (stuckReview) return { block: `${stuckReview.replace("sandbox starts", "sandbox review starts")} since the review was asked for` };
    return dueStage({ state, record, runningSince, review }) || { skip: `${state}: nothing to start` };
  }
  if (ev.kind === "comment") {
    if (!ev.human) return { skip: "a comment by a bot" };
    if (!trusted) return { skip: "a comment by someone who is not a maintainer" };
    // A maintainer's comment on a Question is the answer: back to Queued, as re-applying the label does today.
    return state === "Question" ? { requeue: "a maintainer answered the Question" } : { skip: `${state}: a comment starts nothing` };
  }
  if (ev.kind === "checks") {
    // Only a stage that stopped to wait for CI on this very head resumes, and only while it is still the branch's head.
    if (!ev.sha || ev.sha !== headSha) return { skip: "not the factory branch's head" };
    if (record?.waiting === "checks" && record.head === ev.sha) return { stage: record.stage };
    // CI finished on an In-review PR's head with no stage waiting: the PR may be reviewed and green now, so the
    // dispatcher's merge pass runs on this event rather than on GitHub's cron.
    if (state === "In review") return { tick: "CI finished on the In-review PR's head; the dispatcher's merge pass runs" };
    return { skip: "no stage waits on checks for this head" };
  }
  if (ev.kind === "review") {
    if (ev.draft) return { skip: "a draft PR: the reviewer waits for a human to mark it ready" };
    // The worker marks its PR ready and then labels it; only a person marking it ready is a cue (review.mjs).
    if (ev.ready && !ev.human) return { skip: "ready_for_review is not a review cue" };
    if (review) {
      if (!ev.ready && !review.labelled) return { skip: "the review label is no longer on the PR" };
      // One start per request, whichever event (labeled, ready_for_review) or process (the Action, the sweep) saw it.
      if (launchedSince(record, "review", review.since)) return { skip: "a review already started since it was asked for" };
    } else if (ev.at && launchedSince(record, "review", ev.at)) return { skip: "a review already started after this event" };
    return { stage: "review", pr: ev.pr ?? null };
  }
  return { skip: `unknown event kind ${ev.kind}` };
}

/**
 * Whether the sweep names an Objective again because its stage waits on CI that has finished (the check event lost):
 * the record waits on checks for `head`, which is still the branch's head, the checks on it are done, and the record
 * has waited longer than `graceMs` (the event's own launch gets that long).
 */
export function checksResume(record, { headSha, checksDone, now = Date.now(), graceMs }) {
  return record?.waiting === "checks" && !!record.head && record.head === headSha && !!checksDone && now - Date.parse(record.at) > graceMs;
}

/**
 * The answer to a Question the launcher missed: a maintainer decision (objectiveDecisions: people with write access,
 * never Factory) made after the Question was asked, older than `graceMs` (the comment's own launch gets that long).
 */
export function missedAnswer(decisions, { questionSince, now = Date.now(), graceMs }) {
  const since = Date.parse(questionSince);
  if (!Number.isFinite(since)) return null;
  return (decisions || []).find((d) => Date.parse(d.created_at ?? d.at) > since && now - Date.parse(d.created_at ?? d.at) > graceMs) ?? null;
}

/**
 * What the sweep does with one of Factory's Objective sandboxes (tags `factory=objective`, this repository's id;
 * the caller lists only those). `issue` is the Objective (null when GitHub has none by that number), `state` its
 * state, `record` its sandbox record, `holds` whether a stage holds the sandbox now. Returns
 * `{destroy: reason, collect}` (collect: the record's stage left a usage tarball not yet collected), `{stop: reason,
 * collect}` (the record's own sandbox, running with no stage holding it on an Objective neither Running nor In review)
 * or `{keep: reason, until}`: `until` (ms) is when time alone makes a kept sandbox the sweep's (an end's or a new
 * sandbox's grace; a stopped one's idle days, `idle: true`), the sweep's own next run (sweep.mjs sweepWaits).
 * A sandbox no record names, younger than `graceMs`, is kept: a launcher may be between creating it and recording it.
 */
export function sweepDecision({ sandbox, issue, state, record, holds, now = Date.now(), idleMs, graceMs, endGraceMs = START_LOST_MS }) {
  if (holds) return { keep: "a stage holds it" };
  const mine = record?.id === sandbox.id;
  // A stage that said it ended moments ago: the launcher's end answers it (collects its usage, stops the sandbox, books
  // its cost) within a launch job's time. The sweep a stage's own Block runs leaves it to that end, so the usage comes
  // out once; an end whose event was lost is the sweep's after the grace.
  if (mine && record.state === "ended" && now - Date.parse(record.at) < endGraceMs) return { keep: "its stage ended moments ago; the launcher's end answers it", until: Date.parse(record.at) + endGraceMs };
  // The grace is for a sandbox no record names yet; the record's own sandbox is judged by the record at once, so a
  // short Objective's sandbox goes when it closes, not an hour later.
  if (!mine && now - Date.parse(sandbox.createdAt) < graceMs) return { keep: "created moments ago", until: Date.parse(sandbox.createdAt) + graceMs };
  const collect = mine && typeof record.claim === "string" && !!record.claim && record.collected !== true && typeof record.home === "string";
  if (!issue || issue.state !== "open" || issue.pull_request) return { destroy: "its Objective is closed", collect };
  if (!record) return { destroy: "no sandbox record names it", collect: false };
  if (!mine) return { destroy: "its Objective's record names another sandbox", collect: false };
  if (state === "Running" || state === "In review") return { keep: `the Objective is ${state}` };
  // Running with no stage holding it, on an Objective off the Running and review path (a Block for a vanished stage, a
  // stage that died, a stop that failed): an end never answered. It stops, and its vendor cost is booked, as a stage's
  // end would do; the stopped sandbox then waits out the idle days like any other.
  if (sandbox.state === "running") return { stop: `running with no stage holding it, the Objective ${state}`, collect };
  const last = Date.parse(record.at) || Date.parse(sandbox.createdAt);
  if (sandbox.state === "stopped" && now - last > idleMs) return { destroy: `stopped ${Math.floor((now - last) / 86_400_000)} days, the Objective ${state}`, collect };
  return { keep: `${sandbox.state}, the Objective ${state}`, ...(sandbox.state === "stopped" && Number.isFinite(last) ? { until: last + idleMs, idle: true } : {}) };
}

/** How long an Objective waits, from the first start the vendor refused for its quota, before it is handed back Blocked. */
export const QUOTA_WAIT_MS = 90 * 60_000;
/** The waits between tries after a quota refusal: the first, the second, then every later one. */
export const QUOTA_BACKOFF_MS = Object.freeze([5 * 60_000, 10 * 60_000, 20 * 60_000]);
/** Refused tries in one streak before it is handed back, however fast they came (the backoff fits 7 in the wait). */
export const QUOTA_MAX_TRIES = 8;
/**
 * A streak older than this is a past episode's (the Objective was Blocked or stopped another way in between), so a
 * refusal now starts a new one. Between the wait's end and this, a late try (the dispatcher's cron fired late) gives up.
 */
export const QUOTA_STREAK_MS = 24 * 3600_000;

/**
 * The next step after the vendor refused a start for its quota (SandboxError `quota`, HTTP 402), from the record's
 * `quota` ({since, tries, retryAt}: the streak so far, or none). The streak goes on from its first refusal (`since`)
 * until a start succeeds (which clears it) or QUOTA_STREAK_MS has passed; how late the retry came does not restart it.
 * Returns {since, tries, retryAt} (try again at retryAt, never past since + the wait) or {giveUp: true, since, tries,
 * waitedMs} once the wait is spent or QUOTA_MAX_TRIES refusals are counted.
 */
export function quotaBackoff(prev, now = Date.now()) {
  const first = Date.parse(prev?.since);
  const going = Number.isFinite(first) && first <= now && now - first < QUOTA_STREAK_MS;
  const since = going ? new Date(first).toISOString() : new Date(now).toISOString();
  const tries = (going && Number.isSafeInteger(prev.tries) && prev.tries > 0 ? prev.tries : 0) + 1;
  const waitedMs = now - Date.parse(since);
  if (waitedMs >= QUOTA_WAIT_MS || tries >= QUOTA_MAX_TRIES) return { giveUp: true, since, tries, waitedMs };
  const step = QUOTA_BACKOFF_MS[Math.min(tries, QUOTA_BACKOFF_MS.length) - 1];
  return { since, tries, retryAt: new Date(Math.min(now + step, Date.parse(since) + QUOTA_WAIT_MS)).toISOString() };
}

/** Whether the record says the Objective waits out a quota refusal now: its retry time not reached. */
export const quotaWaiting = (record, now = Date.now()) => Number.isFinite(Date.parse(record?.quota?.retryAt)) && now < Date.parse(record.quota.retryAt);

/**
 * The dispatcher's own next tick (workflow-template.yml `wake`). Each run lists its deadlines: `{issue, kind, at}`, a
 * moment at which only time, not an event, changes what the dispatcher does. A wake job sleeps only to these kinds:
 * - `lease`: a sandbox stage's lease end plus WAKE_SLACK_MS (a stage that died silently frees its Objective then);
 * - `quota`: the retry time of a start the vendor's quota refused (the launcher handed the wait over);
 * - `start-retry`: the next try of a stage whose start failed another way (startRetryAt), three strikes then Blocked;
 * - `daily-cap`: the next 00:00 UTC, when daily_usd held Queued work back;
 * - `retry`: a read this run could not make, read again soon; never armed by a run a retry wake started.
 * The rest are their owners' (an event's launch, a local loop's serve) and the cron's backstop; the run lists them so
 * its log shows every wait: `launch-grace`, `review-grace`, `checks-grace`, `answer-grace`, `local-pause`.
 * On the sandbox route the sweep and the image job arm wakes of their own, whose tick runs the sweep:
 * - `sweep`: a sweep wait of minutes (a stage's end grace, a new sandbox's grace, a superseded image's last minutes,
 *   the rest of a run that reached a cap), on every repository.
 * Every wake's tick is a `workflow_dispatch`, so it also ticks the dispatcher.
 */
export const DISPATCH_WAKE_KINDS = Object.freeze(["lease", "quota", "start-retry", "daily-cap", "retry"]);
/** Every kind a wake job is named for and its tick carries (parseWake reads only these). */
export const WAKE_KINDS = Object.freeze([...DISPATCH_WAKE_KINDS, "sweep"]);
/**
 * The kinds a repository's dispatcher arms. A public repository's Actions minutes are free, so it sleeps to every kind. A private
 * one pays for each sleeper's minutes, so it sleeps only to the short ones (`quota`, `start-retry`, `retry`); a stage's lease end and
 * the UTC day's turn, which can keep a sleeper up for hours, wait for an event or GitHub's cron backstop there. An
 * unknown visibility counts as private.
 */
export const wakeKinds = (isPublic) => (isPublic === true ? DISPATCH_WAKE_KINDS : Object.freeze(["quota", "start-retry", "retry"]));
/** The kinds the sweep and the image job arm: `sweep` only, minutes each, so on every repository. */
export const SWEEP_WAKE_KINDS = Object.freeze(["sweep"]);
/** A wake fires at most this long after its deadline, and covers any deadline this long after its own. */
export const WAKE_SLACK_MS = 60_000;
/** How soon a `retry` wake reads again. */
export const RETRY_WAKE_MS = 2 * 60_000;
/** The longest one wake job sleeps (hosted runners end a job at six hours): a later deadline is reached in hops. */
export const WAKE_MAX_SLEEP_S = 350 * 60;

/**
 * When an armed wake actually ticks (ms), or null when that is not known yet: a sleep is capped at WAKE_MAX_SLEEP_S from
 * its job's start, so a wake named for a deadline further out ticks at that cap (a plain hop) and never at its name. A
 * wake not started yet with such a deadline has no known tick, so it covers nothing.
 */
export function wakeFiresAt({ at, startedAt = null }, now = Date.now()) {
  const t = Date.parse(at);
  const cap = WAKE_MAX_SLEEP_S * 1000;
  if (!Number.isFinite(t)) return null;
  const s = Date.parse(startedAt);
  if (Number.isFinite(s)) return Math.min(t, s + cap);
  return t - now <= cap ? t : null;
}

/** The next 00:00 UTC after `now` (ms), when today's spend starts over. */
export const nextUtcMidnight = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

// Every kind a wake is armed for: a kind this does not read is a sleeper the dispatcher never sees, so they pile up.
const WAKE = new RegExp(`^(${WAKE_KINDS.join("|")}) (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z)$`);
/** A wake's `{kind, at}` from its job name (`wake (<kind> <iso>)`) or its tick's `wake` input (`<kind> <iso>`); else null. */
export function parseWake(text) {
  const m = WAKE.exec(String(text ?? "").replace(/^wake \((.*)\)$/, "$1"));
  return m && Number.isFinite(Date.parse(m[2])) ? { kind: m[1], at: m[2] } : null;
}

/**
 * The one wake this run arms, `{kind, at, issue}`, or null. Only `kinds` (wakeKinds), only deadlines still ahead of `now`, the
 * earliest first. None when a wake already queued or sleeping (`armed`, from the job names) fires before it or within
 * WAKE_SLACK_MS after it: that wake's tick arms the rest, so sleepers never pile up and none is ever cancelled. A run a
 * wake started (`firedBy`, its tick's input) never arms that same deadline again (a runner clock behind the sleeper's
 * would loop on it), nor any retry after a retry wake (a read that keeps failing waits for the next event or the cron).
 */
export function nextWake(deadlines, { now = Date.now(), armed = [], firedBy = null, kinds = WAKE_KINDS } = {}) {
  const fired = firedBy ? Date.parse(firedBy.at) : NaN;
  const ahead = (deadlines || [])
    .filter((d) => kinds.includes(d?.kind) && Date.parse(d.at) > now)
    .filter((d) => !(firedBy?.kind === d.kind && (d.kind === "retry" || Date.parse(d.at) === fired)));
  if (!ahead.length) return null;
  const first = ahead.reduce((a, b) => (Date.parse(b.at) < Date.parse(a.at) ? b : a));
  const at = Date.parse(first.at);
  // A wake covers this deadline when it ticks after now and no later than the slack past it: by when it ticks, not by
  // its name, since a hop ticks long before the deadline it is named for.
  if ((armed || []).some((w) => {
    const fires = wakeFiresAt(w, now);
    return fires !== null && fires > now && fires <= at + WAKE_SLACK_MS;
  })) return null;
  return { kind: first.kind, at: new Date(at).toISOString(), issue: first.issue ?? null };
}

/** Event time to command start, in milliseconds, or null when either end is unknown. */
export function dispatchLatency(eventAt, commandAt) {
  const a = Date.parse(eventAt);
  const b = Date.parse(commandAt);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

/**
 * Milliseconds per sub-step of a launch or a dispatcher tick, in the order they ran: `mark(name)` books the time since
 * the last mark (or the start) to `name`, adding to it when a step repeats. `phase(p)` is the same clock booking under
 * `p.<name>`, so a launch that ends one stage and starts the next keeps the end's steps apart from the start's. The job
 * log's timing line and a launch's record entry (`ms`) carry it, so a drill reads where the time went without the job
 * log's timestamps.
 */
export function stopwatch(now = Date.now) {
  let last = now();
  const ms = {};
  const view = (prefix) => ({
    ms,
    mark(name) {
      const t = now();
      const key = `${prefix}${name}`;
      ms[key] = (ms[key] ?? 0) + (t - last);
      last = t;
    },
    phase: (p) => view(`${prefix}${p}.`),
  });
  return view("");
}

/** The log's line for a stopwatch's `ms`: each sub-step in order, in seconds, then their sum. */
export function timingLine(ms) {
  const steps = Object.entries(ms || {}).filter(([, v]) => Number.isFinite(v));
  const s = (v) => `${(v / 1000).toFixed(1)} s`;
  return steps.length ? `${steps.map(([k, v]) => `${k} ${s(v)}`).join(", ")}; total ${s(steps.reduce((a, [, v]) => a + v, 0))}` : "";
}

/** `fn` over `items`, at most `size` at a time, results in the items' order. */
export async function pooled(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, size), items.length) }, lane));
  return out;
}
