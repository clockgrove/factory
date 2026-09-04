import { randomUUID } from "node:crypto";
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
import { AttemptManager, type AttemptReservation } from "./control/attempts.js";
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
  type CompiledGraphProjectionBinding,
  type CompiledGraphProjectionRecord,
  type CompiledGraphRecord,
} from "./control/graphs.js";
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
} from "./control/receipts.js";
import { RunManager, type RunState } from "./control/runs.js";
import {
  ReviewCheckpointManager,
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
import { parseWorkerPacket, type WorkerPacket } from "./protocol/worker-packet.js";
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
  renderWorkPacket,
  workerPacketFromCompiled,
  type CompiledObjective,
  type ExistingGraphWorkItem,
} from "./graph.js";
import { GitHubReader, type GitHubOptions } from "./github.js";
import { CodexCliManagementBackend } from "./management/codex-cli.js";
import type {
  CompilationCheckpoint,
  CompilationResult,
  ManagementBackend,
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
} from "./validation/clean-run.js";
import { bindValidationToPublishedHead } from "./validation/plan.js";
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
      if (!record) throw error;
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
  return deduplicateFactoryEvents(snapshot.factoryEvents ?? []).some(
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
  return result.stdout.trim();
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

export interface CompiledGraphSnapshot {
  workItems: Array<{
    id: string;
    number: number;
    title: string;
    body?: string | null;
    blockedBy: Array<{ number: number }>;
  }>;
}

/**
 * Fence every mutable GitHub projection against the immutable per-run graph.
 * This runs after each fresh Objective read and before state derivation, so an
 * issue edit cannot widen a Worker Packet, remove a dependency, or make a
 * missing Work Item look like a completed Objective.
 */
export function assertSnapshotMatchesCompiledGraph(
  graph: CompiledObjective,
  snapshot: CompiledGraphSnapshot,
  projection?: readonly CompiledGraphProjectionBinding[],
): Map<number, WorkerPacket> {
  if (snapshot.workItems.length !== graph.workItems.length) {
    throw new Error(
      `Objective Work Item count ${snapshot.workItems.length} differs from immutable graph count ${graph.workItems.length}`,
    );
  }
  const digest = compiledGraphDigest(graph);
  const compiledById = new Map(graph.workItems.map((item) => [item.id, item]));
  const observedById = new Map<
    string,
    { item: CompiledGraphSnapshot["workItems"][number]; index: number }
  >();
  for (const item of snapshot.workItems) {
    let metadata;
    try {
      metadata = parseGraphItemMetadata(item.body ?? "");
    } catch (error) {
      throw new Error(
        `Work Item #${item.number} does not match the immutable graph: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (observedById.has(metadata.id)) {
      throw new Error(`immutable graph Work Item ${metadata.id} appears more than once`);
    }
    observedById.set(metadata.id, { item, index: metadata.index });
  }

  const packets = new Map<number, WorkerPacket>();
  const bindingById = projection
    ? new Map(projection.map((binding) => [binding.compilerId, binding]))
    : null;
  if (projection && bindingById!.size !== graph.workItems.length) {
    throw new Error("immutable graph projection cardinality differs from the compiled graph");
  }
  for (const [index, expected] of graph.workItems.entries()) {
    const observed = observedById.get(expected.id);
    if (!observed) {
      throw new Error(`immutable graph Work Item ${expected.id} is missing from the Objective`);
    }
    const binding = bindingById?.get(expected.id);
    if (
      bindingById &&
      (!binding ||
        binding.issueNodeId !== observed.item.id ||
        binding.issueNumber !== observed.item.number)
    ) {
      throw new Error(`Work Item ${expected.id} moved from its immutable GitHub issue binding`);
    }
    const expectedMetadata = {
      protocol: "clockgrove.factory/graph-v1" as const,
      id: expected.id,
      graphDigest: digest,
      graphSize: graph.workItems.length,
      index,
      dependsOn: expected.dependsOn,
    };
    const actualMetadata = parseGraphItemMetadata(observed.item.body ?? "");
    if (JSON.stringify(actualMetadata) !== JSON.stringify(expectedMetadata)) {
      throw new Error(`Work Item #${observed.item.number} graph metadata was modified`);
    }
    if (observed.item.title !== expected.title) {
      throw new Error(`Work Item #${observed.item.number} title was modified`);
    }
    const expectedBody = renderWorkPacket(expected, expectedMetadata).trim();
    if ((observed.item.body ?? "").trim() !== expectedBody) {
      throw new Error(`Work Item #${observed.item.number} body was modified`);
    }
    packets.set(observed.item.number, workerPacketFromCompiled(expected));
  }
  if (observedById.size !== compiledById.size) {
    throw new Error("Objective contains Work Items outside the immutable graph");
  }

  const numberById = new Map(
    [...observedById].map(([id, observed]) => [id, observed.item.number] as const),
  );
  for (const expected of graph.workItems) {
    const observed = observedById.get(expected.id)!;
    const expectedBlockers = expected.dependsOn
      .map((id) => numberById.get(id)!)
      .sort((left, right) => left - right);
    const actualBlockers = observed.item.blockedBy
      .map(({ number }) => number)
      .sort((left, right) => left - right);
    if (JSON.stringify(actualBlockers) !== JSON.stringify(expectedBlockers)) {
      throw new Error(`Work Item #${observed.item.number} blocker edges were modified`);
    }
  }
  return packets;
}

export interface GraphProjectionExpectation {
  ref: string;
  blobOid: string;
  graphDigest: string;
  graphSize: number;
}

/** Require one run-actor-authenticated journal receipt for the immutable projection. */
export function assertAuthenticatedGraphProjection(
  events: readonly FactoryEvent[],
  objective: number,
  runId: string,
  expected: GraphProjectionExpectation,
): void {
  const receipts = events.filter(
    (event) =>
      event.kind === "graph" &&
      event.event === "GraphProjected" &&
      event.objective === objective &&
      event.runId === runId,
  );
  if (receipts.length !== 1) {
    throw new Error(
      receipts.length === 0
        ? "immutable graph projection has no authenticated Objective receipt"
        : "immutable graph projection has multiple authenticated Objective receipts",
    );
  }
  const receipt = receipts[0]!;
  if (
    receipt.graphDigest !== expected.graphDigest ||
    receipt.graphSize !== expected.graphSize ||
    receipt.projectionRef !== expected.ref ||
    receipt.projectionBlobSha !== expected.blobOid
  ) {
    throw new Error("authenticated graph projection receipt differs from its immutable ref");
  }
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
  readonly #stacks: GitHubStacks;
  readonly #leases: LeaseManager;
  readonly #attempts: AttemptManager;
  readonly #reviews: ReviewCheckpointManager;
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
  readonly #retryArtifacts = new RetryArtifactCache();
  #durablePackets = new Map<number, WorkerPacket>();
  #compiledGraph: CompiledObjective | null = null;
  #compiledProjection: CompiledGraphProjectionRecord | null = null;

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
    this.#reader = new GitHubReader(github);
    this.#store = new GitHubControlStore(controls);
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

  #externalAdmission<T>(operation: () => Promise<T>): Promise<T> {
    return runWithExternalAdmissionBoundary(
      this.#options.repositoryFence ?? (async () => {}),
      () => this.#lease.assertGeneration("admission"),
      operation,
    );
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

  async run(): Promise<SupervisorResult> {
    this.#compiledGraph = null;
    this.#compiledProjection = null;
    this.#durablePackets.clear();
    await verifyLocalRepository(this.#options.repository, this.#options.owner, this.#options.repo);
    let snapshot = await this.#reader.readObjective(this.#options.objective);
    this.#ciExpectedOnPullRequests = snapshot.ciExpectedOnPullRequests;
    const facts = await this.#store.getRepositoryFacts();
    const actor = await this.#store.getAuthenticatedLogin();
    const runManager = new RunManager(this.#store);
    const resumedRun = runManager.resume(snapshot.factoryEvents ?? []);
    if (resumedRun) {
      if (
        resumedRun.objective !== snapshot.number ||
        resumedRun.repository?.toLowerCase() !== facts.fullName.toLowerCase() ||
        resumedRun.baseBranch !== snapshot.defaultBranch ||
        resumedRun.fork !== facts.fork ||
        (this.#options.activation !== undefined &&
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
      const completed = allDone(derive(snapshot));
      return this.#terminal(
        runManager,
        snapshot,
        completed ? "FactoryRunCompleted" : "FactoryRunEscalated",
        completed ? undefined : "Objective was closed externally before all Work Items completed",
      );
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
    if (this.#options.activation && base.oid !== this.#options.activation.baseSha) {
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
    this.#budgetEvents = initialEvents.filter((event) => event.runId === runId);
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
      this.#run =
        resumedRun ??
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
      const failure = settlements.find((settlement) => settlement.error);
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
        this.#notify("compiling Objective into a dependency graph");
        if (observedGraph.hasReceipt || observedGraph.existing.length > 0) {
          throw new Error("compiled graph receipt exists but its durable graph record is missing");
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
              },
            }),
          ),
        recover: () => graphManager.load(snapshot.number, this.#run.runId),
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
        throw new Error("immutable graph projection has multiple authenticated Objective receipts");
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
        const objective = derive(snapshot);
        if (await this.#repairReservationReceipts(objective.items)) continue;
        if (allDone(objective)) {
          const settlements = await activeExecutions.settle();
          const failure = settlements.find((settlement) => settlement.error);
          if (failure?.error) throw failure.error;
          snapshot = await this.#reader.readObjective(snapshot.number);
          this.#fenceSnapshot(snapshot);
          this.#sequences.observe(snapshotEvents(snapshot));
          if (!allDone(derive(snapshot))) continue;
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

        const reviews = objective.items.filter((item) => item.state === "for_review");
        if (reviews.length > 0) {
          if (this.#deliverySelection.selected !== "native-stacks") {
            for (const item of reviews) await this.#resumeIntegration(item);
            continue;
          }
          let integratedUnit = false;
          for (const unit of this.#deliveryPlan?.units ?? []) {
            const members = unit.items.map((itemId) =>
              objective.items.find((item) => parseGraphItemMetadata(item.body ?? "").id === itemId),
            );
            if (members.some((member) => !member)) {
              throw new Error(`delivery unit ${unit.id} is missing a GitHub Work Item`);
            }
            const typedMembers = members as DerivedWorkItem[];
            if (
              !typedMembers.every((member) => new Set(["for_review", "done"]).has(member.state)) ||
              !typedMembers.some((member) => member.state === "for_review")
            ) {
              continue;
            }
            if (unit.kind === "sibling") {
              await this.#resumeIntegration(typedMembers[0]!);
            } else {
              await this.#integrateNativeStack(unit.id, typedMembers, deadline);
            }
            integratedUnit = true;
            break;
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
                return Boolean(capabilities?.hostExecution && !capabilities.requiresPaidRuntime);
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
          ...snapshotEvents(snapshot).filter((event) => event.runId === this.#run.runId),
        ]);
        const availableBudget = remainingBudget(
          this.#policy,
          deriveBudgetUsage(this.#budgetEvents),
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
              for (const candidate of backends) {
                if (candidate.capabilities && !candidate.capabilities.hostExecution) {
                  candidate.permanentReasons.push(
                    "native stack delivery requires host-owned local execution so publication and cascading revalidation never cross the host trust boundary",
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
      if (this.#options.signal?.aborted && this.#options.shutdownBehavior === "release-lease") {
        return await releaseAfterDrain();
      }
      if (error instanceof LeaseLostError) throw error;
      if (error instanceof PlatformUnavailableError) throw error;
      const unsafeCleanup =
        error instanceof DaytonaResourceCleanupError ||
        (error instanceof Error &&
          /automated replacement is blocked|cannot prove (?:that )?(?:the )?resource absent|may still be (?:active|billable)/i.test(
            error.message,
          ));
      if (unsafeCleanup) throw error;
      if (error instanceof RunCancellationRequestedError) {
        return await terminalAfterDrain("FactoryRunCancelled", error.message);
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
          (attempt) => attempt.runId === this.#run.runId,
        );
        const deferred = new Set(
          (item.factoryEvents ?? []).flatMap((event) =>
            event.kind === "attempt" &&
            event.runId === this.#run.runId &&
            event.event === "AttemptDeferred"
              ? [event.attempt]
              : [],
          ),
        );
        const consumed = prior.filter((attempt) => !deferred.has(attempt.attempt)).length;
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
      if (stopRequested && handle && selected && !executionCleanupConfirmed) {
        try {
          await selected.cancel(handle);
        } catch (cancelError) {
          this.#notify(
            `backend cancellation did not confirm absence; cleanup reconciliation will decide: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
          );
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
    const prefix = record.identity.kind === "rebase" ? "rebase-review" : "review";
    return `${prefix}-${record.identityDigest}`;
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
    validation: CleanValidationResult,
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
      const execution = await this.#registry.select({
        policy: this.#policy,
        requirements,
        budget: budgets,
        estimatedDurationMs: timeoutMs,
        requireHostExecution: this.#deliverySelection.selected === "native-stacks",
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
      this.#run.runId,
      this.#compiledProjection,
    );
  }

  async #nativeStackMember(item: DerivedWorkItem): Promise<NativeStackMember> {
    const publishedEvent = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (event) =>
          event.kind === "attempt" &&
          event.runId === this.#run.runId &&
          event.event === "AttemptPublished" &&
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
    if (!publicationEvent && plan.parentItemId) {
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
  ): Promise<void> {
    const ordered = [...items].sort((left, right) => {
      const leftId = parseGraphItemMetadata(left.body ?? "").id;
      const rightId = parseGraphItemMetadata(right.body ?? "").id;
      const leftPosition =
        this.#deliveryPlan?.items.find((candidate) => candidate.itemId === leftId)?.position ?? 0;
      const rightPosition =
        this.#deliveryPlan?.items.find((candidate) => candidate.itemId === rightId)?.position ?? 0;
      return leftPosition - rightPosition;
    });
    const remaining = ordered.filter((item) => item.state === "for_review");
    if (remaining.length === 0) return;
    const members = await Promise.all(ordered.map((item) => this.#nativeStackMember(item)));
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
          return;
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
      return;
    }

    const mergedDuringRecovery: NativeStackMember[] = [];
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index]!;
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
      if (ordered[index]!.state === "done") continue;
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
        await sleep(this.#options.pollIntervalMs ?? 5_000, this.#options.signal);
        return;
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
      return;
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
    const durableStackNumbers = new Set(
      durableLinks.flatMap((event) => (event.stackNumber ? [event.stackNumber] : [])),
    );
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
    if (
      JSON.stringify(observedPulls) !== JSON.stringify(fullPulls) &&
      JSON.stringify(observedPulls) !== JSON.stringify(remainingPulls)
    ) {
      throw new Error("GitHub stack topology differs from Factory's immutable delivery plan");
    }
    for (const member of members) {
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
    if (
      originalPacket.requirements.trust !== "trusted_local" ||
      !executionBackend?.capabilities.hostExecution
    ) {
      throw new Error(
        `stack Work Item ${member.receipt.itemId} cannot be revalidated on the host because its execution provenance was not trusted-local`,
      );
    }
    await ensureLocalCommit(this.#options.repository, baseSha);
    await ensureLocalCommit(this.#options.repository, headSha);
    const changedPaths = (
      await hostGit(
        this.#options.repository,
        ["diff", "--name-only", "-z", baseSha, headSha],
        MAX_ARTIFACT_PATCH_BYTES + 1_024,
      )
    )
      .split("\0")
      .filter(Boolean);
    const patch = await hostGit(
      this.#options.repository,
      ["diff", "--binary", "--no-ext-diff", baseSha, headSha],
      MAX_ARTIFACT_PATCH_BYTES + 1_024,
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
    const validation = await validateArtifactClean({
      repository: this.#options.repository,
      artifact,
      packet,
    });
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
        const reviewBudget = remainingBudget(this.#policy, deriveBudgetUsage(this.#budgetEvents));
        if (reviewBudget.modelTokens !== null && reviewBudget.modelTokens <= 0) {
          throw new Error("model-token budget is exhausted; refusing rebased semantic review");
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
        recordOutcome: (record) =>
          this.#recordRebaseReviewOutcome(
            record,
            item,
            member.reservation,
            validation,
            rebasedReceipt,
          ),
      });
    } finally {
      await discardValidationResult(validation);
    }
  }

  async #integrate(
    item: DerivedWorkItem,
    reservation: AttemptReservation,
    pull: PublishedPullRequest,
    deadline: number,
    allowRecovery = false,
  ): Promise<void> {
    for (;;) {
      await this.#lease.renewIfNeeded();
      const readiness = await this.#serializeIntegration(async () => {
        const current = await integrationReadiness(
          this.#store,
          pull,
          reservation.baseSha,
          this.#baseBranch,
          { ciExpected: this.#ciExpectedOnPullRequests },
        );
        if (current.state !== "ready") return current;
        const currentBase = await this.#store.getBranchHead(this.#baseBranch);
        if (currentBase.oid !== reservation.baseSha) {
          return {
            state: "failed" as const,
            reason:
              `base branch advanced from validated commit ${reservation.baseSha} ` +
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
          await verifySquashIntegration(this.#store, pull, mergeSha, reservation.baseSha);
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
        await this.#lease.assertGeneration("integration");
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
        return;
      }
      if (readiness.state === "failed") throw new Error(readiness.reason);
      if (Date.now() >= deadline) {
        throw new Error(`integration timed out: ${readiness.reason}`);
      }
      // A pending check is controller state, not a worker-sized blocking task.
      // Return after one observation so stale resources, other reviews, and
      // newly-ready work can progress on the next snapshot.
      return;
    }
  }

  async #resumeIntegration(item: DerivedWorkItem): Promise<void> {
    if (this.#deliverySelection.selected === "native-stacks") {
      const member = await this.#nativeStackMember(item);
      await this.#integrate(
        item,
        member.reservation,
        member.pull,
        this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
        true,
      );
      return;
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
    await this.#integrate(
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
