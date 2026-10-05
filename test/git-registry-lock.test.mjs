import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registryLockDirectory, withRegistryFiles } from "../dist/process.js";
import { sweepValidationWorktrees } from "../dist/validation.js";

const processUrl = new URL("../dist/process.js", import.meta.url).href;
const validationUrl = new URL("../dist/validation.js", import.meta.url).href;

/** Another controller process: holds the lock in `mode` until told to let go. */
async function holder(key, mode) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { withRegistryFiles } from ${JSON.stringify(processUrl)};
       await withRegistryFiles(${JSON.stringify(key)}, ${JSON.stringify(mode)}, undefined, async () => {
         process.stdout.write("held\\n");
         await new Promise((resolve) => process.stdin.once("data", resolve));
       });
       process.exit(0);`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  child.stdout.setEncoding("utf8");
  let output = "";
  const seen = (line) =>
    new Promise((resolve) => {
      const check = () => output.includes(line) && resolve();
      child.stdout.on("data", (part) => {
        output += part;
        check();
      });
      check();
    });
  await seen("held");
  return {
    release: async () => {
      child.stdin.write("go\n");
      await once(child, "exit");
    },
    kill: async () => {
      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}

/** Whether this process's command ran within `ms` while the other held the lock. */
async function ranWithin(key, mode, ms) {
  let ran = false;
  const command = withRegistryFiles(key, mode, undefined, async () => {
    ran = true;
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { ran, command };
}

test("the worktree registry lock holds across processes: exclusive excludes the other, shared readers share", async () => {
  const key = `/registry-${process.pid}-${Date.now()}`;

  // Another process changes the registry: this process neither reads nor changes it.
  let other = await holder(key, "exclusive");
  const reader = await ranWithin(key, "shared", 200);
  const changer = await ranWithin(key, "exclusive", 200);
  assert.equal(reader.ran, false);
  assert.equal(changer.ran, false);
  await other.release();
  await Promise.all([reader.command, changer.command]);

  // Another process reads the registry: this process reads too, but does not change it.
  other = await holder(key, "shared");
  assert.equal((await ranWithin(key, "shared", 200)).ran, true);
  const writer = await ranWithin(key, "exclusive", 200);
  assert.equal(writer.ran, false);
  await other.release();
  await writer.command;

  // A holder that crashed leaves a stale file, which no longer excludes anyone.
  other = await holder(key, "exclusive");
  await other.kill();
  await withRegistryFiles(key, "exclusive", undefined, async () => undefined);
});

/** Another process holding the lock directory's guard until it exits. */
async function guardHolder(guard) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { mkdirSync } from "node:fs";
       import { dirname } from "node:path";
       import { takeGuard } from ${JSON.stringify(processUrl)};
       mkdirSync(dirname(${JSON.stringify(guard)}), { recursive: true });
       takeGuard(${JSON.stringify(guard)});
       process.stdout.write("held\\n");
       setInterval(() => undefined, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  child.stdout.setEncoding("utf8");
  await new Promise((resolve) => {
    let output = "";
    child.stdout.on("data", (part) => {
      output += part;
      if (output.includes("held")) resolve();
    });
  });
  return child;
}

test("a guard left by a process killed inside its window is reclaimed; a live holder keeps it", async () => {
  const key = `/registry-guard-${process.pid}-${Date.now()}`;
  const directory = registryLockDirectory(key);
  const guard = join(directory, ".guard");

  const dead = await guardHolder(guard);
  dead.kill("SIGKILL");
  await once(dead, "exit");
  assert.equal(existsSync(guard), true);
  let ran = false;
  await withRegistryFiles(key, "exclusive", undefined, async () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.equal(existsSync(guard), false);
  // The dead holder's guard became its tombstone, which stays.
  const tombstones = readdirSync(directory).filter((name) =>
    name.startsWith(".guard.dead-"),
  );
  assert.equal(tombstones.length, 1);
  assert.equal(
    JSON.parse(readFileSync(join(directory, tombstones[0], "holder"))).pid,
    dead.pid,
  );

  const live = await guardHolder(guard);
  try {
    await assert.rejects(
      withRegistryFiles(key, "shared", undefined, async () => undefined),
      /held by process/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(guard, "holder"), "utf8")).pid,
      live.pid,
    );
  } finally {
    live.kill("SIGKILL");
    await once(live, "exit");
  }
});

/** A checkout with one commit, and Factory's state directory beside it. */
async function withCheckout(body) {
  const root = mkdtempSync(join(tmpdir(), "factory-sweep-"));
  try {
    const checkout = join(root, "checkout");
    const git = (...args) =>
      execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "--quiet", checkout]);
    git(
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Base",
    );
    await body({ root, checkout, state: join(root, "state"), git });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("controllers sweeping at the same moment unregister each stale worktree once (#822)", async () =>
  withCheckout(async ({ root, checkout, state, git }) => {
    // Registrations whose directory is gone, as a failed removal leaves them.
    for (let index = 0; index < 24; index++) {
      const worktree = join(
        state,
        "objectives",
        "9",
        "validation",
        `item-${index}`,
        "worktree",
      );
      git("worktree", "add", "--quiet", "--detach", worktree, "HEAD");
      rmSync(worktree, { recursive: true });
    }
    assert.match(git("worktree", "list", "--porcelain"), /^prunable/m);

    // Four controllers, each owning another Objective, start their sweep together.
    const go = join(root, "go");
    const controllers = [1, 2, 3, 4].map((objective) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { existsSync } from "node:fs";
           import { sweepValidationWorktrees } from ${JSON.stringify(validationUrl)};
           process.stdout.write("ready\\n");
           while (!existsSync(${JSON.stringify(go)}))
             await new Promise((resolve) => setTimeout(resolve, 1));
           await sweepValidationWorktrees(
             ${JSON.stringify(checkout)},
             ${JSON.stringify(join(state, "objectives", String(objective)))},
             ${JSON.stringify(state)},
           );
           process.exit(0);`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      return { child, exit: once(child, "exit") };
    });
    await Promise.all(
      controllers.map(({ child }) => once(child.stdout, "data")),
    );
    writeFileSync(go, "");
    const codes = await Promise.all(
      controllers.map(async ({ exit }) => (await exit)[0]),
    );

    assert.deepEqual(codes, [0, 0, 0, 0]);
    assert.doesNotMatch(git("worktree", "list", "--porcelain"), /^prunable/m);
  }));

test("a run's sweep removes validation worktrees left directly under the state root, and keeps another Objective's (#823)", async () =>
  withCheckout(async ({ checkout, state, git }) => {
    const add = (...path) => {
      const worktree = join(state, ...path, "worktree");
      git("worktree", "add", "--quiet", "--detach", worktree, "HEAD");
      return worktree;
    };
    // Where a build before per-Objective directories kept them.
    const left = [
      add("validation", "item-1"),
      add("environment-preflight", "item-1"),
      add("final-validation"),
    ];
    const own = add("objectives", "3", "validation", "item-1");
    const other = add("objectives", "7", "validation", "item-1");

    await sweepValidationWorktrees(
      checkout,
      join(state, "objectives", "3"),
      state,
    );

    const registered = git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpathSync(line.slice("worktree ".length)));
    assert.deepEqual(
      registered,
      [checkout, other].map((path) => realpathSync(path)),
    );
    for (const worktree of [...left, own])
      assert.equal(existsSync(worktree), false);
  }));
