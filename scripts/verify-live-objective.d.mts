export const objectiveBody: string;
export function boundedPolicy(delivery?: string, maxModelTokens?: number): unknown;
export function assertCompletion(evidence: unknown, allowedBackends?: string[]): void;
export function assertQualificationCompletion(evidence: unknown): void;
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
export function installedPluginPath(input: unknown): string;
export function installedBundleIdentity(input: string): {
  version: string;
  inventorySha256: string;
  bundles: Array<{ file: string; bytes: number; sha256: string }>;
};
export function modelTokenLimit(value: string | undefined): number;
export function assessQualificationPreflight(input: unknown): {
  result: "passed" | "blocked";
  blockers: string[];
  requiredMinimumRemaining: { core: number; graphql: number };
};
export function assertMcpSurface(tools: unknown): void;
export function assertRetryableObjective(input: unknown): void;
