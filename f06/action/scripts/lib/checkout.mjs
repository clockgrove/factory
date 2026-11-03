// The worker's checkout: the branch, the plugin's skills and agent definitions
// written in (git-excluded, never committed), the repository's validation and
// setup commands, and the commit guard for protected paths.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, git } from "./proc.mjs";
import { scrubbedEnv } from "./harness.mjs";

export const ACTION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The plugin: FACTORY_PLUGIN_ROOT, else <action>/plugin (action.yml at the repository root), else <action>/../plugin (action/ beside plugin/). */
export const PLUGIN_ROOT = process.env.FACTORY_PLUGIN_ROOT || [resolve(ACTION_ROOT, "plugin"), resolve(ACTION_ROOT, "..", "plugin")].find((p) => existsSync(join(p, "skills"))) || resolve(ACTION_ROOT, "..", "plugin");

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
export async function sh(checkout, command, { timeoutMs, env = process.env, extraEnv = {} } = {}) {
  const r = await exec("bash", ["-eo", "pipefail", "-c", command], { cwd: checkout, env: scrubbedEnv(env, extraEnv), timeoutMs, echo: true });
  return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, output: `${r.stdout}\n${r.stderr}`.trim() };
}

/** Run the validation commands in order; stop at the first failure. */
export async function runValidation(checkout, commands, opts = {}) {
  const results = [];
  for (const command of commands) {
    const r = await sh(checkout, command, opts);
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
