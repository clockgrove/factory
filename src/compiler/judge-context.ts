import type { CompilerProposal } from "./contracts.js";
import type { CompilerProjectionTrace } from "./proposal.js";
import type { CompiledObjective, CompiledWorkItem } from "../graph.js";
import type {
  CompilerInferenceChallenge,
  ObligationInventory,
} from "../evaluation/compiler-eval.js";

export const MAX_COMPILER_JUDGE_SOURCE_BYTES = 900 * 1024;

export type PersistedCompiledObjectiveJudgeItem = CompiledWorkItem & {
  /** Deterministic binding IDs for judge acceptance rows; persisted text remains unchanged. */
  criteria: Array<{ id: string; text: string }>;
  obligationIds: [];
};

/** Lossless report-only judge view over the complete persisted graph. */
export interface PersistedCompiledObjectiveJudgeCandidate {
  protocol: "clockgrove.factory/persisted-compiled-objective-candidate";
  title: string;
  workItems: PersistedCompiledObjectiveJudgeItem[];
  deferredCapabilityAdapters?: string[];
}

export type CompilerJudgeCandidate = CompilerProposal | PersistedCompiledObjectiveJudgeCandidate;

export function compilerJudgeCandidateFromCompiled(
  graph: CompiledObjective,
): PersistedCompiledObjectiveJudgeCandidate {
  return {
    protocol: "clockgrove.factory/persisted-compiled-objective-candidate",
    title: graph.title,
    workItems: graph.workItems.map((item) => ({
      ...structuredClone(item),
      obligationIds: [],
      criteria: item.acceptance.map((text, index) => ({ id: `criterion-${index + 1}`, text })),
    })),
    ...(graph.deferredCapabilityAdapters === undefined
      ? {}
      : { deferredCapabilityAdapters: [...graph.deferredCapabilityAdapters] }),
  };
}

export function boundedCompilerPriorFailure(
  failure: { reason: string; rawProposalAvailable: false } | undefined,
): { reason: string; rawProposalAvailable: false } | undefined {
  if (!failure) return undefined;
  if (
    failure.rawProposalAvailable !== false ||
    failure.reason.length < 1 ||
    failure.reason.length > 8_000
  )
    throw new Error("invalid prior compilation failure diagnostic");
  return failure;
}

export interface CompilerJudgeSourceInput {
  originalObjective: { number: number; title: string; body: string };
  baseSha: string;
  priorCompilationFailure?: { reason: string; rawProposalAvailable: false };
  inventory: ObligationInventory;
  challenges: CompilerInferenceChallenge[];
  proposal: CompilerJudgeCandidate;
  projectionTrace: CompilerProjectionTrace;
  draftDigest: string;
  inventoryDigest: string;
}

export function buildCompilerJudgeSource(input: CompilerJudgeSourceInput) {
  return {
    originalObjective: input.originalObjective,
    baseSha: input.baseSha,
    ...(input.priorCompilationFailure
      ? { priorCompilationFailure: input.priorCompilationFailure }
      : {}),
    inventory: input.inventory,
    challenges: input.challenges,
    proposal: input.proposal,
    projectionTrace: input.projectionTrace,
    draftDigest: input.draftDigest,
    inventoryDigest: input.inventoryDigest,
  };
}

export function compilerJudgeSourceBytes(input: CompilerJudgeSourceInput): number {
  return Buffer.byteLength(JSON.stringify(buildCompilerJudgeSource(input)));
}
