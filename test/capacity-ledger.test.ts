import { describe, expect, it } from "vitest";

import {
  CapacityLedger,
  capacityReservationKey,
  deriveCapacityReservations,
  isIntegrationValidationBackend,
  unreconciledCapacityReservations,
  type CapacityLimits,
  type CapacityReservation,
} from "../src/scheduling/capacity-ledger.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { policyDigest, DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = policyDigest(DEFAULT_RUN_POLICY);

function reservation(
  workItem: number,
  options: Partial<CapacityReservation> = {},
): CapacityReservation {
  const identity = {
    objective: options.objective ?? 1,
    workItem,
    attempt: options.attempt ?? 1,
    phase: options.phase ?? ("execution" as const),
    backendId: options.backendId ?? "codex-app-server/local-worktree",
  };
  return {
    key: capacityReservationKey(identity),
    ...identity,
    admissionClass: options.admissionClass ?? "local",
    local: options.local ?? true,
    cpu: options.cpu ?? 1,
    memoryMb: options.memoryMb ?? 2_048,
    paidUnits: options.paidUnits ?? 0,
    paths: options.paths ?? [`src/item-${workItem}/`],
    exclusiveResources: options.exclusiveResources ?? [],
  };
}

const limits: CapacityLimits = {
  maxParallel: 4,
  maxLocalParallel: 3,
  maxCloudParallel: 2,
  backendMaxParallel: {
    "codex-app-server/local-worktree": 3,
    "codex-cli/daytona": 2,
  },
  cpuCapacity: 4,
  memoryCapacityMb: 8_192,
  maxPaidUnits: 2,
};

function attemptEvent(
  event: "AttemptReserved" | "AttemptStarted" | "AttemptCollected" | "AttemptFailed",
  sequence: number,
  extra: Record<string, unknown> = {},
): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event,
    objective: 1,
    runId: "run-1",
    sequence,
    at: `2026-09-04T00:00:0${sequence}.000Z`,
    workItem: 10,
    attempt: 1,
    backend: "codex-app-server/local-worktree",
    baseSha: SHA,
    directorEpoch: 1,
    policyDigest: DIGEST,
    ...extra,
  });
}

