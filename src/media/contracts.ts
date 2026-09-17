import { z } from "zod";

import {
  type AssetDescriptorSchema,
  AssetManifestEntrySchema,
  AssetRightsSchema,
  AssetVisibilitySchema,
  ObjectiveAssetAuthoritySchema,
  assetDigest,
  canonicalAssetJson,
} from "../assets/contracts.js";
import {
  MediaIntentKindSchema,
  MediaIntentPurposeSchema,
  MediaTypeSchema,
} from "../assets/media-intent.js";
import { boundedText, gitSha, safeId, sha256Digest } from "../protocol/limits.js";

const unique = <T extends z.ZodTypeAny>(item: T, maximum: number, minimum = 0) =>
  z
    .array(item)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: "values must be unique",
    });

export const RasterProductionProfileSchema = z
  .object({
    kind: z.literal("raster"),
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    alpha: z.boolean(),
    animation: z.boolean(),
  })
  .strict();

export const BinaryProductionProfileSchema = z.object({ kind: z.literal("binary") }).strict();

/** Format-specific parameters stay in a discriminated profile. Raster is the
 * first supported profile; opaque media never receives invented image fields. */
export const MediaProductionProfileSchema = z.discriminatedUnion("kind", [
  BinaryProductionProfileSchema,
  RasterProductionProfileSchema,
]);

export const RasterProducerProfileCapabilitySchema = z
  .object({
    kind: z.literal("raster"),
    maximumWidth: z.number().int().min(1).max(16_384),
    maximumHeight: z.number().int().min(1).max(16_384),
    supportsAlpha: z.boolean(),
    supportsAnimation: z.boolean(),
  })
  .strict();
export const BinaryProducerProfileCapabilitySchema = z
  .object({ kind: z.literal("binary") })
  .strict();

export const MediaProducerCapabilitySchema = z
  .object({
    protocol: z.literal("clockgrove.factory/media-producer-capability-v1"),
    id: safeId,
    adapterVersion: boundedText(80),
    inputMediaTypes: unique(MediaTypeSchema, 32),
    outputMediaTypes: unique(MediaTypeSchema, 32, 1),
    intentKinds: unique(MediaIntentKindSchema, 16, 1),
    purposes: unique(MediaIntentPurposeSchema, 4, 1),
    profiles: z
      .array(
        z.discriminatedUnion("kind", [
          BinaryProducerProfileCapabilitySchema,
          RasterProducerProfileCapabilitySchema,
        ]),
      )
      .min(1)
      .max(8),
    models: unique(boundedText(160), 32),
    qualities: unique(boundedText(80), 16),
    limits: z
      .object({
        providerRequests: z.number().int().min(1).max(64),
        variants: z.number().int().min(1).max(32),
        generatedBytes: z
          .number()
          .int()
          .min(1)
          .max(512 * 1024 * 1024),
        storageBytes: z
          .number()
          .int()
          .min(1)
          .max(512 * 1024 * 1024),
      })
      .strict(),
    network: z
      .object({
        destinations: unique(boundedText(253), 32),
        thirdPartyEgress: z.enum(["denied", "provider-only", "provider-and-input-assets"]),
      })
      .strict(),
    recovery: z
      .object({
        observation: z.boolean(),
        idempotency: z.boolean(),
        cancellation: z.boolean(),
        resultCollection: z.enum(["same-invocation", "inline-only"]),
      })
      .strict(),
    nativeUsageKeys: unique(safeId, 32),
  })
  .strict();

export const MediaReviewCapabilitySchema = z
  .object({
    protocol: z.literal("clockgrove.factory/media-review-capability-v1"),
    id: safeId,
    applicableMediaTypes: unique(MediaTypeSchema, 32, 1),
    profiles: z.array(z.object({ kind: z.literal("raster") }).strict()).max(1),
    decisionKinds: unique(z.enum(["human", "deterministic-preauthorized"]), 2, 1),
    maximumVariants: z.number().int().min(1).max(32),
    network: z
      .object({
        destinations: unique(boundedText(253), 32),
        thirdPartyEgress: z.enum(["denied", "provider-only", "provider-and-input-assets"]),
      })
      .strict(),
  })
  .strict();

export const MediaUsageSchema = z
  .object({
    unit: safeId,
    amount: z.number().nonnegative().finite().nullable(),
  })
  .strict();

const MediaInvocationCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/media-invocation-v1"),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    objective: z.number().int().positive(),
    runId: safeId,
    workItem: z.number().int().positive(),
    attempt: z.number().int().positive(),
    reservationRef: boundedText(500),
    intentId: safeId,
    intentDigest: sha256Digest,
    workerPacketDigest: sha256Digest,
    adapterId: safeId,
    adapterVersion: boundedText(80),
    capabilityDigest: sha256Digest,
    invocationId: safeId,
    model: boundedText(160).nullable(),
    quality: boundedText(80).nullable(),
    profile: MediaProductionProfileSchema.nullable(),
    inputAssets: z
      .array(
        z
          .object({
            descriptorDigest: sha256Digest,
            contentDigest: sha256Digest,
            storageReceiptDigest: sha256Digest,
            mediaType: MediaTypeSchema,
          })
          .strict(),
      )
      .max(32),
    outputMediaType: MediaTypeSchema,
    outputVisibility: AssetVisibilitySchema,
    outputRights: AssetRightsSchema,
    deadline: z.string().datetime(),
    policyDigest: sha256Digest,
    providerRequests: z.number().int().min(1).max(64),
    requestedVariants: z.number().int().min(1).max(32),
    maximumVariants: z.number().int().min(1).max(32),
    maximumGeneratedBytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024),
    maximumStorageBytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024),
    networkDestinations: unique(boundedText(253), 32),
    thirdPartyEgress: z.enum(["denied", "provider-only", "provider-and-input-assets"]),
  })
  .strict();

export const MediaInvocationSchema = MediaInvocationCoreSchema.extend({ digest: sha256Digest })
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "media invocation digest mismatch" });
    if (value.repository !== value.repository.toLowerCase())
      context.addIssue({ code: "custom", message: "media invocation repository is not canonical" });
    if (value.requestedVariants > value.maximumVariants)
      context.addIssue({ code: "custom", message: "requested variants exceed invocation limit" });
  });

export const MediaDispatchReceiptSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/media-dispatch-receipt-v1"),
    invocationDigest: sha256Digest,
    invocationId: safeId,
    providerRequestId: boundedText(500).nullable(),
    dispatchedAt: z.string().datetime(),
    digest: sha256Digest,
  })
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "media dispatch receipt digest mismatch" });
  });

const AssetSetCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/asset-set-v1"),
    authority: ObjectiveAssetAuthoritySchema,
    runId: safeId,
    workItem: z.number().int().positive(),
    attempt: z.number().int().positive(),
    intentId: safeId,
    intentDigest: sha256Digest,
    invocationDigest: sha256Digest,
    dispatchReceiptDigest: sha256Digest,
    providerResponseId: boundedText(500).nullable(),
    productionReceiptDigest: sha256Digest,
    storageManifestDigest: sha256Digest,
    variants: z.array(AssetManifestEntrySchema).min(1).max(32),
    usage: z.array(MediaUsageSchema).max(32),
    totalGeneratedBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    totalStorageBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
  })
  .strict();

export const AssetSetSchema = AssetSetCoreSchema.extend({ digest: sha256Digest })
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "asset set digest mismatch" });
    if (
      value.totalGeneratedBytes !==
        value.variants.reduce((total, variant) => total + variant.descriptor.content.bytes, 0) ||
      value.totalStorageBytes !== value.totalGeneratedBytes
    )
      context.addIssue({ code: "custom", message: "asset set byte totals differ from variants" });
    const ordered = [...value.variants].sort((left, right) =>
      left.descriptor.digest.localeCompare(right.descriptor.digest),
    );
    if (canonicalAssetJson(ordered) !== canonicalAssetJson(value.variants))
      context.addIssue({ code: "custom", message: "asset set variants are not canonical" });
    for (const entry of value.variants) {
      if (entry.storage.descriptorDigest !== entry.descriptor.digest)
        context.addIssue({ code: "custom", message: "asset set storage receipt mismatch" });
    }
  });

const AssetDecisionCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/asset-decision-v1"),
    kind: z.enum(["approved", "rejected", "revision-requested"]),
    requestId: safeId,
    requestedBy: boundedText(160),
    runId: safeId,
    intentId: safeId,
    intentDigest: sha256Digest,
    producerWorkItem: z.number().int().positive(),
    producerAttempt: z.number().int().positive(),
    producerReservationOid: gitSha,
    assetSetDigest: sha256Digest,
    invocationDigest: sha256Digest,
    storageManifestDigest: sha256Digest,
    selectedDescriptorDigests: unique(sha256Digest, 32),
    ruleId: safeId.nullable(),
    ruleDigest: sha256Digest.nullable(),
    reasonDigest: sha256Digest.nullable(),
    feedbackDigest: sha256Digest.nullable(),
  })
  .strict();

