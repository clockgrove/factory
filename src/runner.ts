import {
  assertReviewArtifactSelection,
  assertReviewArtifactSelectors,
  assertReviewArtifactSelectionSources,
} from "./review-artifacts.js";
import { existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  agentSessionContinuation,
  releaseAgentSessions,
} from "./agent-session.js";
import { bindPlanningPlaybook, resolvePlan } from "./compiler.js";
import { objectiveComplete } from "./completion.js";
import type { FactoryConfig } from "./config.js";
import { factoryConfigDigest, stateRoot } from "./config.js";
import type {
  ContentStore,
  ExecutionDriver,
  GitHubGateway,
  PlanningModel,
} from "./contracts.js";
import {
  type ControlRequest,
  ForegroundControllerError,
  requestControl,
  serveControl,
} from "./coordinator-control.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import { hasReadinessWait } from "./delivery/readiness.js";
import {
  continuationStatusDocument,
  DiagnosticEmitter,
  withDiagnosticSession,
} from "./diagnostics.js";
import { executionContext } from "./execution/checkpoint.js";
import { LocalExecutionDriver } from "./execution/local.js";
import { workerIdentity } from "./item-steps.js";
import { isDeepStrictEqual } from "node:util";
import { assertFailedValidationRecord } from "./failed-validation.js";
import { attachedFault, cancelledFault } from "./fault.js";
import {
  withGitHubRequestBudget,
  withGitHubTransportObserver,
} from "./github-client.js";
import {
  progressOffered,
  projectGitHubProgress,
} from "./github-progress-projection.js";
import {
  projectGitHubProjectStatus,
  projectStatusOffered,
} from "./github-project-projection.js";
import {
  type WorkerDiscoveryDecision,
  assertWorkerDiscoveryDisposition,
  workerDiscoveryDigest,
  type AmendmentProposal,
  amendmentBlocksDispatch,
  decideAmendment,
  graphDigest,
  submitAmendment,
} from "./graph-amendments.js";
import { approvedPlaybook, observeRetrospective } from "./learning.js";
import { assetSelectionDigest } from "./media.js";
import { operatorName } from "./operator.js";
import { refuseUnknownFields } from "./unknown-fields.js";
import {
  currentProcessDeadlineAt,
  currentProcessSignal,
  linuxProcessIdentity,
  pinnedGit,
  removeStaleGitTraces,
  withProcessCancellation,
} from "./process.js";
import {
  abandonFailedProjectQueueReservation,
  assertProjectQueueRunLive,
  bindProjectQueueRun,
  claimProjectQueueRun,
  type QueueOwnerClaim,
  retireUnknownProjectAdmission,
  retireUnknownProjectWithdrawal,
  settleCancelledProjectQueueRun,
  settleFailedProjectQueueReservation,
  settleProjectQueueRun,
  settleStoppedProjectQueueRun,
} from "./project-queue-state.js";
import { objectiveCandidate } from "./qa.js";
import {
  awaitCheckpointAdmission,
  CheckpointProducerInventoryChanged,
  isCheckpointAdmissionFailure,
  isCheckpointCollectionPending,
  privateCheckpointBounds,
  trackCollection,
  withQueueControlVerification,
  withRecoveryCheckpointControllerVerification,
  withRecoveryCheckpointScope,
} from "./recovery-checkpoint.js";
import {
  buildRecoveryCheckpointClosure,
  localWorkerReturn,
} from "./recovery-checkpoint-closure.js";
import {
  archiveAttempt,
  charge,
  type RepairCorrection,
  repairScopes,
} from "./repair-policy.js";
import { runObjectivePass } from "./runner/execution.js";
import {
  type AdmitChildObjectives,
  settleSplitParent,
  splitParentOf,
} from "./runner/split.js";
import { graphExpansionPending } from "./runner/expansion.js";
import {
  type ApplicationServices,
  CoordinatorHandoff,
  cancelKnownWork,
  canHandoff,
  closeCancelledIssues,
  configuredDiagnosticSecrets,
  type LocalOwner,
  mutationLock,
  mutationState,
  ownerKey,
  owners,
  releaseMutationLock,
  releaseCancelledSessions,
  synchronizeWorkItemPause,
} from "./runner/ownership.js";
import { decidePlan } from "./runner/planning.js";
import { SemanticAcceptanceFailure } from "./semantic-refusal.js";
import type { ContinuationState, FactoryState, WorkState } from "./state.js";
import {
  isExecutionState,
  isPreparationState,
  openAmendmentQuestion,
  pendingQuestions,
  rejectionHoldsPause,
  setCoordinatorMode,
} from "./state.js";
import {
  acquireInstallationLock,
  acquireObjectiveLock,
  assertRestoredContinuationReady,
  cancelledContinuationResourceHold,
  assertRestoredInstallationDispatchReady,
  type ControllerLock,
  continuationConfigurationMatches,
  installationLockPath,
  liveControllerOwner,
  objectiveLockPath,
  readContinuation,
  readControllerOwner,
  restoredContinuationOwnershipHold,
  releaseControllerLock,
  saveState,
  statePath,
} from "./state-store.js";
import {
  awaitsOperator,
  clearAllRepeats,
  clearRepeats,
  endProviderLimitWaits,
  waitOf,
} from "./step.js";
import { applyWorkCorrection, recordWorkFailure } from "./work-repair.js";

export type { ApplicationServices } from "./runner/ownership.js";
export { CoordinatorHandoff } from "./runner/ownership.js";
export { decidePlan, planObjective } from "./runner/planning.js";

/** Local observations share the controller's async scope, never its mutation authority. */
function withGitHubDiagnostics<T>(
  config: FactoryConfig,
  objective: number,
  run: () => T,
): T {
  let retained: ContinuationState | undefined;
  try {
    const candidate =
      owners.get(ownerKey(config, objective))?.snapshot ??
      readContinuation(config.repository, objective);
    if (candidate && continuationConfigurationMatches(candidate, config))
      retained = candidate;
  } catch {
    // Missing or unreadable context is unknown; normal lifecycle reads still decide.
  }
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    retained?.configDigest ?? factoryConfigDigest(config),
  );
  return withGitHubTransportObserver(
    (transport) =>
      diagnostics.emit({
        runId: retained?.runId,
        operation: "github-transport",
        outcome: transport.outcome === "completed" ? "completed" : "failed",
        transport,
      }),
    run,
  );
}

/** What `factory decide` was asked, before the Objective's state says which decision it is. */
export interface DecisionInput {
  /** The Work Item whose result is decided; none for a plan or the final acceptance. */
  item?: string;
  /** The pending criterion this decision answers; required only when several are pending. */
  criterion?: string;
  actor: string;
  outcome: "accept" | "refuse";
  /** The answer to a plan's question; required to accept a plan. */
  answer?: string;
  reason: string;
}

/** A forwarded `factory decide` request, checked before any state is read. */
export function parseDecisionInput(value: unknown): DecisionInput {
  const input = (value ?? {}) as Record<string, unknown>;
  const optional = (key: string) => {
    const field = input[key];
    if (field !== undefined && typeof field !== "string")
      throw new Error(`Forwarded decision field ${key} is invalid`);
    return field as string | undefined;
  };
  if (
    (input.outcome !== "accept" && input.outcome !== "refuse") ||
    typeof input.actor !== "string" ||
    typeof input.reason !== "string"
  )
    throw new Error("Forwarded decision lacks its outcome, actor or reason");
  const item = optional("item");
  const criterion = optional("criterion");
  const answer = optional("answer");
  return {
    ...(item !== undefined && { item }),
    ...(criterion !== undefined && { criterion }),
    ...(answer !== undefined && { answer }),
    actor: input.actor,
    outcome: input.outcome,
    reason: input.reason,
  };
}

/**
 * `factory decide`: the Objective's state says what is decided. A saved plan is decided
 * as the plan (its digest read from state); anything else is a result criterion, for the
 * Work Item or the final acceptance, against the exact pending tree in state.
 */
async function decideObjectiveUnscoped(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github">,
  input: DecisionInput,
  /** False when the live installation owner applies the decision itself. */
  forward = true,
): Promise<
  | "plan-accepted"
  | "plan-refused"
  | "amendment-accepted"
  | "amendment-refused"
  | "result"
  | "result-open"
