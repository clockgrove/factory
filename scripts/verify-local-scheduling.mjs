/** Opt-in installed Director capacity/priority/outer-lease qualification. No import-time I/O. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  main as installedMain,
  boundedPolicy,
  modelTokenLimit,
  qualificationNamespace,
} from "./verify-live-objective.mjs";
import { assertRegularCompletion, observeRegularCommits } from "./verify-regular-objective.mjs";
import {
  authenticatedFaultEvents,
  parseUnitObservation,
  scopeUnit,
} from "./verify-local-faults.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const unitPattern = /^clockgrove-factory-qualification-[a-f0-9]{64}\.service$/;
const readProperties =
  "Id,LoadState,ActiveState,SubState,Job,InvocationID,ControlGroup,MainPID,KillMode";
const defaults = {
  exec: (command, args) => {
    try {
      return execFileSync(command, args, {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (error) {
      // systemctl show returns status 1 for an unknown exact unit. Its structured
      // stdout still has to pass the strict not-found observation below.
      if (
        command === "systemctl" &&
        args[1] === "show" &&
        error.status === 1 &&
        typeof error.stdout === "string" &&
        error.stdout.length < 65536
      )
        return error.stdout.trim();
      throw Error("owned service operation unavailable");
    }
  },
  read: (path) => readFileSync(path, "utf8"),
  link: (path) => readlinkSync(path),
  now: () => new Date().toISOString(),
  wait: (milliseconds) => sleep(milliseconds),
};

export function schedulingAuthority(env) {
  if (env.FACTORY_LIVE_LOCAL_SCHEDULING !== "1") return null;
  assert.ok(
    env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT === "1" || env.FACTORY_LIVE_OBJECTIVE === "1",
    "shared explicit phase required",
  );
  const repository = env.FACTORY_LIVE_OBJECTIVE_REPOSITORY;
  assert.match(repository ?? "", /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.notEqual(repository, "clockgrove/factory");
  if (env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT !== "1")
    assert.equal(
      env.FACTORY_LIVE_LOCAL_SCHEDULING_ACK,
      `${repository}:owned-cpu-priority-contention`,
      "exact scheduling controls acknowledgement required",
    );
  assert.ok(
    !env.FACTORY_LIVE_REGULAR_BACKEND || env.FACTORY_LIVE_REGULAR_BACKEND === "local-default",
    "scheduling fixture uses unchanged default local policy",
  );
  assert.ok(
    !env.FACTORY_LIVE_OBJECTIVE_DELIVERY || env.FACTORY_LIVE_OBJECTIVE_DELIVERY === "regular-prs",
    "scheduling fixture cannot change native selection",
  );
  return {
    repository,
    namespace: qualificationNamespace(env.FACTORY_LIVE_OBJECTIVE_NAMESPACE),
    policy: boundedPolicy(
      "regular-prs",
      modelTokenLimit(env.FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS),
    ),
  };
}

export function schedulingUnit({ repository, namespace, inventory, nonce, role }) {
  assert.match(nonce, /^[a-f0-9-]{36}$/);
  assert.ok(["primary", "contender"].includes(role));
  assert.match(inventory, /^[a-f0-9]{64}$/);
  return `clockgrove-factory-qualification-${hash({ repository, namespace, inventory, nonce, role })}.service`;
}

export function schedulingTransport({ unit, node, bundle, checkout, path, home, uid, username }) {
  assert.match(unit, unitPattern);
  for (const value of [node, bundle, checkout, home]) assert.match(value, /^\/[A-Za-z0-9_./-]+$/);
  assert.ok(!checkout.startsWith("/mnt/") && !home.startsWith("/mnt/"));
  assert.ok(Number.isSafeInteger(uid) && uid > 0);
  assert.match(username, /^[a-z_][a-z0-9_-]*$/);
  assert.ok(
    path.split(":").every((entry) => /^\/[A-Za-z0-9_./-]+$/.test(entry)),
    "PATH must contain only explicit nonsecret absolute directories",
  );
  const runtime = `/run/user/${uid}`;
  // env -i discards the user manager's ambient credentials as well as caller env.
  // Only computed Linux identity/bus paths and nonsecret executable paths survive.
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--pipe",
      "--wait",
      "--collect",
      "--expand-environment=no",
      `--unit=${unit}`,
      "--property=Type=exec",
      "--property=KillMode=control-group",
      "--property=CPUQuota=50%",
      `--working-directory=${checkout}`,
      "/usr/bin/env",
      "-i",
      `HOME=${home}`,
      `USER=${username}`,
      `PATH=${path}`,
      `CODEX_HOME=${join(home, ".codex")}`,
      `XDG_RUNTIME_DIR=${runtime}`,
      `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime}/bus`,
      node,
      bundle,
    ],
    cwd: checkout,
    env: {
      PATH: path,
      HOME: home,
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    },
    stderr: "pipe",
  };
}

function properties(output) {
  const fields = {};
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    assert.ok(
      index > 0 && !Object.hasOwn(fields, line.slice(0, index)),
      "invalid service observation",
    );
    fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return fields;
}

export function observeSchedulingService(expected, port = defaults) {
  assert.match(expected.unit, unitPattern);
  const fields = properties(
    port.exec("systemctl", ["--user", "show", expected.unit, `--property=${readProperties}`]),
  );
  assert.equal(fields.Id, expected.unit, "service identity changed");
  const boot = hash(port.read("/proc/sys/kernel/random/boot_id").trim());
  if (expected.bootDigest) assert.equal(boot, expected.bootDigest, "machine boot identity changed");
  if (
    fields.LoadState === "not-found" &&
    fields.ActiveState === "inactive" &&
    fields.SubState === "dead" &&
    fields.MainPID === "0" &&
    !fields.InvocationID &&
    !fields.ControlGroup &&
    ["", "0", "0 /"].includes(fields.Job)
  )
    return { unit: expected.unit, state: "absent", bootDigest: boot, observedAt: port.now() };
  assert.equal(fields.LoadState, "loaded");
  assert.equal(fields.ActiveState, "active");
  assert.equal(fields.KillMode, "control-group");
  assert.match(fields.InvocationID, /^[a-f0-9]{32}$/);
  assert.match(fields.ControlGroup, /^\/[A-Za-z0-9_.@:/-]+$/);
  assert.ok(
    !fields.ControlGroup.split("/").includes("..") &&
      fields.ControlGroup.endsWith(`/${expected.unit}`),
  );
  if (expected.invocationId)
    assert.equal(fields.InvocationID, expected.invocationId, "service invocation changed");
  const pid = Number(fields.MainPID);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const stat = port.read(`/proc/${pid}/stat`);
  const ticks = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)[19];
  assert.match(ticks, /^\d+$/);
  if (expected.pid) {
    assert.equal(pid, expected.pid);
    assert.equal(ticks, expected.startTicks, "service process reused");
  }
  assert.equal(port.link(`/proc/${pid}/cwd`), expected.checkout, "service checkout changed");
  assert.deepEqual(
    port.read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean),
    [expected.node, expected.bundle],
    "service executable changed",
  );
  assert.ok(
    port.read(`/proc/${pid}/cgroup`).split("\n").includes(`0::${fields.ControlGroup}`),
    "service is outside its observed cgroup",
  );
  const cpu = port.read(`/sys/fs/cgroup${fields.ControlGroup}/cpu.max`).trim().split(/\s+/);
  assert.ok(cpu.length === 2 && cpu.every((value) => /^\d+$/.test(value)));
  const effectiveCpu = Number(cpu[0]) / Number(cpu[1]);
  assert.ok(Number.isFinite(effectiveCpu) && effectiveCpu > 0);
  return {
    ...expected,
    state: "active",
    invocationId: fields.InvocationID,
    pid,
    startTicks: ticks,
    bootDigest: boot,
    cgroup: fields.ControlGroup,
    effectiveCpu,
    observedAt: port.now(),
  };
}

export async function changeSchedulingService(expected, operation, port = defaults) {
  assert.ok(
    expected.invocationId && expected.pid && expected.bootDigest,
    "uncaptured service cannot be changed",
  );
  assert.ok(["release-cpu", "stop"].includes(operation));
  const current = observeSchedulingService(expected, port);
  assert.equal(current.state, "active", "captured service is not current");
  if (operation === "release-cpu") {
    assert.equal(current.effectiveCpu, 0.5, "initial CPU cap changed");
    port.exec("systemctl", ["--user", "set-property", "--runtime", expected.unit, "CPUQuota=400%"]);
    const updated = observeSchedulingService(expected, port);
    assert.equal(updated.effectiveCpu, 4, "CPU release not observed");
    return updated;
  }
  port.exec("systemctl", ["--user", "stop", expected.unit]);
  for (let attempt = 0; attempt < 10; attempt++) {
    const observed = observeSchedulingService(expected, port);
    if (observed.state === "absent") return observed;
    await port.wait(200);
  }
  throw Error("captured service cleanup is unverified");
}

export function assertSchedulingBarrier(
  { receipts, status, unit, policy, objective },
  requireQueued = true,
) {
  assert.equal(unit.state, "active");
  assert.equal(unit.effectiveCpu, 0.5);
  const starts = receipts
    .map((receipt) => receipt.event)
    .filter((event) => event.event === "FactoryRunStarted");
  assert.equal(starts.length, 1, "one authenticated run required");
  const start = starts[0];
  assert.equal(start.objective, objective);
  assert.deepEqual(start.policy, policy, "initial policy changed");
  assert.equal(status.operation, "status");
  assert.equal(status.objective.number, objective);
  assert.equal(status.run.availability, "observed");
  assert.equal(status.run.runId, start.runId);
  const events = receipts
    .map((receipt) => receipt.event)
    .filter((event) => event.runId === start.runId);
  assert.ok(
    events.some((event) => event.event === "GraphProjected" && event.graphSize === 3),
    "graph is not projected",
  );
  assert.ok(
    !events.some((event) => ["AttemptReserved", "AttemptStarted"].includes(event.event)),
    "worker admitted before barrier release",
  );
  assert.ok(
    !events.some((event) =>
      ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event),
    ),
    "run already terminal",
  );
  assert.equal(status.workItems.length, 3);
  assert.equal(status.summary.attempts.active, 0);
  assert.deepEqual(status.capacity.activeReservations, []);
  const roots = status.workItems.filter((item) => item.openDependencies.length === 0);
  assert.equal(roots.length, 2);
  const queued = roots.every((root) =>
    events.some(
      (event) =>
        event.kind === "scheduling" &&
        event.workItem === root.number &&
        ["local-capacity", "local-pressure", "local-cooldown"].includes(event.reasonCode),
    ),
  );
  if (requireQueued) assert.ok(queued, "measured local admission block not observed");
  else if (!queued) return null;
  return {
    runId: start.runId,
    roots: roots.map((item) => item.number),
    policyDigest: start.policyDigest,
  };
}

/** Octokit's fetch transport honors AbortSignal, not a request.timeout field.
 * An uncertain PATCH is aborted once and never automatically resubmitted. */
