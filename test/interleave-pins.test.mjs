import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedPinProblems } from "./support/interleave.mjs";

const crash = { at: "alpha git fetch #1" };
const broken = {
  invariant: "stop",
  message: "run 1 stopped",
  consequence: false,
};

test("a fixed race pin with no failure and a fired crash has no problems", () => {
  assert.deepEqual(
    fixedPinProblems([], { crash }, { crashed: { label: crash.at } }),
    [],
  );
  assert.deepEqual(fixedPinProblems([], {}, {}), []);
});

test("a fixed race pin fails on any broken invariant, whichever race explains it", () => {
  const problems = fixedPinProblems([broken], {}, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stop: run 1 stopped/);
});

test("a fixed race pin ignores consequences of a stop it already reports", () => {
  const consequence = { ...broken, invariant: "done", consequence: true };
  assert.equal(fixedPinProblems([broken, consequence], {}, {}).length, 1);
});

test("a fixed race pin fails when its scheduled crash never fired", () => {
  const problems = fixedPinProblems([], { crash }, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never fired/);
});
