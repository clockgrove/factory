import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { CodexCliLocalBackend } from "./backends/codex-cli-local.js";
import { CodexSdkLocalBackend } from "./backends/codex-sdk-local.js";
import { CodexAppServerLocalBackend } from "./backends/codex-app-server.js";
import {
  GITHUB_MANAGED_AGENT_PROFILES,
  GitHubManagedAgentBackend,
  resolveManagedAgentActor,
} from "./backends/github-copilot.js";
import { DaytonaBackend, DaytonaResourceCleanupError } from "./backends/daytona.js";
import { VercelSandboxBackend } from "./backends/vercel-sandbox.js";
import { validationInvocationOwnership } from "./backends/validation-invocation.js";
import { AttemptManager, type AttemptReservation } from "./control/attempts.js";
import { activationCancellation, type ActivationBinding } from "./control/activations.js";
import {
  deriveBudgetUsage,
  remainingBudget,
  unreconciledBudgetReservations,
} from "./control/budget.js";
import {
  type AdmissionGateCommand,
  deriveDurableCommandState,
  type DurableCommandState,
} from "./control/commands.js";
import { LifecycleRecorder } from "./control/events.js";
import {
  CompiledGraphManager,
  type CompiledGraphProjectionRecord,
  type CompiledGraphRecord,
} from "./control/graphs.js";
import {
  assertSnapshotMatchesCompiledGraph,
  assertAuthenticatedGraphProjection,
} from "./control/graph-evidence.js";
export {
  assertSnapshotMatchesCompiledGraph,
  assertAuthenticatedGraphProjection,
  type CompiledGraphSnapshot,
  type GraphProjectionExpectation,
} from "./control/graph-evidence.js";
import { GitHubControlStore } from "./control/github-store.js";
import {
  DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
  DEFAULT_LEASE_RENEWAL_LEAD_MS,
  LeaseLostError,
  LeaseManager,
  type LeaseState,
} from "./control/lease.js";
import {
  deduplicateFactoryEvents,
  encodeEventComment,
  nextEventSequence,
  latestSupportedRun,
} from "./control/receipts.js";
import { RunManager, type RunState } from "./control/runs.js";
import { loadRecoveryRuntime, type RecoveryRuntime } from "./recovery/runtime.js";
import {
  loadRecoverySourceArtifact,
  createRecoverySourcePublishedEvent,
  verifyRecoverySourcePublication,
  recoverySourcePublicationBinding,
  type RecoverySourceArtifactProof,
} from "./recovery/source-publications.js";
import {
  ensureRecoveryNativeSourceStack,
  isNativePublicationStackLink,
  verifiedNativeStackSuffix,
  type RecoveryNativeExistingMember,
} from "./recovery/native-source-stacks.js";
import { verifyRecoveryResources } from "./recovery/resources.js";
import { recoveryReadPort } from "./recovery/github-read-port.js";
import { observeRecoveryNativeTransition } from "./recovery/native-transition.js";
import {
  createRecoverySourceIntegratedEvent,
  verifyRecoverySourceIntegration,
  verifyPriorRecoveryDelivery,
} from "./recovery/outcomes.js";
import { inspectImplicitRestart } from "./control/recovery.js";
import {
  MergeCandidateCheckpointStore,
  mergeCandidateIdentityDigest,
  type MergeCandidateCheckpointRecord,
  type MergeCandidateIdentity,
} from "./control/merge-candidates.js";
import { verifyMergeCandidateSquash } from "./publication/merge-candidate.js";
import {
  NativeRebaseCheckpointStore,
  nativeRebaseIdentityDigest,
  nativeRebaseResourceOwnership,
  nativeRebaseValidationInvocation,
  type NativeRebaseIdentity,
  type NativeRebaseCheckpointRecord,
} from "./control/native-rebases.js";
import {
  ReviewCheckpointManager,
  reviewIdentityDigest,
  runDurableReviewTransaction,
  type ReviewCheckpointRecord,
  type ReviewIdentity,
} from "./control/reviews.js";
import { parseFactoryEvent, type FactoryEvent } from "./protocol/events.js";
import { assertNoSecretMaterial, PROTOCOL_V2 } from "./protocol/limits.js";
import {
  assertRequirementsWithinPolicy,
  isManagedAgentBackendId,
  isSandboxBackendId,
  normalizeSchedulingPolicy,
  parseRunPolicy,
  policyDigest,
  resolveModelSelection,
  type RunPolicy,
} from "./protocol/policy.js";
import {
  parseWorkerPacket,
  workerPacketDigest,
  type WorkerPacket,
} from "./protocol/worker-packet.js";
import { recoveryEventDigest } from "./recovery/identity.js";
import {
  BackendRegistry,
  NoExecutionBackendError,
  type BackendCandidate,
} from "./execution/registry.js";
import type { BackendHandle, ExecutionBackend, ExecutionUsage } from "./execution/backend.js";
import {
  MAX_ARTIFACT_PATCH_BYTES,
  normalizeArtifact,
  type NormalizedArtifact,
} from "./execution/artifacts.js";
import { Dispatcher, GithubOctokitWriter } from "./dispatch.js";
import {
  compiledGraphDigest,
  GraphApplier,
  GithubOctokitGraphWriter,
  parseGraphItemMetadata,
  parseWorkerPacketFromIssue,
  workerPacketFromCompiled,
  type CompiledObjective,
  type ExistingGraphWorkItem,
} from "./graph.js";
import { GitHubReader, type GitHubOptions } from "./github.js";
import { CodexCliManagementBackend } from "./management/codex-cli.js";
import { ManagementOutputError } from "./management/backend.js";
import { reportedModelUsage, type ReportedModelUsage } from "./protocol/model-usage.js";
import type {
  CompilationCheckpoint,
  CompilationResult,
  ManagementBackend,
  ManagementUsage,
} from "./management/backend.js";
import {
  integrationReadiness,
  publicationBranch,
  publishValidated,
  verifySquashIntegration,
  type PublishedPullRequest,
} from "./publication/publisher.js";
import {
  branchRuleBlockers,
  missingRequiredChecks,
  requiredChecks,
} from "./publication/branch-policy.js";
import {
  admissionsWithinDeliverySafety,
  planDelivery,
  selectDelivery,
  type DeliveryPlan,
  type DeliverySelection,
} from "./publication/delivery.js";
import { GITHUB_STACKS_API_VERSION, GitHubStacks } from "./publication/github-stacks.js";
import {
  acquireIntegrationLease,
  assertIntegrationHeads,
} from "./publication/integration-lease.js";
import {
  PUBLICATION_RECEIPT_PROTOCOL,
  assertPublicationEventMatchesReceipt,
  type PublicationReceipt,
} from "./publication/stack-manager.js";
import {
  cleanupLocalWorktree,
  createLocalWorktree,
  seedLocalWorktree,
  type LocalWorktree,
} from "./runtime/local-worktree.js";
import { runContainedProcess } from "./runtime/process-group.js";
import { allDone, derive, queuedSince, ready, type DerivedWorkItem } from "./state.js";
import { COPILOT_ASSIGNEE_LOGIN } from "./types.js";
import {
  admissionCapacityLimits,
  planAdmissions,
  type AdmissionProposal,
  type AdmissionWorkItem,
} from "./scheduling/admission.js";
import {
  CapacityLedger,
  capacityReservationKey,
  deriveCapacityReservations,
  isIntegrationValidationBackend,
  isLocalIntegrationValidationBackend,
  unreconciledCapacityReservations,
  type CapacityReservation,
} from "./scheduling/capacity-ledger.js";
import { rankReadyWorkItems } from "./scheduling/priority.js";
import { validatePriorityFieldDefinition } from "./scheduling/github-priority.js";
import { ContinuousExecutionPool } from "./scheduling/continuous-refill.js";
import { ObjectiveFairness } from "./scheduling/fairness.js";
import {
  CachedResourceSampler,
  LinuxResourceSampler,
  resourcePressureReasons,
  type ResourceSampler,
  type ResourceSnapshot,
} from "./scheduling/resource-sampler.js";
import {
  discardValidationResult,
  validateArtifactClean,
  type CleanValidationResult,
  type CleanValidationInput,
} from "./validation/clean-run.js";
import { bindValidationToPublishedHead, validationPlanFromPacket } from "./validation/plan.js";
import { discoverLocalScopeHost } from "./runtime/local-scope.js";
import { LocalScopeBatchSchema, type LocalScopeBatch } from "./protocol/local-scope.js";
import type { ValidationEvidence } from "./validation/evidence.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  MutationScheduler,
  PlatformUnavailableError,
} from "./platform.js";

class RunCancellationRequestedError extends Error {
  constructor(message = "Factory run cancellation requested") {
    super(message);
    this.name = "RunCancellationRequestedError";
  }
}

export interface SupervisorOptions {
  token: string;
  owner: string;
  repo: string;
  objective: number;
  repository: string;
  policy: unknown;
  pollIntervalMs?: number;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
  managementBackend?: ManagementBackend;
  backendRegistry?: BackendRegistry;
  /** RepositoryController supplies one instance to every Objective. */
  repositoryResources?: RepositorySupervisorResources;
  /** Outer repository-controller fence, checked before every GitHub mutation. */
  repositoryFence?: () => Promise<void>;
  /** A service stop releases ownership without durably cancelling the run. */
  shutdownBehavior?: "cancel-run" | "release-lease";
  /** Durable controller activation fence. Foreground runs omit this. */
  activation?: { requestId: string; baseSha: string };
  /** Exact acknowledged successor; selects complete authenticated recovery history reads. */
  recovery?: { requestId: string; planDigest: string; successorRunId: string };
  /** Current fenced repository-controller identity, sampled for durable status. */
  controllerObservation?: () => ControllerObservation;
}

export interface ControllerObservation {
  controllerId: string;
  epoch: number;
  expiresAt: string;
  controllerPolicyDigest: string;
}

export interface RepositorySupervisorResources {
  pacer: ContentCreationPacer;
  circuitBreaker: CircuitBreaker;
  concurrency: ConcurrencyLimiter;
  mutationScheduler: MutationScheduler;
  integration: <T>(operation: () => Promise<T>) => Promise<T>;
  capacityLedger: CapacityLedger;
  resourceSampler: ResourceSampler;
  fairness: ObjectiveFairness;
  controllerLimits: { maxLocalWorkers: number; maxPaidWorkers: number };
}

export function createRepositorySupervisorResources(
  onThrottle: (message: string) => void = () => {},
  controllerLimits: {
    maxLocalWorkers: number;
    maxPaidWorkers: number;
  } = { maxLocalWorkers: 8, maxPaidWorkers: 0 },
): RepositorySupervisorResources {
  const pacer = new ContentCreationPacer();
  let integrationTail = Promise.resolve();
  return {
    pacer,
    circuitBreaker: new CircuitBreaker(),
    concurrency: new ConcurrencyLimiter(),
    mutationScheduler: new MutationScheduler({ pacer, onThrottle }),
    capacityLedger: new CapacityLedger(),
    resourceSampler: new LinuxResourceSampler(),
    fairness: new ObjectiveFairness(),
    controllerLimits,
    integration: async <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = integrationTail;
      let release!: () => void;
      integrationTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}

export interface SupervisorResult {
  status: "completed" | "cancelled" | "drained" | "escalated";
  objective: number;
  runId: string;
  reason?: string;
}

interface DeliveryExecutionBase {
  branch: string;
  sha: string;
}

interface NativeStackMember {
  receipt: PublicationReceipt;
  pull: PublishedPullRequest;
  reservation: AttemptReservation;
  observedHeadSha: string;
}

/**
 * Correlate a provider-created pull request after restart using only durable
 * attempt timing, an optional exact published head, and GitHub's authoritative
 * coding-agent lifecycle event. Ambiguity is never resolved heuristically.
 */
export function selectManagedRecoveryPull(
  pulls: readonly DerivedWorkItem["linkedPullRequests"][number][],
  attemptStartedAt: string | undefined,
  expectedHeadSha?: string,
): DerivedWorkItem["linkedPullRequests"][number] | null {
  if (!attemptStartedAt) return null;
  const cutoff = new Date(attemptStartedAt).getTime() - 2 * 60_000;
  if (!Number.isFinite(cutoff)) throw new Error("managed attempt start time is invalid");
  const attributable = pulls.filter(
    (pull) =>
      pull.createdAt.getTime() >= cutoff &&
      pull.agentWorkEvents.some((event) => event.at.getTime() >= cutoff) &&
      (!expectedHeadSha || pull.headSha === expectedHeadSha),
  );
  if (attributable.length > 1) {
    throw new Error(
      `managed attempt recovery is ambiguous: ${attributable.length} pull requests match`,
    );
  }
  return attributable[0] ?? null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveSleep();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Factory run cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Missing provider counters remain unavailable rather than becoming free usage. */
export function reportedModelTokens(usage?: ExecutionUsage): number | null {
  if (usage?.inputTokens === null || usage?.inputTokens === undefined) return null;
  if (usage.outputTokens === null || usage.outputTokens === undefined) return null;
  return usage.inputTokens + usage.outputTokens;
}

export function assertManagementInvocationNotFailed(
  events: readonly FactoryEvent[],
  runId: string,
  invocationId: string,
): void {
  if (
    events.some(
      (event) =>
        event.kind === "budget" &&
        event.runId === runId &&
        event.event === "BudgetReconciled" &&
        event.phase === "management" &&
        event.unit === "model_tokens" &&
        event.usageId === `failed-${invocationId}`,
    )
  )
    throw new Error("management invocation already failed with recorded usage; refusing replay");
}

export type CompilationFaultPoint =
  | "after-model-return"
  | "after-graph-persistence"
  | "after-usage-write"
  | "after-preflight";

/**
 * A paid compiler may return to the Supervisor only through a callback that
 * has atomically checkpointed graph and usage evidence. Every later step is
 * replayable from that checkpoint, so retries never invoke the model again.
 */
export async function runDurableCompilationTransaction(args: {
  existing: CompiledGraphRecord | null;
  invoke?: (checkpoint: CompilationCheckpoint) => Promise<CompilationResult>;
  persist: (result: CompilationResult) => Promise<CompiledGraphRecord>;
  recover: () => Promise<CompiledGraphRecord | null>;
  recordUsage: (record: CompiledGraphRecord) => Promise<void>;
  recordFailureUsage?: (usage: ManagementUsage) => Promise<void>;
  preflight: (objective: CompiledObjective) => Promise<void>;
  fault?: (point: CompilationFaultPoint) => Promise<void> | void;
}): Promise<CompiledGraphRecord> {
  let record = args.existing;
  if (!record) {
    if (!args.invoke) throw new Error("no durable graph or compiler invocation is available");
    try {
      await args.invoke(async (result) => {
        record = await args.persist(result);
      });
      if (!record) {
        throw new Error(
          "management backend returned without durably checkpointing its compilation",
        );
      }
    } catch (error) {
      record = await args.recover();
      if (!record) {
        if (error instanceof ManagementOutputError) await args.recordFailureUsage?.(error.usage);
        throw error;
      }
    }
    await args.fault?.("after-model-return");
  }
  await args.fault?.("after-graph-persistence");
  await args.recordUsage(record);
  await args.fault?.("after-usage-write");
  await args.preflight(record.objective);
  await args.fault?.("after-preflight");
  return record;
}

type Snapshot = Awaited<ReturnType<GitHubReader["readObjective"]>>;
type GraphQlRateLimit = NonNullable<Snapshot["graphQlRateLimit"]>;

/**
 * Keep enough GraphQL capacity to fence a full wave even when every worker
 * runs to its timeout. Factory comments use REST; this reserve covers graph
 * snapshots, lease CAS renewals, publication/recovery mutations, and margin.
 */
export function graphQlAdmissionReserve(
  queryCost: number,
  workItemTimeoutMinutes: number,
  waveSize: number,
  additionalMutations = 0,
): number {
  if (!Number.isInteger(queryCost) || queryCost < 1) {
    throw new Error("GraphQL query cost must be a positive integer");
  }
  if (!Number.isInteger(workItemTimeoutMinutes) || workItemTimeoutMinutes < 1) {
    throw new Error("Work Item timeout must be a positive integer");
  }
  if (!Number.isInteger(waveSize) || waveSize < 1) {
    throw new Error("wave size must be a positive integer");
  }
  if (!Number.isInteger(additionalMutations) || additionalMutations < 0) {
    throw new Error("additional GraphQL mutations must be a non-negative integer");
  }
  const snapshotReserve = queryCost * 3;
  const leaseRenewals = Math.ceil(
    (workItemTimeoutMinutes * 60_000) / DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
  );
  const perWorkItemControl = 12 * waveSize;
  return Math.max(
    100,
    snapshotReserve + leaseRenewals + perWorkItemControl + additionalMutations + 10,
  );
}

export function pendingGraphQlGraphMutations(
  objective: CompiledObjective,
  existing: ExistingGraphWorkItem[],
): number {
  const existingById = new Map(existing.map((item) => [item.compilerId, item]));
  const missingIssues = objective.workItems.filter((item) => !existingById.has(item.id)).length;
  const missingDependencies = objective.workItems.reduce((count, item) => {
    const observedItem = existingById.get(item.id);
    return (
      count +
      item.dependsOn.filter((dependencyId) => {
        const observedDependency = existingById.get(dependencyId);
        return (
          !observedItem ||
          !observedDependency ||
          !observedItem.blockedByNumbers.includes(observedDependency.number)
        );
      }).length
    );
  }, 0);
  return missingIssues + missingDependencies;
}

export function assertGraphQlAdmissionHeadroom(
  rateLimit: GraphQlRateLimit | undefined,
  policy: RunPolicy,
  waveSize: number,
  notify: (message: string) => void = () => {},
  additionalMutations = 0,
): void {
  if (!rateLimit) return;
  const required = graphQlAdmissionReserve(
    rateLimit.cost,
    policy.workItemTimeoutMinutes,
    waveSize,
    additionalMutations,
  );
  if (rateLimit.remaining >= required) return;
  const retryAfterMs = Math.max(1_000, rateLimit.resetAt.getTime() - Date.now() + 1_000);
  const reason =
    `GitHub GraphQL admission paused: ${rateLimit.remaining} points remain; ` +
    `${required} are reserved for a ${waveSize}-worker wave; quota resets at ` +
    rateLimit.resetAt.toISOString();
  notify(reason);
  throw new PlatformUnavailableError({ kind: "rate_limit", retryAfterMs }, new Error(reason));
}

function snapshotEvents(snapshot: Snapshot): FactoryEvent[] {
  return deduplicateFactoryEvents([
    ...(snapshot.factoryEvents ?? []),
    ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
  ]);
}

function hasCancellationRequest(snapshot: Snapshot, runId: string): boolean {
  const events = deduplicateFactoryEvents(snapshot.factoryEvents ?? []);
  const start = events.find(
    (event) => event.kind === "run" && event.event === "FactoryRunStarted" && event.runId === runId,
  );
  if (
    start?.kind === "run" &&
    start.event === "FactoryRunStarted" &&
    start.activationRequestId &&
    start.baseSha &&
    activationCancellation(events, {
      objective: start.objective,
      requestId: start.activationRequestId,
      requestedBy: start.actor,
      repository: start.repository,
      baseSha: start.baseSha,
      policyDigest: start.policyDigest,
    })
  )
    return true;
  return events.some(
    (event) =>
      event.kind === "run" &&
      event.event === "FactoryRunCancellationRequested" &&
      event.runId === runId,
  );
}

export function retryCommandAllows(
  item: DerivedWorkItem,
  commands: DurableCommandState,
  run: RunState,
  maxAttempts: number,
): boolean {
  const retry = commands.retries.get(item.number);
  if (!retry || !new Set(["failed", "escalated"]).has(item.state)) return false;
  if (item.closed || item.attempts >= maxAttempts) return false;
  if (item.blockedBy.some((dependency) => !dependency.closed)) return false;
  if (item.linkedPullRequests.some((pull) => pull.state === "OPEN")) return false;
  if (item.assignees.includes(COPILOT_ASSIGNEE_LOGIN)) return false;
  const humanAssignees = item.assignees.filter((login) => login !== COPILOT_ASSIGNEE_LOGIN);
  return humanAssignees.every((login) => login.toLowerCase() === run.actor.toLowerCase());
}

export function applyCloudPause(
  candidates: readonly BackendCandidate[],
  paused: boolean,
): BackendCandidate[] {
  if (!paused) return [...candidates];
  return candidates.map((candidate) =>
    candidate.paid
      ? {
          ...candidate,
          transientReasons: [
            ...candidate.transientReasons,
            "paid admission is paused by the active run actor",
          ],
        }
      : candidate,
  );
}

class SequenceAllocator {
  #next: number;

  constructor(events: FactoryEvent[], minimum = 1, lease?: LeaseState) {
    this.#next = Math.max(nextEventSequence(events), minimum, (lease?.sequence ?? 0) + 1);
  }

  take(): number {
    const value = this.#next;
    this.#next += 1;
    return value;
  }

  observe(events: FactoryEvent[]): void {
    this.#next = Math.max(this.#next, nextEventSequence(events));
  }
}

export class LeaseController {
  #renewalTail: Promise<void> = Promise.resolve();
  #fatal: unknown;

  constructor(
    private readonly manager: LeaseManager,
    private lease: LeaseState,
    private readonly sequences: { take(): number },
  ) {}

  async use<T>(operation: (lease: LeaseState) => Promise<T>): Promise<T> {
    if (this.#fatal) throw this.#fatal;
    const current = this.lease;
    return operation(current);
  }

  async #mutateLease<T>(operation: (lease: LeaseState) => Promise<T>): Promise<T> {
    if (this.#fatal) throw this.#fatal;
    let release!: () => void;
    const previous = this.#renewalTail;
    this.#renewalTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      if (this.#fatal) throw this.#fatal;
      return await operation(this.lease);
    } finally {
      release();
    }
  }

  assert = async (): Promise<void> => {
    await this.use((lease) => this.manager.assertCurrent(lease));
  };

  /** Re-read the GitHub lease at a named externally-visible boundary. */
  async assertGeneration(boundary: "admission" | "publication" | "integration"): Promise<void> {
    await this.use((lease) => this.manager.assertGeneration(lease, boundary));
  }

  /** Fence every externally visible mutation using a current ref observation. */
  async guardMutation(waitedMs: number): Promise<void> {
    if (this.#fatal) throw this.#fatal;
    void waitedMs;
    await this.manager.assertCurrent(this.lease);
  }

  async renewIfNeeded(force = false): Promise<void> {
    await this.#mutateLease(async (lease) => {
      if (!force && lease.expiresAt.getTime() - Date.now() > DEFAULT_LEASE_RENEWAL_LEAD_MS) return;
      this.lease = await this.manager.renew(lease, this.sequences.take());
    });
  }

  async release(): Promise<void> {
    await this.#mutateLease(async (lease) => {
      this.lease = await this.manager.release(lease, this.sequences.take());
    });
  }

  fail(error: unknown): void {
    this.#fatal = error;
  }
}

/** Fence a new provider call without blocking cleanup after ownership loss. */
export async function runWithExternalAdmissionBoundary<T>(
  repositoryFence: () => Promise<void>,
  objectiveFence: () => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  await repositoryFence();
  await objectiveFence();
  return operation();
}

