import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { CompiledObjective } from "../graph.js";
import type { CompiledGraphProjectionRecord, CompiledGraphRecord } from "../control/graphs.js";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import type { CompilerDraftRecord } from "../control/compiler-drafts.js";
import { draftDigest } from "../control/compiler-drafts.js";
import { assertCompilerDraftSelection } from "../management/draft-compilation.js";
import type { FactoryEvent } from "../protocol/events.js";
import { assertNoSecretMaterial, gitSha, safeId, sha256Digest } from "../protocol/limits.js";
import { recoveryEventDigest } from "../recovery/identity.js";

const CheckpointKindSchema = z.enum(["compiler-selection", "graph-projection"]);
export type CompilerQualificationCheckpointKind = z.infer<typeof CheckpointKindSchema>;

export const CompilerQualificationArmSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-qualification-checkpoint-arm"),
    bundleIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    effectiveUid: z.number().int().nonnegative(),
    controllerUnit: z.string().regex(/^clockgrove-factory-[a-f0-9]{16}\.service$/),
    repository: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    objective: z.number().int().positive(),
    activationRequestId: safeId,
    runId: safeId,
    policyDigest: sha256Digest,
    baseSha: gitSha,
    checkpoint: CheckpointKindSchema,
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
export type CompilerQualificationArm = z.infer<typeof CompilerQualificationArmSchema>;

const CompilerUsageProofSchema = z
  .object({
    invocationId: safeId,
    stage: z.enum(["inventory", "compile", "repair", "judge"]),
    revision: z.number().int().min(0).max(2),
    amount: z.number().int().nonnegative(),
    reservationSequence: z.number().int().nonnegative(),
    reconciliationSequence: z.number().int().nonnegative(),
  })
  .strict();

export const CompilerSelectionQualificationProofSchema = z
  .object({
    checkpoint: z.literal("compiler-selection"),
    journalDigest: sha256Digest,
    selectionSequence: z.number().int().nonnegative().max(255),
    revision: z.number().int().min(0).max(2),
    graphDigest: sha256Digest,
    graphAbsent: z.literal(true),
    usage: z.array(CompilerUsageProofSchema).min(3).max(7),
  })
  .strict();

export const GraphProjectionQualificationProofSchema = z
  .object({
    checkpoint: z.literal("graph-projection"),
    graphDigest: sha256Digest,
    graphSize: z.number().int().positive().max(100),
    graphRef: z.string().min(1).max(500),
    graphCommitOid: gitSha,
    graphBlobSha: gitSha,
    graphReceiptDigest: sha256Digest,
    projectionRef: z.string().min(1).max(500),
    projectionCommitOid: gitSha,
    projectionBlobSha: gitSha,
    projectionReceiptDigest: sha256Digest,
    bindingsDigest: sha256Digest,
    workItemNumbers: z.array(z.number().int().positive()).min(1).max(100),
    attemptReservations: z.literal(0),
    capacityReservations: z.literal(0),
  })
  .strict();

export const CompilerQualificationProofSchema = z.discriminatedUnion("checkpoint", [
  CompilerSelectionQualificationProofSchema,
  GraphProjectionQualificationProofSchema,
]);
export type CompilerQualificationProof = z.infer<typeof CompilerQualificationProofSchema>;

