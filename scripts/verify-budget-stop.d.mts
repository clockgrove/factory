export function budgetStopPolicy(): Record<string, unknown>;
export function budgetStopAuthority(
  env: Record<string, string | undefined>,
): { repository: string; namespace: string; policy: Record<string, unknown> } | null;
export function assessBudgetStopObservation(input: unknown): {
  runId: string;
  policyDigest: string;
  graphDigest: string;
  compilerUsageId: string;
  compilerTokens: number;
  roots: number[];
} | null;
export function observeBudgetStopThenCancel(input: {
  read: () => Promise<unknown>;
  cancel: (requestId: string) => Promise<unknown>;
  context: unknown;
  cancelRequestId: string;
  assertRunning: () => void;
  saveObservation: (value: unknown) => void;
  saveCancelRequested: (value: unknown) => void;
  wait?: (milliseconds: number) => Promise<unknown>;
  now?: () => string;
}): Promise<unknown>;
export function assertBudgetStopCompletion(evidence: unknown): void;
export function createBudgetStopQualification(
  authority: NonNullable<ReturnType<typeof budgetStopAuthority>>,
  env?: Record<string, string | undefined>,
  port?: import("./verify-local-scheduling.mjs").SchedulingPort,
): Record<string, unknown>;
export function main(
  env?: Record<string, string | undefined>,
  run?: (qualification: Record<string, unknown>) => Promise<void>,
): Promise<void>;
