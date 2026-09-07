/** Opt-in installed, two-Objective qualification. This never invokes a source Supervisor. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  checkpointAuthority,
  checkpointLease,
  main as checkpointMain,
  assertScopeCoverage,
  assertControllerUnit,
} from "./verify-local-checkpoint-restart.mjs";
import { assertRepositoryContention } from "./verify-local-scheduling.mjs";
import { authenticatedFaultEvents, isQuiescentFaultObjective } from "./verify-local-faults.mjs";
import { qualificationModelAccounting } from "./qualification-model-accounting.mjs";
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
  observeNativeMergeProofs,
  assertNativeMergeProof,
} from "./qualification-sibling-refresh-proof.mjs";
import { selectQualificationPublicationRecord } from "./qualification-merge-proof.mjs";
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

export function concurrencyAuthority(env) {
  if (env.FACTORY_LOCAL_CONCURRENCY !== "1") return null;
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
    "this scenario uses the existing SDK/CLI local chain",
  );
  const phase = env.FACTORY_CONCURRENCY_PHASE;
  const namespace = qualificationNamespace(env.FACTORY_CONCURRENCY_NAMESPACE);
  const namespaces = [
    qualificationNamespace(`${namespace}-a`),
    qualificationNamespace(`${namespace}-b`),
  ];
  const repository = env.FACTORY_CONCURRENCY_REPOSITORY;
  const unit = env.FACTORY_CONCURRENCY_CONTROLLER_UNIT;
  if (phase === "exercise")
    assert.equal(
      env.FACTORY_CONCURRENCY_ACK,
      `${repository}:${unit}:start,activate-two,contend,pause-b,freeze-inner-contend-unfreeze,stop-stale,restart,resume-b,stop`,
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
  authority.policy.maxParallel = 1;
  authority.policy.capacity.local.maxWorkers = 1;
  return {
    ...authority,
    namespaces,
    aggregateObservedThreshold,
    controllerLocalCeiling: 8,
    authorizedScenarioWorkerMaximum: 2,
  };
}

export function concurrencyObjectiveBody(namespace, index) {
  return `${objectiveBodyFor(namespace)}\n\nThis is one of exactly two explicitly activated, disjoint qualification Objectives. Keep exactly three Work Items and two independent roots, then the dependent join. Do not edit the other namespace. ${
    index === 0
      ? "Make clamp the first root in native sub-issue order. Its implementation must also handle infinities and negative zero consistently with Math.min(Math.max(value,min),max). Add at least 24 individually named edge-case assertions covering negative/fractional inputs, both infinities, negative zero, equal bounds and inverted bounds. Do not introduce artificial delays, sleeps, services, network calls or resource pressure."
      : "Keep both roots minimal: only the specified deterministic implementation and acceptance cases. Make clamp first and slugify second in native sub-issue order."
  }\nKeep all six new files ordinary non-executable Git mode 100644. Do not combine the roots or add Work Items. This requests useful asymmetric work, not a guarantee about model speed. The observer records an incomplete result if actual overlap/refill does not occur.`;
}

/** Observed execution lifetimes only. Receipt clocks never imply simultaneous CPU use. */
export function concurrencyRefill(pair) {
  assert.equal(pair.length, 2);
  const runs = pair.map(eventsOf);
  const intervals = runs.map((events) =>
    events
      .filter((event) => event.event === "AttemptStarted")
      .map((start) => {
        const ends = events.filter(
          (event) => endNames.has(event.event) && sameAttempt(start, event),
        );
        assert.ok(ends.length <= 1, "conflicting worker terminals");
        const end = ends[0];
        if (end) assert.ok(end.sequence > start.sequence && time(end) >= time(start));
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
  for (const slow of intervals[0])
    for (const first of intervals[1])
      for (const refill of intervals[1]) {
        if (!first.end || first === refill || first.end.sequence >= refill.start.sequence) continue;
        if (
          time(slow.start) < time(first.end) &&
          time(first.start) < time(first.end) &&
          time(first.end) < time(refill.start) &&
          (!slow.end || time(refill.start) < time(slow.end))
        ) {
          return {
            slow: slow.start,
            first: first.start,
            released: first.end,
            refill: refill.start,
            boundary: "authenticated-worker-lifetimes",
            simultaneousCpu: "not-measured",
          };
        }
      }
  return null;
}

export function assertConcurrencySettlement(observation, authority, { paused = false } = {}) {
  const events = eventsOf(observation),
    start = one(
      events.filter((event) => event.event === "FactoryRunStarted"),
      "one exact run required",
    );
  const activation = one(
    events.filter((event) => event.event === "ActivationRequested"),
    "one exact activation required",
  );
  assert.equal(activation.requestId, `${authority.namespace}-activate`);
  assert.equal(start.activationRequestId, activation.requestId);
  for (const event of [activation, start]) {
    assert.equal(event.repository, authority.repository);
    assert.deepEqual(event.policy, authority.policy);
    assert.equal(event.policyDigest, start.policyDigest);
    assert.equal(event.objective, observation.status.objective.number);
  }
  assert.equal(activation.requestedBy.toLowerCase(), start.actor.toLowerCase());
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

export async function runConcurrencyScenario(port, authority) {
  const preflight = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", preflight };
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
    return await run(env, runConcurrencyScenario, {
      authority,
      scope: "installed-two-objective-concurrency",
      harnessPaths: [
        "scripts/verify-local-concurrency.mjs",
        "scripts/qualification-controller-freeze.mjs",
        "scripts/qualification-model-accounting.mjs",
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
        retireClient,
      }) => {
        assert.equal(typeof retireClient, "function", "owned MCP retirement boundary unavailable");
        const [owner, repo] = authority.repository.split("/");
        const once = async (action, invoke) => {
          abort.signal.throwIfAborted();
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
        const observeOne = async (record, full = false) => {
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
          const receipts = authenticatedFaultEvents(comments, evidence.actor, objective.number);
          const observation = {
            receipts,
            status: await call("factory_status", { objectiveNumber: objective.number }),
            children,
          };
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
        const settled = (observation, paused, index = paused ? 1 : 0) => {
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
          assertConcurrencySettlement(observation, policyFor(authority, index), { paused });
          return true;
        };
        return {
          ...port,
          settled,
          action: async (action) => {
            await exclusiveAuthority();
            return port.action(action);
          },
          prepare: async (stage) => {
            assert.ok(["create", "activate"].includes(stage));
            if (stage === "create") {
              evidence.objectives = [];
              for (const [index, namespace] of authority.namespaces.entries()) {
                const body = concurrencyObjectiveBody(namespace, index);
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
            for (const [index, record] of evidence.objectives.entries()) {
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
              await wait(15000);
            }
            evidence.stagger.elapsedMs = Math.floor(performance.now() - began);
            save();
          },
          contend: async (pair) => {
            await once("outer-contention", async () => {
              const before = await readOuter();
              const response = await invoke("factory_run", {
                objectiveNumber: evidence.objectives[0].objective.number,
                repository: authority.checkout,
                untilTerminal: true,
                policy: authority.policy,
              });
              const after = await readOuter(),
                controller = eventsOf(pair[0]).find(
                  (event) => event.event === "ControllerObserved",
                );
              assertRepositoryContention({ response, before, after, controller });
              return {
                boundary: "repository-controller-outer-lease",
                response,
                before,
                after,
                innerDirector: "not-reached",
              };
            });
          },
          scoped: async (action) =>
            once(`${action}-b`, () =>
              call(`factory_${action}`, {
                objectiveNumber: evidence.objectives[1].objective.number,
                requestId: `${authority.namespaces[1]}-${action}`,
              }),
            ),
          pollPair: async (phase, accept) => {
            for (let count = 0; count < 270; count++) {
              abort.signal.throwIfAborted();
              const pair = [];
              for (const [index, record] of evidence.objectives.entries()) {
                // Cached terminal evidence is progress only, never a mutation/resource authorization.
                const observed = record.terminalObservation ?? (await observeOne(record));
                if (!record.terminalObservation && settled(observed, false, index))
                  record.terminalObservation = observed;
                pair.push(observed);
              }
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
              if (accept(pair)) return pair;
              assert.ok(
                Date.now() < Date.parse(evidence.startedAt) + 2700000,
                "bounded scenario observation expired",
              );
              assert.ok(
                !(
                  phase === "refill" &&
                  pair.every((observation) => observation.status.run.state === "completed")
                ),
                "actual refill timing not observed",
              );
              await wait(15000);
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
              remainingMs: Date.parse(evidence.startedAt) + 2700000 - Date.now(),
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
                  await wait(15000);
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
              await wait(15000);
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
              assert.ok(
                Date.parse(evidence.startedAt) + 2700000 - Date.now() > 300000,
                "original completion deadline exhausted",
              );
              await wait(15000);
            }
            throw Error("original inner lease expiry not observed within bound");
          },
          finish: async (_pair, original, replacement, refill) => {
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
              entry.mergeProofs = await observeNativeMergeProofs({ evidence: entry, request });
              for (const proof of entry.mergeProofs) {
                const integration = one(
                  entry.events.filter(
                    (event) =>
                      event.event === "AttemptIntegrated" && event.workItem === proof.workItem,
                  ),
                  "integration missing",
                );
                const publication = selectQualificationPublicationRecord(
                  entry.events.filter(
                    (event) =>
                      event.event === "PublicationRecorded" && sameAttempt(event, integration),
                  ),
                );
                assertNativeMergeProof(entry, proof, {
                  repository: authority.repository,
                  pull: one(
                    entry.pulls.filter((pull) => pull.number === proof.pullRequest),
                    "pull missing",
                  ),
                  publication,
                  integration,
                });
              }
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
            );
            evidence.concurrencyProof = {
              refill: concurrencyRefill(final),
              inner,
              absence,
              artifactProof,
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
export async function verifyConcurrencyArtifacts(request, authority, branch, evidence) {
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
    for (const namespace of authority.namespaces)
      for (const path of qualificationPaths(namespace).files) {
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
      timeout: 60000,
      maxBuffer: 262144,
      stdio: ["ignore", "pipe", "pipe"],
    };
    execFileSync(process.execPath, [...args, "--input-type=module", "-e", command], options);
    return { finalSha: final.sha, files, independentBehavior: "passed", workerReexecution: false };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
