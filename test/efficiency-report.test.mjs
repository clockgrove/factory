import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import { diagnosticPath } from "../dist/diagnostics.js";
import { renderEfficiency, summarizeEfficiency } from "../dist/efficiency.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

const origin = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds) => new Date(origin + seconds * 1000).toISOString();
const privateFile = (path, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    {
      mode: 0o600,
    },
  );
  chmodSync(path, 0o600);
};

test("diagnostics --summary --json reports stage time as a union, operator waits, attempts and tokens per role", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-efficiency-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const target = createTarget(root);
  const config = factoryConfig(target.checkout, "example/efficiency");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));

  let sequence = 0;
  const event = (seconds, operation, outcome, extra = {}) => ({
    eventId: `event-${sequence++}`,
    at: at(seconds),
    repository: config.repository,
    objective: 1,
    operation,
    outcome,
    ...extra,
  });
  // Attempt ids are UUIDs: the worker progress files are named by them.
  const attemptA = "aaaaaaaa-0000-4000-8000-000000000001";
  const attemptB = "bbbbbbbb-0000-4000-8000-000000000002";
  const attemptB0 = "bbbbbbbb-0000-4000-8000-000000000000";
  const item = (id, attemptId) => ({ itemId: id, attemptId });
  const A = item("a", attemptA);
  const B = item("b", attemptB);
  const invocation = (seconds, id, phase, observationType, usage) =>
    event(seconds, "model-invocation", observationType, {
      metadata: {
        scopeId: "scope",
        invocationId: id,
        phase,
        providerAttempt: 1,
        observationType,
        model: "plan-model",
        reasoningEffort: "high",
        usageAvailable: usage !== undefined,
        ...usage,
      },
    });
  privateFile(diagnosticPath(config.repository, 1), [
    event(0, "objective-run", "started"),
    // A failed planning run, then 30 s waiting for the operator to retry.
    event(1, "planning", "started"),
    event(11, "planning", "failed"),
    event(11, "objective-run", "waiting"),
    event(41, "step-retry", "completed"),
    event(42, "planning", "started"),
    invocation(43, "compile", "compile", "completed", {
      inputTokens: 2000,
      cachedInputTokens: 500,
      outputTokens: 200,
      reasoningOutputTokens: 100,
    }),
    invocation(44, "lost", "graph-review", "failed"),
    event(62, "planning", "completed"),
    // Two items in parallel: their stages overlap.
    event(70, "harness", "started", A),
    event(71, "harness", "started", { itemId: "b", attemptId: attemptB0 }),
    event(73, "execute", "failed", { itemId: "b", attemptId: attemptB0 }),
    event(75, "harness", "started", B),
    event(115, "validate", "started", B),
    event(130, "validate", "started", A),
    // A repeated observation of the same phase must not restart or double it.
    event(135, "validate", "observed", A),
    event(145, "acceptance-review", "completed", B),
    event(145, "acceptance-pending", "waiting", B),
    event(160, "acceptance-review", "completed", A),
    event(160, "acceptance-pending", "waiting", A),
    event(175, "acceptance-decision", "completed", B),
    event(175, "deliver", "started", B),
    invocation(180, "review", "result-review", "completed", {
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 100,
      reasoningOutputTokens: 50,
    }),
    event(190, "acceptance-decision", "completed", A),
    event(190, "deliver", "started", A),
    // Whole-item durations on state events are snapshots, never added up.
    event(200, "github-closure", "completed", { ...B, durationMs: 900_000 }),
    event(210, "github-closure", "completed", { ...A, durationMs: 900_000 }),
    event(211, "objective-validation", "started"),
    event(241, "objective-acceptance-review", "completed"),
    event(245, "objective-validation", "completed"),
    event(250, "objective-finalization", "completed"),
  ]);
  for (const [attempt, usage] of [
    [
      attemptA,
      {
        inputTokens: 1000,
        cachedInputTokens: 900,
        outputTokens: 50,
        reasoningOutputTokens: 10,
      },
    ],
    [
      attemptB,
      {
        inputTokens: 500,
        cachedInputTokens: 100,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      },
    ],
  ])
    privateFile(
      join(
        stateRoot(config.repository),
        "harness",
        `${attempt}.progress.ndjson`,
      ),
      [
        {
          eventId: `usage-${attempt}`,
          at: at(120),
          operation: "worker-usage",
          workerUsage: {
            type: "completed",
            invocationId: attempt,
            providerAttempt: 1,
            role: "worker",
            phase: "implementation",
            model: "work-model",
            reasoningEffort: "medium",
            usage,
          },
        },
      ],
    );
  // attempt-b0 never reported usage: it is an attempt that failed without any.
  const run = spawnSync(
    process.execPath,
    [
      new URL("../dist/cli.js", import.meta.url).pathname,
      "diagnostics",
      "--objective",
      "1",
      "--summary",
      "--json",
      "--config",
      configPath,
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(run.status, 0, run.stderr);
  const { efficiency: report, ...usage } = JSON.parse(run.stdout);
  // The earlier summary fields are unchanged.
  assert.equal(usage.objective.invocationCount, 3);
  assert.equal(usage.workerUsage.tokenTotals.inputTokens, 1500);

  assert.equal(report.finished, true);
  assert.equal(report.wallMs, 250_000);
  assert.deepEqual(report.stageMs, {
    plan: 30_000, // 10 s failed run + 20 s
    implement: 60_000, // 70..130, not 100 s of overlapping items
    validate: 45_000, // 115..160, not 75 s
    delivery: 35_000, // 175..210, not 45 s, and not the 1800 s snapshots
    final: 30_000,
    closure: 5_000,
  });
  assert.equal(report.operatorWaitMs, 75_000); // 30 s retry + 145..190 once
  assert.equal(report.humanStops, 3); // the planning retry and the two result decisions
  assert.equal(report.cancelled, false);
  assert.equal(report.unattributedMs, 15_000);
  assert.deepEqual(report.attempts, {
    worker: 3,
    failedWorker: 1,
    retries: 0,
    operatorRetries: 1,
    planningRuns: 2,
    failedPlanningRuns: 1,
    modelCalls: 3,
    failedModelCalls: 1,
  });
  assert.deepEqual(report.tokens.worker, {
    inputTokens: 1500,
    cachedInputTokens: 1000,
    cachedShare: 1000 / 1500,
    outputTokens: 70,
    reasoningOutputTokens: 15,
    models: ["work-model (medium)"],
  });
  assert.deepEqual(report.tokens.plannerAndReviewers, {
    inputTokens: 3000,
    cachedInputTokens: 1000,
    cachedShare: 1000 / 3000,
    outputTokens: 300,
    reasoningOutputTokens: 150,
    models: ["plan-model (high)"],
  });

  // Without --json the command prints the human-readable report, not JSON.
  const text = spawnSync(
    process.execPath,
    [
      new URL("../dist/cli.js", import.meta.url).pathname,
      "diagnostics",
      "--objective",
      "1",
      "--summary",
      "--config",
      configPath,
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(text.status, 0, text.stderr);
  assert.throws(() => JSON.parse(text.stdout));
});

const emptySummary = {
  workerUsage: { tokenTotals: {}, cacheReadRatio: null, byInvocation: {} },
  modelUsage: { tokenTotals: {}, cacheReadRatio: null },
  objective: { invocationCount: 0, failedCount: 0 },
};
const synthetic = (events, now) =>
  summarizeEfficiency(
    events.map(([seconds, operation, outcome, itemId]) => ({
      at: at(seconds),
      operation,
      outcome,
      ...(itemId ? { itemId } : {}),
    })),
    [],
    emptySummary,
    origin + now * 1000,
  );

test("a run that stops for a human counts the gap until the next run or command as operator wait", () => {
  const hour = 3600;
  const report = synthetic(
    [
      [0, "objective-run", "started"],
      // A decision wait: the run exits, the operator re-runs 4 h later.
      [10, "objective-run", "waiting"],
      [10 + 4 * hour, "objective-run", "started"],
      [20 + 4 * hour, "harness", "started", "a"],
      // A Work Item fails and stays failed: the run exits, the operator repairs and re-runs.
      [60 + 4 * hour, "execute", "failed", "a"],
      [60 + 9 * hour, "objective-run", "started"],
      [70 + 9 * hour, "harness", "started", "a"],
      // A failure the next attempt follows in the same run is not a human stop.
      [100 + 9 * hour, "execute", "failed", "a"],
      [110 + 9 * hour, "harness", "started", "a"],
      [200 + 9 * hour, "objective-finalization", "completed"],
    ],
    0,
  );
  assert.equal(report.humanStops, 2);
  assert.equal(report.operatorWaitMs, (4 + 5) * hour * 1000);
  // Only the seconds between events are left over, not the hours.
  assert.ok(report.unattributedMs < 60_000);
  assert.match(renderEfficiency(report), /Human stops: 2/);
});

test("a cancelled Objective ends at its cancellation instead of growing with the clock", () => {
  const events = [
    [0, "objective-run", "started"],
    [5, "harness", "started", "a"],
    [600, "objective-cancel", "completed"],
  ];
  const soon = synthetic(events, 700);
  const later = synthetic(events, 700 + 10 * 86_400);
  for (const report of [soon, later]) {
    assert.equal(report.cancelled, true);
    assert.equal(report.finished, false);
    assert.equal(report.wallMs, 600_000);
    assert.equal(report.endedAt, at(600));
  }
  assert.match(renderEfficiency(later), /\(cancelled\)/);
  // The same events without the cancellation are still running.
  const running = synthetic(events.slice(0, 2), 700);
  assert.equal(running.cancelled, false);
  assert.equal(running.wallMs, 700_000);
});
