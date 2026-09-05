import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubControlStore } from "../src/control/github-store.js";
import { GitHubStacks, type GitHubStackTransport } from "../src/publication/github-stacks.js";
import { recoveryReadPort } from "../src/recovery/github-read-port.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const BLOB = "d".repeat(40);

function pullResponse(headRepository: Record<string, unknown> | null | undefined) {
  return {
    number: 23,
    node_id: "PR_fixture_23",
    state: "open",
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    draft: false,
    head: {
      ref: "factory/work-item-8",
      sha: HEAD,
      ...(headRepository === undefined ? {} : { repo: headRepository }),
    },
    base: { ref: "main", sha: BASE, repo: { full_name: "fixture/project" } },
    merge_commit_sha: null,
    created_at: "2026-09-04T00:00:00.000Z",
  };
}

function fixture(headRepository?: Record<string, unknown> | null) {
  const requests: Request[] = [];
  const beforeMutation = vi.fn(async () => {
    throw new Error("unexpected mutation hook");
  });
  const store = new GitHubControlStore({
    token: "test-token",
    owner: "fixture",
    repo: "project",
    beforeMutation,
    requestFetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.method).toBe("GET");
      const path = new URL(request.url).pathname.replace("/repos/fixture/project", "");
      let status = 200;
      let data: unknown;
      if (path === "")
        data = {
          full_name: "fixture/project",
          fork: false,
          private: true,
          default_branch: "main",
          permissions: { push: true },
        };
      else if (path.startsWith("/git/ref/")) data = { object: { sha: HEAD } };
      else if (path.startsWith("/git/matching-refs/"))
        data = [
          {
            ref: "refs/clockgrove-factory/attempts/objective-7/reservation",
            object: { sha: HEAD },
          },
        ];
      else if (path === `/git/commits/${HEAD}`)
        data = {
          sha: HEAD,
          tree: { sha: TREE },
          parents: [{ sha: BASE }],
          message: "fixture commit",
        };
      else if (path === `/git/blobs/${BLOB}`)
        data = { encoding: "base64", content: Buffer.from("fixture blob").toString("base64") };
      else if (path === `/git/trees/${TREE}`)
        data = { truncated: false, tree: [{ path: "control.json", type: "blob", sha: BLOB }] };
      else if (path === "/rules/branches/main") data = [];
      else if (path === "/branches/main/protection") {
        status = 404;
        data = { message: "Not Found" };
      } else if (path === `/commits/${HEAD}/check-runs`) data = { total_count: 0, check_runs: [] };
      else if (path === `/commits/${HEAD}/statuses`) data = [];
      else if (path === "/pulls/23") data = pullResponse(headRepository);
      else if (path === "/stacks/9")
        data = {
          number: 9,
          base: { ref: "main" },
          open: true,
          pull_requests: [
            {
              number: 23,
              state: "open",
              draft: false,
              merged_at: null,
              head: { ref: "factory/work-item-8", sha: HEAD },
              base: { ref: "main", sha: BASE },
            },
          ],
        };
      else throw new Error(`unhandled read fixture: ${path}`);
      return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json", date: "Fri, 04 Sep 2026 00:00:00 GMT" },
      });
    },
  });
  return { store, requests, beforeMutation };
}

afterEach(() => vi.restoreAllMocks());

