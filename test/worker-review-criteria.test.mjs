// A worker is held to every criterion its result review judges, so it gets
// them all, numbered as the review numbers them (#2175). In run
// 2026-10-28T204933PDT-180b (Claude lane, main, happy.claude), the plan's
// acceptance for the counter item paraphrased the Objective criterion as
// "including the pinned examples for "banana", "Banana", and the empty
// string" and covered the criterion itself with a result-semantic proof.
// The worker's prompt listed only the paraphrase and cited no OBJECTIVE, so
// it never saw that `countCharQudbz("Banana", "b")` is `0`: it tested
// ("Banana", "a") instead, and final review refused the Objective criterion.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resultCriteria } from "../dist/review/result.js";
import { readHandoffNotes } from "../dist/work/collect.js";
import { prepareWorkPrompt, workItemContract } from "../dist/work/prompt.js";
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
  const worktree = join(tempDir("factory-criteria-"), "w");
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "--quiet");
  writeFileSync(join(worktree, "README.md"), "base\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  return { worktree, base: git(worktree, "rev-parse", "HEAD") };
}

const CRITERION =
  '`countCharQudbz(s, ch)` returns how many times the single character `ch` occurs in `s`, case-sensitive: `countCharQudbz("banana", "a")` is `3`, `countCharQudbz("Banana", "b")` is `0` and `countCharQudbz("", "a")` is `0`.';
const PARAPHRASE =
  '`countCharQudbz(s, ch)` returns the number of occurrences of the single character `ch` in `s`, case-sensitively, including the pinned examples for `"banana"`, `"Banana"`, and the empty string.';
const TESTS = "The dedicated `countCharQudbz` tests pass under `npm test`.";

const counter = item("countCharQudbz", {
  acceptance: [PARAPHRASE, TESTS],
  ownedPaths: ["src/countCharQudbz.js", "test/countCharQudbz.test.js"],
  validation: [{ command: "npm test" }],
});
const qa = item("integratedNpmTest", {
  kind: "qa",
  acceptance: ["`npm test` passes on the integrated result."],
  dependencies: ["countCharQudbz"],
  validation: [{ command: "npm test" }],
});

function covered(acceptance = counter.acceptance, fields = {}) {
  const work = { ...counter, acceptance };
  return {
    work,
    accepted: plan([work, qa], {
      coverage: [
        {
          source: { path: "OBJECTIVE", text: CRITERION },
          itemId: work.id,
          proof: { kind: "result-semantic" },
          environment: null,
        },
        {
          source: { path: "OBJECTIVE", text: "`npm test` passes." },
          itemId: qa.id,
          proof: { kind: "integrated-command", validationIndex: 0 },
          environment: null,
        },
      ],
      ...fields,
    }),
  };
}

test("the worker's Acceptance is every criterion its result review judges, the Objective's own text after the item's (#2175)", async () => {
  const { worktree, base } = repository();
  const { work, accepted } = covered();
  accepted.base = base;
  // The review judges the paraphrase and the Objective criterion it stands for.
  assert.deepEqual(resultCriteria(accepted, work), [
    PARAPHRASE,
    TESTS,
    CRITERION,
  ]);
  const prepared = await prepareWorkPrompt({
    checkout: worktree,
    worktree,
    objective: 8,
    objectiveBody: `## Acceptance\n\n- ${CRITERION}\n- \`npm test\` passes.\n`,
    plan: accepted,
    item: work,
    base,
    fixedScripts: [],
  });
  assert.equal(prepared.problem, undefined);
  const contract = workItemContract(accepted, work);
  assert.ok(prepared.prompt.includes(contract));
  assert.ok(
    contract.includes(
      `Acceptance:\n[0] ${PARAPHRASE}\n[1] ${TESTS}\n[2] ${CRITERION}\nCriteria [2] to [2] are what this item's result review also proves for the Objective, exactly as their source states them: meet each as written, every value and example in it included, as you meet the ones before.\nOwned paths:\n`,
    ),
    contract,
  );
  // The pinned example the paraphrase dropped reaches the worker.
  assert.ok(prepared.prompt.includes('`countCharQudbz("Banana", "b")` is `0`'));
});

test("an item whose acceptance states the covered criterion word for word keeps its contract as it was (#2175)", () => {
  const { work, accepted } = covered([CRITERION, TESTS]);
  assert.deepEqual(resultCriteria(accepted, work), [CRITERION, TESTS]);
  assert.equal(
    workItemContract(accepted, work),
    `Title: ${work.title}\nGoal: ${work.goal}\nAcceptance:\n[0] ${CRITERION}\n[1] ${TESTS}\nOwned paths:\n${work.ownedPaths.join("\n")}`,
  );
});

test("a verification note for a covered Objective criterion decodes at its review's index, and one past it is refused (#2175)", async () => {
  const { worktree } = repository();
  const { work, accepted } = covered();
  const note = (criterionIndex) => ({
    kind: "verification",
    criterionIndex,
    summary: `criterion ${criterionIndex}: test/countCharQudbz.test.js:6-8`,
    paths: ["test/countCharQudbz.test.js"],
    consumerIndices: [],
  });
  const manifest = join(worktree, ".factory-handoff.json");
  writeFileSync(manifest, JSON.stringify({ notes: [0, 1, 2].map(note) }));
  const notes = await readHandoffNotes(worktree, accepted, work);
  assert.ok(Array.isArray(notes), JSON.stringify(notes));
  assert.deepEqual(
    notes.map((decoded) => decoded.criterionIndex),
    [0, 1, 2],
  );
  writeFileSync(manifest, JSON.stringify({ notes: [0, 1, 2, 3].map(note) }));
  const refused = await readHandoffNotes(worktree, accepted, work);
  assert.match(
    refused.problem,
    /criterionIndex 3 names no acceptance criterion of this Work Item \(it has 3\)/,
  );
});
