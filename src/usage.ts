import type { ModelInvocationUsage } from "./contracts.js";

export const tokenCategories = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

/** Whitelist counters; absent, invalid and unsupported categories stay absent. */
export function normalizeTokenUsage(value: unknown): ModelInvocationUsage {
  const usage: ModelInvocationUsage = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return usage;
  const supplied = value as Record<string, unknown>;
  for (const key of tokenCategories) {
    const counter = supplied[key];
    if (
      typeof counter === "number" &&
      Number.isSafeInteger(counter) &&
      counter >= 0
    )
      usage[key] = counter;
  }
  if (
    usage.inputTokens !== undefined &&
    usage.cachedInputTokens !== undefined &&
    usage.cachedInputTokens > usage.inputTokens
  )
    delete usage.cachedInputTokens;
  return usage;
}

/** Adapter-specific mapping, not arbitrary result/evidence parsing. */
export function codexTokenUsage(value: unknown): ModelInvocationUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const usage = value as Record<string, unknown>;
  return normalizeTokenUsage({
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    totalTokens: usage.total_tokens,
  });
}

/** Safe raw counters only; never retain arbitrary provider usage payloads. */
export function pickTokenCounters(
  value: unknown,
  fields: readonly string[],
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const supplied = value as Record<string, unknown>;
  return Object.fromEntries(
    fields.flatMap((field) => {
      const count = supplied[field];
      return typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0
        ? [[field, count]]
        : [];
    }),
  );
}

export function codexRawTokenUsage(value: unknown): Record<string, number> {
  return pickTokenCounters(value, [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]);
}
