import { expect, it, vi } from "vitest";
import { NativeRebaseCheckpointStore } from "../src/control/native-rebases.js";
import { DAYTONA, providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it("executes a cloud child on its parent PR, then validates its rewritten head in a fresh sandbox before merge", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
  try {
    const result = await fixture.run();
    expect(result).toMatchObject({ status: "completed" });
    expect(fixture.activity.filter((entry) => entry.operation === "launch")).toEqual([
      expect.objectContaining({ workItem: 8 }),
      expect.objectContaining({ workItem: 9, backend: DAYTONA }),
      expect.objectContaining({ workItem: 10 }),
    ]);
    expect(
      fixture.activity.filter((entry) => entry.operation === "validate" && entry.invocation),
    ).toHaveLength(1);
    expect(fixture.activity.filter((entry) => entry.operation === "rebase-review")).toHaveLength(1);
    expect([...fixture.refs.keys()].filter((ref) => ref.includes("/native-rebases/"))).toHaveLength(
      1,
    );
    const events = fixture.events();
    const childPublications = events.filter(
      (event) =>
        event.kind === "publication" &&
        event.event === "PublicationRecorded" &&
        event.workItem === 9,
    );
    expect(childPublications).toHaveLength(2);
    expect(childPublications[0]).toMatchObject({ parentItemId: "a", mode: "native-stacks" });
    expect(childPublications[1]).toMatchObject({
      parentItemId: "a",
      mode: "native-stacks",
      baseBranch: "main",
    });
    expect(fixture.resources.size).toBe(0);
  } finally {
    await fixture.dispose();
  }
}, 30000);

for (const fault of ["candidateValidationFailure", "candidateCleanupFailure"] as const) {
  it(`preserves the native child liability and forbids replacement after ${fault}`, async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      nativeStack: true,
      [fault]: true,
    });
    try {
      const result = await fixture.run().catch((error: unknown) => error);
      expect(
        result,
        JSON.stringify(fixture.events().filter((event) => event.event === "AttemptFailed")),
      ).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/replacement is blocked|resource reconciliation/);
      expect(fixture.snapshot.workItems.map((item) => item.closed)).toEqual([true, false, false]);
      expect(fixture.activity.filter((entry) => entry.invocation)).toHaveLength(1);
      expect(fixture.activity.filter((entry) => entry.workItem === 10)).toEqual([]);
      expect(fixture.activity.filter((entry) => entry.operation === "rebase-review")).toEqual([]);
      expect([...fixture.refs.keys()].filter((ref) => ref.includes("/native-rebases/"))).toEqual(
        [],
      );
      expect(
        fixture
          .events()
          .filter(
            (event) =>
              event.kind === "capacity" && event.backend.startsWith("factory/integration-sandbox-"),
          )
          .map((event) => event.event),
      ).toEqual(["CapacityReserved"]);
      expect(
        fixture
          .events()
          .filter(
            (event) =>
              event.kind === "run" &&
              ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
                event.event,
              ),
          ),
      ).toEqual([]);
      expect(fixture.resources.size).toBe(fault === "candidateCleanupFailure" ? 1 : 0);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
}

