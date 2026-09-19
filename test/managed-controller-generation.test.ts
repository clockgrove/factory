import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  observeManagedControllerGeneration,
  type ManagedControllerGenerationReadPort,
} from "../src/controller/managed-generation.js";

const executableIdentity = `sha256:${"a".repeat(64)}`;
const hostIdentity = "b".repeat(64);
const invocationId = "c".repeat(32);
const unit = "clockgrove-factory-0123456789abcdef.service";
const fragmentPath = `/home/test/.config/systemd/user/${unit}`;
const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
const config = Buffer.from(
  `# Managed by Clockgrove Factory\n[Service]\n# FactoryExecutableIdentity=${executableIdentity}\nKillMode=control-group\n`,
);
const observationInput = {
  expectedUnit: unit,
  expectedFragmentPath: fragmentPath,
  executableIdentity,
};

function stat(pid: number, startTicks = "456"): Buffer {
  return Buffer.from(
    `${pid} (factory controller) S ${[...Array(18)].map(() => "0").join(" ")} ${startTicks}\n`,
  );
}

function fixture() {
  const fields: Record<string, string> = {
    Id: unit,
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "running",
    Job: "",
    ControlGroup: group,
    InvocationID: invocationId,
    KillMode: "control-group",
    MainPID: "123",
    FragmentPath: fragmentPath,
    DropInPaths: "",
    NeedDaemonReload: "no",
  };
  const properties = () =>
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  const show = vi.fn(async () => properties());
  const host = vi.fn(async () => hostIdentity);
  const read = vi.fn(async (path: string): Promise<Buffer> => {
    if (path === "/proc/self/stat") return stat(123);
    if (path === "/proc/self/cgroup") return Buffer.from(`0::${group}\n`);
    if (path === fragmentPath) return config;
    throw new Error(`unexpected path ${path}`);
  });
  const port: ManagedControllerGenerationReadPort = {
    platform: "linux",
    pid: 123,
    hostIdentity: host,
    show,
    read,
  };
  return { fields, properties, show, host, read, port };
}

