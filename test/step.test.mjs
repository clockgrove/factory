import assert from "node:assert/strict";
import test from "node:test";
import { preparationStatusDocument } from "../dist/diagnostics.js";
import {
  assertRepeats,
  assertWait,
  attachFault,
  faultOf,
  StepFault,
} from "../dist/fault.js";
import { renderStatusText, summarizeStatus } from "../dist/status-summary.js";
import {
  backoffDelay,
  clearRepeats,
  clearWait,
  outageOf,
  repeatKey,
  setStepClock,
  setWait,
  step,
  waitOf,
} from "../dist/step.js";

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A clock that never waits: sleep advances time and records the delay. */
function manualClock(start = T0) {
  const clock = {
    time: start,
    sleeps: [],
    now: () => clock.time,
    sleep: async (milliseconds, signal) => {
      signal?.throwIfAborted();
      clock.sleeps.push(milliseconds);
      clock.time += milliseconds;
    },
  };
  return clock;
}

const factoryState = () => ({
  schemaVersion: 6,
  work: {
    one: { status: "running", attempt: "a1" },
    two: { status: "running", attempt: "b1" },
  },
});

/** Every save writes a JSON copy, as the state file would. */
function harness(state = factoryState(), clock = manualClock()) {
  const disk = [];
  return {
    state,
    clock,
    disk,
    options: {
      clock,
      save: () => disk.push(JSON.parse(JSON.stringify(state))),
    },
  };
}

const fail = (fault) => attachFault(new Error(fault.detail ?? "failed"), fault);
const transient = (detail = "fetch failed", extra = {}) =>
  fail({ kind: "transient", detail, outcomeUnknown: false, ...extra });
const lost = (detail = "response lost") =>
  fail({ kind: "transient", detail, outcomeUnknown: true });

/** fn that throws the given errors in order, then returns "done". */
function scripted(...errors) {
  const calls = { count: 0 };
  const fn = async () => {
    const error = errors[calls.count++];
    if (error) throw error;
    return "done";
  };
  return Object.assign(fn, { calls });
}

const item = { item: "one", attempt: "a1" };
const KEY = "one/a1/publish";

test("repeat keys name the item attempt or the Objective step", () => {
  assert.equal(repeatKey(item, "publish"), KEY);
  assert.equal(repeatKey("objective", "plan"), "objective/plan");
  assert.throws(() => repeatKey(item, "Publish"), /Invalid step name/);
  assert.throws(
    () => repeatKey({ item: "one", attempt: "a/1" }, "publish"),
    /Invalid step scope/,
  );
});

test("backoff doubles from one second to a five-minute cap", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 8, 9, 10, 50].map(backoffDelay),
    [1, 2, 4, 8, 128, 256, 300, 300].map((seconds) => seconds * SECOND),
  );
});

test("success on the first call writes nothing", async () => {
  const h = harness();
  assert.equal(
    await step(
      h.state,
      { scope: item, name: "publish" },
      async () => 7,
      h.options,
    ),
    7,
  );
  assert.equal(h.disk.length, 0);
  assert.equal(h.state.repeats, undefined);
});

test("transient faults repeat with persisted backoff; success deletes the record", async () => {
  const h = harness();
  const fn = scripted(...Array.from({ length: 11 }, () => transient()));
  assert.equal(
    await step(h.state, { scope: item, name: "publish" }, fn, h.options),
    "done",
  );
  assert.equal(fn.calls.count, 12);
  assert.deepEqual(
    h.clock.sleeps,
    [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300].map((s) => s * SECOND),
  );
  // Each fault was saved before its backoff, with the next time to run.
  const third = h.disk[2].repeats[KEY];
  assert.deepEqual(third, {
    since: new Date(T0).toISOString(),
    count: 3,
    last: { kind: "transient", detail: "fetch failed", outcomeUnknown: false },
    nextAt: new Date(T0 + 3 * SECOND + 4 * SECOND).toISOString(),
  });
  for (const saved of h.disk)
    assertRepeats(saved.repeats, "repeats", new Set(["one", "two"]));
  assert.equal(h.state.repeats, undefined);
  assert.equal(h.state.work.one.wait, undefined);
});

