// Claude Code on a runner (Actions, a cloud sandbox VM), where it runs as the agent uid (agent.mjs) with its commands in
// its own bubblewrap sandbox (harness.mjs claudeRunner, local.mjs claudeRunnerSettings).
//
// The invariant: nothing the agent uid can write, inside or outside Claude's sandbox, is read or executed by Claude
// Code's own start-up outside the sandbox. Validation, install and setup run the repository's code as the agent uid
// outside that sandbox, so the agent's home and the checkout's .git are the agent's to plant things in. So:
// - Claude Code's HOME is a directory Factory owns (CLAUDE_HOME): no shell start-up file, no git config, only its env
//   file and Factory's skills. The unit (or NAMESPACE_WRAP) sees it read-only.
// - Its own TMPDIR is /tmp, which its unit (PrivateTmp) or NAMESPACE_WRAP makes private and fresh for every start.
// - Its config directory (CLAUDE_CONFIG_DIR) lives in the agent's home but is made afresh before
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
import { log } from "./inputs.mjs";

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
    sessions: join(state, "config", "projects"),
    sessionDepth: 2,
    cmdTmp: join(state, "cmd"),
    caches: RUNNER_CACHES.map((c) => join(agent.home, c)),
  };
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// ------------------------------------------------------------- services

/**
 * The IPv4 loopback and every-address forms in /proc/net/tcp and tcp6 (each 32-bit word in host byte order): 127.0.0.1,
 * 0.0.0.0, `::`, and the IPv4-mapped ::ffff:127.0.0.1 and ::ffff:0.0.0.0 a dual-stack listener (a JVM's) shows. Never
 * `::1`: the sandbox's proxy connects to `127.0.0.1:<port>`, so a service on `::1` alone would be offered and unreachable.
 */
const LOOPBACK = new Set(["0100007F", "00000000", "00000000000000000000000000000000", "0000000000000000FFFF00000100007F", "0000000000000000FFFF000000000000"]);

/**
 * The TCP ports listening on this machine's IPv4 loopback (or on every address), from /proc/net/tcp and tcp6: what a
 * service the repository's setup started answers on. A socket owned by `skipUid` (the agent's) never counts, so nothing
 * the agent started is offered, whatever the reap left. `read` is a seam for the tests.
 */
export function loopbackListeners(read = (p) => readFileSync(p, "utf8"), { skipUid = null } = {}) {
  const ports = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || f[3] !== "0A") continue;
      if (skipUid !== null && skipUid !== undefined && Number(f[7]) === Number(skipUid)) continue;
      const [addr, port] = f[1].split(":");
      if (LOOPBACK.has(addr.toUpperCase())) ports.add(Number.parseInt(port, 16));
    }
  }
  return [...ports].filter((p) => p > 0 && p < 65536).sort((a, b) => a - b);
}

/** The listeners before the repository's setup ran (noteSetupStart); null until then, and then no service is offered. */
let BEFORE_SETUP = null;
/** Right before the repository's setup runs: what already listened is no service of its. */
export const noteSetupStart = (read) => {
  BEFORE_SETUP = new Set(loopbackListeners(read));
};
/** Tests: forget the baseline. */
export const dropSetupStart = () => {
  BEFORE_SETUP = null;
};
/** At most this many services are offered to Claude Code's commands. */
export const SERVICES_MAX = 20;
const DROPPED_SAID = new Set();
/**
 * The ports of the services the repository's setup started: listening on loopback now, not before the setup ran, and
 * not the agent's (`skipUid`). Claude Code's commands reach exactly these through its sandbox's proxy (envFileText,
 * harness.mjs claudeRunner). Past SERVICES_MAX the rest are dropped, and the log names them once.
 */
export function servicePorts(read, { skipUid = null } = {}) {
  if (!BEFORE_SETUP) return [];
  const fresh = loopbackListeners(read, { skipUid }).filter((p) => !BEFORE_SETUP.has(p));
  const dropped = fresh.slice(SERVICES_MAX);
  if (dropped.length && !DROPPED_SAID.has(dropped.join(","))) {
    DROPPED_SAID.add(dropped.join(","));
    log(`setup's services: only the first ${SERVICES_MAX} ports are offered to Claude Code's commands; dropped ${dropped.join(", ")}`);
  }
  return fresh.slice(0, SERVICES_MAX);
}

/** The services offered to this agent's Claude Code commands (servicePorts without the agent's own sockets). */
export const agentServicePorts = (agent, read) => servicePorts(read, { skipUid: agent.uid ?? uidOf(agent.user) });

