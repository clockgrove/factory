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
import { join } from "node:path";
import { exec, SAFE_PATH } from "./proc.mjs";
import { GitRefusal, HARNESS_CONFIG, LOCAL_DOMAINS, codexReadOnly, copilotHomeFiles, copilotLocalSettings, gitGuards } from "./local.mjs";
import { RUNNER_CACHES, SESSIONS_HELD, prepareFactoryHome } from "./claude-runner.mjs";
import { CONFINEMENT_PROBE, PROBE_MARKER, decoyLaunch } from "./codex-runner.mjs";

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
 * `--setenv`). Among bubblewrap's own options (before the first `--`) each command's HOME and TMPDIR become the agent's.
 * Nothing else changes. Lives in Factory's HOME for Copilot, which the agent cannot write.
 */
export const bwrapShim = (realBwrap, home, tmp) => `#!/bin/sh
# Factory: Copilot's bubblewrap on a runner (lib/copilot-runner.mjs). Started with no environment, so the token Copilot
# holds is not in the sandbox's pid 1; each command's HOME and TMPDIR are the agent's.
first=1; p1=""; p2=""; done=""
for a do
  if [ "$first" = 1 ]; then set --; first=0; fi
  if [ -z "$done" ] && [ "$p2" = --setenv ] && [ "$p1" = HOME ]; then a=${sq(home)}; fi
  if [ -z "$done" ] && [ "$p2" = --setenv ] && [ "$p1" = TMPDIR ]; then a=${sq(tmp)}; fi
  [ "$a" = "--" ] && done=1
  set -- "$@" "$a"
  p2=$p1; p1=$a
done
exec /usr/bin/env -i ${sq(realBwrap)} "$@"
`;

/**
 * Factory's HOME for Copilot made afresh (claude-runner.mjs prepareFactoryHome) with the shim in its bin directory and
 * Copilot's release unpacked into its cache directory: by Factory's own user, from the CLI the Action or the start
 * installed, with an environment of PATH, HOME and COPILOT_CACHE_HOME only. The agent reads both and writes neither.
 */
