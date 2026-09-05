import type { ModelSelection, RunPolicy } from "../protocol/policy.js";
import type { ExecutionRequirements, WorkerPacket } from "../protocol/worker-packet.js";
import { workerPacketDigest } from "../protocol/worker-packet.js";
import type { NormalizedArtifact } from "./artifacts.js";
import { LocalScopeBatchSchema, type LocalScopeBatch } from "../protocol/local-scope.js";

export type IsolationKind = "none" | "process" | "container" | "microvm" | "managed";

export interface ExecutionBackendCapabilities {
  id: string;
  /** Factory's support contract; omitted third-party test doubles default to supported. */
  supportTier?: "supported" | "labs";
  agentKind: string;
  runtimeKind: string;
  hostExecution: boolean;
  isolation: IsolationKind;
  supportedOs: string[];
  supportedArchitectures: string[];
  supportedTools: string[];
  supportedServices: string[];
  supportsCancellation: boolean;
  supportsObservation: boolean;
  supportsResume: boolean;
  supportsLocalInference: boolean;
  /** Terminal observations include provider model-token counters. */
  reportsModelUsage?: boolean;
  /** Launch accepts the immutable model selection carried by AttemptContext. */
  supportsModelSelection?: boolean;
  requiresPaidRuntime: boolean;
  providerManagedPublication: boolean;
  requiredCredentials: string[];
  resourceLimits?: Record<string, number>;
}

export interface BackendProbe {
  available: boolean;
  authenticated: boolean;
  reason?: string;
  measuredAt: string;
}

export interface AttemptContext {
  /** Canonical GitHub repository identity (OWNER/REPO), never a filesystem path. */
  repository: string;
  objective: number;
  workItem: number;
  attempt: number;
  runId: string;
  directorEpoch: number;
  policyDigest: string;
  workspace: string;
  packet: WorkerPacket;
  /** Immutable per-phase choice resolved from RunPolicy.models. */
  modelSelection?: ModelSelection;
  /** Immutable Run Policy egress authority, distinct from task-required destinations. */
  policyNetworkDestinations?: readonly string[];
  /** GitHub-visible branch a provider-managed worker must branch from. */
  providerBaseRef?: string;
  deadline: Date;
  /** A prior host-validated patch is already present for an incremental retry. */
  seededFromArtifact?: boolean;
  /** Prepared and durably journaled by the Supervisor, never by a backend. */
  localExecutionScope?: {
    batch: LocalScopeBatch;
    assertCurrent: () => Promise<void>;
  };
}

/** Reject a borrowed or stale launch descriptor before touching an executable.
 * This validates bindings only; the caller still needs the supplied live fence. */
export function localExecutionScopeBatch(context: AttemptContext): LocalScopeBatch | undefined {
  if (!context.localExecutionScope) return undefined;
  const batch = LocalScopeBatchSchema.parse(context.localExecutionScope.batch);
  const identity = batch.identity;
  if (
    identity.repository !== context.repository.toLowerCase() ||
    identity.objective !== context.objective ||
    identity.workItem !== context.workItem ||
    identity.attempt !== context.attempt ||
    identity.runId !== context.runId ||
    identity.directorEpoch !== context.directorEpoch ||
    identity.policyDigest !== context.policyDigest ||
    identity.phase !== "execution" ||
    identity.commandIndex !== 0 ||
    identity.invocationDigest !== workerPacketDigest(context.packet) ||
    batch.commandCount !== 1 ||
    batch.producerPid !== process.pid ||
    batch.deadline !== context.deadline.toISOString() ||
    typeof context.localExecutionScope.assertCurrent !== "function"
  ) {
    throw new Error("local execution scope does not match the prepared attempt");
  }
  return batch;
}

export interface BackendHandle {
  backendId: string;
  resourceId: string;
  startedAt: string;
  metadata?: Record<string, string>;
}

/** Provider-neutral accounting. Missing counters stay unavailable, never zero. */
export interface ExecutionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

export type BackendObservationState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface BackendObservation {
  state: BackendObservationState;
  observedAt: string;
  reason?: string;
  progress?: string;
  usage?: ExecutionUsage;
}

export interface IsolatedValidationContext extends AttemptContext {
  artifact: NormalizedArtifact;
  /** Distinct, immutable revalidation of a published sibling; never an attempt retry. */
  validationInvocation?: IntegrationValidationInvocation;
}

export interface IntegrationValidationInvocation {
  kind: "integration-candidate";
  identityDigest: string;
  artifactDigest: string;
  baseSha: string;
}

export interface IsolatedValidationResult {
  outputTreeSha: string;
  commands: Array<{ command: string; exitCode: number; durationMs: number }>;
  passed: boolean;
  failureReason?: string;
  startedAt: string;
  completedAt: string;
  /** Exact immutable provider snapshot or image identity used for validation. */
  environmentIdentity?: string;
}

