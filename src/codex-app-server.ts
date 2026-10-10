import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ThreadEvent, ThreadOptions, Usage } from "@openai/codex-sdk";
import { codexRuntimeDirectory } from "./codex-planning-isolation.js";
import { FACTORY_VERSION } from "./package-metadata.js";
import {
  codexStderrCapture,
  type CodexStderrDiagnostic,
} from "./codex-exec.js";
import {
  subprocessAsync,
  UnsettledSubprocessError,
  type SubprocessInputChannel,
} from "./process.js";

import { assertProviderTurnDeadline } from "./provider-turn.js";

/** Codex-private protocol facts; callers keep native identities in adapter data. */
export interface CodexAppServerCheckpoint {
  threadId?: string;
  turnId?: string;
  dispatch: "intent" | "submitted";
  terminal?: "completed" | "failed" | "interrupted";
}

/** Payload-free observations, not lifecycle, acceptance or billing authority. */
export interface CodexAppServerProgress {
  event: string;
  /** Actual generation/tool activity, not setup or an optional observer event. */
  activity?: true;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  waiting?: "approval" | "user-input";
  usage?: Record<string, number>;
}

export interface CodexAppServerOptions {
  /** Already isolated and authenticated by createCodexHome. */
  env: Record<string, string>;
  options: ThreadOptions;
  signal: AbortSignal;
  /** Generation admission only; read-only reconciliation has its own bound. */
  deadlineAt?: string;
  stderr?: (diagnostic: CodexStderrDiagnostic) => void | Promise<void>;
  redactionValues?: string[];
  /** Optional observation; exceptions never alter protocol work. */
  progress?: (event: CodexAppServerProgress) => void;
}

export interface CodexAppServerTurnOptions extends CodexAppServerOptions {
  prompt: string;
  schema: unknown;
  threadId?: string;
  /** Operational checkpoint; rejection must precede further dispatch. */
  checkpoint?: (ref: CodexAppServerCheckpoint) => void;
  /** Existing native exec projection for shared planning observations. */
  event: (event: ThreadEvent) => void;
}

export interface CodexAppServerTurnSnapshot {
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted" | "inProgress" | "unknown";
  response?: string;
  /** Thread/read does not supply authenticated per-turn accounting. */
  usage?: never;
}

type ObjectValue = Record<string, unknown>;
type RpcId = string | number;
const FRAME_BYTES = 8 * 1024 * 1024;
const RESPONSE_BYTES = 1024 * 1024;
const RECORD_LIMIT = 100_000;
const RPC_TIMEOUT_MS = 30_000;
const ACTIVITY = new Set([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/mcpToolCall/progress",
  "thread/tokenUsage/updated",
  "thread/compacted",
]);

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Codex app-server protocol expected an object");
  return value as ObjectValue;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Codex app-server protocol expected a nonempty string");
  return value;
}

