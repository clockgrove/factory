import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { LeaseManager } from "../src/control/lease.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

describe("same-run controller restart after integration", () => {
  it("reconstructs a chain including accepted sibling candidate integration after restart", async () => {
    const shutdown = new AbortController();
    let integrations = 0;
    const f = await providerSupervisorFixture("daytona-burst", {
      controllerActivation: true,
      afterIntegration: () => {
        if (++integrations === 2) shutdown.abort();
      },
    });
    try {
      expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
      expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(2);
      expect(f.activity.filter((entry) => entry.operation === "candidate-review")).toHaveLength(1);
      const resumed = await f.run();
      expect(resumed, resumed.reason).toMatchObject({
        status: "completed",
        runId: "provider-fixture",
      });
      expect(
        f.activity
          .filter((entry) => entry.operation === "launch")
          .map((entry) => entry.workItem)
          .sort((a, b) => a - b),
      ).toEqual([8, 9, 10]);
      expect(f.activity.filter((entry) => entry.operation === "candidate-review")).toHaveLength(1);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each(["validation", "acceptance", "reservation", "lease-race"])(
    "rejects resumed execution when %s evidence changes",
    async (fault) => {
      const shutdown = new AbortController();
      const f = await providerSupervisorFixture("daytona-burst", {
        controllerActivation: true,
        localOnly: true,
        afterIntegration: () => shutdown.abort(),
      });
      try {
        expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
        const item = f.snapshot.workItems[0]!;
        if (fault === "validation" || fault === "acceptance")
          item.factoryEvents = item.factoryEvents!.filter(
            (event) =>
              event.event !== (fault === "validation" ? "ValidationRecorded" : "AttemptValidated"),
          );
        if (fault === "reservation") {
          const ref = [...f.refs.keys()].find(
            (ref) => ref.includes("/attempts/") && ref.includes("work-item-8/"),
          );
          expect(ref).toBeDefined();
          f.refs.delete(ref!);
        }
        if (fault === "lease-race") {
          const acquire = vi.mocked(LeaseManager.prototype.acquire).getMockImplementation()!;
          vi.mocked(LeaseManager.prototype.acquire).mockImplementation(async function (
            this: LeaseManager,
            ...args
          ) {
            const lease = await acquire.apply(this, args);
            execFileSync(
              "git",
              ["commit", "--allow-empty", "-qm", "external advance during acquisition"],
              { cwd: f.repository },
            );
            return lease;
          });
        }
        const before = f.events();
        const launches = f.activity.filter((entry) => entry.operation === "launch").length;
        if (fault === "lease-race")
          await expect(f.run()).rejects.toThrow(
            "base branch advanced outside this run during startup",
          );
        else expect(await f.run()).toMatchObject({ status: "escalated", runId: "not-started" });
        expect(f.events()).toEqual(before);
        expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(launches);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it.each([false, true])(
    "resumes own merges while rejecting external trunk progress (%s)",
    async (external) => {
      const shutdown = new AbortController();
      const f = await providerSupervisorFixture("daytona-burst", {
        controllerActivation: true,
        localOnly: true,
        afterIntegration: () => shutdown.abort(),
      });
      try {
        const first = await f.run(shutdown.signal);
        expect(first).toMatchObject({
          status: "cancelled",
          reason: "repository controller stopped; durable run remains active",
        });
        expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(1);
        expect(f.events().filter((event) => event.event === "FactoryRunStarted")).toHaveLength(1);
        expect(
          f
            .events()
            .some((event) =>
              ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
                event.event,
              ),
            ),
        ).toBe(false);
        if (external)
          execFileSync("git", ["commit", "--allow-empty", "-qm", "external trunk advance"], {
            cwd: f.repository,
          });
        const launches = f.activity.filter((entry) => entry.operation === "launch").length;
        const resumed = await f.run();
        if (external) {
          expect(resumed).toMatchObject({ status: "escalated", runId: "not-started" });
          expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(launches);
        } else {
          expect(resumed, resumed.reason).toMatchObject({
            status: "completed",
            runId: first.runId,
          });
          expect(
            f.activity
              .filter((entry) => entry.operation === "launch")
              .map((entry) => entry.workItem),
          ).toEqual([8, 9, 10]);
          expect(f.events().filter((event) => event.event === "FactoryRunStarted")).toHaveLength(1);
          expect(f.resources.size).toBe(0);
          expect(
            f
              .events()
              .filter((event) => event.event === "ControllerObserved")
              .map((event) => event.controllerId),
          ).toEqual(["fixture-controller-1", "fixture-controller-2"]);
        }
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );
});
