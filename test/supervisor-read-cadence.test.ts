import { expect, it, vi } from "vitest";

import { GitHubControlStore } from "../src/control/github-store.js";
import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import * as publication from "../src/publication/publisher.js";
import * as progress from "../src/scheduling/progress-wake.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it.each([false, true])(
  "uses bounded external refresh and prompt cancellation; dependency chain=%s",
  async (dependencyChain) => {
    const shutdown = new AbortController();
    let cancelled = false;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain,
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
    const narrow = vi.mocked(GitHubReader.prototype.readRunCancellationRequest);
    const running = f.run(shutdown.signal, null);
    try {
      await vi.waitFor(
        () => {
          expect(f.events().filter((event) => event.event === "AttemptStarted")).toHaveLength(1);
          expect(wait.mock.calls.some(([args]) => args.executions.size === 1)).toBe(true);
        },
        { timeout: 8_000, interval: 20 },
      );
      const externalWait = wait.mock.calls.at(-1)![0].maximumMs;
      // Observation work consumes part of the absolute deadline; it must not
      // add that elapsed time back merely to produce an exact interval.
      expect(externalWait).toBeGreaterThan(0);
      expect(externalWait).toBeLessThanOrEqual(60_000);
      // Let any immediate admission/fairness wake finish before measuring unchanged state.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = read.mock.calls.length;
      // Peer-capacity notifications cannot advance an already-owned child.
      // Each used to reconstruct the full Objective despite no eligible action.
      for (let wake = 0; dependencyChain && wake < 3; wake++) {
        f.repositoryResources.fairness.changed();
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(read).toHaveBeenCalledTimes(before);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect(read).toHaveBeenCalledTimes(before);

      const request = parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunCancellationRequested",
        objective: 7,
        runId: f.runId,
        sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
        at: new Date().toISOString(),
        requestedBy: "operator",
        requestId: "cadence-cancel",
      });
      f.snapshot.factoryEvents!.push(request);
      narrow.mockResolvedValue(
        request as Awaited<ReturnType<GitHubReader["readRunCancellationRequest"]>>,
      );
      // Advance the cancellation eligibility clock, leaving the registered 60s
      // scheduling wait intact. The next 2s worker observation must cancel it.
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 10_001);
      await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 3_000, interval: 20 });
      await expect(running).resolves.toMatchObject({ status: "cancelled" });
      expect(read.mock.calls.length).toBeGreaterThan(before);
    } finally {
      shutdown.abort();
      await running.catch(() => {});
      await f.dispose();
      vi.restoreAllMocks();
    }
  },
  20_000,
);

it("retains an explicit active polling override", async () => {
  const shutdown = new AbortController();
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    configureLocalBackend: (backend) => ({
      ...backend,
      observe: async () => ({
        state: "running",
        observedAt: new Date().toISOString(),
        usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0 },
      }),
    }),
  });
  const wait = vi.spyOn(progress, "waitForProgress");
  const running = f.run(shutdown.signal, 25);
  try {
    await vi.waitFor(
      () => {
        expect(
          wait.mock.calls.filter(([args]) => args.executions.size === 1).length,
        ).toBeGreaterThan(2);
      },
      { timeout: 8_000, interval: 20 },
    );
    expect(wait.mock.calls.every(([args]) => args.maximumMs > 0 && args.maximumMs <= 25)).toBe(
      true,
    );
  } finally {
    shutdown.abort();
    await running.catch(() => {});
    await f.dispose();
    vi.restoreAllMocks();
  }
}, 15_000);

it("admits and completes ready work below the former speculative GraphQL reserve", async () => {
  const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
  // Model affordable current requests with fewer than the former 100-point
  // wave floor. Transport is simulated; this exercises Supervisor admission.
  f.snapshot.graphQlRateLimit = {
    cost: 1,
    limit: 5_000,
    remaining: 99,
    resetAt: new Date(Date.now() + 3_600_000),
  };
  try {
    await expect(f.run()).resolves.toMatchObject({ status: "completed" });
    const launched = f.activity.filter((entry) => entry.operation === "launch");
    expect(launched).toHaveLength(f.snapshot.workItems.length);
    expect(f.activity.filter((entry) => entry.operation === "cleanup")).toHaveLength(
      launched.length,
    );
  } finally {
    await f.dispose();
  }
});

it("integrates newly created no-check PRs without waiting for PR age", async () => {
  const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
  const readPull = vi.mocked(GitHubControlStore.prototype.readPullRequest);
  const original = readPull.getMockImplementation()!;
  readPull.mockImplementation(async (number) => ({
    ...(await original(number)),
    createdAt: new Date(),
  }));
  try {
    await expect(f.run(undefined, null)).resolves.toMatchObject({ status: "completed" });
  } finally {
    await f.dispose();
    vi.restoreAllMocks();
  }
}, 20_000);

it("reconsiders pending native integration on each wake without growing a cooldown", async () => {
  const shutdown = new AbortController();
  const f = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
  const originalReadiness = publication.integrationReadiness;
  let pendingReads = 0;
  vi.spyOn(publication, "integrationReadiness").mockImplementation(async (...args) => {
    const readiness = await originalReadiness(...args);
    if (readiness.state !== "ready" || args[1].number !== 109) return readiness;
    pendingReads++;
    return {
      state: "wait",
      code: "checks-pending",
      headSha: args[1].commitSha,
      baseSha: args[2]!,
      reason: "checks pending: later-member",
    };
  });
  const waits: number[] = [];
  const observed: number[] = [];
  const originalWait = progress.waitForProgress;
  vi.spyOn(progress, "waitForProgress").mockImplementation(async (args) => {
    if (pendingReads === 0) return originalWait(args);
    waits.push(args.maximumMs);
    observed.push(pendingReads);
    // Simulate an immediate progress wake, without advancing the wall clock.
    if (waits.length === 3) shutdown.abort();
    return null;
  });
  try {
    await f.run(shutdown.signal, null).catch(() => undefined);
    expect(waits).toHaveLength(3);
    expect(waits.every((ms) => ms > 0 && ms <= 2_000)).toBe(true);
    expect(observed[1]).toBeGreaterThan(observed[0]!);
    expect(observed[2]).toBeGreaterThan(observed[1]!);
  } finally {
    shutdown.abort();
    await f.dispose();
    vi.restoreAllMocks();
  }
}, 20_000);
