// Whether this machine reaches the services a stage needs, and the one wait while it does not (#228).
// A request that never left this machine (DNS, a refused or unreachable connect, a connect that timed out) is no
// answer from GitHub or the model provider: it is this machine's network. A process that waits outages out
// (waitOutages: the stages and `factory serve`) sends no such request again until a cheap probe of the same host gets
// an answer. One probe loop per host, however many calls wait on it, and one log line when the host is lost and one
// when it answers again. Any HTTP answer, a 5xx or a 429 included, is GitHub (or the provider) answering: the client's
// own retries handle those (github.mjs RETRY).
import { log } from "./inputs.mjs";

/** Node fetch's connect-level failures: no byte of the request left this machine, or its connect timed out. */
export const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** The first system or undici code on an error or its causes (fetch wraps them as TypeError("fetch failed")). */
export const causeCode = (e) => {
  for (let c = e, i = 0; c && i < 4; c = c.cause, i += 1) if (typeof c.code === "string" && /^[A-Z0-9_]+$/.test(c.code)) return c.code;
  return "";
};

/** Whether an error is this machine failing to reach a host: a connect-level code on it or its causes, or a NetworkDown. */
export const unreachable = (e) => !!e && (e.offline === true || UNREACHABLE.has(causeCode(e)));

/**
 * The bounds. `stageWaitMs`: how long a local stage waits in place for the network before it ends `paused` for its serve
 * to resume (fifteen minutes: a DNS flap or a router restart passes, and a longer outage costs the stage no more of its
 * wall clock than the claim's own freshness, local.mjs CLAIM_FRESH_MS). `blockMs`: how long an Objective may stay paused
 * on one outage before serve Blocks it with the External cause `outage` (twelve hours: a night's outage, from late evening
 * to the next morning, fits with room; it ends before the dispatcher's day for a claim gone quiet, local.mjs
 * CLAIM_PAUSE_MS, so the Block names the outage rather than the loop). `probeMs`: the pause before each probe, the last
 * repeated. `passWindowMs`: how close to a failed harness pass's end an outage must have been to have cut it off (the
 * harnesses retry their own calls for minutes before a pass fails); one before the pass began never counts. `now` and `sleep` are replaced in tests.
 */
export const OUTAGE = {
  stageWaitMs: 15 * 60_000,
  blockMs: 12 * 60 * 60_000,
  probeMs: [5_000, 10_000, 20_000, 30_000, 60_000],
  probeTimeoutMs: 10_000,
  passWindowMs: 10 * 60_000,
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
    }),
};

