import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  artifactTransferRef,
  type ArtifactTransferIntentCheckpoint,
} from "../control/artifact-transfers.js";
import { MAX_ARTIFACT_PATCH_BYTES } from "../execution/artifacts.js";
import { assertNoSecretMaterial, gitSha, sha256Digest } from "../protocol/limits.js";
import { LocalScopeBatchSchema } from "../protocol/local-scope.js";
import { discoverLocalScopeHost } from "./local-scope.js";
import type { FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import { recoveryEventDigest } from "../recovery/identity.js";

export const ArtifactTransferQualificationArmSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/artifact-transfer-checkpoint-arm-v2"),
    repository: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    objective: z.number().int().positive(),
    activationRequestId: z.string().min(1).max(200),
    policyDigest: sha256Digest,
    baseSha: gitSha,
    unit: z.string().regex(/^clockgrove-factory-[a-f0-9]{16}\.service$/),
    invocationId: z.string().regex(/^[a-f0-9]{32}$/),
    hostIdentity: sha256Digest,
    producerPid: z.number().int().positive(),
    producerStartTicks: z.string().regex(/^[0-9]{1,30}$/),
    minPayloadBytes: z
      .number()
      .int()
      .min(MAX_ARTIFACT_PATCH_BYTES + 1)
      .max(256 * 1024 * 1024),
    eligibilityDurationMs: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60_000),
    holdDurationMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000),
  })
  .strict();
export type ArtifactTransferQualificationArm = z.infer<
  typeof ArtifactTransferQualificationArmSchema
>;
export const ArtifactTransferQualificationTerminalSchema = z
  .object({
    reservationReceiptDigest: sha256Digest,
    startedReceiptDigest: sha256Digest,
    modelReceiptDigest: sha256Digest,
    modelTokens: z.number().int().nonnegative(),
    usageId: z.string().min(1).max(160),
    session: z
      .object({
        threadId: z.string().min(1).max(160),
        turnId: z.string().min(1).max(160),
        checkpointDigest: sha256Digest,
      })
      .strict()
      .optional(),
  })
  .strict();
export type ArtifactTransferQualificationTerminal = z.infer<
  typeof ArtifactTransferQualificationTerminalSchema
>;

/** The caller supplies a freshly authenticated snapshot, not arbitrary comments.
 * This narrows it to the exact successful observation's durable accounting. */
export function proveArtifactTransferQualificationReceipts(args: {
  checkpoint: ArtifactTransferIntentCheckpoint;
  activationRequestId: string | undefined;
  backend: string;
  reservationSequence: number;
  providerResourceId: string;
  modelTokens: number | undefined;
  batch: unknown;
  events: readonly FactoryEvent[];
}): ArtifactTransferQualificationTerminal {
  const id = args.checkpoint.identity;
  const events = deduplicateFactoryEvents([...args.events]).filter(
    (event) => event.runId === id.runId && event.objective === id.objective,
  );
  const starts = events.filter(
    (event) => event.kind === "run" && event.event === "FactoryRunStarted",
  );
  if (
    starts.length !== 1 ||
    starts[0]!.kind !== "run" ||
    starts[0]!.event !== "FactoryRunStarted" ||
    starts[0]!.activationRequestId !== args.activationRequestId ||
    !args.activationRequestId ||
    starts[0]!.policyDigest !== id.policyDigest ||
    starts[0]!.repository.toLowerCase() !== id.repository
  )
    throw new Error("transfer qualification lacks exact activation start");
  const attempts = events.filter(
    (event) =>
      event.kind === "attempt" && event.workItem === id.workItem && event.attempt === id.attempt,
  );
  const reserved = attempts.filter((event) => event.event === "AttemptReserved");
  const started = attempts.filter((event) => event.event === "AttemptStarted");
  if (
    reserved.length !== 1 ||
    started.length !== 1 ||
    attempts.length !== 2 ||
    reserved[0]!.sequence !== args.reservationSequence ||
    reserved[0]!.sequence >= started[0]!.sequence ||
    attempts.some(
      (event) =>
        event.kind !== "attempt" ||
        event.backend !== args.backend ||
        event.baseSha !== id.baseSha ||
        event.policyDigest !== id.policyDigest ||
        event.directorEpoch !== id.directorEpoch,
    ) ||
    reserved[0]!.kind !== "attempt" ||
    started[0]!.kind !== "attempt" ||
    JSON.stringify(LocalScopeBatchSchema.parse(reserved[0]!.localScopeBatch)) !==
      JSON.stringify(LocalScopeBatchSchema.parse(args.batch)) ||
    started[0]!.providerResourceId !== args.providerResourceId
  )
    throw new Error("transfer qualification lacks exact dispatched reservation");
  const model = events.filter(
    (event) =>
      event.kind === "budget" &&
      event.workItem === id.workItem &&
      event.attempt === id.attempt &&
      event.event === "BudgetReconciled" &&
      event.phase === "execution" &&
      event.unit === "model_tokens",
  );
  const usageId = `worker-${id.workItem}-${id.attempt}`;
  if (
    model.length !== 1 ||
    model[0]!.kind !== "budget" ||
    model[0]!.usageId !== usageId ||
    !Number.isSafeInteger(args.modelTokens) ||
    args.modelTokens! < 0 ||
    model[0]!.amount !== args.modelTokens ||
    model[0]!.sequence <= started[0]!.sequence ||
    (model[0]!.policyDigest !== undefined && model[0]!.policyDigest !== id.policyDigest) ||
    (model[0]!.directorEpoch !== undefined && model[0]!.directorEpoch !== id.directorEpoch)
  )
    throw new Error("transfer qualification lacks exact terminal model receipt");
  return {
    reservationReceiptDigest: recoveryEventDigest(reserved[0]!),
    startedReceiptDigest: recoveryEventDigest(started[0]!),
    modelReceiptDigest: recoveryEventDigest(model[0]!),
    modelTokens: args.modelTokens!,
    usageId,
  };
}

