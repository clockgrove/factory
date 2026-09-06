import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { RepositoryLeaseManager } from "../src/controller/repository-lease.js";
import { ControllerGenerationRetirement } from "../src/controller/retirement.js";
import {
  GitHubRepositoryController,
  runGitHubRepositoryController,
} from "../src/controller/repository-controller.js";
import {
  CircuitBreaker,
  classifyRefusal,
  ConcurrencyLimiter,
  PlatformUnavailableError,
} from "../src/platform.js";

vi.mock("../src/supervisor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/supervisor.js")>()),
  verifyLocalRepository: vi.fn(async () => {}),
}));

const activation = {
  objective: 1,
  activatedAt: "2026-09-05T22:01:34Z",
  requestId: "approved",
  policy: {},
  policyDigest: "c".repeat(64),
  baseSha: "a".repeat(40),
  requestedBy: "operator",
};
const quota = (ms = 1_842_000) =>
  new PlatformUnavailableError(
    { kind: "rate_limit", retryAfterMs: ms },
    new Error("private raw response"),
  );
const options = (signal: AbortSignal) => ({
  token: "test-only",
  owner: "fixture",
  repo: "fixture",
  repository: "/not-read",
  signal,
  pollIntervalMs: 60_000,
});

function ownershipMocks() {
  const facts = vi
    .spyOn(GitHubControlStore.prototype, "getRepositoryFacts")
    .mockResolvedValue({ defaultBranch: "main" } as never);
  vi.spyOn(GitHubControlStore.prototype, "getBranchHead").mockResolvedValue({
    oid: "a".repeat(40),
    treeOid: "b".repeat(40),
  } as never);
  const discover = vi
    .spyOn(GitHubControlStore.prototype, "discoverObjectiveActivations")
    .mockResolvedValue([activation]);
  const acquire = vi
    .spyOn(RepositoryLeaseManager.prototype, "acquire")
    .mockImplementation(async (identity) => ({
      ...identity,
      ref: "refs/clockgrove-factory/leases/repository-controller",
      oid: "a".repeat(40),
      treeOid: "b".repeat(40),
      epoch: 1,
      sequence: 1,
      expiresAt: new Date(Date.now() + 600_000),
    }));
  const release = vi
    .spyOn(RepositoryLeaseManager.prototype, "release")
    .mockResolvedValue(undefined as never);
  return { facts, discover, acquire, release };
}

