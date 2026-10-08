import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeInteractions } from "../dist/analysis.js";
import { runAnalysisCommand } from "../dist/analysis-cli.js";
import { readInteractionContent } from "../dist/capture.js";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import { DiagnosticEmitter, readDiagnostics } from "../dist/diagnostics.js";
import { CodexHarness } from "../dist/execution/local.js";
import { killGroup } from "../dist/execution/worker-process.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  addWorktree,
  linuxProcessIdentity,
  processGroupExists,
  removeWorktree,
  sanitizedWorkerEnvironment,
  subprocessAsync,
  withProcessCancellation,
} from "../dist/process.js";
import {
  environmentValidationIndices,
  objectivePreparationCommands,
} from "../dist/qa.js";
import { preflightItemEnvironment } from "../dist/qa-execution.js";
import {
  charge,
  consumption,
  objectiveEvent,
  resolveAutonomy,
} from "../dist/repair-policy.js";
import { rereviewWorkItem } from "../dist/runner.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import {
  validateCheckout,
  validateTree,
  validateWorkItem,
} from "../dist/validation.js";
import {
  CandidateValidationFailure,
  recordWorkFailure,
} from "../dist/work-repair.js";

test("trusted child captures roundtrip through the configured private state root", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-worker-capture-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  const repository = "integration/worker-capture";
  process.env.XDG_STATE_HOME = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const result = await subprocessAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CaptureWriter } from ${JSON.stringify(new URL("../dist/capture.js", import.meta.url).href)};
