import { z } from "zod";
import { createHash } from "node:crypto";

import {
  MAX_WORKER_PACKET_BYTES,
  assertNoSecretMaterial,
  assertWithinBytes,
  boundedText,
  gitSha,
  safeId,
  sha256Digest,
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
    evidence: shortList(
      z
        .object({
          field: z.enum([
            "os",
            "architecture",
            "cpu",
            "memoryMb",
            "diskMb",
            "timeoutMinutes",
            "artifactContract",
          ]),
          kind: z.enum(["repository", "run-policy", "factory-default"]),
          source: boundedText(500),
        })
        .strict(),
      16,
    ).optional(),
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

export const ValidationDesignSchema = z
  .array(
    z
      .object({
        tier: z.enum(["mechanical", "semantic", "visual", "deterministic-simulation"]),
        criteria: shortList(boundedText(2_000)).min(1),
        rationale: boundedText(2_000).optional(),
        evidenceCommands: shortList(boundedText(1_000), 32).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(4);

export const CriterionRiskAssessmentSchema = z
  .array(
    z
      .object({
        criterion: boundedText(2_000),
        risk: z.enum([
          "ordinary",
          "safety",
          "security",
          "destructive-action",
          "accounting",
          "recovery",
        ]),
      })
      .strict(),
  )
  .min(1)
  .max(64);

export const RepositoryCapabilityOperationSchema = z
  .object({
    kind: safeId,
    key: safeId,
  })
  .strict();

export const RuntimeBundleRequirementSchema = z
  .object({
    tool: z.literal("pnpm"),
    adapter: safeId,
    adapterContract: z.number().int().positive().max(1_000),
    platform: z
      .object({
        os: z.literal("linux"),
        architecture: z.literal("x64"),
        libc: z.literal("glibc"),
      })
      .strict(),
    releaseChannel: z.literal("ga"),
    bundleDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const SelectedRuntimeBundleRequirementSchema = RuntimeBundleRequirementSchema.extend({
  bundleDigest: sha256Digest,
}).strict();

export const RuntimeBundleReceiptSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/toolchain-runtime-bundle-v1"),
    tool: z.literal("pnpm"),
    adapter: safeId,
    adapterContract: z.number().int().positive().max(1_000),
    platform: z
      .object({
        os: z.literal("linux"),
        architecture: z.literal("x64"),
        libc: z.literal("glibc"),
      })
      .strict(),
    components: shortList(
      z
        .object({
          id: safeId,
          version: boundedText(160),
          release: z
            .object({
              provider: z.enum(["github", "nodejs"]),
              repository: boundedText(200),
              releaseId: boundedText(500),
              tag: boundedText(200),
              publishedAt: z.string().datetime(),
            })
            .strict(),
          asset: z
            .object({
              assetId: boundedText(2_048),
              name: boundedText(500),
              url: boundedText(2_048),
              size: z
                .number()
                .int()
                .positive()
                .max(512 * 1024 * 1024),
              sha256: sha256Digest,
              archive: z.enum(["raw", "tar.gz", "tar.xz", "zip"]),
            })
            .strict(),
          executablePath: RepositoryScopePathSchema.refine(
            (value) => !value.endsWith("/"),
            "runtime executable must be a file path",
          ),
          executableSha256: sha256Digest,
          treeSha256: sha256Digest,
          executableOnly: z.literal(true).optional(),
        })
        .strict(),
      8,
    ).min(1),
    resolvedAt: z.string().datetime(),
    digest: sha256Digest,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (new Set(receipt.components.map(({ id }) => id)).size !== receipt.components.length) {
      context.addIssue({ code: "custom", message: "runtime receipt components are duplicated" });
    }
    const { digest, resolvedAt: _resolvedAt, ...identity } = receipt;
    if (digest !== createHash("sha256").update(canonicalJson(identity)).digest("hex")) {
      context.addIssue({ code: "custom", message: "runtime receipt digest mismatch" });
    }
  });

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const ManagedRuntimeActivationSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/managed-runtime-activation-v1"),
    baseSha: gitSha,
    sourceRef: boundedText(500),
    requirements: shortList(SelectedRuntimeBundleRequirementSchema, 8).min(1),
    receipts: shortList(RuntimeBundleReceiptSchema, 8).min(1),
    packetDigest: sha256Digest,
    proofDigests: shortList(sha256Digest, 32),
    digest: sha256Digest,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.requirements.map(({ adapter, tool }) => `${adapter}\0${tool}`)).size !==
        value.requirements.length ||
      value.proofDigests.some((digest, index) => value.proofDigests.indexOf(digest) !== index)
    ) {
      context.addIssue({ code: "custom", message: "managed runtime activation is duplicated" });
    }
    if (
      value.receipts.length !== value.requirements.length ||
      value.requirements.some(
        (requirement) =>
          !value.receipts.some(
            (receipt) =>
              receipt.tool === requirement.tool &&
              receipt.adapter === requirement.adapter &&
              receipt.adapterContract === requirement.adapterContract &&
              receipt.digest === requirement.bundleDigest &&
              canonicalJson(receipt.platform) === canonicalJson(requirement.platform),
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "managed runtime activation receipts differ from its requirements",
      });
    }
    const { digest, ...identity } = value;
    if (digest !== createHash("sha256").update(canonicalJson(identity)).digest("hex")) {
      context.addIssue({ code: "custom", message: "managed runtime activation digest mismatch" });
    }
  });

