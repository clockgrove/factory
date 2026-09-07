import { describe, expect, it } from "vitest";
import {
  assertModelInvocationAdmission,
  deriveBudgetUsage,
  isModelInvocationMarker,
  modelInvocationKey,
  remainingBudget,
  unresolvedModelInvocations,
  unreconciledBudgetReservations,
} from "../src/control/budget.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { ModelInvocationScopes } from "../src/control/model-invocations.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "../src/protocol/policy.js";

type BudgetEvent = Extract<FactoryEvent, { kind: "budget" }>;
const invocation = "review-artifact-a";
const policy = parseRunPolicy({
  ...DEFAULT_RUN_POLICY,
  economics: {
    maxModelTokens: 100,
    modelTokenBudgetMode: "observed-stop",
    maxSandboxMinutes: 0,
    maxManagedSessions: 0,
    minCloudTimeSavedMinutes: 0,
  },
});

function budget(
  event: "BudgetReserved" | "BudgetReconciled",
  overrides: Record<string, unknown> = {},
): BudgetEvent {
  const parsed = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "budget",
    event,
    objective: 7,
    runId: "run-a",
    sequence: event === "BudgetReserved" ? 1 : 2,
    at: "2026-09-06T00:00:00.000Z",
    workItem: 8,
    attempt: 1,
    phase: "management",
    unit: "model_tokens",
    amount: event === "BudgetReserved" ? 0 : 30,
    usageId: event === "BudgetReserved" ? `invocation-${invocation}` : "review-checkpoint-a",
    modelInvocationId: invocation,
    ...overrides,
  });
  if (parsed.kind !== "budget") throw new Error("fixture must be a budget event");
  return parsed;
}