export async function schedulingRequest(hooks, route, parameters = {}, signal, timeoutMs = 15000) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000);
  signal?.throwIfAborted();
  const bounded = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  return await hooks.request(route, { ...parameters, request: { signal: bounded } });
}

async function snapshot(hooks) {
  const objective = hooks.evidence.objective.number;
  const children = (
    await schedulingRequest(
      hooks,
      "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
      {
        issue_number: objective,
        per_page: 100,
      },
      hooks.signal,
    )
  ).data;
  assert.ok(Array.isArray(children) && children.length <= 3, "unexpected fixture graph");
  const comments = [];
  for (const number of [objective, ...children.map((item) => item.number)]) {
    const rows = (
      await schedulingRequest(
        hooks,
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          issue_number: number,
          per_page: 100,
        },
        hooks.signal,
      )
    ).data;
    assert.ok(Array.isArray(rows) && rows.length < 100, "receipt page is incomplete");
    comments.push(...rows);
  }
  const receipts = authenticatedFaultEvents(comments, hooks.evidence.actor, objective);
  const status = await hooks.call("factory_status", {
    owner: hooks.owner,
    repo: hooks.repo,
    objectiveNumber: objective,
  });
  return {
    children: children.map(({ number, id, node_id }) => ({ number, id, nodeId: node_id })),
    receipts,
    status,
  };
}

