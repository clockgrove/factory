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
import { recordWorkerDiscovery } from "./graph-amendments.js";
import { cancelledFault } from "./fault.js";
import { executeItem } from "./item-steps.js";
import { selectedInputsForItem } from "./media.js";
import type { PhaseAdmission } from "./phase-admission.js";
import { preflightItemEnvironment } from "./qa-execution.js";
import type { FactoryState } from "./state.js";

interface ItemWorker {
  state: FactoryState;
  item: WorkItem;
  driver: ExecutionDriver;
  save: () => void;
  cancelled: () => boolean;
  diagnostics?: DiagnosticEmitter;
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
    });
  }
  // A reattached worker keeps the coding slot it holds while it runs remotely.
  if (work.phaseReservation !== "coding")
    await phases.reserve(item.id, "coding");
  const result = await executeItem({
    state,
    item,
    driver: args.driver,
    save: args.save,
    signal: args.signal,
    pause: args.pause,
    cancelled: args.cancelled,
    diagnostics: args.diagnostics,
    request: (attemptId) => ({
      captureContext: { objective: args.objective, runId: state.runId },
      item: work.recovery?.correction
        ? {
            ...item,
            brief: `${item.brief}\nDiagnosed repair: ${work.recovery.correction.diagnosis}\nRequired correction: ${work.recovery.correction.correction}`,
          }
        : item,
      baseSha,
      attemptId,
      objectiveBody: args.objectiveBody,
      selectedAssets: selectedInputsForItem(state, item),
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
  return result;
}

/** Stop the item's own worker after its attempt failed, so a retry never runs beside it. */
export async function stopWorker(args: ItemWorker): Promise<void> {
  const { state, item } = args;
  const work = state.work[item.id]!;
  if (!work.execution) return;
  try {
    await args.driver.cancel(
      structuredClone(work.execution),
      workerContext(work, args.save, args.cancelled, args.diagnostics, {
        runId: state.runId,
        itemId: item.id,
      }),
    );
    delete work.execution;
  } catch {
    // Left recorded: the next attempt starts only once the driver confirmed
    // the worker stopped.
  }
}