describe("repository-wide capacity ledger", () => {
  it("rejects stale generations and concurrent over-reservation", () => {
    const ledger = new CapacityLedger();
    const initial = ledger.reconcile(1, []);
    expect(ledger.tryReserve(initial.generation, reservation(1), limits).reserved).toBe(true);
    expect(ledger.tryReserve(initial.generation, reservation(2), limits)).toMatchObject({
      reserved: false,
      code: "stale-generation",
    });
    const current = ledger.snapshot();
    const constrained = { ...limits, maxParallel: 1 };
    expect(ledger.tryReserve(current.generation, reservation(2), constrained)).toMatchObject({
      reserved: false,
      code: "global-capacity",
    });
  });

  it("transitions execution to validation atomically", () => {
    const ledger = new CapacityLedger();
    ledger.reconcile(1, []);
    const execution = reservation(1);
    const reserved = ledger.tryReserve(1, execution, limits);
    expect(reserved.reserved).toBe(true);
    const validation = reservation(1, {
      phase: "validation",
      backendId: "codex-cli/daytona",
      admissionClass: "remote-required",
      local: false,
      paidUnits: 1,
    });
    const transitioned = ledger.transition(
      ledger.snapshot().generation,
      execution.key,
      validation,
      limits,
    );
    expect(transitioned.reserved).toBe(true);
    expect(ledger.snapshot().reservations).toEqual([validation]);
  });

  it("enforces CPU, memory, backend, path, exclusive, and paid ceilings", () => {
    const checks: Array<[Partial<CapacityReservation>, Partial<CapacityLimits>, string]> = [
      [{ cpu: 5 }, {}, "cpu-capacity"],
      [{ memoryMb: 9_000 }, {}, "memory-capacity"],
      [{}, { backendMaxParallel: { "codex-app-server/local-worktree": 0 } }, "backend-capacity"],
      [{ paths: ["src/shared/file.ts"] }, {}, "path-conflict"],
      [{ exclusiveResources: ["generated-assets"] }, {}, "exclusive-resource-conflict"],
      [
        {
          backendId: "codex-cli/daytona",
          admissionClass: "burst",
          local: false,
          paidUnits: 2,
        },
        { maxPaidUnits: 1 },
        "paid-capacity",
      ],
    ];
    for (const [candidate, overrides, code] of checks) {
      const ledger = new CapacityLedger();
      const seeded = reservation(1, {
        paths: ["src/shared/"],
        exclusiveResources: ["generated-assets"],
      });
      ledger.reconcile(1, candidate.paths || candidate.exclusiveResources ? [seeded] : []);
      expect(
        ledger.tryReserve(ledger.snapshot().generation, reservation(2, candidate), {
          ...limits,
          ...overrides,
        }),
      ).toMatchObject({ reserved: false, code });
    }
  });

  it("separates repository capacity from per-Objective run ceilings", () => {
    const ledger = new CapacityLedger();
    ledger.reconcile(1, [reservation(1, { objective: 1 })]);
    const objectiveLimits: CapacityLimits = {
      ...limits,
      maxParallel: 4,
      maxLocalParallel: 4,
      objectiveMaxParallel: { objective: 2, max: 1 },
      objectiveLocalMax: { objective: 2, max: 1 },
      objectiveBackendMaxParallel: {
        objective: 2,
        limits: { "codex-app-server/local-worktree": 1 },
      },
    };
    expect(
      ledger.tryReserve(
        ledger.snapshot().generation,
        reservation(2, { objective: 2 }),
        objectiveLimits,
      ).reserved,
    ).toBe(true);
    expect(
      ledger.tryReserve(
        ledger.snapshot().generation,
        reservation(3, { objective: 2 }),
        objectiveLimits,
      ),
    ).toMatchObject({ reserved: false, code: "global-capacity" });
    expect(ledger.snapshot()).toMatchObject({ active: 2, local: 2 });
  });

  it("reconstructs active reservations and releases terminal work exactly once", () => {
    const active = deriveCapacityReservations([
      {
        objective: 1,
        workItem: 10,
        events: [
          attemptEvent("AttemptReserved", 1, {
            admissionClass: "local",
            requestedCpu: 2,
            requestedMemoryMb: 4_096,
          }),
          attemptEvent("AttemptStarted", 2),
        ],
        defaultCpu: 1,
        defaultMemoryMb: 2_048,
        paths: ["src/engine/"],
      },
    ]);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ cpu: 2, memoryMb: 4_096, local: true });

    const restarted = new CapacityLedger();
    restarted.reconcile(7, active);
    expect(restarted.snapshot()).toMatchObject({ active: 1, cpu: 2, memoryMb: 4_096 });
    expect(restarted.release(active[0]!.key)).toBe(true);
    expect(restarted.release(active[0]!.key)).toBe(false);
    expect(restarted.snapshot().active).toBe(0);

    const collected = deriveCapacityReservations([
      {
        objective: 1,
        workItem: 10,
        events: [attemptEvent("AttemptReserved", 1), attemptEvent("AttemptCollected", 2)],
        defaultCpu: 1,
        defaultMemoryMb: 2_048,
      },
    ]);
    expect(collected).toHaveLength(1);
    const terminal = deriveCapacityReservations([
      {
        objective: 1,
        workItem: 10,
        events: [attemptEvent("AttemptReserved", 1), attemptEvent("AttemptFailed", 2)],
        defaultCpu: 1,
        defaultMemoryMb: 2_048,
      },
    ]);
    expect(terminal).toEqual([]);
  });

  it("reconstructs validation capacity until its idempotent reconciliation", () => {
    const capacity = (event: "CapacityReserved" | "CapacityReconciled", sequence: number) =>
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "capacity",
        event,
        objective: 1,
        runId: "run-1",
        sequence,
        at: `2026-09-04T00:00:0${sequence}.000Z`,
        workItem: 10,
        attempt: 1,
        phase: "validation",
        backend: "codex-cli/daytona",
        requestedCpu: 1,
        requestedMemoryMb: 2_048,
        directorEpoch: 1,
        policyDigest: DIGEST,
      });
    const input = (events: FactoryEvent[]) => ({
      objective: 1,
      workItem: 10,
      events,
      defaultCpu: 1,
      defaultMemoryMb: 2_048,
    });
    expect(deriveCapacityReservations([input([capacity("CapacityReserved", 1)])])).toHaveLength(1);
    expect(
      deriveCapacityReservations([
        input([attemptEvent("AttemptReserved", 1), capacity("CapacityReserved", 2)]),
      ]),
    ).toMatchObject([{ phase: "validation", backendId: "codex-cli/daytona" }]);
    expect(
      deriveCapacityReservations([
        input([
          capacity("CapacityReserved", 1),
          capacity("CapacityReconciled", 2),
          capacity("CapacityReconciled", 2),
        ]),
      ]),
    ).toEqual([]);
    expect(
      unreconciledCapacityReservations([
        capacity("CapacityReserved", 1),
        capacity("CapacityReconciled", 2),
      ]),
    ).toEqual([]);
    expect(
      unreconciledCapacityReservations([
        capacity("CapacityReserved", 1),
        capacity("CapacityReconciled", 2),
        capacity("CapacityReserved", 3),
      ]),
    ).toMatchObject([{ event: "CapacityReserved", sequence: 3 }]);
  });

  it.each([
    "AttemptFailed",
    "AttemptTimedOut",
    "AttemptCancelled",
    "AttemptDeferred",
    "AttemptIntegrated",
  ])(
    "keeps integration validation local and reserved despite source %s and passing validation",
    (terminal) => {
      const backend = `factory/integration-validation-${"a".repeat(64)}`;
      const capacity = (
        event: "CapacityReserved" | "CapacityReconciled",
        sequence: number,
        id = backend,
      ) =>
        parseFactoryEvent({
          protocol: "clockgrove.factory/v2",
          kind: "capacity",
          event,
          objective: 1,
          runId: "run-1",
          sequence,
          at: "2026-09-05T00:00:00Z",
          workItem: 10,
          attempt: 1,
          phase: "validation",
          backend: id,
          requestedCpu: 2,
          requestedMemoryMb: 4096,
          directorEpoch: 1,
          policyDigest: DIGEST,
        });
      const validation = parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "validation",
        event: "ValidationRecorded",
        objective: 1,
        runId: "run-1",
        sequence: 2,
        at: "2026-09-05T00:00:00Z",
        workItem: 10,
        attempt: 1,
        baseSha: SHA,
        outputTreeSha: SHA,
        artifactDigest: "a".repeat(64),
        evidenceDigest: "b".repeat(64),
        passed: true,
        policyDigest: DIGEST,
      });
      const original = [
        attemptEvent("AttemptReserved", 1),
        validation,
        attemptEvent("AttemptFailed", 3, { event: terminal }),
        capacity("CapacityReserved", 4),
      ];
      const derive = (events: FactoryEvent[]) =>
        deriveCapacityReservations([
          {
            objective: 1,
            workItem: 10,
            events,
            defaultCpu: 1,
            defaultMemoryMb: 2048,
            isLocalBackend: () => false,
          },
        ]);
      expect(derive(original)).toMatchObject([
        {
          backendId: backend,
          local: true,
          paidUnits: 0,
          admissionClass: "local",
          cpu: 2,
          memoryMb: 4096,
        },
      ]);
      expect(
        derive([
          ...original,
          capacity("CapacityReconciled", 5, `factory/integration-validation-${"b".repeat(64)}`),
        ]),
      ).toHaveLength(1);
      expect(derive([...original, capacity("CapacityReconciled", 5)])).toEqual([]);
      expect(
        derive([...original, capacity("CapacityReconciled", 5), capacity("CapacityReserved", 6)]),
      ).toHaveLength(1);
    },
  );

  it.each([
    "factory/local-validation",
    "factory/integration-validation-a",
    `factory/integration-validation-${"A".repeat(64)}`,
    `factory/integration-validation-${"a".repeat(64)}-extra`,
  ])("does not classify malformed or ordinary backend %s as integration validation", (backend) => {
    expect(isIntegrationValidationBackend(backend)).toBe(false);
  });
});
