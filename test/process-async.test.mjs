import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
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
import { codexStderrCapture } from "../dist/codex-exec.js";
import { createCodexHome } from "../dist/codex-planning-isolation.js";
import {
  CodexPlanningModel,
  renderCompilationCall,
  renderDiagnosisCall,
} from "../dist/compiler/model.js";
import {
  hydrateWorkerInputSources,
  planningSources,
} from "../dist/compiler/sources.js";
import {
  prepareCompilationRequest,
  validateCompiledGraph,
} from "../dist/compiler/planning.js";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import {
  diagnosticPath,
  DiagnosticEmitter,
  readDiagnostics,
  summarizeFormalHistory,
  withDiagnosticSession,
} from "../dist/diagnostics.js";
import { CodexHarness, LocalExecutionDriver } from "../dist/execution/local.js";
import { LocalContentStore } from "../dist/content/local.js";
import { NativeStackDelivery } from "../dist/delivery/native-stack.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import { RealGitHubGateway } from "../dist/github.js";
import { withGitHubTransportObserver } from "../dist/github-client.js";
import { runObjectivePass } from "../dist/runner/execution.js";
import { killGroup } from "../dist/execution/worker-process.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  addWorktree,
  gitAsync,
  linuxProcessIdentity,
  processGroupExists,
  removeWorktree,
  sanitizedWorkerEnvironment,
  subprocessAsync,
  withProcessCancellation,
} from "../dist/process.js";
import {
  assertCompletedCoverage,
  environmentValidationIndices,
  objectivePreparationCommands,
} from "../dist/qa.js";
import { preflightItemEnvironment } from "../dist/qa-execution.js";
import {
  charge,
  chargeRepair,
  consumption,
  objectiveEvent,
  resolveAutonomy,
  repairScopes,
} from "../dist/repair-policy.js";
import { decideResult, rereviewWorkItem } from "../dist/runner.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import {
  assertStepAdmission,
  step,
  stepCancellationSignal,
  StepPaused,
} from "../dist/step.js";
import {
  validateCheckout,
  validateTree,
  validateWorkItem,
} from "../dist/validation.js";
import {
  CandidateValidationFailure,
  actionableReadiness,
  applyWorkCorrection,
  diagnosisFiles,
  repairEvidence,
  recordWorkFailure,
  workRepairDiagnosisRequest,
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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptureWriter } from ${JSON.stringify(new URL("../dist/capture.js", import.meta.url).href)};
import { DiagnosticEmitter } from ${JSON.stringify(new URL("../dist/diagnostics.js", import.meta.url).href)};
import { GitHubClient, gitHubTransportOf, withGitHubTransportObserver } from ${JSON.stringify(new URL("../dist/github-client.js", import.meta.url).href)};
import { withProcessCancellation } from ${JSON.stringify(new URL("../dist/process.js", import.meta.url).href)};
import { stateRoot } from ${JSON.stringify(new URL("../dist/config.js", import.meta.url).href)};
import { createCodexHome, releaseCodexHome } from ${JSON.stringify(new URL("../dist/codex-planning-isolation.js", import.meta.url).href)};
import { observeModelInvocation } from ${JSON.stringify(new URL("../dist/compiler/observation.js", import.meta.url).href)};
const home = createCodexHome({ config: "", sandbox: { directory: process.cwd(), workspace: "write", network: false } });
const nativeEvents = [];
try {
  assert.equal(home.env.XDG_STATE_HOME, undefined);
  assert.equal(readFileSync(join(home.env.CODEX_HOME, "config.toml"), "utf8").includes(process.env.XDG_STATE_HOME), false);
  home.nativeCapture("00000000-0000-4000-8000-000000000000", event => nativeEvents.push(event));
} finally { home.dispose(); }
const privateBin = join(stateRoot(${JSON.stringify(repository)}), "bin");
mkdirSync(privateBin, { recursive: true });
const retainedRoot = join(privateBin, "retained-native");
const owner = "a".repeat(64);
const isolatedSource = { HOME: join(privateBin, "operator"), PATH: process.env.PATH };
mkdirSync(isolatedSource.HOME);
writeFileSync(join(isolatedSource.HOME, "config.toml"), "unapproved operator config");
const retainedHome = createCodexHome({ root: retainedRoot, owner, source: isolatedSource, config: "approved = true" });
const retainedConfig = join(retainedHome.env.CODEX_HOME, "config.toml");
assert.equal(readFileSync(retainedConfig, "utf8"), "approved = true");
retainedHome.dispose();
assert.equal(existsSync(retainedRoot), true);
assert.throws(() => createCodexHome({ root: retainedRoot, owner: "b".repeat(64), resume: true, source: isolatedSource, config: "unexpected" }), /recorded owner/);
assert.equal(readFileSync(retainedConfig, "utf8"), "approved = true");
assert.throws(() => createCodexHome({ root: retainedRoot, owner, source: isolatedSource, config: "unexpected" }));
assert.equal(existsSync(retainedRoot), true);
chmodSync(retainedHome.env.HOME, 0o755);
assert.throws(() => createCodexHome({ root: retainedRoot, owner, resume: true, source: isolatedSource, config: "unexpected" }), /private owned/);
chmodSync(retainedHome.env.HOME, 0o700);
const rebound = createCodexHome({ root: retainedRoot, owner, resume: true, source: isolatedSource, config: "updated = true", sandbox: { directory: process.cwd(), workspace: "read", network: false } });
assert.equal(rebound.env.CODEX_HOME, retainedHome.env.CODEX_HOME);
assert.equal(readFileSync(retainedConfig, "utf8").includes('updated = true'), true);
assert.equal(readFileSync(retainedConfig, "utf8").includes('"." = "read"'), true);
assert.equal(readFileSync(retainedConfig, "utf8").includes('unapproved operator config'), false);
assert.throws(() => rebound.nativeCaptureBoundary("00000000-0000-4000-8000-000000000000"), /authenticated turn boundary/);
const savedConfig = retainedConfig + ".saved";
renameSync(retainedConfig, savedConfig);
symlinkSync(join(isolatedSource.HOME, "config.toml"), retainedConfig);
assert.throws(() => createCodexHome({ root: retainedRoot, owner, resume: true, source: isolatedSource, config: "unexpected" }));
assert.equal(readFileSync(join(isolatedSource.HOME, "config.toml"), "utf8"), "unapproved operator config");
assert.equal(existsSync(retainedRoot), true);
unlinkSync(retainedConfig);
renameSync(savedConfig, retainedConfig);
rebound.dispose();
assert.equal(existsSync(retainedRoot), true);
releaseCodexHome(retainedRoot, owner);
assert.equal(existsSync(retainedRoot), false);
let failedSink;
observeModelInvocation({ invocationId: "real-filesystem-observer-failure", phase: "compile", ordinal: 0, observe: () => {
  failedSink = appendFile(privateBin, "private observer content");
  return failedSink;
} }, { type: "progress" });
await failedSink.catch(() => undefined);
await new Promise(resolve => setImmediate(resolve));
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
    assert.equal(result.stderr, "Factory model diagnostics unavailable\n");
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
    // The same production collector receives real child stderr split across
    // UTF-8 and secret boundaries. Its cap cuts a second diagnostic line;
    // that whole suffix is withheld before the existing private writer.
    const secret = "private-split-stderr-token";
    const stderrDiagnostics = new DiagnosticEmitter(repository, 2, [secret], {
      enabled: true,
      maxBytesPerInvocation: 1024,
    });
    const observeStderr = stderrDiagnostics.modelObserver({
      scopeId: "actual-local-stderr",
    });
    const stderrCapture = codexStderrCapture(
      (diagnostic) =>
        observeStderr({
          invocationId: "actual-child-stderr",
          providerAttempt: 1,
          phase: "result-review",
          ordinal: 0,
          type: "progress",
          adapter: "local-process",
          provider: "not-invoked",
          model: "none",
          capture: {
            event: {
              kind: "interaction",
              providerEvent: "local.stderr",
              coverage: "boundary",
            },
            content: () => diagnostic,
          },
        }),
      [secret],
    );
    let stderrChunks = 0;
    const childStderr = await subprocessAsync(
      process.execPath,
      [
        "-e",
        `const line = Buffer.from(${JSON.stringify("π 雪 " + secret + "\n")});
process.stderr.write(line.subarray(0, 1));
setTimeout(() => {
  process.stderr.write(line.subarray(1, 13));
  setTimeout(() => {
    process.stderr.write(line.subarray(13));
    process.stderr.write('x'.repeat(65536 - line.length - 5) + ${JSON.stringify(secret)} + '\\n');
  }, 20);
}, 20);`,
      ],
      {},
      undefined,
      (stream, chunk) => {
        if (stream === "stderr") {
          stderrChunks++;
          stderrCapture.chunk(chunk);
        }
      },
    );
    assert.equal(childStderr.status, 0);
    assert.ok(stderrChunks > 1);
    assert.equal(readDiagnostics(repository, 2).length, 0);
    stderrCapture.finish();
    stderrCapture.finish();
    const stderrRecords = readDiagnostics(repository, 2);
    assert.equal(stderrRecords.length, 1);
    assert.equal(stderrRecords[0].operation, "model-capture");
    const stderrMetadata = stderrRecords[0].capture;
    const capturedStderr = JSON.parse(
      readInteractionContent(repository, stderrMetadata.content.reference),
    );
    assert.equal(capturedStderr.text, "π 雪 [REDACTED]\n");
    assert.equal(capturedStderr.redacted, true);
    assert.equal(capturedStderr.truncated, true);
    assert.equal(capturedStderr.completeLinesOnly, true);
    assert.ok(capturedStderr.observedBytes > 65536);
    assert.ok(capturedStderr.retainedBytes < 65536);
    assert.equal(stderrMetadata.usage, undefined);
    assert.equal(stderrMetadata.nativeTool, undefined);
    assert.equal(JSON.stringify(stderrRecords).includes(secret), false);
    assert.equal(
      readInteractionContent(
        repository,
        stderrMetadata.content.reference,
      ).includes(secret),
      false,
    );
    const stderrAnalysis = analyzeInteractions([stderrMetadata]);
    assert.equal(stderrAnalysis.nativeToolActivity.uniqueCalls, null);
    assert.equal(JSON.stringify(stderrAnalysis).includes("[REDACTED]"), false);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation stops an owned shell and its process group", async () => {
  const controller = new AbortController();
  let pid;
  const result = step(
    {},
    { scope: "objective", name: "planning", paid: true },
    (context) =>
      context.paid(() =>
        withProcessCancellation(stepCancellationSignal(), () =>
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
        ),
      ),
    { save: () => undefined, signal: controller.signal },
  );
  await assert.rejects(result, (error) => error.fault?.kind === "cancelled");
  assert.ok(pid > 0);
  assert.equal(processGroupExists(pid), false);

  // A nested effect receives its owning step's cancel signal. A pause only
  // blocks the next effect: the already running real shell settles normally.
  const pause = new AbortController();
  const cancel = new AbortController();
  const state = {};
  let firstSettled = false;
  let nextStarted = false;
  await assert.rejects(
    step(
      state,
      { scope: "objective", name: "planning", paid: true },
      (context) =>
        context.paid(async () => {
          assert.equal(stepCancellationSignal(), cancel.signal);
          const settled = await subprocessAsync(
            "sh",
            ["-c", "echo started; sleep 0.1; echo settled"],
            { signal: stepCancellationSignal() },
            undefined,
            (stream) => {
              if (stream === "stdout") pause.abort();
            },
          );
          firstSettled =
            settled.status === 0 && settled.stdout.includes("settled");
          assertStepAdmission();
          nextStarted = true;
          await subprocessAsync("sh", ["-c", "echo forbidden"]);
        }),
      { save: () => undefined, signal: cancel.signal, pause: pause.signal },
    ),
    StepPaused,
  );
  assert.equal(firstSettled, true);
  assert.equal(nextStarted, false);
  assert.equal(state.repeats, undefined);
  assert.equal(stepCancellationSignal(), undefined);
  assert.doesNotThrow(assertStepAdmission);

  // Cancellation closure belongs to the owner after the aborted pass has
  // unwound. Calling the real gateway from this pass's aborted process scope
  // would refuse its closure GET before dispatch and retain a cancelError.
  const root = mkdtempSync(join(tmpdir(), "factory-cancel-pass-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    const git = (...args) =>
      execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "-b", "main");
    writeFileSync(join(checkout, "README.md"), "# Cancelled local target\n");
    git(
      "remote",
      "add",
      "origin",
      "https://github.com/integration/cancel-pass",
    );
    git("add", ".");
    git(
      "-c",
      "user.name=Integration",
      "-c",
      "user.email=integration@example.invalid",
      "commit",
      "-m",
      "base",
    );
    const config = {
      repository: "integration/cancel-pass",
      checkout,
      execution: { kind: "local" },
      policy: { allowedSecretNames: [] },
    };
    const baseSha = git("rev-parse", "HEAD");
    const graph = {
      objective: 1,
      baseSha,
      items: [
        {
          id: "local",
          kind: "work",
          title: "Local work",
          goal: "Preserve the target",
          brief: "Retain local work",
          acceptance: ["Preserve README"],
          nonGoals: [],
          dependencies: [],
          ownedPaths: ["README.md"],
          resources: [],
          expectedOutputRoles: [],
          requiredLfsRoles: [],
          sourceAssets: [],
          minimumAssetSets: 0,
          citations: [{ path: "README.md", heading: "" }],
          validation: [],
        },
      ],
      coverage: [
        {
          criterionId: createHash("sha256")
            .update("Preserve README")
            .digest("hex"),
          itemId: "local",
          source: {
            path: "README.md",
            digest: createHash("sha256")
              .update("# Cancelled local target\n")
              .digest("hex"),
            text: "# Cancelled local target",
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
    };
    const snapshot = {
      schemaVersion: 7,
      repository: config.repository,
      objective: 1,
      runId: "cancelled-real-pass",
      configDigest: factoryConfigDigest(config),
      baseSha,
      planGraphDigest: graphDigest(graph),
      graph,
      issueByItemId: { local: 2 },
      work: { local: { status: "failed" } },
      autonomy: resolveAutonomy({ allowances: { implementationRepairs: 0 } }),
      capacity: { concurrency: 1 },
      coordinator: {
        mode: "running",
        phase: "waiting",
        phaseStartedAt: new Date().toISOString(),
        processes: [],
      },
      cancelRequested: true,
    };
    saveState(statePath(config.repository, 1), snapshot);
    const contentStore = new LocalContentStore(join(root, "content"));
    const selection = { model: "gpt-6.1-sol", reasoningEffort: "medium" };
    const github = new RealGitHubGateway(
      config.repository,
      new NativeStackDelivery(config.repository),
    );
    const services = {
      github,
      contentStore,
      driver: new LocalExecutionDriver(
        checkout,
        join(root, "worktrees"),
        new CodexHarness(join(root, "credentials"), "off", selection),
        1,
        contentStore,
        "codex",
      ),
      planningModel: new CodexPlanningModel(checkout, selection, selection),
      delivery: new RegularDelivery(checkout, github),
    };
    const aborted = new AbortController();
    aborted.abort(new Error("Objective cancellation requested"));
    const owner = {
      snapshot,
      abort: aborted,
      pause: new AbortController(),
      changed: false,
      cancellation: Promise.resolve(),
    };
    const observations = [];
    await withGitHubTransportObserver(
      (observation) => observations.push(observation),
      () =>
        withProcessCancellation(aborted.signal, () =>
          assert.rejects(runObjectivePass(config, 1, services, owner)),
        ),
    );
    assert.deepEqual(observations, []);
    const loaded = readState(config.repository, 1);
    assert.equal(loaded.cancelRequested, true);
    assert.equal(loaded.coordinator.cancelError, undefined);
    assert.equal(loaded.cancelledAt, undefined);
    assert.equal(loaded.work.local.status, "failed");
    loaded.coordinator.cancelError = "Retained unresolved owned cancellation";
    saveState(statePath(config.repository, 1), loaded);
    owner.snapshot = loaded;
    await withProcessCancellation(aborted.signal, () =>
      assert.rejects(runObjectivePass(config, 1, services, owner)),
    );
    assert.equal(
      readState(config.repository, 1).coordinator.cancelError,
      "Retained unresolved owned cancellation",
    );
    assert.equal(readState(config.repository, 1).cancelledAt, undefined);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("collection settles an exited owned group before removing scratch", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-owned-exit-"));
  const harnessRoot = join(root, "harness");
  mkdirSync(harnessRoot);
  const requestPath = join(harnessRoot, "exited.request.json");
  const scratch = `${requestPath}.codex-home`;
  mkdirSync(scratch);
  const scope = {
    repository: "integration/owned-session",
    objective: 1,
    runId: "owned-exit",
    configDigest: "a".repeat(64),
    graphDigest: "b".repeat(64),
    role: "implementation",
    itemId: "local",
  };
  const session = {
    scope,
    adapter: "codex",
    identity: "retained-owned-exit",
    turn: 1,
    status: "in-flight",
  };
  const sessionRoot = join(harnessRoot, "sessions", session.identity);
  mkdirSync(join(harnessRoot, "sessions"));
  const owner = createHash("sha256")
    .update(
      JSON.stringify({
        scope,
        adapter: session.adapter,
        identity: session.identity,
      }),
    )
    .digest("hex");
  createCodexHome({ root: sessionRoot, owner, config: "" });
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
    assert.equal(existsSync(sessionRoot), true);
    const retainedSession = {
      ...session,
      data: {
        workerSettled: true,
        worker: {
          pid: child.pid,
          startTime: identity.startTime,
          requestPath,
          resultPath: join(harnessRoot, "exited.result.json"),
          logPath: join(harnessRoot, "exited.log"),
        },
      },
    };
    await assert.rejects(
      harness.releaseSession({
        ...retainedSession,
        scope: { ...scope, runId: "other-run" },
      }),
      /recorded owner/,
    );
    assert.equal(existsSync(sessionRoot), true);
    const pendingRequest = join(harnessRoot, "continuation.request.json");
    writeFileSync(pendingRequest, "{}\n");
    const pending = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", pendingRequest],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    try {
      assert.ok(linuxProcessIdentity(pending.pid));
      writeFileSync(join(harnessRoot, "continuation.pid"), `${pending.pid}\n`);
      const exited = once(pending, "exit");
      await harness.releaseSession({
        ...retainedSession,
        data: {
          ...retainedSession.data,
          pendingWorkerIdentity: "continuation",
        },
      });
      await exited;
      assert.equal(processGroupExists(pending.pid), false);
    } finally {
      if (processGroupExists(pending.pid))
        await killGroup(pending.pid, "integration continuation");
    }
    assert.equal(existsSync(sessionRoot), false);
    await harness.releaseSession(retainedSession);
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
    writeFileSync(
      join(checkout, "contract.md"),
      "# Context\n\nRésumé 🧭.\n\n# Documentation\n\nDocument the readiness marker.\n\n# Other\n\nRetain other requirements.\n",
    );
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
    const pinnedSources = planningSources(
      "## Sources\n- README.md\n- contract.md\n",
      commit,
      checkout,
    );
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
          citations: [
            { path: "README.md", heading: "" },
            { path: "contract.md", heading: "Documentation" },
          ],
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
    hydrateWorkerInputSources(graph, pinnedSources);
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
    // Passing commands do not prove this source criterion. The supported
    // exact-tree operator refusal produces semantic evidence, without a model
    // stub or turning the successful subprocess into a failed receipt.
    const criterion = "README documents the readiness marker";
    const semanticGraph = structuredClone(graph);
    semanticGraph.objective = 3;
    semanticGraph.items[0].acceptance = [criterion];
    const semanticState = {
      ...structuredClone(state),
      objective: 3,
      runId: "actual-local-semantic-refusal",
      graph: semanticGraph,
      planGraphDigest: graphDigest(semanticGraph),
      autonomy: resolveAutonomy({ allowances: { implementationRepairs: 1 } }),
      charges: {},
      work: {
        local: {
          status: "waiting",
          step: "approve-result",
          attempt: "semantic-candidate",
          baseSha: commit,
          executionBaseSha: commit,
          graphRevisionDigest: graphDigest(semanticGraph),
          changeRef: commit,
          treeSha,
          validation: structuredClone(evidence),
          acceptancePending: {
            criterion,
            treeSha,
            detail: "README omits the readiness marker",
            question: "Does README document the marker?",
          },
        },
      },
    };
    saveState(statePath(config.repository, 3), semanticState);
    decideResult(config, 3, {
      item: "local",
      actor: "integration-operator",
      outcome: "refuse",
      reason:
        "The exact README contains only an unchanged-candidate heading, not marker documentation.",
    });
    const refusedState = readState(config.repository, 3);
    const refusedWork = refusedState.work.local;
    const refusal = refusedWork.recovery.failure;
    assert.equal(refusal.semanticRefusal.source, "operator");
    assert.equal(refusal.semanticRefusal.treeSha, treeSha);
    assert.equal(
      refusal.semanticRefusal.decision.reason,
      refusedWork.acceptanceDecisions[0].reason,
    );
    assert.equal(refusedWork.failedValidation, undefined);
    assert.equal(refusedWork.validation.commands[0].exitCode, 0);
    const item = refusedState.graph.items[0];
    const supplied = repairEvidence(
      refusedState,
      item,
      diagnosisFiles(refusedState, item, checkout),
    );
    const fileIndex = supplied.findIndex(
      (entry) => entry.kind === "candidate-file" && entry.path === "README.md",
    );
    assert.equal(
      supplied[fileIndex].content,
      git("show", `${treeSha}:README.md`) + "\n",
    );
    // Inspect the actual producer and shared renderer over the retained Git
    // refusal, without generating a provider response or changing admission.
    const beforeDiagnosis = JSON.stringify(refusedState);
    const diagnosisRequest = workRepairDiagnosisRequest({
      state: refusedState,
      item,
      evidence: supplied,
      sources: pinnedSources,
    });
    const diagnosis = JSON.parse(
      diagnosisRequest.objective.slice(
        diagnosisRequest.objective.lastIndexOf("\n{") + 1,
      ),
    );
    assert.deepEqual(diagnosis.repairEvidence, supplied);
    assert.deepEqual(diagnosis.failure, refusal);
    assert.deepEqual(diagnosisRequest.sources, pinnedSources);
    assert.ok(
      diagnosisRequest.sources.every((source) => !("complete" in source)),
    );
    for (const [index, input] of diagnosis.item.inputSources.entries()) {
      assert.equal(input.content, undefined);
      const span = input.sourceSpan;
      const source = diagnosisRequest.sources[span.sourceIndex];
      const selected = source.content.slice(
        span.start,
        span.start + span.length,
      );
      assert.equal(source.path, input.path);
      assert.equal(selected, item.inputSources[index].content);
      assert.equal(
        createHash("sha256").update(source.content).digest("hex"),
        span.sourceDigest,
      );
      assert.equal(
        createHash("sha256").update(selected).digest("hex"),
        span.contentDigest,
      );
    }
    const section = diagnosis.item.inputSources.find(
      (input) => input.heading === "Documentation",
    );
    assert.ok(section.sourceSpan.start > 0);
    assert.ok(
      section.sourceSpan.length <
        pinnedSources[section.sourceSpan.sourceIndex].content.length,
    );
    assert.deepEqual(
      { ...diagnosis.item, inputSources: item.inputSources },
      item,
    );
    const renderedDiagnosis = renderDiagnosisCall(diagnosisRequest);
    assert.equal(renderedDiagnosis.schema, diagnosisRequest.schema);
    assert.ok(renderedDiagnosis.prompt.includes(JSON.stringify(supplied)));
    assert.ok(
      renderedDiagnosis.prompt.includes(
        `Pinned sources:\n${JSON.stringify(pinnedSources)}`,
      ),
    );
    assert.ok(
      renderedDiagnosis.prompt.includes(
        "Candidate-file contents and their ownership/completeness are supplied in repairEvidence, not pinned command authority.",
      ),
    );
    assert.deepEqual(
      JSON.parse(renderedDiagnosis.sourcePacket).sources,
      pinnedSources,
    );
    const unmatchedItem = structuredClone(item);
    unmatchedItem.inputSources[1].content += "An additional unavailable fact.";
    const unmatchedRequest = workRepairDiagnosisRequest({
      state: refusedState,
      item: unmatchedItem,
      evidence: supplied,
      sources: pinnedSources,
    });
    const unmatchedDiagnosis = JSON.parse(
      unmatchedRequest.objective.slice(
        unmatchedRequest.objective.lastIndexOf("\n{") + 1,
      ),
    );
    assert.deepEqual(
      unmatchedDiagnosis.item.inputSources[1],
      unmatchedItem.inputSources[1],
    );
    assert.equal(JSON.stringify(refusedState), beforeDiagnosis);
    // A declared correction exercises the shared admission gate over actual
    // workflow evidence; it is not a generated or scripted provider response.
    const declaration = {
      diagnosis:
        "The owned README omits the required readiness-marker documentation.",
      correction:
        "Document the readiness marker in README.md and rerun unchanged validation and acceptance.",
      decision: "repair",
      predecessor: "",
      path: "README.md",
      readiness: "actionable",
      prerequisites: [],
      question: "",
      evidenceIndices: [0, 1, fileIndex],
      commandAssessments: [],
    };
    const checkedReadiness = actionableReadiness(
      refusedState,
      item,
      declaration,
      supplied,
      checkout,
    );
    assert.equal(typeof checkedReadiness, "object");
    assert.equal(
      checkedReadiness.inputDigest,
      createHash("sha256").update(JSON.stringify(supplied)).digest("hex"),
    );
    const incomplete = structuredClone(supplied);
    incomplete[fileIndex].complete = false;
    assert.equal(
      typeof actionableReadiness(
        refusedState,
        item,
        declaration,
        incomplete,
        checkout,
      ),
      "string",
    );
    assert.equal(
      typeof actionableReadiness(
        refusedState,
        item,
        { ...declaration, evidenceIndices: [0, fileIndex] },
        supplied,
        checkout,
      ),
      "string",
    );
    const missingCommands = structuredClone(state);
    assert.equal(
      missingCommands.work.local.failedValidation.evidence.commands[0].exitCode,
      1,
    );
    const failedSupplied = repairEvidence(
      state,
      graph.items[0],
      diagnosisFiles(state, graph.items[0], checkout),
    );
    delete missingCommands.work.local.failedValidation;
    // Absence of a command capture must never choose the semantic branch.
    assert.equal(
      typeof actionableReadiness(
        missingCommands,
        graph.items[0],
        declaration,
        failedSupplied,
        checkout,
      ),
      "string",
    );
    const changedCommands = structuredClone(refusedState);
    changedCommands.work.local.validation.commands[0].exitCode = 1;
    assert.throws(
      () =>
        repairEvidence(
          changedCommands,
          item,
          diagnosisFiles(refusedState, item, checkout),
        ),
      /Semantic refusal/,
    );
    const correction = {
      kind: "implementation",
      actor: "factory-controller",
      failureDigest: refusal.digest,
      event: refusal.event,
      diagnosis: declaration.diagnosis,
      correction: declaration.correction,
      readiness: checkedReadiness,
    };
    chargeRepair(
      refusedState,
      refusal.event,
      "implementation",
      repairScopes(refusedState, "local"),
    );
    refusedWork.recovery.phase = "diagnosing";
    saveState(statePath(config.repository, 3), refusedState);
    const restartedRepair = readState(config.repository, 3);
    applyWorkCorrection(restartedRepair, "local", correction);
    saveState(statePath(config.repository, 3), restartedRepair);
    const repaired = readState(config.repository, 3);
    assert.equal(repaired.work.local.status, "pending");
    assert.equal(consumption(repaired).implementationRepairs, 1);
    assert.deepEqual(repaired.work.local.recovery.history[0].failure, refusal);
    assert.deepEqual(
      repaired.work.local.recovery.history[0].work.validation,
      evidence,
    );
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
    let item = {
      id: "implementation",
      kind: "work",
      title: "Implement result",
      goal: "Return required result",
      brief: "Implement result.cjs",
      acceptance: ["Result is 42"],
      nonGoals: ["No package or tooling changes"],
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
    const body = `## Outcome\nReturn the required result.\n\n## Acceptance\n- Result is 42\n- \`${acceptance}\`\n\n## Sources\n- README.md\n`;
    const request = prepareCompilationRequest({
      objective: 1,
      body,
      baseSha,
      checkout,
    });
    const { wire, call } = renderCompilationCall(request);
    const source = wire.data.sources.find(
      (entry) => entry.path === "README.md",
    );
    const citation = wire.data.citations.find(
      (entry) => entry.path === "README.md",
    );
    const generated = {
      contextId: wire.data.contextId,
      requiredPreIntegrationChecks: [],
      items: [
        {
          ...item,
          children: [],
          newPackages: [],
          priority: 0,
          citations: [{ choiceIndex: citation.choiceIndex }],
          validation: [setup, probe, acceptance].map((command) => ({
            kind: "source-line",
            sourceIndex: source.sourceIndex,
            lineIndex: source.lines.find((line) => line.text === command)
              .lineIndex,
          })),
        },
      ],
      coverage: request.coverageObligations.map((_, index) => ({
        itemId: item.id,
        proof:
          index === 0
            ? { kind: "final-review" }
            : { kind: "result-command", validationIndex: 2 },
        environment: {
          kind: "real",
          readiness: "available",
          probeValidationIndex: 1,
          prerequisiteValidationIndices: [0],
          preparedBy: "",
        },
      })),
    };
    assert.ok(call.prompt.includes("Same-owner source-authorized setup"));
    // The rejected relationship stays rejected; no decoder rewrites it into
    // available or fabricates a dependency. The authorized sequence is real.
    const invalid = structuredClone(generated);
    invalid.coverage[0].environment.readiness = "prepare";
    assert.throws(() => wire.decode(invalid), /actual preparation dependency/);
    invalid.coverage[0].environment.preparedBy = "unrelated";
    assert.throws(() => wire.decode(invalid), /actual preparation dependency/);
    const duplicated = structuredClone(generated);
    duplicated.coverage.push(structuredClone(generated.coverage[0]));
    assert.throws(
      () => wire.decode(duplicated),
      /one coverage entry per obligation/,
    );
    const graph = validateCompiledGraph({
      graph: wire.decode(generated),
      request,
      body,
      checkout,
    });
    item = graph.items[0];
    // Final semantic proof needs no extra QA item, but real final commands
    // and their readiness still run in their own fresh checkout.
    assert.equal(graph.items.length, 1);
    assert.equal(graph.coverage[0].itemId, item.id);
    assert.deepEqual(graph.coverage[0].proof, { kind: "final-review" });
    assert.deepEqual(
      graph.coverage.map((entry) => entry.source.text),
      ["Result is 42", `\`${acceptance}\``],
    );
    assert.ok(
      graph.coverage.every((entry) => entry.environment.kind === "real"),
    );
    assert.deepEqual(environmentValidationIndices(graph, item.id), [0, 1]);
    assert.deepEqual(objectivePreparationCommands(graph), [setup]);
    const diagnosticRepository = "integration/fresh-readiness";
    const diagnostics = new DiagnosticEmitter(diagnosticRepository, 1);
    const observerConfigDigest = createHash("sha256")
      .update("real-readiness-check")
      .digest("hex");
    await withDiagnosticSession(
      diagnostics,
      observerConfigDigest,
      () =>
        preflightItemEnvironment({
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
        }),
      () => "not-accepted",
    );
    const prospective = readDiagnostics(diagnosticRepository, 1);
    const expectedHistory = {
      repository: diagnosticRepository,
      objective: 1,
      configDigest: observerConfigDigest,
      observerSourceDigest: prospective[0].metadata.observerSourceDigest,
      sessionIds: [prospective[0].observerSessionId],
    };
    assert.equal(
      summarizeFormalHistory(prospective, expectedHistory).completeness,
      "complete",
    );
    assert.equal(
      summarizeFormalHistory(prospective, expectedHistory).hasFailedAttempt,
      false,
    );
    const observedState = {
      runId: "local-real",
      work: { [item.id]: { status: "pending" } },
    };
    await withDiagnosticSession(
      diagnostics,
      observerConfigDigest,
      async () => {
        const marker = join(root, "actual-child-finished");
        const child = spawn(
          process.execPath,
          [
            "-e",
            `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 150)`,
          ],
          { stdio: "ignore" },
        );
        const settled = once(child, "exit");
        try {
          await step(
            observedState,
            { scope: { item: item.id }, name: "observe-child" },
            async (ctx) => {
              if (!existsSync(marker))
                ctx.pending(undefined, new Date(Date.now() + 10).toISOString());
              return marker;
            },
            { save: () => undefined },
          );
          assert.equal((await settled)[0], 0);
        } finally {
          if (child.exitCode === null) {
            child.kill();
            await settled;
          }
        }
      },
      () => "not-accepted",
    );
    const pendingHistory = readDiagnostics(diagnosticRepository, 1).filter(
      (event) => event.observerSessionId !== prospective[0].observerSessionId,
    );
    assert.ok(
      pendingHistory.some(
        (event) => event.formalAttempt?.status === "pending-poll",
      ),
    );
    assert.equal(
      summarizeFormalHistory(pendingHistory, {
        ...expectedHistory,
        sessionIds: [pendingHistory[0].observerSessionId],
      }).hasFailedAttempt,
      false,
    );
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
      for (const entry of historicalGraph.coverage)
        entry.environment = {
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
      withDiagnosticSession(
        diagnostics,
        observerConfigDigest,
        () =>
          step(
            observedState,
            { scope: { item: item.id }, name: "validate" },
            () =>
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
            { save: () => undefined },
          ),
        () => "not-accepted",
      ),
      /result.cjs/,
    );
    assert.equal(observedState.repeats, undefined);
    const failedHistory = readDiagnostics(diagnosticRepository, 1);
    const failedSession = failedHistory.at(-1).observerSessionId;
    const failedSummary = summarizeFormalHistory(
      failedHistory.filter(
        (event) => event.observerSessionId === failedSession,
      ),
      { ...expectedHistory, sessionIds: [failedSession] },
    );
    assert.equal(failedSummary.completeness, "complete");
    assert.equal(failedSummary.hasFailedAttempt, true);
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
    // Passing real commands do not fabricate the missing independent
    // semantic assessment of the original Objective criterion.
    assert.throws(
      () =>
        assertCompletedCoverage({
          graph,
          finalValidation: { ...final, passed: true, criteria: [] },
        }),
      /Final acceptance coverage lacks its exact criterion proof/,
    );
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
    await withDiagnosticSession(
      diagnostics,
      observerConfigDigest,
      async () => {
        chmodSync(diagnosticPath(diagnosticRepository, 1), 0o644);
        try {
          diagnostics.emit({
            operation: "actual-file-permission-loss",
            outcome: "observed",
          });
        } finally {
          chmodSync(diagnosticPath(diagnosticRepository, 1), 0o600);
        }
        await diagnostics.span({ operation: "inspect-current-tree" }, () =>
          gitAsync(checkout, "rev-parse", "HEAD^{tree}"),
        );
      },
      () => "not-accepted",
    );
    const lossHistory = readDiagnostics(diagnosticRepository, 1);
    const lossSession = lossHistory.at(-1).observerSessionId;
    const lossSummary = summarizeFormalHistory(
      lossHistory.filter((event) => event.observerSessionId === lossSession),
      { ...expectedHistory, sessionIds: [lossSession] },
    );
    assert.equal(lossSummary.completeness, "unknown");
    assert.equal(lossHistory.at(-1).metadata.writeFailures, 1);
    assert.ok(lossSummary.reasons.includes("observation-sequence-gap"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
