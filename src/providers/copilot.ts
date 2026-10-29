/**
 * GitHub Copilot through the Copilot SDK and the operator's Copilot login
 * (`copilot` login or gh CLI auth): a Planner for plan and review calls, and
 * a Worker for the work step. The model gets file tools only, no shell, and
 * every read or write is checked to stay inside its directory. Copilot
 * shell, web, GitHub, MCP, plugins and configuration discovery are off.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  SessionConfigBase,
  SessionEvent,
  Tool,
} from "@github/copilot-sdk";
import { isObject } from "../checked.js";
import { serviceCredential } from "../credentials.js";
import { runningBuild } from "../log.js";
import { pathInsideRoot } from "../paths.js";
import { errorMessage } from "../text.js";
import { validationDeadlineMs } from "../validate.js";
import {
  type SelfValidateOptions,
  SelfValidation,
  selectedMediaNote,
  validationToolDescription,
  worktreeGitlinks,
} from "../work/self-validate.js";
import { VALIDATION_TOOL_NAME } from "../work/validate-tool.js";
import {
  targetOf,
  type Worker,
  type WorkerInput,
  type WorkerResult,
} from "../work/worker.js";
import { workerEnvironment } from "../worktree.js";
import { ACTIVE_TOOL_IDLE_MS } from "./claude.js";
import { COPILOT_SECRETS } from "./config.js";
import {
  callImages,
  detail,
  freshOnOverflow,
  IdleWatchdog,
  loggedCall,
  type ModelChoice,
  modelChoice,
  type Planner,
  type PlannerAnswer,
  type PlannerCall,
  PlannerError,
  type PlannerModels,
  providerOutcome,
} from "./planner.js";
import {
  type Conversation,
  openTurn,
  overflowed,
  ResumeOverflow,
  type Session,
  type Turn as SessionTurn,
  turnFields,
  withoutPrevious,
} from "./session.js";
import {
  captureRequest,
  captureResponse,
  captureToolOutput,
  describeRequest,
  firstToken,
  logUsage,
  NativeTools,
  providerUsage,
  Tallies,
  tokens,
  usageRecord,
} from "./usage.js";

export const DEFAULT_COPILOT_MODELS: PlannerModels = {
  planner: { model: "gpt-6.1-sol", effort: "high" },
  reviewer: { model: "gpt-6.1-sol", effort: "medium" },
};

/**
 * The additive counts of an `assistant.usage` event kept per model as the
 * call's `providerUsage`: tokens, Copilot's own cost and duration, and
 * its billing in nano AI units (not USD).
 */
const COPILOT_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "acceptedPredictionTokens",
  "rejectedPredictionTokens",
  "cost",
  "duration",
  "totalNanoAiu",
];

/** Silence that ends a planning or review call; a worker turn uses `worker.idleSeconds`. */
const PLANNER_IDLE_MS = 15 * 60 * 1000;
const CLEANUP_MS = 5_000;

const READ_TOOLS = ["view", "rg", "glob"];

const LOGIN_HOLD =
  "Copilot login is missing or expired: run `copilot` and `/login` (or `gh auth login`) as the service's user, then answer retry";

/**
 * A model the login can't use: the answer is the setting, then `switch` to
 * re-freeze the provider's new settings or to move to another provider.
 * `listed`: the hold comes from the model list, before any session, so
 * `retry` is offered too: it reads the list again and bills nothing, and
 * succeeds once an admin enables the model or the list catches up. A
 * session that served another model offers no retry: each bills a request.
 */
function modelHold(why: string, listed: boolean): PlannerError {
  return new PlannerError(
    "hold",
    `${why}. Set this provider's model to one the Copilot login can use and restart the service, then answer \`switch NAME\` with this provider's name to run on its new settings, or with another configured provider's name;${listed ? " answer `retry` once the login can use the model (an admin enabled it), which checks the model list again before any request;" : ""} or cancel.`,
    undefined,
    listed
      ? [
          {
            answer: "retry",
            family: "retry",
            consequence:
              "Reads the model list again before any request, so it bills nothing.",
          },
          "switch",
          "cancel",
        ]
      : ["switch", "cancel"],
  );
}

