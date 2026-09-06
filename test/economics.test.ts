import { describe, expect, it } from "vitest";

import {
  estimateDuration,
  modelTokenBreakdown,
  summarizeEconomics,
  summarizeRun,
  type DurationEvidenceSample,
  type DurationFingerprint,
  type ProviderBillingEvidence,
} from "../src/economics/index.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const query: DurationFingerprint = {
  taskClass: "typescript-library",
  backendId: "codex-cli/local-worktree",
  trust: "trusted_local",
  os: ["linux"],
  architecture: ["x64"],
  tools: ["node", "npm"],
};

function sample(
  evidenceId: string,
  durationMs: number,
  overrides: Partial<DurationEvidenceSample> = {},
): DurationEvidenceSample {
  return {
    ...query,
    evidenceId,
    completedAt: `2026-09-04T12:0${evidenceId.length}:00.000Z`,
    durationMs,
    outcome: "succeeded",
    durable: true,
    ...overrides,
  };
}

const sha = "a".repeat(40);
const digest = "b".repeat(64);

function event(value: Record<string, unknown>): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "run-7",
    at: "2026-09-04T12:00:00.000Z",
    ...value,
  });
}

function modelReceipt(sequence: number, overrides: Record<string, unknown> = {}): FactoryEvent {
  return event({
    kind: "budget",
    event: "BudgetReconciled",
    sequence,
    phase: "management",
    unit: "model_tokens",
    amount: 100,
    usageId: `call-${sequence}`,
    ...overrides,
  });
}

function runEvidence(): FactoryEvent[] {
  const commonAttempt = {
    kind: "attempt",
    workItem: 8,
    attempt: 1,
    backend: "codex-cli/local-worktree",
    baseSha: sha,
    directorEpoch: 1,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
  };
  return [
    event({
      kind: "run",
      event: "FactoryRunStarted",
      sequence: 1,
      actor: "operator",
      repository: "clockgrove/factory",
      objectiveAuthor: "operator",
      fork: false,
      baseBranch: "main",
      policy: DEFAULT_RUN_POLICY,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    }),
    event({
      ...commonAttempt,
      event: "AttemptReserved",
      sequence: 2,
      admissionClass: "local",
      admissionReason: "local-capacity",
      requestedCpu: 1,
      requestedMemoryMb: 2_048,
      priorityRank: 1,
      subIssuePosition: 0,
      criticalPathLength: 0,
      unfinishedDownstream: 0,
    }),
    event({
      kind: "budget",
      event: "BudgetReserved",
      sequence: 3,
      workItem: 8,
      attempt: 1,
      phase: "execution",
      unit: "local_milliseconds",
      amount: 60_000,
    }),
    event({ ...commonAttempt, event: "AttemptStarted", sequence: 4 }),
    event({ ...commonAttempt, event: "AttemptSucceeded", sequence: 5, headSha: sha }),
    event({
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 6,
      workItem: 8,
      attempt: 1,
      phase: "execution",
      unit: "local_milliseconds",
      amount: 45_000,
    }),
    event({
      kind: "validation",
      event: "ValidationRecorded",
      sequence: 7,
      workItem: 8,
      attempt: 1,
      baseSha: sha,
      outputTreeSha: sha,
      passed: true,
      evidenceDigest: digest,
    }),
    event({
      kind: "delivery",
      event: "DeliverySelected",
      sequence: 8,
      requested: "regular-prs",
      selected: "regular-prs",
      capabilityVersion: "rest-v1",
      reason: "configured regular delivery",
    }),
    event({
      kind: "publication",
      event: "PublicationRecorded",
      sequence: 9,
      workItem: 8,
      attempt: 1,
      unitId: "unit-8",
      itemId: "item-8",
      mode: "regular-prs",
      position: 0,
      branch: "factory/item-8",
      baseBranch: "main",
      baseSha: sha,
      headSha: sha,
      pullRequest: 99,
      capabilityVersion: "rest-v1",
      validationDigest: digest,
      exactHeadValidationDigest: digest,
    }),
    event({ ...commonAttempt, event: "AttemptIntegrated", sequence: 10, headSha: sha }),
    event({
      kind: "run",
      event: "FactoryRunCompleted",
      sequence: 11,
      at: "2026-09-04T12:01:00.000Z",
    }),
  ];
}

