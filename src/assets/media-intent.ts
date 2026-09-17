import { z } from "zod";

import { boundedText, safeId, sha256Digest } from "../protocol/limits.js";

const referenceIds = (maximum: number) =>
  z
    .array(safeId)
    .max(maximum)
    .refine((ids) => new Set(ids).size === ids.length, "reference IDs must be unique");

export const MediaIntentKindSchema = z.enum([
  "concept-reference",
  "layout-reference",
  "state-diagram",
  "spatial-map",
  "style-reference",
  "sprite-sheet",
  "reference-board",
  "sound-reference",
  "motion-reference",
  "model-reference",
  "acceptance-capture",
]);

export const MediaIntentPurposeSchema = z.enum([
  "decision-input",
  "implementation-reference",
  "product-asset",
  "acceptance-evidence",
]);

export const MediaIntentBindingSchema = z
  .object({
    workItemId: safeId,
    direction: z.enum(["input-to", "evidence-for"]),
    criterionIds: referenceIds(64),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.direction === "evidence-for" && binding.criterionIds.length === 0)
      context.addIssue({
        code: "custom",
        path: ["criterionIds"],
        message: "acceptance evidence must identify at least one criterion",
      });
  });

export const MediaTypeSchema = boundedText(160).regex(
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i,
);

export const RasterMediaConstraintsSchema = z
  .object({
    minimumWidth: z.number().int().min(1).max(16_384).nullable(),
    maximumWidth: z.number().int().min(1).max(16_384).nullable(),
    minimumHeight: z.number().int().min(1).max(16_384).nullable(),
    maximumHeight: z.number().int().min(1).max(16_384).nullable(),
    alpha: z.enum(["allowed", "required", "forbidden"]),
    animation: z.enum(["allowed", "required", "forbidden"]),
  })
  .strict()
  .superRefine((value, context) => {
    for (const dimension of ["Width", "Height"] as const) {
      const minimum = value[`minimum${dimension}`];
      const maximum = value[`maximum${dimension}`];
      if (minimum !== null && maximum !== null && minimum > maximum)
        context.addIssue({
          code: "custom",
          path: [`minimum${dimension}`],
          message: `minimum ${dimension.toLowerCase()} exceeds maximum ${dimension.toLowerCase()}`,
        });
    }
  });

export const MediaOutputConstraintsSchema = z
  .object({
    mediaTypes: z.array(MediaTypeSchema).min(1).max(16),
    minimumCount: z.number().int().min(1).max(16),
    maximumCount: z.number().int().min(1).max(16),
    raster: RasterMediaConstraintsSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimumCount > value.maximumCount)
      context.addIssue({
        code: "custom",
        path: ["minimumCount"],
        message: "minimum output count exceeds maximum output count",
      });
  });

export const MediaReviewRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human-required") }).strict(),
  z.object({ kind: z.literal("deterministic-preauthorized"), ruleId: safeId }).strict(),
]);

/** The complete model-owned semantic surface. Provider and storage authority are excluded. */
export const MediaIntentSchema = z
  .object({
    id: safeId,
    kind: MediaIntentKindSchema,
    purpose: MediaIntentPurposeSchema,
    necessity: z.enum(["required", "helpful"]),
    obligationIds: z.array(boundedText(160)).min(1).max(128),
    rationale: boundedText(2_000),
    brief: boundedText(4_000),
    importedAssetIds: referenceIds(32),
    output: MediaOutputConstraintsSchema,
    review: MediaReviewRequestSchema,
    bindings: z.array(MediaIntentBindingSchema).min(1).max(64),
  })
  .strict();

export const CompilerMediaAssetFactSchema = z
  .object({
    id: safeId,
    mediaType: MediaTypeSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    inspection: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("raster"),
          width: z.number().int().positive().max(16_384),
          height: z.number().int().positive().max(16_384),
          frames: z.number().int().positive().max(16),
          alpha: z.boolean(),
        })
        .strict(),
      z.object({ kind: z.literal("opaque") }).strict(),
    ]),
    visibility: z.enum(["public", "private"]),
  })
  .strict();

