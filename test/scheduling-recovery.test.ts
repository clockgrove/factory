import { describe, expect, it, vi } from "vitest";

import { ContinuousExecutionPool } from "../src/scheduling/continuous-refill.js";
import { CapacityLedger } from "../src/scheduling/capacity-ledger.js";
import { ObjectiveFairness } from "../src/scheduling/fairness.js";
import { progressWakeDelay, waitForProgress } from "../src/scheduling/progress-wake.js";
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

  it("does not lose a fairness change that lands before waiter registration", async () => {
    const fairness = new ObjectiveFairness();
    const executions = new ContinuousExecutionPool<number>();
    fairness.register(10);
    const observedRevision = fairness.revision;
    fairness.reportDemand(10, 1);
    await expect(
      waitForProgress({
        executions,
        fairness,
        fairnessRevision: observedRevision,
        maximumMs: 60_000,
      }),
    ).resolves.toBeNull();
  });

  it("consumes a local completion that settled before the combined wait began", async () => {
    const fairness = new ObjectiveFairness();
    const executions = new ContinuousExecutionPool<number>();
    executions.start(7, async () => {});
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      waitForProgress({
        executions,
        fairness,
        fairnessRevision: fairness.revision,
        maximumMs: 60_000,
      }),
    ).resolves.toEqual({ key: 7 });
  });

  it("does not consume a later worker settlement when fairness wins the wake race", async () => {
    const fairness = new ObjectiveFairness();
    const executions = new ContinuousExecutionPool<number>();
    const operation = deferred();
    executions.start(7, () => operation.promise);
    const wake = waitForProgress({
      executions,
      executionRevision: executions.revision,
      fairness,
      fairnessRevision: fairness.revision,
      maximumMs: 60_000,
    });
    fairness.changed();
    await expect(wake).resolves.toBeNull();
    operation.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      waitForProgress({
        executions,
        executionRevision: executions.revision,
        fairness,
        fairnessRevision: fairness.revision,
        maximumMs: 60_000,
      }),
    ).resolves.toEqual({ key: 7 });
  });

  it("waits for the earliest future retry deadline and ignores overdue stale hints", async () => {
    expect(progressWakeDelay(60_000, [9_000, 13_000], 10_000)).toBe(3_000);
    expect(progressWakeDelay(60_000, [9_000], 10_000)).toBe(60_000);
    vi.useFakeTimers();
    try {
      const fairness = new ObjectiveFairness();
      const executions = new ContinuousExecutionPool<number>();
      const wake = waitForProgress({
        executions,
        fairness,
        fairnessRevision: fairness.revision,
        maximumMs: 60_000,
        retryDeadlines: [Date.now() + 5_000],
      });
      let completed = false;
      void wake.then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(wake).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("claims a worker failure exactly once before final draining", async () => {
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
    expect(() => pool.throwNextFailure()).toThrow("unsafe paid cleanup remains unconfirmed");
    expect(() => pool.throwNextFailure()).not.toThrow();
    await expect(pool.settle()).resolves.toEqual([]);
  });

  it("keeps an independent child failure visible after another is claimed", async () => {
    const pool = new ContinuousExecutionPool<number>();
    const first = deferred();
    const second = deferred();
    pool.start(1, async () => {
      await first.promise;
      throw new Error("human handoff");
    });
    pool.start(2, async () => {
      await second.promise;
      throw new Error("late cleanup remains unconfirmed");
    });
    first.resolve();
    await pool.waitForCompletion(10_000);
    expect(() => pool.throwNextFailure()).toThrow("human handoff");
    second.resolve();
    await expect(pool.settle()).resolves.toEqual([
      {
        key: 2,
        error: expect.objectContaining({ message: "late cleanup remains unconfirmed" }),
      },
    ]);
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
