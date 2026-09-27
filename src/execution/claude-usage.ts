import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInvocationUsage } from "../contracts.js";
import { normalizeTokenUsage, pickTokenCounters } from "../usage.js";
import { redact } from "./harness-support.js";

const modelFields = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "thinkingTokens",
] as const;

export function claudeRawTokenUsage(value: unknown): Record<string, number> {
  return pickTokenCounters(value, [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]);
}

export function claudeModelUsage(
  value: unknown,
  secrets: string[],
): Record<string, Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([model, counters]) => [
      redact(model, secrets),
      pickTokenCounters(counters, modelFields),
    ]),
  );
}

export function claudeCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** SDK 0.3.281 modelUsage totals cover this fresh query's model pipeline. */
export function claudeTokenUsage(value: unknown): ModelInvocationUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const models = Object.values(value).map((entry) =>
    pickTokenCounters(entry, modelFields),
  );
  if (!models.length) return {};
  const sum = (fields: readonly string[]) => {
    let total = 0;
    for (const model of models)
      for (const field of fields) {
        const count = model[field];
        if (count === undefined) return;
        total += count;
        if (!Number.isSafeInteger(total)) return;
      }
    return total;
  };
  // The pinned runtime accumulates raw API input_tokens separately from cache
  // reads/writes. Include all three for the common cache-inclusive denominator.
  const usage = normalizeTokenUsage({
    inputTokens: sum([
      "inputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
    ]),
    cachedInputTokens: sum(["cacheReadInputTokens"]),
    cacheWriteInputTokens: sum(["cacheCreationInputTokens"]),
    outputTokens: sum(["outputTokens"]),
    reasoningOutputTokens: sum(["thinkingTokens"]),
  });
  if (
    usage.reasoningOutputTokens !== undefined &&
    usage.outputTokens !== undefined &&
    usage.reasoningOutputTokens > usage.outputTokens
  )
    delete usage.reasoningOutputTokens;
  return usage;
}

export class ClaudeUsage {
  private seen = new Set<string>();
  private usage: ModelInvocationUsage = {};
  constructor(private secrets: string[]) {}

  observe(message: SDKMessage): Record<string, unknown> | undefined {
    if (message.type === "result") {
      // This subtype can contain SDK-reset zeroes after a process crash.
      this.usage =
        message.subtype === "error_during_execution"
          ? {}
          : claudeTokenUsage(message.modelUsage);
      return;
    }
    if (message.type !== "assistant") return;
    const key = JSON.stringify([message.session_id, message.message.id]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    return {
      providerEventId: redact(message.uuid, this.secrets),
      providerMessageId: redact(message.message.id, this.secrets),
      usage: claudeRawTokenUsage(message.message.usage),
    };
  }

  totals(): ModelInvocationUsage {
    return { ...this.usage };
  }
}
