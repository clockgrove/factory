import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { boundedPolicy } from "../scripts/verify-live-objective.mjs";
import {
  pressureAuthority,
  assertPressureRun,
  assertPressureReadmission,
  pressureReadmissionDeadline,
  main,
} from "../scripts/verify-local-pressure.mjs";
import {
  PRESSURE_BOUNDS,
  MB,
  pressureSlice,
  pressureMemory,
  pressureLaunch,
  observePressureSlice,
  observePressureResource,
  stopPressureResource,
  assertPressureHeadroom,
  pressureSliceOverrides,
} from "../scripts/local-pressure-resource.mjs";

const unit = `clockgrove-factory-qualification-${"a".repeat(64)}.service`;

describe("pressure readmission observation deadline", () => {
  it("allows healthy admission after the 120-second cooldown and subsequent idle polling", () => {
    const released = "2026-09-06T00:00:00.000Z";
    const deadline = pressureReadmissionDeadline(released, 120);
    expect(deadline).toBe(Date.parse(released) + 240_000);
    // A healthy next idle tick plus a durable receipt can arrive beyond the old 120s window.
    expect(Date.parse(released) + 180_000 + 15_000).toBeLessThan(deadline);
    expect(() => pressureReadmissionDeadline(released, 600)).toThrow(/unexpected accepted/);
    expect(() => pressureReadmissionDeadline("not a timestamp", 120)).toThrow(/timestamp/);
  });
});
const primaryUnit = `clockgrove-factory-qualification-${"b".repeat(64)}.service`;
const sliceUnit = pressureSlice(primaryUnit);
const cgroup = `/user.slice/user-1000.slice/user@1000.service/${sliceUnit}`;
const identity = {
  unit,
  node: "/usr/bin/node",
  bundle: "/repo/scripts/local-pressure-allocator.mjs",
  checkout: "/repo",
  invocationId: "c".repeat(32),
  pid: 4321,
  startTicks: "12345",
  bootDigest: createHash("sha256").update("boot").digest("hex"),
  cgroup: `${cgroup}/${unit}`,
};

function kernelFixture() {
  let stopped = false;
  const fields: Record<string, string> = {
    Id: unit,
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "running",
    Job: "",
    InvocationID: identity.invocationId,
    ControlGroup: identity.cgroup,
    MainPID: String(identity.pid),
    KillMode: "control-group",
    Type: "exec",
    Restart: "no",
    RuntimeMaxUSec: "2min",
    RuntimeRandomizedExtraUSec: "0",
    TimeoutStopUSec: "2s",
  };
  const files: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": "boot",
    [`/proc/${identity.pid}/stat`]: `${identity.pid} (node) ${["S", ...Array(18).fill("0"), identity.startTicks].join(" ")}`,
    [`/proc/${identity.pid}/cmdline`]: `${identity.node}\0${identity.bundle}\0`,
    [`/proc/${identity.pid}/cgroup`]: `0::${identity.cgroup}\n`,
    "/proc/meminfo": "MemFree: 8388608 kB\n",
  };
  const memory = (path: string, max: number | "max", current: number, cpu: string) => {
    Object.assign(files, {
      [`/sys/fs/cgroup${path}/memory.max`]: String(max),
      [`/sys/fs/cgroup${path}/memory.current`]: String(current),
      [`/sys/fs/cgroup${path}/memory.swap.max`]: "0",
      [`/sys/fs/cgroup${path}/memory.events`]: "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
      [`/sys/fs/cgroup${path}/cpu.max`]: cpu,
      [`/sys/fs/cgroup${path}/cpu.stat`]: "usage_usec 1000\nuser_usec 500\nsystem_usec 500\n",
      [`/sys/fs/cgroup${path}/cgroup.procs`]: "",
    });
  };
  memory(
    identity.cgroup,
    PRESSURE_BOUNDS.pressureBytes,
    PRESSURE_BOUNDS.allocationBytes + 32 * MB,
    "25000 100000",
  );
  memory(cgroup, PRESSURE_BOUNDS.sliceBytes, 100 * MB, "400000 100000");
  for (const path of [
    "/user.slice",
    "/user.slice/user-1000.slice",
    "/user.slice/user-1000.slice/user@1000.service",
  ])
    memory(path, "max", 1024 * MB, "max 100000");
  files[`/sys/fs/cgroup${identity.cgroup}/cgroup.procs`] = String(identity.pid);
  files[`/sys/fs/cgroup${identity.cgroup}/pids.max`] = "32";
  const port = {
    exec: vi.fn((_command: string, args: string[]) => {
      if (args[1] === "stop") {
        stopped = true;
        return "";
      }
      const observed: Record<string, string> =
        args[2] === sliceUnit ? { ...fields, Id: sliceUnit, ControlGroup: cgroup } : fields;
      const values: Record<string, string> = stopped
        ? {
            ...observed,
            LoadState: "not-found",
            ActiveState: "inactive",
            SubState: "dead",
            MainPID: "0",
            InvocationID: "",
            ControlGroup: "",
            Job: "",
          }
        : observed;
      return args[3]!
        .slice("--property=".length)
        .split(",")
        .map((key) => `${key}=${values[key] ?? ""}`)
        .join("\n");
    }),
    read: vi.fn((path: string) => {
      if (!(path in files)) throw Error(`unavailable kernel observation ${path}`);
      return files[path]!;
    }),
    link: (path: string) => (path.endsWith("/exe") ? identity.node : identity.checkout),
    children: vi.fn((path: string) => (path === `/sys/fs/cgroup${cgroup}` ? [unit] : [])),
    inode: vi.fn(() => (stopped ? null : "123")),
    now: () => "2026-09-05T00:01:00.000Z",
    wait: vi.fn(async () => {}),
  };
  return { port, fields, files };
}

