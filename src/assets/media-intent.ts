import { z } from "zod";

import { MAX_PRODUCT_FILE_BYTES, boundedText, safeId, sha256Digest } from "../protocol/limits.js";

const referenceIds = (maximum: number, minimum = 0) =>
  z
    .array(safeId)
    .min(minimum)
    .max(maximum)
    .refine((ids) => new Set(ids).size === ids.length, "reference IDs must be unique");

/** Capability-advertised semantic role. The core does not own a closed media taxonomy. */
export const MediaIntentRoleSchema = safeId;

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
    kind: z.literal("raster"),
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
    profile: RasterMediaConstraintsSchema.nullable(),
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

export const MediaInputRoleBindingSchema = z
  .object({
    roleId: safeId,
    importedAssetIds: referenceIds(32),
    inputIntentIds: referenceIds(32),
  })
  .strict();

const RepositoryCaptureScenarioSchema = z
  .object({
    id: safeId,
    fixture: boundedText(500).nullable(),
    seed: boundedText(500).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.fixture !== null && value.seed !== null)
      context.addIssue({
        code: "custom",
        message: "capture scenario may bind a fixture or seed, not both",
      });
  });

const RepositoryCaptureComparisonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact") }).strict(),
  z
    .object({
      kind: z.literal("threshold"),
      recipeId: safeId,
    })
    .strict(),
]);

export const RepositoryCaptureRequestSchema = z
  .object({
    expectedAssetId: safeId,
    scenario: RepositoryCaptureScenarioSchema,
    captureRecipeId: safeId,
    comparison: RepositoryCaptureComparisonSchema,
  })
  .strict();

export const MediaIntentFulfillmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("imported"),
      assetIds: referenceIds(32, 1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("produced"),
      inputRoleBindings: z.array(MediaInputRoleBindingSchema).max(8),
    })
    .strict(),
]);

/** The complete model-owned semantic surface. Provider and storage authority are excluded. */
export const MediaIntentSchema = z
  .object({
    id: safeId,
    role: MediaIntentRoleSchema,
    purpose: MediaIntentPurposeSchema,
    necessity: z.enum(["required", "helpful"]),
    obligationIds: z.array(boundedText(160)).min(1).max(128),
    rationale: boundedText(2_000),
    brief: boundedText(4_000),
    fulfillment: MediaIntentFulfillmentSchema,
    output: MediaOutputConstraintsSchema,
    review: MediaReviewRequestSchema,
    repositoryCapture: RepositoryCaptureRequestSchema.nullable(),
    bindings: z.array(MediaIntentBindingSchema).max(64),
  })
  .strict()
  .superRefine((intent, context) => {
    const evidenceBindings = intent.bindings.filter(
      ({ direction }) => direction === "evidence-for",
    );
    if ((intent.repositoryCapture !== null) !== evidenceBindings.length > 0)
      context.addIssue({
        code: "custom",
        path: ["repositoryCapture"],
        message: "repository capture request is required exactly for evidence-for intents",
      });
    if (intent.repositoryCapture && evidenceBindings.length !== intent.bindings.length)
      context.addIssue({
        code: "custom",
        path: ["bindings"],
        message: "repository capture intents may contain only evidence-for bindings",
      });
    if (
      intent.repositoryCapture &&
      (intent.purpose !== "acceptance-evidence" ||
        intent.fulfillment.kind !== "imported" ||
        intent.fulfillment.assetIds.length !== 1 ||
        intent.fulfillment.assetIds[0] !== intent.repositoryCapture.expectedAssetId)
    )
      context.addIssue({
        code: "custom",
        path: ["fulfillment"],
        message: "repository capture must use its one expected imported acceptance asset",
      });
    if (
      intent.fulfillment.kind === "produced" &&
      new Set(intent.fulfillment.inputRoleBindings.map(({ roleId }) => roleId)).size !==
        intent.fulfillment.inputRoleBindings.length
    )
      context.addIssue({ code: "custom", message: "media input role is duplicated" });
  });

export const CompilerMediaAssetFactSchema = z
  .object({
    id: safeId,
    mediaType: MediaTypeSchema,
    bytes: z.number().int().positive().max(MAX_PRODUCT_FILE_BYTES),
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
    roles: z.array(MediaIntentRoleSchema).min(1).max(8),
    purposes: z.array(MediaIntentPurposeSchema).min(1).max(4),
    mediaTypes: z.array(MediaTypeSchema).min(1).max(16),
    outputVisibility: z.enum(["public", "private"]),
    outputRightsBasis: z.enum(["user-owned", "licensed", "permission-granted", "unknown"]),
    inputRoles: z
      .array(
        z
          .object({
            id: safeId,
            mediaTypes: z.array(MediaTypeSchema).min(1).max(16),
            minimumCount: z.number().int().min(0).max(32),
            maximumCount: z.number().int().min(0).max(32),
            semantics: safeId,
          })
          .strict(),
      )
      .max(8),
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
    if (new Set(value.inputRoles.map(({ id }) => id)).size !== value.inputRoles.length)
      context.addIssue({ code: "custom", message: "producer input roles are duplicated" });
    if (value.inputRoles.some((role) => role.minimumCount > role.maximumCount))
      context.addIssue({ code: "custom", message: "producer input role cardinality is inverted" });
  });

export const CompilerMediaReviewRuleSchema = z
  .object({
    id: safeId,
    kind: z.literal("deterministic-preauthorized"),
    producerCapabilityIds: z.array(safeId).min(1).max(16),
    roles: z.array(MediaIntentRoleSchema).min(1).max(16),
    purposes: z.array(MediaIntentPurposeSchema).min(1).max(4),
    mediaTypes: z.array(MediaTypeSchema).min(1).max(32),
    profiles: z
      .array(z.enum(["binary", "raster"]))
      .min(1)
      .max(2),
    outputVisibilities: z
      .array(z.enum(["public", "private"]))
      .min(1)
      .max(2),
    rightsBases: z
      .array(z.enum(["user-owned", "licensed", "permission-granted", "unknown"]))
      .min(1)
      .max(4),
    selectionStrategy: z.literal("activation-minimum-canonical"),
  })
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
    role: MediaIntentRoleSchema,
    purpose: MediaIntentPurposeSchema,
    necessity: z.enum(["required", "helpful"]),
    obligationIds: z.array(boundedText(160)).min(1).max(128),
    brief: boundedText(4_000),
    rationale: boundedText(2_000),
    direction: z.literal("input-to"),
    criterionIds: referenceIds(64),
    inputRoleId: safeId.nullable(),
  })
  .strict();

export const RepositoryChangeDeliverableSchema = z
  .object({
    kind: z.literal("repository-change"),
    contract: z.literal("clockgrove.factory/artifact"),
  })
  .strict();

export const MediaActivationSelectionSchema = z
  .object({
    minimumCount: z.number().int().min(1).max(16),
    maximumCount: z.number().int().min(1).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimumCount > value.maximumCount)
      context.addIssue({ code: "custom", message: "media activation selection is inverted" });
  });

export const AssetProductionDeliverableSchema = z
  .object({
    kind: z.literal("asset-production"),
    contract: z.literal("clockgrove.factory/asset-set"),
    intent: MediaIntentSchema,
    producerCapabilityId: safeId,
    producerCapabilityDigest: sha256Digest,
    activationSelection: MediaActivationSelectionSchema,
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
