import assert from "node:assert/strict";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";

// Observation proof only. Authentication and exact run selection belong to the caller.
export const isQualificationModelMarker = (event) =>
  event.kind === "budget" &&
  event.event === "BudgetReserved" &&
  event.unit === "model_tokens" &&
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
    usageKeys = new Set();
  const usage = rows.filter(
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
  let total = 0;
  for (const event of usage) {
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
    assert.ok(!usageKeys.has(usageKey), "model usage repeated");
    usageKeys.add(usageKey);
    total += event.amount;
    assert.ok(Number.isSafeInteger(total), "model usage total overflow");
    if (event.modelInvocationId !== undefined) {
      linkedShape(event, requireMarkers);
      assert.ok(
        !event.usageId.startsWith("invocation-"),
        "dispatch marker cannot masquerade as actual usage",
      );
      const key = identity(event);
      assert.ok(!actual.has(key), "multiple actual receipts for one model invocation");
      actual.set(key, event);
      const marker = markers.get(key);
      assert.ok(marker, "model usage has no exact dispatch marker");
      assert.ok(binding(marker, event), "model usage differs from original dispatch binding");
      assert.ok(event.sequence > marker.sequence, "model usage precedes dispatch intent");
    } else assert.ok(!requireMarkers, "model usage lacks dispatch linkage");
  }
  const unresolved = [...markers.values()].filter((marker) => !actual.has(identity(marker)));
  return { usage, markers: [...markers.values()], unresolved, total };
}
