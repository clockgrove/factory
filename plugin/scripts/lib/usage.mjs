// Normalize each harness's headless output into one usage record:
//   {harness, model, usd, tokens: {input, output, cached}, basis, started, ended,
//    sessionId, subtype, ok, error, turns}
// usd is null when the run is unmetered (a Copilot run whose AI credits are missing,
// pending or unavailable, or a Codex model missing from the price table), never zero. `basis` says where the dollars came from, so the scorecard shows it.
// A count a harness does not report is null, never zero.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Codex prices, USD per million tokens: the one table (codex-prices.json beside this file), which the bench reads too.
 * Codex reports tokens, not dollars, so the worker prices them here; the bench re-prices from the same file. The table
 * records its date and sources. Unknown models give usd: null and basis "unmetered: no price for <model>"; a run that
 * reported no tokens at all (no turn completed) gives CODEX_NO_TOKENS instead, whatever the model.
 */
export const CODEX_PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "codex-prices.json"), "utf8"));

/** A model id without its provider prefix: `openai/gpt-6.1-sol` (the AI Gateway's form) is `gpt-6.1-sol`. */
export const bareModel = (model) => String(model ?? "").replace(/^[A-Za-z0-9._-]+\//, "");

/**
 * The table's rates for `model`, or null: its exact id after any provider prefix, or that id plus a dated snapshot suffix
 * (`gpt-5.5-2026-04-23`). Nothing else matches, so `gpt-5-mini` never takes `gpt-5`'s rates: an unlisted model is
 * unmetered, not mispriced. Short-context rates (the table's `long` entry is recorded, not applied: Codex reports usage
 * per turn, so no request's context size is visible).
 */
export function codexRate(table, model) {
  const id = bareModel(model);
  if (!id || !table?.perMillion) return null;
  const snapshot = id.match(/^(.+)-\d{4}-\d{2}-\d{2}$/)?.[1];
  const p = (Object.hasOwn(table.perMillion, id) && table.perMillion[id]) || (snapshot && Object.hasOwn(table.perMillion, snapshot) && table.perMillion[snapshot]) || null;
  const rate = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return p && [p.input, p.cached, p.output].every(rate) && (p.write === undefined || rate(p.write)) ? p : null;
}

/**
 * USD for Codex `tokens` at `table`'s rates, rounded to 1/100 cent; null when the model is unlisted or nothing was
 * reported. `input` includes the cached and the written tokens (Codex's input_tokens counts both): the cached part at the
 * cached rate, the written part (cache_write_input_tokens) at the write rate, or the input rate for a model with none.
 */
export function priceTokens(table, model, tokens) {
  if (!model || !tokens) return null;
  if (tokens.input === null && tokens.output === null) return null; // nothing reported is unmetered, not free
  const p = codexRate(table, model);
  if (!p) return null;
  const cached = tokens.cached ?? 0;
  const written = tokens.written ?? 0;
  const uncached = Math.max(0, (tokens.input ?? 0) - cached - written);
  const usd = uncached * p.input + cached * p.cached + written * (p.write ?? p.input) + (tokens.output ?? 0) * p.output;
  return Math.round((usd / 1e6) * 10000) / 10000;
}

/**
 * A Codex stage's dollars from its usage record at `table`'s rates: its sub-agent threads (`subAgents`, each run's own
 * share, codex-threads.mjs) each at its own model, the rest of `tokens` at `model`. `{usd, lowerBound}`: a sub-agent
 * whose model is unlisted leaves the dollars a lower bound; usd is null only when nothing could be priced.
 */
export function priceStage(table, model, tokens, subAgents = []) {
  const subs = (Array.isArray(subAgents) ? subAgents : []).filter((t) => t?.tokens && typeof t.tokens === "object");
  if (!subs.length) return { usd: priceTokens(table, model, tokens), lowerBound: false };
  const sum = (k) => subs.reduce((n, t) => n + (typeof t.tokens[k] === "number" ? t.tokens[k] : 0), 0);
  const rest = Object.fromEntries(["input", "output", "cached", "written"].map((k) => [k, tokens?.[k] === null || tokens?.[k] === undefined ? null : Math.max(0, tokens[k] - sum(k))]));
  let usd = priceTokens(table, model, rest);
  let lowerBound = false;
  for (const t of subs) {
    const p = priceTokens(table, t.model || model, t.tokens);
    if (p === null) lowerBound = true;
    else if (usd === null) {
      usd = p;
      lowerBound = true;
    } else usd += p;
  }
  return { usd: usd === null ? null : Math.round(usd * 10000) / 10000, lowerBound };
}

/**
 * The warning for a Codex model with no row in the price table, else null: its runs are unmetered, so `max_usd` and
 * `daily_usd` cannot stop them (Codex has no in-run cap; Factory checks dollars after each run) and only a budget on the
 * provider's key does. Doctor and the stage's progress comment say it.
 */
export function unpricedCodex(harness, model, { gateway = false } = {}) {
  if (harness !== "codex" || !model || codexRate(CODEX_PRICES, model)) return null;
  return `${bareModel(model)} has no row in the Codex price table (dated ${CODEX_PRICES.date}): its runs are unmetered, so max_usd and daily_usd cannot stop them; only ${gateway ? "the AI Gateway key's budget" : "the provider key's own limit"} does`;
}

/**
 * The basis of a Codex run that reported no token counts: no `turn.completed` (a refused request, a turn cut short). Its
 * spend is unknown, not zero (a cut turn may have spent tokens), and no price is missing. The bench says the same
 * (bench/lib/cost.mjs costOf), so the worker's record and the scorecard agree.
 */
export const CODEX_NO_TOKENS = "unmetered: no Codex turn completed, so Codex reported no tokens";
const priceBasis = () => `priced from table dated ${CODEX_PRICES.date}${CODEX_PRICES.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}`;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const add = (a, b) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

function empty(harness, model) {
  return {
    harness,
    model: model ?? null,
    usd: null,
    tokens: { input: null, output: null, cached: null, written: null },
    basis: "unmetered",
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
 * Error types and codes that no retry can pass, whatever the status: an exhausted quota or billing (OpenAI's
 * `insufficient_quota` comes as a 429, so the status alone reads it as a rate limit), a rejected key, and the Vercel AI
 * Gateway's budget (`quota_for_entity_exceeded`, HTTP 402) and payment-method (`customer_verification_required`, 403)
 * types, which decide a gateway body that carries no status.
 */
const REFUSED_KINDS = new Set(["insufficient_quota", "billing_error", "quota", "authentication", "authentication_failed", "authentication_error", "invalid_api_key", "authorization", "quota_for_entity_exceeded", "customer_verification_required"]);
/** 4xx statuses that are worth retrying: a timeout, a conflict, too early, a rate limit. */
const RETRYABLE_4XX = new Set([408, 409, 425, 429]);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The provider error a failed Codex run ended on, as structure: {status, type, code, message} from the last `turn.failed`
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
  return { status: num(body.status), type: str(body.error.type), code: str(body.error.code), message: str(body.error.message) };
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
 * type or code), never on the message's words; a 429 rate limit, a 5xx or a transport error (no status) is null, so
 * the run stays a death or a harness error as before. The parsers ask only for a run that failed. Each harness's structure:
 *   claude  : the result line with is_error and `api_error_status`; the type is the API error message's `error`
 *   codex   : the last `turn.failed` (else `error`) event, whose `error.message` is the provider's JSON error body
 *             ({status, error: {type, code, message}}), or the AI Gateway's bare body ({error: {type, message}}, no
 *             status: decided by its type); a message that is not a JSON object is prose: null
 *   copilot : the main agent's last `session.error` event's data {statusCode, errorType, errorCode, message}
 */
export function providerRefusal(harness, events) {
  let r = null;
  if (harness === "claude") {
    const res = [...events].reverse().find((e) => e?.type === "result");
    const api = [...events].reverse().find((e) => e?.type === "assistant" && e.is_api_error_message === true);
    const status = num(res?.api_error_status) ?? num(api?.api_error_status);
    if (res?.is_error !== true || status === null) return null;
    r = { status, type: str(api?.error), code: null, message: str(res.result) };
  } else if (harness === "codex") {
    r = codexError(events);
    if (!r) return null;
  } else if (harness === "copilot") {
    const d = [...events].reverse().find((e) => e?.type === "session.error" && !e.agentId)?.data;
    if (!d || typeof d !== "object") return null;
    r = { status: num(d.statusCode), type: str(d.errorType), code: str(d.errorCode), message: str(d.message) };
  } else return null;
  const kind = REFUSED_KINDS.has(r.type) || REFUSED_KINDS.has(r.code);
  const refused = r.status !== null ? r.status >= 400 && r.status < 500 && (!RETRYABLE_4XX.has(r.status) || kind) : kind;
  return refused ? { harness, ...r } : null;
}

/**
 * Claude Code's per-model usage (`modelUsage` in a result, or in a transcript's cost-state line) as Factory's models,
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
  const refusal = providerRefusal("claude", lines);
  if (refusal) rec.refusal = refusal;
  if (!result) {
    rec.error = "no JSON result on stdout";
    rec.sessionId = init?.session_id ?? null; // a crashed process still has a session to resume
    return rec;
  }
  rec.subtype = result.subtype ?? null;
  rec.sessionId = result.session_id ?? init?.session_id ?? null;
  rec.turns = num(result.num_turns);
  rec.budgetExceeded = result.subtype === "error_max_budget_usd";
  rec.ok = result.is_error !== true && (result.subtype === "success" || result.subtype === undefined);
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
    rec.basis = rec.usd === null ? "unmetered" : "harness-reported: total_cost_usd, usage (sub-agents excluded)";
  } else {
    rec.usd = num(result.total_cost_usd);
    if (rec.usd !== null) rec.basis = "harness-reported: total_cost_usd";
  }
  return rec;
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
 * What the cache did across one stage's runs, for the usage record: the TTL Factory asked for, the stage's cache-write
 * share (writes over all input tokens; null when the harness reports no writes), and, for each run that follows a CI
 * wait (a validation fix pass), the minutes waited and its first request's split (`first.unit` says whether the harness
 * reports a request, a turn, or nothing finer than the run). The setting is kept only if these writes drop.
 */
export function cacheSummary(records) {
  const live = records.filter(Boolean);
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
export const priceCodex = (model, tokens) => priceTokens(CODEX_PRICES, model, tokens);

/**
 * Codex: `codex exec --json` prints JSONL ending in one `turn.completed` whose
 * `usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` is the
 * thread's running total, restored by `codex exec resume` (sinceSession takes a resumed pass's
 * share). `input_tokens` already includes the cached and the written parts and `output_tokens` the reasoning
 * part, so neither is added again. Sub-agent threads (`spawn_agent`) are threads of their own, in
 * neither: runHarness adds them from their rollouts (codex-threads.mjs). Dollars come from the price table. An `item.completed` of type `error` followed by a completed
 * turn is a warning (Codex 0.167 reports a resumed thread's model change that way), not a failure.
 */
export function parseCodex(stdout, model) {
  const rec = empty("codex", model);
  const events = jsonLines(stdout);
  if (!events.length) {
    rec.error = "no JSONL events on stdout";
    return rec;
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
      input = add(input, num(u.input_tokens));
      output = add(output, num(u.output_tokens));
      cached = add(cached, num(u.cached_input_tokens));
      written = add(written, num(u.cache_write_input_tokens));
    }
    if (e.type === "turn.failed" || e.type === "error") failed = e.error?.message || e.message || e.type;
    if (e.type === "item.completed" && e.item?.type === "error") itemError = e.item.message || "item error";
  }
  failed = failed || itemError;
  rec.turns = turns;
  rec.tokens = { input, output, cached, written };
  rec.cache = { first };
  rec.ok = turns > 0 && !failed;
  rec.error = failed;
  const refusal = rec.ok ? null : providerRefusal("codex", events);
  if (refusal) rec.refusal = refusal;
  // A resume the provider refused because the thread was written through another credential: runHarness runs it fresh.
  if (!rec.ok && rotatedPin("codex", events)) rec.pinRotated = true;
  rec.usd = priceCodex(rec.model, rec.tokens);
  rec.basis = rec.usd === null ? (input === null && output === null ? CODEX_NO_TOKENS : rec.model ? `unmetered: no price for ${rec.model}` : "unmetered: Codex names no model in its output; set the model input so tokens are priced") : priceBasis();
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
/** A model name as Factory logs it: no newline, no `::` workflow command, nothing but a model id's characters. */
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
 * The dollars for `nano` billionths of an AI credit at `creditUsd`, or why there are none. Unmetered (usd null), never
 * $0: no credits reported, a negative count, a `pending`, `unavailable` or unknown status, or zero credits for a run
 * that used tokens. A `partial` status is priced as a lower bound and says so.
 */
function priceCredits({ nano, negative, status, tokens }, creditUsd) {
  if (negative) return { aiu: null, usd: null, why: "a negative AI credit count" };
  if (nano === null) return { aiu: null, usd: null, why: "no AI credits reported" };
  if (status && status !== "complete" && status !== "partial") return { aiu: null, usd: null, why: `AI credits ${status}` };
  if (nano === 0 && ((tokens?.input ?? 0) > 0 || (tokens?.output ?? 0) > 0)) return { aiu: 0, usd: null, why: "zero AI credits for a run that used tokens" };
  return { aiu: Math.round(nano / 1e6) / 1e3, usd: Math.round((nano / 1e9) * creditUsd * 10000) / 10000, lowerBound: status === "partial", why: null };
}

/**
 * The running total a saved Copilot session last recorded (its `events.jsonl`'s last `session.shutdown` accounting
 * snapshot), in sinceSession's shape plus premium requests, AI credits and the session's start time; null when there
 * is none or it is not priced. The file is the harness's to write: clampTotal bounds it by what Factory recorded.
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
 * A restored session's prior total, bounded field by field by what Factory itself recorded: the session's running
 * total in the saving stage's result.json (`sessionTotal`, which spans every stage the session ran in), else that
 * stage's own figures. A total the harness could edit never lowers the next pass's count below what was billed. Null
 * when Factory recorded no dollars, so nothing is subtracted.
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
 * default), or unmetered (priceCredits). On `--resume` every count is the session's running total (sinceSession takes
 * this pass's share). A non-zero exit is a harness error, not a death.
 */
export function parseCopilot(stdout, model, exitCode = 0, { usageFile, creditUsd = COPILOT_CREDIT_USD } = {}) {
  const rec = empty("copilot", model);
  rec.ok = exitCode === 0;
  rec.subtype = rec.ok ? "success" : "error";
  if (!rec.ok) rec.error = `copilot exited ${exitCode}`;
  let turns = 0;
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
  if (p.aiu !== null) rec.aiu = p.aiu;
  if (p.lowerBound) rec.usdLowerBound = true;
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
      ? `harness-reported: ${rec.aiu} AI credits from ${source} at $${creditUsd}/credit${p.lowerBound ? " (lower bound: AI credits partial)" : ""}${req}`
      : a.tokens.input === null && a.tokens.output === null && a.nano === null
        ? `unmetered: Copilot wrote no usage${req}`
        : `unmetered: ${p.why}${req}`;
  return rec;
}

/** One entry point: harness name to parser. A provider's refusal is the run's error, in its structured fields. */
export function parseUsage(harness, stdout, model, exitCode = 0, extra = {}) {
  const parse = { claude: () => parseClaude(stdout, model), codex: () => parseCodex(stdout, model), copilot: () => parseCopilot(stdout, model, exitCode, extra) }[harness];
  if (!parse) throw new Error(`unknown harness ${harness}`);
  const rec = parse();
  if (rec.refusal) rec.error = `refused by the provider: ${refusalFields(rec.refusal)}`;
  return rec;
}

/** A refusal's structured fields in one line: "HTTP 400 invalid_request_error <code>". */
export const refusalFields = (r) => [r.status !== null ? `HTTP ${r.status}` : null, r.type, r.code].filter(Boolean).join(" ");

/** Sum several records of one run (first prompt, validation retry, review pass). */
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

/**
 * Claude Code, Codex and Copilot report a resumed session's cost or tokens as the session's running total, so a pass
 * that resumes an earlier session is counted as its own share: the total minus the total that session had already
 * reported (in this process, or in its restored transcript or Factory's record of it). Turns are per process and stay.
 * Codex's first-turn cache split is that running total too, so it is counted the same way.
 */
export function sinceSession(rec, prior) {
  if (!rec || !prior || prior.usd === null || prior.usd === undefined) return rec;
  // Copilot: only a total from the same session start is a running total of the one subtracted (Copilot keeps the
  // start time across --resume); anything else is counted as reported.
  if (rec.harness === "copilot" && (!rec.sessionStartTime || rec.sessionStartTime !== prior.sessionStartTime)) return rec;
  // A total below the one already seen is not a running total (the session's cost state was never written): as reported.
  if (rec.usd !== null && rec.usd !== undefined && rec.usd < prior.usd) return rec;
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
  return { ...rec, ...counts, ...cache, usd: less(rec.usd, prior.usd), tokens: { input: less(t.input, pt.input), output: less(t.output, pt.output), cached: less(t.cached, pt.cached), written: less(t.written, pt.written) }, models, sessionTotal: { usd: rec.usd, tokens: rec.tokens, models: rec.models, ...(rec.premiumRequests === undefined ? {} : { premiumRequests: rec.premiumRequests }), ...(rec.aiu === undefined ? {} : { aiu: rec.aiu }), ...(rec.sessionStartTime ? { sessionStartTime: rec.sessionStartTime } : {}) } };
}

export function mergeUsage(records) {
  const live = records.filter(Boolean);
  if (!live.length) return null;
  const first = live[0];
  // A negative dollar figure is no spend: it never lowers a total (every harness).
  const spend = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : null);
  const out = { ...first, usd: spend(first.usd), tokens: { ...first.tokens } };
  for (const r of live.slice(1)) {
    out.usd = spend(r.usd) === null && out.usd === null ? null : (out.usd ?? 0) + (spend(r.usd) ?? 0);
    out.usdLowerBound = out.usdLowerBound || r.usdLowerBound;
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
    out.ended = r.ended ?? out.ended;
  }
  return out;
}
