#!/usr/bin/env node
// Refreshes test/timings.json, the seconds each test file took in CI, from
// one CI run's test shards:
//
//   gh run download RUN --pattern 'test-files-*' --dir /tmp/run
//   node scripts/test-timings.mjs /tmp/run/*/test-durations.json
//
// Each DURATIONS is one shard's output from the scripts/test-durations.mjs
// reporter. The file lists the files those shards ran, to a tenth of a
// second; scripts/test-partition.mjs balances the shards by it.
import { readFileSync, writeFileSync } from "node:fs";

const durations = process.argv.slice(2);
if (!durations.length) {
  console.error("usage: test-timings.mjs DURATIONS...");
  process.exit(2);
}

const seconds = {};
for (const path of durations)
  for (const [file, took] of Object.entries(
    JSON.parse(readFileSync(path, "utf8")),
  ))
    seconds[file] = Math.max(seconds[file] ?? 0, took);

const files = Object.keys(seconds).sort();
writeFileSync(
  "test/timings.json",
  `${JSON.stringify(
    Object.fromEntries(
      files.map((file) => [file, Math.round(seconds[file] * 10) / 10]),
    ),
    null,
    2,
  )}\n`,
);
console.log(
  `test/timings.json: ${files.length} test files from ${durations.length} shards`,
);
