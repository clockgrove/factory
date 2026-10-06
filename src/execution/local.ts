import { packageManagerUpdate } from "../package-manager-update.js";
import {
  attachedFault,
  cancelledFault,
  classifyFaults,
  judgedAsWork,
  readWorkerJson,
  StepFault,
  workFault,
} from "../fault.js";
import { executionFault } from "./fault.js";
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
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodexModelSelection,
  ExecutionProfileEnvironment,
} from "../config.js";
import type {
  AgentHarness,
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
import { assertExecutionBinding } from "../execution-profiles.js";
import { assertDiscovery } from "../graph-amendments.js";
import {
  captureAssetSets,
  importSourceAssets,
  parseProducedAssetSets,
} from "../media.js";
import {
  addWorktree,
  hasUnresolvedSubprocesses,
  linuxProcessIdentity,
  pinnedGit,
  pinnedGitAsync,
  pinnedGitMagicAsync,
  processGroupExists,
  sanitizedWorkerEnvironment,
  removeWorktree,
} from "../process.js";
import { DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS } from "../provider-turn.js";
import { stoppedFault } from "./attempt.js";
import { assertDurableValue } from "./checkpoint.js";
import {
  launchWorker,
  observeWorker,
  stopUnrecordedWorker,
} from "./worker-process.js";
import { checkStagedCandidate } from "./staged-candidate.js";

/**
 * A harness that can stop what a start of an identity spawned before its
 * handle was recorded (#585). Optional until AgentHarness declares it.
 */
type RecoverableHarness = AgentHarness & {
  cancelUnrecorded?(identity: string): Promise<void>;
};

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
};

interface WorkerHandleData {
  pid: number;
  startTime: string;
  requestPath: string;
  resultPath: string;
  logPath: string;
}

