import type { SessionEvent } from "@github/copilot-sdk";
import type { ModelInvocationUsage } from "../contracts.js";
import {
  normalizeTokenUsage,
  pickTokenCounters,
  tokenCategories,
} from "../usage.js";
import { redact } from "./harness-support.js";

const tokenFields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
const valid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Raw SDK input counters lack a pinned inclusive-input contract. Do not manufacture a denominator. */
export function copilotTokenUsage(
  raw: Record<string, number>,
): ModelInvocationUsage {
  return normalizeTokenUsage({
    outputTokens: raw.outputTokens,
    cachedInputTokens: raw.cacheReadTokens,
    cacheWriteInputTokens: raw.cacheWriteTokens,
    reasoningOutputTokens: raw.reasoningTokens,
  });
}

/** Current invocation only; history is excluded before dispatch, identities deduplicate concrete calls. */
export class CopilotUsage {
  private previous = new Set<string>();
  private identities = new Map<
    string,
    { fingerprint: string; usage: ModelInvocationUsage }
  >();
  private records: ModelInvocationUsage[] = [];
  private uncertain = false;
  constructor(private secrets: string[]) {}

  private keys(event: SessionEvent, sessionId: string | undefined): string[] {
    if (event.type !== "assistant.usage") return [];
    return [
      ["event", event.id],
      ["api", event.data.apiCallId],
      ["provider", event.data.providerCallId],
    ].flatMap(([kind, id]) =>
      typeof id === "string" && id
        ? [JSON.stringify([sessionId, kind, id])]
        : [],
    );
  }
  excludeHistory(events: readonly SessionEvent[], sessionId: string): void {
    for (const event of events)
      for (const key of this.keys(event, sessionId)) this.previous.add(key);
  }
  observe(
    event: SessionEvent,
    sessionId: string | undefined,
  ): Record<string, unknown> | undefined {
    if (event.type !== "assistant.usage") return;
    const keys = this.keys(event, sessionId);
    if (keys.some((key) => this.previous.has(key))) return;
    const raw = pickTokenCounters(event.data, tokenFields);
    const normalizedUsage = copilotTokenUsage(raw);
    const fingerprint = JSON.stringify(raw);
    const matched = keys.flatMap((key) =>
      this.identities.has(key) ? [this.identities.get(key)!] : [],
    );
    if (matched.length) {
      if (
        matched.some((record) => record.fingerprint !== fingerprint) ||
        new Set(matched).size !== 1
      )
        this.uncertain = true;
      for (const key of keys) this.identities.set(key, matched[0]!);
      return;
    }
    if (!keys.length || !sessionId) this.uncertain = true;
    const record = { fingerprint, usage: normalizedUsage };
    for (const key of keys) this.identities.set(key, record);
    this.records.push(normalizedUsage);
    const safe = (value: string | undefined) =>
      value === undefined ? undefined : redact(value, this.secrets);
    return {
      providerEventId: safe(event.id),
      providerSessionId: safe(sessionId),
      apiCallId: safe(event.data.apiCallId),
      providerCallId: safe(event.data.providerCallId),
      usage: raw,
      normalizedUsage,
      inputSemantics: "provider-reported-inclusion-unknown",
    };
  }
  totals(): ModelInvocationUsage {
    if (!this.records.length || this.uncertain) return {};
    const result: ModelInvocationUsage = {};
    for (const key of tokenCategories) {
      const values = this.records.map((record) => record[key]);
      if (values.every(valid)) {
        const total = values.reduce((sum, value) => sum + value, 0);
        if (valid(total)) result[key] = total;
      }
    }
    return result;
  }
}
