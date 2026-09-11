import { expect, it, vi } from "vitest";
import { NODE_TIMER_MAX_DELAY_MS, scheduleProcessTimeout } from "../src/runtime/process-group.js";

it("preserves the maximum Objective policy timeout across Node timer slices", () => {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  let now = 0;
  const schedule = vi.fn((callback: () => void, delayMs: number) => {
    callbacks.push(callback);
    delays.push(delayMs);
    return {} as NodeJS.Timeout;
  });
  const fired = vi.fn();
  const maximumPolicyMs = 30 * 24 * 60 * 60_000;

  scheduleProcessTimeout(fired, maximumPolicyMs, { schedule, now: () => now });
  expect(delays).toEqual([NODE_TIMER_MAX_DELAY_MS]);
  now = NODE_TIMER_MAX_DELAY_MS;
  callbacks.shift()!();
  expect(delays).toEqual([NODE_TIMER_MAX_DELAY_MS, maximumPolicyMs - NODE_TIMER_MAX_DELAY_MS]);
  expect(fired).not.toHaveBeenCalled();
  now = maximumPolicyMs;
  callbacks.shift()!();
  expect(fired).toHaveBeenCalledOnce();
});

it("expires immediately when a late first slice crosses the absolute deadline", () => {
  const callbacks: Array<() => void> = [];
  let now = 0;
  const fired = vi.fn();
  const maximumPolicyMs = 30 * 24 * 60 * 60_000;
  const schedule = vi.fn((callback: () => void) => {
    callbacks.push(callback);
    return {} as NodeJS.Timeout;
  });

  scheduleProcessTimeout(fired, maximumPolicyMs, { schedule, now: () => now });
  now = maximumPolicyMs;
  callbacks.shift()!();

  expect(fired).toHaveBeenCalledOnce();
  expect(schedule).toHaveBeenCalledOnce();
});

it("cancels the active slice without rearming the logical timeout", () => {
  const callbacks: Array<() => void> = [];
  const timer = {} as NodeJS.Timeout;
  const clear = vi.fn();
  const fired = vi.fn();
  let now = 0;
  const cancel = scheduleProcessTimeout(fired, NODE_TIMER_MAX_DELAY_MS + 1, {
    schedule: (callback) => {
      callbacks.push(callback);
      return timer;
    },
    clear,
    now: () => now,
  });

  cancel();
  now = NODE_TIMER_MAX_DELAY_MS + 1;
  callbacks.shift()!();
  expect(clear).toHaveBeenCalledExactlyOnceWith(timer);
  expect(fired).not.toHaveBeenCalled();
  expect(callbacks).toHaveLength(0);
});
