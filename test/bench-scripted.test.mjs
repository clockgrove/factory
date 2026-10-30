// The scripted operator's rules (bench/lib/scripted.mjs, #2266) on synthetic
// holds shaped as `factory status --json` shows them, each question in
// Factory's own template: every rule's answer and the rule it records, and
// the near misses that still pause for the operator.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isScripted,
  RULES,
  SCRIPTED_AS,
  scriptedAnswer,
  scriptedAs,
} from "../bench/lib/scripted.mjs";

const AT = "2031-03-04T10:00:00.000Z";
const hold = (step, question, options) => ({
  id: `${step}@${AT}`,
  question,
  options,
  askedAt: AT,
});
const option = (answer, extra = {}) => ({ answer, family: answer, ...extra });
const ANSWER = option("answer", { needsText: true, recommended: true });
const REPLAN = option("replan");
const CANCEL = option("cancel");

/** Planning's decide hold with the planner's own question (planning/steps.ts `questionFor`). */
const planner = (asked, options = [ANSWER, REPLAN, CANCEL]) =>
  hold(
    "decide:1:2",
    `The planner needs a decision:\n\n${asked}\n\nAnswer with \`answer <your choice>\`.`,
    options,
  );

/** The amendment planner's question (planning/amendments.ts). */
const amendmentPlanner = (asked) =>
  hold(
    "amend:worker-tokenizer-1:plan",
    `Planning amendment worker-tokenizer-1 needs a decision:\n\n${asked}\n\n\`answer <your choice>\` plans the amendment again with it; \`replace-validation <item> <index>[,<index>...] <reason>\` authorizes replacing those validation commands, and plans it again; \`refuse\` rejects the amendment.`,
    [
      ANSWER,
      option("replace-validation", { needsText: true }),
      option("refuse"),
      CANCEL,
    ],
  );

/** A repair diagnosis's question on a Work Item's work step. */
const diagnosis = (asked, options = [ANSWER, option("retry"), CANCEL]) =>
  hold("item:export-csv:work", asked, options);

/** A rejected amendment's question (planning/amendments.ts `rejectionStep`). */
const rejected = (reason, discovery = "the export needs a row limit") =>
  hold(
    "amend:worker-export-csv-2:continue",
    `Amendment \`worker-export-csv-2\` (Work Item export-csv's worker) was rejected: ${reason}\n\nReason: ${discovery}\n\nEvidence:\n- the export test fails\n\nOwnership: \`src/export.ts\`\n\nAcceptance:\n- An export over 10,000 rows is refused\n\n\`replace <correction>\` plans it again with your correction (3 planning revisions left); \`replace-validation <item> <index>[,<index>...] <reason>\` authorizes replacing those validation commands, and plans it again the same way; \`continue\` runs the plan without it.`,
    [
      option("replace", { needsText: true, recommended: true }),
      option("replace-validation", { needsText: true }),
      option("continue"),
      CANCEL,
    ],
  );

test("the rules are one module's, each an id, a match and an answer", () => {
  assert.deepEqual(
    RULES.map((rule) => rule.id),
    [
      "final-pauses",
      "policy-exception-refused",
      "scope-widening-refused",
      "amendment-continue",
      "planner-recommended",
    ],
  );
  for (const rule of RULES) {
    assert.equal(typeof rule.matches, "function", rule.id);
    assert.equal(typeof rule.answer, "function", rule.id);
  }
  assert.equal(
    scriptedAs("factory-bench operator policy"),
    "factory-bench operator policy (scripted)",
  );
  assert.ok(isScripted(`factory-bench operator policy${SCRIPTED_AS}`));
  assert.ok(!isScripted("factory-bench operator policy"));
  assert.ok(!isScripted(undefined));
});

test("1. a planner decision that names a recommended option takes it; one that names none pauses", () => {
  assert.deepEqual(
    scriptedAnswer(
      planner(
        "Should the export default to CSV or TSV? CSV is recommended: every consumer reads it.",
      ),
    ),
    {
      rule: "planner-recommended",
      answer: "answer",
      text: "Take the recommended option.",
    },
  );
  assert.equal(
    scriptedAnswer(planner("I recommend option B, the streaming export."))
      ?.rule,
    "planner-recommended",
  );
  // Past the planning allowance the question has Factory's note after it.
  const spent = planner("Option A (recommended) or option B?");
  spent.question +=
    "\n\nPlanning has run 6 rounds, past what autonomy.allowances.planningRevisions allows, so an answer is kept and `more` then sends it to the planner.";
  assert.equal(scriptedAnswer(spent)?.answer, "answer");
  // None named, or named as not recommended: pause.
  for (const asked of [
    "Should the export default to CSV or TSV?",
    "Neither option is recommended by the docs; which should it be?",
    "There is no recommended choice here: CSV or TSV?",
  ])
    assert.equal(scriptedAnswer(planner(asked)), null, asked);
});

test("1. only the planner's own question on a decide hold, offering answer with text", () => {
  // Factory's plan checks and the plan reviewer ask on the decide step too,
  // in their own words: not the planner's recommendation.
  assert.equal(
    scriptedAnswer(
      hold(
        "decide:1:2",
        "The plan reviewer found a question only you can decide:\n\n1. The recommended layout splits the tokenizer; is that wanted?\n\n`approve` runs the plan as it is; `answer <decision>` sends your decision back to the planner.",
        [ANSWER, option("approve"), REPLAN, CANCEL],
      ),
    ),
    null,
  );
  // A recommendation on another step's question.
  assert.equal(
    scriptedAnswer(
      diagnosis(
        "The worker recommends a fixture; which fixture should the export test use?",
      ),
    ),
    null,
  );
  // No answer with text offered.
  assert.equal(
    scriptedAnswer(
      planner("Option A (recommended) or option B?", [REPLAN, CANCEL]),
    ),
    null,
  );
});

