import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CompiledGraphManager,
  loadCompiledGraph,
  loadCompiledGraphProjection,
  type CompiledGraphReadStore,
  type CompiledGraphStore,
} from "../src/control/graphs.js";
import { ReviewCheckpointManager } from "../src/control/reviews.js";
import { LeaseManager, type GitCommitObject, type LeaseStore } from "../src/control/lease.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { workerPacketFromCompiled, type CompiledObjective } from "../src/graph.js";
import {
  compileObjective,
  serializeCompilerObjective,
  validateCompiledObjective,
  type CompileInput,
} from "../src/compiler/index.js";

const BASE_SHA = "a".repeat(40);
const BASE_TREE = "b".repeat(40);

class MemoryGraphStore implements LeaseStore, CompiledGraphStore {
  now = new Date("2026-09-03T00:00:00.000Z");
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>();
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  next = 1;

  constructor() {
    this.commits.set(BASE_SHA, {
      oid: BASE_SHA,
      treeOid: BASE_TREE,
      parentOids: [],
      message: "base",
      serverTime: this.now,
    });
    this.trees.set(BASE_TREE, new Map());
  }

  #oid(): string {
    return (this.next++).toString(16).padStart(40, "0");
  }

  async readRef(ref: string): Promise<string | null> {
    return this.refs.get(ref) ?? null;
  }

  async readCommit(oid: string): Promise<GitCommitObject> {
    const commit = this.commits.get(oid);
    if (!commit) throw new Error(`missing commit ${oid}`);
    return commit;
  }

  async createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string> {
    const oid = this.#oid();
    this.commits.set(oid, {
      oid,
      treeOid: args.treeOid,
      parentOids: args.parentOids,
      message: args.message,
      serverTime: this.now,
    });
    return oid;
  }

  async createRef(ref: string, oid: string): Promise<boolean> {
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    return true;
  }

  async compareAndSwapRef(args: {
    ref: string;
    beforeOid: string;
    afterOid: string;
  }): Promise<boolean> {
    if (this.refs.get(args.ref) !== args.beforeOid) return false;
    this.refs.set(args.ref, args.afterOid);
    return true;
  }

  async serverTime(): Promise<Date> {
    return this.now;
  }

  async createBlob(content: Buffer): Promise<string> {
    const oid = createHash("sha1").update(content).digest("hex");
    this.blobs.set(oid, Buffer.from(content));
    return oid;
  }

  async readBlob(oid: string): Promise<Buffer> {
    const blob = this.blobs.get(oid);
    if (!blob) throw new Error(`missing blob ${oid}`);
    return Buffer.from(blob);
  }

  async createTree(args: {
    baseTreeOid?: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }): Promise<string> {
    const tree = new Map(args.baseTreeOid ? (this.trees.get(args.baseTreeOid) ?? []) : []);
    for (const entry of args.entries) {
      if (entry.sha) tree.set(entry.path, entry.sha);
      else tree.delete(entry.path);
    }
    const oid = this.#oid();
    this.trees.set(oid, tree);
    return oid;
  }

  async readTreeEntry(treeOid: string, path: string): Promise<string | null> {
    return this.trees.get(treeOid)?.get(path) ?? null;
  }
}

