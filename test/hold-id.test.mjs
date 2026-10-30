// A question's id is its step's key and when it was asked, to the
// millisecond: a step asking twice in one millisecond gave both questions
// one id (#2211), so an answer, a closing, the comment or `--question`
// could take one for the other. Each takes the next millisecond instead.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hold, ObjectiveRunner } from "../dist/engine.js";
import { newHoldId, newObjective, RESET_KEY } from "../dist/state.js";
import { tempDir } from "./helpers.mjs";

const KEY = "item:a:work";
const NOW = "2026-10-28T01:00:00.000Z";
const at = (ms) => new Date(Date.parse(NOW) + ms).toISOString();

/** An engine whose clock stands still at NOW. */
function stopped() {
  const state = newObjective(1, new Date(NOW));
  state.status = "building";
  return new ObjectiveRunner(
    state,
    { steps: () => [], status: () => "building" },
    tempDir("factory-hold-id-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
    undefined,
    () => new Date(NOW),
  );
}

test("a step asking twice in one instant gets two ids, the later a millisecond on", () => {
  const runner = stopped();
  runner.apply(KEY, hold("First?"));
  const [first] = runner.state.holds;
  assert.equal(first.id, `${KEY}@${NOW}`);
  assert.equal(
    runner.transact(() =>
      runner.answer("retry", undefined, "kirk", undefined, first.id),
    ),
    null,
  );
  assert.equal(runner.state.answers[KEY].holdId, first.id);
  runner.apply(KEY, hold("Second?"));
  const [second] = runner.state.holds;
  assert.equal(second.id, `${KEY}@${at(1)}`);
  assert.equal(second.askedAt, NOW);
  // Asked again before it is answered: the open one is superseded by a
  // third, which names it, and every closing keeps its own question.
  runner.apply(KEY, hold("Third?"));
  const [third] = runner.state.holds;
  assert.equal(third.id, `${KEY}@${at(2)}`);
  assert.deepEqual(
    runner.state.closedHolds.map((closed) => [
      closed.id,
      closed.summary,
      closed.closed.how,
      closed.closed.next,
    ]),
    [
      [first.id, "First?", "answered", undefined],
      [second.id, "Second?", "superseded", third.id],
    ],
  );
});

test("a new id passes every id of its step the state has, and only its step's", () => {
  const state = newObjective(1, new Date(NOW));
  assert.equal(newHoldId(state, KEY, NOW), `${KEY}@${NOW}`);
  // Ids saved before the fix are `key@` the time too, and still count.
  state.answers[KEY] = {
    holdId: `${KEY}@${NOW}`,
    answer: "retry",
    by: "kirk",
    at: NOW,
  };
  assert.equal(newHoldId(state, KEY, NOW), `${KEY}@${at(1)}`);
  state.closedHolds = [
    {
      id: `${KEY}@${at(1)}`,
      step: KEY,
      cause: "question",
      askedAt: NOW,
      summary: "Closed?",
      closed: { how: "answered", at: NOW },
    },
  ];
  assert.equal(newHoldId(state, KEY, NOW), `${KEY}@${at(2)}`);
  // A resetting record's old questions are still open.
  state.kept[RESET_KEY] = {
    old: {
      holds: [
        {
          id: `${KEY}@${at(5)}`,
          step: KEY,
          question: "Old?",
          options: [],
          cause: "question",
          askedAt: at(5),
        },
      ],
    },
  };
  assert.equal(newHoldId(state, KEY, NOW), `${KEY}@${at(6)}`);
  // A later clock is its own time; another step's ids don't count.
  assert.equal(newHoldId(state, KEY, at(9)), `${KEY}@${at(9)}`);
  assert.equal(newHoldId(state, "item:b:work", NOW), `item:b:work@${NOW}`);
  state.holds = [
    {
      id: `${KEY}:more@${at(20)}`,
      step: `${KEY}:more`,
      question: "Another step?",
      options: [],
      cause: "question",
      askedAt: at(20),
    },
  ];
  assert.equal(newHoldId(state, KEY, at(9)), `${KEY}@${at(9)}`);
});
