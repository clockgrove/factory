import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertNewRunBudgetIntent,
  assertSupportedModelTokenBudgetIntent,
  modelTokenBudgetIntent,
} from "../src/protocol/budget-intent.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../src/protocol/policy.js";

const economics = {
  maxModelTokens: 100,
  maxSandboxMinutes: 0,
  maxManagedSessions: 0,
  minCloudTimeSavedMinutes: 0,
};

describe("explicit model-token budget intent", () => {
  it("does not inject intent or rewrite a historical policy digest", () => {
    const recorded = { ...DEFAULT_RUN_POLICY, economics };
    // Independent canonical encoding represents the original immutable bytes' contract.
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
          .join(",")}}`;
      }
      return JSON.stringify(value);
    };
    const digest = createHash("sha256").update(canonical(recorded)).digest("hex");
    const policy = parseRunPolicy(recorded);
    expect(policy).toEqual(recorded);
    expect(policy.economics).not.toHaveProperty("modelTokenBudgetMode");
    expect(policyDigest(policy)).toBe(digest);
    expect(modelTokenBudgetIntent(policy)).toEqual({
      mode: "legacy-observed-stop",
      limit: 100,
      hardCapEnforced: false,
    });
    expect(() => assertSupportedModelTokenBudgetIntent(policy)).not.toThrow();
    expect(() => assertNewRunBudgetIntent(policy)).toThrow(/requires explicit/);
    expect(policyDigest(policy)).toBe(digest);
  });

  it.each([0, 100])(
    "rejects unsupported hard intent at limit %i even on recorded replay",
    (limit) => {
      const policy = parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        economics: { ...economics, maxModelTokens: limit, modelTokenBudgetMode: "hard" },
      });
      expect(modelTokenBudgetIntent(policy)).toEqual({
        mode: "hard",
        limit,
        hardCapEnforced: false,
      });
      expect(() => assertNewRunBudgetIntent(policy)).toThrow(/hard is unsupported/);
      expect(() => assertSupportedModelTokenBudgetIntent(policy)).toThrow(/hard is unsupported/);
    },
  );

  it("accepts explicit observed intent without inventing a provider cap", () => {
    const policy = parseRunPolicy({
      ...DEFAULT_RUN_POLICY,
      economics: { ...economics, modelTokenBudgetMode: "observed-stop" },
    });
    expect(() => assertNewRunBudgetIntent(policy)).not.toThrow();
    expect(modelTokenBudgetIntent(policy)).toEqual({
      mode: "observed-stop",
      limit: 100,
      hardCapEnforced: false,
    });
    expect(policyDigest(policy)).not.toBe(
      policyDigest(parseRunPolicy({ ...DEFAULT_RUN_POLICY, economics })),
    );
  });

  it("preserves policies without a token threshold and rejects misspelled intent", () => {
    expect(() => assertNewRunBudgetIntent(DEFAULT_RUN_POLICY)).not.toThrow();
    expect(modelTokenBudgetIntent(DEFAULT_RUN_POLICY)).toEqual({
      mode: "none",
      limit: null,
      hardCapEnforced: false,
    });
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        economics: { ...economics, modelTokenBudgetMode: "observed" },
      }),
    ).toThrow();
  });
});
