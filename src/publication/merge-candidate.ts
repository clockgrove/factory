import { createHash } from "node:crypto";
import { z } from "zod";

import { gitSha, sha256Digest } from "../protocol/limits.js";
import { verifyValidationEvidence, type ValidationEvidence } from "../validation/evidence.js";
import { verifyExactHeadValidation, type ExactHeadValidationEvidence } from "../validation/plan.js";
import type { PublicationStore } from "./publisher.js";

export const MERGE_CANDIDATE_VALIDATION_PROTOCOL =
  "clockgrove.factory/merge-candidate-validation-v1" as const;

const sourceSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/exact-head-validation-v1"),
    validationDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    publishedHeadSha: gitSha,
    digest: sha256Digest,
  })
  .strict();

const candidateSchema = z
  .object({
    protocol: z.literal(MERGE_CANDIDATE_VALIDATION_PROTOCOL),
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

/** Original published head and newly validated squash tree are distinct immutable identities. */
export type MergeCandidateValidationEvidence = z.infer<typeof candidateSchema>;

function candidateDigest(evidence: Omit<MergeCandidateValidationEvidence, "digest">): string {
  // Fixed field order makes identity independent of input object insertion order.
  return createHash("sha256")
    .update(
      JSON.stringify({
        protocol: evidence.protocol,
        sourceExactHeadValidationDigest: evidence.sourceExactHeadValidationDigest,
        sourceBaseSha: evidence.sourceBaseSha,
        sourceHeadSha: evidence.sourceHeadSha,
        sourceTreeSha: evidence.sourceTreeSha,
        targetBaseSha: evidence.targetBaseSha,
        candidateOutputTreeSha: evidence.candidateOutputTreeSha,
        candidateArtifactDigest: evidence.candidateArtifactDigest,
        candidateValidationDigest: evidence.candidateValidationDigest,
      }),
    )
    .digest("hex");
}

function verifySource(source: ExactHeadValidationEvidence): void {
  sourceSchema.parse(source);
  verifyExactHeadValidation(source, source.publishedHeadSha);
}

/** Bind a full successful validation; this does not publish a head or authorize a merge. */
export function bindMergeCandidateValidation(input: {
  source: ExactHeadValidationEvidence;
  validation: ValidationEvidence;
}): MergeCandidateValidationEvidence {
  verifySource(input.source);
  verifyValidationEvidence(input.validation);
  if (!input.validation.passed) throw new Error("merge candidate validation did not pass");
  if (
    input.validation.commands.some((command) => command.exitCode !== 0) ||
    input.validation.failureReason !== undefined ||
    Date.parse(input.validation.completedAt) < Date.parse(input.validation.startedAt)
  )
    throw new Error("merge candidate validation has a contradictory outcome");
  const evidence = {
    protocol: MERGE_CANDIDATE_VALIDATION_PROTOCOL,
    sourceExactHeadValidationDigest: input.source.digest,
    sourceBaseSha: input.source.baseSha,
    sourceHeadSha: input.source.publishedHeadSha,
    sourceTreeSha: input.source.outputTreeSha,
    targetBaseSha: input.validation.baseSha,
    candidateOutputTreeSha: input.validation.outputTreeSha,
    candidateArtifactDigest: input.validation.artifactDigest,
    candidateValidationDigest: input.validation.digest,
  };
  const bound = { ...evidence, digest: candidateDigest(evidence) };
  verifyMergeCandidateValidation(bound, input.source, input.validation.baseSha);
  return bound;
}

/** Verify only the binding. Its authenticated owner must retain/reverify full validation and review. */
export function verifyMergeCandidateValidation(
  evidence: MergeCandidateValidationEvidence,
  source: ExactHeadValidationEvidence,
  expectedBaseSha?: string,
): void {
  const parsed = candidateSchema.parse(evidence);
  verifySource(source);
  if (parsed.digest !== candidateDigest(parsed))
    throw new Error("merge candidate evidence digest mismatch");
  if (
    parsed.sourceExactHeadValidationDigest !== source.digest ||
    parsed.sourceBaseSha !== source.baseSha ||
    parsed.sourceHeadSha !== source.publishedHeadSha ||
    parsed.sourceTreeSha !== source.outputTreeSha
  )
    throw new Error("merge candidate evidence does not bind the original published head");
  if (parsed.targetBaseSha.toLowerCase() === parsed.sourceBaseSha.toLowerCase())
    throw new Error("merge candidate requires a changed target base");
  if (expectedBaseSha !== undefined) {
    gitSha.parse(expectedBaseSha);
    if (parsed.targetBaseSha !== expectedBaseSha)
      throw new Error("merge candidate target base differs from the expected base");
  }
}

/** Verify the actual squash result, never substitute the original PR tree for the candidate tree. */
export async function verifyMergeCandidateSquash(
  store: Pick<PublicationStore, "readCommit">,
  source: ExactHeadValidationEvidence,
  evidence: MergeCandidateValidationEvidence,
  mergeCommitSha: string,
): Promise<void> {
  verifyMergeCandidateValidation(evidence, source);
  gitSha.parse(mergeCommitSha);
  const commit = await store.readCommit(mergeCommitSha);
  if (
    commit.oid !== mergeCommitSha ||
    commit.parentOids.length !== 1 ||
    commit.parentOids[0] !== evidence.targetBaseSha ||
    commit.treeOid !== evidence.candidateOutputTreeSha
  )
    throw new Error(
      "merged squash commit does not preserve the merge candidate tree on its target base",
    );
}
