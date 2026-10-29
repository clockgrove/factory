#!/usr/bin/env node
/**
 * `node bench/score.mjs`: score one run into <results>/<benchmark>/<run id>.json.
 *
 *   A harness run:   --run-dir DIR        (what bench/provision.mjs wrote)
 *   Any Objective:   --benchmark ID|FILE --state-dir DIR --issue N --run-id ID
 *                    --label TEXT [--group NAME] [--repository OWNER/NAME]
 *
 * The results directory is --results DIR, or results/ in --bench-home DIR;
 * without either, a harness run's own (the one its run record names), then
 * results/ in FACTORY_BENCH_HOME (bench/lib/home.mjs). A definition given by
 * ID is looked up in --benchmarks DIR, --bench-home DIR or the environment's
 * home.
 * --out FILE writes elsewhere; --print prints the scorecard instead.
 * Read-only on the state directory, so a live service's Objective can be
 * scored. An Objective that hasn't ended scores a partial card (`partial:
 * true`), which is never written into the results: give --out or --print
 * for one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BENCH_DIR, loadDefinition } from "./lib/definition.mjs";
import {
  benchDirs,
  DIR_OPTIONS,
  missingDir,
  runResultsDir,
} from "./lib/home.mjs";
import { harnessRun } from "./lib/provision.mjs";
import { scoreRun } from "./lib/score.mjs";

const { values } = parseArgs({
  options: {
    ...DIR_OPTIONS,
    "run-dir": { type: "string" },
    benchmark: { type: "string" },
    "state-dir": { type: "string" },
    issue: { type: "string" },
    "run-id": { type: "string" },
    label: { type: "string" },
    group: { type: "string" },
    repository: { type: "string" },
    out: { type: "string" },
    print: { type: "boolean" },
  },
});

const usage = (message) => {
  process.stderr.write(
    `${message}\nSee the header of bench/score.mjs for usage.\n`,
  );
  process.exit(64);
};

const dirs = benchDirs(values);
let input;
if (values["run-dir"]) {
  const record = JSON.parse(
    readFileSync(join(values["run-dir"], "run.json"), "utf8"),
  );
  if (!record.issue)
    usage(`${values["run-dir"]}/run.json has no filed Objective yet`);
  input = {
    benchmark: record.definitionFile ?? record.benchmark,
    stateDir: record.stateDir,
    issue: record.issue,
    run: harnessRun(record),
    results: runResultsDir(values, record.resultsDir ?? null),
  };
} else {
  for (const flag of ["benchmark", "state-dir", "issue", "run-id", "label"])
    if (!values[flag]) usage(`Give --run-dir, or --${flag} with the others`);
  const stateDir = resolve(values["state-dir"]);
  input = {
    benchmark: values.benchmark,
    stateDir,
    issue: Number(values.issue),
    run: {
      id: values["run-id"],
      label: values.label,
      group: values.group ?? values.label,
      source: "backfill",
      // An installation's directory is named OWNER__NAME (paths.ts).
      repository: values.repository ?? basename(stateDir).replace("__", "/"),
    },
    results: dirs.results,
  };
}
if (!Number.isSafeInteger(input.issue) || input.issue <= 0)
  usage("--issue takes an issue number");
const writes = !values.print && !values.out;
if (writes && !input.results)
  usage(
    `Where to write the scorecard: ${missingDir("results", "results")} Or give --out FILE or --print.`,
  );

let definition;
try {
  definition = loadDefinition(input.benchmark, dirs.benchmarks);
} catch (error) {
  usage(error.message);
}
const card = await scoreRun({
  stateDir: input.stateDir,
  issue: input.issue,
  definition,
  run: input.run,
  factoryRepo: dirname(BENCH_DIR),
});
const text = `${JSON.stringify(card, null, 2)}\n`;
if (values.print) process.stdout.write(text);
else if (card.partial && !values.out) {
  process.stderr.write(
    `#${input.issue} is ${card.outcome}, not ended: its scorecard would be partial, and the results hold only ended runs. Give --out FILE or --print to see it.\n`,
  );
  process.exit(65);
} else {
  const out =
    values.out ?? join(input.results, definition.id, `${card.run.id}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const failed = card.checks.filter((c) => !c.ok);
  process.stdout.write(
    `${out}\n${card.outcome}; ${card.totals.tokens.total.toLocaleString("en-US")} tokens; checks ${card.checks.length - failed.length}/${card.checks.length} agree with Factory's diagnostics${failed.length ? `: ${failed.map((c) => c.name).join(", ")} differ` : ""}\n`,
  );
}
