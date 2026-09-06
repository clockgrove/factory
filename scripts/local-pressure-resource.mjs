/** Narrow, disposable Linux pressure fixture. No import-time I/O or allocation. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { observeSchedulingService } from "./verify-local-scheduling.mjs";

export const MB = 1048576;
export const PRESSURE_BOUNDS = Object.freeze({
  sliceBytes: 4096 * MB,
  allocationBytes: 3584 * MB,
  pressureBytes: 3840 * MB,
  minimumHostFreeBytes: 6144 * MB,
  baselineMaximumBytes: 256 * MB,
  emergencyHeadroomBytes: 128 * MB,
  pressureCpu: 0.25,
  durationSeconds: 120,
});
const slicePattern = /^factorypressure[a-f0-9]{64}\.slice$/;
const servicePattern = /^clockgrove-factory-qualification-[a-f0-9]{64}\.service$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export const pressurePort = {
  exec(command, args) {
    try {
      return execFileSync(command, args, {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (error) {
      if (
        command === "systemctl" &&
        args[1] === "show" &&
        error.status === 1 &&
        typeof error.stdout === "string" &&
        error.stdout.length < 65536
      )
        return error.stdout.trim();
      throw Error("owned pressure resource operation unavailable; no retry");
    }
  },
  read: (path) => readFileSync(path, "utf8"),
  link: (path) => readlinkSync(path),
  children: (path) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
  inode: (path) => {
    try {
      return String(statSync(path, { bigint: true }).ino);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  },
  now: () => new Date().toISOString(),
  wait: (milliseconds) => sleep(milliseconds),
};

export function pressureSlice(unit) {
  assert.match(unit, servicePattern);
  return `factorypressure${digest(unit)}.slice`;
}

export function pressureProperties(unit, names, port = pressurePort) {
  const result = {};
  for (const line of port
    .exec("systemctl", ["--user", "show", unit, `--property=${names.join(",")}`])
    .split("\n")) {
    const split = line.indexOf("=");
    assert.ok(split > 0 && !Object.hasOwn(result, line.slice(0, split)), "malformed unit readback");
    result[line.slice(0, split)] = line.slice(split + 1);
  }
  for (const name of names) assert.ok(Object.hasOwn(result, name), `missing ${name} observation`);
  return result;
}

function bytes(value, unlimited = false) {
  if (unlimited && value.trim() === "max") return null;
  assert.match(value.trim(), /^\d+$/);
  const number = Number(value.trim());
  assert.ok(Number.isSafeInteger(number) && number >= 0, "invalid kernel byte observation");
  return number;
}

export function pressureMemory(cgroup, port = pressurePort) {
  assert.match(cgroup, /^\/[A-Za-z0-9_.@:/-]+$/);
  assert.ok(!cgroup.split("/").includes(".."));
  const root = `/sys/fs/cgroup${cgroup}`;
  const events = {};
  for (const line of port.read(`${root}/memory.events`).trim().split("\n")) {
    const [name, value, extra] = line.split(/\s+/);
    assert.ok(!extra && !Object.hasOwn(events, name));
    events[name] = bytes(value);
  }
  for (const name of ["oom", "oom_kill", "max"])
    assert.equal(events[name], 0, "pressure fixture hit a hard memory boundary");
  const cpuRaw = port.read(`${root}/cpu.max`).trim();
  const [quota, period, extra] = cpuRaw.split(/\s+/);
  assert.ok(!extra && bytes(period) > 0);
  const cpu = quota === "max" ? null : bytes(quota) / bytes(period);
  assert.ok(cpu === null || cpu > 0);
  const usage = /^usage_usec (\d+)$/m.exec(port.read(`${root}/cpu.stat`));
  assert.ok(usage, "actual CPU usage observation unavailable");
  return {
    cgroup,
    inode: port.inode(root),
    memoryMax: bytes(port.read(`${root}/memory.max`), true),
    memoryCurrent: bytes(port.read(`${root}/memory.current`)),
    swapMax: bytes(port.read(`${root}/memory.swap.max`), true),
    cpu,
    cpuRaw,
    cpuUsageUsec: bytes(usage[1]),
    events,
    observedAt: port.now(),
  };
}

export function pressureInputs(primary, port = pressurePort) {
  const meminfo = port.read("/proc/meminfo");
  const loadavg = port.read("/proc/loadavg");
  assert.ok(meminfo.length < 16384 && loadavg.length < 1024);
  const allowed = /^Cpus_allowed_list:\s+([0-9,-]+)$/m.exec(
    port.read(`/proc/${primary.pid}/status`),
  );
  assert.ok(allowed, "Director CPU affinity observation unavailable");
  const cgroups = [];
  for (let path = primary.cgroup; path !== "/"; path = dirname(path)) {
    assert.ok(cgroups.length < 32);
    cgroups.push(pressureMemory(path, port));
  }
  return { meminfo, loadavg, cpuAllowedList: allowed[1], cgroups, observedAt: port.now() };
}

export function observePressureSlice(expected, allowed, port = pressurePort, capped = true) {
  assert.match(expected.unit, slicePattern);
  for (const unit of allowed) assert.match(unit, servicePattern);
  const fields = pressureProperties(
    expected.unit,
    ["Id", "LoadState", "ActiveState", "SubState", "ControlGroup", "Job"],
    port,
  );
  assert.equal(fields.Id, expected.unit);
  const bootDigest = digest(port.read("/proc/sys/kernel/random/boot_id").trim());
  if (expected.bootDigest) assert.equal(bootDigest, expected.bootDigest);
  if (
    ["not-found", "loaded"].includes(fields.LoadState) &&
    fields.ActiveState === "inactive" &&
    fields.SubState === "dead" &&
    fields.ControlGroup === "" &&
    ["", "0", "0 /"].includes(fields.Job)
  ) {
    // systemd can load an implicit slice with no unit file merely by resolving its
    // name. Cold implicit metadata is not a running cgroup or an owned override.
    const configuration = pressureProperties(expected.unit, ["FragmentPath", "DropInPaths"], port);
    assert.equal(configuration.FragmentPath, "", "slice has a preexisting unit definition");
    assert.equal(configuration.DropInPaths, "", "slice has retained runtime overrides");
    if (expected.cgroup) assert.equal(port.inode(`/sys/fs/cgroup${expected.cgroup}`), null);
    return { ...expected, bootDigest, state: "absent", observedAt: port.now() };
  }
  assert.equal(fields.LoadState, "loaded");
  assert.equal(fields.ActiveState, "active");
  assert.ok(fields.ControlGroup.endsWith(`/${expected.unit}`));
  const memory = pressureMemory(fields.ControlGroup, port);
  assert.ok(memory.inode);
  if (expected.inode) {
    assert.equal(memory.inode, expected.inode, "slice cgroup incarnation changed");
    assert.equal(memory.cgroup, expected.cgroup);
  }
  assert.equal(
    port.read(`/sys/fs/cgroup${memory.cgroup}/cgroup.procs`).trim(),
    "",
    "slice has an unowned direct process",
  );
  const children = port.children(`/sys/fs/cgroup${memory.cgroup}`);
  assert.ok(
    children.every((name) => allowed.includes(name)),
    "slice contains an unowned resource",
  );
  if (capped) {
    assert.equal(memory.memoryMax, PRESSURE_BOUNDS.sliceBytes);
    assert.equal(memory.swapMax, 0);
    assert.equal(memory.cpu, 4);
  }
  return { unit: expected.unit, bootDigest, state: "active", ...memory, children };
}

/** Refuses insufficient host/ancestor headroom before allocating anything. */
export function assertPressureHeadroom(slice, port = pressurePort) {
  const info = port.read("/proc/meminfo");
  const free = /^MemFree:\s+(\d+) kB$/m.exec(info);
  assert.ok(free, "host free-memory observation unavailable");
  const hostFreeBytes = Number(free[1]) * 1024;
  assert.ok(
    hostFreeBytes >= PRESSURE_BOUNDS.minimumHostFreeBytes,
    "pressure prerequisite unavailable: at least 6 GiB of actually free host memory required",
  );
  const ancestors = [];
  for (let path = dirname(slice.cgroup); path !== "/"; path = dirname(path)) {
    assert.ok(ancestors.length < 32, "unbounded cgroup ancestry");
    const observed = pressureMemory(path, port);
    if (observed.memoryMax !== null)
      assert.ok(
        observed.memoryMax - observed.memoryCurrent >= PRESSURE_BOUNDS.minimumHostFreeBytes,
        "pressure prerequisite unavailable: ancestor has less than 6 GiB headroom",
      );
    assert.ok(
      observed.cpu === null || observed.cpu >= 4,
      "ancestor cannot admit the final workload",
    );
    ancestors.push(observed);
  }
  assert.ok(
    slice.memoryCurrent <= PRESSURE_BOUNDS.baselineMaximumBytes,
    "pressure prerequisite unavailable: disposable baseline exceeds 256 MiB",
  );
  return { hostFreeBytes, ancestors, observedAt: port.now() };
}

