import { createHash } from "node:crypto";

import { z } from "zod";

import { recoverContentTransfer, type ContentTransferStore } from "../control/content-transfers.js";
import { boundedText, gitSha, sha256Digest } from "../protocol/limits.js";
import {
  RepositoryCaptureEvidenceSchema,
  ValidationInvocationSchema,
  verifyRepositoryCaptureEvidenceBinding,
  type RepositoryCaptureEvidence,
  type ValidationInvocation,
} from "./repository-capture.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const digestOf = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const gitOid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export const ValidationRuntimeResultSchema = z
  .object({
    outputTreeSha: gitSha,
    commands: z
      .array(
        z
          .object({
            command: boundedText(1_000),
            exitCode: z.number().int().min(0).max(255),
            durationMs: z
              .number()
              .int()
              .nonnegative()
              .max(24 * 60 * 60 * 1_000),
          })
          .strict(),
      )
      .max(128),
    passed: z.boolean(),
    failureReason: boundedText(8_000).optional(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    environmentIdentity: boundedText(500),
  })
  .strict();

const ValidationInvocationResultCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/validation-invocation-result"),
    invocationDigest: sha256Digest,
    validation: ValidationRuntimeResultSchema,
    repositoryCapture: RepositoryCaptureEvidenceSchema.optional(),
  })
  .strict();

export const ValidationInvocationResultSchema = ValidationInvocationResultCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((result, context) => {
    const { digest, ...core } = result;
    if (digest !== digestOf(core))
      context.addIssue({ code: "custom", path: ["digest"], message: "result digest mismatch" });
    if (
      result.repositoryCapture &&
      result.repositoryCapture.validationInvocationDigest !== result.invocationDigest
    )
      context.addIssue({
        code: "custom",
        path: ["repositoryCapture"],
        message: "capture evidence belongs to another invocation",
      });
  });

export type ValidationInvocationResult = z.infer<typeof ValidationInvocationResultSchema>;

export const MAX_VALIDATION_INVOCATION_RESULT_BYTES = 8 * 1024 * 1024;

export const validationInvocationRef = (digest: string) =>
  `refs/clockgrove-factory/validation-invocations/${sha256Digest.parse(digest)}`;

async function publish(args: {
  store: ContentTransferStore;
  ref: string;
  bytes: Buffer;
  path: string;
  parents: string[];
  message: string;
  assertCurrent(): Promise<void>;
}) {
  const expectedBlob = gitOid(args.bytes);
  await args.assertCurrent();
  const blob = await args.store.createBlob(args.bytes);
  if (blob !== expectedBlob) throw new Error("validation invocation blob identity mismatch");
  const tree = await args.store.createTree({
    entries: [{ path: args.path, mode: "100644", type: "blob", sha: blob }],
  });
  const validate = async (oid: string) => {
    const commit = await args.store.readCommit(oid);
    if (
      commit.treeOid !== tree ||
      canonical(commit.parentOids) !== canonical(args.parents) ||
      commit.message !== args.message
    )
      throw new Error("validation invocation publication conflicted");
    return oid;
  };
  const existing = await args.store.readRef(args.ref);
  if (existing) return validate(existing);
  await args.assertCurrent();
  const commit = await args.store.createCommit({
    treeOid: tree,
    parentOids: args.parents,
    message: args.message,
  });
  await args.assertCurrent();
  let created = false;
  try {
    created = await args.store.createRef(args.ref, commit);
  } catch {
    // Reconcile the immutable winner below.
  }
  if (created) return validate(commit);
  const winner = await args.store.readRef(args.ref);
  if (!winner) throw new Error("validation invocation publication is unresolved");
  return validate(winner);
}

async function readJson(args: {
  store: ContentTransferStore;
  ref: string;
  path: string;
  maximumBytes: number;
}) {
  const commitOid = await args.store.readRef(args.ref);
  if (!commitOid) return null;
  const commit = await args.store.readCommit(commitOid);
  const blob = await args.store.readTreeEntry(commit.treeOid, args.path);
  if (!blob) throw new Error("validation invocation checkpoint blob is missing");
  const bytes = await args.store.readBlob(blob);
  if (bytes.length > args.maximumBytes || gitOid(bytes) !== blob)
    throw new Error("validation invocation checkpoint identity is invalid");
  return { commitOid, commit, value: JSON.parse(bytes.toString("utf8")) as unknown };
}

export async function persistValidationInvocation(args: {
  store: ContentTransferStore;
  invocation: ValidationInvocation;
  assertCurrent(): Promise<void>;
}) {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const bytes = Buffer.from(canonical(invocation));
  if (bytes.length > 512 * 1024) throw new Error("validation invocation exceeds 512 KiB");
  const ref = `${validationInvocationRef(invocation.digest)}/intent`;
  const message = `Factory validation invocation\n\nFactory-Invocation: ${invocation.digest}`;
  const commit = await publish({
    store: args.store,
    ref,
    bytes,
    path: "validation-invocation.json",
    parents: [],
    message,
    assertCurrent: args.assertCurrent,
  });
  return { ref, commit, invocation };
}

