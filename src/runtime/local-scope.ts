import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { parseLocalScopeIdentity, type LocalScopeIdentity } from "../protocol/local-scope.js";
export { parseLocalScopeIdentity, type LocalScopeIdentity } from "../protocol/local-scope.js";
import { readLocalResourceHostIdentity } from "../recovery/local-resources.js";
import {
  startContainedProcess,
  type ContainedProcess,
  type StartProcessOptions,
  type ProcessResult,
} from "./process-group.js";

const exec = promisify(execFile);

export interface LocalScopeHost {
  hostIdentity: string;
  producerPid: number;
  producerStartTicks: string;
  producerUnit?: string;
  producerInvocationId?: string;
}

/** Optional local capability. A missing user manager preserves the portable
 * process-group backend; it does not fabricate scope-based recovery evidence. */
export async function discoverLocalScopeHost(): Promise<LocalScopeHost | null> {
  if (process.platform !== "linux") return null;
  try {
    const hostIdentity = await readLocalResourceHostIdentity();
    if (!hostIdentity) return null;
    const version = await exec("systemd-run", ["--version"], { timeout: 5_000, maxBuffer: 4_096 });
    const major = /^systemd (\d+)/.exec(version.stdout)?.[1];
    if (!major || Number(major) < 254) return null;
    await exec("systemctl", ["--user", "show", "--property=Version", "--value"], {
      timeout: 5_000,
      maxBuffer: 4_096,
    });
    const stat = await linuxLocalScopeReadPort.read("/proc/self/stat");
    const suffix = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const producerStartTicks = suffix[19];
    if (!/^\d{1,30}$/.test(producerStartTicks ?? "") || !stat.startsWith(`${process.pid} (`))
      return null;
    const groups = (await linuxLocalScopeReadPort.read("/proc/self/cgroup")).trim().split("\n");
    const unified = groups.filter((line) => line.startsWith("0::"));
    if (unified.length !== 1) return null;
    const group = unified[0]!.slice(3);
    const producerUnit = group.split("/").at(-1)!;
    let producer: Pick<LocalScopeHost, "producerUnit" | "producerInvocationId"> = {};
    if (producerUnit.endsWith(".service")) {
      if (!/^[A-Za-z0-9_.@:-]+\.service$/.test(producerUnit)) return null;
      const fields = parseProperties(
        await linuxLocalScopeReadPort.show(producerUnit),
        producerUnit,
      );
      if (
        fields.LoadState !== "loaded" ||
        fields.ActiveState !== "active" ||
        fields.KillMode !== "control-group" ||
        fields.ControlGroup !== group ||
        !/^[a-f0-9]{32}$/.test(fields.InvocationID ?? "")
      )
        return null;
      producer = { producerUnit, producerInvocationId: fields.InvocationID! };
    }
    return {
      hostIdentity,
      producerPid: process.pid,
      producerStartTicks: producerStartTicks!,
      ...producer,
    };
  } catch {
    return null;
  }
}
export function localScopeUnit(input: LocalScopeIdentity): string {
  const identity = parseLocalScopeIdentity(input);
  return `clockgrove-factory-work-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.scope`;
}

/** Scope mode preserves the already-sanitized child environment; no secret is put in a
 * systemd property or command line. The actual worker remains inside Codex's sandbox. */
export function scopedLocalCommand(
  identity: LocalScopeIdentity,
  command: string,
  args: readonly string[],
  runtimeMs?: number,
): { command: string; args: string[] } {
  if (!command || command.includes("\0") || args.some((arg) => arg.includes("\0"))) {
    throw new Error("invalid local scope command");
  }
  if (runtimeMs !== undefined && (!Number.isFinite(runtimeMs) || runtimeMs <= 0))
    throw new Error("local scope runtime must be positive and finite");
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--expand-environment=no",
      "--description=Factory owned local command",
      `--unit=${localScopeUnit(identity)}`,
      "--property=KillMode=control-group",
      ...(identity.producerUnit
        ? [
            `--property=Requisite=${identity.producerUnit}`,
            `--property=After=${identity.producerUnit}`,
            `--property=StopPropagatedFrom=${identity.producerUnit}`,
          ]
        : []),
      ...(runtimeMs === undefined
        ? []
        : [`--property=RuntimeMaxSec=${Math.max(1, Math.floor(runtimeMs))}ms`]),
      "--",
      command,
      ...args,
    ],
  };
}

