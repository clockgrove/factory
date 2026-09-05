import { describe, expect, it } from "vitest";
import type { FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { assessRecoveryAccounting } from "../src/recovery/accounting.js";

const policy = {
  ...DEFAULT_RUN_POLICY,
  maxSandboxMinutes: 10,
  maxManagedAgentSessions: 2,
  economics: {
    maxModelTokens: 1000,
    maxSandboxMinutes: 10,
    maxManagedSessions: 2,
    minCloudTimeSavedMinutes: 0,
  },
};
const digest = policyDigest(policy);
const common = (runId: string, sequence: number) => ({
  protocol: "clockgrove.factory/v2" as const,
  objective: 1,
  runId,
  sequence,
  at: "2026-09-04T00:00:00.000Z",
});
function history(runId: string, offset = 0): FactoryEvent[] {
  return [
    {
      ...common(runId, offset),
      kind: "run",
      event: "FactoryRunStarted",
      actor: "owner",
      repository: "example/fixture",
      objectiveAuthor: "owner",
      fork: false,
      baseBranch: "main",
      policy,
      policyDigest: digest,
    },
    {
      ...common(runId, offset + 1),
      kind: "budget",
      event: "BudgetReconciled",
      phase: "management",
      unit: "model_tokens",
      amount: 10,
      usageId: `compile-${"c".repeat(64)}`,
    },
    {
      ...common(runId, offset + 99),
      kind: "run",
      event: "FactoryRunEscalated",
      reason: "bounded fixture",
    },
  ];
}
function worker(runId: string, offset = 0, tokens = 20): FactoryEvent[] {
  const attempt = {
    ...common(runId, offset + 2),
    kind: "attempt" as const,
    workItem: 2,
    attempt: 1,
    backend: "codex-sdk/local-worktree",
    baseSha: "a".repeat(40),
    directorEpoch: 1,
    policyDigest: digest,
  };
  return [
    { ...attempt, event: "AttemptStarted" },
    {
      ...common(runId, offset + 3),
      kind: "budget",
      event: "BudgetReconciled",
      workItem: 2,
      attempt: 1,
      phase: "execution",
      unit: "model_tokens",
      amount: tokens,
      usageId: "worker-2-1",
    },
    { ...attempt, sequence: offset + 4, event: "AttemptSucceeded", reportedModelTokens: tokens },
  ];
}
const assess = (events = history("one"), runIds = ["one"]) =>
  assessRecoveryAccounting({ objective: 1, repository: "example/fixture", events, runIds, policy });
const codes = (result: ReturnType<typeof assess>) => result.blockers.map((blocker) => blocker.code);

describe("historical successor accounting assessment", () => {
  it("adds distinct run/usage identities without mutating source receipts or granting authority", () => {
    const events = [
      ...history("one"),
      ...worker("one"),
      ...history("two", 100),
      ...worker("two", 100),
    ];
    const before = structuredClone(events);
    const result = assess([...events, ...events], ["one", "two"]);
    expect(result.scope).toBe("historical-assessment");
    expect(result.usage?.modelTokens).toBe(60);
    expect(result.remaining?.modelTokens).toBe(940);
    expect(result.attemptCounts).toEqual([
      {
        workItem: 2,
        count: 2,
        remaining: 1,
        sourcesTruncated: false,
        sources: [
          { runId: "one", attempt: 1 },
          { runId: "two", attempt: 1 },
        ],
      },
    ]);
    expect(result.unknownModelUsage).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(events).toEqual(before);
  });
  it.each(
    [
      [],
      ["one", "one"],
      ["one", "two", "one"],
      Array.from({ length: 101 }, (_, i) => `run-${i}`),
    ].map((runIds) => ({ runIds })),
  )("rejects empty, cyclic/duplicate or unbounded run selection $runIds", ({ runIds }) => {
    const result = assess(history("one"), runIds);
    expect(result.usage).toBeNull();
    expect(codes(result)).toContain("invalid-history-selection");
  });
  it("requires every selected run's start and terminal and chronological selection", () => {
    for (const events of [
      history("one").filter((event) => event.event !== "FactoryRunStarted"),
      history("one").filter((event) => event.event !== "FactoryRunEscalated"),
      [...history("one"), { ...history("one")[0]!, sequence: 2 }],
      [
        ...history("one"),
        { ...common("one", 98), kind: "run" as const, event: "FactoryRunCompleted" as const },
      ],
    ])
      expect(codes(assess(events))).toContain("invalid-run-history");
    expect(codes(assess([...history("one"), ...history("two", 100)], ["two", "one"]))).toContain(
      "invalid-run-history",
    );
    expect(codes(assess(history("one"), ["one", "absent"]))).toContain("invalid-run-history");
  });
  it("rejects different repository, Objective, policy digest and changed policy ceilings", () => {
    const foreign = history("one");
    Object.assign(foreign[0]!, { repository: "different/fixture" });
    expect(codes(assess(foreign))).toContain("invalid-run-history");
    expect(codes(assess(history("one").map((event) => ({ ...event, objective: 2 }))))).toContain(
      "history-binding-mismatch",
    );
    const differentDigest = history("one");
    Object.assign(differentDigest[0]!, { policyDigest: "b".repeat(64) });
    expect(codes(assess(differentDigest))).toContain("invalid-run-history");
    const changed = history("one");
    Object.assign(changed[0]!, { policy: { ...policy, maxAttemptsPerItem: 10 } });
    expect(codes(assess(changed))).toContain("invalid-run-history");
  });
  it("preserves source-bound usage across legitimately different historical policies without granting increased ceilings", () => {
    const events = [
      ...history("one"),
      ...worker("one"),
      ...history("two", 100),
      ...worker("two", 100),
    ];
    const otherPolicy = { ...policy, economics: { ...policy.economics, maxModelTokens: 2000 } };
    for (const event of events.filter((candidate) => candidate.runId === "two")) {
      if ("policyDigest" in event) event.policyDigest = policyDigest(otherPolicy);
      if (event.kind === "run" && event.event === "FactoryRunStarted") event.policy = otherPolicy;
    }
    const result = assess(events, ["one", "two"]);
    expect(result.usage?.modelTokens).toBe(60);
    expect(result.remaining?.modelTokens).toBe(940);
    expect(codes(result)).toEqual(["historical-policy-difference"]);
    Object.assign(
      events.find((event) => event.runId === "two" && event.event === "AttemptStarted")!,
      { policyDigest: digest },
    );
    expect(assess(events, ["one", "two"]).usage).toBeNull();
  });
  it("rejects conflicting duplicate receipts instead of choosing a convenient amount", () => {
    const events = history("one");
    const conflict = { ...events[1]!, amount: 0 } as FactoryEvent;
    const result = assess([...events, conflict]);
    expect(result.usage).toBeNull();
    expect(codes(result)).toContain("invalid-receipts-or-policy");
  });
  it("preserves genuine zero counters and missing historical breakdowns", () => {
    const events = [...history("one"), ...worker("one", 0, 0)];
    const result = assess(events);
    expect(result.usage?.modelTokens).toBe(10);
    expect(result.unknownModelUsage).toEqual([]);
    expect(events.some((event) => "reportedModelUsage" in event)).toBe(false);
  });
  it("reports missing counters and missing reconciliations without silently declaring zero usage", () => {
    const events = [...history("one"), ...worker("one")];
    const terminal = events.find((event) => event.event === "AttemptSucceeded")!;
    Reflect.deleteProperty(terminal, "reportedModelTokens");
    const result = assess(events);
    expect(result.usage?.modelTokens).toBe(30);
    expect(result.unknownModelUsage).toEqual([
      expect.objectContaining({ runId: "one", workItem: 2, attempt: 1, phase: "execution" }),
    ]);
    expect(codes(result)).toContain("unknown-model-usage");
    const missing = assess([
      ...history("one"),
      ...worker("one").filter((event) => event.kind !== "budget"),
    ]);
    expect(missing.usage?.modelTokens).toBe(10);
    expect(codes(missing)).toContain("unknown-model-usage");
    expect(
      assess(history("one").filter((event) => event.kind !== "budget")).unknownModelUsage[0]?.phase,
    ).toBe("management");
  });
  it("reports contradictory worker counters without hiding the recorded subtotal", () => {
    const events = [...history("one"), ...worker("one")];
    Object.assign(events.find((event) => event.event === "AttemptSucceeded")!, {
      reportedModelTokens: 21,
    });
    const result = assess(events);
    expect(result.usage?.modelTokens).toBe(30);
    expect(codes(result)).toContain("conflicting-worker-usage");
  });
  it("reports missing semantic-review counters even when compilation usage is known", () => {
    const events = [...history("one"), ...worker("one")];
    const terminal = events.find((event) => event.event === "AttemptSucceeded")!;
    events.push({ ...terminal, event: "AttemptValidated", sequence: 5 } as FactoryEvent);
    expect(assess(events).unknownModelUsage).toEqual([
      expect.objectContaining({ runId: "one", workItem: 2, phase: "management" }),
    ]);
  });
  it("bounds missing-usage diagnostics without hiding incomplete coverage", () => {
    const events = history("one");
    for (let attempt = 1; attempt <= 250; attempt++) {
      events.push(
        ...worker("one", 0, 0)
          .filter((event) => event.kind === "attempt")
          .map((event) => {
            const value = { ...event, attempt, sequence: attempt * 2 + event.sequence };
            Reflect.deleteProperty(value, "reportedModelTokens");
            return value;
          }),
      );
    }
    const result = assess(events);
    expect(result.unknownModelUsageCount).toBe(250);
    expect(result.unknownModelUsage).toHaveLength(200);
    expect(result.diagnosticsTruncated).toBe(true);
    expect(codes(result)).toContain("unknown-model-usage");
  });
  it.each([
    { workItem: 2, attempt: 1, usageId: `review-${"d".repeat(64)}` },
    { workItem: 2, attempt: 1, usageId: `compile-${"d".repeat(64)}` },
    { attempt: 1, usageId: `compile-${"d".repeat(64)}` },
    { usageId: `review-${"d".repeat(64)}` },
    { usageId: "compile-not-a-digest" },
    { usageId: "failed-compile-not-a-base" },
  ])("does not mistake unrelated management receipt %j for compilation coverage", (fields) => {
    const events = history("one");
    Object.assign(events[1]!, fields);
    const result = assess(events);
    expect(result.usage?.modelTokens).toBe(10);
    expect(result.unknownModelUsageCount).toBe(1);
    expect(result.unknownModelUsage[0]?.reason).toContain("compilation");
  });
  it("recognizes Objective-scoped failed compilation counters including observed zero", () => {
    const events = history("one");
    Object.assign(events[1]!, { usageId: `failed-compile-${"a".repeat(40)}`, amount: 0 });
    const result = assess(events);
    expect(result.usage?.modelTokens).toBe(0);
    expect(result.unknownModelUsageCount).toBe(0);
  });
  it("bounds reservation details but retains every original liability in totals and count", () => {
    const events = history("one");
    for (let index = 0; index < 150; index++)
      events.push({
        ...common("one", 10 + index),
        kind: "budget",
        event: "BudgetReserved",
        phase: "execution",
        unit: "sandbox_milliseconds",
        amount: 60_000,
        workItem: 2,
        attempt: index + 1,
        usageId: `reservation-${index}`,
        privateExtension: "must-not-appear-in-report",
      });
    const result = assess(events);
    expect(result.usage?.sandboxMinutesReserved).toBe(150);
    expect(result.remaining?.sandboxMinutes).toBe(0);
    expect(result.unreconciledReservationCount).toBe(150);
    expect(result.unreconciledReservations).toHaveLength(100);
    expect(result.unreconciledReservationsTruncated).toBe(true);
    expect(result.unreconciledReservations[0]).toMatchObject({
      runId: "one",
      workItem: 2,
      attempt: 1,
      usageId: "reservation-0",
      sequence: 10,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-appear-in-report");
    expect(codes(result)).toEqual(
      expect.arrayContaining(["unreconciled-budget-reservations", "sandbox-minute-limit"]),
    );
  });
  it("caps item and source details after computing all attempt limits and unknown counters", () => {
    const events = history("one");
    for (let workItem = 2; workItem < 112; workItem++) {
      for (let attempt = 1; attempt <= 25; attempt++) {
        const generated = worker("one").filter((event) => event.kind === "attempt");
        events.push(
          ...generated.map((event) => {
            const value = {
              ...event,
              workItem,
              attempt,
              sequence: workItem * 100 + attempt * 3 + event.sequence,
            };
            Reflect.deleteProperty(value, "reportedModelTokens");
            return value;
          }),
        );
      }
    }
    const result = assess(events);
    expect(result.attemptCount).toBe(2750);
    expect(result.attemptWorkItemCount).toBe(110);
    expect(result.attemptCounts).toHaveLength(100);
    expect(result.attemptCountsTruncated).toBe(true);
    expect(result.attemptCounts[0]).toMatchObject({
      count: 25,
      remaining: 0,
      sourcesTruncated: true,
    });
    expect(result.attemptCounts[0]?.sources).toHaveLength(20);
    expect(result.unknownModelUsageCount).toBe(2750);
    expect(result.unknownModelUsage).toHaveLength(200);
    expect(result.blockerCount).toBe(111);
    expect(result.blockers.some((blocker) => blocker.workItem === 111)).toBe(true);
  });
  it("carries original outstanding reservations through terminal runs and later unrelated reconciliation", () => {
    const reserved: FactoryEvent = {
      ...common("one", 4),
      kind: "budget",
      event: "BudgetReserved",
      phase: "execution",
      unit: "sandbox_milliseconds",
      amount: 120_000,
      workItem: 2,
      attempt: 1,
      usageId: "same",
    };
    const unrelated = {
      ...reserved,
      runId: "two",
      sequence: 104,
      event: "BudgetReconciled" as const,
      amount: 30_000,
    };
    const result = assess(
      [...history("one"), ...history("two", 100), reserved, unrelated],
      ["one", "two"],
    );
    expect(result.usage?.sandboxMinutesReserved).toBe(2.5);
    expect(result.remaining?.sandboxMinutes).toBe(7.5);
    expect(result.unreconciledReservations).toEqual([reserved]);
    expect(codes(result)).toContain("unreconciled-budget-reservations");
  });
  it("reconciles only the exact original budget identity", () => {
    const reserved: FactoryEvent = {
      ...common("one", 4),
      kind: "budget",
      event: "BudgetReserved",
      phase: "validation",
      unit: "sandbox_milliseconds",
      amount: 120_000,
      workItem: 2,
      attempt: 1,
    };
    const settled = {
      ...reserved,
      sequence: 5,
      event: "BudgetReconciled" as const,
      amount: 60_000,
    };
    const result = assess([...history("one"), reserved, reserved, settled]);
    expect(result.usage?.sandboxMinutesReserved).toBe(1);
    expect(result.unreconciledReservations).toEqual([]);
  });
  it("retains consumed attempts and exhausts unchanged cumulative ceilings", () => {
    const events = [0, 100, 200].flatMap((offset, index) => [
      ...history(`run-${index}`, offset),
      ...worker(`run-${index}`, offset, 400),
    ]);
    const result = assess(events, ["run-0", "run-1", "run-2"]);
    expect(result.usage?.modelTokens).toBe(1230);
    expect(result.remaining?.modelTokens).toBe(0);
    expect(result.attemptCounts[0]?.count).toBe(3);
    expect(result.attemptCounts[0]?.remaining).toBe(0);
    expect(codes(result)).toEqual(
      expect.arrayContaining(["model-token-limit", "implementation-attempt-limit"]),
    );
  });
  it("does not charge infrastructure-deferred work against implementation retries, but preserves its usage", () => {
    const events = [...history("one"), ...worker("one")];
    Object.assign(events.find((event) => event.event === "AttemptSucceeded")!, {
      event: "AttemptDeferred",
    });
    const result = assess(events);
    expect(result.attemptCounts).toEqual([]);
    expect(result.usage?.modelTokens).toBe(30);
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects unsafe model token amount %s",
    (amount) => {
      const events = history("one");
      Object.assign(events[1]!, { amount });
      expect(assess(events).usage).toBeNull();
    },
  );
  it("rejects aggregate overflow even when individual native amounts are safe", () => {
    const events = history("one");
    Object.assign(events[1]!, { amount: Number.MAX_SAFE_INTEGER });
    events.push({
      ...common("one", 2),
      kind: "budget",
      event: "BudgetReconciled",
      phase: "management",
      unit: "model_tokens",
      amount: 1,
      usageId: "different",
    });
    expect(codes(assess(events))).toContain("unsafe-budget-arithmetic");
    expect(assess(events).usage).toBeNull();
  });
});
