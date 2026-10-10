import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { saveState } from "../dist/state-store.js";
import { workerAttemptItem } from "../dist/item-worker.js";
import { workItemPrompt } from "../dist/execution/harness-support.js";
import { agentSessionContinuation } from "../dist/agent-session.js";
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
      "result-review",
      "ui",
      save,
    );
    const settlingReceipt = {
      scope: settling.scope,
      adapter: "local-integration-controller",
      identity: settling.identity,
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
    const prompt = workItemPrompt({
      item: workerAttemptItem(loaded, consumer, result.changeRef, current),
      worktree: checkout,
    });
    assert.match(prompt, /Timestamp uses UTC/);
    assert.match(prompt, /Controller-bound Objective knowledge view/);
    assert.match(prompt, /advisory-agent-claim/);
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
