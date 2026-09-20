export interface SettledQualificationEvidence {
  events: Array<Record<string, unknown>>;
  terminal: Record<string, unknown>;
  model: Record<string, unknown>;
  counters: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}
export function settledQualificationEvidence(
  events: Array<Record<string, unknown>>,
  expected: { runId: string; terminalEvent: string },
): SettledQualificationEvidence;
export function assertSettledAttemptRefusal(
  settled: SettledQualificationEvidence,
  expected: { baseSha: string; reason: string; backend?: string },
): Record<string, unknown>;
