import { describe, expect, it } from "vitest";
import { ManagementOutputError } from "../src/management/backend.js";

import { parseManagementJsonlOutput } from "../src/management/codex-cli.js";

describe("Codex management backend", () => {
  it.each([undefined, null, -1, 1.5, "5", 101, Number.MAX_SAFE_INTEGER + 1])(
    "keeps invalid or absent cached usage %j unknown without losing terminal totals",
    (cached) => {
      const stdout = [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: cached },
        }),
      ].join("\n");
      expect(parseManagementJsonlOutput(stdout).usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
      });
      let failed: unknown;
      try {
        parseManagementJsonlOutput(stdout.replace('"text":"{}"', '"text":"bad"'));
      } catch (error) {
        failed = error;
      }
      expect(failed).toBeInstanceOf(ManagementOutputError);
      expect(failed).toMatchObject({ usage: { inputTokens: 100, outputTokens: 20 } });
      expect((failed as ManagementOutputError).usage).not.toHaveProperty("cachedInputTokens");
    },
  );

  it.each([0, 50, 100])(
    "preserves cached input %i once for successful and malformed responses",
    (cached) => {
      const stdout = [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: cached },
        }),
      ].join("\n");
      const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: cached };
      expect(parseManagementJsonlOutput(stdout).usage).toEqual(usage);
      let failed: unknown;
      try {
        parseManagementJsonlOutput(stdout.replace('"text":"{}"', '"text":"bad"'));
      } catch (error) {
        failed = error;
      }
      expect(failed).toBeInstanceOf(ManagementOutputError);
      expect(failed).toMatchObject({ usage });
    },
  );
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