export interface StaleAttemptIdentity {
  /** Required with validationInvocation to bind the original resource authority. */
  policyDigest?: string;
  validationInvocation?: IntegrationValidationInvocation;
  /** Canonical GitHub repository identity (OWNER/REPO), required for safe local fencing. */
  repository: string;
  objective: number;
  workItem: number;
  attempt: number;
  runId: string;
  directorEpoch: number;
  phase?: "execution" | "validation";
  providerResourceId?: string;
  /**
   * Durable conservative fence for a create that may have committed before a
   * handle/AttemptStarted receipt existed. Absence before this instant cannot
   * authorize a replacement paid resource.
   */
  noHandleReplacementNotBefore?: string;
}

export interface ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities;
  /** Deterministic policy incompatibilities checked before admission or graph writes. */
  policyRejectionReasons?(args: {
    policy: RunPolicy;
    requirements: ExecutionRequirements;
    phase: "execution" | "validation";
  }): readonly string[];
  probe(requirements?: ExecutionRequirements): Promise<BackendProbe>;
  launch(context: AttemptContext): Promise<BackendHandle>;
  observe(handle: BackendHandle): Promise<BackendObservation>;
  cancel(handle: BackendHandle): Promise<void>;
  collect(handle: BackendHandle): Promise<NormalizedArtifact>;
  cleanup(handle: BackendHandle): Promise<void>;
  /** Run declared checks in a fresh resource, independent of the worker resource. */
  validate?(context: IsolatedValidationContext): Promise<IsolatedValidationResult>;
  /** Validation does not require a model credential, so it has a distinct probe. */
  probeValidation?(): Promise<BackendProbe>;
  /** Ensure a prior Director's resource is absent before a replacement attempt. */
  reconcileStale?(identity: StaleAttemptIdentity): Promise<void>;
  /** Reattach only when the durable identity can be proven to belong to this attempt. */
  resume?(context: AttemptContext, handle: BackendHandle): Promise<BackendHandle>;
}

const isolationRank: Record<IsolationKind, number> = {
  none: 0,
  process: 1,
  container: 2,
  microvm: 3,
  managed: 3,
};

export function canonicalArchitecture(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["amd64", "x86-64", "x86_64"].includes(normalized)) return "x64";
  if (["aarch64", "arm64-v8a"].includes(normalized)) return "arm64";
  if (["x86", "i386", "i486", "i586", "i686"].includes(normalized)) return "ia32";
  return normalized;
}

export function canonicalOperatingSystem(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["windows", "windows_nt"].includes(normalized)) return "win32";
  if (["mac", "macos", "osx"].includes(normalized)) return "darwin";
  if (normalized === "gnu/linux") return "linux";
  return normalized;
}

export function capabilityMismatch(
  capabilities: ExecutionBackendCapabilities,
  requirements: ExecutionRequirements,
): string[] {
  const reasons: string[] = [];
  if (
    requirements.trust === "isolated" &&
    isolationRank[capabilities.isolation] < isolationRank.container
  ) {
    reasons.push("requires container-or-stronger isolation");
  }
  if (requirements.trust === "managed" && capabilities.isolation !== "managed") {
    reasons.push("requires a managed runtime");
  }
  if (
    requirements.os.length > 0 &&
    !requirements.os.some((os) =>
      capabilities.supportedOs.some(
        (supported) => canonicalOperatingSystem(supported) === canonicalOperatingSystem(os),
      ),
    )
  ) {
    reasons.push(`unsupported OS (${requirements.os.join(", ")})`);
  }
  if (
    requirements.architecture.length > 0 &&
    !requirements.architecture.some((arch) =>
      capabilities.supportedArchitectures.some(
        (supported) => canonicalArchitecture(supported) === canonicalArchitecture(arch),
      ),
    )
  ) {
    reasons.push(`unsupported architecture (${requirements.architecture.join(", ")})`);
  }
  for (const tool of requirements.tools) {
    if (!capabilities.supportedTools.includes(tool)) reasons.push(`missing tool ${tool}`);
  }
  for (const service of requirements.services) {
    if (!capabilities.supportedServices.includes(service)) {
      reasons.push(`missing service ${service}`);
    }
  }
  const limits = capabilities.resourceLimits ?? {};
  if (requirements.cpu && limits.cpu && requirements.cpu > limits.cpu) {
    reasons.push(`requires ${requirements.cpu} CPUs; backend limit is ${limits.cpu}`);
  }
  if (requirements.memoryMb && limits.memoryMb && requirements.memoryMb > limits.memoryMb) {
    reasons.push(
      `requires ${requirements.memoryMb} MB memory; backend limit is ${limits.memoryMb}`,
    );
  }
  if (requirements.diskMb && limits.diskMb && requirements.diskMb > limits.diskMb) {
    reasons.push(`requires ${requirements.diskMb} MB disk; backend limit is ${limits.diskMb}`);
  }
  return reasons;
}
