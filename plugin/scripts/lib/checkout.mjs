// The worker's checkout: the branch, the plugin's skills and agent definitions
// written in (git-excluded, never committed), the repository's validation and
// setup commands, and the commit guard for protected paths.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { putFiles, readAgentTree } from "./handoff.mjs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentUser, exec } from "./proc.mjs";
import { scrubbedEnv } from "./harness.mjs";
import { backend } from "./backend.mjs";
import { validationGroups } from "./logic.mjs";
import { noReplace, serverBase } from "./lfs.mjs";
import { parseYaml } from "./yaml.mjs";
import { prepareClaudeHome, prepareFactoryHome, runnerLayout } from "./claude-runner.mjs";
import { CODEX_RUNNER_HOME } from "./codex-runner.mjs";
import { copilotRunnerLayout, prepareCopilotHome } from "./copilot-runner.mjs";

/** The plugin root: these scripts live in it (plugin/scripts/lib), beside skills/, agents/ and templates/; FACTORY_PLUGIN_ROOT overrides. */
export const PLUGIN_ROOT = process.env.FACTORY_PLUGIN_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Kept for callers that name the scripts' home; it is the plugin now. */
export const ACTION_ROOT = PLUGIN_ROOT;

/** Where each harness reads skills and agents from, relative to the checkout. */
export const SKILL_DIRS = [".agents/skills", ".claude/skills"];
export const AGENT_DIRS = { claude: ".claude/agents", codex: ".codex/agents", copilot: ".github/agents" };
const AGENT_SOURCE = { claude: "agents/claude", codex: "agents/codex", copilot: "agents/copilot" };

/**
 * Copy the plugin's skills to .agents/skills and .claude/skills, mirror the
 * repository's own .agents/skills into .claude/skills (Claude Code reads only the
 * latter; Codex and Copilot read .agents/skills), and write the active harness's
 * agent definitions, without overwriting a repository file of the same name (an
 * adopter's override wins). `models` rewrites the pinned model lines from the
 * job's subagent_model / reviewer_model inputs when given. Everything written is
 * added to .git/info/exclude so the worker cannot commit it. All of it is done in the
 * agent's sandbox (backend.mjs sandbox.git, handoff.mjs putFiles), never by Factory on
 * the host. Returns the paths written.
 */
