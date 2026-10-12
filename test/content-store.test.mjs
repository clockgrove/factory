import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  assertAccountingSealContent,
  buildAccountingSeal,
  readAccountingRecords,
} from "../dist/accounting.js";
import {
  authenticateAdaptiveContextPacket,
  buildAdaptiveContext,
} from "../dist/adaptive-context.js";
import { analyzeInteractions } from "../dist/analysis.js";
import {
  CaptureWriter,
  readInteractionContent,
  readInteractionMetadata,
} from "../dist/capture.js";
import {
  assertContextFactsResolved,
  initializeContextLookup,
  resolveContextRequests,
} from "../dist/compiler/context.js";
import { createPlanningContextResolver } from "../dist/compiler/context-runtime.js";
import { admitNativeReturn } from "../dist/compiler/native-return.js";
import { retainPlanningNativeReturn } from "../dist/compiler/recovery.js";
import { hydrateWorkerInputSources } from "../dist/compiler/sources.js";
import {
  factoryAuthorityDigest,
  factoryConfigDigest,
  stateRoot,
} from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import { linearDeliveryUnits } from "../dist/delivery/plan.js";
import {
  DiagnosticEmitter,
  readUsageSummaryEvents,
  summarizeDiagnosticUsage,
} from "../dist/diagnostics.js";
import {
  authenticateDiscoveryOutput,
  discoverRepository,
} from "../dist/discovery.js";
import { withGitHubRequestBudget } from "../dist/github-client.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { materializeGraphExpansion } from "../dist/graph-expansion.js";
import {
  decidePlaybook,
  learningDigest,
  prepareDreamInput,
  readDreamCheckpoint,
  readPinnedPlaybook,
  recordRetrospective,
  retainLearningMemory,
  savePlaybookProposal,
} from "../dist/learning.js";
import { captureAssetSets } from "../dist/media.js";
import {
  currentProcessSignal,
  linuxProcessIdentity,
  withProcessCancellation,
} from "../dist/process.js";
import {
  authenticateQueueOwnerReferences,
  bindProjectQueueRun,
  parseQueueRecord,
  retainProjectQueueOriginal,
} from "../dist/project-queue-state.js";
import {
  aggregateAcceptance,
  assertCompletedCoverage,
  assertExpansionCoverage,
  coverageObligations,
  objectiveCandidate,
} from "../dist/qa.js";
import {
  acceptForwardedCheckpointCompletion,
  awaitCheckpointAdmission,
  gitPersistenceStatus,
  inspectRecoveryCheckpoint,
  readRecoveryCheckpointBodies,
  readVerifiedRecoveryCheckpoint,
  synchronizeRecoveryCheckpoint,
  withRecoveryCheckpointClosureReads,
  withRecoveryCheckpointCommandOperation,
  withRecoveryCheckpointControllerVerification,
  withRecoveryCheckpointOperation,
  withRecoveryCheckpointScope,
  writeRecoveryCheckpointBodies,
} from "../dist/recovery-checkpoint.js";
import {
  buildRecoveryCheckpointClosure,
  describeMemoryBodyReferences,
} from "../dist/recovery-checkpoint-closure.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import {
  LocalRepositoryMemory,
  retainPlanningSourceMemory,
} from "../dist/repository-memory.js";
import { buildMemoryLearningClosure } from "../dist/repository-memory-transfer.js";
import { objectiveReviewEvidence } from "../dist/result-evidence.js";
import { selectedDiscoveryInputs } from "../dist/runner/discovery.js";
import {
  assertWorkRoutingState,
  authenticateWorkRouting,
  settleWorkRouting,
} from "../dist/runner/routing.js";
import {
  pendingItemBlocker,
  rankPending,
  readyItems,
  schedulingObservations,
  validateAndOrderGraph,
} from "../dist/scheduler.js";
import { parseFactoryState } from "../dist/state.js";
import {
  readContinuation,
  reconcileRestoredContinuation,
  restoreRecoveryCheckpoint,
  saveState,
  statePath,
} from "../dist/state-store.js";

test("disk content survives storage and materialization, and corruption is refused", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-content-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source.bin");
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  writeFileSync(source, bytes);
  const store = new LocalContentStore(join(root, "objects"));
  const ref = await store.put(Readable.toWeb(createReadStream(source)), {
    mediaType: "application/octet-stream",
  });
  await store.verify(ref);
  const copy = join(root, "copy.bin");
  await store.materialize(ref, copy);
  assert.equal(ref.bytes, bytes.length);
  assert.deepEqual(readFileSync(copy), bytes);
  writeFileSync(
    join(root, "objects", ref.digest.slice(0, 2), ref.digest),
    "corrupted",
  );
  await assert.rejects(store.verify(ref), /digest verification/);
});

