// Git does not lock a repository's worktree registry. A fetch that walks it
// while `git worktree remove` deletes an entry dies with
// "fatal: Invalid path '<checkout>/.git/worktrees/<id>'". Factory's git
// wrapper holds a per-repository reader/writer lock: registry changes
// exclusive, registry walks (fetch) shared. These tests hold one command
// partway through with a git shim on PATH and check what the others do.
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
import { assertSupportedGit } from "../dist/config.js";
import { attachedFault } from "../dist/fault.js";
import {
  addWorktree,
  fetchHead,
  GitDeadlineExceeded,
  git,
  gitAsync,
  lingeringDescendants,
  linuxProcessIdentity,
  lockedNetworkDeadline,
  pinnedGitAsync,
  pinnedGitRaw,
  processGroupExists,
  removeWorktree,
  SSH_KEEPALIVE_COMMAND,
  withProcessCancellation,
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
case "$sub" in rev-parse|update-ref|config|--version) quiet=1 ;; *) quiet= ;; esac
[ "$sub" = fetch ] && printf '%s' "\${GIT_SSH_COMMAND-}" >"$FACTORY_TEST_DIR/ssh-command"
[ -n "$quiet" ] || echo "start $sub" >>"$FACTORY_TEST_DIR/log"
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
[ -n "$quiet" ] || echo "end $sub" >>"$FACTORY_TEST_DIR/log"
# Like git-remote-http after a connection reset: a transport helper that
# outlives the command in its process group.
if [ "$sub" = "$FACTORY_TEST_LINGER" ]; then
  sleep 30 >/dev/null 2>&1 &
  echo $! >"$FACTORY_TEST_DIR/lingering"
fi
exit $status
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-worktree-lock-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  run(root, "init", "-q", "--bare", "-b", "main", origin);
  run(root, "init", "-q", "-b", "main", seed);
  const commit = (message) => {
    writeFileSync(join(seed, "file.txt"), `${message}\n`);
    run(seed, "add", "file.txt");
    run(
      seed,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    );
  };
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
  return { root, checkout, worktree, head: run(seed, "rev-parse", "HEAD") };
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
    // Let a held shim exit even when an assertion failed.
    writeFileSync(join(root, "release"), "");
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

// The waiting command cannot start while the lock works. Without the lock it
// starts at once; give it a moment to show that, then release.
const settledOrStarted = (promise) =>
  Promise.race([promise.then(undefined, () => undefined), delay(300)]);

/** Whether `promise` settles within a generous bound. */
const settlesSoon = (promise) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(10_000).then(() => false),
  ]);

