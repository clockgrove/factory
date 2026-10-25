// A Work Item keeps the CI check failures its results were repaired
// for, and result review gets them as the repository's enforced convention,
// so it never refuses the change a check demanded, and nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINEERING_STANDARD } from "../dist/planning/rubric.js";
import { checkFailureRows } from "../dist/review/result.js";
import { facts } from "../dist/work/facts.js";
import {
  deliveryRepair,
  keptCheckFailures,
} from "../dist/work/step-deliver.js";

const failure =
  "Checks failed on PR #495 at e508db3: test (failure)\n\ntest:\ntest/chainBase.test.js is missing the required line '// drill-tag'";

function state(kept = {}) {
  return { kept, done: {}, issue: 492 };
}

test("a failed-checks repair keeps its failure for the item's result review, at CI or merge, newest last and bounded", () => {
  const item = { id: "chainBase" };
  for (const phase of ["ci", "merge"]) {
    const outcome = deliveryRepair(
      item,
      { state: state() },
      undefined,
      { finding: failure, checks: true },
      phase,
    );
    assert.deepEqual(
      outcome.keep["item:chainBase:checkFailures"],
      [failure],
      phase,
    );
  }
  const kept = state(
    facts({ checkFailures: ["one", "two", "three"] }, "chainBase"),
  );
  assert.deepEqual(keptCheckFailures(kept, "chainBase", "four"), [
    "two",
    "three",
    "four",
  ]);
});

test("a repair that isn't failed checks keeps no check failure, whatever its text", () => {
  const item = { id: "chainBase" };
  const conflict = deliveryRepair(
    item,
    { state: state() },
    undefined,
    { finding: "PR #495 conflicts with its base branch", conflict: {} },
    "ci",
  );
  assert.equal(conflict.keep["item:chainBase:checkFailures"], undefined);
  const unmarked = deliveryRepair(
    item,
    { state: state() },
    undefined,
    { finding: failure },
    "ci",
  );
  assert.equal(unmarked.keep["item:chainBase:checkFailures"], undefined);
});

test("result review gets the failures as the repository's convention, and the standard lets CI checks win", () => {
  assert.deepEqual(checkFailureRows([]), []);
  const [row] = checkFailureRows([failure]);
  assert.equal(row.origin, "controller");
  assert.equal(row.complete, true);
  const content = JSON.parse(row.content);
  assert.deepEqual(content.failures, [failure]);
  assert.match(content.scope, /repository wins/);
  assert.match(content.scope, /no debug leftover/);
  assert.match(content.scope, /never a reason to weaken a test/);
  assert.match(
    ENGINEERING_STANDARD,
    /or CI checks differ, the repository wins/,
  );
});
