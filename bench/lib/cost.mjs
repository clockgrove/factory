// Dollars per Objective, with the unit and basis per harness (PLAN.md, "Job
// one and how 0.6 is measured"). The input is the usage artifact the worker
// job uploads (`factory-usage-<issue>`, and `factory-usage-<issue>-review`
// for the reviewer pass): its normalized `result.json` (action/scripts/lib/
// usage.mjs: {harness, model, usd, tokens, basis, started, ended, runs,
// passes, exit, reason, credential, turns, priceTableDate}). A raw Claude
// result (`{type: "result", total_cost_usd, modelUsage}`) or a raw Codex
// JSONL (`events.jsonl`) is accepted too, for runs made outside the Action.
//
//   claude   unit usd      total_cost_usd, modelUsage (sub-agents included)
//   codex    unit usd      tokens priced from the Codex price table (plugin/scripts/lib/codex-prices.json, dated)
//   copilot  unit usd      AI credits from --usage-output-file at the run's $/credit (GitHub: $0.01), premium requests beside
//
// A count a harness does not report is null, never zero.
//
// A stage that ran in a cloud sandbox also carries the vendor's cost in its record (`vendor`, booked by the launcher
// from the vendor's usage totals at list rates: plugin/scripts/launch.mjs bookVendor). It is summed beside the model's
// dollars, never into them: `usd` stays the harness's, `vendorUsd` the sandboxes', `totalUsd` both.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_NO_TOKENS, priceStage, priceTokens } from "../../plugin/scripts/lib/usage.mjs";

/** The one Codex price table, the worker's own (plugin/scripts/lib/codex-prices.json). */
export const PRICES_FILE = join(import.meta.dirname, "..", "..", "plugin", "scripts", "lib", "codex-prices.json");
const PRICES_NAME = "codex-prices.json";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const add = (a, b) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const less = (a, b) => (a === null ? null : Math.max(0, a - (b ?? 0)));
const round4 = (n) => (n === null ? null : Math.round(n * 10000) / 10000);

export function loadPrices(file = PRICES_FILE) {
  const prices = JSON.parse(readFileSync(file, "utf8"));
  if (!prices.perMillion || typeof prices.perMillion !== "object") throw new Error(`${file}: no perMillion table`);
  return prices;
}

/** USD for Codex tokens at the table's rates (usage.mjs codexRate: exact id or dated snapshot); null when unlisted. */
export { priceTokens };

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
  const rec = { harness: "claude", model, usd: null, tokens: { input: null, output: null, cached: null, written: null }, basis: "unmetered", turns: num(result.num_turns), exit: null, runs: 1 };
  const byModel = result.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : null;
  if (byModel && Object.keys(byModel).length) {
    let input = null;
    let output = null;
    let cached = null;
    let written = null;
    let cost = null;
    rec.models = {};
    for (const [name, u] of Object.entries(byModel)) {
      const m = { input: num(u.inputTokens), cached: num(u.cacheReadInputTokens), written: num(u.cacheCreationInputTokens), output: num(u.outputTokens), usd: num(u.costUSD) };
      input = add(input, add(m.input, add(m.cached, m.written)));
      output = add(output, m.output);
      cached = add(cached, m.cached);
      written = add(written, m.written);
      if (m.usd !== null) cost = add(cost, m.usd);
      rec.models[name] = m;
      if (!rec.model) rec.model = name;
    }
    rec.tokens = { input, output, cached, written };
    rec.usd = num(result.total_cost_usd) ?? cost;
    rec.basis = "harness-reported: total_cost_usd, modelUsage (sub-agents included)";
  } else {
    const u = result.usage || {};
    const cached = num(u.cache_read_input_tokens);
    const written = num(u.cache_creation_input_tokens);
    rec.tokens = { input: add(num(u.input_tokens), add(cached, written)), output: num(u.output_tokens), cached, written };
    rec.usd = num(result.total_cost_usd);
    rec.basis = rec.usd === null ? "unmetered: no total_cost_usd" : "harness-reported: total_cost_usd, usage (sub-agents excluded)";
  }
  return rec;
}

