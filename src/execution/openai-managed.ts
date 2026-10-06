import { refuseUnknownFields } from "../unknown-fields.js";
import {
  cancelledFault,
  classifyFaults,
  decision,
  StepFault,
} from "../fault.js";
import { executionFault, missingCredential } from "./fault.js";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { hasUnresolvedSubprocesses, removeWorktree } from "../process.js";
import { endAttempt, stoppedFault, transportFailure } from "./attempt.js";
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
  refuseUnknownFields(
    v,
    [
      "model",
      "reasoningEffort",
      "containerSize",
      "apiKeyEnv",
      "timeoutSeconds",
    ],
    "execution.config",
  );
  if (
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
      throw missingCredential(
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
      throw new AgentsApiError(
        `Agents API ${method} failed (${response.status}); request ${response.headers.get("x-request-id") ?? "unknown"}; no mutation retried`,
        response.status,
      );
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : null;
  }
  async content(path: string, timeoutMs?: number): Promise<Response> {
    const response = await this.request("GET", path, undefined, timeoutMs);
    if (!response.ok)
      throw new AgentsApiError(
        `Agents artifact download failed (${response.status})`,
        response.status,
      );
    return response;
  }
}
/** An Agents API response that was not successful; `status` lets callers tell transient failures apart. */
export class AgentsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
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
    | "delete-acknowledged"
    | "disposed";
  sessionId?: string;
  environmentId?: string;
  turnId?: string;
  terminal?: "complete" | "failed" | "cancelled";
  /** Why the attempt was ended; recorded before stopping so a restart finishes it. */
  stopped?: { detail: string; interrupted: boolean };
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
  @classifyFaults(executionFault)
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
  private expired(data: Active): boolean {
    return (
      data.startedAt + this.args.config.timeoutSeconds * 1000 <= Date.now()
    );
  }
  /** Ends the attempt for a failed step; see endAttempt. */
  private async fail(
    error: unknown,
    handle: ExecutionHandle,
    context: ExecutionContext,
  ): Promise<never> {
    return endAttempt(error, {
      expired: this.expired(this.active(handle)),
      cancelled: context.cancelled(),
      settle: (detail) => this.settle(handle, context, detail, false),
    });
  }
  /** Records why the attempt ended before attempting owned cleanup. */
  private async settle(
    handle: ExecutionHandle,
    context: ExecutionContext,
    detail: string,
    interrupted: boolean,
  ): Promise<never> {
    const data = this.active(handle);
    // This API surface cannot find sessions by tag, so a create whose
    // response was lost may have left a session holding the input archive.
    if (!data.stopped && !data.sessionId)
      context.observeOrphan?.({
        resource: "session",
        detail: `Session create for attempt ${handle.identity} has an unknown outcome at ${new Date().toISOString()}; a session with metadata factory_attempt=${handle.identity} may hold the input archive`,
      });
    data.stopped ??= { detail, interrupted };
    this.save(handle, context);
    await this.stop(handle, "failed", context);
    throw stoppedFault(data.stopped.detail, data.stopped.interrupted);
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
  @classifyFaults(executionFault)
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
    try {
      const session = object(
        await this.request(data, "POST", "/agents/sessions", {
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
      );
      data.sessionId = id(session.id);
      data.environmentId = id(object(session.environment).id);
      data.phase = "prepared";
      this.save(handle, context);
      await this.submitInput(handle, context);
    } catch (error) {
      if (
        !context.cancelled() &&
        !this.expired(data) &&
        transportFailure(error)
      ) {
        // A known session's recorded phase is resolved by collection. A lost
        // create cannot be found, so the attempt ends here without a result.
        if (data.sessionId) return handle;
        await this.settle(
          handle,
          context,
          "Managed session creation outcome is unknown",
          true,
        );
      }
      await this.fail(error, handle, context);
    }
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
      throw cancelledFault("Managed input cancelled before submission");
    this.remaining(data);
    data.phase = "input-submitted";
    this.save(handle, context);
    await this.request(
      data,
      "POST",
      `/agents/sessions/${data.sessionId}/events`,
      {
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
      },
    );
    data.phase = "input-accepted";
    this.save(handle, context);
  }
  private async wait(data: Active): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, this.remaining(data))),
    );
  }

  /**
   * Faults are classified once, here at the driver boundary. Collection
   * reads through `observeActive`, so `endAttempt` sees the raw error.
   */
  @classifyFaults(executionFault)
  async observe(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionObservation> {
    return this.observeActive(handle, context);
  }
  private async observeActive(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionObservation> {
    const data = this.active(handle);
    if (data.phase === "disposed" || data.phase === "delete-acknowledged")
      this.physicalCessationUnconfirmed(handle);
    // This API surface cannot list sessions by attempt tag, so a lost create
    // response cannot be resolved; any session it made never received input.
    if (!data.sessionId)
      return {
        state: "failed",
        interrupted: true,
        detail: "Managed session creation outcome is unknown",
      };
    if (data.phase === "prepared")
      return { state: "running", detail: "Preparing the managed session" };
    const current = await this.request(
      data,
      "GET",
      `/agents/sessions/${data.sessionId}`,
    );
    // API disappearance does not establish physical hosted cleanup.
    if (current === null)
      return { state: "failed", detail: "Managed session no longer exists" };
    const session = object(current);
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
  private physicalCessationUnconfirmed(handle: ExecutionHandle): never {
    const data = this.active(handle);
    throw new StepFault(
      decision(
        "How can physical cessation of the owned OpenAI hosted environment be authenticated? This adapter has no authenticated physical-cessation receipt; keep the attempt held.",
        `Attempt ${handle.identity}; session ${data.sessionId ?? "unknown"}; environment ${data.environmentId ?? "unknown"}; cleanup phase ${data.phase}`,
      ),
    );
  }
  private async dispose(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    // Legacy `disposed` checkpoints used API disappearance as their proof.
    // Neither those checkpoints nor a DELETE acknowledgment prove cessation.
    if (data.phase === "disposed" || data.phase === "delete-acknowledged")
      this.physicalCessationUnconfirmed(handle);
    data.cleanupStartedAt ??= Date.now();
    if (data.sessionId) {
      data.phase = "delete-submitted";
      this.save(handle, context);
      await this.request(data, "DELETE", `/agents/sessions/${data.sessionId}`);
      data.phase = "delete-acknowledged";
    }
    this.save(handle, context);
    this.physicalCessationUnconfirmed(handle);
  }
  @classifyFaults(executionFault)
  async cancel(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    await this.stop(handle, "cancelled", context);
  }
  /** Start checkpoints before any provider call: only local input files can exist. */
  @classifyFaults(executionFault)
  async cancelUnrecorded(attemptId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(attemptId))
      throw new Error("Invalid OpenAI managed attempt identity");
    rmSync(join(this.args.workRoot, attemptId), {
      recursive: true,
      force: true,
    });
  }
  /** A session that stopped without a result is stopped again (idempotent) to confirm it. */
  @classifyFaults(executionFault)
  async find(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle | undefined> {
    const data = this.active(handle);
    if (data.result || !data.stopped?.interrupted) return handle;
    await this.stop(handle, "failed", context);
    return undefined;
  }
  /** Stops the owned turn, if any, and deletes the session. */
  private async stop(
    handle: ExecutionHandle,
    terminal: "failed" | "cancelled",
    context?: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    if (data.phase === "disposed" || data.phase === "delete-acknowledged")
      this.physicalCessationUnconfirmed(handle);
    // Each cleanup gets a fresh window, so cleanup resumed after an outage
    // longer than the window still runs.
    data.cleanupStartedAt = Date.now();
    if (!data.sessionId || data.phase === "prepared" || data.terminal) {
      data.terminal ??= terminal;
      await this.dispose(handle, context);
      return;
    }
    if (
      data.phase !== "cancel-submitted" &&
      data.phase !== "delete-submitted"
    ) {
      data.phase = "cancel-submitted";
      this.save(handle, context);
      try {
        await this.request(
          data,
          "POST",
          `/agents/sessions/${data.sessionId}/events`,
          { events: [{ type: "agent.session.input.cancel" }] },
        );
      } catch (error) {
        // The API cannot cancel a missing session; physical cleanup is unknown.
        if (!(error instanceof AgentsApiError && error.status === 404))
          throw error;
        data.phase = "delete-submitted";
      }
    }
    while (data.phase !== "delete-submitted") {
      const observed = await this.observeActive(handle, context);
      if (observed.state !== "running") break;
      await this.wait(data);
    }
    data.terminal ??= terminal;
    await this.dispose(handle, context);
  }
  /**
   * Reattach transient failures; retain the owned attempt and any collected
   * result while physical cleanup cannot be authenticated.
   */
  @classifyFaults(executionFault)
  async collect(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionResult> {
    const data = this.active(handle);
    if (!data.result) {
      if (!context)
        throw new Error(
          "Managed execution requires controller checkpoint authority",
        );
      if (data.stopped)
        await this.settle(
          handle,
          context,
          data.stopped.detail,
          data.stopped.interrupted,
        );
      try {
        data.result = await this.produce(handle, context);
      } catch (error) {
        await this.fail(error, handle, context);
      }
      this.save(handle, context);
    }
    await this.dispose(handle, context);
    return data.result!;
  }
  private async produce(
    handle: ExecutionHandle,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const data = this.active(handle);
    while (true) {
      // Each pass resolves the recorded phase first, so a transport failure
      // leaves collect and the step's repeat resumes here; a lost input is
      // resolved from the turn list.
      if (data.phase === "prepared") await this.submitInput(handle, context);
      const observed = await this.observeActive(handle, context);
      if (observed.state === "complete") break;
      if (observed.state !== "running")
        await this.settle(
          handle,
          context,
          observed.detail ?? `OpenAI managed turn ${observed.state}`,
          observed.interrupted === true,
        );
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
    try {
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
      return await collectWorktreeResult(
        this.args.checkout,
        worktree,
        data.request,
        this.args.contentStore,
        {
          assets: readProducedAssets({ item: data.request.item, worktree }),
          evidence,
        },
      );
    } finally {
      if (!hasUnresolvedSubprocesses())
        await removeWorktree(this.args.checkout, worktree);
    }
  }
}
