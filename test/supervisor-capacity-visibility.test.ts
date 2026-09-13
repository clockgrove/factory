import { expect, it, vi } from "vitest";

import {
  SharedCapacitySnapshotLagError,
  sharedCapacityClaimId,
  type SharedCapacityOwner,
} from "../src/controller/shared-capacity.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import {
  CapacityLedger,
  type CapacityLimits,
  type CapacityReservation,
  type OwnedCapacityReservation,
} from "../src/scheduling/capacity-ledger.js";
import type { ObjectiveSnapshot } from "../src/types.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;

function appendRetainedAttempt(fixture: Fixture): void {
  const item = fixture.snapshot.workItems[0]!;
  item.factoryEvents!.push(
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "attempt",
      event: "AttemptReserved",
      objective: fixture.snapshot.number,
      runId: fixture.runId,
      sequence: Math.max(...fixture.events().map((event) => event.sequence)) + 1,
      at: new Date().toISOString(),
      workItem: item.number,
      attempt: 1,
      backend: "codex-app-server/local-worktree",
      baseSha: fixture.baseSha,
      directorEpoch: 1,
      policyDigest: fixture.lease.policyDigest,
      admissionClass: "local",
      requestedCpu: 1,
      requestedMemoryMb: 2_048,
    }),
  );
}

function installLaggingSharedCapacity(
  fixture: Fixture,
  targetWorkItem?: number,
  targetPhase: CapacityReservation["phase"] = "validation",
  holdPhasePublication = false,
  foreignClaim = false,
) {
  const ledger = new CapacityLedger();
  const owned = new Map<string, OwnedCapacityReservation>();
  const released = new Set<string>();
  let staleRead: ObjectiveSnapshot | undefined;
  let lagCount = 0;
  let laggedReservation: CapacityReservation | undefined;
  let servedLag = holdPhasePublication;
  let releasePublication = () => {};
  const publication = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let publicationHeld = false;
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  if (holdPhasePublication) {
    const addComment = vi.mocked(GitHubControlStore.prototype.addIssueComment);
    const ordinaryComment = addComment.getMockImplementation()!;
    addComment.mockImplementation(async (node, body) => {
      if (
        decodeEventComments(body).some(
          (event) =>
            event.kind === "capacity" &&
            event.event === "CapacityReserved" &&
            event.phase === "validation" &&
            event.workItem === targetWorkItem,
        )
      ) {
        publicationHeld = true;
        // Teardown escape for a broken Supervisor that drains before a fourth read.
        safetyTimer = setTimeout(releasePublication, 5_000);
        await publication;
        clearTimeout(safetyTimer);
      }
      return ordinaryComment(node, body);
    });
  }
  const readObjective = vi.mocked(GitHubReader.prototype.readObjective);
  const ordinaryRead = readObjective.getMockImplementation();
  if (!ordinaryRead) throw new Error("provider fixture did not install its Objective reader");
  readObjective.mockImplementation(async (number) => {
    if (staleRead) {
      // Concurrent child reads must not consume the fault before the scheduler
      // observes it. Visibility converges when reconstruction detects the lag.
      return structuredClone(staleRead);
    }
    return ordinaryRead(number);
  });

  fixture.repositoryResources.sharedCapacity = {
    snapshot: async () => ledger.snapshot(),
    reconcile: async (
      _owner: SharedCapacityOwner,
      imports: readonly OwnedCapacityReservation[],
    ) => {
      const lag = imports
        .filter(({ reservation }) => released.has(reservation.key))
        .map(({ owner, reservation }) => ({
          claimId: sharedCapacityClaimId(
            foreignClaim ? { ...owner, directorEpoch: owner.directorEpoch + 1 } : owner,
            reservation.key,
          ),
          key: reservation.key,
          provenance: "journal" as const,
        }));
      if (lag.length > 0) {
        lagCount += 1;
        if (holdPhasePublication && publicationHeld && lagCount >= 4) releasePublication();
        staleRead = undefined;
        throw new SharedCapacitySnapshotLagError(lag);
      }
      ledger.reconcileObjective(
        fixture.snapshot.number,
        imports.map(({ reservation }) => reservation),
      );
      for (const imported of imports) owned.set(imported.reservation.key, imported);
      return imports;
    },
    reserve: async (
      owner: SharedCapacityOwner,
      reservation: CapacityReservation,
      limits: CapacityLimits,
    ) => {
      if (released.has(reservation.key))
        return { reserved: false as const, code: "released-reservation" as const };
      const result = ledger.tryReserve(ledger.snapshot().generation, reservation, limits);
      if (result.reserved) owned.set(reservation.key, { owner, reservation });
      return result.reserved
        ? { reserved: true as const, claimId: reservation.key }
        : { reserved: false as const, code: result.code };
    },
    transition: async (
      owner: SharedCapacityOwner,
      fromKey: string,
      reservation: CapacityReservation,
      limits: CapacityLimits,
    ) => {
      const result = ledger.transition(ledger.snapshot().generation, fromKey, reservation, limits);
      if (result.reserved) {
        released.add(fromKey);
        owned.delete(fromKey);
        owned.set(reservation.key, { owner, reservation });
      }
      return result.reserved
        ? { reserved: true as const, claimId: reservation.key }
        : { reserved: false as const, code: result.code };
    },
    release: async (_owner: SharedCapacityOwner, key: string) => {
      const releasedReservation = owned.get(key)?.reservation;
      ledger.release(key);
      owned.delete(key);
      released.add(key);
      if (
        !servedLag &&
        releasedReservation?.phase === targetPhase &&
        (targetWorkItem === undefined || releasedReservation?.workItem === targetWorkItem) &&
        releasedReservation
      ) {
        servedLag = true;
        laggedReservation = releasedReservation;
        staleRead = structuredClone(fixture.snapshot);
        const item = staleRead.workItems.find(
          (candidate) => candidate.number === releasedReservation.workItem,
        );
        if (!item) throw new Error("lag fixture could not find the released Work Item");
        const validationReservation = item.factoryEvents!.find(
          (event) =>
            releasedReservation.phase === "validation" &&
            event.kind === "capacity" &&
            event.event === "CapacityReserved" &&
            event.attempt === releasedReservation.attempt &&
            event.phase === "validation" &&
            event.backend === releasedReservation.backendId,
        );
        item.factoryEvents = item.factoryEvents!.filter((event) => {
          if (
            releasedReservation.phase === "validation" &&
            validationReservation &&
            event.sequence > validationReservation.sequence
          )
            return false;
          if (
            releasedReservation.phase === "execution" &&
            event.kind === "attempt" &&
            event.attempt === releasedReservation.attempt &&
            [
              "AttemptFailed",
              "AttemptTimedOut",
              "AttemptCancelled",
              "AttemptDeferred",
              "AttemptIntegrated",
            ].includes(event.event)
          )
            return false;
          return true;
        });
      }
    },
  } as unknown as NonNullable<typeof fixture.repositoryResources.sharedCapacity>;

  return {
    releasePublication,
    lagCount: () => lagCount,
    laggedWorkItem: () => laggedReservation?.workItem,
    laggedPhase: () => laggedReservation?.phase,
    outstanding: () => ledger.snapshot().reservations,
  };
}

