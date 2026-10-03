// Planning eval reports: per-case and overall summaries with case-clustered
// 95% intervals, per-unit metrics for paired comparison, judge-panel
// agreement, and markdown output. Infrastructure errors carry no quality
// metrics: they are counted, never scored.
import { createHash } from "node:crypto";
import { DEFECTS } from "./mutations.mjs";
import {
  byCluster,
  clusteredRate,
  cohensKappa,
  holm,
  pairedBootstrap,
  signFlipTest,
  spread,
} from "./stats.mjs";

/** Fewer paired units than this cannot support a comparison. */
export const MIN_COMPARE_UNITS = 5;
/** Decision metrics, tested without multiplicity adjustment. */
export const PRIMARY_METRICS = {
  plan: [/^productionClean$/, /^judgePass:/],
  review: [/^recall$/, /^falsePositive$/],
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const bit = (value) =>
  value === null || value === undefined ? null : value ? 1 : 0;
const average = (values) => {
  const numbers = values.filter((value) => typeof value === "number");
  return numbers.length
    ? numbers.reduce((total, value) => total + value, 0) / numbers.length
    : null;
};
const tokenTotal = (tokens) =>
  tokens ? (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) : null;

/** A judge's verdict on one run: pass, fail, or null when absent or errored. */
function verdict(run, name) {
  const grade = run.judges?.find((entry) => entry.judge === name);
  return grade && grade.verdict !== "error" ? grade.verdict : null;
}
const judgeNames = (runs) => [
  ...new Set(runs.flatMap((run) => (run.judges ?? []).map((g) => g.judge))),
];
const judgeErrors = (runs) =>
  runs.reduce(
    (total, run) =>
      total +
      (run.judges ?? []).filter((grade) => grade.verdict === "error").length,
    0,
  );

/** Per-run numeric metrics, the unit of paired comparison. */
export function planRunMetrics(run) {
  const metrics = {};
  // An infrastructure error says nothing about the plan.
  if (run.outcome === "error") return metrics;
  Object.assign(metrics, {
    productionClean: bit(run.outcome === "plan"),
    question: bit(run.outcome === "question"),
    firstTryAccepted: run.firstTry ? bit(run.firstTry === "accepted") : null,
    expectationMet: run.expectation ? bit(run.expectation.met) : null,
    finalReviewInsteadOfCommand:
      run.metrics?.finalReviewInsteadOfCommand.count ?? null,
    finalReviewProofs: run.metrics
      ? (run.metrics.proofKinds["final-review"] ?? 0)
      : null,
    ungroundedCiNames: run.metrics?.ciCheckNames.ungrounded.length ?? null,
    criticalPath: run.metrics?.criticalPath ?? null,
    workItems: run.workItems ?? null,
    revisions: run.revisions ?? null,
    planningTokens: tokenTotal(run.tokens),
    wallSeconds: typeof run.wallMs === "number" ? run.wallMs / 1000 : null,
  });
  for (const grade of run.judges ?? []) {
    const value = verdict(run, grade.judge);
    metrics[`judgePass:${grade.judge}`] =
      value === null ? null : bit(value === "pass");
    metrics[`judgeScore:${grade.judge}`] =
      typeof grade.passed === "number" ? grade.passed : null;
  }
  return metrics;
}

/** A review that produced a usable verdict: not an error, not invalid. */
const scored = (run) => run.review === "clean" || run.review === "findings";

/**
 * Review-only metrics. A flag on a known-good plan is a false positive and on
 * a seeded defect is a hit, so the two never share a metric. Invalid and
 * errored reviews have no verdict and score nothing.
 */
export function reviewRunMetrics(run) {
  const good = !run.defect;
  const metrics = {
    reviewTokens: tokenTotal(run.tokens),
    wallSeconds: typeof run.wallMs === "number" ? run.wallMs / 1000 : null,
  };
  if (scored(run)) {
    metrics[good ? "falsePositive" : "recall"] = bit(run.flagged);
    if (!good) metrics.structuralHit = bit(run.structuralHit);
  }
  for (const grade of run.judges ?? []) {
    const value = verdict(run, grade.judge);
    metrics[`${good ? "judgeFalsePositive" : "judgeRecall"}:${grade.judge}`] =
      value === null ? null : bit(value === "fail");
  }
  return metrics;
}

/** Mean of each metric across a unit's repeats, with the unit's input digest. */
export function units(runs, key, metrics, digest) {
  const groups = new Map();
  for (const run of runs) {
    const id = key(run);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(run);
  }
  return [...groups].map(([id, list]) => {
    const values = list.map(metrics);
    return {
      id,
      digest: digest(list[0]),
      runs: list.length,
      errors: list.filter(
        (run) => run.outcome === "error" || run.review === "error",
      ).length,
      metrics: Object.fromEntries(
        [...new Set(values.flatMap((value) => Object.keys(value)))].map(
          (name) => [name, average(values.map((value) => value[name] ?? null))],
        ),
      ),
    };
  });
}

/** Pairwise verdict agreement and Cohen's kappa on the runs both judges graded. */
function agreement(runs, names, cluster) {
  const pairs = [];
  for (let i = 0; i < names.length; i += 1)
    for (let j = i + 1; j < names.length; j += 1) {
      const [a, b] = [names[i], names[j]];
      const both = runs.filter(
        (run) => verdict(run, a) !== null && verdict(run, b) !== null,
      );
      const count = (left, right) =>
        both.filter(
          (run) => verdict(run, a) === left && verdict(run, b) === right,
        ).length;
      pairs.push({
        judges: [a, b],
        agree: clusteredRate(
          byCluster(
            both,
            cluster,
            (run) => verdict(run, a) === verdict(run, b),
          ),
        ),
        kappa: cohensKappa(
          both.map((run) => [verdict(run, a), verdict(run, b)]),
        ),
        bothPass: count("pass", "pass"),
        bothFail: count("fail", "fail"),
        onlyFirstFails: count("fail", "pass"),
        onlySecondFails: count("pass", "fail"),
      });
    }
  return pairs;
}

/** The inputs a plan-mode unit was run on: Objective body and base commit. */
export const planUnitDigest = (run) =>
  sha256(JSON.stringify([run.objectiveDigest ?? null, run.commit ?? null]));

/** Plan-mode summary: per case and overall; intervals cluster by case. */
export function summarizePlanRuns(runs) {
  const rate = (list, test) =>
    clusteredRate(byCluster(list, (run) => run.case, test));
  const valid = runs.filter((run) => run.outcome !== "error");
  const withFirstTry = valid.filter((run) => run.firstTry);
  const types = [...new Set(withFirstTry.map((run) => run.firstTry))].sort();
  const names = judgeNames(runs);
  return {
    cases: units(runs, (run) => run.case, planRunMetrics, planUnitDigest),
    overall: {
      runs: runs.length,
      cases: new Set(runs.map((run) => run.case)).size,
      errors: runs.length - valid.length,
      judgeErrors: judgeErrors(runs),
      productionClean: rate(valid, (run) => run.outcome === "plan"),
      question: rate(valid, (run) => run.outcome === "question"),
      expectationMet: rate(
        valid.filter((run) => run.expectation),
        (run) => run.expectation.met,
      ),
      firstTry: Object.fromEntries(
        types.map((type) => [
          type,
          rate(withFirstTry, (run) => run.firstTry === type),
        ]),
      ),
      judges: names.map((name) => {
        const graded = runs.filter((run) => verdict(run, name) !== null);
        const failed = graded.flatMap(
          (run) => run.judges.find((g) => g.judge === name).failed ?? [],
        );
        return {
          name,
          pass: rate(graded, (run) => verdict(run, name) === "pass"),
          errors: runs.filter((run) =>
            run.judges?.some((g) => g.judge === name && g.verdict === "error"),
          ).length,
          dimensionFailures: Object.fromEntries(
            [...new Set(failed)].map((dimension) => [
              dimension,
              rate(graded, (run) =>
                run.judges
                  .find((g) => g.judge === name)
                  .failed.includes(dimension),
              ),
            ]),
          ),
        };
      }),
      agreement: agreement(runs, names, (run) => run.case),
      means: Object.fromEntries(
        [
          "finalReviewInsteadOfCommand",
          "finalReviewProofs",
          "ungroundedCiNames",
          "criticalPath",
          "workItems",
          "revisions",
          "planningTokens",
          "wallSeconds",
        ].map((name) => [
          name,
          spread(valid.map((run) => planRunMetrics(run)[name])),
        ]),
      ),
    },
  };
}

/**
 * Review-only summary: recall per defect and the false-positive rate, over
 * reviews with a usable verdict; intervals cluster by fixture.
 */
export function summarizeReviewRuns(runs, refusals) {
  const rate = (list, test) =>
    clusteredRate(byCluster(list, (run) => run.fixture, test));
  const order = DEFECTS.map((defect) => defect.id);
  const defects = [
    ...new Set(runs.map((run) => run.defect).filter(Boolean)),
  ].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const names = judgeNames(runs);
  const judgeRates = (list) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        rate(
          list.filter((run) => verdict(run, name) !== null),
          (run) => verdict(run, name) === "fail",
        ),
      ]),
    );
  const good = runs.filter((run) => !run.defect);
  return {
    units: units(
      runs,
      (run) => `${run.fixture}/${run.variant}`,
      reviewRunMetrics,
      (run) => run.unitDigest ?? null,
    ),
    judges: names,
    good: {
      runs: good.length,
      falsePositive: rate(good.filter(scored), (run) => run.flagged),
      invalid: good.filter((run) => run.review === "invalid").length,
      judgeFalsePositive: judgeRates(good),
    },
    defects: defects.map((defect) => {
      const all = runs.filter((run) => run.defect === defect);
      const list = all.filter(scored);
      return {
        defect,
        rule: all[0]?.rule,
        runs: list.length,
        recall: rate(list, (run) => run.flagged),
        structuralHit: rate(list, (run) => run.structuralHit),
        invalid: all.filter((run) => run.review === "invalid").length,
        judgeRecall: judgeRates(all),
      };
    }),
    agreement: agreement(runs, names, (run) => run.fixture),
    refusedByCode: refusals,
    errors: runs.filter((run) => run.review === "error").length,
    judgeErrors: judgeErrors(runs),
  };
}

