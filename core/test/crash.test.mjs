// Crash tests kill the real service with SIGKILL at named crash points and
// check that a restart finishes the work exactly once.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  cli,
  installation,
  seed,
  serve,
  stateOf,
  stopped,
  until,
} from "./helpers.mjs";

// Every crash point the hold → cancel path passes. A crash at each one, then
// a clean restart, must end cancelled and cleaned up, with the request
// applied once and no stray files.
const CRASH_POINTS = [
  "serve:loaded",
  "state:before-rename",
  "state:saved",
  "state:saved#2",
  "state:saved#3",
  "state:saved#4",
  "state:saved#5",
  "engine:check:started",
  "engine:check:before-apply",
  "engine:check:applied",
  "requests:applied",
  "engine:cancel:cleanup:started",
  "engine:cancel:cleanup:before-apply",
  "engine:cancel:cleanup:applied",
];

for (const point of CRASH_POINTS) {
  test(`crash at ${point}, restart, finish once`, async () => {
    const inst = installation();
    seed(inst, 11);
    const crashing = serve(inst, point);
    // Drive the path: wait for the hold, then cancel. The crash can come at
    // any moment along the way.
    let killedByTest = false;
    const holdOrDeath = await Promise.race([
      crashing.exit.then(() => "died"),
      until(() => stateOf(inst, 11).holds.length, "hold")
        .then(() => "held")
        .catch(() => "no hold"),
    ]);
    if (holdOrDeath === "held") {
      cli(inst, "cancel", "11");
      await Promise.race([
        crashing.exit,
        until(
          () => stateOf(inst, 11).done["cancel:cleanup"] === true,
          "cleanup",
        )
          // The crash point may come just after the save the test sees.
          .then(() => new Promise((resolve) => setTimeout(resolve, 500)))
          .then(() => {
            if (crashing.child.exitCode !== null || crashing.child.signalCode)
              return;
            killedByTest = true;
            crashing.child.kill("SIGKILL");
          })
          .catch(() => {}),
      ]);
    }
    const death = await crashing.exit;
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);
    assert.equal(killedByTest, false, `${point} was never reached`);

    const service = serve(inst);
    if (stateOf(inst, 11).status !== "cancelled") {
      await until(
        () =>
          stateOf(inst, 11).holds.length ||
          stateOf(inst, 11).status === "cancelled",
        "hold after restart",
      );
      cli(inst, "cancel", "11");
    }
    await until(
      () => stateOf(inst, 11).done["cancel:cleanup"] === true,
      "cleanup after restart",
    );
    await stopped(service);

    const state = stateOf(inst, 11);
    assert.equal(state.status, "cancelled");
    assert.equal(
      new Set(state.appliedRequests).size,
      state.appliedRequests.length,
    );
    const leftovers = readdirSync(inst.objectives).filter(
      (n) => n !== "11.json" && n !== "finished",
    );
    assert.deepEqual(leftovers, [], "temporary files left after restart");
    assert.ok(
      existsSync(inst.requests) &&
        readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
      "requests left unapplied",
    );
  });
}
