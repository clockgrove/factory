#!/usr/bin/env node
// Print the test files for CI shard <shard> of <total>, one per line.
//
//   node scripts/test-shards.mjs <shard> <total>
//
// Files are packed longest first, each onto the shard with the least
// estimated time so far, using test/support/test-timings.json (seconds per
// file; a file it does not list counts as DEFAULT_SECONDS). The order is
// fixed, so every shard computes the same assignment. Refresh the timings
// from a CI log when a shard nears its timeout.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const DEFAULT_SECONDS = 5;

/** Every test file, as `test/<name>.test.mjs`, sorted. */
function testFiles() {
  return readdirSync(join(root, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `test/${name}`);
}

/** Pack `files` into `total` shards; returns [{ files, seconds }]. */
function packShards(files, timings, total) {
  const seconds = (file) => timings[file] ?? DEFAULT_SECONDS;
  const shards = Array.from({ length: total }, () => ({
    files: [],
    seconds: 0,
  }));
  const ordered = [...files].sort(
    (a, b) => seconds(b) - seconds(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const file of ordered) {
    // The first shard with the least time, so ties break by index.
    const shard = shards.reduce((least, next) =>
      next.seconds < least.seconds ? next : least,
    );
    shard.files.push(file);
    shard.seconds += seconds(file);
  }
  return shards;
}

function main(args) {
  const [shard, total] = args.map(Number);
  if (
    args.length !== 2 ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(shard) ||
    shard < 1 ||
    shard > total
  )
    throw new Error("usage: test-shards.mjs <shard> <total>");
  const timings = JSON.parse(
    readFileSync(join(root, "test/support/test-timings.json"), "utf8"),
  );
  const shards = packShards(testFiles(), timings, total);
  const { files: mine, seconds } = shards[shard - 1];
  // An empty list would make `node --test` run every test file.
  if (!mine.length) throw new Error(`shard ${shard}/${total} has no files`);
  console.error(
    `shard ${shard}/${total}: ${mine.length} files, about ${Math.round(seconds)} s ` +
      `(shards: ${shards.map((s) => Math.round(s.seconds)).join(", ")} s)`,
  );
  console.log(mine.join("\n"));
}

main(process.argv.slice(2));
