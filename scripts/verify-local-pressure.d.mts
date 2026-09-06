export function pressureAuthority(env: Record<string, string | undefined>): {
  repository: string;
  namespace: string;
  policy: Record<string, unknown>;
} | null;
export function assertPressureRun(
  observation: unknown,
  authority: unknown,
  objective: number,
  expectedRun?: string,
): Record<string, unknown>;
export function assertPressureReadmission(
  events: unknown,
  proof: unknown,
  policy: unknown,
): Record<string, unknown>;
export function assertPressureCompletion(evidence: unknown): void;
export function pressureReadmissionDeadline(releasedAt: string, cooldownSeconds: number): number;
export function createPressureQualification(
  authority: unknown,
  env?: Record<string, string | undefined>,
  port?: unknown,
): Record<string, unknown>;
export function main(
  env?: Record<string, string | undefined>,
  run?: (qualification: Record<string, unknown>) => Promise<void>,
): Promise<void>;
