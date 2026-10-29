// The scorecard of Clockgrove #800 from its real, trimmed state and run log
// (bench-fixture.mjs). Three run files: two restarts, one inside an operator
// pause; Codex calls whose resumed sessions repeat their child threads'
// cumulative usage. The numbers are #800's post-mortem's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureCard } from "./bench-fixture.mjs";

test("#800 scores: tokens with each resumed session's child threads counted once", async () => {
  const card = await fixtureCard();
  const { tokens } = card.totals;
  assert.equal(card.outcome, "done");
  assert.deepEqual(card.factory.versions, ["0.5.7", "0.5.8"]);
  // What the 0.5.7/0.5.8 spend limit counted: the calls' own tokens.
  assert.equal(tokens.counted, 89_291_214);
  assert.equal(tokens.own, 89_291_214);
  // Two resumed sessions repeat 503,819 and 1,069,102 child tokens: 18,454,021 summed naively.
  assert.equal(tokens.childThreads, 16_881_100);
  assert.equal(tokens.total, 106_172_314);
  // The spend ledger never charged the call aborted by the first restart.
  assert.equal(tokens.spendLedger, 89_227_422);
  assert.equal(tokens.unknownCalls, 7);
  assert.ok(
    card.checks.every((check) => check.ok),
    JSON.stringify(card.checks),
  );
});

test("#800 scores: active time leaves out the outages and the pause", async () => {
  const { totals } = await fixtureCard();
  assert.equal(totals.wallMs, 43_766_384);
  assert.deepEqual(
    totals.outages.map((outage) => [outage.ms, outage.runEnd]),
    [
      [4_249, "handed-off"],
      [64_952, "handed-off"],
    ],
  );
  assert.deepEqual(
    totals.pauses.map((pause) => pause.ms),
    [12_918_252],
  );
  // The second outage falls inside the pause: excluded once.
  assert.equal(totals.excludedMs, 12_918_252 + 4_249);
  assert.equal(totals.activeWallMs, 30_843_883);
});

test("#800 scores: repairs, holds by kind, validation, CI and per Work Item", async () => {
  const card = await fixtureCard();
  const { totals } = card;
  assert.equal(totals.repairs, 25);
  assert.equal(totals.holds.total, 38);
  assert.equal(totals.holds.scripted, 15);
  assert.equal(totals.holds.operator, 23);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(totals.holds.byKind).map(([kind, k]) => [kind, k.count]),
    ),
    {
      diagnosis: 9,
      allowance: 10,
      spend: 3,
      review: 12,
      ci: 1,
      config: 2,
      qa: 1,
    },
  );
  assert.equal(totals.criteria, 32);
  assert.deepEqual(totals.planning, {
    rounds: 2,
    generations: 1,
    revisions: 9,
  });
  assert.deepEqual(totals.validation, {
    runs: 25,
    passed: 8,
    firstPassRate: 0.32,
  });
  assert.equal(totals.ci.published, 5);
  assert.equal(totals.ci.passedFirstTime, 1);
  assert.deepEqual(
    card.items.map((item) => [
      item.id,
      item.tokens.own,
      item.tokens.childThreads,
      item.repairs,
      item.holds.total,
      item.validation.runs,
      Math.round(item.activeWallMs / 60_000),
    ]),
    [
      ["living-scene", 29_499_710, 3_346_957, 12, 13, 10, 196],
      ["entity-selection", 31_075_957, 8_708_660, 11, 19, 10, 187],
      ["recorded-why", 24_522_060, 4_825_483, 2, 3, 3, 99],
      ["pilot-predeclaration", 101_943, 0, 0, 1, 2, 12],
    ],
  );
  assert.equal(card.operator.decisions.length, 38);
  assert.deepEqual(
    card.operator.actions.map((action) => action.kind),
    ["decline-discovery", "pause", "resume"],
  );
  assert.deepEqual(
    card.unavailable.map((gap) => gap.metric),
    ["costUsd", "tokens of some calls"],
  );
});
