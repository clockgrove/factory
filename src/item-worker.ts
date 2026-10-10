/**
 * The Work Item worker lifecycle both delivery runners share (#600): run the
 * item's worker to a collected result, and stop it after a failed attempt.
 */
import type { FactoryConfig } from "./config.js";
import type {
  ContentStore,
  ExecutionDriver,
  ExecutionResult,
  WorkItem,
} from "./contracts.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { workerContext } from "./execution/checkpoint.js";
import { cancelledFault } from "./fault.js";
import {
  assertGraphRevisions,
  graphDigest,
  recordWorkerDiscovery,
} from "./graph-amendments.js";
import { isDeepStrictEqual } from "node:util";
import { executeItem } from "./item-steps.js";
import { selectedInputsForItem, validationLfsMembersForItem } from "./media.js";
import { packageManagerUpdate } from "./package-manager-update.js";
import { acceptedPlanningDecisionContext } from "./planning-decision-context.js";
import type { PhaseAdmission } from "./phase-admission.js";
import { environmentValidationIndices } from "./qa.js";
import { preflightItemEnvironment } from "./qa-execution.js";
import {
  type WorkRecovery,
  retainedFailedResultContext,
} from "./repair-policy.js";
import type { FactoryState } from "./state.js";
import { workspacePackageAdditions } from "./workspace-membership.js";
import { agentSessionContinuation } from "./agent-session.js";
import {
  objectiveKnowledgeView,
  publishObjectiveKnowledge,
} from "./objective-knowledge.js";

interface ItemWorker {
  state: FactoryState;
  item: WorkItem;
  driver: ExecutionDriver;
  save: () => void;
  cancelled: () => boolean;
  diagnostics?: DiagnosticEmitter;
}

/**
 * The item as the new attempt sees it. A failed earlier attempt's recorded
 * failure (it carries the worker's final response, when there was one) and an
 * accepted correction go into the brief, so the worker does not repeat it.
 */
function attemptItem(item: WorkItem, recovery?: WorkRecovery): WorkItem {
  const failure = recovery?.failure;
  const correction = recovery?.correction;
  if (!failure && !correction) return item;
  const previous = failure
    ? `\nThe previous attempt failed. Do not repeat it: ${failure.detail}`
    : "";
  const repair = correction
    ? `\nDiagnosed repair: ${correction.diagnosis}\nRequired correction: ${correction.correction}`
    : "";
  return { ...item, brief: `${item.brief}${previous}${repair}` };
}

/** The normal worker receives planned peers, not their briefs or result receipts. */
export function workerAttemptItem(
  state: FactoryState,
  item: WorkItem,
  baseSha: string,
  knowledge?: object,
): WorkItem {
  assertGraphRevisions(state);
  if (
    state.graph.objective !== state.objective ||
    state.graph.baseSha !== state.baseSha ||
    !isDeepStrictEqual(
      state.graph.items.find((candidate) => candidate.id === item.id),
      item,
    )
  )
    throw new Error("Worker planned peer context differs from accepted graph");
  const attempted = attemptItem(item, state.work[item.id]?.recovery);
  const context = {
    objective: state.objective,
    acceptedGraphDigest: graphDigest(state.graph),
    objectiveBaseCommitSha: state.baseSha,
    workerExecutionBaseCommitSha: baseSha,
    currentItemId: item.id,
    peers: state.graph.items
      .filter((peer) => peer.id !== item.id)
      .map((peer) => ({
        id: peer.id,
        goal: peer.goal,
        kind: peer.kind ?? "work",
        dependencies: peer.dependencies,
        ownedPaths: peer.ownedPaths,
      })),
  };
  return {
    ...attempted,
    brief: `${attempted.brief}\nController-bound accepted planned peer context (design only): ${JSON.stringify(context)}\nPeers' planned outputs can be absent from this isolated execution base. Absence here alone does not establish additional work when that output is already assigned to a peer; preserve the component's phase and leave combined proof to its accepted downstream owner. This plan proves no peer implementation, validation, delivery, integration or acceptance and grants no new ownership, dependency, command or permission. Report genuine additional gaps with their observed base and relevant planned owner; do not infer either completion or a defect from the plan alone.\nController-bound human planning decision context: ${JSON.stringify(acceptedPlanningDecisionContext(state))}${knowledge ? `\nController-bound Objective knowledge view: ${JSON.stringify(knowledge)}` : ""}`,
  };
}

/**
 * Run the item's worker on `baseSha`. The collected result is recorded on the
 * item (discovery, change ref, tree); the caller decides what happens to the
 * worker handle and what step follows.
 */