const WORKER_SYSTEM =
  "You are an implementation worker controlled by Factory. Work only in the current working directory and only on paths owned by the Work Item. Do not commit, push, publish, open or edit issues or pull requests, access GitHub tools, deploy, or change the current Git HEAD. You have file tools and no shell; Factory validates your result after you finish. Return a concise description and stop when complete or safely blocked.";
const VALIDATE_SYSTEM = ` Your ${VALIDATION_TOOL_NAME} tool runs the Work Item's declared validation commands on your current files: finish only after it passes on your final files.`;

/** One Copilot turn: a fresh session, one prompt, its events until idle. */
interface Turn {
  choice: ModelChoice;
  /** The session's working directory; every permitted path stays inside it. */
  directory: string;
  /** Built-in tools, as the SDK names them. */
  tools: string[];
  /** Factory's own tools; each is approved only with no arguments. */
  custom?: Tool[];
  writes: boolean;
  system?: string;
  prompt: string;
  images?: string[];
  idleMs: number;
  /** The quiet bound while a tool runs, when longer than the default. */
  toolIdleMs?: number;
  signal: AbortSignal;
  onEvent(event: SessionEvent): void;
  /** The call's model-usage record (usage.ts): its tokens and tool calls as they arrive. */
  record: Record<string, unknown>;
  /**
   * A retained conversation's turn (session.ts): it resumes the kept
   * session when it continues one, and keeps its session after a finished
   * turn instead of deleting it.
   */
  conversation?: SessionTurn;
  /** A session this turn replaces: deleted once this one is open. */
  replaces?: string;
}

interface TurnResult {
  text: string;
  usage: { input: number; output: number; cached: number };
  session: string;
}

/**
 * Copilot settings the runtime may see, beside a worker's environment: its
 * home, a GitHub Enterprise endpoint (`COPILOT_API_URL`), and a custom
 * model endpoint (`COPILOT_PROVIDER_*`); its secrets are COPILOT_SECRETS.
 */
const COPILOT_LOGIN = [
  "COPILOT_API_URL",
  "COPILOT_HOME",
  "COPILOT_PROVIDER_BASE_URL",
  "COPILOT_PROVIDER_TYPE",
];

/**
 * The Copilot runtime's environment: a worker's (worktree.ts
 * workerEnvironment, nothing of GitHub, Git or SSH, no API keys, no
 * COPILOT_ALLOW_ALL) plus Copilot's own login: COPILOT_LOGIN, the
 * COPILOT_SECRETS from the environment or the service's credentials, and
 * the gh CLI's configuration, which holds the login when Copilot signs in
 * through gh. The model has no shell, and Validate runs its commands in the sandbox
 * on validationEnvironment, so these stay with the runtime.
 */
function copilotEnvironment(): Record<string, string> {
  const gh =
    process.env.GH_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");
  const env = workerEnvironment(gh, COPILOT_LOGIN);
  // A supervised service has its secrets as loaded credentials; and
  // workerEnvironment drops every GITHUB_ name, GITHUB_COPILOT_API_TOKEN too.
  for (const name of COPILOT_SECRETS) {
    const value = process.env[name] ?? serviceCredential(name);
    if (value) env[name] = value;
  }
  return env;
}

/** The SDK's built-ins, which name grep `rg`; Validate is Factory's own. */
export function copilotTools(tools: readonly string[]): string[] {
  return tools.flatMap((name) =>
    name === "Validate" ? [] : [name === "grep" ? "rg" : name],
  );
}

