import { createHash } from "node:crypto";

import { z } from "zod";

import {
  compiledGraphDigest,
  parsePersistedCompiledObjective,
  serializeCompiledObjective,
  type CompiledObjective,
} from "../graph.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "./lease.js";

const GRAPH_PATH = ".clockgrove-factory/control/compiled-objective.json";
const COMPILATION_PATH = ".clockgrove-factory/control/compilation-receipt.json";
const PROJECTION_PATH = ".clockgrove-factory/control/graph-projection.json";

const CompilationReceiptSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compilation-receipt-v1"),
    invocationId: z.string().min(1).max(200),
    graphDigest: z.string().regex(/^[0-9a-f]{64}$/),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

export type CompilationReceipt = z.infer<typeof CompilationReceiptSchema>;

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
  createCommit(args: { treeOid: string; parentOids: string[]; message: string }): Promise<string>;
  createRef(ref: string, oid: string): Promise<boolean>;
}

export interface CompiledGraphRecord {
  ref: string;
  commitOid: string;
  blobOid: string;
  graphDigest: string;
  graphSize: number;
  objective: CompiledObjective;
  /** Atomically committed with the graph when this run paid to compile it. */
  compilation?: CompilationReceipt;
}

const GraphProjectionBindingSchema = z
  .object({
    compilerId: z.string().min(1).max(200),
    issueNodeId: z.string().min(1).max(200),
    issueNumber: z.number().int().positive(),
  })
  .strict();

const GraphProjectionSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/graph-projection-v1"),
    graphDigest: z.string().regex(/^[0-9a-f]{64}$/),
    bindings: z.array(GraphProjectionBindingSchema).min(1).max(100),
  })
  .strict();

export type CompiledGraphProjectionBinding = z.infer<typeof GraphProjectionBindingSchema>;

export interface CompiledGraphProjectionRecord {
  ref: string;
  commitOid: string;
  blobOid: string;
  graphDigest: string;
  graphSize: number;
  bindings: CompiledGraphProjectionBinding[];
}

export interface StagedCompiledGraphProjection {
  ref: string;
  blobOid: string;
  graphDigest: string;
  graphSize: number;
  bindings: CompiledGraphProjectionBinding[];
}

