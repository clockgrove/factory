export const objectiveBody: string;
export function objectiveBodyFor(namespace: string): string;
export function qualificationNamespace(value?: string, generate?: () => string): string;
export function qualificationPaths(namespace: string): {
  sourceDirectory: string;
  testDirectory: string;
  files: string[];
};
export function qualificationNamespaceMarker(namespace: string): string;
export function waitForCreatedObjectiveNamespace(input: {
  list: (route: string, parameters: { state: string }, maximumEntries: number) => Promise<unknown>;
  namespace: string;
  createdIssue: { number: number; id: number; body: string; pull_request?: unknown };
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<void>;
export function boundedPolicy(delivery?: string, maxModelTokens?: number): unknown;
export function assertCompletion(evidence: unknown, allowedBackends?: string[]): void;
export function assertQualificationNamespace(evidence: unknown): void;
export function assertQualificationCompletion(
  evidence: unknown,
  deliveryMode?: "stacked-prs" | "regular-prs",
): void;
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
