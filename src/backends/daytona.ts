import type { Readable } from "node:stream";

import { Daytona, DaytonaNotFoundError, type Sandbox, type Secret } from "@daytona/sdk";

import type {
  AttemptContext,
  BackendHandle,
  BackendObservation,
  BackendProbe,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  IsolatedValidationContext,
  IsolatedValidationResult,
  StaleAttemptIdentity,
} from "../execution/backend.js";
import {
  MAX_ARTIFACT_PATCH_BYTES,
  normalizeArtifact,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import { assertNoSecretMaterial, MAX_LOG_BYTES } from "../protocol/limits.js";
import { destinationAllowedByPolicy } from "../protocol/policy.js";
import { validationInvocationOwnership } from "./validation-invocation.js";
import {
  parseSandboxPaths,
  parseIsolatedValidationResult,
  repositoryArchive,
  sandboxBootstrapFiles,
  sandboxResourceName,
  sandboxValidationFiles,
} from "./sandbox-common.js";

interface RunningDaytona extends TrackedDaytona {
  phase: "execution";
  result: Awaited<ReturnType<Sandbox["process"]["executeCommand"]>> | null;
  error: unknown;
  context: AttemptContext;
}

interface TrackedDaytona {
  sandbox: Sandbox;
  resourceName: string;
  phase: "execution" | "validation";
  ttlMinutes?: number;
}

interface AmbiguousDaytonaCreate {
  resourceName: string;
  phase: "execution" | "validation";
  ttlMinutes: number;
  expiresAtMs: number;
  createFailure: string;
}

export class DaytonaResourceCleanupError extends Error {
  override readonly name = "DaytonaResourceCleanupError";
  readonly resourceId: string;
  readonly resourceName: string;
  readonly operation: string;
  readonly ttlMinutes: number | undefined;
  readonly priorFailure: string | undefined;
  override readonly cause: string;

  constructor(options: {
    resourceId: string;
    resourceName: string;
    operation: string;
    cause: unknown;
    priorFailure?: unknown;
    ttlMinutes?: number;
  }) {
    const providerMessage = safeDiagnostic(options.cause, "Daytona provider error");
    const priorFailure =
      options.priorFailure === undefined
        ? undefined
        : safeDiagnostic(options.priorFailure, "Daytona preceding failure");
    const priorMessage =
      priorFailure === undefined ? "" : ` The preceding operation also failed: ${priorFailure}.`;
    const ttlMessage =
      options.ttlMinutes === undefined
        ? "The configured provider TTL remains the final cleanup bound."
        : `The resource has a ${options.ttlMinutes}-minute provider TTL as its final cleanup bound.`;
    super(
      `Daytona sandbox deletion was not confirmed during ${options.operation}; ` +
        `resource ${options.resourceId} (${options.resourceName}) may still be billable. ` +
        `Retry stale-attempt reconciliation for this attempt before launching a replacement. ` +
        `${ttlMessage} ` +
        `Provider error: ${providerMessage}.${priorMessage}`,
    );
    this.resourceId = options.resourceId;
    this.resourceName = options.resourceName;
    this.operation = options.operation;
    this.ttlMinutes = options.ttlMinutes;
    this.cause = providerMessage;
    this.priorFailure = priorFailure;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDiagnostic(value: unknown, label: string): string {
  const diagnostic = errorMessage(value).slice(0, 8_000);
  try {
    assertNoSecretMaterial(diagnostic, label);
    return diagnostic;
  } catch (error) {
    return errorMessage(error);
  }
}

function safeFailure(value: unknown, label: string): Error {
  if (value instanceof DaytonaResourceCleanupError) return value;
  return new Error(safeDiagnostic(value, label));
}

function isNotFound(error: unknown): boolean {
  if (error instanceof DaytonaNotFoundError) return true;
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  ) {
    return true;
  }
  return /\b(?:404|not[ -]?found)\b/i.test(errorMessage(error));
}

function isDefinitiveCreateRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return false;
  }
  const status = error.statusCode;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 409
  );
}

function parseReplacementFence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Daytona no-handle replacement fence must be a valid ISO timestamp");
  }
  return timestamp;
}

const DAYTONA_BOOTSTRAP_DOMAINS = ["registry.npmjs.org", "*.npmjs.org"] as const;
const DAYTONA_MODEL_DOMAINS = ["api.openai.com"] as const;
const MAX_CHANGED_PATHS_BYTES = 10_000 * 501;
const MAX_EXIT_CODE_BYTES = 32;
const DEFAULT_CREATE_VISIBILITY_ATTEMPTS = 5;
const DEFAULT_CREATE_VISIBILITY_DELAY_MS = 500;
const MAX_CREATE_VISIBILITY_WINDOW_MS = 30_000;
const MAX_SECRET_LIST_PAGES = 100;

