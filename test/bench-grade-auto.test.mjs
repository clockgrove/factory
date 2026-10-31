// The generic auto-grader (bench/grade-auto.mjs, #2273) on a synthetic
// repository (fixtures/bench/auto-repository.mjs: two criteria, a planted
// defect), with a stand-in agent CLI that answers from a script
// (fixtures/bench/agent-cli.mjs): no model is called. How the roles'
// answers combine, how votes decide a criterion, what the verifier drops,
// that a timeout is unknown and never a fail, the grader contract, and
// what the scorecard makes of the findings.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BENCH_DIR, loadDefinition } from "../bench/lib/definition.mjs";
import {
  gradeCard,
  runBase,
  runGrader,
  setGrade,
} from "../bench/lib/grade.mjs";
import {
  autoGrade,
  combineVotes,
  majority,
  SCHEMAS,
  schemaProblems,
} from "../bench/lib/grade-auto.mjs";
import { HOME_ENV } from "../bench/lib/home.mjs";
import { METRICS } from "../bench/lib/metrics.mjs";
import { runMarkdown, runReport } from "../bench/lib/report.mjs";
import { EXAMPLE, FIXTURE_STATE, fixtureCard } from "./bench-fixture.mjs";
import {
  autoRepository,
  CRITERIA,
  OBJECTIVE,
} from "./fixtures/bench/auto-repository.mjs";

const dir = mkdtempSync(join(tmpdir(), "bench-grade-auto-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const repo = autoRepository(join(dir, "repository"));
const objective = join(dir, "objective.md");
writeFileSync(objective, OBJECTIVE);
// Spawned directly, as the real CLI is: it needs to be executable.
const cli = join(dir, "agent-cli.mjs");
copyFileSync(
  fileURLToPath(new URL("./fixtures/bench/agent-cli.mjs", import.meta.url)),
  cli,
);
chmodSync(cli, 0o755);

const vote = (verdicts, costUsd = 0.5) => ({
  costUsd,
  answer: {
    criteria: CRITERIA.map((c, i) => ({
      ...c,
      verdict: verdicts[i],
      method: "read the source and ran it",
      evidence: `src/tags.mjs:${i + 2}`,
    })),
    checks: [{ command: "npm test", passed: true, summary: "1 test passed" }],
  },
});
const reported = (title, severity, extra = {}) => ({
  title,
  severity,
  evidence: "src/tags.mjs:3",
  reproduce:
    "node -e \"import('./src/tags.mjs').then(m => console.log(m.parseTags('a,A')))\"",
  ...extra,
});

/**
 * Every role answers. The grader's votes: the first criterion pass, pass,
 * partial (passes); the second partial, fail, pass (fails: a partial is
 * not a pass). Quality reports a test gap and a nit; the adversary the
 * planted defect, a break it got wrong and a weakness. The verifier
 * confirms the defect and the test gap, rejects the wrong break and never
 * answers the weakness.
 */
const SCRIPT = {
  "grader-1": vote(["pass", "partial"]),
  "grader-2": vote(["pass", "fail"]),
  "grader-3": vote(["partial", "pass"]),
  quality: {
    costUsd: 0.25,
    answer: {
      findings: [
        reported("No test gives a tag twice", "quality", { category: "tests" }),
        reported("A trailing blank line", "minor", { category: "style" }),
      ],
      mutation: {
        killed: 3,
        survived: 2,
        examples: [
          { location: "src/tags.mjs:3", mutant: "drop toLowerCase()" },
          { location: "src/tags.mjs:3", mutant: "drop new Set" },
        ],
      },
    },
  },
  adversary: {
    costUsd: 0.25,
    answer: {
      probes: 12,
      findings: [
        reported("A tag given twice in two cases appears twice", "defect", {
          guarantee: "A tag given twice appears once.",
        }),
        reported("Empty text throws", "defect", {
          guarantee: "parseTags splits its text on commas",
        }),
        reported("A tag of spaces is kept", "quality", {
          guarantee: "trims each tag",
        }),
      ],
    },
  },
  verifier: {
    costUsd: 0.5,
    answer: {
      verdicts: [
        {
          id: "adversary-1",
          confirmed: true,
          severity: "defect",
          evidence:
            "parseTags('Red,red') gives ['red', 'red']: violates 'A tag given twice appears once.'",
          reproduce: "parseTags('Red,red')",
        },
        {
          id: "adversary-2",
          confirmed: false,
          severity: "minor",
          evidence: "parseTags('') gives [''], it doesn't throw",
        },
        {
          id: "quality-1",
          confirmed: true,
          severity: "quality",
          evidence: "test/tags.test.mjs:6 is the only test",
          reproduce: "",
        },
      ],
    },
  },
};

let runs = 0;
/** autoGrade on the synthetic repository with `script` (changed by `change`), and the stand-in's log. */
async function grade(change, options = {}) {
  runs += 1;
  const script = structuredClone(SCRIPT);
  change?.(script);
  const scriptFile = join(dir, `script-${runs}.json`);
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = join(dir, `log-${runs}.jsonl`);
  writeFileSync(log, "");
  const evidence = join(dir, `evidence-${runs}`);
  const output = await autoGrade({
    repo: repo.dir,
    commit: repo.commit,
    base: repo.base,
    objective: OBJECTIVE,
    evidence,
    cli,
    model: "stand-in-model",
    checks: ["npm test"],
    env: {
      ...process.env,
      STAND_IN_AGENT_SCRIPT: scriptFile,
      STAND_IN_AGENT_LOG: log,
      STAND_IN_AGENT_ORIGINAL: repo.dir,
    },
    ...options,
  });
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { output, calls, evidence };
}

/** The findings the verifier was given, from its prompt. */
const sentTo = (calls) => {
  const prompt = calls.find((c) => c.key === "verifier")?.prompt;
  if (!prompt) return null;
  return JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1]).map(
    (f) => f.id,
  );
};