/** A session.error as an outcome, from its structured type and status only. */
function sessionFailure(
  data: Extract<SessionEvent, { type: "session.error" }>["data"],
): PlannerError {
  const shown = detail(data.message);
  if (
    data.errorType === "authentication" ||
    data.errorType === "authorization" ||
    data.statusCode === 401
  )
    return new PlannerError("hold", `${LOGIN_HOLD} (${shown})`);
  if (data.errorType === "quota")
    return data.errorCode === "billing_not_configured"
      ? new PlannerError(
          "hold",
          `Restore the Copilot plan or billing for the service's login, then answer retry (${shown})`,
        )
      : // A spent premium-request quota resets at a time Copilot doesn't
        // say: Factory asks whether to wait or switch (docs/reference/steps.md#Waits).
        new PlannerError("retry", `Copilot quota: ${shown}`, {
          kind: "reset",
          provider: "copilot",
        });
  if (data.errorType === "rate_limit")
    return data.errorCode === "user_weekly_rate_limited"
      ? new PlannerError("retry", `Copilot weekly limit: ${shown}`, {
          kind: "reset",
          provider: "copilot",
        })
      : // A short rate limit is an unknown transient cause: back off.
        new PlannerError("retry", `Copilot rate limit: ${shown}`);
  if (data.errorType === "context_limit")
    return PlannerError.contextOverflow(
      `The request is larger than the model's context window: ${shown}`,
    );
  return new PlannerError("retry", `Copilot call failed: ${shown}`);
}

async function bounded(operation: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    operation.catch(() => undefined),
    new Promise((done) => {
      timer = setTimeout(done, CLEANUP_MS);
    }),
  ]);
  clearTimeout(timer);
}

