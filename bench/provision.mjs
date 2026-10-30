#!/usr/bin/env node
/**
 * `node bench/provision.mjs --benchmark ID|FILE --host FILE --factory PATH [--run-id ID]
 *  [--label TEXT] [--group NAME] [--share N] [--workers N] [--validations N]
 *  [--memory-mib N] [--dry-run]`: set up one benchmark run
 * (bench/lib/provision.mjs) and print its run directory. PATH is an
 * installed Factory CLI (a release) or a Factory checkout with a build (a
 * candidate). A definition given by ID is looked up in --benchmarks DIR, or
 * benchmarks/ in --bench-home DIR or FACTORY_BENCH_HOME; the run record
 * keeps the results directory (--results DIR, or the home's results/) that
 * bench/run.mjs scores into (bench/lib/home.mjs); without one it refuses
 * before creating anything. The run's service gets the definition's
 * `factory.capacity`; --share N gives it about 1/N of the host instead, for
 * N runs side by side, and --workers, --validations and --memory-mib set
 * one value over both. --dry-run prints every
 * GitHub, Git and setup action and does none of them. Without --run-id the
 * run gets a new id (the minute and a random suffix); running it again
 * with the same --run-id carries on.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadDefinition } from "./lib/definition.mjs";
import { benchDirs, DIR_OPTIONS, missingDir } from "./lib/home.mjs";
import {
  defaultRunId,
  loadHost,
  provision,
  Runner,
  resolveFactory,
  runCapacity,
} from "./lib/provision.mjs";

const { values } = parseArgs({
  options: {
    ...DIR_OPTIONS,
    benchmark: { type: "string" },
    host: { type: "string" },
    factory: { type: "string" },
    "run-id": { type: "string" },
    label: { type: "string" },
    group: { type: "string" },
    share: { type: "string" },
    workers: { type: "string" },
    validations: { type: "string" },
    "memory-mib": { type: "string" },
    "dry-run": { type: "boolean" },
  },
});
const usage = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(64);
};
for (const flag of ["benchmark", "host", "factory"])
  if (!values[flag])
    usage(`--${flag} is required; see the header of bench/provision.mjs`);
/** A whole-number flag: its value, or undefined when not given. */
const whole = (flag, least) => {
  const text = values[flag];
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text) || Number(text) < least)
    usage(`--${flag} ${text}: a whole number, ${least} or more`);
  return Number(text);
};
const given = {
  share: whole("share", 1),
  workers: whole("workers", 1),
  validations: whole("validations", 1),
  memoryMib: whole("memory-mib", 256),
};

const dirs = benchDirs(values);
// A run is never provisioned without a place to be scored into.
if (!dirs.results)
  usage(`Where to score the run into: ${missingDir("results", "results")}`);
let definition;
try {
  definition = loadDefinition(values.benchmark, dirs.benchmarks);
} catch (error) {
  usage(error.message);
}
const host = loadHost(values.host);
const factory = resolveFactory(values.factory);
// A run id is part of a repository name: lowercase, digits and -.
const runId = values["run-id"] ?? defaultRunId();
if (!/^[a-z0-9][a-z0-9-]*$/.test(runId))
  usage(`--run-id ${runId}: lowercase letters, digits and - only`);
// A new id names a new run: a run directory already there is another's.
if (!values["run-id"] && existsSync(join(host.benchRoot, definition.id, runId)))
  usage(
    `${join(host.benchRoot, definition.id, runId)} exists already: give --run-id to carry that run on`,
  );
const build =
  factory.kind === "candidate"
    ? `${factory.branch}@${factory.commit.slice(0, 7)}${factory.dirty ? "+dirty" : ""}`
    : factory.version;
const runner = new Runner({
  dryRun: Boolean(values["dry-run"]),
  print: (line) => process.stdout.write(`${line}\n`),
});
runner.print(
  `${runner.dryRun ? "Dry run: nothing is created. " : ""}${definition.id} run ${runId} on Factory ${build} (${factory.cli})`,
);
let record;
try {
  record = await provision({
    definition,
    host,
    factory,
    runId,
    label: values.label ?? `${definition.id} ${runId}, Factory ${build}`,
    group: values.group ?? `Factory ${build}`,
    resultsDir: dirs.results,
    capacity: runCapacity(definition, given),
    runner,
  });
} catch (error) {
  // Each step names what to fix; running it again with this run id carries on.
  process.stderr.write(
    `Provisioning ${definition.id} run ${runId} stopped: ${error.message}\nFix it, then run again with --run-id ${runId}.\n`,
  );
  process.exit(1);
}
runner.print(
  runner.dryRun
    ? `\nThe run record would be:\n${JSON.stringify(record, null, 2)}`
    : `\nProvisioned: ${record.repository}#${record.issue}\nNext: node bench/run.mjs --run-dir ${record.runDir}`,
);
