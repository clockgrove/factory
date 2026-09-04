import { describe, expect, it } from "vitest";

import {
  EXPLANATION_CODES,
  explainGate,
  explainQueuedDecision,
  queuedReasonCode,
  type GateEvidence,
} from "../src/explanations/index.js";

describe("stable explanations", () => {
  it.each<[string, GateEvidence, string]>([
    [
      "dependency",
      { gate: "dependency", openDependencies: [9, 3] },
      EXPLANATION_CODES.dependencyOpen,
    ],
    [
      "capacity",
      { gate: "capacity", reason: "local-capacity" },
      EXPLANATION_CODES.capacityLocal,
    ],
    [
      "authority",
      { gate: "authority", reason: "lease-unavailable" },
      EXPLANATION_CODES.authorityLeaseUnavailable,
    ],
    [
      "priority",
      { gate: "priority", reason: "burst-threshold", rank: 80 },
      EXPLANATION_CODES.priorityBurstThreshold,
    ],
    [
      "scope",
      { gate: "scope", reason: "path-conflict" },
      EXPLANATION_CODES.scopePathConflict,
    ],
    [
      "trust",
      { gate: "trust", reason: "isolation-required" },
      EXPLANATION_CODES.trustIsolationRequired,
    ],
    [
      "backend",
      { gate: "backend", reason: "unavailable" },
      EXPLANATION_CODES.backendUnavailable,
    ],
    [
      "validation",
      { gate: "validation", reason: "invalidated" },
      EXPLANATION_CODES.validationInvalidated,
    ],
    [
      "economic",
      { gate: "economic", reason: "budget-exhausted" },
      EXPLANATION_CODES.economicBudgetExhausted,
    ],
  ])("identifies the exact %s gate", (category, evidence, code) => {
    const result = explainGate(evidence);
    expect(result.category).toBe(category);
    expect(result.code).toBe(code);
  });

  it("maps every scheduler queue code to a category-qualified stable code", () => {
    const queueCodes = [
      "lease-unavailable",
      "policy-constraint",
      "backend-incompatible",
      "backend-unavailable",
      "backend-at-capacity",
      "global-capacity",
      "local-capacity",
      "local-pressure",
      "local-cooldown",
      "resource-sample-unavailable",
      "budget-exhausted",
      "burst-disabled",
      "burst-trigger-pending",
      "burst-priority",
      "path-conflict",
      "exclusive-resource-conflict",
    ] as const;
    for (const code of queueCodes) {
      const result = explainQueuedDecision({
        code,
        reason:
          code === "policy-constraint"
            ? "requests network destinations outside run policy"
            : code,
        observedPriorityRank: 7,
      });
      expect(result.code).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(result.summary).not.toContain(code);
    }
  });

  it("separates network scope, unsupported secrets, and validation availability", () => {
    expect(
      explainQueuedDecision({
        code: "policy-constraint",
        reason: "requests network destinations outside run policy: example.invalid",
        observedPriorityRank: 1,
      }).code,
    ).toBe(EXPLANATION_CODES.scopeNetworkPolicy);
    expect(
      explainQueuedDecision({
        code: "policy-constraint",
        reason: "requests unsupported task secrets: TOKEN_NAME",
        observedPriorityRank: 1,
      }).code,
    ).toBe(EXPLANATION_CODES.trustSecretsUnsupported);
    expect(
      explainQueuedDecision({
        code: "backend-unavailable",
        reason: "no independent validation backend is available",
        observedPriorityRank: 1,
      }).code,
    ).toBe(EXPLANATION_CODES.validationUnavailable);
  });

  it("parses only exact durable reason prefixes", () => {
    expect(queuedReasonCode("local-capacity: CPU is full")).toBe("local-capacity");
    expect(queuedReasonCode("local-capacity-ish: not a stable code")).toBeNull();
    expect(queuedReasonCode("provider said token=do-not-return")).toBeNull();
  });
});
