export const criticalContractTests: readonly string[];
export const deepScenarioTests: readonly string[];
export const prImpactRules: readonly { path: string; tests: string[] }[];

export type PrCheckSelection = {
  changed: string[];
  biome: string[];
  directTests: string[];
  mappedTests: string[];
  relatedInputs: string[];
  code: boolean;
};

export type PrTestPlan = {
  selectedTests: string[];
  deferredDeepTests: string[];
};

export function parsePrArguments(argv: string[], environment?: NodeJS.ProcessEnv): { base: string };

export function selectPrChecks(paths: string[]): PrCheckSelection;
export function buildPrTestPlan(selection: PrCheckSelection, relatedTests: string[]): PrTestPlan;
export function prWorkerCount(parallelism?: number): number;

export function resolvePrBase(base: string, cwd?: string): Promise<string>;
export function changedFilesSince(base: string, cwd?: string): Promise<string[]>;
export function verifyPullRequest(options?: { argv?: string[]; cwd?: string }): Promise<
  {
    mergeBase: string;
    parallelism?: number;
    workers?: number;
    selectedTests?: string[];
    deferredDeepTests?: string[];
  } & PrCheckSelection
>;
