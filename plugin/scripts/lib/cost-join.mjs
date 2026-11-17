// The cost join (#512): one implementation of an Objective's dollars, shared by the bench scorer (bench/lib/cost.mjs and
// bench/lib/objective.mjs re-export it) and `pendulum report` (report.mjs). Dollars per Objective, with the unit and
// basis per harness (PLAN.md, "Job one and how 0.6 is measured"); each stage counted once across its usage record and its
// progress comment's spend line (withLines); the decision calls outside a stage beside them (decisionSpendRecords). The input is the usage artifact the worker
// job uploads (`pendulum-usage-<issue>`, and `pendulum-usage-<issue>-review`
// for the reviewer pass): its normalized `result.json` (action/scripts/lib/
// usage.mjs: {harness, model, usd, tokens, basis, started, ended, runs,
// passes, exit, reason, credential, turns, priceTableDate}). A raw stream is
// never priced: an artifact with no result.json is a run of unknown cost.
//
//   claude   unit usd      total_cost_usd, modelUsage (sub-agents included)
//   codex    unit usd      tokens priced at OpenAI's Standard rates from the Codex price table (plugin/scripts/lib/codex-prices.json, dated)
//   copilot  unit usd      AI credits from --usage-output-file at the run's $/credit (GitHub: $0.01), premium requests beside
//
// A count a harness does not report is null, never zero. Dollars are real or unknown (usage.mjs UNKNOWN_WHY):
// `usd` sums the known dollars and `usdUnknown` counts the runs of unknown cost, shown as "plus N runs of unknown
// cost", never as $0, an estimate or a bound. What the known dollars are (billed per use on a key, API-equivalent at
// list prices on a subscription, Copilot AI credits billed to the seat, or billing not recorded: usage.mjs
// BILLING) comes from each record's `usdByBilling` and `billing`, which the worker writes; the row keeps `usdByBilling`
// and its basis says it.
//
// A stage that ran in a cloud sandbox also carries the vendor's cost in its record (`vendor`, booked by the launcher
// from the vendor's usage totals at list rates: launch.mjs bookVendor). It is summed beside the model's
// dollars, never into them: `usd` stays the harness's, `vendorUsd` the sandboxes', `totalUsd` both.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decisionSpendEntries } from "./logic.mjs";
import { BILLING_WORDS, CODEX_NO_TOKENS, UNKNOWN_WHY, addBilling, billingCode, billingRead, priceStage, priceTokens, streamSessions, unknownOf, unknownRuns, unknownText } from "./usage.mjs";

/** The one Codex price table, the worker's own (codex-prices.json beside this file). */
export const PRICES_FILE = join(import.meta.dirname, "codex-prices.json");
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
 * `usd` is the known dollars (null when no part reported any), `usdUnknown` the runs of unknown cost (usage.mjs
 * UNKNOWN_WHY: a part's own count, or 1 for a part that ran with no figure), said in the basis ("plus N runs of
 * unknown cost"); `unit` is per harness. `vendor` sums the sandbox vendor's cost the parts carry ({usd, parts,
 * usdUnknown?, basis}, null when no part ran in a sandbox); `totalUsd` is the known model plus vendor dollars and
 * `totalUnknown` the runs of unknown cost in both.
 */
/**
 * A part's known dollars by billing (usage.mjs BILLING) from its record's `usdByBilling`: as recorded, except a
 * Codex part the bench re-priced, whose harness dollars (the part's less the relayed key's) take the record's own
 * `billing` (the kind its harness passes share, as the worker wrote it) and the key's stay `api`. {} when the record
 * names none.
 */
function partBilling(rec, part) {
  const map = billingRead(rec.usdByBilling);
  if (rec.harness !== "codex" || rec.source === "spend" || !Object.keys(map).length) return map;
  // The relayed key's dollars and the AI Gateway decision calls' (`gatewayDecisionUsd`) are billed to a gateway key: `api`.
  const key = (num(rec.workerKeyUsd) ?? 0) + (num(rec.gatewayDecisionUsd) ?? 0);
  const harnessUsd = part.usd === null ? 0 : Math.max(0, part.usd - key);
  return addBilling({ [billingCode(rec.billing) ?? "unknown"]: harnessUsd }, key > 0 ? { api: key } : {});
}

