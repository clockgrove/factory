// A Work Item carries one outcome (#2282). In a 0.5.12 run a 9-entry item
// with seven independently verifiable capabilities, all proved by one new
// test file, passed the entry signal of 15 unremarked: each failing
// capability hid the next, and its worker found them one validation cycle
// at a time.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildFacts } from "../dist/planning/facts.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
} from "../dist/planning/prompts.js";
import { WORK_ITEM_ENTRY_SIGNAL } from "../dist/planning/rubric.js";
import { decodePlan } from "../dist/planning/wire.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

async function streamFacts() {
  const checkout = tempDir("factory-item-size-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
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
    "<h2>Goal</h2>\n<p>Stream events to subscribers.</p>\n<h2>Acceptance</h2>\n<ul>\n<li>Subscribers receive every event in order.</li>\n</ul>",
    { sources: true },
  );
  const built = await buildFacts({
    objective: 9,
    shown,
    base: git(checkout, "rev-parse", "HEAD"),
    checkout,
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  return built.facts;
}

/** A planner answer with one work item. */
function answer(item) {
  return {
    items: [
      {
        kind: "work",
        id: "stream",
        title: "Event stream",
        goal: "Subscribers receive every event in order.",
        nonGoals: ["No change to the event format."],
        citations: [{ path: "OBJECTIVE", heading: "" }],
        children: [],
        dependencies: [],
        ownedPaths: ["src/stream/", "test/stream.test.js"],
        newPackages: [],
        priority: 0,
        resources: [],
        scheduling: null,
        validation: ["npm test"],
        sourceAssets: [],
        media: null,
        ...item,
      },
    ],
    coverage: [
      {
        itemId: "stream",
        proof: { kind: "result-command", validationIndex: 0 },
        environment: null,
      },
    ],
    sourceObligations: [],
    requiredPreIntegrationChecks: [],
    cannotPlan: null,
    decisionRequired: null,
  };
}

const SPLIT = `Plan standard: Work Item stream has 9 acceptance entries, above the signal of ${WORK_ITEM_ENTRY_SIGNAL}, and no oneOutcomeReason: split it into one item per independently verifiable capability, each proved by its own test, or state in oneOutcomeReason why it is one outcome`;

test("a multi-capability item is sent back to split, and a cohesive one with its reason stays together", async () => {
  const facts = await streamFacts();
  assert.equal(WORK_ITEM_ENTRY_SIGNAL, 5);

  // Nine entries, seven capabilities: refused before review, with the split.
  const sprawling = {
    acceptance: [
      "A new subscriber is backfilled incrementally from its last cursor.",
      "Backfill resumes from the cursor after an interruption.",
      "An acknowledgement from a fenced-out consumer is refused.",
      "Each event fans out only to subscribers authorized for its topic.",
      "Under backpressure, pending updates to one key coalesce into the latest.",
      "Delivery recovers after the stream's owner is replaced.",
      "No event crosses the storage boundary of another tenant.",
      "An evidence manifest lists each delivered event's cursor.",
      "`npm test` passes.",
    ],
    brief: "One new integration test proves the stream.",
    oneOutcomeReason: null,
  };
  const refused = decodePlan(answer(sprawling), facts);
  assert.equal(refused.plan, undefined);
  assert.deepEqual(
    refused.findings.map((finding) => [finding.itemId, finding.message]),
    [["stream", SPLIT]],
  );
  // In an amendment, a started item's acceptance was accepted, and its
  // planner cannot restate it, so the signal does not judge it again.
  const started = decodePlan(answer(sprawling), facts, {
    started: new Set(["stream"]),
  });
  assert.deepEqual(started.findings, []);
  // Nor an unstarted item a plan accepted under the old signal keeps as it
  // was, while one whose acceptance or reason the amendment changes is.
  const amended = { amended: started.plan.items };
  assert.deepEqual(decodePlan(answer(sprawling), facts, amended).findings, []);
  const grown = {
    ...sprawling,
    acceptance: [...sprawling.acceptance.slice(0, -1), "Replay is idempotent."],
  };
  assert.deepEqual(
    decodePlan(answer(grown), facts, amended).findings.map((f) => f.message),
    [SPLIT],
  );
  const reasoned = decodePlan(
    answer({ ...sprawling, oneOutcomeReason: "One delivery contract." }),
    facts,
  );
  assert.deepEqual(reasoned.findings, []);
  assert.deepEqual(
    decodePlan(answer(sprawling), facts, {
      amended: reasoned.plan.items,
    }).findings.map((f) => f.message),
    [SPLIT],
  );

  // Six entries of one rule, with the reason: no finding, and the reason
  // reaches the brief.
  const reason =
    "Ordering is one rule: each entry checks one side of it, and none is verifiable without the others.";
  const cohesive = decodePlan(
    answer({
      acceptance: [
        "Subscribers receive events in publish order.",
        "A late subscriber receives events from its cursor in order.",
        "A duplicate publish is delivered once.",
        "Order holds whether events arrive one by one or in batches.",
        "A malformed cursor is refused through the existing validation.",
        "`npm test` passes.",
      ],
      brief: "Order is per topic.",
      oneOutcomeReason: reason,
    }),
    facts,
  );
  assert.deepEqual(cohesive.findings, []);
  const [item] = cohesive.plan.items;
  assert.equal(item.brief, `Order is per topic.\n\nOne outcome: ${reason}`);

  // Graph review judges the reason, the one shared test and the item's cost
  // in check 3, and the planner checks its plan by the same rule.
  const reviewer = renderGraphReviewCall({
    facts,
    draft: cohesive.plan,
    evidence: [],
    decisions: [],
    finalCommands: [],
    controllerCapabilities: {},
  }).prompt;
  const check3 = reviewer.indexOf("3. Decomposition and ownership.");
  const check4 = reviewer.indexOf("4. Phases.");
  for (const rule of [
    "Flag an item whose distinct capabilities are all proved by one new test file or one test, asking for a test per capability or a split, and an item one worker could not plausibly get green in a handful of validation cycles.",
    "An item above about 5 acceptance entries needs a brief that says why it is one outcome: flag a reason that names capabilities separate items could each verify, naming the items to split it into. Entry count alone is not a defect, and an item whose reason holds stays together.",
  ]) {
    const at = reviewer.indexOf(rule);
    assert.ok(check3 < at && at < check4, rule);
  }
  const planner = renderCompilationCall({
    facts,
    data: { instructions: "" },
    revising: false,
    lookups: { open: false, bodies: [] },
  }).prompt;
  assert.ok(
    planner.includes(
      "- One outcome. Items split by independently verifiable capability, never by layer, and each includes its own tests and documentation. Flag an item that delivers more than one outcome, naming the outcomes to split it into; settled shared interfaces, data meanings and files do not make one outcome. Flag an item whose distinct capabilities are all proved by one new test file or one test",
    ),
  );
  assert.ok(
    planner.includes(
      "About 5 acceptance entries is a signal, not a target: above it, split the item or state why it is one outcome (Factory adds the reason to the brief). An item is too big when one worker could not plausibly get it green in a handful of validation cycles.",
    ),
  );
  // The balance against over-splitting stays.
  assert.ok(
    planner.includes(
      "Still keep cohesive work in one item when handoff, preparation, validation and review cost more than the overlap saves",
    ),
  );
  assert.ok(reviewer.includes("Item count alone is not a defect."));
});
