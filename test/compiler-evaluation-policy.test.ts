import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPILER_EVALUATION_POLICY,
  DEFAULT_RUN_POLICY,
  parseRunPolicy,
  policyDigest,
} from "../src/protocol/policy.js";

describe("compiler evaluation policy authority", () => {
  it("selects one explicit bounded auto-repair envelope for new default runs", () => {
    expect(parseRunPolicy(DEFAULT_RUN_POLICY).compilerEvaluation).toEqual(
      DEFAULT_COMPILER_EVALUATION_POLICY,
    );
  });

  it("preserves historical omitted-policy identity without adding repair authority", () => {
    const { compilerEvaluation: _newDefault, ...historicalDefault } = DEFAULT_RUN_POLICY;
    const original = parseRunPolicy(historicalDefault);
    expect(original).not.toHaveProperty("compilerEvaluation");
    expect(policyDigest(parseRunPolicy(JSON.parse(JSON.stringify(original))))).toBe(
      policyDigest(original),
    );
  });

  it("binds opt-in and limits to the immutable policy digest", () => {
    const policy = parseRunPolicy({
      ...DEFAULT_RUN_POLICY,
      compilerEvaluation: {
        mode: "auto-repair",
        maxRepairs: 2,
        maxInvocations: 7,
        timeoutSeconds: 600,
        maxObservedTokens: 20_000,
      },
    });
    expect(policy.compilerEvaluation?.maxRepairs).toBe(2);
    expect(policyDigest(policy)).not.toBe(
      policyDigest({ ...DEFAULT_RUN_POLICY, compilerEvaluation: { mode: "auto-repair" } }),
    );
  });

  it.each([
    { mode: "auto-repair", maxRepairs: 3 },
    { mode: "auto-repair", maxInvocations: 8 },
    { mode: "auto-repair", timeoutSeconds: 0 },
    { mode: "auto-repair", maxObservedTokens: -1 },
    { mode: "auto-repair", hardTokenCap: 100 },
    { mode: "unknown" },
  ])("rejects unsupported compilation authority %j", (compilerEvaluation) => {
    expect(() => parseRunPolicy({ ...DEFAULT_RUN_POLICY, compilerEvaluation })).toThrow();
  });
});
