import { expect, it, vi } from "vitest";
import * as localWake from "../src/control/local-wake.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import * as progress from "../src/scheduling/progress-wake.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it.each([false, true])(
  "wakes paused admissions with active execution=%s",
  async (active) => {
    let wake!: () => void;
    const unsubscribed = vi.fn(async () => {});
    vi.spyOn(localWake, "subscribeLocalWake").mockImplementation(async (_target, callback) => {
      wake = () => callback({ publishedAt: Date.now(), receivedAt: Date.now() });
      return unsubscribed;
    });
    const shutdown = new AbortController();
    let cancelled = false;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async () => ({
          state: cancelled ? "cancelled" : "running",
          observedAt: new Date().toISOString(),
          usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0 },
        }),
        cancel: async (handle) => {
          cancelled = true;
          await backend.cancel(handle);
        },
      }),
    });
    function command(event: "RunPauseRequested" | "RunResumeRequested", requestId: string) {
      f.snapshot.factoryEvents!.push(
        parseFactoryEvent({
          protocol: "clockgrove.factory/v2",
          kind: "run",
          event,
          objective: 7,
          runId: f.runId,
          sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
          at: new Date().toISOString(),
          requestedBy: "operator",
          requestId,
        }),
      );
    }
    if (!active) command("RunPauseRequested", "initial-pause");
    const wait = vi.spyOn(progress, "waitForProgress");
    const read = vi.mocked(GitHubReader.prototype.readObjective);
    const running = f.run(shutdown.signal, null);
    try {
      if (active) {
        await vi.waitFor(
          () => expect(wait.mock.calls.some(([args]) => args.executions.size === 1)).toBe(true),
          { timeout: 8_000 },
        );
        command("RunPauseRequested", "pause");
        wake();
      }
      await vi.waitFor(
        () =>
          expect(f.events().some((event) => event.event === "RunPauseAcknowledged")).toBe(!active),
        { timeout: 3_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = read.mock.calls.length;
      command("RunResumeRequested", "resume");
      wake();
      await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before), {
        timeout: 1_000,
        interval: 10,
      });
      if (!active)
        await vi.waitFor(
          () => expect(f.events().some((event) => event.event === "AttemptStarted")).toBe(true),
          { timeout: 3_000 },
        );
      const diagnostic = f.notifications
        .filter((message) => message.startsWith("Factory command wake: "))
        .at(-1)!;
      const observation = JSON.parse(diagnostic.slice("Factory command wake: ".length));
      expect(observation.publishedAt).toBeLessThanOrEqual(observation.receivedAt);
      expect(observation.receivedAt).toBeLessThanOrEqual(observation.snapshotStartedAt);
      expect(observation.snapshotStartedAt).toBeLessThanOrEqual(observation.snapshotCompletedAt);
      expect(observation.snapshotCompletedAt - observation.publishedAt).toBeLessThan(1_000);
      // A same-turn burst coalesces into one command observation.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = read.mock.calls.length;
      for (let n = 0; n < 5; n++) wake();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(read.mock.calls.length - after).toBeLessThanOrEqual(3);
    } finally {
      shutdown.abort();
      await running.catch(() => {});
      expect(unsubscribed).toHaveBeenCalledOnce();
      await f.dispose();
      vi.restoreAllMocks();
    }
  },
  20_000,
);

it("keeps a command published during an in-flight snapshot pending past the idle admission shortcut", async () => {
  let wake!: () => void;
  vi.spyOn(localWake, "subscribeLocalWake").mockImplementation(async (_target, callback) => {
    wake = () => callback({ publishedAt: Date.now(), receivedAt: Date.now() });
    return async () => {};
  });
  const shutdown = new AbortController();
  let cancelled = false;
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    dependencyChain: true,
    configureLocalBackend: (backend) => ({
      ...backend,
      observe: async () => ({
        state: cancelled ? "cancelled" : "running",
        observedAt: new Date().toISOString(),
        usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0 },
      }),
      cancel: async (handle) => {
        cancelled = true;
        await backend.cancel(handle);
      },
    }),
  });
  const wait = vi.spyOn(progress, "waitForProgress");
  const read = vi.mocked(GitHubReader.prototype.readObjective);
  const ordinary = read.getMockImplementation()!;
  const running = f.run(shutdown.signal, null);
  try {
    await vi.waitFor(
      () => expect(wait.mock.calls.some(([args]) => args.executions.size === 1)).toBe(true),
      { timeout: 8_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = read.mock.calls.length;
    read.mockImplementationOnce(async (number) => {
      const stale = await ordinary(number);
      // Authoritative write after the response was captured, before the Supervisor consumes it.
      f.snapshot.factoryEvents!.push(
        parseFactoryEvent({
          protocol: "clockgrove.factory/v2",
          kind: "run",
          event: "RunPauseRequested",
          objective: 7,
          runId: f.runId,
          sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
          at: new Date().toISOString(),
          requestedBy: "operator",
          requestId: "snapshot-race",
        }),
      );
      wake();
      return stale;
    });
    wake();
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(before + 2), {
      timeout: 1_000,
      interval: 10,
    });
  } finally {
    shutdown.abort();
    await running.catch(() => {});
    await f.dispose();
    vi.restoreAllMocks();
  }
}, 15_000);

it("refreshes persisted cancellation while waiting for another Objective to reconcile", async () => {
  let wake!: () => void;
  vi.spyOn(localWake, "subscribeLocalWake").mockImplementation(async (_target, callback) => {
    wake = () => callback({ publishedAt: Date.now(), receivedAt: Date.now() });
    return async () => {};
  });
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    controllerActivation: true,
  });
  const shutdown = new AbortController();
  f.repositoryResources.fairness.register(121, true);
  const waiting = vi.spyOn(f.repositoryResources.fairness, "waitForChange");
  const running = f.run(shutdown.signal, null);
  try {
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), { timeout: 8_000 });
    expect(f.events().some((event) => event.event === "AttemptStarted")).toBe(false);
    f.snapshot.factoryEvents!.push(
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunCancellationRequested",
        objective: 7,
        runId: f.runId,
        sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
        at: new Date().toISOString(),
        requestedBy: "operator",
        requestId: "cohort-cancel",
      }),
    );
    const publishedAt = Date.now();
    wake();
    let status: string | undefined;
    void running.then((result) => {
      status = result.status;
    });
    await vi.waitFor(() => expect(status).toBe("cancelled"), { timeout: 1_000, interval: 10 });
    expect(Date.now() - publishedAt).toBeLessThan(1_000);
    expect(f.repositoryResources.fairness.reconciled).toBe(false);
    expect(f.events().some((event) => event.event === "AttemptStarted")).toBe(false);
  } finally {
    shutdown.abort();
    await running.catch(() => {});
    f.repositoryResources.fairness.unregister(121);
    await f.dispose();
    vi.restoreAllMocks();
  }
}, 15_000);
