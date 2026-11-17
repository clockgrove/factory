// Normalize each harness's headless output into one usage record:
//   {harness, model, usd, usdUnknown?, usdUnknownWhy?, tokens: {input, output, cached}, basis, started, ended,
//    sessionId, subtype, ok, error, turns}
// `basis` says where the dollars came from, so the scorecard shows it. A count a harness does not report is null, never
// zero. Dollars are real or unknown (UNKNOWN_WHY, below), never an estimate.


import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Codex prices, USD per million tokens: the one table (codex-prices.json beside this file), which the bench reads too.
 * Codex reports tokens, not dollars, so the worker prices them here; the bench re-prices from the same file. The table
 * records its date and sources. Unknown models give usd: null and basis "unknown: no price for <model>"; a run that
 * reported no tokens at all (no turn completed) gives CODEX_NO_TOKENS instead, whatever the model.
 */
export const CODEX_PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "codex-prices.json"), "utf8"));

/**
 * Unknown spend (#478, #483). Every dollar figure Pendulum records, caps on or reports is real: a figure the harness or
 * vendor reports (Claude Code's total_cost_usd, Copilot's AI credits, the AI Gateway's cost), or API-reported token
 * counts at the vendor's published per-token rate (the Codex price table). Spend with no such figure is unknown: never
 * $0, never a guess, never a bound. One shape carries it, on a pass's record and on every total made from records:
 * - `usd`: the known dollars (the sum of what was reported), or null when nothing was;
 * - `usdUnknown`: how many runs in the figure have spend that was not reported (absent or 0: none). A pass record counts
 *   itself once; a total adds its parts' counts (unknownRuns). A run with `usd` set and `usdUnknown` too reported part
 *   of its spend (a Codex turn that failed after others completed, a relayed key call the gateway never priced);
 * - `usdUnknownWhy`: why, as codes from UNKNOWN_WHY (a closed list; a total keeps each code once).
 * Caps compare the known dollars only (logic.mjs sumSpend), and a stage with unknown spend goes on: a cap can be passed
 * by spend that was never reported. Displays say "plus N runs of unknown cost" (unknownText), never a number for it.
 */
export const UNKNOWN_WHY = {
  // The pass ended before its harness reported a cost: killed (the wall clock, the hung check, the stage's end or stop),
  // crashed or cut off. Claude Code printed no result line, Codex no turn.completed.
  unreported: "the run ended before its harness reported its cost",
  // Claude Code's result was an error with total_cost_usd 0 after its stream reported tokens: a crashed session's final
  // result can carry zeroed totals.
  zeroed: "Claude Code's error result carried a zeroed cost after its stream reported tokens",
  // A resumed session whose reported total is no running total: Claude Code before 2.1.277 (or one that named no
  // version), whose totals may restart at zero on resume, or any harness's total below the one already counted.
  "resumed-total": "a resumed session's reported total is no running total (Claude Code before 2.1.277, or a total below the one already counted)",
  // A Codex model with no row in the price table, or no model named: its tokens have no published rate here.
  "no-price": "the Codex model has no row in the price table",
  // A Codex model whose price-table row is a promotional rate that had ended when the run did (codexRow, `until`).
  "price-ended": "the Codex model's promotional rate in the price table had ended",
  // A Codex run whose input passed the long-context threshold and whose requests' sizes could not be read from its
  // rollout: which of its tokens are at the long-context rate is not known (rolloutLong).
  "long-context": "the Codex run passed the long-context threshold and its requests' sizes could not be read",
  // Codex reported a failed request (a stream `error` or `turn.failed`): the provider may have billed tokens Codex never reports.
  "failed-request": "Codex reported a failed request whose tokens it never reports",
  // Codex sub-agent threads that could not be read, or whose model has no price.
  "sub-agent": "a Codex sub-agent thread could not be read or priced",
  // Copilot reported no AI credits, or reported them partial, pending, unavailable, negative, or zero for a run that used tokens.
  credits: "Copilot did not report the run's AI credits in full",
  // Calls through the relayed AI Gateway key whose cost the gateway never reported (gateway-relay.mjs).
  relay: "calls through the relayed gateway key whose cost the gateway did not report",
  // A cloud sandbox's usage the vendor did not report (adapters/sandbox.mjs stageVendorCost).
  sandbox: "the sandbox vendor did not report the stage's usage",
  // The scorer's: a usage record from before records named their progress comment, beside a comment of its stage with
  // dollars that no record names; it may be that comment's stage, so its figure is not added to the comment's
  // (bench objective.mjs withLines).
  unmatched: "a usage record that names no progress comment, beside one of its stage that may be the same stage",
};

/** `rec` marked as having spend that was not reported, for `why` (an UNKNOWN_WHY code); in place. `usd` stays what was reported. */
export function markUnknown(rec, why) {
  if (!rec) return rec;
  if (!Object.hasOwn(UNKNOWN_WHY, why)) throw new Error(`unknown-spend code ${why} is not in UNKNOWN_WHY`);
  rec.usdUnknown = Math.max(1, Number.isInteger(rec.usdUnknown) ? rec.usdUnknown : 0);
  rec.usdUnknownWhy = [...new Set([...(Array.isArray(rec.usdUnknownWhy) ? rec.usdUnknownWhy : []), why])];
  return rec;
}

/**
 * How many runs of unknown cost `rec` holds: its `usdUnknown`; else 1 for a record that ran with no dollar figure (a
 * site that did not mark it is still never read as $0); 0 for one that never ran (`noRun`, or a stage's result.json
 * with `runs: 0`).
 */
export function unknownRuns(rec) {
  if (!rec || typeof rec !== "object") return 0;
  if (Number.isInteger(rec.usdUnknown) && rec.usdUnknown > 0) return rec.usdUnknown;
  if (rec.noRun || rec.runs === 0) return 0;
  return typeof rec.usd === "number" && Number.isFinite(rec.usd) ? 0 : 1;
}

/** The unknown-spend fields of a total of `records` (`{usdUnknown, usdUnknownWhy}`, or {} when all is known), to spread into it. */
export function unknownOf(records) {
  const list = (records || []).filter(Boolean);
  const n = list.reduce((s, r) => s + unknownRuns(r), 0);
  if (!n) return {};
  const why = [...new Set(list.flatMap((r) => (unknownRuns(r) ? (Array.isArray(r.usdUnknownWhy) && r.usdUnknownWhy.length ? r.usdUnknownWhy : ["unreported"]) : [])))].filter((w) => Object.hasOwn(UNKNOWN_WHY, w));
  return { usdUnknown: n, usdUnknownWhy: why };
}

/** " plus 2 runs of unknown cost" for `n` runs (unknownRuns), "" for none: what follows a known figure wherever it is shown. */
export const unknownText = (n) => (Number.isInteger(n) && n > 0 ? ` plus ${n} run${n === 1 ? "" : "s"} of unknown cost` : "");

/** A model id without its provider prefix: `openai/gpt-6.1-sol` (the AI Gateway's form) is `gpt-6.1-sol`. */
export const bareModel = (model) => String(model ?? "").replace(/^[A-Za-z0-9._-]+\//, "");

const isRate = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const validRates = (r) => !!r && typeof r === "object" && [r.input, r.cached, r.output].every(isRate) && (r.write === undefined || isRate(r.write));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The first moment a row's promotional rate no longer applies: the start (UTC) of its `until` day; null for a row with none. */
export const rateEnds = (p) => (p && typeof p.until === "string" && DAY.test(p.until) ? Date.parse(`${p.until}T00:00:00Z`) : null);

/**
 * The table's row for `model`: `{rate, id, why}`. `rate` is the row (null when there is none to price at), `id` the row's
 * model, `why` the UNKNOWN_WHY code when `rate` is null. A model matches by its exact id after any provider prefix, that
 * id plus a dated snapshot suffix (`gpt-5.5-2026-04-23`), or an alias the table records as OpenAI documents it (`aliases`:
 * `gpt-5.6` routes to `gpt-5.6-sol`). Nothing else matches, so `gpt-5-mini` never takes `gpt-5`'s rates: an unlisted
 * model is of unknown cost (`no-price`), not mispriced. A row with `until` is a promotional rate, which prices `at` (a
 * Date, ISO time or epoch ms; now when omitted) only before that day; at or after it, or with `at` null (a record that
 * names no time), the model is of unknown cost (`price-ended`).
 */
export function codexRow(table, model, { at } = {}) {
  const asked = bareModel(model);
  const none = { rate: null, id: asked || null, why: "no-price" };
  if (!asked || !table?.perMillion) return none;
  const aliases = table.aliases && typeof table.aliases === "object" ? table.aliases : {};
  const id = Object.hasOwn(aliases, asked) && typeof aliases[asked] === "string" ? aliases[asked] : asked;
  const snapshot = id.match(/^(.+)-\d{4}-\d{2}-\d{2}$/)?.[1];
  const key = Object.hasOwn(table.perMillion, id) ? id : snapshot && Object.hasOwn(table.perMillion, snapshot) ? snapshot : null;
  const p = key ? table.perMillion[key] : null;
  if (!validRates(p) || (p.long !== undefined && !validRates(p.long)) || (p.until !== undefined && rateEnds(p) === null)) return none;
  const ends = rateEnds(p);
  if (ends !== null) {
    const when = at === undefined ? Date.now() : at === null ? NaN : new Date(at).getTime();
    if (!(when < ends)) return { rate: null, id: key, why: "price-ended" };
  }
  return { rate: p, id: key, why: null };
}

/** The table's rates for `model` (codexRow), or null when it has none to price at. */
export const codexRate = (table, model, opts = {}) => codexRow(table, model, opts).rate;

const TOKEN_KEYS = ["input", "cached", "written", "output"];
const ZERO = Object.freeze({ input: 0, cached: 0, written: 0, output: 0 });

/**
 * The part of `tokens` from requests over `above` input tokens (the long-context tier), or null when it is not known.
 * `tokens.long` holds it when the run's input passed `above` (parseCodex reads it per request from the rollout; null
 * when it could not); a figure whose input is at most `above` has none, since no one request in it can be larger.
 */
export function longShare(tokens, above) {
  if (!Number.isFinite(above)) return null;
  const l = tokens?.long;
  if (l && typeof l === "object") return TOKEN_KEYS.every((k) => isRate(l[k]) && l[k] <= (tokens[k] ?? 0)) ? l : null;
  return (tokens?.input ?? 0) <= above ? ZERO : null;
}

/** `tokens` with its long-context share `long` (longShare: an object or null), kept only when its input passes `above`. */
export function withLong(tokens, long, above) {
  const out = { ...tokens };
  delete out.long;
  if (Number.isFinite(above) && (out.input ?? 0) > above) out.long = long ? Object.fromEntries(TOKEN_KEYS.map((k) => [k, long[k]])) : null;
  return out;
}

/** Whether `tokens` is a Codex running total a pass reported (a turn completed): its input and output are counts. */
export const runningTokens = (tokens) => !!tokens && isRate(tokens.input) && isRate(tokens.output);

/** Long-context shares added (`sign` 1) or taken away (-1, never below zero); null when any is unknown. */
export function sumLong(shares, sign = 1) {
  if (shares.some((s) => !s)) return null;
  return Object.fromEntries(TOKEN_KEYS.map((k) => [k, Math.max(0, shares.slice(1).reduce((n, s) => n + sign * s[k], shares[0]?.[k] ?? 0))]));
}

/**
 * A Codex thread's requests from its rollout's `token_count` events, in order (`counts`, each `{total, last}` in Pendulum's
 * token shape: the thread's running total and the request just answered). An event that repeats the total before it
 * (a rate-limit update) is no request. `{base, end, long}`: the total before the first request read, the last total, and
 * the part of the requests read that came from requests over `above` input tokens (every token of such a request is at
 * the long-context rate). Null when a request names no `last_token_usage` or the requests do not add up to the totals.
 */
export function rolloutRequests(counts, above) {
  const seen = (counts || []).filter((c, i, all) => i === 0 || TOKEN_KEYS.some((k) => c.total[k] !== all[i - 1].total[k]));
  if (!seen.length || !Number.isFinite(above) || seen.some((c) => !c.last)) return null;
  const base = Object.fromEntries(TOKEN_KEYS.map((k) => [k, seen[0].total[k] - seen[0].last[k]]));
  const end = seen.at(-1).total;
  const sum = (list, k) => list.reduce((n, c) => n + c.last[k], 0);
  if (TOKEN_KEYS.some((k) => base[k] < 0 || base[k] + sum(seen, k) !== end[k])) return null;
  const over = seen.filter((c) => c.last.input > above);
  return { base, end, long: Object.fromEntries(TOKEN_KEYS.map((k) => [k, sum(over, k)])) };
}

/** A rollout `token_count` usage in Pendulum's token shape; a missing or negative count is 0. */
export const rolloutUsage = (u) => ({ input: isRate(u?.input_tokens) ? u.input_tokens : 0, cached: isRate(u?.cached_input_tokens) ? u.cached_input_tokens : 0, written: isRate(u?.cache_write_input_tokens) ? u.cache_write_input_tokens : 0, output: isRate(u?.output_tokens) ? u.output_tokens : 0 });

/** The `{total, last}` of each `token_count` event in rollout text (any other line is skipped). */
export function rolloutCounts(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.includes('"token_count"')) continue;
    const p = jsonLines(line)[0]?.payload;
    if (p?.type === "token_count" && p.info?.total_token_usage) out.push({ total: rolloutUsage(p.info.total_token_usage), last: p.info.last_token_usage ? rolloutUsage(p.info.last_token_usage) : null });
  }
  return out;
}

