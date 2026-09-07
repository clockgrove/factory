import { describe, expect, it } from "vitest";

import {
  deriveBudgetUsage,
  mergeAccountingSnapshot,
  remainingBudget,
  unresolvedModelInvocations,
  unreconciledBudgetReservations,
} from "../src/control/budget.js";
import type { FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";

function budget(
  event: "BudgetReserved" | "BudgetReconciled",
  sequence: number,
  amount: number,
  options: {
    unit?: Extract<FactoryEvent, { kind: "budget" }>["unit"];
    phase?: Extract<FactoryEvent, { kind: "budget" }>["phase"];
    usageId?: string;
  } = {},
): Extract<FactoryEvent, { kind: "budget" }> {
  return {
    protocol: "clockgrove.factory/v2",
    kind: "budget",
    event,
    objective: 1,
    runId: "run-1",
    sequence,
    at: "2026-09-03T00:00:00.000Z",
    workItem: 2,
    attempt: 1,
    phase: options.phase ?? "execution",
    unit: options.unit ?? "sandbox_milliseconds",
    amount,
    ...(options.usageId ? { usageId: options.usageId } : {}),
  };
}

describe("budget ledger", () => {
  it("retains concurrent dispatch and actual usage when an older accounting read completes", async () => {
    const prior = budget("BudgetReconciled", 1, 11, { unit: "model_tokens", usageId: "worker-prior" });
    let release!: (events: FactoryEvent[]) => void;
    const delayedRead = new Promise<FactoryEvent[]>((resolve) => { release = resolve; });
    let known: FactoryEvent[] = [prior];
    const refresh = (async () => {
      const observed = await delayedRead;
      known = mergeAccountingSnapshot(known, observed, new Set(["run-1", "ancestor"]));
    })();
    const marker = { ...budget("BudgetReserved", 2, 0, { unit: "model_tokens", usageId: "invocation-worker-next" }), modelInvocationId: "worker-next" };
    const actual = { ...budget("BudgetReconciled", 3, 23, { unit: "model_tokens", usageId: "worker-next" }), modelInvocationId: "worker-next" };
    const ancestor = { ...budget("BudgetReconciled", 1, 7, { unit: "model_tokens", usageId: "worker-ancestor" }), runId: "ancestor" };
    known.push(marker, actual, ancestor);
    release([prior, { ...prior, runId: "foreign", amount: 999 }]);
    await refresh;
    expect(known).toContainEqual(marker);
    expect(known).toContainEqual(actual);
    expect(known.some((event) => event.runId === "foreign")).toBe(false);
    expect(deriveBudgetUsage(known).modelTokens).toBe(41);
    expect(unresolvedModelInvocations(known)).toEqual([]);
    expect(() => mergeAccountingSnapshot(known, [{ ...actual, amount: 24 }], new Set(["run-1", "ancestor"]))).toThrow(/conflicting Factory events/i);
  });

  it("charges the reservation until terminal usage is reconciled", () => {
    const reserved = budget("BudgetReserved", 1, 600_000);
    expect(deriveBudgetUsage([reserved]).sandboxMinutesReserved).toBe(10);
    expect(unreconciledBudgetReservations([reserved])).toEqual([reserved]);
    const reconciled = budget("BudgetReconciled", 2, 60_000);
    expect(deriveBudgetUsage([reserved, reconciled]).sandboxMinutesReserved).toBe(1);
    expect(deriveBudgetUsage([reconciled, reserved]).sandboxMinutesReserved).toBe(1);
    expect(unreconciledBudgetReservations([reserved, reconciled])).toEqual([]);
    expect(unreconciledBudgetReservations([reconciled, reserved])).toEqual([]);
  });

  it("collapses an exact duplicate receipt and rejects a conflicting sequence", () => {
    const reserved = budget("BudgetReserved", 1, 600_000);
    expect(deriveBudgetUsage([reserved, reserved]).sandboxMinutesReserved).toBe(10);
    expect(() => deriveBudgetUsage([reserved, budget("BudgetReserved", 1, 300_000)])).toThrow(
      /conflicting Factory events/i,
    );
  });

  it("adds distinct model calls by usage identity across restart reconstruction", () => {
    const compile = budget("BudgetReconciled", 1, 100, {
      unit: "model_tokens",
      phase: "management",
      usageId: "compile-base-a",
    });
    const review = budget("BudgetReconciled", 2, 200, {
      unit: "model_tokens",
      phase: "management",
      usageId: "review-artifact-b",
    });
    const replayed = [review, compile, review];
    expect(deriveBudgetUsage(replayed).modelTokens).toBe(300);
    expect(
      remainingBudget(
        {
          ...DEFAULT_RUN_POLICY,
          economics: {
            maxModelTokens: 250,
            maxSandboxMinutes: 0,
            maxManagedSessions: 0,
            minCloudTimeSavedMinutes: 0,
          },
        },
        deriveBudgetUsage(replayed),
      ).modelTokens,
    ).toBe(0);
  });
});
