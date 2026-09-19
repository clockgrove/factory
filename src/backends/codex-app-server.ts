import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
  AttemptContext,
  BackendHandle,
  BackendObservation,
  BackendObservationState,
  BackendProbe,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  StaleAttemptIdentity,
} from "../execution/backend.js";
import { localExecutionScopeBatch, remainingBeforeAttemptDeadline } from "../execution/backend.js";
import {
  APP_SERVER_SESSION_PROTOCOL,
  appServerBoundaryDigest,
  assertAppServerSessionContext,
  canonicalSessionJson,
  completeSessionUsage,
  parseAppServerSessionCheckpoint,
  AppServerResponseUsageSchema,
  completedAppServerUsage,
  EMPTY_APP_SERVER_USAGE,
  type AppServerResponseUsage,
  type AppServerSessionBinding,
  type AppServerSessionCheckpoint,
} from "../execution/app-server-session.js";
import { workerPacketDigest } from "../protocol/worker-packet.js";
import { LocalScopeBatchSchema } from "../protocol/local-scope.js";
import { readLocalResourceHostIdentity } from "../recovery/local-resources.js";
import {
  linuxLocalScopeReadPort,
  observeLocalScope,
  stopLocalScope,
  type LocalScopeReadPort,
} from "../runtime/local-scope.js";
import { resolveCodexCommand } from "../runtime/codex-command.js";
import { normalizeArtifact, type NormalizedArtifact } from "../execution/artifacts.js";
import { durableAttemptId, normalizeExecutionUsage } from "../execution/session.js";
import type { ExecutionRequirements } from "../protocol/worker-packet.js";
import {
  createIsolatedCodexHome,
  isolateCodexEnvironment,
  resolveCodexAuthFile,
  resolveCodexHomeRoot,
} from "../runtime/codex-home.js";
import { collectLocalArtifact } from "../runtime/local-worktree.js";
import {
  startCodexAppServer,
  type AppServerConnection,
  type AppServerNotification,
  type AppServerRequest,
} from "../runtime/codex-app-server.js";
import { restrictedCodexArgs } from "./codex-cli-policy.js";
import {
  CODEX_WORKER_OUTPUT_SCHEMA,
  probeLocalCapabilities,
  workerPacketPrompt,
  type LocalCapabilityProbe,
} from "./codex-cli-local.js";
import { withManagedToolchainPath } from "../toolchains/authority.js";
import { parseFindingCandidates, type FindingCandidate } from "../protocol/findings.js";

interface WorkerFinal {
  outcome: "succeeded" | "failed" | "declined";
  summary: string;
  commands: Array<{ command: string; exitCode: number }>;
  findings?: FindingCandidate[] | undefined;
}

interface AppServerTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items?: unknown[];
  error?: { message?: string } | null;
}

interface AppAttempt {
  context: AttemptContext;
  handle: BackendHandle;
  threadId: string;
  turnId: string;
  home: string;
  state: BackendObservationState;
  reason?: string;
  progress?: string;
  usage?: unknown;
  rawTokenUsage?: AppServerSessionCheckpoint["rawTokenUsage"];
  binding?: AppServerSessionBinding;
  providerTerminal?: boolean;
  terminalPersisted?: boolean;
  responseUsage: Map<string, AppServerResponseUsage>;
  usageStreamComplete: boolean;
  providerCompleted?: boolean;
  providerStatus?: "completed" | "interrupted" | "failed";
  final?: WorkerFinal;
  cancellationRequested: boolean;
  interruptSent: boolean;
  connectionCloseRequested: boolean;
  deadlineExpired: boolean;
  deadlineTimer?: NodeJS.Timeout;
  deadlineSettlement?: Promise<void>;
  terminal: Promise<void>;
  resolveTerminal(): void;
  unsubscribeNotification?: () => void;
  unsubscribeRequest?: () => void;
}

type AttemptIdentity = Pick<
  AttemptContext,
  "repository" | "runId" | "objective" | "workItem" | "attempt" | "directorEpoch"
>;

export interface CodexAppServerOptions {
  command?: string;
  args?: string[];
  model?: string;
  profile?: string;
  authFile?: string;
  permittedModelCredentials?: string[];
  capabilityProbe?: LocalCapabilityProbe;
  cancellationWaitMs?: number;
  createProbeCodexHome?: () => Promise<string>;
  /** Injectable deterministic location for tests and alternate hosts. */
  resolveCodexHome?: (identity: AttemptIdentity) => string | Promise<string>;
  /** Injectable transport for protocol/conformance tests. */
  connect?: (home: string) => Promise<AppServerConnection> | AppServerConnection;
  readHostIdentity?: () => Promise<string | null>;
  scopeReadPort?: LocalScopeReadPort;
}

const MAX_REPOSITORY_INSTRUCTIONS_BYTES = 32 * 1024;
const MAX_SERVER_USER_AGENT_BYTES = 512;
const CODEX_CLI_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

function appServerIdentity(value: unknown): { userAgent: string } {
  const initialization = record(value);
  const userAgent = initialization.userAgent;
  if (
    typeof userAgent !== "string" ||
    userAgent.trim().length === 0 ||
    Buffer.byteLength(userAgent, "utf8") > MAX_SERVER_USER_AGENT_BYTES ||
    [...userAgent].some((value) => {
      const code = value.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  )
    throw new Error("Codex App Server omitted its bounded initialize identity");
  return { userAgent };
}

function appServerCliVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !CODEX_CLI_VERSION.test(value))
    throw new Error("Codex App Server returned an invalid CLI version identity");
  return value;
}