/**
 * The file Claude Code sources inside its sandbox before each command: the agent's own HOME and TMPDIR back, and for
 * each service port a relay on the sandbox's own loopback (its network namespace) to the same port on this machine,
 * through the sandbox's proxy (HTTP CONNECT, with the proxy's per-session login from HTTPS_PROXY), which allows only
 * `127.0.0.1:<port>` for these ports. So `localhost:5432` in a command reaches the database setup started, and nothing
 * outside the sandbox runs anything for it: the relay runs inside, and the proxy only connects. It starts only where
 * the sandbox's proxy is set (its login is `srt` or starts with `srt.`), so never in Claude Code's own shell outside
 * the sandbox.
 */
export function envFileText(layout, ports = []) {
  const head = `export HOME=${q(layout.agentHome)}\nexport TMPDIR=${q(layout.agentTmp)}\n`;
  const list = ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (!list.length) return head;
  return `${head}${RELAY.replaceAll("@PORTS@", list.join(" "))}\n`;
}

const RELAY = [
  "# Services the repository's setup started, through the sandbox's proxy (Factory: lib/claude-runner.mjs).",
  "__f_x=\"${HTTPS_PROXY:-}\"; __f_x=\"${__f_x#*://}\"; __f_a=\"${__f_x%@*}\"; __f_h=\"${__f_x#*@}\"; __f_h=\"${__f_h%%/*}\"",
  "case \"$__f_a\" in",
  "  srt:*|srt.*:*)",
  "    if command -v socat >/dev/null 2>&1; then",
  "      __f_a=\"$(printf '%b' \"$(printf '%s' \"$__f_a\" | sed 's/%\\([0-9A-Fa-f][0-9A-Fa-f]\\)/\\\\x\\1/g')\")\"",
  "      for __f_p in @PORTS@; do",
  "        (socat \"TCP4-LISTEN:$__f_p,bind=127.0.0.1,fork,reuseaddr\" \"PROXY:${__f_h%:*}:127.0.0.1:$__f_p,proxyport=${__f_h##*:},proxyauth=$__f_a\" </dev/null >/dev/null 2>&1 &)",
  "        (socat \"TCP6-LISTEN:$__f_p,bind=[::1],fork,reuseaddr,ipv6only=1\" \"PROXY:${__f_h%:*}:127.0.0.1:$__f_p,proxyport=${__f_h##*:},proxyauth=$__f_a\" </dev/null >/dev/null 2>&1 &)",
  "      done",
  "      for __f_p in @PORTS@; do",
  "        __f_i=0",
  "        while [ \"$__f_i\" -lt 40 ]; do __f_l=\"$(ss -Hltn \"sport = :$__f_p\" 2>/dev/null)\" || break; [ -n \"$__f_l\" ] && break; sleep 0.05; __f_i=$((__f_i + 1)); done",
  "      done",
  "    fi",
  "    ;;",
  "esac",
  "unset __f_x __f_a __f_h __f_p __f_i __f_l",
].join("\n");

/** Factory's env file for Claude Code, written (or rewritten before a start) with the current service ports. */
export function writeEnvFile(layout, ports = []) {
  writeFileSync(layout.envFile, envFileText(layout, ports));
  chmodSync(layout.envFile, 0o644);
}

/**
 * Factory's directory made afresh, owned by Factory's own user and 755 (the agent reads it, never writes it), with the
 * env file. `sudo` false (tests): the directory is made by this process.
 */
export async function prepareClaudeHome(layout, { sudo = true } = {}) {
  await prepareFactoryHome(layout.home, "Claude Code", { sudo });
  writeEnvFile(layout);
}

/**
 * A harness's HOME on a runner (Claude Code's, Codex's), made afresh and empty: owned by Factory's own user and 755, so
 * the agent reads it and never writes it, and the unit (or NAMESPACE_WRAP) sees it read-only. `sudo` false (tests): the
 * directory is made by this process.
 */
