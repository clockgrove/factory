import type { CompiledObjective } from "../graph.js";
import type {
  CompilerObjectivesProposal,
  CompilerClarificationProposal,
  CompilerProposal,
  CompilerValidationReport,
} from "../compiler/contracts.js";
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
import {
  assertCompilationContextPolicyAuthority,
  type CompilationContext,
  type CompilerModelAdmission,
  type CompilerProposalProvenance,
  type ManagementBackend,
  type ManagementUsage,
} from "./backend.js";

export interface CompiledPlanResult {
  kind: "work-items";
  objective: CompiledObjective;
  proposal: CompilerProposal;
  report: CompilerValidationReport;
  trace: CompilerProjectionTrace;
  provenance: CompilerProposalProvenance;
  usage: ManagementUsage;
}

export interface ObjectivePlanningResult {
  kind: "objectives" | "clarification";
  proposal: CompilerObjectivesProposal | CompilerClarificationProposal;
  report: CompilerValidationReport;
  provenance: CompilerProposalProvenance;
  usage: ManagementUsage;
}

export type PlanCompilationResult = CompiledPlanResult | ObjectivePlanningResult;

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
): Promise<PlanCompilationResult> {
  assertCompilationContextPolicyAuthority(context);
  const supportedMediaTypes = new Set(backend.compilerInputMediaTypes ?? []);
  const unsupportedMediaTypes = [
    ...new Set(
      (context.mediaPlanning?.mediaInputs ?? [])
        .map(({ mediaType }) => mediaType)
        .filter((mediaType) => !supportedMediaTypes.has(mediaType)),
    ),
  ].sort();
  if (unsupportedMediaTypes.length)
    throw new Error(
      `management compiler does not support separately bound media inputs: ${unsupportedMediaTypes.join(", ")}`,
    );
  const prepared = await prepareCompilerRequest({
    context,
    inventory: structuralObjectiveInventory(context),
    inventorySource: "structural-source",
  });
  if (prepared.report.status !== "valid") throw new CompilerRequestValidationError(prepared.report);
  let projected: PlanCompilationResult | undefined;
  const result = await backend.proposePlan(
    prepared.request,
    async (proposalResult) => {
      if (
        compilerEvalDigest(proposalResult.request) !== compilerEvalDigest(prepared.request) ||
        proposalResult.provenance.requestDigest !== compilerEvalDigest(prepared.request)
      )
        throw new Error("management proposal differs from its exact compiler request");
      if (proposalResult.proposal.kind !== "work-items") {
        projected = {
          kind: proposalResult.proposal.kind,
          proposal: proposalResult.proposal,
          report: proposalResult.report,
          provenance: proposalResult.provenance,
          usage: proposalResult.usage,
        };
        return;
      }
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
        ...(context.mediaPlanning
          ? {
              mediaPlanning: {
                assetBindings: context.mediaPlanning.assetBindings,
                producerCapabilities: context.mediaPlanning.producerCapabilities,
                reviewRules: context.mediaPlanning.reviewRules,
              },
            }
          : {}),
        ...(economics ? { economicEvidence: economics } : {}),
        ...(prepared.legacyGraphConstraints
          ? { legacyGraphConstraints: prepared.legacyGraphConstraints }
          : {}),
      });
      projected = {
        kind: "work-items",
        objective: projection.objective,
        proposal: proposalResult.proposal,
        report: proposalResult.report,
        trace: projection.trace,
        provenance: proposalResult.provenance,
        usage: proposalResult.usage,
      };
      await checkpoint(projected);
    },
    {
      pinnedFacts: prepared.pinnedFacts,
      runPolicy: context.runPolicy,
      ...(context.mediaPlanning
        ? {
            mediaPlanning: {
              assetBindings: context.mediaPlanning.assetBindings,
              producerCapabilities: context.mediaPlanning.producerCapabilities,
              reviewRules: context.mediaPlanning.reviewRules,
            },
          }
        : {}),
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

/** Compatibility boundary for backends that cannot place admission at dispatch. */
export async function compilePlanWithLegacyAdmission(
  context: CompilationContext,
  backend: ManagementBackend,
  checkpoint: CompiledPlanCheckpoint,
  admitCompilation: () => Promise<{ timeoutMs: number }>,
): Promise<PlanCompilationResult> {
  assertCompilationContextPolicyAuthority(context);
  context.invocationTimeoutMs = (await admitCompilation()).timeoutMs;
  return compilePlan(context, backend, checkpoint);
}
