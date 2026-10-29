#!/usr/bin/env node
/**
 * Reports from bench/results/<benchmark>/*.json.
 *
 *   node bench/report.mjs --benchmark ID [--run RUN_ID] [--out DIR]
 *     Each run's report against the baseline (RUN_ID.html, RUN_ID.md; only
 *     RUN_ID with --run) and the history page (history.html, history.md),
 *     into DIR (default bench/reports/<benchmark>/, not committed).
 *
 *   node bench/report.mjs compare --benchmark ID --candidate GROUP [--baseline GROUP]
 *     The hill-climb decision for a group of runs against the baseline
 *     group (the definition's, by default): prints it and exits 0 when
 *     accepted, 3 when not.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCH_DIR, loadDefinition } from "./lib/definition.mjs";
import {
  value,
  historyMarkdown,
  historyPage,
  runMarkdown,
  runReport,
} from "./lib/report.mjs";
import { verdict } from "./lib/metrics.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    benchmark: { type: "string" },
    run: { type: "string" },
    out: { type: "string" },
    results: { type: "string" },
    candidate: { type: "string" },
    baseline: { type: "string" },
  },
});
if (!values.benchmark) {
  process.stderr.write(
    "--benchmark is required; see the header of bench/report.mjs\n",
  );
  process.exit(64);
}
const definition = loadDefinition(values.benchmark);
const resultsDir = values.results ?? join(BENCH_DIR, "results", definition.id);
const cards = readdirSync(resultsDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(resultsDir, name), "utf8")));

if (positionals[0] === "compare") {
  const baselineGroup = values.baseline ?? definition.baseline;
  const baseline = cards.filter((c) => c.run.group === baselineGroup);
  const candidate = cards.filter((c) => c.run.group === values.candidate);
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
      ...decision.primary.map((r) => row(r, "primary")),
      ...decision.guards.map((r) => row(r, "guard")),
      "",
      ...decision.reasons.map((r) => `- ${r}`),
      ...decision.warnings.map((w) => `- Warning: ${w}`),
    ].join("\n")}\n`,
  );
  process.exit(decision.accept ? 0 : 3);
}

const out = values.out ?? join(BENCH_DIR, "reports", definition.id);
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