it.each(["regular", "native-isolated"] as const)(
  "reserves and settles %s candidate validation through the shared controller ledger",
  async (delivery) => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      controllerActivation: true,
      ...(delivery === "regular"
        ? { localOnly: true, independentRoots: true }
        : { nativeStack: true }),
    });
    // Separate ledgers expose accidental process-local admission followed by a
    // shared release; the same-ledger foreground fixture cannot detect that leak.
    const capacity = installLaggingSharedCapacity(fixture, -1);
    if (delivery === "regular") {
      expect(fixture.policy.maxParallel).toBe(1);
      const readPull = vi.mocked(GitHubControlStore.prototype.readPullRequest);
      const original = readPull.getMockImplementation()!;
      readPull.mockImplementation(async (number) => {
        const pull = await original(number);
        // Publish all independent roots against their original base before
        // merging any, so the later two need successive candidate validation.
        return fixture.snapshot.workItems.every((item) => item.linkedPullRequests.length > 0)
          ? pull
          : { ...pull, mergeable: null };
      });
    }
    vi.spyOn(fixture.repositoryResources.capacityLedger, "tryReserve").mockImplementation(() => {
      throw new Error("validation bypassed the repository shared-capacity owner");
    });
    const shared = fixture.repositoryResources.sharedCapacity!;
    const reserve = vi.spyOn(shared, "reserve");
    const release = shared.release.bind(shared);
    const settled: string[] = [];
    vi.spyOn(shared, "release").mockImplementation(async (owner, key, originalOwner) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await release(owner, key, originalOwner);
      settled.push(key);
    });
    try {
      const result = await fixture.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      const candidates = reserve.mock.calls
        .map(([, reservation]) => reservation)
        .filter((reservation) => reservation.backendId.startsWith("factory/integration-"));
      expect(candidates.length).toBeGreaterThanOrEqual(delivery === "regular" ? 2 : 1);
      for (const candidate of candidates) expect(settled).toContain(candidate.key);
      expect(capacity.outstanding()).toEqual([]);
      expect(fixture.repositoryResources.capacityLedger.snapshot().reservations).toEqual([]);
      expect(fixture.resources.size).toBe(0);
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);

