import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { withRegistryFiles } from "../dist/process.js";

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
