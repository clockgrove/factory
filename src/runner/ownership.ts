import { assertRetainedPlannerCheckpointCoverage } from "../compiler/transport.js";
import { isDeepStrictEqual } from "node:util";
import {
  agentSessionContinuation,
  releaseAgentSessions,
  settleAbandonedPlanningTurn,
  settleAbandonedReviewTurns,
  stoppedTurnReceipt,
} from "../agent-session.js";
import { closeCancelledWorkItems } from "../completion.js";
import type { FactoryConfig } from "../config.js";
import type {
  ContentStore,
  DeliveryStrategy,
  ExecutionDriver,
  GitHubGateway,
  PlanningModel,
} from "../contracts.js";
import { isReadinessWait } from "../delivery/readiness.js";
import { executionContext } from "../execution/checkpoint.js";
import { workerIdentity } from "../item-steps.js";
import { linuxProcessIdentity, processGroupExists } from "../process.js";
import { serviceLoginSecrets } from "../provider-credentials.js";
import type { ContinuationState, FactoryState } from "../state.js";
import { isExecutionState, isPreparationState } from "../state.js";
import {
  acquireObjectiveLock,
  assertRestoredContinuationReady,
  type ControllerLock,
  installationLockPath,
  readControllerOwner,
  objectiveLockPath,
  readContinuation,
  readState,
  releaseControllerLock,
} from "../state-store.js";
import { awaitsOperator, type StepContext } from "../step.js";
import * as time from "../clock.js";

export interface ApplicationServices {
  planningModel: PlanningModel;
  driver: ExecutionDriver;
  github: GitHubGateway;
  delivery: DeliveryStrategy;
  contentStore: ContentStore;
  reportRunStatus?: (message: string) => void;
}

export function configuredDiagnosticSecrets(config: FactoryConfig): string[] {
  return [
    ...config.policy.allowedSecretNames
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value)),
    ...serviceLoginSecrets(),
  ];
}

export class CoordinatorHandoff extends Error {
  constructor() {
    super("Coordinator drained and released ownership");
  }
}

/**
 * A running item with no effect in flight (#1268, #1289). An item no step of
 * this controller is running (`idle`) holds none unless a worker it started is
 * still live or a paid call is in flight. An active item holds none only while
 * it waits between tries of its current step: that try is still in the future,
 * or the coordinator is paused, which stops a step before its body. A worker
 * counts as stopped only once the driver records it after settling it. A
 * handoff still waits for every active item to settle.
 */
function betweenTries(
  state: FactoryState,
  id: string,
  work: FactoryState["work"][string],
  idle: boolean,
): boolean {
  const record = work.step
    ? state.repeats?.[`item/${id}/${work.step}`]
    : undefined;
  if (record?.inFlight) return false;
  const data = work.execution?.data as
    | { result?: unknown; stopped?: unknown }
    | undefined;
  const stopped =
    work.execution?.provider === "local" &&
    typeof data?.stopped === "string" &&
    data.result === undefined;
  if (idle)
    return (
      !work.execution ||
      stopped ||
      (work.execution.provider === "local" && data?.result !== undefined)
    );
  if (
    !record?.faults ||
    !record.nextAt ||
    !(
      Date.parse(record.nextAt) > time.now() ||
      state.coordinator?.mode === "paused"
    )
  )
    return false;
  return !work.execution || stopped;
}

/**
 * Whether ownership can be released now. `active` names the Work Items this
 * controller is running a step for; an item outside it is idle (#1289).
 */
export function canHandoff(
  state: ContinuationState,
  active?: ReadonlyMap<string, unknown>,
): boolean {
  if (state.coordinator?.processes?.length || state.coordinator?.cancelError)
    return false;
  if (
    [
      ...Object.values(state.agentSessions ?? {}),
      ...(state.agentSessionHistory ?? []),
    ].some(
      (session) =>
        session.status === "in-flight" ||
        (session.currentTurn && session.currentTurn.resources !== "settled"),
    )
  )
    return false;
  if (isPreparationState(state))
    return state.planningRecovery?.phase !== "submitted";
  if (
    Object.values(state.work).some(
      (work) =>
        work.recovery?.diagnosisInvocation?.submitted &&
        work.recovery.diagnosisInvocation.response === undefined,
    ) ||
    (state.pendingAmendment?.planningInvocation &&
      state.pendingAmendment.planningInvocation.response === undefined) ||
    (state.pendingAmendment?.reviewInvocation &&
      state.pendingAmendment.reviewInvocation.response === undefined)
  )
    return false;
  return !Object.entries(state.work).some(
    ([id, work]) =>
      // An item waiting in place for the operator holds no effect in flight.
      (work.status === "running" &&
        !isReadinessWait(state, id) &&
        !awaitsOperator(work.wait) &&
        !betweenTries(state, id, work, !!active && !active.has(id))) ||
      (work.status === "published" &&
        (!work.pullRequest || !work.changeRef || !work.treeSha)),
  );
}

