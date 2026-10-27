// A repair-diagnosis question offered `revalidate` in its text, but the
// answer was refused (#2120): the service runs every Objective through
// providerWorkflow, which dropped the workflow's Work Item answers
// (`revalidatable`, `freshable` and the rest), so the engine never offered
// them, while the step wrote its own sentence offering `revalidate`. The
// engine now writes that sentence where it offers the answer, and the
// provider routing passes each answer on to the frozen provider's workflow.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectiveRunner, hold } from "../dist/engine.js";
import { providerWorkflow } from "../dist/providers/selection.js";
import { newObjective } from "../dist/state.js";
import { objectiveWorkflow } from "../dist/workflow.js";
import { item, plan, REPO, tempDir } from "./helpers.mjs";

const ID = "trusted-narrowing-proof";
const WORK = `item:${ID}:work`;
const BASE = "dc3e31082a400f4d93170263b260f675aff62fc4";
const HEAD = "cd38dc1124a824da19ceb7509740adccd66d5869";
const TREE = "aa2393dc8427bf89ce2796b2df5ca090f527651b";

/** The workflow as the service builds it: one provider's, routed by what the Objective froze. */
function served() {
  const inner = objectiveWorkflow({
    config: {
      repository: REPO,
      checkout: "/nonexistent",
      delivery: { kind: "regular" },
    },
    github: { made() {} },
  });
  const routes = new Map([
    ["codex", { workflow: inner, frozen: { digest: "frozen", config: {} } }],
  ]);
  return { inner, workflow: providerWorkflow(routes, inner) };
}

/**
 * Clockgrove #821 when its question was asked: the delivered PR's
 * required check failed (a CI repair), so the item keeps the refused
 * result on its base, and the work step's diagnosis asks.
 */
function held(digest = "frozen") {
  const state = newObjective(821, new Date(), {
    provider: "codex",
    selectedBy: "defaultProvider",
    digest,
    config: {},
  });
  state.status = "building";
  state.done.check = { base: BASE };
  state.done.plan = plan([item(ID, { kind: "work" })]);
  const finding = `Checks failed on PR #825 at ${HEAD}: checks (failure, https://github.com/clockgrove/clockgrove/actions/runs/40462855644/job/122053441527). Factory reran the failed Actions jobs of quality, checks once on this head, and the failure stands`;
  Object.assign(state.kept, {
    [`item:${ID}:base`]: BASE,
    // The CI repair asked for a replay onto the current start; the work
    // step's question keeps its base and clears it (keepBase).
    [`item:${ID}:rebase`]: true,
    [`item:${ID}:refused`]: { commit: HEAD, tree: TREE, notes: [] },
    [`item:${ID}:finding`]: { kind: "failure", detail: finding },
    [`item:${ID}:checkFailures`]: [finding],
  });
  state.repairs[WORK] = { count: 2, findings: [finding] };
  return state;
}

/** The repair diagnosis's question as the work step asks it (work/repair-context.ts). */
const diagnosis = {
  ...hold(
    `Work Item ${ID} needs your decision before it is repaired:\n\nWhat step failed in checks job 122053441527, and what error does its preceding log or quality-receipts-checks artifact report?\n\nAnswer \`answer <text>\` to send the worker your guidance, \`retry\` to diagnose the failure again, or \`replan\` to plan again.`,
    [
      "answer",
      {
        answer: "retry",
        family: "retry",
        consequence: "Diagnoses the failure again.",
      },
      "replan",
      "cancel",
    ],
  ),
  keep: { [`item:${ID}:base`]: BASE, [`item:${ID}:rebase`]: false },
};

function runner(state, workflow) {
  return new ObjectiveRunner(
    state,
    workflow,
    tempDir("factory-revalidate-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
  );
}

test("the service's workflow keeps every Work Item answer of its provider's", () => {
  const { inner, workflow } = served();
  for (const hook of Object.keys(inner))
    assert.ok(hook in workflow, `providerWorkflow drops ${hook}`);
  // Each is the frozen provider's: none while the configuration changed.
  const state = held();
  state.kept[`item:${ID}:rebase`] = false;
  assert.equal(workflow.revalidatable(state, WORK), true);
  assert.equal(workflow.freshable(state, WORK), inner.freshable(state, WORK));
  const changed = held("another");
  changed.kept[`item:${ID}:rebase`] = false;
  assert.equal(workflow.revalidatable(changed, WORK), false);
  assert.equal(workflow.freshable(changed, WORK), false);
  assert.equal(workflow.diagnoseFirst(changed, WORK), false);
  assert.equal(workflow.overrunOffers(changed, WORK), undefined);
});

test("a repair diagnosis after a failed check offers revalidate exactly when it takes it", () => {
  const { workflow } = served();
  const engine = runner(held(), workflow);
  engine.apply(WORK, diagnosis);
  const [asked] = engine.state.holds;
  assert.equal(asked.step, WORK);
  assert.ok(
    asked.options.some((option) => option.answer === "revalidate"),
    JSON.stringify(asked.options),
  );
  // The engine's sentence, once, with the rereviews used of the allowance.
  assert.equal(asked.question.split("answer `revalidate`").length, 2);
  assert.match(
    asked.question,
    /this Objective has used 0 of 1 \(autonomy\.allowances\.resultRereviews\)\./,
  );
  // `factory answer 821 revalidate --question …` lands, charged as a rereview.
  assert.equal(
    engine.transact(() =>
      engine.answer("revalidate", undefined, "kirk", undefined, asked.id),
    ),
    null,
  );
  assert.equal(engine.state.answers[WORK].answer, "revalidate");
  assert.equal(engine.state.kept["allowances:rereviews"], 1);
});

test("a refused result that can't be checked again is offered in neither the options nor the text", () => {
  const { workflow } = served();
  const state = held();
  // The work step found it off its base (work/steps.ts `recheckMark`).
  state.kept[`item:${ID}:refused`] = {
    commit: HEAD,
    tree: TREE,
    notes: [],
    unrecheckable: true,
  };
  const engine = runner(state, workflow);
  engine.apply(WORK, diagnosis);
  const [asked] = engine.state.holds;
  assert.ok(!asked.options.some((option) => option.answer === "revalidate"));
  assert.doesNotMatch(asked.question, /revalidate/);
  const refused = engine.transact(() =>
    engine.answer("revalidate", undefined, "kirk", undefined, asked.id),
  );
  assert.equal(refused.code, "invalid_answer");
  assert.equal(engine.state.kept["allowances:rereviews"], undefined);
});
