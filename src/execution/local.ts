import {
  type CommandSandboxPolicy,
  STRICT_COMMAND_SANDBOX,
} from "./sandbox.js";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  assertAgentSessionCapabilities,
  assertAgentSessionRef,
  assertAgentSessionScope,
} from "../agent-session.js";
import { releaseCodexHome } from "../codex-planning-isolation.js";
import { LocalContentStore } from "../content/local.js";
import type {
  CodexModelSelection,
  ExecutionProfileEnvironment,
} from "../config.js";
import type {
  AgentHarness,
  AgentSessionRef,
  AgentSessionRequest,
  CapturedAssetSet,
  ContentRef,
  ContentStore,
  ExecutionBinding,
  ExecutionContext,
  ExecutionDriver,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionRequest,
  ExecutionResult,
  HarnessHandle,
  HarnessObservation,
  HarnessRequest,
  HarnessResult,
  WorkGraph,
  WorkItem,
} from "../contracts.js";
import { AuthenticationRequiredError } from "../contracts.js";
import {
  assertDiscoveryBody,
  assertDiscoveryOutputManifest,
  assertDiscoverySpecification,
  authenticateDiscoveryOutput,
  classifyDiscoveryOutput,
  discoverySpecificationDigest,
} from "../discovery.js";
import { assertExecutionBinding } from "../execution-profiles.js";
import {
  attachedFault,
  cancelledFault,
  classifyFaults,
  judgedAsWork,
  readWorkerJson,
  StepFault,
  workFault,
} from "../fault.js";
import { assertDiscovery } from "../graph-amendments.js";
import {
  assertAssetCaptureReceipt,
  captureAssetSets,
  importSourceAssets,
  parseProducedAssetSets,
} from "../media.js";
import { ownsPath } from "../ownership.js";
import { packageManagerUpdate } from "../package-manager-update.js";
import {
  addWorktree,
  hasUnresolvedSubprocesses,
  linuxProcessIdentity,
  pinnedGit,
  pinnedGitAsync,
  pinnedGitMagicAsync,
  pinnedGitRaw,
  processGroupExists,
  removeWorktree,
  sanitizedWorkerEnvironment,
  UnsettledSubprocessError,
} from "../process.js";
import { DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS } from "../provider-turn.js";
import {
  awaitCheckpointAdmission,
  isCheckpointAdmissionFailure,
  privateCheckpointBounds,
} from "../recovery-checkpoint.js";
import { assertPinnedNpmScripts, validateCheckout } from "../validation.js";
import type { ValidationEvidence } from "../validation-evidence.js";
import { workerReadinessReceipt } from "../worker-readiness.js";
import { workspacePackageAdditions } from "../workspace-membership.js";
import { stoppedFault } from "./attempt.js";
import { assertDurableValue } from "./checkpoint.js";
import { ClaudeAgentSdkHarness } from "./claude.js";
import { executionFault } from "./fault.js";
import {
  assertWorkerSourceFiles,
  materializeWorkerSources,
  readWorkHandoff,
  workerSourceDelivery,
} from "./harness-support.js";
import {
  checkStagedCandidate,
  scanCollectionObservation,
  scanPrivateStaging,
} from "./staged-candidate.js";
import {
  killGroup,
  launchWorker,
  observeWorker,
  stopUnrecordedWorker,
  type WorkerHandleData,
} from "./worker-process.js";

export interface LocalProfileRegistration {
  environment?: ExecutionProfileEnvironment;
  binding: ExecutionBinding;
  createHarness: () => AgentHarness;
}

type Active = {
  executionBinding?: ExecutionBinding;
  request: ExecutionRequest;
  worktree: string;
  adapterIdentity: string;
  handle: HarnessHandle;
  failure?: string;
  /** Original declaration observation; collection acceptance is separate. */
  assetManifest?: { path: ".factory-assets.json"; ref: ContentRef };
  rejectedCollection?: RejectedCollectionReceipt;
  collectedAssets?: CapturedAssetSet[];
  environmentReadiness?: {
    commitSha: string;
    worktree: string;
    evidence: ValidationEvidence;
  };
};

interface CodexSessionData {
  selectionDigest: string;
  threadId?: string;
  worker?: WorkerHandleData;
  pendingWorkerIdentity?: string;
  profileId?: string;
  nativeEof?: true;
  /** Added only by the adapter after its exact owned process group ceased. */
  workerSettled?: true;
}

interface CodexWorkerSession {
  ref: AgentSessionRef;
  root: string;
  owner: string;
  resumeThreadId?: string;
}

function codexSessionOwner(session: AgentSessionRef): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scope: session.scope,
        adapter: session.adapter,
        identity: session.identity,
      }),
    )
    .digest("hex");
}

export class CodexHarness implements AgentHarness {
  readonly sessionCapabilities = { resumeRoles: ["implementation"] } as const;
  readonly sessionAdapter = "codex";
  readonly capabilities = {
    effectAdmission: "controller-checkpoint-v1",
    childAgents: "disabled",
    protocolVersion: 1,
    worktree: "factory-owned-read-write",
    head: "preserve",
    lifecycle: "restart-safe-durable-handle",
    publication: "controller-only",
    assetSets: true,
    authentication: "local-environment",
    discovery: {
      schema: "factory.repository-inventory/v1",
      worktree: "read-only",
      children: "disabled",
      network: "off",
      freshConversation: true,
    },
  } as const;

  constructor(
    private credentialDirectory: string,
    private network: "host" | "off",
    private model: CodexModelSelection,
    private allowedSecretNames: string[] = [],
    private providerTurnIdleTimeoutMs = DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ) {}

  private require(handle: HarnessHandle): WorkerHandleData {
    const data = handle.data;
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Invalid Codex harness handle");
    const value = data as Partial<WorkerHandleData>;
    const root = resolve(join(dirname(this.credentialDirectory), "harness"));
    if (
      !Number.isSafeInteger(value.pid) ||
      typeof value.startTime !== "string" ||
      !value.startTime ||
      typeof value.requestPath !== "string" ||
      typeof value.resultPath !== "string" ||
      typeof value.logPath !== "string" ||
      ![value.requestPath, value.resultPath, value.logPath].every((path) =>
        resolve(path).startsWith(`${root}${sep}`),
      )
    )
      throw new Error("Invalid Codex harness handle");
    return value as WorkerHandleData;
  }

  private get harnessRoot(): string {
    return join(dirname(this.credentialDirectory), "harness");
  }

  private sessionRoot(identity: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(identity))
      throw new Error("Invalid Codex session identity");
    return join(this.harnessRoot, "sessions", identity);
  }

  private selectionDigest(request: HarnessRequest): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          model: this.model,
          network: this.network,
          allowedSecretNames: [...this.allowedSecretNames].sort(),
          executionBinding: request.item.executionBinding,
          ...(request.childAgents && { childAgents: request.childAgents }),
        }),
      )
      .digest("hex");
  }

  private async workerSession(
    request: HarnessRequest,
  ): Promise<CodexWorkerSession | undefined> {
    if (!request.session) return undefined;
    const { scope, identity, retained } = request.session;
    assertAgentSessionScope(scope);
    if (scope.role !== "implementation" || scope.itemId !== request.item.id)
      throw new Error(
        "Codex implementation session belongs to another role or Work Item",
      );
    const selectionDigest = this.selectionDigest(request);
    const root = this.sessionRoot(identity);
    let resumeThreadId: string | undefined;
    if (retained) {
      assertAgentSessionRef(retained, scope);
      if (
        retained.adapter !== this.sessionAdapter ||
        retained.identity !== identity ||
        !isDeepStrictEqual(retained.scope, scope)
      )
        throw new Error(
          "Codex continuation does not match the current session scope",
        );
      const data = retained.data as Partial<CodexSessionData> | undefined;
      if (!data || data.selectionDigest !== selectionDigest)
        throw new Error(
          "Codex continuation model or permission selection changed",
        );
      if (
        retained.status !== "ready" ||
        typeof data.threadId !== "string" ||
        !data.threadId ||
        data.nativeEof !== true ||
        data.workerSettled !== true ||
        !data.worker
      )
        throw new Error("Codex continuation has no confirmed completed turn");
      // The adapter's ready receipt already establishes predecessor group
      // cessation. Its historical PID may now belong to another process;
      // current attempts remain fenced by their own durable worker handles.
      resumeThreadId = data.threadId;
    } else if (existsSync(root)) {
      // A start lost before its handle was saved can have created this home.
      // Its owner and submitted native turn remain unknown; never reuse it.
      throw new Error(
        "Codex session home already exists without a settled continuation",
      );
    }
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    const ref: AgentSessionRef = {
      scope: structuredClone(scope),
      adapter: this.sessionAdapter,
      identity,
      turn: (retained?.turn ?? 0) + 1,
      status: "in-flight",
      executionIdentity: request.attemptId,
      data: {
        selectionDigest,
        ...(request.item.executionBinding && {
          profileId: request.item.executionBinding.id,
        }),
        ...(resumeThreadId && { threadId: resumeThreadId }),
      },
    };
    return {
      ref,
      root,
      owner: codexSessionOwner(ref),
      ...(resumeThreadId && { resumeThreadId }),
    };
  }

  /**
   * Start a fresh worker for the attempt identity. Whatever an earlier
   * unrecorded start of it spawned is stopped first (#585).
   */
  async start(request: HarnessRequest): Promise<HarnessHandle> {
    assertWorkerSourceFiles(request);
    if ((request.item.kind === "discovery") !== Boolean(request.discovery))
      throw new Error(
        "Codex discovery requires its explicit read-only execution input",
      );
    if (request.discovery) {
      assertDiscoverySpecification(request.item.discovery);
      assertDiscoveryOutputManifest(request.discovery.manifest);
      assertDiscoveryBody(request.discovery.body);
      const { manifest, body } = request.discovery;
      if (
        request.item.discovery.mode !== "semantic" ||
        manifest.status !== "complete" ||
        manifest.producer.itemId !== request.item.id ||
        manifest.specificationDigest !==
          discoverySpecificationDigest(request.item.discovery) ||
        manifest.body.bytes !== Buffer.byteLength(JSON.stringify(body)) ||
        manifest.body.digest !==
          createHash("sha256").update(JSON.stringify(body)).digest("hex")
      )
        throw new Error(
          "Codex discovery input differs from its bound inventory",
        );
      await verifyDiscoveryExport(request.worktree, body.entries);
    }
    if (
      request.discovery &&
      (request.session ||
        request.environment ||
        request.workerReadiness ||
        request.sourceAssets?.length ||
        request.selectedAssets?.length)
    )
      throw new Error(
        "Codex discovery cannot inherit implementation capabilities",
      );
    const identity = request.attemptId ?? randomUUID();
    const boundRequest = { ...request, attemptId: identity };
    const session = await this.workerSession(boundRequest);
    return {
      identity,
      data: await launchWorker({
        root: this.harnessRoot,
        identity,
        label: "Codex harness",
        script: fileURLToPath(new URL("./worker.js", import.meta.url)),
        input: codexWorkerInput(
          boundRequest,
          this.network,
          request.discovery ? [] : this.allowedSecretNames,
          this.model,
          this.providerTurnIdleTimeoutMs,
          session,
        ),
        env: sanitizedWorkerEnvironment(
          this.credentialDirectory,
          request.discovery ? [] : this.allowedSecretNames,
        ),
      }),
    };
  }

  originalCollectionReturn(handle: HarnessHandle) {
    return {
      provenance: "controller-worker-result" as const,
      path: this.require(handle).resultPath,
      root: this.harnessRoot,
      attemptId: handle.identity,
    };
  }

  /** Stop what a start of `identity` spawned before its handle was recorded. */
  async cancelUnrecorded(identity: string): Promise<void> {
    await stopUnrecordedWorker(this.harnessRoot, identity, "Codex harness");
  }

  async observe(handle: HarnessHandle): Promise<HarnessObservation> {
    const data = this.require(handle);
    const observed = observeWorker(data, "Codex harness");
    if (observed.state === "running" || !existsSync(data.resultPath))
      return observed;
    const result = readWorkerJson(data.resultPath) as Record<string, unknown>;
    if (result.session === undefined) return observed;
    await this.cancel(handle);
    const session = this.sessionReceipt(data, result.session);
    return { ...observed, session };
  }

  private sessionReceipt(
    data: WorkerHandleData,
    supplied: unknown,
  ): AgentSessionRef {
    assertAgentSessionRef(supplied);
    const input = readWorkerJson(data.requestPath) as {
      request?: HarnessRequest;
      session?: CodexWorkerSession;
    };
    const native = supplied.data as CodexSessionData | undefined;
    if (
      !input.session ||
      supplied.status !== "ready" ||
      supplied.adapter !== this.sessionAdapter ||
      supplied.identity !== input.session.ref.identity ||
      supplied.turn !== input.session.ref.turn ||
      supplied.executionIdentity !== input.session.ref.executionIdentity ||
      !isDeepStrictEqual(supplied.scope, input.session.ref.scope) ||
      native?.selectionDigest !==
        (input.session.ref.data as CodexSessionData).selectionDigest ||
      native?.profileId !==
        (input.session.ref.data as CodexSessionData).profileId ||
      native?.nativeEof !== true ||
      typeof native.threadId !== "string" ||
      !native.threadId ||
      (input.session.resumeThreadId &&
        native.threadId !== input.session.resumeThreadId)
    )
      throw workFault("Codex completion has an invalid session receipt");
    const session = {
      ...supplied,
      data: { ...native, worker: data, workerSettled: true as const },
    };
    assertDurableValue(session, "Codex session receipt");
    return session;
  }

  async cancel(handle: HarnessHandle): Promise<void> {
    const data = this.require(handle);
    try {
      const current = linuxProcessIdentity(data.pid);
      if (
        current &&
        (current.startTime !== data.startTime || current.group !== data.pid)
      )
        throw new Error("Worker identity changed before cancellation");
      if (current || processGroupExists(data.pid))
        await killGroup(data.pid, "Codex harness");
    } catch (error) {
      throw new UnsettledSubprocessError(
        "Worker cessation remains unresolved; checkout retained",
        { cause: error },
      );
    }
    rmSync(`${data.requestPath}.codex-home`, { recursive: true, force: true });
  }

  async collect(handle: HarnessHandle): Promise<HarnessResult> {
    const data = this.require(handle);
    for (;;) {
      const observed = await this.observe(handle);
      if (observed.state === "running") {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      // Terminal observations are flushed before the result is published.
      // Settle the durable owned group before collection can admit another attempt.
      await this.cancel(handle);
      if (observed.state !== "complete") {
        if (observed.authentication)
          throw new AuthenticationRequiredError(
            observed.detail ?? "Codex authentication required",
            observed.authentication,
          );
        throw workFault(observed.detail ?? "Codex harness worker failed");
      }
      const result: unknown = readWorkerJson(data.resultPath);
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw workFault("Harness result is not an object");
      const value = result as Record<string, unknown>;
      if (
        value.state !== "complete" ||
        !value.evidence ||
        typeof value.evidence !== "object" ||
        Array.isArray(value.evidence)
      )
        throw workFault("Harness completion result lacks structured evidence");
      const assets =
        value.assets === undefined
          ? undefined
          : parseProducedAssetSets(value.assets);
      let session: AgentSessionRef | undefined;
      if (value.session !== undefined) {
        session = this.sessionReceipt(data, value.session);
      }
      return { evidence: value.evidence, assets, ...(session && { session }) };
    }
  }

  async releaseSession(session: AgentSessionRef): Promise<void> {
    assertAgentSessionRef(session);
    if (session.adapter !== this.sessionAdapter)
      throw new Error("Cannot release another adapter's conversation");
    const data = session.data as Partial<CodexSessionData> | undefined;
    if (data?.pendingWorkerIdentity) {
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(data.pendingWorkerIdentity))
        throw new Error("Invalid pending Codex session worker identity");
      await this.cancelUnrecorded(data.pendingWorkerIdentity);
    }
    if (data?.worker && data.workerSettled !== true)
      await this.cancel({ identity: session.identity, data: data.worker });
    const root = this.sessionRoot(session.identity);
    if (!existsSync(root)) return;
    // The isolation helper authenticates the retained home before removal;
    // never allow an opaque provider reference to choose a deletion path.
    releaseCodexHome(root, codexSessionOwner(session));
  }
}