test("repository memory verifies complete retained bodies and rebuilds scoped SQLite search after workspace disposal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const repository = "fixture/memory";
  const state = stateRoot(repository);
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const remote = join(root, "archive.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(
    join(checkout, "api.md"),
    "Complete reference for the orchard API.\n",
  );
  git("add", "api.md");
  git("commit", "-m", "Document the API");
  const treeSha = git("rev-parse", "HEAD^{tree}");
  const store = new LocalContentStore(join(state, "content"));
  const source = readFileSync(join(checkout, "api.md"));
  const sourceRef = store.putBytes(source, { mediaType: "text/markdown" });
  const retainedSourcePath = join(
    state,
    "content",
    sourceRef.digest.slice(0, 2),
    sourceRef.digest,
  );
  const retainedSourceIdentity = statSync(retainedSourcePath).ino;
  assert.deepEqual(
    store.putBytes(source, { mediaType: sourceRef.mediaType }),
    sourceRef,
  );
  assert.equal(statSync(retainedSourcePath).ino, retainedSourceIdentity);
  assert.deepEqual(store.readBytes(sourceRef), source);
  chmodSync(retainedSourcePath, 0o644);
  try {
    assert.throws(
      () => store.putBytes(source, { mediaType: sourceRef.mediaType }),
      /owned private regular file/,
    );
  } finally {
    chmodSync(retainedSourcePath, 0o600);
  }
  const changedSource = Buffer.from(source);
  changedSource[0] ^= 1;
  writeFileSync(retainedSourcePath, changedSource);
  try {
    assert.throws(
      () => store.putBytes(source, { mediaType: sourceRef.mediaType }),
      /digest verification/,
    );
  } finally {
    writeFileSync(retainedSourcePath, source);
  }
  rmSync(retainedSourcePath);
  symlinkSync(join(checkout, "api.md"), retainedSourcePath);
  try {
    assert.throws(
      () => store.putBytes(source, { mediaType: sourceRef.mediaType }),
      /regular file|symlink/,
    );
  } finally {
    rmSync(retainedSourcePath);
    assert.deepEqual(
      store.putBytes(source, { mediaType: sourceRef.mediaType }),
      sourceRef,
    );
  }
  const memory = new LocalRepositoryMemory(state, "fixture/memory", store);
  const record = {
    schemaVersion: 1,
    repository: "fixture/memory",
    visibility: "repository",
    kind: "reference",
    producer: {
      objective: 1,
      runId: git("rev-parse", "HEAD"),
      status: "observed",
    },
    createdAt: new Date().toISOString(),
    authority: "observation",
    summary: "Complete orchard API reference",
    bodies: [
      { role: "api-documentation", ref: sourceRef, availability: "retained" },
    ],
    sources: [
      {
        identity: "repository:api.md",
        version: treeSha,
        apiVersion: "1",
        dependencyVersion: "1.2",
        retrievedAt: new Date().toISOString(),
        complete: true,
        ref: sourceRef,
      },
    ],
    bindings: {
      treeSha,
      paths: [
        {
          path: "api.md",
          digest: createHash("sha256").update(source).digest("hex"),
        },
      ],
      environment: { runtime: process.version },
    },
    validity: { state: "current", conditions: ["orchard API 1"] },
    supersedes: [],
  };
  const binding = memory.retain(record);
  assert.equal(memory.catalogStatus, "ready");
  assert.equal(existsSync(join(state, "memory", "catalog.sqlite")), true);
  assert.deepEqual(
    memory.retain({ ...record, createdAt: "2000-01-01T00:00:00.000Z" }),
    binding,
  );
  const second = memory.retain({
    ...record,
    sources: [
      { ...record.sources[0], identity: "authorized-document:orchard-api" },
    ],
  });
  assert.notEqual(second.id, binding.id);
  assert.equal(second.manifestRef.bytes > 0, true);
  assert.equal(
    memory.metadata({
      access: {
        repository: "different/repository",
        visibility: ["repository", "private"],
      },
      limit: 10,
    }).entries.length,
    0,
  );

  const secretRef = store.putBytes(
    Buffer.from("Private unrelated orchard debugging notes"),
    { mediaType: "text/plain" },
  );
  const denied = memory.retain({
    ...record,
    visibility: "private",
    producer: { ...record.producer, objective: 2 },
    kind: "hypothesis",
    summary: "Private unrelated debugging notes",
    bodies: [
      { role: "private-history", ref: secretRef, availability: "retained" },
    ],
    sources: [],
    bindings: {},
  });
  const access = { repository: "fixture/memory", visibility: ["repository"] };
  const applicability = {
    treeSha,
    paths: { "api.md": sourceRef.digest },
    environment: { runtime: process.version },
    conditions: ["orchard API 1"],
    sources: {
      "repository:api.md": {
        version: treeSha,
        apiVersion: "1",
        dependencyVersion: "1.2",
      },
      "authorized-document:orchard-api": {
        version: treeSha,
        apiVersion: "1",
        dependencyVersion: "1.2",
      },
    },
  };
  assert.equal(memory.read({ access, id: denied.id }), undefined);
  const current = memory.read({ access, id: binding.id, applicability });
  assert.equal(current.disposition, "current");
  assert.equal(current.content[0].text, source.toString("utf8"));
  assert.equal(
    memory.read({ access, id: binding.id }).disposition,
    "historical",
  );
  assert.equal(
    memory.read({
      access,
      id: binding.id,
      applicability: { ...applicability, treeSha: "f".repeat(40) },
    }).disposition,
    "stale",
  );
  assert.equal(
    memory.read({
      access,
      id: binding.id,
      applicability: {
        ...applicability,
        sources: {
          "repository:api.md": {
            version: treeSha,
            apiVersion: "2",
            dependencyVersion: "1.2",
          },
        },
      },
    }).disposition,
    "stale",
  );
  const bounded = memory.read({
    access,
    id: binding.id,
    applicability,
    maxBytes: source.length - 1,
  });
  assert.equal(bounded.disposition, "incomplete");
  assert.equal(bounded.content.length, 0);
  assert.match(bounded.gaps.join("\n"), /complete body exceeds/);
  const missing = memory.retain({
    ...record,
    kind: "episode",
    bodies: [{ role: "legacy-source", availability: "missing-legacy" }],
    sources: [{ identity: "legacy-native-session", complete: false }],
  });
  assert.equal(
    memory.read({ access, id: missing.id, applicability }).disposition,
    "unavailable",
  );
  const superseding = memory.retain({
    ...record,
    summary: "Updated complete orchard API reference",
    supersedes: [binding.id],
  });
  assert.equal(
    memory.read({ access, id: binding.id, applicability }).disposition,
    "historical",
  );
  assert.equal(
    memory.read({ access, id: superseding.id, applicability }).disposition,
    "current",
  );

  const metadata = memory.metadata({
    access: {
      repository: "fixture/memory",
      visibility: ["repository", "private"],
    },
    scope: { objective: 1, paths: ["api.md"] },
    limit: 20,
    applicability,
  });
  assert.equal(metadata.complete, true);
  assert.equal(
    metadata.entries.some((entry) => entry.binding.id === denied.id),
    false,
  );
  writeFileSync(
    join(state, "content", secretRef.digest.slice(0, 2), secretRef.digest),
    "corrupt excluded history",
  );
  const results = memory.search({
    access: {
      repository: "fixture/memory",
      visibility: ["repository", "private"],
    },
    scope: { objective: 1, paths: ["api.md"] },
    query: "orchard",
    limit: 1,
    applicability,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].record.producer.objective, 1);
  assert.equal(results[0].disposition, "current");
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(state, "memory", `catalog.sqlite${suffix}`), { force: true });
  const restarted = new LocalRepositoryMemory(state, "fixture/memory");
  assert.equal(restarted.rebuild().records, 5);
  assert.equal(restarted.catalogStatus, "ready");
  assert.equal(
    restarted.read({ access, id: second.id, applicability }).content[0].text,
    source.toString("utf8"),
  );
  writeFileSync(
    join(state, "content", sourceRef.digest.slice(0, 2), sourceRef.digest),
    "corrupt API reference",
  );
  assert.equal(
    restarted.read({ access, id: second.id, applicability }).disposition,
    "unavailable",
  );
  chmodSync(join(state, "memory", "catalog.sqlite"), 0o644);
  assert.throws(
    () => restarted.search({ access, query: "orchard", limit: 1 }),
    /owned private file/,
  );
  // Preserve actual cancelled observations and an explicit operator-reviewed
  // advisory revision. No model call or implementation acceptance is invented.
  chmodSync(join(state, "memory", "catalog.sqlite"), 0o600);
  writeFileSync(
    join(state, "content", sourceRef.digest.slice(0, 2), sourceRef.digest),
    source,
    { mode: 0o600 },
  );
  // Two authentic imported manifests can describe the same observation at
  // different times. Restoration preserves both immutable identities.
  const alternateBytes = Buffer.from(
    store
      .readBytes(binding.manifestRef)
      .toString("utf8")
      .replace(
        `"createdAt":${JSON.stringify(record.createdAt)}`,
        '"createdAt":"2000-01-01T00:00:00.000Z"',
      ),
  );
  const alternateRef = store.putBytes(alternateBytes, {
    mediaType: "application/json",
  });
  const alternateBinding = {
    id: alternateRef.digest,
    manifestRef: alternateRef,
  };
  assert.notEqual(alternateBinding.id, binding.id);
  restarted.installExact(alternateBinding, alternateBytes, access);
  const selection = { model: "unused-local-check", reasoningEffort: "low" };
  const config = {
    schemaVersion: 1,
    repository,
    checkout,
    planning: {
      kind: "codex-sdk",
      planner: selection,
      reviewer: selection,
    },
    execution: {
      kind: "local",
      concurrency: 1,
      harness: { kind: "codex-sdk", ...selection },
    },
    delivery: { kind: "regular" },
    policy: { network: "off", allowedSecretNames: [] },
    gitPersistence: {
      remote,
      ref: "refs/heads/factory-history",
      visibility: "private",
      scope: "private-history",
      maxBytes: 16 * 1024 * 1024,
      maxFiles: 4096,
      timeoutMs: 1000,
      coalesceMs: 0,
    },
  };
  const cancelled = {
    schemaVersion: 8,
    kind: "preparing",
    repository,
    objective: 1,
    runId: "cancelled-orchard-documentation",
    configDigest: factoryConfigDigest(config),
    baseSha: git("rev-parse", "HEAD"),
    objectiveBodyDigest: learningDigest("Observe orchard API documentation"),
    autonomy: resolveAutonomy(),
    capacity: { concurrency: 1 },
    charges: {},
    issueByItemId: {},
    coordinator: {
      mode: "paused",
      phase: "planning",
      phaseStartedAt: new Date().toISOString(),
    },
    cancelledAt: new Date().toISOString(),
  };
  saveState(statePath(repository, 1), cancelled);
  // These are observations of the actual local Git read, with no provider
  // accounting claimed. Optional text retention uses the existing capture budget.
  const observed = [];
  const diagnostics = new DiagnosticEmitter(repository, 1);
  const captureContext = {
    repository,
    objective: 1,
    runId: cancelled.runId,
    invocationId: "actual-local-git-source-read",
    providerAttempt: 1,
    phase: "integration",
    adapter: "local-process",
    configured: { provider: "not-invoked", model: "none" },
    configDigest: cancelled.configDigest,
    sourceDigest: sourceRef.digest,
  };
  const emitCapture = (capture) => {
    observed.push(capture);
    diagnostics.emit({
      operation: "interaction",
      outcome: "observed",
      capture,
    });
  };
  const captured = new CaptureWriter(
    captureContext,
    { enabled: true, retainInRecovery: true, maxBytesPerInvocation: 40 },
    ["Complete reference"],
    emitCapture,
  );
  captured.record({ kind: "request" }, () => ({
    command: "git show HEAD:api.md",
  }));
  const started = performance.now();
  const observedSource = execFileSync("git", [
    "-C",
    checkout,
    "show",
    "HEAD:api.md",
  ]);
  const durationMs = performance.now() - started;
  assert.deepEqual(observedSource, source);
  captured.record(
    {
      kind: "response",
      boundary: {
        source: "factory-process",
        event: "process-exit",
        elapsedMs: durationMs,
        exitCode: 0,
      },
    },
    () => ({ text: observedSource.toString("utf8") }),
  );
  const replicaOnly = new CaptureWriter(
    { ...captureContext, invocationId: "actual-local-replica-only" },
    { enabled: true, maxBytesPerInvocation: 1024 },
    [],
    emitCapture,
  );
  replicaOnly.record(
    { kind: "outcome", outcome: { stage: "protocol", status: "completed" } },
    () => ({ text: observedSource.toString("utf8") }),
  );
  assert.equal(observed[1].content.redacted, true);
  assert.equal(observed[1].content.truncated, true);
  const retainedCapture = observed[1].content.reference;
  const retainedText = readInteractionContent(repository, retainedCapture);
  assert.equal(retainedText.includes("Complete reference"), false);
  assert.equal(observed[2].content.reference.payload, undefined);
  const accountingBefore = readAccountingRecords(repository, 1);
  const accountingSeal = buildAccountingSeal(
    repository,
    1,
    cancelled.runId,
    [],
  );
  assert.equal(accountingSeal.coverage.wholeWorkflowTotal, "unproven");
  assert.equal(accountingSeal.coverage.usageUnavailableRecords > 0, true);
  assert.equal(
    accountingSeal.coverage.usageAvailableRecords +
      accountingSeal.coverage.usageUnavailableRecords,
    accountingBefore.length,
  );
  const usageBefore = summarizeDiagnosticUsage(
    readUsageSummaryEvents(repository, 1),
  );
  assert.equal(
    usageBefore.combinedUsage.coverage.byCategory.totalTokens,
    "unavailable",
  );
  const metadataBefore = readInteractionMetadata(repository, 1);
  assert.equal(
    metadataBefore.find((entry) => entry.recordId === observed[1].recordId)
      .boundary.elapsedMs,
    durationMs,
  );
  const interactionBefore = analyzeInteractions(metadataBefore, [], {});
  // Capture a declaration over the same actual source read, then retain the
  // resulting observation as historical memory before its staging is removed.
  const declared = [
    {
      id: "source-documentation",
      members: [
        {
          role: "documentation",
          path: ".factory-media/source/api.md",
          mediaType: "text/markdown",
          destination: "api.md",
        },
      ],
      provenance: {
        source: "api.md",
        rights: "fixture authored for this test",
        visibility: "repository",
        lineage: ["api.md"],
      },
    },
  ];
  const declarationBytes = Buffer.from(
    `${JSON.stringify({ sets: declared }, null, 2)}\n`,
  );
  mkdirSync(join(checkout, ".factory-media", "source"), { recursive: true });
  writeFileSync(
    join(checkout, ".factory-media", "source", "api.md"),
    observedSource,
  );
  writeFileSync(join(checkout, ".factory-assets.json"), declarationBytes);
  let checkpointedAssets;
  const capturedAssets = await captureAssetSets(
    store,
    checkout,
    { id: "documentation", ownedPaths: ["api.md"] },
    declared,
    { harness: captureContext.invocationId, exitCode: 0 },
    undefined,
    undefined,
    undefined,
    (sets) => {
      assert.equal(existsSync(join(checkout, ".factory-media")), true);
      for (const set of sets)
        for (const member of set.members)
          assert.deepEqual(store.readBytes(member.ref), observedSource);
      checkpointedAssets = sets;
    },
  );
  assert.deepEqual(checkpointedAssets, capturedAssets);
  assert.deepEqual(
    store.readBytes(capturedAssets[0].manifestRef),
    declarationBytes,
  );
  const assetObservationBytes = Buffer.from(
    JSON.stringify({ assets: capturedAssets }),
  );
  const assetObservationRef = store.putBytes(assetObservationBytes, {
    mediaType: "application/json",
  });
  const originalDescription = describeMemoryBodyReferences(
    "attempt-observation",
    assetObservationBytes,
  );
  assert.equal(
    originalDescription.contentRefs.some(
      (ref) => ref.digest === capturedAssets[0].manifestRef.digest,
    ),
    true,
  );
  const legacyAssets = structuredClone(capturedAssets);
  delete legacyAssets[0].manifestRef;
  const legacyDescription = describeMemoryBodyReferences(
    "attempt-observation",
    Buffer.from(JSON.stringify({ assets: legacyAssets })),
  );
  assert.equal(legacyDescription.gaps[0].availability, "missing-legacy");
  assert.equal(legacyDescription.gaps[0].required, false);
  const mismatchedAssets = structuredClone(capturedAssets);
  mismatchedAssets[0].manifestRef = sourceRef;
  assert.throws(
    () =>
      describeMemoryBodyReferences(
        "attempt-observation",
        Buffer.from(JSON.stringify({ assets: mismatchedAssets })),
      ),
    /differs from its original declaration/,
  );
  memory.retain({
    ...record,
    kind: "episode",
    summary:
      "The actual local source read retains its original asset declaration",
    bodies: [
      {
        role: "attempt-observation",
        ref: assetObservationRef,
        availability: "retained",
      },
    ],
  });
  rmSync(join(checkout, ".factory-assets.json"));
  assert.equal(existsSync(join(checkout, ".factory-media")), false);
  const episode = recordRetrospective(config, 1);
  assert.equal(episode.outcome, "cancelled");
  const prepared = await prepareDreamInput(config, { budgetBytes: 16384 });
  assert.equal(prepared.episodes[0].episode.outcome, "cancelled");
  const proposal = {
    schemaVersion: 1,
    repository,
    configDigest: factoryConfigDigest(config),
    id: prepared.checkpoint.id,
    createdAt: prepared.checkpoint.createdAt,
    parent: null,
    budgetBytes: 16384,
    sources: prepared.sources,
    draft: {
      lessons: [
        {
          text: "The cancelled observation retained the orchard API documentation.",
          sources: prepared.sources,
          previousLessons: [],
        },
      ],
      summaries: [],
      contradictions: [],
      retired: [],
    },
    invocationId: prepared.checkpoint.invocationId,
    generatedResponse: null,
    consolidation: {
      checkpointId: prepared.checkpoint.id,
      checkpointDigest: prepared.checkpointDigest,
    },
  };
  const proposalPath = savePlaybookProposal(proposal);
  const reviewed = JSON.parse(readFileSync(proposalPath, "utf8"));
  reviewed.draft.lessons[0].text =
    "The cancelled orchard observation preserves documentation without granting acceptance.";
  const reviewedPath = join(root, "reviewed-draft.json");
  writeFileSync(reviewedPath, `${JSON.stringify(reviewed, null, 2)}\n`, {
    mode: 0o600,
  });
  const reviewedDigest = learningDigest(readFileSync(reviewedPath));
  assert.notEqual(reviewedDigest, learningDigest(readFileSync(proposalPath)));
  const approved = decidePlaybook(
    config,
    reviewedPath,
    reviewedDigest,
    "Fixture operator",
    "approve",
  );
  const pin = {
    version: approved.version,
    digest: learningDigest(readFileSync(approved.path)),
  };
  const originalPlaybook = readPinnedPlaybook(repository, pin);
  retainLearningMemory(repository);
  const privateAccess = { repository, visibility: ["repository", "private"] };
  const selectedClosure = await buildMemoryLearningClosure({
    repository,
    root: state,
    access: privateAccess,
    scope: { objective: 1, paths: ["api.md"] },
  });
  assert.equal(
    selectedClosure.files.some((file) => file.path.includes(denied.id)),
    false,
  );
  writeFileSync(
    join(state, "content", secretRef.digest.slice(0, 2), secretRef.digest),
    "Private unrelated orchard debugging notes",
    { mode: 0o600 },
  );
  const buildClosure = () =>
    buildRecoveryCheckpointClosure({
      config,
      scope: "private-history",
    });
  const closure = await buildClosure();
  // A linked checkout has a .git file; packing uses its common object storage.
  const linkedCheckout = join(root, "linked-checkpoint");
  git("worktree", "add", "--detach", linkedCheckout, "HEAD");
  try {
    const objects = realpathSync(
      git("rev-parse", "--path-format=absolute", "--git-path", "objects"),
    );
    const originalEntries = readdirSync(objects).sort();
    const linkedClosure = await buildRecoveryCheckpointClosure({
      config: { ...config, checkout: linkedCheckout },
      scope: "private-history",
    });
    assert.deepEqual(
      linkedClosure.files
        .filter((file) => file.kind === "git-pack")
        .map((file) => file.ref),
      closure.files
        .filter((file) => file.kind === "git-pack")
        .map((file) => file.ref),
    );
    assert.deepEqual(readdirSync(objects).sort(), originalEntries);
  } finally {
    git("worktree", "remove", linkedCheckout);
  }
  const knowledge = await buildRecoveryCheckpointClosure({
    config,
    scope: "repository-knowledge",
  });
  assert.equal(
    knowledge.files.some((file) => file.path.startsWith("accounting/")),
    false,
  );
  assert.equal(
    knowledge.contentRefs.some(
      (ref) => ref.digest === retainedCapture.payload.digest,
    ),
    false,
  );
  assert.equal(
    closure.files.some((file) => file.kind === "git-pack"),
    true,
  );
  assert.equal(
    closure.files.some((file) => file.path.startsWith("accounting/")),
    true,
  );
  assert.equal(
    closure.files.some((file) => file.path.startsWith("captures/")),
    false,
  );
  assert.equal(
    closure.contentRefs.some(
      (ref) => ref.digest === retainedCapture.payload.digest,
    ),
    true,
  );
  assert.equal(
    closure.contentRefs.some(
      (ref) => ref.digest === capturedAssets[0].manifestRef.digest,
    ),
    true,
  );
  for (const kind of [
    "episodes",
    "snapshots",
    "proposals",
    "reviews",
    "versions",
    "checkpoints",
  ])
    assert.equal(
      closure.files.some((file) => file.path.startsWith(`learning/${kind}/`)),
      true,
    );
  const actualOwner = new AbortController();
  const firstCheckpoint = await withProcessCancellation(
    actualOwner.signal,
    async () => {
      const acknowledged = await withGitHubRequestBudget(1, () =>
        synchronizeRecoveryCheckpoint(config, {
          reason: "explicit",
          buildClosure,
        }),
      );
      assert.equal(currentProcessSignal(), actualOwner.signal);
      assert.equal(actualOwner.signal.aborted, false);
      return acknowledged;
    },
  );
  assert.equal(firstCheckpoint.status, "acknowledged");
  const firstInspection = await inspectRecoveryCheckpoint(config);
  const uniqueBodies = new Map(
    closure.contentRefs.map((ref) => [ref.digest, ref.bytes]),
  );
  assert.equal(
    firstInspection.current.uniqueBodyBytes,
    [...uniqueBodies.values()].reduce((total, bytes) => total + bytes, 0),
  );
  assert.equal(firstInspection.current.logicalFiles, closure.files.length);
  assert.equal(firstInspection.current.manifestBytes > 0, true);
  assert.equal(firstInspection.storage, "git-logical-bytes");
  assert.deepEqual(firstInspection.capacity.cancellationAncestry, {
    availability: "unavailable",
    reason: "not-traversed",
  });
  assert.equal(
    firstInspection.capacity.current.bytes,
    firstInspection.current.manifestBytes +
      firstInspection.current.uniqueBodyBytes,
  );
  assert.equal(
    firstInspection.capacity.current.fileHeadroom,
    config.gitPersistence.maxFiles -
      firstInspection.current.logicalFiles -
      firstInspection.current.uniqueBodies -
      1,
  );
  // Round-trip the workflow's retained originals and an opaque body through
  // the same batch I/O used by full archive publication and verification.
  const opaque = Buffer.alloc(1024 * 1024, 0xff);
  opaque.set([0xff, 0x00, 0x0a, 0x80]);
  const opaqueRef = await store.put(Readable.toWeb(Readable.from([opaque])), {
    mediaType: "application/octet-stream",
  });
  const opaquePath = join(
    state,
    "content",
    opaqueRef.digest.slice(0, 2),
    opaqueRef.digest,
  );
  const opaqueIdentity = statSync(opaquePath).ino;
  assert.deepEqual(
    store.putBytes(opaque, { mediaType: opaqueRef.mediaType }),
    opaqueRef,
  );
  assert.equal(statSync(opaquePath).ino, opaqueIdentity);
  assert.deepEqual(store.readBytes(opaqueRef), opaque);
  const batchObjects = join(root, "batch-objects.git");
  execFileSync(
    "git",
    ["init", "--bare", "--object-format=sha256", batchObjects],
    { stdio: "pipe" },
  );
  const batchBodies = [
    ...closure.contentRefs.map((ref) => ({ ref, bytes: store.readBytes(ref) })),
    { ref: opaqueRef, bytes: opaque },
  ];
  const batchEntries = writeRecoveryCheckpointBodies(
    batchObjects,
    config.gitPersistence,
    batchBodies,
  );
  const readBodies = readRecoveryCheckpointBodies(
    batchObjects,
    config.gitPersistence,
    batchEntries,
  );
  for (const { ref, bytes } of batchBodies)
    assert.deepEqual(readBodies.get(ref.digest), bytes);
  assert.equal(firstInspection.reachableHistory.availability, "available");
  assert.equal(
    firstInspection.reachableHistory.logicalObjectBytes >
      firstInspection.current.uniqueBodyBytes,
    true,
  );
  const unchangedCheckpoint = await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  assert.equal(unchangedCheckpoint.status, "acknowledged");
  assert.equal(
    unchangedCheckpoint.lastAcknowledged.commitSha,
    firstCheckpoint.lastAcknowledged.commitSha,
  );
  assert.deepEqual(readFileSync(join(checkout, "api.md")), source);
  // A failed verification of an acknowledged original remains failed until
  // explicit synchronization verifies the restored exact bytes and same ACK.
  const beforeRevalidationJournal = JSON.parse(
    readFileSync(join(state, "recovery", "checkpoint.json"), "utf8"),
  );
  const corruptAcknowledgedSource = Buffer.from(source);
  corruptAcknowledgedSource[0] ^= 1;
  writeFileSync(retainedSourcePath, corruptAcknowledgedSource);
  try {
    await assert.rejects(
      synchronizeRecoveryCheckpoint(config, {
        reason: "explicit",
        buildClosure,
      }),
      /digest verification|failed exact verification/,
    );
    const failedRevalidation = gitPersistenceStatus(config);
    assert.equal(failedRevalidation.status, "failed");
    assert.equal(failedRevalidation.protectedContinuation, false);
    assert.equal(failedRevalidation.pendingChanges, false);
    assert.deepEqual(
      failedRevalidation.lastAcknowledged,
      unchangedCheckpoint.lastAcknowledged,
    );
  } finally {
    writeFileSync(retainedSourcePath, source);
  }
  const restoredRevalidation = await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  assert.equal(restoredRevalidation.status, "acknowledged");
  assert.equal(restoredRevalidation.protectedContinuation, true);
  assert.equal(restoredRevalidation.pendingChanges, false);
  assert.deepEqual(
    restoredRevalidation.lastAcknowledged,
    unchangedCheckpoint.lastAcknowledged,
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(state, "recovery", "checkpoint.json"), "utf8"),
    ),
    beforeRevalidationJournal,
  );
  // The CLI's forwarding scope reuses the actual producer's completed Git
  // barrier. A later atomic snapshot save invalidates that exact completion.
  let operationClosureBuilds = 0;
  const operationInput = {
    config,
    buildClosure: () => {
      operationClosureBuilds++;
      return buildClosure();
    },
  };
  await withRecoveryCheckpointOperation(
    operationInput,
    () =>
      withRecoveryCheckpointOperation(operationInput, async () =>
        gitPersistenceStatus(config),
      ),
    { forwardCompletedBarrier: true },
  );
  assert.equal(operationClosureBuilds, 1);
  assert.equal(
    gitPersistenceStatus(config).lastAcknowledged.commitSha,
    unchangedCheckpoint.lastAcknowledged.commitSha,
  );
  operationClosureBuilds = 0;
  const beforeLaterSave = gitPersistenceStatus(config).lastAcknowledged;
  await withRecoveryCheckpointOperation(
    operationInput,
    async () => {
      await withRecoveryCheckpointOperation(operationInput, async () =>
        gitPersistenceStatus(config),
      );
      saveState(statePath(repository, 1), cancelled);
    },
    { forwardCompletedBarrier: true },
  );
  assert.equal(operationClosureBuilds, 2);
  const afterLaterSave = gitPersistenceStatus(config).lastAcknowledged;
  assert.equal(afterLaterSave.sequence > beforeLaterSave.sequence, true);
  assert.notEqual(afterLaterSave.commitSha, beforeLaterSave.commitSha);
  assert.deepEqual(
    readContinuation(repository, 1).planningRecovery,
    cancelled.planningRecovery,
  );
  const ownedCommand = {
    requestId: randomUUID(),
    action: "project-queue:pause",
    inputDigest: learningDigest("owned storage completion"),
  };
  operationClosureBuilds = 0;
  let ownedAck;
  const ownedCompletion = await withRecoveryCheckpointCommandOperation(
    operationInput,
    ownedCommand,
    async () => {
      await awaitCheckpointAdmission(repository, "explicit");
      ownedAck = gitPersistenceStatus(config).lastAcknowledged;
    },
  );
  assert.equal(
    operationClosureBuilds,
    1,
    "the same owned terminal ACK requires no second closure",
  );
  assert.deepEqual(ownedCompletion.checkpointCompletion.acknowledgment, {
    commitSha: ownedAck.commitSha,
    payloadDigest: ownedAck.payloadDigest,
    sequence: ownedAck.sequence,
  });
  operationClosureBuilds = 0;
  await withRecoveryCheckpointCommandOperation(
    operationInput,
    { ...ownedCommand, requestId: randomUUID() },
    async () => {
      await awaitCheckpointAdmission(repository, "explicit");
      saveState(statePath(repository, 1), cancelled);
    },
  );
  assert.equal(
    operationClosureBuilds,
    2,
    "later own durable material invalidates the owned ACK",
  );
  // Exercise the actual retention producer and adapter admission seam with a
  // literal storage-contract payload. This is no provider call, dispatch receipt
  // or semantic acceptance: the real store, saved owner and private Git ACK are
  // the facts being verified.
  const returnInvocation = randomUUID();
  const returnRecord = {
    phase: "submitted",
    invocation: { id: returnInvocation, phase: "compile" },
    invocations: [{ id: returnInvocation, phase: "compile" }],
    history: [],
  };
  cancelled.planningRecovery = returnRecord;
  const nativeOriginal = {
    representation: "literal-agent-text",
    response: observedSource.toString("utf8"),
    terminal: "completed",
  };
  const publicationCount = () =>
    Number(
      execFileSync(
        "git",
        ["--git-dir", remote, "rev-list", "--count", config.gitPersistence.ref],
        { encoding: "utf8" },
      ).trim(),
    );
  const beforeReturnPublications = publicationCount();
  let returnClosureBuilds = 0;
  const buildReturnClosure = () => {
    returnClosureBuilds++;
    return buildClosure();
  };
  await withRecoveryCheckpointScope(
    { config, buildClosure: buildReturnClosure },
    () =>
      admitNativeReturn(
        (receipt) =>
          retainPlanningNativeReturn(
            {
              record: returnRecord,
              invocationId: returnInvocation,
              phase: "compile",
              repository,
              store,
              save: () => saveState(statePath(repository, 1), cancelled),
            },
            receipt,
          ),
        nativeOriginal,
        repository,
      ),
  );
  assert.equal(returnClosureBuilds, 1);
  assert.equal(publicationCount(), beforeReturnPublications + 1);
  const returnedArchive = await readVerifiedRecoveryCheckpoint(config);
  const returnRef = returnRecord.invocations[0].nativeReturns[0];
  assert.equal(
    returnedArchive.manifest.contentRefs.some(
      (ref) => ref.digest === returnRef.digest,
    ),
    true,
  );
  assert.deepEqual(
    Buffer.from(await returnedArchive.readVerifiedBlob(returnRef)),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        invocationId: returnInvocation,
        phase: "compile",
        ...nativeOriginal,
      }),
    ),
  );
  assert.equal(
    gitPersistenceStatus(config).lastAcknowledged.sequence,
    returnedArchive.manifest.sequence,
  );
  // Keep this storage-only fixture terminal before the later cancellation
  // lineage workflow; its pending retention owner supplies no dispatched work.
  returnRecord.phase = "stopped";
  delete returnRecord.invocation;
  saveState(statePath(repository, 1), cancelled);
  // This same real private Git workflow retains a claim, its first canonical
  // snapshot, and terminal cancellation originals. No adapter response or
  // admission receipt is invented: dispatch settlement authenticates those
  // separately, while this case exercises the literal lineage/restore boundary.
  const claimDirectory = join(state, "project-queue-history");
  mkdirSync(claimDirectory, { mode: 0o700 });
  const claim = {
    schemaVersion: 1,
    kind: "project-queue-owner",
    id: randomUUID(),
    repository,
    authorityDigest: factoryAuthorityDigest(config),
    admissionId: randomUUID(),
    receiptId: randomUUID(),
    objective: 2,
    bodyDigest: cancelled.objectiveBodyDigest,
    ownerTokenDigest: learningDigest("original-owner"),
    at: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const claimPath = join(claimDirectory, `${claim.id}.json`);
  const writeClaim = () =>
    writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
  writeClaim();
  await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  const claimInitial = {
    // The same real archive supplies a positive pre-snapshot witness before
    // the workflow records its actual canonical continuation below.
    ...structuredClone(cancelled),
    objective: 2,
    runId: randomUUID(),
    coordinator: {
      mode: "paused",
      phase: "planning",
      phaseStartedAt: new Date().toISOString(),
      deadlineAt: claim.deadlineAt,
    },
  };
  delete claimInitial.cancelledAt;
  const reserved = await readVerifiedRecoveryCheckpoint(config, undefined, {
    kind: "pre-snapshot",
    objective: claim.objective,
    claimId: claim.id,
  });
  const reservation = reserved.queueReservationLineage;
  assert(reservation);
  assert.equal(reserved.queueOwnerLineage, undefined);
  assert.equal(reservation.checkpoints.current.commitSha, reserved.commitSha);
  assert.deepEqual(
    reservation.generations.at(-1),
    reservation.checkpoints.current,
  );
  assert.deepEqual(
    Buffer.from(
      reservation.bodies.find(
        ({ ref }) => ref.digest === reservation.originalClaim.digest,
      ).bytes,
    ),
    readFileSync(claimPath),
  );
  saveState(statePath(repository, 2), claimInitial);
  const initialBytes = readFileSync(statePath(repository, 2));
  await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  await assert.rejects(
    readVerifiedRecoveryCheckpoint(config, undefined, {
      kind: "pre-snapshot",
      objective: 2,
      claimId: claim.id,
    }),
    /continuation/,
  );
  const claimTerminal = {
    // A started continuation can never be reshaped into an orphan reservation.
    ...structuredClone(claimInitial),
    cancelRequested: true,
    cancelledAt: new Date().toISOString(),
  };
  saveState(statePath(repository, 2), claimTerminal);
  const terminalBytes = readFileSync(statePath(repository, 2));
  await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  const lineageArchive = await readVerifiedRecoveryCheckpoint(
    config,
    undefined,
    { objective: 2, claimId: claim.id, runId: claimInitial.runId },
  );
  const lineage = lineageArchive.queueOwnerLineage;
  assert.ok(lineage);
  for (const original of lineage.bodies)
    assert.deepEqual(
      retainProjectQueueOriginal(store, original.ref, original.bytes),
      original.ref,
    );
  assert.deepEqual(store.readBytes(lineage.initialSnapshot), initialBytes);
  const terminalFile = lineageArchive.manifest.files.find(
    (file) => file.path === "objectives/2/state.json",
  );
  assert.ok(terminalFile);
  const archiveTerminalBytes = await lineageArchive.readVerifiedBlob(
    terminalFile.ref,
  );
  assert.deepEqual(Buffer.from(archiveTerminalBytes), terminalBytes);
  assert.deepEqual(Object.keys(terminalFile.ref), [
    "bytes",
    "digest",
    "mediaType",
  ]);
  const terminalRef = retainProjectQueueOriginal(
    store,
    terminalFile.ref,
    archiveTerminalBytes,
  );
  claim.settled = {
    at: new Date().toISOString(),
    runId: claimInitial.runId,
    disposition: "quiescent",
    cancellation: {
      schemaVersion: 1,
      originalClaim: lineage.originalClaim,
      initialSnapshot: lineage.initialSnapshot,
      cancelledSnapshot: terminalRef,
      configDigest: claimInitial.configDigest,
      owner: {
        pid: process.pid,
        startTime: linuxProcessIdentity(process.pid).startTime,
        tokenDigest: learningDigest("cancelling-owner"),
      },
      lineage: { kind: "verified-first-run", checkpoints: lineage.checkpoints },
    },
  };
  await authenticateQueueOwnerReferences(claim, (reference) =>
    store.readBytes(reference),
  );
  const unrelated = structuredClone(claim);
  unrelated.settled.runId = randomUUID();
  await assert.rejects(
    authenticateQueueOwnerReferences(unrelated, (reference) =>
      store.readBytes(reference),
    ),
    /original run/,
  );
  const uncertain = structuredClone(claimTerminal);
  uncertain.coordinator.processes = [
    { pid: process.pid, startTime: "unsettled-owned-process" },
  ];
  const uncertainProof = structuredClone(claim);
  uncertainProof.settled.cancellation.cancelledSnapshot = store.putBytes(
    Buffer.from(JSON.stringify(uncertain)),
    { mediaType: "application/json" },
  );
  await assert.rejects(
    authenticateQueueOwnerReferences(uncertainProof, (reference) =>
      store.readBytes(reference),
    ),
    /quiescent/,
  );
  await assert.rejects(
    readVerifiedRecoveryCheckpoint(config, undefined, {
      objective: 2,
      claimId: claim.id,
      runId: randomUUID(),
    }),
    /replaced/,
  );
  writeClaim();
  const queueCheckpoint = await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  assert.equal(queueCheckpoint.status, "acknowledged");
  const queueArchive = await readVerifiedRecoveryCheckpoint(config);
  const queueFile = queueArchive.manifest.files.find(
    (file) => file.path === `project-queue-history/${claim.id}.json`,
  );
  assert.ok(queueFile);
  const queueOriginalBytes = await queueArchive.readVerifiedBlob(queueFile.ref);
  const archivedClaim = parseQueueRecord(
    queueOriginalBytes,
    repository,
    claim.id,
  );
  await authenticateQueueOwnerReferences(
    archivedClaim,
    queueArchive.readVerifiedBlob,
  );
  // A second saved first-run cohort in this same private archive requires an
  // independent witness query. The read may share transport, never either
  // claim/run verdict or its logical original-body capacity charges.
  const secondClaim = {
    ...structuredClone(claim),
    id: randomUUID(),
    objective: 4,
    admissionId: randomUUID(),
    receiptId: randomUUID(),
    ownerTokenDigest: learningDigest("second-original-owner"),
    at: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  delete secondClaim.settled;
  const secondClaimPath = join(claimDirectory, `${secondClaim.id}.json`);
  const writeSecondClaim = () =>
    writeFileSync(secondClaimPath, `${JSON.stringify(secondClaim)}\n`, {
      mode: 0o600,
    });
  writeSecondClaim();
  await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  const secondInitial = {
    ...structuredClone(claimInitial),
    objective: 4,
    runId: randomUUID(),
    coordinator: {
      ...claimInitial.coordinator,
      phaseStartedAt: new Date().toISOString(),
      deadlineAt: secondClaim.deadlineAt,
    },
  };
  saveState(statePath(repository, 4), secondInitial);
  const secondInitialBytes = readFileSync(statePath(repository, 4));
  await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  const secondTerminal = {
    ...structuredClone(secondInitial),
    cancelRequested: true,
    cancelledAt: new Date().toISOString(),
  };
  saveState(statePath(repository, 4), secondTerminal);
  await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  const secondLineageArchive = await readVerifiedRecoveryCheckpoint(
    config,
    undefined,
    {
      objective: 4,
      claimId: secondClaim.id,
      runId: secondInitial.runId,
    },
  );
  const secondLineage = secondLineageArchive.queueOwnerLineage;
  assert.ok(secondLineage);
  for (const original of secondLineage.bodies)
    retainProjectQueueOriginal(store, original.ref, original.bytes);
  assert.deepEqual(
    store.readBytes(secondLineage.initialSnapshot),
    secondInitialBytes,
  );
  const secondTerminalFile = secondLineageArchive.manifest.files.find(
    (file) => file.path === "objectives/4/state.json",
  );
  assert.ok(secondTerminalFile);
  secondClaim.settled = {
    at: new Date().toISOString(),
    runId: secondInitial.runId,
    disposition: "quiescent",
    cancellation: {
      schemaVersion: 1,
      originalClaim: secondLineage.originalClaim,
      initialSnapshot: secondLineage.initialSnapshot,
      cancelledSnapshot: retainProjectQueueOriginal(
        store,
        secondTerminalFile.ref,
        await secondLineageArchive.readVerifiedBlob(secondTerminalFile.ref),
      ),
      configDigest: secondInitial.configDigest,
      owner: claim.settled.cancellation.owner,
      lineage: {
        kind: "verified-first-run",
        checkpoints: secondLineage.checkpoints,
      },
    },
  };
  await authenticateQueueOwnerReferences(secondClaim, (reference) =>
    store.readBytes(reference),
  );
  writeSecondClaim();
  await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  const multiWitnessInspection = await inspectRecoveryCheckpoint(config);
  assert.equal(
    multiWitnessInspection.capacity.cancellationAncestry.availability,
    "available",
  );
  const witnessCharges =
    multiWitnessInspection.capacity.cancellationAncestry.traversals;
  assert.equal(witnessCharges.length, 2);
  assert.equal(
    witnessCharges[0].manifestTransportBytes,
    witnessCharges[1].manifestTransportBytes,
  );
  for (const charge of witnessCharges) {
    assert.equal(charge.retainedOriginalBytes > 0, true);
    assert.equal(
      charge.chargedBytes,
      charge.manifestTransportBytes + charge.retainedOriginalBytes,
    );
  }
  const multiWitnessArchive = await readVerifiedRecoveryCheckpoint(
    config,
    undefined,
    {
      objective: 4,
      claimId: secondClaim.id,
      runId: secondInitial.runId,
    },
  );
  assert.deepEqual(
    multiWitnessArchive.queueOwnerLineage.checkpoints,
    secondLineage.checkpoints,
  );
  assert.deepEqual(
    multiWitnessArchive.queueOwnerLineage.originalClaim,
    secondLineage.originalClaim,
  );
  const priorWitnessArchive = await readVerifiedRecoveryCheckpoint(
    config,
    undefined,
    { objective: 2, claimId: claim.id, runId: claimInitial.runId },
  );
  for (const [actual, original, initialOriginal, foreignRefs] of [
    [
      priorWitnessArchive.queueOwnerLineage,
      lineage,
      initialBytes,
      [secondLineage.initialSnapshot, secondTerminalFile.ref],
    ],
    [
      multiWitnessArchive.queueOwnerLineage,
      secondLineage,
      secondInitialBytes,
      [lineage.initialSnapshot, terminalFile.ref],
    ],
  ]) {
    assert.ok(actual);
    assert.deepEqual(actual.checkpoints, original.checkpoints);
    assert.deepEqual(actual.bodies, original.bodies);
    assert.deepEqual(
      actual.bodies.map(({ ref }) => ref),
      [
        original.checkpoints.before.manifest,
        original.checkpoints.claimed.manifest,
        original.checkpoints.initial.manifest,
        original.originalClaim,
        original.initialSnapshot,
      ],
    );
    for (const { ref, bytes } of actual.bodies) {
      assert.equal(bytes.byteLength, ref.bytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        ref.digest,
      );
      assert.equal(ref.mediaType, "application/json");
      assert.equal(
        foreignRefs.some((foreign) => foreign.digest === ref.digest),
        false,
      );
    }
    assert.deepEqual(
      Buffer.from(
        actual.bodies.find(
          ({ ref }) => ref.digest === original.initialSnapshot.digest,
        ).bytes,
      ),
      initialOriginal,
    );
  }
  await withRecoveryCheckpointOperation(
    operationInput,
    async () => {
      const cold = await inspectRecoveryCheckpoint(config);
      const warm = await inspectRecoveryCheckpoint(config);
      assert.equal(cold.commitSha, multiWitnessInspection.commitSha);
      assert.equal(warm.commitSha, cold.commitSha);
      assert.deepEqual(cold.capacity, multiWitnessInspection.capacity);
      assert.deepEqual(warm.capacity, cold.capacity);
    },
    { queueControlVerification: true },
  );
  await assert.rejects(
    readVerifiedRecoveryCheckpoint(config, undefined, {
      objective: 4,
      claimId: secondClaim.id,
      runId: claimInitial.runId,
    }),
    /replaced/,
  );
  // The producer path freezes its literal first snapshot exactly once.
  const boundClaim = {
    ...claim,
    id: randomUUID(),
    objective: 3,
    ownerTokenDigest: learningDigest("new-owner"),
  };
  delete boundClaim.settled;
  const boundInitial = {
    ...structuredClone(claimInitial),
    objective: 3,
    runId: randomUUID(),
  };
  saveState(statePath(repository, 3), boundInitial);
  bindProjectQueueRun(config, boundClaim, "new-owner", boundInitial);
  const bindingOriginal = structuredClone(boundClaim.runBinding);
  boundInitial.coordinator.phase = "idle";
  saveState(statePath(repository, 3), boundInitial);
  bindProjectQueueRun(config, boundClaim, "new-owner", boundInitial);
  assert.deepEqual(boundClaim.runBinding, bindingOriginal);
  assert.throws(
    () =>
      bindProjectQueueRun(config, boundClaim, "new-owner", {
        ...boundInitial,
        runId: randomUUID(),
      }),
    /cannot change/,
  );
  // Actual module-bound originals also authenticate a nonterminal stopped handoff.
  // No provider result or remote admission is invented; installed reconciliation
  // separately authenticates those operational facts before it can write a claim.
  boundInitial.coordinator.phase = "waiting";
  boundInitial.planningRecovery = { phase: "stopped", history: [] };
  saveState(statePath(repository, 3), boundInitial);
  const stoppedBytes = readFileSync(statePath(repository, 3));
  const handoffClaim = structuredClone(boundClaim);
  handoffClaim.settled = {
    at: new Date().toISOString(),
    runId: boundInitial.runId,
    disposition: "quiescent",
    handoff: {
      schemaVersion: 1,
      originalClaim: store.putBytes(
        readFileSync(join(claimDirectory, `${boundClaim.id}.json`)),
        { mediaType: "application/json" },
      ),
      stoppedSnapshot: store.putBytes(stoppedBytes, {
        mediaType: "application/json",
      }),
      configDigest: boundInitial.configDigest,
      owner: {
        pid: process.pid,
        startTime: linuxProcessIdentity(process.pid).startTime,
        tokenDigest: learningDigest("recovery-owner"),
      },
    },
  };
  const handoffReferences = await authenticateQueueOwnerReferences(
    handoffClaim,
    (reference) => store.readBytes(reference),
  );
  assert.ok(
    handoffReferences.some(
      (reference) =>
        reference.digest === bindingOriginal.initialSnapshot.digest,
    ),
  );
  assert.ok(
    handoffReferences.some(
      (reference) =>
        reference.digest ===
        handoffClaim.settled.handoff.stoppedSnapshot.digest,
    ),
  );
  assert.deepEqual(readFileSync(statePath(repository, 3)), stoppedBytes);
  const foreignHandoff = structuredClone(handoffClaim);
  foreignHandoff.ownerTokenDigest = learningDigest("different-original-owner");
  await assert.rejects(
    authenticateQueueOwnerReferences(foreignHandoff, (reference) =>
      store.readBytes(reference),
    ),
    /original producer-bound/,
  );
  const unresolvedStopped = structuredClone(boundInitial);
  unresolvedStopped.planningRecovery.invocations = [
    { id: randomUUID(), phase: "compile" },
  ];
  const unresolvedHandoff = structuredClone(handoffClaim);
  unresolvedHandoff.settled.handoff.stoppedSnapshot = store.putBytes(
    Buffer.from(JSON.stringify(unresolvedStopped)),
    { mediaType: "application/json" },
  );
  await assert.rejects(
    authenticateQueueOwnerReferences(unresolvedHandoff, (reference) =>
      store.readBytes(reference),
    ),
    /unresolved retained planning invocation/,
  );
  const missingCurrent = structuredClone(boundInitial);
  missingCurrent.planningRecovery.invocation = {
    id: randomUUID(),
    phase: "diagnosis",
  };
  const missingCurrentHandoff = structuredClone(handoffClaim);
  missingCurrentHandoff.settled.handoff.stoppedSnapshot = store.putBytes(
    Buffer.from(JSON.stringify(missingCurrent)),
    { mediaType: "application/json" },
  );
  await assert.rejects(
    authenticateQueueOwnerReferences(missingCurrentHandoff, (reference) =>
      store.readBytes(reference),
    ),
    /unresolved retained planning invocation/,
  );
  boundInitial.cancelRequested = true;
  boundInitial.cancelledAt = new Date().toISOString();
  saveState(statePath(repository, 3), boundInitial);
  await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  const boundArchive = await readVerifiedRecoveryCheckpoint(config);
  const originalBoundFile = boundArchive.manifest.files.find(
    (file) => file.path === `project-queue-history/${boundClaim.id}.json`,
  );
  const finalBoundFile = boundArchive.manifest.files.find(
    (file) => file.path === "objectives/3/state.json",
  );
  const canonicalInitialRef = boundArchive.manifest.contentRefs.find(
    (reference) => reference.digest === bindingOriginal.initialSnapshot.digest,
  );
  assert.ok(originalBoundFile);
  assert.ok(finalBoundFile);
  assert.ok(canonicalInitialRef);
  const boundProof = structuredClone(boundClaim);
  boundProof.runBinding = {
    runId: bindingOriginal.runId,
    initialSnapshot: canonicalInitialRef,
    schemaVersion: 1,
  };
  boundProof.settled = {
    at: new Date().toISOString(),
    runId: bindingOriginal.runId,
    disposition: "quiescent",
    cancellation: {
      schemaVersion: 1,
      originalClaim: retainProjectQueueOriginal(
        store,
        originalBoundFile.ref,
        await boundArchive.readVerifiedBlob(originalBoundFile.ref),
      ),
      initialSnapshot: bindingOriginal.initialSnapshot,
      cancelledSnapshot: retainProjectQueueOriginal(
        store,
        finalBoundFile.ref,
        await boundArchive.readVerifiedBlob(finalBoundFile.ref),
      ),
      configDigest: boundInitial.configDigest,
      owner: claim.settled.cancellation.owner,
      lineage: { kind: "producer-bound" },
    },
  };
  // Canonical manifest refs and locally produced refs authenticate the same
  // original, including nested immutable run bindings and duplicate refs.
  await authenticateQueueOwnerReferences(boundProof, (reference) =>
    store.readBytes(reference),
  );
  new LocalRepositoryMemory(state, repository).retain({
    ...record,
    createdAt: new Date().toISOString(),
    producer: { ...record.producer, identity: "second-local-source-read" },
    summary: "A second local read confirms the complete orchard API reference",
  });
  // A prior authenticated remote copy must never mask corruption in the
  // current local original during the next publication.
  const currentSourcePath = join(
    state,
    "content",
    sourceRef.digest.slice(0, 2),
    sourceRef.digest,
  );
  writeFileSync(currentSourcePath, "corrupt already archived API reference");
  try {
    await assert.rejects(
      synchronizeRecoveryCheckpoint(config, {
        reason: "explicit",
        buildClosure,
      }),
      /digest verification|failed exact verification/,
    );
    assert.equal(
      execFileSync(
        "git",
        ["--git-dir", remote, "rev-parse", config.gitPersistence.ref],
        {
          encoding: "utf8",
        },
      ).trim(),
      boundArchive.commitSha,
    );
  } finally {
    writeFileSync(currentSourcePath, source);
  }
  const publicationStarted = performance.now();
  const secondCheckpoint = await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure,
  });
  const publicationElapsedMs = performance.now() - publicationStarted;
  assert.equal(secondCheckpoint.status, "acknowledged");
  const secondInspection = await inspectRecoveryCheckpoint(config);
  const publishedManifest = JSON.parse(
    execFileSync(
      "git",
      [
        "--git-dir",
        remote,
        "show",
        `${secondCheckpoint.lastAcknowledged.commitSha}:checkpoint.json`,
      ],
      { encoding: "utf8" },
    ),
  );
  const exactRefs = (manifest) =>
    new Map(
      [...manifest.contentRefs, ...manifest.files.map((file) => file.ref)].map(
        (ref) => [ref.digest, ref],
      ),
    );
  const priorRefs = exactRefs(boundArchive.manifest);
  const currentRefs = exactRefs(publishedManifest);
  const sharedRefs = [...currentRefs.values()].filter((ref) => {
    const prior = priorRefs.get(ref.digest);
    return prior?.bytes === ref.bytes && prior.mediaType === ref.mediaType;
  });
  assert.equal(sharedRefs.length > 0, true);
  assert.equal(currentRefs.size > sharedRefs.length, true);
  const blobOid = (commit, ref) =>
    execFileSync(
      "git",
      ["--git-dir", remote, "rev-parse", `${commit}:blobs/${ref.digest}`],
      { encoding: "utf8" },
    ).trim();
  assert.equal(
    blobOid(boundArchive.commitSha, sourceRef),
    blobOid(secondCheckpoint.lastAcknowledged.commitSha, sourceRef),
  );
  t.diagnostic(
    `Changed checkpoint publication: ${publicationElapsedMs.toFixed(3)} ms; ${sharedRefs.length} exact bodies shared, ${currentRefs.size - sharedRefs.length} new or changed`,
  );
  // Whole current material remains charged even when nearly every body is
  // already present in the verified publication base.
  await assert.rejects(
    synchronizeRecoveryCheckpoint(
      {
        ...config,
        gitPersistence: {
          ...config.gitPersistence,
          maxFiles:
            secondInspection.current.logicalFiles +
            secondInspection.current.uniqueBodies,
        },
      },
      { reason: "explicit", buildClosure },
    ),
    /Current materialized checkpoint exceeds admitted bounds/,
  );
  assert.equal(
    gitPersistenceStatus(config).lastAcknowledged.commitSha,
    secondCheckpoint.lastAcknowledged.commitSha,
  );
  assert.equal(
    secondInspection.capacity.cancellationAncestry.availability,
    "available",
  );
  for (const usage of secondInspection.capacity.cancellationAncestry
    .traversals) {
    assert.equal(usage.commits > 1, true);
    assert.equal(usage.manifestTransportBytes > 0, true);
    assert.equal(usage.retainedOriginalBytes > 0, true);
    assert.equal(
      usage.chargedBytes,
      usage.manifestTransportBytes + usage.retainedOriginalBytes,
    );
    assert.equal(
      usage.byteHeadroom,
      config.gitPersistence.maxBytes - usage.chargedBytes,
    );
    assert.equal(
      usage.commitHeadroom,
      config.gitPersistence.maxFiles - usage.commits,
    );
    assert.equal(
      usage.manifestBufferHeadroom,
      config.gitPersistence.maxBytes + 65536 - usage.manifestTransportBytes,
    );
  }
  assert.equal(secondInspection.reachableHistory.availability, "available");
  assert.equal(
    secondInspection.reachableHistory.logicalObjectBytes >
      firstInspection.reachableHistory.logicalObjectBytes,
    true,
  );
  assert.notEqual(
    secondCheckpoint.lastAcknowledged.commitSha,
    firstCheckpoint.lastAcknowledged.commitSha,
  );
  execFileSync("git", [
    `--git-dir=${remote}`,
    "merge-base",
    "--is-ancestor",
    firstCheckpoint.lastAcknowledged.commitSha,
    secondCheckpoint.lastAcknowledged.commitSha,
  ]);
  // The controller owns one remote-only verifier across separate commands.
  // Current bytes stay checked; immutable witnesses reuse authenticated prefixes.
  const verifierDirectories = () =>
    readdirSync(join(state, "recovery"))
      .filter((name) => /^verify-.*\.git$/.test(name))
      .sort();
  assert.deepEqual(verifierDirectories(), []);
  let firstVerifier;
  await withRecoveryCheckpointControllerVerification(
    operationInput,
    async () => {
      const [left, right] = await Promise.all([
        readVerifiedRecoveryCheckpoint(config),
        readVerifiedRecoveryCheckpoint(config),
      ]);
      assert.equal(left.commitSha, right.commitSha);
      const content = new LocalContentStore(join(state, "content"));
      const cachedRef = left.manifest.contentRefs.find((ref) => ref.bytes > 0);
      const cachedPath = join(
        state,
        "content",
        cachedRef.digest.slice(0, 2),
        cachedRef.digest,
      );
      const originalContent = content.readBytes(cachedRef);
      const bodyClosure = {
        files: [],
        contentRefs: [cachedRef],
        gaps: [],
      };
      await withRecoveryCheckpointClosureReads(
        config,
        async () => {
          const first = content.readBytes(cachedRef);
          first[0] ^= 1;
          assert.deepEqual(content.readBytes(cachedRef), originalContent);
          return bodyClosure;
        },
        true,
      );
      const originalMaxFiles = config.gitPersistence.maxFiles;
      try {
        config.gitPersistence.maxFiles++;
        await assert.rejects(
          withRecoveryCheckpointClosureReads(
            config,
            async () => bodyClosure,
            true,
          ),
          /verification scope changed or is unavailable/,
        );
      } finally {
        config.gitPersistence.maxFiles = originalMaxFiles;
      }
      try {
        await assert.rejects(
          withRecoveryCheckpointClosureReads(
            config,
            async () => {
              assert.deepEqual(content.readBytes(cachedRef), originalContent);
              config.gitPersistence.maxFiles++;
              assert.deepEqual(content.readBytes(cachedRef), originalContent);
              return bodyClosure;
            },
            true,
          ),
          /configuration changed during its build/,
        );
      } finally {
        config.gitPersistence.maxFiles = originalMaxFiles;
      }
      try {
        await assert.rejects(
          withRecoveryCheckpointClosureReads(
            config,
            async () => {
              assert.deepEqual(content.readBytes(cachedRef), originalContent);
              const changed = Buffer.from(originalContent);
              changed[0] ^= 1;
              writeFileSync(cachedPath, changed);
              // A repeated semantic read may share its verified original;
              // altered current bytes must still refuse the final boundary.
              assert.deepEqual(content.readBytes(cachedRef), originalContent);
              return bodyClosure;
            },
            true,
          ),
          /failed digest verification/,
        );
      } finally {
        writeFileSync(cachedPath, originalContent);
      }
      try {
        await assert.rejects(
          withRecoveryCheckpointClosureReads(
            config,
            async () => {
              content.verifyPrivateBytes(cachedRef);
              rmSync(cachedPath);
              return bodyClosure;
            },
            true,
          ),
          /ENOENT/,
        );
      } finally {
        content.putBytes(originalContent, { mediaType: cachedRef.mediaType });
      }
      assert.deepEqual(
        new LocalContentStore(join(state, "content")).readBytes(cachedRef),
        originalContent,
      );
      const altered = Buffer.from(originalContent);
      altered[0] ^= 1;
      writeFileSync(cachedPath, altered, { mode: 0o600 });
      assert.throws(
        () => content.readBytes(cachedRef),
        /failed digest verification/,
      );
      writeFileSync(cachedPath, originalContent, { mode: 0o600 });
      assert.deepEqual(content.readBytes(cachedRef), originalContent);
      rmSync(cachedPath);
      assert.throws(() => content.readBytes(cachedRef), /ENOENT/);
      content.putBytes(originalContent, { mediaType: cachedRef.mediaType });
      assert.deepEqual(content.readBytes(cachedRef), originalContent);
      assert.deepEqual(verifierDirectories().length, 1);
      firstVerifier = verifierDirectories()[0];
      const directory = join(state, "recovery", firstVerifier);
      const originalCommit = execFileSync("git", [
        "--git-dir",
        directory,
        "cat-file",
        "commit",
        left.commitSha,
      ]);
      const corruptPath = join(
        directory,
        "objects",
        left.commitSha.slice(0, 2),
        left.commitSha.slice(2),
      );
      mkdirSync(join(directory, "objects", left.commitSha.slice(0, 2)), {
        recursive: true,
      });
      // A valid compressed object under the wrong OID must not become trusted
      // merely because its repository was authenticated on the preceding read.
      const changedCommit = Buffer.from(originalCommit);
      changedCommit[changedCommit.length - 2] ^= 1;
      writeFileSync(
        corruptPath,
        deflateSync(
          Buffer.concat([
            Buffer.from(`commit ${changedCommit.length}\0`),
            changedCommit,
          ]),
        ),
      );
      try {
        await assert.rejects(
          readVerifiedRecoveryCheckpoint(config),
          /Git archive transport command failed|Command failed|altered or missing/,
        );
      } finally {
        rmSync(corruptPath, { force: true });
      }
      const restoredRead = await readVerifiedRecoveryCheckpoint(config);
      assert.equal(restoredRead.commitSha, left.commitSha);
      const reusedDirectory = verifierDirectories()[0];
      await withRecoveryCheckpointOperation(
        operationInput,
        () => readVerifiedRecoveryCheckpoint(config),
        { queueControlVerification: true },
      );
      assert.equal(verifierDirectories()[0], reusedDirectory);
      const objectRoot = join(state, "recovery", reusedDirectory, "objects");
      const cachedFiles = readdirSync(objectRoot).flatMap((name) =>
        name === "pack" || /^[a-f0-9]{2}$/.test(name)
          ? readdirSync(join(objectRoot, name))
              .filter((file) =>
                /(?:^[a-f0-9]{38,62}$|\.pack$|\.idx$)/.test(file),
              )
              .map((file) => join(objectRoot, name, file))
          : [],
      );
      assert(cachedFiles.length > 0);
      rmSync(cachedFiles[0]);
      await assert.rejects(
        readVerifiedRecoveryCheckpoint(config),
        /altered or missing/,
      );
      assert.equal(
        (await readVerifiedRecoveryCheckpoint(config)).commitSha,
        restoredRead.commitSha,
      );
      left.manifest.files.length = 0;
      assert.equal(restoredRead.manifest.files.length > 0, true);
      await assert.rejects(
        readVerifiedRecoveryCheckpoint({
          ...config,
          gitPersistence: {
            ...config.gitPersistence,
            maxFiles: config.gitPersistence.maxFiles - 1,
          },
        }),
        /different admitted binding/,
      );
      await assert.rejects(
        async () =>
          withRecoveryCheckpointOperation(
            {
              ...operationInput,
              config: { ...config, pollSeconds: (config.pollSeconds ?? 1) + 1 },
            },
            async () => readVerifiedRecoveryCheckpoint(config),
          ),
        /scope.*different|scope.*match|different.*configuration|Nested checkpoint/,
      );
      saveState(statePath(repository, 1), cancelled);
      await synchronizeRecoveryCheckpoint(config, {
        reason: "explicit",
        buildClosure,
      });
      const advanced = await readVerifiedRecoveryCheckpoint(config);
      assert.notEqual(advanced.commitSha, restoredRead.commitSha);
      assert.equal(verifierDirectories().length, 1);
    },
  );
  assert.deepEqual(verifierDirectories(), []);
  await withRecoveryCheckpointOperation(
    operationInput,
    async () => {
      await readVerifiedRecoveryCheckpoint(config);
      assert.equal(verifierDirectories().length, 1);
      assert.notEqual(verifierDirectories()[0], firstVerifier);
    },
    { queueControlVerification: true },
  );
  assert.deepEqual(verifierDirectories(), []);
  // Non-opted long-running scopes keep the original per-read disposable path.
  await withRecoveryCheckpointScope(operationInput, async () => {
    await readVerifiedRecoveryCheckpoint(config);
    assert.deepEqual(verifierDirectories(), []);
  });
  // A separate real Node owner completes the actual Git barrier. Forwarding
  // tests concern that receipt only, and invent no GitHub/provider response.
  const commandBinding = {
    requestId: randomUUID(),
    action: "project-queue:pause",
    inputDigest: learningDigest("private storage command"),
  };
  const checkpointModule = new URL(
    "../dist/recovery-checkpoint.js",
    import.meta.url,
  ).href;
  const closureModule = new URL(
    "../dist/recovery-checkpoint-closure.js",
    import.meta.url,
  ).href;
  const stateModule = new URL("../dist/state-store.js", import.meta.url).href;
  const producer = (advance = false) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
    import { withRecoveryCheckpointCommandOperation, gitPersistenceStatus } from ${JSON.stringify(checkpointModule)};
    import { buildRecoveryCheckpointClosure } from ${JSON.stringify(closureModule)};
    import { readContinuation, saveState, statePath } from ${JSON.stringify(stateModule)};
    const config=${JSON.stringify(config)},request=${JSON.stringify(commandBinding)};
    const completed=await withRecoveryCheckpointCommandOperation({config,buildClosure:()=>buildRecoveryCheckpointClosure({config})},request,async()=>{
      ${advance ? "saveState(statePath(config.repository,1),readContinuation(config.repository,1));" : ""}
      return gitPersistenceStatus(config);
    });
    process.stdout.write(JSON.stringify(completed));
  `,
        ],
        { env: process.env, encoding: "utf8", timeout: 30_000 },
      ),
    );
  operationClosureBuilds = 0;
  let completedCommand;
  await withRecoveryCheckpointOperation(
    operationInput,
    async () => {
      completedCommand = producer();
      const later = producer(true);
      assert(
        later.checkpointCompletion.acknowledgment.sequence >
          completedCommand.checkpointCompletion.acknowledgment.sequence,
      );
      assert.throws(
        () =>
          acceptForwardedCheckpointCompletion(
            completedCommand.checkpointCompletion,
            {
              ...commandBinding,
              inputDigest: learningDigest("another request"),
            },
          ),
        /differs/,
      );
      acceptForwardedCheckpointCompletion(
        completedCommand.checkpointCompletion,
        commandBinding,
      );
    },
    { forwardCompletedBarrier: true },
  );
  assert.equal(
    operationClosureBuilds,
    0,
    "later controller material cannot turn the forwarding caller into a publisher",
  );
  await withRecoveryCheckpointOperation(
    operationInput,
    async () => {
      acceptForwardedCheckpointCompletion(
        completedCommand.checkpointCompletion,
        commandBinding,
      );
      saveState(statePath(repository, 1), cancelled);
    },
    { forwardCompletedBarrier: true },
  );
  assert.equal(
    operationClosureBuilds,
    1,
    "this caller's later write still needs its own barrier",
  );
  // A real receiving Git process updates the ref, then outlives the bounded
  // client wait. Reconciliation observes that exact publication without replay.
  const received = join(root, "received.txt");
  const receiveHook = join(remote, "hooks", "post-receive");
  writeFileSync(
    receiveHook,
    `#!/bin/sh\nprintf 'received\\n' >> '${received}'\nsleep 2\n`,
    { mode: 0o700 },
  );
  const boundedConfig = {
    ...config,
    gitPersistence: { ...config.gitPersistence, timeoutMs: 1000 },
  };
  assert.deepEqual(readFileSync(join(checkout, "api.md")), source);
  new LocalRepositoryMemory(state, repository).retain({
    ...record,
    createdAt: new Date().toISOString(),
    producer: { ...record.producer, identity: "third-local-source-read" },
    summary: "A third local read confirms the complete orchard API reference",
  });
  await assert.rejects(
    synchronizeRecoveryCheckpoint(boundedConfig, {
      reason: "explicit",
      buildClosure,
    }),
    /publication outcome is unknown/,
  );
  const unknown = gitPersistenceStatus(config);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.attemptedTransportOutcome, "unknown");
  assert.equal(
    execFileSync(
      "git",
      [`--git-dir=${remote}`, "rev-parse", config.gitPersistence.ref],
      { encoding: "utf8" },
    ).trim(),
    unknown.attemptedCommit,
  );
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const reconciled = await synchronizeRecoveryCheckpoint(config, {
    reason: "explicit",
    buildClosure: () =>
      assert.fail(
        "Exact publication reconciliation must not rebuild or repush",
      ),
  });
  assert.equal(reconciled.status, "acknowledged");
  assert.equal(reconciled.attemptedTransportOutcome, "unknown");
  assert.equal(reconciled.lastAcknowledged.commitSha, unknown.attemptedCommit);
  assert.equal(readFileSync(received, "utf8"), "received\n");
  rmSync(receiveHook);
  // Another actual writer advances the same archive with a normal Git push.
  // The original writer holds the conflict and preserves the foreign tip.
  const rival = join(root, "rival");
  execFileSync("git", ["clone", "--branch", "factory-history", remote, rival], {
    stdio: "pipe",
  });
  const rivalGit = (...args) =>
    execFileSync("git", ["-C", rival, ...args], { encoding: "utf8" }).trim();
  const foreign = execFileSync(
    "git",
    [
      "-C",
      rival,
      "-c",
      "user.name=Other archive writer",
      "-c",
      "user.email=other@example.test",
      "commit-tree",
      rivalGit("rev-parse", "HEAD^{tree}"),
      "-p",
      rivalGit("rev-parse", "HEAD"),
    ],
    { input: "Another archive writer\n", encoding: "utf8" },
  ).trim();
  rivalGit("push", "origin", `${foreign}:${config.gitPersistence.ref}`);
  await assert.rejects(
    synchronizeRecoveryCheckpoint(config, { reason: "explicit", buildClosure }),
    /conflict/,
  );
  assert.equal(gitPersistenceStatus(config).status, "conflict");
  assert.equal(
    execFileSync(
      "git",
      [`--git-dir=${remote}`, "rev-parse", config.gitPersistence.ref],
      { encoding: "utf8" },
    ).trim(),
    foreign,
  );
  const expectedBindings = new LocalRepositoryMemory(state, repository)
    .metadata({ access: privateAccess, limit: 100 })
    .entries.map((entry) => entry.binding)
    .sort((a, b) => a.id.localeCompare(b.id));
  const originals = closure.files
    .filter((file) => file.kind === "learning-original")
    .map((file) => ({ ...file, bytes: readFileSync(join(state, file.path)) }));
  const accountingOriginals = closure.files
    .filter((file) => file.path.startsWith("accounting/"))
    .map((file) => ({ ...file, bytes: readFileSync(join(state, file.path)) }));
  const originalSnapshot = readFileSync(statePath(repository, 1));
  // The only surviving originals are in the remote Git archive. Fetch into an
  // independent repository after both the source workspace and replicas are gone.
  rmSync(checkout, { recursive: true });
  rmSync(rival, { recursive: true });
  rmSync(reviewedPath);
  rmSync(state, { recursive: true });
  assert.equal(gitPersistenceStatus(config).durability, "local-only");
  const recovered = await readVerifiedRecoveryCheckpoint(
    config,
    reconciled.lastAcknowledged.commitSha,
  );
  assert.equal(recovered.commitSha, reconciled.lastAcknowledged.commitSha);
  assert.equal(recovered.manifest.binding.repository, repository);
  assert.equal(recovered.manifest.binding.ref, config.gitPersistence.ref);
  assert.equal(existsSync(join(state, "content")), false);
  await assertAccountingSealContent(
    repository,
    1,
    cancelled.runId,
    accountingSeal,
    recovered.readVerifiedBlob,
  );
  assert.equal(existsSync(join(state, "content")), false);
  const reconstructed = join(root, "reconstructed");
  execFileSync("git", ["init", reconstructed], { stdio: "pipe" });
  const freshConfig = { ...config, checkout: reconstructed };
  assert.notEqual(factoryConfigDigest(freshConfig), cancelled.configDigest);
  await assert.rejects(
    restoreRecoveryCheckpoint({
      config: {
        ...freshConfig,
        gitPersistence: { ...freshConfig.gitPersistence, maxFiles: 1 },
      },
      checkpoint: recovered.commitSha,
    }),
    /bound|limit/i,
  );
  assert.equal(existsSync(statePath(repository, 1)), false);
  assert.equal(existsSync(join(state, "content")), false);
  await assert.rejects(
    restoreRecoveryCheckpoint({
      config: {
        ...freshConfig,
        policy: { ...freshConfig.policy, network: "on" },
      },
      checkpoint: recovered.commitSha,
    }),
    /authority|configuration/i,
  );
  assert.equal(existsSync(statePath(repository, 1)), false);
  assert.equal(existsSync(join(state, "content")), false);
  const historicalRestore = await restoreRecoveryCheckpoint({
    config: freshConfig,
    checkpoint: recovered.commitSha,
  });
  assert.equal(historicalRestore.checkpoint, recovered.commitSha);
  assert.equal(historicalRestore.disposition, "inspection");
  const restoredPreparation = readContinuation(repository, 1);
  assert.equal(restoredPreparation.schemaVersion, 20);
  assert.equal(restoredPreparation.restoration.status, "held");
  assert.equal(
    restoredPreparation.restoration.original.configDigest,
    cancelled.configDigest,
  );
  assert.equal(
    restoredPreparation.restoration.installation.configDigest,
    factoryConfigDigest(freshConfig),
  );
  assert.equal(
    restoredPreparation.restoration.installation.checkout,
    reconstructed,
  );
  assert.equal(restoredPreparation.restoration.source.checkout, checkout);
  assert.deepEqual(
    store.readBytes(restoredPreparation.restoration.original.snapshot),
    originalSnapshot,
  );
  const restoredOriginalFields = structuredClone(restoredPreparation);
  delete restoredOriginalFields.restoration;
  restoredOriginalFields.schemaVersion = cancelled.schemaVersion;
  assert.deepEqual(restoredOriginalFields, cancelled);
  await assert.rejects(
    synchronizeRecoveryCheckpoint(freshConfig, {
      reason: "explicit",
      buildClosure: () =>
        buildRecoveryCheckpointClosure({ config: freshConfig }),
    }),
    /baseline|restor|inspection/i,
  );
  const needsRestoration = gitPersistenceStatus(freshConfig);
  assert.equal(needsRestoration.status, "needs-restore");
  assert.equal(needsRestoration.attemptedCommit, undefined);
  assert.equal(needsRestoration.restoredBaseline, undefined);
  assert.equal(
    execFileSync(
      "git",
      [`--git-dir=${remote}`, "rev-parse", config.gitPersistence.ref],
      { encoding: "utf8" },
    ).trim(),
    foreign,
  );
  assert.throws(() =>
    execFileSync(
      "git",
      ["-C", reconstructed, "rev-parse", "--verify", "HEAD"],
      {
        stdio: "pipe",
      },
    ),
  );
  for (const original of accountingOriginals)
    assert.deepEqual(readFileSync(join(state, original.path)), original.bytes);
  assert.deepEqual(readFileSync(claimPath), Buffer.from(queueOriginalBytes));
  const restoredClaim = parseQueueRecord(
    readFileSync(claimPath),
    repository,
    claim.id,
  );
  await authenticateQueueOwnerReferences(restoredClaim, (reference) =>
    store.readBytes(reference),
  );
  assert.deepEqual(
    store.readBytes(restoredClaim.settled.cancellation.initialSnapshot),
    initialBytes,
  );
  assert.deepEqual(
    store.readBytes(restoredClaim.settled.cancellation.cancelledSnapshot),
    terminalBytes,
  );
  assert.equal(existsSync(join(state, "captures")), false);
  assert.equal(existsSync(join(state, "harness")), false);
  assert.equal(
    existsSync(join(state, "objectives", "1", "diagnostics.ndjson")),
    false,
  );
  assert.deepEqual(readAccountingRecords(repository, 1), accountingBefore);
  assert.deepEqual(readInteractionMetadata(repository, 1), metadataBefore);
  assert.deepEqual(
    analyzeInteractions(readInteractionMetadata(repository, 1), [], {}),
    interactionBefore,
  );
  assert.deepEqual(
    summarizeDiagnosticUsage(readUsageSummaryEvents(repository, 1)),
    usageBefore,
  );
  assert.equal(
    readInteractionContent(repository, retainedCapture),
    retainedText,
  );
  assert.throws(() =>
    readInteractionContent(repository, observed[2].content.reference),
  );
  assert.deepEqual(
    store.readBytes(capturedAssets[0].manifestRef),
    declarationBytes,
  );
  for (const original of originals)
    assert.deepEqual(readFileSync(join(state, original.path)), original.bytes);
  assert.equal(historicalRestore.catalog, "ready");
  assert.equal(existsSync(join(state, "memory", "catalog.sqlite")), true);
  const restored = new LocalRepositoryMemory(state, repository);
  assert.equal(
    restored.search({ access: privateAccess, query: "orchard", limit: 1 })
      .length,
    1,
  );
  assert.equal(restored.catalogStatus, "ready");
  assert.deepEqual(
    restored
      .metadata({ access: privateAccess, limit: 100 })
      .entries.map((entry) => entry.binding)
      .sort((a, b) => a.id.localeCompare(b.id)),
    expectedBindings,
  );
  assert.equal(
    restored.read({ access, id: alternateBinding.id }).record.createdAt,
    "2000-01-01T00:00:00.000Z",
  );
  assert.equal(
    restored.read({ access, id: binding.id }).disposition,
    "historical",
  );
  assert.equal(
    restored.read({ access, id: missing.id }).disposition,
    "unavailable",
  );
  assert.equal(restored.read({ access, id: denied.id }), undefined);
  assert.deepEqual(readPinnedPlaybook(repository, pin), originalPlaybook);
  assert.deepEqual(
    readDreamCheckpoint(repository, proposal.consolidation),
    prepared.checkpoint,
  );
  assert.deepEqual(
    execFileSync("git", [
      "-C",
      reconstructed,
      "show",
      `${cancelled.baseSha}:api.md`,
    ]),
    source,
  );
  await assert.rejects(
    reconcileRestoredContinuation({ config: freshConfig, objective: 1 }),
    /terminal|cancelled/i,
  );
  assert.deepEqual(readContinuation(repository, 1), restoredPreparation);
  const latestRestore = await restoreRecoveryCheckpoint({
    config: freshConfig,
  });
  assert.equal(latestRestore.checkpoint, foreign);
  assert.equal(latestRestore.payloadDigest, historicalRestore.payloadDigest);
  const restoredStatus = gitPersistenceStatus(freshConfig);
  assert.equal(restoredStatus.restoredBaseline.source, "verified-restoration");
  assert.equal(restoredStatus.restoredBaseline.commitSha, foreign);
  assert.equal(restoredStatus.restoredBaseline.transportOutcome, "unavailable");
  assert.deepEqual(restoredStatus.restoredBaseline.priorHold, {
    kind: "needs-restore",
    error: needsRestoration.error,
  });
  assert.equal(restoredStatus.attemptedCommit, undefined);
  assert.equal(restoredStatus.pendingChanges, true);
  const latestPreparation = readContinuation(repository, 1);
  assert.equal(latestPreparation.restoration.status, "held");
  assert.equal(latestPreparation.cancelledAt, cancelled.cancelledAt);
  assert.deepEqual(latestPreparation.charges, cancelled.charges);
  assert.deepEqual(
    store.readBytes(latestPreparation.restoration.original.snapshot),
    originalSnapshot,
  );
  const reboundCheckpoint = await synchronizeRecoveryCheckpoint(freshConfig, {
    reason: "explicit",
    buildClosure: () => buildRecoveryCheckpointClosure({ config: freshConfig }),
  });
  assert.equal(reboundCheckpoint.status, "acknowledged");
  const reboundArchive = await readVerifiedRecoveryCheckpoint(
    freshConfig,
    reboundCheckpoint.lastAcknowledged.commitSha,
  );
  assert.deepEqual(
    Buffer.from(
      await reboundArchive.readVerifiedBlob(
        latestPreparation.restoration.original.snapshot,
      ),
    ),
    originalSnapshot,
  );
  execFileSync("git", [
    `--git-dir=${remote}`,
    "merge-base",
    "--is-ancestor",
    foreign,
    reboundCheckpoint.lastAcknowledged.commitSha,
  ]);
  assert.equal(
    readContinuation(repository, 1).cancelledAt,
    cancelled.cancelledAt,
  );
  assert.equal(readContinuation(repository, 1).restoration.status, "held");
  // A second fresh installation must authenticate the original approval through
  // the rebound publisher's snapshot, without treating its new layout as authority.
  const reboundSnapshot = readFileSync(statePath(repository, 1));
  rmSync(reconstructed, { recursive: true });
  rmSync(state, { recursive: true });
  const nextCheckout = join(root, "rebound-reconstructed");
  execFileSync("git", ["init", nextCheckout], { stdio: "pipe" });
  const nextConfig = { ...freshConfig, checkout: nextCheckout };
  const nextRestore = await restoreRecoveryCheckpoint({
    config: nextConfig,
    checkpoint: reboundCheckpoint.lastAcknowledged.commitSha,
  });
  assert.equal(
    nextRestore.checkpoint,
    reboundCheckpoint.lastAcknowledged.commitSha,
  );
  const nextPreparation = readContinuation(repository, 1);
  assert.equal(nextPreparation.configDigest, cancelled.configDigest);
  assert.equal(nextPreparation.cancelledAt, cancelled.cancelledAt);
  assert.equal(nextPreparation.restoration.status, "held");
  assert.equal(nextPreparation.restoration.source.checkout, checkout);
  assert.equal(nextPreparation.restoration.installation.checkout, nextCheckout);
  assert.deepEqual(
    store.readBytes(nextPreparation.restoration.original.snapshot),
    reboundSnapshot,
  );
  const parentSnapshot = JSON.parse(reboundSnapshot.toString("utf8"));
  assert.deepEqual(
    store.readBytes(parentSnapshot.restoration.original.snapshot),
    originalSnapshot,
  );
  const nextOriginalFields = structuredClone(nextPreparation);
  delete nextOriginalFields.restoration;
  nextOriginalFields.schemaVersion = cancelled.schemaVersion;
  assert.deepEqual(nextOriginalFields, cancelled);
  for (const original of [...originals, ...accountingOriginals])
    assert.deepEqual(readFileSync(join(state, original.path)), original.bytes);
  assert.deepEqual(readAccountingRecords(repository, 1), accountingBefore);
  assert.deepEqual(
    summarizeDiagnosticUsage(readUsageSummaryEvents(repository, 1)),
    usageBefore,
  );
  assert.equal(
    readInteractionContent(repository, retainedCapture),
    retainedText,
  );
  assert.equal(nextRestore.catalog, "ready");
  assert.equal(existsSync(join(state, "memory", "catalog.sqlite")), true);
  assert.deepEqual(readPinnedPlaybook(repository, pin), originalPlaybook);
  assert.deepEqual(
    execFileSync("git", [
      "-C",
      nextCheckout,
      "show",
      `${cancelled.baseSha}:api.md`,
    ]),
    source,
  );
  assert.equal(gitPersistenceStatus(nextConfig).attemptedCommit, undefined);
});

