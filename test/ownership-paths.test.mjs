// An owned path is a file's literal name. The media case's plan owned
// "test/<worker-chosen-new-test-file>"; the worker named its test, which
// that path didn't own, and the item asked a person which path to use.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGraph } from "../dist/planning/graph.js";

const base = "0".repeat(40);

function findings(ownedPaths) {
  const item = {
    kind: "work",
    id: "CubeAssets",
    title: "Cube assets",
    goal: "Add the cube model, its preview and a test.",
    acceptance: ["`npm test` passes."],
    nonGoals: ["No other files."],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths,
    validation: [{ command: "npm test" }],
    brief: "Stage two colour sets for the operator to pick from.",
    priority: 1,
  };
  const draft = {
    base,
    items: [item],
    coverage: [],
    requiredPreIntegrationChecks: [],
    finalCommands: [],
    decisions: [],
  };
  return validateGraph(draft, {
    base,
    body: "",
    sources: [],
    coverageObligations: [],
    integratedCheckNames: [],
  }).findings.filter((f) => /invalid ownership path/.test(f.message));
}

test("a placeholder is no owned path; the file's own name is", () => {
  const [refused] = findings(["test/<worker-chosen-new-test-file>"]);
  assert.match(refused.message, /not a placeholder/);
  assert.deepEqual(findings(["test/cubeQmnan.test.js", "assets/"]), []);
});
