#!/usr/bin/env node
/**
 * Reports from <results>/<benchmark>/*.json.
 *
 *   node bench/report.mjs --benchmark ID|FILE [--run RUN_ID] [--out DIR]
 *     Each run's report against the baseline (RUN_ID.html, RUN_ID.md; only
 *     RUN_ID with --run) and the history page (history.html, history.md),
 *     into DIR (default reports/<benchmark>/ in the bench home).
 *
 *   node bench/report.mjs compare --benchmark ID|FILE --candidate GROUP [--baseline GROUP] [--bench-root DIR]
 *     The hill-climb decision for a group of runs against the baseline
 *     group (the definition's, by default), on outcomes (#2223): grade not
 *     worse, human effort or time to delivery better, escapes not worse,
 *     cost not worse (skipped when unknown on both sides). With a judge in
 *     the definition, also the blind pairwise review (#2224): each
 *     candidate run against each baseline run, judged once and kept in
 *     <results>/<benchmark>/judgments/; the candidate's intent win rate must
 *     not be below 50%. Its calibration pairs are judged too, and the
 *     judge's agreement with the person reported. A run's tree is found
 *     through its run directory: the card's, or <DIR>/<benchmark>/<run id>
 *     with --bench-root DIR (the host's benchRoot). Prints the decision, the
 *     outcome rows first and the diagnostics after, and exits 0 when
 *     accepted, 3 when not.
 *
 *   node bench/report.mjs calibrate --benchmark ID|FILE --pair RUN_A RUN_B
 *       --intent A|B|tie --quality A|B|tie --by NAME
 *     Record a person's choice between two runs' trees (A is RUN_A) in the
 *     definition's judgeCalibration, replacing their earlier choice of the
 *     same pair.
 *
 * The results are --results DIR, or results/ in --bench-home DIR or
 * FACTORY_BENCH_HOME; a definition given by ID is looked up in --benchmarks
 * DIR the same way (bench/lib/home.mjs). A partial card (a run that hadn't
 * ended when scored) is reported and plotted, marked, but never compared.
 * A version 2 card is reported with a warning to score it again (it has no
 * outcome metrics) and is never compared; a card of any other version is
 * left out, with a warning. Exit codes: 0 written, accepted or recorded; 3
 * rejected; 64 usage.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CHOICES,
  definitionProblems,
  loadDefinition,
} from "./lib/definition.mjs";
import { benchDirs, DIR_OPTIONS, missingDir } from "./lib/home.mjs";
import { pairwise, winner } from "./lib/judge.mjs";
import {
  isCurrent,
  isPartial,
  SCORECARD_VERSION,
  verdict,
} from "./lib/metrics.mjs";
import {
  historyMarkdown,
  historyPage,
  runMarkdown,
  runReport,
  value,
} from "./lib/report.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ...DIR_OPTIONS,
    benchmark: { type: "string" },
    run: { type: "string" },
    out: { type: "string" },
    candidate: { type: "string" },
    baseline: { type: "string" },
    "bench-root": { type: "string" },
    pair: { type: "string" },
    intent: { type: "string" },
    quality: { type: "string" },
    by: { type: "string" },
  },
});
const fail = (message) => {
  process.stderr.write(`${message}\nSee the header of bench/report.mjs.\n`);
  process.exit(64);
};
if (!values.benchmark) fail("--benchmark is required");
const dirs = benchDirs(values);
if (!dirs.results)
  fail(`Where the scorecards are: ${missingDir("results", "results")}`);
let definition;
try {
  definition = loadDefinition(values.benchmark, dirs.benchmarks);
} catch (error) {
  fail(error.message);
}
const comparing = positionals[0] === "compare";
const calibrating = positionals[0] === "calibrate";
if (!comparing && !calibrating && !values.out && !dirs.reports)
  fail(
    "Where to write the reports: give --out DIR, or --bench-home DIR or FACTORY_BENCH_HOME (reports go to its reports/<benchmark>/).",
  );
const resultsDir = join(dirs.results, definition.id);
if (!existsSync(resultsDir))
  fail(
    `No scorecards of ${definition.id}: ${resultsDir} does not exist. Score a run into ${dirs.results} with bench/score.mjs first, or give the results directory that has them.`,
  );
const warn = (text) => process.stderr.write(`Warning: ${text}\n`);
const cards = readdirSync(resultsDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => [
    name,
    JSON.parse(readFileSync(join(resultsDir, name), "utf8")),
  ])
  .filter(([name, card]) => {
    if (card.schemaVersion === SCORECARD_VERSION) return true;
    if (card.schemaVersion === SCORECARD_VERSION - 1) {
      warn(
        `${name} is scorecard version ${card.schemaVersion}: reported without the outcome metrics (grade, human effort, delivery, waste, escapes, cost) and never compared. Score it again with bench/score.mjs.`,
      );
      return true;
    }
    warn(
      `${name} is scorecard version ${card.schemaVersion}, not ${SCORECARD_VERSION}: left out. Score it again with bench/score.mjs.`,
    );
    return false;
  })
  .map(([, card]) => card);

if (calibrating) {
  // `--pair RUN_A RUN_B`: RUN_B is the positional after `calibrate`.
  const runs = [values.pair, positionals[1]];
  if (!runs[0] || !runs[1] || positionals.length !== 2)
    fail("calibrate takes --pair RUN_A RUN_B");
  if (runs[0] === runs[1]) fail("--pair names two different runs");
  for (const aspect of ["intent", "quality"])
    if (!CHOICES.includes(values[aspect]))
      fail(`--${aspect} is one of ${CHOICES.join(", ")}`);
  if (!values.by?.trim()) fail("--by names the person who chose");
  const missing = runs.filter((id) => !cards.some((c) => c.run.id === id));
  if (missing.length)
    fail(`${resultsDir} has no scorecard of ${missing.join(", ")}`);
  const raw = JSON.parse(readFileSync(definition.file, "utf8"));
  const same = (entry) =>
    [entry.runA, entry.runB].sort().join("\n") === [...runs].sort().join("\n");
  raw.judgeCalibration = [
    ...(raw.judgeCalibration ?? []).filter((entry) => !same(entry)),
    {
      runA: runs[0],
      runB: runs[1],
      intent: values.intent,
      quality: values.quality,
      by: values.by.trim(),
      at: new Date().toISOString(),
    },
  ];
  const problems = definitionProblems(raw);
  if (problems.length) fail(problems.join("\n"));
  writeFileSync(definition.file, `${JSON.stringify(raw, null, 2)}\n`);
  process.stdout.write(
    `${definition.file}: ${values.by.trim()}'s choice of ${runs[0]} (A) and ${runs[1]} (B), intent ${values.intent}, quality ${values.quality}; ${raw.judgeCalibration.length} calibration pair(s)\n`,
  );
  process.exit(0);
}

if (comparing) {
  const baselineGroup = values.baseline ?? definition.baseline;
  const ended = (group) =>
    cards.filter((c) => {
      if (c.run.group !== group) return false;
      if (isPartial(c)) {
        warn(
          `${c.run.id} (${group}) hadn't ended when it was scored (${c.outcome}): left out`,
        );
        return false;
      }
      if (!isCurrent(c)) {
        warn(
          `${c.run.id} (${group}) is scorecard version ${c.schemaVersion}: left out of the comparison. Score it again with bench/score.mjs`,
        );
        return false;
      }
      return true;
    });
  const baseline = ended(baselineGroup);
  const candidate = ended(values.candidate);
  if (!baseline.length || !candidate.length) {
    process.stderr.write(
      `Need runs in both groups: ${baseline.length} in ${baselineGroup}, ${candidate.length} in ${values.candidate}\n`,
    );
    process.exit(64);
  }
  const review = definition.judge
    ? await pairwise(definition, {
        baseline,
        candidate,
        cards,
        dir: join(resultsDir, "judgments"),
        benchRoot: values["bench-root"] ? resolve(values["bench-root"]) : null,
      })
    : undefined;
  const decision = verdict(definition, baseline, candidate, {
    pairwise: review,
  });
  const row = (r, kind) =>
    `| ${kind} | ${r.label} | ${value(r.unit, r.candidate?.median)} | ${value(r.unit, r.baseline?.median)} (${r.baseline ? `${value(r.unit, r.baseline.min)} – ${value(r.unit, r.baseline.max)}` : "n/a"}) | ${r.verdict} |`;
  const side = (judgment, aspect, run) => {
    const won = winner(judgment, aspect);
    return won === "tie" ? "tie" : won === run ? "candidate" : "baseline";
  };
  const rate = (r) => value("rate", r);
  const pairLines = review
    ? [
        "",
        "## Blind pairwise review",
        "",
        `${review.rates.pairs} of ${review.pairs.length} pair(s) judged (${review.pairs.filter((p) => p.cached).length} kept from earlier), by ${[...new Set(review.pairs.filter((p) => !p.error).map((p) => p.judgeVersion))].join(", ") || "no judge"}. Intent win rate ${rate(review.rates.intent)}, quality win rate ${rate(review.rates.quality)}: the candidate's wins, ties counting half.`,
        "",
        "| Candidate run | Baseline run | Tree A | Intent | Quality |",
        "| --- | --- | --- | --- | --- |",
        ...review.pairs.map((p) =>
          p.error
            ? `| ${p.candidate} | ${p.baseline} | n/a | not judged | not judged |`
            : `| ${p.candidate} | ${p.baseline} | ${p.A.run === p.candidate ? "candidate" : "baseline"} | ${side(p, "intent", p.candidate)} | ${side(p, "quality", p.candidate)} |`,
        ),
        "",
        review.calibration.calibrated
          ? `Calibration: the judge chose as the person did on ${review.calibration.agreed} of ${review.calibration.choices} choices (${rate(review.calibration.rate)}; intent ${rate(review.calibration.intent)}, quality ${rate(review.calibration.quality)}), against ${rate(review.calibration.min)} needed.`
          : "Calibration: none; the judge is uncalibrated.",
      ]
    : [];
  process.stdout.write(
    `${[
      `# ${values.candidate} against ${baselineGroup}: ${decision.accept ? "accept" : "reject"}`,
      "",
      `${candidate.length} candidate and ${baseline.length} baseline run(s).`,
      "",
      "| | Metric | Candidate median | Baseline median (range) | Verdict |",
      "| --- | --- | ---: | ---: | --- |",
      ...decision.outcomes.map((r) => row(r, "outcome")),
      ...decision.diagnostics.map((r) => row(r, "diagnostic")),
      ...pairLines,
      "",
      ...decision.reasons.map((r) => `- ${r}`),
      ...decision.warnings.map((w) => `- Warning: ${w}`),
      ...(review?.warnings ?? []).map((w) => `- Warning: ${w}`),
    ].join("\n")}\n`,
  );
  process.exit(decision.accept ? 0 : 3);
}

const out = values.out ?? join(dirs.reports, definition.id);
mkdirSync(out, { recursive: true });
const chosen = values.run
  ? cards.filter((c) => c.run.id === values.run)
  : cards;
if (values.run && !chosen.length) {
  process.stderr.write(`${resultsDir} has no run ${values.run}\n`);
  process.exit(64);
}
for (const card of chosen) {
  writeFileSync(
    join(out, `${card.run.id}.html`),
    runReport(card, cards, definition),
  );
  writeFileSync(
    join(out, `${card.run.id}.md`),
    runMarkdown(card, cards, definition),
  );
}
writeFileSync(join(out, "history.html"), historyPage(cards, definition));
writeFileSync(join(out, "history.md"), historyMarkdown(cards, definition));
process.stdout.write(
  `${out}: ${chosen.length} run report(s) and the history of ${cards.length} run(s)\n`,
);
