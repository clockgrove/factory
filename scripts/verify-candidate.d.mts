export const candidateCommands: readonly (readonly [string, readonly string[]])[];
export function verifyCandidate(options?: {
  argv?: string[];
  cwd?: string;
}): Promise<Record<string, unknown>>;