function rpcId(value: unknown): RpcId {
  if (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
    return value;
  throw new Error("Codex app-server protocol has an invalid RPC identity");
}

function counters(value: unknown): Record<string, number> {
  const source = object(value);
  const mapped = {
    input_tokens: "inputTokens",
    cached_input_tokens: "cachedInputTokens",
    cache_write_input_tokens: "cacheWriteInputTokens",
    output_tokens: "outputTokens",
    reasoning_output_tokens: "reasoningOutputTokens",
    total_tokens: "totalTokens",
  };
  return Object.fromEntries(
    Object.entries(mapped).flatMap(([key, native]) => {
      const value = source[native];
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? [[key, value]]
        : [];
    }),
  );
}

function finalMessage(items: Iterable<ObjectValue>): {
  id: string;
  text: string;
} {
  const finals = [],
    unphased = [];
  for (const item of items) {
    if (item.type !== "agentMessage") continue;
    if (
      typeof item.text !== "string" ||
      Buffer.byteLength(item.text) > RESPONSE_BYTES
    )
      throw new Error(
        "Codex app-server final message is invalid or exceeds its byte limit",
      );
    const result = { id: text(item.id), text: item.text };
    if (item.phase === "final_answer") finals.push(result);
    else if (item.phase == null) unphased.push(result);
    else if (item.phase !== "commentary")
      throw new Error(
        "Codex app-server agent message has an unsupported phase",
      );
  }
  const candidates = finals.length ? finals : unphased;
  if (candidates.length !== 1)
    throw new Error(
      "Codex app-server turn lacks one unambiguous final agent message",
    );
  return candidates[0]!;
}

/** Minimal owned stdio client. Native process lifetime remains subprocessAsync's. */
class AppServerClient {
  private channel?: SubprocessInputChannel;
  private nextId = 0;
  private pending = new Map<
    RpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private records = 0;
  private failure?: unknown;
  private failed = false;
  readonly stop = new AbortController();
  notification: (method: string, params: ObjectValue) => void = () => undefined;

  constructor(private readonly args: CodexAppServerOptions) {}

  observe(event: CodexAppServerProgress): void {
    try {
      this.args.progress?.(event);
    } catch {
      /* Observations are optional. */
    }
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = error;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    this.stop.abort(error);
  }

  async send(message: ObjectValue): Promise<void> {
    if (!this.channel) throw new Error("Codex app-server input is not ready");
    const frame = `${JSON.stringify(message)}\n`;
    if (message.method === "turn/start")
      assertProviderTurnDeadline(this.args.deadlineAt);
    await this.channel.write(frame);
  }

  async request(method: string, params: ObjectValue): Promise<unknown> {
    if (this.failed) throw this.failure;
    const id = ++this.nextId;
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          `Codex app-server ${method} acknowledgment timed out`,
        );
        reject(error);
        this.fail(error);
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    // Install the rejection handler before a write can fail.
    void answer.catch(() => undefined);
    try {
      await this.send({ id, method, params });
    } catch (error) {
      this.fail(error);
    }
    return answer;
  }

  chunk(chunk: Buffer): void {
    if (this.failed) return;
    try {
      this.buffer += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > FRAME_BYTES)
        throw new Error(
          "Codex app-server protocol frame exceeds its byte limit",
        );
      for (
        let end = this.buffer.indexOf("\n");
        end >= 0;
        end = this.buffer.indexOf("\n")
      ) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (++this.records > RECORD_LIMIT)
          throw new Error("Codex app-server protocol exceeds its record limit");
        this.message(object(JSON.parse(line)));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private message(message: ObjectValue): void {
    if (typeof message.method === "string") {
      const params = object(message.params ?? {});
      if (message.id !== undefined) {
        const id = rpcId(message.id);
        const method = message.method;
        let result: unknown;
        switch (method) {
          case "item/commandExecution/requestApproval":
          case "item/fileChange/requestApproval":
            result = { decision: "decline" };
            break;
          case "item/permissions/requestApproval":
            result = { permissions: {}, scope: "turn" };
            break;
          case "item/tool/requestUserInput":
            result = { answers: {} };
            break;
          case "item/tool/call":
            result = { contentItems: [], success: false };
            break;
          case "mcpServer/elicitation/request":
            result = { action: "cancel", content: null, _meta: null };
            break;
          default:
            this.observe({ event: "unsupported-client-request" });
            void this.send({
              id,
              error: {
                code: -32601,
                message: "Unsupported Factory client request",
              },
            }).catch((error) => this.fail(error));
            this.fail(
              new Error(
                "Codex app-server requested an unsupported client operation",
              ),
            );
            return;
        }
        this.observe({ event: method });
        void this.send({ id, result }).catch((error) => this.fail(error));
        return;
      }
      this.notification(message.method, params);
      return;
    }
    const id = rpcId(message.id);
    const pending = this.pending.get(id);
    if (!pending)
      throw new Error("Codex app-server returned an unmatched RPC response");
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = object(message.error);
      pending.reject(
        new Error(
          `Codex app-server RPC failed (${String(error.code)}): ${typeof error.message === "string" ? error.message : "unreported error"}`,
        ),
      );
    } else if ("result" in message) pending.resolve(message.result);
    else
      pending.reject(new Error("Codex app-server RPC response lacks a result"));
  }

  async run(
    operation: (
      client: AppServerClient,
      channel: SubprocessInputChannel,
    ) => Promise<void>,
    cancel?: () => void,
  ): Promise<void> {
    const target =
      process.arch === "arm64"
        ? "aarch64-unknown-linux-musl"
        : "x86_64-unknown-linux-musl";
    const root = join(codexRuntimeDirectory(), target);
    const modern = existsSync(join(root, "bin", "codex"));
    const file = join(root, modern ? "bin" : "codex", "codex");
    const path = join(root, modern ? "codex-path" : "path");
    const env: Record<string, string> = {
      ...this.args.env,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_sdk_ts",
    };
    if (existsSync(path)) env.PATH = `${path}${delimiter}${env.PATH ?? ""}`;
    const stderr = this.args.stderr
      ? codexStderrCapture(this.args.stderr, this.args.redactionValues)
      : undefined;
    const command = ["app-server", "--listen", "stdio://"];
    const signal = AbortSignal.any([this.args.signal, this.stop.signal]);
    let operationSettled = false;
    try {
      const result = await subprocessAsync(
        file,
        command,
        { env, signal },
        {
          cancellationGraceMs: 250,
          cancel: () => cancel?.(),
          run: async (channel) => {
            this.channel = channel;
            const closeError = new Error(
              "Codex app-server closed before its operation settled",
            );
            void channel.closed.then(() => {
              if (!operationSettled) this.fail(closeError);
            });
            try {
              channel.signal?.throwIfAborted();
              await this.request("initialize", {
                clientInfo: { name: "factory", version: FACTORY_VERSION },
                capabilities: { experimentalApi: false },
              });
              channel.signal?.throwIfAborted();
              await this.send({ method: "initialized", params: {} });
              await operation(this, channel);
              channel.end();
            } finally {
              operationSettled = true;
            }
          },
        },
        (stream, chunk) => {
          if (stream === "stdout") this.chunk(chunk);
          else stderr?.chunk(chunk);
        },
        undefined,
        { stdout: false, stderr: false },
      );
      if (this.failed) throw this.failure;
      this.buffer += this.decoder.end();
      if (this.buffer.trim())
        throw new Error("Codex app-server protocol ended inside a frame");
      if (result.status !== 0)
        throw new Error(`Codex app-server exited with code ${result.status}`);
    } catch (error) {
      if (error instanceof UnsettledSubprocessError) throw error;
      if (this.args.signal.aborted) throw this.args.signal.reason;
      if (this.failed) throw this.failure;
      throw error;
    } finally {
      for (const call of this.pending.values()) clearTimeout(call.timer);
      this.pending.clear();
      stderr?.finish();
    }
  }
}

