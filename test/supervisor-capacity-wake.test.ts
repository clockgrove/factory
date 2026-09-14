import { expect, it, vi } from "vitest";
import { ContinuousExecutionPool } from "../src/scheduling/continuous-refill.js";
import { waitForProgress } from "../src/scheduling/progress-wake.js";
import * as validation from "../src/validation/clean-run.js";
import { CapacityLedger, capacityReservationKey } from "../src/scheduling/capacity-ledger.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it.each([false, true])(
  "retries blocked validation on capacity release; release-before-listener=%s",
  async (duringAdmission) => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    const shutdown = new AbortController();
    const ledger = f.repositoryResources.capacityLedger;
    const original = ledger.transition.bind(ledger);
    let rejectedAt = 0;
    let admittedAt = 0;
    let release: ReturnType<typeof setTimeout> | undefined;
    const transition = vi.spyOn(ledger, "transition").mockImplementation((...args) => {
      if (!rejectedAt) {
        rejectedAt = Date.now();
        if (duringAdmission) f.repositoryResources.fairness.changed();
        else release = setTimeout(() => f.repositoryResources.fairness.changed(), 30);
        return { reserved: false, code: "local-capacity", generation: args[0] };
      }
      const result = original(...args);
      if (result.reserved) admittedAt ||= Date.now();
      return result;
    });
    const running = f.run(shutdown.signal, null);
    try {
      await vi.waitFor(() => expect(admittedAt).toBeGreaterThan(0), {
        timeout: 8_000,
        interval: 10,
      });
      expect(admittedAt - rejectedAt).toBeLessThan(1_000);
      expect(transition.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      if (release) clearTimeout(release);
      shutdown.abort();
      await running.catch(() => {});
      await f.dispose();
      vi.restoreAllMocks();
    }
  },
  15_000,
);

it.each([false, true])(
  "notifies peer admission after successful phase transition; shared=%s",
  async (shared) => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    const shutdown = new AbortController();
    const ledger = shared ? new CapacityLedger() : f.repositoryResources.capacityLedger;
    if (shared) {
      f.repositoryResources.sharedCapacity = {
        snapshot: async () => ledger.snapshot(),
        reconcile: async (_owner, imports) => {
          ledger.reconcileObjective(
            7,
            imports.map(({ reservation }) => reservation),
          );
          return imports;
        },
        reserve: async (_owner, reservation, limits) =>
          ledger.tryReserve(ledger.snapshot().generation, reservation, limits),
        transition: async (_owner, key, reservation, limits) =>
          ledger.transition(ledger.snapshot().generation, key, reservation, limits),
        release: async (_owner, key) => {
          ledger.release(key);
        },
      } as NonNullable<typeof f.repositoryResources.sharedCapacity>;
    }
    const fairness = f.repositoryResources.fairness;
    const peer = {
      objective: 121,
      workItem: 123,
      attempt: 1,
      phase: "execution" as const,
      backendId: "codex-sdk/local-worktree",
      key: "peer-execution",
      admissionClass: "local" as const,
      local: true,
      cpu: 1,
      memoryMb: 512,
      paidUnits: 0,
      paths: ["peer/"],
      exclusiveResources: [],
    };
    peer.key = capacityReservationKey(peer);
    const peerLimits = {
      maxParallel: 8,
      maxLocalParallel: 8,
      maxCloudParallel: 0,
      backendMaxParallel: { "codex-sdk/local-worktree": 1 },
      cpuCapacity: 64,
      memoryCapacityMb: 65536,
      maxPaidUnits: 0,
    };
    let held = false;
    let releaseValidation!: () => void;
    const heldValidation = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const originalValidate = validation.validateArtifactClean;
    vi.spyOn(validation, "validateArtifactClean").mockImplementation(async (args) => {
      held = true;
      await heldValidation;
      return originalValidate(args);
    });
    let peerWait: Promise<void> | undefined;
    let peerAdmitted = false;
    let transitionAt = 0;
    let peerAdmittedAt = 0;
    const originalTransition = ledger.transition.bind(ledger);
    vi.spyOn(ledger, "transition").mockImplementation((...args) => {
      if (!peerWait) {
        // Total/local capacity is available, but A still owns the single execution backend slot.
        const revision = fairness.revision;
        expect(ledger.tryReserve(ledger.snapshot().generation, peer, peerLimits)).toMatchObject({
          reserved: false,
          code: "backend-capacity",
        });
        peerWait = waitForProgress({
          executions: new ContinuousExecutionPool<number>(),
          fairness,
          fairnessRevision: revision,
          maximumMs: 60_000,
          signal: shutdown.signal,
        }).then(() => {
          if (shutdown.signal.aborted) return;
          const result = ledger.tryReserve(ledger.snapshot().generation, peer, peerLimits);
          peerAdmitted = result.reserved;
          peerAdmittedAt = Date.now();
        });
        transitionAt = Date.now();
      }
      return originalTransition(...args);
    });
    const running = f.run(shutdown.signal, null);
    try {
      await vi.waitFor(
        () => {
          expect(held, JSON.stringify(f.notifications.slice(-5))).toBe(true);
          expect(peerAdmitted).toBe(true);
        },
        { timeout: 8_000, interval: 10 },
      );
      expect(peerAdmittedAt - transitionAt).toBeLessThan(1_000);
      expect(ledger.snapshot().reservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ objective: 7, phase: "validation" }),
          peer,
        ]),
      );
      expect(f.events().some((event) => event.event === "AttemptValidated")).toBe(false);
    } finally {
      shutdown.abort();
      releaseValidation();
      await peerWait;
      ledger.release(peer.key);
      await running.catch(() => {});
      await f.dispose();
      vi.restoreAllMocks();
    }
  },
  15_000,
);
