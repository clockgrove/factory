// Synthetic #220 discovery experiment; no files, provider calls or private data read.
import assert from "node:assert/strict";
import { analyzeInteractions } from "../dist/analysis.js";

// Frozen before execution: 12 logical invocations, 13 provider attempts, three
// phases, two configured models. Text is synthetic; outcomes are observations.
const cases = [
  [
    "evidence-a",
    1,
    "result-review",
    "completed",
    "protocol",
    "invalid",
    220,
    "Source chunk missing from the supplied evidence.",
  ],
  [
    "evidence-b",
    1,
    "result-review",
    "completed",
    "semantic",
    "needs-human",
    340,
    "Required baseline file content is absent.",
  ],
  [
    "evidence-decoy",
    1,
    "result-review",
    "completed",
    "semantic",
    "pass",
    270,
    "The instruction says 'source chunk missing'; all expected content is present.",
  ],
  [
    "tool-a",
    1,
    "implementation",
    "failed",
    null,
    "capacity",
    null,
    null,
    "not-exposed",
  ],
  [
    "tool-a",
    2,
    "implementation",
    "failed",
    null,
    "tool-failure",
    900,
    "ENOENT: fixture.json",
  ],
  [
    "tool-b",
    1,
    "implementation",
    "failed",
    null,
    "tool-failure",
    780,
    "File fixture.json was not found.",
  ],
  [
    "tool-decoy",
    1,
    "implementation",
    "completed",
    null,
    "complete",
    320,
    "The test contains 'ENOENT: fixture.json' and passes.",
  ],
  [
    "expensive-refusal",
    1,
    "result-review",
    "completed",
    "semantic",
    "refuse",
    11500,
    "The implementation does not satisfy the requested behavior.",
  ],
  [
    "compile-success",
    1,
    "compile",
    "completed",
    "parse",
    "valid",
    1400,
    "A valid plan was returned.",
  ],
  [
    "disabled",
    1,
    "implementation",
    "failed",
    null,
    "tool-failure",
    550,
    null,
    "capture-disabled",
  ],
  [
    "unavailable",
    1,
    "implementation",
    "failed",
    null,
    "tool-failure",
    null,
    null,
    "unavailable",
  ],
  [
    "redacted",
    1,
    "result-review",
    "completed",
    "semantic",
    "needs-human",
    500,
    "The required [REDACTED] content is absent.",
    "redacted",
  ],
  [
    "truncated",
    1,
    "implementation",
    "failed",
    null,
    "tool-failure",
    null,
    "File fixture.json was",
    "truncated",
  ],
];
const expected = {
  evidence: ["evidence-a:1", "evidence-b:1"],
  tool: ["tool-a:2", "tool-b:1"],
};
const terms = {
  evidence: ["source chunk", "baseline file"],
  tool: ["enoent", "file fixture.json was not found"],
};
const at = (seconds) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const records = [];
const responses = [];
for (const [index, row] of cases.entries()) {
  const [
    id,
    providerAttempt,
    phase,
    provider,
    stage,
    status,
    totalTokens,
    text,
    coverage,
  ] = row;
  const key = `${id}:${providerAttempt}`;
  const start = providerAttempt === 2 ? 16 : index * 5;
  const duration =
    status === "capacity"
      ? 1
      : id === "expensive-refusal"
        ? 30
        : id === "compile-success"
          ? 25
          : 10;
  let sequence = 0;
  const add = (kind, seconds, extra = {}) => {
    const record = {
      schemaVersion: 1,
      repository: "example/synthetic-target",
      objective: 1,
      runId: "synthetic-run",
      itemId: id,
      attemptId: `attempt-${id}`,
      invocationId: id,
      providerAttempt,
      phase,
      recordId: `${key}:${++sequence}`,
      sequence,
      at: at(seconds),
      kind,
      factoryVersion: "synthetic",
      adapter: "synthetic",
      configured: {
        provider: "synthetic",
        model: phase === "implementation" ? "worker-model" : "review-model",
      },
      promptDigest: `synthetic-prompt-${id}`,
      sourceDigest: "synthetic-source-v1",
      configDigest: "synthetic-config-v1",
      coverage: "boundary",
      content: { status: "not-exposed", redacted: false, truncated: false },
      ...extra,
    };
    records.push(record);
    return record;
  };
  add("request", start);
  if (id === "expensive-refusal") {
    add("usage", start + 1, {
      usage: {
        scope: "invocation-cumulative",
        terminal: false,
        completeness: "available-categories",
        normalized: { totalTokens: 2000 },
      },
    });
    add("usage", start + 2, {
      usage: {
        scope: "provider-call",
        terminal: true,
        completeness: "available-categories",
        normalized: { totalTokens: 90000 },
      },
    });
  }
  if (totalTokens !== null) {
    add("usage", start + duration, {
      usage: {
        scope: "invocation-cumulative",
        terminal: true,
        completeness: "available-categories",
        normalized: { totalTokens },
      },
    });
  }
  const response = add("response", start + duration, {
    content: {
      status: ["not-exposed", "capture-disabled", "unavailable"].includes(
        coverage,
      )
        ? coverage
        : "captured",
      redacted: coverage === "redacted",
      truncated: coverage === "truncated",
      ...(text !== null
        ? {
            reference: {
              invocationId: id,
              providerAttempt,
              recordId: `${key}:${sequence + 1}`,
            },
          }
        : {}),
    },
  });
  responses.push({
    key,
    recordId: response.recordId,
    descriptor: response.content,
    text,
  });
  add("outcome", start + duration, {
    outcome: {
      stage: "provider",
      status: provider,
      ...(provider === "failed" ? { failureClass: status } : {}),
    },
  });
  if (stage) add("outcome", start + duration, { outcome: { stage, status } });
}
// A repeated transport record must not multiply observed work or usage.
records.push(structuredClone(records[0]));
const report = analyzeInteractions(records, [], { groupBy: ["phase"] });
const byKey = new Map(
  report.invocations.map((invocation) => [
    `${invocation.identity.invocationId}:${invocation.identity.providerAttempt}`,
    invocation,
  ]),
);
const inspectable = responses.filter(
  ({ descriptor }) =>
    descriptor.status === "captured" &&
    !descriptor.redacted &&
    !descriptor.truncated,
);
const reviewRejected = (invocation) =>
  invocation.outcomes.protocol.some(({ status }) => status === "invalid") ||
  invocation.outcomes.semantic.some(({ status }) =>
    ["needs-human", "refuse"].includes(status),
  );
