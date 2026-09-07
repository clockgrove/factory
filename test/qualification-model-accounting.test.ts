import { describe, expect, it } from "vitest";
import { qualificationModelAccounting } from "../scripts/qualification-model-accounting.mjs";
import { unresolvedModelInvocations } from "../src/control/budget.js";
import { parseFactoryEvent } from "../src/protocol/events.js";

function fixture() {
  const base = { protocol: "clockgrove.factory/v2", kind: "budget", objective: 7, runId: "run-7", at: "2026-09-07T00:00:00Z", workItem: 8, attempt: 1, phase: "execution", unit: "model_tokens", modelInvocationId: "worker-8-1", policyDigest: "a".repeat(64), directorEpoch: 1 };
  return [
    parseFactoryEvent({...base, event: "BudgetReserved", sequence: 1, amount: 0, usageId: "invocation-worker-8-1"}),
    parseFactoryEvent({...base, event: "BudgetReconciled", sequence: 2, amount: 37, usageId: "worker-8-1"}),
  ];
}
describe("installed qualifier model accounting", () => {
  it("uses production-valid marker/actual linkage, not equal usage IDs", () => {
    const rows = fixture();
    const proof = qualificationModelAccounting(rows, {requireMarkers: true});
    expect(proof).toMatchObject({total: 37, unresolved: []});
    expect(proof.usage).toHaveLength(1);
    expect(proof.markers).toHaveLength(1);
    expect(proof.unresolved).toEqual(unresolvedModelInvocations(rows));
    const unknown = qualificationModelAccounting([rows[0]!], {requireMarkers: true});
    expect(unknown.unresolved).toEqual(unresolvedModelInvocations([rows[0]!]));
    expect(unknown.usage).toEqual([]);
  });
  it.each(["policyDigest", "directorEpoch", "workItem", "attempt", "runId", "objective", "modelInvocationId"])("rejects changed %s rather than closing another invocation", (field) => {
    const rows = fixture();
    const changed = {...rows[1], [field]: ["directorEpoch", "workItem", "attempt", "objective"].includes(field) ? 99 : "different"};
    expect(() => qualificationModelAccounting([rows[0]!, changed], {requireMarkers: true})).toThrow();
  });
  it("deduplicates exact receipt replay but rejects duplicate actual usage and zero-filled intent", () => {
    const rows = fixture();
    expect(qualificationModelAccounting([...rows, ...rows], {requireMarkers: true}).total).toBe(37);
    expect(() => qualificationModelAccounting([...rows, {...rows[1], sequence: 3}], {requireMarkers: true})).toThrow(/repeated/);
    expect(() => qualificationModelAccounting([{...rows[0], amount: 37}, rows[1]!], {requireMarkers: true})).toThrow();
    expect(() => qualificationModelAccounting([{...rows[0], sequence: 3}, rows[1]!], {requireMarkers: true})).toThrow(/precedes/);
  });
  it("requires explicit linkage for fresh policies without rewriting historical receipts", () => {
    const rows = fixture();
    const { modelInvocationId: _id, ...legacy } = rows[1] as Record<string, unknown>;
    expect(qualificationModelAccounting([legacy]).total).toBe(37);
    expect(() => qualificationModelAccounting([legacy], {requireMarkers: true})).toThrow(/linkage/);
  });
});
