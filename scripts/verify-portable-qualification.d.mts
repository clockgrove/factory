export function assessPortableQualification(
  artifacts: Array<{
    artifactKind: string;
    result: string;
    artifact?: unknown;
  }>,
): {
  result: string;
  fullFactoryHostMatrix: string;
  publishedDistribution: string;
  artifactVersionsAndBundlesAgree: boolean;
};
export function main(args?: string[]): Promise<void>;
