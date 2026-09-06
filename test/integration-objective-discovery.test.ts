import { describe, expect, it } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";

function fixture(input: { count?: number; incomplete?: boolean } = {}) {
  const calls: string[] = [];
  const store = new GitHubControlStore({
    token: "fixture-only",
    owner: "o",
    repo: "r",
    requestFetch: async (url, init) => {
      const request = new Request(url, init);
      const target = new URL(request.url);
      calls.push(`${request.method} ${target.pathname}`);
      if (request.method === "GET" && target.pathname.endsWith("/pulls")) {
        expect(target.searchParams.get("per_page")).toBe("100");
        return Response.json(
          Array.from({ length: input.count ?? 1 }, (_, index) => ({
            number: index + 10,
            node_id: `PR_${index}`,
            head: { ref: "factory/objective-7/work-item-8/attempt-1" },
          })),
        );
      }
      if (request.method === "POST" && target.pathname === "/graphql") {
        const body = (await request.json()) as { query: string; variables: { ids: string[] } };
        expect(body.query).toContain("query IntegrationObjectiveHints");
        expect(body.query).not.toContain("mutation");
        expect(body.variables.ids).toEqual(["PR_0"]);
        return Response.json({
          data: {
            nodes: [
              {
                closingIssuesReferences: {
                  nodes: [{ parent: { number: 7 } }, { parent: { number: 12 } }, { parent: null }],
                  pageInfo: { hasNextPage: Boolean(input.incomplete) },
                },
              },
            ],
          },
        });
      }
      throw new Error("unexpected integration discovery request");
    },
  });
  return { store, calls };
}

describe("exact-commit Objective discovery hints", () => {
  it("uses only bounded commit associations and structural closing-issue parents, not historical scans", async () => {
    const f = fixture();
    expect(await f.store.readCommitObjectiveCandidates("a".repeat(40))).toEqual([7, 12]);
    expect(f.calls).toEqual([`GET /repos/o/r/commits/${"a".repeat(40)}/pulls`, "POST /graphql"]);
  });
  it("rejects malformed identities before I/O and refuses truncated association pages", async () => {
    const invalid = fixture();
    await expect(invalid.store.readCommitObjectiveCandidates("main")).rejects.toThrow("identity");
    expect(invalid.calls).toEqual([]);
    const full = fixture({ count: 100 });
    await expect(full.store.readCommitObjectiveCandidates("a".repeat(40))).rejects.toThrow(
      "bounded",
    );
    expect(full.calls).toHaveLength(1);
    const incomplete = fixture({ incomplete: true });
    await expect(incomplete.store.readCommitObjectiveCandidates("a".repeat(40))).rejects.toThrow(
      "bounded",
    );
    expect(incomplete.calls).toHaveLength(2);
  });
});