it("retains shared execution capacity through an artifact hold until exact recovery closes it", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
  });
  // Exercise the journal's permanent released-claim fence without injecting
  // snapshot lag: a premature release must make the continuation fail.
  const capacity = installLaggingSharedCapacity(fixture, -1);
  const createRef = vi.mocked(GitHubControlStore.prototype.createRef);
  const original = createRef.getMockImplementation()!;
  createRef.mockImplementation(async (ref, oid) => {
    if (ref.includes("/artifact-transfers/") && ref.endsWith("/ready"))
      throw new Error("fixture: ready publication unavailable");
    return original(ref, oid);
  });
  try {
    await expect(fixture.run()).rejects.toThrow(/artifact transfer recovery/);
    expect(capacity.outstanding()).toMatchObject([{ workItem: 8, phase: "execution" }]);
    expect(fixture.resources.size).toBe(0);
    expect(fixture.events().some((event) => event.event === "FactoryRunCompleted")).toBe(false);
    createRef.mockImplementation(original);
    await expect(fixture.run()).resolves.toMatchObject({ status: "completed" });
    // Phase-transition wakes can observe the released execution claim before its
    // validation receipt is visible, even without injected stale responses.
    expect(capacity.lagCount()).toBeLessThanOrEqual(
      fixture
        .events()
        .filter(
          (event) =>
            event.kind === "capacity" &&
            event.event === "CapacityReserved" &&
            event.phase === "validation",
        ).length,
    );
    expect(capacity.outstanding()).toEqual([]);
    expect(
      fixture.activity.filter((entry) => entry.operation === "launch" && entry.workItem === 8),
    ).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it.each([
  {
    name: "failed validation",
    validationFailure: true,
    status: "escalated",
    maxParallel: 1 as const,
  },
  {
    name: "successful validation and publication",
    validationFailure: false,
    status: "completed",
    maxParallel: 1 as const,
  },
  {
    name: "concurrent successful pipelines",
    validationFailure: false,
    status: "completed",
    maxParallel: 2 as const,
  },
])(
  "refreshes the complete observation after transient capacity lag during $name",
  async ({ validationFailure, status, maxParallel }) => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      dependencyChain: maxParallel === 1,
      maxParallel,
      isolatedValidationWorkItem: 8,
      ...(validationFailure ? { validationFailure: true } : {}),
    });
    const lag = installLaggingSharedCapacity(fixture, 8);
    try {
      const result = await fixture.run();
      expect(result.status, result.reason).toBe(status);
      const reservationComments = vi
        .mocked(GitHubControlStore.prototype.addIssueComment)
        .mock.calls.map(([, body]) => decodeEventComments(body))
        .filter((events) =>
          events.some(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReserved" &&
              event.workItem === 8 &&
              event.phase === "validation" &&
              !event.modelInvocationId,
          ),
        );
      const pairedReservations = reservationComments.filter((events) =>
        events.some(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReserved" &&
            event.phase === "execution" &&
            !event.modelInvocationId,
        ),
      );
      expect(pairedReservations).toHaveLength(1);
      expect(pairedReservations[0]).toEqual([
        expect.objectContaining({
          kind: "budget",
          event: "BudgetReserved",
          workItem: 8,
          phase: "execution",
        }),
        expect.objectContaining({
          kind: "budget",
          event: "BudgetReserved",
          workItem: 8,
          phase: "validation",
        }),
      ]);
      // The injected release lag plus each execution-to-validation wake can expose
      // a still-publishing receipt. All are bounded by actual capacity events.
      expect(lag.lagCount()).toBeGreaterThanOrEqual(1);
      expect(lag.lagCount()).toBeLessThanOrEqual(
        1 +
          fixture
            .events()
            .filter(
              (event) =>
                event.kind === "capacity" &&
                event.event === "CapacityReserved" &&
                event.phase === "validation",
            ).length,
      );
      const laggedWorkItem = lag.laggedWorkItem();
      expect(laggedWorkItem).toBeDefined();
      expect(lag.laggedPhase()).toBe("validation");
      const launches = fixture.activity.filter((entry) => entry.operation === "launch");
      expect(new Set(launches.map((entry) => entry.workItem)).size).toBe(launches.length);
      expect(launches.filter((entry) => entry.workItem === laggedWorkItem)).toHaveLength(1);
      const itemEvents = fixture
        .events()
        .filter((event) => "workItem" in event && event.workItem === laggedWorkItem);
      expect(
        itemEvents.filter(
          (event) => event.kind === "validation" && event.event === "ValidationRecorded",
        ),
      ).toHaveLength(1);
      expect(
        itemEvents.filter(
          (event) =>
            event.kind === "capacity" &&
            event.phase === "validation" &&
            !event.backend.startsWith("factory/integration-") &&
            event.event === "CapacityReserved",
        ),
      ).toHaveLength(1);
      expect(
        itemEvents.filter(
          (event) =>
            event.kind === "capacity" &&
            event.phase === "validation" &&
            !event.backend.startsWith("factory/integration-") &&
            event.event === "CapacityReconciled",
        ),
      ).toHaveLength(1);
      expect(
        itemEvents.filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.phase === "validation" &&
            !event.usageId &&
            event.unit === "validation_milliseconds",
        ),
      ).toHaveLength(1);
      expect(
        fixture.activity.filter(
          (entry) => entry.operation === "review" && entry.workItem === laggedWorkItem,
        ),
      ).toHaveLength(validationFailure ? 0 : 1);
      const candidateReviews = fixture.activity.filter(
        (entry) => entry.operation === "candidate-review" && entry.workItem === laggedWorkItem,
      );
      expect(candidateReviews.length).toBeLessThanOrEqual(maxParallel === 1 ? 0 : 1);
      expect(
        itemEvents.filter(
          (event) => event.kind === "publication" && event.event === "PublicationRecorded",
        ),
      ).toHaveLength(validationFailure ? 0 : 1);
      expect(
        itemEvents.filter(
          (event) => event.kind === "attempt" && event.event === "AttemptIntegrated",
        ),
      ).toHaveLength(validationFailure ? 0 : 1);
      const failed = itemEvents.filter(
        (event) =>
          event.kind === "attempt" &&
          (event.event === "AttemptFailed" || event.event === "AttemptCancelled"),
      );
      expect(failed).toHaveLength(validationFailure ? 1 : 0);
      if (validationFailure)
        expect(failed[0]).toMatchObject({ reason: "simulated isolated validation failure" });
      else expect(launches.some((entry) => entry.workItem !== laggedWorkItem)).toBe(true);
      expect(lag.outstanding()).toEqual([]);
      expect(
        fixture
          .events()
          .filter(
            (event) =>
              event.kind === "run" &&
              ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
                event.event,
              ),
          ),
      ).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  },
  30_000,
);

