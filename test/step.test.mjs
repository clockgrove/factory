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
  setWait,
  step,
  waitOf,
} from "../dist/step.js";

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const at = (time) => new Date(time).toISOString();

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
  schemaVersion: 7,
  work: { one: { status: "running" }, two: { status: "running" } },
});

/** Every save keeps a JSON copy, as the state file would. */
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

/** Also record `observe()` at every save. */
function observing(h, observe) {
  const seen = [];
  const save = h.options.save;
  h.options.save = () => {
    save();
    seen.push(observe());
  };
  return seen;
}

const fail = (fault) => attachFault(new Error(fault.detail ?? "failed"), fault);
const transient = (detail = "fetch failed", extra = {}) =>
  fail({ kind: "transient", detail, outcomeUnknown: false, ...extra });
const lost = (detail = "response lost") =>
  fail({ kind: "transient", detail, outcomeUnknown: true });

/** A body that throws the given errors in order, then returns "done". */
function scripted(...errors) {
  const calls = { count: 0 };
  const fn = async () => {
    const error = errors[calls.count++];
    if (error) throw error;
    return "done";
  };
  return Object.assign(fn, { calls });
}

const item = { item: "one" };
const KEY = "item/one/publish";
const publish = { scope: item, name: "publish" };
const caught = (promise) =>
  promise.then(
    () => assert.fail("expected a rejection"),
    (error) => error,
  );

test("repeat keys name the item or the Objective step", () => {
  assert.equal(repeatKey(item, "publish"), KEY);
  assert.equal(repeatKey("objective", "plan"), "objective/plan");
  assert.throws(() => repeatKey(item, "Publish"), /Invalid step/);
  assert.throws(() => repeatKey({ item: "a/b" }, "publish"), /Invalid step/);
});

test("backoff doubles from one second to a five-minute cap", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 8, 9, 10, 50].map(backoffDelay),
    [1, 2, 4, 8, 128, 256, 300, 300].map((seconds) => seconds * SECOND),
  );
});

test("success on the first call writes nothing", async () => {
  const h = harness();
  assert.equal(await step(h.state, publish, async () => 7, h.options), 7);
  assert.equal(h.disk.length, 0);
  assert.equal(h.state.repeats, undefined);
});

test("transient faults repeat with a persisted backoff; success deletes the record", async () => {
  const h = harness();
  const fn = scripted(...Array.from({ length: 11 }, () => transient()));
  assert.equal(await step(h.state, publish, fn, h.options), "done");
  assert.equal(fn.calls.count, 12);
  assert.deepEqual(
    h.clock.sleeps,
    [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300].map((s) => s * SECOND),
  );
  assert.deepEqual(h.disk[2].repeats[KEY], {
    nextAt: at(T0 + 7 * SECOND),
    scheduledAt: at(T0 + 3 * SECOND),
    faults: {
      since: at(T0),
      count: 3,
      last: {
        kind: "transient",
        detail: "fetch failed",
        outcomeUnknown: false,
      },
      activeMs: 3 * SECOND,
    },
  });
  for (const saved of h.disk) assertRepeats(saved.repeats, "repeats");
  assert.equal(h.state.repeats, undefined);
});

test("a restart mid-backoff resumes from the record and never counts downtime", async () => {
  const h = harness();
  const sleep = h.clock.sleep;
  h.clock.sleep = async (milliseconds) => {
    if (h.clock.sleeps.length) throw new Error("process killed");
    await sleep(milliseconds);
  };
  await assert.rejects(
    step(h.state, publish, scripted(transient(), transient()), h.options),
    /process killed/,
  );
  const saved = h.disk.at(-1);
  assert.equal(saved.repeats[KEY].faults.count, 2);
  assert.equal(saved.repeats[KEY].nextAt, at(T0 + 3 * SECOND));

  // A new process starts 500 ms into the 2 s backoff.
  const resumed = harness(saved, manualClock(T0 + 1500));
  assert.equal(
    await step(resumed.state, publish, scripted(transient()), resumed.options),
    "done",
  );
  assert.deepEqual(resumed.clock.sleeps, [1500, 4 * SECOND]);
  const third = resumed.disk[0].repeats[KEY].faults;
  assert.equal(third.count, 3);
  assert.equal(third.since, at(T0));
  // 1 s before the crash and 1.5 s after the restart; not the 0.5 s down.
  assert.equal(third.activeMs, 2500);
});

