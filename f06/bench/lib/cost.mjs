// Dollars per Objective, with the unit and basis per harness (PLAN.md, "Job
// one and how 0.6 is measured"). The input is the usage artifact the worker
// job uploads (`factory-usage-<issue>`, and `factory-usage-<issue>-review-<n>`
// for the reviewer pass): its normalized `result.json` (action/scripts/lib/
// usage.mjs: {harness, model, usd, tokens, basis, started, ended, runs,
// passes, exit, reason, credential, turns, priceTableDate}). A raw Claude
// result (`{type: "result", total_cost_usd, modelUsage}`) or a raw Codex
// JSONL (`events.jsonl`) is accepted too, for runs made outside the Action.
//
//   claude   unit usd      total_cost_usd, modelUsage (sub-agents included)
//   codex    unit tokens   priced from prices.json (placeholder rates, dated)
//   copilot  unit credits  unmetered: no per-run output; AI Credits from org billing
//
// A count a harness does not report is null, never zero.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PRICES_FILE = join(import.meta.dirname, "..", "prices.json");

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const add = (a, b) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const round4 = (n) => (n === null ? null : Math.round(n * 10000) / 10000);

export function loadPrices(file = PRICES_FILE) {
  const prices = JSON.parse(readFileSync(file, "utf8"));
  if (!prices.perMillion || typeof prices.perMillion !== "object") throw new Error(`${file}: no perMillion table`);
  return prices;
}

/** USD for Codex tokens by the longest model prefix in the table; null when the model is not listed. */
export function priceTokens(prices, model, tokens) {
  if (!model || !tokens) return null;
  const key = Object.keys(prices.perMillion)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(k));
  if (!key) return null;
  const p = prices.perMillion[key];
  const cached = tokens.cached ?? 0;
  const uncached = Math.max(0, (tokens.input ?? 0) - cached);
  return round4((uncached * p.input + cached * p.cached + (tokens.output ?? 0) * p.output) / 1e6);
}

/** Non-JSON lines are skipped (CLIs print warnings on stdout). */
function jsonLines(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial line
    }
  }
  return out;
}

/** A raw Claude result object (json or the last stream-json line) to the normalized record. */
export function fromClaudeResult(result, model = null) {
  const rec = { harness: "claude", model, usd: null, tokens: { input: null, output: null, cached: null }, basis: "unmetered", turns: num(result.num_turns), exit: null, runs: 1 };
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
  } else {
    const u = result.usage || {};
    const cached = num(u.cache_read_input_tokens);
    rec.tokens = { input: add(num(u.input_tokens), add(cached, num(u.cache_creation_input_tokens))), output: num(u.output_tokens), cached };
    rec.usd = num(result.total_cost_usd);
    rec.basis = rec.usd === null ? "unmetered: no total_cost_usd" : "harness-reported: total_cost_usd, usage (sub-agents excluded)";
  }
  return rec;
}

/** Raw Codex JSONL to the normalized record (tokens only; dollars are priced by `costOf`). */
export function fromCodexEvents(text, model = null) {
  const rec = { harness: "codex", model, usd: null, tokens: { input: null, output: null, cached: null }, basis: "unpriced", turns: 0, exit: null, runs: 1 };
  for (const e of jsonLines(text)) {
    if (e.type !== "turn.completed") continue;
    rec.turns += 1;
    const u = e.usage || {};
    rec.tokens.input = add(rec.tokens.input, num(u.input_tokens));
    rec.tokens.output = add(rec.tokens.output, add(num(u.output_tokens), num(u.reasoning_output_tokens)));
    rec.tokens.cached = add(rec.tokens.cached, num(u.cached_input_tokens));
  }
  return rec;
}

