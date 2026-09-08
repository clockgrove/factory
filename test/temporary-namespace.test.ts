import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { enterTemporaryNamespace } from "./helpers/temporary-namespace.js";

it("inherits a private namespace in subprocesses and restores the parent", () => {
  const original = tmpdir();
  expect(basename(original)).toMatch(/^factory-test-namespace-/);
  const namespace = enterTemporaryNamespace();
  try {
    expect(tmpdir()).toBe(namespace.root);
    expect(
      execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').tmpdir())"], {
        encoding: "utf8",
      }),
    ).toBe(namespace.root);
  } finally {
    namespace.restore();
  }
  expect(tmpdir()).toBe(original);
  expect(existsSync(namespace.root)).toBe(false);
});

it("preserves retained files when restoring the namespace", () => {
  const namespace = enterTemporaryNamespace();
  const retained = join(namespace.root, "fixture-retained-evidence");
  writeFileSync(retained, "fixture evidence");
  namespace.restore();
  try {
    expect(existsSync(retained)).toBe(true);
  } finally {
    // Only this test's synchronous synthetic file is eligible for deletion.
    rmSync(retained);
    namespace.restore();
  }
});
