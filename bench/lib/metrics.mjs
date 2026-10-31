/**
 * The metrics runs are compared on, read from a scorecard, and the
 * hill-climb comparison: a candidate group's median against the baseline
 * group's spread (min to max). Better means beyond the whole spread; inside
 * it is noise. A candidate is accepted on outcomes (bench/README.md#Hill-climb):
 * its grade is not worse, its human effort or its time to delivery is
 * better, its stage escapes are not worse, its cost is not worse, and with
 * a judge, it wins at least half the blind pairwise judgments on intent.
 * The effort metrics (tokens, active time, repairs, first-pass rates) are
 * diagnostics: shown, never deciding.
 */
/**
 * The scorecard's schema. 2: active time leaves out waits for an answer
 * with nothing running; hold waits leave out downtime; validation counts
 * each result's first validation; CI leaves out base conflicts; `partial`.
 * 3 (#2223): outcomes first: `grade`, `human`, `deliveryMs`, `waste`,
 * `escapes` and `cost`. Cards of another version mean other things by the
 * same names, or lack them.
 */
export const SCORECARD_VERSION = 3;

const at = (node, path) =>
  path.split(".").reduce((value, key) => value?.[key], node) ?? null;
const totals = (path) => (card) => at(card.totals, path);
const outcome = (path) => (card) => at(card, path);

export const METRICS = {
  "grade.passRate": {
    label: "Grade: criteria the grader passed",
    unit: "rate",
    better: "higher",
    get: outcome("grade.passRate"),
  },
  "human.score": {
    label: "Human effort (weighted touches)",
    unit: "count",
    better: "lower",
    get: outcome("human.score"),
  },
  deliveryMs: {
    label: "Time to delivery",
    unit: "ms",
    better: "lower",
    get: outcome("deliveryMs"),
  },
  "waste.tokensShare": {
    label: "Waste: share of tokens",
    unit: "rate",
    better: "lower",
    get: outcome("waste.tokensShare"),
  },
  "escapes.total": {
    label: "Stage escapes",
    unit: "count",
    better: "lower",
    get: outcome("escapes.total"),
  },
  "cost.usd": {
    label: "Cost",
    unit: "usd",
    better: "lower",
    get: outcome("cost.usd"),
  },
  "tokens.total": {
    label: "Tokens, own and child threads",
    unit: "tokens",
    better: "lower",
    get: totals("tokens.total"),
  },
  "tokens.counted": {
    label: "Tokens the spend limit counted",
    unit: "tokens",
    better: "lower",
    get: totals("tokens.counted"),
  },
  tokensPerCriterion: {
    label: "Tokens per acceptance criterion",
    unit: "tokens",
    better: "lower",
    get: totals("tokensPerCriterion"),
  },
  activeWallMs: {
    label: "Active wall time",
    unit: "ms",
    better: "lower",
    get: totals("activeWallMs"),
  },
  modelMs: {
    label: "Model time",
    unit: "ms",
    better: "lower",
    get: totals("modelMs"),
  },
  repairs: {
    label: "Repairs",
    unit: "count",
    better: "lower",
    get: totals("repairs"),
  },
  "planning.revisions": {
    label: "Planning revisions",
    unit: "count",
    better: "lower",
    get: totals("planning.revisions"),
  },
  "holds.operator": {
    label: "Holds for the operator",
    unit: "count",
    better: "lower",
    get: totals("holds.operator"),
  },
  "holds.operatorWaitMs": {
    label: "Operator wait",
    unit: "ms",
    better: "lower",
    get: totals("holds.operatorWaitMs"),
  },
  "validation.firstPassRate": {
    label: "Results passing their first validation",
    unit: "rate",
    better: "higher",
    get: totals("validation.firstPassRate"),
  },
  "ci.firstPassRate": {
    label: "CI first-pass rate",
    unit: "rate",
    better: "higher",
    get: totals("ci.firstPassRate"),
  },
  // From a grader that reviews as well as grades (bench/grade-auto.mjs,
  // #2273): null for one that reports no findings or mutants.
  "quality.verifiedFindings": {
    label: "Grader's verified findings",
    unit: "count",
    better: "lower",
    get: (card) => card.grade?.findings?.length ?? null,
  },
  "quality.mutantsSurvived": {
    label: "Mutants the delivered tests let survive",
    unit: "count",
    better: "lower",
    get: (card) => card.grade?.mutation?.survived ?? null,
  },
  done: {
    label: "Done",
    unit: "rate",
    better: "higher",
    get: (card) => (card.outcome === "done" ? 1 : 0),
  },
};

