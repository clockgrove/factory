export const objectiveBody: string;
export function boundedPolicy(delivery?: string): unknown;
export function assertCompletion(evidence: unknown, allowedBackends?: string[]): void;
export function assessCompletion(evidence: unknown): {
  result: "passed" | "failed" | "incomplete";
  scope: "installed-local-objective-happy-path";
  reason?: string;
};
export function main(qualification?: Record<string, unknown>): Promise<void>;
export function installedIdentity(input: unknown): {
  version: string;
  codexManifestVersion: string;
  pluginId: string;
};
export function assertMcpSurface(tools: unknown): void;
export function assertRetryableObjective(input: unknown): void;
