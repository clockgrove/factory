import { availableParallelism } from "node:os";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Percentage worker counts round down to one on GitHub's four-core runners.
    // Four workers already fit the deterministic suite's local resource contract.
    maxWorkers: Math.min(4, availableParallelism()),
    testTimeout: 30_000,
    setupFiles: ["./test/setup-temporary-namespace.ts"],
    exclude: [...configDefaults.exclude, "test/*-live.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        branches: 50,
        functions: 60,
        lines: 60,
        statements: 60,
      },
    },
  },
});
