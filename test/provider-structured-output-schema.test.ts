import { describe, expect, it } from "vitest";

import { CODEX_WORKER_OUTPUT_SCHEMA } from "../src/backends/codex-cli-local.js";
import { COMPILER_PROPOSAL_JSON_SCHEMA } from "../src/compiler/contracts.js";
import {
  CODEX_CASE_LABEL_SCHEMA,
  CODEX_OBLIGATION_SCHEMA,
  CODEX_PLAN_JUDGE_SCHEMA,
  CODEX_REVIEW_SCHEMA,
} from "../src/management/codex-cli.js";
import { assertProviderStructuredOutputSchema } from "../src/providers/structured-output-schema.js";

const leaf = { type: "string", maxLength: 20 } as const;
const objectSchema = (property: unknown = leaf) => ({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: property },
});

describe("provider structured-output schema subset", () => {
  it.each([
    ["compiler proposal and repair", COMPILER_PROPOSAL_JSON_SCHEMA],
    ["obligation inventory and repair", CODEX_OBLIGATION_SCHEMA],
    ["compiler judge", CODEX_PLAN_JUDGE_SCHEMA],
    ["case label", CODEX_CASE_LABEL_SCHEMA],
    ["semantic review", CODEX_REVIEW_SCHEMA],
    ["worker output", CODEX_WORKER_OUTPUT_SCHEMA],
  ])("accepts the production %s schema", (_name, schema) => {
    expect(() => assertProviderStructuredOutputSchema(schema)).not.toThrow();
  });

  it.each(["oneOf", "allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else"])(
    "rejects nested %s",
    (keyword) => {
      expect(() =>
        assertProviderStructuredOutputSchema(
          objectSchema({ type: "string", [keyword]: keyword === "not" ? {} : [] }),
        ),
      ).toThrow(`unsupported ${keyword}`);
    },
  );

  it("rejects a root anyOf while validating every nested anyOf branch", () => {
    expect(() =>
      assertProviderStructuredOutputSchema({
        anyOf: [objectSchema()],
      }),
    ).toThrow("root must not use anyOf");
    expect(() =>
      assertProviderStructuredOutputSchema(
        objectSchema({ anyOf: [{ type: "string" }, { const: "missing-type" }] }),
      ),
    ).toThrow("constraint lacks type");
  });

  it.each([
    ["typeless const", objectSchema({ const: "x" })],
    ["typeless enum", objectSchema({ enum: ["x"] })],
    ["untyped constraint", objectSchema({ maxLength: 4 })],
    [
      "missing required",
      { type: "object", additionalProperties: false, required: [], properties: { value: leaf } },
    ],
    [
      "open object",
      {
        type: "object",
        additionalProperties: true,
        required: ["value"],
        properties: { value: leaf },
      },
    ],
  ])("rejects %s", (_name, schema) => {
    expect(() => assertProviderStructuredOutputSchema(schema)).toThrow();
  });

  it("enforces nesting, property, enum, and string budgets", () => {
    let nested: unknown = leaf;
    for (let index = 0; index < 11; index++) nested = { type: "array", items: nested };
    expect(() => assertProviderStructuredOutputSchema(objectSchema(nested))).toThrow("nesting");

    const properties = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [`p${index}`, leaf]),
    );
    expect(() =>
      assertProviderStructuredOutputSchema({
        type: "object",
        additionalProperties: false,
        required: Object.keys(properties),
        properties,
      }),
    ).toThrow("property count");

    expect(() =>
      assertProviderStructuredOutputSchema(
        objectSchema({
          type: "string",
          enum: Array.from({ length: 1_001 }, (_, index) => `v${index}`),
        }),
      ),
    ).toThrow("enum value count");
    expect(() =>
      assertProviderStructuredOutputSchema(
        objectSchema({ type: "string", const: "x".repeat(120_001) }),
      ),
    ).toThrow("string budget");
  });
});
