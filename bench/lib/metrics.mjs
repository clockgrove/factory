/**
 * The metrics runs are compared on, read from a scorecard's totals, and the
 * hill-climb comparison: a candidate group's median against the baseline
 * group's spread (min to max). Better means beyond the whole spread; inside
 * it is noise. Accept only when every primary metric is better and no
 * guard is worse (bench/README.md#Hill-climb).
 */
const totals = (path) => (card) =>
  path.split(".").reduce((node, key) => node?.[key], card.totals) ?? null;

export const METRICS = {
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
    label: "Validation pass rate",
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
  done: {
    label: "Done",
    unit: "rate",
    better: "higher",
    get: (card) => (card.outcome === "done" ? 1 : 0),
  },
};

/** The order history and reports show metrics in. */
export const SHOWN = [
  "tokens.total",
  "activeWallMs",
  "tokensPerCriterion",
  "modelMs",
  "repairs",
  "holds.operator",
  "validation.firstPassRate",
  "ci.firstPassRate",
];

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

/** The hill-climb decision for a candidate group against the baseline group. */
export function verdict(definition, baseline, candidate) {
  const primary = compare(baseline, candidate, definition.hillClimb.primary);
  const guards = compare(baseline, candidate, definition.hillClimb.guards);
  const reasons = [
    ...primary
      .filter((row) => row.verdict !== "better")
      .map((row) => `primary ${row.id} is ${row.verdict}, not better`),
    ...guards
      .filter((row) => row.verdict === "worse" || row.verdict === "unknown")
      .map((row) => `guard ${row.id} is ${row.verdict}`),
  ];
  const warnings = [];
  if (baseline.length < 3 || candidate.length < 3)
    warnings.push(
      `${baseline.length} baseline and ${candidate.length} candidate runs: a spread needs at least 3 of each`,
    );
  return { accept: reasons.length === 0, reasons, warnings, primary, guards };
}