test("the roles' answers combine into the grader contract, with findings, mutation and cost", async () => {
  const { output, calls, evidence } = await grade();
  assert.match(
    output.graderVersion,
    /^grade-auto 1 \(prompts [0-9a-f]{12}; agent-cli\.mjs stand-in-model high; 3 votes\)$/,
  );
  assert.equal(output.commit, repo.commit);
  assert.equal(output.base, repo.base);
  assert.deepEqual(
    output.criteria.map((c) => [c.id, c.verdict, c.evidence.votes]),
    [
      ["split-trim-lowercase", "pass", ["pass", "pass", "partial"]],
      ["once-each", "fail", ["partial", "fail", "pass"]],
    ],
  );
  // Only the verifier's confirmations, with its own severity and evidence.
  assert.deepEqual(
    output.findings.map((f) => [f.id, f.severity, f.reported]),
    [
      ["adversary-1", "defect", "defect"],
      ["quality-1", "quality", "quality"],
    ],
  );
  assert.match(output.findings[0].evidence, /violates 'A tag given twice/);
  // Its reproduction, or the reporter's when it gave none.
  assert.equal(output.findings[0].reproduce, "parseTags('Red,red')");
  assert.match(output.findings[1].reproduce, /^node -e/);
  // The nit isn't verified; claimed defects go first.
  assert.deepEqual(sentTo(calls), [
    "adversary-1",
    "adversary-2",
    "quality-1",
    "adversary-3",
  ]);
  assert.deepEqual(output.verification, {
    reported: 5,
    minor: 1,
    sent: 4,
    overCap: 0,
    confirmed: 2,
    rejected: 2,
    probes: 12,
  });
  assert.deepEqual(output.mutation, SCRIPT.quality.answer.mutation);
  assert.deepEqual(output.metrics, { mutationScore: 3 / 5 });
  assert.deepEqual(output.checks, SCRIPT["grader-1"].answer.checks);
  assert.deepEqual(output.cost, {
    usd: 2.5,
    byRole: {
      "grader-1": 0.5,
      "grader-2": 0.5,
      "grader-3": 0.5,
      quality: 0.25,
      adversary: 0.25,
      verifier: 0.5,
    },
  });
  assert.ok(output.durationMs >= 0);
  assert.deepEqual(
    output.roles.map((r) => [r.role, r.status]),
    [
      ["adversary", "done"],
      ["grader-1", "done"],
      ["grader-2", "done"],
      ["grader-3", "done"],
      ["quality", "done"],
      ["verifier", "done"],
    ],
  );
  assert.equal(output.error, undefined);
  assert.deepEqual(output.warnings, []);

  // Each role: the CLI's flags, its own scratch checkout, its transcript kept.
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf("--model") + 1], "stand-in-model");
    assert.equal(
      call.args[call.args.indexOf("--output-format") + 1],
      "stream-json",
    );
    assert.ok(call.args.includes("-p"), call.key);
    assert.match(call.prompt, /^- `npm test`$/m);
    assert.match(call.prompt, /<objective>\n# Parse tags/);
    assert.match(call.prompt, /src\/tags\.mjs/);
    for (const file of ["prompt.md", "transcript.jsonl"])
      assert.ok(
        existsSync(join(evidence, call.key, file)),
        `${call.key} ${file}`,
      );
    assert.match(
      readFileSync(join(evidence, call.key, "transcript.jsonl"), "utf8"),
      /"type":"result"/,
    );
  }
  assert.equal(new Set(calls.map((c) => c.cwd)).size, 6);
  const { args } = calls.find((c) => c.key === "verifier");
  assert.deepEqual(
    JSON.parse(args[args.indexOf("--json-schema") + 1]),
    SCHEMAS.verifier,
  );
  // The first vote splits the criteria; the others grade its list.
  const graderPrompt = (n) => calls.find((c) => c.key === `grader-${n}`).prompt;
  assert.doesNotMatch(graderPrompt(1), /Grade exactly these criteria/);
  for (const n of [2, 3])
    assert.match(
      graderPrompt(n),
      /Grade exactly these criteria[\s\S]*"once-each"/,
    );
  // The original tree is only read: the stand-in's probe files stayed in
  // the scratch checkouts, which are gone.
  assert.equal(
    execFileSync("git", ["-C", repo.dir, "status", "--porcelain"], {
      encoding: "utf8",
    }),
    "",
  );
  for (const call of calls) assert.ok(!existsSync(call.cwd), call.cwd);
});

