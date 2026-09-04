import {
  compiledGraphDigest,
  parseGraphItemMetadata,
  renderWorkPacket,
  workerPacketFromCompiled,
  type CompiledObjective,
} from "../graph.js";
import type { FactoryEvent } from "../protocol/events.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { CompiledGraphProjectionBinding } from "./graphs.js";

export interface CompiledGraphSnapshot {
  workItems: Array<{
    id: string;
    number: number;
    title: string;
    body?: string | null;
    blockedBy: Array<{ number: number }>;
  }>;
}

/**
 * Fence every mutable GitHub projection against the immutable per-run graph.
 * This runs after each fresh Objective read and before state derivation, so an
 * issue edit cannot widen a Worker Packet, remove a dependency, or make a
 * missing Work Item look like a completed Objective.
 */
export function assertSnapshotMatchesCompiledGraph(
  graph: CompiledObjective,
  snapshot: CompiledGraphSnapshot,
  projection?: readonly CompiledGraphProjectionBinding[],
): Map<number, WorkerPacket> {
  if (snapshot.workItems.length !== graph.workItems.length) {
    throw new Error(
      `Objective Work Item count ${snapshot.workItems.length} differs from immutable graph count ${graph.workItems.length}`,
    );
  }
  const digest = compiledGraphDigest(graph);
  const compiledById = new Map(graph.workItems.map((item) => [item.id, item]));
  const observedById = new Map<
    string,
    { item: CompiledGraphSnapshot["workItems"][number]; index: number }
  >();
  for (const item of snapshot.workItems) {
    let metadata;
    try {
      metadata = parseGraphItemMetadata(item.body ?? "");
    } catch (error) {
      throw new Error(
        `Work Item #${item.number} does not match the immutable graph: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (observedById.has(metadata.id)) {
      throw new Error(`immutable graph Work Item ${metadata.id} appears more than once`);
    }
    observedById.set(metadata.id, { item, index: metadata.index });
  }

  const packets = new Map<number, WorkerPacket>();
  const bindingById = projection
    ? new Map(projection.map((binding) => [binding.compilerId, binding]))
    : null;
  if (projection && bindingById!.size !== graph.workItems.length) {
    throw new Error("immutable graph projection cardinality differs from the compiled graph");
  }
  for (const [index, expected] of graph.workItems.entries()) {
    const observed = observedById.get(expected.id);
    if (!observed) {
      throw new Error(`immutable graph Work Item ${expected.id} is missing from the Objective`);
    }
    const binding = bindingById?.get(expected.id);
    if (
      bindingById &&
      (!binding ||
        binding.issueNodeId !== observed.item.id ||
        binding.issueNumber !== observed.item.number)
    ) {
      throw new Error(`Work Item ${expected.id} moved from its immutable GitHub issue binding`);
    }
    const expectedMetadata = {
      protocol: "clockgrove.factory/graph-v1" as const,
      id: expected.id,
      graphDigest: digest,
      graphSize: graph.workItems.length,
      index,
      dependsOn: expected.dependsOn,
    };
    const actualMetadata = parseGraphItemMetadata(observed.item.body ?? "");
    if (JSON.stringify(actualMetadata) !== JSON.stringify(expectedMetadata)) {
      throw new Error(`Work Item #${observed.item.number} graph metadata was modified`);
    }
    if (observed.item.title !== expected.title) {
      throw new Error(`Work Item #${observed.item.number} title was modified`);
    }
    const expectedBody = renderWorkPacket(expected, expectedMetadata).trim();
    if ((observed.item.body ?? "").trim() !== expectedBody) {
      throw new Error(`Work Item #${observed.item.number} body was modified`);
    }
    packets.set(observed.item.number, workerPacketFromCompiled(expected));
  }
  if (observedById.size !== compiledById.size) {
    throw new Error("Objective contains Work Items outside the immutable graph");
  }

  const numberById = new Map(
    [...observedById].map(([id, observed]) => [id, observed.item.number] as const),
  );
  for (const expected of graph.workItems) {
    const observed = observedById.get(expected.id)!;
    const expectedBlockers = expected.dependsOn
      .map((id) => numberById.get(id)!)
      .sort((left, right) => left - right);
    const actualBlockers = observed.item.blockedBy
      .map(({ number }) => number)
      .sort((left, right) => left - right);
    if (JSON.stringify(actualBlockers) !== JSON.stringify(expectedBlockers)) {
      throw new Error(`Work Item #${observed.item.number} blocker edges were modified`);
    }
  }
  return packets;
}

export interface GraphProjectionExpectation {
  ref: string;
  blobOid: string;
  graphDigest: string;
  graphSize: number;
}

/** Require one run-actor-authenticated journal receipt for the immutable projection. */
export function assertAuthenticatedGraphProjection(
  events: readonly FactoryEvent[],
  objective: number,
  runId: string,
  expected: GraphProjectionExpectation,
): void {
  const receipts = events.filter(
    (event) =>
      event.kind === "graph" &&
      event.event === "GraphProjected" &&
      event.objective === objective &&
      event.runId === runId,
  );
  if (receipts.length !== 1) {
    throw new Error(
      receipts.length === 0
        ? "immutable graph projection has no authenticated Objective receipt"
        : "immutable graph projection has multiple authenticated Objective receipts",
    );
  }
  const receipt = receipts[0]!;
  if (
    receipt.graphDigest !== expected.graphDigest ||
    receipt.graphSize !== expected.graphSize ||
    receipt.projectionRef !== expected.ref ||
    receipt.projectionBlobSha !== expected.blobOid
  ) {
    throw new Error("authenticated graph projection receipt differs from its immutable ref");
  }
}
