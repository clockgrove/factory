// A Work Item keeps the CI check failures its results were repaired
// for, and result review gets them as the repository's enforced convention,
// so it never refuses the change a check demanded, and nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
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
