export interface CheckpointAuthority {
  repository: string;
  checkout: string;
  unit: string;
  phase: "preflight" | "exercise";
  namespace: string;
  evidence: string;
  policy: Record<string, unknown>;
}
export function checkpointAuthority(
  env: Record<string, string | undefined>,
): CheckpointAuthority | null;
export function checkpointFacts(
  observation: unknown,
  authority: CheckpointAuthority,
  pauseRequestId: string,
  requirePaused?: boolean,
): { runId: string; modelTokens: number; integrated: number; stable: unknown[] };
export function assertScopeCoverage(events: Record<string, unknown>[]): void;
export function assertCheckpointExecutable(
  pid: number,
  expectedNode: string,
  readLink?: (path: string) => string,
): void;
export function checkpointFailure(
  error: unknown,
  boundary?: string,
): { boundary: string; code: string };
export function checkpointReady(
  observation: unknown,
  authority: CheckpointAuthority,
  pauseRequestId: string,
): boolean;
export function checkpointLease(commit: unknown, oid: string): Record<string, unknown>;
export function assertControllerUnit(
  body: string,
  expected: { repository: string; checkout: string; node: string; bundle: string },
): string;
export interface CheckpointPort {
  pauseRequestId: string;
  preflight(): Promise<unknown>;
  action(action: string): Promise<unknown>;
  controller(state: string, prior?: unknown): Promise<unknown>;
  observe(): Promise<unknown>;
  poll(phase: string, accept: (observation: unknown) => boolean): Promise<unknown>;
  absence(observation: unknown, controllers: unknown[]): Promise<unknown>;
  checkpoint(value: unknown): Promise<void>;
  takeover(checkpoint: unknown): Promise<void>;
  finalProof(observation: unknown, original: unknown, replacement: unknown): Promise<void>;
}
export function runCheckpointScenario(
  port: CheckpointPort,
  authority: CheckpointAuthority,
): Promise<unknown>;
export function main(
  env?: Record<string, string | undefined>,
  runner?: typeof runCheckpointScenario,
): Promise<void>;
