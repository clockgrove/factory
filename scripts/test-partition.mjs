#!/usr/bin/env node
// Prints the test files CI's test shard I of N runs, one per line, the
// longest first:
//
//   node scripts/test-partition.mjs I N
//
// Every test/*.test.mjs file goes to exactly one shard, balanced by the
// seconds test/timings.json says it took (scripts/test-timings.mjs
// refreshes it): the longest first, each to the shard with the fewest
// seconds so far. A file the timings don't list yet counts as their
// median. scripts/test-shards.mjs checks that the shards between them ran
// each file once.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const [i, n] = process.argv.slice(2).map(Number);
if (
  process.argv.length !== 4 ||
  !Number.isInteger(i) ||
  !Number.isInteger(n) ||
  i < 1 ||
  i > n
) {
  console.error("usage: test-partition.mjs I N (1 <= I <= N)");
  process.exit(2);
}

const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `test/${name}`)
  .sort();
const timings = existsSync("test/timings.json")
  ? JSON.parse(readFileSync("test/timings.json", "utf8"))
  : {};
const known = files
  .filter((file) => typeof timings[file] === "number")
  .map((file) => timings[file])
  .sort((a, b) => a - b);
const half = Math.floor(known.length / 2);
const median = !known.length
  ? 1
  : known.length % 2
    ? known[half]
    : (known[half - 1] + known[half]) / 2;
const seconds = (file) =>
  typeof timings[file] === "number" ? timings[file] : median;

// Ties go by name, then to the shard with the fewest files, then to the
// lowest, so every shard computes the same partition, and files timed at
// 0 s still spread.
const shards = Array.from({ length: n }, () => ({ files: [], seconds: 0 }));
for (const file of [...files].sort(
  (a, b) => seconds(b) - seconds(a) || a.localeCompare(b),
)) {
  const least = shards.reduce((min, shard) =>
    shard.seconds < min.seconds ||
    (shard.seconds === min.seconds && shard.files.length < min.files.length)
      ? shard
      : min,
  );
  least.files.push(file);
  least.seconds += seconds(file);
}

const shard = shards[i - 1];
// node --test with no files runs its default patterns, every file again.
if (!shard.files.length) {
  console.error(`shard ${i} of ${n} has no test files: use fewer shards`);
  process.exit(1);
}
// Longest first, as node --test starts them: a long file started last
// would run on alone after the rest.
for (const file of shard.files) console.log(file);
console.error(
  `shard ${i} of ${n}: ${shard.files.length} test files, about ${Math.round(shard.seconds)} s`,
);
