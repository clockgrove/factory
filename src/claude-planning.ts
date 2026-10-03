import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  observeModelInvocation,
  type PlanningModelOptions,
  type PlanningRole,
  type PlanningTransport,
  type PlanningTurn,
  StructuredPlanningModel,
} from "./compiler.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  type ClaudeModelSelection,
  type PlanningConfig,
} from "./config.js";
import type { ModelInvocationContext } from "./contracts.js";
import {
  claudeAuthenticationValues,
  claudeWorkerEnvironment,
} from "./execution/claude.js";
import {
  ClaudeUsage,
  claudeCost,
  claudeModelUsage,
  claudeRawTokenUsage,
} from "./execution/claude-usage.js";
import { redact } from "./execution/harness-support.js";
import { claudeCaptureEvents } from "./execution/interaction-capture.js";
import {
  closeProviderEventStream,
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
  requireCompletedProviderTurn,
} from "./provider-turn.js";

export const CLAUDE_PLANNING_PROVIDER = "anthropic-claude-agent-sdk";
export const CLAUDE_PLANNING_ADAPTER = CLAUDE_AGENT_SDK_ADAPTER_IDENTITY;

/** The Agent SDK's internal tool that carries `outputFormat` results. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/** One answer plus the SDK's bounded schema-repair turns. */
const CLAUDE_PLANNING_MAX_TURNS = 4;

const systemPrompt = [
  "You are the planning and review model for Clockgrove Factory.",
  "The user message is the complete request; you have no tools, files or network.",
  "Return exactly the requested result through the structured output.",
].join(" ");

export type ClaudePlanningConfig = Extract<
  PlanningConfig,
  { kind: "claude-agent-sdk" }
>;

/** The narrow Agent SDK surface the transport uses; tests supply a fake. */
export type ClaudePlanningQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

export interface ClaudePlanningModelOptions extends PlanningModelOptions {
  /** Defaults to the pinned Agent SDK `query`. */
  query?: ClaudePlanningQuery;
  providerTurnIdleTimeoutMs?: number;
  /** Capture redaction only; never sent to the provider. */
  redactionValues?: string[];
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

/**
 * A tool-free, isolated Agent SDK session for one structured answer.
 * Authentication is whatever the SDK resolves from the operator's Claude
 * login, CLAUDE_CODE_OAUTH_TOKEN or an optional ANTHROPIC_API_KEY.
 */
export function claudePlanningOptions(input: {
  config: ClaudePlanningConfig;
  selection: ClaudeModelSelection;
  schema: unknown;
  cwd: string;
  credentialDirectory: string;
  abortController: AbortController;
}): Options {
  return {
    abortController: input.abortController,
    cwd: input.cwd,
    model: input.selection.model,
    effort: input.selection.reasoningEffort,
    thinking: { type: "adaptive" },
    outputFormat: {
      type: "json_schema",
      schema: claudeOutputSchema(input.schema) as Record<string, unknown>,
    },
    // No built-in tools, MCP servers, agents, plugins, skills or settings.
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk",
    mcpServers: {},
    strictMcpConfig: true,
    agents: {},
    plugins: [],
    skills: [],
    settingSources: [],
    settings: {
      syncClaudeAiPlugins: false,
      syncClaudeAiSkills: false,
      autoMemoryEnabled: false,
      disableBundledSkills: true,
      claudeMdExcludes: ["**"],
    },
    systemPrompt,
    // Prompts carry untrusted source text; never expand @paths or commands.
    verbatimPrompts: true,
    maxTurns: CLAUDE_PLANNING_MAX_TURNS,
    persistSession: false,
    env: {
      ...claudeWorkerEnvironment(input.credentialDirectory),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.config.maxOutputTokens),
      DISABLE_TELEMETRY: "1",
    },
  };
}

