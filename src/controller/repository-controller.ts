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
import { classifyRefusal, PlatformUnavailableError } from "../platform.js";
import { adoptRecoveryActivation, type RecoveryRepositoryOwnership } from "./recovery.js";
import { ControllerGenerationRetirement } from "./retirement.js";
import { LeaseLostError } from "../control/lease.js";

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
}

/** The production-shaped repository loop. Discovery is GitHub-backed and the
 * per-Objective reconciler is expected to be Supervisor.run(), which itself
 * reconstructs attempts and fences every GitHub mutation with its lease. */
export class GitHubRepositoryController {
  readonly #options: GitHubRepositoryControllerOptions;
  readonly #resources: RepositorySupervisorResources;
  readonly #running = new Map<number, Promise<void>>();
  #cursor = 0;
  readonly #shutdown = new AbortController();
  readonly #signal: AbortSignal;
  #retirement: ControllerGenerationRetirement | undefined;
  #platformFailure: PlatformUnavailableError | undefined;
  #fatalFailure: unknown;

  constructor(options: GitHubRepositoryControllerOptions) {
    this.#options = options;
    this.#signal = options.signal
      ? AbortSignal.any([options.signal, this.#shutdown.signal])
      : this.#shutdown.signal;
    if (!Number.isInteger(options.capacity ?? DEFAULT_CONTROLLER_POLICY.maxActiveObjectives) ||
      (options.capacity ?? DEFAULT_CONTROLLER_POLICY.maxActiveObjectives) < 1 ||
      (options.capacity ?? DEFAULT_CONTROLLER_POLICY.maxActiveObjectives) > 32)
      throw new Error("capacity must be between 1 and 32");
    this.#resources = options.resources ?? createRepositorySupervisorResources();
  }

  async reconcileOnce(): Promise<number> {
    if (this.#signal.aborted) return 0;
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
    const available = Math.max(0, (this.#options.capacity ?? DEFAULT_CONTROLLER_POLICY.maxActiveObjectives) - this.#running.size);
    const pending = ordered.filter((activation) => !this.#running.has(activation.objective));
    const resuming = pending.filter((activation) => activation.resuming);
    const selected = [...resuming, ...pending.filter((activation) => !activation.resuming).slice(0, Math.max(0, available - resuming.length))];
    // Register the complete starting cohort before any promise can reach admission.
    // Previously started runs reconcile even when a newly tightened controller
    // ceiling leaves no authority to start another Objective.
    for (const activation of selected) this.#resources.fairness.register(activation.objective, true);
    let started = 0;
    for (const activation of selected) {
      if (this.#signal.aborted) {
        this.#resources.fairness.unregister(activation.objective);
        continue;
      }
      const signal = this.#signal;
      const task = Promise.resolve()
        .then(() => this.#options.reconcileObjective(activation, signal, this.#resources))
        .catch((error) => {
          try {
            if (error instanceof ControllerGenerationRetirement) {
              this.#retirement = error;
              this.#shutdown.abort();
            }
            const unavailable = platformFailure(error);
            if (unavailable) {
              this.#platformFailure = ownershipFailure(
                this.#platformFailure,
                unavailable,
              ) as PlatformUnavailableError;
              this.#shutdown.abort();
            } else if (!(error instanceof ControllerGenerationRetirement)) {
              this.#fatalFailure = error;
              this.#shutdown.abort();
            }
            this.#options.onError?.(error, activation.objective);
          } catch (callbackError) {
            this.#fatalFailure = callbackError;
            this.#shutdown.abort();
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
      while (!this.#signal.aborted) {
        await this.reconcileOnce();
        await interruptibleDelay(this.#options.pollIntervalMs ?? 60_000, this.#signal);
      }
    } catch (error) {
      loopFailure = error;
    } finally {
      this.#shutdown.abort();
      await this.settle();
    }
    if (this.#fatalFailure) throw this.#fatalFailure;
    if (this.#retirement) throw this.#retirement;
    const failure = ownershipFailure(loopFailure, this.#platformFailure);
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
        `Objective #${objective} reconciliation failed: ${controllerFailureDiagnostic(error)}`,
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
            checkout: options.repository,
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
  // One process identity can safely rediscover its own ambiguously acquired
  // lease. Every retry acquires from GitHub anew after the prior loop settles.
  const controllerId = randomUUID();
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
      return;
    } catch (error) {
      if (options.signal?.aborted && error === options.signal.reason) return;
      const unavailable = platformFailure(error);
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
  controllerId?: string;
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
          `repository lease renewal failed; retiring controller ownership (${controllerFailureDiagnostic(error)})`,
        );
        ownership.abort();
        return;
      }
    }
  })().catch((error: unknown) => {
    // Attach immediately: a diagnostic callback must not create an unhandled
    // background rejection while the foreground operation is still draining.
    renewalFailure = error;
    ownership.abort();
  });

  const observation = (): ControllerObservation => ({
    controllerId: lease.controllerId,
    epoch: lease.epoch,
    expiresAt: lease.expiresAt.toISOString(),
    controllerPolicyDigest: lease.policyDigest,
  });

  let result: T | undefined;
  let failure: unknown;
  try {
    result = await operation({
      store,
      signal,
      fence,
      observation,
      recoveryOwnership: { leases, current: () => lease },
    });
  } catch (error) {
    failure = error;
  } finally {
    ownership.abort();
    await renewal;
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
        if (!(error instanceof RepositoryLeaseLostError))
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
  const unavailable = platformFailure(error);
  if (unavailable)
    return `platform-${unavailable.refusal.kind}; retryAfterMs=${unavailable.retryAfterMs}`;
  if (error instanceof ControllerGenerationRetirement) return "controller-generation-retirement";
  if (error instanceof RepositoryLeaseLostError) return "repository-lease-lost";
  if (error instanceof LeaseLostError) return "objective-lease-lost";
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return `github-permission-${status}`;
  if (
    error instanceof Error &&
    error.message === "Recovery adoption blocked: resource-absence-unverified"
  )
    return "recovery-adoption-blocked: resource-absence-unverified";
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
