import { archiveAttempt, type RepairCorrection } from "./repair-policy.js";
import { applyWorkCorrection } from "./work-repair.js";
import { workspacePackageAdditions } from "./workspace-membership.js";
import {
  amendmentBlocksDispatch,
  applyPendingAmendment,
  graphDigest,
  hasPendingAmendmentEffect,
  submitAmendment,
  type AmendmentProposal,
} from "./graph-amendments.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  type AutonomousAdmission,
  assertAdmissionBinding,
  bindAdmission,
  checkAuthority,
  type ExecutionAuthority,
  preflightObjective,
  verifyAdmission,
} from "./admission.js";
import type { SourceSelector } from "./compiler.js";
import {
  assertObjectiveCriteria,
  compilePlan,
  finalObjectiveCommands,
  objectiveCriteria,
  type PlanCandidate,
  planningSources,
  resolvePlan,
  validateCommandProvenance,
  verifyPlanCandidate,
} from "./compiler.js";
import {
  objectiveComplete,
  sealFinalAcceptance,
  closeObjectiveIssue,
  closeWorkItem,
  GitHubClosureFailure,
} from "./completion.js";
import type { FactoryConfig } from "./config.js";
import { factoryConfigDigest, stateRoot, validateTarget } from "./config.js";
import type {
  ContentStore,
  DeliveryStrategy,
  ExecutionDriver,
  GitHubGateway,
  PlanningModel,
} from "./contracts.js";
import { CompletedModelInvocationError } from "./contracts.js";
import {
  type ControlRequest,
  requestControl,
  serveControl,
} from "./coordinator-control.js";
import { runNativeGraph } from "./delivery/native-runner.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import { runRegularGraph } from "./delivery/regular-runner.js";
import { DiagnosticEmitter, StateDiagnostics } from "./diagnostics.js";
import {
  executionProfileChoices,
  verifyExecutionProfiles,
} from "./execution-profiles.js";
import { preflightLocalExecutables } from "./local-preflight.js";
import {
  assetSelectionDigest,
  finalValidationLfsMembers,
  verifyHydratedAssets,
} from "./media.js";
import {
  git,
  gitAsync,
  linuxProcessIdentity,
  pinnedGit,
  processGroupExists,
  withProcessCancellation,
} from "./process.js";
import { assertCompletedCoverage } from "./qa.js";
import type {
  ContinuationState,
  FactoryState,
  PreparationState,
} from "./state.js";
import {
  acquireControllerLock,
  type ControllerLock,
  readContinuation,
  readControllerOwner,
  readState,
  releaseControllerLock,
  saveState,
  statePath,
} from "./state-store.js";
import {
  AcceptanceDecisionRequired,
  assertPinnedNpmScripts,
  objectiveReviewEvidence,
  reviewAcceptance,
  validateTree,
} from "./validation.js";

export interface ApplicationServices {
  planningModel: PlanningModel;
  driver: ExecutionDriver;
  github: GitHubGateway;
  delivery: DeliveryStrategy;
  contentStore: ContentStore;
  reportRunStatus?: (message: string) => void;
}

function configuredDiagnosticSecrets(config: FactoryConfig): string[] {
  return config.policy.allowedSecretNames
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value));
}

