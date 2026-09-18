export interface PublishedQualifierInput {
  releaseDirectory: string;
  installRoot: string;
  version?: string;
  npmCommand?: string;
  codexCommand?: string;
  gitCommand?: string;
  preflightOnly?: boolean;
}

export interface RetainedRelease {
  directory: string;
  manifest: {
    name: string;
    version: string;
    distTag: string;
    tarball: {
      file: string;
      integrity: string;
      npmShasum: string;
      packedBytes: number;
      unpackedBytes: number;
      sha256: string;
    };
    sbom: { file: string; sha256: string };
    bundleInventory: { file: string; sha256: string };
    provenance: { file: string; sha256: string; sourceCommit: string; sourceDirty: false };
    checksums: { file: string; sha256: string };
  };
  repository: string;
  releaseManifestSha256: string;
  tag: string;
}

export interface PublishedTag {
  name: string;
  object: string;
  commit: string;
  url: string;
}

export function assertLinuxNativePath(path: string, label: string): string;
export function assertContainedPath(root: string, path: string, label: string): void;
export function verifyRetainedRelease(releaseDirectory: string): RetainedRelease;
export function assessPublishedPreflight(
  release: RetainedRelease,
  npmDocument: object,
  tag: PublishedTag,
): Record<string, unknown>;
export function verifyPublishedTarball(
  tarball: Uint8Array,
  manifest: RetainedRelease["manifest"],
): void;
export function strictPublishedEnvironment(
  root: string,
  tools: { git: string; npm: string; codex: string },
): NodeJS.ProcessEnv;
export function qualificationInstallReceipt(fields: Record<string, string>): string;
export const defaultPublishedQualifierPort: {
  sourcePreflight(
    release: { directory: string; manifest: { provenance: { sourceCommit: string } } },
    tools: Record<string, string>,
  ): Promise<unknown> | unknown;
  consumeInstallAuthority(input: Record<string, unknown>): Promise<unknown> | unknown;
  [key: string]: unknown;
};
export function qualifyPublishedArtifacts(
  input: PublishedQualifierInput,
  port?: object,
): Promise<Record<string, unknown>>;