async function runTurn(turn: Turn): Promise<TurnResult> {
  turn.signal.throwIfAborted();
  let sdk: typeof import("@github/copilot-sdk");
  try {
    sdk = await import("@github/copilot-sdk");
  } catch (error) {
    throw new PlannerError(
      "hold",
      `Copilot needs the optional @github/copilot-sdk package; install it, then answer retry (${detail(String(error))})`,
    );
  }
  const root = resolve(turn.directory);
  // A running tool sends no events (Validate takes minutes): it gets the
  // longer bound, as Claude's do (Validate: its whole configured deadline),
  // never less than the turn's own.
  const watchdog = new IdleWatchdog(
    turn.idleMs,
    turn.signal,
    Math.max(ACTIVE_TOOL_IDLE_MS, turn.idleMs, turn.toolIdleMs ?? 0),
  );
  const client: CopilotClient = new sdk.CopilotClient({
    mode: "empty",
    workingDirectory: root,
    // The login lives here (or in gh); sessions are deleted after the turn.
    baseDirectory: process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
    env: copilotEnvironment(),
    builtinPluginDirectories: [],
    logLevel: "error",
    useLoggedInUser: true,
    enableRemoteSessions: false,
    clientInfo: {
      applicationName: "factory",
      applicationVersion: runningBuild().factoryVersion ?? "unknown",
      integrationName: "factory",
      integrationVersion: "1",
    },
  });
  let session: CopilotSession | undefined;
  let finished = false;
  try {
    await watchdog.race(client.start());
    const auth = await watchdog.race(client.getAuthStatus());
    if (!auth.isAuthenticated)
      throw new PlannerError(
        "hold",
        `${LOGIN_HOLD} (${detail(auth.statusMessage ?? "not authenticated")})`,
      );
    // Before any session: a session on a model the login can't use bills
    // a request for whatever Copilot serves instead.
    const models = await watchdog.race(client.listModels());
    const listed = models.find((entry) => entry.id === turn.choice.model);
    if (!listed || listed.policy?.state === "disabled")
      throw modelHold(
        `The Copilot login ${listed ? "has model" : "doesn't offer model"} ${turn.choice.model}${listed ? " disabled by policy" : ""} (it offers ${detail(
          models
            .filter((entry) => entry.policy?.state !== "disabled")
            .map((entry) => entry.id)
            .join(", "),
        )})`,
        true,
      );
    let text = "";

    const usage = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
    let reasoning: number | null = null;
    const calls = new Tallies();
    const tools = new NativeTools();
    const toolNames = new Map<string, string>();
    /** The provider's own usage per model, summed over its responses. */
    const byModel: Record<string, Record<string, number>> = {};
    let sentAt: number | undefined;
    // One prompt per call: a fresh session's first turn, or the next turn
    // of the retained session it resumes.
    turnFields(turn.record, turn.conversation ?? { number: 1 });
    turn.record.imageOutputs = 0;
    let settle: () => void = () => undefined;
    let fail: (error: PlannerError) => void = () => undefined;
    // The turn ends at idle, or at once on a session error (as sendAndWait does).
    const idle = new Promise<void>((done, reject) => {
      settle = done;
      fail = reject;
    });
    // An error before the turn is awaited is still seen there.
    idle.catch(() => undefined);
    let sent = false;
    const custom = new Set(turn.custom?.map((tool) => tool.name));
    const permit = (request: PermissionRequest) => {
      // Factory's own tool takes no arguments: the model names no command.
      if (request.kind === "custom-tool")
        return !request.managedApprovalRequired &&
          custom.has(request.toolName) &&
          (request.args === undefined ||
            (isObject(request.args) && !Object.keys(request.args).length))
          ? { kind: "approve-once" as const }
          : {
              kind: "reject" as const,
              feedback: "Factory did not grant this capability",
            };
      if (
        request.managedApprovalRequired ||
        (request.kind !== "read" && request.kind !== "write") ||
        request.requestSandboxBypass ||
        (request.kind === "write" && !turn.writes)
      )
        return {
          kind: "reject" as const,
          feedback: "Factory did not grant this capability",
        };
      const path = request.kind === "read" ? request.path : request.fileName;
      return pathInsideRoot(path, root)
        ? { kind: "approve-once" as const }
        : {
            kind: "reject" as const,
            feedback: "Factory grants file access only inside this directory",
          };
    };
    const resumed = turn.conversation?.resumed?.id;
    const open = (config: SessionConfigBase) =>
      resumed
        ? client.resumeSession(resumed, config)
        : client.createSession(config);
    session = await watchdog.race(
      open({
        clientName: "factory",
        model: turn.choice.model,
        reasoningEffort: turn.choice.effort as never,
        ...(turn.system
          ? { systemMessage: { mode: "append", content: turn.system } }
          : {}),
        availableTools: [
          ...turn.tools.map((name) => `builtin:${name}`),
          ...[...custom].map((name) => `custom:${name}`),
        ],
        ...(turn.custom?.length && { tools: turn.custom }),
        onPermissionRequest: permit,
        onEvent: (event: SessionEvent) => {
          turn.onEvent(event);
          watchdog.progress(
            event.type,
            event.type === "tool.execution_start" ||
              event.type === "tool.execution_complete"
              ? {
                  id: event.data.toolCallId,
                  active: event.type === "tool.execution_start",
                }
              : undefined,
          );
          if (event.type === "assistant.message" && event.data.content)
            text = event.data.content;
          // Copilot quietly serves another model for one it can't: refuse that.
          if (
            event.type === "assistant.usage" &&
            event.data.model &&
            event.data.model !== turn.choice.model
          )
            fail(
              modelHold(
                `Copilot served ${event.data.model}, not the configured ${turn.choice.model}`,
                false,
              ),
            );
          if (
            sentAt !== undefined &&
            (event.type === "assistant.message_delta" ||
              event.type === "assistant.reasoning_delta" ||
              event.type === "assistant.message")
          )
            firstToken(turn.record, sentAt);
          if (event.type === "assistant.turn_end") tools.response();
          if (event.type === "assistant.usage") {
            turn.record.reportedModel = event.data.model;
            const sums = byModel[event.data.model] ?? { responses: 0 };
            byModel[event.data.model] = sums;
            sums.responses = (sums.responses ?? 0) + 1;
            const counts: Record<string, unknown> = {
              ...event.data,
              totalNanoAiu: event.data.copilotUsage?.totalNanoAiu,
            };
            for (const key of COPILOT_USAGE_KEYS) {
              const value = counts[key];
              if (typeof value === "number" && Number.isFinite(value))
                sums[key] = (sums[key] ?? 0) + value;
            }
            turn.record.providerUsage = providerUsage(byModel) ?? null;
            usage.input += event.data.inputTokens ?? 0;
            usage.output += event.data.outputTokens ?? 0;
            usage.cached += event.data.cacheReadTokens ?? 0;
            usage.cacheWrite += event.data.cacheWriteTokens ?? 0;
            if (event.data.reasoningTokens !== undefined)
              reasoning = (reasoning ?? 0) + event.data.reasoningTokens;
            turn.record.tokens = tokens({ ...usage, reasoning });
          }
          if (event.type === "tool.execution_start") {
            calls.add(event.data.toolName, event.data.toolCallId);
            turn.record.nativeToolActivity = calls.value;
            toolNames.set(event.data.toolCallId, event.data.toolName);
            tools.call(event.data.toolCallId);
            turn.record.nativeTools = tools.value;
          }
          if (event.type === "tool.execution_complete") {
            tools.result(event.data.toolCallId, !event.data.success);
            turn.record.nativeTools = tools.value;
            const output =
              event.data.result?.content ?? event.data.error?.message;
            if (output)
              captureToolOutput(
                turn.record,
                toolNames.get(event.data.toolCallId) ?? "unknown",
                output,
              );
          }
          if (event.type === "session.error") fail(sessionFailure(event.data));
          if (event.type === "session.idle" && sent) settle();
        },
        workingDirectory: root,
        additionalDirectories: [],
        streaming: true,
        enableConfigDiscovery: false,
        enableExperimentalMode: false,
        skipCustomInstructions: true,
        customAgentsLocalOnly: true,
        coauthorEnabled: false,
        mcpServers: {},
        customAgents: [],
        skillDirectories: [],
        pluginDirectories: [],
        instructionDirectories: [],
        infiniteSessions: { enabled: false },
        memory: { enabled: false },
        enableMcpApps: false,
        enableSessionTelemetry: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableSkills: false,
        skipEmbeddingRetrieval: true,
        remoteSession: "off",
      }),
    );
    if (turn.replaces) await bounded(client.deleteSession(turn.replaces));
    sent = true;
    sentAt = Date.now();
    await watchdog.race(
      session.send({
        prompt: turn.prompt,
        ...(turn.images?.length
          ? {
              attachments: turn.images.map((path) => ({
                type: "file" as const,
                path,
              })),
            }
          : {}),
      }),
    );
    await watchdog.race(idle);
    finished = true;
    return { text, usage, session: session.sessionId };
  } catch (error) {
    if (error instanceof PlannerError) throw error;
    const expired = watchdog.expired;
    if (expired) throw new PlannerError("retry", expired.message);
    if (turn.signal.aborted) throw turn.signal.reason ?? error;
    throw new PlannerError(
      "retry",
      `Copilot call failed: ${detail(errorMessage(error))}`,
    );
  } finally {
    watchdog.stop();
    if (session) {
      if (!finished) await bounded(session.abort());
      await bounded(session.disconnect());
      // A retained conversation's finished session stays for its next turn.
      if (!(finished && turn.conversation))
        await bounded(client.deleteSession(session.sessionId));
    }
    await bounded(client.stop());
    await bounded(client.forceStop());
  }
}

