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
  "Choosing among the methods the plan can produce to evidence a criterion (a command that checks a property of the result, or a semantic proof whose review judges the criterion itself) is the planner's choice, never an operator decision: review judges whether the chosen method can show the criterion, and one that can't is a fix finding asking for one that can. Proof that only a CI-only command, or an environment local validation lacks, can supply is not such a choice: it stays an integrated-ci proof or an operator decision, as the Work Item standard and the CI-only rule say. A perceptual quality of candidate media (that a preview depicts its model, how an image looks) is judged by the owner's result review through a semantic proof of its criterion, which Factory gives that review from the Objective itself, and seen by the operator when there are candidate sets to choose among at select (a single set is selected without asking): no acceptance entry needs to state it, so it needs no command evidence, but the owner's goal or brief states it, because its worker sees only its own item, and commands check its checkable properties (format, dimensions, content).";

// The suite's recorded answer in that run (objectives/finished/2.json).
const RECORDED_ANSWER =
  "Choose an implementation detail within the Objective's written goal, acceptance criteria, Sources and existing command authority. Do not add authority, relax acceptance or drop capabilities; keep the question open if that is required.";

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
    text: RECORDED_ANSWER,
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
      "Fixture or test values the sources call policy, internal names, file layout and the choice among evidence methods the plan can produce (check 1) are the planner's choice: never an operator question.",
    ),
  );
  // A perceptual media quality need not be in the owner's acceptance, but
  // its worker, who sees only its own item, is still told it.
  assert.ok(
    reviewer.includes(
      "check that the owner's acceptance as a whole delivers it, except a perceptual quality of candidate media, which the owner's result review judges from the Objective criterion itself and the owner's goal or brief states for its worker;",
    ),
  );
  // The CI-only and source-decision routes to the operator remain.
  assert.ok(
    reviewer.includes(
      "it is proved by an integrated-ci proof of a CI check that runs it, or it is an operator decision; never a fix finding asking the plan to run it.",
    ),
  );
  assert.ok(
    reviewer.includes(
      "where proof truly needs an environment local validation lacks, ask through decisionRequired",
    ),
  );
  // A revision round keeps the fix a previous finding asked for, but not a
  // product choice the change made.
  assert.ok(
    reviewer.includes(
      "(d) Where a change does what a previous finding asked for, do not ask to undo it without a new reason that finding did not weigh, and do not raise the evidence method it chose as an operator decision. A product or authority choice the change itself makes is still judged under check 10.",
    ),
  );
  // An answer that leaves the choice to the planner settles only a choice
  // the planner owns; a product choice follows the answer's own terms.
  assert.ok(
    reviewer.includes(
      "An answer that leaves the choice to the planner settles a choice rule 2 leaves to the planner, such as which method the plan can produce evidences a criterion: judge the planner's choice as sound or not. For a product or authority choice, follow the answer's own terms: one that keeps the question open when that is required does not settle it.",
    ),
  );
  // Only an answer that decides a choice settles it, so the note doesn't
  // first say every answer settles its choice.
  assert.ok(
    reviewer.includes(
      "Each answer that decides a choice settles it within the Objective: check that the graph follows it, and do not ask it again as an operator decision.",
    ),
  );
  assert.equal(reviewer.includes("Each answer settles that choice"), false);
});

test("the planner decides an answered or planner-owned question instead of asking it again", async () => {
  const { facts, shown } = await cubeFacts();
  const operator = {
    source: "operator",
    message: `${DEPICTION_QUESTION}\nAnswer: answer — ${RECORDED_ANSWER}`,
  };
  const instructions = renderPlanningInstructions(
    shown.blocks,
    [operator],
    true,
  );
  const settles =
    "An operator answer that decides a question settles it. An answer that leaves the choice to you (such as choosing within the Objective) settles a choice rule 2 leaves to you, such as which method the plan can produce evidences a criterion: make that choice in the plan, keeping the current plan's choice when it is sound, and never ask it again. For a product or authority choice, follow the answer's own terms: one that keeps the question open when that is required does not settle it, so keep your recommendation in the graph and ask again only while that choice is still open. Never ask a question rule 2 leaves to you.";
  // The rule comes before the answer it governs, which arrives whole.
  assert.ok(instructions.indexOf(settles) >= 0);
  assert.ok(
    instructions.indexOf(settles) <
      instructions.indexOf("keep the question open if that is required"),
  );
  const planner = renderCompilationCall({
    facts,
    data: { instructions },
    revising: true,
    lookups: { open: false, bodies: [] },
  }).prompt;
  assert.ok(planner.includes(settles));
  // An answer that keeps a product question open does not settle it.
  assert.equal(
    planner.includes("An operator answer settles the question it answers"),
    false,
  );
  // Rule 2 and the checklist name the evidence method as the planner's, and
  // keep proof that needs CI or a missing environment with the operator.
  assert.ok(
    planner.includes(
      "Choosing fixture or test values the sources call policy, internal names, file layout, which method the plan can produce evidences a criterion and other implementation details is your job, not a product question; proof that needs a CI-only command or an environment local validation lacks is still asked through decisionRequired.",
    ),
  );
  assert.ok(planner.includes(`- Evidence method. ${EVIDENCE_METHOD}`));
  assert.ok(
    planner.includes(
      "prove it by an integrated-ci proof of a CI check that runs it, or ask the operator through decisionRequired.",
    ),
  );
  assert.ok(
    planner.includes(
      "where proof truly needs an environment local validation lacks, ask through decisionRequired",
    ),
  );
  assert.ok(
    planner.includes(
      "the owner's acceptance as a whole must deliver it, except a perceptual quality of candidate media (that a preview depicts its model), which the owner's result review judges from the Objective criterion itself, so no acceptance entry needs to state it; the owner's goal or brief states it, because its worker sees only its own item.",
    ),
  );
  // Without an operator answer the planner is not told about one.
  const unanswered = renderPlanningInstructions(
    shown.blocks,
    [{ source: "review", message: "Fix the coverage." }],
    true,
  );
  assert.equal(unanswered.includes("An operator answer settles"), false);
});
