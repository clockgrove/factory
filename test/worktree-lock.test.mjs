// Git does not lock a repository's worktree registry. A fetch that walks it
// while `git worktree remove` deletes an entry dies with
// "fatal: Invalid path '<checkout>/.git/worktrees/<id>'". Factory serializes
// these commands per repository in its git wrapper. These tests hold one
// command mid-way with a git shim on PATH and check that the other waits.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  git,
  gitAsync,
  pinnedGitAsync,
  pinnedGitRaw,
  removeWorktree,
} from "../dist/process.js";

const realGit = spawnSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).stdout.trim();

function run(cwd, ...args) {
  const result = spawnSync(realGit, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// The shim logs each command's start and end. The first invocation of the
// held command pauses until the test releases it. A held fetch first lists
// the registry and afterwards reads each listed entry, as fetch's
// connectivity check does when it resolves every worktree's HEAD.
const SHIM = `#!/bin/sh
sub=$3
[ "$sub" = worktree ] && sub="worktree-$4"
[ "$sub" = rev-parse ] || echo "start $sub" >>"$FACTORY_TEST_DIR/log"
if [ "$sub" = "$FACTORY_TEST_HOLD" ] && mkdir "$FACTORY_TEST_DIR/holding" 2>/dev/null; then
  if [ "$sub" = fetch ]; then
    common=$("$FACTORY_TEST_REAL_GIT" -C "$2" rev-parse --path-format=absolute --git-common-dir)
    entries=$(ls "$common/worktrees")
  fi
  touch "$FACTORY_TEST_DIR/held"
  while [ ! -e "$FACTORY_TEST_DIR/release" ]; do sleep 0.01; done
  for id in $entries; do
    if [ ! -e "$common/worktrees/$id/commondir" ]; then
      echo "fatal: Invalid path '$common/worktrees/$id': No such file or directory" >&2
      echo "end $sub" >>"$FACTORY_TEST_DIR/log"
      exit 128
    fi
  done
fi
"$FACTORY_TEST_REAL_GIT" "$@"
status=$?
[ "$sub" = rev-parse ] || echo "end $sub" >>"$FACTORY_TEST_DIR/log"
exit $status
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-worktree-lock-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  run(root, "init", "-q", "--bare", "-b", "main", origin);
  run(root, "init", "-q", "-b", "main", seed);
  const commit = (message) =>
    run(
      seed,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    );
  commit("base");
  run(seed, "push", "-q", origin, "main");
  run(root, "clone", "-q", origin, checkout);
  const worktree = (name) => {
    const path = join(root, name);
    run(checkout, "worktree", "add", "-q", "--detach", path, "HEAD");
    writeFileSync(join(path, "output.txt"), "validation output\n");
    return path;
  };
  // Give the fetch new objects so it runs its connectivity check.
  commit("advance");
  run(seed, "push", "-q", origin, "main");
  return { root, checkout, worktree };
}

async function withShim(root, hold, operation) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), SHIM, { mode: 0o755 });
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    FACTORY_TEST_DIR: root,
    FACTORY_TEST_HOLD: hold,
    FACTORY_TEST_REAL_GIT: realGit,
  });
  try {
    await operation({
      held: async () => {
        while (!existsSync(join(root, "held"))) await delay(10);
      },
      release: () => writeFileSync(join(root, "release"), ""),
      log: () => readFileSync(join(root, "log"), "utf8").trim().split("\n"),
    });
  } finally {
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

// The waiting command cannot start while the lock works. Without the lock it
// starts at once; give it a moment to show that, then release.
const settledOrStarted = (promise) =>
  Promise.race([promise.then(undefined, () => undefined), delay(300)]);

test("a worktree removal waits for a fetch walking the registry", async () => {
  const { root, checkout, worktree } = fixture();
  const validation = worktree("validation");
  await withShim(root, "fetch", async ({ held, release, log }) => {
    const fetch = gitAsync(checkout, "fetch", "origin", "main");
    await held();
    const removal = removeWorktree(checkout, validation);
    await settledOrStarted(removal);
    release();
    await fetch;
    await removal;
    assert.deepEqual(log(), [
      "start fetch",
      "end fetch",
      "start worktree-remove",
      "end worktree-remove",
    ]);
  });
  assert.equal(existsSync(validation), false);
  assert.doesNotMatch(run(checkout, "worktree", "list"), /validation/);
  assert.equal(
    run(checkout, "rev-parse", "FETCH_HEAD"),
    run(join(root, "seed"), "rev-parse", "HEAD"),
  );
});

test("a fetch from a linked worktree waits for a removal in progress", async () => {
  const { root, checkout, worktree } = fixture();
  const validation = worktree("validation");
  // Linked worktrees share the checkout's common directory, so its lock.
  const agent = worktree("agent");
  await withShim(root, "worktree-remove", async ({ held, release, log }) => {
    const removal = removeWorktree(checkout, validation);
    await held();
    const fetch = gitAsync(agent, "fetch", "origin", "main");
    await settledOrStarted(fetch);
    release();
    await removal;
    await fetch;
    assert.deepEqual(log(), [
      "start worktree-remove",
      "end worktree-remove",
      "start fetch",
      "end fetch",
    ]);
  });
});

test("worktree registrations do not interleave", async () => {
  const { root, checkout, worktree } = fixture();
  const validation = worktree("validation");
  await withShim(root, "worktree-remove", async ({ held, release, log }) => {
    const removal = removeWorktree(checkout, validation);
    await held();
    const addition = pinnedGitAsync(
      checkout,
      "worktree",
      "add",
      "--detach",
      join(root, "next"),
      "HEAD",
    );
    await settledOrStarted(addition);
    release();
    await removal;
    await addition;
    assert.deepEqual(log(), [
      "start worktree-remove",
      "end worktree-remove",
      "start worktree-add",
      "end worktree-add",
    ]);
  });
});

test("synchronous git refuses commands that need the repository lock", () => {
  const { checkout } = fixture();
  assert.throws(
    () => git(checkout, "fetch", "origin", "main"),
    /must run through gitAsync or pinnedGitAsync/,
  );
  assert.throws(
    () => pinnedGitRaw(checkout, "worktree", "prune"),
    /must run through gitAsync or pinnedGitAsync/,
  );
});
