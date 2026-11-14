// Whether this machine reaches the services a stage needs, and the one wait while it does not (#228).
// A request that never left this machine (DNS, a refused or unreachable connect, a connect that timed out) is no
// answer from GitHub or the model provider: it is this machine's network. A process that waits outages out
// (waitOutages: the stages and `factory serve`) sends no such request again until a cheap probe of the same host gets
// an answer. One probe loop per host, however many calls wait on it, and one log line when the host is lost and one
// when it answers again. Any HTTP answer, a 5xx or a 429 included, is GitHub (or the provider) answering: the client's
// own retries handle those (github.mjs RETRY), with one exception: GitHub's primary rate limit spent (#250). That answer
// says no request will pass until its reset, a known moment, so it is an outage of the API host of known length: a
// process that waits outages out sends nothing more to that host until the reset (plus a little jitter), one sleep and
// two log lines for all its callers, no probe.
import { log } from "./inputs.mjs";

/** Node fetch's connect-level failures: no byte of the request left this machine, or its connect timed out. */
export const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** The first system or undici code on an error or its causes (fetch wraps them as TypeError("fetch failed")). */
export const causeCode = (e) => {
  for (let c = e, i = 0; c && i < 4; c = c.cause, i += 1) if (typeof c.code === "string" && /^[A-Z0-9_]+$/.test(c.code)) return c.code;
  return "";
};

/**
 * The code on an error GitHub's primary rate limit refused (github.mjs: a 403 or 429, or a GraphQL RATE_LIMITED, with
 * x-ratelimit-remaining 0 and a reset; no secondary limit's sign), with `resetAt` (ms), in every process; and on the
 * NetworkDown a waiting process throws when the reset is past its limit or the caller's deadline.
 */
export const RATE_LIMIT_SPENT = "RATE_LIMIT_SPENT";

/** Whether an error is this machine failing to reach a host: a connect-level code on it or its causes, or a NetworkDown. */
export const unreachable = (e) => !!e && (e.offline === true || UNREACHABLE.has(causeCode(e)));

/**
 * The bounds. `stageWaitMs`: how long a local stage waits in place for the network before it ends `paused` for its serve
 * to resume (fifteen minutes: a DNS flap or a router restart passes, and a longer outage costs the stage no more of its
 * wall clock than the claim's own freshness, local.mjs CLAIM_FRESH_MS). `blockMs`: how long an Objective may stay paused
 * on one outage before serve Blocks it with the External cause `outage` (twelve hours: a night's outage, from late evening
 * to the next morning, fits with room; under the dispatcher's day for a claim gone quiet, local.mjs CLAIM_PAUSE_MS, so an
 * outage of twelve to twenty-four hours Blocks naming the outage, while one that keeps the machine off GitHub for over a
 * day meets the dispatcher's Block first). `probeMs`: the pause before each probe, the last
 * repeated. `passWindowMs`: how close to a failed harness pass's end an outage must have been to have cut it off (the
 * harnesses retry their own calls for minutes before a pass fails); one before the pass began never counts, and one on
 * another host than the pass's provider counts only when it lasted `passOutageMs`. `passReruns`: how many times one pass
 * runs again after an outage before its failure stands. `flapMs`: a host lost again this soon after answering is the same
 * outage (its first loss and its limit carried over). `quotaJitterMs`: the most a wait for a rate limit's reset runs past
 * it (a tenth of it at least), so the callers of several processes on one quota do not all go again at once.
 * `exitWaitMs`: how long a stage off the local route that ended on a rate limit waits for its reset to write its Block
 * (inside the fifteen minutes the job keeps after its deadline, session.mjs deadline). `now`, `sleep` and `random` are
 * replaced in tests.
 */