test("selector-bound discovery retains exact bytes, distinguishes incomplete output, and transfers declared fields without delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const bytes = Buffer.from("export const observed = 7;\n");
  writeFileSync(join(checkout, "src", "api.ts"), bytes);
  writeFileSync(
    join(checkout, "src", "helper.ts"),
    "export const helper = 8;\n",
  );
  mkdirSync(join(checkout, "src", "ui"));
  writeFileSync(
    join(checkout, "src", "ui", "view.ts"),
    "export const view = 9;\n",
  );
  writeFileSync(join(checkout, "private.txt"), "Outside selector\n");
  writeFileSync(
    join(checkout, "notes.txt"),
    "# Migration notes\n\nShared migration notes\n",
  );
  git("add", ".");
  git("commit", "-m", "Discovery source");
  const baseSha = git("rev-parse", "HEAD");
  const refsBefore = git("show-ref");
  const store = new LocalContentStore(join(root, "content"));
  const specification = {
    mode: "inventory",
    selectors: ["src/"],
    schema: "factory.repository-inventory/v1",
    role: "implementation-inventory",
    completeness: "complete",
    allowance: { maxEntries: 4, maxBytes: 1024, maxAttempts: 1 },
  };
  const producer = {
    objective: 12,
    runId: "inventory-run",
    itemId: "inventory",
    attemptId: "attempt-1",
  };
  const manifest = await discoverRepository({
    checkout,
    baseSha,
    specification,
    producer,
    store,
  });
  const body = await authenticateDiscoveryOutput({
    checkout,
    specification,
    manifest,
    store,
  });
  assert.equal(manifest.status, "complete");
  assert.deepEqual(
    body.entries.map((entry) => entry.path),
    ["src/api.ts", "src/helper.ts", "src/ui/view.ts"],
  );
  assert.equal(
    body.entries[0].content.digest,
    createHash("sha256").update(bytes).digest("hex"),
  );
  // Authentication and transfer use retained immutable Git bytes, even after the working copy changes.
  writeFileSync(join(checkout, "src", "api.ts"), "Changed working copy\n");
  const inventory = {
    id: "inventory",
    kind: "discovery",
    dependencies: [],
    discovery: specification,
  };
  const consumer = {
    id: "consumer",
    dependencies: ["inventory"],
    discoveryInputs: [
      {
        producerItemId: "inventory",
        role: specification.role,
        fields: ["path", "contentRef"],
      },
    ],
  };
  const state = {
    graph: { items: [inventory, consumer] },
    work: {
      inventory: { status: "done", discoveryOutput: manifest },
      consumer: { status: "pending" },
    },
  };
  const selected = await selectedDiscoveryInputs({
    state,
    item: consumer,
    checkout,
    store,
  });
  assert.deepEqual(selected[0].fields, ["path", "contentRef"]);
  assert.deepEqual(Object.keys(selected[0].entries[0]), [
    "path",
    "contentRef",
    "contentBody",
  ]);
  assert.deepEqual(
    Buffer.from(selected[0].entries[0].contentBody.bytes, "base64"),
    bytes,
  );
  assert.equal(selected[0].source.commitSha, baseSha);
  assert.deepEqual(
    linearDeliveryUnits(state.graph).map((unit) =>
      unit.items.map((item) => item.id),
    ),
    [["inventory"], ["consumer"]],
  );
  // The reviewed graph retains its original integration proof while a complete
  // real inventory materializes related files into bounded, literal batches.
  const criterion =
    "The migration preserves behavior for all affected source modules.";
  const common = {
    title: "Migrate observed modules",
    goal: criterion,
    acceptance: [criterion],
    nonGoals: ["No work outside the approved selectors"],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    discoveryInputs: [],
    ownedPaths: [],
    validation: [],
    brief: "Apply the approved migration while retaining module behavior.",
  };
  const envelope = {
    schemaVersion: 1,
    id: "migrate-modules",
    input: {
      producerItemId: inventory.id,
      role: specification.role,
      schema: specification.schema,
    },
    selectors: specification.selectors,
    workShape: "migration",
    selection: { kind: "all-regular-files" },
    batching: { maxFilesPerChild: 2 },
    limits: { maxChildren: 2, maxIterations: 1 },
    resources: [],
    eligibleProfileIds: [],
    dependencies: [],
    integrationBarrierItemIds: ["join", "integration"],
    empty: "settle-without-children",
    template: {
      ...common,
      id: "migration-template",
      ownedPaths: specification.selectors,
    },
  };
  const graph = {
    objective: producer.objective,
    baseSha,
    expansions: [envelope],
    items: [
      { ...common, ...inventory },
      { ...common, id: "independent", ownedPaths: ["private.txt"] },
      {
        ...common,
        id: "join",
        ownedPaths: ["notes.txt"],
        dependencies: ["independent"],
      },
      {
        ...common,
        id: "integration",
        kind: "qa",
        dependencies: [inventory.id, "join"],
      },
      {
        ...common,
        id: "summary",
        kind: "aggregate",
        dependencies: ["integration"],
        children: ["integration"],
        acceptance: aggregateAcceptance({ id: "summary" }),
      },
    ],
    coverage: [
      {
        ...coverageObligations(criterion, [criterion])[0],
        itemId: "integration",
        proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          preparedBy: "",
        },
      },
    ],
  };
  validateAndOrderGraph(
    graph,
    producer.objective,
    baseSha,
    new Set(["OBJECTIVE"]),
  );
  // Empty selection is no consumption for work, discovery, QA, aggregates and
  // the expansion template; actual selected outputs still require work consumers.
  const malformedSelection = structuredClone(graph);
  malformedSelection.items[1].discoveryInputs = null;
  assert.throws(
    () =>
      validateAndOrderGraph(
        malformedSelection,
        producer.objective,
        baseSha,
        new Set(["OBJECTIVE"]),
      ),
    /Discovery inputs must declare/,
  );
  const readonlySelection = structuredClone(graph);
  readonlySelection.items.find((item) => item.kind === "qa").discoveryInputs =
    consumer.discoveryInputs;
  assert.throws(
    () =>
      validateAndOrderGraph(
        readonlySelection,
        producer.objective,
        baseSha,
        new Set(["OBJECTIVE"]),
      ),
    /ordinary work consumer/,
  );
  const {
    assertWorkflowRecipeGraph,
    assertWorkflowRecipeAdmission,
    assertWorkflowRecipeContext,
    objectiveWorkflowRecipeSelector,
    previewWorkflowRecipe,
    readPinnedWorkflowRecipe,
    resolveWorkflowRecipe,
    retainWorkflowRecipe,
  } = await import("../dist/workflow-recipes.js");
  const recipeBody =
    '## Adaptive workflow\nenabled\n\n## Workflow recipe\n```json\n{"selector":"plugin:repository-migration","arguments":{"selectors":["src/"],"maxFilesPerChild":2,"maxChildren":2}}\n```\n';
  const recipeSelection = objectiveWorkflowRecipeSelector(recipeBody);
  const recipeResolution = resolveWorkflowRecipe({
    selection: recipeSelection,
    checkout,
    baseSha,
    maxBytes: 65536,
  });
  const recipeAdmission = {
    adaptiveEnabled: true,
    selectors: ["src/", "notes.txt"],
    configuredConcurrency: 2,
    executionProfileIds: [],
    memoryEnabled: false,
    capabilities: [
      {
        id: "inventory-discovery",
        status: "available",
        detail: "Installed immutable inventory reader",
      },
      {
        id: "graph-expansion",
        status: "available",
        detail: "Installed bounded expansion controller",
      },
      {
        id: "semantic-discovery",
        status: "unknown",
        detail: "No native discovery preflight in this storage workflow",
      },
    ],
  };
  const recipePreview = previewWorkflowRecipe({
    resolution: recipeResolution,
    admission: recipeAdmission,
  });
  assert.equal(recipePreview.status, "ready");
  assert.equal(recipePreview.estimates.totalItems, "unknown");
  assert.equal(recipePreview.estimates.cost, "unknown");
  assert.equal(recipePreview.estimates.dynamicItems.maximum, 2);
  assert.equal(git("show-ref"), refsBefore);
  assert.throws(
    () =>
      assertWorkflowRecipeAdmission(recipeResolution.contract, {
        ...recipeAdmission,
        selectors: ["notes.txt"],
      }),
    /outside admitted scope/,
  );
  assert.throws(
    () =>
      resolveWorkflowRecipe({
        selection: {
          ...recipeSelection,
          arguments: { selectors: ["src/"], maxChildren: 0 },
        },
        checkout,
        baseSha,
        maxBytes: 65536,
      }),
    /outside declared bounds/,
  );
  const pluginInput = await retainWorkflowRecipe(recipeResolution, store);
  assert.deepEqual(
    await readPinnedWorkflowRecipe(pluginInput.pin, store),
    pluginInput,
  );
  for (const recipe of ["api-feature", "bounded-audit"]) {
    const resolution = resolveWorkflowRecipe({
      selection: {
        selector: `plugin:${recipe}`,
        arguments: {
          selectors: ["src/"],
          ...(recipe === "api-feature"
            ? { sharedSelectors: ["notes.txt"] }
            : {}),
        },
      },
      checkout,
      baseSha,
      maxBytes: 65536,
    });
    const preview = previewWorkflowRecipe({
      resolution,
      admission: recipeAdmission,
    });
    assert.equal(
      preview.status,
      recipe === "bounded-audit" ? "blocked" : "ready",
    );
    assert.equal(preview.estimates.providerCalls, "unknown");
    if (recipe === "bounded-audit")
      assert.ok(
        preview.missingPrerequisites.some((reason) =>
          reason.includes("semantic-discovery"),
        ),
      );
    const retained = await retainWorkflowRecipe(resolution, store);
    assert.deepEqual(
      await readPinnedWorkflowRecipe(retained.pin, store),
      retained,
    );
  }
  // Real repository recipe revisions use a separate Git index and unattached
  // commits, preserving this workflow's checkout/refs and original discovery.
  const localDefinition = structuredClone(recipeResolution.definition);
  localDefinition.version = 3;
  localDefinition.stages[0].id = inventory.id;
  localDefinition.stages[0].discovery = specification;
  localDefinition.stages[1].id = envelope.template.id;
  localDefinition.stages[1].dependencies = [];
  localDefinition.stages[2].id = "integration";
  localDefinition.stages[2].dependencies = [inventory.id];
  localDefinition.stages.push({
    id: "join",
    kind: "work",
    title: "Shared notes owner",
    goal: criterion,
    nonGoals: [],
    dependencies: [],
    selectors: ["notes.txt"],
  });
  const { template: _recipeTemplate, ...declaredEnvelope } = envelope;
  localDefinition.expansions = [
    { ...declaredEnvelope, templateStageId: envelope.template.id },
  ];
  const recipePath = `.factory/recipes/${localDefinition.id}.json`;
  const recipeIndex = join(root, "recipe-index");
  const indexGit = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: recipeIndex },
      encoding: "utf8",
    }).trim();
  const revision = (definition) => {
    const blob = execFileSync(
      "git",
      ["-C", checkout, "hash-object", "-w", "--stdin"],
      { input: JSON.stringify(definition), encoding: "utf8" },
    ).trim();
    indexGit("read-tree", baseSha);
    indexGit(
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},${recipePath}`,
    );
    return indexGit(
      "commit-tree",
      indexGit("write-tree"),
      "-p",
      baseSha,
      "-m",
      "Pinned recipe revision",
    );
  };
  const recipeBase = revision(localDefinition);
  const localResolution = resolveWorkflowRecipe({
    selection: { ...recipeSelection, selector: localDefinition.id },
    checkout,
    baseSha: recipeBase,
    maxBytes: 65536,
  });
  assert.equal(localResolution.origin.kind, "repository");
  assert.equal(localResolution.contract.version, 3);
  const localInput = await retainWorkflowRecipe(localResolution, store);
  assert.doesNotThrow(() => assertWorkflowRecipeGraph(graph, localInput));
  const widened = structuredClone(graph);
  widened.expansions[0].limits.maxChildren++;
  assert.throws(
    () => assertWorkflowRecipeGraph(widened, localInput),
    /widens or changes/,
  );
  const newRecipeBase = revision({ ...localDefinition, version: 4 });
  assert.equal(
    resolveWorkflowRecipe({
      selection: { ...recipeSelection, selector: localDefinition.id },
      checkout,
      baseSha: newRecipeBase,
      maxBytes: 65536,
    }).contract.version,
    4,
  );
  assert.equal(
    (await readPinnedWorkflowRecipe(localInput.pin, store)).contract.version,
    3,
  );
  const invalidBase = revision({
    ...localDefinition,
    commands: ["unauthorized command"],
  });
  assert.throws(
    () =>
      resolveWorkflowRecipe({
        selection: { ...recipeSelection, selector: localDefinition.id },
        checkout,
        baseSha: invalidBase,
        maxBytes: 65536,
      }),
    /unsupported fields/,
  );
  // Pin reads require exact bodies; a lost recipe cannot become latest advice.
  const { readContinuation, statePath } = await import(
    "../dist/state-store.js"
  );
  const { planningSessionInputDigest } = await import(
    "../dist/agent-session.js"
  );
  const preparationRepository = "test-fixtures/recipe-discovery";
  const preparation = {
    schemaVersion: 16,
    kind: "preparing",
    repository: preparationRepository,
    objective: producer.objective,
    runId: "recipe-pre-provider-inputs",
    configDigest: createHash("sha256")
      .update(JSON.stringify(recipeAdmission))
      .digest("hex"),
    baseSha: recipeBase,
    objectiveBodyDigest: createHash("sha256").update(recipeBody).digest("hex"),
    sourcePacketDigest: createHash("sha256")
      .update(JSON.stringify({ objective: recipeBody, pin: localInput.pin }))
      .digest("hex"),
    workflowRecipePin: localInput.pin,
    autonomy: resolveAutonomy(),
    capacity: { concurrency: recipeAdmission.configuredConcurrency },
    charges: {},
    issueByItemId: {},
    coordinator: {
      mode: "running",
      phase: "planning",
      phaseStartedAt: new Date().toISOString(),
    },
  };
  const preparationPath = statePath(preparationRepository, producer.objective);
  saveState(preparationPath, preparation);
  const restoredPreparation = readContinuation(
    preparationRepository,
    producer.objective,
  );
  assert.equal(restoredPreparation.schemaVersion, 16);
  assert.deepEqual(restoredPreparation.workflowRecipePin, localInput.pin);
  assert.equal(
    planningSessionInputDigest(restoredPreparation),
    planningSessionInputDigest(preparation),
  );
  assert.deepEqual(
    await readPinnedWorkflowRecipe(
      restoredPreparation.workflowRecipePin,
      store,
    ),
    localInput,
  );
  const savedPreparationBytes = readFileSync(preparationPath);
  assert.throws(
    () => saveState(preparationPath, { ...preparation, schemaVersion: 14 }),
    /preparation16 or execution15/,
  );
  assert.deepEqual(readFileSync(preparationPath), savedPreparationBytes);
  const resolvedPath = join(
    root,
    "content",
    localInput.pin.resolvedRef.digest.slice(0, 2),
    localInput.pin.resolvedRef.digest,
  );
  const resolvedBody = readFileSync(resolvedPath);
  writeFileSync(resolvedPath, "corrupt retained recipe");
  await assert.rejects(
    readPinnedWorkflowRecipe(localInput.pin, store),
    /digest verification/,
  );
  assert.deepEqual(
    readContinuation(preparationRepository, producer.objective),
    restoredPreparation,
  );
  assert.deepEqual(readFileSync(preparationPath), savedPreparationBytes);
  assert.deepEqual(restoredPreparation.autonomy, preparation.autonomy);
  assert.deepEqual(restoredPreparation.charges, {});
  assert.deepEqual(restoredPreparation.issueByItemId, {});
  writeFileSync(resolvedPath, resolvedBody);
  assert.equal(git("rev-parse", "HEAD"), baseSha);
  assert.equal(git("show-ref"), refsBefore);
  const waiting = Object.fromEntries(
    graph.items.map((item) => [
      item.id,
      { status: item.id === inventory.id ? "done" : "pending" },
    ]),
  );
  assert.deepEqual(
    readyItems(graph, waiting, new Set(), 4).map((item) => item.id),
    ["independent"],
  );
  waiting.independent.status = "done";
  assert.deepEqual(readyItems(graph, waiting, new Set(), 4), []);
  assert.equal(
    linearDeliveryUnits(graph).find((unit) =>
      unit.items.some((item) => item.id === "join"),
    ).items.length,
    1,
  );
  waiting.join.status = "done";
  waiting.integration.status = "done";
  assert.deepEqual(readyItems(graph, waiting, new Set(), 4), []);
  waiting.join.status = "pending";
  waiting.integration.status = "pending";
  const materialized = materializeGraphExpansion({
    graph,
    envelopeId: envelope.id,
    manifest,
    body,
    runId: producer.runId,
    iteration: 1,
  });
  const children = materialized.childIds.map((id) =>
    materialized.graph.items.find((item) => item.id === id),
  );
  const scheduled = structuredClone(materialized.graph);
  const schedulingWork = {
    ...waiting,
    ...Object.fromEntries(
      children.map((item) => [item.id, { status: "pending" }]),
    ),
  };
  const unknownTiming = schedulingObservations(scheduled, schedulingWork);
  assert.equal(
    unknownTiming.get(children[0].id).rankingBasis,
    "remaining-stages",
  );
  assert.equal(unknownTiming.get(children[0].id).estimatedCriticalPathMs, null);
  assert.equal(unknownTiming.get(children[0].id).queueMs, null);
  for (const item of scheduled.items)
    item.scheduling = {
      estimatedDurationMs: item.id === children[0].id ? 20 : 10,
      reason: "The first literal batch contains two modules rather than one.",
    };
  const ranked = rankPending(scheduled, schedulingWork);
  assert.ok(
    ranked.indexOf(scheduled.items.find((item) => item.id === "integration")) <
      ranked.indexOf(
        scheduled.items.find((item) => item.id === children[0].id),
      ),
  );
  assert.deepEqual(
    ranked
      .filter((item) => materialized.childIds.includes(item.id))
      .map((item) => item.id),
    materialized.childIds,
  );
  assert.equal(
    schedulingObservations(scheduled, schedulingWork).get(children[0].id)
      .rankingBasis,
    "declared-duration",
  );
  const scheduledChildren = scheduled.items.filter((item) =>
    materialized.childIds.includes(item.id),
  );
  for (const item of scheduledChildren) item.resources = ["migration-check"];
  assert.equal(
    pendingItemBlocker(
      scheduled,
      schedulingWork,
      scheduledChildren[1],
      new Set([scheduledChildren[0].id]),
      new Set([envelope.id]),
    ).kind,
    "resource",
  );
  assert.deepEqual(
    children.map((item) => item.ownedPaths),
    [["src/api.ts", "src/helper.ts"], ["src/ui/view.ts"]],
  );
  assert.equal(
    new Set(children.flatMap((item) => item.ownedPaths)).size,
    body.entries.length,
  );
  assertExpansionCoverage(graph, materialized.graph);
  assert.deepEqual(
    materialized.graph.items.find((item) => item.id === "integration")
      .dependencies,
    [inventory.id, "join", ...materialized.childIds],
  );
  assert.deepEqual(
    materialized.graph.items.find((item) => item.id === "join").dependencies,
    ["independent", inventory.id, ...materialized.childIds],
  );
  for (const child of children) {
    assert.deepEqual(child.dependencies, [inventory.id]);
    assert.deepEqual(child.discoveryInputs[0].fields, [
      "path",
      "mode",
      "blobSha",
      "contentRef",
    ]);
    waiting[child.id] = { status: "done" };
  }
  assert.deepEqual(readyItems(materialized.graph, waiting, new Set(), 4), []);
  assert.deepEqual(
    readyItems(
      materialized.graph,
      waiting,
      new Set(),
      4,
      new Set([envelope.id]),
    ).map((item) => item.id),
    ["join"],
  );
  waiting.join.status = "done";
  assert.deepEqual(
    readyItems(
      materialized.graph,
      waiting,
      new Set(),
      4,
      new Set([envelope.id]),
    ).map((item) => item.id),
    ["integration"],
  );
  assert.equal(
    linearDeliveryUnits(materialized.graph).find((unit) =>
      unit.items.some((item) => item.id === "integration"),
    ).items.length,
    1,
  );
  const packetRef = store.putBytes(
    Buffer.from(JSON.stringify(materialized.inputPacket)),
    { mediaType: "application/json" },
  );
  // Expansion receipt scope reduces each worker's input to its complete batch,
  // while the original ordinary consumer still receives the full inventory.
  const expandedState = {
    repository: "fixture/adaptive-discovery",
    objective: producer.objective,
    runId: producer.runId,
    configDigest: "a".repeat(64),
    baseSha,
    planGraphDigest: graphDigest(graph),
    graph: materialized.graph,
    work: { ...state.work, ...waiting },
    expansionHistory: [
      {
        schemaVersion: 1,
        id: `${envelope.id}-${materialized.digest}`,
        envelopeId: envelope.id,
        parentGraphDigest: graphDigest(graph),
        graphDigest: graphDigest(materialized.graph),
        envelopeDigest: materialized.envelopeDigest,
        materializationDigest: materialized.digest,
        inputPacketRef: packetRef,
        childIds: materialized.childIds,
        acceptedAt: new Date().toISOString(),
      },
    ],
  };
  expandedState.work.inventory = state.work.inventory;
  for (const child of children) {
    const input = await selectedDiscoveryInputs({
      state: expandedState,
      item: child,
      checkout,
      store,
    });
    assert.deepEqual(
      input[0].entries.map((entry) => entry.path),
      child.ownedPaths,
    );
    assert.deepEqual(input[0].selectionScope.paths, child.ownedPaths);
    assert.equal(input[0].selectionScope.complete, true);
    for (const entry of input[0].entries)
      assert.deepEqual(
        Buffer.from(entry.contentBody.bytes, "base64"),
        execFileSync("git", [
          "-C",
          checkout,
          "show",
          `${baseSha}:${entry.path}`,
        ]),
      );
  }
  const pinnedSources = ["src/api.ts", "notes.txt"].map((path) => ({
    path,
    content: execFileSync(
      "git",
      ["-C", checkout, "show", `${baseSha}:${path}`],
      { encoding: "utf8" },
    ),
  }));
  // The real controller hydration keeps the graph wire's empty full-file heading.
  const citedGraph = {
    items: [
      {
        ...children[0],
        citations: [
          ...pinnedSources.map((source) => ({
            path: source.path,
            heading: "",
          })),
          { path: "notes.txt", heading: "Migration notes" },
        ],
      },
    ],
  };
  hydrateWorkerInputSources(citedGraph, pinnedSources);
  const sources = citedGraph.items[0].inputSources.slice(0, 2);
  assert.deepEqual(
    sources.map((source) => source.heading),
    ["", ""],
  );
  assert.deepEqual(
    sources.map((source) => source.content),
    pinnedSources.map((source) => source.content),
  );
  const sectionSource = citedGraph.items[0].inputSources[2];
  assert.equal(sectionSource.heading, "Migration notes");
  const retainedSources = retainPlanningSourceMemory({
    repository: expandedState.repository,
    objective: producer.objective,
    runId: producer.runId,
    baseSha,
    treeSha: git("rev-parse", "HEAD^{tree}"),
    configDigest: expandedState.configDigest,
    sources,
  });
  const sourceMemory = new LocalRepositoryMemory(
    stateRoot(expandedState.repository),
    expandedState.repository,
  );
  const sourceLookup = {
    access: {
      repository: expandedState.repository,
      visibility: ["private", "repository"],
    },
    scope: { objective: producer.objective, paths: ["src/", "notes.txt"] },
    limit: 64,
  };
  for (const [index, binding] of retainedSources.entries()) {
    const retained = sourceMemory.read({ ...sourceLookup, id: binding.id });
    assert.equal(retained.record.sources[0].heading, undefined);
    assert.deepEqual(retained.record.bindings.paths, [
      { path: sources[index].path, digest: retained.content[0].ref.digest },
    ]);
    assert.equal(retained.content[0].text, sources[index].content);
  }
  const [sectionBinding] = retainPlanningSourceMemory({
    repository: expandedState.repository,
    objective: producer.objective,
    runId: producer.runId,
    baseSha,
    treeSha: git("rev-parse", "HEAD^{tree}"),
    configDigest: expandedState.configDigest,
    sources: [sectionSource],
  });
  const retainedSection = sourceMemory.read({
    ...sourceLookup,
    id: sectionBinding.id,
  });
  assert.equal(
    retainedSection.record.sources[0].heading,
    sectionSource.heading,
  );
  assert.equal(retainedSection.record.bindings.paths, undefined);
  assert.equal(retainedSection.content[0].text, sectionSource.content);
  const suppliedSources = sources.map((source) => ({
    path: source.path,
    heading: source.heading,
    digest: createHash("sha256").update(source.content).digest("hex"),
  }));
  const sourceCatalog = sourceMemory.metadata({
    ...sourceLookup,
    suppliedSources,
  });
  assert.equal(sourceCatalog.complete, true);
  assert.deepEqual(
    sourceCatalog.entries.map((entry) => entry.binding.id),
    [sectionBinding.id],
  );
  assert.deepEqual(
    sourceMemory.metadata({
      ...sourceLookup,
      suppliedSources: [
        ...suppliedSources,
        {
          path: sectionSource.path,
          heading: sectionSource.heading,
          digest: retainedSection.content[0].ref.digest,
        },
      ],
    }).entries,
    [],
  );
  assert.throws(
    () =>
      sourceMemory.metadata({
        ...sourceLookup,
        suppliedSources: [
          { ...suppliedSources[0], heading: "Migration\0notes" },
        ],
      }),
    /no NUL/,
  );
  expandedState.planningRecovery = {
    contextLookup: {
      packet: {
        schemaVersion: 1,
        binding: "b".repeat(64),
        bounds: {
          maxRounds: 1,
          maxRequestsPerRound: 1,
          maxResults: 8,
          maxBytes: 1,
          maxElapsedMs: 30000,
          maxProviderCalls: 1,
        },
        catalog: ["repository", "memory"].map((id) => ({
          id,
          selectors: ["src/", "notes.txt"],
          operations: ["read"],
          freshness: "Pinned source",
          completeness: "complete",
        })),
        automatic: [],
        batches: [],
      },
    },
  };
  const selectedBatch = await selectedDiscoveryInputs({
    state: expandedState,
    item: children[0],
    checkout,
    store,
  });
  const interfaceRef = store.putBytes(Buffer.from(sources[1].content), {
    mediaType: "text/plain",
  });
  const required = {
    discoveryInputs: selectedBatch,
    sharedInterface: { path: "notes.txt", content: sources[1].content },
  };
  const contextInput = {
    state: expandedState,
    role: "dispatch",
    item: children[0],
    baseSha,
    checkout,
    store,
    sources,
    required,
    requiredSelections: [
      {
        id: "migration-inventory",
        kind: "discovery",
        disposition: "current",
        required: true,
        refs: body.entries
          .filter((entry) => children[0].ownedPaths.includes(entry.path))
          .map((entry) => entry.content),
      },
      {
        id: "migration-interface",
        kind: "interface",
        disposition: "current",
        required: true,
        refs: [interfaceRef],
      },
    ],
    save: () => undefined,
  };
  const context = await buildAdaptiveContext(contextInput);
  assert.deepEqual(context.payload.required, required);
  assert.ok(Buffer.byteLength(JSON.stringify(required)) > 1);
  assert.equal(
    context.packet.selections.filter(
      (selection) => selection.kind === "supplied",
    ).length,
    sources.length,
  );
  // Already supplied source bodies are excluded before optional byte accounting.
  assert.deepEqual(context.payload.memory, []);
  assert.deepEqual(context.packet.unavailable, []);
  const restartedStore = new LocalContentStore(join(root, "content"));
  const restartedContext = await buildAdaptiveContext({
    ...contextInput,
    state: JSON.parse(JSON.stringify(expandedState)),
    store: restartedStore,
    save: () => assert.fail("Exact retained context should be reused"),
  });
  assert.equal(restartedContext.packet.id, context.packet.id);
  assert.deepEqual(
    await authenticateAdaptiveContextPacket(
      restartedStore,
      restartedContext.packet,
    ),
    context.payload,
  );
  const contextPath = join(
    root,
    "content",
    context.packet.contentRef.digest.slice(0, 2),
    context.packet.contentRef.digest,
  );
  const contextBytes = readFileSync(contextPath);
  rmSync(contextPath);
  await assert.rejects(
    authenticateAdaptiveContextPacket(restartedStore, context.packet),
    /ENOENT|unavailable|missing/,
  );
  writeFileSync(contextPath, "corrupt role context");
  await assert.rejects(
    authenticateAdaptiveContextPacket(restartedStore, context.packet),
    /digest verification/,
  );
  writeFileSync(contextPath, contextBytes);
  // Two attributable observations retain one actual Git source body. Optional
  // accounting includes their summaries, provenance and selection descriptors.
  const memoryStore = new LocalContentStore(
    join(stateRoot(expandedState.repository), "content"),
  );
  const memory = new LocalRepositoryMemory(
    stateRoot(expandedState.repository),
    expandedState.repository,
    memoryStore,
  );
  const observedRef = memoryStore.putBytes(Buffer.from(sources[1].content), {
    mediaType: "text/plain",
  });
  const observations = ["first-source-read", "second-source-read"].map(
    (identity) =>
      memory.retain({
        schemaVersion: 1,
        repository: expandedState.repository,
        visibility: "repository",
        kind: "observation",
        producer: {
          objective: producer.objective,
          runId: producer.runId,
          identity,
          itemId: "join",
          status: "observed",
        },
        createdAt: new Date().toISOString(),
        authority: "observation",
        summary: "Shared migration notes observed from the pinned source.",
        bodies: [
          {
            role: "migration-notes",
            ref: observedRef,
            availability: "retained",
          },
        ],
        sources: [
          {
            identity: "repository:notes.txt",
            path: "notes.txt",
            commitSha: baseSha,
            treeSha: git("rev-parse", "HEAD^{tree}"),
            complete: true,
            ref: observedRef,
          },
        ],
        bindings: {
          treeSha: git("rev-parse", "HEAD^{tree}"),
          paths: [
            {
              path: sources[0].path,
              digest: createHash("sha256")
                .update(sources[0].content)
                .digest("hex"),
            },
          ],
          environment: { configDigest: expandedState.configDigest },
        },
        validity: { state: "current", conditions: [] },
        supersedes: [],
      }),
  );
  assert.notEqual(observations[0].id, observations[1].id);
  const advisoryState = structuredClone(expandedState);
  const allowance = 65536;
  advisoryState.planningRecovery.contextLookup.packet.bounds.maxBytes =
    allowance;
  const advisoryInput = {
    ...contextInput,
    state: advisoryState,
    role: "diagnosis",
    item: materialized.graph.items.find((item) => item.id === "join"),
    sources: [sources[0]],
    required: {},
    requiredSelections: [],
  };
  const advisory = await buildAdaptiveContext(advisoryInput);
  const observationMatches = advisory.payload.memory.filter((match) =>
    observations.some((binding) => binding.id === match.binding.id),
  );
  assert.equal(observationMatches.length, 2);
  assert.ok(
    observationMatches.every((match) => match.disposition === "current"),
  );
  const observedBodies = advisory.payload.memory
    .flatMap((match) => match.content)
    .filter((body) => body.ref.digest === observedRef.digest);
  assert.deepEqual(
    observedBodies
      .filter((body) => body.text !== undefined)
      .map((body) => body.text),
    [sources[1].content],
  );
  assert.match(observationMatches[1].content[0].reuse, /^memory:/);
  const serializedCost = advisory.payload.memory.reduce(
    (total, match) =>
      total +
      Buffer.byteLength(
        JSON.stringify({
          match,
          selection: advisory.packet.selections.find(
            (selection) => selection.id === `memory:${match.binding.id}`,
          ),
        }),
      ),
    0,
  );
  assert.ok(serializedCost <= allowance);
  assert.ok(serializedCost > observedRef.bytes);
  const boundedState = structuredClone(expandedState);
  boundedState.planningRecovery.contextLookup.packet.bounds.maxBytes =
    observedRef.bytes + 1;
  const bounded = await buildAdaptiveContext({
    ...advisoryInput,
    state: boundedState,
    role: "expansion",
  });
  assert.deepEqual(bounded.payload.memory, []);
  for (const observation of observations) {
    assert.ok(
      bounded.packet.unavailable.includes(
        `Optional memory ${observation.id} deferred by serialized byte allowance`,
      ),
    );
    const selection = bounded.packet.selections.find(
      (selection) => selection.id === `memory:${observation.id}`,
    );
    assert.equal(selection.disposition, "incomplete");
    assert.deepEqual(selection.refs, []);
  }
  writeFileSync(
    join(checkout, "src", "helper.ts"),
    "Working copy changed after materialization\n",
  );
  const retainedPacket = JSON.parse(
    store.readBytes(packetRef).toString("utf8"),
  );
  const reloaded = materializeGraphExpansion({
    graph: JSON.parse(JSON.stringify(graph)),
    envelopeId: retainedPacket.envelope.id,
    manifest: retainedPacket.manifest,
    body: retainedPacket.body,
    runId: retainedPacket.runId,
    iteration: retainedPacket.iteration,
  });
  assert.deepEqual(reloaded, materialized);
  assert.throws(
    () =>
      materializeGraphExpansion({
        graph,
        envelopeId: envelope.id,
        manifest,
        body,
        runId: producer.runId,
        iteration: 1,
        immutableItemIds: ["integration"],
      }),
    /started or completed integration barrier/,
  );
  const emptySpec = { ...specification, selectors: ["missing/"] };
  const empty = await discoverRepository({
    checkout,
    baseSha,
    specification: emptySpec,
    producer,
    store,
  });
  assert.equal(empty.status, "complete");
  assert.equal(empty.selectedEntries, 0);
  assert.deepEqual(
    (
      await authenticateDiscoveryOutput({
        checkout,
        specification: emptySpec,
        manifest: empty,
        store,
      })
    ).entries,
    [],
  );
  const emptyGraph = structuredClone(graph);
  emptyGraph.items.find((item) => item.id === inventory.id).discovery =
    emptySpec;
  emptyGraph.expansions[0].selectors = emptySpec.selectors;
  emptyGraph.expansions[0].template.ownedPaths = emptySpec.selectors;
  const emptyBody = await authenticateDiscoveryOutput({
    checkout,
    specification: emptySpec,
    manifest: empty,
    store,
  });
  const emptyExpansion = materializeGraphExpansion({
    graph: emptyGraph,
    envelopeId: envelope.id,
    manifest: empty,
    body: emptyBody,
    runId: producer.runId,
    iteration: 1,
  });
  assert.deepEqual(emptyExpansion.childIds, []);
  assertExpansionCoverage(emptyGraph, emptyExpansion.graph);
  assert.deepEqual(
    readyItems(
      emptyExpansion.graph,
      waiting,
      new Set(),
      4,
      new Set([envelope.id]),
    ).map((item) => item.id),
    ["integration"],
  );
  assert.throws(
    () =>
      assertCompletedCoverage({ graph: emptyExpansion.graph, work: waiting }),
    /completed exact-tree proof/,
  );
  // Declared conditions use this exact real Git inventory and ordinary atomic state.
  // The opposite branch settles without a worker; the unconditional original proof remains pending.
  const routingConfig = {
    schemaVersion: 1,
    repository: "fixture/conditions",
    checkout,
    planning: {
      kind: "codex-sdk",
      planner: { model: "unused-local-check", reasoningEffort: "low" },
      reviewer: { model: "unused-local-check", reasoningEffort: "low" },
    },
    execution: {
      kind: "local",
      concurrency: 1,
      harness: {
        kind: "codex-sdk",
        model: "unused-local-check",
        reasoningEffort: "low",
      },
    },
    delivery: { kind: "regular" },
    policy: { network: "off", allowedSecretNames: [] },
    planningContext: {
      enabled: true,
      memory: false,
      selectors: ["src/", ...emptySpec.selectors],
      bounds: {
        maxRounds: 1,
        maxRequestsPerRound: 1,
        maxResults: 4,
        maxBytes: 2048,
        maxElapsedMs: 5000,
        maxProviderCalls: 1,
      },
    },
  };
  // Equal recipe queries retain separate controller scopes, including unresolved facts.
  const memoryDefinition = {
    ...localDefinition,
    version: 5,
    memoryInputs: [
      {
        id: "notes",
        query: "Shared migration notes",
        selectors: ["notes.txt"],
        kinds: ["observation"],
        required: true,
      },
      {
        id: "source",
        query: "Shared migration notes",
        selectors: ["src/"],
        kinds: ["observation"],
        required: true,
      },
    ],
  };
  const memoryRecipeBase = revision(memoryDefinition);
  const memoryRecipe = await retainWorkflowRecipe(
    resolveWorkflowRecipe({
      selection: { ...recipeSelection, selector: localDefinition.id },
      checkout,
      baseSha: memoryRecipeBase,
      maxBytes: 65536,
    }),
    store,
  );
  const recipeMemoryConfig = {
    ...routingConfig,
    repository: "fixture/recipe-required-memory",
    planningContext: {
      ...routingConfig.planningContext,
      memory: true,
      selectors: ["src/", "notes.txt"],
      bounds: {
        ...routingConfig.planningContext.bounds,
        maxResults: 8,
        maxBytes: 65536,
      },
    },
  };
  const recipeMemoryStore = new LocalContentStore(
    join(stateRoot(recipeMemoryConfig.repository), "content"),
  );
  const recipeMemoryBody = recipeMemoryStore.putBytes(
    readFileSync(join(checkout, "notes.txt")),
    { mediaType: "text/plain" },
  );
  const recipeMemoryCatalog = new LocalRepositoryMemory(
    stateRoot(recipeMemoryConfig.repository),
    recipeMemoryConfig.repository,
    recipeMemoryStore,
  );
  recipeMemoryCatalog.retain({
    schemaVersion: 1,
    repository: recipeMemoryConfig.repository,
    visibility: "repository",
    kind: "observation",
    producer: {
      objective: producer.objective,
      runId: producer.runId,
      identity: "recipe-scoped-notes",
      status: "observed",
    },
    createdAt: new Date().toISOString(),
    authority: "observation",
    summary: "Shared migration notes",
    bodies: [
      { role: "notes", ref: recipeMemoryBody, availability: "retained" },
    ],
    sources: [
      {
        identity: "repository:notes.txt",
        path: "notes.txt",
        commitSha: memoryRecipeBase,
        complete: true,
        ref: recipeMemoryBody,
      },
    ],
    bindings: { treeSha: git("rev-parse", `${memoryRecipeBase}^{tree}`) },
    validity: { state: "current", conditions: [] },
    supersedes: [],
  });
  const recipeResolver = () =>
    createPlanningContextResolver({
      config: recipeMemoryConfig,
      objective: producer.objective,
      runId: producer.runId,
      baseSha: memoryRecipeBase,
      sources: [],
      objectiveBody: recipeBody,
      contentStore: store,
      workflowRecipe: memoryRecipe,
    });
  const recipeMemoryPath = join(
    stateRoot(recipeMemoryConfig.repository),
    "content",
    recipeMemoryBody.digest.slice(0, 2),
    recipeMemoryBody.digest,
  );
  const recipeMemoryBytes = readFileSync(recipeMemoryPath);
  writeFileSync(recipeMemoryPath, "corrupt scoped recipe body");
  const unresolvedRecipe = await initializeContextLookup(recipeResolver());
  const requiredReceipts = unresolvedRecipe.packet.automatic.filter(
    (result) => result.request.required,
  );
  assert.equal(requiredReceipts[0].disposition, "unavailable");
  assert.equal(requiredReceipts[1].disposition, "no-match");
  assert.throws(
    () => assertContextFactsResolved(unresolvedRecipe.packet),
    /recipe-memory-notes/,
  );
  writeFileSync(recipeMemoryPath, recipeMemoryBytes);
  const resolver = recipeResolver();
  const resolvedRecipe = await initializeContextLookup(resolver);
  assertWorkflowRecipeContext(resolvedRecipe.packet, memoryRecipe);
  assertContextFactsResolved(resolvedRecipe.packet);
  const scopedReceipts = resolvedRecipe.packet.automatic.filter(
    (result) => result.request.required,
  );
  assert.equal(scopedReceipts[0].disposition, "complete");
  assert.equal(scopedReceipts[1].disposition, "no-match");
  assert.ok(
    scopedReceipts[0].matches[0].content.includes("Shared migration notes"),
  );
  const [reserved] = await resolveContextRequests(resolvedRecipe, resolver, [
    {
      ...scopedReceipts[0].request,
      id: "recipe-memory-undeclared",
      required: false,
    },
  ]);
  assert.equal(reserved.disposition, "denied");
  const [ordinaryQuery] = await resolveContextRequests(
    resolvedRecipe,
    resolver,
    [
      {
        ...scopedReceipts[0].request,
        id: "ordinary-notes-query",
        required: false,
      },
    ],
  );
  assert.equal(ordinaryQuery.disposition, "complete");
  assert.doesNotMatch(ordinaryQuery.detail, /Reused retained exact result/);
  const lookup = await initializeContextLookup(
    createPlanningContextResolver({
      config: routingConfig,
      objective: producer.objective,
      runId: producer.runId,
      baseSha,
      sources: [],
      objectiveBody: "## Adaptive workflow\nenabled\n",
      contentStore: store,
    }),
  );
  // Roundtrip the current adaptive wire's required literal empty selections,
  // using this workflow's pinned Git Sources and actual retained lookup packet.
  const { renderCompilationCall } = await import("../dist/compiler/model.js");
  const { installedControllerCapabilities, CONTROLLER_CAPABILITIES_DIGEST } =
    await import("../dist/controller-capabilities.js");
  const compilation = renderCompilationCall({
    objective: criterion,
    baseSha,
    sources: [{ path: "OBJECTIVE", content: criterion }, ...sources],
    compileContext: {
      objectiveNumber: producer.objective,
      instructions: "Preserve the migration contract.",
    },
    coverageObligations: graph.coverage.map(
      ({ itemId, proof, environment, ...obligation }) => obligation,
    ),
    contextLookup: lookup.packet,
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
  });
  assert.match(
    compilation.call.prompt,
    /Return empty discoveryInputs when none are needed/,
  );
  const wireGraph = {
    contextId: compilation.wire.data.contextId,
    requiredPreIntegrationChecks: [],
    expansions: [],
    conditions: [],
    items: graph.items
      .filter((item) => !item.kind)
      .map((item) => ({
        ...item,
        kind: "work",
        citations: [{ choiceIndex: 0 }],
        children: [],
        newPackages: [],
        priority: 0,
        resources: [],
        sourceAssets: [],
        scheduling: null,
        condition: null,
      })),
    coverage: [
      {
        itemId: "join",
        proof: { kind: "result-semantic", acceptanceIndex: 0 },
        environment: {
          kind: "local",
          readiness: "available",
          probeValidationIndex: null,
          prerequisiteValidationIndices: [],
          preparedBy: "",
        },
      },
    ],
  };
  const decoded = compilation.wire.decode({
    contextId: wireGraph.contextId,
    outcome: { kind: "graph", graph: wireGraph },
  }).graph;
  assert.deepEqual(
    decoded.items.map((item) => item.discoveryInputs),
    [[], []],
  );
  assert.deepEqual(
    validateAndOrderGraph(
      decoded,
      producer.objective,
      baseSha,
      new Set(["OBJECTIVE", ...sources.map((source) => source.path)]),
    ).map((item) => item.id),
    ["independent", "join"],
  );
  const routeDefaults = {
    ...common,
    resources: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    requiredLfsRoles: [],
    minimumAssetSets: 0,
  };
  const condition = {
    schemaVersion: 1,
    id: "empty-inventory",
    input: {
      producerItemId: inventory.id,
      role: specification.role,
      schema: specification.schema,
    },
    predicate: { kind: "inventory-empty" },
  };
  const routeGraph = {
    objective: producer.objective,
    baseSha,
    conditions: [condition],
    items: [
      { ...routeDefaults, ...inventory },
      {
        ...routeDefaults,
        id: "has-files",
        ownedPaths: ["src/"],
        dependencies: [inventory.id],
        condition: { conditionId: condition.id, when: false },
      },
      {
        ...routeDefaults,
        id: "no-files",
        ownedPaths: ["notes.txt"],
        dependencies: [inventory.id],
        condition: { conditionId: condition.id, when: true },
      },
      {
        ...routeDefaults,
        id: "integration",
        kind: "qa",
        dependencies: [inventory.id, "has-files", "no-files"],
      },
    ],
    coverage: structuredClone(graph.coverage),
  };
  validateAndOrderGraph(
    routeGraph,
    producer.objective,
    baseSha,
    new Set(["OBJECTIVE"]),
  );
  const invalidPublishedCi = structuredClone(routeGraph);
  invalidPublishedCi.coverage[0].proof = {
    kind: "published-ci",
    checkName: "gate",
    targetItem: "has-files",
  };
  assert.throws(
    () =>
      validateAndOrderGraph(
        invalidPublishedCi,
        producer.objective,
        baseSha,
        new Set(["OBJECTIVE"]),
      ),
    /Published CI cannot require a conditional branch delivery/,
  );
  const invalidPreparation = structuredClone(routeGraph);
  invalidPreparation.coverage[0].environment.readiness = "prepare";
  invalidPreparation.coverage[0].environment.preparedBy = "has-files";
  assert.throws(
    () =>
      validateAndOrderGraph(
        invalidPreparation,
        producer.objective,
        baseSha,
        new Set(["OBJECTIVE"]),
      ),
    /Mandatory environment preparation cannot depend on a conditional branch/,
  );
  const invalidAggregate = structuredClone(routeGraph);
  invalidAggregate.items.push({
    ...routeDefaults,
    id: "branch-aggregate",
    kind: "aggregate",
    children: ["has-files"],
    dependencies: ["has-files"],
    acceptance: aggregateAcceptance({ id: "branch-aggregate" }),
  });
  assert.throws(
    () =>
      validateAndOrderGraph(
        invalidAggregate,
        producer.objective,
        baseSha,
        new Set(["OBJECTIVE"]),
      ),
    /explicit aggregate child/,
  );
  const routeState = {
    schemaVersion: 13,
    repository: routingConfig.repository,
    objective: producer.objective,
    runId: producer.runId,
    configDigest: "a".repeat(64),
    baseSha,
    graph: routeGraph,
    planGraphDigest: graphDigest(routeGraph),
    capacity: { concurrency: 1 },
    autonomy: resolveAutonomy(),
    coordinator: {
      mode: "running",
      phase: "execution",
      phaseStartedAt: new Date().toISOString(),
    },
    planningRecovery: { phase: "ready", history: [], contextLookup: lookup },
    issueByItemId: {
      inventory: 41,
      "has-files": 42,
      "no-files": 43,
      integration: 44,
    },
    work: {
      inventory: {
        status: "done",
        attempt: producer.attemptId,
        baseSha,
        discoveryOutput: manifest,
      },
      "has-files": { status: "pending" },
      "no-files": { status: "pending" },
      integration: { status: "pending" },
    },
  };
  const missingRoutingAdmission = structuredClone(routeState);
  delete missingRoutingAdmission.planningRecovery.contextLookup;
  for (const schemaVersion of [13, 17]) {
    missingRoutingAdmission.schemaVersion = schemaVersion;
    assert.throws(
      () =>
        parseFactoryState(
          missingRoutingAdmission,
          routingConfig.repository,
          producer.objective,
        ),
      /requires its original admitted planning context/,
    );
  }
  const checkpointRoutingAdmission = structuredClone(routeState);
  checkpointRoutingAdmission.schemaVersion = 17;
  parseFactoryState(
    checkpointRoutingAdmission,
    routingConfig.repository,
    producer.objective,
  );
  const snapshot = join(root, "routing-state.json");
  const routeArgs = {
    config: routingConfig,
    state: routeState,
    store,
    save: () => saveState(snapshot, routeState),
    cancelled: () => false,
  };
  await settleWorkRouting(routeArgs);
  assert.equal(routeState.work["has-files"].routing.disposition, "selected");
  assert.equal(routeState.work["no-files"].status, "skipped");
  assert.equal(routeState.work["no-files"].attempt, undefined);
  assert.equal(routeState.work["no-files"].validation, undefined);
  assert.equal(routeState.work["no-files"].pullRequest, undefined);
  assert.deepEqual(
    readyItems(routeGraph, routeState.work, new Set(), 2).map(
      (item) => item.id,
    ),
    ["has-files"],
  );
  assert.throws(
    () => assertCompletedCoverage(routeState),
    /completed exact-tree proof/,
  );
  assert.deepEqual(routeState.graph.coverage, graph.coverage);
  const restored = parseFactoryState(
    JSON.parse(readFileSync(snapshot, "utf8")),
    routingConfig.repository,
    producer.objective,
  );
  await authenticateWorkRouting({
    config: routingConfig,
    state: restored,
    store: new LocalContentStore(join(root, "content")),
  });
  await settleWorkRouting({
    ...routeArgs,
    state: restored,
    save: () =>
      assert.fail("An unchanged routing receipt must not be rewritten"),
  });
  const changedBinding = structuredClone(restored);
  changedBinding.graph.items.find(
    (item) => item.id === "no-files",
  ).condition.when = false;
  assert.throws(
    () => assertWorkRoutingState(changedBinding),
    /admitted branch binding/,
  );
  const fabricatedAttempt = structuredClone(restored);
  fabricatedAttempt.work["no-files"].attempt = "fabricated";
  assert.throws(
    () => assertWorkRoutingState(fabricatedAttempt),
    /owned attempt/,
  );
  const receipt = routeState.conditionFacts[condition.id];
  const receiptPath = join(
    root,
    "content",
    receipt.inputPacketRef.digest.slice(0, 2),
    receipt.inputPacketRef.digest,
  );
  const receiptBytes = readFileSync(receiptPath);
  rmSync(receiptPath);
  await assert.rejects(
    authenticateWorkRouting({ config: routingConfig, state: restored, store }),
    /Retained condition facts are unavailable/,
  );
  writeFileSync(receiptPath, receiptBytes);
  // A genuinely empty complete inventory skips the sole implementation branch; QA still owes its proof on the pinned baseline.
  const emptyRoute = structuredClone(routeState);
  delete emptyRoute.conditionFacts;
  emptyRoute.graph.items = emptyRoute.graph.items.filter(
    (item) => item.id !== "no-files",
  );
  emptyRoute.graph.items.find((item) => item.id === "inventory").discovery =
    emptySpec;
  emptyRoute.graph.items.find(
    (item) => item.id === "integration",
  ).dependencies = [inventory.id, "has-files"];
  emptyRoute.planGraphDigest = graphDigest(emptyRoute.graph);
  delete emptyRoute.issueByItemId["no-files"];
  delete emptyRoute.work["no-files"];
  emptyRoute.work["has-files"] = { status: "pending" };
  emptyRoute.work.inventory.discoveryOutput = empty;
  await settleWorkRouting({
    ...routeArgs,
    state: emptyRoute,
    save: () => saveState(snapshot, emptyRoute),
  });
  assert.equal(emptyRoute.work["has-files"].status, "skipped");
  assert.deepEqual(objectiveCandidate(emptyRoute), {
    basis: "pinned-baseline",
    commitSha: baseSha,
  });
  assert.deepEqual(
    readyItems(emptyRoute.graph, emptyRoute.work, new Set(), 2).map(
      (item) => item.id,
    ),
    ["integration"],
  );
  assert.throws(
    () => assertCompletedCoverage(emptyRoute),
    /completed exact-tree proof/,
  );
  // Even after local closure checkpoints settle, observations and skips supply no QA acceptance.
  const reviewReadiness = structuredClone(emptyRoute);
  reviewReadiness.work.inventory.githubClosure = "complete";
  reviewReadiness.work["has-files"].githubClosure = "complete";
  parseFactoryState(
    reviewReadiness,
    routingConfig.repository,
    producer.objective,
  );
  assert.throws(
    () =>
      objectiveReviewEvidence({
        state: reviewReadiness,
        checkout,
        candidateCommitSha: baseSha,
        candidateTreeSha: git("rev-parse", `${baseSha}^{tree}`),
      }),
    /Work Item integration lacks complete final-review identity/,
  );
  // Missing producer output never routes as false, and a held operator decision keeps its owner pending.
  const unknownRoute = structuredClone(routeState);
  delete unknownRoute.conditionFacts;
  unknownRoute.work.inventory = { status: "pending" };
  unknownRoute.work["has-files"] = { status: "pending" };
  unknownRoute.work["no-files"] = { status: "pending" };
  await settleWorkRouting({
    ...routeArgs,
    state: unknownRoute,
    save: () => saveState(snapshot, unknownRoute),
  });
  assert.equal(unknownRoute.work["has-files"].routing.disposition, "held");
  assert.equal(unknownRoute.work["no-files"].routing.disposition, "held");
  assert.deepEqual(
    readyItems(unknownRoute.graph, unknownRoute.work, new Set(), 2).map(
      (item) => item.id,
    ),
    ["inventory"],
  );
  // The supported cancellation disposition keeps absent and held condition facts unresolved through atomic reload.
  const cancelledHeld = structuredClone(unknownRoute);
  cancelledHeld.cancelRequested = true;
  for (const work of Object.values(cancelledHeld.work))
    work.status = "cancelled";
  saveState(snapshot, cancelledHeld);
  cancelledHeld.cancelledAt = new Date().toISOString();
  saveState(snapshot, cancelledHeld);
  const restoredCancellation = parseFactoryState(
    JSON.parse(readFileSync(snapshot, "utf8")),
    routingConfig.repository,
    producer.objective,
  );
  assert.equal(
    restoredCancellation.work["has-files"].routing.disposition,
    "held",
  );
  assert.equal(
    restoredCancellation.work["no-files"].routing.disposition,
    "held",
  );
  assert.equal(restoredCancellation.conditionFacts, undefined);
  assert.equal(restoredCancellation.work["has-files"].attempt, undefined);
  const cancelledAbsent = structuredClone(cancelledHeld);
  delete cancelledAbsent.work["has-files"].routing;
  delete cancelledAbsent.work["no-files"].routing;
  for (const work of Object.values(cancelledAbsent.work))
    work.completedAt = new Date().toISOString();
  saveState(snapshot, cancelledAbsent);
  parseFactoryState(
    JSON.parse(readFileSync(snapshot, "utf8")),
    routingConfig.repository,
    producer.objective,
  );
  const cancellationNotRecorded = structuredClone(cancelledHeld);
  delete cancellationNotRecorded.cancelRequested;
  delete cancellationNotRecorded.cancelledAt;
  assert.throws(
    () => assertWorkRoutingState(cancellationNotRecorded),
    /Unknown condition cannot start or skip/,
  );
  const cancellationStillOwned = structuredClone(cancelledHeld);
  cancellationStillOwned.work["has-files"].phaseReservation = "coding";
  assert.throws(
    () => assertWorkRoutingState(cancellationStillOwned),
    /Unknown condition cannot start or skip/,
  );
  const operatorRoute = structuredClone(routeState);
  delete operatorRoute.conditionFacts;
  operatorRoute.work["has-files"] = { status: "pending" };
  operatorRoute.work["no-files"] = {
    status: "pending",
    wait: {
      kind: "decision",
      detail: "Retained operator choice",
      step: "item/no-files/execute",
    },
  };
  await settleWorkRouting({
    ...routeArgs,
    state: operatorRoute,
    save: () => saveState(snapshot, operatorRoute),
  });
  assert.equal(operatorRoute.work["no-files"].status, "pending");
  assert.equal(operatorRoute.work["no-files"].routing, undefined);
  assert.equal(
    operatorRoute.work["no-files"].wait.detail,
    "Retained operator choice",
  );
  const boundedSpec = {
    ...specification,
    allowance: { ...specification.allowance, maxBytes: 1 },
  };
  const truncated = await discoverRepository({
    checkout,
    baseSha,
    specification: boundedSpec,
    producer,
    store,
  });
  assert.equal(truncated.status, "truncated");
  assert.throws(
    () =>
      materializeGraphExpansion({
        graph,
        envelopeId: envelope.id,
        manifest: truncated,
        body,
        runId: producer.runId,
        iteration: 1,
      }),
    /complete exact producer-bound/,
  );
  await authenticateDiscoveryOutput({
    checkout,
    specification: boundedSpec,
    manifest: truncated,
    store,
  });
  state.work.inventory.discoveryOutput = truncated;
  await assert.rejects(
    selectedDiscoveryInputs({ state, item: consumer, checkout, store }),
    /incomplete/,
  );
  await assert.rejects(
    authenticateDiscoveryOutput({
      checkout,
      specification,
      manifest: {
        ...manifest,
        source: { ...manifest.source, selectors: ["private.txt"] },
      },
      store,
    }),
    /binding differs/,
  );
  assert.equal(git("rev-parse", "HEAD"), baseSha);
  assert.equal(git("show-ref"), refsBefore);
  writeFileSync(
    join(
      root,
      "content",
      body.entries[0].content.digest.slice(0, 2),
      body.entries[0].content.digest,
    ),
    "corrupt retained source",
  );
  state.work.inventory.discoveryOutput = manifest;
  await assert.rejects(
    selectedDiscoveryInputs({ state, item: consumer, checkout, store }),
    /digest verification/,
  );
});

test("memory source admission precedes same-Objective relevance and binary bodies stay exact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-memory-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(join(checkout, "secret"));
  writeFileSync(
    join(checkout, "src", "main.txt"),
    "Authorized orchard source\n",
  );
  writeFileSync(
    join(checkout, "secret", "detail.txt"),
    "Private unrelated orchard source\n",
  );
  const opaque = Buffer.from([0xff, 0x00, 0x80, 0x50]);
  writeFileSync(join(checkout, "src", "opaque.bin"), opaque);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  git("add", ".");
  git("commit", "-m", "Retain observed sources");
  const treeSha = git("rev-parse", "HEAD^{tree}");
  const state = join(root, "state");
  const store = new LocalContentStore(join(state, "content"));
  const memory = new LocalRepositoryMemory(state, "fixture/admission", store);
  const source = (path) => ({
    path,
    ref: store.putBytes(readFileSync(join(checkout, path)), {
      mediaType: "application/octet-stream",
    }),
  });
  const allowed = source("src/main.txt");
  const denied = source("secret/detail.txt");
  const record = (sources) => ({
    schemaVersion: 1,
    repository: "fixture/admission",
    visibility: "private",
    kind: "handoff",
    producer: {
      objective: 1,
      runId: git("rev-parse", "HEAD"),
      status: "working",
    },
    createdAt: new Date().toISOString(),
    authority: "advisory",
    summary: "Retained orchard handoff",
    bodies: sources.map(({ path, ref }) => ({
      role: `source:${path}`,
      ref,
      availability: "retained",
    })),
    sources: sources.map(({ path, ref }) => ({
      identity: `repository:${path}`,
      ref,
      complete: true,
    })),
    bindings: {
      treeSha,
      paths: sources.map(({ path, ref }) => ({ path, digest: ref.digest })),
    },
    validity: { state: "current", conditions: [] },
    supersedes: [],
  });
  const mixed = memory.retain(record([allowed, denied]));
  const permitted = memory.retain(record([allowed]));
  const lookup = {
    access: { repository: "fixture/admission", visibility: ["private"] },
    scope: { objective: 1, paths: ["src/"] },
    applicability: { treeSha, paths: { "src/main.txt": allowed.ref.digest } },
    limit: 10,
  };
  assert.deepEqual(
    memory.metadata(lookup).entries.map((entry) => entry.binding.id),
    [permitted.id],
  );
  assert.equal(memory.read({ ...lookup, id: mixed.id }), undefined);
  assert.equal(
    memory.metadata({ ...lookup, excludeIds: [permitted.id] }).entries.length,
    0,
  );
  assert.equal(
    memory.read({ ...lookup, excludeIds: [permitted.id], id: permitted.id }),
    undefined,
  );
  assert.equal(
    memory.search({ ...lookup, excludeIds: [permitted.id], query: "orchard" })
      .length,
    0,
  );
  assert.deepEqual(
    memory
      .search({ ...lookup, query: "orchard" })
      .map((result) => result.binding.id),
    [permitted.id],
  );
  assert.equal(
    memory.read({
      ...lookup,
      scope: { objective: 1, paths: [] },
      id: permitted.id,
    }),
    undefined,
  );
  assert.equal(
    memory.read({
      ...lookup,
      scope: { objective: 1, paths: ["src"] },
      id: permitted.id,
    }),
    undefined,
  );
  assert.equal(
    memory.read({
      ...lookup,
      scope: { objective: 1, paths: ["src/main.txt"] },
      id: permitted.id,
    }).content[0].text,
    "Authorized orchard source\n",
  );
  const opaqueSource = source("src/opaque.bin");
  const binary = memory.retain(record([opaqueSource]));
  const result = memory.read({
    ...lookup,
    id: binary.id,
    applicability: {
      treeSha,
      paths: { "src/opaque.bin": opaqueSource.ref.digest },
    },
  });
  assert.equal(result.disposition, "unavailable");
  assert.equal(result.content.length, 0);
  assert.match(
    result.gaps.join("\n"),
    /exact binary bytes retained; text lookup unavailable/,
  );
  assert.deepEqual(store.readBytes(result.record.bodies[0].ref), opaque);
  const supplied = readFileSync(join(checkout, "src", "main.txt"), "utf8");
  const baseSha = git("rev-parse", "HEAD");
  rmSync(checkout, { recursive: true });
  const references = retainPlanningSourceMemory({
    repository: "fixture/supplied-reference",
    objective: 1,
    runId: baseSha,
    baseSha,
    treeSha,
    configDigest: "a".repeat(64),
    sources: [
      { path: "OBJECTIVE", content: "Omit the Objective body" },
      { path: "src/main.txt", content: supplied },
    ],
  });
  assert.equal(references.length, 1);
  const referenceMemory = new LocalRepositoryMemory(
    stateRoot("fixture/supplied-reference"),
    "fixture/supplied-reference",
  );
  const reference = referenceMemory.read({
    access: {
      repository: "fixture/supplied-reference",
      visibility: ["private"],
    },
    scope: { objective: 1, paths: ["src/main.txt"] },
    id: references[0].id,
    applicability: {
      treeSha,
      paths: { "src/main.txt": allowed.ref.digest },
      environment: { configDigest: "a".repeat(64) },
      sources: { "src/main.txt#": { version: allowed.ref.digest } },
    },
  });
  assert.equal(reference.disposition, "current");
  assert.equal(reference.content[0].text, supplied);
  assert.equal(reference.record.sources[0].commitSha, baseSha);
  assert.equal(reference.record.sources[0].treeSha, treeSha);
  const referenceLookup = {
    access: {
      repository: "fixture/supplied-reference",
      visibility: ["private"],
    },
    scope: { objective: 1, paths: ["src/main.txt"] },
    suppliedSources: [{ path: "src/main.txt", digest: allowed.ref.digest }],
    limit: 0,
  };
  assert.equal(referenceMemory.metadata(referenceLookup).complete, true);
  assert.equal(
    referenceMemory.read({ ...referenceLookup, id: references[0].id }),
    undefined,
  );
  assert.equal(
    referenceMemory.search({ ...referenceLookup, limit: 10, query: "orchard" })
      .length,
    0,
  );
  assert.equal(
    referenceMemory.metadata({
      ...referenceLookup,
      limit: 10,
      suppliedSources: [
        {
          path: "src/main.txt",
          heading: "Other selection",
          digest: allowed.ref.digest,
        },
      ],
    }).entries.length,
    1,
  );
  assert.equal(
    referenceMemory.metadata({
      ...referenceLookup,
      limit: 10,
      suppliedSources: [{ path: "src/main.txt", digest: "b".repeat(64) }],
    }).entries.length,
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    retainPlanningSourceMemory({
      repository: "fixture/supplied-reference",
      objective: 1,
      runId: baseSha,
      baseSha,
      treeSha,
      configDigest: "a".repeat(64),
      sources: [{ path: "src/main.txt", content: supplied }],
    }),
    references,
  );
  assert.equal(
    referenceMemory.read({
      ...referenceLookup,
      suppliedSources: [],
      id: references[0].id,
    }).record.sources[0].retrievedAt,
    reference.record.sources[0].retrievedAt,
  );
});
