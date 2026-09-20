export const budgetRefusalReason: string;
export function budgetStopPolicy(model: string, reasoning: string): Record<string, unknown>;
export function budgetStopAuthority(
  env: Record<string, string | undefined>,
): { repository: string; namespace: string; policy: Record<string, unknown> } | null;
export function assessBudgetStopObservation(input: unknown): {
  observationScope: "observed-pre-projection-budget-refusal";
  runId: string;
  start: Record<string, unknown>;
  reservation: Record<string, unknown>;
  compiler: Record<string, unknown>;
  graph: { graphDigest: string; graphSize: number; baseSha: string };
  terminal: Record<string, unknown>;
  compilerTokens: number;
  durableGraph: "uninspected";
  originalExerciseResultChanged: false;
};
export function assertBudgetStopCompletion(evidence: unknown): void;
export function recordBudgetStopSettlement(
  evidence: Record<string, unknown>,
  observeCleanup: (primary: Record<string, unknown>) => Promise<Record<string, unknown>>,
  save?: () => void,
): Promise<{ terminalObservation: Record<string, unknown>; cleanup: Record<string, unknown> }>;
export function createBudgetStopQualification(
  authority: NonNullable<ReturnType<typeof budgetStopAuthority>>,
  env?: Record<string, string | undefined>,
  port?: import("./verify-local-scheduling.mjs").SchedulingPort,
): Record<string, unknown>;
export function main(
  env?: Record<string, string | undefined>,
  run?: (
    qualification: Record<string, unknown>,
    options: { env: Record<string, string | undefined> },
  ) => Promise<void>,
): Promise<void>;
