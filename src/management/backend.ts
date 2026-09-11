import type {
  ObligationInventory,
  CompilerJudgeVerdict,
  CompilerInferenceChallenge,
  CompilerEvidence,
  CompilerCaseLabel,
} from "../evaluation/compiler-eval.js";
import type { CompiledObjective, LegacyGraphConstraints } from "../graph.js";
import type { NormalizedArtifact } from "../execution/artifacts.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { ValidationEvidence } from "../validation/evidence.js";
import type { ModelSelection, RunPolicy } from "../protocol/policy.js";
import type { CompilerWorkItem, DecompositionEvidence } from "../compiler/index.js";
import type { PinnedLfsFacts } from "../repository-profiles/git-lfs.js";

export interface ManagementUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported subset of inputTokens; absence means unavailable. */
  cachedInputTokens?: number | undefined;
}

/** A paid response was observed but could not become a valid management result. */
export class ManagementOutputError extends Error {
  readonly usage: ManagementUsage;
  readonly proposal: unknown;

  constructor(cause: unknown, usage: ManagementUsage, proposal?: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ManagementOutputError";
    this.usage = { ...usage };
    this.proposal = proposal;
  }
}

export interface CompilationContext {
  repository: string;
  objective: { number: number; title: string; body: string };
  defaultBranch: string;
  baseSha: string;
  repositoryFiles: string[];
  repositoryLfs?: PinnedLfsFacts;
  allowedNetworkDestinations: string[];
  /** Exact immutable policy activated for this compilation. */
  runPolicy: RunPolicy;
  modelSelection?: ModelSelection;
  /** Remaining per-invocation operation-stall bound, capped by immutable policy
   * and the Objective deadline; not a hard provider token cap. */
  invocationTimeoutMs?: number;
  /** Trusted pinned source evidence captured once for the draft envelope. */
  repositoryEvidence?: CompilerEvidence[];
  /** Authenticated pre-v2 issue core. The compiler may enrich, never decompose or rewrite it. */
  legacyGraphConstraints?: LegacyGraphConstraints;
  /** Read-only trusted observations after grounding; omitted callers retain explicit unknowns. */
  economicEvidence?: (items: readonly CompilerWorkItem[]) => Promise<DecompositionEvidence>;
}

export interface CompilerProposalTrace {
  rawProposal: unknown;
  normalizationTrace: string[];
  promptDigest: string;
  schemaDigest: string;
  model: string | null;
  reasoning: string | null;
  baseSha: string;
}

export interface ObligationResult {
  inventory: ObligationInventory;
  usage: ManagementUsage;
}
export type ObligationCheckpoint = (result: ObligationResult) => Promise<void>;
export interface PlanJudgeContext {
  challenges?: CompilerInferenceChallenge[];
  compilation: CompilationContext;
  inventory: ObligationInventory;
  objective: CompiledObjective;
}
export interface PlanJudgeResult {
  verdict: CompilerJudgeVerdict;
  usage: ManagementUsage;
}
export type PlanJudgeCheckpoint = (result: PlanJudgeResult) => Promise<void>;
export interface PlanRepairContext {
  challenges?: CompilerInferenceChallenge[];
  compilation: CompilationContext;
  inventory: ObligationInventory;
  objective?: CompiledObjective;
  verdict?: CompilerJudgeVerdict;
  previousProposal?: unknown;
  validationFailure?: string;
  revision: number;
}
export interface CompilerCaseLabelContext {
  compilation: CompilationContext;
  caseDigest: string;
  pass: "blinded" | "adjudication";
  priorLabel?: CompilerCaseLabel;
}
export interface CompilerCaseLabelResult {
  provenance: {
    promptDigest: string;
    schemaDigest: string;
    sourceDigest: string;
    baseSha: string;
    requestedModel: string | null;
    requestedReasoning: string | null;
    providerReportedModel: null;
    priorLabelDigest: string | null;
  };
  label: CompilerCaseLabel;
  usage: ManagementUsage;
}
export type CompilerCaseLabelCheckpoint = (result: CompilerCaseLabelResult) => Promise<void>;
export interface PlanRepairSummary {
  changeSummary: string;
  lineage: Array<{ itemId: string; previousItemIds: string[] }>;
  findingDispositions: Array<{
    findingId: string;
    disposition: "addressed" | "challenged";
    reason: string;
    evidenceIds: string[];
  }>;
}

