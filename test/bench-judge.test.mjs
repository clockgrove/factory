// The blind pairwise review (#2224): a stand-in judge with fixed preferences
// (fixtures/bench/judge.mjs) compares final trees of the run repository
// fixtureRepository builds. The candidate's trees quote CSV values (the
// operator's fix), and one baseline tree doesn't: the judge prefers quoting
// on intent and the shorter export on quality. Blinding, unblinding, win
// rates, the kept judgments, calibration against a person's choices, and
// report.mjs compare and calibrate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BENCH_DIR, loadDefinition } from "../bench/lib/definition.mjs";
import { HOME_ENV } from "../bench/lib/home.mjs";
import {
  agreementOf,
  blindOrder,
  pairKey,
  pairwise,
  winner,
  winRates,
} from "../bench/lib/judge.mjs";
import { verdict } from "../bench/lib/metrics.mjs";
import { EXAMPLE, fixtureCard } from "./bench-fixture.mjs";
import { fixtureRepository } from "./fixtures/bench/generate.mjs";

const JUDGE = fileURLToPath(
  new URL("./fixtures/bench/judge.mjs", import.meta.url),
);
const home = mkdtempSync(join(tmpdir(), "bench-judge-test-"));
after(() => rmSync(home, { recursive: true, force: true }));
const repo = fixtureRepository(join(home, "repository"));
/** The operator's fix quotes values; export-csv's merge doesn't. */
const QUOTED = repo.handFix;
const PLAIN = repo.merges["export-csv"];
const BASELINE = "acme/widgets#42, Factory 0.5.8";
const CANDIDATE = "acme/widgets#42, Factory 0.6.0";
const OBJECTIVE = "Query widgets and export the results as CSV.\n";
const LOG = join(home, "judge.log");
process.env.STAND_IN_JUDGE_LOG = LOG;
const calls = () =>
  existsSync(LOG)
    ? readFileSync(LOG, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];

const scored = await fixtureCard();
const results = join(home, "results", "acme-widgets-42");
mkdirSync(results, { recursive: true });
// The bench home's graders/, which a judge finds beside its definition as a grader does.
mkdirSync(join(home, "graders"));

/** A harness run's card and run directory: its tree is `commit` of the run repository. */
function harnessCard(id, group, commit, { dir = true } = {}) {
  const runDir = join(home, "runs", "acme-widgets-42", id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ runId: id, checkout: repo.checkout, runDir }),
  );
  writeFileSync(join(runDir, "objective.md"), OBJECTIVE);
  const card = structuredClone(scored);
  card.run = {
    ...card.run,
    id,
    label: id,
    group,
    source: "harness",
    ...(dir ? { dir: runDir } : {}),
  };
  card.endCommit = commit;
  card.grade = {
    graderVersion: "acme-widgets-42 stand-in 1",
    commit,
    passed: 3,
    failed: 1,
    unknown: 1,
    passRate: 0.6,
    criteria: [],
    metrics: {},
  };
  if (group === CANDIDATE) card.human.score = 12;
  writeFileSync(join(results, `${id}.json`), JSON.stringify(card));
  return card;
}

const candidates = [
  harnessCard("cand-one", CANDIDATE, QUOTED),
  harnessCard("cand-two", CANDIDATE, QUOTED),
];
const baselines = [
  harnessCard("base-plain", BASELINE, PLAIN),
  harnessCard("base-quoted", BASELINE, QUOTED),
];
const IDS = [...candidates, ...baselines].map((card) => card.run.id);

/** The example with the stand-in judge (`args` after it) and `change`, as a file in the bench home. */
function judged(args = "", change) {
  const value = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  value.baseline = BASELINE;
  value.judge = {
    command: `node ${JSON.stringify(JUDGE)}${args ? ` ${args}` : ""}`,
    timeoutMinutes: 1,
  };
  delete value.judgeCalibration;
  change?.(value);
  mkdirSync(join(home, "benchmarks"), { recursive: true });
  const file = join(home, "benchmarks", "acme-widgets-42.json");
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return loadDefinition(file);
}

const review = (definition, cards = [...candidates, ...baselines]) =>
  pairwise(definition, {
    baseline: baselines,
    candidate: candidates,
    cards,
    dir: join(results, "judgments"),
  });

