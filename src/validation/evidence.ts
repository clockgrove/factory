import { createHash } from "node:crypto";

import { z } from "zod";

import { assertNoSecretMaterial, gitSha, isoDate, sha256Digest } from "../protocol/limits.js";
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
    environmentIdentity: z.string().min(1).max(500).optional(),
    digest: sha256Digest,
  })
  .passthrough();

export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;

function canonicalEvidence(evidence: Omit<ValidationEvidence, "digest">): string {
  return JSON.stringify(evidence);
}

export function createValidationEvidence(
  evidence: Omit<ValidationEvidence, "digest">,
): ValidationEvidence {
  if (evidence.environmentIdentity) {
    assertNoSecretMaterial(evidence.environmentIdentity, "validation environment identity");
  }
  return ValidationEvidenceSchema.parse({
    ...evidence,
    digest: createHash("sha256").update(canonicalEvidence(evidence)).digest("hex"),
  });
}

export function verifyValidationEvidence(evidence: ValidationEvidence): void {
  const parsed = ValidationEvidenceSchema.parse(evidence);
  if (parsed.environmentIdentity) {
    assertNoSecretMaterial(parsed.environmentIdentity, "validation environment identity");
  }
  const { digest, ...withoutDigest } = parsed;
  const expected = createHash("sha256").update(canonicalEvidence(withoutDigest)).digest("hex");
  if (digest !== expected) throw new Error("validation evidence digest mismatch");
}