/**
 * Review units collapse to one per fixture: its variants share a target and
 * a known-good plan, so they are one cluster of evidence, not several.
 */
function fixtureUnits(list) {
  const groups = new Map();
  for (const unit of list) {
    const fixture = unit.id.split("/")[0];
    if (!groups.has(fixture)) groups.set(fixture, []);
    groups.get(fixture).push(unit);
  }
  return [...groups].map(([id, members]) => ({
    id,
    digest: sha256(
      JSON.stringify(members.map((unit) => [unit.id, unit.digest]).sort()),
    ),
    metrics: Object.fromEntries(
      [...new Set(members.flatMap((unit) => Object.keys(unit.metrics)))].map(
        (name) => [
          name,
          average(members.map((unit) => unit.metrics[name] ?? null)),
        ],
      ),
    ),
  }));
}

/**
 * Paired comparison over units both reports ran on identical inputs. Each
 * metric gets a paired-bootstrap interval and an exact sign-flip p-value.
 * Primary metrics are reported as they are; the others are Holm-adjusted.
 * Metrics with fewer than MIN_COMPARE_UNITS paired units are marked
 * insufficient and get no interval or p-value.
 */
export function compareReports(a, b, options = {}) {
  if (a.mode !== b.mode)
    throw new Error(
      `Cannot compare a ${a.mode} report with a ${b.mode} report`,
    );
  const collapse = a.mode === "review" ? fixtureUnits : (list) => list;
  const left = new Map(collapse(a.units).map((unit) => [unit.id, unit]));
  const right = new Map(collapse(b.units).map((unit) => [unit.id, unit]));
  const common = [...left.keys()].filter((id) => right.has(id));
  const mismatched = common.filter(
    (id) => left.get(id).digest !== right.get(id).digest,
  );
  const shared = common.filter((id) => !mismatched.includes(id));
  const digests = (report) =>
    new Map((report.judges ?? []).map((judge) => [judge.name, judge.digest]));
  const [da, db] = [digests(a), digests(b)];
  const comparable = (name) => da.has(name) && da.get(name) === db.get(name);
  const names = [
    ...new Set(
      [...left.values(), ...right.values()].flatMap((unit) =>
        Object.keys(unit.metrics),
      ),
    ),
  ];
  const skipped = [...new Set([...da.keys(), ...db.keys()])].filter(
    (name) => !comparable(name),
  );
  const notes = [];
  if (skipped.length)
    notes.push(
      `Judge metrics for ${skipped.join(", ")} are not compared: the judge is missing from one report or its digest differs.`,
    );
  if (mismatched.length)
    notes.push(
      `Excluded because the Objective, commit or plan inputs differ: ${mismatched.join(", ")}.`,
    );
  const primary = PRIMARY_METRICS[a.mode] ?? [];
  const rows = names
    .filter((name) => !name.includes(":") || comparable(name.split(":")[1]))
    .map((name) => {
      const pairs = shared.flatMap((id) => {
        const x = left.get(id).metrics[name];
        const y = right.get(id).metrics[name];
        return typeof x === "number" && typeof y === "number"
          ? [{ a: x, b: y }]
          : [];
      });
      const isPrimary = primary.some((pattern) => pattern.test(name));
      if (pairs.length < MIN_COMPARE_UNITS)
        return {
          metric: name,
          primary: isPrimary,
          n: pairs.length,
          insufficient: true,
          ...(pairs.length
            ? {
                meanA: average(pairs.map((pair) => pair.a)),
                meanB: average(pairs.map((pair) => pair.b)),
                delta: average(pairs.map((pair) => pair.b - pair.a)),
              }
            : { meanA: null, meanB: null, delta: null }),
          low: null,
          high: null,
          p: null,
          pFloor: null,
        };
      const test = signFlipTest(
        pairs.map((pair) => pair.b - pair.a),
        options,
      );
      return {
        metric: name,
        primary: isPrimary,
        insufficient: false,
        ...pairedBootstrap(pairs, options),
        p: test.p,
        pFloor: test.floor,
        exact: test.exact,
      };
    })
    .filter((row) => row.n > 0);
  const secondary = rows.filter((row) => !row.primary);
  holm(secondary.map((row) => row.p)).forEach((adjusted, index) => {
    secondary[index].pHolm = adjusted;
  });
  return {
    mode: a.mode,
    clusteredBy: a.mode === "review" ? "fixture" : "case",
    units: shared.length,
    onlyInA: [...left.keys()].filter((id) => !right.has(id)),
    onlyInB: [...right.keys()].filter((id) => !left.has(id)),
    mismatched,
    notes,
    rows,
  };
}

