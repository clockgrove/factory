import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { materializeFixture } from "../scripts/eval-planning/cases.mjs";
import { CODEX_JUDGE_CONFIG } from "../scripts/eval-planning/judge.mjs";
import { sandboxBinary } from "../scripts/eval-planning/sandbox.mjs";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/eval-planning.mjs");
const support = (name) => join(root, "test/support", name);
// Tests that run the Codex judge need bubblewrap with unprivileged user
// namespaces. Hosts without it (macOS, Windows, containers) skip them with
// this reason. CI sets FACTORY_REQUIRE_SANDBOX=1 (#705), so there they never
// skip: a missing sandbox fails the "judge sandbox is required" test below.
const sandboxRequired = process.env.FACTORY_REQUIRE_SANDBOX === "1";
const sandboxSkip =
  sandboxBinary() || sandboxRequired
    ? false
    : "judge sandbox unavailable: bubblewrap with unprivileged user namespaces is not usable on this host";

test("judge sandbox is usable where it is required", {
  skip: sandboxRequired ? false : "FACTORY_REQUIRE_SANDBOX is not set",
}, () => {
  assert.ok(
    sandboxBinary(),
    "FACTORY_REQUIRE_SANDBOX=1 but bubblewrap with unprivileged user namespaces is not usable",
  );
});

function writeConfig(work) {
  const path = join(work, "factory.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      repository: "example/planning-eval",
      checkout: "/unused-by-planning-evals",
      planning: {
        kind: "codex-sdk",
        planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        reviewer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
      execution: {
        kind: "local",
        concurrency: 1,
        harness: {
          kind: "codex-sdk",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        },
      },
      delivery: { kind: "regular" },
      contentStore: { kind: "local" },
      policy: {
        network: "off",
        allowedSecretNames: [],
        deployments: "denied",
      },
    }),
  );
  return path;
}

const run = (args) =>
  execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
/** Run the CLI and return its exit status and output without throwing. */
const runStatus = (args, env = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};
const readReport = (output) =>
  JSON.parse(readFileSync(join(output, "report.json"), "utf8"));

