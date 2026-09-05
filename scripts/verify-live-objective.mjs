/** Opt-in installed-plugin Supervisor exercise; never part of offline release checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Octokit } from "@octokit/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localBackends = ["codex-sdk/local-worktree", "codex-cli/local-worktree"];
const minimumGitHubQuota = 1_000;
const minimumModelTokens = 250_000;
const maximumModelTokens = 500_000;
const namespacePattern = /^[a-z](?:[a-z0-9-]{6,46}[a-z0-9])$/;

export function qualificationNamespace(value, generate = randomUUID) {
  const namespace = value?.trim() || `q-${generate()}`;
  assert.match(
    namespace,
    namespacePattern,
    "qualification namespace must be 8-48 lowercase letters, digits, or internal hyphens",
  );
  return namespace;
}

export function qualificationPaths(namespace) {
  assert.match(namespace, namespacePattern, "invalid qualification namespace");
  const sourceDirectory = `src/factory-qualification/${namespace}`;
  const testDirectory = `test/factory-qualification/${namespace}`;
  return {
    sourceDirectory,
    testDirectory,
    files: ["clamp", "slugify", "describe"].flatMap((name) => [
      `${sourceDirectory}/${name}.js`,
      `${testDirectory}/${name}.test.js`,
    ]),
  };
}

export function qualificationNamespaceMarker(namespace) {
  assert.match(namespace, namespacePattern, "invalid qualification namespace");
  return `<!-- clockgrove-factory:qualification-namespace=${namespace} -->`;
}

export async function waitForCreatedObjectiveNamespace({
  list,
  namespace,
  createdIssue,
  wait = sleep,
}) {
  const marker = qualificationNamespaceMarker(namespace);
  assert.ok(
    Number.isSafeInteger(createdIssue.number) &&
      createdIssue.number > 0 &&
      Number.isSafeInteger(createdIssue.id) &&
      createdIssue.id > 0 &&
      !createdIssue.pull_request &&
      createdIssue.body?.includes(marker),
    "created Objective identity or qualification namespace is invalid",
  );
  // Creation is single-shot. Only a successful empty namespace observation may
  // be retried; lookup failures and conflicting identities never mean absence.
  const delays = [1_000, 2_000, 4_000, 8_000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const issues = await list("GET /repos/{owner}/{repo}/issues", { state: "all" }, 1_000);
    assert.ok(Array.isArray(issues), "namespace issue lookup must return an array");
    for (const issue of issues)
      assert.ok(
        issue &&
          Number.isSafeInteger(issue.number) &&
          issue.number > 0 &&
          Number.isSafeInteger(issue.id) &&
          issue.id > 0 &&
          (issue.body === null || typeof issue.body === "string"),
        "namespace issue lookup returned an unknown issue shape",
      );
    const matching = issues.filter((issue) => !issue.pull_request && issue.body?.includes(marker));
    if (matching.length > 0) {
      assert.deepEqual(
        matching.map((issue) => ({ number: issue.number, id: issue.id })),
        [{ number: createdIssue.number, id: createdIssue.id }],
        "qualification namespace is not uniquely bound to the created Objective",
      );
      return;
    }
    if (attempt < delays.length) await wait(delays[attempt]);
  }
  assert.fail("created Objective qualification namespace is not visible after five bounded reads");
}

export function installedPluginPath({ listed, codexHome, requestedRoot }) {
  const matches = (listed.installed ?? []).filter(
    (entry) =>
      entry.name === "factory" &&
      entry.installed === true &&
      entry.enabled === true &&
      typeof entry.version === "string" &&
      typeof entry.marketplaceName === "string" &&
      /^[\w.-]+$/.test(entry.marketplaceName) &&
      entry.pluginId === `factory@${entry.marketplaceName}`,
  );
  assert.equal(matches.length, 1, "one enabled installed Factory plugin is required");
  const entry = matches[0];
  const path = join(
    resolve(codexHome),
    "plugins",
    "cache",
    entry.marketplaceName,
    "factory",
    entry.version,
  );
  if (requestedRoot)
    assert.equal(
      resolve(requestedRoot),
      path,
      "requested plugin root differs from installed receipt",
    );
  return path;
}

export function installedBundleIdentity(pluginRoot) {
  const root = realpathSync(pluginRoot);
  assert.ok(
    root !== sourceRoot && !root.startsWith(`${sourceRoot}${sep}`),
    "development worktree is not an installation",
  );
  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const inventoryPath = realpathSync(join(root, "dist", "bundle-inventory.json"));
  assert.ok(inventoryPath.startsWith(`${root}${sep}`), "installed inventory escapes its artifact");
  const inventoryBytes = readFileSync(inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  assert.equal(inventory.protocol, "clockgrove.factory/bundle-inventory-v1");
  assert.ok(Array.isArray(inventory.bundles), "installed bundle inventory is missing");
  const bundles = [];
  for (const file of ["factory.js", "mcp-server.js"]) {
    const records = inventory.bundles.filter((entry) => entry.file === file);
    assert.equal(records.length, 1, `missing or duplicate installed ${file} identity`);
    const path = realpathSync(join(root, "dist", file));
    assert.ok(path.startsWith(`${root}${sep}`), `installed ${file} escapes its artifact`);
    const bytes = readFileSync(path);
    assert.equal(records[0].bytes, bytes.length, `installed ${file} byte count differs`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(records[0].sha256, digest, `installed ${file} digest differs`);
    bundles.push({ file, bytes: bytes.length, sha256: digest });
  }
  return {
    version: packageManifest.version,
    inventorySha256: createHash("sha256").update(inventoryBytes).digest("hex"),
    bundles,
  };
}

export function modelTokenLimit(value) {
  assert.match(value ?? "", /^[1-9]\d*$/, "explicit model-token limit required");
  const limit = Number(value);
  assert.ok(
    Number.isSafeInteger(limit) && limit >= minimumModelTokens && limit <= maximumModelTokens,
    `model-token limit must be ${minimumModelTokens}-${maximumModelTokens}`,
  );
  return limit;
}

export function assessQualificationPreflight(input) {
  const blockers = [];
  if (input.checkout?.clean !== true) blockers.push("checkout-is-not-clean");
  if (input.checkout?.headMatchesDefault !== true)
    blockers.push("checkout-head-differs-from-default-branch");
  if (input.checkout?.fixturePathsAbsent !== true)
    blockers.push("qualification-output-paths-already-exist");
  if (input.harness?.sourceTreeClean !== true)
    blockers.push("qualification-harness-is-not-committed");
  if (input.harness?.candidateInventorySha256 !== input.installedArtifact?.inventorySha256)
    blockers.push("installed-bundle-differs-from-qualification-candidate");
  if ((input.namespaceIssues ?? []).length > 0)
    blockers.push("qualification-namespace-already-exists");
  if (input.repository?.private !== true) blockers.push("qualification-repository-must-be-private");
  if (input.repository?.archived || input.repository?.permissions?.push !== true)
    blockers.push("repository-is-not-writable");
  if (input.branch?.protected) blockers.push("default-branch-is-protected");
  if ((input.rulesets ?? []).some((ruleset) => ruleset.enforcement === "active"))
    blockers.push("active-repository-ruleset");
  if ((input.openFactoryPulls ?? []).length > 0)
    blockers.push("prior-factory-pull-requests-remain-open");
  for (const plane of ["core", "graphql"])
    if (!Number.isSafeInteger(input.rateLimit?.[plane]?.remaining))
      blockers.push(`${plane}-quota-unavailable`);
    else if (input.rateLimit[plane].remaining < minimumGitHubQuota)
      blockers.push(`${plane}-quota-below-${minimumGitHubQuota}`);
  return {
    result: blockers.length === 0 ? "passed" : "blocked",
    blockers,
    requiredMinimumRemaining: { core: minimumGitHubQuota, graphql: minimumGitHubQuota },
  };
}

export function installedIdentity({
  manifest,
  portable,
  packageManifest,
  listed,
  pluginRoot,
  codexHome,
}) {
  assert.equal(manifest.name, "factory");
  assert.equal(portable.name, "factory");
  assert.equal(packageManifest.name, "@clockgrove/factory");
  const version = packageManifest.version;
  assert.equal(portable.version, version, "portable plugin and package versions differ");
  assert.equal(typeof version, "string");
  const suffix = manifest.version?.slice(version.length);
  assert.ok(
    manifest.version === version ||
      (manifest.version?.startsWith(version) && /^\+codex\.\d{14}$/.test(suffix)),
    "Codex manifest must match canonical version or its documented cachebuster",
  );
  const matches = (listed.installed ?? []).filter(
    (entry) =>
      entry.name === "factory" &&
      entry.installed === true &&
      entry.enabled === true &&
      entry.version === version &&
      entry.pluginId === `factory@${entry.marketplaceName}` &&
      typeof entry.marketplaceName === "string" &&
      /^[\w.-]+$/.test(entry.marketplaceName) &&
      resolve(pluginRoot) ===
        join(
          resolve(codexHome),
          "plugins",
          "cache",
          entry.marketplaceName,
          "factory",
          entry.version,
        ),
  );
  assert.equal(
    matches.length,
    1,
    "the exact cache path must match one enabled installed Factory marketplace/version receipt",
  );
  return {
    version,
    codexManifestVersion: manifest.version,
    pluginId: matches[0].pluginId,
  };
}

export function assertMcpSurface(tools) {
  for (const name of ["factory_run", "factory_status"]) {
    const definition = tools.find((tool) => tool.name === name);
    assert.ok(definition, `installed MCP server lacks ${name}`);
    for (const field of ["owner", "repo", "objectiveNumber"]) {
      assert.ok(definition.inputSchema.required?.includes(field), `${name} must require ${field}`);
    }
    if (name === "factory_run") {
      assert.ok(
        definition.inputSchema.properties?.repository,
        "factory_run must accept repository",
      );
      assert.ok(definition.inputSchema.properties?.policy, "factory_run must accept policy");
      assert.ok(
        definition.inputSchema.required?.includes("untilTerminal"),
        "factory_run must require untilTerminal",
      );
    }
  }
}

export function objectiveBodyFor(namespace) {
  const paths = qualificationPaths(namespace);
  return `Build three tiny dependency-free ESM modules with node:test tests.

Qualification namespace: ${namespace}
${qualificationNamespaceMarker(namespace)}

Compile three Work Items: two independent foundational modules, followed by one integration module that depends on both. Use native blocked-by relationships for that final Work Item. Keep each module and its own tests in its Work Item's allowed paths. Do not modify package.json or existing tests.

1. ${paths.sourceDirectory}/clamp.js exports clamp(value, min, max): return value bounded inclusively to min and max; throw RangeError when min > max. Add ${paths.testDirectory}/clamp.test.js covering below, within, above, equal bounds, and inverted bounds.
2. ${paths.sourceDirectory}/slugify.js exports slugify(text): lowercase ASCII text, replace each run of non-ASCII-alphanumeric characters with one hyphen, remove leading and trailing hyphens. Add ${paths.testDirectory}/slugify.test.js covering spaces, punctuation, repeated separators, empty input, and uppercase.
3. ${paths.sourceDirectory}/describe.js imports those two modules and exports describe(name, value, min, max), returning slugify(name) + ':' + clamp(value, min, max). Add ${paths.testDirectory}/describe.test.js: describe(' Hello World ', 12, 0, 10) equals 'hello-world:10', and inverted bounds propagate RangeError.

Use node --test ${paths.testDirectory}/<module>.test.js as each foundation's independent validation, and npm test for the final integration. No dependencies, services, credentials, cloud workers, workflows, or network access are needed by these modules. Preserve all existing modules and tests. Complete publication, independent validation, integration, and issue closure through Factory.`;
}

/** Legacy fixture constant retained for pure retry-boundary tests; live runs always use a namespace. */
export const objectiveBody = objectiveBodyFor("legacy-qualification");