function requestedSettings(options: ThreadOptions): ObjectValue {
  if (
    !options.model ||
    !options.workingDirectory ||
    options.approvalPolicy !== "never" ||
    options.sandboxMode !== "read-only"
  )
    throw new Error(
      "Codex app-server planning requires explicit model, cwd, never approvals and read-only sandbox",
    );
  if (
    options.additionalDirectories?.length ||
    options.networkAccessEnabled ||
    options.webSearchEnabled ||
    (options.webSearchMode && options.webSearchMode !== "disabled")
  )
    throw new Error(
      "Codex app-server planning cannot widen its isolated read surface",
    );
  return {
    model: options.model,
    modelProvider: "openai",
    cwd: resolve(options.workingDirectory),
    approvalPolicy: "never",
    sandbox: "read-only",
    config: {
      ...(options.modelReasoningEffort && {
        model_reasoning_effort: options.modelReasoningEffort,
      }),
    },
  };
}

function verifySettings(
  reply: ObjectValue,
  options: ThreadOptions,
): ObjectValue {
  const thread = object(reply.thread);
  if (
    reply.model !== options.model ||
    reply.modelProvider !== "openai" ||
    reply.cwd !== resolve(options.workingDirectory!) ||
    reply.approvalPolicy !== "never" ||
    object(reply.sandbox).type !== "readOnly" ||
    (options.modelReasoningEffort &&
      reply.reasoningEffort !== options.modelReasoningEffort)
  )
    throw new Error(
      "Codex app-server effective thread settings differ from the admitted selection",
    );
  return thread;
}

