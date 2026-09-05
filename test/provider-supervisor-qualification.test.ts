import { describe, expect, it } from "vitest";
import {
  providerSupervisorFixture,
  DAYTONA,
  LOCAL,
  COPILOT,
  CODEX,
} from "./helpers/provider-supervisor.js";

describe("credential-free provider Supervisor qualification", () => {
  it("bursts a second independent item while local work is active, then releases its join", async () => {
    const f = await providerSupervisorFixture("daytona-burst");
    try {
      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([
        { operation: "launch", backend: LOCAL, workItem: 8 },
        { operation: "launch", backend: DAYTONA, workItem: 9 },
        { operation: "launch", backend: LOCAL, workItem: 10 },
      ]);
      expect(f.resources.size).toBe(0);
      expect(f.snapshot.workItems.every((item) => item.closed)).toBe(true);
      expect(
        f.activity.filter((entry) => entry.operation === "validate" && entry.invocation),
      ).toEqual([
        {
          operation: "validate",
          backend: DAYTONA,
          workItem: 8,
          invocation: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
    } finally {
      await f.dispose();
    }
  }, 30_000);
  it("revalidates the cloud sibling in a fresh sandbox when the local sibling merges first", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localFinishesFirst: true });
    try {
      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(f.activity.filter((entry) => entry.invocation)).toEqual([
        { operation: "validate", backend: DAYTONA, workItem: 9, invocation: expect.any(String) },
      ]);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);
  for (const [scenario, backend] of [
    ["copilot-objective", COPILOT],
    ["codex-objective", CODEX],
  ] as const) {
    it(`runs all three Work Items through simulated ${backend} with independent validation`, async () => {
      const f = await providerSupervisorFixture(scenario);
      try {
        const result = await f.run();
        expect(result, result.reason).toMatchObject({ status: "completed" });
        expect(
          f.activity.filter((entry) => entry.operation === "launch").map((entry) => entry.backend),
        ).toEqual([backend, backend, backend]);
        expect(f.activity.filter((entry) => entry.operation === "validate")).toHaveLength(3);
        expect(f.resources.size).toBe(0);
      } finally {
        await f.dispose();
      }
    }, 30_000);
  }
  it("recovers a committed candidate checkpoint response without repeating sandbox or review", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      loseCandidateCheckpointResponse: true,
    });
    try {
      expect(await f.run()).toMatchObject({ status: "completed" });
      expect(f.activity.filter((entry) => entry.invocation)).toHaveLength(1);
      expect(f.activity.filter((entry) => entry.operation === "candidate-review")).toHaveLength(1);
      const candidateBudgets = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.unit === "sandbox_milliseconds" &&
            event.usageId?.startsWith("integration-validation-"),
        );
      expect(candidateBudgets.map((event) => event.event)).toEqual([
        "BudgetReserved",
        "BudgetReconciled",
      ]);
    } finally {
      await f.dispose();
    }
  }, 30_000);
  for (const fault of [
    "candidateValidationFailure",
    "candidateReviewRejects",
    "externalAdvance",
  ] as const) {
    it(`does not release the join or merge stale evidence after ${fault}`, async () => {
      const f = await providerSupervisorFixture("daytona-burst", { [fault]: true });
      try {
        expect(await f.run()).toMatchObject({ status: "escalated" });
        expect(
          f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === 10),
        ).toEqual([]);
        expect(f.snapshot.workItems.filter((item) => item.closed)).toHaveLength(1);
        if (fault !== "candidateReviewRejects")
          expect(f.activity.filter((entry) => entry.operation === "candidate-review")).toEqual([]);
      } finally {
        await f.dispose();
      }
    }, 30_000);
  }
  it("preserves paid candidate liability and live run when isolated cleanup is unknown", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { candidateCleanupFailure: true });
    try {
      await expect(f.run()).rejects.toThrow(/may still be active|replacement is blocked/);
      expect(f.resources.size).toBe(1);
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.kind === "run" &&
              ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
                event.event,
              ),
          ),
      ).toEqual([]);
      expect(
        f.activity.some((entry) => entry.operation === "launch" && entry.workItem === 10),
      ).toBe(false);
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.kind === "capacity" && event.backend.startsWith("factory/integration-sandbox-"),
          )
          .map((event) => event.event),
      ).toEqual(["CapacityReserved"]);
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
