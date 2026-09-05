import { describe, expect, it } from "vitest";
import { validationInvocationOwnership } from "../src/backends/validation-invocation.js";
import { sandboxResourceName } from "../src/backends/sandbox-common.js";
import type { StaleAttemptIdentity } from "../src/execution/backend.js";

const identity: StaleAttemptIdentity = {
  repository: "fixture/provider",
  objective: 7,
  workItem: 9,
  attempt: 1,
  runId: "run-original",
  directorEpoch: 2,
  policyDigest: "a".repeat(64),
  phase: "validation",
  validationInvocation: {
    kind: "integration-candidate",
    identityDigest: "b".repeat(64),
    artifactDigest: "c".repeat(64),
    baseSha: "d".repeat(40),
  },
};

describe("integration validation resource identity", () => {
  it("is stable across canonical repository casing and not confused with initial validation", () => {
    expect(validationInvocationOwnership({ ...identity, repository: "FIXTURE/Provider" })).toBe(
      validationInvocationOwnership(identity),
    );
    expect(sandboxResourceName(identity)).toMatch(/^factory-candidate-[a-f0-9]{45}$/);
    const { validationInvocation: _invocation, ...initial } = identity;
    expect(sandboxResourceName(identity)).not.toBe(sandboxResourceName(initial));
  });
  for (const [field, value] of Object.entries({
    repository: "fixture/other",
    objective: 8,
    workItem: 10,
    attempt: 2,
    runId: "run-successor",
    directorEpoch: 3,
    policyDigest: "e".repeat(64),
  })) {
    it(`binds original ${field}`, () =>
      expect(validationInvocationOwnership({ ...identity, [field]: value })).not.toBe(
        validationInvocationOwnership(identity),
      ));
  }
  for (const field of ["identityDigest", "artifactDigest", "baseSha"] as const) {
    it(`binds candidate ${field}`, () =>
      expect(
        validationInvocationOwnership({
          ...identity,
          validationInvocation: {
            ...identity.validationInvocation!,
            [field]: "f".repeat(field === "baseSha" ? 40 : 64),
          },
        }),
      ).not.toBe(validationInvocationOwnership(identity)));
  }
  it("requires source policy and rejects execution reuse", () => {
    const { policyDigest: _policy, ...missing } = identity;
    expect(() => validationInvocationOwnership(missing)).toThrow();
    expect(() => sandboxResourceName(identity, "execution")).toThrow(/cannot identify execution/);
  });
  it("rejects invocation fields that are not the exact candidate artifact or base", () => {
    const context = {
      ...identity,
      artifact: { digest: "f".repeat(64), baseSha: "d".repeat(40) },
      packet: { baseSha: "d".repeat(40) },
    };
    expect(() => validationInvocationOwnership(context as never)).toThrow(
      /exact artifact and base/,
    );
  });
});
