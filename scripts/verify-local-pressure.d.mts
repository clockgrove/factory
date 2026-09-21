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
export function pressureQualificationFailure(
  error: unknown,
  stage: string,
): Record<string, unknown>;
export function observePressureBaseline(
  sample: (index: number) => Promise<{ memoryCurrent: number }>,
  record: (sample: { memoryCurrent: number }) => Promise<unknown>,
  wait: (milliseconds: number) => Promise<unknown>,
): Promise<{ memoryCurrent: number }>;
export function createPressureQualification(
  authority: unknown,
  env?: Record<string, string | undefined>,
  port?: unknown,
): Record<string, unknown>;
export function main(
  env?: Record<string, string | undefined>,
  run?: (
    qualification: Record<string, unknown>,
    context: { env: Record<string, string | undefined> },
  ) => Promise<void>,
): Promise<void>;
