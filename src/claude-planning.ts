import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AccountInfo,
  Options,
  SDKAssistantMessageError,
  SDKMessage,
  SDKRateLimitInfo,
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
  type AgentSessionContinuation,
  type AgentSessionRef,
  type AgentSessionReconciliation,
  type ModelInvocationContext,
} from "./contracts.js";
import {
  claudeAuthenticationValues,
  claudeWorkerEnvironment,
} from "./execution/claude.js";
import {
  ClaudeUsage,
  claudeModelUsage,
  claudeRawTokenUsage,
} from "./execution/claude-usage.js";
import {
  claudeDigest,
  claudeHistoryDigest,
  claudeOwnedSpawn,
  claudePrivateWrite,
  readClaudePrivate,
  claudeProcessDisposition,
  claudeResumeOptions,
  claudeSessionEnvironment,
  prepareClaudeSession,
  releaseClaudeStorage,
  requireClaudeSession,
  settleClaudeProcess,
  type ClaudeNativeProcess,
  type ClaudeOwnedSession,
} from "./execution/claude-session.js";
import { authenticationFailure, redact } from "./execution/harness-support.js";
import { claudeCaptureEvents } from "./execution/interaction-capture.js";
import { type Fault, transient } from "./fault.js";
import { serviceLoginSecrets } from "./provider-credentials.js";
import {
  closeProviderEventStream,
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  modelResponseTimeoutMs,
  ProviderTurnGuard,
  requireCompletedProviderTurn,
} from "./provider-turn.js";

export const CLAUDE_PLANNING_PROVIDER = "anthropic-claude-agent-sdk";
export const CLAUDE_PLANNING_ADAPTER = CLAUDE_AGENT_SDK_ADAPTER_IDENTITY;

/** The Agent SDK's internal tool that carries `outputFormat` results. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/** One answer plus the SDK's bounded schema-repair turns. */
const CLAUDE_PLANNING_MAX_TURNS = 4;
/** A result review also spends turns reading the tree. */
const CLAUDE_TREE_REVIEW_MAX_TURNS = 40;
/** Read-only tools a result review gets over the exact candidate tree. */
const TREE_REVIEW_TOOLS = ["Read", "Grep", "Glob"];

/** Stable system context shared by every Claude planning call. */
export const CLAUDE_PLANNING_SYSTEM_PROMPT = [
  "You are the planning and review model for Clockgrove Factory.",
  "The user message is the complete request; you have no tools, files or network.",
  "Return exactly the requested result through the structured output.",
].join(" ");

/** The system prompt when the session may read the exact result tree. */
export const CLAUDE_TREE_REVIEW_SYSTEM_PROMPT = [
  "You are the planning and review model for Clockgrove Factory.",
  "The user message is the complete request; you have no network.",
  "Your working directory holds the exact tree under review, and your tools can only read it.",
  "Return exactly the requested result through the structured output.",
].join(" ");

export type ClaudePlanningConfig = Extract<
  PlanningConfig,
  { kind: "claude-agent-sdk" }
>;

/** The narrow Agent SDK call surface the transport uses. */
export type ClaudePlanningQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

