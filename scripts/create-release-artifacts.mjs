import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertInitialBetaIdentity,
  assertNormalizedSbomRootIdentity,
  assertSbomRootIdentity,
  assertSynchronizedReleaseManifests,
  canonicalChecksumBytes,
  normalizeSbomRootIdentity,
  sha256,
} from "./release-integrity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length > 2) {
  throw new Error("release artifacts use the fixed release/ output directory");
}
const outputDirectory = resolve(root, "release");
const evidenceDirectory = resolve(outputDirectory, "evidence");
const candidateReceiptPath = resolve(evidenceDirectory, "candidate-deterministic.json");
const npmCache = process.env.FACTORY_NPM_CACHE ?? resolve(tmpdir(), "factory-npm-cache");
const candidateSubjects = Object.freeze([
  "package.json",
  "package-lock.json",
  "dist/factory.js",
  "dist/mcp-server.js",
  "dist/bundle-inventory.json",
]);

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

async function requireDirectory(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a nonsymlink directory: ${path}`);
  }
}

async function authenticateCandidateEvidence(initialCommit, initialTree) {
  await requireDirectory(outputDirectory, "release output");
  const outputEntries = await readdir(outputDirectory, { withFileTypes: true });
  if (
    outputEntries.length !== 1 ||
    outputEntries[0].name !== "evidence" ||
    !outputEntries[0].isDirectory() ||
    outputEntries[0].isSymbolicLink()
  ) {
    throw new Error(
      `release output may contain only the candidate evidence directory: ${outputDirectory}`,
    );
  }

  await requireDirectory(evidenceDirectory, "candidate evidence");
  const evidenceEntries = await readdir(evidenceDirectory, { withFileTypes: true });
  if (
    evidenceEntries.length !== 1 ||
    evidenceEntries[0].name !== "candidate-deterministic.json" ||
    !evidenceEntries[0].isFile() ||
    evidenceEntries[0].isSymbolicLink()
  ) {
    throw new Error(
      `candidate evidence must contain only a regular candidate-deterministic.json file: ${evidenceDirectory}`,
    );
  }

  const receiptDetails = await lstat(candidateReceiptPath);
  if (!receiptDetails.isFile() || receiptDetails.isSymbolicLink()) {
    throw new Error(`candidate receipt must be a nonsymlink regular file: ${candidateReceiptPath}`);
  }
  const receiptBytes = await readFile(candidateReceiptPath);
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error(`candidate receipt is malformed JSON: ${candidateReceiptPath}`);
  }
  if (
    receipt?.kind !== "factory-exact-commit-verification" ||
    receipt?.gate !== "verify:candidate" ||
    receipt?.status !== "passed" ||
    receipt?.commit !== initialCommit ||
    receipt?.tree !== initialTree
  ) {
    throw new Error("candidate receipt does not authenticate the current release source");
  }
  if (!Array.isArray(receipt.subjects) || receipt.subjects.length !== candidateSubjects.length) {
    throw new Error("candidate receipt must bind exactly five release subjects");
  }
  for (const path of candidateSubjects) {
    const matches = receipt.subjects.filter((subject) => subject?.path === path);
    if (matches.length !== 1 || !/^[0-9a-f]{64}$/.test(matches[0].sha256 ?? "")) {
      throw new Error(`candidate receipt must bind ${path} exactly once by SHA-256`);
    }
    const observed = sha256(await readFile(resolve(root, path)));
    if (matches[0].sha256 !== observed) {
      throw new Error(`${path} differs from the verified candidate subject`);
    }
  }
  return receiptBytes;
}

const initialCommit = runGit(["rev-parse", "HEAD"]);
const initialTree = runGit(["rev-parse", "HEAD^{tree}"]);
const initiallyDirty = runGit(["status", "--porcelain"]).length > 0;
if (initiallyDirty) throw new Error("release artifacts require a clean Git worktree");
const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
assertInitialBetaIdentity(packageManifest, packageLock);
const pluginManifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const codexManifest = JSON.parse(
  await readFile(resolve(root, ".codex-plugin", "plugin.json"), "utf8"),
);
const claudeManifest = JSON.parse(
  await readFile(resolve(root, ".claude-plugin", "plugin.json"), "utf8"),
);
const marketplace = JSON.parse(
  await readFile(resolve(root, ".github", "plugin", "marketplace.json"), "utf8"),
);
assertSynchronizedReleaseManifests(packageManifest, {
  plugin: pluginManifest,
  codex: codexManifest,
  claude: claudeManifest,
  marketplace,
});
const candidateReceiptBytes = await authenticateCandidateEvidence(initialCommit, initialTree);
await mkdir(dirname(outputDirectory), { recursive: true });
const stagingDirectory = await mkdtemp(
  resolve(dirname(outputDirectory), `.${basename(outputDirectory)}.tmp-`),
);
const previousDirectory = `${stagingDirectory}-previous`;
const stagingRelative = relative(root, stagingDirectory);
const statusIgnoringStaging = () => {
  const args = ["status", "--porcelain", "--untracked-files=all"];
  if (
    stagingRelative &&
    stagingRelative !== ".." &&
    !stagingRelative.startsWith(`..${sep}`) &&
    !resolve(root, stagingRelative).startsWith(`${resolve(root, "node_modules")}${sep}`)
  ) {
    const normalized = stagingRelative.split(sep).join("/");
    args.push("--", ".", `:(exclude)${normalized}/**`);
  }
  return runGit(args);
};

let completed = false;
try {
  const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", stagingDirectory]))[0];
  if (!packed?.filename) throw new Error("npm pack did not return an artifact");
  const tarballPath = resolve(stagingDirectory, packed.filename);
  const tarballHash = sha256(await readFile(tarballPath));

  const inventoryPath = resolve(root, "dist", "bundle-inventory.json");
  const inventoryBytes = await readFile(inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  if (inventory.protocol !== "clockgrove.factory/bundle-inventory-v1") {
    throw new Error("dist/bundle-inventory.json uses an unsupported protocol");
  }
  for (const record of inventory.bundles ?? []) {
    const bytes = await readFile(resolve(root, "dist", record.file));
    if (record.bytes !== bytes.length || record.sha256 !== sha256(bytes)) {
      throw new Error(`bundle inventory does not match dist/${record.file}`);
    }
  }

  const productionSbom = JSON.parse(
    runNpm(["sbom", "--sbom-format=cyclonedx", "--omit=dev", "--package-lock-only"]),
  );
  const completeLockSbom = JSON.parse(
    runNpm(["sbom", "--sbom-format=cyclonedx", "--package-lock-only"]),
  );
  assertSbomRootIdentity(productionSbom, packageManifest, "production SBOM");
  assertSbomRootIdentity(completeLockSbom, packageManifest, "complete-lock SBOM");
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
          (property) =>
            property.name === "clockgrove.factory:embedded" && property.value === "true",
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
  normalizeSbomRootIdentity(sbom, packageManifest, "release SBOM");
  delete sbom.serialNumber;
  if (sbom.metadata) delete sbom.metadata.timestamp;
  sbom.components?.sort((left, right) =>
    String(left["bom-ref"]).localeCompare(String(right["bom-ref"])),
  );
  sbom.dependencies?.sort((left, right) => String(left.ref).localeCompare(String(right.ref)));
  for (const dependency of sbom.dependencies ?? []) dependency.dependsOn?.sort();

  assertNormalizedSbomRootIdentity(sbom, packageManifest, "release SBOM");
  const sbomName = `${packageManifest.name.split("/").at(-1)}-${packageManifest.version}.cdx.json`;
  const sbomPath = resolve(stagingDirectory, sbomName);
  const sbomBytes = `${JSON.stringify(sbom, null, 2)}\n`;
  await writeFile(sbomPath, sbomBytes);
  const sbomHash = sha256(sbomBytes);
  const inventoryHash = sha256(inventoryBytes);
  const noticesName = "THIRD_PARTY_NOTICES.txt";
  const noticesHash = sha256(await readFile(resolve(root, noticesName)));

  const repository = String(packageManifest.repository?.url ?? "").replace(/^git\+/, "");
  const sourceCommit = runGit(["rev-parse", "HEAD"]);
  if (sourceCommit !== initialCommit) {
    throw new Error(
      "release source commit changed while creating artifacts; discard and regenerate them",
    );
  }
  const sourceDirty = false;
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
  await writeFile(resolve(stagingDirectory, provenanceName), provenanceBytes);
  const provenanceHash = sha256(provenanceBytes);

  const checksumsName = "SHA256SUMS";
  const checksumsBytes = canonicalChecksumBytes([
    { file: packed.filename, sha256: tarballHash },
    { file: sbomName, sha256: sbomHash },
    { file: provenanceName, sha256: provenanceHash },
  ]);
  await writeFile(resolve(stagingDirectory, checksumsName), checksumsBytes);
  const checksumsHash = sha256(checksumsBytes);
  if (runGit(["rev-parse", "HEAD"]) !== initialCommit) {
    throw new Error(
      "release source commit changed while creating artifacts; discard and regenerate them",
    );
  }
  if (statusIgnoringStaging().length > 0) {
    throw new Error("release source changed while creating artifacts; discard and regenerate them");
  }
  await writeFile(
    resolve(stagingDirectory, "release-manifest.json"),
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
        checksums: { file: checksumsName, sha256: checksumsHash },
      },
      null,
      2,
    )}\n`,
  );

  const currentReceiptBytes = await authenticateCandidateEvidence(initialCommit, initialTree);
  if (!currentReceiptBytes.equals(candidateReceiptBytes)) {
    throw new Error("candidate receipt changed while creating release artifacts");
  }
  await mkdir(resolve(stagingDirectory, "evidence"));
  await writeFile(
    resolve(stagingDirectory, "evidence", "candidate-deterministic.json"),
    candidateReceiptBytes,
    { mode: 0o600 },
  );

  await rename(outputDirectory, previousDirectory);
  let swapped = false;
  try {
    const preservedReceipt = await readFile(
      resolve(previousDirectory, "evidence", "candidate-deterministic.json"),
    );
    if (!preservedReceipt.equals(candidateReceiptBytes)) {
      throw new Error("candidate receipt changed during the final artifact swap");
    }
    if (
      process.env.NODE_ENV === "test" &&
      process.env.FACTORY_TEST_RELEASE_FINAL_SWAP_FAILURE === "1"
    ) {
      throw new Error("injected final release artifact swap failure");
    }
    await rename(stagingDirectory, outputDirectory);
    swapped = true;
  } catch (error) {
    if (!swapped) await rename(previousDirectory, outputDirectory);
    throw error;
  }
  await rm(previousDirectory, { recursive: true });
  completed = true;
  process.stdout.write(`created release artifacts in ${outputDirectory}\n`);
} finally {
  if (!completed) await rm(stagingDirectory, { recursive: true, force: true });
}
