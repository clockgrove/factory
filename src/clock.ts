import { setTimeout as realSleep } from "node:timers/promises";

/**
 * Factory's one clock for logical waits: backoff, polls, lag windows and
 * rate-limit gates. Tests compress it with FACTORY_TIME_SCALE (read once;
 * production never sets it), so a 30 s poll takes 0.3 s at scale 100.
 * FACTORY_TIME_ORIGIN (epoch ms) lets every process of one test run share
 * one timeline, so times one process records mean the same to the next.
 *
 * Waits that guard real processes (kill grace, process-group checks,
 * harness idle timeouts) and measured durations stay on real time.
 */
// Only Factory's own test harness may compress time, and only with a shared
// origin; anywhere else a stray FACTORY_TIME_SCALE is ignored.
const testClock =
  process.env.FACTORY_TEST_LOCAL_ORIGINS === "1" &&
  positive(process.env.FACTORY_TIME_ORIGIN) !== undefined;
const scale = testClock ? (positive(process.env.FACTORY_TIME_SCALE) ?? 1) : 1;
const origin = positive(process.env.FACTORY_TIME_ORIGIN) ?? Date.now();
const MAX_TIMER_MS = 2_147_483_647;

function positive(value: string | undefined): number | undefined {
  const number = Number(value);
  return value && Number.isFinite(number) && number > 0 ? number : undefined;
}

/** Logical now in epoch ms: the origin plus real elapsed time × scale. */
export function now(): number {
  return scale === 1 ? Date.now() : origin + (Date.now() - origin) * scale;
}

/** Real milliseconds a logical wait of `milliseconds` takes. */
export function realDelay(milliseconds: number): number {
  return Math.min(Math.max(0, milliseconds) / scale, MAX_TIMER_MS);
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