/** Explicit previews remain read-only; admitted repair or intake planning persists one bound preparation. */
export async function planObjective(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "planningModel" | "github">,
  additionalSources: SourceSelector[] = [],
  authority?: ExecutionAuthority,
  options?: {
    ownerLock?: ControllerLock;
    observePreparation?: (state: PreparationState) => void;
    stopped?: () => boolean;
  },
): Promise<PlanCandidate> {
  validateTarget(config.repository, config.checkout);
  if (authority) checkAuthority(config, objective, authority);
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    factoryConfigDigest(config),
  );
  const planningScopeId = randomUUID();
  const started = Date.now();
  diagnostics.emit({
    operation: "planning-preview",
    outcome: "started",
    metadata: { scopeId: planningScopeId },
  });
  let lock: ControllerLock | undefined;
  let preparation: PreparationState | undefined;
  const persistPreparation = () => {
    if (preparation) {
      saveState(statePath(config.repository, objective), preparation);
      options?.observePreparation?.(preparation);
    }
  };
  try {
    const issue = await services.github.objective(objective);
    const baseSha = git(config.checkout, "rev-parse", "HEAD");
    const sourcePacketDigest = createHash("sha256")
      .update(
        JSON.stringify(
          planningSources(
            issue.body,
            baseSha,
            config.checkout,
            additionalSources,
          ),
        ),
      )
      .digest("hex");
    preflightObjective(config, issue.body, baseSha);
    if (authority?.repairPolicy || options?.ownerLock) {
      if (!authority)
        throw new Error("Owned durable planning requires bound authority");
      mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
      if (options?.ownerLock) {
        const owner = readControllerOwner(
          join(stateRoot(config.repository), "controller.lock"),
        );
        if (
          !owner ||
          owner.token !== options.ownerLock.token ||
          owner.pid !== process.pid ||
          owner.objective !== objective ||
          owner.startTime !== linuxProcessIdentity(process.pid)?.startTime
        )
          throw new Error(
            "Planning owner lock differs from the current process and Objective",
          );
        lock = options.ownerLock;
      } else lock = mutationLock(config, objective);
      const previous = readContinuation(config.repository, objective);
      if (previous && previous.schemaVersion !== 3)
        throw new Error("An activated Objective cannot be recompiled");
      preparation = previous as PreparationState | undefined;
      const bodyDigest = createHash("sha256").update(issue.body).digest("hex");
      if (
        preparation &&
        (preparation.sourcePacketDigest !== sourcePacketDigest ||
          preparation.baseSha !== baseSha ||
          preparation.objectiveBodyDigest !== bodyDigest ||
          preparation.configDigest !== factoryConfigDigest(config) ||
          JSON.stringify(preparation.authority) !== JSON.stringify(authority))
      )
        throw new Error(
          "Planning authority or immutable preparation identity changed",
        );
      preparation ??= {
        schemaVersion: 3,
        kind: "preparing",
        repository: config.repository,
        objective,
        runId: planningScopeId,
        configDigest: factoryConfigDigest(config),
        baseSha,
        objectiveBodyDigest: bodyDigest,
        sourcePacketDigest,
        authority: structuredClone(authority),
        planning: "ready",
        issueByItemId: {},
        coordinator: {
          mode: "running",
          phase: "planning",
          phaseStartedAt: new Date().toISOString(),
        },
      };
      if (
        preparation.cancelRequested ||
        preparation.cancelledAt ||
        preparation.planning === "submitted"
      )
        throw new Error(
          "Preparation is cancelled or has an unknown submitted effect",
        );
      if (preparation.plan) return preparation.plan;
      persistPreparation();
    }
    const result = await compilePlan(
      objective,
      issue.body,
      baseSha,
      config.checkout,
      services.planningModel,
      factoryConfigDigest(config),
      diagnostics.modelObserver({ scopeId: planningScopeId }),
      executionProfileChoices(config),
      additionalSources,
      preparation
        ? {
            state: preparation,
            save: () => {
              preparation!.planning =
                preparation!.planningRecovery?.phase === "submitted"
                  ? "submitted"
                  : "ready";
              persistPreparation();
            },
            stopped: () =>
              preparation!.coordinator.mode !== "running" ||
              Boolean(preparation!.cancelRequested) ||
              Boolean(options?.stopped?.()),
          }
        : undefined,
    );
    if (preparation) {
      preparation.plan = result;
      preparation.planning = "complete";
      persistPreparation();
    }
    diagnostics.emit({
      operation: "planning-preview",
      outcome: "completed",
      durationMs: Date.now() - started,
      metadata: {
        baseSha,
        scopeId: planningScopeId,
        review: result.review.status,
        itemCount: result.graph.items.length,
      },
    });
    return result;
  } catch (error) {
    diagnostics.emit({
      operation: "planning-preview",
      outcome: "failed",
      durationMs: Date.now() - started,
      metadata: { scopeId: planningScopeId },
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (lock && !options?.ownerLock)
      releaseMutationLock(
        join(stateRoot(config.repository), "controller.lock"),
        lock,
      );
  }
}

function samePreparedPlan(
  prepared: PlanCandidate,
  candidate: PlanCandidate,
): boolean {
  const { humanDecision: _preparedDecision, ...original } = prepared;
  const { humanDecision: _candidateDecision, ...resolved } = candidate;
  return (
    JSON.stringify({
      ...original,
      review: { ...original.review, status: "bound" },
    }) ===
    JSON.stringify({
      ...resolved,
      review: { ...resolved.review, status: "bound" },
    })
  );
}

function checkActiveAdmission(
  config: FactoryConfig,
  objective: number,
  admission: AutonomousAdmission,
): void {
  const state = readContinuation(config.repository, objective);
  if (
    state &&
    (!state.admission || state.admission.digest !== admission.digest) &&
    !(
      state.schemaVersion === 3 &&
      state.authority &&
      JSON.stringify(state.authority) === JSON.stringify(admission.authority) &&
      state.plan?.graphDigest === admission.graphDigest
    )
  )
    throw new Error("Active Objective admission cannot be added or replaced");
  const directory = join(stateRoot(config.repository), "objectives");
  if (existsSync(directory))
    for (const name of readdirSync(directory)) {
      if (!/^\d+$/.test(name) || Number(name) === objective) continue;
      const other = readContinuation(config.repository, Number(name));
      if (
        other &&
        !(other.schemaVersion === 2 && objectiveComplete(other)) &&
        !other.cancelledAt
      )
        throw new Error(
          `Objective #${name} is already active in this installation`,
        );
    }
}

export async function admitObjective(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github">,
  candidate: PlanCandidate,
  authority: ExecutionAuthority,
): Promise<AutonomousAdmission> {
  validateTarget(config.repository, config.checkout);
  const issue = await services.github.objective(objective);
  const admission = bindAdmission(
    config,
    objective,
    issue.body,
    git(config.checkout, "rev-parse", "HEAD"),
    candidate,
    authority,
  );
  checkActiveAdmission(config, objective, admission);
  return admission;
}

export async function checkAdmission(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github">,
  candidate: PlanCandidate,
  admission: AutonomousAdmission,
): Promise<void> {
  validateTarget(config.repository, config.checkout);
  const issue = await services.github.objective(objective);
  verifyAdmission(
    config,
    objective,
    issue.body,
    git(config.checkout, "rev-parse", "HEAD"),
    candidate,
    admission,
  );
  checkActiveAdmission(config, objective, admission);
}

export async function decidePlan(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github">,
  candidate: PlanCandidate,
  input: {
    actor: string;
    outcome: "accept" | "refuse";
    answer: string;
    reason: string;
  },
): Promise<PlanCandidate> {
  validateTarget(config.repository, config.checkout);
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    factoryConfigDigest(config),
  );
  const started = Date.now();
  diagnostics.emit({ operation: "planning-decision", outcome: "started" });
  try {
    const issue = await services.github.objective(objective);
    const baseSha = git(config.checkout, "rev-parse", "HEAD");
    const result = await resolvePlan(
      candidate,
      objective,
      issue.body,
      baseSha,
      config.checkout,
      input,
      factoryConfigDigest(config),
    );
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "completed",
      durationMs: Date.now() - started,
      metadata: { review: result.review.status },
    });
    return result;
  } catch (error) {
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "failed",
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export class CoordinatorHandoff extends Error {
  constructor() {
    super("Coordinator drained and released ownership");
  }
}

function canHandoff(state: ContinuationState): boolean {
  if (state.coordinator?.processes?.length || state.coordinator?.cancelError)
    return false;
  if (state.schemaVersion === 3)
    return state.planning !== "submitted" && !state.projectionPending;
  return (
    !state.coordinator?.phase.endsWith("-submitted") &&
    !hasPendingAmendmentEffect(state) &&
    !Object.values(state.work).some(
      (work) =>
        work.status === "running" ||
        (work.status === "published" &&
          (!work.pullRequest || !work.changeRef || !work.treeSha)) ||
        work.pendingEffect,
    )
  );
}

interface LocalOwner {
  handoff?: boolean;
  snapshot?: ContinuationState;
  lock: ControllerLock;
  abort: AbortController;
  changed: boolean;
  deadlineAt?: string;
  cancellation?: Promise<void>;
  waitForWake: () => Promise<void>;
}
const owners = new Map<string, LocalOwner>();
const ownerKey = (config: FactoryConfig, objective: number) =>
  `${config.repository}#${objective}`;
function mutationState(
  config: FactoryConfig,
  objective: number,
): FactoryState | undefined {
  const snapshot = owners.get(ownerKey(config, objective))?.snapshot;
  if (snapshot?.schemaVersion === 3)
    throw new Error("Objective is still preparing");
  return snapshot ?? readState(config.repository, objective);
}
function mutationLock(
  config: FactoryConfig,
  objective: number,
): ControllerLock {
  return owners.has(ownerKey(config, objective))
    ? { fd: -1, token: "owner" }
    : acquireControllerLock(
        join(stateRoot(config.repository), "controller.lock"),
        objective,
      );
}
function releaseMutationLock(path: string, lock: ControllerLock): void {
  if (lock.fd !== -1) releaseControllerLock(path, lock);
}

export async function controlObjective(
  config: FactoryConfig,
  request: ControlRequest,
): Promise<unknown> {
  const reply = await requestControl(config.repository, request);
  if (reply.handled) return reply.result;
  if (!["pause", "drain", "resume", "status"].includes(request.action))
    throw new Error("No active coordinator owns this Objective");
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(lockPath, request.objective);
  try {
    const state = readContinuation(config.repository, request.objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (request.action === "status") return state.coordinator;
    state.coordinator ??= {
      mode: "running",
      phase: "idle",
      phaseStartedAt: new Date().toISOString(),
    };
    state.coordinator.mode =
      request.action === "pause"
        ? "paused"
        : request.action === "drain"
          ? "draining"
          : "running";
    saveState(statePath(config.repository, request.objective), state);
    return state.coordinator;
  } finally {
    releaseControllerLock(lockPath, lock);
  }
}

async function cancelRecordedSubprocesses(
  state: ContinuationState,
): Promise<void> {
  for (const subprocess of state.coordinator?.processes ?? []) {
    if (!processGroupExists(subprocess.pid)) continue;
    const identity = linuxProcessIdentity(subprocess.pid);
    if (
      identity?.startTime !== subprocess.startTime ||
      identity.group !== subprocess.pid
    )
      throw new Error(
        "Subprocess owner identity is unresolved; operator direction required",
      );
    try {
      process.kill(-subprocess.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    for (
      let attempt = 0;
      attempt < 100 && processGroupExists(subprocess.pid);
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    if (processGroupExists(subprocess.pid))
      throw new Error(
        "Subprocess cessation remains unresolved; operator direction required",
      );
  }
  if (state.coordinator) state.coordinator.processes = [];
}

async function cancelKnownWork(
  state: ContinuationState,
  driver: ExecutionDriver,
): Promise<void> {
  const errors: string[] = [];
  const tasks: Promise<void>[] = [];
  if (
    state.schemaVersion === 3 &&
    (state.planning === "submitted" || state.projectionPending)
  )
    errors.push(
      "Submitted preparation effect has unknown outcome; operator direction required",
    );
  if (state.schemaVersion === 2 && hasPendingAmendmentEffect(state))
    errors.push(
      "Submitted amendment effect has unknown outcome; operator direction required",
    );
  if (state.coordinator?.phase === "objective-review-submitted")
    errors.push(
      "Submitted Objective review outcome is unknown; operator direction required",
    );
  if (state.schemaVersion === 2)
    for (const work of Object.values(state.work)) {
      if (work.pendingEffect)
        errors.push(
          `Submitted ${work.pendingEffect} outcome is unknown; operator direction required`,
        );
      if (
        work.step !== "execute" ||
        work.status === "done" ||
        work.status === "cancelled"
      )
        continue;
      if (!work.execution) {
        errors.push(
          "Active attempt has no stable handle; cessation is unknown",
        );
        continue;
      }
      tasks.push(driver.cancel(work.execution));
    }
  tasks.push(cancelRecordedSubprocesses(state));
  for (const result of await Promise.allSettled(tasks))
    if (result.status === "rejected") errors.push(String(result.reason));
  if (errors.length) throw new Error(errors.join("; "));
}

export async function runObjective(
  config: FactoryConfig,
  objective: number,
  services: ApplicationServices,
  acceptedPlan?: PlanCandidate,
  admission?: AutonomousAdmission,
  options: { deadlineAt?: string } = {},
): Promise<FactoryState> {
  if (options.deadlineAt && !Number.isFinite(Date.parse(options.deadlineAt)))
    throw new Error("Deadline must be an absolute timestamp");
  const root = stateRoot(config.repository);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, "controller.lock");
  const lock = acquireControllerLock(lockPath, objective);
  let snapshot: ContinuationState | undefined;
  try {
    snapshot = readContinuation(config.repository, objective);
  } catch (error) {
    releaseControllerLock(lockPath, lock);
    throw error;
  }
  if (snapshot)
    snapshot.coordinator ??= {
      mode: "running",
      phase: "idle",
      phaseStartedAt: new Date().toISOString(),
    };
  const owner: LocalOwner = {
    changed: false,
    lock,
    abort: new AbortController(),
    waitForWake: async () => undefined,
    snapshot,
    deadlineAt: options.deadlineAt,
  };
  owners.set(ownerKey(config, objective), owner);
  const waiters = new Set<() => void>();
  const wake = () => {
    owner.changed = true;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const wait = async () => {
    if (owner.handoff && owner.snapshot && canHandoff(owner.snapshot))
      throw new CoordinatorHandoff();
    if (owner.changed) {
      owner.changed = false;
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.add(resolve);
    });
    owner.changed = false;
  };
  owner.waitForWake = wait;
  const persist = () => {
    if (owner.snapshot)
      saveState(statePath(config.repository, objective), owner.snapshot);
  };
  const cancel = (): void => {
    if (!owner.snapshot) return;
    if (owner.snapshot.schemaVersion === 2 && owner.snapshot.finalAcceptance) {
      owner.snapshot.coordinator!.waitReason =
        "Acceptance is sealed; reconcile Objective closure before successor work";
      persist();
      wake();
      return;
    }
    owner.snapshot.cancelRequested = true;
    owner.snapshot.coordinator ??= {
      mode: "running",
      phase: "idle",
      phaseStartedAt: new Date().toISOString(),
    };
    owner.snapshot.coordinator.waitReason = "Verifying owned work cessation";
    persist();
    owner.abort.abort();
    if (owner.cancellation) return;
    owner.cancellation = (async () => {
      const state = owner.snapshot!;
      try {
        await cancelKnownWork(state, services.driver);
        // The run settles its in-flight effect before recording terminal cancellation.
        state.coordinator!.waitReason =
          "Owned cancellation acknowledged; waiting for in-flight phase to settle";
      } catch (error) {
        state.coordinator!.cancelError =
          error instanceof Error ? error.message : String(error);
        state.coordinator!.waitReason =
          "Cancellation unresolved; operator direction required";
      }
      persist();
      wake();
    })();
  };
  if (owner.snapshot?.coordinator?.deadlineAt) {
    if (
      options.deadlineAt &&
      options.deadlineAt !== owner.snapshot.coordinator.deadlineAt
    ) {
      owners.delete(ownerKey(config, objective));
      releaseControllerLock(lockPath, lock);
      throw new Error(
        "Existing elapsed deadline cannot be replaced on restart",
      );
    }
    owner.deadlineAt = owner.snapshot.coordinator.deadlineAt;
  } else if (owner.snapshot && owner.deadlineAt) {
    owner.snapshot.coordinator!.deadlineAt = owner.deadlineAt;
    persist();
  }
  let deadlineTimer: NodeJS.Timeout | undefined;
  const armDeadline = () => {
    if (!owner.deadlineAt) return;
    const delay = Date.parse(owner.deadlineAt) - Date.now();
    if (delay <= 0 && owner.snapshot) {
      owner.snapshot.coordinator!.waitReason =
        "Operator-declared deadline elapsed";
      persist();
      cancel();
      return;
    }
    deadlineTimer = setTimeout(
      armDeadline,
      Math.max(1, Math.min(delay, 2_147_483_647)),
    );
  };
  armDeadline();
  let controlTail: Promise<unknown> = Promise.resolve();
  let server;
  try {
    server = await serveControl(config.repository, lock, async (request) => {
      if (request.objective !== objective)
        throw new Error("Objective identity differs from owner");
      const state = owner.snapshot;
      if (!state)
        throw new Error(
          "Owner is initializing; observe status before retrying",
        );
      state.coordinator ??= {
        mode: "running",
        phase: "idle",
        phaseStartedAt: new Date().toISOString(),
      };
      if (request.action === "status") return state.coordinator;
      if (request.action === "propose-amendment") {
        if (state.schemaVersion !== 2)
          throw new Error("Planning has no active graph to amend");
        const result = submitAmendment(
          state,
          request.input as unknown as AmendmentProposal,
        );
        persist();
        wake();
        return result;
      }
      if (request.action === "cancel") {
        if (state.schemaVersion === 2 && state.finalAcceptance)
          throw new Error(
            "Acceptance is sealed; resume to reconcile Objective closure",
          );
        cancel();
        return "requested";
      }
      if (["pause", "drain", "resume", "handoff"].includes(request.action)) {
        if (request.action === "handoff") owner.handoff = true;
        state.coordinator.mode =
          request.action === "pause"
            ? "paused"
            : ["drain", "handoff"].includes(request.action)
              ? "draining"
              : "running";
        persist();
        wake();
        return state.coordinator;
      }
      const apply = async () => {
        if (owner.abort.signal.aborted)
          throw new Error(
            "Cancellation is in progress; inspect ownership before another action",
          );
        const input = request.input ?? {};
        if (request.action === "retry")
          retryWorkItem(config, objective, String(input.item));
        else if (request.action === "repair")
          repairWorkItem(
            config,
            objective,
            input as Parameters<typeof repairWorkItem>[2],
          );
        else if (request.action === "rereview")
          rereviewWorkItem(
            config,
            objective,
            input as Parameters<typeof rereviewWorkItem>[2],
          );
        else if (request.action === "decide-result")
          decideResult(
            config,
            objective,
            input as Parameters<typeof decideResult>[2],
          );
        else if (request.action === "select")
          await selectAssetSetFromCli(
            config,
            objective,
            String(input.item),
            String(input.set),
            services.contentStore,
            input,
          );
        else throw new Error("Unsupported control action");
        wake();
        return "applied";
      };
      const result = controlTail.then(apply);
      controlTail = result.catch(() => undefined);
      return result;
    });
  } catch (error) {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    owners.delete(ownerKey(config, objective));
    releaseControllerLock(lockPath, lock);
    throw error;
  }
  const handoff = () => {
    owner.handoff = true;
    if (owner.snapshot?.coordinator) {
      owner.snapshot.coordinator.mode = "draining";
      persist();
    }
    wake();
  };
  process.on("SIGTERM", handoff);
  process.on("SIGUSR1", cancel);
  try {
    for (;;) {
      const state = owner.snapshot;
      if (state?.cancelRequested) {
        cancel();
        await owner.cancellation;
        if (!state.coordinator?.cancelError) {
          state.cancelledAt = new Date().toISOString();
          if (state.schemaVersion === 2)
            for (const work of Object.values(state.work))
              if (work.status === "pending" || work.status === "running")
                work.status = "cancelled";
          persist();
        }
        throw new Error("Objective cancellation requested");
      }
      if (
        state?.coordinator?.mode !== "running" &&
        state?.coordinator &&
        !(
          state.schemaVersion === 2 &&
          Object.values(state.work).some(
            (work) => work.status === "running" || work.status === "published",
          )
        )
      ) {
        await wait();
        continue;
      }
      const result = await withProcessCancellation(
        owner.abort.signal,
        () =>
          runObjectivePass(
            config,
            objective,
            services,
            acceptedPlan,
            admission,
            owner,
          ),
        (process, settled) => {
          const disposition = owner.snapshot?.coordinator;
          if (!disposition) return;
          disposition.processes ??= [];
          disposition.processes = disposition.processes.filter(
            (entry) =>
              entry.pid !== process.pid ||
              entry.startTime !== process.startTime,
          );
          if (!settled) disposition.processes.push(process);
          persist();
        },
      ).catch((error: unknown) => {
        const current = owner.snapshot;
        if (
          !(error instanceof GitHubClosureFailure) ||
          current?.schemaVersion !== 2 ||
          !current.admission
        )
          throw error;
        current.coordinator!.mode = "paused";
        current.coordinator!.waitReason =
          "GitHub closure acknowledgement unresolved; resume to reconcile";
        persist();
        return current;
      });
      owner.snapshot = result;
      if (objectiveComplete(result) || result.cancelledAt || !result.admission)
        return result;
      if (
        amendmentBlocksDispatch(result) &&
        result.pendingAmendment?.phase !== "rejected"
      )
        continue;
      if (
        result.coordinator?.mode === "running" &&
        Object.values(result.work).some(
          (work) =>
            work.recovery?.phase === "ready" &&
            (work.status === "pending" || work.status === "running"),
        )
      )
        continue;
      result.coordinator!.phase = "waiting";
      const stoppedRepair = Object.entries(result.work).find(
        ([, work]) =>
          work.recovery?.phase === "stopped" &&
          ["failed", "waiting"].includes(work.status),
      );
      result.coordinator!.waitReason = result.githubClosureError
        ? "GitHub closure acknowledgement unresolved; resume to reconcile"
        : result.coordinator!.mode === "draining"
          ? "Drained; no owned attempts remain"
          : stoppedRepair
            ? `Work Item ${stoppedRepair[0]}: ${stoppedRepair[1].recovery!.failure?.decision ?? "Inspect the retained recovery failure"}`
            : "Awaiting exact candidate decision or resume";
      persist();
      await wait();
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.off("SIGUSR1", cancel);
    process.off("SIGTERM", handoff);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    owners.delete(ownerKey(config, objective));
    releaseControllerLock(lockPath, lock);
  }
}

async function runObjectivePass(
  config: FactoryConfig,
  objective: number,
  services: ApplicationServices,
  acceptedPlan: PlanCandidate | undefined,
  admission: AutonomousAdmission | undefined,
  owner: LocalOwner,
): Promise<FactoryState> {
  validateTarget(config.repository, config.checkout);
  if (config.execution.kind !== "local")
    throw new Error("Current trunk supports local execution only");
  const root = stateRoot(config.repository);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = statePath(config.repository, objective);
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    factoryConfigDigest(config),
  );
  let stateDiagnostics: StateDiagnostics | undefined;
  const save = (state: FactoryState) => {
    owner.snapshot = state;
    if (state.coordinator) {
      const phases = [
        ...new Set(
          Object.values(state.work)
            .filter((work) => work.status === "running")
            .map((work) => work.pendingEffect ?? work.step ?? "active"),
        ),
      ];
      const phase = phases.join(",") || "waiting";
      if (state.coordinator.phase !== phase) {
        state.coordinator.phase = phase;
        state.coordinator.phaseStartedAt = new Date().toISOString();
      }
    }
    saveState(path, state);
    try {
      stateDiagnostics?.observe();
    } catch (error) {
      process.stderr.write(
        `Factory diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
  const active = new Map<string, Promise<void>>();
  const {
    driver,
    github,
    delivery,
    contentStore,
    planningModel,
    reportRunStatus,
  } = services;
  let stateForSignal: FactoryState | undefined;
  const cancellationRequested = () => Boolean(owner.snapshot?.cancelRequested);
  try {
    diagnostics.emit({ operation: "objective-run", outcome: "started" });
    const observeObjective = async () => {
      for (;;) {
        if (cancellationRequested())
          throw new Error("Objective cancellation requested");
        try {
          const observed = await github.objective(objective);
          if (owner.snapshot?.coordinator) {
            owner.snapshot.coordinator.observedAt = new Date().toISOString();
            delete owner.snapshot.coordinator.observationError;
          }
          return observed;
        } catch (error) {
          if (!owner.snapshot?.coordinator || cancellationRequested())
            throw error;
          owner.snapshot.coordinator.observationError =
            "Exact Objective observation unavailable";
          owner.snapshot.coordinator.waitReason =
            "GitHub API unavailable; resume to observe again or cancel locally";
          owner.snapshot.coordinator.mode = "paused";
          saveState(path, owner.snapshot);
          do {
            await owner.waitForWake();
          } while (
            String(owner.snapshot.coordinator.mode) !== "running" &&
            !cancellationRequested()
          );
        }
      }
    };
    const issue = await observeObjective();
    assertObjectiveCriteria(issue.body);
    const installationConfigDigest = factoryConfigDigest(config);
    const continuation = readContinuation(config.repository, objective);
    owner.snapshot = continuation;
    if (owner.handoff && continuation?.coordinator) {
      continuation.coordinator.mode = "draining";
      saveState(path, continuation);
    }
    let preparation =
      continuation?.schemaVersion === 3 ? continuation : undefined;
    let state = continuation?.schemaVersion === 2 ? continuation : undefined;
    if (preparation?.plan && acceptedPlan && !preparation.admission) {
      if (!samePreparedPlan(preparation.plan, acceptedPlan))
        throw new Error(
          "Prepared plan changed; only its exact human decision can be resolved",
        );
      verifyPlanCandidate(
        acceptedPlan,
        objective,
        issue.body,
        preparation.baseSha,
        config.checkout,
        installationConfigDigest,
      );
      preparation.plan = structuredClone(acceptedPlan);
      saveState(path, preparation);
    }
    if (preparation?.admission) {
      if (admission && admission.digest !== preparation.admission.digest)
        throw new Error("Preparation admission cannot be replaced on restart");
      admission = preparation.admission;
    } else if (preparation && admission) {
      if (
        !preparation.authority ||
        JSON.stringify(preparation.authority) !==
          JSON.stringify(admission.authority) ||
        !preparation.plan
      )
        throw new Error("Preparation cannot gain unbound admission on restart");
      verifyAdmission(
        config,
        objective,
        issue.body,
        preparation.baseSha,
        preparation.plan,
        admission,
      );
      preparation.admission = admission;
      saveState(path, preparation);
    }
    if (preparation?.authority && !admission)
      throw new Error(
        "Durable authorized planning requires its exact reviewed admission before activation",
      );
    if (preparation?.error)
      throw new Error(`Objective preparation stopped: ${preparation.error}`);
    if (preparation?.planning === "submitted" || preparation?.projectionPending)
      throw new Error(
        "Interrupted submitted preparation effect has unknown outcome; operator direction required",
      );
    if (issue.state === "closed" && !state?.finalValidation?.passed)
      throw new Error(
        "Objective issue is confirmed closed; operator direction required",
      );
    if (admission && !state && !acceptedPlan && !preparation?.plan)
      throw new Error("Admission dispatch requires its exact reviewed plan");
    if (!state)
      preflightObjective(
        config,
        issue.body,
        git(config.checkout, "rev-parse", "HEAD"),
      );
    if (state) {
      if (
        state.coordinator?.processes?.some((entry) =>
          processGroupExists(entry.pid),
        )
      )
        throw new Error(
          "Interrupted coordinator subprocess remains owned; cancel or resolve ownership before continuing",
        );
      if (state.schemaVersion === 2 && hasPendingAmendmentEffect(state))
        throw new Error(
          "Submitted amendment effect has unknown outcome; operator direction required",
        );
      if (state.coordinator?.phase === "objective-review-submitted")
        throw new Error(
          "Interrupted Objective review outcome is unknown; operator direction required",
        );
      if (
        admission &&
        (!state.admission ||
          JSON.stringify(admission) !== JSON.stringify(state.admission))
      )
        throw new Error(
          "Active Objective admission cannot be added or replaced; existing runs gain no new authority",
        );
      if (state.admission) {
        assertAdmissionBinding(state.admission);
        checkAuthority(config, objective, state.admission.authority);
        const sources = planningSources(
          issue.body,
          state.baseSha,
          config.checkout,
          state.admission.additionalSources,
        );
        const sourceDigests = sources.map(({ path, heading, content }) => ({
          path,
          ...(heading ? { heading } : {}),
          digest: createHash("sha256").update(content).digest("hex"),
        }));
        if (
          state.admission.graphDigest !==
            (state.graphRevisions?.[0]?.digest ?? graphDigest(state.graph)) ||
          JSON.stringify(state.admission.sourceDigests) !==
            JSON.stringify(sourceDigests) ||
          JSON.stringify(state.additionalSources) !==
            JSON.stringify(state.admission.additionalSources)
        )
          throw new Error(
            "Persisted admission differs from current graph or pinned source packet",
          );
        if (
          state.admission.repository !== config.repository ||
          state.admission.objective !== objective ||
          state.admission.configDigest !== installationConfigDigest ||
          state.admission.baseSha !== state.baseSha ||
          state.admission.bodyDigest !==
            createHash("sha256").update(issue.body).digest("hex")
        )
          throw new Error(
            "Persisted admission differs from current Objective or installation",
          );
        if (acceptedPlan)
          verifyAdmission(
            config,
            objective,
            issue.body,
            state.baseSha,
            acceptedPlan,
            state.admission,
          );
      }
      if (
        state.schemaVersion !== 2 ||
        state.repository !== config.repository ||
        state.configDigest !== installationConfigDigest
      ) {
        throw new Error(
          "Existing Objective state does not match this Factory installation",
        );
      }
      if (acceptedPlan) {
        if (
          JSON.stringify(acceptedPlan.executionProfiles) !==
          JSON.stringify(executionProfileChoices(config))
        )
          throw new Error(
            "Accepted plan execution profile policy differs from installation",
          );
        verifyPlanCandidate(
          acceptedPlan,
          objective,
          issue.body,
          state.baseSha,
          config.checkout,
          installationConfigDigest,
        );
        if (
          JSON.stringify(acceptedPlan.graph) !==
          JSON.stringify(state.graphRevisions?.[0]?.graph ?? state.graph)
        )
          throw new Error(
            "Accepted plan differs from the already active Objective graph",
          );
      }
      if (state.error)
        throw new Error(
          `Objective stopped: ${state.error}. Use explicit retry or operator direction.`,
        );
      if (
        !state.objectiveBodyDigest &&
        workspacePackageAdditions(issue.body).length
      )
        throw new Error(
          "Workspace package authority requires a digest-bound Objective; create a new plan",
        );
      if (
        state.objectiveBodyDigest &&
        state.objectiveBodyDigest !==
          createHash("sha256").update(issue.body).digest("hex")
      )
        throw new Error(
          "Objective issue body changed; operator direction required",
        );
      stateDiagnostics = new StateDiagnostics(
        diagnostics,
        state,
        config.delivery.kind,
        config.execution.concurrency,
      );
      const saveCurrent = () => save(state!);
      for (const item of state.graph.items)
        if (state.work[item.id]?.status === "done")
          await closeWorkItem(
            state,
            item.id,
            github,
            saveCurrent,
            config.delivery.kind === "native-stack",
          );
      if (state.finalValidation?.passed) {
        reportRunStatus?.(
          "Factory: resuming the existing run from atomic state",
        );
        if (!state.finalAcceptance && state.objectiveClosure !== "complete") {
          await gitAsync(
            config.checkout,
            "fetch",
            "origin",
            await github.defaultBranch(),
          );
          if (
            git(config.checkout, "rev-parse", "FETCH_HEAD") !==
            state.integratedSha
          )
            throw new Error(
              "Default branch changed before historical final acceptance could be sealed",
            );
        }
        await closeObjectiveIssue(state, issue.body, github, saveCurrent);
        return state;
      }
      if (state.cancelRequested || state.cancelledAt)
        throw new Error(
          "Objective was cancelled; use explicit retry or operator direction",
        );
      reportRunStatus?.("Factory: resuming the existing run from atomic state");
    } else {
      const objectivesRoot = join(root, "objectives");
      if (existsSync(objectivesRoot)) {
        for (const name of readdirSync(objectivesRoot)) {
          if (!/^\d+$/.test(name) || Number(name) === objective) continue;
          const other = readContinuation(config.repository, Number(name));
          if (
            other &&
            !(other.schemaVersion === 2 && objectiveComplete(other)) &&
            !other.cancelledAt
          )
            throw new Error(
              `Objective #${name} is already active in this installation`,
            );
        }
      }
      const baseSha = git(config.checkout, "rev-parse", "HEAD");
      if (!preparation && acceptedPlan) {
        verifyPlanCandidate(
          acceptedPlan,
          objective,
          issue.body,
          baseSha,
          config.checkout,
          installationConfigDigest,
        );
        if (admission)
          verifyAdmission(
            config,
            objective,
            issue.body,
            baseSha,
            acceptedPlan,
            admission,
          );
      }
      if (!preparation) {
        preparation = {
          schemaVersion: 3,
          kind: "preparing",
          repository: config.repository,
          objective,
          runId: randomUUID(),
          configDigest: installationConfigDigest,
          baseSha,
          objectiveBodyDigest: createHash("sha256")
            .update(issue.body)
            .digest("hex"),
          ...(admission ? { admission } : {}),
          planning: "ready",
          issueByItemId: {},
          coordinator: {
            mode: owner.handoff ? "draining" : "running",
            phase: "planning",
            phaseStartedAt: new Date().toISOString(),
            ...(owner.deadlineAt ? { deadlineAt: owner.deadlineAt } : {}),
          },
        };
        owner.snapshot = preparation;
        saveState(path, preparation);
      }
      if (
        preparation.configDigest !== installationConfigDigest ||
        preparation.baseSha !== baseSha ||
        preparation.objectiveBodyDigest !==
          createHash("sha256").update(issue.body).digest("hex")
      )
        throw new Error(
          "Preparation identity changed; operator direction required",
        );
      if (owner.handoff && canHandoff(preparation))
        throw new CoordinatorHandoff();
      const planningScopeId = preparation.runId;
      const plan =
        preparation.plan ??
        (await diagnostics.span(
          {
            operation: "planning",
            metadata: { baseSha, scopeId: planningScopeId },
          },
          async () => {
            let candidate: PlanCandidate;
            if (acceptedPlan) {
              reportRunStatus?.("Factory: activating the accepted plan");
              candidate = acceptedPlan;
            } else {
              reportRunStatus?.(
                "Factory: compiling and independently reviewing a fresh plan",
              );
              preparation!.planning = "submitted";
              saveState(path, preparation!);
              candidate = await compilePlan(
                objective,
                issue.body,
                baseSha,
                config.checkout,
                planningModel,
                installationConfigDigest,
                diagnostics.modelObserver({ scopeId: planningScopeId }),
                executionProfileChoices(config),
                [],
                preparation!.authority?.repairPolicy
                  ? {
                      state: preparation!,
                      save: () => saveState(path, preparation!),
                      stopped: () =>
                        cancellationRequested() ||
                        preparation!.coordinator.mode !== "running",
                    }
                  : undefined,
              );
            }
            verifyPlanCandidate(
              candidate,
              objective,
              issue.body,
              baseSha,
              config.checkout,
              installationConfigDigest,
            );
            return candidate;
          },
          (candidate) => ({ itemCount: candidate.graph.items.length }),
        ));
      preparation.plan = plan;
      preparation.planning = "complete";
      preparation.coordinator.phase = "projection";
      preparation.coordinator.phaseStartedAt = new Date().toISOString();
      saveState(path, preparation);
      if (cancellationRequested())
        throw new Error("Objective cancellation requested");
      if (
        JSON.stringify(plan.executionProfiles) !==
        JSON.stringify(executionProfileChoices(config))
      )
        throw new Error(
          "Accepted plan execution profile policy differs from installation",
        );
      if (admission)
        verifyAdmission(
          config,
          objective,
          issue.body,
          baseSha,
          plan,
          admission,
        );
      const graph = plan.graph;
      verifyExecutionProfiles(graph, executionProfileChoices(config));
      await driver.preflight?.(graph);
      preflightLocalExecutables({
        checkout: config.checkout,
        baseSha,
        graph,
        finalCommands: plan.finalCommands,
        privateRoot: root,
        credentialDirectory: join(root, "empty-gh-config"),
        secrets: configuredDiagnosticSecrets(config),
        observe: (entry) =>
          diagnostics.emit({
            itemId: entry.itemId,
            operation: "local-executable-preflight",
            outcome:
              entry.status === "missing" || entry.status === "version-mismatch"
                ? "failed"
                : "observed",
            metadata: {
              origin: entry.origin,
              source: entry.source,
              commandIndex: entry.commandIndex,
              executable: entry.executable,
              preflightStatus: entry.status,
              pathContext: entry.pathContext,
            },
            detail: entry.detail,
          }),
      });
      const waitForAdmission = async () => {
        while (
          preparation!.coordinator.mode !== "running" &&
          !cancellationRequested()
        )
          await owner.waitForWake();
        if (cancellationRequested())
          throw new Error("Objective cancellation requested");
      };
      await waitForAdmission();
      const projected = await diagnostics.span(
        {
          operation: "github-projection",
          metadata: { itemCount: graph.items.length },
        },
        () =>
          github.projectGraph({
            graph,
            objectiveIssue: objective,
            knownIssues: preparation!.issueByItemId,
            beforeCreate: async (id) => {
              await waitForAdmission();
              if (cancellationRequested())
                throw new Error("Objective cancellation requested");
              preparation!.projectionPending = id;
              saveState(path, preparation!);
            },
            projected: (id, number) => {
              preparation!.issueByItemId[id] = number;
              delete preparation!.projectionPending;
              saveState(path, preparation!);
            },
          }),
      );
      state = {
        schemaVersion: 2,
        ...(preparation.planningRecovery
          ? { planningRecovery: preparation.planningRecovery }
          : {}),
        ...(preparation.allowanceConsumption
          ? { allowanceConsumption: preparation.allowanceConsumption }
          : {}),
        ...(preparation.repairConsumption
          ? { repairConsumption: preparation.repairConsumption }
          : {}),
        ...(admission
          ? {
              admission: JSON.parse(
                JSON.stringify(admission),
              ) as AutonomousAdmission,
            }
          : {}),
        ...(plan.additionalSources?.length
          ? { additionalSources: plan.additionalSources }
          : {}),
        repository: config.repository,
        objective,
        runId: preparation.runId,
        coordinator: {
          ...preparation.coordinator,
          phase: "active",
          phaseStartedAt: new Date().toISOString(),
        },
        configDigest: installationConfigDigest,
        baseSha,
        graph,
        objectiveCommands: finalObjectiveCommands(issue.body),
        objectiveBodyDigest: createHash("sha256")
          .update(issue.body)
          .digest("hex"),
        issueByItemId: projected.issueByItemId,
        work: Object.fromEntries(
          graph.items.map((item) => [item.id, { status: "pending" }]),
        ),
      };
      stateDiagnostics = new StateDiagnostics(
        diagnostics,
        state,
        config.delivery.kind,
        config.execution.concurrency,
      );
    }
    state.coordinator ??= {
      mode: "running",
      phase: "active",
      phaseStartedAt: new Date().toISOString(),
    };
    state.coordinator.observedAt = new Date().toISOString();
    delete state.coordinator.observationError;
    await applyPendingAmendment({
      state,
      config,
      body: issue.body,
      model: planningModel,
      github,
      save: () => save(state),
      cancelled: cancellationRequested,
      diagnostics,
    });
    if (state.coordinator.mode === "running" && !cancellationRequested())
      for (const [id, work] of Object.entries(state.work)) {
        if (
          work.status === "failed" &&
          work.recovery?.phase === "ready" &&
          work.recovery.correction
        ) {
          applyWorkCorrection(state, id, work.recovery.correction, true);
          save(state);
        }
      }
    const graph = state.graph;
    verifyExecutionProfiles(graph, executionProfileChoices(config));
    await driver.preflight?.(graph);
    validateCommandProvenance(
      graph,
      planningSources(
        issue.body,
        state.baseSha,
        config.checkout,
        state.additionalSources,
      ),
      config.checkout,
    );
    stateForSignal = state;
    save(state);
    if (config.delivery.kind === "native-stack") {
      await runNativeGraph({
        config,
        objective,
        objectiveBody: issue.body,
        root,
        state,
        driver,
        delivery,
        contentStore,
        github,
        planningModel,
        save: () => save(state),
        active,
        reconcile: async () => {
          try {
            const refreshed = await observeObjective();
            state.coordinator!.observedAt = new Date().toISOString();
            delete state.coordinator!.observationError;
            if (refreshed.state === "closed")
              throw new Error(
                "Objective issue is confirmed closed; operator direction required",
              );
            if (
              createHash("sha256").update(refreshed.body).digest("hex") !==
              state.objectiveBodyDigest
            )
              throw new Error(
                "Objective issue body changed; operator direction required",
              );
          } catch (error) {
            state.coordinator!.observationError =
              error instanceof Error ? error.message : String(error);
            save(state);
            throw error;
          }
          if (cancellationRequested())
            throw new Error("Objective cancellation requested");
          save(state);
        },
        cancelled: cancellationRequested,
        paused: () => state.coordinator?.mode !== "running",
        amendmentPending: () => amendmentBlocksDispatch(state),
        diagnostics,
      });
      if (graph.items.some((item) => state.work[item.id]?.status === "waiting"))
        return state;
    } else {
      const awaitingSelection = await runRegularGraph({
        config,
        objective,
        objectiveBody: issue.body,
        root,
        state,
        driver,
        delivery,
        contentStore,
        github,
        planningModel,
        save: () => save(state),
        active,
        reconcile: async () => {
          try {
            const refreshed = await observeObjective();
            state.coordinator!.observedAt = new Date().toISOString();
            delete state.coordinator!.observationError;
            if (refreshed.state === "closed")
              throw new Error(
                "Objective issue is confirmed closed; operator direction required",
              );
            if (
              createHash("sha256").update(refreshed.body).digest("hex") !==
              state.objectiveBodyDigest
            )
              throw new Error(
                "Objective issue body changed; operator direction required",
              );
          } catch (error) {
            state.coordinator!.observationError =
              error instanceof Error ? error.message : String(error);
            save(state);
            throw error;
          }
          if (cancellationRequested())
            throw new Error("Objective cancellation requested");
          save(state);
        },
        cancelled: cancellationRequested,
        paused: () =>
          state.coordinator?.mode !== "running" ||
          amendmentBlocksDispatch(state),
        diagnostics,
      });
      if (awaitingSelection) return state;
    }
    if (
      state.coordinator.mode !== "running" ||
      amendmentBlocksDispatch(state) ||
      graph.items.some((item) => state.work[item.id]?.status !== "done")
    )
      return state;
    if (cancellationRequested())
      throw new Error("Objective cancellation requested");
    await gitAsync(
      config.checkout,
      "fetch",
      "origin",
      await github.defaultBranch(),
    );
    const finalGraphDigest = graphDigest(state.graph);
    const integratedSha = state.integratedSha!;
    const observedHead = git(config.checkout, "rev-parse", "FETCH_HEAD");
    if (observedHead !== integratedSha)
      throw new Error(
        `Default branch changed before final validation: expected ${integratedSha}, observed ${observedHead}`,
      );
    const finalTree = git(
      config.checkout,
      "rev-parse",
      `${integratedSha}^{tree}`,
    );
    assertCompletedCoverage(state);
    const finalValidationStarted = Date.now();
    diagnostics.emit({
      runId: state.runId,
      operation: "objective-validation",
      outcome: "started",
      metadata: { integratedSha, treeSha: finalTree },
    });
    assertPinnedNpmScripts(
      config.checkout,
      state.baseSha,
      integratedSha,
      state.objectiveCommands ?? finalObjectiveCommands(issue.body),
      {
        sourceDeclared:
          state.objectiveCommands ?? finalObjectiveCommands(issue.body),
        workspacePackageAdditions: workspacePackageAdditions(issue.body),
      },
    );
    const commandEvidence = await validateTree(
      config.checkout,
      join(root, "final-validation"),
      integratedSha,
      finalTree,
      state.objectiveCommands ?? finalObjectiveCommands(issue.body),
      (entry) =>
        diagnostics.emit({
          runId: state.runId,
          operation: "objective-validation-command",
          outcome: entry.passed ? "completed" : "failed",
          durationMs: entry.durationMs,
          metadata: { commandIndex: entry.index, exitCode: entry.exitCode },
          detail: entry.output,
        }),
      (entry) =>
        diagnostics.emitStream(
          {
            runId: state.runId,
            operation: "objective-validation-output",
            outcome: "observed",
            metadata: { commandIndex: entry.index, stream: entry.stream },
          },
          entry.output,
          entry.final,
        ),
      finalValidationLfsMembers(state),
      contentStore,
    );
    const selectedAssets = graph.items.flatMap((item) => {
      const work = state.work[item.id];
      const set = work?.assets?.find(
        (candidate) => candidate.id === work.selectedAssetSet,
      );
      return set ? [{ itemId: item.id, set }] : [];
    });
    const hydrationReceipt = selectedAssets.length
      ? await diagnostics.span(
          {
            runId: state.runId,
            operation: "media-hydration-verification",
            metadata: { integratedSha, treeSha: finalTree },
          },
          async () =>
            verifyHydratedAssets({
              checkout: config.checkout,
              workRoot: join(root, "hydration"),
              integratedSha,
              selections: selectedAssets,
            }),
          (receipt) => ({ members: receipt?.members.length ?? 0 }),
        )
      : undefined;
    const acceptanceEvidence = hydrationReceipt
      ? { ...commandEvidence, hydrationReceipt }
      : commandEvidence;
    let finalEvidence;
    try {
      const objectiveEvidence = objectiveReviewEvidence({
        state,
        checkout: config.checkout,
        integratedCommitSha: integratedSha,
        integratedTreeSha: finalTree,
      });
      const reviewFinal = () =>
        reviewAcceptance({
          model: planningModel,
          reviewPhase: "objective-review",
          checkout: config.checkout,
          baseSha: state.baseSha,
          commit: integratedSha,
          evidence: acceptanceEvidence,
          criteria: objectiveCriteria(issue.body),
          sources: planningSources(
            issue.body,
            state.baseSha,
            config.checkout,
            state.additionalSources,
          ),
          evidenceSources: [
            ...objectiveEvidence.evidence,
            ...(hydrationReceipt
              ? [
                  {
                    path: "Controller hydration receipt",
                    content: JSON.stringify(hydrationReceipt),
                  },
                ]
              : []),
          ],
          decisions: state.finalAcceptanceDecisions,
          observations: objectiveEvidence.observations,
          invocation: {
            invocationId: randomUUID(),
            phase: "objective-review",
            ordinal: 0,
            observe: diagnostics.modelObserver({
              scopeId: state.runId,
              runId: state.runId,
            }),
          },
        });
      if (cancellationRequested())
        throw new Error("Objective cancellation requested");
      state.coordinator.phase = "objective-review-submitted";
      saveState(path, state);
      finalEvidence = await diagnostics.span(
        {
          runId: state.runId,
          operation: "objective-acceptance-review",
          metadata: { treeSha: finalTree, integratedSha },
        },
        reviewFinal,
        (result) => ({ criteria: result.criteria?.length ?? 0 }),
        (error) =>
          error instanceof AcceptanceDecisionRequired ? "waiting" : "failed",
      );
      if (cancellationRequested())
        throw new Error("Objective cancellation requested");
      state.coordinator.phase = "objective-review-complete";
      delete state.finalAcceptancePending;
    } catch (error) {
      if (error instanceof CompletedModelInvocationError)
        state.coordinator.phase = "objective-review-complete";
      if (error instanceof AcceptanceDecisionRequired) {
        state.coordinator.phase = "waiting";
        state.finalAcceptancePending = error.pending;
        save(state);
        diagnostics.emit({
          runId: state.runId,
          operation: "objective-validation",
          outcome: "waiting",
          durationMs: Date.now() - finalValidationStarted,
          metadata: { treeSha: finalTree },
          detail: JSON.stringify({
            question: error.pending.question,
            detail: error.pending.detail,
            reviewFinding: error.pending.reviewFinding ?? null,
            reviewRejection: error.pending.reviewRejection ?? null,
          }),
        });
        return state;
      }
      throw error;
    }
    if (
      state.coordinator.mode !== "running" ||
      amendmentBlocksDispatch(state) ||
      graphDigest(state.graph) !== finalGraphDigest ||
      state.integratedSha !== integratedSha
    ) {
      save(state);
      return state;
    }
    await gitAsync(
      config.checkout,
      "fetch",
      "origin",
      await github.defaultBranch(),
    );
    const reviewedHead = git(config.checkout, "rev-parse", "FETCH_HEAD");
    if (reviewedHead !== integratedSha)
      throw new Error(
        `Default branch changed during final review: expected ${integratedSha}, observed ${reviewedHead}`,
      );
    // No await between this CAS, the immutable seal and pending closure persistence.
    if (
      cancellationRequested() ||
      state.coordinator.mode !== "running" ||
      amendmentBlocksDispatch(state) ||
      graphDigest(state.graph) !== finalGraphDigest ||
      state.integratedSha !== integratedSha
    ) {
      save(state);
      return state;
    }
    state.finalValidation = { ...finalEvidence, passed: true };
    sealFinalAcceptance(state);
    diagnostics.emit({
      runId: state.runId,
      operation: "objective-validation",
      outcome: "completed",
      durationMs: Date.now() - finalValidationStarted,
      metadata: { treeSha: finalTree, integratedSha },
    });
    save(state);
    await closeObjectiveIssue(state, issue.body, github, () => save(state));
    return state;
  } catch (error) {
    if (error instanceof CoordinatorHandoff) throw error;
    diagnostics.emit({
      runId: stateForSignal?.runId,
      operation: "objective-run",
      outcome: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    const current = owner.snapshot;
    if (
      current?.schemaVersion === 2 &&
      current.finalAcceptance &&
      !(error instanceof GitHubClosureFailure)
    ) {
      // A rejected resume cannot turn immutable accepted evidence into a failed run.
      current.coordinator!.waitReason = `Sealed acceptance preserved: ${error instanceof Error ? error.message : String(error)}`;
      saveState(path, current);
      throw error;
    }
    if (
      active.size &&
      current?.schemaVersion === 2 &&
      !cancellationRequested()
    ) {
      for (const work of Object.values(current.work)) {
        if (!work.execution || work.status !== "running") continue;
        try {
          await driver.cancel(work.execution);
        } catch (cancelError) {
          current.coordinator!.cancelError = String(cancelError);
        }
      }
      await Promise.allSettled(active.values());
    }
    if (current?.schemaVersion === 2 && !cancellationRequested()) {
      for (const work of Object.values(current.work)) {
        if (
          !work.execution ||
          work.step !== "execute" ||
          work.status === "done"
        )
          continue;
        try {
          if ((await driver.observe(work.execution)).state === "running")
            await driver.cancel(work.execution);
        } catch (cessationError) {
          current.coordinator!.cancelError = `Owned worker cessation unresolved: ${String(cessationError)}`;
          current.coordinator!.waitReason =
            "Operator direction required before retry";
        }
      }
    }
    if (current) {
      if (cancellationRequested()) {
        await owner.cancellation;
        await Promise.allSettled(active.values());
        if (!current.coordinator?.cancelError && active.size === 0) {
          current.cancelledAt = new Date().toISOString();
          if (current.schemaVersion === 2)
            for (const work of Object.values(current.work))
              if (work.status !== "done" && work.status !== "published")
                work.status = "cancelled";
        }
      } else if (
        error instanceof GitHubClosureFailure &&
        current.schemaVersion === 2
      ) {
        current.githubClosureError = error.message;
      } else if (
        current.schemaVersion === 3 &&
        current.planning === "complete" &&
        !current.projectionPending
      ) {
        current.coordinator.waitReason =
          error instanceof Error ? error.message : String(error);
      } else {
        current.error = error instanceof Error ? error.message : String(error);
      }
      saveState(path, current);
    }
    throw error;
  }
}

export async function cancelObjective(
  config: FactoryConfig,
  objective: number,
  driver: ExecutionDriver,
): Promise<"requested" | "cancelled"> {
  const root = stateRoot(config.repository);
  const lock = join(root, "controller.lock");
  const control = await requestControl(config.repository, {
    objective,
    action: "cancel",
  });
  if (control.handled) return "requested";
  const owner = readControllerOwner(lock);
  if (owner) {
    const current = linuxProcessIdentity(owner.pid);
    if (current?.startTime === owner.startTime && current.state !== "Z") {
      if (owner.objective !== objective)
        throw new Error(`Controller is running Objective #${owner.objective}`);
      process.kill(owner.pid, "SIGUSR1");
      return "requested";
    }
  }
  const lockHandle = mutationLock(config, objective);
  try {
    const continuation = readContinuation(config.repository, objective);
    if (!continuation) throw new Error("Objective has no Factory state");
    if (
      (continuation.schemaVersion === 2 && objectiveComplete(continuation)) ||
      continuation.cancelledAt
    )
      return "cancelled";
    if (continuation.schemaVersion === 2 && continuation.finalAcceptance)
      throw new Error(
        "Acceptance is sealed; resume to reconcile Objective closure",
      );
    continuation.cancelRequested = true;
    saveState(statePath(config.repository, objective), continuation);
    try {
      await cancelKnownWork(continuation, driver);
    } catch (error) {
      continuation.coordinator ??= {
        mode: "running",
        phase: "waiting",
        phaseStartedAt: new Date().toISOString(),
      };
      continuation.coordinator.cancelError = String(error);
      continuation.coordinator.waitReason =
        "Cancellation unresolved; operator direction required";
      saveState(statePath(config.repository, objective), continuation);
      throw error;
    }
    if (continuation.schemaVersion === 2)
      for (const work of Object.values(continuation.work)) {
        if (work.execution && work.step === "execute")
          await driver.collect(work.execution).catch(() => undefined);
        if (work.status !== "done" && work.status !== "published") {
          work.status = "cancelled";
          work.completedAt = new Date().toISOString();
        }
      }
    continuation.cancelledAt = new Date().toISOString();
    saveState(statePath(config.repository, objective), continuation);
    const state = continuation;
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      operation: "objective-cancel",
      outcome: "completed",
    });
    return "cancelled";
  } finally {
    releaseMutationLock(lock, lockHandle);
  }
}

export function retryWorkItem(
  config: FactoryConfig,
  objective: number,
  itemId: string,
): void {
  const root = stateRoot(config.repository);
  const lock = join(root, "controller.lock");
  const lockHandle = mutationLock(config, objective);
  try {
    const state = mutationState(config, objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (state.finalValidation?.passed)
      throw new Error("Objective is already complete");
    if (state.coordinator?.cancelError || state.coordinator?.processes?.length)
      throw new Error(
        "Owned work cessation is unresolved; operator direction required before retry",
      );
    if (Object.values(state.work).some((work) => work.status === "running"))
      throw new Error("Finish or cancel active work before retry");
    const work = state.work[itemId];
    if (!work || (work.status !== "failed" && work.status !== "cancelled"))
      throw new Error("Only a failed or cancelled Work Item can be retried");
    if (
      work.pendingEffect ||
      state.coordinator?.phase === "objective-review-submitted"
    )
      throw new Error(
        "Submitted effect outcome is unknown; operator direction required before retry",
      );
    const nativeUnit =
      config.delivery.kind === "native-stack"
        ? linearDeliveryUnits(state.graph).find((unit) =>
            unit.items.some((item) => item.id === itemId),
          )
        : undefined;
    if (
      work.pullRequest ||
      work.step === "deliver" ||
      nativeUnit?.items.some((item) => state.work[item.id]?.pullRequest) ||
      (nativeUnit &&
        (state.stackNumbers?.[nativeUnit.id] ||
          state.stackMerges?.[nativeUnit.id]))
    )
      throw new Error("Published PR requires operator direction before retry");
    if (state.admission?.authority.repairPolicy)
      throw new Error(
        "Admitted repair requires a concrete diagnosed proposal; retry cannot reset its allowance",
      );
    state.work[itemId] = { status: "pending", recovery: archiveAttempt(work) };
    state.cancelRequested = false;
    delete state.cancelledAt;
    delete state.error;
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId,
      operation: "work-retry",
      outcome: "completed",
    });
  } finally {
    releaseMutationLock(lock, lockHandle);
  }
}

/** Diagnosed correction requests retain the exact failure and consume admitted limits. */
export function repairWorkItem(
  config: FactoryConfig,
  objective: number,
  input: { item: string; treeSha?: string; correction: RepairCorrection },
): void {
  const lock = join(stateRoot(config.repository), "controller.lock");
  const handle = mutationLock(config, objective);
  try {
    const state = mutationState(config, objective);
    if (
      !state ||
      state.finalValidation?.passed ||
      state.error ||
      state.configDigest !== factoryConfigDigest(config)
    )
      throw new Error("Objective is not available for diagnosed repair");
    const work = state.work[input.item];
    if (input.correction.kind !== "implementation") {
      if (
        !work?.changeRef ||
        !work.treeSha ||
        input.treeSha !== work.treeSha ||
        pinnedGit(config.checkout, "rev-parse", `${work.changeRef}^{tree}`) !==
          work.treeSha
      )
        throw new Error(
          "Preserved repair candidate tree changed or is unavailable",
        );
    }
    applyWorkCorrection(state, input.item, input.correction);
    saveState(statePath(config.repository, objective), state);
  } finally {
    releaseMutationLock(lock, handle);
  }
}

/** Request validation and automatic review again without deciding a criterion. */
export function rereviewWorkItem(
  config: FactoryConfig,
  objective: number,
  input: { item: string; treeSha: string; actor: string; reason: string },
): void {
  const lock = join(stateRoot(config.repository), "controller.lock");
  const handle = mutationLock(config, objective);
  try {
    const state = mutationState(config, objective);
    if (
      !state ||
      state.error ||
      state.cancelRequested ||
      state.cancelledAt ||
      state.finalValidation?.passed
    )
      throw new Error("Objective is not awaiting result re-review");
    if (state.configDigest !== factoryConfigDigest(config))
      throw new Error(
        "Installation configuration changed before result re-review",
      );
    const work = state.work[input.item];
    if (
      !work ||
      work.status !== "waiting" ||
      work.step !== "approve-result" ||
      !work.acceptancePending ||
      !work.baseSha ||
      !work.changeRef ||
      !work.treeSha ||
      work.pullRequest ||
      work.integratedSha
    )
      throw new Error(
        "Work Item has no unpublished pending result to re-review",
      );
    if (
      work.acceptanceDecisions?.some(
        (decision) => decision.outcome === "refuse",
      )
    )
      throw new Error("Refused acceptance cannot be reopened by re-review");
    const observedTree = pinnedGit(
      config.checkout,
      "rev-parse",
      `${work.changeRef}^{tree}`,
    );
    if (
      input.treeSha !== work.acceptancePending.treeSha ||
      input.treeSha !== work.treeSha ||
      observedTree !== input.treeSha
    )
      throw new Error(
        "Result re-review tree differs from the pending exact result",
      );
    if (!input.actor.trim() || !input.reason.trim())
      throw new Error("Result re-review requires actor and reason");
    if (state.admission?.authority.repairPolicy)
      throw new Error(
        "Admitted re-review requires a diagnosed repair proposal within its allowance",
      );
    work.recovery = archiveAttempt(work);
    work.status = "running";
    work.step = "validate";
    delete work.acceptancePending;
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId: input.item,
      attemptId: work.attempt,
      operation: "result-rereview-request",
      outcome: "completed",
      metadata: { treeSha: input.treeSha, actor: input.actor },
      detail: input.reason,
    });
  } finally {
    releaseMutationLock(lock, handle);
  }
}

