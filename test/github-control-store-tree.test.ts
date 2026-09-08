import { describe, expect, it } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";

const ROOT = "a".repeat(40);
const LEVEL = "b".repeat(40);
const DIRECTORY = "c".repeat(40);
const MARKER = "d".repeat(40);

function response(tree: unknown[], truncated = false) {
  return Response.json({ truncated, tree });
}

describe("bounded Git tree directory reads", () => {
  it("walks each path component without a recursive tree materialization", async () => {
    const requests: Request[] = [];
    const store = new GitHubControlStore({
      token: "fixture-only",
      owner: "o",
      repo: "r",
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const oid = new URL(request.url).pathname.split("/").at(-1);
        if (oid === ROOT) return response([{ path: "retired", type: "tree", sha: LEVEL }]);
        if (oid === LEVEL) return response([{ path: "claim", type: "tree", sha: DIRECTORY }]);
        if (oid === DIRECTORY) return response([{ path: "digest", type: "blob", sha: MARKER }]);
        throw new Error(`unexpected tree ${oid}`);
      },
    });

    await expect(store.readTreeDirectory(ROOT, "retired/claim")).resolves.toEqual([
      { name: "digest", type: "blob", sha: MARKER },
    ]);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => !new URL(request.url).searchParams.has("recursive"))).toBe(
      true,
    );
  });

  it("returns absence and rejects a non-directory path component", async () => {
    const absent = new GitHubControlStore({
      token: "fixture-only",
      owner: "o",
      repo: "r",
      requestFetch: async () => response([]),
    });
    await expect(absent.readTreeDirectory(ROOT, "retired/claim")).resolves.toBeNull();

    const invalid = new GitHubControlStore({
      token: "fixture-only",
      owner: "o",
      repo: "r",
      requestFetch: async () => response([{ path: "retired", type: "blob", sha: MARKER }]),
    });
    await expect(invalid.readTreeDirectory(ROOT, "retired/claim")).rejects.toThrow(
      "crosses non-directory entry",
    );
  });

  it("fails closed when any traversed directory is truncated", async () => {
    const store = new GitHubControlStore({
      token: "fixture-only",
      owner: "o",
      repo: "r",
      requestFetch: async () => response([], true),
    });
    await expect(store.readTreeDirectory(ROOT, "retired/claim")).rejects.toThrow("was truncated");
  });
});
