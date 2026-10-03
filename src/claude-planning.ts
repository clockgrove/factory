import Anthropic from "@anthropic-ai/sdk";
import {
  observeModelInvocation,
  type PlanningModelOptions,
  type PlanningRole,
  type PlanningTransport,
  type PlanningTurn,
  StructuredPlanningModel,
} from "./compiler.js";
import type { ClaudeModelSelection, PlanningConfig } from "./config.js";
import type {
  ModelInvocationContext,
  ModelInvocationUsage,
} from "./contracts.js";
import {
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
} from "./provider-turn.js";
import { normalizeTokenUsage, pickTokenCounters } from "./usage.js";

export const CLAUDE_PLANNING_PROVIDER = "anthropic-claude-api";
export const CLAUDE_PLANNING_ADAPTER = "@anthropic-ai/sdk@0.129.0";

export type ClaudePlanningConfig = Extract<
  PlanningConfig,
  { kind: "claude-api" }
>;

/** The narrow SDK surface the transport uses; tests supply a stub. */
export interface ClaudeMessagesClient {
  messages: Pick<Anthropic["messages"], "stream">;
}

export interface ClaudePlanningModelOptions extends PlanningModelOptions {
  /** Defaults to an SDK client keyed from `credentialEnv`. */
  client?: ClaudeMessagesClient;
  providerTurnIdleTimeoutMs?: number;
}

// Structured outputs reject these JSON Schema keywords. Factory decoders
// still enforce every bound, so the schema only loses grammar guidance.
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
]);
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);
const SCHEMA_LISTS = new Set(["anyOf", "allOf"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The shared planning schema in the Claude structured-output subset.
 * Unsupported constraints move into `description`, as the SDK's own
 * transform does, but `enum` and `const` discriminators stay enforced.
 */
export function claudeOutputSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const result: Record<string, unknown> = {};
  const moved: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (
      UNSUPPORTED_SCHEMA_KEYWORDS.has(key) ||
      (key === "minItems" && value !== 0 && value !== 1)
    )
      moved.push(`${key}: ${JSON.stringify(value)}`);
    else if (SCHEMA_MAPS.has(key) && isRecord(value))
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          claudeOutputSchema(entry),
        ]),
      );
    else if (SCHEMA_LISTS.has(key) && Array.isArray(value))
      result[key] = value.map(claudeOutputSchema);
    else if (key === "items") result[key] = claudeOutputSchema(value);
    else result[key] = value;
  }
  if (moved.length)
    result.description = [result.description, `{${moved.join(", ")}}`]
      .filter((part) => typeof part === "string" && part)
      .join("\n\n");
  return result;
}

/** Messages API usage in Factory's cache-inclusive token categories. */
export function claudeMessageUsage(usage: unknown): ModelInvocationUsage {
  const raw = pickTokenCounters(usage, [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]);
  const details = isRecord(usage) ? usage.output_tokens_details : undefined;
  const thinking = pickTokenCounters(details, ["thinking_tokens"]);
  return normalizeTokenUsage({
    inputTokens:
      raw.input_tokens === undefined
        ? undefined
        : raw.input_tokens +
          (raw.cache_read_input_tokens ?? 0) +
          (raw.cache_creation_input_tokens ?? 0),
    cachedInputTokens: raw.cache_read_input_tokens,
    cacheWriteInputTokens: raw.cache_creation_input_tokens,
    outputTokens: raw.output_tokens,
    reasoningOutputTokens: thinking.thinking_tokens,
  });
}

function apiFailureClass(error: InstanceType<typeof Anthropic.APIError>) {
  if (error.status === 529 || error.type === "overloaded_error")
    return "provider-capacity";
  if (error.status === 429 || error.type === "rate_limit_error")
    return "provider-rate-limit";
  return undefined;
}

/** One streamed Messages API request per attempt, constrained by JSON schema. */
class ClaudePlanningTransport implements PlanningTransport {
  readonly provider = CLAUDE_PLANNING_PROVIDER;
  readonly adapter = CLAUDE_PLANNING_ADAPTER;

