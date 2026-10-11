import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
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
import {
  discoverRepository,
  authenticateDiscoveryOutput,
  readDiscoveryBody,
} from "../dist/discovery.js";
import {
  applyPendingAmendment,
  graphDigest,
} from "../dist/graph-amendments.js";
import {
  completeObjectiveKnowledge,
  objectiveKnowledgeView,
  publishObjectiveKnowledge,
  reviewObjectiveKnowledge,
} from "../dist/objective-knowledge.js";
import {
  buildAdaptiveContext,
  authenticateAdaptiveContextPacket,
} from "../dist/adaptive-context.js";
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
import { resolveAutonomy } from "../dist/repair-policy.js";
import { materializeGraphExpansion } from "../dist/graph-expansion.js";
import { authenticateExpansionInputs } from "../dist/runner/expansion.js";
import { graphProjectionControl } from "../dist/graph-projection-control.js";
import { parseFactoryState } from "../dist/state.js";
import {
  acquireControllerLock,
  objectiveLockPath,
  readContinuation,
  releaseControllerLock,
  saveState,
  statePath,
} from "../dist/state-store.js";
import { requestControl, serveControl } from "../dist/coordinator-control.js";
import { checkpointExecutionState } from "../dist/runner/execution.js";
import { canHandoff } from "../dist/runner/ownership.js";
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
import { StructuredPlanningModel } from "../dist/compiler/model.js";
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
  CODEX_PLANNING_CONFIG,
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
    const request = { item: producer, baseSha, attemptId: "schema-attempt" };
    const store = new LocalContentStore(join(root, "private-content"));
    writeFileSync(join(checkout, "schema.json"), '{"timestamp":"UTC"}\n');
    const manifest = {
      notes: [
        {
          kind: "interface",
          summary: "Timestamp uses UTC",
          paths: ["schema.json"],
          consumers: ["api", "ui"],
        },
        {
          kind: "hypothesis",
          summary: "Investigate optional errors before integration",
          paths: ["missing.json"],
          consumers: ["api"],
        },
      ],
    };
    writeFileSync(join(checkout, ".gitignore"), ".factory-handoff.json\n");
    git(checkout, "add", ".gitignore");
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
    writeFileSync(
      join(checkout, ".factory-handoff.json"),
      JSON.stringify({
        notes: [
          {
            kind: "pitfall",
            summary: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            paths: ["schema.json"],
            consumers: [],
          },
        ],
      }),
    );
    await assert.rejects(
      () => collectWorktreeResult(checkout, checkout, request, store, {}),
      /Secretlint found suspected secret/,
    );
    assert.equal(git(checkout, "rev-parse", "HEAD"), request.baseSha);
    writeFileSync(
      join(checkout, ".factory-handoff.json"),
      JSON.stringify(manifest),
    );
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
    assert.equal(existsSync(join(checkout, ".factory-handoff.json")), false);
    assert.equal(
      git(checkout, "ls-tree", "HEAD", "--", ".factory-handoff.json"),
      "",
    );
    assert.equal(result.handoff.sources.length, 1);
    await store.verify(result.handoff.sources[0].ref);
    state.work.schema.changeRef = result.changeRef;
    state.work.schema.treeSha = result.treeSha;
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
              consumers: ["api"],
            },
          ],
        }),
      );
      const peerResult = await collectWorktreeResult(
        checkout,
        peerCheckout,
        {
          item: peer,
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
        assert.equal(
          episode.snapshotDigest,
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
          restartedStore.readBytes(original.ref).toString("utf8"),
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
      // Historical stopped local ownership is preserved; no provider is launched.
      const stoppedWorktree = join(
        stateRoot(adaptive.repository),
        "worktrees",
        "api-role-attempt",
      );
      mkdirSync(join(stateRoot(adaptive.repository), "worktrees"), {
        recursive: true,
      });
      git(
        checkout,
        "worktree",
        "add",
        "--detach",
        stoppedWorktree,
        result.changeRef,
      );
      const owned = structuredClone(roleReload);
      owned.work.api.execution = {
        provider: "local",
        identity: owned.work.api.attempt,
        data: {
          worktree: stoppedWorktree,
          stopped: "Historical local start ceased",
        },
      };
      const legacyOwned = structuredClone(owned);
      delete legacyOwned.work.api.adaptiveContextId;
      delete legacyOwned.adaptiveContexts;
      saveState(rolePath, legacyOwned);
      const legacySnapshot = readFileSync(rolePath, "utf8");
      const legacyBefore = structuredClone(legacyOwned);
      await assert.rejects(
        () => resumeDispatch(legacyOwned),
        /lacks its original dispatch packet/,
      );
      assert.deepEqual(legacyOwned, legacyBefore);
      assert.equal(restartSaves, 1);
      assert.equal(readFileSync(rolePath, "utf8"), legacySnapshot);
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
      // Historical ownership remains inspectable; another call cannot use missing bytes.
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
      assert.equal(owned.work.api.execution.identity, "api-role-attempt");
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
        iteration: 1,
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
    assert.equal(
      JSON.parse(
        reviewObjectiveKnowledge(
          loaded,
          undefined,
          checkout,
          result.changeRef,
        )[0].content,
      ).view.entries.length,
      2,
    );
    delete loaded.work.schema.validation;
    delete loaded.work.schema.acceptanceDecisions;
    delete loaded.work.schema.pullRequest;

    // Exercise the stock prepared-request producer and its real strict atomic
    // checkpoint, holding before Codex starts; these are no provider responses.
    const prepare = async (objectiveBody, policy) => {
      const originalHead = git(checkout, "rev-parse", "HEAD");
      const preparedState = structuredClone(loaded);
      preparedState.schemaVersion = 17;
      const attempt = randomUUID();
      preparedState.work.api = {
        status: "running",
        step: "execute",
        attempt,
        baseSha: loaded.baseSha,
        startedAt: new Date().toISOString(),
      };
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
            baseSha: preparedState.baseSha,
            attemptId: attempt,
            objectiveBody,
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
      return work.execution.data.preparedHarnessRequest;
    };
    const absent = await prepare("## Package manager update\n_No response_\n");
    assert.equal(Object.hasOwn(absent, "packageManagerUpdate"), false);
    assert.equal(Object.hasOwn(absent.capture, "policy"), false);
    const policy = { enabled: false, maxBytesPerInvocation: 1024 };
    const declared = await prepare(
      "## Package manager update\n- `npm@10.1.0`\n",
      policy,
    );
    assert.equal(declared.packageManagerUpdate, "npm@10.1.0");
    assert.deepEqual(declared.capture.policy, policy);

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
      const legacyConfig = CODEX_PLANNING_CONFIG.replace(
        "shell_tool = false",
        "shell_tool = true",
      ).replace("code_mode_host = false", "code_mode_host = true");
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
              new StructuredPlanningModel(transport).generateStructured({
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