export async function installPlugin(checkout, pluginRoot = PLUGIN_ROOT, { harness = null, models = {}, env = process.env } = {}) {
  const files = {};
  const skillsSrc = join(pluginRoot, "skills");
  if (!existsSync(skillsSrc)) throw new Error(`plugin skills not found at ${skillsSrc}`);
  const walk = (src, rel) => {
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(src, e.name), join(rel, e.name));
      else if (e.isFile()) files[join(rel, e.name)] = { text: readFileSync(join(src, e.name), "utf8") };
    }
  };
  for (const dir of SKILL_DIRS) for (const name of readdirSync(skillsSrc)) walk(join(skillsSrc, name), join(dir, name));
  for (const [h, dir] of Object.entries(AGENT_DIRS)) {
    if (harness && h !== harness) continue;
    const src = join(pluginRoot, AGENT_SOURCE[h]);
    if (!existsSync(src)) continue;
    for (const file of readdirSync(src)) {
      const role = file.replace(/\..*$/, "");
      const model = role === "implementer" ? models.subagent : role === "reviewer" ? models.reviewer : null;
      const text = readFileSync(join(src, file), "utf8");
      files[join(dir, file)] = { text: model ? pinModel(text, h, model) : text };
    }
  }
  const inSandbox = (script, args = []) => exec(...backend(env).sandbox.git(["sh", "-c", script, "sh", ...args], env), { cwd: checkout, env });
  // A skill directory or agent file the repository already has is its override, whole: none of the plugin's go into it.
  const tops = [...new Set(Object.keys(files).map((f) => f.split("/").slice(0, 3).join("/")))];
  const overridden = (await inSandbox('cd "$1" && shift && for d in "$@"; do [ -e "$d" ] || [ -L "$d" ] && printf "%s\n" "$d"; done; true', [checkout, ...tops])).stdout.split("\n").filter(Boolean);
  for (const f of Object.keys(files)) if (overridden.some((d) => f === d || f.startsWith(`${d}/`))) delete files[f];
  const wrote = await putFiles(checkout, files, env);
  // The repository's own .agents/skills mirrored into .claude/skills.
  const mirrored = (await inSandbox('cd "$1/.agents/skills" 2>/dev/null || exit 0; for d in */; do d="${d%/}"; [ -f "$d/SKILL.md" ] && [ ! -e "../../.claude/skills/$d" ] && [ ! -L "$d" ] && mkdir -p ../../.claude/skills && cp -R "$d" "../../.claude/skills/$d" && printf ".claude/skills/%s\n" "$d"; done; true', [checkout])).stdout.split("\n").filter(Boolean);
  const written = [...new Set([...wrote.map((f) => f.split("/").slice(0, 3).join("/")), ...mirrored])];
  await excludeFromGit(checkout, written, env);
  const local = backend(env).sandbox.harness(env);
  if (harness === "claude" && local?.claudeDir) await claudePlugin(checkout, local.claudeDir, env);
  // On a runner and in a cloud sandbox VM the same copy, in Factory's own HOME for Claude Code, made afresh first
  // (lib/claude-runner.mjs): the agent reads it and never writes it.
  else if (harness === "claude" && agentUser() && backend(env).name !== "local") {
    const layout = runnerLayout(agentUser());
    await prepareClaudeHome(layout);
    await claudePlugin(checkout, layout.pluginDir, env, { shared: true });
  }
  // Codex's HOME on a runner: Factory's own, empty, made afresh (lib/codex-runner.mjs).
  else if (harness === "codex" && agentUser() && backend(env).name !== "local") await prepareFactoryHome(CODEX_RUNNER_HOME, "Codex");
  // Copilot's: Factory's own, with its bwrap and the release its binary runs, unpacked by Factory (lib/copilot-runner.mjs).
  else if (harness === "copilot" && agentUser() && backend(env).name !== "local") await prepareCopilotHome(copilotRunnerLayout(agentUser()), { env });
  return written;
}

/**
 * A sandboxed Claude Code run's skills and agent definitions (local mode, and a runner's in Factory's HOME for it): the clone's .claude/skills and .claude/agents as installPlugin
 * left them (Factory's, the repository's own and its mirrored .agents/skills), copied out in the git sandbox into `dir`,
 * a directory of the stage's usage directory that no sandbox may write. Claude Code loads them from there (harness.mjs)
 * and never reads the clone's .claude, which sandboxed code can write. The skills become a plugin named factory (a skill
 * is then factory:<name>); the agents keep their names in an --agents file holding only their description, prompt, tools
 * and model, so no hook, MCP server or permission mode an agent file declares applies.
 */
export async function claudePlugin(checkout, dir, env = process.env, { shared = false } = {}) {
  const files = claudePluginFiles(await readAgentTree(checkout, [".claude/skills", ".claude/agents"], env));
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  // `shared`: a runner's agent uid reads it, whatever this process's umask (a sandbox stage's is 077).
  if (shared) {
    const open = (p) => {
      chmodSync(p, 0o755);
      for (const e of readdirSync(p, { withFileTypes: true })) e.isDirectory() ? open(join(p, e.name)) : chmodSync(join(p, e.name), 0o644);
    };
    open(dir);
  }
}

/** claudePlugin's files, by path under its directory: the plugin's manifest and skills, and agents.json. */
export function claudePluginFiles(tree) {
  const files = { "plugin/.claude-plugin/plugin.json": `${JSON.stringify({ name: "factory" })}\n` };
  const agents = {};
  for (const [rel, text] of Object.entries(tree)) {
    if (typeof text !== "string" || rel.split("/").some((p) => p === "" || p === "." || p === "..")) continue;
    if (rel.startsWith(".claude/skills/")) files[join("plugin", "skills", rel.slice(".claude/skills/".length))] = text;
    else if (/^\.claude\/agents\/[^/]+\.md$/.test(rel)) {
      const a = agentDefinition(text, basename(rel, ".md"));
      if (a) agents[a.name] = a.definition;
    }
  }
  files["agents.json"] = `${JSON.stringify(agents)}\n`;
  return files;
}

