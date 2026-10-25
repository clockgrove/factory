// The hedged planner: how it ends its attempts.
import assert from "node:assert/strict";
import { test } from "node:test";

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
  await assert.rejects(
    planner.answer({
      role: "reviewer",
      phase: "result-review",
      prompt: "review",
      schema: {},
      signal: new AbortController().signal,
      log: () => undefined,
    }),
    /exceeded retry limit/,
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
});