export function codexWorkerInput(
  request: HarnessRequest,
  network: "host" | "off",
  allowedSecretNames: string[],
  model: CodexModelSelection,
  providerTurnIdleTimeoutMs = DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  session?: CodexWorkerSession,
): {
  request: HarnessRequest;
  network: "host" | "off";
  allowedSecretNames: string[];
  model: CodexModelSelection;
  providerTurnIdleTimeoutMs: number;
  session?: CodexWorkerSession;
} {
  return {
    request,
    network,
    allowedSecretNames: [...allowedSecretNames],
    model: {
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      ...(model.serviceTier && { serviceTier: model.serviceTier }),
    },
    providerTurnIdleTimeoutMs,
    ...(session && { session }),
  };
}

async function verifyBoundInput(path: string, ref: ContentRef): Promise<void> {
  if (
    !existsSync(path) ||
    !lstatSync(path).isFile() ||
    realpathSync(path) !== resolve(path)
  )
    throw workFault("Bound asset input is missing or redirected");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== ref.bytes || hash.digest("hex") !== ref.digest)
    throw workFault("Bound asset input differs from its captured digest");
}

async function verifyDiscoveryExport(
  worktree: string,
  entries: { path: string; content: ContentRef }[],
): Promise<void> {
  if (
    !existsSync(worktree) ||
    !lstatSync(worktree).isDirectory() ||
    realpathSync(worktree) !== resolve(worktree)
  )
    throw workFault("Discovery export is missing or redirected");
  const expected = new Set(entries.map((entry) => entry.path));
  const inspect = (directory: string, relative = ""): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const shown = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path);
      if (name === ".git")
        throw workFault("Discovery export contains Git metadata");
      if (stat.isDirectory()) inspect(path, shown);
      else if (!stat.isFile() || !expected.has(shown))
        throw workFault(
          "Read-only discovery export contains an unexpected source or link",
        );
    }
  };
  inspect(worktree);
  for (const entry of entries) {
    const path = resolve(worktree, entry.path);
    if (!path.startsWith(`${resolve(worktree)}${sep}`))
      throw workFault("Discovery export escapes its selected source scope");
    await verifyBoundInput(path, entry.content);
  }
}

function assertDurableHandle(handle: HarnessHandle): void {
  if (!handle || typeof handle.identity !== "string" || !handle.identity)
    throw new Error("Harness returned no durable identity");
  if (handle.data !== undefined)
    assertDurableValue(handle.data, "Harness handle data");
}

async function preserveControllerAssetDestinations(
  worktree: string,
  assets: CapturedAssetSet[],
): Promise<string[]> {
  const destinations = [
    ...new Set(
      assets.flatMap((set) => set.members.map((member) => member.destination)),
    ),
  ];
  for (const destination of destinations) {
    const source = assets
      .flatMap((set) => set.inputs ?? [])
      .find(
        (input) =>
          (input.binding.kind ?? "repository") === "repository" &&
          input.binding.path === destination,
      );
    const path = join(worktree, destination);
    if (!existsSync(path)) {
      if (source)
        throw workFault(
          `Worker removed controller-owned asset destination ${destination}`,
        );
      continue;
    }
    if (!source)
      throw workFault(
        `Worker wrote controller-owned asset destination ${destination}`,
      );
    await verifyBoundInput(path, source.ref);
  }
  return destinations;
}

/** Beside the worktree: never among the files the worker returns. */
function validationLfsStore(worktree: string): string {
  return `${worktree}.validation-lfs`;
}

/** Where worker Validate creates each run's checkout, beside the worktree. */
export function workerValidationRoot(worktree: string): string {
  return `${worktree}.validation`;
}

/** The worktree or its staged validation bytes remain to be removed. */
function executionDirectoryRemains(worktree: string): boolean {
  return existsSync(worktree) || existsSync(validationLfsStore(worktree));
}

/** Controller-owned staging that collection reads but never commits. */
const PRIVATE_STAGING = [
  ".factory-discovery.json",
  ".factory-handoff.json",
  ".factory-inputs",
  ".factory-assets.json",
];
/** Whether a Git-relative path is private staging, which is never a delivery candidate. */
export function privateStagingPath(path: string): boolean {
  return [...PRIVATE_STAGING, ".factory-media"].some(
    (name) => path === name || path.startsWith(`${name}/`),
  );
}
/**
 * Pathspecs that keep present private staging out of `git add -A -- .`.
 * Git rejects an explicit ignored path even when it is an exclusion, and
 * already ignored untracked staging cannot be added by the root pathspec.
 */
export function privateStagingExclusions(
  worktree: string,
  names: readonly string[] = [...PRIVATE_STAGING, ".factory-media"],
): string[] {
  return names
    .filter(
      (name) =>
        pinnedGitRaw(
          worktree,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          name,
        ).length > 0,
    )
    .map((name) => `:(exclude,literal)${name}`);
}
/** The first path under the worktree Factory cannot read, if any. */
function firstUnreadable(directory: string, relative = ""): string | undefined {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return relative || ".";
  }
  for (const name of names) {
    if (!relative && name === ".git") continue;
    const path = join(directory, name);
    const shown = relative ? `${relative}/${name}` : name;
    const type = lstatSync(path);
    if (type.isDirectory()) {
      const inner = firstUnreadable(path, shown);
      if (inner) return inner;
    } else if (type.isFile()) {
      try {
        accessSync(path, constants.R_OK);
      } catch {
        return shown;
      }
    }
  }
  return undefined;
}

/** The longest worker final response carried into a failure detail. */
const FINAL_RESPONSE_LIMIT = 2000;

/**
 * An empty result still has the worker's own account of why it changed
 * nothing; the failure, its diagnosis and the stop message carry it.
 */
function noChangeDetail(evidence: unknown): string {
  const response = (evidence as { finalResponse?: unknown } | null)
    ?.finalResponse;
  const text = typeof response === "string" ? response.trim() : "";
  const shown =
    text.length > FINAL_RESPONSE_LIMIT
      ? `${text.slice(0, FINAL_RESPONSE_LIMIT)}...`
      : text;
  return shown
    ? `Worker produced no repository change. Worker's final response: ${shown}`
    : "Worker produced no repository change";
}

