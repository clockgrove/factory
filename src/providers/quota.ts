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
