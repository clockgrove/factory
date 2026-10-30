// Plan review judges whether an item's acceptance can be met without a
// protected file the Objective's May change section doesn't list (#2248).
// In a 0.5.11 benchmark run collection refused an item's `.github/` edits,
// and its acceptance still asked for browser preparation before the
// workflow's bootstrap invocation: amendment review rejected the worker's
// in-scope script repair, and the item never landed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PROTECTED_PATH_RULE } from "../dist/objective.js";
import { buildFacts } from "../dist/planning/facts.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
  renderPlanningInstructions,
} from "../dist/planning/prompts.js";
import { decodeGraphReview } from "../dist/planning/review.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

const WORKFLOW = ".github/workflows/ci.yml";
const ENTRY = "Browser preparation runs before the bootstrap invocation.";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base whose workflow runs a bootstrap script, and an Objective with no May change section. */
async function browserFacts() {
  const checkout = tempDir("factory-protected-acceptance-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  for (const [file, text] of [
    ["package.json", JSON.stringify({ scripts: { test: "node --test" } })],
    ["scripts/bootstrap.sh", "#!/bin/sh\n"],
    [
      WORKFLOW,
      "on: push\njobs:\n  test:\n    steps:\n      - run: sh scripts/bootstrap.sh\n",
    ],
  ]) {
    mkdirSync(join(checkout, file, ".."), { recursive: true });
    writeFileSync(join(checkout, file), text);
  }
  git(checkout, "add", ".");
  git(
    checkout,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  const shown = readShown(
    "<h2>Goal</h2>\n<p>Run the browser checks in CI.</p>\n<h2>Acceptance</h2>\n<ul>\n<li>The browser checks pass in CI.</li>\n</ul>",
    { sources: true },
  );
  const built = await buildFacts({
    objective: 7,
    shown,
    base: git(checkout, "rev-parse", "HEAD"),
    checkout,
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  return { facts: built.facts, shown };
}

const browserItem = {
  kind: "work",
  id: "browser",
  title: "Browser checks",
  goal: "Run the browser checks in CI.",
  acceptance: [ENTRY, "`npm test` passes."],
  nonGoals: [],
  citations: [{ path: "OBJECTIVE" }],
  dependencies: [],
  ownedPaths: ["scripts/bootstrap.sh"],
  validation: [{ command: "npm test" }],
  brief: "Prepare the browser before the checks run.",
  priority: 1,
};

test("plan review flags acceptance only an unlisted protected file can meet, and the planner gets it to fix", async () => {
  const { facts, shown } = await browserFacts();
  assert.deepEqual(facts.unlistedProtectedPaths, [WORKFLOW]);
  const reviewer = renderGraphReviewCall({
    facts,
    draft: { items: [browserItem] },
    evidence: [],
    decisions: [],
    finalCommands: [],
    controllerCapabilities: {},
  }).prompt;
  // Check 8 carries the rule, and the packet names the file it applies to.
  const check8 = reviewer.indexOf("8. Work Item contracts.");
  const check9 = reviewer.indexOf("9. Repository-checkable criteria.");
  const rule = reviewer.indexOf(
    `In the Objective's May change section, ${PROTECTED_PATH_RULE}, so collection refuses a worker's change to an unlisted one. Flag an acceptance entry that needs ordering, configuration or behaviour only such an unlisted file can deliver`,
  );
  assert.ok(check8 < rule && rule < check9);
  assert.ok(
    reviewer.includes(
      `Protected files at the base the Objective's May change section doesn't list (collection refuses a worker's change to one):\n${JSON.stringify([WORKFLOW])}`,
    ),
  );
  // The planner checks its plan by the same rule.
  const planner = renderCompilationCall({
    facts,
    data: { instructions: "" },
    revising: false,
    lookups: { open: false, bodies: [] },
  }).prompt;
  assert.ok(
    planner.includes(
      "- Protected files. In the Objective's May change section,",
    ),
  );

  // A reviewer's finding naming the entry and the file is the planner's to fix.
  const detail = `Work Item browser's acceptance entry ${JSON.stringify(ENTRY)} needs an ordering only ${WORKFLOW} can deliver, and the May change section doesn't list it: restate it as browser readiness before the browser-dependent tests.`;
  const decoded = decodeGraphReview(
    {
      findings: [
        {
          kind: "fix",
          itemIds: ["browser"],
          evidenceIndices: [],
          detail,
          question: "",
        },
      ],
    },
    [],
    ["browser"],
  );
  assert.equal(decoded.invalid, false);
  const [finding] = decoded.findings;
  assert.equal(finding.kind, "fix");
  assert.equal(finding.itemId, "browser");
  const instructions = renderPlanningInstructions(
    shown.blocks,
    [finding],
    true,
  );
  assert.ok(
    instructions.includes(
      JSON.stringify([
        { source: "review", itemIds: ["browser"], detail: finding.message },
      ]),
    ),
  );
  assert.ok(finding.message.startsWith(detail));
});