export interface CompilationResult {
  provenance?: CompilerProposalTrace;
  repair?: PlanRepairSummary;
  objective: CompiledObjective;
  usage: ManagementUsage;
}

/**
 * The management backend must not expose a paid compilation result to its
 * caller until this callback has durably checkpointed that exact result.
 */
export type CompilationCheckpoint = (result: CompilationResult) => Promise<void>;

export interface SemanticReview {
  accepted: boolean;
  summary: string;
  unmetCriteria: string[];
  risks: string[];
}

export interface ReviewContext {
  /** Source object repository. Filesystem-consuming backends must prepare the
   * exact artifact/evidence tree; this mutable checkout is not review evidence. */
  repository: string;
  objectiveNumber: number;
  workItemNumber: number;
  packet: WorkerPacket;
  artifact: NormalizedArtifact;
  evidence: ValidationEvidence;
  publicationBaseBranch?: string;
  modelSelection?: ModelSelection;
  /** Remaining per-invocation operation-stall bound for legacy review adapters.
   * Implementations with reviewWithAdmission clamp its fresher final-boundary
   * callback by this bound. */
  invocationTimeoutMs?: number;
  /** Includes current/source policy and inherited execution isolation. Packet
   * trust remains independently authoritative, including for legacy callers. */
  requiresIsolation?: boolean;
}

export interface ReviewResult {
  review: SemanticReview;
  usage: ManagementUsage;
}

/** Same paid-result durability boundary as Objective compilation. */
export type ReviewCheckpoint = (result: ReviewResult) => Promise<void>;

/** Called once after local preparation, immediately before dispatch; may return remaining timeout milliseconds. */
export type CompilerModelAdmission = () => Promise<
  number | void | { timeoutMs?: number; modelInvocationId: string }
>;
export interface ManagementBackend {
  /** Required for evaluated drafts; older backends must not silently ignore admission. */
  readonly supportsCompilerAdmission?: true;
  readonly id: string;
  probe(): Promise<{ available: boolean; authenticated: boolean; reason?: string }>;
  compile(
    context: CompilationContext,
    checkpoint: CompilationCheckpoint,
    beforeModelInvocation?: CompilerModelAdmission,
  ): Promise<CompilationResult>;
  /** Draft-stage calls share the compile accounting/checkpoint boundary. Legacy backends
   * may omit them; callers must refuse judge-enabled compilation when unavailable. */
  labelCompilerCase?(
    context: CompilerCaseLabelContext,
    checkpoint: CompilerCaseLabelCheckpoint,
  ): Promise<CompilerCaseLabelResult>;
  extractObligations?(
    context: CompilationContext,
    checkpoint: ObligationCheckpoint,
    beforeModelInvocation?: CompilerModelAdmission,
  ): Promise<ObligationResult>;
  judgePlan?(
    context: PlanJudgeContext,
    checkpoint: PlanJudgeCheckpoint,
    beforeModelInvocation?: CompilerModelAdmission,
  ): Promise<PlanJudgeResult>;
  repairPlan?(
    context: PlanRepairContext,
    checkpoint: CompilationCheckpoint,
    beforeModelInvocation?: CompilerModelAdmission,
  ): Promise<CompilationResult>;
  review(context: ReviewContext, checkpoint: ReviewCheckpoint): Promise<ReviewResult>;
  /** Optional local preparation boundary. The backend must call the admission
   * callback exactly once immediately before paid invocation dispatch, after
   * non-model preparation, and use its returned remaining timeout. */
  reviewWithAdmission?(
    context: ReviewContext,
    checkpoint: ReviewCheckpoint,
    beforeModelInvocation: CompilerModelAdmission,
  ): Promise<ReviewResult>;
}
/** A durable model result does not prove its private review checkout was removed. */
export class ReviewCheckoutCleanupError extends Error {
  readonly usage: ManagementUsage | undefined;

  constructor(cause: unknown, reviewFailure?: unknown) {
    super("semantic review private checkout cleanup is unresolved", { cause });
    this.name = "ReviewCheckoutCleanupError";
    this.usage =
      reviewFailure instanceof ManagementOutputError ? { ...reviewFailure.usage } : undefined;
  }
}
