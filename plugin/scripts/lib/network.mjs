// Whether this machine reaches the services a stage needs, and the one wait while it does not (#228).
// A request that never left this machine (DNS, a refused or unreachable connect, a connect that timed out) is no
// answer from GitHub or the model provider: it is this machine's network. A process that waits outages out
// (waitOutages: the stages and `factory serve`) sends no such request again until a cheap probe of the same host gets
// an answer. One probe loop per host, however many calls wait on it, and one log line when the host is lost and one
// when it answers again. Any HTTP answer, a 5xx or a 429 included, is GitHub (or the provider) answering: the client's
// own retries handle those (github.mjs RETRY), until a 5xx outlasts them: then GitHub is down for the caller, an outage
// of its host (github.mjs outlasted) named by the status (#353). One exception: GitHub's primary rate limit spent (#250). That answer
// says no request will pass until its reset, a known moment, so it is an outage of known length of that one quota (the
// host, the quota GitHub counts the request against, the token: quotaKey): a process that waits outages out sends nothing
// more against that quota until the reset (plus a little jitter), one sleep and two log lines for all its callers, no
// probe. Its other quotas, and other tokens, go on.
import { createHash } from "node:crypto";
import { log } from "./inputs.mjs";
import { BARE_BUSY_TYPES } from "./usage.mjs";

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

/**
 * The quota GitHub counts a request to `url` against: GraphQL, the search APIs (code search apart), else REST's core.
 * Decided on the path before the request is sent, so every caller of one quota waits on the same key.
 */
export const quotaResource = (url) => {
  const path = new URL(url).pathname;
  if (/\/graphql$/.test(path)) return "graphql";
  if (/\/search\/code$/.test(path)) return "code_search";
  if (/\/search\//.test(path)) return "search";
  return "core";
};

/**
 * One GitHub quota: the host, its quota (quotaResource) and the token (a hash of it; none for an anonymous call), since
 * GitHub counts each token's quotas apart (the local token, the notice App's, the agent's read token).
 */
export const quotaKey = (url, token = null) => `${new URL(url).origin} ${quotaResource(url)} ${token ? createHash("sha256").update(String(token)).digest("hex").slice(0, 12) : "anonymous"}`;
const quotaName = (key) => String(key).split(" ")[1] || "core";

/**
 * When GitHub's primary rate limit resets (ms, on this machine's clock), for an answer refused because that limit is
 * spent; else null. The signs: x-ratelimit-remaining 0 with an x-ratelimit-reset, no Retry-After, and no secondary limit
 * (its message, or the older abuse-detection one). A 403 must also carry the primary limit's own message ("API rate limit
 * exceeded"): a 403 on the last quota point for another reason (no access, SAML) is no rate limit. Reading GitHub's
 * documented message is the one place words decide here; the headers alone cannot tell those 403s apart. The reset is
 * moved onto this machine's clock by the answer's Date header, so a clock ahead of GitHub's neither sends again into the
 * limit nor resumes before it.
 */
export function spentResetOf(status, headers, message, now = OUTAGE.now()) {
  const msg = String(message || "");
  if (headers?.get?.("x-ratelimit-remaining") !== "0" || headers.has("retry-after") || /secondary rate limit|abuse/i.test(msg)) return null;
  if (status === 403 && !/rate limit (already )?exceeded/i.test(msg)) return null;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) return null;
  const date = Date.parse(headers.get("date") || "");
  return Number.isFinite(date) ? now + Math.max(0, reset * 1000 - date) : reset * 1000;
}

/**
 * Whether an error is a host out of this machine's reach: a connect-level code on it or its causes, a NetworkDown, or
 * GitHub's 5xx past the client's retries (`offline`, its code the status: serverDown).
 */
export const unreachable = (e) => !!e && (e.offline === true || UNREACHABLE.has(causeCode(e)));

/**
 * Whether an outage's code is a host that answered, and failed or was busy, past the retries ("HTTP 500"): GitHub's 5xx
 * past the client's, or a model provider's busy answer (408, 425, 429 or 5xx, or the gateway's bare 5xx type with no
 * status, usage.mjs BARE_BUSY_TYPES: providerBusy) past runHarness's
 * waits. Not a lost network. The code alone does not say whose: the outage's origin does (GitHub's is githubOrigin(); a
 * provider pause carries the provider's, harness.mjs providerOrigin), so anything that judges GitHub guards on it.
 */
