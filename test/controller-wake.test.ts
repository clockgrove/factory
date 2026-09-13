import { afterEach, expect, it, vi } from "vitest";
import { GitHubRepositoryController } from "../src/controller/repository-controller.js";
import { WakeSignal } from "../src/scheduling/wake-signal.js";
import { PlatformUnavailableError } from "../src/platform.js";

const activation = (objective: number) => ({
  objective,
  activatedAt: new Date(0).toISOString(),
  requestId: `request-${objective}`,
  policy: {},
  policyDigest: "c".repeat(64),
  baseSha: "a".repeat(40),
  requestedBy: "operator",
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

it("admits the next Objective at slot settlement without advancing the 60s timer", async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  const finish = new Map<number, () => void>();
  const discover = vi.fn(async () => [activation(1), activation(2)]);
  const starts: number[] = [];
  const controller = new GitHubRepositoryController({
    capacity: 1,
    signal: stop.signal,
    store: { discoverObjectiveActivations: discover },
    reconcileObjective: async (a) => {
      starts.push(a.objective);
      await new Promise<void>((r) => finish.set(a.objective, r));
    },
  });
  const running = controller.run();
  await flush();
  expect(starts).toEqual([1]);
  const at = Date.now();
  finish.get(1)!();
  await flush();
  expect(starts).toEqual([1, 2]);
  expect(Date.now() - at).toBe(0);
  expect(discover).toHaveBeenCalledTimes(2);
  stop.abort();
  finish.get(2)!();
  await running;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["scan", "scan-to-wait"])(
  "retains burst notifications during %s and coalesces them",
  async (boundary) => {
    vi.useFakeTimers();
    const stop = new AbortController();
    let finish!: () => void;
    const scanned = new Promise<void>((r) => (finish = r));
    const discover = vi.fn(async () => {
      if (discover.mock.calls.length === 1 && boundary === "scan") await scanned;
      return [];
    });
    let controller!: GitHubRepositoryController;
    let notified = false;
    controller = new GitHubRepositoryController({
      signal: stop.signal,
      store: { discoverObjectiveActivations: discover },
      reconcileObjective: async () => {},
      onWakeObservation: (o) => {
        if (boundary === "scan-to-wait" && o.event === "scan-end" && !notified) {
          notified = true;
          for (let i = 0; i < 20; i++) controller.wake();
        }
      },
    });
    const running = controller.run();
    await flush();
    if (boundary === "scan") {
      for (let i = 0; i < 20; i++) controller.wake();
      finish();
    }
    await flush();
    expect(discover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(discover).toHaveBeenCalledTimes(2);
    stop.abort();
    await running;
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("retains the same one-minute idle read windows and remote-origin fallback", async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  let remote = false;
  const discover = vi.fn(async () => (remote ? [activation(1)] : []));
  const reconcile = vi.fn(async () => {});
  const controller = new GitHubRepositoryController({
    signal: stop.signal,
    store: { discoverObjectiveActivations: discover },
    reconcileObjective: reconcile,
  });
  const running = controller.run();
  await flush();
  await vi.advanceTimersByTimeAsync(179_999);
  expect(discover).toHaveBeenCalledTimes(3); // t=0,60,120 seconds, unchanged baseline
  remote = true;
  await vi.advanceTimersByTimeAsync(1);
  expect(reconcile).toHaveBeenCalledTimes(1);
  stop.abort();
  await running;
});

it("wake hints cannot shorten an enforced quota retry", async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  const discover = vi.fn(async () => {
    if (discover.mock.calls.length === 1)
      throw new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: 30_000 },
        Object.assign(new Error("quota"), { status: 429 }),
      );
    return [];
  });
  const controller = new GitHubRepositoryController({
    signal: stop.signal,
    store: { discoverObjectiveActivations: discover },
    reconcileObjective: async () => {},
  });
  const running = controller.run();
  await flush();
  for (let i = 0; i < 50; i++) controller.wake();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(discover).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(discover).toHaveBeenCalledTimes(2);
  stop.abort();
  await running;
});

it("cleans revision waiters on event, timeout and abort, including event-before-registration", async () => {
  vi.useFakeTimers();
  const wake = new WakeSignal();
  const revision = wake.revision;
  wake.changed();
  await wake.waitForChange(60_000, undefined, revision);
  expect(vi.getTimerCount()).toBe(0);
  const stop = new AbortController();
  const wait = wake.waitForChange(60_000, stop.signal);
  stop.abort();
  await wait;
  expect(vi.getTimerCount()).toBe(0);
  const timeout = wake.waitForChange(100);
  await vi.advanceTimersByTimeAsync(100);
  await timeout;
  const event = wake.waitForChange(60_000);
  wake.changed();
  await event;
  expect(vi.getTimerCount()).toBe(0);
});
