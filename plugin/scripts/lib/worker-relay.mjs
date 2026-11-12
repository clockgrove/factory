// The gateway relay for a stage (#97): opened when the worker secrets carry the AI Gateway key (lib/gateway-relay.mjs
// RELAYED_NAME), wherever the stage runs. The key stays in this process; the worker's shell gets the relay's token in its
// place and the relay's address in FACTORY_GATEWAY_URL (harness.mjs). Never falls back to handing the key over: where the
// relay cannot reach the harness's commands, the stage Blocks before the run.
import { join } from "node:path";
import { backend } from "./backend.mjs";
import { prepareFactoryHome } from "./claude-runner.mjs";
import { RELAYED_NAME, openRelay, setActiveRelay } from "./gateway-relay.mjs";
import { holdSecrets, log } from "./inputs.mjs";
import { SAFE_PATH, agentUser, exec, whichSync } from "./proc.mjs";
import { writeRelayShim } from "./relay-shim.mjs";

/** The relay's directory on a runner and in a cloud sandbox: Factory's user owns it, the agent may only pass through. */
export const RELAY_RUNNER_DIR = "/var/lib/factory-relay";

/** Local mode's relay directory: in the stage's usage directory, which no sandbox may write. */
export const localRelayDir = (usageDir) => join(usageDir, "relay");

/**
 * Open the stage's relay when `shell` (the worker's shell secrets, worker-secrets.mjs) carries RELAYED_NAME. Returns
 * {shell, relay, blocked}: `shell` with the token in the key's place; `blocked` a reason when the key cannot be relayed to
 * this harness here (the key is then out of `shell`, and the caller Blocks before any run).
 */
export async function openWorkerRelay({ inputs, shell, usageDir, env = process.env, open = openRelay, which = whichSync }) {
  if (!shell?.[RELAYED_NAME]) return { shell, relay: null, blocked: null };
  const key = shell[RELAYED_NAME];
  const rest = { ...shell };
  delete rest[RELAYED_NAME];
  if (inputs.harness === "copilot") return { shell: rest, relay: null, blocked: `${RELAYED_NAME} is opted in to the worker's shell, and Factory relays that key instead of handing it over (docs/PLAN.md, Worker secrets), but its relay does not reach Copilot's sandbox yet; run this Objective on Claude Code or Codex, or leave ${RELAYED_NAME} out of worker_secrets` };
  const local = backend(env).name === "local";
  const agent = agentUser();
  // No sandbox (a developer's own session): the commands share this machine's loopback, so the relay listens there.
  const sandboxed = local || !!agent;
  const bwrap = sandboxed ? which("bwrap", { PATH: SAFE_PATH }) || (local ? which("bwrap", env) : null) : null;
  const socat = sandboxed ? which("socat", { PATH: SAFE_PATH }) || (local ? which("socat", env) : null) : null;
  if (sandboxed && (!bwrap || !socat)) return { shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} needs ${[!bwrap && "bwrap", !socat && "socat"].filter(Boolean).join(" and ")} on this machine (it starts a forwarder in each command's sandbox); install it (sudo apt-get install -y bubblewrap socat), then re-apply factory:objective` };
  let dir;
  let group = null;
  let chgrp = null;
  if (agent && !local) {
    dir = RELAY_RUNNER_DIR;
    await prepareFactoryHome(dir, "The gateway relay");
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
    return { shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} could not start: ${String(e?.message || e).slice(0, 200)}` };
  }
  if (sandboxed) relay.shimDir = writeRelayShim(join(dir, "bin"), { bwrap, socat, socket: relay.socketPath, port: relay.port });
  holdSecrets([relay.token]);
  setActiveRelay(relay);
  log(`gateway relay: ${RELAYED_NAME} stays in Factory's process; the worker's shell gets a relay token in its place and the relay's address in FACTORY_GATEWAY_URL, and each call counts against max_usd`);
  return { shell: { ...rest, [RELAYED_NAME]: relay.token }, relay, blocked: null };
}

/** Close the stage's relay (its socket removed), when there is one. */
export async function closeWorkerRelay(relay) {
  if (!relay) return;
  setActiveRelay(null);
  await relay.close().catch(() => {});
}
