/** Installed evaluated-compiler restart and pre-scheduling pause qualification. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkpointAuthority, main as checkpointMain } from "./verify-local-checkpoint-restart.mjs";
import { qualificationNamespaceMarker } from "./verify-live-objective.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const unique = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const schedulingAdmission = new Set(["AttemptReserved", "CapacityReserved"]);
const documentedCompilerEvaluationDefaults = Object.freeze({
  mode: "auto-repair",
  maxRepairs: 2,
  maxInvocations: 7,
  timeoutSeconds: 600,
});

export function assertCompilerQualificationDefaults(effectiveDefaults, maxObservedTokens) {
  assert.ok(
    Number.isSafeInteger(maxObservedTokens) && maxObservedTokens >= 0,
    "authorized compiler observed-token ceiling required",
  );
  assert.deepEqual(
    effectiveDefaults?.compilerEvaluation,
    { ...documentedCompilerEvaluationDefaults, maxObservedTokens },
    "installed compiler defaults differ from the documented authorized envelope",
  );
  return effectiveDefaults;
}

/** A retained human-authored greenfield shape: one pnpm authority provider and
 * three bounded, otherwise independent descendants. */
export function compilerQualificationObjectiveBody(authority) {
  const namespace = authority.namespace;
  return `Build a small greenfield pnpm ESM package that provides three independent, dependency-free runtime safety helpers.

Qualification namespace: ${namespace}
${qualificationNamespaceMarker(namespace)}

Compile exactly four Work Items. The first is the only bootstrap provider. It owns package.json and pnpm-lock.yaml, declares packageManager for the Factory-provisioned pnpm runtime, and defines exactly these finite validation scripts: check:bootstrap, test:deadline, test:bounded-queue, and test:safe-task-id. Its only validation command is pnpm run check:bootstrap. It must not add application source or application tests.

The other three Work Items all depend directly on the bootstrap provider and do not depend on each other. They must not modify package.json or pnpm-lock.yaml:

1. Add src/deadline.js and test/deadline.test.js. Export runWithDeadline(task, milliseconds). It passes an AbortSignal to task, aborts once when the deadline expires, clears its timer on every terminal path, and never lets a late task settlement replace the first terminal result. Validate only with pnpm run test:deadline.
2. Add src/bounded-queue.js and test/bounded-queue.test.js. Export drainBounded(tasks, limit). It rejects non-positive or non-integer limits, preserves result order, starts at most limit tasks concurrently, and stops admitting new tasks after the first rejection. Validate only with pnpm run test:bounded-queue.
3. Add src/safe-task-id.js and test/safe-task-id.test.js. Export safeTaskId(value). It accepts only 1-64 lowercase ASCII letters, digits, and single hyphens, and rejects traversal, separators, whitespace, uppercase, empty segments, leading or trailing hyphens, and longer input. Validate only with pnpm run test:safe-task-id.

Use node:test and Node built-ins only. The bootstrap must create a frozen pnpm lockfile with no dependencies. Tests must be finite, deterministic, and must include the deadline helper's abort, timer-cleanup, and late-settlement safety criteria. Do not add services, credentials, workflows, cloud workers, media, or network-dependent application behavior.`;
}

export function compilerCheckpointPath(binding, uid = process.geteuid()) {
  return join(
    tmpdir(),
    `factory-compiler-qualification-checkpoints-${uid}`,
    `${hash(
      `${binding.repository}\0${binding.objective}\0${binding.runId}\0${binding.checkpoint}`,
    )}.json`,
  );
}

