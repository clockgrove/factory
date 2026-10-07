import { bindPlanningPlaybook } from "./compiler.js";
import { hasReadinessWait } from "./delivery/readiness.js";
import { executionContext } from "./execution/checkpoint.js";
import {
  archiveAttempt,
  charge,
  repairScopes,
  type RepairCorrection,
} from "./repair-policy.js";
import { assertFailedValidationRecord } from "./failed-validation.js";
import {
  applyWorkCorrection,
  recordSavedResultRefusal,
  recordWorkFailure,
} from "./work-repair.js";
import { operatorName } from "./operator.js";
import { approvedPlaybook, observeRetrospective } from "./learning.js";
import {
  amendmentBlocksDispatch,
  graphDigest,
  submitAmendment,
  type AmendmentProposal,
} from "./graph-amendments.js";
import { existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { objectiveComplete } from "./completion.js";
import { withGitHubTransportObserver } from "./github-client.js";
import type { FactoryConfig } from "./config.js";
import { factoryConfigDigest, stateRoot } from "./config.js";
import type {
  ContentStore,
  ExecutionDriver,
  GitHubGateway,
} from "./contracts.js";
import { cancelledFault, workFault } from "./fault.js";
import {
  type ControlRequest,
  ForegroundControllerError,
  requestControl,
  serveControl,
} from "./coordinator-control.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import {
  continuationStatusDocument,
  DiagnosticEmitter,
} from "./diagnostics.js";
import {
  awaitsOperator,
  clearAllRepeats,
  clearRepeats,
  waitOf,
} from "./step.js";
import { assetSelectionDigest } from "./media.js";
import {
  linuxProcessIdentity,
  pinnedGit,
  withProcessCancellation,
} from "./process.js";
import { objectiveCandidate } from "./qa.js";
import type { ContinuationState, WorkState } from "./state.js";
import {
  pendingQuestions,
  rejectionHoldsPause,
  setCoordinatorMode,
} from "./state.js";
import {
  acquireObjectiveLock,
  type ControllerLock,
  installationLockPath,
  liveControllerOwner,
  objectiveLockPath,
  readContinuation,
  readControllerOwner,
  releaseControllerLock,
  saveState,
  statePath,
} from "./state-store.js";
import {
  type ApplicationServices,
  type LocalOwner,
  CoordinatorHandoff,
  canHandoff,
  owners,
  ownerKey,
  mutationState,
  mutationLock,
  releaseMutationLock,
  closeCancelledIssues,
  cancelKnownWork,
  configuredDiagnosticSecrets,
} from "./runner/ownership.js";
import { decidePlan } from "./runner/planning.js";
import { runObjectivePass } from "./runner/execution.js";
export type { ApplicationServices } from "./runner/ownership.js";
export { CoordinatorHandoff } from "./runner/ownership.js";
export { planObjective, decidePlan } from "./runner/planning.js";

