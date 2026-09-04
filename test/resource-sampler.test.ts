import { describe, expect, it } from "vitest";

import {
  CachedResourceSampler,
  LinuxResourceSampler,
  resourcePressureReasons,
  type ResourceFileReader,
  type ResourceOsReader,
  type ResourceSnapshot,
} from "../src/scheduling/resource-sampler.js";
import {
  parseCgroupBytes,
  parseCgroupV1Cpu,
  parseCgroupV2CpuMax,
} from "../src/scheduling/cgroup.js";

const GB = 1_073_741_824;

function files(values: Record<string, string>): ResourceFileReader {
  return { read: async (path) => values[path] ?? null };
}

function host(overrides: Partial<ResourceOsReader> = {}): ResourceOsReader {
  return {
    availableParallelism: () => 8,
    totalMemoryBytes: () => 16 * GB,
    freeMemoryBytes: () => 8 * GB,
    oneMinuteLoad: () => 4,
    ...overrides,
  };
}

describe("Linux/WSL resource sampler", () => {
  it("recognizes v1 and v2 unlimited CPU and memory sentinels", () => {
    expect(parseCgroupV2CpuMax("max 100000")).toBeNull();
    expect(parseCgroupV1Cpu("-1", "100000")).toBeNull();
    expect(parseCgroupBytes("max", "memory.max")).toBeNull();
    expect(parseCgroupBytes("9223372036854771712", "memory.limit_in_bytes")).toBeNull();
    expect(() => parseCgroupBytes("9223372036854771712", "memory.usage_in_bytes", false)).toThrow(
      /malformed cgroup/,
    );
  });

  it("chooses the tightest cgroup v2 CPU and memory observations", async () => {
    const sampler = new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "0::/factory.slice\n",
        "/sys/fs/cgroup/factory.slice/cpu.max": "150000 100000\n",
        "/sys/fs/cgroup/factory.slice/memory.max": String(8 * GB),
        "/sys/fs/cgroup/factory.slice/memory.current": String(6 * GB),
      }),
      os: host(),
      now: () => new Date("2026-09-04T00:00:00.000Z"),
    });
    await expect(sampler.sample()).resolves.toEqual({
      measuredAt: "2026-09-04T00:00:00.000Z",
      logicalCpu: 8,
      effectiveCpu: 1.5,
      loadRatio: 4 / 1.5,
      totalMemoryMb: 8_192,
      availableMemoryMb: 2_048,
      memoryUsageRatio: 0.75,
      source: "cgroup-v2",
    });
  });

  it("supports cgroup v1 quotas and fractional CPU", async () => {
    const sampler = new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "2:cpu,cpuacct:/job\n3:memory:/job\n",
        "/sys/fs/cgroup/cpu/job/cpu.cfs_quota_us": "250000",
        "/sys/fs/cgroup/cpu/job/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/memory/job/memory.limit_in_bytes": String(4 * GB),
        "/sys/fs/cgroup/memory/job/memory.usage_in_bytes": String(1 * GB),
      }),
      os: host({ oneMinuteLoad: () => 1 }),
    });
    const result = await sampler.sample();
    expect(result).toMatchObject({
      effectiveCpu: 2.5,
      totalMemoryMb: 4_096,
      availableMemoryMb: 3_072,
      source: "cgroup-v1",
    });
  });

  it("supports combined cgroup v1 cpu,cpuacct controller mounts", async () => {
    const sampler = new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "2:cpu,cpuacct:/job\n",
        "/sys/fs/cgroup/cpu,cpuacct/job/cpu.cfs_quota_us": "175000",
        "/sys/fs/cgroup/cpu,cpuacct/job/cpu.cfs_period_us": "100000",
      }),
      os: host({ oneMinuteLoad: () => 1 }),
    });
    await expect(sampler.sample()).resolves.toMatchObject({
      effectiveCpu: 1.75,
      source: "cgroup-v1",
    });
  });

  it("falls back to WSL host observations when cgroups are unavailable", async () => {
    const result = await new LinuxResourceSampler({ files: files({}), os: host() }).sample();
    expect(result).toMatchObject({
      effectiveCpu: 8,
      totalMemoryMb: 16_384,
      availableMemoryMb: 8_192,
      memoryUsageRatio: 0.5,
      source: "host",
    });
  });

  it("fails closed on an observed malformed cgroup value", async () => {
    const sampler = new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "0::/\n",
        "/sys/fs/cgroup/cpu.max": "not-a-quota",
      }),
      os: host(),
    });
    await expect(sampler.sample()).rejects.toThrow(/malformed cgroup/);
  });

  it("caches until expiry and applies cooldown only to new admission", async () => {
    let calls = 0;
    const snapshot = (measuredAt: string): ResourceSnapshot => ({
      measuredAt,
      logicalCpu: 8,
      effectiveCpu: 8,
      loadRatio: 0.1,
      totalMemoryMb: 16_384,
      availableMemoryMb: 8_192,
      memoryUsageRatio: 0.5,
      source: "host",
    });
    const cache = new CachedResourceSampler(
      {
        sample: async () => snapshot(`2026-09-04T00:00:0${calls++}.000Z`),
      },
      5_000,
      10_000,
    );
    const first = await cache.sample(1_000);
    expect(await cache.sample(5_999)).toBe(first);
    expect(await cache.sample(6_000)).not.toBe(first);
    expect(calls).toBe(2);
    cache.notePressure(6_000);
    expect(cache.coolingDown(15_999)).toBe(true);
    expect(cache.coolingDown(16_000)).toBe(false);
  });

  it("reports load and memory pressure independently", () => {
    const sample: ResourceSnapshot = {
      measuredAt: "2026-09-04T00:00:00.000Z",
      logicalCpu: 4,
      effectiveCpu: 2,
      loadRatio: 1.1,
      totalMemoryMb: 4_096,
      availableMemoryMb: 256,
      memoryUsageRatio: 0.95,
      source: "cgroup-v2",
    };
    expect(
      resourcePressureReasons(sample, {
        maxLoadRatio: 0.9,
        maxMemoryUsageRatio: 0.85,
      }),
    ).toEqual(["load pressure exceeds policy ceiling", "memory pressure exceeds policy ceiling"]);
  });
});
