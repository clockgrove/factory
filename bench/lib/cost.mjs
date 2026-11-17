// Dollars per Objective, with the unit and basis per harness (PLAN.md, "Job
// one and how 0.6 is measured"). The input is the usage artifact the worker
// job uploads (`pendulum-usage-<issue>`, and `pendulum-usage-<issue>-review`
// for the reviewer pass): its normalized `result.json` (action/scripts/lib/
// usage.mjs: {harness, model, usd, tokens, basis, started, ended, runs,
// passes, exit, reason, credential, turns, priceTableDate}). A raw stream is
// never priced: an artifact with no result.json is a run of unknown cost.
//
//   claude   unit usd      total_cost_usd, modelUsage (sub-agents included)
//   codex    unit usd      tokens priced from the Codex price table (plugin/scripts/lib/codex-prices.json, dated)
//   copilot  unit usd      AI credits from --usage-output-file at the run's $/credit (GitHub: $0.01), premium requests beside
//
// A count a harness does not report is null, never zero. Dollars are real or unknown (plugin usage.mjs UNKNOWN_WHY):
// `usd` sums the known dollars and `usdUnknown` counts the runs of unknown cost, shown as "plus N runs of unknown
// cost", never as $0, an estimate or a bound.
//
// A stage that ran in a cloud sandbox also carries the vendor's cost in its record (`vendor`, booked by the launcher
// from the vendor's usage totals at list rates: plugin/scripts/launch.mjs bookVendor). It is summed beside the model's
// dollars, never into them: `usd` stays the harness's, `vendorUsd` the sandboxes', `totalUsd` both.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_NO_TOKENS, UNKNOWN_WHY, priceStage, priceTokens, streamSessions, unknownOf, unknownRuns, unknownText } from "../../plugin/scripts/lib/usage.mjs";

/** The one Codex price table, the worker's own (plugin/scripts/lib/codex-prices.json). */
export const PRICES_FILE = join(import.meta.dirname, "..", "..", "plugin", "scripts", "lib", "codex-prices.json");
const PRICES_NAME = "codex-prices.json";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const add = (a, b) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const round4 = (n) => (n === null ? null : Math.round(n * 10000) / 10000);

export function loadPrices(file = PRICES_FILE) {
  const prices = JSON.parse(readFileSync(file, "utf8"));
  if (!prices.perMillion || typeof prices.perMillion !== "object") throw new Error(`${file}: no perMillion table`);
  return prices;
}

/** USD for Codex tokens at the table's rates (usage.mjs codexRate: exact id or dated snapshot); null when unlisted. */
export { priceTokens };

/**
 * The prompt cache across an Objective's artifacts (the usage record's `cache`, session.mjs writeUsage): the TTLs
 * Pendulum asked for, and each run that followed a CI wait with its first request's cache writes. A/B the
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
 * The sandbox vendor's cost across an Objective's usage records: each stage's known `vendor.usd` summed, with how many
 * stages it covers and how many the vendor reported no usage for (`usdUnknown`: runs of unknown cost, never $0 or a
 * ceiling). Null when no record ran in a sandbox.
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
  // A stage whose usage the vendor did not report: its known parts (a creation, storage) are summed, its compute unknown.
  const unreported = (r) => num(r.vendor.usd) === null || r.vendor.usageUnknown === true || (r.vendor.usdUnknown ?? 0) > 0;
  const rates = withVendor.map((r) => r.vendor.rates).find((x) => x && typeof x === "object");
  const usd = priced.length ? round4(priced.reduce((s, r) => s + r.vendor.usd, 0)) : null;
  const unknown = withVendor.filter(unreported).length;
  const basis = `${withVendor.length} sandbox stage(s)${unknown ? `, ${unknown} of unknown cost (${UNKNOWN_WHY.sandbox})` : ""}; ${rates ? `${rates.vendor ?? "vendor"} ${rates.plan ?? ""} list rates (${rates.region ?? "?"}) read ${rates.date ?? "?"}` : "list rates"}`;
  return { usd, parts: withVendor.length, ...(unknown ? { usdUnknown: unknown } : {}), basis, storedUsd: round4(withVendor.reduce((s, r) => s + (num(r.vendor.storedUsd) ?? 0), 0)) };
}

/** Harness calls and distinct sessions in a raw event stream (the worker's own reading, usage.mjs streamSessions). */
export const sessionsOf = streamSessions;

/**
 * A usage file's content to its record: a stage's result.json (the worker's normalized record), else null. A raw
 * stream (events.jsonl, a harness's own output) is never priced here: a resumed pass's running total would count
 * twice and a killed pass not at all; the stage's own record says what was reported and what is unknown.
 */
