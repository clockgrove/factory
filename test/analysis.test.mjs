import assert from "node:assert/strict";
import test from "node:test";
import { analyzeInteractions, renderAnalysis } from "../dist/analysis.js";

const at = (seconds) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
function record(invocationId, sequence, seconds, extra = {}) {
  return {
    schemaVersion: 1,
    repository: "example/target",
    objective: 12,
    recordId: `${invocationId}-${sequence}`,
    at: at(seconds),
    sequence,
    invocationId,
    providerAttempt: 1,
    phase: "implementation",
    kind: "interaction",
    runId: "run-one",
    itemId: invocationId,
    attemptId: `attempt-${invocationId}`,
    factoryVersion: "0.1.39",
    adapter: "synthetic",
    configured: {
      provider: "synthetic",
      model: "example-model",
      reasoningEffort: "low",
    },
    coverage: "boundary",
    content: { status: "capture-disabled", redacted: false, truncated: false },
    ...extra,
  };
}
const cumulative = (normalized, terminal = true, extra = {}) => ({
  scope: "invocation-cumulative",
  terminal,
  completeness: "available-categories",
  normalized,
  ...extra,
});

test("concurrent timelines and repeated cumulative/call/model usage do not double count", () => {
  const observations = [
    record("one", 1, 0, { kind: "request", promptDigest: "prompt-a" }),
    record("one", 2, 2, {
      kind: "usage",
      usage: cumulative({ inputTokens: 20, outputTokens: 3 }, false),
    }),
    record("one", 3, 5, {
      kind: "usage",
      usage: { ...cumulative({ inputTokens: 999 }), scope: "provider-call" },
    }),
    record("one", 4, 10, {
      kind: "usage",
      usage: cumulative({
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 10,
      }),
    }),
    record("one", 5, 10, {
      kind: "outcome",
      outcome: { stage: "provider", status: "completed" },
    }),
    record("two", 1, 5, { kind: "request" }),
    record("two", 2, 15, {
      kind: "usage",
      usage: { ...cumulative({ inputTokens: 999 }), scope: "model-breakdown" },
    }),
    record("two", 3, 15, {
      kind: "usage",
      usage: cumulative({ inputTokens: 200, outputTokens: 20 }),
    }),
    record("two", 4, 15, {
      kind: "outcome",
      outcome: { stage: "provider", status: "completed" },
    }),
  ];
  const report = analyzeInteractions([...observations, ...observations]);
  assert.equal(report.invocationCount, 2);
  assert.equal(report.observedWindow.elapsedMs, 15000);
  assert.deepEqual(
    report.invocations.map((entry) => entry.interval.durationMs),
    [10000, 10000],
  );
  assert.deepEqual(report.usage.inputTokens, {
    total: 300,
    contributingInvocations: 2,
    eligibleInvocations: 2,
    coverage: "available",
  });
  assert.equal(report.usage.cachedInputTokens.total, 25);
  assert.equal(report.usage.cachedInputTokens.coverage, "partial");
  assert.equal(report.usage.totalTokens.total, null);
  assert.equal(report.usage.totalTokens.coverage, "unavailable");
  assert.deepEqual(report, analyzeInteractions(observations.toReversed()));
  assert.match(renderAnalysis(report), /15000 ms/);
});

test("provider completion, protocol failure, semantic verdict and controller results remain distinct", () => {
  const observations = [
    record("review", 1, 0, { kind: "request", phase: "result-review" }),
    record("review", 2, 1, {
      kind: "outcome",
      phase: "result-review",
      outcome: { stage: "provider", status: "completed" },
    }),
    record("review", 3, 1, {
      kind: "outcome",
      phase: "result-review",
      outcome: { stage: "parse", status: "valid" },
    }),
    record("review", 4, 1, {
      kind: "outcome",
      phase: "result-review",
      outcome: {
        stage: "protocol",
        status: "invalid",
        failureClass: "unknown-evidence-id",
      },
    }),
    record("other", 1, 2, {
      kind: "outcome",
      phase: "result-review",
      outcome: { stage: "semantic", status: "needs-human" },
    }),
  ];
  const controller = [
    {
      eventId: "validation-one",
      at: at(0),
      repository: "example/target",
      objective: 12,
      runId: "run-one",
      itemId: "review",
      attemptId: "attempt-review",
      operation: "validation-command",
      outcome: "completed",
      metadata: { commandIndex: 0 },
      detail: "must not appear",
    },
  ];
  const report = analyzeInteractions(observations, controller);
  const review = report.invocations.find(
    (entry) => entry.identity.invocationId === "review",
  );
  assert.equal(review.outcomes.provider[0].status, "completed");
  assert.equal(review.outcomes.protocol[0].status, "invalid");
  assert.deepEqual(review.outcomes.semantic, []);
  assert.equal(report.controllerObservations[0].outcome, "completed");
  assert.deepEqual(report.controllerObservations[0].relatedInvocationKeys, [
    review.key,
  ]);
  assert.equal(JSON.stringify(report).includes("must not appear"), false);
  assert.equal(
    analyzeInteractions([], controller).controllerObservations.length,
    1,
  );
});

