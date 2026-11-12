// Codex on a runner (Actions, a cloud sandbox VM), where it runs as the agent uid (agent.mjs) with its commands in its
// own sandbox (harness.mjs codexRunner, local.mjs codexLocalConfig), as Claude Code's are (claude-runner.mjs).
//
// Why: the agent uid holds the model credential in Codex's environment, and Linux lets any process of a uid read the
// environment of every other process of that uid (/proc/<pid>/environ), Codex's own and the git processes it starts
// with it (#87). Codex's sandbox gives each command its own PID namespace and denies /proc, so no command reaches them.
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
 * The confinement probe Codex's sandbox must pass before a start (harness.mjs codexSandboxCheck, doctor): run inside the
 * sandbox with the agent's home, a file that must stay read-only (or ""), a directory that must be writable and a host
 * off the allow-list (or "") as arguments, then a random value (or ""). Codex's own process (`codex sandbox`, the
 * harness's stand-in) is started with PROBE_MARKER set to that value in its environment, as a run's Codex holds its
 * credential, and the profile keeps PROBE_MARKER out of commands as it keeps the credential: no process the probe can
 * see may show it in its environment, which is what keeps the credential out of every command's reach (#87). Exit 0 when it
 * confines; exit 4 with the broken rule on stdout; anything else means the sandbox did not start. `true >>` opens for
 * append and writes nothing (a regular builtin: a refused redirection is no shell error, as it is for `:`), so a
 * writable file is left as it was.
 */
export const PROBE_MARKER = "FACTORY_PROBE_MARKER";
export const CONFINEMENT_PROBE = [
  'h=$1; g=$2; t=$3; host=$4; m=$5; f=".factory-sandbox-probe-$$"',
  'if true >> "$h/$f" 2>/dev/null; then rm -f -- "$h/$f"; echo "the agent home is writable"; exit 4; fi',
  'if [ -n "$g" ] && [ -e "$g" ] && true >> "$g" 2>/dev/null; then echo "$g is writable"; exit 4; fi',
  'if ! true > "$t/$f" 2>/dev/null; then echo "the agent temp directory is not writable"; exit 4; fi; rm -f -- "$t/$f"',
  `if [ -n "$m" ]; then for d in /proc/[0-9]*; do if tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qxF "${PROBE_MARKER}=$m"; then echo "the credential stand-in is readable in a process environment"; exit 4; fi; done; fi`,
  'if [ -n "$host" ] && command -v curl >/dev/null 2>&1 && curl -s -m 5 -o /dev/null "https://$host/" 2>/dev/null; then echo "$host, off the allow-list, is reachable"; exit 4; fi',
  "exit 0",
].join("\n");

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
