import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkStagedCandidate } from "../dist/execution/staged-candidate.js";

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
  }).trim();
}

test("staged secrets cannot be hidden by replacing working bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-staged-secret-"));
  try {
    const checkout = root;
    git(checkout, "init", "-b", "main");
    writeFileSync(join(checkout, "README.md"), "# Target\n");
    git(checkout, "add", ".");
    git(
      checkout,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "base",
    );
    const value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(join(checkout, "safe.txt"), `GITHUB_TOKEN=${value}\n`);
    git(checkout, "add", "safe.txt");
    writeFileSync(join(checkout, "safe.txt"), "Clean working bytes.\n");
    await assert.rejects(
      () => checkStagedCandidate(checkout, checkout, ["safe.txt"]),
      (error) => {
        assert.match(
          error.message,
          /Secretlint found suspected secret in "safe.txt"/,
        );
        assert.match(error.message, /@secretlint\/secretlint-rule-github/);
        assert.ok(!error.message.includes(value));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
