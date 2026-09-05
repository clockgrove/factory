import { createHash, createHmac } from "node:crypto";
import { open, opendir, readlink } from "node:fs/promises";
import type { StaleAttemptIdentity } from "../execution/backend.js";
import { durableAttemptId, legacyDurableAttemptId } from "../execution/session.js";

const MAX_PIDS = 16_384;
const MAX_ENV = 262_144;
const MAX_TOTAL = 32 * 1024 * 1024;

/** Low-level read seam for deterministic fixtures, not an injectable resource verdict. */
export interface LocalResourceReader {
  platform: string;
  uid: number | null;
  read(path: string, maxBytes: number): Promise<Buffer>;
  link(path: string): Promise<string>;
  pids(limit: number): Promise<number[]>;
  now(): Date;
}

const linuxReader: LocalResourceReader = {
  platform: process.platform,
  uid: process.getuid?.() === process.geteuid?.() ? (process.getuid?.() ?? null) : null,
  async read(path, maxBytes) {
    const file = await open(path, "r");
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= maxBytes) {
        const chunk = Buffer.alloc(Math.min(8192, maxBytes + 1 - total));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) return Buffer.concat(chunks);
        total += bytesRead;
        if (total > maxBytes) throw new Error("local evidence byte bound");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      throw new Error("local evidence byte bound");
    } finally {
      await file.close();
    }
  },
  link: readlink,
  async pids(limit) {
    const result: number[] = [];
    const directory = await opendir("/proc");
    for await (const entry of directory) {
      if (!/^[1-9]\d*$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!Number.isSafeInteger(pid) || result.length >= limit)
        throw new Error("local evidence process bound");
      result.push(pid);
    }
    return result.sort((a, b) => a - b);
  },
  now: () => new Date(),
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function hostIdentity(reader: LocalResourceReader): Promise<string> {
  if (reader.platform !== "linux" || reader.uid === null || !Number.isSafeInteger(reader.uid))
    throw new Error("local host unavailable");
  const machine = (await reader.read("/etc/machine-id", 128)).toString().trim();
  const boot = (await reader.read("/proc/sys/kernel/random/boot_id", 128)).toString().trim();
  if (!/^[a-f0-9]{32}$/.test(machine) || !/^[a-f0-9-]{36}$/.test(boot))
    throw new Error("local host identity malformed");
  const namespaces = await Promise.all(
    ["pid", "user", "mnt"].map((name) => reader.link(`/proc/self/ns/${name}`)),
  );
  if (
    namespaces.some(
      (value, index) => !new RegExp(`^${["pid", "user", "mnt"][index]}:\\[\\d+\\]$`).test(value),
    )
  )
    throw new Error("local namespace unavailable");
  // Application-specific keyed hash: raw machine ID/UID and namespace identities never leave here.
  return createHmac("sha256", "clockgrove.factory/local-resource-host-v1")
    .update(JSON.stringify([machine, reader.uid, boot, ...namespaces]))
    .digest("hex");
}

/** New launches bind to this exact Linux user/boot/namespace; legacy receipts remain unbound. */
export async function readLocalResourceHostIdentity(
  reader: LocalResourceReader = linuxReader,
): Promise<string | null> {
  return hostIdentity(reader).catch(() => null);
}

export interface LocalRecoveryResourceObservation {
  status: "absent" | "active" | "unknown";
  identityDigest: string;
  evidenceDigest: string;
  hostIdentity: string | null;
  observedAt: string;
  reason:
    | "identity-invalid"
    | "host-unbound"
    | "host-unavailable"
    | "host-mismatch"
    | "process-observation-unavailable"
    | "legacy-marker"
    | "pid-reused"
    | "matching-process"
    | "complete-scan-absent";
}

export function localRecoveryResourceIdentityDigest(input: {
  identity: StaleAttemptIdentity;
  expectedHostIdentity: string | null;
}): string {
  const identity = input.identity;
  return digest([
    "clockgrove.factory/local-resource-identity-v1",
    identity.repository.toLowerCase(),
    identity.objective,
    identity.workItem,
    identity.attempt,
    identity.runId,
    identity.directorEpoch,
    identity.phase ?? "execution",
    identity.providerResourceId ?? null,
    input.expectedHostIdentity,
  ]);
}

/** Read-only point observation under trusted-local marker assumptions, never cleanup or launch authority.
 * /proc environ is ptrace-gated and stat field 22 identifies PID reuse:
 * https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html
 * https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
 */
