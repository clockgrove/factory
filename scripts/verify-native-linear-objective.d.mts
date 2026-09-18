export type NativeLinearCase = "cascade" | "response-loss-restart" | "active-cancellation";

export function nativeLinearObjectiveBody(namespace: string): string;
export function nativeLinearQualification(
  env: Record<string, string | undefined>,
): Record<string, unknown> | null;
export function executeNativeLinearControllerCase(input: Record<string, unknown>): Promise<unknown>;
export function observeNativeLinearProofs(input: Record<string, unknown>): Promise<unknown[]>;
export function assertNativeLinearHistory(events: unknown[]): unknown[];
export function assertNativeIntegrationOperation(events: unknown[], groups?: unknown[]): string;
export function assertNativeLinearLifecycle(evidence: unknown, caseName?: NativeLinearCase): void;
export function assessNativeLinearLifecycle(evidence: unknown): {
  result: "passed" | "failed" | "incomplete";
  scope: string;
  reason?: string;
};
export function main(
  env?: Record<string, string | undefined>,
  run?: (qualification: Record<string, unknown>) => Promise<void>,
): Promise<void>;
