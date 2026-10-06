import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "../dist/execution/local.js";
import { killGroup } from "../dist/execution/worker-process.js";
import {
  linuxProcessIdentity,
  processGroupExists,
  subprocessAsync,
  withProcessCancellation,
} from "../dist/process.js";

test("cancellation stops an owned shell and its process group", async () => {
  const controller = new AbortController();
  let pid;
  const result = withProcessCancellation(controller.signal, () =>
    subprocessAsync(
      "sh",
      ["-c", "echo $$; sleep 120 & wait"],
      {},
      undefined,
      (stream, chunk) => {
        if (stream === "stdout") {
          pid = Number(chunk.toString().trim());
          controller.abort();
        }
      },
    ),
  );
  await assert.rejects(result, /cancelled after verified cessation/);
  assert.ok(pid > 0);
  assert.equal(processGroupExists(pid), false);
});

test("collection settles an exited owned group before removing scratch", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-owned-exit-"));
  const harnessRoot = join(root, "harness");
  mkdirSync(harnessRoot);
  const requestPath = join(harnessRoot, "exited.request.json");
  const scratch = `${requestPath}.codex-home`;
  mkdirSync(scratch);
  // A real shell exits with no result, leaving a child that ignores SIGTERM.
  // No provider, SDK or scripted harness response is involved.
  const child = spawn(
    "sh",
    ["-c", 'trap "" TERM; sleep 120 & echo ready; read -r hold; exit 23'],
    { detached: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  try {
    const identity = linuxProcessIdentity(child.pid);
    assert.ok(identity);
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.stdin.end("\n");
    assert.equal((await exited)[0], 23);
    assert.equal(processGroupExists(child.pid), true);
    const harness = new CodexHarness(join(root, "credentials"), "off", {
      model: "unused",
      reasoningEffort: "low",
    });
    await assert.rejects(
      harness.collect({
        identity: "exited",
        data: {
          pid: child.pid,
          startTime: identity.startTime,
          requestPath,
          resultPath: join(harnessRoot, "exited.result.json"),
          logPath: join(harnessRoot, "exited.log"),
        },
      }),
      /worker exited without a durable result/,
    );
    assert.equal(processGroupExists(child.pid), false);
    assert.equal(existsSync(scratch), false);
  } finally {
    if (processGroupExists(child.pid))
      await killGroup(child.pid, "integration shell");
    rmSync(root, { recursive: true, force: true });
  }
});