it("vetoes terminal mutation after the bounded observations remain stale", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", { localOnly: true });
  appendRetainedAttempt(fixture);
  let observations = 0;
  fixture.repositoryResources.sharedCapacity = {
    snapshot: async () => ({ generation: 1, reservations: [] }),
    reconcile: async (
      _owner: SharedCapacityOwner,
      imports: readonly OwnedCapacityReservation[],
    ) => {
      observations += 1;
      const reservation = imports[0]!.reservation;
      throw new SharedCapacitySnapshotLagError([
        { claimId: "a".repeat(64), key: reservation.key, provenance: "journal" },
      ]);
    },
  } as unknown as NonNullable<typeof fixture.repositoryResources.sharedCapacity>;
  try {
    await expect(fixture.run()).rejects.toBeInstanceOf(SharedCapacitySnapshotLagError);
    expect(observations).toBe(3);
    expect(fixture.activity).toEqual([]);
    expect(fixture.snapshot.closed).toBe(false);
    expect(
      fixture
        .events()
        .filter(
          (event) =>
            event.kind === "run" &&
            ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
              event.event,
            ),
        ),
    ).toEqual([]);
  } finally {
    await fixture.dispose().catch(() => {});
  }
}, 20_000);

it("keeps cancellation nonterminal when it arrives during the visibility barrier", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    controllerActivation: true,
  });
  appendRetainedAttempt(fixture);
  const stop = new AbortController();
  let observations = 0;
  fixture.repositoryResources.sharedCapacity = {
    snapshot: async () => ({ generation: 1, reservations: [] }),
    reconcile: async (
      _owner: SharedCapacityOwner,
      imports: readonly OwnedCapacityReservation[],
    ) => {
      observations += 1;
      stop.abort(new Error("fixture cancellation during capacity visibility barrier"));
      throw new SharedCapacitySnapshotLagError([
        {
          claimId: "a".repeat(64),
          key: imports[0]!.reservation.key,
          provenance: "journal",
        },
      ]);
    },
  } as unknown as NonNullable<typeof fixture.repositoryResources.sharedCapacity>;
  try {
    await expect(fixture.run(stop.signal)).rejects.toBeInstanceOf(SharedCapacitySnapshotLagError);
    expect(observations).toBe(1);
    expect(fixture.snapshot.closed).toBe(false);
    expect(
      fixture
        .events()
        .filter(
          (event) =>
            event.kind === "run" &&
            ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
              event.event,
            ),
        ),
    ).toEqual([]);
  } finally {
    await fixture.dispose().catch(() => {});
  }
}, 20_000);

