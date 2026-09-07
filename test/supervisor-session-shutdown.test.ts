import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubReader } from "../src/github.js";
import { LifecycleRecorder } from "../src/control/events.js";
import * as transfers from "../src/control/artifact-transfers.js";
import { ContinuousExecutionPool } from "../src/scheduling/continuous-refill.js";
import { SafeArtifactCheckpointHeldError } from "../src/runtime/qualification-checkpoint.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const value = await providerSupervisorFixture("daytona-burst", {
    localOnly: true, dependencyChain: true, controllerActivation: true,
  });
  fixtures.push(value);
  return value;
}
function assertHeld(f: Fixture) {
  expect(f.events().filter((event) => event.event === "AttemptSucceeded")).toHaveLength(1);
  expect(f.events().some((event) => ["AttemptCancelled", "AttemptFailed", "AttemptDeferred",
    "AttemptCollected", "ValidationRecorded", "PublicationRecorded"].includes(event.event))).toBe(false);
  expect(f.events().some((event) => event.kind === "capacity" && event.phase === "validation")).toBe(false);
  expect(f.activity.filter((event) => event.operation === "launch")).toHaveLength(1);
  expect(f.activity.some((event) => ["review", "validate"].includes(event.operation))).toBe(false);
}

describe("completed artifact shutdown before validation admission", () => {
  it("consumes a held-worker failure settled during an in-flight snapshot before same-process recovery", async () => {
    const f = await fixture();
    const shutdown = new AbortController();
    const releaseHold = deferred(), settled = deferred();
    let held = false, interruptedSnapshot = false;
    const holdFailure = new SafeArtifactCheckpointHeldError();
    const budget = LifecycleRecorder.prototype.budget;
    vi.spyOn(LifecycleRecorder.prototype, "budget").mockImplementation(async function (this: LifecycleRecorder, args) {
      const receipt = await budget.call(this, args);
      if (!held && args.reservation.workItem === 8 && args.event === "BudgetReconciled" && args.unit === "local_milliseconds") {
        // Actual durable ready artifact, AttemptSucceeded and token/native receipt
        // precede the installed terminal hold. Abort throws this same typed error.
        held = true;
        await releaseHold.promise;
        throw holdFailure;
      }
      return receipt;
    });
    const start = ContinuousExecutionPool.prototype.start;
    vi.spyOn(ContinuousExecutionPool.prototype, "start").mockImplementation(function (this: ContinuousExecutionPool<unknown>, key, operation, onSettled) {
      return start.call(this, key, operation, () => { onSettled?.(); settled.resolve(); });
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
    const original = f.events().filter((event) => event.kind === "attempt" || event.kind === "budget");
    const ready = [...f.refs].filter(([ref]) => ref.includes("/artifact-transfers/") && ref.endsWith("/ready"));
    expect(ready).toHaveLength(1);
    await expect(f.run()).resolves.toMatchObject({ status: "completed" });
    for (const event of original) expect(f.events()).toContainEqual(event);
    for (const [ref, oid] of ready) expect(f.refs.get(ref)).toBe(oid);
    expect(f.events().filter((event) => event.event === "AttemptReserved" && event.workItem === 8)).toHaveLength(1);
    const validation = f.events().find((event) => event.event === "CapacityReserved" && event.workItem === 8);
    expect(validation).toMatchObject({ recoveryEpoch: 2, localScopeBatch: { identity: { directorEpoch: 2 } } });
  }, 30_000);

  it("preserves a retained successful attempt if shutdown arrives during its later recovery reads", async () => {
    const f = await fixture();
    const budget = LifecycleRecorder.prototype.budget;
    let first = true;
    vi.spyOn(LifecycleRecorder.prototype, "budget").mockImplementation(async function (this: LifecycleRecorder, args) {
      const receipt = await budget.call(this, args);
      if (first && args.reservation.workItem === 8 && args.event === "BudgetReconciled" && args.unit === "local_milliseconds") {
        first = false;
        throw new SafeArtifactCheckpointHeldError();
      }
      return receipt;
    });
    await expect(f.run()).rejects.toBeInstanceOf(SafeArtifactCheckpointHeldError);
    assertHeld(f);
    const original = f.events().filter((event) => event.kind === "attempt" || event.kind === "budget");
    const shutdown = new AbortController();
    const resume = transfers.resumeArtifactTransfer;
    let recovered = false;
    vi.spyOn(transfers, "resumeArtifactTransfer").mockImplementation(async (args) => {
      const artifact = await resume(args);
      if (!recovered && artifact) { recovered = true; shutdown.abort(); }
      return artifact;
    });
    await expect(f.run(shutdown.signal)).resolves.toMatchObject({ status: "cancelled" });
    expect(recovered).toBe(true);
    assertHeld(f);
    expect(f.events().filter((event) => event.kind === "attempt" || event.kind === "budget")).toEqual(original);
    expect(f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(false);
    await expect(f.run()).resolves.toMatchObject({ status: "completed" });
    expect(f.events().filter((event) => event.event === "AttemptReserved" && event.workItem === 8)).toHaveLength(1);
    const validation = f.events().find((event) => event.event === "CapacityReserved" && event.workItem === 8);
    expect(validation).toMatchObject({ recoveryEpoch: 3, localScopeBatch: { identity: { directorEpoch: 3 } } });
  }, 30_000);
});
