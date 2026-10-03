import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContentStore,
  ExecutionContext,
  ExecutionDriver,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionRequest,
  ExecutionResult,
} from "../contracts.js";
import { SettledAttemptFailure } from "../work-repair.js";
import { submitted } from "./checkpoint.js";
import { readProducedAssets, workItemPrompt } from "./harness-support.js";
import { collectWorktreeResult } from "./local.js";
import {
  importOpenAIResult,
  openAIExportScript,
  OPENAI_OUTPUT_MAX_BYTES,
  prepareOpenAIInput,
  sha256,
} from "./openai-managed-files.js";

export interface OpenAIManagedConfig {
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  containerSize: "small" | "medium" | "large";
  apiKeyEnv: string;
  timeoutSeconds: number;
}
export function validateOpenAIManagedConfig(
  value: unknown,
): OpenAIManagedConfig {
  const v = object(value);
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "model",
          "reasoningEffort",
          "containerSize",
          "apiKeyEnv",
          "timeoutSeconds",
        ].includes(key),
    ) ||
    typeof v.model !== "string" ||
    !v.model.trim() ||
    !["low", "medium", "high"].includes(String(v.reasoningEffort)) ||
    !["small", "medium", "large"].includes(String(v.containerSize)) ||
    typeof v.apiKeyEnv !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/.test(v.apiKeyEnv) ||
    !Number.isSafeInteger(v.timeoutSeconds) ||
    Number(v.timeoutSeconds) <= 0
  )
    throw new Error(
      "OpenAI managed configuration requires explicit model, reasoningEffort, containerSize, apiKeyEnv and positive timeoutSeconds",
    );
  return v as unknown as OpenAIManagedConfig;
}