/**
 * The prompt cache across an Objective's artifacts (the usage record's `cache`, session.mjs writeUsage): the TTLs
 * Factory asked for, and each run that followed a CI wait with its first request's cache writes. A/B the
 * `prompt_cache_ttl` setting on these: it is kept only if `afterWait[].first.written` drops.
 */
export function cacheOf(records) {
  const withCache = records.filter((r) => r?.cache && typeof r.cache === "object");
  if (!withCache.length) return null;
  const ttls = [...new Set(withCache.map((r) => r.cache.ttl ?? "default"))];
  const afterWait = withCache.flatMap((r) => (r.cache.afterWait || []).map((w) => ({ artifact: r.artifact ?? null, ...w })));
  const written = afterWait.reduce((s, w) => add(s, num(w.first?.written)), null);
  const input = afterWait.reduce((s, w) => add(s, num(w.first?.input)), null);
  return { ttl: ttls.join(", "), afterWait, firstWritten: written, firstInput: input };
}

/** Per-model token and dollar totals, summed across harness runs (null when neither side reports any). */
function mergeModels(a, b) {
  if (!a && !b) return undefined;
  const out = { ...(a ?? {}) };
  for (const [name, m] of Object.entries(b ?? {})) {
    const p = out[name];
    out[name] = p ? { input: add(p.input, m.input), cached: add(p.cached, m.cached), written: add(p.written, m.written), output: add(p.output, m.output), usd: add(p.usd, m.usd) } : m;
  }
  return out;
}

/**
 * The sandbox vendor's cost across an Objective's usage records: each stage's `vendor.usd` summed, with how many stages
 * it covers and whether any is an upper bound (the session's ceiling, when the usage could not be read). Null when no
 * record ran in a sandbox.
 */
export function vendorOf(records) {
  // One booking per stage: a stage's claim names it, so a booking carried twice (a retried launch's artifact) counts once.
  const byStage = new Map();
  records.forEach((r, i) => {
    if (!r?.vendor || typeof r.vendor !== "object") return;
    const claim = typeof r.vendor.claim === "string" && /^[0-9a-f]{12}$/.test(r.vendor.claim) ? r.vendor.claim : `#${i}`;
    byStage.set(claim, r);
  });
  const withVendor = [...byStage.values()];
  if (!withVendor.length) return null;
  const priced = withVendor.filter((r) => num(r.vendor.usd) !== null);
  const upper = withVendor.filter((r) => r.vendor.upperBound).length;
  const rates = withVendor.map((r) => r.vendor.rates).find((x) => x && typeof x === "object");
  const usd = priced.length ? round4(priced.reduce((s, r) => s + r.vendor.usd, 0)) : null;
  const unpriced = withVendor.length - priced.length;
  const basis = `${withVendor.length} sandbox stage(s)${upper ? `, ${upper} at the session's ceiling (an upper bound)` : ""}${unpriced ? `, ${unpriced} unpriced` : ""}; ${rates ? `${rates.vendor ?? "vendor"} ${rates.plan ?? ""} list rates (${rates.region ?? "?"}) read ${rates.date ?? "?"}` : "list rates"}`;
  return { usd, parts: withVendor.length, upperBound: upper > 0, basis, storedUsd: round4(withVendor.reduce((s, r) => s + (num(r.vendor.storedUsd) ?? 0), 0)) };
}

/**
 * Raw Codex JSONL to the normalized record (tokens only; dollars are priced by `costOf`). `output_tokens` already
 * includes the reasoning tokens, and `input_tokens` the cached and written ones (`cache_write_input_tokens`). Each pass starts with `thread.started`; a pass that resumes a thread seen earlier in
 * the stream reports the thread's running total, so it counts only its own share (as the worker's runHarness does).
 */
