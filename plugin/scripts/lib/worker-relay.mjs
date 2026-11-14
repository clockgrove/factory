// The gateway relay for a stage (#97): opened when the worker secrets carry the AI Gateway key (lib/gateway-relay.mjs
// RELAYED_NAME), wherever the stage runs. The key stays in this process; the worker's shell gets the relay's token in its
// place and the relay's address in FACTORY_GATEWAY_URL (harness.mjs). Never falls back to handing the key over: where the
// relay cannot reach the harness's commands, the stage Blocks before the run.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backend } from "./backend.mjs";
import { prepareFactoryHome } from "./claude-runner.mjs";
import { CALL_LOG, GATEWAY_KEY_SHAPE, RELAYED_NAME, openRelay, setActiveRelay } from "./gateway-relay.mjs";
import { nameLabel } from "./worker-secrets.mjs";
import { holdSecrets, log } from "./inputs.mjs";
import { SAFE_PATH, agentUser, exec, processRecord, whichSync } from "./proc.mjs";
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
 * stage's name. Its name is a hash of the usage directory. Locally the loop makes it (handSocketDir) before it writes
 * local mode's outer sandbox, which names it as the one socket directory it keeps reachable (local.mjs
 * harnessOuterSettings). No sandbox writes /tmp: the outer one writes only its allowed paths, and the harnesses' own write
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

/** The env name that carries the socket's directory the loop made for a local stage (handSocketDir) to the stage. */
export const RELAY_SOCKET_DIR_ENV = "FACTORY_RELAY_SOCKET_DIR";
/** The file in a stage's usage directory naming the socket's directory the loop made for it, and the loop (handSocketDir). */
export const SOCKET_DIR_RECORD = "relay-socket.json";

/**
 * The directory the socket's directories go in (RELAY_SOCKET_ROOT), resolved: refused (throws, naming why) unless it is
 * a directory owned by root (`rootUid`; a test's stand-in its own) with the sticky bit. Every user writes it, and only the
 * sticky bit keeps another from renaming this user's directory there between Factory's checks and its `listen`, which
 * would put the socket, and the commands' calls with their token, in a directory of theirs.
 */
export function checkSocketRoot(root = RELAY_SOCKET_ROOT, { rootUid = 0 } = {}) {
  let real;
  let st;
  try {
    real = realpathSync(root);
    st = statSync(real);
  } catch (e) {
    throw new Error(`${root} could not be read (${e?.code || e?.message || e})`);
  }
  const owner = rootUid === 0 ? "root" : `uid ${rootUid}`;
  if (!st.isDirectory()) throw new Error(`${real} is not a directory`);
  if (st.uid !== rootUid) throw new Error(`${real} is not owned by ${owner}, so nothing keeps another user from swapping the socket's directory there`);
  if (!(st.mode & 0o1000)) throw new Error(`${real} has no sticky bit (mode ${(st.mode & 0o7777).toString(8)}), so another user could swap the socket's directory there for one of theirs`);
  return real;
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
    checkOwnDir(d, uid);
  }
  return dir;
}

