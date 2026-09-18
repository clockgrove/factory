import { describe, expect, it, vi } from "vitest";
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
      if (
        request.method === "GET" &&
        target.pathname.includes("/git/ref/clockgrove-factory/integration-admissions/")
      )
        return Response.json(
          { message: "Not Found", documentation_url: "fixture", status: "404" },
          { status: 404, headers: { date: "Fri, 18 Sep 2026 18:00:00 GMT" } },
        );
      throw new Error("unexpected integration discovery request");
    },
  });
  return { store, calls };
}

describe("exact-commit Objective discovery hints", () => {
  it("uses only bounded commit associations and structural closing-issue parents, not historical scans", async () => {
    const f = fixture();
    expect(await f.store.readCommitObjectiveCandidates("a".repeat(40), "main")).toEqual([7, 12]);
    expect(f.calls).toEqual([`GET /repos/o/r/commits/${"a".repeat(40)}/pulls`, "POST /graphql"]);
  });
  it("unions an exact released integration-admission hint when provider association lags", async () => {
    const mergeSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const admissionOid = "c".repeat(40);
    const f = fixture({ count: 0 });
    vi.spyOn(f.store, "readRef").mockResolvedValue(admissionOid);
    vi.spyOn(f.store, "readCommit").mockResolvedValue({
      oid: admissionOid,
      treeOid: "d".repeat(40),
      parentOids: [baseSha],
      serverTime: new Date("2026-09-18T18:00:00.000Z"),
      message: `Factory default-branch integration\n\nFactory-Integration: ${Buffer.from(
        JSON.stringify({
          protocol: "clockgrove.factory/integration-admission-v1",
          identity: {
            repository: "o/r",
            branch: "main",
            objective: 19,
            runId: "peer-run",
            epoch: 1,
            pullRequest: 23,
            headSha: "e".repeat(40),
            baseSha,
            outputTreeSha: "f".repeat(40),
          },
          nonce: "00000000-0000-4000-8000-000000000019",
          preparedAt: "2026-09-18T17:59:00.000Z",
          state: "released",
          dispatch: {
            kind: "regular",
            pullRequest: 23,
            expectedHeadSha: "e".repeat(40),
          },
          outcome: { kind: "confirmed", mergeCommitShas: [mergeSha] },
        }),
      ).toString("base64url")}`,
    });
    expect(await f.store.readCommitObjectiveCandidates(mergeSha, "main")).toEqual([19]);
  });
  it("rejects malformed identities before I/O and refuses truncated association pages", async () => {
    const invalid = fixture();
    await expect(invalid.store.readCommitObjectiveCandidates("main", "main")).rejects.toThrow(
      "identity",
    );
    expect(invalid.calls).toEqual([]);
    const full = fixture({ count: 100 });
    await expect(full.store.readCommitObjectiveCandidates("a".repeat(40), "main")).rejects.toThrow(
      "bounded",
    );
    expect(full.calls).toHaveLength(1);
    const incomplete = fixture({ incomplete: true });
    await expect(
      incomplete.store.readCommitObjectiveCandidates("a".repeat(40), "main"),
    ).rejects.toThrow("bounded");
    expect(incomplete.calls).toHaveLength(2);
  });
});