/**
 * Open a retained Copilot turn (session.ts openTurn). Whether the kept
 * session is still there is known only when it is resumed: a resume that
 * fails leaves the turn's mark, so the next attempt starts fresh.
 */
function copilotTurn(
  conversation: Conversation | undefined,
  prompt: string,
  model: string,
): SessionTurn | undefined {
  if (!conversation) return undefined;
  try {
    return openTurn(conversation, prompt, "copilot", model, () => true);
  } catch (error) {
    throw new PlannerError(
      "hold",
      `Factory could not set up the Copilot conversation; fix the host's work directory, then answer retry (${detail(String(error))})`,
    );
  }
}

/** The session a turn left, as an answer's or result's field. */
function withSession(session: Session | undefined): { session?: Session } {
  return session ? { session } : {};
}

/** A turn's conversation for runTurn: the session it continues or replaces. */
function replacing(
  turn: SessionTurn | undefined,
  conversation: Conversation | undefined,
): Pick<Turn, "conversation" | "replaces"> {
  if (!turn) return {};
  const previous = conversation?.previous;
  return {
    conversation: turn,
    ...(!turn.resumed && previous?.provider === "copilot"
      ? { replaces: previous.id }
      : {}),
  };
}

/** Planning and review through Copilot, with read-only tools over `readDir`. */
export class CopilotPlanner implements Planner {
  constructor(
    private readonly models: PlannerModels = DEFAULT_COPILOT_MODELS,
  ) {}

  answer(call: PlannerCall): Promise<PlannerAnswer> {
    return freshOnOverflow(call, (once) => this.once(once));
  }

