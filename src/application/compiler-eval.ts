import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { assertNoSecretMaterial, assertWithinBytes } from "../protocol/limits.js";
import type { FactoryEvent } from "../protocol/events.js";
import {
  canonicalDraftJson,
  draftDigest,
  loadCompilerDrafts,
  type CompilerDraftRecord,
} from "../control/compiler-drafts.js";
import {
  CompiledGraphProjectionConflictError,
  loadCompiledGraph,
  loadCompiledGraphProjection,
  type CompiledGraphProjectionRecord,
  type CompiledGraphReadStore,
  type CompiledGraphRecord,
} from "../control/graphs.js";
import { latestRunReceipts } from "../control/receipts.js";
import { summarizeRun } from "../economics/index.js";
import {
  CompilerWorkItemsProposalSchema,
  CompilerProposalSchema,
  CompilerRequestSchema,
  CompilerValidationReportSchema,
} from "../compiler/contracts.js";
import {
  compilerJudgeCandidateFromCompiled,
  type CompilerJudgeCandidate,
} from "../compiler/judge-context.js";
import { compiledGraphDigest, type CompiledObjective } from "../graph.js";
import { analyzeDependencies } from "../graph-analysis.js";
import {
  CompilerEvidenceSchema,
  type ObligationInventorySchema,
  compilerEvalDigest,
  createCompilerEvalReport,
  parseObligationInventory,
  renderCompilerEvalMarkdown,
  validateCompilerInferenceChallenges,
  type CompilerEvalUsage,
  type CompilerEvidence,
} from "../evaluation/compiler-eval.js";
import {
  compilerDraftResultHasError,
  validatePersistedCompilerDraftJournal,
} from "../evaluation/compiler-draft-loop.js";
import { ModelReasoningEffortSchema } from "../protocol/policy.js";
import type { ApplicationSnapshot } from "./services.js";

