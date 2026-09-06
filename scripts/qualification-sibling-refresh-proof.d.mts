import type { MergeProofInput, QualificationMergeProof } from "./qualification-merge-proof.mjs";
export function nativeQualificationEvents(evidence: unknown): Record<string, unknown>[];
export function nativeProofReader(
  request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>,
): (demand: unknown) => Promise<unknown>;
export function observeNativeMergeProofs(
  hooks: {
    evidence: unknown;
    request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>;
  },
  read?: (demand: unknown) => Promise<unknown>,
): Promise<QualificationMergeProof[]>;
export function assertNativeMergeProof(
  evidence: unknown,
  proof: unknown,
  input: MergeProofInput,
): void;
