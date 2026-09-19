export function regularQualification(
  env: Record<string, string | undefined>,
): Record<string, unknown> | null;
export function observeRegularLocalScopeCapability(
  input: {
    factoryCli: string;
    checkout: string;
    environment?: NodeJS.ProcessEnv;
  },
  observe?: (input: {
    factoryCli: string;
    checkout: string;
    environment?: NodeJS.ProcessEnv;
  }) => unknown,
): Promise<unknown>;
export function enterRegularQualification(
  input: {
    evidence: Record<string, unknown>;
    save: () => void;
    factoryCli: string;
    checkout: string;
    environment?: NodeJS.ProcessEnv;
    profile: string;
  },
  observe?: (input: {
    factoryCli: string;
    checkout: string;
    environment?: NodeJS.ProcessEnv;
  }) => unknown,
): Promise<void>;
export function assertRegularCompletion(evidence: unknown): void;
export function assertRegularPipelineCompletion(
  evidence: unknown,
  options: {
    expected: unknown;
    scope: string;
    deliveryMode: "regular-prs" | "native-fallback";
  },
): void;
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
  run?: (
    qualification: Record<string, unknown>,
    options: { env: Record<string, string | undefined> },
  ) => Promise<void>,
): Promise<void>;
