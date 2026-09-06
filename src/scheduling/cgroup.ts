export class MalformedCgroupValueError extends Error {
  constructor(path: string, value: string) {
    super(`malformed cgroup value in ${path}: ${JSON.stringify(value.trim())}`);
    this.name = "MalformedCgroupValueError";
  }
}

export const MAX_CGROUP_ANCESTORS = 64;
export const MAX_CGROUP_MEMBERSHIP_BYTES = 64 * 1024;

function positiveInteger(path: string, value: string): number {
  const text = value.trim();
  if (!/^\d+$/.test(text)) throw new MalformedCgroupValueError(path, value);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MalformedCgroupValueError(path, value);
  }
  return parsed;
}

export function parseCgroupV2CpuMax(value: string, path = "cpu.max"): number | null {
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
  const parsedPeriod = positiveInteger(periodPath, period);
  if (quota.trim() === "-1") return null;
  return positiveInteger(quotaPath, quota) / parsedPeriod;
}

export function parseCgroupBytes(
  value: string,
  path: string,
  allowMax = true,
  allowV1Unlimited = false,
): number | null {
  const text = value.trim();
  if (allowMax && text === "max") return null;
  if (!/^\d{1,20}$/.test(text)) throw new MalformedCgroupValueError(path, value);
  const parsed = BigInt(text);
  // cgroup v1 represents an unlimited memory limit with a page-rounded value
  // near LONG_MAX, which is intentionally outside JavaScript's safe range.
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    if (allowV1Unlimited) return null;
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
  if (
    !value.startsWith("/") ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.endsWith(" (deleted)")
  ) {
    throw new Error("cgroup membership path is malformed or exceeds observation bounds");
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("cgroup membership contains path traversal");
  }
  if (parts.length >= MAX_CGROUP_ANCESTORS) {
    throw new Error("cgroup ancestry exceeds observation bounds");
  }
  return parts.join("/");
}

export function parseCgroupMembership(value: string): CgroupMembership {
  if (Buffer.byteLength(value, "utf8") > MAX_CGROUP_MEMBERSHIP_BYTES) {
    throw new Error("cgroup membership exceeds observation bounds");
  }
  const result: CgroupMembership = {};
  const lines = value.split(/\r?\n/);
  if (lines.length > 128) throw new Error("cgroup membership exceeds observation bounds");
  const assign = (key: keyof CgroupMembership, membership: string) => {
    if (result[key] !== undefined) throw new Error("duplicate cgroup controller membership");
    result[key] = membership;
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^(\d+):([^:]*):(.*)$/.exec(line);
    if (!match) throw new MalformedCgroupValueError("/proc/self/cgroup", line);
    const controllers = match[2]!.split(",").filter(Boolean);
    const hierarchyId = Number(match[1]);
    if (
      !Number.isSafeInteger(hierarchyId) ||
      (controllers.length > 0 && hierarchyId === 0) ||
      new Set(controllers).size !== controllers.length
    ) {
      throw new MalformedCgroupValueError("/proc/self/cgroup", line);
    }
    const membership = safeMembershipPath(match[3]!);
    if (controllers.length === 0) {
      if (match[1] !== "0") throw new MalformedCgroupValueError("/proc/self/cgroup", line);
      assign("v2", membership);
    }
    if (controllers.includes("cpu")) assign("v1Cpu", membership);
    if (controllers.includes("memory")) assign("v1Memory", membership);
  }
  return result;
}

/** Visible leaf through mount root, never siblings or paths above the mount. */
export function cgroupAncestors(membership: string | undefined): string[] {
  if (membership === undefined) return [];
  const safe = safeMembershipPath(`/${membership}`);
  const parts = safe ? safe.split("/") : [];
  return Array.from({ length: parts.length + 1 }, (_, index) =>
    parts.slice(0, parts.length - index).join("/"),
  );
}

export function parseCgroupV1Hierarchy(value: string, path: string): boolean {
  if (value.trim() === "1") return true;
  if (value.trim() === "0") return false;
  throw new MalformedCgroupValueError(path, value);
}

export function cgroupPath(root: string, membership: string | undefined, file: string): string {
  return [root.replace(/\/+$/, ""), membership, file].filter(Boolean).join("/");
}
