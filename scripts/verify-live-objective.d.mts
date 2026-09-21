export type QualificationExecutionTrust = "trusted_local" | "managed";
export function objectiveBodyFor(
  namespace: string,
  executionTrust: QualificationExecutionTrust,
): string;
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
export function boundedPolicy(
  delivery?: string,
  maxModelTokens?: number,
  ceiling?: number,
): unknown;
export function qualificationModels(
  model: string | undefined,
  reasoning: string | undefined,
): {
  mode: "single-profile";
  profiles: Record<string, { model: string; reasoning: string }>;
  phaseProfiles: Record<"compile" | "implement" | "review" | "recover", string>;
};
export function assertRecordedQualificationPolicy(recorded: unknown, expected: unknown): void;
export type QualificationMergeAssertion = (
  proof: unknown,
  input: import("./qualification-merge-proof.mjs").MergeProofInput,
) => void;
export function assertCompletion(
  evidence: unknown,
  allowedBackends?: string[],
  assertMergeProof?: QualificationMergeAssertion,
): void;
export function assertQualificationNamespace(evidence: unknown): void;
export function assertQualificationCompletion(
  evidence: unknown,
  deliveryMode?: "stacked-prs" | "regular-prs" | "native-fallback",
  allowedBackends?: string[],
  assertMergeProof?: QualificationMergeAssertion,
): void;
export function assessCompletion(evidence: unknown): {
  result: "passed" | "failed" | "incomplete";
  scope: "installed-local-objective-happy-path";
  reason?: string;
};
export function main(
  qualification?: Record<string, unknown> & { executionTrust?: QualificationExecutionTrust },
  options?: {
    env?: Record<string, string | undefined>;
    candidateSourceRoot?: string;
    installAuthorityOptions?: Record<string, unknown>;
    runtimeEnvironmentOptions?: Record<string, unknown>;
  },
): Promise<void>;
export function verifyQualificationFinalArtifact(input: {
  verifier?: (hooks: Record<string, unknown>) => Promise<void>;
  defaultVerifier: (hooks: Record<string, unknown>) => Promise<void>;
  hooks: Record<string, unknown>;
}): Promise<void>;
export function runQualificationCall<T>(input: {
  invoke: () => Promise<T>;
  duringRun?: (
    hooks: Record<string, unknown> & { run: Promise<T>; signal: AbortSignal },
  ) => Promise<unknown>;
  hooks: Record<string, unknown>;
}): Promise<T>;
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
export function modelTokenLimit(value: string | undefined, ceiling?: number): number;
export function assessQualificationPreflight(input: unknown): {
  result: "passed" | "blocked";
  blockers: string[];
  requiredMinimumRemaining: { core: number; graphql: number };
};
export function applyQualificationScenarioPreflight(
  preflight: { result: "passed" | "blocked"; blockers: string[]; scenario?: unknown },
  scenario: { result: "passed" | "blocked"; blocker?: string; reason?: string },
): { result: "passed" | "blocked"; blockers: string[]; scenario?: unknown };
export function assertMcpSurface(tools: unknown): void;
export function qualificationFailure(evidence: unknown, error: unknown): unknown;