test("votes decide a criterion by a strict majority; a partial is not a pass", () => {
  assert.equal(majority(["pass", "pass", "unknown"]), "pass");
  assert.equal(majority(["pass", "partial", "partial"]), "fail");
  assert.equal(majority(["pass", "fail", "partial"]), "fail");
  assert.equal(majority(["pass", "fail", "unknown"]), "unknown");
  assert.equal(majority(["pass", "partial", "unknown"]), "unknown");
  assert.equal(majority(["unknown", "unknown", "unknown"]), "unknown");
  assert.equal(majority(["partial"]), "fail");
  // A vote that gave none, or left a criterion out, is unknown on it.
  const [split, left] = combineVotes(CRITERIA, [
    vote(["pass", "fail"]).answer,
    null,
    { criteria: [{ ...CRITERIA[0], verdict: "pass", evidence: "x" }] },
  ]);
  assert.deepEqual(
    [split.verdict, split.evidence.votes, left.verdict, left.evidence.votes],
    [
      "pass",
      ["pass", "unknown", "pass"],
      "unknown",
      ["fail", "unknown", "unknown"],
    ],
  );
  // An answer out of its schema is named, and its role is invalid.
  assert.deepEqual(
    schemaProblems(SCHEMAS.verifier, {
      verdicts: [{ id: "a", confirmed: "yes", severity: "major" }],
    }),
    [
      "answer.verdicts[0].evidence is missing",
      "answer.verdicts[0].confirmed must be true or false",
      "answer.verdicts[0].severity must be one of defect, quality, minor",
    ],
  );
});

