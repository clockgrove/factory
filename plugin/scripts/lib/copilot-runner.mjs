// Copilot on a runner (Actions, a cloud sandbox VM), where it runs as the agent uid (agent.mjs) with its commands in its
// own sandbox (`--sandbox`: MXC's bubblewrap backend), as Claude Code's and Codex's are (claude-runner.mjs,
// codex-runner.mjs).
//
// Why: the agent uid holds the Copilot token in Copilot's environment, and Linux lets any process of a uid read the
// environment of every other process of that uid (/proc/<pid>/environ), Copilot's own and the git processes it starts
// with it (#87). Copilot's sandbox runs each command in a user namespace, a PID namespace with a fresh /proc and a
// network namespace whose only way out is Copilot's proxy with the host allow-list, so no process outside it is
// visible. Two things it does not do, which Factory adds (checked with Copilot 1.0.109):
// - It starts bubblewrap with Copilot's whole environment, the token included, and bubblewrap stays in the sandbox as
//   its pid 1, readable by every command. Factory's `bwrap` (BWRAP_SHIM), first on Copilot's PATH, starts the real one
//   with an empty environment; bubblewrap sets each command's environment itself (`--clearenv`, `--setenv`).
// - Its commands get Copilot's own HOME and TMPDIR. The shim gives them the agent's instead, so package caches, the
//   agent's read-only gh login and $FACTORY_IN/$FACTORY_OUT work as before.
//
// The invariant, as for Claude Code and Codex: nothing the agent uid can write, inside or outside Copilot's sandbox, is
// read or run by Copilot's own start-up outside the sandbox. Validation, install and setup run the repository's code
// as the agent outside the sandbox, so the agent's home and the checkout's .git are the agent's to plant things in. So:
// - Copilot's HOME is a directory Factory owns (COPILOT_RUNNER_HOME), with the shim and the release Copilot's binary
//   unpacks and runs (COPILOT_CACHE_HOME, unpacked by Factory before the agent starts). The unit (or NAMESPACE_WRAP)
//   sees it read-only. Its TMPDIR is /tmp, which its unit (PrivateTmp) or NAMESPACE_WRAP makes fresh for every start.
// - COPILOT_HOME (its settings, which are also its sandbox's policy, its trusted folders, MCP servers and sessions) lives
//   in the agent's home but is made afresh before every start, with only the sessions Factory itself captured put back.
//   Its sandboxed commands cannot write it.
// - The checkout's .git config, commondir, info/attributes and hooks, which Copilot's own git reads after every tool call
//   with the token in its environment, are put back to what Factory pinned and are read-only to its commands; the
//   checkout's harness configuration is restored to the commit (local.mjs clearHarnessConfig), and so is anything of
//   that kind in the agent's temp directory, an added directory whose .github agents and skills Copilot loads.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { accessSync, chmodSync, constants, existsSync, lstatSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { exec, SAFE_PATH } from "./proc.mjs";
import { GitRefusal, HARNESS_CONFIG, LOCAL_DOMAINS, TOOLCHAIN_RULE, codexReadOnly, copilotHomeFiles, copilotLocalSettings, credentialPaths, gitGuards } from "./local.mjs";
import { RUNNER_CACHES, SESSIONS_HELD, prepareFactoryHome } from "./claude-runner.mjs";
import { CONFINEMENT_PROBE, PROBE_MARKER, decoyLaunch } from "./codex-runner.mjs";
import { untarAsAgent } from "./untar.mjs";

import { RELAY_PING } from "./gateway-relay.mjs";

export { TOOLCHAIN_RULE };

/** Copilot's HOME on a runner: Factory's own, outside every home the agent can write. */
export const COPILOT_RUNNER_HOME = "/var/lib/factory-copilot";

/** Copilot's sessions on a runner, relative to the agent's home (session.mjs reads and restores them there). */
export const COPILOT_RUNNER_SESSION_ROOT = ".factory-copilot/home/session-state";

/** A shell word for `s`: single-quoted. */
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The agent's read-only GitHub login (agent.mjs readTokenFiles), which its commands use: read-only in the sandbox. */
const LOGIN = [".gitconfig", ".config/gh", ".factory"];

/** Where everything lives for one agent: Factory's HOME for Copilot, and the per-start state in the agent's home. */
export function copilotRunnerLayout(agent, home = COPILOT_RUNNER_HOME) {
  const state = join(agent.home, ".factory-copilot");
  return {
    home,
    bin: join(home, "bin"),
    cacheHome: join(home, "cache"),
    agentHome: agent.home,
    agentTmp: agent.tmp,
    state,
    copilotHome: join(state, "home"),
    probeHome: join(state, "probe"),
    sessions: join(agent.home, COPILOT_RUNNER_SESSION_ROOT),
    sessionDepth: 1,
    caches: RUNNER_CACHES.map((c) => join(agent.home, c)),
    login: LOGIN.map((p) => join(agent.home, p)),
  };
}