test("a restart mid-backoff resumes from the persisted record", async () => {
  const h = harness();
  const sleep = h.clock.sleep;
  h.clock.sleep = async (milliseconds) => {
    if (h.clock.sleeps.length) throw new Error("process killed");
    await sleep(milliseconds);
  };
  await assert.rejects(
    step(
      h.state,
      { scope: item, name: "publish" },
      scripted(transient(), transient()),
      h.options,
    ),
    /process killed/,
  );
  const saved = h.disk.at(-1);
  assert.equal(saved.repeats[KEY].count, 2);
  assert.equal(
    saved.repeats[KEY].nextAt,
    new Date(T0 + 1 * SECOND + 2 * SECOND).toISOString(),
  );

  // A new process starts from the file 500 ms into the 2 s backoff.
  const clock = manualClock(T0 + 1 * SECOND + 500);
  const resumed = harness(saved, clock);
  const fn = scripted(transient());
  assert.equal(
    await step(
      resumed.state,
      { scope: item, name: "publish" },
      fn,
      resumed.options,
    ),
    "done",
  );
  // It waits out the remainder, then the third fault continues the same run.
  assert.deepEqual(clock.sleeps, [1500, 4 * SECOND]);
  assert.equal(resumed.disk[0].repeats[KEY].count, 3);
  assert.equal(resumed.disk[0].repeats[KEY].since, new Date(T0).toISOString());
  assert.equal(resumed.state.repeats, undefined);
});

test("progress inside the step resets since, so long polls never look like an outage", async () => {
  const h = harness();
  let calls = 0;
  const fn = async (ctx) => {
    calls++;
    if (calls <= 8) throw transient();
    if (calls === 9) {
      ctx.progress();
      throw transient("poll hiccup");
    }
    return "done";
  };
  const seen = [];
  h.options.save = () => {
    seen.push(
      structuredClone({
        repeats: h.state.repeats,
        wait: h.state.work.one.wait,
      }),
    );
  };
  await step(h.state, { scope: item, name: "await-ci" }, fn, h.options);
  // Eight faults over two minutes became an outage...
  const before = seen[7];
  assert.equal(before.repeats["one/a1/await-ci"].count, 8);
  assert.deepEqual(before.wait, {
    kind: "outage",
    detail: "await-ci: fetch failed",
  });
  // ...progress deleted the record and its wait...
  assert.deepEqual(seen[8], { repeats: undefined, wait: undefined });
  // ...and the next fault starts a new run with a one-second backoff.
  assert.equal(seen[9].repeats["one/a1/await-ci"].count, 1);
  assert.equal(
    seen[9].repeats["one/a1/await-ci"].since,
    new Date(h.clock.time - SECOND).toISOString(),
  );
  assert.equal(seen[9].wait, undefined);
  assert.equal(h.clock.sleeps.at(-1), SECOND);
});

test("an outage wait appears after a minute and clears on success", async () => {
  const h = harness();
  const waits = [];
  const save = h.options.save;
  h.options.save = () => {
    save();
    waits.push(h.state.work.one.wait);
  };
  await step(
    h.state,
    { scope: item, name: "merge" },
    scripted(...Array.from({ length: 7 }, () => transient("502 Bad Gateway"))),
    h.options,
  );
  // Faults at 0, 1, 3, 7, 15, 31 s carry no wait; the one at 63 s does.
  assert.deepEqual(waits.slice(0, 6), Array(6).fill(undefined));
  assert.deepEqual(waits[6], {
    kind: "outage",
    detail: "merge: 502 Bad Gateway",
  });
  assert.equal(h.state.work.one.wait, undefined);
});