export function assertRetryableObjective({ issue, actorId, status, children, events, runId }) {
  assert.equal(issue.state, "open", "retry requires an open Objective");
  assert.ok(!issue.pull_request, "retry target must be an issue");
  assert.equal(issue.body, objectiveBody, "retry Objective differs from this fixture");
  assert.ok(Number.isInteger(actorId) && actorId > 0, "authenticated actor ID required");
  assert.equal(issue.user?.id, actorId, "retry Objective belongs to another actor");
  assert.equal(status.objective?.number, issue.number, "status belongs to another Objective");
  assert.ok(typeof runId === "string" && runId.length > 0, "prior run ID required");
  assert.equal(status.run?.runId, runId, "latest run differs from acknowledged failed run");
  assert.equal(status.run?.state, "escalated", "retry requires a terminal escalated run");
  assert.equal(children.length, 0, "retry cannot replace existing Work Items");
  assert.equal(status.workItems?.length, 0, "retry cannot replace projected work");
  assert.equal(status.summary?.attempts?.total, 0, "retry cannot replace attempted work");
  const beforeCompilation = new Set([
    "FactoryRunStarted",
    "ControllerObserved",
    "DeliverySelected",
    "FactoryRunEscalated",
    "BudgetReserved",
    "BudgetReconciled",
  ]);
  assert.ok(
    events.some((event) => event.runId === runId && event.event === "FactoryRunEscalated"),
    "missing terminal failure receipt",
  );
  assert.ok(
    events.every((event) => beforeCompilation.has(event.event)),
    "retry requires failure before graph or execution receipts",
  );
}

