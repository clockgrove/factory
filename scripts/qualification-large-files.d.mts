export const LARGE_FILE_RECIPE_VERSION: "factory-large-files-fixture-v2";
export const LARGE_FILE_VALIDATION_SCRIPT: "test:large-file-fixture";
export const LARGE_FILE_VALIDATION_COMMAND: "npm run test:large-file-fixture";
export const LARGE_FILE_AUDIO_BYTES: number;
export type LargeFilePhase = "payload" | "metadata" | "join";
export type LargeFileOutputScenario = "accepted" | "scope" | "secret" | "symlink";
export type LargeFileRefusalScenario =
  | Exclude<LargeFileOutputScenario, "accepted">
  | "lfs-tool-missing"
  | "lfs-object-missing"
  | "lfs-object-corrupt";
export interface LargeFilePaths {
  prefix: string;
  attributes: string;
  recipe: string;
  test: string;
  canonical: string;
  legacy: string;
  payload: string;
  executable: string;
  metadata: string;
  result: string;
}
export interface LargeFileExpected {
  path: string;
  mode: "100644" | "100755";
  bytes: number;
  digest: string;
}
export interface LargeFileFixture {
  version: typeof LARGE_FILE_RECIPE_VERSION;
  id: string;
  namespace: string;
  root: string;
  repository: string;
  baseSha: string;
  baseTreeSha: string;
  sourceBaseSha?: string;
  sourceTreeSha?: string;
  validation?: {
    command: typeof LARGE_FILE_VALIDATION_COMMAND;
    script: typeof LARGE_FILE_VALIDATION_SCRIPT;
    recipe: string;
    packagePath: "package.json";
    sourcePackageDigest: string;
    packageDigest: string;
  };
  paths: LargeFilePaths;
  recipePath: string;
  baseline: LargeFileExpected[];
  lfs: Array<{
    path: string;
    oid: string;
    size: number;
    pointerDigest: string;
    pointerBlobOid: string;
    mode: "100644";
    objectPath: string;
  }>;
  expected: Array<
    LargeFileExpected & {
      phase: LargeFilePhase;
      mediaType: "audio/wav" | "unknown";
      generated: boolean;
    }
  >;
}
export interface LargeFileTreeObservation {
  baseSha: string;
  baseTreeSha: string;
  treeSha: string;
  provenance: "independent-local-raw-git-object-read";
  files: Array<LargeFileExpected & { gitBlobOid: string; mediaType: string; generated: boolean }>;
  patchProof?: { bytes: number; digest: string; appliedTreeSha: string };
}
export function largeFilePaths(namespace: string): LargeFilePaths;
export function largeFileValidationRecipe(namespace: string): string;
export function renderLargeFileRecipe(template: string, namespace: string): string;
export function largeFileObjectiveBody(namespace: string): string;
export function createLargeFileFixture(input: {
  parent: string;
  namespace: string;
  sourceRepository?: string;
  baseSha?: string;
}): LargeFileFixture;
/** Offline fixture generation only: never a replacement for an installed worker. */
export function writeLargeFileOutput(input: {
  fixture: LargeFileFixture;
  checkout?: string;
  scenario?: LargeFileOutputScenario;
  phase?: LargeFilePhase;
}): void;
export function largeFileScenario(id: LargeFileRefusalScenario): {
  id: LargeFileRefusalScenario;
  stage: "source-preflight" | "collection" | "filesystem-materialization";
  reason: RegExp;
  remoteWritesAllowed: boolean;
};
export function assertLargeFileRefusal(observation: {
  scenario: LargeFileRefusalScenario;
  outcome: "refused" | "accepted";
  stage: "source-preflight" | "collection" | "filesystem-materialization";
  reason: string;
  contentUploads?: number;
  contentUploadEvidence?: "instrumented-content-write-count";
  artifactPublished: boolean;
  modelCalls?: number;
}): {
  scenario: LargeFileRefusalScenario;
  boundary: string;
  refused: true;
  uploadAbsence: "observed-zero" | "unavailable" | "not-absent";
};
export function observeLargeFileTree(input: {
  repository: string;
  treeish: string;
  fixture: LargeFileFixture;
  baseSha?: string;
  patch?: Uint8Array;
}): LargeFileTreeObservation;
export function assertLargeFileFinalTree(input: {
  fixture: LargeFileFixture;
  observation: LargeFileTreeObservation;
}): { treeSha: string; files: LargeFileTreeObservation["files"]; lfsPointersPreserved: true };
export function assertLargeFileArtifact(input: {
  fixture: LargeFileFixture;
  artifact: unknown;
  observation: LargeFileTreeObservation;
  patch: Uint8Array;
  phase: LargeFilePhase;
}): {
  phase: LargeFilePhase;
  artifactDigest: string;
  resultTreeSha: string;
  patchBytes: number;
  patchSha256: string;
  oversized: boolean;
};
