// An Objective criterion a `result-command` proof covers is judged by the
// owning item's result review, not only by final review (#2203). Live, a
// plan mapped a criterion requiring a fixture that proves a second kind of
// consumer to a validation command running a test the same Work Item wrote,
// and its acceptance paraphrased the criterion more weakly. The worker wrote
// a stub that echoed its input back, the command passed, and result review
// never saw the criterion: resultCriteria left command-proven ones out, so
// only final review, after every merge, refused it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { correction } from "../dist/repair.js";
import {
  commandProofs,
  REVIEW_GUIDANCE,
  resultCriteria,
  reviewResult,
} from "../dist/review/result.js";
import { workItemContract } from "../dist/work/prompt.js";
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

const CRITERION =
  "A test fixture proves that a second consumer, a plain-text table renderer, builds its own rows from the same `Catalog` records: it imports no type from the JSON renderer, and its test asserts the exact rows it renders for two records.";
const PARAPHRASE =
  "A fixture consumes the same `Catalog` records without the JSON renderer's types.";
const TESTS =
  "The renderer fixture's test passes under `node --test test/tableFixture.test.js`.";
const COMMAND = "node --test test/tableFixture.test.js";

const fixture = item("tableFixture", {
  acceptance: [PARAPHRASE, TESTS],
  ownedPaths: ["src/tableFixture.js", "test/tableFixture.test.js"],
  validation: [{ command: "npm run lint" }, { command: COMMAND }],
});
const qa = item("integratedTests", {
  kind: "qa",
  acceptance: ["`npm test` passes on the integrated result."],
  dependencies: ["tableFixture"],
  validation: [{ command: "npm test" }],
});

/** The plan: the criterion proven by the fixture's own test command, and QA's integrated command. */
function covered(work = fixture) {
  return plan([work, qa], {
    coverage: [
      {
        source: { path: "OBJECTIVE", text: CRITERION },
        itemId: work.id,
        proof: { kind: "result-command", validationIndex: 1 },
        environment: null,
      },
      {
        source: { path: "OBJECTIVE", text: "`npm test` passes." },
        itemId: qa.id,
        proof: { kind: "integrated-command", validationIndex: 0 },
        environment: null,
      },
    ],
  });
}

/** A result whose test passes on a stub that only echoes its input. */
function stubResult() {
  const checkout = join(tempDir("factory-command-proven-"), "w");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--quiet");
  writeFileSync(join(checkout, "README.md"), "base\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  const base = git(checkout, "rev-parse", "HEAD");
  mkdirSync(join(checkout, "src"));
  mkdirSync(join(checkout, "test"));
  writeFileSync(
    join(checkout, "src/tableFixture.js"),
    "export const render = (records) => records;\n",
  );
  writeFileSync(
    join(checkout, "test/tableFixture.test.js"),
    'import assert from "node:assert";\nimport { render } from "../src/tableFixture.js";\nassert.deepEqual(render([{ id: 1 }]), [{ id: 1 }]);\n',
  );
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "fixture");
  const head = git(checkout, "rev-parse", "HEAD");
  return {
    checkout,
    base,
    head,
    tree: git(checkout, "rev-parse", `${head}^{tree}`),
  };
}

test("result review judges an Objective criterion a result-command proves, and the worker is held to it verbatim (#2203)", () => {
  const accepted = covered();
  assert.deepEqual(resultCriteria(accepted, fixture), [
    PARAPHRASE,
    TESTS,
    CRITERION,
  ]);
  assert.deepEqual(commandProofs(accepted, fixture), [
    { criterionIndex: 2, validationIndex: 1, command: COMMAND },
  ]);
  assert.ok(
    workItemContract(accepted, fixture).includes(
      `Acceptance:\n[0] ${PARAPHRASE}\n[1] ${TESTS}\n[2] ${CRITERION}\nCriterion [2] is also judged by this item's result review for the Objective, quoted exactly as the source states it`,
    ),
  );
  // QA's integrated-command criterion is judged where it was: final review.
  assert.deepEqual(resultCriteria(accepted, qa), qa.acceptance);
  assert.deepEqual(commandProofs(accepted, qa), []);
});

test("a command-proven criterion the acceptance states word for word keeps its place and its command (#2203)", () => {
  const work = { ...fixture, acceptance: [CRITERION, TESTS] };
  const accepted = covered(work);
  assert.deepEqual(resultCriteria(accepted, work), [CRITERION, TESTS]);
  assert.deepEqual(commandProofs(accepted, work), [
    { criterionIndex: 0, validationIndex: 1, command: COMMAND },
  ]);
});