export const serverDown = (code) => /^HTTP (5\d\d|408|425|429)$/.test(String(code)) || BARE_BUSY_TYPES.has(String(code));

/**
 * The wait before going again after the `pauses`th busy or failed answer from a host (serverDown): 1, 2, 4… minutes, up
 * to OUTAGE.serverResumeMaxMs. serve's resume of such a pause, and runHarness's wait for a busy provider in place.
 */
export const serverWait = (pauses) => Math.min(OUTAGE.serverResumeMaxMs, OUTAGE.serverResumeMs * 2 ** Math.max(0, pauses - 1));

/**
 * How an outage of `host` with `code` reads in a reason: GitHub's 5xx (on `endpoint`, the request that met it, when
 * known), or this machine not reaching the host.
 */
export const lostText = (host, code, endpoint = null) => (serverDown(code) ? `${host} answered ${code} to every try${endpoint ? ` of ${endpoint}` : ""}` : `this machine could not reach ${host} (${code})`);

/**
 * The bounds. `stageWaitMs`: how long a local stage waits in place for the network before it ends `paused` for its serve
 * to resume (fifteen minutes: a DNS flap or a router restart passes, and a longer outage costs the stage no more of its
 * wall clock than the claim's own freshness, local.mjs CLAIM_FRESH_MS). `blockMs`: how long an Objective may stay paused
 * on one outage before serve Blocks it with the External cause `outage` (twelve hours: a night's outage, from late evening
 * to the next morning, fits with room; under the dispatcher's day for a claim gone quiet, local.mjs CLAIM_PAUSE_MS, so an
 * outage of twelve to twenty-four hours Blocks naming the outage, while one that keeps the machine off GitHub for over a
 * day meets the dispatcher's Block first). `probeMs`: the pause before each probe, the last
 * repeated. `passReruns`: how many times one pass cut off by its provider or the network (passCutOff) runs again
 * before its failure stands. `flapMs`: a host lost again this soon after answering is the same
 * outage (its first loss and its limit carried over). `quotaJitterMs`: the most a wait for a rate limit's reset runs past
 * it (a tenth of it at least), so the callers of several processes on one quota do not all go again at once; a limit
 * still refused after its stated reset waits `probeMs` (doubling) instead. `exitWaitMs`: how long past its deadline a
 * stage off the local route that ended on a rate limit may wait for the reset to write its Block (the job keeps fifteen
 * minutes after its deadline, session.mjs deadline, which also pay for the steps before Factory runs and the upload
 * after). `serverResumeMs`, `serverResumeMaxMs`: serve resumes an Objective paused on a host that answered, and failed
 * or was busy, past the retries (serverDown: GitHub's 5xx, a model provider's busy answer) after 1, 2, 4… minutes,
 * doubling up to half an hour (serverWait), since a probe of the host answers while one endpoint fails; it waits on up
 * to `blockMs`, and for GitHub's own 5xx GitHub's status page decides whether the request gets one more try and then
 * Blocks (adapters/github-status.mjs, local.mjs resume). runHarness waits a busy provider out in place on the same
 * doubling. `now`, `sleep` and `random` are replaced in tests.
 */
export const OUTAGE = {
  stageWaitMs: 15 * 60_000,
  blockMs: 12 * 60 * 60_000,
  probeMs: [5_000, 10_000, 20_000, 30_000, 60_000],
  probeTimeoutMs: 10_000,
  passReruns: 2,
  flapMs: 60_000,
  quotaJitterMs: 10_000,
  exitWaitMs: 12 * 60_000,
  serverResumeMs: 60_000,
  serverResumeMaxMs: 30 * 60_000,
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
/** "GitHub's core API rate limit on api.github.com": a quota as the log and the stage's reason name it. */
const limitName = (origin, key) => `GitHub's ${quotaName(key)} API rate limit on ${hostOf(origin)}`;
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
  constructor({ origin, code, since, resetAt = null, key = null }) {
    const spent = Number.isFinite(resetAt);
    super(spent ? `${limitName(origin, key)} is spent until ${iso(resetAt)} (met at ${iso(since)})` : serverDown(code) ? `${hostOf(origin)} answered ${code} to every try since ${iso(since)}` : `${hostOf(origin)} unreachable from this machine since ${iso(since)} (${code || "no answer"})`);
    this.name = "NetworkDown";
    Object.assign(this, { offline: true, transport: true, unsent: true, status: 0, origin, code: spent ? RATE_LIMIT_SPENT : code || "", since, ...(spent ? { resetAt, key } : {}) });
  }
}

