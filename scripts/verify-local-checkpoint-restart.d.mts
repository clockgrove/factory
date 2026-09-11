export interface CheckpointAuthority {
  repository: string;
  checkout: string;
  unit: string;
  phase: "preflight" | "exercise";
  namespace: string;
  evidence: string;
  policy: Record<string, unknown>;
  sessionRecovery?: true;
}
export function checkpointDeadline(startedAt: string, minutes: number): number;
export function checkpointObjectiveDeadline(
  observation: unknown,
  authority: CheckpointAuthority,
):
  | {
      source: "FactoryRunStarted";
      runId: string;
      policyDigest: string;
      startedAt: string;
      deadline: string;
    }
  | undefined;
export function checkpointPoll<T>(options: {
  phase: string;
  observe(deadline: number): Promise<T>;
  accept(observation: T): boolean | Promise<boolean>;
  deadline(): number;
  bind?(observation: T): unknown;
  read?<R>(stage: string, operation: () => R | Promise<R>): Promise<R>;
  wait?(milliseconds: number): Promise<unknown>;
  now?(): number;
  intervalMs?: number;
}): Promise<T>;
export function checkpointTimeout(deadline: number, maximumMs: number, now?: number): number;
export function checkpointScenarioDeadline(
  evidence: {
    actions: Array<{ action: string; returnedAt?: string }>;
    objectiveDeadline?: { deadline: string };
  },
  observationWindowMinutes: number,
): number | undefined;
export function checkpointBoundedCall<T>(
  operation: (timeoutMs: number) => T,
  deadline: number | undefined,
  maximumMs: number,
  now?: () => number,
): T;
export function checkpointAuthority(
  env: Record<string, string | undefined>,
): CheckpointAuthority | null;
export function checkpointFacts(
  observation: unknown,
  authority: CheckpointAuthority,
  pauseRequestId: string,
  requirePaused?: boolean,
): { runId: string; modelTokens: number; integrated: number; stable: unknown[] };
export function assertCheckpointModelAdmission(
  accounting: {
    markers: Array<{ sequence: number }>;
    usage: Array<{ sequence: number; amount: number }>;
    unresolved: unknown[];
    total: number;
  },
  economics: unknown,
  options?: { requireRemaining?: boolean },
): void;
export function assertScopeCoverage(events: Record<string, unknown>[]): void;
export { readQualificationMergeProof as readCheckpointMergeProof } from "./qualification-merge-proof.mjs";
export function createCheckpointList(
  request: (
    route: string,
    parameters: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<{ data: unknown }>,
  options?: { now?: () => number },
): (
  route: string,
  parameters?: Record<string, unknown>,
  maximumEntries?: number,
  options?: { deadline?: number },
) => Promise<unknown[]>;
export function assertCheckpointExecutable(
  pid: number,
  expectedNode: string,
  readLink?: (path: string) => string,
): void;
export function checkpointStartupObservation(
  observe: (capture: (identity: unknown) => void, remainingMs: () => number) => unknown,
  options: {
    eligible: boolean;
    diagnostic(error: unknown): { boundary: string; code: string };
    record(value: Record<string, unknown>): void;
    wait?(milliseconds: number): Promise<unknown>;
    now?(): number;
  },
): Promise<unknown>;
export function checkpointFailure(
  error: unknown,
  boundary?: string,
): { boundary: string; code: string };
export interface CheckpointObservationDiagnostic {
  boundary: "observation";
  phase: string;
  stage: string;
  failedAt: string;
  category:
    | "http-refusal"
    | "http"
    | "timeout"
    | "aborted"
    | "transport"
    | "mcp"
    | "parse"
    | "assertion"
    | "deadline"
    | "filesystem"
    | "unavailable";
  code: string;
  httpStatus?: number;
  mcpCode?: number;
}
export function checkpointObservationFailure(
  error: unknown,
  context?: { phase?: string; stage?: string; now?: number },
): CheckpointObservationDiagnostic;
export function checkpointObservationRead<T>(
  operation: (remainingMs: number) => T | Promise<T>,
  context: {
    phase: string;
    stage: string;
    deadline: number;
    record(
      diagnostic: CheckpointObservationDiagnostic & { attempt: number; retry: boolean },
      error: unknown,
    ): unknown;
    now?(): number;
    wait?(milliseconds: number): Promise<unknown>;
  },
): Promise<T>;
export function checkpointOperatorFailure(
  tool: string,
  args: Record<string, unknown>,
  response: { isError?: boolean; content?: { type: string; text?: string }[] },
): {
  tool: string;
  requestId: unknown;
  isError: boolean;
  text: string;
  truncated: boolean;
  observedAt: string;
};
export function checkpointStatusSnapshotRetry(
  tool: string,
  args: Record<string, unknown>,
  failure: ReturnType<typeof checkpointOperatorFailure>,
): boolean;
export function checkpointReady(
  observation: unknown,
  authority: CheckpointAuthority,
  pauseRequestId: string,
): boolean;
export function checkpointCompletionReady(
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
  absence(observation: unknown, controllers: unknown[], executionOnly?: boolean): Promise<unknown>;
  armSession?(original: unknown): Promise<unknown>;
  sessionProof?(observation: unknown, witness?: unknown): Promise<unknown[]>;
  checkpoint(value: unknown): Promise<void>;
  takeover(checkpoint: unknown): Promise<void>;
  finalProof(observation: unknown, original: unknown, replacement: unknown): Promise<void>;
}
export function runCheckpointScenario(
  port: CheckpointPort,
  authority: CheckpointAuthority,
): Promise<unknown>;
export function appServerHoldReady(
  observation: unknown,
  authority: CheckpointAuthority,
  arm: unknown,
  pauseRequestId?: string,
): boolean;
export function runAppServerCheckpointScenario(
  port: CheckpointPort,
  authority: CheckpointAuthority,
): Promise<unknown>;
export function continueAppServerCheckpointScenario(
  port: CheckpointPort,
  authority: CheckpointAuthority,
  context: {
    held: unknown;
    original: unknown;
    sessionProofs: unknown[];
    scopes: unknown;
    originalEvents: unknown[];
    restartAction?: "restart" | "start";
  },
): Promise<unknown>;
/** Internal committed adapters only; no operator-supplied module is loaded. */
export interface CheckpointExtension {
  authority?: CheckpointAuthority;
  scope?: string;
  harnessPaths?: string[];
  objectiveBody?(authority: CheckpointAuthority): string;
  preflight?(context: Record<string, unknown>): unknown;
  observe?(context: Record<string, unknown>): unknown;
  extendPort?(context: Record<string, unknown>): unknown;
}
export function main(
  env?: Record<string, string | undefined>,
  runner?: typeof runCheckpointScenario,
  extension?: CheckpointExtension,
): Promise<void>;
