import type { Buffer } from "node:buffer";
export interface ArtifactTransferOptions {
  workItem?: number;
  phase: "intent" | "ready";
  witness?: unknown;
  /** Exact raw `proof` returned at the intent hold, not a summary or caller assertion. */
  priorIntent?: unknown;
}
export interface ArtifactTransferResult {
  summary: Record<string, unknown>;
  artifact: Record<string, unknown>;
  /** Verified applicable bytes; never the artifact's display-only patch marker. Null at intent. */
  patch: Buffer | null;
}
export function assertArtifactTransferProof(
  observation: unknown,
  authority: { repository: string; namespace: string; policy: unknown },
  proof: unknown,
  options: ArtifactTransferOptions,
): ArtifactTransferResult;
export function observeArtifactTransfer(
  request: (route: string, args: Record<string, unknown>) => Promise<unknown>,
  observation: unknown,
  authority: { repository: string; namespace: string; policy: unknown },
  options: ArtifactTransferOptions & { workItem: number },
): Promise<ArtifactTransferResult & { proof: Record<string, unknown> }>;