export async function observeLocalRecoveryResource(
  input: { identity: StaleAttemptIdentity; expectedHostIdentity: string | null },
  reader: LocalResourceReader = linuxReader,
): Promise<LocalRecoveryResourceObservation> {
  const identity = input.identity;
  const identityDigest = localRecoveryResourceIdentityDigest(input);
  let currentHost: string | null = null;
  const witnesses: string[] = [];
  const finish = (
    status: LocalRecoveryResourceObservation["status"],
    reason: LocalRecoveryResourceObservation["reason"],
  ): LocalRecoveryResourceObservation => {
    const observedAt = reader.now().toISOString();
    return {
      status,
      reason,
      identityDigest,
      hostIdentity: currentHost,
      observedAt,
      evidenceDigest: digest([
        "clockgrove.factory/local-resource-observation-v1",
        identityDigest,
        currentHost,
        status,
        reason,
        witnesses,
      ]),
    };
  };
  if (
    ![identity.objective, identity.workItem, identity.attempt, identity.directorEpoch].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !identity.runId ||
    identity.runId.length > 200 ||
    identity.phase === "validation"
  )
    return finish("unknown", "identity-invalid");
  if (!input.expectedHostIdentity || !/^[a-f0-9]{64}$/.test(input.expectedHostIdentity))
    return finish("unknown", "host-unbound");
  currentHost = await readLocalResourceHostIdentity(reader);
  if (!currentHost) return finish("unknown", "host-unavailable");
  if (currentHost !== input.expectedHostIdentity) return finish("unknown", "host-mismatch");
  try {
    const marker = `FACTORY_ATTEMPT_ID=${durableAttemptId(identity)}`;
    const legacy = [
      `FACTORY_ATTEMPT_ID=${legacyDurableAttemptId(identity)}`,
      `FACTORY_ATTEMPT_ID=${`factory-o${identity.objective}-w${identity.workItem}-a${identity.attempt}-${identity.runId.slice(0, 12)}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 63)}`,
    ];
    let total = 0;
    const read = async (path: string, limit: number) => {
      const value = await reader.read(path, limit);
      total += value.length;
      if (value.length > limit || total > MAX_TOTAL) throw new Error("local evidence byte bound");
      return value.toString("utf8");
    };
    const mount = (await read("/proc/self/mountinfo", 262_144))
      .split("\n")
      .filter((line) => line.split(" ")[4] === "/proc");
    if (mount.length !== 1) throw new Error("proc view unavailable");
    const fields = mount[0]!.split(" ");
    const separator = fields.indexOf("-");
    if (
      fields[3] !== "/" ||
      fields[separator + 1] !== "proc" ||
      fields.some((field) =>
        field.split(",").some((option) => option.startsWith("hidepid=") && option !== "hidepid=0"),
      )
    )
      throw new Error("proc view restricted");
    const pids = await reader.pids(MAX_PIDS);
    if (
      pids.length > MAX_PIDS ||
      new Set(pids).size !== pids.length ||
      pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
    )
      throw new Error("proc view malformed");
    const hinted = /^local-([1-9]\d*)$/.exec(identity.providerResourceId ?? "");
    if (
      identity.providerResourceId &&
      !hinted &&
      identity.providerResourceId !== `sdk-${durableAttemptId(identity).slice(0, 24)}`
    )
      return finish("unknown", "identity-invalid");
    let uncertain = false;
    let legacyFound = false;
    let reused = false;
    for (const pid of pids) {
      try {
        const status = await read(`/proc/${pid}/status`, 65_536);
        const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
        if (!uid) throw new Error("process owner unavailable");
        if (!uid.slice(1).some((value) => Number(value) === reader.uid)) {
          if (hinted && Number(hinted[1]) === pid) reused = true;
          continue;
        }
        const start = (text: string) => {
          if (!text.startsWith(`${pid} (`)) throw new Error("process identity malformed");
          const fields = text
            .slice(text.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
          if (!/^[1-9]\d*$/.test(fields[19] ?? "")) throw new Error("process birth unavailable");
          return fields[19]!;
        };
        const before = start(await read(`/proc/${pid}/stat`, 8192));
        const environment = (await read(`/proc/${pid}/environ`, MAX_ENV)).split("\0");
        const after = start(await read(`/proc/${pid}/stat`, 8192));
        if (before !== after) throw new Error("process identity changed");
        if (environment.includes(marker)) {
          witnesses.push(digest([pid, before]));
          return finish("active", "matching-process");
        }
        if (legacy.some((value) => environment.includes(value))) legacyFound = true;
        if (hinted && Number(hinted[1]) === pid) reused = true;
      } catch {
        uncertain = true;
      }
    }
    if (legacyFound) return finish("unknown", "legacy-marker");
    if (reused) return finish("unknown", "pid-reused");
    if (
      uncertain ||
      JSON.stringify(pids) !== JSON.stringify(await reader.pids(MAX_PIDS)) ||
      (await readLocalResourceHostIdentity(reader)) !== currentHost
    )
      return finish("unknown", "process-observation-unavailable");
    return finish("absent", "complete-scan-absent");
  } catch {
    return finish("unknown", "process-observation-unavailable");
  }
}
