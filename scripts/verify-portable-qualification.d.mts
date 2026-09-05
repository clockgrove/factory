export function assessPortableQualification(
  artifacts: Array<{
    artifactKind: string;
    result: string;
    artifact?: unknown;
  }>,
): {
  result: string;
  fullFactoryHostMatrix: string;
  publishedDistribution: string;
  artifactVersionsAndBundlesAgree: boolean;
};
export function runBoundedVerifier(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<boolean>;
export function main(args?: string[]): Promise<void>;
