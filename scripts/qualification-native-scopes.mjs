/** Exact read-only terminal resource observations, including foreground (no service producer) runs. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { parseUnitObservation } from "./verify-local-faults.mjs";
import { nativeQualificationEvents } from "./qualification-sibling-refresh-proof.mjs";

const fields = [
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
export function nativeScopeUnit(identity) {
  assert.ok(identity && Object.keys(identity).every((key) => fields.includes(key)));
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
    assert.match(identity[key], /^[a-f0-9]{64}$/);
  assert.match(identity.repository, /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.match(identity.runId, /^[A-Za-z0-9._:/+-]{1,160}$/);
  assert.equal(identity.producerUnit === undefined, identity.producerInvocationId === undefined);
  if (identity.producerUnit !== undefined) {
    assert.match(identity.producerUnit, /^[A-Za-z0-9_.@:-]+\.service$/);
    assert.match(identity.producerInvocationId, /^[a-f0-9]{32}$/);
  }
  const ordered = Object.fromEntries(
    fields
      .filter((field) => identity[field] !== undefined)
      .map((field) => [field, identity[field]]),
  );
  return `clockgrove-factory-work-${createHash("sha256").update(JSON.stringify(ordered)).digest("hex")}.scope`;
}
export function nativeOwnedScopes(evidence, hostIdentity) {
  assert.match(hostIdentity, /^[a-f0-9]{64}$/);
  const events = nativeQualificationEvents(evidence);
  const units = new Set();
  const reservations = events.filter(
    (event) =>
      event.event === "AttemptReserved" ||
      (event.event === "CapacityReserved" && event.phase === "validation"),
  );
  assert.ok(reservations.length >= evidence.children.length * 2 && reservations.length <= 1000);
  for (const event of reservations) {
    const batch = event.localScopeBatch;
    assert.ok(batch, "local reservation has no exact scope ownership");
    assert.ok(
      Number.isSafeInteger(batch.commandCount) &&
        batch.commandCount > 0 &&
        batch.commandCount <= 257,
    );
    assert.ok(Number.isSafeInteger(batch.producerPid) && batch.producerPid > 0);
    assert.match(batch.producerStartTicks, /^[0-9]{1,30}$/);
    assert.ok(Date.parse(batch.deadline) > Date.parse(event.at));
    const identity = batch.identity;
    assert.equal(identity.commandIndex, 0);
    assert.equal(identity.repository, evidence.repository);
    assert.equal(identity.hostIdentity, hostIdentity, "scope belongs to another host/namespace");
    for (const key of ["objective", "workItem", "attempt", "runId", "policyDigest"])
      assert.equal(identity[key], event[key]);
    assert.equal(identity.directorEpoch, event.recoveryEpoch ?? event.directorEpoch);
    assert.equal(identity.phase, event.event === "AttemptReserved" ? "execution" : "validation");
    if (identity.phase === "execution") {
      assert.equal(batch.commandCount, 1);
      const starts = events.filter(
        (started) =>
          started.event === "AttemptStarted" &&
          ["runId", "objective", "workItem", "attempt", "policyDigest", "directorEpoch"].every(
            (key) => started[key] === event[key],
          ),
      );
      assert.equal(starts.length, 1, "execution scope lacks its exact actual launch");
      assert.ok(starts[0].sequence > event.sequence);
      assert.equal(
        starts[0].resourceHostIdentity,
        identity.hostIdentity,
        "actual worker resource host differs from reserved scope",
      );
      assert.equal(
        starts[0].backend,
        event.backend,
        "actual worker backend differs from reservation",
      );
      if (starts[0].environmentIdentity !== undefined)
        assert.ok(
          typeof starts[0].environmentIdentity === "string" &&
            starts[0].environmentIdentity.length > 0 &&
            starts[0].environmentIdentity.length <= 500,
          "invalid optional worker environment identity",
        );
      assert.ok(
        typeof starts[0].providerResourceId === "string" &&
          starts[0].providerResourceId.length > 0 &&
          starts[0].providerResourceId.length <= 500,
        "actual worker resource identity unavailable",
      );
      // Local SDK/CLI handles report host and resource identity, not an image/environment identity.
      if (event.backend === "codex-sdk/local-worktree") {
        const attemptId = createHash("sha256")
          .update(
            JSON.stringify([
              "clockgrove.factory/attempt-v2",
              evidence.repository.trim().toLowerCase(),
              event.runId,
              event.objective,
              event.workItem,
              event.attempt,
              event.directorEpoch,
            ]),
          )
          .digest("hex");
        assert.equal(
          starts[0].providerResourceId,
          `sdk-${attemptId.slice(0, 24)}`,
          "actual SDK resource belongs to another attempt",
        );
      } else {
        assert.equal(
          event.backend,
          "codex-cli/local-worktree",
          "unsupported local execution backend",
        );
        assert.match(
          starts[0].providerResourceId,
          /^local-[1-9][0-9]*$/,
          "invalid actual CLI process identity",
        );
        assert.ok(
          Number.isSafeInteger(Number(starts[0].providerResourceId.slice(6))),
          "invalid actual CLI PID",
        );
      }
    }
    for (let index = 0; index < batch.commandCount; index++)
      units.add(nativeScopeUnit({ ...identity, commandIndex: index }));
  }
  return [...units].sort();
}
function currentHost() {
  const machine = readFileSync("/etc/machine-id", "utf8").trim();
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  assert.match(machine, /^[a-f0-9]{32}$/);
  assert.match(boot, /^[a-f0-9-]{36}$/);
  const namespaces = ["pid", "user", "mnt"].map((name) => readlinkSync(`/proc/self/ns/${name}`));
  for (const [index, name] of ["pid", "user", "mnt"].entries())
    assert.match(namespaces[index], new RegExp(`^${name}:\\[\\d+\\]$`));
  return createHmac("sha256", "clockgrove.factory/local-resource-host-v1")
    .update(JSON.stringify([machine, process.getuid(), boot, ...namespaces]))
    .digest("hex");
}
export function observeNativeScopes(
  evidence,
  observe = (unit) => {
    const result = spawnSync(
      "systemctl",
      [
        "--user",
        "show",
        unit,
        "--property=Id,LoadState,ActiveState,SubState,ControlGroup,Job,InvocationID,KillMode",
        "--no-pager",
      ],
      { encoding: "utf8", timeout: 15000, maxBuffer: 65536 },
    );
    assert.ok(!result.error && [0, 1, 4].includes(result.status), "exact scope read unavailable");
    return result.stdout;
  },
  hostIdentity = currentHost(),
) {
  const units = nativeOwnedScopes(evidence, hostIdentity);
  evidence.nativeScopeObservations = {
    hostIdentity,
    units: units.map((unit) => {
      const output = observe(unit);
      const observation = parseUnitObservation(unit, output);
      assert.equal(observation.status, "absent", "exact owned scope remains active or unknown");
      return { ...observation, output };
    }),
  };
}
export function assertNativeScopes(evidence) {
  const observations = evidence.nativeScopeObservations;
  const expected = nativeOwnedScopes(evidence, observations.hostIdentity);
  assert.deepEqual(
    observations.units.map((value) => value.unit),
    expected,
    "scope absence coverage differs",
  );
  for (const value of observations.units) {
    const parsed = parseUnitObservation(value.unit, value.output, value.at);
    assert.deepEqual(parsed, {
      unit: value.unit,
      status: value.status,
      at: value.at,
      invocationId: value.invocationId,
      controlGroupDigest: value.controlGroupDigest,
    });
    assert.equal(parsed.status, "absent");
    assert.ok(
      Date.parse(value.at) >=
        Date.parse(
          evidence.status.run.completedAt ??
            evidence.events.find(
              (event) =>
                event.event === "FactoryRunCompleted" && event.runId === evidence.runResult.runId,
            )?.at,
        ),
      "scope read predates terminal completion",
    );
  }
}
