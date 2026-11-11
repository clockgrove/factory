// Claude Code on a runner (Actions, a cloud sandbox VM), where it runs as the agent uid (agent.mjs) with its commands in
// its own bubblewrap sandbox (harness.mjs claudeRunner, local.mjs claudeRunnerSettings).
//
// The invariant: nothing the agent uid can write, inside or outside Claude's sandbox, is read or executed by Claude
// Code's own start-up outside the sandbox. Validation, install and setup run the repository's code as the agent uid
// outside that sandbox, so the agent's home and the checkout's .git are the agent's to plant things in. So:
// - Claude Code's HOME is a directory Factory owns (CLAUDE_HOME): no shell start-up file, no git config, only its env
//   file and Factory's skills. The unit (or NAMESPACE_WRAP) sees it read-only.
// - Its config directory (CLAUDE_CONFIG_DIR) and its own TMPDIR live in the agent's home but are made afresh before
//   every start (resetClaudeState), with only the sessions Factory itself captured put back, so nothing planted between
//   two starts survives into the next. Its sandboxed commands cannot write them.
// - The checkout's .git config, commondir, info/attributes and hooks, which Claude Code's own git reads, are put back
//   to what Factory left before its first harness start (pinRunnerGit, restoreRunnerGit), and a .git that was replaced
//   refuses the start.
// - Its commands get the agent's own HOME and TMPDIR back through CLAUDE_ENV_FILE, which Claude Code sources inside the
//   sandbox before each command, so package caches and the agent's read-only gh login work as before.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backend } from "./backend.mjs";
import { asAgent, exec, SAFE_PATH } from "./proc.mjs";
import { GitRefusal } from "./local.mjs";

/** Claude Code's HOME on a runner: Factory's own, outside every home the agent can write. */
export const CLAUDE_HOME = "/var/lib/factory-claude";

/** The package caches in the agent's home that Claude Code's sandboxed commands may write. */
export const RUNNER_CACHES = [".npm", ".cache", ".local/share/pnpm", ".bun", ".yarn"];

/** A user's uid from /etc/passwd, or null. */
export function uidOf(user, passwd = () => readFileSync("/etc/passwd", "utf8")) {
  try {
    const line = passwd().split("\n").find((l) => l.split(":")[0] === user);
    return line ? Number(line.split(":")[2]) : null;
  } catch {
    return null;
  }
}

/**
 * Where everything lives for one agent: Factory's directory, and the per-start state in the agent's home.
 * `editDiffs`: the directory Claude Code keeps its Bash edits' diffs in (`<command temp>/claude-<uid>/bash-edit-diff`),
 * which its own git reads outside the sandbox, so its commands must not write it.
 */