export interface ClaudePlanningModelOptions extends PlanningModelOptions {
  /** Installation-owned private conversation storage; absent means fresh calls. */
  sessionRoot?: string;
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
  /** `cwd` is the exact tree under review: allow read-only tools over it. */
  tree?: boolean;
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
    // A tree review keeps only read-only file tools, allowed inside cwd alone
    // (a symlink out of the tree is denied too).
    tools: input.tree ? TREE_REVIEW_TOOLS : [],
    allowedTools: input.tree
      ? TREE_REVIEW_TOOLS.map((tool) => `${tool}(./**)`)
      : [],
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
    systemPrompt: input.tree
      ? CLAUDE_TREE_REVIEW_SYSTEM_PROMPT
      : CLAUDE_PLANNING_SYSTEM_PROMPT,
    // Prompts carry untrusted source text; never expand @paths or commands.
    verbatimPrompts: true,
    maxTurns: input.tree
      ? CLAUDE_TREE_REVIEW_MAX_TURNS
      : CLAUDE_PLANNING_MAX_TURNS,
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
  tree: boolean,
): void {
  if (message.model !== model)
    throw new Error(
      `Claude SDK selected model ${message.model}, expected ${model}`,
    );
  const allowed = new Set([
    STRUCTURED_OUTPUT_TOOL,
    ...(tree ? TREE_REVIEW_TOOLS : []),
  ]);
  const tool = message.tools.find((name) => !allowed.has(name));
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

/**
 * A fault the runtime's structured facts settle: an exhausted balance, or a
 * subscription limit with its reset time (`resetsAt` is epoch seconds).
 */
function structuredFault(
  failure: string,
  status: number | undefined,
  facts: SessionFacts,
): Fault | undefined {
  if (
    facts.assistantError === "billing_error" ||
    facts.limit?.errorCode === "credits_required"
  )
    return {
      kind: "config",
      detail: failure,
      fix: "Restore the Claude plan, credits or billing for the controller login, then `factory run`",
    };
  const resetsAt = facts.limit?.resetsAt;
  if (
    resetsAt !== undefined &&
    Number.isFinite(resetsAt) &&
    (status === 429 || facts.assistantError === "rate_limit")
  )
    return transient(
      `Claude usage limit: ${failure}`,
      false,
      new Date(resetsAt * 1000).toISOString(),
    );
  return undefined;
}

interface SessionFacts {
  initialized: boolean;
  /** A real model message arrived, not only a runtime-synthesized one. */
  modelResponded: boolean;
  assistantError?: SDKAssistantMessageError;
  /** The last subscription limit the runtime reported as rejecting requests. */
  limit?: SDKRateLimitInfo;
}

/** One isolated Agent SDK query per attempt, constrained by JSON schema. */
class ClaudePlanningTransport implements PlanningTransport {
  readonly provider = CLAUDE_PLANNING_PROVIDER;
  readonly adapter = CLAUDE_PLANNING_ADAPTER;
  private readonly secrets: string[];
  get sessionCapabilities() {
    return this.sessionRoot
      ? {
          resumeRoles: [
            "planning",
            "result-review",
            "objective-review",
          ] as const,
        }
      : undefined;
  }

  async releaseSession(ref: AgentSessionRef): Promise<void> {
    if (!this.sessionRoot)
      throw new Error("Claude retained storage is unavailable");
    const session = requireClaudeSession(this.sessionRoot, ref, this.adapter);
    if (session.data.settled !== true && session.data.process)
      await settleClaudeProcess(session.data.process);
    if (ref.status === "in-flight")
      throw new Error(
        "Claude submitted turn requires reconciliation before disposal",
      );
    releaseClaudeStorage(this.sessionRoot, ref, this.adapter);
  }

  async reconcileSession(
    ref: AgentSessionRef,
  ): Promise<AgentSessionReconciliation> {
    if (!this.sessionRoot) return { disposition: "unknown" };
    const session = requireClaudeSession(this.sessionRoot, ref, this.adapter);
    const disposition = claudeProcessDisposition(session.data.process);
    if (disposition !== "settled") return { disposition };
    let completed: {
      session: AgentSessionRef;
      response?: string;
      usage?: PlanningTurn["usage"];
    };
    try {
      completed = readClaudePrivate(join(session.data.root, "completed.json"));
    } catch {
      return { disposition: "unknown" };
    }
    if (
      completed.session.identity !== ref.identity ||
      completed.session.turn !== ref.turn ||
      !isDeepStrictEqual(completed.session.scope, ref.scope) ||
      completed.session.currentTurn?.invocationId !==
        ref.currentTurn?.invocationId ||
      completed.session.currentTurn?.requestDigest !==
        ref.currentTurn?.requestDigest
    )
      return { disposition: "unknown" };
    const native = requireClaudeSession(
      this.sessionRoot,
      completed.session,
      this.adapter,
    );
    const historyDigest = claudeHistoryDigest(native);
    const ready: AgentSessionRef = {
      ...completed.session,
      status: "ready",
      data: { ...native.data, settled: true, historyDigest },
      currentTurn: { ...completed.session.currentTurn!, resources: "settled" },
    };
    return {
      disposition: "settled",
      session: ready,
      ...(completed.response === undefined
        ? {}
        : { response: completed.response }),
      ...(completed.usage === undefined ? {} : { usage: completed.usage }),
    };
  }

  constructor(
    private config: ClaudePlanningConfig,
    private query: ClaudePlanningQuery | undefined,
    private providerTurnIdleTimeoutMs: number | undefined,
    redactionValues: string[],
    private sessionRoot?: string,
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

  settings(role: PlanningRole, tree?: string): Record<string, unknown> {
    return {
      ...this.selection(role),
      maxOutputTokens: this.config.maxOutputTokens,
      maxTurns: tree ? CLAUDE_TREE_REVIEW_MAX_TURNS : CLAUDE_PLANNING_MAX_TURNS,
      thinking: "adaptive",
      tools: tree ? TREE_REVIEW_TOOLS : "none",
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
    tree?: string;
    session?: AgentSessionContinuation & { currentGraphDigest?: string };
    sourcePacket?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { invocation, turn: state } = args;
    const selection = this.selection(args.role);
    const { model, reasoningEffort } = selection;
    const started = Date.now();
    const continuation = this.sessionRoot ? args.session : undefined;
    let owned: ClaudeOwnedSession | undefined;
    if (continuation) {
      if (
        this.query ||
        (args.role === "planner"
          ? continuation.scope.role !== "planning"
          : !["result-review", "objective-review"].includes(
              continuation.scope.role,
            ))
      )
        throw new Error(
          "Claude continuation has a different native transport or role",
        );
      owned = prepareClaudeSession(
        this.sessionRoot!,
        continuation,
        this.adapter,
        claudeDigest([selection, this.config, Boolean(args.tree)]),
      );
      owned.ref.currentTurn = {
        invocationId: invocation.invocationId,
        requestDigest: claudeDigest([args.prompt, args.schema]),
        schemaDigest: claudeDigest(args.schema),
        dispatch: "intent",
        resources: "unknown",
        ...(args.sourcePacket && {
          evidenceDigest: createHash("sha256")
            .update(args.sourcePacket)
            .digest("hex"),
        }),
        ...((continuation.scope.role === "planning"
          ? continuation.currentGraphDigest
          : continuation.scope.graphDigest) && {
          graphDigest:
            continuation.scope.role === "planning"
              ? continuation.currentGraphDigest
              : continuation.scope.graphDigest,
        }),
      };
      continuation.checkpoint(owned.ref);
      claudePrivateWrite(join(owned.data.root, "pending.json"), owned.ref);
    }
    const guard = new ProviderTurnGuard(
      this.providerTurnIdleTimeoutMs ?? modelResponseTimeoutMs(reasoningEffort),
      this.providerTurnIdleTimeoutMs ?? DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
    );
    const abortController = new AbortController();
    guard.signal.addEventListener(
      "abort",
      () => abortController.abort(guard.signal.reason),
      { once: true },
    );
    const cancel = () => abortController.abort(args.signal?.reason);
    if (args.signal?.aborted) cancel();
    else args.signal?.addEventListener("abort", cancel, { once: true });
    const usage = new ClaudeUsage(
      this.secrets,
      owned?.data.baseline,
      owned?.resume,
    );
    const facts: SessionFacts = { initialized: false, modelResponded: false };
    let root: string | undefined;
    let events: AsyncIterator<SDKMessage> | undefined;
    let closeStarted = false;
    let result: SDKResultMessage | undefined;
    let nativeProcess: ClaudeNativeProcess | undefined;
    let nativeSpawnAttempted = false;
    let streamClosed = false;
    const checkpoint = (status: AgentSessionRef["status"]) => {
      if (!owned || !continuation) return;
      owned.ref = { ...owned.ref, status, data: { ...owned.data } };
      continuation.checkpoint(owned.ref);
    };
    try {
      root = mkdtempSync(join(tmpdir(), "factory-claude-planning-"));
      const query = this.query ?? (await guard.race(loadClaudeQuery()));
      // A tree review reads the exact tree; any other session gets an empty
      // private directory, with nothing to read or load.
      const cwd = args.tree ?? join(root, "cwd");
      const credentialDirectory = join(root, "empty-gh-config");
      if (!args.tree) mkdirSync(cwd, { mode: 0o700 });
      mkdirSync(credentialDirectory, { mode: 0o700 });
      const options = claudePlanningOptions({
        config: this.config,
        selection,
        schema: args.schema,
        cwd,
        credentialDirectory,
        abortController,
        tree: Boolean(args.tree),
      });
      if (!this.query) {
        const spawnNative = claudeOwnedSpawn((owner) => {
          nativeProcess = owner;
          if (owned) {
            owned.data.process = owner;
            owned.ref.currentTurn = {
              ...owned.ref.currentTurn!,
              dispatch: "submitted",
              resources: "active",
            };
            checkpoint("in-flight");
            claudePrivateWrite(
              join(owned.data.root, "pending.json"),
              owned.ref,
            );
          }
        });
        options.spawnClaudeCodeProcess = (options) => {
          nativeSpawnAttempted = true;
          return spawnNative(options);
        };
      }
      if (owned) {
        Object.assign(options, claudeResumeOptions(owned));
        options.env = claudeSessionEnvironment(owned, options.env ?? {});
      }
      events = query({ prompt: args.prompt, options })[Symbol.asyncIterator]();
      for (;;) {
        const next = await guard.race(events.next());
        if (next.done) break;
        const message = next.value;
        guard.progress(message.type);
        if (message.type === "assistant" || message.type === "user") {
          const content = message.message.content;
          if (Array.isArray(content))
            for (const block of content) {
              if (
                block.type === "tool_use" &&
                TREE_REVIEW_TOOLS.includes(block.name)
              )
                guard.progress(`${message.type}:tool_use:${block.name}`, {
                  id: block.id,
                  active: true,
                });
              else if (block.type === "tool_result")
                guard.progress(`${message.type}:tool_result`, {
                  id: block.tool_use_id,
                  active: false,
                });
            }
        }
        if ("session_id" in message && typeof message.session_id === "string")
          state.providerThreadId ??= message.session_id;
        if (
          message.type === "rate_limit_event" &&
          message.rate_limit_info.status === "rejected"
        )
          facts.limit = message.rate_limit_info;
        if (message.type === "assistant") {
          if (message.error) facts.assistantError = message.error;
          if (message.message.model !== SYNTHETIC_MODEL) {
            facts.modelResponded = true;
            state.started = true;
          }
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
          assertPlanningInitialization(message, model, Boolean(args.tree));
          if (owned && message.session_id !== owned.data.nativeSessionId)
            throw new Error(
              "Claude planning initialized a different native conversation",
            );
          facts.initialized = true;
        }
        if (message.type === "result") {
          result = message;
          break;
        }
      }
      closeStarted = true;
      await closeProviderEventStream(events, guard, true);
      streamClosed = true;
      requireCompletedProviderTurn(result !== undefined);
      if (owned && result!.session_id !== owned.data.nativeSessionId)
        throw new Error(
          "Claude planning result belongs to another native conversation",
        );
      this.settle(result!, { state, invocation, usage, started, facts });
    } catch (error) {
      if (events && !closeStarted && !guard.signal.aborted) {
        closeStarted = true;
        try {
          await closeProviderEventStream(events, guard, true);
          streamClosed = true;
        } catch {
          // Preserve the provider failure that required cleanup.
        }
      }
      throw error;
    } finally {
      args.signal?.removeEventListener("abort", cancel);
      if (events && !closeStarted)
        void closeProviderEventStream(events, guard, false);
      guard.finish();
      const completed = Boolean(
        streamClosed &&
          facts.initialized &&
          result &&
          result.subtype !== "error_during_execution" &&
          (!owned || result.session_id === owned.data.nativeSessionId),
      );
      if (owned && completed) {
        owned.data.nativeTerminal = true;
        owned.data.baseline = usage.boundary();
        owned.ref.currentTurn = {
          ...owned.ref.currentTurn!,
          terminal: state.ended && !state.failureClass ? "completed" : "failed",
          resources: "unknown",
        };
        claudePrivateWrite(join(owned.data.root, "completed.json"), {
          session: { ...owned.ref, data: { ...owned.data } },
          ...(state.response ? { response: state.response } : {}),
          ...(state.usage && { usage: state.usage }),
        });
      }
      if (nativeProcess) {
        await settleClaudeProcess(nativeProcess);
        state.stopped = true;
      } else if (!nativeSpawnAttempted && !this.query) {
        // Validation/import failed before the pinned SDK's sole process launch surface.
        state.stopped = true;
      }
      if (owned) {
        if (completed) {
          owned.data.nativeTerminal = true;
          owned.data.settled = true;
          owned.data.baseline = usage.boundary();
          owned.data.historyDigest = claudeHistoryDigest(owned);
          owned.ref.currentTurn = {
            ...owned.ref.currentTurn!,
            terminal:
              state.ended && !state.failureClass ? "completed" : "failed",
            resources: "settled",
          };
          checkpoint("ready");
          claudePrivateWrite(join(owned.data.root, "completed.json"), {
            session: owned.ref,
            ...(state.response ? { response: state.response } : {}),
            ...(state.usage && { usage: state.usage }),
          });
        } else if (state.stopped) {
          owned.data.settled = true;
          owned.ref.currentTurn = {
            ...owned.ref.currentTurn!,
            ...(owned.ref.currentTurn?.dispatch === "submitted"
              ? { terminal: "interrupted" as const }
              : {}),
            resources: "settled",
          };
          checkpoint("unavailable");
        }
      }
      if (root) rmSync(root, { recursive: true, force: true });
    }
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
    const cost = context.usage.cost();
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
            rawScope: "thread-cumulative",
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
    if (failure !== undefined)
      state.fault = structuredFault(failure, status, facts);
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
        options.providerTurnIdleTimeoutMs,
        options.redactionValues ?? [],
        options.sessionRoot,
      ),
      options,
    );
  }
}
