import { serviceLoginSecrets } from "./provider-credentials.js";
import { hasReadinessWait, isReadinessWait } from "./delivery/readiness.js";
import { executionContext } from "./execution/checkpoint.js";
import {
  archiveAttempt,
  checkRequiredEnvironment,
  type RepairCorrection,
  resolveAutonomy,
} from "./repair-policy.js";
import { applyWorkCorrection, resumeDiagnoses } from "./work-repair.js";
import { workerIdentity } from "./item-steps.js";
import { planningPrerequisites } from "./objective-prerequisites.js";
import { workspacePackageAdditions } from "./workspace-membership.js";
import {
  amendmentBlocksDispatch,
  applyPendingAmendment,
  graphDigest,
  submitAmendment,
  type AmendmentProposal,
} from "./graph-amendments.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  assertObjectiveCriteria,
  compilePlan,
  paidModel,
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
} from "./completion.js";
import type { FactoryConfig } from "./config.js";
import {
  factoryConfigDigest,
  resolveCapacity,
  stateRoot,
  validateTarget,
} from "./config.js";
import type {
  ContentStore,
  DeliveryStrategy,
  ExecutionDriver,
  GitHubGateway,
  PlanningModel,
} from "./contracts.js";
import {
  attachedFault,
  attachFault,
  decision,
  faultDetail,
  StepFault,
} from "./fault.js";
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
  awaitsOperator,
  clearAllRepeats,
  clearRepeats,
  outageOf,
  StepPaused,
  step,
  type StepContext,
  type StepState,
  waitOf,
} from "./step.js";
import { namesPlan, shortPlanDigest } from "./status-summary.js";
import {
  executionProfileChoices,
  verifyExecutionProfiles,
} from "./execution-profiles.js";
import {
  preflightLocalExecutables,
  preflightObjective,
} from "./local-preflight.js";
import {
  assetSelectionDigest,
  finalValidationLfsMembers,
  verifyHydratedAssets,
} from "./media.js";
import {
  fetchHead,
  git,
  linuxProcessIdentity,
  pinnedGit,
  processGroupExists,
  withProcessCancellation,
} from "./process.js";
import { assertCompletedCoverage, objectiveCandidate } from "./qa.js";
import type {
  ContinuationState,
  FactoryState,
  PreparationState,
  WorkState,
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
  assertPinnedNpmScripts,
  objectiveReviewEvidence,
  reviewOutcome,
  sweepValidationWorktrees,
  validateTree,
} from "./validation.js";

/** Heads others push during final validation that Factory follows before asking. */
const FOLLOWED_HEAD_LIMIT = 3;

/** One controller-derived binding for the immutable preparation inputs. */
function preparationSourceDigest(
  sources: PlanCandidate["sources"],
  prerequisites: PlanCandidate["prerequisites"],
  localExecutables: PlanCandidate["localExecutables"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        localExecutables
          ? {
              sources,
              ...(prerequisites ? { prerequisites } : {}),
              localExecutables,
            }
          : prerequisites
            ? { sources, prerequisites }
            : sources,
      ),
    )
    .digest("hex");
}

export interface ApplicationServices {
  planningModel: PlanningModel;
  driver: ExecutionDriver;
  github: GitHubGateway;
  delivery: DeliveryStrategy;
  contentStore: ContentStore;
  reportRunStatus?: (message: string) => void;
}

function configuredDiagnosticSecrets(config: FactoryConfig): string[] {
  return [
    ...config.policy.allowedSecretNames
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value)),
    ...serviceLoginSecrets(),
  ];
}

/** A read-only preview: plans and reviews without writing Objective state. */
export async function planObjective(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "planningModel" | "github">,
): Promise<PlanCandidate> {
  validateTarget(config.repository, config.checkout);
  checkRequiredEnvironment(config);
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
  try {
    const issue = await services.github.objective(objective);
    const baseSha = git(config.checkout, "rev-parse", "HEAD");
    const result = await compilePlan(
      objective,
      issue.body,
      baseSha,
      config.checkout,
      services.planningModel,
      factoryConfigDigest(config),
      diagnostics.modelObserver({ scopeId: planningScopeId }),
      executionProfileChoices(config),
      // The same recoverable planning as run, over a ledger nothing saves.
      {
        state: { autonomy: resolveAutonomy(config.autonomy) },
        save: () => undefined,
      },
      await planningPrerequisites(config, services.github, objective, baseSha),
      preflightObjective(config, issue.body, baseSha),
      { configuredConcurrency: resolveCapacity(config).concurrency },
    );
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
  }
}

/**
 * Decide the plan a run persisted in state. `plan` names the short review digest status showed,
 * so a decision binds to the plan the operator saw. Accepting binds the answer to that exact
 * reviewed plan; refusing discards the unprojected preparation so the next run plans again.
 */
export async function decidePlan(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github">,
  input: {
    plan?: string;
    actor: string;
    outcome: "accept" | "refuse";
    answer: string;
    reason: string;
  },
): Promise<PreparationState> {
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
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = mutationLock(config, objective);
  try {
    const path = statePath(config.repository, objective);
    const preparation = readContinuation(config.repository, objective);
    if (preparation?.schemaVersion !== 8)
      throw new Error(
        "Objective has no persisted plan awaiting a decision; run it first",
      );
    if (preparation.plan && !namesPlan(preparation.plan, input.plan))
      throw new Error(
        `Decision names plan ${input.plan ?? "(none)"}, but the saved plan is ${shortPlanDigest(preparation.plan)}; inspect status and decide again`,
      );
    if (input.outcome === "refuse") {
      if (!input.actor.trim() || !input.reason.trim())
        throw new Error("A plan refusal needs actor and reason");
      // Projection may have created an issue before recording it.
      if (
        Object.keys(preparation.issueByItemId).length ||
        preparation.coordinator.phase === "projection"
      )
        throw new Error(
          "Work Item projection has started; cancel the Objective instead",
        );
      rmSync(path);
    } else {
      if (!preparation.plan)
        throw new Error("Objective planning has not produced a plan yet");
      if (preparation.plan.review.acceptable === false)
        throw new Error(
          `Factory cannot accept plan ${shortPlanDigest(preparation.plan)}; refuse it to plan again`,
        );
      const issue = await services.github.objective(objective);
      preparation.plan = await resolvePlan(
        preparation.plan,
        objective,
        issue.body,
        preparation.baseSha,
        config.checkout,
        input,
        factoryConfigDigest(config),
      );
      delete preparation.coordinator.waitReason;
      saveState(path, preparation);
    }
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "completed",
      durationMs: Date.now() - started,
      metadata: {
        review: input.outcome === "refuse" ? "refused" : "human-accepted",
      },
      detail: input.reason,
    });
    return preparation;
  } catch (error) {
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "failed",
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    releaseMutationLock(lockPath, lock);
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
  // Preparation resumes by repeating its current step, so any point is safe.
  if (state.schemaVersion === 8) return true;
  return (
    !state.coordinator?.phase.endsWith("-submitted") &&
    !Object.entries(state.work).some(
      ([id, work]) =>
        // An item waiting in place for the operator holds no effect in flight.
        (work.status === "running" &&
          !isReadinessWait(state, id) &&
          !awaitsOperator(work.wait)) ||
        (work.status === "published" &&
          (!work.pullRequest || !work.changeRef || !work.treeSha)),
    )
  );
}