export async function prepareFactoryHome(dir, name, { sudo = true } = {}) {
  if (sudo) {
    const r = await exec("/usr/bin/sudo", ["-n", "/bin/sh", "-c", 'rm -rf -- "$1" && install -d -m 755 -o "$2" -g "$3" -- "$1"', "sh", dir, String(process.getuid()), String(process.getgid())], { env: { PATH: SAFE_PATH } });
    if (r.code !== 0) throw new Error(`${name}'s home ${dir} could not be made: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  } else {
    await exec("/bin/sh", ["-c", 'rm -rf -- "$1" && mkdir -m 755 -- "$1"', "sh", dir]);
  }
}

/**
 * A runner's writable roots made real, as the agent, before a harness start (harness.mjs runnerClear): each of `fix` (the
 * temp directory, the package caches) that is a link is removed and made a directory, and each of `fix` and `check` (the
 * checkout) must then resolve to where it sits under the agent's home (`home`, itself resolved: a home under a linked
 * ancestor, as `/home -> /var/home`, is no planted link). A link planted there by the repository's install or
 * validation (`~/.yarn` -> `~`) would otherwise widen what the sandbox lets commands write; one that cannot be put right
 * (a link higher up the path) refuses the start (code `roots`), naming the path under the home.
 */
export async function realRoots({ fix = [], check = [] }, home, env = process.env, { run = exec } = {}) {
  const r = await run("/bin/sh", ["-c", 'home=$1; shift; base=$(realpath -e -- "$home") || exit 4; fix=1; for c; do if [ "$c" = "--" ]; then fix=0; continue; fi; if [ "$fix" = 1 ]; then if [ -L "$c" ]; then rm -f -- "$c"; fi; [ -d "$c" ] || mkdir -p -m 700 -- "$c" 2>/dev/null || true; fi; case "$c" in "$home"/*) want="$base${c#"$home"}" ;; *) want="$c" ;; esac; r=$(realpath -e -- "$c" 2>/dev/null) || r=; if [ "$r" != "$want" ]; then printf "%s\n" "$c"; exit 3; fi; done', "sh", home, ...fix, "--", ...check], { cwd: home, env });
  if (r.code === 3) {
    const path = String(r.stdout).trim();
    throw new GitRefusal("roots", `${path} is not a real directory of its own (a link on its path)`, { path: path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : null });
  }
  if (r.code !== 0) throw new GitRefusal("roots", `the sandbox's writable directories could not be checked: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `exit ${r.code}`}`);
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
/** The held archives, in the order a reset puts them back (codex-runner.mjs resetCodexState). */
export const SESSIONS_HELD = () => [...SESSIONS.values()];
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
 * Claude Code's state made afresh before a start, as the agent: its config directory and its commands' temp directory
 * removed (a link is removed, never followed) and made empty, the package caches made where absent,
 * then every session archive Factory holds unpacked into projects/.
 */
export async function resetClaudeState(layout, env = process.env) {
  // The edit-diff directory is made too, so the sandbox's write denial holds a real directory.
  // The caches are made by realRoots, which replaces a link with a real directory.
  const made = await exec("/bin/sh", ["-c", 'set -e; rm -rf -- "$1"; mkdir -m 700 -- "$1" "$1/config" "$1/config/projects" "$1/cmd"; [ -z "$2" ] || mkdir -p -m 700 -- "$2"', "sh", layout.state, layout.editDiffs || ""], { cwd: layout.agentHome, env });
  if (made.code !== 0) throw new GitRefusal("git-clear", `Claude Code's state could not be made afresh: ${String(made.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  for (const tar of SESSIONS.values()) {
    const put = await exec("tar", ["-xf", "-", "-C", join(layout.config, "projects")], { cwd: layout.agentHome, env, input: tar });
    if (put.code !== 0) throw new GitRefusal("git-clear", "a saved session could not be put back in Claude Code's state");
  }
}

/**
 * Right after a run, before anything else runs as the agent: the session's files archived (as the agent, from a pipe),
 * held for the next reset and for the end of the stage (session.mjs saveAgentTranscript). `layout.sessions` is the
 * harness's session root: Claude Code's `<project>/<id>.jsonl` and `<id>/`, Codex's `YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
 */
export async function captureSession(layout, sessionId, env = process.env) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(sessionId || ""))) return null;
  const root = layout.sessions;
  const listed = await exec("/bin/sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; find . -maxdepth "$3" \\( -name "$2.jsonl" -o -name "$2" -o -name "*-$2.jsonl" \\) -print0', "sh", root, sessionId, String(layout.sessionDepth || 2)], { cwd: layout.agentHome, env });
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
  return ["/usr/bin/env", [`HOME=${layout.home}`, `TMPDIR=${CLAUDE_TMPDIR}`, `PATH=${safe.join(":")}`, cmd, ...args]];
}

/**
 * Claude Code's own TMPDIR on a runner: the /tmp its unit (PrivateTmp) or NAMESPACE_WRAP mounts afresh for every
 * start, so nothing the agent wrote before survives into it. Not a directory in the agent's home: with
 * blockReadsOutsideWorkingDirectories, Claude Code's sandbox cannot read its own TMPDIR there, and its commands then
 * get no network at all, the proxy's bridge included (#61); /tmp stays readable.
 */
export const CLAUDE_TMPDIR = "/tmp";

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
