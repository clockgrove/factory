import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { CodexCliLocalBackend } from "./backends/codex-cli-local.js";
import { GitHubCopilotBackend } from "./backends/github-copilot.js";
import { DaytonaBackend } from "./backends/daytona.js";
import { VercelSandboxBackend } from "./backends/vercel-sandbox.js";
import { AttemptManager, type AttemptReservation } from "./control/attempts.js";
import {
  deriveBudgetUsage,
  remainingBudget,
  unreconciledBudgetReservations,
} from "./control/budget.js";
import { LifecycleRecorder } from "./control/events.js";
import { CompiledGraphManager } from "./control/graphs.js";
import { GitHubControlStore } from "./control/github-store.js";
import { LeaseLostError, LeaseManager, type LeaseState } from "./control/lease.js";
import {
  deduplicateFactoryEvents,
  nextEventSequence,
} from "./control/receipts.js";
import { RunManager, type RunState } from "./control/runs.js";
import type { FactoryEvent } from "./protocol/events.js";
import {
  assertRequirementsWithinPolicy,
  parseRunPolicy,
  policyDigest,
  type RunPolicy,
} from "./protocol/policy.js";
import { parseWorkerPacket } from "./protocol/worker-packet.js";
import {
  BackendRegistry,
  NoExecutionBackendError,
} from "./execution/registry.js";
import type { BackendHandle, ExecutionBackend } from "./execution/backend.js";
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
import type { ManagementBackend } from "./management/backend.js";
import {
  integrationReadiness,
  publicationBranch,
  publishValidated,
  type PublishedPullRequest,
} from "./publication/publisher.js";
import {
  branchRuleBlockers,
  missingRequiredChecks,
  requiredChecks,
} from "./publication/branch-policy.js";
import {
  cleanupLocalWorktree,
  createLocalWorktree,
  type LocalWorktree,
} from "./runtime/local-worktree.js";
import { runContainedProcess } from "./runtime/process-group.js";
import { allDone, derive, ready, type DerivedWorkItem } from "./state.js";
import {
  discardValidationResult,
  validateArtifactClean,
  type CleanValidationResult,
} from "./validation/clean-run.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  PlatformUnavailableError,
} from "./platform.js";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

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
}