/**
 * The basis's words on what the dollars are: "; billed per use on API keys" when all are, else each kind's dollars:
 * "; 1.2 USD API-equivalent at list prices, on the subscription; 0.3 USD billed per use".
 */
function billingNote(byBilling) {
  const kinds = Object.entries(byBilling);
  if (!kinds.length) return "";
  const other = kinds.filter(([k]) => k !== "api");
  if (!other.length) return "; billed per use on API keys";
  return `; ${other.map(([k, n]) => `${round4(n)} USD ${BILLING_WORDS[k]}`).join("; ")}${byBilling.api > 0 ? `; ${round4(byBilling.api)} USD billed per use` : ""}`;
}

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
      // A promotional rate prices only spend before its end (usage.mjs codexRow): the record's end dates it (a stage's
      // record ends with its latest pass or call, usage.mjs mergeUsage), and a record with none is of unknown cost there.
      const priced = priceStage(prices, rec.model, rec.tokens, rec.subAgents, { at: rec.ended ?? null });
      const key = num(rec.workerKeyUsd);
      const decisions = num(rec.gatewayDecisionUsd);
      part.usd = priced.usd === null && key === null && decisions === null ? null : round4((priced.usd ?? 0) + (key ?? 0) + (decisions ?? 0));
      // The record's own runs of unknown cost (a turn that failed, a sub-agent thread not read), or one for tokens this
      // table cannot price: never $0 for them.
      part.usdUnknown = Number.isInteger(rec.usdUnknown) && rec.usdUnknown > 0 ? rec.usdUnknown : priced.unknown ? 1 : 0;
      // Why this table could not price it (no row, a promotional rate ended, a long-context share not read), beside
      // the record's own reasons.
      if (priced.unknown) part.usdUnknownWhy = [...new Set([...(Array.isArray(rec.usdUnknownWhy) ? rec.usdUnknownWhy : []), ...priced.why])].filter((w) => Object.hasOwn(UNKNOWN_WHY, w));
      // No tokens reported (no turn completed) is no missing price: the worker's own basis for it.
      const noTokens = (rec.tokens?.input ?? null) === null && (rec.tokens?.output ?? null) === null;
      const why = priced.why.find((w) => w !== "unreported") ?? "no-price";
      part.basis = priced.usd === null ? (noTokens ? CODEX_NO_TOKENS : why === "no-price" ? `unknown: no price for ${rec.model ?? "unknown model"} in ${PRICES_NAME}` : `unknown: ${UNKNOWN_WHY[why]} (${rec.model ?? "unknown model"}, ${PRICES_NAME})`) : `tokens priced at OpenAI's Standard rates from ${PRICES_NAME} dated ${prices.date}${prices.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}`;
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
    if (part.usdUnknown && !part.usdUnknownWhy?.length) part.usdUnknownWhy = unknownOf([{ ...rec, usdUnknown: part.usdUnknown }]).usdUnknownWhy;
    // What the part's dollars are (usage.mjs BILLING), as the worker recorded them from its credential.
    const billed = partBilling(rec, part);
    if (Object.keys(billed).length) part.usdByBilling = billed;
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
  // The known dollars by what they are (usage.mjs BILLING), from each part's: said in the basis.
  const byBilling = addBilling(...out.parts.map((p) => p.usdByBilling));
  if (Object.keys(byBilling).length) out.usdByBilling = byBilling;
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
      out.basis = priced.length ? `tokens priced at OpenAI's Standard rates from ${PRICES_NAME} dated ${prices.date}${prices.status === "placeholder" ? " (PLACEHOLDER rates)" : ""}` : unpriced[0].basis;
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
  } else if (stageParts.length > 1) {
    // A mixed-route Objective: its artifacts' stages and its local stages' spend lines, each stage once, each source's basis named.
    const lines = stageParts.filter((r) => r.source === "spend").length;
    out.basis = lines ? `artifacts: ${out.basis}; spend lines: the worker's own pricing, in ${lines} progress comment(s); ${stageParts.length - lines} artifact(s) and ${lines} spend line(s) summed` : `${out.basis}; ${stageParts.length} artifacts summed (worker + review)`;
  }
  if (outside.length) {
    const usd = outside.reduce((s, r) => s + (num(r.usd) ?? 0), 0);
    out.basis += `; includes ${round4(usd)} USD of decision calls outside a stage (the AI Gateway's cost, ${outside.length} comment(s))`;
  }
  out.basis += unknownNote;
  out.basis += billingNote(byBilling);
  // The relayed worker key's dollars are inside the figure already: said, so no reader adds them again.
  if (out.workerKeyUsd > 0 && out.usd !== null) out.basis += `; includes ${out.workerKeyUsd} USD through a relayed worker key`;
  out.vendor = vendorOf(parts);
  out.vendorUsd = out.vendor?.usd ?? null;
  out.totalUsd = out.usd === null && out.vendorUsd === null ? null : round4((out.usd ?? 0) + (out.vendorUsd ?? 0));
  const totalUnknown = (out.usdUnknown ?? 0) + (out.vendor?.usdUnknown ?? 0);
  if (totalUnknown) out.totalUnknown = totalUnknown;
  return out;
}

