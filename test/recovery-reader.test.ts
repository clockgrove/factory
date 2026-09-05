import { describe, expect, it } from "vitest";

import { GitHubReader, RECOVERY_READER_LIMITS } from "../src/github.js";

const comment = {
  body: "fixture comment",
  author: { login: "operator" },
  authorAssociation: "OWNER",
};
const restComment = {
  body: "fixture comment",
  user: { login: "operator" },
  author_association: "OWNER",
};
function pull(number: number) {
  return {
    id: `PR_${number}`,
    number,
    state: "OPEN",
    isDraft: false,
    title: "fixture",
    body: "fixture",
    mergeable: "MERGEABLE",
    createdAt: "2026-09-04T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    files: { nodes: [] },
    commits: { nodes: [] },
    statusCheckRollup: {
      nodes: [
        {
          commit: {
            oid: "a".repeat(40),
            committedDate: "2026-09-04T00:00:00Z",
            statusCheckRollup: { state: "SUCCESS" },
            checkSuites: { nodes: [] },
          },
        },
      ],
    },
  };
}
function item(number = 8, pulls: ReturnType<typeof pull>[] = []) {
  const links: {
    nodes: ReturnType<typeof pull>[];
    totalCount?: number;
    pageInfo?: { hasNextPage: boolean };
  } = {
    nodes: pulls,
    totalCount: pulls.length,
    pageInfo: { hasNextPage: false },
  };
  return {
    id: `I_${number}`,
    number,
    title: "fixture",
    body: "fixture",
    state: "OPEN",
    comments: { totalCount: 0, nodes: [] as (typeof comment)[] },
    assignees: { nodes: [] },
    labels: { nodes: [] },
    blockedBy: { totalCount: 0, nodes: [] },
    closedByPullRequestsReferences: links,
    timelineItems: { nodes: [] },
  };
}
function fixture() {
  const data = {
    rateLimit: { cost: 1, limit: 5000, remaining: 4900, resetAt: "2026-09-04T02:00:00Z" },
    repository: {
      id: "R_fixture",
      defaultBranchRef: { name: "main" },
      workItemLabel: null,
      suggestedActors: { nodes: [] },
      issue: {
        id: "I_7",
        number: 7,
        title: "fixture",
        body: "fixture",
        state: "OPEN",
        author: { login: "operator" },
        authorAssociation: "OWNER",
        comments: { totalCount: 0, nodes: [] as (typeof comment)[] },
        subIssues: { totalCount: 1, nodes: [item()] },
      },
    },
  };
  const requests: Request[] = [];
  const queries: string[] = [];
  let comments: (page: number) => unknown[] = () => [];
  let timeline: (page: number) => unknown[] = () => [];
  const create = (recoveryInspection = true) =>
    new GitHubReader({
      token: "test-token",
      owner: "fixture",
      repo: "project",
      recoveryInspection,
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/graphql") {
          expect(request.method).toBe("POST");
          const body = (await request.json()) as { query: string };
          expect(body.query.trimStart().startsWith("query ")).toBe(true);
          queries.push(body.query);
          return Response.json({
            data: body.query.includes("ObjectiveCardinality")
              ? {
                  repository: {
                    issue: {
                      subIssues: { totalCount: data.repository.issue.subIssues.totalCount },
                    },
                  },
                }
              : data,
          });
        }
        expect(request.method).toBe("GET");
        if (url.pathname.endsWith("/comments"))
          return Response.json(comments(Number(url.searchParams.get("page"))));
        if (url.pathname.endsWith("/timeline"))
          return Response.json(timeline(Number(url.searchParams.get("page"))));
        if (url.pathname.endsWith("/actions/runs"))
          return Response.json({ total_count: 0, workflow_runs: [] });
        throw new Error("Unexpected injected request");
      },
    });
  return {
    data,
    requests,
    queries,
    create,
    comments: (read: typeof comments) => {
      comments = read;
    },
    timeline: (read: typeof timeline) => {
      timeline = read;
    },
  };
}
const pages = (requests: Request[], path: string) =>
  requests.filter((request) => new URL(request.url).pathname.endsWith(path));

