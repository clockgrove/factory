import type {
  ExecutionContext,
  ExecutionHandle,
  WorkerUsageObservation,
} from "../contracts.js";
import type { WorkState } from "../state.js";

/** Bind asynchronous provider checkpoints to the same owned Work Item attempt. */
export function executionContext(
  work: WorkState,
  save: () => void,
  cancelled: () => boolean = () => false,
  observeUsage?: (observation: WorkerUsageObservation) => void,
): ExecutionContext {
  const attempt = work.attempt;
  let previous = JSON.stringify(work.execution);
  return {
    cancelled,
    observeUsage,
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
