import type { MergeProofInput, QualificationMergeProof } from "./qualification-merge-proof.mjs";
export function nativeQualificationEvents(evidence: unknown): Record<string, unknown>[];
export function assertQualificationCheckpoint(
  value: unknown,
  request: { ref: string; path: string; maxBytes: number },
  parents: string | string[],
): Record<string, unknown>;
export function nativeProofReader(
  request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>,
): (demand: unknown) => Promise<unknown>;
/** Foreground evidence remains same-run-only. Controller exercises may supply
 * controllerQualification: { peers: [] | [one full, noncyclic evidence object],
 * generation: { controllerId, epoch, controllerPolicyDigest } }.
 * Every member requires exact factory_activate runRequest, authenticated start and
 * controller receipts, and child.node_id for the immutable graph projection.
 * Additional peer GraphQL reads are retained in nativeMergeEvidence for replay. */
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
