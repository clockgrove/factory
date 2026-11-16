// GitHub REST and GraphQL through `gh api`, with the token the caller sets in GH_TOKEN.
// Every write the plan routes through the App (push, PR, review request, card move,
// merge) goes through here with the App token in env; the job token is never passed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOCK_SKEW_MS, STEP_BASELINE_RUNS, answersComment, evaluateChecks, factoryReply, gateStarted, filesDiff, fitToFiles, isPlaceholder, isSelf, marker, parseWake, pooled, reviewBody, reviewComment, selfLogin, setMaintainers, setSelf, setWriters, spendOf, trustedAuthor, unpatchedFiles, writersRepo } from "./logic.mjs";
import { log, redactSecrets } from "./inputs.mjs";
import { exec } from "./proc.mjs";
import { OUTAGE, RATE_LIMIT_SPENT, UNREACHABLE, causeCode, clearSpent, downFor, networkBack, noteSpent, outageOn, quotaKey, quotaNow, quotaResource, spentCandidate, spentOn, spentResetOf, spentUntil, stoppedWaiting, waitingOutages } from "./network.mjs";

/** Run gh and throw on non-zero exit, with stderr on the error. */
async function run(cmd, args, opts = {}) {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    const e = new Error(`${cmd} exited ${r.code ?? r.signal}`);
    e.stderr = String(r.stderr);
    throw e;
  }
  return r;
}

export class GitHubError extends Error {
  constructor(message, status, body, { rateLimited = false, transport = false } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    // A 403 or 429 (or a GraphQL RATE_LIMITED error) that is GitHub throttling, not a refusal of the request itself.
    this.rateLimited = rateLimited;
    // No answer at all (the network, DNS, a timeout): status 0, and nothing GitHub said.
    this.transport = transport;
  }
}

/**
 * Whether an error is GitHub or the network failing for now: no answer at all (`transport`, here and in the token
 * mint), a 5xx, a 429 or a rate limit (REST or GraphQL RATE_LIMITED). Anything else is permanent: a refusal (4xx), any
 * other GraphQL error, a git failure, Factory's own errors.
 */
export const transientError = (e) => !!e && (e.transport === true || e.rateLimited === true || (Number.isInteger(e.status) && (e.status >= 500 || e.status === 429)));

/**
 * `token` is a string or a getter (the TokenKeeper's, which re-mints during long jobs). Without one, a person's own
 * command on their machine (doctor, setup) reads GitHub as their gh login; inside Actions there is no such fallback.
 * Anything else (a stage's request options, `{token, notice}`, passed as the token itself) is refused before any request:
 * GitHub would read it as a bad credential (#405).
 */
let LOGIN = undefined;
const tokenOf = (token) => {
  const t = typeof token === "function" ? token() : token;
  if (t && typeof t !== "string") throw new TypeError(`a GitHub call's token must be a string or a function giving one, not ${Array.isArray(t) ? "an array" : typeof t}`);
  if (t) return t;
  if (process.env.GITHUB_ACTIONS) return null;
  if (LOGIN === undefined) {
    try {
      LOGIN = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).trim() || null;
    } catch {
      LOGIN = null;
    }
  }
  return LOGIN;
};
const API = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

/** gh's env for the few calls still made through gh (artifact downloads): the token for that one child, no job token. */
function env(token) {
  const e = { ...process.env };
  const t = tokenOf(token);
  if (t) e.GH_TOKEN = t;
  delete e.GITHUB_TOKEN;
  delete e.GH_CONFIG_DIR;
  return e;
}

async function call(url, { method = "GET", body, token, accept = "application/vnd.github+json", maxBytes = 0, etag = null, signal = null }) {
  const t = tokenOf(token);
  const r = await fetch(url, {
    method,
    headers: {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clockgrove-factory",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(etag ? { "If-None-Match": etag } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    // Every request body: no held secret (a worker secret's value, inputs.mjs holdSecrets) is ever posted.
    body: requestBody(body),
    ...(signal ? { signal } : {}),
  });
  if (!maxBytes || !r.ok || !r.body) return { r, text: await r.text() };
  return { r, text: await tailOf(r.body, maxBytes) };
}

/** A request's JSON body with every held secret redacted (inputs.mjs redactSecrets); undefined without one. */
export const requestBody = (body) => (body !== undefined ? JSON.stringify(redactSecrets(body)) : undefined);

/** A response body's last `maxBytes` bytes, read as a stream so no more than about twice that is ever held. */
async function tailOf(stream, maxBytes) {
  let chunks = [];
  let held = 0;
  let total = 0;
  for await (const c of stream) {
    chunks.push(c);
    held += c.length;
    total += c.length;
    if (held > 2 * maxBytes) {
      const all = Buffer.concat(chunks);
      chunks = [all.subarray(all.length - maxBytes)];
      held = maxBytes;
    }
  }
  const all = Buffer.concat(chunks);
  const kept = all.length > maxBytes ? all.subarray(all.length - maxBytes) : all;
  const text = kept.toString("utf8");
  return total > kept.length ? `(the first ${total - kept.length} bytes of this log are cut; the rest is its end)\n${text.replace(/^[^\n]*\n/, "")}` : text;
}

// ------------------------------------------------------------------ retries

/**
 * The bound on one call's retries: at most `tries` requests and `maxWaitMs` of added waiting in all, and never a wait
 * that ends past the caller's `deadlineAt`. Ninety seconds covers GitHub's own asks (a secondary rate limit's
 * Retry-After is usually a minute) and a blip of 5xx answers or dropped connections, and stays far inside the 15 minutes
 * a stage keeps after its deadline for its exit (session.mjs deadline). A wait beyond what is left is not taken: the
 * error goes to the caller at once, as without retries. `gatewayMs`: the least wait before a create's check for itself
 * (createAgain) after a 502 or 504, a gateway's answer while GitHub may still be making it. `sleep`, `now` and `random`
 * (jitter); tests replace them.
 */
export const RETRY = { tries: 4, maxWaitMs: 90_000, baseMs: 2_000, gatewayMs: 10_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), random: Math.random };


/**
 * Whether a REST call means the same when sent twice: a read; a PUT, PATCH or DELETE, which sets a state (except a
 * merge and an update-branch, which are actions); a POST of labels to an issue or PR, which adds them to the ones it
 * has. Any other POST creates something (a comment, a review, a PR, a dispatch, a rerun) and is not.
 */
const repeatable = (method, path) => {
  const m = String(method).toUpperCase();
  const route = String(path).split("?")[0];
  if (m === "GET" || m === "HEAD") return true;
  if (m === "PUT" || m === "PATCH" || m === "DELETE") return !/\/(merge|update-branch)$/.test(route);
  return m === "POST" && /\/issues\/\d+\/labels$/.test(route);
};

/** Whether a failed request provably did nothing: it never left this machine, or GitHub's rate limit (403, 429) turned it away. */
const notDone = (e) => e?.unsent === true || (e?.rateLimited === true && (e.status === 403 || e.status === 429));

/**
 * Whether an answer is GitHub's rate limit: a 429, or a 403 with its signals (a spent quota, Retry-After, the secondary
 * limit's message). Any other status with those headers (a 5xx that asks for a wait, a 422 on the last quota point) is
 * no rate limit: GitHub may have done the request.
 */
const rateLimitOf = (status, headers, message) => status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /secondary rate limit|abuse/i.test(String(message || ""))));

/**
 * Mark a rate-limited GitHubError `err`, GitHub's answer to a request to `url` with `token`, as quota `quota`'s primary
 * limit spent, when it is (network.mjs spentResetOf: GitHub's count of the quota, read with the same token from
 * GET /rate_limit, decides): code RATE_LIMIT_SPENT and `resetAt` (ms), so any caller can tell, and the process's record
 * of it (noteSpent). The count read is of the quota the answer names (its x-ratelimit-resource; else quotaResource of
 * the path) and ends with the caller's `signal`. GET /rate_limit is not counted against the primary rate limit but can
 * count toward the secondary one, so it is not read again while this process holds the quota spent until this answer's
 * reset or later (the same spent window): the answer's own reset stands, the latest answer's as always.
 */
async function markSpent(err, quota, url, token, headers, signal = null) {
  if (!err.rateLimited || !spentCandidate(headers)) return;
  const now = RETRY.now();
  const held = spentUntil(quota);
  const stated = spentResetOf(headers, null, now);
  let resetAt = held !== null && stated !== null && held >= stated ? stated : null;
  if (resetAt === null) {
    const resource = headers.get("x-ratelimit-resource") || quotaResource(url);
    const count = await call(`${API()}/rate_limit`, { token, signal }).then(({ r, text }) => (r.ok ? quotaNow(JSON.parse(text), resource, r.headers.get("date")) : null)).catch(() => null);
    resetAt = spentResetOf(headers, count, now);
  }
  if (resetAt === null) return;
  err.code = RATE_LIMIT_SPENT;
  err.resetAt = resetAt;
  noteSpent(quota, resetAt);
}

