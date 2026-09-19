import type { MergeProofInput, QualificationMergeProof } from "./qualification-merge-proof.mjs";

export interface SettledQualificationMergeProof extends QualificationMergeProof {
  sourceHeadSha: string;
  refreshCommitShas: string[];
}

export function observeSettledQualificationMergeProofs(input: {
  entry: unknown;
  request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>;
  repository: string;
}): Promise<SettledQualificationMergeProof[]>;

export function assertSettledQualificationMergeProof(proof: unknown, input: MergeProofInput): void;