/** A comment's spend line as written (logic.mjs spendMarker: known `usd`, its parts and `usdUnknown`), or null. */
const spendOf = (body) => {
  try {
    return JSON.parse(/^<!-- pendulum:spend (\{[^\n]*\}) -->$/m.exec(body || "")?.[1] ?? "null");
  } catch {
    return null;
  }
};
/** A spend line's runs of unknown cost and why (usage.mjs UNKNOWN_WHY): {} for none or a broken count. */
const unknownIn = (spend) => {
  if (!Number.isInteger(spend?.usdUnknown) || spend.usdUnknown < 1) return {};
  const why = Array.isArray(spend.usdUnknownWhy) ? [...new Set(spend.usdUnknownWhy.filter((w) => typeof w === "string" && Object.hasOwn(UNKNOWN_WHY, w)))] : [];
  return { usdUnknown: spend.usdUnknown, usdUnknownWhy: why.length ? why : ["unreported"] };
};

const HARNESSES = new Set(["claude", "codex", "copilot"]);
/** An account name as accounts.mjs allows one. */
export const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,33}$/;
/**
 * The harness one stage ran, from its progress comment's structure: the `<!-- pendulum:harness {...} -->` line (plugin
 * logic.mjs harnessMarker, written from the stage's start), else the fixed line the worker writes as it starts the
 * harness, `harness <name>[ (<model>)] attempt N` (no model when none is set: Copilot's default). Null when neither.
 */
export function stageHarnessOf(body) {
  const line = /^<!-- pendulum:harness (\{[^\n]*\}) -->$/m.exec(body || "");
  if (line) {
    try {
      const v = JSON.parse(line[1]);
      // The line's `models` and `labels` (logic.mjs harnessMarker): the Objective's three models and the labels that chose them.
      const str = (x) => (typeof x === "string" && x ? x : null);
      const ran = v?.models && typeof v.models === "object" ? { ran: { worker: str(v.models.worker), subagent: str(v.models.subagent), reviewer: str(v.models.reviewer), labels: Array.isArray(v.labels) ? v.labels.filter((l) => typeof l === "string") : [] } } : {};
      // The local account the stage ran on (accounts.mjs), by name.
      const account = typeof v?.account === "string" && ACCOUNT.test(v.account) ? { account: v.account } : {};
      if (HARNESSES.has(v?.harness)) return { harness: v.harness, model: str(v.model), ...ran, ...account };
    } catch {
      // a malformed line: read the progress line instead
    }
  }
  const ran = /^- \d\d:\d\dZ harness (claude|codex|copilot)(?: \(([^)\s]+)\))? attempt \d+/m.exec(body || "");
  return ran ? { harness: ran[1], model: ran[2] ?? null } : null;
}

/**
 * Each account's share of an Objective (#266), in the order first seen: `stages` (the stages that ran on it), `usd`
 * (their known dollars, null when none was reported), `unknown` (their runs of unknown cost, usage.mjs
 * UNKNOWN_WHY) and `limitPauses` (the stages a usage limit paused on it: a result.json
 * that ended `paused` with its `usageLimit`, or `waiting` with it to go on on another account on GitHub Actions and the
 * cloud sandbox, #268; or a spend line's `limitPaused`). From records that name their account; empty where none does.
 */
