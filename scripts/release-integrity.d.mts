export interface ReleaseArtifactDescriptor {
  file: string;
  sha256: string;
}

export function canonicalChecksumBytes(descriptors: readonly ReleaseArtifactDescriptor[]): string;
