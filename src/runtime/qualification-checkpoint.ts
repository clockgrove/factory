import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { gitSha, sha256Digest } from "../protocol/limits.js";
import { LocalScopeBatchSchema } from "../protocol/local-scope.js";
import { observeLocalScope } from "./local-scope.js";

const Arm = z
  .object({
    protocol: z.literal("clockgrove.factory/app-server-checkpoint-arm-v2"),
    repository: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    objective: z.number().int().positive(),
    activationRequestId: z.string().min(1).max(200),
    policyDigest: sha256Digest,
    unit: z.string().regex(/^clockgrove-factory-[a-f0-9]{16}\.service$/),
    invocationId: z.string().regex(/^[a-f0-9]{32}$/),
    hostIdentity: sha256Digest,
    producerPid: z.number().int().positive(),
    producerStartTicks: z.string().regex(/^[0-9]+$/),
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
export class SafeArtifactCheckpointHeldError extends Error {
  constructor(cause?: unknown) {
    super("one-shot qualification artifact checkpoint held; exact same-attempt recovery required", {
      cause,
    });
    this.name = "SafeArtifactCheckpointHeldError";
  }
}
/** Only a reached, immutable terminal hold interrupted by its supplied signal. */
export class SafeArtifactCheckpointShutdownError extends SafeArtifactCheckpointHeldError {
  constructor(cause?: unknown) {
    super(cause);
    this.name = "SafeArtifactCheckpointShutdownError";
  }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function qualificationCheckpointPath(unit: string, invocationId: string): string {
  return join(
    tmpdir(),
    `factory-qualification-checkpoints-${process.getuid?.()}`,
    `${hash(`${unit}\0${invocationId}`)}.json`,
  );
}
async function privateBytes(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size > 16384
    )
      throw new Error("qualification checkpoint file is not bounded private owner data");
    const bytes = Buffer.alloc(before.size + 1),
      result = await file.read(bytes, 0, bytes.length, 0),
      after = await file.stat();
    if (
      result.bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("qualification checkpoint changed during read");
    return bytes.subarray(0, before.size);
  } finally {
    await file.close();
  }
}
/** Qualification-only fault input, not orchestration or execution authority. No arm is a no-op.
 * The caller has durably retained output and accounting and completed backend cleanup.
 * Once reached, this hook never releases into validation in the original invocation. */
export async function holdAppServerQualificationCheckpoint(args: {
  repository: string;
  objective: number;
  activationRequestId?: string;
  runId: string;
  workItem: number;
  attempt: number;
  directorEpoch: number;
  policyDigest: string;
  baseSha: string;
  artifactDigest: string;
  threadId: string;
  turnId: string;
  modelTokens: number;
  nativeMilliseconds: number;
  batch: unknown;
  objectiveStartedAt: Date;
  objectiveDeadline: Date;
  holdDurationMs: number;
  signal?: AbortSignal;
  assertCurrent(): Promise<void>;
  proveTerminal(): Promise<void>;
}): Promise<void> {
  const batch = LocalScopeBatchSchema.parse(args.batch),
    id = batch.identity;
  if (!id.producerUnit || !id.producerInvocationId) return;
  const path = qualificationCheckpointPath(id.producerUnit, id.producerInvocationId);
  let directory;
  try {
    directory = await lstat(
      join(tmpdir(), `factory-qualification-checkpoints-${process.getuid?.()}`),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700
  )
    throw new Error("qualification checkpoint directory is not private owned storage");
  let bytes: Buffer;
  try {
    bytes = await privateBytes(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Any reached or malformed arm remains a refusal, never a repeatable hold.
  const rawArm: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    rawArm !== null &&
    typeof rawArm === "object" &&
    (rawArm as { protocol?: unknown }).protocol ===
      "clockgrove.factory/app-server-checkpoint-arm-v1"
  )
    throw new Error(
      "App Server qualification checkpoint arm v1 is retired; use a fresh v2 scenario",
    );
  const arm = Arm.parse(rawArm);
  for (const key of ["repository", "objective", "activationRequestId", "policyDigest"] as const)
    if (arm[key] !== args[key])
      throw new Error("qualification arm differs from current activation");
  if (
    arm.unit !== id.producerUnit ||
    arm.invocationId !== id.producerInvocationId ||
    arm.hostIdentity !== id.hostIdentity ||
    arm.producerPid !== batch.producerPid ||
    arm.producerStartTicks !== batch.producerStartTicks ||
    args.attempt !== 1 ||
    id.runId !== args.runId ||
    id.workItem !== args.workItem ||
    id.attempt !== args.attempt ||
    id.directorEpoch !== args.directorEpoch ||
    id.policyDigest !== args.policyDigest ||
    id.repository !== args.repository ||
    id.objective !== args.objective ||
    id.phase !== "execution" ||
    batch.commandCount !== 1 ||
    id.commandIndex !== 0
  )
    throw new Error("qualification checkpoint invocation binding differs");
  gitSha.parse(args.baseSha);
  sha256Digest.parse(args.artifactDigest);
  if (
    !args.threadId ||
    !args.turnId ||
    !Number.isSafeInteger(args.modelTokens) ||
    args.modelTokens < 0 ||
    !Number.isSafeInteger(args.nativeMilliseconds) ||
    args.nativeMilliseconds < 0 ||
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
    throw new Error("qualification checkpoint evidence or bounded expiry unavailable");
  await args.assertCurrent();
  await args.proveTerminal();
  if ((await observeLocalScope(id)).status !== "absent")
    throw new Error("qualification checkpoint worker scope is not absent");
  if (!(await privateBytes(path)).equals(bytes)) throw new Error("qualification arm changed");
  await args.assertCurrent();
  const reachedAt = Date.now();
  if (reachedAt >= args.objectiveDeadline.getTime())
    throw new Error("qualification checkpoint expired before reaching");
  const holdUntil = reachedAt + arm.holdDurationMs;
  const witness = {
    protocol: "clockgrove.factory/app-server-checkpoint-reached-v2",
    armDigest: hash(bytes.toString("utf8")),
    repository: args.repository,
    objective: args.objective,
    activationRequestId: args.activationRequestId,
    runId: args.runId,
    workItem: args.workItem,
    attempt: args.attempt,
    directorEpoch: args.directorEpoch,
    policyDigest: args.policyDigest,
    baseSha: args.baseSha,
    artifactDigest: args.artifactDigest,
    threadId: args.threadId,
    turnId: args.turnId,
    modelTokens: args.modelTokens,
    nativeMilliseconds: args.nativeMilliseconds,
    batch,
    startedAt: args.objectiveStartedAt.toISOString(),
    eligibleUntil: args.objectiveDeadline.toISOString(),
    reachedAt: new Date(reachedAt).toISOString(),
    holdUntil: new Date(holdUntil).toISOString(),
  };
  try {
    const file = await open(
      `${path}.reached`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(`${JSON.stringify(witness)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    while (!args.signal?.aborted && Date.now() < holdUntil) {
      if (!(await privateBytes(path)).equals(bytes))
        throw new Error("qualification arm changed while held");
      try {
        await sleep(
          Math.min(500, holdUntil - Date.now()),
          undefined,
          args.signal ? { signal: args.signal } : {},
        );
      } catch (error) {
        if (
          args.signal?.aborted &&
          error instanceof Error &&
          error.name === "AbortError" &&
          error.cause === args.signal.reason
        )
          throw new SafeArtifactCheckpointShutdownError(error);
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof SafeArtifactCheckpointShutdownError) throw error;
    throw new SafeArtifactCheckpointHeldError(error);
  }
  if (args.signal?.aborted) throw new SafeArtifactCheckpointShutdownError(args.signal.reason);
  throw new SafeArtifactCheckpointHeldError();
}
