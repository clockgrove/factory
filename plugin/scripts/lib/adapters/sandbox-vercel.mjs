// Vercel Sandbox behind the cloud-sandbox contract (sandbox.mjs, docs/ADAPTERS.md), on the @vercel/sandbox SDK pinned
// in plugin/package.json. A sandbox id is the Vercel sandbox's name (unique in the project). The SDK is loaded on
// open only, so Factory's other scripts run without an install. Credentials: VERCEL_TOKEN, VERCEL_TEAM_ID and
// VERCEL_PROJECT_ID, passed to every call; nothing is read from a CLI login on the machine.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { MAX_TAGS, SNAPSHOT_TAG, SandboxError, checkCreateSpec, checkPath, checkRunSpec, checkUser } from "./sandbox.mjs";

const VENDOR = "vercel";

/**
 * List rates, Pro plan, region iad1 (the SDK's default region, which create keeps), read on the date below: the one
 * place Vercel's prices live (sandbox.mjs prices every stage from them). Active CPU counts CPU time across vCPUs;
 * memory is provisioned for wall time, billed in one-minute increments, 2 GB per vCPU. Snapshot storage, per GB-month,
 * prices an image (snapshot below) and the stop snapshot a persistent sandbox keeps while it is stopped (Vercel bills
 * each automatic snapshot as Snapshot Storage). Data transfer is not priced: included on Pro, and downloads are free.
 */
export const VERCEL_RATES = Object.freeze({
  vendor: VENDOR,
  date: "2026-11-08",
  source: "https://vercel.com/docs/sandbox/pricing",
  plan: "Pro",
  region: "iad1",
  activeCpuHour: 0.128,
  memoryGbHour: 0.0212,
  memoryMinMs: 60_000,
  memoryMbPerVcpu: 2048,
  creation: 0.6 / 1e6,
  snapshotGbMonth: 0.08,
});

/** Node.js majors Vercel has a managed image for; any other version starts from the universal image (Node.js 24). */
const NODE_IMAGES = new Set(["22", "24", "26"]);

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/**
 * The session cap a refused create states, in milliseconds: Vercel answers a `timeout` past the plan's with HTTP 400,
 * `bad_request` and "`timeout` should be <= 45m" (or "<= 1d"), and says it nowhere else. Only the retry's size is read
 * from the message; whether to retry is decided on the status and the code. Null when the answer names no cap.
 */
export function statedLimitMs(status, vendorCode, message) {
  if (status !== 400 || vendorCode !== "bad_request" || typeof message !== "string") return null;
  const m = /`?timeout`?\s+should be\s*<=\s*(\d+(?:\.\d+)?)\s*([smhd])\b/.exec(message);
  const ms = m ? Math.round(Number(m[1]) * UNIT_MS[m[2]]) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A vendor failure as a SandboxError, decided on the HTTP status and Vercel's `error.code`, never the message. */
export function vendorError(err) {
  if (err instanceof SandboxError) return err;
  const status = err?.response?.status ?? null;
  const vendorCode = err?.json?.error?.code ?? (err?.name === "StreamError" ? err.code : null) ?? null;
  const limitMs = statedLimitMs(status, vendorCode, err?.json?.error?.message ?? err?.message);
  const info = { vendor: VENDOR, status, vendorCode, ...(limitMs ? { limitMs } : {}), cause: err };
  const msg = `vercel: ${err?.message || err?.name || String(err)}`;
  if (err?.name === "SandboxUserAlreadyExistsError") return new SandboxError("conflict", msg, info);
  if (status === null) {
    if (err?.name === "StreamError") return new SandboxError("vendor", msg, info);
    // fetch's own failures (DNS, reset, TLS: a system or undici code on the error or its cause) and aborted requests.
    const sys = err?.code ?? err?.cause?.code;
    if (err?.name === "AbortError" || err?.name === "TimeoutError" || (typeof sys === "string" && /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(sys))) return new SandboxError("unavailable", msg, info);
    return new SandboxError("vendor", msg, info);
  }
  if (status === 401 || status === 403) return new SandboxError("auth", msg, info);
  if (status === 402) return new SandboxError("quota", msg, info);
  if (status === 404 || status === 410) return new SandboxError("not_found", msg, info);
  if (status === 409 || (status === 422 && /^sandbox_(stopping|snapshotting)$/.test(vendorCode ?? ""))) return new SandboxError("conflict", msg, info);
  if (status === 429) return new SandboxError("rate_limited", msg, info);
  if (status === 400 || status === 422) return new SandboxError("invalid", msg, info);
  if (status >= 500) return new SandboxError("unavailable", msg, info);
  return new SandboxError("vendor", msg, info);
}

const call = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    throw vendorError(e);
  }
};