/** A Claude Code agent file (front matter, then the prompt) as an --agents entry with only the safe fields; null when unreadable. */
export function agentDefinition(text, fallbackName) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  let fm;
  try {
    fm = parseYaml(m[1]);
  } catch {
    return null;
  }
  if (!fm || typeof fm !== "object" || typeof fm.description !== "string") return null;
  const name = typeof fm.name === "string" && /^[A-Za-z0-9_-]+$/.test(fm.name) ? fm.name : fallbackName;
  const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((t) => t.trim()).filter(Boolean) : undefined);
  const definition = { description: fm.description, prompt: m[2].trim() };
  if (list(fm.tools)) definition.tools = list(fm.tools);
  if (list(fm.disallowedTools)) definition.disallowedTools = list(fm.disallowedTools);
  if (typeof fm.model === "string") definition.model = fm.model;
  return { name, definition };
}

/** Rewrite the pinned model line of an agent definition in its harness's format. */
export function pinModel(text, harness, model) {
  if (harness === "codex") return /^model\s*=/m.test(text) ? text.replace(/^model\s*=.*$/m, `model = ${JSON.stringify(model)}`) : `${text.trimEnd()}\nmodel = ${JSON.stringify(model)}\n`;
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return text;
  let front = fm[1];
  front = /^model:/m.test(front) ? front.replace(/^model:.*$/m, `model: ${model}`) : `${front}\nmodel: ${model}`;
  if (harness === "copilot" && !/^model-policy:/m.test(front)) front += "\nmodel-policy: required";
  return text.replace(fm[0], `---\n${front}\n---`);
}

/** Append paths to .git/info/exclude (local, never committed), in the agent's sandbox. */
export async function excludeFromGit(checkout, paths, env = process.env) {
  if (!paths.length) return;
  await exec(...backend(env).sandbox.git(["sh", "-c", 'f="$1/.git/info/exclude"; shift; mkdir -p "${f%/*}"; for p in "$@"; do grep -qxF "$p" "$f" 2>/dev/null || printf "%s\n" "$p" >> "$f"; done', "sh", checkout, ...paths.map((p) => `/${p}`)], env), { env });
}

/**
 * The paths a stage changed: those that differ between `start` and HEAD, less those the branch took from the default
 * branch by a rebase or merge. A path is taken from the default branch when HEAD has it as the default branch has it
 * (at HEAD's merge-base with origin's tip, read from the server: lfs.mjs serverBase) and the branch had not changed it
 * by `start`. `start` is the commit Factory read before any harness ran, so what a maintainer or an earlier stage pushed
 * is not the stage's, and commit authors play no part; a stage that reverts such a change made that change. Replace refs
 * and grafts are ignored; when the default branch cannot be read, every changed path counts.
 */
export async function stageChanges(checkout, start, env = process.env) {
  const safe = noReplace(env);
  const names = async (a, b) => {
    const r = await exec("git", ["diff", "--no-renames", "--no-relative", "--name-only", "-z", a, b, "--"], { cwd: checkout, env: safe });
    if (r.code !== 0) throw new Error(`git diff ${a} ${b} failed: ${String(r.stderr).trim().slice(0, 200)}`);
    return r.stdout.split("\0").filter(Boolean);
  };
  const changed = await names(start, "HEAD");
  if (!changed.length) return [];
  const taken = await serverBase(checkout, env).catch(() => null);
  const mb = taken ? await exec("git", ["merge-base", start, taken], { cwd: checkout, env: safe }) : null;
  const startBase = mb?.code === 0 ? mb.stdout.trim() : "";
  if (!startBase) return changed;
  const own = new Set([...(await names(taken, "HEAD")), ...(await names(startBase, start))]);
  return changed.filter((f) => own.has(f));
}

