export const budgetRefusalReason: string;
export function budgetStopPolicy(): Record<string, unknown>;
export function budgetStopAuthority(
  env: Record<string, string | undefined>,
): { repository: string; namespace: string; policy: Record<string, unknown> } | null;
export function assessBudgetStopObservation(input: unknown): {
  observationScope: "observed-pre-projection-budget-refusal";
  runId: string;
  start: Record<string, unknown>;
  compiler: Record<string, unknown>;
  terminal: Record<string, unknown>;
  compilerTokens: number;
  durableGraph: "uninspected";
  originalExerciseResultChanged: false;
};
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