describe("conservative economic feedback", () => {
  it("reports partial token subtotals with explicit coverage and leaves missing cache unknown", () => {
    const summary = summarizeEconomics({
      events: [
        modelReceipt(1, {
          reportedModelUsage: { inputTokens: 80, outputTokens: 20, cachedInputTokens: 60 },
        }),
        modelReceipt(2, { reportedModelUsage: { inputTokens: 90, outputTokens: 10 } }),
        modelReceipt(3),
      ],
      policy: DEFAULT_RUN_POLICY,
    });
    expect(summary.modelTokenBreakdown).toEqual({
      source: "model-token-reconciliations",
      reconciledCalls: 3,
      inputTokens: {
        tokens: {
          availability: "observed",
          value: 170,
          source: "github-receipts",
          evidenceCount: 2,
        },
        receiptsWithValue: 2,
        receiptsWithoutValue: 1,
      },
      outputTokens: {
        tokens: {
          availability: "observed",
          value: 30,
          source: "github-receipts",
          evidenceCount: 2,
        },
        receiptsWithValue: 2,
        receiptsWithoutValue: 1,
      },
      cachedInputTokens: {
        tokens: {
          availability: "observed",
          value: 60,
          source: "github-receipts",
          evidenceCount: 1,
        },
        receiptsWithValue: 1,
        receiptsWithoutValue: 2,
      },
    });
    expect(summary.usage.model_tokens).toMatchObject({ availability: "observed", value: 300 });
    expect(summary.providerCost.availability).toBe("unavailable");
  });

  it("does not count duplicate or Attempt copies, reservations, other units, or other runs", () => {
    const reportedModelUsage = { inputTokens: 80, outputTokens: 20, cachedInputTokens: 0 };
    const receipt = modelReceipt(1, { reportedModelUsage });
    const summary = modelTokenBreakdown(
      [
        receipt,
        receipt,
        modelReceipt(2, { event: "BudgetReserved" }),
        modelReceipt(3, { runId: "other-run", reportedModelUsage }),
        modelReceipt(4, { phase: "execution", unit: "local_milliseconds" }),
        event({
          kind: "attempt",
          event: "AttemptSucceeded",
          sequence: 5,
          workItem: 8,
          attempt: 1,
          backend: "codex-sdk/local-worktree",
          baseSha: sha,
          directorEpoch: 1,
          policyDigest: policyDigest(DEFAULT_RUN_POLICY),
          reportedModelTokens: 100,
          reportedModelUsage,
        }),
      ],
      "run-7",
    );
    expect(summary.reconciledCalls).toBe(1);
    expect(summary.inputTokens.tokens).toMatchObject({ availability: "observed", value: 80 });
    expect(summary.cachedInputTokens).toMatchObject({
      tokens: { availability: "observed", value: 0, evidenceCount: 1 },
      receiptsWithValue: 1,
      receiptsWithoutValue: 0,
    });
  });

  it("uses the scalar ledger's latest usage identity without combining old breakdowns", () => {
    const receipts = [
      modelReceipt(2, { usageId: "compile" }),
      modelReceipt(1, {
        usageId: "compile",
        reportedModelUsage: { inputTokens: 80, outputTokens: 20, cachedInputTokens: 60 },
      }),
    ];
    const summary = summarizeEconomics({ events: receipts, policy: DEFAULT_RUN_POLICY });
    expect(summary.modelTokenBreakdown.reconciledCalls).toBe(1);
    expect(summary.modelTokenBreakdown.inputTokens).toMatchObject({
      tokens: { availability: "unavailable" },
      receiptsWithValue: 0,
      receiptsWithoutValue: 1,
    });
    expect(summary.usage.model_tokens).toMatchObject({ availability: "observed", value: 100 });
  });

  it("never infers input from a scalar total or treats an empty ledger as zero usage", () => {
    const partial = modelTokenBreakdown([
      modelReceipt(1, { reportedModelUsage: { outputTokens: 20 } }),
    ]);
    expect(partial.inputTokens.tokens.availability).toBe("unavailable");
    expect(partial.outputTokens.tokens).toMatchObject({ availability: "observed", value: 20 });
    const empty = modelTokenBreakdown([]);
    expect(empty.reconciledCalls).toBe(0);
    expect(empty.cachedInputTokens).toMatchObject({
      tokens: { availability: "unavailable" },
      receiptsWithValue: 0,
      receiptsWithoutValue: 0,
    });
  });

  it("uses only exact, durable successful duration matches and widens sparse evidence", () => {
    const result = estimateDuration(query, [
      sample("a", 40_000),
      sample("b", 50_000),
      sample("wrong-backend", 500_000, { backendId: "codex-cli/daytona" }),
      sample("failed", 800_000, { outcome: "failed" }),
      sample("ephemeral", 900_000, { durable: false }),
    ]);
    expect(result.matchingEvidenceIds).toEqual(["a", "b"]);
    expect(result.durationMs).toEqual({
      availability: "conservative-estimate",
      value: 62_500,
      source: "matching-history",
      evidenceCount: 2,
      method: "slowest matching success plus 25% sparse-evidence margin",
    });
  });

  it("reports duration as unavailable when no exact evidence matches", () => {
    expect(
      estimateDuration(query, [sample("other", 10_000, { os: ["darwin"] })]).durationMs
        .availability,
    ).toBe("unavailable");
  });

  it("never turns absent usage or billing receipts into zero-valued facts", () => {
    const economics = summarizeEconomics({
      events: [],
      policy: DEFAULT_RUN_POLICY,
    });
    expect(economics.usage.model_tokens.availability).toBe("unavailable");
    expect(economics.usage.sandbox_milliseconds.availability).toBe("unavailable");
    expect(economics.providerCost).toEqual({
      availability: "unavailable",
      reason: "no provider billing receipt is present; Factory does not infer dollar cost",
    });
  });

  it("counts exact provider billing receipt replays once without changing native or model ledgers", () => {
    const receipt = {
      provider: "provider-a",
      receiptId: "receipt-1",
      amount: 2.5,
      currency: "USD",
    };
    const input = { events: runEvidence(), policy: DEFAULT_RUN_POLICY };
    const summary = summarizeEconomics({ ...input, billing: [receipt, { ...receipt }, receipt] });
    expect(summary.providerCost).toEqual({
      availability: "observed",
      value: [{ provider: "provider-a", amount: 2.5, currency: "USD" }],
      source: "provider-receipt",
      evidenceCount: 1,
    });
    expect({ ...summary, providerCost: undefined }).toEqual({
      ...summarizeEconomics(input),
      providerCost: undefined,
    });
  });

  it.each([{ amount: 3 }, { currency: "EUR" }])(
    "rejects conflicting receipt replays regardless of input order: %j",
    (change) => {
      const receipt = {
        provider: "provider-a",
        receiptId: "receipt-1",
        amount: 2.5,
        currency: "USD",
      };
      const conflicting = { ...receipt, ...change };
      for (const billing of [
        [receipt, conflicting],
        [conflicting, receipt],
        [receipt, conflicting, receipt],
      ]) {
        expect(
          summarizeEconomics({ events: [], policy: DEFAULT_RUN_POLICY, billing }).providerCost,
        ).toEqual({
          availability: "unavailable",
          reason: "conflicting provider billing receipts share one provider/receipt identity",
        });
      }
    },
  );

  it("keeps distinct providers, receipts, and currencies separate without delimiter identity collisions", () => {
    const billing = [
      { provider: "a", receiptId: "b:c", amount: 2, currency: "USD" },
      { provider: "a:b", receiptId: "c", amount: 3, currency: "USD" },
      { provider: "a", receiptId: "other", amount: 4, currency: "USD" },
      { provider: "a", receiptId: "euro", amount: 5, currency: "EUR" },
      { provider: "z", receiptId: "b:c", amount: 0, currency: "USD" },
    ];
    expect(
      summarizeEconomics({ events: [], policy: DEFAULT_RUN_POLICY, billing }).providerCost,
    ).toEqual({
      availability: "observed",
      value: [
        { provider: "a", amount: 5, currency: "EUR" },
        { provider: "a", amount: 6, currency: "USD" },
        { provider: "a:b", amount: 3, currency: "USD" },
        { provider: "z", amount: 0, currency: "USD" },
      ],
      source: "provider-receipt",
      evidenceCount: 5,
    });
  });

  it.each([NaN, Infinity, -Infinity, -1])(
    "keeps invalid billing amount %s unavailable, not a partial total",
    (amount) => {
      const receipt = { provider: "provider-a", receiptId: "receipt-1", amount: 2, currency: "USD" };
      const billing = [receipt, { ...receipt, amount }];
      expect(
        summarizeEconomics({ events: [], policy: DEFAULT_RUN_POLICY, billing }).providerCost,
      ).toMatchObject({ availability: "unavailable" });
    },
  );

  it.each([{ provider: "" }, { receiptId: "" }, { currency: "usd" }])(
    "does not report partial cost when supplied billing identity is invalid: %j",
    (change) => {
      const receipt = { provider: "provider-a", receiptId: "receipt-1", amount: 2, currency: "USD" };
      const billing = [receipt, { ...receipt, ...change }];
      expect(
        summarizeEconomics({ events: [], policy: DEFAULT_RUN_POLICY, billing }).providerCost,
      ).toMatchObject({ availability: "unavailable" });
    },
  );

  it("rejects overflowing aggregates but does not overflow on a duplicate finite receipt", () => {
    const receipt = {
      provider: "provider-a",
      receiptId: "receipt-1",
      amount: Number.MAX_VALUE,
      currency: "USD",
    };
    const summary = (billing: ProviderBillingEvidence[]) =>
      summarizeEconomics({ events: [], policy: DEFAULT_RUN_POLICY, billing }).providerCost;
    expect(summary([receipt, { ...receipt }])).toMatchObject({
      availability: "observed",
      value: [{ provider: "provider-a", amount: Number.MAX_VALUE, currency: "USD" }],
      evidenceCount: 1,
    });
    expect(summary([receipt, { ...receipt, receiptId: "receipt-2" }])).toEqual({
      availability: "unavailable",
      reason: "provider billing aggregate is not finite",
    });
    expect(summary([]).availability).toBe("unavailable");
  });

  it("reconciles attempts, validation, delivery, native-unit budget, and terminal outcome", () => {
    const summary = summarizeRun(runEvidence());
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      runId: "run-7",
      outcome: "completed",
      elapsedMilliseconds: { availability: "observed", value: 60_000 },
      attempts: { total: 1, integrated: 1, active: 0 },
      validation: { recorded: 1, passed: 1, failed: 0 },
      delivery: {
        selected: "regular-prs",
        publications: 1,
        integrationsCompleted: 1,
      },
    });
    expect(summary!.economics.usage.local_milliseconds).toMatchObject({
      availability: "observed",
      value: 45_000,
    });
    expect(summary!.economics.nativeUnits).toContainEqual({
      unit: "local_milliseconds",
      reserved: 60_000,
      reconciled: 45_000,
      outstanding: 0,
      reservations: 1,
      reconciliations: 1,
    });
    expect(summary!.economics.providerCost.availability).toBe("unavailable");
  });

  it("counts a recovered publication once while retaining its separate audit receipt", () => {
    const receipts = runEvidence();
    const publication = receipts.find((entry) => entry.event === "PublicationRecorded")!;
    const recovered = event({
      ...publication,
      sequence: 12,
      reason: "recovered publication receipt before integration",
    });
    const summary = summarizeRun([...receipts, recovered, recovered])!;
    expect(summary.delivery).toMatchObject({ publications: 1, integrationsCompleted: 1 });
    expect(summary.evidence.eventCount).toBe(receipts.length + 1);
    expect(summary.attempts).toMatchObject({ total: 1, integrated: 1 });
  });

  it("preserves genuinely distinct publication attempts and PRs", () => {
    const receipts = runEvidence();
    const publication = receipts.find((entry) => entry.event === "PublicationRecorded")!;
    const integrated = receipts.find((entry) => entry.event === "AttemptIntegrated")!;
    const summary = summarizeRun([
      ...receipts,
      event({ ...publication, sequence: 12, attempt: 2, pullRequest: 100 }),
      event({ ...integrated, sequence: 13, attempt: 2 }),
      event({ ...publication, sequence: 14, workItem: 9, itemId: "item-9", pullRequest: 101 }),
    ])!;
    expect(summary.delivery).toMatchObject({ publications: 3, integrationsCompleted: 2 });
    expect(summary.attempts).toMatchObject({ total: 2, integrated: 2 });
  });

  it("counts native members, not duplicate completion receipts or revalidated heads", () => {
    const receipts = runEvidence();
    const publication = receipts.find((entry) => entry.event === "PublicationRecorded")!;
    const integrated = receipts.find((entry) => entry.event === "AttemptIntegrated")!;
    const native = { ...publication, mode: "native-stacks", unitId: "stack-8", stackNumber: 1 };
    const summary = summarizeRun([
      ...receipts.filter((entry) => entry.kind !== "publication" && entry.kind !== "delivery"),
      event({
        kind: "delivery",
        event: "DeliverySelected",
        sequence: 8,
        requested: "stacked-prs",
        selected: "native-stacks",
        capabilityVersion: "rest-v1",
        reason: "observed native capability",
      }),
      event(native),
      event({ ...native, sequence: 12, headSha: "c".repeat(40) }),
      event({ ...native, sequence: 13, event: "IntegrationCompleted", operationId: "merge-1" }),
      event({ ...native, sequence: 14, event: "IntegrationCompleted", operationId: "merge-1" }),
      event({ ...native, sequence: 15, workItem: 9, itemId: "item-9", pullRequest: 100 }),
      event({
        ...native,
        sequence: 16,
        workItem: 9,
        itemId: "item-9",
        pullRequest: 100,
        event: "IntegrationCompleted",
        operationId: "merge-1",
      }),
      event({ ...integrated, sequence: 17, workItem: 9 }),
    ])!;
    expect(summary.delivery).toEqual({
      selected: "native-stacks",
      publications: 2,
      integrationsCompleted: 2,
    });
    expect(summary.attempts).toMatchObject({ total: 2, integrated: 2 });
  });

  it("does not carry publication or integration counts across run boundaries", () => {
    const receipts = runEvidence();
    const start = receipts[0]!;
    const publication = receipts.find((entry) => entry.event === "PublicationRecorded")!;
    const summary = summarizeRun([
      ...receipts,
      event({ ...start, sequence: 20, runId: "run-8" }),
      event({ ...publication, sequence: 21, runId: "run-8" }),
    ])!;
    expect(summary.runId).toBe("run-8");
    expect(summary.delivery).toMatchObject({ publications: 1, integrationsCompleted: 0 });
  });

  it("retains a native completion even before its attempt completion copy is recorded", () => {
    const receipts = runEvidence()
      .filter((entry) => entry.event !== "AttemptIntegrated")
      .map((entry) =>
        entry.kind === "delivery"
          ? event({ ...entry, requested: "stacked-prs", selected: "native-stacks" })
          : entry.kind === "publication"
            ? event({ ...entry, mode: "native-stacks", stackNumber: 1 })
            : entry,
      );
    const publication = receipts.find((entry) => entry.event === "PublicationRecorded")!;
    const summary = summarizeRun([
      ...receipts,
      event({
        ...publication,
        sequence: 12,
        event: "IntegrationCompleted",
        operationId: "merge-1",
      }),
    ])!;
    expect(summary.delivery.integrationsCompleted).toBe(1);
    expect(summary.attempts.integrated).toBe(0);
  });

  it("still rejects conflicting authenticated publication receipts at the same identity", () => {
    const receipts = runEvidence();
    const publication = receipts.find((entry) => entry.event === "PublicationRecorded")!;
    expect(() => summarizeRun([...receipts, event({ ...publication, pullRequest: 100 })])).toThrow(
      /conflicting/i,
    );
  });
});