/** A failed collection observation grants no result, validation or reuse authority. */
interface RejectedCollectionBody {
  availability: "available" | "unavailable";
  digest?: string;
  bytes?: number;
  ref?: ContentRef;
  reason?: "secret-ineligible" | "unsafe-staging" | "not-collected";
}
export interface RejectedCollectionReceipt {
  schemaVersion: 1;
  attemptId: string;
  requestDigest: string;
  rawReturn: RejectedCollectionBody & {
    provenance: "controller-worker-result" | "managed-original-artifact";
    identity: string;
  };
  fault: { kind: "work"; detail: string };
  candidate:
    | {
        availability: "available";
        baseSha: string;
        commitSha: string;
        treeSha: string;
        paths: string[];
      }
    | {
        availability: "unavailable";
        baseSha: string;
        reason: "collector-safety-rejected";
      };
  staging: (RejectedCollectionBody & { path: string })[];
  media:
    | { availability: "unavailable"; reason: "not-collected" }
    | { availability: "available"; sets: CapturedAssetSet[] };
}
const collectionDigest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const rejectedStaging = [
  ".factory-assets.json",
  ".factory-handoff.json",
  ".factory-discovery.json",
];
function rejectionRecord(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid rejected collection observation");
  return value as Record<string, unknown>;
}
export function assertRejectedCollectionReceipt(
  value: unknown,
  request: ExecutionRequest,
  executionIdentity: string,
): asserts value is RejectedCollectionReceipt {
  const receipt = rejectionRecord(value, [
    "schemaVersion",
    "attemptId",
    "requestDigest",
    "rawReturn",
    "fault",
    "candidate",
    "staging",
    "media",
  ]);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.attemptId !== executionIdentity ||
    request.attemptId !== executionIdentity ||
    receipt.requestDigest !== collectionDigest(JSON.stringify(request))
  )
    throw new Error(
      "Rejected collection differs from its exact admitted request",
    );
  const body = (value: unknown, extra: string[]) => {
    const record = rejectionRecord(value, [
      "availability",
      "digest",
      "bytes",
      "ref",
      "reason",
      ...extra,
    ]);
    if (
      record.digest !== undefined &&
      (typeof record.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.digest))
    )
      throw new Error("Invalid rejected collection body digest");
    if (
      record.bytes !== undefined &&
      (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0)
    )
      throw new Error("Invalid rejected collection body size");
    if (record.availability === "available") {
      const ref = rejectionRecord(record.ref, ["digest", "bytes", "mediaType"]);
      if (
        !record.digest ||
        record.bytes === undefined ||
        ref.digest !== record.digest ||
        ref.bytes !== record.bytes ||
        typeof ref.mediaType !== "string" ||
        !ref.mediaType ||
        record.reason !== undefined
      )
        throw new Error(
          "Rejected collection body reference differs from its original",
        );
    } else if (
      record.availability !== "unavailable" ||
      record.ref !== undefined ||
      !["secret-ineligible", "unsafe-staging", "not-collected"].includes(
        String(record.reason),
      )
    )
      throw new Error("Rejected collection availability is invalid");
    return record;
  };
  const raw = body(receipt.rawReturn, ["provenance", "identity"]);
  if (
    !["controller-worker-result", "managed-original-artifact"].includes(
      String(raw.provenance),
    ) ||
    typeof raw.identity !== "string" ||
    !raw.identity ||
    !raw.digest ||
    raw.bytes === undefined ||
    (raw.availability === "unavailable" &&
      !["secret-ineligible", "unsafe-staging"].includes(String(raw.reason)))
  )
    throw new Error(
      "Rejected collection lacks its literal original return identity",
    );
  const fault = rejectionRecord(receipt.fault, ["kind", "detail"]);
  if (
    fault.kind !== "work" ||
    typeof fault.detail !== "string" ||
    !fault.detail.trim()
  )
    throw new Error("Rejected collection lacks its original work fault");
  const candidate = rejectionRecord(receipt.candidate, [
    "availability",
    "baseSha",
    "commitSha",
    "treeSha",
    "paths",
    "reason",
  ]);
  if (candidate.baseSha !== request.baseSha)
    throw new Error("Rejected collection baseline differs");
  if (candidate.availability === "available") {
    if (
      typeof candidate.commitSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(candidate.commitSha) ||
      typeof candidate.treeSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(candidate.treeSha) ||
      !Array.isArray(candidate.paths) ||
      new Set(candidate.paths).size !== candidate.paths.length ||
      candidate.paths.some(
        (path) =>
          typeof path !== "string" ||
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path
            .split("/")
            .some((part: string) => !part || part === "." || part === "..") ||
          PRIVATE_STAGING.some(
            (name) => path === name || path.startsWith(name + "/"),
          ) ||
          path === ".factory-media" ||
          path.startsWith(".factory-media/") ||
          !ownsPath(path, request.item.ownedPaths),
      ) ||
      candidate.reason !== undefined
    )
      throw new Error("Rejected collection candidate is invalid");
  } else if (
    candidate.availability !== "unavailable" ||
    candidate.reason !== "collector-safety-rejected" ||
    candidate.commitSha !== undefined ||
    candidate.treeSha !== undefined ||
    candidate.paths !== undefined
  )
    throw new Error("Rejected collection candidate availability is invalid");
  if (
    !Array.isArray(receipt.staging) ||
    receipt.staging.length > rejectedStaging.length ||
    new Set(receipt.staging.map((entry) => (entry as { path?: unknown }).path))
      .size !== receipt.staging.length
  )
    throw new Error("Rejected staging inventory is invalid");
  for (const entry of receipt.staging) {
    const record = body(entry, ["path"]);
    if (!rejectedStaging.includes(String(record.path)))
      throw new Error("Rejected staging path is invalid");
  }
  const media = rejectionRecord(receipt.media, [
    "availability",
    "reason",
    "sets",
  ]);
  if (media.availability === "available") {
    if (
      !Array.isArray(media.sets) ||
      media.reason !== undefined ||
      media.sets.length === 0
    )
      throw new Error("Invalid retained rejected media observation");
    for (const set of media.sets)
      assertAssetCaptureReceipt(set as CapturedAssetSet);
  } else if (
    media.availability !== "unavailable" ||
    media.reason !== "not-collected" ||
    media.sets !== undefined
  )
    throw new Error("Rejected media is not an accepted collection");
}
export async function authenticateRejectedCollectionReceipt(
  receipt: RejectedCollectionReceipt,
  request: ExecutionRequest,
  identity: string,
  checkout: string,
  store: ContentStore,
): Promise<void> {
  assertRejectedCollectionReceipt(receipt, request, identity);
  for (const body of [receipt.rawReturn, ...receipt.staging])
    if (body.availability === "available") await store.verify(body.ref!);
  if (receipt.media.availability === "available") {
    const unavailableDeclaration = receipt.staging.find(
      (entry) =>
        entry.path === ".factory-assets.json" &&
        entry.availability === "unavailable",
    );
    for (const set of receipt.media.sets) {
      if (
        set.manifestRef &&
        set.manifestRef.digest !== unavailableDeclaration?.digest
      )
        await store.verify(set.manifestRef);
      for (const member of set.members) await store.verify(member.ref);
      for (const input of set.inputs ?? []) await store.verify(input.ref);
    }
  }
  if (receipt.candidate.availability === "available") {
    const candidate = receipt.candidate;
    if (
      pinnedGit(
        checkout,
        "show",
        "-s",
        "--format=%P%n%T%n%ae%n%s",
        candidate.commitSha,
      ) !==
        `${request.baseSha}\n${candidate.treeSha}\n${FACTORY_EMAIL}\nFactory rejected collection observation` ||
      JSON.stringify(
        pinnedGitRaw(
          checkout,
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          request.baseSha,
          candidate.commitSha,
        )
          .toString("utf8")
          .split("\0")
          .filter(Boolean),
      ) !== JSON.stringify(candidate.paths)
    )
      throw new Error("Rejected candidate differs from its bound observation");
    for (const path of candidate.paths) {
      if (!ownsPath(path, request.item.ownedPaths))
        throw new Error("Rejected candidate exceeds the admitted ownership");
      const entry = pinnedGitRaw(
        checkout,
        "ls-tree",
        "-z",
        candidate.treeSha,
        "--",
        path,
      ).toString("utf8");
      if (entry && !/^(100644|100755) blob [a-f0-9]{40}\t/.test(entry))
        throw new Error("Rejected candidate includes an unsafe Git entry");
    }
  }
}
/** Freeze permitted evidence of a settled rejection; forbidden bytes remain unavailable. */
export async function freezeRejectedCollection(args: {
  checkout: string;
  worktree: string;
  request: ExecutionRequest;
  store: ContentStore;
  error: unknown;
  capturedAssets?: CapturedAssetSet[];
  rawReturn: {
    provenance: "controller-worker-result" | "managed-original-artifact";
    identity: string;
    bytes: Buffer;
  };
}): Promise<RejectedCollectionReceipt> {
  const bounds = privateCheckpointBounds();
  if (!bounds)
    throw new Error(
      "Rejected collection freezing requires its admitted private checkpoint scope",
    );
  const fault = attachedFault(args.error);
  if (fault?.kind !== "work" || !args.request.attemptId)
    throw new Error(
      "Rejected collection lacks a settled original work failure",
    );
  // Failure text can contain worker quotations; it crosses the same privacy gate.
  await scanCollectionObservation(
    args.worktree,
    args.checkout,
    Buffer.from(fault.evidence.detail),
  );
  let usedBytes = 0,
    usedFiles = 0;
  const deadline = Date.now() + bounds.timeoutMs;
  const bound = (bytes: number) => {
    usedBytes += bytes;
    usedFiles++;
    if (
      usedBytes > bounds.maxBytes ||
      usedFiles > bounds.maxFiles ||
      Date.now() > deadline
    )
      throw new Error(
        "Rejected collection exceeds the admitted checkpoint bounds",
      );
  };
  const retain = async (
    bytes: Buffer,
    mediaType: string,
  ): Promise<RejectedCollectionBody> => {
    bound(bytes.length);
    const identity = { digest: collectionDigest(bytes), bytes: bytes.length };
    try {
      await scanCollectionObservation(args.worktree, args.checkout, bytes);
    } catch (error) {
      if (attachedFault(error)?.kind === "work")
        return {
          availability: "unavailable",
          ...identity,
          reason: "secret-ineligible",
        };
      throw error;
    }
    const ref = await args.store.put(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { mediaType },
    );
    return { availability: "available", ...identity, ref };
  };
  // Managed originals encode file bodies (JSON/base64 or tar). Literal scanning
  // cannot establish admission of all decoded members after collection failed.
  let original: RejectedCollectionBody;
  if (args.rawReturn.provenance === "managed-original-artifact") {
    bound(args.rawReturn.bytes.length);
    original = {
      availability: "unavailable",
      digest: collectionDigest(args.rawReturn.bytes),
      bytes: args.rawReturn.bytes.length,
      reason: "unsafe-staging",
    };
  } else original = await retain(args.rawReturn.bytes, "application/json");
  const rawReturn = {
    ...original,
    provenance: args.rawReturn.provenance,
    identity: args.rawReturn.identity,
  };
  const staging: RejectedCollectionReceipt["staging"] = [];
  for (const path of rejectedStaging) {
    const file = join(args.worktree, path);
    if (!lstatSync(file, { throwIfNoEntry: false })) continue;
    if (
      !lstatSync(file).isFile() ||
      realpathSync(file) !== file ||
      pinnedGit(args.worktree, "ls-files", "--stage", "--", path)
    ) {
      staging.push({
        path,
        availability: "unavailable",
        reason: "unsafe-staging",
      });
      continue;
    }
    if (lstatSync(file).size > bounds.maxBytes - usedBytes)
      throw new Error(
        "Rejected staging exceeds its admitted checkpoint bounds",
      );
    staging.push({
      path,
      ...(await retain(readFileSync(file), "application/json")),
    });
  }
  let candidate: RejectedCollectionReceipt["candidate"] = {
    availability: "unavailable",
    baseSha: args.request.baseSha,
    reason: "collector-safety-rejected",
  };
  try {
    if (pinnedGit(args.worktree, "rev-parse", "HEAD") !== args.request.baseSha)
      throw workFault("Rejected worker changed its admitted HEAD");
    const prospective = [
      ...new Set(
        [
          ...pinnedGitRaw(
            args.worktree,
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            "HEAD",
          )
            .toString("utf8")
            .split("\0"),
          ...pinnedGitRaw(
            args.worktree,
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          )
            .toString("utf8")
            .split("\0"),
        ].filter(Boolean),
      ),
    ].filter(
      (path) =>
        ![...PRIVATE_STAGING, ".factory-media"].some(
          (name) => path === name || path.startsWith(name + "/"),
        ),
    );
    let prospectiveBytes = 0;
    if (prospective.length + usedFiles > bounds.maxFiles)
      throw new Error("Rejected candidate exceeds the admitted file bound");
    for (const path of prospective) {
      if (!ownsPath(path, args.request.item.ownedPaths))
        throw workFault("Rejected candidate exceeds ownership");
      const file = resolve(args.worktree, path);
      if (!file.startsWith(`${resolve(args.worktree)}${sep}`))
        throw workFault("Rejected candidate has an unsafe path");
      const info = lstatSync(file, { throwIfNoEntry: false });
      prospectiveBytes += info?.isFile() ? info.size : 0;
    }
    if (prospectiveBytes + usedBytes > bounds.maxBytes)
      throw new Error("Rejected candidate exceeds the admitted byte bound");
    await pinnedGitMagicAsync(
      args.worktree,
      "add",
      "-A",
      "--",
      ".",
      ...privateStagingExclusions(args.worktree, [
        ...PRIVATE_STAGING,
        ".factory-media",
      ]),
    );
    for (const name of [...PRIVATE_STAGING, ".factory-media"])
      if (
        pinnedGitRaw(args.worktree, "ls-files", "--stage", "-z", "--", name)
          .length
      )
        await pinnedGitAsync(args.worktree, "reset", "HEAD", "--", name);
    const paths = await checkStagedCandidate(
      args.worktree,
      args.checkout,
      args.request.item.ownedPaths,
      undefined,
      {
        maxBytes: bounds.maxBytes - usedBytes,
        maxFiles: bounds.maxFiles - usedFiles,
        deadline,
      },
    );
    if (Date.now() > deadline)
      throw new Error(
        "Rejected collection exceeds its admitted checkpoint deadline",
      );
    const treeSha = pinnedGit(args.worktree, "write-tree");
    const commitSha = await pinnedGitAsync(
      args.worktree,
      "-c",
      "user.name=Factory",
      "-c",
      `user.email=${FACTORY_EMAIL}`,
      "commit-tree",
      treeSha,
      "-p",
      args.request.baseSha,
      "-m",
      "Factory rejected collection observation",
    );
    candidate = {
      availability: "available",
      baseSha: args.request.baseSha,
      commitSha: commitSha.trim(),
      treeSha,
      paths,
    };
  } catch (error) {
    if (attachedFault(error)?.kind !== "work") throw error;
  }
  const receipt: RejectedCollectionReceipt = {
    schemaVersion: 1,
    attemptId: args.request.attemptId,
    requestDigest: collectionDigest(JSON.stringify(args.request)),
    rawReturn,
    fault: { kind: "work", detail: fault.evidence.detail },
    candidate,
    staging,
    media: args.capturedAssets?.length
      ? {
          availability: "available",
          sets: structuredClone(args.capturedAssets),
        }
      : { availability: "unavailable", reason: "not-collected" },
  };
  await authenticateRejectedCollectionReceipt(
    receipt,
    args.request,
    args.request.attemptId,
    args.checkout,
    args.store,
  );
  return receipt;
}