export function fromCodexEvents(text, model = null) {
  const rec = { harness: "codex", model, usd: null, tokens: { input: null, output: null, cached: null, written: null }, basis: "unpriced", turns: 0, exit: null, runs: 1 };
  const totals = new Map();
  let thread = null;
  let pass = null;
  const close = () => {
    if (!pass) return;
    const prior = thread ? totals.get(thread) : null;
    if (thread) totals.set(thread, pass);
    for (const k of ["input", "output", "cached", "written"]) rec.tokens[k] = add(rec.tokens[k], prior ? less(pass[k], prior[k]) : pass[k]);
    pass = null;
  };
  for (const e of jsonLines(text)) {
    if (e.type === "thread.started") {
      close();
      thread = typeof e.thread_id === "string" ? e.thread_id : null;
    }
    if (e.type !== "turn.completed") continue;
    rec.turns += 1;
    const u = e.usage || {};
    pass ??= { input: null, output: null, cached: null, written: null };
    pass.input = add(pass.input, num(u.input_tokens));
    pass.output = add(pass.output, num(u.output_tokens));
    pass.cached = add(pass.cached, num(u.cached_input_tokens));
    pass.written = add(pass.written, num(u.cache_write_input_tokens));
  }
  close();
  return rec;
}

/** Any usage file's content to a normalized record, by shape; null when it is none of them. */
/**
 * Harness calls and distinct sessions in a raw event stream: Claude's `system/init` lines and
 * `session_id`, Codex's `thread.started` and thread ids. Null when the text has neither.
 */
export function sessionsOf(text) {
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
  // The worker appends one result per harness run (the first prompt, each validation fix pass): sum them all.
  const results = lines.filter((l) => l.type === "result").map((r) => fromClaudeResult(r, model));
  if (!results.length) return null;
  const sum = results[0];
  for (const r of results.slice(1)) {
    sum.usd = sum.usd === null && r.usd === null ? null : (sum.usd ?? 0) + (r.usd ?? 0);
    sum.tokens = { input: add(sum.tokens.input, r.tokens.input), output: add(sum.tokens.output, r.tokens.output), cached: add(sum.tokens.cached, r.tokens.cached), written: add(sum.tokens.written, r.tokens.written) };
    sum.models = mergeModels(sum.models, r.models);
    sum.turns = add(sum.turns, r.turns);
    sum.model = sum.model ?? r.model;
  }
  sum.usd = round4(sum.usd);
  sum.runs = results.length;
  return sum;
}

/**
 * The stage a usage record came from, by its artifact's name: the review job's `factory-usage-<n>-review`, a local
 * loop's `usage-review-<stamp>/`, a spend line's `spend/review/<id>`; any other name is the work stage's.
 */
export function stageOf(rec) {
  return typeof rec?.artifact === "string" && /(^|[-/])review([-/]|$)/.test(rec.artifact) ? "review" : "work";
}

/**
 * The cost row from one Objective's usage records (the worker's artifact,
 * then any reviewer artifacts), on `prices` for Codex:
 *   { harness, model, unit, usd, tokens, basis, parts: [{artifact, usd, tokens, basis}], priceTableDate, note }
 * `usd` is null when any priced part is unmetered; `unit` is per harness. `vendor` sums the sandbox vendor's cost the
 * parts carry ({usd, parts, upperBound, basis}, null when no part ran in a sandbox); `totalUsd` is model plus vendor.
 */
