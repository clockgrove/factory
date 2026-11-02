// clockgrove/factory#2364: a Work Item's result review escalates to the
// provider's top tier when a structural trigger fires, once, within its
// deadline, never removing a confirmed refusal. Each trigger on the real
// review pipeline (review/item.ts `reviewCandidate`), a real Git
// repository and the real sandbox, the reviewers' and proofs' answers
// given as fixtures at the planner seam.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ItemTelemetries, telemetryText } from "../dist/item-telemetry.js";
import {
  answering,
  ask,
  CRITERIA,
  NOT_REPRODUCED,
  pass,
  REPRO,
  refuse,
  reproduced,
  review,
  skip,
  target,
} from "./helpers/review.mjs";

/** The top tier on `planner`, whose every call reports `tokens`. */
function top(planner, tokens = 100) {
  return {
    provider: "claude",
    model: "claude-fable-5-1",
    effort: "high",
    planner: {
      ...planner,
      answer(call) {
        call.log({ event: "model-usage", tokens: { total: tokens } });
        return planner.answer(call);
      },
    },
  };
}

/** A review of `repo` that may escalate to `upper` with `escalation`'s history. */
const escalating = (repo, standard, upper, escalation = {}, extra = {}) =>
  review(repo, standard, {
    escalation: { top: top(upper), deadlineMs: 60_000, ...escalation },
    ...extra,
  });

const escalated = (events) =>
  events.filter((event) => event.event === "result-review-escalation");

/** Whether `call` (a finder call) judges criterion text `criterion`. */
const judges = (call, criterion) => call.prompt.includes(criterion);