export const FACTORY_EMAIL = "factory@users.noreply.github.com";
const collectionMessage = (request: ExecutionRequest) =>
  `Factory: ${request.item.title}`;

/** Shared exact collection boundary for local work and imported managed bytes. */
export async function collectWorktreeResult(
  checkout: string,
  worktree: string,
  request: ExecutionRequest,
  store: ContentStore,
  result: HarnessResult,
  checkpointResult?: (result: ExecutionResult) => Promise<void>,
  checkpointManifest?: (manifest: {
    path: ".factory-assets.json";
    ref: ContentRef;
  }) => Promise<void>,
  checkpointAssets?: (assets: CapturedAssetSet[]) => Promise<void>,
): Promise<ExecutionResult> {
  const handoffPath = join(worktree, ".factory-handoff.json");
  const handoffNotes = judgedAsWork(() =>
    readWorkHandoff(
      worktree,
      request.handoffPeers,
      request.item.acceptance.length,
    ),
  );
  if (handoffNotes) {
    if (
      pinnedGit(worktree, "ls-tree", "HEAD", "--", ".factory-handoff.json") ||
      pinnedGit(worktree, "ls-files", "--stage", "--", ".factory-handoff.json")
    )
      throw workFault("Handoff manifest must be untracked private staging");
    await scanPrivateStaging(worktree, checkout, ".factory-handoff.json");
  }
  const discoveryPath = join(worktree, ".factory-discovery.json");
  let discovery: import("../contracts.js").WorkDiscovery | undefined;
  if (existsSync(discoveryPath)) {
    if (
      !lstatSync(discoveryPath).isFile() ||
      realpathSync(discoveryPath) !== discoveryPath
    )
      throw workFault(
        "Discovery manifest must be a regular private staging file",
      );
    discovery = judgedAsWork(() => {
      const parsed = JSON.parse(readFileSync(discoveryPath, "utf8"));
      assertDiscovery(parsed);
      return parsed;
    });
    if (
      pinnedGit(worktree, "ls-tree", "HEAD", "--", ".factory-discovery.json") ||
      pinnedGit(
        worktree,
        "ls-files",
        "--stage",
        "--",
        ".factory-discovery.json",
      )
    )
      throw workFault("Discovery manifest must be untracked private staging");
  }
  // A collection interrupted after its own commit is undone to the staged
  // candidate and checked again from the top.
  if (
    pinnedGit(worktree, "rev-parse", "HEAD") !== request.baseSha &&
    pinnedGit(worktree, "rev-parse", "HEAD^") === request.baseSha &&
    pinnedGit(worktree, "log", "-1", "--format=%ae%n%s") ===
      `${FACTORY_EMAIL}\n${collectionMessage(request)}`
  )
    await pinnedGitAsync(worktree, "reset", "--soft", request.baseSha);
  if (pinnedGit(worktree, "rev-parse", "HEAD") !== request.baseSha) {
    throw workFault(
      "Worker changed HEAD; expected uncommitted changes at exact base",
    );
  }
  const assets = await captureAssetSets(
    store,
    worktree,
    request.item,
    result.assets ?? [],
    result.evidence,
    request.sourceAssets,
    checkpointManifest,
    checkout,
    checkpointAssets,
  );
  for (const [index, source] of (request.selectedAssets ?? []).entries()) {
    await verifyBoundInput(
      join(worktree, ".factory-inputs", `selected-${index}`),
      source.ref,
    );
  }
  if (request.sourceBaseSha && request.item.inputSources?.length) {
    const delivery = workerSourceDelivery(request, worktree)!;
    for (const source of delivery.files)
      await verifyBoundInput(join(delivery.root, source.file), {
        digest: source.digest,
        bytes: source.bytes,
        mediaType: "text/plain",
      });
  }
  const privateSources = (request.sourceAssets ?? []).filter(
    (source) =>
      source.binding.kind === "local" ||
      source.binding.kind === "github-attachment",
  );
  for (const [index, source] of privateSources.entries()) {
    await verifyBoundInput(
      join(worktree, ".factory-inputs", `source-${index}`),
      source.ref,
    );
  }
  if (
    request.item.expectedOutputRoles?.length &&
    assets.length < (request.item.minimumAssetSets ?? 1)
  )
    throw workFault("Media Work Item did not produce the requested AssetSets");
  const assetDestinations = await preserveControllerAssetDestinations(
    worktree,
    assets,
  );
  // Private staging is never staged, so its bytes never reach the object
  // database. Bound inputs and the manifest stay on disk until the commit
  // lands: a transient fault before then repeats collection from the top and
  // verifies the same bytes again.
  try {
    await pinnedGitMagicAsync(
      worktree,
      "add",
      "-A",
      "--",
      ".",
      ...privateStagingExclusions(worktree, PRIVATE_STAGING),
    );
  } catch (error) {
    // Git cannot index what the worker left unreadable; any other failure
    // keeps the classification it already has.
    const unreadable = attachedFault(error)
      ? undefined
      : firstUnreadable(worktree);
    if (unreadable)
      throw workFault(`Worker left an unreadable path: ${unreadable}`, {
        cause: error,
      });
    throw error;
  }
  if (assetDestinations.length)
    await pinnedGitAsync(worktree, "reset", "HEAD", "--", ...assetDestinations);
  const acceptedIgnoredLinks: string[] = [];
  const paths = await checkStagedCandidate(
    worktree,
    checkout,
    request.item.ownedPaths,
    acceptedIgnoredLinks,
  );
  // An empty result is still wrong, but a staged discovery is the worker's
  // account of why: it rides on the fault so Factory reviews it (#820). A
  // continued attempt that left its starting tree as it was resubmits the
  // refused result, so it is empty too (#1313).
  const unchangedContinuation =
    !assets.length &&
    paths.length > 0 &&
    request.retainedFailedResult !== undefined &&
    pinnedGit(worktree, "write-tree") ===
      continuedRetainedTree(checkout, worktree, request);
  if ((!paths.length && !assets.length) || unchangedContinuation)
    throw new StepFault({
      kind: "work",
      evidence: {
        detail: noChangeDetail(result.evidence),
        ...(discovery ? { discovery } : {}),
      },
    });
  if (paths.length)
    await pinnedGitAsync(
      worktree,
      "-c",
      "user.name=Factory",
      "-c",
      `user.email=${FACTORY_EMAIL}`,
      "commit",
      "-m",
      collectionMessage(request),
    );
  const commit = pinnedGit(worktree, "rev-parse", "HEAD");
  const treeSha = pinnedGit(worktree, "rev-parse", "HEAD^{tree}");
  const handoffSources: NonNullable<ExecutionResult["handoff"]>["sources"] = [];
  for (const path of new Set(
    handoffNotes?.flatMap((note) => note.paths) ?? [],
  )) {
    const entry = pinnedGitRaw(
      worktree,
      "ls-tree",
      "-z",
      treeSha,
      "--",
      path,
    ).toString("utf8");
    const blob = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(entry)?.[2];
    if (!blob) continue; // A missing or nonregular source never authenticates bytes.
    const bytes = pinnedGitRaw(worktree, "cat-file", "blob", blob);
    const ref = await store.put(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { mediaType: "application/octet-stream" },
    );
    handoffSources.push({ path, ref });
  }
  const collected: ExecutionResult = {
    changeRef: commit,
    treeSha,
    evidence: result.evidence,
    ...(discovery ? { discovery } : {}),
    ...(handoffNotes
      ? { handoff: { notes: handoffNotes, sources: handoffSources } }
      : {}),
    collection: { acceptedIgnoredLinks },
    assets,
  };
  await checkpointResult?.(collected);
  if (discovery) rmSync(discoveryPath);
  if (handoffNotes) rmSync(handoffPath);
  rmSync(join(worktree, ".factory-inputs"), { recursive: true, force: true });
  rmSync(join(worktree, ".factory-assets.json"), { force: true });
  return collected;
}

const retainedFailedUnavailable =
  "\nRetained failed committed-result context is unavailable or could not be authenticated in this checkout. Do not infer prior source contents; unfinished uncommitted edits remain unavailable.";
/** The retained result as inspect-only context. */
const retainedFailedReachable = (
  retained: NonNullable<ExecutionRequest["retainedFailedResult"]>,
): string =>
  `\nRetained failed committed result, verified reachable in this checkout: ${JSON.stringify(retained)}. This is unaccepted implementation context, not normative source, an accepted base or acceptance proof. You may inspect currently owned files from this exact Git tree and reuse their implementation in owned edits while making the diagnosed correction. Preserve the checkout's current accepted HEAD; do not checkout, reset or cherry-pick the failed commit. Missing prior unfinished uncommitted edits remain unavailable. All current validation and independent acceptance apply anew; old command passes do not prove this result.`;