const fixed = (value, digits = 2) =>
  value === null || value === undefined ? "–" : Number(value).toFixed(digits);
const percent = (interval) =>
  !interval || interval.rate === null
    ? "–"
    : `${(interval.rate * 100).toFixed(0)}% [${(interval.low * 100).toFixed(0)}–${(interval.high * 100).toFixed(0)}] (${interval.successes}/${interval.total}, ${interval.clusters} ${interval.clusters === 1 ? "unit" : "units"})`;

function header(report, unit) {
  const { planning } = report.config;
  return [
    `Config \`${report.config.path}\`: planning \`${planning.kind}\`, planner ${planning.planner?.model ?? "?"}/${planning.planner?.reasoningEffort ?? "?"}, reviewer ${planning.reviewer?.model ?? "?"}/${planning.reviewer?.reasoningEffort ?? "?"}${report.planningModule ? `, planning model module \`${report.planningModule}\`` : ""}.`,
    report.judges.length
      ? `Judges: ${report.judges.map((judge) => `\`${judge.name}\` (${judge.model.kind} ${judge.model.model}/${judge.model.reasoningEffort}, digest \`${judge.digest.slice(0, 12)}\`)`).join(", ")}.`
      : "No judge.",
    `Repeat ${report.repeat}, ${report.startedAt} to ${report.finishedAt}.`,
    "",
    `Rates show the rate, a 95% interval clustered by ${unit}, the run count and the number of units (${unit}s). Repeats of one ${unit} are not independent, so the interval is the wider of a ${unit}-level bootstrap and a Wilson interval on the ${unit} count.`,
  ];
}

function agreementLines(pairs) {
  return pairs.map(
    (pair) =>
      `| Judges agree: ${pair.judges.join(" vs ")} | ${percent(pair.agree)}; Cohen's kappa ${fixed(pair.kappa)}; both pass ${pair.bothPass}, both fail ${pair.bothFail}, only ${pair.judges[0]} fails ${pair.onlyFirstFails}, only ${pair.judges[1]} fails ${pair.onlySecondFails} |`,
  );
}

