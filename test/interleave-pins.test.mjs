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

const hold = { hold: "alpha git push #1", until: "beta POST /pulls #1" };
const withHold = (outcome) => ({ holds: [{ ...hold, outcome }] });

test("a fixed race pin passes when its holds took effect", () => {
  for (const outcome of ["applied", "already", "crashed"])
    assert.deepEqual(
      fixedPinProblems([], { holds: [hold] }, withHold(outcome)),
      [],
      outcome,
    );
});

test("a fixed race pin fails when a hold did not take effect", () => {
  for (const outcome of ["pending", "infeasible", "abandoned"]) {
    const problems = fixedPinProblems([], { holds: [hold] }, withHold(outcome));
    assert.equal(problems.length, 1, outcome);
    assert.match(problems[0], new RegExp(`was ${outcome}`));
    assert.match(problems[0], /alpha git push #1/);
  }
});

test("a fixed race pin fails when the run reports fewer holds than scheduled", () => {
  const problems = fixedPinProblems([], { holds: [hold] }, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 holds were scheduled but the run reported 0/);
});
