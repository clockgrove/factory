export function completeSiblingQualificationFixture(options: {
  policy: unknown;
  repository: string;
  backend?: string;
}): Promise<{
  evidence: unknown;
  commits: Map<string, { oid: string; treeOid: string; parentOids: string[] }>;
}>;