export function costOf(records, prices, { harness: declared = null } = {}) {
  const parts = records.filter(Boolean);
  const harness = declared ?? parts[0]?.harness ?? null;
  // The row's model is the work stage's, whatever order the artifacts are listed in: never the reviewer's.
  const out = { harness, model: parts.find((p) => p.model && stageOf(p) === "work")?.model ?? null, unit: null, usd: null, tokens: { input: null, output: null, cached: null, written: null }, basis: null, parts: [], priceTableDate: null, note: null, activity: { turns: null, calls: null, sessions: null, workRuns: 0, reviewRuns: 0 }, cache: cacheOf(parts) };
  if (!parts.length) {
    out.basis = "unknown: no usage artifact";
    return out;
  }
  for (const rec of parts) {
    const part = { artifact: rec.artifact ?? null, harness: rec.harness, model: rec.model ?? null, usd: null, tokens: rec.tokens ?? { input: null, output: null, cached: null }, basis: rec.basis ?? null };
    if (rec.runs === 0) {
      // A job that ran no harness (a review job that skipped an already-reviewed PR) cost nothing: not unmetered.
      part.usd = 0;
      part.basis = `no harness run (${rec.exit ?? "skipped"})`;
      out.parts.push(part);
      continue;
    }
    if (rec.source === "spend") {
      // Factory's spend line (no usage artifact): the worker's own dollars, whatever the harness; never repriced.
      part.usd = num(rec.usd);
      part.basis = rec.basis ?? "factory:spend line";
    } else if (rec.harness === "claude") {
      part.usd = num(rec.usd);
      part.basis = rec.basis && /harness-reported/.test(rec.basis) ? rec.basis : part.usd === null ? "unmetered: no total_cost_usd" : "harness-reported: total_cost_usd, modelUsage (sub-agents included)";
    } else if (rec.harness === "codex") {
      // The bench's table replaces whatever the worker priced with: one price basis per scorecard.
      // Its sub-agent threads (the record's `subAgents`) each at their own model, the rest at the stage's. The spend
      // through a relayed gateway key is no harness spend: kept as the worker priced it.
      const priced = priceStage(prices, rec.model, rec.tokens, rec.subAgents);
      part.usd = priced.usd === null ? null : round4(priced.usd + (num(rec.workerKeyUsd) ?? 0));
      if (priced.lowerBound || (rec.subAgents?.length && rec.usdLowerBound)) out.usdLowerBound = true;
      // No tokens reported (no turn completed) is no missing price: the worker's own basis for it.
      const noTokens = (rec.tokens?.input ?? null) === null && (rec.tokens?.output ?? null) === null;
      part.basis = part.usd === null ? (noTokens ? CODEX_NO_TOKENS : `unmetered: no price for ${rec.model ?? "unknown model"} in ${PRICES_NAME}`) : `tokens priced from ${PRICES_NAME} dated ${prices.date}${prices.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}`;
    } else if (rec.harness === "copilot") {
      // The worker prices the AI credits its usage file reports (usage.mjs parseCopilot); an artifact from before that,
      // or a run that reported none, stays unmetered.
      part.usd = num(rec.usd);
      part.basis = part.usd === null ? "unmetered: no AI credits in the usage artifact" : rec.basis ?? "harness-reported: AI credits";
      part.premiumRequests = num(rec.premiumRequests);
      part.aiCredits = num(rec.aiCredits ?? rec.aiu);
      out.premiumRequests = add(out.premiumRequests ?? null, part.premiumRequests);
      out.aiCredits = add(out.aiCredits ?? null, part.aiCredits);
      if (rec.usdLowerBound) out.usdLowerBound = true;
    } else {
      part.usd = num(rec.usd);
      part.basis = rec.basis ?? "unknown harness";
    }
    // The spend through a relayed AI Gateway key (#97), already in the part's dollars: broken out on the row.
    const key = num(rec.workerKeyUsd);
    if (key !== null) {
      part.workerKeyUsd = key;
      out.workerKeyUsd = round4((out.workerKeyUsd ?? 0) + key);
    }
    out.parts.push(part);
    // Activity: turns and harness calls per Objective (the token levers' metric), sessions (continuity),
    // and how many work and review runs the artifacts came from (re-entries are work runs past the first).
    out.activity.turns = add(out.activity.turns, num(rec.turns));
    out.activity.calls = add(out.activity.calls, num(rec.sessions?.calls));
    out.activity.sessions = add(out.activity.sessions, num(rec.sessions?.sessions));
    if (rec.runs !== 0 && typeof rec.artifact === "string") out.activity[stageOf(rec) === "review" ? "reviewRuns" : "workRuns"] += 1;
    out.tokens.input = add(out.tokens.input, part.tokens?.input ?? null);
    out.tokens.output = add(out.tokens.output, part.tokens?.output ?? null);
    out.tokens.written = add(out.tokens.written, part.tokens?.written ?? null);
    if (rec.models) out.models = mergeModels(out.models, rec.models);
    out.tokens.cached = add(out.tokens.cached, part.tokens?.cached ?? null);
  }
  const unmetered = out.parts.filter((p) => p.usd === null);
  const priced = out.parts.filter((p) => p.usd !== null);
  // The priced parts are summed; an unmetered part makes the figure partial, never hides what is known.
  out.usd = priced.length ? round4(priced.reduce((s, p) => s + p.usd, 0)) : null;
  const partial = unmetered.length && priced.length ? `partial: ${unmetered.length} of ${out.parts.length} artifacts unmetered (${unmetered.map((p) => p.basis).join("; ")}); ` : "";
  switch (harness) {
    case "claude":
      out.unit = "usd";
      out.basis = priced.length ? `${partial}harness-reported: total_cost_usd, modelUsage (sub-agents included)` : `unmetered: ${unmetered.map((p) => p.basis).join("; ")}`;
      break;
    case "codex":
      // Dollars priced from the table are the measure (PLAN.md); tokens stay the unit only while unpriced.
      out.unit = priced.length ? "usd" : "tokens";
      out.priceTableDate = prices.date;
      out.basis = priced.length ? `${partial}tokens priced from ${PRICES_NAME} dated ${prices.date}${prices.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}${out.usdLowerBound ? "; a lower bound (a sub-agent thread's model has no price)" : ""}` : unmetered[0].basis;
      out.note = prices.status === "placeholder" ? `${PRICES_NAME} carries placeholder rates; replace them before reading this as dollars` : null;
      break;
    case "copilot":
      out.unit = "usd";
      out.basis = priced.length ? `${partial}harness-reported: ${out.aiCredits === null ? "?" : Math.round(out.aiCredits * 1000) / 1000} AI credits, ${out.premiumRequests ?? "?"} premium request(s); dollars at each run's $/credit${out.usdLowerBound ? "; a lower bound (AI credits partial)" : ""}` : unmetered.map((p) => p.basis).join("; ");
      out.note = priced.length ? null : "This Copilot artifact carries no AI credits (written before Factory priced them, or the run reported none); attribute from the org's billing data by this row's time window, or leave unmetered";
      break;
    default:
      out.unit = "usd";
      out.basis = priced.length ? `${partial}${parts[0].basis ?? "unknown"}` : "unmetered";
  }
  if (parts.every((r) => r.source === "spend")) {
    // Read from the progress comments' spend lines: dollars as the worker priced them, no tokens, no table.
    out.unit = "usd";
    out.priceTableDate = null;
    out.note = null;
    out.basis = priced.length ? `${partial}factory:spend lines in ${parts.length} progress comment(s), the worker's own pricing (no usage artifact)` : "unmetered: no usage artifact and no factory:spend line";
  } else if (out.parts.length > 1) out.basis += `; ${out.parts.length} artifacts summed (worker + review)`;
  out.vendor = vendorOf(parts);
  out.vendorUsd = out.vendor?.usd ?? null;
  out.totalUsd = out.usd === null && out.vendorUsd === null ? null : round4((out.usd ?? 0) + (out.vendorUsd ?? 0));
  return out;
}
