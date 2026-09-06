import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";

import {
  cgroupPath,
  cgroupAncestors,
  MAX_CGROUP_MEMBERSHIP_BYTES,
  parseCgroupBytes,
  parseCgroupMembership,
  parseCgroupV1Cpu,
  parseCgroupV1Hierarchy,
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
  /** Null means absent; denied, malformed or otherwise unavailable reads reject. */
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
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        // procfs/cgroupfs can report size zero, so bound bytes actually read.
        const buffer = Buffer.alloc(MAX_CGROUP_MEMBERSHIP_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        if (total > MAX_CGROUP_MEMBERSHIP_BYTES) {
          throw new Error("cgroup resource file exceeds observation bounds");
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
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
  memory: Array<{ limit: number; current: number }>;
  source: "cgroup-v2" | "cgroup-v1";
}

function constrainCpu(observation: CgroupObservation, cpu: number | null): void {
  if (cpu !== null) observation.cpu = Math.min(observation.cpu ?? cpu, cpu);
}

function observeMemoryPair(
  maxRaw: string | null,
  currentRaw: string | null,
  maxPath: string,
  currentPath: string,
  v1 = false,
): { limit: number; current: number } | null {
  if (maxRaw === null && currentRaw === null) return null;
  if (maxRaw === null) throw new Error("incomplete cgroup memory limit observation");
  const limit = parseCgroupBytes(maxRaw, maxPath, !v1, v1);
  const current = currentRaw === null ? null : parseCgroupBytes(currentRaw, currentPath, false);
  if (limit === null) return null;
  if (current === null) throw new Error("incomplete constrained cgroup memory usage observation");
  return { limit, current };
}

async function observeV2(
  files: ResourceFileReader,
  membership: string | undefined,
): Promise<CgroupObservation | null> {
  const root = "/sys/fs/cgroup";
  const result: CgroupObservation = { cpu: null, memory: [], source: "cgroup-v2" };
  let cpuObserved = false;
  let memoryObserved = false;
  for (const ancestor of cgroupAncestors(membership)) {
    const cpuPath = cgroupPath(root, ancestor, "cpu.max");
    const maxPath = cgroupPath(root, ancestor, "memory.max");
    const currentPath = cgroupPath(root, ancestor, "memory.current");
    const [cpuRaw, maxRaw, currentRaw] = await Promise.all([
      files.read(cpuPath),
      files.read(maxPath),
      files.read(currentPath),
    ]);
    // v2 controllers can be disabled below a constrained ancestor. Once present,
    // however, a missing intermediate ancestor is incomplete telemetry. The real
    // hierarchy root legitimately has no cpu.max or memory.max/current files.
    if (ancestor && cpuObserved && cpuRaw === null) {
      throw new Error("incomplete cgroup v2 CPU ancestry observation");
    }
    if (ancestor && memoryObserved && maxRaw === null && currentRaw === null) {
      throw new Error("incomplete cgroup v2 memory ancestry observation");
    }
    if (cpuRaw !== null) {
      cpuObserved = true;
      constrainCpu(result, parseCgroupV2CpuMax(cpuRaw, cpuPath));
    }
    if (maxRaw !== null || currentRaw !== null) memoryObserved = true;
    // Root-only accounting can be exposed without a limit control. It is not
    // evidence of a finite constraint; non-root partial pairs still fail closed.
    if (ancestor === "" && maxRaw === null) {
      if (currentRaw !== null) parseCgroupBytes(currentRaw, currentPath, false);
      continue;
    }
    const memory = observeMemoryPair(maxRaw, currentRaw, maxPath, currentPath);
    if (memory) result.memory.push(memory);
  }
  return cpuObserved || memoryObserved ? result : null;
}

async function observeV1(
  files: ResourceFileReader,
  cpuMembership: string | undefined,
  memoryMembership: string | undefined,
): Promise<CgroupObservation | null> {
  const result: CgroupObservation = { cpu: null, memory: [], source: "cgroup-v1" };
  const memoryRoot = "/sys/fs/cgroup/memory";
  let memoryObserved = false;
  let missingMemoryDescendant = false;
  for (const [index, ancestor] of cgroupAncestors(memoryMembership).entries()) {
    const maxPath = cgroupPath(memoryRoot, ancestor, "memory.limit_in_bytes");
    const currentPath = cgroupPath(memoryRoot, ancestor, "memory.usage_in_bytes");
    const hierarchyPath = cgroupPath(memoryRoot, ancestor, "memory.use_hierarchy");
    const [maxRaw, currentRaw, hierarchyRaw] = await Promise.all([
      files.read(maxPath),
      files.read(currentPath),
      files.read(hierarchyPath),
    ]);
    if (maxRaw === null && currentRaw === null && hierarchyRaw === null) {
      if (ancestor && memoryObserved) throw new Error("incomplete cgroup v1 memory ancestry observation");
      missingMemoryDescendant = true;
      continue;
    }
    if (missingMemoryDescendant) throw new Error("incomplete cgroup v1 memory descendant observation");
    memoryObserved = true;
    const hierarchical = hierarchyRaw === null ? null : parseCgroupV1Hierarchy(hierarchyRaw, hierarchyPath);
    // A leaf's own limit always applies. Legacy v1 ancestor charges and limits
    // apply only with hierarchical accounting enabled; unknown is not disabled.
    if (index > 0 && hierarchical === null) {
      throw new Error("unavailable cgroup v1 memory hierarchy observation");
    }
    const memory = observeMemoryPair(maxRaw, currentRaw, maxPath, currentPath, true);
    if (memory && (index === 0 || hierarchical)) result.memory.push(memory);
  }
  let cpuObserved = false;
  for (const cpuRoot of [
    "/sys/fs/cgroup/cpu",
    "/sys/fs/cgroup/cpu,cpuacct",
    "/sys/fs/cgroup/cpuacct,cpu",
  ]) {
    let missingCpuDescendant = false;
    for (const ancestor of cgroupAncestors(cpuMembership)) {
      const quotaPath = cgroupPath(cpuRoot, ancestor, "cpu.cfs_quota_us");
      const periodPath = cgroupPath(cpuRoot, ancestor, "cpu.cfs_period_us");
      const [quotaRaw, periodRaw] = await Promise.all([
        files.read(quotaPath),
        files.read(periodPath),
      ]);
      if (quotaRaw === null && periodRaw === null) {
        if (ancestor && cpuObserved) throw new Error("incomplete cgroup v1 CPU ancestry observation");
        missingCpuDescendant = true;
        continue;
      }
      if (missingCpuDescendant) throw new Error("incomplete cgroup v1 CPU descendant observation");
      if (quotaRaw === null || periodRaw === null) {
        throw new Error("incomplete cgroup v1 CPU quota observation");
      }
      constrainCpu(result, parseCgroupV1Cpu(quotaRaw, periodRaw, quotaPath, periodPath));
      cpuObserved = true;
    }
    if (cpuObserved) break;
  }
  return cpuObserved || memoryObserved ? result : null;
}

export interface LinuxResourceSamplerOptions {
  files?: ResourceFileReader;
  os?: ResourceOsReader;
  now?: () => Date;
}

/** Linux and WSL sampler. Observe bounded visible ancestry without changing limits. */
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
    // Hybrid hosts may bind CPU and memory to different cgroup versions. Do not
    // discard the v1 controller merely because some v2 telemetry is present.
    const observations = (
      await Promise.all([
        observeV2(this.#files, membership.v2),
        observeV1(this.#files, membership.v1Cpu, membership.v1Memory),
      ])
    ).filter((value): value is CgroupObservation => value !== null);
    let effectiveCpu = logicalCpu;
    let effectiveTotal = hostTotal;
    let effectiveFree = hostFree;
    let memoryUsageRatio = (hostTotal - hostFree) / hostTotal;
    let source: ResourceSnapshot["source"] = "host";
    for (const observation of observations) {
      if (observation.cpu !== null) effectiveCpu = Math.min(effectiveCpu, observation.cpu);
      for (const { limit, current } of observation.memory) {
        effectiveTotal = Math.min(effectiveTotal, limit);
        effectiveFree = Math.min(effectiveFree, Math.max(0, limit - current));
        memoryUsageRatio = Math.max(
          memoryUsageRatio,
          // A zero-byte hard limit provides no capacity, including at zero use.
          limit === 0 ? 1 : Math.min(1, current / limit),
        );
      }
      if (source === "host" && (observation.cpu !== null || observation.memory.length > 0)) {
        source = observation.source;
      }
    }
    effectiveFree = Math.min(effectiveFree, effectiveTotal);

    return {
      measuredAt: this.#now().toISOString(),
      logicalCpu,
      effectiveCpu,
      loadRatio: load / effectiveCpu,
      totalMemoryMb: Math.floor(effectiveTotal / MB),
      availableMemoryMb: Math.floor(effectiveFree / MB),
      memoryUsageRatio,
      source,
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
