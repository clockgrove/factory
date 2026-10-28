// The hedged planner: which phases it hedges, when, and how it ends its attempts.
import assert from "node:assert/strict";
import { test } from "node:test";

const call = (phase, overrides = {}) => ({
  role: ["graph-review", "result-review", "objective-review"].includes(phase)
    ? "reviewer"
    : "planner",
  phase,
  prompt: phase,
  schema: {},
  signal: new AbortController().signal,
  log: () => undefined,
  ...overrides,
});

test("a hedged call that fails fast never aborts the attempt that already settled", async () => {
  const { HedgedPlanner } = await import("../dist/providers/planner.js");
  const signals = [];
  // Like a Codex call that fails at once on a 429: the SDK's child may still
  // be exiting, and an abort that reached it then crashed the service.
  const inner = {
    answer: async (call) => {
      signals.push(call.signal);
      throw new Error("Codex call failed: exceeded retry limit");
    },
  };
  const planner = new HedgedPlanner(inner);
  // Plan review is hedged by default, so the call goes through the hedge.
  const given = call("graph-review");
  await assert.rejects(planner.answer(given), /exceeded retry limit/);
  assert.equal(signals.length, 1);
  assert.notEqual(signals[0], given.signal, "the hedge's own signal");
  assert.equal(signals[0].aborted, false);
});

test("by default diagnosis, result review and final review are never hedged; planning and plan review are", async () => {
  const { DEFAULT_HEDGE_SECONDS, HedgedPlanner, hedgePolicy } = await import(
    "../dist/providers/planner.js"
  );
  assert.deepEqual(DEFAULT_HEDGE_SECONDS, {
    plan: 120,
    "graph-review": 45,
    "result-review": 0,
    "objective-review": 0,
    diagnosis: 0,
    dream: 120,
    propose: 120,
  });
  const policy = hedgePolicy();
  assert.equal(policy.silenceMs.diagnosis, 0);
  assert.equal(policy.silenceMs["result-review"], 0);
  assert.equal(policy.silenceMs["objective-review"], 0);
  assert.equal(policy.silenceMs.plan, 120_000);
  assert.equal(policy.silenceMs["graph-review"], 45_000);
  const seen = [];
  const planner = new HedgedPlanner({
    answer: async (received) => {
      seen.push(received);
      return { value: received.phase, model: "m", effort: "e", ms: 1 };
    },
  });
  for (const phase of ["diagnosis", "result-review", "objective-review"]) {
    const given = call(phase);
    assert.equal((await planner.answer(given)).value, phase);
    // Unhedged: the inner planner gets the call itself, with no second
    // attempt's signal or activity wrapped around it.
    assert.equal(seen.at(-1), given, phase);
  }
  for (const phase of ["plan", "graph-review"]) {
    const given = call(phase);
    assert.equal((await planner.answer(given)).value, phase);
    assert.notEqual(seen.at(-1), given, `${phase} goes through the hedge`);
  }
});

test("a configured threshold hedges its phase after that much silence, and 0 turns a default hedge off", async () => {
  const { HedgedPlanner, hedgePolicy } = await import(
    "../dist/providers/planner.js"
  );
  const policy = hedgePolicy({ "result-review": 1, plan: 0 });
  assert.equal(policy.silenceMs["result-review"], 1000);
  assert.equal(policy.silenceMs.plan, 0);
  assert.equal(policy.silenceMs["graph-review"], 45_000, "others keep theirs");

  const attempts = [];
  const planner = new HedgedPlanner(
    {
      answer: (received) => {
        attempts.push(received);
        if (attempts.length === 1) {
          // The first attempt reports one event, then stalls until aborted.
          received.activity?.();
          return new Promise((_, reject) =>
            received.signal.addEventListener("abort", () =>
              reject(received.signal.reason),
            ),
          );
        }
        return Promise.resolve({
          value: "second",
          model: "m",
          effort: "e",
          ms: 1,
        });
      },
    },
    policy,
  );
  const logged = [];
  const started = Date.now();
  const answer = await planner.answer(
    call("result-review", { log: (event) => logged.push(event) }),
  );
  assert.equal(answer.value, "second");
  assert.equal(attempts.length, 2);
  assert.ok(Date.now() - started >= 1000, "not before its threshold");
  assert.ok(attempts[0].signal.aborted, "the stalled first call is aborted");
  const hedge = logged.find((event) => event.event === "planner-hedge");
  assert.equal(hedge.phase, "result-review");
  assert.equal(hedge.role, "reviewer");
  assert.ok(hedge.silentMs >= 1000);

  // plan: 0 sends planning straight through.
  const seen = [];
  const off = new HedgedPlanner(
    {
      answer: async (received) => {
        seen.push(received);
        return { value: "plan", model: "m", effort: "e", ms: 1 };
      },
    },
    policy,
  );
  const given = call("plan");
  await off.answer(given);
  assert.equal(seen[0], given);
});
