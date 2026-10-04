import { classifyFaults } from "../fault.js";
import { executionFault } from "./fault.js";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  ContentStore,
  ExecutionContext,
  ExecutionDriver,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionRequest,
  ExecutionResult,
  ModelInvocationUsage,
} from "../contracts.js";
import {
  addWorktree,
  hasUnresolvedSubprocesses,
  removeWorktree,
} from "../process.js";
import {
  cancelledFault,
  endAttempt,
  stoppedFault,
  transportFailure,
} from "./attempt.js";
import { collectWorktreeResult } from "./local.js";
import { readProducedAssets, workItemPrompt } from "./harness-support.js";
import {
  ClaudeManagedClient,
  claudeGone,
  validateClaudeManagedConfig,
  type ClaudeManagedConfig,
} from "./claude-managed-client.js";
import {
  CLAUDE_BOOTSTRAP_SCRIPT,
  prepareClaudeInput,
  type ClaudePreparedInput,
} from "./claude-managed-input.js";
import { verifyClaudeBootstrap } from "./claude-managed-bootstrap.js";
import { claudeTurnDisposition } from "./claude-managed-events.js";
import {
  CLAUDE_EXPORT_SCRIPT,
  claudeByteDigest,
  materializeClaudeSnapshot,
  parseClaudeResultSnapshot,
} from "./claude-managed-transfer.js";
import type {
  BetaManagedAgentsSession,
  SessionCreateParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
export { validateClaudeManagedConfig } from "./claude-managed-client.js";

const workspace = "/mnt/session/factory-work";
const uploads = "/mnt/session/uploads";
const outputs = "/mnt/session/outputs";
const inputs = [
  "factory-input.json",
  "factory-bootstrap.mjs",
  "factory-export.mjs",
  "factory-binding.json",
];
/** Session lookup starts this far before the local create time to absorb clock skew. */
const clockSkewMs = 10 * 60_000;
/**
 * A "-submitted" phase means the request may or may not have reached the
 * provider. Observation resolves it from the session list or history: the
 * work continues, the request is sent again, or the attempt is interrupted.
 */
type Phase =
  | "prepared"
  | "create-submitted"
  | "created"
  | "bootstrap-submitted"
  | "bootstrap-running"
  | "bootstrap-verified"
  | "implementation-submitted"
  | "running"
  | "result-ready"
  | "disposed";
interface Active {
  root: string;
  request: ExecutionRequest;
  inputDigest: string;
  treeSha: string;
  startedAt: number;
  cleanupStartedAt?: number;
  phase: Phase;
  files: { id: string; name: string }[];
  deletedFiles: string[];
  /** Lower bound for finding sessions tagged with this attempt. */
  createdAfter?: string;
  sessionId?: string;
  bootstrapEventId?: string;
  implementationEventId?: string;
  interruptEventId?: string;
  bootstrap?: ReturnType<typeof verifyClaudeBootstrap>;
  resourcesDigest?: string;
  artifact?: {
    fileId: string;
    sha256: string;
    bytes: number;
    inputEventId: string;
    endEventId: string;
  };
  evidenceDigest?: string;
  terminal?: "complete" | "failed" | "cancelled";
  /** Why the attempt was ended; recorded before stopping so a restart finishes it. */
  stopped?: { detail: string; interrupted: boolean };
  result?: ExecutionResult;
}
const digest = (value: unknown) =>
  claudeByteDigest(Buffer.from(JSON.stringify(value)));
const historyDigest = (events: BetaManagedAgentsSessionEvent[]) =>
  digest(events.filter((event) => event.type !== "session.usage"));
const messageText = (event: BetaManagedAgentsSessionEvent) =>
  event.type === "user.message"
    ? event.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
    : undefined;
const interrupted = (detail: string): ExecutionObservation => ({
  state: "failed",
  interrupted: true,
  detail: `${detail}; repeating with a fresh attempt`,
});

/** Provider semantics are implemented here; live proof remains the separate #259 qualification. */
export class ClaudeManagedExecutionDriver implements ExecutionDriver {
  private readonly client: ClaudeManagedClient;
  constructor(
    private readonly args: {
      checkout: string;
      workRoot: string;
      contentStore: ContentStore;
      config: ClaudeManagedConfig;
      client?: ClaudeManagedClient;
      apiKey?: string;
    },
  ) {
    validateClaudeManagedConfig(args.config);
    this.client =
      args.client ??
      new ClaudeManagedClient(args.config, { apiKey: args.apiKey });
  }
  @classifyFaults(executionFault)
  async availableSlots(): Promise<"unknown"> {
    return "unknown";
  }
  private active(handle: ExecutionHandle): Active {
    const data = handle.data as Active;
    if (
      handle.provider !== "claude-managed-agents" ||
      !/^[A-Za-z0-9_-]+$/.test(handle.identity) ||
      !data ||
      data.request?.attemptId !== handle.identity ||
      data.root !== join(this.args.workRoot, handle.identity) ||
      !/^[a-f0-9]{64}$/.test(data.inputDigest)
    )
      throw new Error("Invalid Claude managed attempt binding");
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
    const ms =
      (data.cleanupStartedAt ?? data.startedAt) +
      (this.args.config.timeoutSeconds ?? 900) * 1000 -
      Date.now();
    if (ms <= 0)
      throw new Error(
        "Claude managed deadline expired; owned resources remain unresolved",
      );
    return ms;
  }
  private expired(data: Active): boolean {
    return (
      data.startedAt + (this.args.config.timeoutSeconds ?? 900) * 1000 <=
      Date.now()
    );
  }
  /** Ends the attempt for a failed step; see endAttempt. */
  private async fail(
    error: unknown,
    handle: ExecutionHandle,
    context: ExecutionContext,
  ): Promise<never> {
    const data = this.active(handle);
    return endAttempt(error, {
      expired: this.expired(data),
      cancelled: context.cancelled(),
      // The provider no longer has the session: its worker is gone with it,
      // so the attempt ended without a result rather than with a wrong one.
      settle: (detail) =>
        this.settle(handle, context, detail, claudeGone(error)),
    });
  }
  /** Records why the attempt ended, stops its session and reports a settled failure. */
  private async settle(
    handle: ExecutionHandle,
    context: ExecutionContext,
    detail: string,
    interrupted: boolean,
  ): Promise<never> {
    const data = this.active(handle);
    data.stopped ??= { detail, interrupted };
    this.save(handle, context);
    await this.stop(handle, "failed", context);
    throw stoppedFault(data.stopped.detail, data.stopped.interrupted);
  }
  private async wait(data: Active): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, this.remaining(data))),
    );
  }
  private command(data: Active): string {
    return `node ${uploads}/factory-bootstrap.mjs ${uploads}/factory-input.json ${workspace} ${outputs}/factory-bootstrap.json ${data.inputDigest}`;
  }
  private bootstrapText(data: Active): string {
    return `Prepare the supplied immutable input only. Execute exactly this foreground command once, then stop. Do not run other commands or implement changes.\n${this.command(data)}`;
  }
  private implementationText(data: Active): string {
    const sources = data.request.sourceAssets ?? [];
    let privateIndex = 0;
    const prompt = workItemPrompt({
      ...data.request,
      worktree: workspace,
      sourceAssets: sources.map((source) => ({
        ...source,
        ...((source.binding.kind === "local" ||
          source.binding.kind === "github-attachment") && {
          path: `${workspace}/.factory-inputs/source-${privateIndex++}`,
        }),
      })),
      selectedAssets: (data.request.selectedAssets ?? []).map(
        (asset, index) => ({
          ...asset,
          path: `${workspace}/.factory-inputs/selected-${index}`,
        }),
      ),
    });
    return `${prompt}\nWork in ${workspace}. When complete, export exact bytes using: cd ${workspace} && node ${uploads}/factory-export.mjs ${uploads}/factory-binding.json ${outputs}/factory-result.json . Do not encode binary bytes in your answer.`;
  }
  private snapshot(data: Active): Pick<
    ClaudePreparedInput,
    "digest" | "treeSha" | "files"
  > & {
    baseSha: string;
  } {
    const bytes = readFileSync(join(data.root, "factory-input.json"));
    if (claudeByteDigest(bytes) !== data.inputDigest)
      throw new Error("Pinned Claude input changed locally");
    const input = JSON.parse(bytes.toString("utf8"));
    return {
      digest: data.inputDigest,
      treeSha: data.treeSha,
      baseSha: data.request.baseSha,
      files: input.files
        .filter((file: { path: string }) => !file.path.startsWith(".git/"))
        .map(({ content: _content, ...file }: { content: string }) => file),
    };
  }
  private assertSession(
    session: BetaManagedAgentsSession,
    handle: ExecutionHandle,
  ): void {
    const data = this.active(handle);
    if (session.id !== data.sessionId)
      throw new Error("Claude returned a different owned session");
    this.client.assertSession(session, handle.identity);
    if (
      data.resourcesDigest &&
      digest(session.resources) !== data.resourcesDigest
    )
      throw new Error("Claude session resources changed after binding");
  }
  private usage(
    session: BetaManagedAgentsSession,
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): void {
    const usage: ModelInvocationUsage = {};
    for (const [wire, key] of [
      ["input_tokens", "inputTokens"],
      ["output_tokens", "outputTokens"],
      ["cache_read_input_tokens", "cachedInputTokens"],
    ] as const) {
      const value = session.usage?.[wire];
      if (Number.isSafeInteger(value) && Number(value) >= 0) usage[key] = value;
    }
    context?.observeUsage?.({
      type: "progress",
      invocationId: handle.identity,
      providerAttempt: 1,
      role: "worker",
      phase: "implementation",
      provider: "claude-managed-agents",
      model: this.args.config.agent.model.id,
      ...(Object.keys(usage).length && { usage }),
    });
  }
  private preserve(
    data: Active,
    session: BetaManagedAgentsSession,
    events: BetaManagedAgentsSessionEvent[],
  ): void {
    // Compact lifecycle/usage evidence; private prompts and tool outputs are not diagnostic defaults.
    const bytes = Buffer.from(
      JSON.stringify({
        sessionId: session.id,
        status: session.status,
        agentDigest: digest(session.agent),
        environmentId: session.environment_id,
        usage: session.usage ?? null,
        budget: session.budget,
        historyDigest: digest(events),
        events: events.map((event) => ({
          id: event.id,
          type: event.type,
          processed_at: event.processed_at ?? null,
          ...(event.type === "session.status_idle" && {
            stop_reason: event.stop_reason,
          }),
          ...(event.type === "agent.tool_use" && { name: event.name }),
          ...(event.type === "agent.tool_result" && {
            tool_use_id: event.tool_use_id,
            is_error: event.is_error ?? false,
          }),
        })),
      }),
    );
    writeFileSync(join(data.root, "provider-evidence.json"), bytes, {
      mode: 0o600,
    });
    data.evidenceDigest = claudeByteDigest(bytes);
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
    if (!/^[A-Za-z0-9_-]+$/.test(attemptId))
      throw new Error("Invalid Claude managed attempt identity");
    mkdirSync(this.args.workRoot, { recursive: true, mode: 0o700 });
    const root = join(this.args.workRoot, attemptId);
    const prepared = await prepareClaudeInput(
      this.args.checkout,
      root,
      { ...input, attemptId },
      this.args.contentStore,
    );
    const data: Active = {
      root,
      request: prepared.request,
      inputDigest: prepared.digest,
      treeSha: prepared.treeSha,
      startedAt: Date.now(),
      phase: "prepared",
      files: [],
      deletedFiles: [],
    };
    const handle: ExecutionHandle = {
      provider: "claude-managed-agents",
      identity: attemptId,
      data,
    };
    this.save(handle, context);
    writeFileSync(
      join(root, "factory-bootstrap.mjs"),
      CLAUDE_BOOTSTRAP_SCRIPT,
      { mode: 0o600 },
    );
    writeFileSync(join(root, "factory-export.mjs"), CLAUDE_EXPORT_SCRIPT, {
      mode: 0o600,
    });
    writeFileSync(
      join(root, "factory-binding.json"),
      JSON.stringify({
        attemptId,
        baseSha: input.baseSha,
        inputDigest: data.inputDigest,
      }),
      { mode: 0o600 },
    );
    try {
      await this.advance(handle, context);
    } catch (error) {
      // A transient failure leaves a recorded phase that collection resolves.
      if (context.cancelled() || this.expired(data) || !transportFailure(error))
        await this.fail(error, handle, context);
    }
    return handle;
  }
  /** Uploads inputs, creates the session and sends the bootstrap turn, resuming from the recorded phase. */
  private async advance(
    handle: ExecutionHandle,
    context: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    if (data.phase === "prepared") {
      await this.client.verifyEnvironment(this.remaining(data));
      for (const name of inputs) {
        if (data.files.some((file) => file.name === name)) continue;
        if (context.cancelled())
          throw cancelledFault("Claude preparation cancelled before upload");
        // An upload whose response was lost may leave an unreferenced file
        // that cannot be found; it is recorded for operator cleanup.
        const file = await this.client
          .upload(join(data.root, name), this.remaining(data))
          .catch((error: unknown) => {
            if (transportFailure(error))
              context.observeOrphan?.({
                resource: "file",
                detail: `Upload of ${name} for attempt ${handle.identity} lost its response at ${new Date().toISOString()}; the provider may hold an unreferenced copy`,
              });
            throw error;
          });
        if (!file.id) throw new Error("Claude upload returned no identity");
        data.files.push({ id: file.id, name });
        this.save(handle, context);
      }
      if (context.cancelled())
        throw cancelledFault(
          "Claude preparation cancelled before session creation",
        );
      data.createdAfter ??= new Date(Date.now() - clockSkewMs).toISOString();
      data.phase = "create-submitted";
      this.save(handle, context);
      const resources: NonNullable<SessionCreateParams["resources"]> =
        data.files.map((file) => ({
          type: "file",
          file_id: file.id,
          mount_path: `${uploads}/${file.name}`,
        }));
      const session = await this.client.create(
        handle.identity,
        resources,
        this.remaining(data),
      );
      data.sessionId = session.id;
      data.phase = "created";
      this.save(handle, context);
    }
    if (data.phase !== "created") return;
    const session = await this.client.retrieve(
      data.sessionId!,
      this.remaining(data),
    );
    this.assertSession(session, handle);
    if (
      session.status !== "idle" ||
      session.resources.length !== data.files.length ||
      data.files.some(
        (file) =>
          session.resources.filter(
            (resource) =>
              resource.type === "file" &&
              resource.file_id === file.id &&
              resource.mount_path === `${uploads}/${file.name}`,
          ).length !== 1,
      )
    )
      throw new Error(
        "Claude session did not start as an idle bound allocation",
      );
    data.resourcesDigest = digest(session.resources);
    this.save(handle, context);
    if (context.cancelled())
      throw cancelledFault("Claude input cancelled before bootstrap");
    data.phase = "bootstrap-submitted";
    this.save(handle, context);
    const sent = await this.client.send(
      session.id,
      {
        type: "user.message",
        content: [{ type: "text", text: this.bootstrapText(data) }],
      },
      this.remaining(data),
    );
    const event = sent.data?.[0];
    if (sent.data?.length !== 1 || event?.type !== "user.message")
      throw new Error(
        "Claude bootstrap submission acknowledgement is ambiguous",
      );
    data.bootstrapEventId = event.id;
    data.phase = "bootstrap-running";
    this.save(handle, context);
  }
  private async file(
    data: Active,
    name: string,
  ): Promise<{ bytes: Buffer; id: string } | undefined> {
    const files = (
      await this.client.files(data.sessionId!, this.remaining(data))
    ).filter((file) => file.filename === name);
    if (!files.length) return undefined;
    const file = files[0];
    if (
      files.length !== 1 ||
      !file ||
      file.scope?.type !== "session" ||
      file.scope.id !== data.sessionId ||
      file.downloadable !== true ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0
    )
      throw new Error("Claude output scope or identity is ambiguous");
    const response = await this.client.download(file.id, this.remaining(data));
    if (!response.body) throw new Error("Claude output download has no body");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      this.remaining(data);
      size += chunk.length;
      if (size > file.size_bytes)
        throw new Error("Claude result exceeds its declared size");
      chunks.push(Buffer.from(chunk));
    }
    if (size !== file.size_bytes)
      throw new Error("Claude result download is truncated");
    return { bytes: Buffer.concat(chunks), id: file.id };
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
    if (data.phase === "disposed")
      return {
        state: data.terminal ?? "cancelled",
        ...(data.stopped && {
          detail: data.stopped.detail,
          ...(data.stopped.interrupted && { interrupted: true }),
        }),
      };
    if (data.phase === "result-ready") return { state: "complete" };
    if (data.phase === "create-submitted") {
      const found = await this.client.findSessions(
        handle.identity,
        data.createdAfter!,
        this.remaining(data),
      );
      if (found.length > 1)
        return interrupted("Several sessions carry this attempt's tag");
      if (found[0]) {
        data.sessionId = found[0].id;
        data.phase = "created";
      } else data.phase = "prepared";
      this.save(handle, context);
    }
    if (data.phase === "prepared" || data.phase === "created")
      return { state: "running", detail: "Preparing the managed session" };
    const session = await this.client.retrieve(
      data.sessionId!,
      this.remaining(data),
    );
    this.assertSession(session, handle);
    this.usage(session, handle, context);
    const events = await this.client.events(
      data.sessionId!,
      this.remaining(data),
    );
    this.preserve(data, session, events);
    this.save(handle, context);
    if (data.phase === "bootstrap-submitted") {
      const sent = events.filter((event) => event.type === "user.message");
      if (
        sent.length === 1 &&
        messageText(sent[0]!) === this.bootstrapText(data)
      ) {
        data.bootstrapEventId = sent[0]!.id;
        data.phase = "bootstrap-running";
      } else if (!sent.length && session.status === "idle")
        data.phase = "created";
      else return interrupted("Bootstrap submission outcome is unknown");
      this.save(handle, context);
      if (data.phase === "created") return { state: "running" };
    }
    if (data.phase === "implementation-submitted") {
      const sent = events.filter(
        (event) =>
          event.type === "user.message" && event.id !== data.bootstrapEventId,
      );
      if (
        sent.length === 1 &&
        messageText(sent[0]!) === this.implementationText(data)
      ) {
        data.implementationEventId = sent[0]!.id;
        data.phase = "running";
      } else if (
        !sent.length &&
        session.status === "idle" &&
        historyDigest(events) === data.bootstrap?.historyDigest
      )
        data.phase = "bootstrap-verified";
      else return interrupted("Implementation submission outcome is unknown");
      this.save(handle, context);
      if (data.phase === "bootstrap-verified") return { state: "running" };
    }
    if (
      data.phase === "bootstrap-running" ||
      data.phase === "bootstrap-verified"
    ) {
      if (!data.bootstrapEventId)
        throw new Error("Missing Claude bootstrap identity");
      const turn = claudeTurnDisposition(events, {
        inputEventId: data.bootstrapEventId,
      });
      if (turn.state === "running") return { state: "running" };
      if (turn.state !== "output-pending")
        return {
          state: "failed",
          detail:
            turn.state === "failed"
              ? turn.detail
              : "Claude bootstrap was interrupted",
        };
      const output = await this.file(data, "factory-bootstrap.json");
      if (!output)
        return {
          state: "running",
          detail: "Awaiting bootstrap output publication",
        };
      const proof = verifyClaudeBootstrap(
        events,
        data.bootstrapEventId,
        this.command(data),
        output.bytes,
        this.snapshot(data),
      );
      proof.historyDigest = historyDigest(events);
      data.bootstrap = proof;
      data.phase = "bootstrap-verified";
      this.save(handle, context);
      return { state: "running" };
    }
    if (!data.implementationEventId)
      throw new Error("Missing Claude implementation identity");
    const turn = claudeTurnDisposition(events, {
      inputEventId: data.implementationEventId,
      ...(data.interruptEventId && { interruptEventId: data.interruptEventId }),
    });
    if (turn.state === "running")
      return { state: "running", detail: turn.detail };
    if (turn.state !== "output-pending")
      return {
        state: "failed",
        detail:
          turn.state === "failed" ? turn.detail : "Claude turn was interrupted",
      };
    if (session.status !== "idle") return { state: "running" };
    const output = await this.file(data, "factory-result.json");
    if (!output)
      return { state: "running", detail: "Awaiting output publication" };
    parseClaudeResultSnapshot(output.bytes, {
      attemptId: handle.identity,
      baseSha: data.request.baseSha,
      inputDigest: data.inputDigest,
    });
    writeFileSync(join(data.root, "result.json"), output.bytes, {
      mode: 0o600,
    });
    data.artifact = {
      fileId: output.id,
      sha256: claudeByteDigest(output.bytes),
      bytes: output.bytes.length,
      inputEventId: data.implementationEventId,
      endEventId: turn.endEventId,
    };
    data.phase = "result-ready";
    this.save(handle, context);
    return { state: "complete" };
  }
  private async submitImplementation(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    if (
      data.phase !== "bootstrap-verified" ||
      !data.bootstrap ||
      !data.sessionId
    )
      throw new Error(
        "Claude implementation requires verified bootstrap identity",
      );
    const proof = data.bootstrap;
    if (!context || context.cancelled())
      throw cancelledFault("Claude implementation cancelled before submission");
    await this.client.verifyEnvironment(this.remaining(data));
    const current = await this.client.retrieve(
      data.sessionId,
      this.remaining(data),
    );
    this.assertSession(current, handle);
    if (
      current.status !== "idle" ||
      historyDigest(
        await this.client.events(data.sessionId, this.remaining(data)),
      ) !== proof.historyDigest
    )
      throw new Error(
        "Claude bootstrap changed before implementation submission",
      );
    const text = this.implementationText(data);
    if (context.cancelled())
      throw cancelledFault("Claude implementation cancelled before submission");
    data.phase = "implementation-submitted";
    this.save(handle, context);
    const sent = await this.client.send(
      data.sessionId,
      { type: "user.message", content: [{ type: "text", text }] },
      this.remaining(data),
    );
    const event = sent.data?.[0];
    if (sent.data?.length !== 1 || event?.type !== "user.message")
      throw new Error(
        "Claude implementation submission acknowledgement is ambiguous",
      );
    data.implementationEventId = event.id;
    data.phase = "running";
    this.save(handle, context);
  }
  /** Interrupts a running turn. An interrupt whose response was lost is found in the session history. */
  private async interrupt(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    const sessionId = data.sessionId!;
    if (!data.interruptEventId) {
      const prior = (await this.client.events(sessionId, this.remaining(data)))
        .filter((event) => event.type === "user.interrupt")
        .at(-1);
      if (prior) data.interruptEventId = prior.id;
      else {
        const sent = await this.client.send(
          sessionId,
          { type: "user.interrupt" },
          this.remaining(data),
        );
        const event = sent.data?.[0];
        if (sent.data?.length !== 1 || event?.type !== "user.interrupt")
          throw new Error("Claude interrupt acknowledgement is ambiguous");
        data.interruptEventId = event.id;
      }
      this.save(handle, context);
    }
    while (true) {
      const events = await this.client.events(sessionId, this.remaining(data));
      const applied = events.find(
        (event) =>
          event.id === data.interruptEventId &&
          event.type === "user.interrupt" &&
          event.processed_at,
      );
      const session = await this.client.retrieve(
        sessionId,
        this.remaining(data),
      );
      this.assertSession(session, handle);
      this.preserve(data, session, events);
      this.usage(session, handle, context);
      if (applied && ["idle", "terminated"].includes(session.status)) return;
      await this.wait(data);
    }
  }
  /** Deletes every session tagged with this attempt, then the uploaded files. Each deletion is safe to repeat. */
  private async dispose(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    data.cleanupStartedAt ??= Date.now();
    if (data.phase === "disposed") return;
    const sessions = new Set(data.sessionId ? [data.sessionId] : []);
    // A create whose response was lost can leave a tagged session the handle never recorded.
    if (data.createdAfter)
      for (const session of await this.client.findSessions(
        handle.identity,
        data.createdAfter,
        this.remaining(data),
      ))
        sessions.add(session.id);
    for (const sessionId of sessions) {
      const session = await this.client.present(
        sessionId,
        this.remaining(data),
      );
      if (!session) continue;
      if (sessionId === data.sessionId) this.assertSession(session, handle);
      else this.client.assertSession(session, handle.identity);
      if (!["idle", "terminated"].includes(session.status))
        throw new Error("Claude session is still active");
      if (sessionId === data.sessionId) {
        let events;
        try {
          events = await this.client.events(sessionId, this.remaining(data));
        } catch (error) {
          // Deleted since it was observed: nothing is left to preserve, and
          // the deletion below confirms it is absent.
          if (!claudeGone(error)) throw error;
        }
        if (events) {
          this.preserve(data, session, events);
          this.usage(session, handle, context);
          this.save(handle, context);
        }
      }
      // Deleting a session removes its sandbox, not the reusable environment.
      await this.client.deleteSession(sessionId, this.remaining(data));
      if (await this.client.present(sessionId, this.remaining(data)))
        throw new Error(
          "Claude owned session/sandbox deletion is not confirmed",
        );
    }
    for (const file of data.files) {
      if (data.deletedFiles.includes(file.id)) continue;
      await this.client.deleteFile(file.id, this.remaining(data));
      if (!(await this.client.fileAbsent(file.id, this.remaining(data))))
        throw new Error("Claude uploaded file deletion is not confirmed");
      data.deletedFiles.push(file.id);
      this.save(handle, context);
    }
    data.phase = "disposed";
    this.save(handle, context);
  }
  /** Stops any running turn and disposes the attempt's resources. */
  private async stop(
    handle: ExecutionHandle,
    terminal: "failed" | "cancelled",
    context?: ExecutionContext,
  ): Promise<void> {
    const data = this.active(handle);
    if (data.phase === "disposed") return;
    // Each cleanup gets a fresh window, so cleanup resumed after an outage
    // longer than the window still runs.
    data.cleanupStartedAt = Date.now();
    const session = data.sessionId
      ? await this.client.present(data.sessionId, this.remaining(data))
      : undefined;
    if (session) {
      this.assertSession(session, handle);
      if (session.status === "running" || session.status === "rescheduling")
        try {
          await this.interrupt(handle, context);
        } catch (error) {
          // A session deleted meanwhile has no turn left to interrupt.
          if (!claudeGone(error)) throw error;
        }
    }
    data.terminal ??= terminal;
    this.save(handle, context);
    await this.dispose(handle, context);
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
      throw new Error("Invalid Claude managed attempt identity");
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
  /**
   * Any failure either interrupts the step (it reattaches) or stops the
   * session first, so a repeated attempt never runs beside it.
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
      data.terminal = "complete";
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
      if (context.cancelled())
        throw cancelledFault("Claude collection cancelled");
      // Each pass resolves the recorded phase first, so a transport failure
      // leaves collect and the step's repeat resumes here without repeating
      // a submission blindly.
      await this.advance(handle, context);
      const observation = await this.observeActive(handle, context);
      if (
        observation.state === "running" &&
        data.phase === "bootstrap-verified"
      )
        await this.submitImplementation(handle, context);
      if (observation.state === "complete") break;
      if (observation.state !== "running")
        await this.settle(
          handle,
          context,
          observation.detail ?? `Claude execution ${observation.state}`,
          observation.interrupted === true,
        );
      if (data.phase !== "prepared" && data.phase !== "created")
        await this.wait(data);
    }
    const bytes = readFileSync(join(data.root, "result.json"));
    if (
      !data.artifact ||
      bytes.length !== data.artifact.bytes ||
      claudeByteDigest(bytes) !== data.artifact.sha256
    )
      throw new Error("Captured Claude result changed locally");
    const snapshot = parseClaudeResultSnapshot(bytes, {
      attemptId: handle.identity,
      baseSha: data.request.baseSha,
      inputDigest: data.inputDigest,
    });
    if (snapshot.files.some((file) => file.mode === "120000"))
      throw new Error("Managed results support regular files only");
    const stage = join(data.root, "result-files");
    materializeClaudeSnapshot(stage, snapshot);
    const worktree = join(data.root, "result");
    await addWorktree(this.args.checkout, worktree, data.request.baseSha);
    try {
      for (const name of readdirSync(worktree))
        if (name !== ".git")
          rmSync(join(worktree, name), { recursive: true, force: true });
      for (const name of readdirSync(stage))
        cpSync(join(stage, name), join(worktree, name), { recursive: true });
      const evidenceBytes = readFileSync(
        join(data.root, "provider-evidence.json"),
      );
      if (claudeByteDigest(evidenceBytes) !== data.evidenceDigest)
        throw new Error("Captured Claude provider evidence changed locally");
      writeFileSync(join(data.root, "result-evidence.json"), evidenceBytes, {
        mode: 0o600,
      });
      const evidence = {
        harness: "claude-managed-agents",
        sessionId: data.sessionId,
        bootstrap: data.bootstrap,
        artifact: data.artifact,
        providerEvidenceDigest: data.evidenceDigest,
        providerEvidenceFile: "result-evidence.json",
      };
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
