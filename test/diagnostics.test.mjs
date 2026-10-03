import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import {
  DiagnosticEmitter,
  diagnosticPath,
  readAgentTimeline,
  readDiagnostics,
  readWorkerOutput,
  redactDiagnosticDetail,
  StateDiagnostics,
  summarizeDiagnosticUsage,
  summarizeModelInvocations,
} from "../dist/diagnostics.js";
import { validateTree } from "../dist/validation.js";
import { createTarget } from "./support/integration-fixture.mjs";

test("worker usage separates scopes, deduplicates cumulative counters and reports coverage", () => {
  const worker = (attemptId, type, usage, providerAttempt = 1) => ({
    operation: "worker-usage",
    at: "2026-01-01T00:00:00Z",
    attemptId,
    runId: "run",
    workItemId: "item",
    workerUsage: {
      invocationId: attemptId,
      providerAttempt,
      type,
      role: "worker",
      phase: "implementation",
      provider: "not-codex",
      usage,
    },
  });
  const model = {
    operation: "model-invocation",
    at: "2026-01-01T00:00:00Z",
    metadata: {
      invocationId: "model",
      scopeId: "plan",
      phase: "compile",
      observationType: "completed",
      usageAvailable: true,
      inputTokens: 89961,
      cachedInputTokens: 13696,
      outputTokens: 5160,
    },
  };
  const first = {
    inputTokens: 300000,
    cachedInputTokens: 280000,
    outputTokens: 3000,
  };
  const second = {
    inputTokens: 384069,
    cachedInputTokens: 337728,
    outputTokens: 4280,
  };
  const events = [
    model,
    worker("a", "progress", { inputTokens: 50 }),
    worker("a", "progress", first),
    worker("a", "completed", first),
    worker("a", "completed", first),
    worker("b", "failed", second),
  ];
  const summary = summarizeDiagnosticUsage(events);
  assert.equal(summary.scope, "planning-and-review-model-invocations");
  assert.deepEqual(summary.objective.tokenTotals, {
    inputTokens: 89961,
    cachedInputTokens: 13696,
    outputTokens: 5160,
  });
  assert.deepEqual(summary.workerUsage.tokenTotals, {
    inputTokens: 684069,
    cachedInputTokens: 617728,
    outputTokens: 7280,
  });
  assert.deepEqual(summary.combinedUsage.tokenTotals, {
    inputTokens: 774030,
    cachedInputTokens: 631424,
    outputTokens: 12440,
  });
  assert.equal(summary.workerUsage.invocationCount, 2);
  assert.equal(summary.workerUsage.failedCount, 1);
  assert.equal(
    summary.workerUsage.coverage.byCategory.inputTokens,
    "available",
  );
  assert.equal(
    summary.workerUsage.coverage.byCategory.totalTokens,
    "unavailable",
  );
  assert.equal(
    summary.combinedUsage.cacheReadRatio.denominatorInputTokens,
    774030,
  );
  assert.deepEqual(summarizeDiagnosticUsage([...events, ...events]), summary);
  const partial = summarizeDiagnosticUsage([
    ...events,
    worker("c", "completed", { outputTokens: 0, inputTokens: -1 }),
    worker("d", "failed", undefined),
    worker("e", "completed", {
      inputTokens: 10,
      cachedInputTokens: 20,
      outputTokens: Infinity,
      totalTokens: 1.5,
    }),
    worker("f", "failed", { inputTokens: 20 }, 1),
    worker("f", "completed", { inputTokens: 30, cachedInputTokens: 15 }, 2),
    worker("active", "started", {}),
    {
      operation: "harness",
      attemptId: "no-telemetry",
      outcome: "completed",
      evidence: { usage: { inputTokens: 99999 } },
    },
    { operation: "turn.completed", usage: { input_tokens: 99999 } },
  ]);
  assert.equal(partial.workerUsage.invocationCount, 8);
  assert.equal(partial.workerUsage.activeCount, 1);
  assert.equal(partial.workerUsage.usageUnavailableCount, 1);
  assert.equal(partial.workerUsage.tokenTotals.inputTokens, 684129);
  assert.equal(partial.workerUsage.tokenTotals.outputTokens, 7280);
  assert.equal(partial.workerUsage.coverage.unobservedAttemptCount, 1);
  assert.equal(
    partial.combinedUsage.coverage.byCategory.inputTokens,
    "partial",
  );
  assert.equal(
    partial.workerUsage.cacheReadRatio.denominatorInputTokens,
    684099,
  );
  assert.ok(
    Object.values(partial.workerUsage.byInvocation).every(
      (entry) => entry.runId === "run" && entry.itemId === "item",
    ),
  );
});