describe("pressure authority and bounds", () => {
  const env = {
    FACTORY_LIVE_LOCAL_PRESSURE: "1",
    FACTORY_LIVE_OBJECTIVE: "1",
    FACTORY_LIVE_OBJECTIVE_REPOSITORY: "example/disposable",
    FACTORY_LIVE_OBJECTIVE_NAMESPACE: "pressure-test",
    FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "500000",
    FACTORY_LIVE_LOCAL_PRESSURE_ACK:
      "example/disposable:owned-memory-pressure-cooldown-readmission",
  };
  it("requires the separately named opt-in before any installed execution", async () => {
    const run = vi.fn();
    await main({}, run);
    expect(run).not.toHaveBeenCalled();
    expect(() =>
      pressureAuthority({ ...env, FACTORY_LIVE_LOCAL_PRESSURE_ACK: "example/disposable" }),
    ).toThrow();
    expect(() => pressureAuthority({ ...env, FACTORY_LIVE_LOCAL_SCHEDULING: "1" })).toThrow();
  });
  it("selects a measurable initial cooldown and preserves every other original bound", () => {
    const policy = boundedPolicy("regular-prs", 500000) as {
      capacity: { local: { admissionCooldownSeconds: number } };
    };
    const expected = {
      ...policy,
      capacity: {
        ...policy.capacity,
        local: { ...policy.capacity.local, admissionCooldownSeconds: 120 },
      },
    };
    expect(pressureAuthority(env)?.policy).toEqual(expected);
    expect(policy.capacity.local.admissionCooldownSeconds).toBe(10);
    expect(() => pressureAuthority({ ...env, GH_TOKEN: "must-not-propagate" })).toThrow();
  });
  it("launches only a literal exact capped disposable resource, never a shell or ambient secret", () => {
    const args = pressureLaunch(identity, sliceUnit);
    expect(args).toContain("--property=RuntimeMaxSec=120s");
    expect(args).toContain("--property=CPUQuota=25%");
    expect(args).toContain(`--property=MemoryMax=${PRESSURE_BOUNDS.pressureBytes}`);
    expect(args).toContain("--property=MemorySwapMax=0");
    expect(args.slice(-4)).toEqual(["/usr/bin/env", "-i", identity.node, identity.bundle]);
    expect(() => pressureLaunch({ ...identity, unit: "unrelated.service" }, sliceUnit)).toThrow();
    expect(() => pressureLaunch(identity, "user.slice")).toThrow();
    expect(() => pressureLaunch({ ...identity, bundle: "/tmp/$(wrong)" }, sliceUnit)).toThrow();
  });
});

