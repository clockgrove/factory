import { describe, expect, it, vi } from "vitest";
import {
  GitHubPrimaryAdmissionDeferredError,
  PlatformUnavailableError,
  retryGitHubQuota,
  withGitHubQuotaWait,
} from "../src/platform.js";
const depleted = () =>
  new GitHubPrimaryAdmissionDeferredError(
    { kind: "rate_limit", retryAfterMs: 60_000 },
    new Error("observed exhaustion"),
  );
describe("active operation quota waiting", () => {
  it("releases permits then refreshes before retrying the same operation", async () => {
    const events: string[] = [];
    let attempts = 0;
    await withGitHubQuotaWait(
      {
        sleep: async () => {
          events.push("wait");
        },
        beforeRetry: async () => {
          events.push("refresh");
        },
      },
      () =>
        retryGitHubQuota(async () => {
          events.push("acquire");
          try {
            return await retryGitHubQuota(async () => {
              events.push("fence");
              if (attempts++ === 0) throw depleted();
              events.push("transport");
            });
          } finally {
            events.push("release");
          }
        }),
    );
    expect(events).toEqual([
      "acquire",
      "fence",
      "release",
      "wait",
      "refresh",
      "acquire",
      "fence",
      "transport",
      "release",
    ]);
  });
  it("keeps a competing owner and local work responsive", async () => {
    let wake!: () => void, sleeping!: () => void;
    const asleep = new Promise<void>((resolve) => {
      sleeping = resolve;
    });
    const delay = new Promise<void>((resolve) => {
      wake = resolve;
    });
    let attempts = 0;
    const first = withGitHubQuotaWait(
      {
        sleep: async () => {
          sleeping();
          await delay;
        },
      },
      () =>
        retryGitHubQuota(async () => {
          if (attempts++ === 0) throw depleted();
          return "first";
        }),
    );
    await asleep;
    expect(await withGitHubQuotaWait({}, () => retryGitHubQuota(async () => "second"))).toBe(
      "second",
    );
    let localProgress = 0;
    await Promise.resolve().then(() => {
      localProgress++;
    });
    expect(localProgress).toBe(1);
    wake();
    expect(await first).toBe("first");
    expect(attempts).toBe(2);
  });
  it("handles repeated quota and quota during refresh without recursive refresh", async () => {
    let refreshes = 0,
      calls = 0;
    const sleep = vi.fn(async () => {});
    await withGitHubQuotaWait(
      {
        sleep,
        beforeRetry: async () => {
          await retryGitHubQuota(
            async () => {
              if (refreshes++ === 0) throw depleted();
            },
            { refresh: false },
          );
        },
      },
      () =>
        retryGitHubQuota(async () => {
          if (calls++ < 3) throw depleted();
        }),
    );
    expect(calls).toBe(4);
    expect(refreshes).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(4);
  });
  it("does not replay ambiguous errors or partial GraphQL mutation success", async () => {
    for (const error of [
      new PlatformUnavailableError({ kind: "server_error", retryAfterMs: 1000 }, { status: 503 }),
      new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: 1000 },
        {
          name: "GraphqlResponseError",
          data: { createIssue: { id: "created" } },
          errors: [{ type: "RATE_LIMITED" }],
        },
      ),
    ]) {
      const operation = vi.fn(async () => {
        throw error;
      });
      const sleep = vi.fn(async () => {});
      await expect(withGitHubQuotaWait({ sleep }, () => retryGitHubQuota(operation))).rejects.toBe(
        error,
      );
      expect(operation).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });
  it("interrupts quota waits on owner cancellation without cancelling peers", async () => {
    const stop = new AbortController();
    const operation = vi.fn(async () => {
      throw depleted();
    });
    const waiting = withGitHubQuotaWait({ signal: stop.signal }, () => retryGitHubQuota(operation));
    await Promise.resolve();
    stop.abort(new Error("owner stopped"));
    await expect(waiting).rejects.toThrow("owner stopped");
    expect(await withGitHubQuotaWait({}, () => retryGitHubQuota(async () => 1))).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

it("caps a resumed owner's quota wait at its durable remaining deadline", async () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const durableStart = now - 50 * 60_000;
    const operation = vi.fn(async () => {
      throw new GitHubPrimaryAdmissionDeferredError(
        { kind: "rate_limit", retryAfterMs: 3_600_000 },
        new Error("hour reset"),
      );
    });
    const waiting = withGitHubQuotaWait({ deadline: () => durableStart + 60 * 60_000 }, () =>
      retryGitHubQuota(operation),
    );
    const outcome = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await outcome).toMatchObject({ name: "TimeoutError" });
    // Every earlier minute may recheck time, but cannot issue another request
    // once the durable deadline has been reached.
    expect(operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("does not overflow a supported thirty-day owner deadline into an immediate abort", async () => {
  vi.useFakeTimers();
  try {
    const stop = new AbortController();
    const deadline = Date.now() + 30 * 24 * 60 * 60_000;
    const operation = vi.fn(async () => {
      throw depleted();
    });
    let settled = false;
    const waiting = withGitHubQuotaWait({ signal: stop.signal, deadline: () => deadline }, () =>
      retryGitHubQuota(operation),
    );
    const outcome = waiting
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
    stop.abort(new Error("owner stopped"));
    expect(await outcome).toMatchObject({ message: "owner stopped" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
