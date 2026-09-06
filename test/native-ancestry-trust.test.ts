import { describe, expect, it } from "vitest";
import { nativeSourceRequiresIsolation } from "../src/execution/native-ancestry-trust.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../src/protocol/policy.js";

function start(
  runId: string,
  trust: "explicitly_activated_repo" | "sandbox_untrusted",
  sequence = 1,
) {
  const policy = parseRunPolicy({ ...DEFAULT_RUN_POLICY, trust });
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId,
    sequence,
    at: "2026-09-06T00:00:00.000Z",
    kind: "run",
    event: "FactoryRunStarted",
    actor: "operator",
    repository: "o/r",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    baseSha: "a".repeat(40),
    policy,
    policyDigest: policyDigest(policy),
  });
}

describe("native retained source policy restrictions", () => {
  it("retains B's source-policy-only restriction beside trusted A and a trusted successor", () => {
    const events = [
      start("a-source", "explicitly_activated_repo"),
      start("b-source", "sandbox_untrusted"),
      start("successor", "explicitly_activated_repo"),
    ];
    expect(nativeSourceRequiresIsolation("a-source", events)).toBe(false);
    expect(nativeSourceRequiresIsolation("b-source", events)).toBe(true);
    expect(nativeSourceRequiresIsolation("successor", events)).toBe(false);
  });

  it("deduplicates identical receipts without treating distinct starts as authority", () => {
    const event = start("b-source", "sandbox_untrusted");
    expect(nativeSourceRequiresIsolation("b-source", [event, event])).toBe(true);
    expect(() =>
      nativeSourceRequiresIsolation("b-source", [
        event,
        start("b-source", "explicitly_activated_repo", 2),
      ]),
    ).toThrow("unique authenticated source policy");
  });

  it("refuses a missing source rather than inheriting unrelated trusted policy", () => {
    expect(() =>
      nativeSourceRequiresIsolation("b-source", [start("a-source", "explicitly_activated_repo")]),
    ).toThrow("unique authenticated source policy");
  });
});
