export type NativeLinearCase = "cascade" | "response-loss-restart" | "active-cancellation";

export function nativeLinearObjectiveBody(namespace: string): string;
export function nativeLinearQualification(
  env: Record<string, string | undefined>,
): Record<string, unknown> | null;
export function executeNativeLinearControllerCase(input: Record<string, unknown>): Promise<unknown>;
export function assertNativeLinearControllerAuthority(
  controller: Record<string, unknown>,
  evidence: Record<string, unknown>,
  checkout: string,
  port?: Record<string, unknown>,
): Record<string, unknown>;
export function observeNativeLinearProofs(
  input: Record<string, unknown>,
  read?: (demand: Record<string, unknown>) => Promise<Record<string, unknown>>,
  readMerge?: (expected: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<unknown[]>;
export function assertNativeLinearHistory(events: unknown[]): unknown[];
export function assertNativeIntegrationOperation(events: unknown[], groups?: unknown[]): string;
export function assertNativeLinearFinalTree(
  events: unknown[],
  finalTreeSha: string,
): Record<string, unknown>;
export function assertNoOpenLiabilities(events: unknown[]): Record<string, unknown>;
export function assertNativeLinearPublicationProofs(
  evidence: unknown,
  events: unknown[],
  groups?: unknown[],
): void;
export function assertNativeLinearCandidate(
  proof: Record<string, unknown>,
  events: unknown[],
): void;
export function assertNativeLinearReview(
  review: Record<string, unknown>,
  publication: Record<string, unknown>,
  validation: Record<string, unknown>,
  published: Record<string, unknown>,
  events: unknown[],
  publicationIndex?: number,
): string;
export function assertNativeLinearTerminal(events: unknown[], expectedState: string): unknown;
export function assertNativeControllerTakeover(
  events: unknown[],
  trigger: Record<string, unknown>,
  expectedGeneration: Record<string, unknown>,
): Record<string, unknown>;
export function assertNativeCancellationBoundary(
  evidence: unknown,
  events: unknown[],
  groups?: unknown[],
): Record<string, unknown>;
export function startNativeLinearSentinel(port?: Record<string, unknown>): Record<string, unknown>;
export function assertNativeLinearSentinelAlive(
  started: Record<string, unknown>,
  port?: Record<string, unknown>,
): Record<string, unknown>;
export function stopNativeLinearSentinel(
  started: Record<string, unknown>,
  port?: Record<string, unknown>,
): Record<string, unknown>;
export function assertNativeLinearLifecycle(evidence: unknown, caseName?: NativeLinearCase): void;
export function assessNativeLinearLifecycle(evidence: unknown): {
  result: "passed" | "failed" | "incomplete";
  scope: string;
  reason?: string;
};
export function main(
  env?: Record<string, string | undefined>,
  run?: (
    qualification: Record<string, unknown>,
    options: { env: Record<string, string | undefined> },
  ) => Promise<void>,
): Promise<void>;
