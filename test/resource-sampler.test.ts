import { afterEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";

const openResourceFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ open: openResourceFile }));

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
  parseCgroupMembership,
  cgroupAncestors,
  MAX_CGROUP_ANCESTORS,
  MAX_CGROUP_MEMBERSHIP_BYTES,
} from "../src/scheduling/cgroup.js";

const GB = 1_073_741_824;
afterEach(() => vi.resetAllMocks());

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
    expect(parseCgroupBytes("9223372036854771712", "memory.limit_in_bytes", false, true)).toBeNull();
    expect(() => parseCgroupBytes("9223372036854771712", "memory.usage_in_bytes", false)).toThrow(
      /malformed cgroup/,
    );
    expect(parseCgroupBytes("0", "memory.current", false)).toBe(0);
    expect(parseCgroupBytes("0", "memory.max")).toBe(0);
    expect(() => parseCgroupV1Cpu("-1", "0")).toThrow(/malformed cgroup/);
    expect(() => parseCgroupV2CpuMax("0 100000")).toThrow(/malformed cgroup/);
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

  it("uses an ancestor CPU limit and its aggregate sibling-inclusive memory usage", async () => {
    const result = await new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "0::/parent/child\n",
        "/sys/fs/cgroup/parent/child/cpu.max": "max 100000",
        "/sys/fs/cgroup/parent/child/memory.max": "max",
        "/sys/fs/cgroup/parent/child/memory.current": String(GB),
        "/sys/fs/cgroup/parent/cpu.max": "125000 100000",
        "/sys/fs/cgroup/parent/memory.max": String(8 * GB),
        "/sys/fs/cgroup/parent/memory.current": String(7 * GB),
      }),
      os: host(),
    }).sample();
    expect(result).toMatchObject({
      effectiveCpu: 1.25,
      totalMemoryMb: 8192,
      availableMemoryMb: 1024,
      memoryUsageRatio: 0.875,
      source: "cgroup-v2",
    });
  });

  it("can take total capacity from a tighter child and headroom/pressure from its parent", async () => {
    const result = await new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "0::/parent/child\n",
        "/sys/fs/cgroup/parent/child/cpu.max": "150000 100000",
        "/sys/fs/cgroup/parent/child/memory.max": String(4 * GB),
        "/sys/fs/cgroup/parent/child/memory.current": String(GB),
        "/sys/fs/cgroup/parent/cpu.max": "400000 100000",
        "/sys/fs/cgroup/parent/memory.max": String(8 * GB),
        "/sys/fs/cgroup/parent/memory.current": String(7.5 * GB),
      }),
      os: host(),
    }).sample();
    expect(result).toMatchObject({
      effectiveCpu: 1.5,
      totalMemoryMb: 4096,
      availableMemoryMb: 512,
      memoryUsageRatio: 0.9375,
    });
  });

  it("still applies a finite cgroup's headroom when its memory limit exceeds host total", async () => {
    const result = await new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "0::/parent/child\n",
        // Controllers need not be enabled in the child to inherit parent limits.
        "/sys/fs/cgroup/parent/cpu.max": "12800000 100000",
        "/sys/fs/cgroup/parent/memory.max": String(32 * GB),
        "/sys/fs/cgroup/parent/memory.current": String(31 * GB),
      }),
      os: host(),
    }).sample();
    expect(result).toMatchObject({
      effectiveCpu: 8,
      totalMemoryMb: 16384,
      availableMemoryMb: 1024,
      memoryUsageRatio: 31 / 32,
    });
  });

  it.each([
    { limit: 32 * GB, current: 0, total: 16384, free: 8192, usage: 0.5 },
    { limit: 4 * GB, current: 0, total: 4096, free: 4096, usage: 0.5 },
    { limit: 4 * GB, current: 5 * GB, total: 4096, free: 0, usage: 1 },
    { limit: 0, current: 0, total: 0, free: 0, usage: 1 },
    { limit: 512 * 1024, current: 0, total: 0, free: 0, usage: 0.5 },
  ])("preserves host ceilings and zero capacity for limit=$limit/current=$current", async (entry) => {
    const reads: string[] = [];
    const source = files({
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/cpu.max": "50000 100000",
      "/sys/fs/cgroup/memory.max": String(entry.limit),
      "/sys/fs/cgroup/memory.current": String(entry.current),
    });
    const result = await new LinuxResourceSampler({
      files: { read: async (path) => { reads.push(path); return source.read(path); } },
      os: host(),
    }).sample();
    expect(result).toMatchObject({
      effectiveCpu: 0.5,
      totalMemoryMb: entry.total,
      availableMemoryMb: entry.free,
      memoryUsageRatio: entry.usage,
    });
    expect(reads).toEqual([
      "/proc/self/cgroup",
      "/sys/fs/cgroup/cpu.max",
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory.current",
    ]);
  });

  it("applies v1 ancestor CPU limits and hierarchical memory using separate membership paths", async () => {
    const result = await new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "2:cpu,cpuacct:/cpu-parent/job\n3:memory:/mem-parent/job\n",
        "/sys/fs/cgroup/cpu,cpuacct/cpu-parent/job/cpu.cfs_quota_us": "-1",
        "/sys/fs/cgroup/cpu,cpuacct/cpu-parent/job/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/cpu,cpuacct/cpu-parent/cpu.cfs_quota_us": "75000",
        "/sys/fs/cgroup/cpu,cpuacct/cpu-parent/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/memory/mem-parent/job/memory.limit_in_bytes": String(4 * GB),
        "/sys/fs/cgroup/memory/mem-parent/job/memory.usage_in_bytes": String(GB),
        "/sys/fs/cgroup/memory/mem-parent/job/memory.use_hierarchy": "1",
        "/sys/fs/cgroup/memory/mem-parent/memory.limit_in_bytes": String(8 * GB),
        "/sys/fs/cgroup/memory/mem-parent/memory.usage_in_bytes": String(7 * GB),
        "/sys/fs/cgroup/memory/mem-parent/memory.use_hierarchy": "1",
      }),
      os: host(),
    }).sample();
    expect(result).toMatchObject({
      effectiveCpu: 0.75,
      totalMemoryMb: 4096,
      availableMemoryMb: 1024,
      memoryUsageRatio: 0.875,
      source: "cgroup-v1",
    });
  });

  it("does not apply a legacy v1 non-hierarchical parent's own usage to the child", async () => {
    const result = await new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "3:memory:/parent/child\n",
        "/sys/fs/cgroup/memory/parent/child/memory.limit_in_bytes": String(4 * GB),
        "/sys/fs/cgroup/memory/parent/child/memory.usage_in_bytes": String(GB),
        "/sys/fs/cgroup/memory/parent/child/memory.use_hierarchy": "0",
        "/sys/fs/cgroup/memory/parent/memory.limit_in_bytes": String(GB),
        "/sys/fs/cgroup/memory/parent/memory.usage_in_bytes": String(GB),
        "/sys/fs/cgroup/memory/parent/memory.use_hierarchy": "0",
      }),
      os: host(),
    }).sample();
    expect(result).toMatchObject({ totalMemoryMb: 4096, availableMemoryMb: 3072, memoryUsageRatio: 0.5 });
  });

  it("combines v2 CPU with v1 memory on a hybrid host", async () => {
    const result = await new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "0::/job\n3:memory:/\n",
        "/sys/fs/cgroup/job/cpu.max": "200000 100000",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(GB),
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": "0",
        "/sys/fs/cgroup/memory/memory.use_hierarchy": "0",
      }),
      os: host(),
    }).sample();
    expect(result).toMatchObject({ effectiveCpu: 2, totalMemoryMb: 1024, availableMemoryMb: 1024 });
  });

  it("accepts root-only v2 memory accounting without inventing a finite root limit", async () => {
    const result = await new LinuxResourceSampler({
      files: files({
        "/proc/self/cgroup": "0::/job",
        "/sys/fs/cgroup/job/memory.max": String(4 * GB),
        "/sys/fs/cgroup/job/memory.current": String(GB),
        "/sys/fs/cgroup/memory.current": String(15 * GB),
      }),
      os: host(),
    }).sample();
    expect(result).toMatchObject({ effectiveCpu: 8, totalMemoryMb: 4096, availableMemoryMb: 3072, memoryUsageRatio: 0.5 });
  });

  it("does not sample unrelated controller roots without process membership", async () => {
    const result = await new LinuxResourceSampler({
      files: files({ "/sys/fs/cgroup/cpu.max": "50000 100000" }),
      os: host(),
    }).sample();
    expect(result).toMatchObject({ effectiveCpu: 8, source: "host" });
  });

  it.each([
    { "/proc/self/cgroup": "0::/job", "/sys/fs/cgroup/job/memory.max": "0" },
    { "/proc/self/cgroup": "0::/job", "/sys/fs/cgroup/job/memory.current": "0" },
    { "/proc/self/cgroup": "0::/job", "/sys/fs/cgroup/job/memory.max": "9223372036854771712" },
    { "/proc/self/cgroup": "0::/parent/child", "/sys/fs/cgroup/parent/child/cpu.max": "100000 100000" },
    { "/proc/self/cgroup": "2:cpu:/job", "/sys/fs/cgroup/cpu/job/cpu.cfs_quota_us": "-1" },
    { "/proc/self/cgroup": "2:cpu:/job", "/sys/fs/cgroup/cpu/job/cpu.cfs_quota_us": "-1", "/sys/fs/cgroup/cpu/job/cpu.cfs_period_us": "broken" },
    { "/proc/self/cgroup": "3:memory:/parent/child", "/sys/fs/cgroup/memory/parent/child/memory.limit_in_bytes": "1", "/sys/fs/cgroup/memory/parent/child/memory.usage_in_bytes": "0", "/sys/fs/cgroup/memory/parent/memory.limit_in_bytes": "1", "/sys/fs/cgroup/memory/parent/memory.usage_in_bytes": "0" },
    { "/proc/self/cgroup": "3:memory:/job", "/sys/fs/cgroup/memory/job/memory.limit_in_bytes": "1", "/sys/fs/cgroup/memory/job/memory.usage_in_bytes": "0", "/sys/fs/cgroup/memory/job/memory.use_hierarchy": "2" },
  ])("rejects malformed or incomplete constrained ancestry", async (entry) => {
    const sampler = new LinuxResourceSampler({ files: files(entry as Record<string, string>), os: host() });
    await expect(sampler.sample()).rejects.toThrow();
  });

  it("bounds ancestry and rejects traversal, duplicate controllers and malformed memberships", () => {
    expect(cgroupAncestors("")).toEqual([""]);
    expect(cgroupAncestors(undefined)).toEqual([]);
    expect(cgroupAncestors("a/b")).toEqual(["a/b", "a", ""]);
    expect(cgroupAncestors(Array(63).fill("a").join("/"))).toHaveLength(MAX_CGROUP_ANCESTORS);
    for (const value of [
      `0::/${Array(64).fill("a").join("/")}`,
      "0::/a/../b", "0::/a/./b", "0::relative", "0::/a\0b",
      "0::/a\n0::/b", "2:cpu:/a\n3:cpu:/b", "0::/gone (deleted)",
      `0::/${"a".repeat(4096)}`, "x".repeat(MAX_CGROUP_MEMBERSHIP_BYTES + 1),
    ]) {
      expect(() => parseCgroupMembership(value)).toThrow();
    }
    expect(parseCgroupMembership("0::/allowed:name").v2).toBe("allowed:name");
  });

  it("distinguishes a missing kernel file from denied observation", async () => {
    openResourceFile.mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }));
    await expect(new LinuxResourceSampler({ os: host() }).sample()).resolves.toMatchObject({ source: "host" });
    openResourceFile.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(new LinuxResourceSampler({ os: host() }).sample()).rejects.toThrow("denied");
  });

  it("caps bytes actually read and closes the read-only descriptor on overflow", async () => {
    const close = vi.fn(async () => {});
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      buffer.fill(97, offset, offset + length);
      return { bytesRead: length, buffer };
    });
    openResourceFile.mockResolvedValueOnce({ read, close });
    await expect(new LinuxResourceSampler({ os: host() }).sample()).rejects.toThrow("observation bounds");
    expect(read.mock.calls[0]![0]).toHaveLength(MAX_CGROUP_MEMBERSHIP_BYTES + 1);
    expect(close).toHaveBeenCalledOnce();
    const flags = openResourceFile.mock.calls[0]![1] as number;
    expect(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC)).toBe(0);
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
