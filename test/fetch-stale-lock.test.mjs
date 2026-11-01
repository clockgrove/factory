// clockgrove/factory#2359: a Git killed mid-fetch leaves a ref lock (such
// as refs/remotes/origin/HEAD.lock) that no later Git removes, so every
// later fetch failed on it. The default-branch fetch clears locks older
// than the staleness threshold first, and never a young one (a live Git's).
// Real Git; origin names a GitHub repository (the origin check requires
// it) and reaches a real bare repository through an ssh command that runs
// the remote Git program locally.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultHead } from "../dist/git.js";
import { tempDir } from "./helpers.mjs";

const git = (cwd, ...args) => {
  const run = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

test("a stale ref lock a killed fetch left no longer blocks the next fetch; a young one is kept", async () => {
  const root = tempDir("factory-fetch-lock-");
  // `git@github.com:owner/name.git` reaches `<root>/remote/owner/name.git`.
  const bare = join(root, "remote", "owner", "name.git");
  const seed = join(root, "seed");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  git(root, "init", "--quiet", "--initial-branch=main", seed);
  writeFileSync(join(seed, "a"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "base");
  git(seed, "push", "--quiet", bare, "main");
  const ssh = join(root, "ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh\nfor last; do :; done\ncd '${join(root, "remote")}' && exec sh -c "$last"\n`,
  );
  chmodSync(ssh, 0o755);

  const checkout = join(root, "checkout");
  git(root, "init", "--quiet", "--initial-branch=main", checkout);
  git(checkout, "remote", "add", "origin", "git@github.com:owner/name.git");
  git(checkout, "config", "core.sshCommand", ssh);

  const lock = join(checkout, ".git", "refs", "remotes", "origin", "HEAD.lock");
  const fetch = (log) =>
    defaultHead(checkout, "owner/name", AbortSignal.timeout(60_000), log);
  const first = await fetch();
  assert.equal(first, git(seed, "rev-parse", "HEAD"));

  // A kill mid-fetch: the lock stays, and the default branch has moved.
  writeFileSync(lock, "");
  writeFileSync(join(seed, "b"), "b\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "next");
  git(seed, "push", "--quiet", bare, "main");
  const next = git(seed, "rev-parse", "HEAD");

  const events = [];
  await assert.rejects(
    fetch((event) => events.push(event)),
    /HEAD/,
  );
  assert.ok(existsSync(lock), "a young lock is a live Git's: kept");
  assert.ok(events.some((e) => e.event === "git-lock-kept"));

  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, old, old);
  assert.equal(await fetch((event) => events.push(event)), next);
  assert.ok(!existsSync(lock));
  assert.ok(events.some((e) => e.event === "git-lock-removed"));
});