> {
  const state = readContinuation(config.repository, objective);
  if (!state)
    throw new Error(
      `Objective #${objective} has no Factory state; run \`factory run --objective ${objective}\` first`,
    );
  assertRestoredContinuationReady(state, config);
  if (isPreparationState(state)) {
    if (input.item || input.criterion)
      throw new Error(
        "--item names a Work Item's result; a plan decision takes none",
      );
    if (input.outcome === "accept" && !input.answer)
      throw new Error("Accepting a plan requires --answer to its question");
    // A live service owns the installation: it applies the decision (#1290).
    if (forward) {
      const reply = await requestControl(config.repository, {
        objective,
        action: "decide",
        input: { ...input },
      });
      if (reply.handled) {
        if (reply.result !== "plan-accepted" && reply.result !== "plan-refused")
          throw new Error("The live owner returned no plan decision");
        return reply.result;
      }
    }
    await decidePlan(config, objective, services, {
      actor: input.actor,
      outcome: input.outcome,
      answer: input.answer ?? "",
      reason: input.reason,
    });
    return input.outcome === "accept" ? "plan-accepted" : "plan-refused";
  }
  // The planner's open question about the pending amendment (#1296).
  const asked = openAmendmentQuestion(state);
  if (asked && !input.item && !input.criterion) {
    // A live owner holds the amendment: it records the answer itself.
    if (forward) {
      const reply = await requestControl(config.repository, {
        objective,
        action: "decide",
        input: { ...input },
      });
      if (reply.handled) {
        if (
          reply.result !== "amendment-accepted" &&
          reply.result !== "amendment-refused"
        )
          throw new Error("The live owner returned no amendment decision");
        return reply.result;
      }
    }
    const lock = mutationLock(config, objective);
    try {
      const current = mutationState(config, objective);
      if (!current) throw new Error("Objective has no Factory state");
      decideAmendment(current, input);
      saveState(statePath(config.repository, objective), current);
    } finally {
      releaseMutationLock(config, objective, lock);
    }
    return input.outcome === "accept"
      ? "amendment-accepted"
      : "amendment-refused";
  }
  if (input.answer)
    throw new Error(
      "--answer belongs to a plan decision, not a result decision",
    );
  const result = {
    item: input.item,
    criterion: input.criterion,
    actor: input.actor,
    outcome: input.outcome,
    reason: input.reason,
  };
  const reply = forward
    ? await requestControl(config.repository, {
        objective,
        action: "decide",
        input: result,
      })
    : { handled: false };
  if (!reply.handled) decideResult(config, objective, result);
  // Criteria of the same review that still wait keep the Objective stopped.
  const after = readContinuation(config.repository, objective);
  const open =
    isExecutionState(after) &&
    (input.item
      ? after.work[input.item]?.acceptancePending
      : after.finalAcceptancePending);
  return open ? "result-open" : "result";
}

/**
 * What a mode change returns: the coordinator, plus the hold when a rejected
 * amendment kept it from taking effect (`rejectionHoldsPause`), with the
 * command status names to lift it. Only a resume or a drain is held back.
 */
function modeChangeResult(
  config: FactoryConfig,
  state: ContinuationState,
  action: string,
  runActive: boolean,
) {
  if (
    !["resume", "drain"].includes(action) ||
    !rejectionHoldsPause(state) ||
    state.coordinator?.mode !== "paused"
  )
    return state.coordinator;
  const next = continuationStatusDocument(
    state,
    config.repository,
    state.objective,
    config.delivery.kind,
    [],
    state.capacity.concurrency,
    runActive,
    undefined,
    factoryConfigDigest(config),
  ).nextAction?.command;
  return {
    ...state.coordinator,
    hold: { reason: "rejected-amendment" as const, next: next ?? null },
  };
}

/**
 * A rejected amendment holds the Objective paused and blocks dispatch: only the
 * command status names for it (a replacement, `factory cancel`, or the retry
 * that clears another stop first) moves it on. Repair and retry refuse any
 * other change, which would be recorded and then never run (#1297).
 */
function assertRejectionAllows(
  config: FactoryConfig,
  state: ContinuationState,
  command: string,
): void {
  if (!rejectionHoldsPause(state)) return;
  const next = continuationStatusDocument(
    state,
    config.repository,
    state.objective,
    config.delivery.kind,
    [],
    state.capacity.concurrency,
    owners.has(ownerKey(config, state.objective)),
    undefined,
    factoryConfigDigest(config),
  ).nextAction?.command;
  if (next === command) return;
  const reason =
    (isExecutionState(state) && state.pendingAmendment?.error) ||
    "the amendment was rejected";
  throw new Error(
    `Objective #${state.objective} is held by a rejected graph amendment (${reason.length > 200 ? `${reason.slice(0, 199)}…` : reason}); ${next ? `run ${next}` : "submit a replacement or cancel"}`,
  );
}

/** A stopped disposition owns verification and settlement until lease release. */
async function stoppedOperatorHandoff(
  config: FactoryConfig,
  request: ControlRequest,
  github?: GitHubGateway,
): Promise<unknown> {
  const input = request.input;
  if (!input || !github || typeof input.actor !== "string" || !input.actor)
    throw new Error(
      "Stopped operator disposition requires its explicit local operator and genuine Project gateway",
    );
  if (
    [
      input.failedReservationEvidence,
      input.retiredWithdrawalEvidence,
      input.retiredAdmissionEvidence,
    ].filter((value) => value !== undefined).length !== 1
  )
    throw new Error("Choose one exact stopped operator disposition");
  const actor = input.actor;
  const lockPath = installationLockPath(config.repository),
    lock = acquireInstallationLock(config.repository, request.objective);
  try {
    return await withQueueControlVerification(
      {
        config,
        buildClosure: () => buildRecoveryCheckpointClosure({ config }),
      },
      () =>
        checkpointController(config, async () => {
          if (input.retiredAdmissionEvidence !== undefined)
            return await retireUnknownProjectAdmission(
              config,
              github,
              request.objective,
              input.retiredAdmissionEvidence,
              actor,
              lock,
            );
          if (input.retiredWithdrawalEvidence !== undefined)
            return await retireUnknownProjectWithdrawal(
              config,
              github,
              request.objective,
              input.retiredWithdrawalEvidence,
              actor,
              lock,
            );
          return await abandonFailedProjectQueueReservation(
            config,
            github,
            request.objective,
            input.failedReservationEvidence,
            actor,
            lock,
          );
        }),
    );
  } finally {
    releaseControllerLock(lockPath, lock);
  }
}

