import { describe, expect, it } from "vitest";

import { ContinuousExecutionPool } from "../src/scheduling/continuous-refill.js";
import { CapacityLedger } from "../src/scheduling/capacity-ledger.js";
import { ObjectiveFairness } from "../src/scheduling/fairness.js";
import type { CapacityReservation } from "../src/scheduling/capacity-ledger.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("continuous refill and recovery", () => {
  it("reconstructs every peer before admission, rotates scarce CPU service and lends idle shares", () => {
    const fairness = new ObjectiveFairness();
    fairness.register(10, true);
    fairness.register(20, true);
    fairness.reportDemand(10, 20);
    fairness.reportDemand(20, 20);
    fairness.markReconciled(10);
    expect(fairness.mayAdmit(10, [])).toBe(false);
    fairness.noteAdmission(10, 100);
    fairness.noteAdmission(20, 200);
    fairness.markReconciled(20);
    expect(fairness.mayAdmit(10, [])).toBe(true);
    expect(fairness.mayAdmit(20, [])).toBe(false);
    fairness.noteAdmission(10, 300);
    const occupied = [{ objective: 10, local: true } as CapacityReservation];
    expect(fairness.mayAdmit(10, occupied)).toBe(false);
    expect(fairness.mayAdmit(20, occupied)).toBe(true);
    // A single physical CPU can rotate even when the configured slot ceiling is eight.
    expect(fairness.mayAdmit(20, [])).toBe(true);
    fairness.noteAdmission(10, 100); // replaying older receipts cannot reset the order
    expect(fairness.mayAdmit(20, [])).toBe(true);
    fairness.reportDemand(20, 0); // no presently placeable local work
    expect(fairness.mayAdmit(10, [])).toBe(true);
    expect(fairness.localMaximum(10, 8, [])).toBe(8);
  });

  it("wakes an idle Objective when another releases capacity and removes retired barriers", async () => {
    const fairness = new ObjectiveFairness();
    fairness.register(10, true);
    fairness.register(20, true);
    fairness.markReconciled(10);
    const wake = fairness.waitForChange(60_000);
    fairness.unregister(20);
    await wake;
    expect(fairness.reconciled).toBe(true);
  });

  it("scans past currently oversized/path-blocked demand without forgetting its next free-resource turn", () => {
    const fairness = new ObjectiveFairness();
    const requirement = (cpu: number, path: string) => ({
      cpu,
      memoryMb: 1,
      cpuCapacity: 8,
      memoryCapacityMb: 100,
      paths: [path],
      exclusiveResources: [],
    });
    for (const objective of [10, 20, 30]) fairness.register(objective);
    fairness.reportDemand(10, 1, [requirement(8, "large")]);
    fairness.reportDemand(20, 0, []);
    fairness.reportDemand(30, 1, [requirement(1, "small")]);
    const occupied = [
      {
        objective: 20,
        local: true,
        cpu: 1,
        memoryMb: 1,
        paths: ["busy"],
        exclusiveResources: [],
      } as unknown as CapacityReservation,
    ];
    expect(fairness.mayAdmit(30, occupied)).toBe(true);
    expect(fairness.localMaximum(30, 8, occupied)).toBe(7);
    // Without another polling/report round, a fresh ledger makes the older large
    // request first again. A cached lack of free CPU never loses that turn.
    fairness.noteAdmission(30, 100);
    expect(fairness.mayAdmit(10, [])).toBe(true);
    expect(fairness.mayAdmit(30, [])).toBe(false);
    fairness.reportDemand(10, 1, [requirement(1, "busy")]);
    expect(fairness.mayAdmit(30, occupied)).toBe(true);
  });
  it("refills a safe slot while a sibling remains a straggler", async () => {
    const pool = new ContinuousExecutionPool<number>();
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const started: number[] = [];
    const launch = (key: number, promise: Promise<void>) =>
      pool.start(key, async () => {
        started.push(key);
        await promise;
      });

    launch(1, first.promise);
    launch(2, second.promise);
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    second.resolve();
    await expect(pool.waitForChange(10_000)).resolves.toEqual({ key: 2 });
    launch(3, third.promise);
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    expect(pool.keys().sort()).toEqual([1, 3]);
    third.resolve();
    await pool.waitForChange(10_000);
    first.resolve();
    await pool.settle();
    expect(pool.size).toBe(0);
  });

  it("captures a rejected worker and still executes exactly-once cleanup", async () => {
    const pool = new ContinuousExecutionPool<number>();
    let releases = 0;
    pool.start(
      1,
      async () => {
        throw new Error("worker failed");
      },
      () => {
        releases += 1;
      },
    );
    const settled = await pool.waitForChange(10_000);
    expect(settled?.error).toBeInstanceOf(Error);
    expect(releases).toBe(1);
    expect(pool.size).toBe(0);
  });

  it("retains a worker failure that settles before the caller begins draining", async () => {
    const pool = new ContinuousExecutionPool<number>();
    let settled!: () => void;
    const didSettle = new Promise<void>((resolve) => {
      settled = resolve;
    });
    pool.start(
      1,
      async () => {
        throw new Error("unsafe paid cleanup remains unconfirmed");
      },
      settled,
    );
    await didSettle;

    expect(pool.size).toBe(0);
    await expect(pool.settle()).resolves.toEqual([
      {
        key: 1,
        error: expect.objectContaining({ message: "unsafe paid cleanup remains unconfirmed" }),
      },
    ]);
    await expect(pool.settle()).resolves.toEqual([]);
  });

  it("preserves other Objectives while reconciling one durable generation", () => {
    const ledger = new CapacityLedger();
    ledger.reconcileObjective(1, []);
    const before = ledger.snapshot().generation;
    ledger.reconcileObjective(2, []);
    expect(ledger.snapshot().generation).toBe(before);
    expect(() => ledger.reconcile(before, [])).toThrow(/stale/);
  });

  it("guarantees fair shares but lends slots when an Objective has no demand", () => {
    const fairness = new ObjectiveFairness();
    fairness.register(10);
    fairness.register(20);
    fairness.reportDemand(10, 8);
    fairness.reportDemand(20, 4);
    expect(fairness.localMaximum(10, 8, [])).toBe(4);
    expect(fairness.localMaximum(20, 8, [])).toBe(4);

    const activeForTwenty = [
      {
        objective: 20,
        local: true,
      } as CapacityReservation,
    ];
    fairness.reportDemand(20, 0);
    expect(fairness.localMaximum(10, 8, activeForTwenty)).toBe(7);
    fairness.unregister(20);
    expect(fairness.localMaximum(10, 8, [])).toBe(8);
  });
});
