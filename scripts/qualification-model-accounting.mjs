import assert from "node:assert/strict";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";

// Observation proof only. Authentication and exact run selection belong to the caller.
export const isQualificationModelMarker = (event) =>
  event.kind === "budget" && event.event === "BudgetReserved" &&
  event.unit === "model_tokens" && event.modelInvocationId !== undefined;

const identity = (event) => JSON.stringify([
  event.objective, event.runId, event.workItem ?? null, event.attempt ?? null,
  event.phase, event.modelInvocationId,
]);
const binding = (left, right) =>
  left.policyDigest === right.policyDigest && left.directorEpoch === right.directorEpoch;

/** Intent carries no measured usage. Only its exact, later actual receipt settles it. */
export function qualificationModelAccounting(events, { requireMarkers = false } = {}) {
  const rows = deduplicateQualificationReceipts(events.map((event) => ({ event })))
    .map(({ event }) => event);
  const markers = new Map(), actual = new Map(), usageKeys = new Set();
  const usage = rows.filter((event) =>
    event.kind === "budget" && event.event === "BudgetReconciled" && event.unit === "model_tokens");
  for (const event of rows.filter(isQualificationModelMarker)) {
    assert.equal(typeof event.modelInvocationId, "string");
    assert.ok(event.modelInvocationId.length > 0);
    assert.equal(event.amount, 0, "model intent is not measured usage");
    assert.equal(event.usageId, `invocation-${event.modelInvocationId}`);
    assert.equal(event.reportedModelUsage, undefined);
    assert.equal(event.usageEvidence, undefined);
    const key = identity(event), prior = markers.get(key);
    assert.ok(!prior || binding(prior, event), "conflicting model dispatch binding");
    if (!prior || event.sequence < prior.sequence) markers.set(key, event);
  }
  let total = 0;
  for (const event of usage) {
    assert.ok(Number.isSafeInteger(event.amount) && event.amount >= 0, "invalid known model usage");
    const usageKey = JSON.stringify([
      event.objective, event.runId, event.workItem ?? null, event.attempt ?? null,
      event.phase, event.usageId,
    ]);
    assert.ok(!usageKeys.has(usageKey), "model usage repeated");
    usageKeys.add(usageKey);
    total += event.amount;
    assert.ok(Number.isSafeInteger(total), "model usage total overflow");
    if (event.modelInvocationId !== undefined) {
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
