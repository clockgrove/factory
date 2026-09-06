import type { CheckpointAuthority } from "./verify-local-checkpoint-restart.mjs";
export function appServerCheckpointPath(unit: string, invocationId: string, uid?: number): string;
export function appServerCheckpointArm(
  authority: CheckpointAuthority,
  original: Record<string, unknown>,
  objective: number,
  now?: number,
): Record<string, unknown>;
export function assertAppServerCheckpoint(
  observation: unknown,
  authority: CheckpointAuthority,
  proof: unknown,
  witness?: unknown,
): Record<string, unknown>;
export function observeAppServerCheckpoints(
  request: (route: string, args: Record<string, unknown>) => Promise<unknown>,
  observation: unknown,
  authority: CheckpointAuthority,
  witness?: unknown,
): Promise<Record<string, unknown>[]>;
