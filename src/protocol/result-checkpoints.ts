import { z } from "zod";
import { gitSha, safeId, sha256Digest } from "./limits.js";
import { ValidationEvidenceSchema } from "../validation/evidence.js";
import { FindingCandidateSchema } from "./findings.js";

export const ReviewIdentitySchema = z
  .object({
    kind: z.enum(["artifact", "rebase", "integration-candidate"]),
    runId: z.string().min(1).max(200),
    objective: z.number().int().positive(),
    workItem: z.number().int().positive(),
    attempt: z.number().int().positive(),
    artifactDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    evidenceDigest: sha256Digest,
    headSha: gitSha.optional(),
  })
  .strict()
  .superRefine((value, issue) => {
    if ((value.kind !== "artifact") !== Boolean(value.headSha)) {
      issue.addIssue({
        code: "custom",
        path: ["headSha"],
        message: "headSha is required for rebase and integration-candidate reviews only",
      });
    }
  });

const SemanticReviewSchema = z
  .object({
    accepted: z.boolean(),
    summary: z.string().min(1).max(8_000),
    unmetCriteria: z.array(z.string().max(2_000)).max(64),
    risks: z.array(z.string().max(2_000)).max(64),
    findings: z.array(FindingCandidateSchema).max(16).optional(),
  })
  .strict();

const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.cachedInputTokens === undefined || value.cachedInputTokens <= value.inputTokens,
    { message: "cached input tokens cannot exceed input tokens", path: ["cachedInputTokens"] },
  );

export const ReviewReceiptSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/review-checkpoint-v1"),
    identityDigest: sha256Digest,
    identity: ReviewIdentitySchema,
    review: SemanticReviewSchema,
    usage: UsageSchema,
  })
  .strict();

export const ValidationIdentitySchema = z
  .object({
    runId: safeId,
    objective: z.number().int().positive(),
    workItem: z.number().int().positive(),
    attempt: z.number().int().positive(),
    artifactDigest: sha256Digest,
    baseSha: gitSha,
    directorEpoch: z.number().int().positive(),
    policyDigest: sha256Digest,
  })
  .strict();

export const ValidationCheckpointSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/validation-checkpoint-v1"),
    identityDigest: sha256Digest,
    identity: ValidationIdentitySchema,
    writerEpoch: z.number().int().positive(),
    evidence: ValidationEvidenceSchema,
  })
  .strict();