test("a step leaves waits it did not write in place", async () => {
  const h = harness();
  setWait(h.state, { item: "one" }, { kind: "ci", detail: "checks pending" });
  await step(
    h.state,
    { scope: item, name: "merge" },
    scripted(transient()),
    h.options,
  );
  assert.deepEqual(waitOf(h.state, { item: "one" }), {
    kind: "ci",
    detail: "checks pending",
  });
});

test("retryAt is honoured instead of the backoff", async () => {
  const h = harness();
  const retryAt = new Date(T0 + 90 * SECOND).toISOString();
  await step(
    h.state,
    { scope: "objective", name: "plan", paid: true },
    async (ctx) => {
      if (h.clock.sleeps.length < 5)
        await ctx.paid(async () => {
          throw transient("usage limit", {
            retryAt: new Date(h.clock.time + 90 * SECOND).toISOString(),
            outcomeUnknown: true,
          });
        });
      return "planned";
    },
    { ...h.options, save: () => h.disk.push(structuredClone(h.state)) },
  );
  assert.deepEqual(h.clock.sleeps, Array(5).fill(90 * SECOND));
  assert.equal(h.disk[0].repeats["objective/plan"].nextAt, retryAt);
  // A limit with a reset time never counts toward the paid bound.
  assert.equal(h.disk.at(-2).repeats["objective/plan"].paid, undefined);
  // A retryAt already in the past falls back to the backoff.
  const late = harness();
  await step(
    late.state,
    { scope: item, name: "publish" },
    scripted(
      transient("limit", { retryAt: new Date(T0 - SECOND).toISOString() }),
    ),
    late.options,
  );
  assert.deepEqual(late.clock.sleeps, [SECOND]);
});

test("a distant retryAt is slept in bounded chunks", async () => {
  const h = harness();
  await step(
    h.state,
    { scope: item, name: "publish" },
    scripted(
      transient("limit", { retryAt: new Date(T0 + 5 * HOUR).toISOString() }),
    ),
    h.options,
  );
  assert.deepEqual(h.clock.sleeps, Array(5).fill(HOUR));
});

test("a paid step turns the fourth unknown-outcome fault of its paid call into a decision", async () => {
  const h = harness();
  let calls = 0;
  const error = await step(
    h.state,
    { scope: item, name: "review", paid: true },
    async (ctx) => {
      calls++;
      ctx.progress();
      // Free calls inside the step fault without counting...
      if (calls % 2 === 1) throw lost("GitHub response lost");
      // ...as do paid faults with a known outcome.
      if (calls === 2)
        await ctx.paid(async () => {
          throw transient("model 503");
        });
      return ctx.paid(async () => {
        throw lost("model turn lost");
      });
    },
    h.options,
  ).catch((caught) => caught);
  assert.ok(error instanceof StepFault);
  assert.deepEqual(faultOf(error), {
    kind: "decision",
    question: "review failed 4 times with an unknown outcome; retry or cancel?",
    evidence: ["model turn lost"],
  });
  assert.equal(error.cause.message, "model turn lost");
  // Free faults 1,3,5,7,9; paid 503 at 2; paid lost at 4,6,8,10.
  assert.equal(calls, 10);
  const record = h.state.repeats["one/a1/review"];
  // Progress at the start of each call reset the run of faults, not the bound.
  assert.equal(record.count, 1);
  assert.equal(record.paid, 4);
  assert.deepEqual(h.state.work.one.wait, {
    kind: "decision",
    detail: "review failed 4 times with an unknown outcome; retry or cancel?",
  });
  assertRepeats(h.disk.at(-1).repeats, "repeats", new Set(["one"]));
  // Retry clears the records and the decision.
  assert.equal(clearRepeats(h.state, { item: "one" }), true);
  assert.equal(h.state.repeats, undefined);
  assert.equal(h.state.work.one.wait, undefined);
});

