import { z } from "zod";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Provider-reported counters only; cached input is already included in input. */
export const ReportedModelUsageSchema = z
  .object({
    inputTokens: counter.optional(),
    outputTokens: counter.optional(),
    cachedInputTokens: counter.optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (Object.values(usage).every((value) => value === undefined))
      context.addIssue({
        code: "custom",
        message: "reported model usage must contain a supplied counter",
      });
    if (
      usage.inputTokens !== undefined &&
      usage.cachedInputTokens !== undefined &&
      usage.cachedInputTokens > usage.inputTokens
    )
      context.addIssue({
        code: "custom",
        path: ["cachedInputTokens"],
        message: "cached input cannot exceed input tokens",
      });
    if (
      usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined &&
      !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
    )
      context.addIssue({
        code: "custom",
        message: "reported input plus output exceeds the safe integer range",
      });
  });

export type ReportedModelUsage = z.infer<typeof ReportedModelUsageSchema>;

/** Optional telemetry must not suppress otherwise trustworthy scalar accounting. */
export function reportedModelUsage(usage?: {
  inputTokens?: number | null | undefined;
  outputTokens?: number | null | undefined;
  cachedInputTokens?: number | null | undefined;
}): ReportedModelUsage | undefined {
  if (!usage) return undefined;
  const supplied: Record<string, number> = Object.fromEntries(
    (["inputTokens", "outputTokens", "cachedInputTokens"] as const)
      .filter(
        (name) =>
          typeof usage[name] === "number" && Number.isSafeInteger(usage[name]) && usage[name]! >= 0,
      )
      .map((name) => [name, usage[name] as number]),
  );
  if (
    supplied.inputTokens !== undefined &&
    supplied.cachedInputTokens !== undefined &&
    supplied.cachedInputTokens > supplied.inputTokens
  )
    delete supplied.cachedInputTokens;
  const parsed = ReportedModelUsageSchema.safeParse(supplied);
  return parsed.success ? parsed.data : undefined;
}
