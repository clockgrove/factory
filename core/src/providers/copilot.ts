/**
 * GitHub Copilot through the Copilot SDK and the operator's Copilot login
 * (`copilot` login or gh CLI auth): a Planner for plan and review calls, and
 * a Worker for the work step. The model gets file tools only, no shell, and
 * every read or write is checked to stay inside its directory. Copilot
 * shell, web, GitHub, MCP, plugins and configuration discovery are off.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  SessionEvent,
} from "@github/copilot-sdk";
import { errorMessage } from "../text.js";
import type { Worker, WorkerInput, WorkerResult } from "../work/worker.js";
import { workerEnvironment } from "../worktree.js";
import { pathInsideRoot } from "./claude-worker.js";
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
  providerOutcome,
} from "./planner.js";

export const DEFAULT_COPILOT_MODELS: PlannerModels = {
  planner: { model: "gpt-6.1-sol", effort: "high" },
  reviewer: { model: "gpt-6.1-sol", effort: "medium" },
};

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
    undefined,
    listed ? ["retry", "switch", "cancel"] : ["switch", "cancel"],
  );
}

const WORKER_SYSTEM =
  "You are an implementation worker controlled by Factory. Work only in the current working directory and only on paths owned by the Work Item. Do not commit, push, publish, open or edit issues or pull requests, access GitHub tools, deploy, or change the current Git HEAD. You have file tools and no shell; Factory validates your result after you finish. Return a concise description and stop when complete or safely blocked.";

/** One Copilot turn: a fresh session, one prompt, its events until idle. */
interface Turn {
  choice: ModelChoice;
  /** The session's working directory; every permitted path stays inside it. */
  directory: string;
  /** Built-in tools, as the SDK names them. */
  tools: string[];
  writes: boolean;
  system?: string;
  prompt: string;
  images?: string[];
  idleMs: number;
  signal: AbortSignal;
  onEvent(event: SessionEvent): void;
}

interface TurnResult {
  text: string;
  usage: { input: number; output: number; cached: number };
  session: string;
}

/** Copilot login values the runtime may see, beside a worker's environment. */
const COPILOT_LOGIN = ["COPILOT_HOME", "COPILOT_GITHUB_TOKEN"];

/**
 * The Copilot runtime's environment: a worker's (worktree.ts
 * workerEnvironment, nothing of GitHub, Git or SSH, no API keys, no
 * COPILOT_ALLOW_ALL) plus Copilot's own login: its home, its token, and
 * the gh CLI's configuration, which holds the login when Copilot signs in
 * through gh. The model has no shell, so these stay with the runtime.
 */
function copilotEnvironment(): Record<string, string> {
  const gh =
    process.env.GH_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");
  return workerEnvironment(gh, COPILOT_LOGIN);
}

