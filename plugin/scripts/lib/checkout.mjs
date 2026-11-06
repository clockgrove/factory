// The worker's checkout: the branch, the plugin's skills and agent definitions
// written in (git-excluded, never committed), the repository's validation and
// setup commands, and the commit guard for protected paths.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, git } from "./proc.mjs";
import { scrubbedEnv } from "./harness.mjs";

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
 * added to .git/info/exclude so the worker cannot commit it. Returns the paths written.
 */
export function installPlugin(checkout, pluginRoot = PLUGIN_ROOT, { harness = null, models = {} } = {}) {
  const written = [];
  const skillsSrc = join(pluginRoot, "skills");
  if (!existsSync(skillsSrc)) throw new Error(`plugin skills not found at ${skillsSrc}`);
  for (const dir of SKILL_DIRS) {
    for (const name of readdirSync(skillsSrc)) {
      const src = join(skillsSrc, name);
      const dst = join(checkout, dir, name);
      if (existsSync(dst)) continue; // repository override
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
      written.push(join(dir, name));
    }
  }
  const repoSkills = join(checkout, ".agents", "skills");
  if (existsSync(repoSkills)) {
    for (const name of readdirSync(repoSkills)) {
      const src = join(repoSkills, name);
      const dst = join(checkout, ".claude", "skills", name);
      if (existsSync(dst) || !existsSync(join(src, "SKILL.md"))) continue;
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
      written.push(join(".claude", "skills", name));
    }
  }
  for (const [h, dir] of Object.entries(AGENT_DIRS)) {
    if (harness && h !== harness) continue;
    const src = join(pluginRoot, AGENT_SOURCE[h]);
    if (!existsSync(src)) continue;
    for (const file of readdirSync(src)) {
      const dst = join(checkout, dir, file);
      if (existsSync(dst)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      const role = file.replace(/\..*$/, "");
      const model = role === "implementer" ? models.subagent : role === "reviewer" ? models.reviewer : null;
      writeFileSync(dst, model ? pinModel(readFileSync(join(src, file), "utf8"), h, model) : readFileSync(join(src, file), "utf8"));
      written.push(join(dir, file));
    }
  }
  excludeFromGit(checkout, written);
  return written;
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

/** Append paths to .git/info/exclude (local, never committed). */
export function excludeFromGit(checkout, paths) {
  const file = join(checkout, ".git", "info", "exclude");
  if (!existsSync(dirname(file))) return;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = paths.map((p) => `/${p}`).filter((p) => !current.includes(p));
  if (lines.length) writeFileSync(file, `${current.trimEnd()}\n# factory (written per run, never committed)\n${lines.join("\n")}\n`);
}

/** Create or reset factory/<issue> from the default branch; reuse the remote branch when it exists (rerun). */
export async function prepareBranch(checkout, { issue, defaultBranch, remote = "origin" }) {
  const branch = `factory/${issue}`;
  await git(checkout, ["fetch", remote, defaultBranch]);
  // git cannot hold factory/<issue> beside factory/<issue>/<anything> (a ref is a file or a
  // directory, not both): an earlier tool's branches under that name block every push. Found
  // here, before any harness spend, and named so the owner can delete or rename them.
  const under = await exec("git", ["ls-remote", "--heads", remote, `${branch}/*`], { cwd: checkout });
  const colliding = under.code === 0 ? under.stdout.split("\n").map((l) => l.split("\t")[1]).filter(Boolean).map((r) => r.replace(/^refs\/heads\//, "")) : [];
  if (colliding.length) {
    const e = new Error(`branch ${branch} cannot be created: ${colliding.join(", ")} exist${colliding.length > 1 ? "" : "s"} on ${remote} (delete or rename them)`);
    e.code = "ref-collision";
    e.refs = colliding;
    throw e;
  }
  const existing = await exec("git", ["ls-remote", "--heads", remote, branch], { cwd: checkout });
  const base = (await git(checkout, ["rev-parse", `${remote}/${defaultBranch}`])).stdout.trim();
  if (existing.code === 0 && existing.stdout.trim()) {
    await git(checkout, ["fetch", remote, branch]);
    await git(checkout, ["checkout", "-B", branch, `${remote}/${branch}`]);
    return { branch, base, resumed: true };
  }
  await git(checkout, ["checkout", "-B", branch, `${remote}/${defaultBranch}`]);
  return { branch, base, resumed: false };
}

/** Commits on the branch beyond the base, and the files they touch. */
export async function branchDelta(checkout, base, branch = "HEAD") {
  const count = Number((await git(checkout, ["rev-list", "--count", `${base}..${branch}`])).stdout.trim()) || 0;
  const files = count ? (await git(checkout, ["diff", "--name-only", `${base}...${branch}`])).stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  return { count, files };
}

/** Run one shell command in the checkout with the model secrets scrubbed from its env. */
// In local mode (FACTORY_LOCAL_SRT names an srt settings file) the command runs inside the same sandbox as the
// harness: setup, install and validation run on a tree the model edited, so they get no more reach than it has.
export async function sh(checkout, command, { timeoutMs, env = process.env, extraEnv = {} } = {}) {
  const childEnv = scrubbedEnv(env, extraEnv);
  // With FACTORY_LOCAL_DB=1 each command also gets a fresh Postgres inside that sandbox (plugin/bin/factory-db).
  // `--` ends srt's own options: srt has a -c of its own, which would otherwise take the inner bash's -c.
  const inner = ["bash", "-eo", "pipefail", "-c", command];
  const [cmd, args] = childEnv.FACTORY_LOCAL_SRT ? ["srt", ["-s", childEnv.FACTORY_LOCAL_SRT, "--", ...(childEnv.FACTORY_LOCAL_DB === "1" ? ["factory-db"] : []), ...inner]] : [inner[0], inner.slice(1)];
  const r = await exec(cmd, args, { cwd: checkout, env: childEnv, timeoutMs, echo: true });
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

/** Run the validation commands in order; stop at the first failure. GITHUB_SHA is the HEAD under test. */
export async function runValidation(checkout, commands, opts = {}) {
  const results = [];
  const head = (await git(checkout, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const extraEnv = { ...(opts.extraEnv || {}), ...(head ? { GITHUB_SHA: head } : {}) };
  for (const command of commands) {
    const r = await sh(checkout, command, { ...opts, extraEnv });
    results.push({ command, ...r, output: r.output.slice(-20_000) });
    if (!r.ok) return { green: false, results, failed: results.at(-1) };
  }
  return { green: true, results, failed: null };
}

/** Pick the offline install command from the lockfile present. `install: none` skips; a given command wins. */
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

/** The repository's default branch from the checkout's origin, else `main`. */
export async function defaultBranchOf(checkout) {
  const r = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: checkout });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, "");
  const remote = await exec("git", ["remote", "show", "origin"], { cwd: checkout });
  const m = /HEAD branch:\s*(\S+)/.exec(remote.stdout || "");
  return m ? m[1] : "main";
}