function checkOwnDir(d, uid) {
  const st = lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a directory (a link or a file stands there)`);
  if (st.uid !== uid) throw new Error(`${d} belongs to another user`);
  if (st.mode & 0o077) throw new Error(`${d} is open to other users (mode ${(st.mode & 0o777).toString(8)})`);
  return st;
}

/**
 * The levels of a socket's directory under the resolved root `real`: [`factory-relay-<uid>`, `<12 hex>`] for
 * relaySocketDir's, [`factory-relay-<uid>-XXXXXX`] for the private fallback (stageSocketDir); null for any other path.
 */
function socketDirLevels(dir, real, uid) {
  const own = `${real}/factory-relay-${uid}`;
  if (dir.startsWith(`${own}/`) && /^[0-9a-f]{12}$/.test(dir.slice(own.length + 1))) return [own, dir];
  if (dir.startsWith(`${own}-`) && /^[A-Za-z0-9]{6}$/.test(dir.slice(own.length + 1))) return [dir];
  return null;
}

/**
 * Check a socket's directory before the relay listens in it: the root is root's and sticky (checkSocketRoot), the path is
 * one of the two this user's socket directories take there (socketDirLevels), and each level is a real directory of this
 * user's alone. Returns {dir, dev, ino}, which confirmSocketDir holds the socket's directory to after the listen.
 */
export function checkSocketDir(dir, { uid = process.getuid?.() ?? 0, root = RELAY_SOCKET_ROOT, rootUid = 0 } = {}) {
  const real = checkSocketRoot(root, { rootUid });
  const levels = socketDirLevels(String(dir || ""), real, uid);
  if (!levels) throw new Error(`${dir} is not a socket directory of this user's under ${real}`);
  let st = null;
  for (const d of levels) {
    try {
      st = checkOwnDir(d, uid);
    } catch (e) {
      if (e?.code) throw new Error(`${d} could not be read (${e.code})`);
      throw e;
    }
  }
  return { dir, dev: st.dev, ino: st.ino };
}

/**
 * After the listen: the socket is in the very directory checkSocketDir checked (`checked`), which still passes its
 * checks: the same directory (device and inode), the socket's real directory, and the socket itself this user's.
 * Throws, naming what differs.
 */
export function confirmSocketDir(socketPath, checked, opts = {}) {
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const now = checkSocketDir(checked.dir, opts);
  if (now.dev !== checked.dev || now.ino !== checked.ino) throw new Error(`${checked.dir} was replaced after it was checked`);
  let real = null;
  try {
    real = realpathSync(dirname(socketPath));
  } catch {
    // named below
  }
  if (real !== checked.dir) throw new Error(`the socket's directory is ${real ?? "gone"}, not ${checked.dir}`);
  const st = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!st?.isSocket() || st.uid !== uid) throw new Error(`no socket of this user's is at ${socketPath} after the listen (its directory was swapped while the socket was made)`);
}

/**
 * The socket's directory for a stage: relaySocketDir's, made by makeSocketDir; when that is refused (another user made
 * `factory-relay-<uid>` first, or it fails a check) and `fallback`, a private one of the stage's own made by mkdtemp in the
 * root instead (`factory-relay-<uid>-XXXXXX`, mode 700, a name no one can take first). Returns {dir, refused}: `refused`
 * the per-user directory's refusal when the fallback was taken. Throws when the root is refused (checkSocketRoot), which
 * no fallback there escapes, or the per-user directory is refused without `fallback`.
 */
export function stageSocketDir(usageDir, { uid = process.getuid?.() ?? 0, root = RELAY_SOCKET_ROOT, rootUid = 0, fallback = true } = {}) {
  const real = checkSocketRoot(root, { rootUid });
  try {
    return { dir: makeSocketDir(relaySocketDir(usageDir, { uid, root: real }), { uid }), refused: null };
  } catch (e) {
    if (!fallback) throw e;
    return { dir: mkdtempSync(join(real, `factory-relay-${uid}-`)), refused: String(e?.message || e) };
  }
}

/**
 * Local mode's loop, before a stage that relays the gateway key starts: its socket's directory (stageSocketDir), recorded
 * in the stage's usage directory (SOCKET_DIR_RECORD, with this process as its owner) so a later loop removes it when the
 * stage died (local.mjs reapSocketDirs). The loop names it in the outer sandbox and hands it to the stage (RELAY_SOCKET_DIR_ENV).
 */
export function handSocketDir(usageDir, opts = {}) {
  const made = stageSocketDir(usageDir, opts);
  try {
    writeFileSync(join(usageDir, SOCKET_DIR_RECORD), JSON.stringify({ dir: made.dir, owner: processRecord() }), { mode: 0o600 });
  } catch (e) {
    // Unrecorded, no later loop could find it: it goes now.
    rmSync(made.dir, { recursive: true, force: true });
    throw e;
  }
  return made;
}

