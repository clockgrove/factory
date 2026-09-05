import { createHash } from "node:crypto";
import { z } from "zod";
import { CommandResultSchema } from "../execution/artifacts.js";
import { assertNoSecretMaterial, gitSha, safeId, sha256Digest } from "../protocol/limits.js";
import {
  bindMergeCandidateValidation,
  type MergeCandidateValidationEvidence,
} from "../publication/merge-candidate.js";
import { ValidationEvidenceSchema, type ValidationEvidence } from "../validation/evidence.js";
import type { ExactHeadValidationEvidence } from "../validation/plan.js";
import type { CompiledGraphReadStore, CompiledGraphStore } from "./graphs.js";
import type { LeaseManager, LeaseState } from "./lease.js";

export const MAX_MERGE_CANDIDATE_CHECKPOINT_BYTES = 512 * 1024;
const CHECKPOINT_PATH = ".clockgrove-factory/control/merge-candidate.json";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IdentitySchema = z
  .object({
    runId: safeId,
    objective: positive,
    workItem: positive,
    attempt: positive,
    pullRequest: positive,
    sourceHeadSha: gitSha,
    sourceExactHeadValidationDigest: sha256Digest,
    targetBaseSha: gitSha,
  })
  .strict();
const SourceSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/exact-head-validation-v1"),
    validationDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    publishedHeadSha: gitSha,
    digest: sha256Digest,
  })
  .strict();
const FullValidationSchema = ValidationEvidenceSchema.extend({
  commands: z.array(CommandResultSchema.strict()).max(128),
}).strict();
const CandidateSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/merge-candidate-validation-v1"),
    sourceExactHeadValidationDigest: sha256Digest,
    sourceBaseSha: gitSha,
    sourceHeadSha: gitSha,
    sourceTreeSha: gitSha,
    targetBaseSha: gitSha,
    candidateOutputTreeSha: gitSha,
    candidateArtifactDigest: sha256Digest,
    candidateValidationDigest: sha256Digest,
    digest: sha256Digest,
  })
  .strict();
const IsolatedResourceSchema = z
  .object({
    backend: z.literal("codex-cli/daytona"),
    invocationOwnershipDigest: sha256Digest,
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    sandboxMilliseconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.completedAt) - Date.parse(value.startedAt) !== value.sandboxMilliseconds)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "isolated resource duration differs from completion interval",
      });
  });
const CheckpointSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/merge-candidate-checkpoint-v1"),
    identityDigest: sha256Digest,
    identity: IdentitySchema,
    source: SourceSchema,
    validation: FullValidationSchema,
    evidence: CandidateSchema,
    isolatedResource: IsolatedResourceSchema.optional(),
  })
  .strict();