/** The outcome metrics, in priority order: what a candidate is accepted on, and what reports show first. */
export const OUTCOMES = [
  "grade.passRate",
  "human.score",
  "deliveryMs",
  "waste.tokensShare",
  "escapes.total",
  "cost.usd",
];

/** The effort metrics: diagnostics only, shown after the outcomes. */
export const DIAGNOSTICS = [
  "tokens.total",
  "activeWallMs",
  "tokensPerCriterion",
  "modelMs",
  "repairs",
  "holds.operator",
  "validation.firstPassRate",
  "ci.firstPassRate",
  "quality.verifiedFindings",
  "quality.mutantsSurvived",
];

/** The order history and reports show metrics in. */
export const SHOWN = [...OUTCOMES, ...DIAGNOSTICS];

/**
 * A metric the grader reported (`grade.metrics.<name>`, #2224), such as
 * the delivered tests' mutation score: shown with the grade, never
 * deciding. Which way is better is the grader's to say.
 */
export const graderMetric = (name) => ({
  label: `Grader: ${name}`,
  unit: "number",
  better: null,
  get: (card) => card.grade?.metrics?.[name] ?? null,
});

/** The names of the grader metrics any of `cards` has, sorted. */
export const graderMetricNames = (cards) =>
  [
    ...new Set(cards.flatMap((card) => Object.keys(card.grade?.metrics ?? {}))),
  ].sort();

export function spread(values) {
  const known = values
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  if (!known.length) return null;
  const mid = Math.floor(known.length / 2);
  return {
    n: known.length,
    min: known[0],
    max: known.at(-1),
    median: known.length % 2 ? known[mid] : (known[mid - 1] + known[mid]) / 2,
  };
}

/** Each metric of `ids` for the candidate cards against the baseline cards. */
export function compare(baseline, candidate, ids) {
  return ids.map((id) => {
    const metric = METRICS[id];
    const base = spread(baseline.map(metric.get));
    const cand = spread(candidate.map(metric.get));
    let verdict = "unknown";
    if (base && cand) {
      const lower = metric.better === "lower";
      if (lower ? cand.median < base.min : cand.median > base.max)
        verdict = "better";
      else if (lower ? cand.median > base.max : cand.median < base.min)
        verdict = "worse";
      else verdict = "within";
    }
    return {
      id,
      label: metric.label,
      unit: metric.unit,
      baseline: base,
      candidate: cand,
      verdict,
    };
  });
}

/** Cards of runs that hadn't ended when scored: their totals are partial. */
export const isPartial = (card) =>
  card.partial ?? !["done", "cancelled"].includes(card.outcome);

/** Cards of the current scorecard version: an older card lacks the outcome metrics, and is scored again to have them. */
export const isCurrent = (card) => card.schemaVersion === SCORECARD_VERSION;

/**
 * The acceptance rule (#2223), over the outcome rows of `compare`: grade
 * not worse; human effort or time to delivery better; escapes not worse;
 * cost not worse beyond the baseline's range. Unknown (no run graded,
 * priced, ...) never passes a rule: the decision is never made without it.
 * Cost is a guard, not a goal (#2224): unknown on both sides, as for a
 * subscription-priced provider, or for the baseline alone, it is skipped
 * with a warning; a candidate's unknown cost against a known one fails it.
 * Waste is shown with them but doesn't decide.
 */
function acceptance(rows, warnings) {
  const row = (id) => rows.find((r) => r.id === id);
  const reasons = [];
  for (const id of ["grade.passRate", "escapes.total"]) {
    const { verdict } = row(id);
    if (verdict === "worse" || verdict === "unknown")
      reasons.push(
        `${id} is ${verdict}${verdict === "worse" ? "" : ": it decides, so it must be known"}`,
      );
  }
  const cost = row("cost.usd");
  if (cost.verdict === "worse") reasons.push("cost.usd is worse");
  else if (cost.verdict === "unknown") {
    if (!cost.candidate && cost.baseline)
      reasons.push(
        "cost.usd is unknown for the candidate and known for the baseline: the cost guard needs it known",
      );
    else
      warnings.push(
        cost.baseline || cost.candidate
          ? "cost.usd is unknown for the baseline: the cost guard is skipped"
          : "cost.usd is unknown on both sides (no prices, or a provider without per-token prices): the cost guard is skipped",
      );
  }
  const human = row("human.score").verdict;
  const delivery = row("deliveryMs").verdict;
  if (human !== "better" && delivery !== "better")
    reasons.push(
      `neither human.score (${human}) nor deliveryMs (${delivery}) is better`,
    );
  return reasons;
}