/** One explicit turn; native completion and owned process cessation precede return. */
export async function runCodexAppServer(
  args: CodexAppServerTurnOptions,
): Promise<void> {
  assertProviderTurnDeadline(args.deadlineAt);
  args.signal.throwIfAborted();
  const settings = requestedSettings(args.options);
  const client = new AppServerClient(args);
  let threadId = args.threadId,
    turnId: string | undefined;
  let dispatch: CodexAppServerCheckpoint["dispatch"] = "intent";
  let terminal: CodexAppServerCheckpoint["terminal"];
  let usage: Record<string, number> | undefined;
  const messages = new Map<string, ObjectValue>();
  const earlyNotifications: { method: string; params: ObjectValue }[] = [];
  let completed = false;
  let resolveTerminal: () => void = () => undefined;
  let rejectTerminal: (error: unknown) => void = () => undefined;
  const finished = new Promise<void>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  void finished.catch(() => undefined);
  const checkpoint = () =>
    args.checkpoint?.({
      ...(threadId && { threadId }),
      ...(turnId && { turnId }),
      dispatch,
      ...(terminal && { terminal }),
    });
  const acceptTurn = (value: unknown) => {
    const turn = object(value),
      id = text(turn.id);
    if (turnId && id !== turnId)
      throw new Error("Codex app-server changed its admitted turn identity");
    turnId = id;
    checkpoint();
    return turn;
  };
  const addMessage = (item: ObjectValue) => {
    if (item.type !== "agentMessage") return;
    const id = text(item.id),
      previous = messages.get(id);
    if (
      previous &&
      (previous.text !== item.text || previous.phase !== item.phase)
    )
      throw new Error("Codex app-server completed message changed its body");
    if (!previous && messages.size >= 32)
      throw new Error("Codex app-server exceeds its completed message limit");
    if (
      typeof item.text !== "string" ||
      Buffer.byteLength(item.text) > RESPONSE_BYTES
    )
      throw new Error(
        "Codex app-server completed message exceeds its byte limit",
      );
    messages.set(id, {
      id,
      type: item.type,
      text: item.text,
      phase: item.phase,
    });
  };
  client.notification = (method, params) => {
    // Thread-global warnings/config notices do not establish generation progress.
    if (!params.threadId) {
      if (
        ["error", "warning", "configWarning", "deprecationNotice"].includes(
          method,
        )
      )
        client.observe({ event: method });
      return;
    }
    if (!threadId) {
      if (earlyNotifications.length >= 128)
        throw new Error(
          "Codex app-server exceeds its pre-binding notification limit",
        );
      earlyNotifications.push({ method, params });
      return;
    }
    if (params.threadId !== threadId)
      throw new Error(
        "Codex app-server event differs from the admitted thread",
      );
    if (params.turnId && turnId && params.turnId !== turnId)
      throw new Error("Codex app-server event differs from the admitted turn");
    const progress: CodexAppServerProgress = {
      event:
        ACTIVITY.has(method) || method === "thread/status/changed"
          ? method
          : "other-native-notification",
      ...(ACTIVITY.has(method) && { activity: true }),
      threadId,
      ...(turnId && { turnId }),
    };
    if (method === "turn/started") {
      acceptTurn(params.turn);
      args.event({ type: "turn.started" });
    } else if (method === "item/started" || method === "item/completed") {
      const item = object(params.item);
      progress.itemId = text(item.id);
      progress.itemType = text(item.type);
      if (method === "item/completed") addMessage(item);
      if (item.type === "commandExecution") {
        const status =
          item.status === "inProgress" ? "in_progress" : item.status;
        if (!["in_progress", "completed", "failed"].includes(String(status)))
          throw new Error("Codex app-server command has invalid status");
        if (typeof item.command !== "string")
          throw new Error("Codex app-server command lacks its body");
        args.event({
          type: method === "item/started" ? "item.started" : "item.completed",
          item: {
            id: text(item.id),
            type: "command_execution",
            command: item.command,
            aggregated_output:
              typeof item.aggregatedOutput === "string"
                ? item.aggregatedOutput
                : "",
            ...(typeof item.exitCode === "number" && {
              exit_code: item.exitCode,
            }),
            status: status as "in_progress" | "completed" | "failed",
          },
        });
      }
    } else if (method === "thread/tokenUsage/updated") {
      usage = counters(object(params.tokenUsage).total);
      progress.usage = usage;
    } else if (method === "thread/status/changed") {
      const status = object(params.status);
      if (status.type === "active" && Array.isArray(status.activeFlags)) {
        if (status.activeFlags.includes("waitingOnApproval"))
          progress.waiting = "approval";
        else if (status.activeFlags.includes("waitingOnUserInput"))
          progress.waiting = "user-input";
      }
    } else if (method === "turn/completed") {
      const turn = acceptTurn(params.turn);
      if (!["completed", "failed", "interrupted"].includes(String(turn.status)))
        throw new Error("Codex app-server completion has a nonterminal status");
      terminal = turn.status as CodexAppServerCheckpoint["terminal"];
      checkpoint();
      completed = true;
      if (Array.isArray(turn.items))
        for (const item of turn.items) addMessage(object(item));
      if (terminal === "completed") {
        const response = finalMessage(messages.values());
        args.event({
          type: "item.completed",
          item: { type: "agent_message", ...response },
        });
        // Preserve absent counters; never invent zero usage for an unreported turn.
        args.event({ type: "turn.completed", usage: (usage ?? {}) as Usage });
        resolveTerminal();
      } else {
        const error = turn.error == null ? undefined : object(turn.error);
        args.event({
          type: "turn.failed",
          error: {
            message:
              typeof error?.message === "string"
                ? error.message
                : `Codex native turn ${terminal}`,
          },
        });
        rejectTerminal(new Error(`Codex native turn ${terminal}`));
      }
    }
    client.observe(progress);
  };
  const stop = () => {
    if (threadId && turnId && !completed)
      void client
        .request("turn/interrupt", { threadId, turnId })
        .catch(() => undefined);
  };
  try {
    await client.run(async (rpc, channel) => {
      const response = object(
        await rpc.request(args.threadId ? "thread/resume" : "thread/start", {
          ...settings,
          ...(args.threadId
            ? { threadId: args.threadId, excludeTurns: true }
            : { ephemeral: false }),
        }),
      );
      const thread = verifySettings(response, args.options);
      const id = text(thread.id);
      if (threadId && threadId !== id)
        throw new Error("Codex app-server resumed another thread");
      threadId = id;
      checkpoint();
      args.event({ type: "thread.started", thread_id: id });
      for (const event of earlyNotifications.splice(0))
        client.notification(event.method, event.params);
      assertProviderTurnDeadline(args.deadlineAt);
      channel.signal?.throwIfAborted();
      const status = object(thread.status);
      if (status.type === "active")
        throw new Error(
          "Codex app-server cannot dispatch into an already active thread",
        );
      dispatch = "submitted";
      checkpoint();
      const turn = object(
        await rpc.request("turn/start", {
          threadId: id,
          input: [{ type: "text", text: args.prompt, text_elements: [] }],
          cwd: args.options.workingDirectory,
          approvalPolicy: "never",
          model: args.options.model,
          effort: args.options.modelReasoningEffort,
          outputSchema: args.schema,
        }),
      );
      acceptTurn(turn.turn);
      await Promise.race([
        finished,
        channel.closed.then(() => {
          throw new Error(
            "Codex app-server exited without authenticated turn completion",
          );
        }),
      ]);
    }, stop);
  } finally {
    // No hidden replay or automatic follow-up. Every failure remains its original attempt.
    rejectTerminal(new Error("Codex app-server invocation settled"));
  }
}