export const CompilerAssetManifestViewSchema = z
  .object({
    digest: sha256Digest,
    assets: z.array(CompilerMediaAssetFactSchema).min(1).max(32),
  })
  .strict();

export const CompilerMediaProducerCapabilitySchema = z
  .object({
    id: safeId,
    capabilityDigest: sha256Digest,
    kinds: z.array(MediaIntentKindSchema).min(1).max(8),
    purposes: z.array(MediaIntentPurposeSchema).min(1).max(4),
    mediaTypes: z.array(MediaTypeSchema).min(1).max(16),
    inputRequirement: z
      .object({
        minimumCount: z.number().int().min(0).max(32),
        maximumCount: z.number().int().min(0).max(32),
        semantics: z.enum(["none", "directional-reference"]),
      })
      .strict(),
    maximumCount: z.number().int().min(1).max(16),
    raster: z
      .object({
        maximumWidth: z.number().int().min(1).max(16_384),
        maximumHeight: z.number().int().min(1).max(16_384),
        supportsAlpha: z.boolean(),
        supportsAnimation: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.inputRequirement.minimumCount > value.inputRequirement.maximumCount)
      context.addIssue({ code: "custom", message: "producer input cardinality is inverted" });
  });

export const CompilerMediaReviewRuleSchema = z
  .object({ id: safeId, kind: z.literal("deterministic-preauthorized") })
  .strict();

export const CompilerMediaFactsSchema = z
  .object({
    assetManifest: CompilerAssetManifestViewSchema.nullable(),
    assetEgress: z
      .object({
        mode: z.enum(["denied", "public-assets", "private-assets"]),
        policyDigest: sha256Digest,
      })
      .strict(),
    producerCapabilities: z.array(CompilerMediaProducerCapabilitySchema).max(16),
    reviewRules: z.array(CompilerMediaReviewRuleSchema).max(16),
  })
  .strict();

export const GeneratedAssetRequirementSchema = z
  .object({
    intentId: safeId,
    producerWorkItemId: safeId,
    kind: MediaIntentKindSchema,
    purpose: MediaIntentPurposeSchema,
    necessity: z.enum(["required", "helpful"]),
    obligationIds: z.array(boundedText(160)).min(1).max(128),
    brief: boundedText(4_000),
    rationale: boundedText(2_000),
    direction: z.literal("input-to"),
    criterionIds: referenceIds(64),
  })
  .strict();

export const RepositoryChangeDeliverableSchema = z
  .object({
    kind: z.literal("repository-change"),
    contract: z.literal("clockgrove.factory/artifact"),
  })
  .strict();

export const AssetProductionDeliverableSchema = z
  .object({
    kind: z.literal("asset-production"),
    contract: z.literal("clockgrove.factory/asset-set"),
    intent: MediaIntentSchema,
    producerCapabilityId: safeId,
    producerCapabilityDigest: sha256Digest,
  })
  .strict();

export const WorkItemDeliverableSchema = z.discriminatedUnion("kind", [
  RepositoryChangeDeliverableSchema,
  AssetProductionDeliverableSchema,
]);

export type MediaIntent = z.infer<typeof MediaIntentSchema>;
export type CompilerAssetManifestView = z.infer<typeof CompilerAssetManifestViewSchema>;
export type CompilerMediaFacts = z.infer<typeof CompilerMediaFactsSchema>;
export type CompilerMediaProducerCapability = z.infer<typeof CompilerMediaProducerCapabilitySchema>;
export type GeneratedAssetRequirement = z.infer<typeof GeneratedAssetRequirementSchema>;
export type WorkItemDeliverable = z.infer<typeof WorkItemDeliverableSchema>;
