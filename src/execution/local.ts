import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
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
  AgentHarness,
  CapturedAssetSet,
  ContentRef,
  ContentStore,
  ExecutionDriver,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionRequest,
  ExecutionResult,
  HarnessHandle,
  HarnessObservation,
  HarnessRequest,
  HarnessResult,
} from "../contracts.js";
import { AuthenticationRequiredError } from "../contracts.js";
import { captureAssetSets, importSourceAssets } from "../media.js";
import { parseProducedAssetSets } from "../media.js";
import { checkStagedCandidate } from "./staged-candidate.js";
import {
  linuxProcessIdentity,
  pinnedGit,
  processGroupExists,
  sanitizedWorkerEnvironment,
} from "../process.js";
import type { CodexModelSelection } from "../config.js";
import { parseAuthenticationRequest } from "./harness-support.js";
import { DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS } from "../provider-turn.js";

type Active = {
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
    if (current?.startTime !== data.startTime || current.group !== data.pid) {
      if (!existsSync(data.resultPath))
        throw new Error("Worker identity changed before cancellation");
      return;
    }
    try {
      process.kill(-data.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    while (processGroupExists(data.pid))
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
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

function assertDurableValue(
  value: unknown,
  name: string,
  seen = new Set<unknown>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} is not JSON-safe`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${name} is not JSON-safe`);
  if (seen.has(value)) throw new Error(`${name} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries())
        assertDurableValue(entry, `${name}[${index}]`, seen);
    } else {
      if (
        (Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length
      )
        throw new Error(`${name} must contain only JSON objects`);
      for (const [key, entry] of Object.entries(value))
        assertDurableValue(entry, `${name}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
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
      active.adapterIdentity !== this.adapterIdentity
    )
      throw new Error(
        "Local execution handle is outside owned state or uses another adapter",
      );
    return active;
  }

  constructor(
    private checkout: string,
    private workRoot: string,
    private harness: AgentHarness,
    private concurrency: number,
    private contentStore: ContentStore,
    private adapterIdentity: string,
  ) {
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

  async availableSlots(): Promise<number> {
    return Math.max(0, this.concurrency - this.active.size);
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
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
    pinnedGit(
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
      const handle = await this.harness.start({
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
        request: { ...request, sourceAssets },
        worktree,
        adapterIdentity: this.adapterIdentity,
        handle,
      };
      this.active.set(identity, active);
      return { provider: "local", identity, data: active };
    } catch (error) {
      pinnedGit(this.checkout, "worktree", "remove", "--force", worktree);
      throw error;
    }
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    const active = this.require(handle);
    return this.harness.observe(active.handle);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const active = this.require(handle);
    await this.harness.cancel(active.handle);
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    const active = this.require(handle);
    try {
      const result = await this.harness.collect(active.handle);
      if (
        pinnedGit(active.worktree, "rev-parse", "HEAD") !==
        active.request.baseSha
      ) {
        throw new Error(
          "Worker changed HEAD; expected uncommitted changes at exact base",
        );
      }
      const assets = await captureAssetSets(
        this.contentStore,
        active.worktree,
        active.request.item,
        result.assets ?? [],
        result.evidence,
        active.request.sourceAssets,
      );
      for (const [index, source] of (
        active.request.selectedAssets ?? []
      ).entries()) {
        await verifyBoundInput(
          join(active.worktree, ".factory-inputs", `selected-${index}`),
          source.ref,
        );
      }
      const privateSources = (active.request.sourceAssets ?? []).filter(
        (source) =>
          source.binding.kind === "local" ||
          source.binding.kind === "github-attachment",
      );
      for (const [index, source] of privateSources.entries()) {
        await verifyBoundInput(
          join(active.worktree, ".factory-inputs", `source-${index}`),
          source.ref,
        );
      }
      rmSync(join(active.worktree, ".factory-inputs"), {
        recursive: true,
        force: true,
      });
      rmSync(join(active.worktree, ".factory-assets.json"), { force: true });
      if (
        active.request.item.expectedOutputRoles?.length &&
        assets.length < (active.request.item.minimumAssetSets ?? 1)
      )
        throw new Error(
          "Media Work Item did not produce the requested AssetSets",
        );
      const assetDestinations = await preserveControllerAssetDestinations(
        active.worktree,
        assets,
      );
      pinnedGit(active.worktree, "add", "-A");
      if (assetDestinations.length)
        pinnedGit(active.worktree, "reset", "HEAD", "--", ...assetDestinations);
      const paths = checkStagedCandidate(
        active.worktree,
        this.checkout,
        active.request.item.ownedPaths,
      );
      if (!paths.length && !assets.length)
        throw new Error("Worker produced no repository change");
      if (paths.length)
        pinnedGit(
          active.worktree,
          "-c",
          "user.name=Factory",
          "-c",
          "user.email=factory@users.noreply.github.com",
          "commit",
          "-m",
          `Factory: ${active.request.item.title}`,
        );
      const commit = pinnedGit(active.worktree, "rev-parse", "HEAD");
      const treeSha = pinnedGit(active.worktree, "rev-parse", "HEAD^{tree}");
      return {
        changeRef: commit,
        treeSha,
        evidence: result.evidence,
        assets,
      };
    } finally {
      this.active.delete(handle.identity);
      try {
        pinnedGit(
          this.checkout,
          "worktree",
          "remove",
          "--force",
          active.worktree,
        );
      } catch {
        rmSync(active.worktree, { recursive: true, force: true });
      }
    }
  }
}
