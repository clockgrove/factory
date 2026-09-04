export class MalformedCgroupValueError extends Error {
  constructor(path: string, value: string) {
    super(`malformed cgroup value in ${path}: ${JSON.stringify(value.trim())}`);
    this.name = "MalformedCgroupValueError";
  }
}

function positiveInteger(path: string, value: string): number {
  const text = value.trim();
  if (!/^\d+$/.test(text)) throw new MalformedCgroupValueError(path, value);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MalformedCgroupValueError(path, value);
  }
  return parsed;
}

export function parseCgroupV2CpuMax(
  value: string,
  path = "cpu.max",
): number | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) throw new MalformedCgroupValueError(path, value);
  const period = positiveInteger(path, parts[1]!);
  if (parts[0] === "max") return null;
  return positiveInteger(path, parts[0]!) / period;
}

export function parseCgroupV1Cpu(
  quota: string,
  period: string,
  quotaPath = "cpu.cfs_quota_us",
  periodPath = "cpu.cfs_period_us",
): number | null {
  if (quota.trim() === "-1") return null;
  return positiveInteger(quotaPath, quota) / positiveInteger(periodPath, period);
}

export function parseCgroupBytes(
  value: string,
  path: string,
  allowMax = true,
): number | null {
  const text = value.trim();
  if (allowMax && text === "max") return null;
  if (!/^\d+$/.test(text)) throw new MalformedCgroupValueError(path, value);
  const parsed = BigInt(text);
  if (parsed <= 0n) throw new MalformedCgroupValueError(path, value);
  // cgroup v1 represents an unlimited memory limit with a page-rounded value
  // near LONG_MAX, which is intentionally outside JavaScript's safe range.
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    if (allowMax) return null;
    throw new MalformedCgroupValueError(path, value);
  }
  return Number(parsed);
}

export interface CgroupMembership {
  v2?: string;
  v1Cpu?: string;
  v1Memory?: string;
}

function safeMembershipPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("cgroup membership contains path traversal");
  }
  return parts.join("/");
}

export function parseCgroupMembership(value: string): CgroupMembership {
  const result: CgroupMembership = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(":");
    if (parts.length !== 3) throw new MalformedCgroupValueError("/proc/self/cgroup", line);
    const controllers = parts[1]!.split(",").filter(Boolean);
    const membership = safeMembershipPath(parts[2]!);
    if (controllers.length === 0) result.v2 = membership;
    if (controllers.includes("cpu")) result.v1Cpu = membership;
    if (controllers.includes("memory")) result.v1Memory = membership;
  }
  return result;
}

export function cgroupPath(root: string, membership: string | undefined, file: string): string {
  return [root.replace(/\/+$/, ""), membership, file].filter(Boolean).join("/");
}
