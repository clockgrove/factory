/** Opt-in installed local cancellation/orderly-restart qualification; never a release-suite test. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  boundedPolicy,
  installedBundleIdentity,
  installedIdentity,
  installedPluginPath,
  modelTokenLimit,
  qualificationNamespace,
  qualificationNamespaceMarker,
} from "./verify-live-objective.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
const terminal = new Set(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);
const localBackends = new Set(["codex-sdk/local-worktree", "codex-cli/local-worktree"]);
const unitPattern = /^[A-Za-z0-9_.@:-]+\.(?:scope|service)$/;
const scopeFields = [
  "protocol",
  "repository",
  "objective",
  "workItem",
  "attempt",
  "runId",
  "directorEpoch",
  "policyDigest",
  "phase",
  "commandIndex",
  "invocationDigest",
  "hostIdentity",
  "producerUnit",
  "producerInvocationId",
];
const sha = /^[a-f0-9]{64}$/;
const evidenceByteLimit = 8 * 1024 * 1024;

const faultStages = Object.freeze({
  configuration: "Explicit scenario configuration could not be verified",
  "installed-identity": "Exact installed artifact identity could not be verified",
  "repository-preflight": "Private disposable repository authority could not be verified",
  "mcp-connect": "Installed MCP connection or tool contract could not be verified",
  "controller-preflight":
    "Exact installed controller identity or active state could not be verified",
  "repository-quiescence":
    "Disposable repository quiescence or fresh namespace could not be verified",
  "objective-create": "New Objective creation was not fully observed; inspect before any retry",
  "evidence-load": "Prior private evidence identity could not be verified",
  "activation-request":
    "Activation request outcome was not fully observed; inspect before any retry",
  "worker-arm": "An exact active owned worker was not observed within the qualification bound",
  "pause-request": "Pause request outcome was not fully observed; inspect before any retry",
  "fault-injection": "Fault injection outcome was not fully observed; never repeat blindly",
  "resource-absence": "Exact original resource absence or controller takeover was not proven",
  "takeover-reconciliation": "Same-run takeover, cancellation, or reported usage remained unproven",
  "retry-request": "Original-authority retry request outcome was not fully observed",
  "resume-request": "Original-authority resume request outcome was not fully observed",
  "terminal-observation":
    "The exact run did not reach an observed terminal outcome within the bound",
  assessment: "Complete source-bound fault evidence was not established",
  complete: "Qualification completion evidence could not be persisted",
});

/** Fixed vocabulary only; exception messages, provider output and inputs never
 * enter diagnostics. Repeated mechanical reads emit no progress/model chatter. */
export function createFaultProgress({ now = Date.now, emit = () => {} } = {}) {
  const startedAt = now();
  let phase = "unconfigured";
  let current = "configuration";
  let steps = 0;
  const elapsed = () =>
    Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(now() - startedAt)));
  return {
    phase(value) {
      assert.ok(
        ["preflight", "prepare", "exercise", "verify"].includes(value),
        "unknown qualification phase",
      );
      phase = value;
    },
    stage(stage) {
      assert.ok(Object.hasOwn(faultStages, stage), "unknown qualification stage");
      if (stage === current && steps > 0) return;
      assert.ok(steps < 32, "qualification progress bound exceeded");
      current = stage;
      steps++;
      emit({
        protocol: "clockgrove.factory/local-fault-progress-v1",
        phase,
        stage: current,
        elapsedMs: elapsed(),
      });
    },
    failure() {
      return {
        phase,
        stage: current,
        code: `local-fault-${current}-incomplete`,
        reason: faultStages[current],
        elapsedMs: elapsed(),
      };
    },
  };
}

/** Trust only this exact installed, authenticated status response. An old
 * terminal run does not make a newer queued activation quiescent. */