export function codexAppServerArgs(home: string, profile?: string): string[] {
  return [
    "-c",
    `sqlite_home=${JSON.stringify(resolve(home))}`,
    ...(profile ? ["--profile", profile] : []),
    "app-server",
    "--stdio",
  ];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function idOf(value: unknown, key: "thread" | "turn"): string {
  const object = record(value);
  const nested = record(object[key]);
  const id = nested.id ?? object[`${key}Id`] ?? object.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Codex App Server omitted ${key} identity`);
  }
  return id;
}

function eventIds(event: AppServerNotification): {
  thread?: string;
  turn?: string;
} {
  const params = record(event.params);
  const nestedThread = record(params.thread);
  const nestedTurn = record(params.turn);
  const thread = params.threadId ?? nestedThread.id;
  const turn = params.turnId ?? nestedTurn.id;
  return {
    ...(typeof thread === "string" ? { thread } : {}),
    ...(typeof turn === "string" ? { turn } : {}),
  };
}

function parseWorkerFinal(value: unknown): WorkerFinal | undefined {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  const output = record(candidate);
  if (
    !["succeeded", "failed", "declined"].includes(String(output.outcome)) ||
    typeof output.summary !== "string" ||
    !Array.isArray(output.commands)
  ) {
    return undefined;
  }
  const commands: Array<{ command: string; exitCode: number }> = [];
  for (const value of output.commands) {
    const command = record(value);
    if (
      typeof command.command !== "string" ||
      typeof command.exitCode !== "number" ||
      !Number.isInteger(command.exitCode)
    ) {
      return undefined;
    }
    commands.push({ command: command.command, exitCode: command.exitCode });
  }
  return {
    outcome: output.outcome as WorkerFinal["outcome"],
    summary: output.summary,
    commands,
    ...(parseFindingCandidates(output.findings)
      ? { findings: parseFindingCandidates(output.findings) }
      : {}),
  };
}

function finalFromItems(items: unknown): WorkerFinal | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const value of [...items].reverse()) {
    const item = record(value);
    if (item.type !== "agentMessage") continue;
    return parseWorkerFinal(item.text);
  }
  return undefined;
}

function turnFrom(value: unknown): AppServerTurn | undefined {
  const turn = record(value);
  if (
    typeof turn.id !== "string" ||
    !["completed", "interrupted", "failed", "inProgress"].includes(String(turn.status))
  ) {
    return undefined;
  }
  return turn as unknown as AppServerTurn;
}

/** Structured App Server config derived from the same fail-closed CLI policy. */
export function codexAppServerThreadConfig(networkDestinations: string[]): Record<string, unknown> {
  const args = restrictedCodexArgs("workspace-write", networkDestinations);
  const networkEnabled = args.includes("sandbox_workspace_write.network_access=true");
  const domains = Object.fromEntries(
    [...new Set(networkDestinations)].sort().map((destination) => [destination, "allow"]),
  );
  return {
    web_search: "disabled",
    sandbox_workspace_write: { network_access: networkEnabled },
    ...(networkEnabled
      ? {
          features: {
            network_proxy: { enabled: true, domains },
          },
        }
      : {}),
  };
}

async function repositoryDeveloperInstructions(workspace: string): Promise<string | undefined> {
  let instructions: Buffer;
  try {
    instructions = await readFile(join(workspace, "AGENTS.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const truncated = instructions.length > MAX_REPOSITORY_INSTRUCTIONS_BYTES;
  const content = instructions
    .subarray(0, MAX_REPOSITORY_INSTRUCTIONS_BYTES)
    .toString("utf8")
    .trim();
  return [
    "Repository instructions from AGENTS.md (repository-controlled content):",
    content || "(empty)",
    ...(truncated ? [`[AGENTS.md truncated at ${MAX_REPOSITORY_INSTRUCTIONS_BYTES} bytes]`] : []),
    "Factory execution boundary (takes precedence over repository instructions): edit only the supplied workspace; do not create commits, branches, pull requests, issues, or releases; do not contact GitHub, start Factory, invoke a Director, delegate another agent, reveal credentials, or write outside the Work Packet's Allowed paths.",
  ].join("\n\n");
}

async function threadBoundary(context: AttemptContext): Promise<Record<string, unknown>> {
  const config = codexAppServerThreadConfig(context.packet.requirements.networkDestinations);
  const developerInstructions = await repositoryDeveloperInstructions(context.workspace);
  return {
    cwd: context.workspace,
    runtimeWorkspaceRoots: [context.workspace],
    approvalPolicy: "never",
    sandbox: "workspace-write",
    config: {
      ...config,
      ...(context.modelSelection?.reasoning
        ? { model_reasoning_effort: context.modelSelection.reasoning }
        : {}),
      // The CLI backend uses --ignore-rules. App Server has no equivalent RPC
      // field, so its isolated home removes user rules and this trust override
      // removes project .codex config, hooks, and rules. Factory injects the
      // root AGENTS.md separately so repository conventions remain available.
      projects: {
        [context.workspace]: { trust_level: "untrusted" },
      },
    },
    ...(developerInstructions ? { developerInstructions } : {}),
  };
}

function terminalState(state: BackendObservationState): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(state);
}

async function exists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK).then(
    () => true,
    () => false,
  );
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export function appServerHandleFromCheckpoint(input: AppServerSessionCheckpoint): BackendHandle {
  const checkpoint = parseAppServerSessionCheckpoint(input),
    binding = checkpoint.binding;
  return {
    backendId: "codex-app-server/local-worktree",
    resourceId: binding.threadId,
    startedAt: binding.startedAt,
    metadata: {
      threadId: binding.threadId,
      sessionId: binding.sessionId,
      attemptId: binding.attemptId,
      workspace: binding.workspace,
      baseSha: binding.baseSha,
      codexHome: binding.codexHome,
      resourceHostIdentity: binding.hostIdentity,
      ...(checkpoint.turnId ? { turnId: checkpoint.turnId } : {}),
    },
  };
}

export class CodexAppServerLocalBackend implements ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities = {
    id: "codex-app-server/local-worktree",
    supportTier: "supported",
    agentKind: "codex-app-server",
    runtimeKind: "local-worktree",
    hostExecution: true,
    isolation: "process",
    supportedOs: ["linux"],
    supportedArchitectures: [arch()],
    supportedTools: ["git", "node", "npm", "npx", "bash", "sh", "grep"],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: true,
    durableSession: {
      providerStorage: "local",
      recovery: "exact-terminal-read-only",
      coldRepair: "unavailable-raw-usage-subscription",
      preferredRouteQualification: "required",
    },
    supportsLocalInference: false,
    supportsManagedToolchainExecution: true,
    supportsOfflineAssetInputs: true,
    reportsModelUsage: true,
    supportsModelSelection: true,
    requiresPaidRuntime: false,
    providerManagedPublication: false,
    requiredCredentials: ["codex-login-or-model-key"],
  };

  readonly #options: CodexAppServerOptions;
  readonly #attempts = new Map<string, AppAttempt>();
  readonly #connections = new Map<string, AppServerConnection>();
  readonly #serverIdentities = new Map<string, { userAgent: string }>();
  readonly #ownedScopes = new Map<
    string,
    NonNullable<AttemptContext["localExecutionScope"]>["batch"]
  >();

  constructor(options: CodexAppServerOptions = {}) {
    this.#options = options;
  }

  async probe(requirements?: ExecutionRequirements): Promise<BackendProbe> {
    const measuredAt = new Date().toISOString();
    if (process.platform !== "linux") {
      return {
        available: false,
        authenticated: false,
        reason: "Factory local execution requires Linux (native, WSL2, or a Linux guest)",
        measuredAt,
      };
    }
    if (requirements) {
      const found = await (this.#options.capabilityProbe ?? probeLocalCapabilities)(requirements);
      this.capabilities.supportedTools = [
        ...new Set([...this.capabilities.supportedTools, ...found.tools]),
      ];
      this.capabilities.supportedServices = [
        ...new Set([...this.capabilities.supportedServices, ...found.services]),
      ];
    }
    const home = await (this.#options.createProbeCodexHome?.() ??
      createIsolatedCodexHome("worker"));
    let connection: AppServerConnection | undefined;
    try {
      const hasAuth = await this.#installAuth(home);
      const hasCredential = (this.#options.permittedModelCredentials ?? []).some((name) =>
        Boolean(process.env[name]),
      );
      connection = await this.#openConnection(home, tmpdir(), "probe");
      return {
        available: true,
        authenticated: hasAuth || hasCredential,
        ...(!hasAuth && !hasCredential
          ? { reason: "no Codex login or permitted model credential was found" }
          : {}),
        measuredAt,
      };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        reason: error instanceof Error ? error.message : String(error),
        measuredAt,
      };
    } finally {
      await connection?.close();
      this.#serverIdentities.delete(home);
      await rm(home, { recursive: true, force: true });
    }
  }

  async launch(context: AttemptContext): Promise<BackendHandle> {
    const deadlineFailure = "attempt deadline elapsed before App Server model dispatch";
    remainingBeforeAttemptDeadline(context.deadline, deadlineFailure);
    const journal = context.sessionJournal;
    if (!journal)
      throw new Error("durable App Server execution requires the fenced GitHub session journal");
    const scope = localExecutionScopeBatch(context);
    if (!scope)
      throw new Error(
        "durable App Server execution requires independently observable local scopes",
      );
    const host = await (this.#options.readHostIdentity ?? readLocalResourceHostIdentity)();
    if (!host || host !== scope.identity.hostIdentity)
      throw new Error("App Server launch host differs from its reservation");
    if (await journal.load("prepared"))
      throw new Error(
        "App Server turn dispatch already has a durable intent; use read-only recovery",
      );
    const previous = journal.previous && parseAppServerSessionCheckpoint(journal.previous);
    if (
      previous &&
      (previous.stage !== "terminal" ||
        !completeSessionUsage(previous.usage) ||
        previous.binding.repository !== context.repository.toLowerCase() ||
        previous.binding.runId !== context.runId ||
        previous.binding.workItem !== context.workItem ||
        previous.binding.attempt >= context.attempt ||
        previous.binding.policyDigest !== context.policyDigest ||
        previous.binding.baseSha !== context.packet.baseSha ||
        previous.binding.hostIdentity !== host)
    )
      throw new Error("prior thread does not authorize an exact known-usage repair attempt");
    // The current cold thread/resume request cannot opt into rawResponse/completed.
    // Never dispatch a repair with a knowingly unavailable accounting stream.
    if (previous)
      throw new Error(
        "cold same-thread repair is unavailable: thread/resume cannot enable exact raw-response accounting",
      );
    const attemptId = durableAttemptId(context);
    this.#ownedScopes.set(attemptId, scope);
    const home = await this.#prepareHome(context);
    let connection: AppServerConnection | undefined;
    let resourceId: string | undefined;
    let activeAttempt: AppAttempt | undefined;
    try {
      remainingBeforeAttemptDeadline(context.deadline, deadlineFailure);
      await this.#installAuth(home);
      remainingBeforeAttemptDeadline(context.deadline, deadlineFailure);
      connection = await this.#connection(home, context.workspace, attemptId, context);
      const serverIdentity = this.#serverIdentities.get(home);
      if (!serverIdentity) throw new Error("Codex App Server initialize identity is unavailable");
      await journal.assertCurrent();
      const boundary = await threadBoundary(context);
      remainingBeforeAttemptDeadline(context.deadline, deadlineFailure);
      const threadResult = await connection.request("thread/start", {
        ...boundary,
        ...((context.modelSelection?.model ?? this.#options.model)
          ? { model: context.modelSelection?.model ?? this.#options.model }
          : {}),
        ephemeral: false,
        experimentalRawEvents: true,
      });
      const threadId = idOf(threadResult, "thread");
      const response = record(threadResult),
        thread = record(response.thread);
      if (
        typeof thread.sessionId !== "string" ||
        !thread.sessionId ||
        thread.cwd !== context.workspace ||
        typeof thread.modelProvider !== "string" ||
        typeof response.model !== "string" ||
        response.approvalPolicy !== "never" ||
        ((context.modelSelection?.model ?? this.#options.model) &&
          response.model !== (context.modelSelection?.model ?? this.#options.model))
      )
        throw new Error("App Server returned an incompatible thread, model, or permission binding");
      const cliVersion = appServerCliVersion(thread.cliVersion);
      const priorTurns = Array.isArray(thread.turns) ? thread.turns.map(turnFrom) : [];
      if (!Array.isArray(thread.turns) || priorTurns.length)
        throw new Error("App Server thread contains missing, active, or unexpected prior turns");
      const binding: AppServerSessionBinding = {
        attemptId,
        repository: context.repository.toLowerCase(),
        runId: context.runId,
        objective: context.objective,
        workItem: context.workItem,
        attempt: context.attempt,
        directorEpoch: context.directorEpoch,
        policyDigest: context.policyDigest,
        baseSha: context.packet.baseSha,
        packetDigest: workerPacketDigest(context.packet),
        boundaryDigest: appServerBoundaryDigest(context),
        hostIdentity: host,
        workspace: context.workspace,
        codexHome: home,
        threadId,
        sessionId: thread.sessionId,
        modelProvider: thread.modelProvider,
        model: response.model,
        cliVersion,
        serverUserAgent: serverIdentity.userAgent,
        usageBaseline: { ...EMPTY_APP_SERVER_USAGE },
        startedAt: new Date().toISOString(),
        deadline: context.deadline.toISOString(),
        priorTurnIds: priorTurns.map((turn) => turn!.id),
        localScopeBatch: scope,
      };
      resourceId = threadId;
      const handle: BackendHandle = {
        backendId: this.capabilities.id,
        resourceId: threadId,
        startedAt: new Date().toISOString(),
        metadata: {
          threadId,
          turnId: "",
          workspace: context.workspace,
          baseSha: context.packet.baseSha,
          attemptId,
          codexHome: home,
          resourceHostIdentity: host,
          sessionId: binding.sessionId,
          cliVersion: binding.cliVersion,
          ...(connection.pid === null ? {} : { pid: String(connection.pid) }),
        },
      };
      const attempt = this.#newAttempt(context, handle, threadId, "", home);
      activeAttempt = attempt;
      attempt.binding = binding;
      this.#attempts.set(threadId, attempt);
      this.#attach(attempt, connection);
      await journal.persist({
        protocol: APP_SERVER_SESSION_PROTOCOL,
        stage: "prepared",
        binding,
        packet: context.packet,
      });
      await journal.assertCurrent();
      remainingBeforeAttemptDeadline(context.deadline, deadlineFailure);
      const turnResult = await connection.request("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: workerPacketPrompt(context),
            text_elements: [],
          },
        ],
        outputSchema: CODEX_WORKER_OUTPUT_SCHEMA,
      });
      const turnId = idOf(turnResult, "turn");
      if ((attempt.turnId && attempt.turnId !== turnId) || binding.priorTurnIds.includes(turnId))
        throw new Error("App Server turn dispatch returned a different invocation");
      attempt.turnId = turnId;
      handle.metadata = { ...handle.metadata, turnId };
      this.#armDeadline(attempt);
      await journal.persist({
        protocol: APP_SERVER_SESSION_PROTOCOL,
        stage: "turn",
        binding,
        packet: context.packet,
        turnId,
      });
      const returnedTurn = turnFrom(record(turnResult).turn);
      if (returnedTurn && !attempt.providerTerminal) this.#applyTurn(attempt, returnedTurn);
      return handle;
    } catch (error) {
      if (activeAttempt?.deadlineTimer) clearTimeout(activeAttempt.deadlineTimer);
      if (activeAttempt) activeAttempt.connectionCloseRequested = true;
      if (resourceId) this.#attempts.delete(resourceId);
      await connection?.close();
      this.#connections.delete(home);
      this.#serverIdentities.delete(home);
      // Even a lost turn/start response may have consumed model work. Preserve
      // provider history and its immutable intent; never re-dispatch here.
      throw error;
    }
  }

  waitForTerminal(handle: BackendHandle): Promise<void> {
    return this.#require(handle).terminal;
  }

  async observe(handle: BackendHandle): Promise<BackendObservation> {
    const attempt = this.#require(handle);
    if (
      attempt.providerTerminal &&
      !attempt.terminalPersisted &&
      attempt.binding &&
      attempt.context.sessionJournal
    ) {
      attempt.usage = completedAppServerUsage({
        completed: attempt.providerCompleted === true,
        baseline: attempt.binding.usageBaseline,
        total: attempt.rawTokenUsage?.total,
        responses: [...attempt.responseUsage.values()],
        streamComplete: attempt.usageStreamComplete,
      });
      await attempt.context.sessionJournal.persist({
        protocol: APP_SERVER_SESSION_PROTOCOL,
        stage: "terminal",
        binding: attempt.binding,
        packet: attempt.context.packet,
        turnId: attempt.turnId,
        state: attempt.state as "succeeded" | "failed" | "cancelled" | "timed_out",
        providerStatus: attempt.providerStatus!,
        ...(attempt.rawTokenUsage ? { rawTokenUsage: attempt.rawTokenUsage } : {}),
        responseUsage: [...attempt.responseUsage.values()],
        usageStreamComplete: attempt.usageStreamComplete,
        ...(attempt.usage ? { usage: normalizeExecutionUsage(attempt.usage) } : {}),
        ...(attempt.final ? { final: attempt.final } : {}),
      });
      attempt.terminalPersisted = true;
    }
    return {
      state: attempt.state,
      observedAt: new Date().toISOString(),
      // Thread-level total/last notifications are retained verbatim, not
      // relabelled as authoritative final turn counters.
      usage: normalizeExecutionUsage(attempt.usage),
      ...(attempt.reason ? { reason: attempt.reason } : {}),
      ...(attempt.progress ? { progress: attempt.progress } : {}),
    };
  }

  async cancel(handle: BackendHandle): Promise<void> {
    const attempt = this.#require(handle);
    if (terminalState(attempt.state)) return;
    attempt.cancellationRequested = true;
    attempt.reason = "attempt cancelled by Factory";
    let interruptError: unknown;
    try {
      await this.#interrupt(attempt);
    } catch (error) {
      interruptError = error;
    }
    await Promise.race([attempt.terminal, wait(this.#options.cancellationWaitMs ?? 5_000)]);
    attempt.connectionCloseRequested = true;
    await this.#closeConnection(attempt.home);
    if (!terminalState(attempt.state)) {
      attempt.state = "unknown";
      attempt.reason = interruptError
        ? "App Server interruption outcome unavailable"
        : "App Server stopped without a terminal turn receipt";
    }
  }

  async collect(handle: BackendHandle): Promise<NormalizedArtifact> {
    const attempt = this.#require(handle);
    if (!terminalState(attempt.state)) {
      throw new Error("cannot collect a running Codex App Server thread");
    }
    const local = await collectLocalArtifact(
      {
        root: join(attempt.context.workspace, ".."),
        path: attempt.context.workspace,
        repository: attempt.context.workspace,
        baseSha: attempt.context.packet.baseSha,
      },
      attempt.reason ?? attempt.progress ?? attempt.final?.summary ?? "",
      attempt.context.packet.allowedPaths,
    );
    const outcome =
      attempt.state === "succeeded" && attempt.final?.outcome === "succeeded" && local.patch.trim()
        ? "succeeded"
        : attempt.final?.outcome === "declined" || !local.patch.trim()
          ? "declined"
          : "failed";
    return normalizeArtifact({
      baseSha: local.baseSha,
      patch: local.patch,
      payload: local.payload,
      fileManifest: local.fileManifest,
      changedPaths: local.changedPaths,
      commands: (attempt.final?.commands ?? []).map((command) => ({
        ...command,
        durationMs: 0,
      })),
      logs: local.logs,
      outcome,
      ...(attempt.final?.findings ? { findings: attempt.final.findings } : {}),
      ...(outcome === "succeeded"
        ? {}
        : {
            reason:
              attempt.reason ?? attempt.final?.summary ?? "worker did not produce usable work",
          }),
    });
  }

  async cleanup(handle: BackendHandle): Promise<void> {
    const attempt = this.#require(handle);
    if (attempt.deadlineTimer) clearTimeout(attempt.deadlineTimer);
    if (!terminalState(attempt.state)) await this.cancel(handle);
    // The terminal checkpoint is the recovery boundary. Keep the exact live
    // attempt, observers, and provider connection intact until it is durable so
    // active stale reconciliation can retry this same checkpoint without a
    // replacement turn or lost usage.
    if (attempt.providerTerminal) await this.observe(handle);
    attempt.unsubscribeNotification?.();
    attempt.unsubscribeRequest?.();
    attempt.connectionCloseRequested = true;
    await this.#closeConnection(attempt.home);
    this.#attempts.delete(handle.resourceId);
    // Retain provider-owned thread history. It is not a Factory scheduler DB.
  }

  async resume(context: AttemptContext, handle: BackendHandle): Promise<BackendHandle> {
    if (handle.backendId !== this.capabilities.id || !context.sessionJournal)
      throw new Error("App Server resume requires its exact backend and durable journal");
    const journal = context.sessionJournal;
    const prepared = await journal.load("prepared");
    if (!prepared) throw new Error("App Server session preparation is unavailable");
    assertAppServerSessionContext(context, prepared.binding);
    const binding = prepared.binding;
    if (
      handle.resourceId !== binding.threadId ||
      (handle.metadata?.turnId && binding.priorTurnIds.includes(handle.metadata.turnId))
    )
      throw new Error("App Server handle differs from its durable thread");
    const current = this.#attempts.get(handle.resourceId);
    if (current) {
      if (canonicalSessionJson(current.binding) !== canonicalSessionJson(binding))
        throw new Error("active App Server binding changed");
      return current.handle;
    }
    const terminalCheckpoint = await journal.load("terminal");
    await journal.assertCurrent();
    await this.#assertPriorStopped(binding, terminalCheckpoint !== null);
    if (!(await exists(binding.codexHome)))
      throw new Error(
        "durable App Server provider state is unavailable; no replacement turn authorized",
      );
    await journal.assertCurrent();
    // A separate read-only connection may inspect persisted history only. It
    // never reloads an agent or dispatches a model turn during reconciliation.
    const connection = await this.#connection(
      binding.codexHome,
      context.workspace,
      `${binding.attemptId}-read`,
    );
    try {
      const selected = await this.#readFencedTurn(connection, binding, handle.metadata?.turnId);
      const started = await journal.load("turn"),
        terminal = await journal.load("terminal");
      if (canonicalSessionJson(terminal) !== canonicalSessionJson(terminalCheckpoint))
        throw new Error("durable terminal session changed during recovery");
      if (
        (started && started.turnId !== selected.id) ||
        (terminal && terminal.turnId !== selected.id) ||
        (handle.metadata?.turnId && handle.metadata.turnId !== selected.id)
      )
        throw new Error("stored App Server turn differs from its immutable dispatch");
      const deadlineElapsed = Date.now() >= new Date(binding.deadline).getTime();
      await journal.assertCurrent();
      await this.#assertPriorStopped(binding, terminal !== null);
      if (!started) await journal.persist({ ...prepared, stage: "turn", turnId: selected.id });
      const resumed = appServerHandleFromCheckpoint({
        ...prepared,
        stage: "turn",
        turnId: selected.id,
      });
      const attempt = this.#newAttempt(
        context,
        resumed,
        binding.threadId,
        selected.id,
        binding.codexHome,
      );
      attempt.binding = binding;
      attempt.cancellationRequested = terminal?.state === "cancelled";
      attempt.deadlineExpired = terminal?.state === "timed_out";
      attempt.usageStreamComplete = false;
      this.#applyTurn(attempt, selected);
      if (terminal) {
        if (
          terminal.state !== attempt.state ||
          terminal.providerStatus !== selected.status ||
          canonicalSessionJson(terminal.final) !== canonicalSessionJson(attempt.final)
        )
          throw new Error("provider terminal differs from its durable completion");
        attempt.usage = terminal.usage;
        attempt.rawTokenUsage = terminal.rawTokenUsage;
        attempt.responseUsage = new Map(
          (terminal.responseUsage ?? []).map((entry) => [entry.responseId, entry]),
        );
        attempt.usageStreamComplete = terminal.usageStreamComplete === true;
        attempt.terminalPersisted = true;
      }
      this.#attempts.set(resumed.resourceId, attempt);
      this.#ownedScopes.set(binding.attemptId, binding.localScopeBatch);
      if (selected.status === "inProgress") {
        attempt.deadlineExpired = deadlineElapsed;
        this.#markTerminal(
          attempt,
          deadlineElapsed ? "timed_out" : "failed",
          deadlineElapsed
            ? "App Server deadline elapsed after restart with no authoritative terminal provider outcome"
            : "App Server process ended before an authoritative terminal provider outcome",
        );
      }
      await this.observe(resumed);
      return resumed;
    } finally {
      await this.#closeConnection(binding.codexHome);
    }
  }

  async #readFencedTurn(
    connection: AppServerConnection,
    binding: AppServerSessionBinding,
    expectedTurnId?: string,
  ): Promise<AppServerTurn> {
    const response = record(
      await connection.request("thread/read", { threadId: binding.threadId, includeTurns: true }),
    );
    const thread = record(response.thread);
    if (
      thread.id !== binding.threadId ||
      thread.sessionId !== binding.sessionId ||
      thread.cwd !== binding.workspace ||
      thread.modelProvider !== binding.modelProvider ||
      thread.cliVersion !== binding.cliVersion ||
      (thread.model !== null && thread.model !== binding.model) ||
      !Array.isArray(thread.turns) ||
      thread.turns.length > 101
    )
      throw new Error("stored App Server thread identity or complete history changed");
    const turns = thread.turns.map(turnFrom);
    if (
      turns.some((turn) => !turn) ||
      turns.length !== binding.priorTurnIds.length + 1 ||
      binding.priorTurnIds.some((id, index) => turns[index]!.id !== id)
    )
      throw new Error(
        "App Server dispatch outcome is unavailable or ambiguous; no duplicate turn authorized",
      );
    const selected = turns.at(-1)!;
    if (expectedTurnId && selected.id !== expectedTurnId)
      throw new Error("stored App Server turn differs from its immutable dispatch");
    return selected;
  }

  async #assertPriorStopped(
    binding: AppServerSessionBinding,
    terminalCheckpoint: boolean,
  ): Promise<void> {
    const port = this.#options.scopeReadPort ?? linuxLocalScopeReadPort;
    if ((await port.hostIdentity()) !== binding.hostIdentity)
      throw new Error("durable session host is unavailable or changed");
    const batch = binding.localScopeBatch;
    let producerGone = false;
    try {
      const stat = await port.read(`/proc/${batch.producerPid}/stat`);
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      if (!stat.startsWith(`${batch.producerPid} (`) || !/^\d+$/.test(fields[19] ?? ""))
        throw new Error("producer identity unavailable");
      producerGone =
        fields[19] !== batch.producerStartTicks || fields[0] === "Z" || fields[0] === "X";
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ESRCH"
      )
        throw error;
      producerGone = true;
    }
    // An immutable provider-terminal checkpoint closes this invocation's launcher.
    // Its owning controller may remain alive. Without that checkpoint, an alive
    // producer is ambiguous even when the service is momentarily absent.
    if (
      (!producerGone && !terminalCheckpoint) ||
      (await observeLocalScope(batch.identity, port)).status !== "absent"
    )
      throw new Error(
        "prior App Server producer or exact worker scope is not independently absent",
      );
  }

  async reconcileStale(identity: StaleAttemptIdentity): Promise<void> {
    const attemptId = durableAttemptId(identity);
    const active = [...this.#attempts.values()].find(
      (attempt) => durableAttemptId(attempt.context) === attemptId,
    );
    if (active) {
      await this.cancel(active.handle);
      await this.cleanup(active.handle);
      return;
    }

    const value = identity.localScopeBatch ?? this.#ownedScopes.get(attemptId);
    const batch = value ? LocalScopeBatchSchema.parse(value) : undefined;
    if (
      !batch ||
      durableAttemptId(batch.identity) !== attemptId ||
      batch.identity.phase !== "execution" ||
      (identity.policyDigest && batch.identity.policyDigest !== identity.policyDigest)
    )
      throw new Error(
        "stale App Server execution lacks its exact durable scope; automatic replacement is blocked",
      );
    await stopLocalScope(batch.identity);
    // Absence settles compute only, never missing usage or provider history.
  }

  async #homeFor(identity: AttemptIdentity): Promise<string> {
    if (this.#options.resolveCodexHome) {
      return resolve(await this.#options.resolveCodexHome(identity));
    }
    return join(resolveCodexHomeRoot(), `app-server-${durableAttemptId(identity)}`);
  }

  async #prepareHome(identity: AttemptIdentity): Promise<string> {
    const home = await this.#homeFor(identity);
    await mkdir(dirname(home), { recursive: true, mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    return home;
  }

  async #installAuth(home: string): Promise<boolean> {
    const auth = resolveCodexAuthFile(this.#options.authFile);
    const readable = await access(auth, fsConstants.R_OK).then(
      () => true,
      () => false,
    );
    if (!readable) return false;
    const destination = join(home, "auth.json");
    if (!(await exists(destination))) await symlink(auth, destination);
    return true;
  }

  async #openConnection(
    home: string,
    cwd: string,
    attemptId: string,
    context?: AttemptContext,
  ): Promise<AppServerConnection> {
    const target = await resolveCodexCommand(this.#options.command);
    const environment = context
      ? await withManagedToolchainPath(
          isolateCodexEnvironment(process.env, home),
          home,
          context.packet.requirements.tools,
          context.packet.managedRuntimes,
        )
      : isolateCodexEnvironment(process.env, home);
    if (context) {
      remainingBeforeAttemptDeadline(
        context.deadline,
        "attempt deadline elapsed before App Server process launch",
      );
    }
    const connection = await (this.#options.connect?.(home) ??
      startCodexAppServer({
        command: target.command,
        // Pin SQLite state explicitly: overriding CODEX_HOME alone can still
        // leave current Codex builds using the shared user runtime directory.
        args: this.#options.args ?? [
          ...target.args,
          ...codexAppServerArgs(home, this.#options.profile),
        ],
        cwd,
        env: environment,
        permittedSecretNames: this.#options.permittedModelCredentials ?? [],
        attemptIdentity: attemptId,
        ...(context?.localExecutionScope
          ? {
              localScope: {
                identity: context.localExecutionScope.batch.identity,
                deadline: context.deadline,
                assertCurrent: context.localExecutionScope.assertCurrent,
              },
            }
          : {}),
      }));
    try {
      if (context) {
        remainingBeforeAttemptDeadline(
          context.deadline,
          "attempt deadline elapsed before App Server initialization",
        );
      }
      const serverIdentity = appServerIdentity(
        await connection.request("initialize", {
          clientInfo: {
            name: "clockgrove-factory",
            title: "Clockgrove Factory",
            version: "2",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: null,
            extensions: null,
          },
        }),
      );
      this.#serverIdentities.set(home, serverIdentity);
      connection.notify("initialized");
      return connection;
    } catch (error) {
      this.#serverIdentities.delete(home);
      await connection.close();
      throw error;
    }
  }

  async #connection(
    home: string,
    cwd: string,
    attemptId: string,
    context?: AttemptContext,
  ): Promise<AppServerConnection> {
    const existing = this.#connections.get(home);
    if (existing) return existing;
    const connection = await this.#openConnection(home, cwd, attemptId, context);
    this.#connections.set(home, connection);
    return connection;
  }

  #newAttempt(
    context: AttemptContext,
    handle: BackendHandle,
    threadId: string,
    turnId: string,
    home: string,
  ): AppAttempt {
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolveDone) => {
      resolveTerminal = resolveDone;
    });
    return {
      context,
      handle,
      threadId,
      turnId,
      home,
      state: "running",
      cancellationRequested: false,
      interruptSent: false,
      connectionCloseRequested: false,
      deadlineExpired: false,
      responseUsage: new Map(),
      usageStreamComplete: true,
      terminal,
      resolveTerminal,
    };
  }

  #armDeadline(attempt: AppAttempt): void {
    if (terminalState(attempt.state) || attempt.deadlineTimer || attempt.deadlineSettlement) return;
    const remaining = Math.max(0, attempt.context.deadline.getTime() - Date.now());
    attempt.deadlineTimer = setTimeout(() => {
      delete attempt.deadlineTimer;
      void this.#expireAttempt(attempt).catch((error) => {
        attempt.deadlineExpired = true;
        this.#markTerminal(
          attempt,
          "timed_out",
          `App Server deadline fallback failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, remaining);
    attempt.deadlineTimer.unref();
  }

  #expireAttempt(attempt: AppAttempt): Promise<void> {
    if (attempt.deadlineSettlement) return attempt.deadlineSettlement;
    attempt.deadlineSettlement = this.#settleDeadline(attempt);
    return attempt.deadlineSettlement;
  }

  async #settleDeadline(attempt: AppAttempt): Promise<void> {
    if (terminalState(attempt.state)) return;
    const connection = this.#connections.get(attempt.home);
    const binding = attempt.binding;
    const boundedWait = this.#options.cancellationWaitMs ?? 5_000;
    if (connection && binding) {
      try {
        const selected = await bounded(
          this.#readFencedTurn(connection, binding, attempt.turnId),
          boundedWait,
          "App Server deadline terminal read timed out",
        );
        if (selected.status !== "inProgress") {
          this.#applyTurn(attempt, selected);
          return;
        }
      } catch {
        // The exact interrupt and close below remain the bounded fallback.
      }
    }
    attempt.deadlineExpired = true;
    attempt.reason = "immutable App Server attempt deadline elapsed";
    try {
      await bounded(
        this.#interrupt(attempt),
        boundedWait,
        "App Server deadline interrupt timed out",
      );
    } catch {
      // Closing the one per-attempt connection below is the fallback.
    }
    await Promise.race([attempt.terminal, wait(boundedWait)]);
    if (connection && binding) {
      try {
        const selected = await bounded(
          this.#readFencedTurn(connection, binding, attempt.turnId),
          boundedWait,
          "App Server post-interrupt terminal read timed out",
        );
        if (selected.status !== "inProgress") this.#applyTurn(attempt, selected);
      } catch {
        // Missing final provider authority remains unknown after close.
      }
    }
    attempt.connectionCloseRequested = true;
    await this.#closeConnection(attempt.home);
    if (!terminalState(attempt.state))
      this.#markTerminal(
        attempt,
        "timed_out",
        attempt.providerTerminal
          ? "App Server turn reached a terminal provider state after its immutable deadline"
          : "App Server deadline elapsed without an authoritative terminal provider outcome",
      );
  }

  #attach(attempt: AppAttempt, connection: AppServerConnection): void {
    attempt.unsubscribeNotification = connection.onNotification((event) => {
      this.#notification(attempt, event);
    });
    attempt.unsubscribeRequest = connection.onRequest((request) => {
      void this.#serverRequest(attempt, connection, request);
    });
    void connection.closed.then(() => {
      void this.#recoverAfterConnectionClose(attempt, connection);
    });
  }

  async #recoverAfterConnectionClose(
    attempt: AppAttempt,
    closed: AppServerConnection,
  ): Promise<void> {
    if (this.#connections.get(attempt.home) === closed) {
      this.#connections.delete(attempt.home);
      this.#serverIdentities.delete(attempt.home);
    }
    if (attempt.connectionCloseRequested || terminalState(attempt.state)) return;
    const binding = attempt.binding;
    if (!binding) {
      this.#markTerminal(
        attempt,
        "failed",
        "App Server exited before session identity was durable",
      );
      return;
    }
    const boundedWait = this.#options.cancellationWaitMs ?? 5_000;
    try {
      const connection = await this.#connection(
        attempt.home,
        attempt.context.workspace,
        `${binding.attemptId}-terminal-read`,
      );
      try {
        const selected = await bounded(
          this.#readFencedTurn(connection, binding, attempt.turnId),
          boundedWait,
          "App Server closed-connection terminal read timed out",
        );
        if (selected.status !== "inProgress") {
          this.#applyTurn(attempt, selected);
          return;
        }
        const deadlineElapsed = Date.now() >= attempt.context.deadline.getTime();
        attempt.deadlineExpired = deadlineElapsed;
        this.#markTerminal(
          attempt,
          deadlineElapsed ? "timed_out" : "failed",
          deadlineElapsed
            ? "App Server deadline elapsed after its process exited without a terminal provider outcome"
            : "App Server process exited before an authoritative terminal provider outcome",
        );
      } finally {
        attempt.connectionCloseRequested = true;
        await this.#closeConnection(attempt.home);
      }
    } catch {
      const deadlineElapsed = Date.now() >= attempt.context.deadline.getTime();
      attempt.deadlineExpired = deadlineElapsed;
      this.#markTerminal(
        attempt,
        deadlineElapsed ? "timed_out" : "failed",
        deadlineElapsed
          ? "App Server deadline elapsed and its exact terminal provider outcome is unavailable"
          : "App Server exited and its exact terminal provider outcome is unavailable",
      );
    }
  }

  #notification(attempt: AppAttempt, event: AppServerNotification): void {
    const ids = eventIds(event);
    if (
      ids.thread !== attempt.threadId ||
      (ids.turn && attempt.turnId && ids.turn !== attempt.turnId)
    ) {
      return;
    }
    const params = record(event.params);
    if (event.method === "turn/started") {
      const turn = turnFrom(params.turn);
      if (
        !turn ||
        turn.status !== "inProgress" ||
        attempt.binding?.priorTurnIds.includes(turn.id)
      ) {
        attempt.usageStreamComplete = false;
        return;
      }
      if (!attempt.turnId) attempt.turnId = turn.id;
      return;
    }
    if (event.method === "rawResponse/completed") {
      if (!ids.turn || ids.turn !== attempt.turnId || attempt.providerTerminal) {
        attempt.usageStreamComplete = false;
        return;
      }
      const parsed = AppServerResponseUsageSchema.safeParse({
        responseId: params.responseId,
        usage: params.usage,
      });
      if (!parsed.success || attempt.responseUsage.size >= 1000) {
        attempt.usageStreamComplete = false;
        return;
      }
      const previous = attempt.responseUsage.get(parsed.data.responseId);
      if (previous && canonicalSessionJson(previous) !== canonicalSessionJson(parsed.data))
        attempt.usageStreamComplete = false;
      else attempt.responseUsage.set(parsed.data.responseId, parsed.data);
      return;
    }
    if (event.method === "thread/tokenUsage/updated") {
      if (!ids.turn || !attempt.turnId || ids.turn !== attempt.turnId || attempt.providerTerminal)
        return;
      const usage = record(params.tokenUsage);
      const tokens = (value: unknown) => {
        const raw = record(value);
        return Object.fromEntries(
          [
            "totalTokens",
            "inputTokens",
            "outputTokens",
            "cachedInputTokens",
            "cacheWriteInputTokens",
            "reasoningOutputTokens",
          ].map((name) => [
            name,
            Number.isSafeInteger(raw[name]) && Number(raw[name]) >= 0 ? Number(raw[name]) : null,
          ]),
        );
      };
      attempt.rawTokenUsage = {
        total: tokens(usage.total),
        last: tokens(usage.last),
      } as AppServerSessionCheckpoint["rawTokenUsage"];
      return;
    }
    if (event.method === "item/completed") {
      const item = record(params.item);
      if (item.type === "agentMessage") {
        const final = parseWorkerFinal(item.text);
        if (final) {
          attempt.final = final;
        } else {
          delete attempt.final;
          attempt.reason = "Codex worker returned malformed structured output";
        }
      }
      attempt.progress = event.method;
      return;
    }
    if (event.method === "turn/completed") {
      const turn = turnFrom(params.turn);
      if (!turn) {
        this.#markTerminal(
          attempt,
          "failed",
          "Codex App Server returned a malformed completed turn",
        );
        return;
      }
      this.#applyTurn(attempt, turn);
      return;
    }
    if (event.method.startsWith("item/") || event.method.includes("progress")) {
      attempt.progress = String(params.message ?? params.text ?? event.method);
    }
  }

  async #serverRequest(
    attempt: AppAttempt,
    connection: AppServerConnection,
    request: AppServerRequest,
  ): Promise<void> {
    const rejection = "Factory workers are unattended and cannot grant approvals";
    const ids = eventIds(request);
    const identityMismatch =
      ids.thread !== attempt.threadId ||
      !ids.turn ||
      (ids.turn !== undefined && attempt.turnId !== "" && ids.turn !== attempt.turnId);
    if (!identityMismatch && !attempt.turnId && ids.turn) {
      attempt.turnId = ids.turn;
      attempt.handle.metadata = { ...attempt.handle.metadata, turnId: ids.turn };
    }
    try {
      if (
        request.method === "item/commandExecution/requestApproval" ||
        request.method === "item/fileChange/requestApproval"
      ) {
        await connection.respond(request.id, { decision: "decline" });
      } else if (
        request.method === "execCommandApproval" ||
        request.method === "applyPatchApproval"
      ) {
        await connection.respond(request.id, {
          decision: { denied: { rejection } },
        });
      } else {
        await connection.respondError(request.id, -32601, rejection);
      }
    } catch {
      // The owned process will be closed below even if the response pipe failed.
    }
    if (!terminalState(attempt.state)) {
      attempt.progress = `rejected unattended server request ${request.method}`;
      attempt.reason = identityMismatch
        ? `unattended Codex server request identity did not match the fenced attempt: ${request.method}`
        : `unattended Codex server request was denied: ${request.method}`;
      await this.#abortForServerRequest(attempt, request.method);
    }
  }

  async #abortForServerRequest(attempt: AppAttempt, method: string): Promise<void> {
    try {
      await this.#interrupt(attempt);
    } catch {
      // Closing the per-attempt process below is the cancellation fallback.
    }
    attempt.connectionCloseRequested = true;
    await this.#closeConnection(attempt.home);
    this.#markTerminal(attempt, "failed", attempt.reason ?? method);
  }

  #applyTurn(attempt: AppAttempt, turn: AppServerTurn): void {
    if (turn.id !== attempt.turnId && attempt.turnId) return;
    attempt.turnId = turn.id;
    const final = finalFromItems(turn.items);
    if (
      Array.isArray(turn.items) &&
      turn.items.some((item) => record(item).type === "agentMessage")
    ) {
      if (final) attempt.final = final;
      else delete attempt.final;
    }
    if (turn.status === "inProgress") {
      attempt.state = "running";
      return;
    }
    attempt.providerTerminal = true;
    attempt.providerCompleted = turn.status === "completed";
    attempt.providerStatus = turn.status;
    if (attempt.deadlineExpired) {
      this.#markTerminal(
        attempt,
        "timed_out",
        "App Server turn reached a terminal provider state after its immutable deadline",
      );
      return;
    }
    if (turn.status === "interrupted") {
      this.#markTerminal(
        attempt,
        attempt.cancellationRequested ? "cancelled" : "failed",
        attempt.cancellationRequested
          ? "attempt cancelled by Factory"
          : (attempt.reason ?? "Codex turn was interrupted unexpectedly"),
      );
      return;
    }
    if (turn.status === "failed") {
      this.#markTerminal(attempt, "failed", turn.error?.message ?? "Codex turn failed");
      return;
    }
    if (attempt.final?.outcome === "succeeded") {
      this.#markTerminal(attempt, "succeeded");
      return;
    }
    this.#markTerminal(
      attempt,
      "failed",
      attempt.final?.summary ??
        attempt.reason ??
        "Codex turn completed without valid structured output",
    );
  }

  #markTerminal(
    attempt: AppAttempt,
    state: "succeeded" | "failed" | "cancelled" | "timed_out",
    reason?: string,
  ): void {
    if (terminalState(attempt.state)) return;
    if (attempt.deadlineTimer) {
      clearTimeout(attempt.deadlineTimer);
      delete attempt.deadlineTimer;
    }
    attempt.state = state;
    if (reason) attempt.reason = reason;
    else delete attempt.reason;
    attempt.handle.metadata = {
      ...attempt.handle.metadata,
      terminalState: state,
      terminalAt: new Date().toISOString(),
      ...(reason ? { terminalReason: reason } : {}),
    };
    attempt.resolveTerminal();
  }

  async #interrupt(attempt: AppAttempt): Promise<void> {
    if (attempt.interruptSent || !attempt.turnId) return;
    attempt.interruptSent = true;
    const connection = this.#connections.get(attempt.home);
    if (!connection) throw new Error("Codex App Server connection is unavailable");
    await connection.request("turn/interrupt", {
      threadId: attempt.threadId,
      turnId: attempt.turnId,
    });
  }

  async #closeConnection(home: string): Promise<void> {
    const connection = this.#connections.get(home);
    if (!connection) return;
    await connection.close();
    if (this.#connections.get(home) === connection) this.#connections.delete(home);
    this.#serverIdentities.delete(home);
  }

  #require(handle: BackendHandle): AppAttempt {
    if (handle.backendId !== this.capabilities.id) {
      throw new Error(`handle belongs to ${handle.backendId}, not ${this.capabilities.id}`);
    }
    const attempt = this.#attempts.get(handle.resourceId);
    if (!attempt) throw new Error(`unknown Codex thread ${handle.resourceId}`);
    return attempt;
  }
}
