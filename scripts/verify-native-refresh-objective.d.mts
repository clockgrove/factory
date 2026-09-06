export function nativeRefreshQualification(
  env: Record<string, string | undefined>,
): Record<string, unknown> | null;
export function assertNativeRefreshCompletion(evidence: unknown): void;
export function assessNativeRefreshCompletion(evidence: unknown): {
  result: "passed" | "failed" | "incomplete";
  scope: string;
  reason?: string;
};
export function main(
  env?: Record<string, string | undefined>,
  run?: (qualification: Record<string, unknown>) => Promise<void>,
): Promise<void>;