/** Read a recorded exact turn; this never starts/resumes a thread or creates a turn. */
export async function readCodexAppServerTurn(
  args: CodexAppServerOptions & { threadId: string; turnId: string },
): Promise<CodexAppServerTurnSnapshot> {
  args.signal.throwIfAborted();
  const snapshot: CodexAppServerTurnSnapshot = {
    threadId: args.threadId,
    turnId: args.turnId,
    status: "unknown",
  };
  const client = new AppServerClient(args);
  await client.run(async (rpc) => {
    const result = object(
      await rpc.request("thread/read", {
        threadId: args.threadId,
        includeTurns: true,
      }),
    );
    const thread = object(result.thread);
    if (thread.id !== args.threadId)
      throw new Error("Codex app-server read another thread");
    if (!Array.isArray(thread.turns)) return;
    const turns = thread.turns
      .map(object)
      .filter((turn) => turn.id === args.turnId);
    if (turns.length !== 1) return;
    const turn = turns[0]!;
    if (
      !["completed", "failed", "interrupted", "inProgress"].includes(
        String(turn.status),
      )
    )
      return;
    snapshot.status = turn.status as CodexAppServerTurnSnapshot["status"];
    if (
      snapshot.status === "completed" &&
      turn.itemsView === "full" &&
      Array.isArray(turn.items)
    ) {
      const messages = new Map<string, ObjectValue>();
      for (const value of turn.items) {
        const item = object(value);
        if (item.type === "agentMessage") messages.set(text(item.id), item);
      }
      snapshot.response = finalMessage(messages.values()).text;
    }
  });
  return snapshot;
}