// null: the process does not wait outages out (the client's own retry bound applies). Else {until(since) -> ms}.
let MODE = null;
let STOPPED = false;
const EPISODES = new Map();
// The outages this process met that have ended, newest last ({origin, code, since, back, kind}, ms; the last 20): a host
// lost to this machine's network (`network`), or a model provider's busy answer (`busy`, noteBusy). What passCutOff
// reads for an outage met while a pass ran.
const PAST = [];
// The outage each host was in when this process stopped waiting for it (given up, or stopWaiting): what a later request
// to it, or the stage's end, names (downFor, outageOf), so the host and the first loss are never lost to a caller that
// swallowed the wait's own NetworkDown.
const GIVEN_UP = new Map();
// The last outage each host came back from, for a host lost again soon after (OUTAGE.flapMs): the same outage.
const RECENT = new Map();
// The reset (ms) of each quota's spent primary rate limit (quotaKey) as this process last met it, whether it waits or not
// (spentUntil); gone once that quota answers.
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

/**
 * The latest moment (ms) this process waits in place for something that began at `since` (waitOutages's `until`), or
 * null when it does not wait. A harness's usage limit with a known reset is waited for within it (harness.mjs runHarness).
 */
export const waitBound = (since = OUTAGE.now()) => (waitingOutages() ? MODE.until(since) : null);

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

/**
 * A host this process gave up waiting for (past its limit, or stopped waiting while it was lost) that still fails a probe
 * now, as the NetworkDown its requests fail with: its host, code and first loss. Null when there is none, or each such host
 * answers again. A spent rate limit is no such host: it cuts no harness pass off. While one is down, a pass that failed
 * with no structured error or with a provider or network failure, and a run left with no exit record, are that outage's
 * (harness.mjs outageCut, session.mjs exitRecord).
 */
export async function givenUp() {
  const hosts = [...GIVEN_UP.values()].filter((g) => !Number.isFinite(g.resetAt)).sort((a, b) => b.since - a.since);
  for (const g of hosts) if ((await probe(g.origin)) !== null) return new NetworkDown(g);
  return null;
}

/**
 * The outage a failed call met, as its error: a host this machine could not reach (unreachable: a NetworkDown, or a bare
 * connect-level failure), or GitHub's core REST quota spent, the one every write of Factory's goes against. Else null: a
 * spent GraphQL or search quota is no outage of the stage's writes, and any answer from the host is no outage at all.
 */
export const outageMet = (e) => (unreachable(e) && (e.code !== RATE_LIMIT_SPENT || quotaName(e.key) === "core") ? e : null);

/** Record that quota `key` (quotaKey) answered spent until `resetAt` (ms), its latest answer; any process (spentUntil). */
export function noteSpent(key, resetAt) {
  if (key && Number.isFinite(resetAt)) SPENT.set(key, resetAt);
}

/** Quota `key` answered a request: no longer spent. */
export function clearSpent(key) {
  SPENT.delete(key);
}

/** The reset (ms) of quota `key` when this process last met it spent and the reset is still ahead, else null. */
export const spentUntil = (key) => {
  const at = key ? SPENT.get(key) : undefined;
  return at !== undefined && at > OUTAGE.now() ? at : null;
};

/**
 * The NetworkDown for quota `key` once this process gave up waiting for its reset (past its limit, or stopped waiting),
 * while that reset is still ahead: a request against it is not sent, since it would be refused. Else null.
 */
