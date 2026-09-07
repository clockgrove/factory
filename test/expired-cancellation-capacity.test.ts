import { describe, expect, it } from "vitest";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { deriveCapacityReservations } from "../src/scheduling/capacity-ledger.js";

const baseSha = "1".repeat(40);
const policyDigest = "2".repeat(64);
const artifactDigest = "3".repeat(64);
const identity = {
  protocol: "clockgrove.factory/v2",
  objective: 105,
  runId: "expired-original-run",
  workItem: 106,
  attempt: 1,
  backend: "codex-app-server/local-worktree",
  directorEpoch: 3,
  policyDigest,
};

function fixture(legacy = false) {
  const reserved = parseFactoryEvent({
    ...identity,
    kind: "attempt",
    event: "AttemptReserved",
    sequence: 2,
    at: "2026-09-07T00:00:02.000Z",
    baseSha,
    admissionClass: "local",
    ...(legacy ? {} : { requestedCpu: 1, requestedMemoryMb: 256 }),
  });
  const succeeded = parseFactoryEvent({
    ...identity,
    kind: "attempt",
    event: "AttemptSucceeded",
    sequence: 3,
    at: "2026-09-07T00:01:00.000Z",
    baseSha,
    artifactDigest,
    reportedModelTokens: 44906,
    reportedModelUsage: { inputTokens: 44071, outputTokens: 835, cachedInputTokens: 28416 },
  });
  const terminal = parseFactoryEvent({
    protocol: identity.protocol,
    objective: identity.objective,
    runId: identity.runId,
    kind: "run",
    event: "FactoryRunCancelled",
    sequence: 5,
    at: "2026-09-07T01:00:00.000Z",
    reason: "operator requested cleanup-only cancellation",
  });
  const closure = (overrides: Record<string, unknown> = {}) =>
    parseFactoryEvent({
      ...identity,
      kind: "capacity",
      event: "CapacityReconciled",
      sequence: 4,
      at: "2026-09-07T00:59:00.000Z",
      phase: "execution",
      recoveryEpoch: 4,
      requestedCpu: legacy ? 2 : 1,
      requestedMemoryMb: legacy ? 2048 : 256,
      reason: "operator cancellation proved exact resource absence",
      ...overrides,
    });
  const derive = (events: FactoryEvent[]) =>
    deriveCapacityReservations([
      {
        objective: identity.objective,
        workItem: identity.workItem,
        events,
        defaultCpu: 2,
        defaultMemoryMb: 2048,
        paths: ["src/result.ts"],
        isLocalBackend: (backend) => backend === identity.backend,
      },
    ]);
  return { reserved, succeeded, terminal, closure, derive };
}

describe("expired cancellation execution-capacity proof", () => {
  it("does not confuse successful retained output or terminal run state with resource closure", () => {
    const f = fixture();
    for (const events of [
      [f.reserved],
      [f.reserved, f.succeeded],
      [f.reserved, f.succeeded, f.terminal],
    ]) {
      expect(f.derive(events)).toMatchObject([
        {
          objective: 105,
          workItem: 106,
          attempt: 1,
          phase: "execution",
          backendId: identity.backend,
          cpu: 1,
          memoryMb: 256,
        },
      ]);
    }
  });

  it.each([3, 4])(
    "releases the exact original obligation at recovery epoch %i without rewriting success",
    (recoveryEpoch) => {
      const f = fixture();
      const closure = f.closure({ recoveryEpoch });
      const events = [f.reserved, f.succeeded, closure, f.terminal];
      const original = structuredClone(events);
      expect(f.derive(events)).toEqual([]);
      expect(f.derive([...events, structuredClone(closure)])).toEqual([]);
      expect(f.derive([...events].reverse())).toEqual([]);
      expect(events).toEqual(original);
      expect(events.filter((event) => event.event === "AttemptSucceeded")).toEqual([f.succeeded]);
      expect(f.succeeded).toMatchObject({ artifactDigest, reportedModelTokens: 44906 });
      expect(events.some((event) => event.event === "AttemptCancelled")).toBe(false);
    },
  );

  it("accepts exact legacy default resources, not new inferred resource values", () => {
    const f = fixture(true);
    expect(f.derive([f.reserved, f.succeeded, f.closure()])).toEqual([]);
    expect(f.derive([f.reserved, f.succeeded, f.closure({ requestedCpu: 1 })])).toHaveLength(1);
    expect(f.derive([f.reserved, f.succeeded, f.closure({ requestedMemoryMb: 256 })])).toHaveLength(
      1,
    );
  });

  it.each([
    ["run", { runId: "different-run" }],
    ["Objective", { objective: 205 }],
    ["Work Item", { workItem: 206 }],
    ["attempt", { attempt: 2 }],
    ["backend", { backend: "codex-sdk/local-worktree" }],
    ["original epoch", { directorEpoch: 2 }],
    ["older recovery epoch", { recoveryEpoch: 2 }],
    ["policy", { policyDigest: "4".repeat(64) }],
    ["phase", { phase: "validation" }],
    ["CPU", { requestedCpu: 2 }],
    ["memory", { requestedMemoryMb: 512 }],
    ["earlier sequence", { sequence: 1 }],
    ["same sequence", { sequence: 2 }],
    ["reservation instead of closure", { event: "CapacityReserved" }],
  ] satisfies [string, Record<string, unknown>][])(
    "retains liability for mismatched %s proof",
    (_label, overrides) => {
      const f = fixture();
      const original = [f.reserved, f.succeeded, f.terminal];
      expect(f.derive([...original, f.closure(overrides)])).toEqual(f.derive(original));
    },
  );

  it.each([
    { requestedCpu: undefined },
    { requestedMemoryMb: undefined },
    { policyDigest: undefined },
    { directorEpoch: undefined },
    { recoveryEpoch: 0 },
    { requestedCpu: 0 },
    { event: "UnknownResourceClosure" },
    { sourceRunId: "other-source-run", targetBaseSha: baseSha },
  ])("does not supply invalid or unknown closure records to derivation (%j)", (overrides) => {
    const f = fixture();
    expect(() => f.closure(overrides)).toThrow();
    expect(f.derive([f.reserved, f.succeeded, f.terminal])).toHaveLength(1);
  });

  it("does not release another original attempt when one exact execution is reconciled", () => {
    const f = fixture();
    const other = parseFactoryEvent({ ...f.reserved, attempt: 2, sequence: 6 });
    expect(f.derive([f.reserved, f.succeeded, other, f.closure()])).toMatchObject([{ attempt: 2 }]);
  });
});
