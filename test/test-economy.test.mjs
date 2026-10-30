// Workers, reviewers and the planner prove each claim once (#2241). Live, an
// Objective's tests grew by duplication past the repository's test budget:
// two items each asserted one enumerated claim in full, once as an Objective
// criterion and once as a source line; one item rebuilt another's harness;
// each listed word got its own assertion; and a review asked for a test of a
// rule about a layer the candidate didn't implement.
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
import { ENGINEERING_STANDARD } from "../dist/planning/rubric.js";
import { REVIEW_GUIDANCE } from "../dist/review/result.js";
import { readShown } from "../dist/shown.js";
import { PROOF_ECONOMY, prepareWorkPrompt } from "../dist/work/prompt.js";
import { item, plan, tempDir } from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function repository() {
  const checkout = join(tempDir("factory-test-economy-"), "w");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ name: "target", scripts: { test: "node --test" } }),
  );
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  return { checkout, base: git(checkout, "rev-parse", "HEAD") };
}

const CLAIM =
  "`create`, `rename` and `delete` each refuse a read-only token with status 403.";

const CLAIM_ONCE =
  "Each distinct claim is assigned to one item, even when it appears both as an Objective criterion and in a pinned source's lines: flag a plan in which two items must each prove the same claim, and keep it with one owner.";
const SHARED_HARNESS =
  "Where several items' tests need the same harness or fixture setup (a runtime, browser or service harness), the first item that needs it owns it as a shared module, and the items after it that need it depend on that item and reuse it: flag a plan that leaves each of them to build its own.";

async function planningFacts() {
  const { checkout, base } = repository();
  const shown = readShown(
    `<h2>Goal</h2>\n<p>Refuse writes with a read-only token.</p>\n<h2>Acceptance</h2>\n<ul>\n<li>${CLAIM}</li>\n<li><code>npm test</code> passes.</li>\n</ul>`,
    { sources: true },
  );
  const built = await buildFacts({ objective: 3, shown, base, checkout });
  assert.ok(built.facts, JSON.stringify(built.problems));
  return { facts: built.facts, shown, base };
}

test("graph review flags one claim proved by two items and a harness each item builds, and the planner checks both (#2241)", async () => {
  const { facts, shown, base } = await planningFacts();
  // A synthetic plan with the defect: the Objective criterion on one item,
  // the same claim as a source line on another, and two journeys each with
  // their own harness.
  const api = item("tokenRefusal", {
    acceptance: [CLAIM],
    ownedPaths: ["src/tokens.js", "test/tokens.test.js"],
    validation: [{ command: "npm test" }],
  });
  const journey = item("refusalJourney", {
    acceptance: [`A browser journey shows that ${CLAIM}`],
    ownedPaths: ["test/journey/refusal.test.js", "test/journey/harness.js"],
    dependencies: ["tokenRefusal"],
    validation: [{ command: "npm test" }],
  });
  const draft = {
    ...plan([api, journey], {
      coverage: [
        {
          source: { path: "OBJECTIVE", text: CLAIM },
          itemId: api.id,
          proof: { kind: "result-semantic" },
          environment: null,
        },
        {
          source: { path: "docs/spec.md", lines: [3, 3] },
          statement: CLAIM,
          itemId: journey.id,
          proof: { kind: "result-semantic" },
          environment: null,
        },
      ],
    }),
    base,
  };
  const reviewer = renderGraphReviewCall({
    facts,
    draft,
    evidence: [],
    decisions: [],
    finalCommands: [],
    controllerCapabilities: {},
  }).prompt;
  const check = (n, title) => reviewer.indexOf(`${n}. ${title}`);
  const claim = reviewer.indexOf(CLAIM_ONCE);
  assert.ok(
    check(1, "Acceptance coverage.") < claim &&
      claim < check(2, "Constraints and scope."),
    "check 1 holds the one-owner rule",
  );
  const harness = reviewer.indexOf(SHARED_HARNESS);
  assert.ok(
    check(3, "Decomposition and ownership.") < harness &&
      harness < check(4, "Phases."),
    "check 3 holds the shared-harness rule",
  );
  // The reviewer sees both coverage entries of the one claim.
  assert.ok(
    reviewer.includes(JSON.stringify(draft.coverage)),
    "the graph is shown",
  );

  const planner = renderCompilationCall({
    facts,
    data: { instructions: renderPlanningInstructions(shown.blocks, [], true) },
    revising: false,
    lookups: { open: false, bodies: [] },
  }).prompt;
  assert.ok(planner.includes(CLAIM_ONCE));
  assert.ok(planner.includes(`- Shared harness. ${SHARED_HARNESS}`));
});

