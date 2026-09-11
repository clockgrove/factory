import type {
  CheckpointAuthority,
  CheckpointExtension,
  CheckpointPort,
} from "./verify-local-checkpoint-restart.mjs";
export type LargeFileCase =
  | "transfer-restart"
  | "lfs-missing-tool"
  | "lfs-missing-object"
  | "scope"
  | "secret"
  | "symlink";
export interface LargeFileAuthority extends CheckpointAuthority {
  largeFile: { scenario: LargeFileCase; fixture: string; fixtureDigest: string };
}
export interface LargeFilePort extends CheckpointPort {
  compileRefusal(): Promise<unknown>;
  artifactRefusal(observation: unknown): Promise<unknown>;
  armTransfer(original: unknown): Promise<unknown>;
  transferProof(
    observation: unknown,
    phase: "intent" | "ready",
    witness: unknown,
  ): Promise<unknown>;
}
export function largeFileAuthority(
  env: Record<string, string | undefined>,
): LargeFileAuthority | null;
export function transferArmPath(unit: string, invocationId: string, uid?: number): string;
export function largeFileTransferArm(
  authority: LargeFileAuthority,
  producer: {
    unit: string;
    invocationId: string;
    hostIdentity: string;
    pid: number;
    startTicks: string;
  },
  objective: number,
  baseSha: string,
): Record<string, unknown>;
export function transferHoldReady(
  observation: unknown,
  authority: LargeFileAuthority,
  arm: unknown,
): boolean;
export function runLargeFileScenario(
  port: LargeFilePort,
  authority: LargeFileAuthority,
): Promise<unknown>;
export function largeFileExtension(authority: LargeFileAuthority): CheckpointExtension;
export function main(env?: Record<string, string | undefined>): Promise<void>;
