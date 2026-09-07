export type FailureCase = "failed-validation" | "real-conflict";
export interface FailureFixture {
  protocol: string;
  namespace: string;
  scenario: FailureCase;
  paths: { payload: string; recipe: string; test: string };
  files: Record<string, string>;
  output: string;
  competing: string;
  validationCommand: string;
  recipeCommand: string;
}
export function failureHash(bytes: string | Uint8Array): string;
export function failureBlob(bytes: string | Uint8Array): string;
export function failureFixture(namespace: string, scenario: FailureCase): FailureFixture;
export function failureObjectiveBody(namespace: string, scenario: FailureCase): string;
export function rawFailureGit(
  repository: string,
  args: string[],
  input?: string,
  extraEnv?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string };
export function assertFailureFixture(
  repository: string,
  baseSha: string,
  fixture: FailureFixture,
): { baseSha: string; baseTreeSha: string; fixtureDigest: string };
export interface FailureContentProof {
  baseSha: string;
  baseTreeSha: string;
  fixtureDigest: string;
  artifactDigest: string;
  patchDigest: string;
  path: string;
  workerTree: string;
  baseBlob: string;
  workerBlob: string;
  workerCommit?: string;
  competingBlob?: string;
  competingTree?: string;
  competingCommit?: string;
  conflict?: { exitCode: 1; output: string; outputDigest: string; boundary: string };
}
export function proveFailureContent(input: {
  repository: string;
  baseSha: string;
  artifact: unknown;
  fixture: FailureFixture;
}): FailureContentProof;
export function failureEvents(
  observation: unknown,
  authority: unknown,
): {
  run: Record<string, unknown>[];
  start: Record<string, unknown>;
  reserved: Record<string, unknown>;
  started: Record<string, unknown>;
};
export function assertFailureAccounting(run: Record<string, unknown>[]): {
  modelTokens: number;
  actual: Record<string, unknown>[];
};
export function assertFailedValidation(
  observation: unknown,
  authority: unknown,
  fixture: FailureFixture,
): {
  runId: string;
  workItem: number;
  validation: Record<string, unknown>;
  accounting: { modelTokens: number; actual: Record<string, unknown>[] };
};
export function assertConflictPreserved(
  before: unknown,
  after: unknown,
  authority: unknown,
  cancelled?: boolean,
): { modelTokens: number; actual: Record<string, unknown>[] };