export function accountUse(usage) {
  const by = new Map();
  for (const r of usage || []) {
    if (typeof r?.account !== "string" || !ACCOUNT.test(r.account)) continue;
    const a = by.get(r.account) ?? { account: r.account, stages: 0, usd: null, unknown: 0, limitPauses: 0 };
    a.stages += 1;
    if (typeof r.usd === "number" && Number.isFinite(r.usd)) a.usd = Math.round(((a.usd ?? 0) + r.usd) * 1e4) / 1e4;
    a.unknown += unknownRuns(r);
    // What its dollars are (usage.mjs BILLING), when the records name it.
    const billed = addBilling(a.usdByBilling, r.usdByBilling);
    if (Object.keys(billed).length) a.usdByBilling = billed;
    if (r.limitPaused === true || ((r.exit === "paused" || r.exit === "waiting") && r.usageLimit && typeof r.usageLimit === "object")) a.limitPauses += 1;
    by.set(r.account, a);
  }
  return [...by.values()];
}

/** Which progress-line records (stageSpendRecords) a usage record stands for, by the rules withLines states: a predicate. */
export const coversLine = (r) => {
  const claimOf = (x) => (typeof x?.vendor?.claim === "string" && /^[0-9a-f]{12}$/.test(x.vendor.claim) ? x.vendor.claim : null);
  const stage = stageOf(r);
  const key = (l) => (stageOf(l) === stage && typeof l.progressRun === "string" ? l.progressRun : null);
  if (typeof r.progressRun === "string") return (l) => key(l) === r.progressRun;
  const claim = claimOf(r);
  if (claim) return (l) => key(l) === claim || !!key(l)?.endsWith(`-${claim}`);
  if (Number.isInteger(r.workflowRun)) return (l) => key(l) === String(r.workflowRun) || new RegExp(`^${r.workflowRun}-\\d{1,4}$`).test(key(l) ?? "");
  if (!Object.hasOwn(r, "progressRun") && typeof r.account === "string") return (l) => key(l) !== null && l.account === r.account;
  return () => false;
};

/**
 * The usage records given and the stages' progress-line records (stageSpendRecords) together, each stage once, whatever
 * order the records come in. A record stands for the progress comments of its own stage (work or review, stageOf) that
 * it names exactly:
 * - its `progressRun`, the comment's key (session.mjs writeUsage; null: the stage had no comment);
 * - else, a cloud sandbox stage's record (its `vendor.claim`): the comment keyed `<claim>` or `<run>-<claim>`
 *   (launch.mjs stageProgressKey);
 * - else, a GitHub Actions artifact (its `workflowRun`, collect.mjs): the comments keyed `<run>` or `<run>-<attempt>`
 *   (session.mjs progressRunId);
 * - else, a record with no `progressRun` field at all (written before records named their comment) on an account:
 *   that account's comments.
 * A stand-in (`standIn`: Pendulum's record for a stage whose own process wrote none) gives way to the comments it stands
 * for, the first taking its sandbox cost when it has none; when another record stands for them all, its sandbox cost goes
 * to that record (when it has none) and it is dropped. A record that is no stand-in takes the sandbox cost of a comment
 * it stands for when it has none of its own. A record that names no comment counts beside the comments, but a
 * figure is never counted twice: a record with no `progressRun` field beside an unnamed comment of its stage with
 * dollars may be that stage, so its dollars are unknown there (UNKNOWN_WHY `unmatched`).
 */
export const withLines = (records = [], lines = []) => {
  const covers = coversLine;
  const all = records.filter(Boolean);
  // Who counts each comment: a record that is no stand-in first, then the stand-ins in turn.
  const owner = new Map();
  const out = all.filter((r) => !r.standIn).map((r) => ({ ...r }));
  for (const r of out) {
    for (const l of lines.filter(covers(r))) {
      owner.set(l, owner.get(l) ?? r);
      // The stage's sandbox cost, booked on its comment (its vendor comment): the record takes it when it has none.
      if (l.vendor && !r.vendor) r.vendor = l.vendor;
    }
  }
  for (const r of all.filter((x) => x.standIn)) {
    const mine = lines.filter(covers(r));
    const free = mine.filter((l) => !owner.has(l));
    if (free.length) {
      free.forEach((l, i) => {
        const line = i === 0 && r.vendor && !l.vendor ? { ...l, vendor: r.vendor } : { ...l };
        owner.set(l, line);
        out.push(line);
      });
    } else if (mine.length) {
      const taker = owner.get(mine[0]);
      if (r.vendor && !taker.vendor) taker.vendor = r.vendor;
    } else out.push({ ...r });
  }
  const rest = lines.filter((l) => !owner.has(l));
  // A record that cannot say which comment is its own, beside an unnamed comment of its stage with dollars: unknown there.
  const unsure = (r) => !Object.hasOwn(r, "progressRun") && !lines.some(covers(r)) && rest.some((l) => stageOf(l) === stageOf(r) && typeof l.usd === "number" && l.usd > 0);
  const known = (r) => r.runs !== 0 && ((typeof r.usd === "number" && r.usd > 0) || (r.harness === "codex" && (r.tokens?.input ?? null) !== null));
  const counted = out.map((r) => (unsure(r) && known(r) ? { ...r, usd: null, tokens: { input: null, output: null, cached: null, written: null }, subAgents: undefined, workerKeyUsd: undefined, usdByBilling: undefined, usdUnknown: Math.max(1, Number.isInteger(r.usdUnknown) ? r.usdUnknown : 0), usdUnknownWhy: [...new Set([...(Array.isArray(r.usdUnknownWhy) ? r.usdUnknownWhy : []), "unmatched"])] } : r));
  return [...counted, ...rest];
};

