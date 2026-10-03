import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { git } from "./support/integration-fixture.mjs";

const root = resolve(import.meta.dirname, "..");

test("planning eval plans each case through the plan path and reports usage, review and errors", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-"));
  try {
    const target = join(work, "target");
    cpSync(join(root, "test/fixtures/autonomous-target"), target, {
      recursive: true,
    });
    git(target, "init", "-q", "-b", "main");
    git(target, "add", "-A");
    git(
      target,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-qm",
      "Public fixture target",
    );
    const head = git(target, "rev-parse", "HEAD");
    const cases = join(work, "cases");
    cpSync(join(root, "test/fixtures/eval"), cases, { recursive: true });
    mkdirSync(join(cases, "missing-source"));
    cpSync(
      join(cases, "summary-alpha", "objective.md"),
      join(cases, "missing-source", "objective.md"),
    );
    writeFileSync(
      join(cases, "missing-source", "case.json"),
      JSON.stringify({ commit: head, sources: ["docs/MISSING.md#Scope"] }),
    );
    const config = join(work, "factory.json");
    writeFileSync(
      config,
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
    const output = join(work, "out");
    const stdout = execFileSync(
      process.execPath,
      [
        join(root, "scripts/eval-planning.mjs"),
        "--cases",
        cases,
        "--target",
        target,
        "--config",
        config,
        "--output",
        output,
        "--repeat",
        "2",
        "--parallel",
        "2",
        "--planning-model",
        join(root, "test/support/eval-planning-model.mjs"),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.match(stdout, /2\/4 runs planned/);

    const report = JSON.parse(
      readFileSync(join(output, "report.json"), "utf8"),
    );
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.repeat, 2);
    assert.equal(report.parallel, 2);
    assert.equal(report.config.planning.reviewer.reasoningEffort, "high");
    assert.deepEqual(
      report.runs.map((run) => [run.case, run.repeat]),
      [
        ["missing-source", 1],
        ["missing-source", 2],
        ["summary-alpha", 1],
        ["summary-alpha", 2],
      ],
    );
    for (const run of report.runs.filter(
      (entry) => entry.case === "summary-alpha",
    )) {
      assert.equal(run.commit, head);
      assert.deepEqual(run.sources, [{ path: "scripts/check.mjs" }]);
      assert.equal(run.planned, true);
      assert.equal(run.error, null);
      assert.equal(run.review, "clean");
      assert.equal(run.findingCount, 0);
      assert.equal(run.revisions, 0);
      assert.equal(run.workItems, 1);
      assert.deepEqual(run.invocations, {
        total: 2,
        completed: 2,
        failed: 0,
        usageUnavailable: 0,
        byPhase: { compile: 1, "graph-review": 1 },
      });
      assert.deepEqual(run.tokens, {
        inputTokens: 20,
        cachedInputTokens: 8,
        cacheWriteInputTokens: 2,
        outputTokens: 4,
        reasoningOutputTokens: 2,
      });
      assert.equal(typeof run.wallMs, "number");
      const plan = JSON.parse(readFileSync(join(output, run.plan), "utf8"));
      assert.equal(plan.baseSha, head);
      assert.equal(plan.graph.items[0].id, "alpha");
      assert.ok(
        plan.sources.some((source) => source.path === "scripts/check.mjs"),
      );
    }
    for (const run of report.runs.filter(
      (entry) => entry.case === "missing-source",
    )) {
      assert.equal(run.planned, false);
      assert.match(run.error, /docs\/MISSING\.md/);
      assert.equal(run.plan, undefined);
      assert.equal(run.invocations.total, 0);
    }
    const alpha = report.cases.find((entry) => entry.case === "summary-alpha");
    assert.deepEqual(
      {
        runs: alpha.runs,
        planned: alpha.planned,
        errors: alpha.errors,
        review: alpha.review,
        workItems: alpha.workItems,
        invocations: alpha.invocations,
      },
      {
        runs: 2,
        planned: 2,
        errors: 0,
        review: { clean: 2, findings: 0, question: 0 },
        workItems: { min: 1, max: 1, mean: 1 },
        invocations: { min: 2, max: 2, mean: 2 },
      },
    );
    assert.equal(
      report.cases.find((entry) => entry.case === "missing-source").errors,
      2,
    );

    const summary = readFileSync(join(output, "summary.md"), "utf8");
    assert.match(summary, /\| summary-alpha \| 2 \| 2 \| 2 \/ 0 \/ 0 \|/);
    assert.match(summary, /## Errors\n\n- missing-source #1: .*MISSING/);
    // Runs work on isolated clones; the target checkout is left untouched.
    assert.equal(git(target, "rev-parse", "HEAD"), head);
    assert.equal(git(target, "remote"), "");
    assert.equal(
      existsSync(join(output, "runs", "summary-alpha-1", "checkout")),
      false,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("planning eval refuses an unpinned case before any run starts", () => {
  const work = mkdtempSync(join(tmpdir(), "factory-planning-eval-invalid-"));
  try {
    const cases = join(work, "cases");
    mkdirSync(join(cases, "bad"), { recursive: true });
    writeFileSync(join(cases, "bad", "case.json"), "{}");
    writeFileSync(join(work, "factory.json"), "{}");
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            join(root, "scripts/eval-planning.mjs"),
            "--cases",
            cases,
            "--target",
            work,
            "--config",
            join(work, "factory.json"),
            "--output",
            join(work, "out"),
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      (error) =>
        error.status === 2 &&
        /bad: case.json requires commit/.test(error.stderr),
    );
    assert.equal(existsSync(join(work, "out")), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
