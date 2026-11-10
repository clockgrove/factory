// The cloud-sandbox adapter contract (docs/ADAPTERS.md). Every vendor that hosts a sandbox for Factory sits behind this
// one shape, so a second vendor is one new module beside sandbox-vercel.mjs and an entry in ADAPTERS, not a refactor.
// The sandbox's id and its tags are the only vendor-side state Factory relies on; everything else lives in GitHub.
// This module is pure: it validates specs and names errors, and loads a vendor module (and its SDK) only on open.

/**
 * @typedef {"all" | "none" | { allow: string[] }} Network  Outbound reach for the whole sandbox, every user in it.
 * @typedef {{ image?: string, snapshot?: string, vcpus: number, timeoutMs: number, tags: Record<string, string>, network: Network, name?: string }} CreateSpec
 * @typedef {{ argv: string[], cwd?: string, env?: Record<string, string>, user?: string, timeoutMs?: number, onStdout?: (s: string) => void, onStderr?: (s: string) => void }} RunSpec
 * @typedef {{ exitCode: number, timedOut: boolean, durationMs: number }} RunResult
 * @typedef {{ id: string, state: "starting" | "running" | "stopping" | "stopped" | "failed", tags: Record<string, string>, createdAt: string }} Listed
 * @typedef {{ wallMs: number, activeCpuMs: number | null, vcpus: number, memoryMb: number, egressBytes: number | null, ingressBytes: number | null, storedBytes: number | null, usd: number, basis: string, rates: Rates }} Usage
 *   `storedBytes`: the sandbox's own saved state (the stop snapshot a resume boots from), as the vendor bills its storage; null when it keeps none or does not say.
 * @typedef {{ vendor: string, plan: string, region: string, date: string, source: string, activeCpuHour: number, memoryGbHour: number, memoryMinMs: number, memoryMbPerVcpu: number, creation: number, snapshotGbMonth: number }} Rates
 *   The vendor's list rates, dated, with where they were read: the one place a vendor's prices live. `memoryMinMs` is
 *   the vendor's billing increment for provisioned memory (each session is rounded up to it).
 *
 * @typedef {object} SandboxAdapter
 * @property {string} name
 * @property {Rates} rates  The list rates every cost below is computed from.
 * @property {(node: string) => string} baseImage  The vendor's image an image build starts from, for a Node.js version.
 * @property {{ networkAllowList: boolean, users: boolean, stopKeepsFiles: boolean, autoResume: boolean }} capabilities
 * @property {(spec: CreateSpec) => Promise<{ id: string, expiresAt: string | null }>} create  A running sandbox; `id` is what Factory records, `expiresAt` when the vendor ends its session.
 *   A `timeoutMs` past the plan's session cap is refused `invalid` (HTTP 400), with `limitMs` the cap when the vendor's answer states it.
 * @property {(id: string, spec: RunSpec) => Promise<RunResult>} run  Output streams to the callbacks as it arrives.
 * @property {(id: string, name: string) => Promise<{ name: string, home: string }>} addUser  An unprivileged user: no sudo, its own home.
 * @property {(id: string, files: { path: string, content: string | Uint8Array, mode?: number }[]) => Promise<void>} writeFiles  As the default user; absolute paths.
 * @property {(id: string, path: string) => Promise<Buffer | null>} readFile  Null when the file does not exist.
 * @property {(id: string) => Promise<void>} stop  Ends the VM, keeps the files (and the users) for resume.
 * @property {(id: string) => Promise<{ expiresAt: string | null }>} resume  A stopped sandbox running again with its files, and when that session ends.
 * @property {(id: string, ms: number) => Promise<{ expiresAt: string | null }>} extend  The running session ends `ms` later than it would have; the vendor's plan caps the total.
 * @property {() => Promise<{ account: string | null, plan: string | null, status: string | null }>} account  Which account the
 *   credentials act for (a name, never an id) and its plan, as the vendor reports them: the plan sets the session's ceiling.
 * @property {(id: string) => Promise<void>} destroy  The sandbox and everything it saved, gone; a missing one is not an error.
 * @property {(filter: { tag: [string, string] }) => Promise<Listed[]>} list  By one tag, for the sweep.
 * @property {(id: string) => Promise<Usage>} usage  Totals across every session so far, priced at list rates.
 * @property {(id: string) => Promise<{ snapshot: string, sizeBytes: number | null, usdPerMonth: number | null, usage: Usage }>} snapshot
 *   The sandbox's files as a create source (`create({snapshot})`), with its storage at list rates and the sandbox's
 *   usage. The sandbox stays, stopped, tagged `snapshot=<id>` (list shows it): the vendor's record of the image.
 *   Nothing runs in it again; `destroy(id)` deletes the snapshot with it.
 * @property {(id: string) => Promise<{ snapshot: string, state: "ready" | "deleted" | "failed", createdAt: string, sizeBytes: number | null }[]>} snapshots
 *   The snapshots this project's vendor lists for the sandbox `id`.
 * @property {() => Promise<{ snapshots: number, bytes: number, limitBytes: number | null }>} storage
 *   Every ready snapshot in this project (every repository whose sandboxes share it), counted and summed as the vendor
 *   bills its storage, and the plan's storage limit when the vendor's API says it (null when it does not).
 */