/** Local observations share the controller's async scope, never its mutation authority. */
function withGitHubDiagnostics<T>(
  config: FactoryConfig,
  objective: number,
  run: () => T,
): T {
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    factoryConfigDigest(config),
  );
  let retainedRunId: string | undefined;
  try {
    retainedRunId = readContinuation(config.repository, objective)?.runId;
  } catch {
    // Missing or unreadable context is unknown; normal lifecycle reads still decide.
  }
  return withGitHubTransportObserver(
    (transport) =>
      diagnostics.emit({
        runId:
          owners.get(ownerKey(config, objective))?.snapshot?.runId ??
          retainedRunId,
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

/**
 * `factory decide`: the Objective's state says what is decided. A saved plan is decided
 * as the plan (its digest read from state); anything else is a result criterion, for the
 * Work Item or the final acceptance, against the exact pending tree in state.
 */
export async function decideObjective(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github">,
  input: DecisionInput,
): Promise<"plan-accepted" | "plan-refused" | "result" | "result-open"> {
  const state = readContinuation(config.repository, objective);
  if (!state)
    throw new Error(
      `Objective #${objective} has no Factory state; run \`factory run --objective ${objective}\` first`,
    );
  if (state.schemaVersion === 8) {
    if (input.item || input.criterion)
      throw new Error(
        "--item names a Work Item's result; a plan decision takes none",
      );
    if (input.outcome === "accept" && !input.answer)
      throw new Error("Accepting a plan requires --answer to its question");
    await decidePlan(config, objective, services, {
      actor: input.actor,
      outcome: input.outcome,
      answer: input.answer ?? "",
      reason: input.reason,
    });
    return input.outcome === "accept" ? "plan-accepted" : "plan-refused";
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
  const reply = await requestControl(config.repository, {
    objective,
    action: "decide",
    input: result,
  });
  if (!reply.handled) decideResult(config, objective, result);
  // Criteria of the same review that still wait keep the Objective stopped.
  const after = readContinuation(config.repository, objective);
  const open =
    after?.schemaVersion === 7 &&
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
  const lockPath = objectiveLockPath(config.repository, request.objective);
  const lock = acquireObjectiveLock(config.repository, request.objective);
  try {
    const state = readContinuation(config.repository, request.objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (request.action === "status") return state.coordinator;
    if (request.action === "propose-amendment") {
      // Every stop names this command, so it works while the Objective is
      // stopped: it records the pending amendment under the lock (the same
      // checks, review and charges as an owner's) and the next run compiles,
      // reviews and projects it.
      if (state.schemaVersion !== 7)
        throw new Error("Planning has no active graph to amend");
      if (request.input?.scope !== "in-scope")
        throw new Error(
          "Only an in-scope amendment can be proposed while the Objective is stopped; a backlog discovery needs a running owner",
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
  return withGitHubDiagnostics(config, objective, () =>
    runObjectiveOwned(config, objective, services, options),
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
  try {
    snapshot = readContinuation(config.repository, objective);
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
  if (snapshot?.coordinator?.mode !== "running" && snapshot?.coordinator)
    owner.pause.abort(new Error(`Coordinator ${snapshot.coordinator.mode}`));
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
    if (options.observeControl) options.observeControl(handle);
    else
      server = await serveControl(config.repository, lock, handle, objective);
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
      setCoordinatorMode(owner.snapshot, "draining");
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
        await closeCancelledIssues(state, services.github, persist);
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
        throw cancelledFault("Objective cancellation requested");
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
    observeRetrospective(config, objective);
    owners.delete(ownerKey(config, objective));
    if (!options.ownerLock) releaseControllerLock(lockPath, lock);
  }
}

export async function cancelObjective(
  config: FactoryConfig,
  objective: number,
  driver: ExecutionDriver,
  github: GitHubGateway,
): Promise<"requested" | "cancelled"> {
  return withGitHubDiagnostics(config, objective, () =>
    cancelObjectiveOwned(config, objective, driver, github),
  );
}

async function cancelObjectiveOwned(
  config: FactoryConfig,
  objective: number,
  driver: ExecutionDriver,
  github: GitHubGateway,
): Promise<"requested" | "cancelled"> {
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
    // Cessation is verified: an earlier unresolved attempt is answered.
    delete continuation.coordinator?.cancelError;
    await closeCancelledIssues(continuation, github, () =>
      saveState(statePath(config.repository, objective), continuation),
    );
    if (continuation.coordinator?.cancelError)
      throw new Error(continuation.coordinator.cancelError);
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
): "step" | "attempt" {
  if (retryStep(config, objective, itemId)) return "step";
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
    state.work[itemId] = { status: "pending", recovery: archiveAttempt(work) };
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
      state.configDigest !== factoryConfigDigest(config)
    )
      throw new Error("Objective is not available for diagnosed repair");
    if (
      input.correction.readiness ||
      input.correction.actor === "factory-controller"
    )
      throw new Error(
        "Operator corrections must declare their own provenance, not controller-checked readiness",
      );
    if (recordSavedResultRefusal(state, input.item, config.checkout)) {
      // This is a new authenticated observation of a retained refusal, not
      // a historical command failure. Persist it even if the correction is refused.
      saveState(statePath(config.repository, objective), state);
    }
    applyWorkCorrection(state, input.item, input.correction);
    // The repair answers the stop the item's failure caused, as retry does.
    delete state.error;
    delete state.errorItem;
    saveState(statePath(config.repository, objective), state);
  } finally {
    releaseMutationLock(config, objective, handle);
  }
}

/**
 * Request bounded validation and automatic review of the exact retained result.
 * A settled command failure may be revalidated; a refused result cannot be reopened.
 */
export function rereviewWorkItem(
  config: FactoryConfig,
  objective: number,
  input: { item: string; actor: string },
): void {
  const handle = mutationLock(config, objective);
  try {
    const state = mutationState(config, objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (
      state.error ||
      state.cancelRequested ||
      state.cancelledAt ||
      state.finalValidation?.passed ||
      state.finalAcceptance ||
      state.objectiveClosure === "complete"
    )
      throw new Error("Objective is not awaiting result re-review");
    if (state.configDigest !== factoryConfigDigest(config))
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
    if (failed) {
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
        recordWorkFailure(state, input.item!, workFault(work.error));
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

/** Write every candidate AssetSet of a waiting Work Item to `output/SET_ID/`, for the operator to look at before selecting. */
export async function exportAssetSetsForReview(
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
