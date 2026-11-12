// Codex on a runner (Actions, a cloud sandbox VM), where it runs as the agent uid (agent.mjs) with its commands in its
// own sandbox (harness.mjs codexRunner, local.mjs codexLocalConfig), as Claude Code's are (claude-runner.mjs).
//
// Why: the agent uid holds the model credential in Codex's environment, and Linux lets any process of a uid read the
// environment of every other process of that uid (/proc/<pid>/environ), Codex's own and the git processes it starts
// with it (#87). Codex's sandbox (bubblewrap and seccomp) runs each command in a user namespace of its own, without
// CAP_SYS_PTRACE, so the kernel refuses its read of any process outside (cap_ptrace_access_check); where bubblewrap can
// mount a fresh /proc (NAMESPACE_WRAP) the command also has its own PID namespace and sees none of them. Under the
// systemd unit (ProtectKernelTunables) it cannot, Codex retries without one, and the host's world-readable /proc entries
// (cmdline, status, net) stay visible. The confinement probe checks the read refusal before every start.
//
// The invariant, as for Claude Code: nothing the agent uid can write, inside or outside Codex's sandbox, is read or run
// by Codex's own start-up outside the sandbox. Validation, install and setup run the repository's code as the agent
// outside the sandbox, so the agent's home and the checkout's .git are the agent's to plant things in. So:
// - Codex's HOME is a directory Factory owns (CODEX_RUNNER_HOME): empty, so its shell snapshot (`bash -lc`, run with
//   the credential in its environment) sources no start-up file of the agent's. The unit (or NAMESPACE_WRAP) sees it
//   read-only.
// - Its TMPDIR is /tmp, which its unit (PrivateTmp) or NAMESPACE_WRAP makes private and fresh for every start.
// - CODEX_HOME (its config, sessions and plugins) lives in the agent's home but is made afresh and empty before every
//   start, with only the sessions Factory itself captured put back; `--ignore-user-config` besides. Its sandboxed
//   commands cannot write it.
// - The checkout's .git config, commondir, info/attributes and hooks, which Codex's own git reads with the credential
//   in its environment, are put back to what Factory pinned (claude-runner.mjs pinRunnerGit, restoreRunnerGit), and the
//   checkout's harness configuration is restored to the commit (local.mjs clearHarnessConfig).
// - Its commands get the agent's own HOME and TMPDIR back (`shell_environment_policy.set`), so package caches and the
//   agent's read-only gh login work as before.
import { join, relative } from "node:path";
import { exec } from "./proc.mjs";
import { GitRefusal, codexLocalConfig, codexReadOnly } from "./local.mjs";
import { RUNNER_CACHES, SESSIONS_HELD } from "./claude-runner.mjs";

/** Codex's HOME on a runner: Factory's own, outside every home the agent can write. */
export const CODEX_RUNNER_HOME = "/var/lib/factory-codex";

/** Codex's sessions on a runner, relative to the agent's home (session.mjs reads and restores them there). */
export const CODEX_RUNNER_SESSION_ROOT = ".factory-codex/home/sessions";

/** Where everything lives for one agent: Factory's HOME for Codex, and the per-start state in the agent's home. */
export function codexRunnerLayout(agent, home = CODEX_RUNNER_HOME) {
  const state = join(agent.home, ".factory-codex");
  return {
    home,
    agentHome: agent.home,
    agentTmp: agent.tmp,
    state,
    codexHome: join(state, "home"),
    sessions: join(agent.home, CODEX_RUNNER_SESSION_ROOT),
    sessionDepth: 4,
    caches: RUNNER_CACHES.map((c) => join(agent.home, c)),
  };
}

/**
 * Codex's state made afresh before a start, as the agent: its state directory removed (a link is removed, never
 * followed) and made empty, then every session archive Factory holds unpacked into its sessions directory.
 */
