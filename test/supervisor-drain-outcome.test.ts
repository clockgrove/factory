import { describe, expect, it, vi } from "vitest";
import { LeaseLostError, LeaseManager } from "../src/control/lease.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const terminalNames = ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"];

describe("Supervisor selected outcome survives execution teardown", () => {
  it("does not finalize sibling escalation while drained worker cleanup is unproven", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      validationFailure: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        cleanup: async () => {
          throw new Error("fixture cleanup uncertain");
        },
        reconcileStale: async () => {
          throw new Error("fixture resource absence unknown");
        },
      }),
    });
    try {
      await expect(f.run()).rejects.toThrow(/automated replacement is blocked/);
      expect(f.events().filter((event) => terminalNames.includes(event.event))).toEqual([]);
      expect(
        f.events().some((event) => event.event === "AttemptFailed" && event.workItem === 9),
      ).toBe(true);
      expect(
        f.events().some((event) => event.event === "AttemptCancelled" && event.workItem === 8),
      ).toBe(false);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("escalates an exhausted sibling after draining an active worker without inventing operator cancellation", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { validationFailure: true });
    try {
      const result = await f.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: expect.stringMatching(/attempt|failed/i),
      });
      const events = f.events();
      expect(
        events.filter((event) => terminalNames.includes(event.event)).map((event) => event.event),
      ).toEqual(["FactoryRunEscalated"]);
      expect(events.some((event) => event.event === "FactoryRunCancellationRequested")).toBe(false);
      const cancelled = events.find(
        (event) => event.event === "AttemptCancelled" && event.workItem === 8,
      );
      expect(cancelled).toBeDefined();
      expect(cancelled!.sequence).toBeLessThan(
        events.find((event) => event.event === "FactoryRunEscalated")!.sequence,
      );
      expect(events.some((event) => event.event === "AttemptFailed" && event.workItem === 9)).toBe(
        true,
      );
      expect(
        f.activity
          .filter((entry) => entry.operation === "launch")
          .map((entry) => entry.workItem)
          .sort(),
      ).toEqual([8, 9]);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each(["release", "cancel"] as const)(
    "drains an active worker for explicit %s without throwing its internal cancellation",
    async (mode) => {
      const shutdown = new AbortController();
      let cancelled = false;
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        controllerActivation: mode === "release",
        configureLocalBackend: (backend) => ({
          ...backend,
          observe: async () => {
            if (!cancelled) shutdown.abort();
            return {
              state: cancelled ? "cancelled" : "running",
              observedAt: new Date().toISOString(),
              usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
            };
          },
          cancel: async (handle) => {
            await backend.cancel(handle);
            cancelled = true;
          },
        }),
      });
      try {
        expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
        expect(
          f
            .events()
            .filter((event) => terminalNames.includes(event.event))
            .map((event) => event.event),
        ).toEqual(mode === "release" ? [] : ["FactoryRunCancelled"]);
        expect(f.events().filter((event) => event.event === "AttemptCancelled")).toHaveLength(1);
        expect(f.resources.size).toBe(0);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it.each(["lease", "platform", "cleanup"] as const)(
    "preserves %s uncertainty during controller shutdown",
    async (fault) => {
      const shutdown = new AbortController();
      let cancelled = false;
      const failure =
        fault === "lease"
          ? new LeaseLostError("drain fixture lease lost")
          : fault === "platform"
            ? new PlatformUnavailableError(
                { kind: "server_error", retryAfterMs: 1000 },
                new Error("fixture platform unavailable"),
              )
            : new Error("fixture cleanup unavailable");
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        controllerActivation: true,
        configureLocalBackend: (backend) => ({
          ...backend,
          observe: async () => {
            if (!cancelled) shutdown.abort();
            return {
              state: cancelled ? "cancelled" : "running",
              observedAt: new Date().toISOString(),
              usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
            };
          },
          cancel: async (handle) => {
            await backend.cancel(handle);
            cancelled = true;
            if (fault !== "cleanup")
              vi.mocked(LeaseManager.prototype.assertCurrent).mockRejectedValue(failure);
          },
          cleanup: async (handle) => {
            if (fault === "cleanup") throw failure;
            await backend.cleanup(handle);
          },
          reconcileStale: async () => {
            if (fault === "cleanup") throw failure;
          },
        }),
      });
      try {
        if (fault === "cleanup")
          await expect(f.run(shutdown.signal)).rejects.toThrow(/automated replacement is blocked/);
        else await expect(f.run(shutdown.signal)).rejects.toBe(failure);
        expect(f.events().filter((event) => terminalNames.includes(event.event))).toEqual([]);
        expect(f.events().filter((event) => event.event === "AttemptCancelled")).toEqual([]);
        expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );
});