/** Official Node multi-platform image index pinned by digest for reproducible
 * supported Daytona execution. Tags are deliberately not accepted. */
export const DAYTONA_DEFAULT_IMAGE =
  "docker.io/library/node@sha256:c601a46abb4d2ab80a9dc3da208d50d1122642d53f17a101926ace71e5a9bf1c";
export const DAYTONA_MAX_VALIDATION_RESULT_BYTES = 256 * 1024;

function assertImmutableImage(image: string): void {
  if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(
      "Daytona image must be an immutable registry reference pinned with @sha256:<64 lowercase hex characters>",
    );
  }
}

interface RemoteArtifactFile {
  path: string;
  label: string;
  maxBytes: number;
}

const REMOTE_ARTIFACT_FILES = [
  {
    path: "factory/artifact.patch",
    label: "Daytona artifact patch",
    maxBytes: MAX_ARTIFACT_PATCH_BYTES,
  },
  {
    path: "factory/changed-paths",
    label: "Daytona changed-path manifest",
    maxBytes: MAX_CHANGED_PATHS_BYTES,
  },
  {
    path: "factory/exit-code",
    label: "Daytona worker exit code",
    maxBytes: MAX_EXIT_CODE_BYTES,
  },
  {
    path: "factory/worker.stdout",
    label: "Daytona worker stdout",
    maxBytes: MAX_LOG_BYTES,
  },
  {
    path: "factory/worker.stderr",
    label: "Daytona worker stderr",
    maxBytes: MAX_LOG_BYTES,
  },
] as const satisfies readonly RemoteArtifactFile[];

const REMOTE_VALIDATION_RESULT = {
  path: "factory/validation-result.json",
  label: "Daytona validation result",
  maxBytes: DAYTONA_MAX_VALIDATION_RESULT_BYTES,
} as const satisfies RemoteArtifactFile;

const REMOTE_VALIDATION_ERROR = {
  path: "factory/validation-error.txt",
  label: "Daytona validation error",
  maxBytes: MAX_LOG_BYTES,
} as const satisfies RemoteArtifactFile;

function explicitDaytonaDomains(
  destinations: readonly string[],
  policyDestinations: readonly string[],
  phase: "execution" | "validation",
): string[] {
  const required = [
    ...DAYTONA_BOOTSTRAP_DOMAINS,
    ...(phase === "execution" ? DAYTONA_MODEL_DOMAINS : []),
  ];
  const missing = required.filter(
    (domain) => !destinationAllowedByPolicy(domain, [...policyDestinations]),
  );
  if (missing.length > 0) {
    throw new Error(
      `Daytona ${phase} infrastructure is outside immutable Run Policy egress authority: ${missing.join(", ")}`,
    );
  }
  const unauthorizedTasks = destinations.filter(
    (domain) => !destinationAllowedByPolicy(domain, [...policyDestinations]),
  );
  if (unauthorizedTasks.length > 0) {
    throw new Error(
      `Daytona ${phase} task egress is outside immutable Run Policy authority: ${unauthorizedTasks.join(", ")}`,
    );
  }
  return [...new Set([...required, ...destinations])];
}

export interface DaytonaBackendOptions {
  repository: string;
  modelCredentialName?: string;
  daytonaSecretName?: string;
  image?: string;
  /** Dependency seam for deterministic provider lifecycle conformance tests. */
  createClient?: () => Daytona;
  /** Credential seam; the production default reads Daytona's documented env vars. */
  credentialAvailable?: () => boolean;
  /** Bounded eventual-visibility seam for ambiguous create responses. */
  createVisibilityAttempts?: number;
  createVisibilityDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class DaytonaBackend implements ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities = {
    id: "codex-cli/daytona",
    supportTier: "supported",
    agentKind: "codex-cli",
    runtimeKind: "daytona",
    hostExecution: false,
    isolation: "container",
    supportedOs: ["linux"],
    // Daytona's create API does not pin or report architecture. Empty means
    // architecture-specific packets fail capability matching until observed.
    supportedArchitectures: [],
    supportedTools: ["git", "node", "npm", "npx", "bash", "sh", "grep"],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: false,
    supportsLocalInference: false,
    supportsModelSelection: true,
    requiresPaidRuntime: true,
    providerManagedPublication: false,
    requiredCredentials: ["DAYTONA_API_KEY", "FACTORY_DAYTONA_MODEL_SECRET"],
  };