export function boundedPolicy(delivery = "stacked-prs", maxModelTokens = maximumModelTokens) {
  assert.ok(["regular-prs", "stacked-prs"].includes(delivery), "unsupported delivery mode");
  assert.ok(
    Number.isSafeInteger(maxModelTokens) &&
      maxModelTokens >= minimumModelTokens &&
      maxModelTokens <= maximumModelTokens,
    "model-token limit is outside qualification bounds",
  );
  return {
    backendOrder: localBackends,
    maxParallel: 2,
    workItemTimeoutMinutes: 10,
    objectiveTimeoutMinutes: 45,
    maxAttemptsPerItem: 2,
    allowedPaidBackends: [],
    cloudFallback: "never",
    maxSandboxMinutes: 0,
    maxManagedAgentSessions: 0,
    trust: "explicitly_activated_repo",
    managementBackend: "codex-cli/local",
    allowedNetworkDestinations: ["api.openai.com"],
    economics: {
      maxModelTokens,
      maxSandboxMinutes: 0,
      maxManagedSessions: 0,
      minCloudTimeSavedMinutes: 0,
    },
    delivery: {
      mode: delivery,
      onUnavailable: "escalate",
      merge: "bottom-up",
    },
    capacity: {
      mode: "adaptive-local",
      local: {
        maxWorkers: 2,
        defaultCpu: 1,
        defaultMemoryMb: 2048,
        reserveCpu: 0.5,
        reserveMemoryMb: 1024,
        minimumFreeMemoryMb: 1024,
        maxLoadRatio: 0.9,
        maxMemoryUsageRatio: 0.85,
        sampleIntervalSeconds: 5,
        admissionCooldownSeconds: 10,
      },
    },
  };
}

