import type { CompiledObjective } from "../graph.js";
import type { NormalizedArtifact } from "../execution/artifacts.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { ValidationEvidence } from "../validation/evidence.js";

export interface ManagementUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompilationContext {
  repository: string;
  objective: { number: number; title: string; body: string };
  defaultBranch: string;
  baseSha: string;
  repositoryFiles: string[];
  allowedNetworkDestinations: string[];
}

export interface CompilationResult {
  objective: CompiledObjective;
  usage: ManagementUsage;
}

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
}

export interface ReviewResult {
  review: SemanticReview;
  usage: ManagementUsage;
}

export interface ManagementBackend {
  readonly id: string;
  probe(): Promise<{ available: boolean; authenticated: boolean; reason?: string }>;
  compile(context: CompilationContext): Promise<CompilationResult>;
  review(context: ReviewContext): Promise<ReviewResult>;
}
