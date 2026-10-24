// Cleanup after cancel: it never asks, and one that keeps failing settles
// with a note naming what it left, so the Objective can run again.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cli,
  closedPort,
  configured,
  installation,
  refusal,
  seed,
  serve,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

test("a cleanup that keeps failing settles after five tries, naming what it left; a run before then is refused", async () => {
  const inst = installation();
  // GitHub can't be reached, so every cleanup attempt fails.
  configured(inst, `http://127.0.0.1:${await closedPort()}`, {
    FACTORY_BACKOFF_MS: "300",
  });
  seed(inst, 13);
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  assert.equal(cli(inst, "cancel", "13").code, 0);
  const early = cli(inst, "run", "13");
  assert.equal(early.code, 1);
  assert.equal(refusal(early), "cleanup_running");
  assert.match(early.err, /factory reset 13/);
  await until(
    () => stateOf(inst, 13).done["cancel:cleanup"] !== undefined,
    "cleanup settled",
    20_000,
  );
  const state = stateOf(inst, 13);
  const left = state.done["cancel:cleanup"];
  assert.equal(left.failures, 5);
  assert.match(left.left, /Factory's open PRs for #13/);
  assert.match(left.left, /closing issue #13/);
  assert.equal(state.retries["cancel:cleanup"], undefined);
  const [row] = status(inst).objectives;
  assert.equal(row.cleanupLeft, left.left);
  await stopped(service);
});
