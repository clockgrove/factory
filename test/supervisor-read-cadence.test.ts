import { expect, it, vi } from "vitest";

import { GitHubReader } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import * as progress from "../src/scheduling/progress-wake.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it("uses a bounded external refresh while active and still observes narrow cancellation promptly", async () => {
  const shutdown = new AbortController();
  let cancelled = false;
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
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
    expect(wait.mock.calls.at(-1)![0].maximumMs).toBe(60_000);
    // Let any immediate admission/fairness wake finish before measuring unchanged state.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = read.mock.calls.length;
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
}, 20_000);

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