async function controlObjectiveUnscoped(
  config: FactoryConfig,
  request: ControlRequest,
  _github?: GitHubGateway,
): Promise<unknown> {
  const retained = readContinuation(config.repository, request.objective);
  if (retained && request.action !== "status")
    assertRestoredContinuationReady(retained, config);
  const reply = await requestControl(config.repository, request);
  if (reply.handled) return reply.result;
  if (
    ![
      "pause",
      "drain",
      "resume",
      "status",
      "propose-amendment",
      "decline-discovery",
      "handoff",
    ].includes(request.action)
  )
    throw new Error("No active coordinator owns this Objective");
  const lockPath = objectiveLockPath(config.repository, request.objective);
  const lock = acquireObjectiveLock(config.repository, request.objective);
  try {
    const state = readContinuation(config.repository, request.objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (request.action === "status") return state.coordinator;
    assertRestoredContinuationReady(state, config);
    if (request.action === "decline-discovery") {
      if (!isExecutionState(state))
        throw new Error("Objective is still preparing");
      applyWorkerDiscoveryDecline(
        config,
        state,
        request.input as unknown as WorkerDiscoveryDecision,
      );
      saveState(statePath(config.repository, request.objective), state);
      return "applied";
    }
    if (request.action === "handoff") {
      await settleStoppedProjectQueueRun(config, state, lock);
      return { handedOff: true, runId: state.runId, projectClaim: "quiescent" };
    }
    if (request.action === "propose-amendment") {
      // Every stop names this command, so it works while the Objective is
      // stopped: it records the pending amendment under the lock (the same
      // checks, review and charges as an owner's) and the next run compiles,
      // reviews and projects it.
      if (!isExecutionState(state))
        throw new Error("Planning has no active graph to amend");
      if (request.input?.scope !== "in-scope")
        throw new Error(
          "Only an in-scope amendment can be proposed while the Objective is stopped; a backlog discovery needs a running owner",
        );
      if (!continuationConfigurationMatches(state, config))
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
    setCoordinatorMode(
      state,
      request.action === "pause"
        ? "paused"
        : request.action === "drain"
          ? "draining"
          : "running",
    );
    saveState(statePath(config.repository, request.objective), state);
    return modeChangeResult(config, state, request.action, false);
  } finally {
    releaseControllerLock(lockPath, lock);
  }
}

/** Observe supported ownership handoff without changing its thrown control result. */
export function observeObjectiveController<T>(
  emitter: DiagnosticEmitter,
  configDigest: string,
  task: () => Promise<T>,
  lifecycleOutcome: (result: T) => string | { outcome: string; runId?: string },
): Promise<T> {
  return withDiagnosticSession(
    emitter,
    configDigest,
    () =>
      emitter.span(
        { operation: "objective-controller" },
        task,
        undefined,
        (error) =>
          error instanceof CoordinatorHandoff ? "handed-off" : "failed",
      ),
    lifecycleOutcome,
    (error) => (error instanceof CoordinatorHandoff ? "handed-off" : "failed"),
  );
}

/**
 * Plan if needed, then run within the configured autonomy until the Objective completes or
 * needs a human decision. A rerun resumes from state and never plans an existing plan again.
 */
async function runObjectiveUnscoped(
  config: FactoryConfig,
  objective: number,
  services: ApplicationServices,
  options: {
    deadlineAt?: string;
    ownerLock?: ControllerLock;
    observeControl?: (
      handler: ((request: ControlRequest) => Promise<unknown>) | undefined,
    ) => void | Promise<void>;
    admitChildObjectives?: AdmitChildObjectives;
  } = {},
): Promise<ContinuationState> {
  if (
    config.gitPersistence?.scope === "private-history" &&
    (services.planningModel.providerAttemptAdmission !==
      "controller-checkpoint-v1" ||
      services.driver.effectAdmission !== "controller-checkpoint-v1" ||
      services.github.effectAdmission !== "controller-checkpoint-v1" ||
      services.delivery.effectAdmission !== "controller-checkpoint-v1" ||
      services.github.projectionMutationAdmission !==
        "controller-checkpoint-v1")
  )
    throw new Error(
      "Git-backed continuation requires planning, execution, delivery and GitHub adapters that enforce checkpoint admission",
    );
  const digest = factoryConfigDigest(config);
  const emitter = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    digest,
  );
  return observeObjectiveController(
    emitter,
    digest,
    () =>
      withGitHubDiagnostics(config, objective, () =>
        runObjectiveOwned(config, objective, services, options),
      ),
    (result) => ({
      runId: result.runId,
      outcome:
        isExecutionState(result) && objectiveComplete(result)
          ? "accepted"
          : result.cancelledAt
            ? "cancelled"
            : "not-accepted",
    }),
  );
}

async function runObjectiveOwned(
  config: FactoryConfig,
  objective: number,
  services: ApplicationServices,
  options: NonNullable<Parameters<typeof runObjective>[3]>,
): Promise<ContinuationState> {
  if (!!options.ownerLock !== !!options.observeControl)
    throw new Error(
      "Borrowed Objective ownership requires its intake control handler",
    );
  if (options.deadlineAt && !Number.isFinite(Date.parse(options.deadlineAt)))
    throw new Error("Deadline must be an absolute timestamp");
  const root = stateRoot(config.repository);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // The service lends its installation lease; a foreground run owns only its Objective.
  const lockPath = options.ownerLock
    ? installationLockPath(config.repository)
    : objectiveLockPath(config.repository, objective);
  const lock =
    options.ownerLock ?? acquireObjectiveLock(config.repository, objective);
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
  let queueClaim: QueueOwnerClaim | undefined;
  try {
    removeStaleGitTraces();
    assertRestoredInstallationDispatchReady(config);
    snapshot = readContinuation(config.repository, objective);
    if (snapshot) assertRestoredContinuationReady(snapshot, config);
    // A completed return left by the stopped controller refuses every
    // publication until collected, starting with the claim's admission.
    if (snapshot)
      await collectStoppedWorkerReturns([
        {
          state: snapshot,
          runtime: () => ({ config, driver: services.driver }),
        },
      ]);
    queueClaim = await claimProjectQueueRun(
      config,
      services.github,
      objective,
      lock.token,
      snapshot,
      lock,
    );
    if (queueClaim) {
      if (options.deadlineAt && options.deadlineAt !== queueClaim.deadlineAt)
        throw new Error("Project dispatch cannot replace its frozen deadline");
      options = {
        ...options,
        ...(queueClaim.deadlineAt ? { deadlineAt: queueClaim.deadlineAt } : {}),
      };
    }
    const current = snapshot ? undefined : approvedPlaybook(config.repository);
    const pin = snapshot
      ? snapshot.approvedPlaybookPin
      : current
        ? { version: current.version, digest: current.digest }
        : null;
    services = {
      ...services,
      planningModel: bindPlanningPlaybook(
        services.planningModel,
        config.repository,
        pin,
      ),
    };
  } catch (error) {
    try {
      if (queueClaim && !snapshot)
        await settleFailedProjectQueueReservation(
          config,
          queueClaim,
          lock.token,
          error,
        );
    } catch (settlementError) {
      throw new AggregateError(
        [error, settlementError],
        "Pre-snapshot controller setup and its Project settlement failed",
        { cause: error },
      );
    } finally {
      if (!options.ownerLock) releaseControllerLock(lockPath, lock);
    }
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
    admittedObjectiveBodyDigest: queueClaim?.bodyDigest,
    lock,
    abort: new AbortController(),
    pause: new AbortController(),
    workPause: new AbortController(),
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
    admitChildObjectives: options.admitChildObjectives,
  };
  if (snapshot?.coordinator?.mode !== "running" && snapshot?.coordinator)
    owner.pause.abort(new Error(`Coordinator ${snapshot.coordinator.mode}`));
  synchronizeWorkItemPause(owner);
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
    if (owner.snapshot) {
      owner.pause.abort(new Error("Coordinator handoff requested"));
      // Every running item is between tries or waiting in place, so its step
      // stops at that safe point too (#1268).
      if (canHandoff(owner.snapshot, owner.activeItems)) {
        owner.handoffStopped = true;
        owner.workPause.abort(new Error("Coordinator handoff requested"));
      }
    } else owner.initialMode = "draining";
  };
  const wait = async (observationDelay?: number) => {
    if (
      owner.handoff &&
      owner.snapshot &&
      canHandoff(owner.snapshot, owner.activeItems)
    )
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
    synchronizeWorkItemPause(owner);
    if (owner.snapshot) {
      saveState(statePath(config.repository, objective), owner.snapshot);
      owner.recordSnapshot?.(owner.snapshot);
    }
  };
  owner.recordSnapshot = (state) => {
    if (queueClaim) bindProjectQueueRun(config, queueClaim, lock.token, state);
    // A fresh claim needs its authentic model-free snapshot before cessation
    // pauses the initial reads. Its saved mode already retains that request.
    if (owner.initialMode) {
      owner.pause.abort(new Error(`Coordinator ${owner.initialMode}`));
      delete owner.initialMode;
      synchronizeWorkItemPause(owner);
    }
  };
  if (owner.snapshot) {
    try {
      persist();
    } catch (error) {
      owners.delete(ownerKey(config, objective));
      if (!options.ownerLock) releaseControllerLock(lockPath, lock);
      throw error;
    }
  }
  const cancel = (): void => {
    if (!owner.snapshot) return;
    if (isExecutionState(owner.snapshot) && owner.snapshot.finalAcceptance) {
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
      if (!state && ["pause", "drain", "handoff"].includes(request.action)) {
        if (request.action === "handoff") releaseOwnership();
        owner.initialMode =
          owner.handoff || request.action !== "pause" ? "draining" : "paused";
        wake();
        return "requested";
      }
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
        if (!isExecutionState(state))
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
        if (isExecutionState(state) && state.finalAcceptance)
          throw new Error(
            "Acceptance is sealed; resume to reconcile Objective closure",
          );
        cancel();
        return "requested";
      }
      if (["pause", "drain", "resume", "handoff"].includes(request.action)) {
        if (request.action === "resume" && queueClaim)
          await assertProjectQueueRunLive(config, services.github, queueClaim);
        if (request.action === "handoff") releaseOwnership();
        else if (request.action === "resume") {
          if (
            owner.pause.signal.aborted &&
            !owner.handoff &&
            !rejectionHoldsPause(state)
          )
            owner.pause = new AbortController();
        } else owner.pause.abort(new Error(`Coordinator ${request.action}`));
        setCoordinatorMode(
          state,
          request.action === "pause"
            ? "paused"
            : ["drain", "handoff"].includes(request.action)
              ? "draining"
              : "running",
        );
        persist();
        wake();
        return modeChangeResult(config, state, request.action, true);
      }
      const apply = async () => {
        if (owner.abort.signal.aborted)
          throw new Error(
            "Cancellation is in progress; inspect ownership before another action",
          );
        const input = request.input ?? {};
        // A plan waiting under this live owner (a paused or draining
        // planning owner): the owner's snapshot is the state, so the decision
        // lands there (#1290).
        if (request.action === "decide" && isPreparationState(owner.snapshot)) {
          const decision = parseDecisionInput(input);
          const current = owner.snapshot;
          if (decision.item || decision.criterion)
            throw new Error(
              "--item names a Work Item's result; a plan decision takes none",
            );
          // A refusal discards the preparation, which a live owner would
          // write back; it needs the owner stopped first.
          if (decision.outcome === "refuse")
            throw new Error(
              "Refusing a plan needs its owner stopped: hand off the owner, then decide",
            );
          if (!decision.answer)
            throw new Error(
              "Accepting a plan requires --answer to its question",
            );
          if (!current.plan)
            throw new Error("Objective planning has not produced a plan yet");
          if (current.plan.review.acceptable === false)
            throw new Error(
              "Factory cannot accept this plan; hand off the owner and refuse it to plan again",
            );
          const issue = await services.github.objective(objective);
          const accepted = await resolvePlan(
            current.plan,
            objective,
            issue.body,
            current.baseSha,
            config.checkout,
            {
              actor: decision.actor,
              outcome: "accept",
              answer: decision.answer,
              reason: decision.reason,
            },
            current.restoration
              ? current.configDigest
              : factoryConfigDigest(config),
          );
          // Pause, handoff or another decision may have run during the awaits.
          if (
            owner.snapshot !== current ||
            owner.handoff ||
            owner.abort.signal.aborted
          )
            throw new Error(
              "The owner's plan changed while deciding; inspect status and decide again",
            );
          current.plan = accepted;
          delete current.coordinator.waitReason;
          persist();
          wake();
          return "plan-accepted";
        }
        // The planner's open question about the pending amendment (#1296):
        // the owner's snapshot holds it, so the answer lands there.
        if (
          request.action === "decide" &&
          isExecutionState(owner.snapshot) &&
          openAmendmentQuestion(owner.snapshot)
        ) {
          const decision = parseDecisionInput(input);
          if (!decision.item && !decision.criterion) {
            decideAmendment(owner.snapshot, decision);
            persist();
            wake();
            return decision.outcome === "accept"
              ? "amendment-accepted"
              : "amendment-refused";
          }
        }
        if (request.action === "retry") {
          const retried = retryWorkItem(
            config,
            objective,
            input.item === undefined ? undefined : String(input.item),
            { fresh: input.fresh === true },
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
        else if (request.action === "decline-discovery")
          declineWorkerDiscovery(
            config,
            objective,
            input as unknown as WorkerDiscoveryDecision,
          );
        else if (request.action === "rereview")
          rereviewWorkItem(
            config,
            objective,
            input as Parameters<typeof rereviewWorkItem>[2],
          );
        else if (request.action === "decide")
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
    if (options.observeControl) await options.observeControl(handle);
    else
      server = await serveControl(config.repository, lock, handle, objective);
  } catch (error) {
    await options.observeControl?.(undefined);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    owners.delete(ownerKey(config, objective));
    if (!options.ownerLock) releaseControllerLock(lockPath, lock);
    throw error;
  }
  const handoff = () => {
    releaseOwnership();
    if (owner.snapshot?.coordinator) {
      setCoordinatorMode(owner.snapshot, "draining");
      persist();
    }
    wake();
  };
  process.on("SIGTERM", handoff);
  process.on("SIGUSR1", cancel);
  let progressTask: Promise<void> | undefined;
  // Presentation never decides the controller's fate (#1276). When one of its
  // checkpoint admissions fails, it stops for the rest of this run, so it adds
  // no GitHub effect on unacknowledged durability; the controller's own
  // admissions before its effects and at stop remain the durability authority.
  let presentationHeld = false;
  const githubPresentation =
    progressOffered(config, services.github) ||
    projectStatusOffered(config, services.github);
  const projectProgress = (): Promise<void> => {
    if (presentationHeld || !githubPresentation) return Promise.resolve();
    if (progressTask) return progressTask;
    const parentSignal = currentProcessSignal();
    const deadlines = [owner.deadlineAt, currentProcessDeadlineAt()].filter(
      (value): value is string => value !== undefined,
    );
    progressTask = withProcessCancellation(
      AbortSignal.any([
        owner.abort.signal,
        ...(parentSignal ? [parentSignal] : []),
      ]),
      () =>
        withGitHubRequestBudget(30_000, async () => {
          await projectGitHubProjectStatus({
            config,
            objective,
            github: services.github,
            current: () => owner.snapshot,
            save: persist,
          });
          await projectGitHubProgress({
            config,
            objective,
            github: services.github,
            current: () => owner.snapshot,
            save: persist,
            active: true,
            secrets: configuredDiagnosticSecrets(config),
          });
        }),
      undefined,
      deadlines.length
        ? deadlines.reduce((first, next) =>
            Date.parse(next) < Date.parse(first) ? next : first,
          )
        : undefined,
    )
      .catch((error: unknown) => {
        // A worker return awaiting collection, a producer inventory that
        // changed while the closure was built, or an archive read that failed
        // in transit is transient: the next tick tries again (#1291, #1384),
        // as the controller's own admission does.
        if (
          (isCheckpointAdmissionFailure(error) &&
            attachedFault(error)?.kind === "transient") ||
          isCheckpointCollectionPending(error) ||
          error instanceof CheckpointProducerInventoryChanged ||
          (error instanceof Error &&
            error.cause instanceof CheckpointProducerInventoryChanged)
        )
          return;
        if (isCheckpointAdmissionFailure(error)) {
          presentationHeld = true;
          process.stderr.write(
            `Factory GitHub progress for Objective #${objective} stopped for this run: a checkpoint admission failed (${error instanceof Error ? error.message : String(error)}). The run continues; inspect Factory status.\n`,
          );
          return;
        }
        // A failed snapshot read/validation cannot authorize overwriting
        // disk from a remembered snapshot. Valid projection failures are
        // recorded inside the helper; unreadable state remains unreadable.
        process.stderr.write(
          `Factory GitHub progress for Objective #${objective} is unavailable; inspect Factory status.\n`,
        );
      })
      .finally(() => {
        progressTask = undefined;
      });
    return progressTask;
  };
  // Coalesce state transitions. The helper ignores time-only changes and
  // publishes from complete validated snapshots under this same owner.
  const progressTimer = githubPresentation
    ? setInterval(() => {
        void projectProgress();
      }, 30_000)
    : undefined;
  let runResult: ContinuationState | undefined;
  let runFailed = false;
  let runFailure: unknown;
  const finalizationErrors: unknown[] = [];
  try {
    runResult = await (async () => {
      for (;;) {
        const state = owner.snapshot;
        if (state?.cancelRequested) {
          cancel();
          await owner.cancellation;
          await closeCancelledIssues(state, services.github, persist);
          if (!state.coordinator?.cancelError) {
            await releaseCancelledSessions(
              config,
              state,
              services.driver,
              services.planningModel,
              persist,
              lock,
            );
            const alreadyCancelled = !!state.cancelledAt;
            state.cancelledAt = new Date().toISOString();
            clearAllRepeats(state);
            if (isExecutionState(state)) {
              for (const work of Object.values(state.work))
                if (work.status === "pending" || work.status === "running")
                  work.status = "cancelled";
              if (owner.save) owner.save(state);
              else persist();
            } else persist();
            if (!alreadyCancelled)
              new DiagnosticEmitter(config.repository, objective).emit({
                runId: state.runId,
                operation: "objective-cancel",
                outcome: "completed",
              });
          }
          throw cancelledFault("Objective cancellation requested");
        }
        if (
          state?.coordinator?.mode !== "running" &&
          state?.coordinator &&
          !(
            isExecutionState(state) &&
            Object.values(state.work).some(
              (work) =>
                work.status === "running" || work.status === "published",
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
          owner.deadlineAt,
        ).catch((error: unknown) => {
          const current = owner.snapshot;
          // A pass stopped by the cancel request (a step answers `cancelled`):
          // the loop records the cancellation.
          if (current?.cancelRequested && !owner.handoff) return undefined;
          // Planning stops at a pause or drain; the owner keeps serving control until resume.
          if (
            isPreparationState(current) &&
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
          isPreparationState(result) ||
          objectiveComplete(result) ||
          result.cancelledAt
        ) {
          if (
            isExecutionState(result) &&
            (objectiveComplete(result) || result.cancelledAt)
          )
            await releaseAgentSessions(
              result,
              services.driver,
              services.planningModel,
              persist,
            );
          return result;
        }
        if (
          result.coordinator?.mode === "running" &&
          (amendmentBlocksDispatch(result) || graphExpansionPending(result)) &&
          result.pendingAmendment?.phase !== "rejected" &&
          !hasReadinessWait(result) &&
          !awaitsOperator(result.wait)
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
    })();
  } catch (error) {
    runFailed = true;
    runFailure = error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.off("SIGUSR1", cancel);
    process.off("SIGTERM", handoff);
    let controlReleased = false;
    try {
      try {
        await options.observeControl?.(undefined);
        if (server)
          await new Promise<void>((resolve) => server.close(() => resolve()));
        controlReleased = true;
      } catch (error) {
        finalizationErrors.push(error);
      }
      // Await original work even after one promise fails; never replay a failed projection.
      for (const task of [controlTail, progressTask]) {
        try {
          await task;
        } catch (error) {
          finalizationErrors.push(error);
        }
      }
      if (!finalizationErrors.length) {
        try {
          await projectProgress();
          observeRetrospective(config, objective);
        } catch (error) {
          finalizationErrors.push(error);
        }
      }
      try {
        if (
          controlReleased &&
          !finalizationErrors.length &&
          queueClaim &&
          runFailed &&
          !owner.snapshot
        ) {
          // Fresh source preparation can refuse before its first canonical
          // snapshot. The creating owner still holds its lease here; the
          // existing reservation seam independently refuses started work or
          // uncertain subprocesses and acknowledges the original failure.
          await settleFailedProjectQueueReservation(
            config,
            queueClaim,
            lock.token,
            runFailure,
          );
        } else if (
          controlReleased &&
          queueClaim &&
          owner.snapshot &&
          (owner.snapshot.cancelledAt
            ? !cancelledContinuationResourceHold(owner.snapshot)
            : canHandoff(
                owner.snapshot,
                owner.handoff ? owner.activeItems : undefined,
              ))
        ) {
          if (owner.snapshot.cancelledAt) {
            await cancelKnownWork(
              owner.snapshot,
              services.driver,
              persist,
              true,
            );
            await releaseCancelledSessions(
              config,
              owner.snapshot,
              services.driver,
              services.planningModel,
              persist,
              lock,
            );
            await settleCancelledProjectQueueRun(config, owner.snapshot, lock);
          } else
            await settleProjectQueueRun(
              config,
              queueClaim,
              lock.token,
              owner.snapshot.runId,
            );
        }
      } catch (error) {
        finalizationErrors.push(error);
      }
    } finally {
      owners.delete(ownerKey(config, objective));
      if (!options.ownerLock) releaseControllerLock(lockPath, lock);
    }
  }
  const errors = [...(runFailed ? [runFailure] : []), ...finalizationErrors];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Controller execution/finalization and Project claim settlement failed",
      { cause: errors[0] },
    );
  if (isExecutionState(runResult!) && objectiveComplete(runResult!))
    await settleParentOfChild(config, services.github, objective, {
      lockParent: !options.ownerLock,
    });
  return runResult!;
}

/**
 * A child Objective's acceptance can complete its split parent. The child's
 * own result stands whatever happens here; a parent left open is closed by
 * its next run or by the next child.
 */
async function settleParentOfChild(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  options: { lockParent: boolean },
): Promise<void> {
  try {
    const parent = splitParentOf(
      config.repository,
      objective,
      (await github.objective(objective)).body,
    );
    if (parent !== undefined)
      await settleSplitParent({
        config,
        github,
        parent,
        lockParent: options.lockParent,
      });
  } catch (error) {
    process.stderr.write(
      `Factory could not update the parent of Objective #${objective}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function cancelObjectiveUnscoped(
  config: FactoryConfig,
  objective: number,
  driver: ExecutionDriver,
  github: GitHubGateway,
  planningModel?: PlanningModel,
): Promise<"requested" | "cancelled"> {
  return withGitHubDiagnostics(config, objective, () =>
    cancelObjectiveOwned(config, objective, driver, github, planningModel),
  );
}

async function cancelObjectiveOwned(
  config: FactoryConfig,
  objective: number,
  driver: ExecutionDriver,
  github: GitHubGateway,
  planningModel?: PlanningModel,
): Promise<"requested" | "cancelled"> {
  const retained = readContinuation(config.repository, objective);
  if (retained) assertRestoredContinuationReady(retained, config);
  const control = await requestControl(config.repository, {
    objective,
    action: "cancel",
  });
  if (control.handled) return "requested";
  const owner =
    liveControllerOwner(installationLockPath(config.repository)) ??
    liveControllerOwner(objectiveLockPath(config.repository, objective));
  if (owner) {
    if (owner.objective !== objective)
      throw new ForegroundControllerError(owner.objective);
    process.kill(owner.pid, "SIGUSR1");
    return "requested";
  }
  const lockHandle = mutationLock(config, objective);
  try {
    const continuation = readContinuation(config.repository, objective);
    if (!continuation) throw new Error("Objective has no Factory state");
    assertRestoredContinuationReady(continuation, config);
    if (isExecutionState(continuation) && objectiveComplete(continuation)) {
      await releaseAgentSessions(continuation, driver, planningModel, () =>
        saveState(statePath(config.repository, objective), continuation),
      );
      return "cancelled";
    }
    if (isExecutionState(continuation) && continuation.finalAcceptance)
      throw new Error(
        "Acceptance is sealed; resume to reconcile Objective closure",
      );
    if (continuation.cancelledAt) {
      if (config.queue?.project)
        await cancelKnownWork(
          continuation,
          driver,
          () =>
            saveState(statePath(config.repository, objective), continuation),
          true,
        );
      await releaseCancelledSessions(
        config,
        continuation,
        driver,
        planningModel,
        () => saveState(statePath(config.repository, objective), continuation),
        lockHandle,
      );
      saveState(statePath(config.repository, objective), continuation);
      await settleCancelledProjectQueueRun(config, continuation, lockHandle);
      return "cancelled";
    }
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
    // Cessation is verified: an earlier unresolved attempt is answered.
    delete continuation.coordinator?.cancelError;
    await closeCancelledIssues(continuation, github, () =>
      saveState(statePath(config.repository, objective), continuation),
    );
    if (continuation.coordinator?.cancelError)
      throw new Error(continuation.coordinator.cancelError);
    if (isExecutionState(continuation))
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
                undefined,
                undefined,
                config.repository,
                continuation.schemaVersion === 17 ||
                  continuation.schemaVersion === 19
                  ? true
                  : undefined,
              ),
            )
            .catch(() => undefined);
        if (
          work.status !== "done" &&
          work.status !== "published" &&
          work.status !== "skipped"
        ) {
          work.status = "cancelled";
          work.completedAt = new Date().toISOString();
        }
      }
    saveState(statePath(config.repository, objective), continuation);
    await releaseCancelledSessions(
      config,
      continuation,
      driver,
      planningModel,
      () => saveState(statePath(config.repository, objective), continuation),
      lockHandle,
    );
    continuation.cancelledAt = new Date().toISOString();
    clearAllRepeats(continuation);
    saveState(statePath(config.repository, objective), continuation);
    // Reconcile retained historical attempts as well as the active attempt.
    if (config.queue?.project)
      await cancelKnownWork(
        continuation,
        driver,
        () => saveState(statePath(config.repository, objective), continuation),
        true,
      );
    await settleCancelledProjectQueueRun(config, continuation, lockHandle);
    const state = continuation;
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      operation: "objective-cancel",
      outcome: "completed",
    });
    return "cancelled";
  } finally {
    observeRetrospective(config, objective);
    releaseMutationLock(config, objective, lockHandle);
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
  const lockHandle = mutationLock(config, objective);
  try {
    const state =
      owners.get(ownerKey(config, objective))?.snapshot ??
      readContinuation(config.repository, objective);
    if (!state) throw new Error("Objective has no Factory state");
    assertRestoredContinuationReady(state, config);
    assertRejectionAllows(
      config,
      state,
      `factory retry --objective ${objective}${itemId === undefined ? "" : ` --item ${itemId}`}`,
    );
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
    if (!awaitsOperator(waitOf(state, scope)) && !stopped) {
      // A provider's limit the operator says is lifted: try again now instead
      // of at the provider's reset time (#1267).
      if (!endProviderLimitWaits(state, scope)) return false;
      saveState(statePath(config.repository, objective), state);
      new DiagnosticEmitter(config.repository, objective).emit({
        runId: state.runId,
        ...(itemId === undefined ? {} : { itemId }),
        operation: "step-retry",
        outcome: "completed",
        detail: "Provider limit wait ended by the operator",
      });
      return true;
    }
    clearRepeats(state, scope);
    if (stopped) {
      delete state.error;
      if ("work" in state) delete state.errorItem;
    }
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      ...(itemId === undefined ? {} : { itemId }),
      operation: "step-retry",
      outcome: "completed",
    });
    return true;
  } finally {
    releaseMutationLock(config, objective, lockHandle);
  }
}

/**
 * The attempt failed with a wrong result: a new attempt corrects it. A failure
 * blamed on a merged predecessor counts: the same head would fail and be
 * blamed again, so the retry that follows the predecessor's fix starts a new
 * attempt on the integrated head.
 */
function wrongResult(work: WorkState): boolean {
  const failure = work.recovery?.failure;
  return (
    (failure?.classification === "implementation" && !!failure.event) ||
    !!failure?.predecessor
  );
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
  options: { fresh?: boolean } = {},
): "step" | "attempt" {
  if (!options.fresh && retryStep(config, objective, itemId)) return "step";
  if (options.fresh && itemId === undefined)
    throw new Error("retry --fresh needs --item");
  if (itemId === undefined)
    throw new Error(
      "No Objective step awaits a decision or configuration fix; name a Work Item with --item",
    );
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
    // A wrong result (a failed required check, a conflict, a failure blamed
    // on a merged predecessor) is not resumed: the same head would fail the
    // same way. It gets a new attempt that republishes the branch with a
    // lease, as a repair does.
    const delivering = (entry: WorkState | undefined): boolean =>
      !!entry &&
      (entry.status === "failed" || entry.status === "cancelled") &&
      !wrongResult(entry) &&
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
      delete state.errorItem;
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
      !wrongResult(work) &&
      (work.step === "deliver" ||
        above?.some((item) => state.work[item.id]?.pullRequest) ||
        (nativeUnit &&
          (state.stackNumbers?.[nativeUnit.id] ||
            state.stackMerges?.[nativeUnit.id])))
    )
      throw new Error(
        `Work Item ${itemId} is part of a delivery that cannot start again; retry the published item of its unit, or factory cancel --objective ${objective}`,
      );
    // The new attempt starts without the old one's records or bound.
    clearRepeats(state, { item: itemId });
    // The new attempt continues from the refused candidate unless the
    // operator asks for a fresh base (#1313).
    const recovery = archiveAttempt(work);
    if (options.fresh) recovery.freshBase = true;
    state.work[itemId] = { status: "pending", recovery };
    state.cancelRequested = false;
    delete state.cancelledAt;
    delete state.error;
    delete state.errorItem;
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId,
      operation: "work-retry",
      outcome: "completed",
    });
    return "attempt";
  } finally {
    releaseMutationLock(config, objective, lockHandle);
  }
}

/** Diagnosed correction requests retain the exact failure and consume configured limits. */
export function repairWorkItem(
  config: FactoryConfig,
  objective: number,
  input: { item: string; correction: RepairCorrection },
): void {
  const handle = mutationLock(config, objective);
  try {
    const state = mutationState(config, objective);
    if (
      !state ||
      state.finalValidation?.passed ||
      !continuationConfigurationMatches(state, config)
    )
      throw new Error("Objective is not available for diagnosed repair");
    assertRejectionAllows(
      config,
      state,
      `factory repair --objective ${objective} --proposal FILE`,
    );
    if (
      input.correction.readiness ||
      input.correction.actor === "factory-controller"
    )
      throw new Error(
        "Operator corrections must declare their own provenance, not controller-checked readiness",
      );
    applyWorkCorrection(state, input.item, input.correction);
    // The repair answers the stop the item's failure caused, as retry does.
    delete state.error;
    delete state.errorItem;
    saveState(statePath(config.repository, objective), state);
  } finally {
    releaseMutationLock(config, objective, handle);
  }
}

/** Freeze a completed current local return without starting or accepting work. */
export async function collectCompletedWorker(
  config: FactoryConfig,
  objective: number,
  input: { runId: string; item: string; attempt: string },
  driver: ExecutionDriver,
): Promise<void> {
  const lockPath = installationLockPath(config.repository);
  const lock = acquireInstallationLock(config.repository, objective);
  try {
    await checkpointController(config, async () => {
      const state = mutationState(config, objective);
      if (
        state?.runId !== input.runId ||
        state.pendingAmendment ||
        state.pendingExpansion ||
        state.coordinator?.processes?.length ||
        state.coordinator?.cancelError
      )
        throw new Error(
          "Completed local collection requires a stopped current source-host Objective",
        );
      const collect = completedLocalCollection(config, state, input, driver);
      const ownershipHold = restoredContinuationOwnershipHold(
        state,
        true,
        input.item,
      );
      if (ownershipHold) throw new Error(ownershipHold);
      await collect();
    });
  } finally {
    releaseControllerLock(lockPath, lock);
  }
}

/**
 * Collect the completed local returns that a stopped controller left behind,
 * before this owner's first checkpoint admission (#1349). With private-history
 * persistence, such a return is a required gap that refuses every publication
 * until its collector freezes it, and only collection clears it: a restarted
 * controller or a cold service would otherwise stop at its first admission and
 * never reach the Work Item's collection. Without that persistence there is no
 * gap and the execute step collects as before. The owner that continues the
 * Objective performs the collection its execute step would, only earlier, on
 * the provider configuration the Objective froze (`runtime`): nothing is
 * started or accepted, and other Work Items keep their own paths. A return that
 * is not exactly the retained attempt's keeps the existing path.
 *
 * Unlike `factory collect`, this does not require a quiet Objective (no
 * pending amendment or expansion, recorded processes, cancellation error or
 * unsettled ownership elsewhere): the resumed controller reconciles those
 * itself, and they do not bear on this attempt's own exact return, which its
 * execute step would collect regardless. Each refuses an admission only after
 * this gap is gone.
 */
export async function collectStoppedWorkerReturns(
  objectives: {
    state: ContinuationState;
    runtime: () => { config: FactoryConfig; driver: ExecutionDriver };
  }[],
): Promise<void> {
  if (!privateCheckpointBounds()) return;
  const pending: {
    repository: string;
    state: FactoryState;
    item: string;
    identity: string;
    collect: () => Promise<void>;
  }[] = [];
  for (const { state, runtime } of objectives) {
    if (!isExecutionState(state)) continue;
    let resolved: ReturnType<typeof runtime> | undefined;
    for (const [item, work] of Object.entries(state.work)) {
      const handle = work.execution;
      const data = handle?.data as
        | { result?: unknown; stopped?: unknown; rejectedCollection?: unknown }
        | undefined;
      if (
        work.step !== "execute" ||
        handle?.provider !== "local" ||
        !work.attempt ||
        data?.result !== undefined ||
        data?.stopped !== undefined ||
        data?.rejectedCollection !== undefined
      )
        continue;
      try {
        // Only a completed original is the gap this pass exists to clear.
        if (
          localWorkerReturn(stateRoot(state.repository), handle, state)
            ?.returned.state !== "complete"
        )
          continue;
      } catch {
        continue;
      }
      // An Objective that cannot be composed on its frozen provider stops
      // here with that reason, not later with the gap's refusal.
      resolved ??= runtime();
      try {
        pending.push({
          repository: resolved.config.repository,
          state,
          item,
          identity: handle.identity,
          collect: completedLocalCollection(
            resolved.config,
            state,
            { item, attempt: work.attempt },
            resolved.driver,
          ),
        });
      } catch {
        // Not exactly the retained attempt's completed return: the existing
        // path keeps it, and its refusal names the gap.
      }
    }
  }
  // Each collector waits for the others before publishing, as concurrent
  // Work Item collections do, so the first publication carries them all.
  const outcomes = await Promise.allSettled(
    pending.map((entry) =>
      trackCollection(entry.repository, entry.identity, entry.collect),
    ),
  );
  const failures = outcomes.flatMap((outcome, index) => {
    if (outcome.status === "fulfilled") return [];
    const { state, item } = pending[index]!;
    const data = state.work[item]?.execution?.data as
      | { result?: unknown; stopped?: unknown; rejectedCollection?: unknown }
      | undefined;
    // A durably ended attempt (a frozen result, cessation or rejection) is
    // the Work Item's own outcome: its execute step consumes it exactly.
    // With private-history bounds the driver records every work-fault
    // rejection before raising it, so a failure without a record left the
    // gap in place: the next admission would refuse it anyway, and this
    // names the actual cause instead.
    return data?.result !== undefined ||
      data?.stopped !== undefined ||
      data?.rejectedCollection !== undefined
      ? []
      : [outcome.reason];
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Completed worker returns could not be collected",
    );
}

/**
 * Authenticate one Work Item's completed current local return and return its
 * collection, or throw why it cannot be collected. The collection is the
 * driver's own, which the resumed execute step would otherwise perform.
 */
function completedLocalCollection(
  config: FactoryConfig,
  state: FactoryState | undefined,
  input: { item: string; attempt: string },
  driver: ExecutionDriver,
): () => Promise<void> {
  if (
    !state ||
    state.restoration ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.finalAcceptance ||
    state.objectiveClosure === "complete" ||
    !continuationConfigurationMatches(state, config) ||
    !(driver instanceof LocalExecutionDriver)
  )
    throw new Error(
      "Completed local collection requires a stopped current source-host Objective",
    );
  const work = state.work[input.item];
  const item = state.graph.items.find((item) => item.id === input.item);
  const handle = work?.execution;
  const active = handle?.data as
    | { request?: import("./contracts.js").ExecutionRequest }
    | undefined;
  if (
    !work ||
    work.attempt !== input.attempt ||
    work.step !== "execute" ||
    !["running", "waiting"].includes(work.status) ||
    !item ||
    handle?.provider !== "local" ||
    handle.identity !== workerIdentity(work) ||
    active?.request?.attemptId !== handle.identity ||
    active.request.baseSha !== (work.executionBaseSha ?? work.baseSha) ||
    // Advisory briefs are enriched by the producer. Their complete bytes
    // are bound below to the authenticated original dispatch request;
    // all graph authority fields remain exact.
    !isDeepStrictEqual(active.request.item, {
      ...item,
      brief: active.request.item.brief,
    })
  )
    throw new Error(
      "Completed local collection differs from its retained item, attempt or request",
    );
  const save = () =>
    saveState(statePath(config.repository, state.objective), state);
  const context = executionContext(
    work,
    save,
    () => false,
    undefined,
    undefined,
    config.repository,
    true,
  );
  if (driver.sessionCapabilities?.resumeRoles.includes("implementation")) {
    const session = agentSessionContinuation(
      state,
      "implementation",
      input.item,
      save,
    );
    context.checkpointSession = (ref) => session.checkpoint(ref);
  }
  // The adapter authenticates its original return and settles its owned
  // process group. Unknown/missing/live returns never reach collection.
  const original = localWorkerReturn(
    stateRoot(config.repository),
    handle,
    state,
  );
  if (original?.returned.state !== "complete")
    throw new Error(
      "Local worker has no authenticated completed original; preserve its existing owner",
    );
  if (active.request.session) {
    // The initial controller checkpoint records the pending worker owner;
    // the original native wrapper admission supplies its concrete selection.
    // A retained concrete selection must still match that original return.
    const returned = original.returned.session as
      | import("./contracts.js").AgentSessionRef
      | undefined;
    const current = Object.values(state.agentSessions ?? {}).find((ref) =>
      isDeepStrictEqual(ref.scope, active.request!.session!.scope),
    );
    if (
      !returned ||
      !current ||
      current.adapter !== returned.adapter ||
      current.turn !== returned.turn ||
      current.identity !== returned.identity ||
      current.executionIdentity !== returned.executionIdentity ||
      ((current.data as { selectionDigest?: unknown } | undefined)
        ?.selectionDigest !== undefined &&
        (current.data as { selectionDigest?: unknown } | undefined)
          ?.selectionDigest !==
          (returned.data as { selectionDigest?: unknown } | undefined)
            ?.selectionDigest)
    )
      throw new Error(
        "Completed worker native return differs from its current admitted session",
      );
  }
  return async () => {
    const observed = await driver.observe(structuredClone(handle));
    if (observed.state !== "complete")
      throw new Error(
        "Local worker has no authenticated completed return; preserve its existing owner",
      );
    await driver.collect(structuredClone(handle), context);
    // The collector freezes originals and ACKs before removing the checkout.
    // No Work Item acceptance or execution transition is synthesized here.
  };
}

/** Decline an unadmitted worker proposal without accepting or changing its result. */
export function declineWorkerDiscovery(
  config: FactoryConfig,
  objective: number,
  input: WorkerDiscoveryDecision,
): void {
  const lock = mutationLock(config, objective);
  try {
    const state = mutationState(config, objective);
    if (!state) throw new Error("Objective has no Factory state");
    applyWorkerDiscoveryDecline(config, state, input);
    saveState(statePath(config.repository, objective), state);
  } finally {
    releaseMutationLock(config, objective, lock);
  }
}

function applyWorkerDiscoveryDecline(
  config: FactoryConfig,
  state: import("./state.js").FactoryState,
  input: WorkerDiscoveryDecision,
): void {
  if (
    !state ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.finalValidation?.passed ||
    state.finalAcceptance ||
    state.objectiveClosure === "complete" ||
    !continuationConfigurationMatches(state, config)
  )
    throw new Error("Objective is not available for worker discovery decline");
  if (
    (owners.has(ownerKey(config, state.objective)) &&
      state.coordinator?.mode !== "paused") ||
    !canHandoff(state) ||
    restoredContinuationOwnershipHold(state, true) ||
    Object.values(state.work).some((work) => work.status === "running")
  )
    throw new Error(
      "Worker discovery decline requires paused or stopped settled owned work",
    );
  if (state.pendingAmendment || state.pendingExpansion)
    throw new Error(
      "Worker discovery decline cannot dispose an admitted graph change",
    );
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Worker discovery decline requires an explicit decision");
  refuseUnknownFields(
    input as unknown as Record<string, unknown>,
    [
      "runId",
      "item",
      "attempt",
      "resultCommitSha",
      "resultTreeSha",
      "graphDigest",
      "discoveryDigest",
      "actor",
      "reason",
    ],
    "worker discovery decision",
  );
  const work = state.work[input.item];
  if (
    !work?.discovery ||
    work.discovery.scope !== "in-scope" ||
    work.discoveryDisposition ||
    !work.changeRef ||
    !work.treeSha ||
    !["waiting", "failed", "done"].includes(work.status) ||
    work.discovery.attempt !== work.attempt ||
    input.runId !== state.runId ||
    input.attempt !== work.attempt ||
    input.resultCommitSha !== work.changeRef ||
    input.resultTreeSha !== work.treeSha ||
    input.graphDigest !== graphDigest(state.graph) ||
    input.discoveryDigest !== workerDiscoveryDigest(work.discovery) ||
    typeof input.actor !== "string" ||
    !input.actor.trim() ||
    typeof input.reason !== "string" ||
    !input.reason.trim()
  )
    throw new Error(
      "Worker discovery decline differs from the current undisposed proposal/result",
    );
  if (
    pinnedGit(config.checkout, "rev-parse", `${work.changeRef}^{tree}`) !==
    work.treeSha
  )
    throw new Error("Worker discovery decline result tree is not authentic");
  work.discoveryDecline = {
    ...structuredClone(input),
    repository: state.repository,
    objective: state.objective,
    configDigest: state.configDigest,
    declinedAt: new Date().toISOString(),
  };
  work.discoveryDisposition = "declined";
  assertWorkerDiscoveryDisposition(state, input.item, work);
}

/**
 * Request bounded validation and automatic review of the exact retained result.
 * A settled command failure or validated review defect may be revalidated; refusal stays closed.
 */
export function rereviewWorkItem(
  config: FactoryConfig,
  objective: number,
  input: {
    item: string;
    actor: string;
    reviewArtifacts?: import("./review-artifacts.js").ReviewArtifactSelector[];
  },
): void {
  const handle = mutationLock(config, objective);
  try {
    const state = mutationState(config, objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (
      state.cancelRequested ||
      state.cancelledAt ||
      state.finalValidation?.passed ||
      state.finalAcceptance ||
      state.objectiveClosure === "complete"
    )
      throw new Error("Objective is not awaiting result re-review");
    if (!continuationConfigurationMatches(state, config))
      throw new Error(
        "Installation configuration changed before result re-review",
      );
    const work = state.work[input.item];
    if (
      !work ||
      !work.baseSha ||
      !work.attempt ||
      !work.changeRef ||
      !work.treeSha ||
      work.pullRequest ||
      work.integratedSha
    )
      throw new Error(
        "Work Item has no unpublished retained result to re-review",
      );
    const pending =
      work.status === "waiting" &&
      work.step === "approve-result" &&
      work.acceptancePending;
    const failed = work.status === "failed" && work.step === "validate";
    const failure = work.recovery?.failure;
    const validatedDefect =
      failed &&
      failure?.classification === "defect" &&
      !failure.semanticRefusal &&
      !work.failedValidation &&
      !work.acceptancePending &&
      !work.acceptanceDecisions?.length &&
      !!work.validation;
    if (
      state.error &&
      (!validatedDefect ||
        state.errorItem !== input.item ||
        state.error !== work.error ||
        state.error !== failure?.detail)
    )
      throw new Error("Objective is not awaiting result re-review");

    if (!pending && !failed)
      throw new Error("Work Item is not awaiting result re-review");
    if (
      state.coordinator?.cancelError ||
      state.coordinator?.processes?.length ||
      Object.values(state.repeats ?? {}).some((record) => record.inFlight) ||
      Object.values(state.work).some((entry) => entry.status === "running")
    )
      throw new Error("Result re-review requires settled owned work");
    if (
      state.pendingAmendment ||
      (work.graphRevisionDigest !== undefined &&
        work.graphRevisionDigest !== graphDigest(state.graph))
    )
      throw new Error(
        "Result re-review graph differs from the retained result",
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
    const treeSha = pending ? pending.treeSha : work.treeSha;
    if (treeSha !== work.treeSha || observedTree !== treeSha)
      throw new Error(
        "Result re-review tree differs from the pending exact result",
      );
    if (!input.actor.trim()) throw new Error("Result re-review requires actor");
    if (input.reviewArtifacts !== undefined) {
      const item = state.graph.items.find((item) => item.id === input.item)!;
      if (item.kind !== "qa" && item.kind !== "aggregate")
        throw new Error("Prospective evidence selection requires read-only QA");
      assertReviewArtifactSelection(
        input.reviewArtifacts,
        item.validation.map((check) => check.command),
      );
      assertReviewArtifactSelectors([
        ...(config.reviewArtifacts ?? []),
        ...input.reviewArtifacts,
      ]);
      assertReviewArtifactSelectionSources(
        config.checkout,
        treeSha,
        input.reviewArtifacts,
      );
    }
    if (validatedDefect) {
      const validation = work.validation!;
      const observation = validation.worktreeObservation;
      const item = state.graph.items.find((entry) => entry.id === input.item)!;
      if (
        work.graphRevisionDigest !== graphDigest(state.graph) ||
        validation.treeSha !== work.treeSha ||
        validation.nativeReturns?.length ||
        validation.criteria?.length ||
        validation.selectedLfs?.length ||
        validation.commands.length !== item.validation.length ||
        validation.commands.some(
          (command, index) =>
            command.index !== index ||
            command.command !== item.validation[index]!.command ||
            command.passed !== true ||
            command.exitCode !== 0 ||
            command.treeSha !== work.treeSha ||
            command.stoppedLeftovers !== undefined,
        ) ||
        observation?.treeSha !== work.treeSha ||
        observation.initialStatus !== "clean" ||
        !observation.postHydrationStatus.empty ||
        observation.postCommandStatus !== "unchanged" ||
        observation.selectedLfsMembers !== 0 ||
        observation.subprocessOwnership !== "settled" ||
        [
          ...Object.values(state.agentSessions ?? {}),
          ...(state.agentSessionHistory ?? []),
        ].some((ref) => ref.currentTurn && !ref.currentTurn.terminal) ||
        restoredContinuationOwnershipHold(state) ||
        (state.coordinator?.deadlineAt &&
          Date.now() >= Date.parse(state.coordinator.deadlineAt))
      )
        throw new Error(
          "Result re-review defect requires complete unchanged passing validation and settled ownership within its original deadline",
        );
      pinnedGit(
        config.checkout,
        "merge-base",
        "--is-ancestor",
        work.baseSha,
        work.changeRef,
      );
    } else if (failed) {
      assertFailedValidationRecord(
        work.failedValidation,
        state,
        input.item,
        work,
        work.recovery?.failure,
      );
      const capture = work.failedValidation;
      if (
        !capture ||
        capture.graphRevisionDigest !== graphDigest(state.graph) ||
        capture.evidence.reason !== "command" ||
        capture.evidence.commands.at(-1)?.exitCode === null ||
        capture.evidence.postCommandStatus !== "unchanged" ||
        capture.evidence.selectedLfsMembers !== 0 ||
        capture.evidence.commands.some(
          (command) =>
            command.worktreeStatusBefore !== "unchanged" ||
            command.worktreeStatusAfter !== "unchanged" ||
            command.stoppedLeftovers !== undefined,
        )
      )
        throw new Error(
          "Result re-review requires a clean, unchanged, settled command failure capture",
        );
    }
    // A new history position makes each admitted request a distinct charge;
    // repeatedly charging the original failure would make later requests free.
    const event = `item/${input.item}/result-rereview/${work.recovery?.history?.length ?? 0}`;
    charge(state, event, "resultRereviews", repairScopes(state, input.item));
    const recovery = archiveAttempt(work);
    delete recovery.failure;
    delete recovery.correction;
    delete recovery.phase;
    work.recovery = recovery;
    if (input.reviewArtifacts !== undefined)
      work.reviewArtifactSelection = structuredClone(input.reviewArtifacts);
    if (validatedDefect && state.error) {
      delete state.error;
      delete state.errorItem;
    }
    work.status = "running";
    work.step = "validate";
    delete work.acceptancePending;
    delete work.failedValidation;
    delete work.validation;
    delete work.error;
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId: input.item,
      attemptId: work.attempt,
      operation: "result-rereview-request",
      outcome: "completed",
      metadata: { treeSha, actor: input.actor, event },
    });
  } finally {
    releaseMutationLock(config, objective, handle);
  }
}

/**
 * Record one explicit result decision against the exact pending tree in state. The tree must
 * still be what the checkout holds for the commit it names.
 */
export function decideResult(
  config: FactoryConfig,
  objective: number,
  input: {
    item?: string;
    criterion?: string;
    actor: string;
    outcome: "accept" | "refuse";
    reason: string;
  },
): void {
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
    if (observedTree !== pending.treeSha)
      throw new Error(
        "Result decision tree differs from the pending exact result",
      );
    // One review may leave several criteria for a human; each is decided on its own.
    const questions = pendingQuestions(pending);
    const asked = input.criterion
      ? questions.find((question) => question.criterion === input.criterion)
      : questions.length === 1
        ? questions[0]
        : undefined;
    if (!asked)
      throw new Error(
        input.criterion
          ? "No pending criterion matches --criterion"
          : `${questions.length} criteria are pending; name one with --criterion (\`factory status --objective ${objective}\` lists them)`,
      );
    if (
      !input.actor.trim() ||
      !input.reason.trim() ||
      !["accept", "refuse"].includes(input.outcome)
    )
      throw new Error("Result decision requires actor and reason");
    const decision = {
      criterion: asked.criterion,
      treeSha: pending.treeSha,
      actor: input.actor,
      at: new Date().toISOString(),
      outcome: input.outcome,
      reason: input.reason,
    };
    // An accepted answer leaves the other questions waiting; the last one resumes validation.
    const [next, ...more] = questions.filter((question) => question !== asked);
    const remaining =
      input.outcome === "accept" && next
        ? { ...next, ...(more.length ? { more } : {}) }
        : undefined;
    if (work) {
      work.acceptanceDecisions ??= [];
      work.acceptanceDecisions.push(decision);
      if (remaining) work.acceptancePending = remaining;
      else {
        delete work.acceptancePending;
        work.status = input.outcome === "accept" ? "running" : "failed";
        work.step = "validate";
      }
      if (input.outcome === "refuse") {
        work.error = `Acceptance refused: ${asked.criterion}`;
        recordWorkFailure(
          state,
          input.item!,
          new SemanticAcceptanceFailure(work.error, {
            treeSha: decision.treeSha,
            criterion: decision.criterion,
            source: "operator",
            decision,
          }),
        );
      }
    } else {
      state.finalAcceptanceDecisions ??= [];
      state.finalAcceptanceDecisions.push(decision);
      if (remaining) state.finalAcceptancePending = remaining;
      else delete state.finalAcceptancePending;
      if (input.outcome === "refuse")
        state.error = `Final acceptance refused: ${asked.criterion}`;
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
    releaseMutationLock(config, objective, lockHandle);
  }
}

type AssetSelectionInput = {
  actor?: string;
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
      actor: decision?.actor ?? operatorName(),
      at: new Date().toISOString(),
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
    releaseMutationLock(config, objective, lockHandle);
  }
}

async function selectAssetSetUnscoped(
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
async function selectAssetSetFromCliUnscoped(
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

/** Write every candidate AssetSet of a waiting Work Item to `output/SET_ID/`, for the operator to look at before selecting. */
async function exportAssetSetsForReviewUnscoped(
  config: FactoryConfig,
  objective: number,
  itemId: string,
  output: string,
  store: ContentStore,
): Promise<string[]> {
  const state = mutationState(config, objective);
  const work = state?.work[itemId];
  if (!work || work.status !== "waiting" || work.step !== "approve-asset")
    throw new Error(`Work Item ${itemId} is not awaiting asset selection`);
  const sets = work.assets ?? [];
  if (
    !isAbsolute(output) ||
    existsSync(output) ||
    resolve(output).startsWith(`${resolve(config.checkout)}${sep}`)
  )
    throw new Error(
      "--output must be a new absolute directory outside the target checkout",
    );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const set of sets) {
    const directory = join(output, set.id);
    mkdirSync(directory, { mode: 0o700 });
    for (const member of set.members)
      await store.materialize(
        member.ref,
        join(directory, `${member.role}-${basename(member.destination)}`),
      );
  }
  new DiagnosticEmitter(config.repository, objective).emit({
    runId: state!.runId,
    itemId,
    attemptId: work.attempt,
    operation: "media-review-export",
    outcome: "completed",
    metadata: { setCount: sets.length },
  });
  return sets.map((set) => set.id);
}

/** Bind direct library controllers to the same repository-specific durability boundary. */
async function checkpointController<T>(
  config: FactoryConfig,
  task: () => Promise<T>,
  store?: ContentStore,
): Promise<T> {
  return withRecoveryCheckpointScope(
    {
      config,
      buildClosure: () => buildRecoveryCheckpointClosure({ config, store }),
    },
    async () => {
      let result: T;
      try {
        result = await task();
      } catch (error) {
        // A refused inventory build needs an explicit complete observation.
        // Do not turn cleanup into an immediate repetition that clears its
        // dirty/error disposition before the caller can inspect it.
        if (
          error instanceof CheckpointProducerInventoryChanged ||
          (isCheckpointAdmissionFailure(error) &&
            error.cause instanceof CheckpointProducerInventoryChanged)
        )
          throw error;
        try {
          await awaitCheckpointAdmission(config.repository, "settled");
        } catch (settlement) {
          // Name the stop itself: the pending checkpoint only follows it.
          throw new AggregateError(
            [error, settlement],
            `Controller stopped with a pending Git checkpoint after: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        throw error;
      }
      await awaitCheckpointAdmission(config.repository, "settled");
      return result;
    },
  );
}

export function decideObjective(
  ...args: Parameters<typeof decideObjectiveUnscoped>
): ReturnType<typeof decideObjectiveUnscoped> {
  return checkpointController(
    args[0],
    () => decideObjectiveUnscoped(...args),
    undefined,
  );
}

/**
 * The live installation owner deciding one of its stopped Objectives (#1290).
 * Like a controller applying a forwarded decision, it saves the state and leaves
 * publication to the owner's own admissions, so a held checkpoint failure stays held.
 */
export function decideStoppedObjective(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github">,
  input: DecisionInput,
): ReturnType<typeof decideObjectiveUnscoped> {
  return decideObjectiveUnscoped(config, objective, services, input, false);
}

export function controlObjective(
  ...args: Parameters<typeof controlObjectiveUnscoped>
): ReturnType<typeof controlObjectiveUnscoped> {
  const [config, request, github] = args;
  if (
    request.action === "handoff" &&
    (request.input?.failedReservationEvidence !== undefined ||
      request.input?.retiredWithdrawalEvidence !== undefined ||
      request.input?.retiredAdmissionEvidence !== undefined)
  )
    return stoppedOperatorHandoff(config, request, github);
  return checkpointController(
    config,
    () => controlObjectiveUnscoped(...args),
    undefined,
  );
}

export function runObjective(
  ...args: Parameters<typeof runObjectiveUnscoped>
): ReturnType<typeof runObjectiveUnscoped> {
  const [config, , services] = args;
  // The controller owns one bounded remote-only verifier for its lifetime (a
  // queue service lends its own), so each independently verified ACK can be
  // the next publication's base instead of being fetched and verified again.
  return withRecoveryCheckpointControllerVerification(
    {
      config,
      buildClosure: () =>
        buildRecoveryCheckpointClosure({
          config,
          store: services.contentStore,
        }),
    },
    () =>
      checkpointController(
        config,
        () => runObjectiveUnscoped(...args),
        services.contentStore,
      ),
  );
}

export function cancelObjective(
  ...args: Parameters<typeof cancelObjectiveUnscoped>
): ReturnType<typeof cancelObjectiveUnscoped> {
  return checkpointController(
    args[0],
    () => cancelObjectiveUnscoped(...args),
    undefined,
  );
}

export function selectAssetSet(
  ...args: Parameters<typeof selectAssetSetUnscoped>
): ReturnType<typeof selectAssetSetUnscoped> {
  return checkpointController(
    args[0],
    () => selectAssetSetUnscoped(...args),
    args[4],
  );
}

export function selectAssetSetFromCli(
  ...args: Parameters<typeof selectAssetSetFromCliUnscoped>
): ReturnType<typeof selectAssetSetFromCliUnscoped> {
  return checkpointController(
    args[0],
    () => selectAssetSetFromCliUnscoped(...args),
    args[4],
  );
}

export function exportAssetSetsForReview(
  ...args: Parameters<typeof exportAssetSetsForReviewUnscoped>
): ReturnType<typeof exportAssetSetsForReviewUnscoped> {
  return checkpointController(
    args[0],
    () => exportAssetSetsForReviewUnscoped(...args),
    args[4],
  );
}
