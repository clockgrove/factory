import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
// Gate evidence is committed after its run. Only the evidence ledger and its records may
// differ from the tested commit; changing any implementation or other documentation reruns gates.
const evidenceOnlyPath = (path) =>
  path === "docs/CONFORMANCE.md" || path.startsWith("docs/release-evidence/");
const testedCommits = new Set();
const verifyTestedCommit = (testedCommit) => {
  if (!/^[0-9a-f]{40}$/.test(testedCommit ?? "")) {
    throw new Error("release evidence must identify a full tested Git commit");
  }
  if (testedCommits.has(testedCommit)) return;
  try {
    git(["merge-base", "--is-ancestor", testedCommit, commit]);
  } catch {
    throw new Error(`tested commit ${testedCommit} is not an ancestor of release ${commit}`);
  }
  const changed = git(["diff", "--name-only", "-z", testedCommit, commit])
    .split("\0")
    .filter(Boolean);
  if (changed.some((path) => !evidenceOnlyPath(path))) {
    throw new Error(
      `release differs from tested commit ${testedCommit} outside evidence: ${changed.join(", ")}`,
    );
  }
  testedCommits.add(testedCommit);
};
const requiredSubjects = [
  "dist/factory.js",
  "dist/mcp-server.js",
  "dist/bundle-inventory.json",
  "package.json",
  "package-lock.json",
  ".codex-plugin/plugin.json",
];
const evidenceRoot = resolve(root, "docs", "release-evidence");
const resolveEvidencePath = (path) => {
  const resolved = resolve(root, path);
  if (!resolved.startsWith(`${evidenceRoot}${sep}`)) {
    throw new Error(`release evidence path escapes docs/release-evidence: ${path}`);
  }
  return resolved;
};
const readEvidence = async (path) => {
  const resolved = resolveEvidencePath(path);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error(`release evidence may not use symlinks: ${path}`);
  }
  git(["ls-files", "--error-unmatch", "--", path]);
  return readFile(resolved);
};
const conformance = await readFile(resolve(root, "docs", "CONFORMANCE.md"), "utf8");
const requiredBeforePublish = [
  "Linux environment matrix",
  "Live adaptive scheduling matrix",
  "Live native-stack matrix",
  "Real Daytona Objective",
  "Managed-provider capability boundaries",
  "Objective-level adversarial E2E",
];

const gateHeading = "## Verification required before publication";
if (!conformance.includes(gateHeading)) {
  throw new Error("docs/CONFORMANCE.md is missing the publication verification ledger");
}

const gateSection = conformance.split(gateHeading, 2)[1].split(/^## /m, 1)[0];
const rows = gateSection
  .split("\n")
  .filter((line) => line.startsWith("|"))
  .map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  )
  .filter((cells) => cells.length === 3 && cells[0] !== "Gate" && !/^---+$/.test(cells[0]));
