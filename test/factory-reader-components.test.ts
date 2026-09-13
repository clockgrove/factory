/** Read-only authenticated reader floor; not a Supervisor lifecycle benchmark. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { GitHubReader } from "../src/github.js";
import { encodeEventComment } from "../src/control/receipts.js";
import {
  observeGitHubTransportTrace,
  type GitHubTransportAttempt,
} from "../src/control/mutation-observation.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const DATE = "Sun, 13 Sep 2026 00:00:00 GMT";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const comment = (value: Record<string, unknown>) => ({
  body: encodeEventComment(
    "fixture receipt",
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      objective: 14,
      runId: "reader-fixture",
      sequence: 1,
      at: "2026-09-13T00:00:00.000Z",
      ...value,
    }),
  ),
  author: { login: "operator" },
  authorAssociation: "OWNER",
});

it("measures unchanged authenticated reader transports across sizes and fresh instances", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(DATE));
  let finished = false;
  const workload = (async () => {
    const reports = [];
    for (const size of [3, 30, 100]) {
      const nodes = Array.from({ length: size }, (_, i) => ({
        id: `I_${100 + i}`,
        number: 100 + i,
        title: `Item ${i}`,
        body: "Fixed work item body",
        state: "OPEN",
        assignees: { nodes: [] },
        labels: { nodes: [{ name: "factory:work-item" }] },
        issueFieldValues: { totalCount: 0, nodes: [] },
        blockedBy: {
          totalCount: i % 3 === 2 ? 2 : 0,
          nodes: i % 3 === 2 ? [{ number: 100 + i - 2 }, { number: 100 + i - 1 }] : [],
        },
        closedByPullRequestsReferences: { nodes: [] },
        timelineItems: { nodes: [] },
        comments: {
          totalCount: 1,
          nodes: [
            comment({
              kind: "budget",
              event: "BudgetReconciled",
              workItem: 100 + i,
              attempt: 1,
              phase: "execution",
              unit: "local_milliseconds",
              amount: 10,
              usageId: `worker-${i}`,
            }),
          ],
        },
      }));
      const detail = {
        rateLimit: { cost: 4, limit: 5000, remaining: 4900, resetAt: "2026-09-14T00:00:00.000Z" },
        repository: {
          id: "R_fixture",
          defaultBranchRef: { name: "main" },
          workItemLabel: { id: "L_fixture" },
          suggestedActors: { nodes: [{ __typename: "User", id: "U_operator", login: "operator" }] },
          issue: {
            id: "I_14",
            number: 14,
            title: "Reader fixture",
            body: "Fixed objective body",
            state: "OPEN",
            author: { login: "operator" },
            authorAssociation: "OWNER",
            comments: {
              totalCount: 1,
              nodes: [
                comment({
                  kind: "run",
                  event: "FactoryRunStarted",
                  actor: "operator",
                  repository: "fixture/project",
                  objectiveAuthor: "operator",
                  fork: false,
                  baseBranch: "main",
                  policy: DEFAULT_RUN_POLICY,
                  policyDigest: policyDigest(DEFAULT_RUN_POLICY),
                }),
              ],
            },
            subIssues: { totalCount: size, nodes },
          },
        },
      };
      const calls: { route: string; requestBytes: number; responseBytes: number }[] = [];
      const requestFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== "https://api.github.com") throw new Error("network forbidden");
        let value: unknown;
        let route: string;
        const body = request.method === "POST" ? await request.text() : "";
        if (request.method === "GET" && url.pathname.endsWith("/actions/runs")) {
          route = "workflow-runs";
          value = { total_count: 0, workflow_runs: [] };
        } else if (request.method === "POST" && url.pathname === "/graphql") {
          const query = JSON.parse(body).query as string;
          if (!/^\s*(query|\{)/.test(query)) throw new Error("mutation forbidden");
          route = query.includes("ObjectiveCardinality") ? "cardinality" : "detail";
          value = {
            data:
              route === "cardinality"
                ? {
                    repository: {
                      owner: { __typename: "Organization" },
                      issue: { subIssues: { totalCount: size } },
                    },
                  }
                : detail,
          };
        } else throw new Error(`unsupported fixture request ${request.method}`);
        const response = JSON.stringify(value);
        calls.push({
          route,
          requestBytes: Buffer.byteLength(body),
          responseBytes: Buffer.byteLength(response),
        });
        return new Response(response, {
          headers: {
            date: DATE,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(response)),
          },
        });
      };
      const reader = () =>
        new GitHubReader({
          token: `reader-component-${size}`,
          owner: "fixture",
          repo: "project",
          requestFetch,
        });
      let current = reader();
      let projection: string | undefined;
      for (const mode of ["cold", "warm", "restart"] as const) {
        if (mode === "restart") current = reader();
        calls.length = 0;
        const trace: GitHubTransportAttempt[] = [];
        const snapshot = await observeGitHubTransportTrace(
          (value) => trace.push(value),
          () => current.readObjective(14),
        );
        expect(snapshot.workItems).toHaveLength(size);
        expect(snapshot.workItems.every((item) => item.factoryEvents?.length === 1)).toBe(true);
        expect(trace).toHaveLength(calls.length);
        expect(trace.every((value) => value.kind === "read")).toBe(true);
        const nextProjection = digest({ ...snapshot, readAt: undefined });
        if (projection) expect(nextProjection).toBe(projection);
        projection = nextProjection;
        reports.push({
          size,
          mode,
          fixtureDigest: digest(detail),
          projection,
          reads: calls.length,
          writes: 0,
          total: calls.length,
          gitTransfers: 0,
          requestBytes: calls.reduce((sum, call) => sum + call.requestBytes, 0),
          responseBytes: calls.reduce((sum, call) => sum + call.responseBytes, 0),
          fullSnapshots: 1,
          receiptCount: size + 1,
          calls: [...calls],
          trace,
          limitations:
            "Read-only unchanged GitHubReader snapshot; no immutable hydration, Supervisor lifecycle, model, pacing, concurrency, simulated latency, or readiness. Warm-up is preceding cold read; restart uses identical durable server response.",
        });
      }
    }
    if (process.env.FACTORY_READER_COMPONENT_OUTPUT)
      await writeFile(
        process.env.FACTORY_READER_COMPONENT_OUTPUT,
        `${JSON.stringify(reports, null, 2)}\n`,
      );
  })().finally(() => {
    finished = true;
  });
  const settled = workload.catch(() => {});
  try {
    while (!finished) await vi.advanceTimersByTimeAsync(1000);
    await settled;
    await workload;
  } finally {
    vi.useRealTimers();
  }
}, 120_000);
