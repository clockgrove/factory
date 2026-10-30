#!/usr/bin/env node
/**
 * Reports from <results>/<benchmark>/*.json.
 *
 *   node bench/report.mjs --benchmark ID|FILE [--run RUN_ID] [--out DIR]
 *     Each run's report against the baseline (RUN_ID.html, RUN_ID.md; only
 *     RUN_ID with --run) and the history page (history.html, history.md),
 *     into DIR (default reports/<benchmark>/ in the bench home).
 *
 *   node bench/report.mjs compare --benchmark ID|FILE --candidate GROUP [--baseline GROUP]
 *     The hill-climb decision for a group of runs against the baseline
 *     group (the definition's, by default), on outcomes (#2223): grade not
 *     worse, human effort or time to delivery better, escapes not worse,
 *     cost not worse. Prints it, the outcome rows first and the
 *     diagnostics after, and exits 0 when accepted, 3 when not.
 *
 * The results are --results DIR, or results/ in --bench-home DIR or
 * FACTORY_BENCH_HOME; a definition given by ID is looked up in --benchmarks
 * DIR the same way (bench/lib/home.mjs). A partial card (a run that hadn't
 * ended when scored) is reported and plotted, marked, but never compared.
 * A version 2 card is reported with a warning to score it again (it has no
 * outcome metrics) and is never compared; a card of any other version is
 * left out, with a warning. Exit codes: 0 written or accepted; 3 rejected;
 * 64 usage.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadDefinition } from "./lib/definition.mjs";
import { benchDirs, DIR_OPTIONS, missingDir } from "./lib/home.mjs";
import {
  value,
  historyMarkdown,
  historyPage,
  runMarkdown,
  runReport,
} from "./lib/report.mjs";
import {
  isCurrent,
  isPartial,
  SCORECARD_VERSION,
  verdict,
} from "./lib/metrics.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ...DIR_OPTIONS,
    benchmark: { type: "string" },
    run: { type: "string" },
    out: { type: "string" },
    candidate: { type: "string" },
    baseline: { type: "string" },
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
if (!comparing && !values.out && !dirs.reports)
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
  const decision = verdict(definition, baseline, candidate);
  const row = (r, kind) =>
    `| ${kind} | ${r.label} | ${value(r.unit, r.candidate?.median)} | ${value(r.unit, r.baseline?.median)} (${r.baseline ? `${value(r.unit, r.baseline.min)} – ${value(r.unit, r.baseline.max)}` : "n/a"}) | ${r.verdict} |`;
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
      "",
      ...decision.reasons.map((r) => `- ${r}`),
      ...decision.warnings.map((w) => `- Warning: ${w}`),
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
