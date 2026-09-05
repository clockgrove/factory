import { randomUUID } from "node:crypto";

import type { RepositoryAdmission } from "./repository-controls.js";
import type { RepositoryControls } from "./repository-controls.js";
import {
  DEFAULT_REPOSITORY_LEASE_RENEWAL_INTERVAL_MS,
  RepositoryLeaseLostError,
  RepositoryLeaseManager,
} from "./repository-lease.js";
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
import { PlatformUnavailableError } from "../platform.js";
import { adoptRecoveryActivation, type RecoveryRepositoryOwnership } from "./recovery.js";

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
  signal?: AbortSignal;
  onError?: (error: unknown, objective: number) => void;
  resources?: RepositorySupervisorResources;
  /** Deterministic clock seam for transient retry-backoff tests. */
  nowMs?: () => number;
}

/** The production-shaped repository loop. Discovery is GitHub-backed and the
 * per-Objective reconciler is expected to be Supervisor.run(), which itself
 * reconstructs attempts and fences every GitHub mutation with its lease. */
export class GitHubRepositoryController {
  readonly #options: GitHubRepositoryControllerOptions;
  readonly #resources: RepositorySupervisorResources;
  readonly #running = new Map<number, Promise<void>>();
  readonly #retryNotBefore = new Map<number, number>();
  #cursor = 0;

  constructor(options: GitHubRepositoryControllerOptions) {
    this.#options = options;
    if (!Number.isInteger(options.capacity ?? 1) || (options.capacity ?? 1) < 1)
      throw new Error("capacity must be positive");
    this.#resources = options.resources ?? createRepositorySupervisorResources();
  }

