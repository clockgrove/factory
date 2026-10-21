import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as time from "./clock.js";
import { objectiveComplete } from "./completion.js";
import {
  type FactoryConfig,
  factoryAuthorityDigest,
  maxActiveObjectives,
  queueConfigDigest,
  queueControlBinding,
  stateRoot,
} from "./config.js";
import type {
  GitHubGateway,
  ProjectQueueExpectedTarget,
  ProjectQueueInspection,
  ProjectQueuePlannedEffect,
  ProjectQueuePlannedAction,
  ProjectQueueWriteReceipt,
} from "./contracts.js";
import {
  type ControlRequest,
  type ControlContext,
  ControllerCommandIncompleteError,
  ForegroundControllerError,
  type ReturnedQueueCommand,
  requestControl,
  requestForegroundQueueControl,
  serveControl,
} from "./coordinator-control.js";
import {
  executionConflictDetail,
  plannedExecutionConflict,
} from "./concurrent-objectives.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import { attachedFault } from "./fault.js";
import { RealGitHubGateway } from "./github.js";
import { gitHubTransportOf } from "./github-client.js";
import {
  createProjectQueuePlannedEffect,
  projectQueueReceiptTarget,
} from "./github-project-queue.js";
import { planningPrerequisites } from "./objective-prerequisites.js";
import { expandSplitPredecessors, splitSettled } from "./objective-split.js";
import { settleSplitParent, splitReadyToClose } from "./runner/split.js";
import {
  currentProcessSignal,
  currentProcessDeadlineAt,
  assertProcessActive,
  fetchHead,
  git,
  gitAsync,
  withProcessCancellation,
} from "./process.js";
import {
  admitQueueCommand,
  completeQueueCommand,
  createQueueCommand,
  createQueueOperation,
  observeProjectQueue,
  queueObservationTargets,
  retainedQueueEntry,
  nextProjectQueueOrder,
  verifyQueueInspection,
  type VerifiedQueueInspection,
  parseQueueMetadata,
  performQueueCommandEffect,
  type QueueMetadata,
  type QueueMode,
  type QueueOperation,
  type QueueRecord,
  queueDigest,
  readQueueHistory,
  requireProjectQueueEffects,
  retainedQueueCommandOutcome,
  cancelledRunQuiescent,
  locallyClaimedObjectives,
  verifyQueueObservation,
  type VerifiedQueueObservation,
  withQueueMutationLock,
} from "./project-queue-state.js";
import {
  onlyCheckpointBoundsExceeded,
  awaitCheckpointAdmission,
  acceptForwardedCheckpointCompletion,
  bindRecoveryCheckpointControllerScope,
  checkpointRetentionGaps,
  CheckpointProducerInventoryChanged,
  gitPersistenceStatus,
  isCheckpointAdmissionFailure,
  readVerifiedRecoveryCheckpoint,
  withRecoveryCheckpointCommandOperation,
  withRecoveryCheckpointOperation,
  withRecoveryCheckpointControllerVerification,
  withRecoveryCheckpointScope,
  withQueueControlVerification,
} from "./recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "./recovery-checkpoint-closure.js";
import { checkRequiredEnvironment } from "./repair-policy.js";
import {
  type ApplicationServices,
  CoordinatorHandoff,
  collectStoppedWorkerReturns,
  decideStoppedObjective,
  parseDecisionInput,
  runObjective,
} from "./runner.js";
import { type ContinuationState, isExecutionState } from "./state.js";
import {
  checkPreparedIntakeServiceState,
  checkServiceState,
  queuedObjectiveConfig,
} from "./supervision.js";
import {
  acquireInstallationLock,
  asInstallationOwner,
  assertRestoredInstallationDispatchReady,
  installationContinuations,
  liveObjectiveOwners,
  readContinuation,
  releaseControllerLock,
  readScannedContinuation,
  retargetControllerLock,
  withObjectiveDelegation,
} from "./state-store.js";

/** A fresh in-memory Project view; never persisted or restored as a queue. */
export interface IntakeAuthorization {
  queueProtocol: "project-queue-v1";
  version: 1;
  authority: "github-project";
  complete: boolean;
  repository: string;
  configDigest: string;
  objectives: number[];
  watch?: true;
  bodyDigests: Record<string, string>;
  dequeued: number[];
  mode: QueueMode;
  remoteObservation?: {
    availability: "last-observed" | "unavailable";
    observedAt: string | null;
  };
  observation?: {
    at: string;
    reasons: Record<string, string>;
    error?: string;
    needsDecision?: number;
    idleReason?: "awaiting-approved-work" | "waiting-for-eligible-work";
    unapproved?: number[];
  };
}
const DEFAULT_QUEUE_POLL_SECONDS = 30;
export const QUEUE_COMMAND_TIMEOUT_MS = 180_000;
/** The archive holds this installation's publication; only the operator can resolve it. */
export class ColdPublicationHeld extends Error {}
const commandScopes = new AsyncLocalStorage<{
  deadlineAt: number;
  onAcknowledgment?: (value: unknown) => void;
  /** Creating commands this caller declared, for deadline attribution. */
  commands: { config: FactoryConfig; id: string }[];
}>();
/** A deadline after a command's retained completion is a pending-durability failure, not an unknown effect. */
function returnedCommand(
  commands: { config: FactoryConfig; id: string }[],
): ReturnedQueueCommand | undefined {
  try {
    const outcomes = commands.map(({ config, id }) =>
      retainedQueueCommandOutcome(config, id),
    );
    if (outcomes.length !== 1 || !outcomes[0]) return undefined;
    const status = gitPersistenceStatus(commands[0]!.config);
    const acknowledged = status.lastAcknowledged;
    return {
      ...outcomes[0],
      acknowledged: status.status === "acknowledged" && !status.pendingChanges,
      durability: {
        status: status.status,
        pendingChanges: status.pendingChanges,
        ...(status.unsyncedSince
          ? { unsyncedSince: status.unsyncedSince }
          : {}),
        ...(status.attemptedTransportOutcome
          ? { attemptedTransportOutcome: status.attemptedTransportOutcome }
          : {}),
        ...(acknowledged
          ? {
              lastAcknowledged: {
                commitSha: acknowledged.commitSha,
                sequence: acknowledged.sequence,
              },
            }
          : {}),
        ...(status.error ? { error: status.error } : {}),
      },
    };
  } catch {
    // Unreadable receipts leave the caller's unknown outcome unchanged.
    return undefined;
  }
}
/** The deadline is armed at CLI entry and remains unchanged through IPC and admission. */
export async function withIntakeCommandDeadline<T>(
  deadlineAt: number,
  task: () => Promise<T>,
  onAcknowledgment?: (value: unknown) => void,
): Promise<T> {
  const parent = commandScopes.getStore();
  if (parent) return task();
  const cancellation = new AbortController();
  const inherited = currentProcessSignal();
  const signal = inherited
    ? AbortSignal.any([inherited, cancellation.signal])
    : cancellation.signal;
  const scope = {
    deadlineAt,
    onAcknowledgment,
    commands: [] as { config: FactoryConfig; id: string }[],
  };
  const timer = setTimeout(
    () =>
      cancellation.abort(
        new ControllerCommandIncompleteError(undefined, "unknown", deadlineAt),
      ),
    Math.max(0, deadlineAt - Date.now()),
  );
  try {
    signal.throwIfAborted();
    if (Date.now() >= deadlineAt)
      throw new ControllerCommandIncompleteError(
        undefined,
        "not-sent",
        deadlineAt,
      );
    return await commandScopes.run(scope, () =>
      withProcessCancellation(
        signal,
        task,
        undefined,
        new Date(deadlineAt).toISOString(),
      ),
    );
  } catch (error) {
    const incomplete =
      error instanceof ControllerCommandIncompleteError
        ? error
        : Date.now() >= deadlineAt
          ? new ControllerCommandIncompleteError(
              undefined,
              "unknown",
              deadlineAt,
              error,
            )
          : undefined;
    if (!incomplete) throw error;
    const returned =
      !incomplete.requestId && scope.commands.length
        ? returnedCommand(scope.commands)
        : undefined;
    if (returned) {
      incomplete.returned = returned;
      incomplete.message = `Queue command ${returned.commandId} returned its Project effect (operations ${returned.operations.map((operation) => operation.id).join(", ")}) ${returned.acknowledged ? "and its archive acknowledgment is already recorded, but the deadline passed first. Do not repeat it" : "but its archive durability is not acknowledged before the deadline. Do not repeat it; run factory persistence status and factory persistence sync"}`;
    }
    throw incomplete;
  } finally {
    clearTimeout(timer);
  }
}
function projectMutation<T>(
  config: FactoryConfig,
  github: GitHubGateway,
  task: () => Promise<T>,
): Promise<T> {
  assertProcessActive();
  return withQueueMutationLock(config.repository, () =>
    github.withProjectQueueObservation
      ? github.withProjectQueueObservation(
          requireProjectQueueEffects(config),
          task,
        )
      : task(),
  );
}
export const queuePollSeconds = (config: FactoryConfig): number =>
  config.queue?.pollSeconds ?? DEFAULT_QUEUE_POLL_SECONDS;