export const OUTAGE = {
  stageWaitMs: 15 * 60_000,
  blockMs: 12 * 60 * 60_000,
  probeMs: [5_000, 10_000, 20_000, 30_000, 60_000],
  probeTimeoutMs: 10_000,
  passWindowMs: 10 * 60_000,
  passOutageMs: 2 * 60_000,
  passReruns: 2,
  flapMs: 60_000,
  quotaJitterMs: 10_000,
  exitWaitMs: 10 * 60_000,
  now: () => Date.now(),
  random: Math.random,
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
 * a caller that tells transient failures apart still does, plus `offline`, `origin`, `code` and `since` (ms). With
 * `resetAt` (ms) it is GitHub's primary rate limit spent until then (code RATE_LIMIT_SPENT): nothing was done.
 */
export class NetworkDown extends Error {
  constructor({ origin, code, since, resetAt = null }) {
    const spent = Number.isFinite(resetAt);
    super(spent ? `GitHub's API rate limit on ${hostOf(origin)} is spent until ${iso(resetAt)} (met at ${iso(since)})` : `${hostOf(origin)} unreachable from this machine since ${iso(since)} (${code || "no answer"})`);
    this.name = "NetworkDown";
    Object.assign(this, { offline: true, transport: true, unsent: true, status: 0, origin, code: spent ? RATE_LIMIT_SPENT : code || "", since, ...(spent ? { resetAt } : {}) });
  }
}

// null: the process does not wait outages out (the client's own retry bound applies). Else {until(since) -> ms}.
let MODE = null;
let STOPPED = false;
const EPISODES = new Map();
const PAST = [];
// The outage each host was in when this process stopped waiting for it (given up, or stopWaiting): what a later request
// to it, or the stage's end, names (downFor, outageOf), so the host and the first loss are never lost to a caller that
// swallowed the wait's own NetworkDown.
const GIVEN_UP = new Map();
// The last outage each host came back from, for a host lost again soon after (OUTAGE.flapMs): the same outage.
const RECENT = new Map();
// The reset (ms) of each host's spent primary rate limit as this process last met it, whether it waits or not (spentUntil).
const SPENT = new Map();
// Bumped by resetNetwork: an episode from before it records nothing after it.
let GEN = 0;

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
  GEN += 1;
  EPISODES.clear();
  PAST.length = 0;
  GIVEN_UP.clear();
  RECENT.clear();
  SPENT.clear();
}

/**
 * The NetworkDown for `origin` once this process stopped waiting for it: its outage's host, code and first loss. Null when
 * this process never gave up on that host.
 */
export const downFor = (origin) => {
  const g = origin && GIVEN_UP.get(origin);
  return g ? new NetworkDown(g) : null;
};

/** Record that `origin` answered with its primary rate limit spent until `resetAt` (ms); any process (spentUntil). */
export function noteSpent(origin, resetAt) {
  if (origin && Number.isFinite(resetAt) && resetAt > (SPENT.get(origin) ?? 0)) SPENT.set(origin, resetAt);
}

/** The reset (ms) of `origin`'s primary rate limit when this process met it spent and the reset is still ahead, else null. */
export const spentUntil = (origin) => {
  const at = origin ? SPENT.get(origin) : undefined;
  return at !== undefined && at > OUTAGE.now() ? at : null;
};

/**
 * Once this process has stopped waiting: the NetworkDown for `origin`'s spent rate limit while its reset is still ahead
 * (a request to it is not sent: it would be refused), else null.
 */
export const spentOn = (origin) => {
  const g = origin && GIVEN_UP.get(origin);
  return g && Number.isFinite(g.resetAt) && g.resetAt > OUTAGE.now() ? new NetworkDown(g) : null;
};

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

/**
 * The outage on `origin` under way, or a new one: its probe loop runs until the host answers or the limit passes. With
 * `resetAt` (ms), a spent rate limit: one sleep to the reset instead (spentEpisode).
 */