async function repositoryLease(hooks) {
  const ref = (
    await schedulingRequest(
      hooks,
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      {
        ref: "clockgrove-factory/leases/repository-controller",
      },
      hooks.signal,
    )
  ).data;
  const commit = (
    await schedulingRequest(
      hooks,
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      {
        commit_sha: ref.object.sha,
      },
      hooks.signal,
    )
  ).data;
  assert.equal(commit.sha, ref.object.sha);
  const trailers = commit.message
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Factory-Repository-Lease: "));
  assert.equal(trailers.length, 1);
  assert.ok(trailers[0].length < 8192);
  const record = JSON.parse(
    Buffer.from(trailers[0].slice("Factory-Repository-Lease: ".length), "base64url").toString(
      "utf8",
    ),
  );
  assert.equal(record.protocol, "clockgrove.factory/v2");
  assert.equal(record.kind, "repository-lease");
  assert.match(commit.sha, /^[a-f0-9]{40}$/);
  assert.match(record.policyDigest, /^[a-f0-9]{64}$/);
  assert.ok(
    typeof record.controllerId === "string" &&
      record.controllerId.length > 0 &&
      record.controllerId.length <= 160,
  );
  assert.ok(Number.isSafeInteger(record.sequence) && record.sequence > 0);
  assert.ok(["RepositoryLeaseAcquired", "RepositoryLeaseRenewed"].includes(record.event));
  assert.ok(
    Number.isSafeInteger(record.epoch) &&
      record.epoch > 0 &&
      Date.parse(record.expiresAt) > Date.now() + 60000,
    "repository lease too near expiry",
  );
  return { oid: commit.sha, record };
}