function sameCompilation(
  left: CompilationReceipt | undefined,
  right: CompilationReceipt | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

export function compiledGraphProjectionRef(objective: number, runId: string): string {
  if (!Number.isInteger(objective) || objective <= 0) {
    throw new Error("Objective number must be a positive integer");
  }
  if (!runId) throw new Error("run ID is required");
  return `refs/clockgrove-factory/graph-projections/objective-${objective}/run-${runKey(runId)}`;
}

function canonicalProjection(
  graph: CompiledGraphRecord,
  bindings: readonly CompiledGraphProjectionBinding[],
): z.infer<typeof GraphProjectionSchema> {
  const parsed = bindings.map((binding) => GraphProjectionBindingSchema.parse(binding));
  const byCompilerId = new Map(parsed.map((binding) => [binding.compilerId, binding]));
  if (byCompilerId.size !== parsed.length) {
    throw new Error("compiled graph projection contains duplicate compiler IDs");
  }
  if (new Set(parsed.map((binding) => binding.issueNodeId)).size !== parsed.length) {
    throw new Error("compiled graph projection contains duplicate issue node IDs");
  }
  if (new Set(parsed.map((binding) => binding.issueNumber)).size !== parsed.length) {
    throw new Error("compiled graph projection contains duplicate issue numbers");
  }
  if (parsed.length !== graph.objective.workItems.length) {
    throw new Error("compiled graph projection cardinality differs from the immutable graph");
  }
  const ordered = graph.objective.workItems.map((item) => {
    const binding = byCompilerId.get(item.id);
    if (!binding) {
      throw new Error(`compiled graph projection is missing Work Item ${item.id}`);
    }
    return binding;
  });
  return GraphProjectionSchema.parse({
    protocol: "clockgrove.factory/graph-projection-v1",
    graphDigest: graph.graphDigest,
    bindings: ordered,
  });
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
    const graphDigest = compiledGraphDigest(parsed);
    const compilationBlobOid = await this.store.readTreeEntry(commit.treeOid, COMPILATION_PATH);
    let compilation: CompilationReceipt | undefined;
    if (compilationBlobOid) {
      const receiptBytes = await this.store.readBlob(compilationBlobOid);
      if (receiptBytes.byteLength > 16 * 1024) {
        throw new Error("persisted compilation receipt exceeds 16 KiB");
      }
      compilation = CompilationReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
      if (compilation.graphDigest !== graphDigest) {
        throw new Error("persisted compilation receipt names a different graph digest");
      }
    }
    return {
      ref,
      commitOid,
      blobOid,
      graphDigest,
      graphSize: parsed.workItems.length,
      objective: parsed,
      ...(compilation ? { compilation } : {}),
    };
  }

  async persist(args: {
    lease: LeaseState;
    base: GitCommitObject;
    objective: CompiledObjective;
    compilation?: {
      invocationId: string;
      inputTokens: number;
      outputTokens: number;
    };
  }): Promise<CompiledGraphRecord> {
    await this.leases.assertCurrent(args.lease);
    const parsed = parsePersistedCompiledObjective(args.objective);
    const graphDigest = compiledGraphDigest(parsed);
    const compilation = args.compilation
      ? CompilationReceiptSchema.parse({
          protocol: "clockgrove.factory/compilation-receipt-v1",
          graphDigest,
          ...args.compilation,
        })
      : undefined;
    const existing = await this.load(args.lease.objective, args.lease.runId);
    if (existing) {
      if (
        existing.graphDigest !== graphDigest ||
        !sameCompilation(existing.compilation, compilation)
      ) {
        throw new Error("this run already has a different immutable compiled graph");
      }
      return existing;
    }

    const blobOid = await this.store.createBlob(serializeCompiledObjective(parsed));
    const compilationBlobOid = compilation
      ? await this.store.createBlob(Buffer.from(JSON.stringify(compilation), "utf8"))
      : null;
    const treeOid = await this.store.createTree({
      entries: [
        { path: GRAPH_PATH, mode: "100644", type: "blob", sha: blobOid },
        ...(compilationBlobOid
          ? [
              {
                path: COMPILATION_PATH,
                mode: "100644" as const,
                type: "blob" as const,
                sha: compilationBlobOid,
              },
            ]
          : []),
      ],
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
    let won: boolean;
    try {
      won = await this.store.createRef(ref, commitOid);
    } catch (error) {
      const winner = await this.load(args.lease.objective, args.lease.runId);
      if (
        winner &&
        winner.graphDigest === graphDigest &&
        sameCompilation(winner.compilation, compilation)
      ) {
        return winner;
      }
      throw error;
    }
    if (!won) {
      const winner = await this.load(args.lease.objective, args.lease.runId);
      if (
        !winner ||
        winner.graphDigest !== graphDigest ||
        !sameCompilation(winner.compilation, compilation)
      ) {
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
      ...(compilation ? { compilation } : {}),
    };
  }

  async loadProjection(
    objective: number,
    runId: string,
    graph: CompiledGraphRecord,
  ): Promise<CompiledGraphProjectionRecord | null> {
    const ref = compiledGraphProjectionRef(objective, runId);
    const commitOid = await this.store.readRef(ref);
    if (!commitOid) return null;
    const commit = await this.store.readCommit(commitOid);
    if (commit.parentOids.length !== 1 || commit.parentOids[0] !== graph.commitOid) {
      throw new Error("compiled graph projection is not bound to its immutable graph commit");
    }
    const blobOid = await this.store.readTreeEntry(commit.treeOid, PROJECTION_PATH);
    if (!blobOid) throw new Error(`${ref} has no compiled graph projection blob`);
    const staged = await this.loadStagedProjection(objective, runId, graph, blobOid);
    return {
      ...staged,
      commitOid,
    };
  }

  async loadStagedProjection(
    objective: number,
    runId: string,
    graph: CompiledGraphRecord,
    blobOid: string,
  ): Promise<StagedCompiledGraphProjection> {
    const bytes = await this.store.readBlob(blobOid);
    if (bytes.byteLength > 256 * 1024) {
      throw new Error("persisted compiled graph projection exceeds 256 KiB");
    }
    const parsed = GraphProjectionSchema.parse(JSON.parse(bytes.toString("utf8")));
    const canonical = canonicalProjection(graph, parsed.bindings);
    if (
      parsed.graphDigest !== graph.graphDigest ||
      JSON.stringify(parsed) !== JSON.stringify(canonical)
    ) {
      throw new Error("persisted compiled graph projection differs from its immutable graph");
    }
    return {
      ref: compiledGraphProjectionRef(objective, runId),
      blobOid,
      graphDigest: parsed.graphDigest,
      graphSize: parsed.bindings.length,
      bindings: parsed.bindings,
    };
  }

  async stageProjection(args: {
    lease: LeaseState;
    graph: CompiledGraphRecord;
    bindings: readonly CompiledGraphProjectionBinding[];
  }): Promise<StagedCompiledGraphProjection> {
    await this.leases.assertCurrent(args.lease);
    const projection = canonicalProjection(args.graph, args.bindings);
    const blobOid = await this.store.createBlob(Buffer.from(JSON.stringify(projection), "utf8"));
    await this.leases.assertCurrent(args.lease);
    return {
      ref: compiledGraphProjectionRef(args.lease.objective, args.lease.runId),
      blobOid,
      graphDigest: projection.graphDigest,
      graphSize: projection.bindings.length,
      bindings: projection.bindings,
    };
  }

  async persistProjection(args: {
    lease: LeaseState;
    graph: CompiledGraphRecord;
    bindings: readonly CompiledGraphProjectionBinding[];
    expectedBlobOid?: string;
  }): Promise<CompiledGraphProjectionRecord> {
    const staged = await this.stageProjection(args);
    if (args.expectedBlobOid && args.expectedBlobOid !== staged.blobOid) {
      throw new Error("staged compiled graph projection blob changed before persistence");
    }
    const projection = GraphProjectionSchema.parse({
      protocol: "clockgrove.factory/graph-projection-v1",
      graphDigest: staged.graphDigest,
      bindings: staged.bindings,
    });
    const existing = await this.loadProjection(args.lease.objective, args.lease.runId, args.graph);
    if (existing) {
      if (JSON.stringify(existing.bindings) !== JSON.stringify(projection.bindings)) {
        throw new Error("this run already has a different immutable graph projection");
      }
      return existing;
    }

    const treeOid = await this.store.createTree({
      entries: [{ path: PROJECTION_PATH, mode: "100644", type: "blob", sha: staged.blobOid }],
    });
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [args.graph.commitOid],
      message:
        `Factory graph projection for Objective #${args.lease.objective}\n\n` +
        `Factory-Graph-Digest: ${args.graph.graphDigest}\n` +
        `Factory-Projection-Blob: ${staged.blobOid}`,
    });
    await this.leases.assertCurrent(args.lease);
    const ref = compiledGraphProjectionRef(args.lease.objective, args.lease.runId);
    let won: boolean;
    try {
      won = await this.store.createRef(ref, commitOid);
    } catch (error) {
      const winner = await this.loadProjection(args.lease.objective, args.lease.runId, args.graph);
      if (winner && JSON.stringify(winner.bindings) === JSON.stringify(projection.bindings)) {
        return winner;
      }
      throw error;
    }
    if (!won) {
      const winner = await this.loadProjection(args.lease.objective, args.lease.runId, args.graph);
      if (!winner || JSON.stringify(winner.bindings) !== JSON.stringify(projection.bindings)) {
        throw new Error("another writer persisted a divergent graph projection for this run");
      }
      return winner;
    }
    return {
      ref,
      commitOid,
      blobOid: staged.blobOid,
      graphDigest: projection.graphDigest,
      graphSize: projection.bindings.length,
      bindings: projection.bindings,
    };
  }
}