export function pressureLaunch(identity, slice) {
  assert.match(identity.unit, servicePattern);
  assert.match(slice, slicePattern);
  for (const path of [identity.node, identity.bundle, identity.checkout])
    assert.match(path, /^\/[A-Za-z0-9_./-]+$/);
  return [
    "--user",
    "--collect",
    "--expand-environment=no",
    `--unit=${identity.unit}`,
    `--slice=${slice}`,
    "--property=Type=exec",
    "--property=Restart=no",
    "--property=KillMode=control-group",
    "--property=RuntimeMaxSec=120s",
    "--property=RuntimeRandomizedExtraSec=0",
    "--property=TimeoutStopSec=2s",
    "--property=CPUQuota=25%",
    `--property=MemoryMax=${PRESSURE_BOUNDS.pressureBytes}`,
    "--property=MemorySwapMax=0",
    "--property=TasksMax=32",
    "--property=LimitCORE=0",
    `--working-directory=${identity.checkout}`,
    "/usr/bin/env",
    "-i",
    identity.node,
    identity.bundle,
  ];
}

export function observePressureResource(expected, slice, port = pressurePort) {
  const service = observeSchedulingService(expected, port);
  if (service.state === "absent") {
    if (expected.cgroup) assert.equal(port.inode(`/sys/fs/cgroup${expected.cgroup}`), null);
    if (expected.pid) {
      const inode = port.inode(`/proc/${expected.pid}`);
      if (inode !== null) {
        const stat = port.read(`/proc/${expected.pid}/stat`);
        const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
        assert.notEqual(ticks, expected.startTicks, "original pressure process still exists");
      }
    }
    return service;
  }
  assert.equal(
    port.link(`/proc/${service.pid}/exe`),
    expected.node,
    "pressure executable identity changed",
  );
  assert.equal(dirname(service.cgroup), slice.cgroup, "pressure resource escaped its owned slice");
  const memory = pressureMemory(service.cgroup, port);
  if (expected.memory?.inode)
    assert.equal(memory.inode, expected.memory.inode, "pressure cgroup incarnation changed");
  assert.equal(memory.memoryMax, PRESSURE_BOUNDS.pressureBytes);
  assert.equal(memory.swapMax, 0);
  assert.equal(memory.cpu, PRESSURE_BOUNDS.pressureCpu);
  assert.deepEqual(port.children(`/sys/fs/cgroup${service.cgroup}`), []);
  assert.deepEqual(
    port.read(`/sys/fs/cgroup${service.cgroup}/cgroup.procs`).trim().split(/\s+/),
    [String(service.pid)],
    "pressure service has an unexpected process",
  );
  const properties = pressureProperties(
    service.unit,
    ["Type", "Restart", "RuntimeMaxUSec", "RuntimeRandomizedExtraUSec", "TimeoutStopUSec"],
    port,
  );
  assert.equal(properties.Type, "exec");
  assert.equal(properties.Restart, "no");
  assert.ok(["2min", "120s"].includes(properties.RuntimeMaxUSec));
  assert.equal(properties.RuntimeRandomizedExtraUSec, "0");
  assert.equal(properties.TimeoutStopUSec, "2s");
  assert.equal(bytes(port.read(`/sys/fs/cgroup${service.cgroup}/pids.max`)), 32);
  return { ...service, memory, properties };
}