test("blinding: the order comes from the run ids, never from which run is the candidate", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `run-${i}`);
  let firstIsA = 0;
  let firstIsB = 0;
  for (const x of ids)
    for (const y of ids) {
      if (x >= y) continue;
      // The same pair in either role order: the same A and B.
      assert.deepEqual(blindOrder(x, y), blindOrder(y, x));
      assert.deepEqual([...blindOrder(x, y)].sort(), [x, y]);
      assert.equal(pairKey(x, y), pairKey(y, x));
      if (blindOrder(x, y)[0] === x) firstIsA += 1;
      else firstIsB += 1;
    }
  // Neither the first-named nor the lower id is always A.
  assert.ok(firstIsA > 40 && firstIsB > 40, `${firstIsA} / ${firstIsB}`);
});

test("pairwise: every candidate run against every baseline run, judged blind and unblinded", async () => {
  rmSync(LOG, { force: true });
  const definition = judged();
  const result = await review(definition);
  assert.deepEqual(result.warnings, [
    "the judge is uncalibrated: the definition has no judgeCalibration (record a person's choices with report.mjs calibrate)",
  ]);
  const given = calls();
  assert.equal(given.length, 4);
  // Unblinded to run ids: against the plain tree, the candidate wins on
  // intent and loses on quality; against an equal tree, both tie.
  const outcome = Object.fromEntries(
    result.pairs.map((pair) => [
      `${pair.candidate} ${pair.baseline}`,
      [winner(pair, "intent"), winner(pair, "quality")],
    ]),
  );
  assert.deepEqual(outcome, {
    "cand-one base-plain": ["cand-one", "base-plain"],
    "cand-one base-quoted": ["tie", "tie"],
    "cand-two base-plain": ["cand-two", "base-plain"],
    "cand-two base-quoted": ["tie", "tie"],
  });
  // Ties count half: (1 + ½ + 1 + ½) / 4 on intent, (0 + ½ + 0 + ½) / 4 on quality.
  assert.deepEqual(result.rates, { pairs: 4, intent: 0.75, quality: 0.25 });
  for (const pair of result.pairs) {
    // A and B are the blind order of the pair's ids, and A's tree is A's commit.
    assert.deepEqual(
      [pair.A.run, pair.B.run],
      blindOrder(pair.candidate, pair.baseline),
    );
    assert.equal(pair.judgeVersion, "acme-widgets-42 stand-in judge 1");
    assert.equal(pair.cached, false);
  }
  for (const call of given) {
    // Nothing the judge is given names a run: no environment value, no
    // path, no tree's history (the judge refuses a .git), and the
    // definition's copy has no baseline group or calibration runs.
    for (const [name, value] of Object.entries(call.env))
      for (const id of IDS)
        assert.ok(!value.includes(id), `${name} names ${id}: ${value}`);
    assert.ok(!IDS.some((id) => call.cwd.includes(id)));
    assert.equal(call.objective, OBJECTIVE);
    assert.ok(call.graders, "graders/ beside the definition's copy");
    assert.ok(call.definition.includes("judge"));
    assert.ok(!call.definition.includes("baseline"));
    assert.ok(!call.definition.includes("judgeCalibration"));
  }
  // Which tree was A, as the judge saw it, follows the hash, not the role.
  const plainSide = given
    .filter((call) => call.quoted.A !== call.quoted.B)
    .map((call) => (call.quoted.A ? "candidate is A" : "candidate is B"));
  const expected = ["cand-one", "cand-two"].map((id) =>
    blindOrder(id, "base-plain")[0] === id
      ? "candidate is A"
      : "candidate is B",
  );
  assert.deepEqual(plainSide, expected);

  // Accepted on outcomes and the intent win rate.
  const decision = verdict(definition, baselines, candidates, {
    pairwise: result,
  });
  assert.equal(decision.accept, true, decision.reasons.join("; "));
});