test("the verifier sees at most --max-findings, and what it doesn't confirm is dropped", async () => {
  const { output, calls } = await grade(null, { maxFindings: 1 });
  // The verifier confirms quality-1 too, but it was over the cap.
  assert.deepEqual(sentTo(calls), ["adversary-1"]);
  assert.deepEqual(
    output.findings.map((f) => f.id),
    ["adversary-1"],
  );
  assert.equal(output.verification.overCap, 3);
  // A verifier answer out of its schema confirms nothing, and denies
  // nothing either: the findings are unknown.
  const invalid = await grade((script) => {
    script.verifier.answer.verdicts[0].confirmed = "yes";
  });
  assert.equal(
    invalid.output.roles.find((r) => r.role === "verifier").status,
    "invalid",
  );
  assert.equal(invalid.output.findings, undefined);
  assert.equal(invalid.output.verification.confirmed, null);
  assert.match(
    invalid.output.warnings.join("\n"),
    /^the findings are unknown, so none is counted: verifier invalid$/m,
  );
  // One reviewer failing leaves them unknown too: only half the review ran.
  const half = await grade((script) => {
    script.adversary.exit = 1;
  });
  assert.equal(half.output.findings, undefined);
  assert.match(half.output.warnings.join("\n"), /: adversary error$/m);
  // The verifier's confirmations are still counted, and the mutants.
  assert.equal(half.output.verification.confirmed, 1);
  assert.equal(half.output.mutation.survived, 2);
  // Nothing non-minor reported: no verifier.
  const quiet = await grade((script) => {
    script.quality.answer.findings = [script.quality.answer.findings[1]];
    script.adversary.answer.findings = [];
  });
  assert.equal(sentTo(quiet.calls), null);
  assert.deepEqual(quiet.output.findings, []);
});

test("a role that times out is unknown, never a fail", async () => {
  const { output } = await grade(
    (script) => {
      script["grader-1"] = vote(["pass", "fail"]);
      script["grader-2"].sleepMs = 60_000;
      script["grader-3"] = vote(["pass", "pass"]);
      script.verifier.sleepMs = 60_000;
    },
    { roleTimeoutMinutes: 0.05 },
  );
  const status = (role) => output.roles.find((r) => r.role === role).status;
  assert.equal(status("grader-2"), "timeout");
  assert.equal(status("verifier"), "timeout");
  // pass, (timed out), pass: pass. fail, (timed out), pass: unknown.
  assert.deepEqual(
    output.criteria.map((c) => c.verdict),
    ["pass", "unknown"],
  );
  // A verifier that timed out leaves the findings unknown: no defect is
  // counted, as 0 or otherwise.
  assert.equal(output.findings, undefined);
  assert.match(output.warnings.join("\n"), /: verifier timeout$/m);
  const card = await fixtureCard();
  setGrade(card, { ...output, passed: 1, failed: 0, unknown: 1 });
  assert.equal(card.totals.final.reviewPassed, true);
  assert.equal(card.escapes.graderDefects, null);
  assert.equal(METRICS["quality.verifiedFindings"].get(card), null);
  // A timed-out role's cost is unknown, so the total is.
  assert.equal(output.cost.usd, null);

  // No vote answers: nothing to grade, an error, never a fail.
  const none = await grade(
    (script) => {
      for (const n of [1, 2, 3]) script[`grader-${n}`].sleepMs = 60_000;
      script.quality.sleepMs = 60_000;
      script.adversary.sleepMs = 60_000;
    },
    { roleTimeoutMinutes: 0.05 },
  );
  assert.deepEqual(none.output.criteria, []);
  assert.match(
    none.output.error,
    /^no grader vote split the acceptance into criteria: grader-1 timeout/,
  );
  // No reviewer answered: no findings at all, not none found.
  assert.equal(none.output.findings, undefined);
  assert.equal(none.output.mutation, null);
});

