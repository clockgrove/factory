#!/usr/bin/env node
/**
 * `node bench/provision.mjs --benchmark ID --host FILE --factory PATH [--run-id ID]
 *  [--label TEXT] [--group NAME] [--dry-run]`: set up one benchmark run
 * (bench/lib/provision.mjs) and print its run directory. PATH is an
 * installed Factory CLI (a release) or a Factory checkout with a build (a
 * candidate). --dry-run prints every GitHub, Git and setup action and does
 * none of them. Running it again with the same --run-id carries on.
 */
import { parseArgs } from "node:util";
import { loadDefinition } from "./lib/definition.mjs";
import {
  loadHost,
  provision,
  Runner,
  resolveFactory,
} from "./lib/provision.mjs";

const { values } = parseArgs({
  options: {
    benchmark: { type: "string" },
    host: { type: "string" },
    factory: { type: "string" },
    "run-id": { type: "string" },
    label: { type: "string" },
    group: { type: "string" },
    "dry-run": { type: "boolean" },
  },
});
for (const flag of ["benchmark", "host", "factory"])
  if (!values[flag]) {
    process.stderr.write(
      `--${flag} is required; see the header of bench/provision.mjs\n`,
    );
    process.exit(64);
  }

const definition = loadDefinition(values.benchmark);
const host = loadHost(values.host);
const factory = resolveFactory(values.factory);
// A run id is part of a repository name: lowercase, digits and -.
const runId =
  values["run-id"] ??
  new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
if (!/^[a-z0-9][a-z0-9-]*$/.test(runId)) {
  process.stderr.write(
    `--run-id ${runId}: lowercase letters, digits and - only\n`,
  );
  process.exit(64);
}
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
const record = await provision({
  definition,
  host,
  factory,
  runId,
  label: values.label ?? `${definition.id} ${runId}, Factory ${build}`,
  group: values.group ?? `Factory ${build}`,
  runner,
});
runner.print(
  runner.dryRun
    ? `\nThe run record would be:\n${JSON.stringify(record, null, 2)}`
    : `\nProvisioned: ${record.repository}#${record.issue}\nNext: node bench/run.mjs --run-dir ${record.runDir}`,
);
