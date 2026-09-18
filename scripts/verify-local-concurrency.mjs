/** Opt-in installed, two-Objective qualification. This never invokes a source Supervisor. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  checkpointAuthority,
  checkpointDeadline,
  checkpointTimeout,
  checkpointLease,
  main as checkpointMain,
  assertScopeCoverage,
  assertControllerUnit,
} from "./verify-local-checkpoint-restart.mjs";
import { authenticatedFaultEvents, isQuiescentFaultObjective } from "./verify-local-faults.mjs";
import { qualificationModelAccounting } from "./qualification-model-accounting.mjs";
import {
  assertExplainReplayEvidence,
  assertInnerDirectorCollision,
  assertResourceCeilingEvidence,
} from "./qualification-director-contention.mjs";
import {
  installedBundleIdentity,
  modelTokenLimit,
  objectiveBodyFor,
  qualificationNamespace,
  qualificationNamespaceMarker,
  qualificationPaths,
  waitForCreatedObjectiveNamespace,
} from "./verify-live-objective.mjs";
import {
  readQualificationMergeProofForIdentity,
  selectQualificationPublicationRecord,
} from "./qualification-merge-proof.mjs";
import {
  inspectFreezeCapability,
  assertInnerContentionWindow,
  assertHeldInnerRefusal,
  withFrozenController,
} from "./qualification-controller-freeze.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
const one = (values, reason) => {
  assert.equal(values.length, 1, reason);
  return values[0];
};
const eventsOf = (observation) => observation.receipts.map(({ event }) => event);
const time = (event) => {
  const at = Date.parse(event.at);
  assert.ok(Number.isFinite(at), "receipt time unavailable");
  return at;
};
const sameAttempt = (a, b) =>
  ["objective", "runId", "workItem", "attempt"].every((key) => a[key] === b[key]);
const endNames = new Set([
  "AttemptSucceeded",
  "AttemptFailed",
  "AttemptTimedOut",
  "AttemptCancelled",
  "AttemptDeferred",
]);

function workerPacketScope(issue) {
  assert.equal(typeof issue.body, "string", "Work Item body unavailable");
  const matches = [
    ...issue.body.matchAll(/<!--\s*clockgrove-factory:worker-packet\s+([A-Za-z0-9_-]+)\s*-->/g),
  ];
  const encoded = one(matches, "Work Item packet envelope missing or repeated")[1];
  const packet = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.equal(packet.protocol, "clockgrove.factory/worker-packet");
  assert.ok(Array.isArray(packet.allowedPaths) && packet.allowedPaths.length > 0);
  const exclusiveResources = packet.changeSurface?.exclusiveResources ?? [];
  assert.ok(Array.isArray(exclusiveResources));
  return { paths: packet.allowedPaths, exclusiveResources };
}

function capacitySnapshot(observations) {
  const reservations = [];
  for (const observation of observations) {
    const scopes = new Map(
      observation.children.map((issue) => [issue.number, workerPacketScope(issue)]),
    );
    for (const reservation of observation.status.capacity?.activeReservations ?? []) {
      const scope = scopes.get(reservation.workItem);
      assert.ok(scope, "active reservation has no authenticated Work Item packet");
      reservations.push({
        objective: observation.status.objective.number,
        ...reservation,
        ...scope,
      });
    }
  }
  const identities = reservations.map(
    (reservation) =>
      `${reservation.objective}:${reservation.workItem}:${reservation.attempt}:${reservation.phase}:${reservation.backendId}`,
  );
  assert.equal(new Set(identities).size, identities.length, "duplicate capacity reservation");
  return { observedAt: new Date().toISOString(), reservations };
}

export function concurrencyReceiptProgress(phase, pair) {
  const hasChangedReceiptBoundary = pair.some((observation) =>
    Object.hasOwn(observation, "changedReceipts"),
  );
  if (hasChangedReceiptBoundary) {
    const signalEvents = (observation) =>
      eventsOf({
        receipts: [...observation.changedReceipts, ...observation.pendingReceipts],
      });
    if (
      pair.some(
        (observation) =>
          observation.topologyPending ||
          observation.terminalStatusPending ||
          signalEvents(observation).some((event) =>
            [
              "GraphCompiled",
              "GraphProjected",
              "FactoryRunCompleted",
              "FactoryRunCancelled",
              "FactoryRunEscalated",
            ].includes(event.event),
          ),
      )
    )
      return true;
    const relevant =
      phase === "both-started"
        ? pair.some((observation) =>
            signalEvents(observation).some((event) => event.event === "ControllerObserved"),
          )
        : phase === "refill"
          ? pair.some((observation) =>
              signalEvents(observation).some(
                (event) => event.event === "AttemptStarted" || endNames.has(event.event),
              ),
            )
          : phase === "scoped-pause"
            ? signalEvents(pair[1]).some((event) => event.event === "RunPauseAcknowledged")
            : phase === "peer-completed"
              ? signalEvents(pair[0]).some((event) => event.event === "FactoryRunCompleted")
              : phase === "completed"
                ? pair.some((observation) =>
                    signalEvents(observation).some(
                      (event) => event.event === "FactoryRunCompleted",
                    ),
                  )
                : undefined;
    if (relevant === undefined) throw Error(`unsupported concurrency observation phase: ${phase}`);
    if (!relevant) return false;
  }
  if (phase === "both-started")
    return pair.every((observation) =>
      eventsOf(observation).some((event) => event.event === "ControllerObserved"),
    );
  if (phase === "refill") return concurrencyRefill(pair) !== null;
  if (phase === "scoped-pause")
    return eventsOf(pair[1]).some((event) => event.event === "RunPauseAcknowledged");
  if (phase === "peer-completed")
    return eventsOf(pair[0]).some((event) => event.event === "FactoryRunCompleted");
  if (phase === "completed")
    return pair.every((observation) =>
      eventsOf(observation).some((event) => event.event === "FactoryRunCompleted"),
    );
  throw Error(`unsupported concurrency observation phase: ${phase}`);
}

const adverseProgress = (pair) =>
  pair.some((observation) =>
    eventsOf(observation).some(
      (event) =>
        ["FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event) ||
        event.event === "FactoryRunCancellationRequested",
    ),
  );

/** Require an observed original failed incarnation, including its pending auto-restart.
 * The CLI propagates exit 1, so Restart=on-failure remains in force. This predicate is
 * not an atomic generation-conditional stop operation.
 */
export function assertRetiredController(fields, original, configPath) {
  assert.equal(fields.Id, original.unit);
  assert.equal(fields.LoadState, "loaded");
  assert.equal(fields.FragmentPath, configPath);
  assert.equal(fields.DropInPaths, "");
  assert.equal(fields.NeedDaemonReload, "no");
  assert.ok(["", "0", "0 /"].includes(fields.Job), "controller replacement job appeared");
  assert.ok(
    (fields.ActiveState === "failed" && fields.SubState === "failed") ||
      (fields.ActiveState === "activating" && fields.SubState === "auto-restart"),
    "original controller is not in its failed/pending-restart boundary",
  );
  assert.equal(fields.MainPID, "0", "controller replacement is active");
  assert.equal(
    fields.InvocationID,
    original.invocationId,
    "controller invocation changed before stop",
  );
  assert.equal(fields.ExecMainPID, String(original.pid));
  assert.equal(fields.ExecMainCode, "1");
  assert.equal(fields.ExecMainStatus, "1");
  assert.equal(fields.Result, "exit-code");
}
const policyFor = (authority, index) => ({ ...authority, namespace: authority.namespaces[index] });

const reasoningEfforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function qualificationModels(env) {
  const model = env.FACTORY_CONCURRENCY_MODEL;
  const reasoning = env.FACTORY_CONCURRENCY_REASONING;
  assert.ok(model, "explicit concurrency qualification model required");
  assert.ok(Buffer.byteLength(model) <= 160 && /^[A-Za-z0-9._:/+-]+$/.test(model));
  assert.ok(reasoningEfforts.has(reasoning), "explicit supported reasoning effort required");
  const profile = "qualification";
  return {
    mode: "single-profile",
    profiles: { [profile]: { model, reasoning } },
    phaseProfiles: Object.fromEntries(
      ["compile", "implement", "review", "recover"].map((phase) => [phase, profile]),
    ),
  };
}

/** Policy resolution and authenticated backend receipts; provider-returned settings stay unavailable. */
export function concurrencyModelConfiguration(observation, authority) {
  const events = eventsOf(observation);
  assert.ok(authority.policy.models, "immutable model configuration missing");
  const phases = Object.fromEntries(
    Object.entries(authority.policy.models.phaseProfiles).map(([phase, profile]) => [
      phase,
      { profile, ...authority.policy.models.profiles[profile] },
    ]),
  );
  const executionBackends = [
    ...new Set(
      events.filter((event) => event.event === "AttemptReserved").map((event) => event.backend),
    ),
  ];
  for (const backend of executionBackends)
    assert.ok(authority.policy.backendOrder.includes(backend));
  return {
    requested: {
      evidence: "immutable-run-policy",
      models: authority.policy.models,
      managementBackend: authority.policy.managementBackend,
      executionBackendOrder: authority.policy.backendOrder,
    },
    resolved: {
      evidence: "deterministic-run-policy-selection",
      phases,
      managementBackend: authority.policy.managementBackend,
      executionBackendOrder: authority.policy.backendOrder,
    },
    observed: {
      executionBackends,
      providerReturnedModel: "unavailable-not-recorded-in-receipts",
      providerReturnedReasoning: "unavailable-not-recorded-in-receipts",
    },
  };
}

export function concurrencyMeasurements(observation, observer) {
  const events = eventsOf(observation);
  const interval = (from, to) => {
    const start = events.find((event) => event.event === from);
    const end = events.find((event) => event.event === to);
    if (!start || !end) return { availability: "unavailable", reason: "receipt-missing" };
    return {
      availability: "observed",
      milliseconds: time(end) - time(start),
      boundary: "authenticated-receipt-timestamps",
    };
  };
  const compiled = events.find((event) => event.event === "GraphCompiled");
  const projected = events.find((event) => event.event === "GraphProjected");
  let projection;
  if (compiled && projected) {
    assert.equal(projected.graphDigest, compiled.graphDigest, "projected graph digest changed");
    assert.equal(projected.graphSize, compiled.graphSize, "projected graph size changed");
    projection = {
      availability: "observed",
      graphDigest: compiled.graphDigest,
      projectedWorkItems: compiled.graphSize,
      boundary: "authenticated-graph-receipts",
    };
  } else {
    projection = { availability: "unavailable", reason: "receipt-missing" };
  }
  return {
    run: interval("FactoryRunStarted", "FactoryRunCompleted"),
    graphCompiledToProjected: {
      interval: interval("GraphCompiled", "GraphProjected"),
      projection,
      cpuAndMemory: {
        availability: "unavailable",
        reason: "no-durable-transition-scoped-resource-receipt",
      },
      modelTokens: {
        availability: "unavailable",
        reason: "durable-model-accounting-is-not-attributed-to-this-receipt-interval",
      },
    },
    observer: structuredClone(observer),
    controllerMutationOperations: {
      availability: "unavailable",
      reason: "telemetry-is-process-local-and-the-qualifier-is-not-the-controller-process",
    },
    githubAccountQuotaAttributedToRun: {
      availability: "unavailable",
      reason: "account-wide-quota-is-not-run-attribution",
    },
  };
}

