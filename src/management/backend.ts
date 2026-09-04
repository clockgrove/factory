import type { CompiledObjective } from "../graph.js";
import type { NormalizedArtifact } from "../execution/artifacts.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { ValidationEvidence } from "../validation/evidence.js";
import type { ModelSelection } from "../protocol/policy.js";

export interface ManagementUsage {
  inputTokens: number;
  outputTokens: number;
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
  allowedNetworkDestinations: string[];
  modelSelection?: ModelSelection;
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
  repository: string;
  objectiveNumber: number;
  workItemNumber: number;
  packet: WorkerPacket;
  artifact: NormalizedArtifact;
  evidence: ValidationEvidence;
  modelSelection?: ModelSelection;
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
}
