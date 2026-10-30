// The scorecard of an invented Objective, acme/widgets#42 (bench-fixture.mjs,
// written by fixtures/bench/generate.mjs). Three run files: two restarts,
// the second inside an operator pause; Codex calls whose resumed sessions
// repeat their child threads' cumulative usage; holds of every kind, each
// waiting with nothing running; repairs, amendments, CI reruns, a merge
// conflict with the base branch, and final review's refusal. The outcome
// metrics are bench-outcomes.test.mjs's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { BENCH_DIR } from "../bench/lib/definition.mjs";
import { HOME_ENV } from "../bench/lib/home.mjs";
import {
  EXAMPLE,
  FIXTURE_STATE,
  fixtureCard,
  fixtureCopy,
} from "./bench-fixture.mjs";
import { fixtureFiles } from "./fixtures/bench/generate.mjs";

test("the committed fixture is what its generator writes", () => {
  const files = fixtureFiles();
  for (const [path, text] of files) {
    const committed = readFileSync(join(FIXTURE_STATE, path), "utf8");
    // The state is JSON the formatter may lay out differently.
    if (path.endsWith(".json"))
      assert.deepEqual(JSON.parse(committed), JSON.parse(text), path);
    else assert.equal(committed, text, path);
  }
  const committed = readdirSync(FIXTURE_STATE, { recursive: true })
    .filter((path) => statSync(join(FIXTURE_STATE, path)).isFile())
    .sort();
  assert.deepEqual(committed, [...files.keys()].sort());
});

test("tokens: each resumed session's child threads counted once", async () => {
  const card = await fixtureCard();
  const { tokens } = card.totals;
  assert.equal(card.outcome, "done");
  assert.deepEqual(card.factory.versions, ["0.5.7", "0.5.8"]);
  // What the 0.5.7/0.5.8 spend limit counted: the calls' own tokens.
  assert.equal(tokens.counted, 18_144_000);
  assert.equal(tokens.own, 18_144_000);
  // Resumed sessions repeat 400,000, 300,000 and 520,000 cumulative child
  // tokens, and two report 650,000 and 210,000 after 400,000 and 150,000:
  // 3,540,000 summed naively, 1,770,000 counted once.
  assert.equal(tokens.childThreads, 1_770_000);
  assert.equal(tokens.childThreadCount, 9);
  assert.equal(tokens.total, 19_914_000);
  // The spend ledger never charged the call the first restart replaced.
  assert.equal(tokens.spendLedger, 18_144_000 - 55_000);
  assert.equal(tokens.unknownCalls, 2);
  assert.ok(
    card.checks.every((check) => check.ok),
    JSON.stringify(card.checks),
  );
});

test("active time leaves out the outages, the pause and waits for an answer", async () => {
  const card = await fixtureCard();
  const { totals } = card;
  assert.equal(card.partial, false);
  // Admitted 09:00:04, ended 12:21:08.990.
  assert.equal(totals.wallMs, 12_064_990);
  assert.deepEqual(
    totals.outages.map((outage) => [outage.ms, outage.runEnd]),
    [
      [6_500, "handed-off"],
      [55_000, "handed-off"],
    ],
  );
  assert.deepEqual(
    totals.pauses.map((pause) => pause.ms),
    [2_480_000],
  );
  // The second outage falls inside the pause: excluded once.
  assert.equal(totals.downtimeMs, 2_480_000 + 6_500);
  // A hold open and no step in progress: Factory waits on whoever answers.
  // Every hold here waits so; final review's refusal is the longest.
  assert.equal(totals.holdBlocked.length, 13);
  assert.deepEqual(totals.holdBlocked.at(-1), {
    from: "2031-03-04T12:01:41.790Z",
    to: "2031-03-04T12:11:41.790Z",
    ms: 600_000,
  });
  assert.deepEqual(
    totals.holdBlocked.find((span) => span.from.startsWith("2031-03-04T11:39")),
    {
      from: "2031-03-04T11:39:43.070Z",
      to: "2031-03-04T11:51:13.070Z",
      ms: 690_000,
    },
  );
  assert.equal(totals.holdBlockedMs, 2_807_000 + 600_000);
  assert.equal(totals.excludedMs, totals.downtimeMs + totals.holdBlockedMs);
  assert.equal(totals.activeWallMs, 12_064_990 - 2_486_500 - 3_407_000);
  // The operator's waits stay a diagnostic of their own.
  assert.equal(totals.holds.operatorWaitMs, 2_340_000 + 600_000);
  const smoke = card.items.find((item) => item.id === "release-smoke");
  assert.equal(smoke.holdBlockedMs, 690_000);
  assert.equal(smoke.activeWallMs, 18_820);
  // An item's active time also leaves out the Objective's own waits in its
  // span: export-csv's include the changed configuration's 22 s.
  const exportCsv = card.items.find((item) => item.id === "export-csv");
  assert.equal(exportCsv.holdBlockedMs, 1_250_000 + 22_000);
});