const defaultGateway = (config: FactoryConfig): GitHubGateway =>
  new RealGitHubGateway(
    config.repository,
    new NativeStackDelivery(config.repository),
  );
function view(
  config: FactoryConfig,
  observed?: VerifiedQueueObservation,
  error?: unknown,
): IntakeAuthorization {
  const entries = observed?.entries ?? [];
  return {
    version: 1,
    queueProtocol: "project-queue-v1",
    authority: "github-project",
    complete: !!observed,
    repository: config.repository,
    configDigest: queueConfigDigest(config),
    objectives: entries.map((entry) => entry.objective),
    bodyDigests: Object.fromEntries(
      entries.map((entry) => [entry.objective, entry.bodyDigest]),
    ),
    dequeued: entries
      .filter((entry) => entry.state === "withdrawn")
      .map((entry) => entry.objective),
    mode: observed?.control.mode ?? "paused",
    remoteObservation: {
      availability: observed ? "last-observed" : "unavailable",
      observedAt: observed?.snapshot.observedAt ?? null,
    },
    ...(observed?.control.watch ? { watch: true } : {}),
    observation: {
      at: observed?.snapshot.observedAt ?? new Date().toISOString(),
      reasons: {},
      ...(error ? { error: String(error) } : {}),
      ...(observed
        ? {
            unapproved: observed.snapshot.cards
              .filter((card) => card.metadata === null)
              .map((card) => card.objective),
          }
        : {}),
    },
  };
}
/** Missing receipts hold execution. */
export async function readIntake(
  config: FactoryConfig,
  options: { github?: GitHubGateway } = {},
): Promise<IntakeAuthorization | undefined> {
  if (!config.queue?.project) return;
  try {
    return view(
      config,
      await observeProjectQueue(
        config,
        options.github ?? defaultGateway(config),
      ),
    );
  } catch (error) {
    return view(config, undefined, error);
  }
}
function terminal(state: ContinuationState | undefined): boolean {
  return (
    !!state &&
    (!!state.cancelledAt ||
      (isExecutionState(state) && objectiveComplete(state)) ||
      // A split parent's run is over; its children carry the work.
      splitSettled(state))
  );
}
export async function intakeSettled(config: FactoryConfig): Promise<boolean> {
  if (
    config.queue?.project &&
    (await readQueueHistory(config)).some(
      (record) => record.kind === "project-queue-owner" && !record.settled,
    )
  )
    return false;
  return installationContinuations(config.repository).every(terminal);
}
function validateObjectives(objectives: number[]): void {
  if (
    !Array.isArray(objectives) ||
    !objectives.length ||
    objectives.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(objectives).size !== objectives.length
  )
    throw new Error("queue add requires distinct positive Objective numbers");
}
function scoped<T>(config: FactoryConfig, task: () => Promise<T>): Promise<T> {
  return withRecoveryCheckpointScope(
    { config, buildClosure: () => buildRecoveryCheckpointClosure({ config }) },
    task,
  );
}
function queueOperation<T>(
  config: FactoryConfig,
  task: () => Promise<T>,
): Promise<T> {
  if (!commandScopes.getStore())
    return withIntakeCommandDeadline(
      Date.now() + QUEUE_COMMAND_TIMEOUT_MS,
      () => queueOperation(config, task),
    );
  return withRecoveryCheckpointOperation(
    { config, buildClosure: () => buildRecoveryCheckpointClosure({ config }) },
    task,
    { forwardCompletedBarrier: true, queueControlVerification: true },
  );
}
async function locked<T>(
  config: FactoryConfig,
  task: () => Promise<T>,
): Promise<T> {
  if (!commandScopes.getStore())
    return withIntakeCommandDeadline(
      Date.now() + QUEUE_COMMAND_TIMEOUT_MS,
      () => locked(config, task),
    );
  assertProcessActive();
  mkdirSync(stateRoot(config.repository), { recursive: true, mode: 0o700 });
  const lock = acquireInstallationLock(config.repository);
  try {
    return await scoped(config, task);
  } finally {
    releaseControllerLock(
      join(stateRoot(config.repository), "controller.lock"),
      lock,
    );
  }
}
async function mutationSnapshot(
  config: FactoryConfig,
  github: GitHubGateway,
  objective?: number,
  includeIssue = false,
  preparedHistory?: QueueRecord[],
): Promise<VerifiedQueueInspection> {
  const binding = requireProjectQueueEffects(config);
  if (!github.projectQueueInspect)
    throw new Error(
      "GitHub gateway cannot inspect the current Project command target",
    );
  // This preparation reads current archive/Project authority. A clean original
  // acknowledgment need not rebuild local closure before those reads; dirty or
  // unresolved publication still completes before the distinct effect intent.
  if (!preparedHistory)
    await awaitCheckpointAdmission(config.repository, "before-effect");
  const history = preparedHistory ?? (await readQueueHistory(config));
  const retained =
    objective === undefined
      ? undefined
      : retainedQueueEntry(config, history, objective);
  const inspection = await github.projectQueueInspect(binding, {
    ...(retained ? { itemId: retained.itemId } : {}),
    ...(includeIssue && objective !== undefined ? { objective } : {}),
  });
  return verifyQueueInspection(config, inspection, history, {
    allowUninitializedControl: true,
  });
}
function targetProof(
  inspection: ProjectQueueInspection,
): ProjectQueueExpectedTarget | undefined {
  const target = inspection.target;
  return target
    ? {
        itemId: target.itemId,
        metadata: target.metadata,
        order: target.order,
        issueNodeId: target.issueNodeId,
        objective: target.objective,
      }
    : undefined;
}
/** Find the live owner before sending any admission-changing action. */
async function projectControlRequest(
  config: FactoryConfig,
  operation: "enqueue" | "watch" | "pause" | "resume" | "drain" | "dequeue",
  input?: Record<string, unknown>,
) {
  const scope = commandScopes.getStore();
  const deadlineAt = scope?.deadlineAt ?? Date.now() + QUEUE_COMMAND_TIMEOUT_MS;
  // The service owns the installation's queue. Without it, a live foreground
  // Objective owner executes the command (requestForegroundQueueControl).
  let foreground = false;
  try {
    const observed = await requestControl(
      config.repository,
      {
        objective: 0,
        action: "status",
      },
      { deadlineAt },
    );
    if (!observed.handled) return observed;
  } catch (error) {
    if (!(error instanceof ForegroundControllerError) || !error.objective)
      throw error;
    foreground = true;
  }
  const request: ControlRequest = {
    objective: 0,
    action: "project-queue",
    input: {
      ...input,
      operation,
      protocol: "project-queue-v1",
      ...queueControlBinding(config),
    },
    command: { id: randomUUID(), deadlineAt },
  };
  const reply = foreground
    ? await requestForegroundQueueControl(config.repository, request, {
        deadlineAt,
        onAcknowledgment: scope?.onAcknowledgment,
        // Any provider's run of this installation's queue accepts it.
        binding: queueControlBinding(config),
      })
    : await requestControl(config.repository, request, {
        deadlineAt,
        onAcknowledgment: scope?.onAcknowledgment,
      });
  // Nothing reached a foreground owner: none remains, or the service started.
  if (foreground && !reply.handled) return reply;
  if (!reply.handled)
    throw new ControllerCommandIncompleteError(
      request.command!.id,
      "unknown",
      deadlineAt,
    );
  const completed = reply.result as
    | { result?: unknown; checkpointCompletion?: unknown }
    | undefined;
  if (!completed || !("result" in completed) || !completed.checkpointCompletion)
    throw new Error(
      "Controller queue command lacks its exact completed checkpoint receipt; inspect retained status before another mutation",
    );
  acceptForwardedCheckpointCompletion(completed.checkpointCompletion, {
    requestId: request.command!.id,
    action: `project-queue:${operation}`,
    inputDigest: queueDigest(JSON.stringify(request.input)),
  });
  return { handled: true, result: completed.result };
}
interface PreparedQueueCommand {
  operations: QueueOperation[];
  effects: ProjectQueuePlannedEffect[];
  observations: Map<string, ProjectQueueInspection>;
}
const preparedCommand = (): PreparedQueueCommand => ({
  operations: [],
  effects: [],
  observations: new Map(),
});
function planEffect(
  config: FactoryConfig,
  plan: PreparedQueueCommand,
  operation: QueueOperation,
  current: VerifiedQueueInspection,
  action: ProjectQueuePlannedAction,
  prior: ProjectQueuePlannedEffect["prior"],
  control: ProjectQueuePlannedEffect["control"],
): ProjectQueuePlannedEffect {
  assertProcessActive();
  const effect = createProjectQueuePlannedEffect(
    requireProjectQueueEffects(config),
    {
      ...action,
      operationId: operation.id,
      requestId: randomUUID(),
      actorId: current.inspection.actorId,
      prior,
      control,
      ...(["admit", "roadmap"].includes(operation.action)
        ? {
            expectedIssue: {
              issueNodeId: operation.issueNodeId!,
              objective: operation.objective!,
              bodyDigest: operation.bodyDigest!,
            },
          }
        : {}),
    },
  );
  if (!plan.operations.includes(operation)) plan.operations.push(operation);
  plan.effects.push(effect);
  plan.observations.set(effect.requestId, current.inspection);
  return effect;
}
function planControl(
  config: FactoryConfig,
  plan: PreparedQueueCommand,
  current: VerifiedQueueInspection,
  mode: QueueMode,
  watch?: boolean,
  approval: QueueOperation["approval"] = { kind: "queue-command" },
): ProjectQueuePlannedEffect | undefined {
  const previous = current.control,
    watching = watch ?? previous?.watch ?? false;
  if (
    previous?.mode === mode &&
    previous.watch === watching &&
    current.history.some(
      (record) =>
        record.id === previous.receiptId &&
        record.authorityDigest === factoryAuthorityDigest(config),
    )
  )
    return;
  const operation = createQueueOperation(config, {
    action: "control",
    scope: "control",
    previousReceiptId: previous?.receiptId ?? null,
    approval,
  });
  operation.metadata = JSON.stringify({
    schemaVersion: 1,
    kind: "control",
    receiptId: operation.id,
    mode,
    watch: watching,
  } satisfies QueueMetadata);
  return planEffect(
    config,
    plan,
    operation,
    current,
    {
      action: "set-metadata",
      target: { itemId: current.inspection.control.itemId },
      fieldId: operation.binding.metadataFieldId,
      metadata: operation.metadata,
    },
    {
      target: {
        itemId: current.inspection.control.itemId,
        metadata: current.inspection.control.metadata,
      },
    },
    { metadata: current.inspection.control.metadata },
  );
}
async function executePreparedCommand(
  config: FactoryConfig,
  github: GitHubGateway,
  plan: PreparedQueueCommand,
): Promise<ProjectQueueWriteReceipt[]> {
  if (!plan.effects.length) return [];
  const deadlineAt = currentProcessDeadlineAt() ?? null;
  const command = createQueueCommand(config, {
    operations: plan.operations,
    effects: plan.effects,
    deadlineAt,
  });
  commandScopes.getStore()?.commands.push({ config, id: command.recipe.id });
  await admitQueueCommand(config, command);
  const receipts: ProjectQueueWriteReceipt[] = [];
  for (const [index, effect] of plan.effects.entries()) {
    assertProcessActive();
    const dependencyId =
      "resultOf" in effect.prior ? effect.prior.resultOf : undefined;
    const observation = dependencyId
      ? receipts.find((receipt) => receipt.intent.requestId === dependencyId)
      : plan.observations.get(effect.requestId);
    if (!observation)
      throw new Error(
        "Frozen queue command lacks its exact preceding observation",
      );
    receipts.push(
      await performQueueCommandEffect(
        config,
        github,
        command,
        index,
        observation,
      ),
    );
  }
  await completeQueueCommand(config, command);
  return receipts;
}
function acknowledgedControl(
  current: VerifiedQueueInspection,
  effect: ProjectQueuePlannedEffect | undefined,
  receipts: ProjectQueueWriteReceipt[],
): VerifiedQueueInspection {
  if (!effect) return current;
  const receipt = receipts.find(
    (value) => value.intent.requestId === effect.requestId,
  );
  if (!receipt)
    throw new Error("Completed command lacks its actual control response");
  const target = projectQueueReceiptTarget(receipt);
  const metadata = target.metadata && parseQueueMetadata(target.metadata);
  if (!metadata || metadata.kind !== "control")
    throw new Error("Actual control response lacks completed control metadata");
  return { ...current, control: metadata, uninitializedControl: false };
}
async function writeControl(
  config: FactoryConfig,
  github: GitHubGateway,
  mode: QueueMode,
  watch?: boolean,
  approval: QueueOperation["approval"] = { kind: "queue-command" },
  prepared?: VerifiedQueueInspection,
): Promise<VerifiedQueueInspection> {
  const current = prepared ?? (await mutationSnapshot(config, github));
  const plan = preparedCommand(),
    effect = planControl(config, plan, current, mode, watch, approval);
  return acknowledgedControl(
    current,
    effect,
    await executePreparedCommand(config, github, plan),
  );
}
/** Freeze all target observations against one current authenticated history before effects. */
async function commandTargets(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  includeIssue: boolean,
): Promise<VerifiedQueueInspection[]> {
  validateObjectives(objectives);
  await awaitCheckpointAdmission(config.repository, "before-effect");
  const history = await readQueueHistory(config),
    targets: VerifiedQueueInspection[] = [];
  for (const objective of objectives) {
    const target = await mutationSnapshot(
      config,
      github,
      objective,
      includeIssue,
      history,
    );
    const first = targets[0]?.inspection;
    if (
      first &&
      (target.inspection.actorId !== first.actorId ||
        target.inspection.owner !== first.owner ||
        JSON.stringify(target.inspection.control) !==
          JSON.stringify(first.control) ||
        JSON.stringify(target.inspection.binding) !==
          JSON.stringify(first.binding))
    )
      throw new Error(
        "Project command authority changed while freezing all requested targets",
      );
    targets.push(target);
  }
  return targets;
}
export interface QueueCommandAcknowledgment {
  queueProtocol: "project-queue-v1";
  scope: "target";
  complete: false;
  repository: string;
  configDigest: string;
  command: string;
  control: Extract<QueueMetadata, { kind: "control" }>;
  mode: QueueMode;
  watch?: true;
  targets: {
    objective: number;
    itemId: string;
    state: "queued" | "withdrawn" | "roadmap";
    observedAt: string;
  }[];
  globalObservation: {
    availability: "last-observed" | "unavailable";
    observedAt: string | null;
  };
}
function commandAcknowledgment(
  config: FactoryConfig,
  command: string,
  current: VerifiedQueueInspection,
  targets: QueueCommandAcknowledgment["targets"] = [],
  cached?: IntakeAuthorization,
): QueueCommandAcknowledgment {
  if (!current.control)
    throw new Error(
      "Command acknowledgment requires an actual authenticated control",
    );
  const observedAt = cached?.remoteObservation?.observedAt ?? null;
  return {
    queueProtocol: "project-queue-v1",
    scope: "target",
    complete: false,
    repository: config.repository,
    configDigest: queueConfigDigest(config),
    command,
    control: current.control,
    mode: current.control.mode,
    ...(current.control.watch ? { watch: true } : {}),
    targets,
    globalObservation: {
      availability: observedAt ? "last-observed" : "unavailable",
      observedAt,
    },
  };
}
interface EnqueueOptions {
  expectedBodyDigests?: Record<string, string>;
}
interface ProjectPublicationProvenance {
  kind: "proposal";
  proposalId: string;
  approvalDigest: string;
  bodyDigest?: string;
}
async function enqueueOwned(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  options: EnqueueOptions = {},
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  return projectMutation(config, github, () =>
    enqueueMutation(config, github, objectives, options, cached),
  );
}
async function enqueueMutation(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  options: EnqueueOptions,
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  checkRequiredEnvironment(config);
  const observed = await commandTargets(config, github, objectives, true),
    first = observed[0]!;
  if (first.control?.mode === "draining")
    throw new Error(
      "The queue is draining; use `factory queue resume` before adding work",
    );
  const plan = preparedCommand();
  const controlEffect = planControl(
    config,
    plan,
    first,
    first.control?.mode ?? "running",
  );
  const control = controlEffect
    ? { resultOf: controlEffect.requestId }
    : { metadata: first.inspection.control.metadata };
  const targets: QueueCommandAcknowledgment["targets"] = [];
  const completions: { objective: number; requestId: string }[] = [];
  let nextOrder: number | undefined;
  for (const [index, current] of observed.entries()) {
    const objective = objectives[index]!,
      issue = current.inspection.issue;
    if (!issue || issue.objective !== objective || issue.state !== "open")
      throw new Error(
        `Objective #${objective} must be an authenticated open Issue with its exact node identity`,
      );
    const bodyDigest = queueDigest(issue.body);
    if (
      options.expectedBodyDigests &&
      options.expectedBodyDigests[objective] !== bodyDigest
    )
      throw new Error(
        `Objective #${objective} changed after reviewed publication; exact approved contents are required`,
      );
    const previous = current.entry;
    if (
      previous?.state === "queued" &&
      previous.bodyDigest === bodyDigest &&
      previous.authorityDigest === factoryAuthorityDigest(config)
    ) {
      targets.push({
        objective,
        itemId: previous.itemId,
        state: "queued",
        observedAt: current.inspection.observedAt,
      });
      continue;
    }
    const existing = readContinuation(config.repository, objective);
    if (existing && !terminal(existing) && previous?.bodyDigest !== bodyDigest)
      throw new Error(
        "Unfinished approved contents cannot be replaced by requeueing; use supported recovery",
      );
    if (
      current.history.some(
        (record) =>
          record.kind === "project-queue-owner" &&
          record.objective === objective &&
          !record.settled,
      )
    )
      throw new Error(
        "Objective has an unresolved or foreign owner; admission changes are held",
      );
    const order =
      previous?.order ?? nextOrder ?? nextProjectQueueOrder(first.history);
    if (!previous) nextOrder = order + 1;
    if (!Number.isSafeInteger(order))
      throw new Error("Project order exhausted its exact integer range");
    const operation = createQueueOperation(config, {
      action: "admit",
      scope: issue.issueNodeId,
      previousReceiptId: previous?.receiptId ?? null,
      approval: { kind: "queue-command" },
      objective,
      issueNodeId: issue.issueNodeId,
      bodyDigest,
      order,
    });
    operation.metadata = JSON.stringify({
      schemaVersion: 1,
      kind: "admission",
      admissionId: randomUUID(),
      receiptId: operation.id,
      state: "queued",
    } satisfies QueueMetadata);
    const ensured = planEffect(
      config,
      plan,
      operation,
      current,
      { action: "ensure-card", issueNodeId: issue.issueNodeId },
      { target: targetProof(current.inspection) ?? null },
      control,
    );
    const admitted = planEffect(
      config,
      plan,
      operation,
      current,
      {
        action: "set-admission-fields",
        target: { resultOf: ensured.requestId },
        orderFieldId: operation.binding.orderFieldId,
        metadataFieldId: operation.binding.metadataFieldId,
        order,
        metadata: operation.metadata,
      },
      { resultOf: ensured.requestId },
      control,
    );
    completions.push({ objective, requestId: admitted.requestId });
  }
  const receipts = await executePreparedCommand(config, github, plan);
  for (const completion of completions) {
    const receipt = receipts.find(
      (value) => value.intent.requestId === completion.requestId,
    );
    if (!receipt)
      throw new Error(
        "Completed admission lacks its exact final original response",
      );
    targets.push({
      objective: completion.objective,
      itemId: receipt.itemId,
      state: "queued",
      observedAt: receipt.observedAt,
    });
  }
  targets.sort(
    (left, right) =>
      objectives.indexOf(left.objective) - objectives.indexOf(right.objective),
  );
  return commandAcknowledgment(
    config,
    "enqueue",
    acknowledgedControl(first, controlEffect, receipts),
    targets,
    cached,
  );
}
export async function enqueueIntake(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  options: EnqueueOptions = {},
): Promise<QueueCommandAcknowledgment> {
  return queueOperation(config, () =>
    enqueueIntakeCommand(config, github, objectives, options),
  );
}
async function enqueueIntakeCommand(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  options: EnqueueOptions,
): Promise<QueueCommandAcknowledgment> {
  const reply = await projectControlRequest(config, "enqueue", {
    objectives,
    ...options,
  });
  if (reply.handled) return reply.result as QueueCommandAcknowledgment;
  return locked(config, () =>
    enqueueOwned(config, github, objectives, options),
  );
}
/**
 * A foreground run admits its reviewed split's children itself: while it
 * owns its Objective no installation controller can hold the queue, so it
 * uses the same owned admission a controller's queue command would.
 */
