// The gateway relay for a stage (#97): opened when the worker secrets carry the AI Gateway key (lib/gateway-relay.mjs
// RELAYED_NAME), wherever the stage runs. The key stays in this process; the worker's shell gets the relay's token in its
// place and the relay's address in FACTORY_GATEWAY_URL (harness.mjs). Never falls back to handing the key over: where the
// relay cannot reach the harness's commands, the stage Blocks before the run.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backend } from "./backend.mjs";
import { prepareFactoryHome } from "./claude-runner.mjs";
import { GATEWAY_KEY_SHAPE, RELAYED_NAME, openRelay, setActiveRelay } from "./gateway-relay.mjs";
import { nameLabel } from "./worker-secrets.mjs";
import { holdSecrets, log } from "./inputs.mjs";
import { SAFE_PATH, agentUser, exec, whichSync } from "./proc.mjs";
import { writeRelayShim } from "./relay-shim.mjs";

/** The relay's directory on a runner and in a cloud sandbox: Factory's user owns it, the agent may only pass through. */
export const RELAY_RUNNER_DIR = "/var/lib/factory-relay";

/** Local mode's relay directory: in the stage's usage directory, which no sandbox may write. */
export const localRelayDir = (usageDir) => join(usageDir, "relay");

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
 * holds).
 */
export async function openWorkerRelay({ inputs, shell, usageDir, env = process.env, open = openRelay, which = whichSync, runnerDir = RELAY_RUNNER_DIR }) {
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
  if (inputs.harness === "copilot") return out({ shell: rest, relay: null, blocked: `${RELAYED_NAME} is opted in to the worker's shell, and Factory relays that key instead of handing it over (docs/PLAN.md, Worker secrets), but its relay does not reach Copilot's sandbox yet; run this Objective on Claude Code or Codex, or leave ${RELAYED_NAME} out of worker_secrets` });
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
  let relay;
  try {
    relay = await open({ key, dir, group, chgrp, tcp: !sandboxed, maxUsd: inputs.maxUsd, log });
  } catch (e) {
    return out({ shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} could not start: ${String(e?.message || e).slice(0, 200)}` });
  }
  if (sandboxed) relay.shimDir = writeRelayShim(join(dir, "bin"), { bwrap, socat, socket: relay.socketPath, port: relay.port });
  holdSecrets([relay.token]);
  setActiveRelay(relay);
  log(`gateway relay: ${RELAYED_NAME} stays in Factory's process; the worker's shell gets a relay token in its place and the relay's address in FACTORY_GATEWAY_URL, and each call counts against max_usd`);
  return out({ shell: { ...rest, [RELAYED_NAME]: relay.token }, relay, blocked: null });
}

/** Close the stage's relay, when there is one: its socket, shim and directory removed. */
export async function closeWorkerRelay(relay) {
  if (!relay) return;
  setActiveRelay(null);
  await relay.close().catch(() => {});
  rmSync(relay.dir, { recursive: true, force: true });
}