describe("independent physical pressure observations", () => {
  it("binds the service, process birth, executable, cgroup, hard limits and runtime", () => {
    const { port } = kernelFixture();
    expect(observePressureResource(identity, { cgroup }, port)).toMatchObject({
      state: "active",
      effectiveCpu: 0.25,
    });
  });
  it.each([
    ["InvocationID", "d".repeat(32)],
    ["MainPID", "4322"],
    ["KillMode", "process"],
    ["Restart", "always"],
    ["RuntimeMaxUSec", "infinity"],
    ["RuntimeRandomizedExtraUSec", "1min"],
    ["TimeoutStopUSec", "90s"],
  ])("refuses a drifted %s before stopping anything", async (key, value) => {
    const { port, fields } = kernelFixture();
    fields[key] = value;
    await expect(stopPressureResource(identity, { cgroup }, port)).rejects.toThrow();
    expect(port.exec.mock.calls.some(([, args]) => args[1] === "stop")).toBe(false);
  });
  it.each([
    ["memory.max", "max"],
    ["memory.swap.max", "1"],
    ["cpu.max", "100000 100000"],
    ["memory.events", "max 0\noom 0\noom_kill 1"],
    ["pids.max", "max"],
    ["cgroup.procs", "4321\n777"],
  ])("rejects unbounded or unsafe kernel %s", (name, value) => {
    const { port, files } = kernelFixture();
    files[`/sys/fs/cgroup${identity.cgroup}/${name}`] = value;
    expect(() => observePressureResource(identity, { cgroup }, port)).toThrow();
  });
  it("stops the exact captured service once and independently proves process/cgroup absence", async () => {
    const { port } = kernelFixture();
    expect(await stopPressureResource(identity, { cgroup }, port)).toMatchObject({
      state: "absent",
      unit,
    });
    expect(port.exec.mock.calls.filter(([, args]) => args[1] === "stop")).toEqual([
      ["systemctl", ["--user", "stop", unit]],
    ]);
  });
  it("never repeats an uncertain stop", async () => {
    const { port } = kernelFixture();
    const exec = port.exec;
    const uncertain = {
      ...port,
      exec: vi.fn((command: string, args: string[]) => {
        if (args[1] === "stop") throw Error("uncertain stop response");
        return exec(command, args);
      }),
    };
    await expect(stopPressureResource(identity, { cgroup }, uncertain)).rejects.toThrow(
      /uncertain/,
    );
    expect(uncertain.exec.mock.calls.filter(([, args]) => args[1] === "stop")).toHaveLength(1);
  });
  it("rejects slice replacement or unexpected child resources", () => {
    const { port } = kernelFixture();
    expect(() =>
      observePressureSlice({ unit: sliceUnit, inode: "different" }, [unit], port),
    ).toThrow();
    expect(() => observePressureSlice({ unit: sliceUnit }, [], port)).toThrow(/unowned resource/);
  });
  it("does not promote a missing cgroup read or reused PID to a safe pressure observation", () => {
    const { port, files } = kernelFixture();
    delete files[`/sys/fs/cgroup${identity.cgroup}/memory.current`];
    expect(() => observePressureResource(identity, { cgroup }, port)).toThrow(/unavailable/);
    files[`/sys/fs/cgroup${identity.cgroup}/memory.current`] = String(
      PRESSURE_BOUNDS.allocationBytes,
    );
    files[`/proc/${identity.pid}/stat`] = files[`/proc/${identity.pid}/stat`]!.replace(
      "12345",
      "12346",
    );
    expect(() => observePressureResource(identity, { cgroup }, port)).toThrow(/reused/);
  });
  it("requires readable host and every visible ancestor's spare memory before allocation", () => {
    const { port, files } = kernelFixture();
    const slice = pressureMemory(cgroup, port);
    expect(assertPressureHeadroom(slice, port)).toHaveProperty("ancestors");
    files["/sys/fs/cgroup/user.slice/memory.max"] = String(2048 * MB);
    expect(() => assertPressureHeadroom(slice, port)).toThrow(/ancestor/);
    files["/sys/fs/cgroup/user.slice/memory.max"] = "max";
    files["/proc/meminfo"] = "MemFree: 1024 kB\n";
    expect(() => assertPressureHeadroom(slice, port)).toThrow(/host memory/);
    expect(() =>
      assertPressureHeadroom({ ...slice, memoryCurrent: 300 * MB }, kernelFixture().port),
    ).toThrow(/baseline/);
  });
  it("refuses cleanup of non-owned drop-ins or a newly supplied unit file", () => {
    const { port, fields } = kernelFixture();
    fields.FragmentPath = "/etc/systemd/user/foreign.slice";
    fields.DropInPaths = "/tmp/unowned.conf";
    expect(() => pressureSliceOverrides({ unit: sliceUnit }, 1000, port)).toThrow();
    fields.FragmentPath = "";
    expect(() => pressureSliceOverrides({ unit: sliceUnit }, 1000, port)).toThrow(
      /unowned override/,
    );
  });
});