export function assertCompletion(evidence, allowedBackends = localBackends) {
  const runId = evidence.runResult?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0, "explicit executed run ID required");
  assert.equal(evidence.status?.run?.runId, runId, "status belongs to another run");
  assert.equal(evidence.status?.summary?.runId, runId, "summary belongs to another run");
  assert.equal(evidence.status.run.state, "completed", "Supervisor did not complete");
  assert.equal(evidence.runResult.status, "completed", "executed run did not complete");
  assert.equal(evidence.status.summary.outcome, "completed", "summary did not complete");
  assert.equal(
    evidence.runResult.objective,
    evidence.objective.number,
    "executed Objective differs",
  );
  assert.equal(
    evidence.status.objective?.number,
    evidence.objective.number,
    "status Objective differs",
  );
  assert.equal(evidence.status.objective.closed, true, "status Objective remains open");
  assert.equal(evidence.objective.state, "closed", "Objective remains open");
  for (const [name, limit] of [
    ["children", 100],
    ["dependencies", 100],
    ["pulls", 1000],
    ["events", 50_000],
  ]) {
    assert.ok(
      Array.isArray(evidence[name]) && evidence[name].length <= limit,
      `unbounded or missing ${name} evidence`,
    );
  }
  assert.ok(evidence.children.length >= 3, "expected a multi-wave compiled graph");
  const childNumbers = new Set(evidence.children.map((child) => child.number));
  assert.equal(childNumbers.size, evidence.children.length, "duplicate Work Items");
  assert.ok(
    [...childNumbers].every((number) => Number.isSafeInteger(number) && number > 0),
    "invalid Work Item identity",
  );
  assert.ok(
    Array.isArray(evidence.status.workItems) && evidence.status.workItems.length <= 100,
    "unbounded or missing status Work Items",
  );
  assert.ok(
    evidence.dependencies.every(
      (entry) => Array.isArray(entry.blockedBy) && entry.blockedBy.length <= 100,
    ),
    "unbounded or missing dependency edges",
  );
  assert.deepEqual(
    evidence.status.workItems?.map((item) => item.number).sort((a, b) => a - b),
    [...childNumbers].sort((a, b) => a - b),
    "status differs from observed Work Item set",
  );
  assert.ok(
    evidence.status.workItems.every(
      (item) =>
        item.state === "done" && item.openDependencies?.length === 0 && !item.activeReservation,
    ),
    "Work Item status is not settled",
  );
  assert.equal(evidence.status.summary.attempts?.active, 0, "active attempts remain");
  assert.equal(evidence.status.capacity?.observed?.active, 0, "active capacity remains");
  assert.deepEqual(
    evidence.status.capacity?.activeReservations,
    [],
    "capacity reservations remain",
  );
  assert.deepEqual(
    evidence.dependencies.map((entry) => entry.workItem).sort((a, b) => a - b),
    [...childNumbers].sort((a, b) => a - b),
    "dependency observation is incomplete",
  );
  assert.ok(
    evidence.dependencies.some((entry) => entry.blockedBy.length >= 2),
    "missing two-parent join",
  );
  const events = evidence.events
    .filter((event) => event.runId === runId)
    .sort((a, b) => a.sequence - b.sequence);
  assert.ok(
    events.every(
      (event) =>
        event.objective === evidence.objective.number &&
        Number.isSafeInteger(event.sequence) &&
        event.sequence >= 0,
    ),
    "receipt Objective or sequence differs",
  );
  const completion = events.find((event) => event.event === "FactoryRunCompleted");
  assert.ok(
    !events.some((event) => ["FactoryRunEscalated", "FactoryRunCancelled"].includes(event.event)),
    "conflicting terminal run evidence",
  );
  assert.ok(
    events.some(
      (event) => event.event === "GraphProjected" && event.graphSize === childNumbers.size,
    ),
    "missing compilation receipt",
  );
  assert.ok(
    events.some((event) => event.event === "FactoryRunCompleted"),
    "missing completion receipt",
  );
  const starts = events.filter((event) => event.event === "AttemptStarted");
  assert.ok(starts.length >= 3, "fewer than three workers started");
  for (const start of starts) {
    assert.ok(childNumbers.has(start.workItem), "worker outside observed graph");
    assert.ok(
      allowedBackends.includes(start.backend),
      allowedBackends === localBackends
        ? "nonlocal worker used"
        : "worker outside qualified backend selection",
    );
  }
  const terminalAttempts = new Set([
    "AttemptSucceeded",
    "AttemptFailed",
    "AttemptTimedOut",
    "AttemptCancelled",
    "AttemptDeferred",
    "AttemptIntegrated",
  ]);
  const terminalSequences = new Map();
  const reconciledSequences = new Map();
  const attemptKey = (event) => JSON.stringify([event.workItem, event.attempt]);
  const reservationKey = (event, type) =>
    JSON.stringify([
      type,
      event.workItem,
      event.attempt,
      event.phase,
      ...(type === "capacity" ? [event.backend] : [event.unit, event.usageId ?? "default"]),
    ]);
  for (const event of events) {
    if (terminalAttempts.has(event.event)) terminalSequences.set(attemptKey(event), event.sequence);
    if (["BudgetReconciled", "CapacityReconciled"].includes(event.event))
      reconciledSequences.set(
        reservationKey(event, event.event === "CapacityReconciled" ? "capacity" : "budget"),
        event.sequence,
      );
  }
  for (const reserved of events.filter((event) =>
    ["AttemptReserved", "AttemptStarted"].includes(event.event),
  )) {
    assert.ok(
      terminalSequences.get(attemptKey(reserved)) > reserved.sequence,
      "attempt lacks terminal reconciliation",
    );
  }
  for (const reserved of events.filter((event) =>
    ["BudgetReserved", "CapacityReserved"].includes(event.event),
  )) {
    assert.ok(
      reconciledSequences.get(
        reservationKey(reserved, reserved.event === "CapacityReserved" ? "capacity" : "budget"),
      ) > reserved.sequence,
      `unreconciled ${reserved.event}`,
    );
  }
  for (const child of evidence.children) {
    assert.equal(child.state, "closed", `Work Item #${child.number} remains open`);
    const integrated = events.find(
      (event) => event.workItem === child.number && event.event === "AttemptIntegrated",
    );
    assert.ok(integrated, `Work Item #${child.number} missing integration receipt`);
    assert.ok(
      integrated.sequence < completion.sequence,
      "completion precedes Work Item integration",
    );
    assert.ok(
      starts.some(
        (start) =>
          start.workItem === child.number &&
          start.attempt === integrated.attempt &&
          start.sequence < integrated.sequence,
      ),
      "integrated attempt lacks its worker start",
    );
    const published = events.find(
      (event) =>
        event.workItem === child.number &&
        event.attempt === integrated.attempt &&
        event.event === "AttemptPublished",
    );
    assert.ok(
      published?.artifactDigest && published.headSha,
      "missing published artifact identity",
    );
    assert.ok(
      events.some(
        (event) =>
          event.workItem === child.number &&
          event.attempt === integrated.attempt &&
          event.event === "AttemptValidated" &&
          event.artifactDigest === published.artifactDigest,
      ),
      `Work Item #${child.number} lacks independent validation for its published artifact`,
    );
    const publication = events.find(
      (event) =>
        event.workItem === child.number &&
        event.attempt === integrated.attempt &&
        event.event === "PublicationRecorded" &&
        event.headSha === published.headSha,
    );
    assert.ok(publication?.pullRequest, "missing publication PR identity");
    assert.ok(
      evidence.pulls.some(
        (pull) =>
          pull.number === publication.pullRequest &&
          pull.state === "closed" &&
          pull.merged === true &&
          pull.head?.sha === published.headSha &&
          pull.merge_commit_sha === integrated.headSha,
      ),
      "integration receipt differs from GitHub merge commit",
    );
  }
  for (const entry of evidence.dependencies) {
    const dependencies = entry.blockedBy.map((dependency) => dependency.number);
    assert.equal(new Set(dependencies).size, dependencies.length, "duplicate dependency evidence");
    for (const parent of dependencies) {
      assert.ok(
        childNumbers.has(parent) && parent !== entry.workItem,
        "dependency outside graph or self dependency",
      );
      // Native-stack linear descendants may execute before their parent merges.
      // The fixture's multi-parent join must wait for every parent to integrate.
      if (dependencies.length < 2) continue;
      const integrated = events.find(
        (event) => event.event === "AttemptIntegrated" && event.workItem === parent,
      );
      assert.ok(
        starts
          .filter((start) => start.workItem === entry.workItem)
          .every((start) => integrated.sequence < start.sequence),
        "dependency join started before parent integration",
      );
    }
  }
  assert.ok(evidence.pulls.length >= 3, "expected published PRs");
  for (const pull of evidence.pulls)
    assert.equal(pull.merged, true, `PR #${pull.number} was not merged`);
}

