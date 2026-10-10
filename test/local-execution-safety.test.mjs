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
import { collectWorktreeResult } from "../dist/execution/local.js";
import { LocalContentStore } from "../dist/content/local.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  objectiveKnowledgeView,
  publishObjectiveKnowledge,
  reviewObjectiveKnowledge,
} from "../dist/objective-knowledge.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
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
  CLAUDE_EXPORT_SCRIPT,
  materializeClaudeSnapshot,
  parseClaudeResultSnapshot,
} from "../dist/execution/claude-managed-transfer.js";

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
  }).trim();
}

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