/** The wait GitHub asks for, in ms, or null: Retry-After (seconds or an HTTP date), else a spent quota's x-ratelimit-reset. */
function askedWaitMs(headers, now = Date.now()) {
  const after = headers?.get?.("retry-after");
  if (after) {
    const secs = Number(after);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  if (headers?.get?.("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  }
  return null;
}

/**
 * A wait spread by up to 30% so many callers that failed together do not retry together: either way for a backoff of
 * Factory's own, only longer for a wait GitHub asked for (never below its value). `RETRY.random` is the source.
 */
const jitter = (ms, asked) => Math.round(ms * (asked ? 1 + 0.3 * RETRY.random() : 0.7 + 0.6 * RETRY.random()));

/** What withRetry returns a caller's found create under, so it is never read as an answer. */
const LANDED = Symbol("landed");

/**
 * Run `attempt(n)` (one request) until it answers, its failure is not transient (transientError), the bound (RETRY,
 * `deadlineAt`) is spent, or `again(e)` (asked after the wait) says no. `again` returns true to send again, false to
 * throw `e`, or {value} to end with that value (under LANDED). The wait is GitHub's ask (`e.waitMs`), a minute for a
 * rate limit that names none, else 2, 4, 8 s. Each retry is logged once, with its cause and try number; never a token.
 *
 * In a process that waits outages out (network.mjs waitOutages), a request that never left this machine (`unsent` with
 * no answer) is no try: it waits for `origin` to answer again (networkBack, one probe loop and one log line for all its
 * callers) and goes again then, a create included, since it did nothing. A request is not sent at all while an outage on
 * `origin` is under way; it waits for it first. Past the process's limit or `deadlineAt` the wait throws NetworkDown.
 * Once the process has stopped waiting (stopWaiting: a stage ending on the outage), such a request fails at once.
 *
 * GitHub's primary rate limit spent (`e.code` RATE_LIMIT_SPENT) is, in such a process, an outage of its quota (`quota`,
 * network.mjs quotaKey: the host, GraphQL, search or REST's core, and the token) until its reset: no try either, whatever
 * `noRateWait` says. The request waits for the reset (networkBack with `resetAt`, one sleep for all callers, and no
 * request goes against that quota meanwhile) and goes again then, a create included, since the refusal did nothing. A
 * reset past the process's limit or `deadlineAt` throws NetworkDown at once (with `resetAt`), and once the quota is given
 * up no request goes against it until the reset. Any other process keeps the bound: the error, with its code and
 * `resetAt`, goes to the caller when the reset is beyond it. An answer clears the quota's record (clearSpent).
 *
 * A 5xx that is still the answer once the bound is spent (or a create's check for it fails) is thrown as an outage of
 * `origin` from the call's first 5xx (outlasted), so the stage ends on it as on a lost network, never a crash.
 */
async function withRetry(what, attempt, again, { deadlineAt = Infinity, noRateWait = false, origin = null, quota = null } = {}) {
  // The bound starts again after a wait for the network: the time the host was unreachable is no retry's.
  const bound = () => Math.min(RETRY.now() + RETRY.maxWaitMs, Number.isFinite(deadlineAt) ? deadlineAt : Infinity);
  let end = bound();
  // When this call first met a 5xx (outlasted).
  let serverSince = null;
  for (let n = 1; ; n += 1) {
    let e;
    if (origin && waitingOutages() && outageOn(origin)) {
      await networkBack(origin, outageOn(origin).code, { deadlineAt });
      end = bound();
    }
    if (quota && waitingOutages() && outageOn(quota)) {
      await networkBack(origin, RATE_LIMIT_SPENT, { deadlineAt, resetAt: outageOn(quota).resetAt, key: quota });
      end = bound();
    }
    // A quota given up on whose reset is still ahead: not sent, as the limit this process gave up on.
    const spent = quota ? spentOn(quota) : null;
    if (spent) throw spent;
    try {
      const answer = await attempt(n);
      if (quota) clearSpent(quota);
      return answer;
    } catch (err) {
      e = err;
    }
    if (quota && e?.code === RATE_LIMIT_SPENT && Number.isFinite(e.resetAt) && (waitingOutages() || stoppedWaiting())) {
      await networkBack(origin, RATE_LIMIT_SPENT, { deadlineAt, resetAt: e.resetAt, key: quota });
      end = bound();
      n -= 1;
      continue;
    }
    if (origin && e?.transport === true && e.unsent === true && e.status === 0) {
      // Stopped waiting: at once, as the outage this process gave up on (its host and first loss), when it was this host's.
      if (stoppedWaiting()) throw downFor(origin) ?? e;
      if (waitingOutages()) {
        await networkBack(origin, e.code, { deadlineAt });
        end = bound();
        n -= 1;
        continue;
      }
    }
    if (serverError(e)) serverSince ??= OUTAGE.now();
    if (!transientError(e) || (noRateWait && e.rateLimited) || (again.possible && !again.possible(e))) throw e;
    if (n >= RETRY.tries) throw outlasted(e, what, origin, serverSince);
    // GitHub's ask: its header, or the minute it documents for a rate limit that names none. Spread only upward.
    const asked = e.waitMs !== undefined || (e.rateLimited && e.status > 0);
    const gateway = (e.status === 502 || e.status === 504) && !!again.reads?.(e);
    const base = Math.max(e.waitMs ?? (asked ? 60_000 : RETRY.baseMs * 2 ** (n - 1)), gateway ? RETRY.gatewayMs : 0);
    // The bound is held against the unspread wait: jitter never costs a retry, it is cut back to what is left instead.
    if (RETRY.now() + base > end) throw outlasted(e, what, origin, serverSince);
    const wait = Math.min(jitter(base, asked), Math.max(base, end - RETRY.now()));
    const cause = e.transport ? `network${e.code ? ` (${e.code})` : ""}` : e.rateLimited ? `rate limited${e.status ? ` (HTTP ${e.status})` : ""}` : `HTTP ${e.status}`;
    log(`GitHub ${what}: ${cause}; try ${n + 1} of ${RETRY.tries} in ${Math.ceil(wait / 1000)} s`);
    await RETRY.sleep(wait);
    const go = await again(e);
    if (go && typeof go === "object") return { [LANDED]: go.value };
    if (!go) throw outlasted(e, what, origin, serverSince);
  }
}

/**
 * A refreshable token: a getter with `refresh()`, which gets a new App installation token (token-keeper.mjs, and local
 * mode's notice token, session.mjs noticePost), and `mintedAt(token)`, when that token was minted (ms, this machine's
 * clock, as GitHub answered the mint), or null. A fixed token (local mode's own, or one a launcher handed over) has none.
 */
const refreshable = (token) => typeof token === "function" && typeof token.refresh === "function";

/** Why a refresh failed, for a log line: its message, cut. */
const why = (e) => String(e?.message || e).slice(0, 160);

/**
 * `token.refresh()`, and whether the getter gives another token after it: a refresh that minted the token and then
 * failed after (the agent's read-only token, its hand-over: token-keeper.mjs onRefresh) still replaced it. `failed` is
 * the refresh's error, if any.
 */
async function refreshOf(token) {
  const was = tokenOf(token);
  let failed = null;
  await token.refresh().catch((e) => {
    failed = e;
  });
  return { replaced: tokenOf(token) !== was, failed };
}

/**
 * The token a try sends: the getter's now, refreshed first when it says it is at its expiry (token-keeper.mjs `expired`),
 * so no call goes with an expired App installation token. A refresh that fails leaves the call to GitHub's answer.
 */
async function currentToken(token) {
  if (refreshable(token) && token.expired?.()) {
    const { replaced, failed } = await refreshOf(token);
    if (failed) log(`the App installation token was at its expiry; ${replaced ? "refreshed it, then" : "its refresh"} failed (${why(failed)})`);
  }
  return tokenOf(token);
}

/**
 * GitHub can refuse an installation token with 401 for a few seconds after it made it, until the token has reached all
 * its servers. @octokit/auth-app (8.3.1, its hook's sendRequestWithRetries) sends the same token again then: while the
 * token was less than 5 s old when the request went, after 1 s, then 2 s, then 3 s, and the 401 stands after that.
 * `tries` is that bound counted (the waits add to 6 s), so it holds whatever the clock does.
 */
export const PROPAGATION = { windowMs: 5_000, stepMs: 1_000, tries: 3 };

/**
 * `send()` (one call, its retries included) after a 401 on a refreshable token (`last()`: the token of its last try and
 * when it went). GitHub refused an App installation token and did nothing, so any call may go again:
 *  - the token was minted less than PROPAGATION.windowMs before the try: GitHub may not have it everywhere yet. The same
 *    token goes again after PROPAGATION's waits, minting nothing (a burst of 401s on a new token mints no more);
 *  - else, once per call: with the token the getter gives now when a refresh came between, else after one refresh. A
 *    refresh counts when the getter gives a new token, even if what it does after the mint failed (logged).
 * Each is logged by its cause, never with a token. A 401 past those, or a refresh that gave no new token, is the call's
 * failure.
 */
async function refreshedOn401(what, token, last, send) {
  let refreshed = false;
  let waits = 0;
  for (;;) {
    try {
      return await send();
    } catch (e) {
      if (e?.status !== 401 || !refreshable(token)) throw e;
      const { token: was, at } = last();
      const minted = token.mintedAt?.(was) ?? null;
      const age = minted === null ? null : at - minted;
      if (age !== null && age < PROPAGATION.windowMs && waits < PROPAGATION.tries) {
        waits += 1;
        const wait = waits * PROPAGATION.stepMs;
        log(`GitHub ${what}: HTTP 401 on an App installation token minted ${(Math.max(0, age) / 1000).toFixed(1)} s before; GitHub may not have it everywhere yet, so the same token goes again in ${wait / 1000} s (wait ${waits} of ${PROPAGATION.tries})`);
        await RETRY.sleep(wait);
        continue;
      }
      if (refreshed || (age !== null && age < PROPAGATION.windowMs)) throw e;
      refreshed = true;
      const meanwhile = tokenOf(token) !== was;
      const { replaced, failed } = meanwhile ? { replaced: true, failed: null } : await refreshOf(token);
      if (!replaced) {
        log(`GitHub ${what}: HTTP 401 on the App installation token, and its refresh failed (${why(failed)})`);
        throw e;
      }
      log(`GitHub ${what}: HTTP 401 on the App installation token; ${meanwhile ? "it was refreshed meanwhile" : failed ? `refreshed it (what follows a mint failed: ${why(failed)})` : "refreshed it"}, trying once more`);
    }
  }
}

/** A 5xx: GitHub answered, and failed. */
const serverError = (e) => Number.isInteger(e?.status) && e.status >= 500;

/**
 * A 5xx that outlasted the client's retries (`since`: the first in the call, ms on OUTAGE's clock) is an outage of
 * GitHub's `origin`, as network.mjs reads one (unreachable, outageMet, outageOf): `offline`, its origin, `code` the
 * status ("HTTP 500"), `since` and `endpoint` (`what`: the method and path, no query), so a stage ends on it (paused
 * locally) rather than crashing. Any other error as it is.
 */
function outlasted(e, what, origin, since) {
  if (!serverError(e) || !origin) return e;
  return Object.assign(e, { offline: true, origin, code: `HTTP ${e.status}`, since: since ?? OUTAGE.now(), endpoint: what });
}

/** A fetch that got no answer, as a GitHubError: `transport`, its connect-level `code`, and whether it never left (`unsent`). */
function transportError(what, e) {
  const code = causeCode(e);
  const err = new GitHubError(`${what} failed: ${e.message}${code ? ` (${code})` : ""}`, 0, "", { transport: true });
  err.code = code;
  err.unsent = UNREACHABLE.has(code);
  return err;
}

/**
 * Whether to send a create again after `e`: when it provably did nothing, else only on the caller's `landed()` (a read
 * that finds the create): no find (null or false) sends again, a find ({value}) ends the call with it, and a read that
 * fails or no `landed` at all gives up. Used by rest and graphql.
 */
const createAgain = (landed) => {
  const again = async (e) => {
    if (notDone(e)) return true;
    const got = await landed().catch(() => undefined);
    if (got === undefined) return false;
    return got ? { value: got } : true;
  };
  // Whether a retry could happen at all: else no wait is taken and nothing is logged.
  again.possible = (e) => notDone(e) || typeof landed === "function";
  // Whether the next try first reads for the create: after a gateway's 502 or 504 it waits RETRY.gatewayMs at least.
  again.reads = (e) => !notDone(e) && typeof landed === "function";
  return again;
};

/** A comment's body as compared for commentLanded: line ends as \n, no trailing blanks on a line or at the end. */
const sameText = (b) => String(b ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();

/**
 * For a new comment on an issue or PR (POST …/issues/N/comments) whose caller gave no `landed`: a read of the comments
 * updated since just before the call (on GitHub's clock, less CLOCK_SKEW_MS) that finds one with the body sent (sameText).
 * Its author must be Factory's own login when that is known, unless the body carries a Factory marker: a notice is
 * posted with the notice App's token, whose login is not the one Factory reads. So a comment GitHub made before failing
 * (a 5xx, a dropped answer) is found, not posted twice. Its reads keep the call's `deadlineAt`. Null for any other call.
 */
function commentLanded(method, url, body, { token, signal, deadlineAt }) {
  const route = new URL(url);
  if (String(method).toUpperCase() !== "POST" || !/\/issues\/\d+\/comments$/.test(route.pathname) || typeof body?.body !== "string") return null;
  const from = new Date(githubNow() - CLOCK_SKEW_MS).toISOString();
  const text = sameText(body.body);
  const anyAuthor = /<!-- factory:\d+:/.test(text);
  return async () => {
    const list = await rest(`${route.origin}${route.pathname}?since=${encodeURIComponent(from)}&per_page=100`, { token, paginate: true, signal, deadlineAt });
    return (list || []).find((c) => sameText(c?.body) === text && (anyAuthor || !selfLogin() || isSelf(c))) || null;
  };
}

/** GitHub's clock less this machine's (ms), from the newest answer's Date header; 0 before any answer. */
let clockSkewMs = 0;
/** Now on GitHub's clock (to its Date header's second): what a time GitHub wrote (a label event's) is compared with. */
export const githubNow = () => Date.now() + clockSkewMs;

/**
 * REST call with Node's fetch and the token in memory: no token in any process environment or file. `body` is sent as
 * JSON; `paginate` follows the Link header and returns every page's items as one array (a page that is an object with
 * one array field, such as {total_count, artifacts}, contributes that array); `raw` is an Accept header whose text is
 * returned as is. Returns parsed JSON or null.
 *
 * A transient failure is sent again within RETRY's bound and before `deadlineAt` (ms) when the call may repeat
 * (repeatable); a create only as createAgain allows, with the caller's optional `landed` (for a comment with none,
 * commentLanded). A 5xx that outlasts the bound is thrown as GitHub's outage (outlasted). A DELETE whose retry finds
 * nothing (404) after a transient failure is done: the first try removed it. A 401 on a refreshable App installation
 * token is sent again as refreshedOn401 says (GitHub's delay with a new token, else one refresh). `noRateWait`: a rate limit is thrown at once,
 * classified (`e.rateLimited`), for a caller that handles it itself (the dispatcher's next tick, a five-minute launch job).
 * `cache` (a Map, kept by the caller across calls) makes each GET page a conditional read: the page's last ETag goes as
 * If-None-Match, and GitHub's 304 for an unchanged page, which its rate limit does not count, answers with the page kept.
 * `signal` (an AbortSignal) ends a request in flight; give `deadlineAt` too, so no retry follows it.
 */
export async function rest(path, { method = "GET", body, token, paginate = false, raw = false, maxBytes = 0, deadlineAt = Infinity, landed = null, noRateWait = false, cache = null, signal = null } = {}) {
  let url = /^https?:/.test(path) ? path : `${API()}/${path.replace(/^\//, "")}`;
  const accept = raw ? raw.replace(/^Accept:\s*/i, "") : "application/vnd.github+json";
  const again = repeatable(method, path) ? async () => true : createAgain(landed ?? commentLanded(method, url, body, { token, signal, deadlineAt }));
  const quota = quotaKey(url, tokenOf(token));
  const conditional = cache && method === "GET" && !raw;
  // The token each try carried and when it went: the getter is read per try, so a refresh between tries is the next try's.
  let sent = { token: null, at: 0 };
  const one = async (n) => {
    const kept = conditional ? cache.get(url) : undefined;
    sent = { token: await currentToken(token), at: Date.now() };
    let res;
    try {
      res = await call(url, { method, body, token: sent.token, accept, maxBytes: raw ? maxBytes : 0, etag: kept?.etag, signal });
    } catch (e) {
      throw transportError(`${method} ${path}`, e);
    }
    const { r, text } = res;
    const date = Date.parse(r.headers.get("date") || "");
    if (Number.isFinite(date)) clockSkewMs = date - Date.now();
    if (kept && r.status === 304) return { r, text: kept.text, link: kept.link };
    if (r.ok) {
      const etag = conditional ? r.headers.get("etag") : null;
      if (etag) cache.set(url, { etag, text, link: r.headers.get("link") });
      return { r, text, link: r.headers.get("link") };
    }
    if (method === "DELETE" && r.status === 404 && n > 1) return { r, text: "" };
    let msg = text.slice(0, 500);
    try {
      msg = JSON.parse(text).message || msg;
    } catch {
      // not JSON
    }
    const limited = rateLimitOf(r.status, r.headers, msg);
    const err = new GitHubError(`${method} ${path} failed (${r.status}): ${msg}`, r.status, text, { rateLimited: limited });
    const asked = transientError(err) ? askedWaitMs(r.headers, RETRY.now()) : null;
    if (asked !== null) err.waitMs = asked;
    await markSpent(err, quota, url, sent.token, r.headers, signal);
    throw err;
  };
  const pages = [];
  for (;;) {
    const what = `${method} ${String(path).split("?")[0]}`;
    const res = await refreshedOn401(what, token, () => sent, () => withRetry(what, one, again, { deadlineAt, noRateWait, origin: new URL(url).origin, quota }));
    // A create the caller's `landed` found: its value is the answer.
    if (LANDED in res) return res[LANDED];
    const { text, link } = res;
    if (raw) return text;
    const data = text.trim() ? JSON.parse(text) : null;
    if (!paginate) return data;
    pages.push(data);
    const next = /<([^>]+)>;\s*rel="next"/.exec(link || "")?.[1];
    if (!next) break;
    url = next;
  }
  return pages.flatMap((p) => (Array.isArray(p) ? p : p && typeof p === "object" ? Object.values(p).find(Array.isArray) || [p] : []));
}

/**
 * The repository's own Actions variables, {NAME: value}, for the variable layer of its settings (inputs.mjs
 * settingLayers): one list call, 30 a page, conditional with `cache` (rest). A token without Variables: read (a local
 * fine-grained token made before it was asked for) gets 403 or 404: `{refused: status}`. Any other failure throws.
 */
export async function repositoryVariables(repo, { token, cache = null } = {}) {
  try {
    const list = await rest(`repos/${repo.full}/actions/variables?per_page=30`, { token, paginate: true, cache });
    return { vars: Object.fromEntries((list || []).filter((v) => v && typeof v.name === "string").map((v) => [v.name, String(v.value ?? "")])) };
  } catch (e) {
    if ((e.status === 403 || e.status === 404) && !e.rateLimited) return { refused: e.status };
    throw e;
  }
}

/**
 * The FACTORY_* names among the organization variables shared with the repository (one list call, the local token's
 * Variables read), which Factory's variable layer does not take (inputs.mjs organizationVariablesLine); null when they
 * could not be listed (a repository a user owns has none to list).
 */
export async function organizationVariableNames(repo, { token } = {}) {
  try {
    const list = await rest(`repos/${repo.full}/actions/organization-variables?per_page=30`, { token, paginate: true });
    return (list || []).map((v) => String(v?.name ?? "").toUpperCase()).filter((n) => n.startsWith("FACTORY_")).sort();
  } catch {
    return null;
  }
}

/** Whether a GraphQL document is a mutation (its first operation keyword, comments aside): a create, never resent blindly. */
const isMutation = (query) => /^mutation\b/.test(String(query).replace(/#[^\n]*/g, "").trim());

/**
 * GraphQL call with fetch; `variables` are passed as JSON. A query is retried like a REST read; a mutation like a
 * create (createAgain, with the caller's optional `landed`). `deadlineAt`, `noRateWait` and a 401's refresh as for rest.
 */
export async function graphql(query, variables = {}, { token, deadlineAt = Infinity, landed = null, noRateWait = false } = {}) {
  const url = process.env.GITHUB_GRAPHQL_URL || `${API()}/graphql`;
  const quota = quotaKey(url, tokenOf(token));
  let sent = { token: null, at: 0 };
  const one = async () => {
    sent = { token: await currentToken(token), at: Date.now() };
    let res;
    try {
      res = await call(url, { method: "POST", body: { query, variables }, token: sent.token });
    } catch (e) {
      throw transportError("graphql", e);
    }
    const { r, text } = res;
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (!r.ok) {
      const limited = rateLimitOf(r.status, r.headers, data?.message);
      const err = new GitHubError(`graphql failed (${r.status}): ${(data?.message || text).slice(0, 300)}`, r.status, text, { rateLimited: limited });
      const asked = transientError(err) ? askedWaitMs(r.headers, RETRY.now()) : null;
      if (asked !== null) err.waitMs = asked;
      await markSpent(err, quota, url, sent.token, r.headers);
      throw err;
    }
    if (data?.errors?.length) {
      const err = new GitHubError(`graphql: ${data.errors.map((e) => e.message).join("; ")}`, 0, data, { rateLimited: data.errors.some((e) => e?.type === "RATE_LIMITED") });
      // GitHub's RATE_LIMITED answer is a refusal: the operation did not run.
      if (err.rateLimited) {
        err.unsent = true;
        const asked = askedWaitMs(r.headers, RETRY.now());
        if (asked !== null) err.waitMs = asked;
        await markSpent(err, quota, url, sent.token, r.headers);
      }
      throw err;
    }
    return { data: data?.data };
  };
  const again = isMutation(query) ? createAgain(landed) : async () => true;
  const res = await refreshedOn401("graphql", token, () => sent, () => withRetry("graphql", one, again, { deadlineAt, noRateWait, origin: new URL(url).origin, quota }));
  return LANDED in res ? res[LANDED] : res.data;
}

export const repoOf = (full) => {
  const [owner, name] = String(full).split("/");
  if (!owner || !name) throw new Error(`--repo must be OWNER/NAME, got ${full}`);
  return { owner, name, full: `${owner}/${name}` };
};

// ------------------------------------------------------------------ issues

export async function getIssue(repo, number, opts) {
  return rest(`repos/${repo.full}/issues/${number}`, opts);
}

/** Issues with the label closed in the last `hours` (for the Done reconcile). */
export async function recentlyClosedByLabel(repo, label, hours, opts) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const items = await rest(`repos/${repo.full}/issues?state=closed&labels=${encodeURIComponent(label)}&since=${since}&per_page=100`, { ...opts, paginate: true });
  return (items || []).filter((i) => !i.pull_request);
}

export async function listIssuesByLabel(repo, label, opts) {
  const items = await rest(`repos/${repo.full}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`, { ...opts, paginate: true });
  return (items || []).filter((i) => !i.pull_request);
}

/**
 * The REST "blocked by" relations of an issue, or null when the endpoint is unavailable (the feature is off: 403, 404,
 * 410). A rate-limited read throws (`e.rateLimited`): the relations are unknown, never "none", so the caller does not
 * start the issue on its body lines alone.
 */
export async function blockedByRelations(repo, number, opts) {
  try {
    const items = await rest(`repos/${repo.full}/issues/${number}/dependencies/blocked_by?per_page=100`, opts);
    if (!Array.isArray(items)) return null;
    return items.map((i) => ({ number: i.number, state: i.state }));
  } catch (e) {
    if (!e.rateLimited && (e.status === 404 || e.status === 410 || e.status === 403)) return null;
    throw e;
  }
}

/**
 * Whether `label` was (re)applied after the last `since` label was applied: the
 * plan's recovery path, where a human re-applies factory:objective to a Blocked,
 * Question or abandoned In-review issue. Reads the issue timeline's label events; removing
 * one of `removedStarts` (a draft label: starting the draft) counts as re-applying `label`.
 */
export async function relabeledAfter(repo, number, label, since, opts, removedStarts = []) {
  return relabeledIn((await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [], label, since, removedStarts);
}

/** relabeledAfter on timeline events already read. */
export function relabeledIn(events, label, since, removedStarts = []) {
  let last = null;
  let lastSince = null;
  for (const e of events) {
    if (!e.label?.name) continue;
    if (e.event === "unlabeled" && removedStarts.includes(e.label.name)) last = e.created_at;
    if (e.event !== "labeled") continue;
    if (e.label.name === label) last = e.created_at;
    if (since.includes(e.label.name)) lastSince = e.created_at;
  }
  return !!(last && lastSince && last > lastSince);
}

export async function addLabels(repo, number, labels, opts) {
  return rest(`repos/${repo.full}/issues/${number}/labels`, { ...opts, method: "POST", body: { labels } });
}

export async function removeLabel(repo, number, label, opts) {
  try {
    await rest(`repos/${repo.full}/issues/${number}/labels/${encodeURIComponent(label)}`, { ...opts, method: "DELETE" });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

/** Set exactly one of the factory:* state labels. */
export async function setStateLabel(repo, number, state, opts) {
  const all = ["factory:running", "factory:blocked", "factory:question", "factory:in-review"];
  const want = state ? `factory:${state}` : null;
  for (const l of all) if (l !== want) await removeLabel(repo, number, l, opts);
  if (want) await addLabels(repo, number, [want], opts);
}

export async function ensureLabel(repo, name, color, description, opts) {
  try {
    await rest(`repos/${repo.full}/labels/${encodeURIComponent(name)}`, opts);
    return false;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  await rest(`repos/${repo.full}/labels`, { ...opts, method: "POST", body: { name, color, description } });
  return true;
}

/**
 * One of Factory's own record issues (the sandbox image's, image.mjs; the account holds', route-holds.mjs), or null: the
 * oldest issue Factory's own login opened with the exact `title`. The `label` is only a hint (the first, cheap query);
 * without it, Factory's own issues are searched by creator (every page of them), unless `fallback` is false: then the
 * label's one query alone. On Actions the issue must be locked, as Factory leaves it, so an unlocked one (Factory's, but
 * not the record's) is not trusted.
 */
export async function findRecordIssue(repo, { label, title }, opts, { actions = process.env.GITHUB_ACTIONS === "true", fallback = true } = {}) {
  const self = selfLogin();
  if (!self) return null;
  const ok = (i) => !i.pull_request && isSelf(i) && i.title === title && (!actions || i.locked === true);
  const query = (extra) => rest(`repos/${repo.full}/issues?creator=${encodeURIComponent(self)}&state=all&sort=created&direction=asc&per_page=100${extra}`, { ...opts, paginate: !extra });
  for (const extra of [`&labels=${encodeURIComponent(label)}`, ...(fallback ? [""] : [])]) {
    const found = ((await query(extra)) || []).filter(ok).sort((a, b) => a.number - b.number)[0];
    if (found) return found;
  }
  return null;
}

/**
 * Open one of Factory's own record issues (findRecordIssue): `label` made when absent, the issue opened with `title` and
 * `body`, then closed and locked, so it neither shows among open issues nor takes comments. Returns its number. Locked
 * is part of what makes it Factory's record on Actions: a failed close or lock throws, its error carrying the issue
 * opened (`issue`) for the caller to clean up.
 */
export async function openRecordIssue(repo, { label, color, description, title, body }, opts) {
  await ensureLabel(repo, label, color, description, opts);
  const issue = (await rest(`repos/${repo.full}/issues`, { ...opts, method: "POST", body: { title, body, labels: [label] } })).number;
  try {
    await rest(`repos/${repo.full}/issues/${issue}`, { ...opts, method: "PATCH", body: { state: "closed", state_reason: "completed" } });
    await rest(`repos/${repo.full}/issues/${issue}/lock`, { ...opts, method: "PUT", body: { lock_reason: "resolved" } });
  } catch (e) {
    throw Object.assign(e, { issue });
  }
  return issue;
}

export async function listComments(repo, number, opts) {
  return (await rest(`repos/${repo.full}/issues/${number}/comments?per_page=100`, { ...opts, paginate: true })) || [];
}

/**
 * Post a comment, or update the one carrying `marker` when it exists (idempotent on rerun). `head`: Factory's own text
 * after the marker on its first line (the plan comment's record, handoff.mjs planTextMarker), or a function making it
 * from the head the comment has now; `keepHead` keeps the one an existing comment has instead.
 */
export async function upsertComment(repo, number, mark, body, opts, { head = "", keepHead = false } = {}) {
  // Only Factory's own comment, the marker on its first line, is ours to edit: anyone can paste the marker into theirs.
  // Before Factory knows its login (a failed read), one by someone who can push is.
  const ours = (c) => (selfLogin() ? isSelf(c) : trustedAuthor(c)) && (c.body || "").startsWith(mark);
  const existing = (await listComments(repo, number, opts)).find(ours);
  const now = existing ? /^[^\n]*/.exec(existing.body)[0].slice(mark.length).replace(/\r$/, "") : null;
  // keepHead: the head the comment has now stays (a writer that knows none never erases one). A function `head` makes
  // the head from the one the comment has now (null with no comment).
  if (keepHead && existing) head = now;
  if (typeof head === "function") head = head(now);
  const text = `${mark}${head}\n${body}`;
  if (existing) return rest(`repos/${repo.full}/issues/comments/${existing.id}`, { ...opts, method: "PATCH", body: { body: text } });
  return rest(`repos/${repo.full}/issues/${number}/comments`, { ...opts, method: "POST", body: { body: text } });
}

// --------------------------------------------------------------------- PRs

export async function findPr(repo, head, opts) {
  const list = await rest(`repos/${repo.full}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}&per_page=10`, opts);
  return Array.isArray(list) && list.length ? list[0] : null;
}

export async function getPr(repo, number, opts) {
  return rest(`repos/${repo.full}/pulls/${number}`, opts);
}

/**
 * The PR once GitHub has worked out whether it still merges. Right after a sibling merges its state is `unknown`
 * for a few seconds (the read starts the computation); a decision on that would miss the conflict, and on Actions
 * nothing else wakes the dispatcher. Gives up after `tries` and returns the last answer.
 */
export async function getPrSettled(repo, number, opts, { tries = 6, waitMs = 2500 } = {}) {
  let pr = await getPr(repo, number, opts);
  for (let i = 1; i < tries && pr && !pr.merged && pr.state === "open" && (pr.mergeable === null || pr.mergeable_state === "unknown"); i += 1) {
    await new Promise((r) => setTimeout(r, waitMs));
    pr = await getPr(repo, number, opts);
  }
  return pr;
}

export async function createPr(repo, { head, base, title, body, draft }, opts) {
  return rest(`repos/${repo.full}/pulls`, { ...opts, method: "POST", body: { head, base, title, body, draft: !!draft } });
}

/** Change a PR's title or body. */
export async function updatePr(repo, number, fields, opts) {
  return rest(`repos/${repo.full}/pulls/${number}`, { ...opts, method: "PATCH", body: fields });
}

/** The branch's closed PRs, newest first (a split Objective's merged parts among them). */
export async function closedPrsFor(repo, head, opts) {
  return (await rest(`repos/${repo.full}/pulls?state=closed&head=${encodeURIComponent(`${repo.owner}:${head}`)}&sort=created&direction=desc&per_page=20`, opts)) || [];
}

/** A reply in a review comment's thread. */
export async function postReply(repo, number, commentId, body, opts) {
  return rest(`repos/${repo.full}/pulls/${number}/comments/${commentId}/replies`, { ...opts, method: "POST", body: { body } });
}

/**
 * A PR's diff as GitHub shows it (the head against its merge base with the base), for a PR of any size: GitHub's own
 * diff media type refuses one over 300 files (406). `diffOf(base, head)` makes it from local history (a three-dot
 * diff: no file limit); without it, or when it fails, it is made from the paginated files API, which lists at most
 * 3000 files and leaves out the patch of a file too large for it. Returns {text, source: "history" | "files",
 * historyError, unlisted (files the API left out), unpatched (files it lists with changes but no patch)}.
 */
export async function prDiff(repo, pr, opts, { diffOf = null } = {}) {
  let historyError = diffOf ? "" : "no local history";
  if (diffOf) {
    try {
      return { text: String(await diffOf(pr.base.sha, pr.head.sha)), source: "history", historyError: "", unlisted: 0, unpatched: 0 };
    } catch (e) {
      historyError = String(e?.message || e).slice(0, 200);
    }
  }
  const files = (await rest(`repos/${repo.full}/pulls/${pr.number}/files?per_page=100`, { ...opts, paginate: true })) || [];
  return { text: filesDiff(files), source: "files", historyError, unlisted: Math.max(0, (Number(pr.changed_files) || 0) - files.length), unpatched: unpatchedFiles(files) };
}

/** Convert to draft or mark ready: GraphQL is the only API for it. */
export async function setDraft(repo, number, draft, opts) {
  const pr = await getPr(repo, number, opts);
  if (!!pr.draft === !!draft) return;
  const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  await graphql(`mutation($id: ID!) { ${mutation}(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`, { id: pr.node_id }, opts);
}

/**
 * Mark the PR ready for review (delivered) and return it as it now stands, `draft: false`: a Block later in the same exit
 * then says the PR was delivered (session.mjs applyExit), never that it is a draft with what exists.
 */
export async function markReady(repo, pr, opts) {
  if (pr.draft) await setDraft(repo, pr.number, false, opts);
  return { ...pr, draft: false };
}

export async function requestReviewers(repo, number, reviewers, opts) {
  // GitHub refuses a review request to the PR's own author (a local run opens PRs as the developer, who is also notify).
  const author = (await getPr(repo, number, opts).catch(() => null))?.user?.login?.toLowerCase();
  reviewers = reviewers.filter((r) => r && r.toLowerCase() !== author);
  if (!reviewers.length) return;
  await rest(`repos/${repo.full}/pulls/${number}/requested_reviewers`, { ...opts, method: "POST", body: { reviewers } });
}

export async function listReviewComments(repo, number, opts) {
  return (await rest(`repos/${repo.full}/pulls/${number}/comments?per_page=100`, { ...opts, paginate: true })) || [];
}

/**
 * Post a comment-only review. GitHub refuses the whole review (422) for one line comment it cannot place: on a file its
 * files API lists without a patch, or on a line outside the patch. So each comment is first fitted to the PR's file
 * listing (logic.mjs fitToFiles): one GitHub cannot take moves to a line it can, with a note naming the finding's own
 * file and line, and stays a line comment the answer pass reads. Only with no line anywhere to take it does a comment
 * go in the review body. When GitHub still answers 422, the review is posted once more with every comment in the body,
 * under markers the answer pass reads (session.mjs unaddressedReviewComments), so no review and no finding is lost.
 * Returns {review, inline, moved, inBody, retried (the status that made it retry, or 0), sent (the line comments as sent)}.
 */
export async function postReview(repo, number, { body, comments, commitId }, opts) {
  const post = (text, list) => rest(`repos/${repo.full}/pulls/${number}/reviews`, { ...opts, method: "POST", body: { event: "COMMENT", body: text, comments: list.map(reviewComment), ...(commitId ? { commit_id: commitId } : {}) } });
  const all = comments || [];
  let fit = { inline: all, moved: 0, aside: [] };
  if (all.length) {
    try {
      fit = fitToFiles(all, (await rest(`repos/${repo.full}/pulls/${number}/files?per_page=100`, { ...opts, paginate: true })) || []);
    } catch (e) {
      // No listing: each comment with a file and line is tried where it is, and a 422 puts them all in the body below.
      // One with neither (a diff that shows no line) goes in the body. The log names the status only, never vendor text.
      log(`PR #${number}: the files listing failed (${e?.status ?? (/^[A-Z0-9_]+$/.test(String(e?.code)) ? e.code : "no status")}); posting each line comment where it is`);
      const placed = (c) => !!c?.path && Number.isInteger(c?.line) && c.line > 0;
      fit = { inline: all.filter(placed), moved: 0, aside: all.filter((c) => !placed(c)) };
    }
  }
  try {
    return { review: await post(reviewBody(body, fit.aside), fit.inline), inline: fit.inline.length, moved: fit.moved, inBody: fit.aside.filter((c) => !isPlaceholder(c?.body)).length, retried: 0, sent: fit.inline.map(reviewComment) };
  } catch (e) {
    if (e?.status !== 422 || !fit.inline.length) throw e;
    return { review: await post(reviewBody(body, all), []), inline: 0, moved: 0, inBody: all.filter((c) => !isPlaceholder(c?.body)).length, retried: e.status, sent: [] };
  }
}

/**
 * The PR's review threads as Factory sorts them, each `{id, rootId, resolved, author, path, line, by, answered}`: `rootId` the root comment's REST id, `author` the root comment's, named as REST names it (an App's `<slug>[bot]`; GraphQL
 * names a Bot without the suffix), `line` the current line, else the original one. `by` is "ours" for a thread Factory's
 * reviewer opened (the root belongs to the review carrying marker(issue, "review"), by a trusted author: trustedAuthor),
 * "named" for one a reviewer Factory answers opened (`thirdParty`: third-party-review.mjs answeredReviewers, matched on the
 * root comment's author), else null. `answered` is a person's answer, as the answer pass's list judges it: ours once a
 * reply by someone who can push (trustedAuthor) other than Factory's own answer exists (logic.mjs factoryReply) or the
 * root is Factory's placeholder; named once a
 * person's reply answers it (logic.mjs answersComment). Factory's own answer is the finding check's to judge
 * (finding-check.mjs): only its yes resolves the thread.
 */
export async function reviewThreads(repo, number, issue, opts, { thirdParty = [] } = {}) {
  const nodes = [];
  let after = null;
  // Every thread, a page of 100 at a time (THREAD_PAGES at most).
  for (let page = 0; page < THREAD_PAGES; page += 1) {
    const data = await graphql(
      `query($owner: String!, $name: String!, $n: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved path line originalLine comments(first: 50) { nodes { databaseId body authorAssociation author { __typename login } pullRequestReview { body authorAssociation author { __typename login } } } } } } } } }`,
      { owner: repo.owner, name: repo.name, n: Number(number), after },
      opts,
    );
    const got = data?.repository?.pullRequest?.reviewThreads;
    nodes.push(...(got?.nodes || []));
    if (!got?.pageInfo?.hasNextPage || !got.pageInfo.endCursor) break;
    after = got.pageInfo.endCursor;
  }
  const mark = marker(issue, "review");
  // An author as REST shows it (GraphQL names a Bot without "[bot]"), for trustedAuthor.
  const asRest = (author, association, body) => ({ user: { type: author?.__typename, login: author?.__typename === "Bot" ? `${author.login}[bot]` : author?.login }, author_association: association, body });
  const named = new Set(thirdParty.map((l) => String(l).toLowerCase()));
  return nodes.map((t) => {
    const comments = t.comments?.nodes || [];
    const root = comments[0];
    const review = root?.pullRequestReview;
    const ours = !!root && String(review?.body || "").includes(mark) && trustedAuthor(asRest(review?.author, review?.authorAssociation));
    // A reviewer outside Factory is told by the root comment's own author, as the answer pass's list tells it.
    const author = root?.author ? asRest(root.author).user.login : null;
    const theirs = !!root && !ours && named.has(String(author || "").toLowerCase());
    const replies = comments.slice(1).map((c) => asRest(c.author, c.authorAssociation, c.body));
    const answered = ours ? isPlaceholder(root.body) || replies.some((r) => trustedAuthor(r) && !factoryReply(r)) : theirs ? replies.some((r) => answersComment(author, r)) : false;
    return { id: t.id, rootId: root?.databaseId ?? null, resolved: !!t.isResolved, author, path: t.path ?? null, line: t.line ?? t.originalLine ?? null, by: ours ? "ours" : theirs ? "named" : null, answered };
  });
}
/** The most pages of 100 review threads reviewThreads reads. */
const THREAD_PAGES = 10;

/** Resolve one review thread (pull requests write, which Factory's token has). */
export async function resolveThread(id, opts) {
  await graphql(`mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`, { id }, opts);
}

/**
 * Resolve the review threads Factory handles (reviewThreads: its own reviewer's, and those of the reviewers in
 * `thirdParty`) that a person answered or that hold Factory's placeholder, so a rule that requires resolved
 * conversations can merge; they stay visible on the PR. A thread Factory's own answer is in is resolved by the finding
 * check's yes (finding-check.mjs), never here. Returns the number resolved.
 */
export async function resolveFactoryThreads(repo, number, issue, opts, { thirdParty = [] } = {}) {
  let resolved = 0;
  for (const t of await reviewThreads(repo, number, issue, opts, { thirdParty })) {
    if (t.resolved || !t.by || !t.answered) continue;
    await resolveThread(t.id, opts);
    resolved += 1;
  }
  return resolved;
}

/**
 * What on `branch` requires every review conversation resolved before a merge: "branch protection" (its
 * requiresConversationResolution, read through refUpdateRule, which needs no admin), "a ruleset" (an active ruleset's
 * pull_request rule with `required_review_thread_resolution`: GitHub's rules for a branch list only the active ones
 * that apply to it, to anyone who can read the repository), or null for neither.
 */
export async function resolutionRule(repo, branch, opts) {
  const d = await graphql(`query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { refUpdateRule { requiresConversationResolution } } } }`, { owner: repo.owner, name: repo.name, ref: `refs/heads/${branch}` }, opts);
  if (d?.repository?.ref?.refUpdateRule?.requiresConversationResolution === true) return "branch protection";
  const rules = (await rest(`repos/${repo.full}/rules/branches/${encodeURIComponent(branch)}?per_page=100`, { ...opts, paginate: true })) || [];
  return rules.some((r) => r?.type === "pull_request" && r.parameters?.required_review_thread_resolution === true) ? "a ruleset" : null;
}

/** The issue numbers GitHub parsed as closed by this PR (its closing references), as GitHub will act on them. */
export async function closingIssues(repo, number, opts) {
  const data = await graphql(
    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { closingIssuesReferences(first: 50) { nodes { number } } } } }`,
    { owner: repo.owner, name: repo.name, number },
    opts,
  );
  return (data?.repository?.pullRequest?.closingIssuesReferences?.nodes || []).map((n) => n.number);
}

/** Every check-run on a commit (Actions jobs and other apps' checks). */
/** The check-runs on a commit: the latest attempt of each, or every attempt with `all`. */
export async function checkRuns(repo, sha, opts, { all = false } = {}) {
  return (await rest(`repos/${repo.full}/commits/${sha}/check-runs?per_page=100${all ? "&filter=all" : ""}`, { ...opts, paginate: true })) || [];
}

/** A job log as text: ANSI colour codes and the runner's per-line timestamps removed. */
export function cleanLog(raw) {
  // eslint-disable-next-line no-control-regex
  return String(raw ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/gm, "");
}

/**
 * The lines of the step that failed: from the last `##[group]` (a step's header) before the first `##[error]` to the
 * next `##[group]` after it. Warnings and failure-shaped lines from steps that passed (setup, caches) stay out of the
 * signature. A log with no `##[error]`, or no group before it, is read whole.
 */
export function failingStep(lines) {
  const err = lines.findIndex((l) => l.startsWith("##[error]"));
  if (err < 0) return lines;
  let start = -1;
  for (let i = err - 1; i >= 0; i -= 1) if (lines[i].startsWith("##[group]")) {
    start = i;
    break;
  }
  if (start < 0) return lines;
  const next = lines.findIndex((l, i) => i > err && l.startsWith("##[group]"));
  return lines.slice(start, next < 0 ? lines.length : next);
}

/** The first failed step of an Actions job that ran ({name, number, conclusion, started_at, completed_at}, GitHub's `steps`), or null. */
export const failedStep = (job) => (Array.isArray(job?.steps) ? (job.steps.find((x) => x?.conclusion === "failure") ?? null) : null);

// A runner log line's own timestamp, to the second (ms), or NaN for a line without one.
const lineSecond = (l) => {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z/.exec(l);
  return m ? Date.parse(`${m[1]}Z`) : NaN;
};

/**
 * The lines of `job`'s failed step (failedStep), cut from the raw log by time: every line the runner stamped within the
 * step's started_at and completed_at, which GitHub states to the second, so both seconds are kept whole. At those two
 * edges other steps can share a second. The first is trimmed only when GitHub's `steps` show an earlier step that ended
 * in it: the step starts at its own `##[group]` header, the one after the headers of the earlier steps that started in
 * that second; with no such step, or fewer headers than that, the whole second is kept. In the last second, lines after
 * the step's last `##[error]` (the runner's own last line of a failed step) are later steps'. A step's own `::group::`
 * output is no boundary. Cleaned
 * (cleanLog). null with no job, no failed step with both times, or no line stamped in that range: the caller cuts by
 * structure (failingStep).
 */
export function stepByTime(raw, job) {
  const step = failedStep(job);
  const from = Math.floor(Date.parse(step?.started_at) / 1000) * 1000;
  const to = Math.floor(Date.parse(step?.completed_at) / 1000) * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const kept = [];
  let sec = NaN;
  for (const l of String(raw ?? "").split("\n")) {
    const t = lineSecond(l);
    // A line with no stamp of its own goes with the line before it.
    if (Number.isFinite(t)) sec = t;
    if (sec >= from && sec <= to) kept.push({ sec, line: cleanLog(l) });
  }
  if (!kept.length) return null;
  // The first second is trimmed only when an earlier step ended in it. Each step that ran opens with a `##[group]`
  // header, so the step's own header is the one after those of the earlier steps that started in that second. Where
  // that count does not hold (an earlier step's own groups, a header stamped a second late), more is kept, not less.
  const second = (x) => Math.floor(Date.parse(x) / 1000) * 1000;
  const earlier = job.steps.filter((x) => x !== step && Number(x?.number) < Number(step.number) && x?.conclusion !== "skipped");
  let head = -1;
  if (earlier.some((x) => second(x?.completed_at) === from)) {
    const before = earlier.filter((x) => second(x?.started_at) === from).length;
    const groups = [];
    for (let i = 0; i < kept.length && kept[i].sec === from; i += 1) if (kept[i].line.startsWith("##[group]")) groups.push(i);
    if (groups.length > before) head = groups[before];
  }
  let lastError = -1;
  for (let i = kept.length - 1; i >= 0; i -= 1) if (kept[i].line.startsWith("##[error]")) {
    lastError = i;
    break;
  }
  const end = lastError >= 0 && kept[lastError].sec === to ? lastError + 1 : kept.length;
  const lines = kept.slice(Math.max(0, head), end).map((x) => x.line);
  return lines.length ? lines : null;
}

/** The failed step's lines of a job log: by time when `job` says when it ran (stepByTime), else by structure (failingStep). */
export const stepLines = (text, job = null) => stepByTime(text, job) ?? failingStep(cleanLog(text).split("\n"));

// What a count of lines left out takes in a window, at most: its own line and newline.
const OMITTED = 48;
const omitted = (n) => (n > 0 ? [`(${n} lines of this step not shown)`] : []);

/**
 * Whole lines of `lines` from index `to` back towards `from` (exclusive) while they fit in `room` characters, newlines
 * counted: {start, kept, used}. When not even line `to` fits, its end (`cut` "end") or start ("start") as far as the
 * room goes, nothing when there is none.
 */
function linesBack(lines, from, to, room, cut = "end") {
  const kept = [];
  let used = 0;
  let i = to;
  for (; i > from && used + lines[i].length + 1 <= room; i -= 1) {
    kept.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  if (!kept.length && to > from && room > 1) {
    const part = cut === "end" ? lines[to].slice(-(room - 1)) : lines[to].slice(0, room - 1);
    return { start: to, kept: [part], used: part.length + 1 };
  }
  return { start: i + 1, kept, used };
}

/**
 * The lines of a job log that say why the job failed, in at most `chars` characters: the step that failed (stepLines: by
 * the job's step times when `job`, GitHub's job with its `steps`, is given, else at the step's `##[group]` boundaries),
 * so no other step's output (set-up warnings, caches, post-job cleanup) is in it, cleaned of colour codes and
 * timestamps. A step longer than `chars` (what a prompt holds) keeps the start of its first line (the command it ran,
 * at most a quarter of the room), the step's first `##[error]` with the lines just before it (what explains the failure
 * when the step goes on after it), and as many of its last whole lines as fit (where the runner reports how it ended);
 * the lines left out are counted.
 */
export function logWindow(text, chars = 4000, job = null) {
  const step = stepLines(text, job);
  const whole = step.join("\n");
  if (whole.length <= chars) return whole;
  const head = step[0].slice(0, Math.floor(chars / 4));
  const room = chars - head.length - 2 * OMITTED;
  const last = step.length - 1;
  const firstError = step.findIndex((l, i) => i > 0 && l.startsWith("##[error]"));
  const lead = Math.max(1, firstError - 3);
  // The step's end, as far as all the room goes: enough when it reaches the first error's lead-in.
  const tail = linesBack(step, 0, last, room);
  if (firstError < 0 || tail.start <= lead) return [head, ...omitted(tail.start - 1), ...tail.kept].join("\n");
  // Else the first error and the lines before it (the error line first), in up to half the room; the end in the rest.
  const error = linesBack(step, lead - 1, firstError, Math.floor(room / 2), "start");
  const end = firstError < last ? linesBack(step, firstError, last, room - error.used) : { start: last + 1, kept: [], used: 0 };
  return [head, ...omitted(error.start - 1), ...error.kept, ...omitted(end.start - firstError - 1), ...end.kept].join("\n");
}

/** The most of one job log Factory holds: past it the head is cut while reading and the end kept. */
export const JOB_LOG_CAP = 8 * 1024 * 1024;
// A finished job's log never changes: triage and the fix pass's detail read each one once.
const LOGS = new Map();

/**
 * An Actions job's whole log (a check-run's id is the job's id) up to JOB_LOG_CAP bytes, its end kept. The twelve
 * newest read are kept (a red's own jobs, read by triage and again by the fix pass's detail); `cache: false` for a log
 * read once.
 */
export async function jobLog(repo, jobId, opts, { cache = true } = {}) {
  const key = `${repo.full}#${jobId}`;
  if (LOGS.has(key)) return LOGS.get(key);
  // The logs endpoint redirects to storage; fetch drops the Authorization header on that cross-origin hop.
  const text = String(await rest(`repos/${repo.full}/actions/jobs/${jobId}/logs`, { token: opts.token, raw: "application/vnd.github+json", maxBytes: JOB_LOG_CAP }));
  if (!cache) return text;
  LOGS.set(key, text);
  while (LOGS.size > 12) LOGS.delete(LOGS.keys().next().value);
  return text;
}

/** The failed step of an Actions job's log (logWindow); empty when unavailable. */
export async function jobLogTail(repo, jobId, opts, chars = 4000) {
  try {
    return logWindow(await jobLog(repo, jobId, opts), chars);
  } catch {
    return "";
  }
}

/**
 * Wait for the named required checks on `sha`: polls the check-runs until every name has a
 * completed run, or `timeoutMs` passes. A name with no run at all after `appearMs` is a
 * failure (no workflow ran for this head). Returns {green, checks, output, timedOut} where
 * `output` is the failed jobs' log tails (every failed check-run on the head, named or not,
 * since the required check is usually an aggregate of the jobs that actually fail). `conflicted` (async, optional) is
 * asked on every poll; when it says yes the wait ends at once with `conflict: true` (a conflicting PR gets no runs).
 * `failedRuns` are those failed check-runs ({id, name, conclusion, suite, started_at, completed_at}); `ignoreIds` are check-runs a rerun replaces, read
 * as not there yet, so the wait lasts until the rerun's own runs finish. `maxPollMs` above `pollMs` backs the reads off.
 * `ended(runs)` (async, optional) is asked on a read with check runs that leaves a required check with none; yes ends
 * the wait unfinished. A required name no check run has is read from the head's commit statuses too (a pending status is
 * a check in progress, a failing one a failed run). `progress(checks)` (async, optional) is asked on a read that leaves a
 * required check unfinished, given the checks as queueCommitChecks shapes them, and answers `{running, hung}`: hung
 * checks (session.mjs hangsOn) end the wait unfinished, returned as `hung`, and so does `idleMs` with no required check
 * running. `timeoutMs` is the caller's bound (the stage's wall clock); the reads back off only past `backoffAfterMs`.
 * `onRead(state, runs)` (optional) gets
 * each reading's evaluateChecks state as it is made, with every check run read on the head; `signal` (an AbortSignal,
 * optional) ends the wait, unfinished, at its next pause.
 */
/** `ms` of sleep, cut short when `signal` aborts. */
const pause = (ms, signal = null) =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      r();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** A check run as awaitChecks returns it (and checksNotStarted reads it). */
const runShape = (r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion ?? null, suite: r.check_suite?.id ?? null, app: r.app?.slug ?? null, started_at: r.started_at ?? null });

export async function awaitChecks(repo, sha, names, { token, timeoutMs = Infinity, appearMs = 15 * 60_000, pollMs = 60_000, maxPollMs = pollMs, backoffAfterMs = 0, onPoll = null, onRead = null, conflicted = null, ended = null, progress = null, idleMs = Infinity, ignoreIds = null, signal = null, sleep = (ms) => pause(ms, signal) } = {}) {
  const started = Date.now();
  // When a required check was last seen running (progress), from the wait's start.
  let ranAt = started;
  // The head's commit statuses as check runs, read while a required name has no check run.
  let statuses = [];
  // Conditional reads (rest's ETag cache): a page unchanged since the last poll answers 304, outside the rate limit.
  const etags = new Map();
  // The pause between reads: `pollMs`, doubling after each read up to `maxPollMs` (a backoff), never past the timeout.
  let pause = pollMs;
  let runs = [];
  let state = null;
  let conflict = false;
  let hangs = [];
  // Whether a read of the check runs has succeeded since the wait began.
  let readOnce = false;
  for (;;) {
    // A failed read is no reading: once one has succeeded, the last good one stands and the wait goes on to its own
    // deadline; with none yet, the wait ends at `appearMs` as for nothing ran.
    const read = await checkRuns(repo, sha, { token, cache: etags }).catch(() => null);
    if (read) {
      runs = read.filter((r) => !ignoreIds?.has(r.id));
      readOnce = true;
      if (names.some((n) => !runs.some((r) => r.name === n))) statuses = await rest(`repos/${repo.full}/commits/${sha}/status`, { token, cache: etags }).then((st) => (st?.statuses || []).map(statusRun), () => statuses);
      runs = [...runs, ...statuses.filter((x) => !runs.some((r) => r.name === x.name))];
    }
    state = evaluateChecks(names, runs);
    // Each reading as it is made (session.mjs validationLoop's `onRead`: whether the head is known red yet).
    onRead?.(state, runs.map(runShape));
    if (state.done) break;
    if (conflicted && (await conflicted().catch(() => false))) {
      conflict = true;
      break;
    }
    const elapsed = Date.now() - started;
    if (signal?.aborted) break;
    if ((read || !readOnce) && state.missing.length && elapsed > appearMs && !state.pending.length && runs.length === 0) break; // nothing ran for this head
    // A required check with no run while others reported (with none, appearMs above ends the wait), and `ended` (async,
    // optional, given the runs as returned below) says it will get none: its own workflow runs ended before their jobs
    // ran. The wait ends at once, unfinished.
    if (read && state.missing.length && runs.length > 0 && ended && (await ended(runs.map(runShape)).catch(() => false))) break;
    // A required check that made no progress (its step past its usual duration) ends it too, and so does `idleMs` with
    // none running (queued, waiting or not reported: GitHub's not-started bound). An unanswered reading is running.
    if (read && progress) {
      const p = await progress(runs.map(commitCheck)).catch(() => null);
      if (!p || p.running) ranAt = Date.now();
      if ((hangs = p?.hung || []).length) break;
    }
    if (progress && Date.now() - ranAt > idleMs) break;
    if (elapsed > timeoutMs) break;
    if (onPoll) await onPoll(state, Math.round(elapsed / 60000));
    await sleep(Math.max(1, Math.min(pause, timeoutMs - elapsed + 1)));
    if (elapsed >= backoffAfterMs) pause = Math.min(pause * 2, Math.max(pollMs, maxPollMs));
  }
  const timedOut = !state.done && !conflict;
  const failedRuns = runs.filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion));
  const parts = [];
  for (const r of failedRuns.slice(0, 4)) parts.push(`--- ${r.name}: ${r.conclusion}\n${r.commitStatus ? `commit status${r.details_url ? ` ${r.details_url}` : ""}` : await jobLogTail(repo, r.id, { token })}`);
  if (timedOut) parts.unshift(`required check(s) not finished after ${Math.round((Date.now() - started) / 60000)} min: missing ${state.missing.join(", ") || "none"}; pending ${state.pending.join(", ") || "none"}`);
  if (conflict) parts.unshift("the PR conflicts with its base branch: GitHub starts no required-check run for it");
  // `runs` and `minutes`: what a wait that timed out with nothing failed is read against (triage.mjs checksNotStarted).
  return { green: state.done && state.green, checks: state, output: parts.join("\n"), timedOut, conflict, hung: hangs, minutes: Math.round((Date.now() - started) / 60000), runs: runs.map(runShape), failedNames: state.failed.map((f) => f.name), failedRuns: failedRuns.map((r) => ({ id: r.id, name: r.name, conclusion: r.conclusion, suite: r.check_suite?.id ?? null, started_at: r.started_at ?? null, completed_at: r.completed_at ?? null })) };
}

/** GitHub merges the base branch into the PR's branch (its "Update branch" button): 202 accepted; 422 when it is up to date or conflicting. */
export async function updatePrBranch(repo, number, opts) {
  return rest(`repos/${repo.full}/pulls/${number}/update-branch`, { ...opts, method: "PUT", body: {} });
}

export async function prComment(repo, number, body, opts) {
  return rest(`repos/${repo.full}/issues/${number}/comments`, { ...opts, method: "POST", body: { body } });
}

/**
 * Merge exactly `sha`, never a later head: with a merge queue, enqueue with `expectedHeadOid`; without one, the merge
 * endpoint with `sha` (GitHub refuses either when the PR's head is not that commit). The squash commit's title and
 * message are Factory's (`title`, `message`), never the branch's commit messages, which could close any issue; the
 * queue takes the repository's squash defaults, which setup sets to the PR's title and body. Returns "queued" or
 * "merged".
 */
export async function mergeVerified(repo, number, sha, { queue, title, message }, opts) {
  if (queue) {
    const pr = await getPr(repo, number, opts);
    await graphql(`mutation($id: ID!, $oid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid}) { mergeQueueEntry { id } } }`, { id: pr.node_id, oid: sha }, opts);
    return "queued";
  }
  await rest(`repos/${repo.full}/pulls/${number}/merge`, { ...opts, method: "PUT", body: { sha, merge_method: "squash", ...(title ? { commit_title: title } : {}), commit_message: message || "" } });
  return "merged";
}

/** Whether the PR is in the merge queue now. */
export async function inMergeQueue(repo, number, opts) {
  const d = await graphql(`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { isInMergeQueue } } }`, { owner: repo.owner, name: repo.name, n: Number(number) }, opts);
  return !!d?.repository?.pullRequest?.isInMergeQueue;
}

/**
 * GitHub's record of the PR's removals from the merge queue (its timeline), newest 50: `{at, reason, actor, person}`,
 * `reason` GitHub's code, `actor` the login that removed it (`github-merge-queue` for the queue's own drops, Factory's
 * App when it took a stalled entry out) and `person` whether that is a user's account (a hand removal), not a bot's.
 */
export async function mergeQueueRemovals(repo, number, opts) {
  const d = await graphql(`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { timelineItems(itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT], last: 50) { nodes { ... on RemovedFromMergeQueueEvent { createdAt reason actor { login __typename } } } } } } }`, { owner: repo.owner, name: repo.name, n: Number(number) }, opts);
  return (d?.repository?.pullRequest?.timelineItems?.nodes || []).filter(Boolean).map((e) => ({ at: e.createdAt ?? null, reason: e.reason ?? null, actor: e.actor?.login ?? null, person: e.actor?.__typename === "User" }));
}

/**
 * The PR's merge queue entry, or null when it is not in the queue: `{state, enqueuedAt, head, headAt}`, `state` GitHub's
 * (QUEUED, AWAITING_CHECKS, MERGEABLE, UNMERGEABLE, LOCKED), `head` the queue's merge_group commit once it is made and
 * `headAt` that commit's time.
 */
export async function mergeQueueEntry(repo, number, opts) {
  const d = await graphql(`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { mergeQueueEntry { state enqueuedAt headCommit { oid committedDate } } } } }`, { owner: repo.owner, name: repo.name, n: Number(number) }, opts);
  const e = d?.repository?.pullRequest?.mergeQueueEntry;
  return e ? { state: e.state ?? null, enqueuedAt: e.enqueuedAt ?? null, head: e.headCommit?.oid ?? null, headAt: e.headCommit?.committedDate ?? null } : null;
}

/**
 * The failed Actions runs the merge queue started for the PR since `since` (event `merge_group`), newest first:
 * `{id, sha, at, status, conclusion}`, `sha` the queue's merge_group commit. A run is the PR's when its branch is GitHub's
 * queue ref for it, `gh-readonly-queue/<base>/pr-<number>-<base sha>`. With `any`, runs of every status (one still
 * running when the queue dropped the PR on its first failed required job). Read with a token that reads Actions.
 */
export async function mergeGroupRuns(repo, number, base, since, opts, { any = false } = {}) {
  const created = since ? `&created=${encodeURIComponent(`>=${since}`)}` : "";
  const runs = (await rest(`repos/${repo.full}/actions/runs?event=merge_group${any ? "" : "&status=failure"}&exclude_pull_requests=true&per_page=100${created}`, { ...opts, paginate: true })) || [];
  const prefix = `gh-readonly-queue/${base}/pr-${Number(number)}-`;
  return runs
    .filter((r) => typeof r?.head_branch === "string" && r.head_branch.startsWith(prefix) && /^[0-9a-f]{40,64}$/.test(r.head_branch.slice(prefix.length)) && r.head_sha)
    .map((r) => ({ id: r.id, sha: r.head_sha, at: r.created_at ?? null, status: r.status ?? null, conclusion: r.conclusion ?? null }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * The branch as GitHub has it now: `{head, headAt}` its head commit and that commit's time, and `queued` how many PRs
 * wait in its merge queue (0 with no queue). One GraphQL read. Throws when the branch is not there.
 */
export async function branchState(repo, branch, opts) {
  const d = await graphql(`query($owner: String!, $name: String!, $ref: String!, $branch: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid ... on Commit { committedDate } } } mergeQueue(branch: $branch) { entries { totalCount } } } }`, { owner: repo.owner, name: repo.name, ref: `refs/heads/${branch}`, branch }, opts);
  const target = d?.repository?.ref?.target;
  if (!target?.oid) throw new Error(`the branch ${branch} could not be read`);
  return { head: target.oid, headAt: target.committedDate ?? null, queued: Number(d.repository.mergeQueue?.entries?.totalCount) || 0 };
}

/** Actions run `runId` itself (`status`, `updated_at`). Throws when it cannot be read (a 404 or 410: no such run now). */
export async function actionsRun(repo, runId, opts) {
  return rest(`repos/${repo.full}/actions/runs/${encodeURIComponent(runId)}`, opts);
}

/** The jobs of Actions run `runId`, their latest attempts, every page. Throws when they cannot be read. */
export async function runJobs(repo, runId, opts) {
  return (await rest(`repos/${repo.full}/actions/runs/${encodeURIComponent(runId)}/jobs?filter=latest&per_page=100`, { ...opts, paginate: true })) || [];
}

/**
 * `branch`'s merge queue now: `{base, entries}`, `base` the branch's head commit, `entries` its PRs in the queue's order
 * (`[{pr, head}]`, `head` the commit the queue merges for it). Every page (100 a page); none with no queue. Throws when
 * it cannot be read.
 */
export async function mergeQueueHeads(repo, branch, opts) {
  const out = [];
  let base = null;
  let after = null;
  for (;;) {
    const d = await graphql(`query($owner: String!, $name: String!, $branch: String!, $ref: String!, $after: String) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid } } mergeQueue(branch: $branch) { entries(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { position pullRequest { number } headCommit { oid } } } } } }`, { owner: repo.owner, name: repo.name, branch, ref: `refs/heads/${branch}`, after }, opts);
    base ??= d?.repository?.ref?.target?.oid ?? null;
    const got = d?.repository?.mergeQueue?.entries;
    for (const e of got?.nodes || []) if (e?.pullRequest?.number && e.headCommit?.oid) out.push({ pr: e.pullRequest.number, head: e.headCommit.oid, position: e.position ?? null });
    if (!got?.pageInfo?.hasNextPage || !got.pageInfo.endCursor) break;
    after = got.pageInfo.endCursor;
  }
  return { base, entries: out.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(({ pr, head }) => ({ pr, head })) };
}

/** Take the PR out of the merge queue (Factory's App; the timeline names it as the actor). */
export async function dequeuePr(repo, nodeId, opts) {
  await graphql(`mutation($id: ID!) { dequeuePullRequest(input: {id: $id}) { mergeQueueEntry { id } } }`, { id: nodeId }, opts);
}

/**
 * Whether CI began on `sha` (logic.mjs gateStarted): `gate` the required checks (requiredCheckSpecs, or bare names).
 * Reads its check runs, commit statuses and check suites (the App's checks and statuses read; no Actions read). A failed
 * read throws, so it never reads as "not started".
 */
export async function checksStarted(repo, sha, gate, opts) {
  const runs = await checkRuns(repo, sha, opts, { all: true });
  if (gateStarted(gate, { runs })) return true;
  const statuses = (await rest(`repos/${repo.full}/commits/${sha}/status`, opts))?.statuses || [];
  if (gateStarted(gate, { statuses })) return true;
  const suites = (await rest(`repos/${repo.full}/commits/${sha}/check-suites?per_page=100`, { ...opts, paginate: true })) || [];
  return gateStarted(gate, { suites });
}

/** A check run as logic.mjs queueHangs reads it (queueCommitChecks, awaitChecks' `progress`). */
const commitCheck = (r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion ?? null, started_at: r.started_at ?? null, completed_at: r.completed_at ?? null, app: r.app?.id ?? null });

/** A commit status as a check run: `in_progress` while pending, else completed, `success` or failed; from its creation. */
const statusRun = (x) => ({ id: x.id, name: x.context, status: x.state === "pending" ? "in_progress" : "completed", conclusion: x.state === "pending" ? null : x.state === "success" ? "success" : x.state, started_at: x.created_at ?? null, completed_at: x.state === "pending" ? null : (x.updated_at ?? x.created_at ?? null), details_url: x.target_url ?? null, commitStatus: true });

/**
 * The checks on a queue commit as logic.mjs queueHangs and hungOutcome read them: each check run `{id, name, status,
 * conclusion, started_at, completed_at, app}`
 * (GitHub's status: `queued`, `in_progress`, `completed`, ...; `app` its integration's id; an Actions run's id is its
 * job's) and each commit status, `in_progress` while pending, from its creation. A failed read throws, so it never reads
 * as "nothing running".
 */
export async function queueCommitChecks(repo, sha, opts) {
  const runs = (await checkRuns(repo, sha, opts, { all: true })).map(commitCheck);
  const st = await rest(`repos/${repo.full}/commits/${sha}/status`, opts);
  return [...runs, ...(st?.statuses || []).map(statusRun).map(commitCheck)];
}

/**
 * How long one step of one job took in the workflow's recent green runs on the default branch or in the merge queue
 * (logic.mjs STEP_BASELINE_RUNS of them), in ms: the baseline of a step's progress (#2683). `runId` is the run the job
 * belongs to; the step is matched by its job's name and its own, and only a step that succeeded counts. Reads Actions
 * (the job token's `actions: read`). `cache` keeps the workflow, its run list and each run's jobs for one pass or watch,
 * so a step's history is read once.
 */
export async function stepDurations(repo, { runId, jobName, stepName }, opts, cache = {}) {
  cache.workflow ??= new Map();
  cache.runs ??= new Map();
  cache.jobs ??= new Map();
  if (!cache.workflow.has(runId)) cache.workflow.set(runId, rest(`repos/${repo.full}/actions/runs/${runId}`, opts).then((r) => r?.workflow_id ?? null));
  const wf = await cache.workflow.get(runId);
  if (!wf) return [];
  cache.branch ??= getRepo(repo, opts).then((r) => r?.default_branch ?? null);
  const branch = await cache.branch;
  if (!cache.runs.has(wf))
    cache.runs.set(
      wf,
      rest(`repos/${repo.full}/actions/workflows/${wf}/runs?status=success&per_page=50`, opts).then((r) =>
        (r?.workflow_runs || []).filter((x) => x?.event === "merge_group" || (branch && x?.head_branch === branch)).slice(0, STEP_BASELINE_RUNS),
      ),
    );
  const runs = await cache.runs.get(wf);
  const out = [];
  await pooled(runs, 5, async (run) => {
    if (!cache.jobs.has(run.id)) cache.jobs.set(run.id, rest(`repos/${repo.full}/actions/runs/${run.id}/jobs?per_page=100`, opts).then((r) => r?.jobs || [], () => []));
    const step = ((await cache.jobs.get(run.id)).find((j) => j?.name === jobName)?.steps || []).find((x) => x?.name === stepName && x?.conclusion === "success");
    const ms = Date.parse(step?.completed_at) - Date.parse(step?.started_at);
    if (Number.isFinite(ms) && ms >= 0) out.push(ms);
  });
  return out;
}

/**
 * The merge queue's own check timeout on the default branch (`check_response_timeout_minutes` of an active ruleset's
 * merge_queue rule), or null when no such rule is readable.
 */
export async function queueCheckTimeout(repo, opts) {
  const branch = (await getRepo(repo, opts)).default_branch;
  for (const r of await listRulesets(repo, opts)) {
    if (r.target !== "branch" || r.enforcement !== "active") continue;
    const full = await rest(`repos/${repo.full}/rulesets/${r.id}`, opts).catch(() => null);
    const inc = full?.conditions?.ref_name?.include || [];
    if (!inc.some((i) => i === `refs/heads/${branch}` || i === "~DEFAULT_BRANCH")) continue;
    const m = Number((full.rules || []).find((rule) => rule.type === "merge_queue")?.parameters?.check_response_timeout_minutes);
    if (Number.isFinite(m) && m > 0) return m;
  }
  return null;
}

/**
 * The required checks on the default branch as `{name, app}`: an active ruleset's, else branch protection's. `app` is
 * the integration the check must come from (the ruleset's `integration_id`, protection's `app_id`), or null for any.
 */
export async function requiredCheckSpecs(repo, opts) {
  const branch = (await getRepo(repo, opts)).default_branch;
  const specs = [];
  const app = (id) => (Number.isInteger(id) && id > 0 ? id : null);
  for (const r of await listRulesets(repo, opts)) {
    if (r.target !== "branch" || r.enforcement !== "active") continue;
    const full = await rest(`repos/${repo.full}/rulesets/${r.id}`, opts).catch(() => null);
    const inc = full?.conditions?.ref_name?.include || [];
    if (!inc.some((i) => i === `refs/heads/${branch}` || i === "~DEFAULT_BRANCH")) continue;
    for (const rule of full.rules || []) if (rule.type === "required_status_checks") specs.push(...(rule.parameters?.required_status_checks || []).map((c) => ({ name: c.context, app: app(c.integration_id) })));
  }
  if (!specs.length) {
    const bp = await rest(`repos/${repo.full}/branches/${encodeURIComponent(branch)}/protection`, opts).catch(() => null);
    const rsc = bp?.required_status_checks;
    if (rsc?.checks?.length) specs.push(...rsc.checks.map((c) => ({ name: c.context, app: app(c.app_id) })));
    else specs.push(...(rsc?.contexts || []).map((name) => ({ name, app: null })));
  }
  const key = (s) => `${s.name}\0${s.app ?? ""}`;
  return [...new Map(specs.filter((s) => s.name).map((s) => [key(s), s])).values()];
}

/** The required checks' names on the default branch (requiredCheckSpecs). */
export async function requiredChecks(repo, opts) {
  return [...new Set((await requiredCheckSpecs(repo, opts)).map((s) => s.name))];
}

/** Whether any check-run or commit status on `sha` is still running (queued, in progress or pending). */
export async function checksRunning(repo, sha, opts) {
  const runs = await checkRuns(repo, sha, opts);
  if (runs.some((r) => r.status !== "completed")) return true;
  const st = await rest(`repos/${repo.full}/commits/${sha}/status`, opts);
  return (st?.statuses || []).some((x) => x.state === "pending");
}

/** The named checks on a commit, from its check-runs and its commit statuses (logic.mjs evaluateChecks). */
export async function checksOn(repo, sha, names, opts) {
  const runs = await checkRuns(repo, sha, opts);
  const st = await rest(`repos/${repo.full}/commits/${sha}/status`, opts);
  const statuses = (st?.statuses || []).map((x) => ({ name: x.context, id: x.id, started_at: x.updated_at, status: x.state === "pending" ? "in_progress" : "completed", conclusion: x.state === "success" ? "success" : x.state === "pending" ? null : "failure" }));
  return evaluateChecks(names, [...runs, ...statuses]);
}

/** One commit as the REST API shows it (parents, committer, signature verification). */
export async function getCommit(repo, sha, opts) {
  return rest(`repos/${repo.full}/commits/${sha}`, opts);
}

/** Whether `sha` is on the default branch (an ancestor of its tip, or the tip). */
export async function onDefaultBranch(repo, sha, opts) {
  const branch = (await getRepo(repo, opts)).default_branch;
  const c = await rest(`repos/${repo.full}/compare/${sha}...${encodeURIComponent(branch)}`, opts).catch(() => null);
  return c?.status === "identical" || c?.status === "ahead";
}

// ---------------------------------------------------------------- projects

const PROJECT_FIELDS = `
  id title number
  field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name color description } } }
`;

/** The board's title: one per repository, since org projects share one namespace. */
export const projectTitle = (repo) => `Factory: ${repo.name}`;

/**
 * The repository's Factory project, or null: by identity, the board whose node id the `project` setting holds
 * (`opts.project`, local mode's settings; else FACTORY_PROJECT, the workflow's env block on Actions), which setup records
 * as it makes the board, when that board is linked to this repository; with no id recorded, the board linked to the
 * repository titled exactly "Factory: <repo>" (projectTitle, the title setup gives it). A recorded id that names no board,
 * or one not linked to this repository, is no board: nothing else stands in.
 */
export async function findProject(repo, opts) {
  const id = String(opts?.project ?? process.env.FACTORY_PROJECT ?? "").trim();
  if (id) {
    // Only a board linked to this repository: a workflow copied from another repository names that one's board. Its
    // linked repositories are read page by page (100 a page) until this one shows or none are left.
    let after = null;
    let board = null;
    let rid = null;
    for (;;) {
      const byId = await graphql(`query($id: ID!, $owner: String!, $name: String!, $after: String) { node(id: $id) { ... on ProjectV2 { ${PROJECT_FIELDS} repositories(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } } } } repository(owner: $owner, name: $name) { id } }`, { id, owner: repo.owner, name: repo.name, after }, opts);
      rid ??= byId?.repository?.id ?? null;
      if (!byId?.node?.id || !rid) return null;
      const { repositories, ...fields } = byId.node;
      board ??= fields;
      if ((repositories?.nodes || []).some((r) => r?.id === rid)) return { ...board, repositoryId: rid };
      if (!repositories?.pageInfo?.hasNextPage || !repositories.pageInfo.endCursor) return null;
      after = repositories.pageInfo.endCursor;
    }
  }
  const data = await graphql(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id projectsV2(first: 20) { nodes { ${PROJECT_FIELDS} } } } }`,
    { owner: repo.owner, name: repo.name },
    opts,
  );
  const nodes = data?.repository?.projectsV2?.nodes || [];
  let project = nodes.find((p) => p.title === projectTitle(repo)) || null;
  // A repository's own list of linked projects can stay empty for a while after the link (seen on a new repository
  // for over an hour, while the project listed the repository): look the board up from its owner's side too.
  if (!project && data?.repository?.id) project = await ownerSideProject(repo, opts).catch(() => null);
  return project ? { ...project, repositoryId: data.repository.id } : null;
}

async function ownerSideProject(repo, opts) {
  const list = `projectsV2(first: 20, query: $q) { nodes { ${PROJECT_FIELDS} repositories(first: 50) { nodes { name owner { login } } } } }`;
  const data = await graphql(
    `query($owner: String!, $q: String!) { repositoryOwner(login: $owner) { ... on Organization { ${list} } ... on User { ${list} } } }`,
    { owner: repo.owner, q: projectTitle(repo) },
    opts,
  );
  const linked = (p) => (p.repositories?.nodes || []).some((r) => r.name.toLowerCase() === repo.name.toLowerCase() && r.owner?.login?.toLowerCase() === repo.owner.toLowerCase());
  const hit = (data?.repositoryOwner?.projectsV2?.nodes || []).find((p) => p.title === projectTitle(repo) && linked(p));
  if (!hit) return null;
  const { repositories, ...project } = hit;
  return project;
}

export async function repositoryNodeId(repo, opts) {
  const data = await graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id owner { id __typename } } }`, { owner: repo.owner, name: repo.name }, opts);
  return data.repository;
}

/** The project item for an issue, with its Status name, or null. */
export async function projectItem(project, repo, issueNumber, opts) {
  const data = await graphql(
    `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) { id projectItems(first: 20) { nodes { id project { id } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`,
    { owner: repo.owner, name: repo.name, n: Number(issueNumber) },
    opts,
  );
  const issue = data?.repository?.issue;
  if (!issue) return null;
  const item = (issue.projectItems?.nodes || []).find((i) => i.project?.id === project.id);
  return { issueId: issue.id, itemId: item?.id ?? null, status: item?.fieldValueByName?.name ?? null };
}

/** Statuses of many issues in one query (dispatch). Returns {number: status|null}. */
export async function projectStatuses(project, repo, numbers, opts) {
  const out = {};
  const chunk = 25;
  for (let i = 0; i < numbers.length; i += chunk) {
    const slice = numbers.slice(i, i + chunk);
    const fields = slice.map((n, j) => `i${j}: issue(number: ${n}) { number projectItems(first: 20) { nodes { project { id } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } }`).join("\n");
    const data = await graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, { owner: repo.owner, name: repo.name }, opts);
    for (const v of Object.values(data?.repository || {})) {
      if (!v?.number) continue;
      const item = (v.projectItems?.nodes || []).find((it) => it.project?.id === project.id);
      out[v.number] = item?.fieldValueByName?.name ?? null;
    }
  }
  return out;
}

/** Move an issue's card to a Status column, adding it to the project when absent. */
export async function moveCard(project, repo, issueNumber, status, opts) {
  if (!project) return false;
  const option = project.field?.options?.find((o) => o.name.toLowerCase() === status.toLowerCase());
  if (!option) throw new Error(`project has no Status option ${status}`);
  const item = await projectItem(project, repo, issueNumber, opts);
  if (!item) return false;
  let itemId = item.itemId;
  if (!itemId) {
    const added = await graphql(`mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: {projectId: $p, contentId: $c}) { item { id } } }`, { p: project.id, c: item.issueId }, opts);
    itemId = added.addProjectV2ItemById.item.id;
  }
  await graphql(
    `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i, fieldId: $f, value: {singleSelectOptionId: $o}}) { projectV2Item { id } } }`,
    { p: project.id, i: itemId, f: project.field.id, o: option.id },
    opts,
  );
  return true;
}

export const COLUMNS = ["Queued", "Running", "In review", "Blocked", "Done"];

/** Create the Factory project with the five Status options and link it to the repository. */
export async function createProject(repo, opts) {
  const { id: repositoryId, owner } = await repositoryNodeId(repo, opts);
  const created = await graphql(`mutation($o: ID!, $t: String!) { createProjectV2(input: {ownerId: $o, title: $t}) { projectV2 { id number } } }`, { o: owner.id, t: projectTitle(repo) }, opts);
  const project = created.createProjectV2.projectV2;
  await graphql(`mutation($p: ID!, $r: ID!) { linkProjectV2ToRepository(input: {projectId: $p, repositoryId: $r}) { repository { id } } }`, { p: project.id, r: repositoryId }, opts);
  // A new project already has a Status field with Todo/In Progress/Done; replace its options.
  const fields = await graphql(`query($p: ID!) { node(id: $p) { ... on ProjectV2 { field(name: "Status") { ... on ProjectV2SingleSelectField { id } } } } }`, { p: project.id }, opts);
  const fieldId = fields.node.field?.id;
  const colors = { Queued: "GRAY", Running: "BLUE", "In review": "YELLOW", Blocked: "RED", Done: "GREEN" };
  const options = COLUMNS.map((name) => `{name: "${name}", color: ${colors[name]}, description: ""}`).join(", ");
  if (fieldId) {
    // UpdateProjectV2FieldInput takes fieldId only (no projectId): the field already belongs to the project.
    await graphql(`mutation($f: ID!) { updateProjectV2Field(input: {fieldId: $f, singleSelectOptions: [${options}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { f: fieldId }, opts);
  } else {
    await graphql(`mutation($p: ID!) { createProjectV2Field(input: {projectId: $p, dataType: SINGLE_SELECT, name: "Status", singleSelectOptions: [${options}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { p: project.id }, opts);
  }
  return project;
}

// --------------------------------------------------------------- artifacts

/** An artifact never changes once uploaded: a long-lived dispatcher (factory serve) reads each one once. */
const usageCache = new Map();
const USAGE_DOWNLOADS = 8;

/**
 * Today's spend by runs that upload no usage artifact (local mode, any machine, a cloud sandbox): the spend lines in
 * the progress comments and a sandbox stage's vendor comments updated today, written by Factory or someone who can
 * push. Actions runs write none, so nothing here is counted twice with the artifacts.
 */
export async function localSpendToday(repo, { dateIso = new Date().toISOString().slice(0, 10), token } = {}) {
  // One paged read of the repository's comments updated today (issues and PRs alike), not one per Objective.
  const comments = (await rest(`repos/${repo.full}/issues/comments?since=${dateIso}T00:00:00Z&per_page=100`, { token, paginate: true })) || [];
  let usd = 0;
  for (const c of comments) {
    if (trustedAuthor(c) && /^<!-- factory:\d+:(?:progress|vendor):/.test(c.body || "") && String(c.updated_at || "").startsWith(dateIso)) usd += spendOf(c.body);
  }
  return usd;
}

/** Usage artifacts uploaded today (UTC), as parsed result.json records. */
export async function todaysUsage(repo, { prefix = "factory-usage-", token, dateIso = new Date().toISOString().slice(0, 10), download } = {}) {
  // The artifacts endpoint wraps each page as {total_count, artifacts}; rest's pagination returns the artifacts.
  const artifacts = (await rest(`repos/${repo.full}/actions/artifacts?per_page=100`, { token, paginate: true })) || [];
  // Names and run ids go to `gh` as arguments: only Factory's own artifact names and numeric ids.
  const today = artifacts.filter((a) => /^[A-Za-z0-9._-]+$/.test(a.name || "") && a.name.startsWith(prefix) && Number.isSafeInteger(a.workflow_run?.id) && !a.expired && String(a.created_at || "").startsWith(dateIso));
  // One download is about a second and a busy day has a hundred artifacts, so eight at a time. With a cloud sandbox
  // the dispatcher reads none of them (dispatch.mjs todaysSpend): each stage's dollars are in its spend line.
  const one = async (a) => {
    try {
      const rec = usageCache.has(a.id) ? usageCache.get(a.id) : await (download ?? downloadArtifactResult)(repo, a, token);
      if (!download) usageCache.set(a.id, rec);
      return rec ? { artifact: a.name, ...rec } : null;
    } catch (e) {
      return { artifact: a.name, usd: null, basis: `unreadable: ${e.message.slice(0, 120)}` };
    }
  };
  return (await pooled(today, USAGE_DOWNLOADS, one)).filter(Boolean);
}

/** One artifact's result.json; `gh run download` unpacks it, so nothing beyond gh is needed. */
async function downloadArtifactResult(repo, artifact, token) {
  const dir = mkdtempSync(join(tmpdir(), "factory-usage-"));
  try {
    await run("gh", ["run", "download", String(artifact.workflow_run?.id), "-n", artifact.name, "-D", dir, "-R", repo.full], { env: env(token), timeoutMs: 120_000 });
    const file = [join(dir, "result.json"), join(dir, "usage", "result.json")].find(existsSync);
    return file ? JSON.parse(readFileSync(file, "utf8")) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- jobs

/** The workflow file this run belongs to (GITHUB_WORKFLOW_REF), else factory.yml. */
export const workflowFile = (env = process.env) => /\/(\.github\/workflows\/([^@/]+))@/.exec(env.GITHUB_WORKFLOW_REF || "")?.[2] || "factory.yml";

/**
 * Issue numbers with a worker job (`work (<n>)`) not yet completed in any live run of the workflow. Needs actions: read.
 * Strict: a failed listing throws, never an empty set, since callers decide liveness on it (the dispatcher Blocks a
 * Running Objective with no live job; a failed read must leave it alone, not Block it as vanished).
 */
export async function activeWorkIssues(repo, opts) {
  return (await activeFactoryJobs(repo, opts, { strict: true })).work;
}

/**
 * The Objectives with a live Factory job, by kind: `work (N)` and `review (factory/N)` jobs not yet completed, and the
 * dispatcher's wakes queued or sleeping (`wake (<kind> <iso>)`, logic.mjs parseWake) as `wakes: [{kind, at, startedAt}]`.
 * `strict` throws on a failed read instead of treating it as "none running" (a caller that must fail safe).
 */
export async function activeFactoryJobs(repo, opts, { strict = false } = {}) {
  const out = { work: new Set(), review: new Set(), wakes: [] };
  const read = (path) => rest(path, opts).catch((e) => {
    if (strict) throw e;
    return null;
  });
  for (const status of ["in_progress", "queued", "waiting", "requested", "pending"]) {
    const runs = (await read(`repos/${repo.full}/actions/workflows/${workflowFile()}/runs?status=${status}&per_page=50`))?.workflow_runs || [];
    for (const run of runs) {
      const jobs = (await read(`repos/${repo.full}/actions/runs/${run.id}/jobs?per_page=100`))?.jobs || [];
      for (const j of jobs) {
        if (j.status === "completed") continue;
        const w = /^work \((\d+)\)$/.exec(j.name || "");
        if (w) out.work.add(Number(w[1]));
        const r = /^review \(factory\/(\d+)\)$/.exec(j.name || "");
        if (r) out.review.add(Number(r[1]));
        const wake = parseWake(j.name);
        if (wake) out.wakes.push({ ...wake, startedAt: j.status === "in_progress" ? (j.started_at ?? null) : null });
      }
    }
  }
  return out;
}

/**
 * When the issue's text last changed on its timeline: its latest rename, or the latest `labeled` or `unlabeled` event of a
 * label `labelled(name)` holds for (an Objective's harness and model labels, choice.mjs isChoiceLabel); null when none.
 */
export async function issueTextChangedAt(repo, number, opts, labelled = () => false) {
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  let last = null;
  for (const e of events) {
    const counts = e.event === "renamed" || ((e.event === "labeled" || e.event === "unlabeled") && labelled(e.label?.name));
    if (counts && (!last || Date.parse(e.created_at) > Date.parse(last))) last = e.created_at;
  }
  return last;
}

/** When `label` (one name, or any of several) was last applied (a human's recovery re-applies the Objective label), or null. */
export async function objectiveLabeledAt(repo, number, label, opts) {
  const names = [].concat(label);
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  let last = null;
  for (const e of events) if (e.event === "labeled" && names.includes(e.label?.name) && (!last || Date.parse(e.created_at) > Date.parse(last))) last = e.created_at;
  return last;
}

/**
 * Who last applied each of `names`, from the issue's timeline: {name: {at, actor}} (the actor as GitHub gives it), a name
 * with no `labeled` event left out. With `event` "unlabeled", who last removed each.
 */
export async function labelersOf(repo, number, names, opts, event = "labeled") {
  const want = new Set(names);
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  const out = {};
  for (const e of events) {
    const n = e.label?.name;
    if (e.event !== event || !want.has(n)) continue;
    if (!out[n] || Date.parse(e.created_at) > Date.parse(out[n].at)) out[n] = { at: e.created_at, actor: e.actor ?? null };
  }
  return out;
}

/** The issue's latest `labeled` event of `label`: {at, actor} (the actor as GitHub gives it), or null when it has none. */
export async function labeledBy(repo, number, label, opts) {
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  let last = null;
  for (const e of events) if (e.event === "labeled" && e.label?.name === label && (!last || Date.parse(e.created_at) > Date.parse(last.at))) last = { at: e.created_at, actor: e.actor ?? null };
  return last;
}

/** When `label` last came off the issue (its latest `unlabeled` event), or null when it never did. */
export async function labelRemovedAt(repo, number, label, opts) {
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  let last = null;
  for (const e of events) if (e.event === "unlabeled" && e.label?.name === label && (!last || Date.parse(e.created_at) > Date.parse(last))) last = e.created_at;
  return last;
}

/** When the issue last became Running (its `labeled factory:running` event), or null. */
export async function runningSince(repo, number, opts) {
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  let last = null;
  for (const e of events) if (e.event === "labeled" && e.label?.name === "factory:running") last = e.created_at;
  return last;
}

/** Whether an active ruleset puts a merge queue on the default branch. */
export async function hasMergeQueue(repo, opts) {
  const data = await getRepo(repo, opts);
  const branch = data.default_branch;
  for (const r of await listRulesets(repo, opts)) {
    if (r.target !== "branch" || r.enforcement !== "active") continue;
    const full = await rest(`repos/${repo.full}/rulesets/${r.id}`, opts).catch(() => null);
    const inc = full?.conditions?.ref_name?.include || [];
    if (!inc.some((i) => i === `refs/heads/${branch}` || i === "~DEFAULT_BRANCH")) continue;
    if ((full.rules || []).some((rule) => rule.type === "merge_queue")) return true;
  }
  return false;
}

// -------------------------------------------------------------- repo facts

export async function getRepo(repo, opts) {
  return rest(`repos/${repo.full}`, opts);
}

export async function listRulesets(repo, opts) {
  return (await rest(`repos/${repo.full}/rulesets?per_page=100`, opts)) || [];
}

/** Create or update the Factory ruleset on the default branch: merge queue (unless `queue: false`), required checks, no deletion/force push. */
export async function ensureRuleset(repo, { branch, checks, queue = true }, opts) {
  const existing = (await listRulesets(repo, opts)).find((r) => r.name === "factory");
  const rules = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ["squash"] } },
  ];
  if (queue) rules.push({ type: "merge_queue", parameters: { merge_method: "SQUASH", max_entries_to_build: 5, min_entries_to_merge: 1, max_entries_to_merge: 5, min_entries_to_merge_wait_minutes: 5, grouping_strategy: "ALLGREEN", check_response_timeout_minutes: 60 } });
  if (checks.length) rules.push({ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: checks.map((context) => ({ context })) } });
  const body = {
    name: "factory",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules,
  };
  if (existing) return rest(`repos/${repo.full}/rulesets/${existing.id}`, { ...opts, method: "PUT", body });
  return rest(`repos/${repo.full}/rulesets`, { ...opts, method: "POST", body });
}

/**
 * Learn the repository's writers (push or more; org members and owners included, whatever their membership's
 * visibility) so trustedAuthor can tell them apart from strangers. Once per process per repository; a failed read
 * leaves the association check alone, logged. True when a list read for this repository is in memory.
 */
const WRITERS_TTL_MS = 10 * 60_000;
const primed = new Map();
export async function primeWriters(repo, opts, { maintainers = null } = {}) {
  // Whether the writer list in memory is this repository's: a process serving several reads it again per repository.
  const same = writersRepo() === repo.full;
  if (maintainers) setMaintainers(repo.full, maintainers);
  if (!selfLogin()) await primeSelf(opts);
  // A long-lived loop (local serve) re-reads them, so access revoked meanwhile stops counting within minutes.
  // Fresh and for this repository: the list is one per process, so another repository's read never counts here.
  if (same && Date.now() - (primed.get(repo.full) ?? -Infinity) < WRITERS_TTL_MS) return true;
  try {
    const list = (await rest(`repos/${repo.full}/collaborators?affiliation=all&permission=push&per_page=100`, { ...opts, paginate: true })) || [];
    setWriters(repo.full, list.map((u) => u.login));
    primed.set(repo.full, Date.now());
    process.stdout.write(`[factory] ${list.length} writer(s) of ${repo.full} known\n`);
    return true;
  } catch (e) {
    // Not marked primed: the next call tries again. An earlier list of this repository's stays in use meanwhile.
    process.stdout.write(`[factory] writers of ${repo.full} could not be read (${e.status || String(e.message).slice(0, 80)}); trusting by author association only\n`);
    return same && primed.has(repo.full);
  }
}

/**
 * Learn the login this process writes as (logic.mjs setSelf), from its token's own identity and never from a comment:
 * `GET /user` for a person's token (local mode), else GraphQL's viewer (an installation token, as `<slug>[bot]`). On
 * Actions the TokenKeeper already set it from the App's own record when it minted the token. A failed read leaves it
 * unknown, logged; Factory then trusts markers by push access alone and Blocks where it must know its own records.
 */
export async function primeSelf(opts) {
  try {
    const u = await rest("user", opts);
    if (u?.login) setSelf(u.type === "Bot" && !u.login.endsWith("[bot]") ? `${u.login}[bot]` : u.login);
  } catch {
    try {
      const v = (await graphql("query { viewer { login __typename } }", {}, opts))?.viewer;
      if (v?.login) setSelf(v.__typename === "Bot" && !v.login.endsWith("[bot]") ? `${v.login}[bot]` : v.login);
    } catch (e) {
      process.stdout.write(`[factory] Factory's own login could not be read from its token (${String(e.message).slice(0, 80)}); its markers count by push access only\n`);
    }
  }
  return selfLogin();
}

export async function collaboratorPermission(repo, login, opts) {
  try {
    const d = await rest(`repos/${repo.full}/collaborators/${encodeURIComponent(login)}/permission`, opts);
    return d?.permission ?? null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