/**
 * Usage records from Pendulum's spend lines (`<!-- pendulum:spend {...} -->`, logic.mjs spendMarker), one per progress
 * comment of `stages`, Objective `n`'s work and review progress comments that the caller trusts as Pendulum's own, oldest
 * first; `vendors` its trusted vendor comments (`<!-- pendulum:<n>:vendor:<key> -->`, launch.mjs bookVendor), oldest
 * first. A sandbox stage's vendor dollars are in its vendor comment (one of a stage that left no progress comment is a
 * row of its own); an older stage's progress spend line carries them itself. A stage whose comment has no spend line is
 * a part of unknown cost. A line's runs of unknown cost (`usdUnknown`) ride on the record, a sandbox the vendor reported
 * no usage for on its `vendor` (usd null). The harness and model are the stage's own (stageHarnessOf), carried to the
 * review stages; dollars are the worker's own pricing. Without `all`, none when no stage has a spend line or a sandbox.
 */
export function stageSpendRecords(n, stages = [], vendors = [], { all = false } = {}) {
  const keyOf = (body, kind) => new RegExp(`^<!-- pendulum:${n}:${kind}:([A-Za-z0-9:-]{1,100}) -->`).exec(body || "")?.[1] ?? null;
  let harness = null;
  let model = null;
  const out = [];
  for (const c of [...stages, ...vendors.filter((v) => !stages.some((p) => keyOf(p.body, "progress") === keyOf(v.body, "vendor")))]) {
    const own = (c.body || "").startsWith(`<!-- pendulum:${n}:vendor:`);
    const booked = own ? c : vendors.find((v) => keyOf(v.body, "vendor") === keyOf(c.body, "progress"));
    const body = own ? (c.body || "").replace(`<!-- pendulum:${n}:vendor:`, `<!-- pendulum:${n}:progress:`) : c.body || "";
    const kind = new RegExp(`^<!-- pendulum:${n}:progress:(work|review)`).exec(body)[1];
    // The comment's whole key (session.mjs progressRunId: a re-run's `<run>-<attempt>`, a sandbox stage's
    // `<run>-<claim>`), which the stage's usage record names as its `progressRun` (withLines).
    const id = /^<!-- pendulum:\d+:progress:(?:work|review):([A-Za-z0-9-]{1,100}) -->/.exec(body)?.[1] ?? /^<!-- pendulum:\d+:progress:(?:work|review):([^\s>-]+)/.exec(body)?.[1] ?? c.id ?? out.length;
    const ran = stageHarnessOf(body);
    if (ran) [harness, model] = [ran.harness, ran.model];
    const line = /^<!-- pendulum:spend (\{[^\n]*\}) -->$/m.exec(body);
    let spend = null;
    try {
      spend = line ? JSON.parse(line[1]) : null;
    } catch {
      spend = null;
    }
    const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    const bookedSpend = booked && !own ? spendOf(booked.body) : null;
    const total = num(spend?.usd);
    const vendor = num(bookedSpend?.vendorUsd) ?? num(spend?.vendorUsd);
    // The vendor comment's own figure (logic.mjs vendorBody): with no figure, the vendor reported no usage.
    const booking = own ? spend : bookedSpend;
    // A sandbox whose usage the vendor did not report: no figure, or its spend line names the sandbox as unknown.
    const sandboxUnknown = !!booking && Object.hasOwn(booking, "vendorUsd") && (num(booking.vendorUsd) === null || (Array.isArray(booking.usdUnknownWhy) && booking.usdUnknownWhy.includes("sandbox")));
    const sandbox = booking && Object.hasOwn(booking, "vendorUsd") ? { usd: num(booking.vendorUsd), ...(sandboxUnknown ? { usdUnknown: 1 } : {}) } : vendor !== null ? { usd: vendor } : null;
    // The model's runs of unknown cost: the progress line's; a vendor comment standing alone counts the sandbox's own in
    // its line too (vendorBody), which `vendor` above carries, so that one is not counted twice.
    const lineUnknown = unknownIn(spend);
    const modelUnknown = own && lineUnknown.usdUnknown && sandboxUnknown ? (lineUnknown.usdUnknown > 1 ? { usdUnknown: lineUnknown.usdUnknown - 1, usdUnknownWhy: lineUnknown.usdUnknownWhy.filter((w) => w !== "sandbox") } : {}) : lineUnknown;
    // An older stage's spend line holds model plus vendor; a vendor comment's dollars are apart from the progress line's.
    const modelUsd = num(spend?.modelUsd) ?? (bookedSpend ? total : total !== null && vendor !== null ? Math.max(0, total - vendor) : total);
    out.push({ source: "spend", harness, model, ...(ran?.ran ? { ran: ran.ran } : {}), ...(ran?.account ? { account: ran.account } : {}), ...(spend?.limitPaused === true ? { limitPaused: true } : {}), usd: spend ? modelUsd : null, ...(num(spend?.workerKeyUsd) !== null ? { workerKeyUsd: num(spend.workerKeyUsd) } : {}), ...(Object.keys(billingRead(spend?.usdByBilling)).length ? { usdByBilling: billingRead(spend.usdByBilling), ...(billingCode(spend.billing) ? { billing: spend.billing } : {}) } : {}), ...modelUnknown, tokens: { input: null, output: null, cached: null, written: null }, runs: 1, artifact: `spend/${kind}/${id}`, progressRun: String(id), basis: spend ? "pendulum:spend line (the worker's own pricing)" : "unknown: no pendulum:spend line in the stage's progress comment", ...(sandbox ? { vendor: sandbox } : {}) });
  }
  // None with a spend line (an Actions stage writes none; its artifact expired): no dollars here either.
  if (!all && !out.some((r) => r.usd !== null || r.vendor)) return [];
  // The first stage names the harness; a review stage before any work line takes the Objective's.
  return out.map((r) => ({ ...r, harness: r.harness ?? harness, model: r.model ?? model }));
}