/** Re-check the immutable selection and its exact Objective budget receipts from a fresh snapshot. */
export function proveCompilerSelectionQualificationBoundary(args: {
  records: readonly CompilerDraftRecord[];
  graph: CompiledObjective;
  inputDigest: string;
  events: readonly FactoryEvent[];
  durableGraph: CompiledGraphRecord | null;
}): z.infer<typeof CompilerSelectionQualificationProofSchema> {
  assertCompilerDraftSelection(args.records, args.graph, args.inputDigest);
  if (args.durableGraph) throw new Error("compiler selection checkpoint follows graph persistence");
  const events = deduplicateFactoryEvents([...args.events]);
  const selection = args.records.filter((record) => record.kind === "selection");
  if (selection.length !== 1) throw new Error("compiler selection checkpoint is ambiguous");
  const usage = args.records
    .filter((record) => record.kind === "invocation")
    .map((invocation) => {
      const invocationId = String(invocation.payload.invocationId);
      const results = args.records.filter(
        (record) => record.kind === "result" && record.payload.invocationId === invocationId,
      );
      if (results.length !== 1 || !results[0]!.payload.usage)
        throw new Error("compiler selection checkpoint has unknown invocation usage");
      const observed = results[0]!.payload.usage as {
        inputTokens?: unknown;
        outputTokens?: unknown;
      };
      if (
        !Number.isSafeInteger(observed.inputTokens) ||
        Number(observed.inputTokens) < 0 ||
        !Number.isSafeInteger(observed.outputTokens) ||
        Number(observed.outputTokens) < 0
      )
        throw new Error("compiler selection checkpoint usage is invalid");
      const reservations = events.filter(
        (event) =>
          event.kind === "budget" &&
          event.runId === invocation.binding.runId &&
          event.event === "BudgetReserved" &&
          event.phase === "management" &&
          event.unit === "model_tokens" &&
          event.modelInvocationId === invocationId &&
          event.usageId === `invocation-${invocationId}` &&
          event.workItem === undefined &&
          event.attempt === undefined,
      );
      const reconciliations = events.filter(
        (event) =>
          event.kind === "budget" &&
          event.runId === invocation.binding.runId &&
          event.event === "BudgetReconciled" &&
          event.phase === "management" &&
          event.unit === "model_tokens" &&
          event.modelInvocationId === invocationId &&
          event.usageId === `draft-${invocationId}` &&
          event.workItem === undefined &&
          event.attempt === undefined,
      );
      if (reservations.length !== 1 || reconciliations.length !== 1)
        throw new Error("compiler selection checkpoint lacks one exact accounting pair");
      const reservation = reservations[0]!;
      const reconciliation = reconciliations[0]!;
      const amount = Number(observed.inputTokens) + Number(observed.outputTokens);
      if (
        reconciliation.amount !== amount ||
        reservation.sequence >= reconciliation.sequence ||
        reservation.directorEpoch !== reconciliation.directorEpoch ||
        reservation.policyDigest !== reconciliation.policyDigest ||
        reservation.policyDigest !== invocation.binding.policyDigest
      )
        throw new Error("compiler selection checkpoint accounting binding differs");
      return {
        invocationId,
        stage: invocation.payload.stage,
        revision: invocation.payload.revision,
        amount,
        reservationSequence: reservation.sequence,
        reconciliationSequence: reconciliation.sequence,
      };
    });
  const invocationIds = new Set(usage.map((entry) => entry.invocationId));
  const compilerAccounting = events.filter(
    (event) =>
      event.kind === "budget" &&
      event.phase === "management" &&
      event.unit === "model_tokens" &&
      event.workItem === undefined &&
      event.attempt === undefined &&
      typeof event.modelInvocationId === "string" &&
      (event.usageId === `invocation-${event.modelInvocationId}` ||
        event.usageId === `draft-${event.modelInvocationId}`),
  );
  if (
    compilerAccounting.length !== usage.length * 2 ||
    compilerAccounting.some((event) => !invocationIds.has(String(event.modelInvocationId)))
  )
    throw new Error("compiler selection checkpoint has unbound invocation accounting");
  const selected = selection[0]!;
  return CompilerSelectionQualificationProofSchema.parse({
    checkpoint: "compiler-selection",
    journalDigest: draftDigest(args.records),
    selectionSequence: selected.sequence,
    revision: selected.payload.revision,
    graphDigest: selected.payload.graphDigest,
    graphAbsent: true,
    usage,
  });
}

/** Bind a fresh authenticated graph/projection observation to zero scheduling admission. */
export function proveGraphProjectionQualificationBoundary(args: {
  objective: number;
  runId: string;
  graph: CompiledGraphRecord;
  projection: CompiledGraphProjectionRecord;
  events: readonly FactoryEvent[];
}): z.infer<typeof GraphProjectionQualificationProofSchema> {
  const events = deduplicateFactoryEvents([...args.events]);
  const compiled = events.filter(
    (event) =>
      event.kind === "graph" &&
      event.event === "GraphCompiled" &&
      event.objective === args.objective &&
      event.runId === args.runId,
  );
  const projected = events.filter(
    (event) =>
      event.kind === "graph" &&
      event.event === "GraphProjected" &&
      event.objective === args.objective &&
      event.runId === args.runId,
  );
  if (compiled.length !== 1 || projected.length !== 1)
    throw new Error("graph projection checkpoint lacks exact graph receipts");
  const graphReceipt = compiled[0]!;
  const projectionReceipt = projected[0]!;
  if (
    graphReceipt.kind !== "graph" ||
    graphReceipt.event !== "GraphCompiled" ||
    graphReceipt.graphDigest !== args.graph.graphDigest ||
    graphReceipt.graphSize !== args.graph.graphSize ||
    graphReceipt.graphRef !== args.graph.ref ||
    graphReceipt.graphBlobSha !== args.graph.blobOid ||
    projectionReceipt.kind !== "graph" ||
    projectionReceipt.event !== "GraphProjected" ||
    projectionReceipt.graphDigest !== args.projection.graphDigest ||
    projectionReceipt.graphSize !== args.projection.graphSize ||
    projectionReceipt.projectionRef !== args.projection.ref ||
    projectionReceipt.projectionBlobSha !== args.projection.blobOid ||
    args.projection.graphDigest !== args.graph.graphDigest ||
    args.projection.graphSize !== args.graph.graphSize
  )
    throw new Error("graph projection checkpoint differs from its durable receipts");
  const attemptReservations = events.filter(
    (event) =>
      event.kind === "attempt" && event.event === "AttemptReserved" && event.runId === args.runId,
  ).length;
  const capacityReservations = events.filter(
    (event) =>
      event.kind === "capacity" && event.event === "CapacityReserved" && event.runId === args.runId,
  ).length;
  if (attemptReservations || capacityReservations)
    throw new Error("graph projection checkpoint follows worker admission");
  return GraphProjectionQualificationProofSchema.parse({
    checkpoint: "graph-projection",
    graphDigest: args.graph.graphDigest,
    graphSize: args.graph.graphSize,
    graphRef: args.graph.ref,
    graphCommitOid: args.graph.commitOid,
    graphBlobSha: args.graph.blobOid,
    graphReceiptDigest: recoveryEventDigest(graphReceipt),
    projectionRef: args.projection.ref,
    projectionCommitOid: args.projection.commitOid,
    projectionBlobSha: args.projection.blobOid,
    projectionReceiptDigest: recoveryEventDigest(projectionReceipt),
    bindingsDigest: draftDigest(args.projection.bindings),
    workItemNumbers: args.projection.bindings.map((binding) => binding.issueNumber),
    attemptReservations,
    capacityReservations,
  });
}

