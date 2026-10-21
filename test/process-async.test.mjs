import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAccountingRecords } from "../dist/accounting.js";
import { agentSessionContinuation } from "../dist/agent-session.js";
import { analyzeInteractions, renderAnalysis } from "../dist/analysis.js";
import { runAnalysisCommand } from "../dist/analysis-cli.js";
import { readInteractionContent } from "../dist/capture.js";
import { runCodexAppServer } from "../dist/codex-app-server.js";
import {
  codexBoundaryTelemetry,
  codexJsonBoundaries,
} from "../dist/codex-boundary-telemetry.js";
import { codexStderrCapture } from "../dist/codex-exec.js";
import {
  CODEX_PLANNING_CONFIG,
  createCodexHome,
} from "../dist/codex-planning-isolation.js";
import {
  CodexPlanningModel,
  renderCompilationCall,
  renderDiagnosisCall,
} from "../dist/compiler/model.js";
import {
  prepareCompilationRequest,
  validateCompiledGraph,
} from "../dist/compiler/planning.js";
import { compilePlan } from "../dist/compiler/recovery.js";
import {
  hydrateWorkerInputSources,
  planningSources,
} from "../dist/compiler/sources.js";
import {
  assertReviewImages,
  structuredRequestDigest,
} from "../dist/compiler/transport.js";
import { factoryConfigDigest, stateRoot } from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import { requestControl, serveControl } from "../dist/coordinator-control.js";
import { deliveryDescription } from "../dist/delivery/description.js";
import { NativeStackDelivery } from "../dist/delivery/native-stack.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import {
  DiagnosticEmitter,
  diagnosticPath,
  readDiagnostics,
  statusDocument,
  summarizeFormalHistory,
  withDiagnosticSession,
} from "../dist/diagnostics.js";
import { runDiagnosticsCommand } from "../dist/diagnostics-cli.js";
import {
  materializeWorkerSources,
  workItemPrompt,
} from "../dist/execution/harness-support.js";
import {
  CodexHarness,
  checkpointWorkerSession,
  LocalExecutionDriver,
} from "../dist/execution/local.js";
import { killGroup } from "../dist/execution/worker-process.js";
import { faultOf } from "../dist/fault.js";
import { RealGitHubGateway } from "../dist/github.js";
import { withGitHubTransportObserver } from "../dist/github-client.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { validateItem } from "../dist/item-steps.js";
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
  ProviderTurnElapsedTimeoutError,
  ProviderTurnGuard,
  ProviderTurnTimeoutError,
} from "../dist/provider-turn.js";
import {
  assertCompletedCoverage,
  environmentValidationIndices,
  finalReceiptsMatch,
  finalValidationSequence,
  objectivePreparationCommands,
  reusableEnvironmentValidationIndices,
} from "../dist/qa.js";
import { preflightItemEnvironment } from "../dist/qa-execution.js";
import {
  charge,
  chargeRepair,
  consumption,
  objectiveEvent,
  repairScopes,
  resolveAutonomy,
} from "../dist/repair-policy.js";
import {
  assertCommandReceipts,
  commandPassEvidence,
} from "../dist/result-evidence.js";
import { assertReviewArtifactSelectors } from "../dist/review-artifacts.js";
import { assertRetainedReviewEvidence } from "../dist/validation-evidence.js";
import {
  resolveReviewReferences,
  reviewPacket,
} from "../dist/review-evidence.js";
import {
  loadReviewArtifactObservations,
  loadReviewArtifacts,
  materializeReviewImages,
  reviewArtifactEvidence,
} from "../dist/review-image-evidence.js";
import {
  objectiveStepPause,
  runObjectivePass,
  workItemPauseSignal,
} from "../dist/runner/execution.js";
import {
  canHandoff,
  releaseCancelledSessions,
  synchronizeWorkItemPause,
} from "../dist/runner/ownership.js";
import { prepareObjective } from "../dist/runner/planning.js";
import {
  CoordinatorHandoff,
  cancelObjective,
  decideResult,
  rereviewWorkItem,
  retryWorkItem,
  runObjective,
} from "../dist/runner.js";
import {
  SemanticAcceptanceFailure,
  semanticRefusalDetail,
} from "../dist/semantic-refusal.js";
import { parseFactoryState, setCoordinatorMode } from "../dist/state.js";
import {
  acquireInstallationLock,
  acquireObjectiveLock,
  cancelledContinuationResourceHold,
  installationLockPath,
  objectiveLockPath,
  readContinuation,
  readState,
  releaseControllerLock,
  restoredContinuationOwnershipHold,
  saveState,
  statePath,
} from "../dist/state-store.js";
import {
  assertStepAdmission,
  StepPaused,
  step,
  stepCancellationSignal,
} from "../dist/step.js";
import { checkServiceState } from "../dist/supervision.js";
import {
  validateCheckout,
  validateTree,
  validateWorkItem,
} from "../dist/validation.js";
import {
  actionableReadiness,
  applyWorkCorrection,
  CandidateValidationFailure,
  diagnosisFiles,
  recordWorkFailure,
  repairEvidence,
  workRepairDiagnosisRequest,
} from "../dist/work-repair.js";
import {
  currentWorkerReadiness,
  workerReadinessReceipt,
} from "../dist/worker-readiness.js";

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
assert(transport.preparationDurationMs >= 0);
assert.equal(transport.requestDurationMs, undefined);
const { preparationDurationMs, ...untimed } = transport;
assert.deepEqual(untimed, { method: "POST", operation: "mutation", dispatch: "not-sent", outcome: "cancelled", category: "cancelled", status: null, timeout: null, cancellation: true, requestId: null });
assert.equal(Object.isFrozen(transport), true);
const retained = readFileSync(join(stateRoot(${JSON.stringify(repository)}), "objectives", "1", "diagnostics.ndjson"), "utf8");
assert.equal(retained.includes("private"), false);
assert.deepEqual(JSON.parse(retained.trim()).transport, transport);
const emitted = [];
const context = { repository: ${JSON.stringify(repository)}, objective: 1, invocationId: "actual-child-capture", providerAttempt: 1, phase: "integration", adapter: "local-process", configured: { provider: "not-invoked", model: "none" } };
const writer = new CaptureWriter(context, { enabled: true, maxBytesPerInvocation: 1024 }, [], metadata => emitted.push(metadata));
const { renderPrompt } = await import(${JSON.stringify(new URL("../dist/prompt-bytes.js", import.meta.url).href)});
const { prompt, sections } = renderPrompt([["instructions", "real child process "], ["objective", "capture π"]]);
writer.record({ kind: "request", promptComponents: { renderedPromptBytes: Buffer.byteLength(prompt), sections, exportedEvidenceFileBytes: Buffer.byteLength(readFileSync(new URL(${JSON.stringify(new URL("../dist/prompt-bytes.js", import.meta.url).href)}))), rolePreambleTaskSplit: "unavailable" } }, () => ({ text: "real child process capture" }));
for (const event of nativeEvents) writer.record(event);
const durable = new CaptureWriter({ ...context, invocationId: "actual-durable-capture" }, { enabled: true, retainInRecovery: true, maxBytesPerInvocation: 64 }, ["unshared-sensitive-token"], metadata => emitted.push(metadata));
durable.record({ kind: "response" }, () => ({ text: "secret: unshared-sensitive-token " + "雪".repeat(50) }));
let disabledRead = false;
const disabled = new CaptureWriter({ ...context, invocationId: "actual-disabled-capture" }, { enabled: false, retainInRecovery: true, maxBytesPerInvocation: 64 }, [], metadata => emitted.push(metadata));
disabled.record({ kind: "request" }, () => { disabledRead = true; return "Do not read disabled content"; });
assert.equal(disabledRead, false);
process.stdout.write(JSON.stringify(emitted));`,
      ],
      {
        cwd: workspace,
        env: sanitizedWorkerEnvironment(join(root, "credentials")),
      },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stderr, "Factory model diagnostics unavailable\n");
    const emitted = JSON.parse(result.stdout.toString());
    const [metadata, unavailableNative] = emitted;
    assert.equal(metadata.content.status, "captured");
    assert.equal(metadata.content.payloadRetention, "disabled");
    assert.equal(metadata.content.reference.payload, undefined);
    assert.deepEqual(
      JSON.parse(
        readInteractionContent(repository, metadata.content.reference),
      ),
      { text: "real child process capture" },
    );
    const durableCapture = emitted.find(
      (record) => record.invocationId === "actual-durable-capture",
    );
    const disabledCapture = emitted.find(
      (record) => record.invocationId === "actual-disabled-capture",
    );
    assert.equal(disabledCapture.content.status, "capture-disabled");
    assert.equal(disabledCapture.content.payloadRetention, "disabled");
    assert.equal(disabledCapture.content.reference, undefined);
    assert.equal(durableCapture.content.status, "captured");
    assert.equal(durableCapture.content.payloadRetention, "retained");
    assert.equal(durableCapture.content.redacted, true);
    assert.equal(durableCapture.content.truncated, true);
    assert.equal(
      durableCapture.content.reference.recordId,
      durableCapture.recordId,
    );
    const retainedText = readInteractionContent(
      repository,
      durableCapture.content.reference,
    );
    assert.equal(retainedText.includes("unshared-sensitive-token"), false);
    assert.equal(retainedText.includes("[REDACTED]"), true);
    assert.equal(retainedText.includes("\uFFFD"), false);
    assert.equal(
      durableCapture.content.retainedDigest,
      createHash("sha256").update(retainedText).digest("hex"),
    );
    assert.equal(
      durableCapture.content.reference.payload.digest,
      durableCapture.content.retainedDigest,
    );
    assert.equal(
      durableCapture.content.reference.payload.bytes,
      durableCapture.content.retainedBytes,
    );
    assert.equal(
      Buffer.byteLength(retainedText),
      durableCapture.content.retainedBytes,
    );
    assert.ok(durableCapture.content.retainedBytes <= 64);
    assert.ok(
      durableCapture.content.originalBytes >
        durableCapture.content.retainedBytes,
    );
    assert.notEqual(
      durableCapture.content.originalDigest,
      durableCapture.content.retainedDigest,
    );
    // A real private process capture is not a native model tool call:
    // analysis must neither expose its text nor invent counts.
    const analysis = analyzeInteractions([metadata]);
    assert.equal(
      analysis.requestBytes.renderedPromptBytes.total,
      Buffer.byteLength("real child process capture π"),
    );
    assert.equal(analysis.requestBytes.evidenceBytes.total, null);
    assert.equal(analysis.requestBytes.sections.coverage, "available");
    assert.equal(
      analysis.requestBytes.sections.totals.instructions,
      Buffer.byteLength("real child process "),
    );
    assert.equal(
      analysis.requestBytes.sections.totals.objective,
      Buffer.byteLength("capture π"),
    );
    assert.equal(
      analysis.requestBytes.exportedEvidenceFileBytes.total,
      Buffer.byteLength(
        readFileSync(new URL("../dist/prompt-bytes.js", import.meta.url)),
      ),
    );
    const legacyRequest = {
      ...metadata,
      promptComponents: { ...metadata.promptComponents, sections: undefined },
    };
    assert.equal(
      analyzeInteractions([legacyRequest]).requestBytes.sections.coverage,
      "unavailable",
    );
    const malformedRequest = {
      ...metadata,
      promptComponents: {
        ...metadata.promptComponents,
        sections: [
          {
            kind: "objective",
            startByte: 1,
            endByte: metadata.promptComponents.renderedPromptBytes,
          },
        ],
      },
    };
    assert.equal(
      analyzeInteractions([malformedRequest]).requestBytes.sections.coverage,
      "unavailable",
    );
    assert.equal(analysis.requestBytes.exactBilledRoleTokens, null);
    assert.equal(analysis.invocations[0].sessionTurnCoverage, "unavailable");
    assert.equal(
      analysis.sessionModes.find((mode) => mode.mode === "unknown")
        .invocationCount,
      1,
    );
    assert.equal(
      analysis.nativeFamilyResponseUsage.cache.allObservedInputTokens,
      null,
    );
    assert.equal(
      analysis.nativeFamilyResponseUsage.cache
        .knownCachedFractionOfAllObservedInput,
      null,
    );
    assert.equal(
      analysis.nativeFamilyResponseUsage.completeFamilyCoverage,
      "unknown",
    );
    assert.equal(analysis.nativeFamilyResponseUsage.paidOwnedChildSessions, 0);
    assert.equal(analysis.nativeToolActivity.uniqueCalls, null);
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
    assert.equal(cliAnalysis.invocationCount, 3);
    const originalInvocation = cliAnalysis.invocations.find(
      (invocation) =>
        invocation.identity.invocationId === "actual-child-capture",
    );
    assert.equal(cliAnalysis.nativeTools.calls, null);
    assert.equal(cliAnalysis.nativeTools.coverage, "unavailable");
    assert.equal(originalInvocation.native.tools.calls, null);
    assert.equal(originalInvocation.native.tools.observedOutputs, null);
    assert.equal(originalInvocation.native.descendants.accountingUnion, null);
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

    // Real child stdin/stderr and the production metadata writer: native-shaped
    // diagnostic records are test data, never a provider or an accepted answer.
    // The safe target's omitted fields must not reach either metadata or content.
    const boundaryDiagnostics = new DiagnosticEmitter(repository, 3, [secret], {
      enabled: false,
      maxBytesPerInvocation: 1024,
      nativeBoundaryTelemetry: true,
    });
    const boundaryObserver = boundaryDiagnostics.modelObserver({
      scopeId: "actual-client-boundaries",
    });
    assert.equal(boundaryObserver.nativeBoundaryTelemetry, true);
    assert.equal(
      new DiagnosticEmitter(repository, 4).modelObserver({
        scopeId: "disabled",
      }).nativeBoundaryTelemetry,
      false,
    );
    const boundaryStarted = performance.now();
    let firstBoundary;
    const sawLiveBoundary = new Promise((resolve) => {
      firstBoundary = resolve;
    });
    const observeBoundary = (source, boundary) => {
      boundaryObserver({
        invocationId: "actual-client-boundaries",
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
            coverage: "boundary",
            boundary: {
              ...boundary,
              source,
              elapsedMs: performance.now() - boundaryStarted,
            },
          },
        },
      });
      if (boundary.event === "first-output") firstBoundary();
    };
    let filteredDiagnostic;
    const ordinaryCapture = codexStderrCapture(
      (diagnostic) => {
        filteredDiagnostic = diagnostic;
        return boundaryObserver({
          invocationId: "actual-client-boundaries",
          providerAttempt: 1,
          phase: "result-review",
          ordinal: 0,
          type: "progress",
          capture: {
            event: { kind: "interaction", coverage: "boundary" },
            content: () => diagnostic,
          },
        });
      },
      [secret],
    );
    const boundaryParser = codexBoundaryTelemetry(
      (event) => observeBoundary("codex-trace-safe", event),
      ordinaryCapture.chunk,
    );
    const jsonBoundaries = codexJsonBoundaries((event) =>
      observeBoundary("codex-exec-json", event),
    );
    let unsupportedJsonSeen = false;
    const nativeDiagnosticLines = [
      '2026-10-10T05:59:46.827332Z INFO codex_otel.trace_safe: event.name="codex.websocket_request" duration_ms=3 success="true" auth.header_name="authorization" auth.account_id="excluded-account"',
      '2026-10-10T05:59:51.510209Z INFO codex_otel.trace_safe: event.name="codex.turn_ttft" duration_ms=5842',
      '2026-10-10T05:59:46.612150Z INFO codex_otel.trace_safe: event.name="codex.sse_event" event.kind=response.completed input_token_count=7660 output_token_count=0 cached_token_count=0 cache_write_token_count=0 reasoning_token_count=0 tool_token_count=7660 ttft_ms=37',
      '2026-10-10T05:59:52.510209Z TRACE codex_otel.trace_safe: event.name="codex.retry" retry.attempt=0 retry.delay_ms=200 retry.layer="http" retry.operation="request"',
      `2026-10-10T05:59:52.510209Z INFO codex_otel.trace_safe: event.name="unknown" error.message=${JSON.stringify(secret + ' event.name="codex.turn_ttft" duration_ms=9999')} auth.account_id="excluded-account"`,
      '2026-10-10T05:59:52.510209Z INFO codex_otel.trace_safe: event.name="codex.turn_ttft" duration_ms=unsafe',
    ];
    // Authentic pinned safe-target field shapes. Native tool_result carries
    // wrapper duration/identity/sizes, not the omitted argument/output bodies.
    const nativeToolResultLine =
      '2026-10-10T05:59:53.000000Z INFO codex_otel.trace_safe: event.name="codex.tool_result" tool_result_seq=7 tool_name="exec" tool_namespace="functions" call_id="call_preserved_native_tool" duration_ms=220 success="true" output_truncated=false arguments_length=582 output_length=24579 output_line_count=32 tool_origin="builtin" event.timestamp="2026-10-10T05:59:53.000Z" conversation.id="01a1382e-ff76-72f3-827a-e8fa81a1c338" app.version="0.160.0"';
    // The 320 ms quiet guard starts at a same-stderr-stream receipt written
    // after the finite 400-record burst, once the production parser has consumed
    // the preceding bytes. Starting it before the spawn let CI load cancel the
    // child while records were still in the pipe. A finite bound covers a
    // child that never reaches the receipt.
    const receiptMarker = "finite_burst_receipt=true\n";
    const telemetryAbort = new AbortController();
    let receiptTail = "";
    let burstDrained;
    let preparationTimer;
    const burstReceipt = new Promise((resolve, reject) => {
      burstDrained = resolve;
      preparationTimer = setTimeout(() => {
        telemetryAbort.abort();
        reject(new Error("finite telemetry burst receipt was not observed"));
      }, 30_000);
    });
    let quiet;
    let childClosed = false;
    const telemetryChild = subprocessAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      setTimeout(() => process.stdin.resume(), 25);
      const lines = ${JSON.stringify(nativeDiagnosticLines)};
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', id: 'legacy-shaped-item' } }) + '\\n');
      const ordinary = Buffer.from(${JSON.stringify("ordinary π " + secret + "\n")});
      process.stderr.write(ordinary.subarray(0, 10));
      setTimeout(() => {
        process.stderr.write(ordinary.subarray(10));
        for (const line of lines) process.stderr.write(line + '\\n');
        process.stderr.write('private multiline continuation excluded-account\\n');
      }, 15);
      setTimeout(() => process.stderr.write('INFO codex_otel.trace_safe: event.name="unknown" error.message="' + 'x'.repeat(70000) + '"\\n'), 60);
      setTimeout(() => {
        // Unknown noisy lines and a previous oversized line cannot suppress
        // later valid metadata. No raw trace or bodies may reach the writer.
        for (let i = 0; i < 160; i++) process.stderr.write('INFO codex_otel.trace_safe: event.name="unknown" padding="' + 'x'.repeat(512) + '"\\n');
        process.stderr.write(${JSON.stringify(nativeToolResultLine)} + '\\n');
        process.stderr.write(lines[2] + '\\n');
      }, 80);
      setTimeout(() => {
        const tool = ${JSON.stringify(nativeToolResultLine)};
        for (let i = 0; i < 400; i++) process.stderr.write(tool.replace('tool_result_seq=7', 'tool_result_seq=' + (i + 8)).replace('call_preserved_native_tool', 'call_bounded_native_' + i) + '\\n');
        // Aggregate observation counts survive exhausted projected detail.
        process.stderr.write(lines[2] + ' finite_burst_receipt=true\\n');
      }, 120);
      setInterval(() => process.stderr.write(lines[1] + '\\n'), 25);
    `,
      ],
      { signal: telemetryAbort.signal },
      "x".repeat(256 * 1024),
      (stream, chunk) => {
        if (stream === "stderr") {
          boundaryParser.chunk(chunk);
          const seen = receiptTail + chunk.toString("latin1");
          if (seen.includes(receiptMarker)) burstDrained();
          receiptTail = seen.slice(-receiptMarker.length);
        }
        if (stream === "stdout") {
          jsonBoundaries(JSON.parse(chunk.toString()));
          unsupportedJsonSeen = true;
        }
      },
      (boundary) => observeBoundary("factory-process", boundary),
      { stderr: false },
    );
    const settledTelemetry = telemetryChild.finally(() => {
      childClosed = true;
    });
    // Install rejection handlers before waiting for a live receipt.
    const boundedTelemetry = assert.rejects(
      burstReceipt.then(() => {
        clearTimeout(preparationTimer);
        quiet = new ProviderTurnGuard(320);
        quiet.signal.addEventListener("abort", () => telemetryAbort.abort(), {
          once: true,
        });
        return quiet.race(settledTelemetry);
      }),
      ProviderTurnTimeoutError,
    );
    const closedTelemetry = assert.rejects(
      settledTelemetry,
      /cancelled after verified cessation/,
    );
    await sawLiveBoundary;
    assert.equal(childClosed, false);
    const liveRecords = readDiagnostics(repository, 3).filter(
      (event) => event.capture?.boundary,
    );
    assert.ok(
      liveRecords.some(
        (event) => event.capture.boundary.event === "first-output",
      ),
    );
    await boundedTelemetry;
    await closedTelemetry;
    assert.equal(unsupportedJsonSeen, true);
    quiet.finish();
    boundaryParser.finish();
    ordinaryCapture.finish();
    const boundaryRecords = readDiagnostics(repository, 3)
      .filter((event) => event.capture)
      .map((event) => event.capture);
    const boundaryView =
      analyzeInteractions(boundaryRecords).invocations[0].boundaryObservations;
    assert.ok(
      boundaryView.some(
        (event) =>
          event.event === "stdin-finished" &&
          event.observedBytes === 256 * 1024,
      ),
    );
    assert.ok(
      boundaryView.some(
        (event) => event.event === "cessation" && event.status === "verified",
      ),
    );
    assert.ok(
      boundaryView.some(
        (event) =>
          event.event === "transport-completed" && event.durationMs === 3,
      ),
    );
    assert.ok(
      boundaryView.some(
        (event) =>
          event.event === "retry" &&
          event.nativeAttempt === 0 &&
          event.retryLayer === "http",
      ),
    );
    assert.ok(
      boundaryView.some(
        (event) =>
          event.event === "response-completed" &&
          event.responseCounters.inputTokens === 7660 &&
          event.responseCounters.ttftMs === 37,
      ),
    );
    const coverage = boundaryView.find(
      (event) =>
        event.event === "telemetry-coverage" &&
        event.source === "codex-trace-safe",
    );
    assert.equal(coverage.status, "incomplete");
    assert.ok(coverage.unparsedRecords >= 2);
    assert.ok(coverage.truncatedRecords > 0);
    assert.ok(coverage.quarantinedRecords > 0);
    assert.equal(coverage.submission, "unsupported");
    assert.equal(coverage.toolResultRecords, 401);
    assert.equal(coverage.responseCompletedRecords, 3);
    assert.equal(coverage.zeroOutputResponseCompletedRecords, 3);
    assert.ok(coverage.detailDroppedRecords > 0);
    assert.ok(coverage.projectedBytes <= 64 * 1024);
    const nativeToolResult = boundaryView.find(
      (event) => event.event === "tool-result",
    );
    assert.equal(nativeToolResult.toolCallId, "call_preserved_native_tool");
    assert.equal(nativeToolResult.nativeToolResultSequence, 7);
    assert.equal(nativeToolResult.toolName, "exec");
    assert.equal(nativeToolResult.toolNamespace, "functions");
    assert.equal(nativeToolResult.toolOrigin, "builtin");
    assert.equal(nativeToolResult.durationMs, 220);
    assert.equal(nativeToolResult.argumentBytes, 582);
    assert.equal(nativeToolResult.outputBytes, 24579);
    assert.equal(nativeToolResult.outputLines, 32);
    assert.equal(nativeToolResult.outputPreviewTruncated, false);
    assert.equal(nativeToolResult.nativeAt, "2026-10-10T05:59:53.000Z");
    assert.equal(
      nativeToolResult.nativeThreadId,
      "01a1382e-ff76-72f3-827a-e8fa81a1c338",
    );
    const durableBoundaries = readAccountingRecords(repository, 3)
      .filter(
        (record) => record.kind === "interaction" && record.capture.boundary,
      )
      .map((record) => record.capture.boundary);
    assert.deepEqual(
      durableBoundaries.find((event) => event.event === "tool-result"),
      boundaryRecords.find((record) => record.boundary?.event === "tool-result")
        .boundary,
    );
    assert.deepEqual(
      durableBoundaries.find(
        (event) =>
          event.event === "telemetry-coverage" &&
          event.source === "codex-trace-safe",
      ),
      boundaryRecords.find(
        (record) =>
          record.boundary?.event === "telemetry-coverage" &&
          record.boundary.source === "codex-trace-safe",
      ).boundary,
    );
    const boundaryText = renderAnalysis(analyzeInteractions(boundaryRecords));
    assert.ok(
      boundaryText.includes("native timestamp 2026-10-10T05:59:53.000Z"),
    );
    assert.ok(boundaryText.includes("call call_preserved_native_tool"));
    assert.ok(boundaryText.includes("supplied response TTFT 37 ms"));
    assert.ok(boundaryText.includes("tool results 401"));
    assert.equal(
      boundaryView.some((event) => event.durationMs === 9999),
      false,
    );
    assert.equal(JSON.stringify(boundaryRecords).includes(secret), false);
    assert.equal(
      JSON.stringify(boundaryRecords).includes("excluded-account"),
      false,
    );
    assert.equal(
      JSON.stringify(boundaryRecords).includes("error.message"),
      false,
    );
    assert.equal(
      JSON.stringify(boundaryRecords).includes("authorization"),
      false,
    );
    assert.equal(
      boundaryRecords.every((record) => !record.content.reference),
      true,
    );
    assert.ok(filteredDiagnostic.text.includes("ordinary π "));
    assert.ok(filteredDiagnostic.text.includes("[REDACTED]"));
    assert.equal(
      filteredDiagnostic.text.includes("codex_otel.trace_safe"),
      false,
    );
    assert.equal(filteredDiagnostic.text.includes("excluded-account"), false);
    assert.equal(filteredDiagnostic.text.includes(secret), false);
    assert.equal(filteredDiagnostic.text.includes("error.message"), false);
    assert.equal(
      filteredDiagnostic.text.includes("private multiline continuation"),
      false,
    );
    assert.equal(
      analyzeInteractions(boundaryRecords).usage.inputTokens.total,
      null,
    );
    let drainedStderrBytes = 0;
    const noRawStderr = await subprocessAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "process.stderr.write('x'.repeat(128 * 1024)); process.stdout.write('drained');",
      ],
      {},
      undefined,
      (stream, chunk) => {
        if (stream === "stderr") drainedStderrBytes += chunk.length;
      },
      () => {
        throw new Error("local observer rejected");
      },
      { stderr: false },
    );
    assert.equal(noRawStderr.status, 0);
    assert.equal(noRawStderr.stdout, "drained");
    assert.equal(noRawStderr.stderr, "");
    assert.equal(drainedStderrBytes, 128 * 1024);

    // Real bidirectional stdin: the second write waits for observed stdout.
    // Protocol input and output stay transient, with ordinary owned closure.
    const interactiveOwners = [];
    const observeInteractiveOwner = (owner, settled) => {
      interactiveOwners.push({ ...owner, settled });
    };
    let echoed = "";
    let receivedFirst;
    const firstEcho = new Promise((resolve) => {
      receivedFirst = resolve;
    });
    const completedDeadline = Date.now() + 1_500;
    const completedTurn = new ProviderTurnGuard(
      1_000,
      undefined,
      new Date(completedDeadline).toISOString(),
    );
    const interactive = await completedTurn.race(
      withProcessCancellation(
        undefined,
        () =>
          subprocessAsync(
            "/usr/bin/cat",
            [],
            { signal: completedTurn.signal },
            {
              run: async (channel) => {
                await channel.write("first π\n");
                await firstEcho;
                await channel.write("second\n");
                channel.end();
              },
            },
            (stream, chunk) => {
              if (stream === "stdout") {
                completedTurn.progress("cat-echo");
                echoed += chunk;
                if (echoed.includes("first π\n")) receivedFirst();
              }
            },
            undefined,
            { stdout: false, stderr: false },
          ),
        observeInteractiveOwner,
      ),
    );
    completedTurn.finish();
    assert.equal(interactive.status, 0);
    assert.equal(interactive.stdout, "");
    assert.equal(echoed, "first π\nsecond\n");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, completedDeadline - Date.now()) + 100),
    );
    assert.equal(completedTurn.signal.aborted, false);
    assert.equal(
      await completedTurn.race(Promise.resolve(interactive)),
      interactive,
    );

    // Actual echo traffic keeps the inactivity window open but cannot move the
    // separately admitted deadline. No native provider or scripted answer runs.
    const idleWindow = 1_000;
    const activeStarted = Date.now();
    const activeDeadline = new Date(activeStarted + 3_000).toISOString();
    const activeTurn = new ProviderTurnGuard(
      idleWindow,
      undefined,
      activeDeadline,
    );
    let inputChannel;
    let interruptionRequested = false;
    let alivePastIdleWindow = false;
    let echoReceipts = 0;
    const activeInteractive = withProcessCancellation(
      undefined,
      () =>
        subprocessAsync(
          "/usr/bin/cat",
          [],
          { signal: activeTurn.signal },
          {
            cancellationGraceMs: 250,
            cancel: () => {
              interruptionRequested = true;
              inputChannel.end();
            },
            run: async (channel) => {
              inputChannel = channel;
              for (
                let writes = 0;
                writes < 80 && !activeTurn.signal.aborted;
                writes++
              ) {
                await channel.write("active echo\n");
                await Promise.race([
                  channel.closed,
                  new Promise((resolve) => setTimeout(resolve, 50)),
                ]);
              }
              await channel.closed;
            },
          },
          (stream) => {
            if (stream !== "stdout") return;
            echoReceipts++;
            // An echo already in flight can arrive after the turn ends; only
            // the elapsed deadline, never inactivity, may have ended it.
            if (activeTurn.signal.aborted) {
              assert.ok(
                activeTurn.signal.reason instanceof
                  ProviderTurnElapsedTimeoutError,
              );
              return;
            }
            activeTurn.progress("cat-echo");
            if (Date.now() - activeStarted > idleWindow) {
              const owner = interactiveOwners.findLast(
                (entry) => !entry.settled,
              );
              assert.ok(owner);
              assert.equal(processGroupExists(owner.pid), true);
              alivePastIdleWindow = true;
            }
          },
        ),
      observeInteractiveOwner,
    );
    const elapsedTimeout = assert.rejects(
      activeTurn.race(activeInteractive),
      (error) => {
        assert.ok(error instanceof ProviderTurnElapsedTimeoutError);
        assert.ok(error instanceof ProviderTurnTimeoutError);
        assert.equal(error.deadlineAt, activeDeadline);
        assert.equal(error.lastOperation, "cat-echo");
        assert.ok(error.inactivityMs < idleWindow);
        return true;
      },
    );
    // Attach the owned-process rejection handler before either timer can fire.
    const activeClosed = assert.rejects(
      activeInteractive,
      /cancelled after verified cessation/,
    );
    await elapsedTimeout;
    await activeClosed;
    activeTurn.finish();
    assert.equal(alivePastIdleWindow, true);
    assert.ok(echoReceipts > 1);
    assert.equal(interruptionRequested, true);
    assert.equal(interactiveOwners.filter((owner) => !owner.settled).length, 2);
    assert.equal(interactiveOwners.filter((owner) => owner.settled).length, 2);
    for (const owner of interactiveOwners.filter((owner) => owner.settled))
      assert.equal(processGroupExists(owner.pid), false);
    // Recovery uses the exact retained payload, independently of disposable local captures.
    rmSync(captures, { recursive: true });
    assert.equal(
      readInteractionContent(repository, durableCapture.content.reference),
      retainedText,
    );
    assert.throws(
      () => readInteractionContent(repository, metadata.content.reference),
      /Captured interaction|ENOENT/,
    );
    const payload = durableCapture.content.reference.payload;
    writeFileSync(
      join(
        stateRoot(repository),
        "content",
        payload.digest.slice(0, 2),
        payload.digest,
      ),
      "corrupt retained capture",
    );
    assert.throws(
      () =>
        readInteractionContent(repository, durableCapture.content.reference),
      /digest verification/,
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
    const changedConfig = {
      ...config,
      execution: { ...config.execution, concurrency: 2 },
    };
    assert.notEqual(
      factoryConfigDigest(changedConfig),
      factoryConfigDigest(config),
    );
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
      publicationContract: "exact-request-v1",
      objectiveCommands: [],
      objectiveBodyDigest: "b".repeat(64),
      approvedPlaybookPin: null,
      approvedPlaybookAdmission: {
        approvedPlaybookPin: null,
        configDigest: factoryConfigDigest(config),
        graphDigest: graphDigest(graph),
        packetDigest: "c".repeat(64),
        reviewDigest: "d".repeat(64),
        sourcePacketDigest: "e".repeat(64),
      },
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
      workPause: new AbortController(),
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

    // Actual pre-dispatch Codex receipts and owned homes exercise preparation
    // cancellation without native inference, GitHub calls or invented terminals.
    const planningModel = new CodexPlanningModel(
      checkout,
      selection,
      selection,
      undefined,
      { sessionRoot: join(root, "planning-sessions") },
    );
    // Scoped as each Objective's model is: no approved advice selected.
    planningModel.approvedPlaybookPin = null;
    const preparationServices = { ...services, planningModel };
    await withGitHubTransportObserver(
      (observation) => observations.push(observation),
      async () => {
        for (const route of [
          "direct",
          "controller",
          "diagnosis",
          "planning-empty",
        ]) {
          const preparation = {
            schemaVersion: 8,
            kind: "preparing",
            approvedPlaybookPin: null,
            repository: config.repository,
            objective: 1,
            runId: randomUUID(),
            configDigest: factoryConfigDigest(config),
            baseSha,
            objectiveBodyDigest: createHash("sha256")
              .update("Objective")
              .digest("hex"),
            sourcePacketDigest: createHash("sha256")
              .update("Source")
              .digest("hex"),
            issueByItemId: {},
            autonomy: snapshot.autonomy,
            capacity: snapshot.capacity,
            coordinator: {
              mode: "paused",
              phase: "planning",
              phaseStartedAt: new Date().toISOString(),
              processes: [],
            },
          };
          if (route === "diagnosis") {
            // A stopped pending execution can retain an unknown diagnosis
            // without any invented native completion. The same real atomic
            // scope and adapter-owned home must be disposed by ordinary cancel.
            delete preparation.kind;
            preparation.schemaVersion = 7;
            preparation.graph = structuredClone(snapshot.graph);
            preparation.planGraphDigest = snapshot.planGraphDigest;
            preparation.approvedPlaybookAdmission = structuredClone(
              snapshot.approvedPlaybookAdmission,
            );
            preparation.publicationContract = snapshot.publicationContract;
            preparation.objectiveCommands = snapshot.objectiveCommands;
            preparation.issueByItemId = snapshot.issueByItemId;
            preparation.work = {
              local: {
                status: "pending",
                recovery: {
                  diagnosisInvocation: {
                    id: randomUUID(),
                    submitted: true,
                    requestDigest: "a".repeat(64),
                  },
                },
              },
            };
          }
          const savePreparation = () =>
            saveState(statePath(config.repository, 1), preparation);
          savePreparation();
          const preparingOriginal = readFileSync(
            statePath(config.repository, 1),
          );
          assert.throws(
            () =>
              checkServiceState(changedConfig, 1, join(root, "config.json")),
            /different configuration binding/,
          );
          assert.deepEqual(
            readFileSync(statePath(config.repository, 1)),
            preparingOriginal,
          );
          if (route === "controller") {
            // The real intake socket can receive handoff while registration is
            // still awaiting startup. Replay it to the stock Objective handler
            // before its next pass; no planner or gateway response is invented.
            preparation.coordinator.mode = "running";
            savePreparation();
            const original = structuredClone(preparation);
            const lock = acquireInstallationLock(config.repository, 1);
            let server;
            let objectiveControl;
            let pendingHandoff = false;
            let registrationEntered;
            const entered = new Promise((resolve) => {
              registrationEntered = resolve;
            });
            let releaseRegistration;
            const held = new Promise((resolve) => {
              releaseRegistration = resolve;
            });
            let running;
            let controlShell;
            let continuedAfterDeadline = false;
            try {
              server = await serveControl(
                config.repository,
                lock,
                async (request, context) => {
                  assert.equal(request.objective, 1);
                  if (request.action === "status")
                    return readContinuation(config.repository, 1).coordinator;
                  if (request.action === "pause") {
                    context.acknowledge({
                      kind: "local-cessation-acknowledgment",
                      newDispatch: "held",
                      admittedWork: "retained",
                      projectSynchronization: "pending",
                    });
                    // Exercise the real IPC cancellation scope with an owned
                    // subprocess, without a remote/provider stand-in.
                    await subprocessAsync(
                      "sh",
                      ["-c", "echo $$; sleep 120"],
                      {},
                      undefined,
                      (stream, chunk) => {
                        if (stream === "stdout")
                          controlShell = Number(chunk.toString().trim());
                      },
                    );
                    continuedAfterDeadline = true;
                    return "completed";
                  }
                  assert.equal(request.action, "handoff");
                  pendingHandoff = true;
                  if (objectiveControl) await objectiveControl(request);
                  return "requested";
                },
              );
              running = runObjective(config, 1, preparationServices, {
                ownerLock: lock,
                observeControl: async (handler) => {
                  if (!handler) {
                    objectiveControl = undefined;
                    return;
                  }
                  registrationEntered();
                  await held;
                  objectiveControl = handler;
                  if (pendingHandoff)
                    await handler({ objective: 1, action: "handoff" });
                },
              }).then(
                () => assert.fail("A handed-off Objective cannot complete"),
                (error) => error,
              );
              await entered;
              const expiredRequestId = randomUUID();
              const expiredAt = Date.now() - 1;
              await assert.rejects(
                () =>
                  requestControl(
                    config.repository,
                    {
                      objective: 1,
                      action: "pause",
                      command: { id: expiredRequestId, deadlineAt: expiredAt },
                    },
                    { deadlineAt: expiredAt },
                  ),
                (error) =>
                  error.requestId === expiredRequestId &&
                  error.submission === "not-sent",
              );
              assert.equal(controlShell, undefined);
              const requestId = randomUUID();
              const client = spawn(
                process.execPath,
                [
                  "--input-type=module",
                  "-e",
                  `
import { requestControl } from ${JSON.stringify(new URL("../dist/coordinator-control.js", import.meta.url).href)};
const deadlineAt = Date.now() + 1500;
try {
  await requestControl(${JSON.stringify(config.repository)}, { objective: 1, action: 'pause', command: { id: ${JSON.stringify(requestId)}, deadlineAt } }, { deadlineAt, onAcknowledgment(value) { console.log(JSON.stringify({ acknowledgment: value })); } });
  process.exitCode = 9;
} catch (error) {
  console.log(JSON.stringify({ incomplete: { requestId: error.requestId, submission: error.submission } }));
  process.exitCode = error.submission === 'unknown' ? 0 : 8;
}
`,
                ],
                { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
              );
              const clientExit = once(client, "close");
              let clientOutput = "";
              let acknowledge;
              const acknowledged = new Promise((resolve) => {
                acknowledge = resolve;
              });
              client.stdout.on("data", (chunk) => {
                clientOutput += chunk.toString();
                if (clientOutput.includes('"acknowledgment"')) acknowledge();
              });
              await Promise.race([
                acknowledged,
                clientExit.then(() => {
                  throw new Error(
                    `Control client exited before acknowledgment: ${clientOutput}`,
                  );
                }),
              ]);
              const statusStartedAt = Date.now();
              assert.equal(
                (
                  await requestControl(
                    config.repository,
                    { objective: 1, action: "status" },
                    { deadlineAt: Date.now() + 1000 },
                  )
                ).handled,
                true,
              );
              assert(
                Date.now() - statusStartedAt < 1000,
                "Status remains independent of the ongoing mutation",
              );
              assert.equal((await clientExit)[0], 0);
              const frames = clientOutput
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
              assert.equal(
                frames[0].acknowledgment.projectSynchronization,
                "pending",
              );
              assert.deepEqual(frames.at(-1).incomplete, {
                requestId,
                submission: "unknown",
              });
              const closureDeadline = Date.now() + 5000;
              while (
                controlShell &&
                processGroupExists(controlShell) &&
                Date.now() < closureDeadline
              )
                await new Promise((resolve) => setTimeout(resolve, 10));
              assert(controlShell > 0);
              assert.equal(processGroupExists(controlShell), false);
              assert.equal(continuedAfterDeadline, false);
              assert.equal(
                (
                  await requestControl(config.repository, {
                    objective: 1,
                    action: "handoff",
                  })
                ).handled,
                true,
              );
              assert.equal(objectiveControl, undefined);
              releaseRegistration();
              assert.ok((await running) instanceof CoordinatorHandoff);
              const handedOff = readContinuation(config.repository, 1);
              assert.equal(handedOff.coordinator.mode, "draining");
              assert.equal(handedOff.runId, original.runId);
              assert.equal(handedOff.baseSha, original.baseSha);
              assert.equal(
                handedOff.objectiveBodyDigest,
                original.objectiveBodyDigest,
              );
              assert.equal(
                handedOff.coordinator.deadlineAt,
                original.coordinator.deadlineAt,
              );
              assert.deepEqual(handedOff.autonomy, original.autonomy);
              assert.equal(handedOff.agentSessions, undefined);
              assert.deepEqual(observations, []);
              Object.assign(preparation, handedOff);
            } finally {
              releaseRegistration();
              if (running) await running;
              if (server)
                await new Promise((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                );
              releaseControllerLock(
                installationLockPath(config.repository),
                lock,
              );
            }
            preparation.coordinator.mode = "paused";
            savePreparation();
          }
          if (route === "planning-empty") {
            const originalGenerate =
              planningModel.generateStructured.bind(planningModel);
            const legacy = new Proxy(planningModel, {
              get(target, property) {
                if (property === "providerDispatchAdmission") return undefined;
                if (property === "generateStructured")
                  return async (request) => {
                    const admit = request.invocation.beforeProviderAttempt;
                    request.invocation.beforeProviderAttempt = async () => {
                      await admit?.();
                      writeFileSync(
                        join(root, "missing-phase-inputs", "compile.json"),
                        JSON.stringify(request.sources),
                        { mode: 0o600 },
                      );
                    };
                    return originalGenerate(request);
                  };
                return Reflect.get(target, property, target);
              },
            });
            const prepared = structuredClone(preparation);
            const guardedCurrent = new Proxy(legacy, {
              get(target, property) {
                if (property === "providerDispatchAdmission")
                  return planningModel.providerDispatchAdmission;
                return Reflect.get(target, property, target);
              },
            });
            await assert.rejects(
              compilePlan(
                1,
                "## Sources\n- README.md\n## Acceptance\n- Preserve the exact source.\n",
                snapshot.baseSha,
                checkout,
                guardedCurrent,
                factoryConfigDigest(config),
                undefined,
                undefined,
                {
                  state: prepared,
                  sessionState: prepared,
                  save: () =>
                    saveState(statePath(config.repository, 1), prepared),
                },
              ),
              /ENOENT/,
            );
            assert.equal(prepared.planningRecovery.phase, "ready");
            assert.equal(prepared.planningRecovery.invocations.length, 1);
            assert.equal(prepared.planningRecovery.response, undefined);
            assert.equal(
              prepared.planningRecovery.diagnosisResponse,
              undefined,
            );
            assert.equal(prepared.agentSessions, undefined);
            savePreparation();
            await assert.rejects(
              compilePlan(
                1,
                "## Sources\n- README.md\n## Acceptance\n- Preserve the exact source.\n",
                snapshot.baseSha,
                checkout,
                legacy,
                factoryConfigDigest(config),
                undefined,
                undefined,
                {
                  state: preparation,
                  sessionState: preparation,
                  save: savePreparation,
                },
              ),
              /ENOENT/,
            );
            assert.equal(preparation.planningRecovery.phase, "submitted");
            assert.equal(preparation.agentSessions, undefined);
            const originalPlanning = structuredClone(
              preparation.planningRecovery,
            );
            const uncovered = new Proxy(planningModel, {
              get(target, property) {
                if (property === "retainedPlannerCheckpointCoverage")
                  return undefined;
                return Reflect.get(target, property, target);
              },
            });
            await assert.rejects(
              cancelObjective(config, 1, services.driver, github, uncovered),
              /recognized native checkpoint producer/,
            );
            assert.equal(
              readContinuation(config.repository, 1).cancelledAt,
              undefined,
            );
            assert.equal(
              await cancelObjective(
                config,
                1,
                services.driver,
                github,
                planningModel,
              ),
              "cancelled",
            );
            const cancelled = readContinuation(config.repository, 1);
            const { cancelledResources, ...retainedPlanning } =
              cancelled.planningRecovery;
            assert.deepEqual(retainedPlanning, originalPlanning);
            assert.equal(
              cancelledResources.invocationId,
              originalPlanning.invocation.id,
            );
            assert.equal(
              cancelledContinuationResourceHold(cancelled),
              undefined,
            );
            assert.match(
              restoredContinuationOwnershipHold(cancelled),
              /Submitted planning/,
            );
            for (const change of [
              (value) => {
                delete value.planningRecovery.cancelledResources;
              },
              (value) => {
                value.planningRecovery.cancelledResources.invocationId =
                  randomUUID();
              },
              (value) => {
                value.planningRecovery.cancelledResources.scope.runId =
                  randomUUID();
              },
              (value) => {
                value.planningRecovery.cancelledResources.coverage.adapter =
                  "uncovered";
              },
              (value) => {
                value.planningRecovery.cancelledResources.phase =
                  "graph-review";
              },
              (value) => {
                value.planningRecovery.cancelledResources = null;
              },
            ]) {
              const refused = structuredClone(cancelled);
              change(refused);
              assert.throws(() => {
                const hold = cancelledContinuationResourceHold(refused);
                if (hold) throw new Error(hold);
              });
            }
            continue;
          }
          const session = agentSessionContinuation(
            preparation,
            "planning",
            undefined,
            savePreparation,
          );
          let stoppedReceipt;
          const nativeTurn = { response: "", ended: false };
          await assert.rejects(() =>
            planningModel.transport.run({
              role: "planner",
              prompt: "Do not dispatch this already cancelled turn",
              schema: { type: "object" },
              invocation: {
                invocationId: randomUUID(),
                phase: "compile",
                ordinal: 0,
              },
              turn: nativeTurn,
              signal: AbortSignal.abort(
                new Error("Stopped before native dispatch"),
              ),
              session: {
                ...session,
                checkpoint: (ref) => {
                  session.checkpoint(ref);
                  if (ref.status === "unavailable")
                    stoppedReceipt = structuredClone(ref);
                },
              },
            }),
          );
          assert.equal(nativeTurn.started, undefined);
          assert.equal(nativeTurn.usage, undefined);
          assert.equal(stoppedReceipt.currentTurn.dispatch, "intent");
          assert.equal(stoppedReceipt.currentTurn.terminal, undefined);
          assert.equal(stoppedReceipt.currentTurn.resources, "settled");
          const sessionKey = Object.keys(preparation.agentSessions)[0];
          const restoreOwnedHome = () => {
            // Restore the actual pre-disposal checkpoint for an atomic-save gap;
            // home ownership uses the adapter's exact immutable identity binding.
            preparation.agentSessions[sessionKey] =
              structuredClone(stoppedReceipt);
            createCodexHome({
              root: stoppedReceipt.data.sessionRoot,
              owner: createHash("sha256")
                .update(
                  JSON.stringify([
                    stoppedReceipt.scope,
                    stoppedReceipt.identity,
                    stoppedReceipt.adapter,
                    stoppedReceipt.data.selectionDigest,
                  ]),
                )
                .digest("hex"),
              config: CODEX_PLANNING_CONFIG,
            });
            savePreparation();
          };
          restoreOwnedHome();
          if (route === "diagnosis") {
            const pendingPlanningId = randomUUID();
            preparation.planningRecovery = {
              phase: "submitted",
              invocation: { id: pendingPlanningId, phase: "compile" },
              invocations: [{ id: pendingPlanningId, phase: "compile" }],
              history: [],
            };
            savePreparation();

            assert.equal(canHandoff(preparation), false);
            const originalIntent = structuredClone(
              preparation.work.local.recovery.diagnosisInvocation,
            );
            const lock = acquireObjectiveLock(config.repository, 1);
            try {
              preparation.cancelRequested = true;
              preparation.work.local.status = "cancelled";
              await assert.rejects(
                releaseCancelledSessions(
                  config,
                  preparation,
                  services.driver,
                  planningModel,
                  savePreparation,
                  lock,
                ),
                /current atomic scope/,
              );
              assert.equal(existsSync(stoppedReceipt.data.sessionRoot), true);
              // Normal cancel publishes these changes before calling the same
              // direct ownership producer, and preserves all unknown intent.
              savePreparation();
              await releaseCancelledSessions(
                config,
                preparation,
                services.driver,
                planningModel,
                savePreparation,
                lock,
              );
              preparation.cancelledAt = new Date().toISOString();
              savePreparation();
              assert.deepEqual(
                preparation.work.local.recovery.diagnosisInvocation,
                originalIntent,
              );
              assert.equal(
                cancelledContinuationResourceHold(preparation),
                undefined,
              );
              assert.match(
                restoredContinuationOwnershipHold(preparation),
                /Submitted work diagnosis|Submitted planning/,
              );
            } finally {
              releaseControllerLock(
                objectiveLockPath(config.repository, 1),
                lock,
              );
            }
          } else if (route === "direct") {
            await assert.rejects(
              () => cancelObjective(config, 1, services.driver, github),
              /requires its authenticated adapter/,
            );
            assert.equal(
              readContinuation(config.repository, 1).cancelledAt,
              undefined,
            );
            assert.equal(existsSync(stoppedReceipt.data.sessionRoot), true);
            assert.equal(
              await cancelObjective(
                config,
                1,
                services.driver,
                github,
                planningModel,
              ),
              "cancelled",
            );
          } else {
            preparation.cancelRequested = true;
            savePreparation();
            await assert.rejects(
              () => runObjective(config, 1, preparationServices),
              /Objective cancellation requested/,
            );
          }
          const cancelled = readContinuation(config.repository, 1);
          assert.ok(cancelled.cancelledAt);
          if (route === "diagnosis") {
            assert.equal(cancelled.work.local.status, "cancelled");
            assert.deepEqual(
              cancelled.work.local.recovery.diagnosisInvocation,
              preparation.work.local.recovery.diagnosisInvocation,
            );
            assert.equal(
              cancelled.work.local.recovery.diagnosisInvocation.response,
              undefined,
            );
            assert.equal(canHandoff(cancelled), false);
          }
          assert.equal(cancelled.agentSessions[sessionKey].status, "released");
          assert.deepEqual(
            cancelled.agentSessions[sessionKey].currentTurn,
            stoppedReceipt.currentTurn,
          );
          assert.deepEqual(cancelled.autonomy, snapshot.autonomy);
          assert.equal(existsSync(stoppedReceipt.data.sessionRoot), false);
          // The genuine cancelled continuation remains an immutable inspection
          // record under a new configuration; the runnable original above refused.
          const terminalOriginal = readFileSync(
            statePath(config.repository, 1),
          );
          if (route === "diagnosis")
            assert.throws(
              () =>
                checkServiceState(changedConfig, 1, join(root, "config.json")),
              /different configuration binding/,
            );
          else checkServiceState(changedConfig, 1, join(root, "config.json"));
          assert.deepEqual(
            readFileSync(statePath(config.repository, 1)),
            terminalOriginal,
          );
          assert.equal(cancelled.configDigest, factoryConfigDigest(config));
          if (route === "diagnosis") {
            assert.equal(cancelled.planningRecovery.phase, "submitted");
            assert.equal(cancelled.planningRecovery.response, undefined);
            assert.ok(cancelled.planningRecovery.cancelledResources);
            const active = structuredClone(cancelled);
            active.agentSessions[sessionKey].status = "in-flight";
            active.agentSessions[sessionKey].currentTurn.resources = "active";
            assert.throws(() => cancelledContinuationResourceHold(active));
            continue;
          }
          // Repeated cancellation also disposes a retained old terminal checkpoint.
          Object.assign(preparation, cancelled);
          restoreOwnedHome();
          assert.equal(
            await cancelObjective(
              config,
              1,
              services.driver,
              github,
              planningModel,
            ),
            "cancelled",
          );
          assert.equal(
            readContinuation(config.repository, 1).cancelledAt,
            cancelled.cancelledAt,
          );
          assert.equal(
            readContinuation(config.repository, 1).agentSessions[sessionKey]
              .status,
            "released",
          );
          assert.equal(existsSync(stoppedReceipt.data.sessionRoot), false);
        }
      },
    );
    assert.deepEqual(observations, []);
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
      executionIdentity: "exited",
      status: "ready",
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
    const retainedPath = join(root, "retained-session.json");
    writeFileSync(retainedPath, `${JSON.stringify(retainedSession)}\n`);
    const retainedBytes = readFileSync(retainedPath, "utf8");
    // The READY fixture is not provider acceptance. It carries the actual
    // exited worker's private ownership, whose disposal is exercised below.
    assert.equal(
      checkpointWorkerSession(
        { scope, identity: session.identity, retained: retainedSession },
        { adapter: "codex", supportsResume: false, executionIdentity: "fresh" },
        (ref) => writeFileSync(retainedPath, `${JSON.stringify(ref)}\n`),
      ),
      undefined,
    );
    assert.equal(readFileSync(retainedPath, "utf8"), retainedBytes);
    const driver = new LocalExecutionDriver(
      root,
      join(root, "work"),
      harness,
      1,
      new LocalContentStore(join(root, "content")),
      "codex",
    );
    await assert.rejects(
      driver.releaseSession({
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
      await driver.releaseSession({
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
    await driver.releaseSession(retainedSession);
  } finally {
    if (processGroupExists(child.pid))
      await killGroup(child.pid, "integration shell");
    rmSync(root, { recursive: true, force: true });
  }
});

test("settled validation reuses its exact Git result once and retains the failed capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-validation-rereview-"));
  // A read-only sandbox path lies outside every temporary directory: in the
  // repository's ignored `.factory`.
  const ignored = new URL("../.factory/", import.meta.url).pathname;
  mkdirSync(ignored, { recursive: true });
  const external = mkdtempSync(join(ignored, "external-"));
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
    const imageBytes = readFileSync(
      new URL(
        "./fixtures/disposable-target/assets/source.png",
        import.meta.url,
      ),
    );
    writeFileSync(join(checkout, ".gitignore"), ".runtime/\n");
    writeFileSync(
      join(checkout, "capture.cjs"),
      `
const fs = require("node:fs"), crypto = require("node:crypto");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const output = ".runtime/" + crypto.randomUUID();
fs.mkdirSync(output, {recursive:true});
const image = Buffer.from(${JSON.stringify(imageBytes.toString("base64"))}, "base64");
fs.writeFileSync(output + "/scene.png", image);
const receipt = Buffer.from(JSON.stringify({candidateSha256: process.argv[2] === "prerequisite" ? "0".repeat(64) : hash(fs.readFileSync("README.md")), imageSha256: hash(image)}));
fs.writeFileSync(output + "/receipt.json", receipt);
console.log(JSON.stringify({receipt: process.argv[2] === "escape" ? "../receipt.json" : output + "/receipt.json", sha256: process.argv[2] === "mismatch" ? "0".repeat(64) : hash(receipt)}));
`,
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
    // External host readiness the command can see only through the
    // operator's read-only sandbox allowance.
    const ready = join(external, "ready");
    const command = `${process.execPath} -e 'const ready = require("node:fs").existsSync(${JSON.stringify(ready)}); if (!ready) console.error("readiness marker missing"); process.exitCode = ready ? 0 : 1'`;
    const sandbox = {
      required: true,
      network: "off",
      readOnlyPaths: [external],
    };
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
    hydrateWorkerInputSources(graph, pinnedSources, checkout);
    const work = {
      status: "running",
      step: "validate",
      attempt: randomUUID(),
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
      objectiveCommands: [],
      objectiveBodyDigest: "b".repeat(64),
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
      issueByItemId: { local: 1 },
      configDigest: factoryConfigDigest(config),
      baseSha: commit,
      graph,
      work: { local: work },
      autonomy: resolveAutonomy({ allowances: { implementationRepairs: 0 } }),
    };
    const pause = new AbortController();
    pause.abort(new Error("Coordinator paused"));
    const owner = {
      snapshot: state,
      pause,
      workPause: new AbortController(),
    };
    state.coordinator = {
      mode: "paused",
      phase: "validate",
      phaseStartedAt: new Date().toISOString(),
      processes: [],
    };
    const validate = () =>
      validateTree(
        checkout,
        join(root, "validation"),
        commit,
        treeSha,
        [command],
        // The runner's private diagnostics record of each command.
        (entry) =>
          new DiagnosticEmitter(config.repository, 1).emit({
            runId: state.runId,
            itemId: "local",
            attemptId: work.attempt,
            operation: "validation-command",
            outcome: entry.passed ? "completed" : "failed",
            metadata: { commandIndex: entry.index, exitCode: entry.exitCode },
            detail: entry.output,
          }),
        undefined,
        [],
        undefined,
        commit,
        undefined,
        undefined,
        undefined,
        undefined,
        sandbox,
      );
    const validationStep = () =>
      validateItem({
        state,
        item: graph.items[0],
        save: () => undefined,
        pause: workItemPauseSignal(owner),
        validate,
      });
    // A plain pause refuses the next command. Draining must reach a real
    // failure/operator or publication boundary before that pause applies.
    synchronizeWorkItemPause(owner);
    assert.equal(canHandoff(state), false);
    assert.equal(workItemPauseSignal(owner), owner.workPause.signal);
    await assert.rejects(validationStep, StepPaused);
    assert.equal(existsSync(join(root, "validation")), false);
    setCoordinatorMode(state, "draining");
    synchronizeWorkItemPause(owner);
    assert.equal(owner.workPause.signal.aborted, false);
    assert.equal(workItemPauseSignal(owner), owner.workPause.signal);
    // A plain drain keeps driving the paused item: no step of the new pass
    // runs it yet, yet the Objective step does not stop (#1289).
    assert.equal(canHandoff(state, new Map()), true);
    assert.equal(objectiveStepPause(owner, new Map()), undefined);
    let settledTry = false;
    let nextPaidStarted = false;
    await assert.rejects(
      step(
        state,
        { scope: { item: "local" }, name: "acceptance-review", paid: true },
        async (context) => {
          await context.paid(async () => {
            const result = await subprocessAsync(
              "sh",
              ["-c", "echo started; sleep 0.05; echo settled"],
              {},
              undefined,
              (stream) => {
                if (stream !== "stdout") return;
                setCoordinatorMode(state, "paused");
                synchronizeWorkItemPause(owner);
              },
            );
            settledTry =
              result.status === 0 && result.stdout.includes("settled");
          });
          await context.paid(async () => {
            nextPaidStarted = true;
            await subprocessAsync("sh", ["-c", "echo forbidden"]);
          });
        },
        { save: () => undefined, pause: workItemPauseSignal(owner) },
      ),
      StepPaused,
    );
    assert.equal(settledTry, true);
    assert.equal(nextPaidStarted, false);
    setCoordinatorMode(state, "running");
    synchronizeWorkItemPause(owner);
    assert.equal(owner.workPause.signal.aborted, true);
    owner.pause = new AbortController();
    synchronizeWorkItemPause(owner);
    assert.equal(owner.workPause.signal.aborted, false);
    owner.pause.abort(new Error("Coordinator draining"));
    setCoordinatorMode(state, "draining");
    synchronizeWorkItemPause(owner);
    let pollCount = 0;
    let pauseTimer;
    const waitingAt = Date.now();
    try {
      await assert.rejects(
        step(
          state,
          { scope: "objective", name: "observe" },
          async (context) => {
            pollCount++;
            await subprocessAsync("sh", ["-c", "echo observed"]);
            pauseTimer = setTimeout(() => {
              setCoordinatorMode(state, "paused");
              synchronizeWorkItemPause(owner);
            }, 30);
            context.pending(
              undefined,
              new Date(Date.now() + 60_000).toISOString(),
            );
          },
          {
            save: () => undefined,
            pause: workItemPauseSignal(owner),
            signal: AbortSignal.timeout(1_000),
          },
        ),
        StepPaused,
      );
    } finally {
      clearTimeout(pauseTimer);
    }
    assert.equal(pollCount, 1);
    assert.ok(Date.now() - waitingAt < 1_000);
    // Handoff from plain pause receives a live admitted-work signal; the
    // already-aborted coordinator signal still blocks new item admission.
    owner.handoff = true;
    setCoordinatorMode(state, "draining");
    // While a step of this pass runs the item, a handoff is not yet safe.
    const running = new Map([["local", Promise.resolve()]]);
    assert.equal(canHandoff(state, running), false);
    assert.equal(objectiveStepPause(owner, running), undefined);
    owner.activeItems = running;
    synchronizeWorkItemPause(owner);
    assert.equal(owner.workPause.signal.aborted, false);
    assert.equal(owner.pause.signal.aborted, true);
    // The worker's Validate passed this tree with these commands (#1595):
    // the controller's failed run is saved, then rerun once in a fresh
    // checkout before the failure stands, and both runs reach diagnosis.
    const rerunState = structuredClone(state);
    const rerunWork = rerunState.work.local;
    rerunWork.validationRerun = { treeSha, commands: [command] };
    let beforeRerun;
    let runs = 0;
    const rerunStep = (stepState) =>
      validateItem({
        state: stepState,
        item: graph.items[0],
        save: () => {
          if (stepState === rerunState && rerunWork.validationRerun.failure)
            beforeRerun ??= structuredClone(rerunState);
        },
        validate: () => {
          runs++;
          return validate();
        },
      });
    await assert.rejects(rerunStep(rerunState), (error) => {
      assert.ok(error instanceof CandidateValidationFailure, error.stack);
      assert.match(
        error.message,
        /^Validation failed twice on tree [a-f0-9]{40}, [^\n]*\nFirst run: Validation command failed \(1\): [^]*\nRerun: Validation command failed \(1\): /,
      );
      assert.equal(error.failedValidation.commands[0].exitCode, 1);
      rerunWork.status = "failed";
      recordWorkFailure(rerunState, "local", error);
      return true;
    });
    assert.equal(runs, 2);
    const [, diagnosed] = repairEvidence(rerunState, graph.items[0], []);
    assert.equal(diagnosed.record.evidence.commands[0].exitCode, 1);
    assert.deepEqual(
      diagnosed.firstRun,
      rerunWork.validationRerun.failure.evidence,
    );
    assert.equal(diagnosed.firstRun.commands[0].exitCode, 1);
    // A restart after the first failure was saved runs only the rerun; the
    // restored readiness lets it pass, flagged with the failed run.
    saveState(statePath(config.repository, 1), beforeRerun);
    const resumed = readState(config.repository, 1);
    assert.deepEqual(
      resumed.work.local.validationRerun,
      beforeRerun.work.local.validationRerun,
    );
    writeFileSync(ready, "readiness restored between runs\n");
    runs = 0;
    const flaky = await rerunStep(resumed);
    assert.equal(runs, 1);
    assert.equal(flaky.commands[0].exitCode, 0);
    assert.deepEqual(
      flaky.flakyRerun,
      beforeRerun.work.local.validationRerun.failure,
    );
    resumed.work.local.validation = flaky;
    saveState(statePath(config.repository, 1), resumed);
    assert.deepEqual(
      readState(config.repository, 1).work.local.validation.flakyRerun,
      flaky.flakyRerun,
    );
    assert.match(
      deliveryDescription(
        checkout,
        { item: graph.items[0], baseSha: commit, treeSha, changeRef: commit },
        {
          repository: config.repository,
          objective: 1,
          issue: 1,
          validation: flaky,
        },
      ),
      /Possibly flaky: the controller's first validation run of this candidate failed at <code>[^<]+<\/code> \(exit 1\)/,
    );
    rmSync(ready);
    await assert.rejects(validationStep, (error) => {
      assert.ok(error instanceof CandidateValidationFailure, error.stack);
      assert.equal(error.failedValidation.commands[0].exitCode, 1);
      // The delivery runner fails the admitted item after this real
      // validation command rejects, retaining its exact failed capture.
      work.status = "failed";
      recordWorkFailure(state, "local", error);
      return true;
    });
    assert.equal(work.status, "failed");
    assert.equal(canHandoff(state), true);
    assert.equal(workItemPauseSignal(owner), owner.pause.signal);
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
    // `--logs` prints the worker's output, then the failed controller
    // validation command's complete output (#1596).
    const harness = join(stateRoot(config.repository), "harness");
    mkdirSync(harness, { recursive: true });
    writeFileSync(join(harness, `${work.attempt}.log`), "worker done\n", {
      mode: 0o600,
    });
    const logs = [];
    const print = console.log;
    console.log = (line) => logs.push(line);
    try {
      await runDiagnosticsCommand(
        { ...config, policy: { allowedSecretNames: [] } },
        1,
        ["--logs", "local"],
      );
    } finally {
      console.log = print;
    }
    // The worker output, then each failed controller run of the attempt,
    // the first failure and its rerun included, with its complete output.
    assert.equal(logs[0], "worker done");
    const failedRuns = logs.slice(1);
    assert.ok(failedRuns.length >= 3 && failedRuns.length % 3 === 0);
    for (let index = 0; index < failedRuns.length; index += 3) {
      assert.match(
        failedRuns[index],
        /^Controller validation command 0 failed \(exit 1\) at /,
      );
      assert.deepEqual(failedRuns.slice(index + 1, index + 3), [
        "readiness marker missing",
        "",
      ]);
    }
    const attempt = work.attempt;
    rereviewWorkItem(config, 1, request);
    Object.assign(state, readState(config.repository, 1));
    Object.assign(work, state.work.local);
    state.work.local = work;
    assert.equal(work.attempt, attempt);
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
          undefined,
          undefined,
          undefined,
          undefined,
          sandbox,
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
      undefined,
      undefined,
      undefined,
      undefined,
      sandbox,
    );
    assert.equal(evidence.treeSha, treeSha);
    assert.equal(evidence.commands[0].exitCode, 0);
    assert.equal(evidence.commands[0].executionControl, undefined);
    // A deterministic review-boundary defect after real passing validation
    // reuses this exact candidate, not a fabricated failed-command capture.
    const defectState = structuredClone(state);
    const defectWork = defectState.work.local;
    defectWork.validation = structuredClone(evidence);
    delete defectWork.failedValidation;
    const reviewDefect = new Error(
      "Review admission refused before provider dispatch",
    );
    recordWorkFailure(defectState, "local", reviewDefect);
    defectWork.status = "failed";
    defectWork.error = reviewDefect.message;
    defectState.error = reviewDefect.message;
    defectState.errorItem = "local";
    defectState.coordinator.deadlineAt = new Date(
      Date.now() + 60_000,
    ).toISOString();
    defectState.autonomy.allowances.resultRereviews = 2;
    defectState.autonomy.repairPolicy.perPath.resultRereviews = 2;
    const defectOriginal = structuredClone(defectState);
    for (const change of [
      (value) => {
        value.errorItem = "another-item";
      },
      (value) => {
        value.work.local.validation.worktreeObservation.postCommandStatus =
          "changed";
      },
      (value) => {
        value.work.local.recovery.diagnosisInvocation = {
          id: randomUUID(),
          submitted: true,
          requestDigest: "a".repeat(64),
        };
      },
      (value) => {
        value.objectiveBodyDigest = createHash("sha256")
          .update("refusal-only objective binding")
          .digest("hex");
        value.sourcePacketDigest = createHash("sha256")
          .update(JSON.stringify(pinnedSources))
          .digest("hex");
        const session = agentSessionContinuation(
          value,
          "planning",
          undefined,
          () => undefined,
        );
        session.checkpoint({
          scope: session.scope,
          adapter: "unknown-turn-refusal-only",
          identity: session.identity,
          turn: 1,
          status: "unavailable",
          data: {},
          currentTurn: {
            invocationId: randomUUID(),
            requestDigest: "b".repeat(64),
            graphDigest: graphDigest(value.graph),
            dispatch: "submitted",
            resources: "settled",
          },
        });
      },
      (value) => {
        value.coordinator.deadlineAt = new Date(Date.now() - 1).toISOString();
      },
    ]) {
      const refused = structuredClone(defectOriginal);
      change(refused);
      assert.throws(() => {
        saveState(statePath(config.repository, 1), refused);
        rereviewWorkItem(config, 1, request);
      });
    }
    saveState(statePath(config.repository, 1), defectOriginal);
    rereviewWorkItem(config, 1, request);
    const admittedDefect = readState(config.repository, 1);
    assert.equal(admittedDefect.error, undefined);
    assert.equal(admittedDefect.errorItem, undefined);
    assert.equal(admittedDefect.work.local.attempt, defectWork.attempt);
    assert.equal(admittedDefect.work.local.baseSha, defectWork.baseSha);
    assert.equal(admittedDefect.work.local.changeRef, commit);
    assert.equal(admittedDefect.work.local.treeSha, treeSha);
    assert.equal(admittedDefect.work.local.step, "validate");
    assert.equal(admittedDefect.work.local.status, "running");
    const archivedDefect = admittedDefect.work.local.recovery.history.at(-1);
    assert.deepEqual(archivedDefect.failure, defectWork.recovery.failure);
    assert.deepEqual(archivedDefect.work.validation, evidence);
    assert.equal(archivedDefect.work.error, reviewDefect.message);
    assert.equal(consumption(admittedDefect).resultRereviews, 2);
    assert.equal(consumption(admittedDefect).implementationRepairs, 0);
    assert.equal(
      admittedDefect.coordinator.deadlineAt,
      defectOriginal.coordinator.deadlineAt,
    );
    // The native input contract verifies actual immutable bytes before effects.
    const imageInputRoot = join(root, "image-input");
    mkdirSync(join(imageInputRoot, "artifacts"), { recursive: true });
    const imageInputPath = join(imageInputRoot, "artifacts", "0.png");
    writeFileSync(imageInputPath, imageBytes, { mode: 0o400 });
    const nativeImage = {
      path: imageInputPath,
      mediaType: "image/png",
      bytes: imageBytes.length,
      digest: createHash("sha256").update(imageBytes).digest("hex"),
      evidencePath: "artifacts/0.png",
    };
    assertReviewImages([nativeImage], imageInputRoot);
    const textRequest = createHash("sha256")
      .update(JSON.stringify(["review", { type: "object" }]))
      .digest("hex");
    assert.equal(
      structuredRequestDigest("review", { type: "object" }),
      textRequest,
    );
    assert.equal(
      structuredRequestDigest("review", { type: "object" }, []),
      textRequest,
    );
    const imageRequest = structuredRequestDigest("review", { type: "object" }, [
      nativeImage,
    ]);
    assert.notEqual(imageRequest, textRequest);
    assert.notEqual(
      imageRequest,
      structuredRequestDigest("review", { type: "object" }, [
        { ...nativeImage, digest: "0".repeat(64) },
      ]),
    );
    assert.equal(
      imageRequest,
      structuredRequestDigest("review", { type: "object" }, [
        { ...nativeImage, path: join(root, "other", "artifacts", "0.png") },
      ]),
    );
    assert.throws(
      () =>
        assertReviewImages(
          [{ ...nativeImage, digest: "0".repeat(64) }],
          imageInputRoot,
        ),
      /raw PNG bytes/,
    );
    await assert.rejects(
      () =>
        runCodexAppServer({
          env: {},
          options: { workingDirectory: imageInputRoot },
          prompt: "review",
          schema: { type: "object" },
          reviewImages: [nativeImage],
          signal: new AbortController().signal,
          event: () => assert.fail("Unsupported image input must not dispatch"),
        }),
      (error) =>
        faultOf(error).kind === "config" &&
        /does not support direct PNG/.test(error.message),
    );
    // Real exact-tree commands emit ignored PNG/receipt bytes; the producer
    // preserves selected output before the disposable worktree is removed.
    const imageCommand = `${process.execPath} capture.cjs`;
    const imageStore = new LocalContentStore(join(root, "image-objects"));
    const selector = {
      command: imageCommand,
      receipt: {
        stdoutPathField: "receipt",
        stdoutSha256Field: "sha256",
        maxBytes: 4096,
      },
      image: { file: "scene.png", sha256Field: "imageSha256", maxBytes: 65536 },
      candidate: { file: "README.md", sha256Field: "candidateSha256" },
    };
    assertReviewArtifactSelectors([selector]);
    const artifactRoot = join(root, "image-validation");
    const imageEvidence = await validateTree(
      checkout,
      artifactRoot,
      commit,
      treeSha,
      [imageCommand],
      undefined,
      undefined,
      [],
      imageStore,
      commit,
      true,
      { commands: [`${imageCommand} prerequisite`] },
      [selector, { ...selector, command: `${imageCommand} prerequisite` }],
    );
    assert.equal(existsSync(join(artifactRoot, "worktree")), false);
    assert.equal(imageEvidence.preparation.length, 1);
    assert.equal(imageEvidence.reviewArtifacts.length, 1);
    const artifact = imageEvidence.reviewArtifacts[0];
    assert.equal(artifact.commandIndex, 0);
    assert.equal(artifact.command, imageCommand);
    assert.equal(artifact.treeSha, treeSha);
    assert.equal(artifact.complete, true);
    assert.equal(
      artifact.candidate.sha256,
      createHash("sha256")
        .update(readFileSync(join(checkout, "README.md")))
        .digest("hex"),
    );
    await imageStore.materialize(
      artifact.image.ref,
      join(root, "retained-scene.png"),
    );
    assert.deepEqual(
      readFileSync(join(root, "retained-scene.png")),
      imageBytes,
    );
    await imageStore.materialize(
      artifact.receipt.ref,
      join(root, "retained-receipt.json"),
    );
    assert.equal(
      JSON.parse(readFileSync(join(root, "retained-receipt.json"), "utf8"))
        .imageSha256,
      artifact.image.ref.digest,
    );
    const loadedImages = await loadReviewArtifacts(
      checkout,
      imageEvidence,
      imageStore,
    );
    const imageDescriptors = reviewArtifactEvidence(loadedImages);
    assert.equal(imageDescriptors[0].path, "artifacts/0.png");
    const descriptorIdentity = JSON.parse(imageDescriptors[0].content);
    assert.equal(descriptorIdentity.command, imageCommand);
    assert.equal(descriptorIdentity.treeSha, treeSha);
    assert.deepEqual(descriptorIdentity.candidate, artifact.candidate);
    assert.deepEqual(descriptorIdentity.image.ref, artifact.image.ref);
    const normalReviewRoot = join(root, "normal-image-review");
    mkdirSync(normalReviewRoot);
    const normalInputs = materializeReviewImages(
      normalReviewRoot,
      loadedImages,
    );
    assertReviewImages(normalInputs, normalReviewRoot);
    assert.deepEqual(readFileSync(normalInputs[0].path), imageBytes);
    // A final-only review can reuse these exact-tree runtime pixels without
    // relabeling the Work Item command as a new final command execution.
    const emptyFinalEvidence = await validateTree(
      checkout,
      join(root, "empty-final-validation"),
      commit,
      treeSha,
      [],
      undefined,
      undefined,
      [],
      imageStore,
      commit,
    );
    assert.deepEqual(emptyFinalEvidence.commands, []);
    assert.equal(emptyFinalEvidence.reviewArtifacts, undefined);
    const itemImageObservation = {
      itemId: "local",
      resultCommitSha: commit,
      integratedCommitSha: commit,
      evidence: imageEvidence,
    };
    const reusedFinalImages = await loadReviewArtifactObservations(
      checkout,
      emptyFinalEvidence,
      [itemImageObservation],
      imageStore,
    );
    assert.equal(reusedFinalImages.length, 1);
    assert.deepEqual(reusedFinalImages[0].identity, artifact);
    const reusedIdentity = JSON.parse(
      reviewArtifactEvidence(reusedFinalImages)[0].content,
    );
    assert.deepEqual(reusedIdentity.origin, {
      kind: "accepted-work-item-validation",
      itemId: "local",
      resultCommitSha: commit,
      integratedCommitSha: commit,
      resultTreeSha: treeSha,
    });
    assert.equal(reusedIdentity.command, imageCommand);
    assert.equal(reusedIdentity.commandIndex, artifact.commandIndex);
    assert.equal(reusedIdentity.treeSha, treeSha);
    assert.match(
      reusedIdentity.purpose,
      /not a fresh final-validation command/,
    );
    const reusedFinalRoot = join(root, "reused-final-image-review");
    mkdirSync(reusedFinalRoot);
    const reusedFinalInputs = materializeReviewImages(
      reusedFinalRoot,
      reusedFinalImages,
    );
    assertReviewImages(reusedFinalInputs, reusedFinalRoot);
    assert.deepEqual(readFileSync(reusedFinalInputs[0].path), imageBytes);
    assert.deepEqual(emptyFinalEvidence.commands, []);
    const freshFinalEvidence = await validateTree(
      checkout,
      join(root, "fresh-final-image-validation"),
      commit,
      treeSha,
      [imageCommand],
      undefined,
      undefined,
      [],
      imageStore,
      commit,
      true,
      { commands: [] },
      [selector],
    );
    const finalOwnImages = await loadReviewArtifactObservations(
      checkout,
      freshFinalEvidence,
      [itemImageObservation],
      imageStore,
    );
    assert.equal(finalOwnImages.length, 1);
    assert.deepEqual(
      finalOwnImages[0].identity,
      freshFinalEvidence.reviewArtifacts[0],
    );
    assert.equal(
      JSON.parse(reviewArtifactEvidence(finalOwnImages)[0].content).origin,
      undefined,
    );
    // Reordering selectors mid-run moves the index, never the identity: the
    // same command and candidate must not carry its image a second time.
    const reorderedFinalEvidence = structuredClone(freshFinalEvidence);
    reorderedFinalEvidence.reviewArtifacts[0].selectorIndex = 5;
    assert.equal(
      (
        await loadReviewArtifactObservations(
          checkout,
          reorderedFinalEvidence,
          [itemImageObservation],
          imageStore,
        )
      ).length,
      1,
    );
    const changedTree = execFileSync(
      "git",
      ["-C", checkout, "hash-object", "-t", "tree", "-w", "--stdin"],
      { input: "", encoding: "utf8" },
    ).trim();
    assert.notEqual(changedTree, treeSha);
    const changedCommit = git(
      "-c",
      "user.name=Integration",
      "-c",
      "user.email=integration@example.invalid",
      "commit-tree",
      changedTree,
      "-p",
      commit,
      "-m",
      "Different final candidate tree",
    );
    const changedFinalEvidence = await validateTree(
      checkout,
      join(root, "changed-final-validation"),
      changedCommit,
      changedTree,
      [],
      undefined,
      undefined,
      [],
      imageStore,
      commit,
    );
    assert.deepEqual(
      await loadReviewArtifactObservations(
        checkout,
        changedFinalEvidence,
        [itemImageObservation],
        imageStore,
      ),
      [],
    );
    assert.equal(git("rev-parse", "HEAD"), commit);
    const mismatchedCandidate = structuredClone(imageEvidence);
    mismatchedCandidate.reviewArtifacts[0].candidate.sha256 = "0".repeat(64);
    await assert.rejects(
      () => loadReviewArtifacts(checkout, mismatchedCandidate, imageStore),
      /candidate bytes differ/,
    );
    const retainedImageState = structuredClone(state);
    retainedImageState.graph.items.find(
      (item) => item.id === "local",
    ).validation = [{ command: imageCommand, provenance: "source-declared" }];
    retainedImageState.planGraphDigest = graphDigest(retainedImageState.graph);
    retainedImageState.approvedPlaybookAdmission.graphDigest =
      retainedImageState.planGraphDigest;
    retainedImageState.work.local = {
      status: "running",
      step: "validate",
      attempt: "actual-image-validation",
      baseSha: commit,
      executionBaseSha: commit,
      graphRevisionDigest: retainedImageState.planGraphDigest,
      changeRef: commit,
      treeSha,
    };
    retainedImageState.work.local.validation = await validateTree(
      checkout,
      artifactRoot,
      commit,
      treeSha,
      [imageCommand],
      undefined,
      undefined,
      [],
      imageStore,
      commit,
      true,
      { commands: [] },
      [selector],
    );
    assert.deepEqual(
      parseFactoryState(retainedImageState, state.repository, state.objective)
        .work.local.validation.reviewArtifacts,
      retainedImageState.work.local.validation.reviewArtifacts,
    );
    const invalidImageState = structuredClone(retainedImageState);
    invalidImageState.work.local.validation.reviewArtifacts[0].commandIndex = 1;
    assert.throws(
      () =>
        parseFactoryState(invalidImageState, state.repository, state.objective),
      /passing exact command/,
    );
    for (const [option, expected] of [
      ["escape", /contained and relative/],
      ["mismatch", /receipt digest/],
    ]) {
      const badCommand = `${imageCommand} ${option}`;
      await assert.rejects(
        () =>
          validateTree(
            checkout,
            artifactRoot,
            commit,
            treeSha,
            [badCommand],
            undefined,
            undefined,
            [],
            imageStore,
            commit,
            true,
            { commands: [] },
            [{ ...selector, command: badCommand }],
          ),
        expected,
      );
      assert.equal(existsSync(join(artifactRoot, "worktree")), false);
    }

    const deadlineAt = new Date(Date.now() + 10_000).toISOString();
    const boundedState = {
      ...structuredClone(state),
      coordinator: {
        mode: "running",
        phase: "validate",
        phaseStartedAt: new Date().toISOString(),
        deadlineAt,
      },
    };
    const cancellation = new AbortController();
    const deadlineTimer = setTimeout(
      () => cancellation.abort(new Error("Controller deadline elapsed")),
      Date.parse(deadlineAt) - Date.now(),
    );
    const settledGroups = [];
    let bounded;
    try {
      bounded = await withProcessCancellation(
        cancellation.signal,
        () =>
          step(
            boundedState,
            { scope: "objective", name: "bounded-validation" },
            () => validate(),
            { save: () => undefined, signal: cancellation.signal },
          ),
        (owned, settled) => {
          if (settled) settledGroups.push(owned.pid);
        },
        deadlineAt,
      );
      assert.deepEqual(bounded.commands[0].executionControl, {
        scope: "controller-owned-process-group",
        cancellation: "active-at-dispatch",
        settlement: "verified",
        deadlineAt,
      });
      assert.ok(settledGroups.length > 0);
      assert.ok(settledGroups.every((pid) => !processGroupExists(pid)));
      assertCommandReceipts(bounded, treeSha, "Actual bounded validation");
      const retained = structuredClone(state);
      retained.work.local.validation = bounded;
      assert.deepEqual(
        parseFactoryState(retained, state.repository, state.objective).work
          .local.validation.commands[0].executionControl,
        bounded.commands[0].executionControl,
      );
      const receiptText = commandPassEvidence(bounded.commands).content;
      assert.ok(receiptText.includes(deadlineAt));
      assert.ok(receiptText.includes("controller-owned-process-group"));
      const wrongTree = structuredClone(bounded);
      wrongTree.commands[0].treeSha = "0".repeat(40);
      assert.throws(() =>
        assertCommandReceipts(wrongTree, treeSha, "Wrong tree"),
      );
      const invalidControl = structuredClone(bounded);
      invalidControl.commands[0].executionControl.deadlineAt = "not-a-date";
      assert.throws(
        () => assertCommandReceipts(invalidControl, treeSha, "Invalid control"),
        /execution control/,
      );
      retained.work.local.validation = invalidControl;
      assert.throws(
        () => parseFactoryState(retained, state.repository, state.objective),
        /execution control/,
      );
      const mismatched = await withProcessCancellation(
        cancellation.signal,
        () =>
          step(
            boundedState,
            { scope: "objective", name: "mismatched-bound-validation" },
            () => validate(),
            { save: () => undefined, signal: cancellation.signal },
          ),
        undefined,
        new Date(Date.parse(deadlineAt) + 1_000).toISOString(),
      );
      assert.equal(
        mismatched.commands[0].executionControl.deadlineAt,
        undefined,
      );
      assert.equal(
        mismatched.commands[0].executionControl.cancellation,
        "active-at-dispatch",
      );
    } finally {
      clearTimeout(deadlineTimer);
    }
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
      approvedPlaybookAdmission: {
        ...state.approvedPlaybookAdmission,
        graphDigest: graphDigest(semanticGraph),
      },
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
      assert.equal(
        createHash("sha256").update(selected).digest("hex"),
        item.inputSources[index].sha256,
      );
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
        `Pinned sources:\n${JSON.stringify(
          pinnedSources.map(({ content: _content, ...source }, index) => ({
            ...source,
            content: { block: `source ${index}` },
          })),
        )}`,
      ),
    );
    for (const [index, source] of pinnedSources.entries())
      assert.ok(
        renderedDiagnosis.prompt.includes(
          ` source ${index}>>>\n${source.content}\n<<<`,
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
    unmatchedItem.inputSources[1].sha256 = "0".repeat(64);
    const unmatchedRequest = workRepairDiagnosisRequest({
      state: refusedState,
      item: unmatchedItem,
      evidence: supplied,
      sources: pinnedSources,
    });
    const [unmatchedPayload, unmatchedBodies] = unmatchedRequest.objective
      .slice(unmatchedRequest.objective.lastIndexOf("\n{") + 1)
      .split("\nWork Item input bodies. ");
    const unmatchedDiagnosis = JSON.parse(unmatchedPayload);
    // Without a checkout to re-derive it, an input no pinned source holds
    // renders as its exact identity, never as substituted bytes.
    assert.deepEqual(
      unmatchedDiagnosis.item.inputSources[1],
      unmatchedItem.inputSources[1],
    );
    assert.equal(unmatchedBodies, undefined);
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
      requestedFiles: [],
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
    // The repaired item's next attempt is refused by review for a pinned
    // source section. That refusal replaces the earlier attempt's record,
    // and `factory retry` then starts a new attempt (#1254).
    const sectionSources = planningSources(
      "## Sources\n- contract.md#Documentation\n",
      commit,
      checkout,
    );
    assert.ok(sectionSources.some((source) => source.heading));
    const later = readState(config.repository, 3);
    const laterWork = later.work.local;
    Object.assign(laterWork, {
      step: "validate",
      attempt: "later-candidate",
      baseSha: commit,
      executionBaseSha: commit,
      graphRevisionDigest: graphDigest(later.graph),
      changeRef: commit,
      treeSha,
      validation: structuredClone(evidence),
    });
    const laterPacket = reviewPacket(
      later.graph.items[0].acceptance,
      sectionSources.map((source) => ({ ...source, origin: "source" })),
    );
    const laterFinding = {
      criterionId: laterPacket.criteria[0].id,
      verdict: "refuse",
      evidenceIds: laterPacket.evidence.map((entry) => entry.id),
      detail: "The documented section requires a marker the README omits.",
      question: "",
    };
    const laterRefusal = {
      treeSha,
      criterion: later.graph.items[0].acceptance[0],
      source: "model",
      finding: laterFinding,
      evidence: resolveReviewReferences(
        laterFinding.evidenceIds,
        laterPacket,
        false,
      ),
    };
    const reviewRefusal = new SemanticAcceptanceFailure(
      semanticRefusalDetail(laterRefusal),
      laterRefusal,
    );
    // The delivery runner fails the item with the error, then records it.
    const recordLater = (state, error) => {
      state.work.local.status = "failed";
      state.work.local.error = error.message;
      recordWorkFailure(state, "local", error);
    };
    const unbound = structuredClone(later);
    recordLater(later, reviewRefusal);
    assert.deepEqual(laterWork.recovery.failure.semanticRefusal, {
      ...laterRefusal,
      validationDigest:
        laterWork.recovery.failure.semanticRefusal.validationDigest,
    });
    assert.equal(laterWork.recovery.failure.detail, laterWork.error);
    saveState(statePath(config.repository, 3), later);
    // A passing review of the same section retains its literal body with the
    // section heading, while the citation carries only its declared reference.
    const passingIds = laterPacket.evidence.map((entry) => entry.id);
    assertRetainedReviewEvidence({
      criteria: [
        {
          criterion: later.graph.items[0].acceptance[0],
          verdict: "pass",
          evidence: resolveReviewReferences(passingIds, laterPacket, true),
          detail: "The documented section is satisfied.",
        },
      ],
      reviewEvidence: laterPacket.evidence.map((entry) =>
        structuredClone(entry),
      ),
    });
    assert.ok(laterPacket.evidence.some((entry) => entry.heading));
    const retryConfig = { ...config, delivery: { kind: "regular" } };
    assert.equal(retryWorkItem(retryConfig, 3, "local"), "attempt");
    const retried = readState(config.repository, 3).work.local;
    assert.equal(retried.status, "pending");
    assert.equal(
      retried.recovery.history.at(-1).work.attempt,
      "later-candidate",
    );
    assert.deepEqual(
      retried.recovery.history.at(-1).failure,
      laterWork.recovery.failure,
    );
    // A refusal whose binding is rejected is still this attempt's failure:
    // the earlier attempt's record never stays beside its error.
    const misbound = new SemanticAcceptanceFailure(reviewRefusal.message, {
      ...laterRefusal,
      treeSha: "0".repeat(40),
    });
    recordLater(unbound, misbound);
    assert.equal(unbound.work.local.recovery.failure.detail, misbound.message);
    assert.equal(
      unbound.work.local.recovery.failure.semanticRefusal,
      undefined,
    );
    // Its diagnosis was submitted and never returned (#1661): the operator's
    // retry settles it as abandoned, unanswered, and the handoff proceeds.
    const lostDiagnosis = randomUUID();
    unbound.work.local.recovery.diagnosisInvocation = {
      id: lostDiagnosis,
      submitted: true,
      requestDigest: "a".repeat(64),
    };
    // While its planning turn is still in flight, the retry is refused and
    // nothing changes; the turn is settled through its owner first.
    const held = structuredClone(unbound);
    held.objectiveBodyDigest = createHash("sha256")
      .update("retry diagnosis fence")
      .digest("hex");
    held.sourcePacketDigest = createHash("sha256")
      .update(JSON.stringify(pinnedSources))
      .digest("hex");
    const planning = agentSessionContinuation(
      held,
      "planning",
      undefined,
      () => undefined,
    );
    planning.checkpoint({
      scope: planning.scope,
      adapter: "in-flight-diagnosis",
      identity: planning.identity,
      turn: 1,
      status: "in-flight",
      data: {},
      currentTurn: {
        invocationId: lostDiagnosis,
        requestDigest: "a".repeat(64),
        graphDigest: graphDigest(held.graph),
        dispatch: "submitted",
        resources: "active",
      },
    });
    saveState(statePath(config.repository, 3), held);
    assert.throws(
      () => retryWorkItem(retryConfig, 3, "local"),
      /still held by its planning session/,
    );
    assert.deepEqual(
      readState(config.repository, 3).work.local,
      held.work.local,
    );
    saveState(statePath(config.repository, 3), unbound);
    assert.equal(retryWorkItem(retryConfig, 3, "local"), "attempt");
    const settledRetry = readState(config.repository, 3);
    for (const diagnosis of [
      settledRetry.work.local.recovery.diagnosisInvocation,
      settledRetry.work.local.recovery.history.at(-1).diagnosisInvocation,
    ]) {
      assert.equal(diagnosis.submitted, false);
      assert.equal(diagnosis.response, undefined);
      assert.deepEqual(diagnosis.abandoned, [lostDiagnosis]);
    }
    assert.doesNotMatch(
      restoredContinuationOwnershipHold(settledRetry, true) ?? "",
      /diagnosis/,
    );
    assert.equal(git("rev-parse", "HEAD"), commit);
    // The operator retires the command that cannot pass in the sandbox
    // (#1667): only the operator, only a command the item runs, with a reason
    // that status keeps. Acceptance is unchanged; its review judges it.
    saveState(statePath(config.repository, 3), unbound);
    const retire = (retirement) =>
      retryWorkItem(retryConfig, 3, "local", { retire: retirement });
    assert.throws(
      () =>
        retire({ command: "npm run audit", reason: "CI", actor: "operator" }),
      /Work Item local has no validation command "npm run audit"/,
    );
    assert.throws(
      () => retire({ command, reason: "CI", actor: "factory-worker" }),
      /Only the operator can retire a validation command/,
    );
    assert.throws(
      () => retire({ command, reason: "CI", actor: "operator" }),
      /last validation command; an item keeps at least one/,
    );
    // With a second command, the first one retires.
    const kept = { command: "npm test", provenance: "base-observed" };
    const twoCommands = structuredClone(unbound);
    twoCommands.graph.items[0].validation.push(kept);
    // Its receipts covered one command: here the item was cancelled first.
    twoCommands.work.local = { status: "cancelled" };
    saveState(
      statePath(config.repository, 3),
      JSON.parse(
        JSON.stringify(twoCommands).replaceAll(
          graphDigest(unbound.graph),
          graphDigest(twoCommands.graph),
        ),
      ),
    );
    assert.equal(
      retire({ command, reason: "covered by CI", actor: "operator" }),
      "attempt",
    );
    const retiredState = readState(config.repository, 3);
    assert.equal(retiredState.work.local.status, "pending");
    assert.deepEqual(retiredState.graph.items[0].validation, [kept]);
    assert.deepEqual(
      retiredState.graph.items[0].acceptance,
      unbound.graph.items[0].acceptance,
    );
    assert.deepEqual(retiredState.graph.coverage[0].proof, {
      kind: "result-semantic",
    });
    const [retiredEntry] = statusDocument(
      retiredState,
      config.repository,
      3,
      "regular",
    ).retiredValidation;
    assert.deepEqual(
      { ...retiredEntry, at: undefined },
      {
        itemId: "local",
        command,
        reason: "covered by CI",
        actor: "operator",
        at: undefined,
      },
    );
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
      objectiveCommands: [],
      objectiveBodyDigest: "b".repeat(64),
      approvedPlaybookPin: null,
      approvedPlaybookAdmission: {
        approvedPlaybookPin: null,
        configDigest: state.configDigest,
        graphDigest: graphDigest(publicationGraph),
        packetDigest: "c".repeat(64),
        reviewDigest: "d".repeat(64),
        sourcePacketDigest: "e".repeat(64),
      },
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
await control.beforeCreate(request);
const retained = JSON.stringify(state.publicationIntents);
assert.throws(() => stale.assertRequest(request), /control is stale/);
assert.throws(() => stale.reconcileOnly, /control is stale/);
await assert.rejects(() => stale.beforeCreate(request), /control is stale/);
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
    rmSync(external, { recursive: true, force: true });
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
    // New Project preparation fetches and aligns once at the authoritative
    // source seam. The real status callback stops before any compiler/provider;
    // no model answer or accepted graph is supplied by this regression.
    const sourceRemote = join(root, "source.git"),
      producer = join(root, "source-producer");
    execFileSync("git", ["init", "--bare", "-b", "main", sourceRemote], {
      stdio: "ignore",
    });
    git("remote", "add", "origin", sourceRemote);
    git("push", "origin", "main");
    execFileSync("git", ["clone", sourceRemote, producer], { stdio: "ignore" });
    const produce = (...args) =>
      execFileSync("git", ["-C", producer, ...args], {
        encoding: "utf8",
      }).trim();
    const advance = () => {
      writeFileSync(
        join(producer, "new-source.txt"),
        `source revision ${produce("rev-parse", "HEAD")}\n`,
      );
      produce("add", "new-source.txt");
      produce(
        "-c",
        "user.name=Integration",
        "-c",
        "user.email=integration@example.invalid",
        "commit",
        "-m",
        "advance source",
      );
      produce("push", "origin", "main");
      return produce("rev-parse", "HEAD");
    };
    const latest = advance();
    const preparationRepository = `integration/preparation-${randomUUID()}`;
    const selection = { model: "not-dispatched", reasoningEffort: "low" };
    const preparationConfig = {
      schemaVersion: 1,
      repository: preparationRepository,
      checkout,
      planning: { kind: "codex-sdk", planner: selection, reviewer: selection },
      execution: {
        kind: "local",
        concurrency: 1,
        harness: { kind: "codex-sdk", ...selection },
      },
      delivery: { kind: "regular" },
      policy: { network: "off", allowedSecretNames: [] },
      queue: {
        project: {
          repository: preparationRepository,
          projectId: "PVT_source",
          metadataFieldId: "PVTF_metadata",
          orderFieldId: "PVTF_order",
          controlItemId: "PVTI_control",
          factoryManagedFields: true,
        },
      },
      gitPersistence: {
        remote: join(root, "private-history.git"),
        ref: "refs/heads/history",
        visibility: "private",
        scope: "private-history",
        maxBytes: 16 * 1024 * 1024,
        maxFiles: 4096,
        timeoutMs: 30_000,
        coalesceMs: 0,
      },
    };
    const preparationBody =
      "## Outcome\nInspect the pinned source.\n\n## Acceptance\n- Source is readable.\n\n## Sources\n- `README.md`\n";
    mkdirSync(stateRoot(preparationRepository), {
      recursive: true,
      mode: 0o700,
    });
    const preparationStore = new LocalContentStore(
      join(stateRoot(preparationRepository), "content"),
    );
    const preparedBoundary = new Error(
      "Actual preparation reached the pre-compiler status boundary",
    );
    let baseReads = 0;
    const prepare = async (objective, preparation) => {
      const owner = {
        snapshot: preparation,
        abort: new AbortController(),
        pause: new AbortController(),
        workPause: new AbortController(),
      };
      const unsaved = {};
      return prepareObjective({
        config: preparationConfig,
        objective,
        issue: { body: preparationBody },
        path: statePath(preparationRepository, objective),
        diagnostics: new DiagnosticEmitter(preparationRepository, objective),
        planningModel: new CodexPlanningModel(checkout, selection, selection),
        github: {
          async defaultBranch() {
            baseReads++;
            return "main";
          },
          async objectiveDependencies() {
            return [];
          },
        },
        contentStore: preparationStore,
        owner,
        installationConfigDigest: factoryConfigDigest(preparationConfig),
        preparation,
        objectiveStep: (current, name, fn, paid) =>
          step(current ?? unsaved, { scope: "objective", name, paid }, fn, {
            save: () => {
              if (current)
                saveState(statePath(preparationRepository, objective), current);
            },
          }),
        cancellationRequested: () => false,
        reportRunStatus: () => {
          throw preparedBoundary;
        },
      });
    };
    const priorLocalOrigins = process.env.FACTORY_TEST_LOCAL_ORIGINS;
    process.env.FACTORY_TEST_LOCAL_ORIGINS = "1";
    try {
      await assert.rejects(prepare(10), (error) => error === preparedBoundary);
      assert.equal(baseReads, 1);
      assert.equal(git("rev-parse", "HEAD"), latest);
      const retained = readContinuation(preparationRepository, 10);
      assert.equal(retained.baseSha, latest);
      const originalRun = retained.runId;
      const nextHead = advance();
      await assert.rejects(
        prepare(10, retained),
        (error) => error === preparedBoundary,
      );
      assert.equal(
        baseReads,
        1,
        "retained preparation never fetches or realigns",
      );
      assert.equal(git("rev-parse", "HEAD"), latest);
      assert.equal(readContinuation(preparationRepository, 10).baseSha, latest);
      assert.equal(
        readContinuation(preparationRepository, 10).runId,
        originalRun,
      );
      writeFileSync(join(checkout, "dirty.txt"), "actual unsaved user work\n");
      await assert.rejects(prepare(11), /local changes/);
      assert.equal(git("rev-parse", "HEAD"), latest);
      assert.equal(
        readFileSync(join(checkout, "dirty.txt"), "utf8"),
        "actual unsaved user work\n",
      );
      assert.equal(readContinuation(preparationRepository, 11), undefined);
      rmSync(join(checkout, "dirty.txt"));
      writeFileSync(join(checkout, "diverged.txt"), "actual diverged work\n");
      git("add", "diverged.txt");
      git(
        "-c",
        "user.name=Integration",
        "-c",
        "user.email=integration@example.invalid",
        "commit",
        "-m",
        "diverge from default",
      );
      const diverged = git("rev-parse", "HEAD");
      await assert.rejects(prepare(12), /fast-forward|diverging/i);
      assert.equal(git("rev-parse", "HEAD"), diverged);
      assert.equal(readContinuation(preparationRepository, 12), undefined);
      // Restore this disposable fixture through its named original branch;
      // no target or contributor checkout is reset.
      git("switch", "--detach", nextHead);
      git("switch", "-c", "readiness-fixture", baseSha);
    } finally {
      if (priorLocalOrigins === undefined)
        delete process.env.FACTORY_TEST_LOCAL_ORIGINS;
      else process.env.FACTORY_TEST_LOCAL_ORIGINS = priorLocalOrigins;
      rmSync(stateRoot(preparationRepository), {
        recursive: true,
        force: true,
      });
    }
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
    // The opt-in is bound through the original Objective and production
    // compiler context; it adds source choices, not obligations or new fields.
    const qualityRequest = prepareCompilationRequest({
      objective: 1,
      body: `${body}\n## Quality checkpoint\nenabled\n`,
      baseSha,
      checkout,
    });
    const qualityCall = renderCompilationCall(qualityRequest);
    assert.ok(!call.prompt.includes("Quality checkpoint guidance"));
    assert.ok(qualityCall.call.prompt.includes("Quality checkpoint guidance"));
    assert.ok(qualityCall.call.prompt.includes("least convincing dimension"));
    assert.deepEqual(
      Object.keys(qualityCall.call.schema.properties),
      Object.keys(call.schema.properties),
    );
    assert.deepEqual(qualityCall.call.schema.required, call.schema.required);
    assert.deepEqual(
      qualityRequest.coverageObligations.map((entry) => entry.source.text),
      request.coverageObligations.map((entry) => entry.source.text),
    );
    assert.notEqual(qualityCall.wire.data.contextId, wire.data.contextId);
    const disabledRequest = prepareCompilationRequest({
      objective: 1,
      body: `${body.replace(/^## /gm, "### ")}\n### Quality checkpoint\ndisabled\n`,
      baseSha,
      checkout,
    });
    assert.ok(
      !renderCompilationCall(disabledRequest).call.prompt.includes(
        "Quality checkpoint guidance",
      ),
    );
    for (const declaration of [
      "## Quality checkpoint\nenabled\ndisabled\n",
      "## Quality checkpoint\nenabled\n## Quality checkpoint\ndisabled\n",
      "## Quality checkpoint\n```\nenabled\n```\n",
    ])
      assert.throws(
        () =>
          prepareCompilationRequest({
            objective: 1,
            body: `${body}\n${declaration}`,
            baseSha,
            checkout,
          }),
        /Quality checkpoint/,
      );
    const source = wire.data.sources.find(
      (entry) => entry.path === "README.md",
    );
    const citation = wire.data.citations.find(
      (entry) => entry.path === "README.md",
    );
    const generated = {
      contextId: wire.data.contextId,
      decisionRequired: null,
      requiredPreIntegrationChecks: [],
      sourceObligations: [],
      split: null,
      items: [
        {
          ...item,
          children: [],
          newPackages: [],
          priority: 0,
          oneOutcomeReason: null,
          citations: [{ path: citation.path, heading: citation.heading }],
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
    // The transient ordinary-work choice replaces canonical media defaults
    // with media null.
    for (const field of [
      "expectedOutputRoles",
      "minimumAssetSets",
      "requiredLfsRoles",
    ])
      delete generated.items[0][field];
    generated.items[0].media = null;
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
    // A null environment is the default, and a null source-obligation
    // statement is the exact cited lines; both decode to the full form.
    const exitLine = source.lines.find((line) => line.text.trim());
    const lean = structuredClone(generated);
    lean.coverage[0].environment = null;
    lean.sourceObligations = [
      {
        sourceIndex: source.sourceIndex,
        firstLineIndex: exitLine.lineIndex,
        lastLineIndex: exitLine.lineIndex,
        statement: null,
        disposition: {
          kind: "covered",
          itemId: item.id,
          proof: { kind: "final-review" },
          environment: null,
        },
      },
    ];
    const leanGraph = wire.decode(lean);
    const defaultEnvironment = {
      kind: "local",
      readiness: "available",
      preparedBy: "",
      probe: "",
    };
    assert.deepEqual(leanGraph.coverage[0].environment, defaultEnvironment);
    assert.equal(leanGraph.coverage.at(-1).statement, exitLine.text);
    assert.deepEqual(leanGraph.coverage.at(-1).environment, defaultEnvironment);
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
    // Final validation installs first, exactly once: a listed bootstrap
    // moves to the front, else the graph's declared one leads.
    const install = "pnpm install --frozen-lockfile --ignore-scripts";
    const bootstrapped = structuredClone(graph);
    bootstrapped.items[0].validation.unshift({
      command: install,
      provenance: "source-declared",
      source: "README.md",
    });
    const sequence = (commands, target = bootstrapped) =>
      finalValidationSequence(target, commands);
    assert.deepEqual(sequence([acceptance]), {
      preparation: [install, setup],
      commands: [acceptance],
    });
    assert.deepEqual(sequence([setup, acceptance]), {
      preparation: [install],
      commands: [setup, acceptance],
    });
    assert.deepEqual(sequence([setup, acceptance, install]), {
      preparation: [],
      commands: [install, setup, acceptance],
    });
    assert.deepEqual(sequence([install, acceptance, install], graph), {
      preparation: [install, setup],
      commands: [acceptance],
    });
    assert.deepEqual(sequence([acceptance], graph), {
      preparation: [setup],
      commands: [acceptance],
    });
    assert.deepEqual(sequence([` ${install}`, acceptance, `${install} `]), {
      preparation: [` ${install}`, setup],
      commands: [acceptance],
    });
    // Only a source-declared exact bootstrap moves or leads.
    const observed = structuredClone(bootstrapped);
    observed.items[0].validation[0].provenance = "base-observed";
    assert.deepEqual(sequence([acceptance], observed), {
      preparation: [setup],
      commands: [acceptance],
    });
    const nearMiss = "pnpm install --frozen-lockfile";
    assert.deepEqual(sequence([setup, acceptance, nearMiss], graph), {
      preparation: [],
      commands: [setup, acceptance, nearMiss],
    });
    // Receipts must match the current sequence, or exactly the previous one.
    const listed = [setup, acceptance, install];
    assert.ok(finalReceiptsMatch(bootstrapped, listed, sequence(listed)));
    assert.ok(
      finalReceiptsMatch(bootstrapped, listed, {
        preparation: [],
        commands: listed,
      }),
    );
    assert.ok(
      !finalReceiptsMatch(bootstrapped, [acceptance, install], {
        preparation: [install, setup],
        commands: [acceptance, install],
      }),
    );
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
      const reusableIndices = reusableEnvironmentValidationIndices(
        graph,
        item.id,
      );
      assert.deepEqual(reusableIndices, [0, 1]);
      const receiptRequest = {
        item,
        baseSha,
        attemptId: "recorded-checkout",
        environmentReadiness: {
          validationIndices: [0, 1],
          reusableValidationIndices: reusableIndices,
          acceptedBaseSha: baseSha,
          lfsMembers: [],
          workspacePackageAdditions: [],
        },
      };
      const receipt = workerReadinessReceipt({
        request: receiptRequest,
        workerIdentity: "recorded-checkout",
        worktree: worker,
        validationRoot: join(root, "worker-receipts"),
        evidence: readiness,
      });
      const harnessRequest = {
        item,
        sourceBaseSha: baseSha,
        sourceDelivery: materializeWorkerSources(worker, {
          item,
          sourceBaseSha: baseSha,
        }),
        worktree: worker,
        attemptId: "recorded-checkout",
        workerReadiness: receipt,
      };
      assert.equal(
        currentWorkerReadiness(harnessRequest)?.digest,
        receipt.digest,
      );
      assert.equal(receipt.treeSha, baseTree);
      assert.equal(receipt.commands[0].source, "README.md");
      assert.equal(receipt.runtime.ignoredEntries[0].path, ".runtime-ready");
      const workerPrompt = workItemPrompt(harnessRequest);
      const requiredChecks = workerPrompt
        .split("Authoritative post-edit validation:")[1]
        .split("Controller readiness in this exact checkout")[0];
      assert.ok(requiredChecks.includes(acceptance));
      assert.ok(!requiredChecks.includes(setup));
      assert.ok(!requiredChecks.includes(probe));
      assert.ok(workerPrompt.includes("not by you"));
      assert.ok(workerPrompt.includes("source-required post-edit execution"));
      const acceptanceProbe = structuredClone(graph);
      acceptanceProbe.coverage[0].proof = {
        kind: "result-command",
        validationIndex: 1,
      };
      assert.deepEqual(
        reusableEnvironmentValidationIndices(acceptanceProbe, item.id),
        [0],
      );
      const literalSetupDuty = structuredClone(graph);
      literalSetupDuty.items[0].acceptance.push(setup);
      assert.deepEqual(
        reusableEnvironmentValidationIndices(literalSetupDuty, item.id),
        [1],
      );
      const corruptReceipt = { ...receipt, digest: "0".repeat(64) };
      assert.equal(
        currentWorkerReadiness({
          ...harnessRequest,
          workerReadiness: corruptReceipt,
        }),
        undefined,
      );
      assert.ok(
        workItemPrompt({
          ...harnessRequest,
          workerReadiness: undefined,
        }).includes(JSON.stringify(item.validation[0])),
      );
      assert.equal(
        currentWorkerReadiness({ ...harnessRequest, worktree: checkout }),
        undefined,
      );
      // Removing real ignored runtime makes the offer stale even though Git bytes match.
      rmSync(join(worker, ".runtime-ready"));
      assert.equal(currentWorkerReadiness(harnessRequest), undefined);
      const stalePrompt = workItemPrompt(harnessRequest);
      assert.ok(stalePrompt.includes(JSON.stringify(item.validation[0])));
      assert.ok(
        !stalePrompt.includes("Controller readiness in this exact checkout"),
      );
      // A fresh preparation precedes private worker input staging, as in the driver.
      rmSync(join(worker, ".factory-inputs"), { recursive: true, force: true });
      // Restore only through the original real authorized sequence; setup refuses duplication.
      const refreshedReadiness = await validateCheckout(
        worker,
        join(root, "worker-reprepared"),
        baseSha,
        baseTree,
        [setup, probe],
      );
      harnessRequest.sourceDelivery = materializeWorkerSources(worker, {
        item,
        sourceBaseSha: baseSha,
      });
      assert.equal(currentWorkerReadiness(harnessRequest), undefined);
      const refreshed = workerReadinessReceipt({
        request: receiptRequest,
        workerIdentity: "recorded-checkout",
        worktree: worker,
        validationRoot: join(root, "worker-reprepared"),
        evidence: refreshedReadiness,
      });
      assert.ok(
        currentWorkerReadiness({
          ...harnessRequest,
          workerReadiness: refreshed,
        }),
      );
      // Changes to tracked inputs invalidate rendering rather than rewriting proof.
      writeFileSync(
        join(worker, "package.json"),
        `${readFileSync(join(worker, "package.json"), "utf8")}\n`,
      );
      assert.equal(
        currentWorkerReadiness({
          ...harnessRequest,
          workerReadiness: refreshed,
        }),
        undefined,
      );
      writeFileSync(
        join(worker, "package.json"),
        readFileSync(join(checkout, "package.json")),
      );
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
        objectiveCommands: [],
        objectiveBodyDigest: "b".repeat(64),
        approvedPlaybookPin: null,
        approvedPlaybookAdmission: {
          approvedPlaybookPin: null,
          configDigest: factoryConfigDigest({ repository, checkout }),
          graphDigest: originalDigest,
          packetDigest: "c".repeat(64),
          reviewDigest: "d".repeat(64),
          sourcePacketDigest: "e".repeat(64),
        },
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
                    reusableValidationIndices: reusableIndices,
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
      const wrongReusable = structuredClone(state);
      wrongReusable.work[
        item.id
      ].execution.data.request.environmentReadiness.reusableValidationIndices =
        [2];
      assert.throws(
        () => saveState(statePath(repository, 1), wrongReusable),
        /readiness differs from accepted command authority/,
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
      historical.approvedPlaybookAdmission.graphDigest =
        historical.planGraphDigest;
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

test("explicit Codex tiers reach native exec, SDK and app-server without changing model or effort", async (t) => {
  const { Codex } = await import("@openai/codex-sdk");
  const { CaptureWriter } = await import("../dist/capture.js");
  const { readAccountingRecords } = await import("../dist/accounting.js");
  const { codexExecArguments, nativeCodexServiceTier } = await import(
    "../dist/codex-exec.js"
  );
  const { requestedCodexAppServerSettings, verifyCodexAppServerSettings } =
    await import("../dist/codex-app-server.js");
  const { codexWorkerConfiguration } = await import(
    "../dist/execution/worker.js"
  );
  const { codexWorkerInput } = await import("../dist/execution/local.js");
  const { CodexPlanningTransport } = await import(
    "../dist/compiler/codex-transport.js"
  );
  const { codexRuntimeDirectory } = await import(
    "../dist/codex-planning-isolation.js"
  );
  const { validateConfig } = await import("../dist/config.js");
  const root = mkdtempSync(join(tmpdir(), "factory-codex-service-tier-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  execFileSync("git", ["init", "-b", "main", checkout], { stdio: "ignore" });
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/fixture/codex-service-tier.git",
  ]);
  writeFileSync(join(checkout, "README.md"), "# Public tier fixture\n");
  execFileSync("git", ["-C", checkout, "add", "."]);
  execFileSync(
    "git",
    [
      "-C",
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Public fixture",
    ],
    { stdio: "ignore" },
  );
  const model = "gpt-6.1-sol",
    schema = join(root, "output-schema.json");
  writeFileSync(
    schema,
    JSON.stringify({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    { mode: 0o600 },
  );
  // This finite process records genuine SDK argv; it supplies no SDK/provider
  // response and is never consumed as planning or implementation acceptance.
  const recorder = join(root, "record-argv.cjs");
  writeFileSync(
    recorder,
    "#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({argv:process.argv.slice(2)})));\n",
    { mode: 0o700 },
  );
  const native = join(
    codexRuntimeDirectory(),
    "x86_64-unknown-linux-musl",
    "bin",
    "codex",
  );
  const nativeSchemaRoot = join(root, "native-schema");
  const emittedSchema = await subprocessAsync(
    native,
    ["app-server", "generate-json-schema", "--out", nativeSchemaRoot],
    { env: { ...process.env, CODEX_HOME: join(root, "home") } },
  );
  assert.equal(emittedSchema.status, 0);
  for (const name of [
    "ThreadStartParams",
    "ThreadResumeParams",
    "TurnStartParams",
  ]) {
    const shape = JSON.parse(
      readFileSync(join(nativeSchemaRoot, "v2", `${name}.json`), "utf8"),
    );
    assert.deepEqual(shape.properties.serviceTier.type, ["string", "null"]);
  }
  const repository = `fixture/tier-observations-${randomUUID()}`;
  t.after(() =>
    rmSync(stateRoot(repository), { recursive: true, force: true }),
  );
  const selectionDigests = [];
  for (const serviceTier of ["standard", "fast"]) {
    const tier = serviceTier === "standard" ? "default" : "priority";
    for (const reasoningEffort of ["medium", "high"]) {
      const selection = { model, reasoningEffort, serviceTier };
      const config = {
        schemaVersion: 1,
        repository: "fixture/codex-service-tier",
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
      };
      validateConfig(config);
      const options = {
        workingDirectory: checkout,
        model,
        modelReasoningEffort: reasoningEffort,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        serviceTier,
      };
      for (const thread of [undefined, "retained-thread"]) {
        const argv = codexExecArguments(options, schema, thread);
        assert(argv.includes(`service_tier=${JSON.stringify(tier)}`));
        assert(
          argv.includes(
            `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
          ),
        );
        assert.equal(argv[argv.indexOf("--model") + 1], model);
        assert.equal(argv.includes("resume"), Boolean(thread));
        // Actual pinned native parser, help only: no model/native turn is started.
        const help = await subprocessAsync(native, [...argv, "--help"], {
          env: { ...process.env, CODEX_HOME: join(root, "home") },
        });
        assert.equal(help.status, 0);
      }
      const settings = requestedCodexAppServerSettings(options);
      assert.equal(settings.serviceTier, tier);
      assert.equal(settings.model, model);
      assert.equal(settings.config.model_reasoning_effort, reasoningEffort);
      // Settings decoder cases follow the pinned native thread/start contract.
      // They prove binding/refusal, never provider generation or acceptance.
      const reply = {
        ...settings,
        reasoningEffort,
        serviceTier: tier,
        approvalsReviewer: "user",
        sandbox: { type: "readOnly" },
        thread: { id: "public-settings-fixture", status: { type: "idle" } },
      };
      assert.deepEqual(
        verifyCodexAppServerSettings(reply, options),
        reply.thread,
      );
      for (const unknownTier of [null, undefined])
        assert.throws(
          () =>
            verifyCodexAppServerSettings(
              { ...reply, serviceTier: unknownTier },
              options,
            ),
          /effective thread settings differ/,
        );
      assert.deepEqual(
        verifyCodexAppServerSettings(
          { ...reply, serviceTier: null },
          { ...options, serviceTier: undefined },
        ),
        reply.thread,
      );
      const workerConfig = codexWorkerConfiguration(selection, "disabled");
      assert.equal(workerConfig.service_tier, tier);
      assert.equal(workerConfig.features.multi_agent, false);
      const sdk = new Codex({
        codexPathOverride: recorder,
        config: workerConfig,
        env: process.env,
      });
      for (const threadId of [undefined, "retained-thread"]) {
        const lines = [];
        for await (const line of sdk.exec.run({
          input: "",
          workingDirectory: checkout,
          model,
          modelReasoningEffort: reasoningEffort,
          approvalMode: "never",
          threadId,
        }))
          lines.push(line);
        const { argv } = JSON.parse(lines.join("\n"));
        assert(argv.includes(`service_tier=${JSON.stringify(tier)}`));
        assert(
          argv.includes(
            `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
          ),
        );
        assert.equal(argv[argv.indexOf("--model") + 1], model);
        assert.equal(argv.includes("resume"), Boolean(threadId));
      }
      assert.deepEqual(
        codexWorkerInput({ worktree: checkout }, "off", [], selection).model,
        selection,
      );
      const captured = [];
      const invocationId = `native-arguments-${serviceTier}-${reasoningEffort}`;
      const capture = new CaptureWriter(
        {
          repository,
          objective: 1,
          invocationId,
          providerAttempt: 1,
          phase: "native-argument-validation",
          adapter: "local-process",
          configured: { provider: "not-invoked", ...selection },
        },
        { enabled: false },
        [],
        (entry) => captured.push(entry),
      );
      capture.record({ kind: "request" });
      assert.equal(captured[0].configured.serviceTier, serviceTier);
      const accounting = readAccountingRecords(repository, 1).find(
        (entry) => entry.capture?.invocationId === invocationId,
      );
      assert.equal(accounting.capture.configured.serviceTier, serviceTier);
      assert.equal(accounting.capture.reportedServiceTier, undefined);
      const transport = new CodexPlanningTransport(
        checkout,
        selection,
        selection,
        undefined,
        [],
      );
      assert.equal(transport.selection("planner").serviceTier, serviceTier);
      assert.equal(transport.selection("reviewer").serviceTier, serviceTier);
      selectionDigests.push(transport.selectionDigest("planner", false));
      const invalid = structuredClone(config);
      invalid.planning.planner.serviceTier = "priority";
      assert.throws(
        () => validateConfig(invalid),
        /serviceTier is unsupported/,
      );
      const foreignAdapter = structuredClone(config);
      foreignAdapter.execution.harness.kind = "claude-agent-sdk";
      assert.throws(() => validateConfig(foreignAdapter), /serviceTier/);
    }
  }
  assert.equal(new Set(selectionDigests).size, 4);
  const scope = {
    repository,
    objective: 1,
    runId: "owned-selection-contract",
    configDigest: "a".repeat(64),
    graphDigest: "b".repeat(64),
    role: "implementation",
    itemId: "local",
  };
  const initial = {
    attemptId: "same-owned-attempt",
    item: { id: "local" },
    session: { scope, identity: "same-owned-conversation" },
  };
  const standard = new CodexHarness(join(root, "credentials"), "off", {
    model,
    reasoningEffort: "high",
    serviceTier: "standard",
  });
  const fast = new CodexHarness(join(root, "credentials"), "off", {
    model,
    reasoningEffort: "high",
    serviceTier: "fast",
  });
  const admission = await standard.workerSession(initial);
  await assert.rejects(
    fast.workerSession({
      ...initial,
      session: { ...initial.session, retained: admission.ref },
    }),
    /continuation model or permission selection changed/,
  );
  assert.equal(admission.ref.status, "in-flight");
  assert.equal(nativeCodexServiceTier(undefined), undefined);
  assert.throws(
    () => nativeCodexServiceTier("unknown"),
    /Unsupported Codex service tier/,
  );
  const noTier = codexWorkerConfiguration({ model, reasoningEffort: "high" });
  assert.equal(Object.hasOwn(noTier, "service_tier"), false);
  assert.equal(Object.hasOwn(noTier, "instructions"), false);
  assert.equal(Object.hasOwn(noTier, "model_instructions_file"), false);
  assert.equal(
    codexExecArguments({ model }, schema).some((arg) =>
      arg.startsWith("service_tier="),
    ),
    false,
  );
});