  constructor(
    private config: ClaudePlanningConfig,
    private client: ClaudeMessagesClient,
    private providerTurnIdleTimeoutMs: number,
  ) {}

  selection(role: PlanningRole): ClaudeModelSelection {
    return role === "planner" ? this.config.planner : this.config.reviewer;
  }

  settings(role: PlanningRole): Record<string, unknown> {
    return {
      ...this.selection(role),
      maxOutputTokens: this.config.maxOutputTokens,
      thinking: "adaptive",
      tools: "none",
    };
  }

  async run(args: {
    role: PlanningRole;
    prompt: string;
    schema: unknown;
    invocation: ModelInvocationContext;
    turn: PlanningTurn;
  }): Promise<void> {
    const { invocation, turn: state } = args;
    const { model, reasoningEffort } = this.selection(args.role);
    const started = Date.now();
    const guard = new ProviderTurnGuard(this.providerTurnIdleTimeoutMs);
    let message: Anthropic.Message;
    try {
      const stream = this.client.messages.stream(
        {
          model,
          max_tokens: this.config.maxOutputTokens,
          thinking: { type: "adaptive" },
          output_config: {
            effort: reasoningEffort,
            format: {
              type: "json_schema",
              schema: claudeOutputSchema(args.schema) as Record<
                string,
                unknown
              >,
            },
          },
          messages: [{ role: "user", content: args.prompt }],
        },
        { signal: guard.signal },
      );
      const events = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await guard.race(events.next());
        if (next.done) break;
        guard.progress();
        if (next.value.type !== "message_start") continue;
        state.providerThreadId = next.value.message.id;
        observeModelInvocation(invocation, {
          type: "progress",
          provider: this.provider,
          model,
          reasoningEffort,
          providerThreadId: state.providerThreadId,
          providerEvent: next.value.type,
        });
      }
      message = await guard.race(stream.finalMessage());
    } catch (error) {
      // An API error response is a provider verdict; a lost connection is not.
      if (
        error instanceof Anthropic.APIError &&
        (error.status !== undefined || error.type)
      ) {
        state.ended = true;
        state.failureClass = apiFailureClass(error);
      }
      throw error;
    } finally {
      guard.finish();
    }
    state.ended = true;
    state.providerThreadId = message.id;
    state.response = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    state.usage = claudeMessageUsage(message.usage);
    const raw = pickTokenCounters(message.usage, [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]);
    observeModelInvocation(invocation, {
      type: "progress",
      capture: {
        event: {
          kind: "usage",
          reportedModel: message.model,
          usage: {
            scope: "invocation-cumulative",
            terminal: true,
            completeness: Object.keys(raw).length
              ? "available-categories"
              : "unavailable",
            normalized: state.usage,
            raw,
          },
        },
      },
    });
    observeModelInvocation(invocation, {
      type: "progress",
      capture: {
        event: {
          kind: "outcome",
          outcome: {
            stage: "provider",
            status: message.stop_reason ?? "unknown",
          },
          durationMs: Date.now() - started,
        },
      },
    });
    // Only a natural end carries complete schema-constrained output.
    if (message.stop_reason !== "end_turn") {
      state.failureClass =
        message.stop_reason === "refusal"
          ? "provider-refusal"
          : "provider-incomplete";
      const category = message.stop_details?.category;
      throw new Error(
        `Claude response ended with stop_reason ${message.stop_reason ?? "null"}${category ? ` (${category})` : ""}`,
      );
    }
  }
}

/** Planning and review through the Claude Messages API. */
export class ClaudePlanningModel extends StructuredPlanningModel {
  constructor(
    config: ClaudePlanningConfig,
    apiKey: string,
    options: ClaudePlanningModelOptions = {},
  ) {
    super(
      new ClaudePlanningTransport(
        config,
        options.client ??
          new Anthropic({
            apiKey,
            authToken: null,
            baseURL: "https://api.anthropic.com",
            // Factory owns bounded review capacity retries.
            maxRetries: 0,
          }),
        options.providerTurnIdleTimeoutMs ??
          DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
      ),
      options,
    );
  }
}
