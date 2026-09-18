import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const MAX_ARM_LIFETIME_MS = 5 * 60_000;
const CHECK_INTERVAL_MS = 50;

const Unit = z.string().regex(/^clockgrove-factory-[a-f0-9]{16}\.service$/);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CheckpointId = z.string().regex(/^[a-f0-9]{32}$/);
const Repository = z.string().regex(/^[^/\s]+\/[^/\s]+$/);

const LifecycleQualificationArm = z
  .object({
    protocol: z.literal("clockgrove.factory/lifecycle-checkpoint-arm"),
    checkpointId: CheckpointId,
    artifactIdentity: Digest,
    effectiveUid: z.number().int().nonnegative(),
    unit: Unit,
    repository: Repository,
    checkout: z.string().min(1).max(4096),
    requestId: z.string().min(1).max(200),
    operation: z.enum(["install", "start", "stop", "restart", "status", "uninstall"]),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const LifecycleQualificationRelease = z
  .object({
    protocol: z.literal("clockgrove.factory/lifecycle-checkpoint-release"),
    checkpointId: CheckpointId,
    armDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const LIFECYCLE_QUALIFICATION_ARM_ENV = "FACTORY_LIFECYCLE_QUALIFICATION_ARM";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function lifecycleQualificationArmPath(runtimeDirectory: string, unit: string): string {
  Unit.parse(unit);
  return `${runtimeDirectory}/.${unit}.lifecycle-qualification-arm.json`;
}

export function lifecycleQualificationSidecarPaths(
  runtimeDirectory: string,
  unit: string,
  checkpointId: string,
): { reached: string; release: string; consumed: string } {
  Unit.parse(unit);
  CheckpointId.parse(checkpointId);
  const prefix = `${runtimeDirectory}/.${unit}.lifecycle-qualification-${checkpointId}`;
  return {
    reached: `${prefix}.reached.json`,
    release: `${prefix}.release.json`,
    consumed: `${prefix}.consumed.json`,
  };
}

async function privateBytes(path: string, uid: number): Promise<Buffer> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== uid ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 16_384
    ) {
      throw new Error("lifecycle qualification file is not bounded private owner data");
    }
    const bytes = Buffer.alloc(before.size + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      read.bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("lifecycle qualification file changed during read");
    }
    return bytes.subarray(0, before.size);
  } finally {
    await handle.close();
  }
}

async function optionalPrivateBytes(path: string, uid: number): Promise<Buffer | undefined> {
  try {
    return await privateBytes(path, uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeExclusivePrivate(path: string, value: unknown): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function processStartTicks(pid: number): Promise<string> {
  const stat = await open(`/proc/${pid}/stat`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const text = await stat.readFile("utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const ticks = fields[19];
    if (!ticks || !/^[0-9]+$/.test(ticks)) {
      throw new Error("lifecycle qualification process birth identity unavailable");
    }
    return ticks;
  } finally {
    await stat.close();
  }
}

/**
 * Qualification-only one-shot hold at the caller's already-acquired production lock.
 * No opt-in environment path is an immediate no-op. This grants no lifecycle authority:
 * the original validated install resumes only after an exact private release appears.
 */
export async function holdLifecycleQualificationCheckpoint(args: {
  configuredArmPath: string | undefined;
  runtimeDirectory: string;
  effectiveUid: number;
  unit: string;
  lockPath: string;
  repository: string;
  checkout: string;
  requestId: string | undefined;
  artifactIdentity: string;
}): Promise<void> {
  if (!args.configuredArmPath) return;
  const armPath = lifecycleQualificationArmPath(args.runtimeDirectory, args.unit);
  if (args.configuredArmPath !== armPath) {
    throw new Error("controller-lifecycle-qualification-invalid: arm path differs from unit");
  }
  const runtime = await lstat(args.runtimeDirectory);
  if (
    !runtime.isDirectory() ||
    runtime.isSymbolicLink() ||
    runtime.uid !== args.effectiveUid ||
    (runtime.mode & 0o077) !== 0
  ) {
    throw new Error(
      "controller-lifecycle-qualification-invalid: runtime directory is not private owner storage",
    );
  }
  const armBytes = await privateBytes(armPath, args.effectiveUid);
  let arm: z.infer<typeof LifecycleQualificationArm>;
  try {
    arm = LifecycleQualificationArm.parse(JSON.parse(armBytes.toString("utf8")));
  } catch (error) {
    throw new Error("controller-lifecycle-qualification-invalid: malformed arm", { cause: error });
  }
  const now = Date.now;
  const createdAt = Date.parse(arm.createdAt);
  const expiresAt = Date.parse(arm.expiresAt);
  const current = now();
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > MAX_ARM_LIFETIME_MS ||
    current < createdAt ||
    current >= expiresAt
  ) {
    throw new Error(
      "controller-lifecycle-qualification-expired: arm is outside its bounded window",
    );
  }
  const paths = lifecycleQualificationSidecarPaths(
    args.runtimeDirectory,
    args.unit,
    arm.checkpointId,
  );
  if (
    (await optionalPrivateBytes(paths.reached, args.effectiveUid)) !== undefined ||
    (await optionalPrivateBytes(paths.consumed, args.effectiveUid)) !== undefined
  ) {
    throw new Error("controller-lifecycle-qualification-replayed: checkpoint is already terminal");
  }
  const armDigest = hash(armBytes);
  if (
    arm.artifactIdentity !== args.artifactIdentity ||
    arm.effectiveUid !== args.effectiveUid ||
    arm.unit !== args.unit ||
    arm.repository.toLowerCase() !== args.repository.toLowerCase() ||
    resolve(arm.checkout) !== resolve(args.checkout) ||
    arm.requestId !== args.requestId ||
    arm.operation !== "install"
  ) {
    await writeExclusivePrivate(paths.consumed, {
      protocol: "clockgrove.factory/lifecycle-checkpoint-consumed",
      checkpointId: arm.checkpointId,
      armDigest,
      outcome: "binding-mismatch",
      consumedAt: new Date(current).toISOString(),
    });
    throw new Error(
      "controller-lifecycle-qualification-invalid: arm differs from current install binding",
    );
  }
  const reachedAt = now();
  if (reachedAt >= expiresAt) {
    throw new Error("controller-lifecycle-qualification-expired: arm expired before reach");
  }
  if (!(await privateBytes(armPath, args.effectiveUid)).equals(armBytes)) {
    throw new Error("controller-lifecycle-qualification-invalid: arm changed before reach");
  }
  const reached = {
    protocol: "clockgrove.factory/lifecycle-checkpoint-reached",
    checkpointId: arm.checkpointId,
    armDigest,
    artifactIdentity: args.artifactIdentity,
    effectiveUid: args.effectiveUid,
    unit: args.unit,
    repository: args.repository.toLowerCase(),
    checkout: resolve(args.checkout),
    requestId: args.requestId,
    operation: "install",
    lockPath: args.lockPath,
    clientPid: process.pid,
    clientStartTicks: await processStartTicks(process.pid),
    reachedAt: new Date(reachedAt).toISOString(),
    expiresAt: arm.expiresAt,
  };
  await writeExclusivePrivate(paths.reached, reached);

  while (now() < expiresAt) {
    const releaseBytes = await optionalPrivateBytes(paths.release, args.effectiveUid);
    if (releaseBytes === undefined) {
      await sleep(Math.min(CHECK_INTERVAL_MS, Math.max(1, expiresAt - now())));
      continue;
    }
    let release: z.infer<typeof LifecycleQualificationRelease>;
    try {
      release = LifecycleQualificationRelease.parse(JSON.parse(releaseBytes.toString("utf8")));
    } catch (error) {
      throw new Error("controller-lifecycle-qualification-invalid: malformed release", {
        cause: error,
      });
    }
    if (release.checkpointId !== arm.checkpointId || release.armDigest !== armDigest) {
      throw new Error("controller-lifecycle-qualification-invalid: release differs from arm");
    }
    if (!(await privateBytes(armPath, args.effectiveUid)).equals(armBytes)) {
      throw new Error("controller-lifecycle-qualification-invalid: arm changed while held");
    }
    const releasedAt = now();
    if (releasedAt >= expiresAt) break;
    await writeExclusivePrivate(paths.consumed, {
      protocol: "clockgrove.factory/lifecycle-checkpoint-consumed",
      checkpointId: arm.checkpointId,
      armDigest,
      reachedDigest: hash(`${JSON.stringify(reached)}\n`),
      outcome: "released",
      releasedAt: new Date(releasedAt).toISOString(),
    });
    await rm(armPath);
    await rm(paths.release);
    return;
  }
  throw new Error(
    "controller-lifecycle-qualification-expired: release was not observed before expiry",
  );
}