/** The error codes an adapter throws. Callers decide on `code`, never on the message. */
export const ERROR_CODES = Object.freeze(["invalid", "auth", "not_found", "conflict", "rate_limited", "quota", "unsupported", "unavailable", "vendor"]);

export class SandboxError extends Error {
  /**
   * @param {string} code one of ERROR_CODES @param {string} message
   * @param {{ vendor?: string, status?: number, vendorCode?: string, limitMs?: number, cause?: unknown }} [info]  `limitMs`: the
   *   most the vendor accepts for the value it refused (a create's session), when its answer states it.
   */
  constructor(code, message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    if (!ERROR_CODES.includes(code)) throw new TypeError(`unknown sandbox error code ${code}`);
    this.name = "SandboxError";
    this.code = code;
    this.vendor = info.vendor ?? null;
    this.status = info.status ?? null;
    this.vendorCode = info.vendorCode ?? null;
    this.limitMs = Number.isFinite(info.limitMs) && info.limitMs > 0 ? info.limitMs : null;
  }
}

/** Every operation an adapter must have; the conformance script checks a module against this list. */
export const OPERATIONS = Object.freeze(["create", "run", "addUser", "writeFiles", "readFile", "stop", "resume", "extend", "destroy", "list", "usage", "snapshot", "snapshots", "storage", "baseImage", "account"]);

/** The vendors, by the name a workflow input will carry. Loading one loads its SDK. */
export const ADAPTERS = Object.freeze({ vercel: () => import("./sandbox-vercel.mjs") });

/** The named vendor's adapter with its credentials from `env`; throws SandboxError (`unsupported`, `auth`, `unavailable`). */
export async function openSandbox(name, env = process.env) {
  const load = Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : null;
  if (!load) throw new SandboxError("unsupported", `no sandbox adapter named ${JSON.stringify(name)} (have: ${Object.keys(ADAPTERS).join(", ")})`);
  const adapter = await (await load()).open(env);
  const missing = OPERATIONS.filter((op) => typeof adapter[op] !== "function");
  if (missing.length) throw new SandboxError("unsupported", `adapter ${name} lacks ${missing.join(", ")}`);
  if (!checkRates(adapter.rates)) throw new SandboxError("unsupported", `adapter ${name} has no list rates`);
  return adapter;
}

// ------------------------------------------------------------------- cost
// A stage's vendor cost from two usage readings, priced at the adapter's dated list rates. Pure: the launcher, which
// holds the vendor's credentials, reads the totals; the stage in the VM never sees them.

const HOUR_MS = 3_600_000;
/** A GB-month of storage, in milliseconds: 730 hours, the average month. */
const MONTH_MS = 730 * HOUR_MS;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Whether `rates` carries every number the cost below needs. */
export const checkRates = (rates) => !!rates && ["activeCpuHour", "memoryGbHour", "memoryMinMs", "memoryMbPerVcpu", "creation", "snapshotGbMonth"].every((k) => finite(rates[k])) && typeof rates.date === "string" && typeof rates.source === "string";

