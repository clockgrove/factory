import { availableParallelism } from "node:os";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Process-heavy Supervisor scenarios share CPU with subprocesses and mock
    // services. Two file workers keep the complete suite within that resource
    // contract; the smaller PR gate raises its explicit CLI limit to four.
    maxWorkers: Math.min(2, availableParallelism()),
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