export function planMarkdown(report) {
  const { overall } = report.summary;
  const judges = overall.judges.map((judge) => judge.name);
  const lines = [
    "# Planning eval",
    "",
    ...header(report, "case"),
    "",
    "## Overall",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Runs | ${overall.runs} over ${overall.cases} cases; ${overall.errors} infrastructure errors (excluded below); ${overall.judgeErrors} judge errors |`,
    `| Production review clean | ${percent(overall.productionClean)} |`,
    `| Stopped for an operator | ${percent(overall.question)} |`,
    ...overall.judges.map(
      (judge) =>
        `| Judge pass: ${judge.name} | ${percent(judge.pass)}${judge.errors ? ` (${judge.errors} judge errors)` : ""} |`,
    ),
    ...agreementLines(overall.agreement),
    `| Case expectation met | ${percent(overall.expectationMet)} |`,
    ...Object.entries(overall.firstTry).map(
      ([type, interval]) => `| First try: ${type} | ${percent(interval)} |`,
    ),
    ...overall.judges.flatMap((judge) =>
      Object.entries(judge.dimensionFailures).map(
        ([name, interval]) =>
          `| ${judge.name} fails ${name} | ${percent(interval)} |`,
      ),
    ),
    ...Object.entries(overall.means).map(
      ([name, value]) =>
        `| Mean ${name} | ${value ? `${fixed(value.mean)} (${fixed(value.min, 0)}–${fixed(value.max, 0)})` : "–"} |`,
    ),
    "",
    "## Cases",
    "",
    `Means across repeats.${judges.length ? ` Judge pass lists ${judges.join(" / ")}.` : ""}`,
    "",
    "| Case | Runs | Errors | Clean | Judge pass | Expectation | First try accepted | Final review for command | Final-review proofs | Ungrounded CI | Critical path | Items | Revisions | Tokens (k) | Wall (s) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.cases.map(
      ({ id, runs, errors, metrics: m }) =>
        `| ${[
          id,
          runs,
          errors,
          fixed(m.productionClean),
          judges.length
            ? judges.map((name) => fixed(m[`judgePass:${name}`])).join(" / ")
            : "–",
          fixed(m.expectationMet),
          fixed(m.firstTryAccepted),
          fixed(m.finalReviewInsteadOfCommand, 1),
          fixed(m.finalReviewProofs, 1),
          fixed(m.ungroundedCiNames, 1),
          fixed(m.criticalPath, 1),
          fixed(m.workItems, 1),
          fixed(m.revisions, 1),
          typeof m.planningTokens !== "number"
            ? "–"
            : fixed(m.planningTokens / 1000, 1),
          fixed(m.wallSeconds, 0),
        ].join(" | ")} |`,
    ),
  ];
  const errors = report.runs.filter((run) => run.outcome === "error");
  if (errors.length)
    lines.push(
      "",
      "## Infrastructure errors",
      "",
      ...errors.map(
        (run) =>
          `- ${run.case} #${run.repeat}: ${(run.error ?? "unknown").split("\n")[0]}`,
      ),
    );
  return `${lines.join("\n")}\n`;
}