test("plan mode plans public cases through planObjective and reports review, judge and metrics", {
  skip: sandboxSkip,
}, () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-"));
  try {
    const config = writeConfig(work);
    const output = join(work, "out");
    const { status, stdout, stderr } = runStatus([
      "--config",
      config,
      "--output",
      output,
      "--case",
      "native-stack-chain",
      "--case",
      "media-lfs-thumbnail",
      "--case",
      "single-item",
      "--repeat",
      "2",
      "--parallel",
      "3",
      "--planning-model",
      support("eval-fixture-planner.mjs"),
      "--judge",
      join(root, "evals/judges/strict-rubric-v1-claude.json"),
      "--judge",
      join(root, "evals/judges/strict-rubric-v1-codex.json"),
      "--judge-transport",
      support("eval-judge-transport.mjs"),
    ]);
    // Two runs errored, so the eval exits 1 after writing its report.
    assert.equal(status, 1);
    assert.match(stdout, /4\/6 clean plans, 2 errors, 0 judge errors/);
    // The stop names each errored run's log and a rerun of just that case.
    assert.match(
      stderr,
      new RegExp(
        `single-item #1: .* \\(log: ${join(output, "runs", "single-item-1", "worker.log").replaceAll(".", "\\.")}\\)`,
      ),
    );
    assert.match(
      stderr,
      /Rerun only the failed ones[^\n]*\n  node [^\n]*--output \S+-rerun --case single-item$/m,
    );
    assert.doesNotMatch(stderr, /--case native-stack-chain \S*-rerun/);
    const report = readReport(output);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.mode, "plan");
    assert.equal(report.path, "planObjective");
    assert.deepEqual(
      report.judges.map((judge) => [judge.name, judge.model.kind]),
      [
        ["strict-rubric-v1-claude", "claude-agent-sdk"],
        ["strict-rubric-v1-codex", "codex-sdk"],
      ],
    );
    for (const judge of report.judges) {
      assert.match(judge.digest, /^[a-f0-9]{64}$/);
      assert.equal(judge.transportModule, support("eval-judge-transport.mjs"));
    }
    assert.deepEqual(
      report.runs.map((entry) => [entry.case, entry.repeat]),
      [
        ["media-lfs-thumbnail", 1],
        ["media-lfs-thumbnail", 2],
        ["native-stack-chain", 1],
        ["native-stack-chain", 2],
        ["single-item", 1],
        ["single-item", 2],
      ],
    );
    for (const entry of report.runs.filter(
      (candidate) => candidate.case === "native-stack-chain",
    )) {
      assert.equal(entry.outcome, "plan");
      assert.equal(entry.planned, true);
      assert.equal(entry.error, null);
      assert.equal(entry.review, "clean");
      // Host-dependent planning inputs are recorded.
      assert.equal(typeof entry.host.capacity.concurrency, "number");
      assert.ok("localExecutables" in entry.host);
      assert.equal(entry.reviewStatus, "clean");
      assert.equal(entry.firstTry, "accepted");
      assert.deepEqual(entry.expectation, { met: true, failed: [] });
      assert.deepEqual(
        entry.judges.map((grade) => [grade.judge, grade.verdict, grade.passed]),
        [
          ["strict-rubric-v1-claude", "pass", 7],
          ["strict-rubric-v1-codex", "pass", 7],
        ],
      );
      assert.equal(entry.metrics.criticalPath, 3);
      assert.deepEqual(entry.metrics.ciCheckNames, {
        total: 1,
        grounded: 1,
        ungrounded: [],
      });
      assert.equal(entry.metrics.finalReviewInsteadOfCommand.count, 0);
      assert.deepEqual(entry.metrics.proofKinds, {
        "result-command": 4,
        "final-controller": 1,
        "result-semantic": 1,
      });
      assert.deepEqual(entry.invocations.byPhase, {
        compile: 1,
        "graph-review": 1,
      });
      const plan = JSON.parse(readFileSync(join(output, entry.plan), "utf8"));
      assert.deepEqual(
        plan.graph.requiredPreIntegrationChecks.map((gate) => gate.checkName),
        ["unit-tests"],
      );
      // Runs use isolated clones; nothing is left behind.
      assert.equal(
        existsSync(
          join(output, "runs", `${entry.case}-${entry.repeat}`, "checkout"),
        ),
        false,
      );
    }
    for (const entry of report.runs.filter(
      (candidate) => candidate.case === "single-item",
    )) {
      assert.equal(entry.outcome, "error");
      assert.equal(entry.planned, false);
      assert.match(entry.error, /No fixture plan for case single-item/);
      assert.equal(entry.judges, undefined);
      assert.equal(entry.expectation, null);
    }
    const { overall } = report.summary;
    // Infrastructure errors are counted, never scored.
    assert.equal(overall.errors, 2);
    assert.deepEqual(
      [overall.productionClean.successes, overall.productionClean.total],
      [4, 4],
    );
    for (const judge of overall.judges)
      assert.deepEqual([judge.pass.successes, judge.pass.total], [4, 4]);
    assert.deepEqual(
      [overall.agreement[0].agree.successes, overall.agreement[0].bothPass],
      [4, 4],
    );
    // Two cases, so the interval is far wider than four independent runs.
    assert.equal(overall.productionClean.clusters, 2);
    assert.ok(overall.productionClean.low < 0.4);
    assert.deepEqual(
      report.units.map((unit) => [
        unit.id,
        unit.runs,
        unit.metrics.productionClean,
      ]),
      [
        ["media-lfs-thumbnail", 2, 1],
        ["native-stack-chain", 2, 1],
        ["single-item", 2, undefined],
      ],
    );
    const summary = readFileSync(join(output, "summary.md"), "utf8");
    assert.match(
      summary,
      /\| Judge pass: strict-rubric-v1-codex \| 100% \[\d+–100\] \(4\/4, 2 units\) \|/,
    );
    assert.match(
      summary,
      /\| Judges agree: strict-rubric-v1-claude vs strict-rubric-v1-codex \| 100%/,
    );
    assert.match(
      summary,
      /\| native-stack-chain \| 2 \| 0 \| 1\.00 \| 1\.00 \/ 1\.00 \| 1\.00 \|/,
    );
    assert.match(
      summary,
      /## Infrastructure errors\n\n- single-item #1: No fixture plan/,
    );

    // Comparing a report with itself shows no difference on any unit.
    const compared = run([
      "--compare",
      join(output, "report.json"),
      join(output, "report.json"),
      "--output",
      join(work, "cmp"),
    ]);
    assert.match(compared, /Paired over 3 shared units, clustered by case/);
    assert.match(
      compared,
      /Errored and excluded from every rate: A 2 runs, 0 judge calls; B 2 runs, 0 judge calls\./,
    );
    const comparison = JSON.parse(
      readFileSync(join(work, "cmp", "compare.json"), "utf8"),
    );
    assert.ok(comparison.rows.length > 5);
    for (const row of comparison.rows) {
      assert.equal(row.delta, 0);
      // Two scored cases are too few to compare.
      assert.equal(row.insufficient, true);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("plan mode runs private cases from a target checkout at a pinned commit", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-private-"));
  try {
    const target = join(work, "target");
    const head = materializeFixture(
      join(root, "evals/targets/node-lib"),
      target,
    );
    const cases = join(work, "private");
    mkdirSync(join(cases, "native-stack-chain"), { recursive: true });
    cpSync(
      join(root, "evals/cases/native-stack-chain/objective.md"),
      join(cases, "native-stack-chain/objective.md"),
    );
    writeFileSync(
      join(cases, "native-stack-chain/case.json"),
      JSON.stringify({ commit: "main", repository: "example/private" }),
    );
    const output = join(work, "out");
    run([
      "--cases",
      cases,
      "--target",
      target,
      "--config",
      writeConfig(work),
      "--output",
      output,
      "--planning-model",
      support("eval-fixture-planner.mjs"),
    ]);
    const [entry] = readReport(output).runs;
    assert.equal(entry.commit, head);
    assert.equal(entry.repository, "example/private");
    assert.equal(entry.review, "clean");
    assert.equal(entry.judges, undefined);
    assert.equal(entry.expectation, null);
    assert.deepEqual(readReport(output).judges, []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("review-only mode reports recall per seeded defect and the false-positive rate", {
  skip: sandboxSkip,
}, () => {
  const work = mkdtempSync(join(tmpdir(), "factory-review-eval-"));
  try {
    const output = join(work, "out");
    const stdout = run([
      "--review-only",
      "--config",
      writeConfig(work),
      "--output",
      output,
      "--repeat",
      "2",
      "--parallel",
      "4",
      "--planning-model",
      support("eval-review-model.mjs"),
      "--judge",
      join(root, "evals/judges/strict-rubric-v1-claude.json"),
      "--judge",
      join(root, "evals/judges/strict-rubric-v1-codex.json"),
      "--judge-transport",
      support("eval-judge-transport.mjs"),
    ]);
    assert.match(stdout, /30 reviews of 3 fixtures/);
    const report = readReport(output);
    assert.equal(report.mode, "review");
    const { summary } = report;
    assert.deepEqual(
      [summary.good.runs, summary.good.falsePositive.successes],
      [6, 0],
    );
    const recall = Object.fromEntries(
      summary.defects.map((row) => [
        row.defect,
        [row.recall.successes, row.recall.total],
      ]),
    );
    // Compile validation refuses invented CI names and final review of the
    // `npm test` criterion, so those variants never reach the reviewer. The media
    // fixture has no command with authority, so that defect does not apply there.
    assert.deepEqual(recall, {
      "acceptance-needs-own-merge": [6, 6],
      "native-dependency-assumed-merged": [2, 2],
      "missing-ownership": [0, 6],
      "missing-dependency": [0, 6],
      "worker-test-only-proof": [4, 4],
    });
    const dependency = summary.defects.find(
      (row) => row.defect === "missing-dependency",
    );
    // The scripted Claude judge fails `dependencies` only when nothing depends
    // on anything: the two-item media fixture loses its only edge. The Codex
    // judge fails every plan with a QA item, good ones included.
    const claude = dependency.judgeRecall["strict-rubric-v1-claude"];
    assert.deepEqual([claude.successes, claude.total], [2, 6]);
    const codexFalse =
      summary.good.judgeFalsePositive["strict-rubric-v1-codex"];
    assert.deepEqual([codexFalse.successes, codexFalse.total], [2, 6]);
    assert.equal(summary.agreement.length, 1);
    assert.deepEqual(
      summary.refusedByCode.map((row) => `${row.fixture}/${row.defect}`).sort(),
      [
        "native-stack-chain/final-review-replaces-command",
        "native-stack-chain/invented-ci-name",
        "required-ci-check-qa/final-review-replaces-command",
        "required-ci-check-qa/invented-ci-name",
      ],
    );
    assert.equal(summary.errors, 0);
    assert.equal(report.units.length, 15);
    const run0 = report.runs.find(
      (entry) => entry.defect === "worker-test-only-proof",
    );
    assert.deepEqual(run0.tokens, { inputTokens: 100, outputTokens: 10 });
    assert.match(run0.rule, /test the same item writes/);
    const markdown = readFileSync(join(output, "summary.md"), "utf8");
    assert.match(
      markdown,
      /\| missing-dependency \| 6 \| 0% \[0–\d+\] \(0\/6, 3 units\) \|/,
    );
    assert.match(
      markdown,
      /false-positive rate 0% \[0–\d+\] \(0\/6, 3 units\)/,
    );
    // A known-good plan has a false-positive metric and no recall metric.
    const good = report.units.find(
      (unit) => unit.id === "media-lfs-thumbnail/good",
    ).metrics;
    assert.deepEqual(
      ["falsePositive" in good, "recall" in good],
      [true, false],
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("invalid cases, judges and comparisons exit 2 before any model call", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-invalid-"));
  try {
    const cases = join(work, "cases");
    mkdirSync(join(cases, "bad"), { recursive: true });
    writeFileSync(join(cases, "bad", "case.json"), "{}");
    const config = writeConfig(work);
    const refused = (args, pattern) =>
      assert.throws(
        () => run(args),
        (error) => error.status === 2 && pattern.test(error.stderr),
      );
    refused(
      [
        "--cases",
        cases,
        "--target",
        work,
        "--config",
        config,
        "--output",
        join(work, "out"),
      ],
      /bad: case.json requires commit \(or fixture\)/,
    );
    assert.equal(existsSync(join(work, "out")), false);
    const judge = join(work, "judge.json");
    writeFileSync(
      judge,
      readFileSync(
        join(root, "evals/judges/strict-rubric-v1-claude.json"),
        "utf8",
      ).replace(
        /"promptSha256": "[a-f0-9]+"/,
        `"promptSha256": "${"0".repeat(64)}"`,
      ),
    );
    writeFileSync(
      join(work, "strict-rubric-v1.md"),
      readFileSync(join(root, "evals/judges/strict-rubric-v1.md")),
    );
    refused(
      ["--config", config, "--output", join(work, "out2"), "--judge", judge],
      /Frozen judges are never edited/,
    );
    refused(
      ["--compare", join(work, "only-one.json")],
      /needs two report.json paths/,
    );
    const broken = join(work, "broken.json");
    writeFileSync(broken, "{ not json");
    refused(
      ["--config", broken, "--output", join(work, "out3")],
      /--config .*broken\.json/,
    );
    refused(
      [
        "--config",
        config,
        "--output",
        join(work, "out3"),
        "--planning-model",
        join(work, "missing.mjs"),
      ],
      /--planning-model .*missing\.mjs is not a file/,
    );
    writeFileSync(join(cases, "bad", "case.json"), "{ not json");
    // An output directory the user created stays; only its contents go.
    mkdirSync(join(work, "mine"));
    refused(
      [
        "--cases",
        cases,
        "--target",
        work,
        "--config",
        config,
        "--output",
        join(work, "mine"),
      ],
      /bad: case.json is not valid JSON/,
    );
    assert.deepEqual(readdirSync(join(work, "mine")), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a run that dies with a truncated result.json is reported as an errored run", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-crash-"));
  try {
    const output = join(work, "out");
    const { status } = runStatus([
      "--config",
      writeConfig(work),
      "--output",
      output,
      "--case",
      "single-item",
      "--planning-model",
      support("eval-crash-planner.mjs"),
    ]);
    assert.equal(status, 1);
    const [entry] = readReport(output).runs;
    assert.equal(entry.outcome, "error");
    assert.equal(entry.planned, false);
    assert.match(entry.error, /Run result is unreadable .*code 3/);
    assert.match(
      readFileSync(join(output, "summary.md"), "utf8"),
      /## Infrastructure errors\n\n- single-item #1: Run result is unreadable/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a private case with a leftover sources key is refused with a clear message", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-sources-"));
  try {
    const target = join(work, "target");
    materializeFixture(join(root, "evals/targets/node-lib"), target);
    mkdirSync(join(work, "cases", "old"), { recursive: true });
    writeFileSync(join(work, "cases", "old", "objective.md"), "# Old\n");
    writeFileSync(
      join(work, "cases", "old", "case.json"),
      JSON.stringify({ commit: "main", sources: ["docs/SPEC.md#Wrap"] }),
    );
    assert.throws(
      () =>
        run([
          "--cases",
          join(work, "cases"),
          "--target",
          target,
          "--config",
          writeConfig(work),
          "--output",
          join(work, "out"),
        ]),
      (error) =>
        error.status === 2 &&
        /old: case.json `sources` is no longer supported; declare sources in the Objective's `## Planning sources` section/.test(
          error.stderr,
        ),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("planning that stops for an operator is a question, not an error", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-question-"));
  try {
    const output = join(work, "out");
    const { status } = runStatus([
      "--config",
      writeConfig(work),
      "--output",
      output,
      "--case",
      "ask-operator-publish",
      "--planning-model",
      support("eval-asking-planner.mjs"),
    ]);
    assert.equal(status, 0);
    const report = readReport(output);
    const [entry] = report.runs;
    assert.equal(entry.outcome, "question");
    assert.equal(entry.error, null);
    assert.match(entry.stop, /^Planning needs an undelegated decision/);
    assert.deepEqual(entry.expectation, { met: true, failed: [] });
    assert.equal(report.summary.overall.errors, 0);
    assert.equal(report.summary.overall.question.successes, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("planning that never validates a correction is a question, not an error", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-stubborn-"));
  try {
    const output = join(work, "out");
    const { status } = runStatus([
      "--config",
      writeConfig(work),
      "--output",
      output,
      "--case",
      "single-item",
      "--planning-model",
      support("eval-stubborn-planner.mjs"),
    ]);
    assert.equal(status, 0);
    const report = readReport(output);
    const [entry] = report.runs;
    assert.equal(entry.outcome, "question");
    assert.equal(entry.error, null);
    assert.equal(entry.planned, false);
    assert.match(entry.stop, /^Unchanged planning failure/);
    // The stop stays in the primary metric's denominator.
    assert.equal(report.summary.overall.errors, 0);
    assert.equal(report.summary.overall.question.successes, 1);
    assert.equal(report.summary.overall.question.total, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// No bwrap on PATH makes the sandbox unavailable on any host; node, git and sh stay.
function pathWithoutBubblewrap(work) {
  const bin = join(work, "bin-without-bwrap");
  mkdirSync(bin);
  const tools = {
    node: process.execPath,
    git: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
    sh: "/bin/sh",
  };
  for (const [name, target] of Object.entries(tools))
    symlinkSync(target, join(bin, name));
  return bin;
}

const judgeFiles = {
  claude: join(root, "evals/judges/strict-rubric-v1-claude.json"),
  codex: join(root, "evals/judges/strict-rubric-v1-codex.json"),
};

for (const kind of ["claude", "codex"])
  test(`a ${kind} judge without the sandbox is refused with exit 2 and no model call`, () => {
    const work = mkdtempSync(
      join(tmpdir(), "factory-planning-eval-nosandbox-"),
    );
    try {
      const output = join(work, "out");
      const { status, stderr } = runStatus(
        [
          "--config",
          writeConfig(work),
          "--output",
          output,
          "--case",
          "single-item",
          "--planning-model",
          support("eval-fixture-planner.mjs"),
          "--judge",
          judgeFiles[kind],
          "--judge-transport",
          support("eval-judge-transport.mjs"),
        ],
        { PATH: pathWithoutBubblewrap(work) },
      );
      assert.equal(status, 2, stderr);
      assert.match(
        stderr,
        new RegExp(`strict-rubric-v1-${kind} needs the Linux judge sandbox`),
      );
      // The refusal names a working command, the Ubuntu 24.04 note and the flag.
      assert.match(stderr, /sudo apt install bubblewrap/);
      assert.match(stderr, /kernel\.apparmor_restrict_unprivileged_userns/);
      assert.match(stderr, /--allow-unsandboxed-judges/);
      assert.match(stderr, /Drop --judge/);
      // The output directory is created only after the checks, so no run began.
      assert.equal(existsSync(output), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

test("--allow-unsandboxed-judges runs judges without the sandbox and records it", () => {
  const work = mkdtempSync(
    join(tmpdir(), "factory-planning-eval-unsandboxed-"),
  );
  try {
    const output = join(work, "out");
    const { status, stdout, stderr } = runStatus(
      [
        "--config",
        writeConfig(work),
        "--output",
        output,
        "--case",
        "native-stack-chain",
        "--planning-model",
        support("eval-fixture-planner.mjs"),
        "--judge",
        judgeFiles.claude,
        "--judge",
        judgeFiles.codex,
        "--judge-transport",
        support("eval-judge-transport.mjs"),
        "--allow-unsandboxed-judges",
      ],
      { PATH: pathWithoutBubblewrap(work) },
    );
    assert.equal(status, 0, stderr);
    assert.match(stdout, /1\/1 clean plans, 0 errors, 0 judge errors/);
    assert.match(
      stderr,
      /WARNING: judges run WITHOUT the sandbox \(--allow-unsandboxed-judges\)/,
    );
    const report = readReport(output);
    assert.equal(report.judgeIsolation, "none (--allow-unsandboxed-judges)");
    assert.deepEqual(
      report.runs[0].judges.map((grade) => [grade.judge, grade.verdict]),
      [
        ["strict-rubric-v1-claude", "pass"],
        ["strict-rubric-v1-codex", "pass"],
      ],
    );
    assert.match(
      readFileSync(join(output, "summary.md"), "utf8"),
      /Judge isolation: none \(--allow-unsandboxed-judges\)\./,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the flag needs a judge, and a missing dist/ says to build", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-flags-"));
  try {
    const { status, stderr } = runStatus([
      "--config",
      writeConfig(work),
      "--output",
      join(work, "out"),
      "--allow-unsandboxed-judges",
    ]);
    assert.equal(status, 2);
    assert.match(stderr, /--allow-unsandboxed-judges needs --judge/);
    // A copy of the script without a dist/ next to it.
    cpSync(join(root, "scripts"), join(work, "checkout", "scripts"), {
      recursive: true,
    });
    const bare = spawnSync(
      process.execPath,
      [join(work, "checkout", "scripts", "eval-planning.mjs"), "--help"],
      { encoding: "utf8" },
    );
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /dist\/ is missing.*run `npm run build`/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/**
 * Write a `--judge-transport` module that records what a judge process can
 * see: a canary file and the eval output (absolute paths outside its
 * scratch), its working directory, HOME, CODEX_HOME and environment.
 */
function writeProbeJudge(work, canary, output) {
  const path = join(work, "probe-judge.mjs");
  writeFileSync(
    path,
    `import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JUDGE_DIMENSIONS } from ${JSON.stringify(pathToFileURL(join(root, "scripts/eval-planning/judge.mjs")).href)};
const attempt = (read) => { try { return read(); } catch (error) { return error.code ?? "error"; } };
export function createJudgeTransport({ judge }) {
  return {
    async run({ turn }) {
      const probe = {
        kind: judge.model.kind,
        canary: attempt(() => readFileSync(${JSON.stringify(canary)}, "utf8")),
        output: attempt(() => readdirSync(${JSON.stringify(output)})),
        cwd: readdirSync(process.cwd()).sort(),
        codexHome: readdirSync(process.env.CODEX_HOME).sort(),
        codexConfig: readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8"),
        xdgState: process.env.XDG_STATE_HOME ?? null,
      };
      turn.ended = true;
      turn.response = JSON.stringify({
        dimensions: JUDGE_DIMENSIONS.map((name) => ({ name, verdict: "pass", evidence: JSON.stringify(probe) })),
      });
    },
  };
}
`,
  );
  return path;
}

test("judges run sandboxed: no file outside their scratch, no operator Codex config", {
  skip: sandboxSkip,
}, () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-isolation-"));
  try {
    const canary = join(work, "canary.txt");
    writeFileSync(canary, "secret");
    const codexHome = join(work, "codex");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}");
    writeFileSync(join(codexHome, "config.toml"), 'model = "operator"\n');
    writeFileSync(join(codexHome, "AGENTS.md"), "operator instructions");
    const expected = (kind) => ({
      kind,
      canary: "ENOENT",
      output: "ENOENT",
      cwd: [".git"],
      codexHome: ["auth.json", "config.toml"],
      codexConfig: CODEX_JUDGE_CONFIG,
      xdgState: null,
    });
    const judges = (output) => [
      "--judge",
      join(root, "evals/judges/strict-rubric-v1-claude.json"),
      "--judge",
      join(root, "evals/judges/strict-rubric-v1-codex.json"),
      "--judge-transport",
      writeProbeJudge(work, canary, output),
    ];
    // Plan mode, two runs in parallel, so a sibling run's files are on disk.
    const output = join(work, "out");
    const plan = runStatus(
      [
        "--config",
        writeConfig(work),
        "--output",
        output,
        "--case",
        "native-stack-chain",
        "--repeat",
        "2",
        "--parallel",
        "2",
        "--planning-model",
        support("eval-fixture-planner.mjs"),
        ...judges(output),
      ],
      { CODEX_HOME: codexHome },
    );
    assert.equal(plan.status, 0, plan.stderr);
    const reviewOutput = join(work, "review");
    const review = runStatus(
      [
        "--review-only",
        "--config",
        writeConfig(work),
        "--output",
        reviewOutput,
        "--case",
        "media-lfs-thumbnail",
        "--parallel",
        "2",
        "--planning-model",
        support("eval-review-model.mjs"),
        ...judges(reviewOutput),
      ],
      { CODEX_HOME: codexHome },
    );
    assert.equal(review.status, 0, review.stderr);
    const grades = [
      ...readReport(output).runs,
      ...readReport(reviewOutput).runs,
    ].flatMap((entry) => entry.judges);
    assert.ok(grades.length >= 8);
    for (const grade of grades) {
      const probe = JSON.parse(grade.dimensions.coverage.evidence);
      assert.deepEqual(probe, expected(probe.kind));
    }
    // The real login file is bound, not copied, and is untouched.
    assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), "{}");
    assert.deepEqual(
      readdirSync(tmpdir()).filter((name) =>
        name.startsWith("factory-plan-judge-"),
      ),
      [],
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