export async function admitChildObjectives(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  expectedBodyDigests: Record<string, string>,
): Promise<void> {
  // Foreground owners of different Objectives can run side by side; their
  // admissions take turns under the queue mutation lock (projectMutation).
  await queueOperation(config, () =>
    scoped(config, () =>
      enqueueOwned(config, github, objectives, { expectedBodyDigests }),
    ),
  );
}
export async function ensureProjectObjective(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  provenance?: ProjectPublicationProvenance,
): Promise<void> {
  return queueOperation(config, () =>
    ensureProjectObjectiveCommand(config, github, objective, provenance),
  );
}
async function ensureProjectObjectiveCommand(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  provenance?: ProjectPublicationProvenance,
): Promise<void> {
  const reply = await projectControlRequest(config, "enqueue", {
    roadmapOnly: true,
    objectives: [objective],
    provenance,
  });
  if (reply.handled) return;
  await locked(config, () =>
    ensureProjectObjectiveOwned(config, github, objective, provenance),
  );
}
async function ensureProjectObjectiveOwned(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  provenance?: ProjectPublicationProvenance,
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  return ensureProjectObjectivesOwned(
    config,
    github,
    [objective],
    provenance,
    cached,
  );
}
async function ensureProjectObjectivesOwned(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  provenance?: ProjectPublicationProvenance,
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  return projectMutation(config, github, async () => {
    const observed = await commandTargets(config, github, objectives, true),
      first = observed[0]!;
    const plan = preparedCommand(),
      controlEffect = planControl(
        config,
        plan,
        first,
        first.control?.mode ?? "running",
      );
    const control = controlEffect
      ? { resultOf: controlEffect.requestId }
      : { metadata: first.inspection.control.metadata };
    const completions: { objective: number; requestId: string }[] = [];
    for (const [index, current] of observed.entries()) {
      const objective = objectives[index]!,
        issue = current.inspection.issue;
      if (!issue || issue.objective !== objective)
        throw new Error(
          "Project publication requires authenticated Issue identity",
        );
      const bodyDigest = queueDigest(issue.body);
      if (provenance?.bodyDigest && provenance.bodyDigest !== bodyDigest)
        throw new Error(
          "Published contents changed before Project card publication",
        );
      const operation = createQueueOperation(config, {
        action: "roadmap",
        scope: `roadmap:${issue.issueNodeId}`,
        previousReceiptId: null,
        approval: provenance
          ? {
              kind: "proposal",
              proposalId: provenance.proposalId,
              approvalDigest: provenance.approvalDigest,
            }
          : { kind: "queue-command" },
        objective,
        issueNodeId: issue.issueNodeId,
        bodyDigest,
      });
      const ensured = planEffect(
        config,
        plan,
        operation,
        current,
        { action: "ensure-card", issueNodeId: issue.issueNodeId },
        { target: targetProof(current.inspection) ?? null },
        control,
      );
      completions.push({ objective, requestId: ensured.requestId });
    }
    const receipts = await executePreparedCommand(config, github, plan);
    const targets = completions.map((completion) => {
      const receipt = receipts.find(
        (value) => value.intent.requestId === completion.requestId,
      );
      if (!receipt)
        throw new Error(
          "Completed roadmap publication lacks its actual original response",
        );
      return {
        objective: completion.objective,
        itemId: receipt.itemId,
        state: "roadmap" as const,
        observedAt: receipt.observedAt,
      };
    });
    return commandAcknowledgment(
      config,
      "roadmap",
      acknowledgedControl(first, controlEffect, receipts),
      targets,
      cached,
    );
  });
}
export async function watchIntake(
  config: FactoryConfig,
  github: GitHubGateway = defaultGateway(config),
): Promise<QueueCommandAcknowledgment> {
  return queueOperation(config, () => watchIntakeCommand(config, github));
}
async function watchIntakeCommand(
  config: FactoryConfig,
  github: GitHubGateway,
): Promise<QueueCommandAcknowledgment> {
  const reply = await projectControlRequest(config, "watch");
  if (reply.handled) return reply.result as QueueCommandAcknowledgment;
  return locked(config, () => writeWatch(config, github));
}
function writeWatch(
  config: FactoryConfig,
  github: GitHubGateway,
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  return projectMutation(config, github, async () => {
    const current = await mutationSnapshot(config, github);
    const completed = await writeControl(
      config,
      github,
      current.control?.mode ?? "running",
      true,
      { kind: "background-setup" },
      current,
    );
    return commandAcknowledgment(config, "watch", completed, [], cached);
  });
}
async function applyControl(
  config: FactoryConfig,
  github: GitHubGateway,
  action: string,
  objective?: number | number[],
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  const task = () =>
    applyControlOwned(config, github, action, objective, cached);
  return ["pause", "resume", "drain"].includes(action)
    ? withQueueControlVerification(
        {
          config,
          buildClosure: () => buildRecoveryCheckpointClosure({ config }),
        },
        task,
      )
    : task();
}
async function applyControlOwned(
  config: FactoryConfig,
  github: GitHubGateway,
  action: string,
  objective?: number | number[],
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  return projectMutation(config, github, () =>
    applyControlMutation(config, github, action, objective, cached),
  );
}
async function applyControlMutation(
  config: FactoryConfig,
  github: GitHubGateway,
  action: string,
  objective?: number | number[],
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  if (action === "dequeue") {
    const objectives = Array.isArray(objective) ? objective : [objective!];
    const observed = await commandTargets(config, github, objectives, false),
      first = observed[0]!;
    const plan = preparedCommand(),
      completions: { objective: number; requestId: string }[] = [];
    for (const [index, current] of observed.entries()) {
      const entry = current.entry;
      if (
        !entry ||
        entry.objective !== objectives[index] ||
        entry.state !== "queued"
      )
        throw new Error(`Objective #${objectives[index]} is not admitted`);
      // Retired terminal history is settled and never acted on (#1457).
      const read = readScannedContinuation(config.repository, entry.objective);
      const state = read === "history" ? undefined : read;
      if (
        (state && !terminal(state)) ||
        (current.history.some(
          (record) =>
            record.kind === "project-queue-owner" &&
            record.objective === entry.objective &&
            !record.settled,
        ) &&
          !cancelledRunQuiescent(config, entry.objective))
      )
        throw new Error(
          `Objective #${entry.objective} has unfinished owned work; use supported cancellation before removal`,
        );
      const operation = createQueueOperation(config, {
        action: "withdraw",
        scope: entry.issueNodeId,
        previousReceiptId: entry.receiptId,
        approval: { kind: "queue-command" },
        objective: entry.objective,
        issueNodeId: entry.issueNodeId,
        bodyDigest: entry.bodyDigest,
        order: entry.order,
      });
      operation.metadata = JSON.stringify({
        schemaVersion: 1,
        kind: "admission",
        admissionId: entry.admissionId,
        receiptId: operation.id,
        state: "withdrawn",
      } satisfies QueueMetadata);
      const withdrawn = planEffect(
        config,
        plan,
        operation,
        current,
        {
          action: "set-metadata",
          target: { itemId: entry.itemId },
          fieldId: operation.binding.metadataFieldId,
          metadata: operation.metadata,
        },
        { target: targetProof(current.inspection) ?? null },
        { metadata: first.inspection.control.metadata },
      );
      completions.push({
        objective: entry.objective,
        requestId: withdrawn.requestId,
      });
    }
    const receipts = await executePreparedCommand(config, github, plan);
    const targets = completions.map((completion) => {
      const receipt = receipts.find(
        (value) => value.intent.requestId === completion.requestId,
      );
      if (!receipt)
        throw new Error(
          "Completed withdrawal lacks its actual original response",
        );
      return {
        objective: completion.objective,
        itemId: receipt.itemId,
        state: "withdrawn" as const,
        observedAt: receipt.observedAt,
      };
    });
    return commandAcknowledgment(config, action, first, targets, cached);
  }
  if (!["pause", "resume", "drain", "handoff"].includes(action))
    throw new Error("Unsupported queue action");
  const current = await mutationSnapshot(config, github);
  const completed = await writeControl(
    config,
    github,
    action === "pause"
      ? "paused"
      : action === "resume"
        ? "running"
        : "draining",
    undefined,
    undefined,
    current,
  );
  return commandAcknowledgment(config, action, completed, [], cached);
}
export async function intakeControl(
  config: FactoryConfig,
  action: "status" | "sync" | "pause" | "resume" | "drain" | "dequeue",
  objective?: number | number[],
  github: GitHubGateway = defaultGateway(config),
): Promise<unknown> {
  if (action !== "status" && action !== "sync")
    return queueOperation(config, () =>
      intakeControlCommand(config, action, objective, github),
    );
  return intakeControlCommand(config, action, objective, github);
}
async function intakeControlCommand(
  config: FactoryConfig,
  action: "status" | "sync" | "pause" | "resume" | "drain" | "dequeue",
  objective: number | number[] | undefined,
  github: GitHubGateway,
): Promise<unknown> {
  if (action === "sync") return readIntake(config, { github });
  let reply: Awaited<ReturnType<typeof requestControl>>;
  try {
    reply =
      action === "status"
        ? await requestControl(
            config.repository,
            {
              objective: 0,
              action: "status",
            },
            {
              deadlineAt:
                commandScopes.getStore()?.deadlineAt ?? Date.now() + 1000,
            },
          )
        : await projectControlRequest(
            config,
            action,
            action === "dequeue"
              ? {
                  objectives: Array.isArray(objective)
                    ? objective
                    : [objective!],
                }
              : undefined,
          );
  } catch (error) {
    if (action !== "status" || !(error instanceof ForegroundControllerError))
      throw error;
    const foreground = liveObjectiveOwners(config.repository).map(
      (owner) => owner.objective,
    );
    return {
      ...(await readIntake(config, { github })),
      activeObjective: error.objective,
      activeObjectives: foreground.length ? foreground : [error.objective],
    };
  }
  if (reply.handled) return reply.result;
  if (action === "status") return readIntake(config, { github });
  return locked(config, () => applyControl(config, github, action, objective));
}
/**
 * A forwarded Project queue command, authenticated against this owner's queue
 * authority and its original bounded deadline. Returns it with its operation as
 * the action.
 */
