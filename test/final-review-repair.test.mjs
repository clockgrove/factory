// Final review's refusal had two answers (#2204): `retry` after the
// operator fixed the default branch by hand, outside review and validation,
// or `replan`, which drops the plan and its build. A refusal of a criterion
// one Work Item owns now has a third, recommended: `repair` sends the
// refused criteria, verbatim, with final review's findings, to a repair of
// that item against the default branch; it goes through its usual steps,
// and final validation and final review run again once it merges.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectiveRunner } from "../dist/engine.js";
import { ACCEPTED_AT } from "../dist/planning/plan.js";
import { correction } from "../dist/repair.js";
import { newObjective } from "../dist/state.js";
import { fact, facts } from "../dist/work/facts.js";
import {
  deliverySteps,
  finalRefusal,
  finalRepairRoute,
  finalReviewStep,
  PHASES,
  refusalOffers,
  stepKey,
} from "../dist/work/steps.js";
import { objectiveWorkflow } from "../dist/workflow.js";
import { item, plan, tempDir } from "./helpers.mjs";

const BASE = "b".repeat(40);
const HEAD = "d".repeat(40);
const TREE = "e".repeat(40);
const ACCEPTED = "2026-10-29T00:00:00.000Z";
const PARSE = "Parsing an empty document returns an empty list.";
const RENDER = "Rendering an empty list writes nothing.";
const DETAIL =
  "test/parse.test.js only asserts that parsing an empty document does not throw; nothing checks the list it returns.";

/** An Objective criterion owned by `itemId`, proved by `proof`. */
const covered = (text, itemId, proof = { kind: "final-review" }) => ({
  source: { path: "OBJECTIVE", text },
  itemId,
  proof,
  environment: {
    kind: "local",
    readiness: "available",
    probe: "npm test",
    preparedBy: itemId,
  },
});

/** Two coding items, `render` building on `parse`, each owning one criterion. */
const PLAN = plan(
  [
    item("parse", {
      acceptance: ["parse() returns a list of entries."],
      ownedPaths: ["src/parse.js", "test/parse.test.js"],
      validation: [{ command: "npm test" }],
    }),
    item("render", {
      dependencies: ["parse"],
      acceptance: ["render() writes each entry."],
      ownedPaths: ["src/render.js", "test/render.test.js"],
      validation: [{ command: "npm test" }],
    }),
  ],
  {
    base: BASE,
    coverage: [
      covered(PARSE, "parse"),
      covered(RENDER, "render", { kind: "result-semantic" }),
    ],
  },
);

/** What the steps need of the installation here: nothing runs. */
const deps = (delivery = "regular") => ({
  config: {
    delivery: { kind: delivery },
    validation: { commandTimeoutSeconds: 60 },
  },
});

/** Final review's refusal of `refused` (criterion texts, numbered from 1 in that order). */
function refusal(refused) {
  return {
    kind: "refused",
    tree: TREE,
    refused: refused.map((criterion, criterionIndex) => ({
      criterionIndex,
      criterion,
      source: "model",
      detail:
        criterion === PARSE ? DETAIL : "Not shown on the integrated tree.",
      question: "",
      evidence: [
        {
          origin: "worker",
          path: "test/parse.test.js",
          file: "test/parse.test.js",
          complete: true,
        },
      ],
    })),
    verdicts: [],
    questions: [],
  };
}

/** One item's steps, all done, merged at `merge`. */
function delivered(state, id, merge, at) {
  const commit = `${id[0]}`.repeat(40);
  state.done[stepKey(id, "work")] = {
    base: BASE,
    commit,
    tree: commit,
    notes: [],
    sets: [],
  };
  state.done[stepKey(id, "validate")] = {
    tree: commit,
    commands: ["npm test"],
  };
  state.done[stepKey(id, "review")] = { tree: commit };
  state.done[stepKey(id, "publish")] = { pr: 7, head: commit, merged: false };
  state.done[stepKey(id, "ci")] = { head: commit, merged: false };
  state.done[stepKey(id, "merge")] = {
    mergeSha: merge,
    integratedSha: merge,
    at,
  };
  Object.assign(
    state.kept,
    facts({ base: BASE, pushed: [commit] }, id),
    facts({ refused: { commit, tree: commit, notes: [] } }, id),
  );
}

