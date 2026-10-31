// A node --test reporter that writes the seconds each test file took, as a
// JSON object keyed by its path relative to the working directory. Each CI
// test shard writes one, and scripts/test-timings.mjs merges a run's into
// test/timings.json, which scripts/test-partition.mjs balances shards by.
import { relative } from "node:path";

export default async function* testDurations(source) {
  // The runner reports each file as a top-level test that spans the file's
  // own, so a file's longest top-level test is the file.
  const seconds = {};
  for await (const { type, data } of source)
    if (type === "test:complete" && data.nesting === 0 && data.file) {
      const file = relative(process.cwd(), data.file);
      const took = (data.details?.duration_ms ?? 0) / 1000;
      seconds[file] = Math.max(seconds[file] ?? 0, took);
    }
  const sorted = Object.keys(seconds).sort();
  yield `${JSON.stringify(Object.fromEntries(sorted.map((file) => [file, seconds[file]])), null, 2)}\n`;
}