/** The record handSocketDir left in `usageDir`, or null. */
export function readSocketDirRecord(usageDir) {
  try {
    const rec = JSON.parse(readFileSync(join(usageDir, SOCKET_DIR_RECORD), "utf8"));
    return typeof rec?.dir === "string" ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Remove a stage's socket directory and its record (handSocketDir) from `usageDir`: only one that passes checkSocketDir
 * (the root root's and sticky, a path of the two shapes this user's socket directories take there, and every level a
 * real directory of this user's alone, so no link anywhere on the way), and only the stage's own level (the per-user
 * parent stays). Returns whether a directory was removed.
 */
export function dropSocketDir(usageDir, { uid = process.getuid?.() ?? 0, root = RELAY_SOCKET_ROOT, rootUid = 0 } = {}) {
  const rec = readSocketDirRecord(usageDir);
  rmSync(join(usageDir, SOCKET_DIR_RECORD), { force: true });
  if (!rec) return false;
  try {
    checkSocketDir(rec.dir, { uid, root, rootUid });
  } catch {
    // Gone already, or no longer this user's own all the way down (a reboot cleared /tmp and someone planted a link).
    return false;
  }
  rmSync(rec.dir, { recursive: true, force: true });
  return true;
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
 * holds). `socketRoot`: where the socket's directory goes (RELAY_SOCKET_ROOT), `socketRootUid` its owner (root; a test's
 * stand-in its own).
 */
export async function openWorkerRelay({ inputs, shell, usageDir, env = process.env, open = openRelay, which = whichSync, runnerDir = RELAY_RUNNER_DIR, copilotHome = COPILOT_RUNNER_HOME, socketRoot = RELAY_SOCKET_ROOT, socketRootUid = 0 }) {
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
  // Under the usage directory the socket's path could pass its limit: it goes in a short directory of its own. Locally
  // the loop made it and named it in the outer sandbox (handSocketDir); elsewhere the stage makes it, falling back to a
  // private one when the per-user directory is refused. Checked before the listen and confirmed after it.
  let socketDir = null;
  let checked = null;
  // The directory this process made, which it removes when the relay does not start (the loop removes the one it made).
  let made = null;
  const dirOpts = { root: socketRoot, rootUid: socketRootUid };
  const dirBlocked = (e) => out({ shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} could not start: its socket's directory: ${String(e?.message || e).slice(0, 200)}` });
  if (!(agent && !local)) {
    try {
      const handed = local ? env[RELAY_SOCKET_DIR_ENV] || "" : "";
      // Only the one serve made for this stage, as its record in the usage directory (which no sandbox writes) names.
      if (handed && handed !== readSocketDirRecord(usageDir)?.dir) throw new Error(`${handed} is not the directory made for this stage`);
      if (handed) socketDir = handed;
      else {
        const m = stageSocketDir(usageDir, { ...dirOpts, fallback: !local });
        made = socketDir = m.dir;
        if (m.refused) log(`gateway relay: ${m.refused}; the socket goes in a private directory of this stage's instead`);
      }
      checked = checkSocketDir(socketDir, dirOpts);
    } catch (e) {
      if (made) rmSync(made, { recursive: true, force: true });
      return dirBlocked(e);
    }
  }
  let relay;
  try {
    relay = await open({ key, dir, socketDir, group, chgrp, tcp: !sandboxed, maxUsd: inputs.maxUsd, callLog: join(usageDir, CALL_LOG), log });
  } catch (e) {
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
    return out({ shell: rest, relay: null, blocked: `the gateway relay for ${RELAYED_NAME} could not start: ${String(e?.message || e).slice(0, 240)}` });
  }
  if (checked) {
    try {
      confirmSocketDir(relay.socketPath, checked, dirOpts);
    } catch (e) {
      // Nothing was handed out yet: the relay goes before any command could reach it.
      await relay.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      if (made) rmSync(made, { recursive: true, force: true });
      return dirBlocked(e);
    }
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