const providerFailed = (invocation) =>
  invocation.outcomes.provider.some(({ status }) => status === "failed");
const rejected = (invocation) =>
  reviewRejected(invocation) || providerFailed(invocation);
const measure = (found, truth) => ({
  precision: found.length
    ? found.filter((key) => truth.includes(key)).length / found.length
    : null,
  recall: truth.length
    ? truth.filter((key) => found.includes(key)).length / truth.length
    : null,
});
const results = {};
for (const [question, needles] of Object.entries(terms)) {
  const candidates = inspectable.filter(({ text }) =>
    needles.some((needle) => text.toLowerCase().includes(needle)),
  );
  const observed = candidates.filter(({ key }) =>
    question === "evidence"
      ? reviewRejected(byKey.get(key))
      : providerFailed(byKey.get(key)),
  );
  const candidateKeys = candidates.map(({ key }) => key);
  const selectedKeys = observed.map(({ key }) => key);
  assert.deepEqual(selectedKeys, expected[question]);
  results[question] = {
    searchTerms: needles,
    rawSearch: {
      keys: candidateKeys,
      ...measure(candidateKeys, expected[question]),
    },
    outcomeQualified: {
      keys: selectedKeys,
      ...measure(selectedKeys, expected[question]),
    },
    observations: observed.map(({ key, recordId }) => ({
      key,
      responseRecordId: recordId,
      outcomes: byKey.get(key).outcomes,
    })),
  };
}
const unsuccessfulKeys = new Set(
  report.invocations.filter(rejected).map(({ key }) => key),
);
const unsuccessful = analyzeInteractions(
  records.filter((record) =>
    unsuccessfulKeys.has(
      JSON.stringify([
        record.repository,
        record.objective,
        record.attemptId,
        record.invocationId,
        record.providerAttempt,
      ]),
    ),
  ),
  [],
  { groupBy: ["phase"] },
);
const ranked = unsuccessful.groups
  .toSorted(
    (a, b) =>
      (b.usage.totalTokens.total ?? -1) - (a.usage.totalTokens.total ?? -1),
  )
  .map(({ identity, invocationKeys, usage }) => ({
    phase: identity.phase,
    observedTotalTokens: usage.totalTokens,
    invocationKeys,
  }));
assert.equal(ranked[0].phase, "result-review");
assert.equal(ranked[0].observedTotalTokens.total, 12560);
assert.equal(report.usage.totalTokens.total, 16780);
assert.equal(report.invocationCount, 13);
assert.equal(
  new Set(report.invocations.map(({ identity }) => identity.invocationId)).size,
  12,
);
assert.equal(inspectable.length, 8);
assert.deepEqual(
  report,
  analyzeInteractions(records.toReversed(), [], { groupBy: ["phase"] }),
);
console.log(
  JSON.stringify(
    {
      scope:
        "synthetic discovery only; no production frequency, root-cause, model-quality or billing claim",
      sample: {
        logicalInvocations: 12,
        providerAttempts: report.invocationCount,
        metadataRecordsIncludingDuplicate: records.length,
        completeInspectableResponses: inspectable.length,
        excludedResponses: responses
          .filter((response) => !inspectable.includes(response))
          .map(({ key, recordId, descriptor }) => ({
            key,
            recordId,
            ...descriptor,
          })),
        cumulativeTokens: report.usage.totalTokens,
        observedEnvelopeMs: report.observedWindow.elapsedMs,
        summedAttemptDurationMs: report.invocations.reduce(
          (sum, { interval }) => sum + interval.durationMs,
          0,
        ),
      },
      questions: { ...results, observedUnsuccessfulUsage: ranked },
      recommendation:
        "Existing metadata analysis and operator-guided literal search suffice for this sample. Stop; no clustering or embeddings feature justified. Unknown usage and incomplete content prevent a complete corpus verdict.",
    },
    null,
    2,
  ),
);