const RepositoryCapabilityProvisionSchema = z
  .object({
    adapter: safeId,
    generation: safeId,
    authorityPaths: shortList(RepositoryScopePathSchema, 16).min(1),
    operations: shortList(RepositoryCapabilityOperationSchema, 32).min(1),
    runtime: RuntimeBundleRequirementSchema.optional(),
  })
  .strict();

const RepositoryCapabilityRequirementSchema = z
  .object({
    adapter: safeId,
    generation: safeId,
    providerWorkItem: safeId,
    authorityPaths: shortList(RepositoryScopePathSchema, 16).min(1),
    operation: RepositoryCapabilityOperationSchema,
    activation: z.enum(["artifact", "integrated-base"]),
    runtime: RuntimeBundleRequirementSchema.optional(),
  })
  .strict();

export const RepositoryCapabilityBindingsSchema = z
  .object({
    provides: shortList(RepositoryCapabilityProvisionSchema, 16).default([]),
    requires: shortList(RepositoryCapabilityRequirementSchema, 32).default([]),
  })
  .strict();

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
    criterionRisks: CriterionRiskAssessmentSchema.optional(),
    validation: ValidationDesignSchema.optional(),
    repositoryCapabilities: RepositoryCapabilityBindingsSchema.optional(),
    managedRuntimes: shortList(RuntimeBundleRequirementSchema, 8).optional(),
    baseSha: gitSha,
    validationCommands: shortList(boundedText(1_000), 32).min(1),
    requirements: ExecutionRequirementsSchema,
    artifactContract: z.literal("clockgrove.factory/artifact-v1"),
  })
  .passthrough();

export type ExecutionRequirements = z.infer<typeof ExecutionRequirementsSchema>;
export type WorkerPacket = z.infer<typeof WorkerPacketSchema>;
export type ManagedRuntimeActivation = z.infer<typeof ManagedRuntimeActivationSchema>;
export interface RepositoryCapabilityOperation {
  kind: string;
  key: string;
}
export interface RepositoryCapabilityProvision {
  adapter: string;
  generation: string;
  authorityPaths: string[];
  operations: RepositoryCapabilityOperation[];
  runtime?: z.infer<typeof RuntimeBundleRequirementSchema>;
}
export interface RepositoryCapabilityRequirement {
  adapter: string;
  generation: string;
  providerWorkItem: string;
  authorityPaths: string[];
  operation: RepositoryCapabilityOperation;
  activation: "artifact" | "integrated-base";
  runtime?: z.infer<typeof RuntimeBundleRequirementSchema>;
}
export interface RepositoryCapabilityBindings {
  provides: RepositoryCapabilityProvision[];
  requires: RepositoryCapabilityRequirement[];
}

/** Legacy packets conservatively retain semantic review of every criterion. */
export function semanticReviewCriteria(packet: WorkerPacket): string[] {
  if (!packet.validation) return [...packet.acceptanceCriteria];
  const accepted = new Set(packet.acceptanceCriteria);
  const seenTiers = new Set<string>();
  const mapped = new Map<string, typeof packet.validation>();
  for (const entry of packet.validation) {
    if (
      seenTiers.has(entry.tier) ||
      entry.criteria.some((criterion) => !accepted.has(criterion)) ||
      new Set(entry.criteria).size !== entry.criteria.length ||
      !entry.rationale ||
      !entry.evidenceCommands ||
      new Set(entry.evidenceCommands).size !== entry.evidenceCommands.length
    )
      return [...packet.acceptanceCriteria];
    seenTiers.add(entry.tier);
    for (const criterion of entry.criteria)
      mapped.set(criterion, [...(mapped.get(criterion) ?? []), entry]);
  }
  return packet.acceptanceCriteria.filter((criterion) => {
    const routes = mapped.get(criterion);
    if (!routes?.length) return true;
    if (routes.some((entry) => entry.tier === "semantic" || entry.tier === "visual")) return true;
    return !routes.some(
      (entry) =>
        (entry.tier === "mechanical" || entry.tier === "deterministic-simulation") &&
        entry.evidenceCommands!.length > 0 &&
        entry.evidenceCommands!.every((command) => packet.validationCommands.includes(command)),
    );
  });
}

export function parseWorkerPacket(input: unknown): WorkerPacket {
  const packet = WorkerPacketSchema.parse(input);
  assertWithinBytes(packet, MAX_WORKER_PACKET_BYTES, "Worker Packet");
  assertNoSecretMaterial(packet, "Worker Packet");
  return packet;
}

/** Stable content identity for a prepared execution, including retry context and
 * policy-grounded requirements. Object key order is not execution authority. */
export function workerPacketDigest(input: unknown): string {
  const packet: unknown = JSON.parse(JSON.stringify(parseWorkerPacket(input)));
  return createHash("sha256").update(canonicalJson(packet)).digest("hex");
}
