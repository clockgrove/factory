import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function verifyPublishReadiness() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const verifyTestedCommit = (testedCommit) => {
    if (testedCommit !== commit) {
      throw new Error(`release evidence must identify exact current commit ${commit}`);
    }
  };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const readRegularFile = async (path) => {
    if ((await realpath(path)) !== path || !(await stat(path)).isFile()) {
      throw new Error(`release files must be regular files without symlinks: ${path}`);
    }
    return readFile(path);
  };
  const requiredSubjects = [
    "dist/factory.js",
    "dist/mcp-server.js",
    "dist/bundle-inventory.json",
    "bin/factory-mcp",
    "package.json",
    "package-lock.json",
    ".codex-plugin/plugin.json",
  ];
  const evidenceRoot = resolve(root, "release", "evidence");
  const readEvidence = async (path) => {
    if (
      typeof path !== "string" ||
      !path ||
      isAbsolute(path) ||
      path.split(/[\\/]/).includes("..")
    ) {
      throw new Error(`invalid release evidence path: ${path}`);
    }
    const resolved = resolve(evidenceRoot, path);
    if (!resolved.startsWith(`${evidenceRoot}${sep}`)) {
      throw new Error(`release evidence path escapes release/evidence: ${path}`);
    }
    return readRegularFile(resolved);
  };
  const releaseDirectory = resolve(root, "release");
  const manifestBytes = await readRegularFile(resolve(releaseDirectory, "release-manifest.json"));
  const releaseManifestSha256 = hash(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const requiredBeforePublish = [
    "Linux environment matrix",
    "Live adaptive scheduling matrix",
    "Live native-stack matrix",
    "Real Daytona Objective",
    "Managed-provider capability boundaries",
    "Objective-level adversarial E2E",
  ];

  const index = JSON.parse((await readEvidence("index.json")).toString("utf8"));
  verifyTestedCommit(index.commit);
  if (
    index.schema !== 1 ||
    index.releaseManifestSha256 !== releaseManifestSha256 ||
    !Array.isArray(index.gates) ||
    index.gates.length !== requiredBeforePublish.length ||
    index.gates.some((entry) => !requiredBeforePublish.includes(entry?.gate))
  ) {
    throw new Error("invalid release evidence index or release manifest digest");
  }
  const managedBackendIds = ["github-copilot/github-managed", "openai-codex/github-managed"];
  const verifyManagedObjective = async (qualification, record, backendId) => {
    assert.equal(qualification.schema, 1, "installed qualification schema missing");
    assert.equal(qualification.kind, "installed-provider-objective-qualification");
    const observed = qualification.observation;
    assert.equal(observed?.schemaVersion, 1, "structured installed observation missing");
    assert.equal(observed.scope, "installed-managed-objective-happy-path");
    assert.equal(observed.result, "passed", "installed Objective exercise did not pass");
    assert.equal(
      observed.completionAssessment?.result,
      "passed",
      "completion assessment is incomplete",
    );
    assert.equal(observed.completionAssessment.scope, observed.scope);
    assert.equal(observed.failure, undefined, "qualification retained a failed boundary");
    assert.ok(Number.isFinite(Date.parse(observed.startedAt)));
    assert.ok(Date.parse(observed.finishedAt) >= Date.parse(observed.startedAt));
    assert.equal(observed.preflight?.result, "passed");
    assert.deepEqual(observed.preflight.blockers, []);
    assert.equal(observed.preflight.harness?.sourceCommit, record.commit);
    assert.equal(observed.preflight.harness.sourceTreeClean, true);
    const inventory = record.subjects.find(
      (subject) => subject.path === "dist/bundle-inventory.json",
    );
    assert.equal(observed.installedArtifact?.inventorySha256, inventory.sha256);
    assert.equal(observed.preflight.harness.candidateInventorySha256, inventory.sha256);
    assert.deepEqual(observed.preflight.installedArtifact, observed.installedArtifact);
    assert.deepEqual(observed.finishedInstalledArtifact, observed.installedArtifact);
    assert.equal(observed.installedArtifact.bundles?.length, 2);
    for (const file of ["factory.js", "mcp-server.js"]) {
      const bundles = observed.installedArtifact.bundles.filter((bundle) => bundle.file === file);
      assert.equal(bundles.length, 1);
      const subject = record.subjects.find((entry) => entry.path === `dist/${file}`);
      assert.equal(
        bundles[0].sha256,
        subject.sha256,
        "observed installed bundle differs from gate",
      );
      assert.equal(bundles[0].bytes, (await readFile(resolve(root, subject.path))).length);
    }
    const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    assert.equal(observed.installedArtifact.version, packageManifest.version);
    const authority = observed.providerAuthority;
    assert.equal(
      authority?.profile,
      backendId === managedBackendIds[0] ? "github-copilot" : "openai-codex",
    );
    assert.equal(authority.repository, observed.repository);
    assert.ok(
      Number.isSafeInteger(authority.sandboxMinutes) &&
        authority.sandboxMinutes >= 10 &&
        authority.sandboxMinutes <= 120,
    );
    assert.ok(
      Number.isSafeInteger(authority.modelTokens) &&
        authority.modelTokens >= 1000 &&
        authority.modelTokens <= 500000,
    );
    assert.equal(authority.managedSessions, 3);
    // Reuse the runner's pure execution proof, not its caller-supplied passed label.
    // Importing this module does not invoke a provider, controller or live runner.
    const { assessProviderCompletion, providerPolicy } = await import(
      "./verify-provider-objective.mjs"
    );
    assert.deepEqual(observed.policy, providerPolicy(authority));
    const starts = observed.events.filter((event) => event.event === "FactoryRunStarted");
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].policy, observed.policy);
    const assessment = assessProviderCompletion(observed, authority);
    assert.equal(assessment.result, "passed", assessment.reason);
    const joins = observed.dependencies.filter((item) => item.blockedBy.length === 2);
    assert.equal(joins.length, 1);
    const integrations = observed.events.filter(
      (event) =>
        event.runId === observed.runResult.runId &&
        event.event === "AttemptIntegrated" &&
        event.workItem === joins[0].workItem,
    );
    assert.equal(integrations.length, 1);
    assert.match(observed.finalSha ?? "", /^[a-f0-9]{40}$/);
    assert.equal(observed.finalSha, integrations[0].headSha);
    assert.ok(typeof observed.testOutput === "string" && observed.testOutput.trim().length > 0);
    assert.ok(
      typeof observed.behaviorOutput === "string" && observed.behaviorOutput.trim().length > 0,
    );
  };
  const verifyManagedProviders = async (record) => {
    if (!Array.isArray(record.managedProviders) || record.managedProviders.length !== 2) {
      throw new Error("managed-provider evidence requires both exact provider declarations");
    }
    const boundArtifact = async (descriptor) => {
      if (
        !descriptor ||
        typeof descriptor.path !== "string" ||
        !/^[0-9a-f]{64}$/.test(descriptor.sha256 ?? "") ||
        record.artifacts.filter(
          (artifact) => artifact.path === descriptor.path && artifact.sha256 === descriptor.sha256,
        ).length !== 1
      ) {
        throw new Error("managed-provider evidence must reference a unique digest-bound artifact");
      }
      const bytes = await readEvidence(descriptor.path);
      if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
        throw new Error("managed-provider artifact digest mismatch");
      }
      return JSON.parse(bytes.toString("utf8"));
    };
    for (const backendId of managedBackendIds) {
      const entries = record.managedProviders.filter(
        (provider) => provider?.backendId === backendId,
      );
      if (entries.length !== 1) {
        throw new Error(`managed-provider evidence must declare ${backendId} exactly once`);
      }
      const provider = entries[0];
      const observed = await boundArtifact(provider.evidence);
      const available = provider.availability === "available";
      if (
        (!available && provider.availability !== "unavailable") ||
        observed.schema !== 1 ||
        observed.kind !== "managed-provider-capability" ||
        observed.commit !== record.commit ||
        observed.backendId !== backendId ||
        observed.availability !== provider.availability ||
        observed.status !== "passed" ||
        observed.probe?.available !== available ||
        observed.probe?.authenticated !== available ||
        !Number.isFinite(Date.parse(observed.probe?.measuredAt ?? "")) ||
        observed.checks?.declarationMatchesInstalled !== true ||
        observed.checks?.localStartupUnaffected !== true ||
        !Array.isArray(observed.unsupportedCapabilities) ||
        !Array.isArray(observed.supportedClaims)
      ) {
        throw new Error(`${backendId} lacks an exact-candidate installed capability observation`);
      }
      for (const boundary of observed.unsupportedCapabilities) {
        let reference;
        try {
          reference = new URL(boundary.reference);
        } catch {
          throw new Error(`${backendId} has an unsupported capability without a source`);
        }
        if (
          typeof boundary.capability !== "string" ||
          !boundary.capability.trim() ||
          typeof boundary.reason !== "string" ||
          !boundary.reason.trim() ||
          reference.protocol !== "https:" ||
          reference.username ||
          reference.password ||
          ![
            "docs.github.com",
            "developers.openai.com",
            "learn.chatgpt.com",
            "platform.openai.com",
          ].includes(reference.hostname)
        ) {
          throw new Error(`${backendId} has an invalid unsupported-capability boundary`);
        }
      }
      if (!available) {
        if (
          observed.reasonKind !== "provider-interface-unavailable" ||
          typeof observed.probe.reason !== "string" ||
          !observed.probe.reason.trim() ||
          observed.unsupportedCapabilities.length === 0 ||
          observed.supportedClaims.length !== 0 ||
          observed.checks.unavailableLaunchDenied !== true ||
          observed.checks.noProviderLaunch !== true
        ) {
          throw new Error(`${backendId} unavailability is not an evidenced fail-closed boundary`);
        }
        continue;
      }
      if (
        !observed.supportedClaims.some((claim) => claim?.capability === "objective-delivery") ||
        new Set(observed.supportedClaims.map((claim) => claim?.capability)).size !==
          observed.supportedClaims.length
      ) {
        throw new Error(
          `${backendId} requires qualified supported claims including objective-delivery`,
        );
      }
      for (const claim of observed.supportedClaims) {
        const qualification = await boundArtifact(claim.evidence);
        if (
          typeof claim.capability !== "string" ||
          !claim.capability.trim() ||
          qualification.commit !== record.commit ||
          qualification.backendId !== backendId ||
          qualification.capability !== claim.capability ||
          qualification.status !== "passed"
        ) {
          throw new Error(`${backendId} has an unqualified supported capability claim`);
        }
        if (claim.capability !== "objective-delivery") {
          throw new Error(`${backendId} has no release assessor for ${claim.capability}`);
        }
        await verifyManagedObjective(qualification, record, backendId);
      }
    }
  };
  for (const gate of requiredBeforePublish) {
    const matches = index.gates.filter((entry) => entry.gate === gate);
    if (matches.length !== 1) {
      throw new Error(`release evidence index must contain ${gate} exactly once`);
    }
    const descriptor = matches[0];
    const recordBytes = await readEvidence(descriptor.path);
    if (hash(recordBytes) !== descriptor.sha256) {
      throw new Error(`${gate} record does not match its recorded SHA-256 digest`);
    }
    const record = JSON.parse(recordBytes.toString("utf8"));
    if (
      record.schema !== 2 ||
      record.releaseManifestSha256 !== releaseManifestSha256 ||
      record.gate !== gate ||
      record.status !== "passed" ||
      !Number.isFinite(Date.parse(record.recordedAt ?? "")) ||
      !Array.isArray(record.commands) ||
      record.commands.length === 0 ||
      !record.commands.every((command) => typeof command === "string" && command.length > 0) ||
      !Array.isArray(record.artifacts) ||
      record.artifacts.length === 0 ||
      !Array.isArray(record.subjects) ||
      record.subjects.length !== requiredSubjects.length
    ) {
      throw new Error(`${descriptor.path} is not a complete release-evidence record`);
    }
    verifyTestedCommit(record.commit);
    for (const path of requiredSubjects) {
      const subjects = record.subjects.filter((subject) => subject?.path === path);
      if (subjects.length !== 1 || !/^[0-9a-f]{64}$/.test(subjects[0].sha256 ?? "")) {
        throw new Error(`${descriptor.path} must bind ${path} exactly once by SHA-256`);
      }
      const digest = createHash("sha256")
        .update(await readFile(resolve(root, path)))
        .digest("hex");
      if (digest !== subjects[0].sha256) {
        throw new Error(`${path} differs from the tested release subject`);
      }
    }
    for (const artifact of record.artifacts) {
      if (typeof artifact?.path !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")) {
        throw new Error(`${descriptor.path} contains an invalid artifact descriptor`);
      }
      const bytes = await readEvidence(artifact.path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== artifact.sha256) {
        throw new Error(`${artifact.path} does not match its recorded SHA-256 digest`);
      }
    }
    if (gate === "Managed-provider capability boundaries") await verifyManagedProviders(record);
  }
  if (git(["status", "--porcelain"])) {
    throw new Error("release publication requires a clean Git worktree");
  }

  const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (
    manifest.name !== packageManifest.name ||
    manifest.version !== packageManifest.version ||
    manifest.distTag !== packageManifest.publishConfig?.tag
  ) {
    throw new Error("release manifest does not match package.json");
  }

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
    if (hash(await readRegularFile(path)) !== descriptor.sha256) {
      throw new Error(
        `release artifact ${descriptor.file} does not match its verified SHA-256 digest`,
      );
    }
    return path;
  };
  const tarball = await verifyArtifact(manifest.tarball);
  await verifyArtifact(manifest.sbom);
  const provenancePath = await verifyArtifact(manifest.provenance);
  const provenance = JSON.parse((await readRegularFile(provenancePath)).toString("utf8"));
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

  const releaseTag = `v${packageManifest.version}`;
  let taggedCommit;
  try {
    taggedCommit = execFileSync("git", ["rev-list", "-n", "1", releaseTag], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(`release publication requires immutable tag ${releaseTag}`);
  }
  if (taggedCommit !== commit) {
    throw new Error(`${releaseTag} does not identify the release commit ${commit}`);
  }
  return {
    tarball,
    access: packageManifest.publishConfig.access,
    distTag: manifest.distTag,
    commit,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verified = await verifyPublishReadiness();
  process.stdout.write(`publication evidence complete for ${verified.commit}\n`);
}