/**
 * A Codex run's long-context share (longShare's shape) from its thread's rollout `text`, for `tokens`, the running total
 * its stream reported; null when it cannot be read exactly: no rollout, a request with no size, a last total other than
 * the stream's, or requests before the rollout's first that together passed `above` (any one of them could have).
 */
export function rolloutLong(text, tokens, above) {
  const r = rolloutRequests(rolloutCounts(text), above);
  if (!r || TOKEN_KEYS.some((k) => r.end[k] !== (tokens?.[k] ?? 0)) || r.base.input > above) return null;
  return r.long;
}

/**
 * USD for Codex `tokens` at `table`'s rates, rounded to 1/100 cent, with why it is null (`{usd, why}`, `why` an
 * UNKNOWN_WHY code, or null when nothing was reported). `input` includes the cached and the written tokens (Codex's
 * input_tokens counts both): the cached part at the cached rate, the written part (cache_write_input_tokens, 30-minute
 * writes) at the write rate, or the input rate for a model with none. For a model with a long-context tier (`long`), the
 * tokens of requests over the table's `longContextAbove` (longShare) are at those rates; when that share is not known
 * the dollars are unknown (`long-context`). `at` dates the spend for a promotional rate (codexRow).
 */
export function codexPrice(table, model, tokens, { at } = {}) {
  if (!tokens || (tokens.input == null && tokens.output == null)) return { usd: null, why: null }; // nothing reported is unknown, not free
  const { rate: p, why } = codexRow(table, model, { at });
  if (!p) return { usd: null, why };
  const long = p.long ? longShare(tokens, table.longContextAbove) : ZERO;
  if (!long) return { usd: null, why: "long-context" };
  const cost = (t, r) => {
    const cached = t.cached ?? 0;
    const written = t.written ?? 0;
    const uncached = Math.max(0, (t.input ?? 0) - cached - written);
    return uncached * r.input + cached * r.cached + written * (r.write ?? r.input) + (t.output ?? 0) * r.output;
  };
  const short = Object.fromEntries(TOKEN_KEYS.map((k) => [k, Math.max(0, (tokens[k] ?? 0) - long[k])]));
  const usd = cost(short, p) + (p.long ? cost(long, p.long) : 0);
  return { usd: Math.round((usd / 1e6) * 10000) / 10000, why: null };
}

/** USD for Codex `tokens` at `table`'s rates (codexPrice), or null when they cannot be priced. */
export const priceTokens = (table, model, tokens, opts = {}) => codexPrice(table, model, tokens, opts).usd;

/**
 * A Codex stage's dollars from its usage record at `table`'s rates: its sub-agent threads (`subAgents`, each run's own
 * share, codex-threads.mjs) each at its own model, the rest of `tokens` at `model`. `{usd, unknown, why}`: `usd` what
 * could be priced (null when nothing could), `unknown` whether any of it could not, `why` the UNKNOWN_WHY codes for that
 * (an unlisted model's tokens, a lapsed promotional rate, a long-context share not read).
 */
export function priceStage(table, model, tokens, subAgents = [], { at } = {}) {
  const subs = (Array.isArray(subAgents) ? subAgents : []).filter((t) => t?.tokens && typeof t.tokens === "object");
  const above = table?.longContextAbove;
  const why = new Set();
  const priced = (m, t) => {
    const r = codexPrice(table, m, t, { at });
    if (r.usd === null) why.add(r.why ?? "unreported");
    return r.usd;
  };
  if (!subs.length) {
    const usd = priced(model, tokens);
    return { usd, unknown: usd === null, why: [...why] };
  }
  const sum = (k) => subs.reduce((n, t) => n + (typeof t.tokens[k] === "number" ? t.tokens[k] : 0), 0);
  const plain = Object.fromEntries(TOKEN_KEYS.map((k) => [k, tokens?.[k] === null || tokens?.[k] === undefined ? null : Math.max(0, tokens[k] - sum(k))]));
  const rest = withLong(plain, sumLong([longShare(tokens, above), ...subs.map((t) => longShare(t.tokens, above))], -1), above);
  let usd = priced(model, rest);
  let unknown = usd === null;
  for (const t of subs) {
    const p = priced(t.model || model, t.tokens);
    if (p === null) unknown = true;
    else usd = (usd ?? 0) + p;
  }
  return { usd: usd === null ? null : Math.round(usd * 10000) / 10000, unknown, why: [...why] };
}

/**
 * The warning for a Codex model the price table cannot price, else null: no row (UNKNOWN_WHY `no-price`), or a
 * promotional rate that has ended (`price-ended`). Its runs are of unknown cost, so neither `max_usd` nor `daily_usd`
 * counts them (Codex has no in-run cap; Pendulum checks dollars after each run); only a budget on the provider's key
 * bounds them. Doctor and the stage's progress comment say it.
 */
export function unpricedCodex(harness, model, { gateway = false, at } = {}) {
  if (harness !== "codex" || !model) return null;
  const { rate, id, why } = codexRow(CODEX_PRICES, model, { at });
  if (rate) return null;
  const what = why === "price-ended" ? `${bareModel(model)}'s rate in the Codex price table (dated ${CODEX_PRICES.date}) is OpenAI's promotional rate for ${id}, which ended ${CODEX_PRICES.perMillion[id].until}` : `${bareModel(model)} has no row in the Codex price table (dated ${CODEX_PRICES.date})`;
  return `${what}: its runs are of unknown cost, so neither max_usd nor daily_usd counts them; only ${gateway ? "the AI Gateway key's budget" : "the provider key's own limit"} bounds them`;
}

/** Doctor warns about a promotional rate this many days before it ends. */
export const PROMO_WARN_DAYS = 7;

/**
 * Doctor's row for a Codex model priced at a promotional rate (a price-table row with `until`), else null:
 * `{status, detail}`, WARN in the PROMO_WARN_DAYS days before the rate ends and FAIL from then on (its runs are then of
 * unknown cost, UNKNOWN_WHY `price-ended`, until a Pendulum release dates the table again).
 */
export function promoCodex(harness, model, { at = Date.now() } = {}) {
  if (harness !== "codex" || !model) return null;
  const { id } = codexRow(CODEX_PRICES, model, { at: 0 });
  const p = id && Object.hasOwn(CODEX_PRICES.perMillion, id) ? CODEX_PRICES.perMillion[id] : null;
  const ends = rateEnds(p);
  const now = new Date(at).getTime();
  if (ends === null || !(now >= ends - PROMO_WARN_DAYS * 86400000)) return null;
  if (now >= ends) return { status: "FAIL", detail: `${bareModel(model)} is priced at OpenAI's promotional rate for ${id}, which ended ${p.until}: its runs are of unknown cost until the Codex price table (dated ${CODEX_PRICES.date}) has OpenAI's current rate` };
  return { status: "WARN", detail: `${bareModel(model)} is priced at OpenAI's promotional rate for ${id}, which ends ${p.until}: from that day its runs are of unknown cost until the Codex price table (dated ${CODEX_PRICES.date}) has OpenAI's current rate` };
}

/**
 * The basis of a Codex run that reported no token counts: no `turn.completed` (a refused request, a turn cut short). Its
 * spend is unknown (UNKNOWN_WHY `unreported`), not zero (a cut turn may have spent tokens), and no price is missing. The bench says the same
 * (bench/lib/cost.mjs costOf), so the worker's record and the scorecard agree.
 */
export const CODEX_NO_TOKENS = "unknown: no Codex turn completed, so Codex reported no tokens";
const priceBasis = () => `priced at OpenAI's Standard rates from table dated ${CODEX_PRICES.date}${CODEX_PRICES.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}`;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const add = (a, b) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

function empty(harness, model) {
  return {
    harness,
    model: model ?? null,
    usd: null,
    tokens: { input: null, output: null, cached: null, written: null },
    basis: "unknown",
    started: null,
    ended: null,
    sessionId: null,
    subtype: null,
    ok: false,
    error: null,
    turns: null,
    budgetExceeded: false,
    cache: { first: null },
  };
}

/** Parse JSON lines; a non-JSON line is skipped (CLIs print warnings on stdout). */
export function jsonLines(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial or non-JSON line
    }
  }
  return out;
}