export function concurrencyAuthority(env) {
  if (env.FACTORY_LOCAL_CONCURRENCY !== "1") return null;
  const duration = env.FACTORY_CONCURRENCY_DURATION_MINUTES ?? "45";
  assert.match(
    duration,
    /^(?:4[5-9]|[5-9][0-9]|1[01][0-9]|120)$/,
    "concurrency duration must be an integer from 45 through 120 minutes",
  );
  const durationMinutes = Number(duration);
  checkpointDeadline(new Date(0).toISOString(), durationMinutes);
  const perObjectiveThreshold = modelTokenLimit(
    env.FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS ?? "250000",
  );
  const aggregateObservedThreshold = 2 * perObjectiveThreshold;
  assert.equal(
    env.FACTORY_CONCURRENCY_MAX_MODEL_TOKENS,
    String(aggregateObservedThreshold),
    "aggregate observed threshold must explicitly equal twice the per-Objective threshold",
  );
  assert.equal(
    env.FACTORY_CHECKPOINT_BACKEND,
    undefined,
    "concurrency uses the SDK/CLI local chain",
  );
  const phase = env.FACTORY_CONCURRENCY_PHASE;
  const namespace = qualificationNamespace(env.FACTORY_CONCURRENCY_NAMESPACE);
  const namespaces = [
    qualificationNamespace(`${namespace}-a`),
    qualificationNamespace(`${namespace}-b`),
  ];
  const repository = env.FACTORY_CONCURRENCY_REPOSITORY;
  const unit = env.FACTORY_CONCURRENCY_CONTROLLER_UNIT;
  const scenario = env.FACTORY_CONCURRENCY_SCENARIO ?? "throughput";
  assert.ok(
    ["throughput", "lease-fault", "director-contention"].includes(scenario),
    "unsupported concurrency scenario",
  );
  if (phase === "exercise")
    assert.equal(
      env.FACTORY_CONCURRENCY_ACK,
      scenario === "throughput"
        ? `${repository}:${unit}:start,activate-two,stop`
        : scenario === "lease-fault"
          ? `${repository}:${unit}:start,activate-two,contend,pause-b,freeze-inner-contend-unfreeze,stop-stale,restart,resume-b,stop`
          : `${repository}:${unit}:start,activate-peer,race-inner-cas,observe-path-exclusive-refill,explain,replay,stop`,
      "explicit two-Objective lifecycle authority required",
    );
  const authority = checkpointAuthority({
    ...env,
    FACTORY_LOCAL_CHECKPOINT_RESTART: "1",
    FACTORY_CHECKPOINT_REPOSITORY: repository,
    FACTORY_CHECKPOINT_CHECKOUT: env.FACTORY_CONCURRENCY_CHECKOUT,
    FACTORY_CHECKPOINT_CONTROLLER_UNIT: unit,
    FACTORY_CHECKPOINT_PHASE: phase,
    FACTORY_CHECKPOINT_NAMESPACE: namespace,
    FACTORY_CHECKPOINT_EVIDENCE: env.FACTORY_CONCURRENCY_EVIDENCE,
    FACTORY_CHECKPOINT_MAX_MODEL_TOKENS: String(perObjectiveThreshold),
    FACTORY_CHECKPOINT_ACK: `${repository}:${unit}:start,pause-drain,restart,resume,stop`,
  });
  const directorContention = scenario === "director-contention";
  authority.policy.maxParallel = directorContention ? 2 : 1;
  authority.policy.objectiveTimeoutMinutes = durationMinutes;
  authority.policy.capacity.local.maxWorkers = directorContention ? 2 : 1;
  authority.policy.models = qualificationModels(env);
  return {
    ...authority,
    scenario,
    namespaces,
    aggregateObservedThreshold,
    controllerLocalCeiling: 8,
    authorizedScenarioWorkerMaximum: directorContention ? 4 : 2,
  };
}

export function concurrencyObjectiveBody(namespace, index) {
  return `${objectiveBodyFor(namespace)}\n\nThis is one of exactly two explicitly activated, disjoint qualification Objectives. Keep exactly three Work Items and two independent roots, then the dependent join. Do not edit the other namespace. ${
    index === 0
      ? "Make clamp the first root in native sub-issue order. Its implementation must also handle infinities and negative zero consistently with Math.min(Math.max(value,min),max). Add at least 24 individually named edge-case assertions covering negative/fractional inputs, both infinities, negative zero, equal bounds and inverted bounds. Do not introduce artificial delays, sleeps, services, network calls or resource pressure."
      : "Keep both roots minimal: only the specified deterministic implementation and acceptance cases. Make clamp first and slugify second in native sub-issue order."
  }\nKeep all six new files ordinary non-executable Git mode 100644. Do not combine the roots or add Work Items. This requests useful asymmetric work, not a guarantee about model speed. The observer records an incomplete result if actual overlap/refill does not occur.`;
}

export function directorContentionObjectiveBody(namespace, index, sharedPath, sharedResource) {
  assert.match(sharedPath, /^src\/factory-qualification\/[a-z0-9-]+\/shared\/$/);
  assert.match(sharedResource, /^factory-qualification-[a-z0-9-]+$/);
  return `${objectiveBodyFor(namespace)}\n\nThis is one of exactly two Director-contention qualification Objectives. Keep the three modules and dependency graph above unchanged. The clamp root must additionally include ${sharedPath} in its allowed paths and add ${sharedPath}${namespace}.js exporting the string '${namespace}'; the peer Objective writes a different file in that directory. The slugify root must declare the exact exclusive resource ${sharedResource}. Preserve those exact path and exclusive-resource declarations in the Work Packets. ${
    index === 0
      ? "Make both roots useful but smaller, with at least 12 individually named deterministic edge-case assertions each; keep the join minimal."
      : "Make both roots materially larger with at least 48 individually named deterministic edge-case assertions each; keep the join minimal."
  } Do not add sleeps, services, network calls, generated artifacts or unrelated dependencies. All files are ordinary mode 100644. Both Objectives edit disjoint files and must merge cleanly.`;
}

/** Observed execution lifetimes only. Receipt clocks never imply simultaneous CPU use. */
export function concurrencyRefill(pair) {
  assert.equal(pair.length, 2);
  const runs = pair.map(eventsOf);
  const intervals = runs.map((events) =>
    events
      .filter((event) => event.event === "AttemptStarted")
      .map((start) => {
        assert.ok(
          Number.isSafeInteger(start.objective) &&
            start.objective > 0 &&
            typeof start.runId === "string" &&
            start.runId.length > 0 &&
            Number.isSafeInteger(start.workItem) &&
            start.workItem > 0 &&
            Number.isSafeInteger(start.attempt) &&
            start.attempt > 0 &&
            Number.isSafeInteger(start.sequence) &&
            start.sequence > 0,
          "worker lifetime identity missing",
        );
        const ends = events.filter(
          (event) => endNames.has(event.event) && sameAttempt(start, event),
        );
        assert.ok(ends.length <= 1, "conflicting worker terminals");
        const end = ends[0];
        if (end) {
          assert.ok(Number.isSafeInteger(end.sequence) && end.sequence > start.sequence);
          assert.ok(time(end) >= time(start));
        }
        return { start, end };
      }),
  );
  // Within each run, sequence supplies ordering even when server timestamps tie.
  for (const row of intervals) {
    const sorted = [...row].sort((a, b) => a.start.sequence - b.start.sequence);
    for (let i = 1; i < sorted.length; i++)
      assert.ok(
        sorted[i - 1].end && sorted[i - 1].end.sequence < sorted[i].start.sequence,
        "per-Objective one-worker ceiling exceeded",
      );
  }
  // Overlap and refill are distinct observations: one Objective overlaps a peer, then later
  // admits another worker after its own prior worker releases the one-worker slot.
  for (const refillIndex of [0, 1]) {
    const overlapIndex = 1 - refillIndex;
    for (const peer of intervals[overlapIndex])
      for (const first of intervals[refillIndex])
        for (const refill of intervals[refillIndex]) {
          if (!first.end || first === refill || first.end.sequence >= refill.start.sequence)
            continue;
          const peerEnd = peer.end ? time(peer.end) : Number.POSITIVE_INFINITY;
          const firstEnd = time(first.end);
          if (
            time(peer.start) < firstEnd &&
            time(first.start) < peerEnd &&
            firstEnd < time(refill.start)
          ) {
            return {
              peer: peer.start,
              first: first.start,
              released: first.end,
              refill: refill.start,
              overlapObjective: overlapIndex,
              refillObjective: refillIndex,
              boundary: "authenticated-worker-lifetimes",
              simultaneousCpu: "not-measured",
            };
          }
        }
  }
  return null;
}

export function assertConcurrencySettlement(
  observation,
  authority,
  { paused = false, activated = true } = {},
) {
  const events = eventsOf(observation),
    start = one(
      events.filter((event) => event.event === "FactoryRunStarted"),
      "one exact run required",
    );
  const activations = events.filter((event) => event.event === "ActivationRequested");
  let activation;
  if (activated) activation = one(activations, "one exact activation required");
  else assert.equal(activations.length, 0, "foreground collision gained activation authority");
  if (activation) {
    assert.equal(activation.requestId, `${authority.namespace}-activate`);
    assert.equal(start.activationRequestId, activation.requestId);
  } else assert.equal(start.activationRequestId, undefined);
  for (const event of activation ? [activation, start] : [start]) {
    assert.equal(event.repository, authority.repository);
    assert.deepEqual(event.policy, authority.policy);
    assert.equal(event.policyDigest, start.policyDigest);
    assert.equal(event.objective, observation.status.objective.number);
  }
  if (activation) assert.equal(activation.requestedBy.toLowerCase(), start.actor.toLowerCase());
  assert.equal(observation.status.run.runId, start.runId);
  assert.equal(observation.status.summary.runId, start.runId);
  assert.equal(observation.status.run.policyDigest, start.policyDigest);
  assert.ok(
    events.every((event) => event === activation || event.runId === start.runId),
    "foreign run history",
  );
  const run = events.filter((event) => event.runId === start.runId);
  assertScopeCoverage(run);
  assert.ok(
    !run.some((event) =>
      ["AttemptFailed", "AttemptDeferred", "AttemptCancelled", "AttemptTimedOut"].includes(
        event.event,
      ),
    ),
    "replacement or failed work is not this scenario",
  );
  const reservations = run.filter((event) => event.event === "AttemptReserved");
  assert.equal(
    new Set(reservations.map((event) => event.workItem)).size,
    reservations.length,
    "duplicate implementation attempt",
  );
  for (const reserved of reservations) {
    assert.equal(reserved.attempt, 1);
    assert.ok(authority.policy.backendOrder.includes(reserved.backend));
    for (const name of ["AttemptStarted", "AttemptSucceeded", "AttemptIntegrated"])
      one(
        run.filter((event) => event.event === name && sameAttempt(event, reserved)),
        "admitted attempt not settled exactly once",
      );
  }
  const accounting = qualificationModelAccounting(run, { requireMarkers: true });
  assert.equal(accounting.unresolved.length, 0, "unknown model invocation remains");
  one(
    accounting.usage.filter(
      (event) =>
        event.phase === "management" &&
        !event.workItem &&
        /^compile-[a-f0-9]{64}$/.test(event.usageId),
    ),
    "exact compilation usage missing or repeated",
  );
  for (const reserved of reservations) {
    const usage = one(
      accounting.usage.filter(
        (event) =>
          sameAttempt(event, reserved) &&
          event.phase === "execution" &&
          event.usageId === `worker-${reserved.workItem}-${reserved.attempt}`,
      ),
      "exact worker usage missing or repeated",
    );
    const succeeded = one(
      run.filter((event) => event.event === "AttemptSucceeded" && sameAttempt(event, reserved)),
      "terminal worker counter missing",
    );
    assert.equal(
      succeeded.reportedModelTokens,
      usage.amount,
      "actual terminal usage differs from accounting",
    );
  }
  for (const reservation of run.filter((event) =>
    ["BudgetReserved", "CapacityReserved"].includes(event.event),
  )) {
    if (reservation.unit === "model_tokens") continue;
    const name = reservation.event === "BudgetReserved" ? "BudgetReconciled" : "CapacityReconciled";
    assert.ok(
      run.some(
        (event) =>
          event.event === name &&
          event.sequence > reservation.sequence &&
          sameAttempt(event, reservation) &&
          event.phase === reservation.phase &&
          (name === "BudgetReconciled"
            ? event.unit === reservation.unit && event.usageId === reservation.usageId
            : event.backend === reservation.backend),
      ),
      "resource/native accounting remains unresolved",
    );
  }
  assert.deepEqual(observation.status.capacity.activeReservations, []);
  assert.equal(observation.children.length, 3);
  if (paused) {
    const request = one(
      run.filter(
        (event) =>
          event.event === "RunPauseRequested" && event.requestId === `${authority.namespace}-pause`,
      ),
      "exact scoped pause missing",
    );
    const ack = one(
      run.filter(
        (event) =>
          event.event === "RunPauseAcknowledged" && event.commandRequestId === request.requestId,
      ),
      "pause not acknowledged",
    );
    assert.ok(ack.sequence > request.sequence);
    assert.ok(
      !run.some((event) => event.event === "AttemptReserved" && event.sequence > ack.sequence),
    );
    assert.equal(observation.status.run.state, "paused");
    assert.ok(reservations.length > 0 && reservations.length < 3);
  } else {
    one(
      run.filter((event) => event.event === "FactoryRunCompleted"),
      "terminal completion missing",
    );
    assert.equal(observation.status.run.state, "completed");
    assert.equal(observation.status.objective.closed, true);
    assert.equal(reservations.length, 3);
    assert.ok(observation.children.every((child) => child.state === "closed"));
  }
  return { runId: start.runId, modelTokens: accounting.total, reservations: reservations.length };
}