export type MergeCandidateIdentity = z.infer<typeof IdentitySchema>;
export interface MergeCandidateCheckpointRecord {
  ref: string;
  commitOid: string;
  blobOid: string;
  identity: MergeCandidateIdentity;
  source: ExactHeadValidationEvidence;
  validation: ValidationEvidence;
  evidence: MergeCandidateValidationEvidence;
  isolatedResource?: z.infer<typeof IsolatedResourceSchema>;
}
type Checkpoint = z.infer<typeof CheckpointSchema>;
function requireCheckpoint(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Invalid merge-candidate checkpoint: ${reason}`);
}
export function mergeCandidateIdentityDigest(input: MergeCandidateIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(IdentitySchema.parse(input)))
    .digest("hex");
}
export function mergeCandidateCheckpointRef(input: MergeCandidateIdentity): string {
  const identity = IdentitySchema.parse(input);
  return `refs/clockgrove-factory/merge-candidates/objective-${identity.objective}/work-item-${identity.workItem}/attempt-${identity.attempt}/candidate-${mergeCandidateIdentityDigest(identity)}`;
}
function parseCheckpoint(input: unknown): Checkpoint {
  requireCheckpoint(
    Buffer.byteLength(JSON.stringify(input), "utf8") <= MAX_MERGE_CANDIDATE_CHECKPOINT_BYTES,
    "document exceeds 512 KiB",
  );
  const value = CheckpointSchema.parse(input);
  requireCheckpoint(
    value.identityDigest === mergeCandidateIdentityDigest(value.identity),
    "identity digest mismatch",
  );
  requireCheckpoint(
    value.source.publishedHeadSha === value.identity.sourceHeadSha &&
      value.source.digest === value.identity.sourceExactHeadValidationDigest &&
      value.validation.baseSha === value.identity.targetBaseSha,
    "source or target identity mismatch",
  );
  const evidence = bindMergeCandidateValidation({
    source: value.source,
    validation: value.validation,
  });
  requireCheckpoint(
    JSON.stringify(evidence) === JSON.stringify(value.evidence),
    "derived validation binding mismatch",
  );
  assertNoSecretMaterial(JSON.stringify(value), "merge-candidate checkpoint");
  return value;
}
function sameCandidate(record: MergeCandidateCheckpointRecord, value: Checkpoint): boolean {
  return (
    mergeCandidateIdentityDigest(record.identity) === value.identityDigest &&
    JSON.stringify(record.source) === JSON.stringify(value.source) &&
    record.evidence.candidateOutputTreeSha === value.evidence.candidateOutputTreeSha &&
    record.isolatedResource?.invocationOwnershipDigest ===
      value.isolatedResource?.invocationOwnershipDigest &&
    record.evidence.candidateArtifactDigest === value.evidence.candidateArtifactDigest
  );
}

export async function loadMergeCandidateCheckpoint(
  store: CompiledGraphReadStore,
  input: MergeCandidateIdentity,
): Promise<MergeCandidateCheckpointRecord | null> {
  const identity = IdentitySchema.parse(input);
  const ref = mergeCandidateCheckpointRef(identity);
  const commitOid = await store.readRef(ref);
  if (!commitOid) return null;
  gitSha.parse(commitOid);
  const commit = await store.readCommit(commitOid);
  requireCheckpoint(
    commit.oid === commitOid &&
      commit.parentOids.length === 1 &&
      commit.parentOids[0] === identity.targetBaseSha,
    "commit identity or target parent mismatch",
  );
  const blobOid = await store.readTreeEntry(commit.treeOid, CHECKPOINT_PATH);
  requireCheckpoint(blobOid, "missing document");
  gitSha.parse(blobOid);
  const bytes = await store.readBlob(blobOid);
  requireCheckpoint(
    bytes.byteLength <= MAX_MERGE_CANDIDATE_CHECKPOINT_BYTES,
    "document exceeds 512 KiB",
  );
  const value = parseCheckpoint(JSON.parse(bytes.toString("utf8")));
  requireCheckpoint(
    value.identityDigest === mergeCandidateIdentityDigest(identity),
    "reference identity mismatch",
  );
  // Preserve schema field order: validation and exact-head digests bind JSON field order.
  requireCheckpoint(bytes.toString("utf8") === JSON.stringify(value), "noncanonical document");
  return {
    ref,
    commitOid,
    blobOid,
    identity: value.identity,
    source: value.source,
    validation: value.validation,
    evidence: value.evidence,
    ...(value.isolatedResource ? { isolatedResource: value.isolatedResource } : {}),
  };
}

/** Immutable validation before a paid merge-candidate review; no PR, branch, or merge mutation. */
export class MergeCandidateCheckpointStore {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: LeaseManager,
  ) {}
  load(identity: MergeCandidateIdentity): Promise<MergeCandidateCheckpointRecord | null> {
    return loadMergeCandidateCheckpoint(this.store, identity);
  }
  async persist(args: {
    lease: LeaseState;
    identity: MergeCandidateIdentity;
    source: ExactHeadValidationEvidence;
    validation: ValidationEvidence;
    isolatedResource?: z.infer<typeof IsolatedResourceSchema>;
  }): Promise<MergeCandidateCheckpointRecord> {
    const identity = IdentitySchema.parse(args.identity);
    requireCheckpoint(
      identity.objective === args.lease.objective && identity.runId === args.lease.runId,
      "lease scope mismatch",
    );
    await this.leases.assertCurrent(args.lease);
    const value = parseCheckpoint({
      protocol: "clockgrove.factory/merge-candidate-checkpoint-v1",
      identityDigest: mergeCandidateIdentityDigest(identity),
      identity,
      source: args.source,
      validation: args.validation,
      evidence: bindMergeCandidateValidation({ source: args.source, validation: args.validation }),
      ...(args.isolatedResource ? { isolatedResource: args.isolatedResource } : {}),
    });
    const winner = (
      record: MergeCandidateCheckpointRecord | null,
    ): MergeCandidateCheckpointRecord => {
      requireCheckpoint(record && sameCandidate(record, value), "conflicting immutable candidate");
      return record;
    };
    const existing = await this.load(identity);
    if (existing) return winner(existing);
    const base = await this.store.readCommit(identity.targetBaseSha);
    requireCheckpoint(base.oid === identity.targetBaseSha, "target base unavailable");
    await this.leases.assertCurrent(args.lease);
    const blobOid = await this.store.createBlob(Buffer.from(JSON.stringify(value), "utf8"));
    await this.leases.assertCurrent(args.lease);
    const treeOid = await this.store.createTree({
      entries: [{ path: CHECKPOINT_PATH, mode: "100644", type: "blob", sha: blobOid }],
    });
    await this.leases.assertCurrent(args.lease);
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [identity.targetBaseSha],
      message: `Factory merge candidate for Work Item #${identity.workItem}\n\nFactory-Merge-Candidate: ${value.identityDigest}`,
    });
    await this.leases.assertCurrent(args.lease);
    try {
      await this.store.createRef(mergeCandidateCheckpointRef(identity), commitOid);
    } catch (error) {
      const observed = await this.load(identity);
      if (observed) return winner(observed);
      throw error;
    }
    return winner(await this.load(identity));
  }
}
