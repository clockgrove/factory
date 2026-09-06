/** Separately opted installed pressure/cooldown/readmission scenario. Never auto-retries. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  main as installedMain,
  installedBundleIdentity,
  boundedPolicy,
  modelTokenLimit,
} from "./verify-live-objective.mjs";
import {
  assertRegularPipelineCompletion,
  observeRegularCommits,
} from "./verify-regular-objective.mjs";
import { parseUnitObservation } from "./verify-local-faults.mjs";
import { observeNativeMergeProofs } from "./qualification-sibling-refresh-proof.mjs";
import {
  schedulingAuthority,
  schedulingUnit,
  schedulingTransport,
  schedulingSnapshot,
  schedulingRequest,
  observeSchedulingService,
  changeSchedulingService,
  assertSchedulingBarrier,
  ownedSchedulingScopes,
} from "./verify-local-scheduling.mjs";
import {
  PRESSURE_BOUNDS,
  pressurePort,
  pressureSlice,
  pressureProperties,
  pressureMemory,
  pressureInputs,
  observePressureSlice,
  assertPressureHeadroom,
  pressureLaunch,
  observePressureResource,
  stopPressureResource,
  pressureSliceOverrides,
  observePressureDirector,
} from "./local-pressure-resource.mjs";

const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const instant = (value) => {
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result), "missing observation timestamp");
  return result;
};

function cooldownDeadline(reason, message) {
  // The planner emits toISOString(), optionally followed by this exact local-only
  // policy diagnostic. Neither arbitrary suffixes nor Date.parse normalization
  // of malformed calendar dates establish an observed cooldown boundary.
  const match =
    /^local-cooldown: local admission cooldown lasts until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?:; paid burst is disabled)?$/.exec(
      reason,
    );
  assert.ok(match && match[0] === reason, message);
  const milliseconds = instant(match[1]);
  assert.equal(new Date(milliseconds).toISOString(), match[1], "malformed cooldown deadline");
  return { at: match[1], milliseconds };
}

function pressurePolicy(limit) {
  const policy = boundedPolicy("regular-prs", limit);
  policy.capacity.local.admissionCooldownSeconds = 120;
  return policy;
}

/** Observation only: keep the accepted policy unchanged and allow two idle ticks after cooldown. */
export function pressureReadmissionDeadline(releasedAt, cooldownSeconds) {
  assert.equal(cooldownSeconds, 120, "unexpected accepted pressure cooldown");
  return instant(releasedAt) + cooldownSeconds * 1000 + 2 * 60000;
}

function assertPressurePipeline(evidence) {
  assertRegularPipelineCompletion(evidence, {
    expected: pressurePolicy(modelTokenLimit(String(evidence.policy.economics.maxModelTokens))),
    scope: "installed-local-explicit-regular-objective",
    deliveryMode: "regular-prs",
  });
}

export function pressureAuthority(env) {
  if (env.FACTORY_LIVE_LOCAL_PRESSURE !== "1") return null;
  assert.notEqual(env.FACTORY_LIVE_LOCAL_SCHEDULING, "1", "select exactly one scheduling scenario");
  const repository = env.FACTORY_LIVE_OBJECTIVE_REPOSITORY;
  if (env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT !== "1")
    assert.equal(
      env.FACTORY_LIVE_LOCAL_PRESSURE_ACK,
      `${repository}:owned-memory-pressure-cooldown-readmission`,
      "exact pressure acknowledgement required",
    );
  // Reuse the original common local authentication/policy boundaries after checking this scenario's ACK.
  const authority = schedulingAuthority({
    ...env,
    FACTORY_LIVE_LOCAL_SCHEDULING: "1",
    FACTORY_LIVE_LOCAL_SCHEDULING_ACK: `${repository}:owned-cpu-priority-contention`,
  });
  // Selected before the run is accepted. The installed idle loop is 60s, so its
  // original 10s cooldown cannot yield a real observed cooldown decision here.
  authority.policy = pressurePolicy(authority.policy.economics.maxModelTokens);
  return authority;
}