export class ArtifactTransferQualificationHeldError extends Error {
  constructor(cause?: unknown) {
    super(
      "one-shot artifact transfer qualification held; exact original transfer recovery required",
      { cause },
    );
    this.name = "ArtifactTransferQualificationHeldError";
  }
}
class ArtifactTransferQualificationArmVersionError extends Error {}
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const directoryPath = () =>
  join(tmpdir(), `factory-artifact-transfer-checkpoints-${process.getuid?.()}`);
export function artifactTransferQualificationCheckpointPath(
  unit: string,
  invocationId: string,
): string {
  return join(directoryPath(), `${hash(`${unit}\0${invocationId}`)}.json`);
}

async function privateArm(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size > 16_384
    )
      throw new Error("artifact transfer arm is not bounded private owner data");
    const bytes = Buffer.alloc(before.size + 1);
    const result = await file.read(bytes, 0, bytes.length, 0),
      after = await file.stat();
    if (
      result.bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("artifact transfer arm changed while reading");
    return { bytes: bytes.subarray(0, before.size), dev: before.dev, ino: before.ino };
  } finally {
    await file.close();
  }
}

/** Local fault only, not execution authority. Fresh first-attempt oversized output
 * is latched after its real durable intent and complete private copy. Backend/native
 * cleanup is deliberately NOT claimed here: existing collection-error recovery owns it.
 * Resume never calls this hook. Once armed and reached, it cannot release to ready. */
