import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CompiledGraphManager,
  type CompiledGraphStore,
} from "../src/control/graphs.js";
import {
  LeaseManager,
  type GitCommitObject,
  type LeaseStore,
} from "../src/control/lease.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import type { CompiledObjective } from "../src/graph.js";

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

  async createCommit(args: { treeOid: string; parentOids: string[]; message: string }): Promise<string> {
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

  async compareAndSwapRef(args: { ref: string; beforeOid: string; afterOid: string }): Promise<boolean> {
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
    entries: Array<{ path: string; mode: "100644" | "100755" | "120000"; type: "blob"; sha: string | null }>;
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
    workItems: [{
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
        os: [], architecture: [], tools: [], services: [], networkDestinations: [],
        permittedSecretNames: [], trust: "trusted_local",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    }],
  };
}

describe("durable compiled graph", () => {
  it("persists before issue creation and replays the exact graph", async () => {
    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire({
      objective: 42,
      runId: "run-1",
      holder: "director-1",
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    }, base);
    const manager = new CompiledGraphManager(store, leases);
    const first = await manager.persist({ lease, base, objective: objective() });
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

  it("rejects a divergent replay for the same run", async () => {
    const store = new MemoryGraphStore();
    const leases = new LeaseManager({ store });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire({
      objective: 42,
      runId: "run-1",
      holder: "director-1",
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    }, base);
    const manager = new CompiledGraphManager(store, leases);
    await manager.persist({ lease, base, objective: objective() });
    await expect(
      manager.persist({ lease, base, objective: objective("Implement something else.") }),
    ).rejects.toThrow(/different immutable compiled graph/i);
  });
});
