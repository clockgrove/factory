// The real service, as a real process, on real files: the hold it asks
// when a step can't run, and its deaths and restarts, with or without a
// crash point a test caused.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { recordOf, stalled } from "./helpers/service.mjs";
import {
  cli,
  comment,
  exited,
  installation,
  refusal,
  seed,
  serve,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

test("a step that can't run holds with answers that work", async () => {
  const inst = installation();
  seed(inst, 7);
  let service = serve(inst);
  await until(() => status(inst).objectives[0]?.holds.length, "hold");
  const [row] = status(inst).objectives;
  assert.equal(row.status, "holding");
  assert.deepEqual(
    row.holds[0].options.map((option) => option.answer),
    ["retry", "cancel"],
  );

  const firstHold = row.holds[0].id;
  const unnamed = cli(inst, "answer", "7", "retry");
  assert.equal(unnamed.code, 2, "the CLI names it");
  assert.equal(refusal(unnamed), "usage");
  const wrong = cli(inst, "answer", "7", "approve", "--question", firstHold);
  assert.equal(wrong.code, 1);
  assert.equal(refusal(wrong), "invalid_answer");
  assert.match(wrong.err, /Answers: retry, cancel/);
  assert.equal(status(inst).objectives[0].status, "holding");
  // Not shown on GitHub (no configuration here): a comment must name it.
  assert.match(
    await comment(inst, 7, "retry", new Date().toISOString()),
    /doesn't show the short form/,
  );

  // GitHub showed its comment in the short form at `shown`, by GitHub's
  // clock, 5 minutes ahead of the host's; then another question's comment,
  // since closed. The sync saves these GitHub times (github-sync `ask`).
  await stopped(service);
  // A clean stop says so, so the next start counts no death.
  assert.equal(recordOf(inst).stopped, true, "a clean stop");
  const shown = Date.now() + 5 * 60_000;
  const at = (ms) => new Date(shown + ms).toISOString();
  const showAs = (lastShownAt) => {
    const state = stateOf(inst, 7);
    state.holds[0].shownAt = at(0);
    state.holds[0].shortForm = true;
    state.lastShownAt = lastShownAt;
    writeFileSync(join(inst.objectives, "7.json"), JSON.stringify(state));
  };
  showAs(at(10_000));
  service = serve(inst);
  await until(() => status(inst).service === "running", "restart");
  assert.match(
    await comment(inst, 7, "retry", at(20_000)),
    /another question was shown after the open one/,
  );
  await stopped(service);
  showAs(at(0));
  service = serve(inst);
  await until(() => status(inst).service === "running", "restart");
  // Written after the host asked, but before GitHub showed it: refused.
  assert.match(
    await comment(inst, 7, "retry", at(-1000)),
    /written before the open question was shown/,
  );
  // The one open question, shown before the comment: the short form works.
  assert.equal(await comment(inst, 7, "retry", at(1000)), "ok");
  await until(
    () =>
      status(inst).objectives[0].holds[0]?.id !== undefined &&
      status(inst).objectives[0].holds[0].id !== firstHold,
    "a new hold after retry",
  );
  // A comment that names its question applies whatever its time: the id
  // names one asking (here a host clock 5 minutes ahead of GitHub's).
  const again = status(inst).objectives[0].holds[0].id;
  assert.equal(
    await comment(
      inst,
      7,
      "retry",
      new Date(Date.now() - 5 * 60_000).toISOString(),
      again,
    ),
    "ok",
  );
  await until(
    () =>
      status(inst).objectives[0].holds[0]?.id !== undefined &&
      status(inst).objectives[0].holds[0].id !== again,
    "a new hold after the bound retry",
  );

  assert.equal(cli(inst, "cancel", "7").code, 0);
  await until(
    () => stateOf(inst, 7).done["cancel:cleanup"] === true,
    "cleanup after cancel",
  );
  assert.equal(stateOf(inst, 7).status, "cancelled");
  assert.deepEqual(stateOf(inst, 7).holds, []);
  await stopped(service);
  assert.deepEqual(recordOf(inst).deaths, [], "two clean restarts, no deaths");
});

test("three deaths while two Objectives run hold neither; the restart backs off", async () => {
  const inst = installation();
  // GitHub never answers, so both checks are running whenever the service dies.
  await stalled(inst);
  seed(inst, 51);
  seed(inst, 52);
  const runId = () => {
    try {
      return JSON.parse(readFileSync(join(inst.root, "service.json"), "utf8"))
        .runId;
    } catch {
      return undefined;
    }
  };
  const runningIn = (run) =>
    [51, 52].every((issue) => stateOf(inst, issue).attempts.check?.run === run);
  // The service holds its lock before it writes its record, so each start
  // waits for its own record: the last run's would show one death too few.
  let last;
  const started = async () => {
    await until(
      () => status(inst).service === "running" && runId() !== last,
      "service",
    );
    last = runId();
    return last;
  };
  for (let i = 0; i < 3; i++) {
    const service = serve(inst);
    const run = await started();
    await until(() => runningIn(run), "both checks running");
    service.child.kill("SIGKILL");
    await service.exit;
  }
  const service = serve(inst);
  const run = await started();
  const { crashLoop } = status(inst);
  assert.equal(crashLoop.crashes, 3);
  assert.ok(Date.parse(crashLoop.resumeAt) > Date.now() - 60_000);
  await until(() => runningIn(run), "both checks resumed");
  for (const issue of [51, 52]) {
    const state = stateOf(inst, issue);
    assert.deepEqual(state.holds, [], `#${issue} holds`);
    assert.deepEqual(state.retries, {}, `#${issue} counts an error`);
  }
  await stopped(service);
});

test("the one step running at three deaths, with progress between, holds", async () => {
  const inst = installation();
  const at = new Date().toISOString();
  // Interrupted at two deaths already, the second after progress; the
  // dead run's progress is in the saved state only: it died before its
  // heartbeat counted the finished step.
  seed(inst, 61, "checking", {
    attempts: { check: { startedAt: at, run: "dead", interrupted: 2 } },
    finishedRun: "dead",
  });
  const deaths = [1, 2].map(() => ({ at, lived: null }));
  writeFileSync(
    join(inst.root, "service.json"),
    JSON.stringify({
      pid: 1,
      runId: "dead",
      at,
      startedAt: at,
      finished: 0,
      deaths,
      setAside: {},
    }),
  );
  const service = serve(inst);
  await until(() => stateOf(inst, 61).holds.length, "hold");
  const [hold] = stateOf(inst, 61).holds;
  assert.match(
    hold.question,
    /^The service died 3 times in a row while step check ran/,
  );
  assert.deepEqual(
    hold.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  assert.deepEqual(
    stateOf(inst, 61).attempts,
    {},
    "the evidence goes with the attempt",
  );
  await stopped(service);
});

/**
 * Three deaths of the service while #`issue`'s check runs (GitHub never
 * answers): each `die(running)` starts a service that dies, `running`
 * saying when the check runs in it. Each dead run also finished a step,
 * as its saved state says.
 */
async function threeDeathsWithProgress(inst, issue, die) {
  await stalled(inst);
  seed(inst, issue);
  for (let i = 0; i < 3; i++) {
    const last = recordOf(inst).runId;
    const service = await die(() => {
      const { runId } = recordOf(inst);
      return (
        runId !== last && stateOf(inst, issue).attempts.check?.run === runId
      );
    });
    assert.equal((await exited(service, "the dead service")).signal, "SIGKILL");
    const state = stateOf(inst, issue);
    state.finishedRun = state.attempts.check.run;
    writeFileSync(
      join(inst.objectives, `${issue}.json`),
      JSON.stringify(state),
    );
  }
}

test("a step running at three deaths a test caused at a crash point, with progress between, runs on; they continue the streak", async () => {
  const inst = installation();
  await threeDeathsWithProgress(inst, 65, async () =>
    serve(inst, "engine:check:started"),
  );
  // Each death says where the test killed it, and the last run's point is
  // in the record now.
  const point = join(inst.root, "crash-point.json");
  assert.ok(existsSync(point));
  const service = serve(inst);
  await until(() => !existsSync(point), "the crash point recorded");
  const { runId, deaths } = recordOf(inst);
  assert.deepEqual(
    deaths.map((death) => death.crashPoint),
    Array(3).fill("engine:check:started"),
  );
  assert.equal(status(inst).crashLoop.crashes, 3, "a crash streak of three");
  await until(
    () => stateOf(inst, 65).attempts.check?.run === runId,
    "the check resumed",
  );
  const state = stateOf(inst, 65);
  assert.deepEqual(state.holds, []);
  assert.equal(state.attempts.check.interrupted, undefined, "no death counts");
  // The third run logged its crash loop, so its log ends with its death.
  const logs = join(inst.logs, "0");
  assert.ok(
    readdirSync(logs).some((name) =>
      /"outcome":"crashed","detectedBy":"[^"]+","crashPoint":"engine:check:started"/.test(
        readFileSync(join(logs, name), "utf8"),
      ),
    ),
    "the run-end names the crash point",
  );
  await stopped(service);
});

