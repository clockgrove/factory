// Scorecard v3's outcomes (#2223) for the invented Objective, acme/widgets#42
// (bench-fixture.mjs, written by fixtures/bench/generate.mjs), every number
// worked out by hand from the fixture's timeline: the grade from the
// stand-in grader (fixtures/bench/grader.mjs) on the run repository
// fixtureRepository builds, human effort, time to delivery, waste, stage
// escapes and cost.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BENCH_DIR, loadDefinition } from "../bench/lib/definition.mjs";
import { gradeCard, handFixCommits } from "../bench/lib/grade.mjs";
import { HOME_ENV } from "../bench/lib/home.mjs";
import { supersededAttempts, wasteOf } from "../bench/lib/outcomes.mjs";
import { EXAMPLE, fixtureCard, fixtureCopy } from "./bench-fixture.mjs";
import { fixtureRepository } from "./fixtures/bench/generate.mjs";

const GRADER = fileURLToPath(
  new URL("./fixtures/bench/grader.mjs", import.meta.url),
);
const dir = mkdtempSync(join(tmpdir(), "bench-outcomes-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const repo = fixtureRepository(join(dir, "repository"));

/** The fixture's state with Factory's merge commits as the run repository has them. */
const merged = fixtureCopy((stateDir) => {
  const file = join(stateDir, "objectives", "finished", "42.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  for (const [id, sha] of Object.entries(repo.merges))
    Object.assign(state.done[`item:${id}:merge`], {
      mergeSha: sha,
      integratedSha: sha,
    });
  writeFileSync(file, JSON.stringify(state));
});
after(() => rmSync(dirname(merged), { recursive: true, force: true }));

/** The example definition with `grader` (or `change`d), as a file. */
function definitionWith(name, change) {
  const value = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  value.grader = {
    command: `node ${JSON.stringify(GRADER)}`,
    timeoutMinutes: 1,
  };
  change?.(value);
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(value));
  return loadDefinition(file);
}

const harness = () =>
  fixtureCard({ source: "harness" }, merged, { checkout: repo.checkout });

test("human effort: every operator touch by its weight, and the hand fix in the history", async () => {
  const card = await fixtureCard();
  const touch = (kind) =>
    card.operator.decisions
      .filter((d) => d.kind === kind)
      .map((d) => [d.answer, d.touch]);
  // Answers with text, and accepts: judgments. more, adopt, plain retry: stamps.
  assert.deepEqual(touch("diagnosis"), [
    ["answer", "judgment"],
    ["answer", "judgment"],
  ]);
  assert.deepEqual(touch("review"), [
    ["accept", "judgment"],
    ["accept", "judgment"],
  ]);
  assert.deepEqual(touch("spend"), [
    ["more", "stamp"],
    ["more", "stamp"],
  ]);
  assert.deepEqual(touch("final-review"), [["retry", "stamp"]]);
  assert.deepEqual(
    card.operator.actions.map((a) => [a.kind, a.touch]),
    [
      ["decline-discovery", "judgment"],
      ["pause", "stamp"],
      ["resume", "stamp"],
    ],
  );
  // 9 stamped answers (2 spend, 3 allowance, config, CI, QA, final review)
  // and pause and resume: 11 × 1. 4 judged answers and decline-discovery:
  // 5 × 5. A backfill reads no history: no hand fix without --hand-fix.
  assert.deepEqual(
    { ...card.human, fixes: card.human.fixes.length },
    {
      score: 11 + 25,
      unattended: false,
      weights: { stamp: 1, judgment: 5, handFix: 25 },
      stamps: 11,
      judgments: 5,
      handFixes: 0,
      policyStamps: 6,
      fixes: 0,
    },
  );
  // A harness run reads its repository: the merges are Factory's, the
  // commit after the end isn't the run's, and the operator's fix weighs 25.
  const run = await harness();
  assert.equal(run.endCommit, repo.handFix);
  assert.equal(run.defaultBranch, "origin/main");
  assert.deepEqual(run.human.fixes, [
    {
      sha: repo.handFix,
      at: "2031-03-04T12:08:21.000Z",
      from: "history",
      afterFinalReview: true,
    },
  ]);
  assert.equal(run.human.score, 11 + 25 + 25);
  assert.ok(!run.unavailable.some((gap) => gap.metric === "hand fixes"));
});

test("hand fixes: a merge Factory didn't record is one; a merge of a head Factory published isn't", async () => {
  // The committed fixture names no real merge commit: every merge counts.
  const unrecorded = await fixtureCard({ source: "harness" }, undefined, {
    checkout: repo.checkout,
  });
  assert.deepEqual(
    unrecorded.human.fixes.map((fix) => fix.sha),
    [...Object.values(repo.merges), repo.handFix],
  );
  // Merge commits whose other parent is a published head are Factory's.
  const git = (...args) =>
    execFileSync("git", ["-C", repo.checkout, ...args], {
      encoding: "utf8",
    }).trim();
  const heads = new Set(
    Object.values(repo.merges).map((sha) => git("rev-parse", `${sha}^2`)),
  );
  assert.deepEqual(
    handFixCommits(repo.checkout, {
      end: repo.handFix,
      base: repo.base,
      startedAt: repo.timeline.startedAt,
      endedAt: repo.timeline.endedAt,
      merges: new Set(),
      heads,
    }).map((fix) => fix.sha),
    [repo.handFix],
  );
  // A backfill's history has other people's commits: only those given count.
  const given = await fixtureCard({}, merged, {
    checkout: repo.checkout,
    handFixes: [repo.handFix],
  });
  assert.deepEqual(given.human.fixes, [
    {
      sha: repo.handFix,
      at: "2031-03-04T12:08:21.000Z",
      from: "given",
      afterFinalReview: true,
    },
  ]);
  // Given without a repository that has it: counted, but not as after final review.
  const blind = await fixtureCard({}, merged, { handFixes: [repo.handFix] });
  assert.equal(blind.human.handFixes, 1);
  assert.equal(blind.escapes.handFixesAfterFinalReview, 0);
  assert.match(
    blind.unavailable.find((g) => g.metric === "hand fixes after final review")
      .reason,
    /its time is unknown/,
  );
});

test("time to delivery: active time plus a charge per question for the operator", async () => {
  const card = await fixtureCard();
  // 6,171,490 ms active; 7 holds for the operator at 15 min each.
  assert.deepEqual(card.delivery, {
    ms: 6_171_490 + 7 * 900_000,
    activeWallMs: 6_171_490,
    questions: 7,
    questionChargeMs: 900_000,
  });
  assert.equal(card.deliveryMs, 12_471_490);
  const free = definitionWith("free", (d) => {
    d.scoring.questionChargeMinutes = 0;
  });
  assert.equal(
    (await fixtureCard({}, undefined, { definition: free })).deliveryMs,
    6_171_490,
  );
  // Without `scoring`, the charge is 15 min.
  const plain = definitionWith("plain", (d) => {
    delete d.scoring;
  });
  assert.equal(
    (await fixtureCard({}, undefined, { definition: plain })).deliveryMs,
    12_471_490,
  );
});

test("waste: by cause and Work Item, from the run log's attempts and the state", async () => {
  const { waste, totals } = await fixtureCard();
  // outage: export-csv's first worker call, cut by the first restart (55,000, 200 s).
  // hedge: final review's hedge that lost (600,000, 0.1 s).
  // amendment: worker-export-csv-1, rejected (140,000 + 90,000; 45 + 20 s),
  //   and worker-export-csv-2, unchanged (100,000 + 110,000 and two calls
  //   of unknown tokens; 30 + 1.6 + 1.6 + 25 s).
  // superseded: query-api's first result review, of the result its base
  //   conflict made again (280,000, 55 s), and worker-tokenizer-1's first
  //   plan, which its review sent back (120,000, 52 s).
  assert.deepEqual(waste.byCause, {
    outage: { tokens: 55_000, modelMs: 200_000, calls: 1, unknownCalls: 0 },
    hedge: { tokens: 600_000, modelMs: 100, calls: 1, unknownCalls: 0 },
    amendment: {
      tokens: 440_000,
      modelMs: 123_200,
      calls: 6,
      unknownCalls: 2,
    },
    superseded: {
      tokens: 400_000,
      modelMs: 107_000,
      calls: 2,
      unknownCalls: 0,
    },
  });
  // A repaired result is built on, not waste: tokenizer's and export-csv's
  // work, and final validation and review after the operator's fix.
  assert.deepEqual(waste.byItem, {
    tokenizer: { tokens: 120_000, modelMs: 52_000, calls: 1, unknownCalls: 0 },
    "query-api": {
      tokens: 280_000,
      modelMs: 55_000,
      calls: 1,
      unknownCalls: 0,
    },
    "export-csv": {
      tokens: 495_000,
      modelMs: 323_200,
      calls: 7,
      unknownCalls: 2,
    },
    objective: { tokens: 600_000, modelMs: 100, calls: 1, unknownCalls: 0 },
  });
  assert.equal(waste.tokens, 1_495_000);
  assert.equal(waste.modelMs, 430_300);
  assert.equal(totals.modelMs, 4_238_300);
  assert.equal(waste.tokensShare, 1_495_000 / 19_914_000);
  assert.equal(waste.modelMsShare, 430_300 / 4_238_300);
});

test("waste's rules: a repair builds on a result; an aborted attempt is no outage", () => {
  const attempt = (key, step, outcome, outcomeAt, file = 0) => ({
    key,
    step,
    file,
    outcome,
    outcomeAt,
    aborted: false,
  });
  // work#1 done, then validation sends it back: work#2 repairs it.
  // review#1 done, then a conflict sends work back: review#2 reviews again.
  const attempts = [
    attempt("w1", "item:a:work", "done", 1),
    attempt("r1", "item:a:review", "done", 3),
    attempt("w2", "item:a:work", "done", 6),
    attempt("r2", "item:a:review", "done", 8),
  ];
  assert.deepEqual(
    [...supersededAttempts(attempts, [{ at: 4, target: "item:a:work" }])],
    ["r1"],
  );
  // With no repair between them, work#2 made the result again.
  assert.deepEqual([...supersededAttempts(attempts, [])].sort(), ["r1", "w1"]);
  // An attempt with no outcome in its run file: an outage cut it, unless
  // the engine aborted it, or it is in the last run file (still running).
  const call = { attempt: "x", item: null, tokens: 10, ms: 1, error: null };
  const waste = (cut, files) =>
    wasteOf({
      calls: [call],
      attempts: [{ ...attempt("x", "item:a:work", null, null), ...cut }],
      files,
      repairs: [],
      amendmentFate: () => undefined,
      totals: { tokens: 100, modelMs: 10 },
    }).byCause.outage.tokens;
  assert.equal(waste({}, 2), 10);
  assert.equal(waste({ aborted: true }, 2), 0);
  assert.equal(waste({}, 1), 0);
});

test("grade: the stand-in grader's mixed verdicts on a fresh checkout at the end commit", async () => {
  const card = await harness();
  const definition = definitionWith("graded");
  await gradeCard(card, definition, { repo: repo.checkout });
  // It refuses a checkout that isn't BENCH_COMMIT, or past the end.
  assert.deepEqual(
    { ...card.grade, criteria: card.grade.criteria.map((c) => c.verdict) },
    {
      graderVersion: "acme-widgets-42 stand-in 1",
      commit: repo.handFix,
      passed: 3,
      failed: 1,
      unknown: 1,
      passRate: 3 / 5,
      criteria: ["pass", "pass", "pass", "fail", "unknown"],
    },
  );
  assert.deepEqual(card.grade.criteria[2], {
    id: "csv-quoted",
    text: "Values with commas are quoted",
    verdict: "pass",
    method: "read the source",
    evidence: { file: "src/api/export.ts", looked: "quote" },
  });
  // Final review refused once, the operator fixed it after final review,
  // and final review passed the row limit the grader fails.
  assert.deepEqual(card.escapes, {
    total: 3,
    finalReviewRefusals: 1,
    handFixesAfterFinalReview: 1,
    graderFailedPassed: 1,
  });
  assert.ok(!card.unavailable.some((gap) => gap.metric === "grade"));
});

test("escapes: final review passed by its step, not its last logged review", async () => {
  /** The merged fixture with final review's last review, its call and its event, left out; `done` false: the step not done either. */
  const variant = (done) =>
    fixtureCopy((stateDir) => {
      cpSync(merged, stateDir, { recursive: true });
      const file = join(stateDir, "objectives", "finished", "42.json");
      const state = JSON.parse(readFileSync(file, "utf8"));
      if (!done) delete state.done["final-review"];
      writeFileSync(file, JSON.stringify(state));
      const logs = join(stateDir, "logs", "42");
      for (const name of readdirSync(logs)) {
        const lines = readFileSync(join(logs, name), "utf8")
          .split("\n")
          .filter(
            (line) =>
              !(
                line.includes('"attemptId":"final-review#3"') &&
                line.includes("objective-review")
              ),
          );
        writeFileSync(join(logs, name), lines.join("\n"));
      }
    });
  const graded = definitionWith("settled");
  const escapes = async (stateDir) => {
    const card = await fixtureCard({ source: "harness" }, stateDir, {
      checkout: repo.checkout,
    });
    await gradeCard(card, graded, { repo: repo.checkout });
    rmSync(dirname(stateDir), { recursive: true, force: true });
    return [card.totals.final, card.escapes];
  };
  // The operator answered the refusal with `accept <n>`: every criterion
  // settled, final review passed without a review, and the last one logged
  // is the refusal. The row limit the grader fails still escaped it.
  assert.deepEqual(await escapes(variant(true)), [
    {
      runs: 2,
      passed: 2,
      review: { outcome: "refused", criteria: 19 },
      reviewPassed: true,
    },
    {
      total: 3,
      finalReviewRefusals: 1,
      handFixesAfterFinalReview: 1,
      graderFailedPassed: 1,
    },
  ]);
  // Final review never passed (the Objective ended on its refusal): what
  // the grader fails didn't get past it.
  const [final, never] = await escapes(variant(false));
  assert.equal(final.reviewPassed, false);
  assert.deepEqual(never, {
    total: 2,
    finalReviewRefusals: 1,
    handFixesAfterFinalReview: 1,
    graderFailedPassed: 0,
  });
});

test("grade: a grader that fails, times out or writes nonsense is an error, never a rate", async () => {
  const cases = [
    ["exits", 'node -e "process.exit(4)"', /^the grader exited 4/],
    [
      "sleeps",
      'node -e "setTimeout(() => {}, 60000)"',
      /^the grader timed out after 0\.005 min/,
      0.005,
    ],
    [
      "garbles",
      `node -e "require('fs').writeFileSync(process.env.BENCH_OUT, 'pass')"`,
      /^BENCH_OUT is not JSON/,
    ],
    [
      "invents",
      `node -e "require('fs').writeFileSync(process.env.BENCH_OUT, JSON.stringify({graderVersion: '1', criteria: [{id: 'a', verdict: 'mostly'}]}))"`,
      /criterion 1 needs an id and a verdict of pass, fail, unknown/,
    ],
    ["writes nothing", "true", /^the grader wrote nothing to BENCH_OUT/],
  ];
  for (const [name, command, error, timeoutMinutes = 1] of cases) {
    const card = await harness();
    const definition = definitionWith(name.replace(" ", "-"), (d) => {
      d.grader = { command, timeoutMinutes };
    });
    await gradeCard(card, definition, { repo: repo.checkout });
    assert.match(card.grade.error, error, name);
    assert.equal(card.grade.passRate, null, name);
    assert.equal(card.grade.passed, null, name);
    assert.equal(card.escapes.graderFailedPassed, null, name);
    assert.equal(card.escapes.total, 2, name);
    assert.match(
      card.unavailable.find((gap) => gap.metric === "grade").reason,
      /^the grader failed: /,
      name,
    );
  }
  // No grader, or nothing to grade: no grade, and the card says why.
  const card = await harness();
  const none = definitionWith("none", (d) => {
    delete d.grader;
  });
  await gradeCard(card, none, { repo: repo.checkout });
  assert.equal(card.grade, null);
  assert.equal(
    card.unavailable.find((gap) => gap.metric === "grade").reason,
    "the definition has no grader",
  );
  await gradeCard(card, definitionWith("graded"), { repo: null });
  assert.match(
    card.unavailable.find((gap) => gap.metric === "grade").reason,
    /give --grade-tree DIR --grade-commit SHA/,
  );
});

test("cost: each call's tokens at its model's price, or none", async () => {
  const { cost } = await fixtureCard();
  // Every call's own and child-thread tokens: input 19,754,688 of which
  // 17,814,336 cached, output 159,312 (0.8% of each call's total, 90% and
  // 92% of input cached). At $1.25, $0.125 and $10 per million:
  // 2.42544 + 2.226792 + 1.59312.
  assert.deepEqual(cost.byModel["gpt-test"], {
    calls: 37,
    uncachedInput: 19_754_688 - 17_814_336,
    cachedInput: 17_814_336,
    output: 159_312,
    usd: cost.usd,
  });
  assert.ok(Math.abs(cost.usd - 6.245352) < 1e-9, String(cost.usd));
  assert.equal(cost.unknownCalls, 2);
  // A model without a price: no total, never a partial one.
  const other = definitionWith("unpriced", (d) => {
    d.prices = { "another-model": d.prices["gpt-test"] };
  });
  const unpriced = await fixtureCard({}, undefined, { definition: other });
  assert.equal(unpriced.cost.usd, null);
  assert.deepEqual(unpriced.cost.unpriced, ["gpt-test"]);
  assert.match(
    unpriced.unavailable.find((gap) => gap.metric === "cost").reason,
    /prices no gpt-test/,
  );
  const free = definitionWith("unpriced-all", (d) => {
    delete d.prices;
  });
  assert.equal(
    (await fixtureCard({}, undefined, { definition: free })).cost,
    null,
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

test("score.mjs grades a backfill on --grade-tree at --grade-commit, and --grade-only grades it again", () => {
  const results = join(dir, "results");
  const graded = definitionWith("cli");
  const backfill = [
    "--state-dir",
    merged,
    "--issue",
    "42",
    "--run-id",
    "backfill",
    "--label",
    "backfill",
    "--results",
    results,
  ];
  // --grade-commit names a commit of --grade-tree's repository.
  const alone = scoreCli([
    "--benchmark",
    graded.file,
    ...backfill,
    "--grade-commit",
    repo.handFix,
  ]);
  assert.equal(alone.status, 64, alone.stderr);
  assert.match(alone.stderr, /--grade-commit needs --grade-tree DIR/);
  const run = scoreCli([
    "--benchmark",
    graded.file,
    ...backfill,
    "--grade-tree",
    repo.origin,
    "--grade-commit",
    repo.handFix,
    "--hand-fix",
    repo.handFix,
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /; grade 3 of 5 criteria passed\n$/);
  const file = join(results, "acme-widgets-42", "backfill.json");
  const card = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(card.schemaVersion, 3);
  assert.equal(card.grade.passRate, 3 / 5);
  assert.equal(card.human.score, 61);
  assert.equal(card.escapes.total, 3);
  // Graded again by a grader that fails: recorded, exit 70, the rest kept.
  const broken = definitionWith("cli-broken", (d) => {
    d.grader.command = 'node -e "process.exit(9)"';
  });
  const again = scoreCli([
    "--benchmark",
    broken.file,
    ...backfill,
    "--grade-tree",
    repo.origin,
    "--grade-commit",
    repo.handFix,
    "--grade-only",
  ]);
  assert.equal(again.status, 70, again.stderr);
  assert.match(again.stdout, /the grader failed: the grader exited 9/);
  const regraded = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(regraded.grade.passRate, null);
  assert.match(regraded.grade.error, /exited 9/);
  assert.equal(regraded.escapes.total, 2);
  assert.equal(regraded.human.score, 61);
  // --grade-only needs a card of this version.
  writeFileSync(file, JSON.stringify({ ...regraded, schemaVersion: 2 }));
  const old = scoreCli([
    "--benchmark",
    graded.file,
    ...backfill,
    "--grade-tree",
    repo.origin,
    "--grade-only",
  ]);
  assert.equal(old.status, 64, old.stderr);
  assert.match(old.stderr, /is scorecard version 2, not 3: score it again/);
});