test("the paid bound survives a restart", async () => {
  const h = harness();
  h.state.repeats = {
    "objective/plan": {
      since: new Date(T0).toISOString(),
      count: 0,
      last: { kind: "transient", detail: "turn lost", outcomeUnknown: true },
      nextAt: new Date(T0).toISOString(),
      paid: 3,
    },
  };
  const error = await step(
    h.state,
    { scope: "objective", name: "plan", paid: true },
    (ctx) =>
      ctx.paid(async () => {
        throw lost("turn lost again");
      }),
    h.options,
  ).catch((caught) => caught);
  assert.equal(faultOf(error).kind, "decision");
  assert.equal(h.state.repeats["objective/plan"].paid, 4);
  assert.equal(h.state.wait.kind, "decision");
});

test("a paid call in a step not declared paid is a defect", async () => {
  const h = harness();
  const error = await step(
    h.state,
    { scope: item, name: "publish" },
    (ctx) => ctx.paid(async () => 1),
    h.options,
  ).catch((caught) => caught);
  assert.equal(faultOf(error).kind, "defect");
  assert.match(error.message, /not paid/);
});

test("after 24 hours of faults a free step asks retry or cancel and keeps waiting", async () => {
  const h = harness();
  const waits = [];
  h.options.save = () => waits.push(h.state.work.one.wait);
  let calls = 0;
  const result = await step(
    h.state,
    { scope: item, name: "publish" },
    async () => {
      calls++;
      if (h.clock.time < T0 + 25 * HOUR)
        throw transient("api.github.com unreachable");
      return "published";
    },
    h.options,
  );
  assert.equal(result, "published");
  const escalation = {
    kind: "decision",
    detail: `publish has failed since ${new Date(T0).toISOString()}; retry or cancel?`,
  };
  const first = waits.findIndex((wait) => wait?.kind === "decision");
  assert.ok(first > 0);
  assert.equal(waits[first - 1].kind, "outage");
  // It keeps repeating after asking, at the five-minute cap.
  for (const wait of waits.slice(first, -1)) assert.deepEqual(wait, escalation);
  assert.ok(waits.length - 1 - first >= 12);
  assert.equal(h.clock.sleeps.at(-1), 5 * MINUTE);
  // Success clears the question and the record.
  assert.equal(h.state.work.one.wait, undefined);
  assert.equal(h.state.repeats, undefined);
  assert.ok(calls > 280);
});

test("work rethrows the original error and deletes the record", async () => {
  const h = harness();
  const work = fail({
    kind: "work",
    evidence: { detail: "validation failed" },
  });
  const fn = scripted(...Array.from({ length: 7 }, () => transient()), work);
  const error = await step(
    h.state,
    { scope: item, name: "validate" },
    fn,
    h.options,
  ).catch((caught) => caught);
  assert.equal(error, work);
  assert.equal(h.state.repeats, undefined);
  // The outage wait it wrote went with the record.
  assert.equal(h.disk.at(-2).work.one.wait.kind, "outage");
  assert.equal(h.state.work.one.wait, undefined);
});

test("config waits with the named fix and ends the run of faults", async () => {
  const h = harness();
  const config = fail({
    kind: "config",
    detail: "403 Resource not accessible",
    fix: "Grant the token contents: write",
  });
  const error = await step(
    h.state,
    { scope: item, name: "publish" },
    scripted(transient(), config),
    h.options,
  ).catch((caught) => caught);
  assert.equal(error, config);
  assert.deepEqual(h.state.work.one.wait, {
    kind: "prerequisite",
    detail: "403 Resource not accessible",
    fix: "Grant the token contents: write",
  });
  assertWait(h.disk.at(-1).work.one.wait, "wait");
  // The service answered, so the earlier fault is not part of a later outage:
  // after a two-day pause one hiccup is not a 24-hour escalation.
  assert.equal(h.state.repeats, undefined);
  delete h.state.work.one.wait;
  h.clock.time += 48 * HOUR;
  const waits = [];
  h.options.save = () => waits.push(h.state.work.one.wait);
  await step(
    h.state,
    { scope: item, name: "publish" },
    scripted(transient()),
    h.options,
  );
  assert.deepEqual(waits, [undefined, undefined]);
});

