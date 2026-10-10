import { agentSessionContinuation } from "../agent-session.js";
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
import {
  acquireObjectiveLock,
  type ControllerLock,
  objectiveLockPath,
  readContinuation,
  readState,
  releaseControllerLock,
} from "../state-store.js";
import { awaitsOperator, type StepContext } from "../step.js";

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

export function canHandoff(state: ContinuationState): boolean {
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
  if (state.schemaVersion === 8)
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
        !awaitsOperator(work.wait)) ||
      (work.status === "published" &&
        (!work.pullRequest || !work.changeRef || !work.treeSha)),
  );
}

export interface LocalOwner {
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
  if (snapshot?.schemaVersion === 8)
    throw new Error("Objective is still preparing");
  const state = snapshot ?? readState(config.repository, objective);
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
): Promise<void> {
  const errors: string[] = [];
  const tasks: (() => Promise<void>)[] = [];
  if (state.schemaVersion === 7)
    for (const [itemId, work] of Object.entries(state.work)) {
      if (
        work.step !== "execute" ||
        work.status === "done" ||
        work.status === "cancelled"
      )
        continue;
      if (!work.execution && !work.attempt) continue;
      tasks.push(async () => {
        const session = driver.sessionCapabilities?.resumeRoles.includes(
          "implementation",
        )
          ? agentSessionContinuation(state, "implementation", itemId, save)
          : undefined;
        const context = executionContext(work, save, () =>
          Boolean(state.cancelRequested),
        );
        if (session)
          context.checkpointSession = (ref) => session.checkpoint(ref);
        const stoppedIdentity =
          work.execution?.identity ?? workerIdentity(work);
        if (work.execution)
          await driver.cancel(structuredClone(work.execution), context);
        else {
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
