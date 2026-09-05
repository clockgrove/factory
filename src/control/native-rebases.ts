import { createHash } from "node:crypto";
import { z } from "zod";
import { validationInvocationOwnership } from "../backends/validation-invocation.js";
import { CommandResultSchema } from "../execution/artifacts.js";
import type { IntegrationValidationInvocation } from "../execution/backend.js";
import { assertNoSecretMaterial, gitSha, safeId, sha256Digest } from "../protocol/limits.js";
import {
  ValidationEvidenceSchema,
  verifyValidationEvidence,
  type ValidationEvidence,
} from "../validation/evidence.js";
import {
  bindValidationToPublishedHead,
  verifyExactHeadValidation,
  type ExactHeadValidationEvidence,
} from "../validation/plan.js";
import type { CompiledGraphReadStore, CompiledGraphStore } from "./graphs.js";
import type { LeaseManager, LeaseState } from "./lease.js";

const PATH = ".clockgrove-factory/control/native-rebase.json";
export const MAX_NATIVE_REBASE_CHECKPOINT_BYTES = 512 * 1024;
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IdentitySchema = z
  .object({
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    runId: safeId,
    objective: positive,
    workItem: positive,
    attempt: positive,
    directorEpoch: positive,
    policyDigest: sha256Digest,
    pullRequest: positive,
    sourceHeadSha: gitSha,
    sourceExactHeadValidationDigest: sha256Digest,
    headSha: gitSha,
    baseSha: gitSha,
  })
  .strict();
const ExactHeadSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/exact-head-validation-v1"),
    validationDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    publishedHeadSha: gitSha,
    digest: sha256Digest,
  })
  .strict();
