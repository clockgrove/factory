import { describe, expect, it } from "vitest";

import {
  estimateDuration,
  modelTokenBreakdown,
  summarizeEconomics,
  summarizeRun,
  type DurationEvidenceSample,
  type DurationFingerprint,
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
        integrationsCompleted: 0,
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
});
