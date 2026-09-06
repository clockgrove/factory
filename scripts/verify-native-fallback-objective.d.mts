export function observeNativeFallbackCapability(input: {
  request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>;
  repository: string;
  actor: { id: number; login: string };
}): Promise<Record<string, unknown>>;
export function assertNativeFallbackCapability(
  proof: unknown,
  input: {
    repository: string;
    actor: { id: number; login: string };
  },
): void;
export function nativeFallbackQualification(
  env: Record<string, string | undefined>,
): Record<string, unknown> | null;
export function assertNativeFallbackCompletion(evidence: unknown): void;
export function assessNativeFallbackCompletion(evidence: unknown): {
  result: "passed" | "failed" | "incomplete";
  scope: string;
  reason?: string;
};
export function main(
  env?: Record<string, string | undefined>,
  run?: (qualification: Record<string, unknown>) => Promise<void>,
): Promise<void>;
