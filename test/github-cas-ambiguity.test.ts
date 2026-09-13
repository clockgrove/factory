import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubControlStore } from "../src/control/github-store.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  MutationScheduler,
  PlatformUnavailableError,
  withGitHubQuotaWait,
  retryGitHubQuota,
} from "../src/platform.js";

const beforeOid = "a".repeat(40);
const afterOid = "b".repeat(40);

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

describe("GitHub CAS ambiguity across logical retries", () => {
  it.each(["partial GraphQL", "HTTP 503"])(
    "preserves ambiguous %s mutation failure when logical retry reconciliation is refused",
    async (failure) => {
      let mutations = 0;
      let reads = 0;
      const requestFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/graphql") {
          const { query } = (await request.json()) as { query: string };
          if (query.includes("FactoryRepositoryId"))
            return response({ data: { repository: { id: "R_fixture" } } });
          mutations++;
          if (mutations > 1) return response({ data: { updateRefs: { clientMutationId: null } } });
          return failure === "HTTP 503"
            ? response({ message: "Service unavailable" }, 503)
            : response(
                {
                  data: { updateRefs: { clientMutationId: "partial" } },
                  errors: [
                    { type: "RATE_LIMITED", message: "rate limit reached", path: ["updateRefs"] },
                  ],
                },
                200,
                { "retry-after": "1" },
              );
        }
        reads++;
        return response({ object: { sha: beforeOid } });
      };
      const store = new GitHubControlStore({
        token: `logical-ambiguous-${failure}`,
        owner: "o",
        repo: "r",
        requestFetch,
        mutationScheduler: scheduler(),
        circuitBreaker: new CircuitBreaker(),
        concurrency: new ConcurrencyLimiter(1),
      });
      const waits = vi.fn(async (ms: number) => advance(ms));
      await expect(
        withGitHubQuotaWait({ sleep: waits }, () =>
          retryGitHubQuota(() =>
            store.compareAndSwapRef({
              ref: "refs/clockgrove-factory/test",
              beforeOid,
              afterOid,
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(PlatformUnavailableError);
      expect(mutations).toBe(1);
      expect(reads).toBe(0);
      expect(waits).not.toHaveBeenCalled();
    },
  );
});