export function assertSchedulingCompletion(evidence) {
  assertRegularCompletion(evidence);
  const proof = evidence.scheduling;
  assert.equal(proof?.kind, "director-cgroup-native-priority-outer-lease");
  assert.equal(proof.barrier.runId, evidence.runResult.runId);
  assert.deepEqual(
    assertSchedulingBarrier({
      ...proof.barrier,
      policy: evidence.policy,
      objective: evidence.objective.number,
    }),
    {
      runId: proof.barrier.runId,
      roots: proof.barrier.roots,
      policyDigest: proof.barrier.policyDigest,
    },
  );
  assert.equal(proof.barrier.unit.effectiveCpu, 0.5);
  assert.equal(proof.released.effectiveCpu, 4);
  assert.equal(proof.released.invocationId, proof.barrier.unit.invocationId);
  for (const key of ["unit", "pid", "startTicks", "bootDigest", "node", "bundle", "checkout"])
    assert.equal(proof.released[key], proof.barrier.unit[key], "released service identity changed");
  assert.equal(proof.contention.result, "repository-lease-refused");
  assertRepositoryContention({
    ...proof.contention,
    controller: proof.barrier.receipts
      .map((receipt) => receipt.event)
      .filter((event) => event.event === "ControllerObserved")
      .at(-1),
  });
  assert.equal(
    proof.contention.before.record.controllerId,
    proof.contention.after.record.controllerId,
  );
  assert.equal(proof.contention.before.record.epoch, proof.contention.after.record.epoch);
  assert.equal(
    proof.contention.before.record.policyDigest,
    proof.contention.after.record.policyDigest,
  );
  assertNativePriorityReadback(
    proof.priority.before,
    proof.priority.after,
    proof.barrier.roots,
    proof.priority.promoted,
  );
  const attempts = evidence.events
    .filter(
      (event) => event.runId === evidence.runResult.runId && event.event === "AttemptReserved",
    )
    .sort((a, b) => a.sequence - b.sequence);
  assert.equal(attempts[0].workItem, proof.priority.promoted);
  assert.equal(
    attempts[0].subIssuePosition,
    proof.priority.after.findIndex((item) => item.number === proof.priority.promoted),
  );
  const barrierSequence = Math.max(
    ...proof.releaseBarrier.receipts.map((receipt) => receipt.event.sequence),
  );
  assertSchedulingBarrier({
    ...proof.releaseBarrier,
    policy: evidence.policy,
    objective: evidence.objective.number,
  });
  assert.ok(
    attempts.every(
      (event) =>
        event.sequence > barrierSequence &&
        Date.parse(event.capacityMeasuredAt) >= Date.parse(proof.releaseRequestedAt) &&
        event.effectiveCpu === 4,
    ),
    "admission was not measured after exact CPU release",
  );
  assert.equal(proof.cleanup.primary.unit, proof.primary.unit);
  assert.equal(proof.cleanup.primary.bootDigest, proof.primary.bootDigest);
  assert.equal(proof.cleanup.contender.unit, proof.contender.unit);
  assert.equal(proof.cleanup.contender.bootDigest, proof.contender.bootDigest);
  assert.equal(proof.cleanup.primary.state, "absent");
  assert.equal(proof.cleanup.contender.state, "absent");
  assert.ok(
    proof.cleanup.workerScopes.length >= 3 &&
      proof.cleanup.workerScopes.every((item) => item.status === "absent"),
    "owned worker cleanup unverified",
  );
  assert.deepEqual(
    proof.cleanup.workerScopes.map((item) => item.unit).sort(),
    ownedSchedulingScopes(evidence, proof.primary),
  );
}