function progression() {
  const policy = boundedPolicy("regular-prs", 500000);
  const common = { runId: "run", policyDigest: "e".repeat(64), workItem: 2, kind: "scheduling" };
  const pressure = {
    ...common,
    event: "WorkItemQueued",
    reasonCode: "local-pressure",
    reason: "local-pressure: memory pressure exceeds policy ceiling",
    sequence: 5,
    at: "2026-09-05T00:00:00Z",
  };
  const cooldown = {
    ...common,
    event: "WorkItemQueued",
    reasonCode: "local-cooldown",
    reason: "local-cooldown: local admission cooldown lasts until 2026-09-05T00:02:00.000Z",
    sequence: 6,
    at: "2026-09-05T00:01:00Z",
  };
  const admission = {
    ...common,
    event: "AttemptReserved",
    kind: "attempt",
    sequence: 7,
    attempt: 1,
    capacityMeasuredAt: "2026-09-05T00:02:01Z",
    effectiveCpu: 4,
    availableMemoryMb: 3800,
    requestedMemoryMb: 2048,
    memoryUsageRatio: 0.1,
    loadRatio: 0.1,
  };
  const proof = {
    runId: common.runId,
    policyDigest: common.policyDigest,
    roots: [2, 3],
    barrierSequence: 4,
    primary: { ...identity, effectiveCpu: 0.5 },
    released: { ...identity, effectiveCpu: 4 },
    resource: identity,
    slice: { unit: sliceUnit, cgroup, inode: "123", bootDigest: identity.bootDigest },
    measuredPressure: {
      slice: {
        unit: sliceUnit,
        cgroup,
        inode: "123",
        bootDigest: identity.bootDigest,
        memoryCurrent: 3700 * MB,
        memoryMax: PRESSURE_BOUNDS.sliceBytes,
        cpu: 4,
        swapMax: 0,
      },
      resource: {
        ...identity,
        memory: {
          memoryCurrent: PRESSURE_BOUNDS.allocationBytes,
          memoryMax: PRESSURE_BOUNDS.pressureBytes,
          swapMax: 0,
          cpu: 0.25,
        },
      },
    },
    pressureAbsent: {
      unit,
      bootDigest: identity.bootDigest,
      state: "absent",
      observedAt: "2026-09-05T00:00:15Z",
    },
  };
  return { policy, pressure, cooldown, admission, proof, events: [pressure, cooldown, admission] };
}

