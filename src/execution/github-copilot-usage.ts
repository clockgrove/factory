import type { SessionEvent } from "@github/copilot-sdk";
import type { ModelInvocationUsage } from "../contracts.js";
import { pickTokenCounters } from "../usage.js";
import { redact } from "./harness-support.js";

const tokenFields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Per-call SDK metrics, accumulated only for this worker invocation. */
export class CopilotUsage {
  private events = new Set<string>();
  private calls = new Set<string>();
  private count = 0;
  private input: number | undefined = 0;
  private output: number | undefined = 0;

  constructor(private secrets: string[]) {}

  observe(
    event: SessionEvent,
    sessionId: string | undefined,
  ): Record<string, unknown> | undefined {
    if (event.type !== "assistant.usage") return;
    const { data } = event;
    const eventId =
      typeof event.id === "string" && event.id ? event.id : undefined;
    const apiCallId =
      typeof data.apiCallId === "string" && data.apiCallId
        ? data.apiCallId
        : undefined;
    const providerCallId =
      typeof data.providerCallId === "string" && data.providerCallId
        ? data.providerCallId
        : undefined;
    const callKeys = [
      ...(apiCallId ? [JSON.stringify([sessionId, "api", apiCallId])] : []),
      ...(providerCallId
        ? [JSON.stringify([sessionId, "provider", providerCallId])]
        : []),
    ];
    if (
      (eventId && this.events.has(eventId)) ||
      callKeys.some((key) => this.calls.has(key))
    )
      return;
    if (eventId) this.events.add(eventId);
    for (const key of callKeys) this.calls.add(key);
    this.count += 1;
    const tokens = pickTokenCounters(data, tokenFields);
    // Without a stable event/call identity, deduplication cannot be established.
    const identified = Boolean(eventId || callKeys.length);
    const add = (total: number | undefined, value: unknown) => {
      if (!identified || total === undefined || !tokenCount(value)) return;
      const sum = total + value;
      return tokenCount(sum) ? sum : undefined;
    };
    this.input = add(this.input, data.inputTokens);
    this.output = add(this.output, data.outputTokens);
    const safe = (value: string | undefined) =>
      value === undefined ? undefined : redact(value, this.secrets);
    return {
      providerEventId: safe(eventId),
      providerSessionId: safe(sessionId),
      apiCallId: safe(apiCallId),
      providerCallId: safe(providerCallId),
      usage: tokens,
    };
  }

  /** Publish once at termination; a later missing field cannot expose a partial sum. */
  totals(): ModelInvocationUsage {
    if (!this.count) return {};
    return {
      ...(this.input === undefined ? {} : { inputTokens: this.input }),
      ...(this.output === undefined ? {} : { outputTokens: this.output }),
    };
  }
}
