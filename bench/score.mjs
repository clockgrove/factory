#!/usr/bin/env node
/**
 * `node bench/score.mjs`: score one run into <results>/<benchmark>/<run id>.json.
 *
 *   A harness run:   --run-dir DIR        (what bench/provision.mjs wrote)
 *   Any Objective:   --benchmark ID|FILE --state-dir DIR --issue N --run-id ID
 *                    --label TEXT [--group NAME] [--repository OWNER/NAME]
 *                    [--grade-tree DIR --grade-commit SHA] [--hand-fix SHA ...]
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
 *
 * An ended run is graded when the definition has a grader
 * (bench/lib/grade.mjs): on a fresh checkout of the run repository's
 * default branch at the Objective's end. A harness run's repository is its
 * record's checkout; a backfill's is --grade-tree DIR (a clone of the
 * repository) at --grade-commit SHA (default: its default branch at the
 * end). A backfill's hand fixes are the --hand-fix commits given; a harness
 * run's are read from its repository's history.
 *
 *   --grade-only     grade the existing card again (the --out FILE, or the
 *                    run's card in the results) and rewrite it; nothing else
 *                    is scored again.
 *   --grade-file F   attach a grade written outside the harness, such as
 *                    bench/grade-auto.mjs's standalone output (#2273), in
 *                    place of running the definition's grader: checked as a
 *                    grader's output is, at its own commit (or
 *                    --grade-commit SHA, which must agree).
 *
 * Exit codes: 0 scored (and graded, where it is); 64 usage; 65 a partial
 * card not written into the results; 70 the grader failed, its error
 * recorded in the card's `grade.error`, which is written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BENCH_DIR, loadDefinition } from "./lib/definition.mjs";
import { gradeCard, gradeFile, setGrade } from "./lib/grade.mjs";
import {
  benchDirs,
  DIR_OPTIONS,
  missingDir,
  runResultsDir,
} from "./lib/home.mjs";
import { SCORECARD_VERSION } from "./lib/metrics.mjs";
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
    "grade-tree": { type: "string" },
    "grade-commit": { type: "string" },
    "grade-file": { type: "string" },
    "hand-fix": { type: "string", multiple: true },
    "grade-only": { type: "boolean" },
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
    checkout: values["grade-tree"] ?? record.checkout ?? null,
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
    checkout: values["grade-tree"] ? resolve(values["grade-tree"]) : null,
  };
}
if (!Number.isSafeInteger(input.issue) || input.issue <= 0)
  usage("--issue takes an issue number");
if (values["grade-commit"] && !input.checkout && !values["grade-file"])
  usage("--grade-commit needs --grade-tree DIR, the repository it is in");
let attached = null;
if (values["grade-file"])
  try {
    attached = gradeFile(
      resolve(values["grade-file"]),
      values["grade-commit"] ?? null,
    );
  } catch (error) {
    usage(`--grade-file: ${error.message}`);
  }
if (input.checkout && !existsSync(input.checkout) && values["grade-tree"])
  usage(`--grade-tree ${input.checkout} does not exist`);
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
const cardFile = (id) =>
  values.out ?? join(input.results, definition.id, `${id}.json`);
/** The run repository's checkout, where it exists (a dry run's record names one never made). */
const repo =
  input.checkout && existsSync(input.checkout) ? input.checkout : null;

let card;
if (values["grade-only"]) {
  const file = cardFile(input.run.id);
  if (!existsSync(file))
    usage(`--grade-only: there is no card ${file} to grade`);
  card = JSON.parse(readFileSync(file, "utf8"));
  if (card.schemaVersion !== SCORECARD_VERSION)
    usage(
      `--grade-only: ${file} is scorecard version ${card.schemaVersion}, not ${SCORECARD_VERSION}: score it again first`,
    );
} else
  card = await scoreRun({
    stateDir: input.stateDir,
    issue: input.issue,
    definition,
    run: input.run,
    factoryRepo: dirname(BENCH_DIR),
    checkout: repo,
    handFixes: values["hand-fix"] ?? [],
  });
if (!card.partial) {
  if (attached) setGrade(card, attached);
  else
    await gradeCard(card, definition, {
      repo,
      commit: values["grade-commit"] ?? null,
    });
}
const text = `${JSON.stringify(card, null, 2)}\n`;
const graded = card.grade?.error
  ? `; the grader failed: ${card.grade.error}`
  : card.grade
    ? `; grade ${card.grade.passed} of ${card.grade.criteria.length} criteria passed`
    : "";
if (values.print) process.stdout.write(text);
else if (card.partial && !values.out) {
  process.stderr.write(
    `#${input.issue} is ${card.outcome}, not ended: its scorecard would be partial, and the results hold only ended runs. Give --out FILE or --print to see it.\n`,
  );
  process.exit(65);
} else {
  const out = cardFile(card.run.id);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const failed = card.checks.filter((c) => !c.ok);
  process.stdout.write(
    `${out}\n${card.outcome}; ${card.totals.tokens.total.toLocaleString("en-US")} tokens; checks ${card.checks.length - failed.length}/${card.checks.length} agree with Factory's diagnostics${failed.length ? `: ${failed.map((c) => c.name).join(", ")} differ` : ""}${graded}\n`,
  );
}
if (card.grade?.error) process.exit(70);