export const MAX_COMPILER_ANNOTATION_BYTES = 256 * 1024;
const AnnotationId = z.string().min(1).max(160);
const AnnotationText = z.string().min(1).max(4000);
const ProjectionTrace = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-projection"),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    graphDigest: z.string().regex(/^[a-f0-9]{64}$/),
    addedEdges: z.array(z.object({ itemId: z.string(), dependsOn: z.string() }).passthrough()),
    adapterBindings: z.array(z.record(z.unknown())),
    mediaIntents: z.array(
      z
        .object({
          intentId: z.string().min(1).max(64),
          disposition: z.enum(["imported", "producer", "repository-capture", "omitted-helpful"]),
          producerWorkItemId: z.string().min(1).max(64).nullable(),
        })
        .strict(),
    ),
    riskElevations: z
      .object({
        count: z.number().int().nonnegative(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
/** These are caller assertions with mechanically checked citations, never authenticated causal authority. */
export const CompilerCausalAnnotationsSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1).max(200),
    draftDigest: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().min(0).max(2),
    provenance: z
      .object({
        kind: z.literal("caller-supplied"),
        authorType: z.enum(["human", "automated", "unknown"]),
        source: z.string().min(1).max(500),
      })
      .strict(),
    causes: z
      .array(
        z
          .object({
            findingId: AnnotationId,
            cause: z.enum([
              "compiler",
              "worker",
              "infrastructure",
              "changed-requirement",
              "mixed",
              "unknown",
            ]),
            itemIds: z.array(AnnotationId).max(100),
            attempts: z
              .array(
                z
                  .object({
                    workItem: z.number().int().positive(),
                    attempt: z.number().int().positive(),
                  })
                  .strict(),
              )
              .max(100),
            evidenceIds: z.array(AnnotationId).min(1).max(128),
            explanation: AnnotationText,
            uncertainty: z.string().max(4000),
            estimatedAvoidableTokens: z.number().nonnegative().finite().nullable(),
            estimatedAvoidableMilliseconds: z.number().nonnegative().finite().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
export type CompilerCausalAnnotations = z.infer<typeof CompilerCausalAnnotationsSchema>;
export function parseCompilerCausalAnnotations(value: unknown): CompilerCausalAnnotations {
  try {
    assertWithinBytes(value, MAX_COMPILER_ANNOTATION_BYTES, "compiler causal annotations");
    assertNoSecretMaterial(value, "compiler causal annotations");
    return CompilerCausalAnnotationsSchema.parse(value);
  } catch {
    throw new Error(
      "Invalid compiler causal annotations: expected bounded, secret-free version 1 JSON",
    );
  }
}
/** An explicitly named regular file is read under a fixed allocation ceiling. */
export async function readCompilerCausalAnnotationsFile(
  path: string,
): Promise<CompilerCausalAnnotations> {
  try {
    if (!path || path.length > 4096) throw new Error("invalid annotation path");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_COMPILER_ANNOTATION_BYTES)
        throw new Error("annotation file bound");
      const bytes = Buffer.alloc(MAX_COMPILER_ANNOTATION_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_COMPILER_ANNOTATION_BYTES) throw new Error("annotation file bound");
      return parseCompilerCausalAnnotations(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))),
      );
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(
      "Invalid compiler causal annotations file: expected bounded, secret-free version 1 JSON in a regular file",
    );
  }
}

function safeReceiptEvidence(event: FactoryEvent): CompilerEvidence {
  const fields: Record<string, unknown> = {};
  for (const key of [
    "kind",
    "event",
    "objective",
    "workItem",
    "attempt",
    "sequence",
    "at",
    "baseSha",
    "artifactDigest",
    "headSha",
    "phase",
    "unit",
    "amount",
    "usageId",
    "modelInvocationId",
  ]) {
    const value = (event as Record<string, unknown>)[key];
    if (typeof value === "string") {
      try {
        assertNoSecretMaterial(value, "runtime evidence field");
        fields[key] = value;
      } catch {
        fields[key] = "[sensitive value omitted]";
      }
    } else if (typeof value === "number") fields[key] = value;
  }
  if (typeof event.reason === "string") {
    try {
      assertNoSecretMaterial(event.reason, "runtime reason");
      if (/(?:secret|api[_-]?key|password|credential|token)\s*[:=]\s*\S+/i.test(event.reason))
        throw new Error("sensitive runtime reason");
      fields.reason = event.reason.slice(0, 1000);
    } catch {
      fields.reason = "[sensitive reason omitted; original retained in receipt]";
    }
  }
  const digest = draftDigest(event);
  return {
    id: `runtime-${digest}`,
    kind: "receipt",
    identity: `${event.runId}:${digest}`,
    excerpt: JSON.stringify(fields).slice(0, 4000),
  };
}

const Invocation = z.object({
  invocationId: z.string().min(1).max(200),
  stage: z.enum(["inventory", "compile", "repair", "judge"]),
  revision: z.number().int().min(0),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  compilerRequestDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const Usage = z.object({
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  cachedInputTokens: z.number().int().nonnegative().safe().optional(),
});

const InvocationProvenance = z
  .object({
    promptBytes: z.number().int().nonnegative().safe(),
    schemaBytes: z.number().int().nonnegative().safe(),
    sizeSource: z.enum(["provider-dispatch", "local-callback"]),
  })
  .passthrough();
const ResponseSizeSource = z.enum(["provider-final-response", "canonical-structured-value"]);
const CompilerSourceEvidence = z
  .object({
    objective: z
      .object({
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string(),
      })
      .strict(),
    evidence: z.array(CompilerEvidenceSchema).min(1).max(128),
    modelSelection: z
      .object({
        profile: z.string().min(1).max(160),
        model: z.string().min(1).max(160),
        reasoning: ModelReasoningEffortSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

type CalibrationAvailability = "observed" | "missing" | "conflicting";

function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalDraftJson(value), "utf8");
}

export function mechanicalDependencyCriticalPath(
  items: readonly { id: string; dependsOn: readonly string[] }[],
) {
  const analysis = analyzeDependencies(items);
  if (
    analysis.duplicates.length ||
    analysis.unknownDependencies.length ||
    analysis.cycleItems.length
  )
    return null;
  const paths = new Map<string, string[]>();
  for (const id of analysis.order) {
    const item = items.find((candidate) => candidate.id === id)!;
    const predecessors = item.dependsOn
      .map((dependency) => paths.get(dependency))
      .filter((path): path is string[] => path !== undefined)
      .sort(
        (left, right) =>
          right.length - left.length || left.join("\0").localeCompare(right.join("\0")),
      );
    paths.set(id, [...(predecessors[0] ?? []), id]);
  }
  const itemIds =
    [...paths.values()].sort(
      (left, right) =>
        right.length - left.length || left.join("\0").localeCompare(right.join("\0")),
    )[0] ?? [];
  return { workItems: itemIds.length, dependencyEdges: Math.max(0, itemIds.length - 1), itemIds };
}

function authorityState(
  events: readonly FactoryEvent[],
  objective: number,
  runId: string,
  baseSha: string | null,
  graph: CompiledGraphRecord | null,
  projection: CompiledGraphProjectionRecord | null,
) {
  const graphReceipts = events.filter(
    (event) =>
      event.kind === "graph" &&
      event.event === "GraphCompiled" &&
      event.objective === objective &&
      event.runId === runId,
  );
  const projectionReceipts = events.filter(
    (event) =>
      event.kind === "graph" &&
      event.event === "GraphProjected" &&
      event.objective === objective &&
      event.runId === runId,
  );
  const graphReceipt = graphReceipts[0];
  const graphAvailability: CalibrationAvailability = !graph
    ? graphReceipts.length === 0
      ? "missing"
      : "conflicting"
    : graphReceipts.length === 0
      ? "missing"
      : graphReceipts.length !== 1 ||
          graphReceipt?.graphDigest !== graph.graphDigest ||
          graphReceipt.graphSize !== graph.graphSize ||
          graphReceipt.baseSha !== baseSha ||
          graphReceipt.graphRef !== graph.ref ||
          graphReceipt.graphBlobSha !== graph.blobOid
        ? "conflicting"
        : "observed";
  const projectionReceipt = projectionReceipts[0];
  const projectionAvailability: CalibrationAvailability = !projection
    ? projectionReceipts.length === 0
      ? "missing"
      : "conflicting"
    : projectionReceipts.length === 0
      ? "missing"
      : projectionReceipts.length !== 1 ||
          projectionReceipt?.graphDigest !== projection.graphDigest ||
          projectionReceipt.graphSize !== projection.graphSize ||
          projectionReceipt.projectionRef !== projection.ref ||
          projectionReceipt.projectionBlobSha !== projection.blobOid
        ? "conflicting"
        : "observed";
  return {
    graph: {
      availability: graphAvailability,
      ...(graphAvailability === "observed" && graph
        ? {
            digest: graph.graphDigest,
            size: graph.graphSize,
            ref: graph.ref,
            commitOid: graph.commitOid,
            blobOid: graph.blobOid,
            baseSha: graphReceipt?.baseSha,
          }
        : {}),
    },
    projection: {
      availability: projectionAvailability,
      ...(projectionAvailability === "observed" && projection
        ? {
            digest: draftDigest({
              protocol: "clockgrove.factory/graph-projection-v1",
              graphDigest: projection.graphDigest,
              bindings: projection.bindings,
            }),
            size: projection.graphSize,
            ref: projection.ref,
            commitOid: projection.commitOid,
            blobOid: projection.blobOid,
          }
        : {}),
    },
  };
}

function planningStop(records: readonly CompilerDraftRecord[]) {
  const stopped = records.find((record) => record.kind === "stopped");
  if (!stopped || typeof stopped.payload.reason !== "string") return null;
  const match = /^compiler-planning-result:(objectives|clarification):([a-f0-9]{64})$/.exec(
    stopped.payload.reason,
  );
  return match ? { kind: match[1]!, digest: match[2]! } : null;
}

type PlanningTriggerEvidence = {
  code: string;
  source: string;
  availability: string;
  threshold: unknown;
  obligationIds: string[];
};
type ObjectivePlanningEvidence = {
  proposalCount: number;
  proposalCountAuthority: "model-reported-schema-validated";
  triggerIdentities: string[];
  objectives: Array<{
    id: string;
    obligationIds: string[];
    planningEstimate: {
      workItems: number | null;
      criticalPathMinutes: number | null;
      aggregateWorkMinutes: number | null;
    };
    outputIds: string[];
    prerequisiteOutputs: Array<{ objectiveId: string; outputId: string }>;
  }>;
  coverage: Array<{
    obligationId: string;
    disposition: string;
    objectiveId?: string;
    acceptanceId?: string;
  }>;
  triggers: PlanningTriggerEvidence[];
};
type ClarificationPlanningEvidence = {
  proposalCount: number;
  proposalCountAuthority: "model-reported-schema-validated";
  triggerIdentities: string[];
  requirements: Array<{ id: string; obligationIds: string[] }>;
  triggers: PlanningTriggerEvidence[];
};

function renderCalibrationMarkdown(calibration: ReturnType<typeof createCalibrationEvidence>) {
  const result = calibration.result;
  const safe = (value: unknown) => JSON.stringify(value);
  const nullable = (value: unknown) => (value === null ? "unknown" : String(value));
  const authorityIdentity = (
    label: string,
    value: (typeof calibration.authority)["graph"] | (typeof calibration.authority)["projection"],
  ) =>
    value.availability === "observed"
      ? `- ${label}: observed; digest ${value.digest}; size ${value.size}; ref ${safe(value.ref)}; commit ${value.commitOid}; blob ${value.blobOid}${"baseSha" in value ? `; base ${value.baseSha}` : ""}.`
      : `- ${label}: ${value.availability}; exact identity unavailable.`;
  return [
    "## Qualification evidence",
    "",
    `- Terminal state: ${result.terminalState}; result availability: ${result.availability}; proposal kind: ${result.kind ?? "unavailable"}.`,
    `- Obligations: ${result.obligationCount ?? "unavailable"} (${result.obligationCountAuthority}).`,
    ...(result.kind === "work-items" && "workItems" in result
      ? [
          `- Candidate Work Items: ${result.workItems.modelAuthoredCount} (${result.workItems.modelAuthoredCountAuthority}); Factory-derived producers ${result.workItems.mechanicallyDerivedProducerCount ?? "unavailable"} (${result.workItems.mechanicallyDerivedProducerCountAuthority}); compiled ${result.workItems.compiledTotal ?? "unavailable"} (${result.workItems.compiledTotalAuthority}); projected ${result.workItems.projectedTotal ?? "unavailable"} (${result.workItems.projectedTotalAuthority}).`,
          `- Dependency critical path: ${result.workItems.criticalPath?.workItems ?? "unavailable"} Work Items (${result.workItems.criticalPath?.dependencyEdges ?? "unavailable"} edges); ${result.workItems.criticalPath?.itemIds.map(safe).join(" -> ") ?? "unavailable"} (${result.workItems.criticalPathAuthority}).`,
        ]
      : result.kind === "objectives" && "planning" in result
        ? [
            `- Proposed Objectives: ${result.planning.proposalCount} (model-reported, schema-validated); triggers ${result.planning.triggerIdentities.join(", ")}.`,
            ...result.planning.objectives.map(
              (objective) =>
                `- Objective ${safe(objective.id)}: model-reported, schema-validated estimates workItems=${nullable(objective.planningEstimate.workItems)}, criticalPathMinutes=${nullable(objective.planningEstimate.criticalPathMinutes)}, aggregateWorkMinutes=${nullable(objective.planningEstimate.aggregateWorkMinutes)}; obligations=${safe(objective.obligationIds)}; outputs=${safe(objective.outputIds)}; prerequisites=${safe(objective.prerequisiteOutputs)}.`,
            ),
            ...result.planning.coverage.map(
              (coverage) =>
                `- Coverage ${safe(coverage.obligationId)}: disposition=${coverage.disposition}; objective=${safe("objectiveId" in coverage ? coverage.objectiveId : null)}; acceptance=${safe("acceptanceId" in coverage ? coverage.acceptanceId : null)}.`,
            ),
            ...result.planning.triggers.map(
              (trigger) =>
                `- Trigger ${trigger.code}:${trigger.source}: availability=${trigger.availability}; threshold=${safe(trigger.threshold)}; obligations=${safe(trigger.obligationIds)}.`,
            ),
          ]
        : result.kind === "clarification" && "planning" in result
          ? [
              `- Clarification requirements: ${result.planning.proposalCount} (model-reported, schema-validated); triggers ${result.planning.triggerIdentities.join(", ")}.`,
              ...result.planning.requirements.map(
                (requirement) =>
                  `- Clarification ${safe(requirement.id)}: obligations=${safe(requirement.obligationIds)}.`,
              ),
              ...result.planning.triggers.map(
                (trigger) =>
                  `- Trigger ${trigger.code}:${trigger.source}: availability=${trigger.availability}; threshold=${safe(trigger.threshold)}; obligations=${safe(trigger.obligationIds)}.`,
              ),
            ]
          : []),
    authorityIdentity("Immutable graph authority", calibration.authority.graph),
    authorityIdentity("Immutable projection authority", calibration.authority.projection),
    "",
    "### Invocation sizes",
    "",
    ...calibration.invocations.map(
      (invocation) =>
        `- ${invocation.invocationId} (${invocation.stage} r${invocation.revision}, ${invocation.state}): prompt ${invocation.sizes.prompt.bytes ?? "unavailable"} bytes (${invocation.sizes.prompt.provenance}); schema ${invocation.sizes.schema.bytes ?? "unavailable"} bytes (${invocation.sizes.schema.provenance}); response ${invocation.sizes.response.bytes ?? "unavailable"} bytes (${invocation.sizes.response.provenance}); inventory ${invocation.sizes.inventory.bytes ?? "unavailable"} bytes (${invocation.sizes.inventory.provenance}); evidence ${invocation.sizes.evidence.bytes ?? "unavailable"} bytes (${invocation.sizes.evidence.provenance}).`,
    ),
    "",
  ];
}

function createCalibrationEvidence(args: {
  records: readonly CompilerDraftRecord[];
  events: readonly FactoryEvent[];
  objective: number;
  runId: string;
  inventory: z.infer<typeof ObligationInventorySchema> | null;
  graph: CompiledGraphRecord | null;
  fixedGraph: CompiledObjective | null;
  projection: CompiledGraphProjectionRecord | null;
  projectionConflict: boolean;
  invocations: Array<{
    record: CompilerDraftRecord;
    invocation: z.infer<typeof Invocation>;
  }>;
  results: CompilerDraftRecord[];
  invocationStatus: Array<{
    invocationId: string;
    stage: "inventory" | "compile" | "repair" | "judge";
    revision: number;
    state: "reserved" | "not-invoked" | "failed" | "completed";
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    observedTokens: number | null;
    observedMilliseconds: number | null;
  }>;
}) {
  const selection = args.records.find((record) => record.kind === "selection");
  const stopped = args.records.find((record) => record.kind === "stopped");
  const planning = planningStop(args.records);
  let proposalConflict = false;
  const proposals = args.results.flatMap((result) => {
    if (
      compilerDraftResultHasError(result) ||
      (result.payload.stage !== "compile" && result.payload.stage !== "repair")
    )
      return [];
    try {
      const value = z.record(z.unknown()).parse(result.payload.value);
      const request = CompilerRequestSchema.parse(value.request);
      const proposal = CompilerProposalSchema.parse(value.proposal);
      const report = CompilerValidationReportSchema.parse(value.report);
      const provenance = z
        .object({ requestDigest: z.string() })
        .passthrough()
        .parse(value.provenance);
      const invocation = args.invocations.find(
        (candidate) => candidate.invocation.invocationId === result.payload.invocationId,
      );
      const requestDigest = draftDigest(request);
      if (
        report.status !== "valid" ||
        request.revision !== result.payload.revision ||
        !args.inventory ||
        draftDigest(request.inventory) !== draftDigest(args.inventory) ||
        provenance.requestDigest !== requestDigest ||
        invocation?.invocation.compilerRequestDigest !== requestDigest
      ) {
        proposalConflict = true;
        return [];
      }
      return [{ result, proposal, requestDigest, proposalDigest: draftDigest(proposal) }];
    } catch {
      proposalConflict = true;
      return [];
    }
  });
  const fixedProposal =
    selection && args.fixedGraph
      ? {
          result: selection,
          proposal: {
            kind: "work-items" as const,
            workItems: args.fixedGraph.workItems,
          },
          requestDigest: String(selection.payload.requestDigest),
          proposalDigest: String(selection.payload.proposalDigest),
        }
      : undefined;
  const terminalProposal = selection
    ? (proposals.find((entry) => entry.result.payload.revision === selection.payload.revision) ??
      fixedProposal)
    : planning
      ? proposals.find(
          (entry) =>
            entry.proposal.kind === planning.kind &&
            draftDigest(entry.proposal) === planning.digest,
        )
      : undefined;
  if ((selection || planning) && !terminalProposal) proposalConflict = true;

  const authority = authorityState(
    args.events,
    args.objective,
    args.runId,
    args.records[0]?.binding.baseSha ?? null,
    args.graph,
    args.projection,
  );
  if (args.projectionConflict) authority.projection = { availability: "conflicting" };

  const resultBase = {
    terminalState: selection
      ? ("accepted" as const)
      : stopped
        ? ("stopped" as const)
        : ("incomplete" as const),
    availability: proposalConflict
      ? ("conflicting" as const)
      : terminalProposal
        ? ("observed" as const)
        : ("missing" as const),
    kind: terminalProposal?.proposal.kind ?? null,
    proposalDigest: terminalProposal?.proposalDigest ?? null,
    obligationCount: args.inventory?.obligations.length ?? null,
    obligationCountAuthority: args.inventory
      ? ("mechanically-counted-authenticated-inventory" as const)
      : ("unavailable" as const),
  };
  let result:
    | typeof resultBase
    | (typeof resultBase & {
        kind: "work-items";
        workItems: {
          modelAuthoredCount: number;
          modelAuthoredCountAuthority:
            | "model-reported-schema-validated"
            | "mechanically-reconstructed-fixed-graph";
          mechanicallyDerivedProducerCount: number | null;
          mechanicallyDerivedProducerIds: string[] | null;
          mechanicallyDerivedProducerCountAuthority:
            | "mechanically-derived-authenticated-projection-trace"
            | "unavailable";
          compiledTotal: number | null;
          compiledTotalAuthority:
            | "mechanically-counted-authenticated-fixed-graph"
            | "mechanically-counted-authenticated-compiled-graph"
            | "unavailable";
          projectedTotal: number | null;
          projectedTotalAuthority: "mechanically-counted-authenticated-projection" | "unavailable";
          criticalPath: ReturnType<typeof mechanicalDependencyCriticalPath>;
          criticalPathAuthority:
            | "mechanically-derived-authenticated-fixed-graph"
            | "mechanically-derived-authenticated-compiled-graph"
            | "unavailable";
        };
      })
    | (typeof resultBase & { kind: "objectives"; planning: ObjectivePlanningEvidence })
    | (typeof resultBase & { kind: "clarification"; planning: ClarificationPlanningEvidence }) =
    resultBase;
  if (terminalProposal?.proposal.kind === "work-items") {
    const authoredIds = new Set(terminalProposal.proposal.workItems.map((item) => item.id));
    const compiledObjective = args.graph?.objective ?? args.fixedGraph;
    const derivedIds = compiledObjective
      ? compiledObjective.workItems
          .map((item) => item.id)
          .filter((id) => !authoredIds.has(id))
          .sort()
      : null;
    const validation = args.records.find(
      (record) =>
        record.kind === "validation" &&
        record.payload.valid === true &&
        record.payload.revision === terminalProposal.result.payload.revision,
    );
    const trace = validation ? ProjectionTrace.safeParse(validation.payload.projectionTrace) : null;
    const tracedProducerIds = trace?.success
      ? trace.data.mediaIntents
          .filter((intent) => intent.disposition === "producer")
          .map((intent) => intent.producerWorkItemId)
          .filter((id): id is string => id !== null)
          .sort()
      : null;
    const producersVerified =
      (authority.graph.availability === "observed" || args.fixedGraph !== null) &&
      derivedIds !== null &&
      tracedProducerIds !== null &&
      JSON.stringify(derivedIds) === JSON.stringify([...new Set(tracedProducerIds)]);
    result = {
      ...resultBase,
      kind: "work-items",
      workItems: {
        modelAuthoredCount: terminalProposal.proposal.workItems.length,
        modelAuthoredCountAuthority: args.fixedGraph
          ? "mechanically-reconstructed-fixed-graph"
          : "model-reported-schema-validated",
        mechanicallyDerivedProducerCount: producersVerified ? derivedIds.length : null,
        mechanicallyDerivedProducerIds: producersVerified ? derivedIds : null,
        mechanicallyDerivedProducerCountAuthority: producersVerified
          ? "mechanically-derived-authenticated-projection-trace"
          : "unavailable",
        compiledTotal: args.fixedGraph
          ? args.fixedGraph.workItems.length
          : authority.graph.availability === "observed"
            ? (args.graph?.graphSize ?? null)
            : null,
        compiledTotalAuthority: args.fixedGraph
          ? "mechanically-counted-authenticated-fixed-graph"
          : authority.graph.availability === "observed"
            ? "mechanically-counted-authenticated-compiled-graph"
            : "unavailable",
        projectedTotal:
          authority.projection.availability === "observed"
            ? (args.projection?.graphSize ?? null)
            : null,
        projectedTotalAuthority:
          authority.projection.availability === "observed"
            ? "mechanically-counted-authenticated-projection"
            : "unavailable",
        criticalPath:
          compiledObjective &&
          (authority.graph.availability === "observed" || args.fixedGraph !== null)
            ? mechanicalDependencyCriticalPath(compiledObjective.workItems)
            : null,
        criticalPathAuthority: args.fixedGraph
          ? "mechanically-derived-authenticated-fixed-graph"
          : authority.graph.availability === "observed"
            ? "mechanically-derived-authenticated-compiled-graph"
            : "unavailable",
      },
    };
  } else if (terminalProposal?.proposal.kind === "objectives") {
    result = {
      ...resultBase,
      kind: "objectives",
      planning: {
        proposalCount: terminalProposal.proposal.objectives.length,
        proposalCountAuthority: "model-reported-schema-validated",
        triggerIdentities: terminalProposal.proposal.triggers.map(
          (trigger) => `${trigger.code}:${trigger.source}`,
        ),
        objectives: terminalProposal.proposal.objectives.map((objective) => ({
          id: objective.id,
          obligationIds: objective.obligationIds,
          planningEstimate: {
            workItems: objective.planningEstimate.workItems,
            criticalPathMinutes: objective.planningEstimate.criticalPathMinutes,
            aggregateWorkMinutes: objective.planningEstimate.aggregateWorkMinutes,
          },
          outputIds: objective.outputs.map((output) => output.id),
          prerequisiteOutputs: objective.prerequisiteOutputs,
        })),
        coverage: terminalProposal.proposal.coverage.map((coverage) =>
          coverage.disposition === "deferred"
            ? {
                obligationId: coverage.obligationId,
                disposition: coverage.disposition,
              }
            : {
                obligationId: coverage.obligationId,
                disposition: coverage.disposition,
                objectiveId: coverage.objectiveId,
                acceptanceId: coverage.acceptanceId,
              },
        ),
        triggers: terminalProposal.proposal.triggers.map((trigger) => ({
          code: trigger.code,
          source: trigger.source,
          availability: trigger.availability,
          threshold: trigger.threshold,
          obligationIds: trigger.obligationIds,
        })),
      },
    };
  } else if (terminalProposal?.proposal.kind === "clarification") {
    result = {
      ...resultBase,
      kind: "clarification",
      planning: {
        proposalCount: terminalProposal.proposal.requirements.length,
        proposalCountAuthority: "model-reported-schema-validated",
        triggerIdentities: terminalProposal.proposal.triggers.map(
          (trigger) => `${trigger.code}:${trigger.source}`,
        ),
        requirements: terminalProposal.proposal.requirements.map((requirement) => ({
          id: requirement.id,
          obligationIds: requirement.obligationIds,
        })),
        triggers: terminalProposal.proposal.triggers.map((trigger) => ({
          code: trigger.code,
          source: trigger.source,
          availability: trigger.availability,
          threshold: trigger.threshold,
          obligationIds: trigger.obligationIds,
        })),
      },
    };
  }

  const invocations = args.invocations.map(({ record, invocation }) => {
    const status = args.invocationStatus.find(
      (candidate) => candidate.invocationId === invocation.invocationId,
    )!;
    const providerResult = args.results.find(
      (candidate) => candidate.payload.invocationId === invocation.invocationId,
    );
    const preProviderTerminal = providerResult?.payload.preProviderTerminal === true;
    if (record.payload.expectedProvenance === undefined && !preProviderTerminal)
      throw new Error("compiler invocation dispatch provenance unavailable");
    const provenance =
      record.payload.expectedProvenance === undefined
        ? null
        : InvocationProvenance.parse(record.payload.expectedProvenance);
    const responseBytes =
      !providerResult || providerResult.payload.preProviderTerminal === true
        ? null
        : z.number().int().nonnegative().safe().parse(providerResult?.payload.responseBytes);
    const responseSource = !providerResult
      ? "unavailable-unresolved"
      : providerResult.payload.preProviderTerminal === true
        ? "not-applicable-pre-provider"
        : ResponseSizeSource.or(z.literal("no-structured-response")).parse(
            providerResult?.payload.responseBytesSource,
          );
    const hasInventory = invocation.stage !== "inventory" && args.inventory !== null;
    const sourceEvidence = args.records.find((candidate) => candidate.kind === "source-evidence")
      ?.payload.sourceEvidence;
    const evidenceBytes = hasInventory
      ? canonicalBytes(args.inventory!.evidence)
      : sourceEvidence === undefined
        ? null
        : canonicalBytes(sourceEvidence);
    return {
      ...status,
      sizes: {
        prompt: provenance
          ? { bytes: provenance.promptBytes, provenance: provenance.sizeSource }
          : { bytes: null, provenance: "not-applicable-pre-provider" },
        schema: provenance
          ? { bytes: provenance.schemaBytes, provenance: provenance.sizeSource }
          : { bytes: null, provenance: "not-applicable-pre-provider" },
        response: { bytes: responseBytes, provenance: responseSource },
        inventory: {
          bytes: hasInventory ? canonicalBytes(args.inventory) : null,
          provenance: hasInventory ? "reconstructed-authenticated-inventory" : "not-applicable",
        },
        evidence: {
          bytes: evidenceBytes,
          provenance: hasInventory
            ? "reconstructed-authenticated-inventory"
            : evidenceBytes === null
              ? "unavailable"
              : "reconstructed-authenticated-source-evidence",
        },
      },
    };
  });
  return {
    authority: {
      source: "authenticated-durable-records" as const,
      ...authority,
    },
    result,
    invocations,
  };
}

/** Reporting consumes authenticated snapshots and immutable Git objects; it never admits model work. */
export async function inspectCompilerEvaluation(args: {
  repository: string;
  snapshot: ApplicationSnapshot;
  store: CompiledGraphReadStore;
  annotations?: unknown;
}) {
  const annotations =
    args.annotations === undefined ? undefined : parseCompilerCausalAnnotations(args.annotations);
  const events = [
    ...(args.snapshot.factoryEvents ?? []),
    ...args.snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
  ];
  const run = latestRunReceipts(events, args.snapshot.objectiveAuthority);
  if (!run) {
    if (annotations) throw new Error("Compiler causal annotations require an authenticated run");
    return {
      operation: "compiler-eval",
      activationAuthorized: false,
      modelInvoked: false,
      reports: [],
      annotatedReports: [],
      runtimeEvidence: [],
      annotations: null,
      missingEvidence: ["No authenticated run is available"],
      markdown: "# Compiler evaluation\n\nNo authenticated run is available.\n",
    };
  }
  if (annotations && annotations.runId !== run.runId)
    throw new Error("Compiler causal annotations name a foreign run");
  const records = await loadCompilerDrafts(args.store, args.snapshot.number, run.runId);
  const binding = records[0]?.binding;
  if (
    binding &&
    (binding.repository !== args.repository ||
      binding.policyDigest !== run.start.policyDigest ||
      (run.start.baseSha && binding.baseSha !== run.start.baseSha))
  )
    throw new Error("compiler draft disagrees with authenticated run identity");
  const journalAuthority = validatePersistedCompilerDraftJournal(records);
  if (binding && journalAuthority?.sourceEvidence == null)
    throw new Error("compiler draft requires current durable source evidence");
  const sourceEvidence = binding
    ? CompilerSourceEvidence.parse(journalAuthority?.sourceEvidence)
    : null;
  if (
    binding &&
    sourceEvidence &&
    (sourceEvidence.objective.number !== binding.objective ||
      binding.inputDigest !==
        compilerEvalDigest({
          objective: sourceEvidence.objective,
          assetManifestDigest: run.start.assetManifestDigest ?? null,
          compilerMediaEgress: run.start.policy.compilerMediaEgress,
        }))
  )
    throw new Error("compiler draft input envelope identity mismatch");
  const hasFixedGraphRecord = records.some((record) => record.kind === "fixed-graph");
  const fixedGraph = journalAuthority?.fixedGraph;
  if (hasFixedGraphRecord && !fixedGraph)
    throw new Error("fixed compiler graph is not in its canonical journal position");
  const fixedEvaluation = fixedGraph
    ? (() => {
        const graphDigest = compiledGraphDigest(fixedGraph);
        const candidate = compilerJudgeCandidateFromCompiled(fixedGraph);
        return {
          candidate,
          proposalDigest: draftDigest(candidate),
          requestDigest: draftDigest({ fixedGraph: graphDigest }),
        };
      })()
    : null;
  const graph = await loadCompiledGraph(args.store, args.snapshot.number, run.runId);
  let projection: CompiledGraphProjectionRecord | null = null;
  let projectionConflict = false;
  if (graph) {
    try {
      projection = await loadCompiledGraphProjection(
        args.store,
        args.snapshot.number,
        run.runId,
        graph,
      );
    } catch (error) {
      if (!(error instanceof CompiledGraphProjectionConflictError)) throw error;
      projectionConflict = true;
    }
  }
  const selections = records.filter((record) => record.kind === "selection");
  if (selections.length > 1) throw new Error("multiple compiler draft selections");
  const selection = selections[0];
  if (graph && binding && (!selection || selection.payload.graphDigest !== graph.graphDigest))
    throw new Error("activated graph differs from accepted draft selection");
  const inventoryResults = records.filter(
    (record) =>
      record.kind === "result" &&
      record.payload.stage === "inventory" &&
      !compilerDraftResultHasError(record),
  );
  if (inventoryResults.length > 1) throw new Error("multiple obligation inventories");
  const inventory = inventoryResults[0]
    ? parseObligationInventory(inventoryResults[0].payload.value, {
        objectiveDigest: compilerEvalDigest(sourceEvidence!.objective),
        baseSha: binding!.baseSha,
        evidence: sourceEvidence!.evidence,
      })
    : null;
  const invocations = records
    .filter((record) => record.kind === "invocation")
    .map((record) => ({ record, invocation: Invocation.parse(record.payload) }));
  if (
    new Set(invocations.map((entry) => entry.invocation.invocationId)).size !== invocations.length
  )
    throw new Error("duplicate compiler invocation identity");
  const results = records.filter((record) => record.kind === "result");
  if (new Set(results.map((record) => record.payload.invocationId)).size !== results.length)
    throw new Error("duplicate compiler result identity");
  for (const result of results) {
    const invocation = invocations.find(
      (entry) => entry.invocation.invocationId === result.payload.invocationId,
    );
    if (
      !invocation ||
      invocation.record.sequence >= result.sequence ||
      invocation.invocation.stage !== result.payload.stage ||
      invocation.invocation.revision !== result.payload.revision
    )
      throw new Error("compiler result invocation binding mismatch");
  }
  const runtimeEvents = (run.events ?? events).filter(
    (event) => event.runId === run.runId && event.objective === args.snapshot.number,
  );
  const runtimeByDigest = new Map(runtimeEvents.map((event) => [draftDigest(event), event]));
  const boundedRuntimeEvents = [...runtimeByDigest.values()].slice(-128);
  const runtimeEvidence = boundedRuntimeEvents.map(safeReceiptEvidence);
  const runtimeEvidenceById = new Map(
    runtimeEvidence.map((evidence, index) => [evidence.id, boundedRuntimeEvents[index]!]),
  );
  const historicalEvidence: CompilerEvidence[] = invocations.map(({ record, invocation }) => ({
    id: `draft-invocation-${record.sequence}`,
    kind: "receipt",
    identity: `${run.runId}:${record.sequence}:${invocation.invocationId}`,
    excerpt: `Immutable ${invocation.stage} revision ${invocation.revision} invocation`,
  }));
  historicalEvidence.push(...runtimeEvidence);
  const terminalConflicts = records.filter((record) => record.kind === "terminal-conflict");
  const disputedUsage = new Set(
    terminalConflicts
      .filter((record) => record.payload.usageConflict === true)
      .map((record) => String(record.payload.invocationId)),
  );
  if (selection && terminalConflicts.length)
    throw new Error("Compiler selection conflicts with original terminal evidence");
  const unresolvedInvocations: string[] = [];
  const preProviderTerminals: Array<{
    invocationId: string;
    phase: CompilerEvalUsage["phase"];
    reason: string;
    evidenceId: string;
  }> = [];
  const usage: CompilerEvalUsage[] = invocations.flatMap(({ record, invocation }) => {
    const result = results.find((item) => item.payload.invocationId === invocation.invocationId);
    if (
      !disputedUsage.has(invocation.invocationId) &&
      result?.payload.preProviderTerminal === true &&
      result.payload.usage === null &&
      typeof result.payload.stopReason === "string"
    ) {
      preProviderTerminals.push({
        invocationId: invocation.invocationId,
        phase: invocation.stage === "inventory" ? "obligations" : invocation.stage,
        reason: result.payload.stopReason,
        evidenceId: `draft-invocation-${record.sequence}`,
      });
      return [];
    }
    const counters =
      disputedUsage.has(invocation.invocationId) || result?.payload.usage == null
        ? null
        : Usage.parse(result.payload.usage);
    if (
      counters?.cachedInputTokens !== undefined &&
      counters.cachedInputTokens > counters.inputTokens
    )
      throw new Error("invalid cached compiler token evidence");
    if (!counters) unresolvedInvocations.push(invocation.invocationId);
    return [
      {
        invocationId: invocation.invocationId,
        phase: invocation.stage === "inventory" ? "obligations" : invocation.stage,
        evidenceId: `draft-invocation-${record.sequence}`,
        inputTokens: counters?.inputTokens ?? null,
        outputTokens: counters?.outputTokens ?? null,
        cachedInputTokens: counters?.cachedInputTokens ?? null,
        observedTokens: counters ? counters.inputTokens + counters.outputTokens : null,
        observedMilliseconds:
          typeof result?.payload.observedMilliseconds === "number"
            ? result.payload.observedMilliseconds
            : null,
      },
    ];
  });
  const invocationStatus = invocations.map(({ invocation }) => {
    const result = results.find((item) => item.payload.invocationId === invocation.invocationId);
    const counters = usage.find((item) => item.invocationId === invocation.invocationId);
    return {
      invocationId: invocation.invocationId,
      stage: invocation.stage,
      revision: invocation.revision,
      state: !result
        ? ("reserved" as const)
        : result.payload.preProviderTerminal === true
          ? ("not-invoked" as const)
          : compilerDraftResultHasError(result)
            ? ("failed" as const)
            : ("completed" as const),
      inputTokens: counters?.inputTokens ?? null,
      outputTokens: counters?.outputTokens ?? null,
      cachedInputTokens: counters?.cachedInputTokens ?? null,
      observedTokens: counters?.observedTokens ?? null,
      observedMilliseconds: counters?.observedMilliseconds ?? null,
    };
  });
  const calibrationEvidence = createCalibrationEvidence({
    records,
    events: runtimeEvents,
    objective: args.snapshot.number,
    runId: run.runId,
    inventory,
    graph,
    fixedGraph: fixedGraph ?? null,
    projection,
    projectionConflict,
    invocations,
    results,
    invocationStatus,
  });
  const cumulativeUsage = {
    inputTokens: usage.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
    cachedInputTokens: usage.reduce((sum, item) => sum + (item.cachedInputTokens ?? 0), 0),
    observedTokens: usage.reduce((sum, item) => sum + (item.observedTokens ?? 0), 0),
    complete:
      usage.length === invocations.length && usage.every((item) => item.observedTokens !== null),
  };
  const missingEvidence: string[] = [];
  if (runtimeByDigest.size > boundedRuntimeEvents.length)
    missingEvidence.push(
      `${runtimeByDigest.size - boundedRuntimeEvents.length} older runtime receipts omitted from bounded annotation evidence; no causal claims are inferred from them`,
    );
  if (terminalConflicts.length)
    missingEvidence.push(
      "Conflicting original terminal evidence is retained; disputed token counters are unknown",
    );
  if (!records.length)
    missingEvidence.push(
      "This historical run predates draft evaluation; original obligations, judge findings and causal attribution are unavailable. Its old authority cannot authorize new evaluation calls.",
    );
  if (!inventory) missingEvidence.push("No completed obligation inventory");
  if (!selection) missingEvidence.push("No accepted draft selection");
  if (unresolvedInvocations.length)
    missingEvidence.push(
      `Unresolved compiler invocation accounting: ${unresolvedInvocations.join(", ")}`,
    );
  const accountingFailed = records.some(
    (record) =>
      record.kind === "accounting-failure" &&
      !records.some(
        (candidate) =>
          candidate.kind === "accounting-reconciled" &&
          candidate.payload.failureSequence === record.sequence,
      ),
  );
  if (accountingFailed)
    missingEvidence.push(
      "Compiler usage checkpoint exists but accounting reconciliation failed; ledger completeness is unavailable",
    );
  const invalidReviews: Array<{ sequence: number; evidenceDigest: string }> = [];
  const reportBindings = new Map<
    number,
    {
      proposalDigest: string;
      traceDigest: string;
      requestDigest: string;
      candidate: CompilerJudgeCandidate;
    }
  >();
  const reports = inventory
    ? results
        .filter(
          (record) => record.payload.stage === "judge" && !compilerDraftResultHasError(record),
        )
        .flatMap((record) => {
          const validated = records.find(
            (item) =>
              item.kind === "validation" &&
              item.payload.revision === record.payload.revision &&
              item.payload.valid === true &&
              item.sequence < record.sequence,
          );
          if (!validated) throw new Error("judge result has no mechanically validated draft");
          let proposal: CompilerJudgeCandidate;
          let requestDigest: string;
          let requestRevision: number;
          if (fixedEvaluation) {
            proposal = fixedEvaluation.candidate;
            requestDigest = fixedEvaluation.requestDigest;
            requestRevision = 0;
          } else {
            const proposalResult = results.find(
              (item) =>
                item.payload.revision === record.payload.revision &&
                (item.payload.stage === "compile" || item.payload.stage === "repair") &&
                !compilerDraftResultHasError(item),
            );
            if (
              !proposalResult ||
              !proposalResult.payload.value ||
              typeof proposalResult.payload.value !== "object"
            )
              throw new Error("judge result has no semantic proposal");
            const persisted = proposalResult.payload.value as Record<string, unknown>;
            const request = CompilerRequestSchema.parse(persisted.request);
            proposal = CompilerWorkItemsProposalSchema.parse(persisted.proposal);
            const proposalReport = CompilerValidationReportSchema.parse(persisted.report);
            const provenance = persisted.provenance as Record<string, unknown> | undefined;
            const proposalInvocation = invocations.find(
              (entry) => entry.invocation.invocationId === proposalResult.payload.invocationId,
            );
            requestDigest = draftDigest(request);
            requestRevision = request.revision;
            if (
              proposalReport.status !== "valid" ||
              requestRevision !== record.payload.revision ||
              draftDigest(request.inventory) !== draftDigest(inventory) ||
              provenance?.requestDigest !== requestDigest ||
              proposalInvocation?.invocation.compilerRequestDigest !== requestDigest
            )
              throw new Error("proposal result is not bound to its exact compiler request");
          }
          const trace = ProjectionTrace.parse(validated.payload.projectionTrace);
          const digest = String(validated.payload.graphDigest);
          const proposalDigest = fixedEvaluation?.proposalDigest ?? draftDigest(proposal);
          if (
            validated.payload.proposalDigest !== proposalDigest ||
            validated.payload.traceDigest !== draftDigest(trace) ||
            validated.payload.requestDigest !== requestDigest ||
            trace.proposalDigest !== proposalDigest ||
            trace.requestDigest !== requestDigest ||
            trace.graphDigest !== digest
          )
            throw new Error("projection trace is not bound to its exact proposal and request");
          try {
            const judgeInvocation = invocations.find(
              (entry) => entry.invocation.invocationId === record.payload.invocationId,
            )!;
            const reviewEvidence = judgeInvocation.record.payload.reviewEvidence ?? null;
            const challenges = validateCompilerInferenceChallenges(reviewEvidence ?? [], inventory);
            if (
              judgeInvocation.invocation.inputDigest !==
              draftDigest({
                inventory,
                previous: proposal,
                projection: trace,
                failure: reviewEvidence,
                ...(reviewEvidence === null ? {} : { reviewEvidence }),
              })
            )
              throw new Error("judge result is not bound to its exact invocation input");
            const report = createCompilerEvalReport({
              inventory,
              challenges,
              graph: proposal,
              addedEdges: trace.addedEdges,
              verdict: record.payload.value as Parameters<
                typeof createCompilerEvalReport
              >[0]["verdict"],
              draftDigest: digest,
              mode: graph ? "post-mortem" : "plan-review",
              usage,
              historicalEvidence,
              usageComplete: !accountingFailed && unresolvedInvocations.length === 0,
              notInvokedPhases: records.some((item) => item.payload.stage === "repair")
                ? []
                : ["repair"],
            });
            reportBindings.set(requestRevision, {
              proposalDigest,
              traceDigest: draftDigest(trace),
              requestDigest,
              candidate: proposal,
            });
            return [
              { ...report, revision: record.payload.revision, resultSequence: record.sequence },
            ];
          } catch {
            invalidReviews.push({ sequence: record.sequence, evidenceDigest: draftDigest(record) });
            return [];
          }
        })
    : [];
  if (invalidReviews.length)
    missingEvidence.push(
      `Invalid historical judge results retained: ${invalidReviews.map((item) => item.sequence).join(", ")}`,
    );
  if (selection) {
    const selectedRevision = Number(selection.payload.revision);
    const accepted = reports.find((report) => report.revision === selectedRevision);
    const acceptedBinding = reportBindings.get(selectedRevision);
    if (
      !accepted ||
      !acceptedBinding ||
      accepted.verdict.decision !== "accept" ||
      accepted.draftDigest !== selection.payload.graphDigest ||
      draftDigest(accepted.inventory) !== selection.payload.inventoryDigest ||
      draftDigest(accepted.verdict) !== selection.payload.verdictDigest ||
      draftDigest(accepted.challenges) !== draftDigest(selection.payload.reviewEvidence ?? []) ||
      acceptedBinding.proposalDigest !== selection.payload.proposalDigest ||
      acceptedBinding.traceDigest !== selection.payload.traceDigest ||
      acceptedBinding.requestDigest !== selection.payload.requestDigest
    )
      throw new Error("selection has no exact accepted judgment");
  }
  const annotatedReports = [];
  if (annotations) {
    const original = reports.find(
      (report) =>
        report.revision === annotations.revision && report.draftDigest === annotations.draftDigest,
    );
    if (!original)
      throw new Error("Compiler causal annotations name a stale or unavailable draft revision");
    const annotatedProposal = reportBindings.get(annotations.revision)?.candidate;
    if (!annotatedProposal)
      throw new Error("Compiler causal annotations have no bound judge candidate");
    const itemIds = new Set(annotatedProposal.workItems.map((item) => item.id));
    const findingIds = new Set(original.verdict.findings.map((finding) => finding.id));
    const causeIds = new Set<string>();
    for (const cause of annotations.causes) {
      if (!findingIds.has(cause.findingId) || causeIds.has(cause.findingId))
        throw new Error("Compiler causal annotations require unique existing finding references");
      causeIds.add(cause.findingId);
      if (
        new Set(cause.itemIds).size !== cause.itemIds.length ||
        cause.itemIds.some((id) => !itemIds.has(id))
      )
        throw new Error("Compiler causal annotation names an unknown or duplicate item");
      if (!cause.itemIds.length && !cause.attempts.length)
        throw new Error("Compiler causal annotation requires affected items or attempts");
      if (
        new Set(cause.evidenceIds).size !== cause.evidenceIds.length ||
        cause.evidenceIds.some((id) => !original.evidence.some((evidence) => evidence.id === id))
      )
        throw new Error(
          "Compiler causal annotation has a foreign or unavailable evidence reference",
        );
      // A downstream cause must cite an actual run receipt, not only a compiler's assertion.
      if (!cause.evidenceIds.some((id) => runtimeEvidenceById.has(id)))
        throw new Error("Compiler causal annotation requires cited runtime receipt evidence");
      const attempts = cause.attempts.map((attempt) => `${attempt.workItem}:${attempt.attempt}`);
      if (new Set(attempts).size !== attempts.length)
        throw new Error("Compiler causal annotation has duplicate attempts");
      for (const attempt of cause.attempts)
        if (
          !cause.evidenceIds.some((id) => {
            const event = runtimeEvidenceById.get(id);
            return event?.workItem === attempt.workItem && event.attempt === attempt.attempt;
          })
        )
          throw new Error(
            "Compiler causal annotation attempt is not supported by its cited receipts",
          );
    }
    const validation = records.find(
      (record) =>
        record.kind === "validation" &&
        record.payload.revision === annotations.revision &&
        record.payload.valid === true,
    )!;
    const annotated = createCompilerEvalReport({
      inventory: original.inventory,
      challenges: original.challenges,
      graph: annotatedProposal,
      addedEdges: (
        validation.payload.projectionTrace as {
          addedEdges: Array<{ itemId: string; dependsOn: string }>;
        }
      ).addedEdges,
      verdict: original.verdict,
      draftDigest: original.draftDigest,
      mode: original.mode,
      usage,
      historicalEvidence,
      usageComplete: !accountingFailed && unresolvedInvocations.length === 0,
      notInvokedPhases: records.some((record) => record.payload.stage === "repair")
        ? []
        : ["repair"],
      causes: annotations.causes,
    });
    annotatedReports.push({
      ...annotated,
      revision: annotations.revision,
      resultSequence: original.resultSequence,
      annotationDigest: draftDigest(annotations),
      annotationProvenance: annotations.provenance,
      causalAuthority:
        "caller-supplied; cited receipts are authenticated but causal conclusions are not",
      economicBenefitMeasured: false as const,
    });
  }
  // Original raw payloads stay in authenticated Git evidence. Provider errors can contain credentials.
  const history = records.map((record) => ({
    sequence: record.sequence,
    kind: record.kind,
    evidenceDigest: draftDigest(record),
    revision: typeof record.payload.revision === "number" ? record.payload.revision : null,
    failed:
      compilerDraftResultHasError(record) ||
      record.payload.valid === false ||
      record.kind === "accounting-failure" ||
      record.kind === "accounting-reconciled" ||
      record.kind === "terminal-conflict" ||
      record.kind === "stopped",
  }));
  const configuredMaxRepairs = records[0]?.payload.limits;
  const maxRepairs =
    configuredMaxRepairs &&
    typeof configuredMaxRepairs === "object" &&
    "maxRepairs" in configuredMaxRepairs &&
    typeof configuredMaxRepairs.maxRepairs === "number"
      ? configuredMaxRepairs.maxRepairs
      : null;
  const correctionBudget = {
    semantics: "shared across inventory regeneration and graph repair" as const,
    maxRepairs,
    inventoryRepairs: invocations.filter(
      ({ invocation }) => invocation.stage === "inventory" && invocation.revision > 0,
    ).length,
    graphRepairs: invocations.filter(({ invocation }) => invocation.stage === "repair").length,
  };
  const runtimeEconomics = summarizeRun(events, run.start.policy, args.snapshot.objectiveAuthority);
  const observedCompilerTokenSubtotal = usage.reduce(
    (sum, invocation) => sum + (invocation.observedTokens ?? 0),
    0,
  );
  const observedCompilerTokenTotal =
    !accountingFailed &&
    usage.length > 0 &&
    usage.every((invocation) => invocation.observedTokens !== null)
      ? observedCompilerTokenSubtotal
      : null;
  const compilerInvocationAccounting = [
    "## Compiler invocation accounting",
    "",
    ...(usage.length > 0
      ? usage.map(
          (invocation) =>
            `- ${invocation.invocationId} (${invocation.phase}): total tokens ${invocation.observedTokens ?? "unavailable"}; input ${invocation.inputTokens ?? "unavailable"}; output ${invocation.outputTokens ?? "unavailable"}; cached input ${invocation.cachedInputTokens ?? "unavailable"} (cached input is included in input); milliseconds ${invocation.observedMilliseconds ?? "unknown"}; evidence: ${invocation.evidenceId}`,
        )
      : preProviderTerminals.length
        ? []
        : ["- No compiler invocation records are available."]),
    ...preProviderTerminals.map(
      (terminal) =>
        `- ${terminal.invocationId} (${terminal.phase}): provider not invoked; terminal reason ${terminal.reason.replace(/[\r\n|]/g, " ")}; evidence: ${terminal.evidenceId}`,
    ),
    "",
    `Observed compiler token subtotal: ${observedCompilerTokenSubtotal}; complete total: ${observedCompilerTokenTotal ?? "unavailable"}.`,
    "",
  ];
  const runtimeAccounting = runtimeEconomics
    ? [
        "## Runtime accounting",
        "",
        ...Object.entries(runtimeEconomics.economics.usage).map(
          ([unit, metric]) =>
            `- ${unit}: ${metric.availability === "unavailable" ? "unknown" : metric.value} (${metric.availability})`,
        ),
        `- Unresolved runtime model invocations: ${runtimeEconomics.economics.unresolvedModelInvocations}`,
        `- Elapsed completion milliseconds: ${runtimeEconomics.elapsedMilliseconds.availability === "unavailable" ? "unknown" : runtimeEconomics.elapsedMilliseconds.value}`,
        "",
      ]
    : ["Runtime accounting unavailable.", ""];
  return {
    operation: "compiler-eval",
    version: 1,
    repository: args.repository,
    objective: args.snapshot.number,
    runId: run.runId,
    activationAuthorized: false,
    modelInvoked: false,
    records: history,
    invalidReviews,
    reports,
    annotatedReports,
    runtimeEvidence,
    annotations: annotations ?? null,
    usage,
    invocationStatus,
    cumulativeUsage,
    calibrationEvidence,
    preProviderTerminals,
    correctionBudget,
    unresolvedInvocations,
    graphDigest: graph?.graphDigest ?? null,
    runtimeEconomics,
    attribution: annotations
      ? "caller-supplied causal claims attached with verified receipt references; causality is not authenticated and estimated waste is not measured savings"
      : "unknown: downstream causal attribution requires supporting artifact and attempt evidence; repeated work alone is not compiler waste",
    missingEvidence,
    markdown: [
      "# Compiler draft history",
      "",
      `Run: ${run.runId}`,
      `Correction budget: maxRepairs is shared across inventory regeneration and graph repair; configured ${correctionBudget.maxRepairs ?? "unavailable"}, inventory repairs ${correctionBudget.inventoryRepairs}, graph repairs ${correctionBudget.graphRepairs}.`,
      ...missingEvidence.map((item) => `- ${item}`),
      "",
      ...history.map(
        (record) =>
          `- Record ${record.sequence}: ${record.kind}${record.failed ? " (original failure retained)" : ""}; evidence ${record.evidenceDigest}`,
      ),
      "",
      ...compilerInvocationAccounting,
      ...renderCalibrationMarkdown(calibrationEvidence),
      ...reports.map(renderCompilerEvalMarkdown),
      ...(annotations
        ? [
            "## Caller-supplied causal annotations",
            "",
            `Provenance: ${annotations.provenance.authorType}; source: ${annotations.provenance.source.replace(/[\r\n]+/g, " ").replace(/[^A-Za-z0-9 .,:/@+-]/g, " ")}. Citation identity is verified; causal conclusions remain caller supplied. Estimates are not measured savings.`,
            "",
            ...annotations.causes.map(
              (cause) =>
                `- Finding ${cause.findingId}: affected items ${cause.itemIds.join(", ") || "none specified"}; attempts ${cause.attempts.map((attempt) => `${attempt.workItem}/${attempt.attempt}`).join(", ") || "none specified"}; estimated avoidable milliseconds ${cause.estimatedAvoidableMilliseconds ?? "unknown"}.`,
            ),
            "",
            ...annotatedReports.map(renderCompilerEvalMarkdown),
          ]
        : []),
      ...runtimeAccounting,
      "Downstream causal attribution is unknown unless separately supported. Runtime receipt totals are provided in JSON; parallel worker durations are not elapsed completion time.",
      "",
    ].join("\n"),
  };
}
