import type { CheckpointAuthority } from "./verify-local-checkpoint-restart.mjs";
export function appServerCheckpointPath(unit: string, invocationId: string, uid?: number): string;
export function appServerCheckpointArm(
  authority: CheckpointAuthority,
  original: Record<string, unknown>,
  objective: number,
): Record<string, unknown>;
export function assertAppServerCheckpoint(
  observation: unknown,
  authority: CheckpointAuthority,
  proof: unknown,
  witness?: unknown,
  verifiedAt?: string,
): Record<string, unknown>;
export function appServerCheckpointIdentity(
  receipt: Record<string, unknown>,
): Record<string, unknown>;
export function assertAppServerCheckpointContinuation(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  stage: "post-takeover" | "final",
): Record<string, unknown>[];
export function appServerCheckpointContinuationFailureContext(error: unknown):
  | {
      checkpointStage: "post-takeover" | "final";
      checkpointField: string;
      checkpointInvariant:
        | "stable-identity"
        | "stable-authority"
        | "authority-descendant"
        | "authority-revision"
        | "authority-transition";
    }
  | undefined;
export function observeAppServerCheckpoints(
  request: (route: string, args: Record<string, unknown>) => Promise<unknown>,
  observation: unknown,
  authority: CheckpointAuthority,
  witness?: unknown,
): Promise<Record<string, unknown>[]>;