/** Provisioned memory for `ms` of one session: rounded up to the vendor's billing increment. */
const memoryUsd = (rates, memoryMb, ms) => {
  const step = rates.memoryMinMs || 1;
  const billed = ms > 0 ? Math.ceil(ms / step) * step : 0;
  return (memoryMb / 1024) * (billed / HOUR_MS) * rates.memoryGbHour;
};

/** Storage of the sandbox's saved state for `ms` while it was stopped. */
export const storedUsd = (rates, { bytes, ms }) => (finite(bytes) && finite(ms) ? round6((bytes / 1e9) * rates.snapshotGbMonth * (ms / MONTH_MS)) : 0);

/**
 * The most one session can cost: every vCPU busy for all of it, its memory for all of it, one creation when `created`.
 * The vendor ends the session at its end, so the stage's own compute cannot pass this. A stage's harness budget is
 * max_usd less this (and the storage booked with the start), so model and vendor dollars together stay under max_usd.
 */
export function sessionCeilingUsd(rates, { vcpus, memoryMb = vcpus * rates.memoryMbPerVcpu, ms, created = false }) {
  if (!finite(vcpus) || !finite(ms)) return null;
  return round6(vcpus * (ms / HOUR_MS) * rates.activeCpuHour + memoryUsd(rates, memoryMb, ms) + (created ? rates.creation : 0));
}

/**
 * The harness's budget for a stage: `maxUsd` less the vendor's most for the stage (`ceilingUsd`, the session's ceiling,
 * and `storageUsd`, the stopped stretch's storage), floored to the cent. The one place max_usd is split between the
 * model and the vendor, so both together stay under it. 0 when max_usd is off (0); null when the vendor's most leaves
 * nothing for the harness, or cannot be bounded (no ceiling): the stage must not start.
 */
export function harnessBudgetUsd(maxUsd, { ceilingUsd, storageUsd = 0 }) {
  if (!(maxUsd > 0)) return 0;
  if (!finite(ceilingUsd)) return null;
  // Rounded to the micro-dollar before the floor, so a float's 19.7399999 is the 19.74 it means.
  const left = Math.floor(Math.round((maxUsd - ceilingUsd - (finite(storageUsd) ? storageUsd : 0)) * 1e6) / 1e4) / 100;
  return left > 0 ? left : null;
}

/**
 * One stage's vendor cost: the usage totals after its session (`after`, the sandbox stopped) less those before it
 * (`before`: the totals when it was resumed, or null for a sandbox created for it), plus the storage of the stretch the
 * sandbox was stopped before the stage (`stored`: {ms, bytes}). When a reading is missing or partial, or the session's
 * totals cannot have settled (`settled` false: the stop failed), the cost is `ceilingUsd` plus that storage, flagged
 * `upperBound`. Returns {usd, upperBound, activeCpuMs, wallMs, vcpus, memoryMb, computeUsd, creationUsd, storedUsd, storedMs, storedBytes}.
 */
export function stageVendorCost(rates, { before = null, after = null, created = false, stored = null, ceilingUsd = null, settled = true }) {
  const kept = { storedMs: finite(stored?.ms) ? stored.ms : 0, storedBytes: finite(stored?.bytes) ? stored.bytes : null };
  const storage = storedUsd(rates, { bytes: kept.storedBytes, ms: kept.storedMs });
  const base = created ? { wallMs: 0, activeCpuMs: 0 } : before;
  const ok = settled && after && base && finite(after.wallMs) && finite(after.activeCpuMs) && finite(base.wallMs) && finite(base.activeCpuMs) && finite(after.memoryMb);
  if (!ok) {
    const bound = finite(ceilingUsd) ? ceilingUsd : null;
    return { usd: bound === null ? null : round6(bound + storage), upperBound: bound !== null, activeCpuMs: null, wallMs: null, vcpus: after?.vcpus ?? null, memoryMb: after?.memoryMb ?? null, computeUsd: bound, creationUsd: created ? rates.creation : 0, storedUsd: storage, ...kept };
  }
  const activeCpuMs = Math.max(0, after.activeCpuMs - base.activeCpuMs);
  const wallMs = Math.max(0, after.wallMs - base.wallMs);
  const computeUsd = round6((activeCpuMs / HOUR_MS) * rates.activeCpuHour + memoryUsd(rates, after.memoryMb, wallMs));
  const creationUsd = created ? rates.creation : 0;
  return { usd: round6(computeUsd + creationUsd + storage), upperBound: false, activeCpuMs, wallMs, vcpus: after.vcpus ?? null, memoryMb: after.memoryMb, computeUsd, creationUsd, storedUsd: storage, ...kept };
}

