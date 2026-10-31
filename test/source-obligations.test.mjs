// The planner's schema offers source obligations only from the Objective's
// pinned Sources: the decoder refuses the Objective and context, and an
// Objective with no Sources (the media case) planned round after round
// with the same refusal until the revision allowance ran out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planSchema } from "../dist/planning/wire.js";

function facts(sources) {
  return {
    base: "0".repeat(40),
    sources,
    coverageObligations: [],
    checkNames: [],
    integratedCheckNames: [],
    packageCommands: [],
  };
}

const objective = {
  path: "OBJECTIVE",
  content: "## Goal\n\nAdd a cube.",
  operatorAuthored: true,
};
const agents = { path: "AGENTS.md", content: "# Agent rules", context: true };
const spec = { path: "docs/spec.md", content: "- exit item one" };

test("source obligations cite only a pinned Source, and none without one", () => {
  const none = planSchema(facts([objective, agents]));
  assert.equal(none.properties.sourceObligations.maxItems, 0);
  const pinned = planSchema(facts([objective, agents, spec]));
  assert.deepEqual(
    pinned.properties.sourceObligations.items.properties.sourceIndex.enum,
    [2],
  );
});
