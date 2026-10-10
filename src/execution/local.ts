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
import { isDeepStrictEqual } from "node:util";
import {
  assertAgentSessionCapabilities,
  assertAgentSessionRef,
  assertAgentSessionScope,
} from "../agent-session.js";
import { releaseCodexHome } from "../codex-planning-isolation.js";
import type {
  CodexModelSelection,
  ExecutionProfileEnvironment,
} from "../config.js";
import type {
  AgentHarness,
  AgentSessionRef,
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
  captureAssetSets,
  importSourceAssets,
  parseProducedAssetSets,
} from "../media.js";
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
import { assertPinnedNpmScripts, validateCheckout } from "../validation.js";
import type { ValidationEvidence } from "../validation-evidence.js";
import { workspacePackageAdditions } from "../workspace-membership.js";
import { stoppedFault } from "./attempt.js";
import { assertDurableValue } from "./checkpoint.js";
import { executionFault } from "./fault.js";
import { readWorkHandoff } from "./harness-support.js";
import {
  checkStagedCandidate,
  scanPrivateStaging,
} from "./staged-candidate.js";
import {
  killGroup,
  launchWorker,
  observeWorker,
  stopUnrecordedWorker,
} from "./worker-process.js";

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
  environmentReadiness?: {
    commitSha: string;
    worktree: string;
    evidence: ValidationEvidence;
  };
};

interface WorkerHandleData {
  pid: number;
  startTime: string;
  requestPath: string;
  resultPath: string;
  logPath: string;
}

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
          this.allowedSecretNames,
          this.model,
          this.providerTurnIdleTimeoutMs,
          session,
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
  ".factory-handoff.json",
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
  const handoffPath = join(worktree, ".factory-handoff.json");
  const handoffNotes = judgedAsWork(() => readWorkHandoff(worktree));
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
      // Git rejects an explicit ignored path even when it is an exclusion.
      // Already ignored untracked staging cannot be added by the root pathspec.
      ...PRIVATE_STAGING.filter(
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
      ).map((name) => `:(exclude,literal)${name}`),
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
  if (discovery) rmSync(discoveryPath);
  if (handoffNotes) rmSync(handoffPath);
  rmSync(join(worktree, ".factory-inputs"), { recursive: true, force: true });
  rmSync(join(worktree, ".factory-assets.json"), { force: true });
  return {
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
}

/** Render only authenticated local Git context, never an execution base or proof. */
export function retainedFailedResultBrief(
  checkout: string,
  worktree: string,
  retainedResult: ExecutionRequest["retainedFailedResult"],
): string {
  let failedContext = "";
  if (retainedResult) {
    const retained = retainedResult;
    try {
      if (
        !/^[a-f0-9]{40}$/.test(retained.commitSha) ||
        !/^[a-f0-9]{40}$/.test(retained.treeSha) ||
        pinnedGit(worktree, "rev-parse", `${retained.commitSha}^{commit}`) !==
          retained.commitSha ||
        pinnedGit(worktree, "rev-parse", `${retained.commitSha}^{tree}`) !==
          retained.treeSha ||
        pinnedGit(
          worktree,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ) !==
          pinnedGit(
            checkout,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          )
      )
        throw new Error(
          "Retained failed Git result is not authenticated in this checkout",
        );
      failedContext = `\nRetained failed committed result, verified reachable in this checkout: ${JSON.stringify(retained)}. This is unaccepted implementation context, not normative source, an accepted base or acceptance proof. You may inspect currently owned files from this exact Git tree and reuse their implementation in owned edits while making the diagnosed correction. Preserve the checkout's current accepted HEAD; do not checkout, reset or cherry-pick the failed commit. Missing prior unfinished uncommitted edits remain unavailable. All current validation and independent acceptance apply anew; old command passes do not prove this result.`;
    } catch {
      failedContext =
        "\nRetained failed committed-result context is unavailable or could not be authenticated in this checkout. Do not infer prior source contents; unfinished uncommitted edits remain unavailable.";
    }
  }
  return failedContext;
}