interface LocalOwner {
  handoff?: boolean;
  /**
   * Aborts on pause, drain and handoff (SIGTERM, `handoff`): a step waiting
   * between tries stops with `StepPaused`, nothing charged or failed.
   * Replaced by a fresh controller on resume.
   */
  pause: AbortController;
  snapshot?: ContinuationState;
  lock: ControllerLock;
  abort: AbortController;
  changed: boolean;
  deadlineAt?: string;
  cancellation?: Promise<void>;
  waitForWake: () => Promise<void>;
  /**
   * Settles at the next wake without consuming it, so a running pass sees
   * the operator's live control action (a `factory retry`) at once.
   */
  woken: () => Promise<void>;
  /** The pass's observing save: emits each item's state change, terminal ones included. */
  save?: (state: FactoryState) => void;
}
const owners = new Map<string, LocalOwner>();
const ownerKey = (config: FactoryConfig, objective: number) =>
  `${config.repository}#${objective}`;
function mutationState(
  config: FactoryConfig,
  objective: number,
): FactoryState | undefined {
  const snapshot =
    owners.get(ownerKey(config, objective))?.snapshot ??
    readContinuation(config.repository, objective);
  if (snapshot?.schemaVersion === 8)
    throw new Error("Objective is still preparing");
  const state = snapshot ?? readState(config.repository, objective);
  return state;
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
  if (
    !["pause", "drain", "resume", "status", "propose-amendment"].includes(
      request.action,
    )
  )
    throw new Error("No active coordinator owns this Objective");
  const lockPath = join(stateRoot(config.repository), "controller.lock");
  const lock = acquireControllerLock(lockPath, request.objective);
  try {
    const state = readContinuation(config.repository, request.objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (request.action === "status") return state.coordinator;
    if (request.action === "propose-amendment") {
      if (state.schemaVersion !== 7 || !request.input?.replacement)
        throw new Error(
          "Only diagnosed rejected-amendment replacement is supported without an active owner",
        );
      if (state.configDigest !== factoryConfigDigest(config))
        throw new Error("Objective differs from this Factory installation");
      const result = submitAmendment(
        state,
        request.input as unknown as AmendmentProposal,
      );
      saveState(statePath(config.repository, request.objective), state);
      return result;
    }
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
    const identity = linuxProcessIdentity(subprocess.pid);
    // Another process now has the pid. The kernel reuses a pid only once no
    // process belongs to the group it led, so ours is gone; the process
    // group there now is foreign and is never signalled.
    if (identity && identity.startTime !== subprocess.startTime) continue;
    if (!processGroupExists(subprocess.pid)) continue;
    // No process has the pid but its group remains (a reused pid's group
    // whose leader also exited looks the same), or our leader moved to
    // another group: ownership of the group is unproven.
    if (identity?.group !== subprocess.pid)
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
  save: () => void,
): Promise<void> {
  const errors: string[] = [];
  const tasks: (() => Promise<void>)[] = [];
  if (state.schemaVersion === 7)
    for (const work of Object.values(state.work)) {
      if (
        work.step !== "execute" ||
        work.status === "done" ||
        work.status === "cancelled"
      )
        continue;
      // An attempt saved before its start was recorded: the driver stops
      // whatever it started under the attempt's identity, if anything.
      if (!work.execution) {
        if (work.attempt)
          tasks.push(() =>
            driver.cancelUnrecorded(
              workerIdentity(work),
              executionContext(work, save),
            ),
          );
        continue;
      }
      tasks.push(() =>
        driver.cancel(
          structuredClone(work.execution!),
          executionContext(work, save),
        ),
      );
    }
  tasks.push(() => cancelRecordedSubprocesses(state));
  for (const result of await Promise.allSettled(tasks.map((task) => task())))
    if (result.status === "rejected") errors.push(String(result.reason));
  if (errors.length) throw new Error(errors.join("; "));
}

/**
 * Plan if needed, then run within the configured autonomy until the Objective completes or
 * needs a human decision. A rerun resumes from state and never plans an existing plan again.
 */
export async function runObjective(
  config: FactoryConfig,
  objective: number,
  services: ApplicationServices,
  options: {
    deadlineAt?: string;
    ownerLock?: ControllerLock;
    observeControl?: (
      handler: ((request: ControlRequest) => Promise<unknown>) | undefined,
    ) => void;
  } = {},
): Promise<ContinuationState> {
  if (!!options.ownerLock !== !!options.observeControl)
    throw new Error(
      "Borrowed Objective ownership requires its intake control handler",
    );
  if (options.deadlineAt && !Number.isFinite(Date.parse(options.deadlineAt)))
    throw new Error("Deadline must be an absolute timestamp");
  const root = stateRoot(config.repository);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, "controller.lock");
  const lock = options.ownerLock ?? acquireControllerLock(lockPath, objective);
  if (options.ownerLock) {
    const recorded = readControllerOwner(lockPath);
    const identity = linuxProcessIdentity(process.pid);
    if (
      recorded?.token !== lock.token ||
      recorded.pid !== process.pid ||
      recorded.startTime !== identity?.startTime ||
      recorded.objective !== objective
    )
      throw new Error("Borrowed Objective owner identity differs");
  }
  let snapshot: ContinuationState | undefined;
  try {
    snapshot = readContinuation(config.repository, objective);
  } catch (error) {
    if (!options.ownerLock) releaseControllerLock(lockPath, lock);
    throw error;
  }
  if (snapshot)
    snapshot.coordinator ??= {
      mode: "running",
      phase: "idle",
      phaseStartedAt: new Date().toISOString(),
    };
  let woke: { promise: Promise<void>; resolve: () => void } | undefined;
  const owner: LocalOwner = {
    changed: false,
    lock,
    abort: new AbortController(),
    pause: new AbortController(),
    waitForWake: async () => undefined,
    woken: () => {
      if (!woke) {
        let resolve!: () => void;
        const promise = new Promise<void>((settle) => {
          resolve = settle;
        });
        woke = { promise, resolve };
      }
      return woke.promise;
    },
    snapshot,
    deadlineAt: options.deadlineAt,
  };
  owners.set(ownerKey(config, objective), owner);
  const waiters = new Set<() => void>();
  const wake = () => {
    owner.changed = true;
    for (const resolve of waiters) resolve();
    waiters.clear();
    woke?.resolve();
    woke = undefined;
  };
  /** A handoff: stop at the next safe point and release ownership. */
  const releaseOwnership = () => {
    owner.handoff = true;
    owner.pause.abort(new Error("Coordinator handoff requested"));
  };
  const wait = async (observationDelay?: number) => {
    if (owner.handoff && owner.snapshot && canHandoff(owner.snapshot))
      throw new CoordinatorHandoff();
    if (owner.changed) {
      owner.changed = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve();
      };
      const timer =
        observationDelay === undefined
          ? undefined
          : setTimeout(finish, observationDelay);
      waiters.add(finish);
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
    if (owner.snapshot.schemaVersion === 7 && owner.snapshot.finalAcceptance) {
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
    owner.abort.abort(new Error("Objective cancellation requested"));
    if (owner.cancellation) return;
    owner.cancellation = (async () => {
      const state = owner.snapshot!;
      try {
        await cancelKnownWork(state, services.driver, persist);
        // Cessation is verified: an earlier unresolved attempt is answered.
        delete state.coordinator!.cancelError;
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
      if (!options.ownerLock) releaseControllerLock(lockPath, lock);
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
    const handle = async (request: ControlRequest) => {
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
        if (state.schemaVersion !== 7)
          throw new Error("Planning has no active graph to amend");
        if (owner.abort.signal.aborted)
          throw new Error(
            "Cancellation is in progress; amendment intake is fenced",
          );
        const result = submitAmendment(
          state,
          request.input as unknown as AmendmentProposal,
        );
        persist();
        wake();
        return result;
      }
      if (request.action === "cancel") {
        if (state.schemaVersion === 7 && state.finalAcceptance)
          throw new Error(
            "Acceptance is sealed; resume to reconcile Objective closure",
          );
        cancel();
        return "requested";
      }
      if (["pause", "drain", "resume", "handoff"].includes(request.action)) {
        if (request.action === "handoff") releaseOwnership();
        else if (request.action === "resume") {
          if (owner.pause.signal.aborted && !owner.handoff)
            owner.pause = new AbortController();
        } else owner.pause.abort(new Error(`Coordinator ${request.action}`));
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
        if (request.action === "retry") {
          const retried = retryWorkItem(
            config,
            objective,
            input.item === undefined ? undefined : String(input.item),
          );
          wake();
          return retried;
        }
        if (request.action === "repair")
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
    };
    if (options.observeControl) options.observeControl(handle);
    else server = await serveControl(config.repository, lock, handle);
  } catch (error) {
    options.observeControl?.(undefined);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    owners.delete(ownerKey(config, objective));
    if (!options.ownerLock) releaseControllerLock(lockPath, lock);
    throw error;
  }
  const handoff = () => {
    releaseOwnership();
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
          clearAllRepeats(state);
          if (state.schemaVersion === 7) {
            for (const work of Object.values(state.work))
              if (work.status === "pending" || work.status === "running")
                work.status = "cancelled";
            if (owner.save) owner.save(state);
            else persist();
          } else persist();
        }
        throw new StepFault({
          kind: "cancelled",
          detail: "Objective cancellation requested",
        });
      }
      if (
        state?.coordinator?.mode !== "running" &&
        state?.coordinator &&
        !(
          state.schemaVersion === 7 &&
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
        () => runObjectivePass(config, objective, services, owner),
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
        // A pass stopped by the cancel request (a step answers `cancelled`):
        // the loop records the cancellation.
        if (current?.cancelRequested && !owner.handoff) return undefined;
        // Planning stops at a pause or drain; the owner keeps serving control until resume.
        if (
          current?.schemaVersion === 8 &&
          current.coordinator.mode !== "running" &&
          !current.cancelRequested &&
          !owner.handoff
        )
          return undefined;
        throw error;
      });
      if (!result) continue;
      owner.snapshot = result;
      // A pass that stopped for the cancel request: the loop records it.
      if (result.cancelRequested && !owner.handoff) continue;
      // A preparation comes back only when its plan needs a human decision.
      if (
        result.schemaVersion === 8 ||
        objectiveComplete(result) ||
        result.cancelledAt
      )
        return result;
      if (
        result.coordinator?.mode === "running" &&
        amendmentBlocksDispatch(result) &&
        result.pendingAmendment?.phase !== "rejected" &&
        !hasReadinessWait(result)
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
          (work.recovery?.phase === "stopped" ||
            work.recovery?.phase === "diagnosing") &&
          ["failed", "waiting"].includes(work.status),
      );
      // A step's question or configuration fix names what to answer: the
      // Objective's own wait first, then a Work Item's.
      const asked = Object.entries(result.work).find(([, work]) =>
        awaitsOperator(work.wait),
      );
      result.coordinator!.waitReason = result.wait
        ? `${result.wait.detail}${result.wait.fix ? `. ${result.wait.fix}` : ""}`
        : result.coordinator!.mode === "draining"
          ? "Drained; no owned attempts remain"
          : stoppedRepair
            ? `Work Item ${stoppedRepair[0]}: ${stoppedRepair[1].recovery!.failure?.decision ?? "Inspect the retained recovery failure"}`
            : asked
              ? `Work Item ${asked[0]}: ${asked[1].wait!.detail}${asked[1].wait!.fix ? `. ${asked[1].wait!.fix}` : ""}`
              : hasReadinessWait(result)
                ? "Awaiting exact published checks or target protection readiness"
                : "Awaiting exact candidate decision or resume";
      persist();
      // Nothing automatic remains: the Objective needs a human decision.
      if (result.coordinator?.mode === "running" && !hasReadinessWait(result))
        return result;
      // Read-only observations use the same owner and GitHub rate gate. No model work while idle.
      await wait(result.coordinator?.mode === "running" ? 5_000 : undefined);
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.off("SIGUSR1", cancel);
    process.off("SIGTERM", handoff);
    options.observeControl?.(undefined);
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await controlTail;
    owners.delete(ownerKey(config, objective));
    if (!options.ownerLock) releaseControllerLock(lockPath, lock);
  }
}

async function runObjectivePass(
  config: FactoryConfig,
  objective: number,
  services: ApplicationServices,
  owner: LocalOwner,
): Promise<ContinuationState> {
  validateTarget(config.repository, config.checkout);
  if (
    config.execution.kind !== "local" &&
    config.execution.kind !== "managed-agent" &&
    config.execution.kind !== "sandbox"
  )
    throw new Error("Execution mode is not implemented");
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
            .map((work) => work.step ?? "active"),
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
  owner.save = save;
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
  // Cancel stops every step. Pause, drain and handoff stop an Objective step
  // waiting between tries only at a safe point (no running item depends on
  // it); a drain that must still drive running items keeps them going.
  const objectiveSignal = () => owner.abort.signal;
  const objectivePause = () =>
    owner.snapshot && !canHandoff(owner.snapshot)
      ? undefined
      : owner.pause.signal;
  /** Stop a pass the operator cancelled: a `cancelled` fault, never a failure. */
  const stopIfCancelled = () => {
    if (cancellationRequested())
      throw new StepFault({
        kind: "cancelled",
        detail: "Objective cancellation requested",
      });
  };
  try {
    diagnostics.emit({ operation: "objective-run", outcome: "started" });
    // Before the Objective has state its first reads repeat in memory: there
    // is nothing to save yet.
    const unsaved: Pick<PreparationState, "repeats" | "wait"> = {};
    /** Run one Objective step (see src/step.ts) on `state`'s records. */
    const objectiveStep = <T>(
      state: ContinuationState | undefined,
      name: string,
      fn: (context: StepContext) => Promise<T>,
      paid = false,
      /** False inside item runners, which keep driving their items. */
      pausable = true,
    ): Promise<T> =>
      step(
        state ?? (unsaved as StepState),
        { scope: "objective", name, paid },
        fn,
        {
          save: () => {
            if (state?.schemaVersion === 7) save(state);
            else if (state) saveState(path, state);
            else {
              // Nothing is saved before the Objective has state: report an
              // outage to the run's output instead.
              const outage = outageOf(unsaved as StepState, "objective");
              if (outage)
                reportRunStatus?.(
                  `Factory: ${outage.step} failing since ${outage.since} (${outage.tries} tries): ${faultDetail(outage.last)}`,
                );
            }
          },
          signal: objectiveSignal(),
          pause: pausable ? objectivePause() : undefined,
        },
      );
    const observeObjective = (state = owner.snapshot) =>
      objectiveStep(state, "observe", () => github.objective(objective));
    /**
     * The Objective issue changed outside Factory since planning: the
     * operator's decision, whether the run or a resume sees it first.
     */
    const changedOutside = (
      issue: { state?: string; body: string },
      state: FactoryState,
    ): Error | undefined => {
      const changed =
        issue.state === "closed" && !state.finalValidation?.passed
          ? "The Objective issue was closed"
          : state.objectiveBodyDigest &&
              createHash("sha256").update(issue.body).digest("hex") !==
                state.objectiveBodyDigest
            ? "The Objective issue body changed"
            : undefined;
      return changed
        ? attachFault(
            new Error(`${changed}; operator direction required`),
            decision(
              `${changed} outside Factory. Restore it, then factory retry --objective ${objective}; or factory cancel --objective ${objective}`,
            ),
          )
        : undefined;
    };
    const issue = await observeObjective();
    assertObjectiveCriteria(issue.body);
    const installationConfigDigest = factoryConfigDigest(config);
    const continuation = readContinuation(config.repository, objective);
    owner.snapshot = continuation;
    checkRequiredEnvironment(config, continuation?.autonomy);
    if (owner.handoff && continuation?.coordinator) {
      continuation.coordinator.mode = "draining";
      saveState(path, continuation);
    }
    let preparation =
      continuation?.schemaVersion === 8 ? continuation : undefined;
    let state = continuation?.schemaVersion === 7 ? continuation : undefined;
    if (issue.state === "closed" && !state)
      throw new Error(
        "Objective issue is confirmed closed; operator direction required",
      );
    if (state) {
      // Subprocesses recorded by an interrupted controller (for example a
      // validation command) are ours: stop any survivor and clear the
      // records, then repeat the step they belonged to.
      if (state.coordinator?.processes?.length) {
        await cancelRecordedSubprocesses(state);
        saveState(path, state);
      }
      if (
        state.schemaVersion !== 7 ||
        state.repository !== config.repository ||
        state.configDigest !== installationConfigDigest
      ) {
        throw new Error(
          "Existing Objective state does not match this Factory installation",
        );
      }
      if (state.error)
        throw new Error(
          `Objective stopped: ${state.error}. Fix the cause, then run \`factory retry --objective ${objective}\``,
        );
      if (
        !state.objectiveBodyDigest &&
        workspacePackageAdditions(issue.body).length
      )
        throw new Error(
          "Workspace package authority requires a digest-bound Objective; create a new plan",
        );
      // A decision, as when delivery observes the change: the observe
      // step saves the question, and `factory retry` asks it again.
      const changed = changedOutside(issue, state);
      if (changed)
        await objectiveStep(state, "observe", async () => {
          throw changed;
        });
      stateDiagnostics = new StateDiagnostics(
        diagnostics,
        state,
        config.delivery.kind,
        state.capacity.concurrency,
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
            objectiveSignal(),
            objectivePause(),
          );
      if (state.finalValidation?.passed) {
        reportRunStatus?.(
          "Factory: resuming the existing run from atomic state",
        );
        if (!state.finalAcceptance && state.objectiveClosure !== "complete") {
          // A remote read: transient faults repeat with backoff.
          const head = await objectiveStep(state, "final-head", async () =>
            fetchHead(config.checkout, await github.defaultBranch()),
          );
          if (head !== objectiveCandidate(state)?.commitSha)
            throw new Error(
              "Default branch changed before historical final acceptance could be sealed",
            );
        }
        await closeObjectiveIssue(
          state,
          issue.body,
          github,
          saveCurrent,
          objectiveSignal(),
          objectivePause(),
        );
        return state;
      }
      if (state.cancelRequested || state.cancelledAt)
        throw new Error(
          "Objective was cancelled; use explicit retry or operator direction",
        );
      reportRunStatus?.("Factory: resuming the existing run from atomic state");
    } else {
      const baseSha = git(config.checkout, "rev-parse", "HEAD");
      const prerequisites = await objectiveStep(
        owner.snapshot,
        "prerequisites",
        () => planningPrerequisites(config, github, objective, baseSha),
      );
      const objectivesRoot = join(root, "objectives");
      if (existsSync(objectivesRoot)) {
        for (const name of readdirSync(objectivesRoot)) {
          if (!/^\d+$/.test(name) || Number(name) === objective) continue;
          const other = readContinuation(config.repository, Number(name));
          if (
            other &&
            !(other.schemaVersion === 7 && objectiveComplete(other)) &&
            !other.cancelledAt
          )
            throw new Error(
              `Objective #${name} is already active in this installation`,
            );
        }
      }
      const localExecutables = preflightObjective(config, issue.body, baseSha);
      const sourcePacketDigest = preparationSourceDigest(
        planningSources(issue.body, baseSha, config.checkout),
        prerequisites,
        localExecutables,
      );
      if (!preparation) {
        preparation = {
          sourcePacketDigest,
          schemaVersion: 8,
          kind: "preparing",
          repository: config.repository,
          objective,
          runId: randomUUID(),
          configDigest: installationConfigDigest,
          baseSha,
          objectiveBodyDigest: createHash("sha256")
            .update(issue.body)
            .digest("hex"),
          autonomy: resolveAutonomy(config.autonomy),
          capacity: resolveCapacity(config),
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
        preparation.sourcePacketDigest !== sourcePacketDigest ||
        preparation.configDigest !== installationConfigDigest ||
        preparation.baseSha !== baseSha ||
        preparation.objectiveBodyDigest !==
          createHash("sha256").update(issue.body).digest("hex")
      )
        throw new Error(
          Object.keys(preparation.issueByItemId).length
            ? "Base, Objective, sources or configuration changed during projection; operator direction required"
            : "Base, Objective, sources or configuration changed since planning; refuse the plan with factory decide to plan again",
        );
      if (owner.handoff && canHandoff(preparation))
        throw new CoordinatorHandoff();
      const planningScopeId = preparation.runId;
      // Planning that stopped without a reviewable plan waits for an operator refusal.
      const stopPlanning = (detail: string) => {
        preparation!.coordinator.phase = "waiting";
        preparation!.coordinator.phaseStartedAt = new Date().toISOString();
        preparation!.coordinator.waitReason = `Planning stopped for a decision: ${detail}`;
        saveState(path, preparation!);
        return preparation!;
      };
      if (
        !preparation.plan &&
        preparation.planningRecovery?.phase === "stopped"
      )
        return stopPlanning(
          preparation.coordinator.waitReason?.replace(
            /^Planning stopped for a decision: /,
            "",
          ) ?? "inspect the planning diagnostics",
        );
      if (preparation.plan)
        reportRunStatus?.("Factory: continuing with the persisted plan");
      const capacity = preparation.capacity;
      let plan = preparation.plan;
      if (!plan)
        try {
          plan = await diagnostics.span(
            {
              operation: "planning",
              metadata: { baseSha, scopeId: planningScopeId },
            },
            () => {
              reportRunStatus?.(
                "Factory: compiling and independently reviewing a fresh plan",
              );
              // The plan and its review persist in the preparation, so a
              // repeat never pays again for a call that completed.
              return objectiveStep(
                preparation,
                "plan",
                (context) =>
                  compilePlan(
                    objective,
                    issue.body,
                    baseSha,
                    config.checkout,
                    paidModel(planningModel, context),
                    installationConfigDigest,
                    diagnostics.modelObserver({ scopeId: planningScopeId }),
                    executionProfileChoices(config),
                    {
                      state: preparation!,
                      save: () => saveState(path, preparation!),
                      stopped: () =>
                        cancellationRequested() ||
                        preparation!.coordinator.mode !== "running",
                    },
                    prerequisites,
                    localExecutables,
                    { configuredConcurrency: capacity.concurrency },
                  ),
                true,
              );
            },
            (candidate) => ({ itemCount: candidate.graph.items.length }),
          );
        } catch (error) {
          if (
            preparation.plan ||
            preparation.planningRecovery?.phase !== "stopped"
          )
            throw error;
          return stopPlanning(
            error instanceof Error ? error.message : String(error),
          );
        }
      preparation.plan = plan;
      if (!["clean", "human-accepted"].includes(plan.review.status)) {
        // A plan Factory's own checks refuse can only be refused: it still
        // waits for the operator's plan decision (exit 2), never a failure.
        let unacceptable: string | undefined;
        try {
          verifyPlanCandidate(
            plan,
            objective,
            issue.body,
            baseSha,
            config.checkout,
            installationConfigDigest,
            true,
            capacity.concurrency,
          );
        } catch (error) {
          if (attachedFault(error)) throw error;
          unacceptable = error instanceof Error ? error.message : String(error);
        }
        if (unacceptable) plan.review.acceptable = false;
        else delete plan.review.acceptable;
        preparation.coordinator.phase = "waiting";
        preparation.coordinator.phaseStartedAt = new Date().toISOString();
        preparation.coordinator.waitReason = unacceptable
          ? `Plan needs a decision: it cannot be accepted (${unacceptable}); refuse it to plan again`
          : `Plan needs a decision: ${plan.review.failure?.question ?? plan.review.findings[0]?.question ?? "inspect the plan review"}`;
        saveState(path, preparation);
        return preparation;
      }
      verifyPlanCandidate(
        plan,
        objective,
        issue.body,
        baseSha,
        config.checkout,
        installationConfigDigest,
        false,
        capacity.concurrency,
      );
      if (JSON.stringify(plan.prerequisites) !== JSON.stringify(prerequisites))
        throw new Error(
          "Planning native prerequisites changed before activation",
        );
      if (
        JSON.stringify(plan.localExecutables) !==
        JSON.stringify(localExecutables)
      )
        throw new Error(
          "Planning local executable observations changed before activation",
        );
      preparation.coordinator.phase = "projection";
      preparation.coordinator.phaseStartedAt = new Date().toISOString();
      saveState(path, preparation);
      stopIfCancelled();
      if (
        JSON.stringify(plan.executionProfiles) !==
        JSON.stringify(executionProfileChoices(config))
      )
        throw new Error(
          "Accepted plan execution profile policy differs from installation",
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
      const waitWhileStopped = async () => {
        while (
          preparation!.coordinator.mode !== "running" &&
          !cancellationRequested()
        )
          await owner.waitForWake();
        stopIfCancelled();
      };
      await waitWhileStopped();
      // Projection finds existing issues by marker before creating any, so a
      // repeat simply projects again; recorded numbers are passed as known.
      const projected = await diagnostics.span(
        {
          operation: "github-projection",
          metadata: { itemCount: graph.items.length },
        },
        () =>
          objectiveStep(preparation, "project", (context) =>
            github.projectGraph({
              graph,
              objectiveIssue: objective,
              knownIssues: preparation!.issueByItemId,
              author: preparation!.issueAuthor,
              authored: (login) => {
                preparation!.issueAuthor = login;
                saveState(path, preparation!);
              },
              beforeCreate: waitWhileStopped,
              projected: (id, number) => {
                preparation!.issueByItemId[id] = number;
                saveState(path, preparation!);
                context.progress();
              },
            }),
          ),
      );
      state = {
        schemaVersion: 7,
        ...(preparation.planningRecovery
          ? { planningRecovery: preparation.planningRecovery }
          : {}),
        ...(preparation.charges ? { charges: preparation.charges } : {}),
        autonomy: preparation.autonomy,
        capacity,
        planGraphDigest: plan.graphDigest,
        ...(plan.prerequisites
          ? {
              prerequisitesDigest: createHash("sha256")
                .update(JSON.stringify(plan.prerequisites))
                .digest("hex"),
            }
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
        ...(preparation.issueAuthor
          ? { issueAuthor: preparation.issueAuthor }
          : {}),
        work: Object.fromEntries(
          graph.items.map((item) => [item.id, { status: "pending" }]),
        ),
      };
      stateDiagnostics = new StateDiagnostics(
        diagnostics,
        state,
        config.delivery.kind,
        capacity.concurrency,
      );
    }
    state.coordinator ??= {
      mode: "running",
      phase: "active",
      phaseStartedAt: new Date().toISOString(),
    };
    state.coordinator.observedAt = new Date().toISOString();
    await applyPendingAmendment({
      state,
      config,
      body: issue.body,
      model: planningModel,
      github,
      save: () => save(state),
      cancelled: cancellationRequested,
      signal: objectiveSignal(),
      pause: objectivePause(),
      diagnostics,
    });
    if (state.coordinator.mode === "running" && !cancellationRequested()) {
      for (const [id, work] of Object.entries(state.work)) {
        if (
          work.status === "failed" &&
          work.recovery?.phase === "ready" &&
          work.recovery.correction
        ) {
          applyWorkCorrection(state, id, work.recovery.correction);
          save(state);
        }
      }
      const current = state;
      await resumeDiagnoses({
        state: current,
        model: planningModel,
        diagnostics,
        sources: planningSources(issue.body, current.baseSha, config.checkout),
        save: () => save(current),
        stopped: () =>
          cancellationRequested() || current.coordinator?.mode !== "running",
        signal: objectiveSignal(),
        pause: objectivePause(),
      });
    }
    const graph = state.graph;
    verifyExecutionProfiles(graph, executionProfileChoices(config));
    await driver.preflight?.(graph);
    // This controller holds the repository lock: no validation runs yet.
    await sweepValidationWorktrees(config.checkout, root);
    validateCommandProvenance(
      graph,
      planningSources(issue.body, state.baseSha, config.checkout),
      config.checkout,
    );
    stateForSignal = state;
    save(state);
    /** Delivery re-observes the Objective: a foreign edit or closure is a decision. */
    // Items deliver concurrently; they share one observation in flight.
    let observing: Promise<void> | undefined;
    const reconcile = async () => {
      observing ??= observeUnchanged().finally(() => {
        observing = undefined;
      });
      await observing;
      stopIfCancelled();
    };
    const observeUnchanged = async () => {
      await objectiveStep(
        state,
        "observe",
        async () => {
          const changed = changedOutside(
            await github.objective(objective),
            state,
          );
          if (changed) throw changed;
        },
        false,
        false,
      );
      state.coordinator!.observedAt = new Date().toISOString();
      save(state);
    };
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
        reconcile,
        cancelled: cancellationRequested,
        signal: owner.abort.signal,
        // Read at each step: resume replaces the controller.
        get pause() {
          return owner.pause.signal;
        },
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
        reconcile,
        cancelled: cancellationRequested,
        signal: owner.abort.signal,
        // Read at each step: resume replaces the controller.
        get pause() {
          return owner.pause.signal;
        },
        paused: () => state.coordinator?.mode !== "running",
        amendmentPending: () => amendmentBlocksDispatch(state),
        woken: owner.woken,
        diagnostics,
      });
      if (awaitingSelection) return state;
    }
    // A done item whose close step waits (a question, a fix, or a closure
    // still pending) holds final validation; the next run repeats the close.
    const closeWaits = (id: string): boolean => {
      const work = state.work[id];
      return (
        awaitsOperator(work?.wait) ||
        (work?.githubClosure !== "complete" && work?.wait !== undefined)
      );
    };
    if (
      state.coordinator.mode !== "running" ||
      amendmentBlocksDispatch(state) ||
      graph.items.some(
        (item) => state.work[item.id]?.status !== "done" || closeWaits(item.id),
      )
    )
      return state;
    stopIfCancelled();
    /**
     * Fetch the default branch. Commits others pushed on top of the
     * integrated Objective move the final candidate to that head, which is
     * validated again; that is not a fault. Returns whether it moved.
     */
    const followDefaultBranch = () =>
      objectiveStep(state, "final-head", async (context) => {
        const head = await fetchHead(
          config.checkout,
          await github.defaultBranch(),
        );
        context.progress();
        const candidate = objectiveCandidate(state)!;
        if (head === candidate.commitSha) return false;
        const integrated = state.integratedSha;
        let contained = false;
        if (candidate.basis === "current-graph-integration" && integrated)
          try {
            git(
              config.checkout,
              "merge-base",
              "--is-ancestor",
              integrated,
              head,
            );
            contained = true;
          } catch {
            contained = false;
          }
        if (!contained) {
          const detail =
            candidate.basis === "pinned-baseline"
              ? `The default branch moved to ${head} from the pinned baseline ${candidate.commitSha}`
              : `The default branch ${head} no longer contains the integrated Objective ${integrated}`;
          throw attachFault(
            new Error(detail),
            decision(
              `${detail}. Only cancelling resolves this: factory cancel --objective ${objective}`,
            ),
          );
        }
        // Commits others pushed on top: follow them, bounded, apart from
        // the integration Factory made.
        const followed =
          state.finalHead?.integratedSha === integrated
            ? state.finalHead
            : undefined;
        const heads = (followed?.heads ?? []).filter((entry) => entry !== head);
        if (head === integrated) delete state.finalHead;
        else {
          // A pending question is answered once the step runs again.
          if (
            !followed?.asked &&
            (followed?.heads.length ?? 0) >= FOLLOWED_HEAD_LIMIT
          ) {
            state.finalHead = { ...followed!, asked: head };
            save(state);
            throw attachFault(
              new Error(`The default branch keeps moving; now at ${head}`),
              decision(
                `The default branch keeps moving: ${followed!.heads.length} pushes by others during final validation, now at ${head}. Validate at ${head} now with factory retry --objective ${objective}, or wait and retry later.`,
              ),
            );
          }
          state.finalHead = {
            integratedSha: integrated!,
            heads: [...heads, head],
          };
        }
        save(state);
        return true;
      });
    await followDefaultBranch();
    for (;;) {
      const finalGraphDigest = graphDigest(state.graph);
      const candidateCommitSha = objectiveCandidate(state)!.commitSha;
      const finalTree = git(
        config.checkout,
        "rev-parse",
        `${candidateCommitSha}^{tree}`,
      );
      assertCompletedCoverage(state);
      const finalValidationStarted = Date.now();
      diagnostics.emit({
        runId: state.runId,
        operation: "objective-validation",
        outcome: "started",
        metadata: {
          candidateCommitSha,
          candidateBasis: objectiveCandidate(state)!.basis,
          ...(state.integratedSha
            ? { integratedSha: state.integratedSha }
            : {}),
          treeSha: finalTree,
        },
      });
      assertPinnedNpmScripts(
        config.checkout,
        state.baseSha,
        candidateCommitSha,
        state.objectiveCommands ?? finalObjectiveCommands(issue.body),
        {
          sourceDeclared:
            state.objectiveCommands ?? finalObjectiveCommands(issue.body),
          workspacePackageAdditions: workspacePackageAdditions(issue.body),
        },
      );
      // Validation and fresh-clone hydration read the remote: one step,
      // repeatable from the top (a fresh worktree and clone per try), so a
      // transient fault repeats with backoff instead of stopping the Objective.
      const { commandEvidence, hydrationReceipt } = await objectiveStep(
        state,
        "final-validate",
        async () => {
          const commandEvidence = await validateTree(
            config.checkout,
            join(root, "final-validation"),
            candidateCommitSha,
            finalTree,
            state.objectiveCommands ?? finalObjectiveCommands(issue.body),
            (entry) =>
              diagnostics.emit({
                runId: state.runId,
                operation: "objective-validation-command",
                outcome: entry.passed ? "completed" : "failed",
                durationMs: entry.durationMs,
                metadata: {
                  commandIndex: entry.index,
                  exitCode: entry.exitCode,
                },
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
                  metadata: {
                    integratedSha: state.integratedSha!,
                    treeSha: finalTree,
                  },
                },
                async () =>
                  verifyHydratedAssets({
                    checkout: config.checkout,
                    workRoot: join(root, "hydration"),
                    integratedSha: candidateCommitSha,
                    selections: selectedAssets,
                  }),
                (receipt) => ({ members: receipt?.members.length ?? 0 }),
              )
            : undefined;
          return { commandEvidence, hydrationReceipt };
        },
      );
      const acceptanceEvidence = hydrationReceipt
        ? { ...commandEvidence, hydrationReceipt }
        : commandEvidence;
      const objectiveEvidence = objectiveReviewEvidence({
        state,
        checkout: config.checkout,
        candidateCommitSha,
        candidateTreeSha: finalTree,
      });
      // A paid step: only the model call counts toward the bound. A lost
      // answer is asked again, an invalid one again with its validation
      // error, until the bound makes it a decision. A criterion the
      // operator must judge comes back as the pending final acceptance.
      let previousInvalid: string | undefined;
      const reviewFinal = () =>
        objectiveStep(
          state,
          "final-review",
          (context) =>
            reviewOutcome({
              beforeSubmit: stopIfCancelled,
              model: paidModel(planningModel, context),
              reviewPhase: "objective-review",
              checkout: config.checkout,
              baseSha: state.baseSha,
              commit: candidateCommitSha,
              evidence: acceptanceEvidence,
              criteria: objectiveCriteria(issue.body),
              sources: planningSources(
                issue.body,
                state.baseSha,
                config.checkout,
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
              ...(previousInvalid ? { previousInvalid } : {}),
              onInvalid: (detail) => {
                previousInvalid = detail;
              },
            }),
          true,
        );
      const reviewed = await diagnostics.span(
        {
          runId: state.runId,
          operation: "objective-acceptance-review",
          metadata: {
            treeSha: finalTree,
            candidateCommitSha,
            candidateBasis: objectiveCandidate(state)!.basis,
            ...(state.integratedSha
              ? { integratedSha: state.integratedSha }
              : {}),
          },
        },
        reviewFinal,
        (outcome) => ({ criteria: outcome.evidence?.criteria?.length ?? 0 }),
      );
      if (reviewed.pending) {
        state.coordinator.phase = "waiting";
        state.finalAcceptancePending = reviewed.pending;
        save(state);
        diagnostics.emit({
          runId: state.runId,
          operation: "objective-validation",
          outcome: "waiting",
          durationMs: Date.now() - finalValidationStarted,
          metadata: { treeSha: finalTree },
          detail: JSON.stringify({
            question: reviewed.pending.question,
            detail: reviewed.pending.detail,
            reviewFinding: reviewed.pending.reviewFinding ?? null,
          }),
        });
        return state;
      }
      const finalEvidence = reviewed.evidence;
      stopIfCancelled();
      delete state.finalAcceptancePending;
      if (
        state.coordinator.mode !== "running" ||
        amendmentBlocksDispatch(state) ||
        graphDigest(state.graph) !== finalGraphDigest ||
        objectiveCandidate(state)?.commitSha !== candidateCommitSha
      ) {
        save(state);
        return state;
      }
      // The default branch moved during final validation: validate its head.
      if (await followDefaultBranch()) continue;
      // No await between this CAS, the immutable seal and pending closure persistence.
      if (
        cancellationRequested() ||
        state.coordinator.mode !== "running" ||
        amendmentBlocksDispatch(state) ||
        graphDigest(state.graph) !== finalGraphDigest ||
        objectiveCandidate(state)?.commitSha !== candidateCommitSha
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
        metadata: {
          treeSha: finalTree,
          candidateCommitSha,
          candidateBasis: objectiveCandidate(state)!.basis,
          ...(state.integratedSha
            ? { integratedSha: state.integratedSha }
            : {}),
        },
      });
      save(state);
      await closeObjectiveIssue(
        state,
        issue.body,
        github,
        () => save(state),
        objectiveSignal(),
        objectivePause(),
      );
      return state;
    }
  } catch (error) {
    if (error instanceof CoordinatorHandoff) throw error;
    // A step stopped by pause, drain or handoff while waiting between tries
    // (or a try cut off by a handoff) is not a fault: its record stays and
    // the next run resumes it.
    const paused =
      error instanceof StepPaused ||
      (attachedFault(error)?.kind === "cancelled" &&
        !!owner.handoff &&
        !cancellationRequested());
    // A handoff releases ownership at a safe point, also before the first
    // snapshot exists; the step repeats on restart.
    if (
      owner.handoff &&
      (owner.snapshot
        ? canHandoff(owner.snapshot)
        : paused && !cancellationRequested())
    ) {
      if (owner.snapshot?.coordinator) {
        owner.snapshot.coordinator.mode = "draining";
        saveState(path, owner.snapshot);
      }
      throw new CoordinatorHandoff();
    }
    if (error instanceof StepPaused && owner.snapshot) {
      await Promise.allSettled(active.values());
      saveState(path, owner.snapshot);
      // Paused planning: the owner serves control until resume.
      if (owner.snapshot.schemaVersion === 8) throw error;
      return owner.snapshot;
    }
    const current = owner.snapshot;
    // A decision or a prerequisite to fix: the scope waits for the operator
    // and nothing fails, no worker stops (step.ts rule 7). A handoff stops
    // the pass; the next controller repeats the step.
    const fault = attachedFault(error);
    const handedOff =
      fault?.kind === "cancelled" &&
      !!owner.handoff &&
      !cancellationRequested();
    const waiting =
      !!current &&
      !cancellationRequested() &&
      (fault?.kind === "decision" || fault?.kind === "config" || handedOff);
    diagnostics.emit({
      runId: stateForSignal?.runId,
      operation: "objective-run",
      outcome: waiting ? "waiting" : "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    if (waiting && current) {
      // Other items run on to their own stopping points.
      await Promise.allSettled(active.values());
      // A question raised outside a step still names its answer.
      if (
        (fault.kind === "decision" || fault.kind === "config") &&
        !awaitsOperator(waitOf(current, "objective")) &&
        !(
          current.schemaVersion === 7 &&
          Object.values(current.work).some((work) => awaitsOperator(work.wait))
        )
      )
        current.wait =
          fault.kind === "decision"
            ? {
                kind: "decision",
                detail: fault.question,
                step: "objective/coordinator",
              }
            : {
                kind: "prerequisite",
                detail: fault.detail,
                fix: fault.fix,
                step: "objective/coordinator",
              };
      saveState(path, current);
      return current;
    }
    if (current?.schemaVersion === 7 && current.finalAcceptance) {
      // A rejected resume cannot turn immutable accepted evidence into a failed run.
      current.coordinator!.waitReason = `Sealed acceptance preserved: ${error instanceof Error ? error.message : String(error)}`;
      saveState(path, current);
      throw error;
    }
    if (
      active.size &&
      current?.schemaVersion === 7 &&
      !cancellationRequested()
    ) {
      for (const work of Object.values(current.work)) {
        if (!work.execution || work.status !== "running") continue;
        try {
          await driver.cancel(
            structuredClone(work.execution),
            executionContext(work, () => saveState(path, current)),
          );
        } catch (cancelError) {
          current.coordinator!.cancelError = String(cancelError);
        }
      }
      await Promise.allSettled(active.values());
    }
    if (current?.schemaVersion === 7 && !cancellationRequested()) {
      for (const work of Object.values(current.work)) {
        if (
          !work.execution ||
          work.step !== "execute" ||
          work.status === "done"
        )
          continue;
        try {
          // Anything short of a complete result may still hold a live remote
          // worker (an interrupted or unresolved attempt reports "failed"),
          // so cancel it; cancelling a settled handle is a no-op.
          const observed = await driver
            .observe(
              structuredClone(work.execution),
              executionContext(work, () => saveState(path, current)),
            )
            .catch(() => undefined);
          if (observed?.state !== "complete")
            await driver.cancel(
              structuredClone(work.execution),
              executionContext(work, () => saveState(path, current)),
            );
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
          clearAllRepeats(current);
          if (current.schemaVersion === 7)
            for (const work of Object.values(current.work))
              if (work.status !== "done" && work.status !== "published")
                work.status = "cancelled";
        }
      } else if (current.schemaVersion === 8) {
        // Preparation resumes by repeating its step; record why it paused.
        current.coordinator.waitReason =
          error instanceof Error ? error.message : String(error);
      } else {
        current.error = error instanceof Error ? error.message : String(error);
      }
      if (current.schemaVersion === 7) save(current);
      else saveState(path, current);
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
      (continuation.schemaVersion === 7 && objectiveComplete(continuation)) ||
      continuation.cancelledAt
    )
      return "cancelled";
    if (continuation.schemaVersion === 7 && continuation.finalAcceptance)
      throw new Error(
        "Acceptance is sealed; resume to reconcile Objective closure",
      );
    continuation.cancelRequested = true;
    saveState(statePath(config.repository, objective), continuation);
    try {
      await cancelKnownWork(continuation, driver, () =>
        saveState(statePath(config.repository, objective), continuation),
      );
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
    if (continuation.schemaVersion === 7)
      for (const work of Object.values(continuation.work)) {
        if (work.execution && work.step === "execute")
          await driver
            .collect(
              structuredClone(work.execution),
              executionContext(
                work,
                () =>
                  saveState(
                    statePath(config.repository, objective),
                    continuation,
                  ),
                () => true,
              ),
            )
            .catch(() => undefined);
        if (work.status !== "done" && work.status !== "published") {
          work.status = "cancelled";
          work.completedAt = new Date().toISOString();
        }
      }
    continuation.cancelledAt = new Date().toISOString();
    clearAllRepeats(continuation);
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

/**
 * Answer a step's decision or config fix (src/step.ts): clear the scope's
 * repeat records and step waits so the step runs again. Allowed while a run
 * is live and with a published PR. False when no step awaits the operator.
 */
function retryStep(
  config: FactoryConfig,
  objective: number,
  itemId: string | undefined,
): boolean {
  const lock = join(stateRoot(config.repository), "controller.lock");
  const lockHandle = mutationLock(config, objective);
  try {
    const state =
      owners.get(ownerKey(config, objective))?.snapshot ??
      readContinuation(config.repository, objective);
    if (!state) throw new Error("Objective has no Factory state");
    // A failed or cancelled item's attempt is over: retry starts a new one.
    const work =
      itemId === undefined || !("work" in state)
        ? undefined
        : state.work[itemId];
    if (
      itemId !== undefined &&
      (!work || work.status === "failed" || work.status === "cancelled")
    )
      return false;
    const scope = itemId === undefined ? "objective" : { item: itemId };
    // An Objective stopped by a defect outside any Work Item runs its step
    // again once the operator has dealt with the cause.
    const stopped =
      itemId === undefined &&
      !!state.error &&
      !state.cancelRequested &&
      !state.cancelledAt;
    if (!awaitsOperator(waitOf(state, scope)) && !stopped) return false;
    clearRepeats(state, scope);
    if (stopped) delete state.error;
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      ...(itemId === undefined ? {} : { itemId }),
      operation: "step-retry",
      outcome: "completed",
    });
    return true;
  } finally {
    releaseMutationLock(lock, lockHandle);
  }
}

/**
 * `factory retry`: answers a step's decision or config fix when one awaits
 * the operator (Objective without an item), else starts a new attempt of a
 * failed or cancelled Work Item.
 */
export function retryWorkItem(
  config: FactoryConfig,
  objective: number,
  itemId?: string,
): "step" | "attempt" {
  if (retryStep(config, objective, itemId)) return "step";
  if (itemId === undefined)
    throw new Error(
      "No Objective step awaits a decision or configuration fix; name a Work Item with --item",
    );
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
    // An item waiting in place for the operator is not active work.
    if (
      Object.values(state.work).some(
        (work) => work.status === "running" && !awaitsOperator(work.wait),
      )
    )
      throw new Error("Finish or cancel active work before retry");
    const work = state.work[itemId];
    if (!work || (work.status !== "failed" && work.status !== "cancelled"))
      throw new Error("Only a failed or cancelled Work Item can be retried");
    // A recorded worker of the failed attempt is stopped by the driver
    // before the new attempt starts (see executeItem).
    const nativeUnit =
      config.delivery.kind === "native-stack"
        ? linearDeliveryUnits(state.graph).find((unit) =>
            unit.items.some((item) => item.id === itemId),
          )
        : undefined;
    // An item that reached delivery resumes it with the same attempt, head
    // and validation: a published item keeps its PR (publish leases against
    // the recorded head), and an unpublished one repeats publish, which finds
    // its PR by head. In a native unit every such item of the unit resumes.
    const delivering = (entry: WorkState | undefined): boolean =>
      !!entry &&
      (entry.status === "failed" || entry.status === "cancelled") &&
      (!!entry.pullRequest || (entry.step === "deliver" && !!entry.validation));
    const resumed = (
      nativeUnit?.items.map((item) => item.id) ?? [itemId]
    ).filter((id) => delivering(state.work[id]));
    if (resumed.includes(itemId)) {
      for (const id of resumed) {
        const entry = state.work[id]!;
        if (!entry.changeRef || !entry.treeSha)
          throw new Error(
            `Work Item ${id} reached delivery without its recorded head; start the Objective fresh or factory cancel --objective ${objective}`,
          );
        clearRepeats(state, { item: id });
        if (entry.pullRequest) {
          entry.status = "published";
          delete entry.step;
        } else {
          entry.status = "running";
          entry.step = "deliver";
        }
        delete entry.error;
      }
      state.cancelRequested = false;
      delete state.cancelledAt;
      delete state.error;
      saveState(statePath(config.repository, objective), state);
      new DiagnosticEmitter(config.repository, objective).emit({
        runId: state.runId,
        itemId,
        operation: "work-retry",
        outcome: "completed",
        detail: "resume delivery",
      });
      // Its delivery steps run again, like an answered step.
      return "step";
    }
    // Only layers above this item were built on its old head (#619); a
    // published layer below keeps its PR and the new attempt builds on it.
    const above = nativeUnit?.items.slice(
      nativeUnit.items.findIndex((item) => item.id === itemId) + 1,
    );
    if (
      work.step === "deliver" ||
      above?.some((item) => state.work[item.id]?.pullRequest) ||
      (nativeUnit &&
        (state.stackNumbers?.[nativeUnit.id] ||
          state.stackMerges?.[nativeUnit.id]))
    )
      throw new Error(
        `Work Item ${itemId} is part of a delivery that cannot start again; retry the published item of its unit, or factory cancel --objective ${objective}`,
      );
    // The new attempt starts without the old one's records or bound.
    clearRepeats(state, { item: itemId });
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
    return "attempt";
  } finally {
    releaseMutationLock(lock, lockHandle);
  }
}

/** Diagnosed correction requests retain the exact failure and consume configured limits. */
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
    // The repair answers the stop the item's failure caused, as retry does.
    delete state.error;
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
    const commit = input.item
      ? work?.changeRef
      : objectiveCandidate(state)?.commitSha;
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