function episode(origin, code, resetAt = null) {
  const known = EPISODES.get(origin);
  if (known) return known;
  if (Number.isFinite(resetAt)) return spentEpisode(origin, resetAt);
  // A host lost again within OUTAGE.flapMs of answering (a network that comes and goes): the same outage, its first loss
  // and its limit carried over, and no new log line, so a flapping network neither floods the log nor waits afresh. One
  // that then stays down past OUTAGE.flapMs is a loss of its own in the log: one line when it has, one when it answers.
  const last = RECENT.get(origin);
  const flap = !!last && !Number.isFinite(last.resetAt) && OUTAGE.now() - last.back < OUTAGE.flapMs;
  const since = flap ? last.since : OUTAGE.now();
  const end = flap ? last.end : MODE.until(since);
  const stop = new AbortController();
  const gen = GEN;
  const ep = { origin, code: flap ? last.code : code, since, end, stop, back: null };
  EPISODES.set(origin, ep);
  const host = hostOf(origin);
  if (!flap) log(`network: ${host} is unreachable from this machine (${code || "no answer"}); waiting for it to answer again${Number.isFinite(end) ? `, for up to ${minutesText(end - since)}` : ""}`);
  const lostAt = OUTAGE.now();
  let quiet = flap;
  ep.done = (async () => {
    for (let i = 0; ; i += 1) {
      const left = ep.end - OUTAGE.now();
      if (left <= 0 || stop.signal.aborted) break;
      await OUTAGE.sleep(Math.min(OUTAGE.probeMs[Math.min(i, OUTAGE.probeMs.length - 1)], left), stop.signal);
      if (stop.signal.aborted) break;
      if ((await probe(origin)) === null) {
        ep.back = OUTAGE.now();
        if (!quiet) log(`network: ${host} answers again after ${minutesText(ep.back - lostAt)} (unreachable since ${iso(lostAt)}${flap ? `; on and off since ${iso(since)}` : ""})`);
        if (gen === GEN) RECENT.set(origin, { since, end, code: ep.code, back: ep.back });
        return true;
      }
      if (quiet && OUTAGE.now() - lostAt >= OUTAGE.flapMs) {
        quiet = false;
        log(`network: ${host} is unreachable from this machine again (${ep.code || "no answer"}) since ${iso(lostAt)}; on and off since ${iso(since)}; waiting for it to answer again${Number.isFinite(end) ? `, until ${iso(end)}` : ""}`);
      }
    }
    if (!stop.signal.aborted) {
      log(`network: ${host} still unreachable after ${minutesText(OUTAGE.now() - since)} (since ${iso(since)}); no longer waiting`);
      // Past the process's limit it waits no more for anything: a caller that swallowed this wait's NetworkDown and
      // goes on gets its next unreachable request's error at once, not a fresh wait of its own.
      stopWaiting();
    }
    if (gen === GEN) GIVEN_UP.set(origin, { origin, code: ep.code, since });
    return false;
  })().finally(() => {
    if (gen !== GEN) return;
    EPISODES.delete(origin);
    PAST.push({ origin, code: ep.code, since, back: ep.back ?? OUTAGE.now() });
    if (PAST.length > 20) PAST.shift();
  });
  return ep;
}

/**
 * A spent primary rate limit on `origin`, reset at `resetAt` (ms): the wait is known, so it is one sleep to the reset plus
 * OUTAGE's jitter, no probe. A reset past the process's limit is not waited for at all: the process stops waiting (as at
 * an outage's limit), so the stage ends on it now. One log line when met (or given up), one when the reset has passed.
 * A host refused again within OUTAGE.flapMs of a reset (GitHub's clock a little behind) is the same wait, not logged again.
 */
function spentEpisode(origin, resetAt) {
  const now = OUTAGE.now();
  const last = RECENT.get(origin);
  const again = !!last && Number.isFinite(last.resetAt) && now - last.back < OUTAGE.flapMs;
  const since = again ? last.since : now;
  const end = Math.max(resetAt, now) + Math.round(OUTAGE.quotaJitterMs * (0.1 + 0.9 * OUTAGE.random()));
  const limit = MODE.until(since);
  const stop = new AbortController();
  const gen = GEN;
  const ep = { origin, code: RATE_LIMIT_SPENT, since, end, resetAt, stop, back: null };
  EPISODES.set(origin, ep);
  const host = hostOf(origin);
  ep.done = (async () => {
    if (end > limit) {
      log(`network: GitHub's API rate limit on ${host} is spent until ${iso(resetAt)}, past this process's wait (until ${iso(limit)}); no longer waiting`);
      if (gen === GEN) GIVEN_UP.set(origin, { origin, code: RATE_LIMIT_SPENT, since, resetAt });
      stopWaiting();
      return false;
    }
    if (!again) log(`network: GitHub's API rate limit on ${host} is spent until ${iso(resetAt)}; no request goes to it until then (${minutesText(end - now)})`);
    await OUTAGE.sleep(end - OUTAGE.now(), stop.signal);
    if (stop.signal.aborted) {
      if (gen === GEN) GIVEN_UP.set(origin, { origin, code: RATE_LIMIT_SPENT, since, resetAt });
      return false;
    }
    ep.back = OUTAGE.now();
    if (!again) log(`network: GitHub's API rate limit on ${host} has reset; requests go again after ${minutesText(ep.back - since)}`);
    if (gen === GEN) RECENT.set(origin, { since, end, code: RATE_LIMIT_SPENT, back: ep.back, resetAt });
    return true;
  })().finally(() => {
    if (gen !== GEN) return;
    EPISODES.delete(origin);
    PAST.push({ origin, code: RATE_LIMIT_SPENT, since, back: ep.back ?? OUTAGE.now(), resetAt });
    if (PAST.length > 20) PAST.shift();
  });
  return ep;
}

