import { describe, expect, it } from "vitest";

import {
  deriveBudgetUsage,
  unreconciledBudgetReservations,
} from "../src/control/budget.js";
import type { FactoryEvent } from "../src/protocol/events.js";

function budget(
  event: "BudgetReserved" | "BudgetReconciled",
  sequence: number,
  amount: number,
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
    phase: "execution",
    unit: "sandbox_milliseconds",
    amount,
  };
}

describe("budget ledger", () => {
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
    expect(() => deriveBudgetUsage([
      reserved,
      budget("BudgetReserved", 1, 300_000),
    ])).toThrow(/conflicting Factory events/i);
  });
});