  private once(call: PlannerCall): Promise<PlannerAnswer> {
    const choice = modelChoice(this.models, call);
    return loggedCall("copilot", call, choice, async (record, live) => {
      const started = Date.now();
      const images = callImages(call);
      const turn = copilotTurn(call.conversation, call.prompt, choice.model);
      if (turn?.resumed) captureRequest(record, turn.prompt);
      // Without a tree the session gets an empty directory and no tools: a
      // retained conversation's own, so it is the same on every turn.
      let empty: string | undefined;
      if (!call.readDir && call.conversation) {
        empty = join(call.conversation.dir, "work");
        mkdirSync(empty, { recursive: true, mode: 0o700 });
      } else if (!call.readDir)
        empty = mkdtempSync(join(tmpdir(), "factory-copilot-"));
      try {
        const result = await runTurn({
          choice,
          directory: call.readDir ?? empty!,
          tools: call.readDir ? READ_TOOLS : [],
          writes: false,
          prompt: `${turn?.prompt ?? call.prompt}\n\nAnswer with only one JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(call.schema)}`,
          images,
          record,
          idleMs: PLANNER_IDLE_MS,
          signal: call.signal,
          ...replacing(turn, call.conversation),
          onEvent: (event) => {
            call.activity?.();
            call.log({
              event: "copilot-event",
              type: event.type,
              ms: Date.now() - started,
            });
            // The main agent's turns and context; a sub-agent's carry its agentId.
            if (event.type === "assistant.turn_start" && !event.agentId)
              live.turn();
            if (event.type === "session.usage_info" && !event.agentId)
              live.context(event.data.currentTokens, event.data.tokenLimit);
          },
        });
        record.session = result.session;
        captureResponse(record, result.text);
        const body = result.text
          .trim()
          .replace(/^```(?:json)?\s*/, "")
          .replace(/\s*```$/, "");
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          record.stage = "parse";
          throw new PlannerError(
            "retry",
            `Copilot answer is not JSON: ${detail(result.text)}`,
          );
        }
        return {
          value,
          model: choice.model,
          effort: choice.effort,
          usage: result.usage,
          ...withSession(turn?.end(result.session)),
        };
      } catch (error) {
        throw overflowed(error, turn);
      } finally {
        if (empty && !call.conversation)
          rmSync(empty, { recursive: true, force: true });
      }
    });
  }
}

export interface CopilotWorkerOptions {
  model: ModelChoice;
  /** The tool ceiling, from providers/config.ts COPILOT_TOOLS. */
  tools: string[];
  /** `worker.idleSeconds`, in ms. */
  idleMs: number;
  /** What Validate needs; without it the worker has no Validate. */
  validation?: SelfValidateOptions;
}

/** Copilot's file tools that write the file their `path` names. */
const EDIT_TOOLS = ["create", "edit"];

/** A Copilot session event as worker activity: tools, edits, commands, turns, context and compactions. */
function copilotActivity(
  input: WorkerInput,
  event: SessionEvent,
  toolNames: Map<string, string>,
): void {
  if (event.type === "assistant.turn_start") input.activity({ kind: "turn" });
  // The main agent's context; a sub-agent's events carry its agentId.
  if (event.type === "session.usage_info" && !event.agentId)
    input.activity({
      kind: "context",
      tokens: event.data.currentTokens,
      window: event.data.tokenLimit,
    });
  if (
    event.type === "session.compaction_complete" &&
    event.data.success &&
    !event.agentId
  )
    input.activity({ kind: "compaction" });
  if (event.type === "tool.execution_complete") {
    const tool = toolNames.get(event.data.toolCallId);
    toolNames.delete(event.data.toolCallId);
    if (tool) input.activity({ kind: "tool", phase: "finished", tool });
  }
  if (event.type !== "tool.execution_start") return;
  const tool = event.data.toolName;
  toolNames.set(event.data.toolCallId, tool);
  const args = isObject(event.data.arguments) ? event.data.arguments : {};
  input.activity({ kind: "tool", phase: "started", tool, ...targetOf(args) });
  if (EDIT_TOOLS.includes(tool) && typeof args.path === "string")
    input.activity({ kind: "edit", path: args.path });
  if (typeof args.command === "string")
    input.activity({ kind: "command", command: args.command });
}

