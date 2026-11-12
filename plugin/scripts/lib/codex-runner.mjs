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
import { join } from "node:path";
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
 * followed) and made empty, the package caches made where absent (the sandbox's writable roots must exist), then every
 * session archive Factory holds unpacked into its sessions directory.
 */
export async function resetCodexState(layout, env = process.env) {
  const made = await exec("/bin/sh", ["-c", 'set -e; rm -rf -- "$1"; mkdir -m 700 -- "$1" "$2" "$3"; shift 3; for c in "$@"; do [ -L "$c" ] || mkdir -p -- "$c"; done', "sh", layout.state, layout.codexHome, layout.sessions, ...layout.caches], { cwd: layout.agentHome, env });
  if (made.code !== 0) throw new GitRefusal("git-clear", `Codex's state could not be made afresh: ${String(made.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  for (const tar of SESSIONS_HELD()) {
    const put = await exec("tar", ["-xf", "-", "-C", layout.sessions], { cwd: layout.agentHome, env, input: tar });
    if (put.code !== 0) throw new GitRefusal("git-clear", "a saved session could not be put back in Codex's state");
  }
}

/**
 * Which of the checkout's read-only paths are there, listed as the agent (the checkout is the agent's, 700): Codex's
 * sandbox refuses to start on an absent one, so only those present go in its profile.
 */
export async function presentPaths(clone, env = process.env) {
  const paths = codexReadOnly(clone);
  const r = await exec("/bin/sh", ["-c", 'for p; do if [ -e "$p" ] || [ -L "$p" ]; then printf "%s\\n" "$p"; fi; done', "sh", ...paths], { cwd: clone, env });
  return new Set(String(r.stdout).split("\n").filter((p) => paths.includes(p)));
}

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
    secretEnv,
    commandEnv: { HOME: runner.agentHome, TMPDIR: runner.agentTmp },
  });
}

/** The env Codex gets on a runner beside its credential: its fresh state directory. */
export const codexRunnerEnv = (layout) => ({ CODEX_HOME: layout.codexHome });
