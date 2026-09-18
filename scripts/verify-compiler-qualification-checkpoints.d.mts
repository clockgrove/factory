import type { CheckpointExtension } from "./verify-local-checkpoint-restart.mjs";

export type CompilerCheckpointKind = "compiler-selection" | "graph-projection";
export interface CompilerCheckpointPolicy extends Record<string, unknown> {
  objectiveTimeoutMinutes: number;
  workItemTimeoutMinutes: number;
  compilerEvaluation?: {
    mode: "auto-repair";
    maxRepairs: number;
    maxInvocations: number;
    timeoutSeconds: number;
    maxObservedTokens: number;
  };
}
export interface CompilerCheckpointAuthority extends Record<string, unknown> {
  repository: string;
  checkout: string;
  unit: string;
  phase: string;
  namespace: string;
  evidence: string;
  policy: CompilerCheckpointPolicy;
  compilerRecovery: boolean;
  compilerMaxModelTokens: number;
}
export interface CompilerController extends Record<string, unknown> {
  unit: string;
  pid: number;
  startTicks: string;
  invocationId: string;
  hostIdentity: string;
}
export interface CompilerCheckpointArm extends Record<string, unknown> {
  protocol: "clockgrove.factory/compiler-qualification-checkpoint-arm";
  bundleIdentity: string;
  effectiveUid: number;
  controllerUnit: string;
  repository: string;
  objective: number;
  activationRequestId: string;
  runId: string;
  policyDigest: string;
  baseSha: string;
  checkpoint: CompilerCheckpointKind;
  eligibilityDurationMs: number;
  holdDurationMs: number;
}
export function compilerCheckpointPath(binding: Record<string, unknown>, uid?: number): string;
export function compilerQualificationObjectiveBody(authority: { namespace: string }): string;
export function assertCompilerQualificationDefaults(
  effectiveDefaults: unknown,
  maxObservedTokens: number,
): CompilerCheckpointPolicy;
export function compilerCheckpointArm(
  authority: CompilerCheckpointAuthority,
  controller: CompilerController,
  artifact: { bundles: Array<{ file: string; sha256: string }> },
  objective: number,
  baseSha: string,
  checkpoint: CompilerCheckpointKind,
): CompilerCheckpointArm;
export function assertCompilerSelectionHold(
  observation: unknown,
  authority: CompilerCheckpointAuthority,
  armRecord: { arm: CompilerCheckpointArm },
  controller: CompilerController,
): boolean;
export function assertGraphProjectionHold(
  observation: unknown,
  authority: CompilerCheckpointAuthority,
  armRecord: { arm: CompilerCheckpointArm },
  controller: CompilerController,
): boolean;
export function runCompilerCheckpointScenario(
  port: unknown,
  authority: CompilerCheckpointAuthority,
): Promise<Record<string, unknown>>;
export function compilerCheckpointExtension(authority: unknown): CheckpointExtension;
export function main(env?: NodeJS.ProcessEnv): Promise<void>;
