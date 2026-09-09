const TEST_INTEGRITY = `sha512-${"A".repeat(86)}==`;

export function pnpmBootstrapLock(importers: string[], packages: string[]): string {
  return [
    "lockfileVersion: '9.0'",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "importers:",
    ...importers.map((path) => `  '${path}': {}`),
    ...(packages.length === 0
      ? []
      : [
          "packages:",
          ...packages.flatMap((dependency) => [
            `  '${dependency}':`,
            `    resolution: {integrity: ${TEST_INTEGRITY}}`,
          ]),
          "snapshots:",
          ...packages.map((dependency) => `  '${dependency}': {}`),
        ]),
    "",
  ].join("\n");
}