/**
 * The shell that starts a command as another user, with nothing of the caller's environment but the names kept.
 * The image's sudo keeps the caller's environment (`!env_reset`), so the kept variables' values travel in the
 * environment of the sudo call; the command line carries only names, which every user in the VM can read.
 */
const AS_USER =
  'keep=" $1 "; shift; for v in $(compgen -e); do case "$keep" in *" $v "*) ;; *) unset "$v" 2>/dev/null ;; esac; done; for f in $(compgen -A function); do unset -f "$f"; done; ' +
  'export HOME="$1" USER="$2" LOGNAME="$2"; shift 2; cd -- "$1" || exit 1; shift; exec "$@"';
/** Variables a command as another user keeps beside the ones the run passes. */
const KEPT = ["PATH", "LANG", "TERM"];

/** `argv` as `user` in `cwd` (the user's home when absent): the sudo command line, which holds no env value. */
export function userCommand({ user, home, cwd, env = {}, argv }) {
  const keep = [...new Set([...KEPT, ...Object.keys(env)])].join(" ");
  return { cmd: "sudo", args: ["-n", "-u", user, "--", "/bin/bash", "-c", AS_USER, "factory-as-user", keep, home, user, cwd ?? home, ...argv] };
}

const STOP_SETTLE_MS = 120_000;
/** The SDK handle's session status, or null when it has no session (a sandbox read while stopped). */
const sessionStatus = (sandbox) => {
  try {
    return sandbox.status;
  } catch {
    return null;
  }
};
/** When the sandbox's running session ends, as the vendor reports it (an ISO time), or null when it reports none. */
const expiry = (sandbox) => {
  try {
    const at = sandbox.expiresAt;
    return at instanceof Date && Number.isFinite(at.getTime()) ? at.toISOString() : null;
  } catch {
    return null;
  }
};
const homeOf = (user) => (user === "root" ? "/root" : `/home/${user}`);
const STATES = { pending: "starting", running: "running", stopping: "stopping", snapshotting: "stopping", stopped: "stopped", failed: "failed", aborted: "failed" };

