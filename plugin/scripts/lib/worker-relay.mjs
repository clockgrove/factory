// The gateway relay for a stage (#97): opened when the worker secrets carry the AI Gateway key (lib/gateway-relay.mjs
// RELAYED_NAME), wherever the stage runs. The key stays in this process; the worker's shell gets the relay's token in its
// place and the relay's address in FACTORY_GATEWAY_URL (harness.mjs). Never falls back to handing the key over: where the
// relay cannot reach the harness's commands, the stage Blocks before the run.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backend } from "./backend.mjs";
import { prepareFactoryHome } from "./claude-runner.mjs";
import { CALL_LOG, GATEWAY_KEY_SHAPE, RELAYED_NAME, openRelay, setActiveRelay } from "./gateway-relay.mjs";
import { nameLabel } from "./worker-secrets.mjs";
import { holdSecrets, log } from "./inputs.mjs";
import { SAFE_PATH, agentUser, exec, whichSync } from "./proc.mjs";
import { copilotRelayExtra, copilotRelayShimIn, localCopilotRelayShim, writeRelayShim } from "./relay-shim.mjs";
import { COPILOT_RUNNER_HOME, bakeCopilotRelay, copilotRunnerLayout } from "./copilot-runner.mjs";

/** The relay's directory on a runner and in a cloud sandbox: Factory's user owns it, the agent may only pass through. */
export const RELAY_RUNNER_DIR = "/var/lib/factory-relay";

/**
 * A Copilot stage's start on a runner: the shared relay shim an earlier Factory left in `runnerDir` (one per host, which
 * concurrent stages overwrote and a crashed one left behind) is removed; each stage's own is in its relay directory.
 */
export function dropSharedCopilotRelay(runnerDir = RELAY_RUNNER_DIR) {
  try {
    rmSync(join(runnerDir, "copilot"), { recursive: true, force: true });
  } catch (e) {
    log(`gateway relay: the shared Copilot shim in ${runnerDir} could not be removed (${String(e?.code || e?.message || e).slice(0, 60)})`);
  }
}

/** Local mode's relay directory: in the stage's usage directory, which no sandbox may write. */
export const localRelayDir = (usageDir) => join(usageDir, "relay");

/**
 * Where the relay's socket goes when its directory is under the stage's usage directory (locally, and in a developer's
 * own session): a short directory of the stage's own, `/tmp/factory-relay-<uid>/<12 hex>`. A Unix socket's path is
 * limited (107 bytes on Linux, 103 on macOS) and the usage directory's grows with the checkout's path, the issue and the
 * stage's name. Its name is a hash of the usage directory, so local mode's outer sandbox, written before the relay opens,
 * names it as the one socket directory it keeps reachable (local.mjs harnessOuterSettings), as it named the relay
 * directory before. No sandbox writes /tmp: the outer one writes only its allowed paths, and the harnesses' own write
 * the checkout and the stage's temp directory.
 */
export const RELAY_SOCKET_ROOT = "/tmp";
export function relaySocketDir(usageDir, { uid = process.getuid?.() ?? 0, root = RELAY_SOCKET_ROOT } = {}) {
  let base = root;
  try {
    // macOS: /tmp is a link to /private/tmp; the socket's path is the real one.
    base = realpathSync(root);
  } catch {
    // made below, or refused there
  }
  return join(base, `factory-relay-${uid}`, createHash("sha256").update(resolve(usageDir)).digest("hex").slice(0, 12));
}

/**
 * Make relaySocketDir's directory and its parent, each a real directory of this user's alone (mode 700): the parent is
 * in a directory every user writes, so one that is a link, a file, another user's or open to others is refused (throws,
 * naming which and why), never used. Once it is this user's own, /tmp's sticky bit keeps others from replacing it.
 */
