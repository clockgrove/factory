export interface SchedulingPort {
  exec(command: string, args: string[]): string;
  read(path: string): string;
  link(path: string): string;
  now(): string;
  wait(milliseconds: number): Promise<unknown>;
}
export type ServiceIdentity = {
  unit: string;
  node: string;
  bundle: string;
  checkout: string;
  bootDigest?: string;
  invocationId?: string;
  pid?: number;
  startTicks?: string;
};
export type ServiceObservation = Partial<ServiceIdentity> & {
  unit: string;
  state: "active" | "absent";
  bootDigest: string;
  observedAt: string;
  effectiveCpu?: number;
  cgroup?: string;
};
export function schedulingAuthority(env: Record<string, string | undefined>): {
  repository: string;
  namespace: string;
  policy: Record<string, unknown>;
} | null;
export function schedulingUnit(input: {
  repository: string;
  namespace: string;
  inventory: string;
  nonce: string;
  role: "primary" | "contender";
}): string;
export function schedulingTransport(
  input: ServiceIdentity & {
    path: string;
    home: string;
    uid: number;
    username: string;
  },
): { command: string; args: string[]; cwd: string; env: Record<string, string>; stderr: "pipe" };
export function observeSchedulingService(
  expected: ServiceIdentity,
  port?: SchedulingPort,
): ServiceObservation;
export function changeSchedulingService(
  expected: ServiceIdentity,
  operation: "release-cpu" | "stop",
  port?: SchedulingPort,
): Promise<ServiceObservation>;
export function assertSchedulingBarrier(
  input: unknown,
  requireQueued?: boolean,
): {
  runId: string;
  roots: number[];
  policyDigest: string;
} | null;
export function assertNativePriorityReadback(
  before: unknown,
  after: unknown,
  roots: number[],
  promoted: number,
): void;
export function ownedSchedulingScopes(evidence: unknown, primary: unknown): string[];
export function assertSchedulingCompletion(evidence: unknown): void;
export function assertRepositoryContention(input: unknown): void;
export function schedulingRequest<T>(
  hooks: { request: (route: string, parameters: Record<string, unknown>) => Promise<T> },
  route: string,
  parameters?: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T>;
export function createSchedulingQualification(
  authority: NonNullable<ReturnType<typeof schedulingAuthority>>,
  env?: Record<string, string | undefined>,
  port?: SchedulingPort,
): Record<string, unknown>;
export function main(
  env?: Record<string, string | undefined>,
  run?: (qualification: Record<string, unknown>) => Promise<void>,
): Promise<void>;
