import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubReader } from "../src/github.js";
import { LifecycleRecorder } from "../src/control/events.js";
import * as transfers from "../src/control/artifact-transfers.js";
import { ContinuousExecutionPool } from "../src/scheduling/continuous-refill.js";
import { SafeArtifactCheckpointHeldError } from "../src/runtime/qualification-checkpoint.js";
import { SafeArtifactCheckpointShutdownError } from "../src/runtime/qualification-checkpoint.js";
import { CapacityLedger } from "../src/scheduling/capacity-ledger.js";
import { ObjectiveFairness } from "../src/scheduling/fairness.js";
import { LeaseLostError, LeaseManager } from "../src/control/lease.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import * as worktrees from "../src/runtime/local-worktree.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const value = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    dependencyChain: true,
    controllerActivation: true,
  });
  fixtures.push(value);
  return value;
}
function assertHeld(f: Fixture) {
  expect(f.events().filter((event) => event.event === "AttemptSucceeded")).toHaveLength(1);
  expect(
    f
      .events()
      .some((event) =>
        [
          "AttemptCancelled",
          "AttemptFailed",
          "AttemptDeferred",
          "AttemptCollected",
          "ValidationRecorded",
          "PublicationRecorded",
        ].includes(event.event),
      ),
  ).toBe(false);
  expect(
    f.events().some((event) => event.kind === "capacity" && event.phase === "validation"),
  ).toBe(false);
  expect(f.activity.filter((event) => event.operation === "launch")).toHaveLength(1);
  expect(f.activity.some((event) => ["review", "validate"].includes(event.operation))).toBe(false);
}

