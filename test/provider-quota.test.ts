import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { parseCodexWorkerStream } from "../src/backends/codex-cli-local.js";
import { parseManagementJsonlOutput } from "../src/management/codex-cli.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { ProviderQuotaError } from "../src/providers/quota.js";
import { classifyGitHubCopilotQuota } from "../src/providers/github-copilot-quota.js";

const messages = [
  "You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details. private tail",
  "You have exceeded your monthly quota (Request ID: private-request)",
] as const;

describe("provider quota classification", () => {
  it("keeps the exported event schema in parity with the runtime provider gate", () => {
    const gate = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "provider",
      event: "ProviderQuotaBlocked",
      objective: 283,
      runId: "run-provider-schema",
      sequence: 2,
      at: "2026-09-10T12:00:00.000Z",
      reasonCode: "provider-quota-exhausted",
      provider: "another-model-provider",
      phase: "execution",
      backend: "another/local-backend",
      modelInvocationId: "worker-283-1",
      workItem: 283,
      attempt: 1,
      providerMessage: "Model provider quota requires operator action",
      actionUrl: "https://provider.example/quota",
      accounting: "unknown",
    });
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(
      JSON.parse(
        readFileSync(new URL("../schemas/factory-event.schema.json", import.meta.url), "utf8"),
      ),
    );
    expect(validate(gate), JSON.stringify(validate.errors)).toBe(true);
    for (const invalid of [
      { ...gate, actionUrl: "http://provider.example/quota" },
      { ...gate, attempt: undefined },
      { ...gate, accounting: "estimated" },
    ]) {
      expect(validate(invalid)).toBe(false);
      expect(() => parseFactoryEvent(invalid)).toThrow();
    }
  });

  it("keeps the durable gate contract independent of a specific provider adapter", () => {
    expect(
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "provider",
        event: "ProviderQuotaBlocked",
        objective: 283,
        runId: "run-provider-neutral",
        sequence: 2,
        at: "2026-09-10T12:00:00.000Z",
        reasonCode: "provider-quota-exhausted",
        provider: "another-model-provider",
        phase: "management",
        backend: "another/local-backend",
        modelInvocationId: "compile-283",
        providerMessage: "Model provider quota requires operator action",
        accounting: "unknown",
      }),
    ).toMatchObject({
      provider: "another-model-provider",
      providerMessage: "Model provider quota requires operator action",
    });
  });

  it.each(messages)(
    "classifies captured Copilot refusal without retaining diagnostics",
    (message) => {
      const gate = classifyGitHubCopilotQuota(message);
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
    expect(classifyGitHubCopilotQuota(message)).toBeNull();
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
