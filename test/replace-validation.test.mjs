// #2199: a validation command that can never pass on a correct result
// (it splits a document at its first `---`, which is a Markdown table's
// separator row) could be replaced only once a failure fact named it, and
// the operator's explicit authorization didn't count. A QA item has no
// worker, so nothing but the validate step could ever name its command.
// An operator's `replace-validation <item> <index>[,<index>...] <reason>`
// to a Work Item's repair diagnosis question, or to a read-only QA item's
// refusal, now records the authorization against the plan and proposes an
// amendment whose review judges the replacement on that reason.
import assert from "node:assert/strict";
import { test } from "node:test";
import { replacementOffered } from "../dist/planning/amendments.js";
import { qaReplacement, validationAmendment } from "../dist/work/amend.js";
import { qaRefusal } from "../dist/work/step-qa.js";
import { item, plan } from "./helpers.mjs";

const ACCEPTED_AT = "2026-01-01T00:00:00.000Z";
const CUT =
  "awk 'BEGIN { RS = \"---\" } NR == 2' docs/guide.md | grep -q 'Rollout steps'";
const REASON =
  "Its delimiter also matches the table's separator row; split at the horizontal rule instead.";
const FAILURE = `Validation command failed (1): ${CUT}`;
const commands = [{ command: "npm test" }, { command: CUT }];
const a = item("a", {
  kind: "work",
  ownedPaths: ["src/a.js", "docs/guide.md"],
  validation: commands,
});
const qa = item("qa", {
  kind: "qa",
  dependencies: ["a"],
  validation: commands,
});

/** An Objective whose Work Item a's repair 1 is being diagnosed; qa checks after it. */
function held(items = [a, qa]) {
  return {
    issue: 9,
    holds: [],
    answers: {},
    retries: {},
    attempts: {},
    repairs: { "item:a:work": { count: 1, findings: [FAILURE] } },
    done: { plan: plan(items, { base: "0".repeat(40) }) },
    kept: {
      "plan:acceptedAt": ACCEPTED_AT,
      "item:a:base": "0".repeat(40),
      "item:a:refused": {
        commit: "1".repeat(40),
        tree: "2".repeat(40),
        notes: [],
      },
      "item:a:finding": { kind: "failure", detail: FAILURE },
    },
  };
}

/** The operator's `replace-validation <text>` to question `holdId`. */
const replaceValidation = (text, holdId = "item:a:work@1") => ({
  holdId,
  question:
    "Work Item a needs your decision before it is repaired:\n\nWhich delimiter does the guide use?",
  answer: "replace-validation",
  text,
  by: "octo",
  at: "2026-01-01T02:00:00.000Z",
});

/** Applies an outcome's keep as the engine does. */
function apply(state, outcome) {
  for (const [key, value] of Object.entries(outcome.keep ?? {}))
    if (value === null) delete state.kept[key];
    else state.kept[key] = value;
}

const context = (state, answer) => ({
  state,
  ...(answer ? { answer } : {}),
  log: () => {},
  keep: () => {},
});