test("the engineering standard and the review's verification standard bound proof to one test per claim (#2241)", () => {
  assert.ok(
    ENGINEERING_STANDARD.includes(
      "- Test economy: prove each claim once, through the strongest existing or added integration test; extend an existing test or harness in your owned paths before adding one, and import one you don't own instead of copying it; don't re-prove a claim that a dependency's merged test already proves. Apply the repository's cited testing policy on test kind, count, reuse and budget.\n",
    ),
  );
  // Result and final review share it; proof strength stays.
  const { findings } = REVIEW_GUIDANCE;
  for (const rule of [
    "a criterion is proven by the strongest test that establishes it by this standard, a dependency's merged test the review base already holds included (in base/, or unchanged in candidate/), so a claim such a test proves needs no second test;",
    "the enumerated items of one sentence may share one table-driven assertion that checks each item's exact value;",
    "a prohibition on behaviour the candidate does not implement is proven by source evidence, over its complete scope, that no such path exists, cited in place of a mutation;",
    "a missing-verification finding asks for the smallest assertion that proves the omitted fact, added to an existing test within the candidate's accepted ownership that covers that behaviour where one does.",
    "A verification deliverable proves a sub-clause only when its assertion would fail if that sub-clause were wrong",
    "when you cannot name one, the criterion lacks verification: refuse it as missing verification, naming the surviving mutation.",
  ])
    assert.ok(findings.includes(rule), rule);
});

test("the worker adds missing proof inside existing tests and leaves budget headroom, first and in repair (#2241)", async () => {
  const { checkout, base } = repository();
  const work = item("tokenRefusal", {
    acceptance: [CLAIM],
    ownedPaths: ["src/tokens.js", "test/tokens.test.js"],
    validation: [{ command: "npm test" }],
  });
  const input = {
    checkout,
    worktree: checkout,
    objective: 3,
    plan: { ...plan([work]), base },
    item: work,
    base,
    fixedScripts: [],
  };
  const first = await prepareWorkPrompt(input);
  assert.equal(first.problem, undefined);
  assert.ok(first.prompt.includes(ENGINEERING_STANDARD));
  assert.ok(
    first.prompt.includes(
      `and add what is missing before your final validation run. ${PROOF_ECONOMY} The reviewer`,
    ),
  );
  assert.ok(
    first.prompt.includes(
      "The enumerated items of one sentence may share one table-driven assertion that checks each item's exact value.",
    ),
  );
  assert.equal(first.prompt.includes("add whatever is missing"), false);
  // Economy stays inside ownership and never removes an existing test.
  for (const rule of [
    "Add missing proof as assertions inside an existing test in your owned paths that covers that behaviour where one does, not as a new test or harness; import a test setup you don't own, never copy it.",
    "Never add a test or setup that duplicates one the repository already has, and remove duplication among the tests and setup you add; existing tests stay protected.",
    "final validation runs it on the Objective's integrated change, where every Work Item's additions count against it.",
  ])
    assert.ok(PROOF_ECONOMY.includes(rule), rule);
  assert.equal(/remove a test|remove what/.test(PROOF_ECONOMY), false);
  assert.ok(
    first.prompt.includes(
      "Existing tests are protected: change an existing assertion, golden or baseline only where an acceptance entry states that behaviour change.",
    ),
  );

  const repaired = await prepareWorkPrompt({
    ...input,
    repair: { finding: "Missing verification: `rename` is not asserted." },
  });
  assert.equal(repaired.problem, undefined);
  assert.ok(
    repaired.prompt.includes(
      `a test edit can drop another clause's check. ${PROOF_ECONOMY}`,
    ),
  );
});
