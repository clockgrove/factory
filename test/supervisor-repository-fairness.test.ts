import { expect, it, vi } from "vitest";
import {
  capacityReservationKey,
  type CapacityReservation,
} from "../src/scheduling/capacity-ledger.js";
import { providerSupervisorFixture, LOCAL } from "./helpers/provider-supervisor.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;

/** A different Objective's already-admitted resource stays live throughout the
 * real Supervisor run. This is a capacity fixture, not historical/live evidence. */
function retainPeer(
  f: Fixture,
  phase: "execution" | "validation" = "execution",
  paths = ["peer/"],
) {
  const identity = {
    objective: 121,
    workItem: 123,
    attempt: 1,
    phase,
    backendId: phase === "execution" ? LOCAL : "factory/local-validation",
  };
  const peer: CapacityReservation = {
    ...identity,
    key: capacityReservationKey(identity),
    admissionClass: "local",
    local: true,
    cpu: 1,
    memoryMb: 512,
    paidUnits: 0,
    paths,
    exclusiveResources: [],
  };
  const shared = f.repositoryResources;
  shared.controllerLimits.maxLocalWorkers = 8;
  shared.capacityLedger.reconcileObjective(peer.objective, [peer]);
  shared.fairness.register(peer.objective);
  shared.fairness.markReconciled(peer.objective);
  shared.fairness.reportDemand(peer.objective, 0);
  shared.fairness.noteAdmission(peer.objective);
  return peer;
}

it.each(["execution", "validation"] as const)(
  "starts a one-slot Objective beside another Objective's retained %s slot without admitting its second root",
  async (phase) => {
    const shutdown = new AbortController();
    let observing = false;
    const release = deferred();
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      controllerActivation: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async (handle) => {
          observing = true;
          await release.promise;
          return backend.observe(handle);
        },
      }),
    });
    const peer = retainPeer(f, phase);
    const running = f.run(shutdown.signal);
    try {
      await vi.waitFor(
        () => {
          expect(f.events().filter((event) => event.event === "AttemptStarted")).toHaveLength(1);
          expect(observing).toBe(true);
        },
        { timeout: 8_000, interval: 20 },
      );
      expect(f.policy.maxParallel).toBe(1);
      expect(f.policy.capacity?.local?.maxWorkers).toBe(1);
      expect(
        f.activity.filter((entry) => entry.operation === "launch").map((entry) => entry.workItem),
      ).toEqual([8]);
      const active = f.repositoryResources.capacityLedger.snapshot().reservations;
      expect(active.find((entry) => entry.key === peer.key)).toEqual(peer);
      expect(active.filter((entry) => entry.objective === 7 && entry.local)).toHaveLength(1);
      expect(active.filter((entry) => entry.local)).toHaveLength(2);
      expect(
        f
          .events()
          .some(
            (event) =>
              event.kind === "scheduling" &&
              event.workItem === 9 &&
              event.reasonCode === "global-capacity",
          ),
      ).toBe(true);
    } finally {
      shutdown.abort();
      release.resolve();
      await running.catch(() => {});
      await f.dispose();
    }
  },
  20_000,
);

it.each([
  ["repository", "local-capacity"],
  ["cpu", "cpu-capacity"],
  ["memory", "memory-capacity"],
  ["paths", "path-conflict"],
] as const)(
  "retains the %s admission fence across Objectives",
  async (constraint, reason) => {
    const shutdown = new AbortController();
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      controllerActivation: true,
    });
    const peer = retainPeer(
      f,
      "execution",
      constraint === "paths" ? ["a.txt", "b.txt"] : ["peer/"],
    );
    if (constraint === "repository") f.repositoryResources.controllerLimits.maxLocalWorkers = 1;
    const sampler = f.repositoryResources.resourceSampler;
    const sample = sampler.sample.bind(sampler);
    sampler.sample = async () => {
      const observed = await sample();
      return {
        ...observed,
        ...(constraint === "cpu" ? { effectiveCpu: 1.5 } : {}),
        ...(constraint === "memory" ? { availableMemoryMb: 1024 } : {}),
      };
    };
    const running = f.run(shutdown.signal);
    try {
      await vi.waitFor(
        () => {
          const queued = f
            .events()
            .filter(
              (event) =>
                event.kind === "scheduling" &&
                event.reasonCode ===
                  (constraint === "paths" ? "path-conflict" : "local-capacity") &&
                event.reason.includes(reason),
            );
          expect(queued.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 8_000, interval: 20 },
      );
      expect(f.events().filter((event) => event.event === "AttemptStarted")).toHaveLength(0);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(0);
      expect(f.repositoryResources.capacityLedger.snapshot().reservations).toEqual([peer]);
    } finally {
      shutdown.abort();
      await running.catch(() => {});
      await f.dispose();
    }
  },
  20_000,
);