export async function readValidationInvocation(args: {
  store: ContentTransferStore;
  digest: string;
}) {
  const ref = `${validationInvocationRef(args.digest)}/intent`;
  const record = await readJson({
    store: args.store,
    ref,
    path: "validation-invocation.json",
    maximumBytes: 512 * 1024,
  });
  if (!record) return null;
  const invocation = ValidationInvocationSchema.parse(record.value);
  if (
    invocation.digest !== args.digest ||
    record.commit.parentOids.length !== 0 ||
    record.commit.message !==
      `Factory validation invocation\n\nFactory-Invocation: ${invocation.digest}`
  )
    throw new Error("validation invocation intent authority mismatch");
  return { ref, commit: record.commitOid, invocation };
}

export async function persistValidationInvocationResult(args: {
  store: ContentTransferStore;
  invocation: ValidationInvocation;
  validation: z.input<typeof ValidationRuntimeResultSchema>;
  repositoryCapture?: RepositoryCaptureEvidence;
  assertCurrent(): Promise<void>;
}) {
  const intent = await readValidationInvocation({
    store: args.store,
    digest: args.invocation.digest,
  });
  if (
    !intent ||
    canonical(intent.invocation) !== canonical(ValidationInvocationSchema.parse(args.invocation))
  )
    throw new Error("validation invocation result lacks its exact durable intent");
  const core = ValidationInvocationResultCoreSchema.parse({
    protocol: "clockgrove.factory/validation-invocation-result",
    invocationDigest: intent.invocation.digest,
    validation: args.validation,
    ...(args.repositoryCapture ? { repositoryCapture: args.repositoryCapture } : {}),
  });
  if (core.repositoryCapture)
    verifyRepositoryCaptureEvidenceBinding(core.repositoryCapture, intent.invocation);
  const result = ValidationInvocationResultSchema.parse({ ...core, digest: digestOf(core) });
  const bytes = Buffer.from(canonical(result));
  if (bytes.length > MAX_VALIDATION_INVOCATION_RESULT_BYTES)
    throw new Error("validation invocation result exceeds 8 MiB");
  const parents = [intent.commit];
  const ref = `${validationInvocationRef(intent.invocation.digest)}/result`;
  const message = `Factory validation invocation result\n\nFactory-Result: ${result.digest}`;
  const commit = await publish({
    store: args.store,
    ref,
    bytes,
    path: "validation-invocation-result.json",
    parents,
    message,
    assertCurrent: args.assertCurrent,
  });
  return { ref, commit, result };
}

export async function readValidationInvocationResult(args: {
  store: ContentTransferStore;
  invocation: ValidationInvocation;
}) {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const intent = await readValidationInvocation({ store: args.store, digest: invocation.digest });
  if (!intent || canonical(intent.invocation) !== canonical(invocation))
    throw new Error("validation invocation result lookup differs from durable intent");
  const ref = `${validationInvocationRef(invocation.digest)}/result`;
  const record = await readJson({
    store: args.store,
    ref,
    path: "validation-invocation-result.json",
    maximumBytes: MAX_VALIDATION_INVOCATION_RESULT_BYTES,
  });
  if (!record) return null;
  const result = ValidationInvocationResultSchema.parse(record.value);
  const parents = [intent.commit];
  if (
    result.invocationDigest !== invocation.digest ||
    canonical(record.commit.parentOids) !== canonical(parents) ||
    record.commit.message !==
      `Factory validation invocation result\n\nFactory-Result: ${result.digest}`
  )
    throw new Error("validation invocation result authority mismatch");
  if (result.repositoryCapture)
    verifyRepositoryCaptureEvidenceBinding(result.repositoryCapture, invocation);
  for (const { descriptor, storage } of result.repositoryCapture?.manifest.entries ?? []) {
    const recovered = await recoverContentTransfer({
      store: args.store,
      identity: storage.identity,
    });
    if (
      !recovered ||
      recovered.transferRef !== storage.transferRef ||
      recovered.intentCommit !== storage.intentCommit ||
      recovered.readyCommit !== storage.readyCommit ||
      recovered.payload.digest !== storage.payloadDigest ||
      recovered.payload.bytes !== storage.payloadBytes ||
      storage.payloadDigest !== descriptor.content.digest ||
      storage.payloadBytes !== descriptor.content.bytes
    )
      throw new Error("validation capture transfer differs from durable result authority");
  }
  return { ref, commit: record.commitOid, result };
}
