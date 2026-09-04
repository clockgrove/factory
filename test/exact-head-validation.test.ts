import { describe, expect, it } from "vitest";

import {
  bindValidationToPublishedHead,
  verifyExactHeadValidation,
} from "../src/validation/plan.js";
import { evaluatePublishedHead } from "../src/evaluate.js";

const sha = (value: string) => value.repeat(40);

describe("exact published-head validation", () => {
  it("binds independent validation to the precise published commit", () => {
    const evidence = bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: "a".repeat(64),
        baseSha: sha("b"),
        outputTreeSha: sha("c"),
      },
      publishedHeadSha: sha("d"),
      publishedTreeSha: sha("c"),
      publishedBaseSha: sha("b"),
    });
    expect(evidence.publishedHeadSha).toBe(sha("d"));
    expect(() => verifyExactHeadValidation(evidence, sha("d"))).not.toThrow();
    expect(evaluatePublishedHead({ headSha: sha("d") }, evidence)).toEqual({
      kind: "exact-head-validated",
      headSha: sha("d"),
    });
    expect(evaluatePublishedHead({ headSha: sha("e") }, evidence)).toMatchObject({
      kind: "validation-invalidated",
      headSha: sha("e"),
    });
    expect(() => verifyExactHeadValidation(evidence, sha("e"))).toThrow(
      "does not name the exact published head",
    );
  });

  it("rejects a different tree, base, failed validation, or altered binding", () => {
    const validation = {
      passed: true,
      digest: "a".repeat(64),
      baseSha: sha("b"),
      outputTreeSha: sha("c"),
    };
    expect(() =>
      bindValidationToPublishedHead({
        validation,
        publishedHeadSha: sha("d"),
        publishedTreeSha: sha("e"),
        publishedBaseSha: sha("b"),
      }),
    ).toThrow("published head tree differs");
    expect(() =>
      bindValidationToPublishedHead({
        validation,
        publishedHeadSha: sha("d"),
        publishedTreeSha: sha("c"),
        publishedBaseSha: sha("e"),
      }),
    ).toThrow("published head base differs");
    expect(() =>
      bindValidationToPublishedHead({
        validation: { ...validation, passed: false },
        publishedHeadSha: sha("d"),
        publishedTreeSha: sha("c"),
        publishedBaseSha: sha("b"),
      }),
    ).toThrow("cannot bind failed validation");
    const evidence = bindValidationToPublishedHead({
      validation,
      publishedHeadSha: sha("d"),
      publishedTreeSha: sha("c"),
      publishedBaseSha: sha("b"),
    });
    expect(() =>
      verifyExactHeadValidation({ ...evidence, outputTreeSha: sha("e") }, sha("d")),
    ).toThrow("digest mismatch");
  });
});