/**
 * An Objective whose two items merged and passed final validation, held at
 * final review's refusal of `refused` as the final-review step holds
 * (finalRefusal, with the facts it keeps).
 */
function harness(refused = [PARSE], delivery = "regular") {
  const state = newObjective(900, new Date());
  state.status = "finishing";
  state.done.check = true;
  state.done.plan = PLAN;
  state.kept[ACCEPTED_AT] = ACCEPTED;
  delivered(state, "parse", "1".repeat(40), "2026-10-29T01:00:00.000Z");
  delivered(state, "render", "2".repeat(40), "2026-10-29T02:00:00.000Z");
  state.done.final = { commit: HEAD, tree: TREE, commands: ["npm test"] };
  const installation = deps(delivery);
  const runner = new ObjectiveRunner(
    state,
    objectiveWorkflow(installation),
    tempDir("factory-final-repair-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
  );
  const review = refusal(refused);
  runner.apply("final-review", {
    ...finalRefusal(PLAN, review, installation),
    keep: facts({ "final-review:refused": true, "final-review:held": review }),
  });
  const step = finalReviewStep(installation);
  /** The final-review step run once with its answer; its outcome. */
  const run = () =>
    step.run({
      state: structuredClone(runner.state),
      answer: runner.state.answers["final-review"],
      signal: AbortSignal.timeout(60_000),
      log() {},
      runFile() {
        throw new Error("no run file");
      },
      keep() {},
    });
  const answer = (given) =>
    runner.transact(() =>
      runner.answer(
        given,
        undefined,
        "kirk",
        undefined,
        runner.state.holds[0].id,
      ),
    );
  return { runner, installation, run, answer };
}

const form = (option) => [option.answer, option.arg].filter(Boolean).join(" ");
const keys = (steps) => steps.map((step) => step.key);

test("final review's refusal of one item's criterion offers repair first, and explains all three answers", () => {
  const { runner } = harness();
  const [held] = runner.state.holds;
  assert.equal(held.step, "final-review");
  assert.deepEqual(held.options.map(form), [
    "repair",
    "retry",
    "replan",
    "accept 1",
    "cancel",
  ]);
  const [repair] = held.options;
  assert.equal(repair.recommended, true);
  assert.equal(repair.family, "repair");
  assert.match(
    repair.consequence,
    /^Repairs Work Item parse against the current default branch/,
  );
  assert.ok(held.question.includes(`1. ${PARSE}: ${DETAIL}`), held.question);
  assert.ok(
    held.question.includes(
      "Answer `repair` to send criterion 1 back to Work Item parse, which owns it in the plan's coverage: parse is repaired against the current default branch with that criterion, verbatim, and the findings above, goes through its validation, result review, CI and merge again on a new PR, and then final validation and final review run again.",
    ),
    held.question,
  );
  assert.match(
    held.question,
    /Answer `retry` once you have fixed it on the default branch yourself/,
  );
  assert.match(
    held.question,
    /Answer `replan` to plan the remaining work again/,
  );
});

test("repair reopens only the owning item, with the refused criterion verbatim, and final review runs again after its merge", async () => {
  const { runner, installation, run, answer } = harness();
  assert.equal(answer("repair"), null);
  const outcome = await run();
  assert.equal(outcome.kind, "repair");
  assert.equal(outcome.target, stepKey("parse", "work"));
  assert.deepEqual(outcome.clear, [
    ...PHASES.map((phase) => stepKey("parse", phase)),
    "final",
    "final-review",
  ]);
  runner.apply("final-review", outcome);
  const { state } = runner;

  // Only parse is reopened; render's merge stands (neither has media to select).
  for (const phase of PHASES.filter((phase) => phase !== "select")) {
    assert.equal(state.done[stepKey("parse", phase)], undefined, phase);
    assert.ok(state.done[stepKey("render", phase)], phase);
  }
  assert.equal(state.done.final, undefined);
  assert.equal(state.done["final-review"], undefined);
  assert.deepEqual(state.holds, []);
  // A repair of parse's work like any other: counted on its path.
  assert.equal(state.repairs[stepKey("parse", "work")].count, 1);
  assert.equal(state.repairs[stepKey("render", "work")], undefined);
  // Its finding is final review's, verbatim; it starts again on the
  // default branch, with no refused result, and publishes on a new PR.
  const finding = fact(state, "finding", "parse");
  assert.equal(finding.kind, "review");
  assert.equal(finding.final, true);
  assert.equal(finding.tree, TREE);
  assert.deepEqual(
    finding.refused.map((entry) => [entry.criterion, entry.detail]),
    [[PARSE, DETAIL]],
  );
  assert.equal(fact(state, "base", "parse"), undefined);
  assert.equal(fact(state, "refused", "parse"), undefined);
  assert.equal(fact(state, "republish", "parse"), true);
  assert.deepEqual(fact(state, "pushed", "parse"), ["p".repeat(40)]);
  assert.equal(fact(state, "final-review:refused"), undefined);
  assert.equal(fact(state, "final-review:held"), undefined);
  assert.equal(objectiveWorkflow(installation).status(state), "building");
  assert.deepEqual(keys(deliverySteps(state, installation)), [
    stepKey("parse", "work"),
  ]);
  // The worker's question about it offers no `accept <n>`: final review's
  // criteria are decided there.
  assert.deepEqual(refusalOffers(finding), { note: "", options: [] });

  // The worker gets the refused criterion and final review's finding as
  // its correction, with no diagnosis call.
  const fixed = await correction({
    planner: {
      answer: async () => assert.fail("no diagnosis"),
    },
    plan: PLAN,
    item: PLAN.items[0],
    finding,
    checkout: "/nonexistent",
    base: HEAD,
    commit: HEAD,
    sources: [],
    prior: [],
    repair: 1,
    validate: false,
    signal: AbortSignal.timeout(60_000),
    log() {},
  });
  assert.equal(fixed.kind, "correction");
  assert.equal(fixed.correction.source, "final-review");
  assert.ok(
    fixed.finding.startsWith(
      "The previous attempt failed: final review refused the integrated result on the findings in the required correction below.",
    ),
    fixed.finding,
  );
  assert.ok(fixed.correction.correction.includes(JSON.stringify(PARSE)));
  assert.ok(fixed.correction.correction.includes(JSON.stringify(DETAIL)));
  assert.match(
    fixed.correction.diagnosis,
    /^Final review refused 1 Objective criterion this Work Item owns/,
  );
  // Taken once: the next final refusal of parse goes on to the diagnosis,
  // which reads the result from Git (none here).
  await assert.rejects(
    correction({
      planner: {
        answer: async () => {
          throw new Error("diagnosed");
        },
      },
      plan: PLAN,
      item: PLAN.items[0],
      finding,
      checkout: "/nonexistent",
      base: HEAD,
      commit: HEAD,
      sources: [],
      prior: [fixed.correction],
      repair: 2,
      validate: false,
      signal: AbortSignal.timeout(60_000),
      log() {},
    }),
  );

  // parse goes through its steps again and merges; then final validation
  // and final review run again.
  const again = "3".repeat(40);
  for (const phase of PHASES.slice(0, -1))
    runner.apply(stepKey("parse", phase), {
      kind: "done",
      result: { tree: again, head: again, commit: again, base: HEAD },
    });
  assert.deepEqual(keys(deliverySteps(runner.state, installation)), [
    stepKey("parse", "merge"),
  ]);
  runner.apply(stepKey("parse", "merge"), {
    kind: "done",
    result: {
      mergeSha: again,
      integratedSha: again,
      at: "2026-10-29T03:00:00.000Z",
    },
  });
  assert.deepEqual(keys(deliverySteps(runner.state, installation)), ["final"]);
  runner.apply("final", {
    kind: "done",
    result: { commit: again, tree: again, commands: ["npm test"] },
  });
  assert.deepEqual(keys(deliverySteps(runner.state, installation)), [
    "final-review",
  ]);
});

test("retry still validates the fixed default branch again, then reviews it", async () => {
  const { runner, installation, run, answer } = harness();
  assert.equal(answer("retry"), null);
  const outcome = await run();
  assert.deepEqual(
    [outcome.kind, outcome.target, outcome.clear],
    ["repair", "final", ["final", "final-review"]],
  );
  runner.apply("final-review", outcome);
  assert.ok(runner.state.done[stepKey("parse", "merge")]);
  assert.ok(runner.state.done[stepKey("render", "merge")]);
  assert.equal(runner.state.repairs[stepKey("parse", "work")], undefined);
  assert.deepEqual(keys(deliverySteps(runner.state, installation)), ["final"]);
});

test("replan still drops the plan and its build", () => {
  const { runner, answer } = harness();
  assert.equal(answer("replan"), null);
  runner.tick();
  assert.equal(runner.state.done.plan, undefined);
  assert.equal(runner.state.done[stepKey("parse", "merge")], undefined);
  assert.equal(runner.state.done[stepKey("render", "merge")], undefined);
  assert.equal(runner.state.kept.rerun, true);
  assert.equal(runner.state.repairs[stepKey("parse", "work")], undefined);
});

test("a refused criterion no coding item owns alone offers no repair, and says why", () => {
  const integration =
    'Integration of Work Item "render" with its dependency "parse" on the integrated tree.';
  for (const [refused, delivery] of [
    // An integration question has no coverage entry.
    [[integration], "regular"],
    [[PARSE, integration], "regular"],
    // A native stack merges as one: its layer can't reopen alone.
    [[PARSE], "native-stack"],
  ]) {
    const { runner } = harness(refused, delivery);
    const [held] = runner.state.holds;
    assert.deepEqual(
      held.options.map(form).filter((answer) => !answer.startsWith("accept")),
      ["retry", "replan", "cancel"],
    );
    assert.equal(held.options[0].recommended, true);
    assert.match(held.question, /There is no `repair`/);
  }
  // Two coding items covering one criterion share it: no owner.
  const shared = {
    ...PLAN,
    coverage: [...PLAN.coverage, covered(PARSE, "render")],
  };
  assert.equal(
    finalRepairRoute(shared, refusal([PARSE]).refused, deps()),
    undefined,
  );
});

test("criteria two items own go back one item at a time", () => {
  const { runner } = harness([PARSE, RENDER]);
  const [held] = runner.state.holds;
  assert.equal(held.options[0].answer, "repair");
  assert.match(held.question, /send criterion 1 back to Work Item parse/);
  assert.match(
    held.question,
    /Other Work Items own criterion 2: final review judges it again once parse merges, and offers `repair` for it then\./,
  );
  const route = finalRepairRoute(
    PLAN,
    refusal([PARSE, RENDER]).refused,
    deps(),
  );
  assert.equal(route.item.id, "parse");
  assert.deepEqual(
    route.refused.map((entry) => entry.criterion),
    [PARSE],
  );
  assert.deepEqual(
    route.later.map((entry) => entry.criterion),
    [RENDER],
  );
});

test("a refusal held by 0.5.9, which offered no repair, still takes retry and refuses repair", async () => {
  const { runner, run } = harness();
  // As 0.5.9 asked it: the same facts, without the `repair` option.
  const [held] = runner.state.holds;
  held.options = held.options.filter((option) => option.answer !== "repair");
  held.options[0].recommended = true;
  const refused = runner.transact(() =>
    runner.answer("repair", undefined, "kirk", undefined, held.id),
  );
  assert.equal(refused?.code, "invalid_answer");
  assert.equal(
    runner.transact(() =>
      runner.answer("retry", undefined, "kirk", undefined, held.id),
    ),
    null,
  );
  const outcome = await run();
  assert.equal(outcome.target, "final");
});
