// The real service, as a real process, on real files: the Objectives it
// takes from its queue, in what order and how many at once, one dequeued
// while it runs, and one finished.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stalled } from "./helpers/service.mjs";
import {
  cli,
  installation,
  offered,
  refusal,
  seed,
  serve,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

test("checks of newly queued Objectives run within the host's cap", async () => {
  const inst = installation();
  // GitHub never answers, so every check that starts stays running.
  await stalled(inst, {
    queue: { projectId: "PVT_none", pollSeconds: 5, maxActiveObjectives: 2 },
  });
  const issues = [81, 82, 83, 84, 85];
  for (const issue of issues) seed(inst, issue);
  const service = serve(inst);
  const running = () =>
    issues.filter((issue) => stateOf(inst, issue).attempts.check).length;
  await until(() => running() === 2, "two checks running");
  // Many ticks later, still two.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(running(), 2);
  await stopped(service);
});

test("Objectives are taken in Project order: the order field ascending, a card without one last, ties by issue number", async () => {
  const inst = installation();
  // GitHub never answers, so the two checks the cap lets start stay
  // running, and show which two came first in queue order.
  await stalled(inst, {
    queue: { projectId: "PVT_none", pollSeconds: 5, maxActiveObjectives: 2 },
  });
  // #83 is first; #82 and #84 tie on the highest order, and #82 goes next,
  // ahead of #81, which has none. By issue number alone #81 and #82 would
  // start; with a card without an order first, #81 and #83; with ties to
  // the higher issue, #83 and #84.
  const orders = { 81: null, 82: 9, 83: 1, 84: 9 };
  for (const [issue, order] of Object.entries(orders))
    seed(inst, Number(issue), "checking", {
      modules: { github: { itemId: `PVTI_${issue}`, order } },
    });
  const service = serve(inst);
  const issues = Object.keys(orders).map(Number);
  const running = () =>
    issues.filter((issue) => stateOf(inst, issue).attempts.check);
  await until(() => running().length === 2, "two checks running");
  // Many ticks later, still the same two.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(running(), [82, 83]);
  await stopped(service);
});

test("an Objective dequeued during its check, before a re-run's cleanup began, or while that cleanup holds, is withdrawn and never plans", async () => {
  const inst = installation();
  // Saved by a dequeue while the check ran: the check is done now.
  seed(inst, 71, "planning", { done: { check: true }, withdrawing: true });
  // A finished Objective queued again, then dequeued before its re-run's
  // cleanup began: the cleanup never runs, and the earlier run's record stands.
  seed(inst, 72, "done", { done: { check: true, report: true } });
  mkdirSync(join(inst.objectives, "finished"), { recursive: true });
  writeFileSync(
    join(inst.objectives, "finished", "72.json"),
    readFileSync(join(inst.objectives, "72.json")),
  );
  seed(inst, 72, "checking", { kept: { rerun: true }, withdrawing: true });
  // A re-run's cleanup that held (GitHub refused the reopen), dequeued from
  // the "Needs you" Factory showed: withdrawn at once, never asked about.
  seed(inst, 73, "done", { done: { check: true, report: true } });
  writeFileSync(
    join(inst.objectives, "finished", "73.json"),
    readFileSync(join(inst.objectives, "73.json")),
  );
  const askedAt = new Date().toISOString();
  seed(inst, 73, "holding", {
    kept: { rerun: true },
    holds: [
      {
        id: `rerun:cleanup@${askedAt}`,
        step: "rerun:cleanup",
        question: "GitHub refused to reopen the issue.",
        options: offered("retry", "cancel"),
        askedAt,
      },
    ],
    withdrawing: true,
  });
  const service = serve(inst);
  const logs = (issue) =>
    existsSync(join(inst.logs, String(issue)))
      ? readdirSync(join(inst.logs, String(issue)))
          .map((name) =>
            readFileSync(join(inst.logs, String(issue), name), "utf8"),
          )
          .join("")
      : "";
  for (const issue of [71, 72, 73])
    await until(() => logs(issue).includes('"withdrawn"'), "the withdrawal");
  assert.ok(!existsSync(join(inst.objectives, "71.json")));
  assert.ok(!existsSync(join(inst.objectives, "finished", "71.json")));
  assert.ok(!logs(71).includes('"step":"plan"'), "nothing past the check");
  assert.ok(!existsSync(join(inst.objectives, "72.json")));
  assert.equal(
    JSON.parse(readFileSync(join(inst.objectives, "finished", "72.json")))
      .status,
    "done",
  );
  assert.ok(!logs(72).includes('"step":'), "no step ran");
  assert.ok(!existsSync(join(inst.objectives, "73.json")));
  assert.equal(
    JSON.parse(readFileSync(join(inst.objectives, "finished", "73.json")))
      .status,
    "done",
  );
  assert.ok(!logs(73).includes('"step":'), "no step ran");
  await stopped(service);
});

test("a finished Objective leaves the startup set, and can't be cancelled", async () => {
  const inst = installation();
  seed(inst, 13, "done");
  const first = serve(inst);
  const moved = join(inst.objectives, "finished", "13.json");
  await until(() => existsSync(moved), "the move to finished/");
  assert.ok(!existsSync(join(inst.objectives, "13.json")));
  await stopped(first);
  // Startup reads no history: a broken finished file is never read.
  writeFileSync(join(inst.objectives, "finished", "12.json"), "{ not json");
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const result = cli(inst, "cancel", "13");
  assert.equal(result.code, 1);
  assert.equal(refusal(result), "objective_finished");
  assert.match(result.err, /already finished \(done\)/);
  assert.equal(refusal(cli(inst, "pause", "13")), "objective_finished");
  // Bound to a question, it is still finished, not a stale question.
  assert.equal(
    refusal(cli(inst, "answer", "13", "retry", "--question", "old")),
    "objective_finished",
  );
  assert.equal(refusal(cli(inst, "cancel", "99")), "no_factory_state");
  assert.equal(stateOf(inst, 13).status, "done");
  const record = JSON.parse(
    readFileSync(join(inst.root, "service.json"), "utf8"),
  );
  assert.deepEqual(record.setAside, {});
  await stopped(service);
});