/** Terminal Factory cleanup retires disposable review refs; merged PRs and receipts stay durable. */
export async function observeSettledConcurrencyMergeProofs({ entry, request, repository }) {
  const runId = entry.runResult.runId;
  assert.equal(entry.status.run.runId, runId);
  assert.ok(Array.isArray(entry.children) && entry.children.length <= 100);
  const events = entry.events.filter((event) => event.runId === runId);
  const proofs = [];
  const seen = new Set();
  for (const child of entry.children) {
    assert.ok(!seen.has(child.number), "duplicate merge proof Work Item");
    seen.add(child.number);
    const integration = one(
      events.filter(
        (event) => event.event === "AttemptIntegrated" && event.workItem === child.number,
      ),
      "integration missing",
    );
    const publication = selectQualificationPublicationRecord(
      events.filter(
        (event) => event.event === "PublicationRecorded" && sameAttempt(event, integration),
      ),
    );
    const published = one(
      events.filter(
        (event) =>
          event.event === "AttemptPublished" &&
          sameAttempt(event, integration) &&
          event.headSha === publication.headSha,
      ),
      "published source head missing",
    );
    const validation = one(
      events.filter(
        (event) => event.event === "ValidationRecorded" && sameAttempt(event, integration),
      ),
      "validation proof missing",
    );
    const validated = one(
      events.filter(
        (event) => event.event === "AttemptValidated" && sameAttempt(event, integration),
      ),
      "semantic review proof missing",
    );
    assert.equal(validation.passed, true);
    assert.equal(validation.baseSha, publication.baseSha);
    assert.match(validation.outputTreeSha, /^[a-f0-9]{40}$/);
    assert.match(published.artifactDigest, /^[a-f0-9]{64}$/);
    assert.equal(validated.artifactDigest, published.artifactDigest);
    assert.match(publication.validationDigest, /^[a-f0-9]{64}$/);
    assert.match(publication.exactHeadValidationDigest, /^[a-f0-9]{64}$/);
    assert.equal(publication.validationDigest, validation.evidenceDigest);
    const sourceValidation = {
      protocol: "clockgrove.factory/exact-head-validation-v1",
      validationDigest: publication.validationDigest,
      baseSha: publication.baseSha,
      outputTreeSha: validation.outputTreeSha,
      publishedHeadSha: publication.headSha,
    };
    assert.equal(publication.exactHeadValidationDigest, hash(sourceValidation));
    assert.ok(
      validation.sequence < validated.sequence &&
        validated.sequence < published.sequence &&
        published.sequence < publication.sequence &&
        publication.sequence < integration.sequence,
      "validation/publication/integration chronology differs",
    );
    const pull = one(
      entry.pulls.filter((candidate) => candidate.number === publication.pullRequest),
      "pull missing",
    );
    assert.equal(pull.state, "closed");
    assert.equal(pull.merged, true);
    assert.equal(pull.base.repo.full_name, repository);
    assert.equal(pull.head.repo.full_name, repository);
    assert.equal(pull.head.ref, publication.branch);
    assert.match(publication.headSha, /^[a-f0-9]{40}$/);
    assert.match(pull.head.sha, /^[a-f0-9]{40}$/);
    assert.match(integration.headSha, /^[a-f0-9]{40}$/);
    const refreshCommitShas = [];
    let cursor = pull.head.sha;
    while (cursor !== publication.headSha) {
      assert.ok(refreshCommitShas.length < 100, "refresh lineage exceeds bound");
      const commit = (
        await request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
          commit_sha: cursor,
        })
      ).data;
      assert.equal(commit.sha, cursor);
      assert.ok(typeof commit.message === "string" && Buffer.byteLength(commit.message) <= 131072);
      const trailers = [...commit.message.matchAll(/^Factory-Sibling-Refresh: ([a-f0-9]{64})$/gm)];
      assert.equal(trailers.length, 1, "refresh intent trailer missing or repeated");
      assert.ok(Array.isArray(commit.parents) && commit.parents.length === 2);
      for (const parent of commit.parents) assert.match(parent.sha, /^[a-f0-9]{40}$/);
      refreshCommitShas.push(cursor);
      cursor = commit.parents[0].sha;
    }
    const expected = {
      runId: publication.runId,
      objective: publication.objective,
      workItem: publication.workItem,
      attempt: publication.attempt,
      pullRequestNodeId: pull.node_id,
      pullRequest: pull.number,
      repository,
      repositoryNodeId: pull.base.repo.node_id,
      headSha: pull.head.sha,
      mergeSha: integration.headSha,
    };
    const proof = await readQualificationMergeProofForIdentity({ request }, expected);
    proofs.push({
      ...proof,
      sourceHeadSha: publication.headSha,
      refreshCommitShas,
    });
  }
  return proofs;
}

/** These are real Objective lease Git commits, not repository-controller receipts. */
export function assertInnerTakeover(before, after, chain, start) {
  for (const record of [before, after, ...chain]) {
    const event = record.event;
    assert.match(record.oid, /^[a-f0-9]{40}$/);
    assert.equal(event.protocol, "clockgrove.factory/v2");
    assert.equal(event.kind, "lease");
    assert.ok(["LeaseAcquired", "LeaseRenewed", "LeaseReleased"].includes(event.event));
    assert.equal(event.objective, start.objective);
    assert.equal(event.runId, start.runId);
    assert.equal(event.policyDigest, start.policyDigest);
    assert.ok(Number.isSafeInteger(event.epoch) && event.epoch > 0);
    time(event);
  }
  assert.ok(after.event.epoch > before.event.epoch, "inner Director epoch did not advance");
  assert.notEqual(after.event.holder, before.event.holder, "inner Director holder did not change");
  assert.ok(chain.length > 0 && chain.length <= 100);
  let current = after;
  for (const parent of chain) {
    assert.equal(current.event.previousOid, parent.oid);
    assert.deepEqual(current.parents, [parent.oid]);
    assert.ok(
      current.event.sequence > parent.event.sequence && current.event.epoch >= parent.event.epoch,
    );
    current = parent;
  }
  assert.equal(current.oid, before.oid, "inner lease ancestry does not reach captured original");
  return {
    boundary: "inner-Director-serial-takeover",
    before: before.oid,
    after: after.oid,
    originalEpoch: before.event.epoch,
    replacementEpoch: after.event.epoch,
    simultaneousRace: "not-exercised",
  };
}

export function assertObjectiveContention({ response, before, after, objective }) {
  assert.equal(before.event.kind, "lease");
  assert.equal(before.event.objective, objective);
  assert.ok(["LeaseAcquired", "LeaseRenewed"].includes(before.event.event));
  assert.deepEqual(
    response,
    {
      isError: true,
      content: [
        { type: "text", text: `Objective #${objective} is leased by ${before.event.holder}` },
      ],
    },
    "same-Objective contender did not stop at Objective ownership",
  );
  assert.equal(after.oid, before.oid, "losing same-Objective contender changed the lease");
  assert.deepEqual(after.event, before.event);
  return {
    boundary: "objective-lease",
    objective,
    leaseOid: before.oid,
    outerRepositoryLease: "not-consulted",
  };
}

/** Ordinary useful-work path: no expiry offset, injected contention, pause or restart. */
export async function runConcurrencyScenario(port, authority) {
  const preflight = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", preflight };
  assert.equal(authority.scenario, "throughput");
  await port.prepare("create");
  await port.action("start");
  const controller = await port.controller("active");
  await port.prepare("activate");
  await port.pollPair("both-started", (pair) =>
    pair.every((observation) =>
      eventsOf(observation).some((event) => event.event === "ControllerObserved"),
    ),
  );
  const overlap = await port.pollPair("refill", (pair) => concurrencyRefill(pair) !== null);
  const refill = concurrencyRefill(overlap);
  const final = await port.pollPair("completed", (pair) =>
    pair.every((observation, index) => port.settled(observation, false, index)),
  );
  await port.action("stop");
  await port.controller("inactive");
  const proofs = await port.finishThroughput(final, controller, refill);
  return {
    result: "passed",
    scope: "installed-two-objective-useful-throughput-refill",
    controllerLocalCeiling: 8,
    authorizedScenarioWorkerMaximum: 2,
    aggregateObservedThreshold: authority.aggregateObservedThreshold,
    artificialDelayMs: 0,
    injectedFaults: 0,
    comparativeSavings: "not-measured",
    proofs,
  };
}