/** Implementation turns through Copilot with file tools inside the worktree. */
export class CopilotWorker implements Worker {
  constructor(private readonly options: CopilotWorkerOptions) {}

  get validation(): SelfValidateOptions | undefined {
    return this.options.tools.includes("Validate")
      ? this.options.validation
      : undefined;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    try {
      return await this.once(input);
    } catch (error) {
      // A continued session ran out of context: once more, fresh.
      if (!(error instanceof ResumeOverflow)) throw error;
      return this.once({
        ...input,
        conversation: withoutPrevious(input.conversation),
      });
    }
  }

  private async once(input: WorkerInput): Promise<WorkerResult> {
    const started = Date.now();
    const tools = copilotTools(this.options.tools);
    const record = usageRecord({
      role: "worker",
      provider: "copilot",
      model: this.options.model.model,
      effort: this.options.model.effort,
      item: input.item.id,
    });
    describeRequest(record, {
      prompt: input.prompt,
      ...(input.facts ? { facts: input.facts } : {}),
    });
    let turn: SessionTurn | undefined;
    try {
      turn = copilotTurn(
        input.conversation,
        input.prompt,
        this.options.model.model,
      );
    } catch (error) {
      if (error instanceof PlannerError) return providerOutcome(error);
      throw error;
    }
    if (turn?.resumed) captureRequest(record, turn.prompt);
    /** Running tool calls' names by id, for their completions. */
    const toolNames = new Map<string, string>();
    // Validate, as Claude's (work/self-validate.ts): only declared commands.
    const ended = new AbortController();
    let validator: SelfValidation | undefined;
    if (
      this.options.validation &&
      this.options.tools.includes("Validate") &&
      input.commands.length
    ) {
      const gitlinks = await worktreeGitlinks(input);
      if (typeof gitlinks !== "boolean") return gitlinks;
      if (!gitlinks)
        validator = new SelfValidation(
          input,
          this.options.validation,
          AbortSignal.any([input.signal, ended.signal]),
        );
    }
    try {
      const result = await runTurn({
        choice: this.options.model,
        directory: input.worktree,
        tools,
        writes: true,
        system: validator
          ? `${WORKER_SYSTEM}${VALIDATE_SYSTEM}${selectedMediaNote(input.item)}`
          : WORKER_SYSTEM,
        custom: validator && [
          {
            name: VALIDATION_TOOL_NAME,
            description: validationToolDescription(input.item),
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            defer: "never",
            handler: async () => {
              const run = await validator.call();
              return run.isError
                ? { textResultForLlm: run.text, resultType: "failure" }
                : run.text;
            },
          },
        ],
        prompt: turn?.prompt ?? input.prompt,
        record,
        ...replacing(turn, input.conversation),
        idleMs: this.options.idleMs,
        ...(validator && {
          toolIdleMs: validationDeadlineMs(
            input.item,
            this.options.validation!.commandTimeoutMs,
            this.options.validation!.formatCommand !== undefined,
          ),
        }),
        signal: input.signal,
        onEvent: (event) => {
          input.output(event);
          copilotActivity(input, event, toolNames);
        },
      });
      record.session = result.session;
      captureResponse(record, result.text);
      record.outcome = "finished";
      const tree = await validator?.finalTree();
      if (validator) record.finalTreeValidated = Boolean(tree);
      return {
        kind: "finished",
        finalResponse: result.text,
        ...(tree && { validated: { tree, commands: [...input.commands] } }),
        ...withSession(turn?.end(result.session)),
      };
    } catch (error) {
      if (turn?.resumed && error instanceof PlannerError && error.tooLarge) {
        record.outcome = error.outcome;
        throw new ResumeOverflow();
      }
      if (!(error instanceof PlannerError)) {
        record.outcome = "error";
        record.error = detail(String(error));
        throw error;
      }
      record.outcome = error.outcome;
      record.reason = error.message;
      return providerOutcome(error);
    } finally {
      ended.abort(new Error("the worker attempt ended"));
      await validator?.idle();
      record.ms = Date.now() - started;
      logUsage(input.log, record);
    }
  }
}