test("private diagnostics redact secrets and validation streams command output", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-diagnostics-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const emitter = new DiagnosticEmitter("example/diagnostics", 1, [
      "private-credential",
      "xy",
      "multi\nline",
    ]);
    emitter.emit({
      operation: "test",
      outcome: "failed",
      detail:
        "Authorization: Bearer abc123 private-credential xy multi\nline ghp_abcdefghijklmnopqrstuvwxyz",
    });
    const entries = readDiagnostics("example/diagnostics", 1);
    assert.equal(entries.length, 1);
    assert.doesNotMatch(
      JSON.stringify(entries),
      /private-credential|abc123|xy|multi|line|ghp_abcdefghijklmnopqrstuvwxyz/,
    );
    assert.match(entries[0].detail, /REDACTED/);
    const splitBearer = {
      operation: "split-bearer",
      outcome: "observed",
    };
    emitter.emitStream(splitBearer, "Authorization: Be");
    emitter.emitStream(splitBearer, "arer abc123", true);
    const splitToken = { operation: "split-token", outcome: "observed" };
    emitter.emitStream(splitToken, "ghp_abc");
    emitter.emitStream(splitToken, "defghijklmnop", true);
    assert.doesNotMatch(
      JSON.stringify(readDiagnostics("example/diagnostics", 1)),
      /Bearer abc123|ghp_abcdefghijklmnop/,
    );
    emitter.emit({ operation: "duplicate", outcome: "observed" });
    emitter.emit({ operation: "duplicate", outcome: "observed" });
    const identities = readDiagnostics("example/diagnostics", 1).map(
      (event) => event.eventId,
    );
    assert.equal(new Set(identities).size, identities.length);
    assert.equal(
      statSync(diagnosticPath("example/diagnostics", 1)).mode & 0o777,
      0o600,
    );
    const pendingTree = "a".repeat(40);
    const stateDiagnostics = new StateDiagnostics(
      emitter,
      {
        schemaVersion: 6,
        repository: "example/diagnostics",
        objective: 1,
        runId: "run-review",
        configDigest: "b".repeat(64),
        baseSha: "c".repeat(40),
        graph: { objective: 1, baseSha: "c".repeat(40), items: [] },
        issueByItemId: {},
        work: {},
        finalAcceptancePending: {
          criterion: "criterion",
          treeSha: pendingTree,
          source: "OBJECTIVE",
          quote: "missing quote",
          question: "Inspect the result",
          detail: "Reviewer evidence was rejected",
          reviewFinding: {
            criterion: "criterion",
            verdict: "pass",
            source: "OBJECTIVE",
            quote: "missing quote",
            detail: "Unsupported",
            question: "",
          },
          reviewRejection: {
            field: "quote",
            reason: "quote-not-found",
          },
        },
      },
      "regular",
      1,
    );
    stateDiagnostics.observe();
    const pendingDiagnostic = readDiagnostics("example/diagnostics", 1).find(
      (event) => event.operation === "objective-acceptance-pending",
    );
    assert.deepEqual(JSON.parse(pendingDiagnostic.detail).reviewRejection, {
      field: "quote",
      reason: "quote-not-found",
    });
    assert.equal(
      JSON.parse(pendingDiagnostic.detail).reviewFinding.quote,
      "missing quote",
    );
    const tree = execFileSync(
      "git",
      ["-C", target.checkout, "rev-parse", "HEAD^{tree}"],
      { encoding: "utf8" },
    ).trim();
    const observed = [];
    let firstOutput;
    const firstOutputSeen = new Promise((resolve) => {
      firstOutput = resolve;
    });
    let finished = false;
    const validation = validateTree(
      target.checkout,
      join(root, "validation"),
      target.baseSha,
      tree,
      [
        "printf 'starting'; sleep 0.2; printf 'private-'; sleep 0.1; printf 'credential\\n'",
      ],
      (entry) => observed.push(entry),
      (entry) => {
        emitter.emitStream(
          {
            operation: "validation-output",
            outcome: "observed",
            metadata: { stream: entry.stream, commandIndex: entry.index },
          },
          entry.output,
          entry.final,
        );
        firstOutput();
      },
    );
    void validation.finally(() => {
      finished = true;
    });
    await firstOutputSeen;
    assert.equal(finished, false);
    assert.ok(
      readDiagnostics("example/diagnostics", 1).some(
        (event) =>
          event.operation === "validation-output" &&
          /startin/.test(event.detail),
      ),
    );
    await validation;
    assert.equal(observed.length, 1);
    assert.equal(observed[0].passed, true);
    assert.match(observed[0].output, /startingprivate-credential/);
    const streamed = readDiagnostics("example/diagnostics", 1).filter(
      (event) => event.operation === "validation-output",
    );
    assert.doesNotMatch(
      JSON.stringify(streamed),
      /private-credential|private-|credential/,
    );
    assert.ok(streamed.some((event) => /REDACTED/.test(event.detail)));
    assert.equal(redactDiagnosticDetail("sk-abcdefghijklmnop"), "[REDACTED]");
    const attemptId = "11111111-1111-4111-8111-111111111111";
    emitter.emit({
      runId: "run-1",
      itemId: "one",
      attemptId,
      operation: "harness",
      outcome: "started",
    });
    const harnessRoot = join(stateRoot("example/diagnostics"), "harness");
    mkdirSync(harnessRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(harnessRoot, `${attemptId}.progress.ndjson`),
      `${JSON.stringify({ at: new Date().toISOString(), attemptId, operation: "turn.completed", usage: { input_tokens: 12 } })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(harnessRoot, `${attemptId}.log`), "worker stderr\n", {
      mode: 0o600,
    });
    const timeline = readAgentTimeline("example/diagnostics", 1);
    assert.ok(
      timeline.some(
        (event) =>
          event.workItemId === "one" &&
          event.runId === "run-1" &&
          event.usage?.input_tokens === 12,
      ),
    );
    assert.equal(
      readWorkerOutput("example/diagnostics", attemptId),
      "worker stderr\n",
    );
    assert.throws(
      () =>
        readWorkerOutput(
          "example/diagnostics",
          "22222222-2222-4222-8222-222222222222",
        ),
      /unavailable/,
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("model diagnostics preserve safe correlation and aggregate only supplied usage", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-diagnostics-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const emitter = new DiagnosticEmitter("example/model-diagnostics", 7, [
      "private-prompt-secret",
    ]);
    const observe = emitter.modelObserver({
      scopeId: "plan-attempt-1",
      runId: "run-1",
    });
    const common = {
      invocationId: "invoke-1",
      phase: "compile",
      ordinal: 0,
      provider: "provider-one",
      model: "model-one",
      reasoningEffort: "high",
      providerThreadId: "thread-one",
    };
    observe({
      ...common,
      type: "started",
      promptBytes: 123,
      promptDigest: "a".repeat(64),
      sourcePacketBytes: 45,
      sourcePacketDigest: "b".repeat(64),
    });
    observe({
      ...common,
      type: "progress",
      providerEvent: "turn.started",
    });
    observe({
      ...common,
      type: "completed",
      durationMs: 9,
      responseBytes: 20,
      responseDigest: "c".repeat(64),
      usageAvailable: true,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 5,
        outputTokens: 12,
        reasoningOutputTokens: 3,
      },
    });
    const failed = emitter.modelObserver({ scopeId: "plan-attempt-1" });
    failed({
      invocationId: "invoke-2",
      phase: "graph-review",
      ordinal: 0,
      type: "failed",
      usageAvailable: false,
      failureClass: "provider-capacity",
      detail: `private-prompt-secret is unavailable ${"x".repeat(4050)}private-prompt-secret${"x".repeat(1000)}`,
    });
    const partial = emitter.modelObserver({ scopeId: "plan-attempt-1" });
    partial({
      invocationId: "invoke-3",
      phase: "graph-review",
      ordinal: 1,
      type: "completed",
      usageAvailable: true,
      usage: { inputTokens: 100 },
    });
    const semantic = emitter.modelObserver({ scopeId: "plan-attempt-1" });
    semantic({
      invocationId: "invoke-4",
      phase: "graph-review",
      ordinal: 2,
      type: "response-invalid",
      usageAvailable: false,
      failureClass: "semantic-validation",
      failureField: "findings[0].quote",
      failureReason: "quote-not-found",
      failureSource: "OBJECTIVE",
      detail: "Graph review rejected findings[0].quote: quote-not-found",
    });
    const retried = emitter.modelObserver({ scopeId: "plan-attempt-1" });
    retried({
      invocationId: "invoke-5",
      phase: "graph-review",
      ordinal: 3,
      providerAttempt: 1,
      providerMaxAttempts: 3,
      type: "started",
    });
    retried({
      invocationId: "invoke-5",
      phase: "graph-review",
      ordinal: 3,
      providerAttempt: 1,
      providerMaxAttempts: 3,
      type: "failed",
      usageAvailable: false,
      failureClass: "provider-capacity",
    });
    retried({
      invocationId: "invoke-5",
      phase: "graph-review",
      ordinal: 3,
      providerAttempt: 1,
      providerMaxAttempts: 3,
      type: "retry-scheduled",
      retryDelayMs: 250,
      failureClass: "provider-capacity",
    });
    retried({
      invocationId: "invoke-5",
      phase: "graph-review",
      ordinal: 3,
      providerAttempt: 2,
      providerMaxAttempts: 3,
      type: "started",
    });
    retried({
      invocationId: "invoke-5",
      phase: "graph-review",
      ordinal: 3,
      providerAttempt: 2,
      providerMaxAttempts: 3,
      type: "completed",
      usageAvailable: true,
      usage: { inputTokens: 50, cachedInputTokens: 25 },
    });
    const allEvents = readDiagnostics("example/model-diagnostics", 7);
    const events = allEvents.filter(
      (event) => event.operation === "model-invocation",
    );
    assert.ok(
      allEvents.some(
        (event) => event.capture?.content.status === "capture-disabled",
      ),
    );
    assert.equal(events.length, 11);
    assert.ok(events.every((event) => event.operation === "model-invocation"));
    assert.equal(events[0].metadata.scopeId, "plan-attempt-1");
    assert.equal(events[2].metadata.inputTokens, 100);
    assert.equal(events[2].metadata.totalTokens, undefined);
    assert.doesNotMatch(JSON.stringify(events), /private-prompt-secret/);
    assert.match(events[3].detail, /REDACTED/);
    assert.equal(events[3].metadata.detailTruncated, true);
    assert.ok(events[3].detail.length <= 4096);
    assert.equal(events[5].metadata.failureField, "findings[0].quote");
    assert.equal(events[5].metadata.failureReason, "quote-not-found");
    assert.equal(events[5].metadata.failureSource, "OBJECTIVE");
    assert.equal(events[8].metadata.observationType, "retry-scheduled");
    assert.equal(events[8].metadata.providerAttempt, 1);
    assert.equal(events[8].metadata.providerMaxAttempts, 3);
    assert.equal(events[8].metadata.retryDelayMs, 250);

    const summary = summarizeModelInvocations(events);
    assert.deepEqual(summary.objective.tokenTotals, {
      inputTokens: 250,
      cachedInputTokens: 65,
      cacheWriteInputTokens: 5,
      outputTokens: 12,
      reasoningOutputTokens: 3,
    });
    assert.equal(summary.objective.invocationCount, 6);
    assert.equal(summary.objective.completedCount, 3);
    assert.equal(summary.objective.failedCount, 3);
    assert.equal(summary.objective.usageAvailableCount, 3);
    assert.equal(summary.objective.usageUnavailableCount, 3);
    assert.deepEqual(summary.objective.cacheReadRatio, {
      numeratorCachedInputTokens: 65,
      denominatorInputTokens: 150,
      value: 65 / 150,
    });
    assert.equal(summary.objective.tokenAvailability.inputTokens, 3);
    assert.equal(summary.objective.tokenAvailability.cachedInputTokens, 2);
    assert.equal(summary.byPhase.compile.invocationCount, 1);
    assert.equal(summary.byPhase["graph-review"].failedCount, 3);
    assert.equal(summary.byScope["plan-attempt-1"].invocationCount, 6);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
