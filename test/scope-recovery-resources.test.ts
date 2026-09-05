import { describe, expect, it, vi } from "vitest";
import { observeLocalScopeBatch } from "../src/recovery/scope-resources.js";
import { localScopeUnit, type LocalScopeReadPort } from "../src/runtime/local-scope.js";
import type { LocalScopeBatch } from "../src/protocol/local-scope.js";

const batch: LocalScopeBatch = {
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
    invocationDigest: "c".repeat(64),
    hostIdentity: "b".repeat(64),
    producerUnit: "factory-producer.service",
    producerInvocationId: "d".repeat(32),
  },
  commandCount: 2,
  producerPid: 123,
  producerStartTicks: "456",
  deadline: "2026-09-05T00:01:00Z",
};
function properties(unit: string, active = false, invocation = "d".repeat(32)) {
  return Object.entries({
    Id: unit,
    LoadState: active ? "loaded" : "not-found",
    ActiveState: active ? "active" : "inactive",
    SubState: active ? "running" : "dead",
    ControlGroup: active ? `/user.slice/${unit}` : "",
    Job: "",
    InvocationID: active ? invocation : "",
    KillMode: "control-group",
  })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
const stat = (ticks = "456", state = "S") =>
  `123 (producer (name)) ${[state, ...Array<string>(18).fill("0"), ticks, "0"].join(" ")}\n`;
function fixture() {
  const read = vi.fn(async (path: string): Promise<string> => {
    if (path === "/proc/123/stat") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (path === "/proc/self/mountinfo")
      return "31 20 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
    return "populated 1\nfrozen 0\n";
  });
  const show = vi.fn(async (unit: string): Promise<string> => properties(unit));
  const hostIdentity = vi.fn(async (): Promise<string | null> => batch.identity.hostIdentity);
  const port: LocalScopeReadPort = { read, show, hostIdentity, now: () => new Date() };
  return { port, read, show, hostIdentity };
}
describe("original producer and complete scope-batch reconciliation", () => {
  it("requires every scope absent after the original producer is gone", async () => {
    const f = fixture();
    expect(await observeLocalScopeBatch(batch, f.port)).toMatchObject({
      status: "absent",
      reason: "original-producer-and-scopes-absent",
    });
    expect(new Set(f.show.mock.calls.map(([unit]) => unit))).toEqual(
      new Set([
        localScopeUnit(batch.identity),
        localScopeUnit({ ...batch.identity, commandIndex: 1 }),
        batch.identity.producerUnit!,
      ]),
    );
    expect(f.read.mock.calls.map(([path]) => path)).toEqual(["/proc/123/stat", "/proc/123/stat"]);
  });
  it("does not release a missing scope while its original producer could still launch", async () => {
    const f = fixture();
    f.read.mockResolvedValue(stat());
    expect(await observeLocalScopeBatch(batch, f.port)).toMatchObject({
      status: "active",
      reason: "producer-active",
    });
    expect(f.show).not.toHaveBeenCalled();
  });
  it.each(["denied", "malformed"])(
    "does not convert %s producer observations to absence",
    async (mode) => {
      const f = fixture();
      if (mode === "denied")
        f.read.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
      else f.read.mockResolvedValue("123 (truncated) S 1 2");
      expect(await observeLocalScopeBatch(batch, f.port)).toMatchObject({ status: "unknown" });
      expect(f.show).not.toHaveBeenCalled();
    },
  );
  it("keeps a surviving child in a later command scope active", async () => {
    const f = fixture();
    const later = localScopeUnit({ ...batch.identity, commandIndex: 1 });
    f.show.mockImplementation(async (unit) => properties(unit, unit === later));
    expect(await observeLocalScopeBatch(batch, f.port)).toMatchObject({
      status: "active",
      reason: "scope-active",
    });
  });
  it("retains stable original-resource absence across PID reuse", async () => {
    const f = fixture();
    const first = await observeLocalScopeBatch(batch, f.port);
    f.read.mockResolvedValue(stat("999"));
    expect(await observeLocalScopeBatch(batch, f.port)).toMatchObject({
      status: "absent",
      evidenceDigest: first.evidenceDigest,
    });
  });
  it("checks the producer again after scope observation", async () => {
    const f = fixture();
    let calls = 0;
    f.read.mockImplementation(async () => {
      if (++calls === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return stat();
    });
    expect(await observeLocalScopeBatch(batch, f.port)).toMatchObject({
      status: "active",
      reason: "producer-active",
    });
  });
  it("does not use a changed host or missing manager as proof", async () => {
    const f = fixture();
    f.hostIdentity.mockResolvedValue(null);
    expect(await observeLocalScopeBatch(batch, f.port)).toMatchObject({ status: "unknown" });
    f.hostIdentity.mockResolvedValue(batch.identity.hostIdentity);
    f.show.mockRejectedValue(new Error("bus unavailable"));
    expect(await observeLocalScopeBatch(batch, f.port)).toMatchObject({ status: "unknown" });
  });
  it("requires the original service generation gone even if its main PID disappeared", async () => {
    const f = fixture();
    const producerUnit = "factory-producer.service",
      producerInvocationId = "d".repeat(32);
    const serviceBatch = {
      ...batch,
      identity: { ...batch.identity, producerUnit, producerInvocationId },
    };
    f.show.mockImplementation(async (unit) => properties(unit, unit === producerUnit));
    expect(await observeLocalScopeBatch(serviceBatch, f.port)).toMatchObject({
      status: "active",
      reason: "producer-active",
    });
    f.show.mockImplementation(async (unit) =>
      properties(unit, unit === producerUnit, "e".repeat(32)),
    );
    expect(await observeLocalScopeBatch(serviceBatch, f.port)).toMatchObject({ status: "absent" });
  });
});