describe("durable model dispatch intent", () => {
  it("keeps a zero-valued marker unknown, not known-zero observed usage", () => {
    const marker = budget("BudgetReserved");
    expect(isModelInvocationMarker(marker)).toBe(true);
    // This scalar is a subtotal of recorded consumption, not a claim about the pending call.
    expect(deriveBudgetUsage([marker]).modelTokens).toBe(0);
    expect(unresolvedModelInvocations([marker])).toEqual([marker]);
    expect(unreconciledBudgetReservations([marker])).toEqual([marker]);
    expect(() => assertModelInvocationAdmission([marker], policy)).toThrow(
      /consumption is unknown/,
    );
    expect(() => assertModelInvocationAdmission([marker], DEFAULT_RUN_POLICY)).toThrow(
      /consumption is unknown/,
    );
  });

  it.each([
    { amount: 1 },
    { unit: "sandbox_milliseconds" },
    { phase: "validation" },
    { usageId: "unbound-marker" },
    { usageId: undefined },
    { workItem: undefined },
    { reportedModelUsage: { inputTokens: 0, outputTokens: 0 } },
    { usageEvidence: "as-recorded" },
    { modelInvocationId: "not a safe identifier" },
  ])(
    "rejects a malformed marker rather than assigning it fake budget authority: %j",
    (override) => {
      expect(() => budget("BudgetReserved", override)).toThrow();
    },
  );

  it("rejects a reconciliation disguised as the marker's zero receipt", () => {
    expect(() =>
      budget("BudgetReconciled", {
        amount: 0,
        usageId: `invocation-${invocation}`,
      }),
    ).toThrow();
  });

  it.each([
    { objective: 9 },
    { runId: "run-other" },
    { workItem: 9 },
    { attempt: 2 },
    { phase: "execution" },
    { modelInvocationId: "review-artifact-other" },
    { modelInvocationId: undefined },
  ])("a receipt with a different exact binding cannot close the dispatch: %j", (override) => {
    const marker = budget("BudgetReserved");
    const unrelated = budget("BudgetReconciled", override);
    expect(unresolvedModelInvocations([marker, unrelated])).toEqual([marker]);
    expect(() => assertModelInvocationAdmission([marker, unrelated], policy)).toThrow(
      /consumption is unknown/,
    );
  });

  it("collapses exact and equivalent marker replay, but rejects a conflicting authenticated sequence", () => {
    const marker = budget("BudgetReserved");
    const repeated = budget("BudgetReserved", { sequence: 2 });
    expect(unresolvedModelInvocations([marker, marker])).toEqual([marker]);
    expect(unresolvedModelInvocations([marker, repeated])).toHaveLength(1);
    expect(deriveBudgetUsage([marker, marker, repeated]).modelTokens).toBe(0);
    // Phase belongs to the receipt identity, so another phase is not a payload
    // conflict at this sequence. A different binding in the SAME scope is.
    expect(
      unresolvedModelInvocations([marker, budget("BudgetReserved", { phase: "execution" })]),
    ).toHaveLength(2);
    expect(() =>
      unresolvedModelInvocations([
        marker,
        budget("BudgetReserved", { policyDigest: "a".repeat(64), directorEpoch: 1 }),
      ]),
    ).toThrow(/conflicting Factory events/i);
  });

  it.each([0, 30, 175])(
    "closes only with actual counters and never clamps %i tokens to the threshold",
    (amount) => {
      const marker = budget("BudgetReserved");
      const actual = budget("BudgetReconciled", {
        amount,
        reportedModelUsage: { inputTokens: amount, outputTokens: 0, cachedInputTokens: 0 },
      });
      expect(isModelInvocationMarker(actual)).toBe(false);
      expect(unresolvedModelInvocations([actual, marker, actual])).toEqual([]);
      expect(unreconciledBudgetReservations([actual, marker, actual])).toEqual([]);
      const usage = deriveBudgetUsage([actual, marker, actual]);
      expect(usage.modelTokens).toBe(amount);
      expect(remainingBudget(policy, usage).modelTokens).toBe(Math.max(0, 100 - amount));
      if (amount >= 100)
        expect(() => assertModelInvocationAdmission([marker, actual], policy)).toThrow(
          /threshold is exhausted/,
        );
      else expect(() => assertModelInvocationAdmission([marker, actual], policy)).not.toThrow();
    },
  );

  it.each([{ amount: 31 }, { usageId: "different-paid-call" }])(
    "rejects conflicting actual accounting for one dispatch: %j",
    (override) => {
      const marker = budget("BudgetReserved");
      const actual = budget("BudgetReconciled");
      const conflicting = budget("BudgetReconciled", { sequence: 3, ...override });
      expect(() => unresolvedModelInvocations([marker, actual, conflicting])).toThrow(
        /conflicting actual usage/,
      );
      expect(() => assertModelInvocationAdmission([marker, actual, conflicting], policy)).toThrow(
        /conflicting actual usage/,
      );
    },
  );

  it.each([
    { directorEpoch: 2, policyDigest: "a".repeat(64) },
    { directorEpoch: 1, policyDigest: "b".repeat(64) },
  ])("rejects changed supplied immutable marker bindings: %j", (override) => {
    const marker = budget("BudgetReserved", { directorEpoch: 1, policyDigest: "a".repeat(64) });
    const conflicting = budget("BudgetReserved", { sequence: 2, ...override });
    expect(() => unresolvedModelInvocations([marker, conflicting])).toThrow(
      /conflicting dispatch bindings/,
    );
  });

  it.each([false, true])(
    "does not use accounting preceding a dispatch as replacement authority (reversed input: %s)",
    (reversed) => {
      const actual = budget("BudgetReconciled", { sequence: 1 });
      const marker = budget("BudgetReserved", { sequence: 2 });
      const events = reversed ? [marker, actual] : [actual, marker];
      expect(unresolvedModelInvocations(events)).toEqual([marker]);
      expect(deriveBudgetUsage(events).modelTokens).toBe(30);
      expect(() => assertModelInvocationAdmission(events, policy)).toThrow(
        /consumption is unknown/,
      );
    },
  );

  it.each([false, true])(
    "keeps the earliest equivalent marker binding across receipt replay (reversed input: %s)",
    (reversed) => {
      const marker = budget("BudgetReserved");
      const actual = budget("BudgetReconciled");
      const duplicate = budget("BudgetReserved", { sequence: 3 });
      const events = reversed ? [duplicate, actual, marker] : [marker, actual, duplicate];
      expect(unresolvedModelInvocations(events)).toEqual([]);
      expect(unreconciledBudgetReservations(events)).toEqual([]);
      expect(deriveBudgetUsage(events).modelTokens).toBe(30);
      expect(() => assertModelInvocationAdmission(events, policy)).not.toThrow();
    },
  );

  it.each([
    { directorEpoch: 2, policyDigest: "a".repeat(64) },
    { directorEpoch: 1, policyDigest: "b".repeat(64) },
    { directorEpoch: undefined, policyDigest: undefined },
  ])("cannot discharge the invocation using a changed or missing source binding: %j", (binding) => {
    const original = { directorEpoch: 1, policyDigest: "a".repeat(64) };
    const marker = budget("BudgetReserved", original);
    const actual = budget("BudgetReconciled", binding);
    expect(() => unresolvedModelInvocations([marker, actual])).toThrow(
      /usage conflicts with its dispatch binding/,
    );
    expect(() => assertModelInvocationAdmission([marker, actual], policy)).toThrow(
      /usage conflicts with its dispatch binding/,
    );
    expect(unresolvedModelInvocations([marker, budget("BudgetReconciled", original)])).toEqual([]);
  });

  it("distinguishes active process ownership from restart and missing accounting", () => {
    const marker = budget("BudgetReserved");
    const identity = { ...marker, modelInvocationId: invocation };
    const active = new Set([modelInvocationKey(identity)]);
    expect(() => assertModelInvocationAdmission([marker], policy, active)).not.toThrow();
    // An active set is explicitly process-local; serialized history contains no such authority.
    const restarted = JSON.parse(JSON.stringify([marker])).map(parseFactoryEvent);
    expect(() => assertModelInvocationAdmission(restarted, policy)).toThrow(
      /consumption is unknown/,
    );
    expect(() =>
      assertModelInvocationAdmission(
        [marker],
        policy,
        new Set([modelInvocationKey({ ...identity, attempt: 2 })]),
      ),
    ).toThrow(/consumption is unknown/);
    expect(() =>
      assertModelInvocationAdmission([marker, budget("BudgetReconciled")], policy),
    ).not.toThrow();
    expect(unresolvedModelInvocations([marker], "run-other")).toEqual([]);
    expect(unresolvedModelInvocations([marker], "run-a")).toEqual([marker]);
  });

  it("keeps historical unlinked usage readable, but cannot use it to resolve a new marker", () => {
    const historical = budget("BudgetReconciled", { sequence: 1, modelInvocationId: undefined });
    expect(deriveBudgetUsage([historical]).modelTokens).toBe(30);
    expect(unresolvedModelInvocations([historical])).toEqual([]);
    const marker = budget("BudgetReserved", { sequence: 2 });
    expect(unresolvedModelInvocations([historical, marker])).toEqual([marker]);
    expect(() => assertModelInvocationAdmission([historical, marker], policy)).toThrow(
      /consumption is unknown/,
    );
  });

  it("does not let live-marker ownership bypass unsupported hard intent", () => {
    const marker = budget("BudgetReserved");
    const hard = parseRunPolicy({
      ...policy,
      economics: { ...policy.economics!, modelTokenBudgetMode: "hard" },
    });
    expect(() =>
      assertModelInvocationAdmission(
        [marker],
        hard,
        new Set([modelInvocationKey({ ...marker, modelInvocationId: invocation })]),
      ),
    ).toThrow(/hard is unsupported/);
  });

  it("releases only process-local ownership after a failed operation, not its durable dispatch liability", async () => {
    const marker = budget("BudgetReserved");
    const key = modelInvocationKey({ ...marker, modelInvocationId: invocation });
    const scopes = new ModelInvocationScopes();
    expect(() => scopes.claim(key)).toThrow(/owned operation scope/);
    await expect(
      scopes.run(async () => {
        scopes.claim(key);
        expect(() => scopes.claim(key)).toThrow(/already active/);
        expect(() => assertModelInvocationAdmission([marker], policy, scopes.active)).not.toThrow();
        const restarted = new ModelInvocationScopes();
        expect(() => assertModelInvocationAdmission([marker], policy, restarted.active)).toThrow(
          /consumption is unknown/,
        );
        throw new Error("terminal accounting response was lost");
      }),
    ).rejects.toThrow(/accounting response was lost/);
    expect(scopes.active.size).toBe(0);
    expect(unresolvedModelInvocations([marker])).toEqual([marker]);
    expect(() => assertModelInvocationAdmission([marker], policy, scopes.active)).toThrow(
      /consumption is unknown/,
    );
  });

  it("does not discharge another concurrently owned call when one operation completes", async () => {
    const scopes = new ModelInvocationScopes();
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = scopes.run(async () => {
      scopes.claim("first");
      await release;
    });
    await scopes.run(async () => {
      scopes.claim("second");
      expect([...scopes.active].sort()).toEqual(["first", "second"]);
    });
    expect([...scopes.active]).toEqual(["first"]);
    releaseFirst();
    await first;
    expect(scopes.active.size).toBe(0);
  });
});
