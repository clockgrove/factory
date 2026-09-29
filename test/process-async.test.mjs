import assert from "node:assert/strict";
import test from "node:test";
import {
  commandAsync,
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