const retainedFailedNotContinued = (
  retained: NonNullable<ExecutionRequest["retainedFailedResult"]>,
): string =>
  `${retainedFailedReachable(retained)} Its files are not in this checkout: the accepted base or this Work Item's ownership changed since that result, and its changes do not apply cleanly within current ownership, so this attempt starts from the accepted base.`;
const retainedFailedContinued = (
  retained: NonNullable<ExecutionRequest["retainedFailedResult"]>,
): string =>
  `\nRetained failed committed result, verified in this checkout: ${JSON.stringify(retained)}. Its files are already in your working tree: this attempt continues from that result, as uncommitted changes on top of the accepted base HEAD. It is unaccepted implementation context, not normative source or acceptance proof. Fix exactly what the findings and any diagnosed correction refuse, and keep the rest. Do not checkout, reset or cherry-pick the failed commit or the base; your result is collected from this working tree as usual. Missing prior unfinished uncommitted edits remain unavailable. All current validation and independent acceptance apply anew; old command passes do not prove this result.`;

/** The worker brief suffixes the local driver may append for this request. */
export function retainedFailedResultBriefs(
  retainedResult: ExecutionRequest["retainedFailedResult"],
): string[] {
  return retainedResult
    ? [
        retainedFailedContinued(retainedResult),
        retainedFailedNotContinued(retainedResult),
        retainedFailedUnavailable,
      ]
    : [""];
}

/** The retained commit and tree are exactly these objects in this checkout's repository. */
function retainedResultAuthentic(
  checkout: string,
  worktree: string,
  retained: NonNullable<ExecutionRequest["retainedFailedResult"]>,
): boolean {
  try {
    return (
      /^[a-f0-9]{40}$/.test(retained.commitSha) &&
      /^[a-f0-9]{40}$/.test(retained.treeSha) &&
      pinnedGit(worktree, "rev-parse", `${retained.commitSha}^{commit}`) ===
        retained.commitSha &&
      pinnedGit(worktree, "rev-parse", `${retained.commitSha}^{tree}`) ===
        retained.treeSha &&
      pinnedGit(
        worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ) ===
        pinnedGit(
          checkout,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        )
    );
  } catch {
    return false;
  }
}

/**
 * The tree a retried or repaired attempt starts from (#1313): the refused
 * candidate on its own base, or its clean three-way move onto a newer base.
 * Either way its changes from the current base must stay within current
 * ownership, so a peer's merged work is never reverted and an ownership
 * change never makes the attempt fail after a paid run. Undefined when the
 * result cannot continue on this base.
 */
function continuedRetainedTree(
  checkout: string,
  worktree: string,
  request: Pick<ExecutionRequest, "retainedFailedResult" | "baseSha" | "item">,
): string | undefined {
  const retained = request.retainedFailedResult;
  if (!retained || !retainedResultAuthentic(checkout, worktree, retained))
    return undefined;
  try {
    const parent = pinnedGit(
      worktree,
      "rev-parse",
      "--verify",
      `${retained.commitSha}^`,
    );
    const tree =
      parent === request.baseSha
        ? retained.treeSha
        : pinnedGit(
            worktree,
            "merge-tree",
            "--write-tree",
            `--merge-base=${parent}`,
            request.baseSha,
            retained.commitSha,
          ).split("\n")[0]!;
    if (!/^[a-f0-9]{40}$/.test(tree)) return undefined;
    const changed = pinnedGit(
      worktree,
      "diff-tree",
      "-r",
      "--name-only",
      "-z",
      `${request.baseSha}^{tree}`,
      tree,
    )
      .split("\0")
      .filter(Boolean);
    return changed.every((path) => ownsPath(path, request.item.ownedPaths))
      ? tree
      : undefined;
  } catch {
    // A conflicting move (merge-tree exits 1) or an unreadable object.
    return undefined;
  }
}

/**
 * Render only authenticated local Git context, never an execution base or
 * proof, and the tree the attempt continues from when it can.
 */
function retainedFailedResultStart(
  checkout: string,
  worktree: string,
  request: Pick<ExecutionRequest, "retainedFailedResult" | "baseSha" | "item">,
): { brief: string; tree?: string } {
  const retained = request.retainedFailedResult;
  if (!retained) return { brief: "" };
  if (!retainedResultAuthentic(checkout, worktree, retained))
    return { brief: retainedFailedUnavailable };
  const tree = continuedRetainedTree(checkout, worktree, request);
  return tree
    ? { brief: retainedFailedContinued(retained), tree }
    : { brief: retainedFailedNotContinued(retained) };
}

/** Admit only the selected harness's native turn; preserve prior fresh-only ownership. */
export function checkpointWorkerSession(
  session: AgentSessionRequest | undefined,
  options: {
    adapter: string;
    supportsResume: boolean;
    /** This turn starts a new native conversation although the harness can resume. */
    fresh?: boolean;
    executionIdentity: string;
    profileId?: string;
  },
  checkpoint: ExecutionContext["checkpointSession"],
): AgentSessionRequest | undefined {
  if (!session) return undefined;
  assertAgentSessionScope(session.scope);
  if (session.retained) assertAgentSessionRef(session.retained, session.scope);
  if (
    session.retained?.status === "in-flight" ||
    (session.retained?.currentTurn &&
      session.retained.currentTurn.resources !== "settled")
  )
    throw new Error("Unsettled worker conversation cannot dispatch fresh work");
  const resumes = options.supportsResume && !options.fresh;
  // This fresh worker has its own durable execution handle. The old native
  // receipt remains unchanged and addressable by supported disposal.
  if (!resumes && session.retained?.status === "ready") return undefined;
  checkpoint?.({
    scope: structuredClone(session.scope),
    adapter: options.adapter,
    identity: session.identity,
    turn: (session.retained?.turn ?? 0) + 1,
    status: resumes ? "in-flight" : "unavailable",
    executionIdentity: options.executionIdentity,
    data: resumes
      ? {
          ...(session.retained?.data as Record<string, unknown> | undefined),
          pendingWorkerIdentity: options.executionIdentity,
          ...(options.profileId && { profileId: options.profileId }),
        }
      : {
          reason: options.fresh
            ? "An attempt that continues a refused candidate starts a fresh native conversation"
            : "The selected harness does not support native conversation continuation",
          ...(options.profileId && { profileId: options.profileId }),
        },
  });
  return resumes ? session : undefined;
}

async function cessationAdmission(context?: ExecutionContext): Promise<void> {
  try {
    await context?.admitEffect?.("before-effect");
  } catch (error) {
    if (!isCheckpointAdmissionFailure(error)) throw error;
  }
}

export class LocalExecutionDriver implements ExecutionDriver {
  readonly childAgents = "disabled" as const;
  readonly effectAdmission = "controller-checkpoint-v1" as const;
  readonly readonlyDiscovery = "selector-bound-read-only-v1" as const;
  readonly sessionCapabilities = { resumeRoles: ["implementation"] } as const;
  readonly freshCheckoutReadiness = true as const;
  readonly retainedFailedResultContext = true as const;
  private active = new Map<string, Active>();
  private starting = new Map<string, Promise<ExecutionHandle>>();

  private require(handle: ExecutionHandle): Active {
    const active =
      this.active.get(handle.identity) ?? (handle.data as Active | undefined);
    if ((active as unknown as { phase?: string })?.phase === "prepared")
      throw new StepFault({
        kind: "decision",
        evidence: [],
        question:
          "Local worker launch has a retained prepared intent; preserve its owner and use supported cancellation before any replacement",
      });
    if (!active || handle.provider !== "local")
      throw new Error("Unknown local execution handle");
    if (
      !resolve(active.worktree).startsWith(`${resolve(this.workRoot)}${sep}`) ||
      active.request.attemptId !== handle.identity ||
      active.adapterIdentity !==
        (active.executionBinding?.adapter ?? this.adapterIdentity)
    )
      throw new Error(
        "Local execution handle is outside owned state or uses another adapter",
      );
    if (this.profiles && !active.executionBinding)
      throw new Error("Durable execution profile binding is missing");
    this.resolveHarness(active.request.item, active.executionBinding);
    return active;
  }

  private profileHarnesses = new Map<string, AgentHarness>();
  private resolveHarness(
    item: WorkItem,
    persisted?: ExecutionBinding,
  ): AgentHarness {
    if (!this.profiles) {
      if (item.executionProfile || item.executionBinding || persisted)
        throw new Error("Execution profiles are not configured");
      return this.harness!;
    }
    const id = item.executionProfile?.id;
    const registration = id ? this.profiles.get(id) : undefined;
    if (!registration)
      throw new Error(
        `Assigned execution profile ${id} is unavailable; no fallback is available`,
      );
    assertExecutionBinding(item, registration.binding);
    if (
      persisted &&
      JSON.stringify(persisted) !== JSON.stringify(registration.binding)
    )
      throw new Error("Durable execution profile binding changed");
    return this.profileHarness(id!, registration);
  }

  /** The profile's harness, created and checked on first use. */
  private profileHarness(
    id: string,
    registration: LocalProfileRegistration,
  ): AgentHarness {
    let harness = this.profileHarnesses.get(id);
    if (!harness) {
      harness = registration.createHarness();
      this.assertCapabilities(harness, registration.binding.adapter);
      this.profileHarnesses.set(id, harness);
    }
    return harness;
  }

  constructor(
    private checkout: string,
    private workRoot: string,
    private harness: AgentHarness | undefined,
    private concurrency: number,
    private contentStore: ContentStore,
    private adapterIdentity: string,
    private profiles?: ReadonlyMap<string, LocalProfileRegistration>,
    private captureSettings?: {
      repository: string;
      policy?: import("../capture.js").CapturePolicy;
      configDigest: string;
    },
    private commandSandbox: CommandSandboxPolicy = STRICT_COMMAND_SANDBOX,
  ) {
    if (profiles)
      this.profiles = new Map(
        [...profiles].map(([id, registration]) => [
          id,
          {
            ...registration,
            binding: structuredClone(registration.binding),
            environment: structuredClone(registration.environment),
          },
        ]),
      );
    else if (harness) this.assertCapabilities(harness, adapterIdentity);
    else throw new Error("Local execution requires a harness or profiles");
  }

  private assertCapabilities(
    harness: AgentHarness,
    adapterIdentity: string,
  ): void {
    const capabilities = harness.capabilities;
    if (
      capabilities?.protocolVersion !== 1 ||
      capabilities.worktree !== "factory-owned-read-write" ||
      capabilities.head !== "preserve" ||
      capabilities.lifecycle !== "restart-safe-durable-handle" ||
      capabilities.publication !== "controller-only" ||
      capabilities.assetSets !== true ||
      !["local-environment", "adapter-owned", "none"].includes(
        capabilities.authentication,
      )
    )
      throw new Error(
        `Harness adapter ${adapterIdentity} does not satisfy the local AgentHarness capability contract`,
      );
    if (harness.sessionCapabilities !== undefined) {
      assertAgentSessionCapabilities(harness.sessionCapabilities);
      if (
        harness.sessionCapabilities.resumeRoles.some(
          (role) => role !== "implementation",
        )
      )
        throw new Error(
          `Harness adapter ${adapterIdentity} can declare only implementation session resume`,
        );
      if (
        harness.sessionCapabilities.resumeRoles.length &&
        (!harness.sessionAdapter || !harness.releaseSession)
      )
        throw new Error(
          `Harness adapter ${adapterIdentity} declares incomplete session continuation`,
        );
    }
  }

