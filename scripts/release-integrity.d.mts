export interface ReleaseArtifactDescriptor {
  file: string;
  sha256: string;
}

export function canonicalChecksumBytes(descriptors: readonly ReleaseArtifactDescriptor[]): string;
export function sha256(value: string | Uint8Array): string;
export function assertSynchronizedReleaseManifests(
  packageManifest: object,
  manifests: object,
): void;