const hostOf = (origin) => {
  try {
    return new URL(origin).host;
  } catch {
    return String(origin);
  }
};
const iso = (ms) => new Date(ms).toISOString();
export const minutesText = (ms) => (ms >= 2 * 60 * 60_000 ? `${Math.round(ms / (60 * 60_000))} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

/** GitHub's REST origin, as github.mjs calls it. */
export const githubOrigin = (env = process.env) => {
  try {
    return new URL(env.GITHUB_API_URL || "https://api.github.com").origin;
  } catch {
    return "https://api.github.com";
  }
};

/** An origin to probe for a URL, or null (a path, a local remote). */
export const originOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
};

/**
 * A wait that ended without the host answering: the process's limit (waitOutages `until`) or the caller's deadline came
 * first, or the process stopped waiting. Shaped as the transport error it stands for (status 0, `transport`, `unsent`), so
 * a caller that tells transient failures apart still does, plus `offline`, `origin`, `code` and `since` (ms).
 */
export class NetworkDown extends Error {
  constructor({ origin, code, since }) {
    super(`${hostOf(origin)} unreachable from this machine since ${iso(since)} (${code || "no answer"})`);
    this.name = "NetworkDown";
    Object.assign(this, { offline: true, transport: true, unsent: true, status: 0, origin, code: code || "", since });
  }
}

// null: the process does not wait outages out (the client's own retry bound applies). Else {until(since) -> ms}.
let MODE = null;
let STOPPED = false;
const EPISODES = new Map();
const PAST = [];

/**
 * Wait outages out in this process: a request that cannot leave this machine waits for its host to answer again, up to
 * `until(since)` (ms; Infinity for serve). Called by the stages and serve; every other command keeps the client's bound.
 */
export function waitOutages({ until = () => Infinity } = {}) {
  MODE = { until };
  STOPPED = false;
}

/** Whether this process waits outages out now: on, and not stopped (stopWaiting). */
export const waitingOutages = () => MODE !== null && !STOPPED;

/** Whether this process waited outages out and has stopped (stopWaiting): a request that cannot leave fails at once. */
export const stoppedWaiting = () => MODE !== null && STOPPED;

/** Stop waiting: every wait ends with NetworkDown, and a request that cannot leave this machine fails at once from now on. */
export function stopWaiting() {
  STOPPED = true;
  for (const ep of EPISODES.values()) ep.stop.abort();
}

/** Tests: back to a process that does not wait. */
export function resetNetwork() {
  stopWaiting();
  MODE = null;
  STOPPED = false;
  EPISODES.clear();
  PAST.length = 0;
}

/** One probe: null when `origin` gives any HTTP answer, else why not (a connect-level code, or "no answer"). */
export async function probe(origin) {
  try {
    const r = await fetch(origin, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(OUTAGE.probeTimeoutMs) });
    await r.body?.cancel?.().catch(() => {});
    return null;
  } catch (e) {
    return causeCode(e) || "no answer";
  }
}

/** The first of `origins` that does not answer a probe now, as {origin, code}, or null. */
export async function unreachableNow(origins) {
  const list = [...new Set(origins.filter(Boolean))];
  const codes = await Promise.all(list.map((o) => probe(o)));
  const i = codes.findIndex((c) => c !== null);
  return i < 0 ? null : { origin: list[i], code: codes[i] };
}

/** The outage on `origin` under way, or a new one: its probe loop runs until the host answers or the limit passes. */
function episode(origin, code) {
  const known = EPISODES.get(origin);
  if (known) return known;
  const since = OUTAGE.now();
  const end = MODE.until(since);
  const stop = new AbortController();
  const ep = { origin, code, since, end, stop, back: null };
  EPISODES.set(origin, ep);
  const host = hostOf(origin);
  log(`network: ${host} is unreachable from this machine (${code || "no answer"}); waiting for it to answer again${Number.isFinite(end) ? `, for up to ${minutesText(end - since)}` : ""}`);
  ep.done = (async () => {
    for (let i = 0; ; i += 1) {
      const left = ep.end - OUTAGE.now();
      if (left <= 0 || stop.signal.aborted) break;
      await OUTAGE.sleep(Math.min(OUTAGE.probeMs[Math.min(i, OUTAGE.probeMs.length - 1)], left), stop.signal);
      if (stop.signal.aborted) break;
      if ((await probe(origin)) === null) {
        ep.back = OUTAGE.now();
        log(`network: ${host} answers again after ${minutesText(ep.back - since)} (unreachable since ${iso(since)})`);
        return true;
      }
    }
    if (!stop.signal.aborted) {
      log(`network: ${host} still unreachable after ${minutesText(OUTAGE.now() - since)} (since ${iso(since)}); no longer waiting`);
      // Past the process's limit it waits no more for anything: a caller that swallowed this wait's NetworkDown and
      // goes on gets its next unreachable request's error at once, not a fresh wait of its own.
      stopWaiting();
    }
    return false;
  })().finally(() => {
    EPISODES.delete(origin);
    PAST.push({ origin, code, since, back: ep.back ?? OUTAGE.now() });
    if (PAST.length > 20) PAST.shift();
  });
  return ep;
}

/**
 * Wait for `origin` to answer again after a request to it failed with `code` (unreachable): resolves once a probe gets
 * an answer; throws NetworkDown when the process's limit or `deadlineAt` comes first, or the process stops waiting.
 */
export async function networkBack(origin, code, { deadlineAt = Infinity } = {}) {
  if (!waitingOutages()) throw new NetworkDown({ origin, code, since: OUTAGE.now() });
  const ep = episode(origin, code);
  let back;
  if (Number.isFinite(deadlineAt) && deadlineAt < ep.end) {
    const cut = new AbortController();
    back = await Promise.race([ep.done, OUTAGE.sleep(deadlineAt - OUTAGE.now(), cut.signal).then(() => false)]);
    cut.abort();
  } else back = await ep.done;
  if (!back) throw new NetworkDown({ origin, code: ep.code, since: ep.since });
}

/** The outage under way on `origin`, if any: a request to it waits (networkBack) instead of being sent. */
export const outageOn = (origin) => (origin && EPISODES.get(origin)) || null;

/**
 * Whether a harness pass that failed, run from `startedMs` to `endedMs`, was cut off by this machine's network: an outage
 * under way now, or one on any host during the pass's last OUTAGE.passWindowMs, else one of `origins` (the provider's,
 * GitHub's) that does not answer a probe now. An outage that ended before the pass began never counts, so a pass run
 * again after one is judged on its own. Returns {origin, code, since, ongoing} or null.
 */
export async function passCutOff(startedMs, endedMs, origins) {
  const from = Math.max(startedMs, endedMs - OUTAGE.passWindowMs);
  const now = [...EPISODES.values()][0];
  if (now) return { origin: now.origin, code: now.code, since: now.since, ongoing: true };
  const past = PAST.findLast((p) => p.back >= from && p.since <= endedMs);
  if (past) return { origin: past.origin, code: past.code, since: past.since, ongoing: false };
  const down = await unreachableNow(origins);
  return down ? { ...down, since: OUTAGE.now(), ongoing: true } : null;
}

/** The outage a NetworkDown (or a bare connect-level error) names, for an exit: {origin, host, code, since} (ms). */
export function outageOf(e, now = OUTAGE.now()) {
  const origin = e?.origin ?? null;
  return { origin, host: origin ? hostOf(origin) : "the network", code: e?.code || causeCode(e) || "no answer", since: Number.isFinite(e?.since) ? e.since : now };
}

/** A paused or Blocked stage's reason for an outage (outageOf's fields, `since` in ms). */
export const outageReason = ({ host, code, since }, now = OUTAGE.now()) => `this machine could not reach ${host} (${code}) from ${iso(since)}, ${minutesText(Math.max(0, now - since))} so far`;
