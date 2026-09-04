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
