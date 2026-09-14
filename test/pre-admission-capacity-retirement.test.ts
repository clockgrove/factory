import { expect, it, vi } from "vitest";
import { IssueAdmissionLedger } from "../src/control/issue-admission.js";
import {
  SharedCapacityCoordinator,
  type SharedCapacityOwner,
} from "../src/controller/shared-capacity.js";
import { DEFAULT_LEASE_DURATION_MS, LeaseManager, type LeaseState } from "../src/control/lease.js";
import { PlatformUnavailableError } from "../src/platform.js";
import type { CapacityLimits, CapacityReservation } from "../src/scheduling/capacity-ledger.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it.each(["before-intent", "lost-capacity-ack", "capacity-contended"] as const)(
  "settles %s without stranding capacity or duplicating execution",
  async (fault) => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      maxParallel: 1,
      controllerActivation: true,
      objectiveTimeoutMinutes: 45,
    });
    // Keep the fixture's lease simulation, exposing its exact current owner to
    // the production shared ledger rather than replacing capacity behavior.
    let currentLease: LeaseState | null = null;
    const acquire = vi.mocked(LeaseManager.prototype.acquire).getMockImplementation()!;
    vi.mocked(LeaseManager.prototype.acquire).mockImplementation(async (...args) => {
      currentLease = {
        ...(await acquire(...args)),
        expiresAt: new Date(Date.now() + DEFAULT_LEASE_DURATION_MS),
      };
      return currentLease;
    });
    vi.spyOn(LeaseManager.prototype, "readObserved").mockImplementation(async () => ({
      lease: currentLease,
      serverTime: new Date(),
    }));
    const limits: CapacityLimits = {
      maxParallel: 1,
      maxLocalParallel: 1,
      maxCloudParallel: 0,
      backendMaxParallel: {},
      cpuCapacity: 8,
      memoryCapacityMb: 32768,
      maxPaidUnits: 0,
    };
    const options = {
      store: {
        ...fixture.storage,
        serverTime: async () => new Date(),
        compareAndSwapRef: async ({
          ref,
          beforeOid,
          afterOid,
        }: {
          ref: string;
          beforeOid: string;
          afterOid: string;
        }) => {
          if (fixture.refs.get(ref) !== beforeOid) return false;
          fixture.refs.set(ref, afterOid);
          return true;
        },
        // This fresh fixture never compacts retired claims. Fail if that changes.
        readTreeDirectory: async () => {
          throw new Error("unexpected retired-claim lookup");
        },
      },
      repository: "fixture/provider-qualification",
      baseCommitSha: fixture.baseSha,
      limits,
      assertLegacyCompatible: async () => {},
    };
    const shared = new SharedCapacityCoordinator(options);
    fixture.repositoryResources.sharedCapacity = shared;
    const ledger = new IssueAdmissionLedger(options.store);
    let reserved: { owner: SharedCapacityOwner; reservation: CapacityReservation } | undefined;
    let injected = false;
    const failure = new PlatformUnavailableError(
      { kind: "server_error", retryAfterMs: 5_000 },
      new Error(`fixture platform failure: ${fault}`),
    );
    const admit = IssueAdmissionLedger.prototype.admit;
    vi.spyOn(IssueAdmissionLedger.prototype, "admit").mockImplementation(async function (
      this: IssueAdmissionLedger,
      args,
    ) {
      if (fault === "before-intent" && !injected) {
        injected = true;
        throw failure;
      }
      return admit.call(this, args);
    });
    const reserve = shared.reserve.bind(shared);
    vi.spyOn(shared, "reserve").mockImplementation(async (owner, reservation, ceiling) => {
      if (reservation.phase === "execution") {
        const intent = (await ledger.read(reservation.workItem))?.history.find(
          (entry) => entry.capacityReservationId === reservation.key,
        );
        expect(intent).toMatchObject({
          runId: owner.runId,
          directorEpoch: owner.directorEpoch,
          disposition: "prepared",
          dispatchPossible: false,
        });
        if (fault === "capacity-contended" && !injected) {
          injected = true;
          return {
            reserved: false,
            code: "global-capacity",
            generation: (await shared.snapshot()).generation,
          };
        }
      }
      const result = await reserve(owner, reservation, ceiling);
      expect((await shared.snapshot()).active).toBeLessThanOrEqual(1);
      if (result.reserved && reservation.phase === "execution" && !injected) {
        reserved = { owner, reservation };
        injected = true;
        throw failure; // The exact journal claim committed but its acknowledgement was lost.
      }
      return result;
    });
    try {
      let outcome = await fixture.run().catch((error: unknown) => error);
      expect(injected).toBe(true);
      if (fault !== "capacity-contended") {
        expect(outcome).toEqual(failure);
        expect(fixture.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
        expect((await shared.snapshot()).active).toBe(fault === "lost-capacity-ack" ? 1 : 0);
        if (reserved) {
          expect((await ledger.read(reserved.reservation.workItem))?.history).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                directorEpoch: reserved.owner.directorEpoch,
                dispatchPossible: false,
                capacityReservationId: reserved.reservation.key,
              }),
            ]),
          );
        }
        // Only the fixture clock/holder advances. Production issue CAS, receipt
        // reconstruction and shared release must settle the exact original claim.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + DEFAULT_LEASE_DURATION_MS + 1_000);
        outcome = await fixture.run();
      }
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "completed" });
      const launches = fixture.activity.filter((entry) => entry.operation === "launch");
      expect(launches).toHaveLength(fixture.snapshot.workItems.length);
      expect(new Set(launches.map((entry) => entry.workItem)).size).toBe(launches.length);
      expect((await shared.snapshot()).reservations).toEqual([]);
      if (reserved) {
        const original = (await ledger.read(reserved.reservation.workItem))?.history.find(
          (entry) => entry.capacityReservationId === reserved!.reservation.key,
        );
        expect(original).toMatchObject({
          directorEpoch: reserved.owner.directorEpoch,
          disposition: "released",
          dispatchPossible: false,
        });
      }
    } finally {
      vi.useRealTimers();
      await fixture.dispose();
    }
  },
  30_000,
);