export function assertRepositoryContention({ response, before, after, controller }) {
  assert.deepEqual(
    response,
    {
      isError: true,
      content: [{ type: "text", text: "another repository controller holds the lease" }],
    },
    "competing installed runner was not exactly refused",
  );
  assert.equal(controller?.event, "ControllerObserved");
  for (const observation of [before, after]) {
    assert.match(observation.oid, /^[a-f0-9]{40}$/);
    assert.equal(observation.record.protocol, "clockgrove.factory/v2");
    assert.equal(observation.record.kind, "repository-lease");
    assert.ok(
      ["RepositoryLeaseAcquired", "RepositoryLeaseRenewed"].includes(observation.record.event),
    );
    assert.equal(observation.record.controllerId, controller.controllerId);
    assert.equal(observation.record.epoch, controller.epoch);
    assert.equal(observation.record.policyDigest, controller.controllerPolicyDigest);
  }
  assert.ok(after.record.sequence >= before.record.sequence, "repository lease sequence regressed");
}

export function assertNativePriorityReadback(before, after, roots, promoted) {
  assert.equal(before.length, 3);
  assert.equal(after.length, 3);
  for (const list of [before, after]) {
    assert.equal(new Set(list.map((item) => item.id)).size, 3);
    assert.equal(new Set(list.map((item) => item.number)).size, 3);
    for (const item of list) {
      assert.ok(
        Number.isSafeInteger(item.id) &&
          item.id > 0 &&
          Number.isSafeInteger(item.number) &&
          item.number > 0,
      );
      assert.ok(typeof item.nodeId === "string" && item.nodeId.length > 0);
    }
  }
  assert.deepEqual(
    [...before].sort((a, b) => a.id - b.id),
    [...after].sort((a, b) => a.id - b.id),
  );
  const ordered = before.filter((item) => roots.includes(item.number));
  assert.equal(ordered.length, 2);
  assert.equal(promoted, ordered[1].number);
  assert.ok(
    after.findIndex((item) => item.number === promoted) <
      after.findIndex((item) => item.number === ordered[0].number),
    "native priority did not change",
  );
}

