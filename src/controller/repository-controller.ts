import { randomUUID } from "node:crypto";

import type { RepositoryAdmission } from "./repository-controls.js";
import type { RepositoryControls } from "./repository-controls.js";
import {
  DEFAULT_REPOSITORY_LEASE_RENEWAL_INTERVAL_MS,
  RepositoryLeaseLostError,
  RepositoryLeaseManager,
} from "./repository-lease.js";
import { SharedCapacityCoordinator, SHARED_CAPACITY_REF } from "./shared-capacity.js";
import { importLegacyCapacity } from "./legacy-capacity.js";
import {
  createRepositorySupervisorResources,
  FactorySupervisor,
  type ControllerObservation,
  type RepositorySupervisorResources,
  type SupervisorOptions,
  type SupervisorResult,
  verifyLocalRepository,
} from "../supervisor.js";
import type { DurableObjectiveActivation } from "../control/github-store.js";
import { GitHubControlStore } from "../control/github-store.js";
import {
  controllerPolicyDigest,
  type ControllerPolicy,
  DEFAULT_CONTROLLER_POLICY,
  normalizeSchedulingPolicy,
  parseControllerPolicy,
  parseRunPolicy,
} from "../protocol/policy.js";
import {
  classifyRefusal,
  PlatformUnavailableError,
  MutationAdmissionStoppedError,
  primaryQuotaForCredential,
} from "../platform.js";
import { adoptRecoveryActivation, type RecoveryRepositoryOwnership } from "./recovery.js";
import { ControllerGenerationRetirement } from "./retirement.js";
import { LeaseAcquisitionContendedError, LeaseLostError } from "../control/lease.js";

export interface DiscoveredObjective {
  number: number;
  activatedAt?: string;
}
export interface RepositoryControllerSource {
  /** Must reconstruct activations and durable effects from GitHub on every pass. */
  discover(): Promise<readonly DiscoveredObjective[]>;
  admissions(objective: number): Promise<readonly RepositoryAdmission[]>;
  reconcile(
    objective: number,
    admission: RepositoryAdmission,
    signal: AbortSignal,
    resources: RepositorySupervisorResources,
  ): Promise<void>;
}
export interface RepositoryControllerOptions {
  source: RepositoryControllerSource;
  controls: RepositoryControls;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onError?: (error: unknown, objective: number) => void;
  resources?: RepositorySupervisorResources;
}

/** Fair, continuous repository scheduler. No queue or cursor is durable: a
 * restart re-discovers GitHub and idempotently repairs incomplete effects. */
export class RepositoryController {
  readonly #source: RepositoryControllerSource;
  readonly #controls: RepositoryControls;
  readonly #pollIntervalMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #onError: (error: unknown, objective: number) => void;
  readonly #resources: RepositorySupervisorResources;
  #cursor = 0;
  readonly #running = new Map<number, Promise<void>>();

  constructor(options: RepositoryControllerOptions) {
    this.#source = options.source;
    this.#controls = options.controls;
    this.#pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.#signal = options.signal;
    this.#onError = options.onError ?? (() => {});
    this.#resources = options.resources ?? createRepositorySupervisorResources();
  }