/**
 * Run one shell command in the checkout with the model secrets scrubbed from its env, in the backend's sandbox (on
 * Actions, as the agent uid). `asRunner`: the repository's `setup`, which may need sudo, runs as the runner uid on a
 * clean default-branch tree Factory made, never on branch code.
 */
export async function sh(checkout, command, { timeoutMs, env = process.env, extraEnv = {}, echo = true, asRunner = false, reap = true } = {}) {
  const childEnv = scrubbedEnv(env, extraEnv);
  const [cmd, args] = asRunner ? ["bash", ["-eo", "pipefail", "-c", command]] : backend(childEnv).sandbox.command(["bash", "-eo", "pipefail", "-c", command], childEnv);
  const r = await exec(cmd, args, { cwd: checkout, env: childEnv, timeoutMs, echo });
  if (!asRunner && reap) await backend(childEnv).sandbox.reap();
  return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, output: `${r.stdout}\n${r.stderr}`.trim() };
}

/**
 * The commit identity a child of the job sees. The job runs on the dispatching event (an issue
 * on main, a pull_request merge ref), so its GITHUB_SHA and GITHUB_REF name a commit the checkout
 * is not on; a repository's own CI scripts that assert HEAD equals GITHUB_SHA would fail for
 * every branch with commits. Children get the Factory branch as the ref and no GITHUB_SHA;
 * each validation pass sets GITHUB_SHA to the HEAD it tests (runValidation).
 */
export function branchIdentity(branch) {
  return { GITHUB_REF: `refs/heads/${branch}`, GITHUB_REF_NAME: branch, GITHUB_SHA: undefined };
}

/**
 * What a setup command wrote to the runner's GITHUB_PATH and GITHUB_ENV files (a repository's
 * toolchain script does that as a CI step would), as env additions for the job's later children:
 * PATH with the new directories first, and each KEY=value or KEY<<DELIM block. Empty off a runner.
 */
