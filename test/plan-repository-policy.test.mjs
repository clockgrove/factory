// Validation enforces a repository policy only by running the repository's
// own command (#2349). Live, the planner turned an item's share of a
// test-line budget into an inline `node -e` copy of the repository's budget
// script with no allowance: the copy went stale when the script changed,
// and the item failed it while the repository's own check passed. Plan
// review, of a plan and of an amendment alike, refuses such a command and
// names the repository command to run instead.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildFacts } from "../dist/planning/facts.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
  renderPlanningInstructions,
} from "../dist/planning/prompts.js";
import { decodeGraphReview } from "../dist/planning/review.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

const BUDGET = "scripts/test-budget.mjs";
/** The planner's inline copy of the budget script, with no allowance. */
const COPY = `node --input-type=module -e 'import {execSync} from "node:child_process";const n=(p)=>execSync("git diff --numstat "+process.env.FACTORY_BASE_SHA+" -- "+p).toString().split("\\n").filter(Boolean).reduce((s,l)=>s+Number(l.split("\\t")[0]),0);if(n("test")>n("src"))process.exit(1)'`;

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base whose check script runs a test-line budget script. */
async function budgetFacts() {
  const checkout = tempDir("factory-repository-policy-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  for (const [file, text] of [
    [
      "package.json",
      JSON.stringify({
        scripts: { test: "node --test", check: `node ${BUDGET}` },
      }),
    ],
    [BUDGET, "// test lines against production lines, plus an allowance\n"],
    ["src/a.js", "export const a = () => 1;\n"],
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
    "<h2>Goal</h2>\n<p>Add <code>a</code>.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>a()</code> returns <code>1</code>.</li>\n</ul>",
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

const item = {
  kind: "work",
  id: "a",
  title: "Add a",
  goal: "Add a.",
  acceptance: ["a() returns 1."],
  nonGoals: [],
  citations: [{ path: "OBJECTIVE" }],
  dependencies: [],
  ownedPaths: ["src/a.js"],
  validation: [{ command: "npm test" }, { command: COPY }],
  brief: "Export a from src/a.js.",
  priority: 1,
};

test("plan review refuses an inline copy of a repository policy script, naming the repository command, and the planner gets it to fix", async () => {
  const { facts, shown } = await budgetFacts();
  const reviewer = renderGraphReviewCall({
    facts,
    draft: { items: [item] },
    evidence: [],
    decisions: [],
    finalCommands: [],
    controllerCapabilities: {},
  }).prompt;
  // Check 5 carries the rule, and the packet has the script bodies that
  // name the policy script and the command that runs it.
  const check5 = reviewer.indexOf("5. Commands.");
  const check6 = reviewer.indexOf("6. Briefs.");
  const rule = reviewer.indexOf(
    "Flag a validation command that re-implements a repository script's check inline",
  );
  assert.ok(check5 < rule && rule < check6);
  assert.ok(
    reviewer.includes(
      JSON.stringify({ name: "check", body: `node ${BUDGET}` }),
    ),
  );
  // The planner writes a share as guidance, never as a command, and
  // checks its plan by the review's rule.
  const planner = renderCompilationCall({
    facts,
    data: { instructions: "" },
    revising: false,
    lookups: { open: false, bodies: [] },
  }).prompt;
  assert.ok(
    planner.includes(
      "A share is planning guidance, never a validation command: validation enforces a repository policy",
    ),
  );
  assert.ok(planner.includes("- Repository policy. Repository policy:"));

  // The reviewer's finding naming the repository command is the planner's to fix.
  const detail = `Work Item a's validation command 1 re-implements ${BUDGET} inline without its allowance: run \`npm run check\` instead.`;
  const decoded = decodeGraphReview(
    {
      findings: [
        {
          kind: "fix",
          itemIds: ["a"],
          evidenceIndices: [],
          detail,
          question: "",
        },
      ],
    },
    [],
    ["a"],
  );
  assert.equal(decoded.invalid, false);
  const [finding] = decoded.findings;
  assert.equal(finding.kind, "fix");
  assert.equal(finding.itemId, "a");
  assert.ok(finding.message.startsWith(detail));
  assert.ok(
    renderPlanningInstructions(shown.blocks, [finding], true).includes(
      JSON.stringify([
        { source: "review", itemIds: ["a"], detail: finding.message },
      ]),
    ),
  );
});
