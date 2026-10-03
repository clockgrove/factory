import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { selectPrTests } from "../scripts/test-pr.mjs";

const tests = [
  "test/acceptance.test.mjs",
  "test/analysis.test.mjs",
  "test/package-smoke.test.mjs",
  "test/pr-test-gate.test.mjs",
  "test/sandbox-installed.test.mjs",
];
const ordinary = tests.filter(
  (path) =>
    !path.includes("package-smoke") && !path.includes("sandbox-installed"),
);
const packaged = [
  "dist",
  "skills",
  "assets",
  "README.md",
  "docs/SANDBOX-EXECUTION.md",
  ".codex-plugin",
];

test("PR gate retains every ordinary test for isolated source, tests and contributor guidance", () => {
  for (const path of [
    "src/scheduler.ts",
    "src/analysis.ts",
    "test/analysis.test.mjs",
    "docs/ARCHITECTURE.md",
    "CONTRIBUTING.md",
  ])
    assert.deepEqual(selectPrTests([path], tests, packaged), ordinary, path);
});

test("packaging, entrypoints, installed workers and fixtures retain both installed proofs", () => {
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "scripts/release.mjs",
    ".github/workflows/quality.yml",
    "src/index.ts",
    "src/cli.ts",
    "src/application.ts",
    "src/package-metadata.ts",
    "src/process.ts",
    "src/config.ts",
    "src/provider-credentials.ts",
    "src/harness-readiness.ts",
    "src/execution-profiles.ts",
    "src/execution/worker.ts",
    "src/execution/secret-scan.ts",
    "src/execution/sandbox-worker.ts",
    "src/content/local.ts",
    "skills/director/SKILL.md",
    ".codex-plugin/plugin.json",
    "assets/logo.png",
    "README.md",
    "docs/SANDBOX-EXECUTION.md",
    "test/fixtures/packed-harness-runner.mjs",
    "test/support/sandbox-provider.mjs",
    "test/support/integration-fixture.mjs",
    "test/package-smoke.test.mjs",
    "test/sandbox-installed.test.mjs",
  ])
    assert.deepEqual(selectPrTests([path], tests, packaged), tests, path);
});

test("unknown paths and missing or empty diff select the complete suite", () => {
  for (const files of [
    undefined,
    [],
    ["new-build.config"],
    ["src/new-runtime.json"],
    ["test/unknown-helper.mjs"],
    ["docs/notes.md", "package.json"],
  ])
    assert.deepEqual(selectPrTests(files, tests, packaged), tests);
  // --no-renames includes both old and new names, preserving deleted packaged paths.
  assert.deepEqual(
    selectPrTests(
      ["docs/SANDBOX-EXECUTION.md", "docs/renamed.md"],
      tests,
      packaged,
    ),
    tests,
  );
  assert.deepEqual(
    selectPrTests(["test/deleted.test.mjs"], tests, packaged),
    ordinary,
  );
});

test("an unavailable PR base executes all available tests rather than dropping installed files", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-pr-gate-"));
  try {
    mkdirSync(join(root, "test"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ files: packaged }),
    );
    for (const name of ["ordinary", "package-smoke", "sandbox-installed"])
      writeFileSync(
        join(root, "test", `${name}.test.mjs`),
        `import test from "node:test"; test(${JSON.stringify(name)}, () => {});\n`,
      );
    const output = execFileSync(
      process.execPath,
      [resolve("scripts/test-pr.mjs"), "--base", "missing-base"],
      {
        cwd: root,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.match(output, /PR tests: 3\/3 files; complete suite/);
    assert.match(output, /tests 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
