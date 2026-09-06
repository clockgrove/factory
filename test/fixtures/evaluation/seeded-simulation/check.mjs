import assert from "node:assert/strict";
import { simulate } from "./src/simulation.mjs";
const trace = simulate(7, 4);
assert.deepEqual(
  trace.map((step) => step.arrivals),
  [3, 1, 3, 2],
);
assert.deepEqual(simulate(7, 4), trace);
assert.deepEqual(simulate(0, 0), []);
assert.throws(() => simulate(-1, 4));
assert.throws(() => simulate(7, 101));
assert.ok(trace.every((step) => step.admitted === step.arrivals && step.rejected === 0));
console.log("seeded-simulation baseline ok");
