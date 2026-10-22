import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  Options,
  Query,
  SDKAssistantMessageError,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isRecord } from "../planning/graph.js";
import { workerEnvironment } from "../worktree.js";
import {
  callImages,
  detail,
  IdleWatchdog,
  loggedCall,
  type ModelChoice,
  modelChoice,
  type Planner,
  type PlannerAnswer,
  type PlannerCall,
  PlannerError,
  type PlannerModels,
} from "./planner.js";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudePlannerOptions extends PlannerModels<ClaudeEffort> {
  /** Output token ceiling for every planning and review call. */
  maxOutputTokens?: number;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 64000;

export const DEFAULT_CLAUDE_MODELS: ClaudePlannerOptions = {
  planner: { model: "claude-opus-5-5", effort: "medium" },
  reviewer: { model: "claude-opus-5-5", effort: "medium" },
  reviewEffort: { "graph-review": "high", "result-review": "high" },
};

/**
 * Claude streams partial messages, so silence means a stalled call. Native
 * event surfaces may omit ongoing reasoning; higher effort gets a finite
 * quiet window.
 */
function modelResponseTimeoutMs(reasoningEffort?: string): number {
  return (
    (["high", "xhigh", "max", "ultra", "persistent"].includes(
      reasoningEffort ?? "",
    )
      ? 5
      : 2) *
    60 *
    1_000
  );
}
/** The quiet bound while a read tool runs. */
export const ACTIVE_TOOL_IDLE_MS = 45 * 60 * 1_000;
/** How long a rate or usage limit with no reset time waits before a retry. */
const LIMIT_WAIT_MS = 15 * 60 * 1_000;

/** The Agent SDK's internal tool that carries `outputFormat` results. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/** One answer plus the SDK's bounded schema-repair turns. */
const CLAUDE_PLANNING_MAX_TURNS = 4;
/**
 * Planning and reviews also spend turns reading a tree. A result review of a
 * Work Item with about 120 criteria used all of 40 turns (about 7 s each) and
 * answered after 4 more; 100 leaves room for that.
 */
const CLAUDE_TREE_REVIEW_MAX_TURNS = 100;
/** Read-only tools a session gets over its exact tree. */
const TREE_REVIEW_TOOLS = ["Read", "Grep", "Glob"];

/** Stable system context shared by every Claude planning call. */
const CLAUDE_PLANNING_SYSTEM_PROMPT = [
  "You are the planning and review model for Clockgrove Factory.",
  "The user message is the complete request; you have no tools, files or network.",
  "Return exactly the requested result through the structured output.",
].join(" ");

/** The system prompt when the session may read an exact tree. */
const CLAUDE_TREE_REVIEW_SYSTEM_PROMPT = [
  "You are the planning and review model for Clockgrove Factory.",
  "The user message is the complete request; you have no network.",
  "Your working directory holds the exact files the request names, and your tools can only read them.",
  "Return exactly the requested result through the structured output.",
].join(" ");

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
 * The SDK validates the answer against this schema and returns its errors
 * to the model, so a discriminated `anyOf` becomes if/then on its
 * discriminator: errors then name only the branch the entry chose.
 * The grammar enforces no array length above one, so an exact-length array
 * becomes an object with one required key per index; claudeOutputValue
 * turns it back into the canonical array before any Factory decoder sees it.
 */
function claudeOutputSchema(schema: unknown): unknown {
  const indexed: Record<string, unknown> = {};
  const result = claudeSchemaNode(schema, indexed);
  if (isRecord(result) && Object.keys(indexed).length)
    result.$defs = {
      ...(isRecord(result.$defs) ? result.$defs : {}),
      ...indexed,
    };
  return result;
}

/** A single-value `enum` or `const` property value, when the branch fixes one. */
function fixedValue(branch: unknown, property: string): unknown[] | undefined {
  if (!isRecord(branch) || !isRecord(branch.properties)) return undefined;
  const value = branch.properties[property];
  if (!isRecord(value)) return undefined;
  if (Object.hasOwn(value, "const")) return [value.const];
  return Array.isArray(value.enum) && value.enum.length === 1
    ? [value.enum[0]]
    : undefined;
}

/** The property every object branch fixes to one value, not all the same one. */
function discriminator(branches: unknown[]): string | undefined {
  if (branches.length < 2 || !branches.every(isRecord)) return undefined;
  const first = branches[0] as Record<string, unknown>;
  const candidates = Object.keys(
    isRecord(first.properties) ? first.properties : {},
  ).sort((a, b) => Number(b === "kind") - Number(a === "kind"));
  return candidates.find((property) => {
    const values = branches.map((branch) => fixedValue(branch, property));
    return (
      values.every((value) => value !== undefined) &&
      new Set(values.map((value) => JSON.stringify(value![0]))).size > 1
    );
  });
}

/**
 * An `anyOf` of object branches told apart by one fixed property becomes
 * if/then on that property, so a malformed entry is reported against the
 * branch its own discriminator selects instead of against every branch.
 */
function discriminatedUnion(
  schema: Record<string, unknown>,
  indexed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const branches = schema.anyOf;
  if (!Array.isArray(branches)) return undefined;
  const property = discriminator(branches);
  if (!property) return undefined;
  const values = [
    ...new Map(
      branches.map((branch) => {
        const value = fixedValue(branch, property)![0];
        return [JSON.stringify(value), value];
      }),
    ).values(),
  ];
  const { anyOf: _anyOf, ...rest } = schema;
  return {
    ...rest,
    type: "object",
    properties: {
      [property]: {
        ...(values.every((value) => typeof value === "string") && {
          type: "string",
        }),
        enum: values,
      },
    },
    required: [property],
    allOf: values.map((value) => {
      const group = branches.filter(
        (branch) =>
          JSON.stringify(fixedValue(branch, property)![0]) ===
          JSON.stringify(value),
      );
      return {
        if: {
          type: "object",
          properties: { [property]: { const: value } },
          required: [property],
        },
        // biome-ignore lint/suspicious/noThenProperty: the JSON Schema keyword.
        then: claudeSchemaNode(
          group.length === 1 ? group[0] : { anyOf: group },
          indexed,
        ),
      };
    }),
  };
}

function claudeSchemaNode(
  schema: unknown,
  indexed: Record<string, unknown>,
): unknown {
  if (!isRecord(schema)) return schema;
  const union = discriminatedUnion(schema, indexed);
  if (union) return union;
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
function claudeOutputValue(schema: unknown, value: unknown): unknown {
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

/** Login and API-key variables the SDK may authenticate with. */
const CLAUDE_AUTHENTICATION_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
];

/** Network settings a host may need to reach the Claude API. */
const CLAUDE_NETWORK_ENVIRONMENT = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/** Claude login values a supervised service may load with LoadCredential. */
const CLAUDE_LOGIN_CREDENTIALS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

/**
 * The Claude login values systemd loaded for a supervised service. They
 * stay out of `process.env`, so git, Codex and other children never inherit
 * them; only the Claude SDK child receives them. An unreadable or invalid
 * credential holds with its name.
 */
export function serviceLoginEnvironment(): Record<string, string> {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  const env: Record<string, string> = {};
  if (!directory || !isAbsolute(directory)) return env;
  for (const name of CLAUDE_LOGIN_CREDENTIALS) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    let value: string;
    try {
      value = readFileSync(path, "utf8").trim();
    } catch {
      throw new PlannerError(
        "hold",
        `Controller credential ${name} is unavailable; restore its configured private file and restart the service, then answer retry`,
      );
    }
    if (!value || /[\r\n\0]/.test(value))
      throw new PlannerError(
        "hold",
        `Controller credential ${name} is empty or invalid; update its private file and restart the service, then answer retry`,
      );
    env[name] = value;
  }
  return env;
}

/**
 * The SDK child's environment: a worker's (worktree.ts workerEnvironment)
 * with the operator's login (HOME keeps ~/.claude, or the service's loaded
 * credentials) and network settings, and nothing of GitHub, Git or SSH.
 */
export function claudeEnvironment(
  credentialDirectory: string,
  maxOutputTokens: number,
  login: Record<string, string>,
): Record<string, string> {
  // A service's bound login reaches Claude SDK children only.
  return {
    ...workerEnvironment(credentialDirectory, [
      ...CLAUDE_AUTHENTICATION_ENVIRONMENT,
      ...CLAUDE_NETWORK_ENVIRONMENT,
    ]),
    ...login,
    CLAUDE_AGENT_SDK_CLIENT_APP: "clockgrove-factory/core",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
    DISABLE_TELEMETRY: "1",
  };
}

/**
 * An isolated Agent SDK session for one structured answer, authenticated by
 * the operator's Claude login.
 */
function claudePlanningOptions(input: {
  choice: ModelChoice<ClaudeEffort>;
  schema: unknown;
  cwd: string;
  credentialDirectory: string;
  maxOutputTokens: number;
  login: Record<string, string>;
  abortController: AbortController;
  /** `cwd` is the exact tree to read: allow read-only tools over it. */
  tree: boolean;
}): Options {
  return {
    abortController: input.abortController,
    cwd: input.cwd,
    model: input.choice.model,
    effort: input.choice.effort,
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
    // Assistant messages arrive only per completed block, so a long answer
    // would be silent while it streams. Deltas keep the idle clock live.
    includePartialMessages: true,
    // Prompts carry untrusted source text; never expand @paths or commands.
    verbatimPrompts: true,
    maxTurns: input.tree
      ? CLAUDE_TREE_REVIEW_MAX_TURNS
      : CLAUDE_PLANNING_MAX_TURNS,
    persistSession: false,
    env: claudeEnvironment(
      input.credentialDirectory,
      input.maxOutputTokens,
      input.login,
    ),
  };
}

const LOGIN_HOLD =
  "Planner login expired: run `claude auth login` on the service host, then answer retry";

/** Fail closed when the session exposes anything beyond structured output. */
function checkInitialization(
  message: SDKSystemMessage,
  choice: ModelChoice<ClaudeEffort>,
  cwd: string,
  tree: boolean,
): void {
  if (resolve(message.cwd) !== resolve(cwd))
    throw new PlannerError(
      "retry",
      "Claude SDK initialized outside the supplied planning directory",
    );
  // The pinned SDK may omit effort; only a reported value can differ.
  const effort = (message as { effort?: unknown }).effort;
  if (
    message.model !== choice.model ||
    (effort !== undefined && effort !== choice.effort)
  )
    throw new PlannerError(
      "hold",
      `Claude SDK selected model ${message.model}${effort === undefined ? "" : ` at ${String(effort)} effort`}, expected ${choice.model} at ${choice.effort}. Choose a model the provider login can use in the Factory configuration, then answer retry.`,
    );
  if (message.permissionMode !== "dontAsk")
    throw new PlannerError(
      "fail",
      `Claude SDK selected permission mode ${message.permissionMode}, expected dontAsk`,
    );
  const allowed = new Set([
    STRUCTURED_OUTPUT_TOOL,
    ...(tree ? TREE_REVIEW_TOOLS : []),
  ]);
  const tool = message.tools.find((name) => !allowed.has(name));
  if (tool)
    throw new PlannerError(
      "fail",
      `Claude SDK exposed unconfigured tool ${tool}`,
    );
  if (message.mcp_servers.length)
    throw new PlannerError(
      "fail",
      "Claude SDK initialized an unconfigured MCP server",
    );
}

/** The runtime's stand-in for a model message it produced itself. */
export const SYNTHETIC_MODEL = "<synthetic>";

/** Claude Agent SDK assistant errors that mean the login cannot be used. */
const AUTHENTICATION_ERRORS = new Set<SDKAssistantMessageError>([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "cloud_credential_error",
]);

/** What the stream showed beside the result. */
export interface SessionFacts {
  initialized: boolean;
  modelResponded: boolean;
  assistantError?: SDKAssistantMessageError;
  /** A rejected subscription limit; `resetsAt` is epoch seconds. */
  limit?: SDKRateLimitInfo;
}

export function apiErrorStatus(result: SDKResultMessage): number | undefined {
  return result.subtype === "success" &&
    typeof result.api_error_status === "number"
    ? result.api_error_status
    : undefined;
}

/**
 * Whether a failed result is an authentication failure, from its structured
 * fields: API status 401, a login assistant error or a sign-in startup failure.
 */
function authenticationFailure(
  result: SDKResultMessage,
  assistantError: SDKAssistantMessageError | undefined,
): boolean {
  if (result.subtype === "success" && !result.is_error) return false;
  return (
    (result.subtype === "success"
      ? result.api_error_status === 401
      : result.startup_failure_reason === "gateway_signin_required") ||
    (assistantError !== undefined && AUTHENTICATION_ERRORS.has(assistantError))
  );
}

/** A failed result's class, in the order planner and worker check it. */
export type FailedResult =
  | { kind: "billing"; message: string }
  | { kind: "login" }
  | { kind: "too-long" }
  | { kind: "limit"; message: string; afterMs: number }
  | { kind: "other" };

/**
 * Classify a failed result from its structured fields only: billing, login,
 * context, limits, then anything else. `ended` describes the result.
 */
export function failedResult(
  result: SDKResultMessage,
  facts: SessionFacts,
  ended: string,
): FailedResult {
  if (
    facts.assistantError === "billing_error" ||
    facts.limit?.errorCode === "credits_required"
  )
    return {
      kind: "billing",
      message: `Restore the Claude plan, credits or billing for the service's Claude login, then answer retry (${ended})`,
    };
  if (authenticationFailure(result, facts.assistantError))
    return { kind: "login" };
  if (result.terminal_reason === "prompt_too_long") return { kind: "too-long" };
  const status = apiErrorStatus(result);
  const resetsAt = facts.limit?.resetsAt;
  if (
    resetsAt !== undefined &&
    Number.isFinite(resetsAt) &&
    (status === 429 || facts.assistantError === "rate_limit")
  )
    return {
      kind: "limit",
      message: `Claude usage limit until ${new Date(resetsAt * 1000).toISOString()}: ${ended}`,
      afterMs: Math.max(0, resetsAt * 1000 - Date.now()),
    };
  // A limit with no reset time waits instead of spending the error count.
  if (
    status === 429 ||
    facts.assistantError === "rate_limit" ||
    facts.limit !== undefined
  )
    return {
      kind: "limit",
      message: `Claude rate or usage limit: ${ended}`,
      afterMs: LIMIT_WAIT_MS,
    };
  return { kind: "other" };
}

/**
 * The API rejected the credentials before any model response. Clients
 * sharing one login rotate its OAuth token, so a session that read it just
 * before a rotation gets this; a fresh session reads the new token.
 */
class CredentialRejected extends PlannerError {}

/** The outcome of a result, from its structured fields only. */
function settle(
  result: SDKResultMessage,
  facts: SessionFacts,
  schema: unknown,
): unknown {
  const succeeded = result.subtype === "success" && !result.is_error;
  const status = apiErrorStatus(result);
  const text = detail(
    result.subtype === "success" ? result.result : result.errors.join("; "),
  );
  const ended = `Claude planning ended with ${result.subtype}${result.stop_reason ? ` (stop_reason ${result.stop_reason})` : ""}: ${text || "no detail"}`;
  if (result.stop_reason === "refusal")
    throw new PlannerError(
      "fail",
      "Claude response ended with stop_reason refusal",
    );
  if (!succeeded) {
    const failed = failedResult(result, facts, ended);
    switch (failed.kind) {
      case "billing":
        throw new PlannerError("hold", failed.message);
      case "login":
        if (!facts.modelResponded && status === 401)
          throw new CredentialRejected("retry", `${LOGIN_HOLD} (${ended})`);
        throw new PlannerError("hold", `${LOGIN_HOLD} (${ended})`);
      case "too-long":
        throw new PlannerError(
          "fail",
          `The request is larger than the model's context window: ${ended}`,
        );
      case "limit":
        throw new PlannerError("retry", failed.message, failed.afterMs);
      // Overload, connection, turn or output limits, structured output
      // retries and anything unknown: a fresh call may succeed.
      case "other":
        throw new PlannerError("retry", ended);
    }
  }
  if (!facts.initialized)
    throw new PlannerError(
      "retry",
      "Claude SDK did not report its initialized session",
    );
  if (result.subtype !== "success" || result.structured_output === undefined)
    throw new PlannerError(
      "retry",
      "Claude result carried no structured output",
    );
  return claudeOutputValue(schema, result.structured_output);
}

export function usageOf(result: SDKResultMessage): PlannerAnswer["usage"] {
  const models = Object.values(result.modelUsage ?? {});
  if (models.length)
    return models.reduce(
      (sum, model) => ({
        input:
          sum.input +
          model.inputTokens +
          model.cacheReadInputTokens +
          model.cacheCreationInputTokens,
        output: sum.output + model.outputTokens,
        cached: (sum.cached ?? 0) + model.cacheReadInputTokens,
      }),
      { input: 0, output: 0, cached: 0 },
    );
  const usage = result.usage;
  if (!usage) return undefined;
  const read = usage.cache_read_input_tokens ?? 0;
  return {
    input:
      (usage.input_tokens ?? 0) +
      read +
      (usage.cache_creation_input_tokens ?? 0),
    output: usage.output_tokens ?? 0,
    cached: read,
  };
}

/**
 * The query prompt. Images need streaming input: one user message whose
 * content is the prompt text and a base64 PNG image block per image. With
 * no images the prompt stays a plain string.
 */
function claudePrompt(
  text: string,
  images: string[],
): string | AsyncIterable<SDKUserMessage> {
  if (!images.length) return text;
  const message: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...images.map((path) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: "image/png" as const,
            data: readFileSync(path).toString("base64"),
          },
        })),
      ],
    },
  };
  return (async function* () {
    yield message;
  })();
}

