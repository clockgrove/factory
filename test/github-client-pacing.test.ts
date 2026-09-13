import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { createOctokit } from "../src/github.js";
import { definiteGitHubQuotaRejection, PlatformUnavailableError } from "../src/platform.js";
import { observeGitHubTransportPhase } from "../src/control/mutation-observation.js";

// Use real clocks, core and client configuration. Only HTTP is replaced: mocking
// Octokit or advancing timers here would hide the scheduler this test detects.
describe("configured GitHub client fetch admission", () => {
  it.each(["notification", "mutation", "graphql", "raw-graphql"] as const)(
    "%s has no fixed floors across independent clients and credentials",
    async (kind) => {
      const entered: number[] = [];
      const requestFetch: typeof fetch = async () => {
        entered.push(performance.now());
        return Response.json({ data: { viewer: { login: "fixture" } } });
      };
      const clients = ["same", "same", "different"].map((credential) =>
        createOctokit({
          token: `pacing-${kind}-${credential}`,
          owner: "o",
          repo: "r",
          requestFetch,
        }),
      );
      const invoke = (client: (typeof clients)[number]) => {
        if (kind === "graphql") return client.graphql("query { viewer { login } }");
        if (kind === "raw-graphql")
          return client.request("POST /graphql", { query: "query { viewer { login } }" });
        return client.request(
          kind === "notification"
            ? "POST /repos/o/r/issues/1/comments"
            : "POST /repos/o/r/git/blobs",
          { body: "fixture", content: "fixture" },
        );
      };
      const started = performance.now();
      // Sequential calls catch per-client floors; peers catch default shared groups.
      await invoke(clients[0]!);
      await invoke(clients[0]!);
      await Promise.all(clients.map(invoke));
      expect(entered).toHaveLength(5);
      expect(Math.max(...entered) - started).toBeLessThan(750);
    },
  );

  it.each(["graphql", "raw"] as const)(
    "%s preserves HTTP-200 refusal and peer circuit without replay",
    async (kind) => {
      const requestFetch = vi.fn<typeof fetch>(async () =>
        Response.json(
          { data: null, errors: [{ type: "RATE_LIMITED", message: "quota reached" }] },
          { headers: { "retry-after": "60" } },
        ),
      );
      const opts = { token: `pacing-refusal-${kind}`, owner: "o", repo: "r", requestFetch };
      const client = createOctokit(opts);
      const result = await (kind === "raw"
        ? client.request("POST /graphql", { query: "query { viewer { login } }" })
        : client.graphql("query { viewer { login } }")
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(PlatformUnavailableError);
      expect(definiteGitHubQuotaRejection(result)).toBe(true);
      expect(result).toMatchObject({ refusal: { kind: "rate_limit", retryAfterMs: 60_000 } });
      await expect(createOctokit(opts).request("GET /user")).rejects.toBeInstanceOf(
        PlatformUnavailableError,
      );
      expect(requestFetch).toHaveBeenCalledTimes(1);
      await expect(
        createOctokit({
          ...opts,
          token: `${opts.token}-other`,
          requestFetch: async () => Response.json({}),
        }).request("GET /user"),
      ).resolves.toBeDefined();
    },
  );

  it("delimits client pretransport and fetch-to-response time in phase telemetry", async () => {
    const report = vi.fn();
    const client = createOctokit({
      token: "pacing-timing",
      owner: "o",
      repo: "r",
      requestFetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return Response.json({});
      },
    });
    await observeGitHubTransportPhase("objective", report, () => client.request("GET /user"));
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ readRequests: 1, aggregateQueueWaitMs: 0 }),
    );
    const observation = report.mock.calls[0]![0];
    expect(observation.aggregateClientPreTransportMs).toBeGreaterThanOrEqual(0);
    expect(observation.aggregateClientPreTransportMs).toBeLessThan(750);
    expect(observation.aggregateFetchResponseMs).toBeGreaterThanOrEqual(20);
    expect(observation.aggregateFetchResponseMs).toBeLessThanOrEqual(observation.elapsedMs);
  });
});