  async reconcileOnce(): Promise<number> {
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
    let started = 0;
    for (const activation of ordered) {
      if (this.#options.signal?.aborted || this.#running.size >= (this.#options.capacity ?? 1))
        break;
      if (this.#running.has(activation.objective)) continue;
      if (
        (this.#retryNotBefore.get(activation.objective) ?? 0) >
        (this.#options.nowMs?.() ?? Date.now())
      ) {
        continue;
      }
      const signal = this.#options.signal ?? new AbortController().signal;
      const task = this.#options
        .reconcileObjective(activation, signal, this.#resources)
        .then(() => {
          this.#retryNotBefore.delete(activation.objective);
        })
        .catch((error) => {
          if (error instanceof PlatformUnavailableError) {
            const now = this.#options.nowMs?.() ?? Date.now();
            this.#retryNotBefore.set(
              activation.objective,
              now + Math.max(this.#options.pollIntervalMs ?? 60_000, error.retryAfterMs),
            );
          }
          (this.#options.onError ?? (() => {}))(error, activation.objective);
        })
        .finally(() => this.#running.delete(activation.objective));
      this.#running.set(activation.objective, task);
      started += 1;
    }
    return started;
  }

  async run(): Promise<void> {
    while (!this.#options.signal?.aborted) {
      await this.reconcileOnce();
      await interruptibleDelay(this.#options.pollIntervalMs ?? 60_000, this.#options.signal);
    }
    await this.settle();
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
  /** Outer repository-controller lease check for every Supervisor mutation. */
  repositoryFence?: () => Promise<void>;
  /** Current repository-controller lease identity for durable observations. */
  controllerObservation?: () => ControllerObservation;
  /** Concrete repository ownership for dual-lease successor adoption. */
  recoveryOwnership?: RecoveryRepositoryOwnership;
  /** Injection point for deterministic conformance tests. */
  activationStore?: DurableActivationSource;
  resources?: RepositorySupervisorResources;
  /** Test seam; production deliberately constructs the real Supervisor. */
  supervisorFactory?: (
    activation: DurableObjectiveActivation,
    resources: RepositorySupervisorResources,
    controllerObservation?: () => ControllerObservation,
  ) => {
    run(): Promise<SupervisorResult | void>;
  };
}

/** Concrete unattended activation path for `factory controller run`.
 * Discovery and every Supervisor restart reconstruct state from GitHub; only
 * rate-limit and integration coordination are intentionally process-local. */
export function createGitHubRepositoryController(
  options: RunRepositoryControllerOptions,
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
    onError: (error, objective) =>
      options.onStatus?.(
        `Objective #${objective} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    reconcileObjective: async (activation, signal, shared) => {
      shared.fairness.register(activation.objective);
      try {
        if (activation.recovery && !options.supervisorFactory) {
          if (!options.recoveryOwnership || !(store instanceof GitHubControlStore))
            throw new Error("Successor adoption requires concrete repository ownership");
          await adoptRecoveryActivation({
            token: options.token,
            owner: options.owner,
            repo: options.repo,
            activation,
            signal,
            store,
            ownership: options.recoveryOwnership,
          });
        }
        const supervisor =
          options.supervisorFactory?.(activation, shared, options.controllerObservation) ??
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
            ...(options.repositoryFence ? { repositoryFence: options.repositoryFence } : {}),
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
  await withRepositoryOwnership(
    {
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      policy,
      resources,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    },
    async ({ store, signal, fence, observation, recoveryOwnership }) =>
      createGitHubRepositoryController({
        ...options,
        capacity: policy.maxActiveObjectives,
        pollIntervalMs: policy.pollIntervalSeconds * 1_000,
        signal,
        resources,
        activationStore: store,
        repositoryFence: fence,
        controllerObservation: observation,
        recoveryOwnership,
      }).run(),
  );
}

/** Foreground compatibility mode still owns the repository fence. It cannot
 * race a service controller merely because it targets a different Objective. */
export async function runForegroundObjective(
  options: SupervisorOptions,
): Promise<SupervisorResult> {
  await verifyLocalRepository(options.repository, options.owner, options.repo);
  const runPolicy = parseRunPolicy(options.policy);
  const scheduling = normalizeSchedulingPolicy(runPolicy);
  const policy = parseControllerPolicy({
    ...DEFAULT_CONTROLLER_POLICY,
    maxActiveObjectives: 1,
    maxLocalWorkers: Math.min(runPolicy.maxParallel, scheduling.capacity.local.maxWorkers),
    maxPaidWorkers:
      runPolicy.allowedPaidBackends.length === 0 ? 0 : scheduling.burst.maxCloudParallel,
  });
  const resources =
    options.repositoryResources ??
    createRepositorySupervisorResources(options.onStatus, {
      maxLocalWorkers: policy.maxLocalWorkers,
      maxPaidWorkers: policy.maxPaidWorkers,
    });
  return withRepositoryOwnership(
    {
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      policy,
      resources,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    },
    ({ signal, fence, observation }) =>
      new FactorySupervisor({
        ...options,
        policy: runPolicy,
        signal,
        repositoryResources: resources,
        repositoryFence: fence,
        controllerObservation: observation,
      }).run(),
  );
}

interface RepositoryOwnershipOptions {
  token: string;
  owner: string;
  repo: string;
  policy: ControllerPolicy;
  resources: RepositorySupervisorResources;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}

interface RepositoryOwnership {
  store: GitHubControlStore;
  signal: AbortSignal;
  fence: () => Promise<void>;
  observation: () => ControllerObservation;
  recoveryOwnership: RecoveryRepositoryOwnership;
}

async function withRepositoryOwnership<T>(
  options: RepositoryOwnershipOptions,
  operation: (ownership: RepositoryOwnership) => Promise<T>,
): Promise<T> {
  const store = new GitHubControlStore({
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    pacer: options.resources.pacer,
    circuitBreaker: options.resources.circuitBreaker,
    concurrency: options.resources.concurrency,
    mutationScheduler: options.resources.mutationScheduler,
    ...(options.onStatus ? { onThrottle: options.onStatus } : {}),
  });
  const facts = await store.getRepositoryFacts();
  const base = await store.getBranchHead(facts.defaultBranch);
  const leases = new RepositoryLeaseManager({ store });
  let lease = await leases.acquire(
    {
      controllerId: randomUUID(),
      policyDigest: controllerPolicyDigest(options.policy),
    },
    base,
  );
  options.onStatus?.(
    `repository lease epoch ${lease.epoch} acquired; capacity=${options.policy.maxActiveObjectives} Objectives/${options.policy.maxLocalWorkers} local workers`,
  );

  const ownership = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, ownership.signal])
    : ownership.signal;
  let renewalFailure: unknown;
  const fence = async (): Promise<void> => {
    try {
      await leases.assertCurrent(lease);
    } catch (error) {
      renewalFailure = error;
      ownership.abort();
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
          `repository lease lost: ${error instanceof Error ? error.message : String(error)}`,
        );
        ownership.abort();
        return;
      }
    }
  })();

  const observation = (): ControllerObservation => ({
    controllerId: lease.controllerId,
    epoch: lease.epoch,
    expiresAt: lease.expiresAt.toISOString(),
    controllerPolicyDigest: lease.policyDigest,
  });

  try {
    const result = await operation({
      store,
      signal,
      fence,
      observation,
      recoveryOwnership: { leases, current: () => lease },
    });
    if (renewalFailure) throw renewalFailure;
    return result;
  } finally {
    ownership.abort();
    await renewal;
    if (!renewalFailure) {
      await leases.release(lease).catch((error) => {
        if (!(error instanceof RepositoryLeaseLostError)) throw error;
      });
    }
  }
}
