// A result review that needed a person's judgment on several criteria
// asked one question per criterion, one after another (#2171): live
// (Clockgrove #800), entity-selection's review asked 4 questions in 13
// seconds and 4 more after its next result, and living-scene's 3, each the
// same question (was the real-browser journey run on this exact tree?),
// each answered with the same receipt. A review now asks once, listing
// every criterion; `accept all` or `refuse all` decides them all with one
// reason, `decide` lists a decision per criterion, and each criterion's
// decision is still recorded and shown on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectiveRunner } from "../dist/engine.js";
import { closedComment, closingLine } from "../dist/github-sync.js";
import { observedRecords } from "../dist/knowledge/memory.js";
import { ACCEPTED_AT } from "../dist/planning/plan.js";
import { decisionLines, reviewResult } from "../dist/review/result.js";
import { answerList, closingAnswer, newObjective } from "../dist/state.js";
import { decisionText } from "../dist/status.js";
import { fact, facts } from "../dist/work/facts.js";
import { answeredLines } from "../dist/work/finish.js";
import {
  criterionDecisions,
  DECIDE_ALL_NOTE,
  DECIDE_NOTE,
  REFUSES_ITEM,
  reviewOutcome,
} from "../dist/work/step-review.js";
import { withKeep } from "../dist/work/step-work.js";
import { item, plan, tempDir } from "./helpers.mjs";

const KEY = "item:a:review";
const BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const TREE = "a".repeat(40);
const ACCEPTED = "2026-10-28T00:00:00.000Z";
const CRITERIA = [
  "Pointer and accessible selection pick one entity.",
  "Selection shows the entity's details.",
  "Recent actions are listed for the selected entity.",
  "The text selection can be copied.",
];
const PLAN = plan([item("a", { acceptance: CRITERIA })]);
const QUESTION =
  "Was the real-browser journey run on this exact tree, and did it pass?";
const RECEIPT =
  "Executed on this exact tree, rebuilt from the Work Item's HEAD with matching tree hashes: the Playwright journey passed.";

/** The reviewer's first answer: it can judge none of `asked` (criterion indices). */
function needsHuman(asked = [0, 1, 2, 3]) {
  return {
    kind: "needs-human",
    tree: TREE,
    questions: asked.map((criterionIndex) => ({
      criterionIndex,
      criterion: CRITERIA[criterionIndex],
      detail: "The evidence root holds no run of it.",
      question: QUESTION,
    })),
    verdicts: [],
  };
}

/**
 * Work Item a's review step as reviewStep builds it: the operator's
 * decisions (criterionDecisions), the review, and its outcome
 * (reviewOutcome). The first review is the reviewer's needs-human answer;
 * a review the operator answered runs the real reviewResult, which judges
 * only what nobody settled and so calls no reviewer here (the planner
 * throws if it is called).
 */
function reviewStep(reviews, asked) {
  return {
    key: KEY,
    deadlineMs: 60_000,
    run: async (context) => {
      const decided = criterionDecisions(
        context,
        fact(context.state, "held", "a"),
        "a",
      );
      const review = decided.earlier
        ? await reviewResult({
            planner: {
              answer: async () => {
                throw new Error("the reviewer ran");
              },
            },
            plan: PLAN,
            item: PLAN.items[0],
            checkout: "/nonexistent",
            base: BASE,
            commit: COMMIT,
            validation: { tree: TREE, commands: [] },
            sources: [],
            dir: "/nonexistent",
            decisions: decided.decisions,
            earlier: decided.earlier,
            signal: AbortSignal.timeout(60_000),
            log() {},
          })
        : needsHuman(asked);
      reviews.push(review);
      const held = (asked) => facts({ held: asked }, "a");
      return withKeep(
        reviewOutcome(review, held, REFUSES_ITEM, (refusal) => ({
          kind: "done",
          result: {
            refused: refusal.refused.map((entry) => entry.criterionIndex + 1),
          },
          keep: held(null),
        })),
        decided.keep,
      );
    },
  };
}

/**
 * An engine running that step, which `runStep` runs once with the step's
 * answer; its first review asks about `asked` (criterion indices).
 */