test("a step running at three deaths with no known cause, with progress between, holds", async () => {
  const inst = installation();
  await threeDeathsWithProgress(inst, 66, async (running) => {
    const service = serve(inst);
    await until(running, "the check running");
    service.child.kill("SIGKILL");
    return service;
  });
  // A crash point recorded for another run excuses none of these.
  writeFileSync(
    join(inst.root, "crash-point.json"),
    JSON.stringify({ run: "earlier", point: "engine:check:started" }),
  );
  const service = serve(inst);
  await until(() => stateOf(inst, 66).holds.length, "hold");
  assert.match(
    stateOf(inst, 66).holds[0].question,
    /^The service died 3 times in a row while step check ran/,
  );
  assert.deepEqual(
    recordOf(inst).deaths.map((death) => death.crashPoint),
    [undefined, undefined, undefined],
  );
  await stopped(service);
});

test("a death a test caused at a crash point leaves a step's count as it was; the next death with no known cause counts on from it", async () => {
  const inst = installation();
  await stalled(inst);
  const at = new Date().toISOString();
  // Interrupted at two deaths already; the run killed at a crash point
  // finished a step too, so a death with no known cause would make three.
  seed(inst, 67, "checking", {
    attempts: { check: { startedAt: at, run: "dead", interrupted: 2 } },
    finishedRun: "dead",
  });
  writeFileSync(
    join(inst.root, "service.json"),
    JSON.stringify({
      pid: 1,
      runId: "dead",
      at,
      startedAt: at,
      finished: 0,
      deaths: [],
      setAside: {},
    }),
  );
  writeFileSync(
    join(inst.root, "crash-point.json"),
    JSON.stringify({ run: "dead", point: "engine:check:started" }),
  );
  let service = serve(inst);
  await until(
    () => {
      const { runId } = recordOf(inst);
      return (
        runId !== "dead" && stateOf(inst, 67).attempts.check?.run === runId
      );
    },
    "the check resumed",
    30_000,
  );
  const { runId } = recordOf(inst);
  assert.deepEqual(stateOf(inst, 67).holds, []);
  assert.equal(
    stateOf(inst, 67).attempts.check.interrupted,
    2,
    "the count as it was",
  );
  // A death with no known cause, after progress: the third in a row.
  service.child.kill("SIGKILL");
  await exited(service, "the killed service");
  const state = stateOf(inst, 67);
  state.finishedRun = runId;
  writeFileSync(join(inst.objectives, "67.json"), JSON.stringify(state));
  service = serve(inst);
  await until(() => stateOf(inst, 67).holds.length, "hold", 30_000);
  assert.match(
    stateOf(inst, 67).holds[0].question,
    /^The service died 3 times in a row while step check ran/,
  );
  assert.deepEqual(
    recordOf(inst).deaths.map((death) => death.crashPoint),
    ["engine:check:started", undefined],
  );
  await stopped(service);
});

test("every step running at three deaths, with progress between, holds with its own question", async () => {
  const inst = installation();
  const at = new Date().toISOString();
  // A killer and an innocent long step, interrupted together every time.
  for (const issue of [63, 64])
    seed(inst, issue, "checking", {
      attempts: { check: { startedAt: at, run: "dead", interrupted: 2 } },
      finishedRun: "dead",
    });
  writeFileSync(
    join(inst.root, "service.json"),
    JSON.stringify({
      pid: 1,
      runId: "dead",
      at,
      startedAt: at,
      finished: 0,
      deaths: [1, 2].map(() => ({ at, lived: null })),
      setAside: {},
    }),
  );
  const service = serve(inst);
  await until(
    () => [63, 64].every((issue) => stateOf(inst, issue).holds.length),
    "both hold",
  );
  for (const issue of [63, 64]) {
    const [hold] = stateOf(inst, issue).holds;
    assert.match(hold.question, /while step check ran.*1 other step ran/s);
    assert.deepEqual(
      hold.options.map((option) => option.answer),
      ["retry", "cancel"],
    );
  }
  await stopped(service);
});