export interface LocalOwner {
  handoff?: boolean;
  /** Cessation received before the authentic first snapshot is published. */
  initialMode?: "paused" | "draining";
  /** Exact Issue body admitted by the Project claim, before any planning. */
  admittedObjectiveBodyDigest?: string;
  /**
   * Aborts on pause, drain and handoff (SIGTERM, `handoff`): a step waiting
   * between tries stops with `StepPaused`, nothing charged or failed.
   * Replaced by a fresh controller on resume.
   */
  pause: AbortController;
  /** Plain pause stops admitted Work Item retries; draining leaves them live. */
  workPause: AbortController;
  /** A handoff stopped admitted work; `workPause` is never renewed after it. */
  handoffStopped?: boolean;
  /** The Work Items the current pass is running a step for. */
  activeItems?: ReadonlyMap<string, unknown>;
  snapshot?: ContinuationState;
  lock: ControllerLock;
  /**
   * A service-hosted run held behind an overlapping Objective: true when the
   * controller hands off so the service can dispatch another Objective.
   */
  executionHeld?: (conflict: { objective: number; paths: string[] }) => boolean;
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
  /** Bind the literal first canonical snapshot to the admitted Project claim. */
  recordSnapshot?: (state: ContinuationState) => void;
  /** Admit a reviewed split's child Objectives to the Project queue. */
  admitChildObjectives?: import("./split.js").AdmitChildObjectives;
}
/** Update the admitted-work signal from the coordinator's guarded mode. */
export function synchronizeWorkItemPause(
  owner: Pick<
    LocalOwner,
    | "snapshot"
    | "pause"
    | "workPause"
    | "handoff"
    | "handoffStopped"
    | "activeItems"
  >,
): void {
  const mode = owner.snapshot?.coordinator?.mode;
  if (mode === "paused") owner.workPause.abort(new Error("Coordinator paused"));
  // A handoff stops admitted work at its next safe point once nothing it runs
  // holds an effect in flight, and then never renews it (#1268, #1289). Until
  // then a drain keeps driving running items toward that point.
  else if (
    owner.handoff &&
    (owner.handoffStopped ||
      (owner.snapshot && canHandoff(owner.snapshot, owner.activeItems)))
  ) {
    owner.handoffStopped = true;
    owner.workPause.abort(new Error("Coordinator handoff requested"));
  } else if (
    owner.workPause.signal.aborted &&
    (mode === "draining" ||
      (mode === "running" && !owner.handoff && !owner.pause.signal.aborted))
  )
    owner.workPause = new AbortController();
}

export const owners = new Map<string, LocalOwner>();
export const ownerKey = (config: FactoryConfig, objective: number) =>
  `${config.repository}#${objective}`;
export function mutationState(
  config: FactoryConfig,
  objective: number,
): FactoryState | undefined {
  const snapshot =
    owners.get(ownerKey(config, objective))?.snapshot ??
    readContinuation(config.repository, objective);
  if (isPreparationState(snapshot))
    throw new Error("Objective is still preparing");
  const state = snapshot ?? readState(config.repository, objective);
  if (state) assertRestoredContinuationReady(state, config);
  return state;
}
export function mutationLock(
  config: FactoryConfig,
  objective: number,
): ControllerLock {
  return owners.has(ownerKey(config, objective))
    ? { fd: -1, token: "owner" }
    : acquireObjectiveLock(config.repository, objective);
}
export function releaseMutationLock(
  config: FactoryConfig,
  objective: number,
  lock: ControllerLock,
): void {
  if (lock.fd !== -1)
    releaseControllerLock(
      objectiveLockPath(config.repository, objective),
      lock,
    );
}

