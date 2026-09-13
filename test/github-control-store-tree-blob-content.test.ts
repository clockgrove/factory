import { loadCompiledGraph, loadCompiledGraphProjection } from "../src/control/graphs.js";
import {
  compiledGraphDigest,
  serializeCompiledObjective,
  type CompiledObjective,
} from "../src/graph.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";

const TREE = "b".repeat(40);
const NEXT = "c".repeat(40);
const DATE = "Sun, 13 Sep 2026 00:00:00 GMT";
function blob(value: string | Buffer) {
  const content = Buffer.from(value);
  const sha = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  return { sha, encoding: "base64", content: content.toString("base64") };
}
function store(fetcher: typeof fetch) {
  return new GitHubControlStore({
    token: "tree-blob-fixture",
    owner: "o",
    repo: "r",
    requestFetch: fetcher,
  });
}
function response(value: unknown) {
  return Response.json(value, { headers: { date: DATE } });
}

describe("immutable tree and blob transport reuse", () => {
  it("coalesces blobs, returns independent buffers, and separates changed identities", async () => {
    const first = blob("first"),
      second = blob("second");
    let reads = 0;
    const port = store(async (input, init) => {
      reads++;
      return response(new Request(input, init).url.endsWith(first.sha) ? first : second);
    });
    const [a, b] = await Promise.all([port.readBlob(first.sha), port.readBlob(first.sha)]);
    a.fill(0);
    expect(b.toString()).toBe("first");
    expect((await port.readBlob(first.sha)).toString()).toBe("first");
    expect(reads).toBe(1);
    expect((await port.readBlob(second.sha)).toString()).toBe("second");
    expect(reads).toBe(2);
  });

  it("shares a complete tree across different paths but observes a new tree", async () => {
    const value = blob("content");
    let reads = 0;
    const port = store(async (input, init) => {
      reads++;
      const sha = new URL(new Request(input, init).url).pathname.split("/").at(-1);
      return response({
        sha,
        truncated: false,
        tree: ["a", "b"].map((path) => ({ path, type: "blob", sha: value.sha })),
      });
    });
    expect(
      await Promise.all([port.readTreeEntry(TREE, "a"), port.readTreeEntry(TREE, "b")]),
    ).toEqual([value.sha, value.sha]);
    expect(await port.readTreeEntry(TREE, "absent")).toBeNull();
    expect(reads).toBe(1);
    await port.readTreeEntry(NEXT, "a");
    expect(reads).toBe(2);
  });

  it("never retains malformed blob content or failed transport", async () => {
    const value = blob("valid");
    let reads = 0;
    const port = store(async () => {
      reads++;
      if (reads === 1)
        return response({ ...value, content: Buffer.from("wrong").toString("base64") });
      if (reads === 2)
        return Response.json({ message: "Not Found" }, { status: 404, headers: { date: DATE } });
      return response(value);
    });
    await expect(port.readBlob(value.sha)).rejects.toThrow("identity mismatch");
    await expect(port.readBlob(value.sha)).rejects.toThrow();
    expect((await port.readBlob(value.sha)).toString()).toBe("valid");
    await port.readBlob(value.sha);
    expect(reads).toBe(3);
  });

  it("never retains truncated or mismatched trees", async () => {
    let reads = 0;
    const port = store(async () => {
      reads++;
      return response({ sha: reads === 2 ? NEXT : TREE, truncated: reads === 1, tree: [] });
    });
    await expect(port.readTreeEntry(TREE, "a")).rejects.toThrow("truncated");
    await expect(port.readTreeEntry(TREE, "a")).rejects.toThrow("identity mismatch");
    expect(await port.readTreeEntry(TREE, "a")).toBeNull();
    expect(await port.readTreeEntry(TREE, "a")).toBeNull();
    expect(reads).toBe(3);
  });
});

function objective(goal = "Implement the feature."): CompiledObjective {
  return {
    title: "Ship feature",
    deferredCapabilityAdapters: [],
    workItems: [
      {
        id: "feature",
        title: "Implement feature",
        goal,
        acceptance: ["The feature is tested."],
        scope: ["src/feature.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: "d".repeat(40),
        validationCommands: ["npm test"],
        requirements: {
          os: [],
          architecture: [],
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
  };
}

it("loads graph and projection with nine cold transports and two fresh refs on a warm repeat", async () => {
  const graph = objective();
  const digest = compiledGraphDigest(graph);
  const graphBlob = blob(serializeCompiledObjective(graph));
  const receiptBlob = blob(
    JSON.stringify({
      protocol: "clockgrove.factory/compilation-receipt-v1",
      invocationId: "compile",
      graphDigest: digest,
      inputTokens: 1,
      outputTokens: 1,
    }),
  );
  const projectionBlob = blob(
    JSON.stringify({
      protocol: "clockgrove.factory/graph-projection-v1",
      graphDigest: digest,
      bindings: [{ compilerId: "feature", issueNodeId: "I_feature", issueNumber: 2 }],
    }),
  );
  const graphCommit = "1".repeat(40),
    projectionCommit = "2".repeat(40);
  const blobs = new Map(
    [graphBlob, receiptBlob, projectionBlob].map((value) => [value.sha, value]),
  );
  const paths: string[] = [];
  const port = store(async (input, init) => {
    const path = decodeURIComponent(new URL(new Request(input, init).url).pathname);
    paths.push(path);
    const oid = path.split("/").at(-1)!;
    if (path.includes("/git/ref/"))
      return response({
        object: { sha: path.includes("graph-projections") ? projectionCommit : graphCommit },
      });
    if (path.includes("/git/commits/"))
      return response({
        sha: oid,
        tree: { sha: oid === graphCommit ? TREE : NEXT },
        parents: oid === graphCommit ? [] : [{ sha: graphCommit }],
        message: "checkpoint",
      });
    if (path.includes("/git/blobs/")) return response(blobs.get(oid));
    if (path.includes("/git/trees/"))
      return response({
        sha: oid,
        truncated: false,
        tree: (oid === TREE
          ? [
              ["compiled-objective.json", graphBlob.sha],
              ["compilation-receipt.json", receiptBlob.sha],
            ]
          : [["graph-projection.json", projectionBlob.sha]]
        ).map(([name, sha]) => ({
          path: `.clockgrove-factory/control/${name}`,
          type: "blob",
          sha,
        })),
      });
    throw new Error(`unexpected transport ${path}`);
  });
  const read = async () => {
    const loaded = await loadCompiledGraph(port, 1, "run");
    expect(loaded!.graphDigest).toBe(digest);
    expect(
      (await loadCompiledGraphProjection(port, 1, "run", loaded!))!.bindings[0]!.issueNumber,
    ).toBe(2);
  };
  await read();
  expect(paths).toHaveLength(9);
  paths.length = 0;
  await read();
  expect(paths).toHaveLength(2);
  expect(paths.every((path) => path.includes("/git/ref/"))).toBe(true);
});
