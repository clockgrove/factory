import type { CheckpointAuthority, CheckpointExtension } from "./verify-local-checkpoint-restart.mjs";
export interface ConcurrencyAuthority extends CheckpointAuthority {
  namespaces: string[];
  aggregateObservedThreshold: number;
  controllerLocalCeiling: number;
  authorizedScenarioWorkerMaximum: number;
}
export function concurrencyAuthority(env: Record<string, string | undefined>): ConcurrencyAuthority | null;
export function concurrencyObjectiveBody(namespace: string, index: number): string;
export function concurrencyRefill(pair: unknown[]): Record<string, unknown> | null;
export function assertConcurrencySettlement(observation: unknown, authority: CheckpointAuthority, options?: {paused?: boolean}): {runId: string; modelTokens: number; reservations: number};
export function assertInnerTakeover(before: unknown, after: unknown, chain: unknown[], start: unknown): Record<string, unknown>;
export interface ConcurrencyPort {
  preflight(): Promise<unknown>;
  prepare(stage: string): Promise<unknown>;
  stagger(original: unknown): Promise<unknown>;
  action(action: string): Promise<unknown>;
  controller(state: string, prior?: unknown): Promise<unknown>;
  contend(pair: unknown[]): Promise<unknown>;
  pollPair(phase: string, accept: (pair: unknown[]) => boolean): Promise<unknown[]>;
  scoped(action: string): Promise<unknown>;
  settled(observation: unknown, paused: boolean, index?: number): boolean;
  captureCheckpoint(pair: unknown[], original: unknown): Promise<unknown>;
  innerContend(original: unknown): Promise<unknown>;
  takeover(checkpoint: unknown): Promise<unknown>;
  finish(pair: unknown[], original: unknown, replacement: unknown, refill: unknown): Promise<unknown>;
}
export function runConcurrencyScenario(port: ConcurrencyPort, authority: ConcurrencyAuthority): Promise<Record<string, unknown>>;
export function verifyConcurrencyArtifacts(request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>, authority: ConcurrencyAuthority, branch: string, evidence: unknown[]): Promise<unknown>;
export function main(env?: Record<string, string | undefined>, run?: (env: Record<string, string | undefined>, runner: typeof runConcurrencyScenario, extension: CheckpointExtension) => Promise<void>): Promise<void>;
export function assertRetiredController(fields: Record<string, string>, original: { unit: string; invocationId: string; pid: number }, configPath: string): void;
