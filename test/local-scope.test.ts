import { describe, expect, it, vi } from "vitest";
import { parseFactoryEvent } from "../src/protocol/events.js";
import {
  localScopeUnit,
  observeLocalScope,
  scopedLocalCommand,
  type LocalScopeIdentity,
  type LocalScopeReadPort,
} from "../src/runtime/local-scope.js";

const identity: LocalScopeIdentity = {
  protocol: "clockgrove.factory/local-scope-v1",
  repository: "o/r",
  objective: 1,
  workItem: 2,
  attempt: 1,
  runId: "source-run",
  directorEpoch: 1,
  policyDigest: "a".repeat(64),
  phase: "validation",
  commandIndex: 0,
  invocationDigest: "f".repeat(64),
  hostIdentity: "b".repeat(64),
};
function fixture() {
  const unit = localScopeUnit(identity);
  const fields = {
    Id: unit,
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "running",
    ControlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
    Job: "",
    InvocationID: "c".repeat(32),
    KillMode: "control-group",
  };
  const text = () =>
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  const show = vi.fn(async () => text());
  const read = vi.fn(
    async (path: string): Promise<string> =>
      path === "/proc/self/mountinfo"
        ? "31 20 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
        : "populated 0\nfrozen 0\n",
  );
  const hostIdentity = vi.fn(async () => identity.hostIdentity);
  const port: LocalScopeReadPort = {
    show,
    read,
    hostIdentity,
    now: () => new Date("2026-09-05T00:00:00Z"),
  };
  return { port, show, read, hostIdentity, fields, text };
}

