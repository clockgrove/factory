import { z } from "zod";

import {
  MAX_WORKER_PACKET_BYTES,
  assertNoSecretMaterial,
  assertWithinBytes,
  boundedText,
  gitSha,
  safeId,
} from "./limits.js";

const shortList = (item: z.ZodTypeAny, max = 64) => z.array(item).max(max);
export const RepositoryScopePathSchema = boundedText(500).refine((value) => {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("[")
  )
    return false;
  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  return (
    withoutTrailingSlash.length > 0 &&
    withoutTrailingSlash.split("/").every((part) => part !== "." && part !== ".." && part !== "")
  );
}, "scope must be a repository-relative file or directory ending in '/', without traversal or globs");
export const NetworkDestinationSchema = boundedText(253)
  .regex(/^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/)
  .refine(
    (value) =>
      !value.toLowerCase().endsWith(".localhost") &&
      value.toLowerCase() !== "metadata.google.internal",
    "network destination may not target local or instance-metadata services",
  );

export const ExecutionRequirementsSchema = z
  .object({
    os: shortList(boundedText(40), 12).default([]),
    architecture: shortList(boundedText(40), 8).default([]),
    cpu: z.number().positive().max(256).optional(),
    memoryMb: z.number().int().positive().max(1_048_576).optional(),
    diskMb: z.number().int().positive().max(10_485_760).optional(),
    timeoutMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .optional(),
    estimatedDurationMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .optional(),
    tools: shortList(safeId).default([]),
    services: shortList(safeId).default([]),
    networkDestinations: shortList(NetworkDestinationSchema, 64).default([]),
    permittedSecretNames: shortList(z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/), 32).default([]),
    trust: z.enum(["trusted_local", "isolated", "managed"]),
  })
  .passthrough();

export const RetryContextSchema = z.object({
  attempt: z.number().int().positive(),
  outcome: z.enum(["failed", "timed_out"]),
  reason: boundedText(2_000),
});

export const ContextManifestSchema = z
  .object({
    mustRead: shortList(RepositoryScopePathSchema).default([]),
    searchSeeds: shortList(boundedText(500)).default([]),
    dependencyEvidence: shortList(
      z
        .object({
          workItem: safeId,
          commit: gitSha,
        })
        .strict(),
    ).default([]),
  })
  .strict();

export const ChangeSurfaceSchema = z
  .object({
    mergeClass: z.enum(["parallel-safe", "exclusive", "generated", "large-binary"]),
    exclusiveResources: shortList(boundedText(200)).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mergeClass === "parallel-safe" && value.exclusiveResources.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusiveResources"],
        message: "parallel-safe work cannot claim an exclusive resource",
      });
    }
  });

export const DeliveryHintSchema = z
  .object({
    group: safeId,
    relationship: z.enum(["root", "continue-stack", "sibling", "join-after-merge"]),
    parentWorkItem: safeId.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.relationship === "continue-stack" && !value.parentWorkItem) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentWorkItem"],
        message: "is required when continuing a stack",
      });
    }
    if (value.relationship !== "continue-stack" && value.parentWorkItem) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentWorkItem"],
        message: "is only valid when continuing a stack",
      });
    }
  });

export const WorkerPacketSchema = z
  .object({
    goal: boundedText(4_000),
    acceptanceCriteria: shortList(boundedText(2_000)).min(1),
    allowedPaths: shortList(RepositoryScopePathSchema).min(1),
    preconditions: shortList(boundedText(2_000)).default([]),
    outOfScope: shortList(boundedText(2_000)).default([]),
    conventions: shortList(boundedText(2_000)).default([]),
    retryContext: RetryContextSchema.optional(),
    context: ContextManifestSchema.optional(),
    changeSurface: ChangeSurfaceSchema.optional(),
    delivery: DeliveryHintSchema.optional(),
    baseSha: gitSha,
    validationCommands: shortList(boundedText(1_000), 32).min(1),
    requirements: ExecutionRequirementsSchema,
    artifactContract: z.literal("clockgrove.factory/artifact-v1"),
  })
  .passthrough();

export type ExecutionRequirements = z.infer<typeof ExecutionRequirementsSchema>;
export type WorkerPacket = z.infer<typeof WorkerPacketSchema>;

export function parseWorkerPacket(input: unknown): WorkerPacket {
  const packet = WorkerPacketSchema.parse(input);
  assertWithinBytes(packet, MAX_WORKER_PACKET_BYTES, "Worker Packet");
  assertNoSecretMaterial(packet, "Worker Packet");
  return packet;
}