export async function holdArtifactTransferQualificationCheckpoint(args: {
  checkpoint: ArtifactTransferIntentCheckpoint;
  activationRequestId?: string;
  batch: unknown;
  objectiveStartedAt: Date;
  objectiveDeadline: Date;
  holdDurationMs: number;
  signal?: AbortSignal;
  assertCurrent(): Promise<void>;
  proveTerminal(): Promise<ArtifactTransferQualificationTerminal>;
}): Promise<void> {
  const { checkpoint } = args;
  if (checkpoint.payloadBytes <= MAX_ARTIFACT_PATCH_BYTES) return;
  const batch = LocalScopeBatchSchema.parse(args.batch),
    id = batch.identity;
  if (!id.producerUnit || !id.producerInvocationId) return;
  const filename = `${hash(`${id.producerUnit}\0${id.producerInvocationId}`)}.json`;
  let directory;
  try {
    directory = await open(
      directoryPath(),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const info = await directory.stat();
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
      throw new Error("artifact transfer checkpoint directory is not private owned storage");
    // Anchor every file operation to this opened directory, not a replaceable path.
    const path = `/proc/self/fd/${directory.fd}/${filename}`;
    let original;
    try {
      original = await privateArm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const rawArm: unknown = JSON.parse(original.bytes.toString("utf8"));
    if (
      rawArm !== null &&
      typeof rawArm === "object" &&
      (rawArm as { protocol?: unknown }).protocol ===
        "clockgrove.factory/artifact-transfer-checkpoint-arm-v1"
    )
      throw new ArtifactTransferQualificationArmVersionError(
        "artifact transfer qualification checkpoint arm v1 is retired; use a fresh v2 scenario",
      );
    const arm = ArtifactTransferQualificationArmSchema.parse(rawArm);
    const identity = checkpoint.identity;
    for (const key of ["repository", "objective", "policyDigest", "baseSha"] as const)
      if (arm[key] !== identity[key])
        throw new Error("artifact transfer arm differs from current activation");
    if (
      arm.activationRequestId !== args.activationRequestId ||
      arm.unit !== id.producerUnit ||
      arm.invocationId !== id.producerInvocationId ||
      arm.hostIdentity !== id.hostIdentity ||
      arm.producerPid !== batch.producerPid ||
      arm.producerStartTicks !== batch.producerStartTicks ||
      batch.producerPid !== process.pid ||
      identity.attempt !== 1 ||
      id.runId !== identity.runId ||
      id.workItem !== identity.workItem ||
      id.attempt !== identity.attempt ||
      id.directorEpoch !== identity.directorEpoch ||
      id.policyDigest !== identity.policyDigest ||
      id.repository !== identity.repository ||
      id.objective !== identity.objective ||
      id.phase !== "execution" ||
      batch.commandCount !== 1 ||
      id.commandIndex !== 0
    )
      throw new Error("artifact transfer checkpoint invocation differs");
    if (checkpoint.payloadBytes < arm.minPayloadBytes) return;
    sha256Digest.parse(checkpoint.artifactDigest);
    sha256Digest.parse(checkpoint.payloadDigest);
    sha256Digest.parse(checkpoint.descriptorDigest);
    gitSha.parse(checkpoint.intentCommitSha);
    if (
      checkpoint.intentRef !== `${artifactTransferRef(identity)}/intent` ||
      !Number.isSafeInteger(checkpoint.payloadBytes) ||
      checkpoint.payloadBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(checkpoint.payloadChunks) ||
      checkpoint.payloadChunks < 2 ||
      checkpoint.payloadChunks > 64 ||
      !(args.objectiveStartedAt instanceof Date) ||
      !Number.isFinite(args.objectiveStartedAt.getTime()) ||
      !(args.objectiveDeadline instanceof Date) ||
      !Number.isFinite(args.objectiveDeadline.getTime()) ||
      !Number.isSafeInteger(args.holdDurationMs) ||
      args.holdDurationMs <= 0 ||
      arm.holdDurationMs !== args.holdDurationMs ||
      arm.eligibilityDurationMs !==
        args.objectiveDeadline.getTime() - args.objectiveStartedAt.getTime() ||
      args.objectiveDeadline.getTime() <= Date.now()
    )
      throw new Error("artifact transfer checkpoint evidence or bounded expiry unavailable");
    const current = await discoverLocalScopeHost();
    if (
      !current ||
      current.hostIdentity !== arm.hostIdentity ||
      current.producerPid !== arm.producerPid ||
      current.producerStartTicks !== arm.producerStartTicks ||
      current.producerUnit !== arm.unit ||
      current.producerInvocationId !== arm.invocationId
    )
      throw new Error("artifact transfer producer generation is no longer current");
    await args.assertCurrent();
    const terminal = ArtifactTransferQualificationTerminalSchema.parse(await args.proveTerminal());
    await checkpoint.proveRetained();
    const unchangedArm = async () => {
      const current = await privateArm(path);
      if (
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        !current.bytes.equals(original.bytes)
      )
        throw new Error("artifact transfer qualification arm was replaced or changed");
    };
    await unchangedArm();
    await args.assertCurrent();
    const reachedAt = Date.now();
    if (reachedAt >= args.objectiveDeadline.getTime())
      throw new Error("artifact transfer checkpoint expired before reaching");
    const holdUntil = reachedAt + arm.holdDurationMs;
    const witness = {
      protocol: "clockgrove.factory/artifact-transfer-checkpoint-reached-v2",
      armDigest: hash(original.bytes),
      activationRequestId: arm.activationRequestId,
      ...identity,
      artifactDigest: checkpoint.artifactDigest,
      payloadDigest: checkpoint.payloadDigest,
      payloadBytes: checkpoint.payloadBytes,
      payloadChunks: checkpoint.payloadChunks,
      intentRef: checkpoint.intentRef,
      intentCommitSha: checkpoint.intentCommitSha,
      descriptorDigest: checkpoint.descriptorDigest,
      terminal,
      batch,
      executionCleanup: "not-proven-by-checkpoint",
      nativeUsage: "not-measured-by-checkpoint",
      startedAt: args.objectiveStartedAt.toISOString(),
      eligibleUntil: args.objectiveDeadline.toISOString(),
      reachedAt: new Date(reachedAt).toISOString(),
      holdUntil: new Date(holdUntil).toISOString(),
    };
    assertNoSecretMaterial(witness, "artifact transfer qualification witness");
    const bytes = Buffer.from(`${JSON.stringify(witness)}\n`);
    if (bytes.length > 16_384)
      throw new Error("artifact transfer qualification witness exceeds bound");
    const file = await open(
      `${path}.reached`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await directory.sync();
    while (!args.signal?.aborted && Date.now() < holdUntil) {
      await unchangedArm();
      await sleep(
        Math.max(1, Math.min(500, holdUntil - Date.now())),
        undefined,
        args.signal ? { signal: args.signal } : {},
      );
    }
    throw new ArtifactTransferQualificationHeldError();
  } catch (cause) {
    if (
      cause instanceof ArtifactTransferQualificationHeldError ||
      cause instanceof ArtifactTransferQualificationArmVersionError
    )
      throw cause;
    throw new ArtifactTransferQualificationHeldError(cause);
  } finally {
    await directory.close();
  }
}
