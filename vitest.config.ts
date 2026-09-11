import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