/** Record one explicit result decision against the exact pending tree. */
export function decideResult(
  config: FactoryConfig,
  objective: number,
  input: {
    item?: string;
    treeSha: string;
    actor: string;
    outcome: "accept" | "refuse";
    reason: string;
  },
): void {
  const root = stateRoot(config.repository);
  const lockHandle = mutationLock(config, objective);
  try {
    const path = statePath(config.repository, objective);
    const state = mutationState(config, objective);
    if (
      !state ||
      state.error ||
      state.cancelledAt ||
      state.finalValidation?.passed
    )
      throw new Error("Objective is not awaiting a result decision");
    const work = input.item ? state.work[input.item] : undefined;
    const pending = input.item
      ? work?.acceptancePending
      : state.finalAcceptancePending;
    const commit = input.item ? work?.changeRef : state.integratedSha;
    if (
      !pending ||
      !commit ||
      (work && (work.status !== "waiting" || work.step !== "approve-result"))
    )
      throw new Error(
        "No specific acceptance criterion is awaiting this decision",
      );
    const observedTree = pinnedGit(
      config.checkout,
      "rev-parse",
      `${commit}^{tree}`,
    );
    if (pending.treeSha !== input.treeSha || observedTree !== input.treeSha)
      throw new Error(
        "Result decision tree differs from the pending exact result",
      );
    if (
      !input.actor.trim() ||
      !input.reason.trim() ||
      !["accept", "refuse"].includes(input.outcome)
    )
      throw new Error("Result decision requires actor and reason");
    const decision = {
      criterion: pending.criterion,
      treeSha: pending.treeSha,
      actor: input.actor,
      at: new Date().toISOString(),
      outcome: input.outcome,
      reason: input.reason,
    };
    if (work) {
      work.acceptanceDecisions ??= [];
      work.acceptanceDecisions.push(decision);
      delete work.acceptancePending;
      work.status = input.outcome === "accept" ? "running" : "failed";
      work.step = "validate";
      if (input.outcome === "refuse")
        work.error = `Acceptance refused: ${pending.criterion}`;
    } else {
      state.finalAcceptanceDecisions ??= [];
      state.finalAcceptanceDecisions.push(decision);
      delete state.finalAcceptancePending;
      if (input.outcome === "refuse")
        state.error = `Final acceptance refused: ${pending.criterion}`;
    }
    saveState(path, state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId: input.item,
      attemptId: work?.attempt,
      operation: input.item
        ? "acceptance-decision"
        : "objective-acceptance-decision",
      outcome: input.outcome === "accept" ? "completed" : "failed",
      metadata: { treeSha: pending.treeSha },
      detail: input.reason,
    });
  } finally {
    releaseMutationLock(join(root, "controller.lock"), lockHandle);
  }
}