async function loadClaudeQuery(): Promise<ClaudePlanningQuery> {
  try {
    return (await import("@anthropic-ai/claude-agent-sdk")).query;
  } catch (error) {
    throw new Error(
      `Claude planning requires the optional ${CLAUDE_AGENT_SDK_ADAPTER_IDENTITY} package: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Fail closed when the session exposes anything beyond structured output. */
function assertPlanningInitialization(
  message: SDKSystemMessage,
  model: string,
): void {
  if (message.model !== model)
    throw new Error(
      `Claude SDK selected model ${message.model}, expected ${model}`,
    );
  const tool = message.tools.find((name) => name !== STRUCTURED_OUTPUT_TOOL);
  if (tool) throw new Error(`Claude SDK exposed unconfigured tool ${tool}`);
  if (message.mcp_servers.length)
    throw new Error("Claude SDK initialized an unconfigured MCP server");
}

const authenticationErrors = new Set<SDKAssistantMessageError>([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "cloud_credential_error",
]);

function failureClass(
  result: SDKResultMessage,
  assistantError: SDKAssistantMessageError | undefined,
): string | undefined {
  const status =
    result.subtype === "success" ? result.api_error_status : undefined;
  if (status === 529 || assistantError === "overloaded")
    return "provider-capacity";
  if (status === 429 || assistantError === "rate_limit")
    return "provider-rate-limit";
  if (
    status === 401 ||
    (assistantError && authenticationErrors.has(assistantError))
  )
    return "provider-authentication";
  if (
    result.subtype === "error_max_turns" ||
    result.stop_reason === "max_tokens" ||
    assistantError === "max_output_tokens"
  )
    return "provider-incomplete";
  if (result.subtype === "error_max_structured_output_retries")
    return "provider-structured-output";
  return undefined;
}

/** One isolated Agent SDK query per attempt, constrained by JSON schema. */
class ClaudePlanningTransport implements PlanningTransport {
  readonly provider = CLAUDE_PLANNING_PROVIDER;
  readonly adapter = CLAUDE_PLANNING_ADAPTER;
  private readonly secrets: string[];

  constructor(
    private config: ClaudePlanningConfig,
    private query: ClaudePlanningQuery | undefined,
    private providerTurnIdleTimeoutMs: number,
    redactionValues: string[],
  ) {
    this.secrets = [
      ...new Set([
        ...redactionValues,
        ...claudeAuthenticationValues(process.env),
      ]),
    ];
  }

  selection(role: PlanningRole): ClaudeModelSelection {
    return role === "planner" ? this.config.planner : this.config.reviewer;
  }

  settings(role: PlanningRole): Record<string, unknown> {
    return {
      ...this.selection(role),
      maxOutputTokens: this.config.maxOutputTokens,
      maxTurns: CLAUDE_PLANNING_MAX_TURNS,
      thinking: "adaptive",
      tools: "none",
      settingSources: [],
      outputFormat: "json_schema",
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
    const selection = this.selection(args.role);
    const { model, reasoningEffort } = selection;
    const started = Date.now();
    const guard = new ProviderTurnGuard(this.providerTurnIdleTimeoutMs);
    const abortController = new AbortController();
    guard.signal.addEventListener(
      "abort",
      () => abortController.abort(guard.signal.reason),
      { once: true },
    );
    // An empty private directory: the session has nothing to read or load.
    const root = mkdtempSync(join(tmpdir(), "factory-claude-planning-"));
    const usage = new ClaudeUsage(this.secrets);
    let events: AsyncIterator<SDKMessage> | undefined;
    let closeStarted = false;
    let initialized = false;
    let assistantError: SDKAssistantMessageError | undefined;
    let result: SDKResultMessage | undefined;
    try {
      const query = this.query ?? (await guard.race(loadClaudeQuery()));
      const cwd = join(root, "cwd");
      const credentialDirectory = join(root, "empty-gh-config");
      mkdirSync(cwd, { mode: 0o700 });
      mkdirSync(credentialDirectory, { mode: 0o700 });
      events = query({
        prompt: args.prompt,
        options: claudePlanningOptions({
          config: this.config,
          selection,
          schema: args.schema,
          cwd,
          credentialDirectory,
          abortController,
        }),
      })[Symbol.asyncIterator]();
      for (;;) {
        const next = await guard.race(events.next());
        if (next.done) break;
        const message = next.value;
        guard.progress();
        if ("session_id" in message && typeof message.session_id === "string")
          state.providerThreadId ??= message.session_id;
        if (message.type === "assistant" && message.error)
          assistantError = message.error;
        const captures = claudeCaptureEvents(
          message,
          this.secrets,
          usage.observe(message),
        );
        for (const [index, capture] of [
          ...(captures.length ? captures : [undefined]),
        ].entries())
          observeModelInvocation(invocation, {
            type: "progress",
            ...(capture && { capture }),
            ...(index === 0 && {
              provider: this.provider,
              model,
              reasoningEffort,
              providerThreadId: state.providerThreadId,
              providerEvent: message.type,
            }),
          });
        if (message.type === "system" && message.subtype === "init") {
          assertPlanningInitialization(message, model);
          initialized = true;
        }
        if (message.type === "result") {
          result = message;
          break;
        }
      }
      closeStarted = true;
      await closeProviderEventStream(events, guard, true);
    } catch (error) {
      if (events && !closeStarted && !guard.signal.aborted) {
        closeStarted = true;
        try {
          await closeProviderEventStream(events, guard, true);
        } catch {
          // Preserve the provider failure that required cleanup.
        }
      }
      throw error;
    } finally {
      if (events && !closeStarted)
        void closeProviderEventStream(events, guard, false);
      guard.finish();
      rmSync(root, { recursive: true, force: true });
    }
    requireCompletedProviderTurn(result !== undefined);
    this.settle(result!, {
      state,
      invocation,
      usage,
      started,
      initialized,
      assistantError,
    });
  }

  /** Record terminal usage and outcome, then accept only structured output. */
  private settle(
    result: SDKResultMessage,
    context: {
      state: PlanningTurn;
      invocation: ModelInvocationContext;
      usage: ClaudeUsage;
      started: number;
      initialized: boolean;
      assistantError?: SDKAssistantMessageError;
    },
  ): void {
    const { state, invocation } = context;
    state.ended = true;
    const totals = context.usage.totals();
    state.usage = Object.keys(totals).length ? totals : undefined;
    const models = Object.keys(result.modelUsage ?? {});
    const cost = claudeCost(result.total_cost_usd);
    const succeeded = result.subtype === "success" && !result.is_error;
    observeModelInvocation(invocation, {
      type: "progress",
      capture: {
        event: {
          kind: "usage",
          ...(models.length === 1 && {
            reportedModel: redact(models[0]!, this.secrets),
          }),
          usage: {
            scope: "invocation-cumulative",
            terminal: true,
            completeness: state.usage ? "available-categories" : "unavailable",
            normalized: totals,
            raw: claudeRawTokenUsage(result.usage),
            modelBreakdown: claudeModelUsage(result.modelUsage, this.secrets),
            ...(cost !== undefined &&
              result.subtype !== "error_during_execution" && {
                cost: {
                  value: cost,
                  currency: "USD" as const,
                  kind: "provider-estimate" as const,
                  completeness: succeeded
                    ? ("available" as const)
                    : ("partial" as const),
                  provenance: "Claude SDK total_cost_usd",
                },
              }),
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
            status: succeeded
              ? (result.stop_reason ?? "success")
              : result.subtype === "success"
                ? "error"
                : result.subtype,
          },
          durationMs: Date.now() - context.started,
        },
      },
    });
    if (result.stop_reason === "refusal") {
      state.failureClass = "provider-refusal";
      throw new Error("Claude response ended with stop_reason refusal");
    }
    if (!succeeded) {
      state.failureClass = failureClass(result, context.assistantError);
      const detail = redact(
        result.subtype === "success" ? result.result : result.errors.join("; "),
        this.secrets,
      );
      throw new Error(
        `Claude planning ended with ${result.subtype}${result.stop_reason ? ` (stop_reason ${result.stop_reason})` : ""}: ${detail || "no detail"}${
          state.failureClass === "provider-authentication"
            ? "; sign in with `claude auth login`, or set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY for the controller"
            : ""
        }`,
      );
    }
    if (!context.initialized)
      throw new Error("Claude SDK did not report its initialized session");
    if (result.structured_output === undefined) {
      state.failureClass = "provider-incomplete";
      throw new Error("Claude result carried no structured output");
    }
    state.response = JSON.stringify(result.structured_output);
  }
}

/** Planning and review through the Claude Agent SDK and the operator's login. */
export class ClaudePlanningModel extends StructuredPlanningModel {
  constructor(
    config: ClaudePlanningConfig,
    options: ClaudePlanningModelOptions = {},
  ) {
    super(
      new ClaudePlanningTransport(
        config,
        options.query,
        options.providerTurnIdleTimeoutMs ??
          DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
        options.redactionValues ?? [],
      ),
      options,
    );
  }
}