/**
 * Factory's `bwrap` for Copilot's sandbox on a runner. Copilot (MXC) starts bubblewrap with Copilot's whole environment,
 * the token included, and bubblewrap stays in every command's sandbox as its pid 1, whose environment each command can
 * read; this starts the real one with none (bubblewrap sets every command's environment itself: `--clearenv`, then
 * `--setenv`). Among bubblewrap's own options (before the first `--`) each command's HOME and TMPDIR become the agent's
 * (`home`, `tmp`; null leaves Copilot's), and `pathFirst` (local mode: the stage's node, localToolchain) leads each
 * command's PATH. With the gateway relay (lib/gateway-relay.mjs), `relayShim` is where the relay's own shim for Copilot
 * goes (relay-shim.mjs copilotRelayShimIn: a path in the stage's own relay directory, which the agent cannot write,
 * written into this script, never taken from an environment, which repository content can reach in local mode; on a
 * runner bakeCopilotRelay writes the stage's script again once its relay is open); while the stage relays a key it is
 * there, and each call is handed to it instead of the real bubblewrap, still with no
 * environment: it adds the relay's forwarder, the socket's
 * directory read-only and loopback off Copilot's proxy to a command's sandbox, and runs every other call as given.
 * Copilot's commands can open the relay's socket directly too (its filter allows Unix sockets): the same relay, behind
 * the same token check. Nothing else changes. Lives in Factory's HOME for Copilot, which the agent cannot write. Local mode runs
 * it without `home` (local.mjs stageEnv), in the stage's usage directory.
 */
export const bwrapShim = (realBwrap, home = null, tmp = null, pathFirst = null, relayShim = null) => `#!/bin/sh
# Factory: Copilot's bubblewrap (lib/copilot-runner.mjs). Started with no environment, so the token Copilot holds is
# not in the sandbox's pid 1${home || tmp ? "; each command's HOME and TMPDIR are the agent's" : ""}${pathFirst ? "; the stage's node leads each command's PATH" : ""}.
first=1; p1=""; p2=""; done=""
for a do
  if [ "$first" = 1 ]; then set --; first=0; fi
${home ? `  if [ -z "$done" ] && [ "$p2" = --setenv ] && [ "$p1" = HOME ]; then a=${sq(home)}; fi\n` : ""}${tmp ? `  if [ -z "$done" ] && [ "$p2" = --setenv ] && [ "$p1" = TMPDIR ]; then a=${sq(tmp)}; fi\n` : ""}${pathFirst ? `  if [ -z "$done" ] && [ "$p2" = --setenv ] && [ "$p1" = PATH ]; then a=${sq(pathFirst)}:$a; fi\n` : ""}  [ "$a" = "--" ] && done=1
  set -- "$@" "$a"
  p2=$p1; p1=$a
done
next=${sq(realBwrap)}
${relayShim ? `if [ -f ${sq(relayShim)} ] && [ -x ${sq(relayShim)} ]; then next=${sq(relayShim)}; fi
` : ""}exec /usr/bin/env -i "$next" "$@"
`;

/**
 * Factory's HOME for Copilot made afresh (claude-runner.mjs prepareFactoryHome) with the shim in its bin directory and
 * Copilot's release unpacked into its cache directory: by Factory's own user, from the CLI the Action or the start
 * installed, with an environment of PATH, HOME and COPILOT_CACHE_HOME only. The agent reads both and writes neither.
 */
