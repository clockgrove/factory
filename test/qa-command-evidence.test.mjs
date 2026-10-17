import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { assertKnownFlags } from "../dist/cli-flags.js";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import {
  graphDigest,
  selectWorkerAmendment,
  workerDiscoveryDigest,
} from "../dist/graph-amendments.js";
import {
  assertTerminalEligibility,
  sealFinalAcceptance,
  objectiveComplete,
} from "../dist/completion.js";
import { describeContinuationReferences } from "../dist/recovery-checkpoint-closure.js";
import { runQaItem } from "../dist/qa-execution.js";
import { resolveAutonomy, consumption } from "../dist/repair-policy.js";
import {
  rereviewWorkItem,
  declineWorkerDiscovery,
  controlObjective,
} from "../dist/runner.js";
import {
  readState,
  saveState,
  statePath,
  acquireObjectiveLock,
  releaseControllerLock,
  objectiveLockPath,
  restoredContinuationOwnershipHold,
} from "../dist/state-store.js";
import { finalizeObjective } from "../dist/runner/finalization.js";
import { objectiveReviewEvidence } from "../dist/result-evidence.js";
import { renderResultReviewCall } from "../dist/compiler/model.js";
import {
  parseFactoryState,
  assertContinuationRestoration,
} from "../dist/state.js";
import {
  linuxProcessIdentity,
  subprocessAsync,
  withProcessCancellation,
} from "../dist/process.js";
import { validateTree, validateWorkItem } from "../dist/validation.js";
import { reviewTextArtifactEvidence } from "../dist/review-image-evidence.js";
import {
  assertReviewArtifactSelection,
  assertReviewArtifacts,
  captureReviewArtifacts,
} from "../dist/review-artifacts.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("coding text capture follows producer ownership while final capture remains complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-coding-proof-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Integration");
    git("config", "user.email", "integration@example.invalid");
    writeFileSync(
      join(checkout, "independent.cjs"),
      "// Declares command stdout proof.\n",
    );
    writeFileSync(
      join(checkout, "validate.cjs"),
      "if(require('node:fs').existsSync('producer/report.cjs'))require('./producer/report.cjs');else console.log('Setup checks passed');\n",
    );
    writeFileSync(join(checkout, "setup.txt"), "Enable the later producer.\n");
    git("add", ".");
    git("commit", "-m", "Setup contract");
    const base = git("rev-parse", "HEAD");
    const baseTree = git("rev-parse", "HEAD^{tree}");
    const store = new LocalContentStore(join(root, "objects"));
    const command = (mode = "") =>
      `${process.execPath} validate.cjs${mode ? ` ${mode}` : ""}`;
    const selectors = (check = command()) => [
      {
        command: check,
        text: { source: "independent.cjs", stdout: { maxBytes: 4096 } },
      },
      {
        command: check,
        text: {
          source: "producer/report.cjs",
          locator: {
            stdoutPathPrefix: "Runtime evidence: ",
            files: [
              {
                file: "proof.json",
                mediaType: "application/json",
                maxBytes: 1024,
              },
            ],
          },
        },
      },
    ];
    const coding = (
      name,
      commit,
      tree,
      ownedPaths,
      selected = selectors(),
      check = command(),
    ) =>
      validateWorkItem(
        checkout,
        join(root, name),
        {
          id: name,
          kind: "work",
          ownedPaths,
          validation: [{ command: check, provenance: "source-declared" }],
        },
        commit,
        tree,
        base,
        undefined,
        undefined,
        undefined,
        [],
        store,
        [],
        undefined,
        true,
        selected,
      );
    const final = (name, commit, tree, check = command()) =>
      validateTree(
        checkout,
        join(root, name),
        commit,
        tree,
        [check],
        undefined,
        undefined,
        [],
        store,
        base,
        true,
        { commands: [] },
        selectors(check),
      );

    // The actual first candidate has no future producer or runtime reports.
    const setup = await coding("setup", base, baseTree, ["setup.txt"]);
    assert.equal(setup.commands[0].passed, true);
    assert.equal(setup.reviewArtifacts, undefined);
    // Non-text selectors remain required even without producer ownership.
    await assert.rejects(
      () =>
        coding(
          "image-selection",
          base,
          baseTree,
          ["setup.txt"],
          [
            {
              command: command(),
              receipt: {
                stdoutPathField: "receipt",
                stdoutSha256Field: "sha256",
                maxBytes: 4096,
              },
              image: {
                file: "scene.png",
                sha256Field: "imageSha256",
                maxBytes: 65536,
              },
              candidate: {
                file: "independent.cjs",
                sha256Field: "candidateSha256",
              },
            },
          ],
        ),
      /JSON|Unexpected token/,
    );
    await assert.rejects(
      () => final("early-final", base, baseTree),
      /tracked regular file/,
    );
    await assert.rejects(
      () =>
        coding(
          "invalid-declaration",
          base,
          baseTree,
          ["setup.txt"],
          [
            {
              ...selectors()[1],
              text: { ...selectors()[1].text, source: "../report.cjs" },
            },
          ],
        ),
      /contained and relative/,
    );

    mkdirSync(join(checkout, "producer"));
    writeFileSync(
      join(checkout, "producer/report.cjs"),
      `const fs=require('node:fs'),os=require('node:os'),p=require('node:path');
if(process.argv[2]==='missing')console.log('Command passed without a report');
else {const dir=fs.mkdtempSync(p.join(os.tmpdir(),'proof-'));fs.writeFileSync(p.join(dir,'proof.json'),process.argv[2]==='oversized'?' '.repeat(1025):JSON.stringify({equal:true}));console.log('Runtime evidence: '+dir);}
`,
    );
    git("add", ".");
    git("commit", "-m", "Implement report producer");
    const commit = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    for (const [name, ownership] of [
      ["file-owner", ["producer/report.cjs"]],
      ["directory-owner", ["producer/"]],
    ]) {
      const proof = await coding(name, commit, tree, ownership);
      assert.equal(proof.reviewArtifacts.length, 1);
      const artifact = proof.reviewArtifacts[0];
      assert.equal(artifact.selectorIndex, 1);
      assert.equal(artifact.text.source.path, "producer/report.cjs");
      assert.equal(artifact.treeSha, tree);
      assert.deepEqual(
        JSON.parse(
          (await store.readBytes(artifact.text.bodies[0].ref)).toString(),
        ),
        { equal: true },
      );
      // The original selector index survives serialization and the actual
      // review consumer authenticates the retained bytes and source binding.
      const receipt = join(root, `${name}.validation.json`);
      writeFileSync(receipt, JSON.stringify(proof));
      const restored = JSON.parse(readFileSync(receipt, "utf8"));
      assertReviewArtifacts(restored.reviewArtifacts, tree, restored.commands);
      const evidence = await reviewTextArtifactEvidence(
        checkout,
        restored,
        [],
        store,
      );
      assert.ok(
        evidence.some(
          (entry) => entry.path === "Selected validation text 0/1 binding",
        ),
      );
      assert.ok(
        evidence.some(
          (entry) => entry.content === '{"equal":true}' && entry.complete,
        ),
      );
    }
    const unowned = await coding("literal-prefix", commit, tree, [
      "producer/report.cjsx",
    ]);
    assert.equal(unowned.reviewArtifacts, undefined);
    for (const mode of ["missing", "oversized"]) {
      const check = command(mode);
      await assert.rejects(
        () =>
          coding(mode, commit, tree, ["producer/"], selectors(check), check),
        mode === "missing" ? /one complete absolute path/ : /exceeds.*bound/,
      );
    }
    await assert.rejects(
      () =>
        coding(
          "unauthenticated",
          commit,
          tree,
          ["producer/"],
          [
            {
              ...selectors()[1],
              text: { ...selectors()[1].text, source: "producer/absent.cjs" },
            },
          ],
        ),
      /tracked regular file/,
    );
    const complete = await final("final", commit, tree);
    assert.deepEqual(
      complete.reviewArtifacts.map((x) => x.selectorIndex),
      [0, 1],
    );
    assert.equal(
      complete.reviewArtifacts.every((x) => x.complete && x.treeSha === tree),
      true,
    );
    const finalEvidence = await reviewTextArtifactEvidence(
      checkout,
      complete,
      [],
      store,
    );
    const finalBinding = JSON.parse(
      finalEvidence.find(
        (entry) => entry.path === "Selected validation text 0/1 binding",
      ).content,
    );
    assert.deepEqual(
      finalBinding.text.locator,
      complete.reviewArtifacts[1].text.locator,
    );
    assert.equal(finalBinding.origin, undefined);
    await assert.rejects(
      () => final("missing-final", commit, tree, command("missing")),
      /one complete absolute path/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exact operator decline preserves a real result and permits ordinary completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-discovery-decline-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Integration");
    git("config", "user.email", "integration@example.invalid");
    writeFileSync(join(checkout, "README.md"), "# Result contract\n");
    git("add", ".");
    git("commit", "-m", "Contract");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "implementation");
    writeFileSync(
      join(checkout, "proof.cjs"),
      "require('node:assert/strict').equal(1+1,2);console.log('Current command proof');\n",
    );
    git("add", ".");
    git("commit", "-m", "Factory: Implement command proof");
    const commit = git("rev-parse", "HEAD"),
      tree = git("rev-parse", "HEAD^{tree}");
    git("checkout", "main");
    git("merge", "--no-ff", "implementation", "-m", "Integrate command proof");
    const integrated = git("rev-parse", "HEAD");
    const command = `${process.execPath} proof.cjs`;
    const item = {
      id: "implementation",
      kind: "work",
      title: "Implement command proof",
      goal: "Complete current proof",
      brief: "Implement the exact owned producer",
      acceptance: ["`" + command + "`"],
      nonGoals: [],
      dependencies: [],
      ownedPaths: ["proof.cjs"],
      resources: [],
      expectedOutputRoles: [],
      requiredLfsRoles: [],
      sourceAssets: [],
      minimumAssetSets: 0,
      citations: [{ path: "README.md", heading: "" }],
      inputSources: [
        {
          path: "README.md",
          heading: "",
          sha256: hash("# Result contract\n"),
          bytes: 18,
        },
      ],
      validation: [{ command, provenance: "source-declared" }],
    };
    const graph = {
      objective: 1,
      baseSha: base,
      items: [item],
      coverage: [
        {
          criterionId: hash(item.acceptance[0]),
          source: {
            path: "OBJECTIVE",
            digest: hash(item.acceptance[0]),
            text: item.acceptance[0],
          },
          itemId: item.id,
          proof: { kind: "result-command", validationIndex: 0 },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        },
      ],
    };
    const config = {
      repository: `integration/discovery-${root.split("/").at(-1)}`,
      checkout,
      delivery: { kind: "regular" },
      capture: {
        enabled: false,
        maxBytesPerInvocation: 1024,
        retainInRecovery: false,
      },
    };
    const validation = await validateWorkItem(
      checkout,
      join(root, "validation"),
      item,
      commit,
      tree,
      base,
    );
    const discovery = {
      scope: "in-scope",
      reason: "Request obsolete extra ownership",
      evidence: ["Worker hypothesis"],
      ownership: ["config.json"],
      acceptance: ["Current command passes"],
      dependencies: [],
      attempt: "actual-worker",
    };
    const state = {
      schemaVersion: 7,
      publicationContract: "exact-request-v1",
      repository: config.repository,
      objective: 1,
      runId: "decline-real-result",
      baseSha: base,
      graph,
      planGraphDigest: graphDigest(graph),
      approvedPlaybookPin: null,
      approvedPlaybookAdmission: {
        approvedPlaybookPin: null,
        configDigest: factoryConfigDigest(config),
        graphDigest: graphDigest(graph),
        packetDigest: "c".repeat(64),
        reviewDigest: "d".repeat(64),
        sourcePacketDigest: "e".repeat(64),
      },
      capacity: { concurrency: 1 },
      issueByItemId: { implementation: 2 },
      configDigest: factoryConfigDigest(config),
      integratedSha: integrated,
      work: {
        implementation: {
          status: "done",
          attempt: discovery.attempt,
          baseSha: base,
          executionBaseSha: base,
          changeRef: commit,
          treeSha: tree,
          integratedSha: integrated,
          validation,
          githubClosure: "complete",
          discovery,
          execution: {
            provider: "local",
            identity: "actual-worker",
            data: {
              request: { item, baseSha: base, sourceBaseSha: base },
              worktree: join(
                stateRoot(config.repository),
                "worktrees",
                "actual-worker",
              ),
              adapterIdentity: "@clockgrove/factory/local-test",
              handle: { identity: "actual-worker" },
              result: { changeRef: commit, treeSha: tree },
            },
          },
        },
      },
      autonomy: resolveAutonomy({ allowances: { planningRevisions: 0 } }),
      coordinator: {
        mode: "paused",
        phase: "waiting",
        phaseStartedAt: new Date().toISOString(),
        processes: [],
      },
    };
    // Current worker receipts intentionally have no planner currentTurn.
    // Their original adapter output records EOF and exact owned-worker settlement.
    let probeOwner;
    let probeSettled = false;
    const probe = await withProcessCancellation(
      undefined,
      () => subprocessAsync(process.execPath, ["proof.cjs"], { cwd: checkout }),
      (owned, settled) => {
        probeOwner = owned;
        probeSettled = settled;
      },
    );
    assert.equal(probe.status, 0);
    assert.equal(probeSettled, true);
    const worker = {
      ...probeOwner,
      requestPath: join(root, "request.json"),
      resultPath: join(root, "result.json"),
      logPath: join(root, "worker.log"),
    };
    const session = {
      scope: {
        repository: state.repository,
        objective: 1,
        runId: state.runId,
        configDigest: state.configDigest,
        graphDigest: state.planGraphDigest,
        role: "implementation",
        itemId: item.id,
      },
      adapter: "codex",
      identity: "completed-native-worker",
      turn: 1,
      status: "ready",
      executionIdentity: discovery.attempt,
      data: {
        selectionDigest: hash("public fixture selection"),
        threadId: "public-fixture-thread",
        nativeEof: true,
        workerSettled: true,
        worker,
      },
    };
    const key = JSON.stringify([
      "implementation",
      item.id,
      state.planGraphDigest,
    ]);
    state.agentSessions = { [key]: session };
    state.work.implementation.execution.data.handle.data = worker;
    state.work.implementation.execution.data.result.session =
      structuredClone(session);
    assert.match(
      restoredContinuationOwnershipHold(state),
      /Foreign native session/,
    );
    assert.equal(restoredContinuationOwnershipHold(state, true), undefined);
    // This ownership-only preflight supplies no archive acceptance or restore;
    // even a typed restoration context must retain the portable fence.
    const originalBytes = Buffer.from(JSON.stringify(state));
    const snapshot = {
      digest: hash(originalBytes),
      bytes: originalBytes.length,
      mediaType: "application/json",
    };
    const layout = {
      configDigest: state.configDigest,
      authorityDigest: hash(JSON.stringify(config)),
      checkout,
      stateRoot: stateRoot(config.repository),
    };
    const foreign = {
      ...structuredClone(state),
      schemaVersion: 19,
      restoration: {
        schemaVersion: 1,
        checkpoint: {
          commitSha: integrated,
          payloadDigest: snapshot.digest,
        },
        archive: snapshot,
        original: {
          snapshot,
          configDigest: state.configDigest,
          schemaVersion: 7,
        },
        source: layout,
        installation: { ...layout, identity: "restored-fixture-owner" },
        status: "held",
        reason: "Foreign source ownership remains unresolved",
      },
    };
    assertContinuationRestoration(foreign);
    assert.match(
      restoredContinuationOwnershipHold(foreign, true),
      /Foreign native session/,
    );
    const path = statePath(config.repository, 1);
    saveState(path, state);
    const original = readState(config.repository, 1);
    assert.throws(
      () => selectWorkerAmendment(structuredClone(original)),
      /allowance|planningRevisions/,
    );
    const decision = {
      runId: state.runId,
      item: item.id,
      attempt: discovery.attempt,
      resultCommitSha: commit,
      resultTreeSha: tree,
      graphDigest: graphDigest(graph),
      discoveryDigest: workerDiscoveryDigest(discovery),
      actor: "integration-operator",
      reason: "Exact current command disproves the worker hypothesis",
    };
    assertKnownFlags("decline-discovery", [
      "--objective",
      "1",
      "--decision",
      "decision.json",
    ]);
    assert.throws(
      () =>
        declineWorkerDiscovery(config, 1, {
          ...decision,
          resultTreeSha: "0".repeat(40),
        }),
      /current undisposed/,
    );
    const unchanged = readFileSync(path);
    const active = acquireObjectiveLock(config.repository, 1);
    try {
      assert.throws(
        () => declineWorkerDiscovery(config, 1, decision),
        /owns Objective/,
      );
    } finally {
      releaseControllerLock(objectiveLockPath(config.repository, 1), active);
    }
    const withProcess = structuredClone(original);
    withProcess.coordinator.processes = [
      {
        pid: process.pid,
        startTime: linuxProcessIdentity(process.pid).startTime,
      },
    ];
    saveState(path, withProcess);
    assert.throws(
      () => declineWorkerDiscovery(config, 1, decision),
      /settled owned work/,
    );
    const unknown = structuredClone(original);
    delete unknown.work.implementation.execution.data.result;
    saveState(path, unknown);
    assert.throws(
      () => declineWorkerDiscovery(config, 1, decision),
      /settled owned work/,
    );
    // Exact typed originals remain mandatory; false flags or a different
    // collected receipt cannot turn a ready label into settlement proof.
    const falseSettlement = structuredClone(original);
    falseSettlement.agentSessions[key].data.workerSettled = false;
    falseSettlement.agentSessions[key].data.nativeEof = false;
    falseSettlement.work.implementation.execution.data.result.session =
      structuredClone(falseSettlement.agentSessions[key]);
    saveState(path, falseSettlement);
    assert.throws(
      () => declineWorkerDiscovery(config, 1, decision),
      /settled owned work/,
    );
    const changedHandle = structuredClone(original);
    changedHandle.work.implementation.execution.data.handle.data.resultPath =
      join(root, "different-result.json");
    saveState(path, changedHandle);
    assert.throws(
      () => declineWorkerDiscovery(config, 1, decision),
      /settled owned work/,
    );
    const staleSession = structuredClone(original);
    staleSession.agentSessions[key].identity = "different-native-worker";
    saveState(path, staleSession);
    assert.throws(
      () => declineWorkerDiscovery(config, 1, decision),
      /settled owned work/,
    );
    const uncertain = structuredClone(original);
    uncertain.agentSessions[key].status = "in-flight";
    saveState(path, uncertain);
    assert.throws(
      () => declineWorkerDiscovery(config, 1, decision),
      /settled owned work/,
    );
    const pending = structuredClone(original);
    pending.autonomy.allowances.planningRevisions = 1;
    selectWorkerAmendment(pending);
    saveState(path, pending);
    assert.throws(
      () => declineWorkerDiscovery(config, 1, decision),
      /admitted graph change/,
    );
    saveState(path, original);
    assert.deepEqual(readFileSync(path), unchanged);
    // The stopped controller route uses the same operation under its actual lock.
    await controlObjective(config, {
      objective: 1,
      action: "decline-discovery",
      input: decision,
    });
    const declined = readState(config.repository, 1);
    const actualWork = declined.work.implementation;
    assert.equal(actualWork.discoveryDisposition, "declined");
    assert.deepEqual(actualWork.discovery, discovery);
    assert.deepEqual(
      actualWork.validation,
      original.work.implementation.validation,
    );
    assert.deepEqual(
      actualWork.execution,
      original.work.implementation.execution,
    );
    assert.deepEqual(declined.graph, original.graph);
    assert.deepEqual(consumption(declined), consumption(original));
    const onlyDecision = structuredClone(declined);
    delete onlyDecision.work.implementation.discoveryDisposition;
    delete onlyDecision.work.implementation.discoveryDecline;
    // Optional memory observations do not change the continuation contract.
    delete onlyDecision.memoryBindings;
    const beforeDecision = structuredClone(original);
    delete beforeDecision.memoryBindings;
    assert.deepEqual(onlyDecision, beforeDecision);
    selectWorkerAmendment(declined);
    assert.equal(declined.pendingAmendment, undefined);
    const evidence = objectiveReviewEvidence({
      state: declined,
      checkout,
      candidateCommitSha: integrated,
      candidateTreeSha: tree,
    });
    const discovered =
      evidence.observations +
      evidence.evidence.map((x) => x.content).join("\n");
    assert.ok(discovered.includes('"operatorDecline"'));
    assert.ok(discovered.includes(decision.reason));
    assert.ok(discovered.includes('"acceptedAmendment":null'));
    assert.ok(
      describeContinuationReferences(declined).gitObjects.some(
        (x) => x.sha === commit && x.kind === "commit",
      ),
    );
    const forged = structuredClone(declined);
    forged.work.implementation.discoveryDecline.attempt = "foreign";
    assert.throws(
      () => parseFactoryState(forged, config.repository, 1),
      /decline differs/,
    );
    const missing = structuredClone(declined);
    delete missing.work.implementation.discoveryDecline;
    assert.throws(
      () => parseFactoryState(missing, config.repository, 1),
      /lost its decision/,
    );
    // The decline itself creates no final acceptance; normal current command proof is still required.
    assert.throws(
      () => assertTerminalEligibility(declined),
      /terminal eligibility/,
    );
    const final = await validateTree(
      checkout,
      join(root, "final"),
      integrated,
      tree,
      [command],
    );
    declined.objectiveCommands = [command];
    declined.finalValidation = { ...final, passed: true };
    assertTerminalEligibility(declined);
    sealFinalAcceptance(declined);
    declined.objectiveClosure = "complete";
    saveState(path, declined);
    assert.equal(objectiveComplete(readState(config.repository, 1)), true);
    assert.throws(
      () => declineWorkerDiscovery(config, 1, decision),
      /not available/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("QA rereview retains exact command, installed dependency and runtime proof through final review", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-qa-proof-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Integration");
    git("config", "user.email", "integration@example.invalid");
    writeFileSync(
      join(checkout, "README.md"),
      "# QA contract\nRetain dependency and runtime proof.\n",
    );
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "implementation");
    writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(checkout, "proof.cjs"),
      `const fs=require('node:fs'),os=require('node:os'),p=require('node:path');
if(process.argv[2]==='install') { fs.mkdirSync('node_modules/.store/dependency',{recursive:true}); fs.writeFileSync('node_modules/.store/dependency/package.json',JSON.stringify({version:'1.0.0',exports:'./api.js'})); fs.writeFileSync('node_modules/.store/dependency/api.js','exports.fromState = state => [...state];\\n'); fs.symlinkSync('.store/dependency','node_modules/dependency'); console.log('Dependency inspection ready'); }
else { if(process.env.TMPDIR!==process.env.TMP || process.env.TMP!==process.env.TEMP) throw Error('temp not owned'); const dir=fs.mkdtempSync(p.join(os.tmpdir(),'runtime-')); fs.writeFileSync(p.join(dir,'node.json'),JSON.stringify({state:[1,2],restoration:true})); fs.writeFileSync(p.join(dir,'comparison.json'),JSON.stringify({equal:true})); fs.writeFileSync(p.join(dir,'trace.log'),'unselected'); console.log('Owned temp: '+process.env.TMPDIR); console.log('runner prefix: Runtime evidence: '+dir); }
`,
    );
    git("add", ".");
    git("commit", "-m", "Factory: Runtime proof");
    const result = git("rev-parse", "HEAD");
    git("checkout", "main");
    git("merge", "--no-ff", "implementation", "-m", "Integrate proof");
    const commit = git("rev-parse", "HEAD"),
      treeSha = git("rev-parse", "HEAD^{tree}");
    git("remote", "add", "origin", checkout);
    const commands = [
      `${process.execPath} proof.cjs install`,
      `${process.execPath} proof.cjs`,
    ];
    const body =
      "## Sources\n- README.md\n\n## Acceptance\n- Retain dependency and runtime proof.\n";
    const item = {
      id: "qa",
      kind: "qa",
      title: "Runtime proof",
      goal: "Inspect declared proof",
      brief: "Run exact commands and retain selected evidence",
      acceptance: ["Retain dependency and runtime proof."],
      nonGoals: [],
      dependencies: [],
      ownedPaths: [],
      resources: [],
      expectedOutputRoles: [],
      requiredLfsRoles: [],
      sourceAssets: [],
      minimumAssetSets: 0,
      citations: [],
      inputSources: [],
      validation: commands.map((command) => ({
        command,
        provenance: "source-declared",
      })),
    };
    item.dependencies = ["implementation"];
    const graph = {
      objective: 1,
      baseSha: base,
      brief: "",
      items: [
        {
          ...item,
          id: "implementation",
          kind: "work",
          dependencies: [],
          acceptance: [],
          validation: [],
          ownedPaths: ["proof.cjs", ".gitignore"],
        },
        item,
      ],
      coverage: [
        {
          criterionId: hash(item.acceptance[0]),
          source: {
            path: "OBJECTIVE",
            digest: hash(item.acceptance[0]),
            text: item.acceptance[0],
          },
          itemId: "qa",
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
    const config = {
      repository: `integration/qa-proof-${root.split("/").at(-1)}`,
      checkout,
      delivery: { kind: "regular" },
      capture: {
        enabled: false,
        maxBytesPerInvocation: 1024,
        retainInRecovery: false,
      },
    };
    const prior = {
      treeSha,
      commands: commands.map((command, index) => ({
        index,
        command,
        treeSha,
        passed: true,
        exitCode: 0,
      })),
    };
    const work = {
      status: "waiting",
      step: "approve-result",
      attempt: "same-qa-attempt",
      baseSha: commit,
      executionBaseSha: commit,
      changeRef: commit,
      treeSha,
      graphRevisionDigest: graphDigest(graph),
      validation: prior,
      acceptancePending: {
        treeSha,
        criterion: item.acceptance[0],
        detail: "Missing runtime proof",
        question: "Supply complete proof",
      },
    };
    const state = {
      schemaVersion: 7,
      publicationContract: "exact-request-v1",
      repository: config.repository,
      objective: 1,
      runId: "same-qa-run",
      baseSha: base,
      graph,
      planGraphDigest: graphDigest(graph),
      approvedPlaybookPin: null,
      approvedPlaybookAdmission: {
        approvedPlaybookPin: null,
        configDigest: factoryConfigDigest(config),
        graphDigest: graphDigest(graph),
        packetDigest: "c".repeat(64),
        reviewDigest: "d".repeat(64),
        sourcePacketDigest: "e".repeat(64),
      },
      capacity: { concurrency: 1 },
      issueByItemId: { implementation: 3, qa: 2 },
      configDigest: factoryConfigDigest(config),
      integratedSha: commit,
      work: {
        implementation: {
          status: "done",
          attempt: "actual-result",
          baseSha: base,
          executionBaseSha: base,
          changeRef: result,
          integratedSha: commit,
          treeSha,
          validation: { treeSha, commands: [] },
          githubClosure: "complete",
        },
        qa: work,
      },
      autonomy: resolveAutonomy({ allowances: { resultRereviews: 1 } }),
      coordinator: {
        mode: "paused",
        phase: "waiting",
        phaseStartedAt: new Date().toISOString(),
        processes: [],
      },
    };
    const selectors = [
      {
        command: commands[0],
        text: {
          source: "proof.cjs",
          stdout: { maxBytes: 4096 },
          files: [
            {
              file: "node_modules/dependency/package.json",
              mediaType: "application/json",
              maxBytes: 4096,
            },
            {
              file: "node_modules/dependency/api.js",
              mediaType: "text/plain",
              maxBytes: 4096,
            },
          ],
        },
      },
      {
        command: commands[1],
        text: {
          source: "proof.cjs",
          stdout: { maxBytes: 4096 },
          locator: {
            stdoutPathPrefix: "Runtime evidence: ",
            match: {
              pattern: "*.json",
              mediaType: "application/json",
              maxBytes: 4096,
              maxTotalBytes: 8192,
              maxFiles: 4,
            },
          },
        },
      },
    ];
    assertKnownFlags("retry", [
      "--objective",
      "1",
      "--item",
      "qa",
      "--rereview",
      "--review-artifacts",
      "selectors.json",
    ]);
    saveState(statePath(config.repository, 1), state);
    assert.throws(
      () =>
        rereviewWorkItem(config, 1, {
          item: "qa",
          actor: "operator",
          reviewArtifacts: [{ ...selectors[0], command: "echo unauthorized" }],
        }),
      /exact declared/,
    );
    assert.equal(
      consumption(readState(config.repository, 1)).resultRereviews,
      0,
    );
    assert.throws(
      () =>
        rereviewWorkItem(config, 1, {
          item: "qa",
          actor: "operator",
          reviewArtifacts: [
            {
              ...selectors[0],
              text: { ...selectors[0].text, source: "missing.cjs" },
            },
          ],
        }),
      /tracked regular/,
    );
    rereviewWorkItem(config, 1, {
      item: "qa",
      actor: "operator",
      reviewArtifacts: selectors,
    });
    const resumed = readState(config.repository, 1);
    assert.equal(resumed.work.qa.attempt, work.attempt);
    assert.equal(resumed.work.qa.changeRef, commit);
    assert.deepEqual(
      resumed.work.qa.recovery.history[0].work.validation,
      prior,
    );
    assert.equal(
      resumed.work.qa.recovery.history[0].work.reviewArtifactSelection,
      undefined,
    );
    assert.deepEqual(resumed.work.qa.reviewArtifactSelection, selectors);
    assert.equal(consumption(resumed).resultRereviews, 1);
    resumed.coordinator.mode = "running";
    const store = new LocalContentStore(join(root, "objects"));
    let captured;
    const events = [];
    const model = {
      reviewResult: async (request) => {
        captured = request;
        const index = request.reviewPacket.evidence.findIndex(
          (x) => x.content === '{"equal":true}',
        );
        assert.ok(index >= 0);
        return {
          packetId: request.reviewPacket.id,
          findings: [
            {
              criterionIndex: 0,
              verdict: "pass",
              evidenceIndices: [index],
              detail: "Complete current command proof supplied",
              question: "",
            },
          ],
        };
      },
    };
    await runQaItem({
      config,
      root,
      state: resumed,
      item: resumed.graph.items[1],
      github: { defaultBranch: async () => "main", closeIssue: async () => {} },
      model,
      objectiveBody: body,
      store,
      save() {},
      cancelled: () => false,
      diagnostics: {
        emit: (x) => events.push(x),
        emitStream: (x) => events.push(x),
        modelObserver: () => () => {},
      },
    });
    assert.equal(resumed.work.qa.status, "done");
    assert.equal(resumed.work.qa.attempt, work.attempt);
    assert.ok(events.some((x) => x.operation === "qa-validation-output"));
    const artifacts = resumed.work.qa.validation.reviewArtifacts;
    assert.equal(artifacts.length, 2);
    const locator = artifacts[1].text.locator;
    const stdout = (
      await store.readBytes(artifacts[1].text.bodies[0].ref)
    ).toString();
    assert.equal(
      locator.temporaryRoot,
      stdout.split("Owned temp: ")[1].split("\n")[0],
    );
    assert.equal(
      locator.directory,
      stdout.split("Runtime evidence: ")[1].trimEnd(),
    );
    assert.equal(locator.resolvedTemporaryRoot, locator.temporaryRoot);
    assert.equal(locator.resolvedDirectory, locator.directory);
    assert.equal(
      locator.stdoutPathPrefix,
      selectors[1].text.locator.stdoutPathPrefix,
    );
    assert.equal(dirname(locator.directory), locator.temporaryRoot);
    // A match captures every matching file in sorted order, nothing else.
    assert.deepEqual(
      artifacts[1].text.bodies.slice(1).map((body) => basename(body.path)),
      ["comparison.json", "node.json"],
    );
    const resultBinding = captured.reviewPacket.evidence
      .map((entry) => {
        try {
          return JSON.parse(entry.content);
        } catch {
          return undefined;
        }
      })
      .find((entry) => entry?.text?.locator);
    assert.deepEqual(resultBinding.text.locator, locator);
    assert.equal(
      artifacts[0].text.source.sha256,
      hash(readFileSync(join(checkout, "proof.cjs"))),
    );
    assert.equal(
      artifacts[0].text.bodies[1].resolvedPath,
      "node_modules/.store/dependency/package.json",
    );
    assert.equal(existsSync(join(root, "validation", "qa", "worktree")), false);
    assert.equal(
      captured.reviewPacket.evidence.some((x) =>
        x.content.includes("exports.fromState = state"),
      ),
      true,
    );
    assert.equal(
      captured.reviewPacket.evidence.some((x) =>
        x.content.includes('"restoration":true'),
      ),
      true,
    );
    // The real final-evidence producer selects accepted same-tree observations;
    // fresh final commands need no duplicate prospective selector admission.
    const accepted = objectiveReviewEvidence({
      state: resumed,
      checkout,
      candidateCommitSha: commit,
      candidateTreeSha: treeSha,
    });
    assert.equal(accepted.acceptedWorkItemImages.length, 1);
    // Historical captures remain readable, but never gain inferred location facts.
    const historical = structuredClone(resumed.work.qa.validation);
    delete historical.reviewArtifacts[1].text.locator;
    const historicalEvidence = await reviewTextArtifactEvidence(
      checkout,
      historical,
      [],
      store,
    );
    assert.equal(
      historicalEvidence.some((entry) =>
        entry.content.includes('"resolvedTemporaryRoot"'),
      ),
      false,
    );
    const changed = structuredClone(resumed.work.qa.validation);
    changed.reviewArtifacts[0].text.bodies[0].ref.digest = "0".repeat(64);
    await assert.rejects(
      () => reviewTextArtifactEvidence(checkout, changed, [], store),
      /missing|digest verification/,
    );

    const finalCommand = `${process.execPath} -e 'process.exit(0)'`;
    resumed.objectiveCommands = [finalCommand];
    await assert.rejects(
      () =>
        finalizeObjective({
          config,
          objective: 1,
          issue: { body },
          state: resumed,
          graph: resumed.graph,
          objectiveDirectory: join(root, "objective"),
          root,
          diagnostics: {
            emit() {},
            emitStream() {},
            modelObserver: () => () => {},
            span: async (_event, run) => run(),
          },
          github: { defaultBranch: async () => "main" },
          contentStore: store,
          planningModel: {
            reviewResult: async (request) => {
              const rendered = renderResultReviewCall(request);
              assert.ok(
                rendered.prompt.includes("accepted-work-item-validation"),
              );
              assert.ok(
                request.reviewPacket.evidence.some(
                  (x) => x.content === '{"equal":true}',
                ),
              );
              const finalBinding = request.reviewPacket.evidence
                .map((entry) => {
                  try {
                    return JSON.parse(entry.content);
                  } catch {
                    return undefined;
                  }
                })
                .find((entry) => entry?.text?.locator);
              assert.deepEqual(finalBinding.text.locator, locator);
              assert.equal(
                finalBinding.origin.kind,
                "accepted-work-item-validation",
              );
              assert.deepEqual(
                request.commands.map((x) => x.command),
                [finalCommand],
              );
              assert.ok(
                request.commands.every(
                  (x) => x.passed && x.treeSha === treeSha,
                ),
              );
              throw Error("final proof inspected");
            },
          },
          save() {},
          objectiveStep: async (_state, name, run) =>
            name === "final-head"
              ? false
              : run({
                  progress() {},
                  previousInvalid: () => undefined,
                  invalid() {},
                  paid: (run) => run(),
                }),
          stopIfCancelled() {},
          cancellationRequested: () => false,
          objectiveSignal: () => new AbortController().signal,
          objectivePause: () => undefined,
        }),
      /final proof inspected/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected text refuses lossy, oversized, missing and foreign proof without changing commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-text-refusals-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Integration");
    git("config", "user.email", "integration@example.invalid");
    writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");
    const foreign = join(root, "old-runtime");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "proof.json"), '{"stale":true}');
    writeFileSync(
      join(checkout, "proof.cjs"),
      `const fs=require('node:fs'),p=require('node:path'),os=require('node:os');
const mode=process.argv[2];
if(mode==='invalid')process.stdout.write(Buffer.from([0xff]));
if(mode==='oversized')process.stdout.write('x'.repeat(33));
if(mode==='stderr')process.stderr.write(Buffer.from([0xff]));
if(mode==='stale')console.log('Runtime: '+${JSON.stringify(foreign)});
if(mode==='escape') {fs.mkdirSync('node_modules');fs.symlinkSync(${JSON.stringify(foreign)},'node_modules/dependency');}
if(mode==='json') {const dir=fs.mkdtempSync(p.join(os.tmpdir(),'evidence-'));fs.writeFileSync(p.join(dir,'proof.json'),'not json');console.log('Runtime: '+dir);}
`,
    );
    git("add", ".");
    git("commit", "-m", "Proof contract");
    const commit = git("rev-parse", "HEAD"),
      tree = git("rev-parse", "HEAD^{tree}"),
      store = new LocalContentStore(join(root, "objects"));
    const command = (mode) => `${process.execPath} proof.cjs ${mode}`;
    const run = (mode, text) =>
      validateTree(
        checkout,
        join(root, mode),
        commit,
        tree,
        [command(mode)],
        undefined,
        undefined,
        [],
        store,
        commit,
        true,
        { commands: [] },
        [{ command: command(mode), text: { source: "proof.cjs", ...text } }],
      );
    await assert.rejects(
      () => run("invalid", { stdout: { maxBytes: 32 } }),
      /UTF-8/,
    );
    await assert.rejects(
      () => run("stderr", { stderr: { maxBytes: 32 } }),
      /UTF-8/,
    );
    await assert.rejects(
      () => run("oversized", { stdout: { maxBytes: 32 } }),
      /byte bound/,
    );
    const locator = {
      stdoutPathPrefix: "Runtime: ",
      files: [
        { file: "proof.json", mediaType: "application/json", maxBytes: 1024 },
      ],
    };
    // Both the supplied owned root and stdout directory may have contained
    // aliases. Keep their literal identities distinct from verified realpaths.
    const owned = join(root, "owned");
    const directory = join(owned, "reports");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "proof.json"), '{"equal":true}');
    const rootAlias = join(root, "owned-alias");
    symlinkSync(owned, rootAlias);
    symlinkSync("reports", join(owned, "report-alias"));
    const markedDirectory = join(rootAlias, "report-alias");
    const captured = await captureReviewArtifacts({
      worktree: checkout,
      treeSha: tree,
      commandIndex: 0,
      command: command("alias"),
      stdout: `Runtime: ${markedDirectory}\n`,
      stdoutBytes: Buffer.from(`Runtime: ${markedDirectory}\n`),
      temporaryRoot: rootAlias,
      selectors: [
        { command: command("alias"), text: { source: "proof.cjs", locator } },
      ],
      contentStore: store,
    });
    assert.deepEqual(captured[0].text.locator, {
      temporaryRoot: rootAlias,
      resolvedTemporaryRoot: realpathSync(owned),
      stdoutPathPrefix: "Runtime: ",
      directory: markedDirectory,
      resolvedDirectory: realpathSync(directory),
    });
    const receipts = [
      {
        index: 0,
        command: command("alias"),
        treeSha: tree,
        passed: true,
        exitCode: 0,
      },
    ];
    assertReviewArtifacts(captured, tree, receipts);
    for (const mutate of [
      (value) => {
        value.text.locator.temporaryRoot = "relative";
      },
      (value) => {
        value.text.locator.directory = "relative";
      },
      (value) => {
        value.text.locator.stdoutPathPrefix = "Runtime:\n";
      },
      (value) => {
        value.text.locator.resolvedDirectory = foreign;
      },
      (value) => {
        value.text.bodies[0].path = "other/proof.json";
      },
      (value) => {
        value.text.bodies[0].resolvedPath = "../foreign/proof.json";
      },
      // Inside the temporary root but outside the located directory.
      (value) => {
        value.text.bodies[0].resolvedPath = "other/proof.json";
      },
    ]) {
      const changed = structuredClone(captured);
      mutate(changed[0]);
      assert.throws(
        () => assertReviewArtifacts(changed, tree, receipts),
        /locator|contained and relative/,
      );
    }
    // A located file aliasing a sibling directory in the same temporary root
    // is refused: the guarantee is the located directory, not the root.
    mkdirSync(join(owned, "other"), { recursive: true });
    writeFileSync(join(owned, "other", "proof.json"), '{"equal":false}');
    symlinkSync("../other/proof.json", join(directory, "sibling.json"));
    await assert.rejects(
      () =>
        captureReviewArtifacts({
          worktree: checkout,
          treeSha: tree,
          commandIndex: 0,
          command: command("alias"),
          stdout: `Runtime: ${markedDirectory}\n`,
          stdoutBytes: Buffer.from(`Runtime: ${markedDirectory}\n`),
          temporaryRoot: rootAlias,
          selectors: [
            {
              command: command("alias"),
              text: {
                source: "proof.cjs",
                locator: {
                  stdoutPathPrefix: "Runtime: ",
                  files: [
                    {
                      file: "sibling.json",
                      mediaType: "application/json",
                      maxBytes: 1024,
                    },
                  ],
                },
              },
            },
          ],
          contentStore: store,
        }),
      /outside its located directory/,
    );
    await assert.rejects(
      () => run("stale", { locator }),
      /contained and relative/,
    );
    await assert.rejects(
      () => run("json", { locator }),
      /JSON|Unexpected token/,
    );
    await assert.rejects(
      () =>
        run("escape", {
          files: [
            {
              file: "node_modules/dependency/proof.json",
              mediaType: "application/json",
              maxBytes: 1024,
            },
          ],
        }),
      /contained and relative/,
    );
    await assert.rejects(
      () =>
        run("missing", {
          files: [
            { file: "missing.txt", mediaType: "text/plain", maxBytes: 1024 },
          ],
        }),
      /ENOENT/,
    );
    const empty = await run("empty", { stdout: { maxBytes: 32 } });
    assert.equal(empty.reviewArtifacts[0].text.bodies[0].ref.bytes, 0);
    assert.equal(
      (await store.readBytes(empty.reviewArtifacts[0].text.bodies[0].ref))
        .length,
      0,
    );
    assert.throws(
      () =>
        assertReviewArtifactSelection(
          [
            {
              command: command("empty"),
              text: {
                source: "proof.cjs",
                files: [
                  {
                    file: ".git/config",
                    mediaType: "text/plain",
                    maxBytes: 32,
                  },
                ],
              },
            },
          ],
          [command("empty")],
        ),
      /contained and relative/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
