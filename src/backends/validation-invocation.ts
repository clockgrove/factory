import { createHash } from "node:crypto";
import { z } from "zod";
import type { IsolatedValidationContext, StaleAttemptIdentity } from "../execution/backend.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const Invocation = z
  .object({
    kind: z.literal("integration-candidate"),
    identityDigest: digest,
    artifactDigest: digest,
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

/** A deterministic resource locator, not admission or cleanup authority. */
export function validationInvocationOwnership(
  input: IsolatedValidationContext | StaleAttemptIdentity,
): string | null {
  if (!input.validationInvocation) return null;
  const invocation = Invocation.parse(input.validationInvocation);
  if (
    "packet" in input &&
    (invocation.baseSha !== input.packet.baseSha ||
      invocation.baseSha !== input.artifact.baseSha ||
      invocation.artifactDigest !== input.artifact.digest)
  )
    throw new Error("validation invocation differs from its exact artifact and base");
  const identity = z
    .object({
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      objective: z.number().int().positive(),
      workItem: z.number().int().positive(),
      attempt: z.number().int().positive(),
      runId: z.string().min(1).max(200),
      directorEpoch: z.number().int().positive(),
      policyDigest: digest,
    })
    .parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...identity,
        repository: identity.repository.toLowerCase(),
        invocation,
      }),
    )
    .digest("hex");
}
