import { describe, expect, it } from "vitest";

import { parseCodexWorkerStream } from "../src/backends/codex-cli-local.js";
import { parseManagementJsonlOutput } from "../src/management/codex-cli.js";
import { ProviderQuotaError, classifyProviderQuota } from "../src/providers/quota.js";

const messages = [
  "You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details. private tail",
  "You have exceeded your monthly quota (Request ID: private-request)",
] as const;

describe("provider quota classification", () => {
  it.each(messages)(
    "classifies captured Copilot refusal without retaining diagnostics",
    (message) => {
      const gate = classifyProviderQuota(message);
      expect(gate).toMatchObject({
        reasonCode: "provider-quota-exhausted",
        provider: "github-copilot",
        actionUrl: "https://github.com/settings/copilot/features",
      });
      expect(JSON.stringify(gate)).not.toContain("private");
    },
  );

  it.each([
    "API rate limit exceeded for user ID 1",
    "Factory model-token budget is exhausted",
    "provider transport timed out",
    "quota unavailable",
  ])("does not broaden the account-level classifier to %s", (message) => {
    expect(classifyProviderQuota(message)).toBeNull();
  });

  it.each(messages)("classifies management turn.failed JSONL with unknown usage", (message) => {
    let observed: unknown;
    try {
      parseManagementJsonlOutput(
        JSON.stringify({ type: "turn.failed", error: { message, arbitrary: "private" } }),
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ProviderQuotaError);
    expect(observed).toMatchObject({
      gate: { reasonCode: "provider-quota-exhausted" },
      usage: undefined,
    });
    expect(JSON.stringify(observed)).not.toContain("private");
  });

  it.each(messages)("classifies CLI worker JSONL without losing exact usage", (message) => {
    const result = parseCodexWorkerStream(
      [
        { type: "turn.failed", error: { message } },
        { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    expect(result).toMatchObject({
      final: null,
      usage: { input_tokens: 7, output_tokens: 3 },
      providerQuotaGate: { reasonCode: "provider-quota-exhausted" },
    });
  });
});