export function runnerLayout(agent, claudeHome = CLAUDE_HOME) {
  const state = join(agent.home, ".factory-claude");
  const uid = agent.uid ?? uidOf(agent.user);
  return {
    editDiffs: uid === null || uid === undefined ? null : join(state, "cmd", `claude-${uid}`, "bash-edit-diff"),
    home: claudeHome,
    envFile: join(claudeHome, "env.sh"),
    pluginDir: join(claudeHome, "claude"),
    agentHome: agent.home,
    agentTmp: agent.tmp,
    state,
    config: join(state, "config"),
    ownTmp: join(state, "tmp"),
    cmdTmp: join(state, "cmd"),
    caches: RUNNER_CACHES.map((c) => join(agent.home, c)),
  };
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The file Claude Code sources inside its sandbox before each command: the agent's own HOME and TMPDIR back. */
export const envFileText = (layout) => `export HOME=${q(layout.agentHome)}\nexport TMPDIR=${q(layout.agentTmp)}\n`;

/**
 * Factory's directory made afresh, owned by Factory's own user and 755 (the agent reads it, never writes it), with the
 * env file. `sudo` false (tests): the directory is made by this process.
 */
export async function prepareClaudeHome(layout, { sudo = true } = {}) {
  if (sudo) {
    const r = await exec("/usr/bin/sudo", ["-n", "/bin/sh", "-c", 'rm -rf -- "$1" && install -d -m 755 -o "$2" -g "$3" -- "$1"', "sh", layout.home, String(process.getuid()), String(process.getgid())], { env: { PATH: SAFE_PATH } });
    if (r.code !== 0) throw new Error(`Claude Code's home ${layout.home} could not be made: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  } else {
    await exec("/bin/sh", ["-c", 'rm -rf -- "$1" && mkdir -m 755 -- "$1"', "sh", layout.home]);
  }
  writeFileSync(layout.envFile, envFileText(layout));
  chmodSync(layout.envFile, 0o644);
}

// ------------------------------------------------------------- sessions

/** Session archives Factory holds (restored from an earlier stage, or captured after a run), by session id, put back on every reset in that order. */
const SESSIONS = new Map();
/** A session archive (tar of paths under the config directory's projects/) to put back on every reset; a newer one replaces the session's older. */
export const holdSession = (id, tar) => {
  if (!tar?.length) return;
  SESSIONS.delete(id);
  SESSIONS.set(id, tar);
};
/** The newest archive Factory captured for a session id, or null. */
const CAPTURED = new Map();
export const capturedSession = (id) => CAPTURED.get(id) || null;
/** Tests: forget every held session. */
export const dropSessions = () => {
  SESSIONS.clear();
  CAPTURED.clear();
};

/** The projects/ directory, relative to the agent's home, where Claude Code keeps sessions on a runner. */
export const RUNNER_SESSION_ROOT = ".factory-claude/config/projects";

/**
 * Claude Code's state made afresh before a start, as the agent: its config directory, own TMPDIR and its commands'
 * temp directory removed (a link is removed, never followed) and made empty, the package caches made where absent,
 * then every session archive Factory holds unpacked into projects/.
 */
export async function resetClaudeState(layout, env = process.env) {
  // The edit-diff directory is made too, so the sandbox's write denial holds a real directory.
  const made = await exec("/bin/sh", ["-c", 'set -e; rm -rf -- "$1"; mkdir -m 700 -- "$1" "$1/config" "$1/config/projects" "$1/tmp" "$1/cmd"; [ -z "$2" ] || mkdir -p -m 700 -- "$2"; shift 2; for c in "$@"; do [ -L "$c" ] || mkdir -p -- "$c"; done', "sh", layout.state, layout.editDiffs || "", ...layout.caches], { cwd: layout.agentHome, env });
  if (made.code !== 0) throw new GitRefusal("git-clear", `Claude Code's state could not be made afresh: ${String(made.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  for (const tar of SESSIONS.values()) {
    const put = await exec("tar", ["-xf", "-", "-C", join(layout.config, "projects")], { cwd: layout.agentHome, env, input: tar });
    if (put.code !== 0) throw new GitRefusal("git-clear", "a saved session could not be put back in Claude Code's state");
  }
}

/**
 * Right after a run, before anything else runs as the agent: the session's files archived (as the agent, from a pipe),
 * held for the next reset and for the end of the stage (session.mjs saveAgentTranscript).
 */
export async function captureSession(layout, sessionId, env = process.env) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(sessionId || ""))) return null;
  const root = join(layout.config, "projects");
  const listed = await exec("/bin/sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; find . -maxdepth 2 \\( -name "$2.jsonl" -o -name "$2" \\) -print0', "sh", root, sessionId], { cwd: layout.agentHome, env });
  const files = String(listed.stdout).split("\0").map((l) => l.replace(/^\.\//, "")).filter((p) => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p));
  if (!files.length) return null;
  const tar = await exec("tar", ["-C", root, "--null", "-T", "-", "-cf", "-"], { cwd: layout.agentHome, env, encoding: "buffer", input: `${files.join("\0")}\0` });
  if (tar.code !== 0) return null;
  CAPTURED.set(sessionId, { tar: tar.stdout, files });
  holdSession(sessionId, tar.stdout);
  return files;
}

// ------------------------------------------------------------- the checkout's git

// Run as the agent on the checkout. snap: .git's identity (device and inode) and its config, commondir,
// info/attributes and hooks, as JSON (base64). restore: refuse (exit 3) when .git is not that directory any more, else
// put each file back as it was (absent stays absent), and the hooks directory back to exactly those hooks. Every file
// is removed before it is written, so nothing is written through a link.
const GIT_GUARD = String.raw`
const fs = require("fs"), path = require("path");
const [op, clone] = process.argv.slice(1);
const git = path.join(clone, ".git");
const st = fs.lstatSync(git, { throwIfNoEntry: false });
if (!st || !st.isDirectory()) { process.stderr.write(".git is not a directory\n"); process.exit(3); }
const id = st.dev + ":" + st.ino;
const FILES = ["config", "commondir", "info/attributes"];
const read = (p) => { const s = fs.lstatSync(p, { throwIfNoEntry: false }); return s && s.isFile() ? fs.readFileSync(p).toString("base64") : null; };
if (op === "snap") {
  const hooks = {};
  const hd = path.join(git, "hooks");
  const hs = fs.lstatSync(hd, { throwIfNoEntry: false });
  if (hs && hs.isDirectory()) for (const e of fs.readdirSync(hd, { withFileTypes: true })) if (e.isFile()) hooks[e.name] = { b64: read(path.join(hd, e.name)), mode: fs.statSync(path.join(hd, e.name)).mode & 0o777 };
  process.stdout.write(JSON.stringify({ id, files: Object.fromEntries(FILES.map((f) => [f, read(path.join(git, f))])), hooks }));
} else if (op === "restore") {
  const snap = JSON.parse(fs.readFileSync(0, "utf8"));
  if (snap.id !== id) { process.stderr.write(".git is not the directory Factory set up\n"); process.exit(3); }
  for (const f of FILES) {
    const p = path.join(git, f);
    fs.rmSync(p, { recursive: true, force: true });
    if (snap.files[f] !== null) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(snap.files[f], "base64"), { flag: "wx", mode: 0o644 }); }
  }
  const hd = path.join(git, "hooks");
  fs.rmSync(hd, { recursive: true, force: true });
  fs.mkdirSync(hd);
  for (const [n, h] of Object.entries(snap.hooks)) fs.writeFileSync(path.join(hd, n), Buffer.from(h.b64, "base64"), { flag: "wx", mode: h.mode });
}
`;

/** Factory's git state of each checkout, as pinned (pinRunnerGit). */
const GIT_PINS = new Map();

const guard = (op, clone, env, input) => exec(...backend(env).sandbox.git([process.execPath, "-e", GIT_GUARD, op, clone], env), { env, input, maxBytes: 64 * 1024 * 1024 });

/** After Factory's own git work on the checkout and before anything of the repository's runs: its git state, pinned. */
export async function pinRunnerGit(clone, env = process.env) {
  const r = await guard("snap", clone, env);
  if (r.code !== 0) throw new GitRefusal("git-state", `the checkout's git state could not be read: ${String(r.stderr).trim().slice(0, 200)}`);
  GIT_PINS.set(clone, String(r.stdout));
}

/** Before every Claude Code start: the checkout's git state put back as pinned; a replaced .git, or no pin, refuses. */
export async function restoreRunnerGit(clone, env = process.env) {
  const pin = GIT_PINS.get(clone);
  if (!pin) throw new GitRefusal("git-state", "no pinned git state for the checkout");
  const r = await guard("restore", clone, env, pin);
  if (r.code === 3) throw new GitRefusal("git-identity", String(r.stderr).trim().slice(0, 200));
  if (r.code !== 0) throw new GitRefusal("git-state", `the checkout's git state could not be put back: ${String(r.stderr).trim().slice(0, 200)}`);
}

/** Tests: forget the pins. */
export const dropGitPins = () => GIT_PINS.clear();

// ------------------------------------------------------------- the start

/**
 * Claude Code's command line on a runner: its own HOME, TMPDIR and PATH set by env, so the agent's home and anything on
 * PATH under it are never read at its start.
 */
export function runnerLaunch(layout, cmd, args, path = process.env.PATH || "") {
  const safe = path.split(":").filter((d) => d && d !== layout.agentHome && !d.startsWith(`${layout.agentHome}/`));
  return ["/usr/bin/env", [`HOME=${layout.home}`, `TMPDIR=${layout.ownTmp}`, `PATH=${safe.join(":")}`, cmd, ...args]];
}

/** The env Claude Code gets on a runner beside its credential. */
export const runnerEnv = (layout) => ({ CLAUDE_CONFIG_DIR: layout.config, CLAUDE_CODE_TMPDIR: layout.cmdTmp, CLAUDE_ENV_FILE: layout.envFile, NODE_USE_ENV_PROXY: "1" });

/**
 * Claude Code's command as the agent (proc.mjs asAgent), its unit without ProtectKernelTunables: that setting's
 * read-only mounts over parts of /proc keep a user namespace from mounting a fresh /proc, so bubblewrap cannot start
 * under it ("Can't mount proc on /newroot/proc"). The agent stays unprivileged with no new privileges and no
 * capabilities, so /proc/sys and /sys stay root's to write; every other command the agent runs keeps the setting.
 * NAMESPACE_WRAP (a cloud sandbox VM) has no such mount. Returns [cmd, args, env] for proc.mjs exec.
 */
export function asClaudeAgent(cmd, args, env, extra, cwd) {
  const [c, a, e] = asAgent(cmd, args, env, extra, cwd);
  return [c, a.filter((x) => x !== "--property=ProtectKernelTunables=yes"), e];
}
