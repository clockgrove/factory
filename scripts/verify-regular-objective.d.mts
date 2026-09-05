export function regularQualification(
  env: Record<string, string | undefined>,
): Record<string, unknown> | null;
export function assertRegularCompletion(evidence: unknown): void;
export function assessRegularCompletion(evidence: unknown): {
  result: "passed" | "failed" | "incomplete";
  scope: string;
  reason?: string;
};
export function observeRegularCommits(input: {
  evidence: unknown;
  request: (route: string, parameters: Record<string, string>) => Promise<unknown>;
}): Promise<void>;
export function main(
  env?: Record<string, string | undefined>,
  run?: (qualification: Record<string, unknown>) => Promise<void>,
): Promise<void>;
