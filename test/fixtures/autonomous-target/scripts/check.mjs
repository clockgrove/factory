import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const phase = process.argv[2];
if (!["alpha", "beta", "join", "qa", "guide"].includes(phase)) {
  throw new Error("Expected alpha, beta, join, qa, or guide");
}
if (["alpha", "join", "qa"].includes(phase)) {
  const { alpha } = await import("../src/alpha.mjs");
  assert.equal(alpha([3, -2, 8]), 9);
  assert.equal(alpha([]), 0);
  assert.equal(alpha([0]), 0);
}
if (["beta", "join", "qa"].includes(phase)) {
  const { beta } = await import("../src/beta.mjs");
  assert.equal(beta([3, -2, 8]), 8);
  assert.equal(beta([]), null);
  assert.equal(beta([-4, -2]), -2);
}
if (["join", "qa"].includes(phase)) {
  const { summarize } = await import("../src/summary.mjs");
  assert.deepEqual(summarize([3, -2, 8]), { total: 9, maximum: 8 });
  assert.deepEqual(summarize([]), { total: 0, maximum: null });
}
if (phase === "qa") {
  const { summarize } = await import("../src/summary.mjs");
  const input = Object.freeze([2, 2, -1]);
  assert.deepEqual(summarize(input), { total: 3, maximum: 2 });
  assert.deepEqual(input, [2, 2, -1]);
}
if (phase === "guide") {
  const text = await readFile(new URL("../GUIDE.md", import.meta.url), "utf8");
  for (const term of ["summarize", "total", "maximum", "null", "[]"]) {
    assert.ok(text.includes(term), `GUIDE.md must explain ${term}`);
  }
}
console.log(`PASS ${phase}`);