import { DiagnosticEmitter } from ${JSON.stringify(new URL("../dist/diagnostics.js", import.meta.url).href)};
import { GitHubClient, gitHubTransportOf, withGitHubTransportObserver } from ${JSON.stringify(new URL("../dist/github-client.js", import.meta.url).href)};
import { withProcessCancellation } from ${JSON.stringify(new URL("../dist/process.js", import.meta.url).href)};
import { stateRoot } from ${JSON.stringify(new URL("../dist/config.js", import.meta.url).href)};
import { createCodexHome } from ${JSON.stringify(new URL("../dist/codex-planning-isolation.js", import.meta.url).href)};
const home = createCodexHome({ config: "", sandbox: { directory: process.cwd(), workspace: "write", network: false } });
const nativeEvents = [];
try {
  assert.equal(home.env.XDG_STATE_HOME, undefined);
  assert.equal(readFileSync(join(home.env.CODEX_HOME, "config.toml"), "utf8").includes(process.env.XDG_STATE_HOME), false);
  home.nativeCapture("00000000-0000-4000-8000-000000000000", event => nativeEvents.push(event));
} finally { home.dispose(); }
const privateBin = join(stateRoot(${JSON.stringify(repository)}), "bin");
mkdirSync(privateBin, { recursive: true });
assert.throws(() => createCodexHome({ config: "", source: { ...process.env, PATH: privateBin }, sandbox: { directory: process.cwd(), workspace: "write", network: false } }), /Factory's own files/);
const stop = new AbortController();
stop.abort(new Error("private original cancellation reason"));
const diagnostics = new DiagnosticEmitter(${JSON.stringify(repository)}, 1);
let transport;
await withGitHubTransportObserver(observation => {
  transport = observation;
  diagnostics.emit({ operation: "github-transport", outcome: "failed", transport: observation });
}, () => withProcessCancellation(stop.signal, async () => {
  await assert.rejects(new GitHubClient().request("POST", "repos/integration/worker-capture/issues", { body: "private unsent payload" }), error => {
    assert.equal(gitHubTransportOf(error), transport);
    assert.equal(error.message.includes("private"), false);
    return true;
  });
}));
assert.deepEqual(transport, { method: "POST", operation: "mutation", dispatch: "not-sent", outcome: "cancelled", category: "cancelled", status: null, timeout: null, cancellation: true, requestId: null });
assert.equal(Object.isFrozen(transport), true);
const retained = readFileSync(join(stateRoot(${JSON.stringify(repository)}), "objectives", "1", "diagnostics.ndjson"), "utf8");
assert.equal(retained.includes("private"), false);
assert.deepEqual(JSON.parse(retained.trim()).transport, transport);
const emitted = [];
const writer = new CaptureWriter({ repository: ${JSON.stringify(repository)}, objective: 1, invocationId: "actual-child-capture", providerAttempt: 1, phase: "integration", adapter: "local-process", configured: { provider: "not-invoked", model: "none" } }, { enabled: true, maxBytesPerInvocation: 1024 }, [], metadata => emitted.push(metadata));
writer.record({ kind: "interaction" }, () => ({ text: "real child process capture" }));
for (const event of nativeEvents) writer.record(event);
process.stdout.write(JSON.stringify(emitted));`,
      ],
      {
        cwd: workspace,
        env: sanitizedWorkerEnvironment(join(root, "credentials")),
      },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    const [metadata, unavailableNative] = JSON.parse(result.stdout.toString());
    assert.equal(metadata.content.status, "captured");
    assert.deepEqual(
      JSON.parse(
        readInteractionContent(repository, metadata.content.reference),
      ),
      { text: "real child process capture" },
    );
    // A real private process capture is not a native model tool call. Even the
    // explicit legacy-tool read must neither expose its text nor invent counts.
    const analysis = analyzeInteractions([metadata], [], {
      includeNativeToolContent: true,
    });
    assert.equal(analysis.nativeToolActivity.uniqueCalls, null);
    assert.equal(analysis.invocations[0].nativeToolActivity.contentReads, 0);
    assert.equal(
      JSON.stringify(analysis).includes("real child process capture"),
      false,
    );
    // The actual owned-home reader emits unavailable for a missing rollout;
    // that observation must never turn into a fabricated zero-call history.
    assert.equal(unavailableNative.nativeRollout.status, "unavailable");
    const unavailable = analyzeInteractions([unavailableNative]);
    assert.equal(unavailable.nativeToolActivity.availability, "unavailable");
    assert.equal(unavailable.nativeToolActivity.uniqueCalls, null);
    assert.equal(unavailable.nativeToolActivity.callRounds, null);
    new DiagnosticEmitter(repository, 1).emit({
      operation: "model-capture",
      outcome: "observed",
      capture: metadata,
    });
    const analysisText = runAnalysisCommand(
      { repository, checkout: workspace },
      1,
      ["--json"],
    );
    const cliAnalysis = JSON.parse(analysisText);
    assert.equal(cliAnalysis.invocationCount, 1);
    assert.equal(cliAnalysis.nativeTools.calls, null);
    assert.equal(cliAnalysis.nativeTools.coverage, "unavailable");
    assert.equal(cliAnalysis.invocations[0].native.tools.calls, null);
    assert.equal(cliAnalysis.invocations[0].native.tools.observedOutputs, null);
    assert.equal(
      cliAnalysis.invocations[0].native.descendants.accountingUnion,
      null,
    );
    assert.equal(analysisText.includes("real child process capture"), false);
    const captures = join(stateRoot(repository), "captures");
    assert.equal(statSync(captures).mode & 0o777, 0o700);
    const [file] = readdirSync(captures);
    assert.equal(statSync(join(captures, file)).mode & 0o777, 0o600);
    assert.equal(
      existsSync(
        join(
          process.env.HOME,
          ".local",
          "state",
          "clockgrove-factory",
          "repositories",
          "integration",
          "worker-capture",
        ),
      ),
      false,
    );
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation stops an owned shell and its process group", async () => {
  const controller = new AbortController();
  let pid;
  const result = withProcessCancellation(controller.signal, () =>
    subprocessAsync(
      "sh",
      ["-c", "echo $$; sleep 120 & wait"],
      {},
      undefined,
      (stream, chunk) => {
        if (stream === "stdout") {
          pid = Number(chunk.toString().trim());
          controller.abort();
        }
      },
    ),
  );
  await assert.rejects(result, /cancelled after verified cessation/);
  assert.ok(pid > 0);
  assert.equal(processGroupExists(pid), false);
});

test("collection settles an exited owned group before removing scratch", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-owned-exit-"));
  const harnessRoot = join(root, "harness");
  mkdirSync(harnessRoot);
  const requestPath = join(harnessRoot, "exited.request.json");
  const scratch = `${requestPath}.codex-home`;
  mkdirSync(scratch);
  // A real shell exits with no result, leaving a child that ignores SIGTERM.
  // No provider, SDK or scripted harness response is involved.
  const child = spawn(
    "sh",
    ["-c", 'trap "" TERM; sleep 120 & echo ready; read -r hold; exit 23'],
    { detached: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  try {
    const identity = linuxProcessIdentity(child.pid);
    assert.ok(identity);
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.stdin.end("\n");
    assert.equal((await exited)[0], 23);
    assert.equal(processGroupExists(child.pid), true);
    const harness = new CodexHarness(join(root, "credentials"), "off", {
      model: "unused",
      reasoningEffort: "low",
    });
    await assert.rejects(
      harness.collect({
        identity: "exited",
        data: {
          pid: child.pid,
          startTime: identity.startTime,
          requestPath,
          resultPath: join(harnessRoot, "exited.result.json"),
          logPath: join(harnessRoot, "exited.log"),
        },
      }),
      /worker exited without a durable result/,
    );
    assert.equal(processGroupExists(child.pid), false);
    assert.equal(existsSync(scratch), false);
  } finally {
    if (processGroupExists(child.pid))
      await killGroup(child.pid, "integration shell");
    rmSync(root, { recursive: true, force: true });
  }
});

test("settled validation reuses its exact Git result once and retains the failed capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-validation-rereview-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    writeFileSync(join(checkout, "README.md"), "# Unchanged candidate\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Integration",
      "-c",
      "user.email=integration@example.invalid",
      "commit",
      "-m",
      "candidate",
    );
    const commit = git("rev-parse", "HEAD");
    const treeSha = git("rev-parse", "HEAD^{tree}");
    const ready = join(root, "ready");
    const command = `${process.execPath} -e 'process.exit(require("node:fs").existsSync(${JSON.stringify(ready)}) ? 0 : 1)'`;
    const config = { repository: "integration/validation-rereview", checkout };
    const graph = {
      objective: 1,
      baseSha: commit,
      items: [
        {
          id: "local",
          kind: "work",
          title: "Validate local readiness",
          goal: "Preserve the exact candidate",
          brief: "Run the declared local validation",
          acceptance: ["Readiness command passes"],
          nonGoals: [],
          dependencies: [],
          ownedPaths: ["README.md"],
          resources: [],
          expectedOutputRoles: [],
          requiredLfsRoles: [],
          sourceAssets: [],
          minimumAssetSets: 0,
          citations: [],
          validation: [{ command, provenance: "source-declared" }],
        },
      ],
      coverage: [
        {
          criterionId: createHash("sha256").update(command).digest("hex"),
          source: {
            path: "OBJECTIVE",
            digest: createHash("sha256").update(command).digest("hex"),
            text: command,
          },
          itemId: "local",
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
    const work = {
      status: "failed",
      step: "validate",
      attempt: "one-implementation",
      baseSha: commit,
      executionBaseSha: commit,
      graphRevisionDigest: graphDigest(graph),
      changeRef: commit,
      treeSha,
    };
    const state = {
      schemaVersion: 7,
      publicationContract: "exact-request-v1",
      repository: config.repository,
      objective: 1,
      runId: "actual-local-validation",
      planGraphDigest: graphDigest(graph),
      capacity: { concurrency: 1 },
      issueByItemId: { local: 1 },
      configDigest: factoryConfigDigest(config),
      baseSha: commit,
      graph,
      work: { local: work },
      autonomy: resolveAutonomy({ allowances: { implementationRepairs: 0 } }),
    };
    await assert.rejects(
      () =>
        validateTree(
          checkout,
          join(root, "validation"),
          commit,
          treeSha,
          [command],
          undefined,
          undefined,
          [],
          undefined,
          commit,
        ),
      (error) => {
        assert.ok(error instanceof CandidateValidationFailure);
        assert.equal(error.failedValidation.commands[0].exitCode, 1);
        recordWorkFailure(state, "local", error);
        return true;
      },
    );
    const original = structuredClone(work.failedValidation);
    const originalFailure = structuredClone(work.recovery.failure);
    const request = { item: "local", actor: "integration-operator" };
    state.coordinator = {
      mode: "paused",
      phase: "waiting",
      phaseStartedAt: new Date().toISOString(),
      processes: [
        {
          pid: process.pid,
          startTime: linuxProcessIdentity(process.pid).startTime,
        },
      ],
    };
    saveState(statePath(config.repository, 1), state);
    assert.throws(
      () => rereviewWorkItem(config, 1, request),
      /settled owned work/,
    );
    state.coordinator.processes = [];
    saveState(statePath(config.repository, 1), state);
    rereviewWorkItem(config, 1, request);
    Object.assign(state, readState(config.repository, 1));
    Object.assign(work, state.work.local);
    state.work.local = work;
    assert.equal(work.attempt, "one-implementation");
    assert.equal(work.changeRef, commit);
    assert.equal(work.treeSha, treeSha);
    assert.deepEqual(work.recovery.history[0].work.failedValidation, original);
    assert.deepEqual(work.recovery.history[0].failure, originalFailure);
    assert.equal(consumption(state).resultRereviews, 1);
    assert.equal(consumption(state).implementationRepairs, 0);
    assert.throws(() => rereviewWorkItem(config, 1, request), /not awaiting/);
    // The same real command still fails: its original charge cannot be reused.
    await assert.rejects(
      () =>
        validateTree(
          checkout,
          join(root, "validation"),
          commit,
          treeSha,
          [command],
          undefined,
          undefined,
          [],
          undefined,
          commit,
        ),
      (error) => {
        work.status = "failed";
        recordWorkFailure(state, "local", error);
        return true;
      },
    );
    saveState(statePath(config.repository, 1), state);
    assert.throws(
      () => rereviewWorkItem(config, 1, request),
      /resultRereviews allowance exhausted/,
    );
    writeFileSync(ready, "external local readiness restored\n");
    const evidence = await validateTree(
      checkout,
      join(root, "validation"),
      commit,
      treeSha,
      [command],
      undefined,
      undefined,
      [],
      undefined,
      commit,
    );
    assert.equal(evidence.treeSha, treeSha);
    assert.equal(evidence.commands[0].exitCode, 0);
    assert.equal(git("rev-parse", "HEAD"), commit);
    // A real exclusive owner saves intent then exits before dispatch. The next
    // process reclaims ownership and loads the atomic snapshot, not diagnostics.
    const validationHistory = readState(config.repository, 1);
    const publicationGraph = { ...graph, objective: 2 };
    const publicationState = {
      schemaVersion: 7,
      publicationContract: "exact-request-v1",
      repository: config.repository,
      objective: 2,
      runId: "actual-local-publication",
      planGraphDigest: graphDigest(publicationGraph),
      capacity: state.capacity,
      issueByItemId: { local: 2 },
      configDigest: state.configDigest,
      baseSha: commit,
      graph: publicationGraph,
      autonomy: state.autonomy,
      coordinator: {
        mode: "running",
        phase: "active",
        phaseStartedAt: new Date().toISOString(),
      },
      work: {
        local: {
          status: "running",
          step: "deliver",
          attempt: "actual-publication-attempt",
          baseSha: commit,
          executionBaseSha: commit,
          graphRevisionDigest: graphDigest(publicationGraph),
          changeRef: commit,
          treeSha,
          validation: evidence,
        },
      },
    };
    saveState(statePath(config.repository, 2), publicationState);
    const publicationRequest = {
      branch: "factory/objective-2/local",
      base: "main",
      headSha: commit,
      treeSha,
      title: graph.items[0].title,
      body: "Exact controller publication text\n",
    };
    const stoppedOwner = `import assert from "node:assert/strict";
import { publicationControl } from ${JSON.stringify(new URL("../dist/delivery/publication.js", import.meta.url).href)};
import { readState, saveState, statePath, acquireObjectiveLock } from ${JSON.stringify(new URL("../dist/state-store.js", import.meta.url).href)};
const repository = ${JSON.stringify(config.repository)};
acquireObjectiveLock(repository, 2);
const state = readState(repository, 2);
const save = () => saveState(statePath(repository, 2), state);
const control = publicationControl(state, "local", save);
// Constructed before the first save: its empty history must never replace it.
const stale = publicationControl(state, "local", save);
const request = JSON.parse(process.argv[1]);
control.beforeCreate(request);
const retained = JSON.stringify(state.publicationIntents);
assert.throws(() => stale.assertRequest(request), /control is stale/);
assert.throws(() => stale.reconcileOnly, /control is stale/);
assert.throws(() => stale.beforeCreate(request), /control is stale/);
assert.equal(JSON.stringify(state.publicationIntents), retained);
assert.equal(JSON.stringify(readState(repository, 2).publicationIntents), retained);
process.exit(23);`;
    const first = await subprocessAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        stoppedOwner,
        JSON.stringify(publicationRequest),
      ],
      { cwd: checkout },
    );
    assert.equal(first.status, 23, first.stderr.toString());
    const retained = readState(config.repository, 2);
    assert.equal(retained.work.local.changeRef, commit);
    assert.equal(retained.work.local.treeSha, treeSha);
    const intent = retained.publicationIntents.local[0];
    assert.equal(intent.submission, "possibly-submitted");
    assert.equal(intent.observation, undefined);
    assert.equal(intent.headSha, commit);
    assert.equal(intent.treeSha, treeSha);
    assert.equal(
      intent.bodyDigest,
      createHash("sha256").update(publicationRequest.body).digest("hex"),
    );
    const restarted = await subprocessAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        stoppedOwner,
        JSON.stringify(publicationRequest),
      ],
      { cwd: checkout },
    );
    assert.notEqual(restarted.status, 23);
    assert.match(
      restarted.stderr.toString(),
      /permit is unavailable or already consumed/,
    );
    assert.deepEqual(
      readState(config.repository, 2).publicationIntents,
      retained.publicationIntents,
    );
    assert.equal(git("rev-parse", "HEAD"), commit);
    assert.deepEqual(readState(config.repository, 1), validationHistory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source readiness prepares each real fresh checkout before its phase checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-readiness-checkouts-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  const setup = "npm run hydrate-readiness";
  const probe = "npm run probe-readiness";
  const acceptance = "npm test";
  try {
    git("init", "-b", "main");
    writeFileSync(join(checkout, ".gitignore"), ".runtime-ready\n");
    writeFileSync(
      join(checkout, "README.md"),
      `Run this preimplementation prerequisite before its probe in each fresh checkout:\n${setup}\n${probe}\nOnly after implementing result.cjs, run:\n${acceptance}\n`,
    );
    writeFileSync(
      join(checkout, "prepare.cjs"),
      'const fs=require("node:fs"); if(fs.existsSync(".runtime-ready")) throw Error("not fresh"); fs.writeFileSync(".runtime-ready", "prepared");\n',
    );
    writeFileSync(
      join(checkout, "probe.cjs"),
      'const fs=require("node:fs"); if(fs.readFileSync(".runtime-ready","utf8")!=="prepared") throw Error("unprepared");\n',
    );
    writeFileSync(
      join(checkout, "accept.cjs"),
      'require("./probe.cjs"); if(require("./result.cjs")!==42) throw Error("unimplemented");\n',
    );
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({
        name: "fresh-readiness-integration",
        version: "1.0.0",
        private: true,
        scripts: {
          "hydrate-readiness": "node prepare.cjs",
          "probe-readiness": "node probe.cjs",
          test: "node accept.cjs",
        },
      }),
    );
    git("add", ".");
    git(
      "-c",
      "user.name=Integration",
      "-c",
      "user.email=integration@example.invalid",
      "commit",
      "-m",
      "source-authorized preparation, probe and late acceptance",
    );
    const baseSha = git("rev-parse", "HEAD");
    const baseTree = git("rev-parse", "HEAD^{tree}");
    const item = {
      id: "implementation",
      kind: "work",
      title: "Implement result",
      goal: "Return required result",
      brief: "Implement result.cjs",
      acceptance: ["Result is 42"],
      nonGoals: [],
      dependencies: [],
      ownedPaths: ["result.cjs"],
      resources: [],
      expectedOutputRoles: [],
      requiredLfsRoles: [],
      sourceAssets: [],
      minimumAssetSets: 0,
      citations: [],
      validation: [setup, probe, acceptance].map((command) => ({
        command,
        provenance: "source-declared",
        source: "README.md",
      })),
    };
    const graph = {
      objective: 1,
      baseSha,
      items: [item],
      coverage: [
        {
          criterionId: createHash("sha256").update(acceptance).digest("hex"),
          source: {
            path: "OBJECTIVE",
            digest: createHash("sha256").update(acceptance).digest("hex"),
            text: acceptance,
          },
          itemId: item.id,
          proof: { kind: "result-command", validationIndex: 2 },
          environment: {
            kind: "local",
            readiness: "available",
            probe,
            prerequisites: [setup],
            preparedBy: "",
          },
        },
      ],
    };
    assert.deepEqual(environmentValidationIndices(graph, item.id), [0, 1]);
    assert.deepEqual(objectivePreparationCommands(graph), [setup]);
    const diagnosticRepository = "integration/fresh-readiness";
    const diagnostics = new DiagnosticEmitter(diagnosticRepository, 1);
    await preflightItemEnvironment({
      config: { checkout },
      root: join(root, "run"),
      state: {
        graph,
        baseSha,
        runId: "local-real",
        work: { [item.id]: { status: "pending" } },
      },
      item,
      baseSha,
      diagnostics,
    });
    const events = readDiagnostics(diagnosticRepository, 1).filter(
      (event) => event.operation === "environment-readiness-command",
    );
    assert.deepEqual(
      events.map((event) => event.metadata.command),
      [setup, probe],
    );
    assert.ok(events.every((event) => event.outcome === "completed"));
    assert.equal(
      existsSync(
        join(root, "run", "environment-preflight", item.id, "worktree"),
      ),
      false,
    );
    const repository = "integration/readiness-amendment";
    const worker = join(
      stateRoot(repository),
      "worktrees",
      "recorded-checkout",
    );
    mkdirSync(join(stateRoot(repository), "worktrees"), {
      recursive: true,
      mode: 0o700,
    });
    await addWorktree(checkout, worker, baseSha);
    try {
      assert.equal(existsSync(join(worker, ".runtime-ready")), false);
      const readiness = await validateCheckout(
        worker,
        join(root, "worker-receipts"),
        baseSha,
        baseTree,
        [setup, probe],
      );
      assert.deepEqual(
        readiness.commands.map((entry) => entry.command),
        [setup, probe],
      );
      assert.equal(existsSync(join(worker, ".runtime-ready")), true);
      assert.equal(existsSync(join(worker, "result.cjs")), false);
      // A reviewed coverage-only revision leaves this recorded attempt intact.
      // Its real preparation receipt must not be reinterpreted as a new probe.
      // This stopped-attempt snapshot exercises the disk/parser contract only;
      // no harness, provider, model review or external amendment is invoked.
      const amended = structuredClone(graph);
      amended.coverage[0].environment.probe = acceptance;
      amended.coverage[0].environment.prerequisites = [setup, probe];
      const originalDigest = graphDigest(graph);
      const amendmentDigest = graphDigest(amended);
      const state = {
        schemaVersion: 7,
        publicationContract: "exact-request-v1",
        repository,
        objective: 1,
        runId: "recorded-readiness-checkout",
        planGraphDigest: originalDigest,
        configDigest: factoryConfigDigest({ repository, checkout }),
        baseSha,
        capacity: { concurrency: 1 },
        issueByItemId: { [item.id]: 1 },
        graph: amended,
        autonomy: resolveAutonomy({}),
        graphRevisions: [
          { graph, digest: originalDigest },
          {
            graph: amended,
            digest: amendmentDigest,
            parentDigest: originalDigest,
            proposal: {
              scope: "in-scope",
              reason: "Declare final probe preparation",
              evidence: ["README.md"],
              ownership: ["result.cjs"],
              acceptance: ["Result is 42"],
              dependencies: [],
              actor: "integration",
              expectedGraphDigest: originalDigest,
            },
            reviewDigest: createHash("sha256")
              .update(JSON.stringify(amended))
              .digest("hex"),
            acceptedAt: new Date().toISOString(),
          },
        ],
        work: {
          [item.id]: {
            status: "failed",
            step: "execute",
            attempt: "recorded-checkout",
            baseSha,
            executionBaseSha: baseSha,
            graphRevisionDigest: originalDigest,
            execution: {
              provider: "local",
              identity: "recorded-checkout",
              data: {
                worktree: worker,
                adapterIdentity: "local-process-receipt",
                handle: { identity: "settled-readiness-commands" },
                request: {
                  item,
                  baseSha,
                  attemptId: "recorded-checkout",
                  environmentReadiness: {
                    validationIndices: [0, 1],
                    acceptedBaseSha: baseSha,
                    lfsMembers: [],
                    workspacePackageAdditions: [],
                  },
                },
                environmentReadiness: {
                  commitSha: baseSha,
                  worktree: worker,
                  evidence: readiness,
                },
              },
            },
          },
        },
      };
      charge(
        state,
        objectiveEvent("amend", "integration-coverage-revision"),
        "planningRevisions",
        ["$planning"],
      );
      saveState(statePath(repository, 1), state);
      const retained = readState(repository, 1);
      assert.deepEqual(
        retained.work[item.id].execution.data.environmentReadiness.evidence,
        readiness,
      );
      assert.equal(retained.work[item.id].graphRevisionDigest, originalDigest);
      assert.deepEqual(
        environmentValidationIndices(retained.graph, item.id),
        [0, 1, 2],
      );
      const wrongRevision = structuredClone(state);
      wrongRevision.work[item.id].graphRevisionDigest = amendmentDigest;
      // Test malformed current interpretation against the same exact identity:
      assert.throws(
        () => saveState(statePath(repository, 1), wrongRevision),
        /readiness differs from accepted command authority/,
      );
      const historical = structuredClone(state);
      const historicalGraph = structuredClone(graph);
      historicalGraph.coverage[0].environment = {
        kind: "local",
        readiness: "available",
        probe: "",
        preparedBy: "",
      };
      const historicalDigest = graphDigest(historicalGraph);
      historical.planGraphDigest = historicalDigest;
      historical.graphRevisions[0] = {
        graph: historicalGraph,
        digest: historicalDigest,
      };
      historical.graphRevisions[1].parentDigest = historicalDigest;
      historical.graphRevisions[1].proposal.expectedGraphDigest =
        historicalDigest;
      historical.work[item.id].graphRevisionDigest = historicalDigest;
      delete historical.work[item.id].execution.data.request
        .environmentReadiness;
      delete historical.work[item.id].execution.data.environmentReadiness;
      saveState(statePath(repository, 1), historical);
      const old = readState(repository, 1);
      assert.equal(
        old.work[item.id].execution.data.request.environmentReadiness,
        undefined,
      );
      assert.equal(
        old.work[item.id].execution.data.environmentReadiness,
        undefined,
      );
      assert.equal(old.work[item.id].graphRevisionDigest, historicalDigest);
    } finally {
      await removeWorktree(checkout, worker);
    }
    await assert.rejects(
      validateTree(
        checkout,
        join(root, "before-implementation"),
        baseSha,
        baseTree,
        [acceptance],
        undefined,
        undefined,
        [],
        undefined,
        baseSha,
        false,
        { commands: [setup] },
      ),
      /result.cjs/,
    );
    writeFileSync(join(checkout, "result.cjs"), "module.exports=42;\n");
    git("add", "result.cjs");
    git(
      "-c",
      "user.name=Integration",
      "-c",
      "user.email=integration@example.invalid",
      "commit",
      "-m",
      "implementation",
    );
    const commit = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    const result = await validateWorkItem(
      checkout,
      join(root, "result-validation"),
      item,
      commit,
      tree,
      baseSha,
    );
    assert.deepEqual(
      result.commands.map((entry) => entry.command),
      [setup, probe, acceptance],
    );
    const final = await validateTree(
      checkout,
      join(root, "final-validation"),
      commit,
      tree,
      [acceptance],
      undefined,
      undefined,
      [],
      undefined,
      baseSha,
      true,
      { commands: objectivePreparationCommands(graph) },
    );
    assert.deepEqual(
      final.commands.map((entry) => entry.command),
      [acceptance],
    );
    assert.deepEqual(
      final.preparation.map((entry) => entry.command),
      [setup],
    );
    assert.equal(final.commands[0].index, 0);
    assert.ok(
      final.preparation.every(
        (entry) => entry.treeSha === tree && entry.passed,
      ),
    );
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(
      git("worktree", "list", "--porcelain").match(/^worktree /gm).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
