import type { CompiledObjective } from "../graph.js";
import type { NormalizedArtifact } from "../execution/artifacts.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { ValidationEvidence } from "../validation/evidence.js";
import type { ModelSelection } from "../protocol/policy.js";
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

  constructor(cause: unknown, usage: ManagementUsage) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ManagementOutputError";
    this.usage = { ...usage };
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
  modelSelection?: ModelSelection;
  /** Read-only trusted observations after grounding; omitted callers retain explicit unknowns. */
  economicEvidence?: (items: readonly CompilerWorkItem[]) => Promise<DecompositionEvidence>;
}

export interface CompilationResult {
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
  modelSelection?: ModelSelection;
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

export interface ManagementBackend {
  readonly id: string;
  probe(): Promise<{ available: boolean; authenticated: boolean; reason?: string }>;
  compile(
    context: CompilationContext,
    checkpoint: CompilationCheckpoint,
  ): Promise<CompilationResult>;
  review(context: ReviewContext, checkpoint: ReviewCheckpoint): Promise<ReviewResult>;
  /** Optional local preparation boundary. The backend must call dispatch exactly
   * once immediately around the paid invocation, after non-model preparation. */
  reviewWithAdmission?(
    context: ReviewContext,
    checkpoint: ReviewCheckpoint,
    dispatch: (invoke: () => Promise<ReviewResult>) => Promise<ReviewResult>,
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