describe("owned local scope boundary", () => {
  it("accepts a scope batch only on its exact reserved validation capacity", () => {
    const event = {
      protocol: "clockgrove.factory/v2",
      kind: "capacity",
      event: "CapacityReserved",
      objective: identity.objective,
      runId: identity.runId,
      workItem: identity.workItem,
      attempt: identity.attempt,
      directorEpoch: identity.directorEpoch,
      policyDigest: identity.policyDigest,
      phase: "validation",
      backend: "factory/local-validation",
      requestedCpu: 1,
      requestedMemoryMb: 512,
      sequence: 1,
      at: "2026-09-05T00:00:00Z",
      localScopeBatch: {
        identity,
        commandCount: 2,
        producerPid: 123,
        producerStartTicks: "456",
        deadline: "2026-09-05T00:01:00Z",
      },
    };
    expect(parseFactoryEvent(event)).toMatchObject({ localScopeBatch: event.localScopeBatch });
    for (const change of [
      { event: "CapacityReconciled" },
      { workItem: 55 },
      { phase: "execution" },
      { policyDigest: "e".repeat(64) },
      { runId: "other" },
      { recoveryEpoch: 2 },
      { at: "2026-09-05T00:02:00Z" },
    ])
      expect(() => parseFactoryEvent({ ...event, ...change })).toThrow();
    expect(() =>
      parseFactoryEvent({
        ...event,
        localScopeBatch: { ...event.localScopeBatch, commandCount: 0 },
      }),
    ).toThrow();
  });

  it("pins the scope to repository, run, attempt, epoch, phase, command, policy and host", () => {
    expect(localScopeUnit(identity)).toMatch(/^clockgrove-factory-work-[a-f0-9]{64}\.scope$/);
    for (const change of [
      { repository: "other/r" },
      { runId: "next-run" },
      { attempt: 2 },
      { directorEpoch: 2 },
      { phase: "execution" as const },
      { commandIndex: 1 },
      { invocationDigest: "e".repeat(64) },
      { policyDigest: "c".repeat(64) },
      { hostIdentity: "d".repeat(64) },
    ]) {
      expect(localScopeUnit({ ...identity, ...change })).not.toBe(localScopeUnit(identity));
    }
    expect(() => localScopeUnit({ ...identity, repository: "O/R" })).toThrow();
  });
  it("wraps the exact executable without shell interpolation or environment properties", () => {
    const result = scopedLocalCommand(identity, "/bin/worker", ["space here", "$(literal)"]);
    expect(result.command).toBe("systemd-run");
    expect(result.args.slice(-4)).toEqual(["--", "/bin/worker", "space here", "$(literal)"]);
    expect(result.args).toContain("--scope");
    expect(result.args).toContain("--expand-environment=no");
    expect(result.args).toContain("--description=Factory owned local command");
    expect(result.args.join(" ")).not.toContain("Environment=");
    expect(() => scopedLocalCommand(identity, "bad\0name", [])).toThrow();
  });
  it("observes exact empty cgroup evidence without enumerating process environments", async () => {
    const f = fixture();
    const result = await observeLocalScope(identity, f.port);
    expect(result).toMatchObject({
      status: "absent",
      reason: "scope-empty",
      unit: localScopeUnit(identity),
    });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.show).toHaveBeenCalledTimes(2);
    expect(f.read.mock.calls.map(([path]) => path)).toEqual([
      "/proc/self/mountinfo",
      `/sys/fs/cgroup${f.fields.ControlGroup}/cgroup.events`,
    ]);
  });
  it("requires a complete stable not-found result rather than treating query failure as absence", async () => {
    const f = fixture();
    Object.assign(f.fields, {
      LoadState: "not-found",
      ActiveState: "inactive",
      SubState: "dead",
      ControlGroup: "",
      InvocationID: "",
    });
    expect(await observeLocalScope(identity, f.port)).toMatchObject({
      status: "absent",
      reason: "scope-missing",
    });
    expect(f.read).not.toHaveBeenCalled();
    f.show.mockRejectedValueOnce(new Error("bus denied"));
    expect(await observeLocalScope(identity, f.port)).toMatchObject({
      status: "unknown",
      reason: "manager-unavailable",
    });
  });
  it.each(["host-unavailable", "host-mismatch"] as const)(
    "rejects %s before manager lookup",
    async (reason) => {
      const f = fixture();
      f.port.hostIdentity = async () => (reason === "host-unavailable" ? null : "e".repeat(64));
      expect(await observeLocalScope(identity, f.port)).toMatchObject({
        status: "unknown",
        reason,
      });
      expect(f.show).not.toHaveBeenCalled();
    },
  );
  it("retains a populated scope or a queued job as active", async () => {
    const f = fixture();
    f.read.mockImplementation(async (path) =>
      path === "/proc/self/mountinfo"
        ? "31 20 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
        : "populated 1\nfrozen 0\n",
    );
    expect(await observeLocalScope(identity, f.port)).toMatchObject({ status: "active" });
    f.fields.Job = "123 /org/freedesktop/systemd1/job/123";
    f.read.mockClear();
    expect(await observeLocalScope(identity, f.port)).toMatchObject({ status: "active" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["/", "/user.slice/../bad", "/other.scope"])(
    "rejects unsafe or foreign cgroup %s",
    async (path) => {
      const f = fixture();
      f.fields.ControlGroup = path;
      expect(await observeLocalScope(identity, f.port)).toMatchObject({ status: "unknown" });
      expect(f.read).not.toHaveBeenCalled();
    },
  );
  it("retains permission failures and malformed cgroup values as unknown", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("denied"));
    expect(await observeLocalScope(identity, f.port)).toMatchObject({ status: "unknown" });
    f.read.mockImplementation(async (path) =>
      path === "/proc/self/mountinfo"
        ? "31 20 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
        : "populated 0\npopulated 1\n",
    );
    expect(await observeLocalScope(identity, f.port)).toMatchObject({ status: "unknown" });
  });
  it("rejects changing invocation and host observations", async () => {
    const f = fixture();
    f.show
      .mockResolvedValueOnce(f.text())
      .mockResolvedValueOnce(f.text().replace("c".repeat(32), "d".repeat(32)));
    expect(await observeLocalScope(identity, f.port)).toMatchObject({
      status: "unknown",
      reason: "observation-changed",
    });
    f.hostIdentity
      .mockResolvedValueOnce(identity.hostIdentity)
      .mockResolvedValueOnce("e".repeat(64));
    expect(await observeLocalScope(identity, f.port)).toMatchObject({
      status: "unknown",
      reason: "observation-changed",
    });
  });
  it("rejects partial and duplicate property observations", async () => {
    const f = fixture();
    f.show.mockResolvedValueOnce("LoadState=not-found\n");
    expect(await observeLocalScope(identity, f.port)).toMatchObject({ status: "unknown" });
    f.show.mockResolvedValueOnce(`${f.text()}\nJob=0`);
    expect(await observeLocalScope(identity, f.port)).toMatchObject({ status: "unknown" });
  });
});