export const spentOn = (key) => {
  const g = key && GIVEN_UP.get(key);
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
 * `resetAt` (ms), quota `key`'s spent rate limit: one sleep to the reset instead (spentEpisode).
 */
function episode(origin, code, resetAt = null, key = origin) {
  const known = EPISODES.get(key);
  if (known) return known;
  if (Number.isFinite(resetAt)) return spentEpisode(origin, resetAt, key);
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
    PAST.push({ origin, code: ep.code, since, back: ep.back ?? OUTAGE.now(), kind: "network" });
    if (PAST.length > 20) PAST.shift();
  });
  return ep;
}

/**
 * Quota `key`'s spent primary rate limit on `origin`, reset at `resetAt` (ms): the wait is known, so it is one sleep to
 * the reset plus OUTAGE's jitter, no probe. A reset past the process's limit is not waited for at all: the quota is
 * given up (spentOn), so its callers fail at once and the stage ends on the first that cannot go on without it; its
 * other quotas go on. One log line when met (or given up), one when the reset has passed. A refusal that comes after the
 * stated reset has passed here (GitHub not refreshed yet) waits OUTAGE.probeMs, doubling, not the jitter again; one within
 * OUTAGE.flapMs of a reset whose new reset is that near is the same wait, not logged again. A quota spent again until a
 * later reset is a new wait with its own two lines.
 */
function spentEpisode(origin, resetAt, key) {
  const now = OUTAGE.now();
  const last = RECENT.get(key);
  const again = !!last && Number.isFinite(last.resetAt) && now - last.back < OUTAGE.flapMs && resetAt - now <= OUTAGE.flapMs;
  const since = again ? last.since : now;
  const stale = resetAt <= now;
  const backoffMs = stale ? Math.min(OUTAGE.probeMs.at(-1), again && last.backoffMs ? last.backoffMs * 2 : OUTAGE.probeMs[0]) : 0;
  const end = (stale ? now + backoffMs : resetAt) + Math.round(OUTAGE.quotaJitterMs * (0.1 + 0.9 * OUTAGE.random()));
  const limit = MODE.until(since);
  const stop = new AbortController();
  const gen = GEN;
  const ep = { origin, key, code: RATE_LIMIT_SPENT, since, end, resetAt, stop, back: null };
  EPISODES.set(key, ep);
  const name = limitName(origin, key);
  const givenUp = () => {
    if (gen === GEN) GIVEN_UP.set(key, { origin, key, code: RATE_LIMIT_SPENT, since, resetAt });
  };
  ep.done = (async () => {
    if (end > limit) {
      log(`network: ${name} is spent until ${iso(resetAt)}, past this process's wait (until ${iso(limit)}); no longer waiting for it`);
      givenUp();
      return false;
    }
    if (!again) log(`network: ${name} is spent until ${iso(resetAt)}; no request goes against it until then (${minutesText(end - now)})`);
    await OUTAGE.sleep(end - OUTAGE.now(), stop.signal);
    if (stop.signal.aborted) {
      givenUp();
      return false;
    }
    ep.back = OUTAGE.now();
    if (!again) log(`network: ${name} has reset; requests go again after ${minutesText(ep.back - since)}`);
    if (gen === GEN) RECENT.set(key, { since, end, code: RATE_LIMIT_SPENT, back: ep.back, resetAt, backoffMs });
    return true;
  })().finally(() => {
    if (gen === GEN) EPISODES.delete(key);
  });
  return ep;
}

/**
 * Wait for `origin` to answer again after a request to it failed with `code` (unreachable): resolves once a probe gets
 * an answer; throws NetworkDown when the process's limit or `deadlineAt` comes first, or the process stops waiting.
 * With `resetAt` (ms), quota `key`'s primary rate limit is spent until then: resolves once the reset has passed; a
 * reset past `deadlineAt` throws at once, since that wait cannot end in time.
 */