/**
 * Harness calls and distinct sessions in a raw event stream: Claude's `system/init` lines and `session_id`, Codex's
 * `thread.started` and thread ids. Null when the text has neither. The scorer reads it from a stream, and a usage record
 * whose stream was sealed carries it as `sessions` (seal.mjs).
 */
export function streamSessions(text) {
  let calls = 0;
  const ids = new Set();
  for (const l of jsonLines(String(text ?? "").trim())) {
    if (l.type === "system" && l.subtype === "init") calls += 1;
    if (l.type === "thread.started") calls += 1;
    if (typeof l.session_id === "string") ids.add(l.session_id);
    if (typeof l.thread_id === "string") ids.add(l.thread_id);
  }
  return calls || ids.size ? { calls, sessions: ids.size } : null;
}

/**
 * Error types and codes that no retry can pass, whatever the status: an exhausted quota or billing (OpenAI's
 * `insufficient_quota` comes as a 429, so the status alone reads it as a rate limit), a rejected key, and the Vercel AI
 * Gateway's budget (`quota_for_entity_exceeded`, HTTP 402), credits (`insufficient_funds`, 402) and payment-method
 * (`customer_verification_required`, 403) types, which decide a gateway body that carries no status. A subscription's
 * usage limit (`usage_limit_reached`, a 429) is in it too: a retry on any model of the same subscription meets it again.
 */
/**
 * Copilot's per-user rate limits (its schema's RateLimitErrorCode for `errorType: "rate_limit"`): the user's weekly and
 * global limits, which hold the account for a window, so they are usage limits with no reset reported, never "busy".
 */
const COPILOT_USER_LIMITS = ["user_weekly_rate_limited", "user_global_rate_limited"];
const REFUSED_KINDS = new Set(["usage_limit_reached", "insufficient_quota", "billing_error", "quota", "authentication", "authentication_failed", "authentication_error", "invalid_api_key", "authorization", "permission_error", "quota_for_entity_exceeded", "insufficient_funds", "customer_verification_required", ...COPILOT_USER_LIMITS]);
const refusedKind = (r) => REFUSED_KINDS.has(r.type) || REFUSED_KINDS.has(r.code);
/** The kinds that are a subscription's usage limit: it resets at a known moment (usageReset), unlike a quota or billing refusal. */
export const USAGE_LIMIT_KINDS = new Set(["usage_limit_reached"]);
/** Whether a refusal (providerRefusal) is a subscription's usage limit. */
export const usageLimited = (r) => !!r && (USAGE_LIMIT_KINDS.has(r.type) || USAGE_LIMIT_KINDS.has(r.code));

/** Provider error types and codes (REFUSED_KINDS) that are a quota or billing refusal, by whose account. */
const PROVIDER_QUOTA_KINDS = new Set(["usage_limit_reached", "insufficient_quota", "billing_error", "quota", ...COPILOT_USER_LIMITS]);
const GATEWAY_BUDGET_KINDS = new Set(["quota_for_entity_exceeded", "insufficient_funds"]);

/**
 * A provider refusal's cause (providerRefusal): the AI Gateway's budget or credits, the provider's quota or
 * billing (those kinds, or HTTP 402), else a setup gap (a key, an authorization, a payment method, a request the
 * settings make).
 */
export function refusalCause(r) {
  const kinds = [r?.type, r?.code];
  if (kinds.some((k) => GATEWAY_BUDGET_KINDS.has(k))) return "gateway-budget";
  if (kinds.some((k) => PROVIDER_QUOTA_KINDS.has(k)) || r?.status === 402) return "provider-quota";
  return "setup";
}

/**
 * Whether a refusal (providerRefusal) is the account's usage limit or quota with no reset reported: Copilot's always,
 * Codex's when its snapshot names none (a workspace's credits or spend cap). Automatic account choice passes that
 * account over for a guessed while (holds.mjs spent) and, with another account free, moves the Objective there.
 */
export const noResetLimit = (r) => !!r && refusalCause(r) === "provider-quota" && !Number.isFinite(r.resetAt);

/** An epoch time in seconds or ms as ms; null when it is no positive number. */
const epochMs = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : null);

/**
 * The AI Gateway's error types for a 5xx it sends as a bare body with no status (gateway-relay.mjs UNAVAILABLE_ERRORS
 * and `internal_server_error`, docs/PLAN.md's decider): the provider busy, as a 5xx with its status is (providerBusy),
 * and the outage code of a pause on one (busyCode, network.mjs serverDown).
 */
export const BARE_BUSY_TYPES = new Set(["service_unavailable_error", "overloaded_error", "internal_server_error"]);

/** 4xx statuses that are worth retrying: a timeout, a conflict, too early, a rate limit. */
const RETRYABLE_4XX = new Set([408, 409, 425, 429]);
/** 4xx statuses that mean the provider is busy, not refusing (HTTP's own meaning): a request timeout, too early, too many requests. */
const BUSY_4XX = new Set([408, 425, 429]);
/** 4xx statuses that refuse one request as sent (its body: a session's transcript), not the account or its settings. */
const REQUEST_4XX = new Set([400, 413, 422]);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The provider error a failed Codex run ended on, as structure: {status, type, code, message, param?} from the last `turn.failed`
 * (else `error`) event's JSON body, or null when the run's last word was a completed turn or the message is prose.
 */
function codexError(events) {
  const last = [...events].reverse().find((e) => e?.type === "turn.failed" || e?.type === "error" || e?.type === "turn.completed");
  if (!last || last.type === "turn.completed") return null;
  const raw = last.type === "turn.failed" ? last.error?.message : last.message;
  let body = null;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }
  if (!body || typeof body !== "object" || !body.error || typeof body.error !== "object") return null;
  return { status: num(body.status), type: str(body.error.type), code: str(body.error.code), message: str(body.error.message), ...(str(body.error.param) ? { param: str(body.error.param) } : {}) };
}

/**
 * The `rate_limit_reached_type`s of a workspace's credits or spend cap (codex-rs protocol RateLimitReachedType): an
 * owner refills or raises them, so no window's reset ends them.
 */
const CODEX_WORKSPACE_LIMITS = new Set(["workspace_owner_credits_depleted", "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"]);

/**
 * A failed Codex run's subscription usage limit, read from its thread's rollout: `{status, type, code, message, reset,
 * limitType}`, else null. Codex's `exec --json` stream reports the limit as prose only (codex-cli 0.167: its error
 * event holds a `message` and nothing else, and the exit is 1 for every failure), so the stream cannot decide it. When
 * the ChatGPT backend refuses a request with `usage_limit_reached`, Codex records the rate-limit snapshot from that
 * answer's headers as a `token_count` event in the rollout (codex-rs core session/turn.rs, `update_rate_limits`), and
 * the rollout keeps it (rollout/src/policy.rs). The structure read:
 * - the run's stream ended on an error: its last `turn.failed`, `error` or `turn.completed` event is no completed turn;
 * - the last `token_count` line of the rollout stamped at or after `since` (the pass's start: a resumed thread's older
 *   lines are an earlier pass's) whose `payload.rate_limits` is an object of the subscription's own limit group
 *   (`limit_id` "codex" or absent); another group's snapshot (a per-model limit) is not read;
 * - that snapshot names a `rate_limit_reached_type`, or a window (`primary`, `secondary`) at `used_percent` 100 or more;
 * - and it shows no credits to go on (`credits.has_credits` and `credits.unlimited` both not true), unless the type is
 *   a workspace's credits or spend cap (CODEX_WORKSPACE_LIMITS): on credits Codex runs on past its windows, so an
 *   unrelated failure then is no limit, and reading it as one would hold every Codex Objective until the reset.
 * The reset is the latest `resets_at` (epoch seconds) of the full windows, or of any window when a type is named and no
 * window is full; a workspace's credits or spend cap (CODEX_WORKSPACE_LIMITS) has none. `type` is the backend's error type, `usage_limit_reached` (the only refusal that
 * records a snapshot at the failure); `code` the snapshot's `rate_limit_reached_type`. A limit Codex meets in a
 * compaction records no snapshot, and an API key or the AI Gateway gets no ChatGPT rate-limit headers: those failures
 * stay what the stream says.
 */
function codexLimit(events, rollout, since) {
  const last = [...events].reverse().find((e) => e?.type === "turn.failed" || e?.type === "error" || e?.type === "turn.completed");
  const from = Date.parse(since);
  if (!last || last.type === "turn.completed" || typeof rollout !== "string" || !Number.isFinite(from)) return null;
  let snap = null;
  for (const line of rollout.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    const o = jsonLines(line)[0];
    if (o?.type !== "event_msg" || o.payload?.type !== "token_count") continue;
    const at = Date.parse(o.timestamp);
    const rl = o.payload.rate_limits;
    if (Number.isFinite(at) && at >= from && rl && typeof rl === "object" && (rl.limit_id == null || rl.limit_id === "codex")) snap = rl;
  }
  if (!snap) return null;
  const reached = str(snap.rate_limit_reached_type);
  const onCredits = snap.credits?.has_credits === true || snap.credits?.unlimited === true;
  const windows = ["primary", "secondary"].filter((k) => num(snap[k]?.used_percent) !== null);
  const full = windows.filter((k) => snap[k].used_percent >= 100);
  if (!reached && !full.length) return null;
  if (onCredits && !CODEX_WORKSPACE_LIMITS.has(reached)) return null;
  const resets = CODEX_WORKSPACE_LIMITS.has(reached) ? [] : (full.length ? full : windows).map((k) => ({ k, at: epochMs(snap[k].resets_at) })).filter((w) => w.at !== null);
  const latest = resets.reduce((a, w) => (!a || w.at > a.at ? w : a), null);
  const message = str(last.type === "turn.failed" ? last.error?.message : last.message);
  return { status: null, type: "usage_limit_reached", code: reached, message, reset: latest?.at ?? null, ...(latest ? { limitType: `${str(snap.limit_id) ?? "codex"}/${latest.k}` } : {}) };
}

/**
 * The error codes of a resumed Codex thread whose encrypted reasoning the provider cannot read: the thread was written
 * through another provider credential (an AI Gateway session pin that moved to another account between passes, or an
 * OpenAI key from another organization). A fresh thread passes; a retry of the resume never does.
 */
export const ROTATED_PIN_CODES = new Set(["invalid_encrypted_content", "organization_mismatch"]);

/**
 * Whether a failed Codex resume ended on that rejection (runHarness then runs a fresh thread once): HTTP 400, or no status
 * (a bare gateway body), with a ROTATED_PIN_CODES code or type. Structure only, never the message's words.
 */
export function rotatedPin(harness, events) {
  if (harness !== "codex") return false;
  const e = codexError(events);
  return !!e && (e.status === 400 || e.status === null) && (ROTATED_PIN_CODES.has(e.code) || ROTATED_PIN_CODES.has(e.type));
}