export function ownedSchedulingScopes(evidence, primary) {
  const events = evidence.events.filter((event) => event.runId === evidence.runResult.runId);
  const reservations = events.filter(
    (event) =>
      event.event === "AttemptReserved" ||
      (event.event === "CapacityReserved" && event.phase === "validation"),
  );
  assert.ok(reservations.length > 0 && reservations.length <= 100);
  for (const event of reservations)
    assert.ok(event.localScopeBatch, "resource reservation lacks its owned scope batch");
  const scoped = events.filter((event) => event.localScopeBatch);
  assert.ok(scoped.length <= 100);
  const units = new Set();
  for (const event of scoped) {
    const batch = event.localScopeBatch;
    assert.equal(batch.producerPid, primary.pid);
    assert.equal(batch.producerStartTicks, primary.startTicks);
    assert.equal(batch.identity.producerUnit, primary.unit);
    assert.equal(batch.identity.producerInvocationId, primary.invocationId);
    assert.equal(batch.identity.repository, evidence.repository);
    assert.equal(batch.identity.runId, evidence.runResult.runId);
    assert.equal(batch.identity.objective, evidence.objective.number);
    assert.equal(batch.identity.workItem, event.workItem);
    assert.equal(batch.identity.attempt, event.attempt);
    assert.equal(batch.identity.policyDigest, event.policyDigest);
    assert.equal(batch.identity.directorEpoch, event.directorEpoch);
    assert.equal(batch.identity.phase, event.phase ?? "execution");
    assert.equal(batch.identity.commandIndex, 0);
    assert.ok(
      Number.isSafeInteger(batch.commandCount) &&
        batch.commandCount > 0 &&
        batch.commandCount <= 257,
    );
    if (batch.identity.phase === "execution") assert.equal(batch.commandCount, 1);
    for (let i = 0; i < batch.commandCount; i++)
      units.add(scopeUnit({ ...batch.identity, commandIndex: i }));
  }
  for (const validation of events.filter((event) => event.event === "ValidationRecorded")) {
    const capacities = reservations.filter(
      (event) =>
        event.event === "CapacityReserved" &&
        event.workItem === validation.workItem &&
        event.attempt === validation.attempt &&
        event.sequence < validation.sequence,
    );
    assert.ok(capacities.length > 0, "validation invocation lacks its preceding owned capacity");
    const capacity = capacities.sort((left, right) => right.sequence - left.sequence)[0];
    const collected = events
      .filter(
        (event) =>
          event.event === "AttemptCollected" &&
          event.workItem === validation.workItem &&
          event.attempt === validation.attempt &&
          event.sequence < capacity.sequence,
      )
      .sort((left, right) => right.sequence - left.sequence)[0];
    assert.ok(
      collected?.artifactDigest,
      "validation invocation lacks its collected artifact binding",
    );
    assert.equal(
      capacity.localScopeBatch.identity.invocationDigest,
      collected.artifactDigest,
      "validation scope belongs to another artifact invocation",
    );
  }
  assert.ok(units.size <= 100);
  return [...units].sort();
}

