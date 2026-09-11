import { PROVIDER_QUOTA_REASON_CODE, type ProviderQuotaGate } from "./quota.js";

export const COPILOT_QUOTA_ACTION_URL = "https://github.com/settings/copilot/features" as const;

/** Match only the two captured Copilot entitlement/quota messages from the provider stream. */
export function classifyGitHubCopilotQuota(value: unknown): ProviderQuotaGate | null {
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
export function githubCopilotQuotaFromStreamEvent(event: unknown): ProviderQuotaGate | null {
  if (!event || typeof event !== "object") return null;
  const record = event as { message?: unknown; error?: unknown };
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as { message?: unknown }).message
      : undefined;
  return classifyGitHubCopilotQuota(nested) ?? classifyGitHubCopilotQuota(record.message);
}