export async function cancelRecordedSubprocesses(
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

/**
 * Close the Objective's open Work Item issues as not planned once cancellation
 * has settled. A failure is an unresolved cancellation: `factory cancel`
 * repeats it, and the closure is identity-keyed so a repeat posts nothing twice.
 */
export async function closeCancelledIssues(
  state: ContinuationState,
  github: GitHubGateway,
  save: () => void,
): Promise<void> {
  if (state.coordinator?.cancelError) return;
  try {
    await closeCancelledWorkItems(state, github);
  } catch (error) {
    state.coordinator ??= {
      mode: "running",
      phase: "waiting",
      phaseStartedAt: new Date().toISOString(),
    };
    state.coordinator.cancelError =
      error instanceof Error ? error.message : String(error);
    state.coordinator.waitReason =
      "Cancellation unresolved; operator direction required";
    save();
  }
}

export async function cancelKnownWork(
  state: ContinuationState,
  driver: ExecutionDriver,
  save: () => void,
  verifyRetained = false,
): Promise<void> {
  const errors: string[] = [];
  const tasks: (() => Promise<void>)[] = [];
  if (isExecutionState(state))
    for (const [itemId, current] of Object.entries(state.work)) {
      for (const work of verifyRetained
        ? [
            current,
            ...(current.recovery?.history ?? []).map((entry) => entry.work),
          ]
        : [current]) {
        if (
          !verifyRetained &&
          (work.step !== "execute" ||
            work.status === "done" ||
            work.status === "cancelled")
        )
          continue;
        if (!work.execution && !work.attempt) continue;
        tasks.push(async () => {
          const startingIdentity =
            work.execution?.identity ?? workerIdentity(work);
          const startingAttempt = work.attempt;
          const startingProvider = work.execution?.provider;
          await driver.settleStartingAttempt?.(startingIdentity);
          if (
            work.attempt !== startingAttempt ||
            (work === current && state.work[itemId] !== current) ||
            (startingProvider !== undefined &&
              work.execution?.provider !== startingProvider) ||
            (work.execution?.identity ?? workerIdentity(work)) !==
              startingIdentity
          )
            throw new Error(
              "Cancellation start owner was superseded by another attempt",
            );
          const session =
            work === current &&
            driver.sessionCapabilities?.resumeRoles.includes("implementation")
              ? agentSessionContinuation(state, "implementation", itemId, save)
              : undefined;
          const context = executionContext(
            work,
            save,
            () => Boolean(state.cancelRequested),
            undefined,
            undefined,
            state.repository,
            state.schemaVersion === 17 || state.schemaVersion === 19
              ? true
              : undefined,
          );
          if (session)
            context.checkpointSession = (ref) => session.checkpoint(ref);
          const stoppedIdentity =
            work.execution?.identity ?? workerIdentity(work);
          if (work.execution) {
            await driver.cancel(structuredClone(work.execution), context);
            if (verifyRetained) {
              const data = work.execution.data as
                | Record<string, unknown>
                | undefined;
              if (
                !data?.result &&
                !data?.rejectedCollection &&
                data?.stopped === undefined
              )
                // Collection may report cancellation as a failure while retaining
                // the driver's authenticated cessation receipt. The terminal
                // ownership check below still refuses an absent receipt.
                await driver
                  .collect(structuredClone(work.execution), context)
                  .catch(() => undefined);
            }
          } else {
            // An attempt saved before its start was recorded: stop whatever
            // it started under its recorded identity before settling its session.
            await driver.cancelUnrecorded(workerIdentity(work), context);
          }
          // Cessation is authenticated by the driver's cancellation contract.
          // Never promote an interrupted turn into a ready conversation.
          if (
            session?.retained?.status === "in-flight" &&
            session.retained.executionIdentity === stoppedIdentity
          )
            session.checkpoint({ ...session.retained, status: "unavailable" });
        });
      }
    }
  tasks.push(() => cancelRecordedSubprocesses(state));
  for (const result of await Promise.allSettled(tasks.map((task) => task())))
    if (result.status === "rejected") errors.push(String(result.reason));
  if (errors.length) throw new Error(errors.join("; "));
}
export type ObjectiveStep = <T>(
  state: ContinuationState | undefined,
  name: string,
  fn: (context: StepContext) => Promise<T>,
  paid?: boolean,
  pausable?: boolean,
) => Promise<T>;

/** Disposal authenticates the current atomic scope under its actual exclusive owner. */
export async function releaseCancelledSessions(
  config: FactoryConfig,
  state: ContinuationState,
  driver: ExecutionDriver,
  model: PlanningModel | undefined,
  save: () => void,
  lock: ControllerLock,
): Promise<void> {
  const assertCurrent = () => {
    const current = readContinuation(config.repository, state.objective);
    const host = linuxProcessIdentity(process.pid);
    const owner = [
      objectiveLockPath(config.repository, state.objective),
      installationLockPath(config.repository),
    ]
      .map((path) => readControllerOwner(path))
      .find((value) => value?.token === lock.token);
    if (
      !state.cancelRequested ||
      !host ||
      !owner ||
      owner.pid !== process.pid ||
      owner.startTime !== host.startTime ||
      owner.objective !== state.objective ||
      // Cancellation needs no provider call, so an Objective bound to an
      // earlier configuration of this installation still cancels (#1308).
      state.repository !== config.repository ||
      !isDeepStrictEqual(current, state)
    )
      throw new Error(
        "Cancellation disposal lost its current atomic scope or exclusive owner",
      );
  };
  assertCurrent();
  // Without recognized coverage, a planning turn its adapter settled without
  // a native outcome is abandoned, then disposed like any other. Covered
  // adapters keep cancelling without a provider call (#1308); a failed
  // reconciliation mutates nothing and falls through to the coverage check.
  let covered = true;
  try {
    assertRetainedPlannerCheckpointCoverage(
      model?.retainedPlannerCheckpointCoverage,
    );
  } catch {
    covered = false;
  }
  if (!covered) {
    try {
      await settleAbandonedPlanningTurn(state, model, save);
    } catch {
      // The turn stays held; the coverage check below refuses it.
    }
    assertCurrent();
  }
  // A stopped compile, amendment, Work Item diagnosis or review turn whose
  // adapter settled its local process, or proves it ceased, has no outcome
  // left to wait for once the Objective cancels: it becomes unavailable (or
  // settled with an outcome its adapter recovered), then is disposed like any
  // other session. A covered pending compile keeps its submitted invocation
  // for the disposal receipt below. A turn that stays held is refused below.
  const planningTurn = Object.values(state.agentSessions ?? {}).find(
    (ref) => ref.scope.role === "planning" && ref.status === "in-flight",
  );
  const stopped =
    planningTurn &&
    (await stoppedTurnReceipt(planningTurn, model, true).catch(
      () => undefined,
    ));
  if (stopped) {
    agentSessionContinuation(state, "planning", undefined, save).checkpoint(
      stopped,
    );
    assertCurrent();
  }
  await settleAbandonedReviewTurns(state, model, save);
  assertCurrent();
  const planning = state.planningRecovery;
  const unresolvedPlanning =
    planning?.phase === "submitted" &&
    planning.response === undefined &&
    !planning.invocations?.some(
      (entry) => entry.id === planning.invocation?.id && entry.resultDigest,
    );
  let planningScope:
    | ReturnType<typeof agentSessionContinuation>["scope"]
    | undefined;
  if (unresolvedPlanning) {
    if (state.restoration)
      throw new Error(
        "Unresolved restored planning has no authenticated original checkpoint coverage",
      );
    assertRetainedPlannerCheckpointCoverage(
      model?.retainedPlannerCheckpointCoverage,
    );
    if (
      !model?.sessionCapabilities?.resumeRoles.includes("planning") ||
      !["compile", "diagnosis"].includes(planning.invocation?.phase ?? "")
    )
      throw new Error(
        "Pending planning resource scope has no supported retained-planner coverage",
      );
    planningScope = agentSessionContinuation(
      state,
      "planning",
      undefined,
      save,
    ).scope;
    if (
      [
        ...Object.values(state.agentSessions ?? {}),
        ...(state.agentSessionHistory ?? []),
      ].some(
        (ref) =>
          ref.scope.role === "planning" &&
          ref.adapter !== model.retainedPlannerCheckpointCoverage!.adapter,
      )
    )
      throw new Error(
        "Planning resource coverage differs from the actual selected adapter",
      );
  }
  await releaseAgentSessions(state, driver, model, save, assertCurrent);
  if (unresolvedPlanning) {
    assertCurrent();
    if (
      [
        ...Object.values(state.agentSessions ?? {}),
        ...(state.agentSessionHistory ?? []),
      ].some(
        (ref) =>
          ref.status !== "released" ||
          (ref.currentTurn && ref.currentTurn.resources !== "settled"),
      )
    )
      throw new Error(
        "Pending planning requires positive disposal of every covered native scope",
      );
    planning.cancelledResources = {
      coverage: { ...model!.retainedPlannerCheckpointCoverage! },
      invocationId: planning.invocation!.id,
      phase: planning.invocation!.phase as "compile" | "diagnosis",
      scope: planningScope!,
    };
    save();
    assertCurrent();
  }
}