export const AssetDecisionSchema = AssetDecisionCoreSchema.extend({ digest: sha256Digest })
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "asset decision digest mismatch" });
    if (value.kind === "approved" && value.selectedDescriptorDigests.length === 0)
      context.addIssue({ code: "custom", message: "approval requires selected descriptors" });
    if (value.kind !== "approved" && value.selectedDescriptorDigests.length !== 0)
      context.addIssue({ code: "custom", message: "non-approval cannot select descriptors" });
    if ((value.kind === "revision-requested") !== (value.feedbackDigest !== null))
      context.addIssue({ code: "custom", message: "revision decision requires feedback digest" });
    if ((value.kind === "rejected") !== (value.reasonDigest !== null))
      context.addIssue({ code: "custom", message: "rejection decision requires reason digest" });
    if ((value.ruleId === null) !== (value.ruleDigest === null))
      context.addIssue({ code: "custom", message: "deterministic rule identity is incomplete" });
  });

const AssetActivationCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/asset-activation-v1"),
    runId: safeId,
    intentId: safeId,
    intentDigest: sha256Digest,
    producerWorkItem: z.number().int().positive(),
    producerAttempt: z.number().int().positive(),
    producerReservationOid: gitSha,
    assetSetDigest: sha256Digest,
    storageManifestDigest: sha256Digest,
    decisionDigest: sha256Digest,
    selected: z.array(AssetManifestEntrySchema).min(1).max(32),
  })
  .strict();

export const AssetActivationSchema = AssetActivationCoreSchema.extend({ digest: sha256Digest })
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "asset activation digest mismatch" });
    if (
      new Set(value.selected.map((entry) => entry.descriptor.digest)).size !== value.selected.length
    )
      context.addIssue({ code: "custom", message: "asset activation selection is duplicated" });
  });

const AssetActivationBundleCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/asset-activation-bundle-v1"),
    consumerWorkItemId: safeId,
    sourcePacketDigest: sha256Digest,
    activatedPacketDigest: sha256Digest,
    activations: z.array(AssetActivationSchema).min(1).max(32),
  })
  .strict();
export const AssetActivationBundleSchema = AssetActivationBundleCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "asset activation bundle digest mismatch" });
    if (
      new Set(value.activations.map((activation) => activation.intentId)).size !==
      value.activations.length
    )
      context.addIssue({ code: "custom", message: "asset activation bundle duplicates an intent" });
  });

const WorkerMediaIntentUseCommonSchema = z.object({
  intentId: safeId,
  kind: MediaIntentKindSchema,
  brief: boundedText(4_000),
  purpose: MediaIntentPurposeSchema,
  necessity: z.enum(["required", "helpful"]),
  obligationIds: z.array(boundedText(160)).min(1).max(128),
  rationale: boundedText(2_000),
  direction: z.enum(["input-to", "evidence-for"]),
  criterionIds: unique(safeId, 64),
  descriptorDigests: unique(sha256Digest, 32, 1),
});
export const WorkerMediaIntentUseSchema = z.discriminatedUnion("source", [
  WorkerMediaIntentUseCommonSchema.extend({
    source: z.literal("imported"),
    manifestDigest: sha256Digest,
  }).strict(),
  WorkerMediaIntentUseCommonSchema.extend({
    source: z.literal("activated"),
    producerWorkItemId: safeId,
    activationDigest: sha256Digest,
  }).strict(),
]);

export type MediaProductionProfile = z.infer<typeof MediaProductionProfileSchema>;
export type MediaProducerCapability = z.infer<typeof MediaProducerCapabilitySchema>;
export type MediaReviewCapability = z.infer<typeof MediaReviewCapabilitySchema>;
export type MediaInvocation = z.infer<typeof MediaInvocationSchema>;
export type MediaDispatchReceipt = z.infer<typeof MediaDispatchReceiptSchema>;
export type AssetSet = z.infer<typeof AssetSetSchema>;
export type AssetDecision = z.infer<typeof AssetDecisionSchema>;
export type AssetActivation = z.infer<typeof AssetActivationSchema>;
export type AssetActivationBundle = z.infer<typeof AssetActivationBundleSchema>;
export type WorkerMediaIntentUse = z.infer<typeof WorkerMediaIntentUseSchema>;
export type ProducedVariant = {
  descriptor: z.input<typeof AssetDescriptorSchema>;
  bytes: Buffer;
};

export const withMediaDigest = <T extends Record<string, unknown>>(core: T) => ({
  ...core,
  digest: assetDigest(core),
});
