import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { GitHubPrimaryAdmissionDeferredError, retryGitHubQuota } from "../src/platform.js";
import { LeaseController } from "../src/supervisor.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it("does not poison the owned lease when cancellation interrupts a heartbeat quota wait", async () => {
  const stop = new AbortController();
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
  let heartbeat: (() => void) | undefined;
  const originalInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    ms: number,
    ...args: unknown[]
  ) => {
    if (ms === 30_000) {
      const inOwnerScope = AsyncLocalStorage.snapshot();
      heartbeat = () => inOwnerScope(callback);
    }
    return Reflect.apply(originalInterval, globalThis, [callback, ms, ...args]);
  }) as typeof setInterval);
  const fail = vi.spyOn(LeaseController.prototype, "fail");
  const running = f.run(stop.signal);
  try {
    await vi.waitFor(
      () => expect(f.events().some((event) => event.event === "AttemptStarted")).toBe(true),
      { timeout: 8_000 },
    );
    let refused = false;
    vi.spyOn(LeaseController.prototype, "renewIfNeeded").mockImplementation(() =>
      retryGitHubQuota(async () => {
        refused = true;
        throw new GitHubPrimaryAdmissionDeferredError(
          { kind: "rate_limit", retryAfterMs: 3_600_000 },
          new Error("quota exhausted"),
        );
      }),
    );
    expect(heartbeat).toBeDefined();
    heartbeat!();
    await vi.waitFor(() => expect(refused).toBe(true));
    stop.abort(new Error("owner stopped"));
    expect(await running).toMatchObject({ status: "cancelled" });
    expect(fail).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    expect(f.resources.size).toBe(0);
    expect(f.events().some((event) => event.event === "FactoryRunCancelled")).toBe(true);
  } finally {
    stop.abort();
    await running.catch(() => {});
    await f.dispose();
    vi.restoreAllMocks();
  }
}, 20_000);