export class LocalExecutionDriver implements ExecutionDriver {
  readonly sessionCapabilities = { resumeRoles: ["implementation"] } as const;
  readonly freshCheckoutReadiness = true as const;
  readonly retainedFailedResultContext = true as const;
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
    if ("sessionContinuation" in harness)
      throw new Error(
        `Harness adapter ${adapterIdentity} uses the removed sessionContinuation declaration; declare sessionCapabilities.resumeRoles instead`,
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

  @classifyFaults(executionFault)
  async preflight(graph: WorkGraph): Promise<void> {
    for (const item of graph.items) {
      if (item.kind !== "qa" && item.kind !== "aggregate")
        this.resolveHarness(item);
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
    const harness = this.resolveHarness(request.item);
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
        );
        if (context?.cancelled())
          throw cancelledFault(
            "Cancelled after worker environment preparation",
          );
      }
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
      const failedContext = retainedFailedResultBrief(
        this.checkout,
        worktree,
        request.retainedFailedResult,
      );
      if (session) {
        assertAgentSessionScope(session.scope);
        if (
          session.scope.role !== "implementation" ||
          session.scope.itemId !== request.item.id
        )
          throw new Error(
            "Local execution session belongs to another Work Item",
          );
        if (session.retained)
          assertAgentSessionRef(session.retained, session.scope);
        context?.checkpointSession?.({
          scope: structuredClone(session.scope),
          adapter:
            harness.sessionAdapter ??
            request.item.executionBinding?.adapter ??
            this.adapterIdentity,
          identity: session.identity,
          turn: (session.retained?.turn ?? 0) + 1,
          status: harness.sessionCapabilities?.resumeRoles.includes(
            "implementation",
          )
            ? "in-flight"
            : "unavailable",
          executionIdentity: identity,
          data: harness.sessionCapabilities?.resumeRoles.includes(
            "implementation",
          )
            ? {
                ...(session.retained?.data as
                  | Record<string, unknown>
                  | undefined),
                pendingWorkerIdentity: identity,
                ...(request.item.executionBinding && {
                  profileId: request.item.executionBinding.id,
                }),
              }
            : {
                reason:
                  "The selected harness does not support native conversation continuation",
                ...(request.item.executionBinding && {
                  profileId: request.item.executionBinding.id,
                }),
              },
        });
      }
      const handle = await harness.start({
        ...(session &&
          harness.sessionCapabilities?.resumeRoles.includes(
            "implementation",
          ) && { session }),
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
        item: { ...request.item, brief: request.item.brief + failedContext },
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
      return started;
    } catch (error) {
      this.active.delete(identity);
      if (!hasUnresolvedSubprocesses())
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
  async find(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle | undefined> {
    const data = handle.data as Partial<Settled> | undefined;
    if (data?.result) return handle;
    if (data?.stopped !== undefined) {
      this.unavailableSession(handle, context);
      return undefined;
    }
    if (this.active.has(handle.identity)) return handle;
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
    const settled = handle.data as Partial<Settled> | undefined;
    // An attempt that ended has nothing left to stop.
    if (settled?.result || settled?.stopped !== undefined) {
      if (context?.cancelled()) this.unavailableSession(handle, context);
      return;
    }
    const active = this.require(handle);
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
      collected = await collectWorktreeResult(
        this.checkout,
        active.worktree,
        active.request,
        this.contentStore,
        result,
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
    let harnesses: RecoverableHarness[];
    if (this.profiles) {
      const profileId = (session.data as CodexSessionData | undefined)
        ?.profileId;
      const registration = profileId ? this.profiles.get(profileId) : undefined;
      if (!registration)
        throw new Error(
          "The retained session execution profile is unavailable for cleanup",
        );
      let harness = this.profileHarnesses.get(profileId!);
      if (!harness) {
        harness = registration.createHarness();
        this.assertCapabilities(harness, registration.binding.adapter);
        this.profileHarnesses.set(profileId!, harness);
      }
      harnesses = [harness];
    } else {
      harnesses = [this.harness as RecoverableHarness];
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
    for (const harness of harnesses) await harness.releaseSession?.(session);
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