export function assertPressureRun({ receipts, status }, authority, objective, expectedRun) {
  const starts = receipts
    .map((receipt) => receipt.event)
    .filter((event) => event.event === "FactoryRunStarted");
  assert.equal(starts.length, 1, "one authenticated original run required");
  const start = starts[0];
  assert.equal(start.objective, objective);
  assert.deepEqual(start.policy, authority.policy, "accepted policy changed");
  if (expectedRun) assert.equal(start.runId, expectedRun);
  assert.equal(status.operation, "status");
  assert.equal(status.objective.number, objective);
  assert.equal(status.run.runId, start.runId);
  const events = receipts
    .map((receipt) => receipt.event)
    .filter((event) => event.runId === start.runId);
  for (const event of events.filter(
    (event) => event.kind === "scheduling" || event.event === "AttemptReserved",
  ))
    assert.equal(
      event.policyDigest,
      start.policyDigest,
      "decision belongs to another accepted policy",
    );
  assert.ok(
    !events.some((event) => ["FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event)),
    "original run no longer permits intervention",
  );
  return { runId: start.runId, policyDigest: start.policyDigest, events };
}

function queued(events, code) {
  return events.filter((event) => event.event === "WorkItemQueued" && event.reasonCode === code);
}

export function assertPressureReadmission(events, proof, policy) {
  for (const event of events) {
    assert.equal(event.runId, proof.runId, "pressure evidence belongs to another run");
    if (event.kind === "scheduling" || event.event === "AttemptReserved")
      assert.equal(event.policyDigest, proof.policyDigest, "pressure evidence policy changed");
  }
  const pressure = queued(events, "local-pressure").find(
    (event) =>
      event.sequence > proof.barrierSequence &&
      proof.roots.includes(event.workItem) &&
      event.reason.includes("memory pressure exceeds policy ceiling"),
  );
  assert.ok(pressure, "real memory local-pressure decision unavailable");
  const cooldown = queued(events, "local-cooldown").find(
    (event) => event.sequence > pressure.sequence && event.workItem === pressure.workItem,
  );
  assert.ok(cooldown, "real local-cooldown transition unavailable");
  const deadline = cooldownDeadline(
    cooldown.reason,
    "cooldown decision does not contain its actual deadline",
  );
  const cooldownUntil = deadline.milliseconds;
  assert.ok(cooldownUntil > instant(pressure.at), "cooldown does not follow pressure");
  for (const key of [
    "unit",
    "pid",
    "startTicks",
    "bootDigest",
    "invocationId",
    "node",
    "bundle",
    "checkout",
    "cgroup",
  ])
    assert.equal(
      proof.measuredPressure.resource[key],
      proof.resource[key],
      "measured pressure resource identity differs",
    );
  for (const key of ["unit", "cgroup", "inode", "bootDigest"])
    assert.equal(
      proof.measuredPressure.slice[key],
      proof.slice[key],
      "measured parent identity differs",
    );
  assert.equal(proof.measuredPressure.slice.memoryMax, PRESSURE_BOUNDS.sliceBytes);
  assert.equal(proof.measuredPressure.slice.swapMax, 0);
  assert.equal(proof.measuredPressure.slice.cpu, 4);
  assert.equal(proof.measuredPressure.resource.memory.memoryMax, PRESSURE_BOUNDS.pressureBytes);
  assert.equal(proof.measuredPressure.resource.memory.swapMax, 0);
  assert.equal(proof.measuredPressure.resource.memory.cpu, PRESSURE_BOUNDS.pressureCpu);
  assert.ok(
    proof.measuredPressure.slice.memoryCurrent / proof.measuredPressure.slice.memoryMax >
      policy.capacity.local.maxMemoryUsageRatio,
    "no independent measured memory pressure",
  );
  assert.ok(
    proof.measuredPressure.resource.memory.memoryCurrent >= PRESSURE_BOUNDS.allocationBytes,
    "owned allocator's actual charge was not observed",
  );
  assert.equal(proof.pressureAbsent.state, "absent");
  assert.equal(proof.pressureAbsent.unit, proof.resource.unit);
  assert.equal(proof.pressureAbsent.bootDigest, proof.resource.bootDigest);
  assert.equal(proof.released.effectiveCpu, 4);
  for (const key of [
    "unit",
    "pid",
    "startTicks",
    "bootDigest",
    "invocationId",
    "node",
    "bundle",
    "checkout",
  ])
    assert.equal(
      proof.released[key],
      proof.primary[key],
      "Director incarnation changed during release",
    );
  const admissions = events
    .filter((event) => event.event === "AttemptReserved")
    .sort((a, b) => a.sequence - b.sequence);
  assert.ok(admissions.length > 0, "same-run readmission not observed");
  for (const admission of admissions) {
    assert.equal(admission.attempt, 1, "queueing consumed an implementation attempt");
    assert.ok(admission.sequence > cooldown.sequence, "admission preceded cooldown decision");
    assert.ok(
      instant(admission.capacityMeasuredAt) >= cooldownUntil,
      "admission used a resource sample from before cooldown ended",
    );
    for (const decision of queued(events, "local-cooldown").filter(
      (event) => event.sequence < admission.sequence,
    )) {
      const boundary = cooldownDeadline(decision.reason, "later cooldown boundary unavailable");
      assert.ok(
        instant(admission.capacityMeasuredAt) >= boundary.milliseconds,
        "admission preceded a later observed cooldown deadline",
      );
    }
    assert.ok(
      instant(admission.capacityMeasuredAt) >= instant(proof.pressureAbsent.observedAt),
      "admission used a sample from before pressure resource absence",
    );
    assert.equal(admission.effectiveCpu, 4);
    assert.ok(admission.loadRatio <= policy.capacity.local.maxLoadRatio);
    assert.ok(admission.memoryUsageRatio <= policy.capacity.local.maxMemoryUsageRatio);
    assert.ok(
      admission.availableMemoryMb >=
        admission.requestedMemoryMb + policy.capacity.local.reserveMemoryMb,
    );
  }
  return { pressure, cooldown, cooldownUntil: deadline.at, firstAdmission: admissions[0] };
}

export function assertPressureCompletion(evidence) {
  assertPressurePipeline(evidence);
  const proof = evidence.pressure;
  assert.equal(proof.kind, "owned-memory-pressure-cooldown-readmission");
  assert.equal(proof.runId, evidence.runResult.runId);
  const events = evidence.events.filter((event) => event.runId === proof.runId);
  assertPressureReadmission(events, proof, evidence.policy);
  assert.equal(proof.cleanup.primary.state, "absent");
  assert.equal(proof.cleanup.primary.unit, proof.primary.unit);
  assert.equal(proof.cleanup.primary.bootDigest, proof.primary.bootDigest);
  assert.equal(proof.cleanup.slice.state, "absent");
  assert.equal(proof.cleanup.slice.unit, proof.slice.unit);
  assert.equal(proof.cleanup.slice.bootDigest, proof.slice.bootDigest);
  assert.equal(proof.cleanup.pressure.state, "absent");
  assert.equal(proof.cleanup.pressure.unit, proof.resource.unit);
  assert.equal(proof.cleanup.pressure.bootDigest, proof.resource.bootDigest);
  assert.deepEqual(
    proof.cleanup.workerScopes.map((item) => item.unit).sort(),
    ownedSchedulingScopes(evidence, proof.primary),
  );
  assert.ok(proof.cleanup.workerScopes.every((item) => item.status === "absent"));
}

export function createPressureQualification(authority, env = process.env, port = pressurePort) {
  let primary;
  let resource;
  let slice;
  let pluginRoot;
  let allocator;
  let allocatorDigest;
  const nonce = randomUUID();
  const artifacts = (evidence) => {
    assert.deepEqual(
      installedBundleIdentity(pluginRoot),
      evidence.installedArtifact,
      "installed artifact changed; stop injection",
    );
    assert.equal(hashFile(allocator), allocatorDigest, "pressure helper changed; stop injection");
  };
  const owned = () => {
    primary = observePressureDirector(primary, port);
    assert.equal(primary.state, "active");
    slice = observePressureSlice(slice, [primary.unit, resource.unit], port);
    assert.equal(dirname(primary.cgroup), slice.cgroup);
    return { primary, slice };
  };
  return {
    scope: "installed-local-explicit-regular-objective",
    policy: authority.policy,
    namespace: authority.namespace,
    privateEvidence: true,
    wrapTransport: async (parameters, context) => {
      pluginRoot = context.pluginRoot;
      assert.deepEqual(parameters.args, [join(pluginRoot, "dist/mcp-server.js")]);
      const user = userInfo();
      const base = {
        repository: authority.repository,
        namespace: authority.namespace,
        inventory: context.evidence.installedArtifact.inventorySha256,
        nonce,
      };
      primary = {
        unit: schedulingUnit({ ...base, role: "primary" }),
        node: realpathSync(process.execPath),
        bundle: realpathSync(parameters.args[0]),
        checkout: realpathSync(parameters.cwd),
      };
      allocator = realpathSync(
        join(dirname(fileURLToPath(import.meta.url)), "local-pressure-allocator.mjs"),
      );
      allocatorDigest = hashFile(allocator);
      resource = {
        ...primary,
        unit: schedulingUnit({ ...base, role: "contender" }),
        bundle: allocator,
      };
      slice = { unit: pressureSlice(primary.unit) };
      assert.equal(observeSchedulingService(primary, port).state, "absent");
      assert.equal(observeSchedulingService(resource, port).state, "absent");
      assert.equal(observePressureSlice(slice, [], port).state, "absent");
      context.evidence.pressure = {
        kind: "owned-memory-pressure-cooldown-readmission",
        nonce,
        primary,
        resource,
        slice,
        allocatorDigest,
        bounds: PRESSURE_BOUNDS,
      };
      context.save();
      const transport = schedulingTransport({
        ...primary,
        path: env.PATH,
        home: homedir(),
        uid: user.uid,
        username: user.username,
      });
      transport.args.splice(
        1,
        0,
        `--slice=${slice.unit}`,
        "--property=Restart=no",
        "--property=RuntimeMaxSec=3000s",
        "--property=TimeoutStopSec=2s",
        "--property=RuntimeRandomizedExtraSec=0",
        `--property=MemoryMax=${PRESSURE_BOUNDS.sliceBytes}`,
        "--property=MemorySwapMax=0",
      );
      return transport;
    },
    beforeRun: async (hooks) => {
      artifacts(hooks.evidence);
      primary = observePressureDirector(primary, port);
      assert.equal(primary.state, "active");
      assert.equal(primary.effectiveCpu, 0.5);
      slice = observePressureSlice(slice, [primary.unit], port, false);
      assert.equal(dirname(primary.cgroup), slice.cgroup);
      const proof = hooks.evidence.pressure;
      proof.primary = primary;
      proof.slice = slice;
      proof.preAllocationHeadroom = assertPressureHeadroom(slice, port);
      proof.sliceCapRequestedAt = port.now();
      hooks.save();
      // A fresh, exact owned slice only. No ancestor or host setting is modified.
      port.exec("systemctl", [
        "--user",
        "set-property",
        "--runtime",
        slice.unit,
        `MemoryMax=${PRESSURE_BOUNDS.sliceBytes}`,
        "MemorySwapMax=0",
        "CPUQuota=400%",
      ]);
      slice = observePressureSlice(slice, [primary.unit], port);
      proof.slice = slice;
      proof.sliceOverrides = pressureSliceOverrides(slice, userInfo().uid, port);
      hooks.save();
    },
    duringRun: async (hooks) => {
      let settled = false;
      void hooks.run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const running = () => {
        hooks.signal.throwIfAborted();
        assert.ok(!settled, "original foreground outcome no longer permits injection");
        artifacts(hooks.evidence);
      };
      const proof = hooks.evidence.pressure;
      let barrier;
      let observed;
      for (let index = 0; index < 48; index++) {
        running();
        observed = await schedulingSnapshot(hooks);
        owned();
        if (observed.receipts.some((receipt) => receipt.event.event === "GraphProjected")) {
          barrier = assertSchedulingBarrier(
            {
              ...observed,
              unit: primary,
              policy: authority.policy,
              objective: hooks.evidence.objective.number,
            },
            false,
          );
          if (barrier) break;
        }
        await port.wait(10000);
      }
      assert.ok(barrier, "original graph/zero-attempt barrier not observed");
      Object.assign(proof, {
        runId: barrier.runId,
        policyDigest: barrier.policyDigest,
        roots: barrier.roots,
        barrier: observed,
        barrierSequence: Math.max(...observed.receipts.map((receipt) => receipt.event.sequence)),
      });
      running();
      owned();
      proof.preInjectionHeadroom = assertPressureHeadroom(slice, port);
      assert.equal(observeSchedulingService(resource, port).state, "absent");
      proof.injectionRequestedAt = port.now();
      hooks.save();
      running();
      port.exec("systemd-run", pressureLaunch(resource, slice.unit)); // Exactly one allocation launch.
      resource = observePressureResource(resource, slice, port);
      assert.equal(resource.state, "active");
      proof.resource = resource;
      hooks.save();
      const injectionDeadline = instant(proof.injectionRequestedAt) + 90000;
      let pressureSeen = false;
      while (instant(port.now()) < injectionDeadline) {
        running();
        owned();
        resource = observePressureResource(resource, slice, port);
        assert.equal(resource.state, "active", "pressure resource ended before measured decision");
        assert.ok(
          slice.memoryMax - slice.memoryCurrent >= PRESSURE_BOUNDS.emergencyHeadroomBytes,
          "owned slice safety margin exhausted",
        );
        const measurement = {
          slice,
          resource,
          inputs: pressureInputs(primary, port),
          observedAt: port.now(),
        };
        proof.samples ??= [];
        assert.ok(proof.samples.length < 90);
        proof.samples.push(measurement);
        hooks.save();
        observed = await schedulingSnapshot(hooks);
        const run = assertPressureRun(
          observed,
          authority,
          hooks.evidence.objective.number,
          proof.runId,
        );
        assert.ok(
          !run.events.some((event) => ["AttemptReserved", "AttemptStarted"].includes(event.event)),
          "work was admitted while injecting pressure",
        );
        if (
          slice.memoryCurrent / slice.memoryMax >
            authority.policy.capacity.local.maxMemoryUsageRatio &&
          resource.memory.memoryCurrent >= PRESSURE_BOUNDS.allocationBytes &&
          queued(run.events, "local-pressure").some(
            (event) =>
              event.sequence > proof.barrierSequence &&
              event.reason.includes("memory pressure exceeds policy ceiling"),
          )
        ) {
          proof.measuredPressure = measurement;
          proof.pressureDecision = observed;
          pressureSeen = true;
          break;
        }
        await port.wait(1000);
      }
      assert.ok(pressureSeen, "bounded genuine local-pressure decision not observed");
      running();
      owned();
      proof.pressureAbsent = await stopPressureResource(resource, slice, port);
      hooks.save();
      running();
      owned();
      const memory = pressureMemory(primary.cgroup, port);
      assert.equal(memory.memoryMax, PRESSURE_BOUNDS.sliceBytes);
      assert.equal(memory.swapMax, 0);
      proof.releaseRequestedAt = port.now();
      hooks.save();
      proof.released = await changeSchedulingService(primary, "release-cpu", port);
      const readmissionDeadline = pressureReadmissionDeadline(
        proof.releaseRequestedAt,
        authority.policy.capacity.local.admissionCooldownSeconds,
      );
      proof.readmissionDeadline = new Date(readmissionDeadline).toISOString();
      hooks.save();
      for (let index = 0; index < 120 && instant(port.now()) < readmissionDeadline; index++) {
        running();
        owned();
        observed = await schedulingSnapshot(hooks);
        const run = assertPressureRun(
          observed,
          authority,
          hooks.evidence.objective.number,
          proof.runId,
        );
        proof.readmissionObservation = observed;
        hooks.save();
        if (run.events.some((event) => event.event === "AttemptReserved")) {
          proof.progression = assertPressureReadmission(run.events, proof, authority.policy);
          hooks.save();
          return;
        }
        await port.wait(2000);
      }
      throw Error("same original Objective did not safely readmit within the bounded observation");
    },
    observeMergeProofs: (hooks) =>
      observeNativeMergeProofs({
        ...hooks,
        request: (route, parameters) => schedulingRequest(hooks, route, parameters),
      }),
    afterRun: async (hooks) => {
      artifacts(hooks.evidence);
      await observeRegularCommits({
        ...hooks,
        request: (route, parameters) => schedulingRequest(hooks, route, parameters),
      });
      assertPressurePipeline(hooks.evidence);
      const proof = hooks.evidence.pressure;
      assertPressureReadmission(
        hooks.evidence.events.filter((event) => event.runId === proof.runId),
        proof,
        authority.policy,
      );
      const pressure = observePressureResource(resource, slice, port);
      assert.equal(pressure.state, "absent");
      proof.cleanup = {
        pressure,
        workerScopes: ownedSchedulingScopes(hooks.evidence, primary).map((unit) =>
          parseUnitObservation(
            unit,
            port.exec("systemctl", [
              "--user",
              "show",
              unit,
              "--property=Id,LoadState,ActiveState,SubState,Job,InvocationID,ControlGroup,KillMode",
            ]),
            port.now(),
          ),
        ),
      };
      assert.ok(proof.cleanup.workerScopes.every((item) => item.status === "absent"));
      owned();
      proof.cleanup.primary = await changeSchedulingService(primary, "stop", port);
      // The absence branch also independently checks the original PID birth and cgroup path.
      proof.cleanup.primary = observePressureResource(primary, slice, port);
      assert.equal(proof.cleanup.primary.state, "absent");
      // Do not stop a slice containing any new resource, even with our generated name.
      slice = observePressureSlice(slice, [], port);
      assert.deepEqual(slice.children, []);
      port.exec("systemctl", ["--user", "stop", slice.unit]);
      const stopped = pressureProperties(slice.unit, ["Id", "ActiveState", "ControlGroup"], port);
      assert.equal(stopped.Id, slice.unit);
      assert.equal(stopped.ActiveState, "inactive");
      assert.equal(stopped.ControlGroup, "");
      assert.equal(port.inode(`/sys/fs/cgroup${slice.cgroup}`), null);
      // Revert only this never-preexisting slice's runtime resource properties.
      assert.deepEqual(
        pressureSliceOverrides(slice, userInfo().uid, port),
        proof.sliceOverrides,
        "owned runtime override identity changed; do not remove it",
      );
      port.exec("systemctl", ["--user", "revert", slice.unit]);
      for (const item of proof.sliceOverrides) assert.equal(port.inode(item.path), null);
      proof.cleanup.slice = observePressureSlice(slice, [], port);
      assert.equal(proof.cleanup.slice.state, "absent");
      hooks.save();
      assertPressureCompletion(hooks.evidence);
    },
    onFailure: async (hooks) => {
      const proof = (hooks.evidence.pressure ??= {});
      proof.failure = {
        code: "pressure-boundary-unverified",
        automaticRetry: false,
        originalCallOutcome: "inspect-authenticated-history",
        automaticCpuRelease: false,
      };
      // An uncertain launch is never retried. Reobserve its exact generated name and command
      // solely to stop the bounded helper; a replacement/unknown identity fails closed.
      if (resource && slice?.cgroup) {
        resource = observePressureResource(resource, slice, port);
        proof.failure.pressure =
          resource.state === "absent"
            ? resource
            : await stopPressureResource(resource, slice, port);
      }
    },
    assessCompletion: (evidence) => {
      try {
        assertPressureCompletion(evidence);
        return { result: "passed", scope: "installed-local-pressure-cooldown-readmission" };
      } catch {
        return {
          result: "incomplete",
          scope: "installed-local-pressure-cooldown-readmission",
          reason:
            "Real pressure, cooldown, readmission, delivery and exact cleanup are all required",
        };
      }
    },
  };
}

export async function main(env = process.env, run = installedMain) {
  const authority = pressureAuthority(env);
  if (!authority) {
    console.log("Not exercised: separate explicit local pressure opt-in required.");
    return;
  }
  await run(createPressureQualification(authority, env));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      "Local pressure qualification incomplete; preserve private evidence. No automatic reinjection.",
    );
    process.exitCode = 2;
  }
}