export async function runWorker(
  args: ItemWorker & {
    config: FactoryConfig;
    root: string;
    objective: number;
    objectiveBody?: string;
    store: ContentStore;
    phases: PhaseAdmission;
    signal?: AbortSignal;
    pause?: AbortSignal;
    baseSha: string;
  },
): Promise<ExecutionResult> {
  const { state, item, phases, baseSha } = args;
  const work = state.work[item.id]!;
  const retained = work.recovery?.correction
    ? retainedFailedResultContext(work.recovery.history?.at(-1))
    : undefined;
  const readinessIndices = environmentValidationIndices(state.graph, item.id);
  if (readinessIndices.length && args.driver.freshCheckoutReadiness !== true)
    throw new Error(
      "Worker driver cannot authenticate readiness in its actual fresh environment; source decision required",
    );
  if (!work.execution) {
    await phases.reserve(item.id, "validation");
    await preflightItemEnvironment({
      config: args.config,
      root: args.root,
      state,
      objectiveBody: args.objectiveBody,
      item,
      store: args.store,
      baseSha,
      diagnostics: args.diagnostics,
    });
  }
  // A reattached worker keeps the coding slot it holds while it runs remotely.
  if (work.phaseReservation !== "coding")
    await phases.reserve(item.id, "coding");
  const attemptedItem = workerAttemptItem(
    state,
    item,
    baseSha,
    objectiveKnowledgeView(state, item, args.config.checkout, baseSha),
  );
  const session =
    args.driver.sessionContinuation === true
      ? agentSessionContinuation(state, "implementation", item.id, args.save)
      : undefined;
  if (
    work.recovery?.correction &&
    (!retained || args.driver.retainedFailedResultContext !== true)
  )
    attemptedItem.brief +=
      "\nRetained failed committed-result context is unavailable for this repair through this execution driver; no prior source availability is implied.";
  const result = await executeItem({
    state,
    item,
    driver: args.driver,
    save: args.save,
    signal: args.signal,
    pause: args.pause,
    cancelled: args.cancelled,
    diagnostics: args.diagnostics,
    ...(session ? { session } : {}),
    request: (attemptId) => ({
      ...(session
        ? {
            session: {
              scope: session.scope,
              identity: session.identity,
              ...(session.retained ? { retained: session.retained } : {}),
            },
          }
        : {}),
      captureContext: { objective: args.objective, runId: state.runId },
      item: attemptedItem,
      ...(retained && args.driver.retainedFailedResultContext === true
        ? { retainedFailedResult: retained }
        : {}),
      baseSha,
      attemptId,
      objectiveBody: args.objectiveBody,
      selectedAssets: selectedInputsForItem(state, item),
      ...(readinessIndices.length
        ? {
            environmentReadiness: {
              validationIndices: readinessIndices,
              acceptedBaseSha: state.baseSha,
              lfsMembers: validationLfsMembersForItem(
                state,
                item,
                args.config.checkout,
                baseSha,
              ),
              workspacePackageAdditions: workspacePackageAdditions(
                args.objectiveBody ?? "",
              ),
              ...(packageManagerUpdate(args.objectiveBody ?? "")
                ? {
                    packageManagerUpdate: packageManagerUpdate(
                      args.objectiveBody ?? "",
                    ),
                  }
                : {}),
            },
          }
        : {}),
    }),
  });
  phases.release(item.id);
  if (result.collection)
    args.diagnostics?.emit({
      runId: state.runId,
      itemId: item.id,
      attemptId: work.attempt,
      operation: "collection-ignored-links",
      outcome: "completed",
      metadata: {
        observation: "original-worktree-scan",
        acceptedIgnoredLinkCount: result.collection.acceptedIgnoredLinks.length,
        treeSha: result.treeSha,
        headSha: result.changeRef,
      },
      detail: JSON.stringify(result.collection),
    });
  if (args.signal?.aborted || args.cancelled()) throw cancelledFault();
  // The collected result is recorded once.
  recordWorkerDiscovery(state, item.id, result.discovery);
  work.changeRef = result.changeRef;
  work.treeSha = result.treeSha;
  await publishObjectiveKnowledge(state, item, result, args.store);
  args.save();
  return result;
}

/** Stop the item's own worker after its attempt failed, so a retry never runs beside it. */
export async function stopWorker(args: ItemWorker): Promise<void> {
  const { state, item } = args;
  const work = state.work[item.id]!;
  if (!work.execution) return;
  try {
    const session =
      args.driver.sessionContinuation === true
        ? agentSessionContinuation(state, "implementation", item.id, args.save)
        : undefined;
    const context = workerContext(
      work,
      args.save,
      args.cancelled,
      args.diagnostics,
      {
        runId: state.runId,
        itemId: item.id,
      },
    );
    if (session) context.checkpointSession = (ref) => session.checkpoint(ref);
    const stoppedIdentity = work.execution.identity;
    await args.driver.cancel(structuredClone(work.execution), context);
    // Successful cancellation proves owned cessation, but an unfinished turn
    // supplies no resumable conversation. Preserve any ready receipt the driver settled.
    if (
      session?.retained?.status === "in-flight" &&
      session.retained.executionIdentity === stoppedIdentity
    )
      session.checkpoint({ ...session.retained, status: "unavailable" });
    delete work.execution;
  } catch {
    // Left recorded: the next attempt starts only once the driver confirmed
    // the worker stopped.
  }
}
