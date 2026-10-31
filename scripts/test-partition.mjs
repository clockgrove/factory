#!/usr/bin/env node
// Prints the test files CI's test shard I of N runs, one per line:
//
//   node scripts/test-partition.mjs I N [C]
//
// Every test/*.test.mjs file goes to exactly one shard, balanced by the
// seconds test/timings.json says it took (scripts/test-timings.mjs
// refreshes it): the longest first, each to the shard that would finish
// soonest with it. A file the timings don't list yet counts as their
// median. scripts/test-shards.mjs checks that the shards between them ran
// each file once.
//
// A shard finishes when node --test does, and node --test starts a shard's
// files in name order whatever order they are given in, C at a time (C
// defaults to its own default, one less than the CPUs, at least one). So a
// long file that sorts last in a shard of many starts late and runs on
// alone after the rest; the partition counts that, not only the seconds.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const args = process.argv.slice(2);
const [i, n, c = Math.max(availableParallelism() - 1, 1)] = args.map(Number);
if (
  args.length < 2 ||
  args.length > 3 ||
  !Number.isInteger(i) ||
  !Number.isInteger(n) ||
  !Number.isInteger(c) ||
  i < 1 ||
  i > n ||
  c < 1
) {
  console.error("usage: test-partition.mjs I N [C] (1 <= I <= N, 1 <= C)");
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

/** The seconds node --test takes to run `shard`: in name order, C at once. */
function finish(shard) {
  const running = Array(c).fill(0);
  for (const file of [...shard].sort()) {
    const free = running.indexOf(Math.min(...running));
    running[free] += seconds(file);
  }
  return Math.max(...running);
}

// Ties go by name, then to the shard with the fewest seconds, then the
// fewest files, then the lowest, so every shard computes the same
// partition, and files timed at 0 s still spread.
const shards = Array.from({ length: n }, () => ({
  files: [],
  seconds: 0,
  finish: 0,
}));
for (const file of [...files].sort(
  (a, b) => seconds(b) - seconds(a) || a.localeCompare(b),
)) {
  let best;
  for (const shard of shards) {
    const ends = finish([...shard.files, file]);
    if (
      !best ||
      ends < best.ends ||
      (ends === best.ends &&
        (shard.seconds < best.shard.seconds ||
          (shard.seconds === best.shard.seconds &&
            shard.files.length < best.shard.files.length)))
    )
      best = { shard, ends };
  }
  best.shard.files.push(file);
  best.shard.seconds += seconds(file);
  best.shard.finish = best.ends;
}

const shard = shards[i - 1];
// node --test with no files runs its default patterns, every file again.
if (!shard.files.length) {
  console.error(`shard ${i} of ${n} has no test files: use fewer shards`);
  process.exit(1);
}
// In name order, the order node --test starts them in.
for (const file of [...shard.files].sort()) console.log(file);
console.error(
  `shard ${i} of ${n}: ${shard.files.length} test files, about ${Math.round(shard.finish)} s at ${c} at a time`,
);