describe("bounded recovery snapshot reader", () => {
  it("hydrates complete history and requests linked-PR completeness only in recovery mode", async () => {
    const f = fixture();
    f.data.repository.issue.comments = { totalCount: 201, nodes: [comment] };
    f.comments((page) => Array.from({ length: page <= 2 ? 100 : 1 }, () => restComment));
    await expect(f.create().readObjective(7)).resolves.toMatchObject({ number: 7 });
    expect(pages(f.requests, "/comments")).toHaveLength(3);
    expect(f.queries[1]).toContain("totalCount pageInfo { hasNextPage }");
    const normal = fixture();
    delete normal.data.repository.issue.subIssues.nodes[0]!.closedByPullRequestsReferences.pageInfo;
    await expect(normal.create(false).readObjective(7)).resolves.toMatchObject({ number: 7 });
    expect(normal.queries[1]).not.toContain("totalCount pageInfo { hasNextPage }");
  });

  it.each(["truncated", "count-mismatch", "missing-page-info", "missing-count"])(
    "refuses %s linked-PR observations before interpreting missing competitors",
    async (kind) => {
      const f = fixture();
      const links = f.data.repository.issue.subIssues.nodes[0]!.closedByPullRequestsReferences;
      if (kind === "truncated") links.pageInfo = { hasNextPage: true };
      if (kind === "count-mismatch") links.totalCount = 21;
      if (kind === "missing-page-info") delete links.pageInfo;
      if (kind === "missing-count") delete links.totalCount;
      await expect(f.create().readObjective(7)).rejects.toThrow(
        "linked pull-request history is incomplete",
      );
      expect(f.requests).toHaveLength(2);
    },
  );

  it("rejects oversized observed comment cardinality before hydrating pages", async () => {
    const f = fixture();
    f.data.repository.issue.comments.totalCount = RECOVERY_READER_LIMITS.commentsPerIssue + 1;
    await expect(f.create().readObjective(7)).rejects.toThrow("per-issue bound");
    expect(pages(f.requests, "/comments")).toEqual([]);
  });

  it("rejects a history that grows while comments are being hydrated", async () => {
    const f = fixture();
    f.data.repository.issue.comments.totalCount = 101;
    f.comments((page) => Array.from({ length: page === 1 ? 100 : 2 }, () => restComment));
    await expect(f.create().readObjective(7)).rejects.toThrow("changed during bounded hydration");
    expect(pages(f.requests, "/comments")).toHaveLength(2);
  });

  it("caps a full timeline without requesting another page or returning partial evidence", async () => {
    const f = fixture();
    f.data.repository.issue.subIssues.nodes = [item(8, [pull(23)])];
    f.timeline(() => Array.from({ length: 100 }, () => ({ event: "commented" })));
    await expect(f.create().readObjective(7)).rejects.toThrow("timeline exceeded its page bound");
    expect(pages(f.requests, "/timeline")).toHaveLength(
      RECOVERY_READER_LIMITS.timelinePagesPerPullRequest,
    );
  });

  it("shares the hydration page budget across all Work Item PRs", async () => {
    const f = fixture();
    f.data.repository.issue.subIssues.totalCount = 7;
    f.data.repository.issue.subIssues.nodes = Array.from({ length: 7 }, (_, index) =>
      item(
        index + 8,
        Array.from({ length: 20 }, (_, position) => pull(index * 20 + position + 100)),
      ),
    );
    await expect(f.create().readObjective(7)).rejects.toThrow("shared history-page request bound");
    expect(pages(f.requests, "/timeline")).toHaveLength(RECOVERY_READER_LIMITS.hydrationRequests);
  });

  it("caps hydrated bytes even when record counts are small", async () => {
    const f = fixture();
    f.data.repository.issue.comments.totalCount = 1;
    f.comments(() => [{ ...restComment, body: "x".repeat(RECOVERY_READER_LIMITS.hydratedBytes) }]);
    await expect(f.create().readObjective(7)).rejects.toThrow("shared hydrated-history size bound");
    expect(pages(f.requests, "/comments")).toHaveLength(1);
  });
});