type AssetSelectionInput = {
  actor?: string;
  reason?: string;
  downstreamItems?: string[];
};

async function selectAssetSetWithSurface(
  config: FactoryConfig,
  objective: number,
  itemId: string,
  setId: string,
  store: ContentStore,
  decision: AssetSelectionInput | undefined,
  surface: "factory-cli" | "application",
): Promise<void> {
  const root = stateRoot(config.repository);
  const lock = join(root, "controller.lock");
  const lockHandle = mutationLock(config, objective);
  try {
    const state = mutationState(config, objective);
    if (!state || state.error || state.cancelledAt)
      throw new Error("Objective is not awaiting asset selection");
    const work = state.work[itemId];
    if (!work || work.status !== "waiting" || work.step !== "approve-asset")
      throw new Error(`Work Item ${itemId} is not awaiting asset selection`);
    const set = work.assets?.find((candidate) => candidate.id === setId);
    if (!set) throw new Error(`AssetSet ${setId} is not a captured candidate`);
    const downstreamItems = [...new Set(decision?.downstreamItems ?? [])];
    for (const name of downstreamItems) {
      const dependent = state.graph.items.find((item) => item.id === name);
      if (
        !dependent ||
        !dependent.dependencies.includes(itemId) ||
        state.work[name]?.status !== "pending"
      )
        throw new Error(
          `Work Item ${name} is not a pending direct dependent of ${itemId}`,
        );
    }
    for (const member of set.members) await store.verify(member.ref);
    if (
      state.cancelRequested ||
      work.status !== "waiting" ||
      work.step !== "approve-asset"
    )
      throw new Error(
        "Asset selection disposition changed during verification",
      );
    work.selectedAssetSet = setId;
    work.selectionDigest = assetSelectionDigest(set);
    work.selection = {
      actor: decision?.actor ?? userInfo().username,
      at: new Date().toISOString(),
      ...(decision?.reason && { reason: decision.reason }),
      surface,
      destinations: set.members.map((member) => ({
        role: member.role,
        path: member.destination,
        digest: member.ref.digest,
      })),
      downstreamItems,
    };
    work.status = "running";
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId,
      attemptId: work.attempt,
      operation: "media-selection",
      outcome: "completed",
      metadata: { setId, downstreamCount: downstreamItems.length },
    });
  } finally {
    releaseMutationLock(lock, lockHandle);
  }
}