async function hostGit(
  repository: string,
  args: string[],
  maxOutputBytes = 256 * 1024,
  preserveOutput = false,
): Promise<string> {
  const result = await runContainedProcess({
    command: "git",
    args,
    cwd: repository,
    env: process.env,
    timeoutMs: 120_000,
    maxOutputBytes,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return preserveOutput ? result.stdout : result.stdout.trim();
}

async function ensureLocalCommit(repository: string, sha: string): Promise<void> {
  const present = await hostGit(repository, ["cat-file", "-e", `${sha}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!present) await hostGit(repository, ["fetch", "--no-tags", "origin", sha]);
  const local = await hostGit(repository, ["rev-parse", `${sha}^{commit}`]);
  if (local !== sha) throw new Error(`local repository did not resolve exact commit ${sha}`);
}

export async function verifyLocalRepository(
  repository: string,
  owner: string,
  repo: string,
): Promise<void> {
  const root = await hostGit(repository, ["rev-parse", "--show-toplevel"]);
  if (resolve(root) !== resolve(repository)) {
    throw new Error(`repository path must be its Git root (${root})`);
  }
  const remote = await hostGit(repository, ["remote", "get-url", "origin"]);
  const normalized = remote.replace(/\.git$/, "");
  const expectedPath = `${owner}/${repo}`.toLowerCase();
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(normalized);
  const scp = /^git@github\.com:([^/]+\/[^/]+)$/i.exec(normalized);
  const ssh = /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i.exec(normalized);
  const actualPath = https?.[1] ?? scp?.[1] ?? ssh?.[1];
  if (actualPath?.toLowerCase() !== expectedPath) {
    throw new Error(`origin ${remote} does not match ${owner}/${repo}`);
  }
}

function retryContext(item: DerivedWorkItem, runId: string) {
  const failed = (item.factoryEvents ?? [])
    .filter(
      (event) =>
        event.kind === "attempt" &&
        event.runId === runId &&
        ["AttemptFailed", "AttemptTimedOut"].includes(event.event) &&
        Boolean(event.reason),
    )
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (!failed || failed.kind !== "attempt" || !failed.reason) return undefined;
  return {
    attempt: failed.attempt,
    outcome: failed.event === "AttemptTimedOut" ? ("timed_out" as const) : ("failed" as const),
    reason: failed.reason.slice(0, 2_000),
  };
}

function assertGraphWithinRunPolicy(graph: CompiledObjective, policy: RunPolicy): void {
  for (const item of graph.workItems) {
    if (!item.requirements) {
      throw new Error(`Work Item ${item.id} has no v2 execution requirements`);
    }
    assertRequirementsWithinPolicy(item.requirements, policy, `Work Item ${item.id}`);
  }
}

function inspectCompiledGraph(snapshot: Snapshot): {
  hasReceipt: boolean;
  receiptRunId?: string;
  expectedDigest?: string;
  expectedSize?: number;
  expectedRef?: string;
  expectedBlobSha?: string;
  completeObjective?: CompiledObjective;
  existing: ExistingGraphWorkItem[];
} {
  const receipt = deduplicateFactoryEvents(snapshot.factoryEvents ?? [])
    .filter((event) => event.kind === "graph" && event.event === "GraphCompiled")
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (snapshot.workItems.length === 0) {
    return {
      hasReceipt: Boolean(receipt),
      ...(receipt?.kind === "graph"
        ? {
            expectedDigest: receipt.graphDigest,
            expectedSize: receipt.graphSize,
            expectedRef: receipt.graphRef,
            expectedBlobSha: receipt.graphBlobSha,
            receiptRunId: receipt.runId,
          }
        : {}),
      existing: [],
    };
  }
  if (!receipt || receipt.kind !== "graph") {
    throw new Error("Objective has Work Items but no authenticated v2 graph receipt");
  }
  const parsed = snapshot.workItems.map((item) => {
    let metadata;
    try {
      metadata = parseGraphItemMetadata(item.body ?? "");
    } catch (error) {
      throw new Error(
        `Work Item #${item.number} is not part of a recoverable v2 compiled graph: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { item, metadata };
  });
  parsed.sort((a, b) => a.metadata.index - b.metadata.index);
  const digests = new Set(parsed.map(({ metadata }) => metadata.graphDigest));
  const sizes = new Set(parsed.map(({ metadata }) => metadata.graphSize));
  const ids = new Set(parsed.map(({ metadata }) => metadata.id));
  const indexes = new Set(parsed.map(({ metadata }) => metadata.index));
  if (
    digests.size !== 1 ||
    sizes.size !== 1 ||
    ids.size !== parsed.length ||
    indexes.size !== parsed.length
  ) {
    throw new Error("Objective contains mixed or duplicate compiled-graph receipts");
  }
  const expectedDigest = parsed[0]!.metadata.graphDigest;
  const expectedSize = parsed[0]!.metadata.graphSize;
  if (expectedDigest !== receipt.graphDigest || expectedSize !== receipt.graphSize) {
    throw new Error("Work Item graph metadata does not match the authenticated Objective receipt");
  }
  if (parsed.length > expectedSize) {
    throw new Error("Objective contains more Work Items than its compiled graph declares");
  }
  if (parsed.some(({ metadata }) => metadata.index >= expectedSize)) {
    throw new Error("Objective contains an out-of-range compiled Work Item index");
  }
  const existing = parsed.map(({ item, metadata }) => ({
    compilerId: metadata.id,
    graphDigest: metadata.graphDigest,
    graphSize: metadata.graphSize,
    index: metadata.index,
    dependsOn: metadata.dependsOn,
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body ?? "",
    blockedByNumbers: item.blockedBy.map((dependency) => dependency.number),
  }));
  if (parsed.length !== expectedSize) {
    return {
      hasReceipt: true,
      expectedDigest,
      expectedSize,
      expectedRef: receipt.graphRef,
      expectedBlobSha: receipt.graphBlobSha,
      receiptRunId: receipt.runId,
      existing,
    };
  }
  const completeObjective: CompiledObjective = {
    title: snapshot.title,
    workItems: parsed.map(({ item, metadata }) => {
      const packet = parseWorkerPacketFromIssue(item.body ?? "");
      return {
        id: metadata.id,
        title: item.title,
        goal: packet.goal,
        acceptance: packet.acceptanceCriteria,
        scope: packet.allowedPaths,
        preconditions: packet.preconditions,
        outOfScope: packet.outOfScope,
        conventions: packet.conventions,
        dependsOn: metadata.dependsOn,
        baseSha: packet.baseSha,
        validationCommands: packet.validationCommands,
        requirements: packet.requirements,
        artifactContract: packet.artifactContract,
      };
    }),
  };
  const reconstructable = compiledGraphDigest(completeObjective) === expectedDigest;
  return {
    hasReceipt: true,
    expectedDigest,
    expectedSize,
    expectedRef: receipt.graphRef,
    expectedBlobSha: receipt.graphBlobSha,
    receiptRunId: receipt.runId,
    ...(reconstructable ? { completeObjective } : {}),
    existing,
  };
}

const MAX_RETRY_CHECKPOINT_CACHE_BYTES = 32 * 1024 * 1024;

class RetryArtifactCache {
  readonly #entries = new Map<number, NormalizedArtifact>();
  #bytes = 0;

  get(workItem: number, baseSha: string): NormalizedArtifact | undefined {
    const artifact = this.#entries.get(workItem);
    if (!artifact) return undefined;
    if (artifact.baseSha !== baseSha) {
      this.delete(workItem);
      return undefined;
    }
    this.#entries.delete(workItem);
    this.#entries.set(workItem, artifact);
    return artifact;
  }

  set(workItem: number, artifact: NormalizedArtifact): void {
    this.delete(workItem);
    const bytes = Buffer.byteLength(artifact.patch) + Buffer.byteLength(artifact.logs);
    if (bytes > MAX_RETRY_CHECKPOINT_CACHE_BYTES) return;
    while (this.#bytes + bytes > MAX_RETRY_CHECKPOINT_CACHE_BYTES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.#entries.set(workItem, artifact);
    this.#bytes += bytes;
  }

  delete(workItem: number): void {
    const artifact = this.#entries.get(workItem);
    if (!artifact) return;
    this.#bytes -= Buffer.byteLength(artifact.patch) + Buffer.byteLength(artifact.logs);
    this.#entries.delete(workItem);
  }
}

export class FactorySupervisor {
  readonly #options: SupervisorOptions;
  #policy: RunPolicy;
  readonly #notify: (message: string) => void;
  readonly #reader: GitHubReader;
  readonly #store: GitHubControlStore;
  readonly #recoveryStore: ReturnType<typeof recoveryReadPort>;
  readonly #stacks: GitHubStacks;
  readonly #leases: LeaseManager;
  readonly #attempts: AttemptManager;
  readonly #reviews: ReviewCheckpointManager;
  readonly #mergeCandidates: MergeCandidateCheckpointStore;
  readonly #nativeRebases: NativeRebaseCheckpointStore;
  readonly #recorder: LifecycleRecorder;
  #management: ManagementBackend;
  readonly #managementOverride: boolean;
  readonly #registry: BackendRegistry;
  readonly #pacer: ContentCreationPacer;
  readonly #breaker: CircuitBreaker;
  readonly #concurrency: ConcurrencyLimiter;
  readonly #mutations: MutationScheduler;
  readonly #capacity: CapacityLedger;
  readonly #resourceSampler: CachedResourceSampler;
  readonly #fairness: ObjectiveFairness;
  readonly #controllerLimits: {
    maxLocalWorkers: number;
    maxPaidWorkers: number;
  };
  #sequences!: SequenceAllocator;
  #lease!: LeaseController;
  #run!: RunState;
  #runStartSequence = 0;
  #lastControllerObservationKey: string | undefined;
  #baseBranch = "main";
  #priorityFallbackReason: string | undefined;
  #ciExpectedOnPullRequests: boolean | "unknown" = "unknown";
  #deliverySelection!: DeliverySelection;
  #deliveryPlan?: Extract<DeliveryPlan, { result: "supported" }>;
  #budgetEvents: FactoryEvent[] = [];
  #integrationTail: Promise<void> = Promise.resolve();
  // Scheduling hints only: never reuse authority or mutable GitHub evidence.
  // Lost on restart; every due observation repeats the normal integration fences.
  #integrationWaits = new Map<number, { until: number; delay: number; reason: string }>();
  readonly #retryArtifacts = new RetryArtifactCache();
  #durablePackets = new Map<number, WorkerPacket>();
  #compiledGraph: CompiledObjective | null = null;
  #recoveryRuntime: RecoveryRuntime | null = null;
  #compiledProjection: CompiledGraphProjectionRecord | null = null;
  #localScopeHost: ReturnType<typeof discoverLocalScopeHost> | undefined;

  constructor(options: SupervisorOptions) {
    this.#options = { ...options, repository: resolve(options.repository) };
    this.#policy = parseRunPolicy(options.policy);
    this.#notify = options.onStatus ?? (() => {});
    const shared = options.repositoryResources;
    this.#pacer = shared?.pacer ?? new ContentCreationPacer();
    this.#breaker = shared?.circuitBreaker ?? new CircuitBreaker();
    this.#concurrency = shared?.concurrency ?? new ConcurrencyLimiter();
    this.#mutations =
      shared?.mutationScheduler ??
      new MutationScheduler({
        pacer: this.#pacer,
        onThrottle: this.#notify,
      });
    const scheduling = normalizeSchedulingPolicy(this.#policy);
    this.#capacity = shared?.capacityLedger ?? new CapacityLedger();
    this.#resourceSampler = new CachedResourceSampler(
      shared?.resourceSampler ?? new LinuxResourceSampler(),
      scheduling.capacity.local.sampleIntervalSeconds * 1_000,
      scheduling.capacity.local.admissionCooldownSeconds * 1_000,
    );
    this.#fairness = shared?.fairness ?? new ObjectiveFairness();
    this.#controllerLimits = shared?.controllerLimits ?? {
      maxLocalWorkers: scheduling.capacity.local.maxWorkers,
      maxPaidWorkers:
        this.#policy.allowedPaidBackends.length === 0 ? 0 : scheduling.burst.maxCloudParallel,
    };
    const github: GitHubOptions = {
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      onThrottle: this.#notify,
    };
    const controls = {
      ...github,
      circuitBreaker: this.#breaker,
      pacer: this.#pacer,
      concurrency: this.#concurrency,
      mutationScheduler: this.#mutations,
      beforeMutation: async (kind: "normal" | "lease", waitedMs: number) => {
        await this.#options.repositoryFence?.();
        if (kind === "normal" && this.#lease) {
          await this.#lease.guardMutation(waitedMs);
        }
      },
    };
    this.#reader = new GitHubReader({
      ...github,
      ...(options.recovery ? { recoveryInspection: true } : {}),
    });
    this.#store = new GitHubControlStore(controls);
    this.#recoveryStore = recoveryReadPort(this.#store, options.owner, options.repo);
    this.#stacks = new GitHubStacks(
      {
        request: (route, parameters, mutating) =>
          this.#store.stackRequest(route, parameters, mutating),
      },
      options.owner,
      options.repo,
    );
    this.#leases = new LeaseManager({ store: this.#store });
    this.#attempts = new AttemptManager({
      store: this.#store,
      leases: this.#leases,
    });
    this.#reviews = new ReviewCheckpointManager(this.#store, this.#leases);
    this.#mergeCandidates = new MergeCandidateCheckpointStore(this.#store, this.#leases);
    this.#nativeRebases = new NativeRebaseCheckpointStore(this.#store, this.#leases);
    this.#recorder = new LifecycleRecorder(this.#store, this.#leases);
    this.#management =
      options.managementBackend ??
      new CodexCliManagementBackend({
        ...(this.#policy.modelProfile ? { profile: this.#policy.modelProfile } : {}),
      });
    this.#managementOverride = options.managementBackend !== undefined;
    this.#registry = options.backendRegistry ?? new BackendRegistry();
    if (!options.backendRegistry) {
      if (this.#policy.backendOrder.includes("codex-sdk/local-worktree")) {
        this.#registry.register(new CodexSdkLocalBackend());
      }
      if (this.#policy.backendOrder.includes("codex-app-server/local-worktree")) {
        this.#registry.register(
          new CodexAppServerLocalBackend({
            ...(this.#policy.modelProfile ? { profile: this.#policy.modelProfile } : {}),
          }),
        );
      }
      this.#registry.register(
        new CodexCliLocalBackend({
          ...(this.#policy.modelProfile ? { profile: this.#policy.modelProfile } : {}),
        }),
      );
      if (this.#policy.backendOrder.includes("codex-cli/daytona")) {
        this.#registry.register(new DaytonaBackend({ repository: this.#options.repository }));
      }
      if (this.#policy.backendOrder.includes("codex-cli/vercel-sandbox")) {
        this.#registry.register(new VercelSandboxBackend({ repository: this.#options.repository }));
      }
    }
  }

  async #guardMutation(waitedMs: number): Promise<void> {
    await this.#options.repositoryFence?.();
    await this.#lease.guardMutation(waitedMs);
  }

  async #externalAdmission<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#recoveryRuntime) {
      await this.#resumeObservedRun(
        await this.#reader.readObjective(this.#run.objective),
        new RunManager(this.#store),
      );
      const resources = await verifyRecoveryResources({
        planRecord: this.#recoveryRuntime.planRecord,
        events: this.#recoveryRuntime.events,
        store: this.#store,
      });
      if (resources.status !== "verified")
        throw new Error(`successor resources unavailable: ${resources.blockers.join(", ")}`);
      if (this.#recoveryRuntime.currentUnknownModelUsageCount > 0)
        throw new Error("successor model usage is unknown; refusing another invocation");
      this.#budgetEvents = this.#accountingEvents([...this.#recoveryRuntime.events]);
    }
    return runWithExternalAdmissionBoundary(
      this.#options.repositoryFence ?? (async () => {}),
      () => this.#lease.assertGeneration("admission"),
      async () => {
        const binding = this.#activationBinding();
        if (binding) {
          const cancellation = await this.#reader.readRunCancellationRequest(
            this.#run.objective,
            this.#run.runId,
            this.#run.actor,
            binding,
          );
          if (cancellation) {
            this.#sequences.observe([cancellation]);
            throw new RunCancellationRequestedError(
              "operator withdrew the activation through GitHub",
            );
          }
          // The receipt read can span either authority change. Admission still
          // belongs to both current generations, never the pre-read observation.
          await this.#options.repositoryFence?.();
          await this.#lease.assertGeneration("admission");
        }
        return operation();
      },
    );
  }

  #activationBinding(): ActivationBinding | undefined {
    if (!this.#run.activationRequestId) return undefined;
    if (!this.#run.baseSha || !this.#run.repository)
      throw new Error("activation-bound run is missing its immutable base or repository");
    return {
      objective: this.#run.objective,
      requestId: this.#run.activationRequestId,
      requestedBy: this.#run.actor,
      repository: this.#run.repository,
      baseSha: this.#run.baseSha,
      policyDigest: this.#run.policyDigest,
    };
  }

  #withdrawnActivation(snapshot: Snapshot, actor: string, repository: string): boolean {
    const activation = this.#options.activation;
    if (
      (snapshot.factoryEvents ?? []).some(
        (event) =>
          event.kind === "run" &&
          event.event === "FactoryRunStarted" &&
          event.activationRequestId === activation?.requestId,
      )
    )
      return false;
    return Boolean(
      activation &&
        activationCancellation(snapshot.factoryEvents ?? [], {
          objective: snapshot.number,
          requestId: activation.requestId,
          requestedBy: actor,
          repository,
          baseSha: activation.baseSha,
          policyDigest: policyDigest(this.#policy),
        }),
    );
  }

  #accountingEvents(events: FactoryEvent[], currentRunId = this.#run.runId): FactoryEvent[] {
    const runs = new Set(this.#recoveryRuntime?.accountingRunIds ?? [currentRunId]);
    return events.filter((event) => runs.has(event.runId));
  }

  async #resumeObservedRun(
    snapshot: Snapshot,
    manager: RunManager,
    reconciliationMode: "none" | "inspect" | "repair" = "none",
  ): Promise<RunState | null> {
    const active = latestSupportedRun(snapshot.factoryEvents ?? []);
    const recovery = this.#options.recovery;
    if (recovery && (active?.event !== "FactoryRunStarted" || !active.recoveryRequestId)) {
      if (
        !this.#recoveryRuntime &&
        !active &&
        snapshot.closed &&
        snapshot.factoryEvents?.some(
          (event) =>
            event.event === "FactoryRunCompleted" && event.runId === recovery.successorRunId,
        ) &&
        snapshot.factoryEvents
          .filter((event) => event.event === "FactoryRunStarted")
          .sort((a, b) => a.sequence - b.sequence)
          .at(-1)?.runId === recovery.successorRunId
      ) {
        const completed = await loadRecoveryRuntime({
          objective: snapshot.number,
          runId: recovery.successorRunId,
          store: this.#recoveryStore,
          readSnapshot: async () => ({ snapshot, historyComplete: true }),
        });
        if (
          completed.status !== "verified" ||
          completed.planRecord.digest !== recovery.planDigest ||
          completed.planRecord.plan.requestId !== recovery.requestId
        )
          throw new Error("completed successor authority is unavailable");
        return null;
      }
      throw new Error("recovery request does not name the current active successor");
    }
    if (
      this.#recoveryRuntime &&
      (active?.event !== "FactoryRunStarted" ||
        active.runId !== this.#recoveryRuntime.controllingRun.runId)
    )
      throw new Error("successor is no longer the current non-terminal run");
    if (active?.event !== "FactoryRunStarted" || !active.recoveryRequestId)
      return manager.resume(snapshot.factoryEvents ?? []);
    if (
      !recovery ||
      active.recoveryRequestId !== recovery.requestId ||
      active.recoveryPlanDigest !== recovery.planDigest ||
      active.runId !== recovery.successorRunId
    )
      throw new Error(
        "successor resume requires its exact acknowledged recovery request, plan, and run",
      );
    const input = {
      objective: snapshot.number,
      runId: active.runId,
      store: this.#recoveryStore,
      readSnapshot: async () => ({ snapshot, historyComplete: true }),
    };
    let recovered: Awaited<ReturnType<RunManager["resumeRecovery"]>>;
    try {
      recovered = await manager.resumeRecovery(input);
    } catch (error) {
      // Ordinary execution/admission never uses this startup-only repair path.
      if (reconciliationMode === "none" || this.#recoveryRuntime) throw error;
      const inspection = await manager.inspectRecoveryReconciliation({
        ...input,
        planDigest: recovery.planDigest,
        requestId: recovery.requestId,
      });
      if (reconciliationMode === "inspect") return inspection.run;
      recovered = await this.#reconcileRecoverySourceMerges(snapshot.number, manager);
    }
    if (this.#recoveryRuntime && this.#recoveryRuntime.controllingRun.runId !== recovered.run.runId)
      throw new Error("successor runtime changed during execution");
    this.#recoveryRuntime = recovered.runtime;
    return recovered.run;
  }

  /** Append only proved, already-completed merges under both configured fences.
   * No worker, review, PR mutation or issue closure is permitted in this stage. */
  async #reconcileRecoverySourceMerges(objective: number, manager: RunManager) {
    const recovery = this.#options.recovery;
    if (!recovery) throw new Error("source reconciliation requires its acknowledged recovery");
    for (let repaired = 0; repaired <= 100; repaired++) {
      await this.#guardMutation(0);
      const snapshot = await this.#reader.readObjective(objective);
      const input = {
        objective,
        runId: recovery.successorRunId,
        store: this.#recoveryStore,
        readSnapshot: async () => ({ snapshot, historyComplete: true }),
      };
      this.#sequences.observe(snapshotEvents(snapshot));
      try {
        // Full runtime verification, with every real receipt, is the only exit.
        const recovered = await manager.resumeRecovery(input);
        if (
          recovered.runtime.planRecord.digest !== recovery.planDigest ||
          recovered.runtime.planRecord.plan.requestId !== recovery.requestId
        )
          throw new Error("source reconciliation authority changed during startup");
        return recovered;
      } catch (error) {
        if (repaired === 100) throw error;
      }
      const { reconciliation } = await manager.inspectRecoveryReconciliation({
        ...input,
        planDigest: recovery.planDigest,
        requestId: recovery.requestId,
      });
      const source = reconciliation.mergedSources[0]!;
      const event = createRecoverySourceIntegratedEvent({
        planRecord: reconciliation.planRecord,
        claim: reconciliation.claim,
        ...source,
        sequence: this.#sequences.take(),
        at: (await this.#store.serverTime()).toISOString(),
      });
      await this.#guardMutation(0);
      try {
        await this.#lease.use(() =>
          this.#store.addIssueComment(
            source.issueNodeId,
            encodeEventComment("Factory reconciled a verified completed source merge.", event),
          ),
        );
      } catch (error) {
        // A lost write response is recovered only from the exact real receipt.
        const observed = await this.#reader.readObjective(objective);
        if (
          !snapshotEvents(observed).some(
            (value) => recoveryEventDigest(value) === recoveryEventDigest(event),
          )
        )
          throw error;
        this.#sequences.observe(snapshotEvents(observed));
      }
    }
    throw new Error("source reconciliation exceeded the compiled work-item bound");
  }

  #deriveObjective(snapshot: Snapshot): ReturnType<typeof derive> {
    const objective = derive(snapshot);
    if (!this.#recoveryRuntime) return objective;
    return {
      ...objective,
      items: objective.items.map((item) => {
        const planned = this.#recoveryRuntime!.planRecord.plan.items.find(
          (entry) => entry.workItem === item.number,
        );
        const count =
          this.#recoveryRuntime!.attemptCounts.find((entry) => entry.workItem === item.number)
            ?.count ?? 0;
        if (!planned?.source || planned.action === "execute") return { ...item, attempts: count };
        const integrated = this.#recoveryRuntime!.sourceIntegrations.some(
          (proof) => proof.outcome.workItem === item.number,
        );
        const parentId = this.#deliveryPlan?.items.find(
          (entry) => entry.itemId === planned.compilerId,
        )?.parentItemId;
        const parentNumber = this.#recoveryRuntime!.planRecord.plan.items.find(
          (entry) => entry.compilerId === parentId,
        )?.workItem;
        const nativeParentOnly =
          this.#deliverySelection?.selected === "native-stacks" &&
          parentNumber &&
          item.blockedBy.every((blocker) => blocker.closed || blocker.number === parentNumber) &&
          (planned.source.artifactHead ||
            planned.source.publication ||
            this.#recoveryRuntime!.sourcePublications.some(
              (proof) => proof.publication.workItem === item.number,
            ));
        return {
          ...item,
          attempts: count,
          state:
            integrated && item.closed
              ? ("done" as const)
              : planned.action !== "integrated" &&
                  item.blockedBy.some((blocker) => !blocker.closed) &&
                  !nativeParentOnly
                ? ("blocked" as const)
                : ("for_review" as const),
          doneWithoutMergedPullRequest: false,
        };
      }),
    };
  }

  async #prepareRecoveryGraph(snapshot: Snapshot): Promise<void> {
    const runtime = this.#recoveryRuntime!;
    const compiled = runtime.graph.objective;
    if (
      runtime.planRecord.plan.items.some(
        (item) =>
          item.action !== "execute" && !item.source?.publication && !item.source?.artifactHead,
      )
    )
      throw new Error(
        "successor artifact-only recovery requires an explicit artifact consumer; no replacement worker is authorized",
      );
    assertGraphWithinRunPolicy(compiled, this.#policy);
    if (this.#deliverySelection.selected === "native-stacks") {
      const planned = planDelivery(
        compiled.workItems.map((item) => {
          if (!item.delivery) throw new Error(`Work Item ${item.id} has no delivery hint`);
          return {
            id: item.id,
            dependsOn: item.dependsOn,
            delivery: {
              group: item.delivery.group,
              relationship: item.delivery.relationship,
              ...(item.delivery.parentWorkItem
                ? { parentWorkItem: item.delivery.parentWorkItem }
                : {}),
            },
          };
        }),
      );
      if (planned.result === "unsupported")
        throw new Error(`unsupported recovery delivery: ${planned.reason}`);
      this.#deliveryPlan = planned;
    }
    await this.#preflightCompiledGraph(compiled);
    this.#compiledGraph = compiled;
    this.#compiledProjection = runtime.projection;
    this.#fenceSnapshot(snapshot);
  }

  async #scopedValidation(
    reservation: Pick<
      AttemptReservation,
      "objective" | "runId" | "workItem" | "attempt" | "policyDigest"
    >,
    artifact: NormalizedArtifact,
    packet: WorkerPacket,
    deadline: Date,
  ): Promise<{
    batch: LocalScopeBatch;
    hooks: NonNullable<CleanValidationInput["localScope"]>;
  } | null> {
    if (validationPlanFromPacket(packet).isolation === "isolated") return null;
    const host = await (this.#localScopeHost ??= discoverLocalScopeHost());
    if (!host) return null;
    const batch = await this.#lease.use(async (lease) =>
      LocalScopeBatchSchema.parse({
        identity: {
          protocol: "clockgrove.factory/local-scope-v1",
          repository: `${this.#options.owner}/${this.#options.repo}`.toLowerCase(),
          objective: reservation.objective,
          runId: reservation.runId,
          workItem: reservation.workItem,
          attempt: reservation.attempt,
          directorEpoch: lease.epoch,
          policyDigest: reservation.policyDigest,
          phase: "validation",
          commandIndex: 0,
          invocationDigest: artifact.digest,
          hostIdentity: host.hostIdentity,
          ...(host.producerUnit
            ? { producerUnit: host.producerUnit, producerInvocationId: host.producerInvocationId }
            : {}),
        },
        // The optional npm setup consumes at most one additional index. Unused
        // scopes stay absent; each actual command is covered before the first launch.
        commandCount: validationPlanFromPacket(packet).commands.length + 1,
        producerPid: host.producerPid,
        producerStartTicks: host.producerStartTicks,
        deadline: deadline.toISOString(),
      }),
    );
    return {
      batch,
      hooks: {
        identity: batch.identity,
        deadline: batch.deadline,
        beforeLaunch: async (identity) => {
          if (identity.commandIndex >= batch.commandCount)
            throw new Error("local validation command exceeds reserved scope batch");
          await this.#externalAdmission(async () => {
            if (Date.now() >= deadline.getTime())
              throw new Error("local validation deadline expired");
          });
        },
        afterStop: async () => {},
      },
    };
  }

  async #recordControllerObservation(snapshot: Snapshot): Promise<void> {
    const observe = this.#options.controllerObservation;
    if (!observe) return;
    const observation = observe();
    const observationKey = JSON.stringify(observation);
    if (this.#lastControllerObservationKey === observationKey) return;
    const latest = (snapshot.factoryEvents ?? [])
      .filter((event) => event.kind === "controller" && event.runId === this.#run.runId)
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    if (
      latest?.kind === "controller" &&
      latest.controllerId === observation.controllerId &&
      latest.epoch === observation.epoch &&
      latest.expiresAt === observation.expiresAt &&
      latest.controllerPolicyDigest === observation.controllerPolicyDigest &&
      latest.protocolMin === PROTOCOL_V2 &&
      latest.protocolMax === PROTOCOL_V2
    ) {
      this.#lastControllerObservationKey = observationKey;
      return;
    }
    await this.#lease.use((lease) =>
      this.#recorder.controller({
        lease,
        objectiveNodeId: snapshot.id,
        sequence: this.#sequences.take(),
        ...observation,
        protocolMin: PROTOCOL_V2,
        protocolMax: PROTOCOL_V2,
      }),
    );
    this.#lastControllerObservationKey = observationKey;
  }

  async #acknowledgeOperationalGate(snapshot: Snapshot, gate: AdmissionGateCommand): Promise<void> {
    const event = gate.kind === "drain" ? "RunDrainCompleted" : "RunPauseAcknowledged";
    const recorded = (snapshot.factoryEvents ?? []).some(
      (candidate) =>
        candidate.kind === "run" &&
        candidate.runId === this.#run.runId &&
        candidate.event === event &&
        candidate.commandRequestId === gate.requestId,
    );
    if (recorded) return;
    await this.#lease.use((lease) =>
      this.#recorder.operationalGate({
        lease,
        objectiveNodeId: snapshot.id,
        sequence: this.#sequences.take(),
        event,
        commandRequestId: gate.requestId,
      }),
    );
  }

  /** A resume may cross only actual squash merges of this run's accepted heads.
   * This read-only preflight also tolerates a lost final integration receipt:
   * publication and acceptance predate the independently observed real merge. */
  async #observedRunOwnsBaseAdvance(
    snapshot: Snapshot,
    run: RunState,
    targetBaseSha: string,
  ): Promise<boolean> {
    if (!run.baseSha || snapshot.number !== run.objective) return false;
    const observations = new Map<
      number,
      Awaited<ReturnType<GitHubControlStore["readPullRequest"]>>
    >();
    let cursor = targetBaseSha;
    const visited = new Set<string>();
    while (cursor !== run.baseSha) {
      if (visited.has(cursor) || visited.size >= snapshot.workItems.length) return false;
      visited.add(cursor);
      const matches = [];
      for (const item of snapshot.workItems) {
        const events = deduplicateFactoryEvents(item.factoryEvents ?? []).filter(
          (event) =>
            event.runId === run.runId && "workItem" in event && event.workItem === item.number,
        );
        for (const linked of item.linkedPullRequests) {
          if (linked.state !== "MERGED") continue;
          let pull = observations.get(linked.number);
          if (!pull) {
            if (observations.size >= 1000) return false;
            pull = await this.#store.readPullRequest(linked.number);
            observations.set(linked.number, pull);
          }
          if (!pull.merged || pull.mergeCommitSha !== cursor) continue;
          const published = events.find(
            (event) =>
              event.kind === "attempt" &&
              event.event === "AttemptPublished" &&
              event.headSha === pull.headSha &&
              event.policyDigest === run.policyDigest,
          );
          if (published?.kind !== "attempt" || !published.artifactDigest) return false;
          const validation = [...events]
            .reverse()
            .find(
              (event) =>
                event.kind === "validation" &&
                event.attempt === published.attempt &&
                event.passed &&
                event.sequence < published.sequence &&
                (event.policyDigest === undefined || event.policyDigest === run.policyDigest),
            );
          if (
            validation?.kind !== "validation" ||
            !events.some(
              (event) =>
                event.kind === "attempt" &&
                event.event === "AttemptValidated" &&
                event.attempt === published.attempt &&
                event.policyDigest === run.policyDigest &&
                event.artifactDigest === published.artifactDigest &&
                event.sequence < published.sequence,
            )
          )
            return false;
          const reservation = (await this.#attempts.list(run.objective, item.number)).find(
            (entry) => entry.runId === run.runId && entry.attempt === published.attempt,
          );
          if (
            !reservation ||
            reservation.objective !== run.objective ||
            reservation.workItem !== item.number ||
            reservation.policyDigest !== run.policyDigest ||
            reservation.backend !== published.backend ||
            reservation.directorEpoch !== published.directorEpoch ||
            reservation.baseSha !== published.baseSha ||
            pull.baseRef !== run.baseBranch ||
            pull.nodeId !== linked.id ||
            pull.number !== linked.number ||
            pull.headSha !== linked.headSha ||
            pull.baseRepository?.toLowerCase() !== run.repository?.toLowerCase() ||
            pull.headRepository?.toLowerCase() !== run.repository?.toLowerCase()
          )
            return false;
          const head = await this.#store.readCommit(pull.headSha);
          const exactHeadValidation = bindValidationToPublishedHead({
            validation: {
              passed: true,
              digest: validation.evidenceDigest,
              baseSha: validation.baseSha,
              outputTreeSha: validation.outputTreeSha,
            },
            publishedHeadSha: pull.headSha,
            publishedTreeSha: head.treeOid,
            publishedBaseSha: validation.baseSha,
          });
          const commit = await this.#store.readCommit(cursor);
          if (commit.oid !== cursor || commit.parentOids.length !== 1) return false;
          const parent = commit.parentOids[0]!;
          const publishedPull: PublishedPullRequest = {
            number: linked.number,
            branch: pull.headRef!,
            commitSha: pull.headSha,
            htmlUrl: `https://github.com/${run.repository}/pull/${linked.number}`,
            exactHeadValidation,
          };
          if (parent === validation.baseSha) {
            await verifySquashIntegration(this.#store, publishedPull, cursor, parent);
          } else {
            const candidate = await this.#mergeCandidates.load({
              runId: run.runId,
              objective: run.objective,
              workItem: item.number,
              attempt: published.attempt,
              pullRequest: linked.number,
              sourceHeadSha: pull.headSha,
              sourceExactHeadValidationDigest: exactHeadValidation.digest,
              targetBaseSha: parent,
            });
            const review = candidate
              ? await this.#reviews.load(this.#mergeCandidateReviewIdentity(candidate))
              : null;
            if (!candidate || !review?.review.accepted || review.review.unmetCriteria.length)
              return false;
            await verifyMergeCandidateSquash(
              this.#store,
              exactHeadValidation,
              candidate.evidence,
              cursor,
            );
          }
          matches.push(parent);
        }
      }
      if (matches.length !== 1) return false;
      cursor = matches[0]!;
    }
    return true;
  }

  async run(): Promise<SupervisorResult> {
    this.#recoveryRuntime = null;
    this.#compiledGraph = null;
    this.#compiledProjection = null;
    this.#durablePackets.clear();
    await verifyLocalRepository(this.#options.repository, this.#options.owner, this.#options.repo);
    let snapshot = await this.#reader.readObjective(this.#options.objective);
    this.#ciExpectedOnPullRequests = snapshot.ciExpectedOnPullRequests;
    const facts = await this.#store.getRepositoryFacts();
    const actor = await this.#store.getAuthenticatedLogin();
    const runManager = new RunManager(this.#store);
    const resumedRun = await this.#resumeObservedRun(snapshot, runManager, "inspect");
    if (!resumedRun && this.#withdrawnActivation(snapshot, actor, facts.fullName))
      return {
        status: "cancelled",
        objective: snapshot.number,
        runId: this.#options.activation!.requestId,
        reason: "activation was withdrawn before its run started",
      };
    if (resumedRun) {
      if (
        resumedRun.objective !== snapshot.number ||
        resumedRun.repository?.toLowerCase() !== facts.fullName.toLowerCase() ||
        resumedRun.baseBranch !== snapshot.defaultBranch ||
        resumedRun.fork !== facts.fork ||
        (!this.#options.recovery &&
          this.#options.activation !== undefined &&
          (resumedRun.activationRequestId !== this.#options.activation.requestId ||
            resumedRun.baseSha !== this.#options.activation.baseSha))
      ) {
        throw new Error(
          "active run receipt does not match the current Objective, repository, branch, fork, or activation fence",
        );
      }
      this.#policy = resumedRun.policy;
      if (!this.#managementOverride) {
        this.#management = new CodexCliManagementBackend({
          ...(this.#policy.modelProfile ? { profile: this.#policy.modelProfile } : {}),
        });
      }
      if (
        this.#policy.backendOrder.includes("codex-sdk/local-worktree") &&
        !this.#registry.get("codex-sdk/local-worktree")
      ) {
        this.#registry.register(new CodexSdkLocalBackend());
      }
      if (
        this.#policy.backendOrder.includes("codex-app-server/local-worktree") &&
        !this.#registry.get("codex-app-server/local-worktree")
      ) {
        this.#registry.register(
          new CodexAppServerLocalBackend({
            ...(this.#policy.modelProfile ? { profile: this.#policy.modelProfile } : {}),
          }),
        );
      }
      if (
        this.#policy.backendOrder.includes("codex-cli/daytona") &&
        !this.#registry.get("codex-cli/daytona")
      ) {
        this.#registry.register(new DaytonaBackend({ repository: this.#options.repository }));
      }
      if (
        this.#policy.backendOrder.includes("codex-cli/vercel-sandbox") &&
        !this.#registry.get("codex-cli/vercel-sandbox")
      ) {
        this.#registry.register(new VercelSandboxBackend({ repository: this.#options.repository }));
      }
    }
    this.#baseBranch = snapshot.defaultBranch;
    if (!facts.canPush) {
      return this.#startlessEscalation(
        "GitHub identity lacks repository write/push permission required for control refs and pull requests",
        snapshot,
        actor,
      );
    }
    if (facts.fork && this.#policy.trust === "explicitly_activated_repo") {
      return this.#startlessEscalation(
        "trusted-local execution is not allowed for a fork",
        snapshot,
        actor,
      );
    }
    if (this.#policy.trust !== "sandbox_untrusted") {
      if (!snapshot.authorLogin) {
        return this.#startlessEscalation(
          "Objective author identity is unavailable for local execution",
          snapshot,
          actor,
        );
      }
      const authorPermission = await this.#store
        .readRepositoryPermission(snapshot.authorLogin)
        .catch((error) => {
          if (error instanceof PlatformUnavailableError) throw error;
          return "unavailable" as const;
        });
      if (!new Set(["admin", "maintain", "write"]).has(authorPermission)) {
        return this.#startlessEscalation(
          `Objective author lacks write, maintain, or admin repository permission required for local execution (observed ${authorPermission})`,
          snapshot,
          actor,
        );
      }
    }
    if (snapshot.closed) {
      if (!resumedRun) {
        return {
          status: "completed",
          objective: snapshot.number,
          runId: "already-closed",
        };
      }
      if (resumedRun.actor.toLowerCase() !== actor.toLowerCase()) {
        throw new Error(`active run belongs to ${resumedRun.actor}; ${actor} cannot terminate it`);
      }
      const closedBase = await this.#store.getBranchHead(snapshot.defaultBranch);
      const closedLease = await this.#leases.read(snapshot.number);
      this.#sequences = new SequenceAllocator(
        snapshotEvents(snapshot),
        resumedRun.sequence + 1,
        closedLease ?? undefined,
      );
      const acquired = await this.#leases.acquire(
        {
          objective: snapshot.number,
          runId: resumedRun.runId,
          holder: `${actor}-${randomUUID()}`,
          policyDigest: resumedRun.policyDigest,
        },
        closedBase,
        this.#sequences.take(),
      );
      this.#lease = new LeaseController(this.#leases, acquired, this.#sequences);
      this.#run = resumedRun;
      const completed = allDone(this.#deriveObjective(snapshot));
      return this.#terminal(
        runManager,
        snapshot,
        completed ? "FactoryRunCompleted" : "FactoryRunEscalated",
        completed ? undefined : "Objective was closed externally before all Work Items completed",
      );
    }
    const recoveryBlocker = await inspectImplicitRestart(snapshot, (prefix) =>
      this.#store.listRefs(prefix),
    );
    if (recoveryBlocker) {
      return this.#startlessEscalation(recoveryBlocker, snapshot, actor);
    }
    const priorityPolicy = normalizeSchedulingPolicy(this.#policy).priority;
    if (priorityPolicy.source === "issue-field-then-subissue-order") {
      let preflight;
      try {
        preflight = validatePriorityFieldDefinition(
          priorityPolicy,
          await this.#reader.readPriorityFields(),
        );
      } catch (error) {
        if (error instanceof PlatformUnavailableError) throw error;
        preflight = {
          available: false as const,
          reason: `priority field inspection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (!preflight.available) {
        if (priorityPolicy.onUnavailable === "escalate") {
          return this.#startlessEscalation(preflight.reason, snapshot, actor);
        }
        this.#priorityFallbackReason = preflight.reason;
        this.#notify(`${preflight.reason}; falling back to native sub-issue order for this run`);
      }
    }
    assertGraphQlAdmissionHeadroom(
      snapshot.graphQlRateLimit,
      this.#policy,
      Math.min(this.#policy.maxParallel, Math.max(1, snapshot.workItems.length)),
      this.#notify,
    );
    const configuredManagedProfiles = GITHUB_MANAGED_AGENT_PROFILES.filter((profile) =>
      this.#policy.backendOrder.includes(profile.backendId),
    );
    if (configuredManagedProfiles.length > 0) {
      const writer = new GithubOctokitWriter({
        token: this.#options.token,
        owner: this.#options.owner,
        repo: this.#options.repo,
        onThrottle: this.#notify,
      });
      const actorId = await this.#reader.resolveUserId(actor);
      const discoveredActors =
        snapshot.managedAgentActors ??
        (snapshot.copilotBotId
          ? [
              {
                id: snapshot.copilotBotId,
                login: "copilot-swe-agent",
                type: "Bot" as const,
              },
            ]
          : []);
      for (const profile of configuredManagedProfiles) {
        if (this.#registry.get(profile.backendId)) continue;
        const actorResolution = resolveManagedAgentActor(profile, discoveredActors);
        const managedActor = actorResolution.actor;
        const dispatcher = managedActor
          ? new Dispatcher({
              writer,
              repositoryId: snapshot.repositoryId,
              managedAgentActorId: managedActor.id,
              defaultBranch: snapshot.defaultBranch,
              escalateToId: actorId,
              onThrottle: this.#notify,
              circuitBreaker: this.#breaker,
              pacer: this.#pacer,
              concurrency: this.#concurrency,
              mutationScheduler: this.#mutations,
              beforeMutation: (waitedMs) => this.#guardMutation(waitedMs),
            })
          : undefined;
        this.#registry.register(
          new GitHubManagedAgentBackend({
            reader: this.#reader,
            ...(dispatcher ? { dispatcher } : {}),
            repository: this.#options.repository,
            profile,
            actorResolution,
          }),
        );
      }
    }
    const branchRules = await this.#store.readBranchRules(snapshot.defaultBranch);
    const blockers = branchRuleBlockers(branchRules);
    if (blockers.length > 0) {
      return this.#startlessEscalation(
        `branch policy requires HITL: ${blockers.join(", ")}`,
        snapshot,
        actor,
      );
    }
    if (requiredChecks(branchRules).length > 0) {
      const branchHead = await this.#store.getBranchHead(snapshot.defaultBranch);
      const missing = missingRequiredChecks(
        branchRules,
        await this.#store.readChecks(branchHead.oid),
      );
      if (missing.length > 0) {
        return this.#startlessEscalation(
          `required checks have no producer visible on the current base: ${missing.join(", ")}`,
          snapshot,
          actor,
        );
      }
    }
    const managementProbe = await this.#management.probe();
    if (this.#management.id !== this.#policy.managementBackend) {
      return this.#startlessEscalation(
        `run requires management backend ${this.#policy.managementBackend}, but ${this.#management.id} is configured`,
        snapshot,
        actor,
      );
    }
    if (!managementProbe.available || !managementProbe.authenticated) {
      return this.#startlessEscalation(
        managementProbe.reason ?? "management backend unavailable",
        snapshot,
        actor,
      );
    }

    if (resumedRun && resumedRun.actor.toLowerCase() !== actor.toLowerCase()) {
      throw new Error(
        `active run belongs to ${resumedRun.actor}; ${actor} cannot append its receipts`,
      );
    }
    const base = await this.#store.getBranchHead(snapshot.defaultBranch);
    if (
      this.#options.activation &&
      base.oid !== this.#options.activation.baseSha &&
      (!resumedRun || !(await this.#observedRunOwnsBaseAdvance(snapshot, resumedRun, base.oid)))
    ) {
      return this.#startlessEscalation(
        `activation ${this.#options.activation.requestId} is stale: ${snapshot.defaultBranch} advanced from ${this.#options.activation.baseSha} to ${base.oid}; reactivate against the new head`,
        snapshot,
        actor,
      );
    }
    const initialEvents = snapshotEvents(snapshot);
    const previousLease = await this.#leases.read(snapshot.number);
    this.#sequences = new SequenceAllocator(
      initialEvents,
      (resumedRun?.sequence ?? 0) + 1,
      previousLease ?? undefined,
    );
    const runId = resumedRun?.runId ?? randomUUID();
    this.#budgetEvents = this.#accountingEvents(initialEvents, runId);
    const acceptedPolicyDigest = resumedRun?.policyDigest ?? policyDigest(this.#policy);
    const acquired = await this.#leases.acquire(
      {
        objective: snapshot.number,
        runId,
        holder: `${actor}-${randomUUID()}`,
        policyDigest: acceptedPolicyDigest,
      },
      base,
      this.#sequences.take(),
    );
    this.#lease = new LeaseController(this.#leases, acquired, this.#sequences);
    try {
      // Preflight is not a lock: the previous holder may have finished or spent
      // more budget before this lease was acquired. Refresh both new and resumed runs.
      let current = await this.#reader.readObjective(snapshot.number);
      const needsReconciliation = Boolean(this.#options.recovery && !this.#recoveryRuntime);
      let currentRun = await this.#resumeObservedRun(current, runManager, "repair");
      if (!currentRun && this.#withdrawnActivation(current, actor, facts.fullName)) {
        await this.#lease.release();
        return {
          status: "cancelled",
          objective: current.number,
          runId: this.#options.activation!.requestId,
          reason: "activation was withdrawn before its run started",
        };
      }
      // Repair may append actual merge receipts. Refresh the startup accounting
      // and derive state from those receipts, never from the pre-repair snapshot.
      if (needsReconciliation) {
        current = await this.#reader.readObjective(snapshot.number);
        currentRun = await this.#resumeObservedRun(current, runManager);
      }
      if (
        current.closed ||
        current.number !== snapshot.number ||
        current.id !== snapshot.id ||
        current.repositoryId !== snapshot.repositoryId ||
        current.defaultBranch !== snapshot.defaultBranch ||
        current.authorLogin !== snapshot.authorLogin ||
        (resumedRun
          ? !currentRun ||
            currentRun.runId !== resumedRun.runId ||
            currentRun.objective !== resumedRun.objective ||
            currentRun.repository !== resumedRun.repository ||
            currentRun.baseBranch !== resumedRun.baseBranch ||
            currentRun.fork !== resumedRun.fork ||
            currentRun.policyDigest !== resumedRun.policyDigest ||
            currentRun.actor !== resumedRun.actor ||
            currentRun.baseSha !== resumedRun.baseSha ||
            currentRun.activationRequestId !== resumedRun.activationRequestId ||
            currentRun.startedAt.getTime() !== resumedRun.startedAt.getTime()
          : Boolean(currentRun))
      ) {
        throw new Error("Objective run changed during startup; re-read its current state");
      }
      if (!resumedRun) {
        const blocker = await inspectImplicitRestart(current, (prefix) =>
          this.#store.listRefs(prefix),
        );
        if (blocker) {
          const rejected = await this.#startlessEscalation(blocker, current, actor);
          await this.#lease.release();
          return rejected;
        }
      }
      // The original activation remains immutable across restarts. Recheck its
      // permitted progress under the lease before writing any resumed-run effect.
      if (currentRun && this.#options.activation) {
        const currentBase = await this.#store.getBranchHead(current.defaultBranch);
        if (
          currentBase.oid !== this.#options.activation.baseSha &&
          !(await this.#observedRunOwnsBaseAdvance(current, currentRun, currentBase.oid))
        )
          throw new Error("base branch advanced outside this run during startup");
      }
      snapshot = current;
      this.#sequences.observe(snapshotEvents(snapshot));
      this.#budgetEvents = this.#accountingEvents(snapshotEvents(snapshot), runId);
      this.#run =
        currentRun ??
        (await runManager.start({
          objective: snapshot.number,
          objectiveNodeId: snapshot.id,
          repository: facts.fullName,
          objectiveAuthor: snapshot.authorLogin ?? "unknown",
          actor,
          fork: facts.fork,
          baseBranch: snapshot.defaultBranch,
          policy: this.#policy,
          existingEvents: snapshot.factoryEvents ?? [],
          runId,
          sequence: this.#sequences.take(),
          ...(this.#options.activation
            ? {
                activationRequestId: this.#options.activation.requestId,
                baseSha: this.#options.activation.baseSha,
              }
            : {}),
        }));
      const durableRunStart = (snapshot.factoryEvents ?? []).find(
        (event) =>
          event.kind === "run" &&
          event.event === "FactoryRunStarted" &&
          event.runId === this.#run.runId,
      );
      this.#runStartSequence = durableRunStart?.sequence ?? this.#run.sequence;
      await this.#recordControllerObservation(snapshot);
    } catch (error) {
      await this.#lease.release().catch(() => {});
      throw error;
    }

    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      void this.#lease.renewIfNeeded().catch((error) => {
        heartbeatError = error;
        this.#lease.fail(error);
      });
    }, 30_000);
    heartbeat.unref();
    const deadline = this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000;
    const activeExecutions = new ContinuousExecutionPool<number>();
    const executionAbort = new AbortController();
    const forwardAbort = () => executionAbort.abort();
    this.#options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (this.#options.signal?.aborted) executionAbort.abort();
    const drainExecutions = async (): Promise<void> => {
      executionAbort.abort();
      const settlements = await activeExecutions.settle();
      // Intentional teardown reports this typed cancellation only after the
      // execution has reconciled cleanup and its attempt receipt. It is not a
      // new operator command and must not replace the outcome being drained for.
      // Every other failure (including cleanup or fencing uncertainty) survives.
      const failure = settlements.find(
        (settlement) =>
          settlement.error && !(settlement.error instanceof RunCancellationRequestedError),
      );
      if (failure?.error) throw failure.error;
    };
    const terminalAfterDrain = async (
      event: "FactoryRunCompleted" | "FactoryRunCancelled" | "FactoryRunEscalated",
      reason?: string,
    ): Promise<SupervisorResult> => {
      await drainExecutions();
      snapshot = await this.#reader.readObjective(snapshot.number);
      this.#fenceSnapshot(snapshot);
      this.#sequences.observe(snapshotEvents(snapshot));
      return this.#terminal(runManager, snapshot, event, reason);
    };
    const releaseAfterDrain = async (): Promise<SupervisorResult> => {
      await drainExecutions();
      return this.#releaseForShutdown(snapshot);
    };
    const escalateAfterDrain = async (
      item: DerivedWorkItem,
      reason: string,
    ): Promise<SupervisorResult> => {
      await drainExecutions();
      snapshot = await this.#reader.readObjective(snapshot.number);
      this.#fenceSnapshot(snapshot);
      this.#sequences.observe(snapshotEvents(snapshot));
      const refreshed = derive(snapshot).items.find(
        (candidate) => candidate.number === item.number,
      );
      if (!refreshed) {
        throw new Error(
          `Work Item #${item.number} disappeared while draining executions for escalation`,
        );
      }
      return this.#escalate(runManager, snapshot, refreshed, reason);
    };
    this.#fairness.register(this.#options.objective);

    try {
      const deliveryPolicy = this.#policy.delivery ?? {
        mode: "regular-prs" as const,
        onUnavailable: "regular-prs" as const,
        merge: "bottom-up" as const,
      };
      const durableSelections = initialEvents.filter(
        (event) => event.kind === "delivery" && event.runId === this.#run.runId,
      );
      const priorSelection = durableSelections.at(-1);
      if (priorSelection?.kind === "delivery") {
        const conflicting = durableSelections.some(
          (event) =>
            event.kind !== "delivery" ||
            event.requested !== priorSelection.requested ||
            event.selected !== priorSelection.selected ||
            event.capabilityVersion !== priorSelection.capabilityVersion ||
            event.reason !== priorSelection.reason,
        );
        if (conflicting || priorSelection.requested !== deliveryPolicy.mode) {
          throw new Error("durable delivery selection conflicts with the run policy");
        }
        this.#deliverySelection = {
          requested: priorSelection.requested,
          selected: priorSelection.selected,
          capabilityVersion: priorSelection.capabilityVersion,
          reason: priorSelection.reason,
        };
      } else {
        const capability =
          deliveryPolicy.mode === "stacked-prs"
            ? await this.#stacks.probe()
            : {
                available: false,
                observed: true,
                version: GITHUB_STACKS_API_VERSION,
                reason: "native stacks were not requested",
              };
        this.#deliverySelection = selectDelivery({
          requested: deliveryPolicy.mode,
          onUnavailable: deliveryPolicy.onUnavailable,
          capability,
        });
        try {
          await this.#lease.use((lease) =>
            this.#recorder.delivery({
              lease,
              objectiveNodeId: snapshot.id,
              sequence: this.#sequences.take(),
              selection: this.#deliverySelection,
            }),
          );
        } catch (error) {
          const recoveredSnapshot = await this.#reader.readObjective(snapshot.number);
          const recovered = (recoveredSnapshot.factoryEvents ?? []).find(
            (event) =>
              event.kind === "delivery" &&
              event.runId === this.#run.runId &&
              event.requested === this.#deliverySelection.requested &&
              event.selected === this.#deliverySelection.selected &&
              event.capabilityVersion === this.#deliverySelection.capabilityVersion &&
              event.reason === this.#deliverySelection.reason,
          );
          if (!recovered) throw error;
          snapshot = recoveredSnapshot;
          this.#sequences.observe(snapshotEvents(snapshot));
        }
      }
      if (this.#deliverySelection.selected === "escalate") {
        return await this.#terminal(
          runManager,
          snapshot,
          "FactoryRunEscalated",
          `stacked delivery unavailable: ${this.#deliverySelection.reason}`,
        );
      }
      if (this.#recoveryRuntime) {
        await this.#prepareRecoveryGraph(snapshot);
      } else {
        const observedGraph = inspectCompiledGraph(snapshot);
        const graphManager = new CompiledGraphManager(this.#store, this.#leases);
        let durableGraph = await graphManager.load(snapshot.number, this.#run.runId);
        const sourceGraph =
          durableGraph ??
          (observedGraph.receiptRunId && observedGraph.receiptRunId !== this.#run.runId
            ? await graphManager.load(snapshot.number, observedGraph.receiptRunId)
            : null);
        if (sourceGraph && observedGraph.expectedDigest) {
          if (
            sourceGraph.graphDigest !== observedGraph.expectedDigest ||
            sourceGraph.graphSize !== observedGraph.expectedSize ||
            sourceGraph.ref !== observedGraph.expectedRef ||
            sourceGraph.blobOid !== observedGraph.expectedBlobSha
          ) {
            throw new Error("durable compiled graph does not match its Objective receipt");
          }
        }
        const recoverableObjective = sourceGraph?.objective ?? observedGraph.completeObjective;
        let invokeCompilation:
          | ((checkpoint: CompilationCheckpoint) => Promise<CompilationResult>)
          | undefined;
        const compilationInvocationId = `compile-${base.oid}`;
        if (!recoverableObjective) {
          this.#assertManagementInvocationNotFailed(compilationInvocationId);
          this.#notify("compiling Objective into a dependency graph");
          if (observedGraph.hasReceipt || observedGraph.existing.length > 0) {
            throw new Error(
              "compiled graph receipt exists but its durable graph record is missing",
            );
          }
          const layout = await this.#reader.readRepositoryLayout(undefined, 5_000);
          if (layout.truncated) {
            throw new Error("repository layout is incomplete; compilation would be under-grounded");
          }
          const compilationBudget = remainingBudget(
            this.#policy,
            deriveBudgetUsage(this.#budgetEvents),
          );
          if (compilationBudget.modelTokens !== null && compilationBudget.modelTokens <= 0) {
            throw new Error("model-token budget is exhausted; refusing Objective compilation");
          }
          const compilationModel = resolveModelSelection(this.#policy, "compile");
          invokeCompilation = (checkpoint) =>
            this.#externalAdmission(() =>
              this.#management.compile(
                {
                  repository: this.#options.repository,
                  objective: {
                    number: snapshot.number,
                    title: snapshot.title,
                    body: snapshot.body,
                  },
                  defaultBranch: snapshot.defaultBranch,
                  baseSha: base.oid,
                  repositoryFiles: layout.files,
                  allowedNetworkDestinations: this.#policy.allowedNetworkDestinations,
                  ...(compilationModel ? { modelSelection: compilationModel } : {}),
                },
                checkpoint,
              ),
            );
        } else if (!durableGraph) {
          // A graph recovered from an older run or issue receipt is copied into
          // this run's immutable ref before any backend preflight can fail.
          durableGraph = await this.#lease.use((lease) =>
            graphManager.persist({
              lease,
              base,
              objective: recoverableObjective,
            }),
          );
        }
        durableGraph = await runDurableCompilationTransaction({
          existing: durableGraph,
          ...(invokeCompilation ? { invoke: invokeCompilation } : {}),
          persist: (result) =>
            this.#lease.use((lease) =>
              graphManager.persist({
                lease,
                base,
                objective: result.objective,
                compilation: {
                  invocationId: compilationInvocationId,
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  ...(result.usage.cachedInputTokens === undefined
                    ? {}
                    : { cachedInputTokens: result.usage.cachedInputTokens }),
                },
              }),
            ),
          recover: () => graphManager.load(snapshot.number, this.#run.runId),
          recordFailureUsage: (usage) =>
            this.#recordFailedManagementUsage(compilationInvocationId, usage, snapshot.id),
          recordUsage: async (record) => {
            if (!record.compilation) return;
            const amount = record.compilation.inputTokens + record.compilation.outputTokens;
            const usageId = `compile-${record.graphDigest}`;
            const matching = this.#budgetEvents.filter(
              (event) =>
                event.kind === "budget" &&
                event.runId === this.#run.runId &&
                event.event === "BudgetReconciled" &&
                event.phase === "management" &&
                event.unit === "model_tokens" &&
                event.usageId === usageId,
            );
            if (matching.some((event) => event.amount !== amount)) {
              throw new Error("durable compilation usage conflicts with its budget receipt");
            }
            if (matching.length > 0) return;
            try {
              const event = await this.#lease.use((lease) =>
                this.#recorder.objectiveBudget({
                  lease,
                  objectiveNodeId: snapshot.id,
                  sequence: this.#sequences.take(),
                  event: "BudgetReconciled",
                  unit: "model_tokens",
                  amount,
                  usageId,
                  reportedModelUsage: reportedModelUsage(record.compilation)!,
                }),
              );
              this.#budgetEvents.push(event);
            } catch (error) {
              const recoveredSnapshot = await this.#reader.readObjective(snapshot.number);
              const recoveredEvent = snapshotEvents(recoveredSnapshot).find(
                (event) =>
                  event.kind === "budget" &&
                  event.runId === this.#run.runId &&
                  event.event === "BudgetReconciled" &&
                  event.phase === "management" &&
                  event.unit === "model_tokens" &&
                  event.usageId === usageId &&
                  event.amount === amount,
              );
              if (!recoveredEvent) throw error;
              snapshot = recoveredSnapshot;
              this.#sequences.observe(snapshotEvents(snapshot));
              if (
                !this.#budgetEvents.some(
                  (event) =>
                    event.kind === "budget" &&
                    event.sequence === recoveredEvent.sequence &&
                    event.runId === recoveredEvent.runId,
                )
              ) {
                this.#budgetEvents.push(recoveredEvent);
              }
            }
          },
          preflight: async (objective) => {
            assertGraphWithinRunPolicy(objective, this.#policy);
            if (this.#deliverySelection.selected === "native-stacks") {
              const deliveryItems = objective.workItems.map((item) => {
                if (!item.delivery) {
                  throw new Error(`Work Item ${item.id} has no delivery hint for stacked delivery`);
                }
                return {
                  id: item.id,
                  dependsOn: item.dependsOn,
                  delivery: {
                    group: item.delivery.group,
                    relationship: item.delivery.relationship,
                    ...(item.delivery.parentWorkItem
                      ? { parentWorkItem: item.delivery.parentWorkItem }
                      : {}),
                  },
                };
              });
              const planned = planDelivery(deliveryItems);
              if (planned.result === "unsupported") {
                throw new Error(`unsupported delivery topology: ${planned.reason}`);
              }
              this.#deliveryPlan = planned;
            }
            await this.#preflightCompiledGraph(objective);
          },
        });
        const compiled = durableGraph.objective;
        let durableProjection = await graphManager.loadProjection(
          snapshot.number,
          this.#run.runId,
          durableGraph,
        );
        const existingProjectionReceipts = snapshotEvents(snapshot).filter(
          (event): event is Extract<FactoryEvent, { kind: "graph"; event: "GraphProjected" }> =>
            event.kind === "graph" &&
            event.event === "GraphProjected" &&
            event.runId === this.#run.runId,
        );
        if (existingProjectionReceipts.length > 1) {
          throw new Error(
            "immutable graph projection has multiple authenticated Objective receipts",
          );
        }
        if (durableProjection) {
          assertAuthenticatedGraphProjection(
            snapshotEvents(snapshot),
            snapshot.number,
            this.#run.runId,
            durableProjection,
          );
          assertSnapshotMatchesCompiledGraph(compiled, snapshot, durableProjection.bindings);
        } else if (existingProjectionReceipts[0]) {
          const receipt = existingProjectionReceipts[0];
          const staged = await graphManager.loadStagedProjection(
            snapshot.number,
            this.#run.runId,
            durableGraph,
            receipt.projectionBlobSha,
          );
          assertAuthenticatedGraphProjection(
            snapshotEvents(snapshot),
            snapshot.number,
            this.#run.runId,
            staged,
          );
          assertSnapshotMatchesCompiledGraph(compiled, snapshot, staged.bindings);
        }
        let existingGraphItems = observedGraph.existing;
        assertGraphQlAdmissionHeadroom(
          snapshot.graphQlRateLimit,
          this.#policy,
          Math.min(this.#policy.maxParallel, compiled.workItems.length),
          this.#notify,
          pendingGraphQlGraphMutations(compiled, existingGraphItems),
        );
        if (observedGraph.receiptRunId !== this.#run.runId) {
          await this.#lease.use((lease) =>
            this.#recorder.graph({
              lease,
              objectiveNodeId: snapshot.id,
              sequence: this.#sequences.take(),
              graphDigest: durableGraph!.graphDigest,
              graphSize: durableGraph!.graphSize,
              baseSha: base.oid,
              graphRef: durableGraph!.ref,
              graphBlobSha: durableGraph!.blobOid,
            }),
          );
        }
        const graph = new GraphApplier({
          writer: new GithubOctokitGraphWriter({
            token: this.#options.token,
            owner: this.#options.owner,
            repo: this.#options.repo,
            onThrottle: this.#notify,
          }),
          circuitBreaker: this.#breaker,
          pacer: this.#pacer,
          concurrency: this.#concurrency,
          mutationScheduler: this.#mutations,
          beforeMutation: (waitedMs) => this.#guardMutation(waitedMs),
          onThrottle: this.#notify,
        });
        let appliedWorkItems: Map<string, { id: string; number: number }> | null = null;
        for (let recovery = 0; ; recovery += 1) {
          const before = JSON.stringify(
            existingGraphItems.map((item) => [
              item.compilerId,
              [...item.blockedByNumbers].sort((a, b) => a - b),
            ]),
          );
          try {
            appliedWorkItems = await graph.apply(compiled, {
              repositoryId: snapshot.repositoryId,
              objectiveIssueId: snapshot.id,
              ...(snapshot.workItemLabelId ? { workItemLabelId: snapshot.workItemLabelId } : {}),
              existingWorkItems: existingGraphItems,
            });
            break;
          } catch (error) {
            if (recovery >= 4) throw error;
            if (error instanceof PlatformUnavailableError) {
              // The breaker cooldown can outlive the lease. Stop this Director
              // and let the host scheduler resume from the immutable graph after
              // connectivity returns instead of mutating under an expired lease.
              throw error;
            } else {
              // A mutation response can be lost after GitHub commits the write.
              // Give the relationship snapshot a moment to become observable
              // before deciding that no idempotent repair is possible.
              await sleep(1_000, this.#options.signal);
            }
            snapshot = await this.#reader.readObjective(snapshot.number);
            const recovered = inspectCompiledGraph(snapshot);
            if (
              recovered.expectedDigest !== durableGraph.graphDigest ||
              recovered.expectedRef !== durableGraph.ref ||
              recovered.expectedBlobSha !== durableGraph.blobOid
            ) {
              throw error;
            }
            const after = JSON.stringify(
              recovered.existing.map((item) => [
                item.compilerId,
                [...item.blockedByNumbers].sort((a, b) => a - b),
              ]),
            );
            if (after === before && !(error instanceof PlatformUnavailableError)) throw error;
            existingGraphItems = recovered.existing;
            this.#notify("replaying the immutable graph after a partially observed GitHub write");
          }
        }
        if (!appliedWorkItems) {
          throw new Error("compiled graph application returned no GitHub issue projection");
        }
        const projectionBindings = compiled.workItems.map((item) => {
          const issue = appliedWorkItems!.get(item.id);
          if (!issue) {
            throw new Error(`compiled graph application omitted Work Item ${item.id}`);
          }
          return {
            compilerId: item.id,
            issueNodeId: issue.id,
            issueNumber: issue.number,
          };
        });
        const stagedProjection = await this.#lease.use((lease) =>
          graphManager.stageProjection({
            lease,
            graph: durableGraph!,
            bindings: projectionBindings,
          }),
        );
        let projectionReceiptEvents: readonly FactoryEvent[] = snapshotEvents(snapshot);
        const authenticateProjection = () =>
          assertAuthenticatedGraphProjection(
            projectionReceiptEvents,
            snapshot.number,
            this.#run.runId,
            stagedProjection,
          );
        const priorProjectionReceipt = snapshotEvents(snapshot).some(
          (event) =>
            event.kind === "graph" &&
            event.event === "GraphProjected" &&
            event.runId === this.#run.runId,
        );
        if (priorProjectionReceipt) {
          authenticateProjection();
        } else {
          try {
            const projectionEvent = await this.#lease.use((lease) =>
              this.#recorder.graphProjection({
                lease,
                objectiveNodeId: snapshot.id,
                sequence: this.#sequences.take(),
                graphDigest: stagedProjection.graphDigest,
                graphSize: stagedProjection.graphSize,
                projectionRef: stagedProjection.ref,
                projectionBlobSha: stagedProjection.blobOid,
              }),
            );
            projectionReceiptEvents = [projectionEvent];
            authenticateProjection();
          } catch (error) {
            const recoveredSnapshot = await this.#reader.readObjective(snapshot.number);
            snapshot = recoveredSnapshot;
            this.#sequences.observe(snapshotEvents(snapshot));
            projectionReceiptEvents = snapshotEvents(snapshot);
            try {
              authenticateProjection();
            } catch {
              throw error;
            }
          }
        }
        durableProjection = await this.#lease.use((lease) =>
          graphManager.persistProjection({
            lease,
            graph: durableGraph!,
            bindings: projectionBindings,
            expectedBlobOid: stagedProjection.blobOid,
          }),
        );
        assertAuthenticatedGraphProjection(
          projectionReceiptEvents,
          snapshot.number,
          this.#run.runId,
          durableProjection,
        );
        this.#compiledGraph = compiled;
        this.#compiledProjection = durableProjection;
      }
      for (;;) {
        if (heartbeatError) throw heartbeatError;
        if (this.#options.signal?.aborted) {
          if (this.#options.shutdownBehavior === "release-lease") {
            return await releaseAfterDrain();
          }
          return await terminalAfterDrain("FactoryRunCancelled", "operator cancelled run");
        }
        if (Date.now() >= deadline) {
          return await terminalAfterDrain("FactoryRunEscalated", "Objective timeout exhausted");
        }
        await this.#lease.renewIfNeeded();
        snapshot = await this.#reader.readObjective(snapshot.number);
        this.#fenceSnapshot(snapshot);
        this.#ciExpectedOnPullRequests = snapshot.ciExpectedOnPullRequests;
        this.#sequences.observe(snapshotEvents(snapshot));
        if (hasCancellationRequest(snapshot, this.#run.runId)) {
          return await terminalAfterDrain(
            "FactoryRunCancelled",
            "operator requested cancellation through GitHub",
          );
        }
        await this.#recordControllerObservation(snapshot);
        const commandState = deriveDurableCommandState({
          events: snapshotEvents(snapshot),
          objective: snapshot.number,
          runId: this.#run.runId,
          runActor: this.#run.actor,
          runStartSequence: this.#runStartSequence,
        });
        if (this.#recoveryRuntime) await this.#resumeObservedRun(snapshot, runManager);
        const objective = this.#deriveObjective(snapshot);
        const adoptedPublication =
          this.#recoveryRuntime &&
          objective.items.find((item) => {
            const planned = this.#recoveryRuntime!.planRecord.plan.items.find(
              (entry) => entry.workItem === item.number,
            );
            if (
              !planned?.source ||
              planned.action === "execute" ||
              item.state !== "for_review" ||
              !this.#integrationDue(item.number)
            )
              return false;
            if (planned.action === "integrated") return true;
            const unit = this.#deliveryPlan?.units.find((entry) =>
              entry.items.includes(planned.compilerId),
            );
            if (this.#deliverySelection.selected !== "native-stacks" || unit?.kind !== "stack")
              return true;
            const published =
              planned.source.publication ||
              this.#recoveryRuntime!.sourcePublications.some(
                (proof) => proof.publication.workItem === item.number,
              );
            return (
              !published ||
              unit.items.every((id) =>
                objective.items.some(
                  (member) =>
                    parseGraphItemMetadata(member.body ?? "").id === id &&
                    ["for_review", "done"].includes(member.state),
                ),
              )
            );
          });
        if (adoptedPublication) {
          await this.#resumeAdoptedSource(adoptedPublication);
          continue;
        }
        if (await this.#repairReservationReceipts(objective.items)) continue;
        if (this.#deliverySelection.selected === "regular-prs") {
          const unrecorded = objective.items.find((item) => {
            if (item.state !== "done" || activeExecutions.has(item.number)) return false;
            const published = [...(item.factoryEvents ?? [])]
              .reverse()
              .find(
                (event) =>
                  event.kind === "attempt" &&
                  event.runId === this.#run.runId &&
                  event.event === "AttemptPublished",
              );
            return (
              published?.kind === "attempt" &&
              !(item.factoryEvents ?? []).some(
                (event) =>
                  event.kind === "attempt" &&
                  event.runId === this.#run.runId &&
                  event.event === "AttemptIntegrated" &&
                  event.attempt === published.attempt,
              )
            );
          });
          if (unrecorded) {
            if (!(await this.#resumeIntegration(unrecorded)))
              await sleep(this.#options.pollIntervalMs ?? 60_000, this.#options.signal);
            continue;
          }
        }
        // GitHub can report MERGED before the response or our closure receipt arrives.
        // Reconstruct exact integration before derived "done" can close the Objective.
        const unrecordedNative =
          this.#deliverySelection.selected === "native-stacks"
            ? objective.items.find((item) => {
                if (item.state !== "done" || activeExecutions.has(item.number)) return false;
                const metadata = parseGraphItemMetadata(item.body ?? "");
                const unit = this.#deliveryPlan?.units.find((candidate) =>
                  candidate.items.includes(metadata.id),
                );
                if (!unit) return false;
                const published = [...(item.factoryEvents ?? [])]
                  .reverse()
                  .find(
                    (event) =>
                      event.kind === "attempt" &&
                      event.runId === this.#run.runId &&
                      event.event === "AttemptPublished",
                  );
                return (
                  published?.kind === "attempt" &&
                  !(item.factoryEvents ?? []).some(
                    (event) =>
                      event.kind === "attempt" &&
                      event.runId === this.#run.runId &&
                      event.event === "AttemptIntegrated" &&
                      event.attempt === published.attempt,
                  )
                );
              })
            : undefined;
        if (unrecordedNative) {
          const metadata = parseGraphItemMetadata(unrecordedNative.body ?? "");
          const unit = this.#deliveryPlan!.units.find((unit) => unit.items.includes(metadata.id))!;
          let progressed: boolean;
          if (unit.kind === "sibling") progressed = await this.#resumeIntegration(unrecordedNative);
          else {
            const members = unit.items.map((id) =>
              objective.items.find((item) => parseGraphItemMetadata(item.body ?? "").id === id),
            );
            if (members.some((item) => !item || !["done", "for_review"].includes(item.state)))
              throw new Error("native integration recovery has an incomplete publication unit");
            progressed = await this.#integrateNativeStack(
              unit.id,
              members as DerivedWorkItem[],
              deadline,
            );
          }
          if (!progressed)
            await sleep(this.#options.pollIntervalMs ?? 60_000, this.#options.signal);
          continue;
        }
        if (allDone(objective)) {
          const settlements = await activeExecutions.settle();
          const failure = settlements.find((settlement) => settlement.error);
          if (failure?.error) throw failure.error;
          snapshot = await this.#reader.readObjective(snapshot.number);
          this.#fenceSnapshot(snapshot);
          this.#sequences.observe(snapshotEvents(snapshot));
          if (this.#recoveryRuntime) await this.#resumeObservedRun(snapshot, runManager);
          if (!allDone(this.#deriveObjective(snapshot))) continue;
          await this.#lease.assert();
          await this.#store.closeIssue(snapshot.number);
          return await this.#terminal(runManager, snapshot, "FactoryRunCompleted");
        }

        const retryEligible = new Set(
          objective.items
            .filter((item) =>
              retryCommandAllows(item, commandState, this.#run, this.#policy.maxAttemptsPerItem),
            )
            .map((item) => item.number),
        );
        if (!commandState.draining) {
          const inconsistent = objective.items.find(
            (item) =>
              item.state === "inconsistent" ||
              (item.state === "escalated" && !retryEligible.has(item.number)),
          );
          if (inconsistent) {
            return await escalateAfterDrain(inconsistent, `Work Item is ${inconsistent.state}`);
          }
          const exhausted = objective.items.find(
            (item) => item.state === "failed" && item.attempts >= this.#policy.maxAttemptsPerItem,
          );
          if (exhausted) {
            return await escalateAfterDrain(
              exhausted,
              `attempt budget exhausted (${exhausted.attempts})`,
            );
          }
        }

        const recoverable = objective.items.filter(
          (item) =>
            !activeExecutions.has(item.number) &&
            (["reserved", "in_flight", "validating"].includes(item.state) ||
              (item.state === "failed" && this.#hasUnfinishedAttempt(item))),
        );
        if (recoverable.length > 0) {
          for (const item of recoverable) {
            await this.#recoverInterrupted(item, deadline, objective.items);
          }
          continue;
        }

        const reviews = objective.items.filter(
          (item) =>
            item.state === "for_review" &&
            !activeExecutions.has(item.number) &&
            this.#integrationDue(item.number),
        );
        if (reviews.length > 0) {
          if (this.#deliverySelection.selected !== "native-stacks") {
            let progressed = false;
            for (const item of reviews) {
              if (await this.#resumeIntegration(item)) {
                progressed = true;
                break; // Reconstruct after an integration before considering another base.
              }
            }
            if (progressed) continue;
          }
          let integratedUnit = false;
          for (const unit of this.#deliverySelection.selected === "native-stacks"
            ? (this.#deliveryPlan?.units ?? [])
            : []) {
            const members = unit.items.map((itemId) =>
              objective.items.find((item) => parseGraphItemMetadata(item.body ?? "").id === itemId),
            );
            if (members.some((member) => !member)) {
              throw new Error(`delivery unit ${unit.id} is missing a GitHub Work Item`);
            }
            const typedMembers = members as DerivedWorkItem[];
            if (
              !typedMembers.every((member) => new Set(["for_review", "done"]).has(member.state)) ||
              !typedMembers.some((member) => member.state === "for_review") ||
              typedMembers.some((member) => activeExecutions.has(member.number)) ||
              typedMembers.some((member) => !this.#integrationDue(member.number))
            ) {
              continue;
            }
            if (unit.kind === "sibling") {
              integratedUnit = await this.#resumeIntegration(typedMembers[0]!);
            } else {
              integratedUnit = await this.#integrateNativeStack(unit.id, typedMembers, deadline);
            }
            if (integratedUnit) break;
          }
          if (integratedUnit) continue;
        }

        if (commandState.admissionsPaused) {
          this.#fairness.reportDemand(objective.number, 0);
          if (activeExecutions.size === 0) {
            if (!commandState.admissionGate) {
              throw new Error("paused run has no durable admission-gate command");
            }
            await this.#acknowledgeOperationalGate(snapshot, commandState.admissionGate);
            if (commandState.draining) {
              return await this.#releaseForDrain(snapshot);
            }
            await sleep(this.#options.pollIntervalMs ?? 60_000, this.#options.signal);
          } else {
            const settled = await activeExecutions.waitForChange(
              this.#options.pollIntervalMs ?? 2_000,
              this.#options.signal,
            );
            if (settled?.error) throw settled.error;
          }
          continue;
        }

        // A worker promise may finish while its published PR is still waiting for
        // checks/mergeability. Regular delivery owns the whole pipeline, not just
        // that promise or the current integration-backoff window. Reconstruct
        // this gate on every snapshot so restart cannot admit a sibling on the
        // retained publication's old base. Native units keep their concurrency.
        if (
          this.#deliverySelection.selected === "regular-prs" &&
          objective.items.some((item) => item.state === "for_review")
        ) {
          this.#fairness.reportDemand(objective.number, 0);
          if (activeExecutions.size > 0) {
            const settled = await activeExecutions.waitForChange(
              this.#options.pollIntervalMs ?? 2_000,
              this.#options.signal,
            );
            if (settled?.error) throw settled.error;
          } else {
            await sleep(this.#options.pollIntervalMs ?? 60_000, this.#options.signal);
          }
          continue;
        }

        const deliveryBases = new Map<number, DeliveryExecutionBase>();
        const stackReady =
          this.#deliverySelection.selected === "native-stacks"
            ? objective.items.filter((item) => {
                if (
                  activeExecutions.has(item.number) ||
                  (!new Set(["blocked", "failed"]).has(item.state) &&
                    !retryEligible.has(item.number))
                ) {
                  return false;
                }
                const itemId = parseGraphItemMetadata(item.body ?? "").id;
                const plan = this.#deliveryPlan?.items.find(
                  (candidate) => candidate.itemId === itemId,
                );
                if (!plan?.parentItemId) return false;
                const parent = objective.items.find(
                  (candidate) =>
                    parseGraphItemMetadata(candidate.body ?? "").id === plan.parentItemId,
                );
                if (!parent || parent.state !== "for_review") return false;
                const waitsSatisfied = plan.waitsForMerge.every((dependencyId) =>
                  objective.items.some(
                    (candidate) =>
                      parseGraphItemMetadata(candidate.body ?? "").id === dependencyId &&
                      candidate.state === "done",
                  ),
                );
                if (!waitsSatisfied) return false;
                const sourcePublication = this.#recoveryRuntime?.sourcePublications.find(
                  (proof) => proof.publication.workItem === parent.number,
                );
                const original = this.#recoveryRuntime?.planRecord.plan.items.find(
                  (entry) => entry.workItem === parent.number && entry.action !== "execute",
                )?.source?.publication;
                if (sourcePublication || original) {
                  deliveryBases.set(item.number, {
                    branch: sourcePublication?.publication.branch ?? original!.branch,
                    sha: sourcePublication?.publication.sourceHeadSha ?? original!.headSha,
                  });
                  return true;
                }
                const published = [...(parent.factoryEvents ?? [])]
                  .sort((left, right) => right.sequence - left.sequence)
                  .find(
                    (event) =>
                      event.kind === "attempt" &&
                      event.runId === this.#run.runId &&
                      event.event === "AttemptPublished" &&
                      Boolean(event.headSha),
                  );
                if (!published || published.kind !== "attempt" || !published.headSha) {
                  return false;
                }
                deliveryBases.set(item.number, {
                  branch: publicationBranch(this.#run.objective, parent.number, published.attempt),
                  sha: published.headSha,
                });
                return true;
              })
            : [];
        const commandedRetries = objective.items.filter((item) => retryEligible.has(item.number));
        const runnable = [...ready(objective), ...stackReady, ...commandedRetries].filter(
          (item, index, all) =>
            (!this.#recoveryRuntime ||
              this.#recoveryRuntime.planRecord.plan.items.some(
                (planned) => planned.workItem === item.number && planned.action === "execute",
              )) &&
            !activeExecutions.has(item.number) &&
            item.attempts < this.#policy.maxAttemptsPerItem &&
            all.findIndex((candidate) => candidate.number === item.number) === index,
        );
        const scheduling = normalizeSchedulingPolicy(this.#policy);
        const durableCapacity = deriveCapacityReservations(
          objective.items.map((item) => {
            const packet = this.#packetFor(item.number);
            return {
              objective: objective.number,
              workItem: item.number,
              events: item.factoryEvents ?? [],
              defaultCpu: scheduling.capacity.local.defaultCpu,
              defaultMemoryMb: scheduling.capacity.local.defaultMemoryMb,
              paths: packet.allowedPaths,
              exclusiveResources: packet.changeSurface?.exclusiveResources ?? [],
              isLocalBackend: (id: string) => {
                const capabilities = this.#registry.get(id)?.capabilities;
                return (
                  isLocalIntegrationValidationBackend(id) ||
                  Boolean(capabilities?.hostExecution && !capabilities.requiresPaidRuntime)
                );
              },
            };
          }),
        );
        const capacity = this.#capacity.reconcileObjective(objective.number, durableCapacity);
        this.#fairness.reportDemand(objective.number, runnable.length);
        const objectiveLocalMax = this.#fairness.localMaximum(
          objective.number,
          Math.min(scheduling.capacity.local.maxWorkers, this.#controllerLimits.maxLocalWorkers),
          capacity.reservations,
        );
        this.#budgetEvents = deduplicateFactoryEvents([
          ...this.#budgetEvents,
          ...this.#accountingEvents(snapshotEvents(snapshot)),
        ]);
        const availableBudget = remainingBudget(
          this.#policy,
          deriveBudgetUsage(this.#budgetEvents),
        );
        if (
          this.#recoveryRuntime &&
          activeExecutions.size === 0 &&
          runnable.length > 0 &&
          availableBudget.modelTokens !== null &&
          availableBudget.modelTokens <= 0
        )
          return await terminalAfterDrain(
            "FactoryRunEscalated",
            "cumulative model-token budget exhausted before successor work admission",
          );
        const nowMs = snapshot.readAt.getTime();
        let resource: ResourceSnapshot | null = null;
        if (scheduling.capacity.mode === "adaptive-local") {
          resource = await this.#resourceSampler.sample(nowMs).catch((error) => {
            this.#notify(
              `local resource sampling failed closed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          });
        }
        const ranked = rankReadyWorkItems(
          objective.items,
          scheduling.priority,
          this.#priorityFallbackReason,
          new Set([
            ...stackReady.map((item) => item.number),
            ...commandedRetries.map((item) => item.number),
          ]),
          new Map(
            [...commandState.priorities].map(([workItem, command]) => [workItem, command.rank]),
          ),
        ).filter((rankedItem) => runnable.some((item) => item.number === rankedItem.item.number));
        const admissionItems: AdmissionWorkItem[] = await Promise.all(
          ranked.map(async (priority) => {
            const original = this.#packetFor(priority.item.number);
            const packet = parseWorkerPacket({
              ...original,
              requirements: {
                ...original.requirements,
                ...(this.#policy.trust === "sandbox_untrusted" &&
                original.requirements.trust === "trusted_local"
                  ? { trust: "isolated" as const }
                  : {}),
              },
            });
            const timeoutMs = Math.min(
              (packet.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000,
              Math.max(1, deadline - nowMs),
            );
            const nextAttempt =
              (priority.item.factoryEvents ?? []).reduce(
                (highest, event) =>
                  event.kind === "attempt" ? Math.max(highest, event.attempt) : highest,
                0,
              ) + 1;
            const queuedAt = queuedSince(priority.item, this.#run.runId);
            const backends = applyCloudPause(
              await this.#registry.evaluate({
                policy: this.#policy,
                requirements: packet.requirements,
                nowMs,
              }),
              commandState.cloudPaused,
            );
            if (this.#deliverySelection.selected === "native-stacks") {
              const metadata = parseGraphItemMetadata(priority.item.body ?? "");
              const unit = this.#deliveryPlan?.units.find((unit) =>
                unit.items.includes(metadata.id),
              );
              for (const candidate of backends) {
                if (
                  candidate.capabilities &&
                  !candidate.capabilities.hostExecution &&
                  !(
                    candidate.id === "codex-cli/daytona" &&
                    unit &&
                    (unit.kind === "stack" || (unit.kind === "sibling" && unit.items.length === 1))
                  )
                ) {
                  candidate.permanentReasons.push(
                    "native publication requires host-owned artifacts or Daytona with independent isolated revalidation",
                  );
                }
              }
            }
            return {
              priority,
              requirements: packet.requirements,
              backends,
              validators: applyCloudPause(
                await this.#registry.evaluateIsolatedValidators({
                  policy: this.#policy,
                  requirements: packet.requirements,
                  nowMs,
                }),
                commandState.cloudPaused,
              ),
              nextAttempt,
              estimatedDurationMs: timeoutMs,
              ...(packet.requirements.estimatedDurationMinutes === undefined
                ? {}
                : {
                    estimatedCloudTimeSavedMs:
                      packet.requirements.estimatedDurationMinutes * 60_000,
                  }),
              paths: packet.allowedPaths,
              exclusiveResources: packet.changeSurface?.exclusiveResources ?? [],
              ...(queuedAt ? { queuedSince: queuedAt } : {}),
            };
          }),
        );
        const plan = planAdmissions({
          objective: objective.number,
          policy: this.#policy,
          workItems: admissionItems,
          capacity,
          budget: availableBudget,
          resource,
          nowMs,
          objectiveDeadlineMs: deadline,
          cooldownUntilMs: this.#resourceSampler.cooldownUntil,
          leaseValid: true,
          objectiveLocalMax,
          repositoryLimits: this.#controllerLimits,
        });
        const safeAdmissions = admissionsWithinDeliverySafety({
          selected: this.#deliverySelection.selected,
          activeExecutions: activeExecutions.size,
          admissions: plan.admissions,
        });
        if (plan.queued.some((decision) => decision.code === "local-pressure")) {
          this.#resourceSampler.notePressure(nowMs);
        }
        const newQueueReceipts = plan.queued.filter((decision) => decision.recordQueueStart);
        if (safeAdmissions.length + newQueueReceipts.length > 0) {
          assertGraphQlAdmissionHeadroom(
            snapshot.graphQlRateLimit,
            this.#policy,
            Math.max(1, safeAdmissions.length),
            this.#notify,
            newQueueReceipts.length,
          );
        }
        for (const decision of newQueueReceipts) {
          const item = objective.items.find((candidate) => candidate.number === decision.workItem)!;
          await this.#lease.use((lease) =>
            this.#attempts.recordQueued({
              lease,
              workItem: item.number,
              workItemNodeId: item.id,
              sequence: this.#sequences.take(),
              reason: `${decision.code}: ${decision.reason}`,
              reasonCode: decision.code,
              gate: decision.gate,
              observedPriorityRank: decision.observedPriorityRank,
              observedSubIssuePosition: decision.observedSubIssuePosition,
              prioritySource: decision.prioritySource,
            }),
          );
        }
        const permanent = plan.queued.find((decision) => decision.permanent);
        if (permanent) {
          const item = objective.items.find(
            (candidate) => candidate.number === permanent.workItem,
          )!;
          return await escalateAfterDrain(item, `${permanent.code}: ${permanent.reason}`);
        }
        let expectedCapacityGeneration = capacity.generation;
        const limits = admissionCapacityLimits(
          this.#policy,
          resource,
          objective.number,
          objectiveLocalMax,
          this.#controllerLimits,
        );
        const started: number[] = [];
        let capacityChanged = false;
        for (const admission of safeAdmissions) {
          const item = objective.items.find(
            (candidate) => candidate.number === admission.workItem,
          )!;
          const committed = this.#capacity.tryReserve(
            expectedCapacityGeneration,
            admission.reservation,
            limits,
          );
          if (!committed.reserved) {
            this.#notify(`Work Item #${item.number} returned to queue: ${committed.code}`);
            capacityChanged = true;
            break;
          }
          expectedCapacityGeneration = committed.generation;
          started.push(item.number);
          let executionCapacityReleased = false;
          const releaseExecutionCapacity = () => {
            if (executionCapacityReleased) return;
            executionCapacityReleased = true;
            this.#capacity.release(admission.reservation.key);
          };
          activeExecutions.start(
            item.number,
            () =>
              this.#execute(
                item,
                deadline,
                admission,
                releaseExecutionCapacity,
                deliveryBases.get(item.number),
                executionAbort.signal,
              ),
            releaseExecutionCapacity,
          );
        }
        if (started.length > 0) {
          this.#notify(`admitted: ${started.map((number) => `#${number}`).join(", ")}`);
        }
        if (capacityChanged) continue;
        if (activeExecutions.size === 0) {
          await sleep(this.#options.pollIntervalMs ?? 60_000, this.#options.signal);
          continue;
        }
        const settled = await activeExecutions.waitForChange(
          this.#options.pollIntervalMs ?? 2_000,
          this.#options.signal,
        );
        if (settled?.error) throw settled.error;
      }
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      if (error instanceof PlatformUnavailableError) throw error;
      const unsafeCleanup =
        error instanceof DaytonaResourceCleanupError ||
        (error instanceof Error &&
          /automated replacement is blocked|cannot prove (?:that )?(?:the )?resource absent|may still be (?:active|billable)/i.test(
            error.message,
          ));
      if (unsafeCleanup) throw error;
      if (this.#options.signal?.aborted && this.#options.shutdownBehavior === "release-lease") {
        return await releaseAfterDrain();
      }
      if (error instanceof RunCancellationRequestedError || this.#options.signal?.aborted) {
        return await terminalAfterDrain(
          "FactoryRunCancelled",
          error instanceof RunCancellationRequestedError ? error.message : "operator cancelled run",
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      return await terminalAfterDrain("FactoryRunEscalated", reason);
    } finally {
      clearInterval(heartbeat);
      this.#options.signal?.removeEventListener("abort", forwardAbort);
      const unsettled = await activeExecutions.settle();
      this.#fairness.unregister(this.#options.objective);
      const failure = unsettled.find((settlement) => settlement.error);
      // biome-ignore lint/correctness/noUnsafeFinally: cleanup uncertainty must keep the durable run resumable instead of releasing it as terminal
      if (failure?.error) throw failure.error;
    }
  }

  async #execute(
    item: DerivedWorkItem,
    objectiveDeadline: number,
    admission: AdmissionProposal,
    releaseExecutionCapacity: () => void,
    deliveryBase?: DeliveryExecutionBase,
    executionSignal?: AbortSignal,
  ): Promise<void> {
    if (
      this.#recoveryRuntime &&
      !this.#recoveryRuntime.planRecord.plan.items.some(
        (planned) => planned.workItem === item.number && planned.action === "execute",
      )
    )
      throw new Error("successor execution is not authorized for a retained source");
    let reservation: AttemptReservation | undefined;
    let worker: LocalWorktree | undefined;
    let validation: CleanValidationResult | undefined;
    let handle: BackendHandle | undefined;
    let selected: ExecutionBackend | undefined;
    let validator: ExecutionBackend | undefined;
    let published: PublishedPullRequest | undefined;
    let budgetUnit: "managed_sessions" | "sandbox_milliseconds" | "local_milliseconds" =
      "local_milliseconds";
    let executionBudgetReserved = false;
    let executionBudgetReconciled = false;
    let validationBudgetReserved = false;
    let validationBudgetReconciled = false;
    let validationBudgetUnit: "sandbox_milliseconds" | "managed_sessions" | undefined;
    let validationStartedAt: number | undefined;
    let validationCapacity: CapacityReservation | undefined;
    let validationCapacityRecorded = false;
    let validationCapacityReconciled = false;
    let retryableArtifact: NormalizedArtifact | undefined;
    let executionCleanupConfirmed = false;
    let backendLaunchAttempted = false;
    let terminalModelTokens: number | undefined;
    let terminalModelUsage: ReportedModelUsage | undefined;
    let terminalModelProfile: string | undefined;
    let noHandleReplacementNotBefore: string | undefined;
    let validationNoHandleReplacementNotBefore: string | undefined;
    const started = Date.now();
    const confirmExecutionCleanup = async (operation: string): Promise<void> => {
      if (executionCleanupConfirmed || !handle || !selected) return;
      try {
        await selected.cleanup(handle);
        executionCleanupConfirmed = true;
      } catch (cleanupError) {
        if (!reservation || !selected.reconcileStale) {
          throw new Error(
            `${operation} failed and backend ${selected.capabilities.id} cannot prove the resource absent: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        try {
          await selected.reconcileStale({
            repository: `${this.#options.owner}/${this.#options.repo}`,
            objective: reservation.objective,
            workItem: reservation.workItem,
            attempt: reservation.attempt,
            runId: reservation.runId,
            directorEpoch: reservation.directorEpoch,
            phase: "execution",
            providerResourceId: handle.resourceId,
          });
          executionCleanupConfirmed = true;
          this.#notify(
            `${operation} recovered through stale-resource reconciliation on ${selected.capabilities.id}`,
          );
        } catch (reconcileError) {
          throw new Error(
            `${operation} was not confirmed; automated replacement is blocked because ${selected.capabilities.id} may still be active. Cleanup error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Reconciliation error: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
          );
        }
      }
    };
    try {
      if (this.#recoveryRuntime) await this.#externalAdmission(async () => {});
      const originalPacket = this.#packetFor(item.number);
      const base = deliveryBase
        ? await this.#store.readCommit(deliveryBase.sha)
        : await this.#store.getBranchHead(this.#baseBranch);
      const publicationBaseBranch = deliveryBase?.branch ?? this.#baseBranch;
      if (deliveryBase) {
        const current = await this.#store.readRef(`refs/heads/${deliveryBase.branch}`);
        if (current !== deliveryBase.sha) {
          throw new Error("stack parent branch changed before child admission");
        }
      }
      const packet = parseWorkerPacket({
        ...originalPacket,
        baseSha: base.oid,
        ...(retryContext(item, this.#run.runId)
          ? { retryContext: retryContext(item, this.#run.runId) }
          : {}),
        requirements: {
          ...originalPacket.requirements,
          ...(this.#policy.trust === "sandbox_untrusted" &&
          originalPacket.requirements.trust === "trusted_local"
            ? { trust: "isolated" as const }
            : {}),
        },
      });
      assertRequirementsWithinPolicy(
        packet.requirements,
        this.#policy,
        `Work Item #${item.number}`,
      );
      await ensureLocalCommit(this.#options.repository, base.oid);
      const timeoutMs = Math.min(
        (packet.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000,
        Math.max(1, objectiveDeadline - Date.now()),
      );
      const attemptDeadline = new Date(Date.now() + timeoutMs);
      noHandleReplacementNotBefore = new Date(attemptDeadline.getTime() + 60_000).toISOString();
      await this.#lease.use(async (lease) => {
        const prior = (await this.#attempts.list(this.#run.objective, item.number)).filter(
          (attempt) =>
            (this.#recoveryRuntime?.accountingRunIds ?? [this.#run.runId]).includes(attempt.runId),
        );
        const deferred = new Set(
          (item.factoryEvents ?? []).flatMap((event) =>
            event.kind === "attempt" &&
            (this.#recoveryRuntime?.accountingRunIds ?? [this.#run.runId]).includes(event.runId) &&
            event.event === "AttemptDeferred"
              ? [`${event.runId}:${event.attempt}`]
              : [],
          ),
        );
        const consumed = prior.filter(
          (attempt) => !deferred.has(`${attempt.runId}:${attempt.attempt}`),
        ).length;
        if (consumed >= this.#policy.maxAttemptsPerItem) {
          throw new Error(`attempt budget exhausted (${consumed})`);
        }
        const budgets = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
        selected = this.#registry.get(admission.backendId) ?? undefined;
        if (!selected) {
          throw new Error(`admitted backend ${admission.backendId} is no longer registered`);
        }
        if (
          selected.capabilities.reportsModelUsage &&
          budgets.modelTokens !== null &&
          budgets.modelTokens <= 0
        ) {
          throw new Error("model-token budget changed after admission planning");
        }
        if (
          admission.reservedBudget.unit === "sandbox_milliseconds" &&
          budgets.sandboxMinutes * 60_000 < admission.reservedBudget.amount
        ) {
          throw new Error("sandbox-minute budget changed after admission planning");
        }
        if (
          admission.reservedBudget.unit === "managed_sessions" &&
          budgets.managedAgentSessions < admission.reservedBudget.amount
        ) {
          throw new Error("managed-session budget changed after admission planning");
        }
        budgetUnit = isManagedAgentBackendId(selected.capabilities.id)
          ? "managed_sessions"
          : isSandboxBackendId(selected.capabilities.id)
            ? "sandbox_milliseconds"
            : "local_milliseconds";
        const admittedExecutionUnit =
          budgetUnit === "sandbox_milliseconds"
            ? "sandbox_milliseconds"
            : budgetUnit === "managed_sessions"
              ? "managed_sessions"
              : "none";
        if (admission.reservedBudget.unit !== admittedExecutionUnit) {
          throw new Error("admitted backend native budget unit changed before commit");
        }
        const independentValidationRequired =
          packet.requirements.trust !== "trusted_local" || !selected.capabilities.hostExecution;
        if (independentValidationRequired) {
          if (!admission.validation) {
            throw new Error("isolated work was admitted without a pinned validator");
          }
          validator = this.#registry.get(admission.validation.backendId) ?? undefined;
          if (!validator?.validate || !validator.probeValidation) {
            throw new Error(
              `admitted validator ${admission.validation.backendId} is no longer registered`,
            );
          }
          if (
            budgets.sandboxMinutes * 60_000 <
            (admission.reservedBudget.unit === "sandbox_milliseconds"
              ? admission.reservedBudget.amount
              : 0) +
              (admission.validation.reservedBudget.unit === "sandbox_milliseconds"
                ? admission.validation.reservedBudget.amount
                : 0)
          ) {
            throw new Error("sandbox-minute budget changed after validation admission planning");
          }
          if (
            budgets.managedAgentSessions <
            (admission.reservedBudget.unit === "managed_sessions"
              ? admission.reservedBudget.amount
              : 0) +
              (admission.validation.reservedBudget.unit === "managed_sessions"
                ? admission.validation.reservedBudget.amount
                : 0)
          ) {
            throw new Error("managed-session budget changed after validation admission planning");
          }
        }
        // Admission is the durable attempt-ref creation, rather than the
        // preceding local backend choice.  Fence immediately before it.
        await this.#leases.assertGeneration(lease, "admission");
        await this.#store.claimWorkItem({
          objective: this.#run.objective,
          workItem: item.number,
          runId: this.#run.runId,
          directorEpoch: lease.epoch,
          treeOid: base.treeOid,
          parentOid: base.oid,
        });
        reservation = await this.#attempts.reserve({
          lease,
          workItem: item.number,
          workItemNodeId: item.id,
          backend: selected.capabilities.id,
          base,
          sequence: this.#sequences.take(),
          prepareLocalScope: async (attempt) => {
            if (!selected!.capabilities.hostExecution) return null;
            const host = await (this.#localScopeHost ??= discoverLocalScopeHost());
            if (!host) {
              if (this.#recoveryRuntime)
                throw new Error("successor execution requires observable owned local scopes");
              return null;
            }
            return LocalScopeBatchSchema.parse({
              identity: {
                protocol: "clockgrove.factory/local-scope-v1",
                repository: `${this.#options.owner}/${this.#options.repo}`.toLowerCase(),
                objective: this.#run.objective,
                runId: this.#run.runId,
                workItem: item.number,
                attempt,
                directorEpoch: lease.epoch,
                policyDigest: this.#run.policyDigest,
                phase: "execution",
                commandIndex: 0,
                invocationDigest: workerPacketDigest(packet),
                hostIdentity: host.hostIdentity,
                ...(host.producerUnit
                  ? {
                      producerUnit: host.producerUnit,
                      producerInvocationId: host.producerInvocationId,
                    }
                  : {}),
              },
              commandCount: 1,
              producerPid: host.producerPid,
              producerStartTicks: host.producerStartTicks,
              deadline: attemptDeadline.toISOString(),
            });
          },
          admission: {
            admissionClass: admission.admissionClass,
            admissionReason: admission.admissionReason,
            requestedCpu: admission.requirements.cpu,
            requestedMemoryMb: admission.requirements.memoryMb,
            priorityRank: admission.priority.rank,
            prioritySource: admission.priority.source,
            ...(admission.priority.fieldId ? { priorityFieldId: admission.priority.fieldId } : {}),
            ...(admission.priority.optionId
              ? { priorityOptionId: admission.priority.optionId }
              : {}),
            subIssuePosition: admission.priority.subIssuePosition,
            criticalPathLength: admission.priority.criticalPathLength,
            unfinishedDownstream: admission.priority.unfinishedDownstream,
            ...(admission.capacity
              ? {
                  capacityMeasuredAt: admission.capacity.measuredAt,
                  effectiveCpu: admission.capacity.effectiveCpu,
                  availableMemoryMb: admission.capacity.availableMemoryMb,
                  loadRatio: admission.capacity.loadRatio,
                  memoryUsageRatio: admission.capacity.memoryUsageRatio,
                }
              : {}),
            ...(admission.economics ?? {}),
          },
        });
        const reservedAmount =
          admission.reservedBudget.unit === "none" ? timeoutMs : admission.reservedBudget.amount;
        const budgetEvent = await this.#recorder.budget({
          lease,
          workItemNodeId: item.id,
          reservation,
          sequence: this.#sequences.take(),
          event: "BudgetReserved",
          unit: budgetUnit,
          amount: reservedAmount,
        });
        this.#budgetEvents.push(budgetEvent);
        executionBudgetReserved = true;
        if (
          validator &&
          admission.validation &&
          admission.validation.reservedBudget.unit !== "none"
        ) {
          validationBudgetUnit = admission.validation.reservedBudget.unit;
          const validationBudget = await this.#recorder.budget({
            lease,
            workItemNodeId: item.id,
            reservation,
            sequence: this.#sequences.take(),
            event: "BudgetReserved",
            unit: validationBudgetUnit,
            phase: "validation",
            amount: admission.validation.reservedBudget.amount,
          });
          this.#budgetEvents.push(validationBudget);
          validationBudgetReserved = true;
        }
      });
      if (!selected || !reservation) throw new Error("backend reservation did not complete");
      const retryCheckpoint = selected.capabilities.providerManagedPublication
        ? undefined
        : this.#retryArtifacts.get(item.number, base.oid);
      worker = await createLocalWorktree(this.#options.repository, base.oid);
      if (retryCheckpoint) {
        await seedLocalWorktree(worker, retryCheckpoint);
        this.#notify(
          `reusing validated artifact ${retryCheckpoint.digest.slice(0, 12)} for Work Item #${item.number}`,
        );
      }
      const workerModelSelection = resolveModelSelection(
        this.#policy,
        reservation.attempt === 1 ? "implement" : "recover",
      );
      terminalModelProfile = workerModelSelection?.profile ?? this.#policy.modelProfile;
      handle = await this.#externalAdmission(() => {
        backendLaunchAttempted = true;
        return selected!.launch({
          repository: `${this.#options.owner}/${this.#options.repo}`,
          objective: this.#run.objective,
          workItem: item.number,
          attempt: reservation!.attempt,
          runId: this.#run.runId,
          directorEpoch: reservation!.directorEpoch,
          policyDigest: reservation!.policyDigest,
          workspace: worker!.path,
          packet,
          policyNetworkDestinations: this.#policy.allowedNetworkDestinations,
          providerBaseRef: publicationBaseBranch,
          deadline: attemptDeadline,
          ...(reservation!.localScopeBatch
            ? {
                localExecutionScope: {
                  batch: reservation!.localScopeBatch,
                  assertCurrent: () =>
                    this.#externalAdmission(async () => {
                      if (Date.now() >= attemptDeadline.getTime())
                        throw new Error("execution scope deadline expired");
                    }),
                },
              }
            : {}),
          ...(workerModelSelection ? { modelSelection: workerModelSelection } : {}),
          ...(retryCheckpoint ? { seededFromArtifact: true } : {}),
        });
      });
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          event: "AttemptStarted",
          sequence: this.#sequences.take(),
          providerResourceId: handle!.resourceId,
          ...(handle!.metadata?.resourceHostIdentity
            ? { resourceHostIdentity: handle!.metadata.resourceHostIdentity }
            : {}),
          ...(handle!.metadata?.environmentIdentity
            ? { environmentIdentity: handle!.metadata.environmentIdentity }
            : {}),
        }),
      );

      let lastCancellationCheck = 0;
      for (;;) {
        await this.#lease.renewIfNeeded();
        if (Date.now() - lastCancellationCheck >= 10_000) {
          lastCancellationCheck = Date.now();
          const cancellation = await this.#reader.readRunCancellationRequest(
            this.#run.objective,
            this.#run.runId,
            this.#run.actor,
            this.#activationBinding(),
          );
          if (cancellation) {
            this.#sequences.observe([cancellation]);
            throw new RunCancellationRequestedError(
              "operator requested cancellation through GitHub",
            );
          }
        }
        const observation = await selected.observe(handle);
        if (["succeeded", "failed", "cancelled"].includes(observation.state)) {
          terminalModelUsage = reportedModelUsage(observation.usage);
          const observedTokens = reportedModelTokens(observation.usage);
          if (observedTokens !== null) {
            terminalModelTokens = observedTokens;
            await this.#lease.use(async (lease) => {
              const event = await this.#recorder.budget({
                lease,
                workItemNodeId: item.id,
                reservation: reservation!,
                sequence: this.#sequences.take(),
                event: "BudgetReconciled",
                unit: "model_tokens",
                phase: "execution",
                amount: observedTokens,
                usageId: `worker-${item.number}-${reservation!.attempt}`,
                ...(terminalModelUsage ? { reportedModelUsage: terminalModelUsage } : {}),
              });
              this.#budgetEvents.push(event);
            });
          } else if (this.#policy.economics && selected.capabilities.reportsModelUsage) {
            throw new Error(
              `backend ${selected.capabilities.id} omitted terminal model-token usage required by maxModelTokens`,
            );
          }
          if (observation.state !== "succeeded") {
            throw new Error(observation.reason ?? `worker ${observation.state}`);
          }
          break;
        }
        await sleep(this.#options.pollIntervalMs ?? 2_000, executionSignal);
      }
      const artifact = await selected.collect(handle);
      retryableArtifact = artifact;
      if (artifact.outcome !== "succeeded") {
        throw new Error(artifact.reason ?? `worker ${artifact.outcome}`);
      }
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          event: "AttemptSucceeded",
          sequence: this.#sequences.take(),
          artifactDigest: artifact.digest,
          ...(terminalModelProfile ? { modelProfile: terminalModelProfile } : {}),
          ...(terminalModelTokens === undefined
            ? {}
            : { reportedModelTokens: terminalModelTokens }),
          ...(terminalModelUsage ? { reportedModelUsage: terminalModelUsage } : {}),
        }),
      );
      await confirmExecutionCleanup("post-collection backend cleanup");
      await this.#lease.use(async (lease) => {
        const event = await this.#recorder.budget({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled",
          unit: budgetUnit,
          amount: budgetUnit === "managed_sessions" ? 1 : Date.now() - started,
        });
        this.#budgetEvents.push(event);
        executionBudgetReconciled = true;
      });
      const validationBackendId = validator?.capabilities.id ?? "factory/local-validation";
      validationCapacity = {
        key: capacityReservationKey({
          objective: reservation.objective,
          workItem: reservation.workItem,
          attempt: reservation.attempt,
          phase: "validation",
          backendId: validationBackendId,
        }),
        objective: reservation.objective,
        workItem: reservation.workItem,
        attempt: reservation.attempt,
        phase: "validation",
        backendId: validationBackendId,
        admissionClass:
          !validator ||
          (validator.capabilities.hostExecution && !validator.capabilities.requiresPaidRuntime)
            ? "local"
            : "remote-required",
        local:
          !validator ||
          (validator.capabilities.hostExecution && !validator.capabilities.requiresPaidRuntime),
        cpu: admission.requirements.cpu,
        memoryMb: admission.requirements.memoryMb,
        paidUnits: validator?.capabilities.requiresPaidRuntime ? 1 : 0,
        paths: admission.reservation.paths,
        exclusiveResources: admission.reservation.exclusiveResources,
      };
      for (;;) {
        await this.#lease.renewIfNeeded();
        if (Date.now() >= objectiveDeadline) {
          throw new Error("Objective timeout exhausted while awaiting validation capacity");
        }
        let validationResource: ResourceSnapshot | null = null;
        const effective = normalizeSchedulingPolicy(this.#policy);
        if (validationCapacity.local && effective.capacity.mode === "adaptive-local") {
          validationResource = await this.#resourceSampler.sample(Date.now()).catch(() => null);
          const pressure = validationResource
            ? resourcePressureReasons(validationResource, effective.capacity.local)
            : ["resource sample unavailable"];
          if (pressure.length > 0 || this.#resourceSampler.coolingDown(Date.now())) {
            if (pressure.length > 0) {
              this.#resourceSampler.notePressure(Date.now());
            }
            await sleep(this.#options.pollIntervalMs ?? 2_000, executionSignal);
            continue;
          }
        }
        const current = this.#capacity.snapshot();
        const transitioned = this.#capacity.transition(
          current.generation,
          admission.reservation.key,
          validationCapacity,
          admissionCapacityLimits(
            this.#policy,
            validationResource,
            this.#run.objective,
            this.#fairness.localMaximum(
              this.#run.objective,
              Math.min(effective.capacity.local.maxWorkers, this.#controllerLimits.maxLocalWorkers),
              current.reservations,
            ),
            this.#controllerLimits,
          ),
        );
        if (transitioned.reserved) break;
        if (transitioned.code === "duplicate-reservation") {
          throw new Error("execution capacity disappeared before validation transition");
        }
        await sleep(this.#options.pollIntervalMs ?? 2_000, executionSignal);
      }
      releaseExecutionCapacity();
      const scopedValidation = validator
        ? null
        : await this.#scopedValidation(
            reservation!,
            artifact,
            packet,
            new Date(Date.now() + timeoutMs),
          );
      await this.#lease.use(async (lease) => {
        const capacityEvent = await this.#attempts.recordCapacity({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          sequence: this.#sequences.take(),
          event: "CapacityReserved",
          phase: "validation",
          backend: validationCapacity!.backendId,
          requestedCpu: validationCapacity!.cpu,
          requestedMemoryMb: validationCapacity!.memoryMb,
          ...(scopedValidation ? { localScopeBatch: scopedValidation.batch } : {}),
        });
        const validationDeadline = new Date(new Date(capacityEvent.at).getTime() + timeoutMs);
        if (validationDeadline.getTime() <= Date.now()) {
          throw new Error("validation deadline expired before validator launch");
        }
        validationNoHandleReplacementNotBefore = new Date(
          validationDeadline.getTime() + 60_000,
        ).toISOString();
        validationCapacityRecorded = true;
      });
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          event: "AttemptCollected",
          sequence: this.#sequences.take(),
          artifactDigest: artifact.digest,
        }),
      );

      const validationStarted = Date.now();
      validationStartedAt = validationStarted;
      validation = await this.#externalAdmission(() =>
        validateArtifactClean({
          repository: this.#options.repository,
          artifact,
          packet,
          ...(scopedValidation ? { localScope: scopedValidation.hooks } : {}),
          ...(validator
            ? {
                isolatedValidator: () =>
                  this.#externalAdmission(() =>
                    validator!.validate!({
                      repository: `${this.#options.owner}/${this.#options.repo}`,
                      objective: this.#run.objective,
                      workItem: item.number,
                      attempt: reservation!.attempt,
                      runId: this.#run.runId,
                      directorEpoch: reservation!.directorEpoch,
                      policyDigest: reservation!.policyDigest,
                      workspace: worker!.path,
                      packet,
                      policyNetworkDestinations: this.#policy.allowedNetworkDestinations,
                      artifact,
                      deadline: new Date(
                        new Date(validationNoHandleReplacementNotBefore!).getTime() - 60_000,
                      ),
                    }),
                  ),
              }
            : {}),
        }),
      );
      await this.#lease.use((lease) =>
        this.#recorder.validation({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          evidence: validation!.evidence,
          sequence: this.#sequences.take(),
        }),
      );
      await this.#lease.use(async (lease) => {
        await this.#attempts.recordCapacity({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          sequence: this.#sequences.take(),
          event: "CapacityReconciled",
          phase: "validation",
          backend: validationCapacity!.backendId,
          requestedCpu: validationCapacity!.cpu,
          requestedMemoryMb: validationCapacity!.memoryMb,
        });
        validationCapacityReconciled = true;
      });
      this.#capacity.release(validationCapacity.key);
      await this.#lease.use(async (lease) => {
        const event = await this.#recorder.budget({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled",
          unit: "validation_milliseconds",
          amount: Date.now() - validationStarted,
        });
        this.#budgetEvents.push(event);
        if (validator && validationBudgetUnit) {
          const sandboxEvent = await this.#recorder.budget({
            lease,
            workItemNodeId: item.id,
            reservation: reservation!,
            sequence: this.#sequences.take(),
            event: "BudgetReconciled",
            unit: validationBudgetUnit,
            phase: "validation",
            amount:
              validationBudgetUnit === "managed_sessions" ? 1 : Date.now() - validationStarted,
          });
          this.#budgetEvents.push(sandboxEvent);
          validationBudgetReconciled = true;
        }
      });
      if (!validation.evidence.passed) {
        throw new Error(validation.evidence.failureReason ?? "validation failed");
      }

      const reviewIdentity: ReviewIdentity = {
        kind: "artifact",
        runId: this.#run.runId,
        objective: this.#run.objective,
        workItem: item.number,
        attempt: reservation!.attempt,
        artifactDigest: artifact.digest,
        baseSha: validation.evidence.baseSha,
        outputTreeSha: validation.evidence.outputTreeSha,
        evidenceDigest: validation.evidence.digest,
      };
      const existingReview = await this.#reviews.load(reviewIdentity);
      let invokeReview:
        | ((
            checkpoint: Parameters<ManagementBackend["review"]>[1],
          ) => ReturnType<ManagementBackend["review"]>)
        | undefined;
      if (!existingReview) {
        this.#assertManagementInvocationNotFailed(`review-${reviewIdentityDigest(reviewIdentity)}`);
        const reviewBudget = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
        if (reviewBudget.modelTokens !== null && reviewBudget.modelTokens <= 0) {
          throw new Error("model-token budget is exhausted; refusing semantic review");
        }
        const reviewModel = resolveModelSelection(this.#policy, "review");
        invokeReview = (checkpoint) =>
          this.#externalAdmission(() =>
            this.#management.review(
              {
                repository: this.#options.repository,
                objectiveNumber: this.#run.objective,
                workItemNumber: item.number,
                packet,
                artifact,
                evidence: validation!.evidence,
                ...(reviewModel ? { modelSelection: reviewModel } : {}),
              },
              checkpoint,
            ),
          );
      }
      await runDurableReviewTransaction({
        existing: existingReview,
        ...(invokeReview ? { invoke: invokeReview } : {}),
        persist: (result) =>
          this.#lease.use((lease) =>
            this.#reviews.persist({ lease, identity: reviewIdentity, result }),
          ),
        recover: () => this.#reviews.load(reviewIdentity),
        recordFailureUsage: (usage) =>
          this.#recordFailedManagementUsage(
            `review-${reviewIdentityDigest(reviewIdentity)}`,
            usage,
            item.id,
            reservation!,
          ),
        recordUsage: (record) => this.#recordReviewUsage(record, item, reservation!),
        recordOutcome: (record) => this.#recordInitialReviewOutcome(record, item, reservation!),
      });
      await this.#lease.assertGeneration("publication");
      if (selected.capabilities.providerManagedPublication) {
        const pullNumber = Number(handle.metadata?.pullNumber);
        const headSha = handle.metadata?.headSha;
        if (!Number.isInteger(pullNumber) || pullNumber <= 0 || !headSha) {
          throw new Error("managed backend did not identify its pull request");
        }
        const remoteHead = await this.#store.readCommit(headSha);
        if (remoteHead.treeOid !== validation.evidence.outputTreeSha) {
          throw new Error("managed pull request head does not match the validated output tree");
        }
        published = {
          branch: `github-managed/pr-${pullNumber}`,
          commitSha: headSha,
          number: pullNumber,
          htmlUrl: `https://github.com/${this.#options.owner}/${this.#options.repo}/pull/${pullNumber}`,
          exactHeadValidation: bindValidationToPublishedHead({
            validation: validation.evidence,
            publishedHeadSha: headSha,
            publishedTreeSha: remoteHead.treeOid,
            publishedBaseSha: validation.evidence.baseSha,
          }),
        };
      } else {
        published = await publishValidated({
          store: this.#store,
          assertLease: () => this.#lease.assertGeneration("publication"),
          base,
          validation,
          artifact,
          objective: this.#run.objective,
          workItem: item.number,
          attempt: reservation.attempt,
          title: item.title,
          baseBranch: publicationBaseBranch,
        });
      }
      if (!published) throw new Error("publication did not return a pull request");
      const publication = published;
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          event: "AttemptPublished",
          sequence: this.#sequences.take(),
          artifactDigest: artifact.digest,
          headSha: publication.commitSha,
        }),
      );
      const metadata = parseGraphItemMetadata(item.body ?? "");
      const itemPlan = this.#deliveryPlan?.items.find(
        (candidate) => candidate.itemId === metadata.id,
      );
      const receipt: PublicationReceipt = {
        protocol: PUBLICATION_RECEIPT_PROTOCOL,
        runId: this.#run.runId,
        unitId: itemPlan?.unitId ?? `delivery/${metadata.id}`,
        itemId: metadata.id,
        workItem: item.number,
        attempt: reservation.attempt,
        revision: 1,
        mode:
          this.#deliverySelection.selected === "native-stacks" ? "native-stacks" : "regular-prs",
        position: itemPlan?.position ?? 0,
        ...(itemPlan?.parentItemId ? { parentItemId: itemPlan.parentItemId } : {}),
        branch: publication.branch,
        baseBranch: publicationBaseBranch,
        baseSha: validation.evidence.baseSha,
        headSha: publication.commitSha,
        pullRequest: publication.number,
        capabilityVersion: this.#deliverySelection.capabilityVersion,
        exactHeadValidation: publication.exactHeadValidation,
        state: "published",
      };
      await this.#lease.use((lease) =>
        this.#recorder.publication({
          lease,
          workItemNodeId: item.id,
          sequence: this.#sequences.take(),
          receipt,
          event: "PublicationRecorded",
        }),
      );
      if (this.#deliverySelection.selected !== "native-stacks") {
        await this.#integrate(item, reservation, publication, objectiveDeadline);
      }
      this.#retryArtifacts.delete(item.number);
    } catch (error) {
      if (
        retryableArtifact &&
        validation &&
        selected &&
        selected.capabilities.hostExecution &&
        !selected.capabilities.providerManagedPublication
      ) {
        this.#retryArtifacts.set(item.number, retryableArtifact);
      }
      const cancellation =
        error instanceof RunCancellationRequestedError || executionSignal?.aborted;
      if (
        backendLaunchAttempted &&
        !handle &&
        !executionCleanupConfirmed &&
        selected &&
        reservation
      ) {
        if (!selected.reconcileStale) {
          throw new Error(
            `backend ${selected.capabilities.id} launch failed before returning a handle and cannot prove that no resource was created; automated replacement is blocked`,
          );
        }
        try {
          await selected.reconcileStale({
            repository: `${this.#options.owner}/${this.#options.repo}`,
            objective: reservation.objective,
            workItem: reservation.workItem,
            attempt: reservation.attempt,
            runId: reservation.runId,
            directorEpoch: reservation.directorEpoch,
            phase: "execution",
            ...(noHandleReplacementNotBefore ? { noHandleReplacementNotBefore } : {}),
          });
          executionCleanupConfirmed = true;
        } catch (reconcileError) {
          throw new Error(
            `backend ${selected.capabilities.id} launch failed before returning a handle; automated replacement is blocked because absence could not be proven: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
          );
        }
      }
      const stopRequested = cancellation || error instanceof PlatformUnavailableError;
      let cancelledModelUsageObserved = false;
      if (stopRequested && handle && selected && !executionCleanupConfirmed) {
        try {
          await selected.cancel(handle);
        } catch (cancelError) {
          this.#notify(
            `backend cancellation did not confirm absence; cleanup reconciliation will decide: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
          );
        }
        if (terminalModelTokens === undefined && selected.capabilities.reportsModelUsage) {
          try {
            // Cancellation drains some backends' terminal stream. Read any real
            // counters before cleanup discards the handle; absence stays unknown.
            const observation = await selected.observe(handle);
            if (["succeeded", "failed", "cancelled"].includes(observation.state)) {
              terminalModelUsage = reportedModelUsage(observation.usage);
              const tokens = reportedModelTokens(observation.usage);
              if (tokens !== null) {
                terminalModelTokens = tokens;
                cancelledModelUsageObserved = true;
              }
            }
          } catch (observationError) {
            this.#notify(
              `cancelled backend usage is unavailable: ${observationError instanceof Error ? observationError.message : String(observationError)}`,
            );
          }
        }
      }
      let cancelledUsageWriteFailure: { error: unknown } | undefined;
      if (
        cancelledModelUsageObserved &&
        reservation &&
        !(error instanceof PlatformUnavailableError) &&
        !(error instanceof LeaseLostError)
      ) {
        try {
          await this.#lease.use(async (lease) => {
            const event = await this.#recorder.budget({
              lease,
              workItemNodeId: item.id,
              reservation: reservation!,
              sequence: this.#sequences.take(),
              event: "BudgetReconciled",
              unit: "model_tokens",
              phase: "execution",
              amount: terminalModelTokens!,
              usageId: `worker-${item.number}-${reservation!.attempt}`,
              ...(terminalModelUsage ? { reportedModelUsage: terminalModelUsage } : {}),
            });
            this.#budgetEvents.push(event);
          });
        } catch (usageError) {
          // Accounting is independent of resource absence. Always attempt
          // cleanup, but never turn a failed fenced receipt into permission
          // to finish or replace this attempt.
          cancelledUsageWriteFailure = { error: usageError };
        }
      }
      await confirmExecutionCleanup("failed-attempt backend cleanup");
      if (error instanceof DaytonaResourceCleanupError && validationCapacity) {
        if (!reservation || !validator?.reconcileStale) {
          throw new Error(
            `validation cleanup was not confirmed and no stale-resource reconciler is available; automated replacement is blocked: ${error.message}`,
          );
        }
        try {
          await validator.reconcileStale({
            repository: `${this.#options.owner}/${this.#options.repo}`,
            objective: reservation.objective,
            workItem: reservation.workItem,
            attempt: reservation.attempt,
            runId: reservation.runId,
            directorEpoch: reservation.directorEpoch,
            phase: "validation",
            ...(validationNoHandleReplacementNotBefore
              ? {
                  noHandleReplacementNotBefore: validationNoHandleReplacementNotBefore,
                }
              : {}),
          });
        } catch (reconcileError) {
          throw new Error(
            `validation cleanup was not confirmed; automated replacement is blocked because the validator may still be billable. Cleanup error: ${error.message}. Reconciliation error: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
          );
        }
      }
      if (
        error instanceof PlatformUnavailableError ||
        error instanceof LeaseLostError ||
        error instanceof NoExecutionBackendError
      ) {
        throw error;
      }
      if (cancelledUsageWriteFailure) throw cancelledUsageWriteFailure.error;
      const reason = error instanceof Error ? error.message : String(error);
      if (!published && selected?.capabilities.providerManagedPublication) {
        const managedPull = Number(handle?.metadata?.pullNumber);
        if (Number.isInteger(managedPull) && managedPull > 0) {
          try {
            await this.#store.closePullRequest(managedPull);
          } catch (closeError) {
            throw new Error(
              `pull request #${managedPull} could not be closed; automated replacement is blocked: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
            );
          }
        }
      }
      if (published && this.#deliverySelection.selected === "native-stacks" && !cancellation) {
        this.#notify(
          `Work Item #${item.number} publication will be reconciled from GitHub: ${reason}`,
        );
        return;
      }
      if (published) {
        const current = await this.#store.readPullRequest(published.number).catch(() => null);
        if (current?.merged) throw error;
        try {
          await this.#store.closePullRequest(published.number);
        } catch (closeError) {
          throw new Error(
            `published pull request #${published.number} could not be closed; automated replacement is blocked: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          );
        }
      }
      if (reservation) {
        if (validationCapacity && validationCapacityRecorded && !validationCapacityReconciled) {
          await this.#lease
            .use(async (lease) => {
              await this.#attempts.recordCapacity({
                lease,
                workItemNodeId: item.id,
                reservation: reservation!,
                sequence: this.#sequences.take(),
                event: "CapacityReconciled",
                phase: "validation",
                backend: validationCapacity!.backendId,
                requestedCpu: validationCapacity!.cpu,
                requestedMemoryMb: validationCapacity!.memoryMb,
                reason: "validation ended before its normal capacity receipt",
              });
              validationCapacityReconciled = true;
            })
            .catch(() => {});
        }
        if (executionBudgetReserved && !executionBudgetReconciled) {
          await this.#lease.use(async (lease) => {
            const event = await this.#recorder.budget({
              lease,
              workItemNodeId: item.id,
              reservation: reservation!,
              sequence: this.#sequences.take(),
              event: "BudgetReconciled",
              unit: budgetUnit,
              amount: budgetUnit === "managed_sessions" ? 1 : Date.now() - started,
            });
            this.#budgetEvents.push(event);
            executionBudgetReconciled = true;
          });
        }
        if (validationBudgetReserved && !validationBudgetReconciled && validationBudgetUnit) {
          const unit = validationBudgetUnit;
          await this.#lease.use(async (lease) => {
            const event = await this.#recorder.budget({
              lease,
              workItemNodeId: item.id,
              reservation: reservation!,
              sequence: this.#sequences.take(),
              event: "BudgetReconciled",
              unit,
              phase: "validation",
              amount: validationStartedAt
                ? unit === "managed_sessions"
                  ? 1
                  : Date.now() - validationStartedAt
                : 0,
            });
            this.#budgetEvents.push(event);
            validationBudgetReconciled = true;
          });
        }
        await this.#lease.use((lease) =>
          this.#attempts.record({
            lease,
            workItemNodeId: item.id,
            reservation: reservation!,
            event: cancellation ? "AttemptCancelled" : "AttemptFailed",
            sequence: this.#sequences.take(),
            reason,
            ...(backendLaunchAttempted && terminalModelProfile
              ? { modelProfile: terminalModelProfile }
              : {}),
            ...(terminalModelTokens === undefined
              ? {}
              : { reportedModelTokens: terminalModelTokens }),
            ...(terminalModelUsage ? { reportedModelUsage: terminalModelUsage } : {}),
          }),
        );
      } else {
        throw error;
      }
      if (cancellation) throw new RunCancellationRequestedError(reason);
      this.#notify(`Work Item #${item.number} failed: ${reason}`);
    } finally {
      if (executionSignal?.aborted && handle && selected && !executionCleanupConfirmed) {
        try {
          await selected.cancel(handle);
        } catch (cancelError) {
          this.#notify(
            `shutdown cancellation did not confirm absence: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
          );
        }
      }
      let finalizationError: unknown;
      try {
        await confirmExecutionCleanup("final backend cleanup");
      } catch (error) {
        finalizationError = error;
      }
      try {
        if (worker) await cleanupLocalWorktree(worker);
        if (validation) await discardValidationResult(validation);
      } catch (error) {
        finalizationError ??= error;
      } finally {
        if (validationCapacity) this.#capacity.release(validationCapacity.key);
      }
      // biome-ignore lint/correctness/noUnsafeFinally: uncertain cleanup must override success so Factory cannot launch a duplicate paid or local worker
      if (finalizationError) throw finalizationError;
    }
  }

  #reviewUsageId(record: ReviewCheckpointRecord): string {
    const prefix =
      record.identity.kind === "integration-candidate"
        ? "integration-review"
        : record.identity.kind === "rebase"
          ? "rebase-review"
          : "review";
    return `${prefix}-${record.identityDigest}`;
  }

  #assertManagementInvocationNotFailed(invocationId: string): void {
    assertManagementInvocationNotFailed(this.#budgetEvents, this.#run.runId, invocationId);
  }

  async #recordFailedManagementUsage(
    invocationId: string,
    usage: ManagementUsage,
    nodeId: string,
    reservation?: AttemptReservation,
  ): Promise<void> {
    const usageId = `failed-${invocationId}`;
    const amount = usage.inputTokens + usage.outputTokens;
    const matches = (events: readonly FactoryEvent[]) =>
      events.filter(
        (event) =>
          event.kind === "budget" &&
          event.runId === this.#run.runId &&
          event.event === "BudgetReconciled" &&
          event.phase === "management" &&
          event.unit === "model_tokens" &&
          event.usageId === usageId &&
          event.workItem === reservation?.workItem &&
          event.attempt === reservation?.attempt,
      );
    const existing = matches(this.#budgetEvents);
    if (existing.some((event) => event.amount !== amount)) {
      throw new Error("failed management usage conflicts with its budget receipt");
    }
    if (existing.length > 0) return;
    try {
      const event = await this.#lease.use((lease) => {
        const common = {
          lease,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled" as const,
          unit: "model_tokens" as const,
          amount,
          usageId,
          reportedModelUsage: reportedModelUsage(usage)!,
        };
        return reservation
          ? this.#recorder.budget({ ...common, reservation, workItemNodeId: nodeId })
          : this.#recorder.objectiveBudget({ ...common, objectiveNodeId: nodeId });
      });
      this.#budgetEvents.push(event);
    } catch (error) {
      const snapshot = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(snapshot);
      const recovered = matches(snapshotEvents(snapshot));
      if (recovered.some((event) => event.amount !== amount)) {
        throw new Error("failed management usage conflicts with its recovered receipt");
      }
      if (recovered.length === 0) throw error;
      this.#sequences.observe(snapshotEvents(snapshot));
      this.#budgetEvents.push(...recovered);
    }
  }

  async #recordReviewUsage(
    record: ReviewCheckpointRecord,
    item: DerivedWorkItem,
    reservation: AttemptReservation,
  ): Promise<void> {
    const usageId = this.#reviewUsageId(record);
    const amount = record.usage.inputTokens + record.usage.outputTokens;
    const matches = (events: readonly FactoryEvent[]) =>
      events.filter(
        (event) =>
          event.kind === "budget" &&
          event.runId === reservation.runId &&
          event.workItem === reservation.workItem &&
          event.attempt === reservation.attempt &&
          event.event === "BudgetReconciled" &&
          event.phase === "management" &&
          event.unit === "model_tokens" &&
          event.usageId === usageId,
      );
    const existing = matches(this.#budgetEvents);
    if (existing.some((event) => event.amount !== amount)) {
      throw new Error("semantic review usage conflicts with its durable checkpoint");
    }
    if (existing.length > 0) return;
    try {
      const event = await this.#lease.use((lease) =>
        this.#recorder.budget({
          lease,
          workItemNodeId: item.id,
          reservation,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled",
          unit: "model_tokens",
          amount,
          usageId,
          reportedModelUsage: reportedModelUsage(record.usage)!,
        }),
      );
      this.#budgetEvents.push(event);
    } catch (error) {
      const snapshot = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(snapshot);
      const recovered = matches(snapshotEvents(snapshot));
      if (recovered.some((event) => event.amount !== amount)) {
        throw new Error("semantic review usage conflicts with its recovered receipt");
      }
      if (recovered.length === 0) throw error;
      this.#sequences.observe(snapshotEvents(snapshot));
      for (const event of recovered) {
        if (
          !this.#budgetEvents.some(
            (candidate) =>
              candidate.kind === "budget" &&
              candidate.runId === event.runId &&
              candidate.sequence === event.sequence,
          )
        ) {
          this.#budgetEvents.push(event);
        }
      }
    }
  }

  async #recordInitialReviewOutcome(
    record: ReviewCheckpointRecord,
    item: DerivedWorkItem,
    reservation: AttemptReservation,
  ): Promise<void> {
    if (!record.review.accepted) {
      throw new Error(
        `semantic review rejected: ${record.review.summary}; ${record.review.unmetCriteria.join("; ")}`,
      );
    }
    const matches = (events: readonly FactoryEvent[]) =>
      events.some(
        (event) =>
          event.kind === "attempt" &&
          event.runId === reservation.runId &&
          event.workItem === reservation.workItem &&
          event.attempt === reservation.attempt &&
          event.event === "AttemptValidated" &&
          event.artifactDigest === record.identity.artifactDigest,
      );
    if (matches(item.factoryEvents ?? [])) return;
    try {
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation,
          event: "AttemptValidated",
          sequence: this.#sequences.take(),
          artifactDigest: record.identity.artifactDigest,
          reason: record.review.summary,
          allowRecovery: reservation.directorEpoch !== lease.epoch,
        }),
      );
    } catch (error) {
      const snapshot = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(snapshot);
      if (!matches(snapshotEvents(snapshot))) throw error;
      this.#sequences.observe(snapshotEvents(snapshot));
    }
  }

  async #recordRebaseReviewOutcome(
    record: ReviewCheckpointRecord,
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    validation: Pick<CleanValidationResult, "evidence">,
    receipt: PublicationReceipt,
  ): Promise<void> {
    if (!record.review.accepted) {
      throw new Error(
        `rebased semantic review rejected: ${record.review.summary}; ${record.review.unmetCriteria.join("; ")}`,
      );
    }
    let events = [...(item.factoryEvents ?? [])];
    const ensure = async (
      matches: (event: FactoryEvent) => boolean,
      write: () => Promise<FactoryEvent>,
    ): Promise<void> => {
      if (events.some(matches)) return;
      try {
        events.push(await write());
      } catch (error) {
        const snapshot = await this.#reader.readObjective(this.#run.objective);
        this.#fenceSnapshot(snapshot);
        this.#sequences.observe(snapshotEvents(snapshot));
        events =
          snapshot.workItems.find((candidate) => candidate.number === item.number)?.factoryEvents ??
          [];
        if (!events.some(matches)) throw error;
      }
    };
    await ensure(
      (event) =>
        event.kind === "validation" &&
        event.runId === reservation.runId &&
        event.workItem === reservation.workItem &&
        event.attempt === reservation.attempt &&
        event.evidenceDigest === validation.evidence.digest,
      () =>
        this.#lease.use((lease) =>
          this.#recorder.validation({
            lease,
            workItemNodeId: item.id,
            reservation,
            evidence: validation.evidence,
            sequence: this.#sequences.take(),
          }),
        ),
    );
    await ensure(
      (event) =>
        event.kind === "attempt" &&
        event.runId === reservation.runId &&
        event.workItem === reservation.workItem &&
        event.attempt === reservation.attempt &&
        event.event === "AttemptValidated" &&
        event.artifactDigest === record.identity.artifactDigest,
      () =>
        this.#lease.use((lease) =>
          this.#attempts.record({
            lease,
            workItemNodeId: item.id,
            reservation,
            event: "AttemptValidated",
            sequence: this.#sequences.take(),
            artifactDigest: record.identity.artifactDigest,
            reason: record.review.summary,
            allowRecovery: true,
          }),
        ),
    );
    await ensure(
      (event) =>
        event.kind === "attempt" &&
        event.runId === reservation.runId &&
        event.workItem === reservation.workItem &&
        event.attempt === reservation.attempt &&
        event.event === "AttemptPublished" &&
        event.headSha === receipt.headSha,
      () =>
        this.#lease.use((lease) =>
          this.#attempts.record({
            lease,
            workItemNodeId: item.id,
            reservation,
            event: "AttemptPublished",
            sequence: this.#sequences.take(),
            artifactDigest: record.identity.artifactDigest,
            headSha: receipt.headSha,
            allowRecovery: true,
          }),
        ),
    );
    await ensure(
      (event) =>
        event.kind === "publication" &&
        event.runId === reservation.runId &&
        event.workItem === reservation.workItem &&
        event.attempt === reservation.attempt &&
        event.event === "PublicationRecorded" &&
        event.headSha === receipt.headSha &&
        event.exactHeadValidationDigest === receipt.exactHeadValidation.digest,
      () =>
        this.#lease.use((lease) =>
          this.#recorder.publication({
            lease,
            workItemNodeId: item.id,
            sequence: this.#sequences.take(),
            receipt,
            event: "PublicationRecorded",
            reason: "revalidated after cascading stack rebase",
          }),
        ),
    );
  }

  async #preflightCompiledGraph(graph: CompiledObjective): Promise<void> {
    const budgets = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
    for (const item of graph.workItems) {
      const packet = workerPacketFromCompiled(item);
      const requirements = {
        ...packet.requirements,
        ...(this.#policy.trust === "sandbox_untrusted" &&
        packet.requirements.trust === "trusted_local"
          ? { trust: "isolated" as const }
          : {}),
      };
      const timeoutMs =
        (requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000;
      const unit = this.#deliveryPlan?.units.find((unit) => unit.items.includes(item.id));
      const isolatedNativeUnit =
        this.#deliverySelection.selected === "native-stacks" &&
        unit &&
        (unit.kind === "stack" || (unit.kind === "sibling" && unit.items.length === 1));
      const execution = await this.#registry.select({
        policy: isolatedNativeUnit
          ? {
              ...this.#policy,
              backendOrder: this.#policy.backendOrder.filter(
                (id) =>
                  id === "codex-cli/daytona" || this.#registry.get(id)?.capabilities.hostExecution,
              ),
            }
          : this.#policy,
        requirements,
        budget: budgets,
        estimatedDurationMs: timeoutMs,
        requireHostExecution:
          this.#deliverySelection.selected === "native-stacks" && !isolatedNativeUnit,
      });
      if (requirements.trust !== "trusted_local" || !execution.backend.capabilities.hostExecution) {
        const afterExecution = {
          ...budgets,
          sandboxMinutes:
            budgets.sandboxMinutes -
            (execution.backend.capabilities.id.includes("daytona") ||
            execution.backend.capabilities.id.includes("vercel-sandbox")
              ? timeoutMs / 60_000
              : 0),
          managedAgentSessions:
            budgets.managedAgentSessions -
            (execution.backend.capabilities.runtimeKind === "github-managed" ? 1 : 0),
        };
        await this.#registry.selectIsolatedValidator({
          policy: this.#policy,
          requirements,
          budget: afterExecution,
          estimatedDurationMs: timeoutMs,
        });
      }
    }
  }

  #packetFor(workItem: number): WorkerPacket {
    const packet = this.#durablePackets.get(workItem);
    if (!packet) {
      throw new Error(`Work Item #${workItem} has no immutable compiled Worker Packet`);
    }
    return packet;
  }

  #fenceSnapshot(snapshot: Snapshot): void {
    if (!this.#compiledGraph) return;
    if (!this.#compiledProjection) {
      throw new Error("immutable compiled graph has no durable GitHub issue projection");
    }
    this.#durablePackets = assertSnapshotMatchesCompiledGraph(
      this.#compiledGraph,
      snapshot,
      this.#compiledProjection.bindings,
    );
    assertAuthenticatedGraphProjection(
      snapshotEvents(snapshot),
      snapshot.number,
      this.#recoveryRuntime?.planRecord.plan.graph.sourceRunId ?? this.#run.runId,
      this.#compiledProjection,
    );
  }

  async #nativeStackMember(
    item: DerivedWorkItem,
    requireRecordedPublication = false,
  ): Promise<NativeStackMember> {
    const runtime = this.#recoveryRuntime;
    const planned = runtime?.planRecord.plan.items.find((entry) => entry.workItem === item.number);
    if (runtime && planned?.source && planned.action !== "execute") {
      const source = planned.source;
      const restored = runtime.sourcePublications.find(
        (proof) => proof.publication.workItem === item.number,
      );
      const publication =
        source.publication ??
        (restored
          ? recoverySourcePublicationBinding(
              restored.publication,
              runtime.planRecord.plan.repository,
            )
          : null);
      if (!publication || !source.validation)
        throw new Error("native retained source is not published");
      const commit = await this.#store.readCommit(publication.headSha);
      if (commit.parentOids.length !== 1 || commit.parentOids[0] !== source.validation.baseSha)
        throw new Error("native retained source ancestry changed");
      const exactHeadValidation = bindValidationToPublishedHead({
        validation: {
          passed: true,
          digest: source.validation.evidenceDigest,
          baseSha: source.validation.baseSha,
          outputTreeSha: source.validation.outputTreeSha,
        },
        publishedHeadSha: publication.headSha,
        publishedTreeSha: commit.treeOid,
        publishedBaseSha: source.validation.baseSha,
      });
      const reservation = (await this.#attempts.list(this.#run.objective, item.number)).find(
        (entry) => entry.runId === source.runId && entry.attempt === source.attempt,
      );
      if (
        !reservation ||
        reservation.ref !== source.reservationRef ||
        reservation.oid !== source.reservationCommitOid
      )
        throw new Error("native retained source reservation changed");
      const observed = await this.#store.readPullRequest(publication.pullRequest);
      const plan = this.#deliveryPlan?.items.find((entry) => entry.itemId === planned.compilerId);
      if (
        !plan ||
        observed.nodeId !== publication.pullRequestNodeId ||
        observed.headRef !== publication.branch
      )
        throw new Error("native retained source PR identity changed");
      return {
        reservation,
        receipt: {
          protocol: PUBLICATION_RECEIPT_PROTOCOL,
          runId: source.runId,
          unitId: plan.unitId,
          itemId: planned.compilerId,
          workItem: item.number,
          attempt: source.attempt,
          revision: 1,
          mode: "native-stacks",
          position: plan.position,
          ...(plan.parentItemId ? { parentItemId: plan.parentItemId } : {}),
          branch: publication.branch,
          baseBranch: publication.baseBranch,
          baseSha: publication.baseSha,
          headSha: publication.headSha,
          pullRequest: publication.pullRequest,
          ...(publication.stackNumber ? { stackNumber: publication.stackNumber } : {}),
          capabilityVersion: this.#deliverySelection.capabilityVersion,
          exactHeadValidation,
          state: "published",
        },
        pull: {
          number: publication.pullRequest,
          branch: publication.branch,
          commitSha: publication.headSha,
          htmlUrl: "",
          exactHeadValidation,
        },
        observedHeadSha: observed.headSha,
      };
    }
    // A completed publication receipt is the commit point for a rebase. Validation and
    // AttemptPublished may have been written before a lost final publication response.
    // Replay the prior complete binding until that exact checkpoint transaction repairs it.
    const recordedPublication = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
          event.kind === "publication" &&
          event.runId === this.#run.runId &&
          event.workItem === item.number &&
          event.event === "PublicationRecorded",
      );
    const publishedEvent = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (event) =>
          event.kind === "attempt" &&
          event.runId === this.#run.runId &&
          event.event === "AttemptPublished" &&
          (!recordedPublication ||
            (event.headSha === recordedPublication.headSha &&
              event.attempt === recordedPublication.attempt)) &&
          Boolean(event.headSha),
      );
    if (!publishedEvent || publishedEvent.kind !== "attempt" || !publishedEvent.headSha) {
      throw new Error(`stack Work Item #${item.number} has no published head receipt`);
    }
    const validation = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (event) =>
          event.kind === "validation" &&
          event.runId === this.#run.runId &&
          event.attempt === publishedEvent.attempt &&
          (recordedPublication
            ? event.evidenceDigest === recordedPublication.validationDigest
            : event.sequence <= publishedEvent.sequence) &&
          event.passed,
      );
    if (!validation || validation.kind !== "validation") {
      throw new Error(`stack Work Item #${item.number} has no passing validation receipt`);
    }
    const metadata = parseGraphItemMetadata(item.body ?? "");
    const plan = this.#deliveryPlan?.items.find((candidate) => candidate.itemId === metadata.id);
    if (!plan) throw new Error(`Work Item ${metadata.id} is absent from the delivery plan`);
    const branch = publicationBranch(this.#run.objective, item.number, publishedEvent.attempt);
    const found = await this.#store.findPullRequestForBranch(branch);
    if (!found) throw new Error(`stack publication branch ${branch} has no pull request`);
    const commit = await this.#store.readCommit(publishedEvent.headSha);
    if (commit.parentOids.length !== 1 || commit.parentOids[0] !== validation.baseSha) {
      throw new Error(
        `stack Work Item #${item.number} published commit does not descend from its validated base`,
      );
    }
    const exactHeadValidation = bindValidationToPublishedHead({
      validation: {
        passed: validation.passed,
        digest: validation.evidenceDigest,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
      },
      publishedHeadSha: publishedEvent.headSha,
      publishedTreeSha: commit.treeOid,
      publishedBaseSha: validation.baseSha,
    });
    const reservation = (await this.#attempts.list(this.#run.objective, item.number)).find(
      (candidate) =>
        candidate.runId === this.#run.runId && candidate.attempt === publishedEvent.attempt,
    );
    if (!reservation) {
      throw new Error(`stack Work Item #${item.number} has no attempt reservation`);
    }
    const publicationEvent = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
          event.kind === "publication" &&
          event.runId === this.#run.runId &&
          event.event === "PublicationRecorded" &&
          event.itemId === metadata.id &&
          event.headSha === publishedEvent.headSha,
      );
    const baseBranch =
      publicationEvent?.kind === "publication" ? publicationEvent.baseBranch : this.#baseBranch;
    if (!publicationEvent && (plan.parentItemId || requireRecordedPublication)) {
      throw new Error(`stack Work Item ${metadata.id} is missing its publication receipt`);
    }
    const receipt: PublicationReceipt = {
      protocol: PUBLICATION_RECEIPT_PROTOCOL,
      runId: this.#run.runId,
      unitId: plan.unitId,
      itemId: metadata.id,
      workItem: item.number,
      attempt: publishedEvent.attempt,
      revision: 1,
      mode: "native-stacks",
      position: plan.position,
      ...(plan.parentItemId ? { parentItemId: plan.parentItemId } : {}),
      branch,
      baseBranch,
      baseSha: validation.baseSha,
      headSha: publishedEvent.headSha,
      pullRequest: found.number,
      capabilityVersion: this.#deliverySelection.capabilityVersion,
      exactHeadValidation,
      state: "published",
    };
    if (!publicationEvent) {
      await this.#lease.use((lease) =>
        this.#recorder.publication({
          lease,
          workItemNodeId: item.id,
          sequence: this.#sequences.take(),
          receipt,
          event: "PublicationRecorded",
          reason: "recovered publication receipt",
        }),
      );
    } else {
      assertPublicationEventMatchesReceipt(publicationEvent, receipt);
    }
    return {
      receipt,
      pull: {
        branch,
        commitSha: publishedEvent.headSha,
        number: found.number,
        htmlUrl: found.htmlUrl,
        exactHeadValidation,
      },
      reservation,
      observedHeadSha: found.headSha,
    };
  }

  async #integrateNativeStack(
    unitId: string,
    items: DerivedWorkItem[],
    deadline: number,
  ): Promise<boolean> {
    if (items.some((item) => !this.#integrationDue(item.number))) return false;
    const ordered = [...items].sort((left, right) => {
      const leftId = parseGraphItemMetadata(left.body ?? "").id;
      const rightId = parseGraphItemMetadata(right.body ?? "").id;
      const leftPosition =
        this.#deliveryPlan?.items.find((candidate) => candidate.itemId === leftId)?.position ?? 0;
      const rightPosition =
        this.#deliveryPlan?.items.find((candidate) => candidate.itemId === rightId)?.position ?? 0;
      return leftPosition - rightPosition;
    });
    const remaining = ordered.filter((item) => {
      if (item.state === "for_review") return true;
      if (item.state !== "done") return false;
      const published = [...(item.factoryEvents ?? [])]
        .sort((a, b) => b.sequence - a.sequence)
        .find(
          (event) =>
            event.kind === "attempt" &&
            event.runId === this.#run.runId &&
            event.event === "AttemptPublished",
        );
      return (
        published?.kind === "attempt" &&
        !(item.factoryEvents ?? []).some(
          (event) =>
            event.kind === "attempt" &&
            event.runId === this.#run.runId &&
            event.event === "AttemptIntegrated" &&
            event.attempt === published.attempt,
        )
      );
    });
    if (remaining.length === 0) return false;
    const members = await Promise.all(ordered.map((item) => this.#nativeStackMember(item)));
    if (
      members.some(
        (member) =>
          member.reservation.runId !== this.#run.runId &&
          remaining.some((item) => item.number === member.receipt.workItem),
      )
    )
      throw new Error("retained native sources require successor-owned integration outcomes");
    const mergePolicy = this.#policy.delivery?.merge ?? "bottom-up";
    const target =
      mergePolicy === "atomic-stack"
        ? members.at(-1)!
        : members.find((member) =>
            remaining.some((item) => item.number === member.receipt.workItem),
          )!;
    const operationId =
      `stack-${this.#run.objective}-` +
      `${unitId.replace(/[^a-z0-9-]/gi, "-")}-${target.receipt.attempt}`;

    const completeIntegrated = async (integrated: readonly NativeStackMember[]): Promise<void> => {
      for (const member of integrated) {
        if (member.reservation.runId !== this.#run.runId)
          throw new Error("cannot rewrite retained native source attempt history");
        const current = await this.#store.readPullRequest(member.pull.number);
        if (!current.merged || !current.mergeCommitSha) {
          throw new Error(
            `GitHub reported stack merge before PR #${member.pull.number} was merged`,
          );
        }
        if (current.headSha !== member.pull.commitSha) {
          throw new Error(
            `merged stack Work Item ${member.receipt.itemId} differs from its validated head`,
          );
        }
        const memberIndex = members.findIndex(
          (candidate) => candidate.receipt.itemId === member.receipt.itemId,
        );
        let expectedParentSha = member.receipt.baseSha;
        if (memberIndex > 0) {
          const previous = await this.#store.readPullRequest(members[memberIndex - 1]!.pull.number);
          if (!previous.merged || !previous.mergeCommitSha) {
            throw new Error(
              `stack predecessor for ${member.receipt.itemId} has no proven merge commit`,
            );
          }
          expectedParentSha = previous.mergeCommitSha;
        }
        try {
          await verifySquashIntegration(
            this.#store,
            member.pull,
            current.mergeCommitSha,
            expectedParentSha,
          );
        } catch (error) {
          throw new Error(
            `irreversible stack merge for ${member.receipt.itemId} did not preserve validated state: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const item = ordered.find((candidate) => candidate.number === member.receipt.workItem)!;
        const completion = [...(item.factoryEvents ?? [])]
          .sort((left, right) => right.sequence - left.sequence)
          .find(
            (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
              event.kind === "publication" &&
              event.runId === this.#run.runId &&
              event.event === "IntegrationCompleted" &&
              event.operationId === operationId &&
              event.headSha === member.receipt.headSha,
          );
        if (completion) {
          assertPublicationEventMatchesReceipt(completion, member.receipt);
        } else {
          await this.#lease.use((lease) =>
            this.#recorder.publication({
              lease,
              workItemNodeId: item.id,
              sequence: this.#sequences.take(),
              receipt: member.receipt,
              event: "IntegrationCompleted",
              operationId,
            }),
          );
        }
        const alreadyRecorded = (item.factoryEvents ?? []).some(
          (event) =>
            event.kind === "attempt" &&
            event.runId === member.reservation.runId &&
            event.event === "AttemptIntegrated" &&
            event.attempt === member.reservation.attempt,
        );
        if (!alreadyRecorded) {
          await this.#lease.use((lease) =>
            this.#attempts.record({
              lease,
              workItemNodeId: item.id,
              reservation: member.reservation,
              event: "AttemptIntegrated",
              sequence: this.#sequences.take(),
              headSha: current.mergeCommitSha!,
              allowRecovery: true,
            }),
          );
        }
        await this.#lease.assertGeneration("integration");
        if (!item.closed) await this.#store.closeIssue(item.number);
      }
    };

    const firstChanged = members.findIndex(
      (member, index) =>
        ordered[index]!.state === "for_review" && member.observedHeadSha !== member.pull.commitSha,
    );
    if (firstChanged >= 0) {
      const changed = members[firstChanged]!;
      for (let index = firstChanged; index < members.length; index += 1) {
        if (ordered[index]!.state !== "for_review") continue;
        const member = members[index]!;
        const current = await this.#store.readPullRequest(member.pull.number);
        const invalidated: PublicationReceipt = {
          ...member.receipt,
          revision: member.receipt.revision + 1,
          state: "validation-invalidated",
          invalidatedByItem: changed.receipt.itemId,
          invalidatedByHeadSha: changed.observedHeadSha,
        };
        const alreadyInvalidated = (ordered[index]!.factoryEvents ?? []).find(
          (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
            event.kind === "publication" &&
            event.runId === this.#run.runId &&
            event.event === "ValidationInvalidated" &&
            event.itemId === member.receipt.itemId &&
            event.headSha === member.receipt.headSha &&
            event.invalidatedByHeadSha === changed.observedHeadSha,
        );
        if (alreadyInvalidated) {
          assertPublicationEventMatchesReceipt(alreadyInvalidated, invalidated);
        } else {
          await this.#lease.use((lease) =>
            this.#recorder.publication({
              lease,
              workItemNodeId: ordered[index]!.id,
              sequence: this.#sequences.take(),
              receipt: invalidated,
              event: "ValidationInvalidated",
              reason: `lower stack layer ${changed.receipt.itemId} changed head`,
            }),
          );
        }
        const expectedBaseRef =
          index === 0 || ordered[index - 1]!.state === "done"
            ? this.#baseBranch
            : members[index - 1]!.receipt.branch;
        const expectedBaseSha =
          index === 0 || ordered[index - 1]!.state === "done"
            ? (await this.#store.getBranchHead(this.#baseBranch)).oid
            : members[index - 1]!.observedHeadSha;
        if (current.baseRef !== expectedBaseRef || current.baseSha !== expectedBaseSha) {
          // GitHub's server-side cascading rebase is still settling. The
          // invalidation is already durable, so no stale head can integrate.
          return this.#deferIntegration(
            ordered[index]!.number,
            "waiting for GitHub's current cascading-rebase base",
          );
        }
        await this.#revalidateNativeStackMember(
          ordered[index]!,
          member,
          current.headSha,
          current.baseSha,
          current.baseRef,
        );
      }
      // Re-read durable heads and evidence on the next controller cycle.
      return true;
    }

    const mergedDuringRecovery: NativeStackMember[] = [];
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index]!;
      // A retained member keeps its ORIGINAL exact-head proof even when GitHub
      // rebased it before the successor integrated it. The verified successor
      // outcome, not relabelling that proof, accounts for its delivered head.
      if (member.reservation.runId !== this.#run.runId && ordered[index]!.state === "done")
        continue;
      const current = await this.#store.readPullRequest(member.pull.number);
      if (current.headSha !== member.pull.commitSha) {
        throw new Error(`stack Work Item ${member.receipt.itemId} changed after validation`);
      }
      const expectedBaseBranch =
        index === 0 || ordered[index - 1]!.state === "done"
          ? this.#baseBranch
          : members[index - 1]!.receipt.branch;
      if (current.baseRef !== expectedBaseBranch) {
        throw new Error(
          `stack Work Item ${member.receipt.itemId} targets ${current.baseRef}, expected ${expectedBaseBranch}`,
        );
      }
      if (ordered[index]!.state === "done" && !remaining.includes(ordered[index]!)) continue;
      if (current.merged) {
        mergedDuringRecovery.push(member);
        continue;
      }
      const readiness = await integrationReadiness(
        this.#store,
        member.pull,
        member.receipt.baseSha,
        undefined,
        { ciExpected: this.#ciExpectedOnPullRequests },
      );
      if (readiness.state === "wait") {
        if (Date.now() >= deadline) {
          throw new Error(`stack integration timed out: ${readiness.reason}`);
        }
        return this.#deferIntegration(member.receipt.workItem, readiness.reason);
      }
      if (readiness.state !== "ready") {
        throw new Error(
          readiness.state === "failed"
            ? readiness.reason
            : `stack member ${member.receipt.itemId} was already integrated unexpectedly`,
        );
      }
    }
    if (mergedDuringRecovery.length > 0) {
      await completeIntegrated(mergedDuringRecovery);
      return true;
    }

    const durableLinks = members.flatMap((member) => {
      const item = ordered.find((candidate) => candidate.number === member.receipt.workItem)!;
      return (item.factoryEvents ?? []).filter(
        (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
          event.kind === "publication" &&
          event.runId === this.#run.runId &&
          event.event === "StackLinked" &&
          event.unitId === unitId &&
          event.itemId === member.receipt.itemId &&
          event.headSha === member.receipt.headSha,
      );
    });
    for (const link of durableLinks) {
      const member = members.find((candidate) => candidate.receipt.itemId === link.itemId)!;
      assertPublicationEventMatchesReceipt(link, member.receipt);
    }
    const durableStackNumbers = new Set([
      ...durableLinks.flatMap((event) => (event.stackNumber ? [event.stackNumber] : [])),
      ...members.flatMap((member) => {
        const events =
          ordered.find((item) => item.number === member.receipt.workItem)!.factoryEvents ?? [];
        const original = events.filter(
          (event) =>
            event.kind === "publication" &&
            event.event === "PublicationRecorded" &&
            event.runId === member.reservation.runId &&
            event.attempt === member.reservation.attempt &&
            event.workItem === member.receipt.workItem &&
            event.unitId === unitId,
        );
        const numbers = events.flatMap((event) =>
          event.kind === "publication" &&
          event.stackNumber &&
          original.some(
            (publication) =>
              publication.kind === "publication" &&
              isNativePublicationStackLink(publication, event),
          )
            ? [event.stackNumber]
            : [],
        );
        if (member.reservation.runId !== this.#run.runId && member.receipt.stackNumber)
          numbers.push(member.receipt.stackNumber);
        return numbers;
      }),
    ]);
    if (durableStackNumbers.size > 1) {
      throw new Error("delivery unit has conflicting durable GitHub stack numbers");
    }
    const stack = await this.#serializeIntegration(async () => {
      await this.#lease.assertGeneration("integration");
      const stackNumber = [...durableStackNumbers][0];
      return stackNumber
        ? this.#stacks.get(stackNumber)
        : this.#stacks.ensureStack(members.map((member) => member.pull.number));
    });
    const observedPulls = stack.pullRequests.map((pull) => pull.number);
    const fullPulls = members.map((member) => member.pull.number);
    const remainingPulls = members
      .filter((member) => remaining.some((item) => item.number === member.receipt.workItem))
      .map((member) => member.pull.number);
    const suffix = verifiedNativeStackSuffix(
      fullPulls,
      fullPulls.filter((number) => !remainingPulls.includes(number)),
      observedPulls,
    );
    const verifiedSuffix = suffix && JSON.stringify(observedPulls) === JSON.stringify(suffix);
    if (JSON.stringify(observedPulls) !== JSON.stringify(fullPulls) && !verifiedSuffix) {
      throw new Error("GitHub stack topology differs from Factory's immutable delivery plan");
    }
    for (const member of members) {
      if (member.reservation.runId !== this.#run.runId) continue;
      const durableLink = durableLinks.find(
        (event) => event.itemId === member.receipt.itemId && event.stackNumber === stack.number,
      );
      if (durableLink) {
        member.receipt = {
          ...member.receipt,
          revision: member.receipt.revision + 1,
          state: "stack-linked",
          stackNumber: stack.number,
        };
        continue;
      }
      const linked: PublicationReceipt = {
        ...member.receipt,
        revision: member.receipt.revision + 1,
        state: "stack-linked",
        stackNumber: stack.number,
      };
      await this.#lease.use((lease) =>
        this.#recorder.publication({
          lease,
          workItemNodeId: ordered.find((item) => item.number === linked.workItem)!.id,
          sequence: this.#sequences.take(),
          receipt: linked,
          event: "StackLinked",
        }),
      );
      member.receipt = linked;
    }

    const targetItem = ordered.find((item) => item.number === target.receipt.workItem)!;
    const fencedMembers =
      mergePolicy === "atomic-stack"
        ? members.filter((member) =>
            remaining.some((item) => item.number === member.receipt.workItem),
          )
        : [target];
    const expectedHeads = Object.fromEntries(
      fencedMembers.map((member) => [String(member.pull.number), member.pull.commitSha]),
    );
    const evidence = Object.fromEntries(
      fencedMembers.map((member) => [String(member.pull.number), member.pull.exactHeadValidation]),
    );
    const repositoryEpoch = await this.#lease.use(async (lease) => lease.epoch);
    const integrationLease = acquireIntegrationLease({
      operationId,
      unitId,
      repositoryEpoch,
      expectedHeads,
      evidence,
    });
    const observedHeads = Object.fromEntries(
      await Promise.all(
        fencedMembers.map(
          async (member) =>
            [
              String(member.pull.number),
              (await this.#store.readPullRequest(member.pull.number)).headSha,
            ] as const,
        ),
      ),
    );
    assertIntegrationHeads(integrationLease, observedHeads);
    const pendingEvent = [...(targetItem.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
          event.kind === "publication" &&
          event.runId === this.#run.runId &&
          event.event === "IntegrationPending" &&
          event.operationId === operationId &&
          event.headSha === target.receipt.headSha,
      );
    if (pendingEvent) {
      assertPublicationEventMatchesReceipt(pendingEvent, target.receipt);
    }
    let result = await this.#serializeIntegration(async () => {
      await this.#lease.assertGeneration("integration");
      return pendingEvent?.asynchronousMergeUuid
        ? this.#stacks.mergeResult(
            target.pull.number,
            pendingEvent.asynchronousMergeUuid,
            target.pull.commitSha,
          )
        : this.#stacks.requestMerge({
            pullRequest: target.pull.number,
            expectedHeadSha: target.pull.commitSha,
            title: target.receipt.itemId,
            action: "default",
          });
    });
    if (result.state === "failed") throw new Error(result.reason);
    if (
      (result.state === "pending" || result.state === "queued") &&
      (!pendingEvent ||
        (result.state === "pending" && pendingEvent.asynchronousMergeUuid !== result.uuid))
    ) {
      await this.#lease.use((lease) =>
        this.#recorder.publication({
          lease,
          workItemNodeId: targetItem.id,
          sequence: this.#sequences.take(),
          receipt: target.receipt,
          event: "IntegrationPending",
          operationId,
          ...(result.state === "pending" ? { asynchronousMergeUuid: result.uuid } : {}),
        }),
      );
    }
    while (result.state !== "merged") {
      if (Date.now() >= deadline) throw new Error("stack asynchronous integration timed out");
      await sleep(this.#options.pollIntervalMs ?? 5_000, this.#options.signal);
      await this.#lease.renewIfNeeded();
      if (result.state === "pending") {
        const uuid = result.uuid;
        result = await this.#stacks.mergeResult(target.pull.number, uuid, target.pull.commitSha);
      } else {
        const current = await this.#store.readPullRequest(target.pull.number);
        if (current.headSha !== target.pull.commitSha) {
          throw new Error("merge-queue target head changed after validation");
        }
        if (current.merged && current.mergeCommitSha) {
          result = { state: "merged", mergeSha: current.mergeCommitSha };
        } else {
          result = await this.#stacks.requestMerge({
            pullRequest: target.pull.number,
            expectedHeadSha: target.pull.commitSha,
            title: target.receipt.itemId,
            action: "default",
          });
        }
      }
      if (result.state === "failed") throw new Error(result.reason);
    }

    const integrated =
      mergePolicy === "atomic-stack"
        ? members.filter((member) =>
            remaining.some((item) => item.number === member.receipt.workItem),
          )
        : [target];
    await completeIntegrated(integrated);
    for (const item of ordered) this.#integrationWaits.delete(item.number);
    return true;
  }

  async #nativeRebaseAdmissionCurrent(
    member: NativeStackMember,
    headSha: string,
    baseSha: string,
    baseBranch: string,
    alreadyAdmitted = false,
  ): Promise<boolean> {
    this.#options.signal?.throwIfAborted();
    const snapshot = await this.#reader.readObjective(this.#run.objective);
    this.#fenceSnapshot(snapshot);
    this.#sequences.observe(snapshotEvents(snapshot));
    if (hasCancellationRequest(snapshot, this.#run.runId))
      throw new RunCancellationRequestedError("operator cancelled before native rebase admission");
    const commands = deriveDurableCommandState({
      events: snapshotEvents(snapshot),
      objective: snapshot.number,
      runId: this.#run.runId,
      runActor: this.#run.actor,
      runStartSequence: this.#runStartSequence,
    });
    // Cloud pause stops new reservations; it does not cancel an already admitted phase.
    if (commands.cloudPaused && !alreadyAdmitted) return false;
    const current = await this.#store.readPullRequest(member.pull.number);
    if (
      current.merged ||
      current.state !== "open" ||
      current.headSha !== headSha ||
      current.baseSha !== baseSha ||
      current.baseRef !== baseBranch
    )
      throw new Error(
        "native rebase head or base changed before exact validation/review admission",
      );
    const commit = await this.#store.readCommit(headSha);
    if (
      commit.oid !== headSha ||
      commit.parentOids.length !== 1 ||
      commit.parentOids[0] !== baseSha
    )
      throw new Error("native rebase head does not descend from its exact observed base");
    return true;
  }

  /** Revalidation is a new paid resource, never a new implementation attempt. */
  async #prepareNativeRebaseValidation(
    item: DerivedWorkItem,
    member: NativeStackMember,
    headSha: string,
    artifact: NormalizedArtifact,
    packet: WorkerPacket,
    baseBranch: string,
  ): Promise<NativeRebaseCheckpointRecord | null> {
    const reservation = member.reservation;
    const identity: NativeRebaseIdentity = {
      repository: `${this.#options.owner}/${this.#options.repo}`,
      runId: reservation.runId,
      objective: reservation.objective,
      workItem: item.number,
      attempt: reservation.attempt,
      directorEpoch: reservation.directorEpoch,
      policyDigest: reservation.policyDigest,
      pullRequest: member.pull.number,
      sourceHeadSha: member.pull.commitSha,
      sourceExactHeadValidationDigest: member.pull.exactHeadValidation.digest,
      headSha,
      baseSha: packet.baseSha,
    };
    const digest = nativeRebaseIdentityDigest(identity);
    const capacityBackend = `factory/integration-sandbox-${digest}`;
    const snapshot = await this.#reader.readObjective(this.#run.objective);
    this.#fenceSnapshot(snapshot);
    this.#sequences.observe(snapshotEvents(snapshot));
    const events = snapshotEvents(snapshot);
    this.#budgetEvents = deduplicateFactoryEvents([
      ...this.#budgetEvents,
      ...events.filter((event) => event.runId === this.#run.runId),
    ]);
    let record = await this.#nativeRebases.load(identity);
    if (record && record.validation.artifactDigest !== artifact.digest)
      throw new Error("native rebase checkpoint does not match the current rewritten artifact");
    if (record) {
      const history = deduplicateFactoryEvents(events);
      const capacity = history.filter(
        (event) =>
          event.kind === "capacity" &&
          event.event === "CapacityReserved" &&
          event.runId === reservation.runId &&
          event.objective === reservation.objective &&
          event.workItem === item.number &&
          event.attempt === reservation.attempt &&
          event.phase === "validation" &&
          event.backend === capacityBackend &&
          event.policyDigest === reservation.policyDigest &&
          event.directorEpoch === reservation.directorEpoch,
      );
      const budget = history.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReserved" &&
          event.runId === reservation.runId &&
          event.objective === reservation.objective &&
          event.workItem === item.number &&
          event.attempt === reservation.attempt &&
          event.phase === "validation" &&
          event.unit === "sandbox_milliseconds" &&
          event.usageId === `integration-validation-${digest}`,
      );
      if (
        capacity.length !== 1 ||
        budget.length !== 1 ||
        capacity[0]!.sequence >= budget[0]!.sequence
      )
        throw new Error(
          "native rebase checkpoint has no exact authenticated capacity and budget admission",
        );
    }
    const pending = unreconciledCapacityReservations(events).filter(
      (event) =>
        event.runId === reservation.runId &&
        event.workItem === item.number &&
        event.attempt === reservation.attempt &&
        event.backend === capacityBackend,
    );
    if (!record && pending.length)
      throw new Error(
        "native rebase completion is unavailable; automated replacement is blocked until exact resource reconciliation",
      );
    const reconcile = (cpu: number, memoryMb: number) =>
      this.#lease.use((lease) =>
        this.#attempts.recordCapacity({
          lease,
          workItemNodeId: item.id,
          reservation,
          sequence: this.#sequences.take(),
          event: "CapacityReconciled",
          phase: "validation",
          backend: capacityBackend,
          requestedCpu: cpu,
          requestedMemoryMb: memoryMb,
          allowRecovery: true,
        }),
      );
    if (record) {
      for (const capacity of pending)
        await reconcile(capacity.requestedCpu, capacity.requestedMemoryMb);
    } else {
      this.#options.signal?.throwIfAborted();
      if (hasCancellationRequest(snapshot, this.#run.runId))
        throw new RunCancellationRequestedError(
          "operator cancelled before native rebase validation",
        );
      const commandState = deriveDurableCommandState({
        events,
        objective: snapshot.number,
        runId: this.#run.runId,
        runActor: this.#run.actor,
        runStartSequence: this.#runStartSequence,
      });
      if (commandState.cloudPaused) return null;
      if (!(await this.#nativeRebaseAdmissionCurrent(member, headSha, packet.baseSha, baseBranch)))
        return null;
      const objectiveDeadline =
        this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000;
      const timeout = Math.min(
        (packet.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000,
        objectiveDeadline - Date.now(),
      );
      const available = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
      if (timeout <= 0 || available.sandboxMinutes * 60_000 < timeout)
        throw new Error(
          "sandbox-minute budget or deadline exhausted before native rebase validation",
        );
      const validator = await this.#registry.selectIsolatedValidator({
        policy: { ...this.#policy, backendOrder: ["codex-cli/daytona"] },
        requirements: packet.requirements,
        budget: available,
        estimatedDurationMs: timeout,
      });
      if (validator.backend.capabilities.id !== "codex-cli/daytona" || !validator.backend.validate)
        throw new Error(
          "native rebase requires explicitly authorized independent Daytona validation",
        );
      const effective = normalizeSchedulingPolicy(this.#policy);
      const capacity: CapacityReservation = {
        key: capacityReservationKey({
          objective: reservation.objective,
          workItem: item.number,
          attempt: reservation.attempt,
          phase: "validation",
          backendId: capacityBackend,
        }),
        objective: reservation.objective,
        workItem: item.number,
        attempt: reservation.attempt,
        phase: "validation",
        backendId: capacityBackend,
        admissionClass: "remote-required",
        local: false,
        cpu: packet.requirements.cpu ?? effective.capacity.local.defaultCpu,
        memoryMb: packet.requirements.memoryMb ?? effective.capacity.local.defaultMemoryMb,
        paidUnits: 1,
        paths: packet.allowedPaths,
        exclusiveResources: packet.changeSurface?.exclusiveResources ?? [],
      };
      const current = this.#capacity.snapshot();
      const admitted = this.#capacity.tryReserve(
        current.generation,
        capacity,
        admissionCapacityLimits(
          this.#policy,
          null,
          this.#run.objective,
          this.#fairness.localMaximum(
            this.#run.objective,
            Math.min(effective.capacity.local.maxWorkers, this.#controllerLimits.maxLocalWorkers),
            current.reservations,
          ),
          this.#controllerLimits,
        ),
      );
      if (!admitted.reserved) return null;
      let capacityRecorded = false;
      let validation: CleanValidationResult | undefined;
      let providerStarted: Date | undefined;
      let providerCompleted: Date | undefined;
      let budgetReserved = false;
      try {
        await this.#lease.use((lease) =>
          this.#attempts.recordCapacity({
            lease,
            workItemNodeId: item.id,
            reservation,
            sequence: this.#sequences.take(),
            event: "CapacityReserved",
            phase: "validation",
            backend: capacityBackend,
            requestedCpu: capacity.cpu,
            requestedMemoryMb: capacity.memoryMb,
            allowRecovery: true,
          }),
        );
        capacityRecorded = true;
        const budget = await this.#lease.use(async (lease) => {
          const available = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
          const amount = Math.min(timeout, objectiveDeadline - Date.now());
          if (amount <= 0 || available.sandboxMinutes * 60_000 < amount)
            throw new Error("sandbox budget or deadline changed before native rebase reservation");
          return this.#recorder.budget({
            lease,
            workItemNodeId: item.id,
            reservation,
            sequence: this.#sequences.take(),
            event: "BudgetReserved",
            phase: "validation",
            unit: "sandbox_milliseconds",
            amount,
            usageId: `integration-validation-${digest}`,
          });
        });
        this.#budgetEvents.push(budget);
        budgetReserved = true;
        if (budget.kind !== "budget") throw new Error("native rebase budget receipt is invalid");
        const deadline = new Date(
          Math.min(Date.parse(budget.at) + budget.amount, objectiveDeadline),
        );
        validation = await this.#externalAdmission(() =>
          validateArtifactClean({
            repository: this.#options.repository,
            artifact,
            packet,
            isolatedValidator: () =>
              this.#externalAdmission(async () => {
                await this.#nativeRebaseAdmissionCurrent(
                  member,
                  headSha,
                  packet.baseSha,
                  baseBranch,
                  true,
                );
                providerStarted = new Date();
                const result = await validator.backend.validate!({
                  repository: identity.repository,
                  objective: reservation.objective,
                  workItem: item.number,
                  attempt: reservation.attempt,
                  runId: reservation.runId,
                  directorEpoch: reservation.directorEpoch,
                  policyDigest: reservation.policyDigest,
                  workspace: this.#options.repository,
                  packet,
                  artifact,
                  policyNetworkDestinations: this.#policy.allowedNetworkDestinations,
                  deadline,
                  validationInvocation: nativeRebaseValidationInvocation(identity, artifact.digest),
                });
                providerCompleted = new Date();
                return result;
              }),
          }),
        );
        if (!validation.evidence.passed)
          throw new Error(validation.evidence.failureReason ?? "native rebase validation failed");
        record = await this.#lease.use((lease) =>
          this.#nativeRebases.persist({
            lease,
            identity,
            source: member.pull.exactHeadValidation,
            validation: validation!.evidence,
            isolatedResource: {
              backend: "codex-cli/daytona",
              invocationOwnershipDigest: nativeRebaseResourceOwnership(identity, artifact.digest),
              startedAt: providerStarted!.toISOString(),
              completedAt: providerCompleted!.toISOString(),
              sandboxMilliseconds: providerCompleted!.getTime() - providerStarted!.getTime(),
            },
          }),
        );
      } catch (error) {
        if (providerStarted && !record) {
          // A response may have been lost after immutable persistence. Never launch twice.
          const recovered = await this.#nativeRebases.load(identity);
          if (recovered && recovered.validation.artifactDigest !== artifact.digest)
            throw new Error(
              "native rebase recovered checkpoint artifact conflicts; automated replacement is blocked",
            );
          record = recovered;
          if (!record)
            throw new Error(
              "native rebase validation lacks durable completion; automated replacement is blocked until exact resource reconciliation",
              { cause: error },
            );
        }
        if (!record) throw error;
      } finally {
        try {
          if (validation) await discardValidationResult(validation);
          if (!providerStarted && budgetReserved) {
            const event = await this.#lease.use((lease) =>
              this.#recorder.budget({
                lease,
                workItemNodeId: item.id,
                reservation,
                sequence: this.#sequences.take(),
                event: "BudgetReconciled",
                phase: "validation",
                unit: "sandbox_milliseconds",
                amount: 0,
                usageId: `integration-validation-${digest}`,
              }),
            );
            this.#budgetEvents.push(event);
          }
          if (capacityRecorded && (record || !providerStarted))
            await reconcile(capacity.cpu, capacity.memoryMb);
        } finally {
          if (!capacityRecorded || record || !providerStarted) this.#capacity.release(capacity.key);
        }
      }
    }
    await this.#recordCandidateValidationUsage(record.validation, digest, item, reservation);
    await this.#recordCandidateValidationUsage(
      record.validation,
      digest,
      item,
      reservation,
      "sandbox_milliseconds",
      record.isolatedResource.sandboxMilliseconds,
    );
    return record;
  }

  async #revalidateNativeStackMember(
    item: DerivedWorkItem,
    member: NativeStackMember,
    headSha: string,
    baseSha: string,
    baseBranch: string,
  ): Promise<void> {
    const originalPacket = this.#packetFor(item.number);
    const executionBackend = this.#registry.get(member.reservation.backend);
    const isolated =
      originalPacket.requirements.trust !== "trusted_local" ||
      !executionBackend?.capabilities.hostExecution;
    await ensureLocalCommit(this.#options.repository, baseSha);
    await ensureLocalCommit(this.#options.repository, headSha);
    const changedPaths = (
      await hostGit(
        this.#options.repository,
        ["diff", "--name-only", "-z", baseSha, headSha],
        MAX_ARTIFACT_PATCH_BYTES + 1_024,
        true,
      )
    )
      .split("\0")
      .filter(Boolean);
    const patch = await hostGit(
      this.#options.repository,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", baseSha, headSha],
      MAX_ARTIFACT_PATCH_BYTES + 1_024,
      true,
    );
    const artifact = normalizeArtifact({
      baseSha,
      patch,
      changedPaths,
      outcome: patch.trim() ? "succeeded" : "declined",
      ...(patch.trim() ? {} : { reason: "rebased stack layer has no diff" }),
    });
    const packet = parseWorkerPacket({
      ...originalPacket,
      baseSha,
    });
    // Keep local scoped capacity separate from the isolated provider checkpoint.
    const prepareLocal = async () => {
      const invocation = createHash("sha256")
        .update(
          JSON.stringify([
            "native-rebase",
            this.#run.runId,
            item.number,
            member.reservation.attempt,
            artifact.digest,
            headSha,
          ]),
        )
        .digest("hex");
      const capacityBackend = `factory/integration-validation-${invocation}`;
      const currentSnapshot = await this.#reader.readObjective(this.#run.objective);
      if (
        unreconciledCapacityReservations(snapshotEvents(currentSnapshot)).some(
          (event) => event.runId === this.#run.runId && event.backend === capacityBackend,
        )
      )
        throw new Error(
          "interrupted native-rebase validation requires owned-resource reconciliation",
        );
      const scoped = await this.#scopedValidation(
        member.reservation,
        artifact,
        packet,
        new Date(
          Math.min(
            Date.now() + this.#policy.workItemTimeoutMinutes * 60_000,
            this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
          ),
        ),
      );
      if (this.#recoveryRuntime && !scoped)
        throw new Error("successor native rebase requires owned local scopes");
      const scheduling = normalizeSchedulingPolicy(this.#policy);
      const capacity: CapacityReservation = {
        key: capacityReservationKey({
          objective: this.#run.objective,
          workItem: item.number,
          attempt: member.reservation.attempt,
          phase: "validation",
          backendId: capacityBackend,
        }),
        objective: this.#run.objective,
        workItem: item.number,
        attempt: member.reservation.attempt,
        phase: "validation",
        backendId: capacityBackend,
        admissionClass: "local",
        local: true,
        cpu: packet.requirements.cpu ?? scheduling.capacity.local.defaultCpu,
        memoryMb: packet.requirements.memoryMb ?? scheduling.capacity.local.defaultMemoryMb,
        paidUnits: 0,
        paths: packet.allowedPaths,
        exclusiveResources: packet.changeSurface?.exclusiveResources ?? [],
      };
      const resource =
        scheduling.capacity.mode === "adaptive-local"
          ? await this.#resourceSampler.sample(Date.now())
          : null;
      if (
        resource &&
        (resourcePressureReasons(resource, scheduling.capacity.local).length ||
          this.#resourceSampler.coolingDown(Date.now()))
      )
        throw new Error("local capacity pressure blocks native-rebase validation");
      if (
        !this.#capacity.tryReserve(
          this.#capacity.snapshot().generation,
          capacity,
          admissionCapacityLimits(
            this.#policy,
            resource,
            this.#run.objective,
            Math.min(scheduling.capacity.local.maxWorkers, this.#controllerLimits.maxLocalWorkers),
            this.#controllerLimits,
          ),
        ).reserved
      )
        throw new Error("local capacity unavailable for native-rebase validation");
      const recordCapacity = (event: "CapacityReserved" | "CapacityReconciled") =>
        this.#lease.use((lease) =>
          this.#attempts.recordCapacity({
            lease,
            workItemNodeId: item.id,
            reservation: member.reservation,
            sequence: this.#sequences.take(),
            event,
            phase: "validation",
            backend: capacityBackend,
            requestedCpu: capacity.cpu,
            requestedMemoryMb: capacity.memoryMb,
            allowRecovery: true,
            ...(event === "CapacityReserved" && scoped ? { localScopeBatch: scoped.batch } : {}),
          }),
        );
      let validation: CleanValidationResult;
      let pendingValidation: CleanValidationResult | undefined;
      let capacityRecorded = false;
      try {
        await recordCapacity("CapacityReserved");
        capacityRecorded = true;
        validation = await this.#externalAdmission(() =>
          validateArtifactClean({
            repository: this.#options.repository,
            artifact,
            packet,
            ...(scoped ? { localScope: scoped.hooks } : {}),
          }),
        );
        pendingValidation = validation;
        await this.#recordCandidateValidationUsage(
          validation.evidence,
          invocation,
          item,
          member.reservation,
        );
      } catch (error) {
        if (pendingValidation) await discardValidationResult(pendingValidation);
        if (!capacityRecorded) this.#capacity.release(capacity.key);
        throw error;
      }
      const releaseCapacity = () => this.#capacity.release(capacity.key);
      return {
        validation,
        async finish(recorded: boolean) {
          await discardValidationResult(validation);
          if (recorded) {
            await recordCapacity("CapacityReconciled");
            releaseCapacity();
          }
        },
      };
    };
    const remoteRecord = isolated
      ? await this.#prepareNativeRebaseValidation(
          item,
          member,
          headSha,
          artifact,
          packet,
          baseBranch,
        )
      : null;
    if (isolated && !remoteRecord) return;
    const localResult = isolated ? undefined : await prepareLocal();
    const validation: Pick<CleanValidationResult, "evidence"> = remoteRecord
      ? { evidence: remoteRecord.validation }
      : localResult!.validation;
    let validatedAndRecorded = false;
    try {
      if (!validation.evidence.passed) {
        throw new Error(validation.evidence.failureReason ?? "rebased stack validation failed");
      }
      const reviewIdentity: ReviewIdentity = {
        kind: "rebase",
        runId: this.#run.runId,
        objective: this.#run.objective,
        workItem: item.number,
        attempt: member.reservation.attempt,
        artifactDigest: artifact.digest,
        baseSha: validation.evidence.baseSha,
        outputTreeSha: validation.evidence.outputTreeSha,
        evidenceDigest: validation.evidence.digest,
        headSha,
      };
      const existingReview = await this.#reviews.load(reviewIdentity);
      let invokeReview:
        | ((
            checkpoint: Parameters<ManagementBackend["review"]>[1],
          ) => ReturnType<ManagementBackend["review"]>)
        | undefined;
      if (!existingReview) {
        if (
          isolated &&
          !(await this.#nativeRebaseAdmissionCurrent(member, headSha, baseSha, baseBranch))
        )
          return;
        const reviewBudget = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
        if (reviewBudget.modelTokens !== null && reviewBudget.modelTokens <= 0) {
          throw new Error("model-token budget is exhausted; refusing rebased semantic review");
        }
        this.#assertManagementInvocationNotFailed(
          `rebase-review-${reviewIdentityDigest(reviewIdentity)}`,
        );
        const reviewModel = resolveModelSelection(this.#policy, "review");
        invokeReview = (checkpoint) =>
          this.#externalAdmission(() =>
            this.#management.review(
              {
                repository: this.#options.repository,
                objectiveNumber: this.#run.objective,
                workItemNumber: item.number,
                packet,
                artifact,
                evidence: validation.evidence,
                ...(reviewModel ? { modelSelection: reviewModel } : {}),
              },
              checkpoint,
            ),
          );
      }
      const commit = await this.#store.readCommit(headSha);
      if (commit.parentOids.length !== 1 || commit.parentOids[0] !== baseSha) {
        throw new Error(
          `rebased stack Work Item ${member.receipt.itemId} does not descend from its observed base`,
        );
      }
      const exactHeadValidation = bindValidationToPublishedHead({
        validation: validation.evidence,
        publishedHeadSha: headSha,
        publishedTreeSha: commit.treeOid,
        publishedBaseSha: baseSha,
      });
      const rebasedReceipt: PublicationReceipt = {
        ...member.receipt,
        revision: member.receipt.revision + 2,
        baseBranch,
        baseSha,
        headSha,
        exactHeadValidation,
        state: "published",
      };
      await runDurableReviewTransaction({
        existing: existingReview,
        ...(invokeReview ? { invoke: invokeReview } : {}),
        persist: (result) =>
          this.#lease.use((lease) =>
            this.#reviews.persist({ lease, identity: reviewIdentity, result }),
          ),
        recover: () => this.#reviews.load(reviewIdentity),
        recordUsage: (record) => this.#recordReviewUsage(record, item, member.reservation),
        recordFailureUsage: (usage) =>
          this.#recordFailedManagementUsage(
            `rebase-review-${reviewIdentityDigest(reviewIdentity)}`,
            usage,
            item.id,
            member.reservation,
          ),
        recordOutcome: (record) =>
          this.#recordRebaseReviewOutcome(
            record,
            item,
            member.reservation,
            validation,
            rebasedReceipt,
          ),
      });
      validatedAndRecorded = true;
    } finally {
      if (localResult) await localResult.finish(validatedAndRecorded);
    }
  }

  #mergeCandidateIdentity(
    member: NativeStackMember,
    targetBaseSha: string,
  ): MergeCandidateIdentity {
    return {
      runId: this.#run.runId,
      objective: this.#run.objective,
      workItem: member.reservation.workItem,
      attempt: member.reservation.attempt,
      pullRequest: member.pull.number,
      sourceHeadSha: member.pull.commitSha,
      sourceExactHeadValidationDigest: member.pull.exactHeadValidation.digest,
      targetBaseSha,
    };
  }

  #mergeCandidateReviewIdentity(record: MergeCandidateCheckpointRecord): ReviewIdentity {
    return {
      kind: "integration-candidate",
      runId: record.identity.runId,
      objective: record.identity.objective,
      workItem: record.identity.workItem,
      attempt: record.identity.attempt,
      artifactDigest: record.validation.artifactDigest,
      baseSha: record.validation.baseSha,
      outputTreeSha: record.validation.outputTreeSha,
      evidenceDigest: record.validation.digest,
      headSha: record.identity.sourceHeadSha,
    };
  }

  /** External trunk changes never acquire execution authority from being cleanly applicable. */
  async #assertOwnTrunkAdvance(
    sourceBaseSha: string,
    targetBaseSha: string,
    currentWorkItem: number,
  ): Promise<{ snapshot: Snapshot; requiresIsolation: boolean }> {
    const snapshot = await this.#reader.readObjective(this.#run.objective);
    this.#fenceSnapshot(snapshot);
    this.#sequences.observe(snapshotEvents(snapshot));
    if (this.#recoveryRuntime) await this.#resumeObservedRun(snapshot, new RunManager(this.#store));
    const items = derive(snapshot).items;
    let cursor = targetBaseSha;
    let requiresIsolation = false;
    const visited = new Set<string>();
    while (cursor !== sourceBaseSha) {
      if (visited.has(cursor) || visited.size >= items.length) {
        throw new Error("base advancement is not a bounded chain of this run's integrations");
      }
      visited.add(cursor);
      const adopted =
        this.#recoveryRuntime?.sourceIntegrations.filter(
          (proof) =>
            proof.outcome.workItem !== currentWorkItem && proof.outcome.mergeCommitSha === cursor,
        ) ?? [];
      if (adopted.length) {
        if (adopted.length !== 1) throw new Error("conflicting source integration ancestry");
        const commit = await this.#store.readCommit(cursor);
        if (
          commit.oid !== cursor ||
          commit.parentOids.length !== 1 ||
          commit.parentOids[0] !== adopted[0]!.targetBaseSha ||
          commit.treeOid !== adopted[0]!.outputTreeSha
        )
          throw new Error("adopted source integration ancestry changed");
        cursor = commit.parentOids[0]!;
        continue;
      }
      const matches = items.flatMap((item) =>
        deduplicateFactoryEvents(item.factoryEvents ?? [])
          .filter(
            (event) =>
              event.kind === "attempt" &&
              event.event === "AttemptIntegrated" &&
              event.runId === this.#run.runId &&
              event.workItem === item.number &&
              event.workItem !== currentWorkItem &&
              event.headSha === cursor,
          )
          .map((event) => ({ item, event })),
      );
      if (matches.length !== 1) {
        throw new Error(
          `base branch advanced outside this run's evidenced integrations: ${cursor}`,
        );
      }
      const { item, event } = matches[0]!;
      const member = await this.#nativeStackMember(item, true);
      if (!this.#registry.get(member.reservation.backend)?.capabilities.hostExecution)
        requiresIsolation = true;
      if (event.kind !== "attempt" || event.attempt !== member.reservation.attempt) {
        throw new Error("integrated trunk commit does not match its published attempt");
      }
      const pull = await this.#store.readPullRequest(member.pull.number);
      const commit = await this.#store.readCommit(cursor);
      if (
        !pull.merged ||
        pull.headSha !== member.pull.commitSha ||
        pull.mergeCommitSha !== cursor ||
        pull.baseRef !== this.#baseBranch ||
        commit.oid !== cursor ||
        commit.parentOids.length !== 1
      ) {
        throw new Error("trunk advancement lacks an exact Factory squash integration");
      }
      const parent = commit.parentOids[0]!;
      if (parent === member.pull.exactHeadValidation.baseSha) {
        await verifySquashIntegration(this.#store, member.pull, cursor, parent);
      } else {
        const candidate = await this.#mergeCandidates.load(
          this.#mergeCandidateIdentity(member, parent),
        );
        const review = candidate
          ? await this.#reviews.load(this.#mergeCandidateReviewIdentity(candidate))
          : null;
        if (!candidate || !review?.review.accepted) {
          throw new Error("prior sibling integration has no accepted candidate checkpoint");
        }
        await verifyMergeCandidateSquash(
          this.#store,
          member.pull.exactHeadValidation,
          candidate.evidence,
          cursor,
        );
      }
      cursor = parent;
    }
    return { snapshot, requiresIsolation };
  }

  async #recordCandidateValidationUsage(
    evidence: ValidationEvidence,
    identityDigest: string,
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    unit: "validation_milliseconds" | "sandbox_milliseconds" = "validation_milliseconds",
    measuredAmount?: number,
  ): Promise<void> {
    const usageId = `integration-validation-${identityDigest}`;
    const amount =
      measuredAmount ??
      new Date(evidence.completedAt).getTime() - new Date(evidence.startedAt).getTime();
    const matches = (events: readonly FactoryEvent[]) =>
      events.filter(
        (event) =>
          event.kind === "budget" &&
          event.runId === this.#run.runId &&
          event.workItem === item.number &&
          event.attempt === reservation.attempt &&
          event.unit === unit &&
          event.phase === "validation" &&
          event.event === "BudgetReconciled" &&
          event.usageId === usageId,
      );
    const existing = matches(this.#budgetEvents);
    if (existing.some((event) => event.amount !== amount))
      throw new Error("merge-candidate validation usage conflicts with its evidence");
    if (existing.length > 0) return;
    try {
      const event = await this.#lease.use((lease) =>
        this.#recorder.budget({
          lease,
          workItemNodeId: item.id,
          reservation,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled",
          unit,
          phase: "validation",
          amount,
          usageId,
        }),
      );
      this.#budgetEvents.push(event);
    } catch (error) {
      const snapshot = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(snapshot);
      const recovered = matches(snapshotEvents(snapshot));
      if (recovered.length === 0) throw error;
      if (recovered.some((event) => event.amount !== amount))
        throw new Error("recovered merge-candidate validation usage conflicts with its evidence");
      this.#sequences.observe(snapshotEvents(snapshot));
      this.#budgetEvents.push(...recovered);
    }
  }

  async #prepareSiblingMergeCandidate(
    item: DerivedWorkItem,
    member: NativeStackMember,
    targetBaseSha: string,
    merged: boolean,
  ): Promise<MergeCandidateCheckpointRecord | null> {
    const assertDeadline = () => {
      if (
        Date.now() >=
        this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000
      ) {
        throw new Error("Objective timeout exhausted before merge-candidate admission");
      }
      this.#options.signal?.throwIfAborted();
    };
    assertDeadline();
    const originalPacket = this.#packetFor(item.number);
    const backend = this.#registry.get(member.reservation.backend);
    const { snapshot, requiresIsolation: baseRequiresIsolation } =
      await this.#assertOwnTrunkAdvance(
        member.pull.exactHeadValidation.baseSha,
        targetBaseSha,
        item.number,
      );
    const isolated =
      baseRequiresIsolation ||
      originalPacket.requirements.trust !== "trusted_local" ||
      !backend?.capabilities.hostExecution;
    if (hasCancellationRequest(snapshot, this.#run.runId))
      throw new RunCancellationRequestedError(
        "operator cancelled before merge-candidate admission",
      );
    if (
      isolated &&
      deriveDurableCommandState({
        events: snapshotEvents(snapshot),
        objective: snapshot.number,
        runId: this.#run.runId,
        runActor: this.#run.actor,
        runStartSequence: this.#runStartSequence,
      }).cloudPaused
    )
      return null;
    if (isolated && !this.#policy.allowedPaidBackends.includes("codex-cli/daytona"))
      throw new Error(
        "parallel sibling candidate requires explicitly authorized independent Daytona validation",
      );
    this.#budgetEvents = deduplicateFactoryEvents([
      ...this.#budgetEvents,
      ...snapshotEvents(snapshot).filter((event) => event.runId === this.#run.runId),
    ]);
    const identity = this.#mergeCandidateIdentity(member, targetBaseSha);
    const identityDigest = mergeCandidateIdentityDigest(identity);
    const invocationOwnership = (artifactDigest: string) =>
      validationInvocationOwnership({
        repository: `${this.#options.owner}/${this.#options.repo}`,
        objective: member.reservation.objective,
        workItem: item.number,
        attempt: member.reservation.attempt,
        runId: member.reservation.runId,
        directorEpoch: member.reservation.directorEpoch,
        policyDigest: member.reservation.policyDigest,
        phase: "validation",
        validationInvocation: {
          kind: "integration-candidate",
          identityDigest,
          artifactDigest,
          baseSha: targetBaseSha,
        },
      })!;
    let record = await this.#mergeCandidates.load(identity);
    if (
      record &&
      isolated &&
      (!record.isolatedResource ||
        record.isolatedResource.invocationOwnershipDigest !==
          invocationOwnership(record.validation.artifactDigest))
    )
      throw new Error(
        "isolated merge-candidate checkpoint has unknown cleanup or native accounting identity",
      );
    const candidateTimeout = Math.min(
      (originalPacket.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000,
      this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000 - Date.now(),
    );
    let validator: ExecutionBackend | undefined;
    if (isolated && !record) {
      const candidates = await this.#registry.evaluateIsolatedValidators({
        policy: { ...this.#policy, backendOrder: ["codex-cli/daytona"] },
        requirements: originalPacket.requirements,
        probeTtlMs: 0,
      });
      const candidate = candidates.find((candidate) => candidate.id === "codex-cli/daytona");
      if (
        !candidate?.backend?.validate ||
        candidate.permanentReasons.length ||
        candidate.transientReasons.length
      )
        throw new Error(
          "independent Daytona merge-candidate validator is unavailable or unauthorized",
        );
      validator = candidate.backend;
      const available = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
      if (candidateTimeout <= 0 || available.sandboxMinutes * 60_000 < candidateTimeout)
        throw new Error("sandbox-minute budget exhausted before merge-candidate validation");
    }
    if (!record && merged) {
      throw new Error(
        "merged sibling has no pre-merge candidate checkpoint; refusing retrospective validation",
      );
    }
    const packet = parseWorkerPacket({ ...originalPacket, baseSha: targetBaseSha });
    const capacityBackend = `factory/integration-${isolated ? "sandbox" : "validation"}-${identityDigest}`;
    const priorCapacity = unreconciledCapacityReservations(snapshotEvents(snapshot)).filter(
      (event) =>
        event.runId === this.#run.runId &&
        event.workItem === item.number &&
        event.attempt === member.reservation.attempt &&
        event.backend === capacityBackend,
    );
    // A checkpoint is written only after the clean validator has returned. Without it, a
    // crashed validator may still be alive: do not manufacture absence or duplicate its work.
    if (!record && priorCapacity.length > 0) {
      throw new Error(
        "interrupted merge-candidate validation has no completion evidence; resource reconciliation required",
      );
    }
    const reconcileCapacity = async (cpu: number, memoryMb: number) =>
      this.#lease.use((lease) =>
        this.#attempts.recordCapacity({
          lease,
          workItemNodeId: item.id,
          reservation: member.reservation,
          sequence: this.#sequences.take(),
          event: "CapacityReconciled",
          phase: "validation",
          backend: capacityBackend,
          requestedCpu: cpu,
          requestedMemoryMb: memoryMb,
          allowRecovery: true,
        }),
      );
    if (record) {
      for (const capacity of priorCapacity) {
        await reconcileCapacity(capacity.requestedCpu, capacity.requestedMemoryMb);
      }
    }
    let artifact: NormalizedArtifact | undefined;
    const reconstructArtifact = async () => {
      await ensureLocalCommit(this.#options.repository, member.pull.exactHeadValidation.baseSha);
      await ensureLocalCommit(this.#options.repository, member.pull.commitSha);
      await ensureLocalCommit(this.#options.repository, targetBaseSha);
      const source = [member.pull.exactHeadValidation.baseSha, member.pull.commitSha];
      const changedPaths = (
        await hostGit(
          this.#options.repository,
          ["diff", "--name-only", "-z", ...source],
          MAX_ARTIFACT_PATCH_BYTES + 1_024,
          true,
        )
      )
        .split("\0")
        .filter(Boolean);
      const patch = await hostGit(
        this.#options.repository,
        ["diff", "--binary", "--no-ext-diff", "--no-textconv", ...source],
        MAX_ARTIFACT_PATCH_BYTES + 1_024,
        true,
      );
      return normalizeArtifact({
        baseSha: targetBaseSha,
        changedPaths,
        patch,
        outcome: "succeeded",
      });
    };
    if (!record) {
      const effective = normalizeSchedulingPolicy(this.#policy);
      const resource =
        !isolated && effective.capacity.mode === "adaptive-local"
          ? await this.#resourceSampler.sample(Date.now()).catch(() => null)
          : null;
      if (!isolated && effective.capacity.mode === "adaptive-local") {
        const pressure = resource
          ? resourcePressureReasons(resource, effective.capacity.local)
          : ["resource sample unavailable"];
        if (pressure.length > 0 || this.#resourceSampler.coolingDown(Date.now())) {
          if (pressure.length > 0) this.#resourceSampler.notePressure(Date.now());
          return null;
        }
      }
      const capacity: CapacityReservation = {
        key: capacityReservationKey({
          objective: this.#run.objective,
          workItem: item.number,
          attempt: member.reservation.attempt,
          phase: "validation",
          backendId: capacityBackend,
        }),
        objective: this.#run.objective,
        workItem: item.number,
        attempt: member.reservation.attempt,
        phase: "validation",
        backendId: capacityBackend,
        admissionClass: isolated ? "remote-required" : "local",
        local: !isolated,
        cpu: packet.requirements.cpu ?? effective.capacity.local.defaultCpu,
        memoryMb: packet.requirements.memoryMb ?? effective.capacity.local.defaultMemoryMb,
        paidUnits: isolated ? 1 : 0,
        paths: packet.allowedPaths,
        exclusiveResources: packet.changeSurface?.exclusiveResources ?? [],
      };
      const current = this.#capacity.snapshot();
      const admitted = this.#capacity.tryReserve(
        current.generation,
        capacity,
        admissionCapacityLimits(
          this.#policy,
          resource,
          this.#run.objective,
          this.#fairness.localMaximum(
            this.#run.objective,
            Math.min(effective.capacity.local.maxWorkers, this.#controllerLimits.maxLocalWorkers),
            current.reservations,
          ),
          this.#controllerLimits,
        ),
      );
      if (!admitted.reserved) return null;
      let validation: CleanValidationResult | undefined;
      let providerStarted: Date | undefined;
      let providerCompleted: Date | undefined;
      let capacityRecorded = false;
      try {
        artifact = await reconstructArtifact();
        const scopedValidation = isolated
          ? undefined
          : await this.#scopedValidation(
              member.reservation,
              artifact,
              packet,
              new Date(
                Math.min(
                  Date.now() + this.#policy.workItemTimeoutMinutes * 60_000,
                  this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
                ),
              ),
            );
        await this.#lease.use((lease) =>
          this.#attempts.recordCapacity({
            lease,
            workItemNodeId: item.id,
            reservation: member.reservation,
            sequence: this.#sequences.take(),
            event: "CapacityReserved",
            phase: "validation",
            backend: capacityBackend,
            requestedCpu: capacity.cpu,
            requestedMemoryMb: capacity.memoryMb,
            allowRecovery: true,
            ...(scopedValidation ? { localScopeBatch: scopedValidation.batch } : {}),
          }),
        );
        capacityRecorded = true;
        assertDeadline();
        let validationDeadline = new Date(Date.now() + candidateTimeout);
        if (isolated) {
          const budget = await this.#lease.use(async (lease) => {
            const available = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
            const amount = Math.min(
              candidateTimeout,
              this.#run.startedAt.getTime() +
                this.#policy.objectiveTimeoutMinutes * 60_000 -
                Date.now(),
            );
            if (amount <= 0 || available.sandboxMinutes * 60_000 < amount)
              throw new Error(
                "sandbox-minute budget or deadline changed before merge-candidate reservation",
              );
            return this.#recorder.budget({
              lease,
              workItemNodeId: item.id,
              reservation: member.reservation,
              sequence: this.#sequences.take(),
              event: "BudgetReserved",
              phase: "validation",
              unit: "sandbox_milliseconds",
              amount,
              usageId: `integration-validation-${identityDigest}`,
            });
          });
          this.#budgetEvents.push(budget);
          if (budget.kind !== "budget")
            throw new Error("candidate reservation returned non-budget receipt");
          validationDeadline = new Date(
            Math.min(
              new Date(budget.at).getTime() + budget.amount,
              this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
            ),
          );
        }
        validation = await this.#externalAdmission(() =>
          validateArtifactClean({
            repository: this.#options.repository,
            artifact: artifact!,
            packet,
            ...(scopedValidation ? { localScope: scopedValidation.hooks } : {}),
            ...(validator
              ? {
                  isolatedValidator: () =>
                    this.#externalAdmission(async () => {
                      providerStarted = new Date();
                      const result = await validator!.validate!({
                        repository: `${this.#options.owner}/${this.#options.repo}`,
                        objective: member.reservation.objective,
                        workItem: item.number,
                        attempt: member.reservation.attempt,
                        runId: member.reservation.runId,
                        directorEpoch: member.reservation.directorEpoch,
                        policyDigest: member.reservation.policyDigest,
                        workspace: this.#options.repository,
                        packet,
                        artifact: artifact!,
                        policyNetworkDestinations: this.#policy.allowedNetworkDestinations,
                        deadline: validationDeadline,
                        validationInvocation: {
                          kind: "integration-candidate",
                          identityDigest,
                          artifactDigest: artifact!.digest,
                          baseSha: targetBaseSha,
                        },
                      });
                      providerCompleted = new Date();
                      return result;
                    }),
                }
              : {}),
          }),
        );
        if (!validation.evidence.passed) {
          await this.#recordCandidateValidationUsage(
            validation.evidence,
            identityDigest,
            item,
            member.reservation,
          );
          throw new Error(validation.evidence.failureReason ?? "merge-candidate validation failed");
        }
        record = await this.#lease.use((lease) =>
          this.#mergeCandidates.persist({
            lease,
            identity,
            source: member.pull.exactHeadValidation,
            validation: validation!.evidence,
            ...(isolated
              ? {
                  isolatedResource: {
                    backend: "codex-cli/daytona" as const,
                    invocationOwnershipDigest: invocationOwnership(artifact!.digest),
                    startedAt: providerStarted!.toISOString(),
                    completedAt: providerCompleted!.toISOString(),
                    sandboxMilliseconds: providerCompleted!.getTime() - providerStarted!.getTime(),
                  },
                }
              : {}),
          }),
        );
      } finally {
        try {
          if (validation) await discardValidationResult(validation);
          if (capacityRecorded && record) await reconcileCapacity(capacity.cpu, capacity.memoryMb);
        } finally {
          if (!capacityRecorded || record) this.#capacity.release(capacity.key);
        }
      }
    }
    await this.#recordCandidateValidationUsage(
      record.validation,
      identityDigest,
      item,
      member.reservation,
    );
    if (isolated)
      await this.#recordCandidateValidationUsage(
        record.validation,
        identityDigest,
        item,
        member.reservation,
        "sandbox_milliseconds",
        record.isolatedResource!.sandboxMilliseconds,
      );
    const reviewIdentity = this.#mergeCandidateReviewIdentity(record);
    const existingReview = await this.#reviews.load(reviewIdentity);
    const invocationId = `integration-review-${reviewIdentityDigest(reviewIdentity)}`;
    if (!existingReview && merged)
      throw new Error("merged sibling has no pre-merge semantic review checkpoint");
    let invokeReview:
      | ((
          checkpoint: Parameters<ManagementBackend["review"]>[1],
        ) => ReturnType<ManagementBackend["review"]>)
      | undefined;
    if (!existingReview) {
      assertDeadline();
      const budget = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
      if (budget.modelTokens !== null && budget.modelTokens <= 0)
        throw new Error(
          "model-token budget is exhausted; refusing integration-candidate semantic review",
        );
      this.#assertManagementInvocationNotFailed(invocationId);
      artifact ??= await reconstructArtifact();
      if (artifact.digest !== record.validation.artifactDigest)
        throw new Error("merge candidate no longer matches the original published patch");
      const reviewModel = resolveModelSelection(this.#policy, "review");
      invokeReview = (checkpoint) =>
        this.#externalAdmission(() =>
          this.#management.review(
            {
              repository: this.#options.repository,
              objectiveNumber: this.#run.objective,
              workItemNumber: item.number,
              packet,
              artifact: artifact!,
              evidence: record.validation,
              ...(reviewModel ? { modelSelection: reviewModel } : {}),
            },
            checkpoint,
          ),
        );
    }
    await runDurableReviewTransaction({
      existing: existingReview,
      ...(invokeReview ? { invoke: invokeReview } : {}),
      persist: (result) =>
        this.#lease.use((lease) =>
          this.#reviews.persist({ lease, identity: reviewIdentity, result }),
        ),
      recover: () => this.#reviews.load(reviewIdentity),
      recordUsage: (review) => this.#recordReviewUsage(review, item, member.reservation),
      recordFailureUsage: (usage) =>
        this.#recordFailedManagementUsage(invocationId, usage, item.id, member.reservation),
      recordOutcome: async (review) => {
        if (!review.review.accepted)
          throw new Error(
            `integration-candidate semantic review rejected: ${review.review.summary}; ${review.review.unmetCriteria.join("; ")}`,
          );
      },
    });
    return record;
  }

  async #appendSuccessorEvent(nodeId: string, event: FactoryEvent): Promise<void> {
    if (!this.#recoveryRuntime || event.runId !== this.#run.runId)
      throw new Error("successor event lacks its verified controlling run");
    try {
      await this.#lease.use(async () =>
        this.#store.addIssueComment(
          nodeId,
          encodeEventComment("Factory recorded evidence-preserving successor progress.", event),
        ),
      );
    } catch (error) {
      const snapshot = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(snapshot);
      if (
        !snapshotEvents(snapshot).some(
          (value) => recoveryEventDigest(value) === recoveryEventDigest(event),
        )
      )
        throw error;
      this.#sequences.observe(snapshotEvents(snapshot));
    }
    if (event.kind === "budget") this.#budgetEvents.push(event);
  }

  async #sourceUsage(
    item: DerivedWorkItem,
    usageId: string,
    amount: number,
    unit: "model_tokens" | "validation_milliseconds",
  ): Promise<void> {
    const existing = this.#budgetEvents.filter(
      (event) =>
        event.kind === "budget" &&
        event.runId === this.#run.runId &&
        event.workItem === item.number &&
        event.attempt === undefined &&
        event.unit === unit &&
        event.usageId === usageId &&
        event.event === "BudgetReconciled",
    );
    if (existing.some((event) => event.amount !== amount))
      throw new Error("successor usage conflicts with immutable evidence");
    if (existing.length) return;
    await this.#appendSuccessorEvent(
      item.id,
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "budget",
        event: "BudgetReconciled",
        objective: this.#run.objective,
        runId: this.#run.runId,
        sequence: this.#sequences.take(),
        at: (await this.#store.serverTime()).toISOString(),
        workItem: item.number,
        phase: unit === "model_tokens" ? "management" : "validation",
        unit,
        amount,
        usageId,
      }),
    );
  }

  async #restoreAdoptedPublication(item: DerivedWorkItem): Promise<void> {
    await this.#externalAdmission(async () => {});
    const runtime = this.#recoveryRuntime!;
    const artifact = await loadRecoverySourceArtifact({
      planRecord: runtime.planRecord,
      claim: runtime.claim,
      events: runtime.events,
      store: this.#recoveryStore,
      workItem: item.number,
    });
    const native = this.#deliverySelection.selected === "native-stacks";
    if (native && artifact.delivery.stack) {
      await this.#restoreNativeAdoptedStack(artifact);
      return;
    }
    let pull = await this.#store.findPullRequestForBranch(artifact.branch);
    if (!pull) {
      try {
        pull = await this.#lease.use(async () => {
          await this.#lease.assertGeneration("publication");
          if ((await this.#store.readRef(`refs/heads/${artifact.branch}`)) !== artifact.headSha)
            throw new Error("acknowledged source artifact branch changed before PR creation");
          const created = await this.#store.createPullRequest({
            title: item.title,
            body: `Implements Work Item #${item.number} for Objective #${this.#run.objective}.\n\nCloses #${item.number}\n\nRecovered exact validated source artifact; no replacement worker ran.`,
            head: artifact.branch,
            base: this.#baseBranch,
          });
          return { ...created, state: "open", merged: false };
        });
      } catch (error) {
        pull = await this.#store.findPullRequestForBranch(artifact.branch);
        if (!pull) throw error;
      }
    }
    if (pull.headSha !== artifact.headSha || (!pull.merged && pull.state !== "open"))
      throw new Error("recovered source PR differs from acknowledged artifact");
    const observed = await this.#store.readPullRequest(pull.number);
    if (!observed.nodeId) throw new Error("recovered source PR node identity unavailable");
    const publication = createRecoverySourcePublishedEvent({
      artifact,
      pullRequest: pull.number,
      pullRequestNodeId: observed.nodeId,
      baseBranch: this.#baseBranch,
      mode: native ? "native-stacks" : "regular-prs",
      sequence: this.#sequences.take(),
      at: (await this.#store.serverTime()).toISOString(),
    });
    const proof = await verifyRecoverySourcePublication({
      planRecord: runtime.planRecord,
      claim: runtime.claim,
      events: runtime.events,
      store: this.#recoveryStore,
      publication,
    });
    if (proof.status !== "verified")
      throw new Error("restored source publication evidence is unavailable");
    await this.#appendSuccessorEvent(item.id, publication);
  }

  async #restoreNativeAdoptedStack(first: RecoverySourceArtifactProof): Promise<void> {
    const runtime = this.#recoveryRuntime!;
    const unit = this.#deliveryPlan?.units.find((entry) => entry.id === first.delivery.unitId);
    if (unit?.kind !== "stack") throw new Error("acknowledged native source unit unavailable");
    const artifacts: RecoverySourceArtifactProof[] = [];
    const existingMembers: RecoveryNativeExistingMember[] = [];
    for (const compilerId of unit.items) {
      const item = runtime.planRecord.plan.items.find((entry) => entry.compilerId === compilerId)!;
      const source = item.source;
      if (item.action === "execute") continue;
      if (!source || !source.validation)
        throw new Error(
          "native source restoration requires complete independently validated unit artifacts",
        );
      if (!source.publication)
        artifacts.push(
          await loadRecoverySourceArtifact({
            planRecord: runtime.planRecord,
            claim: runtime.claim,
            events: runtime.events,
            store: this.#recoveryStore,
            workItem: item.workItem,
          }),
        );
      else {
        const publication = runtime.events.find(
          (event) => recoveryEventDigest(event) === source.publication!.receiptDigest,
        );
        if (publication?.kind !== "publication")
          throw new Error("original native publication unavailable");
        const head = await this.#store.readCommit(publication.headSha);
        existingMembers.push({
          publication,
          exactHeadValidation: bindValidationToPublishedHead({
            validation: {
              passed: true,
              digest: source.validation.evidenceDigest,
              baseSha: source.validation.baseSha,
              outputTreeSha: source.validation.outputTreeSha,
            },
            publishedHeadSha: publication.headSha,
            publishedBaseSha: publication.baseSha,
            publishedTreeSha: head.treeOid,
          }),
        });
      }
    }
    const pullRequests: Array<{ workItem: number; number: number; nodeId: string }> = [];
    for (const artifact of artifacts.sort((a, b) => a.delivery.position - b.delivery.position)) {
      const parent = artifact.delivery.parentItemId
        ? runtime.planRecord.plan.items.find(
            (entry) => entry.compilerId === artifact.delivery.parentItemId,
          )?.source
        : null;
      const base = parent?.publication?.branch ?? parent?.artifactHead?.branch ?? this.#baseBranch;
      if (artifact.delivery.position > 0 && !parent)
        throw new Error("native source parent branch unavailable");
      let pull = await this.#store.findPullRequestForBranch(artifact.branch);
      if (!pull) {
        try {
          pull = await this.#externalAdmission(() =>
            this.#lease.use(async () => {
              await this.#lease.assertGeneration("publication");
              if ((await this.#store.readRef(`refs/heads/${artifact.branch}`)) !== artifact.headSha)
                throw new Error("native source branch changed before publication");
              const title = runtime.graph.objective.workItems.find(
                (entry) => entry.id === artifact.delivery.itemId,
              )!.title;
              const created = await this.#store.createPullRequest({
                title,
                body: `Implements Work Item #${artifact.workItem} for Objective #${this.#run.objective}.\n\nCloses #${artifact.workItem}\n\nRecovered exact validated source artifact; no replacement worker ran.`,
                head: artifact.branch,
                base,
              });
              return { ...created, state: "open", merged: false };
            }),
          );
        } catch (error) {
          pull = await this.#store.findPullRequestForBranch(artifact.branch);
          if (!pull) throw error;
        }
      }
      const observed = await this.#store.readPullRequest(pull.number);
      if (
        !observed.nodeId ||
        observed.headSha !== artifact.headSha ||
        observed.baseRef !== base ||
        observed.merged ||
        observed.state !== "open"
      )
        throw new Error("native source PR differs from acknowledged branch");
      pullRequests.push({
        workItem: artifact.workItem,
        number: pull.number,
        nodeId: observed.nodeId,
      });
    }
    const linked = await ensureRecoveryNativeSourceStack({
      artifacts,
      existingMembers,
      pullRequests,
      store: this.#store,
      stacks: this.#stacks,
      baseBranch: this.#baseBranch,
      assertCurrent: async () => {
        await this.#externalAdmission(async () => {});
        await this.#lease.assertGeneration("publication");
      },
    });
    if (
      linked.status !== "observed" &&
      (artifacts.length !== 1 ||
        existingMembers.length !== 0 ||
        artifacts[0]!.delivery.position !== 0)
    )
      throw new Error("native source stack is incomplete");
    const recorded: FactoryEvent[] = [];
    for (const artifact of artifacts) {
      if (
        runtime.sourcePublications.some((proof) => proof.publication.workItem === artifact.workItem)
      )
        continue;
      const member =
        linked.status === "observed"
          ? linked.members.find((entry) => entry.workItem === artifact.workItem)!
          : {
              pullRequest: pullRequests[0]!.number,
              pullRequestNodeId: pullRequests[0]!.nodeId,
              baseBranch: this.#baseBranch,
            };
      const publication = createRecoverySourcePublishedEvent({
        artifact,
        pullRequest: member.pullRequest,
        pullRequestNodeId: member.pullRequestNodeId,
        baseBranch: member.baseBranch,
        mode: "native-stacks",
        ...(linked.status === "observed" ? { stackNumber: linked.stack.number } : {}),
        sequence: this.#sequences.take(),
        at: (await this.#store.serverTime()).toISOString(),
      });
      const proof = await verifyRecoverySourcePublication({
        planRecord: runtime.planRecord,
        claim: runtime.claim,
        events: [...runtime.events, ...recorded],
        store: this.#recoveryStore,
        publication,
      });
      if (proof.status !== "verified")
        throw new Error("native source publication proof unavailable");
      const item = runtime.planRecord.plan.items.find(
        (entry) => entry.workItem === artifact.workItem,
      )!;
      await this.#appendSuccessorEvent(item.issueNodeId, publication);
      recorded.push(publication);
    }
  }

  async #linkRecoveryNativeUnit(item: DerivedWorkItem): Promise<boolean> {
    const id = parseGraphItemMetadata(item.body ?? "").id;
    const unit = this.#deliveryPlan?.units.find((entry) => entry.items.includes(id));
    if (unit?.kind !== "stack") return true;
    const snapshot = await this.#reader.readObjective(this.#run.objective);
    this.#fenceSnapshot(snapshot);
    const objective = this.#deriveObjective(snapshot);
    const ordered = unit.items.map(
      (entry) =>
        objective.items.find(
          (candidate) => parseGraphItemMetadata(candidate.body ?? "").id === entry,
        )!,
    );
    if (ordered.some((member) => !member || !["done", "for_review"].includes(member.state)))
      return false;
    const members = await Promise.all(ordered.map((member) => this.#nativeStackMember(member)));
    const expected = members.map((member) => member.pull.number);
    const recordedNumbers = new Set<number>();
    for (const member of members) {
      if (member.receipt.stackNumber) recordedNumbers.add(member.receipt.stackNumber);
      for (const event of snapshotEvents(snapshot))
        if (
          event.kind === "publication" &&
          event.event === "StackLinked" &&
          (event.runId === this.#run.runId ||
            (event.runId === member.reservation.runId &&
              event.workItem === member.receipt.workItem &&
              event.attempt === member.reservation.attempt)) &&
          event.unitId === unit.id &&
          event.stackNumber
        )
          recordedNumbers.add(event.stackNumber);
    }
    if (recordedNumbers.size > 1)
      throw new Error("mixed native unit has conflicting stack identities");
    // Once integration has begun, verify the remaining observed membership;
    // never recreate a stack from rebased heads or infer it from an old link.
    if (ordered.some((member) => member.state === "done")) {
      const number = [...recordedNumbers][0];
      if (!number)
        throw new Error("partially integrated native unit has no durable stack identity");
      let stack = await this.#stacks.get(number);
      const remaining = members
        .filter((_, index) => ordered[index]!.state !== "done")
        .map((member) => member.pull.number);
      let observed = stack.pullRequests.map((pull) => pull.number);
      const complete = verifiedNativeStackSuffix(
        expected,
        expected.filter((number) => !remaining.includes(number)),
        observed,
      );
      if (!complete) throw new Error("partially integrated native stack membership changed");
      if (
        observed.length > 0 &&
        observed.length < complete.length &&
        observed.every((pull, index) => pull === complete[index])
      ) {
        const additions = members.filter((member) =>
          complete.slice(observed.length).includes(member.pull.number),
        );
        for (const member of additions) {
          if (
            member.reservation.runId !== this.#run.runId ||
            snapshotEvents(snapshot).some(
              (event) =>
                event.kind === "publication" &&
                event.event === "StackLinked" &&
                event.runId === this.#run.runId &&
                event.workItem === member.receipt.workItem,
            )
          )
            throw new Error("partially integrated native stack membership changed");
          const current = await this.#store.readPullRequest(member.pull.number);
          const index = members.indexOf(member);
          if (
            current.merged ||
            current.state !== "open" ||
            current.draft ||
            current.headSha !== member.pull.commitSha ||
            current.headRef !== member.receipt.branch ||
            current.baseSha !== member.receipt.baseSha ||
            current.baseRef !== members[index - 1]?.receipt.branch ||
            current.baseSha !== members[index - 1]?.observedHeadSha
          )
            throw new Error("fresh native extension differs from its validated parent");
        }
        await this.#serializeIntegration(async () => {
          await this.#lease.assertGeneration("publication");
          await this.#stacks.ensureExtended(
            number,
            observed,
            additions.map((member) => member.pull.number),
          );
        });
        stack = await this.#stacks.get(number);
        observed = stack.pullRequests.map((pull) => pull.number);
      }
      if (
        stack.number !== number ||
        !stack.open ||
        stack.baseRef !== this.#baseBranch ||
        JSON.stringify(observed) !== JSON.stringify(complete)
      )
        throw new Error("partially integrated native stack membership changed");
      for (const pull of stack.pullRequests) {
        const index = members.findIndex((member) => member.pull.number === pull.number);
        const current = await this.#store.readPullRequest(pull.number);
        if (
          current.headSha !== pull.headSha ||
          current.headRef !== pull.headRef ||
          current.headRef !== members[index]!.receipt.branch ||
          (ordered[index]!.state !== "done" &&
            current.baseRef !==
              (index === 0 || ordered[index - 1]!.state === "done"
                ? this.#baseBranch
                : members[index - 1]!.receipt.branch))
        )
          throw new Error("partially integrated native stack head/base observation changed");
      }
      for (const member of members) {
        if (member.reservation.runId !== this.#run.runId) continue;
        const recorded = snapshotEvents(snapshot).find(
          (event) =>
            event.kind === "publication" &&
            event.event === "StackLinked" &&
            event.runId === this.#run.runId &&
            event.workItem === member.receipt.workItem &&
            event.headSha === member.receipt.headSha,
        );
        if (recorded) continue;
        await this.#lease.use((lease) =>
          this.#recorder.publication({
            lease,
            workItemNodeId: ordered.find((entry) => entry.number === member.receipt.workItem)!.id,
            sequence: this.#sequences.take(),
            receipt: { ...member.receipt, revision: 2, state: "stack-linked", stackNumber: number },
            event: "StackLinked",
          }),
        );
      }
      await this.#lease.assertGeneration("integration");
      return true;
    }
    const assertMembers = async () => {
      await this.#externalAdmission(async () => {});
      for (const [index, member] of members.entries()) {
        const observed = await this.#store.readPullRequest(member.pull.number);
        if (
          observed.merged ||
          observed.state !== "open" ||
          observed.draft ||
          observed.headSha !== member.pull.commitSha ||
          observed.headRef !== member.receipt.branch ||
          observed.baseRef !== (index ? members[index - 1]!.receipt.branch : this.#baseBranch) ||
          observed.baseSha !== member.receipt.baseSha ||
          (index > 0 && observed.baseSha !== members[index - 1]!.pull.commitSha)
        )
          throw new Error("mixed native unit head/base evidence changed");
      }
    };
    await assertMembers();
    const stack = await this.#serializeIntegration(async () => {
      await this.#lease.assertGeneration("publication");
      const stackNumber = [...recordedNumbers][0];
      if (!stackNumber) return this.#stacks.ensureStack(expected);
      const current = await this.#stacks.get(stackNumber);
      const prefix = current.pullRequests.map((pull) => pull.number);
      if (
        !prefix.every((number, index) => number === expected[index]) ||
        prefix.length > expected.length
      )
        throw new Error("mixed native unit has foreign stack members");
      return prefix.length === expected.length
        ? current
        : this.#stacks.ensureExtended(stackNumber, prefix, expected.slice(prefix.length));
    });
    const observed = await this.#stacks.get(stack.number);
    if (
      !observed.open ||
      observed.baseRef !== this.#baseBranch ||
      JSON.stringify(observed.pullRequests.map((pull) => pull.number)) !==
        JSON.stringify(expected) ||
      observed.pullRequests.some(
        (pull, index) =>
          pull.headSha !== members[index]!.pull.commitSha ||
          pull.headRef !== members[index]!.receipt.branch,
      )
    )
      throw new Error("mixed native stack read-back differs from exact publication unit");
    await assertMembers();
    for (const member of members) {
      if (member.reservation.runId !== this.#run.runId) continue;
      const recorded = snapshotEvents(snapshot).find(
        (event) =>
          event.kind === "publication" &&
          event.event === "StackLinked" &&
          event.runId === this.#run.runId &&
          event.workItem === member.receipt.workItem &&
          event.headSha === member.receipt.headSha,
      );
      const linked: PublicationReceipt = {
        ...member.receipt,
        revision: 2,
        state: "stack-linked",
        stackNumber: observed.number,
      };
      if (recorded?.kind === "publication") assertPublicationEventMatchesReceipt(recorded, linked);
      else
        await this.#lease.use((lease) =>
          this.#recorder.publication({
            lease,
            workItemNodeId: ordered.find((entry) => entry.number === member.receipt.workItem)!.id,
            sequence: this.#sequences.take(),
            receipt: linked,
            event: "StackLinked",
          }),
        );
    }
    return true;
  }

  async #resumeAdoptedSource(item: DerivedWorkItem): Promise<void> {
    let runtime = this.#recoveryRuntime!;
    const planItem = runtime.planRecord.plan.items.find((entry) => entry.workItem === item.number)!;
    const source = planItem.source!;
    if (this.#deliverySelection.selected === "native-stacks") {
      const unit = this.#deliveryPlan?.units.find((entry) =>
        entry.items.includes(planItem.compilerId),
      );
      const missing =
        unit?.kind === "stack"
          ? runtime.planRecord.plan.items.find(
              (entry) =>
                unit.items.includes(entry.compilerId) &&
                entry.action !== "execute" &&
                entry.source &&
                !entry.source.publication &&
                !runtime.sourcePublications.some(
                  (proof) => proof.publication.workItem === entry.workItem,
                ),
            )
          : undefined;
      if (missing) {
        const snapshot = await this.#reader.readObjective(this.#run.objective);
        const unresolved = this.#deriveObjective(snapshot).items.find(
          (entry) => entry.number === missing.workItem,
        )!;
        await this.#restoreAdoptedPublication(unresolved);
        await this.#resumeObservedRun(
          await this.#reader.readObjective(this.#run.objective),
          new RunManager(this.#store),
        );
        runtime = this.#recoveryRuntime!;
      }
    }
    if (
      !source.publication &&
      !runtime.sourcePublications.some((proof) => proof.publication.workItem === item.number)
    ) {
      await this.#restoreAdoptedPublication(item);
      await this.#resumeObservedRun(
        await this.#reader.readObjective(this.#run.objective),
        new RunManager(this.#store),
      );
      runtime = this.#recoveryRuntime!;
    }
    const restored = runtime.sourcePublications.find(
      (proof) => proof.publication.workItem === item.number,
    );
    const publication =
      source.publication ??
      (restored
        ? recoverySourcePublicationBinding(restored.publication, runtime.planRecord.plan.repository)
        : null);
    if (!publication) throw new Error("source publication receipt unavailable");
    const existingOutcome = runtime.sourceIntegrations.find(
      (entry) => entry.outcome.workItem === item.number,
    );
    if (existingOutcome) {
      await this.#lease.assertGeneration("integration");
      if (!item.closed) await this.#store.closeIssue(item.number);
      return;
    }
    if (source.priorDelivery) {
      await this.#externalAdmission(async () => {});
      runtime = this.#recoveryRuntime!;
      const prior = await verifyPriorRecoveryDelivery({
        plan: runtime.planRecord.plan,
        item: planItem,
        events: runtime.events,
        store: this.#recoveryStore,
      });
      const outcome = createRecoverySourceIntegratedEvent({
        planRecord: runtime.planRecord,
        claim: runtime.claim,
        workItem: item.number,
        mergeCommitSha: prior.outcome.mergeCommitSha,
        ...(prior.outcome.mergeCandidateIdentityDigest
          ? { mergeCandidateIdentityDigest: prior.outcome.mergeCandidateIdentityDigest }
          : {}),
        ...(prior.outcome.deliveryHeadSha
          ? { deliveryHeadSha: prior.outcome.deliveryHeadSha }
          : {}),
        sequence: this.#sequences.take(),
        at: (await this.#store.serverTime()).toISOString(),
      });
      const proof = await verifyRecoverySourceIntegration({
        planRecord: runtime.planRecord,
        claim: runtime.claim,
        events: runtime.events,
        store: this.#recoveryStore,
        outcome,
      });
      if (proof.status !== "verified")
        throw new Error("prior source delivery could not be independently verified");
      await this.#lease.assertGeneration("integration");
      await this.#appendSuccessorEvent(item.id, outcome);
      if (!item.closed) await this.#store.closeIssue(item.number);
      return;
    }
    const reserved = (await this.#attempts.list(this.#run.objective, item.number)).find(
      (entry) => entry.runId === source.runId && entry.attempt === source.attempt,
    );
    if (!reserved) throw new Error("adopted source reservation is unavailable");
    const head = await this.#store.readCommit(publication.headSha);
    const exactHeadValidation = bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: source.validation!.evidenceDigest,
        baseSha: source.validation!.baseSha,
        outputTreeSha: source.validation!.outputTreeSha,
      },
      publishedHeadSha: publication.headSha,
      publishedTreeSha: head.treeOid,
      publishedBaseSha: publication.baseSha,
    });
    const pull: PublishedPullRequest = {
      number: publication.pullRequest,
      branch: publication.branch,
      commitSha: publication.headSha,
      htmlUrl: `https://github.com/${this.#options.owner}/${this.#options.repo}/pull/${publication.pullRequest}`,
      exactHeadValidation,
    };
    const observed = await this.#store.readPullRequest(pull.number);
    if (
      !observed.merged &&
      this.#deliverySelection.selected === "native-stacks" &&
      !(await this.#linkRecoveryNativeUnit(item))
    )
      return;
    let deliveryHeadSha: string | undefined;
    if (observed.headSha !== pull.commitSha || observed.baseRef !== this.#baseBranch) {
      if (publication.mode !== "native-stacks")
        throw new Error("adopted ordinary source head/base changed");
      const transition = await observeRecoveryNativeTransition({
        planRecord: runtime.planRecord,
        events: runtime.events,
        store: this.#recoveryStore,
        workItem: item.number,
      });
      if (
        transition.deliveryHeadSha !== observed.headSha ||
        transition.sourceHeadSha !== pull.commitSha
      )
        throw new Error("native source transition changed during observation");
      if (observed.headSha !== pull.commitSha) deliveryHeadSha = observed.headSha;
    }
    if (observed.baseRef !== this.#baseBranch || (!observed.merged && observed.state !== "open"))
      throw new Error(
        "adopted publication changed; original source authority cannot be relabelled",
      );
    const target = observed.merged
      ? (await this.#store.readCommit(observed.mergeCommitSha!)).parentOids[0]!
      : (await this.#store.getBranchHead(this.#baseBranch)).oid;
    let candidate: MergeCandidateCheckpointRecord | undefined;
    if (target !== exactHeadValidation.baseSha) {
      const identity: MergeCandidateIdentity = {
        runId: this.#run.runId,
        objective: this.#run.objective,
        workItem: item.number,
        attempt: source.attempt,
        pullRequest: pull.number,
        sourceHeadSha: pull.commitSha,
        sourceExactHeadValidationDigest: exactHeadValidation.digest,
        targetBaseSha: target,
      };
      const digest = mergeCandidateIdentityDigest(identity);
      const backendId = `factory/integration-validation-${digest}`;
      candidate = (await this.#mergeCandidates.load(identity)) ?? undefined;
      if (!candidate && observed.merged)
        throw new Error("merged adopted source lacks pre-merge validation");
      if (!observed.merged)
        await this.#assertOwnTrunkAdvance(
          runtime.planRecord.plan.expectedBaseSha,
          target,
          item.number,
        );
      const original = this.#packetFor(item.number);
      if (original.requirements.trust !== "trusted_local")
        throw new Error("adopted source validation requires trusted local scope");
      const packet = parseWorkerPacket({ ...original, baseSha: target });
      const deadline = new Date(
        this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
      );
      let artifact: NormalizedArtifact | undefined;
      const reconstruct = async () => {
        for (const sha of [exactHeadValidation.baseSha, pull.commitSha, target])
          await ensureLocalCommit(this.#options.repository, sha);
        const range = [exactHeadValidation.baseSha, pull.commitSha];
        const changedPaths = (
          await hostGit(
            this.#options.repository,
            ["diff", "--name-only", "-z", ...range],
            MAX_ARTIFACT_PATCH_BYTES + 1024,
            true,
          )
        )
          .split("\0")
          .filter(Boolean);
        const patch = await hostGit(
          this.#options.repository,
          ["diff", "--binary", "--no-ext-diff", "--no-textconv", ...range],
          MAX_ARTIFACT_PATCH_BYTES + 1024,
          true,
        );
        return normalizeArtifact({ baseSha: target, changedPaths, patch, outcome: "succeeded" });
      };
      const outstanding = unreconciledCapacityReservations([...runtime.events]).filter(
        (event) =>
          event.runId === this.#run.runId &&
          event.workItem === item.number &&
          event.backend === backendId,
      );
      const recordCapacity = async (
        event: "CapacityReserved" | "CapacityReconciled",
        cpu: number,
        memoryMb: number,
        batch?: LocalScopeBatch,
      ) =>
        this.#appendSuccessorEvent(
          item.id,
          parseFactoryEvent({
            protocol: "clockgrove.factory/v2",
            kind: "capacity",
            event,
            objective: this.#run.objective,
            runId: this.#run.runId,
            workItem: item.number,
            attempt: source.attempt,
            sourceRunId: source.runId,
            targetBaseSha: target,
            directorEpoch: await this.#lease.use(async (lease) => lease.epoch),
            policyDigest: this.#run.policyDigest,
            phase: "validation",
            backend: backendId,
            sequence: this.#sequences.take(),
            at: (await this.#store.serverTime()).toISOString(),
            requestedCpu: cpu,
            requestedMemoryMb: memoryMb,
            ...(batch ? { localScopeBatch: batch } : {}),
          }),
        );
      if (!candidate && outstanding.length)
        throw new Error("interrupted adopted validation requires exact scope reconciliation");
      if (candidate)
        for (const entry of outstanding)
          await recordCapacity("CapacityReconciled", entry.requestedCpu, entry.requestedMemoryMb);
      if (!candidate) {
        const effective = normalizeSchedulingPolicy(this.#policy);
        const resource =
          effective.capacity.mode === "adaptive-local"
            ? await this.#resourceSampler.sample(Date.now()).catch(() => null)
            : null;
        if (
          effective.capacity.mode === "adaptive-local" &&
          (!resource ||
            resourcePressureReasons(resource, effective.capacity.local).length ||
            this.#resourceSampler.coolingDown(Date.now()))
        )
          return;
        const capacity: CapacityReservation = {
          key: capacityReservationKey({
            objective: this.#run.objective,
            workItem: item.number,
            attempt: source.attempt,
            phase: "validation",
            backendId,
          }),
          objective: this.#run.objective,
          workItem: item.number,
          attempt: source.attempt,
          phase: "validation",
          backendId,
          admissionClass: "local",
          local: true,
          cpu: packet.requirements.cpu ?? effective.capacity.local.defaultCpu,
          memoryMb: packet.requirements.memoryMb ?? effective.capacity.local.defaultMemoryMb,
          paidUnits: 0,
          paths: packet.allowedPaths,
          exclusiveResources: packet.changeSurface?.exclusiveResources ?? [],
        };
        const state = this.#capacity.snapshot();
        if (
          !this.#capacity.tryReserve(
            state.generation,
            capacity,
            admissionCapacityLimits(
              this.#policy,
              resource,
              this.#run.objective,
              Math.min(effective.capacity.local.maxWorkers, this.#controllerLimits.maxLocalWorkers),
              this.#controllerLimits,
            ),
          ).reserved
        )
          return;
        let validation: CleanValidationResult | undefined;
        let recorded = false;
        try {
          artifact = await reconstruct();
          const scope = await this.#scopedValidation(
            {
              objective: this.#run.objective,
              runId: this.#run.runId,
              workItem: item.number,
              attempt: source.attempt,
              policyDigest: this.#run.policyDigest,
            },
            artifact,
            packet,
            deadline,
          );
          if (!scope) throw new Error("adopted validation requires observable owned local scopes");
          await recordCapacity("CapacityReserved", capacity.cpu, capacity.memoryMb, scope.batch);
          recorded = true;
          validation = await this.#externalAdmission(() =>
            validateArtifactClean({
              repository: this.#options.repository,
              artifact: artifact!,
              packet,
              localScope: scope.hooks,
            }),
          );
          if (!validation.evidence.passed) {
            await this.#sourceUsage(
              item,
              `integration-validation-${digest}`,
              Date.parse(validation.evidence.completedAt) -
                Date.parse(validation.evidence.startedAt),
              "validation_milliseconds",
            );
            throw new Error(
              validation.evidence.failureReason ?? "adopted candidate validation failed",
            );
          }
          candidate = await this.#lease.use((lease) =>
            this.#mergeCandidates.persist({
              lease,
              identity,
              source: exactHeadValidation,
              validation: validation!.evidence,
            }),
          );
        } finally {
          try {
            if (validation) await discardValidationResult(validation);
            if (recorded && candidate)
              await recordCapacity("CapacityReconciled", capacity.cpu, capacity.memoryMb);
          } finally {
            if (!recorded || candidate) this.#capacity.release(capacity.key);
          }
        }
      }
      await this.#sourceUsage(
        item,
        `integration-validation-${digest}`,
        Date.parse(candidate.validation.completedAt) - Date.parse(candidate.validation.startedAt),
        "validation_milliseconds",
      );
      const reviewIdentity = this.#mergeCandidateReviewIdentity(candidate);
      const existing = await this.#reviews.load(reviewIdentity);
      if (!existing && observed.merged)
        throw new Error("merged adopted source lacks pre-merge semantic review");
      const invocationId = `integration-review-${reviewIdentityDigest(reviewIdentity)}`;
      let invoke: Parameters<typeof runDurableReviewTransaction>[0]["invoke"];
      if (!existing) {
        if (Date.now() >= deadline.getTime())
          throw new Error("successor Objective timeout exhausted");
        const remaining = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
        if (remaining.modelTokens !== null && remaining.modelTokens <= 0)
          throw new Error("cumulative model-token budget exhausted");
        this.#assertManagementInvocationNotFailed(invocationId);
        artifact ??= await reconstruct();
        if (artifact.digest !== candidate.validation.artifactDigest)
          throw new Error("adopted candidate artifact changed");
        const model = resolveModelSelection(this.#policy, "review");
        invoke = (checkpoint) =>
          this.#externalAdmission(() =>
            this.#management.review(
              {
                repository: this.#options.repository,
                objectiveNumber: this.#run.objective,
                workItemNumber: item.number,
                packet,
                artifact: artifact!,
                evidence: candidate!.validation,
                ...(model ? { modelSelection: model } : {}),
              },
              checkpoint,
            ),
          );
      }
      await runDurableReviewTransaction({
        existing,
        ...(invoke ? { invoke } : {}),
        persist: (result) =>
          this.#lease.use((lease) =>
            this.#reviews.persist({ lease, identity: reviewIdentity, result }),
          ),
        recover: () => this.#reviews.load(reviewIdentity),
        recordUsage: (review) =>
          this.#sourceUsage(
            item,
            invocationId,
            review.usage.inputTokens + review.usage.outputTokens,
            "model_tokens",
          ),
        recordFailureUsage: (usage) =>
          this.#sourceUsage(
            item,
            `failed-${invocationId}`,
            usage.inputTokens + usage.outputTokens,
            "model_tokens",
          ),
        recordOutcome: async (review) => {
          if (!review.review.accepted)
            throw new Error("adopted candidate semantic review rejected");
        },
      });
    } else if (!observed.merged && target !== runtime.planRecord.plan.expectedBaseSha) {
      await this.#assertOwnTrunkAdvance(
        runtime.planRecord.plan.expectedBaseSha,
        target,
        item.number,
      );
    }
    await this.#integrate(
      item,
      reserved,
      pull,
      this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
      true,
      candidate,
      true,
      deliveryHeadSha,
    );
  }

  #integrationDue(workItem: number): boolean {
    return (this.#integrationWaits.get(workItem)?.until ?? 0) <= Date.now();
  }

  #deferIntegration(workItem: number, reason: string): false {
    const previous = this.#integrationWaits.get(workItem);
    const interval = Math.max(1, Math.min(this.#options.pollIntervalMs ?? 60_000, 60_000));
    const delay = Math.min(previous ? previous.delay * 2 : interval, interval * 5);
    this.#integrationWaits.set(workItem, { until: Date.now() + delay, delay, reason });
    if (previous?.reason !== reason)
      this.#notify(`Work Item #${workItem} integration waiting: ${reason}`);
    return false;
  }

  async #integrate(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    pull: PublishedPullRequest,
    deadline: number,
    allowRecovery = false,
    candidate?: MergeCandidateCheckpointRecord,
    adoptedSource = false,
    deliveryHeadSha?: string,
  ): Promise<boolean> {
    for (;;) {
      await this.#lease.renewIfNeeded();
      const readiness = await this.#serializeIntegration(async () => {
        const validatedBase =
          candidate?.identity.targetBaseSha ??
          (adoptedSource ? pull.exactHeadValidation.baseSha : reservation.baseSha);
        if (candidate) {
          const observed = await this.#store.readPullRequest(pull.number);
          if (!observed.merged && observed.baseSha !== candidate.identity.targetBaseSha) {
            return {
              state: "wait" as const,
              reason:
                "waiting for GitHub pull-request base metadata to match the validated candidate",
            };
          }
        }
        const current = await integrationReadiness(
          this.#store,
          pull,
          validatedBase,
          this.#baseBranch,
          {
            ciExpected: this.#ciExpectedOnPullRequests,
            ...(candidate ? { mergeCandidateValidation: candidate.evidence } : {}),
            ...(deliveryHeadSha ? { mergeCandidateDeliveryHeadSha: deliveryHeadSha } : {}),
          },
        );
        if (current.state !== "ready") return current;
        if (candidate) {
          // REST mergeable/test-merge metadata can lag a trunk update. Check GitHub's
          // actual proposed tree as well as our clean application before any merge.
          const preview = await this.#store.readPullRequest(pull.number);
          if (
            preview.headSha !== (deliveryHeadSha ?? pull.commitSha) ||
            preview.baseRef !== this.#baseBranch
          ) {
            return {
              state: "failed" as const,
              reason: "pull request changed before candidate merge",
            };
          }
          if (preview.merged || preview.mergeable !== true || !preview.mergeCommitSha) {
            return {
              state: "wait" as const,
              reason: "waiting for current GitHub test-merge evidence",
            };
          }
          const testMerge = await this.#store.readCommit(preview.mergeCommitSha);
          if (
            testMerge.oid !== preview.mergeCommitSha ||
            testMerge.parentOids.length !== 2 ||
            testMerge.parentOids[0] !== candidate.identity.targetBaseSha ||
            testMerge.parentOids[1] !== (deliveryHeadSha ?? pull.commitSha)
          ) {
            return {
              state: "wait" as const,
              reason: "GitHub test-merge evidence is stale for the validated candidate",
            };
          }
          if (testMerge.treeOid !== candidate.validation.outputTreeSha) {
            return {
              state: "failed" as const,
              reason: "GitHub test-merge tree differs from the independently validated candidate",
            };
          }
        }
        const currentBase = await this.#store.getBranchHead(this.#baseBranch);
        if (currentBase.oid !== validatedBase) {
          return {
            state: candidate ? ("wait" as const) : ("failed" as const),
            reason:
              `base branch advanced from validated commit ${validatedBase} ` +
              `to ${currentBase.oid}`,
          };
        }
        const currentRules = await this.#store.readBranchRules(this.#baseBranch);
        const blockers = branchRuleBlockers(currentRules);
        if (blockers.length > 0) {
          return {
            state: "failed" as const,
            reason: `branch policy changed and now requires HITL: ${blockers.join(", ")}`,
          };
        }
        if (requiredChecks(currentRules).length > 0) {
          const missing = missingRequiredChecks(
            currentRules,
            await this.#store.readChecks(current.headSha),
          );
          if (missing.length > 0) {
            return {
              state: "wait" as const,
              reason: `required checks have not appeared yet: ${missing.join(", ")}`,
            };
          }
        }
        await this.#lease.assertGeneration("integration");
        const mergeSha = await this.#store.mergePullRequest({
          number: pull.number,
          headSha: current.headSha,
          commitTitle: item.title,
        });
        try {
          if (candidate) {
            await verifyMergeCandidateSquash(
              this.#store,
              pull.exactHeadValidation,
              candidate.evidence,
              mergeSha,
            );
          } else {
            await verifySquashIntegration(this.#store, pull, mergeSha, validatedBase);
          }
        } catch (error) {
          return {
            state: "failed" as const,
            reason:
              `irreversible merge did not preserve validated state: ` +
              (error instanceof Error ? error.message : String(error)),
          };
        }
        return { state: "integrated" as const, headSha: mergeSha };
      });
      if (readiness.state === "integrated") {
        this.#integrationWaits.delete(item.number);
        await this.#lease.assertGeneration("integration");
        if (adoptedSource) {
          const runtime = this.#recoveryRuntime!;
          const outcome = createRecoverySourceIntegratedEvent({
            planRecord: runtime.planRecord,
            claim: runtime.claim,
            workItem: item.number,
            ...(runtime.sourcePublications.find(
              (proof) => proof.publication.workItem === item.number,
            )
              ? {
                  sourcePublication: runtime.sourcePublications.find(
                    (proof) => proof.publication.workItem === item.number,
                  )!.publication,
                }
              : {}),
            mergeCommitSha: readiness.headSha,
            sequence: this.#sequences.take(),
            at: (await this.#store.serverTime()).toISOString(),
            ...(candidate
              ? { mergeCandidateIdentityDigest: mergeCandidateIdentityDigest(candidate.identity) }
              : {}),
            ...(deliveryHeadSha ? { deliveryHeadSha } : {}),
          });
          const proof = await verifyRecoverySourceIntegration({
            planRecord: runtime.planRecord,
            claim: runtime.claim,
            events: [
              ...runtime.events,
              ...this.#budgetEvents.filter((event) => event.runId === this.#run.runId),
            ],
            store: this.#recoveryStore,
            outcome,
          });
          if (proof.status !== "verified")
            throw new Error("adopted source integration evidence is unavailable");
          await this.#appendSuccessorEvent(item.id, outcome);
          if (!item.closed) await this.#store.closeIssue(item.number);
          return true;
        }
        if (!item.closed) await this.#store.closeIssue(item.number);
        const alreadyRecorded = (item.factoryEvents ?? []).some(
          (candidate) =>
            candidate.kind === "attempt" &&
            candidate.runId === reservation.runId &&
            candidate.attempt === reservation.attempt &&
            candidate.event === "AttemptIntegrated",
        );
        if (!alreadyRecorded) {
          await this.#lease.use((lease) =>
            this.#attempts.record({
              lease,
              workItemNodeId: item.id,
              reservation,
              event: "AttemptIntegrated",
              sequence: this.#sequences.take(),
              headSha: readiness.headSha,
              ...(allowRecovery ? { allowRecovery: true } : {}),
            }),
          );
        }
        return true;
      }
      if (readiness.state === "failed") throw new Error(readiness.reason);
      if (Date.now() >= deadline) {
        throw new Error(`integration timed out: ${readiness.reason}`);
      }
      // A pending check is controller state, not a worker-sized blocking task.
      // Return after one observation so stale resources, other reviews, and
      // newly-ready work can progress on the next snapshot.
      return this.#deferIntegration(item.number, readiness.reason);
    }
  }

  async #resumeIntegration(item: DerivedWorkItem): Promise<boolean> {
    if (!this.#integrationDue(item.number)) return false;
    if (this.#deliverySelection.selected === "native-stacks") {
      const member = await this.#nativeStackMember(item);
      const current = await this.#store.readPullRequest(member.pull.number);
      if (
        current.headSha !== member.pull.commitSha ||
        current.baseRef !== this.#baseBranch ||
        (current.state !== "open" && !current.merged)
      ) {
        throw new Error("sibling pull request identity or target changed after publication");
      }
      let targetBaseSha: string;
      if (current.merged) {
        if (!current.mergeCommitSha) throw new Error("merged sibling has no merge commit identity");
        const merge = await this.#store.readCommit(current.mergeCommitSha);
        if (merge.parentOids.length !== 1) throw new Error("merged sibling is not a squash commit");
        targetBaseSha = merge.parentOids[0]!;
      } else {
        targetBaseSha = (await this.#store.getBranchHead(this.#baseBranch)).oid;
      }
      const candidate =
        targetBaseSha === member.pull.exactHeadValidation.baseSha
          ? undefined
          : await this.#prepareSiblingMergeCandidate(item, member, targetBaseSha, current.merged);
      if (candidate === null) {
        return this.#deferIntegration(
          item.number,
          "waiting for merge-candidate validation capacity",
        );
      }
      return await this.#integrate(
        item,
        member.reservation,
        member.pull,
        this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
        true,
        candidate,
      );
    }
    const event = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (candidate) =>
          candidate.kind === "attempt" &&
          candidate.runId === this.#run.runId &&
          candidate.event === "AttemptPublished" &&
          Boolean(candidate.headSha),
      );
    if (!event || event.kind !== "attempt" || !event.headSha) {
      throw new Error(`Work Item #${item.number} has review state without a published attempt`);
    }
    const reservation = (await this.#attempts.list(this.#run.objective, item.number)).find(
      (candidate) => candidate.runId === this.#run.runId && candidate.attempt === event.attempt,
    );
    if (!reservation) throw new Error(`attempt ${event.attempt} reservation is missing`);
    const backend = this.#registry.get(reservation.backend);
    if (!backend) {
      throw new Error(`cannot resume unavailable backend ${reservation.backend}`);
    }
    const publicationEvent = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (candidate): candidate is Extract<FactoryEvent, { kind: "publication" }> =>
          candidate.kind === "publication" &&
          candidate.runId === this.#run.runId &&
          candidate.event === "PublicationRecorded" &&
          candidate.attempt === event.attempt &&
          candidate.headSha === event.headSha,
      );
    const managed = backend.capabilities.providerManagedPublication;
    const branch = managed
      ? `github-managed/pr-${publicationEvent?.pullRequest ?? "unknown"}`
      : publicationBranch(this.#run.objective, item.number, event.attempt);
    let pull: {
      number: number;
      htmlUrl: string;
      state: string;
      merged: boolean;
      headSha: string;
    } | null;
    if (managed) {
      let pullNumber = publicationEvent?.pullRequest;
      if (!pullNumber) {
        const started = [...(item.factoryEvents ?? [])]
          .sort((left, right) => left.sequence - right.sequence)
          .find(
            (candidate) =>
              candidate.kind === "attempt" &&
              candidate.runId === this.#run.runId &&
              candidate.attempt === event.attempt &&
              candidate.event === "AttemptStarted",
          );
        pullNumber = selectManagedRecoveryPull(
          item.linkedPullRequests,
          started?.at,
          event.headSha,
        )?.number;
      }
      if (!pullNumber) {
        throw new Error(`Work Item #${item.number} has no unambiguous managed pull request`);
      }
      const current = await this.#store.readPullRequest(pullNumber);
      pull = {
        number: pullNumber,
        htmlUrl: `https://github.com/${this.#options.owner}/${this.#options.repo}/pull/${pullNumber}`,
        state: current.state,
        merged: current.merged,
        headSha: current.headSha,
      };
    } else {
      pull = await this.#store.findPullRequestForBranch(branch);
    }
    if (!pull) {
      throw new Error(`Work Item #${item.number} has no recoverable Factory pull request`);
    }
    if (pull.headSha !== event.headSha) {
      throw new Error(`Work Item #${item.number} pull request differs from its published head`);
    }
    if (pull.state !== "open" && !pull.merged) {
      throw new Error(`Work Item #${item.number} pull request was closed without merge`);
    }
    const validation = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (candidate) =>
          candidate.kind === "validation" &&
          candidate.runId === this.#run.runId &&
          candidate.attempt === event.attempt &&
          candidate.passed,
      );
    if (!validation || validation.kind !== "validation") {
      throw new Error(`attempt ${event.attempt} has no passing validation receipt`);
    }
    const commit = await this.#store.readCommit(event.headSha);
    if (
      !managed &&
      (commit.parentOids.length !== 1 || commit.parentOids[0] !== validation.baseSha)
    ) {
      throw new Error(
        `Work Item #${item.number} published commit does not descend from its validated base`,
      );
    }
    const exactHeadValidation = bindValidationToPublishedHead({
      validation: {
        passed: validation.passed,
        digest: validation.evidenceDigest,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
      },
      publishedHeadSha: event.headSha,
      publishedTreeSha: commit.treeOid,
      publishedBaseSha: validation.baseSha,
    });
    const metadata = parseGraphItemMetadata(item.body ?? "");
    const receipt: PublicationReceipt = {
      protocol: PUBLICATION_RECEIPT_PROTOCOL,
      runId: this.#run.runId,
      unitId: `delivery/${metadata.id}`,
      itemId: metadata.id,
      workItem: item.number,
      attempt: event.attempt,
      revision: 1,
      mode: "regular-prs",
      position: 0,
      branch: managed ? `github-managed/pr-${pull.number}` : branch,
      baseBranch: this.#baseBranch,
      baseSha: validation.baseSha,
      headSha: event.headSha,
      pullRequest: pull.number,
      capabilityVersion: this.#deliverySelection.capabilityVersion,
      exactHeadValidation,
      state: "published",
    };
    if (pull.merged) {
      // Closing the issue is not acceptance evidence. Recover only an already
      // accepted publication; never review or validate a completed merge anew.
      const accepted = (item.factoryEvents ?? []).some(
        (candidate) =>
          candidate.kind === "attempt" &&
          candidate.runId === this.#run.runId &&
          candidate.event === "AttemptValidated" &&
          candidate.attempt === event.attempt &&
          candidate.artifactDigest === event.artifactDigest &&
          candidate.sequence < event.sequence,
      );
      const review = event.artifactDigest
        ? await this.#reviews.load({
            kind: "artifact",
            runId: this.#run.runId,
            objective: this.#run.objective,
            workItem: item.number,
            attempt: event.attempt,
            artifactDigest: event.artifactDigest,
            baseSha: validation.baseSha,
            outputTreeSha: validation.outputTreeSha,
            evidenceDigest: validation.evidenceDigest,
          })
        : null;
      if (!accepted || !review?.review.accepted || review.review.unmetCriteria.length)
        throw new Error("completed ordinary integration lacks its original acceptance checkpoint");
    }
    if (publicationEvent) {
      assertPublicationEventMatchesReceipt(publicationEvent, receipt);
    } else {
      await this.#lease.use((lease) =>
        this.#recorder.publication({
          lease,
          workItemNodeId: item.id,
          sequence: this.#sequences.take(),
          receipt,
          event: "PublicationRecorded",
          reason: "recovered publication receipt before integration",
        }),
      );
    }
    return await this.#integrate(
      item,
      reservation,
      {
        branch: receipt.branch,
        commitSha: event.headSha,
        number: pull.number,
        htmlUrl: pull.htmlUrl,
        exactHeadValidation,
      },
      this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
      true,
    );
  }

  async #serializeIntegration<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#options.repositoryResources) {
      return this.#options.repositoryResources.integration(operation);
    }
    let release!: () => void;
    const previous = this.#integrationTail;
    this.#integrationTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #reconcileInterruptedValidationCapacity(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    events: readonly FactoryEvent[],
  ): Promise<void> {
    const validationFinished = events.some(
      (event) =>
        event.kind === "validation" &&
        event.workItem === item.number &&
        event.attempt === reservation.attempt,
    );
    for (const capacity of unreconciledCapacityReservations(events)) {
      if (
        capacity.phase !== "validation" ||
        capacity.workItem !== item.number ||
        capacity.attempt !== reservation.attempt
      ) {
        continue;
      }
      if (isIntegrationValidationBackend(capacity.backend)) {
        throw new Error(
          "integration-candidate capacity requires its exact completion checkpoint; ordinary validation cannot reconcile it",
        );
      }
      if (!validationFinished && capacity.backend !== "factory/local-validation") {
        const backend = this.#registry.get(capacity.backend);
        if (!backend?.reconcileStale) {
          throw new Error(
            `validation backend ${capacity.backend} cannot prove its stale resource was stopped`,
          );
        }
        const validationCapacityEvent = events.find(
          (event) =>
            event.kind === "capacity" &&
            event.event === "CapacityReserved" &&
            event.phase === "validation" &&
            event.workItem === item.number &&
            event.attempt === reservation.attempt,
        );
        const packet = this.#packetFor(item.number);
        const validationTimeoutMs =
          (packet.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000;
        const noHandleReplacementNotBefore = validationCapacityEvent
          ? new Date(
              new Date(validationCapacityEvent.at).getTime() + validationTimeoutMs + 60_000,
            ).toISOString()
          : undefined;
        await backend.reconcileStale({
          repository: `${this.#options.owner}/${this.#options.repo}`,
          objective: reservation.objective,
          workItem: reservation.workItem,
          attempt: reservation.attempt,
          runId: reservation.runId,
          directorEpoch: reservation.directorEpoch,
          phase: "validation",
          ...(noHandleReplacementNotBefore ? { noHandleReplacementNotBefore } : {}),
        });
      }
      await this.#lease.use((lease) =>
        this.#attempts.recordCapacity({
          lease,
          workItemNodeId: item.id,
          reservation,
          sequence: this.#sequences.take(),
          event: "CapacityReconciled",
          phase: "validation",
          backend: capacity.backend,
          requestedCpu: capacity.requestedCpu,
          requestedMemoryMb: capacity.requestedMemoryMb,
          reason: validationFinished
            ? "recovered completed validation capacity"
            : "recovered interrupted validation capacity after proving the resource absent",
          allowRecovery: true,
        }),
      );
    }
  }

  async #recoverInterrupted(
    item: DerivedWorkItem,
    deadline: number,
    objectiveItems: readonly DerivedWorkItem[],
  ): Promise<void> {
    const reservations = (await this.#attempts.list(this.#run.objective, item.number))
      .filter((candidate) => candidate.runId === this.#run.runId)
      .sort((a, b) => b.attempt - a.attempt);
    const reservation = reservations[0];
    if (!reservation) {
      throw new Error(`Work Item #${item.number} has recoverable state but no attempt ref`);
    }
    const backend = this.#registry.get(reservation.backend);
    if (!backend) {
      throw new Error(`cannot reconcile unavailable backend ${reservation.backend}`);
    }
    const events = (item.factoryEvents ?? [])
      .filter(
        (event) =>
          event.runId === this.#run.runId &&
          "attempt" in event &&
          event.attempt === reservation.attempt,
      )
      .sort((a, b) => a.sequence - b.sequence);
    const latest = [...events].reverse().find((event) => event.kind === "attempt");
    const validation = [...events].reverse().find((event) => event.kind === "validation");
    let semanticallyAccepted = events.some(
      (event) => event.kind === "attempt" && event.event === "AttemptValidated",
    );

    await this.#reconcileInterruptedValidationCapacity(item, reservation, events);

    if (validation?.kind === "validation" && validation.passed && !semanticallyAccepted) {
      const collected = [...events]
        .reverse()
        .find(
          (event) =>
            event.kind === "attempt" &&
            event.event === "AttemptCollected" &&
            Boolean(event.artifactDigest),
        );
      if (collected?.kind === "attempt" && collected.artifactDigest) {
        const identity: ReviewIdentity = {
          kind: "artifact",
          runId: this.#run.runId,
          objective: this.#run.objective,
          workItem: item.number,
          attempt: reservation.attempt,
          artifactDigest: collected.artifactDigest,
          baseSha: validation.baseSha,
          outputTreeSha: validation.outputTreeSha,
          evidenceDigest: validation.evidenceDigest,
        };
        const checkpoint = await this.#reviews.load(identity);
        if (checkpoint) {
          await runDurableReviewTransaction({
            existing: checkpoint,
            persist: async () => checkpoint,
            recover: () => this.#reviews.load(identity),
            recordUsage: (record) => this.#recordReviewUsage(record, item, reservation),
            recordOutcome: (record) => this.#recordInitialReviewOutcome(record, item, reservation),
          });
          semanticallyAccepted = checkpoint.review.accepted;
        }
      }
    }

    if (validation?.kind === "validation" && validation.passed && semanticallyAccepted) {
      if (backend.capabilities.providerManagedPublication) {
        const attemptPublished = [...events]
          .reverse()
          .find(
            (event) =>
              event.kind === "attempt" &&
              event.event === "AttemptPublished" &&
              Boolean(event.headSha),
          );
        const publicationEvent = [...events]
          .reverse()
          .find(
            (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
              event.kind === "publication" && event.event === "PublicationRecorded",
          );
        const attemptStartedAt = events.find(
          (event) => event.kind === "attempt" && event.event === "AttemptStarted",
        )?.at;
        const correlated = publicationEvent
          ? null
          : selectManagedRecoveryPull(
              item.linkedPullRequests,
              attemptStartedAt,
              attemptPublished?.kind === "attempt" ? attemptPublished.headSha : undefined,
            );
        const pullNumber = publicationEvent?.pullRequest ?? correlated?.number;
        if (pullNumber) {
          const currentPull = await this.#store.readPullRequest(pullNumber);
          const expectedHead =
            publicationEvent?.headSha ??
            (attemptPublished?.kind === "attempt" ? attemptPublished.headSha : correlated?.headSha);
          if (!expectedHead || currentPull.headSha !== expectedHead) {
            throw new Error(
              `managed recovery pull request #${pullNumber} differs from its durable head`,
            );
          }
          if (
            currentPull.baseRef !== this.#baseBranch ||
            (!currentPull.merged && currentPull.baseSha !== validation.baseSha)
          ) {
            throw new Error(
              `managed recovery pull request #${pullNumber} targets a different base`,
            );
          }
          if (currentPull.state !== "open" && !currentPull.merged) {
            throw new Error(
              `managed recovery pull request #${pullNumber} was closed without merge`,
            );
          }
          const commit = await this.#store.readCommit(expectedHead);
          if (commit.treeOid !== validation.outputTreeSha) {
            throw new Error(
              `managed recovery pull request #${pullNumber} does not match the validated tree`,
            );
          }
          const exactHeadValidation = bindValidationToPublishedHead({
            validation: {
              passed: validation.passed,
              digest: validation.evidenceDigest,
              baseSha: validation.baseSha,
              outputTreeSha: validation.outputTreeSha,
            },
            publishedHeadSha: expectedHead,
            publishedTreeSha: commit.treeOid,
            publishedBaseSha: validation.baseSha,
          });
          const metadata = parseGraphItemMetadata(item.body ?? "");
          const receipt: PublicationReceipt = {
            protocol: PUBLICATION_RECEIPT_PROTOCOL,
            runId: this.#run.runId,
            unitId: publicationEvent?.unitId ?? `delivery/${metadata.id}`,
            itemId: publicationEvent?.itemId ?? metadata.id,
            workItem: item.number,
            attempt: reservation.attempt,
            revision: 1,
            mode: "regular-prs",
            position: 0,
            branch: publicationEvent?.branch ?? `github-managed/pr-${pullNumber}`,
            baseBranch: this.#baseBranch,
            baseSha: validation.baseSha,
            headSha: expectedHead,
            pullRequest: pullNumber,
            capabilityVersion: this.#deliverySelection.capabilityVersion,
            exactHeadValidation,
            state: "published",
          };
          if (publicationEvent?.kind === "publication") {
            assertPublicationEventMatchesReceipt(publicationEvent, receipt);
          }
          if (!attemptPublished) {
            await this.#lease.use((lease) =>
              this.#attempts.record({
                lease,
                workItemNodeId: item.id,
                reservation,
                event: "AttemptPublished",
                sequence: this.#sequences.take(),
                headSha: expectedHead,
                ...(latest?.kind === "attempt" && latest.artifactDigest
                  ? { artifactDigest: latest.artifactDigest }
                  : {}),
                allowRecovery: true,
              }),
            );
          }
          if (!publicationEvent) {
            await this.#lease.use((lease) =>
              this.#recorder.publication({
                lease,
                workItemNodeId: item.id,
                sequence: this.#sequences.take(),
                receipt,
                event: "PublicationRecorded",
                reason: "recovered interrupted managed-agent publication",
              }),
            );
          }
          await this.#integrate(
            item,
            reservation,
            {
              branch: receipt.branch,
              commitSha: receipt.headSha,
              number: receipt.pullRequest,
              htmlUrl: `https://github.com/${this.#options.owner}/${this.#options.repo}/pull/${receipt.pullRequest}`,
              exactHeadValidation,
            },
            deadline,
            true,
          );
          return;
        }
      }
      const branch = publicationBranch(this.#run.objective, item.number, reservation.attempt);
      const headSha = await this.#store.readRef(`refs/heads/${branch}`);
      if (headSha) {
        const commit = await this.#store.readCommit(headSha);
        if (commit.treeOid !== validation.outputTreeSha) {
          throw new Error(
            `recovery branch for Work Item #${item.number} does not match validated tree`,
          );
        }
        if (commit.parentOids.length !== 1 || commit.parentOids[0] !== validation.baseSha) {
          throw new Error(
            `recovery branch for Work Item #${item.number} does not descend from its validated base`,
          );
        }
        const stackMetadata =
          this.#deliverySelection.selected === "native-stacks"
            ? parseGraphItemMetadata(item.body ?? "")
            : undefined;
        const stackPlan = stackMetadata
          ? this.#deliveryPlan?.items.find((candidate) => candidate.itemId === stackMetadata.id)
          : undefined;
        if (stackMetadata && !stackPlan) {
          throw new Error(`Work Item ${stackMetadata.id} is absent from the delivery plan`);
        }
        let recoveryBaseBranch = this.#baseBranch;
        if (stackPlan?.parentItemId) {
          const parent = objectiveItems.find(
            (candidate) =>
              parseGraphItemMetadata(candidate.body ?? "").id === stackPlan.parentItemId,
          );
          const parentPublished = [...(parent?.factoryEvents ?? [])]
            .sort((left, right) => right.sequence - left.sequence)
            .find(
              (event) =>
                event.kind === "attempt" &&
                event.runId === this.#run.runId &&
                event.event === "AttemptPublished" &&
                Boolean(event.headSha),
            );
          if (
            !parent ||
            !parentPublished ||
            parentPublished.kind !== "attempt" ||
            !parentPublished.headSha
          ) {
            throw new Error(
              `stack parent ${stackPlan.parentItemId} has no recoverable publication`,
            );
          }
          recoveryBaseBranch = publicationBranch(
            this.#run.objective,
            parent.number,
            parentPublished.attempt,
          );
          const parentHead = await this.#store.getBranchHead(recoveryBaseBranch);
          if (
            parentHead.oid !== validation.baseSha ||
            parentPublished.headSha !== validation.baseSha
          ) {
            throw new Error(
              `stack parent ${stackPlan.parentItemId} changed after the child was validated`,
            );
          }
        }
        await this.#lease.assert();
        let existing = await this.#store.findPullRequestForBranch(branch);
        if (existing && existing.state !== "open" && !existing.merged) {
          throw new Error(`recovery pull request #${existing.number} was closed without merge`);
        }
        if (!existing) {
          try {
            existing = {
              ...(await this.#store.createPullRequest({
                title: item.title,
                body:
                  `Implements Work Item #${item.number} for Objective #${this.#run.objective}.\n\n` +
                  `Closes #${item.number}\n\n` +
                  `Recovered validation: \`${validation.evidenceDigest}\``,
                head: branch,
                base: recoveryBaseBranch,
              })),
              state: "open",
              merged: false,
            };
          } catch (error) {
            existing = await this.#store.findPullRequestForBranch(branch);
            if (!existing || existing.state !== "open") throw error;
          }
        }
        const pull = existing;
        if (pull.headSha !== headSha) {
          throw new Error("recovered pull request head differs from the validated branch");
        }
        const currentPull = await this.#store.readPullRequest(pull.number);
        if (
          currentPull.baseRef !== recoveryBaseBranch ||
          (!currentPull.merged && currentPull.baseSha !== validation.baseSha)
        ) {
          throw new Error(
            "recovered pull request base differs from the validated publication base",
          );
        }
        await this.#lease.use((lease) =>
          this.#attempts.record({
            lease,
            workItemNodeId: item.id,
            reservation,
            event: "AttemptPublished",
            sequence: this.#sequences.take(),
            headSha,
            ...(latest?.kind === "attempt" && latest.artifactDigest
              ? { artifactDigest: latest.artifactDigest }
              : {}),
            allowRecovery: true,
          }),
        );
        if (this.#deliverySelection.selected === "native-stacks") {
          const metadata = stackMetadata!;
          const itemPlan = stackPlan!;
          const exactHeadValidation = bindValidationToPublishedHead({
            validation: {
              passed: validation.passed,
              digest: validation.evidenceDigest,
              baseSha: validation.baseSha,
              outputTreeSha: validation.outputTreeSha,
            },
            publishedHeadSha: headSha,
            publishedTreeSha: commit.treeOid,
            publishedBaseSha: validation.baseSha,
          });
          await this.#lease.use((lease) =>
            this.#recorder.publication({
              lease,
              workItemNodeId: item.id,
              sequence: this.#sequences.take(),
              receipt: {
                protocol: PUBLICATION_RECEIPT_PROTOCOL,
                runId: this.#run.runId,
                unitId: itemPlan.unitId,
                itemId: metadata.id,
                workItem: item.number,
                attempt: reservation.attempt,
                revision: 1,
                mode: "native-stacks",
                position: itemPlan.position,
                ...(itemPlan.parentItemId ? { parentItemId: itemPlan.parentItemId } : {}),
                branch,
                baseBranch: currentPull.baseRef,
                baseSha: validation.baseSha,
                headSha,
                pullRequest: pull.number,
                capabilityVersion: this.#deliverySelection.capabilityVersion,
                exactHeadValidation,
                state: "published",
              },
              event: "PublicationRecorded",
              reason: "recovered interrupted stack publication",
            }),
          );
          return;
        }
        await this.#integrate(
          item,
          reservation,
          {
            branch,
            commitSha: headSha,
            number: pull.number,
            htmlUrl: pull.htmlUrl,
            exactHeadValidation: bindValidationToPublishedHead({
              validation: {
                passed: validation.passed,
                digest: validation.evidenceDigest,
                baseSha: validation.baseSha,
                outputTreeSha: validation.outputTreeSha,
              },
              publishedHeadSha: headSha,
              publishedTreeSha: commit.treeOid,
              publishedBaseSha: validation.baseSha,
            }),
          },
          deadline,
          true,
        );
        return;
      }
    }

    if (backend.capabilities.providerManagedPublication) {
      const attemptStartedAt = events.find(
        (event) => event.kind === "attempt" && event.event === "AttemptStarted",
      )?.at;
      const stalePull = selectManagedRecoveryPull(item.linkedPullRequests, attemptStartedAt);
      if (stalePull) {
        const current = await this.#store.readPullRequest(stalePull.number);
        if (current.merged) {
          throw new Error(
            `unvalidated managed pull request #${stalePull.number} was already merged`,
          );
        }
        if (current.state === "open") {
          await this.#store.closePullRequest(stalePull.number);
        }
      }
    }
    const providerResourceId = latest?.kind === "attempt" ? latest.providerResourceId : undefined;
    const executionBudget = unreconciledBudgetReservations(events).find(
      (budget) => budget.phase === "execution",
    );
    const noHandleReplacementNotBefore =
      !providerResourceId && executionBudget?.unit === "sandbox_milliseconds"
        ? new Date(
            new Date(executionBudget.at).getTime() + executionBudget.amount + 60_000,
          ).toISOString()
        : undefined;
    if (backend.reconcileStale) {
      await backend.reconcileStale({
        repository: `${this.#options.owner}/${this.#options.repo}`,
        objective: reservation.objective,
        workItem: reservation.workItem,
        attempt: reservation.attempt,
        runId: reservation.runId,
        directorEpoch: reservation.directorEpoch,
        phase: "execution",
        ...(providerResourceId ? { providerResourceId } : {}),
        ...(noHandleReplacementNotBefore ? { noHandleReplacementNotBefore } : {}),
      });
    } else if (
      events.some((event) => event.kind === "attempt" && event.event === "AttemptStarted")
    ) {
      throw new Error(`backend ${reservation.backend} cannot prove the stale resource was stopped`);
    }
    const attemptStartedAt = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptStarted",
    )?.at;
    const validationCouldHaveStartedAt = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptCollected",
    )?.at;
    for (const budget of unreconciledBudgetReservations(events)) {
      const phaseStart =
        budget.phase === "validation" ? validationCouldHaveStartedAt : attemptStartedAt;
      const elapsed = phaseStart ? Math.max(0, Date.now() - new Date(phaseStart).getTime()) : 0;
      const ambiguousPaidLaunch =
        budget.phase === "execution" && budget.unit === "sandbox_milliseconds" && !attemptStartedAt;
      const amount =
        budget.unit === "managed_sessions" || ambiguousPaidLaunch
          ? budget.amount
          : Math.min(budget.amount, elapsed);
      await this.#lease.use(async (lease) => {
        const event = await this.#recorder.budget({
          lease,
          workItemNodeId: item.id,
          reservation,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled",
          unit: budget.unit,
          phase: budget.phase,
          amount,
        });
        this.#budgetEvents.push(event);
      });
    }
    const validationFailure = validation?.kind === "validation" && !validation.passed;
    await this.#lease.use((lease) =>
      this.#attempts.record({
        lease,
        workItemNodeId: item.id,
        reservation,
        event: validationFailure ? "AttemptFailed" : "AttemptDeferred",
        sequence: this.#sequences.take(),
        reason: validationFailure
          ? "independent validation failed before its terminal attempt receipt"
          : "prior Director stopped before producing a durable publishable artifact; infrastructure interruption does not consume a Work Item attempt",
        allowRecovery: true,
      }),
    );
  }

  #hasUnfinishedAttempt(item: DerivedWorkItem): boolean {
    const attempts = (item.factoryEvents ?? []).filter(
      (event): event is Extract<FactoryEvent, { kind: "attempt" }> =>
        event.kind === "attempt" && event.runId === this.#run.runId,
    );
    const latestAttempt = attempts.reduce((highest, event) => Math.max(highest, event.attempt), 0);
    if (latestAttempt === 0) return false;
    const latest = attempts.filter((event) => event.attempt === latestAttempt);
    return !latest.some((event) =>
      [
        "AttemptFailed",
        "AttemptTimedOut",
        "AttemptCancelled",
        "AttemptDeferred",
        "AttemptIntegrated",
      ].includes(event.event),
    );
  }

  async #repairReservationReceipts(items: DerivedWorkItem[]): Promise<boolean> {
    let repaired = false;
    for (const item of items) {
      const comments = item.factoryEvents ?? [];
      const reservations = await this.#attempts.list(this.#run.objective, item.number);
      for (const reservation of reservations) {
        if (reservation.runId !== this.#run.runId) continue;
        const recorded = comments.some(
          (event) =>
            event.kind === "attempt" &&
            event.event === "AttemptReserved" &&
            event.attempt === reservation.attempt &&
            event.runId === reservation.runId,
        );
        if (recorded) continue;
        await this.#lease.use((lease) =>
          this.#attempts.repairReservationComment({
            lease,
            workItemNodeId: item.id,
            reservation,
          }),
        );
        repaired = true;
      }
    }
    return repaired;
  }

  async #escalate(
    runManager: RunManager,
    snapshot: Snapshot,
    item: DerivedWorkItem,
    reason: string,
  ): Promise<SupervisorResult> {
    await this.#lease.assert();
    await this.#store.assignIssue(item.number, this.#run.actor);
    return this.#terminal(
      runManager,
      snapshot,
      "FactoryRunEscalated",
      `Work Item #${item.number}: ${reason}`,
    );
  }

  async #terminal(
    runManager: RunManager,
    snapshot: Snapshot,
    event: "FactoryRunCompleted" | "FactoryRunCancelled" | "FactoryRunEscalated",
    reason?: string,
  ): Promise<SupervisorResult> {
    await this.#lease.assert();
    await runManager.terminal({
      run: this.#run,
      objectiveNodeId: snapshot.id,
      event,
      sequence: this.#sequences.take(),
      ...(reason ? { reason } : {}),
    });
    await this.#lease.release();
    return {
      status:
        event === "FactoryRunCompleted"
          ? "completed"
          : event === "FactoryRunCancelled"
            ? "cancelled"
            : "escalated",
      objective: snapshot.number,
      runId: this.#run.runId,
      ...(reason ? { reason } : {}),
    };
  }

  async #releaseForShutdown(snapshot: Snapshot): Promise<SupervisorResult> {
    await this.#lease.release();
    return {
      status: "cancelled",
      objective: snapshot.number,
      runId: this.#run.runId,
      reason: "repository controller stopped; durable run remains active",
    };
  }

  async #releaseForDrain(snapshot: Snapshot): Promise<SupervisorResult> {
    await this.#lease.release();
    return {
      status: "drained",
      objective: snapshot.number,
      runId: this.#run.runId,
      reason: "run drained; admitted work is reconciled and the durable run remains resumable",
    };
  }

  async #startlessEscalation(
    reason: string,
    snapshot?: Snapshot,
    actor?: string,
  ): Promise<SupervisorResult> {
    let durableReason = reason.slice(0, 8_000);
    try {
      assertNoSecretMaterial(durableReason, "activation rejection reason");
    } catch {
      durableReason =
        "activation was rejected before run start; detailed diagnostic was withheld because it may contain secret material";
    }
    this.#notify(`preflight blocked: ${durableReason}`);
    const activation = this.#options.activation;
    if (activation && snapshot && actor) {
      const events = snapshotEvents(snapshot);
      const linkedStart = events.some(
        (event) =>
          event.kind === "run" &&
          event.event === "FactoryRunStarted" &&
          event.activationRequestId === activation.requestId,
      );
      const prior = events.find(
        (event) =>
          event.kind === "run" &&
          event.event === "ActivationRejected" &&
          event.activationRequestId === activation.requestId &&
          event.runId === activation.requestId,
      );
      if (!linkedStart && !prior) {
        const now = await this.#store.serverTime();
        const event = parseFactoryEvent({
          protocol: PROTOCOL_V2,
          kind: "run",
          event: "ActivationRejected",
          objective: snapshot.number,
          runId: activation.requestId,
          sequence: nextEventSequence(events),
          at: now.toISOString(),
          activationRequestId: activation.requestId,
          requestedBy: actor,
          baseSha: activation.baseSha,
          policyDigest: policyDigest(this.#policy),
          reason: durableReason,
        });
        await this.#store.addIssueComment(
          snapshot.id,
          encodeEventComment(
            `Factory rejected activation \`${activation.requestId}\` before run start.`,
            event,
          ),
        );
      } else if (prior?.event === "ActivationRejected") {
        durableReason = prior.reason;
      }
    }
    return {
      status: "escalated",
      objective: this.#options.objective,
      runId: "not-started",
      reason: durableReason,
    };
  }
}