export function reviewMarkdown(report) {
  const { summary } = report;
  const judgeCell = (rates) =>
    summary.judges.length
      ? summary.judges.map((name) => percent(rates[name])).join(" / ")
      : "–";
  const lines = [
    "# Plan review eval (seeded defects)",
    "",
    ...header(report, "fixture"),
    "",
    `Recall: the production reviewer returned at least one finding for a plan with one injected defect. Structural hit: a finding names the mutated item, command or check identifier. Invalid and errored reviews have no verdict and are excluded from recall and false positives.${summary.judges.length ? ` Judge recall lists ${summary.judges.join(" / ")}.` : ""}`,
    "",
    "| Defect | Reviews | Recall | Structural hit | Invalid reviews | Judge recall |",
    "| --- | --- | --- | --- | --- | --- |",
    ...summary.defects.map(
      (row) =>
        `| ${row.defect} | ${row.runs} | ${percent(row.recall)} | ${percent(row.structuralHit)} | ${row.invalid} | ${judgeCell(row.judgeRecall)} |`,
    ),
    "",
    `Known-good plans: ${summary.good.runs} reviews, false-positive rate ${percent(summary.good.falsePositive)}, ${summary.good.invalid} invalid; judge false-positive rate ${judgeCell(summary.good.judgeFalsePositive)}.`,
  ];
  if (summary.agreement.length)
    lines.push(
      "",
      "| Measure | Value |",
      "| --- | --- |",
      ...agreementLines(summary.agreement),
    );
  if (summary.refusedByCode.length)
    lines.push(
      "",
      "## Caught by compile validation (never reviewed)",
      "",
      ...summary.refusedByCode.map(
        (row) =>
          `- ${row.fixture} / ${row.defect}: ${row.reason.split("\n")[0]}`,
      ),
    );
  if (summary.errors || summary.judgeErrors)
    lines.push(
      "",
      `${summary.errors} review calls and ${summary.judgeErrors} judge calls failed; see report.json.`,
    );
  return `${lines.join("\n")}\n`;
}