function harness(asked) {
  const state = newObjective(800, new Date());
  state.status = "building";
  state.done.plan = PLAN;
  state.kept[ACCEPTED_AT] = ACCEPTED;
  const reviews = [];
  const step = reviewStep(reviews, asked);
  const runner = new ObjectiveRunner(
    state,
    { steps: () => [step], status: () => "building" },
    tempDir("factory-one-hold-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
  );
  const runStep = async () =>
    runner.apply(
      KEY,
      await step.run({
        state: structuredClone(runner.state),
        ...(runner.state.answers[KEY]
          ? { answer: runner.state.answers[KEY] }
          : {}),
        signal: AbortSignal.timeout(60_000),
        log() {},
        runFile() {
          throw new Error("no run file");
        },
        keep() {},
      }),
    );
  /** `factory answer` (`arg` apart from the text) or, with `via`, a `/factory` comment. */
  const answer = (hold, given, text, arg, via) =>
    runner.transact(() =>
      runner.answer(given, text, "kirk", undefined, hold.id, arg, via),
    );
  return { runner, reviews, runStep, answer };
}

const form = (option) => [option.answer, option.arg].filter(Boolean).join(" ");
const decisionsOf = (runner) => runner.state.kept["item:a:decisions"] ?? [];

test("a review needing judgment on 4 criteria raises one hold that lists them all", async () => {
  const { runner, runStep } = harness();
  await runStep();
  assert.equal(runner.state.holds.length, 1);
  const [hold] = runner.state.holds;
  assert.equal(hold.step, KEY);
  for (const [index, criterion] of CRITERIA.entries())
    assert.ok(
      hold.question.includes(`${index + 1}. ${criterion}\n   ${QUESTION}`),
      hold.question,
    );
  assert.ok(hold.question.endsWith(DECIDE_ALL_NOTE));
  assert.deepEqual(hold.options.map(form), [
    "accept all",
    "refuse all",
    "decide",
    "accept 1",
    "accept 2",
    "accept 3",
    "accept 4",
    "refuse 1",
    "refuse 2",
    "refuse 3",
    "refuse 4",
    "cancel",
  ]);
  // The one answer that settles it is the one status and the comment lead with.
  const [all, none, decide] = hold.options;
  assert.equal(all.recommended, true);
  assert.equal(hold.options.filter((option) => option.recommended).length, 1);
  assert.deepEqual(all.covers, ["1", "2", "3", "4"]);
  assert.deepEqual(none.covers, ["1", "2", "3", "4"]);
  assert.match(all.consequence, /criteria 1, 2, 3 and 4 as met/);
  assert.match(none.consequence, /sends the result back for repair/);
  assert.equal(decide.list, true);
  assert.equal(decide.family, "decide");
  assert.ok([all, none, decide].every((option) => option.needsText));
});

test("a review needing judgment on one criterion offers only its own answers", () => {
  const outcome = reviewOutcome(
    needsHuman([2]),
    () => ({}),
    REFUSES_ITEM,
    () => assert.fail("not refused"),
  );
  assert.equal(outcome.kind, "hold");
  assert.deepEqual(outcome.options.map(form), [
    "accept 3",
    "refuse 3",
    "cancel",
  ]);
  assert.ok(outcome.question.endsWith(DECIDE_NOTE));
});

for (const [how, give] of [
  // `/factory accept all <reason>`: `all` is the first word after the answer.
  [
    "a /factory comment",
    (answer, hold) =>
      answer(hold, "accept", `all ${RECEIPT}`, undefined, {
        channel: "comment",
        comment: "https://github.com/o/r/issues/800#issuecomment-1",
      }),
  ],
  // `factory answer 800 accept all --question ID --text <reason>`.
  ["the CLI", (answer, hold) => answer(hold, "accept", RECEIPT, "all")],
]) {
  test(`one accept all from ${how} settles all 4 criteria, each decision recorded`, async () => {
    const { runner, reviews, runStep, answer } = harness();
    await runStep();
    const [hold] = runner.state.holds;
    assert.equal(give(answer, hold), null);
    assert.deepEqual(runner.state.holds, []);
    const parts = ["1", "2", "3", "4"].map((arg) => ({
      answer: "accept",
      arg,
      text: RECEIPT,
    }));
    assert.deepEqual(runner.state.answers[KEY].parts, parts);
    const { closed } = runner.state.closedHolds.at(-1);
    assert.equal(closed.answer, "accept");
    assert.equal(closed.arg, "all");
    assert.equal(closed.text, RECEIPT);
    assert.deepEqual(closed.parts, parts);

    await runStep();
    assert.deepEqual(runner.state.holds, [], "no second question");
    assert.deepEqual(runner.state.done[KEY], { tree: TREE });
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].kind, "pass");
    assert.deepEqual(
      reviews[1].verdicts.map((verdict) => verdict.verdict),
      ["human-accept", "human-accept", "human-accept", "human-accept"],
    );
    const decisions = decisionsOf(runner);
    assert.deepEqual(
      decisions.map((entry) => [entry.criterion, entry.outcome, entry.reason]),
      CRITERIA.map((criterion) => [criterion, "accept", RECEIPT]),
    );
    for (const entry of decisions) {
      assert.equal(entry.holdId, hold.id);
      assert.equal(entry.tree, TREE);
      assert.equal(entry.itemId, "a");
      assert.equal(entry.plan, ACCEPTED);
      assert.equal(entry.by, "kirk");
    }
    // Status's and the report's `Decided:` lines: one per criterion.
    const lines = decisionLines(decisions);
    assert.equal(lines.length, 4);
    for (const [index, line] of lines.entries())
      assert.ok(
        line.startsWith(
          `${CRITERIA[index]} (Work Item a, tree aaaaaaaaaaaa): accepted by kirk at `,
        ),
        line,
      );
  });
}

