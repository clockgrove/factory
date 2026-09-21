import assert from "node:assert/strict";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";

// Observation proof only. Authentication and exact run selection belong to the caller.
export const isQualificationModelMarker = (event) =>
  event.kind === "budget" &&
  event.event === "BudgetReserved" &&
  event.unit === "model_tokens" &&
  event.modelInvocationId !== undefined;

export const isQualificationTerminalUnavailable = (event) =>
  event.kind === "attempt" &&
  event.event === "AttemptCancelled" &&
  event.modelUsageAccounting === "terminal-unavailable" &&
  event.producerState === "absent" &&
  event.modelInvocationId !== undefined;

const isQualificationRecoveryBlocked = (event) =>
  event.kind === "attempt" &&
  event.event === "AttemptRecoveryBlocked" &&
  event.modelUsageAccounting === "unknown" &&
  event.producerState === "absent" &&
  event.modelInvocationId !== undefined;

const identity = (event) =>
  JSON.stringify([
    event.objective,
    event.runId,
    event.workItem ?? null,
    event.attempt ?? null,
    event.phase,
    event.modelInvocationId,
  ]);
const binding = (left, right) =>
  left.policyDigest === right.policyDigest && left.directorEpoch === right.directorEpoch;

function linkedShape(event, requireMarkers) {
  assert.ok(typeof event.modelInvocationId === "string" && event.modelInvocationId.length <= 160);
  assert.match(event.modelInvocationId, /^[A-Za-z0-9._:/+-]+$/);
  assert.ok(
    ["execution", "management"].includes(event.phase),
    "model invocation has an invalid phase",
  );
  for (const field of ["objective", "workItem", "attempt"])
    if (field === "objective" || event[field] !== undefined)
      assert.ok(
        Number.isSafeInteger(event[field]) && event[field] > 0,
        "invalid model invocation tuple",
      );
  assert.ok(event.attempt === undefined || event.workItem !== undefined);
  if (event.phase === "execution") assert.ok(event.workItem && event.attempt);
  assert.ok(typeof event.runId === "string" && event.runId.length > 0 && event.runId.length <= 160);
  assert.equal(event.policyDigest === undefined, event.directorEpoch === undefined);
  if (requireMarkers || event.policyDigest !== undefined) {
    assert.match(
      event.policyDigest ?? "",
      /^[a-f0-9]{64}$/i,
      "fresh dispatch lacks its original policy binding",
    );
    assert.ok(
      Number.isSafeInteger(event.directorEpoch) && event.directorEpoch > 0,
      "fresh dispatch lacks its original epoch",
    );
  }
  assert.ok(
    typeof event.usageId === "string" && event.usageId.length > 0 && event.usageId.length <= 300,
  );
}

function actualCounters(event) {
  assert.ok(
    event.usageEvidence === undefined || event.usageEvidence === "as-recorded",
    "model usage cannot be a conservative native reservation",
  );
  const usage = event.reportedModelUsage;
  if (usage === undefined) return; // Available scalar-only historical evidence stays valid.
  assert.ok(usage && typeof usage === "object" && !Array.isArray(usage));
  const fields = Object.keys(usage);
  assert.ok(
    fields.length > 0 &&
      fields.every((field) => ["inputTokens", "outputTokens", "cachedInputTokens"].includes(field)),
  );
  for (const field of fields) assert.ok(Number.isSafeInteger(usage[field]) && usage[field] >= 0);
  if (usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined)
    assert.ok(usage.cachedInputTokens <= usage.inputTokens, "cached input exceeds input");
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined)
    assert.equal(
      usage.inputTokens + usage.outputTokens,
      event.amount,
      "actual model total contradicts reported counters",
    );
}