export function observePressureDirector(expected, port = pressurePort) {
  const service = observeSchedulingService(expected, port);
  assert.equal(service.state, "active");
  assert.equal(
    port.link(`/proc/${service.pid}/exe`),
    expected.node,
    "Director executable identity changed",
  );
  const memory = pressureMemory(service.cgroup, port);
  assert.equal(memory.memoryMax, PRESSURE_BOUNDS.sliceBytes);
  assert.equal(memory.swapMax, 0);
  const properties = pressureProperties(
    service.unit,
    ["Type", "Restart", "RuntimeMaxUSec", "RuntimeRandomizedExtraUSec", "TimeoutStopUSec"],
    port,
  );
  assert.equal(properties.Type, "exec");
  assert.equal(properties.Restart, "no");
  assert.ok(["50min", "3000s"].includes(properties.RuntimeMaxUSec));
  assert.equal(properties.RuntimeRandomizedExtraUSec, "0");
  assert.equal(properties.TimeoutStopUSec, "2s");
  return { ...service, memory, properties };
}

export function pressureSliceOverrides(slice, uid, port = pressurePort) {
  assert.match(slice.unit, slicePattern);
  assert.ok(Number.isSafeInteger(uid) && uid > 0);
  const fields = pressureProperties(slice.unit, ["Id", "FragmentPath", "DropInPaths"], port);
  assert.equal(fields.Id, slice.unit);
  assert.equal(fields.FragmentPath, "", "owned slice acquired a unit definition");
  const paths = fields.DropInPaths.split(" ").filter(Boolean).sort();
  assert.ok(paths.length > 0 && paths.length <= 8);
  return paths.map((path) => {
    assert.ok(
      path.startsWith(`/run/user/${uid}/systemd/user.control/${slice.unit}.d/`),
      "slice has an unowned override",
    );
    assert.match(path, /^\/[A-Za-z0-9_./-]+$/);
    assert.ok(!path.split("/").includes(".."));
    const contents = port.read(path);
    assert.ok(contents.length < 16384);
    return { path, digest: digest(contents) };
  });
}

/** One stop only, bound to the captured executable/process/service incarnation. */
export async function stopPressureResource(expected, slice, port = pressurePort) {
  assert.ok(expected.pid && expected.startTicks && expected.invocationId && expected.bootDigest);
  const before = observePressureResource(expected, slice, port);
  if (before.state === "absent") return before;
  port.exec("systemctl", ["--user", "stop", expected.unit]);
  for (let index = 0; index < 10; index++) {
    const current = observePressureResource(expected, slice, port);
    if (current.state === "absent") return current;
    await port.wait(200);
  }
  throw Error("owned pressure resource cleanup unverified");
}
