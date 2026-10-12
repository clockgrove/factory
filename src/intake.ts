import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as time from "./clock.js";
import { objectiveComplete } from "./completion.js";
import {
  type FactoryConfig,
  factoryAuthorityDigest,
  factoryConfigDigest,
  stateRoot,
} from "./config.js";
import type { GitHubGateway } from "./contracts.js";
import {
  type ControlRequest,
  type ControlContext,
  ControllerCommandIncompleteError,
  ForegroundControllerError,
  requestControl,
  serveControl,
} from "./coordinator-control.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import { attachedFault } from "./fault.js";
import { RealGitHubGateway } from "./github.js";
import { planningPrerequisites } from "./objective-prerequisites.js";
import {
  currentProcessSignal,
  assertProcessActive,
  fetchHead,
  git,
  gitAsync,
  withProcessCancellation,
} from "./process.js";
import {
  completeQueueOperation,
  createQueueOperation,
  observeProjectQueue,
  parseQueueMetadata,
  performQueueEffect,
  type QueueMetadata,
  type QueueMode,
  type QueueOperation,
  queueDigest,
  readQueueHistory,
  requireProjectQueueEffects,
  verifyQueueObservation,
  type VerifiedQueueObservation,
} from "./project-queue-state.js";
import {
  awaitCheckpointAdmission,
  acceptForwardedCheckpointCompletion,
  gitPersistenceStatus,
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
  runObjective,
} from "./runner.js";
import { type ContinuationState, isExecutionState } from "./state.js";
import {
  acquireInstallationLock,
  readContinuation,
  releaseControllerLock,
  retargetControllerLock,
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
  legacyLocalQueueIgnored?: true;
  observation?: {
    at: string;
    reasons: Record<string, string>;
    error?: string;
    needsDecision?: number;
    idleReason?: "awaiting-approved-work" | "waiting-for-eligible-work";
    unapproved?: number[];
  };
}
export const DEFAULT_QUEUE_POLL_SECONDS = 30;
export const QUEUE_COMMAND_TIMEOUT_MS = 10_000;
const commandScopes = new AsyncLocalStorage<{
  deadlineAt: number;
  onAcknowledgment?: (value: unknown) => void;
}>();
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
    return await commandScopes.run({ deadlineAt, onAcknowledgment }, () =>
      withProcessCancellation(
        signal,
        task,
        undefined,
        new Date(deadlineAt).toISOString(),
      ),
    );
  } catch (error) {
    if (
      !(error instanceof ControllerCommandIncompleteError) &&
      Date.now() >= deadlineAt
    )
      throw new ControllerCommandIncompleteError(
        undefined,
        "unknown",
        deadlineAt,
        error,
      );
    throw error;
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
  return github.withProjectQueueObservation
    ? github.withProjectQueueObservation(
        requireProjectQueueEffects(config),
        task,
      )
    : task();
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
    configDigest: factoryConfigDigest(config),
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
    ...(existsSync(join(stateRoot(config.repository), "intake.json"))
      ? { legacyLocalQueueIgnored: true }
      : {}),
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
/** Missing receipts hold execution; legacy file bytes are never parsed. */
export async function readIntake(
  config: FactoryConfig,
  options: { anyConfiguration?: boolean; github?: GitHubGateway } = {},
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
      (isExecutionState(state) && objectiveComplete(state)))
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
  const directory = join(stateRoot(config.repository), "objectives");
  return (
    existsSync(directory)
      ? readdirSync(directory)
          .filter((name) => /^\d+$/.test(name))
          .map((name) => readContinuation(config.repository, Number(name)))
          .filter(Boolean)
      : []
  ).every(terminal);
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
async function mutationSnapshot(config: FactoryConfig, github: GitHubGateway) {
  const binding = requireProjectQueueEffects(config);
  if (!github.projectQueueRead)
    throw new Error("GitHub gateway cannot read Project queue metadata");
  await awaitCheckpointAdmission(config.repository, "explicit");
  const snapshot = await github.projectQueueRead(binding);
  const history = await readQueueHistory(config);
  if (
    history.some(
      (record) =>
        record.kind === "project-queue-operation" && !record.completed,
    )
  )
    throw new Error(
      "A previous Project queue operation remains partial or unknown; no mutation replay is allowed",
    );
  return { snapshot, history };
}
/** Authenticate the owner's protocol before sending any admission-changing action. */
async function projectControlRequest(
  config: FactoryConfig,
  operation: "enqueue" | "watch" | "pause" | "resume" | "drain" | "dequeue",
  input?: Record<string, unknown>,
) {
  const scope = commandScopes.getStore();
  const deadlineAt = scope?.deadlineAt ?? Date.now() + QUEUE_COMMAND_TIMEOUT_MS;
  const observed = await requestControl(
    config.repository,
    {
      objective: 0,
      action: "status",
    },
    { deadlineAt },
  );
  if (!observed.handled) return observed;
  if (
    !observed.result ||
    typeof observed.result !== "object" ||
    !("queueProtocol" in observed.result) ||
    observed.result.queueProtocol !== "project-queue-v1"
  ) {
    if (operation === "pause" || operation === "drain")
      return requestControl(
        config.repository,
        {
          objective: 0,
          action: operation,
        },
        { deadlineAt },
      );
    throw new Error(
      "The existing service uses the retired local queue protocol; hand it off through factory supervisor stop, then set up the Project-bound installation. No admission was sent to that owner",
    );
  }
  const request: ControlRequest = {
    objective: 0,
    action: "project-queue",
    input: {
      ...input,
      operation,
      protocol: "project-queue-v1",
      authorityDigest: factoryAuthorityDigest(config),
      configDigest: factoryConfigDigest(config),
    },
    command: { id: randomUUID(), deadlineAt },
  };
  const reply = await requestControl(config.repository, request, {
    deadlineAt,
    onAcknowledgment: scope?.onAcknowledgment,
  });
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
async function writeControl(
  config: FactoryConfig,
  github: GitHubGateway,
  mode: QueueMode,
  watch?: boolean,
  approval: QueueOperation["approval"] = { kind: "queue-command" },
  prepared?: Awaited<ReturnType<typeof mutationSnapshot>>,
): Promise<void> {
  // Only the caller's fresh pair in this locked operation, before its first
  // effect, can be reused. No observation survives into a later operation.
  const { snapshot, history } =
    prepared ?? (await mutationSnapshot(config, github));
  const previous =
    snapshot.control.metadata === null
      ? undefined
      : parseQueueMetadata(snapshot.control.metadata);
  if (previous && previous.kind !== "control")
    throw new Error("Bound Project control metadata is invalid");
  if (previous) verifyQueueObservation(config, snapshot, history, true);
  const watching =
    watch ?? (previous?.kind === "control" ? previous.watch : false);
  if (
    previous?.kind === "control" &&
    previous.mode === mode &&
    previous.watch === watching &&
    history.some(
      (record) =>
        record.id === previous.receiptId &&
        record.authorityDigest === factoryAuthorityDigest(config),
    )
  )
    return;
  if (
    !previous &&
    history.some(
      (record) =>
        record.kind === "project-queue-operation" && record.scope === "control",
    )
  )
    throw new Error(
      "Project control was cleared after an earlier receipt; supported reconciliation is required",
    );
  assertProcessActive();
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
  await performQueueEffect(config, github, operation, {
    action: "set-metadata",
    itemId: snapshot.control.itemId,
    metadata: operation.metadata,
  });
  await completeQueueOperation(config, operation);
}
export interface EnqueueOptions {
  expectedBodyDigests?: Record<string, string>;
}
export interface ProjectPublicationProvenance {
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
): Promise<IntakeAuthorization> {
  return projectMutation(config, github, () =>
    enqueueMutation(config, github, objectives, options),
  );
}
async function enqueueMutation(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  options: EnqueueOptions,
): Promise<IntakeAuthorization> {
  validateObjectives(objectives);
  checkRequiredEnvironment(config);
  const initialized = await mutationSnapshot(config, github);
  if (initialized.snapshot.control.metadata === null)
    await writeControl(
      config,
      github,
      "running",
      undefined,
      undefined,
      initialized,
    );
  else {
    const previousControl = parseQueueMetadata(
      initialized.snapshot.control.metadata,
    );
    if (previousControl.kind !== "control")
      throw new Error("Invalid Project queue control role");
    await writeControl(
      config,
      github,
      previousControl.mode,
      previousControl.watch,
      undefined,
      initialized,
    );
  }
  for (const objective of objectives) {
    assertProcessActive();
    const observed = await observeProjectQueue(
      config,
      github,
      "explicit-operation",
    );
    if (observed.control.mode === "draining")
      throw new Error(
        "The queue is draining; use `factory queue resume` before adding work",
      );
    const issue = await github.objective(objective);
    if (!issue.nodeId || issue.state !== "open")
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
    const previous = observed.entries.find(
      (entry) => entry.objective === objective,
    );
    if (
      previous?.state === "queued" &&
      previous.bodyDigest === bodyDigest &&
      previous.authorityDigest === factoryAuthorityDigest(config)
    )
      continue;
    const existing = readContinuation(config.repository, objective);
    if (existing && !terminal(existing) && previous?.bodyDigest !== bodyDigest)
      throw new Error(
        "Unfinished approved contents cannot be replaced by requeueing; use supported recovery",
      );
    if (
      observed.history.some(
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
      previous?.order ??
      Math.max(0, ...observed.entries.map((entry) => entry.order)) + 1;
    if (!Number.isSafeInteger(order))
      throw new Error("Project order exhausted its exact integer range");
    assertProcessActive();
    const operation = createQueueOperation(config, {
      action: "admit",
      scope: issue.nodeId,
      previousReceiptId: previous?.receiptId ?? null,
      approval: { kind: "queue-command" },
      objective,
      issueNodeId: issue.nodeId,
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
    const ensured = await performQueueEffect(config, github, operation, {
      action: "ensure-card",
      issueNodeId: issue.nodeId,
    });
    await performQueueEffect(config, github, operation, {
      action: "set-order",
      itemId: ensured.itemId,
      order,
    });
    await performQueueEffect(config, github, operation, {
      action: "set-metadata",
      itemId: ensured.itemId,
      metadata: operation.metadata,
    });
    await completeQueueOperation(config, operation);
  }
  return (await readIntake(config, { github }))!;
}
export async function enqueueIntake(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  options: EnqueueOptions = {},
): Promise<IntakeAuthorization> {
  return queueOperation(config, () =>
    enqueueIntakeCommand(config, github, objectives, options),
  );
}
async function enqueueIntakeCommand(
  config: FactoryConfig,
  github: GitHubGateway,
  objectives: number[],
  options: EnqueueOptions,
): Promise<IntakeAuthorization> {
  const reply = await projectControlRequest(config, "enqueue", {
    objectives,
    ...options,
  });
  if (reply.handled) return reply.result as IntakeAuthorization;
  return locked(config, () =>
    enqueueOwned(config, github, objectives, options),
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
): Promise<void> {
  return projectMutation(config, github, () =>
    ensureProjectObjectiveMutation(config, github, objective, provenance),
  );
}
async function ensureProjectObjectiveMutation(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  provenance?: ProjectPublicationProvenance,
): Promise<void> {
  await mutationSnapshot(config, github);
  const issue = await github.objective(objective);
  if (!issue.nodeId)
    throw new Error(
      "Project publication requires authenticated Issue identity",
    );
  const bodyDigest = queueDigest(issue.body);
  if (provenance?.bodyDigest && provenance.bodyDigest !== bodyDigest)
    throw new Error(
      "Published contents changed before Project card publication",
    );
  assertProcessActive();
  const operation = createQueueOperation(config, {
    action: "roadmap",
    scope: `roadmap:${issue.nodeId}`,
    previousReceiptId: null,
    approval: provenance
      ? {
          kind: "proposal",
          proposalId: provenance.proposalId,
          approvalDigest: provenance.approvalDigest,
        }
      : { kind: "queue-command" },
    objective,
    issueNodeId: issue.nodeId,
    bodyDigest,
  });
  await performQueueEffect(config, github, operation, {
    action: "ensure-card",
    issueNodeId: issue.nodeId,
  });
  await completeQueueOperation(config, operation);
}
export async function watchIntake(
  config: FactoryConfig,
  github: GitHubGateway = defaultGateway(config),
): Promise<IntakeAuthorization> {
  return queueOperation(config, () => watchIntakeCommand(config, github));
}
async function watchIntakeCommand(
  config: FactoryConfig,
  github: GitHubGateway,
): Promise<IntakeAuthorization> {
  const reply = await projectControlRequest(config, "watch");
  if (reply.handled) return reply.result as IntakeAuthorization;
  return locked(config, () =>
    projectMutation(config, github, async () => {
      const prepared = await mutationSnapshot(config, github);
      const { snapshot } = prepared;
      const previous =
        snapshot.control.metadata === null
          ? undefined
          : parseQueueMetadata(snapshot.control.metadata);
      await writeControl(
        config,
        github,
        previous?.kind === "control" ? previous.mode : "running",
        true,
        { kind: "background-setup" },
        prepared,
      );
      return view(config, await observeProjectQueue(config, github));
    }),
  );
}
async function applyControl(
  config: FactoryConfig,
  github: GitHubGateway,
  action: string,
  objective?: number,
): Promise<IntakeAuthorization> {
  const task = () => applyControlOwned(config, github, action, objective);
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
  objective?: number,
): Promise<IntakeAuthorization> {
  return projectMutation(config, github, () =>
    applyControlMutation(config, github, action, objective),
  );
}
async function applyControlMutation(
  config: FactoryConfig,
  github: GitHubGateway,
  action: string,
  objective?: number,
): Promise<IntakeAuthorization> {
  const controlAction = ["pause", "resume", "drain", "handoff"].includes(
    action,
  );
  const prepared = controlAction
    ? await mutationSnapshot(config, github)
    : undefined;
  const observed = prepared
    ? verifyQueueObservation(config, prepared.snapshot, prepared.history, true)
    : await observeProjectQueue(config, github, "explicit-operation");
  if (action === "dequeue") {
    const entry = observed.entries.find(
      (candidate) =>
        candidate.objective === objective && candidate.state === "queued",
    );
    if (!entry) throw new Error(`Objective #${objective} is not admitted`);
    const state = readContinuation(config.repository, entry.objective);
    if (
      (state && !terminal(state)) ||
      observed.history.some(
        (record) =>
          record.kind === "project-queue-owner" &&
          record.objective === entry.objective &&
          !record.settled,
      )
    )
      throw new Error(
        `Objective #${objective} has unfinished owned work; use supported cancellation before removal`,
      );
    assertProcessActive();
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
    await performQueueEffect(config, github, operation, {
      action: "set-metadata",
      itemId: entry.itemId,
      metadata: operation.metadata,
    });
    await completeQueueOperation(config, operation);
  } else if (controlAction)
    await writeControl(
      config,
      github,
      action === "pause"
        ? "paused"
        : action === "resume"
          ? "running"
          : "draining",
      undefined,
      undefined,
      prepared,
    );
  else if (action !== "status" && action !== "sync")
    throw new Error("Unsupported queue action");
  return view(config, await observeProjectQueue(config, github));
}
export async function intakeControl(
  config: FactoryConfig,
  action: "status" | "sync" | "pause" | "resume" | "drain" | "dequeue",
  objective?: number,
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
  objective: number | undefined,
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
            objective ? { objective } : undefined,
          );
  } catch (error) {
    if (action !== "status" || !(error instanceof ForegroundControllerError))
      throw error;
    return {
      ...(await readIntake(config, { github })),
      activeObjective: error.objective,
    };
  }
  if (reply.handled) {
    if (
      action === "status" &&
      (!reply.result ||
        typeof reply.result !== "object" ||
        !("queueProtocol" in reply.result) ||
        reply.result.queueProtocol !== "project-queue-v1")
    )
      return { ...(await readIntake(config, { github })), legacyOwner: true };
    return reply.result;
  }
  if (action === "status") return readIntake(config, { github });
  return locked(config, () => applyControl(config, github, action, objective));
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
async function resolveBase(
  config: FactoryConfig,
  github: GitHubGateway,
  predecessors: number[],
  objective: number,
): Promise<void> {
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
export function runIntake(
  config: FactoryConfig,
  services: ApplicationServices,
): Promise<IntakeAuthorization> {
  return withRecoveryCheckpointControllerVerification(
    { config, buildClosure: () => buildRecoveryCheckpointClosure({ config }) },
    () => runIntakeOwned(config, services),
  );
}
async function runIntakeOwned(
  config: FactoryConfig,
  services: ApplicationServices,
): Promise<IntakeAuthorization> {
  requireProjectQueueEffects(config);
  let record = view(config);
  const lockPath = join(stateRoot(config.repository), "controller.lock"),
    lock = acquireInstallationLock(config.repository);
  let server: Awaited<ReturnType<typeof serveControl>> | undefined;
  let activeObjective: number | undefined;
  let objectiveControl:
    | ((request: ControlRequest) => Promise<unknown>)
    | undefined;
  let handingOff = false;
  let localMode: QueueMode | undefined;
  let wake: (() => void) | undefined;
  let wakePending = false;
  const signalWake = () => {
    wakePending = true;
    wake?.();
  };
  let heldUntil = 0;
  let controlTail: Promise<unknown> = Promise.resolve();
  let pendingMutations = 0;
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
    if (activeObjective && objectiveControl)
      void objectiveControl({
        objective: activeObjective,
        action: "handoff",
      }).catch(() => undefined);
    signalWake();
  };
  const authenticateQueueRequest = (
    request: ControlRequest,
  ): ControlRequest => {
    if (request.action === "project-queue") {
      const operation = request.input?.operation;
      if (
        request.objective !== 0 ||
        request.input?.protocol !== "project-queue-v1" ||
        request.input?.authorityDigest !== factoryAuthorityDigest(config) ||
        request.input?.configDigest !== factoryConfigDigest(config) ||
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
      request = { ...request, action: operation as ControlRequest["action"] };
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
    activeObjective: activeObjective ?? null,
    ...(localMode ? { localMode } : {}),
    pendingMutations,
  });
  const handleOwned = async (request: ControlRequest): Promise<unknown> => {
    if (request.objective !== 0) {
      if (request.objective === activeObjective && objectiveControl)
        return objectiveControl(request);
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
    if (request.action === "enqueue") {
      if (handingOff || localMode === "draining")
        throw new Error("The local service is draining");
      const ids = request.input?.objectives as number[];
      if (request.input?.roadmapOnly) {
        validateObjectives(ids);
        for (const id of ids)
          await ensureProjectObjectiveOwned(
            config,
            services.github,
            id,
            request.input?.provenance as
              | ProjectPublicationProvenance
              | undefined,
          );
        record = view(
          config,
          await observeProjectQueue(config, services.github),
        );
      } else
        record = await enqueueOwned(config, services.github, ids, {
          expectedBodyDigests: request.input?.expectedBodyDigests as
            | Record<string, string>
            | undefined,
        });
    } else if (request.action === "watch") {
      record = await projectMutation(config, services.github, async () => {
        const prepared = await mutationSnapshot(config, services.github);
        const observed = verifyQueueObservation(
          config,
          prepared.snapshot,
          prepared.history,
        );
        await writeControl(
          config,
          services.github,
          observed.control.mode,
          true,
          { kind: "background-setup" },
          prepared,
        );
        return view(config, await observeProjectQueue(config, services.github));
      });
    } else {
      try {
        record = await applyControl(
          config,
          services.github,
          request.action,
          Number(request.input?.objective) || undefined,
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
      if (request.action === "resume") {
        if (activeObjective && objectiveControl)
          await objectiveControl({
            objective: activeObjective,
            action: "resume",
          });
      }
    }
    signalWake();
    return { ...record, activeObjective: activeObjective ?? null };
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
    if (
      request.objective === 0 &&
      ["pause", "drain", "handoff"].includes(request.action)
    ) {
      localMode = request.action === "pause" ? "paused" : "draining";
      if (request.action === "handoff") handingOff = true;
      // The existing Objective handler sets its dispatch stop synchronously
      // before its returned promise. Retain already admitted work, and await
      // the same requested transition as part of this bounded command.
      if (activeObjective && objectiveControl)
        localCessation = objectiveControl({
          objective: activeObjective,
          action: request.action,
        }).then(
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
        if (request.objective === 0 && request.action === "resume")
          localMode = undefined;
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
  process.on("SIGTERM", onHandoff);
  try {
    retargetControllerLock(lockPath, lock, 0);
    // Cold preparation owns the existing lease and exposes no readiness or
    // dispatch until the controller's remote-only verifier is authenticated.
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
    }
    record = view(config, await observeProjectQueue(config, services.github));
    server = await serveControl(config.repository, lock, handle);
    for (;;) {
      if (handingOff || localMode === "draining")
        return { ...record, mode: "draining" };
      let observed: VerifiedQueueObservation | undefined;
      try {
        observed = await observeProjectQueue(config, services.github);
        record = view(config, observed);
      } catch (error) {
        holdFor(error);
        record = view(config, undefined, error);
      }
      if (record.complete && record.mode === "draining") return record;
      if (
        observed &&
        record.mode === "running" &&
        localMode !== "paused" &&
        pendingMutations === 0
      ) {
        const reasons: Record<string, string> = {};
        let selected: number | undefined;
        for (const entry of observed.entries.filter(
          (entry) => entry.state === "queued",
        )) {
          const state = readContinuation(config.repository, entry.objective);
          if (terminal(state)) continue;
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
          try {
            if (!state) {
              if (!services.github.objectiveDependencies)
                throw new Error("Native dependency observation unavailable");
              const predecessors = await services.github.objectiveDependencies(
                entry.objective,
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
              await resolveBase(
                config,
                services.github,
                predecessors,
                entry.objective,
              );
            }
            selected = entry.objective;
            break;
          } catch (error) {
            holdFor(error);
            reasons[entry.objective] = String(error);
          }
        }
        record.observation = {
          at: new Date().toISOString(),
          reasons,
          ...(!selected
            ? {
                idleReason: record.objectives.length
                  ? "waiting-for-eligible-work"
                  : "awaiting-approved-work",
              }
            : {}),
        };
        if (selected) {
          activeObjective = selected;
          retargetControllerLock(lockPath, lock, selected);
          try {
            if (handingOff || localMode || pendingMutations) continue;
            const result = await runObjective(config, selected, services, {
              ownerLock: lock,
              observeControl: async (handler) => {
                objectiveControl = handler;
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
            });
            if (!terminal(result)) {
              localMode = "paused";
              record.observation = {
                at: new Date().toISOString(),
                reasons,
                needsDecision: selected,
                error:
                  result.coordinator?.waitReason ??
                  "Inspect retained Objective status",
              };
              try {
                await applyControl(config, services.github, "pause");
              } catch {
                /* Local stop retains remote uncertainty. */
              }
              return { ...record, mode: "paused" };
            }
          } catch (error) {
            if (error instanceof CoordinatorHandoff) {
              handingOff = true;
              return { ...record, mode: "draining" };
            }
            localMode = "paused";
            record.observation = {
              at: new Date().toISOString(),
              reasons,
              error: String(error),
            };
            try {
              await applyControl(config, services.github, "pause");
            } catch {
              /* No replay or fallback authority. */
            }
            return { ...record, mode: "paused" };
          } finally {
            objectiveControl = undefined;
            activeObjective = undefined;
            retargetControllerLock(lockPath, lock, 0);
          }
          continue;
        }
        if (
          !record.watch &&
          observed.entries.every(
            (entry) =>
              entry.state === "withdrawn" ||
              terminal(readContinuation(config.repository, entry.objective)),
          )
        )
          return record;
      }
      await pauseObservation(
        queuePollSeconds(config) * 1000,
        heldUntil,
        (handler) => {
          wake = handler;
          if (handler && wakePending) {
            wakePending = false;
            handler();
          }
        },
      );
    }
  } finally {
    process.off("SIGTERM", onHandoff);
    await controlTail;
    try {
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
    } finally {
      releaseControllerLock(lockPath, lock);
    }
  }
}
/** Waking observation never creates dispatch authority. */
export async function pauseObservation(
  pollMs: number,
  heldUntil: number,
  register: (wake: (() => void) | undefined) => void,
  clock: { now: () => number; realDelay: (ms: number) => number } = time,
): Promise<void> {
  let woken = false;
  let wait = Math.max(pollMs, heldUntil - clock.now());
  do {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        register(undefined);
        resolve();
      }, clock.realDelay(wait));
      register(() => {
        clearTimeout(timer);
        register(undefined);
        woken = true;
        resolve();
      });
    });
    wait = heldUntil - clock.now();
  } while (!woken && wait > 0);
}