function objective(goal = "Implement the feature."): CompiledObjective {
  return {
    title: "Ship feature",
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
        baseSha: BASE_SHA,
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

describe("durable compiled graph", () => {
  it("loads graph and projection using only a frozen read-only port, without a lease", async () => {
    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(
      {
        objective: 42,
        runId: "read-only",
        holder: "director",
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      },
      base,
    );
    const manager = new CompiledGraphManager(store, leases);
    const graph = await manager.persist({ lease, base, objective: objective() });
    const projection = await manager.persistProjection({
      lease,
      graph,
      bindings: [{ compilerId: "feature", issueNodeId: "issue-43", issueNumber: 43 }],
    });
    const reads: CompiledGraphReadStore = Object.freeze({
      readRef: store.readRef.bind(store),
      readCommit: store.readCommit.bind(store),
      readBlob: store.readBlob.bind(store),
      readTreeEntry: store.readTreeEntry.bind(store),
    });
    const before = structuredClone({ refs: store.refs, commits: store.commits, next: store.next });
    await expect(loadCompiledGraph(reads, 42, "read-only")).resolves.toEqual(graph);
    await expect(loadCompiledGraphProjection(reads, 42, "read-only", graph)).resolves.toEqual(
      projection,
    );
    await expect(loadCompiledGraph(reads, 42, "absent")).resolves.toBeNull();
    await expect(loadCompiledGraphProjection(reads, 42, "absent", graph)).resolves.toBeNull();
    expect({ refs: store.refs, commits: store.commits, next: store.next }).toEqual(before);

    store.commits.get(projection.commitOid)!.parentOids = [BASE_SHA];
    await expect(loadCompiledGraphProjection(reads, 42, "read-only", graph)).rejects.toThrow(
      "not bound to its immutable graph commit",
    );
  });

  it.each([
    ["compiled-objective.json", 2 * 1024 * 1024, "compiled graph exceeds 2 MiB"],
    ["compilation-receipt.json", 16 * 1024, "compilation receipt exceeds 16 KiB"],
    ["graph-projection.json", 256 * 1024, "compiled graph projection exceeds 256 KiB"],
  ] as const)("read-only loading retains the %s size bound", async (path, limit, message) => {
    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(
      {
        objective: 42,
        runId: "bounded",
        holder: "director",
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      },
      base,
    );
    const manager = new CompiledGraphManager(store, leases);
    const graph = await manager.persist({
      lease,
      base,
      objective: objective(),
      compilation: { invocationId: "compile", inputTokens: 1, outputTokens: 1 },
    });
    const projection = await manager.persistProjection({
      lease,
      graph,
      bindings: [{ compilerId: "feature", issueNodeId: "issue-43", issueNumber: 43 }],
    });
    const projectionPath = path === "graph-projection.json";
    const commit = await store.readCommit(projectionPath ? projection.commitOid : graph.commitOid);
    const blob = await store.readTreeEntry(commit.treeOid, `.clockgrove-factory/control/${path}`);
    store.blobs.set(blob!, Buffer.alloc(limit + 1));
    await expect(
      projectionPath
        ? loadCompiledGraphProjection(store, 42, "bounded", graph)
        : loadCompiledGraph(store, 42, "bounded"),
    ).rejects.toThrow(message);
  });

  it("persists before issue creation and replays the exact graph", async () => {
    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(
      {
        objective: 42,
        runId: "run-1",
        holder: "director-1",
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      },
      base,
    );
    const manager = new CompiledGraphManager(store, leases);
    const first = await manager.persist({
      lease,
      base,
      objective: objective(),
    });
    const replay = await manager.load(42, "run-1");
    expect(replay).toMatchObject({
      ref: first.ref,
      blobOid: first.blobOid,
      graphDigest: first.graphDigest,
      graphSize: 1,
      objective: objective(),
    });
    expect(await manager.persist({ lease, base, objective: objective() })).toMatchObject({
      commitOid: first.commitOid,
      graphDigest: first.graphDigest,
    });
  });

  it.each([undefined, 0, 7])(
    "atomically persists compilation usage with cached=%s and recovers a lost ref response",
    async (cached) => {
      const store = new MemoryGraphStore();
      const leases = new LeaseManager({ store });
      const base = await store.readCommit(BASE_SHA);
      const lease = await leases.acquire(
        {
          objective: 42,
          runId: "run-usage",
          holder: "director-1",
          policyDigest: policyDigest(DEFAULT_RUN_POLICY),
        },
        base,
      );
      const manager = new CompiledGraphManager(store, leases);
      const createRef = store.createRef.bind(store);
      let loseResponse = true;
      store.createRef = async (ref, oid) => {
        const created = await createRef(ref, oid);
        if (loseResponse && ref.includes("/graphs/")) {
          loseResponse = false;
          throw new Error("response lost after ref creation");
        }
        return created;
      };

      const saved = await manager.persist({
        lease,
        base,
        objective: objective(),
        compilation: {
          invocationId: `compile-${BASE_SHA}`,
          inputTokens: 11,
          outputTokens: 19,
          ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        },
      });

      expect(saved.compilation).toMatchObject({
        invocationId: `compile-${BASE_SHA}`,
        graphDigest: saved.graphDigest,
        inputTokens: 11,
        outputTokens: 19,
      });
      await expect(manager.load(42, "run-usage")).resolves.toMatchObject({
        graphDigest: saved.graphDigest,
        compilation: saved.compilation,
      });
      expect(saved.compilation?.cachedInputTokens).toBe(cached);
      if (cached === undefined) expect(saved.compilation).not.toHaveProperty("cachedInputTokens");
      await expect(
        manager.persist({
          lease,
          base,
          objective: objective(),
          compilation: { ...saved.compilation!, cachedInputTokens: 3 },
        }),
      ).rejects.toThrow(/different compiled graph|different immutable|already has/i);
      for (const invalid of [-1, 0.5, 12, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(
          manager.persist({
            lease,
            base,
            objective: objective(),
            compilation: { ...saved.compilation!, cachedInputTokens: invalid },
          }),
        ).rejects.toThrow();
      }
      await expect(manager.load(42, "run-usage")).resolves.toMatchObject({
        commitOid: saved.commitOid,
        compilation: saved.compilation,
      });
    },
  );

  it("rejects a divergent replay for the same run", async () => {
    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(
      {
        objective: 42,
        runId: "run-1",
        holder: "director-1",
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      },
      base,
    );
    const manager = new CompiledGraphManager(store, leases);
    await manager.persist({ lease, base, objective: objective() });
    await expect(
      manager.persist({
        lease,
        base,
        objective: objective("Implement something else."),
      }),
    ).rejects.toThrow(/different immutable compiled graph/i);
  });

  it("round-trips vNext compiler metadata while preserving legacy graphs", async () => {
    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(
      {
        objective: 42,
        runId: "run-vnext",
        holder: "director-1",
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      },
      base,
    );
    const manager = new CompiledGraphManager(store, leases);
    const workItem = {
      ...objective().workItems[0]!,
      context: {
        mustRead: ["src/feature.ts"],
        searchSeeds: ["feature"],
        dependencyEvidence: [],
      },
      changeSurface: {
        mergeClass: "parallel-safe" as const,
        exclusiveResources: [],
      },
      validation: [{ tier: "mechanical" as const, criteria: ["The feature is tested."] }],
      delivery: { group: "feature", relationship: "root" as const },
      economicReview: {
        conservative: true,
        rationale: "Uses repository-observed validation only.",
        paidMeasurementRequired: false,
      },
    };

    await manager.persist({
      lease,
      base,
      objective: { title: "Ship feature", workItems: [workItem] },
    });
    const replay = await manager.load(42, "run-vnext");

    expect(replay?.objective.workItems[0]).toMatchObject({
      context: workItem.context,
      changeSurface: workItem.changeSurface,
      validation: workItem.validation,
      delivery: workItem.delivery,
      economicReview: workItem.economicReview,
    });
    expect(workerPacketFromCompiled(replay!.objective.workItems[0]!)).toMatchObject({
      context: workItem.context,
      changeSurface: workItem.changeSurface,
      delivery: workItem.delivery,
    });
  });

  it("durably restores the exact compiler-ID to GitHub issue projection after restart", async () => {
    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(
      {
        objective: 42,
        runId: "run-projection",
        holder: "director-1",
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      },
      base,
    );
    const manager = new CompiledGraphManager(store, leases);
    const graph = await manager.persist({ lease, base, objective: objective() });
    const bindings = [{ compilerId: "feature", issueNodeId: "I_kwDOFeature", issueNumber: 73 }];
    const createRef = store.createRef.bind(store);
    let loseResponse = true;
    store.createRef = async (ref, oid) => {
      const created = await createRef(ref, oid);
      if (loseResponse && ref.includes("/graph-projections/")) {
        loseResponse = false;
        throw new Error("response lost after projection ref creation");
      }
      return created;
    };
    const saved = await manager.persistProjection({ lease, graph, bindings });

    const restarted = new CompiledGraphManager(store, leases);
    await expect(restarted.loadProjection(42, "run-projection", graph)).resolves.toMatchObject({
      ref: saved.ref,
      graphDigest: graph.graphDigest,
      bindings,
    });
    await expect(
      restarted.persistProjection({
        lease,
        graph,
        bindings: [{ ...bindings[0]!, issueNumber: 74 }],
      }),
    ).rejects.toThrow(/different immutable graph projection/i);
  });
});

describe("durable semantic review", () => {
  it.each([undefined, 0, 9])(
    "binds result and usage with cached=%s to exact input and recovers a lost ref response",
    async (cached) => {
      const store = new MemoryGraphStore();
      const leases = new LeaseManager({ store });
      const base = await store.readCommit(BASE_SHA);
      const lease = await leases.acquire(
        {
          objective: 42,
          runId: "run-review",
          holder: "director-1",
          policyDigest: policyDigest(DEFAULT_RUN_POLICY),
        },
        base,
      );
      const manager = new ReviewCheckpointManager(store, leases);
      const identity = {
        kind: "artifact" as const,
        runId: "run-review",
        objective: 42,
        workItem: 7,
        attempt: 1,
        artifactDigest: "c".repeat(64),
        baseSha: BASE_SHA,
        outputTreeSha: BASE_TREE,
        evidenceDigest: "d".repeat(64),
      };
      const createRef = store.createRef.bind(store);
      let loseResponse = true;
      store.createRef = async (ref, oid) => {
        const created = await createRef(ref, oid);
        if (loseResponse && ref.includes("/reviews/")) {
          loseResponse = false;
          throw new Error("response lost after ref creation");
        }
        return created;
      };
      const saved = await manager.persist({
        lease,
        identity,
        result: {
          review: {
            accepted: true,
            summary: "All criteria are satisfied.",
            unmetCriteria: [],
            risks: [],
          },
          usage: {
            inputTokens: 13,
            outputTokens: 17,
            ...(cached === undefined ? {} : { cachedInputTokens: cached }),
          },
        },
      });

      expect(saved).toMatchObject({
        identity,
        review: { accepted: true },
        usage: { inputTokens: 13, outputTokens: 17 },
      });
      await expect(manager.load(identity)).resolves.toMatchObject({
        ref: saved.ref,
        identityDigest: saved.identityDigest,
        usage: saved.usage,
      });
      await expect(
        manager.load({ ...identity, artifactDigest: "e".repeat(64) }),
      ).resolves.toBeNull();
      expect(saved.usage.cachedInputTokens).toBe(cached);
      if (cached === undefined) expect(saved.usage).not.toHaveProperty("cachedInputTokens");
      await expect(
        manager.persist({
          lease,
          identity,
          result: {
            review: saved.review,
            usage: { ...saved.usage, cachedInputTokens: 3 },
          },
        }),
      ).rejects.toThrow(/different immutable review result/);
      for (const invalid of [-1, 0.5, 14, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(
          manager.persist({
            lease,
            identity,
            result: {
              review: saved.review,
              usage: { ...saved.usage, cachedInputTokens: invalid },
            },
          }),
        ).rejects.toThrow();
      }
      await expect(manager.load(identity)).resolves.toMatchObject({
        commitOid: saved.commitOid,
        usage: saved.usage,
      });
    },
  );
});

describe("golden compiled graph", () => {
  it("compiles a checked-in fixture byte-equivalently across enumeration order", async () => {
    const fixture = new URL("./fixtures/compiler/golden-objective.json", import.meta.url);
    const input = JSON.parse(await readFile(fixture, "utf8")) as CompileInput;
    const first = compileObjective(input);
    const reversed = compileObjective({
      ...input,
      repositoryFacts: {
        ...input.repositoryFacts,
        files: [...input.repositoryFacts.files].reverse(),
        scripts: Object.fromEntries(Object.entries(input.repositoryFacts.scripts ?? {}).reverse()),
      },
      workItems: [...input.workItems].reverse().map((item) => ({
        ...item,
        acceptance: [...item.acceptance].reverse(),
        scope: [...item.scope].reverse(),
      })),
    });
    const observedCommands = ["npm test", "npm run typecheck"];

    validateCompiledObjective(first, observedCommands);
    validateCompiledObjective(reversed, observedCommands);
    expect(serializeCompilerObjective(first)).toBe(serializeCompilerObjective(reversed));
    expect(new TextEncoder().encode(serializeCompilerObjective(first))).toEqual(
      new TextEncoder().encode(serializeCompilerObjective(reversed)),
    );

    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(
      {
        objective: 42,
        runId: "run-golden-compiler",
        holder: "director-1",
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      },
      base,
    );
    const manager = new CompiledGraphManager(store, leases);
    await manager.persist({ lease, base, objective: first });
    const replay = await manager.load(42, "run-golden-compiler");
    expect(serializeCompilerObjective(replay!.objective as typeof first)).toBe(
      serializeCompilerObjective(first),
    );
  });
});