it("recovers a lost native validation checkpoint response without another sandbox or review", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
  const persist = NativeRebaseCheckpointStore.prototype.persist;
  const checkpoint = vi
    .spyOn(NativeRebaseCheckpointStore.prototype, "persist")
    .mockImplementationOnce(async function (this: NativeRebaseCheckpointStore, args) {
      await persist.call(this, args);
      throw new Error("native checkpoint response lost after immutable write");
    });
  try {
    const result = await fixture.run();
    expect(
      result,
      JSON.stringify(fixture.events().filter((event) => event.event === "AttemptFailed")),
    ).toMatchObject({ status: "completed" });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(fixture.activity.filter((entry) => entry.operation === "rebase-review")).toHaveLength(1);
    expect(fixture.activity.filter((entry) => entry.invocation)).toHaveLength(1);
    expect([...fixture.refs.keys()].filter((ref) => ref.includes("/native-rebases/"))).toHaveLength(
      1,
    );
    const usage = fixture
      .events()
      .filter(
        (event) =>
          event.kind === "budget" &&
          event.unit === "sandbox_milliseconds" &&
          event.usageId?.startsWith("integration-validation-"),
      );
    expect(usage.map((event) => event.event)).toEqual(["BudgetReserved", "BudgetReconciled"]);
    expect(fixture.resources.size).toBe(0);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

for (const fault of [
  "nativeRebaseConflict",
  "nativeHeadChangeAfterValidation",
  "nativeRebaseReviewRejects",
  "nativeRebaseBudgetExhaustion",
] as const) {
  it(`never merges stale native child evidence after ${fault}`, async () => {
    const fixture = await providerSupervisorFixture("daytona-burst", {
      nativeStack: true,
      [fault]: true,
    });
    try {
      const result = await fixture.run();
      expect(result, result.reason).toMatchObject({ status: "escalated" });
      expect(fixture.snapshot.workItems.map((item) => item.closed)).toEqual([true, false, false]);
      expect(fixture.activity.filter((entry) => entry.workItem === 10)).toEqual([]);
      expect(fixture.activity.filter((entry) => entry.invocation)).toHaveLength(
        fault === "nativeHeadChangeAfterValidation" || fault === "nativeRebaseReviewRejects"
          ? 1
          : 0,
      );
      expect(
        fixture
          .events()
          .filter(
            (event) =>
              event.kind === "publication" &&
              event.workItem === 9 &&
              event.event === "PublicationRecorded",
          ),
      ).toHaveLength(1);
      expect(fixture.resources.size).toBe(0);
      if (fault === "nativeRebaseBudgetExhaustion") expect(result.reason).toMatch(/budget/);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
}

it("cancels before admitting a native rebase sandbox after its parent merge", async () => {
  const controller = new AbortController();
  const fixture = await providerSupervisorFixture("daytona-burst", {
    nativeStack: true,
    nativeAfterParentMerge: () => controller.abort(),
  });
  try {
    expect(await fixture.run(controller.signal)).toMatchObject({ status: "cancelled" });
    expect(fixture.activity.filter((entry) => entry.invocation)).toEqual([]);
    expect(fixture.snapshot.workItems.map((item) => item.closed)).toEqual([true, false, false]);
    expect(fixture.resources.size).toBe(0);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it("does not turn native cleanup uncertainty into terminal cancellation", async () => {
  const controller = new AbortController();
  const fixture = await providerSupervisorFixture("daytona-burst", {
    nativeStack: true,
    candidateCleanupFailure: true,
    nativeDuringRebaseValidation: () => controller.abort(),
  });
  try {
    await expect(fixture.run(controller.signal)).rejects.toThrow(/replacement is blocked/);
    expect(fixture.resources.size).toBe(1);
    expect(
      fixture
        .events()
        .filter(
          (event) =>
            event.kind === "run" &&
            ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
              event.event,
            ),
        ),
    ).toEqual([]);
    expect(
      fixture
        .events()
        .filter(
          (event) =>
            event.kind === "capacity" && event.backend.startsWith("factory/integration-sandbox-"),
        )
        .map((event) => event.event),
    ).toEqual(["CapacityReserved"]);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it("does not duplicate a native sandbox when its completion checkpoint is unavailable", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
  vi.spyOn(NativeRebaseCheckpointStore.prototype, "persist").mockRejectedValue(
    new Error("native checkpoint unavailable before immutable commit"),
  );
  try {
    await expect(fixture.run()).rejects.toThrow(/replacement is blocked/);
    expect(fixture.activity.filter((entry) => entry.invocation)).toHaveLength(1);
    expect(fixture.snapshot.workItems.map((item) => item.closed)).toEqual([true, false, false]);
    expect([...fixture.refs.keys()].filter((ref) => ref.includes("/native-rebases/"))).toEqual([]);
    expect(
      fixture
        .events()
        .filter(
          (event) =>
            event.kind === "capacity" && event.backend.startsWith("factory/integration-sandbox-"),
        )
        .map((event) => event.event),
    ).toEqual(["CapacityReserved"]);
    expect(fixture.resources.size).toBe(0);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it("cancels after native sandbox cleanup without reviewing or merging its rewritten child", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
  const controller = new AbortController();
  const persist = NativeRebaseCheckpointStore.prototype.persist;
  vi.spyOn(NativeRebaseCheckpointStore.prototype, "persist").mockImplementationOnce(async function (
    this: NativeRebaseCheckpointStore,
    args,
  ) {
    const result = await persist.call(this, args);
    controller.abort();
    return result;
  });
  try {
    const result = await fixture.run(controller.signal);
    expect(result).toMatchObject({ status: "cancelled" });
    expect(fixture.activity.filter((entry) => entry.invocation)).toHaveLength(1);
    expect(fixture.snapshot.workItems.map((item) => item.closed)).toEqual([true, false, false]);
    expect(fixture.activity.filter((entry) => entry.workItem === 10)).toEqual([]);
    expect(fixture.resources.size).toBe(0);
    expect(fixture.activity.filter((entry) => entry.operation === "rebase-review")).toEqual([]);
    expect(
      fixture
        .events()
        .filter(
          (event) =>
            event.kind === "capacity" && event.backend.startsWith("factory/integration-sandbox-"),
        )
        .map((event) => event.event),
    ).toEqual(["CapacityReserved", "CapacityReconciled"]);
  } finally {
    await fixture.dispose();
  }
}, 30_000);