export async function networkBack(origin, code, { deadlineAt = Infinity, resetAt = null, key = origin } = {}) {
  if (!waitingOutages()) {
    const since = OUTAGE.now();
    // Stopped waiting: the rate limit is recorded as the one this process gave up on, for the stage's end (outageOf).
    if (Number.isFinite(resetAt) && MODE !== null) GIVEN_UP.set(key, { origin, key, code: RATE_LIMIT_SPENT, since, resetAt });
    throw new NetworkDown({ origin, code, since, resetAt, ...(Number.isFinite(resetAt) ? { key } : {}) });
  }
  const ep = episode(origin, code, resetAt, key);
  let back;
  if (Number.isFinite(deadlineAt) && deadlineAt < ep.end) {
    if (Number.isFinite(ep.resetAt)) back = false;
    else {
      const cut = new AbortController();
      back = await Promise.race([ep.done, OUTAGE.sleep(deadlineAt - OUTAGE.now(), cut.signal).then(() => false)]);
      cut.abort();
    }
  } else back = await ep.done;
  if (!back) throw new NetworkDown({ origin, code: ep.code, since: ep.since, resetAt: ep.resetAt, key: ep.key ?? null });
}

/** The outage under way on `origin` (or on quota `key`), if any: a request to it waits (networkBack) instead of being sent. */
export const outageOn = (origin) => (origin && EPISODES.get(origin)) || null;

/**
 * Record that a model provider (`origin`) answered a pass busy (`code`, `HTTP 429`) at `at` (ms): an outage of that host
 * as passCutOff reads one met while another pass ran (harness.mjs runBusy).
 */
export function noteBusy(origin, code, at = OUTAGE.now()) {
  if (!origin) return;
  PAST.push({ origin, code, since: at, back: at, kind: "busy" });
  if (PAST.length > 20) PAST.shift();
}

/**
 * Whether a failed harness pass, run from `startedMs` to `endedMs`, was cut off by its provider or this machine's
 * network, `origin` being the provider's API: {origin, code, since, ongoing}, else null. `failure` is the provider or
 * network failure its harness reported as its own structured error (a record's `providerOutage`, usage.mjs outageError),
 * or null for a pass whose harness reported none (a harness that prints a 5xx or a lost connection as prose only, a
 * crash, a structured error with no status that names no outage). Such a pass is decided on exact facts instead: an
 * outage this process met between the pass's start and its end (one under way, or one that ended since the pass began),
 * of any kind on the provider's own host (lost, or a busy answer: noteBusy), or on any host a connect-level loss (this
 * machine's network down); a GitHub 5xx or any other host's answer is none. Else the provider's API not answering a
 * probe now. Ongoing when the outage is under way or the provider does not answer: the pass waits for it (networkBack)
 * before it runs again. With the provider answering, a reported failure runs the pass again at once, its code the
 * failure's status, else its code or type.
 */
export async function passCutOff(failure, origin, { startedMs = null, endedMs = null } = {}) {
  const own = origin ? [...EPISODES.values()].find((o) => o.origin === origin) : null;
  if (own) return { origin, code: own.code, since: own.since, ongoing: true };
  if (!failure) {
    const end = Number.isFinite(endedMs) ? endedMs : OUTAGE.now();
    // A host lost to this machine's network (every episode but a spent rate limit's), on any host.
    const live = [...EPISODES.values()].find((o) => !Number.isFinite(o.resetAt) && o.since <= end);
    if (live) return { origin: live.origin, code: live.code, since: live.since, ongoing: true };
    const counts = (p) => p.origin === origin || p.kind === "network";
    const past = Number.isFinite(startedMs) ? PAST.findLast((p) => p.back >= startedMs && p.since <= end && counts(p)) : null;
    if (past) return { origin: past.origin, code: past.code, since: past.since, ongoing: false };
  }
  const code = origin ? await probe(origin) : null;
  if (code !== null) return { origin, code, since: OUTAGE.now(), ongoing: true };
  if (!failure) return null;
  return { origin, code: failure.status !== null ? `HTTP ${failure.status}` : failure.code || failure.type || "no answer", since: OUTAGE.now(), ongoing: false };
}

/**
 * The outage of this machine's network this process met between `startedMs` and `endedMs` (ms), on any host: one under
 * way, or one that ended since `startedMs` and is not in `seen` (pastKey: one the caller already answered). A spent
 * rate limit and a host's 5xx are none. {origin, code, since, ongoing} or null.
 */