export interface SupervisorResult {
  status: "completed" | "cancelled" | "escalated";
  objective: number;
  runId: string;
  reason?: string;
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
  const leaseRenewals = Math.ceil((workItemTimeoutMinutes * 60_000) / 75_000);
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
  const missingIssues = objective.workItems.filter(
    (item) => !existingById.has(item.id),
  ).length;
  const missingDependencies = objective.workItems.reduce((count, item) => {
    const observedItem = existingById.get(item.id);
    return count + item.dependsOn.filter((dependencyId) => {
      const observedDependency = existingById.get(dependencyId);
      return !observedItem ||
        !observedDependency ||
        !observedItem.blockedByNumbers.includes(observedDependency.number);
    }).length;
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
  throw new PlatformUnavailableError(
    { kind: "rate_limit", retryAfterMs },
    new Error(reason),
  );
}

function snapshotEvents(snapshot: Snapshot): FactoryEvent[] {
  return [
    ...(snapshot.factoryEvents ?? []),
    ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
  ];
}

function hasCancellationRequest(snapshot: Snapshot, runId: string): boolean {
  return (snapshot.factoryEvents ?? []).some(
    (event) =>
      event.kind === "run" &&
      event.event === "FactoryRunCancellationRequested" &&
      event.runId === runId,
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

class LeaseController {
  #tail: Promise<void> = Promise.resolve();
  #fatal: unknown;

  constructor(
    private readonly manager: LeaseManager,
    private lease: LeaseState,
    private readonly sequences: SequenceAllocator,
  ) {}

  async use<T>(operation: (lease: LeaseState) => Promise<T>): Promise<T> {
    if (this.#fatal) throw this.#fatal;
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolveLock) => {
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

  async renewIfNeeded(force = false): Promise<void> {
    await this.use(async (lease) => {
      if (!force && lease.expiresAt.getTime() - Date.now() > 45_000) return;
      this.lease = await this.manager.renew(lease, this.sequences.take());
    });
  }

  async release(): Promise<void> {
    await this.use(async (lease) => {
      this.lease = await this.manager.release(lease, this.sequences.take());
    });
  }

  fail(error: unknown): void {
    this.#fatal = error;
  }
}

async function hostGit(repository: string, args: string[]): Promise<string> {
  const result = await runContainedProcess({
    command: "git",
    args,
    cwd: repository,
    env: process.env,
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
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
  if (compiledGraphDigest(completeObjective) !== expectedDigest) {
    throw new Error("persisted Work Item graph does not match its compilation digest");
  }
  return {
    hasReceipt: true,
    expectedDigest,
    expectedSize,
    expectedRef: receipt.graphRef,
    expectedBlobSha: receipt.graphBlobSha,
    receiptRunId: receipt.runId,
    completeObjective,
    existing,
  };
}

export class FactorySupervisor {
  readonly #options: SupervisorOptions;
  #policy: RunPolicy;
  readonly #notify: (message: string) => void;
  readonly #reader: GitHubReader;
  readonly #store: GitHubControlStore;
  readonly #leases: LeaseManager;
  readonly #attempts: AttemptManager;
  readonly #recorder: LifecycleRecorder;
  #management: ManagementBackend;
  readonly #managementOverride: boolean;
  readonly #registry: BackendRegistry;
  readonly #pacer = new ContentCreationPacer();
  readonly #breaker = new CircuitBreaker();
  readonly #concurrency = new ConcurrencyLimiter();
  #sequences!: SequenceAllocator;
  #lease!: LeaseController;
  #run!: RunState;
  #baseBranch = "main";
  #budgetEvents: FactoryEvent[] = [];
  #integrationTail: Promise<void> = Promise.resolve();

  constructor(options: SupervisorOptions) {
    this.#options = { ...options, repository: resolve(options.repository) };
    this.#policy = parseRunPolicy(options.policy);
    this.#notify = options.onStatus ?? (() => {});
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
    };
    this.#reader = new GitHubReader(github);
    this.#store = new GitHubControlStore(controls);
    this.#leases = new LeaseManager({ store: this.#store });
    this.#attempts = new AttemptManager({ store: this.#store, leases: this.#leases });
    this.#recorder = new LifecycleRecorder(this.#store, this.#leases);
    this.#management =
      options.managementBackend ??
      new CodexCliManagementBackend({
        ...(this.#policy.modelProfile ? { profile: this.#policy.modelProfile } : {}),
      });
    this.#managementOverride = options.managementBackend !== undefined;
    this.#registry = options.backendRegistry ?? new BackendRegistry();
    if (!options.backendRegistry) {
      this.#registry.register(
        new CodexCliLocalBackend({
          ...(this.#policy.modelProfile ? { profile: this.#policy.modelProfile } : {}),
        }),
      );
      if (this.#policy.backendOrder.includes("codex-cli/daytona")) {
        this.#registry.register(
          new DaytonaBackend({ repository: this.#options.repository }),
        );
      }
      if (this.#policy.backendOrder.includes("codex-cli/vercel-sandbox")) {
        this.#registry.register(
          new VercelSandboxBackend({ repository: this.#options.repository }),
        );
      }
    }
  }

  async run(): Promise<SupervisorResult> {
    await verifyLocalRepository(
      this.#options.repository,
      this.#options.owner,
      this.#options.repo,
    );
    let snapshot = await this.#reader.readObjective(this.#options.objective);
    const facts = await this.#store.getRepositoryFacts();
    const actor = await this.#store.getAuthenticatedLogin();
    const runManager = new RunManager(this.#store);
    const resumedRun = runManager.resume(snapshot.factoryEvents ?? []);
    if (resumedRun) {
      this.#policy = resumedRun.policy;
      if (!this.#managementOverride) {
        this.#management = new CodexCliManagementBackend({
          ...(this.#policy.modelProfile ? { profile: this.#policy.modelProfile } : {}),
        });
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
        this.#registry.register(
          new VercelSandboxBackend({ repository: this.#options.repository }),
        );
      }
    }
    this.#baseBranch = snapshot.defaultBranch;
    if (!facts.canPush) {
      return this.#startlessEscalation(
        "GitHub identity lacks repository write/push permission required for control refs and pull requests",
      );
    }
    if (facts.fork && this.#policy.trust === "explicitly_activated_repo") {
      return this.#startlessEscalation("trusted-local execution is not allowed for a fork");
    }
    if (
      this.#policy.trust !== "sandbox_untrusted" &&
      (!snapshot.authorLogin || !TRUSTED_ASSOCIATIONS.has(snapshot.authorAssociation ?? ""))
    ) {
      return this.#startlessEscalation("Objective author is not trusted for local execution");
    }
    if (snapshot.closed) {
      if (!resumedRun) {
        return { status: "completed", objective: snapshot.number, runId: "already-closed" };
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
    assertGraphQlAdmissionHeadroom(
      snapshot.graphQlRateLimit,
      this.#policy,
      Math.min(this.#policy.maxParallel, Math.max(1, snapshot.workItems.length)),
      this.#notify,
    );
    if (
      this.#policy.backendOrder.includes("github-copilot/github-managed") &&
      !this.#registry.get("github-copilot/github-managed") &&
      snapshot.copilotBotId
    ) {
      const writer = new GithubOctokitWriter({
        token: this.#options.token,
        owner: this.#options.owner,
        repo: this.#options.repo,
        onThrottle: this.#notify,
      });
      const actorId = await this.#reader.resolveUserId(actor);
      const dispatcher = new Dispatcher({
        writer,
        repositoryId: snapshot.repositoryId,
        copilotBotId: snapshot.copilotBotId,
        defaultBranch: snapshot.defaultBranch,
        escalateToId: actorId,
        onThrottle: this.#notify,
        circuitBreaker: this.#breaker,
        pacer: this.#pacer,
        concurrency: this.#concurrency,
      });
      this.#registry.register(
        new GitHubCopilotBackend({
          reader: this.#reader,
          dispatcher,
          repository: this.#options.repository,
          copilotAvailable: true,
        }),
      );
    }
    const branchRules = await this.#store.readBranchRules(snapshot.defaultBranch);
    const blockers = branchRuleBlockers(branchRules);
    if (blockers.length > 0) {
      return this.#startlessEscalation(`branch policy requires HITL: ${blockers.join(", ")}`);
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
        );
      }
    }
    const managementProbe = await this.#management.probe();
    if (this.#management.id !== this.#policy.managementBackend) {
      return this.#startlessEscalation(
        `run requires management backend ${this.#policy.managementBackend}, but ${this.#management.id} is configured`,
      );
    }
    if (!managementProbe.available || !managementProbe.authenticated) {
      return this.#startlessEscalation(
        managementProbe.reason ?? "management backend unavailable",
      );
    }

    if (resumedRun && resumedRun.actor.toLowerCase() !== actor.toLowerCase()) {
      throw new Error(`active run belongs to ${resumedRun.actor}; ${actor} cannot append its receipts`);
    }
    const base = await this.#store.getBranchHead(snapshot.defaultBranch);
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
      this.#run = resumedRun ?? (await runManager.start({
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
      }));
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
    const deadline =
      this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000;

    try {
      const observedGraph = inspectCompiledGraph(snapshot);
      const graphManager = new CompiledGraphManager(this.#store, this.#leases);
      let durableGraph = await graphManager.load(snapshot.number, this.#run.runId);
      const sourceGraph = durableGraph ?? (
        observedGraph.receiptRunId && observedGraph.receiptRunId !== this.#run.runId
          ? await graphManager.load(snapshot.number, observedGraph.receiptRunId)
          : null
      );
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
      let compiled = sourceGraph?.objective ?? observedGraph.completeObjective;
      if (!compiled) {
        this.#notify(
          "compiling Objective into a dependency graph",
        );
        if (observedGraph.hasReceipt || observedGraph.existing.length > 0) {
          throw new Error("compiled graph receipt exists but its durable graph record is missing");
        }
        const layout = await this.#reader.readRepositoryLayout(undefined, 5_000);
        if (layout.truncated) {
          throw new Error("repository layout is incomplete; compilation would be under-grounded");
        }
        const compilation = await this.#management.compile({
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
        });
        compiled = compilation.objective;
        await this.#lease.use(async (lease) => {
          const event = await this.#recorder.objectiveBudget({
            lease,
            objectiveNodeId: snapshot.id,
            sequence: this.#sequences.take(),
            event: "BudgetReconciled",
            unit: "model_tokens",
            amount: compilation.usage.inputTokens + compilation.usage.outputTokens,
          });
          this.#budgetEvents.push(event);
        });
      }
      assertGraphWithinRunPolicy(compiled, this.#policy);
      await this.#preflightCompiledGraph(compiled);
      let existingGraphItems = observedGraph.existing;
      assertGraphQlAdmissionHeadroom(
        snapshot.graphQlRateLimit,
        this.#policy,
        Math.min(this.#policy.maxParallel, compiled.workItems.length),
        this.#notify,
        pendingGraphQlGraphMutations(compiled, existingGraphItems),
      );
      if (!durableGraph) {
        durableGraph = await this.#lease.use((lease) =>
          graphManager.persist({ lease, base, objective: compiled! }),
        );
      }
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
        beforeMutation: this.#lease.assert,
        onThrottle: this.#notify,
      });
      for (let recovery = 0; ; recovery += 1) {
        const before = JSON.stringify(
          existingGraphItems.map((item) => [
            item.compilerId,
            [...item.blockedByNumbers].sort((a, b) => a - b),
          ]),
        );
        try {
          await graph.apply(compiled, {
            repositoryId: snapshot.repositoryId,
            objectiveIssueId: snapshot.id,
            ...(snapshot.workItemLabelId
              ? { workItemLabelId: snapshot.workItemLabelId }
              : {}),
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
      for (;;) {
        if (heartbeatError) throw heartbeatError;
        if (this.#options.signal?.aborted) {
          return await this.#terminal(
            runManager,
            snapshot,
            "FactoryRunCancelled",
            "operator cancelled run",
          );
        }
        if (Date.now() >= deadline) {
          return await this.#terminal(
            runManager,
            snapshot,
            "FactoryRunEscalated",
            "Objective timeout exhausted",
          );
        }
        await this.#lease.renewIfNeeded();
        snapshot = await this.#reader.readObjective(snapshot.number);
        this.#sequences.observe(snapshotEvents(snapshot));
        if (hasCancellationRequest(snapshot, this.#run.runId)) {
          return await this.#terminal(
            runManager,
            snapshot,
            "FactoryRunCancelled",
            "operator requested cancellation through GitHub",
          );
        }
        const objective = derive(snapshot);
        if (await this.#repairReservationReceipts(objective.items)) continue;
        if (allDone(objective)) {
          await this.#lease.assert();
          await this.#store.closeIssue(snapshot.number);
          return await this.#terminal(runManager, snapshot, "FactoryRunCompleted");
        }

        const inconsistent = objective.items.find(
          (item) => item.state === "inconsistent" || item.state === "escalated",
        );
        if (inconsistent) {
          return await this.#escalate(
            runManager,
            snapshot,
            inconsistent,
            `Work Item is ${inconsistent.state}`,
          );
        }
        const exhausted = objective.items.find(
          (item) =>
            item.state === "failed" &&
            item.attempts >= this.#policy.maxAttemptsPerItem,
        );
        if (exhausted) {
          return await this.#escalate(
            runManager,
            snapshot,
            exhausted,
            `attempt budget exhausted (${exhausted.attempts})`,
          );
        }

        const reviews = objective.items.filter((item) => item.state === "for_review");
        if (reviews.length > 0) {
          for (const item of reviews) await this.#resumeIntegration(item);
          continue;
        }

        const recoverable = objective.items.filter((item) =>
          ["reserved", "in_flight", "validating"].includes(item.state) ||
          (item.state === "failed" && this.#hasUnfinishedAttempt(item)),
        );
        if (recoverable.length > 0) {
          for (const item of recoverable) {
            await this.#recoverInterrupted(item, deadline);
          }
          continue;
        }
        const runnable = ready(objective).filter(
          (item, index, all) =>
            item.attempts < this.#policy.maxAttemptsPerItem &&
            all.findIndex((candidate) => candidate.number === item.number) === index,
        );
        if (runnable.length === 0) {
          await sleep(this.#options.pollIntervalMs ?? 60_000, this.#options.signal);
          continue;
        }
        const wave = runnable.slice(0, this.#policy.maxParallel);
        assertGraphQlAdmissionHeadroom(
          snapshot.graphQlRateLimit,
          this.#policy,
          wave.length,
          this.#notify,
        );
        this.#notify(`starting wave: ${wave.map((item) => `#${item.number}`).join(", ")}`);
        const waveResults = await Promise.allSettled(
          wave.map((item) => this.#execute(item, deadline)),
        );
        const rejected = waveResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (rejected) throw rejected.reason;
      }
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      if (error instanceof PlatformUnavailableError) throw error;
      if (error instanceof RunCancellationRequestedError) {
        return await this.#terminal(
          runManager,
          snapshot,
          "FactoryRunCancelled",
          error.message,
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      return await this.#terminal(runManager, snapshot, "FactoryRunEscalated", reason);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #execute(item: DerivedWorkItem, objectiveDeadline: number): Promise<void> {
    let reservation: AttemptReservation | undefined;
    let worker: LocalWorktree | undefined;
    let validation: CleanValidationResult | undefined;
    let handle: BackendHandle | undefined;
    let selected: ExecutionBackend | undefined;
    let validator: ExecutionBackend | undefined;
    let published: PublishedPullRequest | undefined;
    let budgetUnit:
      | "managed_sessions"
      | "sandbox_milliseconds"
      | "local_milliseconds" = "local_milliseconds";
    let executionBudgetReserved = false;
    let executionBudgetReconciled = false;
    let validationBudgetReserved = false;
    let validationBudgetReconciled = false;
    let validationStartedAt: number | undefined;
    const started = Date.now();
    try {
      const originalPacket = parseWorkerPacketFromIssue(item.body ?? "");
      const base = await this.#store.getBranchHead(this.#baseBranch);
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
      assertRequirementsWithinPolicy(packet.requirements, this.#policy, `Work Item #${item.number}`);
      await ensureLocalCommit(this.#options.repository, base.oid);
      const timeoutMs = Math.min(
        (packet.requirements.timeoutMinutes ?? this.#policy.workItemTimeoutMinutes) *
          60_000,
        Math.max(1, objectiveDeadline - Date.now()),
      );
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
        const budgets = remainingBudget(
          this.#policy,
          deriveBudgetUsage(this.#budgetEvents),
        );
        const choice = await this.#registry.select({
          policy: this.#policy,
          requirements: packet.requirements,
          budget: budgets,
          estimatedDurationMs: timeoutMs,
        });
        selected = choice.backend;
        budgetUnit =
          choice.backend.capabilities.id === "github-copilot/github-managed"
          ? "managed_sessions"
          : choice.backend.capabilities.id.includes("daytona") ||
              choice.backend.capabilities.id.includes("vercel-sandbox")
            ? "sandbox_milliseconds"
            : "local_milliseconds";
        if (packet.requirements.trust !== "trusted_local") {
          const afterExecution = {
            ...budgets,
            sandboxMinutes:
              budgets.sandboxMinutes -
              (budgetUnit === "sandbox_milliseconds" ? timeoutMs / 60_000 : 0),
          };
          validator = (
            await this.#registry.selectIsolatedValidator({
              policy: this.#policy,
              requirements: packet.requirements,
              budget: afterExecution,
              estimatedDurationMs: timeoutMs,
            })
          ).backend;
        }
        reservation = await this.#attempts.reserve({
          lease,
          workItem: item.number,
          workItemNodeId: item.id,
          backend: choice.backend.capabilities.id,
          base,
          sequence: this.#sequences.take(),
        });
        const reservedAmount = budgetUnit === "managed_sessions" ? 1 : timeoutMs;
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
        if (validator) {
          const validationBudget = await this.#recorder.budget({
            lease,
            workItemNodeId: item.id,
            reservation,
            sequence: this.#sequences.take(),
            event: "BudgetReserved",
            unit: "sandbox_milliseconds",
            phase: "validation",
            amount: timeoutMs,
          });
          this.#budgetEvents.push(validationBudget);
          validationBudgetReserved = true;
        }
      });
      if (!selected || !reservation) throw new Error("backend reservation did not complete");
      worker = await createLocalWorktree(this.#options.repository, base.oid);
      await this.#lease.assert();
      handle = await selected.launch({
        objective: this.#run.objective,
        workItem: item.number,
        attempt: reservation.attempt,
        runId: this.#run.runId,
        directorEpoch: reservation.directorEpoch,
        policyDigest: reservation.policyDigest,
        workspace: worker.path,
        packet,
        deadline: new Date(Date.now() + timeoutMs),
      });
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          event: "AttemptStarted",
          sequence: this.#sequences.take(),
          providerResourceId: handle!.resourceId,
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
          if (observation.state !== "succeeded") {
            throw new Error(observation.reason ?? `worker ${observation.state}`);
          }
          break;
        }
        await sleep(this.#options.pollIntervalMs ?? 2_000, this.#options.signal);
      }
      const artifact = await selected.collect(handle);
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
        }),
      );
      await selected.cleanup(handle);
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
      await this.#lease.assert();
      validation = await validateArtifactClean({
        repository: this.#options.repository,
        artifact,
        packet,
        ...(validator
          ? {
              isolatedValidator: () =>
                validator!.validate!({
                  objective: this.#run.objective,
                  workItem: item.number,
                  attempt: reservation!.attempt,
                  runId: this.#run.runId,
                  directorEpoch: reservation!.directorEpoch,
                  policyDigest: reservation!.policyDigest,
                  workspace: worker!.path,
                  packet,
                  artifact,
                  deadline: new Date(Date.now() + timeoutMs),
                }),
            }
          : {}),
      });
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
        if (validator) {
          const sandboxEvent = await this.#recorder.budget({
            lease,
            workItemNodeId: item.id,
            reservation: reservation!,
            sequence: this.#sequences.take(),
            event: "BudgetReconciled",
            unit: "sandbox_milliseconds",
            phase: "validation",
            amount: Date.now() - validationStarted,
          });
          this.#budgetEvents.push(sandboxEvent);
          validationBudgetReconciled = true;
        }
      });
      if (!validation.evidence.passed) {
        throw new Error(validation.evidence.failureReason ?? "validation failed");
      }

      const reviewed = await this.#management.review({
        repository: this.#options.repository,
        objectiveNumber: this.#run.objective,
        workItemNumber: item.number,
        packet,
        artifact,
        evidence: validation.evidence,
      });
      await this.#lease.use(async (lease) => {
        const event = await this.#recorder.budget({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          sequence: this.#sequences.take(),
          event: "BudgetReconciled",
          unit: "model_tokens",
          amount: reviewed.usage.inputTokens + reviewed.usage.outputTokens,
        });
        this.#budgetEvents.push(event);
      });
      if (!reviewed.review.accepted) {
        throw new Error(
          `semantic review rejected: ${reviewed.review.summary}; ${reviewed.review.unmetCriteria.join("; ")}`,
        );
      }
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          event: "AttemptValidated",
          sequence: this.#sequences.take(),
          artifactDigest: artifact.digest,
          reason: reviewed.review.summary,
        }),
      );
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
        };
      } else {
        published = await publishValidated({
          store: this.#store,
          assertLease: this.#lease.assert,
          base,
          validation,
          artifact,
          objective: this.#run.objective,
          workItem: item.number,
          attempt: reservation.attempt,
          title: item.title,
          baseBranch: this.#baseBranch,
        });
      }
      await this.#lease.use((lease) =>
        this.#attempts.record({
          lease,
          workItemNodeId: item.id,
          reservation: reservation!,
          event: "AttemptPublished",
          sequence: this.#sequences.take(),
          artifactDigest: artifact.digest,
          headSha: published!.commitSha,
        }),
      );
      await this.#integrate(item, reservation, published, objectiveDeadline);
    } catch (error) {
      if (error instanceof PlatformUnavailableError) {
        if (handle && selected) await selected.cancel(handle).catch(() => {});
        throw error;
      }
      if (error instanceof LeaseLostError || error instanceof NoExecutionBackendError) throw error;
      const cancellation =
        error instanceof RunCancellationRequestedError || this.#options.signal?.aborted;
      if (cancellation && handle && selected) {
        await selected.cancel(handle).catch(() => {});
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (!published && selected?.capabilities.providerManagedPublication) {
        const managedPull = Number(handle?.metadata?.pullNumber);
        if (Number.isInteger(managedPull) && managedPull > 0) {
          await this.#store.closePullRequest(managedPull).catch(() => {});
        }
      }
      if (published) {
        const current = await this.#store.readPullRequest(published.number).catch(() => null);
        if (current?.merged) throw error;
        await this.#store.closePullRequest(published.number).catch(() => {});
      }
      if (reservation) {
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
        if (validationBudgetReserved && !validationBudgetReconciled) {
          await this.#lease.use(async (lease) => {
            const event = await this.#recorder.budget({
              lease,
              workItemNodeId: item.id,
              reservation: reservation!,
              sequence: this.#sequences.take(),
              event: "BudgetReconciled",
              unit: "sandbox_milliseconds",
              phase: "validation",
              amount: validationStartedAt ? Date.now() - validationStartedAt : 0,
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
          }),
        );
      } else {
        throw error;
      }
      if (cancellation) throw new RunCancellationRequestedError(reason);
      this.#notify(`Work Item #${item.number} failed: ${reason}`);
    } finally {
      if (this.#options.signal?.aborted && handle && selected) {
        await selected.cancel(handle).catch(() => {});
      }
      if (handle && selected) await selected.cleanup(handle).catch(() => {});
      if (worker) await cleanupLocalWorktree(worker).catch(() => {});
      if (validation) await discardValidationResult(validation).catch(() => {});
    }
  }

  async #preflightCompiledGraph(graph: CompiledObjective): Promise<void> {
    const budgets = remainingBudget(
      this.#policy,
      deriveBudgetUsage(this.#budgetEvents),
    );
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
      });
      if (requirements.trust !== "trusted_local") {
        const afterExecution = {
          ...budgets,
          sandboxMinutes:
            budgets.sandboxMinutes -
            (execution.backend.capabilities.id.includes("daytona") ||
            execution.backend.capabilities.id.includes("vercel-sandbox")
              ? timeoutMs / 60_000
              : 0),
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
        await this.#lease.assert();
        const mergeSha = await this.#store.mergePullRequest({
          number: pull.number,
          headSha: current.headSha,
          commitTitle: item.title,
        });
        return { state: "integrated" as const, headSha: mergeSha };
      });
      if (readiness.state === "integrated") {
        await this.#lease.assert();
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
      await sleep(this.#options.pollIntervalMs ?? 5_000, this.#options.signal);
    }
  }

  async #resumeIntegration(item: DerivedWorkItem): Promise<void> {
    const event = [...(item.factoryEvents ?? [])]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (candidate) =>
          candidate.kind === "attempt" &&
          candidate.event === "AttemptPublished" &&
          Boolean(candidate.headSha),
      );
    if (!event || event.kind !== "attempt" || !event.headSha) {
      throw new Error(`Work Item #${item.number} has review state without a published attempt`);
    }
    const pull = item.linkedPullRequests.find((candidate) =>
      candidate.state === "OPEN" || candidate.state === "MERGED",
    );
    if (!pull) {
      throw new Error(`Work Item #${item.number} has no recoverable Factory pull request`);
    }
    const reservation = (await this.#attempts.list(this.#run.objective, item.number)).find(
      (candidate) => candidate.attempt === event.attempt,
    );
    if (!reservation) throw new Error(`attempt ${event.attempt} reservation is missing`);
    await this.#integrate(
      item,
      reservation,
      {
        branch: publicationBranch(this.#run.objective, item.number, event.attempt),
        commitSha: event.headSha,
        number: pull.number,
        htmlUrl: "",
      },
      this.#run.startedAt.getTime() + this.#policy.objectiveTimeoutMinutes * 60_000,
      true,
    );
  }

  async #serializeIntegration<T>(operation: () => Promise<T>): Promise<T> {
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

  async #recoverInterrupted(item: DerivedWorkItem, deadline: number): Promise<void> {
    const reservations = (await this.#attempts.list(this.#run.objective, item.number))
      .filter((candidate) => candidate.runId === this.#run.runId)
      .sort((a, b) => b.attempt - a.attempt);
    const reservation = reservations[0];
    if (!reservation) {
      throw new Error(`Work Item #${item.number} has recoverable state but no attempt ref`);
    }
    const events = (item.factoryEvents ?? [])
      .filter(
        (event) =>
          event.runId === this.#run.runId &&
          "attempt" in event &&
          event.attempt === reservation.attempt,
      )
      .sort((a, b) => a.sequence - b.sequence);
    const latest = [...events]
      .reverse()
      .find((event) => event.kind === "attempt");
    const validation = [...events]
      .reverse()
      .find((event) => event.kind === "validation");
    const semanticallyAccepted = events.some(
      (event) => event.kind === "attempt" && event.event === "AttemptValidated",
    );

    if (validation?.kind === "validation" && validation.passed && semanticallyAccepted) {
      const branch = publicationBranch(
        this.#run.objective,
        item.number,
        reservation.attempt,
      );
      const headSha = await this.#store.readRef(`refs/heads/${branch}`);
      if (headSha) {
        const commit = await this.#store.readCommit(headSha);
        if (commit.treeOid !== validation.outputTreeSha) {
          throw new Error(
            `recovery branch for Work Item #${item.number} does not match validated tree`,
          );
        }
        await this.#lease.assert();
        const existing = await this.#store.findPullRequestForBranch(branch);
        if (existing && existing.state !== "open" && !existing.merged) {
          throw new Error(`recovery pull request #${existing.number} was closed without merge`);
        }
        const pull = existing ?? (await this.#store.createPullRequest({
          title: item.title,
          body:
            `Implements Work Item #${item.number} for Objective #${this.#run.objective}.\n\n` +
            `Closes #${item.number}\n\n` +
            `Recovered validation: \`${validation.evidenceDigest}\``,
          head: branch,
          base: this.#baseBranch,
        }));
        if (pull.headSha !== headSha) {
          throw new Error("recovered pull request head differs from the validated branch");
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
        await this.#integrate(
          item,
          reservation,
          { branch, commitSha: headSha, number: pull.number, htmlUrl: pull.htmlUrl },
          deadline,
          true,
        );
        return;
      }
    }

    const backend = this.#registry.get(reservation.backend);
    if (!backend) {
      throw new Error(`cannot reconcile unavailable backend ${reservation.backend}`);
    }
    const providerResourceId =
      latest?.kind === "attempt" ? latest.providerResourceId : undefined;
    if (backend.reconcileStale) {
      await backend.reconcileStale({
        objective: reservation.objective,
        workItem: reservation.workItem,
        attempt: reservation.attempt,
        runId: reservation.runId,
        directorEpoch: reservation.directorEpoch,
        ...(providerResourceId ? { providerResourceId } : {}),
      });
    } else if (events.some((event) => event.kind === "attempt" && event.event === "AttemptStarted")) {
      throw new Error(
        `backend ${reservation.backend} cannot prove the stale resource was stopped`,
      );
    }
    const attemptStartedAt = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptStarted",
    )?.at;
    const validationCouldHaveStartedAt = events.find(
      (event) => event.kind === "attempt" && event.event === "AttemptCollected",
    )?.at;
    for (const budget of unreconciledBudgetReservations(events)) {
      const phaseStart = budget.phase === "validation"
        ? validationCouldHaveStartedAt
        : attemptStartedAt;
      const elapsed = phaseStart
        ? Math.max(0, Date.now() - new Date(phaseStart).getTime())
        : 0;
      const ambiguousPaidLaunch =
        budget.phase === "execution" &&
        budget.unit === "sandbox_milliseconds" &&
        !attemptStartedAt;
      const amount = budget.unit === "managed_sessions" || ambiguousPaidLaunch
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
    const latestAttempt = attempts.reduce(
      (highest, event) => Math.max(highest, event.attempt),
      0,
    );
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

  async #startlessEscalation(reason: string): Promise<SupervisorResult> {
    this.#notify(`preflight blocked: ${reason}`);
    return {
      status: "escalated",
      objective: this.#options.objective,
      runId: "not-started",
      reason,
    };
  }
}
