// How a criterion is evidenced is the planner's choice. In run
// 2026-10-27T053725PDT-60f0 (#2117) Claude's graph reviewer asked for a
// command proxy of "visibly depicts the cube", then raised that proxy against
// result review as an operator decision; answered "choose within the
// Objective", the planner kept the proxy in its graph and asked the same A/B
// question every round until the suite's answers ran out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildFacts } from "../dist/planning/facts.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
  renderPlanningInstructions,
} from "../dist/planning/prompts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

const EVIDENCE_METHOD =
  "How a criterion is evidenced (a command that checks a property of the result, or a semantic proof whose review judges the criterion itself) is the planner's choice, never an operator decision: review judges whether the chosen method can show the criterion, and one that can't is a fix finding asking for one that can. A perceptual quality of candidate media (that a preview depicts its model, how an image looks) is seen by the operator when choosing a set at select and judged by the owner's result review through a semantic proof of its criterion; it is not an acceptance entry, so it needs no command evidence, and commands check its checkable properties (format, dimensions, content).";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

async function cubeFacts() {
  const checkout = tempDir("factory-evidence-method-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ name: "target", scripts: { test: "node --test" } }),
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
  const base = git(checkout, "rev-parse", "HEAD");
  const shown = readShown(
    "<h2>Goal</h2>\n<p>Deliver a cube model and its preview.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>assets/cube-preview.png</code> is a 64x64 PNG preview of the cube.</li>\n<li><code>npm test</code> passes.</li>\n</ul>",
    { sources: true },
  );
  const built = await buildFacts({ objective: 2, shown, base, checkout });
  assert.ok(built.facts, JSON.stringify(built.problems));
  return { facts: built.facts, shown };
}

const DEPICTION_QUESTION =
  "For the preview criterion 'is a 64x64 PNG preview of the cube': (A) keep the command proxy (dimensions, not uniform, contains the model's base colour). (B) Split the coverage row: dimensions stay result-command, and 'depicts the cube' is proved by item review of the delivered PNG against the model.";

test("graph review judges how a criterion is evidenced and does not undo a fix it asked for", async () => {
  const { facts } = await cubeFacts();
  const decision = {
    question: DEPICTION_QUESTION,
    answer: "answer",
    text: "Choose an implementation detail within the Objective's written goal.",
    by: "kirk",
    at: "2026-10-27T12:41:49.311Z",
  };
  const reviewer = renderGraphReviewCall({
    facts,
    draft: { items: [] },
    evidence: [],
    decisions: [decision],
    finalCommands: [],
    controllerCapabilities: {},
    scope: {
      round: 2,
      previousFindings: [
        {
          kind: "fix",
          itemIds: ["cube-model-assets"],
          detail:
            "Replace the visible-depiction entry with a checkable property of the PNG.",
        },
      ],
      changedItemIds: ["cube-model-assets"],
      addedItemIds: [],
      removedItemIds: [],
      changedFields: ["coverage"],
    },
  }).prompt;
  // Check 1 quotes the rule; check 10 keeps it off the operator's list.
  const check1 = reviewer.indexOf("1. Acceptance coverage.");
  const check2 = reviewer.indexOf("2. Constraints and scope.");
  const rule = reviewer.indexOf(EVIDENCE_METHOD);
  assert.equal(check1 < rule && rule < check2, true);
  assert.ok(
    reviewer.includes(
      "Fixture or test values the sources call policy, internal names, file layout and how a criterion is evidenced (check 1) are the planner's choice: never an operator question.",
    ),
  );
  // A revision round keeps the fix a previous finding asked for.
  assert.ok(
    reviewer.includes(
      "(d) A change the revision made for a previous finding is what that finding asked for: do not ask to undo it, or raise the choice it settled as an operator decision, without a new reason that finding did not weigh.",
    ),
  );
  // An answer that leaves the choice to the planner settles it.
  assert.ok(
    reviewer.includes(
      "An answer that leaves the choice to the planner settles it too: judge the planner's choice as sound or not.",
    ),
  );
});

test("the planner decides an answered or planner-owned question instead of asking it again", async () => {
  const { facts, shown } = await cubeFacts();
  const operator = {
    source: "operator",
    message: `${DEPICTION_QUESTION}\nAnswer: answer — Choose an implementation detail within the Objective's written goal.`,
  };
  const planner = renderCompilationCall({
    facts,
    data: {
      instructions: renderPlanningInstructions(shown.blocks, [operator], true),
    },
    revising: true,
    lookups: { open: false, bodies: [] },
  }).prompt;
  assert.ok(
    planner.includes(
      "An operator answer settles the question it answers, also when it leaves the choice to you (such as choosing within the Objective): make that choice in the plan, keeping the current plan's choice when it is sound. Never ask an answered question again, and never ask one rule 2 leaves to you, such as how a criterion is evidenced.",
    ),
  );
  // Rule 2 and the checklist name the evidence method as the planner's.
  assert.ok(
    planner.includes(
      "Choosing fixture or test values the sources call policy, internal names, file layout, how a criterion is evidenced and other implementation details is your job, not a product question.",
    ),
  );
  assert.ok(planner.includes(`- Evidence method. ${EVIDENCE_METHOD}`));
  // Without an operator answer the planner is not told about one.
  const unanswered = renderPlanningInstructions(
    shown.blocks,
    [{ source: "review", message: "Fix the coverage." }],
    true,
  );
  assert.equal(unanswered.includes("An operator answer settles"), false);
});