/**
 * The blind pairwise review's rule (#2224), when the definition has a
 * judge: the candidate's intent win rate is not below 50%. Unknown (no
 * pair judged) never passes. Without `pairwise` (a run report, which
 * judges nothing), a warning says it is left to compare.
 */
function pairwiseRule(definition, pairwise, reasons, warnings) {
  if (!definition.judge) return;
  if (pairwise === undefined) {
    warnings.push(
      "the blind pairwise review isn't in this decision: report.mjs compare judges it",
    );
    return;
  }
  const rate = pairwise.rates.intent;
  if (rate === null)
    reasons.push(
      "pairwise intent win rate is unknown: no pair was judged, and with a judge it decides",
    );
  else if (rate < 0.5)
    reasons.push(
      `pairwise intent win rate ${Math.round(rate * 100)}% is below 50%`,
    );
}

/**
 * The hill-climb decision for a candidate group against the baseline group.
 * Partial cards are left out (a warning says so): an unfinished run's
 * tokens and time are lower only because it is unfinished. Cards of an
 * older scorecard version are left out too: score them again. The
 * definition's `hillClimb` metrics, when it names any, are the diagnostics
 * shown; otherwise DIAGNOSTICS. `pairwise`: the blind pairwise review
 * (bench/lib/judge.mjs `pairwise`), which decides too when the definition
 * has a judge. Runs with scripted judgments beside runs without
 * (bench/lib/scripted.mjs) get a warning: their human effort isn't alike.
 */
export function verdict(
  definition,
  baselineCards,
  candidateCards,
  { pairwise } = {},
) {
  const warnings = [];
  const ended = (cards, which) => {
    const left = cards.filter(isPartial);
    if (left.length)
      warnings.push(
        `left out ${left.length} partial ${which} run(s), not ended when scored: ${left.map((c) => c.run.id).join(", ")}`,
      );
    const old = cards.filter((card) => !isPartial(card) && !isCurrent(card));
    if (old.length)
      warnings.push(
        `left out ${old.length} ${which} run(s) of an older scorecard version, which have no outcome metrics: ${old.map((c) => c.run.id).join(", ")}. Score them again with bench/score.mjs`,
      );
    return cards.filter((card) => !isPartial(card) && isCurrent(card));
  };
  const baseline = ended(baselineCards, "baseline");
  const candidate = ended(candidateCards, "candidate");
  const outcomes = compare(baseline, candidate, OUTCOMES);
  const diagnostics = compare(
    baseline,
    candidate,
    definition.hillClimb
      ? [
          ...new Set([
            ...definition.hillClimb.primary,
            ...definition.hillClimb.guards,
          ]),
        ]
      : DIAGNOSTICS,
  );
  if (baseline.length < 3 || candidate.length < 3)
    warnings.push(
      `${baseline.length} baseline and ${candidate.length} candidate runs: a spread needs at least 3 of each`,
    );
  // A scripted judgment weighs as an operator's would, but runs where some
  // answers were scripted and others a person's aren't compared as equals.
  const scripted = (cards) =>
    cards.filter((card) => card.human?.scriptedJudgments > 0).length;
  const scriptedBase = scripted(baseline);
  const scriptedCand = scripted(candidate);
  if (
    (scriptedBase || scriptedCand) &&
    (scriptedBase < baseline.length || scriptedCand < candidate.length)
  )
    warnings.push(
      `${scriptedBase} of ${baseline.length} baseline and ${scriptedCand} of ${candidate.length} candidate runs had scripted judgments (human.scriptedJudgments): their human effort counts answers a script gave alongside a person's`,
    );
  const reasons = acceptance(outcomes, warnings);
  pairwiseRule(definition, pairwise, reasons, warnings);
  return {
    accept: reasons.length === 0,
    reasons,
    warnings,
    outcomes,
    diagnostics,
  };
}