beforeEach(() =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("controller quota boundary", () => {
  it.each(["facts", "acquire", "discovery", "release"] as const)(
    "waits through a %s refusal without service restart or model retry",
    async (phase) => {
      const mock = ownershipMocks();
      const abort = new AbortController();
      const run = vi.fn(async () => {
        abort.abort();
      });
      const failure = quota();
      if (phase === "facts") mock.facts.mockRejectedValueOnce(failure);
      if (phase === "acquire") mock.acquire.mockRejectedValueOnce(failure);
      if (phase === "discovery") mock.discover.mockRejectedValueOnce(failure);
      if (phase === "release") mock.release.mockRejectedValueOnce(failure);
      // Release failure is observed after operation completion, not operator stop.
      if (phase === "release")
        mock.discover.mockImplementationOnce(async () => {
          throw failure;
        });
      const task = runGitHubRepositoryController({
        ...options(abort.signal),
        supervisorFactory: () => ({ run }),
      });
      const settled = vi.fn();
      void task.then(settled, settled);
      await vi.advanceTimersByTimeAsync(1_841_999);
      expect(run).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      expect(mock.facts).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(run).toHaveBeenCalledTimes(1);
      expect(mock.facts).toHaveBeenCalledTimes(2);
      if (mock.acquire.mock.calls.length === 2) {
        expect(mock.acquire.mock.calls[0]![0].controllerId).toBe(
          mock.acquire.mock.calls[1]![0].controllerId,
        );
      }
    },
  );

  it("settles and aborts active work before propagating discovery failure", async () => {
    const failure = quota();
    const discover = vi.fn().mockResolvedValueOnce([activation]).mockRejectedValueOnce(failure);
    let cleaned = false;
    const controller = new GitHubRepositoryController({
      store: { discoverObjectiveActivations: discover },
      pollIntervalMs: 10,
      reconcileObjective: async (_activation, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        await Promise.resolve();
        cleaned = true;
      },
    });
    const task = controller.run();
    const rejection = expect(task).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(cleaned).toBe(true);
    expect(await controller.reconcileOnce()).toBe(0);
  });

  it("preserves the longest original cooldown when lease release also refuses", async () => {
    const mock = ownershipMocks();
    const abort = new AbortController();
    mock.discover.mockRejectedValueOnce(quota(120_000));
    mock.release.mockRejectedValueOnce(quota(1_000));
    const run = vi.fn(async () => abort.abort());
    const task = runGitHubRepositoryController({
      ...options(abort.signal),
      supervisorFactory: () => ({ run }),
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(mock.acquire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await task;
    expect(mock.acquire).toHaveBeenCalledTimes(2);
  });

  it("does not release through an open shared circuit and can stop during a long cooldown", async () => {
    const mock = ownershipMocks();
    const { createRepositorySupervisorResources } = await import("../src/supervisor.js");
    const resources = createRepositorySupervisorResources();
    const abort = new AbortController();
    mock.discover.mockImplementationOnce(async () => {
      resources.circuitBreaker.recordRefusal({ kind: "rate_limit", retryAfterMs: 3_000_000_000 });
      throw quota(3_000_000_000);
    });
    const task = runGitHubRepositoryController({ ...options(abort.signal), resources });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mock.facts).toHaveBeenCalledTimes(1);
    expect(mock.release).not.toHaveBeenCalled();
    abort.abort();
    await task;
  });

  it("keeps bootstrap permission failures fatal instead of retrying them", async () => {
    const mock = ownershipMocks();
    const failure = { status: 403, message: "Resource not accessible by integration" };
    mock.facts.mockRejectedValueOnce(failure);
    await expect(
      runGitHubRepositoryController(options(new AbortController().signal)),
    ).rejects.toThrow("non-retryable failure");
    expect(mock.facts).toHaveBeenCalledTimes(1);
  });

  it("does not acquire a repository lease when stopped during bootstrap reads", async () => {
    const mock = ownershipMocks();
    const abort = new AbortController();
    mock.facts.mockImplementationOnce(async () => {
      abort.abort();
      return { defaultBranch: "main" } as never;
    });
    await runGitHubRepositoryController(options(abort.signal));
    expect(mock.acquire).not.toHaveBeenCalled();
    expect(mock.discover).not.toHaveBeenCalled();
  });

  it("handles renewal refusal in-process and rereads ownership only after cooldown", async () => {
    const mock = ownershipMocks();
    mock.discover.mockResolvedValue([]);
    vi.spyOn(RepositoryLeaseManager.prototype, "renew").mockRejectedValueOnce(quota(120_000));
    const abort = new AbortController();
    const task = runGitHubRepositoryController(options(abort.signal));
    await vi.advanceTimersByTimeAsync(480_000);
    expect(mock.acquire).toHaveBeenCalledTimes(1);
    expect(mock.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(mock.acquire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.acquire).toHaveBeenCalledTimes(2);
    abort.abort();
    await task;
  });

  it("does not turn an active cleanup failure into a platform retry", async () => {
    const failure = new Error("resource cleanup unverified");
    const controller = new GitHubRepositoryController({
      store: {
        discoverObjectiveActivations: vi
          .fn()
          .mockResolvedValueOnce([activation])
          .mockRejectedValueOnce(quota()),
      },
      pollIntervalMs: 10,
      reconcileObjective: async (_activation, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw failure;
      },
    });
    const result = expect(controller.run()).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("does not leak raw authentication errors from asynchronous reconciliation", async () => {
    const mock = ownershipMocks();
    const logs: string[] = [];
    const secret = "Bearer private-token";
    const run = async () => {
      throw { status: 403, message: secret };
    };
    const task = runGitHubRepositoryController({
      ...options(new AbortController().signal),
      onStatus: (line) => logs.push(line),
      supervisorFactory: () => ({ run }),
    });
    await expect(task).rejects.toThrow("non-retryable failure");
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).toContain("github-permission-403");
    expect(mock.acquire).toHaveBeenCalledTimes(1);
  });

  it("preserves deliberate controller-generation retirement identity", async () => {
    ownershipMocks();
    const retirement = new ControllerGenerationRetirement();
    await expect(
      runGitHubRepositoryController({
        ...options(new AbortController().signal),
        supervisorFactory: () => ({
          run: async () => {
            throw retirement;
          },
        }),
      }),
    ).rejects.toBe(retirement);
  });

  it("retains the known recovery resource gate diagnostic without raw provider details", async () => {
    ownershipMocks();
    await expect(
      runGitHubRepositoryController({
        ...options(new AbortController().signal),
        supervisorFactory: () => ({
          run: async () => {
            throw new Error("Recovery adoption blocked: resource-absence-unverified");
          },
        }),
      }),
    ).rejects.toThrow("recovery-adoption-blocked: resource-absence-unverified");
  });

  it("handles a failing asynchronous diagnostic without an unhandled task rejection", async () => {
    const diagnostic = new Error("diagnostic failure");
    const controller = new GitHubRepositoryController({
      store: { discoverObjectiveActivations: async () => [activation] },
      reconcileObjective: async () => {
        throw quota();
      },
      onError: () => {
        throw diagnostic;
      },
    });
    await expect(controller.run()).rejects.toBe(diagnostic);
  });
});

describe("captured primary REST refusal", () => {
  it("does not turn an invalid negative Retry-After into an immediate retry", () => {
    expect(
      classifyRefusal({ status: 429, response: { headers: { "retry-after": "-1" } } }),
    ).toEqual({ kind: "rate_limit", retryAfterMs: 60_000 });
  });

  it("preserves typed platform classification without inspecting an arbitrary cause chain", () => {
    const error = quota(120_000);
    expect(classifyRefusal(error)).toEqual({ kind: "rate_limit", retryAfterMs: 120_000 });
  });
  it("holds the actual reset boundary despite later successes or shorter refusals", () => {
    vi.setSystemTime(new Date("2026-09-05T22:01:34Z"));
    const refusal = classifyRefusal({
      status: 403,
      message: "API rate limit exceeded",
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-used": "5000",
          "x-ratelimit-reset": "1788647538",
        },
      },
    });
    expect(refusal).toEqual({ kind: "rate_limit", retryAfterMs: 1_844_000 });
    if (refusal.kind === "not_refusal") throw new Error("fixture must classify");
    const breaker = new CircuitBreaker();
    breaker.recordRefusal(refusal);
    breaker.recordSuccess(); // A separate bucket's full remaining count cannot clear this.
    breaker.recordRefusal({ kind: "rate_limit", retryAfterMs: 1000 });
    expect(breaker.waitMs()).toBe(1_844_000);
  });

  it("records Octokit's wrapped refusal and blocks a queued call without retripping", async () => {
    vi.useRealTimers();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "120" },
        }),
    );
    const breaker = new CircuitBreaker({
      openAfterConsecutiveRefusals: 1,
      maxOpens: 2,
      baseCooldownMs: 1,
    });
    const store = new GitHubControlStore({
      token: "test-only",
      owner: "fixture",
      repo: "fixture",
      requestFetch: fetch,
      circuitBreaker: breaker,
      concurrency: new ConcurrencyLimiter(1),
    });
    const results = Promise.allSettled([
      store.readRef("refs/heads/main"),
      store.readRef("refs/heads/other"),
    ]);
    expect((await results).every((entry) => entry.status === "rejected")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(breaker.waitMs()).toBeGreaterThan(119_000);
    expect(breaker.exhausted()).toBe(false);
  });

  it("a late in-flight HTTP success cannot clear another request's cooldown", async () => {
    vi.useRealTimers();
    let finishSuccess!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finishSuccess = resolve;
    });
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (decodeURIComponent(String(input)).endsWith("/late")) {
        await waiting;
        return new Response(JSON.stringify({ object: { sha: "a".repeat(40) } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "content-type": "application/json", "retry-after": "120" },
      });
    });
    const breaker = new CircuitBreaker();
    const store = new GitHubControlStore({
      token: "test-only",
      owner: "fixture",
      repo: "fixture",
      requestFetch: fetch,
      circuitBreaker: breaker,
    });
    const late = store.readRef("refs/heads/late").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await expect(store.readRef("refs/heads/refused")).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
    finishSuccess();
    expect(await late).toEqual({ value: "a".repeat(40) });
    await expect(store.readRef("refs/heads/never-sent")).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(breaker.waitMs()).toBeGreaterThan(119_000);
  });

  it("rechecks a shared refusal after an awaited mutation fence", async () => {
    vi.useRealTimers();
    let releaseFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    let enteredFence!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFence = resolve;
    });
    const breaker = new CircuitBreaker();
    const fetch = vi.fn();
    const store = new GitHubControlStore({
      token: "test-only",
      owner: "fixture",
      repo: "fixture",
      requestFetch: fetch,
      circuitBreaker: breaker,
      beforeMutation: async () => {
        enteredFence();
        await fence;
      },
    });
    const result = expect(store.stackRequest("POST /fixture", {}, true)).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
    await entered;
    breaker.recordRefusal({ kind: "rate_limit", retryAfterMs: 120_000 });
    releaseFence();
    await result;
    expect(fetch).not.toHaveBeenCalled();
    expect(breaker.waitMs()).toBeGreaterThan(119_000);
  });
});