test("judgments are kept: a judged pair isn't judged again, unless the judge's command changes", async () => {
  rmSync(LOG, { force: true });
  const definition = judged();
  const first = await review(definition);
  const kept = await review(definition);
  assert.ok(kept.pairs.every((pair) => pair.cached));
  assert.deepEqual(kept.rates, first.rates);
  assert.equal(calls().length, first.pairs.filter((p) => !p.cached).length);
  assert.equal(
    readdirSync(join(results, "judgments")).length,
    4,
    "one file per pair",
  );
  // Another judge (here the same one, preferring the plain export): judged
  // again, and the candidate now loses on intent.
  const before = calls().length;
  const contrary = judged("prefer-plain");
  const again = await review(contrary);
  assert.ok(again.pairs.every((pair) => !pair.cached));
  assert.equal(calls().length, before + 4);
  assert.deepEqual(again.rates, { pairs: 4, intent: 0.25, quality: 0.25 });
  assert.deepEqual(
    verdict(contrary, baselines, candidates, { pairwise: again }).reasons,
    ["pairwise intent win rate 25% is below 50%"],
  );
});

test("a judge that fails is no judgment: not kept, and unknown never passes", async () => {
  const definition = {
    ...judged(),
    judge: {
      command: `node -e "require('fs').writeFileSync(process.env.BENCH_OUT, JSON.stringify({judgeVersion: '1', intent: 'C', quality: 'A'}))"`,
      timeoutMinutes: 1,
    },
  };
  const result = await review(definition);
  assert.equal(result.rates.intent, null);
  assert.equal(result.pairs.length, 4);
  assert.match(
    result.warnings[0],
    /^cand-one against base-plain wasn't judged: BENCH_OUT's intent must be A, B, tie/,
  );
  assert.deepEqual(
    verdict(definition, baselines, candidates, { pairwise: result }).reasons,
    [
      "pairwise intent win rate is unknown: no pair was judged, and with a judge it decides",
    ],
  );
  // Nothing was kept for this command: the next run judges again.
  for (const name of readdirSync(join(results, "judgments")))
    assert.notEqual(
      JSON.parse(readFileSync(join(results, "judgments", name), "utf8"))
        .command,
      definition.judge.command,
    );
});

test("calibration: the judge's choices against a person's, with a warning below the threshold", async () => {
  // The person's own order: A is runA. They chose as the judge does on
  // the first pair, and differently on both aspects of the second.
  const choice = (runA, runB, intent, quality) => ({
    runA,
    runB,
    intent,
    quality,
    by: "a widgets maintainer",
    at: "2031-03-06T10:00:00.000Z",
  });
  const agreeing = choice("base-plain", "cand-one", "B", "A");
  const disagreeing = choice("cand-two", "base-plain", "B", "tie");
  rmSync(LOG, { force: true });
  const trusted = await review(
    judged("", (d) => {
      d.judgeCalibration = [agreeing];
    }),
  );
  assert.deepEqual(trusted.warnings, []);
  assert.deepEqual(
    { ...trusted.calibration, entries: trusted.calibration.entries.length },
    {
      calibrated: true,
      min: 0.8,
      choices: 2,
      agreed: 2,
      rate: 1,
      intent: 1,
      quality: 1,
      entries: 1,
    },
  );
  const untrusted = await review(
    judged("", (d) => {
      d.judgeCalibration = [
        agreeing,
        disagreeing,
        choice("base-plain", "gone", "A", "A"),
      ];
    }),
  );
  assert.equal(untrusted.calibration.rate, 0.5);
  assert.deepEqual(untrusted.warnings, [
    "calibration pair base-plain, gone: no scorecard of gone",
    "the judge agrees with the person on 2 of 4 choices (50%), below 80%: its pairwise verdict isn't to be trusted",
  ]);
  // The calibration pairs are compare's own: judged once, then kept.
  assert.equal(calls().length, 4);
  // The threshold is the definition's.
  const lenient = await review(
    judged("", (d) => {
      d.judgeCalibration = [agreeing, disagreeing];
      d.scoring.minJudgeAgreement = 0.5;
    }),
  );
  assert.deepEqual(lenient.warnings, []);
  // agreementOf compares run ids, whatever order the person saw them in.
  const swapped = {
    ...agreeing,
    runA: "cand-one",
    runB: "base-plain",
    intent: "A",
    quality: "B",
  };
  const judgment = trusted.calibration.entries[0].judgment;
  assert.equal(agreementOf([{ ...swapped, judgment }]).rate, 1);
  assert.deepEqual(winRates([], new Set()), {
    pairs: 0,
    intent: null,
    quality: null,
  });
});