/** The SDK names grep `rg`. */
export function copilotTools(tools: readonly string[]): string[] {
  return tools.map((name) => (name === "grep" ? "rg" : name));
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
        // say: Factory asks whether to wait or switch (CORE.md#Waits).
        new PlannerError("retry", `Copilot quota: ${shown}`, undefined, {
          kind: "reset",
          provider: "copilot",
        });
  if (data.errorType === "rate_limit")
    return data.errorCode === "user_weekly_rate_limited"
      ? new PlannerError("retry", `Copilot weekly limit: ${shown}`, undefined, {
          kind: "reset",
          provider: "copilot",
        })
      : // A short rate limit is an unknown transient cause: back off.
        new PlannerError("retry", `Copilot rate limit: ${shown}`);
  if (data.errorType === "context_limit")
    return new PlannerError(
      "fail",
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
  const watchdog = new IdleWatchdog(turn.idleMs, turn.signal);
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
      applicationVersion: "core",
      integrationName: "factory-core",
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

    const usage = { input: 0, output: 0, cached: 0 };
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
    const permit = (request: PermissionRequest) => {
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
    session = await watchdog.race(
      client.createSession({
        clientName: "factory",
        model: turn.choice.model,
        reasoningEffort: turn.choice.effort as never,
        ...(turn.system
          ? { systemMessage: { mode: "append", content: turn.system } }
          : {}),
        availableTools: turn.tools.map((name) => `builtin:${name}`),
        onPermissionRequest: permit,
        onEvent: (event: SessionEvent) => {
          turn.onEvent(event);
          watchdog.progress(event.type);
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
          if (event.type === "assistant.usage") {
            usage.input += event.data.inputTokens ?? 0;
            usage.output += event.data.outputTokens ?? 0;
            usage.cached += event.data.cacheReadTokens ?? 0;
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
    sent = true;
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
      await bounded(client.deleteSession(session.sessionId));
    }
    await bounded(client.stop());
    await bounded(client.forceStop());
  }
}

/** Planning and review through Copilot, with read-only tools over `readDir`. */
export class CopilotPlanner implements Planner {
  constructor(
    private readonly models: PlannerModels = DEFAULT_COPILOT_MODELS,
  ) {}

  answer(call: PlannerCall): Promise<PlannerAnswer> {
    const choice = modelChoice(this.models, call);
    return loggedCall("copilot", call, choice, async (record) => {
      const started = Date.now();
      const images = callImages(call);
      // Without a tree the session gets an empty directory and no tools.
      const empty = call.readDir
        ? undefined
        : mkdtempSync(join(tmpdir(), "factory-copilot-"));
      try {
        const result = await runTurn({
          choice,
          directory: call.readDir ?? empty!,
          tools: call.readDir ? READ_TOOLS : [],
          writes: false,
          prompt: `${call.prompt}\n\nAnswer with only one JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(call.schema)}`,
          images,
          idleMs: PLANNER_IDLE_MS,
          signal: call.signal,
          onEvent: (event) => {
            call.activity?.();
            call.log({
              event: "copilot-event",
              type: event.type,
              ms: Date.now() - started,
            });
          },
        });
        record.session = result.session;
        record.usage = result.usage;
        const body = result.text
          .trim()
          .replace(/^```(?:json)?\s*/, "")
          .replace(/\s*```$/, "");
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
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
        };
      } finally {
        if (empty) rmSync(empty, { recursive: true, force: true });
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
}

/** Implementation turns through Copilot with file tools inside the worktree. */
export class CopilotWorker implements Worker {
  constructor(private readonly options: CopilotWorkerOptions) {}

  async run(input: WorkerInput): Promise<WorkerResult> {
    const started = Date.now();
    // A discovery item reads only: Factory grants no writes, so it's enforced.
    const readOnly = input.item.kind === "discovery";
    const tools = copilotTools(this.options.tools).filter(
      (tool) => !readOnly || READ_TOOLS.includes(tool),
    );
    const record: Record<string, unknown> = {
      event: "worker-call",
      provider: "copilot",
      item: input.item.id,
      model: this.options.model.model,
      effort: this.options.model.effort,
    };
    try {
      const result = await runTurn({
        choice: this.options.model,
        directory: input.worktree,
        tools,
        writes: !readOnly,
        system: WORKER_SYSTEM,
        prompt: input.prompt,
        idleMs: this.options.idleMs,
        signal: input.signal,
        onEvent: (event) => {
          if (event.type === "tool.execution_start")
            input.log({
              event: "worker-tool",
              item: input.item.id,
              tool: event.data.toolName,
            });
        },
      });
      record.session = result.session;
      record.usage = result.usage;
      record.outcome = "finished";
      return { kind: "finished", finalResponse: result.text };
    } catch (error) {
      if (!(error instanceof PlannerError)) {
        record.outcome = "error";
        record.error = detail(String(error));
        throw error;
      }
      record.outcome = error.outcome;
      record.reason = error.message;
      return providerOutcome(error);
    } finally {
      record.ms = Date.now() - started;
      input.log(record);
    }
  }
}
