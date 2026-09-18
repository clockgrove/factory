import { describe, expect, it } from "vitest";
import { ManagementOutputError } from "../src/management/backend.js";

import {
  classifyManagementCliProcessFailure,
  observedManagementCompletionUsage,
  parseManagementJsonlOutput,
} from "../src/management/codex-cli.js";

describe("Codex management backend", () => {
  it("normalizes one completion exactly while allowing provider extension fields", () => {
    const stdout = JSON.stringify({
      type: "turn.completed",
      extension: { provider: "codex" },
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 101,
        total_tokens: 120,
      },
    });
    expect(observedManagementCompletionUsage(stdout)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(
      observedManagementCompletionUsage(
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100 } }),
      ),
    ).toBeUndefined();
    expect(observedManagementCompletionUsage(`${stdout}\n${stdout}`)).toBeUndefined();
  });

  it.each([
    {
      name: "progress-only nonzero",
      process: {
        exitCode: 2,
        signal: null,
        timedOut: false,
        durationMs: 20,
        stdout: JSON.stringify({ type: "turn.started" }),
      },
      message:
        "management backend failed: Codex CLI exited with status 2; inspect the local management transcript when enabled",
      quota: false,
    },
    {
      name: "quota error at exit zero",
      process: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 21,
        stdout: JSON.stringify({
          type: "error",
          message: "You've reached your additional usage limit for your plan.",
        }),
      },
      message: "GitHub Copilot additional usage limit reached",
      quota: true,
    },
    {
      name: "signal",
      process: {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        durationMs: 22,
        stdout: "",
      },
      message:
        "management backend failed: Codex CLI exited with status unknown after signal SIGTERM; inspect the local management transcript when enabled",
      quota: false,
    },
    {
      name: "timeout",
      process: { exitCode: null, signal: null, timedOut: true, durationMs: 23, stdout: "" },
      message:
        "management backend failed: Codex CLI exited with status unknown after timeout; inspect the local management transcript when enabled",
      quota: false,
    },
  ])("classifies the exact $name process terminal", ({ process, message, quota }) => {
    const result = classifyManagementCliProcessFailure(process);
    expect(result?.error.message).toBe(message);
    expect(result?.providerQuota !== null).toBe(quota);
  });

  it("retains the last observed response size when the CLI exits nonzero", () => {
    const response = "partial structured response";
    const result = classifyManagementCliProcessFailure({
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 20,
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: response },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "provider failed" } }),
      ].join("\n"),
    });

    expect(result?.error).toMatchObject({
      responseBytes: Buffer.byteLength(response, "utf8"),
      responseBytesSource: "provider-final-response",
    });

    const unknownUsage = classifyManagementCliProcessFailure({
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 20,
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: response },
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "provider failed" } }),
      ].join("\n"),
    });
    expect(unknownUsage).toMatchObject({
      usage: null,
      error: {
        responseBytes: Buffer.byteLength(response, "utf8"),
        responseBytesSource: "provider-final-response",
      },
    });
  });

  it.each([
    { exitCode: null, signal: null, timedOut: false, durationMs: 1, stdout: "" },
    { exitCode: 0, signal: "SIGTERM", timedOut: false, durationMs: 1, stdout: "" },
    { exitCode: -1, signal: null, timedOut: false, durationMs: 1, stdout: "" },
    { exitCode: 1, signal: null, timedOut: false, durationMs: -1, stdout: "" },
  ])("rejects impossible process terminal tuple %#", (process) => {
    expect(() => classifyManagementCliProcessFailure(process)).toThrow(/process terminal|tuple/);
  });

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
    let invalidUsage: unknown;
    try {
      parseManagementJsonlOutput(
        `${result}\n${JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: -1, output_tokens: 2 },
        })}`,
      );
    } catch (error) {
      invalidUsage = error;
    }
    expect(invalidUsage).toMatchObject({
      message: expect.stringMatching(/invalid model-token usage/i),
      responseBytes: Buffer.byteLength(JSON.stringify({ ok: true }), "utf8"),
      responseBytesSource: "provider-final-response",
    });
    expect(invalidUsage).not.toBeInstanceOf(ManagementOutputError);
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
      responseBytes: Buffer.byteLength('{"final":true}', "utf8"),
      responseBytesSource: "provider-final-response",
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
    let observed: unknown;
    try {
      parseManagementJsonlOutput(`${result}\n${completed}\n${failure}`);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ManagementOutputError);
    expect(observed).toMatchObject({
      usage: { inputTokens: 1, outputTokens: 2 },
      responseBytes: Buffer.byteLength(JSON.stringify({ ok: true }), "utf8"),
      responseBytesSource: "provider-final-response",
    });
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
