import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUN_POLICY,
  normalizeSchedulingPolicy,
  parseControllerPolicy,
  parseRunPolicy,
  policyDigest,
} from "../src/protocol/policy.js";

const legacyPolicy = JSON.parse(
  readFileSync(new URL("./fixtures/legacy-run-policy.json", import.meta.url), "utf8"),
);

const adaptiveLocal = {
  mode: "adaptive-local" as const,
  local: {
    maxWorkers: 8,
    defaultCpu: 1,
    defaultMemoryMb: 2_048,
    reserveCpu: 0.5,
    reserveMemoryMb: 1_024,
    minimumFreeMemoryMb: 1_024,
    maxLoadRatio: 0.9,
    maxMemoryUsageRatio: 0.85,
    sampleIntervalSeconds: 5,
    admissionCooldownSeconds: 10,
  },
  backendMaxParallel: {
    "codex-cli/local-worktree": 8,
    "codex-cli/daytona": 2,
  },
};

describe("extended run policy", () => {
  it("preserves the checked-in legacy policy shape and digest", () => {
    const parsed = parseRunPolicy(legacyPolicy);
    expect(parsed).toEqual(legacyPolicy);
    expect(policyDigest(parsed)).toBe(
      "e213f60a61ac8386c7af30aa54d15266cae0af5090212761f93a7306992eea40",
    );
  });

  it("normalizes legacy scheduling without mutating the stored shape", () => {
    const parsed = parseRunPolicy(legacyPolicy);
    const before = policyDigest(parsed);
    const effective = normalizeSchedulingPolicy(parsed);
    expect(effective.priority.source).toBe("subissue-order");
    expect(effective.capacity.mode).toBe("fixed");
    expect(effective.capacity.local.maxWorkers).toBe(2);
    expect(effective.burst.mode).toBe("never");
    expect(policyDigest(parsed)).toBe(before);
    expect(parsed).not.toHaveProperty("priority");
  });

  it("accepts strict adaptive capacity and explicitly budgeted burst", () => {
    const parsed = parseRunPolicy({
      ...DEFAULT_RUN_POLICY,
      backendOrder: ["codex-cli/local-worktree", "codex-cli/daytona"],
      maxParallel: 8,
      allowedPaidBackends: ["codex-cli/daytona"],
      cloudFallback: "explicit",
      maxSandboxMinutes: 60,
      priority: {
        source: "issue-field-then-subissue-order",
        issueFieldId: "IIF_priority",
        optionRanks: { urgent: 0, high: 10 },
        unsetRank: 100,
        onUnavailable: "fallback-to-subissue-order",
      },
      capacity: adaptiveLocal,
      burst: {
        mode: "queue-or-deadline",
        backendOrder: ["codex-cli/daytona"],
        maxCloudParallel: 2,
        queueDelaySeconds: 120,
        deadlineReserveMinutes: 60,
        maxPriorityRank: 20,
      },
    });
    expect(normalizeSchedulingPolicy(parsed).capacity.local.maxWorkers).toBe(8);
  });

  it("rejects misspelled nested safety controls", () => {
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        priority: {
          source: "subissue-order",
          unsetRank: 100,
          onUnavailable: "fallback-to-subissue-order",
          unsetRnak: 10,
        },
      }),
    ).toThrow(/unrecognized/i);
  });

  it("rejects impossible burst and capacity authority", () => {
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        capacity: {
          mode: "fixed",
          backendMaxParallel: { "codex-cli/daytona": 1 },
        },
      }),
    ).toThrow(/absent from backendOrder/);
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        burst: {
          mode: "saturation",
          backendOrder: [],
          maxCloudParallel: 1,
          queueDelaySeconds: 0,
          deadlineReserveMinutes: 0,
          maxPriorityRank: 100,
        },
      }),
    ).toThrow(/cloudFallback=explicit/);
  });

  it("rejects conflicting duplicated economics ceilings", () => {
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        economics: {
          maxModelTokens: 10_000,
          maxSandboxMinutes: 1,
          maxManagedSessions: 0,
          minCloudTimeSavedMinutes: 20,
        },
      }),
    ).toThrow(/legacy sandbox budget/);
  });

  it("validates repository controller safety ceilings independently", () => {
    expect(
      parseControllerPolicy({
        scope: "repository",
        maxActiveObjectives: 2,
        maxLocalWorkers: 8,
        maxPaidWorkers: 0,
        pollIntervalSeconds: 15,
      }),
    ).toMatchObject({ maxLocalWorkers: 8, maxPaidWorkers: 0 });
    expect(() =>
      parseControllerPolicy({
        scope: "repository",
        maxActiveObjectives: 2,
        maxLocalWorkers: 8,
        maxPaidWorkers: 0,
        pollIntervalSeconds: 15,
        autoSpend: true,
      }),
    ).toThrow(/unrecognized/i);
  });
});