/** Any usage file's content to a normalized record, by shape; null when it is none of them. */
export function parseUsageText(text, { model = null } = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  let value = null;
  if (!trimmed.includes("\n") || trimmed.startsWith("{\n") || trimmed.startsWith("{\r\n")) {
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = null;
    }
  }
  if (value && typeof value === "object") {
    if (value.harness) return { ...value, runs: value.runs ?? 1 };
    if (value.type === "result" || "total_cost_usd" in value) return fromClaudeResult(value, model);
  }
  const lines = jsonLines(trimmed);
  if (!lines.length) return null;
  if (lines.some((l) => l.type === "turn.completed" || l.type === "thread.started")) return fromCodexEvents(trimmed, model);
  const result = [...lines].reverse().find((l) => l.type === "result");
  return result ? fromClaudeResult(result, model) : null;
}

/**
 * The cost row from one Objective's usage records (the worker's artifact,
 * then any reviewer artifacts), on `prices` for Codex:
 *   { harness, model, unit, usd, tokens, basis, parts: [{artifact, usd, tokens, basis}], priceTableDate, note }
 * `usd` is null when any priced part is unmetered; `unit` is per harness.
 */
export function costOf(records, prices, { harness: declared = null } = {}) {
  const parts = records.filter(Boolean);
  const harness = declared ?? parts[0]?.harness ?? null;
  const out = { harness, model: parts.find((p) => p.model)?.model ?? null, unit: null, usd: null, tokens: { input: null, output: null, cached: null }, basis: null, parts: [], priceTableDate: null, note: null };
  if (!parts.length) {
    out.basis = "unknown: no usage artifact";
    return out;
  }
  for (const rec of parts) {
    const part = { artifact: rec.artifact ?? null, harness: rec.harness, model: rec.model ?? null, usd: null, tokens: rec.tokens ?? { input: null, output: null, cached: null }, basis: rec.basis ?? null };
    if (rec.harness === "claude") {
      part.usd = num(rec.usd);
      part.basis = rec.basis && /harness-reported/.test(rec.basis) ? rec.basis : part.usd === null ? "unmetered: no total_cost_usd" : "harness-reported: total_cost_usd, modelUsage (sub-agents included)";
    } else if (rec.harness === "codex") {
      // The bench's table replaces whatever the worker priced with (action/NOTES.md).
      part.usd = priceTokens(prices, rec.model, rec.tokens);
      part.basis = part.usd === null ? `unmetered: no price for ${rec.model ?? "unknown model"} in prices.json` : `tokens priced from prices.json dated ${prices.date}${prices.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}`;
    } else if (rec.harness === "copilot") {
      part.usd = null;
      part.basis = "unmetered: Copilot reports nothing per run; bills GitHub AI Credits, attribute from org billing by time window";
    } else {
      part.usd = num(rec.usd);
      part.basis = rec.basis ?? "unknown harness";
    }
    out.parts.push(part);
    out.tokens.input = add(out.tokens.input, part.tokens?.input ?? null);
    out.tokens.output = add(out.tokens.output, part.tokens?.output ?? null);
    out.tokens.cached = add(out.tokens.cached, part.tokens?.cached ?? null);
  }
  const unmetered = out.parts.filter((p) => p.usd === null);
  out.usd = unmetered.length ? null : round4(out.parts.reduce((s, p) => s + p.usd, 0));
  switch (harness) {
    case "claude":
      out.unit = "usd";
      out.basis = unmetered.length ? `unmetered: ${unmetered.map((p) => p.basis).join("; ")}` : "harness-reported: total_cost_usd, modelUsage (sub-agents included)";
      break;
    case "codex":
      out.unit = "tokens";
      out.priceTableDate = prices.date;
      out.basis = unmetered.length ? unmetered[0].basis : `tokens priced from prices.json dated ${prices.date}${prices.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}`;
      out.note = prices.status === "placeholder" ? "prices.json carries placeholder rates; replace them before reading this as dollars" : null;
      break;
    case "copilot":
      out.unit = "credits";
      out.basis = "unmetered";
      out.note = "Copilot reports nothing per run and bills GitHub AI Credits; attribute from the org's billing data by this row's time window and convert at GitHub's rate, or leave unmetered";
      break;
    default:
      out.unit = "usd";
      out.basis = unmetered.length ? "unmetered" : parts[0].basis ?? "unknown";
  }
  if (out.parts.length > 1) out.basis += `; ${out.parts.length} artifacts summed (worker + review)`;
  return out;
}