export function compilerCheckpointArm(
  authority,
  controller,
  artifact,
  objective,
  baseSha,
  checkpoint,
) {
  assert.equal(authority.compilerRecovery, true);
  assert.ok(["compiler-selection", "graph-projection"].includes(checkpoint));
  const bundle = unique(
    artifact.bundles.filter(({ file }) => file === "factory.js"),
    "exact installed Factory bundle required",
  );
  return {
    protocol: "clockgrove.factory/compiler-qualification-checkpoint-arm",
    bundleIdentity: `sha256:${bundle.sha256}`,
    effectiveUid: process.geteuid(),
    controllerUnit: controller.unit,
    repository: authority.repository,
    objective,
    activationRequestId: `${authority.namespace}-activate`,
    runId: `${authority.namespace}-activate`,
    policyDigest: hash(canonical(authority.policy)),
    baseSha,
    checkpoint,
    eligibilityDurationMs: authority.policy.objectiveTimeoutMinutes * 60_000,
    holdDurationMs: authority.policy.workItemTimeoutMinutes * 60_000,
  };
}

function assertWitnessBinding(witness, arm, controller) {
  assert.equal(witness.protocol, "clockgrove.factory/compiler-qualification-checkpoint-reached");
  for (const key of [
    "bundleIdentity",
    "effectiveUid",
    "controllerUnit",
    "repository",
    "objective",
    "activationRequestId",
    "runId",
    "policyDigest",
    "baseSha",
    "checkpoint",
  ])
    assert.equal(witness[key], arm[key], `checkpoint ${key} differs`);
  assert.equal(witness.armDigest, hash(JSON.stringify(arm)));
  assert.equal(witness.controllerInvocationId, controller.invocationId);
  assert.equal(witness.hostIdentity, controller.hostIdentity);
  assert.equal(witness.producerPid, controller.pid);
  assert.equal(witness.producerStartTicks, controller.startTicks);
  assert.ok(Number.isFinite(Date.parse(witness.startedAt)));
  assert.equal(
    Date.parse(witness.eligibleUntil) - Date.parse(witness.startedAt),
    arm.eligibilityDurationMs,
  );
  assert.ok(Date.parse(witness.reachedAt) >= Date.parse(witness.startedAt));
  assert.ok(Date.parse(witness.reachedAt) < Date.parse(witness.eligibleUntil));
  assert.ok(Date.parse(witness.holdUntil) > Date.parse(witness.reachedAt));
  assert.ok(Date.now() < Date.parse(witness.holdUntil), "checkpoint hold already expired");
  assert.ok(Date.parse(witness.holdUntil) <= Date.parse(witness.reachedAt) + arm.holdDurationMs);
}

export function assertCompilerSelectionHold(observation, authority, armRecord, controller) {
  const witness = observation.compilerCheckpoints?.["compiler-selection"];
  if (!witness) return false;
  assertWitnessBinding(witness, armRecord.arm, controller);
  const events = observation.receipts.map(({ event }) => event);
  const start = unique(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "one exact run start required",
  );
  assert.equal(start.runId, witness.runId);
  assert.equal(start.activationRequestId, witness.activationRequestId);
  assert.equal(start.policyDigest, witness.policyDigest);
  assert.equal(start.baseSha, witness.baseSha);
  assert.equal(start.at, witness.startedAt);
  assert.deepEqual(start.policy, authority.policy);
  assert.equal(witness.proof.checkpoint, "compiler-selection");
  assert.equal(witness.proof.graphAbsent, true);
  assert.match(witness.proof.journalDigest, /^[a-f0-9]{64}$/);
  assert.ok(witness.proof.usage.length >= 3 && witness.proof.usage.length <= 7);
  for (const item of witness.proof.usage) {
    const reserved = unique(
      events.filter(
        (event) =>
          event.event === "BudgetReserved" &&
          event.modelInvocationId === item.invocationId &&
          event.sequence === item.reservationSequence,
      ),
      "compiler invocation reservation missing or repeated",
    );
    const reconciled = unique(
      events.filter(
        (event) =>
          event.event === "BudgetReconciled" &&
          event.modelInvocationId === item.invocationId &&
          event.sequence === item.reconciliationSequence,
      ),
      "compiler invocation accounting missing or repeated",
    );
    assert.equal(reconciled.usageId, `draft-${item.invocationId}`);
    assert.equal(reconciled.amount, item.amount);
    assert.equal(reserved.policyDigest, witness.policyDigest);
    assert.equal(reconciled.policyDigest, witness.policyDigest);
  }
  assert.ok(
    !events.some(
      (event) =>
        ["GraphCompiled", "GraphProjected"].includes(event.event) ||
        schedulingAdmission.has(event.event),
    ),
    "selection checkpoint crossed graph or scheduling persistence",
  );
  assert.equal(observation.children.length, 0);
  assert.equal(observation.status.compilerEvaluation?.availability, "observed");
  assert.equal(observation.status.compilerEvaluation.cumulativeUsage.complete, true);
  assert.deepEqual(
    observation.status.compilerEvaluation.invocations.map((invocation) => ({
      invocationId: invocation.invocationId,
      stage: invocation.stage,
      revision: invocation.revision,
      state: invocation.state,
      observedTokens: invocation.observedTokens,
    })),
    witness.proof.usage.map((item) => ({
      invocationId: item.invocationId,
      stage: item.stage,
      revision: item.revision,
      state: "completed",
      observedTokens: item.amount,
    })),
    "compiler status differs from the accepted fully-accounted selection",
  );
  return true;
}