/**
 * A provider's refusal the harness reported as structure, when no retry can pass it: {harness, status, type, code,
 * message}, else null. Decided on the fields alone (an HTTP status in 4xx other than RETRYABLE_4XX, or a REFUSED_KINDS
 * type or code), never on the message's words; a 429 rate limit or a 5xx is null (the provider busy: providerBusy), and
 * so is a transport error (no status). A resumed pass refused for its request alone (requestRefused) runs once fresh
 * before its refusal stands (harness.mjs runHarness). The parsers ask only for a run that failed. Each harness's structure:
 *   claude  : the result line with is_error and `api_error_status`; the type is the API error message's `error`
 *   codex   : the last `turn.failed` (else `error`) event, whose `error.message` is the provider's JSON error body
 *             ({status, error: {type, code, message}}), or the AI Gateway's bare body ({error: {type, message}}, no
 *             status: decided by its type); a message that is not a JSON object is prose: null
 *   copilot : the main agent's last `session.error` event's data {statusCode, errorType, errorCode, message}
 * A usage limit (usageLimited) carries `resetAt` (ms) when the harness reported the reset as structure:
 *   claude  : the result's `api_error` is the code (`usage_limit_reached`); the reset is the API error message's
 *             `api_error_params.rate_limit_info.resetsAt`, else the last `rate_limit_event` whose status is `rejected`,
 *             of the error's own window (`rateLimitType`, kept as `limitType`) when it names one
 *   codex   : the stream reports it as prose only, so it is read from the rate-limit snapshot Codex records in the
 *             thread's rollout (`rollout`, its text, the lines stamped from `since`, the pass's start: codexLimit), with
 *             the reset from that snapshot's full window
 *   copilot : no reset is reported, so a Copilot quota refusal Blocks as it is
 */
export function providerRefusal(harness, events, { rollout = null, since = null } = {}) {
  let e = providerError(harness, events);
  // A failed Codex run whose stream names no error of its own: its usage limit, from the thread's rollout (codexLimit).
  if (!e && harness === "codex") {
    const limit = codexLimit(events, rollout, since);
    if (limit) e = { harness, retryAt: null, ...limit };
  }
  // Claude Code's API error with no status (a connection it could not make) is no refusal.
  if (!e || (harness === "claude" && e.status === null)) return null;
  const { reset, retryAt, ...r } = e;
  // A 5xx with an auth, permission, quota or billing type or code is that refusal, not the provider busy (providerBusy).
  const refused = r.status !== null ? (r.status >= 400 && r.status < 500 && (!RETRYABLE_4XX.has(r.status) || refusedKind(r))) || (r.status >= 500 && refusedKind(r)) : refusedKind(r);
  if (!refused) return null;
  return { ...r, ...(usageLimited(r) && reset !== null ? { resetAt: reset } : {}) };
}

/** Anthropic's API error types by HTTP status (its Errors reference), for an API error message that names no status. */
const ANTHROPIC_ERROR_STATUS = new Map([["invalid_request_error", 400], ["authentication_error", 401], ["billing_error", 402], ["permission_error", 403], ["not_found_error", 404], ["request_too_large", 413], ["rate_limit_error", 429], ["api_error", 500], ["timeout_error", 504], ["overloaded_error", 529]]);

/**
 * A Claude Code sub-agent's model refused by the provider, from one of its API error messages (an assistant event with
 * `is_api_error_message` and the `parent_tool_use_id` of the call that started it): {harness, status, type, code,
 * message, subAgent, toolUseId}, else null. The main session goes on without the sub-agent's work, on its own model and
 * with no error of its own (Claude Code 2.1.325), so the stage stops the run on it (harness.mjs runPass) and Blocks
 * naming the sub-agent's model (logic.mjs refusalReason). Decided on the fields alone: its `api_error_status`, else the
 * status of its `api_error_type` (a sub-agent's message carries the type only), a 4xx that refuses the model or the
 * credential (not RETRYABLE_4XX, not a request's own REQUEST_4XX), or a REFUSED_KINDS type or code. A usage limit is
 * not one: the main session draws on the same limit and meets it as its own refusal. `subAgent` is the agent's type.
 */
export function subAgentRefusal(events) {
  for (const e of events) {
    if (e?.type !== "assistant" || e.is_api_error_message !== true || !e.parent_tool_use_id) continue;
    const text = (Array.isArray(e.message?.content) ? e.message.content : []).find((c) => c?.type === "text")?.text;
    const r = { harness: "claude", status: num(e.api_error_status) ?? ANTHROPIC_ERROR_STATUS.get(e.api_error_type) ?? null, type: str(e.error), code: str(e.api_error), message: str(text) };
    if (usageLimited(r)) continue;
    const refused = refusedKind(r) || (r.status !== null && r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status) && !REQUEST_4XX.has(r.status));
    if (refused) return { ...r, subAgent: str(e.subagent_type) ?? "", toolUseId: String(e.parent_tool_use_id) };
  }
  return null;
}

/**
 * The provider saying it is busy, from its error (providerError) on a failed run: {harness, status, type, code, message,
 * retryAt?}, else null. Busy is the status's own HTTP meaning: 408, 425 or 429 (BUSY_4XX), or any 5xx (529 included);
 * with no status, the AI Gateway's bare 5xx types (BARE_BUSY_TYPES: `service_unavailable_error`,
 * `overloaded_error`, `internal_server_error`). A refusal type or code (REFUSED_KINDS: auth, permission, quota or
 * billing; a 429 `insufficient_quota`, `usage_limit_reached`, or Copilot's weekly or global rate limit) is a refusal
 * instead, whatever the status: providerRefusal reads a 5xx with one as a refusal too, so no such error falls between.
 * `retryAt` is the error's own (providerError: a 429's only); runHarness waits for it, else the outage doubling, and runs
 * the pass again: no death. busyCode is its code as an outage's.
 */
export function providerBusy(harness, events) {
  const e = providerError(harness, events);
  if (!e || refusedKind(e)) return null;
  const busy = e.status !== null ? BUSY_4XX.has(e.status) || (e.status >= 500 && e.status < 600) : BARE_BUSY_TYPES.has(e.type);
  if (!busy) return null;
  const { reset, retryAt, ...r } = e;
  return { ...r, ...(Number.isFinite(retryAt) ? { retryAt } : {}) };
}

/** A busy answer (providerBusy) as an outage's code (network.mjs serverDown): `HTTP 503`, or the bare body's type. */
export const busyCode = (r) => (r.status !== null ? `HTTP ${r.status}` : r.type);

/**
 * Whether a refusal refuses only the request a resumed session sends (its transcript), so one fresh pass can tell: a
 * 400, 413 or 422 (REQUEST_4XX) with no auth, permission, quota or billing type or code (REFUSED_KINDS). runHarness runs
 * a resumed pass so refused once fresh before the refusal stands.
 */
export const requestRefused = (r) => !!r && REQUEST_4XX.has(r.status) && !refusedKind(r);

/**
 * The provider error a failed run ended on, as the harness reported it in structure: {harness, status, type, code,
 * message, reset, retryAt}, else null (no such structure: a crash, a run killed, an error reported as prose only).
 * providerRefusal, providerBusy and outageError are read from it, never from the words:
 *   claude  : the result line with is_error and an API error message: the result's `api_error_status` (else the
 *             message's; null for a connection Claude Code could not make), the message's `error` as the type and the
 *             result's (else the message's) `api_error` as the code
 *   codex   : the last `turn.failed` (else `error`) event's JSON error body (codexError)
 *   copilot : the main agent's last `session.error` event's data {statusCode, errorType, errorCode, message}
 * `reset` (ms): a usage limit's reset as Claude Code reports it, the API error's `rate_limit_info.resetsAt`, else the
 * last rejected `rate_limit_event` of the error's own window (`rateLimitType`, kept as `limitType`); null otherwise.
 * `retryAt` (ms): when the provider says to go again, a 429's only and only from the error's own fields: Claude's API
 * error `api_error_params.rate_limit_info.resetsAt`; Copilot's `auto_mode_switch.requested` that follows the
 * `session.error` with the same `errorCode`, its `retryAfterSeconds` from that event's time. Never an unrelated event.
 */
