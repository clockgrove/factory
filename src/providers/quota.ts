export const PROVIDER_QUOTA_REASON_CODE = "provider-quota-exhausted" as const;
export const COPILOT_QUOTA_ACTION_URL = "https://github.com/settings/copilot/features" as const;

export interface ProviderQuotaGate {
  reasonCode: typeof PROVIDER_QUOTA_REASON_CODE;
  provider: "github-copilot";
  message:
    | "GitHub Copilot additional usage limit reached"
    | "GitHub Copilot monthly quota exceeded";
  actionUrl: typeof COPILOT_QUOTA_ACTION_URL;
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

/** Match only the two captured Copilot entitlement/quota messages from the provider stream. */
export function classifyProviderQuota(value: unknown): ProviderQuotaGate | null {
  if (typeof value !== "string") return null;
  if (/you(?:'|’)ve reached your additional usage limit for your plan/i.test(value)) {
    return {
      reasonCode: PROVIDER_QUOTA_REASON_CODE,
      provider: "github-copilot",
      message: "GitHub Copilot additional usage limit reached",
      actionUrl: COPILOT_QUOTA_ACTION_URL,
    };
  }
  if (/you have exceeded your monthly quota/i.test(value)) {
    return {
      reasonCode: PROVIDER_QUOTA_REASON_CODE,
      provider: "github-copilot",
      message: "GitHub Copilot monthly quota exceeded",
      actionUrl: COPILOT_QUOTA_ACTION_URL,
    };
  }
  return null;
}

/** Read only documented message slots; never stringify an arbitrary diagnostic object. */
export function providerQuotaFromStreamEvent(event: unknown): ProviderQuotaGate | null {
  if (!event || typeof event !== "object") return null;
  const record = event as { message?: unknown; error?: unknown };
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as { message?: unknown }).message
      : undefined;
  return classifyProviderQuota(nested) ?? classifyProviderQuota(record.message);
}
