export interface QualificationMergeProof {
  runId: string;
  objective: number;
  workItem: number;
  attempt: number;
  pullRequestNodeId: string;
  pullRequest: number;
  repository: string;
  repositoryNodeId: string;
  headSha: string;
  mergeSha: string;
}
export interface MergeProofInput {
  repository: string;
  pull: unknown;
  publication: unknown;
  integration: unknown;
}
export interface MergeProofHooks {
  request(route: string, parameters: Record<string, unknown>): Promise<unknown>;
}
export function readQualificationMergeProof(
  hooks: MergeProofHooks,
  input: MergeProofInput,
): Promise<QualificationMergeProof>;
export function readQualificationMergeProofForIdentity(
  hooks: MergeProofHooks,
  expected: QualificationMergeProof,
): Promise<QualificationMergeProof>;
export function assertQualificationMergeProof(proof: unknown, input: MergeProofInput): void;
export function observeQualificationMergeProofs(
  hooks: MergeProofHooks,
  evidence: unknown,
): Promise<QualificationMergeProof[]>;
