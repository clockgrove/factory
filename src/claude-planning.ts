import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccountInfo,
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
import {
  AuthenticationRequiredError,
  type ModelInvocationContext,
} from "./contracts.js";
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
import { authenticationFailure, redact } from "./execution/harness-support.js";
import { claudeCaptureEvents } from "./execution/interaction-capture.js";
import { serviceLoginSecrets } from "./provider-credentials.js";
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

/** Shared by every Claude planning call; plan-eval judges hash it into their digest. */
export const CLAUDE_PLANNING_SYSTEM_PROMPT = [
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
    systemPrompt: CLAUDE_PLANNING_SYSTEM_PROMPT,
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

/** The Agent SDK control surface the model-free login probe uses. */
export type ClaudeLoginQuery = (params: {
  prompt: AsyncIterable<never>;
  options: Options;
}) => { accountInfo(): Promise<AccountInfo>; close(): void };

export interface ClaudeLoginReadiness {
  status: "present" | "missing";
  /** Which login the SDK resolved; never the account identity. */
  source?: string;
  detail?: string;
}

const LOGIN_PROBE_TIMEOUT_MS = 30_000;

/**
 * Model-free check that the Agent SDK resolves a Claude login with the same
 * scrubbed environment planning uses. It asks the runtime for account info
 * and never sends a prompt; `environment` adds service-bound credentials.
 */
export async function probeClaudeLogin(
  environment: Record<string, string> = {},
  query?: ClaudeLoginQuery,
): Promise<ClaudeLoginReadiness> {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-login-"));
  const guard = new ProviderTurnGuard(LOGIN_PROBE_TIMEOUT_MS);
  let session: ReturnType<ClaudeLoginQuery> | undefined;
  let release: () => void = () => undefined;
  const idle = new Promise<void>((resolve) => (release = resolve));
  try {
    const credentialDirectory = join(root, "empty-gh-config");
    mkdirSync(credentialDirectory, { mode: 0o700 });
    const start =
      query ??
      ((await guard.race(loadClaudeQuery())) as unknown as ClaudeLoginQuery);
    session = start({
      // Streaming input keeps the session open for control requests and
      // ends, without a message, when the probe finishes.
      prompt: {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            idle.then(() => ({ done: true as const, value: undefined })),
        }),
      },
      options: {
        cwd: root,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        env: {
          ...claudeWorkerEnvironment(credentialDirectory),
          ...environment,
        },
      },
    });
    const account = await guard.race(session.accountInfo());
    const source = [account.apiKeySource, account.tokenSource].find(
      (value) => value && value !== "none",
    );
    if (source) return { status: "present", source };
    if (account.subscriptionType || account.email)
      return { status: "present", source: "claude-login" };
    return {
      status: "missing",
      detail:
        "No Claude login found; run `claude auth login` on this host, or provide CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
    };
  } catch (error) {
    return {
      status: "missing",
      detail: `Claude login could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    release();
    session?.close();
    guard.finish();
    rmSync(root, { recursive: true, force: true });
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

/** The runtime's stand-in for a model message it produced itself. */
const SYNTHETIC_MODEL = "<synthetic>";

function apiErrorStatus(result: SDKResultMessage): number | undefined {
  return result.subtype === "success" &&
    typeof result.api_error_status === "number"
    ? result.api_error_status
    : undefined;
}

function failureClass(
  result: SDKResultMessage,
  assistantError: SDKAssistantMessageError | undefined,
): string | undefined {
  const status = apiErrorStatus(result);
  if (status === 529 || assistantError === "overloaded")
    return "provider-capacity";
  if (status === 429 || assistantError === "rate_limit")
    return "provider-rate-limit";
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

interface SessionFacts {
  initialized: boolean;
  /** A real model message arrived, not only a runtime-synthesized one. */
  modelResponded: boolean;
  assistantError?: SDKAssistantMessageError;
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
        ...serviceLoginSecrets(),
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
    const usage = new ClaudeUsage(this.secrets);
    const facts: SessionFacts = { initialized: false, modelResponded: false };
    let root: string | undefined;
    let events: AsyncIterator<SDKMessage> | undefined;
    let closeStarted = false;
    let result: SDKResultMessage | undefined;
    try {
      // An empty private directory: the session has nothing to read or load.
      root = mkdtempSync(join(tmpdir(), "factory-claude-planning-"));
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
        if (message.type === "assistant") {
          if (message.error) facts.assistantError = message.error;
          if (message.message.model !== SYNTHETIC_MODEL)
            facts.modelResponded = true;
        }
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
          facts.initialized = true;
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
      if (root) rmSync(root, { recursive: true, force: true });
    }
    requireCompletedProviderTurn(result !== undefined);
    this.settle(result!, { state, invocation, usage, started, facts });
  }

  /** Record terminal usage and outcome, then accept only structured output. */
  private settle(
    result: SDKResultMessage,
    context: {
      state: PlanningTurn;
      invocation: ModelInvocationContext;
      usage: ClaudeUsage;
      started: number;
      facts: SessionFacts;
    },
  ): void {
    const { state, invocation, facts } = context;
    const succeeded = result.subtype === "success" && !result.is_error;
    const status = apiErrorStatus(result);
    const detail = redact(
      result.subtype === "success" ? result.result : result.errors.join("; "),
      this.secrets,
    );
    const authentication =
      !succeeded &&
      (status === 401 ||
        (facts.assistantError !== undefined &&
          authenticationErrors.has(facts.assistantError)) ||
        authenticationFailure("claude", detail) !== undefined);
    // Only a model message or an API error status is a provider verdict. The
    // runtime also reports startup, login and connection failures as results.
    state.ended =
      !authentication &&
      result.subtype !== "error_during_execution" &&
      (status !== undefined || facts.modelResponded);
    const totals = context.usage.totals();
    state.usage = Object.keys(totals).length ? totals : undefined;
    const models = Object.keys(result.modelUsage ?? {});
    const cost = claudeCost(result.total_cost_usd);
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
    let failure: string | undefined;
    if (result.stop_reason === "refusal") {
      state.failureClass = "provider-refusal";
      failure = "Claude response ended with stop_reason refusal";
    } else if (authentication) {
      state.failureClass = "provider-authentication";
      failure = `Claude planning is not authenticated (${detail || result.subtype}); run \`claude auth login\` on the controller host, or provide CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, then retry`;
    } else if (!succeeded) {
      state.failureClass = failureClass(result, facts.assistantError);
      failure = `Claude planning ended with ${result.subtype}${result.stop_reason ? ` (stop_reason ${result.stop_reason})` : ""}: ${detail || "no detail"}`;
    } else if (!facts.initialized)
      failure = "Claude SDK did not report its initialized session";
    else if (result.structured_output === undefined) {
      state.failureClass = "provider-incomplete";
      failure = "Claude result carried no structured output";
    }
    observeModelInvocation(invocation, {
      type: "progress",
      capture: {
        event: {
          kind: "outcome",
          outcome: {
            stage: "provider",
            status: failure === undefined ? "completed" : "failed",
            ...(failure !== undefined &&
              state.failureClass && { failureClass: state.failureClass }),
            ...(result.stop_reason && { stopReason: result.stop_reason }),
          },
          durationMs: Date.now() - context.started,
        },
      },
    });
    if (authentication)
      throw new AuthenticationRequiredError(failure!, {
        provider: "claude",
        command: "claude auth login",
      });
    if (failure !== undefined) throw new Error(failure);
    if (result.subtype === "success")
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
