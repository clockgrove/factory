import { describe, expect, it, vi } from "vitest";
import { ManagementOutputError } from "../src/management/backend.js";

import {
  CODEX_COMPILED_OBJECTIVE_SCHEMA,
  CodexCliManagementBackend,
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
  it("retains valid compiler usage when durable checkpoint persistence fails", async () => {
    const usage = { inputTokens: 30, outputTokens: 12 };
    const backend = new CodexCliManagementBackend({
      runStructured: async () => ({
        usage,
        value: {
          title: "Test",
          workItems: [
            {
              id: "code",
              title: "Implement code",
              goal: "Implement code",
              acceptance: ["Tests pass"],
              scope: ["src/code.ts"],
              preconditions: [],
              outOfScope: [],
              conventions: [],
              dependsOn: [],
              baseSha: "a".repeat(40),
              validationCommands: ["npm test"],
              requirements: {
                os: ["linux"],
                architecture: ["x64"],
                cpu: 1,
                memoryMb: 2048,
                diskMb: 1024,
                timeoutMinutes: 30,
                estimatedDurationMinutes: 10,
                tools: ["node", "npm"],
                services: [],
                networkDestinations: [],
                permittedSecretNames: [],
                trust: "trusted_local",
              },
              artifactContract: "clockgrove.factory/artifact-v1",
            },
          ],
        },
      }),
    });
    const checkpoint = vi.fn(async () => {
      throw new Error("persistence unavailable");
    });
    await expect(
      backend.compile(
        {
          repository: process.cwd(),
          objective: { number: 1, title: "Test", body: "Test" },
          defaultBranch: "main",
          baseSha: "a".repeat(40),
          repositoryFiles: ["src/code.ts", "package.json"],
          allowedNetworkDestinations: [],
        },
        checkpoint,
      ),
    ).rejects.toMatchObject({
      name: "ManagementOutputError",
      usage,
      message: "persistence unavailable",
    });
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it("retains observed usage when compiler output is rejected before its checkpoint", async () => {
    const usage = { inputTokens: 30, outputTokens: 12 };
    const backend = new CodexCliManagementBackend({
      runStructured: async () => ({ value: { title: "invalid", workItems: [] }, usage }),
    });
    const checkpoint = vi.fn();
    await expect(
      backend.compile(
        {
          repository: "/tmp",
          objective: { number: 1, title: "Test", body: "Test" },
          defaultBranch: "main",
          baseSha: "a".repeat(40),
          repositoryFiles: [],
          allowedNetworkDestinations: [],
        },
        checkpoint,
      ),
    ).rejects.toMatchObject({ name: "ManagementOutputError", usage });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("recovers unique terminal counters after malformed result JSON without accepting the result", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{invalid" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 12 } }),
    ].join("\n");
    let observed: unknown;
    try {
      parseManagementJsonlOutput(stdout);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ManagementOutputError);
    expect(observed).toMatchObject({ usage: { inputTokens: 30, outputTokens: 12 } });
  });

  it("does not invent an aggregate for ambiguous completion counters", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 12 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 40, output_tokens: 15 } }),
    ].join("\n");
    let observed: unknown;
    try {
      parseManagementJsonlOutput(stdout);
    } catch (error) {
      observed = error;
    }
    expect(observed).not.toBeInstanceOf(ManagementOutputError);
    expect(observed).toMatchObject({ message: expect.stringContaining("multiple turn.completed") });
  });

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

  it("rejects duplicate completions", () => {
    const result = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ ok: true }) },
    });
    const completed = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(() => parseManagementJsonlOutput(`${result}\n${completed}\n${completed}`)).toThrow(
      /multiple turn\.completed events/,
    );
  });

  it("uses the terminal agent response after natural-language progress and tool events", () => {
    const stdout = [
      {
        type: "item.completed",
        item: { id: "progress", type: "agent_message", text: "I’ll check the repository first." },
      },
      {
        type: "item.completed",
        item: { id: "tool", type: "command_execution", aggregated_output: "repository files" },
      },
      {
        type: "item.completed",
        item: { id: "intermediate", type: "agent_message", text: '{"intermediate":true}' },
      },
      {
        type: "item.completed",
        item: { id: "final", type: "agent_message", text: '{"final":true}' },
      },
      { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 7 } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(parseManagementJsonlOutput(stdout)).toEqual({
      value: { final: true },
      usage: { inputTokens: 20, outputTokens: 7 },
    });
  });

  it.each(["invalid final response", ""])(
    "refuses a %j final response despite earlier valid JSON",
    (text) => {
      const stdout = [
        { type: "item.completed", item: { type: "agent_message", text: '{"ok":true}' } },
        { type: "item.completed", item: { type: "agent_message", text } },
        { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 7 } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");
      let observed: unknown;
      try {
        parseManagementJsonlOutput(stdout);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(ManagementOutputError);
      expect(observed).toMatchObject({ usage: { inputTokens: 20, outputTokens: 7 } });
    },
  );

  it("refuses another agent message after the terminal boundary", () => {
    const result = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: '{"ok":true}' },
    });
    const completed = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 20, output_tokens: 7 },
    });
    expect(() => parseManagementJsonlOutput(`${result}\n${completed}\n${result}`)).toThrow(
      /after turn.completed/,
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