  async reconcileOnce(): Promise<number> {
    const objectives = [...(await this.#source.discover())]
      .filter((item, i, all) => all.findIndex((x) => x.number === item.number) === i)
      .sort((a, b) => a.number - b.number);
    if (objectives.length === 0) return 0;
    const ordered = objectives.map((_, i) => objectives[(this.#cursor + i) % objectives.length]!);
    this.#cursor = (this.#cursor + 1) % objectives.length;
    let admitted = 0;
    for (const objective of ordered) {
      if (this.#signal?.aborted) break;
      try {
        const candidates = await this.#source.admissions(objective.number);
        for (const candidate of candidates) {
          if (candidate.objective !== objective.number)
            throw new Error("admission Objective mismatch");
          if (this.#running.has(candidate.workItem)) continue;
          const release = await this.#controls.admit(candidate);
          if (!release) continue;
          admitted += 1;
          const signal = this.#signal ?? new AbortController().signal;
          const task = this.#source
            .reconcile(objective.number, candidate, signal, this.#resources)
            .catch((error) => this.#onError(error, objective.number))
            .finally(() => {
              release();
              this.#running.delete(candidate.workItem);
            });
          this.#running.set(candidate.workItem, task);
          break; // round-robin: at most one new admission per Objective/pass
        }
      } catch (error) {
        this.#onError(error, objective.number);
      }
    }
    return admitted;
  }

  async run(): Promise<void> {
    while (!this.#signal?.aborted) {
      await this.reconcileOnce();
      await interruptibleDelay(this.#pollIntervalMs, this.#signal);
    }
    await Promise.allSettled(this.#running.values());
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.#running.values());
  }
}

function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface DurableActivationSource {
  discoverObjectiveActivations(): Promise<DurableObjectiveActivation[]>;
}

export interface GitHubRepositoryControllerOptions {
  store: DurableActivationSource;
  reconcileObjective: (
    activation: DurableObjectiveActivation,
    signal: AbortSignal,
    resources: RepositorySupervisorResources,
  ) => Promise<void>;
  capacity?: number;
  pollIntervalMs?: number;
  /** Explicit process shutdown/cancellation. Stops discovery and active Objectives. */
  signal?: AbortSignal;
  /** Discovery-election retirement. Stops new dispatch but not active Objectives. */
  discoverySignal?: AbortSignal;
  onError?: (error: unknown, objective: number) => void;
  resources?: RepositorySupervisorResources;
}

/** The production-shaped repository loop. Discovery is GitHub-backed and the
 * per-Objective reconciler is expected to be Supervisor.run(), which itself
 * reconstructs attempts and fences every GitHub mutation with its lease. */
export class GitHubRepositoryController {
  readonly #options: GitHubRepositoryControllerOptions;
  readonly #resources: RepositorySupervisorResources;
  readonly #running = new Map<number, Promise<void>>();
  readonly #parked = new Map<number, { requestId: string; retryAt: number }>();
  #cursor = 0;
  readonly #failureStop = new AbortController();
  readonly #discoverySignal: AbortSignal;
  readonly #executionSignal: AbortSignal;
  #platformFailure: PlatformUnavailableError | undefined;
  #fatalFailure: unknown;

  constructor(options: GitHubRepositoryControllerOptions) {
    this.#options = options;
    this.#executionSignal = options.signal
      ? AbortSignal.any([options.signal, this.#failureStop.signal])
      : this.#failureStop.signal;
    this.#discoverySignal = options.discoverySignal
      ? AbortSignal.any([options.discoverySignal, this.#executionSignal])
      : this.#executionSignal;
    if (
      !Number.isInteger(options.capacity ?? DEFAULT_CONTROLLER_POLICY.maxActiveObjectives) ||
      (options.capacity ?? DEFAULT_CONTROLLER_POLICY.maxActiveObjectives) < 1 ||
      (options.capacity ?? DEFAULT_CONTROLLER_POLICY.maxActiveObjectives) > 32
    )
      throw new Error("capacity must be between 1 and 32");
    this.#resources = options.resources ?? createRepositorySupervisorResources();
  }

  async reconcileOnce(): Promise<number> {
    if (this.#discoverySignal.aborted) return 0;
    const discovered = [...(await this.#options.store.discoverObjectiveActivations())]
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.objective === item.objective) === index,
      )
      .sort((a, b) => a.objective - b.objective);
    if (discovered.length === 0) return 0;
    const ordered = discovered.map(
      (_, index) => discovered[(this.#cursor + index) % discovered.length]!,
    );
    this.#cursor = (this.#cursor + 1) % discovered.length;
    const available = Math.max(
      0,
      (this.#options.capacity ?? DEFAULT_CONTROLLER_POLICY.maxActiveObjectives) -
        this.#running.size,
    );
    const pending = ordered.filter((activation) => {
      const parked = this.#parked.get(activation.objective);
      return (
        !this.#running.has(activation.objective) &&
        (!parked || parked.requestId !== activation.requestId || parked.retryAt <= Date.now())
      );
    });
    const resuming = pending.filter((activation) => activation.resuming);
    const selected = [
      ...resuming,
      ...pending
        .filter((activation) => !activation.resuming)
        .slice(0, Math.max(0, available - resuming.length)),
    ];
    // Register the complete starting cohort before any promise can reach admission.
    // Previously started runs reconcile even when a newly tightened controller
    // ceiling leaves no authority to start another Objective.
    for (const activation of selected)
      this.#resources.fairness.register(activation.objective, true);
    let started = 0;
    for (const activation of selected) {
      if (this.#discoverySignal.aborted) {
        this.#resources.fairness.unregister(activation.objective);
        continue;
      }
      const signal = this.#executionSignal;
      const task = Promise.resolve()
        .then(() => {
          this.#discoverySignal.throwIfAborted();
          return this.#options.reconcileObjective(activation, signal, this.#resources);
        })
        .catch((error) => {
          try {
            const unavailable = platformFailure(error);
            if (unavailable) {
              this.#platformFailure = ownershipFailure(
                this.#platformFailure,
                unavailable,
              ) as PlatformUnavailableError;
              this.#failureStop.abort(unavailable);
            } else {
              // A failed Objective retains its obligations but does not own
              // unrelated sessions. An explicit new activation/restart retries it.
              this.#parked.set(activation.objective, {
                requestId: activation.requestId,
                retryAt:
                  error instanceof LeaseAcquisitionContendedError
                    ? Date.now() + error.retryAfterMs
                    : Number.POSITIVE_INFINITY,
              });
              if (signal.aborted && !(error instanceof LeaseAcquisitionContendedError)) {
                // A shared stop may expose unknown cleanup; retain that failure
                // instead of treating the whole generation as safely retryable.
                this.#fatalFailure = ownershipFailure(this.#fatalFailure, error);
              }
            }
            this.#options.onError?.(error, activation.objective);
          } catch (callbackError) {
            this.#fatalFailure = callbackError;
            this.#failureStop.abort(callbackError);
          }
        })
        .finally(() => {
          this.#running.delete(activation.objective);
          this.#resources.fairness.unregister(activation.objective);
        });
      this.#running.set(activation.objective, task);
      started += 1;
    }
    return started;
  }

  async run(): Promise<void> {
    let loopFailure: unknown;
    try {
      while (!this.#discoverySignal.aborted) {
        await this.reconcileOnce();
        await interruptibleDelay(this.#options.pollIntervalMs ?? 60_000, this.#discoverySignal);
      }
    } catch (error) {
      loopFailure = error;
      // Discovery transport/account/invariant failures retain their existing
      // safety propagation. Election-only retirement never reaches this path.
      this.#failureStop.abort(error);
    } finally {
      await this.settle();
    }
    if (this.#fatalFailure && !(this.#fatalFailure instanceof LeaseAcquisitionContendedError))
      throw this.#fatalFailure;
    const failure = ownershipFailure(
      this.#fatalFailure,
      ownershipFailure(loopFailure, this.#platformFailure),
    );
    if (failure !== undefined) throw failure;
  }
  async settle(): Promise<void> {
    await Promise.allSettled(this.#running.values());
  }
}

export interface RunRepositoryControllerOptions {
  token: string;
  owner: string;
  repo: string;
  repository: string;
  capacity?: number;
  maxLocalWorkers?: number;
  maxPaidWorkers?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  /** Current repository-controller lease identity for durable observations. */
  controllerObservation?: () => ControllerObservation | undefined;
  /** Historical election identity for recovery diagnostics, not mutation authority. */
  recoveryOwnership?: RecoveryRepositoryOwnership;
  /** Injection point for deterministic conformance tests. */
  activationStore?: DurableActivationSource;
  resources?: RepositorySupervisorResources;
  /** Test seam; production deliberately constructs the real Supervisor. */
  supervisorFactory?: (
    activation: DurableObjectiveActivation,
    resources: RepositorySupervisorResources,
    controllerObservation?: () => ControllerObservation | undefined,
    signal?: AbortSignal,
  ) => {
    run(): Promise<SupervisorResult | void>;
  };
}

export interface CreateGitHubRepositoryControllerOptions extends RunRepositoryControllerOptions {
  /** Internal election-retirement signal supplied by the ownership wrapper. */
  discoverySignal?: AbortSignal;
}

/** Concrete unattended activation path for `factory controller run`.
 * Discovery and every Supervisor restart reconstruct state from GitHub; only
 * rate-limit and integration coordination are intentionally process-local. */
export function createGitHubRepositoryController(
  options: CreateGitHubRepositoryControllerOptions,
): GitHubRepositoryController {
  const resources =
    options.resources ??
    createRepositorySupervisorResources(options.onStatus, {
      maxLocalWorkers: options.maxLocalWorkers ?? DEFAULT_CONTROLLER_POLICY.maxLocalWorkers,
      maxPaidWorkers: options.maxPaidWorkers ?? DEFAULT_CONTROLLER_POLICY.maxPaidWorkers,
    });
  const store =
    options.activationStore ??
    new GitHubControlStore({
      ...{ mutationScope: "controller-discovery" },
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      pacer: resources.pacer,
      circuitBreaker: resources.circuitBreaker,
      concurrency: resources.concurrency,
      mutationScheduler: resources.mutationScheduler,
      ...(options.onStatus ? { onThrottle: options.onStatus } : {}),
    });
  return new GitHubRepositoryController({
    store,
    resources,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.discoverySignal === undefined ? {} : { discoverySignal: options.discoverySignal }),
    onError: (error, objective) =>
      options.onStatus?.(
        `Objective #${objective} reconciliation failed: ${controllerFailureDiagnostic(error)}`,
      ),
    reconcileObjective: async (activation, signal, shared) => {
      shared.fairness.register(activation.objective);
      try {
        if (activation.recovery && !options.supervisorFactory) {
          if (!(store instanceof GitHubControlStore))
            throw new Error("Successor adoption requires a concrete GitHub store");
          await adoptRecoveryActivation({
            token: options.token,
            owner: options.owner,
            repo: options.repo,
            activation,
            signal,
            store,
            checkout: options.repository,
          });
        }
        const supervisor =
          options.supervisorFactory?.(activation, shared, options.controllerObservation, signal) ??
          new FactorySupervisor({
            token: options.token,
            owner: options.owner,
            repo: options.repo,
            objective: activation.objective,
            repository: options.repository,
            policy: activation.policy,
            ...(activation.recovery
              ? { recovery: activation.recovery }
              : {
                  activation: {
                    requestId: activation.requestId,
                    baseSha: activation.baseSha,
                  },
                }),
            signal,
            repositoryResources: shared,
            shutdownBehavior: "release-lease",
            ...(options.controllerObservation
              ? { controllerObservation: options.controllerObservation }
              : {}),
            ...(options.onStatus ? { onStatus: options.onStatus } : {}),
          });
        await supervisor.run();
      } finally {
        shared.fairness.unregister(activation.objective);
      }
    },
  });
}

export async function runGitHubRepositoryController(
  options: RunRepositoryControllerOptions,
): Promise<void> {
  await verifyLocalRepository(options.repository, options.owner, options.repo);
  const policy = parseControllerPolicy({
    ...DEFAULT_CONTROLLER_POLICY,
    ...(options.capacity === undefined ? {} : { maxActiveObjectives: options.capacity }),
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalSeconds: Math.ceil(options.pollIntervalMs / 1_000) }),
    ...(options.maxLocalWorkers === undefined ? {} : { maxLocalWorkers: options.maxLocalWorkers }),
    ...(options.maxPaidWorkers === undefined ? {} : { maxPaidWorkers: options.maxPaidWorkers }),
  });
  const resources =
    options.resources ??
    createRepositorySupervisorResources(options.onStatus, {
      maxLocalWorkers: policy.maxLocalWorkers,
      maxPaidWorkers: policy.maxPaidWorkers,
    });
  // One process identity can safely rediscover its own ambiguously acquired
  // lease. Every retry acquires from GitHub anew after the prior loop settles.
  const controllerId = randomUUID();
  // Only the deliberate outer stop retires normal writes. A quota or lost
  // ownership signal must retain its own failure and recovery semantics.
  const stopNormalAdmission = () => resources.mutationScheduler.stopNormalAdmission();
  options.signal?.addEventListener("abort", stopNormalAdmission, { once: true });
  if (options.signal?.aborted) stopNormalAdmission();
  try {
    while (!options.signal?.aborted) {
      try {
        await withRepositoryOwnership(
          {
            token: options.token,
            owner: options.owner,
            repo: options.repo,
            policy,
            resources,
            controllerId,
            sharedPaidCeiling: options.maxPaidWorkers ?? DEFAULT_CONTROLLER_POLICY.maxLocalWorkers,
            configureCapacity: [
              ...(options.maxLocalWorkers !== undefined ? ["maxLocalParallel" as const] : []),
              ...(options.maxPaidWorkers !== undefined ? ["maxCloudParallel" as const] : []),
            ],
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.onStatus ? { onStatus: options.onStatus } : {}),
          },
          async ({ store, signal, executionSignal, observation, recoveryOwnership }) =>
            createGitHubRepositoryController({
              ...options,
              capacity: policy.maxActiveObjectives,
              pollIntervalMs: policy.pollIntervalSeconds * 1_000,
              signal: executionSignal,
              discoverySignal: signal,
              resources,
              activationStore: store,
              controllerObservation: observation,
              recoveryOwnership,
            }).run(),
        );
        return;
      } catch (error) {
        if (options.signal?.aborted && error === options.signal.reason) return;
        if (error instanceof LeaseAcquisitionContendedError) {
          // The complete cohort and repository generation have settled before
          // reaching here. Do not redispatch while another Objective holder may
          // still own resources, or churn the service/repository lease on a timer.
          options.onStatus?.(
            `Objective #${error.objective} acquisition contended; waiting ${error.retryAfterMs}ms before fresh discovery`,
          );
          const retryAt = performance.now() + error.retryAfterMs;
          while (!options.signal?.aborted && performance.now() < retryAt)
            await interruptibleDelay(Math.min(60_000, retryAt - performance.now()), options.signal);
          continue;
        }
        const unavailable = platformFailure(error);
        if (unavailable && options.signal?.aborted) {
          // This refusal reached us only after the admitted cohort and ownership
          // retirement settled. Unlike interrupting an already-established
          // backoff below, it may represent an in-flight write or failed cleanup.
          throw new Error(
            `Factory repository controller stopped with unresolved platform failure (${controllerFailureDiagnostic(unavailable)})`,
          );
        }
        if (!unavailable) {
          if (error instanceof ControllerGenerationRetirement) throw error;
          // Octokit errors can embed request headers and raw response bodies.
          // Keep fatal errors fatal without letting Node print those secrets.
          throw new Error(
            `Factory repository controller stopped after a non-retryable failure (${controllerFailureDiagnostic(error)})`,
          );
        }
        const delayMs = Math.max(unavailable.retryAfterMs, resources.circuitBreaker.waitMs());
        options.onStatus?.(
          `repository controller paused for platform backoff; retry in ${delayMs}ms`,
        );
        // Chunk long waits: Node's timer overflow must never turn a long reset
        // boundary into an immediate retry. Monotonic time prevents clock jumps.
        const deadline = performance.now() + delayMs;
        while (!options.signal?.aborted && performance.now() < deadline) {
          await interruptibleDelay(Math.min(60_000, deadline - performance.now()), options.signal);
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", stopNormalAdmission);
  }
}

/** Independent sessions share short capacity transactions, not scheduler ownership. */
export async function runForegroundObjective(
  options: SupervisorOptions,
): Promise<SupervisorResult> {
  await verifyLocalRepository(options.repository, options.owner, options.repo);
  const runPolicy = parseRunPolicy(options.policy);
  const scheduling = normalizeSchedulingPolicy(runPolicy);
  const policy = parseControllerPolicy({
    ...DEFAULT_CONTROLLER_POLICY,
    maxActiveObjectives: 1,
    maxLocalWorkers: DEFAULT_CONTROLLER_POLICY.maxLocalWorkers,
    maxPaidWorkers:
      runPolicy.allowedPaidBackends.length === 0 ? 0 : scheduling.burst.maxCloudParallel,
  });
  const resources =
    options.repositoryResources ??
    createRepositorySupervisorResources(options.onStatus, {
      maxLocalWorkers: policy.maxLocalWorkers,
      maxPaidWorkers: policy.maxPaidWorkers,
    });
  await attachSharedCapacity(options, policy, resources);
  return new FactorySupervisor({
    ...options,
    policy: runPolicy,
    repositoryResources: resources,
  }).run();
}

async function attachSharedCapacity(
  options: Pick<SupervisorOptions, "token" | "owner" | "repo" | "onStatus" | "signal">,
  policy: ControllerPolicy,
  resources: RepositorySupervisorResources,
  existing?: {
    store: GitHubControlStore;
    lease: import("./repository-lease.js").RepositoryLeaseState;
    leases: RepositoryLeaseManager;
    base: import("../control/lease.js").GitCommitObject;
    sharedPaidCeiling: number;
    configureCapacity: readonly ("maxLocalParallel" | "maxCloudParallel")[];
  },
): Promise<void> {
  const store = new GitHubControlStore({
    ...{ mutationScope: "repository-capacity" },
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    pacer: resources.pacer,
    circuitBreaker: resources.circuitBreaker,
    concurrency: resources.concurrency,
    mutationScheduler: resources.mutationScheduler,
    primaryQuota: primaryQuotaForCredential(options.token),
  });
  options.signal?.throwIfAborted();
  const base =
    existing?.base ?? (await store.getBranchHead((await store.getRepositoryFacts()).defaultBranch));
  options.signal?.throwIfAborted();
  const leases = existing?.leases ?? new RepositoryLeaseManager({ store });
  let migrationLease = existing?.lease;
  let releaseMigration = false;
  if (!(await store.readRef(SHARED_CAPACITY_REF)) && !migrationLease) {
    migrationLease = await leases.acquire(
      {
        controllerId: `capacity-migration-${randomUUID()}`,
        policyDigest: controllerPolicyDigest(policy),
      },
      base,
    );
    releaseMigration = true;
  }
  const sharedLimits = {
    maxParallel:
      policy.maxLocalWorkers +
      (existing?.sharedPaidCeiling ?? DEFAULT_CONTROLLER_POLICY.maxLocalWorkers),
    maxLocalParallel: policy.maxLocalWorkers,
    // A finite capacity ceiling grants no paid launch or budget authority.
    maxCloudParallel: existing?.sharedPaidCeiling ?? DEFAULT_CONTROLLER_POLICY.maxLocalWorkers,
    backendMaxParallel: {},
    cpuCapacity: Number.POSITIVE_INFINITY,
    memoryCapacityMb: Number.POSITIVE_INFINITY,
    maxPaidUnits: Number.POSITIVE_INFINITY,
  };
  const coordinator = new SharedCapacityCoordinator({
    store,
    repository: `${options.owner}/${options.repo}`,
    baseCommitSha: base.oid,
    limits: sharedLimits,
    assertLegacyCompatible: async () => {
      if (!migrationLease)
        throw new Error("capacity initialization requires a fenced migration boundary");
      const captured = migrationLease;
      return importLegacyCapacity({
        store,
        token: options.token,
        owner: options.owner,
        repo: options.repo,
        assertCurrent: async () => {
          options.signal?.throwIfAborted();
          await leases.assertCurrent(captured);
        },
      });
    },
  });
  try {
    const guarded = store as GitHubControlStore & {
      withMutationFence?<T>(fence: () => Promise<void>, operation: () => Promise<T>): Promise<T>;
    };
    if (migrationLease && guarded.withMutationFence) {
      const captured = migrationLease;
      await guarded.withMutationFence(
        () => leases.assertCurrent(captured),
        () => coordinator.initialize(),
      );
    } else await coordinator.initialize();
    if (existing?.configureCapacity.length)
      await coordinator.configureLimits(
        sharedLimits,
        () => existing.leases.assertCurrent(existing.lease),
        existing.configureCapacity,
      );
  } finally {
    if (releaseMigration && migrationLease) await leases.release(migrationLease);
  }
  Object.assign(resources, { sharedCapacity: coordinator });
}

interface RepositoryOwnershipOptions {
  controllerId?: string;
  token: string;
  owner: string;
  repo: string;
  policy: ControllerPolicy;
  resources: RepositorySupervisorResources;
  sharedPaidCeiling: number;
  configureCapacity: readonly ("maxLocalParallel" | "maxCloudParallel")[];
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}

interface RepositoryOwnership {
  store: GitHubControlStore;
  /** Election-scoped signal: discovery/configuration only. */
  signal: AbortSignal;
  /** Explicit shutdown/cancellation signal for active Objective execution. */
  executionSignal: AbortSignal;
  fence: () => Promise<void>;
  observation: () => ControllerObservation | undefined;
  recoveryOwnership: RecoveryRepositoryOwnership;
}

async function withRepositoryOwnership<T>(
  options: RepositoryOwnershipOptions,
  operation: (ownership: RepositoryOwnership) => Promise<T>,
): Promise<T> {
  const primaryQuota = primaryQuotaForCredential(options.token);
  options.resources.mutationScheduler.attachPrimaryQuota(primaryQuota);
  const store = new GitHubControlStore({
    ...{ mutationScope: "controller-election" },
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    pacer: options.resources.pacer,
    circuitBreaker: options.resources.circuitBreaker,
    concurrency: options.resources.concurrency,
    mutationScheduler: options.resources.mutationScheduler,
    primaryQuota,
    ...(options.onStatus ? { onThrottle: options.onStatus } : {}),
  });
  options.signal?.throwIfAborted();
  const facts = await store.getRepositoryFacts();
  options.signal?.throwIfAborted();
  const base = await store.getBranchHead(facts.defaultBranch);
  options.signal?.throwIfAborted();
  const leases = new RepositoryLeaseManager({ store });
  let lease = await leases.acquire(
    {
      controllerId: options.controllerId ?? randomUUID(),
      policyDigest: controllerPolicyDigest(options.policy),
    },
    base,
  );
  try {
    await attachSharedCapacity(options, options.policy, options.resources, {
      store,
      leases,
      lease,
      base,
      sharedPaidCeiling: options.sharedPaidCeiling,
      configureCapacity: options.configureCapacity,
    });
  } catch (error) {
    // Failed migration never authorizes a Supervisor or discards source claims.
    await leases.release(lease).catch(() => undefined);
    throw error;
  }
  options.onStatus?.(
    `repository lease epoch ${lease.epoch} acquired; capacity=${options.policy.maxActiveObjectives} Objectives/${options.policy.maxLocalWorkers} local workers`,
  );

  const ownership = new AbortController();
  const executionStop = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, ownership.signal])
    : ownership.signal;
  const executionSignal = options.signal
    ? AbortSignal.any([options.signal, executionStop.signal])
    : executionStop.signal;
  let renewalFailure: unknown;
  const retire = (error: unknown): void => {
    ownership.abort(error);
    // Only a proven election loss is discovery-local. Quota, credential,
    // account and invariant failures retain the previous safety stop.
    if (!(error instanceof RepositoryLeaseLostError)) executionStop.abort(error);
  };
  const fence = async (): Promise<void> => {
    try {
      await leases.assertCurrent(lease);
    } catch (error) {
      renewalFailure = error;
      retire(error);
      throw error;
    }
  };
  const renewal = (async () => {
    while (!signal.aborted) {
      await interruptibleDelay(DEFAULT_REPOSITORY_LEASE_RENEWAL_INTERVAL_MS, signal);
      if (signal.aborted) return;
      try {
        lease = await leases.renew(lease);
        options.onStatus?.(`repository lease renewed at sequence ${lease.sequence}`);
      } catch (error) {
        renewalFailure = error;
        options.onStatus?.(
          `repository lease renewal failed; retiring controller ownership (${controllerFailureDiagnostic(error)})`,
        );
        retire(error);
        return;
      }
    }
  })().catch((error: unknown) => {
    // Attach immediately: a diagnostic callback must not create an unhandled
    // background rejection while the foreground operation is still draining.
    renewalFailure = error;
    retire(error);
  });

  const observation = (): ControllerObservation | undefined =>
    ownership.signal.aborted
      ? undefined
      : {
          controllerId: lease.controllerId,
          epoch: lease.epoch,
          expiresAt: lease.expiresAt.toISOString(),
          controllerPolicyDigest: lease.policyDigest,
        };

  let result: T | undefined;
  let failure: unknown;
  try {
    result = await operation({
      store,
      signal,
      executionSignal,
      fence,
      observation,
      recoveryOwnership: { leases, current: () => lease },
    });
  } catch (error) {
    failure = error;
  } finally {
    ownership.abort();
    await renewal;
    // Election retirement is subordinate to a concrete cohort/discovery
    // failure observed while that cohort drained. Preserve the platform or
    // cleanup result so its safety/backoff semantics are not mislabeled as a
    // generic handoff; a sole election loss remains the terminal result.
    if (!(renewalFailure instanceof RepositoryLeaseLostError && failure !== undefined))
      failure = ownershipFailure(failure, renewalFailure);
    if (options.resources.circuitBreaker.isOpen()) {
      failure = ownershipFailure(
        failure,
        new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: options.resources.circuitBreaker.waitMs() },
          new Error("shared platform cooldown prevents lease release"),
        ),
      );
    } else if (!renewalFailure) {
      try {
        await leases.release(lease);
      } catch (error) {
        if (
          !(error instanceof RepositoryLeaseLostError) ||
          failure instanceof LeaseAcquisitionContendedError
        )
          failure = ownershipFailure(failure, error);
      }
    }
  }
  if (failure !== undefined) throw failure;
  return result as T;
}

function platformFailure(error: unknown): PlatformUnavailableError | undefined {
  if (error instanceof PlatformUnavailableError) return error;
  const refusal = classifyRefusal(error);
  return refusal.kind === "not_refusal" ? undefined : new PlatformUnavailableError(refusal, error);
}

/** Fixed diagnostics only: never log provider request bodies, headers, or causes. */
function controllerFailureDiagnostic(error: unknown): string {
  if (error instanceof MutationAdmissionStoppedError)
    return "normal-mutation-admission-stopped; durable cleanup may remain unresolved";
  if (error instanceof LeaseAcquisitionContendedError)
    return "objective-lease-acquisition-contended";
  const unavailable = platformFailure(error);
  if (unavailable)
    return `platform-${unavailable.refusal.kind}; retryAfterMs=${unavailable.retryAfterMs}`;
  if (error instanceof ControllerGenerationRetirement) return "controller-generation-retirement";
  if (error instanceof RepositoryLeaseLostError) return "repository-lease-lost";
  if (error instanceof LeaseLostError) return "objective-lease-lost";
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return `github-permission-${status}`;
  if (error instanceof Error) {
    const recovery = /^Recovery adoption (blocked|pending): ([a-z0-9,-]+(?:, [a-z0-9,-]+)*)$/.exec(
      error.message,
    );
    if (recovery) return `recovery-adoption-${recovery[1]}: ${recovery[2]}`;
  }
  if (
    error instanceof Error &&
    [
      "Recovery activation identity is required",
      "Observed successor runtime does not match controller discovery",
      "Recovery activation changed before adoption",
    ].includes(error.message)
  )
    return "recovery-activation-identity-mismatch";
  return "controller-invariant-failure";
}

/** Cleanup must not erase the failure that selected this teardown. */
function ownershipFailure(original: unknown, next: unknown): unknown {
  if (original === undefined) return next;
  if (next === undefined) return original;
  // Expected pre-acquisition contention cannot hide uncertain cleanup, quota,
  // or actual ownership loss encountered while retiring the cohort.
  if (original instanceof LeaseAcquisitionContendedError) {
    if (next instanceof LeaseAcquisitionContendedError)
      return original.retryAfterMs >= next.retryAfterMs ? original : next;
    return next;
  }
  if (next instanceof LeaseAcquisitionContendedError) return original;
  const first = platformFailure(original);
  const second = platformFailure(next);
  if (first && second) {
    return new PlatformUnavailableError(
      first.retryAfterMs >= second.retryAfterMs ? first.refusal : second.refusal,
      original,
    );
  }
  if (first && !second) return next;
  return original;
}