describe("completed artifact shutdown before validation admission", () => {
  it.each(["none", "cleanup", "lease"] as const)(
    "retires an exact safe hold on shutdown without hiding %s failure",
    async (failure) => {
      const f = await fixture();
      const shutdown = new AbortController();
      const original: ReturnType<Fixture["events"]> = [];
      let interrupted = false;
      const transition = CapacityLedger.prototype.transition;
      vi.spyOn(CapacityLedger.prototype, "transition").mockImplementation(function (
        this: CapacityLedger,
        generation,
        from,
        reservation,
        limits,
      ) {
        if (!interrupted && reservation.workItem === 8 && reservation.phase === "validation") {
          // Inject the runtime hold's proved-shutdown outcome at the first
          // downstream boundary, before capacity admission. The real hold's
          // witness/abort classification is covered in its direct module tests.
          interrupted = true;
          expect(f.resources.size).toBe(0);
          assertHeld(f);
          original.push(
            ...f.events().filter((event) => event.kind === "attempt" || event.kind === "budget"),
          );
          shutdown.abort();
          throw new SafeArtifactCheckpointShutdownError(shutdown.signal.reason);
        }
        return transition.call(this, generation, from, reservation, limits);
      });
      const release = vi.mocked(LeaseManager.prototype.release);
      const releaseFailure = new LeaseLostError("exact original lease was replaced");
      if (failure === "lease") release.mockRejectedValueOnce(releaseFailure);
      if (failure === "cleanup") {
        const cleanup = worktrees.cleanupLocalWorktree;
        vi.spyOn(worktrees, "cleanupLocalWorktree").mockImplementationOnce(async (...args) => {
          await cleanup(...args);
          throw new Error("owned workspace cleanup unavailable");
        });
      }
      if (failure === "none")
        await expect(f.run(shutdown.signal)).resolves.toMatchObject({ status: "cancelled" });
      else if (failure === "lease")
        await expect(f.run(shutdown.signal)).rejects.toBe(releaseFailure);
      else
        await expect(f.run(shutdown.signal)).rejects.toMatchObject({
          name: "SafeArtifactCheckpointHeldError",
          cause: { message: "owned workspace cleanup unavailable" },
        });
      expect(interrupted).toBe(true);
      assertHeld(f);
      expect(
        f.events().filter((event) => event.kind === "attempt" || event.kind === "budget"),
      ).toEqual(original);
      expect(
        f
          .events()
          .some((event) =>
            ["FactoryRunCancelled", "FactoryRunCompleted", "FactoryRunEscalated"].includes(
              event.event,
            ),
          ),
      ).toBe(false);
      expect(release).toHaveBeenCalledTimes(failure === "cleanup" ? 0 : 1);
      const ready = [...f.refs].filter(
        ([ref]) => ref.includes("/artifact-transfers/") && ref.endsWith("/ready"),
      );
      expect(ready).toHaveLength(1);
      if (failure === "none") {
        expect(release.mock.calls[0]![0]).toMatchObject({ runId: f.runId, epoch: 1 });
        await expect(f.run()).resolves.toMatchObject({ status: "completed" });
        expect(
          f.events().filter((event) => event.event === "AttemptReserved" && event.workItem === 8),
        ).toHaveLength(1);
        for (const [ref, oid] of ready) expect(f.refs.get(ref)).toBe(oid);
      }
    },
    30_000,
  );
  it("consumes a held-worker failure settled during an in-flight snapshot before same-process recovery", async () => {
    const f = await fixture();
    const shutdown = new AbortController();
    const releaseHold = deferred(),
      settled = deferred();
    let held = false,
      interruptedSnapshot = false;
    const holdFailure = new SafeArtifactCheckpointHeldError();
    const budget = LifecycleRecorder.prototype.budget;
    vi.spyOn(LifecycleRecorder.prototype, "budget").mockImplementation(async function (
      this: LifecycleRecorder,
      args,
    ) {
      const receipt = await budget.call(this, args);
      if (
        !held &&
        args.reservation.workItem === 8 &&
        args.event === "BudgetReconciled" &&
        args.unit === "local_milliseconds"
      ) {
        // Actual durable ready artifact, AttemptSucceeded and token/native receipt
        // precede the installed terminal hold. Abort throws this same typed error.
        held = true;
        await releaseHold.promise;
        throw holdFailure;
      }
      return receipt;
    });
    const start = ContinuousExecutionPool.prototype.start;
    vi.spyOn(ContinuousExecutionPool.prototype, "start").mockImplementation(function (
      this: ContinuousExecutionPool<unknown>,
      key,
      operation,
      onSettled,
    ) {
      return start.call(this, key, operation, () => {
        onSettled?.();
        settled.resolve();
      });
    });
    const read = vi.mocked(GitHubReader.prototype.readObjective).getMockImplementation()!;
    vi.mocked(GitHubReader.prototype.readObjective).mockImplementation(async (...args) => {
      if (held && !interruptedSnapshot) {
        interruptedSnapshot = true;
        // SIGTERM arrives while a previously admitted scheduler snapshot is in
        // flight. The pool removes the active key before the snapshot completes.
        shutdown.abort();
        releaseHold.resolve();
        await settled.promise;
      }
      return read(...args);
    });
    await expect(f.run(shutdown.signal)).rejects.toBe(holdFailure);
    expect(interruptedSnapshot).toBe(true);
    assertHeld(f);
    const original = f
      .events()
      .filter((event) => event.kind === "attempt" || event.kind === "budget");
    const ready = [...f.refs].filter(
      ([ref]) => ref.includes("/artifact-transfers/") && ref.endsWith("/ready"),
    );
    expect(ready).toHaveLength(1);
    await expect(f.run()).resolves.toMatchObject({ status: "completed" });
    for (const event of original) expect(f.events()).toContainEqual(event);
    for (const [ref, oid] of ready) expect(f.refs.get(ref)).toBe(oid);
    expect(
      f.events().filter((event) => event.event === "AttemptReserved" && event.workItem === 8),
    ).toHaveLength(1);
    const validation = f
      .events()
      .find((event) => event.event === "CapacityReserved" && event.workItem === 8);
    expect(validation).toMatchObject({
      recoveryEpoch: 2,
      localScopeBatch: { identity: { directorEpoch: 2 } },
    });
  }, 30_000);

  it.each(["pause", "drain"] as const)(
    "does not acknowledge a %s command over a queued worker veto",
    async (command) => {
      const f = await fixture();
      const holdFailure = new SafeArtifactCheckpointHeldError();
      const budget = LifecycleRecorder.prototype.budget;
      const throwNextFailure = ContinuousExecutionPool.prototype.throwNextFailure;
      const reportDemand = ObjectiveFairness.prototype.reportDemand;
      let commandRecorded = false;
      let claimAtOperationalGate = false;

      vi.spyOn(LifecycleRecorder.prototype, "budget").mockImplementation(async function (
        this: LifecycleRecorder,
        args,
      ) {
        const receipt = await budget.call(this, args);
        if (
          !commandRecorded &&
          args.reservation.workItem === 8 &&
          args.event === "BudgetReconciled" &&
          args.unit === "local_milliseconds"
        ) {
          commandRecorded = true;
          const start = f.events().find((event) => event.event === "FactoryRunStarted");
          if (start?.event !== "FactoryRunStarted") throw new Error("fixture start absent");
          f.snapshot.factoryEvents!.push(
            parseFactoryEvent({
              protocol: start.protocol,
              kind: "run",
              event: command === "pause" ? "RunPauseRequested" : "RunDrainRequested",
              objective: 7,
              runId: f.runId,
              sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
              at: new Date().toISOString(),
              requestedBy: "operator",
              requestId: `${command}-queued-veto`,
            }),
          );
          throw holdFailure;
        }
        return receipt;
      });
      vi.spyOn(ObjectiveFairness.prototype, "reportDemand").mockImplementation(function (
        this: ObjectiveFairness,
        objective,
        demand,
        requirements,
      ) {
        const result = reportDemand.call(this, objective, demand, requirements);
        if (objective === 7 && demand === 0 && requirements === undefined)
          claimAtOperationalGate = true;
        return result;
      });
      vi.spyOn(ContinuousExecutionPool.prototype, "throwNextFailure").mockImplementation(function (
        this: ContinuousExecutionPool<unknown>,
      ) {
        // Hold the already queued settlement until the precise acknowledgement
        // fence. This deterministically models settlement after the preceding
        // scheduler checks, without weakening the real pool's claim behavior.
        if (claimAtOperationalGate) return throwNextFailure.call(this);
      });

      await expect(f.run()).rejects.toBe(holdFailure);
      expect(commandRecorded).toBe(true);
      expect(claimAtOperationalGate).toBe(true);
      expect(
        f
          .events()
          .some((event) =>
            command === "pause"
              ? event.event === "RunPauseAcknowledged"
              : event.event === "RunDrainCompleted",
          ),
      ).toBe(false);
      expect(
        f
          .events()
          .some((event) =>
            ["FactoryRunCancelled", "FactoryRunCompleted", "FactoryRunEscalated"].includes(
              event.event,
            ),
          ),
      ).toBe(false);
      assertHeld(f);
    },
    30_000,
  );

  it("preserves a retained successful attempt if shutdown arrives during its later recovery reads", async () => {
    const f = await fixture();
    const budget = LifecycleRecorder.prototype.budget;
    let first = true;
    vi.spyOn(LifecycleRecorder.prototype, "budget").mockImplementation(async function (
      this: LifecycleRecorder,
      args,
    ) {
      const receipt = await budget.call(this, args);
      if (
        first &&
        args.reservation.workItem === 8 &&
        args.event === "BudgetReconciled" &&
        args.unit === "local_milliseconds"
      ) {
        first = false;
        throw new SafeArtifactCheckpointHeldError();
      }
      return receipt;
    });
    await expect(f.run()).rejects.toBeInstanceOf(SafeArtifactCheckpointHeldError);
    assertHeld(f);
    const original = f
      .events()
      .filter((event) => event.kind === "attempt" || event.kind === "budget");
    const shutdown = new AbortController();
    const resume = transfers.resumeArtifactTransfer;
    let recovered = false;
    vi.spyOn(transfers, "resumeArtifactTransfer").mockImplementation(async (args) => {
      const artifact = await resume(args);
      if (!recovered && artifact) {
        recovered = true;
        shutdown.abort();
      }
      return artifact;
    });
    await expect(f.run(shutdown.signal)).resolves.toMatchObject({ status: "cancelled" });
    expect(recovered).toBe(true);
    assertHeld(f);
    expect(
      f.events().filter((event) => event.kind === "attempt" || event.kind === "budget"),
    ).toEqual(original);
    expect(f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(false);
    await expect(f.run()).resolves.toMatchObject({ status: "completed" });
    expect(
      f.events().filter((event) => event.event === "AttemptReserved" && event.workItem === 8),
    ).toHaveLength(1);
    const validation = f
      .events()
      .find((event) => event.event === "CapacityReserved" && event.workItem === 8);
    expect(validation).toMatchObject({
      recoveryEpoch: 3,
      localScopeBatch: { identity: { directorEpoch: 3 } },
    });
  }, 30_000);
});
