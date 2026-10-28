// Crash tests kill the real service with SIGKILL at named crash points and
// check that a restart finishes the work exactly once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  cli,
  closedPort,
  configured,
  exited,
  githubOrigin,
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
    const holdOrDeath = await Promise.race([
      crashing.exit.then(() => "died"),
      until(() => stateOf(inst, 11).holds.length, "hold")
        .then(() => "held")
        .catch(() => "no hold"),
    ]);
    if (holdOrDeath === "held") cli(inst, "cancel", "11");
    // The service must kill itself at the point. The point can come well
    // after the last save the test could see (a slow runner took seconds
    // past the cleanup save, #2145), so wait for that death itself, bounded:
    // past the bound the point was never reached, and the wait kills the
    // service and fails with what it wrote.
    const death = await exited(
      crashing,
      `the service set to crash at ${point} (never reached?)`,
    );
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);

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
    const ids = state.appliedRequests.map((applied) => applied.id);
    assert.equal(new Set(ids).size, ids.length, "a request applied twice");
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

// The one-installation record (holder.ts) at each of its pushes: a crash
// leaves the record as the push left it, the same installation restarted
// with the same flags serves on, and a clean stop then frees the repository.
const HOLDER_POINTS = ["take", "takeover", "release"].flatMap((push) => [
  `holder:${push}:before`,
  `holder:${push}:after`,
]);

for (const point of HOLDER_POINTS) {
  test(`crash at ${point}, restart, the repository has one holder`, async () => {
    const api = `http://127.0.0.1:${await closedPort()}`;
    const first = installation();
    configured(first, api);
    // A second installation of the same repository, on the same origin.
    const second = installation();
    const bare = join(first.root, "origin.git");
    mkdirSync(second.root, { recursive: true });
    const git = (...args) => {
      const result = spawnSync("git", args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("clone", "--quiet", bare, join(second.root, "checkout"));
    githubOrigin(join(second.root, "checkout"), bare);
    configured(second, api);
    const record = () =>
      git(
        "--git-dir",
        bare,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/factory/holder",
      );
    const holder = () =>
      JSON.parse(git("--git-dir", bare, "log", "-1", "--format=%B", record()))
        .installation;
    // A service serves once its run has written service.json, which comes
    // after it holds the record (host.ts: holderFor, then the run). A stop
    // before that, while the record is still being taken, keeps the record.
    const serving = (service) => {
      try {
        const path = join(actor.root, "service.json");
        return JSON.parse(readFileSync(path, "utf8")).pid === service.child.pid;
      } catch {
        return false;
      }
    };
    // Waited for by the event, never a fixed delay: on a slow runner the
    // record's Git pushes take seconds (#2145).
    const served = async (service, what) => {
      const ended = () =>
        service.child.exitCode !== null || service.child.signalCode !== null;
      await until(() => ended() || serving(service), what, 30_000);
      assert.ok(!ended(), `${what}: it exited first\n${service.stderr()}`);
    };

    const takeover = point.startsWith("holder:takeover");
    const actor = takeover ? second : first;
    const flags = takeover ? ["--take-over"] : [];
    let firstId;
    if (takeover) {
      // The first installation holds and dies, which keeps its record.
      const holding = serve(first);
      await until(() => record(), "the first installation takes it");
      firstId = holder();
      holding.child.kill("SIGKILL");
      await exited(holding, "the first installation");
    }
    const crashing = serve(actor, point, [], flags);
    if (point.startsWith("holder:release")) {
      // The release push comes at a clean stop of a running service.
      await served(crashing, "the installation serves");
      crashing.child.kill("SIGTERM");
    }
    const death = await exited(crashing, point);
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);

    // The same installation restarted with the same flags serves on.
    const restarted = serve(actor, undefined, [], flags);
    await served(restarted, "the restart serves");
    assert.ok(record(), "the restart holds the repository");
    if (takeover) assert.notEqual(holder(), firstId, "the take-over holds");
    assert.equal((await stopped(restarted)).code, 0);
    assert.equal(record(), "", "a clean stop frees the repository");
  });
}
