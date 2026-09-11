import { createHash, randomUUID } from "node:crypto";
import { EXECUTION_AFFECTING_GIT_PATHS, executionAffectingReason } from "./approval.js";
import { assertPeerActivation } from "./recovery/peer-trunk.js";
import {
  withIntegrationAdmission,
  IntegrationAdmissionPendingError,
} from "./control/integration-admission.js";
import { reconcileAdmissionForSuccessor } from "./control/admission-reassignment.js";
import { observeLocalScopeBatch } from "./recovery/scope-resources.js";
import { dirname, resolve } from "node:path";

import { CodexCliLocalBackend } from "./backends/codex-cli-local.js";
import { CodexSdkLocalBackend } from "./backends/codex-sdk-local.js";
import {
  CodexAppServerLocalBackend,
  appServerHandleFromCheckpoint,
} from "./backends/codex-app-server.js";
import {
  holdAppServerQualificationCheckpoint,
  SafeArtifactCheckpointHeldError,
  SafeArtifactCheckpointShutdownError,
} from "./runtime/qualification-checkpoint.js";
import {
  holdArtifactTransferQualificationCheckpoint,
  proveArtifactTransferQualificationReceipts,
} from "./runtime/artifact-transfer-qualification-checkpoint.js";
import { AppServerSessionManager } from "./control/app-server-sessions.js";
import {
  completeSessionUsage,
  type AppServerSessionJournal,
} from "./execution/app-server-session.js";
import {
  GITHUB_MANAGED_AGENT_PROFILES,
  GitHubManagedAgentBackend,
  resolveManagedAgentActor,
} from "./backends/github-copilot.js";
import { DaytonaBackend } from "./backends/daytona.js";
import { VercelSandboxBackend } from "./backends/vercel-sandbox.js";
import { validationInvocationOwnership } from "./backends/validation-invocation.js";
import {
  buildAdmissionSettlementEvidence,
  hasOriginalAdmissionProducerCompletion,
} from "./control/admission-settlement.js";
import {
  AttemptManager,
  listAttemptReservationRefs,
  type AttemptAdmissionBinding,
  type AttemptReservation,
} from "./control/attempts.js";
import {
  artifactRecoveryCopyAvailable,
  persistArtifactTransfer,
  resumeArtifactTransfer,
  type ArtifactTransferIdentity,
  type ArtifactTransferIntentCheckpoint,
} from "./control/artifact-transfers.js";
import { activationCancellation, type ActivationBinding } from "./control/activations.js";
import {
  deriveBudgetUsage,
  remainingBudget,
  unreconciledBudgetReservations,
  unresolvedModelInvocations,
  assertModelInvocationAdmission,
  isModelInvocationMarker,
  mergeAccountingSnapshot,
  modelInvocationKey,
  type ModelInvocationIdentity,
} from "./control/budget.js";
import { ModelInvocationScopes } from "./control/model-invocations.js";
import {
  assertNewRunBudgetIntent,
  assertSupportedModelTokenBudgetIntent,
} from "./protocol/budget-intent.js";
import {
  type AdmissionGateCommand,
  deriveDurableCommandState,
  type DurableCommandState,
} from "./control/commands.js";
import { LifecycleRecorder } from "./control/events.js";
import {
  CompiledGraphManager,
  loadCompiledGraph,
  loadCompiledGraphProjection,
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
import type {
  SharedCapacityCoordinator,
  SharedCapacityOwner,
} from "./controller/shared-capacity.js";
import { materializePinnedCompilationTree } from "./execution/pinned-compilation-tree.js";
import {
  assertLocalLfsAvailable,
  materializeLocalLfsAssets,
} from "./repository-profiles/git-lfs.js";
import {
  DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
  DEFAULT_LEASE_RENEWAL_LEAD_MS,
  LeaseLostError,
  LeaseManager,
  type LeaseState,
  type GitCommitObject,
} from "./control/lease.js";
import {
  deduplicateFactoryEvents,
  encodeEventComment,
  nextEventSequence,
  latestSupportedRun,
  hasCurrentWriterAuthority,
} from "./control/receipts.js";
import { assertAuthenticatedCompilationCheckpoint } from "./control/compilation-checkpoint.js";
import { inspectObjectiveGraphInput } from "./control/objective-graph-input.js";
import { RunManager, type RunState } from "./control/runs.js";
import {
  loadRecoveryRuntime,
  type RecoveryGraphBootstrapRuntime,
  type RecoveryRuntime,
} from "./recovery/runtime.js";
import { nativeSourceRequiresIsolation } from "./execution/native-ancestry-trust.js";
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
import { observeRecoverySiblingRefresh } from "./recovery/sibling-refresh.js";
import {
  createRecoverySourceIntegratedEvent,
  verifyRecoverySourceIntegration,
  verifyPriorRecoveryDelivery,
  verifyRecoveryMergedSource,
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
  SiblingRefreshStore,
  loadSiblingRefreshLineage,
  verifyPlannedSiblingRefreshCommit,
  type SiblingRefreshIdentity,
  type SiblingRefreshRecord,
} from "./control/sibling-refreshes.js";
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
import {
  ValidationCheckpointManager,
  type ValidationIdentity,
} from "./control/validation-checkpoints.js";
import {
  parseFactoryEvent,
  type AttemptEvent,
  type FactoryEvent,
  type ProviderQuotaEvent,
  type PublicationEvent,
} from "./protocol/events.js";
import { assertIsolatedCandidateFailureProof } from "./recovery/isolated-candidate.js";
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
import { isRecoveryAdoptionGraph } from "./recovery/plan.js";
import {
  BackendRegistry,
  NoExecutionBackendError,
  type BackendCandidate,
} from "./execution/registry.js";
import type {
  BackendHandle,
  BackendObservation,
  ExecutionBackend,
  ExecutionUsage,
} from "./execution/backend.js";
import { ProviderResourceCleanupError } from "./execution/backend.js";
import {
  MAX_ARTIFACT_PATCH_BYTES,
  assertArtifactScope,
  type NormalizedArtifact,
} from "./execution/artifacts.js";
import { bindArtifactManifest } from "./runtime/artifact-patch.js";
import { retainArtifactContent } from "./execution/artifact-content.js";
import {
  retainScopedArtifact,
  withArtifactContentScope,
} from "./execution/artifact-content-scope.js";
import { Dispatcher, GithubOctokitWriter } from "./dispatch.js";
import {
  assertCompiledObjectiveAdoptsLegacyConstraints,
  assertExistingGraphWorkItemsMatchCompiled,
  executionWorkerPacketFromCompiled,
  GraphApplier,
  GithubOctokitGraphWriter,
  legacyGraphConstraintsDigest,
  parseGraphItemMetadata,
  type CompiledObjective,
  type ExistingGraphWorkItem,
  type LegacyGraphConstraints,
} from "./graph.js";
import { GitHubReader, type GitHubOptions } from "./github.js";
import { CodexCliManagementBackend } from "./management/codex-cli.js";
import {
  compileEvaluatedDraft,
  assertCompilerDraftSelection,
} from "./management/draft-compilation.js";
import { CompilerDraftManager, loadCompilerDrafts } from "./control/compiler-drafts.js";
import { compilerEvalDigest } from "./evaluation/compiler-eval.js";
import { collectCompilationEvidence } from "./compiler/runtime-evidence.js";
import { ManagementOutputError } from "./management/backend.js";
import { preserveProviderQuotaError, ProviderQuotaError } from "./providers/quota.js";
import { providerQuotaGates, providerQuotaGateState } from "./control/provider-gates.js";
import { reportedModelUsage, type ReportedModelUsage } from "./protocol/model-usage.js";
import type {
  CompilationCheckpoint,
  CompilationContext,
  CompilationResult,
  ManagementBackend,
  ManagementUsage,
  ReviewContext,
  ReviewCheckpoint,
  ReviewResult,
} from "./management/backend.js";
import {
  assertPublicationMutationAuthorized,
  dispatchPublicationMutation,
  integrationReadiness,
  publicationBranch,
  publishValidated,
  verifySquashIntegration,
  type PublishedPullRequest,
} from "./publication/publisher.js";
import { prepareSiblingRefreshTree } from "./publication/sibling-refresh-tree.js";
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
import { selectEquivalentPublicationRecord } from "./publication/recorded-publication.js";
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
import { artifactFromGitRange } from "./runtime/artifact-patch.js";
import { allDone, derive, queuedState, ready, type DerivedWorkItem } from "./state.js";
import { queuedReasonCode } from "./explanations/index.js";
import { COPILOT_ASSIGNEE_LOGIN } from "./types.js";
import {
  admissionCapacityLimits,
  localMemoryFits,
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
  type CapacityLimits,
  type CapacityReservation,
  type CapacityReservationResult,
  type CapacitySnapshot,
} from "./scheduling/capacity-ledger.js";
import { rankReadyWorkItems } from "./scheduling/priority.js";
import { validatePriorityFieldDefinition } from "./scheduling/github-priority.js";
import {
  ClaimedExecutionFailure,
  ContinuousExecutionPool,
} from "./scheduling/continuous-refill.js";
import { ObjectiveFairness } from "./scheduling/fairness.js";
import { waitForProgress } from "./scheduling/progress-wake.js";
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
import {
  assertReviewOnlyWorkflowArtifacts,
  isReviewOnlyWorkflowSurface,
} from "./publication/workflow-safety.js";
import {
  bindValidationToPublishedHead,
  bootstrapPackageValidationCommand,
  validationLocalCommandCount,
  validationPlanFromPacket,
} from "./validation/plan.js";
import {
  activateManagedRuntimePacket,
  assertManagedRuntimeActivationCurrent,
  assertRepositoryCapabilityProofsCurrent,
  createManagedRuntimeActivation,
  managedRuntimeRequirements,
  packetWithManagedRuntimeActivation,
  resolveIntegratedRepositoryCapabilities,
  toolchainAdapterById,
  type CapabilityProviderIdentity,
  type RepositoryCapabilityProof,
} from "./toolchains/authority.js";
import type { ManagedRuntimeActivation } from "./protocol/worker-packet.js";
import {
  discoverLocalScopeHost,
  observeLocalScope,
  stopLocalScope,
} from "./runtime/local-scope.js";
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

class CancellationAccountingPublicationError extends Error {
  constructor(cause: unknown) {
    super(
      `cancelled execution usage receipt could not be persisted: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "CancellationAccountingPublicationError";
  }
}

class ControllerObservationRetiredError extends Error {
  constructor() {
    super("repository-controller observation retired before dispatch");
    this.name = "ControllerObservationRetiredError";
  }
}

class ExecutionSourceAdvancedBeforeDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionSourceAdvancedBeforeDispatchError";
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
  /** Durable repository-wide capacity authority supplied by production hosts. */
  sharedCapacity?: SharedCapacityCoordinator;
  /** A service stop releases ownership without durably cancelling the run. */
  shutdownBehavior?: "cancel-run" | "release-lease";
  /** Durable controller activation fence. Foreground runs omit this. */
  activation?: { requestId: string; baseSha: string };
  /** Exact acknowledged successor; selects complete authenticated recovery history reads. */
  recovery?: { requestId: string; planDigest: string; successorRunId: string };
  /** Current fenced repository-controller identity, sampled for durable status.
   * A retired discovery generation returns undefined; Objective authority then
   * remains observable solely through the current Objective writer. */
  controllerObservation?: () => ControllerObservation | undefined;
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
  sharedCapacity?: SharedCapacityCoordinator;
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
  kind?: "trunk" | "stack";
  requiresIsolation?: boolean;
}

/** Already collected execution, never a replacement worker. A successor-owned
 * artifact-consumer reservation may carry predecessor bytes into validation
 * without copying predecessor execution usage into the successor ledger. */
interface CollectedAttemptContinuation {
  reservation: AttemptReservation;
  packet: WorkerPacket;
  artifact: NormalizedArtifact;
  modelTokens?: number;
  modelUsage?: ReportedModelUsage & { inputTokens: number; outputTokens: number };
  nativeUsage: {
    unit: "local_milliseconds" | "sandbox_milliseconds" | "managed_sessions";
    amount: number;
  };
  adoptedSource?: {
    reservation: AttemptReservation;
    artifactDigest: string;
  };
  worker?: LocalWorktree;
}

class SiblingRefreshTargetAdvancedError extends Error {}
class SiblingRefreshObservationPendingError extends Error {}

class ArtifactCollectionCheckpointError extends Error {
  constructor(cause: unknown) {
    super(
      "collected output is not durably retained; automated replacement is blocked until exact artifact transfer recovery completes",
      { cause },
    );
    this.name = "ArtifactCollectionCheckpointError";
  }
}

/** Missing completion evidence must remain recoverable, not become terminal history. */
class ArtifactCompletionUnavailableError extends Error {
  constructor() {
    super(
      "execution completion is unknown after dispatch; recover the exact original output or obtain explicit recovery direction before replacement",
    );
    this.name = "ArtifactCompletionUnavailableError";
  }
}

/** A durable provider gate blocks new model work while already-admitted attempts
 * are still being reconciled. It is a nonterminal drain hold, not a new failure. */
class ProviderQuotaDrainIncompleteError extends Error {
  constructor() {
    super("provider quota gate is active while durable attempt reconciliation remains incomplete");
    this.name = "ProviderQuotaDrainIncompleteError";
  }
}

class PrepublicationApprovalRequiredError extends Error {
  constructor(cause: unknown) {
    super(
      `validated artifact is held before any feature-ref or pull-request mutation; human pre-publication approval is required: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PrepublicationApprovalRequiredError";
  }
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
        event.runId === runId &&
        ((event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.phase === "management" &&
          event.unit === "model_tokens" &&
          event.usageId === `failed-${invocationId}`) ||
          (event.kind === "provider" &&
            event.event === "ProviderQuotaBlocked" &&
            event.phase === "management" &&
            event.modelInvocationId === invocationId)),
    )
  )
    throw new Error("management invocation already failed or is provider-gated; refusing replay");
}

/** Report-only runs finish their evaluation purpose without committing an execution graph. */
class CompilerDraftReportCompleted extends Error {}

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
  recordProviderGate?: (error: ProviderQuotaError) => Promise<void>;
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
        if (error instanceof ProviderQuotaError) {
          try {
            await args.recordProviderGate?.(error);
          } catch (cause) {
            throw preserveProviderQuotaError(
              error,
              cause,
              "provider-refusal adapter and compilation transaction checkpoints both failed",
            );
          }
        }
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
  legacyGraphConstraints?: LegacyGraphConstraints,
): number {
  const existingById = new Map(existing.map((item) => [item.compilerId, item]));
  if (legacyGraphConstraints) {
    assertCompiledObjectiveAdoptsLegacyConstraints(objective, legacyGraphConstraints);
    return legacyGraphConstraints.workItems.filter((item) => !existingById.has(item.compilerId))
      .length;
  }
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
    return this.captureMutationFence()(waitedMs);
  }

  /**
   * Capture the operation's generation before it enters the shared mutation
   * queue. Reassigning a Supervisor to a later lease can therefore never lend
   * the new epoch to an already-queued write.
   */
  captureMutationFence(): (waitedMs: number) => Promise<void> {
    if (this.#fatal) throw this.#fatal;
    const expected = this.lease;
    return async (waitedMs: number) => {
      if (this.#fatal) throw this.#fatal;
      void waitedMs;
      await this.manager.assertCurrent(expected);
    };
  }

  /** Cheap envelope/scope check; the captured fence performs the remote read. */
  assertMutationIdentity(lease: LeaseState): void {
    const current = this.lease;
    if (
      lease.objective !== current.objective ||
      lease.runId !== current.runId ||
      lease.holder !== current.holder ||
      lease.epoch !== current.epoch ||
      lease.policyDigest !== current.policyDigest
    ) {
      throw new LeaseLostError("Objective mutation belongs to another lease generation");
    }
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
  objectiveFence: () => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
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

const MAX_RETRY_CHECKPOINT_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_RETRY_PAYLOAD_CACHE_BYTES = 512 * 1024 * 1024;

class RetryArtifactCache {
  readonly #entries = new Map<number, NormalizedArtifact>();
  readonly #releases = new Map<number, () => Promise<void>>();
  #bytes = 0;
  #payloadBytes = 0;

  async get(workItem: number, baseSha: string): Promise<NormalizedArtifact | undefined> {
    const artifact = this.#entries.get(workItem);
    if (!artifact) return undefined;
    if (artifact.baseSha !== baseSha) {
      await this.delete(workItem);
      return undefined;
    }
    this.#entries.delete(workItem);
    this.#entries.set(workItem, artifact);
    return artifact;
  }

  async set(workItem: number, artifact: NormalizedArtifact): Promise<void> {
    await this.delete(workItem);
    const bytes = Buffer.byteLength(JSON.stringify(artifact));
    const payloadBytes = artifact.payload?.bytes ?? 0;
    if (bytes > MAX_RETRY_CHECKPOINT_CACHE_BYTES || payloadBytes > MAX_RETRY_PAYLOAD_CACHE_BYTES)
      return;
    while (
      this.#bytes + bytes > MAX_RETRY_CHECKPOINT_CACHE_BYTES ||
      this.#payloadBytes + payloadBytes > MAX_RETRY_PAYLOAD_CACHE_BYTES
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      await this.delete(oldest);
    }
    this.#entries.set(workItem, artifact);
    if (artifact.payload) this.#releases.set(workItem, retainArtifactContent(artifact.payload));
    this.#bytes += bytes;
    this.#payloadBytes += payloadBytes;
  }

  async delete(workItem: number): Promise<void> {
    const artifact = this.#entries.get(workItem);
    if (!artifact) return;
    this.#bytes -= Buffer.byteLength(JSON.stringify(artifact));
    this.#payloadBytes -= artifact.payload?.bytes ?? 0;
    this.#entries.delete(workItem);
    const release = this.#releases.get(workItem);
    this.#releases.delete(workItem);
    await release?.();
  }

  async clear(): Promise<void> {
    for (const workItem of [...this.#entries.keys()]) await this.delete(workItem);
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
  readonly #validations: ValidationCheckpointManager;
  readonly #sessions: AppServerSessionManager;
  readonly #mergeCandidates: MergeCandidateCheckpointStore;
  readonly #siblingRefreshes: SiblingRefreshStore;
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
  readonly #sharedCapacity: SharedCapacityCoordinator | undefined;
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
  readonly #modelInvocations = new ModelInvocationScopes();
  #integrationTail: Promise<void> = Promise.resolve();
  // Scheduling hints only: never reuse authority or mutable GitHub evidence.
  // Lost on restart; every due observation repeats the normal integration fences.
  #integrationWaits = new Map<number, { until: number; delay: number; reason: string }>();
  readonly #retryArtifacts = new RetryArtifactCache();
  #durablePackets = new Map<number, WorkerPacket>();
  #compiledGraph: CompiledObjective | null = null;
  #recoveryRuntime: RecoveryRuntime | null = null;
  #recoveryGraphBootstrap: RecoveryGraphBootstrapRuntime | null = null;
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
    this.#sharedCapacity = shared?.sharedCapacity ?? options.sharedCapacity;
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
      captureMutationFence: (kind: "normal" | "lease") =>
        kind === "lease" ? async () => {} : this.#captureMutationFence(),
      assertMutationIdentity: (lease: LeaseState) => {
        if (!this.#lease) throw new LeaseLostError("Objective mutation has no acquired lease");
        this.#lease.assertMutationIdentity(lease);
      },
      mutationScope: `objective:${options.objective}`,
    };
    this.#reader = new GitHubReader({
      ...github,
      ...(options.recovery ? { recoveryInspection: true } : {}),
    });
    this.#store = new GitHubControlStore(controls);
    this.#recoveryStore = recoveryReadPort(this.#store, options.owner, options.repo, (number) =>
      this.#reader.readObjective(number),
    );
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
      legacyBinding: (reservation, nodeId) => this.#legacyAdmissionBinding(reservation, nodeId),
    });
    this.#reviews = new ReviewCheckpointManager(this.#store, this.#leases);
    this.#validations = new ValidationCheckpointManager(this.#store, this.#leases);
    this.#sessions = new AppServerSessionManager(this.#store, this.#leases);
    this.#mergeCandidates = new MergeCandidateCheckpointStore(this.#store, this.#leases);
    this.#siblingRefreshes = new SiblingRefreshStore(this.#store, this.#leases);
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

  /** Live process-local evidence only; never attributed to a historical run. */
  mutationOperationTelemetry() {
    return this.#store.mutationOperationTelemetry();
  }

  #captureMutationFence(): (waitedMs: number) => Promise<void> {
    if (!this.#lease) throw new LeaseLostError("Objective mutation has no acquired lease");
    return this.#lease.captureMutationFence();
  }

  async #externalAdmission<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#recoveryRuntime || this.#recoveryGraphBootstrap) {
      const fresh = await this.#reader.readObjective(this.#run.objective);
      if (this.#recoveryGraphBootstrap) {
        const observed = await loadRecoveryRuntime({
          objective: fresh.number,
          runId: this.#run.runId,
          store: this.#recoveryStore,
          readSnapshot: async () => ({ snapshot: fresh, historyComplete: true }),
          ...(this.#options.signal ? { signal: this.#options.signal } : {}),
        });
        if (
          observed.status === "blocked" ||
          observed.planRecord.digest !== this.#recoveryGraphBootstrap.planRecord.digest
        )
          throw new Error("successor graph-bootstrap authority changed");
        if (observed.status === "verified") {
          this.#recoveryRuntime = observed;
          this.#recoveryGraphBootstrap = null;
        } else this.#recoveryGraphBootstrap = observed;
      } else await this.#resumeObservedRun(fresh, new RunManager(this.#store));
      const recovery = this.#recoveryRuntime ?? this.#recoveryGraphBootstrap!;
      const resources = await verifyRecoveryResources({
        planRecord: recovery.planRecord,
        events: recovery.events,
        store: this.#store,
      });
      if (resources.status !== "verified")
        throw new Error(`successor resources unavailable: ${resources.blockers.join(", ")}`);
      if (recovery.currentUnknownModelUsageCount > 0)
        throw new Error("successor model usage is unknown; refusing another invocation");
      this.#budgetEvents = mergeAccountingSnapshot(
        this.#budgetEvents,
        [...recovery.events],
        new Set(recovery.accountingRunIds),
      );
    }
    return runWithExternalAdmissionBoundary(
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
          // The receipt read can span an authority change. Admission still
          // belongs to the current Objective generation, never the pre-read observation.
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
    const runs = new Set(
      (this.#recoveryRuntime ?? this.#recoveryGraphBootstrap)?.accountingRunIds ?? [currentRunId],
    );
    return events.filter((event) => runs.has(event.runId));
  }

  async #resumeObservedRun(
    snapshot: Snapshot,
    manager: RunManager,
    reconciliationMode: "none" | "inspect" | "repair" = "none",
  ): Promise<RunState | null> {
    const active = latestSupportedRun(snapshot.factoryEvents ?? [], snapshot.objectiveAuthority);
    const recovery = this.#options.recovery;
    if (recovery && (active?.event !== "FactoryRunStarted" || !active.recoveryRequestId)) {
      if (
        !this.#recoveryRuntime &&
        !this.#recoveryGraphBootstrap &&
        !active &&
        snapshot.closed &&
        snapshot.factoryEvents?.some(
          (event) =>
            event.event === "FactoryRunCompleted" &&
            event.runId === recovery.successorRunId &&
            hasCurrentWriterAuthority(
              event,
              snapshot.factoryEvents ?? [],
              snapshot.objectiveAuthority,
            ),
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
          ...(this.#options.signal ? { signal: this.#options.signal } : {}),
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
      (this.#recoveryRuntime || this.#recoveryGraphBootstrap) &&
      (active?.event !== "FactoryRunStarted" ||
        active.runId !==
          (this.#recoveryRuntime ?? this.#recoveryGraphBootstrap)!.controllingRun.runId)
    )
      throw new Error("successor is no longer the current non-terminal run");
    if (active?.event !== "FactoryRunStarted" || !active.recoveryRequestId)
      return manager.resume(snapshot.factoryEvents ?? [], snapshot.objectiveAuthority);
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
      if (error instanceof PlatformUnavailableError) throw error;
      // Ordinary execution/admission never uses this startup-only repair path.
      if (reconciliationMode === "none" || this.#recoveryRuntime || this.#recoveryGraphBootstrap)
        throw error;
      const inspection = await manager.inspectRecoveryReconciliation({
        ...input,
        planDigest: recovery.planDigest,
        requestId: recovery.requestId,
      });
      if (reconciliationMode === "inspect") return inspection.run;
      recovered = await this.#reconcileRecoverySourceMerges(snapshot.number, manager);
    }
    const priorRuntime = this.#recoveryRuntime ?? this.#recoveryGraphBootstrap;
    if (priorRuntime && priorRuntime.controllingRun.runId !== recovered.run.runId)
      throw new Error("successor runtime changed during execution");
    if (recovered.runtime.status === "verified") {
      this.#recoveryRuntime = recovered.runtime;
      this.#recoveryGraphBootstrap = null;
    } else {
      this.#recoveryRuntime = null;
      this.#recoveryGraphBootstrap = recovered.runtime;
    }
    return recovered.run;
  }

  /** Append only proved, already-completed merges under Objective ownership.
   * No worker, review, PR mutation or issue closure is permitted in this stage. */
  async #reconcileRecoverySourceMerges(objective: number, manager: RunManager) {
    const recovery = this.#options.recovery;
    if (!recovery) throw new Error("source reconciliation requires its acknowledged recovery");
    for (let repaired = 0; repaired <= 100; repaired++) {
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

  #capacityOwner(lease: LeaseState): SharedCapacityOwner {
    return {
      objective: lease.objective,
      runId: lease.runId,
      directorEpoch: lease.epoch,
      policyDigest: lease.policyDigest,
    };
  }

  async #capacitySnapshot(): Promise<CapacitySnapshot> {
    return this.#sharedCapacity ? this.#sharedCapacity.snapshot() : this.#capacity.snapshot();
  }

  async #reserveCapacity(
    expectedGeneration: number,
    reservation: CapacityReservation,
    limits: CapacityLimits,
  ): Promise<CapacityReservationResult> {
    if (!this.#sharedCapacity)
      return this.#capacity.tryReserve(expectedGeneration, reservation, limits);
    const result = await this.#lease.use((lease) =>
      this.#sharedCapacity!.reserve(this.#capacityOwner(lease), reservation, limits),
    );
    const snapshot = await this.#sharedCapacity.snapshot();
    return result.reserved
      ? { reserved: true, reservation, generation: snapshot.generation }
      : {
          reserved: false,
          code: result.code === "released-reservation" ? "duplicate-reservation" : result.code,
          generation: snapshot.generation,
        };
  }

  async #transitionCapacity(
    expectedGeneration: number,
    fromKey: string,
    reservation: CapacityReservation,
    limits: CapacityLimits,
  ): Promise<CapacityReservationResult> {
    if (!this.#sharedCapacity)
      return this.#capacity.transition(expectedGeneration, fromKey, reservation, limits);
    const result = await this.#lease.use((lease) =>
      this.#sharedCapacity!.transition(this.#capacityOwner(lease), fromKey, reservation, limits),
    );
    const snapshot = await this.#sharedCapacity.snapshot();
    return result.reserved
      ? { reserved: true, reservation, generation: snapshot.generation }
      : {
          reserved: false,
          code: result.code === "released-reservation" ? "duplicate-reservation" : result.code,
          generation: snapshot.generation,
        };
  }

  async #releaseCapacity(key: string): Promise<void> {
    if (this.#sharedCapacity) {
      await this.#lease.use((lease) =>
        this.#sharedCapacity!.release(this.#capacityOwner(lease), key),
      );
    } else {
      this.#capacity.release(key);
    }
    this.#fairness.changed();
  }

  async #reconcileObjectiveCapacity(objective: number, items: DerivedWorkItem[]) {
    const scheduling = normalizeSchedulingPolicy(this.#policy);
    const reservations = deriveCapacityReservations(
      items.map((item) => {
        const packet = this.#packetFor(item.number);
        for (const event of item.factoryEvents ?? []) {
          if (
            event.kind === "attempt" &&
            event.event === "AttemptReserved" &&
            this.#registry.get(event.backend)?.capabilities.hostExecution
          )
            this.#fairness.noteAdmission(objective, Date.parse(event.at));
        }
        return {
          objective,
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
    if (!this.#sharedCapacity) return this.#capacity.reconcileObjective(objective, reservations);
    const verifiedPredecessors = this.#recoveryRuntime
      ? [
          ...new Map(
            items.flatMap((item) =>
              (item.factoryEvents ?? []).flatMap((event) => {
                if (
                  event.kind !== "attempt" ||
                  event.event !== "AttemptReserved" ||
                  event.runId === this.#run.runId
                )
                  return [];
                const owner: SharedCapacityOwner = {
                  objective: event.objective,
                  runId: event.runId,
                  directorEpoch: event.directorEpoch,
                  policyDigest: event.policyDigest,
                };
                return [
                  [`${owner.runId}:${owner.directorEpoch}:${owner.policyDigest}`, owner] as const,
                ];
              }),
            ),
          ).values(),
        ]
      : [];
    await this.#lease.use((lease) =>
      this.#sharedCapacity!.reconcile(
        this.#capacityOwner(lease),
        reservations,
        verifiedPredecessors,
      ),
    );
    return this.#sharedCapacity.snapshot();
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
        if (!planned?.source || ["execute", "reconcile"].includes(planned.action))
          return { ...item, attempts: count };
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

  #plannedRecoveryItem(workItem: number) {
    return this.#recoveryRuntime?.planRecord.plan.items.find(
      (entry) => entry.workItem === workItem,
    );
  }

  async #prepareRecoveryGraph(snapshot: Snapshot): Promise<void> {
    const runtime = this.#recoveryRuntime!;
    const compiled = runtime.graph.objective;
    if (
      runtime.planRecord.plan.items.some(
        (item) =>
          item.action !== "execute" &&
          !item.source?.publication &&
          !item.source?.artifactHead &&
          !(item.action === "reconcile" && item.source?.artifactDigest),
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
    this.#validateCompiledGraphStatic(compiled);
    await this.#preflightCompiledGraphRuntime(compiled);
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
        // Ordinary npm setup consumes at most one additional index; a bootstrap
        // pnpm validation proves the tool version and then performs setup.
        // Unused scopes stay absent; every actual command is pre-authorized.
        commandCount: validationLocalCommandCount(packet),
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

  async #resolveExecutionBaseCapabilities(
    item: DerivedWorkItem,
    packet: WorkerPacket,
    base: { oid: string; treeOid: string },
    sourceRef: string,
    objectiveItems: readonly DerivedWorkItem[],
    providerIdentities?: ReadonlyMap<string, CapabilityProviderIdentity>,
  ): Promise<RepositoryCapabilityProof[]> {
    const requirements = packet.repositoryCapabilities?.requires ?? [];
    if (requirements.length === 0) return [];
    const compilerId = parseGraphItemMetadata(item.body ?? "").id;
    for (const requirement of requirements) {
      const adapter = toolchainAdapterById(requirement.adapter);
      if (!adapter?.deferredOperations)
        throw new Error(
          `unsupported deferred repository capability adapter: ${requirement.adapter}`,
        );
      if (requirement.activation === "artifact") {
        if (requirement.providerWorkItem !== compilerId)
          throw new Error("artifact-time repository capability provider identity changed");
      }
    }
    try {
      if ((await this.#store.readRef(sourceRef)) !== base.oid)
        throw new Error(`execution source ref ${sourceRef} no longer names ${base.oid}`);
      const providers =
        providerIdentities ??
        (await this.#capabilityProviderIdentities(packet, objectiveItems, base.oid));
      const proofs = await resolveIntegratedRepositoryCapabilities({
        repository: this.#options.repository,
        base,
        sourceRef,
        packet,
        providerById: (id) => providers.get(id),
      });
      if ((await this.#store.readRef(sourceRef)) !== base.oid)
        throw new Error(`execution source ref ${sourceRef} changed during capability inspection`);
      return proofs;
    } catch (error) {
      throw new Error(
        `repository validation for ${compilerId} is not grounded on exact base ${base.oid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #capabilityProviderIdentities(
    packet: WorkerPacket,
    objectiveItems: readonly DerivedWorkItem[],
    baseSha: string,
  ): Promise<Map<string, CapabilityProviderIdentity>> {
    const providers = new Map<string, CapabilityProviderIdentity>();
    for (const providerId of new Set(
      (packet.repositoryCapabilities?.requires ?? [])
        .filter((requirement) => requirement.activation === "integrated-base")
        .map((requirement) => requirement.providerWorkItem),
    ))
      providers.set(
        providerId,
        await this.#capabilityProviderIdentity(providerId, objectiveItems, baseSha),
      );
    return providers;
  }

  async #commitIncludes(baseSha: string, ancestorSha: string): Promise<boolean> {
    const pending = [baseSha];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const oid = pending.pop()!;
      if (oid === ancestorSha) return true;
      if (seen.has(oid)) continue;
      if (seen.size >= 512) throw new Error("capability integration ancestry exceeds bound");
      seen.add(oid);
      const commit = await this.#store.readCommit(oid);
      if (commit.oid !== oid || commit.parentOids.length > 16)
        throw new Error("capability integration ancestry contains an invalid commit");
      pending.push(...commit.parentOids);
    }
    return false;
  }

  async #capabilityProviderIdentity(
    compilerId: string,
    objectiveItems: readonly DerivedWorkItem[],
    baseSha: string,
  ): Promise<CapabilityProviderIdentity> {
    const compiled = this.#compiledGraph?.workItems.find(
      (candidate) => candidate.id === compilerId,
    );
    const provider = objectiveItems.find(
      (candidate) => parseGraphItemMetadata(candidate.body ?? "").id === compilerId,
    );
    if (
      !compiled ||
      !provider ||
      provider.state !== "done" ||
      provider.doneWithoutMergedPullRequest
    )
      throw new Error(`repository capability provider ${compilerId} lacks integrated completion`);

    const durableReservations = await this.#attempts.list(this.#run.objective, provider.number);
    const authenticatedReservation = (
      runId: string,
      attempt: number,
      expectedOid?: string,
      expectedReceiptDigest?: string,
    ) => {
      const reservations = durableReservations.filter(
        (candidate) => candidate.runId === runId && candidate.attempt === attempt,
      );
      const events = (provider.factoryEvents ?? []).filter(
        (event): event is AttemptEvent =>
          event.kind === "attempt" &&
          event.event === "AttemptReserved" &&
          event.runId === runId &&
          event.attempt === attempt &&
          (expectedReceiptDigest === undefined ||
            recoveryEventDigest(event) === expectedReceiptDigest),
      );
      if (reservations.length !== 1 || events.length !== 1)
        throw new Error(
          `repository capability provider ${compilerId} lacks one authenticated source reservation`,
        );
      const reservation = reservations[0]!;
      const event = events[0]!;
      if (
        (expectedOid !== undefined && reservation.oid !== expectedOid) ||
        reservation.objective !== this.#run.objective ||
        reservation.workItem !== provider.number ||
        reservation.receiptDigest !== recoveryEventDigest(event) ||
        reservation.baseSha !== event.baseSha ||
        reservation.policyDigest !== event.policyDigest ||
        JSON.stringify(reservation.managedRuntimeActivation ?? null) !==
          JSON.stringify(event.managedRuntimeActivation ?? null)
      )
        throw new Error(`repository capability provider ${compilerId} source reservation changed`);
      return {
        reservation,
        receiptDigest: reservation.receiptDigest,
      };
    };

    let integration: CapabilityProviderIdentity["integration"] | undefined;
    const recovered = this.#recoveryRuntime?.sourceIntegrations.find(
      (proof) => proof.outcome.workItem === provider.number,
    );
    if (recovered) {
      const source = authenticatedReservation(
        recovered.outcome.sourceRunId,
        recovered.outcome.sourceAttempt,
        recovered.outcome.sourceReservationCommitOid,
        recovered.outcome.sourceReservationReceiptDigest,
      );
      const commit = await this.#store.readCommit(recovered.outcome.mergeCommitSha);
      integration = {
        kind: "recovery",
        runId: recovered.outcome.sourceRunId,
        attempt: recovered.outcome.sourceAttempt,
        commitSha: commit.oid,
        treeOid: commit.treeOid,
        reservationOid: source.reservation.oid,
        reservationReceiptDigest: source.receiptDigest,
        receiptDigest: recoveryEventDigest(recovered.outcome),
        ...(source.reservation.managedRuntimeActivation
          ? { managedRuntimeActivation: source.reservation.managedRuntimeActivation }
          : {}),
      };
    } else {
      const candidates = (provider.factoryEvents ?? []).filter(
        (event): event is AttemptEvent =>
          event.kind === "attempt" &&
          event.event === "AttemptIntegrated" &&
          event.runId === this.#run.runId &&
          Boolean(event.headSha),
      );
      for (const event of candidates) {
        const source = authenticatedReservation(event.runId, event.attempt);
        const publication = (provider.factoryEvents ?? []).find(
          (candidate): candidate is PublicationEvent =>
            candidate.kind === "publication" &&
            candidate.event === "PublicationRecorded" &&
            candidate.runId === event.runId &&
            candidate.workItem === provider.number &&
            candidate.attempt === event.attempt,
        );
        if (!publication || !event.headSha) continue;
        const pull = await this.#store.readPullRequest(publication.pullRequest);
        if (
          !pull.merged ||
          pull.mergeCommitSha !== event.headSha ||
          pull.headSha !== publication.headSha
        )
          continue;
        const merge = await this.#store.readCommit(event.headSha);
        const head = await this.#store.readCommit(publication.headSha);
        if (
          merge.parentOids.length !== 1 ||
          merge.parentOids[0] !== publication.baseSha ||
          merge.treeOid !== head.treeOid
        )
          continue;
        const value: CapabilityProviderIdentity["integration"] = {
          kind: "attempt",
          runId: event.runId,
          attempt: event.attempt,
          commitSha: merge.oid,
          treeOid: merge.treeOid,
          reservationOid: source.reservation.oid,
          reservationReceiptDigest: source.receiptDigest,
          receiptDigest: createHash("sha256")
            .update(
              `${source.reservation.oid}\0${source.receiptDigest}\0${recoveryEventDigest(publication)}\0${recoveryEventDigest(event)}`,
            )
            .digest("hex"),
          ...(source.reservation.managedRuntimeActivation
            ? { managedRuntimeActivation: source.reservation.managedRuntimeActivation }
            : {}),
        };
        if (integration && JSON.stringify(integration) !== JSON.stringify(value))
          throw new Error(`repository capability provider ${compilerId} has ambiguous lineage`);
        integration = value;
      }
    }
    if (!integration || !(await this.#commitIncludes(baseSha, integration.commitSha)))
      throw new Error(
        `repository capability provider ${compilerId} merge is not authenticated in the execution base`,
      );
    return {
      id: compiled.id,
      dependsOn: compiled.dependsOn,
      scope: compiled.scope,
      issueNumber: provider.number,
      integration,
    };
  }

  async #baseWorkflowInventory(baseSha: string): Promise<Map<string, string>> {
    await ensureLocalCommit(this.#options.repository, baseSha);
    const paths = (
      await hostGit(
        this.#options.repository,
        ["ls-tree", "-r", "--name-only", "-z", baseSha, "--", ".github/workflows"],
        512 * 501,
        true,
      )
    )
      .split("\0")
      .filter(isReviewOnlyWorkflowSurface)
      .sort();
    if (paths.length > 512) throw new Error("base workflow directory exceeds inspection bound");
    const workflows = new Map<string, string>();
    for (const path of paths) {
      workflows.set(
        path,
        await hostGit(
          this.#options.repository,
          ["show", `${baseSha}:${path}`],
          64 * 1024 + 1,
          true,
        ),
      );
    }
    return workflows;
  }

  async #assertWorkflowPublicationSafety(args: {
    candidateRoot: string;
    artifact: Pick<NormalizedArtifact, "baseSha" | "changedPaths">;
    baseBranch: string;
    changedPackageScripts?: readonly string[];
  }): Promise<void> {
    const sensitivePaths = args.artifact.changedPaths.filter(
      (path) => executionAffectingReason(path) !== null,
    );
    const workflowChange = sensitivePaths.some(isReviewOnlyWorkflowSurface);
    const actionsProfile = workflowChange
      ? await this.#reader.readWorkflowSafetyProfile(true)
      : undefined;
    const changedPackageScripts =
      args.changedPackageScripts ??
      (args.artifact.changedPaths.includes("package.json") ? ["<unknown>"] : []);
    const assertAgainst = (baseWorkflows: ReadonlyMap<string, string>) =>
      assertReviewOnlyWorkflowArtifacts(
        args.candidateRoot,
        sensitivePaths,
        args.baseBranch,
        changedPackageScripts,
        baseWorkflows,
        actionsProfile,
      );
    await assertAgainst(await this.#baseWorkflowInventory(args.artifact.baseSha));
    const liveBase = await this.#store.readRef(`refs/heads/${args.baseBranch}`);
    if (!liveBase) throw new Error(`publication base ${args.baseBranch} is unavailable`);
    if (liveBase !== args.artifact.baseSha) {
      await assertAgainst(await this.#baseWorkflowInventory(liveBase));
    }
    if ((await this.#store.readRef(`refs/heads/${args.baseBranch}`)) !== liveBase) {
      throw new Error(`publication base ${args.baseBranch} changed during workflow inspection`);
    }
  }

  /** Reconstruct policy input from immutable Git objects for recovery and
   * adoption paths that no longer hold the original validation worktree. */
  async #assertWorkflowPublicationHeadSafety(args: {
    baseSha: string;
    headSha: string;
    baseBranch: string;
  }): Promise<void> {
    await ensureLocalCommit(this.#options.repository, args.baseSha);
    await ensureLocalCommit(this.#options.repository, args.headSha);
    const sensitiveOutput = await hostGit(
      this.#options.repository,
      [
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        args.baseSha,
        args.headSha,
        "--",
        ...EXECUTION_AFFECTING_GIT_PATHS,
      ],
      256 * 1024,
      true,
    );
    const changedPaths = sensitiveOutput.split("\0").filter(Boolean);
    if (changedPaths.length === 0) return;
    const candidate = await createLocalWorktree(this.#options.repository, args.headSha);
    try {
      await this.#assertWorkflowPublicationSafety({
        candidateRoot: candidate.path,
        artifact: { baseSha: args.baseSha, changedPaths },
        baseBranch: args.baseBranch,
      });
    } finally {
      await cleanupLocalWorktree(candidate);
    }
  }

  async #assertPublicationHeadCurrent(args: {
    headBranch: string;
    headSha: string;
  }): Promise<void> {
    if ((await this.#store.readRef(`refs/heads/${args.headBranch}`)) !== args.headSha) {
      throw new Error(`publication branch ${args.headBranch} changed from ${args.headSha}`);
    }
  }

  async #holdRecoveredPrepublication(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    cause: unknown,
  ): Promise<never> {
    const error = new PrepublicationApprovalRequiredError(cause);
    const alreadyDeferred = (item.factoryEvents ?? []).some(
      (event) =>
        event.kind === "attempt" &&
        event.event === "AttemptDeferred" &&
        event.runId === reservation.runId &&
        event.attempt === reservation.attempt,
    );
    if (!alreadyDeferred) {
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation,
          event: "AttemptDeferred",
          sequence: this.#sequences.take(),
          reason: error.message,
          allowRecovery: true,
        }),
      );
    }
    throw error;
  }

  async #recordControllerObservation(
    snapshot: Snapshot,
    objectiveWriterOnly = false,
  ): Promise<void> {
    const observe = this.#options.controllerObservation;
    const owner = await this.#lease.use(async (lease) => lease);
    const observedController = objectiveWriterOnly ? undefined : observe?.();
    const observation = observedController ?? {
      controllerId: owner.holder,
      epoch: owner.epoch,
      expiresAt: owner.expiresAt.toISOString(),
      controllerPolicyDigest: owner.policyDigest,
    };
    // A foreground writer needs one boundary per generation, not a comment
    // for each lease renewal. Service observations retain their own lifecycle.
    const observationKey = JSON.stringify([
      owner.epoch,
      observedController ? observation : "objective-writer",
    ]);
    if (this.#lastControllerObservationKey === observationKey) return;
    const latest = (snapshot.factoryEvents ?? [])
      .filter((event) => event.kind === "controller" && event.runId === this.#run.runId)
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    if (
      latest?.kind === "controller" &&
      latest.writerEpoch === owner.epoch &&
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
    const record = () =>
      this.#lease.use((lease) =>
        this.#recorder.controller({
          lease,
          objectiveNodeId: snapshot.id,
          sequence: this.#sequences.take(),
          ...observation,
          observationScope: observedController ? "repository-controller" : "objective-writer",
          protocolMin: PROTOCOL_V2,
          protocolMax: PROTOCOL_V2,
        }),
      );
    try {
      if (observedController) {
        // A scoped fence replaces the store's configured Objective fence, so
        // compose both checks. The local callback is sampled after any queue
        // wait and adjacent to transport; retirement suppresses stale leader
        // metadata without polling the repository lease or aborting execution.
        const objectiveFence = this.#captureMutationFence();
        await this.#store.withMutationFence(async (waitedMs) => {
          await objectiveFence(waitedMs);
          if (!observe?.()) throw new ControllerObservationRetiredError();
        }, record);
      } else await record();
    } catch (error) {
      if (error instanceof ControllerObservationRetiredError && !objectiveWriterOnly) {
        await this.#recordControllerObservation(snapshot, true);
        return;
      }
      throw error;
    }
    this.#lastControllerObservationKey = observationKey;
  }

  async #acknowledgeOperationalGate(snapshot: Snapshot, gate: AdmissionGateCommand): Promise<void> {
    const writerEpoch = await this.#lease.use(async (lease) => lease.epoch);
    const event = gate.kind === "drain" ? "RunDrainCompleted" : "RunPauseAcknowledged";
    const recorded = (snapshot.factoryEvents ?? []).some(
      (candidate) =>
        candidate.kind === "run" &&
        candidate.writerEpoch === writerEpoch &&
        hasCurrentWriterAuthority(
          candidate,
          snapshot.factoryEvents ?? [],
          snapshot.objectiveAuthority,
        ) &&
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
    completionDeadline?: number,
    completedSources?: ReadonlyMap<number, { mergeCommitSha: string; targetBaseSha: string }>,
    completedCandidates?: Map<string, MergeCandidateCheckpointRecord>,
    completedMergeOids?: Set<string>,
    stopBaseSha = run.baseSha,
    peerProof = false,
  ): Promise<boolean> {
    if (snapshot.number !== run.objective) return false;
    if (!run.baseSha) {
      // Foreground starts deliberately have no activation/base envelope. Their
      // initial base is the authenticated immutable compilation, never today's
      // trunk or the caller's one-commit traversal boundary. Do not modify the
      // historical RunState to make it look like a controller activation.
      const events = deduplicateFactoryEvents(snapshot.factoryEvents ?? []);
      const starts = events.filter(
        (event) =>
          event.kind === "run" &&
          event.event === "FactoryRunStarted" &&
          event.runId === run.runId &&
          event.objective === run.objective,
      );
      const start = starts[0];
      const compiled = events.filter(
        (event) =>
          event.kind === "graph" &&
          event.event === "GraphCompiled" &&
          event.runId === run.runId &&
          event.objective === run.objective,
      );
      const receipt = compiled[0];
      if (
        starts.length !== 1 ||
        start?.kind !== "run" ||
        start.event !== "FactoryRunStarted" ||
        start.baseSha ||
        start.activationRequestId ||
        start.recoveryRequestId ||
        start.actor !== run.actor ||
        start.repository !== run.repository ||
        start.baseBranch !== run.baseBranch ||
        start.policyDigest !== run.policyDigest ||
        policyDigest(parseRunPolicy(start.policy)) !== run.policyDigest ||
        compiled.length !== 1 ||
        receipt?.kind !== "graph" ||
        receipt.event !== "GraphCompiled" ||
        receipt.sequence <= start.sequence
      )
        return false;
      const graph = await loadCompiledGraph(this.#recoveryStore, run.objective, run.runId);
      if (
        !graph ||
        graph.ref !== receipt.graphRef ||
        graph.blobOid !== receipt.graphBlobSha ||
        graph.graphDigest !== receipt.graphDigest ||
        graph.graphSize !== receipt.graphSize ||
        !graph.objective.workItems.every((item) => item.baseSha === receipt.baseSha)
      )
        return false;
      const commit = await this.#recoveryStore.readCommit(graph.commitOid);
      if (
        commit.oid !== graph.commitOid ||
        commit.parentOids.length !== 1 ||
        commit.parentOids[0] !== receipt.baseSha
      )
        return false;
      const projection = await loadCompiledGraphProjection(
        this.#recoveryStore,
        run.objective,
        run.runId,
        graph,
      );
      if (!projection) return false;
      assertAuthenticatedGraphProjection(events, run.objective, run.runId, projection);
      assertSnapshotMatchesCompiledGraph(graph.objective, snapshot, projection.bindings);
      stopBaseSha ??= receipt.baseSha;
    }
    const observations = new Map<
      number,
      Awaited<ReturnType<GitHubControlStore["readPullRequest"]>>
    >();
    let cursor = targetBaseSha;
    const visited = new Set<string>();
    while (cursor !== stopBaseSha) {
      if (visited.has(cursor) || visited.size >= 3200) return false;
      visited.add(cursor);
      const matches = [];
      if (completionDeadline !== undefined) {
        for (const proof of completedSources?.values() ?? []) {
          if (proof.mergeCommitSha !== cursor) continue;
          matches.push(proof.targetBaseSha);
        }
      }
      for (const item of snapshot.workItems) {
        if (
          completionDeadline !== undefined &&
          completedSources?.get(item.number)?.mergeCommitSha === cursor
        )
          continue;
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
          if (completionDeadline !== undefined) {
            const integrated = events.filter((event) => event.event === "AttemptIntegrated");
            if (
              integrated.length !== 1 ||
              integrated[0]?.kind !== "attempt" ||
              integrated[0].headSha !== cursor ||
              Date.parse(integrated[0].at) > completionDeadline
            )
              return false;
          }
          const publication = [...events]
            .reverse()
            .find(
              (event) =>
                event.kind === "publication" &&
                event.event === "PublicationRecorded" &&
                event.pullRequest === linked.number,
            );
          if (publication?.kind !== "publication") return false;
          selectEquivalentPublicationRecord(
            events.filter(
              (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
                event.kind === "publication" &&
                event.event === "PublicationRecorded" &&
                event.attempt === publication.attempt &&
                event.headSha === publication.headSha,
            ),
            publication,
          );
          const published = events.find(
            (event) =>
              event.kind === "attempt" &&
              event.event === "AttemptPublished" &&
              event.headSha === publication.headSha &&
              event.attempt === publication.attempt &&
              event.policyDigest === run.policyDigest,
          );
          if (published?.kind !== "attempt" || !published.artifactDigest) return false;
          const validation = [...events]
            .reverse()
            .find(
              (event) =>
                event.kind === "validation" &&
                event.attempt === published.attempt &&
                event.evidenceDigest === publication.validationDigest &&
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
          if (completionDeadline !== undefined || peerProof) {
            const review = await this.#reviews.load({
              kind: validation.baseSha === reservation.baseSha ? "artifact" : "rebase",
              runId: run.runId,
              objective: run.objective,
              workItem: item.number,
              attempt: published.attempt,
              artifactDigest: published.artifactDigest,
              baseSha: validation.baseSha,
              outputTreeSha: validation.outputTreeSha,
              evidenceDigest: validation.evidenceDigest,
              ...(validation.baseSha === reservation.baseSha
                ? {}
                : { headSha: publication.headSha }),
            });
            if (
              !this.#completedReviewAccounted(
                review,
                snapshotEvents(snapshot),
                completionDeadline ?? Infinity,
              )
            )
              return false;
          }
          const head = await this.#store.readCommit(publication.headSha);
          if (
            head.oid !== publication.headSha ||
            head.parentOids.length !== 1 ||
            head.parentOids[0] !== validation.baseSha
          )
            return false;
          const exactHeadValidation = bindValidationToPublishedHead({
            validation: {
              passed: true,
              digest: validation.evidenceDigest,
              baseSha: validation.baseSha,
              outputTreeSha: validation.outputTreeSha,
            },
            publishedHeadSha: publication.headSha,
            publishedTreeSha: head.treeOid,
            publishedBaseSha: validation.baseSha,
          });
          const commit = await this.#store.readCommit(cursor);
          if (commit.oid !== cursor || commit.parentOids.length !== 1) return false;
          const parent = commit.parentOids[0]!;
          const publishedPull: PublishedPullRequest = {
            number: linked.number,
            branch: pull.headRef!,
            commitSha: publication.headSha,
            htmlUrl: `https://github.com/${run.repository}/pull/${linked.number}`,
            exactHeadValidation,
          };
          const refresh = await this.#observedSiblingRefresh(
            item,
            { reservation, pull: publishedPull },
            pull.headSha,
            run,
          );
          if (refresh && refresh.identity.targetBaseSha !== parent) return false;
          if (parent === validation.baseSha) {
            if (refresh) return false;
            await verifySquashIntegration(this.#store, publishedPull, cursor, parent);
          } else {
            const candidate = await this.#mergeCandidates.load({
              runId: run.runId,
              objective: run.objective,
              workItem: item.number,
              attempt: published.attempt,
              pullRequest: linked.number,
              sourceHeadSha: publication.headSha,
              sourceExactHeadValidationDigest: exactHeadValidation.digest,
              targetBaseSha: parent,
              ...(refresh ? { deliveryHeadSha: refresh.plannedHeadSha } : {}),
            });
            const review = candidate
              ? await this.#reviews.load(this.#mergeCandidateReviewIdentity(candidate))
              : null;
            if (
              !candidate ||
              !review?.review.accepted ||
              review.review.unmetCriteria.length ||
              (refresh && candidate.validation.outputTreeSha !== refresh.outputTreeSha)
            )
              return false;
            if (
              completionDeadline !== undefined &&
              (!this.#completedReviewAccounted(
                review,
                snapshotEvents(snapshot),
                completionDeadline,
              ) ||
                Date.parse(candidate.validation.completedAt) > completionDeadline)
            )
              return false;
            completedCandidates?.set(mergeCandidateIdentityDigest(candidate.identity), candidate);
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
      if (matches.length === 0 && !peerProof) {
        const peer = await this.#peerTrunkIntegration(cursor, snapshot, run);
        if (peer) matches.push(peer.parent);
      }
      if (matches.length !== 1) return false;
      completedMergeOids?.add(cursor);
      cursor = matches[0]!;
    }
    return true;
  }

  #completedReviewAccounted(
    record: ReviewCheckpointRecord | null,
    events: readonly FactoryEvent[],
    deadline: number,
    sourceOwned = false,
  ): boolean {
    if (!record?.review.accepted || record.review.unmetCriteria.length) return false;
    const receipts = events.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.runId === record.identity.runId &&
        event.workItem === record.identity.workItem &&
        event.attempt === (sourceOwned ? undefined : record.identity.attempt) &&
        event.phase === "management" &&
        event.unit === "model_tokens" &&
        event.usageId === this.#reviewUsageId(record),
    );
    return (
      receipts.length === 1 &&
      receipts[0]?.kind === "budget" &&
      receipts[0].amount === record.usage.inputTokens + record.usage.outputTokens &&
      Date.parse(receipts[0].at) <= deadline
    );
  }

  /** Completion-only authority after expiry: no repair or new execution may be inferred. */
  async #recordedCompletionReady(snapshot: Snapshot, deadline: number): Promise<boolean> {
    try {
      const active = latestSupportedRun(snapshot.factoryEvents ?? [], snapshot.objectiveAuthority);
      if (
        active?.event !== "FactoryRunStarted" ||
        active.runId !== this.#run.runId ||
        active.policyDigest !== this.#run.policyDigest
      )
        return false;
      if (this.#options.recovery) {
        const runtime = await loadRecoveryRuntime({
          objective: snapshot.number,
          runId: this.#run.runId,
          store: this.#recoveryStore,
          readSnapshot: async () => ({ snapshot, historyComplete: true }),
          ...(this.#options.signal ? { signal: this.#options.signal } : {}),
        });
        if (
          runtime.status !== "verified" ||
          runtime.currentUnknownModelUsageCount !== 0 ||
          runtime.planRecord.digest !== this.#options.recovery.planDigest ||
          runtime.planRecord.plan.requestId !== this.#options.recovery.requestId
        )
          return false;
        this.#recoveryRuntime = runtime;
      }
      const graphs = new CompiledGraphManager(this.#store, this.#leases);
      const graph =
        this.#recoveryRuntime?.graph ?? (await graphs.load(snapshot.number, this.#run.runId));
      const projection =
        this.#recoveryRuntime?.projection ??
        (graph && (await graphs.loadProjection(snapshot.number, this.#run.runId, graph)));
      if (!graph || !projection) return false;
      assertGraphWithinRunPolicy(graph.objective, this.#policy);
      this.#compiledGraph = graph.objective;
      this.#compiledProjection = projection;
      this.#fenceSnapshot(snapshot);
      const completedSources = new Map<
        number,
        { mergeCommitSha: string; targetBaseSha: string; at: string }
      >();
      const runtime = this.#recoveryRuntime;
      for (const proof of runtime?.sourceIntegrations ?? []) {
        if (
          proof.candidate &&
          (Date.parse(proof.candidate.validation.completedAt) > deadline ||
            !this.#completedReviewAccounted(
              proof.candidateReview,
              runtime!.events,
              deadline,
              proof.candidate.identity.runId !==
                runtime!.planRecord.plan.items.find(
                  (item) => item.workItem === proof.outcome.workItem,
                )?.source?.runId,
            ))
        )
          return false;
        completedSources.set(proof.outcome.workItem, {
          mergeCommitSha: proof.outcome.mergeCommitSha,
          targetBaseSha: proof.targetBaseSha,
          at: proof.outcome.at,
        });
      }
      // An acknowledged already-integrated predecessor retains its ORIGINAL
      // receipt. Never manufacture a successor outcome to make closure possible.
      for (const item of runtime?.planRecord.plan.items ?? []) {
        if (item.action !== "integrated" || !item.source || completedSources.has(item.workItem))
          continue;
        const source = item.source;
        if (source.priorDelivery) {
          const prior = await verifyPriorRecoveryDelivery({
            plan: runtime!.planRecord.plan,
            item,
            events: runtime!.events,
            store: this.#recoveryStore,
          });
          completedSources.set(item.workItem, {
            mergeCommitSha: prior.outcome.mergeCommitSha,
            targetBaseSha: prior.targetBaseSha,
            at: prior.outcome.at,
          });
        } else {
          const receipts = runtime!.events.filter(
            (event) =>
              event.event === "AttemptIntegrated" &&
              event.runId === source.runId &&
              event.workItem === item.workItem &&
              event.attempt === source.attempt,
          );
          if (receipts.length !== 1 || receipts[0]?.kind !== "attempt") return false;
          const receipt = receipts[0];
          const proof = await verifyRecoveryMergedSource({
            planRecord: runtime!.planRecord,
            claim: runtime!.claim,
            events: runtime!.events,
            store: this.#recoveryStore,
            workItem: item.workItem,
          });
          if (
            proof.mergeCommitSha !== receipt.headSha ||
            receipt.policyDigest !==
              runtime!.planRecord.plan.history.find((entry) => entry.runId === source.runId)
                ?.policyDigest
          )
            return false;
          const merge = await this.#store.readCommit(proof.mergeCommitSha);
          if (merge.oid !== proof.mergeCommitSha || merge.parentOids.length !== 1) return false;
          completedSources.set(item.workItem, {
            mergeCommitSha: proof.mergeCommitSha,
            targetBaseSha: merge.parentOids[0]!,
            at: receipt.at,
          });
        }
      }
      const derived = this.#deriveObjective(snapshot);
      const objective = {
        ...derived,
        items: derived.items.map((item) =>
          completedSources.has(item.number) && item.closed
            ? { ...item, state: "done" as const }
            : item,
        ),
      };
      if (!allDone(objective) || objective.items.some((item) => !item.closed)) return false;
      const events = deduplicateFactoryEvents(
        this.#accountingEvents(snapshotEvents(snapshot), this.#run.runId),
      );
      if (graph.compilation) {
        const owner = runtime?.planRecord.plan.graph.sourceRunId ?? this.#run.runId;
        const compiler = events.filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.runId === owner &&
            event.phase === "management" &&
            event.unit === "model_tokens" &&
            event.workItem === undefined &&
            event.attempt === undefined &&
            event.usageId === `compile-${graph.graphDigest}`,
        );
        if (
          compiler.length !== 1 ||
          compiler[0]?.kind !== "budget" ||
          compiler[0].amount !== graph.compilation.inputTokens + graph.compilation.outputTokens ||
          Date.parse(compiler[0].at) > deadline
        )
          return false;
      }
      if (
        unreconciledBudgetReservations(events).length ||
        unreconciledCapacityReservations(events).length
      )
        return false;
      const current = events.filter((event) => event.runId === this.#run.runId);
      if (
        current.some(
          (event) =>
            ["attempt", "capacity", "budget", "validation", "publication"].includes(event.kind) &&
            (!Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) > deadline),
        )
      )
        return false;
      // Every completed Work Item needs its real, on-time integration receipt. A
      // closed issue or an observed merge without the receipt cannot use this path.
      for (const item of objective.items) {
        const source = completedSources.get(item.number);
        const own = current.filter(
          (event) => event.event === "AttemptIntegrated" && event.workItem === item.number,
        );
        const outcomes = [...(source ? [source] : []), ...own];
        if (
          outcomes.length !== 1 ||
          !Number.isFinite(Date.parse(outcomes[0]!.at)) ||
          Date.parse(outcomes[0]!.at) > deadline
        )
          return false;
      }
      for (const started of current) {
        if (started.event !== "AttemptStarted") continue;
        const terminal = current.filter(
          (event) =>
            event.kind === "attempt" &&
            event.workItem === started.workItem &&
            event.attempt === started.attempt &&
            ["AttemptSucceeded", "AttemptFailed", "AttemptTimedOut", "AttemptCancelled"].includes(
              event.event,
            ),
        );
        if (
          terminal.length !== 1 ||
          terminal[0]?.kind !== "attempt" ||
          terminal[0].reportedModelTokens === undefined ||
          terminal[0].sequence <= started.sequence ||
          Date.parse(terminal[0].at) > deadline
        )
          return false;
        const usage = current.filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.workItem === started.workItem &&
            event.attempt === started.attempt &&
            event.phase === "execution" &&
            event.unit === "model_tokens",
        );
        if (
          usage.length !== 1 ||
          usage[0]?.kind !== "budget" ||
          usage[0].amount !== terminal[0].reportedModelTokens
        )
          return false;
      }
      const target = await this.#store.getBranchHead(this.#baseBranch);
      const candidates = new Map<string, MergeCandidateCheckpointRecord>();
      const merged = new Set<string>();
      if (
        !(await this.#observedRunOwnsBaseAdvance(
          snapshot,
          this.#run,
          target.oid,
          deadline,
          completedSources,
          candidates,
          merged,
        ))
      )
        return false;
      if (
        current.some(
          (event) =>
            event.event === "AttemptIntegrated" && (!event.headSha || !merged.has(event.headSha)),
        )
      )
        return false;
      if (
        runtime?.sourceIntegrations.some(
          (proof) =>
            runtime.planRecord.plan.items.find((item) => item.workItem === proof.outcome.workItem)
              ?.action !== "integrated" && !merged.has(proof.outcome.mergeCommitSha),
        )
      )
        return false;
      // This shortcut is intentionally local-only. Exact settled receipts plus
      // synchronous terminal control flow precede physical observation of every
      // possible command slot; a live Director producer is not a worker liability.
      for (const event of events) {
        if (event.event !== "AttemptReserved" && event.event !== "CapacityReserved") continue;
        if (event.event === "CapacityReserved" && event.phase !== "validation") continue;
        if (!event.localScopeBatch) return false;
        const batch = LocalScopeBatchSchema.parse(event.localScopeBatch);
        const identity = batch.identity;
        if (
          identity.repository !== this.#run.repository ||
          identity.objective !== snapshot.number ||
          identity.runId !== event.runId ||
          identity.workItem !== event.workItem ||
          identity.attempt !== event.attempt ||
          identity.policyDigest !== event.policyDigest ||
          identity.directorEpoch !== (event.recoveryEpoch ?? event.directorEpoch) ||
          identity.phase !== (event.event === "AttemptReserved" ? "execution" : "validation")
        )
          return false;
        if (event.event === "AttemptReserved") {
          const reservation = (await this.#attempts.list(snapshot.number, event.workItem)).find(
            (entry) => entry.runId === event.runId && entry.attempt === event.attempt,
          );
          if (
            !reservation?.localScopeBatch ||
            JSON.stringify(LocalScopeBatchSchema.parse(reservation.localScopeBatch)) !==
              JSON.stringify(batch)
          )
            return false;
        } else {
          const workItem = snapshot.workItems.find((item) => item.number === event.workItem);
          const compilerId = workItem && parseGraphItemMetadata(workItem.body ?? "").id;
          const packet = graph.objective.workItems.find((item) => item.id === compilerId);
          if (
            !packet ||
            batch.commandCount !==
              validationLocalCommandCount(executionWorkerPacketFromCompiled(packet))
          )
            return false;
          const candidate = candidates.get(
            event.backend.replace(/^factory\/integration-validation-/, ""),
          );
          const sourceCapacity = runtime?.verifiedSourceCapacity.some(
            (entry) => recoveryEventDigest(entry) === recoveryEventDigest(event),
          );
          const ordinary = events.some(
            (collected) =>
              collected.event === "AttemptCollected" &&
              collected.runId === event.runId &&
              collected.workItem === event.workItem &&
              collected.attempt === event.attempt &&
              collected.artifactDigest === identity.invocationDigest &&
              events.some(
                (validated) =>
                  validated.kind === "validation" &&
                  validated.passed &&
                  validated.runId === event.runId &&
                  validated.workItem === event.workItem &&
                  validated.attempt === event.attempt &&
                  validated.sequence > event.sequence &&
                  validated.sequence > collected.sequence,
              ),
          );
          if (candidate) {
            if (
              candidate.identity.runId !== event.runId ||
              candidate.identity.workItem !== event.workItem ||
              candidate.identity.attempt !== event.attempt ||
              candidate.validation.artifactDigest !== identity.invocationDigest ||
              ![batch.commandCount, batch.commandCount - 1].includes(
                candidate.validation.commands.length,
              )
            )
              return false;
            const usage = events.filter(
              (entry) =>
                entry.kind === "budget" &&
                entry.event === "BudgetReconciled" &&
                entry.runId === event.runId &&
                entry.workItem === event.workItem &&
                entry.attempt === event.attempt &&
                entry.unit === "validation_milliseconds" &&
                entry.phase === "validation" &&
                entry.usageId ===
                  `integration-validation-${mergeCandidateIdentityDigest(candidate.identity)}`,
            );
            if (
              usage.length !== 1 ||
              usage[0]?.kind !== "budget" ||
              usage[0].amount !==
                Date.parse(candidate.validation.completedAt) -
                  Date.parse(candidate.validation.startedAt)
            )
              return false;
          } else if (!sourceCapacity && !ordinary) return false;
          else if (!sourceCapacity) {
            const duration = events.filter(
              (entry) =>
                entry.kind === "budget" &&
                entry.event === "BudgetReconciled" &&
                entry.runId === event.runId &&
                entry.workItem === event.workItem &&
                entry.attempt === event.attempt &&
                entry.unit === "validation_milliseconds" &&
                entry.phase === "validation" &&
                !entry.usageId,
            );
            if (duration.length !== 1 || duration[0]!.sequence <= event.sequence) return false;
          }
        }
        for (let commandIndex = 0; commandIndex < batch.commandCount; commandIndex++) {
          const observed = await observeLocalScope({ ...identity, commandIndex });
          if (observed.status !== "absent") return false;
        }
      }
      return true;
    } catch (error) {
      if (error instanceof PlatformUnavailableError || error instanceof LeaseLostError) throw error;
      return false;
    }
  }

  async run(): Promise<SupervisorResult> {
    try {
      return await withArtifactContentScope(() => this.#runWithArtifactContent());
    } finally {
      await this.#retryArtifacts.clear();
    }
  }

  /** Cancellation or elapsed immutable authority permits resource retirement,
   * never execution. Keep this outside graph repair, continuation and admission. */
  async #cancelActivatedRun(
    snapshot: Snapshot,
    run: RunState,
    manager: RunManager,
    actor: string,
  ): Promise<SupervisorResult | null> {
    if (!run.activationRequestId || !run.baseSha || !run.repository || this.#options.recovery)
      return null;
    if (run.actor.toLowerCase() !== actor.toLowerCase())
      throw new Error("only the original run actor may reconcile cancellation");
    const binding: ActivationBinding = {
      objective: run.objective,
      requestId: run.activationRequestId,
      requestedBy: run.actor,
      repository: run.repository,
      baseSha: run.baseSha,
      policyDigest: run.policyDigest,
    };
    const readCancellation = async () => {
      const request = await this.#reader.readRunCancellationRequest(
        run.objective,
        run.runId,
        run.actor,
        binding,
      );
      if (!request) return null;
      if (
        request.objective !== run.objective ||
        request.requestedBy.toLowerCase() !== run.actor.toLowerCase() ||
        (request.event === "FactoryRunCancellationRequested" && request.runId !== run.runId) ||
        (request.event === "ActivationCancellationRequested" &&
          !activationCancellation([request], binding))
      )
        throw new Error("cancellation does not bind the original run authority");
      return request;
    };
    const requested = await readCancellation();
    const initial = snapshotEvents(snapshot);
    const scheduling = normalizeSchedulingPolicy(run.policy);
    const outstandingCapacity = deriveCapacityReservations(
      snapshot.workItems.map((item) => ({
        objective: run.objective,
        workItem: item.number,
        events: initial.filter((event) => event.runId === run.runId),
        defaultCpu: scheduling.capacity.local.defaultCpu,
        defaultMemoryMb: scheduling.capacity.local.defaultMemoryMb,
      })),
    );
    const deadline = run.startedAt.getTime() + run.policy.objectiveTimeoutMinutes * 60_000;
    if (!requested && !(Date.now() >= deadline && outstandingCapacity.length)) return null;
    let terminalCancellation = requested;
    const assertActivation = (events: readonly FactoryEvent[]) => {
      const activations = events.filter(
        (event) => event.event === "ActivationRequested" && event.requestId === binding.requestId,
      );
      const activation = activations[0];
      if (
        activations.length !== 1 ||
        activation?.event !== "ActivationRequested" ||
        activation.objective !== run.objective ||
        activation.runId !== binding.requestId ||
        activation.repository.toLowerCase() !== binding.repository.toLowerCase() ||
        activation.requestedBy.toLowerCase() !== binding.requestedBy.toLowerCase() ||
        activation.baseSha !== binding.baseSha ||
        activation.policyDigest !== binding.policyDigest ||
        policyDigest(activation.policy) !== binding.policyDigest
      )
        throw new Error("cancellation lacks its exact authenticated activation");
    };
    assertActivation(initial);
    const base = await this.#store.getBranchHead(snapshot.defaultBranch);
    // Neither cancellation nor expiry retires retained resource liabilities.
    // Keep the ordinary completion/cancellation path only when this snapshot has
    // no outstanding capacity; completed cloud history is not a new obligation.
    if (
      outstandingCapacity.length === 0 &&
      (base.oid === run.baseSha ||
        (await this.#observedRunOwnsBaseAdvance(snapshot, run, base.oid)))
    )
      return null;
    const priorLease = await this.#leases.read(snapshot.number);
    this.#sequences = new SequenceAllocator(
      [...initial, ...(requested ? [requested] : [])],
      run.sequence + 1,
      priorLease ?? undefined,
    );
    // Current Git tree is only the lease's storage parent, not an execution base.
    const acquired = await this.#leases.acquire(
      {
        objective: run.objective,
        runId: run.runId,
        holder: `${actor}-${randomUUID()}`,
        policyDigest: run.policyDigest,
      },
      base,
      this.#sequences.take(),
    );
    this.#lease = new LeaseController(this.#leases, acquired, this.#sequences);
    this.#run = run;
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      void this.#lease.renewIfNeeded().catch((error) => {
        heartbeatError = error;
        this.#lease.fail(error);
      });
    }, 30_000);
    heartbeat.unref();
    const assertCurrent = async () => {
      if (heartbeatError) throw heartbeatError;
      await this.#lease.assert();
      const current = await this.#reader.readObjective(run.objective);
      assertActivation(snapshotEvents(current));
      const observed = manager.resume(current.factoryEvents ?? [], current.objectiveAuthority);
      if (
        !observed ||
        current.number !== run.objective ||
        current.id !== snapshot.id ||
        current.repositoryId !== snapshot.repositoryId ||
        current.authorLogin !== snapshot.authorLogin ||
        current.defaultBranch !== snapshot.defaultBranch ||
        [
          "runId",
          "actor",
          "policyDigest",
          "activationRequestId",
          "baseSha",
          "repository",
          "baseBranch",
          "fork",
        ].some((key) => observed[key as keyof RunState] !== run[key as keyof RunState]) ||
        observed.startedAt.getTime() !== run.startedAt.getTime()
      )
        throw new Error("run changed during cancellation cleanup");
      const cancellation = await readCancellation();
      if (
        terminalCancellation &&
        (!cancellation || cancellation.requestId !== terminalCancellation.requestId)
      )
        throw new Error("exact cancellation disappeared during cleanup");
      if (!cancellation && Date.now() < deadline)
        throw new Error("expired cleanup authority is no longer established");
      if (cancellation) terminalCancellation = cancellation;
      this.#sequences.observe([
        ...snapshotEvents(current),
        ...(cancellation ? [cancellation] : []),
      ]);
      this.#fenceSnapshot(current);
      await this.#lease.assert();
      return current;
    };
    try {
      snapshot = await assertCurrent();
      const graphs = new CompiledGraphManager(this.#store, this.#leases);
      const graph = await graphs.load(run.objective, run.runId);
      if (graph) {
        const projection = await graphs.loadProjection(run.objective, run.runId, graph);
        if (!projection) throw new Error("cancellation graph projection is unavailable");
        this.#compiledGraph = graph.objective;
        this.#compiledProjection = projection;
        this.#fenceSnapshot(snapshot);
      } else if (snapshot.workItems.length)
        throw new Error("cancellation graph ownership is unavailable");
      this.#budgetEvents = this.#accountingEvents(snapshotEvents(snapshot), run.runId);
      const items = this.#deriveObjective(snapshot).items;
      const retired = new Map<string, AttemptReservation>();
      for (const item of items) {
        const reservations = (await this.#attempts.list(run.objective, item.number)).filter(
          (reservation) => reservation.runId === run.runId,
        );
        if (
          (item.factoryEvents ?? []).some(
            (event) =>
              event.kind === "attempt" &&
              event.runId === run.runId &&
              !reservations.some((reservation) => reservation.attempt === event.attempt),
          )
        )
          throw new Error("cancellation attempt receipt lacks its exact reservation ref");
        for (const reservation of reservations) {
          if (
            reservation.objective !== run.objective ||
            reservation.workItem !== item.number ||
            reservation.policyDigest !== run.policyDigest ||
            reservation.directorEpoch > acquired.epoch
          )
            throw new Error("cancellation reservation differs from original ownership");
          snapshot = await assertCurrent();
          const events = snapshotEvents(snapshot).filter(
            (event) =>
              event.runId === run.runId &&
              "workItem" in event &&
              event.workItem === item.number &&
              "attempt" in event &&
              event.attempt === reservation.attempt,
          );
          const backend = this.#registry.get(reservation.backend);
          if (!backend?.reconcileStale)
            throw new Error(`cancellation cleanup unavailable for ${reservation.backend}`);
          if (backend.capabilities.hostExecution && !reservation.localScopeBatch)
            throw new Error("cancellation lacks exact local execution scope");
          const resourceIds = new Set(
            events.flatMap((event) =>
              event.kind === "attempt" && event.providerResourceId
                ? [event.providerResourceId]
                : [],
            ),
          );
          if (resourceIds.size > 1) throw new Error("cancellation resource identity conflicts");
          const executionBudget = unreconciledBudgetReservations(events).find(
            (event) => event.phase === "execution" && event.unit === "sandbox_milliseconds",
          );
          await backend.reconcileStale({
            repository: run.repository,
            objective: run.objective,
            workItem: item.number,
            attempt: reservation.attempt,
            runId: run.runId,
            directorEpoch: reservation.directorEpoch,
            policyDigest: reservation.policyDigest,
            phase: "execution",
            ...(reservation.localScopeBatch
              ? { localScopeBatch: reservation.localScopeBatch }
              : {}),
            ...(resourceIds.size ? { providerResourceId: [...resourceIds][0]! } : {}),
            ...(!resourceIds.size && executionBudget
              ? {
                  noHandleReplacementNotBefore: new Date(
                    Date.parse(executionBudget.at) + executionBudget.amount + 60_000,
                  ).toISOString(),
                }
              : {}),
          });
          await assertCurrent();
          if (reservation.localScopeBatch) {
            await stopLocalScope(reservation.localScopeBatch.identity);
            await assertCurrent();
          }
          // Every recorded validation scope is independently retired, even when a
          // prior completion receipt exists. Missing ownership cannot mean absence.
          const capacities = events.filter(
            (event) => event.kind === "capacity" && event.event === "CapacityReserved",
          );
          for (const capacity of capacities) {
            if (capacity.kind !== "capacity") continue;
            if (!capacity.localScopeBatch)
              throw new Error(
                "cancellation validation resource lacks supported exact local scope ownership",
              );
            const batch = LocalScopeBatchSchema.parse(capacity.localScopeBatch);
            if (
              batch.identity.repository !== run.repository ||
              batch.identity.runId !== run.runId ||
              batch.identity.objective !== run.objective ||
              batch.identity.workItem !== item.number ||
              batch.identity.attempt !== reservation.attempt ||
              batch.identity.policyDigest !== run.policyDigest ||
              batch.identity.phase !== capacity.phase ||
              batch.identity.directorEpoch !== (capacity.recoveryEpoch ?? capacity.directorEpoch)
            )
              throw new Error("cancellation validation scope identity conflicts");
            for (let commandIndex = 0; commandIndex < batch.commandCount; commandIndex++) {
              await assertCurrent();
              await stopLocalScope({ ...batch.identity, commandIndex });
            }
          }
          if (reservation.backend === "codex-app-server/local-worktree")
            await this.#recoverAppServerUsage(item, reservation, events);
          else {
            const terminal = events.filter(
              (event) =>
                event.kind === "attempt" &&
                event.reportedModelTokens !== undefined &&
                [
                  "AttemptSucceeded",
                  "AttemptFailed",
                  "AttemptTimedOut",
                  "AttemptCancelled",
                ].includes(event.event),
            );
            const known = terminal[0];
            if (known?.kind === "attempt") {
              if (
                terminal.some(
                  (event) =>
                    event.kind !== "attempt" ||
                    event.reportedModelTokens !== known.reportedModelTokens,
                )
              )
                throw new Error("cancellation terminal model usage conflicts");
              const actual = events.filter(
                (event) =>
                  event.kind === "budget" &&
                  event.event === "BudgetReconciled" &&
                  event.phase === "execution" &&
                  event.unit === "model_tokens",
              );
              const usageId = `worker-${item.number}-${reservation.attempt}`;
              if (
                actual.some(
                  (event) =>
                    event.kind !== "budget" ||
                    event.amount !== known.reportedModelTokens ||
                    event.usageId !== usageId,
                )
              )
                throw new Error("cancellation model accounting differs from terminal usage");
              const link = this.#modelInvocationLink(usageId, reservation, undefined, "execution");
              if (!this.#hasModelUsageLink(actual, link)) {
                await assertCurrent();
                await this.#lease.use(async (lease) => {
                  this.#budgetEvents.push(
                    await this.#recorder.budget({
                      lease,
                      workItemNodeId: item.id,
                      reservation,
                      sequence: this.#sequences.take(),
                      event: "BudgetReconciled",
                      phase: "execution",
                      unit: "model_tokens",
                      amount: known.reportedModelTokens!,
                      usageId,
                      ...link,
                      ...(known.reportedModelUsage
                        ? { reportedModelUsage: known.reportedModelUsage }
                        : {}),
                    }),
                  );
                });
              }
            }
          }
          const validation = events.find((event) => event.kind === "validation" && event.passed);
          const collected = events.find(
            (event) => event.kind === "attempt" && event.event === "AttemptCollected",
          );
          if (
            validation?.kind === "validation" &&
            collected?.kind === "attempt" &&
            collected.artifactDigest
          ) {
            const review = await this.#reviews.load({
              kind: "artifact",
              runId: run.runId,
              objective: run.objective,
              workItem: item.number,
              attempt: reservation.attempt,
              artifactDigest: collected.artifactDigest,
              baseSha: validation.baseSha,
              outputTreeSha: validation.outputTreeSha,
              evidenceDigest: validation.evidenceDigest,
            });
            if (review) await this.#recordReviewUsage(review, item, reservation);
          }
          for (const capacity of unreconciledCapacityReservations(events)) {
            await assertCurrent();
            // Validation may have been admitted under a later controller than
            // execution. Preserve the original capacity identity, not the older
            // execution reservation's epoch, while fencing this new writer.
            await this.#lease.use(async (lease) => {
              if (
                capacity.directorEpoch > lease.epoch ||
                capacity.policyDigest !== lease.policyDigest
              )
                throw new Error("cancellation capacity is fenced from the current lease");
              await this.#store.addIssueComment(
                item.id,
                encodeEventComment(
                  terminalCancellation
                    ? "Factory reconciled cancelled capacity."
                    : "Factory reconciled expired capacity.",
                  parseFactoryEvent({
                    ...capacity,
                    localScopeBatch: undefined,
                    event: "CapacityReconciled",
                    sequence: this.#sequences.take(),
                    at: (await this.#store.serverTime()).toISOString(),
                    recoveryEpoch: lease.epoch,
                    reason: terminalCancellation
                      ? "operator cancellation proved exact resource absence"
                      : "Objective timeout cleanup proved exact resource absence",
                  }),
                ),
              );
            });
          }
          for (const budget of unreconciledBudgetReservations(events)) {
            if (budget.unit === "model_tokens") continue; // Unknown consumption stays unknown.
            if (
              budget.phase === "management" ||
              (budget.phase === "validation" && !capacities.length)
            )
              throw new Error("cancellation budget lacks exact resource retirement evidence");
            if (
              !["local_milliseconds", "sandbox_milliseconds", "validation_milliseconds"].includes(
                budget.unit,
              )
            )
              throw new Error("cancellation native accounting cannot infer this reserved unit");
            await assertCurrent();
            await this.#lease.use(async (lease) => {
              this.#budgetEvents.push(
                await this.#recorder.budget({
                  lease,
                  workItemNodeId: item.id,
                  reservation,
                  sequence: this.#sequences.take(),
                  event: "BudgetReconciled",
                  phase: budget.phase,
                  unit: budget.unit,
                  amount: budget.amount,
                  ...(budget.usageId ? { usageId: budget.usageId } : {}),
                  usageEvidence: "conservative-reservation",
                  reason: terminalCancellation
                    ? "exact resources absent after cancellation; reserved bound charged, elapsed usage unavailable"
                    : "exact resources absent after Objective timeout; reserved bound charged, elapsed usage unavailable",
                }),
              );
            });
          }
          // AttemptSucceeded intentionally does not imply resource absence. The
          // original artifact/usage remains successful; retire only this exact
          // execution capacity after independently proving cleanup above.
          const scheduling = normalizeSchedulingPolicy(run.policy);
          const executionCapacity = deriveCapacityReservations([
            {
              objective: run.objective,
              workItem: item.number,
              events,
              defaultCpu: scheduling.capacity.local.defaultCpu,
              defaultMemoryMb: scheduling.capacity.local.defaultMemoryMb,
            },
          ]).find(
            (capacity) =>
              capacity.phase === "execution" &&
              capacity.attempt === reservation.attempt &&
              capacity.backendId === reservation.backend,
          );
          if (executionCapacity) {
            await assertCurrent();
            await this.#lease.use(async (lease) => {
              await this.#store.addIssueComment(
                item.id,
                encodeEventComment(
                  terminalCancellation
                    ? "Factory reconciled cancelled execution capacity after exact resource cleanup."
                    : "Factory reconciled expired execution capacity after exact resource cleanup.",
                  parseFactoryEvent({
                    protocol: PROTOCOL_V2,
                    kind: "capacity",
                    event: "CapacityReconciled",
                    objective: run.objective,
                    runId: run.runId,
                    workItem: item.number,
                    attempt: reservation.attempt,
                    phase: "execution",
                    backend: reservation.backend,
                    requestedCpu: executionCapacity.cpu,
                    requestedMemoryMb: executionCapacity.memoryMb,
                    directorEpoch: reservation.directorEpoch,
                    recoveryEpoch: lease.epoch,
                    policyDigest: reservation.policyDigest,
                    sequence: this.#sequences.take(),
                    at: (await this.#store.serverTime()).toISOString(),
                    reason: terminalCancellation
                      ? "operator cancellation proved exact original execution resource absence"
                      : "Objective timeout cleanup proved exact original execution resource absence",
                  }),
                ),
              );
            });
          }
          if (
            !events.some(
              (event) =>
                event.kind === "attempt" &&
                [
                  "AttemptSucceeded",
                  "AttemptFailed",
                  "AttemptTimedOut",
                  "AttemptCancelled",
                  "AttemptDeferred",
                  "AttemptIntegrated",
                ].includes(event.event),
            )
          ) {
            await assertCurrent();
            await this.#lease.use((lease) =>
              this.#attempts.record({
                lease,
                workItemNodeId: item.id,
                reservation,
                sequence: this.#sequences.take(),
                event: "AttemptCancelled",
                allowRecovery: true,
                reason: terminalCancellation
                  ? "operator cancelled original attempt after exact resource cleanup; unknown model usage is not zero"
                  : "Objective timeout retired original attempt after exact resource cleanup; unknown model usage is not zero",
              }),
            );
          }
          retired.set(`${item.number}:${reservation.attempt}`, reservation);
        }
      }
      snapshot = await assertCurrent();
      const remaining = snapshotEvents(snapshot).filter((event) => event.runId === run.runId);
      const scheduling = normalizeSchedulingPolicy(run.policy);
      if (
        unreconciledCapacityReservations(remaining).length ||
        deriveCapacityReservations(
          snapshot.workItems.map((item) => ({
            objective: run.objective,
            workItem: item.number,
            events: remaining,
            defaultCpu: scheduling.capacity.local.defaultCpu,
            defaultMemoryMb: scheduling.capacity.local.defaultMemoryMb,
          })),
        ).length ||
        unreconciledBudgetReservations(remaining).some((event) => event.unit !== "model_tokens")
      )
        throw new Error("cancellation has unresolved resource or native accounting ownership");
      for (const marker of unresolvedModelInvocations(remaining)) {
        const reservation = retired.get(`${marker.workItem}:${marker.attempt}`);
        if (marker.phase === "management")
          throw new Error("cancellation management invocation cleanup is not independently known");
        if (
          !reservation ||
          marker.policyDigest !== reservation.policyDigest ||
          marker.directorEpoch !== reservation.directorEpoch
        )
          throw new Error(
            "cancellation unknown execution invocation lacks exact resource retirement",
          );
      }
      return await this.#terminal(
        manager,
        snapshot,
        terminalCancellation ? "FactoryRunCancelled" : "FactoryRunEscalated",
        terminalCancellation
          ? "operator requested cleanup-only cancellation; retained work was not resumed"
          : "Objective timeout exhausted; exact retained resource cleanup completed without resuming work",
      );
    } catch (error) {
      await this.#lease.release().catch(() => {});
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #runWithArtifactContent(): Promise<SupervisorResult> {
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
    if (resumedRun?.activationRequestId && !this.#options.recovery) {
      const cancelled = await this.#cancelActivatedRun(snapshot, resumedRun, runManager, actor);
      if (cancelled) return cancelled;
    }
    if (
      snapshot.closed &&
      !(
        resumedRun &&
        Date.now() >= resumedRun.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000
      )
    ) {
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
    const recoveryBlocker = await inspectImplicitRestart(snapshot, () =>
      listAttemptReservationRefs(this.#store, snapshot.number),
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
              captureMutationFence: () => this.#captureMutationFence(),
              mutationScope: `objective:${this.#options.objective}:managed-dispatch`,
              onMutationOperation: this.#store.recordMutationOperation,
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
      !(resumedRun
        ? await this.#observedRunOwnsBaseAdvance(snapshot, resumedRun, base.oid)
        : await this.#observedPeerBaseAdvance(snapshot, this.#options.activation.baseSha, base.oid))
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
      const expiredResume = Boolean(
        resumedRun &&
          Date.now() >=
            resumedRun.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
      );
      const needsReconciliation = Boolean(
        !expiredResume && this.#options.recovery && !this.#recoveryRuntime,
      );
      let currentRun = await this.#resumeObservedRun(
        current,
        runManager,
        expiredResume ? "inspect" : "repair",
      );
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
      if (!currentRun) {
        // The lease fences Factory writers while this fresh activation is
        // classified. Invalid child-issue state is an activation rejection,
        // not a started run that later needs terminal recovery.
        await this.#lease.assert();
        try {
          inspectObjectiveGraphInput(current);
        } catch (error) {
          const reason = `Objective graph preflight failed: ${error instanceof Error ? error.message : String(error)}`;
          const rejected = await this.#startlessEscalation(reason, current, actor);
          await this.#lease.release();
          return rejected;
        }
      }
      if (
        (current.closed && !expiredResume) ||
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
        const blocker = await inspectImplicitRestart(current, () =>
          listAttemptReservationRefs(this.#store, current.number),
        );
        if (blocker) {
          const rejected = await this.#startlessEscalation(blocker, current, actor);
          await this.#lease.release();
          return rejected;
        }
      }
      // The original activation remains immutable across restarts. Recheck its
      // permitted progress under the lease before writing any resumed-run effect.
      if (this.#options.activation) {
        const currentBase = await this.#store.getBranchHead(current.defaultBranch);
        if (
          currentBase.oid !== this.#options.activation.baseSha &&
          !(currentRun
            ? await this.#observedRunOwnsBaseAdvance(current, currentRun, currentBase.oid)
            : await this.#observedPeerBaseAdvance(
                current,
                this.#options.activation.baseSha,
                currentBase.oid,
              ))
        )
          throw new Error("base branch advanced outside this run during startup");
      }
      snapshot = current;
      this.#sequences.observe(snapshotEvents(snapshot));
      this.#budgetEvents = this.#accountingEvents(snapshotEvents(snapshot), runId);
      if (!currentRun) {
        const activation = this.#options.activation;
        const recordedActivation =
          activation &&
          (snapshot.factoryEvents ?? []).some(
            (event) =>
              event.event === "ActivationRequested" &&
              event.objective === snapshot.number &&
              event.requestId === activation.requestId &&
              event.runId === activation.requestId &&
              event.baseSha === activation.baseSha &&
              event.repository.toLowerCase() === facts.fullName.toLowerCase() &&
              event.requestedBy.toLowerCase() === actor.toLowerCase() &&
              event.policyDigest === policyDigest(this.#policy) &&
              policyDigest(event.policy) === event.policyDigest,
          );
        if (recordedActivation) assertSupportedModelTokenBudgetIntent(this.#policy);
        else assertNewRunBudgetIntent(this.#policy);
      }
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
          writer: acquired,
          authority: snapshot.objectiveAuthority,
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
      if (!expiredResume) await this.#recordControllerObservation(snapshot);
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
    type DrainOutcome =
      | {
          event: "FactoryRunCompleted" | "FactoryRunCancelled" | "FactoryRunEscalated";
          reason?: string;
        }
      | { event: "release-shutdown" | "release-command"; reason?: never };
    const terminalVeto = (error: unknown): boolean =>
      error instanceof LeaseLostError ||
      error instanceof PlatformUnavailableError ||
      error instanceof SafeArtifactCheckpointHeldError ||
      error instanceof ArtifactCompletionUnavailableError ||
      error instanceof ArtifactCollectionCheckpointError ||
      error instanceof ProviderQuotaDrainIncompleteError ||
      error instanceof ProviderResourceCleanupError ||
      error instanceof CancellationAccountingPublicationError ||
      (error instanceof Error &&
        /automated replacement is blocked|cannot prove (?:that )?(?:the )?resource absent|may still be (?:active|billable)/i.test(
          error.message,
        ));
    const drainExecutions = async (proposed: DrainOutcome): Promise<DrainOutcome> => {
      executionAbort.abort();
      const settlements = await activeExecutions.settle();
      // Intentional teardown reports this typed cancellation only after the
      // execution has reconciled cleanup and its attempt receipt. It is not a
      // new operator command and must not replace the outcome being drained for.
      // Safety/cleanup uncertainty vetoes every terminal proposal. Otherwise a
      // late human-authority failure deterministically turns any proposal into
      // escalation, just as the same failure does when claimed before drain.
      const errors = settlements.flatMap((settlement) =>
        settlement.error === undefined ? [] : [settlement.error],
      );
      const veto = errors.find(terminalVeto);
      if (veto !== undefined) throw veto;
      const escalation = errors.find(
        (error) =>
          !(error instanceof RunCancellationRequestedError) &&
          !(error instanceof CompilerDraftReportCompleted),
      );
      if (escalation !== undefined)
        return {
          event: "FactoryRunEscalated",
          reason: escalation instanceof Error ? escalation.message : String(escalation),
        };
      const completed = errors.find((error) => error instanceof CompilerDraftReportCompleted);
      if (completed instanceof CompilerDraftReportCompleted)
        return { event: "FactoryRunCompleted", reason: completed.message };
      return proposed;
    };
    const terminalAfterDrain = async (
      event: "FactoryRunCompleted" | "FactoryRunCancelled" | "FactoryRunEscalated",
      reason?: string,
    ): Promise<SupervisorResult> => {
      const outcome = await drainExecutions({ event, ...(reason ? { reason } : {}) });
      if (outcome.event === "release-shutdown" || outcome.event === "release-command")
        throw new Error("terminal drain produced an invalid release outcome");
      let terminalEvent = outcome.event;
      let terminalReason = outcome.reason;
      snapshot = await this.#reader.readObjective(snapshot.number);
      this.#fenceSnapshot(snapshot);
      this.#sequences.observe(snapshotEvents(snapshot));
      if (outcome.event === "FactoryRunEscalated") {
        const cancellation = await this.#reader.readRunCancellationRequest(
          this.#run.objective,
          this.#run.runId,
          this.#run.actor,
          this.#activationBinding(),
        );
        if (
          cancellation ||
          hasCancellationRequest(snapshot, this.#run.runId) ||
          (this.#options.signal?.aborted && this.#options.shutdownBehavior !== "release-lease")
        ) {
          if (cancellation) this.#sequences.observe([cancellation]);
          terminalEvent = "FactoryRunCancelled";
          terminalReason = "operator requested cancellation";
        }
      }
      return this.#terminal(runManager, snapshot, terminalEvent, terminalReason);
    };
    const releaseAfterDrain = async (): Promise<SupervisorResult> => {
      const outcome = await drainExecutions({ event: "release-shutdown" });
      if (outcome.event === "release-shutdown") return this.#releaseForShutdown(snapshot);
      if (outcome.event === "release-command")
        throw new Error("shutdown drain produced an invalid command release outcome");
      snapshot = await this.#reader.readObjective(snapshot.number);
      this.#fenceSnapshot(snapshot);
      this.#sequences.observe(snapshotEvents(snapshot));
      return this.#terminal(runManager, snapshot, outcome.event, outcome.reason);
    };
    const releaseCommandAfterDrain = async (): Promise<SupervisorResult> => {
      const outcome = await drainExecutions({ event: "release-command" });
      if (outcome.event === "release-command") return this.#releaseForDrain(snapshot);
      if (outcome.event === "release-shutdown")
        throw new Error("command drain produced an invalid shutdown release outcome");
      snapshot = await this.#reader.readObjective(snapshot.number);
      this.#fenceSnapshot(snapshot);
      this.#sequences.observe(snapshotEvents(snapshot));
      return this.#terminal(runManager, snapshot, outcome.event, outcome.reason);
    };
    const finishExpired = async (): Promise<SupervisorResult> => {
      snapshot = await this.#reader.readObjective(snapshot.number);
      this.#sequences.observe(snapshotEvents(snapshot));
      if (hasCancellationRequest(snapshot, this.#run.runId) || this.#options.signal?.aborted)
        return terminalAfterDrain("FactoryRunCancelled", "operator requested cancellation");
      if (
        activeExecutions.size === 0 &&
        (await this.#recordedCompletionReady(snapshot, deadline))
      ) {
        await activeExecutions.waitForIdle();
        activeExecutions.throwNextFailure();
        const finalSnapshot = await this.#reader.readObjective(snapshot.number);
        this.#sequences.observe(snapshotEvents(finalSnapshot));
        if (hasCancellationRequest(finalSnapshot, this.#run.runId) || this.#options.signal?.aborted)
          return terminalAfterDrain("FactoryRunCancelled", "operator requested cancellation");
        if (await this.#recordedCompletionReady(finalSnapshot, deadline)) {
          const cancellation = await this.#reader.readRunCancellationRequest(
            this.#run.objective,
            this.#run.runId,
            this.#run.actor,
            this.#activationBinding(),
          );
          if (cancellation)
            return terminalAfterDrain("FactoryRunCancelled", "operator requested cancellation");
          await this.#lease.assert();
          this.#options.signal?.throwIfAborted();
          if (!finalSnapshot.closed) await this.#store.closeIssue(finalSnapshot.number);
          return terminalAfterDrain("FactoryRunCompleted");
        }
      }
      return terminalAfterDrain("FactoryRunEscalated", "Objective timeout exhausted");
    };
    const escalateAfterDrain = async (
      item: DerivedWorkItem,
      reason: string,
    ): Promise<SupervisorResult> => {
      const outcome = await drainExecutions({ event: "FactoryRunEscalated", reason });
      if (outcome.event === "release-shutdown" || outcome.event === "release-command")
        throw new Error("escalation drain produced an invalid release outcome");
      snapshot = await this.#reader.readObjective(snapshot.number);
      this.#fenceSnapshot(snapshot);
      this.#sequences.observe(snapshotEvents(snapshot));
      if (outcome.event !== "FactoryRunEscalated" || outcome.reason !== reason)
        return this.#terminal(runManager, snapshot, outcome.event, outcome.reason);
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
      const startupProviderGateState = providerQuotaGateState(
        snapshotEvents(snapshot),
        this.#run.runId,
      );
      const startupProviderGate = startupProviderGateState?.gate;
      const startupProviderAccounting = startupProviderGateState?.accounting ?? "unknown";
      // An expired run normally cannot repair graph/publication/checkpoint state. A
      // work-item provider gate is different: its already-admitted durable attempt
      // must reach the reconciliation path below before any terminal receipt can be
      // written, even when the controller restarts after the deadline.
      if (Date.now() >= deadline && startupProviderGate?.workItem === undefined)
        return await finishExpired();
      if (startupProviderGate?.kind === "provider" && startupProviderGate.workItem === undefined) {
        if (this.#options.signal?.aborted) {
          if (this.#options.shutdownBehavior === "release-lease") return await releaseAfterDrain();
          return await terminalAfterDrain("FactoryRunCancelled", "operator cancelled run");
        }
        if (hasCancellationRequest(snapshot, this.#run.runId))
          return await terminalAfterDrain(
            "FactoryRunCancelled",
            "operator requested cancellation through GitHub",
          );
        return await terminalAfterDrain(
          "FactoryRunEscalated",
          startupProviderAccounting === "unknown"
            ? `${startupProviderGate.providerMessage}; model usage remains unknown, so this run cannot currently be recovered`
            : `${startupProviderGate.providerMessage}; restore provider quota${startupProviderGate.actionUrl ? ` at ${startupProviderGate.actionUrl}` : ""} before explicit recovery`,
        );
      }
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
      if (
        (this.#recoveryRuntime || this.#recoveryGraphBootstrap) &&
        this.#policy.compilerEvaluation?.mode === "report-only"
      )
        throw new Error(
          "report-only evaluation cannot resume execution authority; inspect historical compiler-eval evidence instead",
        );
      if (this.#recoveryRuntime) {
        await this.#prepareRecoveryGraph(snapshot);
      } else {
        const observedGraph = inspectObjectiveGraphInput(snapshot);
        const legacyGraphConstraints = observedGraph.legacyGraphConstraints;
        const legacyConstraintDigest = legacyGraphConstraints
          ? legacyGraphConstraintsDigest(legacyGraphConstraints)
          : null;
        const legacyObjectiveInputDigest = legacyGraphConstraints
          ? compilerEvalDigest({
              number: snapshot.number,
              title: snapshot.title,
              body: snapshot.body,
            })
          : null;
        if (this.#recoveryGraphBootstrap) {
          const authorized = this.#recoveryGraphBootstrap.planRecord.plan.graph;
          if (
            !isRecoveryAdoptionGraph(authorized) ||
            authorized.sourceRunId !== this.#run.runId ||
            legacyObjectiveInputDigest !== authorized.objectiveInputDigest ||
            legacyConstraintDigest !== authorized.constraintDigest
          )
            throw new Error("successor legacy graph constraints changed after acknowledgement");
        }
        const graphManager = new CompiledGraphManager(this.#store, this.#leases);
        let durableGraph = await graphManager.load(snapshot.number, this.#run.runId);
        const receiptGraph = observedGraph.receiptRunId
          ? observedGraph.receiptRunId === this.#run.runId
            ? durableGraph
            : await graphManager.load(snapshot.number, observedGraph.receiptRunId)
          : null;
        if (receiptGraph && observedGraph.expectedDigest) {
          if (
            receiptGraph.graphDigest !== observedGraph.expectedDigest ||
            receiptGraph.graphSize !== observedGraph.expectedSize ||
            receiptGraph.ref !== observedGraph.expectedRef ||
            receiptGraph.blobOid !== observedGraph.expectedBlobSha
          ) {
            throw new Error("durable compiled graph does not match its Objective receipt");
          }
        }
        if (observedGraph.expectedDigest && !receiptGraph)
          throw new Error("authenticated compiled graph record is unavailable");
        if (durableGraph && observedGraph.receiptRunId !== this.#run.runId) {
          const commit = await this.#store.readCommit(durableGraph.commitOid);
          if (receiptGraph) {
            if (
              durableGraph.graphDigest !== receiptGraph.graphDigest ||
              durableGraph.graphSize !== receiptGraph.graphSize ||
              durableGraph.compilation !== undefined ||
              commit.oid !== durableGraph.commitOid ||
              commit.parentOids.length !== 1 ||
              commit.parentOids[0] !== base.oid
            )
              throw new Error("current run graph differs from its authenticated source graph");
          } else if (!this.#policy.compilerEvaluation) {
            // Ordinary compilation authenticates this pre-receipt restart
            // window through its single invocation checkpoint. Evaluated
            // compilation uses immutable draft-stage records instead; those
            // are verified below by assertCompilerDraftSelection before any
            // graph receipt or projection is allowed.
            assertAuthenticatedCompilationCheckpoint({
              graph: durableGraph,
              graphCommit: commit,
              events: snapshotEvents(snapshot),
              objective: snapshot.number,
              runId: this.#run.runId,
              expectedBaseSha: base.oid,
              expectedInvocationId: `compile-${base.oid}`,
              expectedPolicyDigest: policyDigest(this.#policy),
            });
          }
        }
        const sourceGraph = durableGraph ?? receiptGraph;
        if (this.#policy.compilerEvaluation && sourceGraph && !durableGraph)
          throw new Error(
            "draft evaluation cannot replace an activated historical graph; use compiler-eval to inspect its evidence",
          );
        if (this.#policy.compilerEvaluation && durableGraph) {
          if (this.#policy.compilerEvaluation.mode === "report-only")
            throw new Error("report-only policy cannot project an execution graph");
          const draftRecords = await loadCompilerDrafts(
            this.#store,
            snapshot.number,
            this.#run.runId,
          );
          assertCompilerDraftSelection(
            draftRecords,
            durableGraph.objective,
            observedGraph.hasReceipt
              ? undefined
              : compilerEvalDigest({
                  number: snapshot.number,
                  title: snapshot.title,
                  body: snapshot.body,
                }),
          );
          if (
            draftRecords[0]?.binding.baseSha !== base.oid ||
            draftRecords[0]?.binding.policyDigest !== policyDigest(this.#policy)
          )
            throw new Error("compiler selection policy or base changed");
        }
        const recoverableObjective = sourceGraph?.objective ?? observedGraph.completeObjective;
        if (this.#policy.compilerEvaluation && recoverableObjective && !durableGraph)
          throw new Error("existing issue graph cannot bypass the independent draft assessment");
        let invokeCompilation:
          | ((checkpoint: CompilationCheckpoint) => Promise<CompilationResult>)
          | undefined;
        const compilationInvocationId = `compile-${base.oid}`;
        if (!recoverableObjective) {
          if (!this.#policy.compilerEvaluation)
            this.#assertManagementInvocationNotFailed(compilationInvocationId);
          this.#notify("compiling Objective into a dependency graph");
          if (observedGraph.hasReceipt || observedGraph.existing.length > 0) {
            throw new Error(
              "compiled graph receipt exists but its durable graph record is missing",
            );
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
            this.#externalAdmission(async () => {
              await ensureLocalCommit(this.#options.repository, base.oid);
              const repositoryLfs = await assertLocalLfsAvailable(
                this.#options.repository,
                base.oid,
              );
              const tree = await materializePinnedCompilationTree(
                this.#options.repository,
                base.oid,
              );
              try {
                await materializeLocalLfsAssets(this.#options.repository, tree.path, base.oid);
                const observedCapacity = await this.#capacitySnapshot();
                const context: CompilationContext = {
                  repository: tree.path,
                  objective: {
                    number: snapshot.number,
                    title: snapshot.title,
                    body: snapshot.body,
                  },
                  ...(legacyGraphConstraints ? { legacyGraphConstraints } : {}),
                  defaultBranch: snapshot.defaultBranch,
                  baseSha: base.oid,
                  repositoryFiles: tree.files,
                  repositoryLfs,
                  allowedNetworkDestinations: this.#policy.allowedNetworkDestinations,
                  runPolicy: this.#policy,
                  invocationTimeoutMs: Math.min(
                    deadline - Date.now(),
                    this.#policy.workItemTimeoutMinutes * 60_000,
                  ),
                  economicEvidence: (items) =>
                    collectCompilationEvidence(items, {
                      objective: snapshot.number,
                      policy: this.#policy,
                      capacity: observedCapacity,
                      repositoryLimits: this.#controllerLimits,
                      deliveryMode: this.#deliverySelection.selected,
                      nowMs: Date.now(),
                      cooldownUntilMs: this.#resourceSampler.cooldownUntil,
                      sampleResource: (nowMs) => this.#resourceSampler.sample(nowMs),
                      evaluate: (input) => this.#registry.evaluate(input),
                    }),
                  ...(compilationModel ? { modelSelection: compilationModel } : {}),
                };
                if (!this.#policy.compilerEvaluation) {
                  const admitCompilation = async () => {
                    const timeoutMs = await this.#externalAdmission(async () =>
                      Math.min(
                        await this.#admitModelInvocation(compilationInvocationId, snapshot.id),
                        this.#policy.workItemTimeoutMinutes * 60_000,
                      ),
                    );
                    return {
                      timeoutMs,
                      modelInvocationId: compilationInvocationId,
                      checkpointProviderRefusal: (error: ProviderQuotaError) =>
                        this.#recordProviderQuotaGate(
                          error,
                          snapshot.id,
                          "management",
                          this.#management.id,
                        ),
                    };
                  };
                  if (this.#management.supportsCompilerAdmission) {
                    return await this.#management.compile(context, checkpoint, admitCompilation);
                  }
                  // Compatibility for injected legacy backends that cannot place
                  // durable admission at their own final dispatch boundary.
                  context.invocationTimeoutMs = (await admitCompilation()).timeoutMs;
                  return await this.#management.compile(context, checkpoint);
                }
                const inputDigest = compilerEvalDigest(context.objective);
                const assertInputs = async () => {
                  await this.#externalAdmission(async () => {});
                  if (this.#options.signal?.aborted)
                    throw new RunCancellationRequestedError(
                      "operator cancelled during draft compilation",
                    );
                  if (Date.now() >= deadline)
                    throw new Error("Objective deadline exhausted during draft compilation");
                  const fresh = await this.#reader.readObjective(snapshot.number);
                  this.#fenceSnapshot(fresh);
                  if (
                    compilerEvalDigest({
                      number: fresh.number,
                      title: fresh.title,
                      body: fresh.body,
                    }) !== inputDigest
                  )
                    throw new Error(
                      "Objective changed during draft evaluation; new inputs require a new run",
                    );
                  const currentLegacy = inspectObjectiveGraphInput(fresh).legacyGraphConstraints;
                  if (
                    legacyConstraintDigest !==
                    (currentLegacy ? legacyGraphConstraintsDigest(currentLegacy) : null)
                  )
                    throw new Error(
                      "legacy Work Items changed during draft evaluation; new inputs require a new recovery plan",
                    );
                };
                const outcome = await this.#lease.use((lease) =>
                  compileEvaluatedDraft({
                    context,
                    backend: this.#management,
                    manager: new CompilerDraftManager(this.#store, this.#leases),
                    lease,
                    binding: {
                      repository: `${this.#options.owner}/${this.#options.repo}`,
                      objective: snapshot.number,
                      runId: this.#run.runId,
                      policyDigest: policyDigest(this.#policy),
                      baseSha: base.oid,
                      inputDigest,
                    },
                    admit: (id) =>
                      this.#externalAdmission(async () => {
                        await this.#admitModelInvocation(id, snapshot.id);
                      }),
                    recordUsage: (id, _stage, usage) =>
                      this.#recordManagementUsage(id, usage, snapshot.id, undefined, `draft-${id}`),
                    assertInputs,
                    validate: async (graph) => {
                      assertGraphWithinRunPolicy(graph, this.#policy);
                    },
                    deadlineAt: deadline,
                  }),
                );
                await assertInputs();
                if (
                  this.#policy.compilerEvaluation.mode === "report-only" &&
                  !(
                    outcome.status === "stopped" &&
                    /accounting|invocation-conflict/.test(outcome.reason)
                  )
                ) {
                  throw new CompilerDraftReportCompleted(
                    `Report-only compiler evaluation completed: ${outcome.status === "accepted" ? "accepted draft" : outcome.reason}. No implementation was authorized and no Work Items were projected; inspect compiler-eval for the retained evidence.`,
                  );
                }
                if (outcome.status !== "accepted")
                  throw new Error(`compiler draft stopped without projection: ${outcome.reason}`);
                await assertInputs();
                const usage = outcome.records
                  .filter((record) => record.kind === "result")
                  .reduce(
                    (total, record) => {
                      const used = record.payload.usage as ManagementUsage;
                      return {
                        inputTokens: total.inputTokens + used.inputTokens,
                        outputTokens: total.outputTokens + used.outputTokens,
                      };
                    },
                    { inputTokens: 0, outputTokens: 0 },
                  );
                const result = { objective: outcome.graph, usage };
                await checkpoint(result);
                return result;
              } finally {
                // A durable successful checkpoint must not become a repeated paid call
                // merely because this exact owned temporary directory could not be removed.
                await tree
                  .dispose()
                  .catch(() =>
                    this.#notify(`compilation tree cleanup needs attention: ${tree.path}`),
                  );
              }
            });
        } else if (!durableGraph) {
          // A graph recovered from an older run or issue receipt is copied into
          // this run's immutable ref before any backend preflight can fail.
          durableGraph = await this.#lease.use((lease) =>
            graphManager.persist({
              lease,
              base,
              ...(sourceGraph ? { source: sourceGraph } : { objective: recoverableObjective }),
            }),
          );
        }
        durableGraph = await this.#compilationTransaction({
          existing: durableGraph,
          ...(invokeCompilation ? { invoke: invokeCompilation } : {}),
          persist: (result) =>
            this.#lease.use((lease) =>
              graphManager.persist({
                lease,
                base,
                objective: result.objective,
                ...(this.#policy.compilerEvaluation
                  ? {}
                  : {
                      compilation: {
                        invocationId: compilationInvocationId,
                        inputTokens: result.usage.inputTokens,
                        outputTokens: result.usage.outputTokens,
                        ...(result.usage.cachedInputTokens === undefined
                          ? {}
                          : { cachedInputTokens: result.usage.cachedInputTokens }),
                      },
                    }),
              }),
            ),
          recover: () => graphManager.load(snapshot.number, this.#run.runId),
          recordFailureUsage: (usage) =>
            this.#recordManagementUsage(compilationInvocationId, usage, snapshot.id),
          recordProviderGate: (error) =>
            this.#recordProviderQuotaGate(error, snapshot.id, "management", this.#management.id),
          recordUsage: async (record) => {
            if (!record.compilation) return;
            const amount = record.compilation.inputTokens + record.compilation.outputTokens;
            const usageId = `compile-${record.graphDigest}`;
            const link = this.#modelInvocationLink(record.compilation.invocationId);
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
            if (this.#hasModelUsageLink(matching, link)) return;
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
                  ...link,
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
                  event.amount === amount &&
                  this.#hasModelUsageLink([event], link),
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
            if (legacyGraphConstraints)
              assertCompiledObjectiveAdoptsLegacyConstraints(objective, legacyGraphConstraints);
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
            this.#validateCompiledGraphStatic(objective);
          },
        });
        const compiled = durableGraph.objective;
        const refreshLegacySnapshot = async (reason: string) => {
          if (!legacyGraphConstraints) return;
          const fresh = await this.#reader.readObjective(snapshot.number);
          const current = inspectObjectiveGraphInput(fresh);
          if (
            legacyObjectiveInputDigest !==
              compilerEvalDigest({ number: fresh.number, title: fresh.title, body: fresh.body }) ||
            legacyConstraintDigest !==
              (current.legacyGraphConstraints
                ? legacyGraphConstraintsDigest(current.legacyGraphConstraints)
                : null)
          )
            throw new Error(`legacy Work Item constraints changed ${reason}`);
          assertExistingGraphWorkItemsMatchCompiled(compiled, current.existing);
          snapshot = fresh;
          this.#sequences.observe(snapshotEvents(snapshot));
        };
        await refreshLegacySnapshot("during Objective compilation");
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
        const pendingGraphMutations = pendingGraphQlGraphMutations(
          compiled,
          existingGraphItems,
          legacyGraphConstraints,
        );
        assertGraphQlAdmissionHeadroom(
          snapshot.graphQlRateLimit,
          this.#policy,
          Math.min(this.#policy.maxParallel, compiled.workItems.length),
          this.#notify,
          pendingGraphMutations *
            (legacyGraphConstraints ? (snapshot.graphQlRateLimit?.cost ?? 1) + 1 : 1),
        );
        if (observedGraph.receiptRunId !== this.#run.runId) {
          if (this.#policy.compilerEvaluation) {
            const fresh = await this.#reader.readObjective(snapshot.number);
            this.#fenceSnapshot(fresh);
            const records = await loadCompilerDrafts(this.#store, snapshot.number, this.#run.runId);
            assertCompilerDraftSelection(
              records,
              compiled,
              compilerEvalDigest({ number: fresh.number, title: fresh.title, body: fresh.body }),
            );
          }
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
        // Authenticate the immutable graph before checking transient runtime
        // availability. A missing backend/tool must not orphan a paid compiler
        // result and force a second model invocation on restart. No Work Item,
        // attempt, or publication mutation occurs before this preflight passes.
        await this.#preflightCompiledGraphRuntime(compiled);
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
          beforeMutation: () => refreshLegacySnapshot("before a graph adoption write"),
          captureMutationFence: () => this.#captureMutationFence(),
          mutationScope: `objective:${this.#options.objective}:graph`,
          onMutationOperation: this.#store.recordMutationOperation,
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
              ...(legacyGraphConstraints ? { legacyGraphConstraints } : {}),
              ...(compiled.deferredCapabilityAdapters === undefined
                ? { allowAuthenticatedLegacyOmissions: true }
                : {}),
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
            const recovered = inspectObjectiveGraphInput(snapshot);
            if (
              recovered.expectedDigest !== durableGraph.graphDigest ||
              recovered.expectedRef !== durableGraph.ref ||
              recovered.expectedBlobSha !== durableGraph.blobOid
            ) {
              throw error;
            }
            if (
              legacyConstraintDigest !==
              (recovered.legacyGraphConstraints
                ? legacyGraphConstraintsDigest(recovered.legacyGraphConstraints)
                : null)
            )
              throw new Error("legacy Work Item constraints changed during graph adoption");
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
        await refreshLegacySnapshot("before graph projection");
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
        if (this.#recoveryGraphBootstrap) {
          snapshot = await this.#reader.readObjective(snapshot.number);
          this.#sequences.observe(snapshotEvents(snapshot));
          const completed = await loadRecoveryRuntime({
            objective: snapshot.number,
            runId: this.#run.runId,
            store: this.#recoveryStore,
            readSnapshot: async () => ({ snapshot, historyComplete: true }),
            ...(this.#options.signal ? { signal: this.#options.signal } : {}),
          });
          if (
            completed.status !== "verified" ||
            completed.planRecord.digest !== this.#recoveryGraphBootstrap.planRecord.digest
          )
            throw new Error("successor graph adoption did not produce a verified runtime");
          this.#recoveryRuntime = completed;
          this.#recoveryGraphBootstrap = null;
        }
      }
      runLoop: for (;;) {
        // Capture before any snapshot or admission work so a peer-capacity change during this
        // iteration cannot happen between our decision and listener registration unnoticed.
        const fairnessRevision = this.#fairness.revision;
        const executionRevision = activeExecutions.revision;
        if (heartbeatError) throw heartbeatError;
        activeExecutions.throwNextFailure();
        await this.#lease.renewIfNeeded();
        snapshot = await this.#reader.readObjective(snapshot.number);
        // A hold/cleanup failure can settle while the snapshot is in flight.
        // An absent active key must not turn that failure into same-process recovery.
        activeExecutions.throwNextFailure();
        this.#fenceSnapshot(snapshot);
        this.#ciExpectedOnPullRequests = snapshot.ciExpectedOnPullRequests;
        this.#sequences.observe(snapshotEvents(snapshot));
        const durableProviderGates = providerQuotaGates(snapshotEvents(snapshot), this.#run.runId);
        const durableProviderGate = durableProviderGates.at(-1);
        const durableProviderGateState = providerQuotaGateState(
          snapshotEvents(snapshot),
          this.#run.runId,
        );
        const cancellationReason = this.#options.signal?.aborted
          ? "operator cancelled run"
          : hasCancellationRequest(snapshot, this.#run.runId)
            ? "operator requested cancellation through GitHub"
            : undefined;
        const deadlineExpired = Date.now() >= deadline;
        if (
          (cancellationReason || deadlineExpired) &&
          durableProviderGates.some((gate) => gate.workItem !== undefined)
        ) {
          const gatedObjective = this.#deriveObjective(snapshot);
          await this.#reconcileObjectiveCapacity(gatedObjective.number, gatedObjective.items);
          const gatedRecoverable: DerivedWorkItem[] = [];
          for (const item of gatedObjective.items) {
            if (activeExecutions.has(item.number)) continue;
            if (await this.#needsDurableAttemptRecovery(item, durableProviderGates, true))
              gatedRecoverable.push(item);
          }
          const interruptedTerminal =
            this.#options.signal?.aborted && this.#options.shutdownBehavior === "release-lease"
              ? "AttemptDeferred"
              : cancellationReason
                ? "AttemptCancelled"
                : "AttemptTimedOut";
          for (const item of gatedRecoverable)
            await this.#reconcileInterruptedForEarlyTerminal(
              item,
              gatedObjective.items,
              interruptedTerminal,
            );
          snapshot = await this.#reader.readObjective(snapshot.number);
          this.#fenceSnapshot(snapshot);
          this.#sequences.observe(snapshotEvents(snapshot));
          const settledObjective = this.#deriveObjective(snapshot);
          await this.#reconcileObjectiveCapacity(settledObjective.number, settledObjective.items);
          for (const item of settledObjective.items) {
            if (
              !activeExecutions.has(item.number) &&
              (await this.#needsDurableAttemptRecovery(item, durableProviderGates, true))
            )
              await this.#reconcileInterruptedForEarlyTerminal(
                item,
                settledObjective.items,
                interruptedTerminal,
              );
          }
          snapshot = await this.#reader.readObjective(snapshot.number);
          this.#fenceSnapshot(snapshot);
          this.#sequences.observe(snapshotEvents(snapshot));
          let remaining = false;
          for (const item of this.#deriveObjective(snapshot).items) {
            if (
              !activeExecutions.has(item.number) &&
              (await this.#needsDurableAttemptRecovery(item, durableProviderGates, true))
            ) {
              remaining = true;
              break;
            }
          }
          if (remaining) throw new ProviderQuotaDrainIncompleteError();
        }
        if (this.#options.signal?.aborted && this.#options.shutdownBehavior === "release-lease")
          return await releaseAfterDrain();
        if (cancellationReason || this.#options.signal?.aborted)
          return await terminalAfterDrain(
            "FactoryRunCancelled",
            cancellationReason ?? "operator cancelled run",
          );
        if (deadlineExpired) return await finishExpired();
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
        // All resumed peers seed their durable execution/validation liabilities
        // before any member of the starting cohort may acquire fresh capacity.
        await this.#reconcileObjectiveCapacity(objective.number, objective.items);
        this.#fairness.markReconciled(objective.number);
        if (!this.#fairness.reconciled && !durableProviderGate) {
          await this.#fairness.waitForChange(
            this.#options.pollIntervalMs ?? 60_000,
            this.#options.signal,
          );
          continue;
        }
        activeExecutions.throwNextFailure();
        if (this.#options.signal?.aborted) continue;
        const gatedRecoverable: DerivedWorkItem[] = [];
        for (const item of objective.items) {
          if (
            activeExecutions.has(item.number) ||
            !durableProviderGates.some(
              (gate) => gate.workItem === item.number && gate.attempt !== undefined,
            )
          )
            continue;
          if (await this.#needsDurableAttemptRecovery(item, durableProviderGates))
            gatedRecoverable.push(item);
        }
        if (gatedRecoverable.length > 0) {
          for (const item of gatedRecoverable)
            await this.#recoverInterrupted(item, deadline, objective.items);
          continue;
        }
        const adoptedPublication =
          this.#recoveryRuntime &&
          objective.items.find((item) => {
            const planned = this.#recoveryRuntime!.planRecord.plan.items.find(
              (entry) => entry.workItem === item.number,
            );
            if (
              !planned?.source ||
              planned.action === "execute" ||
              planned.action === "reconcile" ||
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
        let deferredIntegration = false;
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
            if (await this.#resumeIntegration(unrecorded)) continue;
            deferredIntegration = true;
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
          if (progressed) continue;
          deferredIntegration = true;
        }
        if (!deferredIntegration && allDone(objective)) {
          await activeExecutions.waitForIdle();
          activeExecutions.throwNextFailure();
          snapshot = await this.#reader.readObjective(snapshot.number);
          this.#fenceSnapshot(snapshot);
          this.#sequences.observe(snapshotEvents(snapshot));
          if (this.#recoveryRuntime) await this.#resumeObservedRun(snapshot, runManager);
          if (!allDone(this.#deriveObjective(snapshot))) continue;
          await this.#lease.assert();
          await this.#store.closeIssue(snapshot.number);
          return await terminalAfterDrain("FactoryRunCompleted");
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
            (item) =>
              item.state === "failed" &&
              !activeExecutions.has(item.number) &&
              item.attempts >= this.#policy.maxAttemptsPerItem &&
              !durableProviderGates.some(
                (gate) => gate.workItem === item.number && gate.attempt !== undefined,
              ) &&
              !this.#hasRecoverablePostSuccessCancellation(item),
          );
          if (exhausted) {
            return await escalateAfterDrain(
              exhausted,
              `attempt budget exhausted (${exhausted.attempts})`,
            );
          }
        }

        activeExecutions.throwNextFailure();
        if (this.#options.signal?.aborted) continue;
        const recoverable: DerivedWorkItem[] = [];
        for (const item of objective.items) {
          if (activeExecutions.has(item.number)) continue;
          if (await this.#needsDurableAttemptRecovery(item, durableProviderGates))
            recoverable.push(item);
        }
        if (recoverable.length > 0) {
          for (const item of recoverable) {
            activeExecutions.throwNextFailure();
            if (this.#options.signal?.aborted) continue runLoop;
            const planned = this.#plannedRecoveryItem(item.number);
            if (planned?.action === "reconcile" && planned.source?.artifactDigest)
              await this.#recoverAdoptedRetainedArtifact(item, deadline);
            else await this.#recoverInterrupted(item, deadline, objective.items);
          }
          continue;
        }
        if (this.#options.signal?.aborted) continue;
        if (durableProviderGate?.kind === "provider") {
          return await terminalAfterDrain(
            "FactoryRunEscalated",
            durableProviderGateState?.accounting === "unknown"
              ? `${durableProviderGate.providerMessage}; model usage remains unknown, so this run cannot currently be recovered`
              : `${durableProviderGate.providerMessage}; restore provider quota${durableProviderGate.actionUrl ? ` at ${durableProviderGate.actionUrl}` : ""} before explicit recovery`,
          );
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
            // Settlement removes the active key before enqueueing its result.
            // Claim that edge before acknowledging an operational stop.
            activeExecutions.throwNextFailure();
            if (!commandState.admissionGate) {
              throw new Error("paused run has no durable admission-gate command");
            }
            await this.#acknowledgeOperationalGate(snapshot, commandState.admissionGate);
            if (commandState.draining) {
              return await releaseCommandAfterDrain();
            }
            await sleep(this.#options.pollIntervalMs ?? 60_000, this.#options.signal);
          } else {
            const settled = await activeExecutions.waitForChange(
              this.#options.pollIntervalMs ?? 2_000,
              this.#options.signal,
            );
            if (settled?.error) throw new ClaimedExecutionFailure(settled);
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
                const providers =
                  this.#compiledGraph?.workItems
                    .find((candidate) => candidate.id === itemId)
                    ?.repositoryCapabilities?.requires.filter(
                      (requirement) => requirement.activation === "integrated-base",
                    )
                    .map((requirement) => requirement.providerWorkItem) ?? [];
                if (
                  providers.length > 0 &&
                  !providers.every((provider) => {
                    const state = objective.items.find(
                      (candidate) => parseGraphItemMetadata(candidate.body ?? "").id === provider,
                    )?.state;
                    return state === "done";
                  })
                ) {
                  const compiled = this.#compiledGraph?.workItems.find(
                    (candidate) => candidate.id === itemId,
                  );
                  const pending = [...(compiled?.dependsOn ?? [])];
                  const seen = new Set<string>();
                  while (pending.length) {
                    const dependency = pending.pop()!;
                    if (providers.includes(dependency)) return false;
                    if (seen.has(dependency)) continue;
                    seen.add(dependency);
                    pending.push(
                      ...(this.#compiledGraph?.workItems.find(
                        (candidate) => candidate.id === dependency,
                      )?.dependsOn ?? []),
                    );
                  }
                }
                const parent = objective.items.find(
                  (candidate) =>
                    parseGraphItemMetadata(candidate.body ?? "").id === plan.parentItemId,
                );
                if (!parent || parent.state !== "for_review" || activeExecutions.has(parent.number))
                  return false;
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
        const capacity = await this.#reconcileObjectiveCapacity(objective.number, objective.items);
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
        resource = await this.#resourceSampler.sample(nowMs).catch((error) => {
          this.#notify(
            `local resource sampling failed closed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
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
        const executionBaseProofs = new Map<
          string,
          Promise<{ executionRequiresIsolation: boolean }>
        >();
        const repositoryCapabilityProofs = new Map<number, RepositoryCapabilityProof[]>();
        const activatedPackets = new Map<number, WorkerPacket>();
        const managedRuntimeActivations = new Map<number, ManagedRuntimeActivation>();
        const executionHead = runnable.length
          ? await this.#store.getBranchHead(this.#baseBranch)
          : null;
        const admissionItems: AdmissionWorkItem[] = await Promise.all(
          ranked.map(async (priority) => {
            const original = this.#packetFor(priority.item.number);
            const stackBase = deliveryBases.get(priority.item.number);
            if (stackBase) {
              const itemId = parseGraphItemMetadata(priority.item.body ?? "").id;
              const unit = this.#deliveryPlan?.units.find((candidate) =>
                candidate.items.includes(itemId),
              );
              const root = objective.items.find(
                (candidate) => parseGraphItemMetadata(candidate.body ?? "").id === unit?.items[0],
              );
              if (!root) throw new Error("stack execution lacks its immutable root provenance");
              const publication = (root.factoryEvents ?? []).find(
                (event) =>
                  event.kind === "publication" &&
                  event.runId === this.#run.runId &&
                  event.event === "PublicationRecorded",
              );
              const adopted = this.#recoveryRuntime?.sourcePublications.find(
                (proof) => proof.publication.workItem === root.number,
              );
              const recoveryRoot = this.#recoveryRuntime?.planRecord.plan.items.find(
                (entry) => entry.workItem === root.number,
              );
              const originalSource = recoveryRoot?.source?.publication;
              const rootBase =
                publication?.kind === "publication"
                  ? publication.baseSha
                  : (adopted?.publication.sourceBaseSha ?? originalSource?.baseSha);
              if (!rootBase) throw new Error("stack execution root has no exact published base");
              const authorityBase = this.#run.baseSha ?? this.#packetFor(root.number).baseSha;
              const integratedRoot =
                recoveryRoot?.action === "integrated" &&
                this.#recoveryRuntime?.planRecord.plan.expectedBaseSha === authorityBase
                  ? this.#recoveryRuntime?.sourceIntegrations.find(
                      (proof) => proof.outcome.workItem === root.number,
                    )
                  : undefined;
              // An authenticated pre-activation root is already contained in the
              // recovery plan's exact base. Its older publication base is source
              // provenance, not a forward trunk advance by the successor.
              const comparisonBase = integratedRoot ? authorityBase : rootBase;
              // The actual parent head contains every native ancestor, not just
              // the root. Neither a trusted child nor successor policy may
              // declassify an intermediate retained producer's restrictions.
              let inheritedIsolation = false;
              let ancestorId = this.#deliveryPlan?.items.find(
                (candidate) => candidate.itemId === itemId,
              )?.parentItemId;
              const ancestors = new Set<string>();
              while (ancestorId) {
                if (!unit || ancestors.has(ancestorId) || !unit.items.includes(ancestorId))
                  throw new Error("stack execution has invalid ancestor provenance");
                ancestors.add(ancestorId);
                const ancestor = objective.items.find(
                  (candidate) => parseGraphItemMetadata(candidate.body ?? "").id === ancestorId,
                );
                if (!ancestor) throw new Error("stack execution lacks an immutable ancestor");
                inheritedIsolation ||=
                  this.#packetFor(ancestor.number).requirements.trust !== "trusted_local";
                const retained = this.#recoveryRuntime?.planRecord.plan.items.find(
                  (entry) => entry.workItem === ancestor.number,
                );
                if (this.#recoveryRuntime && !retained)
                  throw new Error("stack execution ancestor is outside the recovery plan");
                if (retained && retained.action !== "execute") {
                  if (!retained.source)
                    throw new Error("stack execution ancestor lacks its source run");
                  // Always resolve provenance, even if another ancestor has
                  // already required isolation: missing authority must refuse.
                  const producerRunIds = new Set([
                    retained.source.runId,
                    ...(retained.source.priorDelivery ? [retained.source.priorDelivery.runId] : []),
                    ...(retained.source.siblingRefresh
                      ? [retained.source.siblingRefresh.candidateRunId]
                      : []),
                  ]);
                  for (const sourceRunId of producerRunIds) {
                    const sourceIsolation = nativeSourceRequiresIsolation(
                      sourceRunId,
                      this.#recoveryRuntime!.events,
                    );
                    inheritedIsolation ||= sourceIsolation;
                  }
                }
                const ancestorPlan = this.#deliveryPlan?.items.find(
                  (candidate) => candidate.itemId === ancestorId,
                );
                if (!ancestorPlan)
                  throw new Error("stack execution ancestor lacks its delivery plan");
                ancestorId = ancestorPlan.parentItemId;
              }
              if (!unit || !ancestors.has(unit.items[0]!))
                throw new Error("stack execution ancestry does not reach its immutable root");
              const key = `${authorityBase}:${comparisonBase}`;
              if (!executionBaseProofs.has(key))
                executionBaseProofs.set(
                  key,
                  authorityBase === comparisonBase
                    ? Promise.resolve({ executionRequiresIsolation: false })
                    : this.#assertOwnTrunkAdvance(authorityBase, comparisonBase, 0),
                );
              stackBase.requiresIsolation =
                inheritedIsolation ||
                this.#packetFor(root.number).requirements.trust !== "trusted_local" ||
                (await executionBaseProofs.get(key)!).executionRequiresIsolation;
            }
            if (!deliveryBases.has(priority.item.number)) {
              if (!executionHead) throw new Error("missing pinned execution head");
              const authorityBase = this.#run.baseSha ?? original.baseSha;
              const key = `${authorityBase}:${executionHead.oid}`;
              if (!executionBaseProofs.has(key))
                executionBaseProofs.set(
                  key,
                  executionHead.oid === authorityBase
                    ? Promise.resolve({ executionRequiresIsolation: false })
                    : this.#assertOwnTrunkAdvance(authorityBase, executionHead.oid, 0),
                );
              const proof = await executionBaseProofs.get(key)!;
              deliveryBases.set(priority.item.number, {
                branch: this.#baseBranch,
                sha: executionHead.oid,
                kind: "trunk",
                requiresIsolation: proof.executionRequiresIsolation,
              });
            }
            const executionBase = await this.#store.readCommit(
              deliveryBases.get(priority.item.number)!.sha,
            );
            const graphPacket = parseWorkerPacket({
              ...original,
              baseSha: executionBase.oid,
              ...(retryContext(priority.item, this.#run.runId)
                ? { retryContext: retryContext(priority.item, this.#run.runId) }
                : {}),
              requirements: {
                ...original.requirements,
                ...((this.#policy.trust === "sandbox_untrusted" ||
                  deliveryBases.get(priority.item.number)?.requiresIsolation) &&
                original.requirements.trust === "trusted_local"
                  ? { trust: "isolated" as const }
                  : {}),
              },
            });
            let packet = graphPacket;
            let capabilityBlocker: string | undefined;
            try {
              const capabilitySourceRef = `refs/heads/${deliveryBases.get(priority.item.number)!.branch}`;
              const providerIdentities = await this.#capabilityProviderIdentities(
                graphPacket,
                objective.items,
                executionBase.oid,
              );
              packet = await activateManagedRuntimePacket(graphPacket, (id) =>
                providerIdentities.get(id),
              );
              const proofs = await this.#resolveExecutionBaseCapabilities(
                priority.item,
                packet,
                executionBase,
                capabilitySourceRef,
                objective.items,
                providerIdentities,
              );
              repositoryCapabilityProofs.set(priority.item.number, proofs);
              activatedPackets.set(priority.item.number, packet);
              const activation = createManagedRuntimeActivation({
                packet,
                baseSha: executionBase.oid,
                sourceRef: capabilitySourceRef,
                proofDigests: proofs.map(({ digest }) => digest),
              });
              if (activation) managedRuntimeActivations.set(priority.item.number, activation);
            } catch (error) {
              capabilityBlocker =
                error instanceof Error ? error.message : `repository capability refusal: ${error}`;
            }
            const timeoutMs = Math.min(
              (packet.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000,
              Math.max(1, deadline - nowMs),
            );
            const issueAdmission = await this.#attempts.ledger.read(priority.item.number);
            const nextAttempt =
              Math.max(
                issueAdmission?.history.at(-1)?.reservation.attempt ?? 0,
                (priority.item.factoryEvents ?? []).reduce(
                  (highest, event) =>
                    event.kind === "attempt" ? Math.max(highest, event.attempt) : highest,
                  0,
                ),
              ) + 1;
            const queued = queuedState(priority.item, this.#run.runId);
            const backends = applyCloudPause(
              await this.#registry.evaluate({
                policy: this.#policy,
                requirements: packet.requirements,
                requiresManagedToolchain: Boolean(packet.managedRuntimes?.length),
                nowMs,
              }),
              commandState.cloudPaused,
            );
            if (capabilityBlocker)
              for (const candidate of backends) candidate.permanentReasons.push(capabilityBlocker);
            const mayChangeExecutionAuthority = packet.allowedPaths.some(
              (path) => executionAffectingReason(path) !== null,
            );
            if (mayChangeExecutionAuthority)
              for (const candidate of backends)
                if (candidate.capabilities?.providerManagedPublication)
                  candidate.permanentReasons.push(
                    "execution-authority artifacts require host-owned pre-publication inspection before any feature ref or pull request exists",
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
              ...(queued
                ? {
                    queuedSince: queued.since,
                    previousQueueObservation: {
                      code:
                        queued.latest.reasonCode ?? queuedReasonCode(queued.latest.reason) ?? null,
                      ...(queued.latest.gate ? { gate: queued.latest.gate } : {}),
                    },
                  }
                : {}),
            };
          }),
        );
        const physicalLimits = admissionCapacityLimits(
          this.#policy,
          resource,
          objective.number,
          scheduling.capacity.local.maxWorkers,
          this.#controllerLimits,
        );
        const localObservationReady = Boolean(
          resource &&
            resourcePressureReasons(resource, scheduling.capacity.local).length === 0 &&
            nowMs >= this.#resourceSampler.cooldownUntil,
        );
        const localDemand = !localObservationReady
          ? []
          : admissionItems.filter(
              (item) =>
                item.backends.some(
                  (candidate) =>
                    candidate.local &&
                    candidate.permanentReasons.length === 0 &&
                    candidate.transientReasons.length === 0,
                ) &&
                (item.requirements.cpu ?? scheduling.capacity.local.defaultCpu) <=
                  physicalLimits.cpuCapacity &&
                (item.requirements.memoryMb ?? scheduling.capacity.local.defaultMemoryMb) <=
                  physicalLimits.memoryCapacityMb,
            );
        this.#fairness.reportDemand(
          objective.number,
          localDemand.length,
          localDemand.map((item) => ({
            cpu: item.requirements.cpu ?? scheduling.capacity.local.defaultCpu,
            memoryMb: item.requirements.memoryMb ?? scheduling.capacity.local.defaultMemoryMb,
            cpuCapacity: physicalLimits.cpuCapacity,
            memoryCapacityMb: physicalLimits.memoryCapacityMb,
            paths: item.paths,
            exclusiveResources: item.exclusiveResources,
          })),
        );
        const objectiveLocalMax = this.#fairness.mayAdmit(objective.number, capacity.reservations)
          ? this.#fairness.localMaximum(
              objective.number,
              // Fairness shares the repository pool, not this Objective's
              // immutable ceiling. admissionCapacityLimits applies that separate
              // ceiling after subtracting other Objectives' occupied slots.
              this.#controllerLimits.maxLocalWorkers,
              capacity.reservations,
            )
          : capacity.reservations.filter(
              (reservation) => reservation.objective === objective.number && reservation.local,
            ).length;
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
        const newQueueReceipts = plan.queued.filter(
          (decision) => decision.recordQueueStart || decision.recordQueueReasonChange,
        );
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
        if (permanent && safeAdmissions.length === 0 && activeExecutions.size === 0) {
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
          if (
            admission.reservation.local &&
            !this.#fairness.mayAdmit(
              objective.number,
              (await this.#capacitySnapshot()).reservations,
            )
          )
            break;
          const item = objective.items.find(
            (candidate) => candidate.number === admission.workItem,
          )!;
          activeExecutions.throwNextFailure();
          this.#options.signal?.throwIfAborted();
          const committed = await this.#reserveCapacity(
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
          if (admission.reservation.local) this.#fairness.noteAdmission(objective.number);
          started.push(item.number);
          let executionCapacityReleased = false;
          const releaseExecutionCapacity = async (alreadyReleased = false) => {
            if (executionCapacityReleased) return;
            if (alreadyReleased) {
              executionCapacityReleased = true;
              return;
            }
            await this.#releaseCapacity(admission.reservation.key);
            executionCapacityReleased = true;
          };
          activeExecutions.start(item.number, async () => {
            try {
              await this.#execute(
                item,
                deadline,
                admission,
                releaseExecutionCapacity,
                deliveryBases.get(item.number),
                executionAbort.signal,
                repositoryCapabilityProofs.get(item.number) ?? [],
                activatedPackets.get(item.number),
                managedRuntimeActivations.get(item.number),
              );
            } finally {
              await releaseExecutionCapacity();
            }
          });
        }
        if (started.length > 0) {
          this.#notify(`admitted: ${started.map((number) => `#${number}`).join(", ")}`);
        }
        if (capacityChanged) continue;
        await this.#waitForProgress(
          activeExecutions,
          executionRevision,
          fairnessRevision,
          deadline,
        );
      }
    } catch (error) {
      const claimed = error instanceof ClaimedExecutionFailure ? error : undefined;
      const failure = claimed?.settlement.error ?? error;
      if (failure instanceof CompilerDraftReportCompleted)
        return await terminalAfterDrain("FactoryRunCompleted", failure.message);
      if (terminalVeto(failure)) {
        executionAbort.abort();
        await activeExecutions.settle();
        throw failure;
      }
      if (
        this.#options.signal?.aborted &&
        this.#options.shutdownBehavior === "release-lease" &&
        (!claimed || failure instanceof RunCancellationRequestedError)
      ) {
        return await releaseAfterDrain();
      }
      if (
        failure instanceof RunCancellationRequestedError ||
        (!claimed && this.#options.signal?.aborted)
      ) {
        return await terminalAfterDrain(
          "FactoryRunCancelled",
          failure instanceof RunCancellationRequestedError
            ? failure.message
            : "operator cancelled run",
        );
      }
      const reason = failure instanceof Error ? failure.message : String(failure);
      return await terminalAfterDrain("FactoryRunEscalated", reason);
    } finally {
      clearInterval(heartbeat);
      this.#options.signal?.removeEventListener("abort", forwardAbort);
      const unsettled = await activeExecutions.settle();
      this.#fairness.unregister(this.#options.objective);
      // Every outcome path above claims or drains child settlements. Reaching
      // finally with anything left is an internal lifecycle bug, not another
      // timing-dependent outcome arbiter.
      if (unsettled.length > 0)
        // biome-ignore lint/correctness/noUnsafeFinally: classified exits drain the pool; a leftover settlement proves the lifecycle invariant itself failed
        throw new Error("execution pool exited without classified settlement drain");
    }
  }

  async #execute(
    item: DerivedWorkItem,
    objectiveDeadline: number,
    admission: AdmissionProposal,
    releaseExecutionCapacity: (alreadyReleased?: boolean) => Promise<void>,
    deliveryBase?: DeliveryExecutionBase,
    executionSignal?: AbortSignal,
    repositoryCapabilityProofs: readonly RepositoryCapabilityProof[] = [],
    activatedPacket?: WorkerPacket,
    managedRuntimeActivation?: ManagedRuntimeActivation,
    recovered?: CollectedAttemptContinuation,
  ): Promise<void> {
    const execute = () =>
      withArtifactContentScope(() =>
        this.#executeWithArtifactContent(
          item,
          objectiveDeadline,
          admission,
          releaseExecutionCapacity,
          deliveryBase,
          executionSignal,
          repositoryCapabilityProofs,
          activatedPacket,
          managedRuntimeActivation,
          recovered,
        ),
      );
    return recovered ? execute() : this.#modelInvocations.run(execute);
  }

  async #executeWithArtifactContent(
    item: DerivedWorkItem,
    objectiveDeadline: number,
    admission: AdmissionProposal,
    releaseExecutionCapacity: (alreadyReleased?: boolean) => Promise<void>,
    deliveryBase?: DeliveryExecutionBase,
    executionSignal?: AbortSignal,
    repositoryCapabilityProofs: readonly RepositoryCapabilityProof[] = [],
    activatedPacket?: WorkerPacket,
    managedRuntimeActivation?: ManagedRuntimeActivation,
    recovered?: CollectedAttemptContinuation,
  ): Promise<void> {
    if (
      this.#recoveryRuntime &&
      !recovered?.adoptedSource &&
      !this.#recoveryRuntime.planRecord.plan.items.some(
        (planned) => planned.workItem === item.number && planned.action === "execute",
      )
    )
      throw new Error("successor execution is not authorized for a retained source");
    let reservation: AttemptReservation | undefined = recovered?.reservation;
    let worker: LocalWorktree | undefined = recovered?.worker;
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
    let validationCapacityReleased = false;
    let retryableArtifact: NormalizedArtifact | undefined;
    let retainCollectedSource = false;
    let executionCleanupConfirmed = Boolean(recovered);
    let completedArtifactRetained = Boolean(recovered);
    let safeHoldShutdown = false;
    let admissionPipelineClosed = false;
    let backendLaunchAttempted = false;
    let executionTerminalObserved = Boolean(recovered);
    let terminalModelTokens: number | undefined;
    let terminalModelUsage: ReportedModelUsage | undefined;
    let terminalModelProfile: string | undefined;
    let retainedUnknownModelInvocationId: string | undefined;
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
            ...(reservation.localScopeBatch
              ? { localScopeBatch: reservation.localScopeBatch }
              : {}),
            policyDigest: reservation.policyDigest,
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
      const originalPacket = recovered?.packet ?? this.#packetFor(item.number);
      const base = recovered
        ? await this.#store.readCommit(recovered.reservation.baseSha)
        : deliveryBase
          ? await this.#store.readCommit(deliveryBase.sha)
          : await this.#store.readCommit(originalPacket.baseSha);
      const publicationBaseBranch = deliveryBase?.branch ?? this.#baseBranch;
      if (deliveryBase && deliveryBase.kind !== "trunk") {
        const current = await this.#store.readRef(`refs/heads/${deliveryBase.branch}`);
        if (current !== deliveryBase.sha) {
          throw new Error("stack parent branch changed before child admission");
        }
      }
      const graphPacket =
        recovered?.packet ??
        parseWorkerPacket({
          ...originalPacket,
          baseSha: base.oid,
          ...(retryContext(item, this.#run.runId)
            ? { retryContext: retryContext(item, this.#run.runId) }
            : {}),
          requirements: {
            ...originalPacket.requirements,
            ...((this.#policy.trust === "sandbox_untrusted" || deliveryBase?.requiresIsolation) &&
            originalPacket.requirements.trust === "trusted_local"
              ? { trust: "isolated" as const }
              : {}),
          },
        });
      const packet = packetWithManagedRuntimeActivation(
        graphPacket,
        recovered ? reservation?.managedRuntimeActivation : managedRuntimeActivation,
      );
      if (activatedPacket && workerPacketDigest(packet) !== workerPacketDigest(activatedPacket))
        throw new Error("managed runtime packet changed after admission planning");
      assertRequirementsWithinPolicy(
        packet.requirements,
        this.#policy,
        `Work Item #${item.number}`,
      );
      await ensureLocalCommit(this.#options.repository, base.oid);
      const capabilitySourceRef = `refs/heads/${publicationBaseBranch}`;
      let currentRepositoryCapabilityProofs = [...repositoryCapabilityProofs];
      let currentProviderIdentities = new Map<string, CapabilityProviderIdentity>();
      if ((packet.repositoryCapabilities?.requires.length ?? 0) > 0) {
        const currentSnapshot = await this.#reader.readObjective(this.#run.objective);
        this.#fenceSnapshot(currentSnapshot);
        const currentObjective = this.#deriveObjective(currentSnapshot);
        const currentItem = currentObjective.items.find((candidate) => candidate.id === item.id);
        if (!currentItem || currentItem.number !== item.number)
          throw new Error("repository capability consumer identity changed before admission");
        currentProviderIdentities = await this.#capabilityProviderIdentities(
          packet,
          currentObjective.items,
          base.oid,
        );
        if (!recovered) {
          const refreshed = await this.#resolveExecutionBaseCapabilities(
            currentItem,
            packet,
            base,
            capabilitySourceRef,
            currentObjective.items,
            currentProviderIdentities,
          );
          const plannedDigests = currentRepositoryCapabilityProofs
            .map((proof) => proof.digest)
            .sort();
          const refreshedDigests = refreshed.map((proof) => proof.digest).sort();
          if (JSON.stringify(plannedDigests) !== JSON.stringify(refreshedDigests))
            throw new Error("repository capability proof changed before admission");
          currentRepositoryCapabilityProofs = refreshed;
        }
      }
      await assertRepositoryCapabilityProofsCurrent({
        proofs: currentRepositoryCapabilityProofs,
        base,
        sourceRef: capabilitySourceRef,
        packet,
        providerById: (id) => currentProviderIdentities.get(id),
      });
      await assertManagedRuntimeActivationCurrent({
        packet,
        activation: recovered ? reservation?.managedRuntimeActivation : managedRuntimeActivation,
        baseSha: base.oid,
        sourceRef: capabilitySourceRef,
        proofDigests: currentRepositoryCapabilityProofs.map(({ digest }) => digest),
      });
      const timeoutMs = Math.min(
        (packet.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000,
        Math.max(1, objectiveDeadline - Date.now()),
      );
      const attemptDeadline = new Date(Date.now() + timeoutMs);
      noHandleReplacementNotBefore = new Date(attemptDeadline.getTime() + 60_000).toISOString();
      if (!recovered) {
        await this.#lease.use(async (lease) => {
          const reassignmentAuthorityReceiptOid = await this.#reconcileIssueAdmissionHistory(
            item,
            lease,
            base,
          );
          const prior = (await this.#attempts.list(this.#run.objective, item.number)).filter(
            (attempt) =>
              (this.#recoveryRuntime?.accountingRunIds ?? [this.#run.runId]).includes(
                attempt.runId,
              ),
          );
          const deferred = new Set(
            (item.factoryEvents ?? []).flatMap((event) =>
              event.kind === "attempt" &&
              (this.#recoveryRuntime?.accountingRunIds ?? [this.#run.runId]).includes(
                event.runId,
              ) &&
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
          assertModelInvocationAdmission(
            this.#budgetEvents,
            this.#policy,
            this.#modelInvocations.active,
          );
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
          // The issue ledger CAS admits work after the local backend/capacity plan.
          // Capture the Objective generation immediately before that transition.
          await this.#leases.assertGeneration(lease, "admission");
          if ((packet.repositoryCapabilities?.requires.length ?? 0) > 0) {
            if ((await this.#store.readRef(capabilitySourceRef)) !== base.oid)
              throw new Error("repository capability source ref changed before reservation");
            await assertRepositoryCapabilityProofsCurrent({
              proofs: currentRepositoryCapabilityProofs,
              base,
              sourceRef: capabilitySourceRef,
              packet,
              providerById: (id) => currentProviderIdentities.get(id),
            });
          }
          await assertManagedRuntimeActivationCurrent({
            packet,
            activation: managedRuntimeActivation,
            baseSha: base.oid,
            sourceRef: capabilitySourceRef,
            proofDigests: currentRepositoryCapabilityProofs.map(({ digest }) => digest),
          });
          reservation = await this.#attempts.reserve({
            ...(reassignmentAuthorityReceiptOid ? { reassignmentAuthorityReceiptOid } : {}),
            lease,
            workItem: item.number,
            workItemNodeId: item.id,
            backend: selected.capabilities.id,
            base,
            sequence: this.#sequences.take(),
            binding: async (attempt) => {
              if (attempt !== admission.reservation.attempt)
                throw new Error(
                  "issue admission advanced after the capacity plan; reread before retry",
                );
              const projection = this.#compiledProjection;
              if (
                !projection ||
                !projection.bindings.some(
                  (binding) =>
                    binding.issueNodeId === item.id && binding.issueNumber === item.number,
                )
              )
                throw new Error("issue admission requires its immutable graph projection");
              const commit = await this.#store.readCommit(projection.commitOid);
              if (commit.parentOids.length !== 1)
                throw new Error("invalid graph projection ancestry");
              return {
                graphDigest: projection.graphDigest,
                graphCommitOid: commit.parentOids[0]!,
                projectionCommitOid: projection.commitOid,
                capacityReservationId: admission.reservation.key,
                budgetReservationId: `${this.#run.runId}:${item.number}:${attempt}:execution:${budgetUnit}:default`,
                resourceIdentity: JSON.stringify([
                  this.#run.objective,
                  this.#run.runId,
                  item.number,
                  attempt,
                  selected!.capabilities.id,
                  lease.epoch,
                  lease.policyDigest,
                  managedRuntimeActivation?.digest ?? null,
                ]),
                ...(managedRuntimeActivation ? { managedRuntimeActivation } : {}),
              };
            },
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
              ...(admission.priority.fieldId
                ? { priorityFieldId: admission.priority.fieldId }
                : {}),
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
      } else {
        selected = this.#registry.get(recovered.reservation.backend) ?? undefined;
        terminalModelUsage = recovered.modelUsage;
        terminalModelTokens =
          recovered.modelTokens ??
          (recovered.modelUsage
            ? recovered.modelUsage.inputTokens + recovered.modelUsage.outputTokens
            : undefined);
        budgetUnit = recovered.nativeUsage.unit;
        executionBudgetReconciled = true;
        if (admission.validation) {
          validator = this.#registry.get(admission.validation.backendId) ?? undefined;
          if (!validator?.validate || !validator.probeValidation)
            throw new Error("recovered artifact validator is no longer available");
          if (admission.validation.reservedBudget.unit !== "none") {
            validationBudgetUnit = admission.validation.reservedBudget.unit;
            validationBudgetReserved = true;
          }
          // Source preparation is not replacement implementation. The exact
          // original artifact is validated in its required independent boundary.
          worker ??= await createLocalWorktree(this.#options.repository, base.oid);
        }
        terminalModelProfile =
          resolveModelSelection(this.#policy, reservation!.attempt === 1 ? "implement" : "recover")
            ?.profile ?? this.#policy.modelProfile;
      }
      if (!selected || !reservation) throw new Error("backend reservation did not complete");
      if (!recovered) {
        const retryCheckpoint = selected.capabilities.providerManagedPublication
          ? undefined
          : await this.#retryArtifacts.get(item.number, base.oid);
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
        const sessionJournal =
          selected.capabilities.id === "codex-app-server/local-worktree"
            ? await this.#sessionJournal(reservation)
            : undefined;
        handle = await this.#externalAdmission(async () => {
          if ((await this.#store.readRef(capabilitySourceRef)) !== base.oid)
            throw new ExecutionSourceAdvancedBeforeDispatchError(
              "execution source ref changed after attempt reservation",
            );
          const dispatchSnapshot = await this.#reader.readObjective(this.#run.objective);
          this.#fenceSnapshot(dispatchSnapshot);
          const dispatchObjective = this.#deriveObjective(dispatchSnapshot);
          const dispatchItem = dispatchObjective.items.find(
            (candidate) => candidate.id === item.id && candidate.number === item.number,
          );
          if (!dispatchItem)
            throw new Error("repository capability consumer changed after attempt reservation");
          const dispatchProviderIdentities = await this.#capabilityProviderIdentities(
            packet,
            dispatchObjective.items,
            base.oid,
          );
          const dispatchProofs = await this.#resolveExecutionBaseCapabilities(
            dispatchItem,
            packet,
            base,
            capabilitySourceRef,
            dispatchObjective.items,
            dispatchProviderIdentities,
          );
          if (
            JSON.stringify(dispatchProofs.map(({ digest }) => digest).sort()) !==
            JSON.stringify(currentRepositoryCapabilityProofs.map(({ digest }) => digest).sort())
          )
            throw new Error("repository capability proof changed after attempt reservation");
          await assertRepositoryCapabilityProofsCurrent({
            proofs: dispatchProofs,
            base,
            sourceRef: capabilitySourceRef,
            packet,
            providerById: (id) => dispatchProviderIdentities.get(id),
          });
          await assertManagedRuntimeActivationCurrent({
            packet,
            activation: reservation!.managedRuntimeActivation,
            baseSha: base.oid,
            sourceRef: capabilitySourceRef,
            proofDigests: dispatchProofs.map(({ digest }) => digest),
          });
          if ((await this.#store.readRef(capabilitySourceRef)) !== base.oid)
            throw new ExecutionSourceAdvancedBeforeDispatchError(
              "execution source ref changed during final dispatch validation",
            );
          assertSupportedModelTokenBudgetIntent(this.#policy);
          if (selected!.capabilities.reportsModelUsage)
            await this.#admitModelInvocation(
              `worker-${item.number}-${reservation!.attempt}`,
              item.id,
              reservation!,
              undefined,
              "execution",
            );
          else
            assertModelInvocationAdmission(
              this.#budgetEvents,
              this.#policy,
              this.#modelInvocations.active,
            );
          await this.#lease.use((lease) => this.#attempts.markDispatching(lease, reservation!));
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
            ...(sessionJournal ? { sessionJournal } : {}),
            policyNetworkDestinations: this.#policy.allowedNetworkDestinations,
            providerBaseRef: publicationBaseBranch,
            deadline: attemptDeadline,
            ...(selected!.capabilities.reportsModelUsage
              ? {
                  checkpointProviderRefusal: async (error: ProviderQuotaError) => {
                    const invocationId = `worker-${item.number}-${reservation!.attempt}`;
                    const invocationKey = modelInvocationKey({
                      objective: reservation!.objective,
                      runId: reservation!.runId,
                      workItem: item.number,
                      attempt: reservation!.attempt,
                      phase: "execution",
                      modelInvocationId: invocationId,
                    });
                    error.bindInvocation(invocationId);
                    if (!error.usage && this.#modelInvocations.active.has(invocationKey))
                      this.#modelInvocations.retire(invocationKey);
                    await this.#recordProviderQuotaGate(
                      error,
                      item.id,
                      "execution",
                      selected!.capabilities.id,
                      reservation!,
                    );
                  },
                }
              : {}),
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
            ...(recovered ? { allowRecovery: true } : {}),
            lease,
            workItemNodeId: item.id,
            reservation: reservation!,
            event: "AttemptStarted",
            sequence: this.#sequences.take(),
            providerResourceId: handle!.resourceId,
            ...(handle!.metadata?.sourceArchiveDigest
              ? { sourceArchiveDigest: handle!.metadata.sourceArchiveDigest }
              : {}),
            ...(handle!.metadata?.sourceArchiveBytes === undefined
              ? {}
              : { sourceArchiveBytes: Number(handle!.metadata.sourceArchiveBytes) }),
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
          let observation: BackendObservation;
          try {
            observation = await selected.observe(handle);
          } catch (error) {
            if (!(error instanceof ProviderQuotaError)) throw error;
            if (!selected.capabilities.reportsModelUsage)
              throw new Error(
                `backend ${selected.capabilities.id} emitted a provider quota failure without declaring model-usage reporting`,
                { cause: error },
              );
            executionTerminalObserved = true;
            const invocationId = `worker-${item.number}-${reservation!.attempt}`;
            error.bindInvocation(invocationId);
            terminalModelUsage = reportedModelUsage(error.usage);
            terminalModelTokens = error.usage
              ? error.usage.inputTokens + error.usage.outputTokens
              : undefined;
            try {
              await this.#recordProviderQuotaGate(
                error,
                item.id,
                "execution",
                selected.capabilities.id,
                reservation!,
              );
            } catch (checkpointError) {
              throw preserveProviderQuotaError(
                error,
                checkpointError,
                "worker provider-refusal adapter and Supervisor checkpoints both failed",
              );
            }
            throw error;
          }
          if (
            selected.capabilities.id === "codex-app-server/local-worktree" &&
            observation.state === "unknown"
          )
            throw new Error(
              "App Server outcome is unknown; automated replacement is blocked pending exact session recovery",
            );
          if (["succeeded", "failed", "cancelled"].includes(observation.state)) {
            executionTerminalObserved = true;
            terminalModelUsage = reportedModelUsage(observation.usage);
            const observedTokens = reportedModelTokens(observation.usage);
            if (observation.providerQuotaGate) {
              if (!selected.capabilities.reportsModelUsage)
                throw new Error(
                  `backend ${selected.capabilities.id} emitted a provider quota gate without declaring model-usage reporting`,
                );
              if (observedTokens === null && selected.capabilities.reportsModelUsage) {
                const invocationKey = modelInvocationKey({
                  objective: reservation!.objective,
                  runId: reservation!.runId,
                  workItem: item.number,
                  attempt: reservation!.attempt,
                  phase: "execution",
                  modelInvocationId: `worker-${item.number}-${reservation!.attempt}`,
                });
                if (this.#modelInvocations.active.has(invocationKey))
                  this.#modelInvocations.retire(invocationKey);
              }
              const quotaError = new ProviderQuotaError(observation.providerQuotaGate, {
                invocationId: `worker-${item.number}-${reservation!.attempt}`,
                ...(observedTokens !== null
                  ? {
                      usage: {
                        inputTokens: observation.usage!.inputTokens!,
                        outputTokens: observation.usage!.outputTokens!,
                        ...(typeof observation.usage?.cachedInputTokens === "number"
                          ? { cachedInputTokens: observation.usage.cachedInputTokens }
                          : {}),
                      },
                    }
                  : {}),
              });
              await this.#recordProviderQuotaGate(
                quotaError,
                item.id,
                "execution",
                selected.capabilities.id,
                reservation!,
              );
              terminalModelTokens = observedTokens ?? undefined;
              throw quotaError;
            }
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
                  ...this.#modelInvocationLink(
                    `worker-${item.number}-${reservation!.attempt}`,
                    reservation!,
                    undefined,
                    "execution",
                  ),
                  ...(terminalModelUsage ? { reportedModelUsage: terminalModelUsage } : {}),
                });
                this.#budgetEvents.push(event);
              });
            } else if (selected.capabilities.reportsModelUsage) {
              this.#modelInvocations.retire(
                modelInvocationKey({
                  objective: reservation!.objective,
                  runId: reservation!.runId,
                  workItem: item.number,
                  attempt: reservation!.attempt,
                  phase: "execution",
                  modelInvocationId: `worker-${item.number}-${reservation!.attempt}`,
                }),
              );
              if (selected.capabilities.id === "codex-app-server/local-worktree")
                throw new Error(
                  "App Server final model usage is unavailable; automated replacement is blocked",
                );
              throw new Error(
                `backend ${selected.capabilities.id} omitted terminal model-token usage; consumption remains unknown`,
              );
            }
            if (observation.state !== "succeeded") {
              throw new Error(observation.reason ?? `worker ${observation.state}`);
            }
            break;
          }
          await sleep(this.#options.pollIntervalMs ?? 2_000, executionSignal);
        }
      }
      let artifact = recovered?.artifact ?? (await selected.collect(handle!));
      this.#retainArtifactContent(artifact);
      assertArtifactScope(artifact, packet.allowedPaths);
      if (!recovered && artifact.outcome === "succeeded")
        artifact = await bindArtifactManifest(this.#options.repository, artifact);
      this.#retainArtifactContent(artifact);
      retryableArtifact = artifact;
      if (artifact.outcome !== "succeeded") {
        throw new Error(artifact.reason ?? `worker ${artifact.outcome}`);
      }
      try {
        await this.#persistCollectedArtifact(
          reservation,
          packet,
          artifact,
          objectiveDeadline,
          !recovered
            ? {
                modelTokens: terminalModelTokens,
                providerResourceId: handle!.resourceId,
                turnId: handle!.metadata?.turnId,
                signal: executionSignal,
              }
            : undefined,
        );
      } catch (cause) {
        // Keep the original workspace only when no complete independent copy can
        // be verified. Complete local pending bytes or a ready ref survive cleanup.
        retainCollectedSource = !(await artifactRecoveryCopyAvailable({
          store: this.#store,
          identity: this.#artifactTransferIdentity(reservation),
          artifactDigest: artifact.digest,
        }));
        throw new ArtifactCollectionCheckpointError(cause);
      }
      if (
        !recovered ||
        !(item.factoryEvents ?? []).some(
          (event) =>
            event.kind === "attempt" &&
            event.event === "AttemptSucceeded" &&
            event.runId === reservation!.runId &&
            event.attempt === reservation!.attempt &&
            event.artifactDigest === artifact.digest,
        )
      )
        await this.#lease.use((lease) =>
          this.#attempts.record({
            ...(recovered ? { allowRecovery: true } : {}),
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
      if (recovered?.adoptedSource)
        await this.#settleArtifactConsumerAdmission(item, reservation, recovered.adoptedSource);
      await confirmExecutionCleanup("post-collection backend cleanup");
      if (!recovered)
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
      // Fresh completed siblings have the same durable continuation boundary as
      // recovered attempts: ready artifact, terminal usage, and absent compute.
      // A controller shutdown must not turn that paid work into a failed attempt.
      completedArtifactRetained =
        !selected.capabilities.providerManagedPublication &&
        executionCleanupConfirmed &&
        (Boolean(recovered) || executionBudgetReconciled);
      if (
        !recovered &&
        selected.capabilities.id === "codex-app-server/local-worktree" &&
        reservation.localScopeBatch
      ) {
        const native = this.#budgetEvents
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.runId === reservation!.runId &&
              event.workItem === reservation!.workItem &&
              event.attempt === reservation!.attempt &&
              event.phase === "execution" &&
              event.unit === "local_milliseconds",
          )
          .at(-1);
        try {
          await holdAppServerQualificationCheckpoint({
            repository: `${this.#options.owner}/${this.#options.repo}`,
            objective: this.#run.objective,
            ...(this.#run.activationRequestId
              ? { activationRequestId: this.#run.activationRequestId }
              : {}),
            runId: reservation.runId,
            workItem: reservation.workItem,
            attempt: reservation.attempt,
            directorEpoch: reservation.directorEpoch,
            policyDigest: reservation.policyDigest,
            baseSha: reservation.baseSha,
            artifactDigest: artifact.digest,
            threadId: handle!.resourceId,
            turnId: handle!.metadata?.turnId ?? "",
            modelTokens: terminalModelTokens ?? NaN,
            nativeMilliseconds: native?.kind === "budget" ? native.amount : NaN,
            batch: reservation.localScopeBatch,
            objectiveStartedAt: this.#run.startedAt,
            objectiveDeadline: new Date(
              this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
            ),
            holdDurationMs: this.#policy.workItemTimeoutMinutes * 60_000,
            ...(executionSignal ? { signal: executionSignal } : {}),
            assertCurrent: () => this.#lease.assert(),
            proveTerminal: async () => {
              const terminal = await this.#sessions.load(
                `${this.#options.owner}/${this.#options.repo}`,
                reservation!,
                "terminal",
              );
              if (
                !terminal ||
                terminal.state !== "succeeded" ||
                !completeSessionUsage(terminal.usage) ||
                terminal.turnId !== handle!.metadata?.turnId ||
                terminal.binding.threadId !== handle!.resourceId ||
                terminal.usage!.inputTokens! + terminal.usage!.outputTokens! !== terminalModelTokens
              )
                throw new Error("qualification hold lacks exact complete terminal session usage");
            },
          });
        } catch (cause) {
          if (cause instanceof SafeArtifactCheckpointHeldError) throw cause;
          throw new SafeArtifactCheckpointHeldError(cause);
        }
      }
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
        executionSignal?.throwIfAborted();
        await this.#lease.renewIfNeeded();
        if (Date.now() >= objectiveDeadline) {
          throw new Error("Objective timeout exhausted while awaiting validation capacity");
        }
        let validationResource: ResourceSnapshot | null = null;
        const effective = normalizeSchedulingPolicy(this.#policy);
        if (validationCapacity.local) {
          validationResource = await this.#resourceSampler.sample(Date.now()).catch(() => null);
          const pressure = validationResource
            ? resourcePressureReasons(validationResource, effective.capacity.local)
            : ["resource sample unavailable"];
          if (
            pressure.length > 0 ||
            this.#resourceSampler.coolingDown(Date.now()) ||
            !validationResource ||
            !localMemoryFits(
              validationResource,
              validationCapacity.memoryMb,
              effective.capacity.local.minimumFreeMemoryMb,
            )
          ) {
            if (pressure.length > 0) {
              this.#resourceSampler.notePressure(Date.now());
            }
            await sleep(this.#options.pollIntervalMs ?? 2_000, executionSignal);
            continue;
          }
        }
        const current = await this.#capacitySnapshot();
        const limits = admissionCapacityLimits(
          this.#policy,
          validationResource,
          this.#run.objective,
          this.#fairness.localMaximum(
            this.#run.objective,
            Math.min(effective.capacity.local.maxWorkers, this.#controllerLimits.maxLocalWorkers),
            current.reservations,
          ),
          this.#controllerLimits,
        );
        const transitioned = recovered
          ? await this.#reserveCapacity(current.generation, validationCapacity, limits)
          : await this.#transitionCapacity(
              current.generation,
              admission.reservation.key,
              validationCapacity,
              limits,
            );
        if (transitioned.reserved) break;
        if (transitioned.code === "duplicate-reservation") {
          throw new Error("execution capacity disappeared before validation transition");
        }
        await sleep(this.#options.pollIntervalMs ?? 2_000, executionSignal);
      }
      await releaseExecutionCapacity(!recovered);
      const scopedValidation = validator
        ? null
        : await this.#scopedValidation(
            reservation!,
            artifact,
            packet,
            new Date(Math.min(objectiveDeadline, Date.now() + timeoutMs)),
          );
      await this.#lease.use(async (lease) => {
        executionSignal?.throwIfAborted();
        const capacityEvent = await this.#attempts.recordCapacity({
          ...(recovered ? { allowRecovery: true } : {}),
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
        const validationDeadline = new Date(
          Math.min(objectiveDeadline, new Date(capacityEvent.at).getTime() + timeoutMs),
        );
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
          ...(recovered ? { allowRecovery: true } : {}),
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
          publicationBaseBranch: this.#baseBranch,
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
        this.#validations.persist({
          lease,
          identity: this.#validationIdentity(reservation!, artifact!.digest),
          evidence: validation!.evidence,
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
          ...(recovered ? { allowRecovery: true } : {}),
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
      await this.#releaseCapacity(validationCapacity.key);
      validationCapacityReleased = true;
      await this.#lease.use(async (lease) => {
        const validationDuration = Date.now() - validationStarted;
        const events = await this.#recorder.budgetBatch([
          {
            lease,
            workItemNodeId: item.id,
            reservation: reservation!,
            sequence: this.#sequences.take(),
            event: "BudgetReconciled",
            unit: "validation_milliseconds",
            amount: validationDuration,
          },
          ...(validator && validationBudgetUnit
            ? [
                {
                  lease,
                  workItemNodeId: item.id,
                  reservation: reservation!,
                  sequence: this.#sequences.take(),
                  event: "BudgetReconciled" as const,
                  unit: validationBudgetUnit,
                  phase: "validation" as const,
                  amount: validationBudgetUnit === "managed_sessions" ? 1 : validationDuration,
                },
              ]
            : []),
        ]);
        this.#budgetEvents.push(...events);
        if (validator && validationBudgetUnit) validationBudgetReconciled = true;
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
          this.#invokeSemanticReview(
            {
              repository: this.#options.repository,
              objectiveNumber: this.#run.objective,
              workItemNumber: item.number,
              packet,
              artifact,
              evidence: validation!.evidence,
              publicationBaseBranch: this.#baseBranch,
              requiresIsolation:
                this.#policy.trust === "sandbox_untrusted" ||
                packet.requirements.trust !== "trusted_local" ||
                Boolean(deliveryBase?.requiresIsolation),
              ...(reviewModel ? { modelSelection: reviewModel } : {}),
            },
            checkpoint,
            `review-${reviewIdentityDigest(reviewIdentity)}`,
            () =>
              this.#admitModelInvocation(
                `review-${reviewIdentityDigest(reviewIdentity)}`,
                item.id,
                reservation!,
              ),
            (error) =>
              this.#recordProviderQuotaGate(
                error,
                item.id,
                "management",
                this.#management.id,
                reservation!,
              ),
          );
      }
      await this.#reviewTransaction({
        existing: existingReview,
        ...(invokeReview ? { invoke: invokeReview } : {}),
        persist: (result) =>
          this.#lease.use((lease) =>
            this.#reviews.persist({ lease, identity: reviewIdentity, result }),
          ),
        recover: () => this.#reviews.load(reviewIdentity),
        recordFailureUsage: (usage) =>
          this.#recordManagementUsage(
            `review-${reviewIdentityDigest(reviewIdentity)}`,
            usage,
            item.id,
            reservation!,
          ),
        recordProviderGate: (error) =>
          this.#recordProviderQuotaGate(
            error,
            item.id,
            "management",
            this.#management.id,
            reservation!,
          ),
        recordUsage: (record) => this.#recordReviewUsage(record, item, reservation!),
        recordOutcome: (record) => this.#recordInitialReviewOutcome(record, item, reservation!),
      });
      const assertPublicationSafety = async () => {
        try {
          await this.#assertWorkflowPublicationSafety({
            candidateRoot: validation!.worktree.path,
            artifact,
            baseBranch: publicationBaseBranch,
            changedPackageScripts: validation!.publicationReview.changedPackageScripts,
          });
        } catch (cause) {
          throw new PrepublicationApprovalRequiredError(cause);
        }
      };
      await this.#lease.assertGeneration("publication");
      if (selected.capabilities.providerManagedPublication) {
        // Execution-authority paths are rejected for managed publication at
        // admission. Retain a fail-closed assertion if that contract drifts.
        await assertPublicationSafety();
        const pullNumber = Number(handle!.metadata?.pullNumber);
        const headSha = handle!.metadata?.headSha;
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
          beforeRefMutation: assertPublicationSafety,
          beforePullRequestMutation: assertPublicationSafety,
        });
      }
      if (!published) throw new Error("publication did not return a pull request");
      const publication = published;
      await this.#lease.use((lease) =>
        this.#attempts.record({
          ...(recovered ? { allowRecovery: true } : {}),
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
      // Publication ends the worker pipeline. The next reconstructed snapshot
      // integrates regular and native siblings through exact candidate recovery.
      await this.#retryArtifacts.delete(item.number);
      admissionPipelineClosed = true;
    } catch (error) {
      if (
        error instanceof SafeArtifactCheckpointShutdownError &&
        completedArtifactRetained &&
        executionCleanupConfirmed &&
        !validationCapacityRecorded &&
        executionSignal?.aborted &&
        this.#options.signal?.aborted &&
        this.#options.shutdownBehavior === "release-lease"
      ) {
        safeHoldShutdown = true;
        throw new RunCancellationRequestedError(
          "repository controller stopped at proved terminal artifact hold; validation was not admitted",
        );
      }
      if (error instanceof SafeArtifactCheckpointHeldError) throw error;
      // Shutdown before validation admission preserves a durable successful
      // checkpoint for the next fenced controller. Use the intentional teardown
      // signal so a fresh worker's pool settlement also drains without failure;
      // no durable AttemptCancelled/Failed receipt is manufactured here.
      if (
        completedArtifactRetained &&
        !validationCapacityRecorded &&
        executionSignal?.aborted &&
        this.#options.shutdownBehavior === "release-lease"
      ) {
        if (error === executionSignal.reason)
          throw new RunCancellationRequestedError(
            "repository controller stopped after durable execution completion; validation was not admitted",
          );
        // Preserve unrelated fencing/receipt failures rather than disguising
        // their uncertain outcome as an intentional pool teardown.
        throw error;
      }
      if (
        retryableArtifact &&
        validation &&
        selected &&
        selected.capabilities.hostExecution &&
        !selected.capabilities.providerManagedPublication
      ) {
        await this.#retryArtifacts.set(item.number, retryableArtifact);
      }
      const cancellation =
        error instanceof RunCancellationRequestedError || executionSignal?.aborted;
      if (error instanceof ProviderQuotaError && !error.usage)
        retainedUnknownModelInvocationId = error.invocationId;
      if (backendLaunchAttempted && !executionTerminalObserved && !cancellation)
        retainCollectedSource = true;
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
            ...(reservation.localScopeBatch
              ? { localScopeBatch: reservation.localScopeBatch }
              : {}),
            policyDigest: reservation.policyDigest,
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
              ...this.#modelInvocationLink(
                `worker-${item.number}-${reservation!.attempt}`,
                reservation!,
                undefined,
                "execution",
              ),
              ...(terminalModelUsage ? { reportedModelUsage: terminalModelUsage } : {}),
            });
            this.#budgetEvents.push(event);
          });
        } catch (usageError) {
          // Accounting is independent of resource absence. Always attempt
          // cleanup, but never turn a failed fenced receipt into permission
          // to finish or replace this attempt.
          cancelledUsageWriteFailure = {
            error:
              usageError instanceof LeaseLostError || usageError instanceof PlatformUnavailableError
                ? usageError
                : new CancellationAccountingPublicationError(usageError),
          };
        }
      }
      await confirmExecutionCleanup("failed-attempt backend cleanup");
      if (error instanceof ProviderResourceCleanupError && validationCapacity) {
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
        error instanceof ArtifactCollectionCheckpointError ||
        error instanceof NoExecutionBackendError ||
        (selected?.capabilities.id === "codex-app-server/local-worktree" &&
          error instanceof Error &&
          /automated replacement is blocked/.test(error.message))
      ) {
        throw error;
      }
      if (
        backendLaunchAttempted &&
        !executionTerminalObserved &&
        !cancellation &&
        !selected?.capabilities.providerManagedPublication
      ) {
        retainCollectedSource = true;
        throw new ArtifactCollectionCheckpointError(
          new Error(
            "execution completion is unknown after dispatch; absence alone does not authorize replacement",
            { cause: error },
          ),
        );
      }
      if (cancelledUsageWriteFailure) throw cancelledUsageWriteFailure.error;
      const reason = error instanceof Error ? error.message : String(error);
      const deferredBeforeDispatch =
        error instanceof ExecutionSourceAdvancedBeforeDispatchError && !backendLaunchAttempted;
      if (error instanceof PrepublicationApprovalRequiredError) {
        if (!reservation || !retryableArtifact || !completedArtifactRetained)
          throw new Error("pre-publication hold lacks a durable completed artifact", {
            cause: error,
          });
        await this.#retryArtifacts.set(item.number, retryableArtifact);
        await this.#lease.use((lease) =>
          this.#attempts.record({
            ...(recovered ? { allowRecovery: true } : {}),
            lease,
            workItemNodeId: item.id,
            reservation: reservation!,
            event: "AttemptDeferred",
            sequence: this.#sequences.take(),
            reason,
          }),
        );
        admissionPipelineClosed = true;
        throw error;
      }
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
                ...(recovered ? { allowRecovery: true } : {}),
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
              amount: backendLaunchAttempted
                ? budgetUnit === "managed_sessions"
                  ? 1
                  : Date.now() - started
                : 0,
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
            ...(recovered ? { allowRecovery: true } : {}),
            lease,
            workItemNodeId: item.id,
            reservation: reservation!,
            event: deferredBeforeDispatch
              ? "AttemptDeferred"
              : cancellation
                ? "AttemptCancelled"
                : "AttemptFailed",
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
      admissionPipelineClosed = true;
      if (cancellation) throw new RunCancellationRequestedError(reason);
      if (error instanceof ProviderQuotaError) throw error;
      this.#notify(
        deferredBeforeDispatch
          ? `Work Item #${item.number} returned to queue before dispatch: ${reason}`
          : `Work Item #${item.number} failed: ${reason}`,
      );
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
        if (worker && !retainCollectedSource) await cleanupLocalWorktree(worker);
        if (validation) await discardValidationResult(validation);
      } catch (error) {
        finalizationError ??= error;
      } finally {
        if (validationCapacity && !validationCapacityReleased) {
          await this.#releaseCapacity(validationCapacity.key);
          validationCapacityReleased = true;
        }
      }
      if (
        !finalizationError &&
        admissionPipelineClosed &&
        reservation &&
        (!backendLaunchAttempted || executionCleanupConfirmed)
      ) {
        await releaseExecutionCapacity();
        await this.#settleIssueAdmission(item, reservation, {
          cleanupConfirmed: executionCleanupConfirmed || !backendLaunchAttempted,
          definitiveNonExecution: !backendLaunchAttempted && !recovered,
          modelUsageExpected:
            !recovered?.adoptedSource && (selected?.capabilities.reportsModelUsage ?? false),
          ...(retainedUnknownModelInvocationId ? { retainedUnknownModelInvocationId } : {}),
          ...(recovered?.adoptedSource
            ? {
                artifactConsumer: {
                  sourceRunId: recovered.adoptedSource.reservation.runId,
                  sourceReservationOid: recovered.adoptedSource.reservation.oid,
                  sourceAttempt: recovered.adoptedSource.reservation.attempt,
                  artifactDigest: recovered.adoptedSource.artifactDigest,
                },
              }
            : {}),
        });
      }
      if (finalizationError) {
        // An orderly hold is not permission to suppress a later cleanup failure
        // through the outer signal-aborted shutdown branch.
        // biome-ignore lint/correctness/noUnsafeFinally: uncertain cleanup must override success so Factory cannot launch a duplicate paid or local worker
        throw safeHoldShutdown
          ? new SafeArtifactCheckpointHeldError(finalizationError)
          : finalizationError;
      }
    }
  }

  /** Ready immutable artifacts take this entry before any provider-session fallback.
   * Caller proves original resource absence; this entry independently requires exact
   * reconciled execution accounting and never replays an already-started validation. */
  async #continueCollectedArtifact(
    item: DerivedWorkItem,
    deadline: number,
    recovered: CollectedAttemptContinuation,
  ): Promise<void> {
    this.#options.signal?.throwIfAborted();
    const { reservation, packet, artifact, modelUsage, nativeUsage } = recovered;
    const adopted = recovered.adoptedSource;
    const modelTokens =
      recovered.modelTokens ??
      (modelUsage ? modelUsage.inputTokens + modelUsage.outputTokens : undefined);
    const backend = this.#registry.get(reservation.backend);
    const original = reservation.admission;
    if (
      !backend ||
      backend.capabilities.providerManagedPublication ||
      !original ||
      reservation.runId !== this.#run.runId ||
      reservation.objective !== this.#run.objective ||
      reservation.workItem !== item.number ||
      reservation.policyDigest !== policyDigest(this.#policy) ||
      packet.baseSha !== reservation.baseSha ||
      artifact.baseSha !== reservation.baseSha ||
      artifact.outcome !== "succeeded" ||
      (backend.capabilities.hostExecution && !reservation.localScopeBatch && !adopted) ||
      (reservation.localScopeBatch &&
        reservation.localScopeBatch.identity.invocationDigest !== workerPacketDigest(packet))
    )
      throw new Error("collected attempt continuation is not bound to its original execution");
    const prior = deduplicateFactoryEvents([
      ...(item.factoryEvents ?? []),
      ...this.#budgetEvents,
    ]).filter(
      (event) =>
        event.runId === reservation.runId &&
        "workItem" in event &&
        event.workItem === item.number &&
        "attempt" in event &&
        event.attempt === reservation.attempt,
    );
    const recoverablePostSuccessCancellation = this.#isRecoverablePostSuccessCancellation(prior);
    if (
      prior.some(
        (event) =>
          event.kind === "validation" ||
          (event.kind === "capacity" && event.phase === "validation") ||
          (event.kind === "attempt" &&
            [
              "AttemptCollected",
              "AttemptValidated",
              "AttemptPublished",
              "AttemptIntegrated",
              "AttemptFailed",
              "AttemptTimedOut",
              ...(recoverablePostSuccessCancellation ? [] : ["AttemptCancelled"]),
              "AttemptDeferred",
            ].includes(event.event)),
      )
    )
      throw new Error(
        "collected continuation cannot replay terminal or previously invoked validation work",
      );
    if (
      prior.some(
        (event) =>
          event.kind === "attempt" &&
          event.event === "AttemptSucceeded" &&
          event.artifactDigest !== artifact.digest,
      )
    )
      throw new Error("retained artifact differs from its original terminal success receipt");
    const model = prior.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.phase === "execution" &&
        event.unit === "model_tokens",
    );
    const native = prior.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.phase === "execution" &&
        event.unit === nativeUsage.unit,
    );
    if (
      !adopted &&
      modelUsage &&
      model.some(
        (event) =>
          event.kind === "budget" &&
          event.reportedModelUsage &&
          (["inputTokens", "outputTokens", "cachedInputTokens"] as const).some(
            (key) =>
              event.reportedModelUsage?.[key] !== undefined &&
              modelUsage[key] !== undefined &&
              event.reportedModelUsage[key] !== modelUsage[key],
          ),
      )
    )
      throw new Error("collected continuation has conflicting model usage breakdowns");
    if (
      !adopted &&
      prior.some(
        (event) =>
          event.kind === "attempt" &&
          event.event === "AttemptSucceeded" &&
          event.reportedModelTokens !== undefined &&
          event.reportedModelTokens !== modelTokens,
      )
    )
      throw new Error("collected continuation model accounting differs from terminal success");
    const expectedUnit = isManagedAgentBackendId(reservation.backend)
      ? "managed_sessions"
      : isSandboxBackendId(reservation.backend)
        ? "sandbox_milliseconds"
        : "local_milliseconds";
    if (
      !adopted &&
      ((this.#policy.economics &&
        backend.capabilities.reportsModelUsage &&
        (modelTokens === undefined || !model.length)) ||
        (modelTokens !== undefined &&
          (!Number.isSafeInteger(modelTokens) ||
            modelTokens < 0 ||
            !model.length ||
            model.some(
              (event) =>
                event.kind !== "budget" ||
                event.usageId !== `worker-${item.number}-${reservation.attempt}` ||
                event.amount !== modelTokens,
            ))) ||
        (modelUsage && modelUsage.inputTokens + modelUsage.outputTokens !== modelTokens) ||
        (modelTokens === undefined && model.length > 0) ||
        nativeUsage.unit !== expectedUnit ||
        !native.length ||
        native.some((event) => event.kind !== "budget" || event.amount !== nativeUsage.amount) ||
        !Number.isFinite(nativeUsage.amount) ||
        nativeUsage.amount < 0)
    )
      throw new Error("collected continuation lacks exact reconciled execution accounting");
    if (
      adopted &&
      (modelTokens !== undefined ||
        modelUsage !== undefined ||
        model.length > 0 ||
        native.length > 0 ||
        artifact.digest !== adopted.artifactDigest ||
        adopted.reservation.objective !== reservation.objective ||
        adopted.reservation.workItem !== reservation.workItem ||
        adopted.reservation.runId === reservation.runId)
    )
      throw new Error("adopted artifact continuation conflicts with predecessor provenance");
    let validation: AdmissionProposal["validation"];
    if (packet.requirements.trust !== "trusted_local" || !backend.capabilities.hostExecution) {
      const held = unreconciledBudgetReservations(prior).filter(
        (event) => event.phase === "validation",
      );
      const remaining = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
      const duration = Math.min(
        (packet.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) * 60_000,
        deadline - Date.now(),
      );
      if (duration <= 0)
        throw new Error("Objective deadline exhausted before recovered artifact validation");
      const selected = await this.#externalAdmission(() =>
        this.#registry.selectIsolatedValidator({
          policy: this.#policy,
          requirements: packet.requirements,
          estimatedDurationMs: duration,
          budget: {
            ...remaining,
            sandboxMinutes:
              remaining.sandboxMinutes +
              held
                .filter((event) => event.unit === "sandbox_milliseconds")
                .reduce((sum, event) => sum + event.amount, 0) /
                60_000,
          },
        }),
      );
      const unit = isSandboxBackendId(selected.backend.capabilities.id)
        ? "sandbox_milliseconds"
        : isManagedAgentBackendId(selected.backend.capabilities.id)
          ? "managed_sessions"
          : "none";
      const reservationBudget = held.filter((event) => event.unit === unit);
      if (
        unit !== "none" &&
        (reservationBudget.length !== 1 ||
          reservationBudget[0]!.amount < (unit === "managed_sessions" ? 1 : duration))
      )
        throw new Error(
          "recovered artifact requires its existing unspent independent-validation allowance",
        );
      validation = {
        backendId: selected.backend.capabilities.id,
        reservedBudget: { unit, amount: reservationBudget[0]?.amount ?? 0 },
      };
    }
    const executionKey = capacityReservationKey({
      objective: reservation.objective,
      workItem: item.number,
      attempt: reservation.attempt,
      phase: "execution",
      backendId: reservation.backend,
    });
    if (!adopted) await this.#releaseCapacity(executionKey);
    const capacity = await this.#capacitySnapshot();
    const admission: AdmissionProposal = {
      workItem: item.number,
      backendId: reservation.backend,
      admissionClass: original.admissionClass,
      admissionReason: original.admissionReason,
      requirements: { cpu: original.requestedCpu, memoryMb: original.requestedMemoryMb },
      priority: {
        rank: original.priorityRank,
        source: original.prioritySource ?? "subissue-order",
        subIssuePosition: original.subIssuePosition,
        criticalPathLength: original.criticalPathLength,
        unfinishedDownstream: original.unfinishedDownstream,
      },
      capacityGeneration: capacity.generation,
      reservation: {
        key: executionKey,
        objective: reservation.objective,
        workItem: item.number,
        attempt: reservation.attempt,
        phase: "execution",
        backendId: reservation.backend,
        admissionClass: original.admissionClass,
        local: backend.capabilities.hostExecution && !backend.capabilities.requiresPaidRuntime,
        cpu: original.requestedCpu,
        memoryMb: original.requestedMemoryMb,
        paidUnits: backend.capabilities.requiresPaidRuntime ? 1 : 0,
        paths: packet.allowedPaths,
        exclusiveResources: packet.changeSurface?.exclusiveResources ?? [],
      },
      reservedBudget: { unit: "none", amount: 0 },
      ...(validation ? { validation } : {}),
    };
    let deliveryBase: DeliveryExecutionBase | undefined;
    if (this.#deliverySelection.selected === "native-stacks") {
      const metadata = parseGraphItemMetadata(item.body ?? "");
      const planned = this.#deliveryPlan?.items.find((entry) => entry.itemId === metadata.id);
      if (!planned) throw new Error("retained artifact lacks its immutable delivery plan");
      if (planned.parentItemId) {
        const snapshot = await this.#reader.readObjective(this.#run.objective);
        this.#fenceSnapshot(snapshot);
        const parent = this.#deriveObjective(snapshot).items.find(
          (entry) => parseGraphItemMetadata(entry.body ?? "").id === planned.parentItemId,
        );
        if (!parent) throw new Error("retained artifact stack parent is missing");
        const member = await this.#nativeStackMember(parent, true);
        if (
          member.pull.commitSha !== reservation.baseSha ||
          member.observedHeadSha !== reservation.baseSha
        )
          throw new Error(
            "retained artifact stack parent advanced; automated replacement is blocked pending exact parent recovery",
          );
        deliveryBase = { branch: member.pull.branch, sha: reservation.baseSha };
      }
    }
    this.#options.signal?.throwIfAborted();
    const retainedBase = await this.#store.readCommit(reservation.baseSha);
    const capabilitySnapshot = await this.#reader.readObjective(this.#run.objective);
    this.#fenceSnapshot(capabilitySnapshot);
    const capabilityObjective = this.#deriveObjective(capabilitySnapshot);
    const capabilitySourceRef = `refs/heads/${deliveryBase?.branch ?? this.#baseBranch}`;
    const repositoryCapabilityProofs = await this.#resolveExecutionBaseCapabilities(
      item,
      packet,
      retainedBase,
      capabilitySourceRef,
      capabilityObjective.items,
    );
    await this.#execute(
      item,
      deadline,
      admission,
      async () => {},
      deliveryBase,
      this.#options.signal,
      repositoryCapabilityProofs,
      packet,
      reservation.managedRuntimeActivation,
      recovered,
    );
  }

  #retainArtifactContent(artifact: NormalizedArtifact): NormalizedArtifact {
    return retainScopedArtifact(artifact);
  }

  async #sessionJournal(reservation: AttemptReservation): Promise<AppServerSessionJournal> {
    const repository = `${this.#options.owner}/${this.#options.repo}`;
    const earlier = (await this.#attempts.list(reservation.objective, reservation.workItem))
      .filter(
        (candidate) =>
          candidate.runId === reservation.runId &&
          candidate.attempt < reservation.attempt &&
          candidate.backend === "codex-app-server/local-worktree",
      )
      .sort((a, b) => b.attempt - a.attempt);
    let previous: AppServerSessionJournal["previous"];
    if (earlier[0]) {
      previous = (await this.#sessions.load(repository, earlier[0], "terminal")) ?? undefined;
      if (!previous || !completeSessionUsage(previous.usage))
        throw new Error(
          "prior App Server session usage is unavailable; automated replacement is blocked",
        );
    }
    return {
      load: (stage) => this.#sessions.load(repository, reservation, stage),
      persist: (checkpoint) =>
        this.#lease.use((lease) =>
          this.#sessions.persist({ repository, reservation, lease, checkpoint }),
        ),
      assertCurrent: () => this.#externalAdmission(async () => {}),
      ...(previous ? { previous } : {}),
    };
  }

  /** Ready artifact recovery reads this first; it does not reload a provider or recollect. */
  async #recoverAppServerUsage(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    events: readonly FactoryEvent[],
  ): Promise<(ReportedModelUsage & { inputTokens: number; outputTokens: number }) | null> {
    const terminal = await this.#sessions.load(
      `${this.#options.owner}/${this.#options.repo}`,
      reservation,
      "terminal",
    );
    if (!terminal || terminal.state !== "succeeded" || !completeSessionUsage(terminal.usage))
      return null;
    const usage = reportedModelUsage(terminal.usage);
    if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
    const matching = events.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.runId === reservation.runId &&
        event.workItem === item.number &&
        event.attempt === reservation.attempt &&
        event.phase === "execution" &&
        event.unit === "model_tokens",
    );
    if (
      matching.some(
        (event) =>
          event.kind !== "budget" ||
          event.usageId !== `worker-${item.number}-${reservation.attempt}` ||
          event.amount !== usage.inputTokens! + usage.outputTokens!,
      )
    )
      throw new Error("App Server terminal usage conflicts with its original budget receipt");
    const link = this.#modelInvocationLink(
      `worker-${item.number}-${reservation.attempt}`,
      reservation,
      undefined,
      "execution",
    );
    if (!this.#hasModelUsageLink(matching, link))
      await this.#lease.use(async (lease) => {
        this.#budgetEvents.push(
          await this.#recorder.budget({
            lease,
            workItemNodeId: item.id,
            reservation,
            sequence: this.#sequences.take(),
            event: "BudgetReconciled",
            phase: "execution",
            unit: "model_tokens",
            amount: usage.inputTokens! + usage.outputTokens!,
            usageId: `worker-${item.number}-${reservation.attempt}`,
            ...link,
            reportedModelUsage: usage,
          }),
        );
      });
    return { ...usage, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  }

  async #recoverAppServerSession(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    deadline: number,
    events: readonly FactoryEvent[],
  ): Promise<void> {
    const repository = `${this.#options.owner}/${this.#options.repo}`;
    const prepared = await this.#sessions.load(repository, reservation, "prepared");
    const backend = this.#registry.get(reservation.backend);
    if (!prepared || !backend?.resume)
      throw new Error(
        "App Server session identity is unavailable; automated replacement is blocked",
      );
    if (
      events.some(
        (event) =>
          (event.kind === "capacity" && event.phase === "validation") ||
          event.kind === "validation",
      )
    )
      throw new Error(
        "prior validation may have executed; automated replacement is blocked without its durable artifact/result checkpoint",
      );
    const sessionJournal = await this.#sessionJournal(reservation);
    const modelSelection = resolveModelSelection(
      this.#policy,
      reservation.attempt === 1 ? "implement" : "recover",
    );
    let handle: BackendHandle | undefined;
    try {
      handle = await backend.resume(
        {
          repository,
          objective: reservation.objective,
          workItem: reservation.workItem,
          attempt: reservation.attempt,
          runId: reservation.runId,
          directorEpoch: reservation.directorEpoch,
          policyDigest: reservation.policyDigest,
          workspace: prepared.binding.workspace,
          packet: prepared.packet,
          deadline: new Date(prepared.binding.deadline),
          policyNetworkDestinations: this.#policy.allowedNetworkDestinations,
          ...(modelSelection ? { modelSelection } : {}),
          sessionJournal,
        },
        appServerHandleFromCheckpoint(prepared),
      );
      const observed = await backend.observe(handle);
      const usage = reportedModelUsage(observed.usage);
      if (
        observed.state !== "succeeded" ||
        !usage ||
        usage.inputTokens === undefined ||
        usage.outputTokens === undefined
      )
        throw new Error(
          "App Server terminal success and complete model usage are required for artifact continuation",
        );
      const model = events.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.phase === "execution" &&
          event.unit === "model_tokens",
      );
      if (
        model.some(
          (event) =>
            event.kind !== "budget" ||
            event.usageId !== `worker-${item.number}-${reservation.attempt}` ||
            event.amount !== usage.inputTokens! + usage.outputTokens!,
        )
      )
        throw new Error("App Server recovered usage conflicts with original accounting");
      const link = this.#modelInvocationLink(
        `worker-${item.number}-${reservation.attempt}`,
        reservation,
        undefined,
        "execution",
      );
      if (!this.#hasModelUsageLink(model, link))
        await this.#lease.use(async (lease) => {
          this.#budgetEvents.push(
            await this.#recorder.budget({
              lease,
              workItemNodeId: item.id,
              reservation,
              sequence: this.#sequences.take(),
              event: "BudgetReconciled",
              phase: "execution",
              unit: "model_tokens",
              amount: usage.inputTokens! + usage.outputTokens!,
              usageId: `worker-${item.number}-${reservation.attempt}`,
              ...link,
              reportedModelUsage: usage,
            }),
          );
        });
      const artifact = await backend.collect(handle);
      // The same durable artifact boundary as fresh execution. Never remove the
      // original materialization on persistence failure, and never generate again.
      try {
        await this.#persistCollectedArtifact(reservation, prepared.packet, artifact, deadline);
      } catch (error) {
        throw new ArtifactCollectionCheckpointError(error);
      }
      await backend.cleanup(handle);
      handle = undefined;
      const native = events.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.phase === "execution" &&
          event.unit === "local_milliseconds",
      );
      let nativeMilliseconds: number;
      if (native.length) {
        const amounts = new Set(
          native.map((event) => (event.kind === "budget" ? event.amount : NaN)),
        );
        if (amounts.size !== 1) throw new Error("original native usage receipts conflict");
        nativeMilliseconds = [...amounts][0]!;
      } else {
        const reserved = deduplicateFactoryEvents([...events]).filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReserved" &&
            event.phase === "execution" &&
            event.unit === "local_milliseconds",
        );
        if (reserved.length !== 1 || reserved[0]!.kind !== "budget" || reserved[0]!.amount <= 0)
          throw new Error("original positive local execution allowance is unavailable");
        nativeMilliseconds = reserved[0]!.amount;
        await this.#lease.use(async (lease) => {
          this.#budgetEvents.push(
            await this.#recorder.budget({
              lease,
              workItemNodeId: item.id,
              reservation,
              sequence: this.#sequences.take(),
              event: "BudgetReconciled",
              phase: "execution",
              unit: "local_milliseconds",
              amount: nativeMilliseconds,
              usageEvidence: "conservative-reservation",
              reason:
                "Exact terminal session and original worker scope absence were independently verified; charging the original reserved duration, not measured elapsed execution",
            }),
          );
        });
      }
      await this.#continueCollectedArtifact(item, deadline, {
        reservation,
        packet: prepared.packet,
        artifact,
        modelUsage: { ...usage, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        nativeUsage: { unit: "local_milliseconds", amount: nativeMilliseconds },
        worker: {
          root: dirname(prepared.binding.workspace),
          path: prepared.binding.workspace,
          repository: this.#options.repository,
          baseSha: reservation.baseSha,
        },
      });
    } catch (error) {
      if (
        error instanceof PlatformUnavailableError ||
        error instanceof LeaseLostError ||
        error instanceof ArtifactCollectionCheckpointError
      )
        throw error;
      throw new Error(
        `App Server recovery is unavailable; automated replacement is blocked: ${error instanceof Error ? error.message : "unknown protocol outcome"}`,
        { cause: error },
      );
    } finally {
      if (handle) await backend.cleanup(handle);
    }
  }

  #artifactTransferIdentity(reservation: AttemptReservation): ArtifactTransferIdentity {
    return {
      repository: `${this.#options.owner}/${this.#options.repo}`,
      objective: reservation.objective,
      workItem: reservation.workItem,
      attempt: reservation.attempt,
      runId: reservation.runId,
      directorEpoch: reservation.directorEpoch,
      policyDigest: reservation.policyDigest,
      baseSha: reservation.baseSha,
    };
  }

  async #recoverRetainedArtifact(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    events: FactoryEvent[],
    backend: ExecutionBackend,
    deadline: number,
  ): Promise<boolean> {
    if (backend.capabilities.providerManagedPublication) return false;
    const planned = this.#plannedRecoveryItem(item.number);
    let adoptedSource: CollectedAttemptContinuation["adoptedSource"];
    if (planned?.action === "reconcile" && planned.source?.artifactDigest) {
      const source = planned.source;
      const sourceReservation = (await this.#attempts.list(this.#run.objective, item.number)).find(
        (candidate) =>
          candidate.runId === source.runId &&
          candidate.attempt === source.attempt &&
          candidate.oid === source.reservationCommitOid &&
          candidate.ref === source.reservationRef,
      );
      if (
        !sourceReservation ||
        reservation.runId !== this.#run.runId ||
        reservation.attempt <= sourceReservation.attempt ||
        reservation.backend !== sourceReservation.backend ||
        reservation.baseSha !== sourceReservation.baseSha
      )
        throw new Error("successor artifact consumer differs from its accepted predecessor");
      adoptedSource = { reservation: sourceReservation, artifactDigest: source.artifactDigest! };
    }
    const original = this.#packetFor(item.number);
    const retainedRetryContext = retryContext(
      item,
      adoptedSource?.reservation.runId ?? this.#run.runId,
    );
    const graphPacket = parseWorkerPacket({
      ...original,
      baseSha: reservation.baseSha,
      ...(retainedRetryContext ? { retryContext: retainedRetryContext } : {}),
      requirements: {
        ...original.requirements,
        ...(this.#policy.trust === "sandbox_untrusted" &&
        original.requirements.trust === "trusted_local"
          ? { trust: "isolated" as const }
          : {}),
      },
    });
    const packet = packetWithManagedRuntimeActivation(
      graphPacket,
      reservation.managedRuntimeActivation,
    );
    if (
      reservation.localScopeBatch &&
      reservation.localScopeBatch.identity.invocationDigest !== workerPacketDigest(packet)
    )
      throw new Error("retained artifact packet differs from its original scoped invocation");
    let artifact: NormalizedArtifact | null;
    try {
      artifact = await resumeArtifactTransfer({
        store: this.#store,
        identity: this.#artifactTransferIdentity(reservation),
        allowedPaths: packet.allowedPaths,
        assertCurrent: () => this.#externalAdmission(async () => {}),
      });
    } catch (cause) {
      throw new ArtifactCollectionCheckpointError(cause);
    }
    if (!artifact) return false;
    this.#retainArtifactContent(artifact);
    const recoverablePostSuccessCancellation = this.#isRecoverablePostSuccessCancellation(events);
    if (
      events.some(
        (event) =>
          event.kind === "attempt" &&
          event.event === "AttemptSucceeded" &&
          event.artifactDigest !== artifact.digest,
      )
    )
      throw new Error("retained artifact differs from its original terminal success receipt");
    if (
      events.some(
        (event) =>
          event.kind === "validation" ||
          (event.kind === "capacity" && event.phase === "validation") ||
          (event.kind === "attempt" &&
            [
              "AttemptCollected",
              "AttemptValidated",
              "AttemptPublished",
              "AttemptIntegrated",
              "AttemptFailed",
              "AttemptTimedOut",
              ...(recoverablePostSuccessCancellation ? [] : ["AttemptCancelled"]),
              "AttemptDeferred",
            ].includes(event.event)),
      )
    )
      throw new Error(
        "retained output has later lifecycle evidence; automated replacement is blocked pending exact validation/publication recovery",
      );
    const started = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptStarted",
    );
    if (!backend.reconcileStale)
      throw new Error(
        "retained output has no backend absence reconciler; automated replacement is blocked",
      );
    await backend.reconcileStale({
      repository: `${this.#options.owner}/${this.#options.repo}`,
      objective: reservation.objective,
      workItem: reservation.workItem,
      attempt: reservation.attempt,
      runId: reservation.runId,
      directorEpoch: reservation.directorEpoch,
      policyDigest: reservation.policyDigest,
      phase: "execution",
      ...(reservation.localScopeBatch ? { localScopeBatch: reservation.localScopeBatch } : {}),
      ...(started?.kind === "attempt" && started.providerResourceId
        ? { providerResourceId: started.providerResourceId }
        : {}),
    });
    let model = events.filter(
      (event): event is Extract<FactoryEvent, { kind: "budget" }> =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.phase === "execution" &&
        event.unit === "model_tokens",
    );
    if (
      !adoptedSource &&
      this.#policy.economics &&
      backend.capabilities.reportsModelUsage &&
      !model.length
    ) {
      await this.#recoverAppServerUsage(item, reservation, events);
      model = this.#budgetEvents.filter(
        (event): event is Extract<FactoryEvent, { kind: "budget" }> =>
          event.kind === "budget" &&
          event.runId === reservation.runId &&
          event.workItem === item.number &&
          event.attempt === reservation.attempt &&
          event.event === "BudgetReconciled" &&
          event.phase === "execution" &&
          event.unit === "model_tokens",
      );
    }
    const reported = model[0]?.reportedModelUsage;
    const modelUsage =
      reported?.inputTokens !== undefined && reported.outputTokens !== undefined
        ? { ...reported, inputTokens: reported.inputTokens, outputTokens: reported.outputTokens }
        : undefined;
    // A content checkpoint does not invent accounting. The session fallback may
    // restore an exact terminal usage receipt, but must not dispatch a new turn.
    if (
      !adoptedSource &&
      this.#policy.economics &&
      backend.capabilities.reportsModelUsage &&
      !model.length
    )
      throw new Error(
        "retained output lacks exact terminal model usage; automated replacement is blocked pending usage recovery",
      );
    const unit = isSandboxBackendId(reservation.backend)
      ? "sandbox_milliseconds"
      : "local_milliseconds";
    let native = events.filter(
      (event): event is Extract<FactoryEvent, { kind: "budget" }> =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.phase === "execution" &&
        event.unit === unit,
    );
    if (!adoptedSource && !native.length) {
      const held = unreconciledBudgetReservations(events).filter(
        (event) => event.phase === "execution" && event.unit === unit,
      );
      if (held.length !== 1)
        throw new Error(
          "retained output lacks its original native allowance; automated replacement is blocked",
        );
      const event = await this.#lease.use((lease) =>
        this.#recorder.budget({
          lease,
          workItemNodeId: item.id,
          reservation,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled",
          phase: "execution",
          unit,
          amount: held[0]!.amount,
          usageEvidence: "conservative-reservation",
          reason:
            "Original resource absence is proven; charge its reserved duration because exact elapsed usage is unavailable. This is not measured consumption or invoice settlement.",
        }),
      );
      this.#budgetEvents.push(event);
      if (event.kind !== "budget")
        throw new Error("native recovery did not record a budget receipt");
      native = [event];
    }
    await this.#continueCollectedArtifact(item, deadline, {
      reservation,
      packet,
      artifact,
      ...(!adoptedSource && model.length ? { modelTokens: model[0]!.amount } : {}),
      ...(!adoptedSource && modelUsage ? { modelUsage } : {}),
      nativeUsage: { unit, amount: adoptedSource ? 0 : native[0]!.amount },
      ...(adoptedSource ? { adoptedSource } : {}),
    });
    return true;
  }

  async #persistCollectedArtifact(
    reservation: AttemptReservation,
    packet: WorkerPacket,
    artifact: NormalizedArtifact,
    objectiveDeadline: number,
    qualification?: {
      modelTokens: number | undefined;
      providerResourceId: string;
      turnId: string | undefined;
      signal: AbortSignal | undefined;
    },
  ): Promise<void> {
    await persistArtifactTransfer({
      store: this.#store,
      identity: this.#artifactTransferIdentity(reservation),
      artifact,
      allowedPaths: packet.allowedPaths,
      assertCurrent: () => this.#externalAdmission(async () => {}),
      ...(qualification && reservation.localScopeBatch
        ? {
            afterIntent: async (checkpoint: ArtifactTransferIntentCheckpoint) =>
              holdArtifactTransferQualificationCheckpoint({
                checkpoint,
                ...(this.#run.activationRequestId
                  ? { activationRequestId: this.#run.activationRequestId }
                  : {}),
                batch: reservation.localScopeBatch,
                objectiveStartedAt: this.#run.startedAt,
                objectiveDeadline: new Date(objectiveDeadline),
                holdDurationMs: this.#policy.workItemTimeoutMinutes * 60_000,
                ...(qualification.signal ? { signal: qualification.signal } : {}),
                assertCurrent: () => this.#externalAdmission(async () => {}),
                proveTerminal: async () => {
                  const snapshot = await this.#reader.readObjective(this.#run.objective);
                  this.#fenceSnapshot(snapshot);
                  const events = snapshotEvents(snapshot);
                  this.#sequences.observe(events);
                  const proof = proveArtifactTransferQualificationReceipts({
                    checkpoint,
                    activationRequestId: this.#run.activationRequestId,
                    backend: reservation.backend,
                    reservationSequence: reservation.sequence,
                    providerResourceId: qualification.providerResourceId,
                    modelTokens: qualification.modelTokens,
                    batch: reservation.localScopeBatch,
                    events,
                  });
                  if (reservation.backend === "codex-app-server/local-worktree") {
                    const terminal = await this.#sessions.load(
                      `${this.#options.owner}/${this.#options.repo}`,
                      reservation,
                      "terminal",
                    );
                    if (
                      !terminal ||
                      terminal.state !== "succeeded" ||
                      !completeSessionUsage(terminal.usage) ||
                      !qualification.turnId ||
                      terminal.turnId !== qualification.turnId ||
                      terminal.binding.threadId !== qualification.providerResourceId ||
                      terminal.usage!.inputTokens! + terminal.usage!.outputTokens! !==
                        qualification.modelTokens
                    )
                      throw new Error(
                        "transfer qualification lacks exact complete terminal session usage",
                      );
                    proof.session = {
                      threadId: qualification.providerResourceId,
                      turnId: qualification.turnId,
                      checkpointDigest: createHash("sha256")
                        .update(JSON.stringify(terminal))
                        .digest("hex"),
                    };
                  }
                  return proof;
                },
              }),
          }
        : {}),
    });
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

  #validationIdentity(reservation: AttemptReservation, artifactDigest: string): ValidationIdentity {
    return {
      runId: reservation.runId,
      objective: reservation.objective,
      workItem: reservation.workItem,
      attempt: reservation.attempt,
      artifactDigest,
      baseSha: reservation.baseSha,
      directorEpoch: reservation.directorEpoch,
      policyDigest: reservation.policyDigest,
    };
  }

  #reviewTransaction(args: Parameters<typeof runDurableReviewTransaction>[0]) {
    return this.#modelInvocations.run(() => runDurableReviewTransaction(args));
  }

  #invokeSemanticReview(
    context: ReviewContext,
    checkpoint: ReviewCheckpoint,
    invocationId: string,
    admit: () => Promise<number>,
    checkpointProviderRefusal: (error: ProviderQuotaError) => Promise<void>,
  ): Promise<ReviewResult> {
    const operationTimeoutMs = this.#policy.workItemTimeoutMinutes * 60_000;
    context.invocationTimeoutMs = Math.min(
      context.invocationTimeoutMs ?? operationTimeoutMs,
      operationTimeoutMs,
    );
    let dispatched = false;
    let admitted = false;
    const beforeModelInvocation = () =>
      this.#externalAdmission(async () => {
        if (dispatched) throw new Error("semantic review attempted duplicate dispatch");
        dispatched = true;
        const remainingMs = Math.min(await admit(), operationTimeoutMs);
        admitted = true;
        return {
          timeoutMs: remainingMs,
          modelInvocationId: invocationId,
          checkpointProviderRefusal,
        };
      });
    const admittedCheckpoint: ReviewCheckpoint = (result) => {
      if (!admitted) throw new Error("semantic review checkpoint precedes dispatch admission");
      return checkpoint(result);
    };
    const invocation = this.#management.reviewWithAdmission
      ? this.#management.reviewWithAdmission(context, admittedCheckpoint, beforeModelInvocation)
      : beforeModelInvocation().then((admission) => {
          const remainingMs = admission.timeoutMs;
          context.invocationTimeoutMs = Math.min(
            remainingMs,
            context.invocationTimeoutMs ?? remainingMs,
          );
          return this.#management.review(context, admittedCheckpoint);
        });
    return invocation.catch((error: unknown) => {
      if (error instanceof ProviderQuotaError) error.bindInvocation(invocationId);
      throw error;
    });
  }

  async #recoverMissingInitialReview(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    events: readonly FactoryEvent[],
    validation: Extract<FactoryEvent, { kind: "validation" }>,
  ): Promise<boolean> {
    const collected = events.filter(
      (event): event is Extract<FactoryEvent, { kind: "attempt" }> =>
        event.kind === "attempt" &&
        event.event === "AttemptCollected" &&
        Boolean(event.artifactDigest),
    );
    const artifactDigests = new Set(collected.map((event) => event.artifactDigest!));
    if (artifactDigests.size !== 1) {
      throw new Error("validated recovery lacks one exact collected artifact identity");
    }
    const artifactDigest = [...artifactDigests][0]!;
    const reviewIdentity: ReviewIdentity = {
      kind: "artifact",
      runId: reservation.runId,
      objective: reservation.objective,
      workItem: reservation.workItem,
      attempt: reservation.attempt,
      artifactDigest,
      baseSha: validation.baseSha,
      outputTreeSha: validation.outputTreeSha,
      evidenceDigest: validation.evidenceDigest,
    };
    const existing = await this.#reviews.load(reviewIdentity);
    let invoke:
      | ((
          checkpoint: Parameters<ManagementBackend["review"]>[1],
        ) => ReturnType<ManagementBackend["review"]>)
      | undefined;
    if (!existing) {
      const checkpoint = await this.#validations.load(
        this.#validationIdentity(reservation, artifactDigest),
      );
      if (
        !checkpoint ||
        !checkpoint.evidence.passed ||
        checkpoint.evidence.digest !== validation.evidenceDigest ||
        checkpoint.evidence.outputTreeSha !== validation.outputTreeSha
      ) {
        throw new Error(
          "validated recovery lacks its authenticated full validation checkpoint; refusing to rerun validation or review incomplete evidence",
        );
      }
      const original = this.#packetFor(item.number);
      const packet = this.#packetBoundToReservation(
        item,
        reservation,
        reservation.baseSha,
        this.#policy.trust === "sandbox_untrusted" &&
          original.requirements.trust === "trusted_local"
          ? "isolated"
          : original.requirements.trust,
      );
      const artifact = await resumeArtifactTransfer({
        store: this.#store,
        identity: this.#artifactTransferIdentity(reservation),
        allowedPaths: packet.allowedPaths,
        assertCurrent: () => this.#externalAdmission(async () => {}),
      });
      if (
        !artifact ||
        artifact.outcome !== "succeeded" ||
        artifact.digest !== artifactDigest ||
        artifact.baseSha !== reservation.baseSha
      ) {
        throw new Error("validated recovery differs from its exact retained artifact");
      }
      this.#retainArtifactContent(artifact);
      const invocationId = `review-${reviewIdentityDigest(reviewIdentity)}`;
      this.#assertManagementInvocationNotFailed(invocationId);
      const reviewBudget = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
      if (reviewBudget.modelTokens !== null && reviewBudget.modelTokens <= 0) {
        throw new Error("model-token budget is exhausted; refusing semantic review");
      }
      const reviewModel = resolveModelSelection(this.#policy, "review");
      const metadata = parseGraphItemMetadata(item.body ?? "");
      const stackMember =
        this.#deliverySelection.selected === "native-stacks"
          ? this.#deliveryPlan?.items.find((entry) => entry.itemId === metadata.id)
          : undefined;
      invoke = (reviewCheckpoint) =>
        this.#invokeSemanticReview(
          {
            repository: this.#options.repository,
            objectiveNumber: this.#run.objective,
            workItemNumber: item.number,
            packet,
            artifact,
            evidence: checkpoint.evidence,
            publicationBaseBranch: this.#baseBranch,
            requiresIsolation:
              this.#policy.trust === "sandbox_untrusted" ||
              packet.requirements.trust !== "trusted_local" ||
              Boolean(stackMember?.parentItemId),
            ...(reviewModel ? { modelSelection: reviewModel } : {}),
          },
          reviewCheckpoint,
          invocationId,
          () => this.#admitModelInvocation(invocationId, item.id, reservation),
          (error) =>
            this.#recordProviderQuotaGate(
              error,
              item.id,
              "management",
              this.#management.id,
              reservation,
            ),
        );
    }
    const record = await this.#reviewTransaction({
      existing,
      ...(invoke ? { invoke } : {}),
      persist: (result) =>
        this.#lease.use((lease) =>
          this.#reviews.persist({ lease, identity: reviewIdentity, result }),
        ),
      recover: () => this.#reviews.load(reviewIdentity),
      recordFailureUsage: (usage) =>
        this.#recordManagementUsage(
          `review-${reviewIdentityDigest(reviewIdentity)}`,
          usage,
          item.id,
          reservation,
        ),
      recordProviderGate: (error) =>
        this.#recordProviderQuotaGate(
          error,
          item.id,
          "management",
          this.#management.id,
          reservation,
        ),
      recordUsage: (record) => this.#recordReviewUsage(record, item, reservation),
      recordOutcome: (record) => this.#recordInitialReviewOutcome(record, item, reservation),
    });
    return record.review.accepted;
  }

  #compilationTransaction(args: Parameters<typeof runDurableCompilationTransaction>[0]) {
    return this.#modelInvocations.run(() => runDurableCompilationTransaction(args));
  }

  #hasModelUsageLink(
    events: readonly FactoryEvent[],
    link: { modelInvocationId?: string; directorEpoch?: number; policyDigest?: string },
  ): boolean {
    for (const event of events) {
      if (event.kind !== "budget" || !event.modelInvocationId) continue;
      if (
        event.modelInvocationId !== link.modelInvocationId ||
        event.directorEpoch !== link.directorEpoch ||
        event.policyDigest !== link.policyDigest
      )
        throw new Error("actual model usage conflicts with its original dispatch binding");
    }
    return events.some(
      (event) =>
        event.kind === "budget" &&
        (!link.modelInvocationId || event.modelInvocationId === link.modelInvocationId),
    );
  }

  #modelInvocationLink(
    invocationId: string,
    reservation?: AttemptReservation,
    workItem?: number,
    phase: "management" | "execution" = "management",
  ): { modelInvocationId?: string; directorEpoch?: number; policyDigest?: string } {
    const identity: ModelInvocationIdentity = {
      objective: this.#run.objective,
      runId: this.#run.runId,
      workItem: reservation?.workItem ?? workItem,
      attempt: reservation?.attempt,
      phase,
      modelInvocationId: invocationId,
    };
    const marker = this.#budgetEvents.find(
      (event) =>
        isModelInvocationMarker(event) &&
        modelInvocationKey(event) === modelInvocationKey(identity),
    );
    return marker?.kind === "budget"
      ? {
          modelInvocationId: invocationId,
          ...(marker.directorEpoch !== undefined ? { directorEpoch: marker.directorEpoch } : {}),
          ...(marker.policyDigest ? { policyDigest: marker.policyDigest } : {}),
        }
      : {};
  }

  /** Persist before dispatch. The marker is unknown consumption, not a zero-token estimate. */
  async #admitModelInvocation(
    invocationId: string,
    nodeId: string,
    reservation?: AttemptReservation,
    workItem?: number,
    phase: "management" | "execution" = "management",
  ): Promise<number> {
    return this.#modelInvocations.admit(() =>
      this.#lease.use(async (lease) => {
        const snapshot = await this.#reader.readObjective(this.#run.objective);
        this.#fenceSnapshot(snapshot);
        this.#sequences.observe(snapshotEvents(snapshot));
        if (hasCancellationRequest(snapshot, this.#run.runId)) {
          throw new RunCancellationRequestedError(
            "operator cancelled before model invocation dispatch",
          );
        }
        const objectiveDeadline =
          this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000;
        if (Date.now() >= objectiveDeadline)
          throw new Error("Objective deadline exhausted before model invocation dispatch");
        this.#budgetEvents = deduplicateFactoryEvents([
          ...this.#budgetEvents,
          ...this.#accountingEvents(snapshotEvents(snapshot)),
        ]);
        if (providerQuotaGateState(this.#budgetEvents, this.#run.runId))
          throw new ProviderQuotaDrainIncompleteError();
        assertModelInvocationAdmission(
          this.#budgetEvents,
          this.#policy,
          this.#modelInvocations.active,
        );
        const identity: ModelInvocationIdentity = {
          objective: this.#run.objective,
          runId: this.#run.runId,
          workItem: reservation?.workItem ?? workItem,
          attempt: reservation?.attempt,
          phase,
          modelInvocationId: invocationId,
        };
        const key = modelInvocationKey(identity);
        const matches = (event: FactoryEvent) =>
          isModelInvocationMarker(event) && modelInvocationKey(event) === key;
        if (this.#budgetEvents.some(matches))
          throw new Error(
            "model invocation was already dispatched; refusing replay without exact completion",
          );
        const args = {
          lease,
          sequence: this.#sequences.take(),
          event: "BudgetReserved" as const,
          unit: "model_tokens" as const,
          amount: 0,
          usageId: `invocation-${invocationId}`,
          modelInvocationId: invocationId,
          directorEpoch: reservation?.directorEpoch ?? lease.epoch,
          policyDigest: reservation?.policyDigest ?? policyDigest(this.#policy),
        };
        try {
          const marker = reservation
            ? await this.#recorder.budget({ ...args, reservation, workItemNodeId: nodeId, phase })
            : await this.#recorder.objectiveBudget({
                ...args,
                objectiveNodeId: nodeId,
                ...(workItem !== undefined ? { workItem } : {}),
              });
          this.#budgetEvents.push(marker);
        } catch (error) {
          // Only this still-live dispatch may recover its exact lost write response.
          const fresh = await this.#reader.readObjective(this.#run.objective);
          this.#fenceSnapshot(fresh);
          const recovered = snapshotEvents(fresh).filter(matches);
          const marker = recovered[0];
          if (
            recovered.length !== 1 ||
            marker?.kind !== "budget" ||
            marker.sequence !== args.sequence ||
            marker.policyDigest !== args.policyDigest ||
            marker.directorEpoch !== args.directorEpoch
          )
            throw error;
          this.#sequences.observe(snapshotEvents(fresh));
          this.#budgetEvents.push(...recovered);
        }
        this.#modelInvocations.claim(key);
        await this.#lease.assertGeneration("admission");
        const remainingMs = objectiveDeadline - Date.now();
        if (remainingMs <= 0)
          throw new Error("Objective deadline exhausted after model invocation admission");
        return phase === "management"
          ? Math.min(remainingMs, this.#policy.workItemTimeoutMinutes * 60_000)
          : remainingMs;
      }),
    );
  }

  async #recordManagementUsage(
    invocationId: string,
    usage: ManagementUsage,
    nodeId: string,
    reservation?: AttemptReservation,
    usageId = `failed-${invocationId}`,
  ): Promise<void> {
    const link = this.#modelInvocationLink(invocationId, reservation);
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
    if (this.#hasModelUsageLink(existing, link)) return;
    try {
      const event = await this.#lease.use((lease) => {
        const common = {
          lease,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled" as const,
          unit: "model_tokens" as const,
          amount,
          usageId,
          ...link,
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
      if (!this.#hasModelUsageLink(recovered, link)) throw error;
      this.#sequences.observe(snapshotEvents(snapshot));
      this.#budgetEvents.push(...recovered);
    }
  }

  async #recordProviderQuotaGate(
    error: ProviderQuotaError,
    issueNodeId: string,
    phase: "management" | "execution",
    backend: string,
    reservation?: AttemptReservation,
    workItem?: number,
  ): Promise<void> {
    return this.#modelInvocations.admit(() =>
      this.#recordProviderQuotaGateWithinAdmission(
        error,
        issueNodeId,
        phase,
        backend,
        reservation,
        workItem,
      ),
    );
  }

  async #recordProviderQuotaGateWithinAdmission(
    error: ProviderQuotaError,
    issueNodeId: string,
    phase: "management" | "execution",
    backend: string,
    reservation?: AttemptReservation,
    workItem?: number,
  ): Promise<void> {
    const invocationId = error.invocationId;
    if (!invocationId)
      throw new Error("provider quota failure lacks its admitted invocation identity");
    const marker = this.#budgetEvents.find(
      (event) =>
        isModelInvocationMarker(event) &&
        event.runId === this.#run.runId &&
        event.modelInvocationId === invocationId &&
        event.phase === phase &&
        event.workItem === (reservation?.workItem ?? workItem) &&
        event.attempt === reservation?.attempt,
    );
    if (!marker)
      throw new Error("provider quota failure is not linked to a durable dispatch marker");
    if (typeof marker.directorEpoch !== "number" || typeof marker.policyDigest !== "string")
      throw new Error("provider quota dispatch marker lacks its original writer binding");
    const markerDirectorEpoch = marker.directorEpoch;
    const markerPolicyDigest = marker.policyDigest;
    const snapshot = await this.#reader.readObjective(this.#run.objective);
    this.#fenceSnapshot(snapshot);
    const observedEvents = snapshotEvents(snapshot);
    const matches = observedEvents.filter(
      (event) =>
        event.kind === "provider" &&
        event.event === "ProviderQuotaBlocked" &&
        event.runId === this.#run.runId &&
        event.modelInvocationId === invocationId,
    );
    if (matches.length > 1) throw new Error("provider quota evidence is duplicated");
    const amount = error.usage ? error.usage.inputTokens + error.usage.outputTokens : undefined;
    const usageId = phase === "execution" ? invocationId : `failed-${invocationId}`;
    const usageMatches = observedEvents.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.runId === this.#run.runId &&
        event.phase === phase &&
        event.unit === "model_tokens" &&
        event.modelInvocationId === invocationId &&
        event.workItem === (reservation?.workItem ?? workItem) &&
        event.attempt === reservation?.attempt,
    );
    if (
      usageMatches.some(
        (event) =>
          amount === undefined ||
          event.amount !== amount ||
          event.usageId !== usageId ||
          event.directorEpoch !== markerDirectorEpoch ||
          event.policyDigest !== markerPolicyDigest ||
          JSON.stringify(event.reportedModelUsage) !==
            JSON.stringify(reportedModelUsage(error.usage!)),
      )
    )
      throw new Error("provider quota usage conflicts with its original observation");
    if (matches.length === 1) {
      const existing = matches[0]!;
      if (
        existing.kind !== "provider" ||
        existing.provider !== error.gate.provider ||
        existing.phase !== phase ||
        existing.backend !== backend ||
        existing.workItem !== (reservation?.workItem ?? workItem) ||
        existing.attempt !== reservation?.attempt ||
        existing.providerMessage !== error.gate.message ||
        existing.actionUrl !== error.gate.actionUrl ||
        existing.accounting !== (error.usage ? "exact" : "unknown")
      )
        throw new Error("provider quota evidence conflicts with its original observation");
      if ((existing.accounting === "exact") !== (usageMatches.length === 1))
        throw new Error("provider quota accounting conflicts with its atomic usage receipt");
      return;
    }
    if (usageMatches.length > 0)
      throw new Error("provider quota usage exists without its atomic gate metadata");
    this.#sequences.observe(observedEvents);
    const usageSequence = error.usage ? this.#sequences.take() : undefined;
    const gateSequence = this.#sequences.take();
    try {
      const recorded = await this.#lease.use((lease) =>
        this.#recorder.providerQuotaBlocked({
          lease,
          issueNodeId,
          sequence: gateSequence,
          phase,
          backend,
          modelInvocationId: invocationId,
          provider: error.gate.provider,
          providerMessage: error.gate.message,
          ...(error.gate.actionUrl ? { actionUrl: error.gate.actionUrl } : {}),
          accounting: error.usage ? "exact" : "unknown",
          ...(error.usage
            ? {
                usage: {
                  sequence: usageSequence!,
                  usageId,
                  amount: amount!,
                  reportedModelUsage: reportedModelUsage(error.usage)!,
                  directorEpoch: markerDirectorEpoch,
                  policyDigest: markerPolicyDigest,
                },
              }
            : {}),
          ...(reservation ? { reservation } : {}),
          ...(!reservation && workItem !== undefined ? { workItem } : {}),
        }),
      );
      this.#budgetEvents.push(...recorded.filter((event) => event.kind === "budget"));
    } catch (cause) {
      const recovered = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(recovered);
      const recoveredEvents = snapshotEvents(recovered);
      const recoveredGate = recoveredEvents.filter(
        (event) =>
          event.kind === "provider" &&
          event.event === "ProviderQuotaBlocked" &&
          event.runId === this.#run.runId &&
          event.modelInvocationId === invocationId &&
          event.sequence === gateSequence,
      );
      const recoveredUsage = recoveredEvents.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.runId === this.#run.runId &&
          event.modelInvocationId === invocationId &&
          event.sequence === usageSequence,
      );
      const recoveredGateEvent = recoveredGate[0];
      const recoveredUsageEvent = recoveredUsage[0];
      if (
        recoveredGate.length !== 1 ||
        recoveredGateEvent?.kind !== "provider" ||
        recoveredGateEvent.provider !== error.gate.provider ||
        recoveredGateEvent.phase !== phase ||
        recoveredGateEvent.backend !== backend ||
        recoveredGateEvent.workItem !== (reservation?.workItem ?? workItem) ||
        recoveredGateEvent.attempt !== reservation?.attempt ||
        recoveredGateEvent.providerMessage !== error.gate.message ||
        recoveredGateEvent.actionUrl !== error.gate.actionUrl ||
        recoveredGateEvent.accounting !== (error.usage ? "exact" : "unknown") ||
        (error.usage
          ? recoveredUsage.length !== 1 ||
            recoveredUsageEvent?.kind !== "budget" ||
            recoveredUsageEvent.phase !== phase ||
            recoveredUsageEvent.workItem !== (reservation?.workItem ?? workItem) ||
            recoveredUsageEvent.attempt !== reservation?.attempt ||
            recoveredUsageEvent.unit !== "model_tokens" ||
            recoveredUsageEvent.amount !== amount ||
            recoveredUsageEvent.usageId !== usageId ||
            recoveredUsageEvent.directorEpoch !== markerDirectorEpoch ||
            recoveredUsageEvent.policyDigest !== markerPolicyDigest ||
            JSON.stringify(recoveredUsageEvent.reportedModelUsage) !==
              JSON.stringify(reportedModelUsage(error.usage))
          : recoveredUsage.length !== 0)
      )
        throw cause;
      this.#sequences.observe(recoveredEvents);
      this.#budgetEvents.push(...recoveredUsage);
    }
  }

  async #recordReviewUsage(
    record: ReviewCheckpointRecord,
    item: DerivedWorkItem,
    reservation: AttemptReservation,
  ): Promise<void> {
    const usageId = this.#reviewUsageId(record);
    const link = this.#modelInvocationLink(usageId, reservation);
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
    if (this.#hasModelUsageLink(existing, link)) return;
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
          ...link,
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
      if (!this.#hasModelUsageLink(recovered, link)) throw error;
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

  #validateCompiledGraphStatic(graph: CompiledObjective): void {
    for (const item of graph.workItems) {
      const packet = executionWorkerPacketFromCompiled(item);
      if (
        JSON.stringify(packet.managedRuntimes ?? []) !==
          JSON.stringify(
            managedRuntimeRequirements(packet.validationCommands, packet.repositoryCapabilities),
          ) ||
        (packet.managedRuntimes ?? []).some(({ bundleDigest }) => bundleDigest !== undefined)
      )
        throw new Error(
          `compiled graph managed runtime contract differs from canonical host derivation for ${item.id}: observed ${JSON.stringify(packet.managedRuntimes ?? [])}; expected ${JSON.stringify(managedRuntimeRequirements(packet.validationCommands, packet.repositoryCapabilities))}`,
        );
      for (const requirement of packet.repositoryCapabilities?.requires ?? []) {
        const adapter = toolchainAdapterById(requirement.adapter);
        if (!adapter?.deferredOperations)
          throw new Error(
            `compiled graph requires unsupported deferred repository capability adapter ${requirement.adapter}`,
          );
      }
    }
  }

  async #preflightCompiledGraphRuntime(graph: CompiledObjective): Promise<void> {
    const budgets = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
    for (const item of graph.workItems) {
      const packet = executionWorkerPacketFromCompiled(item);
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
        requiresManagedToolchain: Boolean(packet.managedRuntimes?.length),
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

  async #recoverUndispatchedAdmission(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
  ): Promise<boolean> {
    const entry = (await this.#attempts.ledger.read(item.number))?.history.find(
      (candidate) => candidate.reservation.oid === reservation.oid,
    );
    if (
      !entry ||
      entry.imported ||
      entry.dispatchPossible ||
      ["released", "reconciled"].includes(entry.disposition)
    )
      return false;
    const closed = await this.#lease.use((lease) =>
      this.#attempts.recoverUndispatched({
        lease,
        reservation,
        workItemNodeId: item.id,
        sequence: this.#sequences.take(),
      }),
    );
    if (!closed) return false;
    // The winning issue CAS excludes every delayed original dispatch. No provider
    // or local-scope absence observation is needed, and no model work is replayed.
    const snapshot = await this.#reader.readObjective(reservation.objective);
    const events = snapshotEvents(snapshot).filter(
      (event) =>
        event.runId === reservation.runId &&
        "workItem" in event &&
        event.workItem === reservation.workItem &&
        "attempt" in event &&
        event.attempt === reservation.attempt,
    );
    if (
      events.some(
        (event) =>
          event.kind === "attempt" &&
          ![
            "AttemptReserved",
            "AttemptDeferred",
            "AttemptFailed",
            "AttemptCancelled",
            "AttemptTimedOut",
          ].includes(event.event),
      )
    )
      throw new Error("undispatched admission contradicts authenticated dispatch evidence");
    await this.#lease.use(async (lease) => {
      for (const budget of unreconciledBudgetReservations(events)) {
        if (budget.phase === "management")
          throw new Error("undispatched worker cannot settle unknown management work");
        const reconciled = await this.#recorder.budget({
          lease,
          reservation,
          workItemNodeId: item.id,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled",
          unit: budget.unit,
          phase: budget.phase,
          amount: 0,
          ...(budget.usageId ? { usageId: budget.usageId } : {}),
          ...(budget.modelInvocationId
            ? {
                modelInvocationId: budget.modelInvocationId,
                directorEpoch: reservation.directorEpoch,
                policyDigest: reservation.policyDigest,
              }
            : {}),
          reason: "issue CAS permanently excluded dispatch of this original worker intent",
        });
        this.#budgetEvents.push(reconciled);
      }
      for (const capacity of unreconciledCapacityReservations(events)) {
        await this.#attempts.recordCapacity({
          lease,
          reservation,
          workItemNodeId: item.id,
          sequence: this.#sequences.take(),
          event: "CapacityReconciled",
          phase: capacity.phase,
          backend: capacity.backend,
          requestedCpu: capacity.requestedCpu,
          requestedMemoryMb: capacity.requestedMemoryMb,
          allowRecovery: true,
          reason: "issue CAS closed the original intent before dispatch",
        });
      }
    });
    const capacity = await this.#capacitySnapshot();
    for (const held of capacity.reservations.filter(
      (held) =>
        held.objective === reservation.objective &&
        held.workItem === reservation.workItem &&
        held.attempt === reservation.attempt,
    ))
      await this.#releaseCapacity(held.key);
    await this.#settleIssueAdmission(item, reservation, {
      cleanupConfirmed: true,
      definitiveNonExecution: true,
      modelUsageExpected: false,
    });
    const settled = (await this.#attempts.ledger.read(item.number))?.history.find(
      (candidate) => candidate.reservation.oid === reservation.oid,
    );
    if (settled?.disposition !== "released")
      throw new Error("undispatched admission still has unresolved accounting or capacity");
    return true;
  }

  async #reconcileIssueAdmissionHistory(
    item: DerivedWorkItem,
    lease: LeaseState,
    base: GitCommitObject,
  ): Promise<string | undefined> {
    await this.#attempts.ensureCompatibility(lease, item.number, item.id, base);
    const ledger = await this.#attempts.ledger.read(item.number);
    if (!ledger) return;
    const snapshot = await this.#reader.readObjective(lease.objective);
    const events = snapshotEvents(snapshot);
    for (const entry of ledger.history) {
      if (
        entry.disposition === "released" ||
        entry.runId !== lease.runId ||
        entry.objective !== lease.objective
      )
        continue;
      const reservation = (await this.#attempts.list(entry.objective, item.number)).find(
        (candidate) => candidate.oid === entry.reservation.oid,
      );
      if (!reservation) throw new Error("issue admission original reservation unavailable");
      if (await this.#recoverUndispatchedAdmission(item, reservation)) continue;
      let producerClosed = hasOriginalAdmissionProducerCompletion(entry, events);
      if (!producerClosed && reservation.localScopeBatch) {
        producerClosed =
          (await observeLocalScopeBatch(reservation.localScopeBatch)).status === "absent";
      }
      if (!producerClosed) continue;
      const backend = this.#registry.get(reservation.backend);
      if (!backend?.reconcileStale) continue;
      const resources = new Set(
        events.flatMap((event) =>
          event.kind === "attempt" &&
          event.runId === reservation.runId &&
          event.workItem === reservation.workItem &&
          event.attempt === reservation.attempt &&
          event.providerResourceId
            ? [event.providerResourceId]
            : [],
        ),
      );
      if (resources.size > 1)
        throw new Error("issue admission original resource identity conflicts");
      await backend.reconcileStale({
        repository: `${this.#options.owner}/${this.#options.repo}`,
        objective: reservation.objective,
        workItem: reservation.workItem,
        attempt: reservation.attempt,
        runId: reservation.runId,
        directorEpoch: reservation.directorEpoch,
        policyDigest: reservation.policyDigest,
        phase: "execution",
        ...(reservation.localScopeBatch ? { localScopeBatch: reservation.localScopeBatch } : {}),
        ...(resources.size ? { providerResourceId: [...resources][0]! } : {}),
      });
      await this.#settleIssueAdmission(item, reservation, {
        cleanupConfirmed: true,
        definitiveNonExecution: false,
        modelUsageExpected: backend.capabilities.reportsModelUsage ?? false,
      });
    }
    if (this.#recoveryRuntime) {
      const transfer = await reconcileAdmissionForSuccessor({
        store: this.#store,
        ledger: this.#attempts.ledger,
        runtime: this.#recoveryRuntime,
        lease,
        workItem: item.number,
        workItemNodeId: item.id,
        assertCurrent: () => this.#leases.assertCurrent(lease).then(() => {}),
        assertCapacityReleased: async (entry) => {
          const capacity = await this.#capacitySnapshot();
          if (
            capacity.reservations.some(
              (reservation) =>
                reservation.objective === entry.objective &&
                reservation.workItem === entry.workItem &&
                reservation.attempt === entry.reservation.attempt,
            )
          )
            throw new Error("accepted issue transfer still has reserved capacity");
        },
        modelUsageExpected: (entry) => {
          const backend = this.#registry.get(entry.reservation.backend);
          if (!backend) throw new Error("accepted issue transfer backend is unavailable");
          return backend.capabilities.reportsModelUsage ?? false;
        },
      });
      return transfer?.authorityReceiptOid;
    }
  }

  async #legacyAdmissionBinding(
    reservation: AttemptReservation,
    nodeId: string,
  ): Promise<AttemptAdmissionBinding> {
    const snapshot = await this.#reader.readObjective(reservation.objective);
    const events = snapshotEvents(snapshot);
    const start = events.find(
      (event) =>
        event.kind === "run" &&
        event.event === "FactoryRunStarted" &&
        event.runId === reservation.runId &&
        event.policyDigest === reservation.policyDigest,
    );
    if (!start)
      throw new Error(
        "legacy admission has no authenticated original run; use explicit recovery assessment",
      );
    const adoptedGraph = this.#recoveryRuntime?.accountingRunIds.includes(reservation.runId)
      ? this.#recoveryRuntime
      : undefined;
    const graph =
      (await loadCompiledGraph(this.#store, reservation.objective, reservation.runId)) ??
      adoptedGraph?.graph;
    const projection =
      adoptedGraph?.projection ??
      (graph &&
        (await loadCompiledGraphProjection(
          this.#store,
          reservation.objective,
          reservation.runId,
          graph,
        )));
    if (!graph || !projection)
      throw new Error("legacy admission original graph/projection unavailable");
    assertAuthenticatedGraphProjection(
      events,
      reservation.objective,
      adoptedGraph?.planRecord.plan.graph.sourceRunId ?? reservation.runId,
      projection,
    );
    if (
      !projection.bindings.some(
        (binding) => binding.issueNumber === reservation.workItem && binding.issueNodeId === nodeId,
      )
    )
      throw new Error("legacy admission does not bind this original issue identity");
    const unit = isManagedAgentBackendId(reservation.backend)
      ? "managed_sessions"
      : isSandboxBackendId(reservation.backend)
        ? "sandbox_milliseconds"
        : "local_milliseconds";
    return {
      graphDigest: graph.graphDigest,
      graphCommitOid: graph.commitOid,
      projectionCommitOid: projection.commitOid,
      capacityReservationId: capacityReservationKey({
        objective: reservation.objective,
        workItem: reservation.workItem,
        attempt: reservation.attempt,
        phase: "execution",
        backendId: reservation.backend,
      }),
      budgetReservationId: `${reservation.runId}:${reservation.workItem}:${reservation.attempt}:execution:${unit}:default`,
      resourceIdentity: JSON.stringify([
        reservation.objective,
        reservation.runId,
        reservation.workItem,
        reservation.attempt,
        reservation.backend,
        reservation.directorEpoch,
        reservation.policyDigest,
        reservation.managedRuntimeActivation?.digest ?? null,
      ]),
      ...(reservation.managedRuntimeActivation
        ? { managedRuntimeActivation: reservation.managedRuntimeActivation }
        : {}),
    };
  }

  /** Called only after the owning execution/reconciler has positively stopped its exact producer.
   * Read current authenticated receipts independently; failure retains the issue liability. */
  async #settleIssueAdmission(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    proof: {
      cleanupConfirmed: boolean;
      definitiveNonExecution: boolean;
      modelUsageExpected: boolean;
      retainedUnknownModelInvocationId?: string;
      artifactConsumer?: {
        sourceRunId: string;
        sourceReservationOid: string;
        sourceAttempt: number;
        artifactDigest: string;
      };
    },
  ): Promise<void> {
    if (!proof.cleanupConfirmed) return;
    const record = await this.#attempts.ledger.read(item.number);
    const entry = record?.history.find((entry) => entry.reservation.oid === reservation.oid);
    if (!entry || entry.disposition === "released") return;
    const snapshot = await this.#reader.readObjective(reservation.objective);
    const events = snapshotEvents(snapshot);
    const capacity = await this.#capacitySnapshot();
    if (
      capacity.reservations.some(
        (claim) =>
          claim.objective === reservation.objective &&
          claim.workItem === reservation.workItem &&
          claim.attempt === reservation.attempt,
      )
    )
      return;
    // The immutable evidence commit records what this exact producer observed. It is reachable
    // through the ledger transition, and is not a reconstructed zero-usage claim.
    const base = await this.#store.readCommit(reservation.baseSha);
    await this.#lease.use(async (lease) => {
      if (lease.runId !== reservation.runId || lease.objective !== reservation.objective) return;
      const payload = {
        protocol: "clockgrove.factory/admission-settlement-v1",
        reservationOid: reservation.oid,
        resourceIdentity: entry.resourceIdentity,
        capacityReservationId: entry.capacityReservationId,
        budgetReservationId: entry.budgetReservationId,
        writerHolder: lease.holder,
        writerEpoch: lease.epoch,
        definitiveNonExecution: proof.definitiveNonExecution,
        ...(proof.retainedUnknownModelInvocationId
          ? { retainedUnknownModelInvocationId: proof.retainedUnknownModelInvocationId }
          : {}),
        ...(proof.artifactConsumer ? { artifactConsumer: proof.artifactConsumer } : {}),
        producerStopped: true,
        resourcesReleased: true,
        capacityReleased: true,
        events: events.filter(
          (event) =>
            event.runId === reservation.runId &&
            "workItem" in event &&
            event.workItem === reservation.workItem &&
            "attempt" in event &&
            event.attempt === reservation.attempt,
        ),
      };
      // Validate before recording: incomplete accounting is expected during held recovery.
      const input = {
        entry,
        events,
        modelUsageExpected: proof.modelUsageExpected,
        ...(proof.retainedUnknownModelInvocationId
          ? { retainedUnknownModelInvocationId: proof.retainedUnknownModelInvocationId }
          : {}),
        authority: snapshot.objectiveAuthority,
        cleanup: {
          reservationOid: reservation.oid,
          resourceIdentity: entry.resourceIdentity,
          producerStopped: true as const,
          resourcesReleased: true as const,
          evidenceOid: base.oid,
        },
        capacity: {
          reservationOid: reservation.oid,
          capacityReservationId: entry.capacityReservationId,
          released: true as const,
        },
        ...(proof.definitiveNonExecution
          ? {
              definitiveNonExecution: {
                reservationOid: reservation.oid,
                evidenceOid: base.oid,
                dispatchPrevented: true as const,
              },
            }
          : {}),
        ...(proof.artifactConsumer && entry.artifactConsumer
          ? {
              definitiveArtifactConsumer: {
                reservationOid: reservation.oid,
                evidenceOid: base.oid,
                dispatchPrevented: true as const,
                sourceRunId: proof.artifactConsumer.sourceRunId,
                sourceReservationOid: proof.artifactConsumer.sourceReservationOid,
                sourceAttempt: proof.artifactConsumer.sourceAttempt,
                artifactDigest: proof.artifactConsumer.artifactDigest,
                recoveryPlanCommitOid: entry.artifactConsumer.recoveryPlanCommitOid,
                recoveryClaimOid: entry.artifactConsumer.recoveryClaimOid,
              },
            }
          : {}),
      };
      let evidence;
      try {
        evidence = buildAdmissionSettlementEvidence(input);
      } catch {
        return;
      }
      const evidenceOid = await this.#store.createCommit({
        treeOid: base.treeOid,
        parentOids: [record!.oid],
        message: `Factory exact admission settlement\n\nFactory-Admission-Settlement: ${Buffer.from(JSON.stringify(payload)).toString("base64url")}`,
      });
      await this.#attempts.settle(lease, reservation, { ...evidence, evidenceOid });
    });
  }

  /** A retained-artifact consumer never owns execution capacity or model work.
   * Settle its exact issue CAS immediately after durable success, before validation,
   * and retry bounded snapshot lag rather than leaving a hidden occupied identity. */
  async #settleArtifactConsumerAdmission(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    adopted: NonNullable<CollectedAttemptContinuation["adoptedSource"]>,
  ): Promise<void> {
    for (let observation = 0; observation < 3; observation++) {
      await this.#settleIssueAdmission(item, reservation, {
        cleanupConfirmed: true,
        definitiveNonExecution: false,
        modelUsageExpected: false,
        artifactConsumer: {
          sourceRunId: adopted.reservation.runId,
          sourceReservationOid: adopted.reservation.oid,
          sourceAttempt: adopted.reservation.attempt,
          artifactDigest: adopted.artifactDigest,
        },
      });
      const entry = (await this.#attempts.ledger.read(item.number))?.history.find(
        (candidate) => candidate.reservation.oid === reservation.oid,
      );
      if (entry?.disposition === "released") return;
      if (observation < 2) await sleep(this.#options.pollIntervalMs ?? 2_000);
    }
    throw new ArtifactCompletionUnavailableError();
  }

  #packetFor(workItem: number): WorkerPacket {
    const packet = this.#durablePackets.get(workItem);
    if (!packet) {
      throw new Error(`Work Item #${workItem} has no immutable compiled Worker Packet`);
    }
    return packet;
  }

  /** Reconstruct the exact Worker Packet admitted by a durable reservation,
   * then carry that reservation's immutable runtime selection onto a later
   * validation base. The activation packet digest chooses between the only
   * host-authorized trust variants; no active toolchain pointer is consulted. */
  #packetBoundToReservation(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    baseSha = reservation.baseSha,
    trust?: WorkerPacket["requirements"]["trust"],
  ): WorkerPacket {
    const original = this.#packetFor(item.number);
    const context = retryContext(item, reservation.runId);
    const trusts = [
      original.requirements.trust,
      ...(original.requirements.trust === "trusted_local" ? (["isolated"] as const) : []),
    ];
    let failure: unknown;
    for (const candidateTrust of trusts) {
      const graphPacket = parseWorkerPacket({
        ...original,
        baseSha: reservation.baseSha,
        ...(context ? { retryContext: context } : {}),
        requirements: { ...original.requirements, trust: candidateTrust },
      });
      try {
        const admitted = packetWithManagedRuntimeActivation(
          graphPacket,
          reservation.managedRuntimeActivation,
        );
        if (
          reservation.localScopeBatch &&
          reservation.localScopeBatch.identity.invocationDigest !== workerPacketDigest(admitted)
        )
          continue;
        return parseWorkerPacket({
          ...admitted,
          baseSha,
          ...(trust ? { requirements: { ...admitted.requirements, trust } } : {}),
        });
      } catch (error) {
        failure = error;
      }
    }
    throw new Error("durable reservation differs from its exact activated Worker Packet", {
      cause: failure,
    });
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
    if (
      runtime &&
      planned?.source &&
      planned.action !== "execute" &&
      planned.action !== "reconcile"
    ) {
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
      const plan =
        this.#deliveryPlan?.items.find((entry) => entry.itemId === planned.compilerId) ??
        (this.#deliverySelection.selected === "regular-prs" && publication.mode === "regular-prs"
          ? { unitId: `delivery/${planned.compilerId}`, position: 0, parentItemId: undefined }
          : undefined);
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
          mode: publication.mode,
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
    const metadata = parseGraphItemMetadata(item.body ?? "");
    const plan =
      this.#deliveryPlan?.items.find((candidate) => candidate.itemId === metadata.id) ??
      (this.#deliverySelection.selected === "regular-prs"
        ? {
            itemId: metadata.id,
            unitId: `delivery/${metadata.id}`,
            position: 0,
            waitsForMerge: [] as string[],
            parentItemId: undefined,
          }
        : undefined);
    if (!plan) throw new Error(`Work Item ${metadata.id} is absent from the delivery plan`);
    const sibling =
      this.#deliverySelection.selected === "regular-prs" ||
      this.#deliveryPlan?.units.find((unit) => unit.id === plan.unitId)?.kind === "sibling";
    const recordedPublications = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .filter(
        (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
          event.kind === "publication" &&
          event.runId === this.#run.runId &&
          event.workItem === item.number &&
          event.event === "PublicationRecorded",
      );
    const latestPublication = recordedPublications[0];
    const recordedPublication = selectEquivalentPublicationRecord(
      recordedPublications.filter(
        (event) =>
          event.attempt === latestPublication?.attempt &&
          (sibling || event.headSha === latestPublication.headSha),
      ),
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
    if (this.#deliverySelection.selected === "regular-prs") {
      // Regular publications now share sibling integration/recovery. Preserve
      // the ordinary path's original acceptance proof before repairing any
      // publication/integration receipt, even if a concurrent merge changes the
      // mutable PR state after this observation. Never review merged work anew.
      const accepted = (item.factoryEvents ?? []).some(
        (event) =>
          event.kind === "attempt" &&
          event.event === "AttemptValidated" &&
          event.runId === reservation.runId &&
          event.workItem === item.number &&
          event.attempt === reservation.attempt &&
          event.policyDigest === reservation.policyDigest &&
          event.artifactDigest === publishedEvent.artifactDigest &&
          event.sequence > validation.sequence &&
          event.sequence < publishedEvent.sequence,
      );
      const review = publishedEvent.artifactDigest
        ? await this.#reviews.load({
            kind: "artifact",
            runId: reservation.runId,
            objective: reservation.objective,
            workItem: item.number,
            attempt: reservation.attempt,
            artifactDigest: publishedEvent.artifactDigest,
            baseSha: validation.baseSha,
            outputTreeSha: validation.outputTreeSha,
            evidenceDigest: validation.evidenceDigest,
          })
        : null;
      if (!accepted || !review?.review.accepted || review.review.unmetCriteria.length)
        throw new Error("completed ordinary integration lacks its original acceptance checkpoint");
    }
    let publicationEvent = recordedPublication ?? undefined;
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
      mode: this.#deliverySelection.selected === "native-stacks" ? "native-stacks" : "regular-prs",
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
      // The owning worker may have finished its publication while another unit
      // awaited checks. Re-read before repairing the older loop snapshot.
      const fresh = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(fresh);
      this.#sequences.observe(snapshotEvents(fresh));
      const current = fresh.workItems.find((value) => value.number === item.number);
      if (!current || current.id !== item.id)
        throw new Error("publication recovery Work Item identity changed");
      const records = (current.factoryEvents ?? []).filter(
        (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
          event.kind === "publication" &&
          event.event === "PublicationRecorded" &&
          event.runId === this.#run.runId &&
          event.workItem === item.number &&
          event.attempt === publishedEvent.attempt,
      );
      publicationEvent = selectEquivalentPublicationRecord(records) ?? undefined;
      item.factoryEvents = current.factoryEvents ?? [];
      if (!publicationEvent) {
        const recorded = await this.#lease.use((lease) =>
          this.#recorder.publication({
            lease,
            workItemNodeId: item.id,
            sequence: this.#sequences.take(),
            receipt,
            event: "PublicationRecorded",
            reason: "recovered publication receipt",
          }),
        );
        item.factoryEvents = [...(item.factoryEvents ?? []), recorded];
      }
    }
    if (publicationEvent) {
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
    return withArtifactContentScope(() =>
      this.#integrateNativeStackWithArtifactContent(unitId, items, deadline),
    );
  }

  async #integrateNativeStackWithArtifactContent(
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
    const pendingEvents = [...(targetItem.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .filter(
        (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
          event.kind === "publication" &&
          event.runId === this.#run.runId &&
          event.event === "IntegrationPending" &&
          event.operationId === operationId &&
          event.headSha === target.receipt.headSha,
      );
    for (const event of pendingEvents) assertPublicationEventMatchesReceipt(event, target.receipt);
    if (
      new Set(pendingEvents.map((event) => event.asynchronousMergeUuid ?? "unknown-dispatch"))
        .size > 1
    )
      throw new Error("native integration has conflicting outstanding request identities");
    const pendingEvent = pendingEvents[0];
    const integratingMembers =
      mergePolicy === "atomic-stack"
        ? members.filter((member) =>
            remaining.some((item) => item.number === member.receipt.workItem),
          )
        : [target];
    try {
      const controller = this.#lease;
      const capturedOwner = await controller.use(async (lease) => ({
        epoch: lease.epoch,
        fence: controller.captureMutationFence(),
      }));
      return await withIntegrationAdmission(
        this.#store,
        {
          repository: `${this.#options.owner}/${this.#options.repo}`,
          branch: this.#baseBranch,
          objective: this.#run.objective,
          runId: this.#run.runId,
          epoch: capturedOwner.epoch,
          pullRequest: target.pull.number,
          headSha: target.pull.commitSha,
          baseSha: integratingMembers[0]!.receipt.baseSha,
          outputTreeSha: target.pull.exactHeadValidation.outputTreeSha,
          members: integratingMembers.map((member) => ({
            pullRequest: member.pull.number,
            headSha: member.pull.commitSha,
            outputTreeSha: member.pull.exactHeadValidation.outputTreeSha,
          })),
        },
        () => capturedOwner.fence(0),
        async (admission) => {
          let result = await this.#serializeIntegration(async () => {
            const recoveryUuid =
              admission.dispatch?.kind === "native"
                ? admission.dispatch.asynchronousMergeUuid
                : undefined;
            if (admission.dispatch && !recoveryUuid)
              throw new IntegrationAdmissionPendingError(this.#run.objective, target.pull.number);
            // A request already crossed the mechanical boundary. Reconcile only
            // that UUID; changed readiness cannot unsend it and must not trigger
            // a second request.
            if (recoveryUuid) {
              return this.#stacks.mergeResult(
                target.pull.number,
                recoveryUuid,
                target.pull.commitSha,
              );
            }
            if (
              (await this.#store.getBranchHead(this.#baseBranch)).oid !==
              integratingMembers[0]!.receipt.baseSha
            )
              throw new Error("native integration base advanced before dispatch");
            for (const member of integratingMembers) {
              const current = await integrationReadiness(
                this.#store,
                member.pull,
                member.receipt.baseSha,
                undefined,
                { ciExpected: this.#ciExpectedOnPullRequests },
              );
              if (current.state !== "ready")
                throw new Error("native integration readiness changed before dispatch");
            }
            await admission.markDispatched("native");
            const result = await this.#stacks.requestMerge({
              pullRequest: target.pull.number,
              expectedHeadSha: target.pull.commitSha,
              title: target.receipt.itemId,
              action: "default",
            });
            if (result.state === "pending") await admission.bindAsynchronousMerge(result.uuid);
            return result;
          });
          if (
            result.state === "pending" &&
            (admission.dispatch?.kind !== "native" ||
              admission.dispatch.asynchronousMergeUuid !== result.uuid)
          ) {
            throw new Error("native integration poll changed the exact request UUID");
          }
          if (result.state === "failed") {
            const uuid =
              admission.dispatch?.kind === "native"
                ? admission.dispatch.asynchronousMergeUuid
                : undefined;
            await admission.authoritativeNonExecution(
              uuid
                ? {
                    kind: "native-terminal-failure",
                    asynchronousMergeUuid: uuid,
                    reason: result.reason,
                  }
                : { kind: "native-request-rejection", reason: result.reason },
            );
            throw new Error(result.reason);
          }
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
              const uuid =
                admission.dispatch?.kind === "native"
                  ? admission.dispatch.asynchronousMergeUuid
                  : undefined;
              if (!uuid) throw new Error("native integration poll lacks its exact request UUID");
              result = await this.#stacks.mergeResult(
                target.pull.number,
                uuid,
                target.pull.commitSha,
              );
              if (result.state === "pending" && result.uuid !== uuid) {
                throw new Error("native integration poll changed the exact request UUID");
              }
            } else {
              const current = await this.#store.readPullRequest(target.pull.number);
              if (current.headSha !== target.pull.commitSha) {
                throw new Error("merge-queue target head changed after validation");
              }
              if (current.merged && current.mergeCommitSha) {
                result = { state: "merged", mergeSha: current.mergeCommitSha };
              }
            }
            if (result.state === "failed") {
              const uuid =
                admission.dispatch?.kind === "native"
                  ? admission.dispatch.asynchronousMergeUuid
                  : undefined;
              if (!uuid) throw new Error("native terminal failure lacks its request UUID");
              await admission.authoritativeNonExecution({
                kind: "native-terminal-failure",
                asynchronousMergeUuid: uuid,
                reason: result.reason,
              });
              throw new Error(result.reason);
            }
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
        },
        pendingEvent?.asynchronousMergeUuid
          ? { recoverNativeRequestUuid: pendingEvent.asynchronousMergeUuid }
          : {},
      );
    } catch (error) {
      if (error instanceof IntegrationAdmissionPendingError)
        return this.#deferIntegration(targetItem.number, error.message);
      throw error;
    }
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
            publicationBaseBranch: this.#baseBranch,
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
          if (!capacityRecorded || record || !providerStarted) this.#releaseCapacity(capacity.key);
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
    const originalPacket = this.#packetBoundToReservation(item, member.reservation);
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
    const priorNative = isolated
      ? await this.#nativeRebases.load({
          repository: `${this.#options.owner}/${this.#options.repo}`,
          runId: member.reservation.runId,
          objective: member.reservation.objective,
          workItem: item.number,
          attempt: member.reservation.attempt,
          directorEpoch: member.reservation.directorEpoch,
          policyDigest: member.reservation.policyDigest,
          pullRequest: member.pull.number,
          sourceHeadSha: member.pull.commitSha,
          sourceExactHeadValidationDigest: member.pull.exactHeadValidation.digest,
          headSha,
          baseSha,
        })
      : null;
    const artifact = this.#retainArtifactContent(
      await artifactFromGitRange({
        repository: this.#options.repository,
        sourceBaseSha: baseSha,
        headSha,
        baseSha,
        changedPaths,
        emptyReason: "rebased stack layer has no diff",
        authenticatedLegacyDigest: priorNative?.validation.artifactDigest,
      }),
    );
    const packet = this.#packetBoundToReservation(item, member.reservation, baseSha);
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
      const resource = await this.#resourceSampler.sample(Date.now()).catch(() => null);
      if (
        !resource ||
        resourcePressureReasons(resource, scheduling.capacity.local).length ||
        this.#resourceSampler.coolingDown(Date.now()) ||
        !localMemoryFits(resource, capacity.memoryMb, scheduling.capacity.local.minimumFreeMemoryMb)
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
            publicationBaseBranch: this.#baseBranch,
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
        if (!capacityRecorded) this.#releaseCapacity(capacity.key);
        throw error;
      }
      const releaseCapacity = () => this.#releaseCapacity(capacity.key);
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
          this.#invokeSemanticReview(
            {
              repository: this.#options.repository,
              objectiveNumber: this.#run.objective,
              workItemNumber: item.number,
              packet,
              artifact,
              evidence: validation.evidence,
              publicationBaseBranch: this.#baseBranch,
              requiresIsolation: isolated || this.#policy.trust === "sandbox_untrusted",
              ...(reviewModel ? { modelSelection: reviewModel } : {}),
            },
            checkpoint,
            `rebase-review-${reviewIdentityDigest(reviewIdentity)}`,
            () =>
              this.#admitModelInvocation(
                `rebase-review-${reviewIdentityDigest(reviewIdentity)}`,
                item.id,
                member.reservation,
              ),
            (error) =>
              this.#recordProviderQuotaGate(
                error,
                item.id,
                "management",
                this.#management.id,
                member.reservation,
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
      await this.#reviewTransaction({
        existing: existingReview,
        ...(invokeReview ? { invoke: invokeReview } : {}),
        persist: (result) =>
          this.#lease.use((lease) =>
            this.#reviews.persist({ lease, identity: reviewIdentity, result }),
          ),
        recover: () => this.#reviews.load(reviewIdentity),
        recordUsage: (record) => this.#recordReviewUsage(record, item, member.reservation),
        recordFailureUsage: (usage) =>
          this.#recordManagementUsage(
            `rebase-review-${reviewIdentityDigest(reviewIdentity)}`,
            usage,
            item.id,
            member.reservation,
          ),
        recordProviderGate: (error) =>
          this.#recordProviderQuotaGate(
            error,
            item.id,
            "management",
            this.#management.id,
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
    deliveryHeadSha?: string,
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
      ...(deliveryHeadSha ? { deliveryHeadSha } : {}),
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
      headSha: record.identity.deliveryHeadSha ?? record.identity.sourceHeadSha,
    };
  }

  async #siblingRefreshIdentity(
    item: Pick<DerivedWorkItem, "number" | "factoryEvents">,
    member: Pick<NativeStackMember, "reservation" | "pull">,
    targetBaseSha: string,
    run = this.#run,
  ): Promise<SiblingRefreshIdentity> {
    const ownRecovery =
      run.runId === this.#run?.runId && run.objective === this.#run?.objective
        ? this.#recoveryRuntime
        : undefined;
    const publications = deduplicateFactoryEvents([
      ...(ownRecovery?.events ?? item.factoryEvents ?? []),
    ]).filter(
      (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
        event.kind === "publication" &&
        event.event === "PublicationRecorded" &&
        event.runId === member.reservation.runId &&
        event.workItem === item.number &&
        event.attempt === member.reservation.attempt,
    );
    const publication = selectEquivalentPublicationRecord(publications);
    const restored = ownRecovery?.sourcePublications.find(
      (proof) =>
        proof.publication.workItem === item.number &&
        proof.publication.sourceRunId === member.reservation.runId &&
        proof.publication.sourceAttempt === member.reservation.attempt &&
        proof.publication.sourceHeadSha === member.pull.commitSha,
    );
    if (!publication && !restored)
      throw new Error("sibling refresh lacks an authenticated original publication");
    if (
      publication &&
      (publication.headSha !== member.pull.commitSha ||
        publication.pullRequest !== member.pull.number ||
        publication.validationDigest !== member.pull.exactHeadValidation.validationDigest ||
        publication.exactHeadValidationDigest !== member.pull.exactHeadValidation.digest ||
        publication.branch !== member.pull.branch ||
        publication.objective !== run.objective)
    )
      throw new Error("sibling refresh original publication binding changed");
    const pull = await this.#store.readPullRequest(member.pull.number);
    if (
      !pull.nodeId ||
      pull.number !== member.pull.number ||
      pull.headRef !== member.pull.branch ||
      pull.baseRepository?.toLowerCase() !==
        `${this.#options.owner}/${this.#options.repo}`.toLowerCase() ||
      pull.headRepository?.toLowerCase() !==
        `${this.#options.owner}/${this.#options.repo}`.toLowerCase()
    )
      throw new Error("sibling refresh repository or PR identity changed");
    const identity: SiblingRefreshIdentity = {
      repository: `${this.#options.owner}/${this.#options.repo}`,
      runId: run.runId,
      sourceRunId: member.reservation.runId,
      objective: run.objective,
      workItem: item.number,
      attempt: member.reservation.attempt,
      pullRequest: member.pull.number,
      pullRequestNodeId: pull.nodeId,
      branch: member.pull.branch,
      reservationRef: member.reservation.ref,
      reservationOid: member.reservation.oid,
      leaseEpoch: member.reservation.directorEpoch,
      policyDigest: member.reservation.policyDigest,
      controllingPolicyDigest: run.policyDigest,
      sourcePublicationDigest: recoveryEventDigest(publication ?? restored!.publication),
      sourceHeadSha: member.pull.commitSha,
      sourceExactHeadValidationDigest: member.pull.exactHeadValidation.digest,
      targetBaseSha,
    };
    // A late-arriving equivalent envelope cannot change an already pinned ref.
    // Probe only this bounded equivalence class, never guess another head/target.
    if (publications.length > 1) {
      const existing: SiblingRefreshRecord[] = [];
      for (const event of publications) {
        const record = await this.#siblingRefreshes.load({
          ...identity,
          sourcePublicationDigest: recoveryEventDigest(event),
        });
        if (record && !existing.some((prior) => prior.ref === record.ref)) existing.push(record);
      }
      if (existing.length > 1)
        throw new Error("equivalent publications have conflicting refresh intents");
      if (existing[0]) return existing[0].identity;
    }
    return identity;
  }

  async #observedSiblingRefresh(
    item: Pick<DerivedWorkItem, "number" | "factoryEvents">,
    member: Pick<NativeStackMember, "reservation" | "pull">,
    headSha: string,
    run = this.#run,
  ): Promise<SiblingRefreshRecord | null> {
    if (headSha === member.pull.commitSha) return null;
    const runtime = this.#recoveryRuntime;
    if (runtime && member.reservation.runId !== run.runId) {
      const source = runtime.planRecord.plan.items.find(
        (entry) => entry.workItem === item.number,
      )?.source;
      const restored = runtime.sourcePublications.find(
        (proof) => proof.publication.workItem === item.number,
      );
      const publication =
        source?.publication ??
        (restored
          ? recoverySourcePublicationBinding(
              restored.publication,
              runtime.planRecord.plan.repository,
            )
          : null);
      if (!source || !publication)
        throw new Error("refreshed adopted source publication is unavailable");
      return (
        await observeRecoverySiblingRefresh({
          repository: runtime.planRecord.plan.repository,
          objective: runtime.planRecord.plan.objective,
          workItem: item.number,
          source: { ...source, publication },
          events: runtime.events,
          controllingRunIds: [
            ...runtime.planRecord.plan.history.map((entry) => entry.runId),
            runtime.controllingRun.runId,
          ],
          store: this.#recoveryStore,
          deliveryHeadSha: headSha,
          requireCompletion: false,
          authority: runtime.objectiveAuthority,
        })
      ).record;
    }
    const head = await this.#store.readCommit(headSha);
    if (head.oid !== headSha || head.parentOids.length !== 2)
      throw new Error("changed sibling head has no exact two-parent refresh lineage");
    const identity = await this.#siblingRefreshIdentity(item, member, head.parentOids[1]!, run);
    const record = await this.#siblingRefreshes.load(identity);
    if (!record || record.plannedHeadSha !== headSha)
      throw new Error("changed sibling head is not this run's immutable planned refresh");
    await loadSiblingRefreshLineage(this.#store, record);
    await verifyPlannedSiblingRefreshCommit(this.#store, record);
    return record;
  }

  async #siblingArtifact(
    member: NativeStackMember,
    targetBaseSha: string,
  ): Promise<NormalizedArtifact> {
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
    return this.#retainArtifactContent(
      await artifactFromGitRange({
        repository: this.#options.repository,
        sourceBaseSha: source[0]!,
        headSha: source[1]!,
        baseSha: targetBaseSha,
        changedPaths,
      }),
    );
  }

  async #assertSiblingRefreshCurrent(
    member: Pick<NativeStackMember, "reservation" | "pull">,
    record: SiblingRefreshRecord,
    merged = false,
  ): Promise<void> {
    const pull = await this.#store.readPullRequest(member.pull.number);
    if (
      pull.number !== record.identity.pullRequest ||
      pull.nodeId !== record.identity.pullRequestNodeId ||
      pull.headRef !== record.identity.branch ||
      pull.baseRef !== this.#baseBranch ||
      pull.draft ||
      (!merged && (pull.merged || pull.state !== "open")) ||
      pull.headRepository?.toLowerCase() !== record.identity.repository.toLowerCase() ||
      pull.baseRepository?.toLowerCase() !== record.identity.repository.toLowerCase()
    )
      throw new Error("sibling refresh current PR no longer matches its immutable intent");
    if (pull.headSha !== record.plannedHeadSha) {
      if (
        !pull.merged &&
        pull.headSha === record.expectedOldHeadSha &&
        (await this.#store.readRef(`refs/heads/${record.identity.branch}`)) ===
          record.plannedHeadSha
      )
        throw new SiblingRefreshObservationPendingError(
          "waiting for GitHub PR metadata to observe the exact refreshed head",
        );
      throw new Error("sibling refresh current PR head differs from its immutable intent");
    }
    if (!pull.merged) {
      if (
        (await this.#store.readRef(`refs/heads/${record.identity.branch}`)) !==
        record.plannedHeadSha
      )
        throw new Error("sibling refresh branch changed before validation");
      await this.#assertRefreshTarget(record.identity.targetBaseSha, member.reservation.workItem);
    }
    await verifyPlannedSiblingRefreshCommit(this.#store, record);
  }

  async #assertRefreshTarget(targetBaseSha: string, workItem: number): Promise<void> {
    const current = (await this.#store.getBranchHead(this.#baseBranch)).oid;
    if (current === targetBaseSha) return;
    await this.#assertOwnTrunkAdvance(targetBaseSha, current, workItem);
    throw new SiblingRefreshTargetAdvancedError(
      "another evidenced sibling advanced the refresh target",
    );
  }

  /** A write-ahead two-parent commit is a proposed head, never a validation receipt. */
  async #prepareSiblingRefresh(
    item: DerivedWorkItem,
    member: NativeStackMember,
    targetBaseSha: string,
    merged: boolean,
  ): Promise<SiblingRefreshRecord> {
    if (
      isManagedAgentBackendId(member.reservation.backend) ||
      (member.receipt.mode === "regular-prs" &&
        (member.pull.branch !==
          publicationBranch(this.#run.objective, item.number, member.reservation.attempt) ||
          member.receipt.position !== 0 ||
          member.receipt.parentItemId ||
          member.receipt.stackNumber))
    )
      throw new Error("sibling refresh requires an exact Factory-owned publication branch");
    const { snapshot, requiresIsolation } = await this.#assertOwnTrunkAdvance(
      member.pull.exactHeadValidation.baseSha,
      targetBaseSha,
      item.number,
    );
    const assertAdmission = () => {
      this.#options.signal?.throwIfAborted();
      if (
        Date.now() >=
        this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000
      )
        throw new Error("Objective timeout exhausted before sibling refresh");
      if (hasCancellationRequest(snapshot, this.#run.runId))
        throw new RunCancellationRequestedError("operator cancelled before sibling refresh");
    };
    assertAdmission();
    const identity = await this.#siblingRefreshIdentity(item, member, targetBaseSha);
    let record = await this.#siblingRefreshes.load(identity);
    const observed = await this.#store.readPullRequest(member.pull.number);
    const previous = await this.#observedSiblingRefresh(item, member, observed.headSha);
    if (previous?.identity.targetBaseSha === targetBaseSha) {
      if (record && previous.commitOid !== record.commitOid)
        throw new Error("sibling refresh intent conflicts with observed head");
      return previous;
    }
    if (merged) throw new Error("merged sibling lacks its pre-merge refresh intent");
    if (!record) {
      if (
        (requiresIsolation ||
          this.#packetFor(item.number).requirements.trust !== "trusted_local" ||
          !this.#registry.get(member.reservation.backend)?.capabilities.hostExecution) &&
        !this.#policy.allowedPaidBackends.includes("codex-cli/daytona")
      )
        throw new Error(
          "sibling refresh requires explicitly authorized independent isolated validation",
        );
      this.#budgetEvents = deduplicateFactoryEvents([
        ...this.#budgetEvents,
        ...snapshotEvents(snapshot).filter((event) => event.runId === this.#run.runId),
      ]);
      const budget = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
      if (budget.modelTokens !== null && budget.modelTokens <= 0)
        throw new Error("model-token budget exhausted before sibling refresh");
      const artifact = await this.#siblingArtifact(member, targetBaseSha);
      const packet = this.#packetBoundToReservation(item, member.reservation, targetBaseSha);
      const outputTreeSha = await prepareSiblingRefreshTree({
        repository: this.#options.repository,
        artifact,
        packet,
        store: this.#store,
        assertCurrent: () => this.#externalAdmission(async () => {}),
      });
      record = await this.#lease.use((lease) =>
        this.#siblingRefreshes.persist({
          lease,
          identity,
          source: member.pull.exactHeadValidation,
          expectedOldHeadSha: observed.headSha,
          outputTreeSha,
          ...(previous
            ? {
                previous: {
                  ref: previous.ref,
                  commitOid: previous.commitOid,
                  identityDigest: previous.identityDigest,
                },
              }
            : {}),
        }),
      );
    }
    const pinned = record;
    await this.#serializeIntegration(() =>
      this.#externalAdmission(async () => {
        assertAdmission();
        const { snapshot } = await this.#assertOwnTrunkAdvance(
          member.pull.exactHeadValidation.baseSha,
          targetBaseSha,
          item.number,
        );
        if (hasCancellationRequest(snapshot, this.#run.runId))
          throw new RunCancellationRequestedError("operator cancelled before sibling refresh");
        const current = await this.#store.readPullRequest(member.pull.number);
        if (
          current.nodeId !== identity.pullRequestNodeId ||
          current.headRef !== identity.branch ||
          current.baseRef !== this.#baseBranch ||
          current.draft ||
          current.merged ||
          current.state !== "open" ||
          current.headRepository?.toLowerCase() !== identity.repository.toLowerCase() ||
          current.baseRepository?.toLowerCase() !== identity.repository.toLowerCase()
        )
          throw new Error("sibling refresh PR or target changed before branch CAS");
        await this.#assertRefreshTarget(targetBaseSha, item.number);
        const branchHead = await this.#store.readRef(`refs/heads/${identity.branch}`);
        if (branchHead === pinned.plannedHeadSha && current.headSha === pinned.expectedOldHeadSha)
          throw new SiblingRefreshObservationPendingError(
            "waiting for GitHub PR metadata to observe the exact refreshed head",
          );
        if (
          current.headSha !== branchHead ||
          (branchHead !== pinned.expectedOldHeadSha && branchHead !== pinned.plannedHeadSha)
        )
          throw new Error("sibling refresh branch contains an unauthorized third head");
        const rules = await this.#store.readBranchRules(this.#baseBranch);
        if (branchRuleBlockers(rules).length)
          throw new Error("branch policy blocks sibling refresh");
        if (branchHead === pinned.expectedOldHeadSha) {
          await this.#lease.use(async () => {
            if (
              !(await this.#store.compareAndSwapRef({
                ref: `refs/heads/${identity.branch}`,
                beforeOid: pinned.expectedOldHeadSha,
                afterOid: pinned.plannedHeadSha,
              }))
            )
              throw new Error("sibling refresh exact branch CAS lost ownership");
          });
        }
        await this.#assertSiblingRefreshCurrent(member, pinned);
      }),
    );
    return pinned;
  }

  async #observedPeerBaseAdvance(
    snapshot: Snapshot,
    source: string,
    target: string,
  ): Promise<boolean> {
    const seen = new Set<string>();
    let cursor = target;
    while (cursor !== source) {
      if (seen.has(cursor) || seen.size >= 3200) return false;
      seen.add(cursor);
      const peer = await this.#peerTrunkIntegration(cursor, snapshot);
      if (!peer) return false;
      cursor = peer.parent;
    }
    return true;
  }

  /** Read independently activated historical peers, never resume them.
   * Exact-commit PR associations are discovery hints, not activation authority. */
  async #peerTrunkIntegration(
    mergeSha: string,
    receiver: Snapshot,
    receiverRun?: RunState,
  ): Promise<{
    parent: string;
    requiresIsolation: boolean;
    executionRequiresIsolation: boolean;
  } | null> {
    const objectives = (await this.#store.readCommitObjectiveCandidates(mergeSha)).filter(
      (number) => number !== receiver.number,
    );
    if (objectives.length > 100)
      throw new Error("repository integration provenance exceeds 100 Objectives");
    let proof: {
      parent: string;
      requiresIsolation: boolean;
      executionRequiresIsolation: boolean;
    } | null = null;
    let proofObjective: number | undefined;
    let priorRequiresIsolation = false;
    let priorExecutionRequiresIsolation = false;
    for (const number of objectives) {
      const snapshot = await this.#reader.readObjective(number);
      if (
        snapshot.repositoryId !== receiver.repositoryId ||
        snapshot.defaultBranch !== receiver.defaultBranch
      )
        throw new Error("peer Objective repository identity changed");
      const starts = (snapshot.factoryEvents ?? []).filter(
        (event) => event.kind === "run" && event.event === "FactoryRunStarted",
      );
      for (const start of starts) {
        if (
          start.kind !== "run" ||
          start.event !== "FactoryRunStarted" ||
          !start.baseSha ||
          (!start.activationRequestId && !start.recoveryRequestId) ||
          start.repository.toLowerCase() !==
            `${this.#options.owner}/${this.#options.repo}`.toLowerCase() ||
          start.baseBranch !== receiver.defaultBranch ||
          start.actor.toLowerCase() !== (receiverRun ?? this.#run).actor.toLowerCase() ||
          start.objectiveAuthor.toLowerCase() !== snapshot.authorLogin?.toLowerCase()
        )
          continue;
        const events = snapshotEvents(snapshot).filter((event) => event.runId === start.runId);
        if (
          !events.some(
            (event) =>
              event.kind === "controller" &&
              event.sequence > start.sequence &&
              Number.isFinite(Date.parse(event.at)) &&
              Date.parse(event.at) >= Date.parse(start.at),
          )
        )
          continue;
        // Do not read every PR in every peer unless authenticated publication history
        // and the observed linked merge identify a possible source for this exact commit.
        const mergedItems = snapshot.workItems.filter(
          (item) =>
            item.linkedPullRequests.some((pull) => pull.state === "MERGED") &&
            (item.factoryEvents ?? []).some(
              (event) =>
                event.kind === "publication" &&
                (event.runId === start.runId || Boolean(start.recoveryRequestId)) &&
                event.event === "PublicationRecorded",
            ),
        );
        if (!mergedItems.length) continue;
        let exactAssociation = false;
        for (const item of mergedItems) {
          for (const linked of item.linkedPullRequests.filter((pull) => pull.state === "MERGED")) {
            const pull = await this.#store.readPullRequest(linked.number);
            if (pull.merged && pull.mergeCommitSha === mergeSha) exactAssociation = true;
          }
        }
        if (!exactAssociation) continue;
        const policy = parseRunPolicy(start.policy);
        if (policyDigest(policy) !== start.policyDigest)
          throw new Error("peer run policy digest changed");
        if (!start.recoveryRequestId)
          assertPeerActivation(start, snapshotEvents(snapshot), start.repository);
        const recovery = start.recoveryRequestId
          ? await loadRecoveryRuntime({
              objective: number,
              runId: start.runId,
              store: this.#recoveryStore,
              readSnapshot: async () => ({ snapshot, historyComplete: true }),
              ...(this.#options.signal ? { signal: this.#options.signal } : {}),
            })
          : undefined;
        if (recovery && recovery.status !== "verified")
          throw new Error("peer recovery integration lacks verified adoption provenance");
        const graphManager = new CompiledGraphManager(this.#store, this.#leases);
        const graph = recovery?.graph ?? (await graphManager.load(number, start.runId));
        const projection =
          recovery?.projection ??
          (graph ? await graphManager.loadProjection(number, start.runId, graph) : null);
        if (!graph || !projection)
          throw new Error("peer integration lacks immutable graph/projection evidence");
        assertGraphWithinRunPolicy(graph.objective, policy);
        const packets = assertSnapshotMatchesCompiledGraph(
          graph.objective,
          snapshot,
          projection.bindings,
        );
        if (!recovery)
          assertAuthenticatedGraphProjection(
            snapshotEvents(snapshot),
            number,
            start.runId,
            projection,
          );
        const run: RunState = {
          objective: number,
          runId: start.runId,
          actor: start.actor,
          sequence: start.sequence,
          policy,
          policyDigest: start.policyDigest,
          startedAt: new Date(start.at),
          ...(start.activationRequestId ? { activationRequestId: start.activationRequestId } : {}),
          baseSha: start.baseSha,
          repository: start.repository,
          baseBranch: start.baseBranch,
          fork: start.fork,
        };
        const commit = await this.#store.readCommit(mergeSha);
        if (commit.parentOids.length !== 1) return null;
        const adopted =
          recovery?.sourceIntegrations.filter(
            (source) => source.outcome.mergeCommitSha === mergeSha,
          ) ?? [];
        if (adopted.length > 1) throw new Error("peer adopted integration ownership is ambiguous");
        if (adopted.length) {
          if (
            adopted[0]!.targetBaseSha !== commit.parentOids[0] ||
            adopted[0]!.outputTreeSha !== commit.treeOid
          )
            throw new Error("peer adopted integration squash changed");
        } else if (
          !(await this.#observedRunOwnsBaseAdvance(
            snapshot,
            run,
            mergeSha,
            undefined,
            undefined,
            undefined,
            undefined,
            commit.parentOids[0],
            true,
          ))
        )
          continue;
        if (proof && proofObjective !== number)
          throw new Error("trunk commit has ambiguous cross-Objective ownership");
        const matched = mergedItems.filter((item) =>
          (item.factoryEvents ?? []).some(
            (event) =>
              event.kind === "attempt" &&
              event.runId === start.runId &&
              event.event === "AttemptIntegrated" &&
              event.headSha === mergeSha,
          ),
        );
        // A lost final integration receipt is allowed only because the helper above
        // proved the real squash and pre-merge accepted checkpoints. Conservatively
        // propagate isolation from every candidate source if its exact item is unknown.
        const sources = matched.length ? matched : mergedItems;
        const adoptedIsolation = adopted.some((source) => {
          const original = recovery?.events.find(
            (event) =>
              event.kind === "run" &&
              event.event === "FactoryRunStarted" &&
              event.runId === source.outcome.sourceRunId,
          );
          return (
            original?.kind !== "run" ||
            original.event !== "FactoryRunStarted" ||
            parseRunPolicy(original.policy).trust === "sandbox_untrusted"
          );
        });
        const executionRequiresIsolation =
          adoptedIsolation ||
          policy.trust === "sandbox_untrusted" ||
          sources.some((item) => {
            const packet = packets.get(item.number);
            return (
              !packet ||
              packet.requirements.trust !== "trusted_local" ||
              (item.factoryEvents ?? []).some(
                (event) =>
                  event.kind === "attempt" &&
                  (event.runId === start.runId || Boolean(adopted.length)) &&
                  event.event === "AttemptPublished" &&
                  isManagedAgentBackendId(event.backend),
              )
            );
          });
        const requiresIsolation =
          adoptedIsolation ||
          policy.trust === "sandbox_untrusted" ||
          sources.some((item) => {
            const packet = packets.get(item.number);
            if (!packet || packet.requirements.trust !== "trusted_local") return true;
            const published = (item.factoryEvents ?? []).filter(
              (event) =>
                event.kind === "attempt" &&
                (event.runId === start.runId || Boolean(adopted.length)) &&
                event.event === "AttemptPublished",
            );
            return published.some(
              (event) =>
                event.kind === "attempt" &&
                !this.#registry.get(event.backend)?.capabilities.hostExecution,
            );
          });
        priorRequiresIsolation ||= requiresIsolation;
        priorExecutionRequiresIsolation ||= executionRequiresIsolation;
        proof = {
          parent: commit.parentOids[0]!,
          requiresIsolation: priorRequiresIsolation,
          executionRequiresIsolation: priorExecutionRequiresIsolation,
        };
        proofObjective = number;
      }
    }
    return proof;
  }

  /** External trunk changes never acquire execution authority from being cleanly applicable. */
  async #assertOwnTrunkAdvance(
    sourceBaseSha: string,
    targetBaseSha: string,
    currentWorkItem: number,
  ): Promise<{
    snapshot: Snapshot;
    requiresIsolation: boolean;
    executionRequiresIsolation: boolean;
  }> {
    const snapshot = await this.#reader.readObjective(this.#run.objective);
    this.#fenceSnapshot(snapshot);
    this.#sequences.observe(snapshotEvents(snapshot));
    if (this.#recoveryRuntime) await this.#resumeObservedRun(snapshot, new RunManager(this.#store));
    const items = derive(snapshot).items;
    let cursor = targetBaseSha;
    let requiresIsolation = false;
    let executionRequiresIsolation = false;
    const visited = new Set<string>();
    while (cursor !== sourceBaseSha) {
      if (visited.has(cursor) || visited.size >= 3200) {
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
        const source = adopted[0]!.outcome;
        const originalStart = this.#recoveryRuntime!.events.find(
          (event) =>
            event.kind === "run" &&
            event.event === "FactoryRunStarted" &&
            event.runId === source.sourceRunId,
        );
        const inheritedTrust =
          originalStart?.kind !== "run" ||
          originalStart.event !== "FactoryRunStarted" ||
          parseRunPolicy(originalStart.policy).trust === "sandbox_untrusted" ||
          this.#packetFor(source.workItem).requirements.trust !== "trusted_local";
        executionRequiresIsolation ||= inheritedTrust;
        requiresIsolation ||= inheritedTrust;
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
      if (matches.length === 0) {
        const commit = await this.#store.readCommit(cursor);
        if (
          commit.parentOids.length === 1 &&
          (await this.#observedRunOwnsBaseAdvance(
            snapshot,
            this.#run,
            cursor,
            undefined,
            undefined,
            undefined,
            undefined,
            commit.parentOids[0],
            true,
          ))
        ) {
          // Recover a peer worker's lost final receipt from its original accepted
          // publication and observed squash, never by re-reviewing a completed merge.
          requiresIsolation ||= items.some((item) =>
            (item.factoryEvents ?? []).some(
              (event) =>
                event.kind === "attempt" &&
                event.runId === this.#run.runId &&
                event.event === "AttemptPublished" &&
                (!this.#registry.get(event.backend)?.capabilities.hostExecution ||
                  this.#packetFor(item.number).requirements.trust !== "trusted_local"),
            ),
          );
          executionRequiresIsolation ||= items.some((item) =>
            (item.factoryEvents ?? []).some(
              (event) =>
                event.kind === "attempt" &&
                event.runId === this.#run.runId &&
                event.event === "AttemptPublished" &&
                (isManagedAgentBackendId(event.backend) ||
                  this.#packetFor(item.number).requirements.trust !== "trusted_local"),
            ),
          );
          cursor = commit.parentOids[0]!;
          continue;
        }
        const peer = await this.#peerTrunkIntegration(cursor, snapshot, this.#run);
        if (peer) {
          requiresIsolation ||= peer.requiresIsolation;
          executionRequiresIsolation ||= peer.executionRequiresIsolation;
          cursor = peer.parent;
          continue;
        }
      }
      if (matches.length !== 1) {
        throw new Error(
          `base branch advanced outside this run's evidenced integrations: ${cursor}`,
        );
      }
      const { item, event } = matches[0]!;
      if (event.kind !== "attempt") throw new Error("invalid integration receipt");
      executionRequiresIsolation ||=
        isManagedAgentBackendId(event.backend) ||
        this.#packetFor(item.number).requirements.trust !== "trusted_local";
      if (
        !this.#registry.get(event.backend)?.capabilities.hostExecution ||
        this.#packetFor(item.number).requirements.trust !== "trusted_local"
      )
        requiresIsolation = true;
      const commit = await this.#store.readCommit(cursor);
      if (commit.oid !== cursor || commit.parentOids.length !== 1) {
        throw new Error("trunk advancement lacks an exact Factory squash integration");
      }
      const parent = commit.parentOids[0]!;
      if (
        !(await this.#observedRunOwnsBaseAdvance(
          snapshot,
          this.#run,
          cursor,
          undefined,
          undefined,
          undefined,
          undefined,
          parent,
          true,
        ))
      )
        throw new Error("prior integration lacks its authenticated accepted exact-head checkpoint");
      cursor = parent;
    }
    return { snapshot, requiresIsolation, executionRequiresIsolation };
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
    refresh?: SiblingRefreshRecord,
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
    const originalPacket = this.#packetBoundToReservation(item, member.reservation);
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
    const identity = this.#mergeCandidateIdentity(member, targetBaseSha, refresh?.plannedHeadSha);
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
    const packet = this.#packetBoundToReservation(item, member.reservation, targetBaseSha);
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
      return this.#retainArtifactContent(
        await artifactFromGitRange({
          repository: this.#options.repository,
          sourceBaseSha: source[0]!,
          headSha: source[1]!,
          baseSha: targetBaseSha,
          changedPaths,
          authenticatedLegacyDigest: record?.validation.artifactDigest,
        }),
      );
    };
    if (!record) {
      const effective = normalizeSchedulingPolicy(this.#policy);
      const resource = !isolated
        ? await this.#resourceSampler.sample(Date.now()).catch(() => null)
        : null;
      if (!isolated) {
        const pressure = resource
          ? resourcePressureReasons(resource, effective.capacity.local)
          : ["resource sample unavailable"];
        if (
          pressure.length > 0 ||
          this.#resourceSampler.coolingDown(Date.now()) ||
          !resource ||
          !localMemoryFits(
            resource,
            packet.requirements.memoryMb ?? effective.capacity.local.defaultMemoryMb,
            effective.capacity.local.minimumFreeMemoryMb,
          )
        ) {
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
      let validationLaunched = false;
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
        validation = await this.#externalAdmission(async () => {
          if (refresh) await this.#assertSiblingRefreshCurrent(member, refresh);
          validationLaunched = true;
          return validateArtifactClean({
            repository: this.#options.repository,
            artifact: artifact!,
            packet,
            publicationBaseBranch: this.#baseBranch,
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
          });
        });
        if (!validation.evidence.passed) {
          await this.#recordCandidateValidationUsage(
            validation.evidence,
            identityDigest,
            item,
            member.reservation,
          );
          throw new Error(validation.evidence.failureReason ?? "merge-candidate validation failed");
        }
        if (refresh) {
          if (validation.evidence.outputTreeSha !== refresh.outputTreeSha) {
            await this.#recordCandidateValidationUsage(
              validation.evidence,
              identityDigest,
              item,
              member.reservation,
            );
            if (isolated)
              await this.#recordCandidateValidationUsage(
                validation.evidence,
                identityDigest,
                item,
                member.reservation,
                "sandbox_milliseconds",
                providerCompleted!.getTime() - providerStarted!.getTime(),
              );
            throw new Error("refreshed head differs from the full newly validated tree");
          }
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
          if (capacityRecorded && (record || !validationLaunched))
            await reconcileCapacity(capacity.cpu, capacity.memoryMb);
        } finally {
          if (!capacityRecorded || record || !validationLaunched)
            this.#releaseCapacity(capacity.key);
        }
      }
    }
    if (refresh) {
      if (record.validation.outputTreeSha !== refresh.outputTreeSha)
        throw new Error("refreshed head checkpoint differs from its planned tree");
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
    // A completed exact validation is durable/accounted before observing mutable trunk.
    // A later same-run merge creates a new target, not lost usage or a duplicate validator.
    if (refresh) await this.#assertSiblingRefreshCurrent(member, refresh, merged);
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
        this.#invokeSemanticReview(
          {
            repository: this.#options.repository,
            objectiveNumber: this.#run.objective,
            workItemNumber: item.number,
            packet,
            artifact: artifact!,
            evidence: record.validation,
            publicationBaseBranch: this.#baseBranch,
            requiresIsolation: isolated || this.#policy.trust === "sandbox_untrusted",
            ...(reviewModel ? { modelSelection: reviewModel } : {}),
          },
          checkpoint,
          invocationId,
          () => this.#admitModelInvocation(invocationId, item.id, member.reservation),
          (error) =>
            this.#recordProviderQuotaGate(
              error,
              item.id,
              "management",
              this.#management.id,
              member.reservation,
            ),
        );
    }
    await this.#reviewTransaction({
      existing: existingReview,
      ...(invokeReview ? { invoke: invokeReview } : {}),
      persist: (result) =>
        this.#lease.use((lease) =>
          this.#reviews.persist({ lease, identity: reviewIdentity, result }),
        ),
      recover: () => this.#reviews.load(reviewIdentity),
      recordUsage: (review) => this.#recordReviewUsage(review, item, member.reservation),
      recordFailureUsage: (usage) =>
        this.#recordManagementUsage(invocationId, usage, item.id, member.reservation),
      recordProviderGate: (error) =>
        this.#recordProviderQuotaGate(
          error,
          item.id,
          "management",
          this.#management.id,
          member.reservation,
        ),
      recordOutcome: async (review) => {
        if (!review.review.accepted || review.review.unmetCriteria.length > 0)
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
    unit: "model_tokens" | "validation_milliseconds" | "sandbox_milliseconds",
  ): Promise<void> {
    const link =
      unit === "model_tokens"
        ? this.#modelInvocationLink(
            usageId.startsWith("failed-") ? usageId.slice(7) : usageId,
            undefined,
            item.number,
          )
        : {};
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
    if (unit === "model_tokens" ? this.#hasModelUsageLink(existing, link) : existing.length > 0)
      return;
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
        ...link,
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
    await this.#assertWorkflowPublicationHeadSafety({
      baseSha: artifact.exactHeadValidation.baseSha,
      headSha: artifact.headSha,
      baseBranch: this.#baseBranch,
    });
    let pull = await this.#store.findPullRequestForBranch(artifact.branch);
    if (!pull) {
      try {
        pull = await this.#lease.use(async () => {
          await this.#lease.assertGeneration("publication");
          if ((await this.#store.readRef(`refs/heads/${artifact.branch}`)) !== artifact.headSha)
            throw new Error("acknowledged source artifact branch changed before PR creation");
          const created = await dispatchPublicationMutation({
            store: this.#store,
            assertCurrent: () => this.#lease.assertGeneration("publication"),
            assertSafety: async () => {
              await this.#assertWorkflowPublicationHeadSafety({
                baseSha: artifact.exactHeadValidation.baseSha,
                headSha: artifact.headSha,
                baseBranch: this.#baseBranch,
              });
              await this.#assertPublicationHeadCurrent({
                headBranch: artifact.branch,
                headSha: artifact.headSha,
              });
            },
            mutate: () =>
              this.#store.createPullRequest({
                title: item.title,
                body: `Implements Work Item #${item.number} for Objective #${this.#run.objective}.\n\nCloses #${item.number}\n\nRecovered exact validated source artifact; no replacement worker ran.`,
                head: artifact.branch,
                base: this.#baseBranch,
              }),
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
      await this.#assertWorkflowPublicationHeadSafety({
        baseSha: artifact.exactHeadValidation.baseSha,
        headSha: artifact.headSha,
        baseBranch: base,
      });
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
              const created = await dispatchPublicationMutation({
                store: this.#store,
                assertCurrent: () => this.#lease.assertGeneration("publication"),
                assertSafety: async () => {
                  await this.#assertWorkflowPublicationHeadSafety({
                    baseSha: artifact.exactHeadValidation.baseSha,
                    headSha: artifact.headSha,
                    baseBranch: base,
                  });
                  await this.#assertPublicationHeadCurrent({
                    headBranch: artifact.branch,
                    headSha: artifact.headSha,
                  });
                },
                mutate: () =>
                  this.#store.createPullRequest({
                    title,
                    body: `Implements Work Item #${artifact.workItem} for Objective #${this.#run.objective}.\n\nCloses #${artifact.workItem}\n\nRecovered exact validated source artifact; no replacement worker ran.`,
                    head: artifact.branch,
                    base,
                  }),
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
      events: runtime.events,
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
    try {
      await this.#resumeAdoptedSourceNow(item);
    } catch (error) {
      if (
        error instanceof SiblingRefreshTargetAdvancedError ||
        error instanceof SiblingRefreshObservationPendingError
      ) {
        this.#deferIntegration(item.number, error.message);
        return;
      }
      throw error;
    }
  }

  async #resumeAdoptedSourceNow(item: DerivedWorkItem): Promise<void> {
    return withArtifactContentScope(() => this.#resumeAdoptedSourceWithArtifactContent(item));
  }

  async #resumeAdoptedSourceWithArtifactContent(item: DerivedWorkItem): Promise<void> {
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
    // This inventory contains only independently verified candidate identities,
    // including their original target and any distinct refreshed delivery head.
    // Check all failed identities before observing a new target or probing a
    // validator: an authenticated later trunk advance cannot erase rejection.
    const priorFailures = runtime.verifiedSourceCapacity.filter(
      (event): event is Extract<FactoryEvent, { kind: "capacity" }> =>
        event.kind === "capacity" &&
        event.event === "CapacityReconciled" &&
        event.runId === this.#run.runId &&
        event.workItem === item.number &&
        event.sourceRunId === source.runId &&
        event.attempt === source.attempt &&
        event.isolatedFailure !== undefined,
    );
    if (priorFailures.length) {
      if (
        priorFailures.length > 100 ||
        new Set(priorFailures.map((event) => event.backend)).size !== priorFailures.length ||
        priorFailures.some(
          (event) =>
            !/^factory\/integration-sandbox-[a-f0-9]{64}$/.test(event.backend) ||
            !event.isolatedValidation ||
            event.policyDigest !== this.#run.policyDigest ||
            !event.targetBaseSha,
        )
      )
        throw new Error("prior adopted isolated failure inventory is ambiguous");
      for (const event of priorFailures) {
        const failure = event.isolatedFailure!;
        const usageId = `integration-validation-${event.backend.slice("factory/integration-sandbox-".length)}`;
        await this.#sourceUsage(
          item,
          usageId,
          Date.parse(failure.validationCompletedAt) - Date.parse(failure.validationStartedAt),
          "validation_milliseconds",
        );
        await this.#sourceUsage(item, usageId, failure.sandboxMilliseconds, "sandbox_milliseconds");
      }
      throw new Error("adopted isolated candidate validation was durably rejected");
    }
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
    const target = observed.merged
      ? (await this.#store.readCommit(observed.mergeCommitSha!)).parentOids[0]!
      : (await this.#store.getBranchHead(this.#baseBranch)).oid;
    const unit = this.#deliveryPlan?.units.find((entry) =>
      entry.items.includes(planItem.compilerId),
    );
    let requiresIsolatedCandidate = false;
    let adoptedValidator: ExecutionBackend | undefined;
    const candidateTimeout = () =>
      Math.min(
        (this.#packetFor(item.number).requirements.timeoutMinutes ??
          this.#policy.workItemTimeoutMinutes) * 60_000,
        this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000 - Date.now(),
      );
    const remoteAdmissionOpen = async (alreadyAdmitted = false) => {
      const snapshot = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(snapshot);
      this.#sequences.observe(snapshotEvents(snapshot));
      if (hasCancellationRequest(snapshot, this.#run.runId))
        throw new RunCancellationRequestedError(
          "operator cancelled before adopted isolated validation",
        );
      const commands = deriveDurableCommandState({
        events: snapshotEvents(snapshot),
        objective: this.#run.objective,
        runId: this.#run.runId,
        runActor: this.#run.actor,
        runStartSequence: this.#runStartSequence,
      });
      this.#budgetEvents = deduplicateFactoryEvents([
        ...this.#budgetEvents,
        ...snapshotEvents(snapshot).filter(
          (event) => event.runId === this.#run.runId && event.kind === "budget",
        ),
      ]);
      // Pause/drain stops new phases, while an already durably admitted phase may
      // finish. Cancellation is different and is rechecked even after admission.
      return (
        alreadyAdmitted ||
        (!commands.admissionsPaused && !commands.draining && !commands.cloudPaused)
      );
    };
    const selectAdoptedValidator = async () => {
      const amount = candidateTimeout();
      const available = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
      if (amount <= 0 || available.sandboxMinutes * 60_000 < amount)
        throw new Error("sandbox-minute budget exhausted before adopted candidate validation");
      const candidates = await this.#registry.evaluateIsolatedValidators({
        policy: { ...this.#policy, backendOrder: ["codex-cli/daytona"] },
        requirements: this.#packetFor(item.number).requirements,
        probeTtlMs: 0,
      });
      const selected = candidates.find((entry) => entry.id === "codex-cli/daytona");
      if (
        !selected?.backend?.validate ||
        !selected.backend.reconcileStale ||
        selected.permanentReasons.length ||
        selected.transientReasons.length
      )
        throw new Error(
          "independent Daytona adopted-candidate validator is unavailable or unauthorized",
        );
      return selected.backend;
    };
    if (target !== exactHeadValidation.baseSha) {
      const nativeLinear = publication.mode === "native-stacks" && unit?.kind === "stack";
      let nativeAncestorIsolation = false;
      if (nativeLinear) {
        const position = unit.items.indexOf(planItem.compilerId);
        if (position < 0) throw new Error("adopted native candidate lacks its graph position");
        for (const compilerId of unit.items.slice(0, position)) {
          const ancestor = runtime.planRecord.plan.items.find(
            (entry) => entry.compilerId === compilerId,
          );
          if (!ancestor) throw new Error("adopted native candidate lacks ancestor provenance");
          nativeAncestorIsolation ||=
            this.#packetFor(ancestor.workItem).requirements.trust !== "trusted_local";
          if (ancestor.action === "execute") continue; // Current integrations are proved below.
          if (!ancestor.source)
            throw new Error("adopted native ancestor lacks its retained source");
          const reservations = runtime.events.filter(
            (event) => recoveryEventDigest(event) === ancestor.source!.reservationReceiptDigest,
          );
          const reservation = reservations[0];
          if (reservations.length !== 1 || reservation?.event !== "AttemptReserved")
            throw new Error("adopted native ancestor lacks its exact reservation");
          nativeAncestorIsolation ||= !this.#registry.get(reservation.backend)?.capabilities
            .hostExecution;
          for (const producer of new Set([
            ancestor.source.runId,
            ...(ancestor.source.priorDelivery ? [ancestor.source.priorDelivery.runId] : []),
            ...(ancestor.source.siblingRefresh
              ? [ancestor.source.siblingRefresh.candidateRunId]
              : []),
          ])) {
            const sourceIsolation = nativeSourceRequiresIsolation(producer, runtime.events);
            nativeAncestorIsolation ||= sourceIsolation;
          }
        }
      }
      const lineage = await this.#assertOwnTrunkAdvance(
        // A linear member's source base can be its parent's publication, which
        // is not a trunk commit. Native member/transition proofs preserve that
        // identity; actual trunk advancement starts at the acknowledged base.
        nativeLinear ? runtime.planRecord.plan.expectedBaseSha : exactHeadValidation.baseSha,
        target,
        item.number,
      );
      const sourceStarts = runtime.events.filter(
        (event) =>
          event.event === "FactoryRunStarted" &&
          event.runId === source.runId &&
          event.policyDigest === reserved.policyDigest,
      );
      const sourceStart = sourceStarts[0];
      if (sourceStarts.length !== 1 || sourceStart?.event !== "FactoryRunStarted")
        throw new Error("adopted candidate source policy is not uniquely authenticated");
      requiresIsolatedCandidate =
        sourceStart.policy.trust === "sandbox_untrusted" ||
        this.#policy.trust === "sandbox_untrusted" ||
        this.#packetFor(item.number).requirements.trust !== "trusted_local" ||
        !this.#registry.get(reserved.backend)?.capabilities.hostExecution ||
        nativeAncestorIsolation ||
        lineage.requiresIsolation;
      if (
        requiresIsolatedCandidate &&
        (!sourceStart.policy.allowedPaidBackends.includes("codex-cli/daytona") ||
          !this.#policy.allowedPaidBackends.includes("codex-cli/daytona"))
      )
        throw new Error(
          "adopted candidate requires original and successor authorization for independent Daytona validation",
        );
      if (
        !observed.merged &&
        requiresIsolatedCandidate &&
        deriveDurableCommandState({
          events: snapshotEvents(lineage.snapshot),
          objective: this.#run.objective,
          runId: this.#run.runId,
          runActor: this.#run.actor,
          runStartSequence: this.#runStartSequence,
        }).cloudPaused
      )
        return;
      if (
        !observed.merged &&
        requiresIsolatedCandidate &&
        observed.headSha === pull.commitSha &&
        ((publication.mode === "native-stacks" && unit?.kind === "sibling") ||
          (publication.mode === "regular-prs" &&
            publication.branch ===
              publicationBranch(this.#run.objective, item.number, source.attempt) &&
            !isManagedAgentBackendId(reserved.backend)))
      )
        adoptedValidator = await selectAdoptedValidator();
    }
    let siblingRefresh: SiblingRefreshRecord | undefined;
    if (
      ((publication.mode === "native-stacks" && unit?.kind === "sibling") ||
        (publication.mode === "regular-prs" &&
          publication.branch ===
            publicationBranch(this.#run.objective, item.number, source.attempt) &&
          !isManagedAgentBackendId(reserved.backend))) &&
      target !== exactHeadValidation.baseSha &&
      (!observed.merged || observed.headSha !== pull.commitSha)
    ) {
      if (
        observed.headSha === pull.commitSha &&
        unreconciledCapacityReservations([...runtime.events]).some(
          (event) =>
            event.runId === this.#run.runId &&
            event.workItem === item.number &&
            event.sourceRunId === source.runId,
        )
      )
        throw new Error(
          "prior adopted validation requires exact scope reconciliation before refresh",
        );
      if (observed.headSha === pull.commitSha) {
        // Only authenticated invocation receipts identify historical targets.
        // Do not scan refs or drop an earlier paid result when trunk advances.
        const historicalCapacity = runtime.verifiedSourceCapacity.filter(
          (event) =>
            event.kind === "capacity" &&
            event.runId === this.#run.runId &&
            event.workItem === item.number &&
            event.attempt === source.attempt &&
            event.sourceRunId === source.runId,
        );
        const priorTargets = new Set([target]);
        for (const event of historicalCapacity) {
          if (event.kind !== "capacity" || !event.targetBaseSha)
            throw new Error("prior adopted candidate target unavailable before refresh");
          priorTargets.add(event.targetBaseSha);
          if (priorTargets.size > 100)
            throw new Error("prior adopted candidate history exceeds the refresh bound");
        }
        for (const priorTarget of priorTargets) {
          const priorIdentity: MergeCandidateIdentity = {
            runId: this.#run.runId,
            objective: this.#run.objective,
            workItem: item.number,
            attempt: source.attempt,
            pullRequest: pull.number,
            sourceHeadSha: pull.commitSha,
            sourceExactHeadValidationDigest: exactHeadValidation.digest,
            targetBaseSha: priorTarget,
          };
          const priorDigest = mergeCandidateIdentityDigest(priorIdentity);
          const receipts = historicalCapacity.filter(
            (event) => event.kind === "capacity" && event.targetBaseSha === priorTarget,
          );
          if (
            receipts.some(
              (event) =>
                event.kind !== "capacity" ||
                event.backend !== `factory/integration-validation-${priorDigest}`,
            )
          )
            throw new Error("prior adopted candidate invocation changed before refresh");
          const prior = await this.#mergeCandidates.load(priorIdentity);
          if (!prior) {
            if (receipts.length)
              throw new Error("prior adopted candidate completion unavailable before refresh");
            continue;
          }
          if (JSON.stringify(prior.source) !== JSON.stringify(exactHeadValidation))
            throw new Error("prior adopted candidate source changed before refresh");
          if (
            receipts.some(
              (event) =>
                event.kind === "capacity" &&
                event.localScopeBatch &&
                event.localScopeBatch.identity.invocationDigest !== prior.validation.artifactDigest,
            )
          )
            throw new Error("prior adopted candidate artifact changed before refresh");
          if (priorTarget !== target)
            await this.#assertOwnTrunkAdvance(priorTarget, target, item.number);
          // Completion precedes this fallible receipt in the ordinary path.
          // Replay its exact duration; never substitute zero or re-run validation.
          await this.#sourceUsage(
            item,
            `integration-validation-${priorDigest}`,
            Date.parse(prior.validation.completedAt) - Date.parse(prior.validation.startedAt),
            "validation_milliseconds",
          );
          const reviewIdentity = this.#mergeCandidateReviewIdentity(prior);
          const invocationId = `integration-review-${reviewIdentityDigest(reviewIdentity)}`;
          this.#assertManagementInvocationNotFailed(invocationId);
          const existing = await this.#reviews.load(reviewIdentity);
          if (existing)
            await this.#reviewTransaction({
              existing,
              recover: () => this.#reviews.load(reviewIdentity),
              persist: async () => {
                throw new Error("prior review cannot be recreated before refresh");
              },
              recordUsage: (review) =>
                this.#sourceUsage(
                  item,
                  invocationId,
                  review.usage.inputTokens + review.usage.outputTokens,
                  "model_tokens",
                ),
              recordOutcome: async (review) => {
                if (!review.review.accepted || review.review.unmetCriteria.length)
                  throw new Error(
                    "prior adopted candidate semantic review rejected before refresh",
                  );
              },
            });
        }
      }
      const member = await this.#nativeStackMember(item, true);
      siblingRefresh = await this.#prepareSiblingRefresh(item, member, target, observed.merged);
      if (
        source.siblingRefresh &&
        source.siblingRefresh.targetBaseSha === target &&
        source.siblingRefresh.deliveryHeadSha === siblingRefresh.plannedHeadSha &&
        (planItem.action === "reuse-publication" || planItem.action === "integrated")
      ) {
        const prior = await observeRecoverySiblingRefresh({
          repository: runtime.planRecord.plan.repository,
          objective: runtime.planRecord.plan.objective,
          workItem: item.number,
          source: { ...source, publication },
          events: runtime.events,
          controllingRunIds: [
            ...runtime.planRecord.plan.history.map((entry) => entry.runId),
            runtime.controllingRun.runId,
          ],
          store: this.#recoveryStore,
          deliveryHeadSha: siblingRefresh.plannedHeadSha,
          candidateRunId: source.siblingRefresh.candidateRunId,
          requireCompletion: true,
          authority: runtime.objectiveAuthority,
        });
        if (!prior.candidate) throw new Error("accepted prior sibling candidate is unavailable");
        await this.#integrate(
          item,
          reserved,
          pull,
          this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
          true,
          prior.candidate,
          true,
          undefined,
          siblingRefresh,
        );
        return;
      }
    }
    let deliveryHeadSha: string | undefined;
    if (
      !siblingRefresh &&
      (observed.headSha !== pull.commitSha || observed.baseRef !== this.#baseBranch)
    ) {
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
        ...(siblingRefresh ? { deliveryHeadSha: siblingRefresh.plannedHeadSha } : {}),
      };
      const digest = mergeCandidateIdentityDigest(identity);
      const isolated = requiresIsolatedCandidate;
      const backendId = `factory/integration-${isolated ? "sandbox" : "validation"}-${digest}`;
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
      const packet = this.#packetBoundToReservation(
        item,
        reserved,
        target,
        isolated ? "isolated" : original.requirements.trust,
      );
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
        return this.#retainArtifactContent(
          await artifactFromGitRange({
            repository: this.#options.repository,
            sourceBaseSha: range[0]!,
            headSha: range[1]!,
            baseSha: target,
            changedPaths,
            authenticatedLegacyDigest: candidate?.validation.artifactDigest,
          }),
        );
      };
      const outstanding = unreconciledCapacityReservations([...runtime.events]).filter(
        (event) =>
          event.runId === this.#run.runId &&
          event.workItem === item.number &&
          event.backend === backendId,
      );
      type SourceCapacity = Extract<FactoryEvent, { kind: "capacity" }>;
      const invocation = (artifactDigest: string) => ({
        kind: "integration-candidate" as const,
        identityDigest: digest,
        artifactDigest,
        baseSha: target,
      });
      const ownership = (artifactDigest: string, directorEpoch: number) =>
        validationInvocationOwnership({
          repository: `${this.#options.owner}/${this.#options.repo}`,
          objective: this.#run.objective,
          workItem: item.number,
          attempt: source.attempt,
          runId: this.#run.runId,
          directorEpoch,
          policyDigest: this.#run.policyDigest,
          phase: "validation",
          validationInvocation: invocation(artifactDigest),
        })!;
      const recordedReservations = runtime.events.filter(
        (event): event is SourceCapacity =>
          event.kind === "capacity" &&
          event.event === "CapacityReserved" &&
          event.runId === this.#run.runId &&
          event.workItem === item.number &&
          event.backend === backendId,
      );
      let remoteReservation: SourceCapacity | undefined;
      if (isolated && recordedReservations.length) {
        if (recordedReservations.length !== 1)
          throw new Error("ambiguous adopted isolated capacity ownership");
        remoteReservation = recordedReservations[0]!;
        const metadata = remoteReservation.isolatedValidation;
        if (
          !metadata ||
          remoteReservation.sourceRunId !== source.runId ||
          remoteReservation.attempt !== source.attempt ||
          remoteReservation.targetBaseSha !== target ||
          remoteReservation.policyDigest !== this.#run.policyDigest ||
          metadata.invocationOwnershipDigest !==
            ownership(metadata.artifactDigest, remoteReservation.directorEpoch)
        )
          throw new Error("adopted isolated capacity identity changed");
      }
      if (
        candidate &&
        isolated &&
        (!remoteReservation ||
          !candidate.isolatedResource ||
          candidate.isolatedResource.invocationOwnershipDigest !==
            remoteReservation.isolatedValidation!.invocationOwnershipDigest ||
          candidate.validation.artifactDigest !==
            remoteReservation.isolatedValidation!.artifactDigest)
      )
        throw new Error("adopted isolated completion lacks its exact resource ownership");
      if (candidate && !isolated && candidate.isolatedResource)
        throw new Error("adopted candidate isolation classification changed");
      const failures = runtime.events.filter(
        (event): event is SourceCapacity =>
          event.kind === "capacity" &&
          event.event === "CapacityReconciled" &&
          event.runId === this.#run.runId &&
          event.workItem === item.number &&
          event.backend === backendId &&
          event.isolatedFailure !== undefined,
      );
      if (failures.length) {
        if (!isolated || candidate)
          throw new Error("adopted isolated failure conflicts with successful completion");
        assertIsolatedCandidateFailureProof({
          repository: runtime.planRecord.plan.repository,
          sourceRunId: source.runId,
          identity,
          events: runtime.events,
          requireAccounting: false,
        });
        const failure = failures[0]!.isolatedFailure!;
        await this.#sourceUsage(
          item,
          `integration-validation-${digest}`,
          Date.parse(failure.validationCompletedAt) - Date.parse(failure.validationStartedAt),
          "validation_milliseconds",
        );
        await this.#sourceUsage(
          item,
          `integration-validation-${digest}`,
          failure.sandboxMilliseconds,
          "sandbox_milliseconds",
        );
        throw new Error("adopted isolated candidate validation was durably rejected");
      }
      const recordCapacity = async (
        event: "CapacityReserved" | "CapacityReconciled",
        cpu: number,
        memoryMb: number,
        batch?: LocalScopeBatch,
        remote?: SourceCapacity,
        failure?: SourceCapacity["isolatedFailure"],
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
            directorEpoch:
              remote?.directorEpoch ?? (await this.#lease.use(async (lease) => lease.epoch)),
            policyDigest: this.#run.policyDigest,
            phase: "validation",
            backend: backendId,
            sequence: this.#sequences.take(),
            at: (await this.#store.serverTime()).toISOString(),
            requestedCpu: cpu,
            requestedMemoryMb: memoryMb,
            ...(batch ? { localScopeBatch: batch } : {}),
            ...(remote?.isolatedValidation
              ? { isolatedValidation: remote.isolatedValidation }
              : {}),
            ...(failure ? { isolatedFailure: failure } : {}),
          }),
        );
      if (!candidate && isolated && remoteReservation) {
        const backend = this.#registry.get("codex-cli/daytona");
        if (!backend?.reconcileStale)
          throw new Error("adopted isolated resource reconciliation unavailable");
        await this.#externalAdmission(() =>
          backend.reconcileStale!({
            repository: `${this.#options.owner}/${this.#options.repo}`,
            objective: this.#run.objective,
            workItem: item.number,
            attempt: source.attempt,
            runId: this.#run.runId,
            directorEpoch: remoteReservation!.directorEpoch,
            policyDigest: this.#run.policyDigest,
            phase: "validation",
            validationInvocation: invocation(remoteReservation!.isolatedValidation!.artifactDigest),
            noHandleReplacementNotBefore:
              remoteReservation!.isolatedValidation!.noHandleReplacementNotBefore,
          }),
        );
        // Absence is not validation completion or measured usage. Retain the native
        // liability and refuse to dispatch this immutable candidate a second time.
        throw new Error(
          "interrupted adopted isolated validation reconciled resources but lacks immutable completion",
        );
      }
      if (!candidate && outstanding.length)
        throw new Error("interrupted adopted validation requires exact scope reconciliation");
      if (candidate)
        for (const entry of outstanding)
          await recordCapacity(
            "CapacityReconciled",
            entry.requestedCpu,
            entry.requestedMemoryMb,
            undefined,
            isolated ? entry : undefined,
          );
      if (!candidate) {
        if (isolated && !(await remoteAdmissionOpen())) return;
        if (isolated) adoptedValidator ??= await selectAdoptedValidator();
        const effective = normalizeSchedulingPolicy(this.#policy);
        const resource = !isolated
          ? await this.#resourceSampler.sample(Date.now()).catch(() => null)
          : null;
        if (
          !isolated &&
          (!resource ||
            resourcePressureReasons(resource, effective.capacity.local).length ||
            this.#resourceSampler.coolingDown(Date.now()) ||
            !localMemoryFits(
              resource,
              packet.requirements.memoryMb ?? effective.capacity.local.defaultMemoryMb,
              effective.capacity.local.minimumFreeMemoryMb,
            ))
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
          admissionClass: isolated ? "remote-required" : "local",
          local: !isolated,
          cpu: packet.requirements.cpu ?? effective.capacity.local.defaultCpu,
          memoryMb: packet.requirements.memoryMb ?? effective.capacity.local.defaultMemoryMb,
          paidUnits: isolated ? 1 : 0,
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
        let validationLaunched = false;
        let failureRecorded = false;
        let providerStarted: Date | undefined;
        let providerCompleted: Date | undefined;
        let providerResult:
          | Awaited<ReturnType<NonNullable<ExecutionBackend["validate"]>>>
          | undefined;
        try {
          artifact = await reconstruct();
          const scope = isolated
            ? undefined
            : await this.#scopedValidation(
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
          if (!isolated && !scope)
            throw new Error("adopted validation requires observable owned local scopes");
          let validationDeadline = deadline;
          let sandboxAmount = 0;
          if (isolated) {
            if (!(await remoteAdmissionOpen())) return;
            const available = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
            sandboxAmount = candidateTimeout();
            if (sandboxAmount <= 0 || available.sandboxMinutes * 60_000 < sandboxAmount)
              throw new Error(
                "sandbox-minute budget or deadline changed before adopted validation reservation",
              );
            if (
              this.#budgetEvents.some(
                (event) =>
                  event.kind === "budget" &&
                  event.runId === this.#run.runId &&
                  event.workItem === item.number &&
                  event.unit === "sandbox_milliseconds" &&
                  event.usageId === `integration-validation-${digest}`,
              )
            )
              throw new Error(
                "adopted isolated invocation already has native accounting without a completion",
              );
            const at = (await this.#store.serverTime()).toISOString();
            validationDeadline = new Date(
              Math.min(Date.parse(at) + sandboxAmount, deadline.getTime()),
            );
            const directorEpoch = await this.#lease.use(async (lease) => lease.epoch);
            const receipt = parseFactoryEvent({
              protocol: "clockgrove.factory/v2",
              kind: "capacity",
              event: "CapacityReserved",
              objective: this.#run.objective,
              runId: this.#run.runId,
              workItem: item.number,
              attempt: source.attempt,
              sourceRunId: source.runId,
              targetBaseSha: target,
              directorEpoch,
              policyDigest: this.#run.policyDigest,
              phase: "validation",
              backend: backendId,
              sequence: this.#sequences.take(),
              at,
              requestedCpu: capacity.cpu,
              requestedMemoryMb: capacity.memoryMb,
              isolatedValidation: {
                backend: "codex-cli/daytona",
                artifactDigest: artifact.digest,
                invocationOwnershipDigest: ownership(artifact.digest, directorEpoch),
                deadline: validationDeadline.toISOString(),
                noHandleReplacementNotBefore: new Date(
                  validationDeadline.getTime() + 60_000,
                ).toISOString(),
              },
            });
            if (receipt.kind !== "capacity") throw new Error("invalid adopted capacity receipt");
            remoteReservation = receipt;
            await this.#appendSuccessorEvent(item.id, receipt);
          } else {
            await recordCapacity("CapacityReserved", capacity.cpu, capacity.memoryMb, scope!.batch);
          }
          recorded = true;
          if (isolated) {
            const budgetAt = (await this.#store.serverTime()).toISOString();
            const remainingWindow = validationDeadline.getTime() - Date.parse(budgetAt);
            if (remainingWindow <= 0)
              throw new Error(
                "adopted isolated reservation server-time window changed before native admission",
              );
            await this.#appendSuccessorEvent(
              item.id,
              parseFactoryEvent({
                protocol: "clockgrove.factory/v2",
                kind: "budget",
                event: "BudgetReserved",
                objective: this.#run.objective,
                runId: this.#run.runId,
                workItem: item.number,
                sequence: this.#sequences.take(),
                at: budgetAt,
                phase: "validation",
                unit: "sandbox_milliseconds",
                amount: sandboxAmount,
                usageId: `integration-validation-${digest}`,
              }),
            );
          }
          validation = await this.#externalAdmission(async () => {
            if (siblingRefresh)
              await this.#assertSiblingRefreshCurrent(
                { reservation: reserved, pull },
                siblingRefresh,
              );
            validationLaunched = true;
            return validateArtifactClean({
              repository: this.#options.repository,
              artifact: artifact!,
              packet,
              publicationBaseBranch: this.#baseBranch,
              ...(scope ? { localScope: scope.hooks } : {}),
              ...(isolated
                ? {
                    isolatedValidator: () =>
                      this.#externalAdmission(async () => {
                        await remoteAdmissionOpen(true);
                        if (Date.now() >= validationDeadline.getTime())
                          throw new Error(
                            "adopted isolated validation deadline exhausted before launch",
                          );
                        await this.#lease.use(async (lease) => {
                          if (lease.epoch !== remoteReservation!.directorEpoch)
                            throw new Error(
                              "adopted isolated invocation lost its reserved Objective generation",
                            );
                        });
                        providerStarted = new Date();
                        const result = await adoptedValidator!.validate!({
                          repository: `${this.#options.owner}/${this.#options.repo}`,
                          objective: this.#run.objective,
                          workItem: item.number,
                          attempt: source.attempt,
                          runId: this.#run.runId,
                          directorEpoch: remoteReservation!.directorEpoch,
                          policyDigest: this.#run.policyDigest,
                          workspace: this.#options.repository,
                          packet,
                          artifact: artifact!,
                          policyNetworkDestinations: this.#policy.allowedNetworkDestinations,
                          deadline: validationDeadline,
                          validationInvocation: invocation(artifact!.digest),
                        });
                        providerCompleted = new Date();
                        providerResult = result;
                        return result;
                      }),
                  }
                : {}),
            });
          }).catch(async (error: unknown) => {
            // A returned provider result already proves cleanup, even if the
            // host rejects its command/tree binding. Record rejection, not an
            // accepted candidate or an indefinitely unknown sandbox.
            if (isolated && providerStarted && providerCompleted && providerResult) {
              await recordCapacity(
                "CapacityReconciled",
                capacity.cpu,
                capacity.memoryMb,
                undefined,
                remoteReservation,
                {
                  validationDigest: createHash("sha256")
                    .update(
                      JSON.stringify({
                        invocation: invocation(artifact!.digest),
                        result: providerResult,
                      }),
                    )
                    .digest("hex"),
                  validationStartedAt: providerResult.startedAt,
                  validationCompletedAt: providerResult.completedAt,
                  startedAt: providerStarted.toISOString(),
                  completedAt: providerCompleted.toISOString(),
                  sandboxMilliseconds: providerCompleted.getTime() - providerStarted.getTime(),
                },
              );
              failureRecorded = true;
              await this.#sourceUsage(
                item,
                `integration-validation-${digest}`,
                Date.parse(providerResult.completedAt) - Date.parse(providerResult.startedAt),
                "validation_milliseconds",
              );
            }
            throw error;
          });
          if (
            isolated &&
            (!validation.evidence.passed ||
              (siblingRefresh &&
                validation.evidence.outputTreeSha !== siblingRefresh.outputTreeSha))
          ) {
            await recordCapacity(
              "CapacityReconciled",
              capacity.cpu,
              capacity.memoryMb,
              undefined,
              remoteReservation,
              {
                validationDigest: validation.evidence.digest,
                validationStartedAt: validation.evidence.startedAt,
                validationCompletedAt: validation.evidence.completedAt,
                startedAt: providerStarted!.toISOString(),
                completedAt: providerCompleted!.toISOString(),
                sandboxMilliseconds: providerCompleted!.getTime() - providerStarted!.getTime(),
              },
            );
            failureRecorded = true;
          }
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
          if (
            siblingRefresh &&
            validation.evidence.outputTreeSha !== siblingRefresh.outputTreeSha
          ) {
            await this.#sourceUsage(
              item,
              `integration-validation-${digest}`,
              Date.parse(validation.evidence.completedAt) -
                Date.parse(validation.evidence.startedAt),
              "validation_milliseconds",
            );
            throw new Error("adopted refreshed head differs from its newly validated tree");
          }
          candidate = await this.#lease.use((lease) =>
            this.#mergeCandidates.persist({
              lease,
              identity,
              source: exactHeadValidation,
              validation: validation!.evidence,
              ...(isolated
                ? {
                    isolatedResource: {
                      backend: "codex-cli/daytona" as const,
                      invocationOwnershipDigest:
                        remoteReservation!.isolatedValidation!.invocationOwnershipDigest,
                      startedAt: providerStarted!.toISOString(),
                      completedAt: providerCompleted!.toISOString(),
                      sandboxMilliseconds:
                        providerCompleted!.getTime() - providerStarted!.getTime(),
                    },
                  }
                : {}),
            }),
          );
        } finally {
          try {
            if (validation) await discardValidationResult(validation);
            if (providerStarted && providerCompleted)
              await this.#sourceUsage(
                item,
                `integration-validation-${digest}`,
                providerCompleted.getTime() - providerStarted.getTime(),
                "sandbox_milliseconds",
              );
            if (recorded && !failureRecorded && (candidate || !validationLaunched))
              await recordCapacity(
                "CapacityReconciled",
                capacity.cpu,
                capacity.memoryMb,
                undefined,
                isolated ? remoteReservation : undefined,
              );
          } finally {
            if (!recorded || candidate || failureRecorded || !validationLaunched)
              this.#releaseCapacity(capacity.key);
          }
        }
      }
      await this.#sourceUsage(
        item,
        `integration-validation-${digest}`,
        Date.parse(candidate.validation.completedAt) - Date.parse(candidate.validation.startedAt),
        "validation_milliseconds",
      );
      if (candidate.isolatedResource)
        await this.#sourceUsage(
          item,
          `integration-validation-${digest}`,
          candidate.isolatedResource.sandboxMilliseconds,
          "sandbox_milliseconds",
        );
      if (siblingRefresh) {
        if (candidate.validation.outputTreeSha !== siblingRefresh.outputTreeSha)
          throw new Error("adopted refresh checkpoint differs from its planned tree");
        await this.#assertSiblingRefreshCurrent(
          { reservation: reserved, pull },
          siblingRefresh,
          observed.merged,
        );
      }
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
          this.#invokeSemanticReview(
            {
              repository: this.#options.repository,
              objectiveNumber: this.#run.objective,
              workItemNumber: item.number,
              packet,
              artifact: artifact!,
              evidence: candidate!.validation,
              publicationBaseBranch: this.#baseBranch,
              requiresIsolation:
                requiresIsolatedCandidate || this.#policy.trust === "sandbox_untrusted",
              ...(model ? { modelSelection: model } : {}),
            },
            checkpoint,
            invocationId,
            () => this.#admitModelInvocation(invocationId, item.id, undefined, item.number),
            (error) =>
              this.#recordProviderQuotaGate(
                error,
                item.id,
                "management",
                this.#management.id,
                undefined,
                item.number,
              ),
          );
      }
      await this.#reviewTransaction({
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
        recordProviderGate: (error) =>
          this.#recordProviderQuotaGate(
            error,
            item.id,
            "management",
            this.#management.id,
            undefined,
            item.number,
          ),
        recordOutcome: async (review) => {
          if (!review.review.accepted || review.review.unmetCriteria.length > 0)
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
    if (candidate?.isolatedResource) {
      // Re-read the authenticated capacity/native/completion/review receipts before
      // an irreversible merge. The entry snapshot predates this paid invocation.
      const settled = await this.#reader.readObjective(this.#run.objective);
      this.#fenceSnapshot(settled);
      await this.#resumeObservedRun(settled, new RunManager(this.#store));
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
      siblingRefresh,
    );
  }

  #integrationDue(workItem: number): boolean {
    return (this.#integrationWaits.get(workItem)?.until ?? 0) <= Date.now();
  }

  async #waitForProgress(
    activeExecutions: ContinuousExecutionPool<number>,
    executionRevision: number,
    fairnessRevision: number,
    objectiveDeadline: number,
  ): Promise<void> {
    const normalMaximum =
      activeExecutions.size === 0
        ? (this.#options.pollIntervalMs ?? 60_000)
        : (this.#options.pollIntervalMs ?? 2_000);
    const maximumMs = Math.max(1, Math.min(normalMaximum, objectiveDeadline - Date.now()));
    const settled = await waitForProgress({
      executions: activeExecutions,
      executionRevision,
      fairness: this.#fairness,
      fairnessRevision,
      maximumMs,
      retryDeadlines: [...this.#integrationWaits.values()].map((wait) => wait.until),
      ...(this.#options.signal ? { signal: this.#options.signal } : {}),
    });
    if (settled?.error) throw new ClaimedExecutionFailure(settled);
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
    siblingRefresh?: SiblingRefreshRecord,
  ): Promise<boolean> {
    const packet = this.#packetFor(item.number);
    const bootstrapCommand =
      packet.validationCommands.length === 1
        ? bootstrapPackageValidationCommand(packet.validationCommands[0]!)
        : null;
    if (bootstrapCommand && packet.allowedPaths.includes("package.json")) {
      const sourceBase = await this.#store.readCommit(pull.exactHeadValidation.baseSha);
      const basePackageJson = await this.#store.readTreeEntry(sourceBase.treeOid, "package.json");
      if (basePackageJson === null) {
        const current = await this.#store.readPullRequest(pull.number);
        if (!current.merged)
          throw new Error(
            `greenfield bootstrap pull request #${pull.number} passed bounded validation but changes dependency authority; review and merge it by hand before recovering the Objective`,
          );
      }
    }
    const observedSource = await this.#store.readPullRequest(pull.number);
    if (!observedSource.merged) {
      await ensureLocalCommit(this.#options.repository, pull.exactHeadValidation.baseSha);
      await ensureLocalCommit(this.#options.repository, pull.commitSha);
      const sensitiveOutput = await hostGit(
        this.#options.repository,
        [
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          pull.exactHeadValidation.baseSha,
          pull.commitSha,
          "--",
          ...EXECUTION_AFFECTING_GIT_PATHS,
        ],
        256 * 1024,
        true,
      );
      const changedPaths = sensitiveOutput.split("\0").filter(Boolean);
      const sensitive = changedPaths.flatMap((path) => {
        const reason = executionAffectingReason(path);
        return reason === null ? [] : [{ path, reason }];
      });
      if (sensitiveOutput.length > 0) {
        throw new Error(
          `pull request #${pull.number} changes a security-sensitive execution surface and ` +
            `must be reviewed and merged by a human` +
            (sensitive.length > 0
              ? `: ${sensitive.map(({ path, reason }) => `${path} (${reason})`).join("; ")}`
              : "; the bounded sensitive-path listing was truncated"),
        );
      }
    }
    if (siblingRefresh) {
      if (deliveryHeadSha || candidate?.identity.deliveryHeadSha !== siblingRefresh.plannedHeadSha)
        throw new Error("sibling integration lacks its distinct changed-head validation identity");
      deliveryHeadSha = siblingRefresh.plannedHeadSha;
    }
    for (;;) {
      await this.#lease.renewIfNeeded();
      const validatedBase =
        candidate?.identity.targetBaseSha ??
        (adoptedSource ? pull.exactHeadValidation.baseSha : reservation.baseSha);
      const readiness = await this.#serializeIntegration(async () => {
        // Cheap non-authoritative readiness avoids creating coordination records during
        // ordinary pending-check polls. All checks are repeated under the shared claim.
        // GitHub can expose the newly advanced target ref before it refreshes
        // the PR's base metadata. That lag is a wait, not a failed candidate.
        // Check it before integrationReadiness classifies a base mismatch as
        // failure; the same evidence is re-read under the admission claim.
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
        const observedReadiness = await integrationReadiness(
          this.#store,
          pull,
          validatedBase,
          this.#baseBranch,
          {
            ciExpected: this.#ciExpectedOnPullRequests,
            ...(candidate ? { mergeCandidateValidation: candidate.evidence } : {}),
            ...(siblingRefresh
              ? { siblingRefresh }
              : deliveryHeadSha
                ? { mergeCandidateDeliveryHeadSha: deliveryHeadSha }
                : {}),
          },
        );
        if (observedReadiness.state !== "ready") return observedReadiness;
        const controller = this.#lease;
        const capturedOwner = await controller.use(async (lease) => ({
          epoch: lease.epoch,
          fence: controller.captureMutationFence(),
        }));
        return withIntegrationAdmission(
          this.#store,
          {
            repository: `${this.#options.owner}/${this.#options.repo}`,
            branch: this.#baseBranch,
            objective: this.#run.objective,
            runId: this.#run.runId,
            epoch: capturedOwner.epoch,
            pullRequest: pull.number,
            headSha: deliveryHeadSha ?? pull.commitSha,
            baseSha: validatedBase,
            outputTreeSha:
              candidate?.validation.outputTreeSha ?? pull.exactHeadValidation.outputTreeSha,
          },
          () => capturedOwner.fence(0),
          async (admission) => {
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
                ...(siblingRefresh
                  ? { siblingRefresh }
                  : deliveryHeadSha
                    ? { mergeCandidateDeliveryHeadSha: deliveryHeadSha }
                    : {}),
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
                  reason:
                    "GitHub test-merge tree differs from the independently validated candidate",
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
            await admission.markDispatched("regular");
            let mergeSha: string;
            try {
              mergeSha = await this.#store.mergePullRequest({
                number: pull.number,
                headSha: current.headSha,
                commitTitle: item.title,
              });
            } catch (error) {
              if ((error as { status?: number })?.status === 409) {
                await admission.authoritativeNonExecution({
                  kind: "regular-http-rejection",
                  status: 409,
                });
              }
              throw error;
            }
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
          },
        );
      }).catch((error: unknown) => {
        if (error instanceof IntegrationAdmissionPendingError)
          return { state: "wait" as const, reason: error.message };
        throw error;
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
        // Candidate validation can span another completed sibling observation.
        // Do not project a second integration from the earlier loop snapshot.
        const latest = await this.#reader.readObjective(this.#run.objective);
        this.#fenceSnapshot(latest);
        this.#sequences.observe(snapshotEvents(latest));
        const latestItem = latest.workItems.find((entry) => entry.number === item.number);
        if (!latestItem)
          throw new Error("integrated Work Item disappeared before outcome projection");
        const recorded = (latestItem.factoryEvents ?? []).filter(
          (candidate) =>
            candidate.kind === "attempt" &&
            candidate.runId === reservation.runId &&
            candidate.attempt === reservation.attempt &&
            candidate.event === "AttemptIntegrated",
        );
        if (
          recorded.some((event) => event.kind !== "attempt" || event.headSha !== readiness.headSha)
        )
          throw new Error("existing integration receipt conflicts with the exact observed squash");
        if (!latestItem.closed) await this.#store.closeIssue(item.number);
        if (recorded.length === 0) {
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
    return withArtifactContentScope(() => this.#resumeIntegrationWithArtifactContent(item));
  }

  async #resumeIntegrationWithArtifactContent(item: DerivedWorkItem): Promise<boolean> {
    if (!this.#integrationDue(item.number)) return false;
    if (
      this.#deliverySelection.selected === "native-stacks" ||
      (item.factoryEvents ?? []).some(
        (event) =>
          event.kind === "publication" &&
          event.runId === this.#run.runId &&
          event.event === "PublicationRecorded" &&
          event.branch === publicationBranch(this.#run.objective, item.number, event.attempt),
      )
    ) {
      try {
        const member = await this.#nativeStackMember(item);
        const current = await this.#store.readPullRequest(member.pull.number);
        if (current.baseRef !== this.#baseBranch || (current.state !== "open" && !current.merged)) {
          throw new Error("sibling pull request identity or target changed after publication");
        }
        let targetBaseSha: string;
        if (current.merged) {
          if (!current.mergeCommitSha)
            throw new Error("merged sibling has no merge commit identity");
          const merge = await this.#store.readCommit(current.mergeCommitSha);
          if (merge.parentOids.length !== 1)
            throw new Error("merged sibling is not a squash commit");
          targetBaseSha = merge.parentOids[0]!;
        } else {
          targetBaseSha = (await this.#store.getBranchHead(this.#baseBranch)).oid;
        }
        const refresh =
          targetBaseSha === member.pull.exactHeadValidation.baseSha ||
          (current.merged && current.headSha === member.pull.commitSha)
            ? undefined
            : await this.#prepareSiblingRefresh(item, member, targetBaseSha, current.merged);
        if (!refresh && current.headSha !== member.pull.commitSha)
          throw new Error("sibling head changed without an authorized refresh");
        const candidate =
          targetBaseSha === member.pull.exactHeadValidation.baseSha
            ? undefined
            : await this.#prepareSiblingMergeCandidate(
                item,
                member,
                targetBaseSha,
                current.merged,
                refresh,
              );
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
          false,
          undefined,
          refresh,
        );
      } catch (error) {
        if (
          error instanceof SiblingRefreshTargetAdvancedError ||
          error instanceof SiblingRefreshObservationPendingError
        )
          return this.#deferIntegration(item.number, error.message);
        throw error;
      }
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
    const published: PublishedPullRequest = {
      branch: receipt.branch,
      commitSha: event.headSha,
      number: pull.number,
      htmlUrl: pull.htmlUrl,
      exactHeadValidation,
    };
    const current = await this.#store.readPullRequest(pull.number);
    const merge =
      current.merged && current.mergeCommitSha
        ? await this.#store.readCommit(current.mergeCommitSha)
        : null;
    if (current.merged && (!merge || merge.parentOids.length !== 1))
      throw new Error("completed ordinary integration lacks an exact squash parent");
    const targetBaseSha = merge
      ? merge.parentOids[0]!
      : (await this.#store.getBranchHead(this.#baseBranch)).oid;
    // Provider-managed branches remain provider-owned. Validate GitHub's exact
    // test-merge candidate under the independently authorized validator instead
    // of rewriting their head or bypassing stale-base checks.
    const candidate =
      targetBaseSha === validation.baseSha
        ? undefined
        : await this.#prepareSiblingMergeCandidate(
            item,
            {
              receipt,
              pull: published,
              reservation,
              observedHeadSha: current.headSha,
            },
            targetBaseSha,
            current.merged,
          );
    if (candidate === null)
      return this.#deferIntegration(
        item.number,
        "waiting for ordinary merge-candidate validation capacity",
      );
    return await this.#integrate(
      item,
      reservation,
      published,
      this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
      true,
      candidate,
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

  /** Continue a predecessor's durable successful bytes under a new, explicitly
   * non-dispatching successor reservation. The predecessor execution remains the
   * sole owner of its model/native accounting; this reservation only owns the
   * validation, review and publication that follow. */
  async #recoverAdoptedRetainedArtifact(item: DerivedWorkItem, deadline: number): Promise<void> {
    const runtime = this.#recoveryRuntime!;
    const planned = runtime.planRecord.plan.items.find((entry) => entry.workItem === item.number);
    const source = planned?.source;
    if (planned?.action !== "reconcile" || !source?.artifactDigest)
      throw new Error("retained artifact reconciliation is absent from the accepted plan");
    const reservations = await this.#attempts.list(this.#run.objective, item.number);
    const sourceReservation = reservations.find(
      (candidate) =>
        candidate.runId === source.runId &&
        candidate.attempt === source.attempt &&
        candidate.oid === source.reservationCommitOid &&
        candidate.ref === source.reservationRef,
    );
    if (!sourceReservation) throw new Error("retained artifact source reservation is unavailable");
    const sourcePacket = this.#packetBoundToReservation(item, sourceReservation);
    if (
      sourceReservation.localScopeBatch?.identity.invocationDigest !==
      workerPacketDigest(sourcePacket)
    )
      throw new Error("retained artifact differs from its original scoped invocation");
    const packet = parseWorkerPacket({
      ...sourcePacket,
      requirements: {
        ...sourcePacket.requirements,
        ...(this.#policy.trust === "sandbox_untrusted" &&
        sourcePacket.requirements.trust === "trusted_local"
          ? { trust: "isolated" as const }
          : {}),
      },
    });
    const events = runtime.events.filter(
      (event) =>
        event.runId === source.runId &&
        "workItem" in event &&
        event.workItem === item.number &&
        "attempt" in event &&
        event.attempt === source.attempt,
    );
    const succeeded = events.filter(
      (event) =>
        event.kind === "attempt" &&
        event.event === "AttemptSucceeded" &&
        event.artifactDigest === source.artifactDigest,
    );
    if (
      succeeded.length !== 1 ||
      events.some(
        (event) =>
          event.kind === "validation" ||
          (event.kind === "capacity" && event.phase === "validation") ||
          (event.kind === "attempt" &&
            [
              "AttemptCollected",
              "AttemptValidated",
              "AttemptPublished",
              "AttemptIntegrated",
              "AttemptFailed",
              "AttemptTimedOut",
              "AttemptCancelled",
              "AttemptDeferred",
            ].includes(event.event)),
      )
    )
      throw new Error("retained artifact source has incompatible later lifecycle evidence");
    const backend = this.#registry.get(sourceReservation.backend);
    if (!backend || backend.capabilities.providerManagedPublication || !backend.reconcileStale)
      throw new Error("retained artifact source backend cannot prove its execution absent");
    if (packet.requirements.trust !== "trusted_local" || !backend.capabilities.hostExecution)
      throw new Error(
        "retained artifact reconciliation requires a separately authorized independent-validation allowance",
      );
    const model = events.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.phase === "execution" &&
        event.unit === "model_tokens",
    );
    const reported = succeeded[0]!.kind === "attempt" ? succeeded[0]!.reportedModelTokens : null;
    if (
      this.#policy.economics &&
      backend.capabilities.reportsModelUsage &&
      (reported === undefined ||
        model.length !== 1 ||
        model[0]?.kind !== "budget" ||
        model[0].amount !== reported)
    )
      throw new Error("retained artifact lacks exact predecessor model accounting");
    const nativeUnit = isSandboxBackendId(sourceReservation.backend)
      ? "sandbox_milliseconds"
      : "local_milliseconds";
    const native = events.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.phase === "execution" &&
        event.unit === nativeUnit,
    );
    if (native.length !== 1 || unreconciledBudgetReservations(events).length)
      throw new Error("retained artifact lacks exact predecessor native accounting");
    await backend.reconcileStale({
      repository: `${this.#options.owner}/${this.#options.repo}`,
      objective: sourceReservation.objective,
      workItem: sourceReservation.workItem,
      attempt: sourceReservation.attempt,
      runId: sourceReservation.runId,
      directorEpoch: sourceReservation.directorEpoch,
      policyDigest: sourceReservation.policyDigest,
      phase: "execution",
      localScopeBatch: sourceReservation.localScopeBatch,
      ...(() => {
        const started = events.find(
          (event) => event.kind === "attempt" && event.event === "AttemptStarted",
        );
        return started?.kind === "attempt" && started.providerResourceId
          ? { providerResourceId: started.providerResourceId }
          : {};
      })(),
    });
    const artifact = await resumeArtifactTransfer({
      store: this.#store,
      identity: this.#artifactTransferIdentity(sourceReservation),
      allowedPaths: packet.allowedPaths,
      assertCurrent: () => this.#externalAdmission(async () => {}),
    });
    if (!artifact || artifact.digest !== source.artifactDigest)
      throw new ArtifactCompletionUnavailableError();
    this.#retainArtifactContent(artifact);
    const base = await this.#store.readCommit(sourceReservation.baseSha);
    let reservation = reservations
      .filter((candidate) => candidate.runId === this.#run.runId)
      .sort((left, right) => right.attempt - left.attempt)[0];
    const existingConsumer = Boolean(reservation);
    if (
      reservation &&
      (reservation.attempt <= sourceReservation.attempt ||
        reservation.backend !== sourceReservation.backend ||
        reservation.baseSha !== sourceReservation.baseSha ||
        reservation.policyDigest !== this.#run.policyDigest ||
        Boolean(reservation.localScopeBatch) ||
        reservation.artifactConsumer?.sourceRunId !== source.runId ||
        reservation.artifactConsumer.sourceReservationOid !== sourceReservation.oid ||
        reservation.artifactConsumer.sourceAttempt !== source.attempt ||
        reservation.artifactConsumer.artifactDigest !== source.artifactDigest ||
        reservation.artifactConsumer.recoveryPlanCommitOid !== runtime.planRecord.commitOid ||
        reservation.artifactConsumer.recoveryClaimOid !== runtime.claim.oid)
    )
      throw new Error("existing successor artifact consumer differs from the accepted source");
    if (!reservation)
      await this.#lease.use(async (lease) => {
        const reassignmentAuthorityReceiptOid = await this.#reconcileIssueAdmissionHistory(
          item,
          lease,
          base,
        );
        const admission = sourceReservation.admission ?? {
          admissionClass: "local" as const,
          admissionReason: "local-capacity" as const,
          requestedCpu: 1,
          requestedMemoryMb: 512,
          priorityRank: 0,
          prioritySource: "subissue-order" as const,
          subIssuePosition: 0,
          criticalPathLength: 0,
          unfinishedDownstream: 0,
        };
        reservation = await this.#attempts.reserve({
          ...(reassignmentAuthorityReceiptOid ? { reassignmentAuthorityReceiptOid } : {}),
          lease,
          workItem: item.number,
          workItemNodeId: item.id,
          backend: sourceReservation.backend,
          base,
          sequence: this.#sequences.take(),
          admission,
          binding: async (attempt) => {
            const projection = this.#compiledProjection;
            if (
              !projection ||
              !projection.bindings.some(
                (binding) => binding.issueNodeId === item.id && binding.issueNumber === item.number,
              )
            )
              throw new Error("artifact consumer requires its immutable graph projection");
            const projectionCommit = await this.#store.readCommit(projection.commitOid);
            if (projectionCommit.parentOids.length !== 1)
              throw new Error("artifact consumer graph projection ancestry is invalid");
            const capacityReservationId = capacityReservationKey({
              objective: this.#run.objective,
              workItem: item.number,
              attempt,
              phase: "execution",
              backendId: sourceReservation.backend,
            });
            return {
              graphDigest: projection.graphDigest,
              graphCommitOid: projectionCommit.parentOids[0]!,
              projectionCommitOid: projection.commitOid,
              capacityReservationId,
              budgetReservationId: `${this.#run.runId}:${item.number}:${attempt}:artifact-consumer:none`,
              resourceIdentity: JSON.stringify([
                this.#run.objective,
                this.#run.runId,
                item.number,
                attempt,
                "retained-artifact-consumer",
                source.runId,
                source.artifactDigest,
              ]),
              artifactConsumer: {
                sourceRunId: source.runId,
                sourceReservationOid: sourceReservation.oid,
                sourceAttempt: source.attempt,
                artifactDigest: source.artifactDigest!,
                recoveryPlanCommitOid: runtime.planRecord.commitOid,
                recoveryClaimOid: runtime.claim.oid,
              },
            };
          },
        });
      });
    if (!reservation) throw new Error("artifact consumer reservation did not complete");
    const consumerAdmission = (await this.#attempts.ledger.read(item.number))?.history.find(
      (entry) => entry.reservation.oid === reservation!.oid,
    );
    if (
      !consumerAdmission?.artifactConsumer ||
      consumerAdmission.dispatchPossible ||
      consumerAdmission.imported ||
      consumerAdmission.reassignmentReceiptOid !== runtime.claim.oid ||
      consumerAdmission.artifactConsumer.sourceRunId !== source.runId ||
      consumerAdmission.artifactConsumer.sourceReservationOid !== sourceReservation.oid ||
      consumerAdmission.artifactConsumer.sourceAttempt !== source.attempt ||
      consumerAdmission.artifactConsumer.artifactDigest !== source.artifactDigest ||
      consumerAdmission.artifactConsumer.recoveryPlanCommitOid !== runtime.planRecord.commitOid ||
      consumerAdmission.artifactConsumer.recoveryClaimOid !== runtime.claim.oid
    )
      throw new Error("artifact consumer admission differs from the accepted recovery authority");
    await persistArtifactTransfer({
      store: this.#store,
      identity: this.#artifactTransferIdentity(reservation),
      artifact,
      allowedPaths: packet.allowedPaths,
      assertCurrent: () => this.#externalAdmission(async () => {}),
    });
    if (
      existingConsumer &&
      (item.factoryEvents ?? []).some(
        (event) =>
          event.kind === "attempt" &&
          event.runId === reservation!.runId &&
          event.attempt === reservation!.attempt &&
          event.event === "AttemptSucceeded" &&
          event.artifactDigest === source.artifactDigest,
      )
    )
      await this.#settleArtifactConsumerAdmission(item, reservation, {
        reservation: sourceReservation,
        artifactDigest: source.artifactDigest,
      });
    if (existingConsumer) {
      await this.#continueCollectedArtifact(item, deadline, {
        reservation,
        packet,
        artifact,
        nativeUsage: { unit: nativeUnit, amount: 0 },
        adoptedSource: { reservation: sourceReservation, artifactDigest: source.artifactDigest },
      });
      return;
    }
    await this.#continueCollectedArtifact(item, deadline, {
      reservation,
      packet,
      artifact,
      nativeUsage: { unit: nativeUnit, amount: 0 },
      adoptedSource: { reservation: sourceReservation, artifactDigest: source.artifactDigest },
    });
  }

  /** Terminal drains reconcile ownership only; they never resume artifact, review, or publication work. */
  async #reconcileInterruptedForEarlyTerminal(
    item: DerivedWorkItem,
    objectiveItems: readonly DerivedWorkItem[],
    terminalEvent: "AttemptCancelled" | "AttemptTimedOut" | "AttemptDeferred",
  ): Promise<void> {
    if (
      (item.factoryEvents ?? []).some(
        (event) =>
          event.kind === "provider" &&
          event.event === "ProviderQuotaBlocked" &&
          event.runId === this.#run.runId,
      )
    ) {
      await this.#recoverInterrupted(item, this.#run.startedAt.getTime(), objectiveItems);
      return;
    }
    const reservations = await this.#attempts.list(this.#run.objective, item.number);
    const reservation = reservations
      .filter((candidate) => candidate.runId === this.#run.runId)
      .sort((left, right) => right.attempt - left.attempt)[0];
    if (!reservation)
      throw new Error(`Work Item #${item.number} has recoverable state but no attempt ref`);
    const events = (item.factoryEvents ?? [])
      .filter(
        (event) =>
          event.runId === this.#run.runId &&
          "attempt" in event &&
          event.attempt === reservation.attempt,
      )
      .sort((left, right) => left.sequence - right.sequence);
    const artifactConsumer = reservation.artifactConsumer;
    const artifactConsumerSucceeded =
      artifactConsumer &&
      events.some(
        (event) =>
          event.kind === "attempt" &&
          event.event === "AttemptSucceeded" &&
          event.artifactDigest === artifactConsumer.artifactDigest,
      );
    let adoptedSource: NonNullable<CollectedAttemptContinuation["adoptedSource"]> | undefined;
    if (artifactConsumerSucceeded) {
      const sourceReservation = reservations.find(
        (candidate) =>
          candidate.runId === artifactConsumer.sourceRunId &&
          candidate.oid === artifactConsumer.sourceReservationOid &&
          candidate.attempt === artifactConsumer.sourceAttempt,
      );
      if (!sourceReservation)
        throw new Error(
          "retained artifact source reservation is unavailable during terminal drain",
        );
      adoptedSource = {
        reservation: sourceReservation,
        artifactDigest: artifactConsumer.artifactDigest,
      };
      if (this.#hasPostSuccessManagementLiabilities(events)) {
        // A restarted controller cannot prove whether an admitted semantic-review
        // invocation completed or what it cost. Keep the run nonterminal until
        // exact result/usage evidence settles that dispatch.
        throw new ProviderQuotaDrainIncompleteError();
      }
      if (!this.#hasPostSuccessValidationLiabilities(events)) {
        await this.#settleArtifactConsumerAdmission(item, reservation, adoptedSource);
        return;
      }
    }
    if (!adoptedSource && (await this.#recoverUndispatchedAdmission(item, reservation))) return;
    const backend = this.#registry.get(reservation.backend);
    if (!backend) throw new Error(`cannot reconcile unavailable backend ${reservation.backend}`);
    await this.#reconcileInterruptedValidationCapacity(item, reservation, events);
    const started = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptStarted",
    );
    const providerResourceId = started?.kind === "attempt" ? started.providerResourceId : undefined;
    const executionBudget = unreconciledBudgetReservations(events).find(
      (budget) =>
        budget.phase === "execution" &&
        ["local_milliseconds", "sandbox_milliseconds", "managed_sessions"].includes(budget.unit),
    );
    const noHandleReplacementNotBefore =
      !providerResourceId && executionBudget?.unit === "sandbox_milliseconds"
        ? new Date(
            new Date(executionBudget.at).getTime() + executionBudget.amount + 60_000,
          ).toISOString()
        : undefined;
    // An artifact consumer never owned execution; only its separately admitted
    // validation resource can require stale-resource reconciliation.
    if (!adoptedSource) {
      if (backend.reconcileStale) {
        await backend.reconcileStale({
          repository: `${this.#options.owner}/${this.#options.repo}`,
          objective: reservation.objective,
          workItem: reservation.workItem,
          attempt: reservation.attempt,
          runId: reservation.runId,
          directorEpoch: reservation.directorEpoch,
          phase: "execution",
          ...(reservation.localScopeBatch ? { localScopeBatch: reservation.localScopeBatch } : {}),
          policyDigest: reservation.policyDigest,
          ...(providerResourceId ? { providerResourceId } : {}),
          ...(noHandleReplacementNotBefore ? { noHandleReplacementNotBefore } : {}),
        });
      } else if (started) {
        throw new Error(
          `backend ${reservation.backend} cannot prove the stale resource was stopped`,
        );
      }
    }
    const validationStartedAt = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptCollected",
    )?.at;
    for (const budget of unreconciledBudgetReservations(events)) {
      if (budget.unit === "model_tokens") continue;
      const phaseStart = budget.phase === "validation" ? validationStartedAt : started?.at;
      const elapsed = phaseStart ? Math.max(0, Date.now() - new Date(phaseStart).getTime()) : 0;
      const ambiguousPaidLaunch =
        budget.phase === "execution" && budget.unit === "sandbox_milliseconds" && !started;
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
    if (this.#hasUnfinishedAttempt(item))
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation,
          event: terminalEvent,
          sequence: this.#sequences.take(),
          reason:
            terminalEvent === "AttemptCancelled"
              ? "operator cancellation interrupted the recovered attempt"
              : terminalEvent === "AttemptTimedOut"
                ? "objective deadline interrupted the recovered attempt"
                : "controller retirement deferred the recovered attempt",
          allowRecovery: true,
        }),
      );
    const capacity = await this.#capacitySnapshot();
    for (const held of capacity.reservations.filter(
      (held) =>
        held.objective === reservation.objective &&
        held.workItem === reservation.workItem &&
        held.attempt === reservation.attempt,
    ))
      await this.#releaseCapacity(held.key);
    if (adoptedSource) {
      await this.#settleArtifactConsumerAdmission(item, reservation, adoptedSource);
    } else {
      await this.#settleIssueAdmission(item, reservation, {
        cleanupConfirmed: true,
        definitiveNonExecution: false,
        modelUsageExpected: backend.capabilities.reportsModelUsage ?? false,
      });
    }
    if (await this.#hasUnsettledIssueAdmission(item)) throw new ProviderQuotaDrainIncompleteError();
  }

  async #recoverInterrupted(
    item: DerivedWorkItem,
    deadline: number,
    objectiveItems: readonly DerivedWorkItem[],
  ): Promise<void> {
    return withArtifactContentScope(() =>
      this.#recoverInterruptedWithArtifactContent(item, deadline, objectiveItems),
    );
  }

  async #recoverInterruptedWithArtifactContent(
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
    const adoptedArtifactConsumer =
      this.#plannedRecoveryItem(item.number)?.action === "reconcile" &&
      Boolean(this.#plannedRecoveryItem(item.number)?.source?.artifactDigest);
    // This reservation deliberately never dispatches a worker, but its durable
    // AttemptSucceeded receipt means it is no longer an undispatched intent.
    if (!adoptedArtifactConsumer && (await this.#recoverUndispatchedAdmission(item, reservation)))
      return;
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
    let validation = [...events].reverse().find((event) => event.kind === "validation");
    let semanticallyAccepted = events.some(
      (event) => event.kind === "attempt" && event.event === "AttemptValidated",
    );

    await this.#reconcileInterruptedValidationCapacity(item, reservation, events);

    const providerGate = events.find(
      (event) =>
        event.kind === "provider" &&
        event.event === "ProviderQuotaBlocked" &&
        event.modelInvocationId &&
        event.workItem === reservation.workItem &&
        event.attempt === reservation.attempt,
    );
    if (providerGate?.kind === "provider") {
      const attemptFailed = events.some(
        (event) => event.kind === "attempt" && event.event === "AttemptFailed",
      );
      const started = events.find(
        (event) => event.kind === "attempt" && event.event === "AttemptStarted",
      );
      const providerResourceId =
        started?.kind === "attempt" ? started.providerResourceId : undefined;
      const executionBudget = unreconciledBudgetReservations(events).find(
        (budget) =>
          budget.phase === "execution" &&
          ["local_milliseconds", "sandbox_milliseconds", "managed_sessions"].includes(budget.unit),
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
          ...(reservation.localScopeBatch ? { localScopeBatch: reservation.localScopeBatch } : {}),
          policyDigest: reservation.policyDigest,
          ...(providerResourceId ? { providerResourceId } : {}),
          ...(noHandleReplacementNotBefore ? { noHandleReplacementNotBefore } : {}),
        });
      } else if (started) {
        throw new Error(
          `backend ${reservation.backend} cannot prove the stale resource was stopped`,
        );
      }
      for (const budget of unreconciledBudgetReservations(events)) {
        // The atomic provider batch is the only authority for exact model usage.
        if (budget.unit === "model_tokens") continue;
        const phaseStart =
          budget.phase === "validation"
            ? events.find((event) => event.kind === "attempt" && event.event === "AttemptCollected")
                ?.at
            : started?.at;
        const elapsed = phaseStart ? Math.max(0, Date.now() - new Date(phaseStart).getTime()) : 0;
        const ambiguousPaidLaunch =
          budget.phase === "execution" && budget.unit === "sandbox_milliseconds" && !started;
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
      if (!attemptFailed)
        await this.#lease.use((lease) =>
          this.#attempts.record({
            lease,
            workItemNodeId: item.id,
            reservation,
            event: "AttemptFailed",
            sequence: this.#sequences.take(),
            reason:
              providerGate.accounting === "unknown"
                ? `${providerGate.providerMessage}; model usage remains unknown, so this run cannot currently be recovered`
                : `${providerGate.providerMessage}; provider quota must be restored before explicit recovery`,
            allowRecovery: true,
          }),
        );
      const capacity = await this.#capacitySnapshot();
      for (const held of capacity.reservations.filter(
        (held) =>
          held.objective === reservation.objective &&
          held.workItem === reservation.workItem &&
          held.attempt === reservation.attempt,
      ))
        await this.#releaseCapacity(held.key);
      await this.#settleIssueAdmission(item, reservation, {
        cleanupConfirmed: true,
        definitiveNonExecution: false,
        modelUsageExpected: backend.capabilities.reportsModelUsage ?? false,
        ...(providerGate.accounting === "unknown"
          ? { retainedUnknownModelInvocationId: providerGate.modelInvocationId }
          : {}),
      });
      if (await this.#hasUnsettledIssueAdmission(item))
        throw new ProviderQuotaDrainIncompleteError();
      return;
    }

    if (
      !validation &&
      !events.some(
        (event) =>
          event.kind === "attempt" &&
          ["AttemptFailed", "AttemptTimedOut", "AttemptCancelled", "AttemptDeferred"].includes(
            event.event,
          ),
      )
    ) {
      const collected = events.filter(
        (event): event is Extract<FactoryEvent, { kind: "attempt" }> =>
          event.kind === "attempt" &&
          event.event === "AttemptCollected" &&
          Boolean(event.artifactDigest),
      );
      const digests = new Set(collected.map((event) => event.artifactDigest!));
      if (digests.size === 1) {
        const checkpoint = await this.#validations.load(
          this.#validationIdentity(reservation, [...digests][0]!),
        );
        if (checkpoint) {
          const recoveredValidation = await this.#lease.use((lease) =>
            this.#recorder.validation({
              lease,
              workItemNodeId: item.id,
              reservation,
              evidence: checkpoint.evidence,
              sequence: this.#sequences.take(),
            }),
          );
          if (recoveredValidation.kind !== "validation") {
            throw new Error("validation recovery emitted an unexpected lifecycle receipt");
          }
          validation = recoveredValidation;
          events.push(recoveredValidation);
        }
      }
    }

    if (validation?.kind === "validation" && validation.passed && !semanticallyAccepted) {
      semanticallyAccepted = await this.#recoverMissingInitialReview(
        item,
        reservation,
        events,
        validation,
      );
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
          (candidate) => parseGraphItemMetadata(candidate.body ?? "").id === stackPlan.parentItemId,
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
        if (!parent || parentPublished?.kind !== "attempt" || !parentPublished.headSha) {
          throw new Error(`stack parent ${stackPlan.parentItemId} has no recoverable publication`);
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
      const branch = publicationBranch(this.#run.objective, item.number, reservation.attempt);
      let headSha = await this.#store.readRef(`refs/heads/${branch}`);
      if (!headSha && !backend.capabilities.providerManagedPublication) {
        const collected = [...events]
          .reverse()
          .find((event) => event.kind === "attempt" && event.event === "AttemptCollected");
        if (collected?.kind !== "attempt" || !collected.artifactDigest)
          throw new Error("validated publication recovery has no exact collected artifact");
        const reviewIdentity: ReviewIdentity = {
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
        const review = await this.#reviews.load(reviewIdentity);
        if (!review || !review.review.accepted || review.review.unmetCriteria.length > 0)
          throw new Error(
            "validated publication recovery requires its exact accepted review checkpoint",
          );
        // Repair only the checkpoint's actual counters; this never invokes management.
        await this.#recordReviewUsage(review, item, reservation);
        const packet = parseWorkerPacket({
          ...this.#packetFor(item.number),
          baseSha: reservation.baseSha,
        });
        const artifact = await resumeArtifactTransfer({
          store: this.#store,
          identity: this.#artifactTransferIdentity(reservation),
          allowedPaths: packet.allowedPaths,
          assertCurrent: () => this.#externalAdmission(async () => {}),
        });
        if (
          !artifact ||
          artifact.digest !== collected.artifactDigest ||
          artifact.baseSha !== validation.baseSha ||
          artifact.outcome !== "succeeded"
        )
          throw new Error(
            "validated publication recovery differs from the original retained artifact",
          );
        this.#retainArtifactContent(artifact);
        // The raw-object helper refuses an unavailable base; recovery must not
        // run checkout-configured fetch, credential helpers, hooks, or filters.
        const treeOid = await prepareSiblingRefreshTree({
          repository: this.#options.repository,
          store: this.#store,
          packet,
          artifact,
          expectedOutputTreeSha: validation.outputTreeSha,
          allowSensitiveValidatedRecovery: true,
          assertCurrent: () => this.#lease.assertGeneration("publication"),
        });
        const message = `${item.title}\n\nCloses #${item.number}\nFactory-Artifact: ${artifact.digest}\nFactory-Validation: ${validation.evidenceDigest}`;
        await assertPublicationMutationAuthorized(this.#store, () =>
          this.#lease.assertGeneration("publication"),
        );
        const plannedHead = await this.#store.createCommit({
          treeOid,
          parentOids: [artifact.baseSha],
          message,
        });
        try {
          await this.#assertWorkflowPublicationHeadSafety({
            baseSha: artifact.baseSha,
            headSha: plannedHead,
            baseBranch: recoveryBaseBranch,
          });
        } catch (cause) {
          await this.#holdRecoveredPrepublication(item, reservation, cause);
        }
        try {
          await dispatchPublicationMutation({
            store: this.#store,
            assertCurrent: () => this.#lease.assertGeneration("publication"),
            assertSafety: async () => {
              try {
                await this.#assertWorkflowPublicationHeadSafety({
                  baseSha: artifact.baseSha,
                  headSha: plannedHead,
                  baseBranch: recoveryBaseBranch,
                });
              } catch (cause) {
                throw new PrepublicationApprovalRequiredError(cause);
              }
            },
            mutate: () => this.#store.createRef(`refs/heads/${branch}`, plannedHead),
          });
        } catch (error) {
          if (error instanceof PrepublicationApprovalRequiredError) {
            await this.#holdRecoveredPrepublication(item, reservation, error.cause);
          }
          if (!(await this.#store.readRef(`refs/heads/${branch}`))) throw error;
        }
        headSha = await this.#store.readRef(`refs/heads/${branch}`);
        if (!headSha) throw new Error("validated publication recovery branch is unavailable");
        const restored = await this.#store.readCommit(headSha);
        if (
          restored.treeOid !== treeOid ||
          restored.parentOids.length !== 1 ||
          restored.parentOids[0] !== artifact.baseSha ||
          restored.message.trim() !== message
        )
          throw new Error("validated publication recovery branch has incompatible content");
      }
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
        await this.#lease.assert();
        try {
          await this.#assertWorkflowPublicationHeadSafety({
            baseSha: validation.baseSha,
            headSha,
            baseBranch: recoveryBaseBranch,
          });
        } catch (cause) {
          await this.#holdRecoveredPrepublication(item, reservation, cause);
        }
        let existing = await this.#store.findPullRequestForBranch(branch);
        if (existing && existing.state !== "open" && !existing.merged) {
          throw new Error(`recovery pull request #${existing.number} was closed without merge`);
        }
        if (!existing) {
          try {
            existing = {
              ...(await dispatchPublicationMutation({
                store: this.#store,
                assertCurrent: () => this.#lease.assertGeneration("publication"),
                assertSafety: async () => {
                  try {
                    await this.#assertWorkflowPublicationHeadSafety({
                      baseSha: validation.baseSha,
                      headSha,
                      baseBranch: recoveryBaseBranch,
                    });
                  } catch (cause) {
                    throw new PrepublicationApprovalRequiredError(cause);
                  }
                  await this.#assertPublicationHeadCurrent({ headBranch: branch, headSha });
                },
                mutate: () =>
                  this.#store.createPullRequest({
                    title: item.title,
                    body:
                      `Implements Work Item #${item.number} for Objective #${this.#run.objective}.\n\n` +
                      `Closes #${item.number}\n\n` +
                      `Recovered validation: \`${validation.evidenceDigest}\``,
                    head: branch,
                    base: recoveryBaseBranch,
                  }),
              })),
              state: "open",
              merged: false,
            };
          } catch (error) {
            if (error instanceof PrepublicationApprovalRequiredError) {
              await this.#holdRecoveredPrepublication(item, reservation, error.cause);
            }
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
        {
          const native = this.#deliverySelection.selected === "native-stacks";
          const metadata = stackMetadata ?? parseGraphItemMetadata(item.body ?? "");
          const itemPlan = stackPlan;
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
                unitId: itemPlan?.unitId ?? `delivery/${metadata.id}`,
                itemId: metadata.id,
                workItem: item.number,
                attempt: reservation.attempt,
                revision: 1,
                mode: native ? "native-stacks" : "regular-prs",
                position: itemPlan?.position ?? 0,
                ...(itemPlan?.parentItemId ? { parentItemId: itemPlan.parentItemId } : {}),
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
              reason: "recovered interrupted validated publication",
            }),
          );
          if (native) return;
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

    if (await this.#recoverRetainedArtifact(item, reservation, events, backend, deadline)) return;
    const recoveryAction = this.#recoveryRuntime?.planRecord.plan.items.find(
      (planned) => planned.workItem === item.number,
    );
    if (recoveryAction?.action === "reconcile" && recoveryAction.source?.artifactDigest)
      throw new ArtifactCompletionUnavailableError();

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
    // Ready artifact-transfer recovery is inserted before this provider fallback.
    if (reservation.backend === "codex-app-server/local-worktree" && !validation) {
      await this.#recoverAppServerSession(item, reservation, deadline, events);
      return;
    }
    const providerResourceId = latest?.kind === "attempt" ? latest.providerResourceId : undefined;
    const executionBudget = unreconciledBudgetReservations(events).find(
      (budget) =>
        budget.phase === "execution" &&
        ["local_milliseconds", "sandbox_milliseconds", "managed_sessions"].includes(budget.unit),
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
        ...(reservation.localScopeBatch ? { localScopeBatch: reservation.localScopeBatch } : {}),
        policyDigest: reservation.policyDigest,
        ...(providerResourceId ? { providerResourceId } : {}),
        ...(noHandleReplacementNotBefore ? { noHandleReplacementNotBefore } : {}),
      });
    } else if (
      events.some((event) => event.kind === "attempt" && event.event === "AttemptStarted")
    ) {
      throw new Error(`backend ${reservation.backend} cannot prove the stale resource was stopped`);
    }
    // Exact artifact and provider-session recovery have already had first refusal.
    // Dispatch may have completed before the first collection-marker write, so
    // missing local metadata is not evidence that there is no reusable output.
    const knownTerminal = events.some(
      (event) =>
        event.kind === "attempt" &&
        ["AttemptFailed", "AttemptTimedOut", "AttemptCancelled", "AttemptDeferred"].includes(
          event.event,
        ),
    );
    const dispatchPossible = events.some(
      (event) =>
        (event.kind === "attempt" && event.event === "AttemptStarted") ||
        (event.kind === "budget" &&
          event.event === "BudgetReserved" &&
          event.phase === "execution"),
    );
    if (
      !backend.capabilities.providerManagedPublication &&
      dispatchPossible &&
      !knownTerminal &&
      !validation
    )
      throw new ArtifactCompletionUnavailableError();
    const attemptStartedAt = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptStarted",
    )?.at;
    const validationCouldHaveStartedAt = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptCollected",
    )?.at;
    for (const budget of unreconciledBudgetReservations(events)) {
      // Elapsed time and resource absence cannot measure token consumption.
      // Dispatch markers remain pending until an exact model receipt is recovered.
      if (budget.unit === "model_tokens") continue;
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
    await this.#lease.use(async (lease) =>
      this.#reconcileIssueAdmissionHistory(
        item,
        lease,
        await this.#store.readCommit(reservation.baseSha),
      ),
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

  async #needsDurableAttemptRecovery(
    item: DerivedWorkItem,
    providerGates: readonly ProviderQuotaEvent[],
    includeAnyUnsettledAdmission = false,
  ): Promise<boolean> {
    if (includeAnyUnsettledAdmission) {
      const consumerSuccess = [...(item.factoryEvents ?? [])]
        .reverse()
        .find(
          (event) =>
            event.kind === "attempt" &&
            event.runId === this.#run.runId &&
            event.event === "AttemptSucceeded",
        );
      if (consumerSuccess?.kind === "attempt" && consumerSuccess.artifactDigest) {
        const consumerEvents = (item.factoryEvents ?? []).filter(
          (event) =>
            event.runId === this.#run.runId &&
            "attempt" in event &&
            event.attempt === consumerSuccess.attempt,
        );
        const settledConsumer = (await this.#attempts.ledger.read(item.number))?.history.find(
          (entry) =>
            entry.runId === this.#run.runId &&
            entry.reservation.attempt === consumerSuccess.attempt &&
            entry.artifactConsumer?.artifactDigest === consumerSuccess.artifactDigest,
        );
        if (settledConsumer?.disposition === "released") {
          if (this.#hasPostSuccessManagementLiabilities(consumerEvents)) return true;
          if (!this.#hasPostSuccessValidationLiabilities(consumerEvents)) return false;
          // Validation liabilities still use the item-state/terminal-receipt
          // classification below: an AttemptCollected receipt remains in history
          // after its interrupted validator has been safely reconciled.
        }
      }
    }
    if (["reserved", "in_flight", "validating"].includes(item.state)) return true;
    if (
      item.state === "failed" &&
      (this.#hasUnfinishedAttempt(item) || this.#hasRecoverablePostSuccessCancellation(item))
    )
      return true;
    const providerGated = providerGates.some(
      (gate) => gate.workItem === item.number && gate.attempt !== undefined,
    );
    if (
      providerGated &&
      (this.#hasUnfinishedAttempt(item) || (await this.#hasUnsettledIssueAdmission(item)))
    )
      return true;
    return includeAnyUnsettledAdmission && (await this.#hasUnsettledIssueAdmission(item));
  }

  #hasPostSuccessValidationLiabilities(events: FactoryEvent[]): boolean {
    const validationFinished = events.some((event) => event.kind === "validation");
    return (
      unreconciledCapacityReservations(events).some((event) => event.phase === "validation") ||
      unreconciledBudgetReservations(events).some((event) => event.phase === "validation") ||
      (!validationFinished &&
        events.some((event) => event.kind === "attempt" && event.event === "AttemptCollected"))
    );
  }

  #hasPostSuccessManagementLiabilities(events: FactoryEvent[]): boolean {
    return unreconciledBudgetReservations(events).some(
      (event) => event.phase === "management" && event.unit === "model_tokens",
    );
  }

  async #hasUnsettledIssueAdmission(item: DerivedWorkItem): Promise<boolean> {
    const ledger = await this.#attempts.ledger.read(item.number);
    return Boolean(
      ledger?.history.some(
        (entry) =>
          entry.objective === this.#run.objective &&
          entry.runId === this.#run.runId &&
          entry.disposition !== "released",
      ),
    );
  }

  #isRecoverablePostSuccessCancellation(events: readonly FactoryEvent[]): boolean {
    const attempts = events.filter(
      (event): event is Extract<FactoryEvent, { kind: "attempt" }> => event.kind === "attempt",
    );
    const succeeded = attempts.filter(
      (event) => event.event === "AttemptSucceeded" && Boolean(event.artifactDigest),
    );
    const cancelled = attempts.filter((event) => event.event === "AttemptCancelled");
    return (
      succeeded.length === 1 &&
      cancelled.length === 1 &&
      cancelled[0]!.sequence > succeeded[0]!.sequence &&
      !attempts.some((event) =>
        ["AttemptFailed", "AttemptTimedOut", "AttemptDeferred", "AttemptIntegrated"].includes(
          event.event,
        ),
      ) &&
      !events.some(
        (event) =>
          event.kind === "validation" ||
          (event.kind === "capacity" && event.phase === "validation") ||
          (event.kind === "attempt" &&
            ["AttemptCollected", "AttemptValidated", "AttemptPublished"].includes(event.event)),
      )
    );
  }

  #hasRecoverablePostSuccessCancellation(item: DerivedWorkItem): boolean {
    const attempts = (item.factoryEvents ?? []).filter(
      (event) =>
        event.runId === this.#run.runId &&
        "workItem" in event &&
        event.workItem === item.number &&
        "attempt" in event &&
        typeof event.attempt === "number",
    );
    const latestAttempt = attempts.reduce(
      (highest, event) => Math.max(highest, typeof event.attempt === "number" ? event.attempt : 0),
      0,
    );
    return this.#isRecoverablePostSuccessCancellation(
      attempts.filter(
        (event) => typeof event.attempt === "number" && event.attempt === latestAttempt,
      ),
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
    // Deadline-only recovery skips normal admission, but its fresh terminal
    // receipt still needs this writer's boundary. Ordinary runs reuse the
    // already-recorded boundary without another comment.
    await this.#recordControllerObservation(snapshot);
    await this.#lease.use((lease) =>
      runManager.terminal({
        writer: lease,
        run: this.#run,
        objectiveNodeId: snapshot.id,
        event,
        sequence: this.#sequences.take(),
        ...(reason ? { reason } : {}),
      }),
    );
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