  readonly #repository: string;
  readonly #modelCredential: string;
  readonly #secretName: string | undefined;
  readonly #image: string;
  readonly #createClient: () => Daytona;
  readonly #credentialAvailable: () => boolean;
  readonly #createVisibilityAttempts: number;
  readonly #createVisibilityDelayMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #running = new Map<string, RunningDaytona>();
  readonly #resources = new Map<string, TrackedDaytona>();
  readonly #ambiguousCreates = new Map<string, AmbiguousDaytonaCreate>();
  readonly #deletedHandles = new Set<string>();
  readonly #deletions = new Map<string, Promise<void>>();

  policyRejectionReasons(args: {
    policy: import("../protocol/policy.js").RunPolicy;
    requirements: import("../protocol/worker-packet.js").ExecutionRequirements;
    phase: "execution" | "validation";
  }): readonly string[] {
    try {
      explicitDaytonaDomains(
        args.requirements.networkDestinations,
        args.policy.allowedNetworkDestinations,
        args.phase,
      );
      return [];
    } catch (error) {
      return [errorMessage(error)];
    }
  }

  constructor(options: DaytonaBackendOptions) {
    this.#repository = options.repository;
    this.#modelCredential = options.modelCredentialName ?? "OPENAI_API_KEY";
    this.#secretName = options.daytonaSecretName ?? process.env.FACTORY_DAYTONA_MODEL_SECRET;
    this.#image = options.image ?? DAYTONA_DEFAULT_IMAGE;
    assertImmutableImage(this.#image);
    this.#createClient = options.createClient ?? (() => new Daytona());
    this.#credentialAvailable =
      options.credentialAvailable ??
      (() =>
        Boolean(
          process.env.DAYTONA_API_KEY ||
            (process.env.DAYTONA_JWT_TOKEN && process.env.DAYTONA_ORGANIZATION_ID),
        ));
    this.#createVisibilityAttempts =
      options.createVisibilityAttempts ?? DEFAULT_CREATE_VISIBILITY_ATTEMPTS;
    this.#createVisibilityDelayMs =
      options.createVisibilityDelayMs ?? DEFAULT_CREATE_VISIBILITY_DELAY_MS;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = options.now ?? Date.now;
    if (
      !Number.isInteger(this.#createVisibilityAttempts) ||
      this.#createVisibilityAttempts < 1 ||
      this.#createVisibilityAttempts > 20
    ) {
      throw new Error("Daytona create visibility attempts must be an integer from 1 through 20");
    }
    if (
      !Number.isFinite(this.#createVisibilityDelayMs) ||
      this.#createVisibilityDelayMs < 0 ||
      this.#createVisibilityDelayMs > 5_000 ||
      (this.#createVisibilityAttempts - 1) * this.#createVisibilityDelayMs >
        MAX_CREATE_VISIBILITY_WINDOW_MS
    ) {
      throw new Error(
        "Daytona create visibility delay must be between 0 and 5000 milliseconds with a total window no longer than 30000 milliseconds",
      );
    }
  }

  async probe(): Promise<BackendProbe> {
    const provider = this.#credentialAvailable();
    if (!provider || !this.#secretName) {
      return {
        available: provider,
        authenticated: false,
        reason: !provider
          ? "Daytona authentication is not available"
          : "FACTORY_DAYTONA_MODEL_SECRET does not name a Daytona organization Secret",
        measuredAt: new Date().toISOString(),
      };
    }
    try {
      await this.#resolveScopedModelSecret(this.#createClient());
    } catch (error) {
      return {
        available: true,
        authenticated: false,
        reason: safeDiagnostic(error, "Daytona model Secret probe failure"),
        measuredAt: new Date().toISOString(),
      };
    }
    return {
      available: true,
      authenticated: true,
      measuredAt: new Date().toISOString(),
    };
  }

  async probeValidation(): Promise<BackendProbe> {
    const available = this.#credentialAvailable();
    return {
      available,
      authenticated: available,
      ...(!available ? { reason: "Daytona authentication is not available" } : {}),
      measuredAt: new Date().toISOString(),
    };
  }

  async launch(context: AttemptContext): Promise<BackendHandle> {
    if (this.#now() >= context.deadline.getTime()) {
      throw new Error("Daytona execution deadline elapsed before sandbox creation");
    }
    if (!this.#secretName) throw new Error("Daytona model Secret is not configured");
    const domains = explicitDaytonaDomains(
      context.packet.requirements.networkDestinations,
      context.policyNetworkDestinations ?? [],
      "execution",
    );
    const daytona = this.#createClient();
    await this.#resolveScopedModelSecret(daytona);
    const archive = await repositoryArchive(this.#repository, context.packet.baseSha);
    const ttlMinutes = Math.max(1, Math.ceil((context.deadline.getTime() - this.#now()) / 60_000));
    const resourceName = sandboxResourceName(context);
    let sandbox: Sandbox;
    try {
      sandbox = await daytona.create(
        {
          name: resourceName,
          image: this.#image,
          ephemeral: true,
          autoDeleteInterval: 0,
          ttlMinutes,
          domainAllowList: [...new Set(domains)].join(","),
          labels: {
            factory: "v2",
            objective: String(context.objective),
            workItem: String(context.workItem),
            attempt: String(context.attempt),
            run: context.runId.slice(0, 48),
          },
          secrets: { [this.#modelCredential]: this.#secretName },
          envVars: { FACTORY_SUPERVISED: "1" },
          ...(context.packet.requirements.cpu ||
          context.packet.requirements.memoryMb ||
          context.packet.requirements.diskMb
            ? {
                resources: {
                  ...(context.packet.requirements.cpu
                    ? { cpu: context.packet.requirements.cpu }
                    : {}),
                  ...(context.packet.requirements.memoryMb
                    ? { memory: context.packet.requirements.memoryMb / 1024 }
                    : {}),
                  ...(context.packet.requirements.diskMb
                    ? { disk: context.packet.requirements.diskMb / 1024 }
                    : {}),
                },
              }
            : {}),
        },
        { timeout: 120 },
      );
    } catch (createFailure) {
      await this.#reconcileAmbiguousCreate(
        daytona,
        resourceName,
        "execution",
        ttlMinutes,
        createFailure,
      );
      throw safeFailure(createFailure, "Daytona sandbox creation failure");
    }

    const running: RunningDaytona = {
      sandbox,
      resourceName,
      phase: "execution",
      ttlMinutes,
      result: null,
      error: null,
      context,
    };
    this.#track(running);
    this.#running.set(sandbox.id, running);
    try {
      await sandbox.fs.createFolder("factory", "700");
      await sandbox.fs.uploadFiles(
        sandboxBootstrapFiles(context, archive).map((file) => ({
          source: file.content,
          destination: file.path,
        })),
      );
      const workdir = await sandbox.getWorkDir();
      void sandbox.process
        .executeCommand(
          "bash factory/run.sh",
          workdir,
          undefined,
          Math.max(1, Math.ceil((context.deadline.getTime() - Date.now()) / 1000)),
        )
        .then(
          (result) => {
            running.result = result;
          },
          (error) => {
            running.error = error;
          },
        );
      return {
        backendId: this.capabilities.id,
        resourceId: sandbox.id,
        startedAt: new Date().toISOString(),
        metadata: {
          sandbox: sandbox.id,
          resourceName,
          environmentIdentity: this.#image,
        },
      };
    } catch (launchFailure) {
      await this.#deleteTracked(running, "launch rollback", launchFailure);
      throw safeFailure(launchFailure, "Daytona launch failure");
    }
  }

  async observe(handle: BackendHandle): Promise<BackendObservation> {
    const running = this.#require(handle);
    if (running.error) {
      return {
        state: "failed",
        observedAt: new Date().toISOString(),
        reason: safeDiagnostic(running.error, "Daytona worker error"),
      };
    }
    if (!running.result) return { state: "running", observedAt: new Date().toISOString() };
    return {
      state: running.result.exitCode === 0 ? "succeeded" : "failed",
      observedAt: new Date().toISOString(),
      ...(running.result.exitCode === 0
        ? {}
        : {
            reason: running.result.result
              ? safeDiagnostic(running.result.result, "Daytona worker output")
              : `sandbox exited ${running.result.exitCode}`,
          }),
    };
  }

  async cancel(handle: BackendHandle): Promise<void> {
    await this.#deleteHandle(handle, "cancellation");
  }

  async collect(handle: BackendHandle): Promise<NormalizedArtifact> {
    const running = this.#require(handle);
    let files: [Buffer, Buffer, Buffer, Buffer, Buffer];
    try {
      const details = await Promise.all(
        REMOTE_ARTIFACT_FILES.map(async (file) => ({
          file,
          details: await running.sandbox.fs.getFileDetails(file.path),
        })),
      );
      const expectedSizes = details.map(({ file, details: metadata }) => {
        if (metadata.isDir) throw new Error(`${file.label} is a directory, not a file`);
        if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
          throw new Error(`${file.label} has invalid provider size metadata`);
        }
        if (metadata.size > file.maxBytes) {
          throw new Error(`${file.label} is ${metadata.size} bytes; maximum is ${file.maxBytes}`);
        }
        return metadata.size;
      });
      files = (await Promise.all(
        REMOTE_ARTIFACT_FILES.map((file, index) =>
          this.#downloadRemoteFile(running.sandbox, file, expectedSizes[index]!),
        ),
      )) as [Buffer, Buffer, Buffer, Buffer, Buffer];
    } catch (error) {
      throw safeFailure(error, "Daytona artifact collection failure");
    }
    const [patch, paths, exit, stdout, stderr] = files;
    const exitCode = Number(exit.toString("utf8"));
    const patchText = patch.toString("utf8");
    const outcome =
      exitCode === 0 && patchText.trim() ? "succeeded" : patchText.trim() ? "failed" : "declined";
    return normalizeArtifact({
      baseSha: running.context.packet.baseSha,
      patch: patchText,
      changedPaths: parseSandboxPaths(paths),
      logs: `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`,
      outcome,
      ...(outcome === "succeeded" ? {} : { reason: `sandbox worker exited ${exitCode}` }),
    });
  }

  async cleanup(handle: BackendHandle): Promise<void> {
    await this.#deleteHandle(handle, "final cleanup");
  }

  async validate(context: IsolatedValidationContext): Promise<IsolatedValidationResult> {
    const invocationOwner = validationInvocationOwnership(context);
    if (this.#now() >= context.deadline.getTime()) {
      throw new Error("Daytona validation deadline elapsed before sandbox creation");
    }
    const domains = explicitDaytonaDomains(
      context.packet.requirements.networkDestinations,
      context.policyNetworkDestinations ?? [],
      "validation",
    );
    const archive = await repositoryArchive(this.#repository, context.packet.baseSha);
    const ttlMinutes = Math.max(1, Math.ceil((context.deadline.getTime() - this.#now()) / 60_000));
    const daytona = this.#createClient();
    const resourceName = sandboxResourceName(context, "validation");
    let sandbox: Sandbox;
    try {
      sandbox = await daytona.create(
        {
          name: resourceName,
          image: this.#image,
          ephemeral: true,
          autoDeleteInterval: 0,
          ttlMinutes,
          domainAllowList: [...new Set(domains)].join(","),
          labels: {
            factory: "v2",
            phase: "validation",
            ...(invocationOwner ? { invocationOwner } : {}),
            objective: String(context.objective),
            workItem: String(context.workItem),
            attempt: String(context.attempt),
            run: context.runId.slice(0, 48),
          },
          envVars: { FACTORY_SUPERVISED: "1" },
          ...(context.packet.requirements.cpu ||
          context.packet.requirements.memoryMb ||
          context.packet.requirements.diskMb
            ? {
                resources: {
                  ...(context.packet.requirements.cpu
                    ? { cpu: context.packet.requirements.cpu }
                    : {}),
                  ...(context.packet.requirements.memoryMb
                    ? { memory: context.packet.requirements.memoryMb / 1024 }
                    : {}),
                  ...(context.packet.requirements.diskMb
                    ? { disk: context.packet.requirements.diskMb / 1024 }
                    : {}),
                },
              }
            : {}),
        },
        { timeout: 120 },
      );
    } catch (createFailure) {
      await this.#reconcileAmbiguousCreate(
        daytona,
        resourceName,
        "validation",
        ttlMinutes,
        createFailure,
        invocationOwner ?? undefined,
      );
      throw safeFailure(createFailure, "Daytona validator creation failure");
    }

    if (
      invocationOwner &&
      (sandbox.name !== resourceName || sandbox.labels?.invocationOwner !== invocationOwner)
    )
      throw new Error(
        "Daytona created validation resource has mismatching ownership; refusing use or cleanup",
      );

    const tracked: TrackedDaytona = {
      sandbox,
      resourceName,
      phase: "validation",
      ttlMinutes,
    };
    this.#track(tracked);
    let result: IsolatedValidationResult | undefined;
    let validationFailure: unknown;
    let validationFailed = false;
    try {
      await sandbox.fs.createFolder("factory", "700");
      await sandbox.fs.uploadFiles(
        sandboxValidationFiles(context, archive).map((file) => ({
          source: file.content,
          destination: file.path,
        })),
      );
      const workdir = await sandbox.getWorkDir();
      const command = await sandbox.process.executeCommand(
        "node factory/validate.mjs",
        workdir,
        undefined,
        Math.max(1, Math.ceil((context.deadline.getTime() - Date.now()) / 1000)),
      );
      if (command.exitCode !== 0) {
        let detail: Buffer | null = null;
        try {
          detail = await this.#downloadBoundedRemoteFile(sandbox, REMOTE_VALIDATION_ERROR);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        throw new Error(
          detail
            ? safeDiagnostic(detail.toString("utf8"), "Daytona validator diagnostic")
            : command.result
              ? safeDiagnostic(command.result, "Daytona validator output")
              : `isolated validator exited ${command.exitCode}`,
        );
      }
      result = parseIsolatedValidationResult(
        await this.#downloadBoundedRemoteFile(sandbox, REMOTE_VALIDATION_RESULT),
      );
    } catch (error) {
      validationFailed = true;
      validationFailure = error;
    }

    await this.#deleteTracked(
      tracked,
      "validation cleanup",
      validationFailed ? validationFailure : undefined,
    );
    if (validationFailed) {
      throw safeFailure(validationFailure, "Daytona validation failure");
    }
    if (!result) throw new Error("isolated Daytona validator produced no result");
    return { ...result, environmentIdentity: this.#image };
  }

  async reconcileStale(identity: StaleAttemptIdentity): Promise<void> {
    const invocationOwner = validationInvocationOwnership(identity);
    const resourceName = sandboxResourceName(identity, identity.phase);
    const locator = identity.providerResourceId ?? resourceName;
    const durableReplacementFence = identity.providerResourceId
      ? undefined
      : parseReplacementFence(identity.noHandleReplacementNotBefore);
    const tracked = [...this.#resources.values()].find(
      (resource) => resource.resourceName === resourceName || resource.sandbox.id === locator,
    );
    if (tracked) {
      if (
        invocationOwner &&
        (tracked.sandbox.name !== resourceName ||
          tracked.sandbox.labels?.invocationOwner !== invocationOwner)
      )
        throw new Error("Daytona tracked validation resource ownership mismatch; refusing cleanup");
      await this.#deleteTracked(tracked, "stale-attempt reconciliation");
      return;
    }

    const daytona = this.#createClient();
    const ambiguity = identity.providerResourceId
      ? undefined
      : this.#ambiguousCreates.get(resourceName);
    const replacementNotBefore = Math.max(
      durableReplacementFence ?? Number.NEGATIVE_INFINITY,
      ambiguity?.expiresAtMs ?? Number.NEGATIVE_INFINITY,
    );
    let sandbox: Sandbox | null;
    try {
      sandbox = identity.providerResourceId
        ? await this.#findWithBoundedVisibility(daytona, locator, 1)
        : await this.#findWithBoundedVisibility(daytona, resourceName);
    } catch (error) {
      throw new DaytonaResourceCleanupError({
        resourceId: locator,
        resourceName,
        operation: ambiguity ? "ambiguous create stale-attempt lookup" : "stale-attempt lookup",
        cause: error,
        ...(ambiguity ? { ttlMinutes: ambiguity.ttlMinutes } : {}),
      });
    }
    if (!sandbox) {
      if (!Number.isFinite(replacementNotBefore)) return;
      if (this.#now() >= replacementNotBefore) {
        this.#ambiguousCreates.delete(resourceName);
        return;
      }
      const remainingTtlMinutes = Math.max(
        1,
        Math.ceil((replacementNotBefore - this.#now()) / 60_000),
      );
      throw new DaytonaResourceCleanupError({
        resourceId: "provider-id-unavailable",
        resourceName,
        operation: ambiguity
          ? "ambiguous create remains inside provider TTL"
          : "durable no-handle replacement fence remains active",
        cause:
          ambiguity?.createFailure ??
          "a durable reservation permits a pre-handle provider allocation",
        priorFailure:
          `bounded visibility checks still report absence; replacement is unsafe until ` +
          `${new Date(replacementNotBefore).toISOString()} and a subsequent absence check`,
        ttlMinutes: ambiguity?.ttlMinutes ?? remainingTtlMinutes,
      });
    }
    const recovered: TrackedDaytona = {
      sandbox,
      resourceName,
      phase: identity.phase === "validation" ? "validation" : "execution",
      ...(ambiguity ? { ttlMinutes: ambiguity.ttlMinutes } : {}),
    };
    if (
      invocationOwner &&
      (sandbox.name !== resourceName || sandbox.labels?.invocationOwner !== invocationOwner)
    )
      throw new Error(
        "Daytona validation invocation resource ownership mismatch; refusing cleanup",
      );
    this.#track(recovered);
    await this.#deleteTracked(recovered, "stale-attempt reconciliation");
  }

  async #downloadRemoteFile(
    sandbox: Sandbox,
    file: RemoteArtifactFile,
    expectedSize: number,
  ): Promise<Buffer> {
    const controller = new AbortController();
    let progressExceeded = false;
    let stream: Readable;
    try {
      stream = await sandbox.fs.downloadFileStream(file.path, {
        signal: controller.signal,
        onProgress: ({ bytesReceived }) => {
          if (bytesReceived > file.maxBytes) {
            progressExceeded = true;
            controller.abort();
          }
        },
      });
    } catch (error) {
      if (progressExceeded) {
        throw new Error(`${file.label} exceeded ${file.maxBytes} bytes while downloading`);
      }
      throw error;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
        received += bytes.byteLength;
        if (received > file.maxBytes) {
          controller.abort();
          stream.destroy();
          throw new Error(`${file.label} exceeded ${file.maxBytes} bytes while downloading`);
        }
        chunks.push(bytes);
      }
    } catch (error) {
      if (progressExceeded) {
        throw new Error(`${file.label} exceeded ${file.maxBytes} bytes while downloading`);
      }
      throw error;
    }
    if (received !== expectedSize) {
      throw new Error(
        `${file.label} changed after metadata inspection: expected ${expectedSize} bytes, received ${received}`,
      );
    }
    return Buffer.concat(chunks, received);
  }

  async #downloadBoundedRemoteFile(sandbox: Sandbox, file: RemoteArtifactFile): Promise<Buffer> {
    const metadata = await sandbox.fs.getFileDetails(file.path);
    if (metadata.isDir) throw new Error(`${file.label} is a directory, not a file`);
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      throw new Error(`${file.label} has invalid provider size metadata`);
    }
    if (metadata.size > file.maxBytes) {
      throw new Error(`${file.label} is ${metadata.size} bytes; maximum is ${file.maxBytes}`);
    }
    return this.#downloadRemoteFile(sandbox, file, metadata.size);
  }

  async #resolveScopedModelSecret(daytona: Daytona): Promise<Secret> {
    const configuredName = this.#secretName;
    if (!configuredName) throw new Error("Daytona model Secret is not configured");

    const exactMatches: Secret[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let exhausted = false;
    try {
      for (let page = 0; page < MAX_SECRET_LIST_PAGES; page += 1) {
        const result = await daytona.secret.list({
          name: configuredName,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        exactMatches.push(...result.items.filter((secret) => secret.name === configuredName));
        if (exactMatches.length > 1) break;
        if (!result.nextCursor) {
          exhausted = true;
          break;
        }
        if (seenCursors.has(result.nextCursor)) {
          throw new Error("Daytona returned a repeated Secret-list cursor");
        }
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
    } catch (error) {
      throw new Error(
        `Could not inspect the Daytona organization Secret named by FACTORY_DAYTONA_MODEL_SECRET: ${safeDiagnostic(error, "Daytona Secret metadata lookup")}`,
      );
    }

    if (!exhausted && exactMatches.length <= 1) {
      throw new Error(
        "Could not prove that FACTORY_DAYTONA_MODEL_SECRET uniquely names a Daytona organization Secret because its bounded metadata lookup did not finish",
      );
    }
    if (exactMatches.length !== 1) {
      throw new Error(
        `FACTORY_DAYTONA_MODEL_SECRET must uniquely name one Daytona organization Secret; found ${exactMatches.length} exact matches`,
      );
    }

    const secret = exactMatches[0]!;
    if (typeof secret.placeholder !== "string" || !/^dtn_secret_\S+$/.test(secret.placeholder)) {
      throw new Error(
        "The configured Daytona organization Secret did not return the expected opaque dtn_secret_ placeholder metadata",
      );
    }
    if (
      !Array.isArray(secret.hosts) ||
      secret.hosts.length !== 1 ||
      typeof secret.hosts[0] !== "string" ||
      secret.hosts[0]?.toLocaleLowerCase("en-US") !== DAYTONA_MODEL_DOMAINS[0]
    ) {
      throw new Error(
        'The Daytona organization Secret named by FACTORY_DAYTONA_MODEL_SECRET must set hosts to exactly ["api.openai.com"]; empty hosts are unrestricted, and wildcard or additional hosts are not supported',
      );
    }
    return secret;
  }

  async #reconcileAmbiguousCreate(
    daytona: Daytona,
    resourceName: string,
    phase: "execution" | "validation",
    ttlMinutes: number,
    createFailure: unknown,
    invocationOwner?: string,
  ): Promise<void> {
    const definitiveRejection = isDefinitiveCreateRejection(createFailure);
    const ambiguity: AmbiguousDaytonaCreate = {
      resourceName,
      phase,
      ttlMinutes,
      expiresAtMs: this.#now() + ttlMinutes * 60_000,
      createFailure: safeDiagnostic(createFailure, "Daytona ambiguous create failure"),
    };
    if (!definitiveRejection) this.#ambiguousCreates.set(resourceName, ambiguity);
    let sandbox: Sandbox | null;
    try {
      sandbox = await this.#findWithBoundedVisibility(
        daytona,
        resourceName,
        definitiveRejection ? 1 : this.#createVisibilityAttempts,
      );
    } catch (lookupFailure) {
      throw new DaytonaResourceCleanupError({
        resourceId: "provider-id-unavailable",
        resourceName,
        operation: "ambiguous create lookup",
        cause: lookupFailure,
        priorFailure: createFailure,
        ttlMinutes,
      });
    }
    if (!sandbox) {
      if (definitiveRejection) return;
      throw new DaytonaResourceCleanupError({
        resourceId: "provider-id-unavailable",
        resourceName,
        operation: "ambiguous create visibility timeout",
        cause: createFailure,
        priorFailure: `resource was not visible after ${this.#createVisibilityAttempts} bounded checks`,
        ttlMinutes,
      });
    }
    if (
      invocationOwner &&
      (sandbox.name !== resourceName || sandbox.labels?.invocationOwner !== invocationOwner)
    )
      throw new Error("Daytona ambiguous validation resource ownership mismatch; refusing cleanup");
    const tracked: TrackedDaytona = {
      sandbox,
      resourceName,
      phase,
      ttlMinutes,
    };
    this.#track(tracked);
    await this.#deleteTracked(tracked, "ambiguous create rollback", createFailure);
  }

  async #findWithBoundedVisibility(
    daytona: Daytona,
    locator: string,
    attempts = this.#createVisibilityAttempts,
  ): Promise<Sandbox | null> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await daytona.get(locator);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        if (attempt < attempts) {
          await this.#sleep(this.#createVisibilityDelayMs);
        }
      }
    }
    return null;
  }

  #track(resource: TrackedDaytona): void {
    this.#resources.set(resource.sandbox.id, resource);
    this.#deletedHandles.delete(resource.sandbox.id);
  }

  #forget(resource: TrackedDaytona): void {
    if (this.#resources.get(resource.sandbox.id) === resource) {
      this.#resources.delete(resource.sandbox.id);
    }
    if (this.#running.get(resource.sandbox.id) === resource) {
      this.#running.delete(resource.sandbox.id);
    }
    this.#ambiguousCreates.delete(resource.resourceName);
  }

  async #deleteTracked(
    resource: TrackedDaytona,
    operation: string,
    priorFailure?: unknown,
  ): Promise<void> {
    const resourceId = resource.sandbox.id;
    const pending = this.#deletions.get(resourceId);
    if (pending) return pending;
    const deletion = (async () => {
      try {
        await resource.sandbox.delete(60, true);
      } catch (error) {
        if (isNotFound(error)) {
          this.#forget(resource);
          return;
        }
        throw new DaytonaResourceCleanupError({
          resourceId,
          resourceName: resource.resourceName,
          operation,
          cause: error,
          ...(priorFailure === undefined ? {} : { priorFailure }),
          ...(resource.ttlMinutes === undefined ? {} : { ttlMinutes: resource.ttlMinutes }),
        });
      }
      this.#forget(resource);
    })();
    this.#deletions.set(resourceId, deletion);
    try {
      await deletion;
    } finally {
      if (this.#deletions.get(resourceId) === deletion) {
        this.#deletions.delete(resourceId);
      }
    }
  }

  async #deleteHandle(handle: BackendHandle, operation: string): Promise<void> {
    if (handle.backendId !== this.capabilities.id) {
      throw new Error(`handle belongs to ${handle.backendId}`);
    }
    if (this.#deletedHandles.has(handle.resourceId)) return;
    const running = this.#running.get(handle.resourceId);
    if (!running) throw new Error(`unknown Daytona sandbox ${handle.resourceId}`);
    await this.#deleteTracked(running, operation);
    this.#deletedHandles.add(handle.resourceId);
  }

  #require(handle: BackendHandle): RunningDaytona {
    if (handle.backendId !== this.capabilities.id)
      throw new Error(`handle belongs to ${handle.backendId}`);
    const running = this.#running.get(handle.resourceId);
    if (!running) {
      if (this.#deletedHandles.has(handle.resourceId)) {
        throw new Error(`Daytona sandbox ${handle.resourceId} has already been deleted`);
      }
      throw new Error(`unknown Daytona sandbox ${handle.resourceId}`);
    }
    return running;
  }
}