test("a non-transient fault keeps a paid step's bound", async () => {
  const h = harness();
  const config = fail({ kind: "config", detail: "401", fix: "Log in" });
  let calls = 0;
  await step(
    h.state,
    { scope: item, name: "execute", paid: true },
    (ctx) =>
      ctx.paid(async () => {
        calls++;
        throw calls === 3 ? config : lost();
      }),
    h.options,
  ).catch((caught) => assert.equal(caught, config));
  assert.equal(h.state.repeats["one/a1/execute"].paid, 2);
  assert.equal(h.state.repeats["one/a1/execute"].count, 0);
  assertRepeats(h.state.repeats, "repeats", new Set(["one"]));
});

test("decision waits with its question", async () => {
  const h = harness();
  const asked = new StepFault({
    kind: "decision",
    question: "A foreign commit is on the branch; keep it?",
    evidence: ["abc123"],
  });
  const error = await step(
    h.state,
    { scope: "objective", name: "close" },
    scripted(asked),
    h.options,
  ).catch((caught) => caught);
  assert.equal(error, asked);
  assert.deepEqual(h.state.wait, {
    kind: "decision",
    detail: "A foreign commit is on the branch; keep it?",
  });
  assert.equal(h.disk.length, 1);
});

test("the last fault is saved in the exact persisted shape", async () => {
  const h = harness();
  const loose = new StepFault({
    kind: "transient",
    detail: "x",
    outcomeUnknown: false,
    retryAt: undefined,
    status: 503,
  });
  await step(
    h.state,
    { scope: item, name: "publish" },
    scripted(loose),
    h.options,
  );
  assert.deepEqual(h.disk[0].repeats[KEY].last, {
    kind: "transient",
    detail: "x",
    outcomeUnknown: false,
  });
  assertRepeats(h.disk[0].repeats, "repeats", new Set(["one"]));
});

test("a defect stops at once without a wait", async () => {
  const h = harness();
  const bug = new TypeError("undefined is not a function");
  const error = await step(
    h.state,
    { scope: item, name: "publish" },
    scripted(transient(), bug),
    h.options,
  ).catch((caught) => caught);
  assert.equal(error, bug);
  assert.equal(faultOf(error).kind, "defect");
  // The caller stops and reports; the step writes no wait for a defect.
  assert.equal(h.state.repeats, undefined);
  assert.equal(h.state.work.one.wait, undefined);
});

test("cancel aborts a backoff and stops repeating", async () => {
  const h = harness();
  const controller = new AbortController();
  h.clock.sleep = async (_ms, signal) => {
    controller.abort(new Error("Objective cancelled"));
    signal.throwIfAborted();
  };
  const fn = scripted(transient(), transient());
  await assert.rejects(
    step(h.state, { scope: item, name: "publish" }, fn, {
      ...h.options,
      signal: controller.signal,
    }),
    /Objective cancelled/,
  );
  assert.equal(fn.calls.count, 1);
  assert.equal(h.state.repeats[KEY].count, 1);
});

test("an item step needs the item's state", async () => {
  const h = harness();
  await assert.rejects(
    step(
      h.state,
      { scope: { item: "three", attempt: "c1" }, name: "publish" },
      async () => 1,
      h.options,
    ),
    /three has no state/,
  );
  await assert.rejects(
    step(
      { kind: "preparing" },
      { scope: item, name: "publish" },
      async () => 1,
      h.options,
    ),
    /one has no state/,
  );
});

test("the default clock can be replaced for tests", async () => {
  const clock = manualClock();
  const restore = setStepClock(clock);
  try {
    const state = factoryState();
    await step(state, { scope: item, name: "publish" }, scripted(transient()), {
      save: () => undefined,
    });
    assert.deepEqual(clock.sleeps, [SECOND]);
  } finally {
    restore();
  }
});