export async function prepareCopilotHome(layout, { env = process.env, sudo = true, run = exec } = {}) {
  await prepareFactoryHome(layout.home, "Copilot", { sudo });
  // The system's bwrap, never one on a PATH entry another user could write.
  const bwrap = await run("/bin/sh", ["-c", "command -v bwrap"], { env: { PATH: SAFE_PATH }, cwd: "/" });
  const real = String(bwrap.stdout).trim();
  // Without bwrap there is no shim, so Copilot's sandbox cannot start: the pre-start probe Blocks (doctor names it).
  const shim = bwrap.code === 0 && real.startsWith("/") ? 'cat > "$1/bwrap"; chmod 755 "$1/bwrap"' : "true";
  const made = await run("/bin/sh", ["-c", `set -e; mkdir -m 755 -- "$1" "$2"; ${shim}`, "sh", layout.bin, layout.cacheHome], { input: bwrapShim(real, layout.agentHome, layout.agentTmp), env: { PATH: SAFE_PATH }, cwd: "/" });
  if (made.code !== 0) throw new Error(`Copilot's home ${layout.home} could not be filled: ${String(made.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  // umask 022: the agent reads what Copilot unpacks (a cloud sandbox's stage runs with 077).
  const unpacked = await run("/bin/sh", ["-c", "umask 022; exec copilot --version"], { env: { PATH: absolutePath(env.PATH || SAFE_PATH), HOME: layout.home, COPILOT_CACHE_HOME: layout.cacheHome }, cwd: "/", timeoutMs: 120_000 });
  if (unpacked.code !== 0) throw new Error(`Copilot could not unpack its release into ${layout.cacheHome}: ${String(unpacked.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `exit ${unpacked.code}`}`);
}

/**
 * A runner's Copilot shim for this stage, written again with its relay's shim baked in (`relayShim`, in the stage's own
 * relay directory): by Factory's user, in Factory's HOME for Copilot, which the agent reads and never writes.
 */
export function bakeCopilotRelay(layout, realBwrap, relayShim) {
  writeFileSync(join(layout.bin, "bwrap"), bwrapShim(realBwrap, layout.agentHome, layout.agentTmp, null, relayShim), { mode: 0o755 });
  chmodSync(join(layout.bin, "bwrap"), 0o755);
}

/**
 * Copilot's settings.json on a runner, which is also its sandbox's policy: local mode's (local.mjs copilotLocalSettings)
 * fitted to the agent. Commands may write the checkout (its .git for commits), the agent's temp directory and the
 * package caches; never the checkout's git hooks, config, commondir, info and harness configuration. They read the
 * agent's GitHub login (read-only), and nothing else of the agent's home is in their sandbox. Denied: Copilot's own
 * TMPDIR (COPILOT_TMP), where it writes each command's network rules before it loads them. (Its logs directory Copilot
 * binds into every command's sandbox whatever the policy says; it writes none: copilotRunnerFlags.) No credential store
 * is denied: the agent's home holds only that login, which is for its commands. They also read the stage's toolchain
 * (`runner.toolchain`, runnerToolchain), read-only. The network is `domains`.
 */
export function copilotRunnerSettings(runner) {
  return copilotLocalSettings({
    domains: runner.domains || LOCAL_DOMAINS,
    clone: runner.clone,
    addDirs: [runner.clone, runner.agentTmp, ...runner.caches],
    readOnly: [...new Set([...gitGuards(runner.clone), ...codexReadOnly(runner.clone)])],
    readable: [...runner.login, ...(runner.toolchain || [])],
    denied: [COPILOT_TMP],
    platform: "linux",
  });
}

/** The env Copilot gets on a runner beside its credential: its fresh state and Factory's unpacked release. */
export const copilotRunnerEnv = (layout) => ({ COPILOT_HOME: layout.copilotHome, COPILOT_CACHE_HOME: layout.cacheHome });

/**
 * Copilot's flags on a runner: its sandbox, tools and URLs allowed, file tools kept to the checkout and the agent's temp
 * directory, no update of itself (it would run a release Factory did not unpack), and no logs: Copilot binds its logs
 * directory into every command's sandbox, a deny in its policy notwithstanding (checked with 1.0.109).
 */
export const copilotRunnerFlags = (runner) => ["--sandbox", "--allow-all-tools", "--allow-all-urls", "--no-auto-update", "--log-level", "none", "--add-dir", runner.agentTmp];

/**
 * Copilot's own TMPDIR on a runner: a directory of its own in the /tmp its unit (PrivateTmp) or NAMESPACE_WRAP makes
 * fresh for every start, made by its launch. Copilot binds its TMPDIR into every command's sandbox, and writes each
 * command's network rules there before it loads them, so with /tmp itself a command could rewrite the next command's
 * rules and open its network (found in review); this directory is denied to commands (copilotRunnerSettings), which
 * keep their own /tmp and the agent's $TMPDIR.
 */
export const COPILOT_TMP = "/tmp/factory-copilot";

/** A PATH's absolute entries only: a relative one would resolve against whatever directory a process runs in. */
export const absolutePath = (path = "") => path.split(":").filter((d) => d.startsWith("/")).join(":");

/**
 * Copilot's command line on a runner: Factory's HOME for it, COPILOT_TMP as its TMPDIR (made here, a directory of its
 * own: an existing one that is a link or not its own refuses the start), and a PATH with Factory's shim first and
 * nothing of the agent's home, so nothing the agent wrote is read at its start.
 */
export function copilotLaunch(layout, cmd, args, path = process.env.PATH || "") {
  return ["/bin/sh", ["-c", COPILOT_TMP_LAUNCH, "factory-copilot", COPILOT_TMP, `HOME=${layout.home}`, `PATH=${[layout.bin, ...launchPath(layout, path)].join(":")}`, cmd, ...args]];
}

/** The stage's PATH as Copilot gets it after Factory's bin: its absolute entries, none in the agent's home. */
export const launchPath = (layout, path = "") => absolutePath(path).split(":").filter((d) => d && !within(d, layout.agentHome));

/** Whether `p` is `dir` or under it. */
const within = (p, dir) => p === dir || p.startsWith(`${dir}/`);

/**
 * What Copilot's sandbox binds into every command itself (MXC's bubblewrap backend, checked with 1.0.109): the system's
 * own directories. Nothing else of the filesystem is there unless its policy names it: not /usr/local, not /opt (the
 * toolchains a runner's setup puts there, Actions' /opt/hostedtoolcache), not a home.
 */
const SYSTEM_BOUND = ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib32", "/usr/lib64", "/usr/libx32", "/usr/libexec", "/usr/share", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

/** Never put in commands' reach as toolchain, nor any directory above one of these: the kernel's and the runtime's own. */
const NOT_TOOLCHAIN = ["/proc", "/sys", "/dev", "/run", "/var/run"];

/**
 * Factory's own directories on the route (its HOME, the runner's temp directory and workspace, its usage and private
 * directories, its TMPDIR other than /tmp, which each start has private): never in commands' reach as toolchain.
 */
export const factoryDirs = (env = process.env) =>
  [...new Set(["HOME", "RUNNER_TEMP", "GITHUB_WORKSPACE", "FACTORY_USAGE_DIR", "FACTORY_PRIVATE_DIR", "TMPDIR"].map((k) => String(env[k] || "").replace(/\/+$/, "")))].filter((d) => d.startsWith("/") && d !== "/tmp");

/** Where no toolchain directory may be, nor above: the agent's home, Factory's HOME for Copilot, its TMPDIR, the kernel's, Factory's own. */
const offLimits = (layout, env) => [layout.agentHome, layout.home, COPILOT_TMP, ...NOT_TOOLCHAIN, ...factoryDirs(env)];

/** `dirs` less those under another one of them, which is in commands' reach already. */
const outermost = (dirs) => dirs.filter((t) => !dirs.some((o) => o !== t && within(t, o)));

/** toolchainDirs before outermost: every candidate, so runnerToolchain can still keep one under a parent it drops. */
function toolchainCandidates(layout, path, env) {
  const off = offLimits(layout, env);
  const out = [];
  for (const d of launchPath(layout, path)) {
    if (/[\t\n]/.test(d) || SYSTEM_BOUND.some((s) => within(d, s))) continue;
    const t = /\/s?bin$/.test(d) ? dirname(d) : d;
    if (t === "/" || off.some((x) => within(t, x) || within(x, t))) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The directories the stage's toolchain lives in, by the PATH Copilot gets (launchPath), for its commands to read: each
 * entry Copilot's sandbox does not bind itself, as its install prefix where it is a `bin` or `sbin` directory (npm is
 * bin/npm -> ../lib/node_modules/npm, Python's lib is beside its bin). Without them a command finds Copilot's PATH but
 * none of its toolchain (#105). Never `/`, nothing in or above the agent's home, Factory's HOME for Copilot, its TMPDIR,
 * NOT_TOOLCHAIN or Factory's own directories (factoryDirs). Pure: runnerToolchain keeps those the agent can neither
 * change nor fail to reach.
 */
export const toolchainDirs = (layout, path = "", env = {}) => outermost(toolchainCandidates(layout, path, env));

/**
 * Run as the agent with candidate directories as arguments: each one it can reach, and its real path, when neither it
 * nor any directory above it, by its path and by its real path, is the agent's or writable by it. Copilot's bubblewrap
 * binds a toolchain directory by its path when each command starts, after this check, following links: a directory the
 * agent could replace with a link (one it owns, or in a directory it can write) would put whatever the link names
 * (Factory's HOME for Copilot, Factory's own directories) in commands' reach. A sticky directory (/tmp) it can write
 * counts only where the entry under it is the agent's. No `${...}`: systemd-run expands that form itself.
 */
export const TOOLCHAIN_CHECK = [
  "safe() {",
  '  p=$1; c=""',
  "  while :; do",
  '    if [ -O "$p" ]; then return 1; fi',
  '    if [ -w "$p" ] && ! { [ -n "$c" ] && [ -k "$p" ] && ! [ -O "$c" ]; }; then return 1; fi',
  '    if [ "$p" = / ]; then return 0; fi',
  '    c=$p; p=$(dirname -- "$p")',
  "  done",
  "}",
  "for d; do r=$(cd -P -- \"$d\" 2>/dev/null && pwd -P) && safe \"$d\" && safe \"$r\" && printf '%s\\t%s\\n' \"$d\" \"$r\"; done; exit 0",
].join("\n");

/**
 * The stage's toolchain directories (toolchainDirs) the agent can reach and cannot change (TOOLCHAIN_CHECK, as the agent)
 * whose real path is not off-limits either (a link into the agent's home or Factory's is dropped): Copilot's sandbox
 * cannot bind one the agent cannot reach, and would not start. Kept on `runner.toolchain` for its settings
 * (copilotRunnerSettings), once per runner.
 */
export async function runnerToolchain(runner, env = process.env) {
  if (runner.toolchain) return runner.toolchain;
  const dirs = toolchainCandidates(runner, env.PATH || "", env);
  const r = dirs.length ? await exec("/bin/sh", ["-c", TOOLCHAIN_CHECK, "sh", ...dirs], { cwd: runner.agentHome, env }) : { stdout: "" };
  const off = offLimits(runner, env);
  const reached = String(r.stdout)
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([d, real]) => dirs.includes(d) && real?.startsWith("/") && real !== "/" && !off.some((x) => within(real, x) || within(x, real)));
  runner.toolchain = outermost(reached.map(([d]) => d));
  return runner.toolchain;
}

/**
 * The stage's node and the npm beside it, as a command finds them on the PATH Copilot gets (launchPath): the first entry
 * with an executable `node`, read by Factory. {node, npm}: npm "" where there is none beside it; null where the PATH has
 * no node (nothing to prove).
 */
export function stageNode(layout, path = "") {
  const exe = (f) => {
    try {
      accessSync(f, constants.X_OK);
      return statSync(f).isFile();
    } catch {
      return false;
    }
  };
  for (const d of launchPath(layout, path)) {
    if (!exe(join(d, "node"))) continue;
    return { node: join(d, "node"), npm: exe(join(d, "npm")) ? join(d, "npm") : "" };
  }
  return null;
}

/**
 * Local mode's toolchain for Copilot's commands on Linux (#111): the stage's node, which a developer's version manager
 * (nvm, mise, asdf, Volta) keeps in their home, where Copilot's sandbox binds nothing. The first `node` on the stage's
 * PATH by its real path; a version manager's shim (whose real path is not a `node`) gives way to the node running Factory
 * (`execPath`), which is what the shim chose. Returns {bin, toolchain: {node, npm}, dirs, denied}, or null with no node:
 * - `bin` leads each command's PATH (bwrapShim `pathFirst`), so a command finds this node before a shim it cannot run;
 * - `dirs`: its install prefix (`bin`'s parent; npm is bin/npm -> ../lib), read-only in commands' policy, and nothing
 *   else of the home. None where the sandbox binds it already (/usr/bin), or where it is `/`, the home or above it, in or
 *   above a credential store, or in or above `off`: what any sandbox may write (the Objective's directory, the stage's
 *   temp directory), so no sandboxed code can swap it for a link before Copilot's bubblewrap binds it by its path. The
 *   probe's toolchain rule then Blocks.
 * - `denied`: its `etc` (npm's global npmrc, which can hold a registry token), where there is one.
 * `toolchain` is what the probe proves (probeDriver).
 */
export function localToolchain({ path = "", off = [], home = homedir(), execPath = process.execPath } = {}) {
  const real = (f) => {
    try {
      return realpathSync(f);
    } catch {
      return null;
    }
  };
  const first = absolutePath(path)
    .split(":")
    .map((d) => join(d, "node"))
    .find((f) => {
      try {
        accessSync(f, constants.X_OK);
        return statSync(f).isFile();
      } catch {
        return false;
      }
    });
  if (!first) return null;
  let node = real(first);
  if (!node || basename(node) !== "node") node = real(execPath);
  if (!node || basename(node) !== "node") return null;
  const bin = dirname(node);
  const npm = join(bin, "npm");
  const toolchain = { node, npm: existsSync(npm) ? npm : "" };
  const prefix = basename(bin) === "bin" ? dirname(bin) : bin;
  const fenced = [...off, ...credentialPaths(home)].filter((x) => x && x.startsWith("/"));
  const bound = SYSTEM_BOUND.some((d) => within(bin, d));
  const safe = !bound && prefix !== "/" && !within(home, prefix) && !fenced.some((x) => within(prefix, x) || within(x, prefix));
  return { bin, toolchain, dirs: safe ? [prefix] : [], denied: safe && existsSync(join(prefix, "etc")) ? [join(prefix, "etc")] : [] };
}
export const COPILOT_TMP_LAUNCH = 'if [ -L "$1" ] || { [ -e "$1" ] && ! [ -d "$1" -a -O "$1" ]; }; then echo "factory: $1 is not a directory of its own" >&2; exit 126; fi; [ -d "$1" ] || mkdir -m 700 -- "$1" || exit 126; t=$1; shift; exec /usr/bin/env TMPDIR="$t" "$@"';

/** Copilot's settings and seeds for a fresh COPILOT_HOME: nothing trusted, no MCP servers, the sandbox's policy. */
const homeFiles = (runner) => ({ ...copilotHomeFiles(), "settings.json": `${JSON.stringify(copilotRunnerSettings(runner), null, 2)}\n` });

/** Write `files` ({name: text}) into `dir` as the agent, each from a pipe. */
async function writeAgentFiles(dir, files, cwd, env) {
  for (const [name, text] of Object.entries(files)) {
    const w = await exec("/bin/sh", ["-c", 'cat > "$1/$2"', "sh", dir, name], { cwd, env, input: text });
    if (w.code !== 0) throw new GitRefusal("git-clear", `Copilot's ${name} could not be written`);
  }
}

/**
 * Copilot's state made afresh before a start, as the agent: its state directory removed (a link is removed, never
 * followed) and made with a fresh COPILOT_HOME holding Factory's settings, then every session archive Factory holds
 * unpacked into its session-state; and the harness configuration Copilot would load from the agent's temp directory, an
 * added directory, removed.
 */
export async function resetCopilotState(runner, env = process.env) {
  const made = await exec("/bin/sh", ["-c", 'set -e; rm -rf -- "$1"; mkdir -m 700 -- "$1" "$2" "$3"', "sh", runner.state, runner.copilotHome, runner.sessions], { cwd: runner.agentHome, env });
  if (made.code !== 0) throw new GitRefusal("git-clear", `Copilot's state could not be made afresh: ${String(made.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  await runnerToolchain(runner, env);
  await writeAgentFiles(runner.copilotHome, homeFiles(runner), runner.agentHome, env);
  for (const tar of SESSIONS_HELD()) {
    const put = await untarAsAgent(tar, runner.sessions, { cwd: runner.agentHome, env });
    if (put.code !== 0) throw new GitRefusal("git-clear", `a saved session could not be put back in Copilot's state: ${String(put.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `exit ${put.code}`}`);
  }
  const cleared = await exec("/bin/sh", ["-c", 'd=$1; shift; cd -- "$d" 2>/dev/null || exit 0; rm -rf -- "$@"', "sh", runner.agentTmp, ...HARNESS_CONFIG.dirs, ...HARNESS_CONFIG.files], { cwd: runner.agentHome, env });
  if (cleared.code !== 0) throw new GitRefusal("git-clear", "the agent's temp directory could not be cleared of harness configuration");
}

// ------------------------------------------------------------- the confinement probe

/** The file the probe leaves its result in, in the agent's temp directory: its exit code, then its last line. */
export const PROBE_RESULT = ".factory-copilot-probe";
/**
 * The file the probe tries to make, from inside the sandbox, in the agent's home, the probe's own COPILOT_HOME, Factory's
 * HOME for Copilot and its release (persistDirs); none may be there afterwards.
 */
export const PROBE_PERSIST = ".factory-copilot-probe-home";
export const persistDirs = (runner) => [runner.agentHome, runner.probeHome, runner.home, runner.cacheHome];

/**
 * The command the probe's model runs, from Copilot's environment (FACTORY_COPILOT_PROBE): Copilot's path checks refuse a
 * command that names a path outside the checkout, so the paths travel in the script, never in the command line. Inside
 * the sandbox it refuses to go on without its script or its decoy (an empty one would pass unchecked); checks that
 * Copilot's own TMPDIR, where each command's network rules are written, is neither listed nor writable; tries a file in
 * each of `persist` (Factory checks from outside that none was made: inside, a path the sandbox does not bind is a
 * throwaway); then runs CONFINEMENT_PROBE (FACTORY_PROBE_SCRIPT) with no home rule. It writes an exit code and a last
 * line to PROBE_RESULT: a pass is 0 and PROBE_PASS, nothing else. `copilotTmp`: Copilot's own TMPDIR (local mode's:
 * harness.mjs copilotLocalCheck); the commands' own $TMPDIR must not hold its rules either. `tmp`: the temp directory
 * commands must have, for the result and the temp rule, by its path (local mode: where $TMPDIR is not it, as without
 * Factory's bwrap, the probe still writes its result and names the rule that broke); else $TMPDIR. `toolchain`: the
 * stage's node and npm (stageNode), which a command must find on its PATH, the same node, and run (#105); null: no rule.
 */
export const probeDriver = ({ gitConfig, host, marker, persist = [], logs = "", copilotTmp = COPILOT_TMP, tmp = "", toolchain = null, relay = null }) => {
  const T = tmp ? sq(tmp) : '"$TMPDIR"';
  return [
    `out() { printf '%s\\n%s\\n' "$1" "$2" > ${T}/${PROBE_RESULT}; exit 0; }`,
    `[ -n "$FACTORY_PROBE_SCRIPT" ] || out 4 "the probe script is missing"`,
    `[ -n "$FACTORY_PROBE_DECOY" ] || out 4 "the probe's decoy is missing"`,
    // Where Copilot's TMPDIR is, where it would be had it the default /tmp, and the commands' own (had it theirs).
    `for p in ${sq(copilotTmp)}/mxc-bwrap-proxy-* "$TMPDIR"/mxc-bwrap-proxy-* ${T}/mxc-bwrap-proxy-* /tmp/mxc-bwrap-proxy-*; do if [ -e "$p" ]; then out 4 "Copilot's network rules are visible to commands"; fi; done`,
    `if true >> ${sq(`${copilotTmp}/${PROBE_PERSIST}`)} 2>/dev/null; then out 4 "Copilot's temp directory is writable"; fi`,
    // The logs directory by its path (the probe's COPILOT_HOME's), never by a variable a command may not have.
    ...(logs ? [`if [ -n "$(find ${sq(logs)} -type f -size +0 2>/dev/null | head -n 1)" ]; then out 4 "Copilot's logs are readable by commands"; fi`] : []),
    // Bubblewrap is the sandbox's first process: its arguments must not hold the marker. (Copilot's own: Codex's probe
    // gets the marker as an argument, which its sandbox's first process then holds.)
    `if tr '\\0' '\\n' < /proc/1/cmdline 2>/dev/null | grep -qxF -e ${sq(marker)} -e ${sq(`${PROBE_MARKER}=${marker}`)}; then out 4 "the credential stand-in is in the first process's command line"; fi`,
    // The stage's toolchain, as a command finds it: the same node first on its PATH, and it and npm run.
    ...(toolchain?.node ? [`if [ "$(command -v node)" != ${sq(toolchain.node)} ] || ! node --version >/dev/null 2>&1${toolchain.npm ? " || ! npm --version >/dev/null 2>&1" : ""}; then out 4 ${sq(TOOLCHAIN_RULE)}; fi`] : []),
    // The gateway relay (gateway-relay.mjs), when the run relays a key: this relay's ping through the forwarder.
    ...(relay ? [`got=$( (curl -sS --max-time 5 ${sq(`http://127.0.0.1:${relay.port}${RELAY_PING}`)} || node -e 'fetch(process.argv[1]).then((r) => r.text()).then((t) => process.stdout.write(t), () => {})' ${sq(`http://127.0.0.1:${relay.port}${RELAY_PING}`)}) 2>/dev/null)`, `case "$got" in *${sq(`factory-relay ${relay.probeId}`)}*) ;; *) out 4 ${sq(RELAY_RULE)} ;; esac`] : []),
    ...persist.map((d) => `true >> ${sq(`${d}/${PROBE_PERSIST}`)} 2>/dev/null`),
    `r=0; o=$(sh -c "$FACTORY_PROBE_SCRIPT" sh "" ${sq(gitConfig)} ${T} ${sq(host)} ${sq(marker)} "$FACTORY_PROBE_DECOY") || r=$?`,
    `out "$r" "$(printf '%s\\n' "$o" | tail -n 1)"`,
  ].join("\n");
};

/** The probe's launch: CONFINEMENT_PROBE's decoy, then Copilot with the decoy's pid in its environment (for the decoy rule). */
export const COPILOT_DECOY_LAUNCH = decoyLaunch('FACTORY_PROBE_DECOY=$d copilot "$@"');

/**
 * A model for the probe, on this machine's loopback: Copilot's BYOK provider (COPILOT_OFFLINE), speaking the Responses
 * API. Its first answer is one shell call, `sh -c "$FACTORY_COPILOT_PROBE"`; every later one ends the session. Nothing
 * leaves the machine and nothing is billed. Returns {env, close, toolOutput}: the provider variables Copilot needs, and
 * what Copilot answered for the call (for the log only: where the sandbox did not start, its reason is there).
 */
export async function probeModel() {
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  let n = 0;
  let toolOutput = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      if (body.length < 4_000_000) body += c;
    });
    req.on("end", () => {
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {
        // an empty or partial request is answered like a first one
      }
      const outputs = (Array.isArray(j.input) ? j.input : []).filter((i) => i?.type === "function_call_output");
      const answered = outputs.length > 0;
      if (answered) toolOutput = String(outputs.at(-1).output ?? "").slice(0, 2000);
      const item = answered
        ? { type: "message", role: "assistant", id: "msg_probe", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }
        : { type: "function_call", id: "fc_probe", call_id: "call_probe", name: "bash", arguments: JSON.stringify({ command: 'sh -c "$FACTORY_COPILOT_PROBE"', description: "Factory's sandbox probe" }), status: "completed" };
      const id = `resp_probe_${++n}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of [
        { type: "response.created", response: { id } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id, object: "response", status: "completed", model: "factory-probe", output: [item], usage } },
      ])
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    env: { COPILOT_OFFLINE: "true", COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`, COPILOT_PROVIDER_WIRE_API: "responses", COPILOT_MODEL: "gpt-5" },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    toolOutput: () => toolOutput,
  };
}

/**
 * The probe's environment beside the provider's: a fresh COPILOT_HOME of its own (the run's settings), Factory's
 * release, the marker Copilot and the decoy hold (as Copilot holds the token), and the scripts; `toolchain` for its
 * toolchain rule (probeDriver).
 */
/** The probe's rule for the gateway relay: a command in Copilot's sandbox does not reach it. */
export const RELAY_RULE = "the gateway relay is out of the commands' reach";

export function probeEnv(runner, marker, host, toolchain = null, relay = null) {
  return {
    COPILOT_HOME: runner.probeHome,
    COPILOT_CACHE_HOME: runner.cacheHome,
    [PROBE_MARKER]: marker,
    FACTORY_PROBE_SCRIPT: CONFINEMENT_PROBE,
    FACTORY_COPILOT_PROBE: probeDriver({ gitConfig: join(runner.clone, ".git", "config"), host, marker, persist: persistDirs(runner), logs: join(runner.probeHome, "logs"), toolchain, relay, ...(runner.copilotTmp ? { copilotTmp: runner.copilotTmp, tmp: runner.agentTmp } : {}) }),
  };
}

/** Before a probe, as the agent: its own COPILOT_HOME made afresh with the run's settings, no result, no planted file. */
export async function resetProbe(runner, env = process.env) {
  if (factoryPlanted(runner)) throw new GitRefusal("sandbox", "a file is in Factory's HOME for Copilot that Factory did not put there", { rule: "Factory's HOME for Copilot is writable", harness: "copilot" });
  const made = await exec("/bin/sh", ["-c", 'set -e; rm -rf -- "$1"; mkdir -p -m 700 -- "$1"; rm -f -- "$2" "$3"', "sh", runner.probeHome, join(runner.agentTmp, PROBE_RESULT), join(runner.agentHome, PROBE_PERSIST)], { cwd: runner.agentHome, env });
  if (made.code !== 0) throw new GitRefusal("git-clear", "Copilot's sandbox probe could not be prepared");
  await runnerToolchain(runner, env);
  await writeAgentFiles(runner.probeHome, homeFiles(runner), runner.agentHome, env);
}

/**
 * The probe's result, read as the agent after it ran: {code, said}. `code` is the probe's exit code (0 confines, 4 a
 * rule broke, `said` naming it), or null when it left no result (it did not run). A file it made in the agent's home is
 * a broken rule of its own, and is removed.
 */
export async function probeResult(runner, env = process.env) {
  // As the agent: its home and the probe's COPILOT_HOME, which are its own. Factory's HOME and release: by Factory.
  const r = await exec("/bin/sh", ["-c", 'for p in "$2" "$3"; do if [ -e "$p" ] || [ -L "$p" ]; then rm -f -- "$p"; echo home; fi; done; cat -- "$1" 2>/dev/null; rm -f -- "$1"', "sh", join(runner.agentTmp, PROBE_RESULT), join(runner.agentHome, PROBE_PERSIST), join(runner.probeHome, PROBE_PERSIST)], { cwd: runner.agentHome, env });
  const lines = String(r.stdout).split("\n");
  if (factoryPlanted(runner)) return { code: 4, said: "Factory's HOME for Copilot is writable" };
  if (lines[0] === "home") return { code: 4, said: "the agent home is writable" };
  const code = /^\d+$/.test(lines[0] || "") ? Number(lines[0]) : null;
  return { code, said: lines[1] || "" };
}

/** Whether the probe's file is in Factory's HOME for Copilot or its release (read by Factory, which owns both). */
const factoryPlanted = (runner) => {
  const found = [runner.home, runner.cacheHome].map((d) => join(d, PROBE_PERSIST)).filter((f) => !!lstatSync(f, { throwIfNoEntry: false }));
  for (const f of found) rmSync(f, { force: true });
  return found.length > 0;
};

/** A fresh random marker for one probe. */
export const probeMarker = () => randomBytes(16).toString("hex");