export async function prepareCopilotHome(layout, { env = process.env, sudo = true, run = exec } = {}) {
  await prepareFactoryHome(layout.home, "Copilot", { sudo });
  const bwrap = await run("/bin/sh", ["-c", "command -v bwrap"], { env: { PATH: env.PATH || SAFE_PATH } });
  const real = String(bwrap.stdout).trim();
  // Without bwrap there is no shim, so Copilot's sandbox cannot start: the pre-start probe Blocks (doctor names it).
  const shim = bwrap.code === 0 && real.startsWith("/") ? 'cat > "$1/bwrap"; chmod 755 "$1/bwrap"' : "true";
  const made = await run("/bin/sh", ["-c", `set -e; mkdir -m 755 -- "$1" "$2"; ${shim}`, "sh", layout.bin, layout.cacheHome], { input: bwrapShim(real, layout.agentHome, layout.agentTmp), env: { PATH: SAFE_PATH } });
  if (made.code !== 0) throw new Error(`Copilot's home ${layout.home} could not be filled: ${String(made.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  // umask 022: the agent reads what Copilot unpacks (a cloud sandbox's stage runs with 077).
  const unpacked = await run("/bin/sh", ["-c", 'umask 022; exec copilot --version'], { env: { PATH: env.PATH || SAFE_PATH, HOME: layout.home, COPILOT_CACHE_HOME: layout.cacheHome }, timeoutMs: 120_000 });
  if (unpacked.code !== 0) throw new Error(`Copilot could not unpack its release into ${layout.cacheHome}: ${String(unpacked.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `exit ${unpacked.code}`}`);
}

/**
 * Copilot's settings.json on a runner, which is also its sandbox's policy: local mode's (local.mjs copilotLocalSettings)
 * fitted to the agent. Commands may write the checkout (its .git for commits), the agent's temp directory and the
 * package caches; never the checkout's git hooks, config, commondir, info and harness configuration. They read the
 * agent's GitHub login (read-only), and nothing else of the agent's home is in their sandbox. No credential store is
 * denied: the agent's home holds only that login, which is for its commands. The network is `domains`.
 */
export function copilotRunnerSettings(runner) {
  return copilotLocalSettings({
    domains: runner.domains || LOCAL_DOMAINS,
    clone: runner.clone,
    addDirs: [runner.clone, runner.agentTmp, ...runner.caches],
    readOnly: [...new Set([...gitGuards(runner.clone), ...codexReadOnly(runner.clone)])],
    readable: runner.login,
    denied: [],
    platform: "linux",
  });
}

/** The env Copilot gets on a runner beside its credential: its fresh state and Factory's unpacked release. */
export const copilotRunnerEnv = (layout) => ({ COPILOT_HOME: layout.copilotHome, COPILOT_CACHE_HOME: layout.cacheHome });

/** Copilot's flags on a runner: its sandbox, tools and URLs allowed, file tools kept to the checkout and the agent's temp directory. */
export const copilotRunnerFlags = (runner) => ["--sandbox", "--allow-all-tools", "--allow-all-urls", "--add-dir", runner.agentTmp];

/**
 * Copilot's command line on a runner: Factory's HOME for it, a fresh /tmp as its TMPDIR, and a PATH with Factory's shim
 * first and nothing of the agent's home, so nothing the agent wrote is read at its start.
 */
export function copilotLaunch(layout, cmd, args, path = process.env.PATH || "") {
  const safe = path.split(":").filter((d) => d && d !== layout.agentHome && !d.startsWith(`${layout.agentHome}/`));
  return ["/usr/bin/env", [`HOME=${layout.home}`, "TMPDIR=/tmp", `PATH=${[layout.bin, ...safe].join(":")}`, cmd, ...args]];
}

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
  await writeAgentFiles(runner.copilotHome, homeFiles(runner), runner.agentHome, env);
  for (const tar of SESSIONS_HELD()) {
    const put = await exec("tar", ["-xf", "-", "-C", runner.sessions], { cwd: runner.agentHome, env, input: tar });
    if (put.code !== 0) throw new GitRefusal("git-clear", "a saved session could not be put back in Copilot's state");
  }
  const cleared = await exec("/bin/sh", ["-c", 'd=$1; shift; cd -- "$d" 2>/dev/null || exit 0; rm -rf -- "$@"', "sh", runner.agentTmp, ...HARNESS_CONFIG.dirs, ...HARNESS_CONFIG.files], { cwd: runner.agentHome, env });
  if (cleared.code !== 0) throw new GitRefusal("git-clear", "the agent's temp directory could not be cleared of harness configuration");
}

// ------------------------------------------------------------- the confinement probe

/** The file the probe leaves its result in, in the agent's temp directory: its exit code, then its last line. */
export const PROBE_RESULT = ".factory-copilot-probe";
/** The file the probe tries to make in the agent's home from inside the sandbox; it must not be there afterwards. */
export const PROBE_PERSIST = ".factory-copilot-probe-home";

/**
 * The command the probe's model runs, from Copilot's environment (FACTORY_COPILOT_PROBE): Copilot's path checks refuse a
 * command that names a path outside the checkout, so the paths travel in the script, never in the command line. Inside
 * the sandbox it tries a file in the agent's home (Factory checks from outside that none was made: inside, a path the
 * sandbox does not bind is a throwaway), then runs CONFINEMENT_PROBE (FACTORY_PROBE_SCRIPT) with no home rule, and
 * writes its exit code and last line to PROBE_RESULT.
 */
export const probeDriver = ({ gitConfig, host, marker }) =>
  [
    `true >> "$HOME/${PROBE_PERSIST}" 2>/dev/null`,
    `r=0; o=$(sh -c "$FACTORY_PROBE_SCRIPT" sh "" ${sq(gitConfig)} "$TMPDIR" ${sq(host)} ${sq(marker)} "$FACTORY_PROBE_DECOY") || r=$?`,
    `printf '%s\\n%s\\n' "$r" "$(printf '%s\\n' "$o" | tail -n 1)" > "$TMPDIR/${PROBE_RESULT}"`,
  ].join("\n");

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
    close: () => new Promise((resolve) => server.close(() => resolve())),
    toolOutput: () => toolOutput,
  };
}

/**
 * The probe's environment beside the provider's: a fresh COPILOT_HOME of its own (the run's settings), Factory's
 * release, the marker Copilot and the decoy hold (as Copilot holds the token), and the scripts.
 */
export function probeEnv(runner, marker, host) {
  return {
    COPILOT_HOME: runner.probeHome,
    COPILOT_CACHE_HOME: runner.cacheHome,
    [PROBE_MARKER]: marker,
    FACTORY_PROBE_SCRIPT: CONFINEMENT_PROBE,
    FACTORY_COPILOT_PROBE: probeDriver({ gitConfig: join(runner.clone, ".git", "config"), host, marker }),
  };
}

/** Before a probe, as the agent: its own COPILOT_HOME made afresh with the run's settings, no result, no planted file. */
export async function resetProbe(runner, env = process.env) {
  const made = await exec("/bin/sh", ["-c", 'set -e; rm -rf -- "$1"; mkdir -p -m 700 -- "$1"; rm -f -- "$2" "$3"', "sh", runner.probeHome, join(runner.agentTmp, PROBE_RESULT), join(runner.agentHome, PROBE_PERSIST)], { cwd: runner.agentHome, env });
  if (made.code !== 0) throw new GitRefusal("git-clear", "Copilot's sandbox probe could not be prepared");
  await writeAgentFiles(runner.probeHome, homeFiles(runner), runner.agentHome, env);
}

/**
 * The probe's result, read as the agent after it ran: {code, said}. `code` is the probe's exit code (0 confines, 4 a
 * rule broke, `said` naming it), or null when it left no result (it did not run). A file it made in the agent's home is
 * a broken rule of its own, and is removed.
 */
export async function probeResult(runner, env = process.env) {
  const r = await exec("/bin/sh", ["-c", 'if [ -e "$2" ] || [ -L "$2" ]; then rm -f -- "$2"; echo home; fi; cat -- "$1" 2>/dev/null; rm -f -- "$1"', "sh", join(runner.agentTmp, PROBE_RESULT), join(runner.agentHome, PROBE_PERSIST)], { cwd: runner.agentHome, env });
  const lines = String(r.stdout).split("\n");
  if (lines[0] === "home") return { code: 4, said: "the agent home is writable" };
  const code = /^\d+$/.test(lines[0] || "") ? Number(lines[0]) : null;
  return { code, said: lines[1] || "" };
}

/** A fresh random marker for one probe. */
export const probeMarker = () => randomBytes(16).toString("hex");