test("a worktree removal waits for a fetch walking the registry", async () => {
  const { root, checkout, worktree, head } = fixture();
  const validation = worktree("validation");
  await withShim(root, "fetch", async ({ held, release, log }) => {
    const fetched = fetchHead(checkout, "main");
    await held();
    const removal = removeWorktree(checkout, validation);
    await settledOrStarted(removal);
    release();
    assert.equal(await fetched, head);
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
  // The fetch left no ref and no FETCH_HEAD behind.
  assert.equal(run(checkout, "for-each-ref", "refs/factory"), "");
  assert.equal(existsSync(join(checkout, ".git", "FETCH_HEAD")), false);
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

test("fetches share the lock", async () => {
  const { root, checkout, head } = fixture();
  await withShim(root, "fetch", async ({ held, release, log }) => {
    const first = fetchHead(checkout, "main");
    await held();
    const second = fetchHead(checkout, "main");
    assert.equal(await settlesSoon(second), true);
    assert.equal(await second, head);
    release();
    assert.equal(await first, head);
    assert.deepEqual(log(), [
      "start fetch",
      "start fetch",
      "end fetch",
      "end fetch",
    ]);
  });
});

test("addWorktree checks out files outside the lock", async () => {
  const { root, checkout, head } = fixture();
  const added = join(root, "added");
  await withShim(root, "reset", async ({ held, release }) => {
    const addition = addWorktree(checkout, added, "HEAD");
    await held();
    // The registration is done; a fetch need not wait for the checkout.
    const fetch = gitAsync(checkout, "fetch", "origin", "main");
    assert.equal(await settlesSoon(fetch), true);
    await fetch;
    release();
    await addition;
  });
  assert.equal(readFileSync(join(added, "file.txt"), "utf8"), "base\n");
  assert.equal(run(added, "status", "--porcelain"), "");
  assert.notEqual(run(added, "rev-parse", "HEAD"), head);
});

test("a failed command releases the lock", async () => {
  const { root, checkout } = fixture();
  await assert.rejects(
    pinnedGitAsync(checkout, "worktree", "remove", join(root, "missing")),
    /is not a working tree/,
  );
  const next = pinnedGitAsync(
    checkout,
    "worktree",
    "add",
    "--detach",
    join(root, "next"),
    "HEAD",
  );
  assert.equal(await settlesSoon(next), true);
  await next;
});

test("a fetch queued behind a waiting registry change waits for it", async () => {
  const { root, checkout, worktree, head } = fixture();
  const validation = worktree("validation");
  await withShim(root, "fetch", async ({ held, release, log }) => {
    const first = fetchHead(checkout, "main");
    await held();
    // The removal queues behind the held fetch; the second fetch, queued
    // after it, must not overtake it although it could share the lock.
    // (removeWorktree deletes files before it queues, so queue the
    // unregistration directly.)
    const removal = pinnedGitAsync(
      checkout,
      "worktree",
      "remove",
      "--force",
      validation,
    );
    const second = fetchHead(checkout, "main");
    await settledOrStarted(second);
    release();
    assert.equal(await first, head);
    await removal;
    assert.equal(await second, head);
    assert.deepEqual(log(), [
      "start fetch",
      "end fetch",
      "start worktree-remove",
      "end worktree-remove",
      "start fetch",
      "end fetch",
    ]);
  });
});

test("a caller cancelled while queued leaves the queue", async () => {
  const { root, checkout, worktree, head } = fixture();
  const validation = worktree("validation");
  await withShim(root, "fetch", async ({ held, release, log }) => {
    const first = fetchHead(checkout, "main");
    await held();
    const controller = new AbortController();
    // Queued behind the held fetch.
    const removal = withProcessCancellation(controller.signal, () =>
      pinnedGitAsync(checkout, "worktree", "remove", "--force", validation),
    );
    // Queued behind the removal, in call order.
    const second = fetchHead(checkout, "main");
    await settledOrStarted(second);
    controller.abort(new Error("operator cancelled"));
    await assert.rejects(removal, /operator cancelled/);
    // The fetch behind the cancelled removal now shares the lock.
    assert.equal(await settlesSoon(second), true);
    assert.equal(await second, head);
    release();
    assert.equal(await first, head);
    assert.deepEqual(log(), [
      "start fetch",
      "start fetch",
      "end fetch",
      "end fetch",
    ]);
  });
  assert.equal(existsSync(validation), true);
});

test("a cancelled holder releases the lock to its successor", async () => {
  const { root, checkout, worktree, head } = fixture();
  const validation = worktree("validation");
  await withShim(root, "worktree-remove", async ({ held }) => {
    const controller = new AbortController();
    const removal = withProcessCancellation(controller.signal, () =>
      pinnedGitAsync(checkout, "worktree", "remove", "--force", validation),
    );
    await held();
    const fetched = fetchHead(checkout, "main");
    await settledOrStarted(fetched);
    controller.abort();
    await assert.rejects(removal, /cancelled after verified cessation/);
    assert.equal(await settlesSoon(fetched), true);
    assert.equal(await fetched, head);
  });
});

test("a stalled fetch stops at its deadline and releases the lock", async () => {
  const { root, checkout, worktree } = fixture();
  const validation = worktree("validation");
  const saved = lockedNetworkDeadline.milliseconds;
  lockedNetworkDeadline.milliseconds = 500;
  try {
    // The held fetch is released only long after its deadline, so that a
    // missing deadline fails this test instead of hanging it.
    await withShim(root, "fetch", async ({ held, release }) => {
      const fetched = fetchHead(checkout, "main");
      const fallback = setTimeout(release, 5_000);
      await held();
      const removal = removeWorktree(checkout, validation);
      const error = await fetched.then(
        () => assert.fail("stalled fetch completed"),
        (cause) => cause,
      );
      clearTimeout(fallback);
      assert.ok(error instanceof GitDeadlineExceeded, String(error));
      assert.equal(attachedFault(error)?.kind, "transient");
      assert.equal(await settlesSoon(removal), true);
      await removal;
    });
  } finally {
    lockedNetworkDeadline.milliseconds = saved;
  }
  assert.equal(existsSync(validation), false);
});

test("a transport helper outliving its fetch is stopped after the grace period", async () => {
  const { root, checkout, head } = fixture();
  const saved = lingeringDescendants.graceMilliseconds;
  lingeringDescendants.graceMilliseconds = 300;
  process.env.FACTORY_TEST_LINGER = "fetch";
  try {
    await withShim(root, "none", async () => {
      const groups = [];
      const fetched = await withProcessCancellation(
        undefined,
        () => fetchHead(checkout, "main"),
        (owned, settled) => groups.push({ owned, settled }),
      );
      assert.equal(fetched, head);
      const helper = Number(readFileSync(join(root, "lingering"), "utf8"));
      assert.ok([undefined, "Z"].includes(linuxProcessIdentity(helper)?.state));
      assert.ok(groups.some(({ settled }) => settled));
      for (const { owned } of groups)
        assert.equal(processGroupExists(owned.pid), false);
    });
  } finally {
    delete process.env.FACTORY_TEST_LINGER;
    lingeringDescendants.graceMilliseconds = saved;
  }
});

test("Factory's git never starts automatic maintenance", async () => {
  const { checkout } = fixture();
  for (const read of [gitAsync, pinnedGitAsync]) {
    assert.equal(
      await read(checkout, "config", "--get", "maintenance.auto"),
      "false",
    );
    assert.equal(await read(checkout, "config", "--get", "gc.auto"), "0");
  }
  assert.equal(git(checkout, "config", "--get", "gc.auto"), "0");
});

test("Factory's git never runs repository hooks", async () => {
  const { root, checkout } = fixture();
  const marker = join(root, "hook-ran");
  const hook = `#!/bin/sh\necho "$0" >>${JSON.stringify(marker)}\n`;
  // A hook in the repository's own directory, and one a worker points
  // core.hooksPath at.
  writeFileSync(join(checkout, ".git", "hooks", "pre-commit"), hook, {
    mode: 0o755,
  });
  const redirected = join(root, "worker-hooks");
  mkdirSync(redirected);
  writeFileSync(join(redirected, "post-commit"), hook, { mode: 0o755 });
  const added = join(root, "added");
  await addWorktree(checkout, added, "HEAD");
  run(added, "config", "core.hooksPath", redirected);
  writeFileSync(join(added, "new.txt"), "new\n");
  await pinnedGitAsync(added, "add", "new.txt");
  await pinnedGitAsync(
    added,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
    "commit",
    "-q",
    "-m",
    "pinned",
  );
  await gitAsync(
    added,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "ambient",
  );
  await removeWorktree(checkout, added);
  assert.equal(existsSync(marker), false);
  // The same hooks do run for plain git, so the test would see them.
  run(
    checkout,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "plain",
  );
  assert.equal(existsSync(marker), true);
});

test("a locked fetch bounds SSH stalls unless the operator chose the SSH command", async () => {
  const { root, checkout } = fixture();
  await withShim(root, "none", async () => {
    const used = () => readFileSync(join(root, "ssh-command"), "utf8");
    await fetchHead(checkout, "main");
    assert.equal(used(), SSH_KEEPALIVE_COMMAND);
    process.env.GIT_SSH_COMMAND = "ssh -i operator-key";
    try {
      await fetchHead(checkout, "main");
      assert.equal(used(), "ssh -i operator-key");
    } finally {
      delete process.env.GIT_SSH_COMMAND;
    }
    run(checkout, "config", "core.sshCommand", "ssh -F operator-config");
    await fetchHead(checkout, "main");
    assert.equal(used(), "");
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

test("Git older than 2.31 is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-old-git-"));
  writeFileSync(join(root, "git"), "#!/bin/sh\necho 'git version 2.30.9'\n", {
    mode: 0o755,
  });
  const path = process.env.PATH;
  process.env.PATH = `${root}:${path}`;
  try {
    assert.throws(assertSupportedGit, /requires Git 2\.31 or later/);
  } finally {
    process.env.PATH = path;
  }
  assert.doesNotThrow(assertSupportedGit);
});
