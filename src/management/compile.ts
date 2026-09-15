import type { CompiledObjective } from "../graph.js";
import type { CompilerProposal, CompilerValidationReport } from "../compiler/contracts.js";
import {
  compilerWorkItemsForEconomics,
  prepareCompilerRequest,
  projectCompilerProposal,
  type CompilerProjectionTrace,
  CompilerRequestValidationError,
} from "../compiler/proposal.js";
import { compilerEvalDigest, type ObligationInventory } from "../evaluation/compiler-eval.js";
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

/** Standard non-evaluated compilation still supplies a complete structural
 * inventory. Independent extraction and judgment remain policy-gated jobs. */
export function structuralObjectiveInventory(context: CompilationContext): ObligationInventory {
  const identity = compilerEvalDigest(context.objective);
  return {
    version: 1,
    objectiveDigest: identity,
    baseSha: context.baseSha,
    evidence: [
      {
        id: "objective",
        kind: "objective",
        identity,
        excerpt: `${context.objective.title}\n${context.objective.body}`.slice(0, 4_000),
      },
    ],
    obligations: [
      {
        id: "objective-complete",
        text: "Deliver every explicit requirement in the Objective.",
        kind: "explicit",
        evidenceIds: ["objective"],
        acceptanceEvidence: "Every explicit Objective requirement maps to acceptance criteria.",
      },
    ],
  };
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
