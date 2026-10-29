#!/usr/bin/env node
/**
 * `node bench/score.mjs`: score one run into bench/results/<benchmark>/<run id>.json.
 *
 *   A harness run:   --run-dir DIR        (what bench/provision.mjs wrote)
 *   Any Objective:   --benchmark ID --state-dir DIR --issue N --run-id ID --label TEXT
 *                    [--group NAME] [--repository OWNER/NAME]
 *
 * --out FILE writes elsewhere; --print prints the scorecard instead. Read-only
 * on the state directory, so a live service's Objective can be scored. An
 * Objective that hasn't ended scores a partial card (`partial: true`), which
 * is never written into results/: give --out or --print for one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BENCH_DIR, loadDefinition } from "./lib/definition.mjs";
import { harnessRun } from "./lib/provision.mjs";
import { scoreRun } from "./lib/score.mjs";

const { values } = parseArgs({
  options: {
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

let input;
if (values["run-dir"]) {
  const record = JSON.parse(
    readFileSync(join(values["run-dir"], "run.json"), "utf8"),
  );
  if (!record.issue)
    usage(`${values["run-dir"]}/run.json has no filed Objective yet`);
  input = {
    benchmark: record.benchmark,
    stateDir: record.stateDir,
    issue: record.issue,
    run: harnessRun(record),
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
  };
}
if (!Number.isSafeInteger(input.issue) || input.issue <= 0)
  usage("--issue takes an issue number");

const definition = loadDefinition(input.benchmark);
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
    `#${input.issue} is ${card.outcome}, not ended: its scorecard would be partial, and results/ holds only ended runs. Give --out FILE or --print to see it.\n`,
  );
  process.exit(65);
} else {
  const out =
    values.out ??
    join(BENCH_DIR, "results", definition.id, `${card.run.id}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const failed = card.checks.filter((c) => !c.ok);
  process.stdout.write(
    `${out}\n${card.outcome}; ${card.totals.tokens.total.toLocaleString("en-US")} tokens; checks ${card.checks.length - failed.length}/${card.checks.length} agree with Factory's diagnostics${failed.length ? `: ${failed.map((c) => c.name).join(", ")} differ` : ""}\n`,
  );
}