test("a backwards clock jump cannot stall a backoff", async () => {
  // Scheduled for one second after a fault the clock then put 24 hours ahead.
  const h = harness();
  h.state.repeats = {
    [KEY]: {
      nextAt: at(T0 + 24 * HOUR + SECOND),
      scheduledAt: at(T0 + 24 * HOUR),
      faults: {
        since: at(T0),
        count: 1,
        last: { kind: "transient", detail: "x", outcomeUnknown: false },
        activeMs: 0,
      },
    },
  };
  await step(h.state, publish, scripted(), h.options);
  assert.deepEqual(h.clock.sleeps, [SECOND]);
});

test("progress ends a run of faults, so long polls never look like an outage", async () => {
  const h = harness();
  let calls = 0;
  const seen = observing(h, () => structuredClone(h.state.repeats));
  await step(
    h.state,
    { scope: item, name: "await-ci" },
    async (ctx) => {
      calls++;
      if (calls <= 8) throw transient();
      if (calls === 9) {
        ctx.progress();
        throw transient("poll hiccup");
      }
      return "done";
    },
    h.options,
  );
  assert.equal(seen[7]["item/one/await-ci"].faults.count, 8);
  assert.equal(seen[8], undefined);
  assert.equal(seen[9]["item/one/await-ci"].faults.count, 1);
  assert.equal(h.clock.sleeps.at(-1), SECOND);
});

test("status shows an outage once it will have lasted a minute", async () => {
  const h = harness();
  const outages = observing(h, () => outageOf(h.state, item, h.clock.now()));
  await step(
    h.state,
    publish,
    scripted(...Array.from({ length: 7 }, () => transient("502"))),
    h.options,
  );
  // Faults at 0, 1, 3, 7, 15 s: the next try is within a minute of the first.
  assert.deepEqual(outages.slice(0, 5), Array(5).fill(undefined));
  // At 31 s the next try is at 63 s.
  assert.deepEqual(outages[5], {
    step: "publish",
    since: at(T0),
    tries: 6,
    last: { kind: "transient", detail: "502", outcomeUnknown: false },
    escalated: false,
  });
  assert.equal(outages.at(-1), undefined);

  // A distant retryAt is an outage at once.
  const limited = harness();
  limited.clock.sleep = async () => {
    throw new Error("stop");
  };
  await caught(
    step(
      limited.state,
      publish,
      scripted(transient("limit", { retryAt: at(T0 + 5 * HOUR) })),
      limited.options,
    ),
  );
  assert.equal(outageOf(limited.state, item, T0).tries, 1);
});

test("retryAt is honoured and never counts toward the paid bound", async () => {
  const h = harness();
  await step(
    h.state,
    { scope: "objective", name: "plan", paid: true },
    async (ctx) => {
      if (h.clock.sleeps.length < 5)
        await ctx.paid(async () => {
          throw transient("usage limit", {
            retryAt: at(h.clock.time + 90 * SECOND),
            outcomeUnknown: true,
          });
        });
      return "planned";
    },
    h.options,
  );
  assert.deepEqual(h.clock.sleeps, Array(5).fill(90 * SECOND));
  const lastFault = h.disk.findLast(
    (saved) => saved.repeats?.["objective/plan"]?.faults,
  );
  assert.equal(lastFault.repeats["objective/plan"].faults.count, 5);
  assert.equal(lastFault.repeats["objective/plan"].paid, undefined);
  // A retryAt already past falls back to the backoff.
  const late = harness();
  await step(
    late.state,
    publish,
    scripted(transient("limit", { retryAt: at(T0 - SECOND) })),
    late.options,
  );
  assert.deepEqual(late.clock.sleeps, [SECOND]);
});