/** The adapter, with credentials from env; throws SandboxError("auth") naming any missing variable, never a value. */
export async function open(env = process.env) {
  const missing = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"].filter((k) => !env[k]);
  if (missing.length) throw new SandboxError("auth", `vercel: ${missing.join(", ")} not set`, { vendor: VENDOR });
  const creds = { token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID };
  let Sandbox;
  let Snapshot;
  try {
    ({ Sandbox, Snapshot } = await import("@vercel/sandbox"));
  } catch (e) {
    throw new SandboxError("unavailable", "vercel: the @vercel/sandbox package is not installed (run `npm ci --ignore-scripts` in plugin/)", { vendor: VENDOR, cause: e });
  }

  // One SDK handle per sandbox in this process; it resumes a stopped sandbox on the next call that needs the VM.
  const boxes = new Map();
  const box = async (id) => {
    if (typeof id !== "string" || !id) throw new SandboxError("invalid", "a sandbox id is a non-empty string");
    if (!boxes.has(id)) boxes.set(id, await call(() => Sandbox.get({ ...creds, name: id })));
    return boxes.get(id);
  };

  return {
    name: VENDOR,
    rates: VERCEL_RATES,
    capabilities: { networkAllowList: true, users: true, stopKeepsFiles: true, autoResume: true },
    /** The vendor's base image for an image build: Ubuntu with the adopter's Node.js major when Vercel has one. */
    baseImage: (node) => `vercel/sandbox/${NODE_IMAGES.has(String(node ?? "").split(".")[0]) ? `node:${String(node).split(".")[0]}` : "universal"}`,

    async create(spec) {
      const s = checkCreateSpec(spec);
      if (s.vcpus !== 1 && (s.vcpus % 2 !== 0 || s.vcpus > 32)) throw new SandboxError("invalid", "vercel: vcpus must be 1 or an even number up to 32 (the plan may cap it lower)", { vendor: VENDOR });
      const name = s.name ?? `factory-${randomBytes(6).toString("hex")}`;
      const networkPolicy = s.network === "all" ? "allow-all" : s.network === "none" ? "deny-all" : { allow: s.network.allow };
      const sandbox = await call(() =>
        Sandbox.create({
          ...creds,
          name,
          ...(s.snapshot ? { source: { type: "snapshot", snapshotId: s.snapshot } } : s.image ? { image: s.image } : {}),
          resources: { vcpus: s.vcpus },
          timeout: s.timeoutMs,
          tags: s.tags,
          networkPolicy,
          persistent: true,
          // Only the latest stop's snapshot is kept, so snapshot storage stays at one copy per sandbox.
          keepLastSnapshots: { count: 1, deleteEvicted: true },
        }),
      );
      boxes.set(sandbox.name, sandbox);
      return { id: sandbox.name, expiresAt: expiry(sandbox) };
    },

    async run(id, spec) {
      const r = checkRunSpec(spec);
      const sandbox = await box(id);
      const [cmd, ...args] = r.argv;
      const base = { detached: true, env: r.env, timeoutMs: r.timeoutMs };
      const params =
        r.user === undefined
          ? { ...base, cmd, args, cwd: r.cwd }
          : r.user === "root"
            ? { ...base, cmd, args, cwd: r.cwd, sudo: true }
            : { ...base, ...userCommand({ user: r.user, home: homeOf(r.user), cwd: r.cwd, env: r.env, argv: r.argv }) };
      const started = Date.now();
      const command = await call(() => sandbox.runCommand(params));
      await call(async () => {
        for await (const line of command.logs()) {
          if (line.stream === "stdout") r.onStdout?.(line.data);
          else if (line.stream === "stderr") r.onStderr?.(line.data);
        }
      });
      const done = await call(() => command.wait());
      const durationMs = Date.now() - started;
      const exitCode = done.exitCode ?? -1;
      // The VM kills a command at its limit (SIGKILL); a non-zero exit at or past the limit is that kill.
      return { exitCode, timedOut: r.timeoutMs !== undefined && exitCode !== 0 && durationMs >= r.timeoutMs, durationMs };
    },

    async addUser(id, name) {
      checkUser(name);
      if (name === "root") throw new SandboxError("invalid", "root exists already");
      const sandbox = await box(id);
      // useradd -m with no extra groups (so no sudo); the home is 770, group-owned by the default user's group.
      const u = await call(() => sandbox.createUser(name));
      return { name: u.username, home: u.homeDir };
    },

    async writeFiles(id, files) {
      if (!Array.isArray(files) || !files.length) throw new SandboxError("invalid", "writeFiles needs at least one file");
      const list = files.map((f) => ({ path: checkPath(f?.path), content: typeof f.content === "string" ? Buffer.from(f.content) : f.content, ...(f.mode === undefined ? {} : { mode: f.mode }) }));
      const sandbox = await box(id);
      await call(() => sandbox.writeFiles(list));
    },

    async readFile(id, path) {
      checkPath(path);
      const sandbox = await box(id);
      return call(() => sandbox.readFileToBuffer({ path }));
    },

    async stop(id) {
      const sandbox = await box(id);
      const before = sessionStatus(sandbox);
      if (before === "running" || before === "pending") await call(() => sandbox.stop());
      // The snapshot is taken while the session reads stopping or snapshotting; stop returns once the files are saved.
      boxes.set(id, await settled(id));
    },

    async resume(id) {
      const sandbox = await call(() => Sandbox.get({ ...creds, name: id, resume: true }));
      boxes.set(id, sandbox);
      return { expiresAt: expiry(sandbox) };
    },

    async extend(id, ms) {
      if (!Number.isInteger(ms) || ms < 1000) throw new SandboxError("invalid", "extend takes whole milliseconds, at least 1000", { vendor: VENDOR });
      const sandbox = await box(id);
      await call(() => sandbox.extendTimeout(ms));
      return { expiresAt: expiry(sandbox) };
    },

    async account() {
      // The team the credentials act for, by its slug and plan only: never its id, the token or anything else it holds.
      const r = await call(async () => {
        const res = await fetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(creds.teamId)}`, { headers: { authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw Object.assign(new Error(`GET /v2/teams: HTTP ${res.status}`), { response: { status: res.status } });
        return res.json();
      });
      const word = (v) => (typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : null);
      return { account: word(r?.slug), plan: word(r?.billing?.plan), status: word(r?.billing?.status) };
    },

    async destroy(id) {
      let sandbox;
      try {
        sandbox = await box(id);
      } catch (e) {
        if (e.code === "not_found") return;
        throw e;
      }
      try {
        await call(() => sandbox.delete({ deleteOrphanSnapshots: true }));
      } catch (e) {
        if (e.code !== "not_found") throw e;
      }
      boxes.delete(id);
    },

    async list({ tag } = {}) {
      if (!Array.isArray(tag) || tag.length !== 2 || tag.some((t) => typeof t !== "string" || !t)) throw new SandboxError("invalid", "list needs tag: [key, value]");
      const all = await call(async () => (await Sandbox.list({ ...creds, tags: { [tag[0]]: tag[1] } })).toArray());
      return all.map((s) => ({ id: s.name, state: STATES[s.status] ?? "failed", tags: s.tags ?? {}, createdAt: new Date(s.createdAt).toISOString() }));
    },

    async snapshot(id) {
      const sandbox = await box(id);
      const tags = { ...(sandbox.tags ?? {}) };
      if (!Object.hasOwn(tags, SNAPSHOT_TAG) && Object.keys(tags).length >= MAX_TAGS) throw new SandboxError("invalid", `vercel: ${id} has ${MAX_TAGS} tags; snapshot needs room for its own`, { vendor: VENDOR });
      // Vercel stops the session to take it. It expires 30 days after its last use (Vercel's default), so an image no
      // stage starts from goes by itself; destroying the sandbox it came from deletes it sooner.
      const snap = await call(() => sandbox.snapshot());
      const fresh = await settled(id);
      // The vendor's own record of the image, in this project: the sandbox it came from stays, stopped, tagged with it.
      // Nothing may run in it again: a command would resume it, and its next stop could evict the image.
      await call(() => fresh.update({ tags: { ...tags, [SNAPSHOT_TAG]: snap.snapshotId } }));
      boxes.delete(id);
      const final = await usage(id);
      const sizeBytes = Number.isFinite(snap.sizeBytes) ? snap.sizeBytes : null;
      return { snapshot: snap.snapshotId, sizeBytes, usdPerMonth: sizeBytes === null ? null : Math.round((sizeBytes / 1e9) * VERCEL_RATES.snapshotGbMonth * 1e4) / 1e4, usage: final };
    },

    async snapshots(id) {
      if (typeof id !== "string" || !id) throw new SandboxError("invalid", "a sandbox id is a non-empty string");
      // Listed by the sandbox's name within this project (the SDK sends the project), never team-wide.
      const all = await call(async () => (await Snapshot.list({ ...creds, name: id })).toArray());
      return all.map((s) => ({ snapshot: s.id, state: s.status === "created" ? "ready" : s.status === "deleted" ? "deleted" : "failed", createdAt: new Date(s.createdAt).toISOString(), sizeBytes: Number.isFinite(s.sizeBytes) ? s.sizeBytes : null }));
    },

    async storage() {
      // The project's snapshots, never team-wide (the SDK sends the project). Vercel's API states no storage limit: its
      // 402 answer is the only sign of one, so limitBytes is null.
      const all = await call(async () => (await Snapshot.list({ ...creds })).toArray());
      const ready = all.filter((s) => s.status === "created");
      return { snapshots: ready.length, bytes: ready.reduce((n, s) => n + (Number.isFinite(s.sizeBytes) ? s.sizeBytes : 0), 0), limitBytes: null };
    },

    usage,
  };

  async function usage(id) {
    // A fresh read, not the cached handle: the totals move with every session.
    const s = await call(() => Sandbox.get({ ...creds, name: id }));
    const wallMs = s.totalDurationMs ?? 0;
    const activeCpuMs = s.totalActiveCpuDurationMs ?? null;
    const R = VERCEL_RATES;
    const memoryMb = s.memory ?? R.memoryMbPerVcpu * (s.vcpus ?? 1);
    // The stop snapshot a resume boots from, which Vercel bills as Snapshot Storage while the sandbox is stopped.
    let storedBytes = null;
    const current = s.currentSnapshotId;
    if (typeof current === "string" && current) {
      const snap = await call(() => Snapshot.get({ ...creds, snapshotId: current })).catch(() => null);
      storedBytes = Number.isFinite(snap?.sizeBytes) ? snap.sizeBytes : null;
    }
    const usd = ((activeCpuMs ?? 0) / 3.6e6) * R.activeCpuHour + (memoryMb / 1024) * (wallMs / 3.6e6) * R.memoryGbHour + R.creation;
    const partial = activeCpuMs === null || s.totalDurationMs === undefined ? "partial (Vercel reported no CPU or duration total yet); " : "";
    return {
      wallMs,
      activeCpuMs,
      vcpus: s.vcpus ?? null,
      memoryMb,
      egressBytes: s.totalEgressBytes ?? null,
      ingressBytes: s.totalIngressBytes ?? null,
      storedBytes,
      usd: Math.round(usd * 1e6) / 1e6,
      basis: `${partial}computed from Vercel ${R.plan} list rates (${R.region}) read ${R.date} from ${R.source}: active CPU and provisioned memory and one creation; the stop snapshot's storage is priced per stopped stretch (sandbox.mjs stageVendorCost), data transfer not priced`,
      rates: R,
    };
  }

  /** Wait while the sandbox's session reads stopping or snapshotting: its files are saved and its totals settled after. */
  async function settled(id) {
    for (const deadline = Date.now() + STOP_SETTLE_MS; ; await sleep(1000)) {
      const fresh = await call(() => Sandbox.get({ ...creds, name: id }));
      const now = sessionStatus(fresh);
      if (now !== "stopping" && now !== "snapshotting") return fresh;
      if (Date.now() > deadline) throw new SandboxError("unavailable", `vercel: ${id} still ${now} ${STOP_SETTLE_MS / 1000} s after stop`, { vendor: VENDOR });
    }
  }
}
