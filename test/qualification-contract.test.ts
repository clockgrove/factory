import { describe, expect, it } from "vitest";
import {
  QualificationViolation,
  qualificationInvariant,
  qualificationViolation,
} from "../scripts/qualification-contract.mjs";
import { checkpointFailure } from "../scripts/verify-local-checkpoint-restart.mjs";

describe("qualification violation contract", () => {
  it("retains stable deterministic fields through the checkpoint boundary", () => {
    let caught: unknown;
    try {
      qualificationInvariant(false, {
        code: "fixture-command-identity-mismatch",
        phase: "verify",
        item: "real-conflict",
        field: "packet.validationCommands",
        expected: "one repository test script invocation",
        observed: {
          type: "array",
          count: 1,
          commands: [{ manager: "npm", script: "lint", form: "run" }],
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QualificationViolation);
    expect(checkpointFailure(caught)).toEqual({
      boundary: "scenario",
      category: "invariant",
      code: "fixture-command-identity-mismatch",
      violation: {
        protocol: "clockgrove.factory/qualification-violation",
        code: "fixture-command-identity-mismatch",
        phase: "verify",
        item: "real-conflict",
        field: "packet.validationCommands",
        expected: "one repository test script invocation",
        observed: {
          type: "array",
          count: 1,
          commands: [{ manager: "npm", script: "lint", form: "run" }],
        },
      },
    });
  });

  it("never derives diagnostic content from an arbitrary thrown error", () => {
    const secret = "token=/private/secret provider-response";
    const error = Object.assign(new Error(secret), {
      code: "ERR_ASSERTION",
      actual: secret,
      expected: secret,
    });
    expect(qualificationViolation(error)).toBeUndefined();
    expect(JSON.stringify(checkpointFailure(error))).not.toContain(secret);
  });

  it.each([
    { observed: undefined },
    { observed: "control\ncharacter" },
    { observed: Array.from({ length: 17 }, () => true) },
    { observed: { ["x".repeat(81)]: true } },
  ])("rejects unsafe caller-supplied diagnostic values %#", ({ observed }) => {
    expect(
      () =>
        new QualificationViolation({
          code: "fixture-contract-invalid",
          phase: "preflight",
          item: "fixture",
          field: "configuration",
          expected: "a bounded safe value",
          observed: observed as never,
        }),
    ).toThrow(/qualification diagnostic/);
  });
});
