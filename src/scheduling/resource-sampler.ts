import { readFile } from "node:fs/promises";
import os from "node:os";

import {
  cgroupPath,
  parseCgroupBytes,
  parseCgroupMembership,
  parseCgroupV1Cpu,
  parseCgroupV2CpuMax,
} from "./cgroup.js";

const MB = 1_048_576;

export interface ResourceSnapshot {
  measuredAt: string;
  logicalCpu: number;
  effectiveCpu: number;
  loadRatio: number;
  totalMemoryMb: number;
  availableMemoryMb: number;
  memoryUsageRatio: number;
  source: "cgroup-v2" | "cgroup-v1" | "host";
}

export interface ResourceSampler {
  sample(): Promise<ResourceSnapshot>;
}

export interface ResourceFileReader {
  read(path: string): Promise<string | null>;
}

export interface ResourceOsReader {
  availableParallelism(): number;
  totalMemoryBytes(): number;
  freeMemoryBytes(): number;
  oneMinuteLoad(): number;
}

const defaultFiles: ResourceFileReader = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return null;
      throw error;
    }
  },
};

const defaultOs: ResourceOsReader = {
  availableParallelism: () => os.availableParallelism(),
  totalMemoryBytes: () => os.totalmem(),
  freeMemoryBytes: () => os.freemem(),
  oneMinuteLoad: () => os.loadavg()[0] ?? 0,
};

interface CgroupObservation {
  cpu: number | null;
  memoryLimitBytes: number | null;
  memoryCurrentBytes: number | null;
  source: "cgroup-v2" | "cgroup-v1";
}

async function observeV2(
  files: ResourceFileReader,
  membership: string | undefined,
): Promise<CgroupObservation | null> {
  const root = "/sys/fs/cgroup";
  const cpuPath = cgroupPath(root, membership, "cpu.max");
  const maxPath = cgroupPath(root, membership, "memory.max");
  const currentPath = cgroupPath(root, membership, "memory.current");
  const [cpuRaw, maxRaw, currentRaw] = await Promise.all([
    files.read(cpuPath),
    files.read(maxPath),
    files.read(currentPath),
  ]);
  if (cpuRaw === null && maxRaw === null && currentRaw === null) return null;
  return {
    cpu: cpuRaw === null ? null : parseCgroupV2CpuMax(cpuRaw, cpuPath),
    memoryLimitBytes: maxRaw === null ? null : parseCgroupBytes(maxRaw, maxPath),
    memoryCurrentBytes:
      currentRaw === null ? null : parseCgroupBytes(currentRaw, currentPath, false),
    source: "cgroup-v2",
  };
}

async function observeV1(
  files: ResourceFileReader,
  cpuMembership: string | undefined,
  memoryMembership: string | undefined,
): Promise<CgroupObservation | null> {
  const memoryRoot = "/sys/fs/cgroup/memory";
  const maxPath = cgroupPath(memoryRoot, memoryMembership, "memory.limit_in_bytes");
  const currentPath = cgroupPath(memoryRoot, memoryMembership, "memory.usage_in_bytes");
  const [maxRaw, currentRaw] = await Promise.all([files.read(maxPath), files.read(currentPath)]);
  let cpu: number | null = null;
  let cpuObserved = false;
  for (const cpuRoot of [
    "/sys/fs/cgroup/cpu",
    "/sys/fs/cgroup/cpu,cpuacct",
    "/sys/fs/cgroup/cpuacct,cpu",
  ]) {
    const quotaPath = cgroupPath(cpuRoot, cpuMembership, "cpu.cfs_quota_us");
    const periodPath = cgroupPath(cpuRoot, cpuMembership, "cpu.cfs_period_us");
    const [quotaRaw, periodRaw] = await Promise.all([
      files.read(quotaPath),
      files.read(periodPath),
    ]);
    if (quotaRaw === null && periodRaw === null) continue;
    if (quotaRaw === null || periodRaw === null) {
      throw new Error("incomplete cgroup v1 CPU quota observation");
    }
    cpu = parseCgroupV1Cpu(quotaRaw, periodRaw, quotaPath, periodPath);
    cpuObserved = true;
    break;
  }
  if (!cpuObserved && maxRaw === null && currentRaw === null) {
    return null;
  }
  return {
    cpu,
    memoryLimitBytes: maxRaw === null ? null : parseCgroupBytes(maxRaw, maxPath),
    memoryCurrentBytes:
      currentRaw === null ? null : parseCgroupBytes(currentRaw, currentPath, false),
    source: "cgroup-v1",
  };
}

export interface LinuxResourceSamplerOptions {
  files?: ResourceFileReader;
  os?: ResourceOsReader;
  now?: () => Date;
}

