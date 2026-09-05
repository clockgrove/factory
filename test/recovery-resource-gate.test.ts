import { describe, expect, it } from "vitest";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { observeLocalScopeBatch } from "../src/recovery/scope-resources.js";
import {
  assertLocalScopeLaunch,
  type LocalScopeReadPort,
  localScopeUnit,
} from "../src/runtime/local-scope.js";

function reservation(service = true) {
  const event = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "capacity",
    event: "CapacityReserved",
    objective: 1,
    runId: "source",
    sequence: 1,
    at: "2026-09-04T00:00:00Z",
    workItem: 2,
    attempt: 1,
    phase: "validation",
    backend: "codex-cli/local-worktree",
    requestedCpu: 1,
    requestedMemoryMb: 512,
    directorEpoch: 1,
    policyDigest: "a".repeat(64),
    localScopeBatch: {
      identity: {
        protocol: "clockgrove.factory/local-scope-v1",
        repository: "o/r",
        objective: 1,
        workItem: 2,
        attempt: 1,
        runId: "source",
        directorEpoch: 1,
        policyDigest: "a".repeat(64),
        phase: "validation",
        commandIndex: 0,
        invocationDigest: "b".repeat(64),
        hostIdentity: "c".repeat(64),
        ...(service
          ? { producerUnit: "factory-test.service", producerInvocationId: "d".repeat(32) }
          : {}),
      },
      commandCount: 2,
      producerPid: 123,
      producerStartTicks: "456",
      deadline: "2026-09-05T00:00:00Z",
    },
  });
  if (event.kind !== "capacity" || !event.localScopeBatch) throw new Error("invalid fixture");
  return event.localScopeBatch;
}

function missing(unit: string) {
  return `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=\nInvocationID=\nKillMode=control-group\n`;
}

function port(): LocalScopeReadPort {
  return {
    hostIdentity: async () => "c".repeat(64),
    show: async (unit) => missing(unit),
    read: async (path) => {
      if (path === "/proc/123/stat")
        throw Object.assign(new Error("original producer exited"), { code: "ENOENT" });
      throw new Error(`unexpected read ${path}`);
    },
    now: () => new Date(),
  };
}

describe("recovery resource ownership before scope registration", () => {
  it.each(["process", "none", ""])(
    "does not launch a recoverable batch under a producer with KillMode=%s",
    async (killMode) => {
      const batch = reservation();
      const reader = port();
      reader.show = async (unit) =>
        unit === batch.identity.producerUnit
          ? `Id=${unit}\nLoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/user.slice/${unit}\nJob=\nInvocationID=${batch.identity.producerInvocationId}\nKillMode=${killMode}\n`
          : missing(unit);
      await expect(assertLocalScopeLaunch(batch.identity, undefined, reader)).rejects.toThrow();
    },
  );

  it("cannot discharge a foreground launch from dead producer PID and missing future scopes", async () => {
    // These observations also hold while an already-forked systemd-run child is
    // waiting to register its scope. No owned launcher domain has been observed.
    expect(await observeLocalScopeBatch(reservation(false), port())).toMatchObject({
      status: "unknown",
    });
  });

  it("keeps equivalent service-bound absence stable across scope garbage collection", async () => {
    const batch = reservation();
    const reader = port();
    const first = await observeLocalScopeBatch(batch, reader);
    expect(first.status).toBe("absent");
    const unit = localScopeUnit(batch.identity);
    reader.show = async (name) =>
      name === unit
        ? `Id=${name}\nLoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/user.slice/${name}\nJob=\nInvocationID=${"e".repeat(32)}\nKillMode=control-group\n`
        : missing(name);
    reader.read = async (path) => {
      if (path === "/proc/123/stat")
        throw Object.assign(new Error("original producer exited"), { code: "ENOENT" });
      if (path === "/proc/self/mountinfo")
        return "31 20 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
      if (path === `/sys/fs/cgroup/user.slice/${unit}/cgroup.events`)
        return "populated 0\nfrozen 0\n";
      throw new Error(`unexpected read ${path}`);
    };
    expect(await observeLocalScopeBatch(batch, reader)).toMatchObject({
      status: "absent",
      evidenceDigest: first.evidenceDigest,
    });
  });
});