test("the review is told a passing command is required, not sufficient, and its refusal reaches the repair at the criterion's number (#2203)", async () => {
  const repo = stubResult();
  const accepted = { ...covered(), base: repo.base };
  const prompts = [];
  const review = await reviewResult({
    planner: {
      async answer(call) {
        prompts.push(call.prompt);
        // Evidence row 1 is the change index, row 2 the validation passes.
        return {
          value: {
            findings: [
              {
                criterionIndex: 0,
                verdict: "pass",
                evidenceIndices: [1],
                detail: "The fixture imports nothing from the JSON renderer.",
                question: "",
              },
              {
                criterionIndex: 1,
                verdict: "pass",
                evidenceIndices: [2],
                detail: "The command passed on this tree.",
                question: "",
              },
              {
                criterionIndex: 2,
                verdict: "refuse",
                evidenceIndices: [1, 2],
                detail:
                  "Missing verification: test/tableFixture.test.js:3 asserts render echoes its input; no table rows are built or asserted.",
                question: "",
              },
            ],
          },
        };
      },
    },
    plan: accepted,
    item: fixture,
    checkout: repo.checkout,
    base: repo.base,
    commit: repo.head,
    validation: { tree: repo.tree, commands: ["npm run lint", COMMAND] },
    sources: [],
    dir: tempDir("factory-command-proven-root-"),
    signal: AbortSignal.timeout(60_000),
    log() {},
  });
  assert.equal(prompts.length, 1);
  const [prompt] = prompts;
  assert.ok(
    prompt.includes(
      JSON.stringify({ criterionIndex: 2, criterion: CRITERION }),
    ),
    "the criterion is judged verbatim",
  );
  assert.ok(
    prompt.includes(
      `Command-proven criteria: the plan proves criterion 2 by validation command 1 (${JSON.stringify(COMMAND)}) of this Work Item; the Validation command passes row lists each command at that index, and it passed on this tree. When a criterion states only what that command's own exit decides`,
    ),
    prompt,
  );
  // Proof asked for once (#2241) keeps its strength: a stub is still refused,
  // and the review is told a duplicate test or copied harness is a finding.
  assert.ok(
    prompt.includes(
      "a fixture that only stores and echoes its input where the criterion requires a real consumer or producer), or a test the command does not run, leaves the criterion unproven",
    ),
  );
  assert.ok(prompt.includes(REVIEW_GUIDANCE.findings));
  // A quantified criterion is judged over its class, siblings included (#2272).
  assert.ok(prompt.includes(REVIEW_GUIDANCE.quantified));
  assert.ok(
    prompt.includes(
      "A test this result adds that proves again a claim another test in the tree already proves, or a harness or fixture setup it copies instead of importing, is a test-economy violation: refuse it, citing both locations.",
    ),
  );
  assert.equal(review.kind, "refused", JSON.stringify(review));
  assert.deepEqual(
    review.refused.map(({ criterionIndex, criterion }) => [
      criterionIndex,
      criterion,
    ]),
    [[2, CRITERION]],
  );

  const repaired = await correction({
    planner: {
      answer: async () => {
        throw new Error("diagnosis called");
      },
    },
    plan: accepted,
    item: fixture,
    finding: { kind: "review", tree: review.tree, refused: review.refused },
    checkout: repo.checkout,
    base: repo.base,
    commit: repo.head,
    sources: [],
    prior: [],
    validate: true,
    signal: AbortSignal.timeout(60_000),
    log() {},
  });
  assert.equal(repaired.kind, "correction", JSON.stringify(repaired));
  assert.equal(repaired.correction.source, "review-findings");
  const findings = JSON.parse(
    repaired.correction.correction.slice(
      repaired.correction.correction.indexOf("\n") + 1,
    ),
  );
  assert.deepEqual(
    findings.map(({ criterionIndex, criterion }) => [
      criterionIndex,
      criterion,
    ]),
    [[2, CRITERION]],
  );
});

test("a review of an item with no command-proven criterion says nothing about them (#2203)", async () => {
  const repo = stubResult();
  const work = { ...fixture, acceptance: [PARAPHRASE] };
  const prompts = [];
  await reviewResult({
    planner: {
      async answer(call) {
        prompts.push(call.prompt);
        return {
          value: {
            findings: [
              {
                criterionIndex: 0,
                verdict: "pass",
                evidenceIndices: [1],
                detail: "Met.",
                question: "",
              },
            ],
          },
        };
      },
    },
    plan: { ...plan([work]), base: repo.base },
    item: work,
    checkout: repo.checkout,
    base: repo.base,
    commit: repo.head,
    validation: { tree: repo.tree, commands: ["npm run lint", COMMAND] },
    sources: [],
    dir: tempDir("factory-command-proven-root-"),
    signal: AbortSignal.timeout(60_000),
    log() {},
  });
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes("Command-proven criteria"));
});
