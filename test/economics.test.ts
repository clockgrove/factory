import { describe, expect, it } from "vitest";

import {
  estimateDuration,
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
