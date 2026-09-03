import { createHash } from "node:crypto";

import { z } from "zod";

import { gitSha, isoDate, sha256Digest } from "../protocol/limits.js";
import { CommandResultSchema } from "../execution/artifacts.js";

export const ValidationEvidenceSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/validation-v1"),
    artifactDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    commands: z.array(CommandResultSchema).max(128),
    passed: z.boolean(),
    failureReason: z.string().max(8_000).optional(),
    startedAt: isoDate,
    completedAt: isoDate,
    digest: sha256Digest,
  })
  .passthrough();

export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;

function canonicalEvidence(
  evidence: Omit<ValidationEvidence, "digest">,
): string {
  return JSON.stringify(evidence);
}

export function createValidationEvidence(
  evidence: Omit<ValidationEvidence, "digest">,
): ValidationEvidence {
  return ValidationEvidenceSchema.parse({
    ...evidence,
    digest: createHash("sha256").update(canonicalEvidence(evidence)).digest("hex"),
  });
}

export function verifyValidationEvidence(evidence: ValidationEvidence): void {
  const parsed = ValidationEvidenceSchema.parse(evidence);
  const { digest, ...withoutDigest } = parsed;
  const expected = createHash("sha256")
    .update(canonicalEvidence(withoutDigest))
    .digest("hex");
  if (digest !== expected) throw new Error("validation evidence digest mismatch");
}
