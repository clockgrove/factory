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

function boundedObjectiveSourceSegments(value: string): string[] {
  return Array.from({ length: Math.ceil(value.length / 4_000) }, (_, index) =>
    value.slice(index * 4_000, (index + 1) * 4_000),
  );
}

/** Standard non-evaluated compilation carries a lossless structural coverage
 * envelope without claiming semantic extraction. Independent model extraction
 * and judgment remain policy-gated jobs. */
export function structuralObjectiveInventory(context: CompilationContext): ObligationInventory {
  const identity = compilerEvalDigest(context.objective);
  const segments = [
    context.objective.title,
    ...boundedObjectiveSourceSegments(context.objective.body),
  ];
  const evidence = segments.map((excerpt, index) => ({
    id: index === 0 ? "objective-title" : `objective-body-${index}`,
    kind: "objective" as const,
    identity,
    excerpt,
  }));
  return ObligationInventorySchema.parse({
    version: 1,
    objectiveDigest: identity,
    baseSha: context.baseSha,
    evidence,
    obligations: evidence.map((source, index) => {
      const label =
        index === 0
          ? "the complete Objective title"
          : `Objective body source segment ${index} of ${segments.length - 1}`;
      return {
        id: source.id,
        text: `Map ${label}.`,
        kind: "explicit" as const,
        evidenceIds: [source.id],
        acceptanceEvidence: `A Work Item maps ${label}.`,
      };
    }),
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
    inventorySource: "structural-source",
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
