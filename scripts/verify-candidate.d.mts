export const candidateCommands: readonly (readonly [string, readonly string[]])[];
export function verifyCandidate(options?: {
  argv?: string[];
  cwd?: string;
  runCommand?: (command: string, args: readonly string[], cwd: string) => Promise<void>;
}): Promise<Record<string, unknown>>;
