import type { FactoryEvent } from "../protocol/events.js";
import {
  compiledGraphDigest,
  parseGraphItemMetadata,
  parseLegacyGraphConstraints,
  parseLegacyGraphConstraintsSnapshot,
  parseWorkerPacketFromIssue,
  type CompiledObjective,
  type ExistingGraphWorkItem,
  type LegacyGraphConstraints,
} from "../graph.js";
import { deduplicateFactoryEvents } from "./receipts.js";

export interface ObjectiveGraphInputSnapshot {
  title: string;
  factoryEvents?: FactoryEvent[];
  workItems: Array<{
    id?: string;
    number: number;
    title?: string;
    body?: string;
    blockedBy?: Array<{ number: number }>;
  }>;
}

export interface ObjectiveGraphInputInspection {
  classification: "empty" | "legacy-adoptable" | "authenticated";
  hasReceipt: boolean;
  receiptRunId?: string;
  expectedDigest?: string;
  expectedSize?: number;
  expectedRef?: string;
  expectedBlobSha?: string;
  completeObjective?: CompiledObjective;
  existing: ExistingGraphWorkItem[];
  legacyGraphConstraints?: LegacyGraphConstraints;
}

function graphInputWorkItems(snapshot: ObjectiveGraphInputSnapshot) {
  return snapshot.workItems.map((item) => {
    if (!item.id) throw new Error(`Work Item #${item.number} node identity is unavailable`);
    if (!item.title) throw new Error(`Work Item #${item.number} title is unavailable`);
    if (!item.blockedBy)
      throw new Error(`Work Item #${item.number} native dependency evidence is unavailable`);
    return {
      id: item.id,
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      blockedByNumbers: item.blockedBy.map((dependency) => dependency.number),
    };
  });
}

/**
 * Classify the complete, bounded Objective graph input before a run starts.
 * This is deliberately side-effect free so doctor and the lease-fenced
 * Supervisor startup use the same trust decision.
 */
