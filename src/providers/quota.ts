export const PROVIDER_QUOTA_REASON_CODE = "provider-quota-exhausted" as const;

/** Provider-neutral, already-redacted account quota metadata emitted by an adapter. */
export interface ProviderQuotaGate {
  reasonCode: typeof PROVIDER_QUOTA_REASON_CODE;
  provider: string;
  message: string;
  actionUrl?: string | undefined;
}

export interface ProviderQuotaUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number | undefined;
}

/** Owner-supplied durability port that every provider adapter must await before exposing a refusal. */
export type ProviderQuotaCheckpoint = (error: ProviderQuotaError) => Promise<void>;

/** Partial provider counters never become an exact refusal receipt. */
export function exactProviderQuotaUsage(usage: {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}): ProviderQuotaUsage | undefined {
  if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens))
    return undefined;
  if (usage.inputTokens! < 0 || usage.outputTokens! < 0) return undefined;
  if (
    usage.cachedInputTokens !== null &&
    (!Number.isSafeInteger(usage.cachedInputTokens) ||
      usage.cachedInputTokens < 0 ||
      usage.cachedInputTokens > usage.inputTokens!)
  )
    return undefined;
  return {
    inputTokens: usage.inputTokens!,
    outputTokens: usage.outputTokens!,
    ...(usage.cachedInputTokens === null ? {} : { cachedInputTokens: usage.cachedInputTokens }),
  };
}

/** A captured account-level refusal. Arbitrary provider diagnostics are never retained here. */
export class ProviderQuotaError extends Error {
  readonly gate: ProviderQuotaGate;
  usage: ProviderQuotaUsage | undefined;
  invocationId: string | undefined;

  constructor(
    gate: ProviderQuotaGate,
    options: { usage?: ProviderQuotaUsage; invocationId?: string; cause?: unknown } = {},
  ) {
    super(gate.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderQuotaError";
    this.gate = { ...gate };
    this.usage = options.usage ? { ...options.usage } : undefined;
    this.invocationId = options.invocationId;
  }

  bindInvocation(invocationId: string): this {
    if (this.invocationId && this.invocationId !== invocationId)
      throw new Error("provider quota failure conflicts with its invocation identity");
    this.invocationId = invocationId;
    return this;
  }

  bindUsage(usage: ProviderQuotaUsage): this {
    if (
      this.usage &&
      (this.usage.inputTokens !== usage.inputTokens ||
        this.usage.outputTokens !== usage.outputTokens ||
        this.usage.cachedInputTokens !== usage.cachedInputTokens)
    )
      throw new Error("provider quota failure conflicts with its reported usage");
    this.usage = { ...usage };
    return this;
  }
}

/** Retain the provider result while accumulating failures from later durability or cleanup work. */
export function preserveProviderQuotaError(
  error: ProviderQuotaError,
  cause: unknown,
  message: string,
): ProviderQuotaError {
  return new ProviderQuotaError(error.gate, {
    ...(error.usage ? { usage: error.usage } : {}),
    ...(error.invocationId ? { invocationId: error.invocationId } : {}),
    cause: error.cause === undefined ? cause : new AggregateError([error.cause, cause], message),
  });
}
