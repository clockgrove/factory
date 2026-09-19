import { describe, expect, it } from "vitest";
import {
  buildAdmissionSettlementEvidence,
  hasOriginalAdmissionProducerCompletion,
} from "../src/control/admission-settlement.js";
import type { IssueAdmissionEntry } from "../src/control/issue-admission.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { PROTOCOL_V2 } from "../src/protocol/limits.js";
import { objectiveAuthorityObservation, writerAuthority } from "../src/control/authority.js";
import type { LeaseState } from "../src/control/lease.js";
import { MediaInvocationSchema, withMediaDigest } from "../src/media/contracts.js";

const sha = "a".repeat(40),
  digest = "b".repeat(64);
const entry: IssueAdmissionEntry = {
  objective: 1,
  workItem: 2,
  workItemNodeId: "I_2",
  runId: "run",
  directorEpoch: 1,
  writerEpoch: 1,
  writerHolder: "holder",
  currentWriterHolder: "holder",
  policyDigest: digest,
  graphDigest: digest,
  graphCommitOid: sha,
  projectionCommitOid: sha,
  compatibilityClaimOid: sha,
  reservation: { ref: "ref", oid: sha, attempt: 1, backend: "codex-sdk-local", baseSha: sha },
  capacityReservationId: "capacity",
  budgetReservationId: "budget",
  resourceIdentity: "resource",
  disposition: "terminal",
  dispatchPossible: true,
};
const common = {
  protocol: PROTOCOL_V2,
  objective: 1,
  runId: "run",
  workItem: 2,
  attempt: 1,
  at: "2026-09-08T00:00:00Z",
  directorEpoch: 1,
  policyDigest: digest,
};
function attempt(event: string, sequence: number) {
  return parseFactoryEvent({
    ...common,
    kind: "attempt",
    event,
    sequence,
    backend: "codex-sdk-local",
    baseSha: sha,
  });
}
function budget(event: string, sequence: number, extra: object = {}) {
  return parseFactoryEvent({
    ...common,
    kind: "budget",
    event,
    sequence,
    phase: "execution",
    unit: "local_milliseconds",
    amount: 10,
    ...extra,
  });
}
function unknownProviderGate(modelInvocationId: string, sequence: number) {
  return parseFactoryEvent({
    ...common,
    kind: "provider",
    event: "ProviderQuotaBlocked",
    sequence,
    reasonCode: "provider-quota-exhausted",
    provider: "fixture-provider",
    phase: "execution",
    backend: "codex-sdk-local",
    modelInvocationId,
    providerMessage: "fixture provider quota exhausted",
    accounting: "unknown",
  });
}
const events = [
  attempt("AttemptReserved", 1),
  budget("BudgetReserved", 2),
  attempt("AttemptFailed", 3),
  budget("BudgetReconciled", 4),
];
const cleanup = {
  reservationOid: sha,
  resourceIdentity: "resource",
  producerStopped: true as const,
  resourcesReleased: true as const,
  evidenceOid: sha,
};
const capacity = {
  reservationOid: sha,
  capacityReservationId: "capacity",
  released: true as const,
};
function settle(
  observed: FactoryEvent[] = events,
  changes: Partial<Parameters<typeof buildAdmissionSettlementEvidence>[0]> = {},
) {
  return buildAdmissionSettlementEvidence({
    entry,
    events: observed,
    cleanup,
    capacity,
    ...changes,
  });
}