export interface OpenAIManagedTransport {
  json(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
  content(path: string, timeoutMs?: number): Promise<Response>;
}
/** Fixed official API origin; no mutation retries, credentials remain controller-only. */
export class OpenAIAgentsClient implements OpenAIManagedTransport {
  constructor(
    private keyName: string,
    private fetcher: typeof fetch = fetch,
    private timeoutMs?: number,
    private apiKey?: string,
  ) {}
  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    if (!/^\/agents\//.test(path) || path.includes(".."))
      throw new Error("Invalid Agents API path");
    const key = this.apiKey ?? process.env[this.keyName];
    if (!key)
      throw new Error(
        `OpenAI Agents API requires controller credential ${this.keyName}`,
      );
    return this.fetcher(`https://api.openai.com/v1${path}`, {
      method,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      headers: {
        Authorization: `Bearer ${key}`,
        "OpenAI-Beta": "agents=v1",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async json(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await this.request(method, path, body, timeoutMs);
    if (response.status === 404 && method === "GET") return null;
    if (response.status === 404 && method === "DELETE") return null;
    if (!response.ok)
      throw new Error(
        `Agents API ${method} failed (${response.status}); request ${response.headers.get("x-request-id") ?? "unknown"}; no mutation retried`,
      );
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : null;
  }
  async content(path: string, timeoutMs?: number): Promise<Response> {
    const response = await this.request("GET", path, undefined, timeoutMs);
    if (!response.ok)
      throw new Error(`Agents artifact download failed (${response.status})`);
    return response;
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Agents API object");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid Agents API identity");
  return value;
}
interface Active {
  request: ExecutionRequest;
  root: string;
  inputDigest: string;
  startedAt: number;
  cleanupStartedAt?: number;
  phase:
    | "create-submitted"
    | "prepared"
    | "input-submitted"
    | "input-accepted"
    | "running"
    | "cancel-submitted"
    | "delete-submitted"
    | "disposed";
  sessionId?: string;
  environmentId?: string;
  turnId?: string;
  terminal?: "complete" | "failed" | "cancelled";
  /** The attempt stopped because a step was interrupted, not because the work failed. */
  interrupted?: boolean;
  usage?: unknown;
  result?: ExecutionResult;
  artifact?: { id: string; digest: string; bytes: number; turnId: string };
}
export class OpenAIManagedExecutionDriver implements ExecutionDriver {
  private client: OpenAIManagedTransport;
  constructor(
    private args: {
      checkout: string;
      workRoot: string;
      contentStore: ContentStore;
      config: OpenAIManagedConfig;
      transport?: OpenAIManagedTransport;
      apiKey?: string;
    },
  ) {
    validateOpenAIManagedConfig(args.config);
    this.client =
      args.transport ??
      new OpenAIAgentsClient(
        args.config.apiKeyEnv,
        fetch,
        args.config.timeoutSeconds * 1000,
        args.apiKey,
      );
  }
  async availableSlots(): Promise<"unknown"> {
    return "unknown";
  }
  private active(handle: ExecutionHandle): Active {
    if (
      handle.provider !== "openai-agents" ||
      !/^[A-Za-z0-9_-]+$/.test(handle.identity)
    )
      throw new Error("Unknown OpenAI managed handle");
    const data = object(handle.data) as unknown as Active;
    if (
      data.request?.attemptId !== handle.identity ||
      data.root !== join(this.args.workRoot, handle.identity) ||
      !/^[a-f0-9]{64}$/.test(data.inputDigest)
    )
      throw new Error("OpenAI managed handle binding is invalid");
    return data;
  }
  private save(handle: ExecutionHandle, context?: ExecutionContext): void {
    if (!context)
      throw new Error(
        "Managed execution requires controller checkpoint authority",
      );
    context.checkpoint(handle);
  }
  private remaining(data: Active): number {
    const cleanup =
      data.phase === "cancel-submitted" || data.phase === "delete-submitted";
    const started = cleanup ? data.cleanupStartedAt : data.startedAt;
    const remaining =
      (started ?? data.startedAt) +
      this.args.config.timeoutSeconds * 1000 -
      Date.now();
    if (remaining <= 0)
      throw new Error(
        cleanup
          ? "OpenAI managed cleanup deadline expired; cessation remains unresolved"
          : "OpenAI managed attempt deadline expired; cessation must be confirmed",
      );
    return remaining;
  }
  private async request(
    data: Active,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    return this.client.json(method, path, body, this.remaining(data));
  }
  private async pages(
    data: Active,
    path: string,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const page = object(
        await this.request(
          data,
          "GET",
          `${path}${path.includes("?") ? "&" : "?"}order=asc${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        ),
      );
      if (!Array.isArray(page.data))
        throw new Error("Malformed Agents API page");
      all.push(...page.data.map(object));
      if (!page.has_more) return all;
      after = id(page.last_id);
      if (seen.has(after))
        throw new Error("Agents API pagination did not advance");
      seen.add(after);
    } while (after);
    return all;
  }
  async start(
    input: ExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle> {
    if (!context)
      throw new Error(
        "Managed execution requires controller checkpoint authority",
      );
    const attemptId = input.attemptId ?? randomUUID();
    const root = join(this.args.workRoot, attemptId);
    const prepared = await prepareOpenAIInput({
      checkout: this.args.checkout,
      root,
      request: { ...input, attemptId },
      store: this.args.contentStore,
    });
    const data: Active = {
      request: prepared.request,
      root,
      inputDigest: sha256(prepared.archive),
      startedAt: Date.now(),
      phase: "create-submitted",
    };
    const handle: ExecutionHandle = {
      provider: "openai-agents",
      identity: attemptId,
      data,
    };
    this.save(handle, context);
    // Kept beside the attempt so a restart can still submit the same input.
    writeFileSync(
      join(root, "input-prompt.txt"),
      workItemPrompt(prepared.harnessRequest) +
        "\nExport all completed bytes with python3 /workspace/factory-export.py. Do not encode binary bytes in your answer.",
      { mode: 0o600 },
    );
    const binding = JSON.stringify({
      baseSha: input.baseSha,
      attemptId,
      inputDigest: data.inputDigest,
    });
    const session = object(
      await submitted(
        this.request(data, "POST", "/agents/sessions", {
          agent: {
            model: this.args.config.model,
            reasoning: { effort: this.args.config.reasoningEffort },
            multi_agent: { enabled: false },
            tools: [],
            instructions:
              "Perform only the supplied Work Item in /workspace/repo. Preserve HEAD. Export the finished work by running python3 /workspace/factory-export.py before finishing.",
          },
          environment: {
            type: "openai_hosted",
            container_size: this.args.config.containerSize,
            network: { access: "disabled" },
            files: [
              {
                type: "inline",
                path: "/workspace/input.tar",
                data: prepared.archive.toString("base64"),
              },
              {
                type: "inline",
                path: "/workspace/factory-binding.json",
                data: Buffer.from(binding).toString("base64"),
              },
              {
                type: "inline",
                path: "/workspace/factory-export.py",
                data: Buffer.from(openAIExportScript).toString("base64"),
              },
            ],
            setup_commands: [
              {
                command: `echo '${data.inputDigest}  /workspace/input.tar' | sha256sum -c - && tar -xf /workspace/input.tar -C /workspace && test "$(git -C /workspace/repo rev-parse HEAD)" = '${input.baseSha}'`,
              },
            ],
          },
          metadata: {
            factory_attempt: attemptId,
            factory_input: data.inputDigest,
          },
        }),
      ),
    );
    data.sessionId = id(session.id);
    data.environmentId = id(object(session.environment).id);
    data.phase = "prepared";
    this.save(handle, context);
    await this.submitInput(handle, context);
    return handle;
  }
  /** Waits for hosted setup, then submits the Work Item input once. */
  private async submitInput(
    handle: ExecutionHandle,
    context: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    while (true) {
      const environment = object(
        await this.request(
          data,
          "GET",
          `/agents/environments/${data.environmentId}`,
        ),
      );
      if (environment.status === "connected") break;
      if (environment.status !== "provisioning")
        throw new Error("OpenAI hosted setup did not connect");
      await this.wait(data);
    }
    if (context.cancelled())
      throw new Error("Managed input cancelled before submission");
    this.remaining(data);
    data.phase = "input-submitted";
    this.save(handle, context);
    await submitted(
      this.request(data, "POST", `/agents/sessions/${data.sessionId}/events`, {
        events: [
          {
            type: "agent.session.input.message",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: readFileSync(
                      join(data.root, "input-prompt.txt"),
                      "utf8",
                    ),
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    data.phase = "input-accepted";
    this.save(handle, context);
  }
  private async wait(data: Active): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, this.remaining(data))),
    );
  }

  async observe(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionObservation> {
    const data = this.active(handle);
    if (data.phase === "disposed")
      return {
        state: data.terminal ?? "failed",
        ...(data.interrupted && { interrupted: true }),
      };
    // This API surface cannot list sessions by attempt tag, so a lost create
    // response cannot be resolved; any session it made never received input.
    if (!data.sessionId)
      return {
        state: "failed",
        interrupted: true,
        detail:
          "Managed session creation outcome is unknown; repeating with a fresh attempt",
      };
    if (data.phase === "prepared")
      return { state: "running", detail: "Preparing the managed session" };
    const session = object(
      await this.request(data, "GET", `/agents/sessions/${data.sessionId}`),
    );
    const turns = await this.pages(
      data,
      `/agents/sessions/${data.sessionId}/turns`,
    );
    if (turns.some((turn) => turn.subagent_id != null) || turns.length > 1)
      throw new Error(
        "Managed session has unexpected work outside its owned single turn",
      );
    const turn = turns[0];
    if (!turn) {
      if (data.phase === "cancel-submitted" && session.status === "idle") {
        data.terminal = "cancelled";
        this.save(handle, context);
        return { state: "cancelled" };
      }
      if (session.status === "failed")
        return {
          state: "failed",
          detail: "Managed session failed before a recorded turn",
        };
      // An accepted input always records a turn.
      if (data.phase === "input-submitted")
        return {
          state: "failed",
          interrupted: true,
          detail:
            "Managed Work Item input outcome is unknown; repeating with a fresh attempt",
        };
      return { state: "running" };
    }
    if (turn.session_id !== data.sessionId)
      throw new Error("Managed turn belongs to a different session");
    const turnId = id(turn.id);
    if (data.turnId && data.turnId !== turnId)
      throw new Error("Managed turn identity changed");
    data.turnId = turnId;
    data.usage = turn.usage ?? null;
    const terminal =
      turn.status === "completed"
        ? "complete"
        : turn.status === "failed"
          ? "failed"
          : turn.status === "cancelled"
            ? "cancelled"
            : undefined;
    if (terminal) data.terminal = terminal;
    if (data.phase === "input-accepted" || data.phase === "input-submitted")
      data.phase = "running";
    this.save(handle, context);
    const raw =
      turn.usage && typeof turn.usage === "object"
        ? object(turn.usage)
        : undefined;
    const usage: import("../contracts.js").ModelInvocationUsage = {};
    for (const [wire, key] of [
      ["input_tokens", "inputTokens"],
      ["output_tokens", "outputTokens"],
      ["total_tokens", "totalTokens"],
    ] as const)
      if (raw && Number.isSafeInteger(raw[wire]) && Number(raw[wire]) >= 0)
        usage[key] = Number(raw[wire]);
    context?.observeUsage?.({
      type:
        terminal === "complete"
          ? "completed"
          : terminal
            ? "failed"
            : "progress",
      invocationId: handle.identity,
      providerAttempt: 1,
      role: "worker",
      phase: "implementation",
      provider: "openai-agents",
      model: this.args.config.model,
      ...(Object.keys(usage).length ? { usage } : {}),
    });
    if (
      !terminal &&
      !["queued", "in_progress", "waiting"].includes(String(turn.status))
    )
      throw new Error("Unknown managed turn status");
    return { state: terminal ?? "running" };
  }
  private async dispose(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    data.cleanupStartedAt ??= Date.now();
    if (data.sessionId) {
      data.phase = "delete-submitted";
      this.save(handle, context);
      await this.request(data, "DELETE", `/agents/sessions/${data.sessionId}`);
      if (
        await this.request(
          data,
          "GET",
          `/agents/environments/${data.environmentId}`,
        )
      )
        throw new Error("Managed environment cessation has not been confirmed");
    }
    data.phase = "disposed";
    this.save(handle, context);
  }
  async cancel(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    await this.stop(handle, "cancelled", context);
  }
  /** Stops the owned turn, if any, and deletes the session. */
  private async stop(
    handle: ExecutionHandle,
    terminal: "failed" | "cancelled",
    context?: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    if (data.phase === "disposed") return;
    if (!data.sessionId || data.phase === "prepared" || data.terminal) {
      data.terminal ??= terminal;
      await this.dispose(handle, context);
      return;
    }
    if (
      data.phase !== "cancel-submitted" &&
      data.phase !== "delete-submitted"
    ) {
      data.cleanupStartedAt ??= Date.now();
      data.phase = "cancel-submitted";
      this.save(handle, context);
      await this.request(
        data,
        "POST",
        `/agents/sessions/${data.sessionId}/events`,
        { events: [{ type: "agent.session.input.cancel" }] },
      );
    }
    while (data.phase !== "delete-submitted") {
      const observed = await this.observe(handle, context);
      if (observed.state !== "running") break;
      await this.wait(data);
    }
    data.terminal ??= terminal;
    await this.dispose(handle, context);
  }
  async collect(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionResult> {
    const data = this.active(handle);
    if (data.result) {
      if (data.phase !== "disposed") await this.dispose(handle, context);
      return data.result;
    }
    if (!context)
      throw new Error(
        "Managed execution requires controller checkpoint authority",
      );
    if (data.phase === "prepared") await this.submitInput(handle, context);
    while (true) {
      const observed = await this.observe(handle, context);
      if (observed.state === "complete") break;
      if (observed.state !== "running") {
        // Settle the attempt so a repeat never runs beside this session.
        if (observed.interrupted) data.interrupted = true;
        await this.stop(
          handle,
          observed.state === "cancelled" ? "cancelled" : "failed",
          context,
        );
        throw new SettledAttemptFailure(
          new Error(observed.detail ?? `OpenAI managed turn ${observed.state}`),
          observed.interrupted ? "interruption" : "implementation",
        );
      }
      await this.wait(data);
    }
    const artifacts = await this.pages(
      data,
      `/agents/sessions/${data.sessionId}/artifacts`,
    );
    const matches = artifacts.filter(
      (a) =>
        a.turn_id === data.turnId &&
        a.path === "/workspace/outputs/factory-result.tar",
    );
    if (matches.length !== 1)
      throw new Error("Exact managed result artifact is missing or ambiguous");
    const artifact = matches[0]!;
    if (
      artifact.session_id !== data.sessionId ||
      artifact.environment_id !== data.environmentId ||
      !Number.isSafeInteger(artifact.size_bytes) ||
      Number(artifact.size_bytes) <= 0 ||
      Number(artifact.size_bytes) > OPENAI_OUTPUT_MAX_BYTES
    )
      throw new Error("Managed artifact identity or size is invalid");
    const artifactId = id(artifact.id);
    const response = await this.client.content(
      `/agents/sessions/${data.sessionId}/artifacts/${artifactId}/content`,
      this.remaining(data),
    );
    if (!response.body) throw new Error("Managed artifact response is empty");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > Number(artifact.size_bytes))
        throw new Error("Managed artifact content exceeds declared length");
      chunks.push(Buffer.from(chunk));
    }
    if (size !== artifact.size_bytes)
      throw new Error("Managed artifact content is truncated");
    const bytes = Buffer.concat(chunks);
    const file = join(data.root, "result.tar");
    writeFileSync(file, bytes, { mode: 0o600 });
    data.artifact = {
      id: artifactId,
      digest: sha256(bytes),
      bytes: size,
      turnId: data.turnId!,
    };
    this.save(handle, context);
    const worktree = join(data.root, "result");
    await importOpenAIResult({
      file,
      checkout: this.args.checkout,
      worktree,
      baseSha: data.request.baseSha,
      attemptId: handle.identity,
      inputDigest: data.inputDigest,
    });
    const evidence = {
      harness: "openai-agents",
      sessionId: data.sessionId,
      turnId: data.turnId,
      inputDigest: data.inputDigest,
      artifact: data.artifact,
      usage: data.usage ?? null,
      model: this.args.config.model,
    };
    this.remaining(data);
    data.result = await collectWorktreeResult(
      this.args.checkout,
      worktree,
      data.request,
      this.args.contentStore,
      {
        assets: readProducedAssets({ item: data.request.item, worktree }),
        evidence,
      },
    );
    this.save(handle, context);
    await this.dispose(handle, context);
    return data.result;
  }
}
