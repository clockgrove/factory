export function directorContentionResponseRecord(
  clientInvocationId: string,
  response: unknown,
): {
  clientInvocationId: string;
  response: unknown;
  responseBytes: number;
  responseSha256: string;
};
export function assertInnerDirectorCollision(input: unknown): Record<string, unknown>;
export function assertPhaseKillRecovery(input: unknown): Record<string, unknown>;
export function assertResourceCeilingEvidence(input: unknown): Record<string, unknown>;
export function assertExplainReplayEvidence(input: unknown): Record<string, unknown>;
