import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readLocalResourceHostIdentity } from "../recovery/local-resources.js";

const exec = promisify(execFile);
const SYSTEMCTL = "/usr/bin/systemctl";
const MAX_PROPERTY_BYTES = 16_384;
const MAX_PROC_BYTES = 4_096;
const MAX_UNIT_BYTES = 65_536;
const FACTORY_UNIT_MARKER = "# Managed by Clockgrove Factory";
const PROPERTIES = [
  "Id",
  "LoadState",
  "ActiveState",
  "SubState",
  "Job",
  "ControlGroup",
  "InvocationID",
  "KillMode",
  "MainPID",
  "FragmentPath",
  "DropInPaths",
  "NeedDaemonReload",
] as const;

export interface ManagedServiceControllerGeneration {
  kind: "managed-service";
  hostIdentity: string;
  configDigest: string;
  executableIdentity: string;
  unit: string;
  invocationId: string;
}

export interface ManagedControllerGenerationReadPort {
  platform: string;
  pid: number;
  hostIdentity(): Promise<string | null>;
  show(unit: string): Promise<string>;
  read(path: string, maxBytes: number): Promise<Buffer>;
}

export const linuxManagedControllerGenerationReadPort: ManagedControllerGenerationReadPort = {
  platform: process.platform,
  pid: process.pid,
  hostIdentity: readLocalResourceHostIdentity,
  async show(unit) {
    const uid = process.getuid?.();
    if (uid === undefined || process.geteuid?.() !== uid) {
      throw new Error("managed controller user identity unavailable");
    }
    const result = await exec(
      SYSTEMCTL,
      ["--user", "show", unit, `--property=${PROPERTIES.join(",")}`, "--no-pager"],
      {
        timeout: 5_000,
        maxBuffer: MAX_PROPERTY_BYTES,
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          XDG_RUNTIME_DIR: `/run/user/${uid}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
        },
      },
    );
    return result.stdout;
  },
  read: readBoundedRegularFile,
};

/**
 * Proves that this exact process is the stable MainPID of the expected installed
 * Factory service generation. A failed or incomplete proof is not an unmanaged
 * fallback: callers receive no generation suitable for repository ownership.
 */
export async function observeManagedControllerGeneration(
  input: { expectedUnit: string; expectedFragmentPath: string; executableIdentity: string },
  port: ManagedControllerGenerationReadPort = linuxManagedControllerGenerationReadPort,
): Promise<ManagedServiceControllerGeneration | null> {
  if (
    port.platform !== "linux" ||
    !/^clockgrove-factory-[a-f0-9]{16}\.service$/.test(input.expectedUnit) ||
    !validFragmentPath(input.expectedFragmentPath, input.expectedUnit) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.executableIdentity) ||
    !Number.isSafeInteger(port.pid) ||
    port.pid < 1
  )
    return null;

  try {
    const hostBefore = await port.hostIdentity();
    if (!hostBefore || !/^[a-f0-9]{64}$/.test(hostBefore)) return null;

    const statBefore = await port.read("/proc/self/stat", MAX_PROC_BYTES);
    const startTicks = processStartTicks(statBefore, port.pid);
    if (!startTicks) return null;

    const cgroupBefore = await port.read("/proc/self/cgroup", MAX_PROC_BYTES);
    const processCgroup = unifiedCgroup(cgroupBefore);
    if (!processCgroup) return null;

    const fieldsBefore = parseProperties(await port.show(input.expectedUnit), input.expectedUnit);
    if (!validServiceState(fieldsBefore, input.expectedUnit, port.pid, processCgroup)) return null;

    const fragmentPath = fieldsBefore.FragmentPath!;
    if (
      fragmentPath !== input.expectedFragmentPath ||
      fieldsBefore.DropInPaths !== "" ||
      fieldsBefore.NeedDaemonReload !== "no"
    )
      return null;
    const configBefore = await port.read(fragmentPath, MAX_UNIT_BYTES);
    if (!validFactoryUnit(configBefore, input.executableIdentity)) return null;

    const fieldsAfter = parseProperties(await port.show(input.expectedUnit), input.expectedUnit);
    const statAfter = await port.read("/proc/self/stat", MAX_PROC_BYTES);
    const cgroupAfter = await port.read("/proc/self/cgroup", MAX_PROC_BYTES);
    const configAfter = await port.read(fragmentPath, MAX_UNIT_BYTES);
    const hostAfter = await port.hostIdentity();

    if (
      !PROPERTIES.every((property) => fieldsAfter[property] === fieldsBefore[property]) ||
      !cgroupAfter.equals(cgroupBefore) ||
      !configAfter.equals(configBefore) ||
      hostAfter !== hostBefore ||
      processStartTicks(statAfter, port.pid) !== startTicks ||
      unifiedCgroup(cgroupAfter) !== processCgroup ||
      !validServiceState(fieldsAfter, input.expectedUnit, port.pid, processCgroup) ||
      !validFactoryUnit(configAfter, input.executableIdentity)
    )
      return null;

    return {
      kind: "managed-service",
      hostIdentity: hostBefore,
      configDigest: createHash("sha256").update(configBefore).digest("hex"),
      executableIdentity: input.executableIdentity,
      unit: input.expectedUnit,
      invocationId: fieldsBefore.InvocationID!,
    };
  } catch {
    return null;
  }
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("managed generation evidence is not a file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error("managed generation evidence exceeds bound");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

function parseProperties(text: string, unit: string): Record<string, string> {
  if (Buffer.byteLength(text) > MAX_PROPERTY_BYTES)
    throw new Error("property evidence exceeds bound");
  const fields: Record<string, string> = {};
  for (const line of text.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (
      separator < 1 ||
      !(PROPERTIES as readonly string[]).includes(key) ||
      Object.hasOwn(fields, key)
    )
      throw new Error("malformed managed service properties");
    fields[key] = line.slice(separator + 1);
  }
  if (PROPERTIES.some((property) => fields[property] === undefined) || fields.Id !== unit)
    throw new Error("incomplete managed service properties");
  return fields;
}

function validServiceState(
  fields: Record<string, string>,
  unit: string,
  pid: number,
  processCgroup: string,
): boolean {
  return (
    fields.Id === unit &&
    fields.LoadState === "loaded" &&
    fields.ActiveState === "active" &&
    fields.SubState === "running" &&
    ["", "0", "0 /"].includes(fields.Job ?? "missing") &&
    fields.ControlGroup === processCgroup &&
    processCgroup.split("/").at(-1) === unit &&
    fields.MainPID === String(pid) &&
    /^[a-f0-9]{32}$/.test(fields.InvocationID ?? "") &&
    fields.KillMode === "control-group"
  );
}

function unifiedCgroup(value: Buffer): string | null {
  if (value.length > MAX_PROC_BYTES) return null;
  const lines = value.toString("utf8").trimEnd().split("\n");
  if (lines.length !== 1) return null;
  const match = /^0::(\/[^\n\0]+)$/.exec(lines[0]!);
  if (!match) return null;
  const group = match[1]!;
  if (
    group === "/" ||
    group
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  )
    return null;
  return group;
}

function processStartTicks(value: Buffer, pid: number): string | null {
  if (value.length > MAX_PROC_BYTES) return null;
  const text = value.toString("utf8").trim();
  if (!text.startsWith(`${pid} (`)) return null;
  const close = text.lastIndexOf(")");
  if (close < `${pid} (`.length || text[close + 1] !== " ") return null;
  const fields = text.slice(close + 2).split(/\s+/);
  const startTicks = fields[19];
  return /^\d{1,30}$/.test(startTicks ?? "") ? startTicks! : null;
}

function validFragmentPath(path: string, unit: string): boolean {
  return (
    path.length <= 4_096 &&
    !path.includes("\0") &&
    !path.includes("\n") &&
    isAbsolute(path) &&
    normalize(path) === path &&
    basename(path) === unit
  );
}

function validFactoryUnit(value: Buffer, executableIdentity: string): boolean {
  if (value.length > MAX_UNIT_BYTES) return false;
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value) || !text.startsWith(`${FACTORY_UNIT_MARKER}\n`))
    return false;
  return (
    text.split("\n").filter((line) => line.startsWith("# FactoryExecutableIdentity=")).length ===
      1 && text.split("\n").includes(`# FactoryExecutableIdentity=${executableIdentity}`)
  );
}
