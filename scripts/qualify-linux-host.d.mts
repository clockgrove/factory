export function classifyLinuxHost(input: {
  platform: string;
  kernel: string;
  virtualization?: string;
  claimed?: string;
}): {
  platform: string;
  detected: string;
  claimed: string;
  claimVerified: boolean;
  reason: string | null;
};
export function qualificationEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function installedPluginRoot(listed: unknown, codexHome: string, version: string): string;
export function ownedCgroupPath(unit: string, state: { Id: string; ControlGroup: string }): string;
export function assertOwnedServiceCleanup(unit: string, state: unknown, cgroupEvents: string): void;
export function installedArtifactIdentity(
  root: string,
  forbiddenRoot?: string,
): Promise<{
  version: string;
  bundles: Array<{ file: string; bytes: number; sha256: string }>;
}>;
export function summarizeQualification(evidence: {
  host: { detected: string; claimVerified: boolean };
  checks: Record<string, { result: string }>;
}): { result: string; fullFactoryHostMatrix: string; unverified: string[] };