export function providerError(harness, events) {
  let r = null;
  let reset = null;
  let retryAt = null;
  if (harness === "claude") {
    const res = [...events].reverse().find((e) => e?.type === "result");
    // The main session's own API error message: a sub-agent's (parent_tool_use_id) is subAgentRefusal's.
    const api = [...events].reverse().find((e) => e?.type === "assistant" && e.is_api_error_message === true && !e.parent_tool_use_id);
    const status = num(res?.api_error_status) ?? num(api?.api_error_status);
    if (res?.is_error !== true || (!api && status === null)) return null;
    r = { status, type: str(api?.error), code: str(res.api_error) ?? str(api?.api_error), message: str(res.result) };
    // The limit's window (`rateLimitType`, e.g. five_hour) as the API error names it; the fallback reset is that window's.
    const info = api?.api_error_params?.rate_limit_info;
    const limitType = str(info?.rateLimitType);
    const rejected = [...events].reverse().find((e) => e?.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected" && (!limitType || e.rate_limit_info.rateLimitType === limitType));
    reset = epochMs(info?.resetsAt) ?? epochMs(rejected?.rate_limit_info?.resetsAt);
    if (status === 429) retryAt = epochMs(info?.resetsAt);
    if (limitType && USAGE_LIMIT_KINDS.has(r.code)) r.limitType = limitType;
  } else if (harness === "codex") {
    r = codexError(events);
    if (!r) return null;
  } else if (harness === "copilot") {
    const at = events.findLastIndex((e) => e?.type === "session.error" && !e.agentId);
    const d = events[at]?.data;
    if (!d || typeof d !== "object") return null;
    r = { status: num(d.statusCode), type: str(d.errorType), code: str(d.errorCode), message: str(d.message) };
    const ask = r.status === 429 && r.code ? events.slice(at + 1).find((e) => e?.type === "auto_mode_switch.requested" && !e.agentId && str(e.data?.errorCode) === r.code) : null;
    const after = num(ask?.data?.retryAfterSeconds);
    const t = Date.parse(ask?.timestamp);
    if (after !== null && after >= 0 && Number.isFinite(t)) retryAt = t + after * 1000;
  } else return null;
  return { harness, ...r, reset, retryAt };
}

/**
 * Claude Code's per-model windows (SDKRateLimitInfo `rateLimitType`): each limits only stages on that model family; and
 * `overage`, which meters pay-as-you-go use past the included limits, so it is no limit on included use at all.
 */
const MODEL_WINDOWS = { seven_day_opus: "opus", seven_day_sonnet: "sonnet" };
const NO_LIMIT_WINDOWS = new Set(["overage"]);
/**
 * A Claude model id's family, the word after `claude-` (`claude-opus-5-5`: opus); null for any other name: an alias
 * (`opus`, `opusplan`, which runs more than one), another harness's model, or none.
 */
export const modelFamily = (model) => /^claude-([a-z]+)-/.exec(String(model || "").trim().toLowerCase())?.[1] ?? null;
/**
 * Whether a quota window limits a stage that runs `models` (its worker, sub-agent or reviewer models): `overage` never;
 * a per-model window only when one of the models is of its family, or when any model is unknown (none, a harness
 * default: it could be that family); every other window always.
 */
export function quotaWindowApplies(name, models = []) {
  if (NO_LIMIT_WINDOWS.has(name)) return false;
  const family = MODEL_WINDOWS[name];
  if (!family) return true;
  const families = models.map(modelFamily);
  return !families.length || families.includes(null) || families.includes(family);
}

/** A usage window's name as a quota reading keeps it (the names holds.mjs windowOf accepts). */
const QUOTA_WINDOW = /^[a-z0-9][a-z0-9_./-]{0,39}$/i;
/** The most windows one reading keeps: Claude Code names five or six, Codex two. */
const QUOTA_WINDOWS_MAX = 8;

/**
 * How much of its subscription's usage limits a pass's account had used, as the harness reported it during the pass:
 * {harness, windows: {<window>: {used, resetsAt}}}, `used` the fraction of the window spent (1 is all of it) and
 * `resetsAt` (ms) when the window starts again; null when the harness reported none. Only a window with both numbers is
 * kept: a reading with no reset could never be told stale. The structure read:
 *   claude  : each `rate_limit_event` on the stream (Claude Code sends one for a claude.ai subscription; none on an API
 *             key): its `rate_limit_info.unifiedWindows` (`five_hour`, `seven_day`, ...: {utilization, resetsAt}), and
 *             its own `rateLimitType` with `utilization` and `resetsAt` when it names them; a later event's window
 *             replaces an earlier one's
 *   codex   : the last `token_count` line of the thread's rollout stamped at or after `since` (the pass's start) whose
 *             `rate_limits` is the subscription's own limit group (`limit_id` "codex" or absent, as codexLimit reads):
 *             its `primary` and `secondary` windows' `used_percent` and `resets_at`, kept as `codex/primary` and
 *             `codex/secondary`. Codex writes it from each answer's headers on a ChatGPT login; an API key or the AI
 *             Gateway gets none
 *   copilot : reports none
 */
export function quotaReading(harness, stdout, { rollout = null, since = null } = {}) {
  const windows = {};
  const put = (name, used, reset) => {
    const at = epochMs(reset);
    if (typeof name !== "string" || !QUOTA_WINDOW.test(name) || num(used) === null || used < 0 || at === null) return;
    if (!(name in windows) && Object.keys(windows).length >= QUOTA_WINDOWS_MAX) return;
    windows[name] = { used, resetsAt: at };
  };
  if (harness === "claude") {
    for (const e of jsonLines(stdout)) {
      const info = e?.type === "rate_limit_event" ? e.rate_limit_info : null;
      if (!info || typeof info !== "object") continue;
      put(info.rateLimitType, info.utilization, info.resetsAt);
      const uw = info.unifiedWindows;
      if (uw && typeof uw === "object" && !Array.isArray(uw)) for (const [name, w] of Object.entries(uw)) put(name, w?.utilization, w?.resetsAt);
    }
  } else if (harness === "codex") {
    const from = Date.parse(since);
    if (typeof rollout !== "string" || !Number.isFinite(from)) return null;
    let snap = null;
    for (const line of rollout.split("\n")) {
      if (!line.includes('"token_count"')) continue;
      const o = jsonLines(line)[0];
      if (o?.type !== "event_msg" || o.payload?.type !== "token_count") continue;
      const at = Date.parse(o.timestamp);
      const rl = o.payload.rate_limits;
      if (Number.isFinite(at) && at >= from && rl && typeof rl === "object" && (rl.limit_id == null || rl.limit_id === "codex")) snap = rl;
    }
    if (!snap) return null;
    for (const k of ["primary", "secondary"]) {
      const w = snap[k];
      if (w && typeof w === "object" && num(w.used_percent) !== null) put(`codex/${k}`, w.used_percent / 100, w.resets_at);
    }
  } else return null;
  return Object.keys(windows).length ? { harness, windows } : null;
}

/**
 * Whether a provider error (providerError) with no status is its provider or the network failing: the type is a server
 * error. Claude Code reports a connection it could not make or a request that timed out as an API error message whose
 * `error` is `server_error` with no `api_error_status` (2.1.325). A 5xx or a 429 that carries its status is the provider
 * busy instead (providerBusy).
 */
export const outageError = (r) => !!r && r.status === null && r.type === "server_error";

/** Whether a provider error (providerError) is a 4xx: the provider answered and said why, so no probe asks the network. */
export const answeredError = (r) => !!r && r.status !== null && r.status >= 400 && r.status < 500;

/**
 * Claude Code's per-model usage (`modelUsage` in a result, or in a transcript's cost-state line) as Pendulum's models,
 * tokens and summed dollars; null when there is none. Cache writes and the per-model split are kept so cost reads by
 * component on the bench's scorecard.
 */
function claudeModels(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object" || !Object.keys(modelUsage).length) return null;
  const out = { models: {}, tokens: { input: null, output: null, cached: null, written: null }, usd: null };
  for (const [name, u] of Object.entries(modelUsage)) {
    const m = { input: num(u?.inputTokens), cached: num(u?.cacheReadInputTokens), written: num(u?.cacheCreationInputTokens), output: num(u?.outputTokens), usd: num(u?.costUSD) };
    out.tokens.input = add(out.tokens.input, add(m.input, add(m.cached, m.written)));
    out.tokens.output = add(out.tokens.output, m.output);
    out.tokens.cached = add(out.tokens.cached, m.cached);
    out.tokens.written = add(out.tokens.written, m.written);
    if (m.usd !== null) out.usd = add(out.usd, m.usd);
    out.models[name] = m;
  }
  return out;
}

/**
 * The running total a Claude session's transcript last recorded: its last `cost-state` line, which Claude Code writes
 * as each process ends and a resumed session's reported totals start from. In sinceSession's shape; null when none.
 */
export function transcriptTotal(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.includes('"cost-state"'));
  const last = jsonLines(lines.join("\n")).filter((l) => l?.type === "cost-state").at(-1);
  if (!last) return null;
  const m = claudeModels(last.modelUsage);
  const usd = num(last.totalCostUSD) ?? m?.usd ?? null;
  return usd === null ? null : { usd, tokens: m?.tokens ?? { input: null, output: null, cached: null, written: null }, models: m?.models ?? null };
}

/**
 * Claude Code: `claude -p --output-format json` prints one result object; with
 * stream-json it prints one object per line ending in the same result. Either way the
 * last {type: "result"} wins. `modelUsage` includes sub-agents; top-level `usage` does not.
 */
export function parseClaude(stdout, model) {
  const rec = empty("claude", model);
  let result = null;
  const trimmed = String(stdout || "").trim();
  if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    try {
      result = JSON.parse(trimmed);
    } catch {
      result = null;
    }
  }
  let init = null;
  let first = null;
  let lines = result ? [result] : [];
  if (!result) {
    lines = jsonLines(stdout);
    result = [...lines].reverse().find((l) => l && l.type === "result") ?? lines.at(-1) ?? null;
    init = lines.find((l) => l && l.type === "system" && l.session_id) ?? null;
    first = claudeFirstRequest(lines);
  }
  rec.cache = { first };
  const refusal = providerRefusal("claude", lines) ?? subAgentRefusal(lines);
  if (refusal) rec.refusal = refusal;
  const busy = refusal ? null : providerBusy("claude", lines);
  if (busy) rec.busy = busy;
  // Its provider error (providerError) when it is no refusal and no busy answer; also `providerOutage` when it names a
  // provider or network failure with no status (outageError).
  const failure = refusal || busy ? null : providerError("claude", lines);
  if (failure) rec.providerError = failure;
  if (outageError(failure)) rec.providerOutage = failure;
  // The Claude Code that ran, as its stream's init line names it: whether a resumed total is a running total (sinceSession).
  const version = lines.find((l) => l?.type === "system" && l.subtype === "init")?.claude_code_version ?? lines.find((l) => typeof l?.claude_code_version === "string")?.claude_code_version;
  if (typeof version === "string") rec.harnessVersion = version;
  if (!result) {
    rec.error = "no JSON result on stdout";
    rec.sessionId = init?.session_id ?? null; // a crashed process still has a session to resume
    return markUnknown(rec, "unreported");
  }
  rec.subtype = result.subtype ?? null;
  rec.sessionId = result.session_id ?? init?.session_id ?? null;
  rec.turns = num(result.num_turns);
  rec.budgetExceeded = result.subtype === "error_max_budget_usd";
  // A sub-agent's model refused (subAgentRefusal): the run did not do what it was asked, whatever its result says.
  rec.ok = result.is_error !== true && (result.subtype === "success" || result.subtype === undefined) && typeof refusal?.subAgent !== "string";
  if (!rec.ok) rec.error = result.subtype || (typeof result.result === "string" ? result.result.slice(0, 300) : "is_error");

  const byModel = claudeModels(result.modelUsage);
  if (byModel) {
    rec.models = byModel.models;
    rec.model = rec.model || Object.keys(byModel.models)[0];
    rec.tokens = byModel.tokens;
    rec.usd = num(result.total_cost_usd) ?? byModel.usd;
    rec.basis = "harness-reported: total_cost_usd, modelUsage (sub-agents included)";
  } else if (result.usage) {
    const u = result.usage;
    const cached = num(u.cache_read_input_tokens);
    const written = num(u.cache_creation_input_tokens);
    rec.tokens = {
      input: add(num(u.input_tokens), add(cached, written)),
      output: num(u.output_tokens),
      cached,
      written,
    };
    rec.usd = num(result.total_cost_usd);
    if (rec.usd !== null) rec.basis = "harness-reported: total_cost_usd, usage (sub-agents excluded)";
  } else {
    rec.usd = num(result.total_cost_usd);
    if (rec.usd !== null) rec.basis = "harness-reported: total_cost_usd";
  }
  // A crashed session's final result can carry zeroed totals (Anthropic's cost-tracking docs): an error result at $0
  // after the stream's own messages reported tokens is no $0.
  const streamed = lines.some((l) => l?.type === "assistant" && ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].some((k) => num(l.message?.usage?.[k]) > 0));
  if (rec.usd === 0 && (result.is_error === true || (result.subtype && result.subtype !== "success")) && streamed) {
    rec.usd = null;
    rec.basis = `unknown: ${UNKNOWN_WHY.zeroed}`;
    markUnknown(rec, "zeroed");
  }
  if (rec.usd === null && !rec.usdUnknown) {
    rec.basis = `unknown: ${UNKNOWN_WHY.unreported}`;
    markUnknown(rec, "unreported");
  }
  return rec;
}

