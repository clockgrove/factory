import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
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
  commandAsync,
  hasUnresolvedSubprocesses,
  linuxProcessIdentity,
  pinnedGit,
  pinnedGitAsync,
  pinnedGitEnvironment,
  processGroupExists,
  sanitizedWorkerEnvironment,
  withProcessCancellation,
} from "../process.js";
import { DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS } from "../provider-turn.js";
import { SettledAttemptFailure } from "../work-repair.js";
import { assertDurableValue } from "./checkpoint.js";
import { parseAuthenticationRequest } from "./harness-support.js";
import { checkStagedCandidate } from "./staged-candidate.js";

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

  async start(request: HarnessRequest): Promise<HarnessHandle> {
    const identity = request.attemptId ?? randomUUID();
    const root = join(dirname(this.credentialDirectory), "harness");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const requestPath = join(root, `${identity}.request.json`);
    const resultPath = join(root, `${identity}.result.json`);
    const logPath = join(root, `${identity}.log`);
    writeFileSync(
      requestPath,
      `${JSON.stringify(
        codexWorkerInput(
          request,
          this.network,
          this.allowedSecretNames,
          this.model,
          this.providerTurnIdleTimeoutMs,
        ),
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const log = openSync(logPath, "a", 0o600);
    let pid: number;
    try {
      const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
      const child = spawn(process.execPath, [worker, requestPath, resultPath], {
        detached: true,
        stdio: ["ignore", log, log],
        env: sanitizedWorkerEnvironment(
          this.credentialDirectory,
          this.allowedSecretNames,
        ),
      });
      if (!child.pid) throw new Error("Failed to launch Codex harness worker");
      pid = child.pid;
      child.unref();
    } finally {
      closeSync(log);
    }
    const identityOnHost = linuxProcessIdentity(pid);
    if (!identityOnHost || identityOnHost.group !== pid) {
      throw new Error(
        "Codex harness worker did not start in its own process group",
      );
    }
    return {
      identity,
      data: {
        pid,
        startTime: identityOnHost.startTime,
        requestPath,
        resultPath,
        logPath,
      } satisfies WorkerHandleData,
    };
  }

  async observe(handle: HarnessHandle): Promise<HarnessObservation> {
    const data = this.require(handle);
    if (existsSync(data.resultPath)) {
      const result = JSON.parse(readFileSync(data.resultPath, "utf8")) as {
        state: "complete" | "failed";
        error?: string;
        authentication?: unknown;
      };
      const authentication = parseAuthenticationRequest(result.authentication);
      return result.state === "complete"
        ? { state: "complete" }
        : {
            state: "failed",
            detail: result.error,
            ...(authentication && { authentication }),
          };
    }
    const current = linuxProcessIdentity(data.pid);
    return current?.startTime === data.startTime &&
      current.group === data.pid &&
      current.state !== "Z"
      ? { state: "running" }
      : {
          state: "failed",
          detail:
            "Worker exited without a durable result; operator direction required",
        };
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
        throw new Error(observed.detail ?? "Codex harness worker failed");
      }
      const result: unknown = JSON.parse(readFileSync(data.resultPath, "utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Harness result is not an object");
      const value = result as Record<string, unknown>;
      if (
        value.state !== "complete" ||
        !value.evidence ||
        typeof value.evidence !== "object" ||
        Array.isArray(value.evidence)
      )
        throw new Error("Harness completion result lacks structured evidence");
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
    throw new Error("Bound asset input is missing or redirected");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== ref.bytes || hash.digest("hex") !== ref.digest)
    throw new Error("Bound asset input differs from its captured digest");
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
        throw new Error(
          `Worker removed controller-owned asset destination ${destination}`,
        );
      continue;
    }
    if (!source)
      throw new Error(
        `Worker wrote controller-owned asset destination ${destination}`,
      );
    await verifyBoundInput(path, source.ref);
  }
  return destinations;
}

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
      throw new Error(
        "Discovery manifest must be a regular private staging file",
      );
    discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
    assertDiscovery(discovery!);
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
      throw new Error("Discovery manifest must be untracked private staging");
  }
  if (pinnedGit(worktree, "rev-parse", "HEAD") !== request.baseSha) {
    throw new Error(
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
  rmSync(join(worktree, ".factory-inputs"), {
    recursive: true,
    force: true,
  });
  rmSync(join(worktree, ".factory-assets.json"), { force: true });
  if (
    request.item.expectedOutputRoles?.length &&
    assets.length < (request.item.minimumAssetSets ?? 1)
  )
    throw new Error("Media Work Item did not produce the requested AssetSets");
  const assetDestinations = await preserveControllerAssetDestinations(
    worktree,
    assets,
  );
  if (discovery)
    await commandAsync(
      "git",
      [
        "-C",
        worktree,
        "add",
        "-A",
        "--",
        ".",
        ":(exclude,literal).factory-discovery.json",
      ],
      undefined,
      { ...pinnedGitEnvironment(), GIT_LITERAL_PATHSPECS: "0" },
    );
  else await pinnedGitAsync(worktree, "add", "-A");
  if (assetDestinations.length)
    await pinnedGitAsync(worktree, "reset", "HEAD", "--", ...assetDestinations);
  const acceptedIgnoredLinks: string[] = [];
  const paths = await checkStagedCandidate(
    worktree,
    checkout,
    request.item.ownedPaths,
    acceptedIgnoredLinks,
  );
  if (!paths.length && !assets.length)
    throw new Error("Worker produced no repository change");
  if (paths.length)
    await pinnedGitAsync(
      worktree,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@users.noreply.github.com",
      "commit",
      "-m",
      `Factory: ${request.item.title}`,
    );
  const commit = pinnedGit(worktree, "rev-parse", "HEAD");
  const treeSha = pinnedGit(worktree, "rev-parse", "HEAD^{tree}");
  if (discovery) rmSync(discoveryPath);
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

  async preflight(graph: WorkGraph): Promise<void> {
    for (const item of graph.items) this.resolveHarness(item);
  }

  async availableSlots(): Promise<number> {
    return Math.max(0, this.concurrency - this.active.size);
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const harness = this.resolveHarness(request.item);
    const identity = request.attemptId ?? randomUUID();
    const worktree = join(this.workRoot, identity);
    mkdirSync(this.workRoot, { recursive: true });
    const verified = pinnedGit(
      this.checkout,
      "rev-parse",
      "--verify",
      `${request.baseSha}^{commit}`,
    );
    if (verified !== request.baseSha)
      throw new Error("Execution base does not resolve exactly");
    await pinnedGitAsync(
      this.checkout,
      "worktree",
      "add",
      "--detach",
      worktree,
      request.baseSha,
    );
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
      return { provider: "local", identity, data: active };
    } catch (error) {
      await withProcessCancellation(undefined, () =>
        pinnedGitAsync(
          this.checkout,
          "worktree",
          "remove",
          "--force",
          worktree,
        ),
      );
      throw error;
    }
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    const active = this.require(handle);
    return this.resolveHarness(
      active.request.item,
      active.executionBinding,
    ).observe(active.handle);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const active = this.require(handle);
    await this.resolveHarness(
      active.request.item,
      active.executionBinding,
    ).cancel(active.handle);
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    const active = this.require(handle);
    let collected: ExecutionResult | undefined;
    let failed = false;
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
      failed = true;
      collectionError = error;
    }
    let failureClassification: "implementation" | "interruption" =
      "implementation";
    {
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
      failureClassification =
        observed.state === "complete" ? "implementation" : "interruption";
      this.active.delete(handle.identity);
      if (
        !failed ||
        !existsSync(join(active.worktree, ".factory-discovery.json"))
      ) {
        try {
          await withProcessCancellation(undefined, () =>
            pinnedGitAsync(
              this.checkout,
              "worktree",
              "remove",
              "--force",
              active.worktree,
            ),
          );
        } catch {
          rmSync(active.worktree, { recursive: true, force: true });
        }
      }
    }
    if (failed) {
      if (collectionError instanceof AuthenticationRequiredError)
        throw collectionError;
      throw new SettledAttemptFailure(collectionError, failureClassification);
    }
    return collected!;
  }
}
