import { createHash } from "node:crypto";

import { z } from "zod";

import {
  MAX_LOG_BYTES,
  assertNoSecretMaterial,
  assertWithinBytes,
  boundedText,
  gitSha,
  isoDate,
  sha256Digest,
} from "../protocol/limits.js";

export const MAX_ARTIFACT_PATCH_BYTES = 5 * 1024 * 1024;

const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((part) => part !== ".." && part !== ""),
    "path must be repository-relative and may not traverse",
  );

export const CommandResultSchema = z
  .object({
    command: boundedText(1_000),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative(),
  })
  .passthrough();

export const NormalizedArtifactSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/artifact-v1"),
    baseSha: gitSha,
    digest: sha256Digest,
    patch: z.string().max(MAX_ARTIFACT_PATCH_BYTES),
    changedPaths: z.array(relativePath).max(10_000),
    commands: z.array(CommandResultSchema).max(128),
    logs: z.string().max(MAX_LOG_BYTES),
    outcome: z.enum(["succeeded", "failed", "declined"]),
    reason: z.string().max(8_000).optional(),
    createdAt: isoDate,
  })
  .passthrough();

export type NormalizedArtifact = z.infer<typeof NormalizedArtifactSchema>;

export interface ArtifactInput {
  baseSha: string;
  patch: string;
  changedPaths: string[];
  commands?: Array<{ command: string; exitCode: number; durationMs: number }>;
  logs?: string;
  outcome: "succeeded" | "failed" | "declined";
  reason?: string;
  createdAt?: Date;
}

export function artifactDigest(input: {
  baseSha: string;
  patch: string;
  changedPaths: string[];
}): string {
  return createHash("sha256")
    .update(input.baseSha)
    .update("\0")
    .update(input.changedPaths.slice().sort().join("\0"))
    .update("\0")
    .update(input.patch)
    .digest("hex");
}

export function normalizeArtifact(input: ArtifactInput): NormalizedArtifact {
  const core = {
    protocol: "clockgrove.factory/artifact-v1" as const,
    baseSha: input.baseSha,
    patch: input.patch,
    changedPaths: [...new Set(input.changedPaths)].sort(),
    commands: input.commands ?? [],
    logs: input.logs ?? "",
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
  const artifact = NormalizedArtifactSchema.parse({
    ...core,
    digest: artifactDigest(core),
  });
  assertWithinBytes(artifact.logs, MAX_LOG_BYTES, "worker logs");
  assertNoSecretMaterial(artifact.logs, "worker logs");
  return artifact;
}

export function verifyArtifact(artifact: NormalizedArtifact): NormalizedArtifact {
  const parsed = NormalizedArtifactSchema.parse(artifact);
  const expected = artifactDigest(parsed);
  if (parsed.digest !== expected) throw new Error("artifact digest does not match its contents");
  assertNoSecretMaterial(parsed.logs, "worker logs");
  return parsed;
}

export function assertArtifactScope(
  artifact: NormalizedArtifact,
  allowedPaths: string[],
): void {
  const permits = (path: string) =>
    allowedPaths.some((allowed) =>
      allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
    );
  const outside = artifact.changedPaths.filter((path) => !permits(path));
  if (outside.length > 0) {
    throw new Error(`artifact changes paths outside scope: ${outside.join(", ")}`);
  }
}
