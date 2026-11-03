// Normalize each harness's headless output into one usage record:
//   {harness, model, usd, tokens: {input, output, cached}, basis, started, ended,
//    sessionId, subtype, ok, error, turns}
// usd is null when the run is unmetered (Copilot, or a Codex model missing from the
// price table). `basis` says where the dollars came from, so the scorecard shows it.
// A count a harness does not report is null, never zero.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Codex prices, USD per million tokens, by model prefix: the bench's one table
 * (bench/prices.json) when it sits beside the action, else this copy of it. Codex
 * reports tokens, not dollars, so the worker prices them here; the bench re-prices.
 * `status: "placeholder"` travels into every basis string until the rates are real.
 * Unknown models give usd: null and basis "unmetered: no price for <model>".
 */
const FALLBACK_PRICES = {
  status: "placeholder",
  date: "2026-11-02",
  perMillion: {
    "gpt-6.1-sol": { input: 2.5, cached: 0.25, output: 15 },
    "gpt-6.1": { input: 2.5, cached: 0.25, output: 15 },
    "gpt-5.5-codex": { input: 1.25, cached: 0.125, output: 10 },
    "gpt-5.5": { input: 1.25, cached: 0.125, output: 10 },
    "gpt-5-codex": { input: 1.25, cached: 0.125, output: 10 },
    "gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  },
};
function loadPrices() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of [join(here, "..", "..", "..", "bench", "prices.json"), join(here, "..", "..", "bench", "prices.json")]) {
    if (!existsSync(f)) continue;
    try {
      const p = JSON.parse(readFileSync(f, "utf8"));
      if (p?.perMillion) return p;
    } catch {
      // unreadable: fall through
    }
  }
  return FALLBACK_PRICES;
}
export const CODEX_PRICES = loadPrices();
const priceBasis = () => `priced from table dated ${CODEX_PRICES.date}${CODEX_PRICES.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}`;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const add = (a, b) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