export async function resetCodexState(layout, env = process.env) {
  // The caches are made by realRoots (claude-runner.mjs), which replaces a link with a real directory.
  const made = await exec("/bin/sh", ["-c", 'set -e; rm -rf -- "$1"; mkdir -m 700 -- "$1" "$2" "$3"', "sh", layout.state, layout.codexHome, layout.sessions], { cwd: layout.agentHome, env });
  if (made.code !== 0) throw new GitRefusal("git-clear", `Codex's state could not be made afresh: ${String(made.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  for (const tar of SESSIONS_HELD()) {
    const put = await exec("tar", ["-xf", "-", "-C", layout.sessions], { cwd: layout.agentHome, env, input: tar });
    if (put.code !== 0) throw new GitRefusal("git-clear", "a saved session could not be put back in Codex's state");
  }
}

/**
 * Which of the checkout's read-only paths are there, listed as the agent (the checkout is the agent's, 700): Codex's
 * sandbox refuses to start on an absent one, so only those present go in its profile. Fails closed: a listing that
 * fails, a `.git/commondir` or `.git/info/attributes` missing (the pre-start clear makes both), or a path that is a link
 * to nothing (which the sandbox cannot protect, and which it refuses) refuses the start, naming the path.
 */
export async function presentPaths(clone, env = process.env, { run = exec } = {}) {
  const paths = codexReadOnly(clone);
  const r = await run("/bin/sh", ["-c", 'for p; do if [ -L "$p" ] && [ ! -e "$p" ]; then printf "dangling\t%s\n" "$p"; elif [ -e "$p" ]; then printf "here\t%s\n" "$p"; fi; done', "sh", ...paths], { cwd: clone, env });
  if (r.code !== 0) throw new GitRefusal("git-clear", `the checkout's protected paths could not be listed: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `exit ${r.code}`}`);
  const rows = String(r.stdout).split("\n").map((l) => l.split("\t")).filter(([k, p]) => (k === "here" || k === "dangling") && paths.includes(p));
  const dangling = rows.find(([k]) => k === "dangling");
  if (dangling) throw new GitRefusal("sandbox", `${dangling[1]} is a link to nothing`, { path: relative(clone, dangling[1]) });
  const present = new Set(rows.map(([, p]) => p));
  for (const need of [join(clone, ".git", "commondir"), join(clone, ".git", "info", "attributes")]) if (!present.has(need)) throw new GitRefusal("git-clear", `${need} is missing after the pre-start clear`);
  return present;
}

/**
 * The confinement probe Codex's sandbox must pass before a start (harness.mjs codexSandboxCheck, doctor), run inside the
 * sandbox by DECOY_LAUNCH with, as arguments: the agent's home, a file that must stay read-only (or ""), a directory that
 * must be writable, a host off the allow-list (or ""), a random marker, and the pid of a decoy outside the sandbox.
 * Codex's own process (`codex sandbox`, the harness's stand-in) and the decoy, a plain dumpable `sleep` of the agent's
 * uid, hold PROBE_MARKER=<marker> in their environment, as a run's Codex and its git processes hold the credential; the
 * profile keeps PROBE_MARKER out of commands as it keeps the credential. No environment the probe can read under /proc
 * may show the marker, the decoy's above all: the decoy is readable by its uid unless the sandbox itself stops the read,
 * so a Codex release that only made its own process unreadable (non-dumpable) while loosening the sandbox fails here.
 * Exit 0 and PROBE_PASS when it confines; exit 4 with the broken rule on stdout; anything else means the sandbox did not start.
 * `true >>` opens for append and writes nothing (a regular builtin: a refused redirection is no shell error, as it is
 * for `:`), so a writable file is left as it was. The network rule needs curl or node; with neither it fails.
 */
export const PROBE_MARKER = "FACTORY_PROBE_MARKER";
/** The probe's last line when every rule held: Copilot's check passes only on it (an empty script would exit 0 too). */
export const PROBE_PASS = "factory: confined";
export const CONFINEMENT_PROBE = [
  'h=$1; g=$2; t=$3; host=$4; m=$5; d=$6; f=".factory-sandbox-probe-$$"',
  'if [ -n "$h" ] && true >> "$h/$f" 2>/dev/null; then rm -f -- "$h/$f"; echo "the agent home is writable"; exit 4; fi',
  'if [ -n "$g" ] && [ -e "$g" ] && true >> "$g" 2>/dev/null; then echo "the checkout\'s .git/config is writable"; exit 4; fi',
  'if ! true > "$t/$f" 2>/dev/null; then echo "the agent temp directory is not writable"; exit 4; fi; rm -f -- "$t/$f"',
  `seen() { tr '\\0' '\\n' < "$1/environ" 2>/dev/null | grep -qxF "${PROBE_MARKER}=$m"; }`,
  'if [ -n "$d" ] && seen "/proc/$d"; then echo "the decoy outside the sandbox is readable"; exit 4; fi',
  'if [ -n "$m" ]; then for p in /proc/[0-9]*; do if seen "$p"; then echo "the credential stand-in is readable in a process environment"; exit 4; fi; done; fi',
  // The sandbox's first process (bubblewrap where it has a PID namespace of its own) never holds it as an argument.
  `if [ -n "$m" ] && tr '\\0' '\\n' < /proc/1/cmdline 2>/dev/null | grep -qxF -e "$m" -e "${PROBE_MARKER}=$m"; then echo "the credential stand-in is in the first process's command line"; exit 4; fi`,
  'if [ -n "$host" ]; then',
  '  if command -v curl >/dev/null 2>&1; then curl -s -m 5 -o /dev/null "https://$host/" 2>/dev/null && { echo "$host, off the allow-list, is reachable"; exit 4; }',
  '  elif command -v node >/dev/null 2>&1; then node -e \'fetch("https://" + process.argv[1], { signal: AbortSignal.timeout(5000) }).then(() => process.exit(0), () => process.exit(1))\' "$host" 2>/dev/null && { echo "$host, off the allow-list, is reachable"; exit 4; }',
  '  else echo "no curl or node to check the network rule"; exit 4; fi',
  "fi",
  `echo "${PROBE_PASS}"`,
  "exit 0",
].join("\n");

/**
 * How the probe is launched, as the agent outside the sandbox: a decoy `sleep` holding the marker (its environment is
 * this shell's) is started first and checked to hold it, so the probe's decoy rule cannot pass because the decoy is
 * not there; then the harness (`start`: Codex's `codex "$@" <decoy pid>`, copilot-runner.mjs COPILOT_DECOY_LAUNCH), and
 * the decoy is stopped. Exit 5: the decoy did not come up. Neither this nor the probe holds a `${...}`: systemd-run
 * expands that form in a unit's arguments before the shell sees them.
 */
export const decoyLaunch = (start) =>
  [
    "sleep 300 & d=$!",
    "i=0",
    `until tr '\\0' '\\n' < "/proc/$d/environ" 2>/dev/null | grep -qxF "${PROBE_MARKER}=$${PROBE_MARKER}"; do i=$((i+1)); if [ "$i" -gt 100 ]; then kill "$d" 2>/dev/null; echo "factory: the probe's decoy did not come up" >&2; exit 5; fi; sleep 0.05; done`,
    `${start}; r=$?`,
    'kill "$d" 2>/dev/null',
    'exit "$r"',
  ].join("\n");
export const DECOY_LAUNCH = decoyLaunch('codex "$@" "$d"');

/** A host the probe tries that the allow-list does not name (none when `domains` names it or a wildcard covers it). */
export const offListHost = (domains = []) => (domains.some((d) => d === "example.com" || d === "*.com") ? "" : "example.com");

/**
 * Codex's `-c` flags on a runner: local mode's profile (codexLocalConfig) fitted to the agent. Commands may write the
 * checkout, the agent's temp directory and the package caches; never the checkout's git hooks, config and harness
 * configuration, nor anything else in the agent's home (Codex's own state included). The network is `domains`. No
 * credential store is hidden: the agent's home holds only its read-only GitHub token, which is for its commands.
 */
export function codexRunnerConfig({ runner, secretEnv }) {
  return codexLocalConfig({
    domains: runner.domains,
    clone: runner.clone,
    addDirs: [runner.clone, runner.agentTmp, ...runner.caches],
    home: runner.agentHome,
    secrets: [],
    exists: (p) => !!runner.present?.has(p),
    secretEnv: [...new Set([...secretEnv, PROBE_MARKER])],
    commandEnv: { HOME: runner.agentHome, TMPDIR: runner.agentTmp },
    denyProc: false,
  });
}

/** The env Codex gets on a runner beside its credential: its fresh state directory. */
export const codexRunnerEnv = (layout) => ({ CODEX_HOME: layout.codexHome });
