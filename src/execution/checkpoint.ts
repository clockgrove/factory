import { isDeepStrictEqual } from "node:util";
import { retainWorkerAccounting } from "../accounting.js";
import type {
  AgentSessionRef,
  ExecutionContext,
  ExecutionHandle,
  ExecutionOrphan,
  ExecutionResult,
  HarnessHandle,
  WorkerUsageObservation,
} from "../contracts.js";
import type { DiagnosticEmitter } from "../diagnostics.js";
import { awaitCheckpointAdmission } from "../recovery-checkpoint.js";
import type { WorkState } from "../state.js";

/** A runner's driver context: checkpoints, plus usage and possible orphans recorded as diagnostics. */
export function workerContext(
  work: WorkState,
  save: () => void,
  cancelled: () => boolean,
  diagnostics: DiagnosticEmitter | undefined,
  ids: {
    runId?: string;
    itemId: string;
    repository?: string;
    checkpointedEffects?: true;
    objective?: number;
    configDigest?: string;
  },
): ExecutionContext {
  const context = executionContext(
    work,
    save,
    cancelled,
    (workerUsage) => {
      const repository = ids.repository ?? diagnostics?.repositoryIdentity;
      const objective = ids.objective ?? diagnostics?.objectiveIdentity;
      if (repository && objective !== undefined) {
        try {
          retainWorkerAccounting(
            {
              repository,
              objective,
              runId: ids.runId ?? null,
              itemId: ids.itemId,
              attemptId: work.attempt ?? null,
              configDigest:
                ids.configDigest ?? diagnostics?.accountingConfigDigest ?? null,
            },
            workerUsage,
          );
        } catch {
          /* Mandatory retention gap is fenced by the checkpoint journal. */
        }
      }
      diagnostics?.emit({
        ...ids,
        attemptId: work.attempt,
        operation: "worker-usage",
        outcome: "observed",
        workerUsage,
      });
    },
    (orphan) =>
      diagnostics?.emit({
        ...ids,
        attemptId: work.attempt,
        operation: "possible-orphan",
        outcome: "observed",
        metadata: { resource: orphan.resource },
        detail: orphan.detail,
      }),
  );
  if (ids.checkpointedEffects) context.checkpointedEffects = true;
  if (ids.repository)
    context.admitEffect = (reason = "before-effect") =>
      awaitCheckpointAdmission(ids.repository!, reason);
  context.observeReadiness = (entry) =>
    diagnostics?.emit({
      ...ids,
      attemptId: work.attempt,
      operation: "environment-readiness-command",
      outcome: entry.passed ? "completed" : "failed",
      ...(!entry.passed && { formalFailure: true as const }),
      durationMs: entry.durationMs,
      metadata: {
        scope: "actual-worker-fresh-checkout",
        workerIdentity: entry.workerIdentity,
        validationIndex: entry.index,
        command: entry.command,
        exitCode: entry.exitCode,
        baseSha: entry.baseSha,
        treeSha: entry.treeSha,
        worktree: entry.worktree,
        source: entry.source,
      },
      detail: entry.output,
    });
  context.observeReadinessOffer = (entry) =>
    diagnostics?.emit({
      ...ids,
      attemptId: work.attempt,
      operation: "environment-readiness-offer",
      outcome: "observed",
      metadata: {
        ...entry,
        scope: "actual-worker-checkout-at-dispatch",
        actualReuse: "unobserved",
      },
    });
  return context;
}

/** Bind asynchronous provider checkpoints to the same owned Work Item attempt. */
export function executionContext(
  work: WorkState,
  save: () => void,
  cancelled: () => boolean = () => false,
  observeUsage?: (observation: WorkerUsageObservation) => void,
  observeOrphan?: (orphan: ExecutionOrphan) => void,
  repository?: string,
  checkpointedEffects?: true,
): ExecutionContext {
  const attempt = work.attempt;
  let previous = JSON.stringify(work.execution);
  return {
    ...(checkpointedEffects && { checkpointedEffects }),
    ...(repository && {
      admitEffect: (
        reason: "before-effect" | "settled" | "explicit" = "before-effect",
      ) => awaitCheckpointAdmission(repository, reason),
    }),
    cancelled,
    observeUsage,
    observeOrphan,
    checkpoint(handle: ExecutionHandle) {
      if (JSON.stringify(work.execution) !== previous)
        throw new Error(
          "Execution checkpoint was superseded by another lifecycle operation",
        );
      if (!attempt || work.attempt !== attempt)
        throw new Error("Execution checkpoint has a stale attempt owner");
      if (!handle.provider || !handle.identity)
        throw new Error(
          "Execution checkpoint requires a stable provider identity",
        );
      assertDurableValue(handle, "Execution checkpoint");
      if (
        work.execution &&
        (work.execution.provider !== handle.provider ||
          work.execution.identity !== handle.identity)
      )
        throw new Error("Execution checkpoint cannot replace an owned attempt");
      work.execution = structuredClone(handle);
      save();
      previous = JSON.stringify(work.execution);
    },
  };
}

export function assertDurableValue(
  value: unknown,
  name: string,
  seen = new Set<unknown>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} is not JSON-safe`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${name} is not JSON-safe`);
  if (seen.has(value)) throw new Error(`${name} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries())
        assertDurableValue(entry, `${name}[${index}]`, seen);
    } else {
      if (
        (Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length
      )
        throw new Error(`${name} must contain only JSON objects`);
      for (const [key, entry] of Object.entries(value))
        assertDurableValue(entry, `${name}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

/** The adapter's collected source-host worker receipt, not a foreign process observation. */
export function collectedLocalWorkerSessionSettled(
  execution: ExecutionHandle | undefined,
  ref: AgentSessionRef,
): boolean {
  if (
    execution?.provider !== "local" ||
    ref.scope.role !== "implementation" ||
    ref.status !== "ready" ||
    (ref.currentTurn !== undefined &&
      (ref.currentTurn.terminal !== "completed" ||
        ref.currentTurn.resources !== "settled")) ||
    ref.executionIdentity !== execution.identity
  )
    return false;
  const original = execution.data as
    | {
        result?: ExecutionResult;
        handle?: HarnessHandle;
      }
    | undefined;
  const native = ref.data as
    | {
        nativeEof?: unknown;
        workerSettled?: unknown;
        settled?: unknown;
        worker?: unknown;
      }
    | undefined;
  return (
    // Codex and Copilot receipts mark EOF and worker settlement; Claude
    // receipts mark one settled flag after native terminal verification.
    ((native?.nativeEof === true && native.workerSettled === true) ||
      native?.settled === true) &&
    ref.executionIdentity === original?.handle?.identity &&
    !!native.worker &&
    isDeepStrictEqual(native.worker, original?.handle?.data) &&
    isDeepStrictEqual(ref, original?.result?.session)
  );
}
