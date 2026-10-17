import { admitNativeReturn } from "./compiler/native-return.js";
import type { ReviewImageInput } from "./contracts.js";
import { unsupportedReviewImages } from "./compiler/transport.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { assertAgentSessionRef } from "./agent-session.js";
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
  claudeAuthenticationFailure,
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
import { redact } from "./execution/harness-support.js";
import { claudeCaptureEvents } from "./execution/interaction-capture.js";
import {
  awaitCheckpointAdmission,
  isCheckpointAdmissionFailure,
  markCheckpointEffectDispatched,
} from "./recovery-checkpoint.js";
import { assertDurableValue } from "./execution/checkpoint.js";
import { type Fault, transient } from "./fault.js";
import { serviceLoginSecrets } from "./provider-credentials.js";
import {
  assertProviderTurnDeadline,
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

/** An array the shared schema fixes to exactly this many entries. */
function exactLength(schema: Record<string, unknown>): number | undefined {
  const length = schema.maxItems;
  return schema.type === "array" &&
    typeof length === "number" &&
    Number.isSafeInteger(length) &&
    length > 0 &&
    schema.minItems === length
    ? length
    : undefined;
}

const indexKeys = (length: number) =>
  Array.from({ length }, (_, index) => String(index));

/**
 * The shared planning schema in the Claude structured-output subset.
 * Unsupported constraints move into `description`, as the SDK's own
 * transform does, but `enum` and `const` discriminators stay enforced.
 * The grammar enforces no array length above one, so an exact-length array
 * becomes an object with one required key per index; claudeOutputValue
 * turns it back into the canonical array before any Factory decoder sees it.
 */
export function claudeOutputSchema(schema: unknown): unknown {
  const indexed: Record<string, unknown> = {};
  const result = claudeSchemaNode(schema, indexed);
  if (isRecord(result) && Object.keys(indexed).length)
    result.$defs = {
      ...(isRecord(result.$defs) ? result.$defs : {}),
      ...indexed,
    };
  return result;
}

function claudeSchemaNode(
  schema: unknown,
  indexed: Record<string, unknown>,
): unknown {
  if (!isRecord(schema)) return schema;
  const length = exactLength(schema);
  if (length !== undefined) {
    // One definition per array keeps the grammar the size of the original.
    const name = `factoryIndexedEntry${Object.keys(indexed).length}`;
    indexed[name] = {};
    indexed[name] = claudeSchemaNode(schema.items, indexed);
    const keys = indexKeys(length);
    return {
      type: "object",
      description: [
        schema.description,
        `Exactly ${length} entries keyed "0" to "${length - 1}"; each key is that array position.`,
      ]
        .filter((part) => typeof part === "string" && part)
        .join("\n\n"),
      properties: Object.fromEntries(
        keys.map((key) => [key, { $ref: `#/$defs/${name}` }]),
      ),
      required: keys,
      additionalProperties: false,
    };
  }
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
          claudeSchemaNode(entry, indexed),
        ]),
      );
    else if (SCHEMA_LISTS.has(key) && Array.isArray(value))
      result[key] = value.map((entry) => claudeSchemaNode(entry, indexed));
    else if (key === "items") result[key] = claudeSchemaNode(value, indexed);
    else result[key] = value;
  }
  if (moved.length)
    result.description = [result.description, `{${moved.join(", ")}}`]
      .filter((part) => typeof part === "string" && part)
      .join("\n\n");
  return result;
}

function hasExactLength(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (exactLength(schema) !== undefined) return true;
  return Object.entries(schema).some(([key, value]) =>
    SCHEMA_MAPS.has(key) && isRecord(value)
      ? Object.values(value).some(hasExactLength)
      : SCHEMA_LISTS.has(key) && Array.isArray(value)
        ? value.some(hasExactLength)
        : key === "items" && hasExactLength(value),
  );
}

/** A union branch whose single-value discriminators admit this object. */
function admits(schema: unknown, value: Record<string, unknown>): boolean {
  if (!isRecord(schema) || !isRecord(schema.properties)) return false;
  return Object.entries(schema.properties).every(
    ([key, property]) =>
      !isRecord(property) ||
      !Array.isArray(property.enum) ||
      property.enum.includes(value[key]),
  );
}

/**
 * Undo claudeOutputSchema's index-keyed objects against the shared schema.
 * Only an object with exactly the encoded keys becomes an array; anything
 * else stays as returned, so the canonical decoder still rejects it.
 */
