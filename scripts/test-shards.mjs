#!/usr/bin/env node
// Checks that CI's test shards ran every test file exactly once.
//
//   node scripts/test-shards.mjs LIST...
//
// Each LIST is one shard's output from the scripts/test-files.mjs reporter.
// Exits 1 when a test/*.test.mjs file ran in no shard or in several (a lost
// shard, or a split that is not a partition), or a shard ran something else.
import { readdirSync, readFileSync } from "node:fs";

const lists = process.argv.slice(2);
if (!lists.length) {
  console.error("usage: test-shards.mjs LIST...");
  process.exit(2);
}

const ranIn = new Map();
for (const list of lists)
  for (const file of readFileSync(list, "utf8").split("\n").filter(Boolean))
    ranIn.set(file, [...(ranIn.get(file) ?? []), list]);

const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `test/${name}`)
  .sort();
const problems = [];
for (const file of files) {
  const shards = ranIn.get(file) ?? [];
  if (shards.length === 0) problems.push(`${file} ran in no shard`);
  else if (shards.length > 1)
    problems.push(
      `${file} ran in ${shards.length} shards: ${shards.join(", ")}`,
    );
}
for (const [file, shards] of ranIn)
  if (!files.includes(file))
    problems.push(
      `${shards.join(", ")} ran ${file}, not a test/*.test.mjs file`,
    );

for (const problem of problems) console.error(problem);
console.log(
  `${files.length} test files across ${lists.length} shards: ${problems.length ? `${problems.length} problems` : "each ran once"}`,
);
process.exit(problems.length ? 1 : 0);
