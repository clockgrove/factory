import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = resolve(root, "release");
const dryRun = process.argv.includes("--dry-run");
// Keep this guard here as well as in the npm script: direct invocation must not bypass gates.
execFileSync(process.execPath, [resolve(root, "scripts/verify-publish-readiness.mjs")], {
  cwd: root,
  stdio: "inherit",
});
const manifest = JSON.parse(
  await readFile(resolve(releaseDirectory, "release-manifest.json"), "utf8"),
);
const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

if (
  manifest.name !== packageManifest.name ||
  manifest.version !== packageManifest.version ||
  manifest.distTag !== packageManifest.publishConfig?.tag
) {
  throw new Error("release manifest does not match package.json");
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verifyArtifact = async (descriptor) => {
  if (
    typeof descriptor?.file !== "string" ||
    !descriptor.file ||
    basename(descriptor.file) !== descriptor.file ||
    !/^[0-9a-f]{64}$/.test(descriptor.sha256 ?? "")
  ) {
    throw new Error("release manifest contains an invalid artifact descriptor");
  }
  const path = resolve(releaseDirectory, descriptor.file);
  if (hash(await readFile(path)) !== descriptor.sha256) {
    throw new Error(
      `release artifact ${descriptor.file} does not match its verified SHA-256 digest`,
    );
  }
  return path;
};
const tarball = await verifyArtifact(manifest.tarball);
await verifyArtifact(manifest.sbom);
const provenancePath = await verifyArtifact(manifest.provenance);
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (
  manifest.provenance.sourceDirty !== false ||
  manifest.provenance.sourceCommit !== commit ||
  provenance.protocol !== "clockgrove.factory/release-provenance-v1" ||
  provenance.source?.commit !== commit ||
  provenance.source?.dirty !== false ||
  provenance.package?.name !== manifest.name ||
  provenance.package?.version !== manifest.version ||
  provenance.package?.distTag !== manifest.distTag
) {
  throw new Error("release artifacts were not generated from the current clean release commit");
}
for (const descriptor of [
  manifest.tarball,
  manifest.sbom,
  manifest.bundleInventory,
  manifest.thirdPartyNotices,
]) {
  const matches = provenance.subjects?.filter(
    (subject) => subject.file === descriptor?.file && subject.sha256 === descriptor?.sha256,
  );
  if (matches?.length !== 1)
    throw new Error("release provenance does not bind every manifest subject");
}
for (const [descriptor, expectedPath] of [
  [manifest.bundleInventory, "dist/bundle-inventory.json"],
  [manifest.thirdPartyNotices, "THIRD_PARTY_NOTICES.txt"],
]) {
  if (
    descriptor?.file !== expectedPath ||
    hash(await readFile(resolve(root, expectedPath))) !== descriptor.sha256
  ) {
    throw new Error(`release subject ${expectedPath} differs from the current source`);
  }
}

const publishArguments = [
  "publish",
  tarball,
  "--access",
  packageManifest.publishConfig.access,
  "--tag",
  manifest.distTag,
];
if (dryRun) publishArguments.push("--dry-run");

const result = spawnSync("npm", publishArguments, {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