export function assertGraphProjectionHold(observation, authority, armRecord, controller) {
  const witness = observation.compilerCheckpoints?.["graph-projection"];
  if (!witness) return false;
  assertWitnessBinding(witness, armRecord.arm, controller);
  const events = observation.receipts.map(({ event }) => event);
  const start = unique(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "one exact run start required",
  );
  assert.equal(start.runId, witness.runId);
  assert.equal(start.activationRequestId, witness.activationRequestId);
  assert.equal(start.policyDigest, witness.policyDigest);
  assert.equal(start.baseSha, witness.baseSha);
  assert.equal(start.at, witness.startedAt);
  assert.deepEqual(start.policy, authority.policy);
  const compiled = unique(
    events.filter((event) => event.event === "GraphCompiled"),
    "one exact compiled graph receipt required",
  );
  const projected = unique(
    events.filter((event) => event.event === "GraphProjected"),
    "one exact projected graph receipt required",
  );
  assert.equal(witness.proof.checkpoint, "graph-projection");
  assert.equal(witness.proof.graphDigest, compiled.graphDigest);
  assert.equal(witness.proof.graphDigest, projected.graphDigest);
  assert.equal(witness.proof.graphRef, compiled.graphRef);
  assert.equal(witness.proof.graphBlobSha, compiled.graphBlobSha);
  assert.equal(witness.proof.projectionRef, projected.projectionRef);
  assert.equal(witness.proof.projectionBlobSha, projected.projectionBlobSha);
  assert.equal(witness.proof.graphSize, 4, "compiler qualification graph must contain four items");
  assert.equal(observation.children.length, 4, "compiler projection must contain four Work Items");
  assert.equal(witness.proof.graphSize, observation.children.length);
  assert.deepEqual(
    witness.proof.workItemNumbers.slice().sort((a, b) => a - b),
    observation.children.map(({ number }) => number).sort((a, b) => a - b),
  );
  assert.equal(witness.proof.attemptReservations, 0);
  assert.equal(witness.proof.capacityReservations, 0);
  assert.ok(!events.some((event) => schedulingAdmission.has(event.event)));
  return true;
}

function stableCompilerAccounting(observation) {
  return observation.receipts
    .map(({ event }) => event)
    .filter((event) => event.kind === "budget" && event.phase === "management");
}

function stableCompilerInvocations(observation) {
  assert.equal(observation.status.compilerEvaluation?.availability, "observed");
  return observation.status.compilerEvaluation.invocations;
}

function stableGraphEvidence(observation) {
  return observation.receipts.map(({ event }) => event).filter((event) => event.kind === "graph");
}