/**
 * The worker's own background commands still running when its harness process ended, from the harness's stream:
 * `[{id, description, command}]`, [] when there are none. Claude Code reports the session's in-flight background work as
 * a whole set on every change (`system` `background_tasks_changed`, its `tasks`): the last such set, its `local_bash`
 * entries, is what was still running. A stream with no such event (an older Claude Code) falls back to pairing: a
 * `local_bash` `task_started` with `is_backgrounded` (or moved there by a `task_updated` patch) and no
 * `task_notification` for its `task_id`. `command` is the Bash call's own input (the task's `tool_use_id`, from its
 * `task_started`), null when the stream does not have it; both it and `description` are the model's text. Codex
 * reports no background command (a command it starts with `&` is an item that completed), and Copilot's stream names a
 * still-running background shell's id in no start event, so for both this is [].
 */
export function backgroundJobs(harness, stdout) {
  if (harness !== "claude") return [];
  const calls = new Map();
  const tasks = new Map();
  let live = null;
  for (const e of jsonLines(stdout)) {
    if (e?.type === "assistant") {
      for (const c of e.message?.content || []) if (c?.type === "tool_use" && typeof c.id === "string") calls.set(c.id, c.input);
      continue;
    }
    if (e?.type !== "system") continue;
    if (e.subtype === "background_tasks_changed" && Array.isArray(e.tasks)) live = e.tasks;
    if (typeof e.task_id !== "string") continue;
    if (e.subtype === "task_started" && e.task_type === "local_bash") tasks.set(e.task_id, { id: e.task_id, call: e.tool_use_id ?? null, description: typeof e.description === "string" ? e.description : "", backgrounded: e.is_backgrounded === true, ended: false });
    else if (e.subtype === "task_updated" && e.patch?.is_backgrounded === true && tasks.has(e.task_id)) tasks.get(e.task_id).backgrounded = true;
    else if (e.subtype === "task_notification" && tasks.has(e.task_id)) tasks.get(e.task_id).ended = true;
  }
  const running = live
    ? live.filter((t) => t?.task_type === "local_bash" && typeof t.task_id === "string").map((t) => ({ ...tasks.get(t.task_id), id: t.task_id, description: typeof t.description === "string" ? t.description : tasks.get(t.task_id)?.description ?? "" }))
    : [...tasks.values()].filter((t) => t.backgrounded && !t.ended);
  return running.map((t) => {
    const command = calls.get(t.call)?.command;
    return { id: t.id, description: t.description || "", command: typeof command === "string" ? command : null };
  });
}

/**
 * The cache split of the first model request of a Claude run: its first assistant message's `usage` (stream-json
 * repeats one message per content block, all with the same usage). `cache_creation` splits the writes by TTL, so the
 * record shows which TTL the request used. Null when the run printed no assistant message with usage.
 */
function claudeFirstRequest(lines) {
  const u = lines.find((l) => l?.type === "assistant" && !l.parent_tool_use_id && l.message?.usage)?.message.usage;
  if (!u) return null;
  const cached = num(u.cache_read_input_tokens);
  const written = num(u.cache_creation_input_tokens);
  return {
    unit: "request",
    input: add(num(u.input_tokens), add(cached, written)),
    cached,
    written,
    written1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
    written5m: num(u.cache_creation?.ephemeral_5m_input_tokens),
  };
}

const writeShare = (t) => (t?.written === null || t?.written === undefined || !t?.input ? null : Math.round((t.written / t.input) * 1000) / 1000);

/**
 * What the cache did across one stage's runs, for the usage record: the TTL Pendulum asked for, the stage's cache-write
 * share (writes over all input tokens; null when the harness reports no writes), and, for each run that follows a CI
 * wait (a validation fix pass), the minutes waited and its first request's split (`first.unit` says whether the harness
 * reports a request, a turn, or nothing finer than the run). The setting is kept only if these writes drop.
 */
export function cacheSummary(records) {
  // The stage's decision record (harness.mjs keepDecision) is no pass: no cache split, no wait, no write share of its own.
  const live = records.filter((r) => r && !r.decision);
  const tokens = mergeUsage(live)?.tokens ?? null;
  const afterWait = [];
  live.forEach((r, i) => {
    if (!/-fix-\d+$/.test(r.label || "")) return;
    const prev = live[i - 1];
    const waited = prev?.ended && r.started ? Math.round(((Date.parse(r.started) - Date.parse(prev.ended)) / 60000) * 10) / 10 : null;
    afterWait.push({ label: r.label, waitMin: Number.isFinite(waited) ? waited : null, resumed: !!r.resumed, first: r.cache?.first ?? null, writeShare: writeShare(r.tokens) });
  });
  const ttlSeconds = live.map((r) => r.cache?.ttlSeconds).filter((t) => typeof t === "number").at(-1) ?? null;
  return { ttl: live.find((r) => r.cacheTtl)?.cacheTtl ?? null, ...(ttlSeconds === null ? {} : { harnessTtlSeconds: ttlSeconds }), writeShare: writeShare(tokens), afterWait };
}

/** Price Codex tokens from the table (a provider prefix stripped); null when the model is not listed. */
export const priceCodex = (model, tokens, opts = {}) => priceTokens(CODEX_PRICES, model, tokens, opts);

/**
 * Codex: `codex exec --json` prints JSONL ending in one `turn.completed` whose
 * `usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` is the
 * thread's running total (codex-rs exec builds it from the thread's total token usage, and shuts down after a completed
 * turn), so a stream with more than one is read at its last, never summed. `codex exec resume` restores the running
 * total (sinceSession takes a resumed pass's
 * share). `input_tokens` already includes the cached and the written parts and `output_tokens` the reasoning
 * part, so neither is added again. Sub-agent threads (`spawn_agent`) are threads of their own, in
 * neither: runHarness adds them from their rollouts (codex-threads.mjs). Dollars come from the price table. An `item.completed` of type `error` followed by a completed
 * turn is a warning (Codex 0.167 reports a resumed thread's model change that way), not a failure. A stream `error` or
 * `turn.failed` event (a dropped stream Codex reconnects, a failed request) may be a request the provider billed whose
 * tokens Codex never reports: the run then has unknown spend (UNKNOWN_WHY `failed-request`) beside what its turns
 * reported. No turn completed is `unreported`; a model with no price row, `no-price`. `rollout` (the thread's rollout text)
 * and `since` (the pass's start, ISO) let a failed run's usage limit be read (providerRefusal). `requests` (the thread's
 * rollout text, its `token_count` lines; `rollout` when not given) prices a run past the long-context threshold per
 * request (rolloutLong, kept as `tokens.long`); without it such a run is of unknown cost (`long-context`). `at` dates
 * the spend for a promotional rate (codexRow; now when omitted).
 */
export function parseCodex(stdout, model, { rollout = null, since = null, requests = rollout, at } = {}) {
  const rec = empty("codex", model);
  const events = jsonLines(stdout);
  if (!events.length) {
    rec.error = "no JSONL events on stdout";
    rec.basis = CODEX_NO_TOKENS;
    return markUnknown(rec, "unreported");
  }
  let input = null;
  let output = null;
  let cached = null;
  let written = null;
  let turns = 0;
  let failed = null;
  let itemError = null;
  let first = null;
  for (const e of events) {
    if (e.type === "thread.started" && e.thread_id) rec.sessionId = e.thread_id;
    if (e.type === "turn.completed") {
      turns += 1;
      // An item error the turn completed after was a warning.
      itemError = null;
      const u = e.usage || {};
      // Codex reports usage per turn, not per request; cache writes where the provider bills them (the AI Gateway does).
      if (!first) first = { unit: "turn", input: num(u.input_tokens), cached: num(u.cached_input_tokens), written: num(u.cache_write_input_tokens) };
      // Each turn.completed carries the thread's running total, not the turn's share: the last one is the process's. A
      // count it does not report keeps its value before it.
      input = num(u.input_tokens) ?? input;
      output = num(u.output_tokens) ?? output;
      cached = num(u.cached_input_tokens) ?? cached;
      written = num(u.cache_write_input_tokens) ?? written;
    }
    if (e.type === "turn.failed" || e.type === "error") {
      failed = e.error?.message || e.message || e.type;
      markUnknown(rec, "failed-request");
    }
    if (e.type === "item.completed" && e.item?.type === "error") itemError = e.item.message || "item error";
    // Sub-agent work (spawn, wait, message): its threads' usage is not in this stream (codex-threads.mjs).
    if ((e.type === "item.started" || e.type === "item.completed") && e.item?.type === "collab_tool_call") rec.subAgentWork = true;
  }
  failed = failed || itemError;
  rec.turns = turns;
  rec.tokens = { input, output, cached, written };
  rec.cache = { first };
  rec.ok = turns > 0 && !failed;
  rec.error = failed;
  const refusal = rec.ok ? null : providerRefusal("codex", events, { rollout, since });
  if (refusal) rec.refusal = refusal;
  const busy = rec.ok || refusal ? null : providerBusy("codex", events);
  if (busy) rec.busy = busy;
  // Its provider error (providerError) when it is no refusal and no busy answer; also `providerOutage` when it names a
  // provider or network failure with no status (outageError).
  const failure = rec.ok || refusal || busy ? null : providerError("codex", events);
  if (failure) rec.providerError = failure;
  if (outageError(failure)) rec.providerOutage = failure;
  // A resume the provider refused because the thread was written through another credential: runHarness runs it fresh.
  if (!rec.ok && rotatedPin("codex", events)) rec.pinRotated = true;
  // The part of the thread's running total from requests over the long-context threshold, per request from its rollout;
  // a total at most that has none (no one request in it is larger).
  const above = CODEX_PRICES.longContextAbove;
  if ((input ?? 0) > above) rec.tokens.long = rolloutLong(requests, rec.tokens, above);
  const priced = codexPrice(CODEX_PRICES, rec.model, rec.tokens, { at });
  rec.usd = priced.usd;
  const why = rec.usd !== null ? null : input === null && output === null ? "unreported" : priced.why ?? "no-price";
  rec.basis = why === null ? priceBasis() : why === "unreported" ? CODEX_NO_TOKENS : !rec.model ? "unknown: Codex names no model in its output; set the model input so tokens are priced" : why === "no-price" ? `unknown: no price for ${rec.model}` : `unknown: ${UNKNOWN_WHY[why]} (${rec.model})`;
  if (why) markUnknown(rec, why);
  return rec;
}

/**
 * GitHub's published rate: "1 AI credit = $0.01 USD" (docs.github.com/en/copilot/reference/copilot-billing/
 * models-and-pricing, read 2026-11-08). Copilot has billed AI credits by tokens since June 1, 2026; premium requests
 * remain a count, and only legacy annual plans are billed by them. The `copilot_credit_usd` setting overrides it.
 */
export const COPILOT_CREDIT_USD = 0.01;

/** The AI-credit states Copilot writes; anything else reads as `unknown` and is not priced. */
const CREDIT_STATUS = /^(complete|partial|pending|unavailable)$/;
/** A model name as Pendulum logs it: no newline, no `::` workflow command, nothing but a model id's characters. */
const cleanModel = (name) => String(name ?? "").replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 100) || null;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const nonNegative = (v) => (num(v) !== null && v >= 0 ? v : null);