test("pending shows its wait, polls, survives faults and never counts", async () => {
  const h = harness();
  const waits = observing(h, () => structuredClone(h.state.work.one.wait));
  let calls = 0;
  await step(
    h.state,
    { scope: item, name: "merge", paid: true },
    async (ctx) => {
      calls++;
      if (calls === 1) ctx.pending({ kind: "ci", detail: "PR #5 checks" });
      if (calls === 2)
        ctx.pending(
          { kind: "ci", detail: "PR #5 checks" },
          at(h.clock.time + 10 * SECOND),
        );
      if (calls <= 10) throw lost("GitHub GET failed");
      return "merged";
    },
    h.options,
  );
  const ci = { kind: "ci", detail: "PR #5 checks", step: "item/one/merge" };
  assert.deepEqual(h.clock.sleeps.slice(0, 2), [30 * SECOND, 10 * SECOND]);
  // Eight faults over more than two minutes leave the pending wait in place.
  for (const wait of waits.slice(0, -1)) assert.deepEqual(wait, ci);
  assert.ok(h.clock.time - T0 > 2 * MINUTE);
  // Free faults in a paid step never count.
  const lastFault = h.disk.at(-2).repeats["item/one/merge"];
  assert.equal(lastFault.faults.count, 8);
  assert.equal(lastFault.paid, undefined);
  // Success clears the step's own wait and record.
  assert.equal(h.state.work.one.wait, undefined);
  assert.equal(h.state.repeats, undefined);
});

test("a caller's wait survives faults; the step never writes over it", async () => {
  const h = harness();
  assert.equal(
    setWait(h.state, item, { kind: "ci", detail: "checks pending" }),
    true,
  );
  await step(
    h.state,
    publish,
    scripted(...Array.from({ length: 9 }, () => transient())),
    h.options,
  );
  assert.deepEqual(waitOf(h.state, item), {
    kind: "ci",
    detail: "checks pending",
  });
  assert.equal(clearWait(h.state, item), true);
});

test("the fourth unknown-outcome fault of the paid call is a decision that holds until retry", async () => {
  const h = harness();
  let calls = 0;
  const spec = { scope: item, name: "review", paid: true };
  const body = async (ctx) => {
    calls++;
    ctx.progress();
    // Free calls fault without counting, as do known-outcome paid faults.
    if (calls % 2 === 1) throw lost("GitHub response lost");
    if (calls === 2)
      await ctx.paid(async () => {
        throw transient("model 503");
      });
    // The caller wraps the paid call's error; it still counts.
    return ctx
      .paid(async () => {
        throw lost("model turn lost");
      })
      .catch((error) => {
        throw new Error("review failed", { cause: error });
      });
  };
  const error = await caught(step(h.state, spec, body, h.options));
  assert.ok(error instanceof StepFault);
  const question =
    "review failed 4 times with an unknown outcome; retry or cancel?";
  assert.deepEqual(faultOf(error), {
    kind: "decision",
    question,
    evidence: ["model turn lost"],
  });
  assert.equal(calls, 10);
  assert.equal(h.state.repeats["item/one/review"].paid, 4);
  assert.deepEqual(h.state.work.one.wait, {
    kind: "decision",
    detail: question,
    step: "item/one/review",
  });
  assertRepeats(h.disk.at(-1).repeats, "repeats");
  assertWait(h.disk.at(-1).work.one.wait, "wait");

  // Re-entry re-throws without calling the body; nothing silently clears it.
  const again = await caught(step(h.state, spec, body, h.options));
  assert.equal(faultOf(again).question, question);
  assert.equal(calls, 10);
  assert.equal(setWait(h.state, item, { kind: "ci", detail: "x" }), false);
  assert.equal(clearWait(h.state, item), false);

  // The operator's retry clears the bound and the decision.
  assert.equal(clearRepeats(h.state, item), true);
  assert.equal(h.state.repeats, undefined);
  assert.equal(h.state.work.one.wait, undefined);
  assert.equal(
    await step(h.state, spec, async () => "reviewed", h.options),
    "reviewed",
  );
});

