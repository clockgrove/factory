import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineOf, formatBaseline, selectRows } from "../lib/baseline.mjs";

const row = (issue, mergedAt, model, turns, usd, walk) => ({ issue, repository: "o/r", exit: "merged", mergedAt, phases: { modelMinutes: model, ciWaitMinutes: 10, setupMinutes: 2 }, activity: { turns, sessions: 1 }, cost: { usd, tokens: { cached: 1000, written: 100 } }, wallMinutes: model + 20, walkAway: { value: walk } });
const rows = [row(1, "2026-11-01T00:00:00Z", 10, 20, 1, true), row(2, "2026-11-02T00:00:00Z", 30, 60, 3, false), row(3, "2026-11-03T00:00:00Z", 50, 100, 5, true), { issue: 4, repository: "o/r", exit: "blocked" }, row(5, "2026-11-04T00:00:00Z", 70, 140, 7, true)];

test("selectRows: merged rows only, newest first, last N and since", () => {
  assert.deepEqual(selectRows(rows).map((r) => r.issue), [5, 3, 2, 1]);
  assert.deepEqual(selectRows(rows, { last: 2 }).map((r) => r.issue), [5, 3]);
  assert.deepEqual(selectRows(rows, { since: "2026-11-03" }).map((r) => r.issue), [5, 3]);
  assert.deepEqual(selectRows(rows, { repo: "x/y" }), []);
});

test("baselineOf: medians, spread and walk-away over the picked rows; the line formats", () => {
  const line = baselineOf(rows, { repo: "o/r", label: "w0" });
  assert.equal(line.rows, 4);
  assert.equal(line.walkAway, 75);
  assert.deepEqual(line.measures.modelMinutes, { median: 40, p25: 25, p75: 55, n: 4 });
  assert.deepEqual(line.measures.turns, { median: 80, p25: 50, p75: 110, n: 4 });
  assert.equal(line.measures.usd.median, 4);
  assert.equal(line.measures.sessions.median, 1);
  const text = formatBaseline(line);
  assert.match(text, /^baseline w0 o\/r: 4 merged Objective\(s\) 2026-11-01\.\.2026-11-04, walk-away 75%\n/);
  assert.match(text, /model min {4}40 \(25\.\.55, n=4\)/);
  assert.equal(baselineOf([], { label: "empty" }).rows, 0);
  assert.equal(baselineOf([{ issue: 9, exit: "merged", mergedAt: "2026-11-05T00:00:00Z" }], { label: "bare" }).measures.modelMinutes.median, null);
});