test("2. an amendment rejected by the started-item fence, or as a duplicate of one in flight, continues", () => {
  for (const reason of [
    "Work Item export-csv has started, so it keeps its spec. Leave it as it is, and put further work in a new item",
    "Another amendment was in flight when it was taken in; replace it once that one is settled",
  ])
    assert.deepEqual(scriptedAnswer(rejected(reason)), {
      rule: "amendment-continue",
      answer: "continue",
    });
  // Rejected for anything else: pause, even when the worker's own words
  // repeat the fence's.
  assert.equal(
    scriptedAnswer(
      rejected(
        "its review found an operator decision: should exports be capped?",
      ),
    ),
    null,
  );
  assert.equal(
    scriptedAnswer(
      rejected(
        "the same findings twice",
        "export-csv has started, so it keeps its spec; another item must add the limit",
      ),
    ),
    null,
  );
  // A hold that doesn't offer continue.
  const noContinue = rejected(
    "Another amendment was in flight when it was taken in",
  );
  noContinue.options = noContinue.options.filter(
    (o) => o.answer !== "continue",
  );
  assert.equal(scriptedAnswer(noContinue), null);
});

test("3. a request for a repository policy exception is refused with guidance, never granted", () => {
  const refusal = {
    rule: "policy-exception-refused",
    answer: "answer",
    text: "No exception is granted: the repository's policy stays as its owner recorded it, and nothing is added to its exceptions. Stay within the policy, and meet the need in a way it already allows.",
  };
  assert.deepEqual(
    scriptedAnswer(
      amendmentPlanner(
        "The tokenizer's new tests exceed added production lines under the test budget. Approve an entry in testLineExceptions for them?",
      ),
    ),
    refusal,
  );
  assert.deepEqual(
    scriptedAnswer(
      diagnosis(
        "The test budget check fails on this result. Should a budget exception be recorded for export-csv?",
      ),
    ),
    refusal,
  );
  // Refused even when the planner recommends granting it.
  assert.deepEqual(
    scriptedAnswer(
      planner(
        "Grant an exception to the repository's test budget policy for the tokenizer? Granting it is recommended.",
      ),
    ),
    refusal,
  );
  // An exception in code isn't a policy's, and a question without answer
  // offered isn't guided.
  assert.equal(
    scriptedAnswer(
      diagnosis(
        "Should the export catch the exception and record it in the log, or let it fail the request?",
      ),
    ),
    null,
  );
  assert.equal(
    scriptedAnswer(
      hold(
        "item:export-csv:review",
        "The reviewer needs your judgment: the tests exceed added production lines",
        [option("accept"), option("refuse"), CANCEL],
      ),
    ),
    null,
  );
});

test("4. widening the Objective's scope to a protected path it doesn't list isn't authorized", () => {
  const refusal = {
    rule: "scope-widening-refused",
    answer: "answer",
    text: "Not authorized: the Objective's May change section stays as it is, so no protected path it doesn't list may change. Meet the need within the files the Objective allows.",
  };
  // Refused even when the planner recommends listing it.
  assert.deepEqual(
    scriptedAnswer(
      planner(
        "Work Item export-csv needs `.github/workflows/test.yml`, a protected path the Objective's May change section doesn't list. Should you list it? I recommend listing it.",
      ),
    ),
    refusal,
  );
  assert.deepEqual(
    scriptedAnswer(
      diagnosis(
        "Worker changed protected paths the Objective's May change section doesn't list: .github/workflows/test.yml. May the workflow change?",
      ),
    ),
    refusal,
  );
  // A protected path named without Factory's words, or no answer offered: pause.
  assert.equal(
    scriptedAnswer(diagnosis("May the worker change the CI workflow?")),
    null,
  );
  assert.equal(
    scriptedAnswer(
      diagnosis(
        "Worker changed protected paths the Objective's May change section doesn't list.",
        [option("retry"), CANCEL],
      ),
    ),
    null,
  );
});

test("5. final validation's and final review's questions are never answered", () => {
  const options = [
    option("repair", { recommended: true }),
    option("retry"),
    option("accept", { needsText: true }),
    REPLAN,
    CANCEL,
  ];
  for (const [step, question] of [
    [
      "final",
      "Final validation failed on `npm test` (exit 1). `repair` sends it back to export-csv; the recommended answer repairs it.",
    ],
    [
      "final-review",
      "Final review refused the integrated result: a policy exception is needed for the export's tests.",
    ],
  ])
    assert.deepEqual(
      scriptedAnswer(hold(step, question, options)),
      { rule: "final-pauses", answer: null },
      step,
    );
});

test("a judgment hold no rule matches pauses for the operator", () => {
  for (const question of [
    hold(
      "item:query-api:review",
      "The reviewer needs your judgment on the query API's result",
      [option("accept", { needsText: true }), option("refuse"), CANCEL],
    ),
    diagnosis(
      "Which fixture should the export test use, the small or the large one?",
    ),
    hold("check", "The issue was closed after planning.", [option("retry")]),
  ])
    assert.equal(scriptedAnswer(question), null, question.id);
});
