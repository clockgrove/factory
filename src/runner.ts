import { serviceLoginSecrets } from "./provider-credentials.js";
import { hasReadinessWait, isReadinessWait } from "./delivery/readiness.js";
import { executionContext } from "./execution/checkpoint.js";
import {
  archiveAttempt,
  checkRequiredEnvironment,
  type RepairCorrection,
  resolveAutonomy,
} from "./repair-policy.js";
import { applyWorkCorrection } from "./work-repair.js";
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
  git,
  gitAsync,
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
    if (preparation?.schemaVersion !== 7)
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
  if (state.schemaVersion === 7) return true;
  return (
    !state.coordinator?.phase.endsWith("-submitted") &&
    !Object.entries(state.work).some(
      ([id, work]) =>
        (work.status === "running" && !isReadinessWait(state, id)) ||
        (work.status === "published" &&
          (!work.pullRequest || !work.changeRef || !work.treeSha)),
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
  const snapshot =
    owners.get(ownerKey(config, objective))?.snapshot ??
    readContinuation(config.repository, objective);
  if (snapshot?.schemaVersion === 7)
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
      if (state.schemaVersion !== 6 || !request.input?.replacement)
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
  save: () => void,
): Promise<void> {
  const errors: string[] = [];
  const tasks: (() => Promise<void>)[] = [];
  if (state.schemaVersion === 6)
    for (const work of Object.values(state.work)) {
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
      tasks.push(() =>
        driver.cancel(
          structuredClone(work.execution!),
          executionContext(work, save),
        ),
      );
    }
  if (errors.length) throw new Error(errors.join("; "));
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
    if (owner.snapshot.schemaVersion === 6 && owner.snapshot.finalAcceptance) {
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
        await cancelKnownWork(state, services.driver, persist);
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
        if (state.schemaVersion !== 6)
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
        if (state.schemaVersion === 6 && state.finalAcceptance)
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
          if (state.schemaVersion === 6)
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
          state.schemaVersion === 6 &&
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
        // Planning stops at a pause or drain; the owner keeps serving control until resume.
        if (
          current?.schemaVersion === 7 &&
          current.coordinator.mode !== "running" &&
          !current.cancelRequested &&
          !owner.handoff
        )
          return undefined;
        throw error;
      });
      if (!result) continue;
      owner.snapshot = result;
      // A preparation comes back only when its plan needs a human decision.
      if (
        result.schemaVersion === 7 ||
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
          work.recovery?.phase === "stopped" &&
          ["failed", "waiting"].includes(work.status),
      );
      result.coordinator!.waitReason = result.githubClosureError
        ? "GitHub closure acknowledgement unresolved; resume to reconcile"
        : result.coordinator!.mode === "draining"
          ? "Drained; no owned attempts remain"
          : stoppedRepair
            ? `Work Item ${stoppedRepair[0]}: ${stoppedRepair[1].recovery!.failure?.decision ?? "Inspect the retained recovery failure"}`
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
    checkRequiredEnvironment(config, continuation?.autonomy);
    if (owner.handoff && continuation?.coordinator) {
      continuation.coordinator.mode = "draining";
      saveState(path, continuation);
    }
    let preparation =
      continuation?.schemaVersion === 7 ? continuation : undefined;
    let state = continuation?.schemaVersion === 6 ? continuation : undefined;
    if (issue.state === "closed" && !state?.finalValidation?.passed)
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
        state.schemaVersion !== 6 ||
        state.repository !== config.repository ||
        state.configDigest !== installationConfigDigest
      ) {
        throw new Error(
          "Existing Objective state does not match this Factory installation",
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
            objectiveCandidate(state)?.commitSha
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
      const baseSha = git(config.checkout, "rev-parse", "HEAD");
      const prerequisites = await planningPrerequisites(
        config,
        github,
        objective,
        baseSha,
      );
      const objectivesRoot = join(root, "objectives");
      if (existsSync(objectivesRoot)) {
        for (const name of readdirSync(objectivesRoot)) {
          if (!/^\d+$/.test(name) || Number(name) === objective) continue;
          const other = readContinuation(config.repository, Number(name));
          if (
            other &&
            !(other.schemaVersion === 6 && objectiveComplete(other)) &&
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
          schemaVersion: 7,
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
              // The plan and its review persist in the preparation, so a rerun never pays again.
              return compilePlan(
                objective,
                issue.body,
                baseSha,
                config.checkout,
                planningModel,
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
        preparation.coordinator.phase = "waiting";
        preparation.coordinator.phaseStartedAt = new Date().toISOString();
        preparation.coordinator.waitReason = `Plan needs a decision: ${plan.review.failure?.question ?? plan.review.findings[0]?.question ?? "inspect the plan review"}`;
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
      if (cancellationRequested())
        throw new Error("Objective cancellation requested");
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
        if (cancellationRequested())
          throw new Error("Objective cancellation requested");
      };
      await waitWhileStopped();
      // Projection finds existing issues by marker before creating any, so a
      // restart simply projects again; recorded numbers are passed as known.
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
            beforeCreate: waitWhileStopped,
            projected: (id, number) => {
              preparation!.issueByItemId[id] = number;
              saveState(path, preparation!);
            },
          }),
      );
      state = {
        schemaVersion: 6,
        ...(preparation.planningRecovery
          ? { planningRecovery: preparation.planningRecovery }
          : {}),
        ...(preparation.allowanceConsumption
          ? { allowanceConsumption: preparation.allowanceConsumption }
          : {}),
        ...(preparation.repairConsumption
          ? { repairConsumption: preparation.repairConsumption }
          : {}),
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
      planningSources(issue.body, state.baseSha, config.checkout),
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
        paused: () => state.coordinator?.mode !== "running",
        amendmentPending: () => amendmentBlocksDispatch(state),
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
    const candidateCommitSha = objectiveCandidate(state)!.commitSha;
    const observedHead = git(config.checkout, "rev-parse", "FETCH_HEAD");
    if (observedHead !== candidateCommitSha)
      throw new Error(
        `Default branch changed before final validation: expected ${candidateCommitSha}, observed ${observedHead}`,
      );
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
        ...(state.integratedSha ? { integratedSha: state.integratedSha } : {}),
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
    const acceptanceEvidence = hydrationReceipt
      ? { ...commandEvidence, hydrationReceipt }
      : commandEvidence;
    let finalEvidence;
    try {
      const objectiveEvidence = objectiveReviewEvidence({
        state,
        checkout: config.checkout,
        candidateCommitSha,
        candidateTreeSha: finalTree,
      });
      const reviewFinal = () =>
        reviewAcceptance({
          beforeSubmit: () => {
            if (cancellationRequested())
              throw new Error("Objective cancellation requested");
          },
          model: planningModel,
          reviewPhase: "objective-review",
          checkout: config.checkout,
          baseSha: state.baseSha,
          commit: candidateCommitSha,
          evidence: acceptanceEvidence,
          criteria: objectiveCriteria(issue.body),
          sources: planningSources(issue.body, state.baseSha, config.checkout),
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
      finalEvidence = await diagnostics.span(
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
      objectiveCandidate(state)?.commitSha !== candidateCommitSha
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
    if (reviewedHead !== candidateCommitSha)
      throw new Error(
        `Default branch changed during final review: expected ${candidateCommitSha}, observed ${reviewedHead}`,
      );
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
        ...(state.integratedSha ? { integratedSha: state.integratedSha } : {}),
      },
    });
    save(state);
    await closeObjectiveIssue(state, issue.body, github, () => save(state));
    return state;
  } catch (error) {
    if (error instanceof CoordinatorHandoff) throw error;
    // A handoff that stopped planning releases ownership; the step repeats on restart.
    if (owner.handoff && owner.snapshot && canHandoff(owner.snapshot))
      throw new CoordinatorHandoff();
    diagnostics.emit({
      runId: stateForSignal?.runId,
      operation: "objective-run",
      outcome: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    const current = owner.snapshot;
    if (
      current?.schemaVersion === 6 &&
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
      current?.schemaVersion === 6 &&
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
    if (current?.schemaVersion === 6 && !cancellationRequested()) {
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
          if (current.schemaVersion === 6)
            for (const work of Object.values(current.work))
              if (work.status !== "done" && work.status !== "published")
                work.status = "cancelled";
        }
      } else if (
        error instanceof GitHubClosureFailure &&
        current.schemaVersion === 6
      ) {
        current.githubClosureError = error.message;
      } else if (current.schemaVersion === 7) {
        // Preparation resumes by repeating its step; record why it paused.
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
      (continuation.schemaVersion === 6 && objectiveComplete(continuation)) ||
      continuation.cancelledAt
    )
      return "cancelled";
    if (continuation.schemaVersion === 6 && continuation.finalAcceptance)
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
    if (continuation.schemaVersion === 6)
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
      work.step === "execute" &&
      work.execution !== undefined &&
      work.recovery?.failure?.classification === "uncertain"
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