export function createSchedulingQualification(authority, env = process.env, port = defaults) {
  let primary;
  let contender;
  const nonce = randomUUID();
  const safe =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch {
        throw Error(
          "local scheduling qualification boundary unavailable; inspect private evidence",
        );
      }
    };
  return {
    scope: "installed-local-explicit-regular-objective",
    policy: authority.policy,
    privateEvidence: true,
    namespace: authority.namespace,
    wrapTransport: safe(async (parameters, context) => {
      assert.deepEqual(parameters.args, [join(context.pluginRoot, "dist/mcp-server.js")]);
      const user = userInfo();
      const base = {
        repository: authority.repository,
        namespace: authority.namespace,
        inventory: context.evidence.installedArtifact.inventorySha256,
        nonce,
      };
      const expected = {
        unit: schedulingUnit({ ...base, role: "primary" }),
        node: realpathSync(process.execPath),
        bundle: realpathSync(parameters.args[0]),
        checkout: realpathSync(parameters.cwd),
      };
      assert.equal(
        observeSchedulingService(expected, port).state,
        "absent",
        "disposable unit already exists",
      );
      primary = expected;
      context.evidence.scheduling = {
        kind: "director-cgroup-native-priority-outer-lease",
        nonce,
        primary: expected,
      };
      context.save();
      return schedulingTransport({
        ...expected,
        path: env.PATH,
        home: homedir(),
        uid: user.uid,
        username: user.username,
      });
    }),
    beforeRun: safe(async (hooks) => {
      primary = observeSchedulingService(primary, port);
      assert.equal(primary.state, "active");
      assert.equal(primary.effectiveCpu, 0.5);
      hooks.evidence.scheduling.primary = primary;
      hooks.save();
    }),
    duringRun: safe(async (hooks) => {
      let settled = false;
      void hooks.run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const assertRunning = () =>
        assert.ok(
          !settled && !hooks.signal.aborted,
          "original foreground outcome no longer permits intervention",
        );
      let observed;
      let barrier;
      for (let attempt = 0; attempt < 48; attempt++) {
        assertRunning();
        observed = await snapshot(hooks);
        const unit = observeSchedulingService(primary, port);
        // Absence of a graph is expected during compilation. Once projected,
        // malformed authority/admission evidence is fatal, never a retry signal.
        if (observed.receipts.some((receipt) => receipt.event.event === "GraphProjected")) {
          barrier = assertSchedulingBarrier(
            {
              ...observed,
              unit,
              policy: authority.policy,
              objective: hooks.evidence.objective.number,
            },
            false,
          );
          if (barrier) break;
        }
        await port.wait(10000);
      }
      assert.ok(barrier, "bounded capacity barrier not observed");
      const proof = hooks.evidence.scheduling;
      proof.barrier = {
        ...barrier,
        unit: observeSchedulingService(primary, port),
        receipts: observed.receipts,
        status: observed.status,
      };
      hooks.save();
      const roots = observed.children.filter((item) => barrier.roots.includes(item.number));
      assert.equal(roots.length, 2);
      const promoted = roots[1];
      const prior = roots[0];
      assertRunning();
      await schedulingRequest(
        hooks,
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority",
        {
          issue_number: hooks.evidence.objective.number,
          sub_issue_id: promoted.id,
          before_id: prior.id,
        },
        hooks.signal,
      );
      let after;
      for (let attempt = 0; attempt < 6; attempt++) {
        const check = await snapshot(hooks);
        assertSchedulingBarrier({
          ...check,
          unit: observeSchedulingService(primary, port),
          policy: authority.policy,
          objective: hooks.evidence.objective.number,
        });
        assert.deepEqual(
          [...check.children].sort((a, b) => a.id - b.id),
          [...observed.children].sort((a, b) => a.id - b.id),
        );
        if (
          check.children.findIndex((item) => item.id === promoted.id) <
          check.children.findIndex((item) => item.id === prior.id)
        ) {
          after = check.children;
          break;
        }
        await port.wait(2000);
      }
      assert.ok(after, "native priority readback unavailable");
      assertNativePriorityReadback(observed.children, after, barrier.roots, promoted.number);
      proof.priority = { before: observed.children, after, promoted: promoted.number };
      hooks.save();
      const before = await repositoryLease(hooks);
      const controller = observed.receipts
        .map((receipt) => receipt.event)
        .filter((event) => event.event === "ControllerObserved")
        .at(-1);
      assert.equal(before.record.controllerId, controller?.controllerId);
      assert.equal(before.record.epoch, controller?.epoch);
      assert.equal(before.record.policyDigest, controller?.controllerPolicyDigest);
      const user = userInfo();
      contender = {
        node: primary.node,
        bundle: primary.bundle,
        checkout: primary.checkout,
        bootDigest: primary.bootDigest,
        unit: schedulingUnit({
          repository: authority.repository,
          namespace: authority.namespace,
          inventory: hooks.evidence.installedArtifact.inventorySha256,
          nonce,
          role: "contender",
        }),
      };
      assert.equal(observeSchedulingService(contender, port).state, "absent");
      const second = new Client({ name: "factory-scheduling-contender", version: "1.0.0" });
      const secondTransport = new StdioClientTransport(
        schedulingTransport({
          ...contender,
          path: env.PATH,
          home: homedir(),
          uid: user.uid,
          username: user.username,
        }),
      );
      try {
        assertRunning();
        await second.connect(secondTransport);
        assert.equal(second.getServerVersion()?.version, hooks.evidence.pluginVersion);
        contender = observeSchedulingService(contender, port);
        assert.equal(contender.effectiveCpu, 0.5);
        proof.contender = contender;
        hooks.save();
        assertRunning();
        const response = await second.callTool(
          { name: "factory_run", arguments: hooks.evidence.runRequest.arguments },
          undefined,
          { timeout: 60000, maxTotalTimeout: 60000 },
        );
        // Keep the fixed, bounded error contract, not an arbitrary error substring.
        const refusal = { isError: response.isError, content: response.content };
        assert.deepEqual(refusal, {
          isError: true,
          content: [{ type: "text", text: "another repository controller holds the lease" }],
        });
        const afterLease = await repositoryLease(hooks);
        assertRepositoryContention({ response: refusal, before, after: afterLease, controller });
        proof.contention = {
          result: "repository-lease-refused",
          responseDigest: hash(response),
          response: refusal,
          before,
          after: afterLease,
        };
        proof.cleanup = { contender: await changeSchedulingService(contender, "stop", port) };
        hooks.save();
      } finally {
        await second.close();
      }
      assertRunning();
      const latest = await snapshot(hooks);
      const releaseUnit = observeSchedulingService(primary, port);
      assertSchedulingBarrier({
        ...latest,
        unit: releaseUnit,
        policy: authority.policy,
        objective: hooks.evidence.objective.number,
      });
      proof.releaseBarrier = { ...latest, unit: releaseUnit };
      proof.releaseRequestedAt = port.now();
      hooks.save();
      assertRunning();
      proof.released = await changeSchedulingService(primary, "release-cpu", port);
      hooks.save();
    }),
    afterRun: safe(async (hooks) => {
      await observeRegularCommits({
        ...hooks,
        request: (route, parameters) => schedulingRequest(hooks, route, parameters),
      });
      assertRegularCompletion(hooks.evidence);
      const proof = hooks.evidence.scheduling;
      proof.cleanup.workerScopes = ownedSchedulingScopes(hooks.evidence, primary).map((unit) =>
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
      );
      assert.ok(
        proof.cleanup.workerScopes.every((item) => item.status === "absent"),
        "owned worker cleanup unknown",
      );
      proof.cleanup.primary = await changeSchedulingService(primary, "stop", port);
      hooks.save();
      assertSchedulingCompletion(hooks.evidence);
    }),
    onFailure: async (hooks) => {
      hooks.evidence.scheduling ??= {};
      hooks.evidence.failure =
        "local scheduling boundary unavailable; inspect retained exact identities";
      hooks.evidence.scheduling.failure = {
        code: "scheduling-boundary-unverified",
        originalCallOutcome: "inspect-authenticated-history",
        automaticRetry: false,
        automaticCpuRelease: false,
      };
    },
    assessCompletion: (evidence) => {
      try {
        assertSchedulingCompletion(evidence);
        return { result: "passed", scope: "installed-director-scheduling-subset" };
      } catch {
        return {
          result: "incomplete",
          scope: "installed-director-scheduling-subset",
          reason: "Scheduling evidence is incomplete; no lease/priority/capacity claim established",
        };
      }
    },
  };
}

export async function main(env = process.env, run = installedMain) {
  const authority = schedulingAuthority(env);
  if (!authority) {
    console.log("Not exercised: explicit local scheduling opt-in required.");
    return;
  }
  await run(createSchedulingQualification(authority, env));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      "Local scheduling qualification incomplete; inspect private evidence and exact owned units. No automatic reinjection.",
    );
    process.exitCode = 2;
  }
}