test("a hold's wait leaves out the downtime inside it; the raw wait is kept for the check", async () => {
  // The fixture with an operator pause inside the QA hold, 11:45 to 11:50.
  const stateDir = fixtureCopy((dir) => {
    const logs = join(dir, "logs", "42");
    const file = join(
      logs,
      readdirSync(logs).find((name) => name.startsWith("2031-03-04T10-34")),
    );
    const request = (at, seq, kind) =>
      JSON.stringify({
        at,
        seq,
        event: "request",
        by: "operator",
        message: "ok",
        request: { kind, issue: 42 },
      });
    const lines = readFileSync(file, "utf8").split("\n");
    const after = lines.findIndex((line) =>
      line.includes('"id":"item:release-smoke:validate@'),
    );
    lines.splice(
      after + 1,
      0,
      request("2031-03-04T11:45:00.000Z", 9001, "pause"),
      request("2031-03-04T11:50:00.000Z", 9002, "resume"),
    );
    writeFileSync(file, lines.join("\n"));
  });
  after(() => rmSync(dirname(stateDir), { recursive: true, force: true }));
  const card = await fixtureCard({}, stateDir);
  const qa = card.operator.decisions.find((d) => d.kind === "qa");
  assert.equal(qa.rawWaitMs, 690_000);
  assert.equal(qa.waitMs, 690_000 - 300_000);
  assert.equal(card.totals.holds.byKind.qa.waitMs, 390_000);
  assert.equal(card.totals.holds.operatorWaitMs, 2_940_000 - 300_000);
  assert.equal(card.totals.holds.rawWaitMs, 3_407_000);
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

/** bench/score.mjs with `args`, never reading the environment's bench home. */
function scoreCli(args) {
  const env = { ...process.env };
  delete env[HOME_ENV];
  return spawnSync(process.execPath, [join(BENCH_DIR, "score.mjs"), ...args], {
    encoding: "utf8",
    env,
  });
}

test("an Objective that hasn't ended scores a partial card", async () => {
  const stateDir = fixtureCopy((dir) => {
    const file = join(dir, "objectives", "finished", "42.json");
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
  // The CLI never writes it into the results.
  const results = mkdtempSync(join(tmpdir(), "bench-results-"));
  after(() => rmSync(results, { recursive: true, force: true }));
  const run = scoreCli([
    "--benchmark",
    EXAMPLE,
    "--results",
    results,
    "--state-dir",
    stateDir,
    "--issue",
    "42",
    "--run-id",
    "partial",
    "--label",
    "partial",
  ]);
  assert.equal(run.status, 65, run.stderr);
  assert.match(run.stderr, /is running, not ended: .*partial/);
  assert.deepEqual(readdirSync(results), []);
});

test("scorecards go only where they are told: outside the Factory repository", () => {
  const args = [
    "--state-dir",
    FIXTURE_STATE,
    "--issue",
    "42",
    "--run-id",
    "nowhere",
    "--label",
    "nowhere",
  ];
  // No results directory: refused, nothing written.
  const refused = scoreCli(["--benchmark", EXAMPLE, ...args]);
  assert.equal(refused.status, 64, refused.stderr);
  assert.match(
    refused.stderr,
    /no results directory\. Benchmark definitions and results live outside the Factory repository: give --results DIR, or --bench-home DIR/,
  );
  assert.ok(
    !existsSync(join(BENCH_DIR, "results", "acme-widgets-42", "nowhere.json")),
  );
  // A definition by id needs its directory too.
  const byId = scoreCli(["--benchmark", "acme-widgets-42", "--print", ...args]);
  assert.equal(byId.status, 64, byId.stderr);
  assert.match(byId.stderr, /no definitions directory/);
  // A bench home has both.
  const home = mkdtempSync(join(tmpdir(), "bench-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const benchmarks = join(home, "benchmarks");
  mkdirSync(benchmarks);
  writeFileSync(
    join(benchmarks, "acme-widgets-42.json"),
    readFileSync(EXAMPLE, "utf8"),
  );
  const scored = scoreCli([
    "--bench-home",
    home,
    "--benchmark",
    "acme-widgets-42",
    ...args,
  ]);
  assert.equal(scored.status, 0, scored.stderr);
  const card = JSON.parse(
    readFileSync(
      join(home, "results", "acme-widgets-42", "nowhere.json"),
      "utf8",
    ),
  );
  assert.equal(card.totals.tokens.total, 19_914_000);
});

test("a harness run is scored where its record says, unless a flag says otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-run-results-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, "run1");
  mkdirSync(runDir);
  const recorded = join(dir, "recorded");
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      runId: "r1",
      label: "r1",
      group: "r1",
      repository: "acme/widgets",
      issue: 42,
      stateDir: FIXTURE_STATE,
      definitionFile: EXAMPLE,
      resultsDir: recorded,
    }),
  );
  const exported = join(dir, "exported");
  const score = (...args) =>
    spawnSync(
      process.execPath,
      [join(BENCH_DIR, "score.mjs"), "--run-dir", runDir, ...args],
      { encoding: "utf8", env: { ...process.env, [HOME_ENV]: exported } },
    );
  const card = (results) => join(results, "acme-widgets-42", "r1.json");
  // An exported bench home doesn't override what provisioning recorded.
  const run = score();
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(card(recorded)));
  assert.ok(!existsSync(exported));
  // A flag does.
  const flagged = join(dir, "flagged");
  assert.equal(score("--results", flagged).status, 0);
  assert.ok(existsSync(card(flagged)));
  const home = join(dir, "home");
  assert.equal(score("--bench-home", home).status, 0);
  assert.ok(existsSync(card(join(home, "results"))));
  assert.ok(!existsSync(exported));
});

test("repairs, holds by kind, validation, CI and per Work Item", async () => {
  const card = await fixtureCard();
  const { totals } = card;
  // tokenizer's worker validation, validation and review sent it back;
  // query-api's push conflicted with its base; export-csv's validation;
  // final review, after the operator's fix, sent final validation back.
  assert.equal(totals.repairs, 6);
  assert.equal(totals.holds.total, 13);
  assert.equal(totals.holds.scripted, 6);
  assert.equal(totals.holds.operator, 7);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(totals.holds.byKind).map(([kind, k]) => [kind, k.count]),
    ),
    {
      diagnosis: 2,
      allowance: 3,
      review: 2,
      spend: 2,
      config: 1,
      ci: 1,
      qa: 1,
      "final-review": 1,
    },
  );
  // Final validation ran twice, before and after the operator's fix; final
  // review refused, then passed.
  assert.deepEqual(totals.final, {
    runs: 2,
    passed: 2,
    review: { outcome: "pass", criteria: 19 },
  });
  // The plan as amended: tokenizer's amendment added a criterion.
  assert.equal(totals.criteria, 19);
  assert.deepEqual(totals.planning, {
    rounds: 2,
    generations: 1,
    revisions: 6,
  });
  assert.deepEqual(totals.amendments, {
    proposed: 3,
    accepted: 1,
    rejected: 1,
    unchanged: 1,
    plannerAnswers: 4,
  });
  // export-csv's spend hold in validation is no verdict: its next run is
  // the result's first validation. The QA hold counts as release-smoke's
  // result not passing; the operator's retry validated the same result again.
  assert.deepEqual(totals.validation, {
    runs: 8,
    passed: 6,
    holds: 2,
    passRate: 6 / 8,
    results: 8,
    passedFirstTime: 5,
    firstPassRate: 5 / 8,
  });
  assert.deepEqual(
    card.items.find((item) => item.id === "release-smoke").validation,
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
  // query-api's first push conflicted with its base before any check ran:
  // not a CI result. tokenizer's was rerun and export-csv's held; one of
  // the three pushes whose checks ran passed.
  assert.equal(totals.ci.published, 4);
  assert.equal(totals.ci.rounds, 5);
  assert.equal(totals.ci.conflicts, 1);
  assert.equal(totals.ci.passedFirstTime, 1);
  assert.equal(totals.ci.firstPassRate, 1 / 3);
  assert.deepEqual(
    card.items.map((item) => [
      item.id,
      item.outcome,
      item.tokens.own,
      item.tokens.childThreads,
      item.repairs,
      item.holds.total,
      item.validation.runs,
      Math.round(item.activeWallMs / 60_000),
    ]),
    [
      ["tokenizer", "merged", 7_059_000, 740_000, 3, 3, 3, 34],
      ["query-api", "merged", 2_590_000, 300_000, 1, 1, 2, 14],
      ["export-csv", "merged", 4_715_000, 730_000, 1, 6, 2, 28],
      ["release-smoke", "settled", 90_000, 0, 0, 1, 1, 0],
    ],
  );
  // Planning and the final reviews are the Objective's own.
  assert.equal(card.objective.tokens.total, 3_690_000);
  assert.equal(card.operator.decisions.length, 13);
  assert.deepEqual(
    card.operator.actions.map((action) => action.kind),
    ["decline-discovery", "pause", "resume"],
  );
  assert.deepEqual(card.telemetry.hedges, {
    "reviewer objective-review": {
      hedged: 1,
      won: 0,
      lost: 1,
      tokens: 600_000,
      tokensUnknown: 0,
    },
  });
  assert.deepEqual(
    card.unavailable.map((gap) => gap.metric),
    ["costUsd", "tokens of some calls", "hand fixes", "grade"],
  );
});