/**
 * One Copilot accounting snapshot (the `--usage-output-file` JSON, or the `accountingSnapshot` of a saved session's
 * `session.shutdown` event, which has the same shape): tokens, model, premium requests, AI credits in billionths
 * (`nano`), the credit status and the session's start time. Null fields are what the snapshot did not report; a
 * negative count is not a count.
 */
function copilotAccounting(u) {
  const out = { tokens: { input: null, output: null, cached: null, written: null }, model: null, premiumRequests: null, nano: null, negative: false, status: null, sessionStartTime: null };
  if (!u || typeof u !== "object") return out;
  const models = u.modelMetrics && typeof u.modelMetrics === "object" ? Object.entries(u.modelMetrics) : [];
  for (const [name, m] of models) {
    const t = m?.usage || {};
    out.tokens.input = add(out.tokens.input, nonNegative(t.inputTokens));
    out.tokens.output = add(out.tokens.output, add(nonNegative(t.outputTokens), nonNegative(t.reasoningTokens)));
    out.tokens.cached = add(out.tokens.cached, nonNegative(t.cacheReadTokens));
    out.tokens.written = add(out.tokens.written, nonNegative(t.cacheWriteTokens));
    if (!out.model) out.model = cleanModel(name);
  }
  if (!models.length && u.tokenDetails) {
    const d = u.tokenDetails;
    out.tokens.input = add(nonNegative(d.input?.tokenCount), add(nonNegative(d.cache_read?.tokenCount), nonNegative(d.cache_write?.tokenCount)));
    out.tokens.output = nonNegative(d.output?.tokenCount);
    out.tokens.cached = nonNegative(d.cache_read?.tokenCount);
    out.tokens.written = nonNegative(d.cache_write?.tokenCount);
  }
  out.premiumRequests = nonNegative(u.totalPremiumRequestCost);
  out.nano = nonNegative(u.totalNanoAiu);
  out.negative = num(u.totalNanoAiu) !== null && u.totalNanoAiu < 0;
  if (u.aiCreditsStatus !== undefined && u.aiCreditsStatus !== null) out.status = CREDIT_STATUS.test(String(u.aiCreditsStatus)) ? u.aiCreditsStatus : "unknown";
  if (typeof u.sessionStartTime === "string" && ISO.test(u.sessionStartTime)) out.sessionStartTime = u.sessionStartTime;
  return out;
}

/**
 * The dollars for `nano` billionths of an AI credit at `creditUsd`, or why there are none. Unknown (usd null), never
 * $0: no credits reported, a negative count, a `pending`, `unavailable` or unknown status, or zero credits for a run
 * that used tokens. A `partial` status prices the credits reported, and the rest is unknown (`partial`).
 */
function priceCredits({ nano, negative, status, tokens }, creditUsd) {
  if (negative) return { aiu: null, usd: null, why: "a negative AI credit count" };
  if (nano === null) return { aiu: null, usd: null, why: "no AI credits reported" };
  if (status && status !== "complete" && status !== "partial") return { aiu: null, usd: null, why: `AI credits ${status}` };
  if (nano === 0 && ((tokens?.input ?? 0) > 0 || (tokens?.output ?? 0) > 0)) return { aiu: 0, usd: null, why: "zero AI credits for a run that used tokens" };
  return { aiu: Math.round(nano / 1e6) / 1e3, usd: Math.round((nano / 1e9) * creditUsd * 10000) / 10000, partial: status === "partial", why: null };
}

/**
 * The running total a saved Copilot session last recorded (its `events.jsonl`'s last `session.shutdown` accounting
 * snapshot), in sinceSession's shape plus premium requests, AI credits and the session's start time; null when there
 * is none or it is not priced. The file is the harness's to write: clampTotal bounds it by what Pendulum recorded.
 */
export function copilotSessionTotal(text, creditUsd = COPILOT_CREDIT_USD) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.includes('"session.shutdown"'));
  const last = jsonLines(lines.join("\n")).filter((l) => l?.type === "session.shutdown" && l.data?.accountingSnapshot).at(-1);
  if (!last) return null;
  const a = copilotAccounting(last.data.accountingSnapshot);
  const p = priceCredits(a, creditUsd);
  return p.usd === null ? null : { usd: p.usd, tokens: a.tokens, models: null, premiumRequests: a.premiumRequests, aiu: p.aiu, sessionStartTime: a.sessionStartTime };
}

/**
 * A restored session's prior total, bounded field by field by what Pendulum itself recorded: the session's running
 * total in the saving stage's result.json (`sessionTotal`, which spans every stage the session ran in), else that
 * stage's own figures. A total the harness could edit never lowers the next pass's count below what was billed. Null
 * when Pendulum recorded no dollars, so nothing is subtracted.
 */
export function clampTotal(seed, saved) {
  const recorded = saved?.sessionTotal && typeof saved.sessionTotal.usd === "number" ? { ...saved.sessionTotal, aiCredits: saved.sessionTotal.aiu } : saved;
  if (!seed || typeof recorded?.usd !== "number" || recorded.usd < 0) return null;
  const min = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.min(a, b) : null);
  const t = seed.tokens ?? {};
  const rt = recorded.tokens ?? {};
  return { ...seed, usd: Math.min(seed.usd, recorded.usd), aiu: min(seed.aiu, recorded.aiCredits), premiumRequests: min(seed.premiumRequests, recorded.premiumRequests), tokens: { input: min(t.input, rt.input), output: min(t.output, rt.output), cached: min(t.cached, rt.cached), written: min(t.written, rt.written) } };
}

/**
 * Copilot 1.0.107: `copilot --output-format json` (the prompt on stdin) prints JSONL whose last line is
 * `{type: "result", sessionId, exitCode, usage: {premiumRequests, ...}}`, with one `assistant.turn_end` per turn, the
 * model named on `assistant.message`, and `session.usage_checkpoint` lines carrying `totalNanoAiu` and
 * `totalPremiumRequests`; `--usage-output-file` writes `{totalPremiumRequestCost, totalNanoAiu, aiCreditsStatus,
 * sessionStartTime, modelMetrics: {<model>: {requests: {count, cost}, usage: {inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens, reasoningTokens}}}}` (sub-agents under agentMetrics, already summed into
 * modelMetrics). Tokens come from that file. Premium requests and AI credits are the larger of the file's and the
 * stream's, so a usage file rewritten low loses; the dollars are those credits at `creditUsd` (GitHub's $0.01 by
 * default), or unknown (priceCredits). On `--resume` every count is the session's running total (sinceSession takes
 * this pass's share). A non-zero exit is a harness error, not a death.
 */
export function parseCopilot(stdout, model, exitCode = 0, { usageFile, creditUsd = COPILOT_CREDIT_USD } = {}) {
  const rec = empty("copilot", model);
  rec.ok = exitCode === 0;
  rec.subtype = rec.ok ? "success" : "error";
  if (!rec.ok) rec.error = `copilot exited ${exitCode}`;
  let turns = 0;
  // Whether the run printed its result line: one killed before it reported its usage only up to its last checkpoint.
  let ended = false;
  let streamNano = null;
  let streamRequests = null;
  let ttlSeconds = null;
  const events = jsonLines(stdout);
  for (const e of events) {
    if (e.type === "assistant.turn_end") turns += 1;
    if (e.type === "assistant.message" && e.data?.model && !rec.model) rec.model = cleanModel(e.data.model);
    if (e.type === "session.usage_checkpoint") {
      const n = nonNegative(e.data?.totalNanoAiu);
      const r = nonNegative(e.data?.totalPremiumRequests);
      if (n !== null) streamNano = Math.max(streamNano ?? 0, n);
      if (r !== null) streamRequests = Math.max(streamRequests ?? 0, r);
      // Copilot picks its own cache TTL and says which in each usage checkpoint.
      for (const m of e.data?.modelCacheState || []) if (num(m?.cacheTtlSeconds) !== null) ttlSeconds = num(m.cacheTtlSeconds);
    }
    if (e.type === "result") {
      ended = true;
      if (e.sessionId) rec.sessionId = String(e.sessionId);
      const r = nonNegative(e.usage?.premiumRequests);
      if (r !== null) streamRequests = Math.max(streamRequests ?? 0, r);
      if (typeof e.exitCode === "number" && e.exitCode !== 0 && rec.ok) {
        rec.ok = false;
        rec.subtype = "error";
        rec.error = `copilot reported exit ${e.exitCode}`;
      }
    }
  }
  let a = copilotAccounting(null);
  if (usageFile && existsSync(usageFile)) {
    try {
      a = copilotAccounting(JSON.parse(readFileSync(usageFile, "utf8")));
    } catch {
      // unreadable usage file: tokens stay null; the stream's totals still count
    }
  }
  if (streamNano !== null && (a.nano === null || streamNano > a.nano)) a = { ...a, nano: streamNano, negative: false, fromStream: true };
  const requests = Math.max(a.premiumRequests ?? -1, streamRequests ?? -1);
  if (requests >= 0) rec.premiumRequests = requests;
  if (!rec.model) rec.model = a.model;
  const p = priceCredits(a, creditUsd);
  const refusal = rec.ok ? null : providerRefusal("copilot", events);
  if (refusal) rec.refusal = refusal;
  const busy = rec.ok || refusal ? null : providerBusy("copilot", events);
  if (busy) rec.busy = busy;
  // Its provider error (providerError) when it is no refusal and no busy answer; also `providerOutage` when it names a
  // provider or network failure with no status (outageError).
  const failure = rec.ok || refusal || busy ? null : providerError("copilot", events);
  if (failure) rec.providerError = failure;
  if (outageError(failure)) rec.providerOutage = failure;
  if (p.aiu !== null) rec.aiu = p.aiu;
  // Credits not reported in full: the run's spend is unknown beyond what was (UNKNOWN_WHY), never $0 and never a bound.
  if (p.usd === null) markUnknown(rec, a.tokens.input === null && a.tokens.output === null && a.nano === null ? "unreported" : "credits");
  else if (p.partial) markUnknown(rec, "credits");
  // Killed before its result line: the credits its last checkpoint reported are known, what it spent after is not.
  if (p.usd !== null && !ended) markUnknown(rec, "unreported");
  rec.sessionStartTime = a.sessionStartTime;
  rec.turns = turns || null;
  rec.tokens = a.tokens;
  rec.usd = p.usd;
  // Copilot reports usage per run, not per request: no first-request split, only the run's write share and its TTL.
  rec.cache = { first: null, ttlSeconds };
  const req = rec.premiumRequests !== undefined ? `, ${rec.premiumRequests} premium request(s)` : "";
  const source = a.fromStream ? "the stream's usage checkpoint" : "copilot --usage-output-file";
  rec.basis =
    p.usd !== null
      ? `harness-reported: ${rec.aiu} AI credits from ${source} at $${creditUsd}/credit${p.partial ? " (AI credits partial: the rest unknown)" : ""}${req}`
      : a.tokens.input === null && a.tokens.output === null && a.nano === null
        ? `unknown: Copilot wrote no usage${req}`
        : `unknown: ${p.why}${req}`;
  return rec;
}