test("an answer that decided several criteria is recorded once when its step runs again", async () => {
  const { runner, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  assert.equal(answer(hold, "accept", RECEIPT, "all"), null);
  const context = {
    state: structuredClone(runner.state),
    answer: runner.state.answers[KEY],
  };
  const held = fact(context.state, "held", "a");
  const first = criterionDecisions(context, held, "a");
  assert.equal(first.decisions.length, 4);
  // Its decisions saved, the same answer (a rerun) adds none.
  Object.assign(context.state.kept, first.keep);
  assert.equal(criterionDecisions(context, held, "a").decisions.length, 4);
});

test("a mixed per-criterion answer decides each criterion its own way", async () => {
  const { runner, reviews, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  const list = [
    "accept 1,2 Ran the journey on this exact tree.",
    "- refuse 3 The recent-actions panel was never exercised.",
    "accept 4 Copied the selection by hand.",
  ].join("\n");
  assert.equal(answer(hold, "decide", list), null);
  assert.deepEqual(runner.state.answers[KEY].parts, [
    { answer: "accept", arg: "1", text: "Ran the journey on this exact tree." },
    { answer: "accept", arg: "2", text: "Ran the journey on this exact tree." },
    {
      answer: "refuse",
      arg: "3",
      text: "The recent-actions panel was never exercised.",
    },
    { answer: "accept", arg: "4", text: "Copied the selection by hand." },
  ]);
  await runStep();
  assert.deepEqual(runner.state.holds, []);
  // The refusal stands for the whole result: it goes to repair.
  assert.equal(reviews[1].kind, "refused");
  assert.deepEqual(runner.state.done[KEY], { refused: [3] });
  assert.deepEqual(
    decisionsOf(runner).map((entry) => [entry.criterion, entry.outcome]),
    [
      [CRITERIA[0], "accept"],
      [CRITERIA[1], "accept"],
      [CRITERIA[2], "refuse"],
      [CRITERIA[3], "accept"],
    ],
  );
  assert.deepEqual(
    [...new Set(decisionsOf(runner).map((entry) => entry.holdId))],
    [hold.id],
  );
});

test("a list can be written on one line, a reason holding a `;`", () => {
  const options = reviewOutcome(
    needsHuman(),
    () => ({}),
    REFUSES_ITEM,
    () => assert.fail("not refused"),
  ).options;
  assert.deepEqual(
    answerList(
      "accept 1,2,4 Ran it; the receipt is R; refuse 3 Not run",
      options,
    ),
    [
      { answer: "accept", arg: "1", text: "Ran it; the receipt is R" },
      { answer: "accept", arg: "2", text: "Ran it; the receipt is R" },
      { answer: "accept", arg: "4", text: "Ran it; the receipt is R" },
      { answer: "refuse", arg: "3", text: "Not run" },
    ],
  );
  // Case and bullets don't matter.
  assert.deepEqual(answerList("* ACCEPT 2 Fine.", options), [
    { answer: "accept", arg: "2", text: "Fine." },
  ]);
});

test("a list that decides some criteria asks once more, about the rest only", async () => {
  const { runner, reviews, runStep, answer } = harness();
  await runStep();
  const [first] = runner.state.holds;
  assert.equal(
    answer(first, "decide", "accept 1 Ran it.; accept 3 Listed by hand."),
    null,
  );
  await runStep();
  assert.equal(runner.state.holds.length, 1);
  const [second] = runner.state.holds;
  assert.notEqual(second.id, first.id);
  assert.ok(second.question.includes(`2. ${CRITERIA[1]}`));
  assert.ok(second.question.includes(`4. ${CRITERIA[3]}`));
  assert.ok(!second.question.includes(`1. ${CRITERIA[0]}`));
  assert.ok(!second.question.includes(`3. ${CRITERIA[2]}`));
  assert.deepEqual(second.options.slice(0, 3).map(form), [
    "accept all",
    "refuse all",
    "decide",
  ]);
  assert.deepEqual(second.options[0].covers, ["2", "4"]);
  assert.deepEqual(second.options.slice(3).map(form), [
    "accept 2",
    "accept 4",
    "refuse 2",
    "refuse 4",
    "cancel",
  ]);
  assert.equal(decisionsOf(runner).length, 2);

  assert.equal(answer(second, "refuse", "Not run on this tree.", "all"), null);
  await runStep();
  assert.deepEqual(runner.state.holds, []);
  assert.equal(reviews.length, 3);
  assert.deepEqual(runner.state.done[KEY], { refused: [2, 4] });
  assert.deepEqual(
    decisionsOf(runner).map((entry) => [
      entry.criterion,
      entry.outcome,
      entry.holdId,
    ]),
    [
      [CRITERIA[0], "accept", first.id],
      [CRITERIA[2], "accept", first.id],
      [CRITERIA[1], "refuse", second.id],
      [CRITERIA[3], "refuse", second.id],
    ],
  );
});

test("an answer that doesn't fit is refused and the question stays open", async () => {
  const { runner, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  for (const [given, text, arg, why] of [
    ["decide", "accept 9 Ran it.", undefined, /`accept 9` isn't an answer/],
    [
      "decide",
      "accept 1 Ran it.\nrefuse 1 It didn't.",
      undefined,
      /names 1 more than once/,
    ],
    ["decide", "accept 1\nrefuse 2 No.", undefined, /`accept 1` needs text/],
    ["decide", "Looks fine to me.", undefined, /isn't an entry of the list/],
    ["decide", "accept all Ran it.", undefined, /`accept all` isn't an answer/],
    ["decide", undefined, undefined, /needs text/],
    ["accept", undefined, "all", /needs text/],
    // `accept` alone names no criterion: it never means all of them.
    ["accept", "Ran it on this tree.", undefined, /`accept all <text>`/],
  ]) {
    const refused = answer(hold, given, text, arg);
    assert.equal(refused?.code, "invalid_answer", `${given} ${text}`);
    assert.match(refused.message, why);
  }
  assert.deepEqual(
    runner.state.holds.map((open) => open.id),
    [hold.id],
  );
  assert.equal(runner.state.closedHolds, undefined);
  assert.equal(runner.state.answers[KEY], undefined);
});

const COMMENT = {
  channel: "comment",
  comment: "https://github.com/o/r/issues/800#issuecomment-2",
};

test("a list's criteria can be written with spaces after the commas", async () => {
  const { runner, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  assert.deepEqual(answerList("accept 1, 2 Ran it", hold.options), [
    { answer: "accept", arg: "1", text: "Ran it" },
    { answer: "accept", arg: "2", text: "Ran it" },
  ]);
  assert.equal(
    answer(hold, "decide", "accept 1 , 2,3 Ran it.\nrefuse 4 Not copied."),
    null,
  );
  assert.deepEqual(
    runner.state.answers[KEY].parts.map((part) => [
      part.answer,
      part.arg,
      part.text,
    ]),
    [
      ["accept", "1", "Ran it."],
      ["accept", "2", "Ran it."],
      ["accept", "3", "Ran it."],
      ["refuse", "4", "Not copied."],
    ],
  );
});

test("an entry whose reason names more criteria is refused, never half applied", async () => {
  const { runner, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  for (const [text, more] of [
    ["accept 1 and 2 Ran it", "2"],
    ["accept 1,2 Ran the journey.\nrefuse 3 and 4 Never exercised.", "4"],
    ["refuse 3 & 4 Never exercised.", "4"],
    ["accept 1 2 Ran it", "2"],
  ]) {
    const why = answerList(text, hold.options);
    assert.equal(typeof why, "string", text);
    assert.ok(why.includes(`names ${more} in its reason`), why);
    const refused = answer(hold, "decide", text);
    assert.equal(refused?.code, "invalid_answer", text);
  }
  // A reason may start with a word that isn't one of its criteria.
  assert.deepEqual(answerList("accept 1 and it passed", hold.options), [
    { answer: "accept", arg: "1", text: "and it passed" },
  ]);
  assert.deepEqual(answerList("accept 1 5 runs passed", hold.options), [
    { answer: "accept", arg: "1", text: "5 runs passed" },
  ]);
  // A comment naming one criterion and then another is refused the same.
  const refused = answer(hold, "accept", "1 and 2 Ran it", undefined, COMMENT);
  assert.equal(refused?.code, "invalid_answer");
  assert.match(refused.message, /names 2 in its reason/);
  assert.deepEqual(
    runner.state.holds.map((open) => open.id),
    [hold.id],
  );
  assert.equal(runner.state.answers[KEY], undefined);
});

test("accept all on a question about one criterion is refused from a comment and the CLI alike", async () => {
  const { runner, runStep, answer } = harness([2]);
  await runStep();
  const [hold] = runner.state.holds;
  assert.deepEqual(hold.options.map(form), ["accept 3", "refuse 3", "cancel"]);
  for (const refused of [
    answer(hold, "accept", `all ${RECEIPT}`, undefined, COMMENT),
    answer(hold, "accept", `ALL ${RECEIPT}`, undefined, COMMENT),
    answer(hold, "accept", RECEIPT, "all"),
  ]) {
    assert.equal(refused?.code, "invalid_answer");
    assert.equal(
      refused.message,
      "This question offers no `accept all`. Name one: `accept 3 <text>`.",
    );
  }
  assert.deepEqual(
    runner.state.holds.map((open) => open.id),
    [hold.id],
  );
  assert.equal(runner.state.answers[KEY], undefined);
  // Its own answer still works from a comment, with or without the number.
  assert.equal(
    answer(hold, "accept", `3 ${RECEIPT}`, undefined, COMMENT),
    null,
  );
  assert.deepEqual(
    [runner.state.answers[KEY].arg, runner.state.answers[KEY].text],
    ["3", RECEIPT],
  );
});

test("the CLI's text starting with `all` never accepts every criterion", async () => {
  const { runner, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  // `factory answer 800 accept --question ID --text "all evidence ..."`.
  const refused = answer(
    hold,
    "accept",
    "all evidence is in the receipt for criterion 2",
  );
  assert.equal(refused?.code, "invalid_answer");
  assert.match(refused.message, /^Name one: `accept all <text>`/);
  assert.deepEqual(
    runner.state.holds.map((open) => open.id),
    [hold.id],
  );
  assert.equal(runner.state.answers[KEY], undefined);
  assert.equal(decisionsOf(runner).length, 0);
});

test("a decide that refuses one criterion sends the result to repair, and says so", async () => {
  const { runner, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  const decide = hold.options.find((option) => option.answer === "decide");
  assert.match(
    decide.consequence,
    /asked again together only when it refuses none; a refusal decides this result/,
  );
  assert.match(
    DECIDE_ALL_NOTE,
    /When an answer refuses none, the criteria it leaves undecided are asked again together/,
  );
  assert.equal(answer(hold, "decide", "refuse 1 Not run."), null);
  await runStep();
  assert.deepEqual(runner.state.done[KEY], { refused: [1] });
  assert.deepEqual(runner.state.holds, [], "the rest aren't asked now");
});

test("the answered question's comment, status, the report and memory show each criterion's answer", async () => {
  const { runner, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  const secret = "ghp_notarealtokennotarealtoken0000";
  assert.equal(
    answer(
      hold,
      "decide",
      `accept 1,2,4 ${RECEIPT}\nrefuse 3 Its log shows ${secret}.`,
    ),
    null,
  );
  const closing = runner.state.closedHolds.at(-1);
  assert.equal(
    closingAnswer(closing.closed),
    "decide (accept 1, accept 2, accept 4, refuse 3)",
  );
  const line = closingLine(closing.closed, [secret]);
  assert.ok(line.startsWith("**Answered** `/factory decide` by "), line);
  assert.ok(
    line.includes(
      `It gave:\n- \`accept 1\`, \`accept 2\`, \`accept 4\`: ${RECEIPT}\n- \`refuse 3\`: Its log shows`,
    ),
    line,
  );
  assert.ok(!line.includes(secret), "redacted");
  assert.ok(!line.includes("\n> "), "the parts, not the list's whole text");
  const comment = closedComment("<!-- hold -->", closing, {
    issue: 800,
    secrets: [secret],
  });
  assert.ok(comment.includes("It gave:\n- `accept 1`"));
  assert.ok(comment.includes("`decide <text>`"), "the answers it offered");

  const status = decisionText(closing);
  assert.ok(
    status.includes("answered decide (accept 1, accept 2, accept 4, refuse 3)"),
    status,
  );
  const [report] = answeredLines(runner.state, [secret]);
  assert.ok(
    report.includes("`decide (accept 1, accept 2, accept 4, refuse 3)` by "),
    report,
  );

  // Repository memory: one decision per criterion, and the answer itself
  // isn't recorded again as a step's answer.
  await runStep();
  const records = await observedRecords(
    { repository: "o/r", checkout: "/nonexistent" },
    { ...runner.state, answers: { [KEY]: closing.closed } },
    false,
  );
  const decided = records.filter((record) =>
    record.summary.startsWith("Criterion "),
  );
  assert.deepEqual(
    decided.map((record) => record.summary.split(":")[0]),
    [
      "Criterion accepted at Work Item a's review",
      "Criterion accepted at Work Item a's review",
      "Criterion accepted at Work Item a's review",
      "Criterion refused at Work Item a's review",
    ],
  );
  assert.ok(
    !records.some((record) => record.summary.startsWith("Answered decide")),
  );
});

test("an accept all's closing lists every criterion it accepted with its one reason", async () => {
  const { runner, runStep, answer } = harness();
  await runStep();
  const [hold] = runner.state.holds;
  assert.equal(answer(hold, "accept", RECEIPT, "all"), null);
  const { closed } = runner.state.closedHolds.at(-1);
  assert.equal(
    closingAnswer(closed),
    "accept all (accept 1, accept 2, accept 3, accept 4)",
  );
  assert.ok(
    closingLine(closed, []).endsWith(
      `It gave:\n- \`accept 1\`, \`accept 2\`, \`accept 3\`, \`accept 4\`: ${RECEIPT}`,
    ),
  );
  // A one-criterion answer reads as before.
  assert.equal(closingAnswer({ answer: "accept", arg: "2" }), "accept 2");
  assert.ok(
    closingLine(
      {
        how: "answered",
        answer: "accept",
        arg: "2",
        text: RECEIPT,
        by: "kirk",
        channel: "cli",
        at: ACCEPTED,
      },
      [],
    ).endsWith(`\n\n> ${RECEIPT}`),
  );
});
