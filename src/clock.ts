import { setTimeout as realSleep } from "node:timers/promises";

/**
 * Factory's one clock for logical waits: backoff, polls, lag windows and
 * rate-limit gates.
 *
 * Waits that guard real processes (kill grace, process-group checks,
 * harness idle timeouts) and measured durations stay on real time.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** Logical now in epoch ms. */
export function now(): number {
  return Date.now();
}

/** Real milliseconds a logical wait of `milliseconds` takes. */
export function realDelay(milliseconds: number): number {
  return Math.min(Math.max(0, milliseconds), MAX_TIMER_MS);
}

/** Wait `milliseconds` of logical time; `signal` ends it with an AbortError. */
export function sleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return realSleep(
    realDelay(milliseconds),
    undefined,
    signal ? { signal } : undefined,
  );
}
