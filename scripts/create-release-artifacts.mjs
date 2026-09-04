import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(process.argv[2] ?? resolve(root, "release"));
const npmCache = process.env.FACTORY_NPM_CACHE ?? resolve(tmpdir(), "factory-npm-cache");

function runNpm(args) {
  const result = spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const initialCommit = runGit(["rev-parse", "HEAD"]);
const initiallyDirty = runGit(["status", "--porcelain"]).length > 0;
await mkdir(outputDirectory, { recursive: true });

const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", outputDirectory]))[0];
if (!packed?.filename) throw new Error("npm pack did not return an artifact");
const tarballPath = resolve(outputDirectory, packed.filename);
const tarballHash = hash(await readFile(tarballPath));

const inventoryPath = resolve(root, "dist", "bundle-inventory.json");
const inventoryBytes = await readFile(inventoryPath);
const inventory = JSON.parse(inventoryBytes.toString("utf8"));
if (inventory.protocol !== "clockgrove.factory/bundle-inventory-v1") {
  throw new Error("dist/bundle-inventory.json uses an unsupported protocol");
}
for (const record of inventory.bundles ?? []) {
  const bytes = await readFile(resolve(root, "dist", record.file));
  if (record.bytes !== bytes.length || record.sha256 !== hash(bytes)) {
    throw new Error(`bundle inventory does not match dist/${record.file}`);
  }
}

const productionSbom = JSON.parse(
  runNpm(["sbom", "--sbom-format=cyclonedx", "--omit=dev", "--package-lock-only"]),
);
const completeLockSbom = JSON.parse(
  runNpm(["sbom", "--sbom-format=cyclonedx", "--package-lock-only"]),
);
const componentKey = (component) => `${component.name}@${component.version}`;
const bundledKeys = new Set(inventory.components.map(componentKey));
const components = new Map();
for (const component of productionSbom.components ?? []) {
  components.set(component["bom-ref"], component);
}
for (const component of completeLockSbom.components ?? []) {
  if (!bundledKeys.has(componentKey(component))) continue;
  components.set(component["bom-ref"], {
    ...component,
    scope: "required",
    properties: [
      ...(component.properties ?? []).filter(
        (property) => property.name !== "clockgrove.factory:embedded",
      ),
      { name: "clockgrove.factory:embedded", value: "true" },
    ],
  });
  bundledKeys.delete(componentKey(component));
}
if (bundledKeys.size > 0) {
  throw new Error(
    `bundle inventory components are missing from the lock SBOM: ${[...bundledKeys]}`,
  );
}

const rootRef = productionSbom.metadata?.component?.["bom-ref"];
const allowedRefs = new Set([rootRef, ...components.keys()]);
const dependencies = new Map();
for (const document of [productionSbom, completeLockSbom]) {
  for (const dependency of document.dependencies ?? []) {
    if (!allowedRefs.has(dependency.ref)) continue;
    const current = dependencies.get(dependency.ref) ?? new Set();
    for (const target of dependency.dependsOn ?? []) {
      if (allowedRefs.has(target)) current.add(target);
    }
    dependencies.set(dependency.ref, current);
  }
}
const rootDependencies = dependencies.get(rootRef) ?? new Set();
for (const component of completeLockSbom.components ?? []) {
  if (
    components
      .get(component["bom-ref"])
      ?.properties?.some(
        (property) => property.name === "clockgrove.factory:embedded" && property.value === "true",
      )
  ) {
    rootDependencies.add(component["bom-ref"]);
  }
}
dependencies.set(rootRef, rootDependencies);

const sbom = {
  ...productionSbom,
  components: [...components.values()],
  dependencies: [...dependencies].map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn] })),
};
delete sbom.serialNumber;
if (sbom.metadata) delete sbom.metadata.timestamp;
sbom.components?.sort((left, right) =>
  String(left["bom-ref"]).localeCompare(String(right["bom-ref"])),
);
sbom.dependencies?.sort((left, right) => String(left.ref).localeCompare(String(right.ref)));
for (const dependency of sbom.dependencies ?? []) dependency.dependsOn?.sort();

const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const sbomName = `${packageManifest.name.split("/").at(-1)}-${packageManifest.version}.cdx.json`;
const sbomPath = resolve(outputDirectory, sbomName);
const sbomBytes = `${JSON.stringify(sbom, null, 2)}\n`;
await writeFile(sbomPath, sbomBytes);
const sbomHash = hash(sbomBytes);
const inventoryHash = hash(inventoryBytes);
const noticesName = "THIRD_PARTY_NOTICES.txt";
const noticesHash = hash(await readFile(resolve(root, noticesName)));

const repository = String(packageManifest.repository?.url ?? "").replace(/^git\+/, "");
const sourceCommit = runGit(["rev-parse", "HEAD"]);
if (sourceCommit !== initialCommit) {
  throw new Error(
    "release source commit changed while creating artifacts; discard and regenerate them",
  );
}
const sourceDirty = initiallyDirty || runGit(["status", "--porcelain"]).length > 0;
const provenanceName = `${packageManifest.name.split("/").at(-1)}-${packageManifest.version}.provenance.json`;
const provenance = {
  protocol: "clockgrove.factory/release-provenance-v1",
  source: { repository, commit: sourceCommit, dirty: sourceDirty },
  package: {
    name: packageManifest.name,
    version: packageManifest.version,
    distTag: packageManifest.publishConfig?.tag ?? "latest",
  },
  subjects: [
    { file: packed.filename, sha256: tarballHash },
    { file: sbomName, sha256: sbomHash },
    { file: "dist/bundle-inventory.json", sha256: inventoryHash },
    { file: noticesName, sha256: noticesHash },
  ],
};
const provenanceBytes = `${JSON.stringify(provenance, null, 2)}\n`;
await writeFile(resolve(outputDirectory, provenanceName), provenanceBytes);
const provenanceHash = hash(provenanceBytes);

await writeFile(
  resolve(outputDirectory, "SHA256SUMS"),
  `${tarballHash}  ${packed.filename}\n${sbomHash}  ${sbomName}\n${provenanceHash}  ${provenanceName}\n`,
);
await writeFile(
  resolve(outputDirectory, "release-manifest.json"),
  `${JSON.stringify(
    {
      name: packageManifest.name,
      version: packageManifest.version,
      distTag: packageManifest.publishConfig?.tag ?? "latest",
      tarball: {
        file: packed.filename,
        integrity: packed.integrity,
        npmShasum: packed.shasum,
        packedBytes: packed.size,
        sha256: tarballHash,
        unpackedBytes: packed.unpackedSize,
      },
      sbom: { file: sbomName, format: "CycloneDX 1.5", sha256: sbomHash },
      bundleInventory: {
        file: "dist/bundle-inventory.json",
        components: inventory.components.length,
        sha256: inventoryHash,
      },
      thirdPartyNotices: { file: noticesName, sha256: noticesHash },
      provenance: {
        file: provenanceName,
        protocol: provenance.protocol,
        sha256: provenanceHash,
        sourceCommit,
        sourceDirty,
      },
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`created release artifacts in ${outputDirectory}\n`);
