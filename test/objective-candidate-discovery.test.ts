import { describe, expect, it } from "vitest";

import { GitHubReader, OBJECTIVE_CANDIDATE_SCAN_LIMITS } from "../src/github.js";

function issue(number: number, title: string, labels: string[] = []) {
  return {
    number,
    title,
    labels: {
      totalCount: labels.length,
      nodes: labels.map((name) => ({ name })),
    },
  };
}

function response(
  nodes: ReturnType<typeof issue>[],
  totalCount: number,
  nextCursor: string | null = null,
) {
  return Response.json({
    data: {
      repository: {
        issues: {
          totalCount,
          nodes,
          pageInfo: { hasNextPage: nextCursor !== null, endCursor: nextCursor },
        },
      },
    },
  });
}

describe("natural-language Objective candidate discovery", () => {
  it("finds canonical unlabeled and explicitly labelled open Objectives without reading bodies", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const reader = new GitHubReader({
      token: "objective-candidate-fixture",
      owner: "o",
      repo: "r",
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe("/graphql");
        const body = (await request.json()) as {
          query: string;
          variables: Record<string, unknown>;
        };
        requests.push(body);
        return response(
          [
            issue(1, "Ordinary bug"),
            issue(2, "Objective: Build the product"),
            issue(3, "Legacy project goal", ["factory:objective", "priority:now"]),
            issue(4, "Discuss Objective: naming"),
            issue(5, "  objective : lowercase is accepted"),
          ],
          5,
        );
      },
    });

    await expect(reader.discoverObjectiveCandidates()).resolves.toEqual({
      repository: "o/r",
      activationAuthorized: false,
      candidates: [
        {
          number: 2,
          title: "Objective: Build the product",
          matchedBy: { objectiveLabel: false, canonicalTitle: true },
        },
        {
          number: 3,
          title: "Legacy project goal",
          matchedBy: { objectiveLabel: true, canonicalTitle: false },
        },
        {
          number: 5,
          title: "  objective : lowercase is accepted",
          matchedBy: { objectiveLabel: false, canonicalTitle: true },
        },
      ],
      scan: {
        complete: true,
        scannedOpenIssues: 5,
        totalOpenIssues: 5,
        pageLimit: 5,
        issuesPerPage: 100,
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).toContain("states: [OPEN]");
    expect(requests[0]!.query).toContain("direction: DESC");
    expect(requests[0]!.query).not.toMatch(/\bbody\b/);
    expect(requests[0]!.variables).toEqual({ owner: "o", repo: "r", after: null });
  });

  it("stops at the fixed page bound and reports that one returned candidate is not unique proof", async () => {
    let page = 0;
    const reader = new GitHubReader({
      token: "objective-candidate-page-bound",
      owner: "o",
      repo: "r",
      requestFetch: async () => {
        page++;
        return response(
          Array.from({ length: 100 }, (_, index) =>
            issue(
              (page - 1) * 100 + index + 1,
              page === 1 && index === 0 ? "Objective: One" : `Issue ${index}`,
            ),
          ),
          600,
          `page-${page + 1}`,
        );
      },
    });

    const result = await reader.discoverObjectiveCandidates();
    expect(page).toBe(OBJECTIVE_CANDIDATE_SCAN_LIMITS.pages);
    expect(result.candidates).toHaveLength(1);
    expect(result.scan).toMatchObject({
      complete: false,
      scannedOpenIssues: 500,
      totalOpenIssues: 600,
    });
  });

  it("marks candidate coverage incomplete when GitHub truncates an issue's labels", async () => {
    const reader = new GitHubReader({
      token: "objective-candidate-label-bound",
      owner: "o",
      repo: "r",
      requestFetch: async () =>
        Response.json({
          data: {
            repository: {
              issues: {
                totalCount: 1,
                nodes: [
                  {
                    ...issue(1, "Objective: Label-heavy"),
                    labels: { totalCount: 101, nodes: [{ name: "one-of-many" }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
    });

    const result = await reader.discoverObjectiveCandidates();
    expect(result.candidates).toHaveLength(1);
    expect(result.scan.complete).toBe(false);
  });
});
