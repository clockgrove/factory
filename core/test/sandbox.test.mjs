// Real command sandbox behavior, including read-only Git in linked worktrees.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runSandboxed } from "../dist/sandbox.js";
import { addWorktree, validationEnvironment } from "../dist/worktree.js";

test("validation can read Git with system symlink directories on PATH", async (t) => {
  const root = mkdtempSync("/tmp/factory-sandbox-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const home = join(root, "home");
  const temporary = join(root, "temporary");
  const credentials = join(root, "credentials");
  for (const dir of [checkout, home, temporary, credentials]) mkdirSync(dir);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  writeFileSync(join(checkout, "a.txt"), "test\n");
  writeFileSync(join(checkout, ".gitattributes"), "a.txt test=value\n");
  git("add", "a.txt", ".gitattributes");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const directory = join(root, "item.validation");
  await addWorktree(checkout, directory, git("rev-parse", "HEAD"));
  const result = await runSandboxed("git check-attr test -- a.txt", {
    cwd: directory,
    home,
    temporary,
    env: { ...validationEnvironment(credentials), PATH: "/bin:/sbin:/usr/bin" },
    config: {
      required: true,
      network: "off",
      readOnlyPaths: [],
      environment: {},
      limits: {
        tmpMiB: 16,
        homeMiB: 16,
        checkoutMiB: 16,
        files: 1024,
        candidateMiB: 16,
        candidateFiles: 1024,
        processes: 4096,
      },
    },
    signal: AbortSignal.timeout(30_000),
    timeoutMs: 20_000,
  });
  assert.equal(result.kind, "ran", JSON.stringify(result));
  assert.equal(result.sandboxed, true);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "a.txt: test: value");
});