test("a crash during a paid call counts as a paid fault on restart", async () => {
  const h = harness();
  let release;
  const plan = { scope: "objective", name: "plan", paid: true };
  const running = step(
    h.state,
    plan,
    (ctx) =>
      ctx.paid(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    h.options,
  );
  await new Promise((resolve) => setImmediate(resolve));
  // The process dies here: the file holds the in-flight marker.
  const crashed = structuredClone(h.disk.at(-1));
  assert.deepEqual(crashed.repeats["objective/plan"], { inFlight: true });
  release("plan");
  assert.equal(await running, "plan");
  assert.equal(h.state.repeats, undefined);

  crashed.repeats["objective/plan"].paid = 3;
  const restarted = harness(crashed);
  let called = false;
  const error = await caught(
    step(
      restarted.state,
      plan,
      async () => {
        called = true;
      },
      restarted.options,
    ),
  );
  assert.equal(called, false);
  assert.equal(faultOf(error).kind, "decision");
  assert.deepEqual(restarted.state.repeats["objective/plan"], { paid: 4 });
});

test("an invalid answer's error survives a restart and goes with the step (#593)", async () => {
  const h = harness();
  const review = { scope: { item: "one" }, name: "review", paid: true };
  const asks = [];
  // The first answer is invalid; the process dies during the backoff.
  const controller = new AbortController();
  h.clock.sleep = async (_ms, signal) => {
    controller.abort(new Error("process died"));
    signal?.throwIfAborted();
  };
  await caught(
    step(
      h.state,
      review,
      (ctx) => {
        asks.push(ctx.previousInvalid());
        return ctx.paid(async () => {
          ctx.invalid("criterion 2 has no evidence");
          throw lost("Independent review answer was invalid");
        });
      },
      { ...h.options, signal: controller.signal },
    ),
  );
  const crashed = structuredClone(h.disk.at(-1));
  assert.equal(
    crashed.repeats["item/one/review"].invalid,
    "criterion 2 has no evidence",
  );
  assert.doesNotThrow(() => assertRepeats(crashed.repeats, "repeats"));
  // The restarted process asks again with the saved error.
  const restarted = harness(crashed);
  const answer = await step(
    restarted.state,
    review,
    (ctx) => {
      asks.push(ctx.previousInvalid());
      return ctx.paid(async () => "reviewed");
    },
    restarted.options,
  );
  assert.equal(answer, "reviewed");
  assert.deepEqual(asks, [undefined, "criterion 2 has no evidence"]);
  // Success ends the step and its record.
  assert.equal(restarted.state.repeats, undefined);
});

test("a paid call in a step not declared paid is a defect", async () => {
  const h = harness();
  const error = await caught(
    step(h.state, publish, (ctx) => ctx.paid(async () => 1), h.options),
  );
  assert.equal(faultOf(error).kind, "defect");
  assert.match(error.message, /not paid/);
});

test("24 hours of running time escalates; downtime between processes does not count", async () => {
  // A run of faults that began two days ago in a process that then stopped.
  const old = harness();
  old.state.repeats = {
    [KEY]: {
      nextAt: at(T0 - 47 * HOUR),
      scheduledAt: at(T0 - 47 * HOUR - MINUTE),
      faults: {
        since: at(T0 - 48 * HOUR),
        count: 3,
        last: { kind: "transient", detail: "x", outcomeUnknown: false },
        activeMs: HOUR,
      },
    },
  };
  old.clock.sleep = async () => {
    throw new Error("stop");
  };
  await caught(step(old.state, publish, scripted(transient()), old.options));
  assert.equal(outageOf(old.state, item, T0).escalated, false);

  const h = harness();
  const escalated = observing(
    h,
    () => outageOf(h.state, item, h.clock.now())?.escalated,
  );
  const result = await step(
    h.state,
    publish,
    async () => {
      if (h.clock.time < T0 + 25 * HOUR)
        throw transient("api.github.com unreachable");
      return "published";
    },
    h.options,
  );
  assert.equal(result, "published");
  const first = escalated.indexOf(true);
  assert.ok(first > 0);
  // It keeps repeating after escalating, at the five-minute cap.
  assert.ok(escalated.slice(first, -1).every((value) => value === true));
  assert.ok(escalated.length - 1 - first >= 12);
  assert.equal(h.clock.sleeps.at(-1), 5 * MINUTE);
  assert.equal(h.state.repeats, undefined);
});

test("work and defect end the step: the record, paid count and own wait go", async () => {
  for (const ending of [
    fail({ kind: "work", evidence: { detail: "validation failed" } }),
    new TypeError("undefined is not a function"),
  ]) {
    const h = harness();
    let calls = 0;
    const error = await caught(
      step(
        h.state,
        { scope: item, name: "execute", paid: true },
        async (ctx) => {
          calls++;
          if (calls === 1)
            ctx.pending({ kind: "capacity", detail: "worker running" });
          if (calls === 2)
            await ctx.paid(async () => {
              throw lost();
            });
          throw ending;
        },
        h.options,
      ),
    );
    assert.equal(error, ending);
    assert.equal(h.disk.at(-2).repeats["item/one/execute"].paid, 1);
    assert.equal(h.state.repeats, undefined);
    assert.equal(h.state.work.one.wait, undefined);
  }
});

test("config waits with its fix; the next run tries again and keeps the paid count", async () => {
  const h = harness();
  const config = fail({
    kind: "config",
    detail: "401 Bad credentials",
    fix: "Log in to the model provider",
  });
  const spec = { scope: item, name: "execute", paid: true };
  let calls = 0;
  const error = await caught(
    step(
      h.state,
      spec,
      (ctx) =>
        ctx.paid(async () => {
          calls++;
          throw calls === 3 ? config : lost();
        }),
      h.options,
    ),
  );
  assert.equal(error, config);
  assert.deepEqual(h.state.work.one.wait, {
    kind: "prerequisite",
    detail: "401 Bad credentials",
    fix: "Log in to the model provider",
    step: "item/one/execute",
  });
  assert.deepEqual(h.state.repeats["item/one/execute"], { paid: 2 });
  // The service answered, so a two-day pause is not part of an outage.
  h.clock.time += 48 * HOUR;
  assert.equal(await step(h.state, spec, async () => "ran", h.options), "ran");
  assert.equal(h.state.work.one.wait, undefined);
  assert.equal(h.state.repeats, undefined);
});

test("a decision waits with its question until the operator answers", async () => {
  const h = harness();
  const close = { scope: "objective", name: "close" };
  const asked = new StepFault({
    kind: "decision",
    question: "A foreign commit is on the branch; keep it?",
    evidence: ["abc123"],
  });
  const fn = scripted(asked);
  assert.equal(await caught(step(h.state, close, fn, h.options)), asked);
  assert.deepEqual(h.state.wait, {
    kind: "decision",
    detail: "A foreign commit is on the branch; keep it?",
    step: "objective/close",
  });
  await caught(step(h.state, close, fn, h.options));
  assert.equal(fn.calls.count, 1);
  assert.equal(clearRepeats(h.state, "objective"), true);
  assert.equal(await step(h.state, close, fn, h.options), "done");
});

test("cancel ends a backoff or a try with a cancelled fault, not a defect", async () => {
  const h = harness();
  const controller = new AbortController();
  h.clock.sleep = async (_ms, signal) => {
    controller.abort(new Error("Objective cancelled"));
    signal.throwIfAborted();
  };
  const fn = scripted(transient(), transient());
  const during = await caught(
    step(h.state, publish, fn, { ...h.options, signal: controller.signal }),
  );
  assert.deepEqual(faultOf(during), {
    kind: "cancelled",
    detail: "Objective cancelled",
  });
  assert.equal(fn.calls.count, 1);

  const body = harness();
  const abort = new AbortController();
  const error = await caught(
    step(
      body.state,
      publish,
      async () => {
        abort.abort();
        throw new Error("The operation was aborted");
      },
      { ...body.options, signal: abort.signal },
    ),
  );
  assert.equal(faultOf(error).kind, "cancelled");
  assert.equal(body.state.repeats, undefined);
});

test("one step key never runs twice at once", async () => {
  const h = harness();
  let release;
  const first = step(
    h.state,
    publish,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    h.options,
  );
  const error = await caught(step(h.state, publish, async () => 1, h.options));
  assert.equal(faultOf(error).kind, "defect");
  assert.match(error.message, /already running/);
  release(2);
  assert.equal(await first, 2);
  assert.equal(await step(h.state, publish, async () => 3, h.options), 3);
});

test("Objective steps run on a planning snapshot; item steps need the item", async () => {
  const preparing = { schemaVersion: 8, kind: "preparing" };
  const h = harness(preparing);
  assert.equal(
    await step(
      preparing,
      { scope: "objective", name: "plan" },
      scripted(transient()),
      h.options,
    ),
    "done",
  );
  await assert.rejects(
    step(preparing, publish, async () => 1, h.options),
    /one has no state/,
  );
  await assert.rejects(
    step(
      factoryState(),
      { scope: { item: "three" }, name: "publish" },
      async () => 1,
      h.options,
    ),
    /three has no state/,
  );
});

test("running work polls without a wait; progress clears a stale pending wait", async () => {
  const h = harness();
  const waits = observing(h, () => structuredClone(h.state.work.one.wait));
  let calls = 0;
  await step(
    h.state,
    { scope: item, name: "merge" },
    async (ctx) => {
      calls++;
      if (calls === 1) ctx.pending({ kind: "ci", detail: "PR #5 checks" });
      if (calls === 2) throw transient();
      ctx.progress();
      if (calls === 3) ctx.pending(undefined, at(h.clock.time + 5 * SECOND));
      return "merged";
    },
    h.options,
  );
  const ci = { kind: "ci", detail: "PR #5 checks", step: "item/one/merge" };
  // The fault keeps the last known state; the next observation clears it.
  assert.deepEqual(waits.slice(0, 3), [ci, ci, undefined]);
  assert.deepEqual(h.clock.sleeps, [30 * SECOND, SECOND, 5 * SECOND]);
  assert.equal(h.state.work.one.wait, undefined);
});

test("a worker confirmed dead counts toward the paid bound through paidLost", async () => {
  const h = harness();
  h.state.work.one.session = { attempt: "a1", seq: 1 };
  const error = await caught(
    step(
      h.state,
      { scope: item, name: "execute", paid: true },
      async (ctx) => {
        const session = h.state.work.one.session;
        h.state.work.one.session = { ...session, seq: session.seq + 1 };
        ctx.paidLost(`worker ${session.seq} ended without a result`);
      },
      h.options,
    ),
  );
  assert.equal(faultOf(error).kind, "decision");
  assert.deepEqual(faultOf(error).evidence, [
    "worker 4 ended without a result",
  ]);
  // Each try started a new session of the same attempt.
  assert.equal(h.state.work.one.session.seq, 5);
  const free = await caught(
    step(h.state, publish, (ctx) => ctx.paidLost("x"), h.options),
  );
  assert.equal(faultOf(free).kind, "defect");
});

test("a paid step makes one paid call at a time", async () => {
  const h = harness();
  const error = await caught(
    step(
      h.state,
      { scope: item, name: "review", paid: true },
      (ctx) =>
        Promise.all([
          ctx.paid(() => new Promise(() => {})),
          ctx.paid(async () => 1),
        ]),
      h.options,
    ),
  );
  assert.equal(faultOf(error).kind, "defect");
  assert.match(error.message, /while one is running/);
});

test("a decision blocks its step even while another step's question holds the wait", async () => {
  const h = harness();
  h.state.work.one.wait = {
    kind: "decision",
    detail: "review failed 4 times with an unknown outcome; retry or cancel?",
    step: "item/one/review",
  };
  const merge = { scope: item, name: "merge" };
  const fn = scripted(
    new StepFault({
      kind: "decision",
      question: "Foreign head; keep it?",
      evidence: [],
    }),
  );
  await caught(step(h.state, merge, fn, h.options));
  // Status shows the first question; this step's waits in its record.
  assert.equal(h.state.work.one.wait.step, "item/one/review");
  assert.equal(
    h.state.repeats["item/one/merge"].asked,
    "Foreign head; keep it?",
  );
  const again = await caught(step(h.state, merge, fn, h.options));
  assert.equal(faultOf(again).question, "Foreign head; keep it?");
  assert.equal(fn.calls.count, 1);
  // Retry answers the item's waiting steps.
  clearRepeats(h.state, item);
  assert.equal(
    await step(h.state, merge, async () => "merged", h.options),
    "merged",
  );
});

test("clearRepeats clears one scope's records and step waits", () => {
  const record = { nextAt: at(T0), scheduledAt: at(T0) };
  const state = factoryState();
  state.repeats = {
    "item/one/publish": record,
    "item/one/execute": { paid: 2 },
    "item/two/publish": record,
    "objective/plan": record,
  };
  state.work.one.wait = {
    kind: "decision",
    detail: "x",
    step: "item/one/execute",
  };
  state.work.two.wait = { kind: "ci", detail: "checks" };
  assert.equal(clearRepeats(state, item), true);
  assert.deepEqual(Object.keys(state.repeats), [
    "item/two/publish",
    "objective/plan",
  ]);
  assert.equal(state.work.one.wait, undefined);
  assert.equal(clearRepeats(state, item), false);
  assert.equal(clearRepeats(state, { item: "two" }), true);
  assert.deepEqual(state.work.two.wait, { kind: "ci", detail: "checks" });
  assert.equal(clearRepeats(state, "objective"), true);
  assert.equal(state.repeats, undefined);
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
  work,
  ...overrides,
});
const itemView = (id, overrides = {}) => ({
  id,
  status: "running",
  step: "publish",
  requestedPhase: null,
  blockedReason: null,
  pullRequest: null,
  acceptancePending: null,
  candidateAssetSets: [],
  lastError: null,
  authentication: null,
  ...overrides,
});
const outage = (overrides = {}) => ({
  step: "publish",
  since: "2026-10-03T10:00:00.000Z",
  tries: 9,
  last: "fetch failed",
  escalated: false,
  ...overrides,
});

test("status shows an outage per scope, alongside a pending wait", () => {
  const status = view([
    itemView("one", { outage: outage() }),
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
    "on outage for one (publish): since 2026-10-03 10:00Z (9 tries, last: fetch failed); 0/2 done",
  );
  assert.equal(summary.nextAction, null);
  assert.equal(
    renderStatusText({ ...status, ...summary })[0],
    "Objective #7: waiting — on outage for one (publish): since 2026-10-03 10:00Z (9 tries, last: fetch failed); 0/2 done",
  );
  const both = summarizeStatus(
    view([
      itemView("one", {
        outage: outage(),
        wait: { kind: "ci", detail: "PR #5 checks", step: "item/one/merge" },
      }),
    ]),
  );
  assert.match(
    both.summary,
    /\(9 tries, last: fetch failed\); also on CI check: PR #5 checks; 0\/1 done$/,
  );
  // Other active work keeps the Objective running.
  assert.equal(
    summarizeStatus(view([...status.work, itemView("three")])).phase,
    "running",
  );
  // The Objective's own outage reads the same way.
  assert.equal(
    summarizeStatus(
      view([itemView("one", { status: "done" })], {
        outage: outage({ step: "close", tries: 1, last: "502" }),
      }),
    ).summary,
    "on outage for the Objective (close): since 2026-10-03 10:00Z (1 try, last: 502); 1/1 done",
  );
});

test("a 24-hour outage offers cancel and keeps waiting, even beside running work", () => {
  const escalated = outage({ escalated: true });
  const live = summarizeStatus(
    view([itemView("one", { outage: escalated }), itemView("two")]),
  );
  assert.equal(live.phase, "waiting");
  assert.equal(live.nextAction.command, "factory cancel --objective 7");
  assert.match(live.nextAction.reason, /keeps retrying until you cancel$/);
  const stopped = summarizeStatus(
    view([itemView("one", { outage: escalated })], { runActive: false }),
  );
  assert.match(
    stopped.nextAction.reason,
    /or factory run --objective 7 to keep retrying$/,
  );
});

test("a step decision asks for factory retry and hides the outage", () => {
  const detail =
    "review failed 4 times with an unknown outcome; retry or cancel?";
  const asked = summarizeStatus(
    view([
      itemView("one", {
        wait: { kind: "decision", detail, step: "item/one/review" },
        outage: outage(),
      }),
    ]),
  );
  assert.equal(asked.phase, "needs-decision");
  assert.equal(asked.summary, `decision for one: ${detail}`);
  assert.deepEqual(asked.nextAction, {
    command: "factory retry --objective 7 --item one",
    reason: "Retry runs the step again; or factory cancel --objective 7",
  });
  const objective = summarizeStatus(
    view([itemView("one", { status: "done" })], {
      runActive: false,
      wait: { kind: "decision", detail, step: "objective/close" },
    }),
  );
  assert.equal(objective.summary, `decision for the Objective: ${detail}`);
  assert.deepEqual(objective.nextAction, {
    command: "factory retry --objective 7",
    reason:
      "Retry runs the step again; then factory run --objective 7; or factory cancel --objective 7",
  });
});

test("a config pause names its fix and follows the restart convention", () => {
  const wait = {
    kind: "prerequisite",
    detail: "403 Resource not accessible",
    fix: "Grant the token contents: write",
    step: "item/one/publish",
  };
  const live = summarizeStatus(view([itemView("one", { wait })]));
  assert.equal(live.phase, "waiting");
  assert.equal(
    live.summary,
    "on external prerequisite for one: 403 Resource not accessible; 0/1 done",
  );
  assert.deepEqual(live.nextAction, {
    command: "factory retry --objective 7 --item one",
    reason: "First: Grant the token contents: write",
  });
  const stopped = summarizeStatus(
    view([itemView("one", { wait })], { runActive: false }),
  );
  assert.equal(
    stopped.nextAction.reason,
    "First: Grant the token contents: write; then factory run --objective 7",
  );
});

test("planning status reads the Objective's outage from state, redacted", () => {
  const document = preparationStatusDocument(
    {
      schemaVersion: 8,
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
        phaseStartedAt: at(T0),
      },
      repeats: {
        "objective/plan": {
          nextAt: at(Date.now() + 5 * HOUR),
          scheduledAt: at(Date.now()),
          faults: {
            since: "2026-10-03T10:00:00.000Z",
            count: 4,
            last: {
              kind: "transient",
              detail: "token secret-value refused",
              outcomeUnknown: false,
            },
            activeMs: 0,
          },
        },
      },
    },
    ["secret-value"],
    true,
  );
  assert.equal(document.phase, "waiting");
  assert.equal(
    document.summary,
    "on outage for the Objective (plan): since 2026-10-03 10:00Z (4 tries, last: token [REDACTED] refused)",
  );
  assert.equal(document.outage.tries, 4);
});