const ControllerObservationSchema = z
  .object({
    bundleIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    hostIdentity: sha256Digest,
    producerPid: z.number().int().positive(),
    producerStartTicks: z.string().regex(/^[0-9]{1,30}$/),
    producerUnit: z.string().regex(/^clockgrove-factory-[a-f0-9]{16}\.service$/),
    producerInvocationId: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export type CompilerQualificationControllerObservation = z.infer<
  typeof ControllerObservationSchema
>;

export class CompilerQualificationCheckpointHeldError extends Error {
  constructor(cause?: unknown) {
    super(
      "one-shot compiler qualification checkpoint held; GitHub recovery remains authoritative",
      {
        cause,
      },
    );
    this.name = "CompilerQualificationCheckpointHeldError";
  }
}

export class CompilerQualificationCheckpointShutdownError extends CompilerQualificationCheckpointHeldError {
  constructor(cause?: unknown) {
    super(cause);
    this.name = "CompilerQualificationCheckpointShutdownError";
  }
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const directoryPath = (uid = process.geteuid?.()) =>
  join(tmpdir(), `factory-compiler-qualification-checkpoints-${uid}`);

export function compilerQualificationCheckpointPath(
  binding: Pick<
    CompilerQualificationArm,
    "repository" | "objective" | "runId" | "checkpoint" | "effectiveUid"
  >,
): string {
  return join(
    directoryPath(binding.effectiveUid),
    `${hash(
      `${binding.repository}\0${binding.objective}\0${binding.runId}\0${binding.checkpoint}`,
    )}.json`,
  );
}

async function privateFile(path: string, label: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.geteuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size > 32_768
    )
      throw new Error(`${label} is not bounded private owner data`);
    const bytes = Buffer.alloc(before.size + 1);
    const result = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (
      result.bytesRead !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error(`${label} changed while reading`);
    return {
      bytes: bytes.subarray(0, before.size),
      dev: before.dev,
      ino: before.ino,
    };
  } finally {
    await file.close();
  }
}

/** Qualification-only delay at two existing durable controller boundaries.
 * No private arm is a no-op. The arm and witness never authorize replay or recovery. */
export async function holdCompilerQualificationCheckpoint(args: {
  repository: string;
  objective: number;
  activationRequestId: string;
  runId: string;
  policyDigest: string;
  baseSha: string;
  checkpoint: CompilerQualificationCheckpointKind;
  objectiveStartedAt: Date;
  objectiveDeadline: Date;
  holdDurationMs: number;
  signal?: AbortSignal;
  observeController(): Promise<CompilerQualificationControllerObservation | null>;
  assertCurrent(): Promise<void>;
  proveBoundary(): Promise<CompilerQualificationProof>;
}): Promise<void> {
  const uid = process.geteuid?.();
  if (uid === undefined) return;
  const filename = `${hash(
    `${args.repository}\0${args.objective}\0${args.runId}\0${args.checkpoint}`,
  )}.json`;
  let directory;
  try {
    directory = await open(
      directoryPath(uid),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CompilerQualificationCheckpointHeldError(error);
  }
  try {
    const info = await directory.stat();
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700)
      throw new Error("compiler qualification checkpoint directory is not private owned storage");
    const path = `/proc/self/fd/${directory.fd}/${filename}`;
    let original;
    try {
      original = await privateFile(path, "compiler qualification arm");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      await privateFile(`${path}.reached`, "compiler qualification witness");
      throw new Error("compiler qualification arm was replayed after its one-shot witness");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const arm = CompilerQualificationArmSchema.parse(JSON.parse(original.bytes.toString("utf8")));
    for (const key of [
      "repository",
      "objective",
      "activationRequestId",
      "runId",
      "policyDigest",
      "baseSha",
      "checkpoint",
    ] as const)
      if (arm[key] !== args[key])
        throw new Error("compiler qualification arm differs from the active run boundary");
    if (
      arm.effectiveUid !== uid ||
      !(args.objectiveStartedAt instanceof Date) ||
      !Number.isFinite(args.objectiveStartedAt.getTime()) ||
      !(args.objectiveDeadline instanceof Date) ||
      !Number.isFinite(args.objectiveDeadline.getTime()) ||
      arm.eligibilityDurationMs !==
        args.objectiveDeadline.getTime() - args.objectiveStartedAt.getTime() ||
      !Number.isSafeInteger(args.holdDurationMs) ||
      args.holdDurationMs <= 0 ||
      arm.holdDurationMs !== args.holdDurationMs ||
      Date.now() >= args.objectiveDeadline.getTime()
    )
      throw new Error("compiler qualification arm has no exact bounded run expiry");
    const controller = ControllerObservationSchema.parse(await args.observeController());
    if (
      controller.bundleIdentity !== arm.bundleIdentity ||
      controller.producerUnit !== arm.controllerUnit ||
      controller.producerPid !== process.pid
    )
      throw new Error("compiler qualification arm differs from the installed controller");
    const unchangedArm = async () => {
      const current = await privateFile(path, "compiler qualification arm");
      if (
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        !current.bytes.equals(original.bytes)
      )
        throw new Error("compiler qualification arm was replaced or changed");
    };
    await args.assertCurrent();
    const proof = CompilerQualificationProofSchema.parse(await args.proveBoundary());
    if (proof.checkpoint !== args.checkpoint)
      throw new Error("compiler qualification proof belongs to another checkpoint");
    await unchangedArm();
    await args.assertCurrent();
    const reachedAt = Date.now();
    if (reachedAt >= args.objectiveDeadline.getTime())
      throw new Error("compiler qualification checkpoint expired before reaching");
    const holdUntil = Math.min(args.objectiveDeadline.getTime(), reachedAt + arm.holdDurationMs);
    if (holdUntil <= reachedAt)
      throw new Error("compiler qualification checkpoint has no bounded hold interval");
    const witness = {
      protocol: "clockgrove.factory/compiler-qualification-checkpoint-reached",
      armDigest: hash(original.bytes),
      bundleIdentity: arm.bundleIdentity,
      effectiveUid: uid,
      controllerUnit: controller.producerUnit,
      controllerInvocationId: controller.producerInvocationId,
      hostIdentity: controller.hostIdentity,
      producerPid: controller.producerPid,
      producerStartTicks: controller.producerStartTicks,
      repository: args.repository,
      objective: args.objective,
      activationRequestId: args.activationRequestId,
      runId: args.runId,
      policyDigest: args.policyDigest,
      baseSha: args.baseSha,
      checkpoint: args.checkpoint,
      proof,
      startedAt: args.objectiveStartedAt.toISOString(),
      eligibleUntil: args.objectiveDeadline.toISOString(),
      reachedAt: new Date(reachedAt).toISOString(),
      holdUntil: new Date(holdUntil).toISOString(),
    };
    assertNoSecretMaterial(witness, "compiler qualification checkpoint witness");
    const witnessBytes = Buffer.from(`${JSON.stringify(witness)}\n`);
    if (witnessBytes.length > 32_768)
      throw new Error("compiler qualification checkpoint witness exceeds bound");
    const reached = await open(
      `${path}.reached`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await reached.writeFile(witnessBytes);
      await reached.sync();
    } finally {
      await reached.close();
    }
    await directory.sync();
    while (!args.signal?.aborted && Date.now() < holdUntil) {
      await unchangedArm();
      try {
        await sleep(
          Math.max(1, Math.min(500, holdUntil - Date.now())),
          undefined,
          args.signal ? { signal: args.signal } : {},
        );
      } catch (error) {
        if (!(args.signal?.aborted && error instanceof Error && error.name === "AbortError"))
          throw error;
      }
    }
    if (args.signal?.aborted) {
      await unchangedArm();
      await unlink(path);
      await directory.sync();
      throw new CompilerQualificationCheckpointShutdownError(args.signal.reason);
    }
    throw new CompilerQualificationCheckpointHeldError();
  } catch (error) {
    if (error instanceof CompilerQualificationCheckpointHeldError) throw error;
    throw new CompilerQualificationCheckpointHeldError(error);
  } finally {
    await directory.close();
  }
}