test("clearRepeats clears one scope; clearWait clears only the expected wait", () => {
  const record = (since) => ({
    since,
    count: 2,
    last: { kind: "transient", detail: "x", outcomeUnknown: false },
    nextAt: since,
  });
  const state = factoryState();
  state.repeats = {
    "one/a1/publish": record("2026-10-03T10:00:00.000Z"),
    "one/a0/execute": record("2026-10-03T09:00:00.000Z"),
    "two/b1/publish": record("2026-10-03T08:00:00.000Z"),
    "objective/plan": record("2026-10-03T07:00:00.000Z"),
  };
  assert.deepEqual(outageOf(state, item), {
    step: "publish",
    since: "2026-10-03T10:00:00.000Z",
    tries: 2,
    last: { kind: "transient", detail: "x", outcomeUnknown: false },
  });
  assert.equal(outageOf(state, "objective").step, "plan");
  assert.equal(outageOf(state, { item: "one", attempt: "zz" }), undefined);
  assert.equal(clearRepeats(state, { item: "one" }), true);
  assert.deepEqual(Object.keys(state.repeats), [
    "two/b1/publish",
    "objective/plan",
  ]);
  assert.equal(clearRepeats(state, { item: "one" }), false);
  assert.equal(clearRepeats(state, "objective"), true);
  assert.deepEqual(Object.keys(state.repeats), ["two/b1/publish"]);

  setWait(state, "objective", { kind: "ci", detail: "checks" });
  assert.equal(
    clearWait(state, "objective", { kind: "ci", detail: "other" }),
    false,
  );
  assert.equal(
    clearWait(state, "objective", { kind: "ci", detail: "checks" }),
    true,
  );
  assert.equal(clearWait(state, "objective"), false);
});

test("persisted records and waits keep their exact shape", () => {
  const last = { kind: "transient", detail: "x", outcomeUnknown: true };
  const at = "2026-10-03T10:00:00.000Z";
  assertRepeats(
    { "objective/plan": { since: at, count: 0, last, nextAt: at, paid: 2 } },
    "repeats",
  );
  for (const bad of [
    { since: at, count: 0, last, nextAt: at },
    { since: at, count: 1, last, nextAt: at, paid: 0 },
    { since: at, count: -1, last, nextAt: at, paid: 1 },
  ])
    assert.throws(
      () => assertRepeats({ "objective/plan": bad }, "repeats"),
      /invalid/,
    );
  assertWait(
    { kind: "prerequisite", detail: "403", fix: "Grant access" },
    "wait",
  );
  for (const bad of [
    { kind: "outage", detail: "x", fix: "y" },
    { kind: "prerequisite", detail: "x", fix: "" },
  ])
    assert.throws(() => assertWait(bad, "wait"), /wait is invalid/);
});

const view = (work, overrides = {}) => ({
  objective: 7,
  state: "active",
  runActive: true,
  coordinator: { mode: "running", phase: "active" },
  pendingAmendment: null,
  repairs: {},
  finalValidation: false,
  finalAcceptancePending: null,
  objectiveClosure: null,
  lastError: null,
  githubClosureError: null,
  work,
  ...overrides,
});
const itemView = (id, overrides = {}) => ({
  id,
  status: "running",
  step: "publish",
  requestedPhase: null,
  blockedReason: null,
  waitingReason: null,
  pullRequest: null,
  acceptancePending: null,
  candidateAssetSets: [],
  lastError: null,
  authentication: null,
  ...overrides,
});

