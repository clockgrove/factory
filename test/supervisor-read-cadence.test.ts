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
      if (dependencyChain) {
        expect(externalWait).toBeGreaterThan(0);
        expect(externalWait).toBeLessThanOrEqual(60_000);
      } else expect(externalWait).toBe(60_000);
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
    expect(wait.mock.calls.every(([args]) => args.maximumMs === 25)).toBe(true);
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

it("schedules first-check grace expiry without an additional external poll", async () => {
  const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
  const readPull = vi.mocked(GitHubControlStore.prototype.readPullRequest);
  const original = readPull.getMockImplementation()!;
  const deadlines = new Map<number, number>();
  readPull.mockImplementation(async (number) => {
    const current = await original(number);
    if (!deadlines.has(number)) deadlines.set(number, Date.now() + 750);
    return { ...current, createdAt: new Date(deadlines.get(number)! - 60_000) };
  });
  const waits: Array<{ maximum: number; remaining: number }> = [];
  const originalWait = progress.waitForProgress;
  vi.spyOn(progress, "waitForProgress").mockImplementation(async (args) => {
    const deadline = args.retryDeadlines?.find((value) => [...deadlines.values()].includes(value));
    if (deadline !== undefined)
      waits.push({ maximum: args.maximumMs, remaining: deadline - Date.now() });
    return originalWait(args);
  });
  try {
    await expect(f.run(undefined, null)).resolves.toMatchObject({ status: "completed" });
    expect(waits.length).toBeGreaterThan(0);
    for (const wait of waits) {
      expect(wait.maximum).toBeLessThanOrEqual(750);
      expect(Math.abs(wait.maximum - Math.max(1, wait.remaining))).toBeLessThan(50);
    }
  } finally {
    await f.dispose();
    vi.restoreAllMocks();
  }
}, 20_000);

it("retires a native member's expired grace when a later member still waits", async () => {
  const shutdown = new AbortController();
  const f = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
  const originalReadiness = publication.integrationReadiness;
  let firstGrace: number | undefined;
  let laterMemberPending = false;
  vi.spyOn(publication, "integrationReadiness").mockImplementation(async (...args) => {
    const readiness = await originalReadiness(...args);
    if (readiness.state !== "ready") return readiness;
    if (args[1].number === 108 && firstGrace === undefined) {
      // Model the grace expiring while the current observation is in flight.
      firstGrace = Date.now() - 1;
      return {
        state: "wait",
        code: "first-check-grace",
        headSha: args[1].commitSha,
        baseSha: args[2]!,
        notBefore: firstGrace,
        reason: "waiting for the pull request's first checks to appear",
      };
    }
    if (args[1].number === 109) {
      laterMemberPending = true;
      return {
        state: "wait",
        code: "checks-pending",
        headSha: args[1].commitSha,
        baseSha: args[2]!,
        reason: "checks pending: later-member",
      };
    }
    return readiness;
  });
  const originalWait = progress.waitForProgress;
  let expiredGraceWait: number | undefined;
  let laterWait: Parameters<typeof progress.waitForProgress>[0] | undefined;
  vi.spyOn(progress, "waitForProgress").mockImplementation(async (args) => {
    if (
      !laterMemberPending &&
      firstGrace !== undefined &&
      args.retryDeadlines?.includes(firstGrace)
    )
      expiredGraceWait = args.maximumMs;
    if (laterMemberPending) {
      laterWait = args;
      shutdown.abort();
    }
    return originalWait(args);
  });
  try {
    await f.run(shutdown.signal, null).catch(() => undefined);
    expect(firstGrace).toBeDefined();
    expect(expiredGraceWait).toBe(1);
    expect(laterWait).toBeDefined();
    expect(laterWait!.retryDeadlines).not.toContain(firstGrace);
    // The pending member's absolute retry deadline is retained across the wait;
    // elapsed reconciliation time is not added back to its interval.
    expect(laterWait!.maximumMs).toBeGreaterThan(59_000);
    expect(laterWait!.maximumMs).toBeLessThanOrEqual(60_000);
  } finally {
    shutdown.abort();
    await f.dispose();
    vi.restoreAllMocks();
  }
}, 20_000);