/** Explicit controller-expiry/restart fault path, kept out of throughput measurement. */
export async function runConcurrencyLeaseFaultScenario(port, authority) {
  const preflight = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", preflight };
  assert.equal(authority.scenario, "lease-fault");
  await port.prepare("create");
  await port.action("start");
  const original = await port.controller("active");
  await port.stagger(original);
  await port.prepare("activate");
  const started = await port.pollPair("both-started", (pair) =>
    pair.every((observation) =>
      eventsOf(observation).some((event) => event.event === "ControllerObserved"),
    ),
  );
  await port.contend(started);
  const overlap = await port.pollPair("refill", (pair) => concurrencyRefill(pair) !== null);
  const refill = concurrencyRefill(overlap);
  await port.scoped("pause");
  const paused = await port.pollPair("scoped-pause", (pair) => port.settled(pair[1], true));
  const pause = one(
    eventsOf(paused[1]).filter((event) => event.event === "RunPauseRequested"),
    "pause request missing",
  );
  const finishedA = await port.pollPair("peer-completed", (pair) => port.settled(pair[0], false));
  assert.ok(
    eventsOf(finishedA[0]).some(
      (event) => event.event === "AttemptStarted" && time(event) > time(pause),
    ),
    "peer received no new service after scoped pause",
  );
  assert.ok(
    !eventsOf(finishedA[0]).some((event) =>
      ["RunPauseRequested", "RunCancelRequested"].includes(event.event),
    ),
    "scoped command leaked to peer",
  );
  assert.ok(port.settled(finishedA[1], true, 1), "paused peer checkpoint is not settled");
  await port.captureCheckpoint(finishedA, original);
  await port.innerContend(original);
  await port.action("restart");
  const replacement = await port.controller("active");
  assert.notEqual(
    replacement.invocationId,
    original.invocationId,
    "controller did not change generation",
  );
  assert.equal(replacement.hostIdentity, original.hostIdentity, "host changed across restart");
  await port.takeover(finishedA[1]);
  await port.scoped("resume");
  const final = await port.pollPair("completed", (pair) =>
    pair.every((observation, index) => port.settled(observation, false, index)),
  );
  await port.action("stop");
  await port.controller("inactive");
  const proofs = await port.finish(final, original, replacement, refill);
  return {
    result: "passed",
    scope: "installed-two-objective-refill-scoped-pause-inner-contention",
    controllerLocalCeiling: 8,
    authorizedScenarioWorkerMaximum: 2,
    aggregateObservedThreshold: authority.aggregateObservedThreshold,
    innerLeaseHeldContention: "observed",
    simultaneousInnerCasCollision: "not-exercised",
    pressure: "not-repeated",
    comparativeSavings: "not-measured",
    proofs,
  };
}

/** Two process-isolated foreground Directors race one absent inner lease while a peer progresses. */
export async function runDirectorContentionScenario(port, authority) {
  const preflight = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", preflight };
  assert.equal(authority.scenario, "director-contention");
  await port.prepare("create");
  await port.action("start");
  const controller = await port.controller("active");
  await port.prepare("activate-peer");
  await port.pollPeer("started");
  const collision = await port.innerCasCollision(controller);
  const final = await port.pollPair("completed", (pair) =>
    pair.every((observation, index) => port.settled(observation, false, index, index === 1)),
  );
  const proofs = await port.finishDirectorContention(final, controller, collision);
  await port.action("stop");
  const stopped = await port.controller("inactive");
  return {
    result: "passed",
    scope: "installed-inner-Director-CAS-resource-ceilings-explain-replay",
    controllerLocalCeiling: authority.controllerLocalCeiling,
    authorizedScenarioWorkerMaximum: authority.authorizedScenarioWorkerMaximum,
    aggregateObservedThreshold: authority.aggregateObservedThreshold,
    outerRepositoryLeaseEvidence: "separate",
    proofs,
    cleanup: { controller: stopped, workerScopes: "proved-in-report" },
  };
}