test("1: a proof that drops a behaviour refusal sends that criterion alone to the top tier, whose confirmed refusal stands, with its tokens and event", {
  skip,
}, async () => {
  const repo = target();
  const standard = answering(
    [{ findings: [refuse(0), pass(1)] }],
    () => NOT_REPRODUCED,
  );
  const upper = answering([{ findings: [refuse(0)] }], () => reproduced(REPRO));
  const { run, events } = escalating(repo, standard, upper);
  const outcome = await run;
  assert.equal(outcome.kind, "refused");
  assert.deepEqual(
    outcome.refused.map((entry) => [entry.criterionIndex, entry.repro.command]),
    [[0, REPRO]],
  );
  assert.equal(upper.calls.length, 1);
  assert.ok(judges(upper.calls[0], CRITERIA[0]));
  assert.ok(!judges(upper.calls[0], CRITERIA[1]));
  // Its suspicion was proved as the standard one is.
  assert.equal(upper.proofs.length, 1);
  const [event] = escalated(events);
  assert.deepEqual(
    { ...event, ms: undefined, step: undefined },
    {
      event: "result-review-escalation",
      triggers: ["proof-dropped"],
      tier: "top",
      provider: "claude",
      model: "claude-fable-5-1",
      effort: "high",
      criteria: [0],
      outcome: "done",
      suspicions: { raised: 1, proved: 1 },
      refused: 1,
      settled: 0,
      tokens: 200,
      ms: undefined,
      step: undefined,
    },
  );
  assert.deepEqual(outcome.escalation.triggers, ["proof-dropped"]);
  // Its calls are logged as model usage, which spend counts.
  assert.equal(
    events.filter(
      (event) => event.event === "model-usage" && event.escalation === true,
    ).length,
    2,
  );
  // Status shows it, as text and JSON.
  const telemetry = new ItemTelemetries();
  for (const entry of events)
    telemetry.add({ at: "2026-01-01T00:00:00.000Z", ...entry });
  const item = telemetry.liveItems().reduce;
  assert.deepEqual(item.reviewer.escalations.triggers, { "proof-dropped": 1 });
  assert.match(
    telemetryText(item, "Work Item reduce"),
    /escalations 1 done \(1 proof-dropped; suspicions 1 raised, 1 proved; 1 refused, 0 settled; 200 tokens/,
  );

  // A pass of the top tier never removes a refusal the standard review
  // confirmed.
  const confirmed = answering(
    [{ findings: [refuse(0), refuse(1, "A patch may be dropped.")] }],
    (_call, suspicion) =>
      suspicion.case === "A patch may be dropped."
        ? NOT_REPRODUCED
        : reproduced(REPRO),
  );
  const passing = answering([{ findings: [pass(0)] }]);
  const kept = await escalating(repo, confirmed, passing).run;
  assert.deepEqual(
    kept.refused.map((entry) => entry.criterionIndex),
    [0],
  );
  assert.ok(judges(passing.calls[0], CRITERIA[1]));
  assert.ok(!judges(passing.calls[0], CRITERIA[0]));
});

test("2: with the repair allowance nearly spent, the top tier reviews every criterion afresh", {
  skip,
}, async () => {
  const repo = target();
  const standard = answering([{ findings: [pass(0), pass(1)] }]);
  const upper = answering([{ findings: [pass(0), pass(1)] }]);
  const { run, events } = escalating(repo, standard, upper, {
    repairsNearlySpent: true,
  });
  assert.equal((await run).kind, "pass");
  assert.ok(CRITERIA.every((criterion) => judges(upper.calls[0], criterion)));
  assert.deepEqual(
    escalated(events).map(({ triggers, criteria }) => ({ triggers, criteria })),
    [{ triggers: ["repairs-nearly-spent"], criteria: [0, 1] }],
  );
});

test("3: a finder question about to reach the operator is judged by the top tier; one it can't judge stays, and the protected-test question never escalates", {
  skip,
}, async () => {
  const repo = target();
  const question = "Must a snapshot of the same version replace the items?";
  const standard = () => answering([{ findings: [pass(0), ask(1, question)] }]);
  // The top tier judges criterion 1 alone: its first.
  const judging = answering([{ findings: [pass(0, "Defined: kept.")] }]);
  const { run, events } = escalating(repo, standard(), judging);
  const settled = await run;
  assert.equal(settled.kind, "pass");
  assert.match(
    settled.verdicts[1].detail,
    /^The top-tier reviewer \(claude-fable-5-1 at high\) judged it: Defined: kept\./,
  );
  assert.ok(!judges(judging.calls[0], CRITERIA[0]));
  assert.match(judging.calls[0].prompt, /The standard reviewer's questions/);
  assert.ok(judging.calls[0].prompt.includes(question));
  assert.equal(escalated(events)[0].settled, 1);

  const unsure = answering([
    { findings: [ask(0, "Is a same-version snapshot defined anywhere?")] },
  ]);
  const still = await escalating(repo, standard(), unsure).run;
  assert.equal(still.kind, "needs-human");
  assert.match(
    still.questions[0].detail,
    /could not judge it either: Is a same-version snapshot defined anywhere\?/,
  );

  // The protected-test check's question is Factory's own: no escalation.
  const protectedRepo = target(undefined, {
    base: {
      "test/old.test.js": Array.from(
        { length: 12 },
        (_, n) => `assert(${n});`,
      ).join("\n"),
    },
    head: { "test/old.test.js": "" },
  });
  const untouched = answering([]);
  const { run: guarded, events: guardedEvents } = escalating(
    protectedRepo,
    answering([{ findings: [pass(0), pass(1)] }]),
    untouched,
  );
  assert.equal((await guarded).kind, "needs-human");
  assert.equal(untouched.calls.length, 0);
  assert.deepEqual(escalated(guardedEvents), []);
});

test("4: a confirmed repro citing a file a pass cites sends that pass to the top tier", {
  skip,
}, async () => {
  const repo = target();
  const standard = answering(
    [
      {
        findings: [
          refuse(0),
          pass(1, "A patch appends its item (src/reduce.js:6)."),
        ],
      },
    ],
    () => reproduced(REPRO),
  );
  const upper = answering(
    [
      {
        findings: [
          refuse(0, "A late snapshot drops the patch (src/reduce.js:6)."),
        ],
      },
    ],
    () => reproduced(REPRO),
  );
  const { run, events } = escalating(repo, standard, upper);
  const outcome = await run;
  assert.deepEqual(
    outcome.refused.map((entry) => entry.criterionIndex),
    [0, 1],
  );
  assert.ok(judges(upper.calls[0], CRITERIA[1]));
  assert.ok(!judges(upper.calls[0], CRITERIA[0]));
  assert.deepEqual(escalated(events)[0].triggers, ["repro-shares-file"]);
});

test("5: a criterion refused on an earlier attempt that now passes with no suspicion goes to the top tier", {
  skip,
}, async () => {
  const repo = target();
  const upper = answering([{ findings: [pass(0)] }]);
  const { run, events } = escalating(
    repo,
    answering([{ findings: [pass(0), pass(1)] }]),
    upper,
    { earlierRefused: [CRITERIA[0]] },
  );
  assert.equal((await run).kind, "pass");
  assert.deepEqual(
    escalated(events).map(({ triggers, criteria }) => ({ triggers, criteria })),
    [{ triggers: ["earlier-refusal-passes"], criteria: [0] }],
  );
});

test("6: a refusal routed to a note escalates when its detail cites product code or its criterion names no test; a test-economy note on tests about tests doesn't", {
  skip,
}, async () => {
  const repo = target();
  const upper = answering([{ findings: [refuse(0)] }], () => reproduced(REPRO));
  const { run, events } = escalating(
    repo,
    answering([
      {
        findings: [
          refuse(
            0,
            "The fix is past the test-line budget (src/reduce.js:4).",
            "test-economy",
          ),
          pass(1),
        ],
      },
    ]),
    upper,
  );
  const outcome = await run;
  assert.deepEqual(
    outcome.refused.map((entry) => entry.criterionIndex),
    [0],
  );
  assert.deepEqual(escalated(events)[0].triggers, ["note-on-behaviour"]);

  const about = "test/reduce.test.js proves a patch adds its item.";
  const untouched = answering([]);
  const { run: noted, events: notedEvents } = escalating(
    repo,
    answering([
      {
        findings: [
          refuse(
            0,
            "It repeats test/reduce.test.js:3 (test/other.test.js:2).",
            "test-economy",
          ),
        ],
      },
    ]),
    untouched,
    {},
    { criteria: [about] },
  );
  assert.equal((await noted).kind, "pass");
  assert.equal(untouched.calls.length, 0);
  assert.deepEqual(escalated(notedEvents), []);
});

test("safeguards: past the Objective's cap, at its deadline, or on an error, the standard result stands", {
  skip,
}, async () => {
  const repo = target();
  const standard = () =>
    answering([{ findings: [refuse(0), pass(1)] }], () => NOT_REPRODUCED);
  const untouched = answering([]);
  const { run: capped, events: cappedEvents } = escalating(
    repo,
    standard(),
    untouched,
    { capped: true },
  );
  const cappedOutcome = await capped;
  assert.equal(cappedOutcome.kind, "pass");
  assert.equal(cappedOutcome.escalation, undefined);
  assert.equal(untouched.calls.length, 0);
  assert.equal(escalated(cappedEvents)[0].outcome, "capped");

  const hanging = {
    answer: (call) =>
      new Promise((_, reject) =>
        call.signal.addEventListener("abort", () => reject(call.signal.reason)),
      ),
  };
  const { run: late, events: lateEvents } = escalating(
    repo,
    standard(),
    hanging,
    { deadlineMs: 200 },
  );
  const lateOutcome = await late;
  assert.equal(lateOutcome.kind, "pass");
  assert.equal(lateOutcome.escalation.outcome, "timeout");
  assert.equal(escalated(lateEvents)[0].outcome, "timeout");

  const broken = {
    answer: async () => {
      throw new Error("the top tier's login expired");
    },
  };
  const failed = await escalating(repo, standard(), broken).run;
  assert.equal(failed.kind, "pass");
  assert.equal(failed.escalation.outcome, "error");
});