export function makeSocketDir(dir, { uid = process.getuid?.() ?? 0 } = {}) {
  for (const d of [dirname(dir), dir]) {
    try {
      mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if (e?.code !== "EEXIST") throw new Error(`${d} could not be made (${e?.code || e?.message || e})`);
    }
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a directory (a link or a file stands there)`);
    if (st.uid !== uid) throw new Error(`${d} belongs to another user`);
    if (st.mode & 0o077) throw new Error(`${d} is open to other users (mode ${(st.mode & 0o777).toString(8)})`);
  }
  return dir;
}

/**
 * The worker secrets an AI Gateway key must not reach as they are: any but RELAYED_NAME itself whose NAME is it in
 * another case, or whose value has a gateway key's shape (GATEWAY_KEY_SHAPE), whatever its NAME. Such a key is only ever
 * relayed, under RELAYED_NAME; under another name it is withheld. Names only.
 */
export const unrelayedGatewayKeys = (shell = {}) => Object.entries(shell).filter(([n, v]) => n !== RELAYED_NAME && (n.toUpperCase() === RELAYED_NAME || GATEWAY_KEY_SHAPE.test(String(v)))).map(([n]) => n);

/**
 * Open the stage's relay when `shell` (the worker's shell secrets, worker-secrets.mjs) carries RELAYED_NAME. Returns
 * {shell, relay, blocked, masked}: `shell` with the token in the key's place and any other gateway-shaped key withheld
 * (unrelayedGatewayKeys); `blocked` a reason when the key cannot be relayed here (the key is then out of `shell`, and the
 * caller Blocks before any run); `masked` the values the stage masks in what it saves (the key, which `shell` no longer
 * holds). `socketRoot`: where relaySocketDir's directory goes (RELAY_SOCKET_ROOT; a test sets its own).
 */
export async function openWorkerRelay({ inputs, shell, usageDir, env = process.env, open = openRelay, which = whichSync, runnerDir = RELAY_RUNNER_DIR, copilotHome = COPILOT_RUNNER_HOME, socketRoot = RELAY_SOCKET_ROOT }) {
  if (inputs.harness === "copilot" && agentUser() && backend(env).name !== "local") dropSharedCopilotRelay(runnerDir);
  const withheld = unrelayedGatewayKeys(shell || {});
  const masked = withheld.map((n) => shell[n]);
  if (withheld.length) log(`gateway relay: ${withheld.map(nameLabel).join(", ")} withheld: an AI Gateway key reaches the worker only relayed, as ${RELAYED_NAME}`);
  const kept = Object.fromEntries(Object.entries(shell || {}).filter(([n]) => !withheld.includes(n)));
  if (!kept[RELAYED_NAME]) return { shell: kept, relay: null, blocked: null, masked };
  const key = kept[RELAYED_NAME];
  masked.push(key);
  const rest = { ...kept };
  delete rest[RELAYED_NAME];
  const out = (o) => ({ masked, ...o });
  const local = backend(env).name === "local";
  const agent = agentUser();
  // No sandbox (a developer's own session): the commands share this machine's loopback, so the relay listens there.
  const sandboxed = local || !!agent;
  const bwrap = sandboxed ? which("bwrap", { PATH: SAFE_PATH }) || (local ? which("bwrap", env) : null) : null;
  const socat = sandboxed ? which("socat", { PATH: SAFE_PATH }) || (local ? which("socat", env) : null) : null;
  if (sandboxed && (!bwrap || !socat)) return out({ shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} needs ${[!bwrap && "bwrap", !socat && "socat"].filter(Boolean).join(" and ")} on this machine (it starts a forwarder in each command's sandbox); install it (sudo apt-get install -y bubblewrap socat), then re-apply factory:objective` });
  let dir;
  let group = null;
  let chgrp = null;
  if (agent && !local) {
    // A directory of the stage's own under Factory's (made once per machine, the agent may only pass through), removed
    // with its socket and shim when the stage ends (closeWorkerRelay).
    try {
      if (!existsSync(runnerDir)) await prepareFactoryHome(runnerDir, "The gateway relay");
    } catch (e) {
      return out({ shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} could not start: ${String(e?.message || e).slice(0, 200)}` });
    }
    dir = join(runnerDir, `stage-${randomBytes(6).toString("hex")}`);
    group = agent.user;
    chgrp = async (p, g) => {
      const r = await exec("/usr/bin/sudo", ["-n", "/bin/chgrp", g, p], { env: { PATH: SAFE_PATH } });
      if (r.code !== 0) throw new Error(`the relay's socket could not be handed to ${g}'s group: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 160) || `exit ${r.code}`}`);
    };
  } else dir = local ? localRelayDir(usageDir) : join(usageDir, "relay");
  // Under the usage directory the socket's path could pass its limit: it goes in a short directory of its own.
  let socketDir = null;
  if (!(agent && !local)) {
    try {
      socketDir = makeSocketDir(relaySocketDir(usageDir, { root: socketRoot }));
    } catch (e) {
      return out({ shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} could not start: its socket's directory: ${String(e?.message || e).slice(0, 200)}` });
    }
  }
  let relay;
  try {
    relay = await open({ key, dir, socketDir, group, chgrp, tcp: !sandboxed, maxUsd: inputs.maxUsd, callLog: join(usageDir, CALL_LOG), log });
  } catch (e) {
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
    return out({ shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} could not start: ${String(e?.message || e).slice(0, 240)}` });
  }
  // Claude Code and Codex: the relay's shim first on their PATH. Copilot: its own shim (copilot-runner.mjs bwrapShim),
  // already first on its PATH, hands each call to the relay's, which adds Copilot's extra options (copilotRelayExtra).
  if (sandboxed && inputs.harness === "copilot") {
    // In the stage's own relay directory, gone when the stage ends. Locally serve baked that path into Copilot's shim;
    // on a runner Copilot's shim for this stage is written again with it (one host's concurrent stages each their own).
    const at = agent && !local ? copilotRelayShimIn(dir) : localCopilotRelayShim(localRelayDir(usageDir));
    writeRelayShim(dirname(at), { bwrap, socat, socket: relay.socketPath, port: relay.port, extra: copilotRelayExtra(dirname(relay.socketPath)) });
    if (agent && !local) bakeCopilotRelay(copilotRunnerLayout(agent, copilotHome), bwrap, at);
    relay.copilotShim = at;
  }
  else if (sandboxed) relay.shimDir = writeRelayShim(join(dir, "bin"), { bwrap, socat, socket: relay.socketPath, port: relay.port });
  holdSecrets([relay.token]);
  setActiveRelay(relay);
  log(`gateway relay: ${RELAYED_NAME} stays in Factory's process; the worker's shell gets a relay token in its place and the relay's address in FACTORY_GATEWAY_URL, and each call counts against max_usd`);
  return out({ shell: { ...rest, [RELAYED_NAME]: relay.token }, relay, blocked: null });
}

/** Close the stage's relay, when there is one: its socket, shim and directories removed. */
export async function closeWorkerRelay(relay) {
  if (!relay) return;
  setActiveRelay(null);
  await relay.close().catch(() => {});
  rmSync(relay.dir, { recursive: true, force: true });
  if (relay.socketDir && relay.socketDir !== relay.dir) rmSync(relay.socketDir, { recursive: true, force: true });
  if (relay.copilotShim) rmSync(dirname(relay.copilotShim), { recursive: true, force: true });
}