describe("real receipt pressure/cooldown/readmission contract", () => {
  // Only the reason text is captured from the original installed run (#124).
  // The surrounding deterministic fixture is not a replacement runtime receipt.
  const capturedReason =
    "local-cooldown: local admission cooldown lasts until 2026-09-06T10:18:53.472Z; paid burst is disabled";
  const capturedProgression = () => {
    const input = progression();
    input.pressure.at = "2026-09-06T10:16:53.000Z";
    input.cooldown.at = "2026-09-06T10:18:03.000Z";
    input.cooldown.reason = capturedReason;
    input.proof.pressureAbsent.observedAt = "2026-09-06T10:17:01.000Z";
    input.admission.capacityMeasuredAt = "2026-09-06T10:18:54.000Z";
    return input;
  };
  it("accepts the captured local-only reason without changing its exact deadline", () => {
    const input = capturedProgression();
    expect(assertPressureReadmission(input.events, input.proof, input.policy)).toMatchObject({
      cooldownUntil: "2026-09-06T10:18:53.472Z",
      firstAdmission: input.admission,
    });
  });
  it.each([
    { capacityMeasuredAt: "2026-09-06T10:18:53.471Z" },
    { sequence: 5 },
    { runId: "other" },
    { policyDigest: "f".repeat(64) },
  ])("keeps timing, order and identity fences for the captured reason %j", (change) => {
    const input = capturedProgression();
    Object.assign(input.admission, change);
    expect(() => assertPressureReadmission(input.events, input.proof, input.policy)).toThrow();
  });
  it.each([
    capturedReason.replace("2026-09-06", "2026-02-30"),
    capturedReason.replace("10:18:53.472Z", "25:18:53.472Z"),
    capturedReason.replace(".472Z", "Z"),
    capturedReason.replace(".472Z", ".472+00:00"),
    capturedReason.replace("paid burst is disabled", "paid burst is enabled"),
    `${capturedReason}; arbitrary trailing content`,
    `${capturedReason}; paid burst is disabled`,
    `${capturedReason}\n`,
    capturedReason.replace("local-cooldown:", "local-pressure:"),
  ])("rejects malformed or unrelated cooldown reason %j", (reason) => {
    const input = capturedProgression();
    input.cooldown.reason = reason;
    expect(() => assertPressureReadmission(input.events, input.proof, input.policy)).toThrow(
      /deadline|timestamp/,
    );
  });
  it("requires both distinct real reasons followed by first-attempt safe fresh admission", () => {
    const input = progression();
    expect(assertPressureReadmission(input.events, input.proof, input.policy)).toHaveProperty(
      "firstAdmission",
    );
  });
  it.each(["pressure", "cooldown"] as const)(
    "cannot substitute capacity or fabricated absence for %s",
    (name) => {
      const input = progression();
      input[name].reasonCode = "local-capacity";
      expect(() => assertPressureReadmission(input.events, input.proof, input.policy)).toThrow();
    },
  );
  it.each([
    { sequence: 5 },
    { attempt: 2 },
    { capacityMeasuredAt: "2026-09-05T00:01:59Z" },
    { capacityMeasuredAt: "invalid" },
    { effectiveCpu: 0.5 },
    { availableMemoryMb: 2000 },
    { memoryUsageRatio: 0.9 },
    { loadRatio: 2 },
    { runId: "other" },
    { policyDigest: "f".repeat(64) },
  ])("rejects early, unsafe, stale or transplanted readmission %j", (change) => {
    const input = progression();
    Object.assign(input.admission, change);
    expect(() => assertPressureReadmission(input.events, input.proof, input.policy)).toThrow();
  });
  it("rejects claimed pressure with no actual owned allocation or missing cleanup", () => {
    const input = progression();
    input.proof.measuredPressure.resource.memory.memoryCurrent = 0;
    expect(() => assertPressureReadmission(input.events, input.proof, input.policy)).toThrow(
      /charge/,
    );
    input.proof.measuredPressure.resource.memory.memoryCurrent = PRESSURE_BOUNDS.allocationBytes;
    input.proof.pressureAbsent.state = "active";
    expect(() => assertPressureReadmission(input.events, input.proof, input.policy)).toThrow();
  });
  it.each(["", "; paid burst is disabled"])(
    "does not ignore a later observed cooldown deadline %s",
    (suffix) => {
      const input = progression();
      const later = {
        ...input.cooldown,
        sequence: 7,
        reason: `local-cooldown: local admission cooldown lasts until 2026-09-05T00:03:00.000Z${suffix}`,
      };
      input.admission.sequence = 8;
      expect(() =>
        assertPressureReadmission([...input.events, later], input.proof, input.policy),
      ).toThrow(/later observed/);
    },
  );
  it("never accepts a successor policy or a terminal original run as injection authority", () => {
    const { policy } = progression();
    const start = {
      event: "FactoryRunStarted",
      objective: 1,
      policy,
      runId: "run",
      policyDigest: "e".repeat(64),
    };
    const observation = {
      receipts: [{ event: start }],
      status: { operation: "status", objective: { number: 1 }, run: { runId: "run" } },
    };
    expect(() => assertPressureRun(observation, { policy }, 1, "other")).toThrow();
    expect(() =>
      assertPressureRun(observation, { policy: boundedPolicy("regular-prs", 250000) }, 1, "run"),
    ).toThrow();
    expect(() =>
      assertPressureRun(
        {
          ...observation,
          receipts: [
            ...observation.receipts,
            { event: { event: "FactoryRunEscalated", runId: "run" } },
          ],
        },
        { policy },
        1,
        "run",
      ),
    ).toThrow();
  });
});