export function runnerFileEnv(env = process.env) {
  const out = {};
  const read = (file) => (file && existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : []);
  const dirs = read(env.GITHUB_PATH).map((l) => l.trim()).filter(Boolean);
  if (dirs.length) {
    const have = String(env.PATH || "").split(":");
    const fresh = [...new Set(dirs)].filter((d) => !have.includes(d));
    if (fresh.length) out.PATH = [...fresh, ...have].join(":");
  }
  const lines = read(env.GITHUB_ENV);
  for (let i = 0; i < lines.length; i += 1) {
    const block = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(lines[i]);
    if (block) {
      const body = [];
      for (i += 1; i < lines.length && lines[i] !== block[2]; i += 1) body.push(lines[i]);
      out[block[1]] = body.join("\n");
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(lines[i]);
    if (pair) out[pair[1]] = pair[2];
  }
  return out;
}

/**
 * Run the validation commands in order, each group of `parallel:` ones at once (validationGroups); stop after the
 * first group with a failure. Every failure of that group is reported (`failures`, `failed` the first), each with the
 * tail of its output for the prompt (`output`) and up to 256 KB of it (`full`), which the fix run reads in
 * $FACTORY_IN/checks/; Factory writes no log file of its own. GITHUB_SHA is the HEAD under test.
 */
export async function runValidation(checkout, commands, opts = {}) {
  const results = [];
  // The HEAD under test, read in the agent's sandbox: Factory runs no git on the host in the agent's checkout.
  const env = opts.env || process.env;
  // Factory's git there gets no secret: neither the harness's credential nor the worker secrets' carrier (scrubbedEnv).
  const gitEnv = scrubbedEnv(env);
  const head = (await exec(...backend(gitEnv).sandbox.git(["git", "-C", checkout, "rev-parse", "HEAD"], gitEnv), { env: gitEnv }).catch(() => ({ stdout: "" }))).stdout.trim();
  // FACTORY_DB_WRAP: only validation commands get a throwaway database (sh), not setup or install.
  const extraEnv = { ...(opts.extraEnv || {}), ...(head ? { GITHUB_SHA: head } : {}), FACTORY_DB_WRAP: "1" };
  const shOpts = opts;
  for (const group of validationGroups(commands)) {
    // Interleaved live output from several commands helps no one; a group's commands report as each ends.
    // Commands of one group run side by side: the agent's leftovers are reaped once the whole group is done.
    const runs = await Promise.all(group.map((command) => sh(checkout, command, { ...shOpts, extraEnv, echo: group.length === 1, reap: false })));
    await backend(shOpts.env || process.env).sandbox.reap();
    const done = runs.map((r, i) => ({ command: group[i], ...r, output: r.output.slice(-20_000), full: r.ok ? "" : r.output.slice(-256 * 1024) }));
    if (group.length > 1) for (const r of done) process.stdout.write(`[factory] ${r.ok ? "passed" : r.timedOut ? "timed out" : `failed (exit ${r.code})`}: ${r.command}\n`);
    results.push(...done);
    const failures = done.filter((r) => !r.ok);
    if (failures.length) return { green: false, results, failed: failures[0], failures, head };
  }
  return { green: true, results, failed: null, failures: [], head };
}

// Run by `node` in the checkout's sandbox (installDeps), as Factory's other commands on the agent's tree are.
// `check`: every direct dependency of each package.json (not below node_modules) that the install linked is whole: the
// link resolves, its package.json is there and each bin it declares exists. A dependency not linked at all is skipped
// (hoisted or filtered), and so are local packages (resolved outside node_modules: a workspace's bins may be build
// output) and packages with install scripts (their files may come from the scripts Factory skips). Exit 3 with the
// missing paths as JSON on the last line, 0 when nothing is missing. `clear`: each node_modules directory emptied,
// the package caches Factory keeps in the clone (pnpm's store, Bun's cache) kept, nothing followed through a link.
const INSTALL_CHECK = String.raw`
const fs = require("fs"), path = require("path");
const mode = process.argv[1], root = process.cwd();
const keep = [process.env.pnpm_config_store_dir, process.env.npm_config_store_dir, process.env.BUN_INSTALL_CACHE_DIR].filter(Boolean).map((p) => path.resolve(root, p));
const dirs = [], mods = [];
const walk = (d) => {
  let es;
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  if (es.some((e) => e.name === "package.json" && e.isFile())) dirs.push(d);
  for (const e of es) {
    if (!e.isDirectory() || e.name === ".git") continue;
    if (e.name === "node_modules") { mods.push(path.join(d, e.name)); continue; }
    walk(path.join(d, e.name));
  }
};
walk(root);
if (mode === "clear") {
  for (const m of mods) for (const e of fs.readdirSync(m)) {
    const p = path.join(m, e);
    if (keep.some((k) => k === p || k.startsWith(p + path.sep))) continue;
    fs.rmSync(p, { recursive: true, force: true });
  }
  process.exit(0);
}
const missing = [];
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const LOCAL = /^(workspace|link|file|portal):/;
for (const d of dirs) {
  const pkg = read(path.join(d, "package.json")) || {};
  const optional = pkg.optionalDependencies || {};
  const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  for (const [name, spec] of Object.entries(deps)) {
    if (name in optional || LOCAL.test(String(spec))) continue;
    const at = path.join(d, "node_modules", name);
    if (!fs.lstatSync(at, { throwIfNoEntry: false })) continue;
    let real;
    try { real = fs.realpathSync(at); } catch { missing.push(path.relative(root, at)); continue; }
    if (!real.split(path.sep).includes("node_modules")) continue;
    const dep = read(path.join(at, "package.json"));
    if (!dep) { missing.push(path.relative(root, path.join(at, "package.json"))); continue; }
    const s = dep.scripts || {};
    if (s.preinstall || s.install || s.postinstall) continue;
    const bins = typeof dep.bin === "string" ? [dep.bin] : Object.values(dep.bin || {});
    for (const b of bins) if (typeof b === "string" && !fs.existsSync(path.join(at, b))) missing.push(path.relative(root, path.join(at, b)));
  }
}
process.stdout.write("\n" + JSON.stringify({ missing }) + "\n");
process.exit(missing.length ? 3 : 0);
`;

/** installDeps's install check: exit 3 means the install left paths missing, any other failure means no check ran. */
async function installGaps(checkout, opts) {
  if (!existsSync(join(checkout, "node_modules"))) return [];
  const r = await sh(checkout, 'node -e "$FACTORY_INSTALL_CHECK" check', { ...opts, extraEnv: { FACTORY_INSTALL_CHECK: INSTALL_CHECK }, echo: false });
  if (r.code !== 3) return [];
  try {
    return JSON.parse(r.output.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)).missing.map(String);
  } catch {
    return [];
  }
}

