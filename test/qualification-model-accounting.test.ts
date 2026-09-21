import { describe, expect, it } from "vitest";
import { qualificationModelAccounting } from "../scripts/qualification-model-accounting.mjs";
import { unresolvedModelInvocations } from "../src/control/budget.js";
import { parseFactoryEvent } from "../src/protocol/events.js";

function fixture() {
  const base = {
    protocol: "clockgrove.factory/v2",
    kind: "budget",
    objective: 7,
    runId: "run-7",
    at: "2026-09-07T00:00:00Z",
    workItem: 8,
    attempt: 1,
    phase: "execution",
    unit: "model_tokens",
    modelInvocationId: "worker-8-1",
    policyDigest: "a".repeat(64),
    directorEpoch: 1,
  };
  return [
    parseFactoryEvent({
      ...base,
      event: "BudgetReserved",
      sequence: 1,
      amount: 0,
      usageId: "invocation-worker-8-1",
    }),
    parseFactoryEvent({
      ...base,
      event: "BudgetReconciled",
      sequence: 2,
      amount: 37,
      usageId: "worker-8-1",
    }),
  ];
}
describe("installed qualifier model accounting", () => {
  it("uses production-valid marker/actual linkage, not equal usage IDs", () => {
    const rows = fixture();
    const proof = qualificationModelAccounting(rows, { requireMarkers: true });
    expect(proof).toMatchObject({ total: 37, unresolved: [] });
    expect(proof.usage).toHaveLength(1);
    expect(proof.markers).toHaveLength(1);
    expect(proof.unresolved).toEqual(unresolvedModelInvocations(rows));
    const unknown = qualificationModelAccounting([rows[0]!], { requireMarkers: true });
    expect(unknown.unresolved).toEqual(unresolvedModelInvocations([rows[0]!]));
    expect(unknown.usage).toEqual([]);
  });
  it("closes a proven absent cancellation as terminal unavailable without inventing usage", () => {
    const [marker] = fixture();
    const cancelled = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "attempt",
      event: "AttemptCancelled",
      objective: marker!.objective,
      runId: marker!.runId,
      sequence: 2,
      at: "2026-09-07T00:00:01Z",
      workItem: marker!.workItem,
      attempt: marker!.attempt,
      backend: "codex-sdk/local-worktree",
      baseSha: "b".repeat(40),
      reason: "operator cancellation",
      directorEpoch: marker!.directorEpoch,
      policyDigest: marker!.policyDigest,
      modelInvocationId: marker!.modelInvocationId,
      producerState: "absent",
      modelUsageAccounting: "terminal-unavailable",
    });

    expect(
      qualificationModelAccounting([marker!, cancelled], { requireMarkers: true }),
    ).toMatchObject({
      total: 0,
      usage: [],
      unresolved: [],
      terminalUnavailable: [expect.objectContaining({ modelInvocationId: "worker-8-1" })],
    });
    expect(() =>
      qualificationModelAccounting([marker!, { ...cancelled, reportedModelTokens: 0 }], {
        requireMarkers: true,
      }),
    ).toThrow();
    expect(() =>
      qualificationModelAccounting([...fixture(), { ...cancelled, sequence: 3 }], {
        requireMarkers: true,
      }),
    ).toThrow(/conflicting terminal accounting dispositions/);
    expect(
      qualificationModelAccounting([marker!, cancelled, { ...cancelled, sequence: 3 }], {
        requireMarkers: true,
      }).terminalUnavailable,
    ).toHaveLength(1);
  });
  it("matches runtime closure for abandonment and ambiguity", () => {
    const [marker, exact] = fixture();
    const abandoned = parseFactoryEvent({
      ...marker!,
      event: "BudgetAbandoned",
      sequence: 2,
      amount: 0,
      usageId: "abandoned-worker-8-1",
      reason: "provider boundary was not crossed",
    });
    const abandonedProof = qualificationModelAccounting([marker!, abandoned], {
      requireMarkers: true,
    });
    expect(abandonedProof.abandoned).toEqual([abandoned]);
    expect(abandonedProof.unresolved).toEqual(unresolvedModelInvocations([marker!, abandoned]));

    const laterMarker = parseFactoryEvent({ ...marker!, sequence: 3 });
    const earlierExact = parseFactoryEvent({ ...exact!, sequence: 2 });
    expect(
      qualificationModelAccounting([earlierExact, laterMarker], { requireMarkers: true })
        .unresolved,
    ).toEqual(unresolvedModelInvocations([earlierExact, laterMarker]));
  });
  it.each([
    { amount: 1 },
    { usageId: "wrong-abandonment" },
    { reason: undefined },
    { reason: "" },
    { reason: "x".repeat(4001) },
    { reportedModelUsage: { inputTokens: 0, outputTokens: 0 } },
    { usageEvidence: "as-recorded" },
  ])("rejects malformed abandonment evidence with runtime parity: %j", (patch) => {
    const [marker] = fixture();
    const abandonment = {
      ...marker!,
      event: "BudgetAbandoned",
      sequence: 2,
      amount: 0,
      usageId: "abandoned-worker-8-1",
      reason: "provider boundary was not crossed",
      ...patch,
    };
    expect(() =>
      qualificationModelAccounting([marker!, abandonment], { requireMarkers: true }),
    ).toThrow();
    expect(() => parseFactoryEvent(abandonment)).toThrow();
  });
  it("rejects recovery-blocked and terminal-unavailable dispositions for one invocation", () => {
    const [marker] = fixture();
    const blocked = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "attempt",
      event: "AttemptRecoveryBlocked",
      objective: marker!.objective,
      runId: marker!.runId,
      sequence: 2,
      at: "2026-09-07T00:00:01Z",
      workItem: marker!.workItem,
      attempt: marker!.attempt,
      backend: "codex-sdk/local-worktree",
      baseSha: "b".repeat(40),
      directorEpoch: marker!.directorEpoch,
      policyDigest: marker!.policyDigest,
      modelInvocationId: marker!.modelInvocationId,
      producerState: "absent",
      sameAttemptResume: "unavailable",
      terminalEvidence: "unavailable",
      artifactEvidence: "unavailable",
      modelUsageAccounting: "unknown",
      nextDisposition: "explicit-recovery",
    });
    const cancelled = parseFactoryEvent({
      ...blocked,
      event: "AttemptCancelled",
      sequence: 3,
      sameAttemptResume: undefined,
      terminalEvidence: undefined,
      artifactEvidence: undefined,
      modelUsageAccounting: "terminal-unavailable",
      nextDisposition: undefined,
    });
    expect(
      qualificationModelAccounting([marker!, blocked], { requireMarkers: true }).unresolved,
    ).toEqual(unresolvedModelInvocations([marker!, blocked]));
    expect(() =>
      qualificationModelAccounting([marker!, blocked, cancelled], { requireMarkers: true }),
    ).toThrow(/conflicting terminal accounting dispositions/);
    expect(() => unresolvedModelInvocations([marker!, blocked, cancelled])).toThrow(
      /conflicting terminal accounting dispositions/,
    );
  });
  it.each([
    "policyDigest",
    "directorEpoch",
    "workItem",
    "attempt",
    "runId",
    "objective",
    "modelInvocationId",
  ])("rejects changed %s rather than closing another invocation", (field) => {
    const rows = fixture();
    const changed = {
      ...rows[1],
      [field]: ["directorEpoch", "workItem", "attempt", "objective"].includes(field)
        ? 99
        : "different",
    };
    expect(() =>
      qualificationModelAccounting([rows[0]!, changed], { requireMarkers: true }),
    ).toThrow();
  });
  it("deduplicates exact receipt replay but rejects duplicate actual usage and zero-filled intent", () => {
    const rows = fixture();
    expect(qualificationModelAccounting([...rows, ...rows], { requireMarkers: true }).total).toBe(
      37,
    );
    const repeated = qualificationModelAccounting([...rows, { ...rows[1], sequence: 3 }], {
      requireMarkers: true,
    });
    expect(repeated.total).toBe(37);
    expect(repeated.usage).toHaveLength(1);
    expect(() =>
      qualificationModelAccounting([...rows, { ...rows[1], sequence: 3, amount: 38 }], {
        requireMarkers: true,
      }),
    ).toThrow(/conflicting evidence/);
    expect(() =>
      qualificationModelAccounting([{ ...rows[0], amount: 37 }, rows[1]!], {
        requireMarkers: true,
      }),
    ).toThrow();
    const laterMarker = parseFactoryEvent({ ...rows[0]!, sequence: 3 });
    expect(
      qualificationModelAccounting([laterMarker, rows[1]!], {
        requireMarkers: true,
      }).unresolved,
    ).toEqual(unresolvedModelInvocations([laterMarker, rows[1]!]));
  });
  it("requires explicit linkage for fresh policies without rewriting historical receipts", () => {
    const rows = fixture();
    const { modelInvocationId: _id, ...legacy } = rows[1] as Record<string, unknown>;
    expect(qualificationModelAccounting([legacy]).total).toBe(37);
    expect(() => qualificationModelAccounting([legacy], { requireMarkers: true })).toThrow(
      /linkage/,
    );
  });
  it("refuses fabricated actual-shaped markers and counters that production would reject", () => {
    const rows = fixture();
    for (const patch of [
      { usageId: "invocation-worker-8-1", amount: 0 },
      { usageEvidence: "conservative-reservation" },
      { reportedModelUsage: { inputTokens: 30, outputTokens: 8 } },
      { reportedModelUsage: { inputTokens: 30, outputTokens: 7, cachedInputTokens: 31 } },
      { reportedModelUsage: {} },
      { reportedModelUsage: { inputTokens: -1 } },
    ])
      expect(() =>
        qualificationModelAccounting([rows[0]!, { ...rows[1], ...patch }], {
          requireMarkers: true,
        }),
      ).toThrow();
    const unbound = rows.map((row) => ({
      ...row,
      policyDigest: undefined,
      directorEpoch: undefined,
    }));
    expect(() => qualificationModelAccounting(unbound, { requireMarkers: true })).toThrow(
      /binding/,
    );
    // Absence of optional breakdown is not absence of a supplied scalar actual.
    expect(qualificationModelAccounting(rows, { requireMarkers: true }).total).toBe(37);
    const zero = rows.map((row) =>
      row.event === "BudgetReconciled"
        ? { ...row, amount: 0, reportedModelUsage: { inputTokens: 0, outputTokens: 0 } }
        : row,
    );
    expect(qualificationModelAccounting(zero, { requireMarkers: true })).toMatchObject({
      total: 0,
      unresolved: [],
    });
  });
});