export async function main(env = process.env, run = checkpointMain) {
  const authority = concurrencyAuthority(env);
  if (!authority) {
    console.log("Skipped: explicit local concurrency qualification is not enabled.");
    return;
  }
  const abort = new AbortController(),
    stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const wait = (milliseconds) => sleep(milliseconds, undefined, { signal: abort.signal });
  try {
    const scenario =
      authority.scenario === "throughput"
        ? runConcurrencyScenario
        : authority.scenario === "lease-fault"
          ? runConcurrencyLeaseFaultScenario
          : runDirectorContentionScenario;
    return await run(env, scenario, {
      authority,
      scope:
        authority.scenario === "throughput"
          ? "installed-two-objective-useful-throughput"
          : authority.scenario === "lease-fault"
            ? "installed-two-objective-controller-expiry-fault"
            : "installed-inner-Director-contention-resource-ceilings",
      harnessPaths: [
        "scripts/verify-local-concurrency.mjs",
        "scripts/qualification-controller-freeze.mjs",
        "scripts/qualification-model-accounting.mjs",
        "scripts/qualification-director-contention.mjs",
        "scripts/qualification-sibling-refresh-proof.mjs",
        "scripts/qualification-merge-proof.mjs",
        "scripts/qualification-receipts.mjs",
        "scripts/verify-live-objective.mjs",
        "scripts/verify-local-faults.mjs",
        "scripts/verify-local-scheduling.mjs",
      ],
      preflight: async ({ evidence, request, list }) => {
        const repository = (await request("GET /repos/{owner}/{repo}")).data;
        evidence.defaultBranch = repository.default_branch;
        evidence.freezeCapability = inspectFreezeCapability();
        const issues = await list("GET /repos/{owner}/{repo}/issues", { state: "all" });
        for (const namespace of authority.namespaces)
          assert.ok(
            !issues.some((issue) => issue.body?.includes(qualificationNamespaceMarker(namespace))),
            "namespace already exists",
          );
      },
      extendPort: async ({
        port,
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
        runtimeEnvironment,
        retireClient,
      }) => {
        assert.equal(typeof retireClient, "function", "owned MCP retirement boundary unavailable");
        const [owner, repo] = authority.repository.split("/");
        const deadline = () =>
          checkpointDeadline(evidence.startedAt, authority.policy.objectiveTimeoutMinutes);
        const once = async (action, invoke) => {
          abort.signal.throwIfAborted();
          checkpointTimeout(deadline(), 1);
          assert.ok(
            !evidence.actions.some((entry) => entry.action === action),
            "uncertain action must not be retried",
          );
          const entry = { action, requestedAt: new Date().toISOString() };
          evidence.actions.push(entry);
          save();
          const result = await invoke();
          entry.response = result;
          entry.returnedAt = new Date().toISOString();
          save();
          return result;
        };
        const exclusiveAuthority = async () => {
          const issues = await list("GET /repos/{owner}/{repo}/issues", { state: "open" });
          const owned = new Map(
            (evidence.objectives ?? []).map((record) => [record.objective.number, record]),
          );
          const numbers = new Set([
            ...owned.keys(),
            ...issues
              .filter((issue) => issue.labels?.some((label) => label.name === "factory:objective"))
              .map((issue) => issue.number),
          ]);
          for (const number of numbers) {
            const status = await call("factory_status", { objectiveNumber: number }),
              record = owned.get(number);
            if (record?.activation)
              assert.equal(
                status.activation?.requestId,
                record.activation.arguments.requestId,
                "owned Objective authority changed",
              );
            else
              assert.ok(
                isQuiescentFaultObjective(status, authority.repository, number) ||
                  (record && status.run.state === "not-started" && !status.activation),
                "unrelated runnable authority appeared",
              );
          }
        };
        const commentCache = new Map();
        let commentCursor = Date.parse(evidence.startedAt);
        evidence.observer = {
          strategy: "repository-incremental-comments-with-fresh-acceptance",
          fullObjectiveSnapshots: 0,
          incrementalCommentListings: 0,
          unchangedIncrementalListings: 0,
        };
        const commentIssue = (comment) => {
          const prefix = `https://api.github.com/repos/${authority.repository}/issues/`;
          assert.equal(typeof comment.issue_url, "string", "canonical comment issue URL missing");
          assert.ok(comment.issue_url.startsWith(prefix), "comment belongs to another repository");
          const encoded = comment.issue_url.slice(prefix.length);
          assert.match(encoded, /^[1-9][0-9]*$/, "comment issue URL is malformed");
          const number = Number(encoded);
          assert.ok(Number.isSafeInteger(number) && number > 0, "comment issue unavailable");
          assert.ok(
            ["issues", "pull"].some(
              (kind) =>
                comment.html_url ===
                `https://github.com/${authority.repository}/${kind}/${number}#issuecomment-${comment.id}`,
            ),
            "comment HTML URL does not match its canonical issue target",
          );
          return number;
        };
        const rememberComments = (comments) => {
          const changed = new Set();
          const seen = new Map();
          for (const comment of comments) {
            assert.ok(Number.isSafeInteger(comment.id) && comment.id > 0);
            const issueNumber = commentIssue(comment);
            const updated = Date.parse(comment.updated_at ?? comment.created_at);
            assert.ok(Number.isFinite(updated), "comment update time unavailable");
            commentCursor = Math.max(commentCursor, updated);
            const version = hash({
              body: comment.body,
              htmlUrl: comment.html_url,
              issueUrl: comment.issue_url,
              createdAt: comment.created_at,
              updatedAt: comment.updated_at,
              userId: comment.user?.id,
              userLogin: comment.user?.login,
            });
            const duplicate = seen.get(comment.id);
            assert.ok(
              !duplicate || duplicate === version,
              "conflicting duplicate comment version in one listing",
            );
            seen.set(comment.id, version);
            if (commentCache.get(comment.id)?.version !== version) changed.add(comment.id);
            commentCache.set(comment.id, { comment, version, issueNumber });
          }
          return changed;
        };
        const receiptKey = (receipt) => `${receipt.commentId}:${hash(receipt.event)}`;
        const hintedObservation = (record, changedComments) => {
          assert.ok(record.latestFreshObservation, "fresh Objective baseline missing");
          const issueNumbers = new Set([
            record.objective.number,
            ...record.latestFreshObservation.children.map((child) => child.number),
          ]);
          const comments = [...commentCache.values()]
            .filter((entry) => issueNumbers.has(entry.issueNumber))
            .map((entry) => entry.comment);
          const receipts = authenticatedFaultEvents(
            comments,
            evidence.actor,
            record.objective.number,
          );
          const changedReceipts = authenticatedFaultEvents(
            comments.filter((comment) => changedComments.has(comment.id)),
            evidence.actor,
            record.objective.number,
          );
          const freshKeys = new Set(record.latestFreshObservation.receipts.map(receiptKey));
          const pendingReceipts = receipts.filter((receipt) => !freshKeys.has(receiptKey(receipt)));
          const graph = [...eventsOf({ receipts })]
            .reverse()
            .find((event) => ["GraphProjected", "GraphCompiled"].includes(event.event));
          if (graph)
            assert.ok(
              Number.isSafeInteger(graph.graphSize) && graph.graphSize > 0 && graph.graphSize <= 3,
              "topology receipt has invalid graph size",
            );
          const topologyPending = Boolean(
            graph && record.latestFreshObservation.children.length !== graph.graphSize,
          );
          const terminalStates = new Map([
            ["FactoryRunCompleted", "completed"],
            ["FactoryRunCancelled", "cancelled"],
            ["FactoryRunEscalated", "escalated"],
          ]);
          const terminalStatusPending = eventsOf({ receipts }).some((event) => {
            const expected = terminalStates.get(event.event);
            return expected && record.latestFreshObservation.status.run.state !== expected;
          });
          return {
            ...record.latestFreshObservation,
            receipts,
            changedReceipts,
            pendingReceipts,
            topologyPending,
            terminalStatusPending,
          };
        };
        const readIncrementalComments = async () => {
          const since = new Date(Math.max(Date.parse(evidence.startedAt), commentCursor - 1000));
          const comments = await list(
            "GET /repos/{owner}/{repo}/issues/comments",
            { since: since.toISOString(), sort: "updated", direction: "asc" },
            1000,
            { deadline: deadline() },
          );
          evidence.observer.incrementalCommentListings++;
          const changed = rememberComments(comments);
          if (changed.size === 0) evidence.observer.unchangedIncrementalListings++;
          evidence.observer.cursor = new Date(commentCursor).toISOString();
          save();
          return changed;
        };
        const observeOne = async (record, full = false) => {
          evidence.observer.fullObjectiveSnapshots++;
          const objective = (
            await request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
              issue_number: record.objective.number,
            })
          ).data;
          assert.equal(objective.id, record.objective.id);
          assert.equal(objective.user.id, evidence.actor.id);
          assert.equal(hash(objective.body), record.bodyDigest);
          const children = await list(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
            { issue_number: objective.number },
          );
          assert.ok(children.length <= 3);
          const comments = [],
            dependencies = [];
          for (const issue of [objective, ...children]) {
            const rows = await list("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
              issue_number: issue.number,
            });
            for (const comment of rows) {
              assert.ok(
                comment.html_url.startsWith(
                  `https://github.com/${authority.repository}/issues/${issue.number}#issuecomment-`,
                ),
              );
              comments.push(comment);
            }
            if (full && issue !== objective)
              dependencies.push({
                workItem: issue.number,
                blockedBy: await list(
                  "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
                  { issue_number: issue.number },
                ),
              });
          }
          rememberComments(comments);
          const receipts = authenticatedFaultEvents(comments, evidence.actor, objective.number);
          const observation = {
            receipts,
            status: await call("factory_status", { objectiveNumber: objective.number }),
            children,
          };
          record.latestFreshObservation = observation;
          if (!full) return observation;
          const events = receipts.map((receipt) => {
            const comment = one(
              comments.filter((row) => row.id === receipt.commentId),
              "receipt location ambiguous",
            );
            return {
              ...receipt.event,
              author: comment.user.login,
              authorId: comment.user.id,
              receiptUrl: comment.html_url,
            };
          });
          const numbers = [
            ...new Set(
              events
                .filter((event) => event.event === "PublicationRecorded")
                .map((event) => event.pullRequest),
            ),
          ];
          assert.equal(numbers.length, 3);
          const pulls = [];
          for (const number of numbers)
            pulls.push(
              (
                await request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
                  pull_number: number,
                })
              ).data,
            );
          return {
            ...observation,
            repository: authority.repository,
            namespace: record.namespace,
            actor: evidence.actor,
            objective,
            dependencies,
            pulls,
            events,
            policy: authority.policy,
            base: evidence.base,
            preflight: { base: evidence.base, defaultBranch: evidence.defaultBranch },
            runRequest: record.activation,
            runResult: {
              runId: observation.status.run.runId,
              objective: objective.number,
              status: observation.status.run.state,
            },
            runResultProvenance: "derived-authenticated-terminal-status-not-captured-RPC",
          };
        };
        const readOuter = async () => {
          const response = await request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
            ref: "clockgrove-factory/leases/repository-controller",
          });
          assert.ok(
            Number.isFinite(Date.parse(response.headers.date)),
            "fresh GitHub server time unavailable",
          );
          const commit = (
            await request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
              commit_sha: response.data.object.sha,
            })
          ).data;
          return {
            oid: response.data.object.sha,
            record: checkpointLease(commit, response.data.object.sha),
            parents: commit.parents.map((parent) => parent.sha),
            serverTime: response.headers.date,
          };
        };
        const readLease = async (objective, oid) => {
          if (!oid)
            oid = (
              await request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
                ref: `clockgrove-factory/leases/objective-${objective}`,
              })
            ).data.object.sha;
          const commit = (
            await request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { commit_sha: oid })
          ).data;
          assert.equal(commit.sha, oid);
          assert.ok(Buffer.byteLength(commit.message) <= 16384);
          const line = one(
            commit.message.split(/\r?\n/).filter((value) => value.startsWith("Factory-Event: ")),
            "inner lease trailer missing or repeated",
          );
          return {
            oid,
            event: JSON.parse(Buffer.from(line.slice(15), "base64url").toString("utf8")),
            parents: commit.parents.map((parent) => parent.sha),
          };
        };
        const readLeaseChain = async (objective) => {
          const chain = [];
          let current = await readLease(objective);
          for (let count = 0; count < 256; count++) {
            chain.push(current);
            if (current.event.previousOid === undefined) return chain;
            assert.equal(
              current.parents[0],
              current.event.previousOid,
              "inner lease parent differs from previousOid",
            );
            current = await readLease(objective, current.event.previousOid);
          }
          throw Error("inner lease chain exceeds the bounded observation limit");
        };
        const settled = (observation, paused, index = paused ? 1 : 0, activated = true) => {
          if (observation.status.run.state !== (paused ? "paused" : "completed")) return false;
          const events = eventsOf(observation),
            reservations = events.filter((event) => event.event === "AttemptReserved");
          if (
            !events.some(
              (event) => event.event === (paused ? "RunPauseAcknowledged" : "FactoryRunCompleted"),
            )
          )
            return false;
          if (
            reservations.some(
              (reserved) =>
                !events.some(
                  (event) => event.event === "AttemptIntegrated" && sameAttempt(event, reserved),
                ),
            )
          )
            return false;
          const start = events.find((event) => event.event === "FactoryRunStarted");
          if (
            !start ||
            qualificationModelAccounting(
              events.filter((event) => event.runId === start.runId),
              { requireMarkers: true },
            ).unresolved.length
          )
            return false;
          // Status and comments are independently fetched; one-sided completion is pending, not proof.
          assertConcurrencySettlement(observation, policyFor(authority, index), {
            paused,
            activated,
          });
          return true;
        };
        const startInstalledClient = async (name) => {
          const manifest = JSON.parse(
            readBounded(join(pluginRoot, ".codex-plugin/plugin.json"), 65536),
          );
          const mcp = manifest.mcpServers.factory;
          assert.equal(mcp.command, "sh");
          const token = command("gh", ["auth", "token"], authority.checkout);
          const client = new Client({ name, version: "1.0.0" });
          const transport = new StdioClientTransport({
            command: mcp.command,
            args: mcp.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", pluginRoot)),
            cwd: authority.checkout,
            env: { ...runtimeEnvironment, GITHUB_TOKEN: token },
            stderr: "pipe",
          });
          await client.connect(transport);
          transport.stderr?.on("data", () => {});
          assert.equal(client.getServerVersion()?.version, artifact.version);
          const pid = transport.pid;
          assert.ok(Number.isSafeInteger(pid) && pid > 1);
          const stat = readBounded(`/proc/${pid}/stat`, 16384),
            startTicks = stat
              .slice(stat.lastIndexOf(")") + 2)
              .trim()
              .split(/\s+/)[19];
          assert.match(startTicks, /^\d+$/);
          assert.equal(realpathSync(`/proc/${pid}/cwd`), authority.checkout);
          const clientInvocationId = hash({
            artifact,
            pid,
            startTicks,
            name,
          });
          const close = async () => {
            await client.close().catch(() => undefined);
            for (let attempt = 0; attempt < 30; attempt++) {
              try {
                const currentStat = readBounded(`/proc/${pid}/stat`, 16384);
                const current = currentStat
                  .slice(currentStat.lastIndexOf(")") + 2)
                  .trim()
                  .split(/\s+/)[19];
                if (current !== startTicks) return true;
              } catch (error) {
                if (error.code === "ENOENT") return true;
                throw error;
              }
              await sleep(100);
            }
            return false;
          };
          return { client, pid, startTicks, clientInvocationId, close };
        };
        return {
          ...port,
          settled,
          action: async (action) => {
            await exclusiveAuthority();
            return port.action(action);
          },
          prepare: async (stage) => {
            assert.ok(["create", "activate", "activate-peer"].includes(stage));
            if (stage === "create") {
              evidence.objectives = [];
              const sharedSlug = authority.namespace.replace(/[^a-z0-9-]/g, "-");
              evidence.directorContention =
                authority.scenario === "director-contention"
                  ? {
                      sharedPath: `src/factory-qualification/${sharedSlug}/shared/`,
                      sharedResource: `factory-qualification-${sharedSlug}`,
                      capacitySnapshots: [],
                    }
                  : undefined;
              for (const [index, namespace] of authority.namespaces.entries()) {
                const body =
                  authority.scenario === "director-contention"
                    ? directorContentionObjectiveBody(
                        namespace,
                        index,
                        evidence.directorContention.sharedPath,
                        evidence.directorContention.sharedResource,
                      )
                    : concurrencyObjectiveBody(namespace, index);
                const objective = await once(
                  `create-${index}`,
                  async () =>
                    (
                      await request("POST /repos/{owner}/{repo}/issues", {
                        title: `Factory local concurrency [${namespace}]`,
                        body,
                      })
                    ).data,
                );
                const record = { namespace, objective, bodyDigest: hash(body) };
                evidence.objectives.push(record);
                save();
                await waitForCreatedObjectiveNamespace({
                  list,
                  namespace,
                  createdIssue: objective,
                });
              }
              return;
            }
            const selected =
              stage === "activate-peer"
                ? [[1, evidence.objectives[1]]]
                : evidence.objectives.entries();
            for (const [index, record] of selected) {
              const args = {
                owner,
                repo,
                objectiveNumber: record.objective.number,
                requestId: `${record.namespace}-activate`,
                baseSha: evidence.base,
                policy: authority.policy,
              };
              record.activation = { tool: "factory_activate", arguments: args };
              save();
              await once(`activate-${index}`, () => call("factory_activate", args));
            }
            // Re-read the public admission surface immediately before starting the shared controller.
            const issues = await list("GET /repos/{owner}/{repo}/issues", { state: "open" });
            const owned = new Set(evidence.objectives.map((record) => record.objective.number));
            for (const issue of issues.filter((issue) =>
              issue.labels?.some((label) => label.name === "factory:objective"),
            )) {
              if (owned.has(issue.number)) continue;
              assert.ok(
                isQuiescentFaultObjective(
                  await call("factory_status", { objectiveNumber: issue.number }),
                  authority.repository,
                  issue.number,
                ),
                "unrelated runnable authority appeared before controller start",
              );
            }
            assert.equal(
              (
                await request("GET /repos/{owner}/{repo}/commits/{ref}", {
                  ref: evidence.defaultBranch,
                })
              ).data.sha,
              evidence.base,
              "base advanced before owned activations started",
            );
          },
          stagger: async (original) => {
            const began = performance.now();
            for (let index = 0; index < 12; index++) {
              assert.ok(
                performance.now() - began < 240000,
                "bounded initial offset observation expired",
              );
              abort.signal.throwIfAborted();
              await port.controller("active", original);
              evidence.stagger = {
                purpose: "model-free-expiry-offset-opportunity-not-expiry-proof",
                elapsedMs: Math.floor(performance.now() - began),
                requestedDelayMs: 180000,
              };
              save();
              await wait(checkpointTimeout(deadline(), 15000));
            }
            evidence.stagger.elapsedMs = Math.floor(performance.now() - began);
            save();
          },
          contend: async (pair) => {
            await once("same-objective-contention", async () => {
              const objective = evidence.objectives[0].objective.number;
              const before = await readLease(objective);
              const response = await invoke("factory_run", {
                objectiveNumber: objective,
                repository: authority.checkout,
                untilTerminal: true,
                policy: authority.policy,
              });
              const after = await readLease(objective);
              assert.ok(
                eventsOf(pair[0]).some((event) => event.event === "ControllerObserved"),
                "controller observation missing before Objective contention",
              );
              return assertObjectiveContention({ response, before, after, objective });
            });
          },
          pollPeer: async () => {
            const record = evidence.objectives[1];
            for (let attempt = 0; attempt < 48; attempt++) {
              abort.signal.throwIfAborted();
              checkpointTimeout(deadline(), 1);
              const observation = await observeOne(record);
              evidence.latestPeer = observation;
              save();
              const events = eventsOf(observation);
              const snapshot = capacitySnapshot([observation]);
              if (
                events.some((event) => event.event === "FactoryRunStarted") &&
                events.some((event) => event.event === "ControllerObserved") &&
                snapshot.reservations.some((reservation) =>
                  reservation.paths.includes(evidence.directorContention.sharedPath),
                ) &&
                snapshot.reservations.some((reservation) =>
                  reservation.exclusiveResources.includes(
                    evidence.directorContention.sharedResource,
                  ),
                )
              ) {
                evidence.directorContention.capacitySnapshots.push(snapshot);
                save();
                return observation;
              }
              await wait(checkpointTimeout(deadline(), 10000));
            }
            throw Error("peer Objective did not start within the bounded observation window");
          },
          innerCasCollision: async (controller) =>
            once("inner-cas-collision", async () => {
              const record = evidence.objectives[0],
                peerRecord = evidence.objectives[1],
                objective = record.objective.number;
              const beforeRefs = (
                await request("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
                  ref: `clockgrove-factory/leases/objective-${objective}`,
                })
              ).data;
              assert.deepEqual(beforeRefs, [], "inner collision lease already exists");
              assert.equal(
                (
                  await request("GET /repos/{owner}/{repo}/commits/{ref}", {
                    ref: evidence.defaultBranch,
                  })
                ).data.sha,
                evidence.base,
                "peer integrated before the absent-lease collision boundary",
              );
              const peerBefore = await observeOne(peerRecord),
                peerBeforeSequence = Math.max(
                  0,
                  ...eventsOf(peerBefore).map((event) => event.sequence),
                ),
                contenders = [];
              try {
                contenders.push(await startInstalledClient("factory-inner-cas-a"));
                contenders.push(await startInstalledClient("factory-inner-cas-b"));
              } catch (error) {
                for (const contender of contenders) await contender.close();
                throw error;
              }
              const barrierDigest = hash({
                repository: authority.repository,
                objective,
                clients: contenders.map((entry) => entry.clientInvocationId).sort(),
              });
              const args = {
                owner,
                repo,
                objectiveNumber: objective,
                repository: authority.checkout,
                untilTerminal: true,
                policy: authority.policy,
              };
              evidence.directorContention.collision = {
                barrierDigest,
                objective,
                beforeLease: null,
                clients: contenders.map(({ clientInvocationId, pid, startTicks }) => ({
                  clientInvocationId,
                  pid,
                  startTicks,
                })),
                requestedAt: new Date().toISOString(),
              };
              save();
              let completed = false;
              const calls = contenders.map((entry) =>
                entry.client.callTool({ name: "factory_run", arguments: args }, undefined, {
                  timeout: checkpointTimeout(deadline(), 7_200_000),
                  maxTotalTimeout: checkpointTimeout(deadline(), 7_200_000),
                }),
              );
              const settlement = Promise.allSettled(calls).then((value) => {
                completed = true;
                return value;
              });
              let results;
              const processAbsence = [];
              try {
                for (let sample = 0; !completed; sample++) {
                  assert.ok(sample < 254, "inner collision observation bound exhausted");
                  const done = await Promise.race([
                    settlement.then(() => true),
                    wait(checkpointTimeout(deadline(), 10000)).then(() => false),
                  ]);
                  if (done) break;
                  const pair = [];
                  for (const current of evidence.objectives) pair.push(await observeOne(current));
                  evidence.directorContention.capacitySnapshots.push(capacitySnapshot(pair));
                  save();
                }
                results = await settlement;
              } finally {
                for (const contender of contenders) processAbsence.push(await contender.close());
                evidence.directorContention.collision.processAbsence = processAbsence;
                save();
              }
              assert.ok(processAbsence.every(Boolean), "inner contender process absence unproved");
              assert.ok(
                results.every((result) => result.status === "fulfilled"),
                "inner collision response loss is ambiguous; retain the repository without retry or cleanup",
              );
              const responses = results.map((result) => ({
                status: "fulfilled",
                response: result.value,
              }));
              const winnerIndex = responses.findIndex(
                (result) => result.status === "fulfilled" && !result.response.isError,
              );
              assert.ok(winnerIndex >= 0, "inner collision has no completed winner");
              assert.equal(
                responses.filter(
                  (result) => result.status === "fulfilled" && !result.response.isError,
                ).length,
                1,
                "inner collision produced multiple winners",
              );
              const loserIndex = 1 - winnerIndex,
                loser = responses[loserIndex];
              assert.deepEqual(
                { isError: loser.response.isError, content: loser.response.content },
                {
                  isError: true,
                  content: [{ type: "text", text: "another Director won lease acquisition" }],
                },
                "losing Director did not report the exact create-ref CAS loss",
              );
              const leaseChain = await readLeaseChain(objective),
                final = await observeOne(record),
                start = one(
                  eventsOf(final).filter((event) => event.event === "FactoryRunStarted"),
                  "winning inner run missing",
                ),
                peerAfter = await observeOne(peerRecord);
              const winnerText = responses[winnerIndex].response.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
              assert.ok(Buffer.byteLength(winnerText) <= 65536, "winning response is unbounded");
              const winnerReport = JSON.parse(winnerText);
              assert.deepEqual(
                {
                  objective: winnerReport.objective,
                  runId: winnerReport.runId,
                  status: winnerReport.status,
                },
                { objective, runId: start.runId, status: "completed" },
                "winning response differs from the authenticated terminal run",
              );
              const collision = {
                objective,
                runId: start.runId,
                policyDigest: start.policyDigest,
                baseSha: evidence.base,
                beforeLease: null,
                leaseChain,
                contenders: contenders.map((entry, index) => ({
                  clientInvocationId: entry.clientInvocationId,
                  pid: entry.pid,
                  startTicks: entry.startTicks,
                  barrierDigest,
                  automaticRetry: false,
                  ...(index === winnerIndex
                    ? { outcome: "won", observedHolder: leaseChain.at(-1).event.holder }
                    : {
                        outcome: "lease-cas-lost",
                        errorCode: "inner-lease-cas-lost",
                        observedHolder: "unavailable-before-winning-CAS",
                      }),
                })),
                events: eventsOf(final),
                peer: {
                  objective: peerRecord.objective.number,
                  beforeSequence: peerBeforeSequence,
                  events: eventsOf(peerAfter),
                  outerLeaseEvidence: "separate",
                },
              };
              evidence.directorContention.collision = {
                ...evidence.directorContention.collision,
                completedAt: new Date().toISOString(),
                processAbsence,
                proof: assertInnerDirectorCollision(collision),
              };
              save();
              await port.controller("active", controller);
              return {
                ...collision,
                events: [],
                peer: { ...collision.peer, events: [] },
              };
            }),
          scoped: async (action) =>
            once(`${action}-b`, () =>
              call(`factory_${action}`, {
                objectiveNumber: evidence.objectives[1].objective.number,
                requestId: `${authority.namespaces[1]}-${action}`,
              }),
            ),
          pollPair: async (phase, accept) => {
            const maximumPolls = Math.ceil(
              (authority.policy.objectiveTimeoutMinutes * 60000) / 15000,
            );
            let pair = [];
            for (const record of evidence.objectives) pair.push(await observeOne(record));
            for (let count = 0; count < maximumPolls; count++) {
              abort.signal.throwIfAborted();
              checkpointTimeout(deadline(), 1);
              evidence.latestPair = pair;
              evidence.observationPhase = phase;
              save();
              assert.ok(
                pair.every(
                  (observation) =>
                    !["cancelled", "escalated"].includes(observation.status.run.state),
                ),
                "owned run ended before scenario completion",
              );
              checkpointTimeout(deadline(), 1);
              const accepted = accept(pair);
              checkpointTimeout(deadline(), 1);
              if (accepted) return pair;
              assert.ok(
                !(
                  phase === "refill" &&
                  pair.every((observation) => observation.status.run.state === "completed")
                ),
                "actual refill timing not observed",
              );
              await wait(checkpointTimeout(deadline(), 15000));
              const changedComments = await readIncrementalComments();
              const hinted = evidence.objectives.map((record) =>
                hintedObservation(record, changedComments),
              );
              if (!concurrencyReceiptProgress(phase, hinted) && !adverseProgress(hinted)) continue;
              // Incremental comments are wake hints only. Every acceptance, terminal refusal and
              // subsequent action is based on a fresh complete authenticated observation pair.
              pair = [];
              for (const record of evidence.objectives) pair.push(await observeOne(record));
            }
            throw Error("bounded scenario observation exhausted");
          },
          captureCheckpoint: async (pair, original) => {
            pair = [];
            for (const record of evidence.objectives) pair.push(await observeOne(record));
            assertConcurrencySettlement(pair[0], policyFor(authority, 0));
            assertConcurrencySettlement(pair[1], policyFor(authority, 1), { paused: true });
            const absence = [];
            for (const [index, observation] of pair.entries()) {
              evidence.objective = evidence.objectives[index].objective;
              absence.push(await port.absence(observation, [original]));
            }
            evidence.concurrencyCheckpoint = {
              pair,
              original,
              absence,
              inner: await readLease(evidence.objectives[1].objective.number),
            };
            save();
          },
          innerContend: async (original) => {
            await exclusiveAuthority();
            await port.controller("active", original);
            const checkpoint = evidence.concurrencyCheckpoint;
            const b = evidence.objectives[1],
              initial = await observeOne(b);
            assertConcurrencySettlement(initial, policyFor(authority, 1), { paused: true });
            const inner = await readLease(b.objective.number),
              outer = await readOuter();
            for (const key of ["holder", "epoch", "objective", "runId", "policyDigest"])
              assert.equal(
                inner.event[key],
                checkpoint.inner.event[key],
                "inner generation changed after accounted checkpoint",
              );
            assert.equal(inner.event.protocol, "clockgrove.factory/v2");
            assert.equal(inner.event.kind, "lease");
            assert.match(inner.event.holder, /^[A-Za-z0-9_.-]{1,160}$/);
            const start = one(
              eventsOf(initial).filter((event) => event.event === "FactoryRunStarted"),
              "original run missing",
            );
            for (const key of ["objective", "runId", "policyDigest"])
              assert.equal(inner.event[key], start[key]);
            const oldController = eventsOf(initial)
              .filter((event) => event.event === "ControllerObserved")
              .at(-1);
            assert.equal(outer.record.controllerId, oldController.controllerId);
            assert.equal(outer.record.epoch, oldController.epoch);
            const window = assertInnerContentionWindow({
              outer: outer.record,
              inner: inner.event,
              serverTime: outer.serverTime,
              remainingMs: deadline() - Date.now(),
            });
            const cgroup = command("systemctl", [
              "--user",
              "show",
              authority.unit,
              "--property=ControlGroup",
              "--value",
            ]);
            assert.ok(cgroup.endsWith(`/${authority.unit}`));
            const node = realpathSync(process.execPath),
              bundle = realpathSync(join(pluginRoot, "dist/factory.js"));
            const spec = {
              ...original,
              uid: process.getuid(),
              cgroup,
              node,
              checkout: authority.checkout,
              configPath: join(homedir(), ".config/systemd/user", authority.unit),
              argv: [
                node,
                bundle,
                "controller",
                "run",
                authority.repository,
                "--repo",
                authority.checkout,
              ],
              maximumMs: window.maximumMs,
            };
            evidence.innerContention = { window, outer, inner, freeze: [], result: "pending" };
            save();
            await withFrozenController(
              spec,
              async (assertFrozen) => {
                assert.equal(
                  (await readOuter()).oid,
                  outer.oid,
                  "outer lease advanced before freeze",
                );
                assert.equal(
                  (await readLease(b.objective.number)).oid,
                  inner.oid,
                  "inner lease advanced before freeze",
                );
                let fresh;
                for (let count = 0; count < 42; count++) {
                  abort.signal.throwIfAborted();
                  assertFrozen();
                  fresh = await readOuter();
                  assert.equal(
                    fresh.oid,
                    outer.oid,
                    "another controller replaced the frozen holder",
                  );
                  evidence.innerContention.wait = {
                    serverTime: fresh.serverTime,
                    polls: count + 1,
                  };
                  save();
                  if (Date.parse(fresh.serverTime) > window.outerExpiry) break;
                  await wait(checkpointTimeout(deadline(), 15000));
                }
                assert.ok(Date.parse(fresh.serverTime) > window.outerExpiry);
                assert.ok(
                  window.innerExpiry - Date.parse(fresh.serverTime) >= 135000,
                  "live inner refusal window exhausted before contender",
                );
                assert.equal((await readLease(b.objective.number)).oid, inner.oid);
                assertFrozen();
                abort.signal.throwIfAborted();
                await once("inner-lease-held-contender", async () => {
                  let response;
                  try {
                    response = await invoke("factory_run", {
                      objectiveNumber: b.objective.number,
                      repository: authority.checkout,
                      untilTerminal: true,
                      policy: authority.policy,
                    });
                  } catch {
                    // A client deadline is not evidence that its handler or remote request stopped.
                    // Retire the exact owned client before thaw and keep the durable pause intact;
                    // no resume/restart path is reachable from this uncertain outcome.
                    const uncertain = {
                      outcome: "unknown",
                      continuation: "forbidden",
                      process: { absence: "unknown" },
                      remoteObservation: "unavailable",
                    };
                    evidence.innerContention.uncertainContender = uncertain;
                    save();
                    try {
                      uncertain.process = await retireClient();
                    } catch {
                      /* retain explicit unknown */
                    }
                    save();
                    try {
                      const comments = [];
                      for (const issue of [b.objective, ...initial.children])
                        comments.push(
                          ...(await list(
                            "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
                            { issue_number: issue.number },
                          )),
                        );
                      const receipts = authenticatedFaultEvents(
                        comments,
                        evidence.actor,
                        b.objective.number,
                      );
                      uncertain.remoteObservation = {
                        outer: await readOuter(),
                        inner: await readLease(b.objective.number),
                        receipts,
                        runHistoryUnchanged: hash(receipts) === hash(initial.receipts),
                        settlementClaim: "none; fresh observation only",
                      };
                    } catch {
                      /* a missing read never proves remote-request settlement */
                    }
                    save();
                    throw Error("inner contender outcome is unknown; no automatic continuation");
                  }
                  const released = await readOuter();
                  assert.equal(released.record.event, "RepositoryLeaseReleased");
                  const commit = (
                    await request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
                      commit_sha: released.record.previousOid,
                    })
                  ).data;
                  const acquired = {
                    oid: commit.sha,
                    record: checkpointLease(commit, commit.sha),
                    parents: commit.parents.map((parent) => parent.sha),
                  };
                  assertHeldInnerRefusal({
                    response,
                    objective: b.objective.number,
                    inner,
                    afterInner: await readLease(b.objective.number),
                    outer,
                    acquired,
                    released,
                  });
                  const after = await observeOne(b);
                  assert.deepEqual(
                    after.receipts,
                    initial.receipts,
                    "losing inner contender changed run/admission/accounting history",
                  );
                  evidence.innerContention.result = "inner-lease-held-refusal";
                  save();
                  return {
                    response,
                    acquired,
                    released,
                    innerOidUnchanged: inner.oid,
                    admissionsAdded: 0,
                  };
                });
              },
              (observation) => {
                evidence.innerContention.freeze.push(observation);
                save();
              },
            );
            // Give the original actor a bounded chance to hit its stale outer fence. No task is resumed.
            let gone = false;
            for (let count = 0; count < 7; count++) {
              abort.signal.throwIfAborted();
              try {
                const stat = readBounded(`/proc/${original.pid}/stat`, 16384);
                gone =
                  stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] !== original.startTicks;
              } catch (error) {
                if (error.code !== "ENOENT") throw error;
                gone = true;
              }
              if (gone) break;
              await wait(checkpointTimeout(deadline(), 15000));
            }
            assert.ok(gone, "stale controller did not retire within the observed bound");
            const journal = command("journalctl", [
              "--user",
              "--no-pager",
              "-n",
              "100",
              "-o",
              "cat",
              `_SYSTEMD_INVOCATION_ID=${original.invocationId}`,
            ]);
            assert.ok(
              journal.includes("repository-lease-lost"),
              "stale outer-actor fencing diagnostic not observed",
            );
            const after = await observeOne(b);
            assert.deepEqual(
              after.receipts,
              initial.receipts,
              "stale actor changed paused run history",
            );
            assert.equal(
              (await readLease(b.objective.number)).oid,
              inner.oid,
              "stale actor changed original inner ownership",
            );
            evidence.innerContention.staleActor = {
              original,
              absent: true,
              diagnostic: "repository-lease-lost",
              runHistoryUnchanged: true,
            };
            save();
            await once("stop-stale", async () => {
              await exclusiveAuthority();
              assert.equal(
                assertControllerUnit(readBounded(spec.configPath, 16384), {
                  repository: authority.repository,
                  checkout: authority.checkout,
                  node,
                  bundle,
                }),
                original.configDigest,
              );
              const raw = command("systemctl", [
                "--user",
                "show",
                authority.unit,
                "--property=Id,LoadState,ActiveState,SubState,Job,InvocationID,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus,Result,FragmentPath,DropInPaths,NeedDaemonReload",
              ]);
              const rows = raw.split("\n").map((line) => {
                const index = line.indexOf("=");
                assert.ok(index > 0);
                return [line.slice(0, index), line.slice(index + 1)];
              });
              const fields = Object.fromEntries(rows);
              assert.equal(Object.keys(fields).length, rows.length);
              assertRetiredController(fields, original, spec.configPath);
              evidence.innerContention.staleActor.unitBeforeStop = fields;
              evidence.innerContention.staleActor.stopBoundary =
                "exact-pre-call-observation; public-stop-is-not-generation-conditional";
              save();
              return call("factory_controller_stop", {
                repository: authority.checkout,
                requestId: `${authority.namespace}-stop-stale`,
              });
            });
            evidence.innerContention.staleActor.unitAfterStop = await port.controller("inactive");
            save();
            // A stale actor cannot release its old inner lease through a lost outer fence. Wait for
            // that actual server-relative expiry before the normal public restart/resume path.
            for (let count = 0; count < 24; count++) {
              abort.signal.throwIfAborted();
              const observed = await readOuter();
              if (Date.parse(observed.serverTime) > window.innerExpiry) return;
              assert.ok(deadline() - Date.now() > 300000, "original completion deadline exhausted");
              await wait(checkpointTimeout(deadline(), 15000));
            }
            throw Error("original inner lease expiry not observed within bound");
          },
          finishDirectorContention: async (_pair, controller, collision) => {
            checkpointTimeout(deadline(), 1);
            const final = [];
            for (const record of evidence.objectives) final.push(await observeOne(record, true));
            const peerSnapshots = final.map((entry) => structuredClone(entry));
            for (const [index, entry] of final.entries()) {
              assertConcurrencySettlement(entry, policyFor(authority, index), {
                activated: index === 1,
              });
              entry.controllerQualification = {
                boundary: index === 0 ? "foreground-inner-Director" : "repository-controller",
                peers: [peerSnapshots[1 - index]],
              };
              entry.modelConfiguration = concurrencyModelConfiguration(
                entry,
                policyFor(authority, index),
              );
              entry.measurements = concurrencyMeasurements(entry, evidence.observer);
              entry.mergeProofs = await observeSettledConcurrencyMergeProofs({
                entry,
                request,
                repository: authority.repository,
              });
            }
            evidence.directorContention.capacitySnapshots.push(capacitySnapshot(final));
            const allEvents = final.flatMap((entry) => entry.events);
            const innerCollision = assertInnerDirectorCollision({
              ...collision,
              events: final[0].events,
              peer: { ...collision.peer, events: final[1].events },
            });
            const resourceCeilings = assertResourceCeilingEvidence({
              snapshots: evidence.directorContention.capacitySnapshots,
              events: allEvents,
            });
            const beforeReadOnly = {
              branch: (
                await request("GET /repos/{owner}/{repo}/commits/{ref}", {
                  ref: evidence.defaultBranch,
                })
              ).data.sha,
              receipts: final.map((entry) => hash(entry.receipts.map(({ event }) => event))),
            };
            const readOnlyEvidence = [];
            for (const [index, record] of evidence.objectives.entries()) {
              const explain = await call("factory_explain", {
                objectiveNumber: record.objective.number,
              });
              const replay = await call("factory_replay", {
                objectiveNumber: record.objective.number,
              });
              readOnlyEvidence.push(
                assertExplainReplayEvidence({
                  repository: authority.repository,
                  objective: record.objective.number,
                  events: final[index].events,
                  explain,
                  replay,
                }),
              );
            }
            const afterReadOnly = {
              branch: (
                await request("GET /repos/{owner}/{repo}/commits/{ref}", {
                  ref: evidence.defaultBranch,
                })
              ).data.sha,
              receipts: [],
            };
            for (const record of evidence.objectives) {
              const observation = await observeOne(record);
              afterReadOnly.receipts.push(hash(observation.receipts.map(({ event }) => event)));
            }
            assert.deepEqual(
              afterReadOnly,
              beforeReadOnly,
              "read-only evidence changed durable state",
            );
            await port.controller("active", controller);
            const absence = [];
            for (const [index, observation] of final.entries()) {
              evidence.objective = evidence.objectives[index].objective;
              absence.push(await port.absence(observation, [controller]));
            }
            assert.deepEqual(installedBundleIdentity(pluginRoot), artifact);
            const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
            for (const entry of evidence.harnessFiles)
              assert.equal(
                hash(readBounded(join(sourceRoot, entry.path), 262144)),
                entry.sha256,
                "qualifier dependency changed during execution",
              );
            const artifactProof = await verifyConcurrencyArtifacts(
              request,
              authority,
              evidence.defaultBranch,
              final,
              deadline(),
            );
            const report = {
              protocol: "clockgrove.factory/director-contention-qualification",
              scenario: "director-contention",
              candidate: artifact,
              innerCollision,
              resourceCeilings,
              readOnlyEvidence,
              controllerGeneration: {
                unit: controller.unit,
                invocationId: controller.invocationId,
                pid: controller.pid,
                startTicks: controller.startTicks,
                hostIdentity: controller.hostIdentity,
                configDigest: controller.configDigest,
                outerRepositoryLeaseEvidence: "separate",
              },
              usage: {
                modelTokensExact: final.map(
                  (entry, index) =>
                    assertConcurrencySettlement(entry, policyFor(authority, index), {
                      activated: index === 1,
                    }).modelTokens,
                ),
                nativeAccounting: "exact",
                unknown: [],
              },
              cleanup: { workerScopes: absence },
              artifactProof,
            };
            assert.ok(
              Buffer.byteLength(JSON.stringify(report)) <= 262144,
              "director contention report is unbounded",
            );
            evidence.finalObjectives = final;
            evidence.concurrencyProof = report;
            save();
            return report;
          },
          finishThroughput: async (_pair, controller, refill) => {
            checkpointTimeout(deadline(), 1);
            const final = [];
            for (const record of evidence.objectives) final.push(await observeOne(record, true));
            const originalController = final[0].events.find(
              (event) => event.event === "ControllerObserved",
            );
            assert.ok(originalController);
            const generation = Object.fromEntries(
              ["controllerId", "epoch", "controllerPolicyDigest"].map((key) => [
                key,
                originalController[key],
              ]),
            );
            assert.ok(
              final[1].events.some(
                (event) =>
                  event.event === "ControllerObserved" &&
                  Object.keys(generation).every((key) => event[key] === generation[key]),
              ),
              "Objectives did not share one authenticated discovery generation",
            );
            const peerSnapshots = final.map((entry) => structuredClone(entry));
            for (const [index, entry] of final.entries()) {
              assertConcurrencySettlement(entry, policyFor(authority, index));
              entry.controllerQualification = { generation, peers: [peerSnapshots[1 - index]] };
              entry.modelConfiguration = concurrencyModelConfiguration(
                entry,
                policyFor(authority, index),
              );
              entry.measurements = concurrencyMeasurements(entry, evidence.observer);
              entry.mergeProofs = await observeSettledConcurrencyMergeProofs({
                entry,
                request,
                repository: authority.repository,
              });
            }
            const absence = [];
            for (const [index, observation] of final.entries()) {
              evidence.objective = evidence.objectives[index].objective;
              absence.push(await port.absence(observation, [controller]));
            }
            assert.deepEqual(installedBundleIdentity(pluginRoot), artifact);
            const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
            for (const entry of evidence.harnessFiles)
              assert.equal(
                hash(readBounded(join(sourceRoot, entry.path), 262144)),
                entry.sha256,
                "qualifier dependency changed during execution",
              );
            const artifactProof = await verifyConcurrencyArtifacts(
              request,
              authority,
              evidence.defaultBranch,
              final,
              deadline(),
            );
            const observedRefill = concurrencyRefill(final);
            assert.ok(observedRefill);
            assert.deepEqual(observedRefill.refill, refill.refill);
            evidence.finalObjectives = final;
            evidence.concurrencyProof = {
              scenario: "throughput",
              artificialDelayMs: 0,
              refill: observedRefill,
              absence,
              artifactProof,
              measurements: final.map((entry) => entry.measurements),
            };
            save();
            return {
              refill: observedRefill,
              modelTokensKnown: final.map(
                (entry, index) =>
                  assertConcurrencySettlement(entry, policyFor(authority, index)).modelTokens,
              ),
              modelConfiguration: final.map((entry) => entry.modelConfiguration),
              measurements: final.map((entry) => entry.measurements),
              artifactProof,
            };
          },
          finish: async (_pair, original, replacement, refill) => {
            checkpointTimeout(deadline(), 1);
            const final = [];
            for (const record of evidence.objectives) final.push(await observeOne(record, true));
            const starts = final.map((entry) =>
              one(
                entry.events.filter((event) => event.event === "FactoryRunStarted"),
                "fresh run missing",
              ),
            );
            const originalController = final[0].events.find(
              (event) => event.event === "ControllerObserved",
            );
            assert.ok(originalController);
            const generation = Object.fromEntries(
              ["controllerId", "epoch", "controllerPolicyDigest"].map((key) => [
                key,
                originalController[key],
              ]),
            );
            assert.ok(
              final[1].events.some(
                (event) =>
                  event.event === "ControllerObserved" &&
                  Object.keys(generation).every((key) => event[key] === generation[key]),
              ),
              "Objectives did not share one authenticated controller generation",
            );
            const peerSnapshots = final.map((entry) => structuredClone(entry));
            for (const [index, entry] of final.entries()) {
              assertConcurrencySettlement(entry, policyFor(authority, index));
              entry.controllerQualification = { generation, peers: [peerSnapshots[1 - index]] };
              entry.modelConfiguration = concurrencyModelConfiguration(
                entry,
                policyFor(authority, index),
              );
              entry.measurements = concurrencyMeasurements(entry, evidence.observer);
              entry.mergeProofs = await observeSettledConcurrencyMergeProofs({
                entry,
                request,
                repository: authority.repository,
              });
            }
            evidence.finalObjectives = final;
            save();
            const before = evidence.concurrencyCheckpoint.inner,
              after = await readLease(evidence.objectives[1].objective.number),
              chain = [];
            let cursor = after;
            while (cursor.oid !== before.oid) {
              assert.ok(chain.length < 100);
              assert.match(cursor.event.previousOid, /^[a-f0-9]{40}$/);
              cursor = await readLease(
                evidence.objectives[1].objective.number,
                cursor.event.previousOid,
              );
              chain.push(cursor);
            }
            const inner = assertInnerTakeover(before, after, chain, starts[1]);
            const bEvents = eventsOf(final[1]);
            const resume = one(
              bEvents.filter(
                (event) =>
                  event.event === "RunResumeRequested" &&
                  event.requestId === `${authority.namespaces[1]}-resume`,
              ),
              "exact same-run resume missing",
            );
            const pause = one(
              bEvents.filter(
                (event) =>
                  event.event === "RunPauseAcknowledged" &&
                  event.commandRequestId === `${authority.namespaces[1]}-pause`,
              ),
              "original scoped pause missing",
            );
            assert.ok(resume.sequence > pause.sequence);
            const later = bEvents.filter(
              (event) => event.event === "AttemptReserved" && event.sequence > pause.sequence,
            );
            assert.equal(later.length, 1, "restart must release only the remaining original join");
            assert.ok(
              later[0].sequence > resume.sequence && later[0].directorEpoch > before.event.epoch,
              "resumed admission lacks fresh inner epoch",
            );
            assert.ok(
              bEvents.some(
                (event) =>
                  event.event === "ControllerObserved" &&
                  event.controllerId === evidence.takeover.lease.controllerId &&
                  event.epoch === evidence.takeover.lease.epoch &&
                  event.sequence < later[0].sequence,
              ),
              "resumed admission lacks captured repository takeover",
            );
            for (const [index, checkpoint] of evidence.concurrencyCheckpoint.pair.entries()) {
              for (const receipt of checkpoint.receipts)
                assert.ok(
                  final[index].receipts.some(
                    (current) => hash(current.event) === hash(receipt.event),
                  ),
                  "checkpoint history disappeared or changed after restart",
                );
            }
            const absence = [];
            for (const [index, observation] of final.entries()) {
              evidence.objective = evidence.objectives[index].objective;
              absence.push(await port.absence(observation, [original, replacement]));
            }
            assert.deepEqual(installedBundleIdentity(pluginRoot), artifact);
            const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
            for (const entry of evidence.harnessFiles)
              assert.equal(
                hash(readBounded(join(sourceRoot, entry.path), 262144)),
                entry.sha256,
                "qualifier dependency changed during execution",
              );
            const artifactProof = await verifyConcurrencyArtifacts(
              request,
              authority,
              evidence.defaultBranch,
              final,
              deadline(),
            );
            checkpointTimeout(deadline(), 1);
            evidence.concurrencyProof = {
              scenario: "lease-fault",
              refill: concurrencyRefill(final),
              inner,
              absence,
              artifactProof,
              measurements: final.map((entry) => entry.measurements),
            };
            save();
            assert.ok(evidence.concurrencyProof.refill);
            assert.deepEqual(evidence.concurrencyProof.refill.refill, refill.refill);
            return {
              inner,
              modelTokensKnown: final.map(
                (entry, index) =>
                  assertConcurrencySettlement(entry, policyFor(authority, index)).modelTokens,
              ),
              modelConfiguration: final.map((entry) => entry.modelConfiguration),
              measurements: final.map((entry) => entry.measurements),
              artifactProof,
            };
          },
        };
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/** Independent bounded retained-artifact behavior. No checkout hooks, package install or inherited credentials. */
export async function verifyConcurrencyArtifacts(request, authority, branch, evidence, deadline) {
  const remaining = (maximumMs) =>
    deadline === undefined ? maximumMs : checkpointTimeout(deadline, maximumMs);
  const originalRequest = request;
  request = (route, args) => originalRequest(route, args, remaining(15000));
  const final = (await request("GET /repos/{owner}/{repo}/commits/{ref}", { ref: branch })).data;
  assert.ok(
    evidence.some((entry) =>
      entry.events.some(
        (event) => event.event === "AttemptIntegrated" && event.headSha === final.sha,
      ),
    ),
    "default tip outside exact proved integrations",
  );
  const tree = (
    await request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      tree_sha: final.commit.tree.sha,
      recursive: "1",
    })
  ).data;
  assert.equal(tree.truncated, false);
  assert.ok(tree.tree.length <= 5000);
  const root = mkdtempSync(join(tmpdir(), "factory-concurrency-artifact-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}', { flag: "wx", mode: 0o600 });
    const files = [];
    for (const namespace of authority.namespaces) {
      const paths = qualificationPaths(namespace).files;
      if (authority.scenario === "director-contention")
        paths.push(`src/factory-qualification/${authority.namespace}/shared/${namespace}.js`);
      for (const path of paths) {
        const entry = one(
          tree.tree.filter((entry) => entry.path === path),
          "fixture blob missing or repeated",
        );
        assert.equal(entry.type, "blob");
        assert.equal(entry.mode, "100644");
        assert.ok(entry.size > 0 && entry.size <= 65536);
        const blob = (
          await request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { file_sha: entry.sha })
        ).data;
        assert.equal(blob.encoding, "base64");
        assert.equal(blob.sha, entry.sha);
        assert.ok(blob.content.length <= 100000);
        const bytes = Buffer.from(blob.content, "base64");
        assert.equal(bytes.length, entry.size);
        assert.equal(
          createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
          entry.sha,
        );
        mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
        writeFileSync(join(root, path), bytes, { flag: "wx", mode: 0o600 });
        files.push({ path, sha: entry.sha, size: bytes.length, sha256: hash(bytes) });
      }
    }
    const command = `import assert from 'node:assert/strict'; ${authority.namespaces
      .map((namespace, index) => {
        const dir = qualificationPaths(namespace).sourceDirectory;
        return `import {clamp as c${index}} from './${dir}/clamp.js'; import {slugify as s${index}} from './${dir}/slugify.js'; import {describe as d${index}} from './${dir}/describe.js'; assert.equal(c${index}(-2,0,10),0); assert.equal(c${index}(4,0,10),4); assert.equal(c${index}(12,0,10),10); assert.throws(()=>c${index}(1,2,0),RangeError); assert.equal(s${index}(' Hello, WORLD!! '),'hello-world'); assert.equal(s${index}('---'),''); assert.equal(d${index}(' Hello World ',12,0,10),'hello-world:10'); assert.throws(()=>d${index}('x',1,2,0),RangeError);`;
      })
      .join(" ")}`;
    // Trusted-local validation, not hostile-code containment. Permission mode additionally restricts
    // filesystem, children, workers and addons; it is not represented as a network sandbox.
    const args = ["--permission", `--allow-fs-read=${root}`];
    const options = {
      cwd: root,
      env: { PATH: dirname(process.execPath), HOME: root, LANG: "C.UTF-8" },
      encoding: "utf8",
      timeout: remaining(60000),
      maxBuffer: 262144,
      stdio: ["ignore", "pipe", "pipe"],
    };
    execFileSync(process.execPath, [...args, "--input-type=module", "-e", command], options);
    remaining(1);
    return { finalSha: final.sha, files, independentBehavior: "passed", workerReexecution: false };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
