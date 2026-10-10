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
  return normalizeCodexTokenUsage({
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    totalTokens: usage.total_tokens,
  });
}

/** Codex drops upstream detail presence and defaults absent optional counters to zero. */
export function normalizeCodexTokenUsage(value: unknown): ModelInvocationUsage {
  const usage = normalizeTokenUsage(value);
  // Native exec also emits wholly zero default usage when no accounting arrived.
  if (!Object.values(usage).some((counter) => counter > 0)) return {};
  for (const key of [
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningOutputTokens",
  ] as const)
    if (usage[key] === 0) delete usage[key];
  return usage;
}

export function isCodexUsageIdentity(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === "codex" ||
      value === "codex-sdk" ||
      value === "openai-codex-sdk" ||
      value.startsWith("@openai/codex@") ||
      value.startsWith("@openai/codex-sdk@"))
  );
}

/** SDK and native streams share the same upstream zero ambiguity. Raw receipts stay intact. */
export function codexSdkTokenUsage(value: unknown): ModelInvocationUsage {
  return codexTokenUsage(value);
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

/** Comparable authenticated cumulative categories only; missing/reset counters stay absent. */
export function cumulativeTokenUsageDelta(
  cumulative: ModelInvocationUsage,
  baseline: ModelInvocationUsage,
): ModelInvocationUsage {
  const current = normalizeTokenUsage(cumulative);
  const before = normalizeTokenUsage(baseline);
  const delta: ModelInvocationUsage = {};
  for (const category of tokenCategories) {
    const previous = before[category];
    const after = current[category];
    if (previous !== undefined && after !== undefined && after >= previous)
      delta[category] = after - previous;
  }
  return delta;
}

/** Counts all observed input; a paired cache cohort remains a separate denominator. */
export function summarizeInputCaching(values: readonly ModelInvocationUsage[]) {
  const normalized = values.map(normalizeTokenUsage);
  const inputs = normalized.filter((usage) => usage.inputTokens !== undefined);
  const pairs = inputs.filter((usage) => usage.cachedInputTokens !== undefined);
  const sum = (
    selected: ModelInvocationUsage[],
    key: "inputTokens" | "cachedInputTokens",
  ) => {
    const total = selected.reduce((sum, usage) => sum + usage[key]!, 0);
    return selected.length && Number.isSafeInteger(total) ? total : null;
  };
  const allInputTokens = sum(inputs, "inputTokens");
  const pairedInputTokens = sum(pairs, "inputTokens");
  const knownCachedInputTokens = sum(pairs, "cachedInputTokens");
  return {
    allInputTokens,
    pairedInputTokens,
    knownCachedInputTokens,
    knownFreshInputTokens:
      pairedInputTokens !== null && knownCachedInputTokens !== null
        ? pairedInputTokens - knownCachedInputTokens
        : null,
    inputWithUnknownCachedCategory:
      allInputTokens !== null && pairedInputTokens !== null
        ? allInputTokens - pairedInputTokens
        : allInputTokens,
    knownCachedFractionOfAllObservedInput:
      allInputTokens && knownCachedInputTokens !== null
        ? knownCachedInputTokens / allInputTokens
        : null,
    pairedCacheFraction:
      pairedInputTokens && knownCachedInputTokens !== null
        ? knownCachedInputTokens / pairedInputTokens
        : null,
    inputContributors: inputs.length,
    cacheContributors: pairs.length,
    eligibleObservations: values.length,
    inputCoverage:
      !inputs.length || allInputTokens === null
        ? ("unavailable" as const)
        : inputs.length === values.length
          ? ("available" as const)
          : ("partial" as const),
    cacheCoverage:
      !pairs.length || knownCachedInputTokens === null
        ? ("unavailable" as const)
        : pairs.length === values.length
          ? ("available" as const)
          : ("partial" as const),
  };
}

/** Pinned Codex exec emits thread totals, including earlier resumed turns. */
export function codexInvocationUsage(
  cumulative: unknown,
  baseline?: ModelInvocationUsage,
): ModelInvocationUsage {
  const current = codexSdkTokenUsage(cumulative);
  if (baseline === undefined) return current;
  return normalizeCodexTokenUsage(cumulativeTokenUsageDelta(current, baseline));
}