const invalid = (msg) => new SandboxError("invalid", msg);
// Linux user names as useradd takes them portably; tag keys and values short and plain so every vendor can hold them.
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TAG = /^[A-Za-z0-9_.:-]{1,63}$/;
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const MAX_TAGS = 5;

/** The tag `snapshot` puts on the sandbox an image came from: the snapshot's id. */
export const SNAPSHOT_TAG = "snapshot";

/** A Linux user name the contract accepts (`root`, or one addUser could make). */
export function checkUser(name) {
  if (typeof name !== "string" || !USER.test(name)) throw invalid(`user name ${JSON.stringify(name)} is not a plain Linux user name`);
  return name;
}

/** The spec, checked and normalized; throws SandboxError("invalid") naming the first problem. */
export function checkCreateSpec(spec) {
  if (!spec || typeof spec !== "object") throw invalid("create needs a spec object");
  const { image, snapshot, vcpus, timeoutMs, tags = {}, network, name } = spec;
  if (image !== undefined && snapshot !== undefined) throw invalid("create takes an image or a snapshot, not both");
  for (const [k, v] of [["image", image], ["snapshot", snapshot], ["name", name]]) if (v !== undefined && (typeof v !== "string" || !v)) throw invalid(`${k} must be a non-empty string`);
  if (!Number.isInteger(vcpus) || vcpus < 1) throw invalid("vcpus must be a whole number of at least 1");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw invalid("timeoutMs must be a whole number of milliseconds, at least 1000");
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) throw invalid("tags must be an object of strings");
  const entries = Object.entries(tags);
  if (entries.length > MAX_TAGS) throw invalid(`at most ${MAX_TAGS} tags`);
  for (const [k, v] of entries) if (!TAG.test(k) || typeof v !== "string" || !TAG.test(v)) throw invalid(`tag ${JSON.stringify(k)}=${JSON.stringify(v)} is not 1-63 of [A-Za-z0-9_.:-]`);
  return { image, snapshot, vcpus, timeoutMs, tags: { ...tags }, network: checkNetwork(network), name };
}

/** "all", "none" or {allow: [host, "*.host"]}: an allow-list of host names, nothing else reachable. */
export function checkNetwork(network) {
  if (network === "all" || network === "none") return network;
  if (!network || typeof network !== "object" || !Array.isArray(network.allow)) throw invalid('network must be "all", "none" or {allow: [host, ...]}');
  for (const h of network.allow) if (typeof h !== "string" || !HOST.test(h)) throw invalid(`network host ${JSON.stringify(h)} is not a lowercase host name (a leading "*." is allowed)`);
  return { allow: [...new Set(network.allow)] };
}

/** The run spec, checked; env names plain, values strings, the user a plain name, the limit positive. */
export function checkRunSpec(spec) {
  if (!spec || typeof spec !== "object") throw invalid("run needs a spec object");
  const { argv, cwd, env = {}, user, timeoutMs, onStdout, onStderr } = spec;
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string") || !argv[0]) throw invalid("argv must be a non-empty array of strings");
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd.startsWith("/"))) throw invalid("cwd must be an absolute path");
  if (!env || typeof env !== "object" || Array.isArray(env)) throw invalid("env must be an object of strings");
  for (const [k, v] of Object.entries(env)) if (!ENV_NAME.test(k) || typeof v !== "string") throw invalid(`env ${JSON.stringify(k)} must be a plain name with a string value`);
  if (user !== undefined) checkUser(user);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) throw invalid("timeoutMs must be a positive whole number");
  for (const [k, f] of [["onStdout", onStdout], ["onStderr", onStderr]]) if (f !== undefined && typeof f !== "function") throw invalid(`${k} must be a function`);
  return { argv: [...argv], cwd, env: { ...env }, user, timeoutMs, onStdout, onStderr };
}

/** An absolute path for the file operations. */
export function checkPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) throw invalid(`path ${JSON.stringify(path)} must be absolute`);
  return path;
}