/**
 * The repository's install in the checkout, checked: its exit code, then (for a Node install) whether it left a
 * linked dependency or a declared binary missing. A failed or incomplete install gets one repair: the node_modules
 * directories emptied (Factory's package caches kept) and the install run again. Returns {ok} or {ok: false, reason},
 * the reason naming the install as infrastructure, never as a validation result: what follows an install that did not
 * finish is no verdict on the branch. A timed-out install is not retried (the stage's deadline is spent).
 */
export async function installDeps(checkout, command, { timeoutMs, env = process.env, now = Date.now } = {}) {
  const started = now();
  const left = () => (timeoutMs ? Math.max(1000, timeoutMs - (now() - started)) : timeoutMs);
  const attempt = async () => {
    const r = await sh(checkout, command, { env, timeoutMs: left() });
    if (!r.ok) return { ok: false, code: r.code, timedOut: r.timedOut, missing: [] };
    const missing = await installGaps(checkout, { env, timeoutMs: left() });
    return { ok: !missing.length, code: 0, timedOut: false, missing };
  };
  const first = await attempt();
  if (first.ok) return { ok: true, repaired: false };
  const what = (a) => (a.timedOut ? "timed out" : a.missing.length ? `exited 0 but left ${a.missing.slice(0, 3).join(", ")}${a.missing.length > 3 ? ` and ${a.missing.length - 3} more` : ""} missing` : `exited ${a.code ?? "on a signal"}`);
  const infra = (detail) => `install failed (infrastructure, not a validation result; validation did not run): ${command} ${detail}`;
  if (first.timedOut) return { ok: false, reason: infra(what(first)), missing: [] };
  const cleared = existsSync(join(checkout, "node_modules")) ? await sh(checkout, 'node -e "$FACTORY_INSTALL_CHECK" clear', { env, extraEnv: { FACTORY_INSTALL_CHECK: INSTALL_CHECK }, timeoutMs: left(), echo: false }) : { ok: true };
  const second = await attempt();
  if (second.ok) return { ok: true, repaired: true, first: what(first) };
  return { ok: false, reason: infra(`${what(first)}, and again after a clean reinstall${cleared.ok ? "" : " (node_modules could not be cleared)"}: ${what(second)}`), missing: second.missing };
}

/**
 * Pick the install command from the lockfile present: the versions it pins, over the network (pnpm tries its store
 * offline first). npm, pnpm and yarn run no install scripts (--ignore-scripts); poetry and uv run a source package's
 * build. It runs with the stage's scrubbed env (sh), so no credential. `install: none` skips; a given command wins.
 */
export function installCommand(checkout, setting = "auto") {
  if (setting && setting !== "auto") return setting === "none" ? null : setting;
  const has = (f) => existsSync(join(checkout, f));
  if (has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile --offline --ignore-scripts || pnpm install --frozen-lockfile --ignore-scripts";
  if (has("package-lock.json")) return "npm ci --ignore-scripts";
  if (has("yarn.lock")) return "yarn install --frozen-lockfile --ignore-scripts";
  if (has("Cargo.lock")) return "cargo fetch --locked";
  if (has("poetry.lock")) return "poetry install --no-root";
  if (has("uv.lock")) return "uv sync --frozen";
  if (has("go.sum")) return "go mod download";
  return null;
}
