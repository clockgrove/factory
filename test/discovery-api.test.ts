import { describe, expect, it } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { PlatformUnavailableError } from "../src/platform.js";

const DATE = "Sun, 13 Sep 2026 10:00:00 GMT";
const updatedAt = "2026-09-13T10:00:00.000Z";
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { date: DATE, ...headers } });
}
function connection(name: "issues" | "refs", nodes: unknown[], cursor: string | null = null) {
  return {
    data: {
      repository: {
        [name]: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } },
      },
    },
  };
}
function node(number: number) {
  return { __typename: "Issue", number, state: "OPEN", updatedAt, comments: { totalCount: 0 } };
}

describe("configured discovery API contracts", () => {
  it("uses minimal direct filtered GraphQL pages and never queries historical refs or repository comments", async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const store = new GitHubControlStore({
      token: "discovery-api-filtered-pages",
      owner: "o",
      repo: "r",
      discoveryNow: () => new Date(DATE),
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/user") return json({ login: "operator" });
        expect(url.pathname).toBe("/graphql");
        const body = (await request.json()) as {
          query: string;
          variables: Record<string, unknown>;
        };
        calls.push(body);
        expect(body.query).not.toMatch(/\bbody\b|search\(/);
        if (body.query.includes("FactoryDiscoveryLocators")) {
          expect(body.variables.prefix).toBe("refs/clockgrove-factory/active/");
          return json(connection("refs", []));
        }
        expect(body.query).toContain('labels:["factory:objective"]');
        expect(body.query).toContain("CREATED_AT");
        if ((body.variables.states as string[])[0] === "CLOSED") {
          const firstClosed =
            calls.filter(
              (call) => (call.variables.states as string[] | undefined)?.[0] === "CLOSED",
            ).length === 1;
          expect(Date.parse(body.variables.since as string)).toBe(
            Date.parse(DATE) - (firstClosed ? 7 * 86400_000 : 0) - 120_000,
          );
          return json(connection("issues", []));
        }
        if (!body.variables.cursor)
          return json(
            connection(
              "issues",
              Array.from({ length: 100 }, (_, index) => node(index + 1)),
              "page-two",
            ),
          );
        expect(body.variables.cursor).toBe("page-two");
        return json(connection("issues", [node(101), { ...node(102), __typename: "PullRequest" }]));
      },
    });
    for (let cycle = 0; cycle < 5; cycle++)
      expect(await store.discoverObjectiveActivations()).toEqual([]);
    const open = calls.filter(
      (call) => (call.variables.states as string[] | undefined)?.[0] === "OPEN",
    );
    expect(open.map((call) => call.variables.cursor)).toEqual([null, "page-two"]);
    expect(open[0]!.variables.since).toBeNull();
    expect(store.discoveryTelemetry()).toMatchObject({ cachedObjectives: 101, cachedComments: 0 });
    expect(
      store.discoveryTelemetry().cycles.reduce((sum, cycle) => sum + (cycle.returnedBytes ?? 0), 0),
    ).toBeGreaterThan(10_000);
  });

  it("binds exact issue conditional reads to an existing summary", async () => {
    const validators: Array<string | null> = [];
    const store = new GitHubControlStore({
      token: "discovery-api-conditional-issue",
      owner: "o",
      repo: "r",
      discoveryNow: () => new Date(DATE),
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/user") return json({ login: "operator" });
        if (url.pathname === "/repos/o/r/issues/7") {
          validators.push(request.headers.get("if-none-match"));
          if (validators.at(-1))
            return new Response(null, {
              status: 304,
              headers: { date: DATE, etag: '"issue-seven"' },
            });
          return json(
            { number: 7, state: "open", updated_at: updatedAt, comments: 0, labels: [] },
            200,
            { etag: '"issue-seven"' },
          );
        }
        const body = (await request.json()) as { query: string };
        return json(
          connection(body.query.includes("FactoryDiscoveryLocators") ? "refs" : "issues", []),
        );
      },
    });
    await store.discoverObjectiveActivations([7]);
    await store.discoverObjectiveActivations([7]);
    expect(validators).toEqual([null, '"issue-seven"']);
    expect(store.discoveryTelemetry().cycles.at(-1)?.probes.notModified).toBe(1);
  });

  it("preserves actual secondary refusal and does not transport through its open circuit", async () => {
    let transported = 0;
    const store = new GitHubControlStore({
      token: "discovery-api-secondary-response",
      owner: "o",
      repo: "r",
      discoveryNow: () => new Date(DATE),
      requestFetch: async (input, init) => {
        transported++;
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/user") return json({ login: "operator" });
        return json(
          {
            message:
              "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
          },
          403,
          { "retry-after": "120" },
        );
      },
    });
    await expect(store.discoverObjectiveActivations()).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
    expect(store.discoveryTelemetry().cycles.at(-1)).toMatchObject({
      outcome: "failed",
      probes: { authenticatedUser: 1, issues: 1 },
    });
    const before = transported;
    await expect(store.discoverObjectiveActivations()).rejects.toThrow();
    expect(transported).toBe(before);
  });

  it("rejects partial GraphQL envelopes instead of interpreting their data as a complete scan", async () => {
    let openReads = 0;
    const store = new GitHubControlStore({
      token: "discovery-api-partial-graphql",
      owner: "o",
      repo: "r",
      discoveryNow: () => new Date(DATE),
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/user") return json({ login: "operator" });
        const body = (await request.json()) as { query: string; variables: { states?: string[] } };
        if (body.variables.states?.[0] === "OPEN") {
          openReads++;
          if (openReads === 1)
            return json({
              ...connection("issues", []),
              errors: [{ message: "connection unavailable", type: "INTERNAL" }],
            });
        }
        return json(
          connection(body.query.includes("FactoryDiscoveryLocators") ? "refs" : "issues", []),
        );
      },
    });
    await expect(store.discoverObjectiveActivations()).rejects.toThrow("incomplete GraphQL");
    expect(store.discoveryTelemetry().cycles.at(-1)?.probes.issues).toBe(1);
    await expect(store.discoverObjectiveActivations()).resolves.toEqual([]);
    expect(openReads).toBe(2);
  });
});
