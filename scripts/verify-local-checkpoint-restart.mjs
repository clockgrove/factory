/** Explicit installed-controller restart at a fully accounted, resource-empty pause. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readlinkSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Octokit } from "@octokit/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  boundedPolicy,
  installedBundleIdentity,
  installedIdentity,
  installedPluginPath,
  modelTokenLimit,
  objectiveBodyFor,
  qualificationNamespace,
  qualificationNamespaceMarker,
  waitForCreatedObjectiveNamespace,
} from "./verify-live-objective.mjs";
import {
  authenticatedFaultEvents,
  isQuiescentFaultObjective,
  parseUnitObservation,
} from "./verify-local-faults.mjs";
import { ownedSchedulingScopes, schedulingRequest } from "./verify-local-scheduling.mjs";
import { isQualificationModelMarker, qualificationModelAccounting } from "./qualification-model-accounting.mjs";
import { selectQualificationPublicationRecord } from "./qualification-merge-proof.mjs";
import { observeNativeMergeProofs, assertNativeMergeProof } from "./qualification-sibling-refresh-proof.mjs";
import {
  appServerCheckpointArm,
  appServerCheckpointPath,
  assertAppServerCheckpoint,
  observeAppServerCheckpoints,
} from "./qualification-app-server-checkpoint.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const terminal = new Set(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);
const local = new Set(["codex-sdk/local-worktree", "codex-cli/local-worktree"]);
const safePath = (value) => {
  assert.match(value ?? "", /^\/[A-Za-z0-9_./-]+$/);
  return value;
};
const unique = (items, message) => {
  assert.equal(items.length, 1, message);
  return items[0];
};

export function checkpointAuthority(env) {
  if (env.FACTORY_LOCAL_CHECKPOINT_RESTART !== "1") return null;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"])
    assert.equal(env[key], undefined, "default Linux-home authentication required");
  const repository = env.FACTORY_CHECKPOINT_REPOSITORY;
  assert.match(repository ?? "", /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.notEqual(repository, "clockgrove/factory");
  const checkout = safePath(env.FACTORY_CHECKPOINT_CHECKOUT);
  assert.ok(!checkout.startsWith("/mnt/"));
  const unit = `clockgrove-factory-${hash(`${repository}\0${resolve(checkout)}`).slice(0, 16)}.service`;
  assert.equal(env.FACTORY_CHECKPOINT_CONTROLLER_UNIT, unit, "exact installed controller required");
  const phase = env.FACTORY_CHECKPOINT_PHASE;
  const sessionRecovery = env.FACTORY_CHECKPOINT_BACKEND === "app-server";
  assert.ok(
    env.FACTORY_CHECKPOINT_BACKEND === undefined || sessionRecovery,
    "unsupported checkpoint backend",
  );
  assert.ok(["preflight", "exercise"].includes(phase));
  if (phase === "exercise")
    assert.equal(
      env.FACTORY_CHECKPOINT_ACK,
      `${repository}:${unit}:${sessionRecovery ? "start,arm-terminal-artifact-hold,pause,restart,resume,stop" : "start,pause-drain,restart,resume,stop"}`,
      "explicit lifecycle authority required",
    );
  assert.ok(env.FACTORY_CHECKPOINT_NAMESPACE, "explicit new namespace required");
  const policy = boundedPolicy(
    "regular-prs",
    modelTokenLimit(env.FACTORY_CHECKPOINT_MAX_MODEL_TOKENS),
  );
  if (sessionRecovery) {
    policy.backendOrder = ["codex-app-server/local-worktree"];
    policy.maxParallel = 1;
    policy.capacity.local.maxWorkers = 1;
  }
  assert.ok(policy.capacity.local.maxWorkers <= policy.maxParallel, "invalid qualification worker ceiling");
  return {
    repository,
    checkout,
    unit,
    phase,
    namespace: qualificationNamespace(env.FACTORY_CHECKPOINT_NAMESPACE),
    evidence: safePath(env.FACTORY_CHECKPOINT_EVIDENCE),
    policy,
    ...(sessionRecovery ? { sessionRecovery: true } : {}),
  };
}

class CheckpointPending extends Error {}

export function checkpointOperatorFailure(tool, args, response) {
  assert.equal(response.isError, true);
  const text = (response.content ?? []).filter((part) => part.type === "text")
    .map((part) => part.text).join("\n");
  return {
    tool,
    requestId: args.requestId ?? null,
    isError: true,
    text: text.slice(0, 8192),
    truncated: text.length > 8192,
    observedAt: new Date().toISOString(),
  };
}

export function checkpointFailure(error, boundary) {
  const boundaries = new Set([
    "controller-config",
    "controller-properties",
    "controller-host",
    "controller-state",
    "controller-process-owner",
    "controller-process-executable",
    "controller-process-cwd",
    "controller-process-command",
    "controller-process-birth",
    "controller-process-cgroup",
    "controller-generation",
  ]);
  const codes = new Set([
    "ERR_ASSERTION",
    "EACCES",
    "EPERM",
    "ENOENT",
    "ESRCH",
    "ETIMEDOUT",
    "ABORT_ERR",
  ]);
  return {
    boundary: boundaries.has(boundary) ? boundary : "scenario",
    code: codes.has(error?.code) ? error.code : "UNAVAILABLE",
  };
}

export function assertCheckpointExecutable(pid, expectedNode, readLink = readlinkSync) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.equal(readLink(`/proc/${pid}/exe`), expectedNode);
}

export async function checkpointStartupObservation(
  observe,
  { eligible, diagnostic, record, wait = sleep, now = () => performance.now() },
) {
  const deadline = now() + 1500;
  let pinned;
  let firstDiagnostic;
  for (let attempt = 0; attempt < 4; attempt++) {
    let captured = false;
    try {
      assert.ok(!eligible || now() < deadline, "startup observation deadline exhausted");
      const result = observe(
        (identity) => {
          assert.ok(!captured, "controller identity captured twice");
          captured = true;
          if (pinned)
            assert.deepEqual(
              identity,
              pinned,
              "controller generation changed during startup observation",
            );
          else pinned = structuredClone(identity);
        },
        () => {
          if (!eligible) return 15000;
          assert.ok(now() < deadline, "startup observation deadline exhausted");
          return Math.max(1, Math.floor(deadline - now()));
        },
      );
      assert.ok(!eligible || captured, "startup observation lacks pinned identity");
      assert.ok(!eligible || now() < deadline, "startup observation deadline exhausted");
      if (eligible)
        record({
          firstDiagnostic: firstDiagnostic ?? null,
          attempts: attempt + 1,
          outcome: firstDiagnostic ? "ready-after-observation-retry" : "ready",
          identity: pinned,
        });
      return result;
    } catch (error) {
      const failure = diagnostic(error);
      firstDiagnostic ??= failure;
      const retry =
        eligible &&
        captured &&
        failure.code === "EACCES" &&
        ["controller-process-executable", "controller-process-cwd"].includes(failure.boundary) &&
        attempt < 3 &&
        now() + 100 * (attempt + 1) < deadline;
      if (eligible)
        record({
          firstDiagnostic,
          lastDiagnostic: failure,
          attempts: attempt + 1,
          outcome: retry ? "waiting-same-generation" : "unavailable",
          identity: pinned,
        });
      if (!retry) throw error;
      await wait(100 * (attempt + 1));
    }
  }
  throw Error("startup observation exhausted");
}

export function checkpointReady(observation, authority, pauseRequestId) {
  try {
    checkpointFacts(observation, authority, pauseRequestId, true, true);
    return true;
  } catch (error) {
    if (error instanceof CheckpointPending) return false;
    throw error;
  }
}

export function checkpointCompletionReady(observation, authority, pauseRequestId) {
  const events = observation.receipts.map(({ event }) => event);
  const start = unique(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "one original run required",
  );
  assert.equal(
    observation.status.run.runId,
    start.runId,
    "completion status belongs to another run",
  );
  assert.equal(
    observation.status.summary.runId,
    start.runId,
    "completion summary belongs to another run",
  );
  assert.ok(
    !["cancelled", "escalated"].includes(observation.status.run.state),
    "run ended without completion",
  );
  const outcomes = events.filter((event) => terminal.has(event.event));
  assert.ok(outcomes.length <= 1, "conflicting terminal outcome");
  if (outcomes.length) {
    assert.equal(outcomes[0].runId, start.runId, "terminal receipt belongs to another run");
    assert.equal(outcomes[0].event, "FactoryRunCompleted", "run ended without completion");
  }
  // Comments and installed status are separate bounded reads. Either can lead;
  // neither one-sided observation proves the complete terminal snapshot.
  if (outcomes.length === 0 || observation.status.run.state !== "completed") return false;
  checkpointFacts(observation, authority, pauseRequestId, false);
  return true;
}
export { readQualificationMergeProof as readCheckpointMergeProof } from "./qualification-merge-proof.mjs";

export function checkpointFacts(
  observation,
  authority,
  pauseRequestId,
  requirePaused = true,
  waiting = false,
) {
  const settled = (condition, reason) => {
    if (!condition && waiting) throw new CheckpointPending(reason);
    assert.ok(condition, reason);
  };
  const completedReceipt = (values, reason) => {
    assert.ok(values.length <= 1, reason);
    settled(values.length === 1, reason);
    return values[0];
  };
  const events = observation.receipts.map((receipt) => receipt.event);
  const start = unique(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "one original run required",
  );
  assert.deepEqual(start.policy, authority.policy, "immutable allowance changed");
  assert.equal(start.repository, authority.repository);
  assert.equal(start.objective, observation.status.objective.number);
  assert.equal(start.runId, observation.status.run.runId);
  assert.equal(start.runId, observation.status.summary.runId);
  assert.equal(observation.status.run.policyDigest, start.policyDigest);
  const activation = unique(
    events.filter((event) => event.event === "ActivationRequested"),
    "one exact activation required",
  );
  assert.equal(activation.requestId, `${authority.namespace}-activate`);
  assert.equal(start.activationRequestId, activation.requestId);
  assert.equal(activation.policyDigest, start.policyDigest);
  assert.equal(activation.repository, authority.repository);
  assert.equal(activation.requestedBy.toLowerCase(), start.actor.toLowerCase());
  assert.deepEqual(activation.policy, authority.policy);
  assert.ok(
    events.every((event) => event.runId === start.runId || event === activation),
    "another run appeared",
  );
  const run = events.filter((event) => event.runId === start.runId);
  assert.ok(
    !run.some((event) =>
      [
        "AttemptFailed",
        "AttemptCancelled",
        "AttemptTimedOut",
        "AttemptDeferred",
        "RecoveryRequested",
      ].includes(event.event),
    ),
    "checkpoint must not replace failed or interrupted work",
  );
  const reservations = run.filter((event) => event.event === "AttemptReserved");
  assertScopeCoverage(run);
  const integrated = run.filter((event) => event.event === "AttemptIntegrated");
  assert.ok(integrated.length <= (requirePaused ? 2 : 3));
  assert.equal(
    new Set(reservations.map((event) => event.workItem)).size,
    reservations.length,
    "duplicate execution",
  );
  if (requirePaused) {
    const pause = completedReceipt(
      run.filter(
        (event) => event.event === "RunPauseRequested" && event.requestId === pauseRequestId,
      ),
      "exact pause request missing or repeated",
    );
    const ack = completedReceipt(
      run.filter(
        (event) =>
          event.event === "RunPauseAcknowledged" && event.commandRequestId === pauseRequestId,
      ),
      "drained pause acknowledgement missing or repeated",
    );
    assert.ok(ack.sequence > pause.sequence, "pause acknowledgement precedes request");
    assert.ok(
      !run.some(
        (event) =>
          ["AttemptReserved", "AttemptStarted"].includes(event.event) &&
          event.sequence > ack.sequence,
      ),
      "new admission after pause acknowledgement",
    );
    assert.ok(!run.some((event) => terminal.has(event.event)), "terminal run cannot resume");
  }
  assert.ok(reservations.length >= integrated.length, "integration lacks admission");
  // An acknowledged admission gate can precede deferred PR integration. Keep
  // polling, but never reinterpret contradictory identity/duplicate receipts as pending.
  for (const eventName of [
    "AttemptStarted",
    "PublicationRecorded",
    "AttemptSucceeded",
    "AttemptValidated",
    "ValidationRecorded",
    "AttemptIntegrated",
  ]) {
    const seen = new Set();
    for (const event of run.filter((event) => event.event === eventName)) {
      const key = `${event.workItem}:${event.attempt}`;
      assert.ok(!seen.has(key), `${eventName} repeated`);
      seen.add(key);
    }
  }
  const usageKeys = new Set();
  for (const event of run.filter((event) => event.event === "BudgetReconciled")) {
    const key = JSON.stringify([
      event.workItem,
      event.attempt,
      event.phase,
      event.unit,
      event.usageId,
    ]);
    assert.ok(!usageKeys.has(key), "usage repeated");
    usageKeys.add(key);
    assert.ok(Number.isSafeInteger(event.amount) && event.amount >= 0, "invalid known usage");
  }
  settled(
    integrated.length >= 1 && reservations.length === integrated.length,
    "admitted work remains unsettled",
  );
  const accounting = qualificationModelAccounting(run, {
    requireMarkers: authority.policy.economics?.modelTokenBudgetMode === "observed-stop",
  });
  settled(accounting.unresolved.length === 0, "model dispatch consumption remains unknown");
  const usage = accounting.usage;
  const compile = completedReceipt(
    usage.filter(
      (event) =>
        event.phase === "management" &&
        !event.workItem &&
        /^compile-[a-f0-9]{64}$/.test(event.usageId),
    ),
    "compilation accounting missing or repeated",
  );
  assert.ok(Number.isSafeInteger(compile.amount) && compile.amount >= 0);
  for (const reserved of reservations) {
    assert.equal(reserved.attempt, 1, "qualification never spends a replacement attempt");
    assert.ok(
      authority.sessionRecovery
        ? reserved.backend === "codex-app-server/local-worktree"
        : local.has(reserved.backend),
    );
    const itemEvents = run.filter(
      (event) => event.workItem === reserved.workItem && event.attempt === reserved.attempt,
    );
    unique(
      itemEvents.filter((event) => event.event === "AttemptStarted"),
      "worker launch missing or repeated",
    );
    unique(
      itemEvents.filter((event) => event.event === "PublicationRecorded"),
      "publication missing or repeated",
    );
    for (const [phase, unit] of [
      ["execution", "local_milliseconds"],
      ["validation", "validation_milliseconds"],
    ]) {
      const native = completedReceipt(
        itemEvents.filter(
          (event) =>
            event.event === "BudgetReconciled" && event.phase === phase && event.unit === unit &&
            event.usageId === undefined,
        ),
        "native execution/validation usage missing or repeated",
      );
      assert.ok(Number.isSafeInteger(native.amount) && native.amount >= 0);
      if (unit === "validation_milliseconds") {
        const candidates = itemEvents.filter((event) => event.event === "BudgetReconciled" && event.phase === phase && event.unit === unit && event.usageId !== undefined);
        const identities = new Set();
        for (const candidate of candidates) {
          assert.match(candidate.usageId, /^integration-validation-[a-f0-9]{64}$/);
          assert.ok(!identities.has(candidate.usageId), "candidate validation accounting repeated");
          identities.add(candidate.usageId);
          assert.ok(Number.isSafeInteger(candidate.amount) && candidate.amount >= 0);
        }
      }
    }
    const succeeded = completedReceipt(
      itemEvents.filter((event) => event.event === "AttemptSucceeded"),
      "worker completion missing or repeated",
    );
    unique(
      itemEvents.filter((event) => event.event === "AttemptIntegrated"),
      "integration missing or repeated",
    );
    completedReceipt(
      itemEvents.filter((event) => event.event === "AttemptValidated"),
      "accepted semantic review missing or repeated",
    );
    const validation = completedReceipt(
      itemEvents.filter((event) => event.event === "ValidationRecorded"),
      "validation missing or repeated",
    );
    assert.equal(validation.passed, true);
    const worker = completedReceipt(
      usage.filter(
        (event) =>
          event.workItem === reserved.workItem &&
          event.attempt === 1 &&
          event.phase === "execution",
      ),
      "worker usage missing or repeated",
    );
    const reviews = usage.filter(
        (event) =>
          event.workItem === reserved.workItem &&
          event.attempt === 1 &&
          event.phase === "management" &&
          /^review-[a-f0-9]{64}$/.test(event.usageId),
      );
    completedReceipt(reviews, "original artifact review missing or repeated");
    const candidateReviews = usage.filter((event) => event.workItem === reserved.workItem && event.attempt === 1 && event.phase === "management" && /^integration-review-[a-f0-9]{64}$/.test(event.usageId));
    assert.ok(Number.isSafeInteger(worker.amount) && worker.amount >= 0);
    for (const review of [...reviews, ...candidateReviews])
      assert.ok(Number.isSafeInteger(review.amount) && review.amount >= 0);
    settled(succeeded.reportedModelTokens !== undefined, "terminal worker counter unavailable");
    assert.equal(
      succeeded.reportedModelTokens,
      worker.amount,
      "terminal worker counter unavailable or different",
    );
  }
  assert.ok(usage.every((event) => event === compile || reservations.some((reserved) =>
    event.workItem === reserved.workItem && event.attempt === reserved.attempt &&
    (event.phase === "execution" ||
      (event.phase === "management" && /^(?:integration-)?review-[a-f0-9]{64}$/.test(event.usageId)))
  )), "model usage outside compiled work");
  for (const reserved of run.filter((event) =>
    ["BudgetReserved", "CapacityReserved"].includes(event.event),
  )) {
    if (isQualificationModelMarker(reserved)) continue;
    const expected =
      reserved.event === "BudgetReserved" ? "BudgetReconciled" : "CapacityReconciled";
    settled(
      run.some(
        (event) =>
          event.event === expected &&
          event.sequence > reserved.sequence &&
          [
            "workItem",
            "attempt",
            "phase",
            ...(expected === "BudgetReconciled" ? ["unit", "usageId"] : ["backend"]),
          ].every((key) => event[key] === reserved[key]),
      ),
      "durable native reservation remains unsettled",
    );
  }
  assert.ok(Array.isArray(observation.status.capacity.activeReservations));
  settled(
    observation.status.capacity.activeReservations.length === 0,
    "active reservations remain",
  );
  for (const entry of observation.status.summary.economics.nativeUnits)
    settled(entry.outstanding === 0, "native usage not reconciled");
  const modelTokens = usage.reduce((sum, event) => sum + event.amount, 0);
  assert.equal(observation.status.summary.economics.usage.model_tokens.availability, "observed");
  assert.equal(observation.status.summary.economics.usage.model_tokens.value, modelTokens);
  assert.equal(
    observation.status.summary.economics.modelTokenBreakdown.reconciledCalls,
    usage.length,
  );
  assert.ok(
    modelTokens < authority.policy.economics.maxModelTokens,
    "original allowance exhausted",
  );
  assert.equal(
    unique(
      run.filter((event) => event.event === "GraphCompiled"),
      "compilation repeated",
    ).baseSha,
    activation.baseSha,
  );
  unique(
    run.filter((event) => event.event === "GraphProjected" && event.graphSize === 3),
    "graph changed",
  );
  if (requirePaused) {
    assert.ok(!run.some((event) => terminal.has(event.event)), "terminal run cannot resume");
    assert.equal(observation.status.run.state, "paused");
  } else {
    assert.equal(integrated.length, 3);
    assert.equal(
      run.filter((event) => terminal.has(event.event)).length,
      1,
      "conflicting terminal outcome",
    );
    unique(
      run.filter((event) => event.event === "FactoryRunCompleted"),
      "completion missing or repeated",
    );
    assert.equal(observation.status.run.state, "completed");
    assert.equal(observation.status.objective.closed, true);
  }
  return {
    runId: start.runId,
    modelTokens,
    integrated: integrated.length,
    stable: run.filter((event) =>
      ["attempt", "validation", "budget", "publication", "graph"].includes(event.kind),
    ),
  };
}

export async function runCheckpointScenario(port, authority) {
  if (authority.sessionRecovery) return runAppServerCheckpointScenario(port, authority);
  // The adapter persists each requested side effect before invoking it. A fresh
  // evidence file is mandatory; this orchestration has no retry/re-entry path.
  const before = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", before };
  await port.action("start");
  const original = await port.controller("active");
  await port.action("create");
  await port.action("activate");
  await port.poll("worker-start", (observation) =>
    observation.receipts.some(({ event }) => event.event === "AttemptStarted"),
  );
  await port.action("pause");
  const checkpoint = await port.poll("accounted-pause", (observation) =>
    checkpointReady(observation, authority, port.pauseRequestId),
  );
  const facts = checkpointFacts(checkpoint, authority, port.pauseRequestId);
  const scopes = await port.absence(checkpoint, [original]);
  await port.checkpoint({ checkpoint, facts, original, scopes });
  await port.controller("active", original);
  await port.action("restart");
  const replacement = await port.controller("active");
  assert.notEqual(replacement.invocationId, original.invocationId, "controller did not restart");
  assert.equal(replacement.hostIdentity, original.hostIdentity, "host changed");
  await port.takeover(checkpoint);
  const paused = await port.observe();
  assert.deepEqual(
    checkpointFacts(paused, authority, port.pauseRequestId).stable,
    facts.stable,
    "paused restart repeated work or accounting",
  );
  await port.absence(paused, [original]);
  await port.controller("active", replacement);
  await port.action("resume");
  const completed = await port.poll("completed", (observation) =>
    checkpointCompletionReady(observation, authority, port.pauseRequestId),
  );
  const final = checkpointFacts(completed, authority, port.pauseRequestId, false);
  assert.equal(final.runId, facts.runId, "replacement run forbidden");
  for (const event of facts.stable)
    assert.ok(
      final.stable.some((candidate) => JSON.stringify(candidate) === JSON.stringify(event)),
      "checkpoint receipt changed or disappeared",
    );
  const priorItems = new Set(
    checkpoint.receipts
      .filter(({ event }) => event.event === "AttemptReserved")
      .map(({ event }) => event.workItem),
  );
  assert.deepEqual(
    final.stable.filter((event) => priorItems.has(event.workItem)),
    facts.stable.filter((event) => priorItems.has(event.workItem)),
    "completed work was repeated after restart",
  );
  await port.finalProof(completed, original, replacement);
  const finalScopes = await port.absence(completed, [original, replacement]);
  await port.controller("active", replacement);
  await port.action("stop");
  const stopped = await port.controller("inactive");
  return {
    result: "passed",
    checkpoint: facts,
    final,
    original,
    replacement,
    scopes,
    finalScopes,
    stopped,
  };
}

export function appServerHoldReady(observation, authority, arm) {
  const witness = observation.checkpointReached;
  if (!witness) return false;
  assert.equal(witness.armDigest, arm.digest);
  const events = observation.receipts.map(({ event }) => event);
  const start = unique(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "one original run required",
  );
  assert.deepEqual(start.policy, authority.policy);
  assert.equal(start.repository, authority.repository);
  assert.equal(start.activationRequestId, `${authority.namespace}-activate`);
  assert.equal(start.runId, witness.runId);
  assert.equal(start.runId, observation.status.run.runId);
  assert.equal(start.policyDigest, witness.policyDigest);
  assert.equal(start.objective, witness.objective);
  const reserved = unique(
    events.filter((event) => event.event === "AttemptReserved"),
    "one held original attempt required",
  );
  assert.equal(reserved.workItem, witness.workItem);
  assert.equal(reserved.attempt, 1);
  assert.equal(reserved.backend, "codex-app-server/local-worktree");
  assert.ok(
    !events.some(
      (event) =>
        terminal.has(event.event) ||
        [
          "AttemptFailed",
          "AttemptCancelled",
          "AttemptDeferred",
          "AttemptCollected",
          "ValidationRecorded",
          "PublicationRecorded",
        ].includes(event.event) ||
        (event.event === "CapacityReserved" && event.phase === "validation"),
    ),
    "checkpoint already crossed validation or terminal boundary",
  );
  for (const eventName of ["AttemptStarted", "AttemptSucceeded"])
    unique(
      events.filter((event) => event.event === eventName),
      "held worker receipt missing or repeated",
    );
  unique(
    events.filter(
      (event) =>
        event.event === "RunPauseRequested" && event.requestId === `${authority.namespace}-pause`,
    ),
    "pause request missing",
  );
  return true;
}

export async function runAppServerCheckpointScenario(port, authority) {
  const before = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", before };
  await port.action("start");
  const original = await port.controller("active");
  await port.action("create");
  const arm = await port.armSession(original);
  await port.action("activate");
  await port.poll("worker-start", (value) =>
    value.receipts.some(({ event }) => event.event === "AttemptStarted"),
  );
  await port.action("pause");
  const held = await port.poll("terminal-artifact-hold", (value) =>
    appServerHoldReady(value, authority, arm),
  );
  const sessionProofs = await port.sessionProof(held, held.checkpointReached);
  assert.equal(sessionProofs.length, 1);
  const scopes = await port.absence(held, [original], true);
  const originalEvents = held.receipts
    .map(({ event }) => event)
    .filter((event) => ["attempt", "budget", "graph"].includes(event.kind));
  await port.checkpoint({
    checkpoint: held,
    facts: { runId: held.status.run.runId, stable: originalEvents },
    original,
    scopes,
    sessionProofs,
  });
  await port.controller("active", original);
  await port.action("restart");
  const replacement = await port.controller("active");
  assert.notEqual(replacement.invocationId, original.invocationId);
  assert.equal(replacement.hostIdentity, original.hostIdentity);
  await port.takeover(held);
  const paused = await port.poll("recovered-accounted-pause", (value) =>
    checkpointReady(value, authority, port.pauseRequestId),
  );
  const facts = checkpointFacts(paused, authority, port.pauseRequestId);
  assert.equal(facts.runId, held.status.run.runId);
  for (const event of originalEvents)
    assert.ok(
      facts.stable.some((current) => JSON.stringify(current) === JSON.stringify(event)),
      "original worker receipt changed",
    );
  const resumedProofs = await port.sessionProof(paused, held.checkpointReached);
  assert.deepEqual(
    resumedProofs,
    sessionProofs,
    "session or ready artifact changed across same-attempt continuation",
  );
  await port.absence(paused, [original, replacement]);
  await port.controller("active", replacement);
  await port.action("resume");
  const completed = await port.poll("completed", (value) =>
    checkpointCompletionReady(value, authority, port.pauseRequestId),
  );
  const final = checkpointFacts(completed, authority, port.pauseRequestId, false);
  assert.equal(final.runId, facts.runId);
  const finalSessionProofs = await port.sessionProof(completed);
  assert.equal(finalSessionProofs.length, 3);
  assert.deepEqual(
    finalSessionProofs.find((proof) => proof.workItem === sessionProofs[0].workItem),
    sessionProofs[0],
  );
  await port.finalProof(completed, original, replacement);
  const finalScopes = await port.absence(completed, [original, replacement]);
  await port.controller("active", replacement);
  await port.action("stop");
  const stopped = await port.controller("inactive");
  return {
    result: "passed",
    scope: "installed-app-server-terminal-artifact-recovery",
    checkpoint: facts,
    final,
    sessionProofs,
    finalSessionProofs,
    original,
    replacement,
    scopes,
    finalScopes,
    stopped,
  };
}

export function assertScopeCoverage(events) {
  const reservations = events.filter((event) => event.event === "AttemptReserved");
  for (const event of events.filter(
    (event) =>
      event.localScopeBatch || (event.event === "CapacityReserved" && event.phase === "validation"),
  )) {
    assert.equal(
      reservations.filter(
        (reserved) => reserved.workItem === event.workItem && reserved.attempt === event.attempt,
      ).length,
      1,
      "scoped receipt lacks one exact execution partition",
    );
  }
}

export function checkpointLease(commit, oid) {
  assert.match(oid, /^[a-f0-9]{40}$/);
  assert.equal(commit.sha, oid);
  const trailer = unique(
    commit.message.split(/\r?\n/).filter((line) => line.startsWith("Factory-Repository-Lease: ")),
    "repository lease unavailable",
  );
  assert.ok(trailer.length < 8192);
  const lease = JSON.parse(
    Buffer.from(trailer.slice("Factory-Repository-Lease: ".length), "base64url").toString("utf8"),
  );
  assert.equal(lease.protocol, "clockgrove.factory/v2");
  assert.equal(lease.kind, "repository-lease");
  assert.match(lease.policyDigest, /^[a-f0-9]{64}$/);
  assert.ok(
    typeof lease.controllerId === "string" &&
      lease.controllerId.length > 0 &&
      lease.controllerId.length <= 160,
  );
  assert.ok(Number.isSafeInteger(lease.sequence) && lease.sequence > 0);
  assert.ok(Number.isSafeInteger(lease.epoch) && lease.epoch > 0);
  assert.ok(
    ["RepositoryLeaseAcquired", "RepositoryLeaseRenewed", "RepositoryLeaseReleased"].includes(
      lease.event,
    ),
  );
  assert.ok(typeof lease.expiresAt === "string" && Number.isFinite(Date.parse(lease.expiresAt)));
  return lease;
}

function command(name, args, cwd, timeoutMs = 15000) {
  try {
    return execFileSync(name, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1048576,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (
      name === "systemctl" &&
      args[1] === "show" &&
      [1, 4].includes(error.status) &&
      typeof error.stdout === "string" &&
      Buffer.byteLength(error.stdout) <= 65536
    )
      return error.stdout.trim();
    throw Object.assign(Error("bounded local operation unavailable"), {
      code: checkpointFailure(error).code,
    });
  }
}
function readBounded(path, maximum = 65536) {
  const size = statSync(path).size;
  assert.ok(size <= maximum);
  const text = readFileSync(path, "utf8");
  assert.ok(Buffer.byteLength(text) <= maximum);
  return text;
}
function hostIdentity() {
  const machine = readBounded("/etc/machine-id", 128).trim();
  const boot = readBounded("/proc/sys/kernel/random/boot_id", 128).trim();
  assert.match(machine, /^[a-f0-9]{32}$/);
  assert.match(boot, /^[a-f0-9-]{36}$/);
  const namespaces = ["pid", "user", "mnt"].map((name) => readlinkSync(`/proc/self/ns/${name}`));
  for (let i = 0; i < 3; i++)
    assert.match(namespaces[i], new RegExp(`^${["pid", "user", "mnt"][i]}:\\[\\d+\\]$`));
  return createHmac("sha256", "clockgrove.factory/local-resource-host-v1")
    .update(JSON.stringify([machine, process.getuid(), boot, ...namespaces]))
    .digest("hex");
}

export function assertControllerUnit(body, expected) {
  assert.ok(Buffer.byteLength(body) <= 16384);
  const environments = body.split("\n").filter((line) => line.startsWith("Environment="));
  assert.ok(environments.length >= 1 && environments.length <= 2);
  assert.ok(environments[0].startsWith('Environment="PATH='));
  if (environments.length === 2)
    assert.ok(environments[1].startsWith('Environment="FACTORY_CODEX_PATH='));
  for (const line of environments)
    assert.match(
      line,
      /^Environment="(?:PATH=\/[A-Za-z0-9_./:-]+|FACTORY_CODEX_PATH=\/[A-Za-z0-9_./-]+)"$/,
    );
  const rendered = `# Managed by Clockgrove Factory v2\n[Unit]\nDescription=Clockgrove Factory repository controller for ${expected.repository}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${expected.checkout}\n${environments.map((line) => `${line}\n`).join("")}ExecStart="${expected.node}" "${expected.bundle}" controller run "${expected.repository}" --repo "${expected.checkout}"\nRestart=on-failure\nRestartPreventExitStatus=2 130\nRestartSec=30\nTimeoutStopSec=90\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
  assert.equal(body, rendered, "controller config differs from exact installed identity");
  return hash(body);
}

// Extensions are committed qualification adapters, never a plugin/runtime API or
// input loaded from an operator-supplied module. They reuse this installed-client,
// controller-identity, evidence and lifecycle boundary for additional fixtures.
export async function main(env = process.env, runner = runCheckpointScenario, extension = {}) {
  const authority = extension.authority ?? checkpointAuthority(env);
  if (!authority) {
    console.log("Not exercised: explicit checkpoint-restart opt-in required.");
    return;
  }
  assert.equal(process.platform, "linux");
  const home = realpathSync(homedir());
  assert.ok(!home.startsWith("/mnt/"));
  if (env.CODEX_HOME) assert.equal(realpathSync(env.CODEX_HOME), join(home, ".codex"));
  assert.equal(realpathSync(authority.checkout), authority.checkout);
  const parent = statSync(dirname(authority.evidence));
  assert.equal(parent.uid, process.getuid());
  assert.equal(parent.mode & 0o077, 0);
  const listed = JSON.parse(command("codex", ["plugin", "list", "--json"], authority.checkout));
  const pluginRoot = installedPluginPath({ listed, codexHome: join(home, ".codex") });
  const manifest = JSON.parse(readBounded(join(pluginRoot, ".codex-plugin/plugin.json")));
  installedIdentity({
    listed,
    codexHome: join(home, ".codex"),
    pluginRoot,
    manifest,
    portable: JSON.parse(readBounded(join(pluginRoot, "plugin.json"))),
    packageManifest: JSON.parse(readBounded(join(pluginRoot, "package.json"))),
  });
  const artifact = installedBundleIdentity(pluginRoot);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(
    hash(readFileSync(join(root, "dist/bundle-inventory.json"), "utf8")),
    artifact.inventorySha256,
  );
  assert.equal(
    command("git", ["status", "--porcelain", "--untracked-files=no"], root),
    "",
    "harness must be committed",
  );
  const sourceCommit = command("git", ["rev-parse", "HEAD"], root);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const harnessPath = "scripts/verify-local-checkpoint-restart.mjs";
  assert.equal(command("git", ["ls-files", "--error-unmatch", harnessPath], root), harnessPath);
  assert.equal(
    command("git", ["show", `HEAD:${harnessPath}`], root),
    readBounded(fileURLToPath(import.meta.url), 262144).trim(),
  );
  const harnessFiles = [
    harnessPath,
    "scripts/qualification-model-accounting.mjs",
    "scripts/qualification-receipts.mjs",
    "scripts/qualification-sibling-refresh-proof.mjs",
    "scripts/qualification-merge-proof.mjs",
    ...(authority.sessionRecovery
      ? [
          "scripts/qualification-app-server-checkpoint.mjs",
        ]
      : []),
    ...(extension.harnessPaths ?? []),
  ].map((path) => {
    assert.match(path, /^scripts\/[A-Za-z0-9_.-]+\.mjs$/);
    const bytes = readBounded(join(root, path), 262144);
    assert.equal(
      command("git", ["show", `HEAD:${path}`], root),
      bytes.trim(),
      "qualification dependency differs from committed source",
    );
    return { path, sha256: hash(bytes) };
  });
  const token = command("gh", ["auth", "token"], authority.checkout);
  const [owner, repo] = authority.repository.split("/");
  const octokit = new Octokit({
    auth: token,
    request: { headers: { "X-GitHub-Api-Version": "2026-03-10" } },
  });
  const request = (route, args = {}) =>
    schedulingRequest(
      { request: (r, p) => octokit.request(r, { owner, repo, ...p }) },
      route,
      args,
    );
  const list = async (route, args = {}) => {
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await request(route, { ...args, page, per_page: 100 });
      assert.ok(Array.isArray(data));
      rows.push(...data);
      if (data.length < 100) return rows;
    }
    throw Error("complete bounded GitHub listing unavailable");
  };
  const evidence = {
    protocol: "clockgrove.factory/checkpoint-restart-qualification-v1",
    authority,
    artifact,
    sourceCommit,
    harnessSha256: hash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    harnessFiles,
    actions: [],
    startedAt: new Date().toISOString(),
  };
  // Exclusive creation bars replay of uncertain start/activation/restart/resume.
  const evidenceFd = openSync(
    authority.evidence,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const save = () => {
    const text = JSON.stringify(evidence, null, 2).replaceAll(token, "[REDACTED]");
    assert.ok(Buffer.byteLength(text) <= 8 * 1024 * 1024);
    const meta = fstatSync(evidenceFd);
    assert.equal(meta.uid, process.getuid());
    assert.equal(meta.mode & 0o777, 0o600);
    assert.equal(meta.nlink, 1);
    assert.ok(meta.isFile());
    ftruncateSync(evidenceFd, 0);
    writeSync(evidenceFd, `${text}\n`, 0, "utf8");
  };
  const mcp = manifest.mcpServers.factory;
  assert.equal(mcp.command, "node");
  const client = new Client({ name: "factory-checkpoint-restart", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", pluginRoot)),
    cwd: authority.checkout,
    env: { ...env, CODEX_HOME: join(home, ".codex"), GITHUB_TOKEN: token },
    stderr: "pipe",
  });
  const expected = {
    ...authority,
    node: realpathSync(process.execPath),
    bundle: realpathSync(join(pluginRoot, "dist/factory.js")),
  };
  const unitPath = join(home, ".config/systemd/user", authority.unit);
  let controllerBoundary;
  const controller = async (state, prior) => {
    const eligible = state === "active" && !prior;
    const observation = { state, priorBound: Boolean(prior) };
    return checkpointStartupObservation(
      (capture, remainingMs) => {
        controllerBoundary = "controller-config";
        const meta = statSync(unitPath);
        assert.equal(meta.uid, process.getuid());
        assert.ok(meta.isFile());
        const configDigest = assertControllerUnit(readBounded(unitPath, 16384), expected);
        if (evidence.configDigest) assert.equal(configDigest, evidence.configDigest);
        controllerBoundary = "controller-properties";
        const raw = command(
          "systemctl",
          [
            "--user",
            "show",
            authority.unit,
            "--property=Id,LoadState,ActiveState,SubState,Job,InvocationID,ControlGroup,MainPID,KillMode,FragmentPath,DropInPaths,NeedDaemonReload",
          ],
          undefined,
          remainingMs(),
        );
        const fields = Object.fromEntries(
          raw.split("\n").map((line) => {
            const i = line.indexOf("=");
            assert.ok(i > 0);
            return [line.slice(0, i), line.slice(i + 1)];
          }),
        );
        assert.equal(
          Object.keys(fields).length,
          raw.split("\n").length,
          "duplicate controller property",
        );
        assert.equal(fields.Id, authority.unit);
        assert.equal(fields.LoadState, "loaded");
        assert.equal(fields.FragmentPath, unitPath);
        assert.equal(fields.DropInPaths, "");
        assert.equal(fields.NeedDaemonReload, "no");
        assert.equal(fields.KillMode, "control-group");
        assert.ok(["", "0", "0 /"].includes(fields.Job));
        controllerBoundary = "controller-host";
        const host = hostIdentity();
        if (prior) assert.equal(host, prior.hostIdentity);
        controllerBoundary = "controller-state";
        if (state === "inactive") {
          assert.equal(fields.ActiveState, "inactive");
          assert.equal(fields.MainPID, "0");
          assert.equal(fields.ControlGroup, "");
          controllerBoundary = undefined;
          return { unit: authority.unit, state, hostIdentity: host, configDigest };
        }
        assert.equal(fields.ActiveState, "active");
        assert.match(fields.InvocationID, /^[a-f0-9]{32}$/);
        const pid = Number(fields.MainPID);
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        controllerBoundary = "controller-process-owner";
        assert.equal(statSync(`/proc/${pid}`).uid, process.getuid());
        controllerBoundary = "controller-process-birth";
        const stat = readBounded(`/proc/${pid}/stat`);
        assert.ok(stat.startsWith(`${pid} (`));
        const startTicks = stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)[19];
        assert.match(startTicks, /^\d+$/);
        controllerBoundary = "controller-process-cgroup";
        assert.ok(fields.ControlGroup.endsWith(`/${authority.unit}`));
        assert.ok(
          readBounded(`/proc/${pid}/cgroup`).split("\n").includes(`0::${fields.ControlGroup}`),
        );
        const result = {
          unit: authority.unit,
          state,
          pid,
          startTicks,
          invocationId: fields.InvocationID,
          hostIdentity: host,
          configDigest,
        };
        controllerBoundary = "controller-generation";
        if (prior)
          for (const key of [
            "unit",
            "pid",
            "startTicks",
            "invocationId",
            "hostIdentity",
            "configDigest",
          ])
            assert.equal(result[key], prior[key], "controller generation changed");
        capture(result);
        controllerBoundary = "controller-process-executable";
        assertCheckpointExecutable(pid, expected.node);
        controllerBoundary = "controller-process-cwd";
        assert.equal(readlinkSync(`/proc/${pid}/cwd`), authority.checkout);
        controllerBoundary = "controller-process-command";
        assert.deepEqual(readBounded(`/proc/${pid}/cmdline`).split("\0").filter(Boolean), [
          expected.node,
          expected.bundle,
          "controller",
          "run",
          authority.repository,
          "--repo",
          authority.checkout,
        ]);
        controllerBoundary = undefined;
        return result;
      },
      {
        eligible,
        diagnostic: (error) => checkpointFailure(error, controllerBoundary),
        record: (value) => {
          if (!evidence.controllerReadiness) evidence.controllerReadiness = [];
          if (!evidence.controllerReadiness.includes(observation))
            evidence.controllerReadiness.push(observation);
          Object.assign(observation, value);
          save();
        },
      },
    );
  };
  const invoke = async (name, args = {}) =>
    client.callTool({ name, arguments: { owner, repo, ...args } }, undefined, {
      timeout: 120000,
      maxTotalTimeout: 120000,
    });
  const call = async (name, args = {}) => {
    const response = await invoke(name, args);
    if (response.isError) {
      evidence.operatorFailure = checkpointOperatorFailure(name, args, response);
      save();
    }
    assert.ok(!response.isError, "installed operator call unavailable");
    return JSON.parse(
      response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  };
  const observe = async () => {
    const objective = (
      await request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        issue_number: evidence.objective.number,
      })
    ).data;
    assert.equal(objective.user.id, evidence.actor.id);
    assert.equal(hash(objective.body), evidence.objectiveBodyDigest);
    const children = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
      issue_number: objective.number,
    });
    assert.ok(children.length <= 3);
    const comments = [];
    for (const issue of [objective, ...children])
      comments.push(
        ...(await list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          issue_number: issue.number,
        })),
      );
    const observation = {
      receipts: authenticatedFaultEvents(comments, evidence.actor, objective.number),
      status: await call("factory_status", { objectiveNumber: objective.number }),
      children: children.map(({ number, state }) => ({ number, state })),
    };
    if (evidence.sessionArm) {
      try {
        observation.checkpointReached = JSON.parse(
          readBounded(`${evidence.sessionArm.path}.reached`, 16384),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await extension.observe?.({ observation, evidence, authority });
    evidence.latest = observation;
    save();
    return observation;
  };
  const pauseRequestId = `${authority.namespace}-pause`;
  const port = {
    pauseRequestId,
    observe,
    controller,
    armSession: async (original) => {
      assert.equal(authority.sessionRecovery, true);
      assert.ok(!evidence.sessionArm, "qualification checkpoint must not be rearmed");
      await controller("active", original);
      const path = appServerCheckpointPath(original.unit, original.invocationId),
        directory = dirname(path);
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      assert.equal(realpathSync(directory), directory);
      const meta = statSync(directory);
      assert.equal(meta.uid, process.getuid());
      assert.equal(meta.mode & 0o777, 0o700);
      const arm = appServerCheckpointArm(authority, original, evidence.objective.number),
        bytes = JSON.stringify(arm);
      // Evidence is persisted before the one exclusive private fault-arm write.
      evidence.sessionArm = {
        path,
        arm,
        digest: hash(bytes),
        requestedAt: new Date().toISOString(),
      };
      save();
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      evidence.sessionArm.writtenAt = new Date().toISOString();
      save();
      return evidence.sessionArm;
    },
    sessionProof: async (observation, witness) => {
      assert.equal(authority.sessionRecovery, true);
      const proofs = await observeAppServerCheckpoints(request, observation, authority, witness);
      (evidence.sessionObservations ??= []).push({
        at: new Date().toISOString(),
        runId: observation.status.run.runId,
        proofs,
      });
      save();
      return proofs.map((proof) =>
        assertAppServerCheckpoint(
          observation,
          authority,
          proof,
          witness?.workItem === proof.workItem ? witness : undefined,
        ),
      );
    },
    preflight: async () => {
      const repository = (await request("GET /repos/{owner}/{repo}")).data;
      assert.ok(repository.private && !repository.archived && repository.permissions?.push);
      evidence.actor = (await request("GET /user")).data;
      evidence.actor = { id: evidence.actor.id, login: evidence.actor.login };
      assert.equal(command("git", ["status", "--porcelain"], authority.checkout), "");
      const origin = command("git", ["remote", "get-url", "origin"], authority.checkout).replace(
        /\.git$/,
        "",
      );
      assert.ok(
        [
          `https://github.com/${authority.repository}`,
          `git@github.com:${authority.repository}`,
        ].includes(origin),
      );
      evidence.base = (
        await request("GET /repos/{owner}/{repo}/commits/{ref}", { ref: repository.default_branch })
      ).data.sha;
      assert.equal(command("git", ["rev-parse", "HEAD"], authority.checkout), evidence.base);
      const issues = await list("GET /repos/{owner}/{repo}/issues", { state: "all" });
      assert.ok(
        !issues.some((issue) =>
          issue.body?.includes(qualificationNamespaceMarker(authority.namespace)),
        ),
      );
      for (const issue of issues.filter(
        (issue) =>
          issue.state === "open" &&
          issue.labels?.some((label) => label.name === "factory:objective"),
      )) {
        const status = await call("factory_status", { objectiveNumber: issue.number });
        assert.ok(
          isQuiescentFaultObjective(status, authority.repository, issue.number),
          "another Objective has runnable authority",
        );
      }
      assert.equal((await list("GET /repos/{owner}/{repo}/pulls", { state: "open" })).length, 0);
      const lifecycle = await call("factory_controller_status", {
        repository: authority.checkout,
        requestId: `${authority.namespace}-inspect`,
      });
      assert.equal(lifecycle.unit, authority.unit);
      assert.ok(lifecycle.installed && !lifecycle.active);
      const state = await controller("inactive");
      evidence.configDigest = state.configDigest;
      await extension.preflight?.({ authority, evidence, request, list, command, save });
      save();
      return state;
    },
    action: async (action) => {
      assert.ok(
        !evidence.actions.some((entry) => entry.action === action),
        "uncertain action must never be repeated",
      );
      evidence.actions.push({ action, requestedAt: new Date().toISOString() });
      save();
      let result;
      if (["start", "restart", "stop"].includes(action))
        result = await call(`factory_controller_${action}`, {
          repository: authority.checkout,
          requestId: `${authority.namespace}-${action}`,
        });
      else if (action === "create") {
        const body = extension.objectiveBody
          ? extension.objectiveBody(authority)
          : objectiveBodyFor(authority.namespace);
        assert.equal(typeof body, "string");
        assert.ok(body.includes(qualificationNamespaceMarker(authority.namespace)));
        assert.ok(Buffer.byteLength(body) <= 65536);
        result = (
          await request("POST /repos/{owner}/{repo}/issues", {
            title: `Factory checkpoint restart [${authority.namespace}]`,
            body,
          })
        ).data;
        evidence.objective = { number: result.number, id: result.id, node_id: result.node_id };
        evidence.objectiveBodyDigest = hash(body);
        save();
        await waitForCreatedObjectiveNamespace({
          list,
          namespace: authority.namespace,
          createdIssue: result,
        });
      } else if (action === "activate") {
        const args = {
          objectiveNumber: evidence.objective.number,
          requestId: `${authority.namespace}-activate`,
          baseSha: evidence.base,
          policy: authority.policy,
        };
        evidence.runRequest = { tool: "factory_activate", arguments: { owner, repo, ...args } };
        save();
        result = await call("factory_activate", args);
      } else
        result = await call(`factory_${action}`, {
          objectiveNumber: evidence.objective.number,
          requestId: `${authority.namespace}-${action}`,
        });
      evidence.actions.at(-1).returnedAt = new Date().toISOString();
      evidence.actions.at(-1).response = result;
      save();
    },
    poll: async (phase, accept) => {
      const deadline = Math.min(
        Date.now() + (phase === "worker-start" ? 240000 : 2700000),
        Date.parse(evidence.startedAt) + 2700000,
      );
      for (let count = 0; count < 270; count++) {
        const observation = await observe();
        if (accept(observation)) return observation;
        assert.ok(
          !observation.receipts.some(
            ({ event }) =>
              terminal.has(event.event) &&
              !(phase === "completed" && event.event === "FactoryRunCompleted"),
          ),
          "run ended before checkpoint qualification",
        );
        assert.ok(Date.now() < deadline, "bounded checkpoint observation incomplete");
        await sleep(5000);
      }
      throw Error("bounded checkpoint polling exhausted");
    },
    checkpoint: async (value) => {
      evidence.checkpoint = value;
      save();
    },
    takeover: async (checkpoint) => {
      const old = checkpoint.receipts
        .map(({ event }) => event)
        .filter((event) => event.event === "ControllerObserved")
        .at(-1);
      assert.ok(old, "original authenticated controller identity missing");
      for (let attempt = 0; attempt < 10; attempt++) {
        const ref = (
          await request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
            ref: "clockgrove-factory/leases/repository-controller",
          })
        ).data;
        const commit = (
          await request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
            commit_sha: ref.object.sha,
          })
        ).data;
        const lease = checkpointLease(commit, ref.object.sha);
        assert.equal(lease.policyDigest, old.controllerPolicyDigest);
        if (
          ["RepositoryLeaseAcquired", "RepositoryLeaseRenewed"].includes(lease.event) &&
          lease.controllerId !== old.controllerId &&
          lease.epoch > old.epoch &&
          Date.parse(lease.expiresAt) > Date.now() + 60000
        ) {
          evidence.takeover = { oid: commit.sha, lease };
          save();
          return;
        }
        await sleep(1000);
      }
      throw Error("bounded new repository-controller lease not observed");
    },
    absence: async (observation, controllers, executionOnly = false) => {
      const runId = observation.status.run.runId;
      const events = observation.receipts
        .map(({ event }) => event)
        .filter((event) => event.runId === runId);
      const reservations = events.filter((event) => event.event === "AttemptReserved");
      assertScopeCoverage(events);
      const units = new Set();
      if (authority.sessionRecovery) {
        const scoped = events.filter((event) => event.localScopeBatch);
        assert.ok(
          scoped.every(
            (event) =>
              controllers.filter(
                (producer) =>
                  event.localScopeBatch.identity.producerInvocationId === producer.invocationId,
              ).length === 1,
          ),
          "scope producer missing or ambiguous",
        );
        for (const producer of controllers) {
          const owned = scoped.filter(
            (event) =>
              event.localScopeBatch.identity.producerInvocationId === producer.invocationId,
          );
          if (!owned.length) continue;
          const validationKeys = new Set(
            owned
              .filter((event) => event.event === "CapacityReserved" && event.phase === "validation")
              .map((event) => `${event.workItem}:${event.attempt}`),
          );
          const subset = [
            ...owned,
            ...events.filter(
              (event) =>
                !event.localScopeBatch &&
                validationKeys.has(`${event.workItem}:${event.attempt}`) &&
                ["AttemptCollected", "ValidationRecorded"].includes(event.event),
            ),
          ];
          for (const event of owned)
            assert.equal(event.localScopeBatch.identity.hostIdentity, hostIdentity());
          for (const unit of ownedSchedulingScopes(
            {
              repository: authority.repository,
              objective: evidence.objective,
              runResult: { runId },
              events: subset,
            },
            producer,
          ))
            units.add(unit);
        }
      } else {
        for (const producer of controllers) {
          const owned = reservations.filter(
            (event) =>
              event.localScopeBatch?.identity.producerInvocationId === producer.invocationId,
          );
          const keys = new Set(owned.map((event) => `${event.workItem}:${event.attempt}`));
          const subset = events.filter((event) => keys.has(`${event.workItem}:${event.attempt}`));
          if (!owned.length) continue;
          for (const event of subset.filter((event) => event.localScopeBatch))
            assert.equal(event.localScopeBatch.identity.hostIdentity, hostIdentity());
          for (const unit of ownedSchedulingScopes(
            {
              repository: authority.repository,
              objective: evidence.objective,
              runResult: { runId },
              events: subset,
            },
            producer,
          ))
            units.add(unit);
        }
      }
      assert.ok(
        reservations.every((event) =>
          controllers.some(
            (producer) =>
              producer.invocationId === event.localScopeBatch?.identity.producerInvocationId,
          ),
        ),
        "unowned execution reservation",
      );
      const observations = [...units]
        .sort()
        .map((unit) =>
          parseUnitObservation(
            unit,
            command("systemctl", [
              "--user",
              "show",
              unit,
              "--property=Id,LoadState,ActiveState,SubState,ControlGroup,Job,InvocationID,KillMode",
            ]),
          ),
        );
      assert.ok(
        observations.length >= reservations.length * (executionOnly ? 1 : 2) &&
          observations.every((entry) => entry.status === "absent"),
        "exact worker/validator absence unproved",
      );
      return observations;
    },
    finalProof: async (observation, original, replacement) => {
      const events = observation.receipts.map(({ event }) => event);
      const before = evidence.checkpoint.checkpoint.receipts
        .map(({ event }) => event)
        .filter((event) => event.event === "ControllerObserved")
        .at(-1);
      assert.ok(before);
      assert.ok(
        events.some(
          (event) =>
            event.event === "ControllerObserved" &&
            event.runId === observation.status.run.runId &&
            event.controllerId !== before.controllerId &&
            event.epoch > before.epoch,
        ),
        "durable controller takeover not observed",
      );
      assert.ok(
        events.some(
          (event) =>
            event.event === "ControllerObserved" &&
            event.controllerId === evidence.takeover.lease.controllerId &&
            event.epoch === evidence.takeover.lease.epoch,
        ),
        "resumed run differs from observed repository takeover",
      );
      unique(
        events.filter(
          (event) =>
            event.event === "RunResumeRequested" &&
            event.requestId === `${authority.namespace}-resume`,
        ),
        "exact same-run resume missing",
      );
      assert.equal(observation.children.length, 3);
      assert.ok(observation.children.every((item) => item.state === "closed"));
      // Re-read actor/location and immutable graph identities for the same existing
      // proof consumer used by sibling qualification. Never relabel PublicationRecorded
      // with a refreshed head just to satisfy the old one-parent proof.
      const objective = (await request("GET /repos/{owner}/{repo}/issues/{issue_number}", { issue_number: evidence.objective.number })).data;
      assert.equal(objective.id, evidence.objective.id);
      assert.equal(objective.user.id, evidence.actor.id);
      assert.equal(hash(objective.body), evidence.objectiveBodyDigest);
      const children = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", { issue_number: objective.number });
      assert.equal(children.length, 3);
      assert.ok(children.every((child) => child.state === "closed"));
      const comments = [], dependencies = [];
      for (const issue of [objective, ...children]) {
        const rows = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { issue_number: issue.number });
        for (const row of rows) {
          assert.equal(row.html_url, `https://github.com/${authority.repository}/issues/${issue.number}#issuecomment-${row.id}`);
          comments.push(row);
        }
        if (issue !== objective) dependencies.push({ workItem: issue.number, blockedBy: await list("GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by", { issue_number: issue.number }) });
      }
      const receipts = authenticatedFaultEvents(comments, evidence.actor, objective.number);
      for (const receipt of observation.receipts)
        assert.ok(receipts.some((fresh) => hash(fresh.event) === hash(receipt.event)), "original completion receipt disappeared");
      const proofEvents = receipts.map((receipt) => {
        const comment = unique(comments.filter((row) => row.id === receipt.commentId), "receipt location ambiguous");
        return { ...receipt.event, author: comment.user.login, authorId: comment.user.id, receiptUrl: comment.html_url };
      });
      const publications = proofEvents.filter((event) => event.event === "PublicationRecorded");
      const pulls = [];
      for (const pullNumber of new Set(publications.map((event) => event.pullRequest)))
        pulls.push((await request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { pull_number: pullNumber })).data);
      const start = unique(proofEvents.filter((event) => event.event === "FactoryRunStarted"), "one original start required");
      const delivery = { repository: authority.repository, namespace: authority.namespace, actor: evidence.actor,
        objective, children, dependencies, pulls, events: proofEvents, policy: authority.policy, base: evidence.base,
        nativeDefaultBranch: start.baseBranch, runRequest: evidence.runRequest,
        runResult: { runId: observation.status.run.runId },
        controllerQualification: { peers: [], generation: Object.fromEntries(["controllerId", "epoch", "controllerPolicyDigest"].map((key) => [key, before[key]])) } };
      evidence.checkpointDelivery = delivery;
      delivery.mergeProofs = await observeNativeMergeProofs({ evidence: delivery, request });
      for (const proof of delivery.mergeProofs) {
        const integration = unique(proofEvents.filter((event) => event.event === "AttemptIntegrated" && event.workItem === proof.workItem), "integration identity missing");
        const publication = selectQualificationPublicationRecord(publications.filter((event) => event.workItem === integration.workItem && event.attempt === integration.attempt));
        assertNativeMergeProof(delivery, proof, { repository: authority.repository, pull: unique(pulls.filter((pull) => pull.number === proof.pullRequest), "PR identity missing"), publication, integration });
      }
      evidence.mergeProofs = delivery.mergeProofs;
      save();
      assert.deepEqual(installedBundleIdentity(pluginRoot), artifact);
      for (const entry of harnessFiles)
        assert.equal(
          hash(readBounded(join(root, entry.path), 262144)),
          entry.sha256,
          "qualifier source changed during run",
        );
      evidence.finishedArtifact = artifact;
      evidence.original = original;
      evidence.replacement = replacement;
      save();
    },
  };
  try {
    await client.connect(transport);
    transport.stderr?.on("data", () => {});
    assert.equal(client.getServerVersion()?.version, artifact.version);
    // The committed extension may retire this one owned MCP transport after an ambiguous
    // foreground request. Timeout/cancellation alone is not process or remote-request absence.
    const observerPid = transport.pid;
    assert.ok(Number.isSafeInteger(observerPid) && observerPid > 1);
    const observerStat = readBounded(`/proc/${observerPid}/stat`, 16384);
    const observerStartTicks = observerStat.slice(observerStat.lastIndexOf(")") + 2).split(/\s+/)[19];
    assert.match(observerStartTicks, /^[0-9]+$/);
    const retireClient = async () => {
      let timer, transportClose = "observed";
      try {
        // Pinned SDK stdio.close ends stdin, waits 2s, sends SIGTERM, waits 2s,
        // then SIGKILLs only its owned child. Independently observe that incarnation below.
        await Promise.race([client.close(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("owned MCP retirement deadline exceeded")), 6000);
        })]);
      } catch { transportClose = "unverified"; }
      finally { clearTimeout(timer); }
      for (let index = 0; index < 20; index++) {
        let present;
        try {
          const stat = readBounded(`/proc/${observerPid}/stat`, 16384);
          present = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] === observerStartTicks;
        } catch (error) { if (error.code !== "ENOENT") throw error; present = false; }
        if (!present) return { pid: observerPid, startTicks: observerStartTicks, absent: true,
          transportClose, remoteRequestSettlement: "not-implied" };
        await sleep(100);
      }
      throw Error("owned MCP process absence unverified");
    };
    const scenarioPort = extension.extendPort
      ? await extension.extendPort({
          port,
          authority,
          evidence,
          save,
          request,
          list,
          call,
          invoke,
          command,
          readBounded,
          pluginRoot,
          artifact,
          retireClient,
        })
      : port;
    evidence.result = await runner(scenarioPort, authority);
    save();
    console.log(
      JSON.stringify({
        result: evidence.result.result,
        scope: extension.scope ?? "installed-accounted-checkpoint-restart",
        evidence: authority.evidence,
      }),
    );
  } catch (error) {
    evidence.result = {
      result: "incomplete",
      reason:
        "checkpoint boundary unavailable; inspect exact retained authority before any further action",
      diagnostic: checkpointFailure(error, controllerBoundary),
      automaticRetry: false,
      automaticRestart: false,
    };
    save();
    process.exitCode = 2;
    console.error("Checkpoint restart incomplete; no automatic retry or controller cleanup.");
  } finally {
    await client.close();
    closeSync(evidenceFd);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.exitCode = 2;
    console.error(
      "Checkpoint restart prerequisites unavailable; no execution qualification claimed.",
    );
  }
}
