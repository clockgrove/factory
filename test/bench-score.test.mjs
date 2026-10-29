// The scorecard of Clockgrove #800 from its real, trimmed state and run log
// (bench-fixture.mjs). Three run files: two restarts, one inside an operator
// pause; Codex calls whose resumed sessions repeat their child threads'
// cumulative usage. The numbers are #800's post-mortem's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { BENCH_DIR } from "../bench/lib/definition.mjs";
import { fixtureCard, fixtureCopy } from "./bench-fixture.mjs";

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

test("#800 scores: active time leaves out the outages, the pause and waits for an answer", async () => {
  const card = await fixtureCard();
  const { totals } = card;
  assert.equal(card.partial, false);
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
  assert.equal(totals.downtimeMs, 12_918_252 + 4_249);
  // A hold open and no step in progress: Factory waits on whoever answers.
  // The read-only QA hold (asked 22:52:33, answered 23:04:34) is the longest.
  assert.equal(totals.holdBlocked.length, 36);
  assert.deepEqual(
    totals.holdBlocked.find((span) => span.from.startsWith("2026-10-28T22:5")),
    {
      from: "2026-10-28T22:52:33.163Z",
      to: "2026-10-28T23:04:34.455Z",
      ms: 721_292,
    },
  );
  assert.equal(totals.holdBlockedMs, 3_196_627);
  assert.equal(totals.excludedMs, totals.downtimeMs + totals.holdBlockedMs);
  assert.equal(totals.activeWallMs, 27_647_256);
  // The operator's waits stay a guard of their own.
  assert.equal(totals.holds.operatorWaitMs, 2_644_477);
  const pilot = card.items.find((item) => item.id === "pilot-predeclaration");
  assert.equal(pilot.holdBlockedMs, 721_292);
  assert.equal(pilot.activeWallMs, 19_987);
});

test("a hold's wait leaves out the downtime inside it; the raw wait is kept for the check", async () => {
  // The fixture with an operator pause inside the QA hold, 22:55 to 23:00.
  const stateDir = fixtureCopy((dir) => {
    const logs = join(dir, "logs", "800");
    const file = join(
      logs,
      readdirSync(logs).find((name) => name.startsWith("2026-10-28T21-49")),
    );
    const request = (at, seq, kind) =>
      JSON.stringify({
        at,
        seq,
        event: "request",
        by: "kirk",
        message: "ok",
        request: { kind, issue: 800 },
      });
    const lines = readFileSync(file, "utf8").split("\n");
    const after = lines.findIndex((line) =>
      line.includes('"id":"item:pilot-predeclaration:validate@'),
    );
    lines.splice(
      after + 1,
      0,
      request("2026-10-28T22:55:00.000Z", 9001, "pause"),
      request("2026-10-28T23:00:00.000Z", 9002, "resume"),
    );
    writeFileSync(file, lines.join("\n"));
  });
  after(() => rmSync(dirname(stateDir), { recursive: true, force: true }));
  const card = await fixtureCard({}, stateDir);
  const qa = card.operator.decisions.find((d) => d.kind === "qa");
  assert.equal(qa.rawWaitMs, 721_292);
  assert.equal(qa.waitMs, 721_292 - 300_000);
  assert.equal(card.totals.holds.byKind.qa.waitMs, 421_292);
  assert.equal(card.totals.holds.operatorWaitMs, 2_644_477 - 300_000);
  assert.equal(card.totals.holds.rawWaitMs, 3_268_968);
  assert.ok(
    card.checks.every((check) => check.ok),
    JSON.stringify(card.checks),
  );
});

test("a Factory build changed since provisioning is named in the card's gaps", async () => {
  const factory = {
    kind: "candidate",
    cli: "/work/factory/dist/cli.js",
    commit: "c".repeat(40),
    distSha256: "a".repeat(64),
    distSha256Now: "b".repeat(64),
  };
  const card = await fixtureCard({ source: "harness", factory });
  assert.deepEqual(card.run.factory, factory);
  assert.match(
    card.unavailable.find((gap) => gap.metric === "which Factory ran").reason,
    /changed after provisioning: sha256 aaaaaaaaaaaa then, bbbbbbbbbbbb at scoring/,
  );
  factory.distSha256Now = factory.distSha256;
  assert.ok(
    !(await fixtureCard({ factory })).unavailable.some(
      (gap) => gap.metric === "which Factory ran",
    ),
  );
});

test("an Objective that hasn't ended scores a partial card", async () => {
  const stateDir = fixtureCopy((dir) => {
    const file = join(dir, "objectives", "finished", "800.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.status = "building";
    delete state.ended;
    writeFileSync(file, JSON.stringify(state));
  });
  after(() => rmSync(dirname(stateDir), { recursive: true, force: true }));
  const card = await fixtureCard({}, stateDir);
  assert.equal(card.outcome, "running");
  assert.equal(card.partial, true);
  assert.equal(card.unavailable[0].metric, "every total");
  // The CLI never writes it into results/.
  const id = `partial-${process.pid}`;
  const out = join(BENCH_DIR, "results", "clockgrove-800", `${id}.json`);
  after(() => rmSync(out, { force: true }));
  const run = spawnSync(
    process.execPath,
    [
      join(BENCH_DIR, "score.mjs"),
      "--benchmark",
      "clockgrove-800",
      "--state-dir",
      stateDir,
      "--issue",
      "800",
      "--run-id",
      id,
      "--label",
      "partial",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 65, run.stderr);
  assert.match(run.stderr, /is running, not ended: .*partial/);
  assert.ok(!existsSync(out));
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
  // The QA hold is no verdict run but counts as pilot-predeclaration's result not
  // passing its first validation; the operator's retry validated the same result again.
  assert.deepEqual(totals.validation, {
    runs: 24,
    passed: 8,
    holds: 1,
    passRate: 8 / 24,
    results: 24,
    passedFirstTime: 7,
    firstPassRate: 7 / 24,
  });
  assert.deepEqual(
    card.items.find((item) => item.id === "pilot-predeclaration").validation,
    {
      runs: 1,
      passed: 1,
      holds: 1,
      passRate: 1,
      results: 1,
      passedFirstTime: 0,
      firstPassRate: 0,
    },
  );
  // entity-selection's first push conflicted with its base before any check
  // ran: not a CI result. One of the four pushes whose checks ran passed.
  assert.equal(totals.ci.published, 5);
  assert.equal(totals.ci.conflicts, 1);
  assert.equal(totals.ci.passedFirstTime, 1);
  assert.equal(totals.ci.firstPassRate, 0.25);
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
      ["living-scene", 29_499_710, 3_346_957, 12, 13, 10, 182],
      ["entity-selection", 31_075_957, 8_708_660, 11, 19, 10, 165],
      ["recorded-why", 24_522_060, 4_825_483, 2, 3, 3, 94],
      ["pilot-predeclaration", 101_943, 0, 0, 1, 1, 0],
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