it("keeps an expired Objective nonterminal while released capacity remains ambiguous", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", { localOnly: true });
  appendRetainedAttempt(fixture);
  let observations = 0;
  fixture.repositoryResources.sharedCapacity = {
    snapshot: async () => ({ generation: 1, reservations: [] }),
    reconcile: async (
      _owner: SharedCapacityOwner,
      imports: readonly OwnedCapacityReservation[],
    ) => {
      observations += 1;
      throw new SharedCapacitySnapshotLagError([
        {
          claimId: "a".repeat(64),
          key: imports[0]!.reservation.key,
          provenance: "journal",
        },
      ]);
    },
  } as unknown as NonNullable<typeof fixture.repositoryResources.sharedCapacity>;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000);
  try {
    await expect(fixture.run()).rejects.toBeInstanceOf(SharedCapacitySnapshotLagError);
    expect(observations).toBe(1);
    expect(fixture.snapshot.closed).toBe(false);
    expect(
      fixture
        .events()
        .filter(
          (event) =>
            event.kind === "run" &&
            ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
              event.event,
            ),
        ),
    ).toEqual([]);
  } finally {
    vi.useRealTimers();
    await fixture.dispose().catch(() => {});
  }
}, 20_000);

it("waits for an admitted child's phase receipt beyond the visibility retry bound", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", {
    maxParallel: 2,
    isolatedValidationWorkItem: 8,
  });
  const lag = installLaggingSharedCapacity(fixture, 8, "execution", true);
  try {
    const result = await fixture.run();
    expect(result.status, result.reason).toBe("completed");
    expect(lag.lagCount()).toBeGreaterThanOrEqual(4);
    const launches = fixture.activity.filter((entry) => entry.operation === "launch");
    expect(launches).toHaveLength(fixture.snapshot.workItems.length);
    expect(new Set(launches.map((entry) => entry.workItem)).size).toBe(launches.length);
    expect(fixture.events().filter((event) => event.event === "AttemptCancelled")).toEqual([]);
    expect(fixture.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(
      launches.length,
    );
    expect(fixture.events().filter((event) => event.event === "FactoryRunCompleted")).toHaveLength(
      1,
    );
    expect(lag.outstanding()).toEqual([]);
  } finally {
    lag.releasePublication();
    await fixture.dispose();
  }
}, 30_000);

it("does not treat another owner's claim as a live child's phase publication", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", {
    maxParallel: 2,
    isolatedValidationWorkItem: 8,
  });
  const lag = installLaggingSharedCapacity(fixture, 8, "execution", true, true);
  try {
    await expect(fixture.run()).rejects.toBeInstanceOf(SharedCapacitySnapshotLagError);
    expect(lag.lagCount()).toBe(3);
    expect(fixture.events().some((event) => event.event === "FactoryRunCompleted")).toBe(false);
  } finally {
    lag.releasePublication();
    await fixture.dispose();
  }
}, 30_000);