export async function selectAssetSet(
  config: FactoryConfig,
  objective: number,
  itemId: string,
  setId: string,
  store: ContentStore,
  decision?: AssetSelectionInput,
): Promise<void> {
  return selectAssetSetWithSurface(
    config,
    objective,
    itemId,
    setId,
    store,
    decision,
    "application",
  );
}

/** CLI-only boundary: the invocation surface is fixed here, not caller data. */
export async function selectAssetSetFromCli(
  config: FactoryConfig,
  objective: number,
  itemId: string,
  setId: string,
  store: ContentStore,
  decision?: AssetSelectionInput,
): Promise<void> {
  return selectAssetSetWithSurface(
    config,
    objective,
    itemId,
    setId,
    store,
    decision,
    "factory-cli",
  );
}

export async function exportAssetSetForReview(
  config: FactoryConfig,
  objective: number,
  itemId: string,
  setId: string,
  output: string,
  store: ContentStore,
): Promise<void> {
  const state = mutationState(config, objective);
  const work = state?.work[itemId];
  if (!work || work.status !== "waiting" || work.step !== "approve-asset")
    throw new Error(`Work Item ${itemId} is not awaiting asset review`);
  const set = work.assets?.find((candidate) => candidate.id === setId);
  if (!set) throw new Error(`AssetSet ${setId} is not a captured candidate`);
  if (
    !isAbsolute(output) ||
    existsSync(output) ||
    resolve(output).startsWith(`${resolve(config.checkout)}${sep}`)
  )
    throw new Error(
      "Review output must be a new absolute directory outside the target checkout",
    );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const member of set.members)
    await store.materialize(
      member.ref,
      join(output, `${member.role}-${basename(member.destination)}`),
    );
  new DiagnosticEmitter(config.repository, objective).emit({
    runId: state!.runId,
    itemId,
    attemptId: work.attempt,
    operation: "media-review-export",
    outcome: "completed",
    metadata: { setId, memberCount: set.members.length },
  });
}
