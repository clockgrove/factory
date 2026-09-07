import { access, rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubReader } from "../src/github.js";
import { LeaseManager } from "../src/control/lease.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function blockedFixture(signal?: AbortSignal) {
  const fixture = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    dependencyChain: true,
    controllerActivation: true,
  });
  const entered = deferred(),
    unblock = deferred();
  const sample = fixture.repositoryResources.resourceSampler.sample;
  const observedRuns: string[] = [];
  fixture.repositoryResources.resourceSampler = {
    sample: async () => {
      entered.resolve();
      await unblock.promise;
      // This deliberately consults the current prototype after the blocked
      // await, exactly where a detached old run could reach a new fixture.
      const snapshot = await new GitHubReader({
        token: "fixture-only",
        owner: "fixture",
        repo: "provider-qualification",
      }).readObjective(7);
      observedRuns.push(
        snapshot.factoryEvents!.find((event) => event.event === "FactoryRunStarted")!.runId,
      );
      return sample();
    },
  };
  const run = fixture.run(signal);
  const outcome = run.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await Promise.race([
    entered.promise,
    outcome.then(() => {
      throw new Error("fixture run settled before the blocked admission observation");
    }),
  ]);
  return { fixture, run, outcome, unblock, observedRuns };
}

it("drains an abandoned real Supervisor before restoring mocks or admitting the next fixture", async () => {
  const f = await blockedFixture();
  cleanup.push(() => f.fixture.dispose());
  const release = vi.mocked(LeaseManager.prototype.release);
  let disposed = false;
  const retiring = f.fixture.dispose();
  const disposal = retiring.then(() => {
    disposed = true;
  });
  expect(f.fixture.dispose()).toBe(retiring);
  await expect(providerSupervisorFixture("daytona-burst")).rejects.toThrow(
    "retirement is still pending",
  );
  await expect(access(f.fixture.repository)).resolves.toBeUndefined();
  expect(vi.isMockFunction(GitHubReader.prototype.readObjective)).toBe(true);
  expect(disposed).toBe(false);
  f.unblock.resolve();
  await disposal;
  expect(await f.outcome).toMatchObject({ result: { status: "cancelled" } });
  expect(f.observedRuns).toEqual([f.fixture.runId]);
  expect(release).toHaveBeenCalledTimes(1);
  expect(release.mock.calls[0]![0]).toMatchObject({ runId: f.fixture.runId, epoch: 1 });
  await expect(access(f.fixture.repository)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.fixture.run()).rejects.toThrow("already retiring");
  const next = await providerSupervisorFixture("daytona-burst", { localOnly: true });
  cleanup.push(() => next.dispose());
  const snapshot = await new GitHubReader({
    token: "fixture-only",
    owner: "fixture",
    repo: "provider-qualification",
  }).readObjective(7);
  expect(snapshot.factoryEvents!.find((event) => event.event === "FactoryRunStarted")!.runId).toBe(
    next.runId,
  );
  expect(f.observedRuns).toEqual([f.fixture.runId]);
  expect(next.activity).toEqual([]);
  expect(f.fixture.activity.some((event) => event.operation === "launch")).toBe(false);
});

it("preserves caller cancellation without requiring disposal to stop the run", async () => {
  const caller = new AbortController();
  const f = await blockedFixture(caller.signal);
  cleanup.push(() => f.fixture.dispose());
  caller.abort(new Error("caller stopped this fixture run"));
  f.unblock.resolve();
  expect(await f.outcome).toMatchObject({ result: { status: "cancelled" } });
  await expect(access(f.fixture.repository)).resolves.toBeUndefined();
  expect(vi.isMockFunction(GitHubReader.prototype.readObjective)).toBe(true);
  expect(f.fixture.activity.some((event) => event.operation === "launch")).toBe(false);
});

it("retains unresolved teardown evidence and the next-fixture guard after its bounded timeout", async () => {
  const f = await blockedFixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const disposal = f.fixture.dispose();
  const failure = disposal.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await failure).toMatchObject({
    message: expect.stringContaining("runs and cleanup remain unresolved"),
  });
  await expect(providerSupervisorFixture("daytona-burst")).rejects.toThrow(
    "retirement is still pending",
  );
  await expect(access(f.fixture.repository)).resolves.toBeUndefined();
  expect(vi.isMockFunction(GitHubReader.prototype.readObjective)).toBe(true);
  vi.useRealTimers();
  f.unblock.resolve();
  expect(await f.outcome).toMatchObject({ result: { status: "cancelled" } });
  // Finish the settled promise reactions, not an arbitrary wall-clock sleep.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.observedRuns).toEqual([f.fixture.runId]);
  expect(f.fixture.resources.size).toBe(0);
  // A late settlement does not perform cleanup after timeout.
  await expect(access(f.fixture.repository)).resolves.toBeUndefined();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(f.fixture.repository, { recursive: true, force: true });
  const next = await providerSupervisorFixture("daytona-burst", { localOnly: true });
  cleanup.push(() => next.dispose());
  expect(next.activity).toEqual([]);
});

it("reports an interrupted run's real failure but does not replay an already-settled expected rejection at disposal", async () => {
  const expected = new Error("fixture cleanup proof unavailable");
  const f = await blockedFixture();
  vi.mocked(LeaseManager.prototype.release).mockRejectedValue(expected);
  const disposal = f.fixture.dispose();
  const failure = disposal.catch((error: unknown) => error);
  f.unblock.resolve();
  expect(await f.outcome).toMatchObject({ error: expected });
  expect(await failure).toBe(expected);
  await expect(access(f.fixture.repository)).resolves.toBeUndefined();
  expect(vi.isMockFunction(GitHubReader.prototype.readObjective)).toBe(true);
  expect(f.fixture.resources.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(f.fixture.repository, { recursive: true, force: true });
  const settled = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    controllerActivation: true,
    repositoryFence: async () => {
      throw expected;
    },
  });
  cleanup.push(() => settled.dispose());
  await expect(settled.run()).rejects.toBe(expected);
  await expect(settled.dispose()).resolves.toBeUndefined();
});
