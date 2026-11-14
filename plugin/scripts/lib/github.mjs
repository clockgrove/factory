// GitHub REST and GraphQL through `gh api`, with the token the caller sets in GH_TOKEN.
// Every write the plan routes through the App (push, PR, review request, card move,
// merge) goes through here with the App token in env; the job token is never passed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEP_BASELINE_RUNS, evaluateChecks, gateStarted, filesDiff, fitToFiles, isPlaceholder, isSelf, marker, parseWake, pooled, reviewBody, reviewComment, selfLogin, setMaintainers, setSelf, setWriters, spendOf, trustedAuthor, unpatchedFiles, writersRepo } from "./logic.mjs";
import { log, redactSecrets } from "./inputs.mjs";
import { exec } from "./proc.mjs";

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
 */
let LOGIN = undefined;
const tokenOf = (token) => {
  const t = typeof token === "function" ? token() : token;
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

async function call(url, { method = "GET", body, token, accept = "application/vnd.github+json", maxBytes = 0 }) {
  const t = tokenOf(token);
  const r = await fetch(url, {
    method,
    headers: {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clockgrove-factory",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    // Every request body: no held secret (a worker secret's value, inputs.mjs holdSecrets) is ever posted.
    body: requestBody(body),
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
 * error goes to the caller at once, as without retries. `sleep`, `now` and `random` (jitter); tests replace them.
 */
export const RETRY = { tries: 4, maxWaitMs: 90_000, baseMs: 2_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), random: Math.random };

/** Node fetch's connect-level failures: no byte of the request left this machine, so even a create may go again. */
const UNSENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const causeCode = (e) => {
  for (let c = e, i = 0; c && i < 4; c = c.cause, i += 1) if (typeof c.code === "string" && /^[A-Z0-9_]+$/.test(c.code)) return c.code;
  return "";
};

/**
 * Whether a REST call means the same when sent twice: a read; a PUT, PATCH or DELETE, which sets a state (except a
 * merge and an update-branch, which are actions). A POST creates something (a comment, a review, a PR, a label event,
 * a dispatch, a rerun) and is not.
 */
const repeatable = (method, path) => {
  const m = String(method).toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  if (m === "PUT" || m === "PATCH" || m === "DELETE") return !/\/(merge|update-branch)$/.test(String(path).split("?")[0]);
  return false;
};

/** Whether a failed request provably did nothing: it never left this machine, or GitHub's rate limit (403, 429) turned it away. */
const notDone = (e) => e?.unsent === true || (e?.rateLimited === true && (e.status === 403 || e.status === 429));

/**
 * Whether an answer is GitHub's rate limit: a 429, or a 403 with its signals (a spent quota, Retry-After, the secondary
 * limit's message). Any other status with those headers (a 5xx that asks for a wait, a 422 on the last quota point) is
 * no rate limit: GitHub may have done the request.
 */
const rateLimitOf = (status, headers, message) => status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /secondary rate limit/i.test(String(message || ""))));

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
 */
async function withRetry(what, attempt, again, { deadlineAt = Infinity, noRateWait = false } = {}) {
  const end = Math.min(RETRY.now() + RETRY.maxWaitMs, Number.isFinite(deadlineAt) ? deadlineAt : Infinity);
  for (let n = 1; ; n += 1) {
    let e;
    try {
      return await attempt(n);
    } catch (err) {
      e = err;
    }
    if (n >= RETRY.tries || !transientError(e) || (noRateWait && e.rateLimited) || (again.possible && !again.possible(e))) throw e;
    // GitHub's ask: its header, or the minute it documents for a rate limit that names none. Spread only upward.
    const asked = e.waitMs !== undefined || (e.rateLimited && e.status > 0);
    const base = e.waitMs ?? (asked ? 60_000 : RETRY.baseMs * 2 ** (n - 1));
    // The bound is held against the unspread wait: jitter never costs a retry, it is cut back to what is left instead.
    if (RETRY.now() + base > end) throw e;
    const wait = Math.min(jitter(base, asked), Math.max(base, end - RETRY.now()));
    const cause = e.transport ? `network${e.code ? ` (${e.code})` : ""}` : e.rateLimited ? `rate limited${e.status ? ` (HTTP ${e.status})` : ""}` : `HTTP ${e.status}`;
    log(`GitHub ${what}: ${cause}; try ${n + 1} of ${RETRY.tries} in ${Math.ceil(wait / 1000)} s`);
    await RETRY.sleep(wait);
    const go = await again(e);
    if (go && typeof go === "object") return { [LANDED]: go.value };
    if (!go) throw e;
  }
}

/** A fetch that got no answer, as a GitHubError: `transport`, its connect-level `code`, and whether it never left (`unsent`). */
function transportError(what, e) {
  const code = causeCode(e);
  const err = new GitHubError(`${what} failed: ${e.message}${code ? ` (${code})` : ""}`, 0, "", { transport: true });
  err.code = code;
  err.unsent = UNSENT.has(code);
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
  return again;
};

/**
 * REST call with Node's fetch and the token in memory: no token in any process environment or file. `body` is sent as
 * JSON; `paginate` follows the Link header and returns every page's items as one array (a page that is an object with
 * one array field, such as {total_count, artifacts}, contributes that array); `raw` is an Accept header whose text is
 * returned as is. Returns parsed JSON or null.
 *
 * A transient failure is sent again within RETRY's bound and before `deadlineAt` (ms) when the call may repeat
 * (repeatable); a create only as createAgain allows, with the caller's optional `landed`. A DELETE whose retry finds
 * nothing (404) after a transient failure is done: the first try removed it. `noRateWait`: a rate limit is thrown at once,
 * classified (`e.rateLimited`), for a caller that handles it itself (the dispatcher's next tick, a five-minute launch job).
 */
export async function rest(path, { method = "GET", body, token, paginate = false, raw = false, maxBytes = 0, deadlineAt = Infinity, landed = null, noRateWait = false } = {}) {
  let url = /^https?:/.test(path) ? path : `${API()}/${path.replace(/^\//, "")}`;
  const accept = raw ? raw.replace(/^Accept:\s*/i, "") : "application/vnd.github+json";
  const again = repeatable(method, path) ? async () => true : createAgain(landed);
  const one = async (n) => {
    let res;
    try {
      res = await call(url, { method, body, token, accept, maxBytes: raw ? maxBytes : 0 });
    } catch (e) {
      throw transportError(`${method} ${path}`, e);
    }
    const { r, text } = res;
    if (r.ok) return { r, text };
    if (method === "DELETE" && r.status === 404 && n > 1) return { r, text: "" };
    let msg = text.slice(0, 500);
    try {
      msg = JSON.parse(text).message || msg;
    } catch {
      // not JSON
    }
    const rateLimited = rateLimitOf(r.status, r.headers, msg);
    const err = new GitHubError(`${method} ${path} failed (${r.status}): ${msg}`, r.status, text, { rateLimited });
    const asked = transientError(err) ? askedWaitMs(r.headers, RETRY.now()) : null;
    if (asked !== null) err.waitMs = asked;
    throw err;
  };
  const pages = [];
  for (;;) {
    const res = await withRetry(`${method} ${String(path).split("?")[0]}`, one, again, { deadlineAt, noRateWait });
    // A create the caller's `landed` found: its value is the answer.
    if (LANDED in res) return res[LANDED];
    const { r, text } = res;
    if (raw) return text;
    const data = text.trim() ? JSON.parse(text) : null;
    if (!paginate) return data;
    pages.push(data);
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") || "")?.[1];
    if (!next) break;
    url = next;
  }
  return pages.flatMap((p) => (Array.isArray(p) ? p : p && typeof p === "object" ? Object.values(p).find(Array.isArray) || [p] : []));
}

/** Whether a GraphQL document is a mutation (its first operation keyword, comments aside): a create, never resent blindly. */
const isMutation = (query) => /^mutation\b/.test(String(query).replace(/#[^\n]*/g, "").trim());

/**
 * GraphQL call with fetch; `variables` are passed as JSON. A query is retried like a REST read; a mutation like a
 * create (createAgain, with the caller's optional `landed`). `deadlineAt` and `noRateWait` as for rest.
 */
export async function graphql(query, variables = {}, { token, deadlineAt = Infinity, landed = null, noRateWait = false } = {}) {
  const url = process.env.GITHUB_GRAPHQL_URL || `${API()}/graphql`;
  const one = async () => {
    let res;
    try {
      res = await call(url, { method: "POST", body: { query, variables }, token });
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
      const rateLimited = rateLimitOf(r.status, r.headers, data?.message);
      const err = new GitHubError(`graphql failed (${r.status}): ${(data?.message || text).slice(0, 300)}`, r.status, text, { rateLimited });
      const asked = transientError(err) ? askedWaitMs(r.headers, RETRY.now()) : null;
      if (asked !== null) err.waitMs = asked;
      throw err;
    }
    if (data?.errors?.length) {
      const err = new GitHubError(`graphql: ${data.errors.map((e) => e.message).join("; ")}`, 0, data, { rateLimited: data.errors.some((e) => e?.type === "RATE_LIMITED") });
      // GitHub's RATE_LIMITED answer is a refusal: the operation did not run.
      if (err.rateLimited) {
        err.unsent = true;
        const asked = askedWaitMs(r.headers, RETRY.now());
        if (asked !== null) err.waitMs = asked;
      }
      throw err;
    }
    return { data: data?.data };
  };
  const again = isMutation(query) ? createAgain(landed) : async () => true;
  const res = await withRetry("graphql", one, again, { deadlineAt, noRateWait });
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
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
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

export async function listComments(repo, number, opts) {
  return (await rest(`repos/${repo.full}/issues/${number}/comments?per_page=100`, { ...opts, paginate: true })) || [];
}

/**
 * Post a comment, or update the one carrying `marker` when it exists (idempotent on rerun). `head`: Factory's own text
 * after the marker on its first line (the plan comment's record, handoff.mjs planTextMarker); `keepHead` keeps the one an
 * existing comment has instead.
 */
export async function upsertComment(repo, number, marker, body, opts, { head = "", keepHead = false } = {}) {
  // Only Factory's own comment, the marker on its first line, is ours to edit: anyone can paste the marker into theirs.
  // Before Factory knows its login (a failed read), one by someone who can push is.
  const ours = (c) => (selfLogin() ? isSelf(c) : trustedAuthor(c)) && (c.body || "").startsWith(marker);
  const existing = (await listComments(repo, number, opts)).find(ours);
  // keepHead: the head the comment has now stays (a writer that knows none never erases one).
  if (keepHead && existing) head = /^[^\n]*/.exec(existing.body)[0].slice(marker.length).replace(/\r$/, "");
  const text = `${marker}${head}\n${body}`;
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
 * Resolve the review threads Factory itself opened (the root comment belongs to the review
 * carrying marker(issue, "review")) once they are answered: a reply exists, or the root is
 * Factory's placeholder. Identified by Factory's own marker and a trusted author (trustedAuthor). GraphQL names a Bot
 * without the "[bot]" suffix REST adds.
 * Returns the number resolved.
 */
export async function resolveFactoryThreads(repo, number, issue, opts) {
  const data = await graphql(
    `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 50) { nodes { body pullRequestReview { body authorAssociation author { __typename login } } } } } } } } }`,
    { owner: repo.owner, name: repo.name, n: Number(number) },
    opts,
  );
  const threads = data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  const mark = marker(issue, "review");
  let resolved = 0;
  for (const t of threads) {
    if (t.isResolved) continue;
    const comments = t.comments?.nodes || [];
    const root = comments[0];
    const review = root?.pullRequestReview;
    // GraphQL names a Bot without REST's "[bot]" suffix.
    const login = review?.author?.__typename === "Bot" ? `${review.author.login}[bot]` : review?.author?.login;
    if (!root || !String(review?.body || "").includes(mark) || !trustedAuthor({ user: { type: review?.author?.__typename, login }, author_association: review?.authorAssociation })) continue;
    const answered = comments.length > 1 || isPlaceholder(root.body);
    if (!answered) continue;
    await graphql(`mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`, { id: t.id }, opts);
    resolved += 1;
  }
  return resolved;
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
 * About `chars` of a cleaned job log: the runner's own error annotations mark where the job failed, and the window
 * around them beats the tail (post-job cleanup); without one, the tail.
 */
export function logWindow(text, chars = 4000) {
  const first = text.indexOf("##[error]");
  if (first === -1) return text.slice(-chars);
  const last = text.lastIndexOf("##[error]");
  return text.slice(Math.max(0, first - Math.round(chars * 0.75)), Math.min(text.length, last + Math.round(chars * 0.25)));
}

/** The most of one job log Factory holds: past it the head is cut while reading and the end kept. */
export const JOB_LOG_CAP = 8 * 1024 * 1024;
// A finished job's log never changes: triage and the fix pass's detail read each one once.
const LOGS = new Map();

/**
 * An Actions job's whole log (a check-run's id is the job's id) up to JOB_LOG_CAP bytes, its end kept. The red's own
 * jobs (at most MAX_JOBS, read by triage and again by the fix pass's detail) are kept; `cache: false` for a log read once.
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

/** The window of an Actions job's log around its failure (logWindow); empty when unavailable. */
export async function jobLogTail(repo, jobId, opts, chars = 4000) {
  try {
    return logWindow(cleanLog(await jobLog(repo, jobId, opts)), chars);
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
 * the wait unfinished.
 */
/** A check run as awaitChecks returns it (and checksNotStarted reads it). */
const runShape = (r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion ?? null, suite: r.check_suite?.id ?? null, app: r.app?.slug ?? null, started_at: r.started_at ?? null });

export async function awaitChecks(repo, sha, names, { token, timeoutMs = 60 * 60_000, appearMs = 15 * 60_000, pollMs = 60_000, maxPollMs = pollMs, onPoll = null, conflicted = null, ended = null, ignoreIds = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const started = Date.now();
  // The pause between reads: `pollMs`, doubling after each read up to `maxPollMs` (a backoff), never past the timeout.
  let pause = pollMs;
  let runs = [];
  let state = null;
  let conflict = false;
  // Whether a read of the check runs has succeeded since the wait began.
  let readOnce = false;
  for (;;) {
    // A failed read is no reading: once one has succeeded, the last good one stands and the wait goes on to its own
    // deadline; with none yet, the wait ends at `appearMs` as for nothing ran.
    const read = await checkRuns(repo, sha, { token }).catch(() => null);
    if (read) {
      runs = read.filter((r) => !ignoreIds?.has(r.id));
      readOnce = true;
    }
    state = evaluateChecks(names, runs);
    if (state.done) break;
    if (conflicted && (await conflicted().catch(() => false))) {
      conflict = true;
      break;
    }
    const elapsed = Date.now() - started;
    if ((read || !readOnce) && state.missing.length && elapsed > appearMs && !state.pending.length && runs.length === 0) break; // nothing ran for this head
    // A required check with no run while others reported (with none, appearMs above ends the wait), and `ended` (async,
    // optional, given the runs as returned below) says it will get none: its own workflow runs ended before their jobs
    // ran. The wait ends at once, unfinished.
    if (read && state.missing.length && runs.length > 0 && ended && (await ended(runs.map(runShape)).catch(() => false))) break;
    if (elapsed > timeoutMs) break;
    if (onPoll) await onPoll(state, Math.round(elapsed / 60000));
    await sleep(Math.max(1, Math.min(pause, timeoutMs - elapsed + 1)));
    pause = Math.min(pause * 2, Math.max(pollMs, maxPollMs));
  }
  const timedOut = !state.done && !conflict;
  const failedRuns = runs.filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion));
  const parts = [];
  for (const r of failedRuns.slice(0, 4)) parts.push(`--- ${r.name}: ${r.conclusion}\n${await jobLogTail(repo, r.id, { token })}`);
  if (timedOut) parts.unshift(`required check(s) not finished after ${Math.round((Date.now() - started) / 60000)} min: missing ${state.missing.join(", ") || "none"}; pending ${state.pending.join(", ") || "none"}`);
  if (conflict) parts.unshift("the PR conflicts with its base branch: GitHub starts no required-check run for it");
  // `runs` and `minutes`: what a wait that timed out with nothing failed is read against (triage.mjs checksNotStarted).
  return { green: state.done && state.green, checks: state, output: parts.join("\n"), timedOut, conflict, minutes: Math.round((Date.now() - started) / 60000), runs: runs.map(runShape), failedNames: state.failed.map((f) => f.name), failedRuns: failedRuns.map((r) => ({ id: r.id, name: r.name, conclusion: r.conclusion, suite: r.check_suite?.id ?? null, started_at: r.started_at ?? null, completed_at: r.completed_at ?? null })) };
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
 * `{id, sha, at}`, `sha` the queue's merge_group commit. A run is the PR's when its branch is GitHub's queue ref for it,
 * `gh-readonly-queue/<base>/pr-<number>-<base sha>`. Read with a token that reads Actions.
 */
export async function mergeGroupRuns(repo, number, base, since, opts) {
  const created = since ? `&created=${encodeURIComponent(`>=${since}`)}` : "";
  const runs = (await rest(`repos/${repo.full}/actions/runs?event=merge_group&status=failure&exclude_pull_requests=true&per_page=100${created}`, { ...opts, paginate: true })) || [];
  const prefix = `gh-readonly-queue/${base}/pr-${Number(number)}-`;
  return runs
    .filter((r) => typeof r?.head_branch === "string" && r.head_branch.startsWith(prefix) && /^[0-9a-f]{40,64}$/.test(r.head_branch.slice(prefix.length)) && r.head_sha)
    .map((r) => ({ id: r.id, sha: r.head_sha, at: r.created_at ?? null }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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

/**
 * The checks on a queue commit as logic.mjs queueHangs reads them: each check run `{id, name, status, started_at, app}`
 * (GitHub's status: `queued`, `in_progress`, `completed`, ...; `app` its integration's id; an Actions run's id is its
 * job's) and each commit status, `in_progress` while pending, from its creation. A failed read throws, so it never reads
 * as "nothing running".
 */
export async function queueCommitChecks(repo, sha, opts) {
  const runs = (await checkRuns(repo, sha, opts, { all: true })).map((r) => ({ id: r.id, name: r.name, status: r.status, started_at: r.started_at ?? null, app: r.app?.id ?? null }));
  const st = await rest(`repos/${repo.full}/commits/${sha}/status`, opts);
  const statuses = (st?.statuses || []).map((x) => ({ id: x.id, name: x.context, status: x.state === "pending" ? "in_progress" : "completed", started_at: x.created_at ?? null }));
  return [...runs, ...statuses];
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

/** The repository's Factory project (title "Factory: <repo>", "Factory", else a linked project with a Queued column), or null. */
export async function findProject(repo, opts) {
  const data = await graphql(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id projectsV2(first: 20) { nodes { ${PROJECT_FIELDS} } } } }`,
    { owner: repo.owner, name: repo.name },
    opts,
  );
  const nodes = data?.repository?.projectsV2?.nodes || [];
  let project = nodes.find((p) => p.title === projectTitle(repo)) || nodes.find((p) => p.title === "Factory") || nodes.find((p) => p.field?.options?.some((o) => o.name === "Queued")) || null;
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
 * with no `labeled` event left out.
 */
export async function labelersOf(repo, number, names, opts) {
  const want = new Set(names);
  const events = (await rest(`repos/${repo.full}/issues/${number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  const out = {};
  for (const e of events) {
    const n = e.label?.name;
    if (e.event !== "labeled" || !want.has(n)) continue;
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
