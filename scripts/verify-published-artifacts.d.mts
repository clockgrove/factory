export interface PublishedQualifierInput {
  releaseDirectory: string;
  installRoot: string;
  repository: string;
  checkout: string;
  version?: string;
  output?: string;
  codexCommand?: string;
  lifecycleAck?: string;
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
export function lifecycleTargetBinding(repository: string, checkout: string): string;
export function receiptWithDigest(value: Record<string, unknown>): Record<string, unknown>;
export const defaultPublishedQualifierPort: object;
export function qualifyPublishedArtifacts(
  input: PublishedQualifierInput,
  port?: object,
): Promise<Record<string, unknown>>;