describe("recovery GitHub read port", () => {
  it("exposes only frozen, explicitly bound read capabilities", async () => {
    const { store, requests, beforeMutation } = fixture();
    const port = recoveryReadPort(store, "fixture", "project");
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.keys(port).sort()).toEqual(
      [
        "readRef",
        "readCommit",
        "readBlob",
        "readTreeEntry",
        "listRefs",
        "readPullRequest",
        "getRepositoryFacts",
        "getBranchHead",
        "readBranchRules",
        "readChecks",
        "readStack",
      ].sort(),
    );
    expect(Object.getPrototypeOf(port)).toBe(Object.prototype);
    expect(() => Object.assign(port, { createRef: store.createRef.bind(store) })).toThrow(
      TypeError,
    );

    // Detach every method: a lost binding would fail on GitHubControlStore's private fields.
    const {
      readRef,
      readCommit,
      readBlob,
      readTreeEntry,
      listRefs,
      readPullRequest,
      getRepositoryFacts,
      getBranchHead,
      readBranchRules,
      readChecks,
      readStack,
    } = port;
    await expect(readRef("refs/heads/main")).resolves.toBe(HEAD);
    await expect(readCommit(HEAD)).resolves.toMatchObject({ oid: HEAD, treeOid: TREE });
    await expect(readBlob(BLOB)).resolves.toEqual(Buffer.from("fixture blob"));
    await expect(readTreeEntry(TREE, "control.json")).resolves.toBe(BLOB);
    await expect(listRefs("refs/clockgrove-factory/attempts/objective-7/")).resolves.toHaveLength(
      1,
    );
    await expect(readPullRequest(23)).resolves.toMatchObject({
      number: 23,
      nodeId: "PR_fixture_23",
    });
    await expect(getRepositoryFacts()).resolves.toMatchObject({
      fullName: "fixture/project",
      private: true,
    });
    await expect(getBranchHead("main")).resolves.toMatchObject({ oid: HEAD });
    await expect(readBranchRules("main")).resolves.toEqual([]);
    await expect(readChecks(HEAD)).resolves.toMatchObject({
      pending: [],
      failed: [],
      observed: [],
    });
    expect(typeof readStack).toBe("function");
    await expect(readStack!(9)).resolves.toMatchObject({ number: 9, open: true });
    expect(requests.length).toBeGreaterThan(11);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    const stackRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/stacks/9"),
    );
    expect(stackRequest?.headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(beforeMutation).not.toHaveBeenCalled();
  });

  it.each([
    ["POST /repos/{owner}/{repo}/stacks", false],
    ["GET /repos/{owner}/{repo}/stacks/{stack_number}", true],
  ] as const)(
    "refuses adapter request %s with mutation=%s before transport",
    async (route, mutating) => {
      const { store, requests, beforeMutation } = fixture();
      vi.spyOn(GitHubStacks.prototype, "get").mockImplementation(async function (
        this: GitHubStacks,
      ) {
        // Simulate a future adapter regression; the port must still enforce its boundary.
        const adapter = this as unknown as { transport: GitHubStackTransport };
        await adapter.transport.request(route, {}, mutating);
        throw new Error("read-only boundary unexpectedly allowed adapter mutation");
      });
      await expect(recoveryReadPort(store, "fixture", "project").readStack!(9)).rejects.toThrow(
        "recovery assessment cannot mutate GitHub",
      );
      expect(requests).toEqual([]);
      expect(beforeMutation).not.toHaveBeenCalled();
    },
  );
});

describe("recovery pull request identity", () => {
  it("preserves returned numeric/node identity, exact refs, and both repositories", async () => {
    const { store, beforeMutation } = fixture({ full_name: "contributor/fork" });
    await expect(store.readPullRequest(23)).resolves.toEqual({
      number: 23,
      nodeId: "PR_fixture_23",
      baseRepository: "fixture/project",
      headRepository: "contributor/fork",
      headRef: "factory/work-item-8",
      state: "open",
      merged: false,
      mergeable: true,
      mergeableState: "clean",
      draft: false,
      headSha: HEAD,
      baseSha: BASE,
      baseRef: "main",
      mergeCommitSha: null,
      createdAt: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(beforeMutation).not.toHaveBeenCalled();
  });

  it.each([null, undefined, {}])(
    "keeps unavailable head repository identity null (%j)",
    async (headRepository) => {
      const { store, beforeMutation } = fixture(headRepository);
      await expect(store.readPullRequest(23)).resolves.toMatchObject({ headRepository: null });
      expect(beforeMutation).not.toHaveBeenCalled();
    },
  );
});

describe("check-run snapshot completeness", () => {
  it.each([
    { total: 2, pageLengths: [1], complete: false },
    { total: 101, pageLengths: [100, 0], complete: false },
    { total: 101, pageLengths: [100, 1], complete: true },
  ])(
    "does not infer passing checks from partial pages: %j",
    async ({ total, pageLengths, complete }) => {
      const beforeMutation = vi.fn(async () => {
        throw new Error("unexpected mutation");
      });
      const checkPages: number[] = [];
      const store = new GitHubControlStore({
        token: "test-token",
        owner: "fixture",
        repo: "project",
        beforeMutation,
        requestFetch: async (input, init) => {
          const request = new Request(input, init);
          expect(request.method).toBe("GET");
          const url = new URL(request.url);
          if (url.pathname.endsWith("/statuses")) return Response.json([]);
          expect(url.pathname).toBe(`/repos/fixture/project/commits/${HEAD}/check-runs`);
          const page = Number(url.searchParams.get("page"));
          checkPages.push(page);
          const length = pageLengths[page - 1];
          if (length === undefined) throw new Error("unexpected extra page");
          return Response.json({
            total_count: total,
            check_runs: Array.from({ length }, (_, index) => ({
              name: `check-${page}-${index}`,
              status: "completed",
              conclusion: complete && page === 2 ? "failure" : "success",
              app: { id: 1 },
            })),
          });
        },
      });
      const result = recoveryReadPort(store, "fixture", "project").readChecks(HEAD);
      if (complete) await expect(result).resolves.toMatchObject({ failed: ["check-2-0"] });
      else await expect(result).rejects.toThrow("check-run history is incomplete");
      expect(checkPages).toEqual(pageLengths.map((_, index) => index + 1));
      expect(beforeMutation).not.toHaveBeenCalled();
    },
  );
});