export class CodexHarness implements AgentHarness {
  readonly capabilities = {
    protocolVersion: 1,
    worktree: "factory-owned-read-write",
    head: "preserve",
    lifecycle: "restart-safe-durable-handle",
    publication: "controller-only",
    assetSets: true,
    authentication: "local-environment",
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

  /**
   * Start a fresh worker for the attempt identity. Whatever an earlier
   * unrecorded start of it spawned is stopped first (#585).
   */
  async start(request: HarnessRequest): Promise<HarnessHandle> {
    const identity = request.attemptId ?? randomUUID();
    return {
      identity,
      data: await launchWorker({
        root: this.harnessRoot,
        identity,
        label: "Codex harness",
        script: fileURLToPath(new URL("./worker.js", import.meta.url)),
        input: codexWorkerInput(
          request,
          this.network,
          this.allowedSecretNames,
          this.model,
          this.providerTurnIdleTimeoutMs,
        ),
        env: sanitizedWorkerEnvironment(
          this.credentialDirectory,
          this.allowedSecretNames,
        ),
      }),
    };
  }

  /** Stop what a start of `identity` spawned before its handle was recorded. */
  async cancelUnrecorded(identity: string): Promise<void> {
    await stopUnrecordedWorker(this.harnessRoot, identity, "Codex harness");
  }

  async observe(handle: HarnessHandle): Promise<HarnessObservation> {
    return observeWorker(this.require(handle), "Codex harness");
  }

  async cancel(handle: HarnessHandle): Promise<void> {
    const data = this.require(handle);
    const current = linuxProcessIdentity(data.pid);
    if (!current) {
      if (processGroupExists(data.pid))
        throw new Error(
          "Worker cessation remains unresolved; checkout retained",
        );
      return;
    }
    if (current.startTime !== data.startTime || current.group !== data.pid)
      throw new Error("Worker identity changed before cancellation");
    try {
      process.kill(-data.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    for (
      let attempt = 0;
      attempt < 100 && processGroupExists(data.pid);
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (processGroupExists(data.pid))
      throw new Error("Worker cessation remains unresolved; checkout retained");
  }

  async collect(handle: HarnessHandle): Promise<HarnessResult> {
    const data = this.require(handle);
    for (;;) {
      const observed = await this.observe(handle);
      if (observed.state === "running") {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
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
      return { evidence: value.evidence, assets };
    }
  }
}

export function codexWorkerInput(
  request: HarnessRequest,
  network: "host" | "off",
  allowedSecretNames: string[],
  model: CodexModelSelection,
  providerTurnIdleTimeoutMs = DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
): {
  request: HarnessRequest;
  network: "host" | "off";
  allowedSecretNames: string[];
  model: CodexModelSelection;
  providerTurnIdleTimeoutMs: number;
} {
  return {
    request,
    network,
    allowedSecretNames: [...allowedSecretNames],
    model: {
      model: model.model,
      reasoningEffort: model.reasoningEffort,
    },
    providerTurnIdleTimeoutMs,
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

/** Controller-owned staging that collection reads but never commits. */
const PRIVATE_STAGING = [
  ".factory-discovery.json",
  ".factory-inputs",
  ".factory-assets.json",
];
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

const FACTORY_EMAIL = "factory@users.noreply.github.com";
const collectionMessage = (request: ExecutionRequest) =>
  `Factory: ${request.item.title}`;

/** Shared exact collection boundary for local work and imported managed bytes. */
export async function collectWorktreeResult(
  checkout: string,
  worktree: string,
  request: ExecutionRequest,
  store: ContentStore,
  result: HarnessResult,
): Promise<ExecutionResult> {
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
  );
  for (const [index, source] of (request.selectedAssets ?? []).entries()) {
    await verifyBoundInput(
      join(worktree, ".factory-inputs", `selected-${index}`),
      source.ref,
    );
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
      ...PRIVATE_STAGING.map((name) => `:(exclude,literal)${name}`),
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
  // account of why: it rides on the fault so Factory reviews it (#820).
  if (!paths.length && !assets.length)
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
  if (discovery) rmSync(discoveryPath);
  rmSync(join(worktree, ".factory-inputs"), { recursive: true, force: true });
  rmSync(join(worktree, ".factory-assets.json"), { force: true });
  return {
    changeRef: commit,
    treeSha,
    evidence: result.evidence,
    ...(discovery ? { discovery } : {}),
    collection: { acceptedIgnoredLinks },
    assets,
  };
}

export class LocalExecutionDriver implements ExecutionDriver {
  private active = new Map<string, Active>();

  private require(handle: ExecutionHandle): Active {
    const active =
      this.active.get(handle.identity) ?? (handle.data as Active | undefined);
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
    let harness = this.profileHarnesses.get(id!);
    if (!harness) {
      harness = registration.createHarness();
      this.assertCapabilities(harness, registration.binding.adapter);
      this.profileHarnesses.set(id!, harness);
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
  }

  @classifyFaults(executionFault)
  async preflight(graph: WorkGraph): Promise<void> {
    for (const item of graph.items) this.resolveHarness(item);
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
    const harness = this.resolveHarness(request.item);
    const identity = request.attemptId ?? randomUUID();
    const running = this.active.get(identity);
    if (running) return { provider: "local", identity, data: running };
    const worktree = join(this.workRoot, identity);
    mkdirSync(this.workRoot, { recursive: true });
    if (existsSync(worktree)) {
      await (harness as RecoverableHarness).cancelUnrecorded?.(identity);
      await removeWorktree(this.checkout, worktree);
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
    await addWorktree(this.checkout, worktree, request.baseSha);
    try {
      const sourceAssets = await importSourceAssets(
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
      const environment = request.item.executionProfile
        ? this.profiles?.get(request.item.executionProfile.id)?.environment
        : undefined;
      const handle = await harness.start({
        ...(request.captureContext &&
          this.captureSettings && {
            capture: {
              policy: this.captureSettings.policy,
              context: {
                repository: this.captureSettings.repository,
                ...request.captureContext,
                itemId: request.item.id,
                attemptId: identity,
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
                configDigest: this.captureSettings.configDigest,
                sourceDigest: createHash("sha256")
                  .update(request.objectiveBody ?? "")
                  .digest("hex"),
              },
            },
          }),
        ...(environment && { environment: structuredClone(environment) }),
        item: request.item,
        packageManagerUpdate: packageManagerUpdate(request.objectiveBody ?? ""),
        worktree,
        attemptId: identity,
        sourceAssets: sourceAssets.map(
          (source) =>
            boundSources.find((bound) => bound.binding === source.binding) ??
            source,
        ),
        selectedAssets: boundSelected,
      });
      assertDurableHandle(handle);
      const active = {
        request: structuredClone({
          ...request,
          attemptId: identity,
          sourceAssets,
        }),
        worktree,
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
      return started;
    } catch (error) {
      this.active.delete(identity);
      await removeWorktree(this.checkout, worktree);
      throw error;
    }
  }

  /**
   * Stop an attempt whose start was never recorded: a worker this process
   * still runs is cancelled, a worker a crashed start spawned is found by
   * its identity and stopped, and the worktree is removed.
   */
  @classifyFaults(executionFault)
  async cancelUnrecorded(attemptId: string): Promise<void> {
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
      existsSync(worktree)
    )
      await removeWorktree(this.checkout, worktree);
  }

  /** Every harness this driver can start a worker with. */
  private harnesses(): RecoverableHarness[] {
    if (!this.profiles) return [this.harness as RecoverableHarness];
    return [...this.profiles].map(([id, registration]) => {
      let harness = this.profileHarnesses.get(id);
      if (!harness) {
        harness = registration.createHarness();
        this.assertCapabilities(harness, registration.binding.adapter);
        this.profileHarnesses.set(id, harness);
      }
      return harness as RecoverableHarness;
    });
  }

  /**
   * The handle to continue with, or undefined once the attempt is confirmed
   * stopped without a result (a settled dead worker or an interrupted
   * start). A collected result, a running worker and a finished worker whose
   * result is still in its worktree are continued.
   */
  @classifyFaults(executionFault)
  async find(handle: ExecutionHandle): Promise<ExecutionHandle | undefined> {
    const data = handle.data as Partial<Settled> | undefined;
    if (data?.result) return handle;
    if (data?.stopped !== undefined) return undefined;
    if (this.active.has(handle.identity)) return handle;
    return existsSync(this.require(handle).worktree) ? handle : undefined;
  }

  @classifyFaults(executionFault)
  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    const settled = handle.data as Partial<Settled> | undefined;
    if (settled?.result) return { state: "complete" };
    if (settled?.stopped !== undefined)
      return { state: "failed", interrupted: true, detail: settled.stopped };
    const active = this.require(handle);
    return this.resolveHarness(
      active.request.item,
      active.executionBinding,
    ).observe(active.handle);
  }

  @classifyFaults(executionFault)
  async cancel(handle: ExecutionHandle): Promise<void> {
    const settled = handle.data as Partial<Settled> | undefined;
    // An attempt that ended has nothing left to stop.
    if (settled?.result || settled?.stopped !== undefined) return;
    const active = this.require(handle);
    await this.resolveHarness(
      active.request.item,
      active.executionBinding,
    ).cancel(active.handle);
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
    // An ended attempt: its worktree goes if a crash kept it.
    if (settled?.result || settled?.stopped !== undefined) {
      if (settled.worktree && existsSync(settled.worktree))
        await removeWorktree(this.checkout, settled.worktree);
      if (settled.result) return structuredClone(settled.result);
      throw stoppedFault(settled.stopped!, true);
    }
    const active = this.require(handle);
    let collected: ExecutionResult | undefined;
    let collectionError: unknown;
    try {
      const result = await this.resolveHarness(
        active.request.item,
        active.executionBinding,
      ).collect(active.handle);
      collected = await collectWorktreeResult(
        this.checkout,
        active.worktree,
        active.request,
        this.contentStore,
        result,
      );
    } catch (error) {
      collectionError = error;
    }
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
    this.active.delete(handle.identity);
    if (
      collected ||
      !existsSync(join(active.worktree, ".factory-discovery.json"))
    )
      await removeWorktree(this.checkout, active.worktree);
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
      );
    }
    return collected;
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