/** The example definition with `grader`, as a file. */
function definitionWith(name, command, timeoutMinutes = 1) {
  const value = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  value.grader = { command, timeoutMinutes };
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(value));
  return loadDefinition(file);
}

/** The environment that points the stand-in at SCRIPT (changed by `change`), logging to `log`. */
function scripted(name, change) {
  const script = structuredClone(SCRIPT);
  change?.(script);
  const scriptFile = join(dir, `${name}-script.json`);
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = join(dir, `${name}-log.jsonl`);
  writeFileSync(log, "");
  return { STAND_IN_AGENT_SCRIPT: scriptFile, STAND_IN_AGENT_LOG: log };
}

/** What the stand-in logged in `env`'s log: one call per role. */
const logged = (env) =>
  readFileSync(env.STAND_IN_AGENT_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** `work()` with `env` in process.env, as runGrader passes it to a grader. */
async function withEnv(env, work) {
  Object.assign(process.env, env);
  try {
    return await work();
  } finally {
    for (const name of Object.keys(env)) delete process.env[name];
  }
}

/** The command that runs bench/grade-auto.mjs on the stand-in, with `flags`. */
const autoCommand = (...flags) =>
  [
    "node",
    JSON.stringify(join(BENCH_DIR, "grade-auto.mjs")),
    "--cli",
    JSON.stringify(cli),
    "--model",
    "stand-in-model",
    ...flags,
  ].join(" ");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("stopped by the grader contract's timeout, it kills every role it started and removes their checkouts", async () => {
  const pids = join(dir, "stopped-pids.txt");
  writeFileSync(pids, "");
  const env = {
    ...scripted("stopped", (script) => {
      for (const role of ["grader-1", "quality", "adversary"])
        script[role].sleepMs = 60_000;
    }),
    STAND_IN_AGENT_PIDS: pids,
  };
  const definition = definitionWith(
    "stopped",
    autoCommand(
      "--base",
      repo.base,
      "--evidence",
      JSON.stringify(join(dir, "stopped-evidence")),
    ),
    0.05,
  );
  const grade = await withEnv(env, () =>
    runGrader(definition, { repo: repo.dir, commit: repo.commit, objective }),
  );
  assert.match(grade.error, /^the grader timed out after 0\.05 min/);
  // Each sleeping stand-in and the child it started, in its own process group.
  const started = readFileSync(pids, "utf8").split("\n").filter(Boolean);
  assert.equal(started.length, 6, "three roles, each with its child");
  const until = Date.now() + 5_000;
  while (started.some((pid) => alive(Number(pid))) && Date.now() < until)
    await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(
    started.filter((pid) => alive(Number(pid))),
    [],
    "nothing it started outlived it",
  );
  for (const call of logged(env)) assert.ok(!existsSync(call.cwd), call.cwd);
});

test("a graded card's base is past the definition's base patches, which aren't the run's change", async () => {
  const definition = definitionWith(
    "patched",
    autoCommand(
      "--objective",
      JSON.stringify(objective),
      "--evidence",
      JSON.stringify(join(dir, "patched-evidence")),
    ),
  );
  const plain = await fixtureCard();
  assert.equal(runBase(plain, definition), definition.source.base);
  // The patch provisioning applied is the graded change's base. The
  // definition's source.base is invented: had the grade started there, the
  // auto-grader would have found no such commit.
  const card = await fixtureCard({
    basePatches: [{ ...definition.basePatches[0], applied: repo.base }],
  });
  assert.equal(runBase(card, definition), repo.base);
  const env = scripted("patched");
  await withEnv(env, () =>
    gradeCard(card, definition, { repo: repo.dir, commit: repo.commit }),
  );
  assert.equal(card.grade.error, undefined, card.grade.error);
  assert.equal(card.grade.passRate, 1 / 2);
  for (const call of logged(env))
    assert.match(call.prompt, new RegExp(`^Base commit: ${repo.base}$`, "m"));
});

test("as a definition's grader it keeps the grader contract, and the scorecard counts its defects", async () => {
  const env = scripted("contract");
  Object.assign(process.env, env);
  const evidence = join(dir, "contract-evidence");
  const definition = definitionWith(
    "auto",
    `node ${JSON.stringify(join(BENCH_DIR, "grade-auto.mjs"))} --cli ${JSON.stringify(cli)} --model stand-in-model --base ${repo.base} --evidence ${JSON.stringify(evidence)}`,
  );
  let grade;
  try {
    grade = await runGrader(definition, {
      repo: repo.dir,
      commit: repo.commit,
      objective,
    });
  } finally {
    for (const name of Object.keys(env)) delete process.env[name];
  }
  assert.equal(grade.error, undefined, grade.error);
  assert.deepEqual(
    {
      ...grade,
      criteria: grade.criteria.map((c) => c.verdict),
      findings: grade.findings.map((f) => `${f.id} ${f.severity}`),
    },
    {
      graderVersion: grade.graderVersion,
      commit: repo.commit,
      passed: 1,
      failed: 1,
      unknown: 0,
      passRate: 1 / 2,
      criteria: ["pass", "fail"],
      metrics: { mutationScore: 3 / 5 },
      findings: ["adversary-1 defect", "quality-1 quality"],
      mutation: SCRIPT.quality.answer.mutation,
      cost: { usd: 2.5, byRole: grade.cost.byRole },
      durationMs: grade.durationMs,
    },
  );
  assert.match(grade.graderVersion, /^grade-auto 1 /);
  // BENCH_OBJECTIVE was the Objective, and the definition's required
  // commands were the declared checks.
  const calls = readFileSync(env.STAND_IN_AGENT_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.match(call.prompt, /<objective>\n# Parse tags/);
    assert.match(call.prompt, /^- `npm test`\n- `npm run lint`$/m);
  }
  assert.ok(existsSync(join(evidence, "verifier", "transcript.jsonl")));

  // Final review passed the result: the verified defect escaped it, as did
  // the criterion the grader failed.
  const card = await fixtureCard();
  setGrade(card, grade);
  assert.equal(card.totals.final.reviewPassed, true);
  assert.deepEqual(card.escapes, {
    total: 1 + 0 + 1 + 1,
    finalReviewRefusals: 1,
    handFixesAfterFinalReview: 0,
    graderFailedPassed: 1,
    graderDefects: 1,
  });
  assert.equal(METRICS["quality.verifiedFindings"].get(card), 2);
  assert.equal(METRICS["quality.mutantsSurvived"].get(card), 2);
  const html = runReport(card, [card], definition);
  assert.match(html, /<h3>Verified findings<\/h3>/);
  assert.match(html, /A tag given twice in two cases appears twice/);
  assert.match(html, /2 of 5 mutants of the changed lines survived/);
  const markdown = runMarkdown(card, [card], definition);
  assert.match(
    markdown,
    /\| Grade \| 50% \| .*; 2 verified finding\(s\), 1 defect\(s\), 2 of 5 mutant\(s\) survived \|/,
  );
  assert.match(
    markdown,
    /, 1 verified defect\(s\) in the result final review passed \|/,
  );
  assert.match(
    markdown,
    /^- \*\*defect\*\* adversary-1: A tag given twice in two cases appears twice$/m,
  );
  // Final review never passed it: nothing escaped final review.
  card.totals.final.reviewPassed = false;
  setGrade(card, grade);
  assert.equal(card.escapes.graderDefects, 0);
  assert.equal(card.escapes.total, 1);
  // A grader that reports no findings looked for none: null, not 0.
  const { findings, mutation, ...plain } = grade;
  card.totals.final.reviewPassed = true;
  setGrade(card, plain);
  assert.equal(card.escapes.graderDefects, null);
  assert.equal(METRICS["quality.verifiedFindings"].get(card), null);
});

/** bench/grade-auto.mjs or bench/score.mjs with `args`, never reading the environment's bench home. */
function benchCli(script, args, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env[HOME_ENV];
  for (const name of [
    "BENCH_TREE",
    "BENCH_COMMIT",
    "BENCH_OUT",
    "BENCH_DEFINITION",
    "BENCH_OBJECTIVE",
    "BENCH_BASE",
  ])
    delete env[name];
  return spawnSync(process.execPath, [join(BENCH_DIR, script), ...args], {
    encoding: "utf8",
    env,
  });
}

test("standalone, it grades any Objective, and score.mjs --grade-file attaches its grade to a backfill", () => {
  const out = join(dir, "standalone.json");
  const flags = [
    "--repo",
    repo.dir,
    "--commit",
    repo.commit,
    "--base",
    repo.base,
    "--cli",
    cli,
    "--model",
    "stand-in-model",
  ];
  const missing = benchCli("grade-auto.mjs", [...flags, "--out", out]);
  assert.equal(missing.status, 64, missing.stderr);
  assert.match(missing.stderr, /Give --objective/);
  const run = benchCli(
    "grade-auto.mjs",
    [...flags, "--objective", objective, "--out", out],
    scripted("standalone"),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /1 of 2 criteria passed; 2 verified finding\(s\), 1 defect\(s\)\n$/,
  );
  // The evidence sits beside the output.
  assert.ok(
    existsSync(join(dir, "standalone.evidence", "grader-1", "prompt.md")),
  );

  const card = join(dir, "backfill.json");
  const backfill = [
    "--benchmark",
    EXAMPLE,
    "--state-dir",
    FIXTURE_STATE,
    "--issue",
    "42",
    "--run-id",
    "auto",
    "--label",
    "auto-graded backfill",
    "--out",
    card,
  ];
  const scored = benchCli("score.mjs", [...backfill, "--grade-file", out]);
  assert.equal(scored.status, 0, scored.stderr);
  assert.match(scored.stdout, /; grade 1 of 2 criteria passed\n$/);
  const graded = JSON.parse(readFileSync(card, "utf8"));
  assert.equal(graded.grade.commit, repo.commit);
  assert.equal(graded.grade.passRate, 1 / 2);
  assert.equal(graded.grade.findings.length, 2);
  assert.equal(graded.escapes.graderDefects, 1);
  assert.ok(!graded.unavailable.some((gap) => gap.metric === "grade"));
  // Its commit is the file's: another --grade-commit is refused.
  const other = benchCli("score.mjs", [
    ...backfill,
    "--grade-file",
    out,
    "--grade-commit",
    repo.base,
  ]);
  assert.equal(other.status, 64, other.stderr);
  assert.match(
    other.stderr,
    /--grade-file: .* grades [0-9a-f]+, not [0-9a-f]+/,
  );
  // A card that knows its end commit takes a grade of another only when
  // --grade-commit names it.
  writeFileSync(
    card,
    JSON.stringify({ ...graded, endCommit: repo.base, grade: null }),
  );
  const again = [...backfill, "--grade-only", "--grade-file", out];
  const stale = benchCli("score.mjs", again);
  assert.equal(stale.status, 64, stale.stderr);
  assert.match(
    stale.stderr,
    new RegExp(
      `grades ${repo.commit}, not the Objective's end commit ${repo.base}: give --grade-commit ${repo.commit}`,
    ),
  );
  assert.equal(JSON.parse(readFileSync(card, "utf8")).grade, null);
  const named = benchCli("score.mjs", [
    ...again,
    "--grade-commit",
    repo.commit,
  ]);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(
    JSON.parse(readFileSync(card, "utf8")).grade.commit,
    repo.commit,
  );
});