export function parseUsageText(text) {
  let value = null;
  try {
    value = JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
  return value && typeof value === "object" && !Array.isArray(value) && value.harness ? { ...value, runs: value.runs ?? 1 } : null;
}

/**
 * The stage a usage record came from, by its artifact's name: the review job's `pendulum-usage-<n>-review`, a local
 * loop's `usage-review-<stamp>/`, a spend line's `spend/review/<id>`; any other name is the work stage's.
 */
export function stageOf(rec) {
  return typeof rec?.artifact === "string" && /(^|[-/])review([-/]|$)/.test(rec.artifact) ? "review" : "work";
}

/**
 * The cost row from one Objective's usage records (the worker's artifact,
 * then any reviewer artifacts), on `prices` for Codex:
 *   { harness, model, unit, usd, usdUnknown?, usdUnknownWhy?, tokens, basis, parts: [{artifact, usd, usdUnknown, tokens, basis}], priceTableDate, note }
 * `usd` is the known dollars (null when no part reported any), `usdUnknown` the runs of unknown cost (plugin usage.mjs
 * UNKNOWN_WHY: a part's own count, or 1 for a part that ran with no figure), said in the basis ("plus N runs of
 * unknown cost"); `unit` is per harness. `vendor` sums the sandbox vendor's cost the parts carry ({usd, parts,
 * usdUnknown?, basis}, null when no part ran in a sandbox); `totalUsd` is the known model plus vendor dollars and
 * `totalUnknown` the runs of unknown cost in both.
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
    const part = { artifact: rec.artifact ?? null, harness: rec.harness, model: rec.model ?? null, usd: null, usdUnknown: 0, tokens: rec.tokens ?? { input: null, output: null, cached: null }, basis: rec.basis ?? null };
    if (rec.runs === 0 && !unknownRuns(rec)) {
      // A job that ran no harness (a review job that skipped an already-reviewed PR) cost nothing: not unknown.
      part.usd = 0;
      part.basis = `no harness run (${rec.exit ?? "skipped"})`;
      out.parts.push(part);
      continue;
    }
    if (rec.source === "spend") {
      // Pendulum's spend line (no usage artifact): the worker's own dollars, whatever the harness; never repriced.
      part.usd = num(rec.usd);
      part.usdUnknown = unknownRuns(rec);
      part.basis = rec.basis ?? "pendulum:spend line";
    } else if (rec.harness === "claude") {
      part.usd = num(rec.usd);
      part.usdUnknown = unknownRuns(rec);
      part.basis = rec.basis && /harness-reported/.test(rec.basis) ? rec.basis : part.usd === null ? "unknown: no total_cost_usd" : "harness-reported: total_cost_usd, modelUsage (sub-agents included)";
    } else if (rec.harness === "codex") {
      // The bench's table replaces whatever the worker priced with: one price basis per scorecard.
      // Its sub-agent threads (the record's `subAgents`) each at their own model, the rest at the stage's. The spend
      // through a relayed gateway key and the AI Gateway's decision calls (`gatewayDecisionUsd`) are no harness spend:
      // kept as the gateway reported them.
      const priced = priceStage(prices, rec.model, rec.tokens, rec.subAgents);
      const key = num(rec.workerKeyUsd);
      const decisions = num(rec.gatewayDecisionUsd);
      part.usd = priced.usd === null && key === null && decisions === null ? null : round4((priced.usd ?? 0) + (key ?? 0) + (decisions ?? 0));
      // The record's own runs of unknown cost (a turn that failed, a sub-agent thread not read), or one for tokens this
      // table cannot price: never $0 for them.
      part.usdUnknown = Number.isInteger(rec.usdUnknown) && rec.usdUnknown > 0 ? rec.usdUnknown : priced.unknown ? 1 : 0;
      // No tokens reported (no turn completed) is no missing price: the worker's own basis for it.
      const noTokens = (rec.tokens?.input ?? null) === null && (rec.tokens?.output ?? null) === null;
      part.basis = priced.usd === null ? (noTokens ? CODEX_NO_TOKENS : `unknown: no price for ${rec.model ?? "unknown model"} in ${PRICES_NAME}`) : `tokens priced from ${PRICES_NAME} dated ${prices.date}${prices.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}`;
    } else if (rec.harness === "copilot") {
      // The worker prices the AI credits its usage file reports (usage.mjs parseCopilot); an artifact from before that,
      // or a run that reported none, is of unknown cost.
      part.usd = num(rec.usd);
      part.usdUnknown = unknownRuns(rec);
      part.basis = part.usd === null ? "unknown: no AI credits in the usage artifact" : rec.basis ?? "harness-reported: AI credits";
      part.premiumRequests = num(rec.premiumRequests);
      part.aiCredits = num(rec.aiCredits ?? rec.aiu);
      out.premiumRequests = add(out.premiumRequests ?? null, part.premiumRequests);
      out.aiCredits = add(out.aiCredits ?? null, part.aiCredits);
    } else {
      part.usd = num(rec.usd);
      part.usdUnknown = unknownRuns(rec);
      part.basis = rec.basis ?? "unknown harness";
    }
    if (part.usdUnknown) part.usdUnknownWhy = unknownOf([{ ...rec, usdUnknown: part.usdUnknown }]).usdUnknownWhy;
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
  const unpriced = out.parts.filter((p) => p.usd === null);
  const priced = out.parts.filter((p) => p.usd !== null);
  // The known dollars are summed; the runs of unknown cost are counted beside them, never as $0 and never hidden.
  out.usd = priced.length ? round4(priced.reduce((s, p) => s + p.usd, 0)) : null;
  const unknown = unknownOf(out.parts.map((p) => ({ usd: p.usd, usdUnknown: p.usdUnknown, usdUnknownWhy: p.usdUnknownWhy, runs: p.usdUnknown ? 1 : 0 })));
  if (unknown.usdUnknown) Object.assign(out, unknown);
  // Said after the known figure's basis: "plus 2 runs of unknown cost (why; why)".
  const unknownNote = unknown.usdUnknown ? `;${unknownText(unknown.usdUnknown)} (${unknown.usdUnknownWhy.map((w) => UNKNOWN_WHY[w]).join("; ")})` : "";
  switch (harness) {
    case "claude":
      out.unit = "usd";
      out.basis = priced.length ? `harness-reported: total_cost_usd, modelUsage (sub-agents included)` : `unknown: ${unpriced.map((p) => String(p.basis ?? "").replace(/^unknown:?\s*/, "") || "no total_cost_usd").join("; ")}`;
      break;
    case "codex":
      // Dollars priced from the table are the measure (PLAN.md); tokens stay the unit only while unpriced.
      out.unit = priced.length ? "usd" : "tokens";
      out.priceTableDate = prices.date;
      out.basis = priced.length ? `tokens priced from ${PRICES_NAME} dated ${prices.date}${prices.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}` : unpriced[0].basis;
      out.note = prices.status === "placeholder" ? `${PRICES_NAME} carries placeholder rates; replace them before reading this as dollars` : null;
      break;
    case "copilot":
      out.unit = "usd";
      out.basis = priced.length ? `harness-reported: ${out.aiCredits === null ? "?" : Math.round(out.aiCredits * 1000) / 1000} AI credits, ${out.premiumRequests ?? "?"} premium request(s); dollars at each run's $/credit` : unpriced.map((p) => p.basis).join("; ");
      out.note = priced.length ? null : "This Copilot artifact carries no AI credits (written before Pendulum priced them, or the run reported none); attribute from the org's billing data by this row's time window, or leave it unknown";
      break;
    default:
      out.unit = "usd";
      out.basis = priced.length ? `${parts[0].basis ?? "unknown"}` : "unknown";
  }
  // The decision calls made outside any stage (plugin decision-spend.mjs): parts of their own, said apart in the basis.
  const outside = parts.filter((r) => r.source === "decisions");
  const stageParts = parts.filter((r) => r.source !== "decisions");
  if (stageParts.length && stageParts.every((r) => r.source === "spend")) {
    // Read from the progress comments' spend lines: dollars as the worker priced them, no tokens, no table.
    out.unit = "usd";
    out.priceTableDate = null;
    out.note = null;
    out.basis = priced.length ? `pendulum:spend lines in ${stageParts.length} progress comment(s), the worker's own pricing (no usage artifact)` : unknown.usdUnknown ? "unknown: no stage's spend line holds a reported figure" : "unknown: no usage artifact and no pendulum:spend line";
  } else if (stageParts.length > 1) out.basis += `; ${stageParts.length} artifacts summed (worker + review)`;
  if (outside.length) {
    const usd = outside.reduce((s, r) => s + (num(r.usd) ?? 0), 0);
    out.basis += `; includes ${round4(usd)} USD of decision calls outside a stage (the AI Gateway's cost, ${outside.length} comment(s))`;
  }
  out.basis += unknownNote;
  // The relayed worker key's dollars are inside the figure already: said, so no reader adds them again.
  if (out.workerKeyUsd > 0 && out.usd !== null) out.basis += `; includes ${out.workerKeyUsd} USD through a relayed worker key`;
  out.vendor = vendorOf(parts);
  out.vendorUsd = out.vendor?.usd ?? null;
  out.totalUsd = out.usd === null && out.vendorUsd === null ? null : round4((out.usd ?? 0) + (out.vendorUsd ?? 0));
  const totalUnknown = (out.usdUnknown ?? 0) + (out.vendor?.usdUnknown ?? 0);
  if (totalUnknown) out.totalUnknown = totalUnknown;
  return out;
}