const ResourceSchema = z
  .object({
    backend: z.literal("codex-cli/daytona"),
    invocationOwnershipDigest: sha256Digest,
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    sandboxMilliseconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const Schema = z
  .object({
    protocol: z.literal("clockgrove.factory/native-rebase-checkpoint-v1"),
    identity: IdentitySchema,
    identityDigest: sha256Digest,
    source: ExactHeadSchema,
    validation: ValidationEvidenceSchema.extend({
      commands: z.array(CommandResultSchema.strict()).max(128),
      environmentIdentity: z
        .string()
        .max(500)
        .regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/),
    }).strict(),
    exactHeadValidation: ExactHeadSchema,
    isolatedResource: ResourceSchema,
  })
  .strict();

export type NativeRebaseIdentity = z.infer<typeof IdentitySchema>;
export type NativeRebaseResourceCompletion = z.infer<typeof ResourceSchema>;
type Document = z.infer<typeof Schema>;
export type NativeRebaseCheckpointRecord = Document & {
  ref: string;
  commitOid: string;
  blobOid: string;
};
function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid native-rebase checkpoint: ${message}`);
}
function identityOf(input: NativeRebaseIdentity): NativeRebaseIdentity {
  const identity = IdentitySchema.parse(input);
  return { ...identity, repository: identity.repository.toLowerCase() };
}
export function nativeRebaseIdentityDigest(input: NativeRebaseIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(identityOf(input)))
    .digest("hex");
}
export function nativeRebaseCheckpointRef(input: NativeRebaseIdentity): string {
  const identity = identityOf(input);
  return `refs/clockgrove-factory/native-rebases/objective-${identity.objective}/work-item-${identity.workItem}/attempt-${identity.attempt}/rebase-${nativeRebaseIdentityDigest(identity)}`;
}
export function nativeRebaseValidationInvocation(
  identity: NativeRebaseIdentity,
  artifactDigest: string,
): IntegrationValidationInvocation {
  return {
    kind: "native-stack-rebase",
    identityDigest: nativeRebaseIdentityDigest(identity),
    artifactDigest: sha256Digest.parse(artifactDigest),
    baseSha: identity.baseSha,
  };
}
export function nativeRebaseResourceOwnership(
  identity: NativeRebaseIdentity,
  artifactDigest: string,
): string {
  return validationInvocationOwnership({
    ...identityOf(identity),
    phase: "validation",
    validationInvocation: nativeRebaseValidationInvocation(identity, artifactDigest),
  })!;
}
function parseDocument(raw: unknown): Document {
  requireProof(
    Buffer.byteLength(JSON.stringify(raw)) <= MAX_NATIVE_REBASE_CHECKPOINT_BYTES,
    "document exceeds 512 KiB",
  );
  const value = Schema.parse(raw);
  const { identity, source, validation, isolatedResource: resource } = value;
  requireProof(
    identity.repository === identity.repository.toLowerCase(),
    "noncanonical repository",
  );
  requireProof(value.identityDigest === nativeRebaseIdentityDigest(identity), "identity mismatch");
  verifyExactHeadValidation(source, identity.sourceHeadSha);
  verifyValidationEvidence(validation);
  requireProof(
    source.digest === identity.sourceExactHeadValidationDigest &&
      source.publishedHeadSha === identity.sourceHeadSha &&
      identity.headSha !== identity.sourceHeadSha,
    "source or rewritten head mismatch",
  );
  requireProof(
    validation.baseSha === identity.baseSha &&
      validation.passed &&
      validation.commands.every((command) => command.exitCode === 0) &&
      validation.failureReason === undefined,
    "validation did not pass at the exact base",
  );
  const expected = bindValidationToPublishedHead({
    validation,
    publishedHeadSha: identity.headSha,
    publishedBaseSha: identity.baseSha,
    publishedTreeSha: validation.outputTreeSha,
  });
  requireProof(
    JSON.stringify(expected) === JSON.stringify(value.exactHeadValidation),
    "rewritten-head validation binding mismatch",
  );
  requireProof(
    resource.invocationOwnershipDigest ===
      nativeRebaseResourceOwnership(identity, validation.artifactDigest),
    "isolated resource ownership mismatch",
  );
  const start = Date.parse(resource.startedAt);
  const end = Date.parse(resource.completedAt);
  // Provider lifetime is measured by the controller across provision and cleanup.
  // Command evidence uses the sandbox clock; cross-clock containment is not a proof.
  requireProof(
    end - start === resource.sandboxMilliseconds &&
      Date.parse(validation.completedAt) >= Date.parse(validation.startedAt),
    "resource completion interval mismatch",
  );
  assertNoSecretMaterial(JSON.stringify(value), "native-rebase checkpoint");
  return value;
}
async function verifyHeads(store: CompiledGraphReadStore, value: Document): Promise<void> {
  for (const proof of [value.source, value.exactHeadValidation]) {
    const head = await store.readCommit(proof.publishedHeadSha);
    requireProof(
      head.oid === proof.publishedHeadSha &&
        head.parentOids.length === 1 &&
        head.parentOids[0] === proof.baseSha &&
        head.treeOid === proof.outputTreeSha,
      "observed Git head parent or tree differs from validation",
    );
  }
}
export async function loadNativeRebaseCheckpoint(
  store: CompiledGraphReadStore,
  input: NativeRebaseIdentity,
): Promise<NativeRebaseCheckpointRecord | null> {
  const identity = identityOf(input);
  const ref = nativeRebaseCheckpointRef(identity);
  const commitOid = await store.readRef(ref);
  if (!commitOid) return null;
  gitSha.parse(commitOid);
  const commit = await store.readCommit(commitOid);
  requireProof(
    commit.oid === commitOid &&
      commit.parentOids.length === 1 &&
      commit.parentOids[0] === identity.headSha,
    "checkpoint parent mismatch",
  );
  const blobOid = await store.readTreeEntry(commit.treeOid, PATH);
  requireProof(blobOid, "missing checkpoint document");
  gitSha.parse(blobOid);
  const bytes = await store.readBlob(blobOid);
  requireProof(bytes.byteLength <= MAX_NATIVE_REBASE_CHECKPOINT_BYTES, "document exceeds 512 KiB");
  const value = parseDocument(JSON.parse(bytes.toString("utf8")));
  requireProof(
    value.identityDigest === nativeRebaseIdentityDigest(identity),
    "reference identity mismatch",
  );
  requireProof(bytes.toString("utf8") === JSON.stringify(value), "noncanonical document");
  await verifyHeads(store, value);
  return { ...value, ref, commitOid, blobOid };
}

/** Fresh sandbox validation and cleanup evidence, persisted before any paid rebase review.
 * A checkpoint is reusable evidence, not admission, topology, or merge authority. */
export class NativeRebaseCheckpointStore {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: LeaseManager,
  ) {}
  load(identity: NativeRebaseIdentity): Promise<NativeRebaseCheckpointRecord | null> {
    return loadNativeRebaseCheckpoint(this.store, identity);
  }
  async persist(args: {
    lease: LeaseState;
    identity: NativeRebaseIdentity;
    source: ExactHeadValidationEvidence;
    validation: ValidationEvidence;
    isolatedResource: NativeRebaseResourceCompletion;
  }): Promise<NativeRebaseCheckpointRecord> {
    const identity = identityOf(args.identity);
    requireProof(
      identity.objective === args.lease.objective &&
        identity.runId === args.lease.runId &&
        identity.policyDigest === args.lease.policyDigest &&
        identity.directorEpoch <= args.lease.epoch,
      "lease scope mismatch",
    );
    await this.leases.assertCurrent(args.lease);
    const value = parseDocument({
      protocol: "clockgrove.factory/native-rebase-checkpoint-v1",
      identity,
      identityDigest: nativeRebaseIdentityDigest(identity),
      source: args.source,
      validation: args.validation,
      exactHeadValidation: bindValidationToPublishedHead({
        validation: args.validation,
        publishedHeadSha: identity.headSha,
        publishedBaseSha: identity.baseSha,
        publishedTreeSha: args.validation.outputTreeSha,
      }),
      isolatedResource: args.isolatedResource,
    });
    await verifyHeads(this.store, value);
    const winner = (record: NativeRebaseCheckpointRecord | null): NativeRebaseCheckpointRecord => {
      requireProof(record, "checkpoint response is unresolved");
      const { ref: _ref, commitOid: _commit, blobOid: _blob, ...document } = record;
      requireProof(
        JSON.stringify(document) === JSON.stringify(value),
        "conflicting immutable checkpoint",
      );
      return record;
    };
    const existing = await this.load(identity);
    if (existing) return winner(existing);
    await this.leases.assertCurrent(args.lease);
    const blobOid = await this.store.createBlob(Buffer.from(JSON.stringify(value), "utf8"));
    await this.leases.assertCurrent(args.lease);
    const treeOid = await this.store.createTree({
      entries: [{ path: PATH, mode: "100644", type: "blob", sha: blobOid }],
    });
    await this.leases.assertCurrent(args.lease);
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [identity.headSha],
      message: `Factory native rebase for Work Item #${identity.workItem}\n\nFactory-Native-Rebase: ${value.identityDigest}`,
    });
    await this.leases.assertCurrent(args.lease);
    try {
      await this.store.createRef(nativeRebaseCheckpointRef(identity), commitOid);
    } catch (error) {
      const observed = await this.load(identity);
      if (observed) return winner(observed);
      throw error;
    }
    return winner(await this.load(identity));
  }
}