export interface LocalScopeReadPort {
  hostIdentity(): Promise<string | null>;
  show(unit: string): Promise<string>;
  read(path: string): Promise<string>;
  now(): Date;
}
const properties = [
  "Id",
  "LoadState",
  "ActiveState",
  "SubState",
  "ControlGroup",
  "Job",
  "InvocationID",
  "KillMode",
];
export const linuxLocalScopeReadPort: LocalScopeReadPort = {
  hostIdentity: readLocalResourceHostIdentity,
  async show(unit) {
    try {
      const result = await exec(
        "systemctl",
        ["--user", "show", unit, `--property=${properties.join(",")}`, "--no-pager"],
        { timeout: 10_000, maxBuffer: 16_384 },
      );
      return result.stdout;
    } catch (error) {
      // systemctl may return 1/4 with a complete not-found property set. Absence is
      // accepted only after parsing that set, never from the exit code or stderr.
      const result = error as { code?: unknown; stdout?: unknown };
      if (
        [1, 4].includes(Number(result.code)) &&
        typeof result.stdout === "string" &&
        result.stdout.length <= 16_384
      )
        return result.stdout;
      throw new Error("local scope manager observation unavailable");
    }
  },
  async read(path) {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(262_145);
      let size = 0;
      while (size < buffer.length) {
        const result = await file.read(buffer, size, buffer.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > 262_144) throw new Error("local scope observation exceeds bound");
      return buffer.subarray(0, size).toString("utf8");
    } finally {
      await file.close();
    }
  },
  now: () => new Date(),
};

export interface LocalScopeObservation {
  status: "absent" | "active" | "unknown";
  reason:
    | "host-unavailable"
    | "host-mismatch"
    | "manager-unavailable"
    | "scope-busy"
    | "scope-empty"
    | "scope-missing"
    | "observation-changed";
  identityDigest: string;
  evidenceDigest: string;
  observedAt: string;
  unit: string;
}

export interface LocalScopeProcessPort extends LocalScopeReadPort {
  start(options: StartProcessOptions): ContainedProcess;
  stop(unit: string): Promise<void>;
}

export interface ScopedLocalProcessOptions extends StartProcessOptions {
  launchDeadline?: Date;
}

export const linuxLocalScopeProcessPort: LocalScopeProcessPort = {
  ...linuxLocalScopeReadPort,
  start: startContainedProcess,
  async stop(unit) {
    await exec("systemctl", ["--user", "stop", unit], {
      timeout: 10_000,
      maxBuffer: 16_384,
    });
  },
};

export class LocalScopeCleanupError extends Error {
  constructor(
    readonly scope: LocalScopeIdentity,
    readonly result: ProcessResult,
  ) {
    super("owned local command ended but its complete resource cleanup is unverified");
    this.name = "LocalScopeCleanupError";
  }
}

export async function assertLocalScopeLaunch(
  input: LocalScopeIdentity,
  deadline?: Date,
  port: LocalScopeReadPort = linuxLocalScopeReadPort,
): Promise<void> {
  const identity = parseLocalScopeIdentity(input);
  const before = await observeLocalScope(identity, port);
  if (before.status !== "absent") throw new Error("owned local scope is not available for launch");
  if (identity.producerUnit) {
    const producer = parseProperties(await port.show(identity.producerUnit), identity.producerUnit);
    if (
      producer.LoadState !== "loaded" ||
      producer.ActiveState !== "active" ||
      producer.KillMode !== "control-group" ||
      producer.InvocationID !== identity.producerInvocationId ||
      !["", "0", "0 /"].includes(producer.Job!)
    ) {
      throw new Error("local scope producer generation is no longer active");
    }
  }
  if (deadline) {
    const remaining = deadline.getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new Error("local scope launch deadline expired");
  }
}

export async function stopLocalScope(
  input: LocalScopeIdentity,
  port: Pick<LocalScopeProcessPort, keyof LocalScopeReadPort | "stop"> = linuxLocalScopeProcessPort,
): Promise<void> {
  const identity = parseLocalScopeIdentity(input);
  const state = await observeLocalScope(identity, port);
  if (state.status === "unknown") throw new Error("owned local scope cleanup unavailable");
  if (state.status === "active") {
    await port.stop(localScopeUnit(identity)).catch(() => {
      throw new Error("owned local scope stop unavailable");
    });
  }
  if ((await observeLocalScope(identity, port)).status !== "absent")
    throw new Error("owned local scope cleanup unverified");
}

/** Starts only after the caller has journaled and fenced this launch. Scope absence
 * is a duplicate-launch guard, not a substitute for that durable authorization. */
export async function startScopedLocalProcess(
  input: LocalScopeIdentity,
  options: ScopedLocalProcessOptions,
  port: LocalScopeProcessPort = linuxLocalScopeProcessPort,
): Promise<ContainedProcess> {
  const identity = parseLocalScopeIdentity(input);
  await assertLocalScopeLaunch(identity, options.launchDeadline, port);
  if (options.launchDeadline)
    options = {
      ...options,
      timeoutMs: Math.min(options.timeoutMs, options.launchDeadline.getTime() - Date.now()),
    };
  const command = scopedLocalCommand(
    identity,
    options.command,
    options.args ?? [],
    options.timeoutMs,
  );
  const stopOwned = () => stopLocalScope(identity, port);
  const child = port.start({ ...options, ...command, terminateDescendants: stopOwned });
  const completed = child.completed.then(async (result) => {
    // A worker/test can daemonize out of its original process group. Stop only
    // this content-bound scope, then require an independently observed empty tree.
    const observation = await observeLocalScope(identity, port);
    if (observation.status === "active") {
      await port.stop(localScopeUnit(identity)).catch(() => undefined);
    }
    if ((await observeLocalScope(identity, port)).status !== "absent") {
      throw new LocalScopeCleanupError(identity, result);
    }
    return result;
  });
  // Callers may install observation handlers after launch returns.
  void completed.catch(() => undefined);
  return {
    pid: child.pid,
    completed,
    async cancel(signal) {
      let failed = false;
      await child.cancel(signal).catch(() => {
        failed = true;
      });
      await completed;
      if (failed) throw new Error("owned local command cancellation failed");
    },
  };
}

