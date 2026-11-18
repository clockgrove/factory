// A stage's figures from its per-pass ledger (usage.mjs passLedger, logic.mjs ledgerOfComment), worked out once, in one
// place, for both readers: `pendulum report` (report.mjs) from a stage's own records, and the finish card's summary
// (finish-card.mjs finishSummary), which a report reads a merged Objective from (#544). Both fold the same per-stage
// figures into their totals, so the two paths give the same numbers.

import { BILLING, UNKNOWN_WHY, billingRead } from "./usage.mjs";

/** The cost kinds a figure is split into, never added together: the billing kinds (usage.mjs BILLING) and the sandbox's. */
export const COST_KINDS = Object.freeze([...BILLING, "sandbox"]);

const ms = (at) => (at ? Date.parse(at) : NaN);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const PASS_LABEL = /^[a-z][a-z0-9-]{0,60}$/;

/** A cost with every kind at zero: dollars per kind (COST_KINDS), the runs of unknown cost and why (UNKNOWN_WHY codes). */
export const zeroCost = () => ({ usd: Object.fromEntries(COST_KINDS.map((k) => [k, 0])), unknownRuns: 0, unknownWhy: [] });
/**
 * `c` added into `into`; a cost that splits its runs of unknown cost (the report's `unknownDecisionCalls` and
 * `unknownUnsplitRuns`) takes `c`'s, 0 where `c` has none.
 */
export const addCost = (into, c) => {
  for (const k of COST_KINDS) into.usd[k] = round6(into.usd[k] + c.usd[k]);
  into.unknownRuns += c.unknownRuns;
  for (const k of ["unknownDecisionCalls", "unknownUnsplitRuns"]) if (Object.hasOwn(into, k)) into[k] += c[k] ?? 0;
  into.unknownWhy = [...new Set([...into.unknownWhy, ...c.unknownWhy])].sort();
  return into;
};
export const zeroTokens = () => ({ input: null, output: null, cached: null, written: null });
export const addTokens = (into, t) => {
  for (const k of Object.keys(into)) if (num(t?.[k]) !== null) into[k] = (into[k] ?? 0) + t[k];
  return into;
};

/**
 * A pass's label without its count (`work-2` is `work`, `validation-fix-3` is `validation-fix`): the pass breakdown's key.
 */
export const passLabel = (label) => (typeof label === "string" && PASS_LABEL.test(label) ? label.replace(/-\d+$/, "") : "other");
export const isFix = (kind) => /-(?:fix|fresh)$/.test(kind);
export const isAnswer = (kind) => kind === "answer" || kind.startsWith("answer-");

/** One ledger entry as the report reads it: its kind, cost by billing, tokens and minutes; null for a broken one. */
function ledgerPass(e) {
  if (!e || typeof e !== "object") return null;
  const c = zeroCost();
  const usd = num(e.usd);
  const kind = BILLING.includes(e.billing) ? e.billing : "unknown";
  // Its dollars by kind as the ledger split them (a relayed key's share is `api`), the rest at the pass's own kind.
  const by = billingRead(e.usdByBilling);
  let named = 0;
  for (const [k, n] of Object.entries(by)) {
    c.usd[k] = round6(c.usd[k] + n);
    named += n;
  }
  if (usd !== null && usd - named > 1e-9) c.usd[kind] = round6(c.usd[kind] + usd - named);
  c.unknownRuns = Number.isInteger(e.usdUnknown) && e.usdUnknown > 0 ? e.usdUnknown : usd === null ? 1 : 0;
  c.unknownWhy = c.unknownRuns ? (Array.isArray(e.usdUnknownWhy) && e.usdUnknownWhy.length ? e.usdUnknownWhy : ["unreported"]).filter((w) => Object.hasOwn(UNKNOWN_WHY, w)).sort() : [];
  const minutes = Number.isFinite(ms(e.started)) && Number.isFinite(ms(e.ended)) && ms(e.ended) >= ms(e.started) ? (ms(e.ended) - ms(e.started)) / 60_000 : null;
  return { kind: e.decision ? "decision" : passLabel(e.label), priced: usd !== null, cost: c, tokens: e.tokens || {}, minutes, decision: e.decision === true };
}

/**
 * A stage's passes from its per-pass `ledger`, one entry per pass kind (passLabel; `decision` for a decision record), in
 * the order of their first pass: `kind`, `passes` (how many), `cost` and `tokens` (theirs, summed), `minutes` (their
 * model minutes, null when none has its times), `harnessMinutes` (the same over its harness passes alone, decision
 * records left out; null when none has its times), `cache` (`{passes, written, input}` over the passes whose input and
 * cache writes are both reported, null for none), `untimed` (its harness passes with no start or end) and, over the
 * harness passes with their times, `priced` (`{minutes, passes, cost}` of those whose dollars were all reported) and
 * `unpriced` (the count of the rest).
 */
export function stagePassFigures(ledger) {
  const kinds = new Map();
  for (const p of (Array.isArray(ledger) ? ledger : []).map(ledgerPass).filter(Boolean)) {
    const k = kinds.get(p.kind) ?? { kind: p.kind, passes: 0, cost: zeroCost(), tokens: zeroTokens(), minutes: null, harnessMinutes: null, cache: null, untimed: 0, priced: { minutes: 0, passes: 0, cost: zeroCost() }, unpriced: 0 };
    k.passes += 1;
    addCost(k.cost, p.cost);
    addTokens(k.tokens, p.tokens);
    if (num(p.tokens.input) !== null && num(p.tokens.written) !== null) {
      k.cache ??= { passes: 0, written: 0, input: 0 };
      k.cache.passes += 1;
      k.cache.written += p.tokens.written;
      k.cache.input += p.tokens.input;
    }
    if (p.minutes !== null) k.minutes = (k.minutes ?? 0) + p.minutes;
    if (!p.decision && p.minutes !== null) k.harnessMinutes = (k.harnessMinutes ?? 0) + p.minutes;
    else if (!p.decision) k.untimed += 1;
    if (!p.decision && p.minutes !== null) {
      if (p.cost.unknownRuns || !p.priced) k.unpriced += 1;
      else {
        k.priced.minutes += p.minutes;
        k.priced.passes += 1;
        addCost(k.priced.cost, p.cost);
      }
    }
    kinds.set(p.kind, k);
  }
  return [...kinds.values()];
}
