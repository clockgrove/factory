import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubControlStore } from "../src/control/github-store.js";
import { LeaseLostError } from "../src/control/lease.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  MutationScheduler,
  PlatformUnavailableError,
  withGitHubQuotaWait,
} from "../src/platform.js";

const beforeOid = "a".repeat(40);
const afterOid = "b".repeat(40);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}
function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers });
}
function scheduler() {
  return new MutationScheduler({
    sleep: async (ms) => {
      advance(ms);
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GitHub control transport quota retries", () => {
  it("releases real permits for a peer and repeats both fences before retrying an HTTP 429 mutation", async () => {
    const asleep = deferred();
    const wake = deferred();
    const order: string[] = [];
    const firstScheduler = scheduler();
    const secondScheduler = firstScheduler.fork();
    const acquire = vi.spyOn(firstScheduler, "acquire");
    const breaker = new CircuitBreaker();
    const concurrency = new ConcurrencyLimiter(1);
    const transports: string[] = [];
    let firstAttempts = 0;
    const requestFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/repos/o/r/git/refs");
      const body = (await request.json()) as { ref: string };
      transports.push(body.ref);
      order.push(`transport:${body.ref}`);
      if (body.ref === "refs/heads/first" && firstAttempts++ === 0)
        return response({ message: "secondary rate limit" }, 429, { "retry-after": "1" });
      return response({ ref: body.ref, object: { sha: afterOid } }, 201);
    };
    const common = {
      token: "quota-transport-peer",
      owner: "o",
      repo: "r",
      requestFetch,
      circuitBreaker: breaker,
      concurrency,
    };
    const first = new GitHubControlStore({ ...common, mutationScheduler: firstScheduler });
    const second = new GitHubControlStore({ ...common, mutationScheduler: secondScheduler });
    const leaseFence = vi.fn(async () => {
      order.push("lease-fence");
    });
    const policyFence = vi.fn(async () => {
      order.push("policy-fence");
    });
    const refresh = vi.fn(async () => {
      order.push("refresh");
    });
    const pending = withGitHubQuotaWait(
      {
        beforeRetry: refresh,
        sleep: async (ms) => {
          expect(ms).toBe(1_000);
          order.push("quota-wait");
          // Respect the shared server deadline, then keep this owner asleep while
          // a peer exercises the same admission gate and sole concurrency slot.
          advance(ms);
          asleep.resolve();
          await wake.promise;
        },
      },
      () =>
        first.withMutationFence(leaseFence, () =>
          first.withPublicationSafetyFence(policyFence, () =>
            first.createRef("refs/heads/first", afterOid),
          ),
        ),
    );
    try {
      await asleep.promise;
      expect(await second.createRef("refs/heads/peer", afterOid)).toBe(true);
      expect(firstScheduler.telemetry()).toMatchObject({
        admitted: 1,
        transported: 1,
        successful: 0,
      });
      expect(secondScheduler.telemetry()).toMatchObject({
        admitted: 1,
        transported: 1,
        successful: 1,
      });
      wake.resolve();
      await expect(pending).resolves.toBe(true);
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(leaseFence).toHaveBeenCalledTimes(2);
      expect(policyFence).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(transports).toEqual(["refs/heads/first", "refs/heads/peer", "refs/heads/first"]);
      expect(order).toEqual([
        "lease-fence",
        "policy-fence",
        "transport:refs/heads/first",
        "quota-wait",
        "transport:refs/heads/peer",
        "refresh",
        "lease-fence",
        "policy-fence",
        "transport:refs/heads/first",
      ]);
      expect(firstScheduler.telemetry()).toMatchObject({
        admitted: 2,
        transported: 2,
        successful: 1,
      });
      expect(first.mutationOperationTelemetry().records).toEqual([
        expect.objectContaining({
          operation: "createRef",
          mutationRequests: 2,
          outcome: "succeeded",
        }),
      ]);
    } finally {
      wake.resolve();
      await pending.catch(() => {});
    }
  });

  it("does not issue a second HTTP mutation when ownership changes during quota backoff", async () => {
    const admission = scheduler();
    const requests = vi.fn<typeof fetch>(async () =>
      response({ message: "secondary rate limit" }, 429, { "retry-after": "1" }),
    );
    const store = new GitHubControlStore({
      token: "quota-transport-takeover",
      owner: "o",
      repo: "r",
      requestFetch: requests,
      mutationScheduler: admission,
      circuitBreaker: new CircuitBreaker(),
      concurrency: new ConcurrencyLimiter(1),
    });
    let owned = true;
    const fence = vi.fn(async () => {
      if (!owned) throw new LeaseLostError("peer now owns lease");
    });
    await expect(
      withGitHubQuotaWait(
        {
          sleep: async (ms) => {
            advance(ms);
            owned = false;
          },
        },
        () => store.withMutationFence(fence, () => store.createRef("refs/heads/owned", afterOid)),
      ),
    ).rejects.toThrow("peer now owns lease");
    expect(fence).toHaveBeenCalledTimes(2);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(admission.telemetry()).toMatchObject({ admitted: 2, transported: 1, successful: 0 });
    expect(store.mutationOperationTelemetry().records).toEqual([
      expect.objectContaining({ mutationRequests: 1, outcome: "failed" }),
    ]);
  });

  it.each([false, true])(
    "allows initial cleanup after owner stop and never retries a refusal (quota=%s)",
    async (quota) => {
      const stop = new AbortController();
      const reason = new Error("owner stopped");
      stop.abort(reason);
      const requestFetch = vi.fn<typeof fetch>(async (input, init) => {
        expect(init?.signal?.aborted).not.toBe(true);
        expect(new Request(input, init).signal.aborted).toBe(false);
        return quota
          ? response({ message: "secondary rate limit" }, 429, { "retry-after": "1" })
          : response({ object: { sha: afterOid } }, 201);
      });
      const store = new GitHubControlStore({
        token: `quota-transport-stopped-${quota}`,
        owner: "o",
        repo: "r",
        requestFetch,
        mutationScheduler: scheduler(),
        circuitBreaker: new CircuitBreaker(),
        concurrency: new ConcurrencyLimiter(1),
      });
      const sleep = vi.fn(async () => {});
      const cleanup = withGitHubQuotaWait({ signal: stop.signal, sleep }, () =>
        store.withMutationClass("cleanup", () =>
          store.createRef("refs/clockgrove-factory/cleanup", afterOid),
        ),
      );
      if (quota) await expect(cleanup).rejects.toBe(reason);
      else await expect(cleanup).resolves.toBe(true);
      expect(requestFetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("retries a real GraphQL mutation rejected with RATE_LIMITED and no result data", async () => {
    const admission = scheduler();
    let mutations = 0;
    const requestFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/graphql");
      const { query } = (await request.json()) as { query: string };
      if (query.includes("FactoryRepositoryId"))
        return response({ data: { repository: { id: "R_fixture" } } });
      mutations++;
      if (mutations === 1)
        return response(
          { data: null, errors: [{ type: "RATE_LIMITED", message: "rate limit reached" }] },
          200,
          { "retry-after": "1" },
        );
      return response({ data: { updateRefs: { clientMutationId: null } } });
    };
    const store = new GitHubControlStore({
      token: "quota-transport-no-data",
      owner: "o",
      repo: "r",
      requestFetch,
      mutationScheduler: admission,
      circuitBreaker: new CircuitBreaker(),
      concurrency: new ConcurrencyLimiter(1),
    });
    const fence = vi.fn(async () => {});
    const waits = vi.fn(async (ms: number) => {
      advance(ms);
    });
    await expect(
      withGitHubQuotaWait({ sleep: waits }, () =>
        store.withMutationFence(fence, () =>
          store.compareAndSwapRef({ ref: "refs/clockgrove-factory/test", beforeOid, afterOid }),
        ),
      ),
    ).resolves.toBe(true);
    expect(mutations).toBe(2);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(waits).toHaveBeenCalledTimes(1);
    expect(admission.telemetry()).toMatchObject({ admitted: 2, transported: 2, successful: 1 });
  });

  it("reconciles but never replays a real GraphQL mutation response containing partial data and RATE_LIMITED", async () => {
    const admission = scheduler();
    const transportKinds: string[] = [];
    const requestFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/graphql") {
        const { query } = (await request.json()) as { query: string };
        if (query.includes("FactoryRepositoryId")) {
          transportKinds.push("repository-query");
          return response({ data: { repository: { id: "R_fixture" } } });
        }
        transportKinds.push("cas-mutation");
        return response(
          {
            data: { updateRefs: { clientMutationId: "partly-applied" } },
            errors: [{ type: "RATE_LIMITED", message: "rate limit reached", path: ["updateRefs"] }],
          },
          200,
          { "retry-after": "1" },
        );
      }
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toContain("/git/ref/");
      transportKinds.push("reconcile-ref");
      return response({ object: { sha: beforeOid } });
    };
    const store = new GitHubControlStore({
      token: "quota-transport-partial",
      owner: "o",
      repo: "r",
      requestFetch,
      mutationScheduler: admission,
      circuitBreaker: new CircuitBreaker(),
      concurrency: new ConcurrencyLimiter(1),
    });
    const fence = vi.fn(async () => {});
    const waits = vi.fn(async (ms: number) => {
      advance(ms);
    });
    const result = await withGitHubQuotaWait({ sleep: waits }, () =>
      store.withMutationFence(fence, () =>
        store.compareAndSwapRef({ ref: "refs/clockgrove-factory/test", beforeOid, afterOid }),
      ),
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(PlatformUnavailableError);
    const causes: unknown[] = [];
    let cause = result;
    for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
      causes.push(cause);
      cause = (cause as { cause?: unknown }).cause;
    }
    expect(causes).toContainEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          status: 200,
          data: {
            data: { updateRefs: { clientMutationId: "partly-applied" } },
            errors: [{ type: "RATE_LIMITED", message: "rate limit reached", path: ["updateRefs"] }],
          },
        }),
      }),
    );
    expect(transportKinds).toEqual(["repository-query", "cas-mutation", "reconcile-ref"]);
    expect(fence).toHaveBeenCalledTimes(1);
    expect(admission.telemetry()).toMatchObject({ admitted: 1, transported: 1, successful: 0 });
    // Waiting for a safe reconciliation read is allowed; the ambiguous mutation
    // itself must retain its original outcome and must not be transported twice.
    expect(waits).toHaveBeenCalledTimes(1);
  });
});