export async function runCompilerCheckpointScenario(port, authority) {
  const before = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", before };
  await port.action("start");
  const original = await port.controller("active");
  await port.action("create");
  const arms = await port.armCompilerCheckpoints(original);
  await port.action("activate");
  await port.assertDefaultPolicyActivation();
  const selection = await port.poll("compiler-selection-hold", (observation) =>
    assertCompilerSelectionHold(observation, authority, arms["compiler-selection"], original),
  );
  const selectionAccounting = stableCompilerAccounting(selection);
  const selectionInvocations = stableCompilerInvocations(selection);

  await port.restart("selection");
  const projectionController = await port.controller("active");
  assert.notEqual(projectionController.invocationId, original.invocationId);
  assert.equal(projectionController.hostIdentity, original.hostIdentity);
  const projected = await port.poll("graph-projection-hold", (observation) =>
    assertGraphProjectionHold(
      observation,
      authority,
      arms["graph-projection"],
      projectionController,
    ),
  );
  assert.deepEqual(
    stableCompilerAccounting(projected),
    selectionAccounting,
    "compiler accounting changed after restart",
  );
  assert.deepEqual(
    stableCompilerInvocations(projected),
    selectionInvocations,
    "compiler invocation inventory changed after restart",
  );
  const projectedGraph = stableGraphEvidence(projected);
  await port.action("pause");
  const pausedAtProjection = await port.poll("graph-projection-pause", (observation) => {
    if (
      !assertGraphProjectionHold(
        observation,
        authority,
        arms["graph-projection"],
        projectionController,
      )
    )
      return false;
    const pause = observation.receipts
      .map(({ event }) => event)
      .filter(
        (event) => event.event === "RunPauseRequested" && event.requestId === port.pauseRequestId,
      );
    return pause.length === 1;
  });
  await port.restart("projection");
  const pausedController = await port.controller("active");
  assert.notEqual(pausedController.invocationId, projectionController.invocationId);
  const paused = await port.poll("projected-paused-restart", (observation) => {
    const events = observation.receipts.map(({ event }) => event);
    return (
      observation.status.run.state === "paused" &&
      events.filter(
        (event) =>
          event.event === "RunPauseAcknowledged" && event.commandRequestId === port.pauseRequestId,
      ).length === 1 &&
      !events.some((event) => schedulingAdmission.has(event.event))
    );
  });
  assert.deepEqual(stableCompilerAccounting(pausedAtProjection), selectionAccounting);
  assert.deepEqual(stableCompilerInvocations(pausedAtProjection), selectionInvocations);
  assert.deepEqual(stableGraphEvidence(pausedAtProjection), projectedGraph);
  assert.deepEqual(stableCompilerAccounting(paused), selectionAccounting);
  assert.deepEqual(stableCompilerInvocations(paused), selectionInvocations);
  assert.deepEqual(stableGraphEvidence(paused), projectedGraph);
  assert.deepEqual(paused.children, pausedAtProjection.children);
  await port.action("stop");
  const stopped = await port.controller("inactive");
  return {
    result: "passed",
    scope: "installed-compiler-qualification-checkpoints",
    runId: paused.status.run.runId,
    original,
    projectionController,
    pausedController,
    stopped,
    selectionWitness: selection.compilerCheckpoints["compiler-selection"],
    projectionWitness: projected.compilerCheckpoints["graph-projection"],
  };
}

