import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendHandle, ExecutionBackend } from "../src/execution/backend.js";
import { createBackendObservationWake } from "../src/execution/terminal-wake.js";

const handle: BackendHandle = { backendId: "fixture", resourceId: "worker", startedAt: "now" };
function fixture(terminal?: Promise<void>) {
  const backend = (terminal ? { waitForTerminal: vi.fn(() => terminal) } : {}) as Pick<
    ExecutionBackend,
    "waitForTerminal"
  >;
  return { backend, wake: createBackendObservationWake(backend, handle) };
}

afterEach(() => vi.useRealTimers());

describe("backend terminal observation wake", () => {
  it.each(["resolve", "reject"])(
    "wakes once on terminal %s and then uses fallback",
    async (outcome) => {
      vi.useFakeTimers();
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const terminal = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const then = vi.spyOn(terminal, "then");
      const { backend, wake } = fixture(terminal);
      const subscriptions = then.mock.calls.length;
      const revision = wake.revision;
      const first = wake.waitForChange(60_000, undefined, revision);
      if (outcome === "resolve") resolve();
      else reject(new Error("fixture failure"));
      await first;
      expect(wake.revision).toBe(revision + 1);
      expect(vi.getTimerCount()).toBe(0);
      const observed = vi.fn();
      const next = wake.waitForChange(60_000, undefined, wake.revision).then(observed);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(observed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(backend.waitForTerminal).toHaveBeenCalledOnce();
      expect(then).toHaveBeenCalledTimes(subscriptions);
      wake.dispose();
    },
  );

  it("retains completion before registration and during authoritative observation", async () => {
    vi.useFakeTimers();
    const { wake } = fixture(Promise.resolve());
    const beforeObservation = wake.revision;
    await Promise.resolve();
    await wake.waitForChange(60_000, undefined, beforeObservation);
    expect(wake.revision).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    wake.dispose();
  });

  it("uses bounded polling without accumulating terminal callbacks while unresolved", async () => {
    vi.useFakeTimers();
    const terminal = new Promise<void>(() => {});
    const then = vi.spyOn(terminal, "then");
    const { wake } = fixture(terminal);
    const subscriptions = then.mock.calls.length;
    for (let poll = 0; poll < 3; poll++) {
      const wait = wake.waitForChange(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await wait;
    }
    expect(then).toHaveBeenCalledTimes(subscriptions);
    expect(vi.getTimerCount()).toBe(0);
    wake.dispose();
  });

  it("retains unsupported-backend fallback and cleans abort and disposal timers", async () => {
    vi.useFakeTimers();
    const { wake } = fixture();
    const aborted = new AbortController();
    const wait = wake.waitForChange(60_000, aborted.signal);
    aborted.abort();
    await wait;
    expect(vi.getTimerCount()).toBe(0);
    const fallback = wake.waitForChange(60_000);
    wake.dispose();
    await fallback;
    expect(vi.getTimerCount()).toBe(0);
    await wake.waitForChange(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores completion after disposal", async () => {
    let finish!: () => void;
    const { wake } = fixture(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    wake.dispose();
    finish();
    await Promise.resolve();
    expect(wake.revision).toBe(0);
  });
});