function authenticatedQueueCommand(
  config: FactoryConfig,
  request: ControlRequest,
): ControlRequest {
  const operation = request.input?.operation;
  if (
    request.objective !== 0 ||
    request.input?.protocol !== "project-queue-v1" ||
    request.input?.authorityDigest !== factoryAuthorityDigest(config) ||
    request.input?.configDigest !== queueConfigDigest(config) ||
    typeof operation !== "string" ||
    !["enqueue", "watch", "pause", "resume", "drain", "dequeue"].includes(
      operation,
    )
  )
    throw new Error(
      "Project queue control protocol or authority binding differs",
    );
  if (
    !request.command ||
    request.command.deadlineAt > Date.now() + QUEUE_COMMAND_TIMEOUT_MS
  )
    throw new Error(
      "Project queue command requires its original bounded request deadline",
    );
  return { ...request, action: operation as ControlRequest["action"] };
}
/** The Project effect of one authenticated queue command, by its live owner. */
function ownedQueueCommand(
  config: FactoryConfig,
  github: GitHubGateway,
  request: ControlRequest,
  cached?: IntakeAuthorization,
): Promise<QueueCommandAcknowledgment> {
  if (request.action === "enqueue") {
    const ids = request.input?.objectives as number[];
    return request.input?.roadmapOnly
      ? ensureProjectObjectivesOwned(
          config,
          github,
          ids,
          request.input?.provenance as ProjectPublicationProvenance | undefined,
          cached,
        )
      : enqueueOwned(
          config,
          github,
          ids,
          {
            expectedBodyDigests: request.input?.expectedBodyDigests as
              | Record<string, string>
              | undefined,
          },
          cached,
        );
  }
  if (request.action === "watch") return writeWatch(config, github, cached);
  return applyControl(
    config,
    github,
    request.action,
    request.action === "dequeue"
      ? (request.input?.objectives as number[])
      : undefined,
    cached,
  );
}
/**
 * The queue command handler of a foreground `factory run`: with no service, a
 * live foreground owner executes the installation's queue commands, as the
 * service would, and returns the command's exact completion receipt after its
 * terminal archive acknowledgment. Its pause, resume and drain change the
 * Project control only: they hold or allow new dispatch, and the running
 * Objectives keep their own `factory pause|drain|resume --objective N`.
 */
