import { createHash } from "node:crypto";
import { LocalScopeBatchSchema, type LocalScopeBatch } from "../protocol/local-scope.js";
import {
  linuxLocalScopeReadPort,
  observeLocalScope,
  type LocalScopeReadPort,
} from "../runtime/local-scope.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface LocalScopeBatchObservation {
  status: "absent" | "active" | "unknown";
  reason:
    | "producer-active"
    | "scope-active"
    | "original-producer-and-scopes-absent"
    | "observation-unavailable";
  identityDigest: string;
  evidenceDigest: string;
  observedAt: string;
}

/** Read only the exact original producer PID, never unrelated process environments.
 * Absence of the scope by itself cannot discharge a delayed producer launch. */
async function producerAbsent(batch: LocalScopeBatch, port: LocalScopeReadPort): Promise<boolean> {
  try {
    const stat = await port.read(`/proc/${batch.producerPid}/stat`);
    if (!stat.startsWith(`${batch.producerPid} (`) || !stat.includes(") "))
      throw new Error("producer stat malformed");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (!/^[0-9]{1,30}$/.test(fields[19] ?? "") || !/^[A-Za-z]$/.test(fields[0] ?? ""))
      throw new Error("producer stat incomplete");
    if (fields[19] === batch.producerStartTicks && !["Z", "X", "x"].includes(fields[0]!))
      return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { producerUnit, producerInvocationId } = batch.identity;
  // A foreground producer can die after forking a launcher but before that
  // launcher registers its scope. PID absence does not fence that child. Only
  // a recorded manager-owned producer domain can exclude this pending launch.
  if (!producerUnit) throw new Error("pre-registration launcher ownership unavailable");
  const text = await port.show(producerUnit);
  if (Buffer.byteLength(text) > 16_384) throw new Error("producer property bound");
  const fields: Record<string, string> = {};
  for (const line of text.trim().split("\n")) {
    const index = line.indexOf("=");
    if (index < 1 || Object.hasOwn(fields, line.slice(0, index)))
      throw new Error("producer properties malformed");
    fields[line.slice(0, index)] = line.slice(index + 1);
  }
  if (fields.Id !== producerUnit || fields.Job === undefined || fields.ControlGroup === undefined)
    throw new Error("producer properties incomplete");
  if (!["", "0", "0 /"].includes(fields.Job)) return false;
  if (
    fields.LoadState === "not-found" &&
    fields.ActiveState === "inactive" &&
    fields.ControlGroup === ""
  )
    return true;
  if (fields.LoadState !== "loaded" || !/^[a-f0-9]{32}$/.test(fields.InvocationID ?? ""))
    throw new Error("producer generation unavailable");
  if (fields.InvocationID !== producerInvocationId) return true;
  return ["inactive", "failed"].includes(fields.ActiveState ?? "") && fields.ControlGroup === "";
}

export async function observeLocalScopeBatch(
  input: LocalScopeBatch,
  port: LocalScopeReadPort = linuxLocalScopeReadPort,
): Promise<LocalScopeBatchObservation> {
  const batch = LocalScopeBatchSchema.parse(input);
  const identityDigest = digest(batch);
  const finish = (
    status: LocalScopeBatchObservation["status"],
    reason: LocalScopeBatchObservation["reason"],
  ): LocalScopeBatchObservation => ({
    status,
    reason,
    identityDigest,
    // Normalize equivalent absence witnesses so garbage collection/PID reuse
    // cannot invalidate a claim after fresh checks prove the same original resources gone.
    evidenceDigest: digest([identityDigest, status, reason]),
    observedAt: port.now().toISOString(),
  });
  const began = port.now().getTime();
  try {
    if ((await port.hostIdentity()) !== batch.identity.hostIdentity)
      throw new Error("original host unavailable");
    if (!(await producerAbsent(batch, port))) return finish("active", "producer-active");
    for (let commandIndex = 0; commandIndex < batch.commandCount; commandIndex++) {
      if (port.now().getTime() - began > 30_000)
        throw new Error("scope batch observation deadline");
      const observed = await observeLocalScope({ ...batch.identity, commandIndex }, port);
      if (observed.status === "active") return finish("active", "scope-active");
      if (observed.status !== "absent") throw new Error("scope absence unavailable");
    }
    if ((await port.hostIdentity()) !== batch.identity.hostIdentity)
      throw new Error("original host changed");
    if (!(await producerAbsent(batch, port))) return finish("active", "producer-active");
    return finish("absent", "original-producer-and-scopes-absent");
  } catch {
    return finish("unknown", "observation-unavailable");
  }
}