export function compilerCheckpointExtension(authority) {
  return {
    authority,
    scope: "installed-compiler-qualification-checkpoints",
    omitActivationPolicy: true,
    maxObservedChildren: 4,
    objectiveBody: compilerQualificationObjectiveBody,
    harnessPaths: ["scripts/verify-compiler-qualification-checkpoints.mjs"],
    observe: ({ observation, evidence }) => {
      if (!evidence.compilerArms) return;
      observation.compilerCheckpoints = {};
      for (const [checkpoint, record] of Object.entries(evidence.compilerArms)) {
        try {
          observation.compilerCheckpoints[checkpoint] = JSON.parse(
            readFileSync(`${record.path}.reached`, "utf8"),
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    },
    extendPort: async ({ port, evidence, save, call, artifact }) => ({
      ...port,
      armCompilerCheckpoints: async (controller) => {
        assert.ok(!evidence.compilerArms, "compiler checkpoints cannot be rearmed");
        assert.equal(authority.policy, undefined, "default policy was already selected");
        const doctor = await call("factory_doctor", {
          objectiveNumber: evidence.objective.number,
          repository: authority.checkout,
        });
        assert.equal(doctor.operation, "doctor");
        assert.equal(doctor.repository.toLowerCase(), authority.repository.toLowerCase());
        assert.equal(doctor.objective, evidence.objective.number);
        assert.equal(doctor.activationAuthorized, false);
        authority.policy = structuredClone(
          assertCompilerQualificationDefaults(
            doctor.effectiveDefaults,
            authority.compilerMaxModelTokens,
          ),
        );
        evidence.defaultPolicyObservation = {
          operation: doctor.operation,
          repository: doctor.repository,
          objective: doctor.objective,
          activationAuthorized: doctor.activationAuthorized,
          policyDigest: hash(canonical(authority.policy)),
          observedAt: new Date().toISOString(),
        };
        save();
        const records = {};
        const firstPath = compilerCheckpointPath({
          repository: authority.repository,
          objective: evidence.objective.number,
          runId: `${authority.namespace}-activate`,
          checkpoint: "compiler-selection",
        });
        try {
          mkdirSync(dirname(firstPath), { mode: 0o700 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        for (const checkpoint of ["compiler-selection", "graph-projection"]) {
          const arm = compilerCheckpointArm(
            authority,
            controller,
            artifact,
            evidence.objective.number,
            evidence.base,
            checkpoint,
          );
          const path = compilerCheckpointPath(arm);
          const directory = statSync(dirname(path));
          assert.equal(directory.uid, process.geteuid());
          assert.equal(directory.mode & 0o777, 0o700);
          const bytes = JSON.stringify(arm);
          records[checkpoint] = {
            path,
            arm,
            digest: hash(bytes),
            requestedAt: new Date().toISOString(),
          };
          evidence.compilerArms = records;
          save();
          const file = openSync(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            writeSync(file, bytes);
            fsyncSync(file);
          } finally {
            closeSync(file);
          }
          records[checkpoint].writtenAt = new Date().toISOString();
          save();
        }
        const directory = openSync(dirname(firstPath), constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
        return records;
      },
      assertDefaultPolicyActivation: async () => {
        assert.ok(authority.policy?.compilerEvaluation, "installed compiler default required");
        assert.deepEqual(evidence.runRequest?.arguments, {
          owner: authority.repository.split("/")[0],
          repo: authority.repository.split("/")[1],
          objectiveNumber: evidence.objective.number,
          requestId: `${authority.namespace}-activate`,
          baseSha: evidence.base,
        });
        assert.equal(
          evidence.defaultPolicyObservation?.policyDigest,
          hash(canonical(authority.policy)),
        );
      },
      restart: async (boundary) => {
        assert.ok(["selection", "projection"].includes(boundary));
        const action = `restart-${boundary}`;
        assert.ok(!evidence.actions.some((entry) => entry.action === action));
        const record = { action, requestedAt: new Date().toISOString() };
        evidence.actions.push(record);
        save();
        record.response = await call("factory_controller_restart", {
          repository: authority.checkout,
          requestId: `${authority.namespace}-${action}`,
        });
        record.returnedAt = new Date().toISOString();
        save();
        return record.response;
      },
    }),
  };
}

export async function main(env = process.env) {
  const authority = checkpointAuthority(env);
  if (authority) assert.equal(authority.compilerRecovery, true);
  return checkpointMain(env, runCompilerCheckpointScenario, compilerCheckpointExtension(authority));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.exitCode = 2;
    console.error(
      "Compiler checkpoint prerequisites unavailable; no execution qualification claimed.",
    );
  }
}
