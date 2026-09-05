import { z } from "zod";
import { safeId, sha256Digest, isoDate } from "./limits.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const LocalScopeIdentitySchema = z
  .object({
    protocol: z.literal("clockgrove.factory/local-scope-v1"),
    repository: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    objective: positive,
    workItem: positive,
    attempt: positive,
    runId: safeId,
    directorEpoch: positive,
    policyDigest: sha256Digest,
    phase: z.enum(["execution", "validation"]),
    commandIndex: z.number().int().nonnegative().max(256),
    /** Content-addressed execution/validation invocation, distinct across rebases. */
    invocationDigest: sha256Digest,
    hostIdentity: sha256Digest,
    producerUnit: z
      .string()
      .regex(/^[A-Za-z0-9_.@:-]+\.service$/)
      .max(255)
      .optional(),
    producerInvocationId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.producerUnit === undefined) === (value.producerInvocationId === undefined),
    "producer service requires its exact invocation identity",
  );

export type LocalScopeIdentity = z.infer<typeof LocalScopeIdentitySchema>;
export function parseLocalScopeIdentity(input: unknown): LocalScopeIdentity {
  return LocalScopeIdentitySchema.parse(input);
}

/** One existing capacity receipt covers every possible command in this phase.
 * The producer binding is needed to rule out a delayed, not-yet-visible launch. */
export const LocalScopeBatchSchema = z
  .object({
    identity: LocalScopeIdentitySchema,
    commandCount: positive.max(257),
    producerPid: positive,
    producerStartTicks: z.string().regex(/^[0-9]{1,30}$/),
    deadline: isoDate,
  })
  .strict()
  .refine((value) => value.identity.commandIndex === 0, "scope batch starts at command zero");
export type LocalScopeBatch = z.infer<typeof LocalScopeBatchSchema>;
