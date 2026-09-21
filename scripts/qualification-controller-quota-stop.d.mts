export const QUOTA_STOP_ARM_ENV: string;

export interface QuotaStopArm {
  nodeExecutable: string;
  factoryCli: string;
  repository: string;
  checkout: string;
  artifactIdentity: string;
  unit: string;
  [key: string]: unknown;
}

export interface QuotaStopObservation {
  argv: string[];
  cgroup: string;
  invocationId: string;
}

export interface QuotaStopRequestClassification {
  method: "GET";
  route: "repository";
  operation: "repository-facts-rest-read";
}

export function classifyQuotaStopRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  repository: string,
): QuotaStopRequestClassification;

export function quotaStopTargetMatch(
  arm: QuotaStopArm,
  observation: QuotaStopObservation,
): { argvMatches: boolean; targetMatches: boolean };

export function installQuotaStopFetchInterceptor(
  env?: NodeJS.ProcessEnv,
  observation?: QuotaStopObservation,
): boolean;