/** Intent carries no measured usage. Only its exact, later actual receipt settles it. */
export function qualificationModelAccounting(events, { requireMarkers = false } = {}) {
  const rows = deduplicateQualificationReceipts(events.map((event) => ({ event }))).map(
    ({ event }) => event,
  );
  const markers = new Map(),
    actual = new Map(),
    abandoned = new Map(),
    terminalUnavailable = new Map(),
    recoveryBlocked = new Map(),
    usageByKey = new Map();
  const rawUsage = rows.filter(
    (event) =>
      event.kind === "budget" &&
      event.event === "BudgetReconciled" &&
      event.unit === "model_tokens",
  );
  for (const event of rows.filter(isQualificationModelMarker)) {
    linkedShape(event, requireMarkers);
    assert.equal(event.amount, 0, "model intent is not measured usage");
    assert.equal(event.usageId, `invocation-${event.modelInvocationId}`);
    assert.equal(event.reportedModelUsage, undefined);
    assert.equal(event.usageEvidence, undefined);
    const key = identity(event),
      prior = markers.get(key);
    assert.ok(!prior || binding(prior, event), "conflicting model dispatch binding");
    if (!prior || event.sequence < prior.sequence) markers.set(key, event);
  }
  for (const event of rows.filter(isQualificationTerminalUnavailable)) {
    assert.ok(
      typeof event.modelInvocationId === "string" &&
        event.modelInvocationId.length > 0 &&
        event.modelInvocationId.length <= 160 &&
        /^[A-Za-z0-9._:/+-]+$/.test(event.modelInvocationId),
      "terminal unavailable receipt has an invalid model invocation",
    );
    for (const field of ["objective", "workItem", "attempt", "directorEpoch"])
      assert.ok(Number.isSafeInteger(event[field]) && event[field] > 0);
    assert.ok(
      typeof event.runId === "string" && event.runId.length > 0 && event.runId.length <= 160,
    );
    assert.match(event.policyDigest ?? "", /^[a-f0-9]{64}$/i);
    assert.equal(event.reportedModelTokens, undefined);
    assert.equal(event.reportedModelUsage, undefined);
    const key = identity({ ...event, phase: "execution" });
    const marker = markers.get(key);
    assert.ok(marker, "terminal unavailable receipt has no exact dispatch marker");
    assert.ok(binding(marker, event), "terminal unavailable receipt differs from dispatch binding");
    assert.ok(
      event.sequence > marker.sequence,
      "terminal unavailable receipt precedes dispatch intent",
    );
    const prior = terminalUnavailable.get(key);
    assert.ok(
      !prior ||
        (binding(prior, event) &&
          prior.backend === event.backend &&
          prior.baseSha === event.baseSha),
      "conflicting terminal unavailable receipts for one invocation",
    );
    if (!prior || event.sequence < prior.sequence) terminalUnavailable.set(key, event);
  }
  for (const event of rows.filter(isQualificationRecoveryBlocked)) {
    const key = identity({ ...event, phase: "execution" });
    const marker = markers.get(key);
    assert.ok(marker, "recovery-blocked receipt has no exact dispatch marker");
    assert.ok(binding(marker, event), "recovery-blocked receipt differs from dispatch binding");
    const prior = recoveryBlocked.get(key);
    assert.ok(
      !prior ||
        (binding(prior, event) &&
          prior.backend === event.backend &&
          prior.baseSha === event.baseSha),
      "conflicting recovery-blocked receipts for one invocation",
    );
    if (!prior || event.sequence < prior.sequence) recoveryBlocked.set(key, event);
  }
  let total = 0;
  for (const event of rawUsage) {
    assert.ok(Number.isSafeInteger(event.amount) && event.amount >= 0, "invalid known model usage");
    actualCounters(event);
    const usageKey = JSON.stringify([
      event.objective,
      event.runId,
      event.workItem ?? null,
      event.attempt ?? null,
      event.phase,
      event.usageId,
    ]);
    const priorUsage = usageByKey.get(usageKey);
    assert.ok(
      !priorUsage ||
        (priorUsage.amount === event.amount &&
          priorUsage.modelInvocationId === event.modelInvocationId &&
          priorUsage.policyDigest === event.policyDigest &&
          priorUsage.directorEpoch === event.directorEpoch &&
          JSON.stringify(priorUsage.reportedModelUsage) ===
            JSON.stringify(event.reportedModelUsage)),
      "model usage repeated with conflicting evidence",
    );
    if (!priorUsage) {
      usageByKey.set(usageKey, event);
      total += event.amount;
      assert.ok(Number.isSafeInteger(total), "model usage total overflow");
    }
    if (event.modelInvocationId !== undefined) {
      linkedShape(event, requireMarkers);
      assert.ok(
        !event.usageId.startsWith("invocation-"),
        "dispatch marker cannot masquerade as actual usage",
      );
      const key = identity(event);
      const prior = actual.get(key);
      assert.ok(
        !prior ||
          (prior.amount === event.amount &&
            prior.usageId === event.usageId &&
            binding(prior, event) &&
            JSON.stringify(prior.reportedModelUsage) === JSON.stringify(event.reportedModelUsage)),
        "multiple conflicting actual receipts for one model invocation",
      );
      if (!prior || event.sequence < prior.sequence) actual.set(key, event);
      const marker = markers.get(key);
      assert.ok(marker, "model usage has no exact dispatch marker");
      assert.ok(binding(marker, event), "model usage differs from original dispatch binding");
    } else assert.ok(!requireMarkers, "model usage lacks dispatch linkage");
  }
  for (const event of rows.filter(
    (event) =>
      event.kind === "budget" &&
      event.event === "BudgetAbandoned" &&
      event.unit === "model_tokens" &&
      event.modelInvocationId !== undefined,
  )) {
    linkedShape(event, requireMarkers);
    assert.equal(event.amount, 0, "model abandonment cannot report usage");
    assert.equal(
      event.usageId,
      `abandoned-${event.modelInvocationId}`,
      "model abandonment has an invalid usage identity",
    );
    assert.ok(
      typeof event.reason === "string" && event.reason.length > 0 && event.reason.length <= 4000,
      "model abandonment requires a bounded reason",
    );
    assert.equal(event.reportedModelUsage, undefined);
    assert.equal(event.usageEvidence, undefined);
    const key = identity(event);
    const marker = markers.get(key);
    assert.ok(marker, "model abandonment has no exact dispatch marker");
    assert.ok(binding(marker, event), "model abandonment differs from original dispatch binding");
    const prior = abandoned.get(key);
    assert.ok(
      !prior ||
        (prior.amount === event.amount && prior.usageId === event.usageId && binding(prior, event)),
      "multiple conflicting abandonment receipts for one model invocation",
    );
    if (!prior || event.sequence < prior.sequence) abandoned.set(key, event);
  }
  for (const key of markers.keys()) {
    const terminal = terminalUnavailable.get(key);
    const recovery = recoveryBlocked.get(key);
    const exact = actual.get(key);
    const abandonedDisposition = abandoned.get(key);
    assert.ok(
      !(exact && abandonedDisposition) &&
        !(terminal && (exact || abandonedDisposition || recovery)) &&
        !(recovery && (exact || abandonedDisposition)),
      "model invocation has conflicting terminal accounting dispositions",
    );
  }
  const unresolved = [...markers.values()].filter((marker) => {
    const key = identity(marker);
    const exact = actual.get(key);
    const abandonedDisposition = abandoned.get(key);
    return (
      !terminalUnavailable.has(key) &&
      !(exact && exact.sequence > marker.sequence) &&
      !(abandonedDisposition && abandonedDisposition.sequence > marker.sequence)
    );
  });
  const usage = [...usageByKey.values()];
  return {
    usage,
    markers: [...markers.values()],
    abandoned: [...abandoned.values()],
    terminalUnavailable: [...terminalUnavailable.values()],
    unresolved,
    total,
  };
}
