import {
  checkpointPlanningDispatch,
  compilePlan,
} from "../dist/compiler/recovery.js";
import { paidPlanningModel } from "../dist/compiler/planning.js";
import {
  planningSources,
  hydrateWorkerInputSources,
  resolveWorkItemSources,
} from "../dist/compiler/sources.js";
import { step, repeatKey } from "../dist/step.js";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkStagedCandidate } from "../dist/execution/staged-candidate.js";
import {
  collectWorktreeResult,
  freezeRejectedCollection,
  authenticateRejectedCollectionReceipt,
} from "../dist/execution/local.js";
import {
  withRecoveryCheckpointScope,
  awaitCheckpointAdmission,
  gitPersistenceStatus,
  CheckpointAdmissionFailure,
  readVerifiedRecoveryCheckpoint,
  withRecoveryCheckpointControllerVerification,
} from "../dist/recovery-checkpoint.js";
import {
  executionContext,
  assertDurableValue,
} from "../dist/execution/checkpoint.js";
import {
  describeContinuationReferences,
  buildRecoveryCheckpointClosure,
} from "../dist/recovery-checkpoint-closure.js";
import { LocalContentStore } from "../dist/content/local.js";
import { faultOf } from "../dist/fault.js";
import { retainStateMemory } from "../dist/repository-memory.js";
import { buildMemoryLearningClosure } from "../dist/repository-memory-transfer.js";
import {
  proposalPersistenceReferences,
  proposalSchema,
  refuseUnknownProviderSubmissions,
} from "../dist/proposals.js";
import {
  discoverRepository,
  authenticateDiscoveryOutput,
  readDiscoveryBody,
} from "../dist/discovery.js";
import {
  applyPendingAmendment,
  decideAmendment,
  graphDigest,
} from "../dist/graph-amendments.js";
import {
  completeObjectiveKnowledge,
  maxHandoffSources,
  objectiveKnowledgeView,
  publishObjectiveKnowledge,
  reviewObjectiveKnowledge,
  workHandoffSchema,
} from "../dist/objective-knowledge.js";
import {
  renderWorkItemPrompt,
  materializeWorkerSources,
  assertWorkerSourceFiles,
} from "../dist/execution/harness-support.js";
import {
  buildAdaptiveContext,
  authenticateAdaptiveContextPacket,
} from "../dist/adaptive-context.js";
import { prepareClaudeInput } from "../dist/execution/claude-managed-input.js";
import { prepareOpenAIInput } from "../dist/execution/openai-managed-files.js";
import { createPlanningContextResolver } from "../dist/compiler/context-runtime.js";
import { initializeContextLookup } from "../dist/compiler/context.js";
import {
  stateRoot,
  validateConfig,
  factoryConfigDigest,
} from "../dist/config.js";
import {
  recordRetrospective,
  prepareDreamInput,
  readDreamCheckpoint,
  learningPersistenceClosure,
  dreamSubmissionHolds,
  DEFAULT_PLAYBOOK_BUDGET_BYTES,
} from "../dist/learning.js";
import {
  reflectWorkflow,
  readWorkflowReflection,
  workflowStageObligations,
} from "../dist/workflow-reflection.js";
import {
  archiveAttempt,
  consumption,
  resolveAutonomy,
} from "../dist/repair-policy.js";
import { materializeGraphExpansion } from "../dist/graph-expansion.js";
import { authenticateExpansionInputs } from "../dist/runner/expansion.js";
import { graphProjectionControl } from "../dist/graph-projection-control.js";
import { openAmendmentQuestion, parseFactoryState } from "../dist/state.js";
import {
  acquireControllerLock,
  objectiveLockPath,
  readContinuation,
  readControllerOwner,
  releaseControllerLock,
  saveState,
  statePath,
} from "../dist/state-store.js";
import {
  ControllerReadinessPendingError,
  requestControl,
  serveControl,
} from "../dist/coordinator-control.js";
import { checkpointExecutionState } from "../dist/runner/execution.js";
import { cancelKnownWork, canHandoff } from "../dist/runner/ownership.js";
import { setCoordinatorMode } from "../dist/state.js";
import {
  CoordinatorHandoff,
  observeObjectiveController,
} from "../dist/runner.js";
import {
  DiagnosticEmitter,
  continuationStatusDocument,
  readDiagnostics,
  summarizeFormalHistory,
} from "../dist/diagnostics.js";
import {
  checkpointWorkerSession,
  CodexHarness,
  LocalExecutionDriver,
} from "../dist/execution/local.js";
import { workerAttemptItem } from "../dist/item-worker.js";
import { workItemPrompt } from "../dist/execution/harness-support.js";
import {
  agentSessionContinuation,
  assertAgentSessionCapabilities,
  assertAgentSessions,
  planningSessionInputDigest,
  releaseAgentSessions,
} from "../dist/agent-session.js";
import {
  CodexPlanningModel,
  StructuredPlanningModel,
} from "../dist/compiler/model.js";
import {
  ProviderTurnGuard,
  ProviderTurnTimeoutError,
} from "../dist/provider-turn.js";
import { subprocessAsync, withProcessCancellation } from "../dist/process.js";
import { attachedFault } from "../dist/fault.js";
import { CodexPlanningTransport } from "../dist/compiler/codex-transport.js";
import { materializeResultTree } from "../dist/result-evidence.js";
import {
  createCodexHome,
  CODEX_TREE_REVIEW_CONFIG,
} from "../dist/codex-planning-isolation.js";
import {
  CLAUDE_EXPORT_SCRIPT,
  materializeClaudeSnapshot,
  parseClaudeResultSnapshot,
} from "../dist/execution/claude-managed-transfer.js";

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
  }).trim();
}

