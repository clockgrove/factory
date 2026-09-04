import { describe, expect, it } from "vitest";

import {
  CODEX_COMPILED_OBJECTIVE_SCHEMA,
  codexCompiledObjectiveSchema,
  parseManagementJsonlOutput,
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
      const properties = Object.keys(
        (schema.properties as Record<string, unknown> | undefined) ?? {},
      );
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

  it("constrains compiler platform names to backend-compatible identifiers", () => {
    const requirements =
      CODEX_COMPILED_OBJECTIVE_SCHEMA.properties.workItems.items.properties.requirements.properties;
    expect(requirements.architecture.items.enum).toContain("x64");
    expect(requirements.architecture.items.enum).not.toContain("x86_64");
    expect(requirements.os.items.enum).toEqual(["linux", "darwin", "win32"]);
  });

  it("constrains compiler identifiers and paths before runtime validation", () => {
    const item = CODEX_COMPILED_OBJECTIVE_SCHEMA.properties.workItems.items.properties;
    const requirements = item.requirements.properties;
    expect(item.scope.items.pattern).toBe("^(?:[A-Za-z0-9_@+ .-]+/)*[A-Za-z0-9_@+ .-]+/?$");
    expect(item.dependsOn.items.pattern).toBe("^[a-z0-9][a-z0-9-]*$");
    expect(requirements.tools.items.pattern).toBe("^[A-Za-z0-9._:/+-]+$");
    expect(requirements.services.items.pattern).toBe("^[A-Za-z0-9._:/+-]+$");
    expect(requirements.permittedSecretNames.items.pattern).toBe("^[A-Z][A-Z0-9_]{1,127}$");
  });

  it("requires explicit valid management usage instead of inventing zero tokens", () => {
    const result = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ ok: true }) },
    });
    expect(() => parseManagementJsonlOutput(result)).toThrow(
      /stream ended without turn\.completed/i,
    );
    expect(() =>
      parseManagementJsonlOutput(
        `${result}\n${JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: -1, output_tokens: 2 },
        })}`,
      ),
    ).toThrow(/invalid model-token usage/i);
    expect(
      parseManagementJsonlOutput(
        `${result}\n${JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0 },
        })}`,
      ).usage,
    ).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("requires the structured result before terminal completion", () => {
    const completed = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const result = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ ok: true }) },
    });
    expect(() => parseManagementJsonlOutput(`${completed}\n${result}`)).toThrow(
      /completed before returning a structured result/,
    );
  });

  it("rejects duplicate structured results and duplicate completions", () => {
    const result = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ ok: true }) },
    });
    const completed = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(() => parseManagementJsonlOutput(`${result}\n${result}\n${completed}`)).toThrow(
      /multiple structured results/,
    );
    expect(() => parseManagementJsonlOutput(`${result}\n${completed}\n${completed}`)).toThrow(
      /multiple turn\.completed events/,
    );
  });

  it("rejects a failure even after an otherwise valid completion", () => {
    const result = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ ok: true }) },
    });
    const completed = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const failure = JSON.stringify({ type: "turn.failed", error: { message: "failed" } });
    expect(() => parseManagementJsonlOutput(`${result}\n${completed}\n${failure}`)).toThrow(
      /reported turn\.failed/,
    );
  });

  it("rejects EOF after a structured result without terminal completion", () => {
    const result = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ ok: true }) },
    });
    expect(() => parseManagementJsonlOutput(result)).toThrow(
      /stream ended without turn\.completed/,
    );
  });
});