/** Pure assessment of captured evidence, not a live authentication or provider-leak audit. */
export function assessCompletion(evidence) {
  try {
    assertQualificationCompletion(evidence);
    return { result: "passed", scope: "installed-local-objective-happy-path" };
  } catch (error) {
    return {
      result: ["escalated", "cancelled"].includes(evidence?.status?.run?.state)
        ? "failed"
        : "incomplete",
      scope: "installed-local-objective-happy-path",
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    };
  }
}

export function assertQualificationNamespace(evidence) {
  const namespace = qualificationNamespace(evidence.qualificationNamespace);
  const paths = qualificationPaths(namespace);
  assert.equal(
    evidence.preflight?.qualificationNamespace,
    namespace,
    "preflight namespace differs from executed qualification",
  );
  assert.deepEqual(
    evidence.fixturePaths,
    paths,
    "evidence paths differ from qualification namespace",
  );
  assert.deepEqual(evidence.preflight?.namespaceIssues, [], "qualification namespace collided");
  assert.ok(
    evidence.objective?.body?.includes(qualificationNamespaceMarker(namespace)) &&
      paths.files.every((path) => evidence.objective.body.includes(path)),
    "executed Objective does not retain its exact qualification namespace",
  );
}

export function assertQualificationCompletion(evidence) {
  assertCompletion(evidence);
  assertQualificationNamespace(evidence);
  assert.equal(
    evidence.preflight?.harness?.candidateInventorySha256,
    evidence.installedArtifact?.inventorySha256,
    "installed bundle is not the qualification candidate",
  );
  assert.deepEqual(
    evidence.finishedInstalledArtifact,
    evidence.installedArtifact,
    "installed bundle changed during qualification",
  );
  const runId = evidence.runResult.runId;
  const rawEvents = evidence.events.filter((event) => event.runId === runId);
  assert.ok(Number.isSafeInteger(evidence.actor?.id) && evidence.actor.id > 0, "actor ID missing");
  assert.ok(
    rawEvents.every(
      (event) =>
        event.authorId === evidence.actor.id &&
        event.author?.toLowerCase() === evidence.actor.login?.toLowerCase() &&
        typeof event.receiptUrl === "string" &&
        event.receiptUrl.startsWith(`https://github.com/${evidence.repository}/`),
    ),
    "run receipt lacks the authenticated GitHub actor or location",
  );
  const eventsBySequence = new Map();
  for (const event of rawEvents) {
    const envelope = { ...event };
    delete envelope.receiptUrl;
    delete envelope.author;
    delete envelope.authorId;
    const prior = eventsBySequence.get(event.sequence);
    if (prior)
      assert.deepEqual(prior, envelope, "same run sequence contains conflicting GitHub receipts");
    else eventsBySequence.set(event.sequence, envelope);
  }
  const events = [...eventsBySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const starts = events.filter((event) => event.event === "FactoryRunStarted");
  const completions = events.filter((event) => event.event === "FactoryRunCompleted");
  assert.equal(starts.length, 1, "exactly one authenticated run start is required");
  assert.equal(completions.length, 1, "exactly one authenticated run completion is required");
  assert.equal(starts[0].actor?.toLowerCase(), evidence.actor.login.toLowerCase());
  assert.equal(starts[0].repository?.toLowerCase(), evidence.repository.toLowerCase());
  assert.deepEqual(starts[0].policy?.backendOrder, localBackends, "run backend policy changed");
  assert.equal(starts[0].policy?.maxParallel, 2, "run parallel bound changed");
  assert.deepEqual(starts[0].policy?.allowedPaidBackends, [], "paid backend authority appeared");
  assert.equal(starts[0].policy?.maxSandboxMinutes, 0, "sandbox authority appeared");
  assert.equal(starts[0].policy?.maxManagedAgentSessions, 0, "managed authority appeared");
  assert.equal(
    starts[0].policy?.economics?.maxModelTokens,
    evidence.policy.economics.maxModelTokens,
    "durable model-token ceiling differs from requested policy",
  );
  assert.equal(evidence.status.run.policyDigest, starts[0].policyDigest, "status policy differs");

  assert.equal(evidence.children.length, 3, "qualification requires exactly three Work Items");
  const roots = evidence.dependencies.filter((entry) => entry.blockedBy.length === 0);
  const joins = evidence.dependencies.filter((entry) => entry.blockedBy.length === 2);
  assert.equal(roots.length, 2, "qualification requires exactly two independent roots");
  assert.equal(joins.length, 1, "qualification requires exactly one two-parent join");
  assert.deepEqual(
    joins[0].blockedBy.map((item) => item.number).sort((a, b) => a - b),
    roots.map((item) => item.workItem).sort((a, b) => a - b),
    "join does not depend on both independent roots",
  );
  const delivery = events.filter((event) => event.event === "DeliverySelected");
  assert.equal(delivery.length, 1, "exactly one delivery selection is required");
  assert.equal(delivery[0].requested, "stacked-prs", "native delivery was not requested");
  assert.equal(delivery[0].selected, "native-stacks", "native delivery was not selected");
  assert.ok(
    events
      .filter((event) => event.event === "PublicationRecorded")
      .every((event) => event.mode === "native-stacks"),
    "publication escaped native delivery mode",
  );
  const attemptStarts = events.filter((event) => event.event === "AttemptStarted");
  const attemptSuccesses = events.filter((event) => event.event === "AttemptSucceeded");
  for (const root of roots) {
    const start = attemptStarts.find((event) => event.workItem === root.workItem);
    assert.ok(start, `root Work Item #${root.workItem} did not start`);
    assert.ok(
      roots
        .filter((other) => other.workItem !== root.workItem)
        .every((other) =>
          attemptSuccesses.some(
            (success) => success.workItem === other.workItem && success.sequence > start.sequence,
          ),
        ),
      "independent sibling attempt lifecycles did not overlap",
    );
  }

  const modelReceipts = events.filter(
    (event) => event.event === "BudgetReconciled" && event.unit === "model_tokens",
  );
  assert.ok(modelReceipts.length >= 7, "too few attributable model-call receipts");
  assert.ok(
    modelReceipts.every(
      (event) => typeof event.usageId === "string" && event.usageId.length > 0 && event.amount > 0,
    ),
    "model usage lacks a positive, stable call identity",
  );
  const latestModelCalls = new Map(
    modelReceipts.map((event) => [
      JSON.stringify([
        event.workItem ?? "management",
        event.attempt ?? "management",
        event.phase,
        event.unit,
        event.usageId,
      ]),
      event,
    ]),
  );
  const modelTokens = [...latestModelCalls.values()].reduce((sum, event) => sum + event.amount, 0);
  const economics = evidence.status.summary.economics;
  assert.equal(economics.usage.model_tokens?.availability, "observed");
  assert.equal(
    economics.usage.model_tokens?.value,
    modelTokens,
    "status model usage is not attributable to the captured GitHub receipts",
  );
  assert.equal(
    economics.budgets.modelTokens?.value?.configured,
    evidence.policy.economics.maxModelTokens,
    "status model-token ceiling differs",
  );
  assert.equal(
    economics.budgets.modelTokens?.value?.committed,
    modelTokens,
    "status model-token commitment differs",
  );
  for (const unit of ["local_milliseconds", "validation_milliseconds"])
    assert.equal(
      economics.usage[unit]?.availability,
      "observed",
      `${unit} usage is not attributable to GitHub receipts`,
    );
}

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}
export async function main(qualification = {}) {
  const preflightOnly = process.env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT === "1";
  if (process.env.FACTORY_LIVE_OBJECTIVE !== "1" && !preflightOnly) {
    console.log(
      "Not exercised: set FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1 or FACTORY_LIVE_OBJECTIVE=1.",
    );
    return;
  }
  assert.equal(process.platform, "linux", "live Objective harness requires Linux");
  assert.equal(
    process.env.FACTORY_LIVE_OBJECTIVE_NUMBER,
    undefined,
    "installed qualification never revives a prior Objective",
  );
  assert.equal(
    process.env.FACTORY_LIVE_OBJECTIVE_PRIOR_RUN_ID,
    undefined,
    "installed qualification never reuses a terminal run",
  );
  const namespace = qualificationNamespace(
    qualification.namespace ?? process.env.FACTORY_LIVE_OBJECTIVE_NAMESPACE,
  );
  const fixturePaths = qualificationPaths(namespace);
  const runObjectiveBody = qualification.objectiveBody ?? objectiveBodyFor(namespace);
  assert.ok(
    runObjectiveBody.includes(qualificationNamespaceMarker(namespace)) &&
      fixturePaths.files.every((path) => runObjectiveBody.includes(path)),
    "Objective body does not retain its exact qualification namespace",
  );
  const repository = required("FACTORY_LIVE_OBJECTIVE_REPOSITORY");
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.notEqual(repository.toLowerCase(), "clockgrove/factory", "use a disposable repository");
  if (!preflightOnly)
    assert.equal(
      required("FACTORY_LIVE_OBJECTIVE_MUTATION_ACK"),
      repository,
      "acknowledge the exact disposable repository",
    );
  const [owner, repo] = repository.split("/");
  const checkout = realpathSync(required("FACTORY_LIVE_OBJECTIVE_CHECKOUT"));
  assert.ok(!checkout.startsWith("/mnt/"), "checkout must reside on the Linux filesystem");
  const checkoutClean = run("git", ["status", "--porcelain"], checkout) === "";
  const fixturePathsAbsent = fixturePaths.files.every((path) => !existsSync(join(checkout, path)));
  const origin = run("git", ["remote", "get-url", "origin"], checkout).replace(/\.git$/, "");
  assert.ok(
    origin === `https://github.com/${repository}` || origin === `git@github.com:${repository}`,
    "checkout origin differs from approved repository",
  );
  const codexHome = realpathSync(join(homedir(), ".codex"));
  if (process.env.CODEX_HOME)
    assert.equal(
      realpathSync(process.env.CODEX_HOME),
      codexHome,
      "unset non-Linux-home CODEX_HOME for installed qualification",
    );
  const listed = JSON.parse(run("codex", ["plugin", "list", "--json"], checkout));
  const pluginRoot = realpathSync(
    installedPluginPath({
      listed,
      codexHome,
      requestedRoot: process.env.FACTORY_LIVE_OBJECTIVE_PLUGIN_ROOT?.trim(),
    }),
  );
  assert.ok(
    pluginRoot.startsWith(`${join(codexHome, "plugins", "cache")}${sep}`),
    "use the plugin installed in this Codex home's cache",
  );
  assert.ok(
    pluginRoot !== sourceRoot && !pluginRoot.startsWith(`${sourceRoot}${sep}`),
    "development worktree is not an installation",
  );
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
  const identity = installedIdentity({
    manifest,
    listed,
    pluginRoot,
    codexHome,
    portable: JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8")),
    packageManifest: JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")),
  });
  const artifact = installedBundleIdentity(pluginRoot);
  assert.equal(artifact.version, identity.version, "installed inventory version differs");
  const candidateInventorySha256 = createHash("sha256")
    .update(readFileSync(join(sourceRoot, "dist", "bundle-inventory.json")))
    .digest("hex");
  const harness = {
    sourceCommit: run("git", ["rev-parse", "HEAD"], sourceRoot),
    sourceTreeClean:
      run("git", ["status", "--porcelain", "--untracked-files=no"], sourceRoot) === "",
    candidateInventorySha256,
  };
  const modelTokenCeiling =
    qualification.policy?.economics?.maxModelTokens ??
    modelTokenLimit(required("FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS"));
  const mcp = manifest.mcpServers?.factory;
  assert.equal(mcp?.command, "node");
  const token =
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || run("gh", ["auth", "token"], checkout);
  const octokit = new Octokit({
    auth: token,
    request: { headers: { "X-GitHub-Api-Version": "2026-03-10" } },
  });
  const request = (route, parameters = {}) =>
    octokit.request(route, { owner, repo, ...parameters });
  const list = async (route, parameters = {}, maximumEntries = Number.MAX_SAFE_INTEGER) => {
    const results = [];
    for (let page = 1; ; page++) {
      const { data } = await request(route, {
        ...parameters,
        per_page: 100,
        page,
      });
      assert.ok(Array.isArray(data), "paginated GitHub response must be an array");
      results.push(...data);
      assert.ok(results.length <= maximumEntries, "paginated GitHub observation bound exceeded");
      if (data.length < 100) return results;
    }
  };
  const info = (await request("GET /repos/{owner}/{repo}")).data;
  const actor = (await octokit.request("GET /user")).data;
  const base = (
    await request("GET /repos/{owner}/{repo}/commits/{ref}", {
      ref: info.default_branch,
    })
  ).data.sha;
  const checkoutHead = run("git", ["rev-parse", "HEAD"], checkout);
  const branch = (
    await request("GET /repos/{owner}/{repo}/branches/{branch}", { branch: info.default_branch })
  ).data;
  const rulesets = await list("GET /repos/{owner}/{repo}/rulesets");
  const workflows = (
    await request("GET /repos/{owner}/{repo}/actions/workflows", { per_page: 100 })
  ).data.workflows;
  const repositoryIssues = await list("GET /repos/{owner}/{repo}/issues", { state: "all" }, 1_000);
  const namespaceMarker = qualificationNamespaceMarker(namespace);
  const namespaceIssues = repositoryIssues
    .filter((issue) => !issue.pull_request && issue.body?.includes(namespaceMarker))
    .map((issue) => ({ number: issue.number, state: issue.state, title: issue.title }));
  const openFactoryPulls = (await list("GET /repos/{owner}/{repo}/pulls", { state: "open" }))
    .filter((pull) => pull.head?.ref?.startsWith("factory/"))
    .map((pull) => ({ number: pull.number, head: pull.head.ref, title: pull.title }));
  const rateLimit = (await octokit.request("GET /rate_limit")).data.resources;
  const preflight = {
    ...assessQualificationPreflight({
      checkout: {
        clean: checkoutClean,
        headMatchesDefault: checkoutHead === base,
        fixturePathsAbsent,
      },
      harness,
      installedArtifact: artifact,
      namespaceIssues,
      repository: info,
      branch,
      rulesets,
      workflows,
      openFactoryPulls,
      rateLimit,
    }),
    observedAt: new Date().toISOString(),
    repository,
    qualificationNamespace: namespace,
    fixturePaths,
    base,
    checkout: {
      clean: checkoutClean,
      head: checkoutHead,
      headMatchesDefault: checkoutHead === base,
      fixturePathsAbsent,
    },
    installedArtifact: artifact,
    harness,
    pluginId: identity.pluginId,
    codexManifestVersion: identity.codexManifestVersion,
    modelTokenCeiling: {
      configured: modelTokenCeiling,
      semantics: "observed stop-before-next-call threshold; concurrent calls may overshoot",
    },
    namespaceIssues,
    openFactoryPulls,
    enabledDynamicWorkflows: workflows
      .filter(
        (workflow) => workflow.state === "active" && workflow.path?.startsWith("dynamic/agents/"),
      )
      .map((workflow) => ({ name: workflow.name, path: workflow.path })),
    rateLimit: {
      core: rateLimit.core,
      graphql: rateLimit.graphql,
    },
  };
  const output = resolve(required("FACTORY_LIVE_OBJECTIVE_EVIDENCE"));
  mkdirSync(output, { recursive: true });
  const evidencePath = join(
    output,
    preflightOnly ? "qualification-preflight.json" : "objective-evidence.json",
  );
  const reservation = openSync(evidencePath, "wx", 0o600);
  closeSync(reservation);
  writeFileSync(evidencePath, `${JSON.stringify(preflight, null, 2)}\n`, { mode: 0o600 });
  if (preflightOnly) {
    console.log(`${preflight.result} installed Objective preflight; evidence: ${evidencePath}`);
    if (preflight.result !== "passed") process.exitCode = 2;
    return;
  }
  assert.equal(preflight.result, "passed", `preflight blocked: ${preflight.blockers.join(", ")}`);
  if (!qualification.policy)
    assert.equal(
      process.env.FACTORY_LIVE_OBJECTIVE_DELIVERY ?? "stacked-prs",
      "stacked-prs",
      "installed local qualification requires native delivery",
    );
  const policy =
    qualification.policy ??
    boundedPolicy(process.env.FACTORY_LIVE_OBJECTIVE_DELIVERY ?? "stacked-prs", modelTokenCeiling);
  const evidence = {
    schemaVersion: 1,
    scope: qualification.scope ?? "installed-local-objective-happy-path",
    startedAt: new Date().toISOString(),
    repository,
    qualificationNamespace: namespace,
    fixturePaths,
    base,
    pluginVersion: identity.version,
    codexManifestVersion: identity.codexManifestVersion,
    pluginId: identity.pluginId,
    installedArtifact: artifact,
    preflight,
    policy,
    actor: { id: actor.id, login: actor.login },
    objective: null,
    status: null,
    children: [],
    dependencies: [],
    events: [],
    pulls: [],
  };
  const save = () =>
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const client = new Client({
    name: "factory-live-objective",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", pluginRoot)),
    cwd: checkout,
    env: { ...process.env, GITHUB_TOKEN: token },
    stderr: "pipe",
  });
  const call = async (name, args, timeout = 60_000) => {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout,
      maxTotalTimeout: timeout,
    });
    assert.ok(!result.isError, `${name} failed: ${JSON.stringify(result.content)}`);
    return JSON.parse(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  };
  try {
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    assert.equal(
      client.getServerVersion()?.version,
      identity.version,
      "installed server version mismatch",
    );
    assertMcpSurface((await client.listTools()).tools);
    const hooks = { call, request, octokit, evidence, checkout, owner, repo };
    if (qualification.beforeRun) await qualification.beforeRun(hooks);
    evidence.objective = (
      await request("POST /repos/{owner}/{repo}/issues", {
        title: `Factory ${qualification.scope ?? "installed local Objective"} [${namespace}]`,
        body: runObjectiveBody,
      })
    ).data;
    await waitForCreatedObjectiveNamespace({ list, namespace, createdIssue: evidence.objective });
    save();
    console.log(
      `Created disposable Objective ${evidence.objective.html_url} for ${namespace}; installed Factory is running.`,
    );
    evidence.runResult = await call(
      "factory_run",
      {
        owner,
        repo,
        objectiveNumber: evidence.objective.number,
        repository: checkout,
        untilTerminal: true,
        policy: evidence.policy,
      },
      48 * 60_000,
    );
    evidence.status = await call("factory_status", {
      owner,
      repo,
      objectiveNumber: evidence.objective.number,
    });
    evidence.objective = (
      await request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        issue_number: evidence.objective.number,
      })
    ).data;
    evidence.children = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
      issue_number: evidence.objective.number,
    });
    for (const issue of [evidence.objective, ...evidence.children]) {
      const comments = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        issue_number: issue.number,
      });
      for (const comment of comments) {
        for (const match of (comment.body ?? "").matchAll(
          /<!-- clockgrove-factory:event\n([\s\S]*?)\n-->/g,
        ))
          evidence.events.push({
            ...JSON.parse(match[1]),
            receiptUrl: comment.html_url,
            author: comment.user?.login,
            authorId: comment.user?.id,
          });
      }
      if (issue.number !== evidence.objective.number)
        evidence.dependencies.push({
          workItem: issue.number,
          blockedBy: await list(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
            { issue_number: issue.number },
          ),
        });
    }
    const pullNumbers = new Set(
      evidence.events
        .filter((event) => event.runId === evidence.status.run.runId)
        .map((event) => event.pullRequest)
        .filter(Number.isInteger),
    );
    for (const number of pullNumbers)
      evidence.pulls.push(
        (
          await request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            pull_number: number,
          })
        ).data,
      );
    evidence.finishedInstalledArtifact = installedBundleIdentity(pluginRoot);
    assert.deepEqual(
      evidence.finishedInstalledArtifact,
      evidence.installedArtifact,
      "installed bundle changed during qualification",
    );
    if (qualification.afterRun) await qualification.afterRun(hooks);
    assertQualificationNamespace(evidence);
    const completionAssessment = (qualification.assessCompletion ?? assessCompletion)(evidence);
    assert.equal(completionAssessment.result, "passed", completionAssessment.reason);
    const verified = join(output, "merged-fixture");
    run("git", ["clone", "--depth", "1", `https://github.com/${repository}.git`, verified], output);
    evidence.finalSha = run("git", ["rev-parse", "HEAD"], verified);
    const finalDefaultSha = (
      await request("GET /repos/{owner}/{repo}/commits/{ref}", { ref: info.default_branch })
    ).data.sha;
    assert.equal(
      evidence.finalSha,
      finalDefaultSha,
      "verified clone is not the current default branch",
    );
    const joinWorkItem = evidence.dependencies.find(
      (entry) => entry.blockedBy.length === 2,
    ).workItem;
    const joinIntegration = evidence.events.find(
      (event) =>
        event.runId === evidence.runResult.runId &&
        event.event === "AttemptIntegrated" &&
        event.workItem === joinWorkItem,
    );
    assert.equal(
      evidence.finalSha,
      joinIntegration?.headSha,
      "default branch does not end at the dependent join integration",
    );
    evidence.testOutput = run("node", ["--test"], verified);
    evidence.behaviorOutput = run(
      "node",
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict'; import {clamp} from './${fixturePaths.sourceDirectory}/clamp.js'; import {slugify} from './${fixturePaths.sourceDirectory}/slugify.js'; import {describe} from './${fixturePaths.sourceDirectory}/describe.js'; assert.equal(clamp(-2,0,10),0); assert.equal(clamp(4,0,10),4); assert.equal(clamp(12,0,10),10); assert.throws(()=>clamp(1,2,0),RangeError); assert.equal(slugify(' Hello, WORLD!! '),'hello-world'); assert.equal(slugify('---'),''); assert.equal(describe(' Hello World ',12,0,10),'hello-world:10'); assert.throws(()=>describe('x',1,2,0),RangeError); console.log('Independent merged-artifact assertions passed for ${namespace}');`,
      ],
      verified,
    );
    evidence.completionAssessment = completionAssessment;
    evidence.result = "passed";
    evidence.finishedAt = new Date().toISOString();
    save();
    console.log(`Passed ${evidence.scope}; evidence: ${evidencePath}`);
  } catch (error) {
    evidence.result = "failed";
    evidence.failure = error instanceof Error ? error.message : String(error);
    if (evidence.objective) {
      try {
        evidence.status = await call("factory_status", {
          owner,
          repo,
          objectiveNumber: evidence.objective.number,
        });
      } catch {
        // The durable Objective URL remains available even if the MCP transport died.
      }
    }
    if (qualification.onFailure) {
      try {
        await qualification.onFailure({ call, request, octokit, evidence, checkout, owner, repo });
      } catch {
        evidence.cleanupObservation = {
          state: "unknown",
          reason: "cleanup observation unavailable; manual reconciliation required",
        };
      }
    }
    evidence.completionAssessment = (qualification.assessCompletion ?? assessCompletion)(evidence);
    save();
    throw error;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
