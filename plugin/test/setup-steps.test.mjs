// setup's --apply (#247): every step asked for runs, however the flags are written; an unknown step is refused.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TOKEN_STEP, SETUP_STEPS, setupSteps } from "../scripts/setup.mjs";

test("setup runs every --apply step asked for, in its own order; all or none is every step; an unknown step is refused", () => {
  const base = ["--repo", "o/r", "--yes"];
  assert.deepEqual(setupSteps([...base, "--apply", "workflow", "--apply", "labels"]), ["labels", "workflow"]);
  assert.deepEqual(setupSteps([...base, "--apply=workflow", "--apply", "labels,project"]), ["labels", "project", "workflow"]);
  assert.deepEqual(setupSteps([...base, "--apply", "protection"]), ["protection"]);
  assert.deepEqual(setupSteps(base), SETUP_STEPS);
  assert.deepEqual(setupSteps([...base, "--apply", "labels", "--apply", "all"]), SETUP_STEPS);
  assert.throws(() => setupSteps([...base, "--apply", "labels", "--apply", "lables"]), /no step lables/);
});

// #470: the default-token step changes a repository-wide setting other workflows run on, so a plain `setup --yes` (a
// repin, a migration) never runs it: only when named, and last, so its refusal skips no other step.
test("all, or no --apply, leaves out default-token; named, it runs last", () => {
  const base = ["--repo", "o/r", "--yes"];
  assert.equal(DEFAULT_TOKEN_STEP, "default-token");
  assert.ok(!SETUP_STEPS.includes(DEFAULT_TOKEN_STEP));
  assert.ok(!setupSteps(base).includes(DEFAULT_TOKEN_STEP));
  assert.ok(!setupSteps([...base, "--apply", "all"]).includes(DEFAULT_TOKEN_STEP));
  assert.deepEqual(setupSteps([...base, "--apply", "default-token"]), ["default-token"]);
  assert.deepEqual(setupSteps([...base, "--apply", "workflow,default-token,protection"]), ["protection", "workflow", "default-token"]);
  assert.deepEqual(setupSteps([...base, "--apply", "all", "--apply", "default-token"]), ["labels", "project", "protection", "workflow", "default-token"]);
  assert.deepEqual(setupSteps([...base, "--apply", "app,default-token"]), ["app", "default-token"]);
  assert.throws(() => setupSteps([...base, "--apply", "lables"]), /or all \(every step but app and default-token\)/);
});
