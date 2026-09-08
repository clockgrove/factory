import type { ContinuousExecutionPool, ExecutionSettlement } from "./continuous-refill.js";
import type { ObjectiveFairness } from "./fairness.js";

export function progressWakeDelay(
  maximumMs: number,
  retryDeadlines: readonly number[],
  nowMs = Date.now(),
): number {
  if (!Number.isFinite(maximumMs) || maximumMs < 1) {
    throw new Error("progress wake maximum must be positive");
  }
  const future = retryDeadlines.filter((value) => Number.isFinite(value) && value > nowMs);
  const untilRetry = future.length === 0 ? maximumMs : Math.min(...future) - nowMs;
  return Math.max(1, Math.min(maximumMs, untilRetry));
}

/**
 * Wake for the first local completion, peer-capacity change, or bounded retry deadline.
 * Completed executions are queued by ContinuousExecutionPool, while the fairness revision
 * closes the change-before-listener race. The private abort only retires losing waiters.
 */
export async function waitForProgress<Key>(args: {
  executions: ContinuousExecutionPool<Key>;
  executionRevision?: number;
  fairness: ObjectiveFairness;
  fairnessRevision: number;
  maximumMs: number;
  retryDeadlines?: readonly number[];
  signal?: AbortSignal;
}): Promise<ExecutionSettlement<Key> | null> {
  const completed = args.executions.takeCompleted();
  if (completed) return completed;
  const timeoutMs = progressWakeDelay(args.maximumMs, args.retryDeadlines ?? []);
  const controller = new AbortController();
  const aborted = () => controller.abort();
  args.signal?.addEventListener("abort", aborted, { once: true });
  if (args.signal?.aborted) controller.abort();
  const execution = args.executions.waitForCompletion(
    timeoutMs,
    controller.signal,
    args.executionRevision,
  );
  const fairness = args.fairness
    .waitForChange(timeoutMs, controller.signal, args.fairnessRevision)
    .then(() => null);
  try {
    await Promise.race([execution, fairness]);
  } finally {
    controller.abort();
    await Promise.allSettled([execution, fairness]);
    args.signal?.removeEventListener("abort", aborted);
  }
  return args.executions.takeCompleted();
}