/** bench/report.mjs in the test's bench home. */
function report(...args) {
  const env = { ...process.env, [HOME_ENV]: home };
  return spawnSync(process.execPath, [join(BENCH_DIR, "report.mjs"), ...args], {
    encoding: "utf8",
    env,
  });
}

test("report.mjs compare judges the pairs and reports the win rates; calibrate records a person's choice", () => {
  const definition = judged();
  const compared = report(
    "compare",
    "--benchmark",
    "acme-widgets-42",
    "--candidate",
    CANDIDATE,
  );
  assert.equal(compared.status, 0, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /: accept\n/);
  assert.match(compared.stdout, /## Blind pairwise review/);
  assert.match(
    compared.stdout,
    /4 of 4 pair\(s\) judged \(\d kept from earlier\), by acme-widgets-42 stand-in judge 1\. Intent win rate 75%, quality win rate 25%/,
  );
  assert.match(
    compared.stdout,
    /\| cand-one \| base-plain \| (candidate|baseline) \| candidate \| baseline \|/,
  );
  assert.match(
    compared.stdout,
    /\| cand-two \| base-quoted \| (candidate|baseline) \| tie \| tie \|/,
  );
  assert.match(
    compared.stdout,
    /Calibration: none; the judge is uncalibrated\./,
  );
  assert.match(compared.stdout, /- Warning: the judge is uncalibrated/);

  // A person's choice, recorded into the definition.
  const calibrate = (...args) =>
    report("calibrate", "--benchmark", "acme-widgets-42", ...args);
  const recorded = calibrate(
    "--pair",
    "cand-one",
    "base-plain",
    "--intent",
    "A",
    "--quality",
    "B",
    "--by",
    "a widgets maintainer",
  );
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /intent A, quality B; 1 calibration pair\(s\)/);
  const choices = () =>
    JSON.parse(readFileSync(definition.file, "utf8")).judgeCalibration;
  assert.deepEqual(
    choices().map(({ at, ...rest }) => rest),
    [
      {
        runA: "cand-one",
        runB: "base-plain",
        intent: "A",
        quality: "B",
        by: "a widgets maintainer",
      },
    ],
  );
  // The same pair again, in the other order: it replaces the first choice.
  assert.equal(
    calibrate(
      "--pair",
      "base-plain",
      "cand-one",
      "--intent",
      "tie",
      "--quality",
      "A",
      "--by",
      "a widgets maintainer",
    ).status,
    0,
  );
  assert.deepEqual(
    choices().map((entry) => [entry.runA, entry.intent]),
    [["base-plain", "tie"]],
  );
  // Refused: a choice that isn't A, B or tie; a run with no card; one run.
  const refused = [
    [
      "--pair",
      "cand-one",
      "base-plain",
      "--intent",
      "C",
      "--quality",
      "A",
      "--by",
      "x",
    ],
    [
      "--pair",
      "cand-one",
      "nobody",
      "--intent",
      "A",
      "--quality",
      "A",
      "--by",
      "x",
    ],
    ["--pair", "cand-one", "--intent", "A", "--quality", "A", "--by", "x"],
    ["--pair", "cand-one", "base-plain", "--intent", "A", "--quality", "A"],
  ].map((args) => calibrate(...args));
  assert.deepEqual(
    refused.map((run) => run.status),
    [64, 64, 64, 64],
  );
  assert.match(refused[0].stderr, /--intent is one of A, B, tie/);
  assert.match(refused[1].stderr, /has no scorecard of nobody/);
  assert.match(refused[2].stderr, /calibrate takes --pair RUN_A RUN_B/);
  assert.match(refused[3].stderr, /--by names the person who chose/);

  // compare now reports the agreement: the person called intent a tie
  // where the judge chose the candidate, and quality as the judge did.
  const again = report(
    "compare",
    "--benchmark",
    "acme-widgets-42",
    "--candidate",
    CANDIDATE,
  );
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /4 of 4 pair\(s\) judged \(4 kept from earlier\)/);
  assert.match(
    again.stdout,
    /Calibration: the judge chose as the person did on 1 of 2 choices \(50%; intent 0%, quality 100%\), against 80% needed\./,
  );
  assert.match(
    again.stdout,
    /- Warning: the judge agrees with the person on 1 of 2 choices \(50%\), below 80%/,
  );
});