function empty(harness, model) {
  return {
    harness,
    model: model ?? null,
    usd: null,
    tokens: { input: null, output: null, cached: null },
    basis: "unmetered",
    started: null,
    ended: null,
    sessionId: null,
    subtype: null,
    ok: false,
    error: null,
    turns: null,
    budgetExceeded: false,
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
  if (!result) {
    const lines = jsonLines(stdout);
    result = [...lines].reverse().find((l) => l && l.type === "result") ?? lines.at(-1) ?? null;
    init = lines.find((l) => l && l.type === "system" && l.session_id) ?? null;
  }
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

  const byModel = result.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : null;
  if (byModel && Object.keys(byModel).length) {
    let input = null;
    let output = null;
    let cached = null;
    let cost = null;
    for (const [name, u] of Object.entries(byModel)) {
      input = add(input, add(num(u.inputTokens), add(num(u.cacheReadInputTokens), num(u.cacheCreationInputTokens))));
      output = add(output, num(u.outputTokens));
      cached = add(cached, num(u.cacheReadInputTokens));
      if (num(u.costUSD) !== null) cost = add(cost, num(u.costUSD));
      if (!rec.model) rec.model = name;
    }
    rec.tokens = { input, output, cached };
    rec.usd = num(result.total_cost_usd) ?? cost;
    rec.basis = "harness-reported: total_cost_usd, modelUsage (sub-agents included)";
  } else if (result.usage) {
    const u = result.usage;
    const cached = num(u.cache_read_input_tokens);
    rec.tokens = {
      input: add(num(u.input_tokens), add(cached, num(u.cache_creation_input_tokens))),
      output: num(u.output_tokens),
      cached,
    };
    rec.usd = num(result.total_cost_usd);
    rec.basis = rec.usd === null ? "unmetered" : "harness-reported: total_cost_usd, usage (sub-agents excluded)";
  } else {
    rec.usd = num(result.total_cost_usd);
    if (rec.usd !== null) rec.basis = "harness-reported: total_cost_usd";
  }
  return rec;
}

/** Price Codex tokens from the table; null when the model is not listed. */
export function priceCodex(model, tokens) {
  if (!model) return null;
  if (tokens.input === null && tokens.output === null) return null; // nothing reported is unmetered, not free
  const key = Object.keys(CODEX_PRICES.perMillion)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(k));
  if (!key) return null;
  const p = CODEX_PRICES.perMillion[key];
  const cached = tokens.cached ?? 0;
  const uncached = Math.max(0, (tokens.input ?? 0) - cached);
  const usd = (uncached * p.input + cached * p.cached + (tokens.output ?? 0) * p.output) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

/**
 * Codex: `codex exec --json` prints JSONL. Each `turn.completed` carries
 * `usage.{input_tokens, cached_input_tokens, output_tokens[, reasoning_output_tokens]}`;
 * `input_tokens` already includes the cached part. Sub-agent threads are folded in by
 * Codex where it reports them at all. Dollars come from the price table.
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
  let turns = 0;
  let failed = null;
  for (const e of events) {
    if (e.type === "thread.started" && e.thread_id) rec.sessionId = e.thread_id;
    if (e.type === "turn.completed") {
      turns += 1;
      const u = e.usage || {};
      input = add(input, num(u.input_tokens));
      output = add(output, add(num(u.output_tokens), num(u.reasoning_output_tokens)));
      cached = add(cached, num(u.cached_input_tokens));
    }
    if (e.type === "turn.failed" || e.type === "error") failed = e.error?.message || e.message || e.type;
    if (e.type === "item.completed" && e.item?.type === "error") failed = e.item.message || "item error";
  }
  rec.turns = turns;
  rec.tokens = { input, output, cached };
  rec.ok = turns > 0 && !failed;
  rec.error = failed;
  rec.usd = priceCodex(rec.model, rec.tokens);
  rec.basis = rec.usd === null ? (rec.model ? `unmetered: no price for ${rec.model}` : "unmetered: Codex names no model in its output; set the model input so tokens are priced") : priceBasis();
  return rec;
}

/**
 * Copilot 1.0.91: `copilot -p --output-format json` prints JSONL whose last line is
 * `{type: "result", sessionId, exitCode, usage: {premiumRequests, ...}}`, with one
 * `assistant.turn_end` per turn and the model named on `assistant.message`;
 * `--usage-output-file` writes `{totalPremiumRequestCost, totalNanoAiu, modelMetrics:
 * {<model>: {requests: {count, cost}, usage: {inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens, reasoningTokens}}}}` (sub-agents under
 * agentMetrics, already summed into modelMetrics). Tokens come from that file; dollars
 * are always null: Copilot bills GitHub AI Credits (premium requests, AIU), attributed
 * by the bench from the org's billing window. A non-zero exit is a harness error, not a death.
 */
export function parseCopilot(stdout, model, exitCode = 0, { usageFile } = {}) {
  const rec = empty("copilot", model);
  rec.ok = exitCode === 0;
  rec.subtype = rec.ok ? "success" : "error";
  if (!rec.ok) rec.error = `copilot exited ${exitCode}`;
  let input = null;
  let output = null;
  let cached = null;
  let turns = 0;
  for (const e of jsonLines(stdout)) {
    if (e.type === "assistant.turn_end") turns += 1;
    if (e.type === "assistant.message" && e.data?.model && !rec.model) rec.model = e.data.model;
    if (e.type === "result") {
      if (e.sessionId) rec.sessionId = String(e.sessionId);
      if (num(e.usage?.premiumRequests) !== null) rec.premiumRequests = num(e.usage.premiumRequests);
      if (typeof e.exitCode === "number" && e.exitCode !== 0 && rec.ok) {
        rec.ok = false;
        rec.subtype = "error";
        rec.error = `copilot reported exit ${e.exitCode}`;
      }
    }
  }
  if (usageFile && existsSync(usageFile)) {
    try {
      const u = JSON.parse(readFileSync(usageFile, "utf8"));
      const models = u.modelMetrics && typeof u.modelMetrics === "object" ? Object.entries(u.modelMetrics) : [];
      for (const [name, m] of models) {
        const t = m.usage || {};
        input = add(input, num(t.inputTokens));
        output = add(output, add(num(t.outputTokens), num(t.reasoningTokens)));
        cached = add(cached, num(t.cacheReadTokens));
        if (!rec.model) rec.model = name;
      }
      if (!models.length && u.tokenDetails) {
        const d = u.tokenDetails;
        input = add(num(d.input?.tokenCount), add(num(d.cache_read?.tokenCount), num(d.cache_write?.tokenCount)));
        output = num(d.output?.tokenCount);
        cached = num(d.cache_read?.tokenCount);
      }
      if (num(u.totalPremiumRequestCost) !== null) rec.premiumRequests = num(u.totalPremiumRequestCost);
      if (num(u.totalNanoAiu) !== null) rec.aiu = Math.round(u.totalNanoAiu / 1e6) / 1e3;
    } catch {
      // unreadable usage file: tokens stay null
    }
  }
  rec.turns = turns || null;
  rec.tokens = { input, output, cached };
  rec.basis = input === null && output === null ? "unmetered: Copilot wrote no usage; attribute AI Credits from org billing by time window" : `tokens from copilot --usage-output-file${rec.premiumRequests !== undefined ? `, ${rec.premiumRequests} premium request(s)` : ""}; dollars unmetered (AI Credits, attribute from org billing)`;
  return rec;
}

/** One entry point: harness name to parser. */
export function parseUsage(harness, stdout, model, exitCode = 0, extra = {}) {
  switch (harness) {
    case "claude":
      return parseClaude(stdout, model);
    case "codex":
      return parseCodex(stdout, model);
    case "copilot":
      return parseCopilot(stdout, model, exitCode, extra);
    default:
      throw new Error(`unknown harness ${harness}`);
  }
}

/** Sum several records of one run (first prompt, validation retry, review pass). */
export function mergeUsage(records) {
  const live = records.filter(Boolean);
  if (!live.length) return null;
  const first = live[0];
  const out = { ...first, tokens: { ...first.tokens } };
  for (const r of live.slice(1)) {
    out.usd = r.usd === null && out.usd === null ? null : (out.usd ?? 0) + (r.usd ?? 0);
    out.tokens.input = add(out.tokens.input, r.tokens.input);
    out.tokens.output = add(out.tokens.output, r.tokens.output);
    out.tokens.cached = add(out.tokens.cached, r.tokens.cached);
    out.turns = add(out.turns, r.turns);
    out.ok = out.ok && r.ok;
    out.error = out.error || r.error;
    out.budgetExceeded = out.budgetExceeded || r.budgetExceeded;
    out.ended = r.ended ?? out.ended;
  }
  return out;
}
