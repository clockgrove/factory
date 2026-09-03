import { createHash } from "node:crypto";

import {
  compiledGraphDigest,
  parsePersistedCompiledObjective,
  serializeCompiledObjective,
  type CompiledObjective,
} from "../graph.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "./lease.js";

const GRAPH_PATH = ".clockgrove-factory/control/compiled-objective.json";

export interface CompiledGraphStore {
  readRef(ref: string): Promise<string | null>;
  readCommit(oid: string): Promise<GitCommitObject>;
  createBlob(content: Buffer): Promise<string>;
  readBlob(oid: string): Promise<Buffer>;
  createTree(args: {
    baseTreeOid?: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }): Promise<string>;
  readTreeEntry(treeOid: string, path: string): Promise<string | null>;
  createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string>;
  createRef(ref: string, oid: string): Promise<boolean>;
}

export interface CompiledGraphRecord {
  ref: string;
  commitOid: string;
  blobOid: string;
  graphDigest: string;
  graphSize: number;
  objective: CompiledObjective;
}

function runKey(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 32);
}

export function compiledGraphRef(objective: number, runId: string): string {
  if (!Number.isInteger(objective) || objective <= 0) {
    throw new Error("Objective number must be a positive integer");
  }
  if (!runId) throw new Error("run ID is required");
  return `refs/clockgrove-factory/graphs/objective-${objective}/run-${runKey(runId)}`;
}

export class CompiledGraphManager {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: LeaseManager,
  ) {}

  async load(objective: number, runId: string): Promise<CompiledGraphRecord | null> {
    const ref = compiledGraphRef(objective, runId);
    const commitOid = await this.store.readRef(ref);
    if (!commitOid) return null;
    const commit = await this.store.readCommit(commitOid);
    const blobOid = await this.store.readTreeEntry(commit.treeOid, GRAPH_PATH);
    if (!blobOid) throw new Error(`${ref} has no compiled graph blob`);
    const bytes = await this.store.readBlob(blobOid);
    if (bytes.byteLength > 2 * 1024 * 1024) {
      throw new Error("persisted compiled graph exceeds 2 MiB");
    }
    const parsed = parsePersistedCompiledObjective(JSON.parse(bytes.toString("utf8")));
    return {
      ref,
      commitOid,
      blobOid,
      graphDigest: compiledGraphDigest(parsed),
      graphSize: parsed.workItems.length,
      objective: parsed,
    };
  }

  async persist(args: {
    lease: LeaseState;
    base: GitCommitObject;
    objective: CompiledObjective;
  }): Promise<CompiledGraphRecord> {
    await this.leases.assertCurrent(args.lease);
    const parsed = parsePersistedCompiledObjective(args.objective);
    const graphDigest = compiledGraphDigest(parsed);
    const existing = await this.load(args.lease.objective, args.lease.runId);
    if (existing) {
      if (existing.graphDigest !== graphDigest) {
        throw new Error("this run already has a different immutable compiled graph");
      }
      return existing;
    }

    const blobOid = await this.store.createBlob(serializeCompiledObjective(parsed));
    const treeOid = await this.store.createTree({
      entries: [{ path: GRAPH_PATH, mode: "100644", type: "blob", sha: blobOid }],
    });
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [args.base.oid],
      message:
        `Factory compiled graph for Objective #${args.lease.objective}\n\n` +
        `Factory-Graph-Digest: ${graphDigest}\n` +
        `Factory-Graph-Blob: ${blobOid}`,
    });
    await this.leases.assertCurrent(args.lease);
    const ref = compiledGraphRef(args.lease.objective, args.lease.runId);
    const won = await this.store.createRef(ref, commitOid);
    if (!won) {
      const winner = await this.load(args.lease.objective, args.lease.runId);
      if (!winner || winner.graphDigest !== graphDigest) {
        throw new Error("another writer persisted a divergent compiled graph for this run");
      }
      return winner;
    }
    return {
      ref,
      commitOid,
      blobOid,
      graphDigest,
      graphSize: parsed.workItems.length,
      objective: parsed,
    };
  }
}
