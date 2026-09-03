import { describe, expect, it } from "vitest";

import {
  CODEX_COMPILED_OBJECTIVE_SCHEMA,
  codexCompiledObjectiveSchema,
} from "../src/management/codex-cli.js";

function objectSchemas(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(objectSchemas);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(record.type === "object" ? [record] : []),
    ...Object.values(record).flatMap(objectSchemas),
  ];
}

describe("Codex management backend", () => {
  it("uses a strict structured-output schema accepted by the Codex API", () => {
    for (const schema of objectSchemas(CODEX_COMPILED_OBJECTIVE_SCHEMA)) {
      const properties = Object.keys(schema.properties as Record<string, unknown> | undefined ?? {});
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(expect.arrayContaining(properties));
      expect(schema.required).toHaveLength(properties.length);
    }
  });

  it("constrains the compiler to preserve the Objective title as identity data", () => {
    const title = "Objective: Exact human-authored title";
    const schema = codexCompiledObjectiveSchema(title) as {
      properties: { title: { const?: string } };
    };
    expect(schema.properties.title.const).toBe(title);
    expect(CODEX_COMPILED_OBJECTIVE_SCHEMA.properties.title).not.toHaveProperty("const");
  });
});