/**
 * Wait for `origin` to answer again after a request to it failed with `code` (unreachable): resolves once a probe gets
 * an answer; throws NetworkDown when the process's limit or `deadlineAt` comes first, or the process stops waiting.
 * With `resetAt` (ms), GitHub's primary rate limit is spent until then: resolves once the reset has passed; a reset
 * past `deadlineAt` throws at once, since that wait cannot end in time.
 */
export async function networkBack(origin, code, { deadlineAt = Infinity, resetAt = null } = {}) {
  if (!waitingOutages()) {
    const since = OUTAGE.now();
    // Stopped waiting: the rate limit is recorded as the one this process gave up on, for the stage's end (outageOf).
    if (Number.isFinite(resetAt) && MODE !== null) GIVEN_UP.set(origin, { origin, code: RATE_LIMIT_SPENT, since, resetAt });
    throw new NetworkDown({ origin, code, since, resetAt });
  }
  const ep = episode(origin, code, resetAt);
  let back;
  if (Number.isFinite(deadlineAt) && deadlineAt < ep.end) {
    if (Number.isFinite(ep.resetAt)) back = false;
    else {
      const cut = new AbortController();
      back = await Promise.race([ep.done, OUTAGE.sleep(deadlineAt - OUTAGE.now(), cut.signal).then(() => false)]);
      cut.abort();
    }
  } else back = await ep.done;
  if (!back) throw new NetworkDown({ origin, code: ep.code, since: ep.since, resetAt: ep.resetAt });
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
  const [provider] = origins;
  // Only an outage that could have cut the pass off: on its provider's host, or one on any host that lasted at least
  // OUTAGE.passOutageMs (a heartbeat's GitHub blip of a few seconds is no reason for a pass to fail).
  // A spent rate limit is GitHub refusing, not the network: it cuts no pass off.
  const counts = (o) => !Number.isFinite(o.resetAt) && (o.origin === provider || (o.back ?? OUTAGE.now()) - o.since >= OUTAGE.passOutageMs);
  const now = [...EPISODES.values()].find(counts);
  if (now) return { origin: now.origin, code: now.code, since: now.since, ongoing: true };
  const past = PAST.findLast((p) => p.back >= from && p.since <= endedMs && counts(p));
  if (past) return { origin: past.origin, code: past.code, since: past.since, ongoing: false };
  const down = await unreachableNow(origins);
  return down ? { ...down, since: OUTAGE.now(), ongoing: true } : null;
}

/**
 * The outage a NetworkDown (or a bare connect-level error) names, for an exit: {origin, host, code, since} (ms), plus
 * `resetAt` (ms) for GitHub's spent rate limit.
 */
export function outageOf(e, now = OUTAGE.now()) {
  // An error that names no outage (a bare connect failure): the one this process last gave up on, if any.
  const known = e?.origin && Number.isFinite(e?.since) ? e : (e?.origin && GIVEN_UP.get(e.origin)) || [...GIVEN_UP.values()].at(-1) || e;
  const origin = known?.origin ?? null;
  return { origin, host: origin ? hostOf(origin) : "the network", code: known?.code || causeCode(e) || "no answer", since: Number.isFinite(known?.since) ? known.since : now, ...(Number.isFinite(known?.resetAt) ? { resetAt: known.resetAt } : {}) };
}

/** A paused or Blocked stage's reason for an outage (outageOf's fields, `since` and `resetAt` in ms). */
export const outageReason = ({ host, code, since, resetAt }, now = OUTAGE.now()) =>
  Number.isFinite(resetAt) ? `GitHub's API rate limit on ${host} is spent until ${iso(resetAt)} (met at ${iso(since)})` : `this machine could not reach ${host} (${code}) from ${iso(since)}, ${minutesText(Math.max(0, now - since))} so far`;
