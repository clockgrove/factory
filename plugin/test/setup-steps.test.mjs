// setup's --apply (#247): every step asked for runs, however the flags are written; an unknown step is refused.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SETUP_STEPS, setupSteps } from "../scripts/setup.mjs";

test("setup runs every --apply step asked for, in its own order; all or none is every step; an unknown step is refused", () => {
  const base = ["--repo", "o/r", "--yes"];
  assert.deepEqual(setupSteps([...base, "--apply", "workflow", "--apply", "labels"]), ["labels", "workflow"]);
  assert.deepEqual(setupSteps([...base, "--apply=workflow", "--apply", "labels,project"]), ["labels", "project", "workflow"]);
  assert.deepEqual(setupSteps([...base, "--apply", "protection"]), ["protection"]);
  assert.deepEqual(setupSteps(base), SETUP_STEPS);
  assert.deepEqual(setupSteps([...base, "--apply", "labels", "--apply", "all"]), SETUP_STEPS);
  assert.throws(() => setupSteps([...base, "--apply", "labels", "--apply", "lables"]), /no step lables/);
});