/** One entry point: harness name to parser. A provider's refusal, or its busy answer, is the run's error, in its structured fields. */
export function parseUsage(harness, stdout, model, exitCode = 0, extra = {}) {
  const parse = { claude: () => parseClaude(stdout, model), codex: () => parseCodex(stdout, model, extra), copilot: () => parseCopilot(stdout, model, exitCode, extra) }[harness];
  if (!parse) throw new Error(`unknown harness ${harness}`);
  const rec = parse();
  if (rec.refusal) rec.error = `refused by the provider: ${refusalFields(rec.refusal)}`;
  else if (rec.busy) rec.error = `the provider was busy: ${refusalFields(rec.busy)}`;
  return rec;
}

/** A refusal's structured fields in one line: "HTTP 400 invalid_request_error <code>". */
export const refusalFields = (r) => [r.status !== null ? `HTTP ${r.status}` : null, r.type, r.code].filter(Boolean).join(" ");

/** Per-model totals summed across runs; undefined when no run reported a split. */
function mergeModels(a, b) {
  if (!a && !b) return undefined;
  const out = { ...(a ?? {}) };
  for (const [name, m] of Object.entries(b ?? {})) {
    const p = out[name];
    out[name] = p ? { input: add(p.input, m.input), cached: add(p.cached, m.cached), written: add(p.written, m.written), output: add(p.output, m.output), usd: add(p.usd, m.usd) } : m;
  }
  return out;
}

const less = (a, b) => (a === null || a === undefined ? null : Math.max(0, a - (b ?? 0)));

/** The first Claude Code whose resumed `claude -p` carries the session's running totals on (Anthropic's cost-tracking docs). */
export const CLAUDE_RUNNING_TOTALS = [2, 1, 277];

/** Whether Claude Code `version` (its stream's `claude_code_version`, "2.1.325") reports a resumed session's running total. */
export function claudeRunningTotals(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version ?? ""));
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  const at = v.findIndex((x, i) => x !== CLAUDE_RUNNING_TOTALS[i]);
  // A pre-release of 2.1.277 itself comes before it (semver).
  return at === -1 ? !m[4] : v[at] > CLAUDE_RUNNING_TOTALS[at];
}

/** The UNKNOWN_WHY codes a Codex price gives (codexPrice): a record's other reasons are its run's, not its price's. */
const PRICE_WHY = new Set(["no-price", "price-ended", "long-context"]);

/**
 * A Codex pass's dollars from its own share `tokens` (sinceSession): `{usd, basis, usdUnknown?, usdUnknownWhy?}`, the
 * record's reasons other than its price's kept, and the share's own price reason added when it cannot be priced. A run
 * that reported no tokens keeps its record's dollars and reasons.
 */
function ownCodexPrice(rec, tokens, { at } = {}) {
  if (!runningTokens(rec.tokens)) return { usd: rec.usd ?? null };
  const p = codexPrice(CODEX_PRICES, rec.model, tokens, { at });
  const why = [...(Array.isArray(rec.usdUnknownWhy) ? rec.usdUnknownWhy : []).filter((w) => !PRICE_WHY.has(w)), ...(p.usd === null ? [p.why ?? "no-price"] : [])];
  const out = { usd: p.usd, basis: p.usd === null ? (rec.model ? (p.why === "no-price" || !p.why ? `unknown: no price for ${rec.model}` : `unknown: ${UNKNOWN_WHY[p.why]} (${rec.model})`) : rec.basis) : priceBasis() };
  return why.length ? { ...out, usdUnknown: Math.max(1, Number.isInteger(rec.usdUnknown) ? rec.usdUnknown : 0), usdUnknownWhy: [...new Set(why)] } : { ...out, usdUnknown: undefined, usdUnknownWhy: undefined };
}

/**
 * Claude Code, Codex and Copilot report a resumed session's cost or tokens as the session's running total, so a pass
 * that resumes an earlier session is counted as its own share: the total minus the total that session had already
 * reported (in this process, or in its restored transcript or Pendulum's record of it). Turns are per process and stay.
 * Codex's first-turn cache split is that running total too, so it is counted the same way. A Claude Code before 2.1.277
 * (claudeRunningTotals; or one whose stream named no version) may restart a resumed session's totals at zero, and a
 * total below the one already counted is no running total of it: either pass's dollars and tokens are unknown
 * (UNKNOWN_WHY `resumed-total`), neither its total nor a share of it taken.
 */
export function sinceSession(rec, prior, { at } = {}) {
  // Codex's running total is its tokens, priced here: a prior total whose dollars were unknown (a pass past the
  // long-context threshold whose requests were not read, a promotional rate that had ended) is still subtracted. A
  // prior with no token counts is taken by its dollars, as every other harness's.
  const codex = rec?.harness === "codex" && runningTokens(prior?.tokens);
  if (!rec || !prior || (!codex && (prior.usd === null || prior.usd === undefined))) return rec;
  // No running total: the pass's dollars and tokens are unknown, neither its total nor a share of it taken.
  const notRunning = (why) => {
    const out = { ...rec, usd: null, tokens: { input: null, output: null, cached: null, written: null }, basis: `unknown: ${why}` };
    delete out.models;
    return markUnknown(out, "resumed-total");
  };
  if (rec.harness === "claude" && !claudeRunningTotals(rec.harnessVersion)) return notRunning(`a resumed Claude session on ${rec.harnessVersion ? `Claude Code ${rec.harnessVersion}` : "a Claude Code that named no version"}, whose totals may restart at zero before 2.1.277`);
  // Copilot: only a total from the same session start is a running total of the one subtracted (Copilot keeps the
  // start time across --resume); anything else is counted as reported.
  if (rec.harness === "copilot" && (!rec.sessionStartTime || rec.sessionStartTime !== prior.sessionStartTime)) return rec;
  // A total below the one already counted is no running total of it: unknown, neither it nor a share of it taken. Its
  // harness reports running totals (a Claude Code from 2.1.277, checked above), so the session's later totals run on
  // from this one: `newBase` says so, and the pass's runner keeps it as the session's total.
  if (codex && runningTokens(rec.tokens) && TOKEN_KEYS.some((k) => (rec.tokens[k] ?? 0) < (prior.tokens[k] ?? 0))) return { ...notRunning(`the resumed Codex thread reported ${rec.tokens.input} input tokens, below the ${prior.tokens.input} already counted for it`), newBase: true };
  if (!codex && rec.usd !== null && rec.usd !== undefined && rec.usd < prior.usd) return { ...notRunning(`the resumed session reported $${rec.usd}, below the $${prior.usd} already counted for it`), newBase: true };
  const models = rec.models
    ? Object.fromEntries(Object.entries(rec.models).map(([name, m]) => {
        const p = prior.models?.[name] ?? {};
        return [name, { input: less(m.input, p.input), cached: less(m.cached, p.cached), written: less(m.written, p.written), output: less(m.output, p.output), usd: less(m.usd, p.usd) }];
      }))
    : rec.models;
  const t = rec.tokens ?? {};
  const pt = prior.tokens ?? {};
  const counts = Object.fromEntries(["premiumRequests", "aiu"].filter((k) => typeof rec[k] === "number").map((k) => [k, Math.round(less(rec[k], prior[k]) * 1000) / 1000]));
  const first = rec.cache?.first;
  const cache = rec.harness === "codex" && first ? { cache: { ...rec.cache, first: { ...first, input: less(first.input, pt.input), cached: less(first.cached, pt.cached), written: less(first.written, pt.written) } } } : {};
  const own = { input: less(t.input, pt.input), output: less(t.output, pt.output), cached: less(t.cached, pt.cached), written: less(t.written, pt.written) };
  // A Codex pass's long-context share: its running share less the one before (unknown when either is).
  const above = CODEX_PRICES.longContextAbove;
  const tokens = codex ? withLong(own, sumLong([longShare(t, above), longShare(pt, above)], -1), above) : own;
  // A Codex pass's own share is priced on its own (`at` dates it for a promotional rate), and its price's reasons for
  // unknown cost are its share's, not the running total's.
  const priced = codex ? ownCodexPrice(rec, tokens, { at }) : { usd: less(rec.usd, prior.usd) };
  const out = { ...rec, ...counts, ...cache, ...priced, tokens, models, sessionTotal: { usd: rec.usd, tokens: rec.tokens, models: rec.models, ...(rec.premiumRequests === undefined ? {} : { premiumRequests: rec.premiumRequests }), ...(rec.aiu === undefined ? {} : { aiu: rec.aiu }), ...(rec.sessionStartTime ? { sessionStartTime: rec.sessionStartTime } : {}) } };
  for (const k of ["usdUnknown", "usdUnknownWhy"]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Several records of one stage summed: the known dollars, tokens, turns and credits, and its runs of unknown cost (unknownOf). */
export function mergeUsage(records) {
  // A stage's decision record (harness.mjs keepDecision) is never the base: its label, basis and model are no pass's.
  const all = records.filter(Boolean);
  const live = [...all.filter((r) => !r.decision), ...all.filter((r) => r.decision)];
  if (!live.length) return null;
  const first = live[0];
  // A negative dollar figure is no spend: it never lowers a total (every harness).
  const spend = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : null);
  const out = { ...first, usd: spend(first.usd), tokens: { ...first.tokens } };
  // The runs of unknown cost in it, from every record (UNKNOWN_WHY): `usd` is the known dollars only.
  delete out.usdUnknown;
  delete out.usdUnknownWhy;
  Object.assign(out, unknownOf(live));
  for (const r of live.slice(1)) {
    out.usd = spend(r.usd) === null && out.usd === null ? null : (out.usd ?? 0) + (spend(r.usd) ?? 0);
    out.tokens.input = add(out.tokens.input, r.tokens.input);
    out.tokens.output = add(out.tokens.output, r.tokens.output);
    out.tokens.cached = add(out.tokens.cached, r.tokens.cached);
    out.tokens.written = add(out.tokens.written, r.tokens.written ?? null);
    if (r.models) out.models = mergeModels(out.models, r.models);
    out.turns = add(out.turns, r.turns);
    for (const k of ["premiumRequests", "aiu"]) if (typeof r[k] === "number") out[k] = Math.round(((out[k] ?? 0) + r[k]) * 1000) / 1000;
    out.ok = out.ok && r.ok;
    out.error = out.error || r.error;
    out.budgetExceeded = out.budgetExceeded || r.budgetExceeded;
    // The stage's end is its latest record's (a decision call is listed last but may have ended before a pass).
    if (Number.isFinite(Date.parse(r.ended)) && !(Date.parse(r.ended) <= Date.parse(out.ended))) out.ended = r.ended;
  }
  // Codex's long-context shares, summed (unknown when any is: usage.mjs longShare).
  if (first.harness === "codex") out.tokens = withLong(out.tokens, sumLong(live.map((r) => longShare(r.tokens, CODEX_PRICES.longContextAbove))), CODEX_PRICES.longContextAbove);
  return out;
}
