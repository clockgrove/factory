import { describe, expect, it, vi } from "vitest";
import { AttemptManager } from "../src/control/attempts.js";
import { CachedResourceSampler } from "../src/scheduling/resource-sampler.js";
import { derive, queuedState } from "../src/state.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

describe("Supervisor durable queue reason transitions", () => {
  it("journals only changed gates across a same-run restart without resetting waiting age or attempts", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true, adaptiveLocal: true, controllerActivation: true,
    });
    let shutdown = new AbortController();
    let cycle = 0;
    let restarted = false;
    const record = AttemptManager.prototype.recordQueued;
    const queued = vi.spyOn(AttemptManager.prototype, "recordQueued").mockImplementation(async function(this: AttemptManager, args) {
      const receipt = await record.call(this, args);
      // Both ready items complete their real leased write before stopping this generation.
      if (args.workItem === 9 && args.reasonCode === (restarted ? "local-cooldown" : "local-pressure")) shutdown.abort();
      return receipt;
    });
    vi.spyOn(CachedResourceSampler.prototype, "sample").mockImplementation(async () => {
      cycle++;
      return {
        measuredAt: new Date().toISOString(), logicalCpu: 8,
        effectiveCpu: !restarted && cycle <= 2 ? 0.5 : 8,
        loadRatio: !restarted && cycle <= 2 ? 0 : 1,
        totalMemoryMb: 32768, availableMemoryMb: 30000, memoryUsageRatio: 0.1, source: "host",
      };
    });
    try {
      expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
      const original = queuedState(derive(f.snapshot).items.find((item) => item.number === 8)!, f.runId)!;
      expect(original.latest.reasonCode).toBe("local-pressure");
      restarted = true;
      cycle = 0;
      shutdown = new AbortController();
      expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
      for (const number of [8, 9]) {
        const writes = queued.mock.calls.filter(([args]) => args.workItem === number);
        expect(writes.map(([args]) => args.reasonCode)).toEqual(["local-capacity", "local-pressure", "local-cooldown"]);
        expect(new Set(writes.map(([args]) => args.lease.runId))).toEqual(new Set([f.runId]));
        expect(new Set(writes.map(([args]) => args.lease.policyDigest)).size).toBe(1);
      }
      const state = queuedState(derive(f.snapshot).items.find((item) => item.number === 8)!, f.runId)!;
      expect(state.since).toBe(original.since);
      expect(state.latest.reasonCode).toBe("local-cooldown");
      expect(f.events().filter((event) => event.kind === "attempt")).toEqual([]);
      expect(f.events().filter((event) => ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event))).toEqual([]);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