test("partial failure/cancellation and unavailable terminal counters stay unknown", () => {
  const observations = [
    record("cancelled", 1, 0, { kind: "request" }),
    record("cancelled", 2, 2, {
      usage: cumulative({ inputTokens: 12 }, false),
    }),
    record("cancelled", 3, 3, {
      kind: "outcome",
      outcome: {
        stage: "provider",
        status: "failed",
        failureClass: "cancelled",
      },
    }),
    record("crashed", 1, 0, { kind: "request" }),
    record("crashed", 2, 3, { usage: cumulative({ inputTokens: 100 }, false) }),
    record("crashed", 3, 4, {
      usage: { ...cumulative({}), completeness: "unavailable" },
    }),
  ];
  const report = analyzeInteractions(observations);
  assert.equal(report.usage.inputTokens.total, 12);
  assert.equal(report.usage.inputTokens.coverage, "partial");
  assert.equal(report.observedWindow.incompleteIntervals, 1);
  assert.equal(
    report.invocations.find(
      (entry) => entry.identity.invocationId === "crashed",
    ).interval.endedAt,
    null,
  );
});

test("filters retain complete invocation history; grouping preserves unavailable and multiple observed models", () => {
  const observations = [
    record("one", 1, 0, { kind: "request", promptDigest: "chosen" }),
    record("one", 2, 1, { reportedModel: "model-a" }),
    record("one", 3, 2, {
      reportedModel: "model-b",
      usage: cumulative({ inputTokens: 1 }),
    }),
    record("two", 1, 0, { kind: "request", promptDigest: "other" }),
  ];
  const report = analyzeInteractions(observations, [], {
    filters: { promptDigest: "chosen", reportedModel: "model-b" },
    groupBy: ["reportedModel", "sourceDigest"],
  });
  assert.equal(report.invocationCount, 1);
  assert.equal(report.invocations[0].observations.length, 3);
  assert.deepEqual(report.groups[0].identity, {
    reportedModel: ["model-a", "model-b"],
    sourceDigest: null,
  });
  assert.throws(
    () => analyzeInteractions(observations, [], { groupBy: ["content"] }),
    /Unsupported analysis field/,
  );
  assert.equal(
    analyzeInteractions(observations, [], { filters: { model: "absent" } })
      .invocationCount,
    0,
  );
});

test("provider estimates retain provenance and incomplete coverage without invented billing", () => {
  const observations = [
    record("one", 1, 1, {
      usage: cumulative({ outputTokens: 3 }, true, {
        cost: {
          value: 0.02,
          currency: "USD",
          kind: "provider-estimate",
          provenance: "SDK total_cost_usd",
          completeness: "available",
        },
      }),
    }),
    record("one", 2, 2, {
      usage: cumulative({ outputTokens: 4 }, true, {
        cost: {
          value: 0.03,
          currency: "USD",
          kind: "provider-estimate",
          provenance: "SDK total_cost_usd",
          completeness: "available",
        },
      }),
    }),
    record("unknown", 1, 2),
  ];
  const report = analyzeInteractions(observations);
  assert.deepEqual(report.providerCostEstimates, [
    {
      currency: "USD",
      value: 0.03,
      kind: "provider-estimate",
      contributingInvocations: 1,
      eligibleInvocations: 2,
      coverage: "partial",
      provenance: ["SDK total_cost_usd"],
    },
  ]);
  assert.match(renderAnalysis(report), /not billed cost/);
});

test("metadata keeps coverage/content references without opening payloads; conflicting IDs are refused", () => {
  const observation = record("one", 1, 0, {
    content: {
      status: "captured",
      redacted: true,
      truncated: true,
      reference: { invocationId: "one", providerAttempt: 1, recordId: "one-1" },
    },
  });
  Object.defineProperty(observation, "payload", {
    get() {
      throw new Error("Content must not load");
    },
  });
  const report = analyzeInteractions([observation]);
  assert.equal(report.invocations[0].observations[0].content.truncated, true);
  assert.equal(report.invocations[0].observations[0].content.redacted, true);
  assert.throws(
    () =>
      analyzeInteractions([observation, { ...observation, phase: "other" }]),
    /Conflicting capture record identity/,
  );
  const reordered = Object.fromEntries(
    Object.entries(observation).toReversed(),
  );
  assert.equal(
    analyzeInteractions([observation, reordered]).invocationCount,
    1,
  );
});

test("cost completeness is independent of token availability and a reset is not zero cost", () => {
  const make = (completeness) =>
    record("one", 1, 1, {
      usage: {
        ...cumulative({}, true, {
          cost: {
            value: 0,
            currency: "USD",
            kind: "provider-estimate",
            completeness,
            provenance: "SDK estimate",
          },
        }),
        completeness: "unavailable",
      },
    });
  const available = analyzeInteractions([make("available")]);
  assert.equal(available.usage.inputTokens.total, null);
  assert.equal(available.providerCostEstimates[0].value, 0);
  assert.equal(available.providerCostEstimates[0].coverage, "available");
  assert.equal(
    analyzeInteractions([make("partial")]).providerCostEstimates[0].coverage,
    "partial",
  );
  assert.deepEqual(
    analyzeInteractions([make("unavailable")]).providerCostEstimates,
    [],
  );
});
