import assert from "node:assert/strict";
import test from "node:test";
import {
  commandAsync,
  lingeringDescendants,
  processGroupExists,
  subprocessAsync,
  withProcessCancellation,
} from "../dist/process.js";

test("async subprocess leaves the event loop responsive", async () => {
  let responsive = false;
  const timer = setTimeout(() => {
    responsive = true;
  }, 10);
  const output = await commandAsync(process.execPath, [
    "-e",
    "setTimeout(() => console.log('finished'), 80)",
  ]);
  clearTimeout(timer);
  assert.equal(output, "finished");
  assert.equal(responsive, true);
});

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

test("already cancelled scope cannot launch a command", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withProcessCancellation(controller.signal, () =>
      commandAsync("sh", ["-c", "exit 0"]),
    ),
  );
});

test("an exited command's lingering descendants are waited for, then stopped", async () => {
  const saved = lingeringDescendants.graceMilliseconds;
  lingeringDescendants.graceMilliseconds = 300;
  const groups = [];
  try {
    await withProcessCancellation(
      undefined,
      async () => {
        // Finishes within the grace period: waited for.
        const short = await subprocessAsync("sh", [
          "-c",
          "(sleep 0.1; true) >/dev/null 2>&1 & exit 3",
        ]);
        assert.equal(short.status, 3);
        // Still running after it: stopped; the command's own result stands.
        // The leftover holds the output pipes open, so the grace period
        // starts at the command's exit, not when its output closes.
        for (const leftover of ["sleep 30 >/dev/null 2>&1 &", "sleep 30 &"]) {
          const started = Date.now();
          const long = await subprocessAsync("sh", [
            "-c",
            `${leftover} echo exited`,
          ]);
          assert.equal(long.status, 0);
          assert.equal(long.stdout.trim(), "exited");
          assert.equal(long.stoppedLeftovers, 1);
          assert.ok(Date.now() - started < 5_000, leftover);
        }
      },
      (owned, settled) => groups.push({ owned, settled }),
    );
  } finally {
    lingeringDescendants.graceMilliseconds = saved;
  }
  assert.equal(groups.filter(({ settled }) => settled).length, 3);
  for (const { owned } of groups)
    assert.equal(processGroupExists(owned.pid), false);
});
