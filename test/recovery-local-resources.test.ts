import { describe, expect, it, vi } from "vitest";
import { durableAttemptId, legacyDurableAttemptId } from "../src/execution/session.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import {
  localRecoveryResourceIdentityDigest,
  observeLocalRecoveryResource,
  readLocalResourceHostIdentity,
  type LocalResourceReader,
} from "../src/recovery/local-resources.js";

const identity = {
  repository: "owner/repo",
  objective: 7,
  workItem: 8,
  attempt: 1,
  runId: "source",
  directorEpoch: 1,
  phase: "execution" as const,
};
const stat = (pid: number, birth = "123") =>
  `${pid} (a ) process) S ${Array(18).fill("0").join(" ")} ${birth} 0 0`;
async function fixture() {
  const files = new Map<string, string>([
    ["/etc/machine-id", "1234567890abcdef1234567890abcdef\n"],
    ["/proc/sys/kernel/random/boot_id", "12345678-abcd-1234-abcd-1234567890ab\n"],
    ["/proc/self/mountinfo", "1 0 0:1 / /proc rw,nosuid - proc proc rw\n"],
  ]);
  const pids: number[] = [];
  const reader: LocalResourceReader = {
    platform: "linux",
    uid: 1000,
    read: vi.fn(async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("SECRET_PRIVATE_PATH");
      return Buffer.from(value);
    }),
    link: vi.fn(async (path) => `${path.split("/").at(-1)}:[123]`),
    pids: vi.fn(async () => [...pids]),
    now: () => new Date("2026-09-04T00:00:00Z"),
  };
  const add = (pid: number, environment = "PATH=/bin\0", uid = 1000) => {
    pids.push(pid);
    files.set(`/proc/${pid}/status`, `Name:\ttest\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    files.set(`/proc/${pid}/stat`, stat(pid));
    files.set(`/proc/${pid}/environ`, environment);
  };
  const host = (await readLocalResourceHostIdentity(reader))!;
  const input = { identity, expectedHostIdentity: host };
  return {
    files,
    pids,
    reader,
    add,
    input,
    resolve: () => observeLocalRecoveryResource(input, reader),
  };
}

describe("local successor resource observation", () => {
  it("proves a bounded same-host absence without leaking machine/user/process metadata", async () => {
    const f = await fixture();
    f.add(10, "PRIVATE_CREDENTIAL=secret\0");
    f.add(11, "", 2000);
    const observed = await f.resolve();
    expect(observed.status).toBe("absent");
    expect(observed.identityDigest).toBe(localRecoveryResourceIdentityDigest(f.input));
    expect(JSON.stringify(observed)).not.toMatch(/PRIVATE|secret|1234567890abcdef|1000/);
    f.reader.now = () => new Date("2026-09-05T00:00:00Z");
    expect((await f.resolve()).evidenceDigest).toBe(observed.evidenceDigest);
  });
  it("finds the exact original attempt marker and binds PID birth into opaque evidence", async () => {
    const f = await fixture();
    f.add(10, `SECRET=x\0FACTORY_ATTEMPT_ID=${durableAttemptId(identity)}\0`);
    const observed = await f.resolve();
    expect(observed.status).toBe("active");
    f.files.set("/proc/10/stat", stat(10, "124"));
    expect((await f.resolve()).evidenceDigest).not.toBe(observed.evidenceDigest);
  });
  it("does not confuse another repository's same-numbered attempt", async () => {
    const f = await fixture();
    f.add(
      10,
      `FACTORY_ATTEMPT_ID=${durableAttemptId({ ...identity, repository: "other/repo" })}\0`,
    );
    expect((await f.resolve()).status).toBe("absent");
  });
  it.each(["pid", "user", "mnt", "boot", "machine", "uid"])(
    "rejects changed %s host binding",
    async (kind) => {
      const f = await fixture();
      if (["pid", "user", "mnt"].includes(kind))
        f.reader.link = async (path) =>
          `${path.split("/").at(-1)}:[${path.endsWith(kind) ? 124 : 123}]`;
      if (kind === "boot")
        f.files.set("/proc/sys/kernel/random/boot_id", "12345678-abcd-1234-abcd-1234567890ac");
      if (kind === "machine") f.files.set("/etc/machine-id", "1234567890abcdef1234567890abcdee");
      if (kind === "uid") f.reader.uid = 1001;
      expect((await f.resolve()).status).toBe("unknown");
    },
  );
  it("keeps legacy/missing host binding and unsupported validation unknown", async () => {
    const f = await fixture();
    expect(
      (await observeLocalRecoveryResource({ ...f.input, expectedHostIdentity: null }, f.reader))
        .reason,
    ).toBe("host-unbound");
    expect(
      (
        await observeLocalRecoveryResource(
          { ...f.input, identity: { ...identity, phase: "validation" } },
          f.reader,
        )
      ).status,
    ).toBe("unknown");
    expect(vi.mocked(f.reader.pids)).not.toHaveBeenCalled();
  });
  it.each([
    "linux-unavailable",
    "missing-machine",
    "hidden-proc",
    "unreadable-owner",
    "unreadable-environment",
    "oversized-environment",
    "too-many-pids",
    "process-churn",
    "pid-reuse-during-read",
  ])("fails closed for %s", async (kind) => {
    const f = await fixture();
    f.add(10);
    if (kind === "linux-unavailable") f.reader.platform = "darwin";
    if (kind === "missing-machine") f.files.delete("/etc/machine-id");
    if (kind === "hidden-proc")
      f.files.set("/proc/self/mountinfo", "1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n");
    if (kind === "unreadable-owner") f.files.delete("/proc/10/status");
    if (kind === "unreadable-environment") f.files.delete("/proc/10/environ");
    if (kind === "oversized-environment") f.files.set("/proc/10/environ", "x".repeat(262_145));
    if (kind === "too-many-pids")
      f.reader.pids = async () => Array.from({ length: 16_385 }, (_, i) => i + 1);
    if (kind === "process-churn")
      vi.mocked(f.reader.pids).mockResolvedValueOnce([10]).mockResolvedValueOnce([10, 11]);
    if (kind === "pid-reuse-during-read") {
      const read = f.reader.read;
      let calls = 0;
      f.reader.read = async (path, limit) =>
        path === "/proc/10/stat" ? Buffer.from(stat(10, String(++calls))) : read(path, limit);
    }
    const observed = await f.resolve();
    expect(observed.status).toBe("unknown");
    expect(JSON.stringify(observed)).not.toContain("SECRET_PRIVATE_PATH");
  });
  it.each([legacyDurableAttemptId(identity), "factory-o7-w8-a1-source"])(
    "refuses legacy marker %s",
    async (marker) => {
      const f = await fixture();
      f.add(10, `FACTORY_ATTEMPT_ID=${marker}\0`);
      expect((await f.resolve()).reason).toBe("legacy-marker");
    },
  );
  it("does not declare a reused hinted PID absent even when its current marker differs", async () => {
    const f = await fixture();
    f.add(10);
    expect(
      (
        await observeLocalRecoveryResource(
          { ...f.input, identity: { ...identity, providerResourceId: "local-10" } },
          f.reader,
        )
      ).reason,
    ).toBe("pid-reused");
  });
  it("accepts missing original PID only after the complete marker scan", async () => {
    const f = await fixture();
    f.add(11);
    const local = await observeLocalRecoveryResource(
      { ...f.input, identity: { ...identity, providerResourceId: "local-10" } },
      f.reader,
    );
    expect(local.status).toBe("absent");
    const sdk = await observeLocalRecoveryResource(
      {
        ...f.input,
        identity: {
          ...identity,
          providerResourceId: `sdk-${durableAttemptId(identity).slice(0, 24)}`,
        },
      },
      f.reader,
    );
    expect(sdk.status).toBe("absent");
  });
  it("retains only valid hashed host identity on parsed attempt receipts", async () => {
    const f = await fixture();
    const event = {
      protocol: "clockgrove.factory/v2",
      kind: "attempt",
      event: "AttemptStarted",
      objective: 7,
      workItem: 8,
      attempt: 1,
      runId: "source",
      sequence: 1,
      at: "2026-09-04T00:00:00Z",
      backend: "codex-cli/local-worktree",
      baseSha: "a".repeat(40),
      directorEpoch: 1,
      policyDigest: "a".repeat(64),
      resourceHostIdentity: f.input.expectedHostIdentity,
    };
    expect(parseFactoryEvent(event)).toMatchObject({
      resourceHostIdentity: f.input.expectedHostIdentity,
    });
    expect(() => parseFactoryEvent({ ...event, resourceHostIdentity: "raw-machine-id" })).toThrow();
  });
});