test("status shows an outage with its start, tries and last fault", () => {
  const status = view([
    itemView("one", {
      wait: { kind: "outage", detail: "publish: fetch failed" },
      outage: {
        step: "publish",
        since: "2026-10-03T10:00:00.000Z",
        tries: 9,
        last: "fetch failed",
      },
    }),
    itemView("two", {
      status: "pending",
      step: null,
      blockedReason: "dependency:one",
    }),
  ]);
  const summary = summarizeStatus(status);
  assert.equal(summary.phase, "waiting");
  assert.equal(
    summary.summary,
    "outage since 2026-10-03 10:00Z (9 tries, last: fetch failed) in one; 0/2 done",
  );
  const lines = renderStatusText({ ...status, ...summary });
  assert.equal(
    lines[0],
    "Objective #7: waiting — outage since 2026-10-03 10:00Z (9 tries, last: fetch failed) in one; 0/2 done",
  );
  assert.match(
    lines.find((line) => line.includes("one ")),
    /since 2026-10-03 10:00Z \(9 tries/,
  );
  // Other active work keeps the Objective running.
  assert.equal(
    summarizeStatus(view([...status.work, itemView("three")])).phase,
    "running",
  );
});

test("status asks for structured decisions and names a config fix", () => {
  const asked = summarizeStatus(
    view([
      itemView("one", {
        wait: {
          kind: "decision",
          detail:
            "review failed 4 times with an unknown outcome; retry or cancel?",
        },
      }),
    ]),
  );
  assert.equal(asked.phase, "needs-decision");
  assert.equal(
    asked.summary,
    "decision for one: review failed 4 times with an unknown outcome; retry or cancel?",
  );
  assert.equal(
    asked.nextAction.command,
    "factory retry --objective 7 --item one",
  );
  assert.match(asked.nextAction.reason, /or factory cancel --objective 7$/);

  const objective = summarizeStatus(
    view([itemView("one", { status: "done" })], {
      wait: {
        kind: "decision",
        detail: "close has failed since then; retry or cancel?",
      },
    }),
  );
  assert.equal(objective.phase, "needs-decision");
  assert.equal(objective.nextAction.command, "factory cancel --objective 7");

  const fix = summarizeStatus(
    view([
      itemView("one", {
        wait: {
          kind: "prerequisite",
          detail: "403 Resource not accessible",
          fix: "Grant the token contents: write",
        },
      }),
    ]),
  );
  assert.equal(fix.phase, "waiting");
  assert.equal(
    fix.summary,
    "on external prerequisite for one: 403 Resource not accessible; 0/1 done",
  );
  assert.deepEqual(fix.nextAction, {
    command: "factory run --objective 7",
    reason: "First: Grant the token contents: write",
  });

  const closing = summarizeStatus(
    view([itemView("one", { status: "done" })], {
      finalValidation: true,
      wait: { kind: "outage", detail: "close: 502" },
      outage: {
        step: "close",
        since: "2026-10-03T10:00:00.000Z",
        tries: 1,
        last: "502",
      },
    }),
  );
  assert.equal(
    closing.summary,
    "outage since 2026-10-03 10:00Z (1 try, last: 502) in close; 1/1 done",
  );
});

test("planning status reads the Objective's outage from state, redacted", () => {
  const document = preparationStatusDocument(
    {
      schemaVersion: 7,
      kind: "preparing",
      repository: "example/repo",
      objective: 7,
      runId: "run",
      configDigest: "b".repeat(64),
      baseSha: "c".repeat(40),
      objectiveBodyDigest: "d".repeat(64),
      issueByItemId: {},
      coordinator: {
        mode: "running",
        phase: "planning",
        phaseStartedAt: new Date(T0).toISOString(),
      },
      repeats: {
        "objective/plan": {
          since: "2026-10-03T10:00:00.000Z",
          count: 4,
          last: {
            kind: "transient",
            detail: "token secret-value refused",
            outcomeUnknown: false,
          },
          nextAt: "2026-10-03T10:00:15.000Z",
        },
      },
      wait: { kind: "outage", detail: "plan: token secret-value refused" },
    },
    ["secret-value"],
    true,
  );
  assert.equal(document.phase, "waiting");
  assert.equal(
    document.summary,
    "outage since 2026-10-03 10:00Z (4 tries, last: token [REDACTED] refused) in plan",
  );
  assert.deepEqual(document.wait, {
    kind: "outage",
    detail: "plan: token [REDACTED] refused",
  });
  assert.equal(document.outage.tries, 4);
});
