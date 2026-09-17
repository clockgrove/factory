import { createHash } from "node:crypto";

const prereleaseIdentifier = String.raw`(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const prereleaseVersion = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-${prereleaseIdentifier}(?:\.${prereleaseIdentifier})*(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

export function assertInitialBetaIdentity(packageManifest, packageLock) {
  if (!prereleaseVersion.test(packageManifest?.version ?? ""))
    throw new Error("Initial Beta requires a SemVer prerelease package version");
  if (packageManifest?.publishConfig?.tag !== "beta")
    throw new Error("Initial Beta requires the npm beta dist-tag");
  if (
    packageLock?.name !== packageManifest.name ||
    packageLock?.version !== packageManifest.version ||
    packageLock?.packages?.[""]?.name !== packageManifest.name ||
    packageLock?.packages?.[""]?.version !== packageManifest.version
  )
    throw new Error("package-lock root identity differs from package.json");
}

function assertSynchronizedReleaseVersions(packageManifest, entries) {
  for (const [label, version] of entries) {
    if (version !== packageManifest.version)
      throw new Error(`${label} version differs from package.json`);
  }
}

export function assertSynchronizedReleaseManifests(packageManifest, manifests) {
  const expectedPluginName = packageManifest.name?.split("/").at(-1);
  const marketplacePlugins = manifests.marketplace?.plugins?.filter(
    (entry) => entry.name === expectedPluginName,
  );
  if (
    !expectedPluginName ||
    manifests.plugin?.name !== expectedPluginName ||
    manifests.codex?.name !== expectedPluginName ||
    manifests.claude?.name !== expectedPluginName ||
    marketplacePlugins?.length !== 1
  )
    throw new Error("package and plugin release names differ");
  assertSynchronizedReleaseVersions(packageManifest, [
    ["plugin.json", manifests.plugin.version],
    ["Codex plugin", manifests.codex.version],
    ["Claude plugin", manifests.claude.version],
    ["Copilot marketplace metadata", manifests.marketplace.metadata?.version],
    ["Copilot marketplace plugin", marketplacePlugins[0].version],
  ]);
}

export function assertSbomRootIdentity(sbom, packageManifest, label) {
  const root = sbom?.metadata?.component;
  const encodedName = packageManifest.name.replace(/^@/, "%40");
  if (
    root?.version !== packageManifest.version ||
    root?.["bom-ref"] !== `${packageManifest.name}@${packageManifest.version}` ||
    root?.purl !== `pkg:npm/${encodedName}@${packageManifest.version}`
  )
    throw new Error(`${label} root identity differs from package.json`);
}

export function normalizeSbomRootIdentity(sbom, packageManifest, label) {
  assertSbomRootIdentity(sbom, packageManifest, label);
  sbom.metadata.component.name = packageManifest.name;
}

export function assertNormalizedSbomRootIdentity(sbom, packageManifest, label) {
  assertSbomRootIdentity(sbom, packageManifest, label);
  if (sbom.metadata.component.name !== packageManifest.name)
    throw new Error(`${label} normalized root name differs from package.json`);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertReleaseArtifactBasename(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
  )
    throw new Error("release artifact filename is invalid");
  return value;
}

export function canonicalChecksumBytes(descriptors) {
  const seen = new Set();
  return `${descriptors
    .map((descriptor) => {
      const file = assertReleaseArtifactBasename(descriptor?.file);
      if (!/^[0-9a-f]{64}$/.test(descriptor.sha256 ?? "") || seen.has(file))
        throw new Error("release checksum descriptor is invalid or duplicated");
      seen.add(file);
      return `${descriptor.sha256}  ${file}`;
    })
    .join("\n")}\n`;
}