/**
 * Usage records of the decision calls made about Objective `n` outside any stage (the dispatcher's, the launcher's and
 * local mode's answer, comment, edit and lapse checks): the decision-spend lines (logic.mjs decisionSpendMarker) in
 * `comments`, the ones the caller trusts as Pendulum's own, one record per comment that has any, summed over its days
 * (`keep(entry)`: the days counted, every one by default): their known dollars and calls of unknown cost, `source`
 * "decisions", on every route (no usage artifact carries them).
 */
export function decisionSpendRecords(n, comments = [], { keep = () => true } = {}) {
  const ms = (at) => (at ? Date.parse(at) : NaN);
  return (comments || [])
    .filter((c) => (c.body || "").startsWith(`<!-- pendulum:${n}:`) && decisionSpendEntries(c.body).filter(keep).length)
    .sort((a, b) => ms(a.created_at) - ms(b.created_at))
    .map((c) => {
      const days = decisionSpendEntries(c.body).filter(keep);
      const unknown = days.reduce((s, d) => s + (d.usdUnknown ?? 0), 0);
      const usd = Math.round(days.reduce((s, d) => s + d.usd, 0) * 1e6) / 1e6;
      // The AI Gateway's calls, billed to its key: `api` (usage.mjs BILLING).
      return { source: "decisions", harness: null, model: null, billing: "api", usdByBilling: { api: usd }, usd, ...(unknown ? { usdUnknown: unknown, usdUnknownWhy: [...new Set(days.flatMap((d) => (d.usdUnknown ? d.usdUnknownWhy : [])))] } : {}), tokens: { input: null, output: null, cached: null, written: null }, basis: "pendulum:decision-spend lines of decision calls outside a stage (the AI Gateway's cost)" };
    });
}