test("read-only discovery authenticates a pinned Git inventory and retains complete bodies outside the checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-discovery-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(join(checkout, "src"), { recursive: true });
    git(checkout, "init", "-b", "main");
    writeFileSync(join(checkout, "src", "a.txt"), "original\n");
    writeFileSync(
      join(checkout, "src", "binary\tfile.bin"),
      Buffer.from([0, 255, 1, 2]),
    );
    git(checkout, "add", ".");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    );
    const baseSha = git(checkout, "rev-parse", "HEAD");
    writeFileSync(join(checkout, "src", "a.txt"), "uncommitted edit\n");
    writeFileSync(join(checkout, "src", "untracked.txt"), "untracked\n");
    const before = git(checkout, "status", "--porcelain=v1");
    const store = new LocalContentStore(join(root, "objects"));
    const specification = {
      mode: "inventory",
      selectors: ["src/"],
      schema: "factory.repository-inventory/v1",
      role: "inventory",
      completeness: "complete",
      allowance: { maxEntries: 10, maxBytes: 1024, maxAttempts: 1 },
    };
    const request = {
      checkout,
      baseSha,
      specification,
      producer: {
        objective: 1,
        runId: "inventory-run",
        itemId: "inventory",
        attemptId: "inventory-attempt",
      },
      store,
    };
    const manifest = await discoverRepository(request);
    const body = await authenticateDiscoveryOutput({ ...request, manifest });
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.selectedEntries, 2);
    assert.deepEqual(
      body.entries.map((entry) => entry.path),
      ["src/a.txt", "src/binary\tfile.bin"],
    );
    assert.equal(
      Buffer.from(
        await new Response(
          await store.open(body.entries[0].content),
        ).arrayBuffer(),
      ).toString(),
      "original\n",
    );
    assert.equal(git(checkout, "status", "--porcelain=v1"), before);
    assert.equal(git(checkout, "rev-parse", "HEAD"), baseSha);
    const emptySpec = { ...specification, selectors: ["absent/"] };
    const empty = await discoverRepository({
      ...request,
      specification: emptySpec,
    });
    assert.equal(empty.status, "complete");
    assert.equal(empty.selectedEntries, 0);
    assert.deepEqual(
      (
        await authenticateDiscoveryOutput({
          ...request,
          specification: emptySpec,
          manifest: empty,
        })
      ).entries,
      [],
    );
    const limitedSpec = {
      ...specification,
      allowance: { ...specification.allowance, maxEntries: 1 },
    };
    const limited = await discoverRepository({
      ...request,
      specification: limitedSpec,
    });
    assert.equal(limited.status, "truncated");
    assert.equal(limited.selectedEntries, 2);
    assert.equal(
      (
        await authenticateDiscoveryOutput({
          ...request,
          specification: limitedSpec,
          manifest: limited,
        })
      ).entries.length,
      1,
    );
    await assert.rejects(
      authenticateDiscoveryOutput({
        ...request,
        manifest: {
          ...limited,
          status: "complete",
          specificationDigest: manifest.specificationDigest,
        },
      }),
      /completeness/,
    );
    await assert.rejects(
      authenticateDiscoveryOutput({
        ...request,
        manifest: {
          ...manifest,
          source: { ...manifest.source, treeSha: "f".repeat(40) },
        },
      }),
      /binding differs/,
    );
    git(
      checkout,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${baseSha},vendor/library`,
    );
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "tracked submodule boundary",
    );
    const submoduleSpec = { ...specification, selectors: ["vendor/"] };
    const unreadable = await discoverRepository({
      ...request,
      baseSha: git(checkout, "rev-parse", "HEAD"),
      specification: submoduleSpec,
    });
    assert.equal(unreadable.status, "unreadable");
    assert.equal(unreadable.selectedEntries, 1);
    const unreadableBody = await authenticateDiscoveryOutput({
      ...request,
      specification: submoduleSpec,
      manifest: unreadable,
    });
    assert.deepEqual(unreadableBody.entries, []);
    assert.equal(unreadableBody.failures[0].path, "vendor/library");
    rmSync(checkout, { recursive: true });
    const retained = await readDiscoveryBody(store, manifest.body);
    for (const entry of retained.entries) await store.verify(entry.content);
    assert.equal(retained.entries.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged secrets cannot be hidden by replacing working bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-staged-secret-"));
  try {
    const checkout = root;
    git(checkout, "init", "-b", "main");
    writeFileSync(join(checkout, "README.md"), "# Target\n");
    git(checkout, "add", ".");
    git(
      checkout,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "base",
    );
    const value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(join(checkout, "safe.txt"), `GITHUB_TOKEN=${value}\n`);
    git(checkout, "add", "safe.txt");
    writeFileSync(join(checkout, "safe.txt"), "Clean working bytes.\n");
    await assert.rejects(
      () => checkStagedCandidate(checkout, checkout, ["safe.txt"]),
      (error) => {
        assert.match(
          error.message,
          /Secretlint found suspected secret in "safe.txt"/,
        );
        assert.match(error.message, /@secretlint\/secretlint-rule-github/);
        assert.ok(!error.message.includes(value));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private handoffs retain exact source bytes and scoped DAG knowledge across atomic reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-private-handoff-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    git(checkout, "init", "-b", "main");
    writeFileSync(join(checkout, "README.md"), "# Target\n");
    const originalLock = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: Object.fromEntries(
          Array.from({ length: 4096 }, (_, index) => [
            `node_modules/public-fixture-${index}`,
            { version: "1.0.0", integrity: "public-synthetic" },
          ]),
        ),
      },
      null,
      2,
    );
    writeFileSync(join(checkout, "package-lock.json"), originalLock);
    writeFileSync(
      join(checkout, "contract.md"),
      "# Selected\nOriginal accepted section.\n# Other\nUnselected private-scope fixture text.\n",
    );

    git(checkout, "add", ".");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    );
    const baseSha = git(checkout, "rev-parse", "HEAD");
    const item = (id, dependencies, ownedPaths) => ({
      id,
      title: id,
      goal: id,
      acceptance: ["Implement owned files"],
      nonGoals: [],
      dependencies,
      ownedPaths,
      resources: [],
      brief: "Keep the source contract",
      validation: [],
      sourceAssets: [],
      expectedOutputRoles: [],
      requiredLfsRoles: [],
      minimumAssetSets: 0,
      citations: [],
    });
    const producer = item("schema", [], ["schema.json"]);
    const consumer = item("api", ["schema"], ["api.json"]);
    const peer = item("ui", [], ["ui.json"]);
    const unrelated = item("docs", [], ["docs.md"]);
    producer.citations = [
      { path: "package-lock.json", heading: "" },
      { path: "contract.md", heading: "Selected" },
    ];
    hydrateWorkerInputSources(
      { items: [producer] },
      planningSources(
        "## Sources\n- package-lock.json\n- contract.md\n",
        baseSha,
        checkout,
      ),
      checkout,
    );
    const producerSources = resolveWorkItemSources(producer.inputSources, {
      checkout,
      baseSha,
    });
    const graph = {
      objective: 1,
      baseSha,
      coverage: [
        {
          criterionId: "b".repeat(64),
          itemId: "schema",
          source: {
            path: "README.md",
            digest: createHash("sha256").update("# Target\n").digest("hex"),
            text: "# Target",
          },
          proof: { kind: "result-semantic", acceptanceIndex: 0 },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        },
      ],
      items: [producer, consumer, peer, unrelated],
    };
    const state = {
      schemaVersion: 7,
      repository: "example/target",
      objective: 1,
      runId: "handoff-integration",
      configDigest: "c".repeat(64),
      baseSha,
      graph,
      planGraphDigest: graphDigest(graph),
      publicationContract: "exact-request-v1",
      objectiveCommands: [],
      objectiveBodyDigest: "b".repeat(64),
      approvedPlaybookPin: null,
      approvedPlaybookAdmission: {
        approvedPlaybookPin: null,
        configDigest: "c".repeat(64),
        graphDigest: graphDigest(graph),
        packetDigest: "c".repeat(64),
        reviewDigest: "d".repeat(64),
        sourcePacketDigest: "e".repeat(64),
      },
      capacity: { concurrency: 1 },
      autonomy: resolveAutonomy(),
      issueByItemId: { schema: 2, api: 3, ui: 4, docs: 5 },
      work: {
        schema: { status: "done", attempt: "schema-attempt" },
        api: { status: "pending" },
        ui: { status: "pending" },
        docs: { status: "pending" },
      },
    };
    const request = {
      item: producer,
      baseSha,
      sourceBaseSha: baseSha,
      attemptId: "schema-attempt",
      handoffPeers: graph.items
        .filter((item) => item.id !== producer.id)
        .map(({ id, title }) => ({ id, title })),
    };
    const store = new LocalContentStore(join(root, "private-content"));
    writeFileSync(join(checkout, "schema.json"), '{"timestamp":"UTC"}\n');
    const manifest = {
      notes: [
        {
          kind: "interface",
          summary: "Timestamp uses UTC",
          paths: ["schema.json"],
          consumerIndices: [0, 1],
        },
        {
          kind: "hypothesis",
          summary: "Investigate optional errors before integration",
          paths: ["missing.json"],
          consumerIndices: [],
        },
        // The worker's self-review map for its only criterion.
        {
          kind: "verification",
          summary:
            "Implement owned files: schema.json:1 declares the UTC timestamp",
          paths: ["schema.json"],
          consumerIndices: [],
          criterionIndex: 0,
        },
      ],
    };
    writeFileSync(join(checkout, ".gitignore"), ".factory-handoff.json\n");
    writeFileSync(
      join(checkout, "package-lock.json"),
      '{"lockfileVersion":3,"packages":{}}\n',
    );
    git(checkout, "add", ".gitignore", "package-lock.json");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--amend",
      "--no-edit",
    );
    request.baseSha = git(checkout, "rev-parse", "HEAD");
    state.baseSha = graph.baseSha = request.baseSha;
    state.planGraphDigest = graphDigest(graph);
    state.approvedPlaybookAdmission.graphDigest = state.planGraphDigest;
    const sourceDelivery = materializeWorkerSources(checkout, request);
    assert.notEqual(request.baseSha, sourceDelivery.baseSha);
    assert.equal(sourceDelivery.baseSha, baseSha);
    assert.equal(
      readFileSync(
        join(sourceDelivery.root, sourceDelivery.files[0].file),
        "utf8",
      ),
      originalLock,
    );
    const sectionFile = join(sourceDelivery.root, sourceDelivery.files[1].file);
    assert.equal(readFileSync(sectionFile, "utf8"), producerSources[1].content);
    assert.equal(
      readFileSync(sectionFile, "utf8").includes("Unselected private-scope"),
      false,
    );
    const references = {
      item: producer,
      sourceBaseSha: baseSha,
      sourceDelivery,
      worktree: checkout,
    };
    assertWorkerSourceFiles(references);
    const rendered = renderWorkItemPrompt(references);
    assert.equal(
      rendered.prompt.includes(JSON.stringify(producer.inputSources)),
      false,
    );
    assert.equal(
      rendered.prompt.includes("node_modules/public-fixture-4095"),
      false,
    );
    assert(rendered.prompt.includes(sourceDelivery.files[0].digest));
    assert(rendered.prompt.includes("targeted entries"));
    assert(rendered.prompt.includes('"heading":"Selected"'));
    // Only a whole-file source the checkout still holds byte for byte is
    // marked; this checkout's lock changed after the pin.
    assert.equal(
      renderWorkItemPrompt(references, checkout).prompt.includes(
        'inCheckout":',
      ),
      false,
    );
    const pinnedLockChanged = readFileSync(join(checkout, "package-lock.json"));
    writeFileSync(join(checkout, "package-lock.json"), originalLock);
    assert(
      renderWorkItemPrompt(references, checkout).prompt.includes(
        `"path":"package-lock.json","file":"${sourceDelivery.files[0].file}","bytes":${sourceDelivery.files[0].bytes},"inCheckout":true}`,
      ),
    );
    writeFileSync(join(checkout, "package-lock.json"), pinnedLockChanged);
    assert.equal(
      JSON.parse(
        readFileSync(
          join(sourceDelivery.root, sourceDelivery.files[0].file),
          "utf8",
        ),
      ).packages["node_modules/public-fixture-1"].version,
      "1.0.0",
    );
    assert.throws(
      () =>
        renderWorkItemPrompt({
          ...references,
          sourceDelivery: { ...sourceDelivery, baseSha: request.baseSha },
        }),
      /original accepted bodies/,
    );
    assert.throws(
      () => materializeWorkerSources(checkout, { item: producer }),
      /original accepted source pin/,
    );
    assert.throws(
      () => renderWorkItemPrompt({ item: producer, worktree: checkout }),
      /complete source file delivery/,
    );

    const managedClaude = await prepareClaudeInput(
      checkout,
      join(root, "claude-input"),
      request,
      store,
    );
    const claudeInput = JSON.parse(readFileSync(managedClaude.path, "utf8"));
    const pinnedRelative =
      ".factory-inputs/pinned-sources/" + sourceDelivery.files[0].file;
    assert.equal(
      Buffer.from(
        claudeInput.files.find((file) => file.path === pinnedRelative).content,
        "base64",
      ).toString("utf8"),
      originalLock,
    );
    assert.equal(managedClaude.request.sourceBaseSha, baseSha);
    const managedOpenAI = await prepareOpenAIInput({
      checkout,
      root: join(root, "openai-input"),
      request,
      store,
    });
    assert.equal(
      readFileSync(join(root, "openai-input", "repo", pinnedRelative), "utf8"),
      originalLock,
    );
    const managedPrompt = renderWorkItemPrompt(managedOpenAI.harnessRequest);
    assert.equal(
      managedPrompt.prompt.includes(JSON.stringify(producer.inputSources)),
      false,
    );
    assert(
      managedPrompt.prompt.includes(
        "under /workspace/repo/.factory-inputs/pinned-sources;",
      ),
    );
    assert(
      managedPrompt.prompt.includes(`"file":"${sourceDelivery.files[0].file}"`),
    );
    assert.equal(managedOpenAI.harnessRequest.sourceBaseSha, baseSha);

    writeFileSync(
      join(checkout, ".factory-handoff.json"),
      JSON.stringify({
        notes: [
          {
            kind: "pitfall",
            summary: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            paths: ["schema.json"],
            consumerIndices: [],
          },
        ],
      }),
    );
    await assert.rejects(
      () => collectWorktreeResult(checkout, checkout, request, store, {}),
      /Secretlint found suspected secret/,
    );
    assert.equal(git(checkout, "rev-parse", "HEAD"), request.baseSha);
    const emitted = renderWorkItemPrompt({
      item: producer,
      sourceBaseSha: baseSha,
      sourceDelivery,
      worktree: checkout,
      handoffPeers: request.handoffPeers,
    });
    assert(
      emitted.prompt.includes(
        JSON.stringify(workHandoffSchema(3, producer.acceptance.length)),
      ),
    );
    assert(emitted.prompt.includes("one verification note per criterion"));
    // Each note kind carries its own limits in the emitted schema.
    const [learningShape, verificationShape] = workHandoffSchema(
      3,
      producer.acceptance.length,
    ).properties.notes.items.oneOf;
    assert.equal(learningShape.properties.summary.maxLength, 1024);
    assert.equal(learningShape.properties.paths.maxItems, 8);
    assert.equal(learningShape.properties.criterionIndex, undefined);
    assert.equal(verificationShape.properties.summary.maxLength, 4096);
    assert.deepEqual(
      verificationShape.properties.criterionIndex.maximum,
      producer.acceptance.length - 1,
    );
    assert(verificationShape.required.includes("criterionIndex"));
    assert.equal(
      workHandoffSchema(3, producer.acceptance.length).properties.notes
        .maxItems,
      16 + producer.acceptance.length,
    );
    assert(emitted.prompt.includes('"peerIndex":0,"title":"api"'));
    const withoutPeers = renderWorkItemPrompt({
      item: producer,
      sourceBaseSha: baseSha,
      sourceDelivery,
      worktree: checkout,
    });
    assert(withoutPeers.prompt.includes("Omit peer-targeted handoff notes"));
    assert(
      withoutPeers.prompt.includes(
        JSON.stringify(workHandoffSchema(0, producer.acceptance.length)),
      ),
    );
    for (const note of [
      {
        kind: "interface",
        summary: "Unknown recipient",
        paths: ["schema.json"],
        consumerIndices: [3],
      },
      {
        kind: "hypothesis",
        summary: "Unfinished broad change",
        paths: Array.from({ length: 9 }, (_, index) => `file-${index}.json`),
        consumerIndices: [],
      },
      // Learnings keep their own limits even though verification notes are larger.
      {
        kind: "pitfall",
        summary: "x".repeat(1500),
        paths: ["schema.json"],
        consumerIndices: [],
      },
      // A verification map names one of this item's criteria, only for itself.
      {
        kind: "verification",
        summary: "A criterion this item does not have",
        paths: ["schema.json"],
        consumerIndices: [],
        criterionIndex: producer.acceptance.length,
      },
      {
        kind: "verification",
        summary: "Proof map sent to a peer",
        paths: ["schema.json"],
        consumerIndices: [0],
        criterionIndex: 0,
      },
      {
        kind: "interface",
        summary: "A learning bound to a criterion",
        paths: ["schema.json"],
        consumerIndices: [],
        criterionIndex: 0,
      },
    ]) {
      writeFileSync(
        join(checkout, ".factory-handoff.json"),
        JSON.stringify({ notes: [note] }),
      );
      await assert.rejects(
        () => collectWorktreeResult(checkout, checkout, request, store, {}),
        /Handoff/,
      );
      assert.equal(git(checkout, "rev-parse", "HEAD"), request.baseSha);
      assert.deepEqual(
        JSON.parse(
          readFileSync(join(checkout, ".factory-handoff.json"), "utf8"),
        ),
        { notes: [note] },
      );
    }
    writeFileSync(
      join(checkout, ".factory-handoff.json"),
      JSON.stringify(manifest),
    );
    chmodSync(sectionFile, 0o600);
    writeFileSync(sectionFile, "Changed worker source.\n");
    assert.throws(
      () => assertWorkerSourceFiles(references),
      /missing, redirected or changed/,
    );
    await assert.rejects(
      () => collectWorktreeResult(checkout, checkout, request, store, {}),
      /Bound asset input differs/,
    );
    assert.throws(
      () => materializeWorkerSources(checkout, request),
      /Immutable planning source file differs/,
    );
    writeFileSync(sectionFile, producerSources[1].content);
    chmodSync(sectionFile, 0o400);
    const script = join(root, "export.mjs");
    const bindingPath = join(root, "binding.json");
    const output = join(root, "private-export.json");
    const binding = {
      attemptId: request.attemptId,
      baseSha: request.baseSha,
      inputDigest: createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex"),
    };
    writeFileSync(script, CLAUDE_EXPORT_SCRIPT);
    writeFileSync(bindingPath, JSON.stringify(binding));
    execFileSync(process.execPath, [script, bindingPath, output], {
      cwd: checkout,
    });
    const exported = parseClaudeResultSnapshot(readFileSync(output), binding);
    assert.ok(
      exported.files.some((file) => file.path === ".factory-handoff.json"),
    );
    assert.equal(
      Buffer.from(
        exported.files.find((file) => file.path === pinnedRelative).content,
        "base64",
      ).toString("utf8"),
      originalLock,
    );
    const materialized = join(root, "exported-bytes");
    materializeClaudeSnapshot(materialized, exported);
    const imported = join(root, "imported-target");
    git(checkout, "worktree", "add", "--detach", imported, request.baseSha);
    cpSync(materialized, imported, { recursive: true });
    {
      // The real export above is a literal controller artifact, rather than a
      // reconstructed HarnessResult. Reject its staged handoff without accepting
      // or advancing the imported source, and retain only permitted observations.
      const previousRejectedStateHome = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(root, "rejected-state-root");
      try {
        const rejectedWorktree = join(
          stateRoot(state.repository),
          "worktrees",
          request.attemptId,
        );
        mkdirSync(join(stateRoot(state.repository), "worktrees"), {
          recursive: true,
          mode: 0o700,
        });
        git(
          checkout,
          "worktree",
          "add",
          "--detach",
          rejectedWorktree,
          request.baseSha,
        );
        cpSync(materialized, rejectedWorktree, { recursive: true });
        writeFileSync(
          join(rejectedWorktree, ".factory-handoff.json"),
          "{malformed handoff\n",
        );
        const rejectedSecret =
          '{"token":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}';
        writeFileSync(
          join(rejectedWorktree, ".factory-discovery.json"),
          rejectedSecret,
        );
        const rejectedOutput = join(root, "rejected-original.json");
        execFileSync(process.execPath, [script, bindingPath, rejectedOutput], {
          cwd: rejectedWorktree,
        });
        let rejectedError;
        try {
          await collectWorktreeResult(
            checkout,
            rejectedWorktree,
            request,
            store,
            {},
          );
          assert.fail("Malformed staged handoff must reject collection");
        } catch (error) {
          rejectedError = error;
        }
        const originalHead = git(rejectedWorktree, "rev-parse", "HEAD");
        const rejectedConfig = {
          repository: state.repository,
          checkout,
          execution: { kind: "local" },
          policy: { allowedSecretNames: [] },
          gitPersistence: {
            remote: join(root, "private-history.git"),
            ref: "refs/heads/history",
            visibility: "private",
            scope: "private-history",
            maxBytes: 16 * 1024 * 1024,
            maxFiles: 4096,
            timeoutMs: 30000,
            coalesceMs: 0,
          },
        };
        git(
          root,
          "init",
          "--bare",
          "-b",
          "main",
          rejectedConfig.gitPersistence.remote,
        );
        const receipt = await withRecoveryCheckpointScope(
          {
            config: rejectedConfig,
            buildClosure: async () => {
              throw new Error(
                "Observation freeze performs no external transport",
              );
            },
          },
          () =>
            freezeRejectedCollection({
              checkout,
              worktree: rejectedWorktree,
              request,
              store,
              error: rejectedError,
              rawReturn: {
                provenance: "managed-original-artifact",
                identity: rejectedOutput,
                bytes: readFileSync(rejectedOutput),
              },
            }),
        );
        assert.equal(receipt.candidate.availability, "available");
        assert.deepEqual(receipt.candidate.paths, ["schema.json"]);
        assert.equal(git(rejectedWorktree, "rev-parse", "HEAD"), originalHead);
        assert.equal(
          receipt.staging.find(
            (entry) => entry.path === ".factory-handoff.json",
          ).availability,
          "available",
        );
        assert.equal(receipt.media.availability, "unavailable");
        const rejectedSnapshot = structuredClone(state);
        rejectedSnapshot.schemaVersion = 17;
        rejectedSnapshot.configDigest = factoryConfigDigest(rejectedConfig);
        rejectedSnapshot.approvedPlaybookAdmission.configDigest =
          rejectedSnapshot.configDigest;
        rejectedSnapshot.work.schema = {
          status: "failed",
          attempt: request.attemptId,
          baseSha: request.baseSha,
          error: receipt.fault.detail,
          // The actual local file exporter is settled historical ownership. This
          // metadata claims no provider session, usage, validation or result.
          execution: {
            provider: "local",
            identity: request.attemptId,
            data: {
              request,
              worktree: rejectedWorktree,
              adapterIdentity: "actual-local-file-export",
              handle: { identity: request.attemptId },
              rejectedCollection: receipt,
            },
          },
        };
        const rejectedSnapshotFile = statePath(state.repository, 1);
        saveState(rejectedSnapshotFile, rejectedSnapshot);
        const rejectedReload = parseFactoryState(
          JSON.parse(readFileSync(rejectedSnapshotFile, "utf8")),
          state.repository,
          1,
        );
        const reloadedReceipt =
          rejectedReload.work.schema.execution.data.rejectedCollection;
        await authenticateRejectedCollectionReceipt(
          reloadedReceipt,
          request,
          request.attemptId,
          checkout,
          store,
        );
        const retained = describeContinuationReferences(rejectedReload);
        assert.ok(
          retained.gitObjects.some(
            (entry) => entry.sha === receipt.candidate.commitSha,
          ),
        );
        assert.equal(receipt.rawReturn.availability, "unavailable");
        assert.equal(receipt.rawReturn.reason, "unsafe-staging");
        assert.equal(receipt.rawReturn.ref, undefined);
        const forbiddenStage = receipt.staging.find(
          (entry) => entry.path === ".factory-discovery.json",
        );
        assert.equal(forbiddenStage.availability, "unavailable");
        assert.equal(forbiddenStage.reason, "secret-ineligible");
        assert.equal(forbiddenStage.ref, undefined);
        assert.equal(
          retained.contentRefs.some(
            (ref) =>
              ref.digest === receipt.rawReturn.digest ||
              ref.digest === forbiddenStage.digest,
          ),
          false,
        );
        await assert.rejects(() =>
          store.verify({
            digest: receipt.rawReturn.digest,
            bytes: receipt.rawReturn.bytes,
            mediaType: "application/octet-stream",
          }),
        );
        await assert.rejects(() =>
          store.verify({
            digest: forbiddenStage.digest,
            bytes: forbiddenStage.bytes,
            mediaType: "application/json",
          }),
        );
        assert.equal(
          retained.gaps.some((gap) => gap.required),
          false,
        );
        assert.equal(rejectedReload.work.schema.status, "failed");
        assert.equal(rejectedReload.work.schema.changeRef, undefined);
        assert.equal(rejectedReload.work.schema.treeSha, undefined);
        assert.deepEqual(rejectedReload.autonomy, rejectedSnapshot.autonomy);
        const snapshotBytes = readFileSync(rejectedSnapshotFile);
        await assert.rejects(
          () =>
            authenticateRejectedCollectionReceipt(
              reloadedReceipt,
              { ...request, attemptId: "different-attempt" },
              request.attemptId,
              checkout,
              store,
            ),
          /exact admitted request/,
        );
        assert.deepEqual(readFileSync(rejectedSnapshotFile), snapshotBytes);
        // The existing real private-Git transport must acknowledge this failed
        // observation before the only imported checkout is removed.
        await withRecoveryCheckpointScope(
          {
            config: rejectedConfig,
            buildClosure: () =>
              buildRecoveryCheckpointClosure({ config: rejectedConfig, store }),
          },
          () => awaitCheckpointAdmission(state.repository, "explicit"),
        );
        assert.equal(
          gitPersistenceStatus(rejectedConfig).protectedContinuation,
          true,
        );
        // Hold the genuine private-Git admission while the stock driver's
        // prepared start is owned, then cancel before its actual ACK returns.
        // This exercises the complete cleanup caller without native dispatch.
        const raceState = structuredClone(rejectedSnapshot);
        const raceAttempt = randomUUID();
        raceState.work.api = {
          status: "running",
          step: "execute",
          attempt: raceAttempt,
          baseSha: raceState.baseSha,
          startedAt: new Date().toISOString(),
        };
        const raceSave = () => saveState(rejectedSnapshotFile, raceState);
        raceSave();
        const conversation = agentSessionContinuation(
          raceState,
          "implementation",
          "api",
          raceSave,
        );
        const raceContext = executionContext(
          raceState.work.api,
          raceSave,
          () => Boolean(raceState.cancelRequested),
          undefined,
          undefined,
          raceState.repository,
          true,
        );
        raceContext.checkpointSession = (ref) => conversation.checkpoint(ref);
        let admissionEntered;
        const entered = new Promise((resolve) => {
          admissionEntered = resolve;
        });
        let releaseAdmission;
        const held = new Promise((resolve) => {
          releaseAdmission = resolve;
        });
        const originalAdmission = raceContext.admitEffect;
        raceContext.admitEffect = async (reason) => {
          if (reason === "before-effect") {
            admissionEntered();
            await held;
          }
          await originalAdmission(reason);
        };
        const credentials = join(root, "cancel-before-dispatch-credentials");
        const raceDriver = new LocalExecutionDriver(
          checkout,
          join(stateRoot(raceState.repository), "worktrees"),
          new CodexHarness(credentials, "off", {
            model: "unused",
            reasoningEffort: "low",
          }),
          1,
          store,
          "codex",
        );
        await withRecoveryCheckpointScope(
          {
            config: rejectedConfig,
            buildClosure: () =>
              buildRecoveryCheckpointClosure({ config: rejectedConfig, store }),
          },
          async () => {
            const start = raceDriver
              .start(
                {
                  item: consumer,
                  baseSha: raceState.baseSha,
                  attemptId: raceAttempt,
                  session: {
                    scope: conversation.scope,
                    identity: conversation.identity,
                  },
                },
                raceContext,
              )
              .then(
                () => assert.fail("Cancelled admission dispatched a worker"),
                (error) => error,
              );
            await entered;
            const prepared = structuredClone(raceState.work.api.execution);
            assert.equal(prepared.data.phase, "prepared");
            assert.equal(prepared.data.handle, undefined);
            const staleContext = executionContext(raceState.work.api, raceSave);
            raceState.cancelRequested = true;
            raceSave();
            const cancellation = cancelKnownWork(
              raceState,
              raceDriver,
              raceSave,
            );
            assert.equal(raceState.work.api.execution.data.stopped, undefined);
            releaseAdmission();
            const startError = await start;
            assert.equal(attachedFault(startError).kind, "cancelled");
            assert.match(
              String(startError),
              /Cancelled before native worker dispatch/,
            );
            await cancellation;
            await awaitCheckpointAdmission(raceState.repository, "explicit");
            const cancelled = parseFactoryState(
              JSON.parse(readFileSync(rejectedSnapshotFile, "utf8")),
              raceState.repository,
              1,
            );
            assert.equal(cancelled.work.api.execution.identity, raceAttempt);
            assert.equal(cancelled.work.api.execution.data.phase, "prepared");
            assert.equal(cancelled.work.api.execution.data.handle, undefined);
            assert.match(
              cancelled.work.api.execution.data.stopped,
              /Prepared local launch cancelled/,
            );
            assert.deepEqual(
              cancelled.work.api.execution.data.preparedHarnessRequest,
              prepared.data.preparedHarnessRequest,
            );
            const cancelledSession = Object.values(
              cancelled.agentSessions,
            ).find((ref) => ref.identity === conversation.identity);
            assert.equal(cancelledSession.status, "unavailable");
            assert.equal(cancelledSession.turn, 1);
            assert.equal(cancelledSession.executionIdentity, raceAttempt);
            assert.equal(cancelledSession.currentTurn, undefined);
            assert.equal(
              existsSync(
                join(stateRoot(raceState.repository), "worktrees", raceAttempt),
              ),
              false,
            );
            assert.equal(existsSync(credentials), false);
            assert.throws(
              () => staleContext.checkpoint(prepared),
              /superseded/,
            );
          },
        );
        git(checkout, "worktree", "remove", "--force", rejectedWorktree);
      } finally {
        if (previousRejectedStateHome === undefined)
          delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousRejectedStateHome;
      }
    }
    const importedResult = await collectWorktreeResult(
      checkout,
      imported,
      request,
      store,
      {},
    );
    assert.equal(
      git(imported, "ls-tree", "HEAD", "--", ".factory-handoff.json"),
      "",
    );
    const result = await collectWorktreeResult(
      checkout,
      checkout,
      request,
      store,
      {},
    );
    assert.equal(importedResult.treeSha, result.treeSha);
    assert.deepEqual(importedResult.handoff, result.handoff);
    assert.deepEqual(result.handoff.notes[0].consumers, ["api", "ui"]);
    assert.deepEqual(result.handoff.notes[1].consumers, []);
    assert.equal(result.handoff.notes[2].kind, "verification");
    assert.equal(result.handoff.notes[2].criterionIndex, 0);
    assert.equal(existsSync(join(checkout, ".factory-handoff.json")), false);
    assert.equal(
      git(checkout, "ls-tree", "HEAD", "--", ".factory-handoff.json"),
      "",
    );
    assert.equal(result.handoff.sources.length, 1);
    await store.verify(result.handoff.sources[0].ref);
    state.work.schema.changeRef = result.changeRef;
    state.work.schema.treeSha = result.treeSha;
    {
      // A handoff at its schema limits (every learning note and the one
      // verification map at their path limits) cites more than 128 files; it
      // publishes and the state still saves and loads.
      const paths = Array.from(
        { length: maxHandoffSources(producer.acceptance.length) },
        (_, index) => `cited/file-${index}.json`,
      );
      const learning = Array.from({ length: 16 }, (_, note) => ({
        kind: "pitfall",
        summary: `Learning ${note}`,
        paths: paths.slice(note * 8, note * 8 + 8),
        consumers: [],
      }));
      const maximal = {
        ...result,
        handoff: {
          notes: [
            ...learning,
            {
              kind: "verification",
              summary: "Every sub-clause mapped",
              paths: paths.slice(128),
              consumers: [],
              criterionIndex: 0,
            },
          ],
          sources: paths.map((path) => ({
            path,
            ref: result.handoff.sources[0].ref,
          })),
        },
      };
      assert(paths.length > 128);
      const full = structuredClone(state);
      await publishObjectiveKnowledge(full, producer, maximal, store);
      assert.equal(full.work.schema.knowledge.sources.length, paths.length);
      const fullSnapshot = join(root, "private-state", "full.json");
      saveState(fullSnapshot, full);
      parseFactoryState(
        JSON.parse(readFileSync(fullSnapshot, "utf8")),
        state.repository,
        1,
      );
      // An invalid record is refused as the attempt's work fault before it
      // enters state, so later saves are unaffected.
      const invalid = structuredClone(state);
      await assert.rejects(
        () =>
          publishObjectiveKnowledge(
            invalid,
            producer,
            {
              ...maximal,
              handoff: {
                ...maximal.handoff,
                sources: [
                  ...maximal.handoff.sources,
                  { path: "uncited.json", ref: result.handoff.sources[0].ref },
                ],
              },
            },
            store,
          ),
        (error) =>
          faultOf(error).kind === "work" &&
          /Handoff knowledge is invalid/.test(error.message),
      );
      assert.equal(invalid.work.schema.knowledge, undefined);
      saveState(join(root, "private-state", "invalid.json"), invalid);
    }
    await publishObjectiveKnowledge(state, producer, result, store);
    const snapshot = join(root, "private-state", "state.json");
    saveState(snapshot, state);
    const loaded = parseFactoryState(
      JSON.parse(readFileSync(snapshot, "utf8")),
      state.repository,
      1,
    );
    {
      // Freeze complete selected role inputs through the ordinary atomic snapshot.
      // Optional retrieval bounds never trim the required settled interface body.
      git(
        checkout,
        "remote",
        "add",
        "origin",
        "https://github.com/example/target.git",
      );
      const selection = { model: "unused-local-check", reasoningEffort: "low" };
      const config = validateConfig({
        schemaVersion: 1,
        repository: loaded.repository,
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
        planningContext: {
          enabled: true,
          memory: false,
          selectors: ["README.md"],
          bounds: {
            maxRounds: 1,
            maxRequestsPerRound: 1,
            maxResults: 1,
            maxBytes: 1,
            maxElapsedMs: 5000,
            maxProviderCalls: 1,
          },
        },
      });
      const adaptive = structuredClone(loaded);
      adaptive.schemaVersion = 9;
      const source = {
        path: "README.md",
        content: git(checkout, "show", `${adaptive.baseSha}:README.md`),
      };
      const resolver = createPlanningContextResolver({
        config,
        objective: adaptive.objective,
        runId: adaptive.runId,
        baseSha: adaptive.baseSha,
        sources: [source],
        objectiveBody: "## Adaptive workflow\nenabled\n",
        contentStore: store,
      });
      adaptive.planningRecovery = {
        phase: "ready",
        history: [],
        contextLookup: await initializeContextLookup(resolver),
      };
      adaptive.work.api = {
        status: "running",
        step: "execute",
        attempt: "api-role-attempt",
        baseSha: result.changeRef,
        executionBaseSha: result.changeRef,
        graphRevisionDigest: graphDigest(adaptive.graph),
      };
      const knowledge = await completeObjectiveKnowledge({
        state: adaptive,
        item: consumer,
        checkout,
        baseSha: result.changeRef,
        store,
      });
      const rolePath = join(root, "private-state", "role-context.json");
      let initialRoleSaves = 0;
      const saveRole = () => {
        initialRoleSaves++;
        const id = adaptive.work.api.adaptiveContextId;
        assert.ok(adaptive.adaptiveContexts[id]);
        saveState(rolePath, adaptive);
      };
      const selected = await buildAdaptiveContext({
        state: adaptive,
        role: "dispatch",
        item: consumer,
        baseSha: result.changeRef,
        checkout,
        store,
        config,
        sources: [source],
        required: { sources: [source], knowledge: knowledge.view },
        requiredSelections: knowledge.selections,
        save: saveRole,
      });
      assert.equal(initialRoleSaves, 1);
      const roleSnapshot = readFileSync(rolePath, "utf8");
      const roleReload = parseFactoryState(
        JSON.parse(roleSnapshot),
        adaptive.repository,
        adaptive.objective,
      );
      assert.deepEqual(
        roleReload.adaptiveContexts[selected.packet.id],
        selected.packet,
      );
      assert.equal(roleReload.work.api.adaptiveContextId, selected.packet.id);
      assert.deepEqual(
        await authenticateAdaptiveContextPacket(
          store,
          roleReload.adaptiveContexts[selected.packet.id],
        ),
        selected.payload,
      );
      assert.ok(
        selected.packet.selections.some(
          (entry) => entry.kind === "interface" && entry.required,
        ),
      );
      const supplied = JSON.stringify(selected.payload.required);
      assert.ok(
        supplied.includes(
          Buffer.from('{"timestamp":"UTC"}\n').toString("base64"),
        ),
      );
      assert.ok(supplied.includes(source.content.replaceAll("\n", "\\n")));
      // A real peer finishes after dispatch. Its newly published advisory facts
      // change live selection without changing this attempt's admitted input.
      const peerCheckout = join(root, "peer-target");
      git(
        checkout,
        "worktree",
        "add",
        "--detach",
        peerCheckout,
        result.changeRef,
      );
      writeFileSync(join(peerCheckout, "ui.json"), '{"format":"UTC"}\n');
      writeFileSync(
        join(peerCheckout, ".factory-handoff.json"),
        JSON.stringify({
          notes: [
            {
              kind: "pitfall",
              summary: "Peer UI requires the timestamp format",
              paths: ["ui.json"],
              consumerIndices: [0],
            },
          ],
        }),
      );
      const peerResult = await collectWorktreeResult(
        checkout,
        peerCheckout,
        {
          item: peer,
          handoffPeers: [{ id: consumer.id, title: consumer.title }],
          baseSha: result.changeRef,
          attemptId: "ui-role-attempt",
        },
        store,
        {},
      );
      roleReload.work.ui = {
        status: "done",
        attempt: "ui-role-attempt",
        changeRef: peerResult.changeRef,
        treeSha: peerResult.treeSha,
      };
      await publishObjectiveKnowledge(roleReload, peer, peerResult, store);
      const changedKnowledge = await completeObjectiveKnowledge({
        state: roleReload,
        item: consumer,
        checkout,
        baseSha: result.changeRef,
        store,
      });
      assert.notDeepEqual(changedKnowledge.view, knowledge.view);
      assert.ok(
        JSON.stringify(changedKnowledge.view).includes("Peer UI requires"),
      );
      {
        // The same settled Git handoff supplies an attributable material event.
        // Reflection adds no worker, graph change, acceptance or repair charge.
        const reflected = structuredClone(loaded);
        reflected.schemaVersion = 13;
        reflected.planningRecovery = structuredClone(adaptive.planningRecovery);
        const reflectedPath = join(root, "private-state", "reflection.json");
        const originalWork = structuredClone(reflected.work);
        const originalGraph = graphDigest(reflected.graph);
        const originalCharges = structuredClone(reflected.charges);
        let reflectionSaves = 0;
        const reflect = () =>
          reflectWorkflow({
            state: reflected,
            event: { kind: "completion", itemId: "schema" },
            store,
            save: () => {
              reflectionSaves++;
              saveState(reflectedPath, reflected);
            },
          });
        const reflection = await reflect();
        assert.equal(reflection.action.kind, "existing-critical-path");
        assert.ok(reflection.action.eligibleItemIds.includes("api"));
        assert.equal(reflection.baseline.currentProofs, 0);
        assert.ok(
          workflowStageObligations(reflected).every(
            (proof) => proof.disposition === "missing",
          ),
        );
        const retainedBody = await readWorkflowReflection(store, reflection);
        assert.equal(
          retainedBody.observations.items.find((entry) => entry.id === "schema")
            .changeRef,
          result.changeRef,
        );
        assert.equal(retainedBody.previousRecord, null);
        const reflectionSnapshot = readFileSync(reflectedPath, "utf8");
        const reflectionReload = parseFactoryState(
          JSON.parse(reflectionSnapshot),
          reflected.repository,
          reflected.objective,
        );
        assert.deepEqual(reflectionReload.workflowReflection.records, [
          reflection,
        ]);
        assert.equal((await reflect()).id, reflection.id);
        assert.equal(reflectionSaves, 1);
        assert.equal(readFileSync(reflectedPath, "utf8"), reflectionSnapshot);
        assert.deepEqual(reflected.work, originalWork);
        assert.equal(graphDigest(reflected.graph), originalGraph);
        assert.deepEqual(reflected.charges, originalCharges);
        reflected.work.ui = structuredClone(roleReload.work.ui);
        const reassessed = await reflectWorkflow({
          state: reflected,
          event: { kind: "completion", itemId: "ui" },
          store,
          save: () => {
            reflectionSaves++;
            saveState(reflectedPath, reflected);
          },
        });
        assert.equal(reassessed.assessment.outcome, "useful-progress");
        assert.equal(reassessed.assessment.completedItemDelta, 1);
        assert.equal(reassessed.assessment.currentProofDelta, 0);
        const reassessmentBody = await readWorkflowReflection(
          store,
          reassessed,
        );
        assert.deepEqual(reassessmentBody.previousRecord, reflection);
        assert.deepEqual(
          await readWorkflowReflection(store, reassessmentBody.previousRecord),
          retainedBody,
        );
        assert.equal(reflectionSaves, 2);
        // A terminal cancellation of this same real Git workflow retains the
        // original material observations; consolidation never upgrades them to
        // acceptance or causal evidence and performs no provider call.
        reflected.cancelledAt = new Date().toISOString();
        const terminalPath = statePath(config.repository, reflected.objective);
        saveState(terminalPath, reflected);
        const terminalBytes = readFileSync(terminalPath, "utf8");
        const learningStoreRoot = join(stateRoot(config.repository), "content");
        mkdirSync(stateRoot(config.repository), {
          recursive: true,
          mode: 0o700,
        });
        cpSync(join(root, "private-content"), learningStoreRoot, {
          recursive: true,
        });
        const episode = recordRetrospective(config, reflected.objective);
        assert.equal(episode.outcome, "cancelled");
        // The snapshot record names the terminal state by reference.
        const snapshotRecord = readFileSync(
          episode.sourceLinks.find((link) => link.includes("/snapshots/")),
          "utf8",
        );
        assert.equal(
          episode.snapshotDigest,
          createHash("sha256").update(snapshotRecord).digest("hex"),
        );
        assert.equal(
          JSON.parse(snapshotRecord).stateRef.digest,
          createHash("sha256").update(terminalBytes).digest("hex"),
        );
        assert.deepEqual(
          episode.experiences.workflowReflection,
          reflected.workflowReflection,
        );
        const prepared = await prepareDreamInput(config, {
          budgetBytes: DEFAULT_PLAYBOOK_BUDGET_BYTES,
          inputBudgetBytes: 262144,
        });
        assert.equal(prepared.checkpoint.bounds.maxResults, 1);
        assert.equal(prepared.checkpoint.bounds.maxBytes, 262144);
        assert.equal(prepared.checkpoint.playbookBudgetBytes, 16384);
        assert.equal(prepared.checkpoint.included.length, 1);
        assert.equal(prepared.checkpoint.included[0].supporting.length, 2);
        const packet = JSON.parse(prepared.sourcePacket);
        assert.equal(packet.parent, null);
        assert.equal(packet.sources[0].episode.outcome, "cancelled");
        assert.deepEqual(
          packet.sources[0].supporting[1].body,
          reassessmentBody,
        );
        assert.equal(
          packet.sources[0].supporting[1].body.previousRecord.id,
          reflection.id,
        );
        const binding = {
          checkpointId: prepared.checkpoint.id,
          checkpointDigest: prepared.checkpointDigest,
        };
        assert.deepEqual(
          readDreamCheckpoint(config.repository, binding),
          prepared.checkpoint,
        );
        const restartedStore = new LocalContentStore(learningStoreRoot);
        assert.equal(
          restartedStore
            .readBytes(prepared.checkpoint.inputPacketRef)
            .toString("utf8"),
          prepared.sourcePacket,
        );
        // Budget the actual serialized episode and keep larger workflow bodies
        // as explicit deferred identities rather than silently truncating them.
        const episodeOnly = structuredClone(packet);
        episodeOnly.sources[0].supporting = [];
        const smaller = await prepareDreamInput(config, {
          budgetBytes: DEFAULT_PLAYBOOK_BUDGET_BYTES,
          inputBudgetBytes: Buffer.byteLength(JSON.stringify(episodeOnly)),
        });
        assert.equal(smaller.checkpoint.included.length, 1);
        assert.deepEqual(smaller.checkpoint.included[0].supporting, []);
        assert.equal(
          smaller.checkpoint.deferred.filter((entry) =>
            entry.reason.includes("input allowance"),
          ).length,
          2,
        );
        assert.ok(
          Buffer.byteLength(smaller.sourcePacket) <=
            smaller.checkpoint.bounds.maxBytes,
        );
        assert.equal(readFileSync(terminalPath, "utf8"), terminalBytes);
        assert.deepEqual(dreamSubmissionHolds(config.repository), []);
        {
          // A submission the dispatch checkpoint admitted stays unknown even
          // when its call only started and failed.
          const { checkpoint } = prepared;
          const learning = join(stateRoot(config.repository), "learning");
          const observation = (type) => ({
            type,
            invocationId: checkpoint.invocationId,
            phase: "dream",
            ordinal: 0,
            providerAttempt: 1,
            providerMaxAttempts: 1,
            ...(type === "failed" && { usageAvailable: false }),
          });
          const submission = {
            schemaVersion: 1,
            id: checkpoint.id,
            invocationId: checkpoint.invocationId,
            checkpointDigest: prepared.checkpointDigest,
            sourceDigest: checkpoint.inputPacketRef.digest,
            configDigest: checkpoint.configDigest,
            parent: checkpoint.parent,
            providerAttempt: 1,
            providerMaxAttempts: 1,
            at: new Date().toISOString(),
            dispatchAdmitted: true,
            outcome: "submitted-outcome-unobserved",
            usage: "unavailable",
            reconciliation: "not-exposed",
          };
          const submissionPath = join(
            learning,
            "submissions",
            `${checkpoint.id}.json`,
          );
          const callPath = join(learning, "calls", `${checkpoint.id}.json`);
          mkdirSync(join(learning, "calls"), { recursive: true, mode: 0o700 });
          writeFileSync(
            callPath,
            JSON.stringify({
              invocationId: checkpoint.invocationId,
              phase: "dream",
              sourceDigest: checkpoint.inputPacketRef.digest,
              checkpointDigest: prepared.checkpointDigest,
              observations: [observation("started"), observation("failed")],
              outcome: "failed",
            }),
            { mode: 0o600 },
          );
          writeFileSync(submissionPath, JSON.stringify(submission), {
            mode: 0o600,
          });
          assert.equal(dreamSubmissionHolds(config.repository).length, 1);
          rmSync(submissionPath);
          rmSync(callPath);
        }
        const closure = learningPersistenceClosure(config.repository);
        assert.ok(
          closure.records.some(
            (entry) =>
              entry.path ===
              `learning/checkpoints/${prepared.checkpoint.id}.json`,
          ),
        );
        const original = closure.records.find((entry) =>
          entry.path.startsWith("learning/snapshots/"),
        );
        assert.equal(
          restartedStore
            .readBytes(
              JSON.parse(
                restartedStore.readBytes(original.ref).toString("utf8"),
              ).stateRef,
            )
            .toString("utf8"),
          terminalBytes,
        );
        assert.ok(
          closure.contentRefs.some(
            (ref) => ref.digest === reassessed.bodyRef.digest,
          ),
        );
        assert.deepEqual(closure.unavailable, []);
        // A checkpoint is usable only with its exact retained packet body.
        const packetPath = join(
          learningStoreRoot,
          prepared.checkpoint.inputPacketRef.digest.slice(0, 2),
          prepared.checkpoint.inputPacketRef.digest,
        );
        const originalPacket = readFileSync(packetPath);
        writeFileSync(packetPath, "changed bytes");
        assert.throws(
          () => readDreamCheckpoint(config.repository, binding),
          /digest|content|integrity|changed/i,
        );
        writeFileSync(packetPath, originalPacket, { mode: 0o600 });
        rmSync(packetPath);
        assert.throws(
          () => readDreamCheckpoint(config.repository, binding),
          /ENOENT|missing|unavailable|content/i,
        );
        writeFileSync(packetPath, originalPacket, { mode: 0o600 });
        assert.deepEqual(
          readDreamCheckpoint(config.repository, binding),
          prepared.checkpoint,
        );
      }
      saveState(rolePath, roleReload);
      const peerSnapshot = readFileSync(rolePath, "utf8");
      let restartSaves = 0;
      const resumeDispatch = (
        state,
        overrides = {},
        save = () => {
          restartSaves++;
          saveState(rolePath, state);
        },
      ) =>
        buildAdaptiveContext({
          state,
          role: "dispatch",
          item: consumer,
          baseSha: result.changeRef,
          checkout,
          store,
          config,
          sources: [source],
          required: { sources: [source], knowledge: changedKnowledge.view },
          requiredSelections: changedKnowledge.selections,
          save,
          ...overrides,
        });
      const reused = await resumeDispatch(roleReload);
      assert.equal(reused.packet.id, selected.packet.id);
      assert.deepEqual(reused.payload, selected.payload);
      assert.equal(roleReload.work.api.adaptiveContextId, selected.packet.id);
      assert.equal(restartSaves, 0);
      assert.equal(readFileSync(rolePath, "utf8"), peerSnapshot);
      // A unique older pre-pointer checkpoint restores the original identity
      // through one ordinary atomic save, without rebuilding its payload.
      const prePointer = structuredClone(roleReload);
      delete prePointer.work.api.adaptiveContextId;
      saveState(rolePath, prePointer);
      const recovered = await resumeDispatch(prePointer);
      assert.equal(recovered.packet.id, selected.packet.id);
      assert.deepEqual(recovered.payload, selected.payload);
      assert.equal(restartSaves, 1);
      assert.equal(
        parseFactoryState(
          JSON.parse(readFileSync(rolePath, "utf8")),
          adaptive.repository,
          adaptive.objective,
        ).work.api.adaptiveContextId,
        selected.packet.id,
      );
      assert.equal(readFileSync(rolePath, "utf8"), peerSnapshot);
      const changedOwner = structuredClone(roleReload);
      changedOwner.work.api.attempt = "foreign-attempt";
      assert.throws(
        () => saveState(rolePath, changedOwner),
        /selected adaptive context differs/,
      );
      await assert.rejects(
        () => resumeDispatch(changedOwner),
        /admitted attempt/,
      );
      await assert.rejects(
        () => resumeDispatch(roleReload, { baseSha: adaptive.baseSha }),
        /admitted attempt/,
      );
      await assert.rejects(
        () =>
          resumeDispatch(roleReload, {
            sources: [
              { ...source, content: `${source.content}\nChanged source` },
            ],
          }),
        /complete supplied Source bytes/,
      );
      assert.equal(restartSaves, 1);
      assert.equal(readFileSync(rolePath, "utf8"), peerSnapshot);
      const owned = structuredClone(roleReload);
      saveState(rolePath, owned);
      const ownedSnapshot = readFileSync(rolePath, "utf8");
      const ownedBefore = structuredClone(owned);
      rmSync(
        join(
          root,
          "private-content",
          selected.packet.contentRef.digest.slice(0, 2),
          selected.packet.contentRef.digest,
        ),
      );
      // The retained snapshot remains inspectable; another call cannot use missing bytes.
      assert.equal(
        parseFactoryState(
          JSON.parse(ownedSnapshot),
          adaptive.repository,
          adaptive.objective,
        ).work.api.attempt,
        "api-role-attempt",
      );
      await assert.rejects(
        () => authenticateAdaptiveContextPacket(store, selected.packet),
        /missing/,
      );
      await assert.rejects(() => resumeDispatch(owned), /missing/);
      assert.deepEqual(owned, ownedBefore);
      assert.equal(owned.work.api.adaptiveContextId, selected.packet.id);
      assert.equal(restartSaves, 1);
      assert.equal(readFileSync(rolePath, "utf8"), ownedSnapshot);
    }
    {
      // Reuse this real Git/ContentStore and atomic snapshot workflow for expansion:
      // the checkpoint records possible submission, not an invented GitHub response.
      const inventorySpec = {
        mode: "inventory",
        selectors: ["README.md"],
        schema: "factory.repository-inventory/v1",
        role: "affected-files",
        completeness: "complete",
        allowance: { maxEntries: 10, maxBytes: 1024, maxAttempts: 1 },
      };
      const inventoryItem = {
        ...item("inventory", [], []),
        kind: "discovery",
        discovery: inventorySpec,
      };
      const expanded = structuredClone(loaded);
      expanded.schemaVersion = 11;
      expanded.work = Object.fromEntries(
        expanded.graph.items.map((entry) => [entry.id, { status: "pending" }]),
      );
      expanded.graph.items.push(inventoryItem);
      expanded.graph.expansions = [
        {
          schemaVersion: 1,
          id: "migration",
          input: {
            producerItemId: "inventory",
            role: "affected-files",
            schema: inventorySpec.schema,
          },
          selectors: ["README.md"],
          workShape: "migration",
          selection: { kind: "all-regular-files" },
          batching: { maxFilesPerChild: 1 },
          limits: { maxChildren: 2, maxIterations: 1 },
          resources: [],
          eligibleProfileIds: [],
          dependencies: [],
          integrationBarrierItemIds: ["docs"],
          empty: "settle-without-children",
          template: item("migration-template", [], ["README.md"]),
        },
      ];
      for (const candidate of [
        ...expanded.graph.items,
        expanded.graph.expansions[0].template,
      ]) {
        candidate.nonGoals = ["Do not change unrelated files"];
        candidate.citations = [{ path: "README.md" }];
      }
      expanded.planGraphDigest = graphDigest(expanded.graph);
      expanded.approvedPlaybookAdmission.graphDigest = expanded.planGraphDigest;
      expanded.issueByItemId.inventory = 6;
      const inventoryManifest = await discoverRepository({
        checkout,
        baseSha,
        specification: inventorySpec,
        producer: {
          objective: 1,
          runId: expanded.runId,
          itemId: "inventory",
          attemptId: "inventory-attempt",
        },
        store,
      });
      expanded.work.inventory = {
        status: "done",
        attempt: "inventory-attempt",
        baseSha,
        discoveryOutput: inventoryManifest,
      };
      const inventoryBody = await authenticateDiscoveryOutput({
        checkout,
        specification: inventorySpec,
        manifest: inventoryManifest,
        store,
      });
      const materialized = materializeGraphExpansion({
        graph: expanded.graph,
        envelopeId: "migration",
        manifest: inventoryManifest,
        body: inventoryBody,
        runId: expanded.runId,
      });
      const inputBytes = new TextEncoder().encode(
        JSON.stringify(materialized.inputPacket),
      );
      const inputPacketRef = await store.put(
        new ReadableStream({
          start(controller) {
            controller.enqueue(inputBytes);
            controller.close();
          },
        }),
        { mediaType: "application/json" },
      );
      const expansionReceipt = {
        schemaVersion: 1,
        id: `migration-${materialized.digest}`,
        envelopeId: "migration",
        parentGraphDigest: graphDigest(expanded.graph),
        graphDigest: graphDigest(materialized.graph),
        envelopeDigest: materialized.envelopeDigest,
        materializationDigest: materialized.digest,
        inputPacketRef,
        childIds: materialized.childIds,
      };
      expanded.pendingExpansion = {
        ...expansionReceipt,
        graph: materialized.graph,
        phase: "admitted",
        issueByItemId: { ...expanded.issueByItemId },
      };
      const projectionRemote = join(root, "projection-archive.git");
      git(root, "init", "--bare", projectionRemote);
      const projectionConfig = {
        repository: `fixture/projection-${randomUUID()}`,
        checkout,
        execution: { kind: "local" },
        policy: { allowedSecretNames: [] },
        gitPersistence: {
          remote: projectionRemote,
          ref: "refs/heads/history",
          visibility: "private",
          scope: "private-history",
          maxBytes: 16 * 1024 * 1024,
          maxFiles: 4096,
          timeoutMs: 30000,
          coalesceMs: 0,
        },
      };
      const expansionPath = join(root, "private-state", "expansion.json");
      const saveExpanded = () => saveState(expansionPath, expanded);
      saveExpanded();
      const effectMetadata = {
        method: "POST",
        path: `repos/${expanded.repository}/issues`,
        bodyDigest: createHash("sha256")
          .update(
            JSON.stringify({
              title: materialized.graph.items.find(
                (entry) => entry.id === materialized.childIds[0],
              ).title,
            }),
          )
          .digest("hex"),
      };
      const effect = {
        key: `issue-create:${materialized.childIds[0]}`,
        id: createHash("sha256")
          .update(JSON.stringify(effectMetadata))
          .digest("hex"),
        ...effectMetadata,
      };
      await graphProjectionControl(
        expanded,
        materialized.graph,
        saveExpanded,
      ).beforeWrite(effect);
      // Use this real discovery's graph in a fresh pending projection, without
      // importing the earlier fixture's deliberately edited memory episodes.
      const projectionState = {
        schemaVersion: 11,
        repository: projectionConfig.repository,
        objective: 1,
        runId: randomUUID(),
        configDigest: factoryConfigDigest(projectionConfig),
        baseSha: materialized.graph.baseSha,
        graph: structuredClone(materialized.graph),
        planGraphDigest: graphDigest(materialized.graph),
        publicationContract: "exact-request-v1",
        objectiveCommands: [],
        objectiveBodyDigest: "b".repeat(64),
        approvedPlaybookPin: null,
        approvedPlaybookAdmission: {
          approvedPlaybookPin: null,
          configDigest: factoryConfigDigest(projectionConfig),
          graphDigest: graphDigest(materialized.graph),
          packetDigest: "c".repeat(64),
          reviewDigest: "d".repeat(64),
          sourcePacketDigest: "e".repeat(64),
        },
        capacity: { concurrency: 1 },
        autonomy: resolveAutonomy(),
        issueByItemId: Object.fromEntries(
          materialized.graph.items.map((item, index) => [item.id, index + 2]),
        ),
        work: Object.fromEntries(
          materialized.graph.items.map((item) => [
            item.id,
            { status: "pending" },
          ]),
        ),
      };
      const projectionPath = statePath(projectionState.repository, 1);
      const saveProjection = () => saveState(projectionPath, projectionState);
      saveProjection();
      const projectionMetadata = {
        ...effectMetadata,
        path: `repos/${projectionState.repository}/issues`,
      };
      const projectionEffect = {
        ...effect,
        ...projectionMetadata,
        id: createHash("sha256")
          .update(JSON.stringify(projectionMetadata))
          .digest("hex"),
      };
      const projectionControl = graphProjectionControl(
        projectionState,
        projectionState.graph,
        saveProjection,
      );
      await withRecoveryCheckpointScope(
        {
          config: projectionConfig,
          buildClosure: () =>
            buildRecoveryCheckpointClosure({ config: projectionConfig }),
        },
        async () => {
          await projectionControl.beforeWrite(projectionEffect);
          const intentAck =
            gitPersistenceStatus(projectionConfig).lastAcknowledged;
          assert.ok(intentAck);
          const receipt = {
            outcome: "responded",
            responseDigest: createHash("sha256")
              .update(inputBytes)
              .digest("hex"),
            identity: { id: 6, number: 6 },
          };
          await projectionControl.observed(projectionEffect.id, receipt);
          await projectionControl.observed(projectionEffect.id, {
            ...receipt,
            outcome: "reconciled",
          });
          assert.equal(
            gitPersistenceStatus(projectionConfig).lastAcknowledged.commitSha,
            intentAck.commitSha,
            "response and readback stay local until the next effect or completion",
          );
          const locallySaved = parseFactoryState(
            JSON.parse(readFileSync(projectionPath, "utf8")),
            projectionState.repository,
            projectionState.objective,
          );
          assert.equal(
            locallySaved.graphProjectionIntents[expansionReceipt.graphDigest]
              .effects[0].reconciliation.outcome,
            "reconciled",
          );
          await projectionControl.complete();
          const finalAck =
            gitPersistenceStatus(projectionConfig).lastAcknowledged;
          assert.notEqual(finalAck.commitSha, intentAck.commitSha);
          const archived = await readVerifiedRecoveryCheckpoint(
            projectionConfig,
            finalAck.commitSha,
          );
          const snapshot = archived.manifest.files.find(
            (entry) => entry.path === "objectives/1/state.json",
          );
          const complete = JSON.parse(
            Buffer.from(await archived.readVerifiedBlob(snapshot.ref)).toString(
              "utf8",
            ),
          );
          assert.deepEqual(
            complete.graphProjectionIntents[expansionReceipt.graphDigest]
              .effects,
            projectionState.graphProjectionIntents[expansionReceipt.graphDigest]
              .effects,
          );
        },
      );
      const reloadedExpansion = parseFactoryState(
        JSON.parse(readFileSync(expansionPath, "utf8")),
        expanded.repository,
        1,
      );
      assert.deepEqual(
        reloadedExpansion.pendingExpansion.childIds,
        materialized.childIds,
      );
      assert.equal(
        reloadedExpansion.graphProjectionIntents[expansionReceipt.graphDigest]
          .effects[0].observation,
        undefined,
      );
      await assert.rejects(
        () =>
          graphProjectionControl(
            reloadedExpansion,
            reloadedExpansion.pendingExpansion.graph,
            () => saveState(expansionPath, reloadedExpansion),
          ).beforeWrite(effect),
        /already submitted/,
      );
      assert.deepEqual(
        [
          ...(await authenticateExpansionInputs({
            state: reloadedExpansion,
            config: { checkout, execution: { kind: "local" } },
            contentStore: store,
          })),
        ],
        [],
      );
      const settledReceipt = {
        ...expansionReceipt,
        acceptedAt: new Date().toISOString(),
      };
      reloadedExpansion.graphRevisions = [
        {
          graph: structuredClone(reloadedExpansion.graph),
          digest: reloadedExpansion.planGraphDigest,
        },
        {
          graph: structuredClone(materialized.graph),
          digest: expansionReceipt.graphDigest,
          parentDigest: expansionReceipt.parentGraphDigest,
          expansion: settledReceipt,
          acceptedAt: settledReceipt.acceptedAt,
        },
      ];
      reloadedExpansion.graph = materialized.graph;
      reloadedExpansion.expansionHistory = [settledReceipt];
      delete reloadedExpansion.pendingExpansion;
      reloadedExpansion.work[materialized.childIds[0]] = { status: "pending" };
      reloadedExpansion.issueByItemId[materialized.childIds[0]] = 7;
      saveState(expansionPath, reloadedExpansion);
      const settledReload = parseFactoryState(
        JSON.parse(readFileSync(expansionPath, "utf8")),
        expanded.repository,
        1,
      );
      assert.deepEqual(
        [
          ...(await authenticateExpansionInputs({
            state: settledReload,
            config: { checkout, execution: { kind: "local" } },
            contentStore: store,
          })),
        ],
        ["migration"],
      );
      const changedProducer = structuredClone(settledReload);
      changedProducer.work.inventory.discoveryOutput.producer.attemptId =
        "other-attempt";
      await assert.rejects(
        authenticateExpansionInputs({
          state: changedProducer,
          config: { checkout, execution: { kind: "local" } },
          contentStore: store,
        }),
        /exact complete accepted discovery/,
      );
      const preservedExpansion = readFileSync(expansionPath, "utf8");
      rmSync(
        join(
          root,
          "private-content",
          inputPacketRef.digest.slice(0, 2),
          inputPacketRef.digest,
        ),
      );
      await assert.rejects(
        authenticateExpansionInputs({
          state: settledReload,
          config: { checkout, execution: { kind: "local" } },
          contentStore: store,
        }),
        /ENOENT|missing|unavailable/i,
      );
      assert.equal(readFileSync(expansionPath, "utf8"), preservedExpansion);
      // Missing retained bytes still allow diagnostics/cancellation to parse state.
      parseFactoryState(JSON.parse(preservedExpansion), expanded.repository, 1);
    }
    // Historical graph snapshots have no planner-session inputs. A real
    // execution pass probes amendments even when only final review remains.
    const legacy = structuredClone(loaded);
    legacy.objectiveBodyDigest = createHash("sha256")
      .update(git(checkout, "show", `${legacy.baseSha}:README.md`))
      .digest("hex");
    for (const work of Object.values(legacy.work)) work.status = "done";
    const legacyPath = join(root, "private-state", "legacy.json");
    saveState(legacyPath, legacy);
    const legacyReload = parseFactoryState(
      JSON.parse(readFileSync(legacyPath, "utf8")),
      legacy.repository,
      legacy.objective,
    );
    const legacySelection = { model: "unused", reasoningEffort: "low" };
    const legacyModel = new StructuredPlanningModel(
      new CodexPlanningTransport(
        checkout,
        legacySelection,
        legacySelection,
        undefined,
        [],
        join(root, "legacy-planner-homes"),
      ),
    );
    const retainedGraph = structuredClone(legacyReload.graph);
    const retainedWork = structuredClone(legacyReload.work);
    assert.equal(
      await applyPendingAmendment({
        state: legacyReload,
        config: { repository: legacy.repository, checkout },
        body: git(checkout, "show", `${legacy.baseSha}:README.md`),
        model: legacyModel,
        // The real adapter must never start a provider process for a no-op.
        save: () => saveState(legacyPath, legacyReload),
        cancelled: () => false,
      }),
      false,
    );
    const continuedLegacy = parseFactoryState(
      JSON.parse(readFileSync(legacyPath, "utf8")),
      legacy.repository,
      legacy.objective,
    );
    assert.deepEqual(continuedLegacy.graph, retainedGraph);
    assert.deepEqual(continuedLegacy.work, retainedWork);
    assert.equal(continuedLegacy.sourcePacketDigest, undefined);
    assert.equal(continuedLegacy.agentSessions, undefined);
    assert.equal(
      agentSessionContinuation(
        continuedLegacy,
        "objective-review",
        undefined,
        () => saveState(legacyPath, continuedLegacy),
      ).scope.graphDigest,
      graphDigest(retainedGraph),
    );
    assert.throws(
      () =>
        agentSessionContinuation(continuedLegacy, "planning", undefined, () =>
          saveState(legacyPath, continuedLegacy),
        ),
      /Planner immutable sourcePacketDigest is unavailable/,
    );
    await releaseAgentSessions(continuedLegacy, undefined, undefined, () =>
      saveState(legacyPath, continuedLegacy),
    );
    assert.equal(existsSync(join(root, "legacy-planner-homes")), false);
    // Eligible discoveries still enter the planner and retain the strict
    // missing-input fence instead of being skipped as a historical no-op.
    continuedLegacy.work.api.attempt = "legacy-discovery";
    continuedLegacy.work.api.discovery = {
      scope: "in-scope",
      reason: "Extend the accepted interface",
      evidence: ["schema.json"],
      ownership: ["api.json"],
      acceptance: ["Implement owned files"],
      dependencies: ["schema"],
      attempt: "legacy-discovery",
    };
    await assert.rejects(
      () =>
        applyPendingAmendment({
          state: continuedLegacy,
          config: { repository: legacy.repository, checkout },
          body: git(checkout, "show", `${legacy.baseSha}:README.md`),
          model: legacyModel,
          save: () => saveState(legacyPath, continuedLegacy),
          cancelled: () => false,
        }),
      /Planner immutable sourcePacketDigest is unavailable/,
    );
    assert.equal(continuedLegacy.pendingAmendment.phase, "ready");
    assert.equal(continuedLegacy.work.api.discoveryDisposition, "proposed");
    assert.equal(existsSync(join(root, "legacy-planner-homes")), false);
    // A planner question holds the amendment at its compilation (#1296):
    // asking again starts no provider process and spends no revision.
    const asking = structuredClone(continuedLegacy);
    asking.pendingAmendment.decisions = [
      { question: "May the catalog membership assertion grow?" },
    ];
    const revisionsBefore = consumption(asking).planningRevisions;
    await assert.rejects(
      () =>
        applyPendingAmendment({
          state: asking,
          config: { repository: legacy.repository, checkout },
          body: git(checkout, "show", `${legacy.baseSha}:README.md`),
          model: legacyModel,
          save: () => saveState(legacyPath, asking),
          cancelled: () => false,
        }),
      /May the catalog membership assertion grow\?.*factory decide --objective/,
    );
    assert.equal(asking.pendingAmendment.phase, "ready");
    assert.equal(consumption(asking).planningRevisions, revisionsBefore);
    assert.equal(existsSync(join(root, "legacy-planner-homes")), false);
    const refusing = structuredClone(asking);
    decideAmendment(asking, {
      actor: "operator",
      outcome: "accept",
      answer: "Yes, only for the added components",
      reason: "The Objective requires them",
    });
    saveState(legacyPath, asking);
    const answered = parseFactoryState(
      JSON.parse(readFileSync(legacyPath, "utf8")),
      legacy.repository,
      legacy.objective,
    );
    assert.equal(
      answered.pendingAmendment.decisions[0].answer.answer,
      "Yes, only for the added components",
    );
    assert.equal(answered.pendingAmendment.phase, "ready");
    assert.throws(
      () =>
        decideAmendment(answered, {
          actor: "operator",
          outcome: "refuse",
          reason: "Already answered",
        }),
      /No amendment decision is pending/,
    );
    refusing.charges = {
      ...refusing.charges,
      [`objective/amend/${refusing.pendingAmendment.id}`]: {
        allowances: ["planningRevisions"],
        scopes: ["$planning"],
      },
    };
    decideAmendment(refusing, {
      actor: "operator",
      outcome: "refuse",
      reason: "The Objective forbids this change",
    });
    assert.equal(refusing.pendingAmendment.phase, "rejected");
    assert.equal(refusing.pendingAmendment.rejectionStage, "decision");
    assert.equal(consumption(refusing).planningRevisions, revisionsBefore);
    // The refused amendment gave its charge back and still saves and loads.
    saveState(legacyPath, refusing);
    const refused = parseFactoryState(
      JSON.parse(readFileSync(legacyPath, "utf8")),
      legacy.repository,
      legacy.objective,
    );
    assert.equal(refused.pendingAmendment.phase, "rejected");
    // The refused question is no longer open: status, run outcome and decide
    // routing move on to the replacement instead of asking it again.
    assert.equal(openAmendmentQuestion(refused), undefined);
    assert.throws(
      () =>
        decideAmendment(refused, {
          actor: "operator",
          outcome: "refuse",
          reason: "Asked again",
        }),
      /No amendment decision is pending/,
    );
    // A blind rerun names the rejection wait again; no provider starts.
    await assert.rejects(
      () =>
        applyPendingAmendment({
          state: refused,
          config: { repository: legacy.repository, checkout },
          body: git(checkout, "show", `${legacy.baseSha}:README.md`),
          model: legacyModel,
          save: () => saveState(legacyPath, refused),
          cancelled: () => false,
        }),
      (error) =>
        error.name === "AmendmentRejection" &&
        /The operator refused the amendment/.test(error.message),
    );
    assert.equal(existsSync(join(root, "legacy-planner-homes")), false);
    await store.verify(loaded.work.schema.knowledge.recordRef);
    const current = objectiveKnowledgeView(
      loaded,
      consumer,
      checkout,
      result.changeRef,
    );
    assert.equal(current.entries.length, 2);
    assert.equal(current.entries[0].sources[0].availability, "current-bytes");
    assert.equal(current.entries[0].authority, "advisory-agent-claim");
    assert.equal(
      current.entries[1].sources[0].availability,
      "unavailable-in-execution-base",
    );
    const crossBranch = objectiveKnowledgeView(
      loaded,
      peer,
      checkout,
      request.baseSha,
    );
    assert.equal(crossBranch.entries.length, 1);
    assert.equal(crossBranch.entries[0].relationship, "cross-branch-lead");
    assert.equal(
      crossBranch.entries[0].sources[0].availability,
      "unavailable-in-execution-base",
    );
    assert.equal(
      objectiveKnowledgeView(loaded, unrelated, checkout, result.changeRef)
        .entries.length,
      0,
    );
    loaded.work.schema.status = "published";
    loaded.work.schema.pullRequest = 6;
    assert.equal(
      objectiveKnowledgeView(loaded, consumer, checkout, result.changeRef)
        .entries.length,
      0,
    );
    loaded.work.schema.acceptanceDecisions = [
      {
        criterion: producer.acceptance[0],
        treeSha: result.treeSha,
        actor: "local-integration-controller",
        at: new Date().toISOString(),
        outcome: "accept",
        reason: "Observed exact schema bytes use UTC",
      },
    ];
    loaded.work.schema.validation = {
      treeSha: result.treeSha,
      commands: [],
      criteria: [
        {
          criterion: producer.acceptance[0],
          verdict: "human-accept",
          detail: "Local controller decision",
        },
      ],
    };
    saveState(snapshot, loaded);
    assert.equal(
      objectiveKnowledgeView(loaded, consumer, checkout, result.changeRef)
        .entries.length,
      2,
    );
    assert.equal(
      objectiveKnowledgeView(loaded, peer, checkout, request.baseSha).entries[0]
        .sources[0].availability,
      "unavailable-in-execution-base",
    );
    loaded.work.schema.status = "running";
    assert.equal(
      objectiveKnowledgeView(loaded, consumer, checkout, result.changeRef)
        .entries.length,
      0,
    );
    const ownReview = reviewObjectiveKnowledge(
      loaded,
      "schema",
      checkout,
      result.changeRef,
    );
    assert.equal(ownReview[0].origin, "controller");
    const ownDeclaration = JSON.parse(ownReview[0].content);
    assert.equal(ownDeclaration.candidateCommitSha, result.changeRef);
    // Repository memory keeps the learnings, never the verification map: not in
    // its summary, its retained handoff body or its sources.
    const memoryRoot = mkdtempSync(join(root, "memory-"));
    const memoryStore = new LocalContentStore(join(memoryRoot, "content"));
    const memoryRecords = retainStateMemory(
      { ...loaded, memoryBindings: undefined },
      memoryRoot,
    ).map((binding) =>
      JSON.parse(memoryStore.readBytes(binding.manifestRef).toString("utf8")),
    );
    const memoryHandoff = memoryRecords.find(
      (record) => record.kind === "handoff",
    );
    assert(memoryHandoff);
    assert.equal(memoryHandoff.summary.includes("verification"), false);
    const memoryBody = JSON.parse(
      memoryStore
        .readBytes(
          memoryHandoff.bodies.find((entry) => entry.role === "handoff").ref,
        )
        .toString("utf8"),
    );
    assert.equal(
      memoryBody.notes.some((note) => note.kind === "verification"),
      false,
    );
    assert.equal(memoryBody.notes.length, 2);
    // The filtered body cites its sources by digest; the checkpoint closure
    // binds each one to the record's exact retained source reference. The
    // source bytes live in the worker's store, which production shares.
    for (const record of memoryRecords)
      for (const body of record.bodies)
        if (body.role.startsWith("source:"))
          memoryStore.putBytes(store.readBytes(body.ref), {
            mediaType: body.ref.mediaType,
          });
    const memoryClosure = await buildMemoryLearningClosure({
      repository: loaded.repository,
      root: memoryRoot,
      access: {
        repository: loaded.repository,
        visibility: ["private", "repository"],
      },
    });
    assert.deepEqual(
      memoryBody.sources.map((source) =>
        memoryClosure.contentRefs.some((ref) => ref.digest === source.digest),
      ),
      memoryBody.sources.map(() => true),
    );
    // The item's own review receives its verification map; other workers
    // (the consumer views above) never do.
    const ownVerification = ownDeclaration.view.entries.find(
      (entry) => entry.kind === "verification",
    );
    assert.equal(ownVerification.criterionIndex, 0);
    assert.equal(ownVerification.sources[0].availability, "current-bytes");
    assert.equal(
      ownDeclaration.view.entries[0].relationship,
      "current-item-implementation-claim",
    );
    assert.equal(
      ownDeclaration.view.entries[0].producerDisposition,
      "implementation-claims-without-acceptance-authority",
    );
    assert.equal(
      ownDeclaration.view.entries[0].sources[0].availability,
      "current-bytes",
    );
    assert.equal(
      JSON.parse(
        reviewObjectiveKnowledge(
          loaded,
          undefined,
          checkout,
          result.changeRef,
        )[0].content,
      ).view.entries.length,
      0,
    );
    loaded.work.schema.status = "done";
    // Final review sees the settled learnings and the verification map.
    const finalEntries = JSON.parse(
      reviewObjectiveKnowledge(loaded, undefined, checkout, result.changeRef)[0]
        .content,
    ).view.entries;
    assert.equal(finalEntries.length, 3);
    assert.equal(
      finalEntries.filter((entry) => entry.kind === "verification").length,
      1,
    );
    delete loaded.work.schema.validation;
    delete loaded.work.schema.acceptanceDecisions;
    delete loaded.work.schema.pullRequest;

    // Exercise the stock prepared-request producer and its real strict atomic
    // checkpoint, holding before Codex starts; these are no provider responses.
    let lastPrepared;
    const prepare = async (
      objectiveBody,
      policy,
      retainedFailedResult,
      executionBase = loaded.baseSha,
      noChangeStop = false,
    ) => {
      const originalHead = git(checkout, "rev-parse", "HEAD");
      const preparedState = structuredClone(loaded);
      preparedState.schemaVersion = 17;
      const attempt = randomUUID();
      preparedState.work.api = {
        status: "running",
        step: "execute",
        attempt,
        baseSha: executionBase,
        startedAt: new Date().toISOString(),
      };
      if (retainedFailedResult) {
        // The archived refused attempt this new attempt continues from.
        const detail =
          "Acceptance criterion disproved: a required report field is missing.";
        const failure = {
          digest: createHash("sha256").update(detail).digest("hex"),
          classification: "implementation",
          detail,
          at: new Date().toISOString(),
          continuation: "new-attempt-from-accepted-base",
          unfinishedEdits: "removed",
          decision: "Start a new attempt",
          event: "item/api/validate/0",
        };
        preparedState.work.api.recovery = {
          failure,
          history: [
            {
              at: failure.at,
              work: {
                status: "failed",
                step: "validate",
                attempt: retainedFailedResult.attemptId,
                baseSha: loaded.baseSha,
                changeRef: retainedFailedResult.commitSha,
                treeSha: retainedFailedResult.treeSha,
              },
              failure,
            },
            // A no-change stop after it left no candidate (#1313).
            ...(noChangeStop
              ? [
                  {
                    at: failure.at,
                    work: {
                      status: "failed",
                      step: "execute",
                      attempt: "no-change-attempt",
                      baseSha: loaded.baseSha,
                    },
                    failure: {
                      ...failure,
                      detail: "Worker produced no repository change",
                      digest: createHash("sha256")
                        .update("Worker produced no repository change")
                        .digest("hex"),
                      event: "item/api/execute/1",
                    },
                  },
                ]
              : []),
          ],
        };
      }
      const preparedFile = join(root, `prepared-${attempt}.json`);
      const work = preparedState.work.api;
      const context = executionContext(
        work,
        () => saveState(preparedFile, preparedState),
        undefined,
        undefined,
        undefined,
        preparedState.repository,
        true,
      );
      const hold = new CheckpointAdmissionFailure(
        "Integration admission remains held before native dispatch",
        "before-effect",
      );
      context.admitEffect = async () => {
        throw hold;
      };
      const driver = new LocalExecutionDriver(
        checkout,
        join(stateRoot(preparedState.repository), "worktrees"),
        new CodexHarness(join(root, "prepared-credentials"), "off", {
          model: "unused",
          reasoningEffort: "low",
        }),
        1,
        store,
        "codex",
        undefined,
        {
          repository: preparedState.repository,
          configDigest: preparedState.configDigest,
          policy,
        },
      );
      await assert.rejects(
        driver.start(
          {
            item: preparedState.graph.items.find((item) => item.id === "api"),
            baseSha: executionBase,
            attemptId: attempt,
            objectiveBody,
            ...(retainedFailedResult && { retainedFailedResult }),
            captureContext: {
              objective: 1,
              runId: preparedState.runId,
              attemptId: attempt,
            },
          },
          context,
        ),
        (error) => error === hold,
      );
      assertDurableValue(
        work.execution,
        "Actual prepared execution checkpoint",
      );
      const reloaded = parseFactoryState(
        JSON.parse(readFileSync(preparedFile, "utf8")),
        preparedState.repository,
        1,
      );
      assert.deepEqual(reloaded.work.api.execution, work.execution);
      assert.equal(work.execution.data.phase, "prepared");
      assert.equal(work.execution.data.handle, undefined);
      assert.ok(work.execution.data.admissionBlockedAt);
      assert.equal(git(checkout, "rev-parse", "HEAD"), originalHead);
      lastPrepared = { state: preparedState, file: preparedFile };
      return work.execution.data;
    };
    const absent = (await prepare("## Package manager update\n_No response_\n"))
      .preparedHarnessRequest;
    assert.equal(Object.hasOwn(absent, "packageManagerUpdate"), false);
    assert.equal(Object.hasOwn(absent.capture, "policy"), false);
    const policy = { enabled: false, maxBytesPerInvocation: 1024 };
    const declared = (
      await prepare("## Package manager update\n- `npm@10.1.0`\n", policy)
    ).preparedHarnessRequest;
    assert.equal(declared.packageManagerUpdate, "npm@10.1.0");
    assert.deepEqual(declared.capture.policy, policy);
    // A retried or repaired wrong result continues from its refused candidate
    // (#1313): its tree is the working tree and index of the new attempt's
    // checkout while HEAD stays at the accepted base, and the brief says so.
    const commitOn = (parent, files) => {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: join(root, `index-${randomUUID()}`),
        GIT_AUTHOR_NAME: "Factory Test",
        GIT_AUTHOR_EMAIL: "factory-test@example.invalid",
        GIT_COMMITTER_NAME: "Factory Test",
        GIT_COMMITTER_EMAIL: "factory-test@example.invalid",
      };
      const run = (args, input) =>
        execFileSync("git", ["-C", checkout, ...args], {
          env,
          encoding: "utf8",
          ...(input !== undefined && { input }),
        }).trim();
      run(["read-tree", parent]);
      for (const [path, content] of Object.entries(files))
        run([
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${run(["hash-object", "-w", "--stdin"], content)},${path}`,
        ]);
      const tree = run(["write-tree"]);
      return {
        commitSha: run(["commit-tree", tree, "-p", parent, "-m", "attempt"]),
        treeSha: tree,
      };
    };
    const refusedCandidate = {
      attemptId: "refused-candidate",
      ...commitOn(loaded.baseSha, { "api.json": '{"refused":true}\n' }),
    };
    const continued = await prepare(
      "## Package manager update\n_No response_\n",
      undefined,
      refusedCandidate,
    );
    assert.equal(git(continued.worktree, "rev-parse", "HEAD"), loaded.baseSha);
    assert.equal(
      git(continued.worktree, "write-tree"),
      refusedCandidate.treeSha,
    );
    assert.notEqual(
      git(continued.worktree, "rev-parse", "HEAD^{tree}"),
      refusedCandidate.treeSha,
    );
    assert.match(
      continued.preparedHarnessRequest.item.brief,
      /Its files are already in your working tree/,
    );
    // Returning the starting tree unchanged resubmits the refused result: it
    // is collected as no change, before any validation or review.
    await assert.rejects(
      collectWorktreeResult(
        checkout,
        continued.worktree,
        continued.request,
        store,
        { evidence: { finalResponse: "Nothing left to change." } },
      ),
      /Worker produced no repository change/,
    );
    // Rereview archives the current attempt while its execution, and the
    // retained result it continued from, stay: the state still saves.
    {
      const { state: rereviewed, file } = lastPrepared;
      rereviewed.work.api.recovery = archiveAttempt(rereviewed.work.api);
      saveState(file, rereviewed);
      assert.equal(
        parseFactoryState(
          JSON.parse(readFileSync(file, "utf8")),
          rereviewed.repository,
          1,
        ).work.api.execution.data.request.retainedFailedResult.commitSha,
        refusedCandidate.commitSha,
      );
    }
    // A no-change stop between the refusal and this attempt left no
    // candidate: the attempt still continues from the refused result.
    const afterNoChange = await prepare(
      "## Package manager update\n_No response_\n",
      undefined,
      refusedCandidate,
      loaded.baseSha,
      true,
    );
    assert.equal(
      git(afterNoChange.worktree, "write-tree"),
      refusedCandidate.treeSha,
    );
    // A peer merged after the refusal: the candidate moves onto the new base
    // and keeps the peer's change instead of reverting it.
    const peerBase = commitOn(loaded.baseSha, { "peer.json": "peer\n" });
    const moved = await prepare(
      "## Package manager update\n_No response_\n",
      undefined,
      refusedCandidate,
      peerBase.commitSha,
    );
    assert.equal(git(moved.worktree, "rev-parse", "HEAD"), peerBase.commitSha);
    assert.equal(
      readFileSync(join(moved.worktree, "api.json"), "utf8"),
      '{"refused":true}\n',
    );
    assert.equal(
      readFileSync(join(moved.worktree, "peer.json"), "utf8"),
      "peer\n",
    );
    assert.match(
      moved.preparedHarnessRequest.item.brief,
      /Its files are already in your working tree/,
    );
    // A peer change that conflicts falls back to the accepted base with
    // inspect-only context, and the brief says why.
    const conflictBase = commitOn(loaded.baseSha, {
      "api.json": '{"peer":true}\n',
    });
    const fallback = await prepare(
      "## Package manager update\n_No response_\n",
      undefined,
      refusedCandidate,
      conflictBase.commitSha,
    );
    assert.equal(
      git(fallback.worktree, "write-tree"),
      git(fallback.worktree, "rev-parse", "HEAD^{tree}"),
    );
    assert.match(
      fallback.preparedHarnessRequest.item.brief,
      /Its files are not in this checkout/,
    );
    const save = () => saveState(snapshot, loaded);
    const session = agentSessionContinuation(
      loaded,
      "implementation",
      "api",
      save,
    );
    const receipt = {
      scope: session.scope,
      adapter: "local-integration-controller",
      identity: session.identity,
      turn: 1,
      status: "in-flight",
    };
    session.checkpoint(receipt);
    const inFlight = parseFactoryState(
      JSON.parse(readFileSync(snapshot, "utf8")),
      loaded.repository,
      1,
    );
    assert.deepEqual(
      agentSessionContinuation(inFlight, "implementation", "api", () => {})
        .retained,
      receipt,
    );
    const blockedWorkRoot = join(root, "blocked-worker");
    const blockedDriver = new LocalExecutionDriver(
      checkout,
      blockedWorkRoot,
      new CodexHarness(join(root, "blocked-credentials"), "off", {
        model: "unused",
        reasoningEffort: "low",
      }),
      1,
      store,
      "codex",
    );
    await assert.rejects(
      blockedDriver.start(
        {
          item: loaded.graph.items.find((item) => item.id === "api"),
          baseSha: loaded.baseSha,
          attemptId: "blocked-fresh",
          session: {
            scope: session.scope,
            identity: session.identity,
            retained: receipt,
          },
        },
        {
          cancelled: () => false,
          checkpoint: () => assert.fail("No worker may be admitted"),
          checkpointSession: (ref) => session.checkpoint(ref),
        },
      ),
      /Unsettled worker conversation/,
    );
    assert.equal(existsSync(blockedWorkRoot), false);
    const otherGraph = structuredClone(inFlight);
    otherGraph.graph.items[0].brief += "\nRefined implementation boundary.";
    assert.throws(
      () => agentSessionContinuation(otherGraph, "implementation", "api", save),
      /unsettled agent ownership/,
    );
    const historicalUnknown = structuredClone(inFlight);
    historicalUnknown.agentSessionHistory = [structuredClone(receipt)];
    delete historicalUnknown.agentSessions;
    assert.throws(
      () =>
        agentSessionContinuation(
          historicalUnknown,
          "implementation",
          "api",
          save,
        ),
      /unsettled agent ownership/,
    );
    session.checkpoint({ ...receipt, status: "ready" });
    const ready = parseFactoryState(
      JSON.parse(readFileSync(snapshot, "utf8")),
      loaded.repository,
      1,
    );
    assert.equal(
      agentSessionContinuation(ready, "implementation", "api", () => {})
        .identity,
      session.identity,
    );
    const beforeFresh = readFileSync(snapshot, "utf8");
    assert.equal(
      checkpointWorkerSession(
        {
          scope: session.scope,
          identity: session.identity,
          retained: session.retained,
        },
        {
          adapter: receipt.adapter,
          supportsResume: false,
          executionIdentity: "fresh-api",
        },
        (ref) => session.checkpoint(ref),
      ),
      undefined,
    );
    assert.equal(readFileSync(snapshot, "utf8"), beforeFresh);
    assert.deepEqual(session.retained, { ...receipt, status: "ready" });
    assert.throws(
      () =>
        session.checkpoint({
          ...receipt,
          scope: { ...receipt.scope, itemId: "ui" },
        }),
      /scope/,
    );
    const alteredSession = JSON.parse(readFileSync(snapshot, "utf8"));
    Object.values(alteredSession.agentSessions)[0].scope.runId = "foreign-run";
    assert.throws(
      () => parseFactoryState(alteredSession, loaded.repository, 1),
      /Agent session/,
    );
    session.checkpoint({ ...receipt, status: "unavailable" });
    const freshIdentity = session.identity;
    const unavailableSnapshot = readFileSync(snapshot, "utf8");
    session.checkpoint({ ...receipt, status: "unavailable" });
    assert.equal(session.identity, freshIdentity);
    assert.equal(readFileSync(snapshot, "utf8"), unavailableSnapshot);
    session.checkpoint({ ...receipt, status: "released" });
    assert.equal(session.identity, freshIdentity);
    const released = parseFactoryState(
      JSON.parse(readFileSync(snapshot, "utf8")),
      loaded.repository,
      1,
    );
    assert.equal(
      Object.values(released.agentSessions)[0].identity,
      receipt.identity,
    );
    assert.equal(Object.values(released.agentSessions)[0].status, "released");
    // The real Git collection above is already settled. Terminal cleanup must
    // reuse its released session instead of requesting a new unavailable turn.
    const cancelledCollectionState = structuredClone(released);
    cancelledCollectionState.cancelRequested = true;
    cancelledCollectionState.cancelledAt = new Date().toISOString();
    const terminalSession = agentSessionContinuation(
      cancelledCollectionState,
      "implementation",
      "api",
      () => saveState(snapshot, cancelledCollectionState),
    );
    const ended = {
      identity: request.attemptId,
      data: {
        request: {
          ...request,
          session: {
            scope: terminalSession.scope,
            identity: receipt.identity,
            retained: { ...receipt, status: "released" },
          },
        },
        result,
      },
    };
    const terminalContext = executionContext(
      cancelledCollectionState.work.api,
      () => saveState(snapshot, cancelledCollectionState),
      () => cancelledCollectionState.cancelRequested,
    );
    terminalContext.checkpointSession = (ref) =>
      terminalSession.checkpoint(ref);
    cancelledCollectionState.work.api.execution = ended;
    if (cancelledCollectionState.coordinator)
      cancelledCollectionState.coordinator.processes = [];
    const terminalOriginal = JSON.stringify(cancelledCollectionState);
    await cancelKnownWork(
      cancelledCollectionState,
      blockedDriver,
      () => saveState(snapshot, cancelledCollectionState),
      true,
    );
    await cancelKnownWork(
      cancelledCollectionState,
      blockedDriver,
      () => saveState(snapshot, cancelledCollectionState),
      true,
    );
    assert.deepEqual(
      await blockedDriver.collect(ended, terminalContext),
      result,
    );
    assert.equal(JSON.stringify(cancelledCollectionState), terminalOriginal);
    const replacement = agentSessionContinuation(
      loaded,
      "implementation",
      "api",
      save,
    );
    assert.notEqual(replacement.identity, session.identity);
    assert.equal(replacement.retained, undefined);
    loaded.cancelRequested = true;
    assert.throws(
      () =>
        replacement.checkpoint({ ...receipt, identity: replacement.identity }),
      /Cancelling/,
    );
    delete loaded.cancelRequested;
    replacement.checkpoint({
      ...receipt,
      identity: replacement.identity,
      status: "ready",
    });
    const replacedSession = parseFactoryState(
      JSON.parse(readFileSync(snapshot, "utf8")),
      loaded.repository,
      1,
    );
    assert.equal(replacedSession.agentSessionHistory.length, 1);
    assert.equal(
      replacedSession.agentSessionHistory[0].identity,
      receipt.identity,
    );
    assert.equal(replacedSession.agentSessionHistory[0].status, "released");

    const settling = agentSessionContinuation(
      loaded,
      "implementation",
      "ui",
      save,
    );
    const settlingReceipt = {
      scope: settling.scope,
      adapter: "local-integration-controller",
      identity: settling.identity,
      executionIdentity: "ui-attempt",
      turn: 1,
      status: "in-flight",
    };
    settling.checkpoint(settlingReceipt);
    loaded.cancelRequested = true;
    save();
    const cancellingSnapshot = readFileSync(snapshot, "utf8");
    for (const forbidden of [
      settlingReceipt,
      { ...settlingReceipt, status: "ready", turn: 2 },
      { ...settlingReceipt, status: "ready", identity: replacement.identity },
      { ...settlingReceipt, status: "ready", adapter: "foreign-adapter" },
      {
        ...settlingReceipt,
        status: "ready",
        executionIdentity: "foreign-attempt",
      },
    ])
      assert.throws(() => settling.checkpoint(forbidden), /Cancelling/);
    const unadmitted = agentSessionContinuation(
      loaded,
      "implementation",
      "docs",
      save,
    );
    assert.throws(
      () =>
        unadmitted.checkpoint({
          ...settlingReceipt,
          scope: unadmitted.scope,
          identity: unadmitted.identity,
        }),
      /Cancelling/,
    );
    assert.equal(readFileSync(snapshot, "utf8"), cancellingSnapshot);
    settling.checkpoint({ ...settlingReceipt, status: "ready" });
    const settledReady = parseFactoryState(
      JSON.parse(readFileSync(snapshot, "utf8")),
      loaded.repository,
      1,
    );
    assert.equal(
      Object.values(settledReady.agentSessions).find(
        (ref) => ref.identity === settlingReceipt.identity,
      ).status,
      "ready",
    );
    assert.equal(settledReady.cancelRequested, true);
    settling.checkpoint({ ...settlingReceipt, status: "unavailable" });
    const unavailableIdentity = settling.identity;
    settling.checkpoint({ ...settlingReceipt, status: "unavailable" });
    assert.equal(settling.identity, unavailableIdentity);
    const settledUnavailable = parseFactoryState(
      JSON.parse(readFileSync(snapshot, "utf8")),
      loaded.repository,
      1,
    );
    assert.equal(
      Object.values(settledUnavailable.agentSessions).find(
        (ref) => ref.identity === settlingReceipt.identity,
      ).status,
      "unavailable",
    );
    loaded.cancelledAt = new Date().toISOString();
    assert.throws(
      () => settling.checkpoint({ ...settlingReceipt, status: "released" }),
      /Terminal/,
    );
    delete loaded.cancelledAt;
    delete loaded.cancelRequested;
    const concurrentOwner = agentSessionContinuation(
      loaded,
      "implementation",
      "docs",
      save,
    );
    const concurrentReceipt = {
      scope: concurrentOwner.scope,
      adapter: "local-integration-controller",
      identity: concurrentOwner.identity,
      executionIdentity: "docs-attempt",
      turn: 1,
      status: "in-flight",
    };
    concurrentOwner.checkpoint(concurrentReceipt);
    const cancellationCallback = agentSessionContinuation(
      loaded,
      "implementation",
      "docs",
      save,
    );
    const executionCallback = agentSessionContinuation(
      loaded,
      "implementation",
      "docs",
      save,
    );
    loaded.cancelRequested = true;
    save();
    const stoppedReceipt = { ...concurrentReceipt, status: "unavailable" };
    cancellationCallback.checkpoint(stoppedReceipt);
    const stoppedSnapshot = readFileSync(snapshot, "utf8");
    executionCallback.checkpoint(stoppedReceipt);
    assert.equal(readFileSync(snapshot, "utf8"), stoppedSnapshot);
    assert.equal(executionCallback.retained, undefined);
    assert.notEqual(executionCallback.identity, concurrentReceipt.identity);
    assert.throws(
      () =>
        executionCallback.checkpoint({
          ...stoppedReceipt,
          data: { controllerObservation: "different settlement declaration" },
        }),
      /logical identity/,
    );
    assert.equal(readFileSync(snapshot, "utf8"), stoppedSnapshot);
    const concurrentSettlement = parseFactoryState(
      JSON.parse(stoppedSnapshot),
      loaded.repository,
      1,
    );
    assert.deepEqual(
      Object.values(concurrentSettlement.agentSessions).find(
        (ref) => ref.identity === concurrentReceipt.identity,
      ),
      stoppedReceipt,
    );
    delete loaded.cancelRequested;
    // The same real Git-backed evidence and atomic store authenticate a planner
    // before a graph exists and after execution activates. These are controller
    // receipt checks, not provider completion or acceptance claims.
    assertAgentSessionCapabilities({
      resumeRoles: ["planning", "implementation"],
    });
    assert.throws(
      () =>
        assertAgentSessionCapabilities({
          resumeRoles: ["planning", "planning"],
        }),
      /capabilities/,
    );
    assert.throws(
      () => assertAgentSessionCapabilities({ resumeRoles: ["graph-review"] }),
      /capabilities/,
    );
    const pinnedBody = git(checkout, "show", `${loaded.baseSha}:README.md`);
    const preparation = {
      schemaVersion: 8,
      kind: "preparing",
      repository: loaded.repository,
      approvedPlaybookPin: null,
      objective: loaded.objective,
      runId: loaded.runId,
      configDigest: loaded.configDigest,
      baseSha: loaded.baseSha,
      objectiveBodyDigest: createHash("sha256")
        .update(pinnedBody)
        .digest("hex"),
      sourcePacketDigest: createHash("sha256")
        .update(JSON.stringify([{ path: "README.md", content: pinnedBody }]))
        .digest("hex"),
      autonomy: loaded.autonomy,
      capacity: loaded.capacity,
      issueByItemId: {},
      coordinator: {
        mode: "running",
        phase: "planning",
        phaseStartedAt: new Date().toISOString(),
      },
    };
    const preparationPath = statePath(
      preparation.repository,
      preparation.objective,
    );
    const savePreparation = () => saveState(preparationPath, preparation);
    savePreparation();
    assert.throws(
      () =>
        agentSessionContinuation(
          preparation,
          "implementation",
          "api",
          savePreparation,
        ),
      /Preparation/,
    );
    assert.throws(
      () =>
        planningSessionInputDigest({
          ...preparation,
          sourcePacketDigest: undefined,
        }),
      /unavailable/,
    );
    const planner = agentSessionContinuation(
      preparation,
      "planning",
      undefined,
      savePreparation,
    );
    const intent = {
      scope: planner.scope,
      adapter: "local-integration-controller",
      identity: planner.identity,
      turn: 1,
      status: "in-flight",
      currentTurn: {
        invocationId: randomUUID(),
        requestDigest: createHash("sha256").update(pinnedBody).digest("hex"),
        dispatch: "intent",
        resources: "unknown",
      },
    };
    planner.checkpoint(intent);
    const unknownTurnSnapshot = readContinuation(
      preparation.repository,
      preparation.objective,
    );
    const unknownTurnDocument = continuationStatusDocument(
      unknownTurnSnapshot,
      preparation.repository,
      preparation.objective,
      "regular",
      [pinnedBody],
      undefined,
      false,
    );
    const guidance = unknownTurnDocument.prerequisiteGuidance;
    const unknownTurn = guidance.entries.find(
      (entry) =>
        entry.kind === "unknown-effect" && entry.scope.startsWith("session:"),
    );
    assert.equal(unknownTurn.owner, "controller");
    assert.equal(
      unknownTurn.nextAction.command,
      `factory status --objective ${preparation.objective}`,
    );
    assert.equal(unknownTurnDocument.phase, "waiting");
    assert.equal(guidance.control.owner, "absent");
    assert.equal(guidance.binding.runId, preparation.runId);
    assert.equal(guidance.binding.configDigest, preparation.configDigest);
    assert.ok(
      Object.isFrozen(guidance) &&
        Object.isFrozen(guidance.entries) &&
        Object.isFrozen(unknownTurn),
    );
    assert.equal(
      JSON.stringify(unknownTurnDocument).includes(pinnedBody),
      false,
    );
    assert.equal(
      continuationStatusDocument(
        unknownTurnSnapshot,
        preparation.repository,
        preparation.objective,
        "regular",
        [pinnedBody],
        undefined,
        false,
      ).prerequisiteGuidance.digest,
      guidance.digest,
    );
    await assert.rejects(
      () =>
        releaseAgentSessions(
          preparation,
          undefined,
          undefined,
          savePreparation,
        ),
      /settled native resources/,
    );
    assert.deepEqual(
      Object.values(
        readContinuation(preparation.repository, preparation.objective)
          .agentSessions,
      )[0],
      intent,
    );
    assert.throws(
      () => planner.checkpoint({ ...intent, turn: 2 }),
      /Unsettled/,
    );
    assert.throws(
      () => planner.checkpoint({ ...intent, status: "ready" }),
      /settled terminal/,
    );
    assert.throws(
      () => planner.checkpoint({ ...intent, status: "unavailable" }),
      /resource settlement/,
    );
    const submitted = {
      ...intent,
      currentTurn: {
        ...intent.currentTurn,
        dispatch: "submitted",
        resources: "active",
      },
    };
    planner.checkpoint(submitted);
    assert.throws(() => planner.checkpoint(intent), /regressed/);
    const terminal = {
      ...submitted,
      status: "ready",
      currentTurn: {
        ...submitted.currentTurn,
        terminal: "completed",
        resources: "settled",
      },
    };
    planner.checkpoint(terminal);
    assert.throws(
      () =>
        planner.checkpoint({
          ...terminal,
          currentTurn: { ...terminal.currentTurn, terminal: "failed" },
        }),
      /regressed/,
    );
    assert.throws(
      () => planner.checkpoint({ ...terminal, status: "in-flight" }),
      /active again/,
    );
    const resumedPreparation = readContinuation(
      preparation.repository,
      preparation.objective,
    );
    assert.equal(
      continuationStatusDocument(
        resumedPreparation,
        preparation.repository,
        preparation.objective,
        "regular",
        [pinnedBody],
        undefined,
        false,
      ).prerequisiteGuidance.entries.some(
        (entry) =>
          entry.kind === "unknown-effect" && entry.scope.startsWith("session:"),
      ),
      false,
    );
    const activated = {
      ...structuredClone(loaded),
      objectiveBodyDigest: preparation.objectiveBodyDigest,
      sourcePacketDigest: preparation.sourcePacketDigest,
      agentSessions: resumedPreparation.agentSessions,
      agentSessionHistory: resumedPreparation.agentSessionHistory,
      coordinator: {
        ...resumedPreparation.coordinator,
        phase: "active",
      },
      work: Object.fromEntries(
        loaded.graph.items.map((item) => [item.id, { status: "pending" }]),
      ),
    };
    const activationPath = join(root, "activated-planner.json");
    const owner = {
      snapshot: resumedPreparation,
      pause: new AbortController(),
      workPause: new AbortController(),
    };
    const saveActivation = () =>
      checkpointExecutionState(owner, activationPath, activated);
    saveActivation();
    assert.equal(owner.snapshot, activated);
    assert.equal(owner.snapshot.schemaVersion, 7);
    assert.equal(canHandoff(owner.snapshot), true);
    const lockPath = objectiveLockPath(
      activated.repository,
      activated.objective,
    );
    const lock = acquireControllerLock(lockPath, activated.objective);
    let server;
    try {
      server = await serveControl(
        activated.repository,
        lock,
        async (request) => {
          assert.equal(request.action, "pause");
          setCoordinatorMode(owner.snapshot, "paused");
          owner.pause.abort(new Error("Coordinator pause"));
          checkpointExecutionState(owner, activationPath, owner.snapshot);
          return owner.snapshot.coordinator;
        },
        activated.objective,
      );
      // Local readiness bypasses the ordinary handler and reveals no lock token.
      const readiness = await requestControl(
        activated.repository,
        { objective: activated.objective, action: "readiness" },
        { deadlineAt: Date.now() + 1_000 },
      );
      assert.equal(readiness.handled, true);
      assert.deepEqual(readiness.result, {
        protocol: "controller-readiness-v1",
        owner: {
          pid: process.pid,
          startTime: readControllerOwner(lockPath).startTime,
          objective: activated.objective,
          intake: false,
        },
      });
      let paused;
      const preflight = await subprocessAsync(
        "sh",
        ["-c", "echo preflight; sleep 0.05; echo settled; exit 23"],
        {},
        undefined,
        (stream) => {
          if (stream === "stdout" && !paused)
            paused = requestControl(activated.repository, {
              objective: activated.objective,
              action: "pause",
            });
        },
      );
      assert.equal(preflight.status, 23);
      assert.ok(preflight.stdout.includes("settled"));
      assert.equal((await paused).handled, true);
      // Even failed preflight retains the active pending graph. A post-await
      // checkpoint cannot restore the stale Preparation coordinator's running mode.
      saveActivation();
      assert.equal(owner.snapshot, activated);
      assert.equal(activated.coordinator.mode, "paused");
      assert.equal(resumedPreparation.coordinator.mode, "running");
      assert.equal(owner.workPause.signal.aborted, true);
      assert.ok(
        Object.values(activated.work).every(
          (work) => work.status === "pending",
        ),
      );
      assert.equal(canHandoff(activated), true);
    } finally {
      if (server)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      releaseControllerLock(lockPath, lock);
    }

    // A genuinely suspended owner cannot answer; the read-only socket deadline
    // ends that probe without a remote observation or lifecycle mutation.
    const controllerModule = new URL(
      "../dist/coordinator-control.js",
      import.meta.url,
    ).href;
    const ownerModule = new URL("../dist/state-store.js", import.meta.url).href;
    const controller = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        String.raw`
      import {serveControl} from ${JSON.stringify(controllerModule)};
      import {acquireControllerLock,objectiveLockPath,releaseControllerLock} from ${JSON.stringify(ownerModule)};
      const repository=process.env.FACTORY_CONTROL_TEST_REPOSITORY;
      const objective=Number(process.env.FACTORY_CONTROL_TEST_OBJECTIVE);
      const path=objectiveLockPath(repository,objective);
      const lock=acquireControllerLock(path,objective);
      const server=await serveControl(repository,lock,async()=>{throw new Error("Unexpected ordinary control handler")},objective);
      process.on("SIGTERM",async()=>{await new Promise(resolve=>server.close(resolve));setTimeout(()=>{releaseControllerLock(path,lock);process.exit(0)},300)});
      process.stdout.write("ready\n");
    `,
      ],
      {
        env: {
          ...process.env,
          FACTORY_CONTROL_TEST_REPOSITORY: activated.repository,
          FACTORY_CONTROL_TEST_OBJECTIVE: String(activated.objective),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let childError = "";
    controller.stderr.on("data", (part) => {
      childError += part;
    });
    const controllerExit = new Promise((resolve) =>
      controller.once("exit", resolve),
    );
    try {
      await new Promise((resolve, reject) => {
        controller.stdout.once("data", resolve);
        controller.once("error", reject);
        controller.once("exit", () =>
          reject(new Error(childError || "Controller exited before readiness")),
        );
      });
      controller.kill("SIGSTOP");
      const started = Date.now();
      await assert.rejects(
        requestControl(
          activated.repository,
          { objective: activated.objective, action: "readiness" },
          { deadlineAt: started + 50 },
        ),
        (error) =>
          error instanceof ControllerReadinessPendingError &&
          error.reason === "deadline",
      );
      assert.ok(Date.now() - started < 1_000);
      controller.kill("SIGCONT");
      const resumed = await requestControl(
        activated.repository,
        { objective: activated.objective, action: "readiness" },
        { deadlineAt: Date.now() + 1_000 },
      );
      assert.equal(resumed.handled, true);
      assert.equal(resumed.result.owner.pid, controller.pid);
      assert.equal(resumed.result.protocol, "controller-readiness-v1");
      // An exiting owner removes its endpoint before its record (#1486): a
      // command waits for it to finish, then takes the owned path.
      controller.kill("SIGTERM");
      while (existsSync(join(lockPath, "..", "control.sock")))
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(
        await requestControl(activated.repository, {
          objective: activated.objective,
          action: "status",
        }),
        { handled: false },
      );
    } finally {
      controller.kill("SIGCONT");
      controller.kill("SIGTERM");
      await controllerExit;
    }
    const reloadedActivation = parseFactoryState(
      JSON.parse(readFileSync(activationPath, "utf8")),
      activated.repository,
      activated.objective,
    );
    assert.equal(reloadedActivation.coordinator.mode, "paused");
    assert.ok(
      Object.values(reloadedActivation.work).every(
        (work) => work.status === "pending",
      ),
    );
    assert.equal(
      planningSessionInputDigest(preparation),
      planningSessionInputDigest(reloadedActivation),
    );
    const diagnostics = new DiagnosticEmitter(
      activated.repository,
      activated.objective,
    );
    const firstObservation = readDiagnostics(
      activated.repository,
      activated.objective,
    ).length;
    const observe = (task) =>
      observeObjectiveController(
        diagnostics,
        activated.configDigest,
        task,
        (result) => ({ runId: result.runId, outcome: "not-accepted" }),
      );
    const handoff = new CoordinatorHandoff();
    const pausedBytes = readFileSync(activationPath, "utf8");
    // The real pause and owned preflight above have settled. Exercise the
    // production controller observation boundary at that supported safe point.
    await assert.rejects(
      observe(async () => {
        const settled = await subprocessAsync(
          "sh",
          ["-c", "echo handed-off"],
          {},
        );
        assert.equal(settled.status, 0);
        assert.equal(canHandoff(reloadedActivation), true);
        throw handoff;
      }),
      (error) => error === handoff,
    );
    const observations = () =>
      readDiagnostics(activated.repository, activated.objective).slice(
        firstObservation,
      );
    const handoffRecords = observations();
    const expectedObservations = {
      repository: activated.repository,
      objective: activated.objective,
      configDigest: activated.configDigest,
      observerSourceDigest: handoffRecords[0].metadata.observerSourceDigest,
      sessionIds: [handoffRecords[0].observerSessionId],
    };
    const handoffTerminal = handoffRecords.find(
      (event) => event.formalAttempt?.terminal,
    );
    assert.equal(handoffTerminal.outcome, "waiting");
    assert.equal(handoffTerminal.formalAttempt.status, "paused");
    assert.equal(handoffTerminal.formalAttempt.faultClass, undefined);
    assert.equal(handoffTerminal.metadata.controllerDisposition, "handed-off");
    const handoffSummary = summarizeFormalHistory(
      handoffRecords,
      expectedObservations,
    );
    assert.equal(handoffSummary.completeness, "complete");
    assert.equal(handoffSummary.hasFailedAttempt, false);
    assert.deepEqual(handoffSummary.lifecycleOutcomes, ["handed-off"]);
    assert.equal(readFileSync(activationPath, "utf8"), pausedBytes);
    assert.equal(reloadedActivation.cancelledAt, undefined);
    assert.equal(reloadedActivation.finalAcceptance, undefined);
    await observe(async () => {
      const settled = await subprocessAsync("sh", ["-c", "echo restarted"], {});
      assert.equal(settled.status, 0);
      return reloadedActivation;
    });
    expectedObservations.sessionIds = observations()
      .filter(
        (event) =>
          event.operation === "observer-session" && event.outcome === "started",
      )
      .map((event) => event.observerSessionId);
    const restartSummary = summarizeFormalHistory(
      observations(),
      expectedObservations,
    );
    assert.equal(restartSummary.completeness, "complete");
    assert.equal(restartSummary.hasFailedAttempt, false);
    assert.deepEqual(restartSummary.lifecycleOutcomes, [
      "handed-off",
      "not-accepted",
    ]);
    // A real nonzero process with the same text is still an ordinary failure;
    // subsequent observer closure cannot rewrite either historical outcome.
    await assert.rejects(
      observe(async () => {
        const failed = await subprocessAsync(
          "sh",
          ["-c", "echo failure; exit 23"],
          {},
        );
        assert.equal(failed.status, 23);
        throw new Error(handoff.message);
      }),
      (error) =>
        error.constructor === Error && error.message === handoff.message,
    );
    expectedObservations.sessionIds = observations()
      .filter(
        (event) =>
          event.operation === "observer-session" && event.outcome === "started",
      )
      .map((event) => event.observerSessionId);
    const failureSummary = summarizeFormalHistory(
      observations(),
      expectedObservations,
    );
    assert.equal(failureSummary.completeness, "complete");
    assert.equal(failureSummary.hasFailedAttempt, true);
    assert.deepEqual(failureSummary.lifecycleOutcomes, [
      "handed-off",
      "not-accepted",
      "failed",
    ]);
    const failureTerminal = observations().find(
      (event) => event.formalAttempt?.status === "failed",
    );
    assert.equal(failureTerminal.outcome, "failed");
    assert.equal(failureTerminal.formalAttempt.faultClass, "defect");
    setCoordinatorMode(activated, "running");
    owner.pause = new AbortController();
    saveActivation();
    const continuedPlanner = agentSessionContinuation(
      activated,
      "planning",
      undefined,
      saveActivation,
    );
    assert.equal(continuedPlanner.identity, planner.identity);
    assert.deepEqual(continuedPlanner.retained, terminal);
    const nextIntent = {
      ...terminal,
      turn: 2,
      status: "in-flight",
      currentTurn: {
        ...intent.currentTurn,
        invocationId: randomUUID(),
        graphDigest: graphDigest(activated.graph),
      },
    };
    assert.throws(
      () =>
        continuedPlanner.checkpoint({
          ...nextIntent,
          currentTurn: {
            ...nextIntent.currentTurn,
            graphDigest: "f".repeat(64),
          },
        }),
      /admitted graph/,
    );
    // Older same-turn receipts cannot silently acquire an elapsed admission.
    assert.throws(
      () =>
        continuedPlanner.checkpoint({
          ...terminal,
          currentTurn: {
            ...terminal.currentTurn,
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      /binding/,
    );
    nextIntent.currentTurn.deadlineAt = new Date(
      Date.now() + 60_000,
    ).toISOString();
    continuedPlanner.checkpoint(nextIntent);
    const deadlineReload = parseFactoryState(
      JSON.parse(readFileSync(activationPath, "utf8")),
      activated.repository,
      activated.objective,
    );
    assert.equal(
      Object.values(deadlineReload.agentSessions).find(
        (ref) => ref.identity === continuedPlanner.identity,
      ).currentTurn.deadlineAt,
      nextIntent.currentTurn.deadlineAt,
    );
    assert.throws(
      () =>
        continuedPlanner.checkpoint({
          ...nextIntent,
          currentTurn: {
            ...nextIntent.currentTurn,
            deadlineAt: new Date(Date.now() + 120_000).toISOString(),
          },
        }),
      /binding/,
    );
    const malformedDeadline = structuredClone(deadlineReload);
    Object.values(malformedDeadline.agentSessions).find(
      (ref) => ref.identity === continuedPlanner.identity,
    ).currentTurn.deadlineAt = "invalid";
    assert.throws(
      () =>
        parseFactoryState(
          malformedDeadline,
          activated.repository,
          activated.objective,
        ),
      /elapsed deadline/,
    );
    const competingPlanner = agentSessionContinuation(
      activated,
      "planning",
      undefined,
      saveActivation,
    );
    assert.throws(
      () => competingPlanner.checkpoint({ ...nextIntent, turn: 3 }),
      /Unsettled/,
    );
    assert.throws(
      () =>
        continuedPlanner.checkpoint({
          ...nextIntent,
          currentTurn: {
            ...nextIntent.currentTurn,
            requestDigest: "f".repeat(64),
          },
        }),
      /binding/,
    );
    assert.throws(
      () =>
        continuedPlanner.checkpoint({
          ...nextIntent,
          adapter: "foreign-adapter",
        }),
      /adapter or owner/,
    );
    const changedSource = {
      ...reloadedActivation,
      sourcePacketDigest: "f".repeat(64),
    };
    assert.throws(
      () => saveState(join(root, "changed-planner-inputs.json"), changedSource),
      /Agent session/,
    );
    // A retained old planner request binds historical graph bytes; changing a
    // graph cannot silently mutate that request or rotate planner identity.
    const historical = structuredClone(reloadedActivation);
    historical.graph.items[0].brief += " changed graph";
    assertAgentSessions(historical);
    assert.equal(
      agentSessionContinuation(historical, "planning", undefined, () => {})
        .identity,
      planner.identity,
    );
    const oldGraphDisposal = agentSessionContinuation(
      historical,
      "planning",
      undefined,
      () => {},
    );
    oldGraphDisposal.checkpoint({ ...terminal, status: "released" });
    const nextSubmitted = {
      ...nextIntent,
      data: { nativeThread: "retained-opaque-thread" },
      currentTurn: {
        ...nextIntent.currentTurn,
        dispatch: "submitted",
        resources: "active",
      },
    };
    continuedPlanner.checkpoint(nextSubmitted);
    activated.cancelRequested = true;
    assert.throws(
      () => continuedPlanner.checkpoint(nextSubmitted),
      /Cancelling/,
    );
    assert.throws(
      () =>
        continuedPlanner.checkpoint({
          ...nextSubmitted,
          currentTurn: { ...nextSubmitted.currentTurn, resources: "unknown" },
        }),
      /Cancelling/,
    );
    const unknownSettled = {
      ...nextSubmitted,
      currentTurn: { ...nextSubmitted.currentTurn, resources: "settled" },
    };
    continuedPlanner.checkpoint(unknownSettled);
    const unknownSnapshot = readFileSync(activationPath, "utf8");
    competingPlanner.checkpoint(unknownSettled);
    assert.equal(readFileSync(activationPath, "utf8"), unknownSnapshot);
    const persistedUnknown = Object.values(
      parseFactoryState(
        JSON.parse(unknownSnapshot),
        activated.repository,
        activated.objective,
      ).agentSessions,
    )[0];
    assert.deepEqual(persistedUnknown, unknownSettled);
    assert.equal(persistedUnknown.status, "in-flight");
    assert.equal(persistedUnknown.currentTurn.terminal, undefined);
    assert.throws(
      () => continuedPlanner.checkpoint({ ...unknownSettled, turn: 3 }),
      /Cancelling/,
    );
    assert.throws(
      () =>
        continuedPlanner.checkpoint({
          ...unknownSettled,
          currentTurn: {
            ...unknownSettled.currentTurn,
            requestDigest: "f".repeat(64),
          },
        }),
      /binding/,
    );
    const settled = {
      ...unknownSettled,
      status: "released",
    };
    continuedPlanner.checkpoint(settled);
    const settledSnapshot = readFileSync(activationPath, "utf8");
    competingPlanner.checkpoint(settled);
    assert.equal(readFileSync(activationPath, "utf8"), settledSnapshot);
    activated.cancelledAt = new Date().toISOString();
    assert.throws(
      () => continuedPlanner.checkpoint({ ...settled, status: "released" }),
      /Terminal/,
    );
    const reviewTree = materializeResultTree(checkout, result.treeSha);
    try {
      const reviewHomes = join(root, "private-review-homes");
      const selection = { model: "gpt-6.1", reasoningEffort: "medium" };
      const transport = new CodexPlanningTransport(
        checkout,
        selection,
        selection,
        undefined,
        [],
        reviewHomes,
      );
      const abortReason = new Error(
        "Review stopped before native process startup",
      );
      const stoppedSignal = AbortSignal.abort(abortReason);
      const expiredDeadline = new Date(Date.now() - 1).toISOString();
      const checkpoints = [];
      const reviewSession = agentSessionContinuation(
        loaded,
        "result-review",
        "api",
        () => {
          save();
          const snapshotState = parseFactoryState(
            JSON.parse(readFileSync(snapshot, "utf8")),
            loaded.repository,
            1,
          );
          const retained = Object.values(snapshotState.agentSessions).find(
            (ref) => ref.identity === reviewIdentity,
          );
          checkpoints.push({
            status: retained.status,
            homeExists: existsSync(retained.data.sessionRoot),
            threadIdPresent: Object.hasOwn(retained.data, "threadId"),
          });
        },
      );
      const reviewIdentity = reviewSession.identity;
      const reviewTurn = { response: "", ended: false };
      // The real transport constructs an already-expired elapsed guard; its
      // synchronous abort wins before native submission and is durably retained.
      await assert.rejects(
        () =>
          transport.run({
            role: "reviewer",
            prompt: "Inspect the exact candidate",
            schema: { type: "object" },
            invocation: {
              invocationId: randomUUID(),
              phase: "result-review",
              ordinal: 0,
            },
            turn: reviewTurn,
            tree: reviewTree.directory,
            session: reviewSession,
            signal: stoppedSignal,
            deadlineAt: expiredDeadline,
          }),
        (error) => {
          assert.equal(error.name, "ProviderTurnElapsedTimeoutError");
          assert.equal(error.deadlineAt, expiredDeadline);
          return true;
        },
      );
      assert.deepEqual(checkpoints, [
        { status: "in-flight", homeExists: true, threadIdPresent: false },
        { status: "unavailable", homeExists: true, threadIdPresent: false },
        { status: "released", homeExists: false, threadIdPresent: false },
      ]);
      assert.equal(reviewTurn.started, undefined);
      assert.equal(reviewTurn.stopped, true);
      assert.equal(reviewTurn.usage, undefined);
      const reviewReload = parseFactoryState(
        JSON.parse(readFileSync(snapshot, "utf8")),
        loaded.repository,
        1,
      );
      const disposedReview = Object.values(reviewReload.agentSessions).find(
        (ref) => ref.identity === reviewIdentity,
      );
      assert.equal(disposedReview.status, "released");
      assert.equal(disposedReview.currentTurn.deadlineAt, expiredDeadline);
      assert.equal(disposedReview.currentTurn.dispatch, "intent");
      assert.equal(disposedReview.currentTurn.terminal, undefined);
      assert.equal(existsSync(disposedReview.data.sessionRoot), false);
      await transport.releaseSession(disposedReview);

      // An actual pre-admission receipt supplies the binding shape; no native
      // READY/terminal response is fabricated. Recreate only an owned old-policy
      // home to prove refusal before reconfiguration and original-owner disposal.
      const legacyConfig = CODEX_TREE_REVIEW_CONFIG.replace(
        /^instructions =.*\n/m,
        "",
      );
      const legacyReview = structuredClone(disposedReview);
      legacyReview.data.selectionDigest = createHash("sha256")
        .update(
          JSON.stringify([
            selection,
            transport.adapter,
            "reviewer",
            "read-only",
            "never",
            legacyConfig,
          ]),
        )
        .digest("hex");
      const legacyOwner = createHash("sha256")
        .update(
          JSON.stringify([
            legacyReview.scope,
            legacyReview.identity,
            legacyReview.adapter,
            legacyReview.data.selectionDigest,
          ]),
        )
        .digest("hex");
      const legacyHome = createCodexHome({
        root: legacyReview.data.sessionRoot,
        owner: legacyOwner,
        config: legacyConfig,
        sandbox: {
          directory: reviewTree.directory,
          workspace: "read",
          network: false,
        },
      });
      const legacyConfigPath = join(legacyHome.env.CODEX_HOME, "config.toml");
      const legacyBytes = readFileSync(legacyConfigPath);
      await assert.rejects(
        () => transport.reconcileSession(legacyReview),
        /policy changed.*unknown turn.*supported session disposal/,
      );
      await assert.rejects(
        () =>
          transport.run({
            role: "reviewer",
            prompt: "Inspect the exact candidate",
            schema: { type: "object" },
            invocation: {
              invocationId: randomUUID(),
              phase: "result-review",
              ordinal: 0,
            },
            turn: { response: "", ended: false },
            tree: reviewTree.directory,
            session: {
              ...reviewSession,
              retained: legacyReview,
              checkpoint: () => assert.fail("Old-policy admission checkpoint"),
            },
          }),
        /policy changed.*Do not resume or replay/,
      );
      assert.deepEqual(readFileSync(legacyConfigPath), legacyBytes);
      await assert.rejects(
        () =>
          transport.releaseSession({
            ...legacyReview,
            currentTurn: {
              ...legacyReview.currentTurn,
              resources: "unknown",
            },
          }),
        /unproved process settlement/,
      );
      assert.equal(existsSync(legacyHome.root), true);
      await assert.rejects(
        () =>
          transport.releaseSession({
            ...legacyReview,
            data: {
              ...legacyReview.data,
              selectionDigest: "0".repeat(64),
            },
          }),
        /owner/,
      );
      assert.equal(existsSync(legacyHome.root), true);
      await transport.releaseSession(legacyReview);
      assert.equal(existsSync(legacyHome.root), false);
      await transport.releaseSession(legacyReview);

      // The real shared planning entry refuses an already expired Objective
      // ceiling without spawning a native process or recording unknown usage as zero.
      const elapsedEvents = [];
      const elapsedProcesses = [];
      const elapsedSnapshot = readFileSync(snapshot, "utf8");
      await assert.rejects(
        () =>
          withProcessCancellation(
            undefined,
            () =>
              new StructuredPlanningModel(transport).generateStructured({
                purpose: "diagnosis",
                objective:
                  "Inspect the retained failure within its original deadline.",
                baseSha: result.baseSha,
                sources: [],
                schema: { type: "object" },
                session: {
                  ...reviewSession,
                  retained: undefined,
                  objectiveDeadlineAt: new Date(Date.now() - 1).toISOString(),
                },
                invocation: {
                  invocationId: randomUUID(),
                  phase: "diagnosis",
                  ordinal: 0,
                  observe: (event) => elapsedEvents.push(event),
                },
              }),
            (owned) => elapsedProcesses.push(owned),
          ),
        (error) => {
          assert.equal(attachedFault(error)?.kind, "decision");
          assert.equal(
            error.cause.timeout.name,
            "ProviderTurnElapsedTimeoutError",
          );
          assert.equal(error.cause.stopped, true);
          return true;
        },
      );
      assert.deepEqual(elapsedProcesses, []);
      assert.equal(
        elapsedEvents.find((event) => event.type === "failed").usageAvailable,
        false,
      );
      assert.equal(
        elapsedEvents.some((event) => event.type === "retry-scheduled"),
        false,
      );
      assert.equal(readFileSync(snapshot, "utf8"), elapsedSnapshot);

      // Exercise the real adapter with a controller timeout already settled
      // before dispatch: no native child/provider is started, and the planner
      // must surface the uncertainty without its former three-call replay.
      const timeoutSnapshot = readFileSync(snapshot, "utf8");
      const timeoutGuard = new ProviderTurnGuard(1, 1);
      await assert.rejects(
        timeoutGuard.race(new Promise(() => {})),
        ProviderTurnTimeoutError,
      );
      timeoutGuard.finish();
      const timeoutEvents = [];
      const ownedProcesses = [];
      // This standalone timeout probe has no owned continuation; retained
      // planning now requires its real controller checkpoint header.
      const timeoutTransport = new CodexPlanningTransport(
        checkout,
        selection,
        selection,
      );
      const timeoutInvocation = {
        invocationId: randomUUID(),
        phase: "diagnosis",
        ordinal: 0,
        observe: (event) => timeoutEvents.push(event),
      };
      await assert.rejects(
        () =>
          withProcessCancellation(
            timeoutGuard.signal,
            () =>
              new StructuredPlanningModel(timeoutTransport).generateStructured({
                purpose: "diagnosis",
                objective:
                  "Diagnose the retained failure without weakening acceptance.",
                baseSha: result.baseSha,
                sources: [],
                schema: { type: "object" },
                invocation: timeoutInvocation,
              }),
            (owned) => ownedProcesses.push(owned),
          ),
        (error) => {
          assert.equal(attachedFault(error)?.kind, "decision");
          assert.equal(error.cause.stopped, true);
          assert.equal(error.cause.timeout.waitingFor, "model-response");
          return true;
        },
      );
      assert.equal(timeoutInvocation.providerAttempt, 1);
      assert.equal(timeoutInvocation.providerMaxAttempts, 1);
      assert.equal(
        timeoutEvents.filter((event) => event.type === "started").length,
        1,
      );
      assert.equal(
        timeoutEvents.filter((event) => event.type === "retry-scheduled")
          .length,
        0,
      );
      assert.equal(
        timeoutEvents.find((event) => event.type === "failed").usageAvailable,
        false,
      );
      assert.deepEqual(ownedProcesses, []);
      assert.equal(readFileSync(snapshot, "utf8"), timeoutSnapshot);

      const rejectedSession = agentSessionContinuation(
        loaded,
        "result-review",
        "ui",
        save,
      );
      const rejectedHome = join(reviewHomes, rejectedSession.identity);
      loaded.cancelRequested = true;
      save();
      const rejectedSnapshot = readFileSync(snapshot, "utf8");
      const rejectedTurn = { response: "", ended: false };
      await assert.rejects(
        () =>
          transport.run({
            role: "reviewer",
            prompt: "Inspect the exact candidate",
            schema: { type: "object" },
            invocation: {
              invocationId: randomUUID(),
              phase: "result-review",
              ordinal: 0,
            },
            turn: rejectedTurn,
            tree: reviewTree.directory,
            session: rejectedSession,
            signal: stoppedSignal,
          }),
        /Cancelling/,
      );
      assert.equal(existsSync(rejectedHome), false);
      assert.equal(readFileSync(snapshot, "utf8"), rejectedSnapshot);
      assert.equal(rejectedTurn.started, undefined);
      assert.equal(rejectedTurn.usage, undefined);
      delete loaded.cancelRequested;
    } finally {
      reviewTree.remove();
    }
    const prompt = workItemPrompt({
      item: workerAttemptItem(loaded, consumer, result.changeRef, current),
      worktree: checkout,
    });
    assert.match(prompt, /Timestamp uses UTC/);
    assert.match(prompt, /Controller-bound Objective knowledge view/);
    assert.match(prompt, /advisory-agent-claim/);
    assert.ok(
      prompt.includes(JSON.stringify(join(checkout, ".factory-handoff.json"))),
    );
    assert.match(
      prompt,
      /allowed private staging exception even when absent from Owned paths/,
    );
    writeFileSync(join(checkout, "schema.json"), '{"timestamp":"local"}\n');
    git(checkout, "add", "schema.json");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "update schema",
    );
    const advanced = git(checkout, "rev-parse", "HEAD");
    loaded.work.schema.changeRef = advanced;
    loaded.work.schema.treeSha = git(checkout, "rev-parse", "HEAD^{tree}");
    saveState(snapshot, loaded); // The immutable note retains its original observed tree after replay.
    assert.equal(
      objectiveKnowledgeView(loaded, consumer, checkout, advanced).entries[0]
        .sources[0].availability,
      "changed-or-unbound-bytes",
    );
    const tampered = JSON.parse(readFileSync(snapshot, "utf8"));
    tampered.work.schema.knowledge.notes[0].summary =
      "An unauthenticated replacement";
    assert.throws(
      () => parseFactoryState(tampered, state.repository, 1),
      /Objective knowledge/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnosis dispatch intent follows complete admission before real process effects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-diagnosis-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, "failure-test.mjs");
  writeFileSync(
    sourcePath,
    "assert.equal(currentKeyboardOwner, requestedOwner);\n",
  );
  const beforeEffect = join(root, "dispatch-intent.json");
  const afterEffect = join(root, "actual-process.json");
  const transport = {
    provider: "local-process-check",
    adapter: "owned-local-process-check",
    selection: () => ({ model: "unused", reasoningEffort: "low" }),
    settings: () => ({ sandboxMode: "read-only", approvalPolicy: "never" }),
    run: async ({ turn }) => {
      assert.equal(
        JSON.parse(readFileSync(beforeEffect, "utf8")).submitted,
        true,
      );
      const result = await subprocessAsync(
        process.execPath,
        [
          "-e",
          "process.stderr.write('Owned process failure');process.exit(23)",
        ],
        {},
      );
      assert.equal(result.status, 23);
      writeFileSync(afterEffect, JSON.stringify({ status: result.status }), {
        mode: 0o600,
      });
      turn.nativeInvocationStarted = true;
      throw new Error(result.stderr);
    },
  };
  const model = new StructuredPlanningModel(transport);
  assert.equal(model.providerDispatchAdmission, "after-attempt-admission-v1");
  const request = {
    purpose: "diagnosis",
    objective: "Inspect this exact complete failure source.",
    baseSha: "a".repeat(40),
    sources: [
      { path: "failure-test.mjs", content: readFileSync(sourcePath, "utf8") },
    ],
    schema: { type: "object" },
    invocation: {
      invocationId: randomUUID(),
      phase: "diagnosis",
      ordinal: 0,
      beforeProviderDispatch: () =>
        writeFileSync(beforeEffect, JSON.stringify({ submitted: true }), {
          mode: 0o600,
        }),
    },
  };
  const originalAdmission = async () => {
    assert.equal(existsSync(sourcePath), true);
  };
  // Exercise the demonstrated outer guard AFTER its original admission, with
  // actual rendered model inputs and no native/provider response fixture.
  request.invocation.beforeProviderAttempt = async () => {
    await originalAdmission();
    throw new Error("Complete failure file omitted before diagnosis");
  };
  await assert.rejects(
    model.generateStructured(request),
    /Complete failure file omitted/,
  );
  assert.equal(existsSync(beforeEffect), false);
  assert.equal(existsSync(afterEffect), false);
  request.invocation.invocationId = randomUUID();
  request.invocation.beforeProviderAttempt = originalAdmission;
  const admitDispatch = request.invocation.beforeProviderDispatch;
  request.invocation.beforeProviderDispatch = async () => {
    await admitDispatch();
    throw new Error("Submitted intent checkpoint admission refused");
  };
  await assert.rejects(
    model.generateStructured(request),
    /Submitted intent checkpoint admission refused/,
  );
  assert.equal(JSON.parse(readFileSync(beforeEffect, "utf8")).submitted, true);
  assert.equal(existsSync(afterEffect), false);
  request.invocation.invocationId = randomUUID();
  request.invocation.beforeProviderDispatch = admitDispatch;
  await assert.rejects(
    model.generateStructured(request),
    /Owned process failure/,
  );
  assert.equal(JSON.parse(readFileSync(beforeEffect, "utf8")).submitted, true);
  assert.equal(JSON.parse(readFileSync(afterEffect, "utf8")).status, 23);
  for (const phase of ["compile", "graph-review", "diagnosis"]) {
    rmSync(afterEffect);
    const id = randomUUID();
    const record = {
      phase: "ready",
      history: [],
      invocation: { id, phase },
      invocations: [{ id, phase }],
    };
    const mark = () =>
      checkpointPlanningDispatch({
        record,
        id,
        phase,
        save: () =>
          writeFileSync(
            beforeEffect,
            JSON.stringify({ submitted: record.phase === "submitted", phase }),
            { mode: 0o600 },
          ),
      });
    request.invocation = {
      invocationId: id,
      phase,
      ordinal: 0,
      beforeProviderAttempt: async () => {
        throw new Error("Complete outer admission refused");
      },
      beforeProviderDispatch: mark,
    };
    await assert.rejects(
      model.generateStructured(request),
      /Complete outer admission refused/,
    );
    assert.equal(record.phase, "ready");
    assert.equal(existsSync(afterEffect), false);
    request.invocation.beforeProviderAttempt = originalAdmission;
    request.invocation.beforeProviderDispatch = async () => {
      await mark();
      throw new Error("Current submitted intent checkpoint refused");
    };
    await assert.rejects(
      model.generateStructured(request),
      /submitted intent checkpoint refused/,
    );
    assert.equal(record.phase, "submitted");
    assert.equal(existsSync(afterEffect), false);
    request.invocation.beforeProviderDispatch = mark;
    await assert.rejects(
      model.generateStructured(request),
      /Owned process failure/,
    );
    assert.equal(record.phase, "submitted");
    assert.equal(JSON.parse(readFileSync(afterEffect)).status, 23);
  }
  const ownedModel = new CodexPlanningModel(
    root,
    { model: "unused", reasoningEffort: "low" },
    { model: "unused", reasoningEffort: "low" },
    undefined,
    { sessionRoot: join(root, "native-sessions") },
  );
  assert.equal(
    ownedModel.retainedPlannerCheckpointCoverage.contract,
    "retained-planner-native-checkpoint-v1",
  );
  const unknownNativeTurn = { response: "", ended: false };
  await assert.rejects(
    ownedModel.transport.run({
      role: "planner",
      prompt: "No native dispatch",
      schema: { type: "object" },
      invocation: { invocationId: randomUUID(), phase: "compile", ordinal: 0 },
      turn: unknownNativeTurn,
    }),
    /controller-owned checkpoint header/,
  );
  assert.equal(unknownNativeTurn.nativeInvocationStarted, undefined);
  assert.equal(existsSync(join(root, "native-sessions")), false);

  // Exercise both composed admissions through the real compiler, continuation
  // and private Git publisher. Cancellation inside the final ACK deterministically
  // prevents an actual Codex process, without supplying any model response.
  const checkout = join(root, "planning-target");
  mkdirSync(checkout);
  git(checkout, "init", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "# Public planning fixture\n");
  git(checkout, "add", ".");
  git(
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "baseline",
  );
  const baseSha = git(checkout, "rev-parse", "HEAD");
  const repository = `fixture/planning-admission-${randomUUID()}`;
  git(
    checkout,
    "remote",
    "add",
    "origin",
    `https://github.com/${repository}.git`,
  );
  const remote = join(root, "planning-archive.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const selection = { model: "unused-local-check", reasoningEffort: "low" };
  const config = {
    schemaVersion: 1,
    repository,
    checkout,
    planning: { kind: "codex-sdk", planner: selection, reviewer: selection },
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
  validateConfig(config);
  t.after(() =>
    rmSync(stateRoot(repository), { recursive: true, force: true }),
  );
  const body =
    "## Outcome\nUpdate the fixture README.\n\n## Acceptance\n- The README records the change.\n\n## Sources\n- README.md\n";
  const preparation = {
    schemaVersion: 18,
    kind: "preparing",
    approvedPlaybookPin: null,
    repository,
    objective: 1,
    runId: randomUUID(),
    configDigest: factoryConfigDigest(config),
    baseSha,
    objectiveBodyDigest: createHash("sha256").update(body).digest("hex"),
    sourcePacketDigest: createHash("sha256")
      .update(JSON.stringify(planningSources(body, baseSha, checkout)))
      .digest("hex"),
    issueByItemId: {},
    autonomy: resolveAutonomy({ allowances: { planningRevisions: 0 } }),
    capacity: { concurrency: 1 },
    coordinator: {
      mode: "running",
      phase: "planning",
      phaseStartedAt: new Date().toISOString(),
      processes: [],
    },
  };
  const save = () => saveState(statePath(repository, 1), preparation);
  save();
  const nativeModel = new CodexPlanningModel(
    checkout,
    selection,
    selection,
    undefined,
    {
      sessionRoot: join(stateRoot(repository), "planning-sessions"),
      sourceArtifacts: false,
    },
  );
  // Scoped as each Objective's model is: no approved advice selected.
  nativeModel.approvedPlaybookPin = null;
  const stop = new AbortController();
  const beforeNativeBuilds = [];
  const buildClosure = async () => {
    const session = Object.values(preparation.agentSessions ?? {})[0];
    if (!session || session.currentTurn?.resources === "active") {
      beforeNativeBuilds.push(structuredClone(preparation));
      if (session) {
        assert.equal(existsSync(session.data.sessionRoot), true);
        stop.abort(
          new Error("Cancelled during complete pre-native acknowledgment"),
        );
      }
    }
    return buildRecoveryCheckpointClosure({ config });
  };
  await withRecoveryCheckpointControllerVerification(
    { config, buildClosure },
    async () => {
      await assert.rejects(
        step(
          preparation,
          { scope: "objective", name: "plan", paid: true },
          (context) =>
            compilePlan(
              1,
              body,
              baseSha,
              checkout,
              paidPlanningModel(nativeModel, context),
              preparation.configDigest,
              undefined,
              undefined,
              {
                state: preparation,
                sessionState: preparation,
                save,
                stopped: () => stop.signal.aborted,
              },
            ),
          { save, signal: stop.signal },
        ),
      );
    },
  );
  assert.equal(
    beforeNativeBuilds.length,
    1,
    "one acknowledgment contains both complete logical and native admissions",
  );
  const [native] = beforeNativeBuilds;
  assert.equal(native.planningRecovery.phase, "submitted");
  const session = Object.values(native.agentSessions)[0];
  assert.equal(session.status, "in-flight");
  assert.equal(session.currentTurn.dispatch, "submitted");
  assert.equal(session.currentTurn.resources, "active");
  assert.equal(
    session.currentTurn.invocationId,
    native.planningRecovery.invocation.id,
  );
  assert.equal(session.currentTurn.requestDigest.length, 64);
  assert.equal(session.currentTurn.schemaDigest.length, 64);
  assert.equal(session.currentTurn.evidenceDigest.length, 64);
  assert.equal(session.scope.configDigest, preparation.configDigest);
  assert.equal(session.scope.repository, repository);
  assert.equal(session.scope.role, "planning");
  assert.equal(session.data.transport, "exec");
  assert.equal(session.data.selectionDigest.length, 64);
  assert.equal(native.repeats[repeatKey("objective", "plan")].inFlight, true);
  assert.equal(preparation.planningRecovery.invocations.length, 1);
  assert.equal(preparation.planningRecovery.phase, "submitted");
  const ack = gitPersistenceStatus(config).lastAcknowledged;
  assert.ok(ack);
  const archive = await readVerifiedRecoveryCheckpoint(config, ack.commitSha);
  assert.equal(archive.payloadDigest, ack.payloadDigest);
  assert.equal(archive.manifest.gaps.length, 0);
  const acknowledgedStates = [];
  const commits = execFileSync(
    "git",
    [
      "--git-dir",
      remote,
      "rev-list",
      "--first-parent",
      config.gitPersistence.ref,
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  for (const commit of commits) {
    const retained = await readVerifiedRecoveryCheckpoint(config, commit);
    const file = retained.manifest.files.find(
      (entry) => entry.path === "objectives/1/state.json",
    );
    acknowledgedStates.push(
      JSON.parse(
        Buffer.from(await retained.readVerifiedBlob(file.ref)).toString("utf8"),
      ),
    );
  }
  assert.equal(
    acknowledgedStates.filter(
      (entry) => Object.keys(entry.agentSessions ?? {}).length === 0,
    ).length,
    0,
  );
  const activeAdmissions = acknowledgedStates.filter((entry) =>
    Object.values(entry.agentSessions ?? {}).some(
      (ref) => ref.currentTurn?.resources === "active",
    ),
  );
  assert.equal(
    activeAdmissions.length,
    1,
    "the final ACK contains the complete submitted native admission, without an earlier intent-only publication",
  );
  const archivedNative = Object.values(activeAdmissions[0].agentSessions)[0];
  assert.deepEqual(archivedNative.currentTurn, session.currentTurn);
  assert.equal(activeAdmissions[0].planningRecovery.phase, "submitted");
  assert.equal(
    activeAdmissions[0].repeats[repeatKey("objective", "plan")].inFlight,
    true,
  );
  assert.equal(
    Object.values(preparation.agentSessions)[0].currentTurn.resources,
    "settled",
  );
  assert.equal(
    Object.values(preparation.agentSessions)[0].currentTurn.terminal,
    undefined,
  );
});

test("proposal provider fences keep dispatched submissions unknown", async () => {
  // A journal as retained after a dispatched provider call that failed with
  // only a start and a failure: it stays unknown and blocks later proposals.
  const retain = (repository) => {
    const proposalId = randomUUID();
    const invocationId = randomUUID();
    const content = "# One\nBuild it.\n";
    const binding = {
      repository,
      configDigest: "a".repeat(64),
      baseSha: "b".repeat(40),
      source: "docs/wave.md#One",
      additionalSources: [],
      sources: [
        {
          path: "docs/wave.md",
          heading: "One",
          digest: createHash("sha256").update(content).digest("hex"),
          purpose: "primary-wave",
        },
      ],
    };
    const input = new LocalContentStore(
      join(stateRoot(repository), "content"),
    ).putBytes(
      Buffer.from(
        JSON.stringify({
          invocationId,
          prompt: "Draft Objectives.",
          schema: proposalSchema(1),
          sourcePacket: JSON.stringify([
            {
              path: "docs/wave.md",
              heading: "One",
              content,
              purpose: "primary-wave",
            },
          ]),
        }),
      ),
      { mediaType: "application/json" },
    );
    const observation = (type, extra = {}) => ({
      type,
      invocationId,
      phase: "propose",
      ordinal: 0,
      providerAttempt: 1,
      providerMaxAttempts: 1,
      ...extra,
    });
    const directory = join(stateRoot(repository), "proposals");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${proposalId}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        binding,
        observations: [
          observation("started"),
          observation("failed", { usageAvailable: false }),
        ],
        issues: {},
        generation: {
          invocationId,
          input,
          attempts: [
            {
              providerAttempt: 1,
              providerMaxAttempts: 1,
              at: new Date().toISOString(),
              dispatchAdmitted: true,
              outcome: "submitted-outcome-unobserved",
            },
          ],
        },
        pending: { kind: "provider", id: invocationId },
      }),
      { mode: 0o600 },
    );
    return () =>
      proposalPersistenceReferences(
        readFileSync(path),
        repository,
        proposalId,
        (ref) =>
          new LocalContentStore(
            join(stateRoot(repository), "content"),
          ).readBytes(ref),
      ).journal;
  };
  const dispatched = "example/proposal-dispatched";
  const dispatchedJournal = retain(dispatched);
  assert.throws(
    () => refuseUnknownProviderSubmissions(dispatched),
    /remains unknown/,
  );
  assert.equal(dispatchedJournal().pending.kind, "provider");
});