export function foregroundQueueControl(
  config: FactoryConfig,
  github: GitHubGateway,
): (request: ControlRequest) => Promise<unknown> {
  return async (original) => {
    const request = authenticatedQueueCommand(config, original);
    assertProcessActive();
    return withRecoveryCheckpointCommandOperation(
      {
        config,
        buildClosure: () => buildRecoveryCheckpointClosure({ config }),
      },
      {
        requestId: original.command!.id,
        action: `project-queue:${request.action}`,
        inputDigest: queueDigest(JSON.stringify(original.input)),
      },
      () => ownedQueueCommand(config, github, request),
    );
  };
}
export async function resumeWatcherAfterUpgrade(
  config: FactoryConfig,
  expected: IntakeAuthorization,
): Promise<boolean> {
  return locked(config, async () => {
    const github = defaultGateway(config);
    const current = await readIntake(config, { github });
    if (
      !current?.complete ||
      !current.watch ||
      !expected.watch ||
      expected.mode !== "running" ||
      !["draining", "running"].includes(current.mode) ||
      current.configDigest !== expected.configDigest ||
      JSON.stringify(current.objectives) !==
        JSON.stringify(expected.objectives) ||
      JSON.stringify(current.bodyDigests) !==
        JSON.stringify(expected.bodyDigests) ||
      JSON.stringify(current.dequeued) !== JSON.stringify(expected.dequeued) ||
      !(await intakeSettled(config))
    )
      return false;
    if (current.mode === "draining")
      await applyControl(config, github, "resume");
    return true;
  });
}
export async function resolveIntakeBase(
  config: FactoryConfig,
  github: GitHubGateway,
  predecessors: number[],
  objective: number,
): Promise<void> {
  // With no predecessor outputs there is no base-dependent eligibility to
  // resolve here. The new preparation fetches and aligns its authoritative
  // default head after the fresh Project claim; do not fetch it twice.
  if (!predecessors.length) {
    if (git(config.checkout, "status", "--porcelain"))
      throw new Error(
        "Compilation checkout has local changes; preserve them before intake",
      );
    return;
  }
  const head = await fetchHead(config.checkout, await github.defaultBranch());
  await planningPrerequisites(config, github, objective, head, predecessors);
  if (git(config.checkout, "status", "--porcelain"))
    throw new Error(
      "Compilation checkout has local changes; preserve them before intake",
    );
  await gitAsync(config.checkout, "merge", "--ff-only", head);
  if (git(config.checkout, "rev-parse", "HEAD") !== head)
    throw new Error(
      "Compilation checkout diverges from authenticated default head",
    );
}
export interface IntakeStartupOptions {
  backgroundConfigurationPath?: string;
  /** Services for a queued Objective's frozen provider when it is not the service's own. */
  servicesFor?: (config: FactoryConfig) => ApplicationServices;
}
export function runIntake(
  config: FactoryConfig,
  services: ApplicationServices,
  options: IntakeStartupOptions = {},
): Promise<IntakeAuthorization> {
  return withRecoveryCheckpointControllerVerification(
    { config, buildClosure: () => buildRecoveryCheckpointClosure({ config }) },
    () => runIntakeOwned(config, services, options),
  );
}
async function runIntakeOwned(
  config: FactoryConfig,
  services: ApplicationServices,
  options: IntakeStartupOptions,
): Promise<IntakeAuthorization> {
  requireProjectQueueEffects(config);
  let record = view(config);
  const lockPath = join(stateRoot(config.repository), "controller.lock"),
    lock = acquireInstallationLock(config.repository);
  let server: Awaited<ReturnType<typeof serveControl>> | undefined;
  // The Objectives this service runs at once, each with the control its run
  // registers; at most queue.maxActiveObjectives (default 1).
  const active = new Map<
    number,
    { control?: (request: ControlRequest) => Promise<unknown> }
  >();
  const slots = maxActiveObjectives(config);
  const activeControls = () =>
    [...active].flatMap(([objective, entry]) =>
      entry.control ? [[objective, entry.control] as const] : [],
    );
  // A run that needs a person or failed holds new dispatch; the service then
  // ends with this record once its other active runs settle.
  let stopping: IntakeAuthorization["observation"];
  // Upgrade drain (`factory supervisor upgrade` with several Objectives): no
  // new dispatch while the active runs finish; `queue resume` lifts it.
  let finishing = false;
  let handingOff = false;
  let localMode: QueueMode | undefined;
  let completedCheckpointFailure: IntakeAuthorization["observation"];
  let wake: (() => void) | undefined;
  let wakePending = false;
  const signalWake = () => {
    wakePending = true;
    wake?.();
  };
  const registerWake = (handler: (() => void) | undefined) => {
    wake = handler;
    if (handler && wakePending) {
      wakePending = false;
      handler();
    }
  };
  let heldUntil = 0;
  // The provider configuration and services each Objective froze: the
  // service continues every Objective on them.
  const objectiveRuntime = (
    objective: number,
  ): { config: FactoryConfig; services: ApplicationServices } => {
    const objectiveConfig = options.backgroundConfigurationPath
      ? queuedObjectiveConfig(
          config,
          objective,
          options.backgroundConfigurationPath,
        )
      : config;
    if (objectiveConfig === config) return { config, services };
    if (!options.servicesFor)
      throw new Error(
        `Objective #${objective} runs with another provider, and this service cannot compose it`,
      );
    return {
      config: objectiveConfig,
      services: options.servicesFor(objectiveConfig),
    };
  };
  let controlTail: Promise<unknown> = Promise.resolve();
  let pendingMutations = 0;
  let backgroundObservation: AbortController | undefined;
  const observationPreempted = new DOMException(
    "Read-only Project observation yielded to an authenticated queue command",
    "AbortError",
  );
  const observeBackground = async (): Promise<VerifiedQueueObservation> => {
    const poll = new AbortController();
    backgroundObservation = poll;
    const inherited = currentProcessSignal();
    const inheritedDeadline = inherited
      ? currentProcessDeadlineAt()
      : undefined;
    const signal = inherited
      ? AbortSignal.any([inherited, poll.signal])
      : poll.signal;
    try {
      const binding = requireProjectQueueEffects(config);
      if (!services.github.projectQueueRead)
        throw new Error("GitHub gateway cannot read Project queue metadata");
      // Only the serial read-only GitHub leg is preemptible. Archive checking
      // keeps the original controller scope and its authenticated verifier.
      const history = await readQueueHistory(config);
      const targets = queueObservationTargets(history);
      const snapshot = await withProcessCancellation(
        signal,
        async () => {
          const current = await services.github.projectQueueRead!(
            binding,
            targets,
          );
          signal.throwIfAborted();
          return current;
        },
        undefined,
        inheritedDeadline,
      );
      inherited?.throwIfAborted();
      poll.signal.throwIfAborted();
      return verifyQueueObservation(config, snapshot, history);
    } catch (error) {
      const transport = gitHubTransportOf(error);
      if (
        poll.signal.reason === observationPreempted &&
        !inherited?.aborted &&
        (error === observationPreempted ||
          attachedFault(error)?.kind === "cancelled" ||
          (transport?.operation === "read" &&
            transport.cancellation === true &&
            transport.category === "cancelled" &&
            transport.timeout !== true))
      )
        throw observationPreempted;
      throw error;
    } finally {
      if (backgroundObservation === poll) backgroundObservation = undefined;
    }
  };
  const holdFor = (error: unknown) => {
    const fault = attachedFault(error);
    const at =
      fault?.kind === "transient" && fault.retryAt
        ? Date.parse(fault.retryAt)
        : Number.NaN;
    if (Number.isFinite(at)) heldUntil = Math.max(heldUntil, at);
  };
  const onHandoff = () => {
    handingOff = true;
    localMode = "draining";
    for (const [objective, control] of activeControls())
      void control({ objective, action: "handoff" }).catch(() => undefined);
    signalWake();
  };
  const authenticateQueueRequest = (
    request: ControlRequest,
  ): ControlRequest => {
    if (request.action === "project-queue") {
      request = authenticatedQueueCommand(config, request);
    } else if (
      request.objective === 0 &&
      ["enqueue", "watch", "resume", "dequeue"].includes(request.action)
    )
      throw new Error(
        "Queue mutations require the Project queue protocol; upgrade the caller before admission",
      );
    return request;
  };
  const localStatus = () => ({
    ...record,
    ...(completedCheckpointFailure
      ? { observation: completedCheckpointFailure }
      : stopping
        ? { observation: stopping }
        : {}),
    activeObjective: [...active.keys()][0] ?? null,
    activeObjectives: [...active.keys()],
    maxActiveObjectives: slots,
    ...(finishing ? { finishing: true } : {}),
    // A run's stop holds new dispatch locally without pausing the other runs.
    ...(localMode || stopping || completedCheckpointFailure
      ? { localMode: localMode ?? "paused" }
      : {}),
    pendingMutations,
  });
  const handleOwned = async (request: ControlRequest): Promise<unknown> => {
    if (request.objective !== 0) {
      const control = active.get(request.objective)?.control;
      if (control) return control(request);
      if (request.action === "decide") {
        // The Objective's run registers its control late and clears it early;
        // in those windows it may be writing state it has not saved yet.
        if (active.has(request.objective))
          throw new Error(
            `Objective #${request.objective} is starting or settling under the service; retry the decision`,
          );
        // A queued Objective stopped for a person: the service owns the
        // installation, so it records the decision itself, on the provider the
        // Objective froze. This request is pending control, which holds new
        // dispatch until it settles (#1290).
        if (record.objectives.includes(request.objective)) {
          const input = parseDecisionInput(request.input);
          const { config: objectiveConfig, services: objectiveServices } =
            objectiveRuntime(request.objective);
          return asInstallationOwner(lock, () =>
            decideStoppedObjective(
              objectiveConfig,
              request.objective,
              objectiveServices,
              input,
            ),
          );
        }
      }
      const state = readContinuation(config.repository, request.objective);
      if (
        request.action === "status" &&
        state &&
        record.objectives.includes(request.objective)
      )
        return state.coordinator;
      throw new Error(
        "Only the current owned Objective supports lifecycle control; inspect retained state",
      );
    }
    if (request.action === "status") {
      return localStatus();
    }
    if (["pause", "drain", "handoff"].includes(request.action)) {
      signalWake();
    }
    let acknowledgment: QueueCommandAcknowledgment;
    if (request.action === "enqueue" || request.action === "watch") {
      if (
        request.action === "enqueue" &&
        (handingOff || localMode === "draining")
      )
        throw new Error("The local service is draining");
      acknowledgment = await ownedQueueCommand(
        config,
        services.github,
        request,
        record,
      );
    } else {
      try {
        acknowledgment = await ownedQueueCommand(
          config,
          services.github,
          request,
          record,
        );
      } catch (error) {
        if (["pause", "drain", "handoff"].includes(request.action))
          record = {
            ...record,
            complete: false,
            observation: {
              at: new Date().toISOString(),
              reasons: {},
              error: `Local new dispatch remains held; Project synchronization incomplete or unknown: ${String(error)}`,
            },
          };
        throw error;
      }
      if (request.action === "resume")
        for (const [objective, control] of activeControls())
          await control({ objective, action: "resume" });
    }
    signalWake();
    return acknowledgment;
  };
  const handle = (
    original: ControlRequest,
    context: ControlContext,
  ): Promise<unknown> => {
    const request = authenticateQueueRequest(original);
    assertProcessActive();
    let localCessation: Promise<{ error?: unknown }> | undefined;
    // Token/live-owner authentication happens in serveControl; semantic authority
    // is checked above before any local dispatch state changes.
    if (request.action === "status") return handleOwned(request);
    if (request.objective === 0 && request.action === "finish") {
      finishing = true;
      signalWake();
      return Promise.resolve(localStatus());
    }
    if (request.objective === 0)
      backgroundObservation?.abort(observationPreempted);
    if (
      request.objective === 0 &&
      ["pause", "drain", "handoff"].includes(request.action)
    ) {
      localMode = request.action === "pause" ? "paused" : "draining";
      if (request.action === "handoff") handingOff = true;
      // The existing Objective handler sets its dispatch stop synchronously
      // before its returned promise. Retain already admitted work, and await
      // the same requested transition as part of this bounded command.
      const controls = activeControls();
      if (controls.length)
        localCessation = Promise.all(
          controls.map(([objective, control]) =>
            control({ objective, action: request.action }),
          ),
        ).then(
          () => ({}),
          (error) => ({ error }),
        );
      signalWake();
      context.acknowledge({
        kind: "local-cessation-acknowledgment",
        at: new Date().toISOString(),
        newDispatch: "held",
        admittedWork: "retained",
        projectSynchronization: "pending",
        physicalSettlement: "not-asserted",
      });
    }
    pendingMutations++;
    const result = controlTail
      .then(async () => {
        context.signal.throwIfAborted();
        assertProcessActive();
        const task = async () => {
          const cessation = await localCessation;
          if (cessation?.error) throw cessation.error;
          return handleOwned(request);
        };
        const completed =
          original.action === "project-queue"
            ? await withRecoveryCheckpointCommandOperation(
                {
                  config,
                  buildClosure: () =>
                    buildRecoveryCheckpointClosure({ config }),
                },
                {
                  requestId: original.command!.id,
                  action: `project-queue:${request.action}`,
                  inputDigest: queueDigest(JSON.stringify(original.input)),
                },
                task,
              )
            : await task();
        context.signal.throwIfAborted();
        assertProcessActive();
        if (request.objective === 0 && request.action === "resume") {
          localMode = undefined;
          completedCheckpointFailure = undefined;
          stopping = undefined;
          finishing = false;
        }
        signalWake();
        return completed;
      })
      .finally(() => {
        pendingMutations--;
        signalWake();
      });
    controlTail = result.catch(() => undefined);
    return result;
  };
  // Node opens its inspector on an unhandled SIGUSR1. With one slot the
  // run takes cancellation by it; with several, cancellation comes only
  // through the control endpoint, and the lock records which (#1590).
  const ignoreSignal = () => {
    if (slots > 1)
      process.stderr.write(
        `Factory ignored SIGUSR1: this service runs up to ${slots} Objectives and cancels them only through its control endpoint (\`factory cancel\`).\n`,
      );
  };
  process.on("SIGUSR1", ignoreSignal);
  process.on("SIGTERM", onHandoff);
  try {
    retargetControllerLock(lockPath, lock, 0, slots === 1);
    assertRestoredInstallationDispatchReady(config);
    // Cold preparation owns the existing lease and exposes no readiness or
    // dispatch until the controller's remote-only verifier is authenticated.
    // Queue receipts are read only from the authenticated archive. This
    // installation's own unacknowledged changes complete first, as before any
    // queue command's read: a queue command whose deadline cut off its final
    // checkpoint (durability-pending), or a submitted attempt not yet
    // acknowledged, is reconciled and published before the tip check and the
    // queue observation (#1298). A held archive needs the operator.
    // This lease excludes every Objective owner: a completed worker return
    // still uncollected was left by a stopped controller, and it refuses
    // that publication and readiness until collected, so collect it first.
    // Each Objective's return is collected on the provider it froze.
    await collectStoppedWorkerReturns(
      installationContinuations(config.repository).map((state) => ({
        state,
        runtime: () => {
          const runtime = objectiveRuntime(state.objective);
          return {
            config: runtime.config,
            driver: runtime.services.driver,
          };
        },
      })),
    );
    try {
      await awaitCheckpointAdmission(config.repository, "before-effect");
    } catch (error) {
      const message = `Cold controller cannot publish this installation's pending checkpoint: ${error instanceof Error ? error.message : String(error)}`;
      if (
        ["conflict", "needs-restore"].includes(
          gitPersistenceStatus(config).status,
        )
      )
        throw new ColdPublicationHeld(
          `${message}; inspect factory persistence status and restore or reconcile the archive before starting the service`,
          { cause: error },
        );
      throw new Error(message, { cause: error });
    }
    // An installation without an acknowledged archive keeps its initial path.
    const persistence = gitPersistenceStatus(config);
    const acknowledged = persistence.lastAcknowledged;
    if (persistence.scope === "private-history" && acknowledged) {
      const verified = await readVerifiedRecoveryCheckpoint(
        config,
        acknowledged.commitSha,
      );
      if (
        verified.commitSha !== acknowledged.commitSha ||
        verified.remoteTip !== acknowledged.commitSha ||
        verified.payloadDigest !== acknowledged.payloadDigest ||
        verified.manifest.sequence !== acknowledged.sequence
      )
        throw new Error(
          "Cold controller preparation differs from the acknowledged current archive tip",
        );
      // Prime actual local originals and Git roots in the same cold owner scope.
      // Required gaps hold readiness exactly as they hold checkpoint publication.
      const closure = await buildRecoveryCheckpointClosure({ config });
      assertProcessActive();
      if (
        closure.gaps.some((gap) => gap.required !== false) ||
        checkpointRetentionGaps(config.repository).length
      )
        throw new Error(
          "Cold controller local checkpoint closure retains required unavailable originals; readiness is held",
        );
    }
    record = view(config, await observeProjectQueue(config, services.github));
    if (options.backgroundConfigurationPath)
      checkPreparedIntakeServiceState(
        config,
        options.backgroundConfigurationPath,
        record,
      );
    server = await serveControl(
      config.repository,
      lock,
      bindRecoveryCheckpointControllerScope(handle),
    );
    const runs = new Set<Promise<void>>();
    // Runs asked to hand off because they wait behind an overlap while the
    // service stops; their handoff is not the service's.
    const yielded = new Set<number>();
    // Objectives this service handed back to the queue: their handoff left
    // them draining, so their next run here resumes them.
    const requeued = new Set<number>();
    const idle = () =>
      pauseObservation(
        queuePollSeconds(config) * 1000,
        heldUntil,
        registerWake,
      );
    /**
     * Hold new dispatch; the service stops once its other runs settle. Those
     * runs continue: this is not an operator pause.
     */
    const stop = (
      observation: NonNullable<IntakeAuthorization["observation"]>,
    ) => {
      stopping ??= observation;
      signalWake();
    };
    const launch = (selected: number, reasons: Record<string, string>) => {
      const entry: { control?: (request: ControlRequest) => Promise<unknown> } =
        {};
      active.set(selected, entry);
      const run = (async () => {
        try {
          const { config: objectiveConfig, services: objectiveServices } =
            objectiveRuntime(selected);
          // The service owns each Objective it runs with that Objective's own
          // lock, so several run side by side and each claim names one.
          const result = await withObjectiveDelegation(lock, () =>
            runObjective(objectiveConfig, selected, objectiveServices, {
              signalCancel: slots === 1,
              // Children of a split are admitted through this controller's
              // own authenticated queue command path.
              admitChildObjectives: (objectives, expectedBodyDigests) =>
                enqueueIntake(config, services.github, objectives, {
                  expectedBodyDigests,
                }).then(() => undefined),
              // Held behind an overlapping Objective after planning: the run
              // hands its slot back and selection passes over it until the
              // overlap clears.
              onExecutionHeld: () => {
                if (slots <= 1 || handingOff || localMode) return false;
                yielded.add(selected);
                requeued.add(selected);
                return true;
              },
              observeControl: async (handler) => {
                entry.control = handler;
                if (
                  handler &&
                  requeued.delete(selected) &&
                  !handingOff &&
                  !localMode
                )
                  // A refused resume leaves it draining; status names resume.
                  await handler({
                    objective: selected,
                    action: "resume",
                  }).catch(() => undefined);
                if (handler && (handingOff || localMode))
                  await handler({
                    objective: selected,
                    action: handingOff
                      ? "handoff"
                      : localMode === "paused"
                        ? "pause"
                        : "drain",
                  });
              },
            }),
          );
          if (!terminal(result))
            stop({
              at: new Date().toISOString(),
              reasons,
              needsDecision: selected,
              error:
                result.coordinator?.waitReason ??
                "Inspect retained Objective status",
            });
        } catch (error) {
          if (error instanceof CoordinatorHandoff) {
            if (!yielded.delete(selected)) handingOff = true;
            return;
          }
          const observation = {
            at: new Date().toISOString(),
            reasons,
            error: String(error),
          };
          // A configured archive limit stops for the operator, who raises it
          // and continues (#1306): it needs a person, not a failure.
          const bounds = onlyCheckpointBoundsExceeded(error);
          if (bounds) {
            stop({
              ...observation,
              needsDecision: selected,
              error: `${bounds.fault.detail}. ${bounds.fault.fix}`,
            });
            return;
          }
          if (
            options.backgroundConfigurationPath &&
            terminal(readContinuation(config.repository, selected)) &&
            (error instanceof CheckpointProducerInventoryChanged ||
              isCheckpointAdmissionFailure(error))
          ) {
            // Retain the actual failure and local dispatch stop while status
            // and explicit recovery use the ordinary checkpoint barriers.
            // Historical acceptance and archive uncertainty stay unchanged.
            completedCheckpointFailure = observation;
            return;
          }
          stop(observation);
        } finally {
          active.delete(selected);
          signalWake();
        }
      })();
      runs.add(run);
      void run.finally(() => runs.delete(run));
    };
    try {
      for (;;) {
        // Local drain or handoff: active runs stop at their safe points.
        if (handingOff || localMode === "draining") {
          if (active.size) {
            await idle();
            continue;
          }
          return { ...record, mode: "draining" };
        }
        if (pendingMutations) {
          await controlTail;
          continue;
        }
        if (stopping) {
          if (active.size) {
            // A run held behind an overlapping Objective, perhaps the very one
            // that stopped, would wait forever: it hands off and stays queued.
            for (const [objective, control] of activeControls()) {
              if (yielded.has(objective)) continue;
              let held: ReturnType<typeof plannedExecutionConflict>;
              try {
                held = plannedExecutionConflict(
                  config,
                  readContinuation(config.repository, objective),
                );
              } catch {
                held = undefined;
              }
              if (!held) continue;
              yielded.add(objective);
              requeued.add(objective);
              void control({ objective, action: "handoff" }).catch(
                () => undefined,
              );
            }
            await idle();
            continue;
          }
          try {
            await applyControl(config, services.github, "pause");
          } catch {
            /* Local stop retains remote uncertainty. */
          }
          return { ...record, observation: stopping, mode: "paused" };
        }
        if (completedCheckpointFailure || finishing || active.size >= slots) {
          // A held owner serves authenticated control only: background polling
          // must not repeat the failed publication or create dispatch
          // authority. Full slots need no Project observation either.
          await idle();
          continue;
        }
        let observed: VerifiedQueueObservation | undefined;
        try {
          observed = await observeBackground();
          record = view(config, observed);
        } catch (error) {
          currentProcessSignal()?.throwIfAborted();
          assertProcessActive();
          if (error === observationPreempted) {
            // Keep the prior timestamp and contents for local status. A cancelled
            // observation grants no dispatch authority; the next poll is fresh.
            continue;
          }
          holdFor(error);
          record = view(config, undefined, error);
        }
        // A verified background owner remains available for explicit queue
        // control after restart; the actual draining mode never admits dispatch.
        // Local drain/handoff still ceases it through the branch above.
        if (
          record.complete &&
          record.mode === "draining" &&
          !options.backgroundConfigurationPath
        ) {
          if (active.size) {
            await idle();
            continue;
          }
          return record;
        }
        if (
          observed &&
          record.mode === "running" &&
          localMode !== "paused" &&
          pendingMutations === 0
        ) {
          const reasons: Record<string, string> = {};
          const selected: number[] = [];
          // With several slots, an unsettled claim of an Objective this
          // service does not run (a stopped run awaiting recovery) holds a
          // slot too: the next claim would refuse it.
          const claimed =
            slots > 1
              ? (locallyClaimedObjectives(config) ?? [])
              : ([] as number[]);
          for (const entry of observed.entries.filter(
            (entry) => entry.state === "queued",
          )) {
            if (active.size + selected.length >= slots) break;
            if (active.has(entry.objective)) continue;
            const held = new Set([...active.keys(), ...selected, ...claimed]);
            held.delete(entry.objective);
            if (held.size >= slots) {
              reasons[entry.objective] =
                `All ${slots} dispatch slots are held (${[...held].map((id) => `#${id}`).join(", ")})`;
              continue;
            }
            // Retired terminal history needs nothing and is never acted on (#1457).
            const read = readScannedContinuation(
              config.repository,
              entry.objective,
            );
            if (read === "history") continue;
            const state = read;
            if (terminal(state)) {
              // A split parent whose last child settle failed closes here; it
              // needs only local state and the parent's own provider.
              if (splitReadyToClose(config.repository, state))
                try {
                  const runtime = objectiveRuntime(entry.objective);
                  // Its children may be settling it concurrently: take its
                  // lock; a busy lock means one of them closes it.
                  await withObjectiveDelegation(lock, () =>
                    settleSplitParent({
                      config: runtime.config,
                      github: runtime.services.github,
                      parent: entry.objective,
                      lockParent: true,
                    }),
                  );
                } catch (error) {
                  reasons[entry.objective] =
                    `Closing the split Objective failed: ${error instanceof Error ? error.message : String(error)}`;
                }
              continue;
            }
            const card = observed.snapshot.cards.find(
              (candidate) => candidate.objective === entry.objective,
            )!;
            if (
              card.state !== "open" ||
              queueDigest(card.body) !== entry.bodyDigest
            ) {
              reasons[entry.objective] =
                "Issue is closed or its approved contents changed";
              continue;
            }
            if (state?.error || state?.cancelRequested) {
              reasons[entry.objective] =
                "Retained failure/cancellation requires supported recovery";
              break;
            }
            // A drain this service did not hand back itself (the operator's,
            // or one from before a restart) holds until resume: running it
            // would only idle in a slot (#1701).
            if (
              state?.coordinator?.mode === "draining" &&
              !requeued.has(entry.objective)
            ) {
              reasons[entry.objective] =
                `Coordinator is draining; run \`factory resume --objective ${entry.objective}\` to continue it`;
              continue;
            }
            // A planned Objective whose owned paths overlap an earlier active
            // one would only wait: the next queued Objective runs instead.
            const conflict =
              slots > 1 ? plannedExecutionConflict(config, state) : undefined;
            if (conflict) {
              reasons[entry.objective] = executionConflictDetail(conflict);
              continue;
            }
            try {
              if (!state) {
                if (!services.github.objectiveDependencies)
                  throw new Error("Native dependency observation unavailable");
                const predecessors = expandSplitPredecessors(
                  config.repository,
                  await services.github.objectiveDependencies(entry.objective),
                );
                const missing = predecessors.find((id) => {
                  const before = readContinuation(config.repository, id);
                  return (
                    !isExecutionState(before) ||
                    !objectiveComplete(before) ||
                    !before.finalAcceptance
                  );
                });
                if (missing) {
                  reasons[entry.objective] =
                    `Predecessor #${missing} has no accepted evidence`;
                  continue;
                }
                await resolveIntakeBase(
                  config,
                  services.github,
                  predecessors,
                  entry.objective,
                );
              }
              // Start readiness skips dequeued cards; one re-queued since
              // is checked here before it runs (#1650).
              if (options.backgroundConfigurationPath)
                checkServiceState(
                  queuedObjectiveConfig(
                    config,
                    entry.objective,
                    options.backgroundConfigurationPath,
                  ),
                  entry.objective,
                  options.backgroundConfigurationPath,
                );
              selected.push(entry.objective);
            } catch (error) {
              holdFor(error);
              reasons[entry.objective] = String(error);
            }
          }
          record.observation = {
            at: new Date().toISOString(),
            reasons,
            ...(!selected.length && !active.size
              ? {
                  idleReason: record.objectives.length
                    ? "waiting-for-eligible-work"
                    : "awaiting-approved-work",
                }
              : {}),
          };
          for (const objective of selected) {
            if (handingOff || localMode || pendingMutations) break;
            launch(objective, reasons);
          }
          if (selected.length) continue;
          if (
            !record.watch &&
            !active.size &&
            observed.entries.every(
              (entry) =>
                entry.state === "withdrawn" ||
                ((read) => read === "history" || terminal(read))(
                  readScannedContinuation(config.repository, entry.objective),
                ),
            )
          )
            return record;
        }
        await idle();
      }
    } finally {
      // The installation lease outlives every run it lent ownership to.
      while (runs.size) await Promise.allSettled([...runs]);
    }
  } finally {
    process.off("SIGTERM", onHandoff);
    await controlTail;
    try {
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
    } finally {
      releaseControllerLock(lockPath, lock);
      process.off("SIGUSR1", ignoreSignal);
    }
  }
}
/** Waking observation never creates dispatch authority. */
async function pauseObservation(
  pollMs: number,
  heldUntil: number,
  register: (wake: (() => void) | undefined) => void,
): Promise<void> {
  let woken = false;
  let wait = Math.max(pollMs, heldUntil - time.now());
  do {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        register(undefined);
        resolve();
      }, time.realDelay(wait));
      register(() => {
        clearTimeout(timer);
        register(undefined);
        woken = true;
        resolve();
      });
    });
    wait = heldUntil - time.now();
  } while (!woken && wait > 0);
}