/** Planning and review through the Claude Agent SDK and the operator's login. */
export class ClaudePlanner implements Planner {
  constructor(private readonly options: ClaudePlannerOptions) {}

  async answer(call: PlannerCall): Promise<PlannerAnswer> {
    try {
      return await this.attempt(call);
    } catch (error) {
      // A rotated OAuth token: one fresh session reads the new one. A login
      // that stays rejected holds.
      if (!(error instanceof CredentialRejected)) throw error;
      try {
        return await this.attempt(call);
      } catch (again) {
        if (again instanceof CredentialRejected)
          throw new PlannerError("hold", again.message);
        throw again;
      }
    }
  }

  private async attempt(call: PlannerCall): Promise<PlannerAnswer> {
    const choice = modelChoice(this.options, call);
    return loggedCall("claude", call, choice, (record) =>
      this.run(call, choice, record),
    );
  }

  private async run(
    call: PlannerCall,
    choice: ModelChoice<ClaudeEffort>,
    record: Record<string, unknown>,
  ): Promise<Omit<PlannerAnswer, "ms">> {
    call.signal.throwIfAborted();
    let query: typeof import("@anthropic-ai/claude-agent-sdk").query;
    try {
      ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
    } catch (error) {
      throw new PlannerError(
        "hold",
        `Claude planning needs the optional @anthropic-ai/claude-agent-sdk package; install it, then answer retry (${detail(String(error))})`,
      );
    }
    const login = serviceLoginEnvironment();
    let prompt: ReturnType<typeof claudePrompt>;
    try {
      prompt = claudePrompt(call.prompt, callImages(call));
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      throw new PlannerError(
        "hold",
        `A review image could not be read; restore it, then answer retry (${detail(String(error))})`,
      );
    }
    const tree = Boolean(call.readDir);
    const watchdog = new IdleWatchdog(
      modelResponseTimeoutMs(choice.effort),
      call.signal,
      ACTIVE_TOOL_IDLE_MS,
    );
    // Aborting the SDK's controller kills its child process.
    const abortController = new AbortController();
    const abort = () => abortController.abort(watchdog.signal.reason);
    watchdog.signal.addEventListener("abort", abort, { once: true });
    const facts: SessionFacts = { initialized: false, modelResponded: false };
    let session: Query | undefined;
    let root: string | undefined;
    try {
      let credentialDirectory: string;
      let cwd: string;
      try {
        root = mkdtempSync(join(tmpdir(), "factory-claude-"));
        credentialDirectory = join(root, "gh");
        mkdirSync(credentialDirectory, { mode: 0o700 });
        cwd = call.readDir ? resolve(call.readDir) : join(root, "work");
        if (!tree) mkdirSync(cwd, { mode: 0o700 });
      } catch (error) {
        throw new PlannerError(
          "hold",
          `Factory could not set up the Claude planning home; fix the host's temporary directory, then answer retry (${detail(String(error))})`,
        );
      }
      session = query({
        prompt,
        options: claudePlanningOptions({
          choice,
          schema: call.schema,
          cwd,
          credentialDirectory,
          maxOutputTokens:
            this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          login,
          abortController,
          tree,
        }),
      });
      const callStarted = Date.now();
      const events = session[Symbol.asyncIterator]();
      let result: SDKResultMessage | undefined;
      for (;;) {
        const next = await watchdog.race(events.next());
        if (next.done) break;
        const message = next.value;
        call.activity?.();
        // Every message's kind and timing, so a stall can be read afterwards.
        if (message.type !== "stream_event")
          call.log({
            event: "claude-event",
            type:
              message.type === "system"
                ? `system.${message.subtype}`
                : message.type,
            ms: Date.now() - callStarted,
          });
        // A retry announces its backoff; that silence is not inactivity.
        watchdog.progress(
          message.type === "system"
            ? `system.${message.subtype}`
            : message.type,
          undefined,
          message.type === "system" && message.subtype === "api_retry"
            ? message.retry_delay_ms + (message.no_response?.retry_wait_ms ?? 0)
            : 0,
        );
        if (message.type === "assistant" || message.type === "user") {
          const content = message.message.content;
          if (Array.isArray(content))
            for (const block of content) {
              if (
                block.type === "tool_use" &&
                TREE_REVIEW_TOOLS.includes(block.name)
              )
                watchdog.progress(`tool_use:${block.name}`, {
                  id: block.id,
                  active: true,
                });
              else if (block.type === "tool_result")
                watchdog.progress("tool_result", {
                  id: block.tool_use_id,
                  active: false,
                });
            }
        }
        if (
          message.type === "rate_limit_event" &&
          message.rate_limit_info.status === "rejected"
        )
          facts.limit = message.rate_limit_info;
        if (message.type === "assistant") {
          if (message.error) facts.assistantError = message.error;
          if (message.message.model !== SYNTHETIC_MODEL)
            facts.modelResponded = true;
        }
        if (message.type === "system" && message.subtype === "init") {
          record.session = message.session_id;
          checkInitialization(message, choice, cwd, tree);
          facts.initialized = true;
        }
        if (message.type === "result") {
          result = message;
          break;
        }
      }
      if (!result)
        throw new PlannerError("retry", "Claude SDK ended without a result");
      const usage = usageOf(result);
      record.usage = usage;
      record.costUsd = result.total_cost_usd;
      record.turns = result.num_turns;
      if (result.stop_reason) record.stopReason = result.stop_reason;
      const value = settle(result, facts, call.schema);
      return {
        value,
        model: choice.model,
        effort: choice.effort,
        ...(usage && { usage }),
        ...(Number.isFinite(result.total_cost_usd) && {
          costUsd: result.total_cost_usd,
        }),
        ...(Number.isSafeInteger(result.num_turns) && {
          turns: result.num_turns,
        }),
      };
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      const idle = watchdog.expired;
      if (idle) throw new PlannerError("retry", idle.message);
      // The step was cancelled or hit its deadline: the engine decides.
      if (call.signal.aborted) throw call.signal.reason ?? error;
      throw error;
    } finally {
      watchdog.signal.removeEventListener("abort", abort);
      watchdog.stop();
      abortController.abort();
      session?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }
}