it.each(["before", "rejected", "accepted-response-lost"] as const)(
  "retains reservation batch liabilities without launching after %s",
  async (failure) => {
    const f = await providerSupervisorFixture("daytona-burst", {
      dependencyChain: true,
      maxParallel: 1,
      isolatedValidationWorkItem: 8,
      maxAttemptsPerItem: 1,
    });
    const addComment = vi.mocked(GitHubControlStore.prototype.addIssueComment);
    const original = addComment.getMockImplementation()!;
    let injected = 0;
    addComment.mockImplementation(async (node, body, mutationClass) => {
      const events = decodeEventComments(body);
      if (
        events.length === 2 &&
        events.every(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReserved" &&
            event.workItem === 8 &&
            !event.modelInvocationId,
        )
      ) {
        injected++;
        if (failure === "accepted-response-lost") await original(node, body, mutationClass);
        throw Object.assign(
          new Error(`reservation batch ${failure}`),
          failure === "rejected" ? { status: 403 } : {},
        );
      }
      return original(node, body, mutationClass);
    });
    try {
      await f.run().catch(() => undefined);
      expect(injected).toBe(1);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(0);
      const reservations = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReserved" &&
            event.workItem === 8 &&
            !event.modelInvocationId,
        );
      expect(reservations).toHaveLength(failure === "accepted-response-lost" ? 2 : 0);
      if (failure === "accepted-response-lost") {
        expect(reservations).toEqual([
          expect.objectContaining({ phase: "execution", amount: expect.any(Number) }),
          expect.objectContaining({ phase: "validation", amount: expect.any(Number) }),
        ]);
        expect(reservations.every((event) => event.kind === "budget" && event.amount > 0)).toBe(
          true,
        );
        expect(
          f
            .events()
            .filter(
              (event) =>
                event.kind === "budget" &&
                event.event === "BudgetReconciled" &&
                event.workItem === 8 &&
                !event.modelInvocationId,
            ),
        ).toHaveLength(0);
      }
    } finally {
      await f.dispose();
      vi.restoreAllMocks();
    }
  },
  20_000,
);

it.each(["before", "rejected", "accepted-response-lost"] as const)(
  "preserves the acknowledged reservations across cleanup batch %s",
  async (failure) => {
    const f = await providerSupervisorFixture("daytona-burst", {
      dependencyChain: true,
      maxParallel: 1,
      isolatedValidationWorkItem: 8,
      maxAttemptsPerItem: 1,
    });
    let failDispatchObservation = false;
    const read = vi.mocked(GitHubControlStore.prototype.readRef);
    const originalRead = read.getMockImplementation()!;
    read.mockImplementation(async (...args) => {
      if (failDispatchObservation && args[0].startsWith("refs/heads/")) {
        failDispatchObservation = false;
        throw new Error("scripted failure before backend dispatch");
      }
      return originalRead(...args);
    });
    const addComment = vi.mocked(GitHubControlStore.prototype.addIssueComment);
    const original = addComment.getMockImplementation()!;
    let injected = 0;
    addComment.mockImplementation(async (node, body, mutationClass) => {
      const events = decodeEventComments(body);
      const compatiblePair =
        events.length === 2 &&
        events.every(
          (event) => event.kind === "budget" && event.workItem === 8 && !event.modelInvocationId,
        );
      if (compatiblePair && events.every((event) => event.event === "BudgetReconciled")) {
        injected++;
        if (failure === "accepted-response-lost") await original(node, body, mutationClass);
        throw Object.assign(
          new Error(`cleanup batch ${failure}`),
          failure === "rejected" ? { status: 403 } : {},
        );
      }
      const result = await original(node, body, mutationClass);
      if (compatiblePair && events.every((event) => event.event === "BudgetReserved"))
        failDispatchObservation = true;
      return result;
    });
    try {
      await f.run().catch(() => undefined);
      expect(injected).toBe(1);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(0);
      const nativeBudget = f
        .events()
        .filter(
          (event) => event.kind === "budget" && event.workItem === 8 && !event.modelInvocationId,
        );
      expect(nativeBudget.filter((event) => event.event === "BudgetReserved")).toHaveLength(2);
      const reconciled = nativeBudget.filter((event) => event.event === "BudgetReconciled");
      expect(reconciled).toHaveLength(failure === "accepted-response-lost" ? 2 : 0);
      // No launch was attempted, so these two acknowledged results are exact zero;
      // failed/ambiguous publication never synthesizes an additional receipt.
      expect(reconciled.every((event) => event.kind === "budget" && event.amount === 0)).toBe(true);
    } finally {
      await f.dispose();
      vi.restoreAllMocks();
    }
  },
  20_000,
);