test("replace-validation to a repair diagnosis proposes an amendment of the authorized command, the item waits for it and runs again once it is accepted", () => {
  const state = held();
  // An index the item hasn't: asked again with its commands, nothing kept.
  const wrong = validationAmendment(
    a,
    context(state, replaceValidation(`a 2 ${REASON}`)),
    undefined,
    {},
  );
  assert.equal(wrong.kind, "hold");
  assert.match(
    wrong.question,
    /^Work Item a needs your decision before it is repaired:\n\nWhich delimiter/,
  );
  assert.match(
    wrong.question,
    /wasn't taken: Work Item a has no validation command 2; its commands are 0 `npm test`, 1 `awk/,
  );
  assert.ok(
    wrong.options.some((option) => option.answer === "replace-validation"),
  );
  assert.deepEqual(wrong.keep ?? {}, {});

  const answer = replaceValidation(`a 1 ${REASON}`);
  const proposed = validationAmendment(
    a,
    context(state, answer),
    undefined,
    {},
  );
  assert.equal(proposed.kind, "retry", JSON.stringify(proposed));
  apply(state, proposed);
  assert.deepEqual(state.kept["validation:authorized"], [
    {
      itemId: "a",
      index: 1,
      command: CUT,
      reason: REASON,
      by: "octo",
      at: answer.at,
      holdId: answer.holdId,
      plan: ACCEPTED_AT,
    },
  ]);
  const proposal = state.kept["amend:validation-a-1:proposal"];
  assert.equal(proposal.actor, "octo");
  assert.equal(proposal.plan, ACCEPTED_AT);
  // The item waits for it, at its next attempt, as for a discovery.
  assert.deepEqual(proposal.worker, { itemId: "a", attempt: 2 });
  assert.equal(proposal.commit, "1".repeat(40));
  assert.deepEqual(proposal.discovery.ownership, a.ownedPaths);
  assert.deepEqual(proposal.discovery.evidence, [
    `a's validation command 1: ${CUT}`,
    FAILURE,
  ]);
  assert.match(proposal.discovery.reason, /^octo authorized replacing a's/);

  // Pending: it waits, with the same answer.
  const waits = validationAmendment(a, context(state, answer), undefined, {});
  assert.equal(waits.kind, "retry");
  assert.match(waits.reason, /Waits for amendment validation-a-1/);

  // Accepted: a new attempt on the amended plan, charged to no allowance,
  // whose refused change may now end on the same tree.
  state.done["amend:validation-a-1"] = { plan: state.done.plan };
  const runs = validationAmendment(a, context(state, answer), undefined, {});
  assert.equal(runs.kind, "repair", JSON.stringify(runs));
  assert.deepEqual(runs.free, { target: "item:a:work", repair: 2 });
  assert.equal(runs.keep["item:a:refused"].replayOnly, true);

  // Rejected and continued past: the repair goes on as usual.
  state.done["amend:validation-a-1"] = { rejected: "Refused." };
  state.done["amend:validation-a-1:continue"] = {};
  assert.equal(
    validationAmendment(a, context(state, answer), undefined, {}),
    undefined,
  );
});

test("replace-validation to a QA item's refusal proposes an operator's amendment of its own command, once", () => {
  const state = held();
  delete state.repairs["item:a:work"];
  const offers = ["replan", "retry", "cancel"];
  const answer = replaceValidation(`qa 1 ${REASON}`, "item:qa:validate@1");
  const proposed = qaReplacement(qa, context(state, answer), offers);
  assert.equal(proposed.kind, "retry", JSON.stringify(proposed));
  apply(state, proposed);
  const proposal = state.kept["amend:validation-qa-1:proposal"];
  assert.equal(proposal.worker, undefined);
  assert.equal(proposal.actor, "octo");
  // A QA item owns nothing: what it checks is its dependencies' paths.
  assert.deepEqual(proposal.discovery.ownership, a.ownedPaths);
  assert.deepEqual(proposal.discovery.acceptance, [
    `qa no longer runs ${JSON.stringify(CUT)}; the commands in its place prove what it proved, keeping every assertion it makes.`,
  ]);
  assert.equal(state.kept["validation:authorized"][0].itemId, "qa");
  // Taken in: the step runs on, on the plan as it stands.
  assert.equal(qaReplacement(qa, context(state, answer), offers), undefined);
  assert.equal(qaReplacement(qa, context(state), offers), undefined);

  // A QA item that checks no owning item asks again, recording nothing.
  const alone = item("qa", { kind: "qa", validation: commands });
  const bare = held([a, alone]);
  const asked = qaReplacement(alone, context(bare, answer), offers);
  assert.equal(asked.kind, "hold");
  assert.match(asked.question, /depends on no Work Item that owns paths/);
  assert.equal(bare.kept["validation:authorized"], undefined);
});

test("replace-validation is offered while an unpublished item has a validation command, and a QA refusal names its commands", () => {
  const state = held();
  assert.equal(replacementOffered(state), true);
  // Published or merged items run no validation an amendment could change.
  state.kept["item:a:pushed"] = ["3".repeat(40)];
  state.done["item:qa:merge"] = { settled: "qa" };
  assert.equal(replacementOffered(state), false);
  assert.equal(
    replacementOffered(
      held([item("a", { kind: "work", ownedPaths: ["src/a.js"] })]),
    ),
    false,
  );

  const refused = qaRefusal(qa, "4".repeat(40), "`npm test` failed", FAILURE);
  assert.deepEqual(
    refused.options.map((option) => option.answer),
    ["replan", "retry", "replace-validation", "cancel"],
  );
  assert.match(
    refused.question,
    /`replace-validation <item> <index>\[,<index>\.\.\.\] <reason>` authorizes an amendment/,
  );
  assert.match(refused.question, /qa's commands are 0 `npm test`, 1 `awk/);
  // One with no command of its own offers none.
  assert.deepEqual(
    qaRefusal(
      item("qa", { kind: "qa" }),
      "4".repeat(40),
      "its review refused",
      "",
    ).options.map((option) => option.answer),
    ["replan", "retry", "cancel"],
  );
});
