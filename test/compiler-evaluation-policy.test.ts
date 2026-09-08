import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../src/protocol/policy.js";

describe("compiler evaluation policy authority", () => {
  it("preserves historical policy identity and does not opt existing runs into extra calls", () => {
    const original = parseRunPolicy(DEFAULT_RUN_POLICY);
    expect(original.compilerEvaluation).toBeUndefined();
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
    expect(policyDigest(policy)).not.toBe(policyDigest(DEFAULT_RUN_POLICY));
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
