/** Durable terminal evidence shared by successful and refused qualification paths. */
import assert from "node:assert/strict";
import { qualificationModelAccounting } from "./qualification-model-accounting.mjs";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";

const one = (values, message) => {
  assert.equal(values.length, 1, message);
  return values[0];
};
const sameAttempt = (left, right) =>
  ["runId", "objective", "workItem", "attempt"].every((key) => left[key] === right[key]);

function exactModelCounters(model) {
  const counters = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  for (const event of model.usage) {
    const usage = event.reportedModelUsage;
    assert.ok(usage && typeof usage === "object", "settled model usage lacks exact counters");
    assert.deepEqual(
      Object.keys(usage).sort(),
      ["cachedInputTokens", "inputTokens", "outputTokens"],
      "settled model counter fields differ",
    );
    for (const field of Object.keys(counters)) {
      assert.ok(Number.isSafeInteger(usage[field]) && usage[field] >= 0);
      counters[field] += usage[field];
      assert.ok(Number.isSafeInteger(counters[field]), "settled model counter total overflow");
    }
    assert.ok(usage.cachedInputTokens <= usage.inputTokens, "cached input exceeds input");
    assert.equal(usage.inputTokens + usage.outputTokens, event.amount);
  }
  assert.equal(counters.inputTokens + counters.outputTokens, model.total);
  return counters;
}

/** The caller authenticates receipt actors and locations before passing events here. */
export function settledQualificationEvidence(events, { runId, terminalEvent }) {
  assert.ok(typeof runId === "string" && runId.length > 0);
  const run = deduplicateQualificationReceipts(
    events.filter((event) => event.runId === runId).map((event) => ({ event })),
  ).map(({ event }) => event);
  assert.ok(run.length > 0, "settled run has no durable receipts");
  const terminal = one(
    run.filter((event) => event.event === terminalEvent),
    "settled terminal receipt is missing or repeated",
  );
  assert.ok(
    run.every(
      (event) => Number.isSafeInteger(event.sequence) && event.sequence <= terminal.sequence,
    ),
    "durable run advanced after its terminal receipt",
  );
  const model = qualificationModelAccounting(run, { requireMarkers: true });
  assert.equal(model.unresolved.length, 0, "settled model invocation remains unresolved");
  return { events: run, terminal, model, counters: exactModelCounters(model) };
}

export function assertSettledAttemptRefusal(
  settled,
  { baseSha, reason, backend = "codex-app-server/local-worktree" },
) {
  const { events, terminal, model, counters } = settled;
  const reserved = one(
    events.filter((event) => event.event === "AttemptReserved"),
    "one actual refusal attempt required",
  );
  const started = one(
    events.filter((event) => event.event === "AttemptStarted"),
    "one actual worker start required",
  );
  const failed = one(
    events.filter((event) => event.event === "AttemptFailed"),
    "one exact failed artifact attempt required",
  );
  assert.ok(
    sameAttempt(reserved, started) &&
      sameAttempt(reserved, failed) &&
      reserved.attempt === 1 &&
      reserved.baseSha === baseSha &&
      reserved.backend === backend &&
      ["baseSha", "backend", "policyDigest", "directorEpoch"].every(
        (key) => reserved[key] === started[key] && reserved[key] === failed[key],
      ),
    "refusal attempt identity or authority differs",
  );
  assert.ok(
    typeof started.providerResourceId === "string" && started.providerResourceId.length > 0,
    "refusal did not reach a real worker",
  );
  assert.equal(failed.reason, reason, "worker failed at a different artifact boundary");
  assert.ok(
    reserved.sequence < started.sequence &&
      started.sequence < failed.sequence &&
      failed.sequence < terminal.sequence,
    "refusal attempt/terminal chronology differs",
  );
  const executionUsage = one(
    model.usage.filter((event) => event.phase === "execution" && sameAttempt(event, reserved)),
    "refusal worker accounting is missing or repeated",
  );
  assert.ok(
    started.sequence < executionUsage.sequence && executionUsage.sequence < failed.sequence,
    "refusal worker accounting is outside its attempt fence",
  );
  const forbidden = new Set([
    "AttemptSucceeded",
    "ValidationRecorded",
    "AttemptValidated",
    "AttemptPublished",
    "PublicationRecorded",
    "IntegrationPending",
    "IntegrationCompleted",
    "AttemptIntegrated",
    "FactoryRunCompleted",
  ]);
  assert.ok(
    !events.some((event) => forbidden.has(event.event)),
    "refused artifact reached success, validation, publication, or integration",
  );
  return {
    runId: reserved.runId,
    workItem: reserved.workItem,
    attempt: reserved.attempt,
    backend: reserved.backend,
    reason,
    terminalSequence: terminal.sequence,
    model: {
      calls: model.usage.length,
      ...counters,
      totalTokens: model.total,
      unresolvedInvocations: 0,
    },
  };
}
