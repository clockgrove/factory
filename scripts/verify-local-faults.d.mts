export function faultPolicy(tokens: number, scenario?: "cancel" | "restart"): unknown;
export function assertFaultAuthenticationEnvironment(env: Record<string, string | undefined>): void;
export function faultRequest<T>(
  request: (route: string, parameters: Record<string, unknown>) => Promise<T>,
  route: string,
  parameters?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T>;
export function faultTerminalReady(evidence: unknown): boolean;
export function faultResourceUnits(evidence: unknown): string[];
export function createFaultProgress(options?: {
  now?: () => number;
  emit?: (event: { protocol: string; phase: string; stage: string; elapsedMs: number }) => void;
}): {
  phase(value: string): void;
  stage(stage: string): void;
  failure(): { phase: string; stage: string; code: string; reason: string; elapsedMs: number };
};
export function faultObjective(namespace: string): string;
export function isQuiescentFaultObjective(
  status: unknown,
  repository: string,
  objective: number,
): boolean;
export function privateEvidenceFile(path: string, value?: unknown): unknown;
export function reservePrivateEvidenceFile(path: string): void;
export function scopeUnit(identity: unknown): string;
export function parseUnitObservation(
  unit: string,
  output: string,
  at?: string,
): {
  unit: string;
  status: "active" | "absent" | "unknown";
  at: string;
  invocationId: string | null;
  controlGroupDigest: string | null;
};
export function authenticatedFaultEvents(
  comments: unknown[],
  actor: { id: number; login: string },
  objective: number,
): Array<{ event: Record<string, unknown>; commentId: number; actorId: number }>;
export function assessLocalFault(evidence: unknown): {
  result: "passed" | "incomplete";
  scope: string;
  blockers: string[];
  limitations: string[];
};
export function boundedPoll<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options?: {
    milliseconds?: number;
    interval?: number;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  },
): Promise<T>;
export const localFaultHarnessPaths: string[];
export function installedLocalFaultAuthority(
  env: Record<string, string | undefined>,
  options?: {
    candidateSourceRoot?: string;
    installAuthorityOptions?: Record<string, unknown>;
  },
): unknown;
export function assertFaultControllerAuthority(
  controller: Record<string, unknown>,
  expected: {
    artifactIdentity: string;
    launcher: string;
    bundle: string;
    repository: string;
    checkout: string;
    runningArgv: string[];
  },
): void;
export function assertInstalledFaultControllerAuthority(
  controller: Record<string, unknown>,
  authority: {
    artifactIdentity: string;
    installReceiptIdentity: string;
    factoryBundleSurfaces: Array<{
      surface: "npm" | "plugin-cache";
      path: string;
      sha256: string;
      installReceiptIdentity: string;
    }>;
    repository: string;
    checkout: string;
  },
  port?: {
    pid(unit: string): number;
    argv(pid: number): string[];
    bundle(path: string): { path: string; sha256: string };
  },
): {
  pid: number;
  artifactIdentity: string;
  launcher: string;
  bundle: string;
  repository: string;
  checkout: string;
  runningArgv: string[];
  installSurface: "npm" | "plugin-cache";
  authenticatedDigest: string;
  expectedReceiptIdentity: string;
};
export function runQualification(
  progress: {
    phase(value: string): void;
    stage(stage: string): void;
    failure(): unknown;
  },
  env?: Record<string, string | undefined>,
  options?: {
    candidateSourceRoot?: string;
    installAuthorityOptions?: Record<string, unknown>;
  },
): Promise<void>;
export function main(
  env?: Record<string, string | undefined>,
  options?: {
    candidateSourceRoot?: string;
    installAuthorityOptions?: Record<string, unknown>;
  },
): Promise<void>;
