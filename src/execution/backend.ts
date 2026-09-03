import type { ExecutionRequirements, WorkerPacket } from "../protocol/worker-packet.js";
import type { NormalizedArtifact } from "./artifacts.js";

export type IsolationKind = "none" | "process" | "container" | "microvm" | "managed";

export interface ExecutionBackendCapabilities {
  id: string;
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
  objective: number;
  workItem: number;
  attempt: number;
  runId: string;
  directorEpoch: number;
  policyDigest: string;
  workspace: string;
  packet: WorkerPacket;
  deadline: Date;
}

export interface BackendHandle {
  backendId: string;
  resourceId: string;
  startedAt: string;
  metadata?: Record<string, string>;
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
}

export interface IsolatedValidationContext extends AttemptContext {
  artifact: NormalizedArtifact;
}

export interface IsolatedValidationResult {
  outputTreeSha: string;
  commands: Array<{ command: string; exitCode: number; durationMs: number }>;
  passed: boolean;
  failureReason?: string;
  startedAt: string;
  completedAt: string;
}

export interface StaleAttemptIdentity {
  objective: number;
  workItem: number;
  attempt: number;
  runId: string;
  directorEpoch: number;
  providerResourceId?: string;
}

export interface ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities;
  probe(): Promise<BackendProbe>;
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
}

const isolationRank: Record<IsolationKind, number> = {
  none: 0,
  process: 1,
  container: 2,
  microvm: 3,
  managed: 3,
};

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
    !requirements.os.some((os) => capabilities.supportedOs.includes(os))
  ) {
    reasons.push(`unsupported OS (${requirements.os.join(", ")})`);
  }
  if (
    requirements.architecture.length > 0 &&
    !requirements.architecture.some((arch) =>
      capabilities.supportedArchitectures.includes(arch),
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
  if (
    requirements.memoryMb &&
    limits.memoryMb &&
    requirements.memoryMb > limits.memoryMb
  ) {
    reasons.push(
      `requires ${requirements.memoryMb} MB memory; backend limit is ${limits.memoryMb}`,
    );
  }
  if (requirements.diskMb && limits.diskMb && requirements.diskMb > limits.diskMb) {
    reasons.push(`requires ${requirements.diskMb} MB disk; backend limit is ${limits.diskMb}`);
  }
  return reasons;
}
