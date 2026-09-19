export const criticalContractTests: readonly string[];

export function parsePrArguments(argv: string[], environment?: NodeJS.ProcessEnv): { base: string };

export function selectPrChecks(paths: string[]): {
  changed: string[];
  biome: string[];
  affected: string[];
  code: boolean;
};

export function resolvePrBase(base: string, cwd?: string): Promise<string>;
export function changedFilesSince(base: string, cwd?: string): Promise<string[]>;
export function verifyPullRequest(options?: { argv?: string[]; cwd?: string }): Promise<{
  mergeBase: string;
  changed: string[];
  biome: string[];
  affected: string[];
  code: boolean;
}>;