describe("admission settlement evidence", () => {
  it("settles media only after exact usage and successful cleanup", () => {
    const mediaInvocation = MediaInvocationSchema.parse(
      withMediaDigest({
        protocol: "clockgrove.factory/media-invocation-v1" as const,
        repository: "fixture/project",
        objective: 1,
        runId: "run",
        workItem: 2,
        attempt: 1,
        authorityBaseSha: sha,
        reservationRef: "refs/media-attempt",
        intentId: "layout",
        intentRole: "raster-derivative",
        intentPurpose: "implementation-reference",
        intentDigest: digest,
        workerPacketDigest: digest,
        adapterId: "fixture/media",
        adapterVersion: "1",
        capabilityDigest: digest,
        invocationId: "media-2-1",
        model: null,
        quality: null,
        profile: { kind: "raster" as const, width: 2, height: 2, alpha: true, animation: false },
        inputAssets: [],
        outputMediaType: "image/png",
        outputVisibility: "private",
        outputRights: { basis: "unknown" as const },
        deadline: "2026-09-08T01:00:00Z",
        policyDigest: digest,
        requestedVariants: 1,
        activationSelection: { minimumCount: 1, maximumCount: 1 },
        usageReservation: withMediaDigest({
          protocol: "clockgrove.factory/media-usage-reservation-v1" as const,
          providerRequests: 0,
          variants: 1,
          generatedBytes: 1024,
          storageBytes: 1024,
          nativeUnits: ["generated_bytes"],
        }),
        revisionContext: null,
        networkDestinations: [],
        thirdPartyEgress: "denied" as const,
      }),
    );
    const mediaEntry: IssueAdmissionEntry = {
      ...entry,
      reservation: { ...entry.reservation, backend: mediaInvocation.adapterId },
      mediaInvocation,
    };
    const reserved = parseFactoryEvent({
      ...common,
      kind: "attempt",
      event: "AttemptReserved",
      sequence: 1,
      backend: mediaInvocation.adapterId,
      baseSha: sha,
      mediaInvocation,
    });
    const succeeded = parseFactoryEvent({
      ...common,
      kind: "attempt",
      event: "AttemptSucceeded",
      sequence: 5,
      backend: mediaInvocation.adapterId,
      baseSha: sha,
      artifactDigest: digest,
    });
    const media = (event: string, sequence: number, extra: object = {}) =>
      parseFactoryEvent({
        ...common,
        kind: "media",
        event,
        sequence,
        reservationOid: sha,
        invocationDigest: mediaInvocation.digest,
        ...extra,
      });
    const exactAccounting = {
      providerRequests: 0,
      variants: 1,
      generatedBytes: 80,
      storageBytes: 80,
      native: [{ unit: "generated_bytes", amount: 80 }],
    };
    const observed = [
      reserved,
      media("AssetSetReady", 2, { assetSetDigest: digest, assetSetCommitOid: sha }),
      media("MediaUsageSettled", 3, { accounting: exactAccounting }),
      media("MediaCleanupCompleted", 4),
      succeeded,
    ];
    expect(
      buildAdmissionSettlementEvidence({
        entry: mediaEntry,
        events: observed,
        cleanup,
        capacity,
      }),
    ).toMatchObject({ accountingSettled: true });
    const unavailable = observed.map((event) =>
      event.kind === "media" && event.event === "MediaUsageSettled"
        ? media("MediaUsageSettled", 3, {
            accounting: { ...exactAccounting, generatedBytes: null },
          })
        : event,
    );
    expect(() =>
      buildAdmissionSettlementEvidence({
        entry: mediaEntry,
        events: unavailable,
        cleanup,
        capacity,
      }),
    ).toThrow("accounting remains unknown");
    expect(() =>
      buildAdmissionSettlementEvidence({
        entry: mediaEntry,
        events: observed.filter(
          (event) => !(event.kind === "media" && event.event === "MediaCleanupCompleted"),
        ),
        cleanup,
        capacity,
      }),
    ).toThrow("cleanup receipt");
  });

  it("settles only exact known accounting plus positive cleanup/capacity evidence", () => {
    expect(settle()).toMatchObject({
      accountingSettled: true,
      reservationOid: sha,
      budgetReservationId: "budget",
    });
    expect(() => settle(events, { cleanup: { ...cleanup, resourceIdentity: "other" } })).toThrow(
      "exact positive",
    );
    expect(() =>
      settle(events, { capacity: { ...capacity, capacityReservationId: "other" } }),
    ).toThrow("exact positive");
  });
  it("does not turn missing accounting or a terminal event into zero usage", () => {
    expect(() => settle([events[0]!, events[2]!])).toThrow("no native execution budget");
    expect(() => settle(events.slice(0, 3))).toThrow("remains unknown");
    expect(() =>
      settle(
        events.filter((event) => !(event.kind === "attempt" && event.event === "AttemptReserved")),
      ),
    ).toThrow("original reservation");
  });
  it("retains an unresolved worker model dispatch marker even when native budget is settled", () => {
    const marker = budget("BudgetReserved", 5, {
      unit: "model_tokens",
      amount: 0,
      modelInvocationId: "worker",
      usageId: "invocation-worker",
    });
    expect(() => settle([...events, marker])).toThrow("remains unknown");
    const actual = budget("BudgetReconciled", 6, {
      unit: "model_tokens",
      amount: 12,
      modelInvocationId: "worker",
      usageId: "worker-actual",
    });
    expect(
      settle([...events, marker, actual], { modelUsageExpected: true }).accountingSettled,
    ).toBe(true);
  });
  it("releases resource and capacity ownership while retaining authenticated unknown model usage", () => {
    const marker = budget("BudgetReserved", 5, {
      unit: "model_tokens",
      amount: 0,
      modelInvocationId: "worker",
      usageId: "invocation-worker",
    });
    const gate = unknownProviderGate("worker", 6);
    expect(
      settle([...events, marker, gate], {
        modelUsageExpected: true,
        retainedUnknownModelInvocationId: "worker",
      }),
    ).toMatchObject({ accountingSettled: false, unknownModelUsageRetained: true });
    expect(
      settle([...events, marker], {
        modelUsageExpected: true,
        retainedUnknownModelInvocationId: "worker",
      }),
    ).toMatchObject({ accountingSettled: false, unknownModelUsageRetained: true });
    expect(() =>
      settle([...events, marker, gate], {
        modelUsageExpected: true,
        retainedUnknownModelInvocationId: "other",
      }),
    ).toThrow("remains unknown");
  });
  it("requires actual worker usage when the backend reports it", () => {
    expect(() => settle(events, { modelUsageExpected: true })).toThrow("actual worker model usage");
  });
  it("rejects contradictory original accounting identity and outstanding capacity", () => {
    expect(() => settle([...events, budget("BudgetReserved", 5, { directorEpoch: 2 })])).toThrow(
      "contradicts",
    );
    const held = parseFactoryEvent({
      ...common,
      kind: "capacity",
      event: "CapacityReserved",
      sequence: 5,
      phase: "execution",
      backend: "codex-sdk-local",
      requestedCpu: 1,
      requestedMemoryMb: 100,
    });
    expect(() => settle([...events, held])).toThrow("capacity remains reserved");
  });
  it("allows successful execution settlement with exact final cleanup and known accounting", () => {
    expect(
      settle(
        events.map((event) =>
          event.kind === "attempt" && event.event === "AttemptFailed"
            ? attempt("AttemptSucceeded", 3)
            : event,
        ),
      ).resourcesReleased,
    ).toBe(true);
  });
  it("separates original producer identity from the current settlement writer", () => {
    const current = {
      ref: "refs/clockgrove-factory/leases/objective-1",
      oid: "c".repeat(40),
      treeOid: "d".repeat(40),
      objective: 1,
      runId: "run",
      holder: "successor",
      epoch: 2,
      sequence: 5,
      expiresAt: new Date("2026-09-08T00:10:00Z"),
      policyDigest: digest,
    } satisfies LeaseState;
    const authority = objectiveAuthorityObservation(current, new Date("2026-09-08T00:05:00Z"));
    const old = { ...current, holder: "predecessor", epoch: 1 } satisfies LeaseState;
    const stale = parseFactoryEvent({ ...attempt("AttemptFailed", 3), ...writerAuthority(old, 3) });
    const fresh = parseFactoryEvent({
      ...attempt("AttemptFailed", 3),
      ...writerAuthority(current, 3),
    });
    const accounting = [events[0]!, events[1]!, events[3]!];

    expect(() => settle([...accounting, stale], { authority })).toThrow("terminal execution");
    expect(settle([...accounting, fresh], { authority }).accountingSettled).toBe(true);
    expect(fresh).toMatchObject({ directorEpoch: 1, writerEpoch: 2, writerHolder: "successor" });
  });
  it("accepts definitive non-execution only for an unimported prepared identity", () => {
    const definitiveNonExecution = {
      reservationOid: sha,
      evidenceOid: sha,
      dispatchPrevented: true as const,
    };
    expect(
      settle([events[0]!], {
        entry: { ...entry, disposition: "prepared", dispatchPossible: false },
        definitiveNonExecution,
      }).accountingSettled,
    ).toBe(true);
    expect(() => settle([events[0]!], { definitiveNonExecution })).toThrow("never-dispatched");
    expect(() =>
      settle([events[0]!, attempt("AttemptStarted", 2)], {
        entry: { ...entry, disposition: "prepared", dispatchPossible: false },
        definitiveNonExecution,
      }),
    ).toThrow("never-dispatched");
    expect(() =>
      settle([events[0]!], {
        entry: { ...entry, disposition: "prepared", dispatchPossible: false, imported: true },
        definitiveNonExecution,
      }),
    ).toThrow("never-dispatched");
  });
  it("settles only an accepted, non-dispatching retained-artifact consumer", () => {
    const claim = "c".repeat(40);
    const plan = "d".repeat(40);
    const consumerEntry: IssueAdmissionEntry = {
      ...entry,
      runId: "successor",
      reservation: { ...entry.reservation, attempt: 2 },
      budgetReservationId: "successor:2:2:artifact-consumer:none",
      resourceIdentity: JSON.stringify([
        1,
        "successor",
        2,
        2,
        "retained-artifact-consumer",
        "run",
        digest,
      ]),
      disposition: "terminal",
      dispatchPossible: false,
      reassignmentReceiptOid: claim,
      artifactConsumer: {
        sourceRunId: "run",
        sourceReservationOid: sha,
        sourceAttempt: 1,
        artifactDigest: digest,
        recoveryPlanCommitOid: plan,
        recoveryClaimOid: claim,
      },
    };
    const consumerCommon = { ...common, runId: "successor", attempt: 2 };
    const reserved = parseFactoryEvent({
      ...consumerCommon,
      kind: "attempt",
      event: "AttemptReserved",
      sequence: 5,
      backend: entry.reservation.backend,
      baseSha: sha,
    });
    const succeeded = parseFactoryEvent({
      ...consumerCommon,
      kind: "attempt",
      event: "AttemptSucceeded",
      sequence: 6,
      backend: entry.reservation.backend,
      baseSha: sha,
      artifactDigest: digest,
    });
    const definitiveArtifactConsumer = {
      reservationOid: sha,
      evidenceOid: sha,
      dispatchPrevented: true as const,
      sourceRunId: "run",
      sourceReservationOid: sha,
      sourceAttempt: 1,
      artifactDigest: digest,
      recoveryPlanCommitOid: plan,
      recoveryClaimOid: claim,
    };
    const started = parseFactoryEvent({
      ...consumerCommon,
      kind: "attempt",
      event: "AttemptStarted",
      sequence: 7,
      backend: entry.reservation.backend,
      baseSha: sha,
    });
    expect(
      settle([reserved, succeeded], {
        entry: consumerEntry,
        cleanup: { ...cleanup, resourceIdentity: consumerEntry.resourceIdentity },
        definitiveArtifactConsumer,
      }).accountingSettled,
    ).toBe(true);
    expect(() =>
      settle([reserved, succeeded, started], {
        entry: consumerEntry,
        cleanup: { ...cleanup, resourceIdentity: consumerEntry.resourceIdentity },
        definitiveArtifactConsumer,
      }),
    ).toThrow("accepted non-dispatching consumer");
    expect(() =>
      settle([reserved, succeeded], {
        entry: { ...consumerEntry, artifactConsumer: undefined },
        cleanup: { ...cleanup, resourceIdentity: consumerEntry.resourceIdentity },
        definitiveArtifactConsumer,
      }),
    ).toThrow("accepted non-dispatching consumer");
  });
});