const openGates = [];
const managedBackendIds = ["github-copilot/github-managed", "openai-codex/github-managed"];
const verifyManagedObjective = async (qualification, record, backendId) => {
  assert.equal(qualification.schema, 1, "installed qualification schema missing");
  assert.equal(qualification.kind, "installed-provider-objective-qualification");
  const observed = qualification.observation;
  assert.equal(observed?.schemaVersion, 1, "structured installed observation missing");
  assert.equal(observed.scope, "installed-managed-objective-happy-path");
  assert.equal(observed.result, "passed", "installed Objective exercise did not pass");
  assert.equal(observed.completionAssessment?.result, "passed", "completion assessment is incomplete");
  assert.equal(observed.completionAssessment.scope, observed.scope);
  assert.equal(observed.failure, undefined, "qualification retained a failed boundary");
  assert.ok(Number.isFinite(Date.parse(observed.startedAt)));
  assert.ok(Date.parse(observed.finishedAt) >= Date.parse(observed.startedAt));
  assert.equal(observed.preflight?.result, "passed");
  assert.deepEqual(observed.preflight.blockers, []);
  assert.equal(observed.preflight.harness?.sourceCommit, record.commit);
  assert.equal(observed.preflight.harness.sourceTreeClean, true);
  const inventory = record.subjects.find((subject) => subject.path === "dist/bundle-inventory.json");
  assert.equal(observed.installedArtifact?.inventorySha256, inventory.sha256);
  assert.equal(observed.preflight.harness.candidateInventorySha256, inventory.sha256);
  assert.deepEqual(observed.preflight.installedArtifact, observed.installedArtifact);
  assert.deepEqual(observed.finishedInstalledArtifact, observed.installedArtifact);
  assert.equal(observed.installedArtifact.bundles?.length, 2);
  for (const file of ["factory.js", "mcp-server.js"]) {
    const bundles = observed.installedArtifact.bundles.filter((bundle) => bundle.file === file);
    assert.equal(bundles.length, 1);
    const subject = record.subjects.find((entry) => entry.path === `dist/${file}`);
    assert.equal(bundles[0].sha256, subject.sha256, "observed installed bundle differs from gate");
    assert.equal(bundles[0].bytes, (await readFile(resolve(root, subject.path))).length);
  }
  const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(observed.installedArtifact.version, packageManifest.version);
  const authority = observed.providerAuthority;
  assert.equal(authority?.profile, backendId === managedBackendIds[0] ? "github-copilot" : "openai-codex");
  assert.equal(authority.repository, observed.repository);
  assert.ok(Number.isSafeInteger(authority.sandboxMinutes) && authority.sandboxMinutes >= 10 && authority.sandboxMinutes <= 120);
  assert.ok(Number.isSafeInteger(authority.modelTokens) && authority.modelTokens >= 1000 && authority.modelTokens <= 500000);
  assert.equal(authority.managedSessions, 3);
  // Reuse the runner's pure execution proof, not its caller-supplied passed label.
  // Importing this module does not invoke a provider, controller or live runner.
  const { assessProviderCompletion, providerPolicy } = await import("./verify-provider-objective.mjs");
  assert.deepEqual(observed.policy, providerPolicy(authority));
  const starts = observed.events.filter((event) => event.event === "FactoryRunStarted");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].policy, observed.policy);
  const assessment = assessProviderCompletion(observed, authority);
  assert.equal(assessment.result, "passed", assessment.reason);
  const joins = observed.dependencies.filter((item) => item.blockedBy.length === 2);
  assert.equal(joins.length, 1);
  const integrations = observed.events.filter((event) =>
    event.runId === observed.runResult.runId && event.event === "AttemptIntegrated" && event.workItem === joins[0].workItem);
  assert.equal(integrations.length, 1);
  assert.match(observed.finalSha ?? "", /^[a-f0-9]{40}$/);
  assert.equal(observed.finalSha, integrations[0].headSha);
  assert.ok(typeof observed.testOutput === "string" && observed.testOutput.trim().length > 0);
  assert.ok(typeof observed.behaviorOutput === "string" && observed.behaviorOutput.trim().length > 0);
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
    const entries = record.managedProviders.filter((provider) => provider?.backendId === backendId);
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
        typeof boundary.capability !== "string" || !boundary.capability.trim() ||
        typeof boundary.reason !== "string" || !boundary.reason.trim() ||
        reference.protocol !== "https:" || reference.username || reference.password ||
        !["docs.github.com", "developers.openai.com", "learn.chatgpt.com", "platform.openai.com"].includes(reference.hostname)
      ) {
        throw new Error(`${backendId} has an invalid unsupported-capability boundary`);
      }
    }
    if (!available) {
      if (
        observed.reasonKind !== "provider-interface-unavailable" ||
        typeof observed.probe.reason !== "string" || !observed.probe.reason.trim() ||
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
      new Set(observed.supportedClaims.map((claim) => claim?.capability)).size !== observed.supportedClaims.length
    ) {
      throw new Error(`${backendId} requires qualified supported claims including objective-delivery`);
    }
    for (const claim of observed.supportedClaims) {
      const qualification = await boundArtifact(claim.evidence);
      if (
        typeof claim.capability !== "string" || !claim.capability.trim() ||
        qualification.commit !== record.commit || qualification.backendId !== backendId ||
        qualification.capability !== claim.capability || qualification.status !== "passed"
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
  const matches = rows.filter(([name]) => name === gate);
  if (matches.length !== 1) {
    throw new Error(`release ledger must contain ${gate} exactly once; found ${matches.length}`);
  }
  const [, status, evidence] = matches[0];
  if (status !== "Passed") {
    openGates.push(`${gate} (${status || "missing status"})`);
    continue;
  }
  const evidenceMatch = evidence.match(/\[[^\]]+\]\((release-evidence\/[^)]+\.json)\)/);
  if (!evidenceMatch) {
    throw new Error(`${gate} is Passed but does not link a docs/release-evidence JSON record`);
  }
  const record = JSON.parse((await readEvidence(`docs/${evidenceMatch[1]}`)).toString("utf8"));
  if (
    record.schema !== 2 ||
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
    throw new Error(`${evidenceMatch[1]} is not a complete release-evidence record`);
  }
  verifyTestedCommit(record.commit);
  for (const path of requiredSubjects) {
    const subjects = record.subjects.filter((subject) => subject?.path === path);
    if (subjects.length !== 1 || !/^[0-9a-f]{64}$/.test(subjects[0].sha256 ?? "")) {
      throw new Error(`${evidenceMatch[1]} must bind ${path} exactly once by SHA-256`);
    }
    const digest = createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex");
    if (digest !== subjects[0].sha256) {
      throw new Error(`${path} differs from the tested release subject`);
    }
  }
  for (const artifact of record.artifacts) {
    if (
      typeof artifact?.path !== "string" ||
      !artifact.path.startsWith("docs/release-evidence/") ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")
    ) {
      throw new Error(`${evidenceMatch[1]} contains an invalid artifact descriptor`);
    }
    const bytes = await readEvidence(artifact.path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) {
      throw new Error(`${artifact.path} does not match its recorded SHA-256 digest`);
    }
  }
  if (gate === "Managed-provider capability boundaries") await verifyManagedProviders(record);
}
if (openGates.length > 0) {
  throw new Error(
    `release publication is blocked by open conformance gates:\n- ${openGates.join("\n- ")}`,
  );
}
if (git(["status", "--porcelain"])) {
  throw new Error("release publication requires a clean Git worktree");
}

const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
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
process.stdout.write(`publication evidence complete for ${commit}\n`);