describe("managed controller generation", () => {
  it("binds the stable MainPID, host, invocation, cgroup, artifact, and exact unit bytes", async () => {
    const f = fixture();

    await expect(observeManagedControllerGeneration(observationInput, f.port)).resolves.toEqual({
      kind: "managed-service",
      hostIdentity,
      configDigest: createHash("sha256").update(config).digest("hex"),
      executableIdentity,
      unit,
      invocationId,
    });
    expect(f.show).toHaveBeenCalledTimes(2);
    expect(f.show).toHaveBeenCalledWith(unit);
    expect(f.host).toHaveBeenCalledTimes(2);
    expect(f.read.mock.calls.map(([path]) => path)).toEqual([
      "/proc/self/stat",
      "/proc/self/cgroup",
      fragmentPath,
      "/proc/self/stat",
      "/proc/self/cgroup",
      fragmentPath,
    ]);
  });

  it.each([
    ["Id", "clockgrove-factory-ffffffffffffffff.service"],
    ["LoadState", "not-found"],
    ["ActiveState", "activating"],
    ["SubState", "start"],
    ["Job", "19 /org/freedesktop/systemd1/job/19"],
    ["ControlGroup", `${group}/child`],
    ["InvocationID", "not-an-invocation"],
    ["KillMode", "process"],
    ["MainPID", "124"],
    ["FragmentPath", `/home/test/.config/systemd/user/other.service`],
    ["DropInPaths", "/home/test/.config/systemd/user/service.d/override.conf"],
    ["NeedDaemonReload", "yes"],
  ])("rejects an invalid %s manager property", async (property, value) => {
    const f = fixture();
    f.fields[property] = value;
    await expect(observeManagedControllerGeneration(observationInput, f.port)).resolves.toBeNull();
  });

  it.each([
    ["foreign cgroup", Buffer.from("0::/user.slice/foreign.service\n"), stat(123), hostIdentity],
    [
      "hybrid cgroups",
      Buffer.from(`0::${group}\n1:name=systemd:${group}\n`),
      stat(123),
      hostIdentity,
    ],
    ["foreign pid stat", Buffer.from(`0::${group}\n`), stat(124), hostIdentity],
    ["malformed start time", Buffer.from(`0::${group}\n`), stat(123, "nope"), hostIdentity],
    ["malformed host", Buffer.from(`0::${group}\n`), stat(123), "host"],
  ])("rejects %s evidence", async (_name, cgroup, processStat, host) => {
    const f = fixture();
    f.host.mockResolvedValue(host);
    f.read.mockImplementation(async (path: string) => {
      if (path === "/proc/self/stat") return processStat;
      if (path === "/proc/self/cgroup") return cgroup;
      if (path === fragmentPath) return config;
      throw new Error(`unexpected path ${path}`);
    });
    await expect(observeManagedControllerGeneration(observationInput, f.port)).resolves.toBeNull();
  });

  it("requires the installed unit bytes to bind the verified executable", async () => {
    const f = fixture();
    f.read.mockImplementation(async (path: string) => {
      if (path === "/proc/self/stat") return stat(123);
      if (path === "/proc/self/cgroup") return Buffer.from(`0::${group}\n`);
      if (path === fragmentPath)
        return Buffer.from(
          `# Managed by Clockgrove Factory\n# FactoryExecutableIdentity=sha256:${"d".repeat(64)}\n`,
        );
      throw new Error(`unexpected path ${path}`);
    });
    await expect(observeManagedControllerGeneration(observationInput, f.port)).resolves.toBeNull();
  });

  it.each(["manager", "process", "cgroup", "configuration", "host"])(
    "rejects a %s generation change during the proof",
    async (changed) => {
      const f = fixture();
      if (changed === "manager")
        f.show.mockResolvedValueOnce(f.properties()).mockImplementationOnce(async () => {
          f.fields.InvocationID = "d".repeat(32);
          return f.properties();
        });
      if (changed === "host")
        f.host.mockResolvedValueOnce(hostIdentity).mockResolvedValueOnce("d".repeat(64));
      if (["process", "cgroup", "configuration"].includes(changed)) {
        let targetReads = 0;
        f.read.mockImplementation(async (path: string) => {
          if (path === "/proc/self/stat") {
            targetReads += changed === "process" ? 1 : 0;
            return stat(123, changed === "process" && targetReads === 2 ? "457" : "456");
          }
          if (path === "/proc/self/cgroup") {
            targetReads += changed === "cgroup" ? 1 : 0;
            return Buffer.from(
              `0::${changed === "cgroup" && targetReads === 2 ? `${group}/child` : group}\n`,
            );
          }
          if (path === fragmentPath) {
            targetReads += changed === "configuration" ? 1 : 0;
            return changed === "configuration" && targetReads === 2
              ? Buffer.concat([config, Buffer.from("# changed\n")])
              : config;
          }
          throw new Error(`unexpected path ${path}`);
        });
      }
      await expect(
        observeManagedControllerGeneration(observationInput, f.port),
      ).resolves.toBeNull();
    },
  );

  it("rejects non-Factory inputs before consulting the host", async () => {
    const f = fixture();
    await expect(
      observeManagedControllerGeneration(
        { ...observationInput, expectedUnit: "foreign.service" },
        f.port,
      ),
    ).resolves.toBeNull();
    await expect(
      observeManagedControllerGeneration(
        { ...observationInput, executableIdentity: "sha256:invalid" },
        f.port,
      ),
    ).resolves.toBeNull();
    await expect(
      observeManagedControllerGeneration(
        { ...observationInput, expectedFragmentPath: "/tmp/foreign.service" },
        f.port,
      ),
    ).resolves.toBeNull();
    expect(f.host).not.toHaveBeenCalled();
  });

  it.each(["", "0", "0 /"])("accepts the supported no-job encoding %j", async (job) => {
    const f = fixture();
    f.fields.Job = job;
    await expect(observeManagedControllerGeneration(observationInput, f.port)).resolves.toEqual(
      expect.objectContaining({ invocationId }),
    );
  });
});