describe("original admission producer completion", () => {
  it("accepts only supported original pipeline-end receipts", () => {
    for (const event of [
      "AttemptFailed",
      "AttemptCancelled",
      "AttemptTimedOut",
      "AttemptIntegrated",
    ])
      expect(hasOriginalAdmissionProducerCompletion(entry, [attempt(event, 3)])).toBe(true);
  });
  it("rejects success and intermediate or recovery-only outcomes", () => {
    for (const event of [
      "AttemptSucceeded",
      "AttemptReserved",
      "AttemptStarted",
      "AttemptCollected",
      "AttemptValidated",
      "AttemptPublished",
      "AttemptDeferred",
    ])
      expect(hasOriginalAdmissionProducerCompletion(entry, [attempt(event, 3)])).toBe(false);
  });
  it("rejects recovery-generated closure even when original identity is retained", () => {
    expect(
      hasOriginalAdmissionProducerCompletion(entry, [
        parseFactoryEvent({ ...attempt("AttemptFailed", 3), recoveryEpoch: 2 }),
      ]),
    ).toBe(false);
    expect(
      hasOriginalAdmissionProducerCompletion(entry, [
        parseFactoryEvent({ ...attempt("AttemptIntegrated", 3), writerEpoch: 2 }),
      ]),
    ).toBe(false);
    expect(
      hasOriginalAdmissionProducerCompletion(entry, [
        parseFactoryEvent({ ...attempt("AttemptFailed", 3), writerEpoch: 1 }),
      ]),
    ).toBe(true);
  });
  it("requires every original reservation identity field", () => {
    for (const mismatch of [
      { objective: 9 },
      { runId: "other" },
      { workItem: 9 },
      { attempt: 9 },
      { backend: "other" },
      { baseSha: "c".repeat(40) },
      { policyDigest: "c".repeat(64) },
      { directorEpoch: 9 },
    ])
      expect(
        hasOriginalAdmissionProducerCompletion(entry, [
          parseFactoryEvent({ ...attempt("AttemptFailed", 3), ...mismatch }),
        ]),
      ).toBe(false);
  });
  it("never infers closure from empty evidence or the ledger disposition", () => {
    expect(hasOriginalAdmissionProducerCompletion({ ...entry, disposition: "released" }, [])).toBe(
      false,
    );
    expect(
      hasOriginalAdmissionProducerCompletion({ ...entry, imported: true }, [
        attempt("AttemptDeferred", 3),
      ]),
    ).toBe(false);
  });
});
