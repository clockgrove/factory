// A node --test reporter that lists the test files a run loaded, one path
// per line relative to the working directory. Each CI test shard writes one,
// and scripts/test-shards.mjs checks that together they ran every file once.
import { relative } from "node:path";

export default async function* testFiles(source) {
  // The runner queues each file as a top-level test, even one that fails to
  // load or has no tests of its own.
  const files = new Set();
  for await (const { type, data } of source)
    if (type === "test:enqueue" && data.nesting === 0 && data.file)
      files.add(relative(process.cwd(), data.file));
  for (const file of [...files].sort()) yield `${file}\n`;
}