export function lostDuring(startedMs, endedMs = OUTAGE.now(), seen = new Set()) {
  const lost = (o) => !Number.isFinite(o.resetAt) && !serverDown(o.code);
  const live = [...EPISODES.values()].find((o) => lost(o) && o.since <= endedMs);
  if (live) return { origin: live.origin, code: live.code, since: live.since, ongoing: true };
  const past = PAST.findLast((p) => p.kind === "network" && lost(p) && p.back >= startedMs && p.since <= endedMs && !seen.has(pastKey(p)));
  return past ? { origin: past.origin, code: past.code, since: past.since, ongoing: false } : null;
}

/** One ended outage, as lostDuring's `seen` holds it. */
export const pastKey = ({ origin, since }) => `${origin} ${since}`;

/** Every ended outage of this machine's network this process keeps, as pastKey names them. */
export const pastKeys = () => PAST.filter((p) => p.kind === "network").map(pastKey);

const LOOPBACK = (host) => host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host === "0.0.0.0";

/**
 * The origins of the http(s) URLs in a command's output (an install's error naming the URL it could not fetch), this
 * machine's own (loopback) left out: a service on this machine is no network.
 */
export function namedOrigins(text) {
  const found = new Set();
  for (const [url] of String(text || "").matchAll(/\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^,]+/g)) {
    const origin = originOf(url.replace(/[.,;:]+$/, ""));
    if (origin && !LOOPBACK(new URL(origin).hostname)) found.add(origin);
  }
  return [...found];
}

/**
 * Whether a set-up step that needs the network (the repository's install or setup), run from `startedMs` to `endedMs`
 * and failed, met this machine's network down. `cut` ({origin, code, since, ongoing}) when it did: an outage this
 * process recorded meanwhile (lostDuring), or the first of `origins` (the hosts the step needs) not answering a probe
 * now while `general` (this machine's reachability check, GitHub's origin) does not answer either. An ended outage in
 * `seen` (pastKey) was answered by a run since: it counts no more. Else `cut` is null and the network was up:
 * `answered`, the origins that answered, and `unanswered` ({origin, code}), the one host the step needs that did not
 * while the general check did, if any (that host's own trouble, never the machine's outage).
 */
export async function stepCutOff(origins, { startedMs, endedMs = OUTAGE.now(), seen = new Set(), general = githubOrigin() }) {
  const met = lostDuring(startedMs, endedMs, seen);
  if (met) return { cut: met };
  const down = await unreachableNow(origins);
  if (!down) return { cut: null, answered: origins };
  if (down.origin !== general && (await probe(general)) === null) return { cut: null, answered: [general], unanswered: down };
  return { cut: { ...down, since: OUTAGE.now(), ongoing: true } };
}

/**
 * The outage a NetworkDown (or a bare connect-level error) names, for an exit: {origin, host, code, since} (ms), plus
 * `resetAt` (ms) and `quota` (quotaResource's name) for GitHub's spent rate limit.
 */
export function outageOf(e, now = OUTAGE.now()) {
  // An error that names no outage (a bare connect failure): the one this process last gave up on, if any.
  const known = e?.origin && Number.isFinite(e?.since) ? e : (e?.origin && GIVEN_UP.get(e.origin)) || [...GIVEN_UP.values()].at(-1) || e;
  const origin = known?.origin ?? null;
  return { origin, host: origin ? hostOf(origin) : "the network", code: known?.code || causeCode(e) || "no answer", since: Number.isFinite(known?.since) ? known.since : now, ...(typeof known?.endpoint === "string" ? { endpoint: known.endpoint } : {}), ...(Number.isFinite(known?.resetAt) ? { resetAt: known.resetAt, quota: quotaName(known.key) } : {}) };
}

/** A paused or Blocked stage's reason for an outage (outageOf's fields, `since` and `resetAt` in ms). */
export const outageReason = ({ host, code, since, resetAt, quota = "core", endpoint = null }, now = OUTAGE.now()) =>
  Number.isFinite(resetAt) ? `GitHub's ${quota} API rate limit on ${host} is spent until ${iso(resetAt)} (met at ${iso(since)})` : `${lostText(host, code, endpoint)} from ${iso(since)}, ${minutesText(Math.max(0, now - since))} so far`;
