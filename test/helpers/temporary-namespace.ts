import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolate one offline test file, including child processes, from live caches. */
export function enterTemporaryNamespace(parent = tmpdir()) {
  const previous = process.env.TMPDIR;
  const root = mkdtempSync(join(parent, "factory-test-namespace-"));
  process.env.TMPDIR = root;
  return {
    root,
    restore() {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      // Individual fixtures own cleanup after retirement. Never recursively
      // discard retained artifacts or unresolved work merely because tests ended.
      try {
        rmdirSync(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
      }
    },
  };
}