export async function runScopedLocalProcess(
  identity: LocalScopeIdentity,
  options: ScopedLocalProcessOptions,
  port: LocalScopeProcessPort = linuxLocalScopeProcessPort,
): Promise<ProcessResult> {
  return (await startScopedLocalProcess(identity, options, port)).completed;
}

function parseProperties(text: string, unit: string): Record<string, string> {
  if (Buffer.byteLength(text) > 16_384) throw new Error("scope property bound");
  const fields: Record<string, string> = {};
  for (const line of text.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("malformed scope property");
    const key = line.slice(0, separator);
    if (!properties.includes(key) || Object.hasOwn(fields, key))
      throw new Error("unexpected scope property");
    fields[key] = line.slice(separator + 1);
  }
  if (
    fields.Id !== unit ||
    !fields.LoadState ||
    !fields.ActiveState ||
    fields.Job === undefined ||
    fields.ControlGroup === undefined
  )
    throw new Error("incomplete scope properties");
  return fields;
}

/** Point observation of an exact, already-authorized scope on the original Linux
 * user/boot/namespace. Callers must still fence the producer and reconcile pending launch.
 * This does not infer that an arbitrary old marker-based process ever ran in this scope. */
export async function observeLocalScope(
  input: LocalScopeIdentity,
  port: LocalScopeReadPort = linuxLocalScopeReadPort,
): Promise<LocalScopeObservation> {
  const identity = parseLocalScopeIdentity(input);
  const unit = localScopeUnit(identity);
  const identityDigest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const finish = (
    status: LocalScopeObservation["status"],
    reason: LocalScopeObservation["reason"],
    witness: unknown = null,
  ): LocalScopeObservation => ({
    status,
    reason,
    unit,
    identityDigest,
    evidenceDigest: createHash("sha256")
      .update(JSON.stringify([identityDigest, status, reason, witness]))
      .digest("hex"),
    observedAt: port.now().toISOString(),
  });
  const host = await port.hostIdentity().catch(() => null);
  if (!host) return finish("unknown", "host-unavailable");
  if (host !== identity.hostIdentity) return finish("unknown", "host-mismatch");
  try {
    const before = parseProperties(await port.show(unit), unit);
    const noJob = before.Job === "" || before.Job === "0" || before.Job === "0 /";
    if (!noJob || ["activating", "deactivating", "reloading"].includes(before.ActiveState!))
      return finish("active", "scope-busy", before);
    let absent: "scope-empty" | "scope-missing";
    if (
      before.LoadState === "not-found" &&
      before.ActiveState === "inactive" &&
      before.ControlGroup === ""
    ) {
      absent = "scope-missing";
    } else {
      if (
        before.LoadState !== "loaded" ||
        before.KillMode !== "control-group" ||
        !/^[a-f0-9]{32}$/.test(before.InvocationID ?? "")
      )
        throw new Error("scope identity unavailable");
      const group = before.ControlGroup!;
      if (
        !group.startsWith("/") ||
        group === "/" ||
        group.includes("\0") ||
        group
          .split("/")
          .slice(1)
          .some((part) => !part || part === "." || part === "..") ||
        group.split("/").at(-1) !== unit
      )
        throw new Error("unsafe scope cgroup path");
      const mount = (await port.read("/proc/self/mountinfo")).split("\n").filter((line) => {
        const fields = line.split(" ");
        return (
          fields[4] === "/sys/fs/cgroup" &&
          fields[3] === "/" &&
          fields[fields.indexOf("-") + 1] === "cgroup2"
        );
      });
      if (mount.length !== 1) throw new Error("unified cgroup view unavailable");
      const values = (await port.read(`/sys/fs/cgroup${group}/cgroup.events`)).trim().split("\n");
      const populated = values.filter((line) => /^populated [01]$/.test(line));
      if (populated.length !== 1 || values.some((line) => !/^[a-z_]+ \d+$/.test(line)))
        throw new Error("malformed cgroup evidence");
      if (populated[0] === "populated 1") return finish("active", "scope-busy", before);
      absent = "scope-empty";
    }
    const after = parseProperties(await port.show(unit), unit);
    if (JSON.stringify(before) !== JSON.stringify(after) || (await port.hostIdentity()) !== host)
      return finish("unknown", "observation-changed");
    return finish("absent", absent, before);
  } catch {
    return finish("unknown", "manager-unavailable");
  }
}
