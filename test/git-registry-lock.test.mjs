import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { registryLockDirectory, withRegistryFiles } from "../dist/process.js";

const processUrl = new URL("../dist/process.js", import.meta.url).href;

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
