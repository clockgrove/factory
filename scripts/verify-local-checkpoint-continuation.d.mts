export function readContinuationInput(path: string, digest: string, maximum?: number): unknown;
export function continuationEvidencePath(original: unknown, originalPath: string, outputPath: string): string;
export function assertContinuationSeed(original: unknown, witness: unknown, pause: unknown, installed: unknown, now?: number): {
  controller: Record<string, unknown>; deadline: number; runId: string; pauseRequestId: string;
};
export function assertContinuationObservation(observation: unknown, original: unknown, witness: unknown, pause: unknown, now?: number): {
  controller: Record<string, unknown>; deadline: number; runId: string; pauseRequestId: string; modelTokens: number;
};
export function assertStoppedContinuationController(fields: unknown, original: unknown, configDigest: string, absent: boolean): unknown;
export function runCheckpointContinuation(port: unknown, authority: unknown, input: unknown): Promise<unknown>;
export function main(env?: Record<string, string | undefined>): Promise<void>;