/** Linux and WSL sampler. Missing cgroups fall back to host observations. */
export class LinuxResourceSampler implements ResourceSampler {
  readonly #files: ResourceFileReader;
  readonly #os: ResourceOsReader;
  readonly #now: () => Date;

  constructor(options: LinuxResourceSamplerOptions = {}) {
    this.#files = options.files ?? defaultFiles;
    this.#os = options.os ?? defaultOs;
    this.#now = options.now ?? (() => new Date());
  }

  async sample(): Promise<ResourceSnapshot> {
    const logicalCpu = this.#os.availableParallelism();
    const hostTotal = this.#os.totalMemoryBytes();
    const hostFree = this.#os.freeMemoryBytes();
    const load = this.#os.oneMinuteLoad();
    if (
      !Number.isFinite(logicalCpu) ||
      logicalCpu <= 0 ||
      !Number.isFinite(hostTotal) ||
      hostTotal <= 0 ||
      !Number.isFinite(hostFree) ||
      hostFree < 0 ||
      hostFree > hostTotal ||
      !Number.isFinite(load) ||
      load < 0
    ) {
      throw new Error("host resource observation is malformed");
    }

    const membershipRaw = await this.#files.read("/proc/self/cgroup");
    const membership = membershipRaw ? parseCgroupMembership(membershipRaw) : {};
    const cgroup =
      (await observeV2(this.#files, membership.v2)) ??
      (await observeV1(this.#files, membership.v1Cpu, membership.v1Memory));

    const finiteCpu = cgroup?.cpu && cgroup.cpu > 0 ? cgroup.cpu : null;
    const effectiveCpu = Math.min(logicalCpu, finiteCpu ?? logicalCpu);
    const finiteMemoryLimit =
      cgroup?.memoryLimitBytes && cgroup.memoryLimitBytes < hostTotal
        ? cgroup.memoryLimitBytes
        : null;
    const effectiveTotal = Math.min(hostTotal, finiteMemoryLimit ?? hostTotal);
    const cgroupCurrent = cgroup?.memoryCurrentBytes ?? null;
    const cgroupFree =
      finiteMemoryLimit !== null && cgroupCurrent !== null
        ? Math.max(0, finiteMemoryLimit - cgroupCurrent)
        : hostFree;
    const effectiveFree = Math.min(hostFree, cgroupFree, effectiveTotal);
    const hostUsage = (hostTotal - hostFree) / hostTotal;
    const cgroupUsage =
      finiteMemoryLimit !== null && cgroupCurrent !== null
        ? Math.min(1, cgroupCurrent / finiteMemoryLimit)
        : 0;

    return {
      measuredAt: this.#now().toISOString(),
      logicalCpu,
      effectiveCpu,
      loadRatio: load / effectiveCpu,
      totalMemoryMb: Math.floor(effectiveTotal / MB),
      availableMemoryMb: Math.floor(effectiveFree / MB),
      memoryUsageRatio: Math.max(hostUsage, cgroupUsage),
      source: cgroup && (finiteCpu !== null || finiteMemoryLimit !== null) ? cgroup.source : "host",
    };
  }
}

/** TTL cache plus admission-only pressure cooldown; running work is untouched. */
export class CachedResourceSampler {
  #cached?: { value: ResourceSnapshot; expiresAt: number };
  #cooldownUntil = 0;

  constructor(
    readonly sampler: ResourceSampler,
    readonly sampleIntervalMs: number,
    readonly admissionCooldownMs: number,
  ) {
    if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 0) {
      throw new Error("sample interval must be non-negative");
    }
    if (!Number.isFinite(admissionCooldownMs) || admissionCooldownMs < 0) {
      throw new Error("admission cooldown must be non-negative");
    }
  }

  async sample(nowMs: number): Promise<ResourceSnapshot> {
    if (this.#cached && nowMs < this.#cached.expiresAt) return this.#cached.value;
    const value = await this.sampler.sample();
    this.#cached = { value, expiresAt: nowMs + this.sampleIntervalMs };
    return value;
  }

  notePressure(nowMs: number): void {
    this.#cooldownUntil = Math.max(this.#cooldownUntil, nowMs + this.admissionCooldownMs);
  }

  get cooldownUntil(): number {
    return this.#cooldownUntil;
  }

  coolingDown(nowMs: number): boolean {
    return nowMs < this.#cooldownUntil;
  }
}

export function resourcePressureReasons(
  snapshot: ResourceSnapshot,
  ceilings: { maxLoadRatio: number; maxMemoryUsageRatio: number },
): string[] {
  const reasons: string[] = [];
  if (snapshot.loadRatio > ceilings.maxLoadRatio) {
    reasons.push("load pressure exceeds policy ceiling");
  }
  if (snapshot.memoryUsageRatio > ceilings.maxMemoryUsageRatio) {
    reasons.push("memory pressure exceeds policy ceiling");
  }
  return reasons;
}