export function isQuiescentFaultObjective(status, repository, objective) {
  if (
    status?.operation !== "status" ||
    status.repository !== repository ||
    status.objective?.number !== objective ||
    status.activation?.state === "queued"
  )
    return false;
  if (
    status.activation &&
    !["withdrawn", "started", "cancellation-requested", "rejected"].includes(
      status.activation.state,
    )
  )
    return false;
  if (
    status.run?.availability === "observed" &&
    ["completed", "cancelled", "escalated"].includes(status.run.state)
  )
    return true;
  const requestIdentity = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    [...value].every(
      (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    );
  return (
    status.run?.availability === "unavailable" &&
    status.run.state === "not-started" &&
    status.run.runId === undefined &&
    status.activation?.state === "withdrawn" &&
    requestIdentity(status.activation.requestId) &&
    requestIdentity(status.activation.cancellationRequestId)
  );
}

export function privateEvidenceFile(path, value) {
  const parent = realpathSync(dirname(path));
  assert.ok(
    resolve(path).startsWith("/tmp/") && (parent === "/tmp" || parent.startsWith("/tmp/")),
    "private evidence must stay in /tmp",
  );
  const flags =
    constants.O_NOFOLLOW |
    (value === undefined ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT);
  const fd = openSync(path, flags, 0o600);
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        stat.nlink === 1 &&
        stat.size <= evidenceByteLimit,
      "private evidence must be an owned bounded regular file",
    );
    if (value === undefined) return JSON.parse(readFileSync(fd, "utf8"));
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    assert.ok(Buffer.byteLength(bytes) <= evidenceByteLimit, "private evidence exceeds bound");
    fchmodSync(fd, 0o600);
    // Truncate only after verifying the opened descriptor; never follow a symlink.
    ftruncateSync(fd, 0);
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

function assertScopeReceipt(reservation, start, repository, objective) {
  const batch = reservation.localScopeBatch;
  assert.equal(batch.commandCount, 1);
  assert.equal(batch.identity.phase, "execution");
  assert.equal(batch.identity.commandIndex, 0);
  assert.equal(batch.identity.repository, repository);
  assert.equal(batch.identity.objective, objective);
  assert.equal(reservation.objective, objective);
  assert.equal(reservation.runId, start.runId);
  assert.equal(reservation.policyDigest, start.policyDigest);
  for (const key of ["runId", "workItem", "attempt", "directorEpoch", "policyDigest"])
    assert.equal(batch.identity[key], reservation[key]);
  return scopeUnit(batch.identity);
}

export function faultPolicy(tokens, scenario = "cancel") {
  assert.ok(["cancel", "restart"].includes(scenario));
  const policy = boundedPolicy("regular-prs", tokens);
  return {
    ...policy,
    maxParallel: 1,
    maxAttemptsPerItem: scenario === "restart" ? 2 : 1,
    workItemTimeoutMinutes: 10,
    objectiveTimeoutMinutes: 40,
    capacity: {
      ...policy.capacity,
      mode: "fixed",
      local: { ...policy.capacity.local, maxWorkers: 1 },
    },
  };
}
export function faultObjective(namespace) {
  qualificationNamespace(namespace);
  const directory = `factory-fault-qualification/${namespace}`;
  return `${qualificationNamespaceMarker(namespace)}\nImplement one bounded Work Item: an ESM module ${directory}/sum-even.mjs exporting sumEven(values), returning the sum of finite even integers, rejecting non-array input and any non-finite or non-integer element with TypeError. Add ${directory}/sum-even.test.mjs using node:test, covering positive, negative, empty, odd, and malformed input. Validate with node --test ${directory}/sum-even.test.mjs. No dependencies, workflows, credentials, services, network, generated bundles, or unrelated changes. Factory must independently validate, review, publish, integrate, and close the Work Item.`;
}
export function scopeUnit(identity) {
  assert.ok(
    identity && Object.keys(identity).every((key) => scopeFields.includes(key)),
    "unexpected scope identity field",
  );
  assert.equal(identity.protocol, "clockgrove.factory/local-scope-v1");
  for (const key of ["objective", "workItem", "attempt", "directorEpoch"])
    assert.ok(Number.isSafeInteger(identity[key]) && identity[key] > 0);
  assert.ok(["execution", "validation"].includes(identity.phase));
  assert.ok(
    Number.isSafeInteger(identity.commandIndex) &&
      identity.commandIndex >= 0 &&
      identity.commandIndex <= 256,
  );
  for (const key of ["policyDigest", "invocationDigest", "hostIdentity"])
    assert.match(identity[key] ?? "", sha);
  assert.match(identity.repository ?? "", /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.match(identity.runId ?? "", /^[A-Za-z0-9._:/+-]{1,160}$/);
  assert.match(identity.producerUnit ?? "", /^[A-Za-z0-9_.@:-]+\.service$/);
  assert.match(identity.producerInvocationId ?? "", /^[a-f0-9]{32}$/);
  const ordered = Object.fromEntries(
    scopeFields.filter((key) => identity[key] !== undefined).map((key) => [key, identity[key]]),
  );
  return `clockgrove-factory-work-${hash(ordered)}.scope`;
}
export function parseUnitObservation(unit, output, at = new Date().toISOString()) {
  assert.match(unit, unitPattern);
  const fields = {};
  for (const line of output.trim().split("\n")) {
    const separator = line.indexOf("=");
    assert.ok(
      separator > 0 && fields[line.slice(0, separator)] === undefined,
      "invalid or duplicate systemd property",
    );
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const bound = fields.Id === unit && fields.KillMode === "control-group";
  const absent =
    fields.Id === unit &&
    ["not-found", "loaded"].includes(fields.LoadState) &&
    fields.ActiveState === "inactive" &&
    fields.SubState === "dead" &&
    fields.ControlGroup === "" &&
    ["", "0", "0 /"].includes(fields.Job) &&
    fields.InvocationID === "";
  const active =
    bound &&
    fields.LoadState === "loaded" &&
    fields.ActiveState === "active" &&
    fields.ControlGroup?.endsWith(`/${unit}`) &&
    /^[a-f0-9]{32}$/.test(fields.InvocationID ?? "");
  return {
    unit,
    status: active ? "active" : absent ? "absent" : "unknown",
    at,
    invocationId: fields.InvocationID || null,
    controlGroupDigest: fields.ControlGroup ? hash(fields.ControlGroup) : null,
  };
}
export function authenticatedFaultEvents(comments, actor, objective) {
  assert.ok(comments.length <= 2000);
  assert.ok(
    comments.reduce((total, comment) => total + Buffer.byteLength(comment.body ?? ""), 0) <=
      evidenceByteLimit,
    "authenticated receipt input exceeds bound",
  );
  const result = new Map();
  for (const comment of comments) {
    if (
      comment.user?.id !== actor.id ||
      comment.user?.login?.toLowerCase() !== actor.login.toLowerCase()
    )
      continue;
    assert.ok(typeof comment.body === "string" && comment.body.length <= 131072);
    for (const match of comment.body.matchAll(/<!-- clockgrove-factory:event\n([\s\S]*?)\n-->/g)) {
      const event = JSON.parse(match[1]);
      assert.equal(event.protocol, "clockgrove.factory/v2");
      assert.equal(event.objective, objective);
      assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > 0);
      const key = `${event.runId}:${event.sequence}`;
      const previous = result.get(key);
      assert.ok(
        !previous || hash(previous.event) === hash(event),
        "conflicting authenticated receipt sequence",
      );
      result.set(key, { event, commentId: comment.id, actorId: actor.id });
    }
  }
  return [...result.values()].sort((a, b) => a.event.sequence - b.event.sequence);
}
export function assessLocalFault(evidence) {
  const blockers = [];
  if (!evidence.runId || !evidence.injected) blockers.push("fault-not-injected");
  if (hash(evidence.installedArtifact) !== hash(evidence.finishedInstalledArtifact))
    blockers.push("installed-artifact-changed");
  const events = (evidence.receipts ?? [])
    .map((receipt) => receipt.event)
    .filter((event) => event.runId === evidence.runId);
  const starts = events.filter((event) => event.event === "FactoryRunStarted");
  const policy = starts[0]?.policy;
  if (
    starts.length !== 1 ||
    policy?.economics?.maxModelTokens !== evidence.maxModelTokens ||
    !Array.isArray(policy?.allowedPaidBackends) ||
    policy.allowedPaidBackends.length !== 0 ||
    policy?.cloudFallback !== "never" ||
    policy.maxSandboxMinutes !== 0 ||
    policy.maxManagedAgentSessions !== 0 ||
    policy.maxParallel !== 1 ||
    policy.maxAttemptsPerItem !== (evidence.scenario === "restart" ? 2 : 1) ||
    !Array.isArray(policy?.backendOrder) ||
    !policy.backendOrder.length ||
    policy.backendOrder.some((backend) => !localBackends.has(backend))
  )
    blockers.push("run-authority-mismatch");
  const expected = evidence.scenario === "restart" ? "FactoryRunCompleted" : "FactoryRunCancelled";
  const ended = events.find((event) => event.event === expected);
  const expectedState = evidence.scenario === "restart" ? "completed" : "cancelled";
  if (
    evidence.status?.run?.availability !== "observed" ||
    evidence.status.run.runId !== evidence.runId ||
    evidence.status.run.state !== expectedState ||
    evidence.status.summary?.runId !== evidence.runId ||
    evidence.status.summary.outcome !== expectedState
  )
    blockers.push("installed-status-run-mismatch");
  const tokens = evidence.status?.summary?.economics?.usage?.model_tokens;
  if (
    tokens?.availability !== "observed" ||
    !Number.isSafeInteger(tokens.value) ||
    tokens.value < 0
  )
    blockers.push("model-usage-unavailable");
  if (
    events.filter((event) => terminal.has(event.event)).length !== 1 ||
    !events.some((event) => event.event === expected)
  )
    blockers.push("expected-terminal-unobserved");
  if (
    evidence.status?.summary?.attempts?.active !== 0 ||
    evidence.status?.capacity?.activeReservations?.length !== 0
  )
    blockers.push("active-or-unavailable-reservations");
  if (
    !evidence.before?.scope ||
    evidence.before.scope.status !== "active" ||
    evidence.after?.scope?.status !== "absent" ||
    evidence.before.scope.unit !== evidence.after.scope.unit ||
    evidence.before.hostIdentity !== evidence.after.hostIdentity
  )
    blockers.push("captured-worker-absence-unproven");
  const captured = events.find(
    (event) =>
      event.event === "AttemptReserved" && hash(event) === evidence.before?.reservationDigest,
  );
  if (
    !captured ||
    captured.localScopeBatch?.identity?.hostIdentity !== evidence.before?.hostIdentity ||
    hash(captured.localScopeBatch?.identity) !== hash(evidence.before?.identity)
  )
    blockers.push("captured-scope-receipt-unbound");
  try {
    if (
      assertScopeReceipt(captured, starts[0], evidence.repository, evidence.objective) !==
      evidence.before?.scope?.unit
    )
      blockers.push("captured-scope-receipt-unbound");
  } catch {
    blockers.push("captured-scope-receipt-unbound");
  }
  const capturedStart = events.find(
    (event) =>
      event.event === "AttemptStarted" &&
      event.workItem === captured?.workItem &&
      event.attempt === captured?.attempt,
  );
  if (
    !capturedStart ||
    !(capturedStart.sequence > captured?.sequence && capturedStart.sequence < ended?.sequence)
  )
    blockers.push("captured-worker-start-unobserved");
  const workerIdentities = new Map();
  for (const event of events.filter((entry) => entry.event === "AttemptStarted")) {
    if (!localBackends.has(event.backend)) blockers.push("nonlocal-worker");
    const identity = `${event.workItem}:${event.attempt}`;
    const resource = event.providerResourceId;
    if (!resource) blockers.push("worker-resource-identity-unavailable");
    if (workerIdentities.has(identity) && workerIdentities.get(identity) !== resource)
      blockers.push("duplicate-worker-identity");
    workerIdentities.set(identity, resource);
    if (
      !events.some(
        (later) =>
          later.workItem === event.workItem &&
          later.attempt === event.attempt &&
          later.sequence > event.sequence &&
          later.sequence < ended?.sequence &&
          [
            "AttemptSucceeded",
            "AttemptFailed",
            "AttemptTimedOut",
            "AttemptCancelled",
            "AttemptDeferred",
            "AttemptIntegrated",
          ].includes(later.event),
      )
    )
      blockers.push("unterminated-worker-receipt");
  }
  const reservations = new Map();
  for (const event of events) {
    if (
      !["BudgetReserved", "BudgetReconciled", "CapacityReserved", "CapacityReconciled"].includes(
        event.event,
      )
    )
      continue;
    const key = JSON.stringify([
      event.kind,
      event.workItem,
      event.attempt,
      event.phase,
      event.unit,
      event.usageId,
      event.backend,
    ]);
    reservations.set(key, event.event.endsWith("Reserved"));
  }
  if ([...reservations.values()].some(Boolean)) blockers.push("unreconciled-receipt-reservation");
  for (const event of events.filter((event) => event.event === "AttemptStarted")) {
    const amount = events.filter(
      (later) =>
        later.kind === "budget" &&
        later.event === "BudgetReconciled" &&
        later.unit === "model_tokens" &&
        later.phase === "execution" &&
        later.workItem === event.workItem &&
        later.attempt === event.attempt &&
        Number.isSafeInteger(later.amount) &&
        later.amount >= 0,
    );
    if (amount.length === 0) blockers.push("worker-model-usage-unavailable");
  }
  if (evidence.scenario === "restart") {
    if (
      !evidence.resumeAfterAbsence ||
      evidence.before?.controller?.invocationId === evidence.after?.controller?.invocationId ||
      evidence.after?.controller?.status !== "active"
    )
      blockers.push("controller-generation-transition-unproven");
    const pause = events.find(
      (event) => event.event === "RunPauseRequested" && event.requestId === evidence.pauseRequestId,
    );
    if (!pause || !(pause.sequence > captured?.sequence && pause.sequence < ended?.sequence))
      blockers.push("durable-pause-unobserved");
    const before = events.filter(
      (event) => event.event === "ControllerObserved" && event.sequence < pause?.sequence,
    );
    const after = events.filter(
      (event) =>
        event.event === "ControllerObserved" &&
        event.sequence > pause?.sequence &&
        event.sequence < ended?.sequence,
    );
    if (
      !before.length ||
      !after.some((event) => before.every((prior) => prior.controllerId !== event.controllerId))
    )
      blockers.push("authenticated-controller-takeover-unobserved");
    const retry = events.find(
      (event) =>
        event.event === "WorkItemRetryRequested" &&
        event.requestId === evidence.retryRequestId &&
        event.workItem === captured?.workItem,
    );
    const resume = events.find(
      (event) =>
        event.event === "RunResumeRequested" && event.requestId === evidence.resumeRequestId,
    );
    const cancelled = events.find(
      (event) =>
        event.event === "AttemptCancelled" &&
        event.workItem === captured?.workItem &&
        event.attempt === captured?.attempt,
    );
    if (
      !retry ||
      !resume ||
      !cancelled ||
      !(
        cancelled.sequence > captured?.sequence &&
        retry.sequence > cancelled.sequence &&
        resume.sequence > retry.sequence &&
        ended?.sequence > resume.sequence
      )
    )
      blockers.push("bounded-retry-resume-unobserved");
    const laterReservations = events.filter(
      (event) => event.event === "AttemptReserved" && event.sequence > captured?.sequence,
    );
    if (
      laterReservations.length !== 1 ||
      laterReservations[0].workItem !== captured?.workItem ||
      laterReservations[0].attempt !== captured?.attempt + 1 ||
      !(laterReservations[0].sequence > resume?.sequence)
    )
      blockers.push("unexpected-post-fault-admission");
    if (
      !events.some(
        (event) =>
          event.event === "AttemptIntegrated" &&
          event.workItem === captured?.workItem &&
          event.attempt === captured?.attempt + 1 &&
          event.sequence < ended?.sequence,
      )
    )
      blockers.push("retried-work-integration-unobserved");
  }
  const cancel = events.find(
    (event) =>
      event.event === "FactoryRunCancellationRequested" &&
      event.requestId === evidence.cancelRequestId,
  );
  if (
    evidence.scenario === "cancel" &&
    (!cancel || !(cancel.sequence > captured?.sequence && cancel.sequence < ended?.sequence))
  )
    blockers.push("durable-cancellation-unobserved");
  if (
    evidence.scenario === "cancel" &&
    (events.some(
      (event) => event.event === "AttemptReserved" && event.sequence > cancel?.sequence,
    ) ||
      !(capturedStart?.sequence < cancel?.sequence))
  )
    blockers.push("post-cancellation-admission");
  return {
    result: blockers.length ? "incomplete" : "passed",
    scope: `installed-local-${evidence.scenario}-captured-active-worker`,
    blockers: [...new Set(blockers)],
    limitations: [
      "Orderly installed controller restart, not abrupt crash/phase kill",
      "Restart permits one explicit retry within its initial two-attempt allowance, not terminal revival or extra allowance",
      "Physical absence applies only to the captured active worker scope",
      "Receipt identity checks are not a proof of unreported provider behavior",
    ],
  };
}

function command(file, args, cwd, accept = [0]) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ok(accept.includes(result.status), `${file} observation failed`);
  return result.stdout.trim();
}
function currentHost() {
  const machine = readFileSync("/etc/machine-id", "utf8").trim();
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  assert.match(machine, /^[a-f0-9]{32}$/);
  assert.match(boot, /^[a-f0-9-]{36}$/);
  const namespaces = ["pid", "user", "mnt"].map((name) => readlinkSync(`/proc/self/ns/${name}`));
  assert.ok(
    namespaces.every((value, index) =>
      new RegExp(`^${["pid", "user", "mnt"][index]}:\\[\\d+\\]$`).test(value),
    ),
  );
  return createHmac("sha256", "clockgrove.factory/local-resource-host-v1")
    .update(JSON.stringify([machine, process.getuid(), boot, ...namespaces]))
    .digest("hex");
}
function observeUnit(unit) {
  assert.match(unit, unitPattern);
  return parseUnitObservation(
    unit,
    command(
      "systemctl",
      [
        "--user",
        "show",
        unit,
        "--property=Id,LoadState,ActiveState,SubState,ControlGroup,Job,InvocationID,KillMode",
        "--no-pager",
      ],
      undefined,
      [0, 1, 4],
    ),
  );
}
export async function boundedPoll(
  read,
  accept,
  {
    milliseconds = 120000,
    interval = 10000,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  assert.ok(milliseconds >= 1 && milliseconds <= 600000 && interval >= 1 && interval <= 30000);
  const deadline = now() + milliseconds;
  for (let count = 0; count < 121; count++) {
    const value = await read();
    if (accept(value)) return value;
    if (now() >= deadline) break;
    await wait(Math.min(interval, deadline - now()));
  }
  throw new Error("bounded-observation-incomplete");
}

async function runQualification(progress) {
  if (process.env.FACTORY_LOCAL_FAULTS !== "1") {
    console.log(
      "Not exercised: FACTORY_LOCAL_FAULTS=1 and explicit phase/repository authority required.",
    );
    return;
  }
  progress.stage("configuration");
  const required = (key) => {
    const value = process.env[`FACTORY_LOCAL_FAULT_${key}`]?.trim();
    assert.ok(value, `FACTORY_LOCAL_FAULT_${key} required`);
    return value;
  };
  const phase = required("PHASE");
  assert.ok(["preflight", "prepare", "exercise", "verify"].includes(phase));
  progress.phase(phase);
  const scenario = required("SCENARIO");
  assert.ok(["cancel", "restart"].includes(scenario));
  const repository = required("REPOSITORY");
  assert.match(repository, /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.notEqual(repository, "clockgrove/factory");
  if (["prepare", "exercise"].includes(phase)) assert.equal(required("MUTATION_ACK"), repository);
  assert.equal(process.platform, "linux");
  const checkout = realpathSync(required("CHECKOUT"));
  assert.ok(!checkout.startsWith("/mnt/"));
  const origin = command("git", ["remote", "get-url", "origin"], checkout).replace(/\.git$/, "");
  assert.ok([`https://github.com/${repository}`, `git@github.com:${repository}`].includes(origin));
  const namespace = qualificationNamespace(required("NAMESPACE"));
  const maxModelTokens = modelTokenLimit(required("MAX_MODEL_TOKENS"));
  const policy = faultPolicy(maxModelTokens, scenario);
  const evidencePath = resolve(required("EVIDENCE"));
  assert.ok(evidencePath.startsWith("/tmp/"), "private evidence must be in /tmp");
  const codexHome = realpathSync(join(homedir(), ".codex"));
  progress.stage("installed-identity");
  if (process.env.CODEX_HOME) assert.equal(realpathSync(process.env.CODEX_HOME), codexHome);
  const listed = JSON.parse(command("codex", ["plugin", "list", "--json"], checkout));
  const pluginRoot = installedPluginPath({ listed, codexHome });
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
  installedIdentity({
    manifest,
    listed,
    pluginRoot,
    codexHome,
    portable: JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8")),
    packageManifest: JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")),
  });
  const artifact = installedBundleIdentity(pluginRoot);
  assert.equal(
    artifact.inventorySha256,
    createHash("sha256")
      .update(readFileSync(join(root, "dist/bundle-inventory.json")))
      .digest("hex"),
  );
  assert.equal(
    command("git", ["status", "--porcelain", "--untracked-files=no"], root),
    "",
    "harness must be committed",
  );
  progress.stage("repository-preflight");
  const token =
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || command("gh", ["auth", "token"], checkout);
  const octokit = new Octokit({
    auth: token,
    request: { headers: { "X-GitHub-Api-Version": "2026-03-10" } },
  });
  const [owner, repo] = repository.split("/");
  const request = (route, args = {}) => octokit.request(route, { owner, repo, ...args });
  const list = async (route, args = {}) => {
    const values = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await request(route, { ...args, per_page: 100, page });
      assert.ok(Array.isArray(data));
      values.push(...data);
      if (data.length < 100) return values;
    }
    throw new Error("GitHub observation bound exceeded");
  };
  const info = (await request("GET /repos/{owner}/{repo}")).data;
  assert.ok(
    info.private && !info.archived && info.permissions?.push,
    "private writable disposable repository required",
  );
  const actor = (await octokit.request("GET /user")).data;
  const mcp = manifest.mcpServers?.factory;
  assert.equal(mcp?.command, "node");
  const client = new Client({ name: "factory-installed-local-faults", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", pluginRoot)),
    cwd: checkout,
    env: { ...process.env, GITHUB_TOKEN: token },
    stderr: "pipe",
  });
  let evidence;
  const save = () => privateEvidenceFile(evidencePath, evidence);
  try {
    progress.stage("mcp-connect");
    await client.connect(transport);
    transport.stderr?.on("data", () => {});
    assert.equal(
      client.getServerVersion()?.version,
      artifact.version,
      "installed MCP version changed",
    );
    const call = async (name, args = {}) => {
      const result = await client.callTool(
        { name, arguments: { owner, repo, ...args } },
        undefined,
        { timeout: 60000, maxTotalTimeout: 60000 },
      );
      assert.ok(!result.isError, `${name} failed; inspect private controller diagnostics`);
      return JSON.parse(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
    };
    const definitions = (await client.listTools()).tools;
    for (const name of [
      "factory_activate",
      "factory_status",
      "factory_cancel",
      "factory_pause",
      "factory_retry",
      "factory_resume",
      "factory_controller_restart",
      "factory_controller_status",
    ])
      assert.ok(definitions.some((tool) => tool.name === name));
    progress.stage("controller-preflight");
    const controller = await call("factory_controller_status", {
      repository: checkout,
      requestId: `${namespace}-inspect`,
    });
    assert.ok(
      controller.active && controller.installed,
      "an explicitly installed active controller is required",
    );
    const controllerObservation = observeUnit(controller.unit);
    assert.equal(controllerObservation.status, "active");
    const controllerExec = command("systemctl", [
      "--user",
      "show",
      controller.unit,
      "--property=ExecStart",
      "--value",
    ]);
    assert.ok(
      controllerExec.includes(join(realpathSync(pluginRoot), "dist/factory.js")),
      "controller must execute this exact installed Factory bundle",
    );
    if (phase === "preflight") {
      console.log(
        JSON.stringify({
          result: "passed",
          phase,
          scenario,
          installedArtifact: artifact,
          controllerUnit: controller.unit,
          modelTokenLimit: maxModelTokens,
        }),
      );
      return;
    }
    if (phase === "prepare") {
      progress.stage("repository-quiescence");
      assert.ok(!existsSync(evidencePath), "never overwrite prior qualification evidence");
      assert.equal(command("git", ["status", "--porcelain"], checkout), "");
      const issues = await list("GET /repos/{owner}/{repo}/issues", { state: "all" });
      assert.ok(
        !issues.some((issue) => issue.body?.includes(qualificationNamespaceMarker(namespace))),
        "namespace already exists",
      );
      for (const issue of issues.filter(
        (issue) =>
          issue.state === "open" &&
          issue.labels?.some((label) => label.name === "factory:objective"),
      )) {
        const status = await call("factory_status", { objectiveNumber: issue.number });
        assert.ok(
          isQuiescentFaultObjective(status, repository, issue.number),
          "another Objective may be active or queued in this disposable repository",
        );
      }
      assert.ok(
        !(await list("GET /repos/{owner}/{repo}/pulls", { state: "open" })).length,
        "disposable repository must have no open PRs",
      );
      const body = faultObjective(namespace);
      progress.stage("objective-create");
      const objective = (
        await request("POST /repos/{owner}/{repo}/issues", {
          title: `Factory local ${scenario} qualification [${namespace}]`,
          body,
        })
      ).data;
      evidence = {
        protocol: "clockgrove.factory/installed-local-fault-v1",
        scenario,
        repository,
        namespace,
        objective: objective.number,
        objectiveBodyDigest: hash(body),
        actor: { id: actor.id, login: actor.login },
        maxModelTokens,
        policy,
        installedArtifact: artifact,
        activationRequestId: `${namespace}-activate`,
        faultRequestId: `${namespace}-${scenario}`,
        pauseRequestId: `${namespace}-pause`,
        cancelRequestId: `${namespace}-cancel`,
        retryRequestId: `${namespace}-retry`,
        resumeRequestId: `${namespace}-resume`,
        injected: false,
      };
      save();
      console.log("Prepared one new disposable Objective; no activation or worker was launched.");
      return;
    }
    progress.stage("evidence-load");
    evidence = privateEvidenceFile(evidencePath);
    assert.equal(evidence.protocol, "clockgrove.factory/installed-local-fault-v1");
    for (const [key, expected] of Object.entries({
      repository,
      namespace,
      scenario,
      maxModelTokens,
    }))
      assert.deepEqual(evidence[key], expected);
    assert.deepEqual(evidence.installedArtifact, artifact);
    assert.deepEqual(evidence.actor, { id: actor.id, login: actor.login });
    const observe = async () => {
      const objective = (
        await request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
          issue_number: evidence.objective,
        })
      ).data;
      assert.equal(objective.user.id, actor.id);
      assert.equal(hash(objective.body), evidence.objectiveBodyDigest);
      const children = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
        issue_number: evidence.objective,
      });
      assert.ok(children.length <= 10);
      const comments = [];
      for (const issue of [objective, ...children])
        comments.push(
          ...(await list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
            issue_number: issue.number,
          })),
        );
      evidence.receipts = authenticatedFaultEvents(comments, evidence.actor, evidence.objective);
      evidence.status = await call("factory_status", { objectiveNumber: evidence.objective });
      return evidence.receipts.map((receipt) => receipt.event);
    };
    if (phase === "exercise") {
      assert.ok(
        !evidence.injected && !evidence.injectionRequested,
        "prior injection must be inspected, never repeated blindly",
      );
      const previous = await observe();
      assert.ok(
        !previous.some((event) => event.event === "FactoryRunStarted" || terminal.has(event.event)),
        "exercise requires the fresh prepared Objective",
      );
      progress.stage("activation-request");
      await call("factory_activate", {
        objectiveNumber: evidence.objective,
        requestId: evidence.activationRequestId,
        repository: checkout,
        policy,
      });
      let identity;
      progress.stage("worker-arm");
      await boundedPoll(observe, (events) => {
        const start = events.find((event) => event.event === "FactoryRunStarted");
        if (!start) return false;
        assert.equal(start.activationRequestId, evidence.activationRequestId);
        assert.equal(start.policy.economics.maxModelTokens, maxModelTokens);
        evidence.runId = start.runId;
        for (const event of events.filter(
          (entry) =>
            entry.runId === start.runId &&
            entry.event === "AttemptReserved" &&
            entry.localScopeBatch,
        )) {
          const batch = event.localScopeBatch;
          if (batch.commandCount !== 1 || batch.identity.phase !== "execution") continue;
          identity = batch.identity;
          assert.equal(identity.runId, start.runId);
          assert.equal(identity.repository, repository);
          assert.equal(identity.objective, evidence.objective);
          assert.equal(identity.hostIdentity, currentHost());
          assert.equal(identity.producerUnit, controller.unit);
          const scope = observeUnit(
            assertScopeReceipt(event, start, repository, evidence.objective),
          );
          if (scope.status === "active") {
            const producer = observeUnit(controller.unit);
            assert.equal(
              producer.invocationId,
              identity.producerInvocationId,
              "recorded producer generation differs from current controller",
            );
            evidence.before = {
              hostIdentity: currentHost(),
              scope,
              controller: producer,
              identity,
              reservationDigest: hash(event),
            };
            return true;
          }
        }
        assert.ok(
          !events.some((event) => terminal.has(event.event)),
          "run ended before fault was armed",
        );
        return false;
      });
      save();
      if (scenario === "restart") {
        progress.stage("pause-request");
        await call("factory_pause", {
          objectiveNumber: evidence.objective,
          requestId: evidence.pauseRequestId,
          reason:
            "Bounded installed restart qualification: pause new admissions until original scope absence is independently observed",
        });
      }
      progress.stage("fault-injection");
      assert.equal(
        observeUnit(evidence.before.scope.unit).status,
        "active",
        "captured worker already finished; no fault qualification claimed",
      );
      evidence.injectionRequested = true;
      save();
      if (scenario === "cancel")
        await call("factory_cancel", {
          objectiveNumber: evidence.objective,
          requestId: evidence.cancelRequestId,
          reason: "Bounded installed durable cancellation qualification",
        });
      else
        await call("factory_controller_restart", {
          repository: checkout,
          requestId: evidence.faultRequestId,
        });
      evidence.injected = true;
      save();
      progress.stage("resource-absence");
      await boundedPoll(
        async () => ({
          hostIdentity: currentHost(),
          scope: observeUnit(evidence.before.scope.unit),
          controller: observeUnit(controller.unit),
        }),
        (observation) => {
          evidence.after = observation;
          return (
            observation.scope.status === "absent" &&
            observation.hostIdentity === evidence.before.hostIdentity &&
            (scenario === "cancel" ||
              (observation.controller.status === "active" &&
                observation.controller.invocationId !== evidence.before.controller.invocationId))
          );
        },
      );
      save();
      if (scenario === "restart") {
        progress.stage("takeover-reconciliation");
        await boundedPoll(observe, (events) => {
          const pause = events.find(
            (event) =>
              event.event === "RunPauseRequested" && event.requestId === evidence.pauseRequestId,
          );
          const old = events.filter(
            (event) => event.event === "ControllerObserved" && event.sequence < pause?.sequence,
          );
          assert.ok(
            !events.some((event) => terminal.has(event.event)),
            "restart reached a terminal run; never revive it",
          );
          return (
            old.length > 0 &&
            events.some(
              (event) =>
                event.event === "AttemptCancelled" &&
                event.workItem === identity.workItem &&
                event.attempt === identity.attempt,
            ) &&
            events.some(
              (event) =>
                event.event === "ControllerObserved" &&
                event.sequence > pause?.sequence &&
                old.every((prior) => prior.controllerId !== event.controllerId),
            )
          );
        });
        evidence.resumeAfterAbsence = true;
        save();
        assert.ok(
          evidence.receipts.some(
            ({ event }) =>
              event.runId === evidence.runId &&
              event.event === "BudgetReconciled" &&
              event.unit === "model_tokens" &&
              event.phase === "execution" &&
              event.workItem === identity.workItem &&
              event.attempt === identity.attempt &&
              Number.isSafeInteger(event.amount) &&
              event.amount >= 0,
          ),
          "interrupted worker model usage is unknown; keep admissions paused rather than assume zero",
        );
        progress.stage("retry-request");
        await call("factory_retry", {
          objectiveNumber: evidence.objective,
          workItemNumber: identity.workItem,
          requestId: evidence.retryRequestId,
          reason:
            "Orderly restart qualification: original worker absence and durable takeover observed; use the remaining original attempt allowance",
        });
        progress.stage("resume-request");
        await call("factory_resume", {
          objectiveNumber: evidence.objective,
          requestId: evidence.resumeRequestId,
        });
      }
    }
    progress.stage("terminal-observation");
    assert.ok(evidence.runId, "no captured run to verify");
    await boundedPoll(
      observe,
      (events) =>
        events.some((event) => event.runId === evidence.runId && terminal.has(event.event)),
      { milliseconds: 600000 },
    );
    evidence.finishedInstalledArtifact = installedBundleIdentity(pluginRoot);
    if (evidence.before?.scope)
      evidence.after = {
        hostIdentity: currentHost(),
        scope: observeUnit(evidence.before.scope.unit),
        controller: observeUnit(controller.unit),
      };
    progress.stage("assessment");
    evidence.assessment = assessLocalFault(evidence);
    save();
    console.log(JSON.stringify(evidence.assessment));
    if (evidence.assessment.result !== "passed") process.exitCode = 2;
    else progress.stage("complete");
  } catch {
    const failure = progress.failure();
    if (evidence) {
      evidence.assessment = {
        result: "incomplete",
        ...failure,
      };
      save();
    }
    process.exitCode = 2;
    console.error(JSON.stringify({ result: "incomplete", ...failure }));
  } finally {
    await client.close().catch(() => {});
  }
}
export async function main() {
  const progress = createFaultProgress({ emit: (event) => console.log(JSON.stringify(event)) });
  try {
    await runQualification(progress);
  } catch {
    // Includes failures before MCP setup and failures to persist private evidence.
    // Never print raw exceptions, transport payloads, environment or credentials.
    process.exitCode = 2;
    console.error(JSON.stringify({ result: "incomplete", ...progress.failure() }));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
