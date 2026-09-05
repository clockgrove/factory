export function faultPolicy(tokens: number, scenario?: "cancel" | "restart"): unknown;
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
export function main(): Promise<void>;