export function compareMarkdown(comparison, a, b) {
  const p = (value) =>
    value === null || value === undefined ? "–" : fixed(value, 3);
  return `${[
    "# Planning eval comparison",
    "",
    `A: \`${a}\``,
    `B: \`${b}\``,
    "",
    `Paired over ${comparison.units} shared units, clustered by ${comparison.clusteredBy} (${comparison.mode} mode). Delta is mean(B − A) per unit, with a paired-bootstrap 95% interval and an exact sign-flip p-value. Primary metrics are marked *; the others are Holm-adjusted. A metric with fewer than ${MIN_COMPARE_UNITS} paired units is insufficient and gets no interval or p-value. p floor is the smallest p-value the number of units allows.`,
    ...comparison.notes.map((note) => `\n${note}`),
    ...(comparison.onlyInA.length
      ? [`\nOnly in A (ignored): ${comparison.onlyInA.join(", ")}`]
      : []),
    ...(comparison.onlyInB.length
      ? [`\nOnly in B (ignored): ${comparison.onlyInB.join(", ")}`]
      : []),
    "",
    "| Metric | Units | A | B | Delta | 95% interval | p | Holm p | p floor |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...comparison.rows.map(
      (row) =>
        `| ${row.metric}${row.primary ? " *" : ""} | ${row.n}${row.insufficient ? " (insufficient)" : ""} | ${fixed(row.meanA, 3)} | ${fixed(row.meanB, 3)} | ${fixed(row.delta, 3)} | ${row.low === null ? "–" : `[${fixed(row.low, 3)}, ${fixed(row.high, 3)}]`} | ${p(row.p)} | ${row.primary ? "–" : p(row.pHolm)} | ${p(row.pFloor)} |`,
    ),
  ].join("\n")}\n`;
}