export function claudeOutputValue(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema) || !hasExactLength(schema)) return value;
  const length = exactLength(schema);
  if (length !== undefined) {
    const keys = indexKeys(length);
    if (
      !isRecord(value) ||
      Object.keys(value).length !== length ||
      keys.some((key) => !Object.hasOwn(value, key))
    )
      return value;
    return keys.map((key) => claudeOutputValue(schema.items, value[key]));
  }
  if (Array.isArray(value))
    return value.map((entry) => claudeOutputValue(schema.items, entry));
  if (!isRecord(value)) return value;
  let result = value;
  if (isRecord(schema.properties)) {
    const properties = schema.properties;
    result = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        Object.hasOwn(properties, key)
          ? claudeOutputValue(properties[key], entry)
          : entry,
      ]),
    );
  }
  for (const list of SCHEMA_LISTS) {
    const branches = schema[list];
    if (!Array.isArray(branches)) continue;
    const branch = branches.find(
      (entry) => hasExactLength(entry) && admits(entry, result),
    );
    if (branch) result = claudeOutputValue(branch, result) as typeof result;
  }
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
  selection: ClaudeModelSelection,
  cwd: string,
  tree: boolean,
): void {
  if (resolve(message.cwd) !== resolve(cwd))
    throw new Error(
      "Claude SDK initialized outside the supplied planning tree",
    );
  if (message.model !== selection.model)
    throw new Error(
      `Claude SDK selected model ${message.model}, expected ${selection.model}`,
    );
  if (message.permissionMode !== "dontAsk")
    throw new Error(
      `Claude SDK selected permission mode ${message.permissionMode}, expected dontAsk`,
    );
  // The pinned SDK may omit effort; only a reported value can authenticate it.
  if (
    message.effort !== undefined &&
    message.effort !== selection.reasoningEffort
  )
    throw new Error(
      `Claude SDK selected reasoning effort ${String(message.effort)}, expected ${selection.reasoningEffort}`,
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

/** Base of the complete request the retained conversation already holds. */
type RequestBaseData = ClaudeOwnedSession["data"] & { requestBase?: string };

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
    assertAgentSessionRef(ref);
    const supplied = ref.data as { root?: string } | undefined;
    if (
      ref.adapter !== this.adapter ||
      supplied?.root !== join(resolve(this.sessionRoot), ref.identity)
    )
      throw new Error(
        "Claude disposal differs from its private adapter binding",
      );
    // A crash after confirmed removal but before the controller checkpoint is safe to repeat.
    if (!existsSync(supplied.root)) return;
    if (ref.status === "in-flight")
      throw new Error(
        "Claude submitted turn requires reconciliation before disposal",
      );
    const session = requireClaudeSession(this.sessionRoot, ref, this.adapter);
    if (session.data.settled !== true && session.data.process)
      await settleClaudeProcess(session.data.process);
    await awaitCheckpointAdmission(ref.scope.repository, "explicit");
    releaseClaudeStorage(this.sessionRoot, ref, this.adapter);
  }

  async reconcileSession(
    ref: AgentSessionRef,
  ): Promise<AgentSessionReconciliation> {
    if (!this.sessionRoot) return { disposition: "unknown" };
    if (!existsSync(join(resolve(this.sessionRoot), ref.identity)))
      return { disposition: "unknown" };
    const session = requireClaudeSession(this.sessionRoot, ref, this.adapter);
    const disposition = claudeProcessDisposition(session.data.process);
    if (disposition !== "settled") return { disposition };
    let completed: {
      session: AgentSessionRef;
      response?: string;
      nativeReturn?: Parameters<
        NonNullable<ModelInvocationContext["retainNativeReturn"]>
      >[0];
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
        ref.currentTurn?.requestDigest ||
      completed.session.currentTurn?.deadlineAt !== ref.currentTurn?.deadlineAt
    )
      return { disposition: "unknown" };
    const native = requireClaudeSession(
      this.sessionRoot,
      completed.session,
      this.adapter,
    );
    if (completed.nativeReturn) {
      assertDurableValue(completed.nativeReturn, "Claude native return");
      if (
        completed.nativeReturn.representation !== "literal-agent-text" ||
        typeof completed.nativeReturn.response !== "string" ||
        completed.nativeReturn.providerSessionId !==
          native.data.nativeSessionId ||
        completed.nativeReturn.terminal !==
          completed.session.currentTurn?.terminal
      )
        throw new Error(
          "Claude retained native return differs from its terminal session",
        );
    }
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
      ...(completed.nativeReturn && { nativeReturn: completed.nativeReturn }),
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

  /** No native effect separates the local session intent from the SDK launch. */
  logicalDispatchAdmission(): "native-before-effect-v1" {
    return "native-before-effect-v1";
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
    reviewImages?: ReviewImageInput[];
    session?: AgentSessionContinuation & { currentGraphDigest?: string };
    continuation?: { base: string; prompt: string };
    sourcePacket?: string;
    beforeNativeDispatch?: NonNullable<
      ModelInvocationContext["beforeProviderDispatch"]
    >;
    signal?: AbortSignal;
    deadlineAt?: string;
  }): Promise<void> {
    if (args.reviewImages?.length) throw unsupportedReviewImages(this.adapter);
    const { invocation, turn: state } = args;
    const selection = this.selection(args.role);
    const { model, reasoningEffort } = selection;
    const started = Date.now();
    // A diagnosis carries its own complete request. Resuming the planner
    // conversation would resend that whole history under another output
    // schema, which shares no cache prefix, so it runs as a fresh session.
    const continuation =
      this.sessionRoot && invocation.phase !== "diagnosis"
        ? args.session
        : undefined;
    let owned: ClaudeOwnedSession | undefined;
    let nativePrompt = args.prompt;
    let compacted = false;
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
      // The conversation holds an earlier complete request with this base:
      // send only what changed. Forget the base until this turn completes.
      const data = owned.data as RequestBaseData;
      if (
        owned.resume &&
        args.continuation &&
        data.requestBase === args.continuation.base
      )
        nativePrompt = args.continuation.prompt;
      delete data.requestBase;
      owned.ref.currentTurn = {
        invocationId: invocation.invocationId,
        ...(args.deadlineAt ? { deadlineAt: args.deadlineAt } : {}),
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
      args.deadlineAt,
    );
    const abortController = new AbortController();
    const expire = () => abortController.abort(guard.signal.reason);
    if (guard.signal.aborted) expire();
    else guard.signal.addEventListener("abort", expire, { once: true });
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
    let checkpointRejected = false;
    let initialized: Promise<void> | undefined;
    const checkpoint = (status: AgentSessionRef["status"]) => {
      if (!owned || !continuation) return;
      owned.ref = { ...owned.ref, status, data: { ...owned.data } };
      continuation.checkpoint(owned.ref);
    };
    try {
      assertProviderTurnDeadline(args.deadlineAt);
      abortController.signal.throwIfAborted();
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
          assertProviderTurnDeadline(args.deadlineAt);
          abortController.signal.throwIfAborted();
          nativeSpawnAttempted = true;
          return spawnNative(options);
        };
      }
      if (owned) {
        Object.assign(options, claudeResumeOptions(owned));
        options.env = claudeSessionEnvironment(owned, options.env ?? {});
      }
      // A delta relies on the complete request earlier in the conversation;
      // a compaction summary could drop it. Only full requests may compact.
      if (nativePrompt !== args.prompt) {
        options.settings = {
          ...(options.settings as Record<string, unknown>),
          autoCompactEnabled: false,
        };
        options.env = { ...options.env, DISABLE_AUTO_COMPACT: "1" };
      }
      assertProviderTurnDeadline(args.deadlineAt);
      abortController.signal.throwIfAborted();
      // The controller callback admits the charged attempt, logical submission
      // and this native session intent in one pre-effect checkpoint.
      const admission = await args.beforeNativeDispatch?.();
      if (admission !== "admission-complete")
        await awaitCheckpointAdmission(
          continuation?.scope.repository,
          "before-effect",
        );
      events = query({ prompt: nativePrompt, options })[Symbol.asyncIterator]();
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
        if (message.type === "system" && message.subtype === "compact_boundary")
          compacted = true;
        if (message.type === "system" && message.subtype === "init") {
          assertPlanningInitialization(
            message,
            selection,
            cwd,
            Boolean(args.tree),
          );
          if (owned && message.session_id !== owned.data.nativeSessionId)
            throw new Error(
              "Claude planning initialized a different native conversation",
            );
          facts.initialized = true;
          checkpoint("in-flight");
          // Coalesced durability for the running session; it guards no effect,
          // so the stream keeps draining and its outcome is awaited at the end.
          initialized = awaitCheckpointAdmission(
            continuation?.scope.repository,
            "settled",
          );
          initialized.catch(() => {
            /* Rethrown when awaited after the stream closes. */
          });
        }
        if (message.type === "result") {
          result = message;
          break;
        }
      }
      closeStarted = true;
      await closeProviderEventStream(events, guard, true);
      streamClosed = true;
      await initialized;
      requireCompletedProviderTurn(result !== undefined);
      if (owned && result!.session_id !== owned.data.nativeSessionId)
        throw new Error(
          "Claude planning result belongs to another native conversation",
        );
      if (compacted && nativePrompt !== args.prompt) {
        // Never accept an answer planned from a summary of the request.
        const detail =
          "Claude compacted a delta turn despite disabled auto-compact; its answer is not accepted";
        state.ended = true;
        state.fault = { kind: "defect", detail };
        throw new Error(detail);
      }
      this.settle(result!, {
        state,
        invocation,
        usage,
        started,
        facts,
        schema: args.schema,
      });
    } catch (error) {
      checkpointRejected = isCheckpointAdmissionFailure(error);
      if (isCheckpointAdmissionFailure(error) && nativeSpawnAttempted)
        markCheckpointEffectDispatched(error);
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
      guard.signal.removeEventListener("abort", expire);
      if (events && !closeStarted)
        void closeProviderEventStream(events, guard, false);
      guard.finish();
      const nativeTerminal = Boolean(
        facts.initialized &&
          result &&
          result.subtype !== "error_during_execution" &&
          (!owned || result.session_id === owned.data.nativeSessionId),
      );
      const completed = streamClosed && nativeTerminal;
      const terminal =
        result?.subtype === "success" && !result.is_error
          ? ("completed" as const)
          : ("failed" as const);
      if (nativeTerminal) {
        const totals = usage.totals();
        state.usage = Object.keys(totals).length ? totals : undefined;
      }
      let nativeReturn:
        | Parameters<
            NonNullable<ModelInvocationContext["retainNativeReturn"]>
          >[0]
        | undefined;
      if (nativeTerminal && result?.subtype === "success") {
        nativeReturn = {
          representation: "literal-agent-text",
          response: result.result,
          providerSessionId: result.session_id,
          terminal,
          ...(state.usage && { usage: state.usage }),
        };
        if (result.structured_output !== undefined) {
          assertDurableValue(
            result.structured_output,
            "Claude SDK structured output",
          );
          nativeReturn.structuredValue =
            result.structured_output as import("./config.js").JsonValue;
        }
      }
      if (owned && nativeTerminal) {
        // A genuine SDK result remains a native fact if later draining fails.
        // Response acceptance and reusable context still require full settlement.
        owned.data.nativeTerminal = true;
        owned.ref.currentTurn = {
          ...owned.ref.currentTurn!,
          terminal,
          resources: "unknown",
        };
        // Retain authenticated native facts even if owned closure throws; this
        // private record is not a ready-session or accepted-response receipt.
        claudePrivateWrite(join(owned.data.root, "pending.json"), {
          ...owned.ref,
          data: { ...owned.data },
        });
      }
      if (owned && completed) {
        owned.data.nativeTerminal = true;
        owned.data.baseline = usage.boundary();
        // A summary can drop the complete request a later delta relies on.
        if (args.continuation && terminal === "completed" && !compacted)
          (owned.data as RequestBaseData).requestBase = args.continuation.base;
        owned.ref.currentTurn = {
          ...owned.ref.currentTurn!,
          terminal,
          resources: "unknown",
        };
        claudePrivateWrite(join(owned.data.root, "completed.json"), {
          session: { ...owned.ref, data: { ...owned.data } },
          ...(nativeReturn && { nativeReturn }),
          responseRepresentation: "derived-sdk-structured-json",
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
            terminal,
            resources: "settled",
          };
          checkpoint("ready");
          claudePrivateWrite(join(owned.data.root, "completed.json"), {
            session: owned.ref,
            ...(nativeReturn && { nativeReturn }),
            responseRepresentation: "derived-sdk-structured-json",
            ...(state.response ? { response: state.response } : {}),
            ...(state.usage && { usage: state.usage }),
          });
        } else if (state.stopped) {
          owned.data.settled = true;
          owned.ref.currentTurn = {
            ...owned.ref.currentTurn!,
            resources: "settled",
          };
          // Closing the local owner cannot authenticate native turn completion.
          checkpoint(
            owned.ref.currentTurn.dispatch === "submitted" &&
              !owned.ref.currentTurn.terminal
              ? "in-flight"
              : "unavailable",
          );
        }
      }
      await admitNativeReturn(
        invocation.retainNativeReturn?.bind(invocation),
        nativeReturn,
        continuation?.scope.repository,
        checkpointRejected,
      );
      if (!checkpointRejected) {
        if (root) rmSync(root, { recursive: true, force: true });
      }
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
      schema: unknown;
    },
  ): void {
    const { state, invocation, facts } = context;
    const succeeded = result.subtype === "success" && !result.is_error;
    const status = apiErrorStatus(result);
    const detail = redact(
      result.subtype === "success" ? result.result : result.errors.join("; "),
      this.secrets,
    );
    const authentication = claudeAuthenticationFailure(
      result,
      facts.assistantError,
    );
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
      state.response = JSON.stringify(
        claudeOutputValue(context.schema, result.structured_output),
      );
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
