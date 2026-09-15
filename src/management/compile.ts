import type { CompiledObjective } from "../graph.js";
import type { CompilerProposal, CompilerValidationReport } from "../compiler/contracts.js";
import {
  compilerWorkItemsForEconomics,
  prepareCompilerRequest,
  projectCompilerProposal,
  type CompilerProjectionTrace,
  CompilerRequestValidationError,
} from "../compiler/proposal.js";
import {
  compilerEvalDigest,
  ObligationInventorySchema,
  type ObligationInventory,
} from "../evaluation/compiler-eval.js";
import type {
  CompilationContext,
  CompilerModelAdmission,
  CompilerProposalProvenance,
  ManagementBackend,
  ManagementUsage,
} from "./backend.js";

export interface CompiledPlanResult {
  objective: CompiledObjective;
  proposal: CompilerProposal;
  report: CompilerValidationReport;
  trace: CompilerProjectionTrace;
  provenance: CompilerProposalProvenance;
  usage: ManagementUsage;
}

export type CompiledPlanCheckpoint = (result: CompiledPlanResult) => Promise<void>;

function boundedObjectiveSegments(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const units = normalized
    .split(/\n+/)
    .flatMap((line) => line.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9`])/))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const chunks: string[] = [];
      let remaining = entry;
      while (remaining.length > 4_000) {
        const whitespace = remaining.lastIndexOf(" ", 4_000);
        const boundary = whitespace > 0 ? whitespace : 4_000;
        chunks.push(remaining.slice(0, boundary).trim());
        remaining = remaining.slice(boundary).trim();
      }
      if (remaining) chunks.push(remaining);
      return chunks;
    });
  if (units.length <= 127) return units;

  // The Objective body is bounded below the inventory's aggregate text capacity.
  // Coalesce only unusually fragmented prose, preserving all source text while
  // keeping one slot for the title and at most 128 total obligations.
  const compactSource = units.join("\n");
  const compacted = Array.from({ length: Math.ceil(compactSource.length / 4_000) }, (_, index) =>
    compactSource.slice(index * 4_000, (index + 1) * 4_000).trim(),
  ).filter(Boolean);
  if (compacted.length > 127)
    throw new Error("Objective is too fragmented for the bounded obligation inventory");
  return compacted;
}

/** Standard non-evaluated compilation inventories every explicit Objective
 * segment. Independent semantic extraction and judgment remain policy-gated jobs. */
export function structuralObjectiveInventory(context: CompilationContext): ObligationInventory {
  const identity = compilerEvalDigest(context.objective);
  const segments = [
    context.objective.title.trim(),
    ...boundedObjectiveSegments(context.objective.body),
  ];
  const evidence = segments.map((excerpt, index) => ({
    id: index === 0 ? "objective-title" : `objective-segment-${index}`,
    kind: "objective" as const,
    identity,
    excerpt,
  }));
  return ObligationInventorySchema.parse({
    version: 1,
    objectiveDigest: identity,
    baseSha: context.baseSha,
    evidence,
    obligations: evidence.map((source) => ({
      id: source.id,
      text: source.excerpt,
      kind: "explicit" as const,
      evidenceIds: [source.id],
      acceptanceEvidence: "Concrete acceptance criteria preserve this exact Objective segment.",
    })),
  });
}

export async function compilePlan(
  context: CompilationContext,
  backend: ManagementBackend,
  checkpoint: CompiledPlanCheckpoint,
  beforeModelInvocation?: CompilerModelAdmission,
): Promise<CompiledPlanResult> {
  const prepared = await prepareCompilerRequest({
    context,
    inventory: structuralObjectiveInventory(context),
  });
  if (prepared.report.status !== "valid") throw new CompilerRequestValidationError(prepared.report);
  let projected: CompiledPlanResult | undefined;
  const result = await backend.proposePlan(
    prepared.request,
    async (proposalResult) => {
      if (
        compilerEvalDigest(proposalResult.request) !== compilerEvalDigest(prepared.request) ||
        proposalResult.provenance.requestDigest !== compilerEvalDigest(prepared.request)
      )
        throw new Error("management proposal differs from its exact compiler request");
      const economics = context.economicEvidence
        ? await context.economicEvidence(
            compilerWorkItemsForEconomics(
              prepared.request,
              proposalResult.proposal,
              prepared.pinnedFacts,
              context.runPolicy,
            ),
          )
        : undefined;
      const projection = projectCompilerProposal({
        request: prepared.request,
        proposal: proposalResult.proposal,
        pinnedFacts: prepared.pinnedFacts,
        runPolicy: context.runPolicy,
        ...(economics ? { economicEvidence: economics } : {}),
        ...(prepared.legacyGraphConstraints
          ? { legacyGraphConstraints: prepared.legacyGraphConstraints }
          : {}),
      });
      projected = {
        objective: projection.objective,
        proposal: proposalResult.proposal,
        report: proposalResult.report,
        trace: projection.trace,
        provenance: proposalResult.provenance,
        usage: proposalResult.usage,
      };
      await checkpoint(projected);
    },
    beforeModelInvocation,
    context,
  );
  if (!projected)
    throw new Error(
      `management backend returned proposal ${compilerEvalDigest(result.proposal)} without checkpoint`,
    );
  return projected;
}
