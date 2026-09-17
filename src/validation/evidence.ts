import { createHash } from "node:crypto";

import { z } from "zod";

import { assertNoSecretMaterial, gitSha, isoDate, sha256Digest } from "../protocol/limits.js";
import { CommandResultSchema } from "../execution/artifacts.js";
import { FindingCandidateSchema } from "../protocol/findings.js";
import { RepositoryCaptureEvidenceSchema } from "./repository-capture.js";

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
    findings: z.array(FindingCandidateSchema).max(16).optional(),
    validationInvocationDigest: sha256Digest.optional(),
    repositoryCapture: RepositoryCaptureEvidenceSchema.optional(),
    digest: sha256Digest,
  })
  .passthrough();

export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;
const ValidationEvidenceWithoutDigestSchema = ValidationEvidenceSchema.omit({ digest: true });
type ValidationEvidenceWithoutDigest = z.infer<typeof ValidationEvidenceWithoutDigestSchema>;

function canonicalEvidence(evidence: ValidationEvidenceWithoutDigest): string {
  return JSON.stringify(evidence);
}

function verifyRepositoryCaptureBinding(evidence: ValidationEvidenceWithoutDigest): void {
  const invocationDigest = evidence.validationInvocationDigest;
  const capture = evidence.repositoryCapture;
  if (capture && !invocationDigest)
    throw new Error("repository capture requires its exact validation invocation");
  if (capture && capture.validationInvocationDigest !== invocationDigest)
    throw new Error("repository capture differs from canonical validation invocation digest");
}

export function createValidationEvidence(
  evidence: ValidationEvidenceWithoutDigest,
): ValidationEvidence {
  if (evidence.environmentIdentity) {
    assertNoSecretMaterial(evidence.environmentIdentity, "validation environment identity");
  }
  verifyRepositoryCaptureBinding(evidence);
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
  verifyRepositoryCaptureBinding(withoutDigest);
  const expected = createHash("sha256").update(canonicalEvidence(withoutDigest)).digest("hex");
  if (digest !== expected) throw new Error("validation evidence digest mismatch");
}