  private assertDiscoveryCapability(
    item: WorkItem,
    harness: AgentHarness,
  ): void {
    if (item.kind !== "discovery") return;
    assertDiscoverySpecification(item.discovery);
    if (item.discovery.mode === "inventory") return;
    const capability = harness.capabilities.discovery;
    if (
      !capability ||
      capability.schema !== item.discovery.schema ||
      capability.worktree !== "read-only" ||
      capability.children !== "disabled" ||
      capability.network !== "off" ||
      capability.freshConversation !== true
    )
      throw new Error(
        `Assigned execution adapter cannot enforce this read-only discovery contract; no provider call was made`,
      );
    if (
      item.sourceAssets?.length ||
      item.validation.length ||
      item.ownedPaths.length
    )
      throw new Error(
        "Discovery cannot declare source ownership, setup commands or assets",
      );
  }

  private async removeExecutionDirectory(path: string): Promise<void> {
    if (existsSync(join(path, ".git")))
      await removeWorktree(this.checkout, path);
    else rmSync(path, { recursive: true, force: true });
    rmSync(validationLfsStore(path), { recursive: true, force: true });
    // Each run removes its own checkout; one it retained keeps the parent.
    try {
      rmdirSync(workerValidationRoot(path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  }

  @classifyFaults(executionFault)
  async preflight(graph: WorkGraph): Promise<void> {
    for (const item of graph.items) {
      if (item.kind === "discovery" && item.discovery?.mode === "inventory")
        continue;
      if (item.kind !== "qa" && item.kind !== "aggregate")
        this.assertDiscoveryCapability(item, this.resolveHarness(item));
    }
  }

  @classifyFaults(executionFault)
  async availableSlots(): Promise<number> {
    return Math.max(0, this.concurrency - this.active.size);
  }

  /**
   * Starting an attempt is idempotent: a repeat in this process returns the
   * running attempt, and the handle is checkpointed before start returns. A
   * start that crashed before its checkpoint left a worktree and perhaps a
   * worker: both are stopped and removed, and the attempt starts fresh in
   * this same call. The crash was already counted once by the paid step, so
   * nothing here counts it again (#585).
   */
  @classifyFaults(executionFault)
  async start(
    request: ExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle> {
    const identity = request.attemptId ?? randomUUID();
    if (this.starting.has(identity))
      throw new Error("Local attempt already has an owned start in progress");
    const operation = Promise.resolve().then(() =>
      this.startOwned({ ...request, attemptId: identity }, context),
    );
    this.starting.set(identity, operation);
    try {
      return await operation;
    } finally {
      if (this.starting.get(identity) === operation)
        this.starting.delete(identity);
    }
  }

  async settleStartingAttempt(attemptId: string): Promise<void> {
    // Joining is sequencing, not a stopped receipt. The original start caller
    // records its error; cancellation must still verify every owned resource.
    await this.starting.get(attemptId)?.then(
      () => undefined,
      () => undefined,
    );
  }

  private async startOwned(
    request: ExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle> {
    const harness = this.resolveHarness(request.item);
    if (
      request.childAgents !== undefined &&
      (request.childAgents !== "disabled" ||
        harness.capabilities.childAgents !== "disabled")
    )
      throw new Error(
        "Assigned execution adapter cannot enforce the requested native child-agent prohibition; no provider call was made",
      );
    this.assertDiscoveryCapability(request.item, harness);
    if (request.item.kind === "discovery") {
      if (
        !request.discovery ||
        request.item.discovery?.mode !== "semantic" ||
        request.session ||
        request.environmentReadiness ||
        request.sourceAssets?.length ||
        request.selectedAssets?.length ||
        request.retainedFailedResult
      )
        throw new Error(
          "Semantic discovery requires its bound inventory and a fresh read-only request",
        );
      if (
        request.discovery.manifest.source.commitSha !== request.baseSha ||
        request.discovery.manifest.status !== "complete"
      )
        throw new Error(
          "Semantic discovery cannot execute from an incomplete or differently bound inventory",
        );
    } else if (request.discovery)
      throw new Error("Unrequested discovery execution input");
    if (
      context?.checkpointedEffects &&
      harness.capabilities.effectAdmission !== "controller-checkpoint-v1"
    )
      throw new Error(
        "Configured Git persistence requires a harness with enforced controller effect admission",
      );
    const identity = request.attemptId ?? randomUUID();
    const session = request.session
      ? structuredClone(request.session)
      : undefined;
    if (session && !context?.checkpointSession)
      throw new Error(
        "Local session execution requires a durable session checkpoint callback",
      );
    const running = this.active.get(identity);
    if (running) return { provider: "local", identity, data: running };
    if (session) {
      assertAgentSessionScope(session.scope);
      if (
        session.scope.role !== "implementation" ||
        session.scope.itemId !== request.item.id
      )
        throw new Error("Local execution session belongs to another Work Item");
      if (session.retained)
        assertAgentSessionRef(session.retained, session.scope);
      if (
        session.retained?.status === "in-flight" ||
        (session.retained?.currentTurn &&
          session.retained.currentTurn.resources !== "settled")
      )
        throw new Error(
          "Unsettled worker conversation cannot dispatch fresh work",
        );
    }
    const worktree = join(this.workRoot, identity);
    mkdirSync(this.workRoot, { recursive: true });
    if (existsSync(worktree)) {
      if (context?.checkpointedEffects)
        throw new Error(
          "Prepared local checkout is retained; reconcile or cancel its owner before another launch",
        );
      await harness.cancelUnrecorded?.(identity);
      await this.removeExecutionDirectory(worktree);
    }
    if (context?.cancelled())
      throw cancelledFault("Cancelled before the worker started");
    const verified = pinnedGit(
      this.checkout,
      "rev-parse",
      "--verify",
      `${request.baseSha}^{commit}`,
    );
    if (verified !== request.baseSha)
      throw new Error("Execution base does not resolve exactly");
    if (request.discovery)
      mkdirSync(worktree, { recursive: false, mode: 0o700 });
    else await addWorktree(this.checkout, worktree, request.baseSha);
    try {
      const discoveryBody = request.discovery
        ? await authenticateDiscoveryOutput({
            checkout: this.checkout,
            specification: request.item.discovery!,
            manifest: request.discovery.manifest,
            store: this.contentStore,
          })
        : undefined;
      if (discoveryBody) {
        for (const entry of discoveryBody.entries) {
          const path = resolve(worktree, entry.path);
          if (
            !path.startsWith(`${resolve(worktree)}${sep}`) ||
            entry.path.split("/").includes(".git")
          )
            throw new Error(
              "Discovery export path escapes the selected source scope",
            );
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          await this.contentStore.materialize(entry.content, path);
        }
      }
      let environmentReadiness: ValidationEvidence | undefined;
      if (request.environmentReadiness) {
        const readiness = request.environmentReadiness;
        let previous = -1;
        const checks = readiness.validationIndices.map((index) => {
          if (
            !Number.isSafeInteger(index) ||
            index <= previous ||
            !request.item.validation[index]
          )
            throw new Error(
              "Worker readiness requires ordered authorized validation rows",
            );
          previous = index;
          return request.item.validation[index]!;
        });
        if (
          JSON.stringify(readiness.workspacePackageAdditions) !==
            JSON.stringify(
              workspacePackageAdditions(request.objectiveBody ?? ""),
            ) ||
          readiness.packageManagerUpdate !==
            packageManagerUpdate(request.objectiveBody ?? "")
        )
          throw new Error(
            "Worker readiness differs from pinned Objective package authority",
          );
        assertPinnedNpmScripts(
          this.checkout,
          readiness.acceptedBaseSha,
          request.baseSha,
          checks.map((check) => check.command),
          {
            sourceDeclared: checks
              .filter((check) => check.provenance === "source-declared")
              .map((check) => check.command),
            predecessorSha: request.baseSha,
            workspacePackageAdditions: readiness.workspacePackageAdditions,
            packageManagerUpdate: readiness.packageManagerUpdate,
          },
        );
        environmentReadiness = await validateCheckout(
          worktree,
          join(this.workRoot, "environment-preflight", identity),
          request.baseSha,
          pinnedGit(worktree, "rev-parse", "HEAD^{tree}"),
          checks.map((check) => check.command),
          (entry) =>
            context?.observeReadiness?.({
              ...entry,
              workerIdentity: identity,
              index: readiness.validationIndices[entry.index]!,
              command: checks[entry.index]!.command,
              baseSha: request.baseSha,
              treeSha: pinnedGit(worktree, "rev-parse", "HEAD^{tree}"),
              worktree,
              source:
                checks[entry.index]!.source ?? checks[entry.index]!.provenance,
            }),
          undefined,
          readiness.lfsMembers,
          this.contentStore,
          readiness.acceptedBaseSha,
          false,
          undefined,
          undefined,
          // assertPinnedNpmScripts checked these commands' inputs above.
          { ...this.commandSandbox, packageInputsVerified: true },
        );
        if (context?.cancelled())
          throw cancelledFault(
            "Cancelled after worker environment preparation",
          );
      }
      const sourceAssets = request.discovery
        ? []
        : await importSourceAssets(
            this.contentStore,
            worktree,
            request.item,
            request.objectiveBody,
          );
      const inputRoot = join(worktree, ".factory-inputs");
      const privateSources = sourceAssets.filter(
        (source) =>
          source.binding.kind === "local" ||
          source.binding.kind === "github-attachment",
      );
      const selected = request.selectedAssets ?? [];
      if (privateSources.length || selected.length)
        mkdirSync(inputRoot, { recursive: true, mode: 0o700 });
      const boundSources = await Promise.all(
        privateSources.map(async (source, index) => {
          const path = join(inputRoot, `source-${index}`);
          await this.contentStore.materialize(source.ref, path);
          return { ...source, path };
        }),
      );
      const boundSelected = await Promise.all(
        selected.map(async (asset, index) => {
          await this.contentStore.verify(asset.ref);
          const path = join(inputRoot, `selected-${index}`);
          await this.contentStore.materialize(asset.ref, path);
          return { ...asset, path };
        }),
      );
      // Worker validation restores the selected LFS bytes controller
      // validation restores. Only those objects are staged, verified, in a
      // private store outside the worktree; the worker verifies them again.
      const lfsStore = validationLfsStore(worktree);
      rmSync(lfsStore, { recursive: true, force: true });
      const lfsMembers = request.validationLfsMembers ?? [];
      if (lfsMembers.length) {
        const staged = new LocalContentStore(lfsStore);
        for (const member of lfsMembers) {
          const ref = {
            digest: member.digest,
            bytes: member.bytes,
            mediaType: member.mediaType,
          };
          const copy = await staged.put(await this.contentStore.open(ref), ref);
          if (copy.digest !== ref.digest || copy.bytes !== ref.bytes)
            throw new Error(
              `Selected LFS bytes differ from their reference: ${member.destination}`,
            );
        }
      }
      const environment =
        !request.discovery && request.item.executionProfile
          ? this.profiles?.get(request.item.executionProfile.id)?.environment
          : undefined;
      const retainedStart = retainedFailedResultStart(
        this.checkout,
        worktree,
        request,
      );
      const failedContext = retainedStart.brief;
      // An authenticated refused candidate is the attempt's starting tree:
      // its files land in the working tree and index while HEAD stays at the
      // accepted base, so collection and ownership checks are unchanged (#1313).
      const continuesCandidate = retainedStart.tree !== undefined;
      if (retainedStart.tree)
        pinnedGit(worktree, "read-tree", "-u", "--reset", retainedStart.tree);
      const admittedSession = checkpointWorkerSession(
        session,
        {
          adapter:
            harness.sessionAdapter ??
            request.item.executionBinding?.adapter ??
            this.adapterIdentity,
          supportsResume:
            harness.sessionCapabilities?.resumeRoles.includes(
              "implementation",
            ) === true,
          fresh:
            continuesCandidate &&
            harness.candidateContinuationSession === "fresh",
          executionIdentity: identity,
          profileId: request.item.executionBinding?.id,
        },
        context?.checkpointSession,
      );
      const workerRequest = { ...request };
      if (!admittedSession) delete workerRequest.session;
      // Readiness proved on the base tree does not carry to a continued
      // candidate's working tree.
      const workerReadiness =
        environmentReadiness && !continuesCandidate
          ? workerReadinessReceipt({
              request,
              workerIdentity: identity,
              worktree,
              validationRoot: join(
                this.workRoot,
                "environment-preflight",
                identity,
              ),
              evidence: environmentReadiness,
            })
          : undefined;
      context?.observeReadinessOffer?.({
        workerIdentity: identity,
        status: workerReadiness?.commands.some((entry) => entry.reusable)
          ? "bound-current"
          : "ineligible",
        eligibleCommandCount:
          workerReadiness?.commands.filter((entry) => entry.reusable).length ??
          0,
        ...(workerReadiness && { receiptDigest: workerReadiness.digest }),
      });
      const managerUpdate = packageManagerUpdate(request.objectiveBody ?? "");
      const sourceDelivery = request.discovery
        ? undefined
        : materializeWorkerSources(worktree, request);
      const preparedHarnessRequest: HarnessRequest = {
        ...(sourceDelivery && {
          sourceBaseSha: request.sourceBaseSha,
          sourceDelivery,
        }),
        ...(request.handoffPeers && {
          handoffPeers: structuredClone(request.handoffPeers),
        }),
        ...(request.childAgents && { childAgents: request.childAgents }),
        ...(!request.discovery &&
          request.conventions && { conventions: request.conventions }),
        ...(request.discovery &&
          discoveryBody && {
            discovery: {
              manifest: structuredClone(request.discovery.manifest),
              body: discoveryBody,
            },
          }),
        ...(workerReadiness && { workerReadiness }),
        ...(admittedSession && { session: admittedSession }),
        ...(request.captureContext &&
          this.captureSettings && {
            capture: {
              ...(this.captureSettings.policy !== undefined && {
                policy: this.captureSettings.policy,
              }),
              context: {
                repository: this.captureSettings.repository,
                ...request.captureContext,
                itemId: request.item.id,
                attemptId: request.captureContext.attemptId ?? identity,
                invocationId: identity,
                providerAttempt: 1,
                phase: "implementation",
                adapter:
                  request.item.executionBinding?.adapter ??
                  this.adapterIdentity,
                configured: {
                  provider: this.adapterIdentity,
                  model: "not-exposed",
                },
                configDigest:
                  request.captureContext.configDigest ??
                  this.captureSettings.configDigest,
                sourceDigest: createHash("sha256")
                  .update(request.objectiveBody ?? "")
                  .digest("hex"),
              },
            },
          }),
        ...(environment && { environment: structuredClone(environment) }),
        item: { ...request.item, brief: request.item.brief + failedContext },
        ...(managerUpdate !== undefined && {
          packageManagerUpdate: managerUpdate,
        }),
        worktree,
        attemptId: identity,
        sourceAssets: sourceAssets.map(
          (source) =>
            boundSources.find((bound) => bound.binding === source.binding) ??
            source,
        ),
        selectedAssets: boundSelected,
        ...(lfsMembers.length && {
          validationLfs: {
            members: structuredClone(lfsMembers),
            store: lfsStore,
          },
        }),
        commandSandbox: structuredClone(this.commandSandbox),
      };
      const preparedHandle: ExecutionHandle = {
        provider: "local",
        identity,
        data: {
          phase: "prepared",
          request: structuredClone({
            ...workerRequest,
            attemptId: identity,
            sourceAssets,
          }),
          worktree,
          adapterIdentity:
            request.item.executionBinding?.adapter ?? this.adapterIdentity,
          ...(request.item.executionBinding
            ? {
                executionBinding: structuredClone(
                  request.item.executionBinding,
                ),
              }
            : {}),
          ...(environmentReadiness && {
            environmentReadiness: {
              commitSha: request.baseSha,
              worktree,
              evidence: environmentReadiness,
            },
          }),
          preparedHarnessRequest: structuredClone(preparedHarnessRequest),
        },
      };
      if (context?.checkpointedEffects) context.checkpoint(preparedHandle);
      try {
        await context?.admitEffect?.("before-effect");
      } catch (error) {
        if (isCheckpointAdmissionFailure(error) && context?.checkpointedEffects)
          context.checkpoint({
            ...preparedHandle,
            data: {
              ...(preparedHandle.data as object),
              admissionBlockedAt: new Date().toISOString(),
            },
          });
        throw error;
      }
      if (context?.cancelled())
        throw cancelledFault("Cancelled before native worker dispatch");
      const handle = await harness.start(preparedHarnessRequest);
      assertDurableHandle(handle);
      const active = {
        request: structuredClone({
          ...workerRequest,
          attemptId: identity,
          sourceAssets,
        }),
        worktree,
        ...(environmentReadiness && {
          environmentReadiness: {
            commitSha: request.baseSha,
            worktree,
            evidence: environmentReadiness,
          },
        }),
        adapterIdentity:
          request.item.executionBinding?.adapter ?? this.adapterIdentity,
        ...(request.item.executionBinding
          ? { executionBinding: structuredClone(request.item.executionBinding) }
          : {}),
        handle,
      };
      this.active.set(identity, active);
      const started = { provider: "local", identity, data: active };
      context?.checkpoint(started);
      await context?.admitEffect?.("settled");
      return started;
    } catch (error) {
      if (isCheckpointAdmissionFailure(error)) throw error;
      this.active.delete(identity);
      if (!hasUnresolvedSubprocesses())
        await this.removeExecutionDirectory(worktree);
      throw error;
    }
  }

  /**
   * Stop an attempt whose start was never recorded: a worker this process
   * still runs is cancelled, a worker a crashed start spawned is found by
   * its identity and stopped, and the worktree is removed.
   */
  @classifyFaults(executionFault)
  async cancelUnrecorded(
    attemptId: string,
    context?: ExecutionContext,
  ): Promise<void> {
    await this.settleStartingAttempt(attemptId);
    await cessationAdmission(context);
    const running = this.active.get(attemptId);
    if (running) {
      await this.cancel({
        provider: "local",
        identity: attemptId,
        data: running,
      });
      this.active.delete(attemptId);
    }
    for (const harness of this.harnesses())
      await harness.cancelUnrecorded?.(attemptId);
    const worktree = join(this.workRoot, attemptId);
    if (
      resolve(worktree).startsWith(`${resolve(this.workRoot)}${sep}`) &&
      executionDirectoryRemains(worktree)
    ) {
      await context?.admitEffect?.("explicit");
      await this.removeExecutionDirectory(worktree);
    }
  }

  /** Every harness this driver can start a worker with. */
  private harnesses(): AgentHarness[] {
    if (!this.profiles) return [this.harness as AgentHarness];
    return [...this.profiles].map(([id, registration]) =>
      this.profileHarness(id, registration),
    );
  }

  /**
   * The handle to continue with, or undefined once the attempt is confirmed
   * stopped without a result (a settled dead worker or an interrupted
   * start). A collected result, a running worker and a finished worker whose
   * result is still in its worktree are continued.
   */
  @classifyFaults(executionFault)
  async find(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle | undefined> {
    const data = handle.data as Partial<Settled> | undefined;
    if (data?.result) return handle;
    const rejection = handle.data as Active | undefined;
    if (rejection?.rejectedCollection) {
      await authenticateRejectedCollectionReceipt(
        rejection.rejectedCollection,
        rejection.request,
        handle.identity,
        this.checkout,
        this.contentStore,
      );
      return handle;
    }
    if (data?.stopped !== undefined) {
      this.unavailableSession(handle, context);
      return undefined;
    }
    if (this.active.has(handle.identity)) return handle;
    if ((data as { phase?: string })?.phase === "prepared")
      throw new StepFault({
        kind: "decision",
        evidence: [],
        question:
          "Local launch outcome is unresolved; preserve the prepared request and use supported cancellation before replacement",
      });
    const active = this.require(handle);
    if (existsSync(active.worktree)) return handle;
    const harness = this.resolveHarness(
      active.request.item,
      active.executionBinding,
    );
    // A vanished checkout does not establish that its native process stopped.
    // Retain a live owner; a replacement is admitted only after cancellation
    // proves cessation through the existing process-group contract.
    if ((await harness.observe(active.handle)).state === "running")
      return handle;
    await cessationAdmission(context);
    await harness.cancel(active.handle);
    this.unavailableSession(handle, context);
    return undefined;
  }

  private unavailableSession(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): void {
    const active = handle.data as Active | undefined;
    const session = active?.request?.session;
    if (!session || !active) return;
    const harness = this.resolveHarness(
      active.request.item,
      active.executionBinding,
    );
    if (!harness.sessionCapabilities?.resumeRoles.includes("implementation"))
      return;
    context?.checkpointSession?.({
      scope: structuredClone(session.scope),
      adapter: harness.sessionAdapter ?? active.adapterIdentity,
      identity: session.identity,
      turn: (session.retained?.turn ?? 0) + 1,
      status: "unavailable",
      executionIdentity: handle.identity,
      data: {
        ...(session.retained?.data as Record<string, unknown> | undefined),
        pendingWorkerIdentity: handle.identity,
        ...(active.executionBinding && {
          profileId: active.executionBinding.id,
        }),
        reason:
          "The owned worker ceased without a retained completed-turn receipt",
      },
    });
  }

  @classifyFaults(executionFault)
  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    const settled = handle.data as Partial<Settled> | undefined;
    if (settled?.result) return { state: "complete" };
    const rejection = handle.data as Active | undefined;
    if (rejection?.rejectedCollection) {
      await authenticateRejectedCollectionReceipt(
        rejection.rejectedCollection,
        rejection.request,
        handle.identity,
        this.checkout,
        this.contentStore,
      );
      return {
        state: "failed",
        detail: rejection.rejectedCollection.fault.detail,
      };
    }
    if (settled?.stopped !== undefined)
      return { state: "failed", interrupted: true, detail: settled.stopped };
    const active = this.require(handle);
    return this.resolveHarness(
      active.request.item,
      active.executionBinding,
    ).observe(active.handle);
  }

  @classifyFaults(executionFault)
  async cancel(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<void> {
    await this.settleStartingAttempt(handle.identity);
    const settled = handle.data as Partial<Settled> | undefined;
    // An ended attempt retains its original session receipt; cancellation must
    // not allocate another unavailable turn after that receipt was released.
    if (
      settled?.result ||
      settled?.stopped !== undefined ||
      (handle.data as Active | undefined)?.rejectedCollection
    ) {
      return;
    }
    if (
      (settled as { phase?: string })?.phase === "prepared" &&
      !this.active.has(handle.identity)
    ) {
      await this.cancelUnrecorded(handle.identity, context);
      context?.checkpoint({
        ...handle,
        data: {
          ...settled,
          stopped:
            "Prepared local launch cancelled through its owned worker identity",
        },
      });
      await context?.admitEffect?.("settled");
      return;
    }
    const active = this.require(handle);
    await cessationAdmission(context);
    await this.resolveHarness(
      active.request.item,
      active.executionBinding,
    ).cancel(active.handle);
    if (context?.cancelled()) this.unavailableSession(handle, context);
  }

  /**
   * Collect the worker's result. The result is checkpointed into the handle
   * before the worktree is removed, so a repeated collect returns it; a dead
   * worker is recorded as stopped before its worktree goes.
   */
  @classifyFaults(executionFault)
  async collect(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionResult> {
    const settled = handle.data as Partial<Settled> | undefined;
    if (
      settled?.result &&
      (handle.data as Active | undefined)?.rejectedCollection
    )
      throw new Error("Rejected collection cannot claim an execution result");
    // An ended attempt: its worktree goes if a crash kept it.
    if (settled?.result || settled?.stopped !== undefined) {
      await context?.admitEffect?.("explicit");
      if (settled.worktree && executionDirectoryRemains(settled.worktree))
        await this.removeExecutionDirectory(settled.worktree);
      if (settled.result) return structuredClone(settled.result);
      throw stoppedFault(settled.stopped!, true);
    }
    const active = this.require(handle);
    if (active.rejectedCollection) {
      await authenticateRejectedCollectionReceipt(
        active.rejectedCollection,
        active.request,
        handle.identity,
        this.checkout,
        this.contentStore,
      );
      await context?.admitEffect?.("explicit");
      if (executionDirectoryRemains(active.worktree))
        await this.removeExecutionDirectory(active.worktree);
      throw workFault(active.rejectedCollection.fault.detail);
    }
    let collected: ExecutionResult | undefined;
    let collectionError: unknown;
    let sessionCheckpointed = false;
    try {
      const result = await this.resolveHarness(
        active.request.item,
        active.executionBinding,
      ).collect(active.handle);
      if (result.session) {
        if (!active.request.session)
          throw new Error(
            "Harness returned an unsolicited conversation receipt",
          );
        assertAgentSessionRef(result.session, active.request.session.scope);
        if (
          result.session.identity !== active.request.session.identity ||
          result.session.status !== "ready"
        )
          throw new Error(
            "Harness conversation receipt differs from its admitted turn",
          );
        // Harness collection has settled the owned group. Persist native
        // continuity even if subsequent source/ownership collection rejects
        // the candidate: this receipt proves no implementation acceptance.
        if (context?.cancelled()) this.unavailableSession(handle, context);
        else context?.checkpointSession?.(structuredClone(result.session));
        sessionCheckpointed = true;
      }
      if (active.request.discovery) {
        if (result.session || result.assets?.length)
          throw workFault(
            "Discovery returned unsolicited implementation effects",
          );
        const response = (
          result.evidence as { finalResponse?: unknown } | undefined
        )?.finalResponse;
        if (typeof response !== "string")
          throw workFault("Discovery returned no structured classification");
        const original = await authenticateDiscoveryOutput({
          checkout: this.checkout,
          specification: active.request.item.discovery!,
          manifest: active.request.discovery.manifest,
          store: this.contentStore,
        });
        await verifyDiscoveryExport(active.worktree, original.entries);
        const manifest = await classifyDiscoveryOutput({
          checkout: this.checkout,
          specification: active.request.item.discovery!,
          manifest: active.request.discovery!.manifest,
          store: this.contentStore,
          response,
        });
        collected = {
          treeSha: manifest.source.treeSha,
          changeRef: manifest.source.commitSha,
          discoveryOutput: manifest,
          evidence: result.evidence,
        };
      } else
        collected = await collectWorktreeResult(
          this.checkout,
          active.worktree,
          active.request,
          this.contentStore,
          result,
          async (collected) => {
            context?.checkpoint({
              ...handle,
              data: {
                ...active,
                // The stopped-run handoff authenticates this settled session.
                result: JSON.parse(
                  JSON.stringify(
                    result.session
                      ? { ...collected, session: result.session }
                      : collected,
                  ),
                ),
              },
            });
            await context?.admitEffect?.("explicit");
          },
          async (manifest) => {
            active.assetManifest = structuredClone(manifest);
            context?.checkpoint({ ...handle, data: active });
            // Collection must finish freezing its source before complete ACK.
            // A semantic rejection keeps this original and its owned checkout.
          },
          async (assets) => {
            if (!privateCheckpointBounds() || !assets.length) return;
            active.collectedAssets = structuredClone(assets);
            context?.checkpoint({ ...handle, data: active });
          },
        );
      if (result.session) collected.session = structuredClone(result.session);
    } catch (error) {
      collectionError = error;
    }
    if (collectionError instanceof UnsettledSubprocessError)
      throw collectionError;
    const observed = await this.resolveHarness(
      active.request.item,
      active.executionBinding,
    ).observe(active.handle);
    if (observed.state === "running")
      throw new Error(
        "Collection failed while worker remains active; checkout retained",
      );
    if (hasUnresolvedSubprocesses())
      throw new Error(
        "Collection subprocess ownership unresolved; checkout retained",
      );
    if (observed.session && !sessionCheckpointed) {
      if (!active.request.session)
        throw new Error(
          "Harness returned an unsolicited failed-result session receipt",
        );
      assertAgentSessionRef(observed.session, active.request.session.scope);
      if (
        observed.session.identity !== active.request.session.identity ||
        observed.session.status !== "ready"
      )
        throw new Error(
          "Failed-result conversation differs from its admitted turn",
        );
      if (context?.cancelled()) this.unavailableSession(handle, context);
      else context?.checkpointSession?.(structuredClone(observed.session));
    } else if (!observed.session && !sessionCheckpointed) {
      // This attempt has demonstrably ceased but never supplied a completed
      // native turn. Preserve its historical conversation for disposal and
      // allow the controller to allocate a fresh identity within its limits.
      await this.resolveHarness(
        active.request.item,
        active.executionBinding,
      ).cancel(active.handle);
      this.unavailableSession(handle, context);
    }
    if (isCheckpointAdmissionFailure(collectionError)) throw collectionError;
    if (
      !collected &&
      observed.interrupted !== true &&
      attachedFault(collectionError)?.kind === "work"
    ) {
      if (privateCheckpointBounds()) {
        if (!active.rejectedCollection) {
          const harness = this.resolveHarness(
            active.request.item,
            active.executionBinding,
          );
          const source =
            harness instanceof CodexHarness ||
            harness instanceof ClaudeAgentSdkHarness
              ? harness.originalCollectionReturn(active.handle)
              : undefined;
          if (
            !source ||
            source.attemptId !== handle.identity ||
            !resolve(source.path).startsWith(`${resolve(source.root)}${sep}`) ||
            !source.path.endsWith(".result.json")
          )
            throw new Error(
              "Rejected collection has no authenticated original worker return; checkout retained",
            );
          const info = lstatSync(source.path);
          const bounds = privateCheckpointBounds()!;
          if (
            !info.isFile() ||
            realpathSync(source.path) !== resolve(source.path) ||
            (process.getuid && info.uid !== process.getuid()) ||
            info.size > bounds.maxBytes
          )
            throw new Error(
              "Rejected worker return is unavailable or exceeds its admitted bounds",
            );
          const bytes = readFileSync(source.path);
          const original = JSON.parse(bytes.toString("utf8")) as {
            state?: unknown;
          };
          if (original.state === "failed") {
            // The worker itself reported failure (provider limit, context
            // exhaustion, crash): it produced no result to reject, so there
            // is nothing to freeze. Record that it ceased and end the attempt
            // with its own work fault, as the unbounded path does.
            context?.checkpoint({
              ...handle,
              data: {
                ...active,
                stopped:
                  collectionError instanceof Error
                    ? collectionError.message
                    : String(collectionError),
              },
            });
            await context?.admitEffect?.("explicit");
            this.active.delete(handle.identity);
            await this.removeExecutionDirectory(active.worktree);
            throw collectionError;
          }
          if (original.state !== "complete")
            throw new Error(
              "Rejected collection has no completed original wrapper return",
            );
          active.rejectedCollection = await freezeRejectedCollection({
            checkout: this.checkout,
            worktree: active.worktree,
            request: active.request,
            store: this.contentStore,
            error: collectionError,
            capturedAssets: active.collectedAssets,
            rawReturn: {
              provenance: source.provenance,
              identity: handle.identity,
              bytes,
            },
          });
        }
        await authenticateRejectedCollectionReceipt(
          active.rejectedCollection,
          active.request,
          handle.identity,
          this.checkout,
          this.contentStore,
        );
        context?.checkpoint({ ...handle, data: active });
        await context?.admitEffect?.("explicit");
        this.active.delete(handle.identity);
        await this.removeExecutionDirectory(active.worktree);
      }
      throw collectionError;
    }
    const interrupted = !collected && observed.interrupted === true;
    // Only a wrong result ends the attempt here. A transient, config or
    // defect fault from collecting a finished worker's result is not the
    // worker's: it leaves the result in its worktree for the step to repeat
    // collect, or to stop as a defect, and charges nothing.
    if (
      !collected &&
      !interrupted &&
      !(collectionError instanceof AuthenticationRequiredError) &&
      attachedFault(collectionError)?.kind !== "work"
    )
      throw collectionError;
    if (collected)
      context?.checkpoint({
        ...handle,
        data: { ...active, result: JSON.parse(JSON.stringify(collected)) },
      });
    else if (interrupted)
      context?.checkpoint({
        ...handle,
        data: {
          ...active,
          stopped:
            collectionError instanceof Error
              ? collectionError.message
              : String(collectionError),
        },
      });
    await context?.admitEffect?.("explicit");
    this.active.delete(handle.identity);
    if (
      collected ||
      active.request.discovery ||
      !existsSync(join(active.worktree, ".factory-discovery.json"))
    )
      await this.removeExecutionDirectory(active.worktree);
    if (!collected) {
      if (collectionError instanceof AuthenticationRequiredError)
        throw collectionError;
      // A wrong result keeps its own fault: its evidence may carry the
      // worker's staged discovery.
      if (!interrupted) throw collectionError;
      throw stoppedFault(
        collectionError instanceof Error
          ? collectionError.message
          : String(collectionError),
        interrupted,
        collectionError,
        observed.retryAt,
      );
    }
    return collected;
  }

  async releaseSession(session: AgentSessionRef): Promise<void> {
    assertAgentSessionRef(session);
    if (session.scope.role !== "implementation" || !session.scope.itemId)
      throw new Error("Local execution cannot dispose a reviewer conversation");
    const active = [...this.active.values()].find(
      (entry) => entry.request.item.id === session.scope.itemId,
    );
    if (active) {
      const harness = this.resolveHarness(
        active.request.item,
        active.executionBinding,
      );
      if ((await harness.observe(active.handle)).state === "running")
        throw new Error(
          "Cannot dispose a conversation while its Work Item worker is active",
        );
      await harness.cancel(active.handle);
    }
    let harnesses: AgentHarness[];
    if (this.profiles) {
      const profileId = (session.data as CodexSessionData | undefined)
        ?.profileId;
      const registration = profileId ? this.profiles.get(profileId) : undefined;
      if (!registration)
        throw new Error(
          "The retained session execution profile is unavailable for cleanup",
        );
      harnesses = [this.profileHarness(profileId!, registration)];
    } else {
      harnesses = [this.harness as AgentHarness];
    }
    harnesses = harnesses.filter(
      (harness) => harness.sessionAdapter === session.adapter,
    );
    if (!harnesses.length) {
      if (session.status === "unavailable") return;
      throw new Error(
        "The retained session adapter is unavailable for cleanup",
      );
    }
    await awaitCheckpointAdmission(session.scope.repository, "explicit");
    for (const harness of harnesses) {
      if (!harness.releaseSession)
        throw new Error(
          "The retained session adapter lacks supported disposal",
        );
      await harness.releaseSession(session);
    }
  }
}

/** What a local handle records once its attempt ended (#515). */
interface Settled {
  /** The collected result, saved before the worktree was removed. */
  result: ExecutionResult;
  /** Why the attempt stopped without a result. */
  stopped: string;
  /** The attempt's worktree, removed once the attempt ended. */
  worktree: string;
}