export function inspectObjectiveGraphInput(
  snapshot: ObjectiveGraphInputSnapshot,
): ObjectiveGraphInputInspection {
  const receipt = deduplicateFactoryEvents(snapshot.factoryEvents ?? [])
    .filter((event) => event.kind === "graph" && event.event === "GraphCompiled")
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (snapshot.workItems.length === 0) {
    return {
      classification: receipt ? "authenticated" : "empty",
      hasReceipt: Boolean(receipt),
      ...(receipt?.kind === "graph"
        ? {
            expectedDigest: receipt.graphDigest,
            expectedSize: receipt.graphSize,
            expectedRef: receipt.graphRef,
            expectedBlobSha: receipt.graphBlobSha,
            receiptRunId: receipt.runId,
          }
        : {}),
      existing: [],
    };
  }
  const workItems = graphInputWorkItems(snapshot);
  if (!receipt || receipt.kind !== "graph") {
    const legacyGraphConstraints = parseLegacyGraphConstraints({
      objectiveTitle: snapshot.title,
      workItems,
    });
    return {
      classification: "legacy-adoptable",
      hasReceipt: false,
      existing: [],
      legacyGraphConstraints,
    };
  }
  const legacy = [] as typeof workItems;
  const parsed = workItems.flatMap((item) => {
    try {
      return [{ item, metadata: parseGraphItemMetadata(item.body) }];
    } catch (metadataError) {
      try {
        parseLegacyGraphConstraints({
          objectiveTitle: snapshot.title,
          workItems: [{ ...item, blockedByNumbers: [] }],
        });
        legacy.push(item);
        return [];
      } catch (legacyError) {
        throw new Error(
          `Work Item #${item.number} is neither authenticated v2 nor bounded legacy input: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}; ${legacyError instanceof Error ? legacyError.message : String(legacyError)}`,
        );
      }
    }
  });
  parsed.sort((a, b) => a.metadata.index - b.metadata.index);
  const digests = new Set(parsed.map(({ metadata }) => metadata.graphDigest));
  const sizes = new Set(parsed.map(({ metadata }) => metadata.graphSize));
  const ids = new Set(parsed.map(({ metadata }) => metadata.id));
  const indexes = new Set(parsed.map(({ metadata }) => metadata.index));
  if (
    (parsed.length > 0 && (digests.size !== 1 || sizes.size !== 1)) ||
    ids.size !== parsed.length ||
    indexes.size !== parsed.length
  ) {
    throw new Error("Objective contains mixed or duplicate compiled-graph receipts");
  }
  const expectedDigest = parsed[0]?.metadata.graphDigest ?? receipt.graphDigest;
  const expectedSize = parsed[0]?.metadata.graphSize ?? receipt.graphSize;
  if (expectedDigest !== receipt.graphDigest || expectedSize !== receipt.graphSize) {
    throw new Error("Work Item graph metadata does not match the authenticated Objective receipt");
  }
  if (workItems.length > expectedSize) {
    throw new Error("Objective contains more Work Items than its compiled graph declares");
  }
  if (parsed.some(({ metadata }) => metadata.index >= expectedSize)) {
    throw new Error("Objective contains an out-of-range compiled Work Item index");
  }
  const existing = parsed.map(({ item, metadata }) => ({
    compilerId: metadata.id,
    graphDigest: metadata.graphDigest,
    graphSize: metadata.graphSize,
    index: metadata.index,
    dependsOn: metadata.dependsOn,
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    blockedByNumbers: item.blockedByNumbers,
  }));
  let legacyGraphConstraints: LegacyGraphConstraints | undefined;
  if (
    legacy.length > 0 ||
    (parsed.length === workItems.length &&
      parsed.every(({ item, metadata }) => metadata.id === `adopted-${item.number}`))
  ) {
    legacyGraphConstraints = parseLegacyGraphConstraintsSnapshot({
      objectiveTitle: snapshot.title,
      workItems,
    });
  }
  if (parsed.length !== expectedSize) {
    return {
      classification: "authenticated",
      hasReceipt: true,
      expectedDigest,
      expectedSize,
      expectedRef: receipt.graphRef,
      expectedBlobSha: receipt.graphBlobSha,
      receiptRunId: receipt.runId,
      existing,
      ...(legacyGraphConstraints ? { legacyGraphConstraints } : {}),
    };
  }
  const completeObjective: CompiledObjective = {
    title: snapshot.title,
    workItems: parsed.map(({ item, metadata }) => {
      const packet = parseWorkerPacketFromIssue(item.body);
      return {
        id: metadata.id,
        title: item.title,
        goal: packet.goal,
        acceptance: packet.acceptanceCriteria,
        scope: packet.allowedPaths,
        preconditions: packet.preconditions,
        outOfScope: packet.outOfScope,
        conventions: packet.conventions,
        dependsOn: metadata.dependsOn,
        baseSha: packet.baseSha,
        validationCommands: packet.validationCommands,
        requirements: packet.requirements,
        artifactContract: packet.artifactContract,
        ...(packet.context ? { context: packet.context } : {}),
        ...(packet.changeSurface ? { changeSurface: packet.changeSurface } : {}),
        ...(packet.criterionRisks ? { criterionRisks: packet.criterionRisks } : {}),
        ...(packet.delivery ? { delivery: packet.delivery } : {}),
        ...(packet.validation ? { validation: packet.validation } : {}),
        ...(packet.repositoryCapabilities
          ? { repositoryCapabilities: packet.repositoryCapabilities }
          : {}),
        ...(packet.managedRuntimes ? { managedRuntimes: packet.managedRuntimes } : {}),
      };
    }),
  };
  const reconstructable = compiledGraphDigest(completeObjective) === expectedDigest;
  return {
    classification: "authenticated",
    hasReceipt: true,
    expectedDigest,
    expectedSize,
    expectedRef: receipt.graphRef,
    expectedBlobSha: receipt.graphBlobSha,
    receiptRunId: receipt.runId,
    ...(reconstructable ? { completeObjective } : {}),
    existing,
    ...(legacyGraphConstraints ? { legacyGraphConstraints } : {}),
  };
}
