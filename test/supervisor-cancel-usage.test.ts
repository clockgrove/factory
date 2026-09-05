import { describe, expect, it, vi } from "vitest";
import { LeaseLostError, LeaseManager } from "../src/control/lease.js";
import { LifecycleRecorder } from "../src/control/events.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

describe("Supervisor cancellation model usage", () => {
  it("persists known usage while unknown cleanup still blocks release and replacement", async () => {
    const shutdown = new AbortController();
    let cancelled = false;
    let cleanupAttempts = 0;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async () => {
          if (!cancelled) shutdown.abort();
          return {
            state: cancelled ? "cancelled" : "running",
            observedAt: new Date().toISOString(),
            usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
          };
        },
        cancel: async () => {
          cancelled = true;
        },
        cleanup: async () => {
          cleanupAttempts++;
          throw new Error("fixture cleanup unavailable");
        },
        reconcileStale: async () => {
          throw new Error("fixture resource may still be active");
        },
      }),
    });
    try {
      await expect(f.run(shutdown.signal)).rejects.toThrow(/automated replacement is blocked/);
      const usage = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" && event.unit === "model_tokens" && event.phase === "execution",
        );
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        amount: 13,
        usageId: "worker-8-1",
        reportedModelUsage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
      });
      expect(cleanupAttempts).toBeGreaterThan(0);
      expect(
        f
          .events()
          .filter((event) =>
            [
              "AttemptCancelled",
              "AttemptSucceeded",
              "CapacityReconciled",
              "FactoryRunCompleted",
              "FactoryRunCancelled",
            ].includes(event.event),
          ),
      ).toEqual([]);
      expect(f.resources.size).toBe(1);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("does not duplicate usage already journaled before a later cancellation", async () => {
    const shutdown = new AbortController();
    let observations = 0;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async (handle) => {
          observations++;
          return backend.observe(handle);
        },
        collect: async () => {
          shutdown.abort();
          throw new Error("operator cancelled after terminal accounting");
        },
      }),
    });
    try {
      expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
      const usage = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" && event.unit === "model_tokens" && event.phase === "execution",
        );
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ amount: 6, usageId: "worker-8-1" });
      expect(observations).toBe(1);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each(["lease", "receipt"])(
    "still cleans up and blocks terminal writes when the usage %s fence fails",
    async (failure) => {
      const shutdown = new AbortController();
      let cancelled = false;
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        configureLocalBackend: (backend) => ({
          ...backend,
          observe: async () => {
            if (!cancelled) shutdown.abort();
            return {
              state: cancelled ? "cancelled" : "running",
              observedAt: new Date().toISOString(),
              usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
            };
          },
          cancel: async (handle) => {
            await backend.cancel(handle);
            cancelled = true;
            if (failure === "lease")
              vi.mocked(LeaseManager.prototype.assertCurrent).mockRejectedValue(
                new LeaseLostError("cancellation fixture lease lost"),
              );
            else
              vi.spyOn(LifecycleRecorder.prototype, "budget").mockRejectedValue(
                new Error("cancellation fixture receipt unavailable"),
              );
          },
        }),
      });
      try {
        await expect(f.run(shutdown.signal)).rejects.toThrow(/lease lost|receipt unavailable/);
        expect(
          f
            .events()
            .filter(
              (event) =>
                event.kind === "budget" &&
                event.unit === "model_tokens" &&
                event.phase === "execution",
            ),
        ).toEqual([]);
        expect(
          f
            .events()
            .filter((event) => event.kind === "attempt" && event.event === "AttemptCancelled"),
        ).toEqual([]);
        expect(f.resources.size).toBe(0);
        expect(f.activity.filter((entry) => entry.operation === "cleanup")).toHaveLength(1);
        expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it.each([13, 0, null, "unavailable"] as const)(
    "retains terminal cancellation usage %s without inventing absent counters",
    async (tokens) => {
      const shutdown = new AbortController();
      const order: string[] = [];
      let cancelled = false;
      let cleaned = false;
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        configureLocalBackend: (backend) => ({
          ...backend,
          observe: async () => {
            if (cleaned) throw new Error("cleanup discarded backend observation");
            if (!cancelled) {
              shutdown.abort();
              return { state: "running", observedAt: new Date().toISOString() };
            }
            order.push("terminal-observe");
            if (tokens === "unavailable") throw new Error("terminal counters unavailable");
            return {
              state: "cancelled",
              observedAt: new Date().toISOString(),
              usage: {
                inputTokens: tokens,
                outputTokens: tokens === null ? null : 0,
                cachedInputTokens: tokens === null ? null : 0,
              },
            };
          },
          cancel: async (handle) => {
            await backend.cancel(handle);
            cancelled = true;
            order.push("cancel");
          },
          cleanup: async (handle) => {
            await backend.cleanup(handle);
            cleaned = true;
            order.push("cleanup");
          },
        }),
      });
      try {
        expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
        const usage = f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.unit === "model_tokens" &&
              event.phase === "execution",
          );
        const terminal = f
          .events()
          .filter((event) => event.kind === "attempt" && event.event === "AttemptCancelled");
        expect(order).toEqual(["cancel", "terminal-observe", "cleanup"]);
        expect(terminal).toHaveLength(1);
        if (tokens === null || tokens === "unavailable") {
          expect(usage).toEqual([]);
          expect(terminal[0]).not.toHaveProperty("reportedModelTokens");
          expect(terminal[0]).not.toHaveProperty("reportedModelUsage");
        } else {
          expect(usage).toHaveLength(1);
          expect(usage[0]).toMatchObject({
            amount: tokens,
            usageId: "worker-8-1",
            reportedModelUsage: { inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0 },
          });
          expect(terminal[0]).toMatchObject({
            reportedModelTokens: tokens,
            reportedModelUsage: { inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0 },
          });
        }
        expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
        expect(f.resources.size).toBe(0);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );
});
