import { createHash } from "node:crypto";
import { z } from "zod";

import { ArtifactPayloadSchema } from "../execution/artifact-content.js";
import {
  MAX_PRODUCT_FILE_BYTES,
  boundedText,
  gitSha,
  safeId,
  sha256Digest,
} from "../protocol/limits.js";

export const MAX_OBJECTIVE_ASSETS = 32;
export const MAX_OBJECTIVE_ASSET_BYTES = MAX_PRODUCT_FILE_BYTES;
export const MAX_OBJECTIVE_ASSET_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_OBJECTIVE_ASSET_PIXELS = 40_000_000;
export const MAX_OBJECTIVE_ASSET_FRAMES = 16;
export const MAX_OBJECTIVE_ASSET_DECODED_BYTES = 160 * 1024 * 1024;

export function canonicalAssetJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAssetJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAssetJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export const assetDigest = (value: unknown) =>
  createHash("sha256").update(canonicalAssetJson(value)).digest("hex");

export const ObjectiveAssetAuthoritySchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    objective: z.number().int().positive(),
    baseSha: gitSha,
  })
  .strict()
  .transform((value) => ({ ...value, repository: value.repository.toLowerCase() }));

const TextMetadataSchema = z
  .object({
    kind: z.enum(["text", "markdown"]),
    encoding: z.literal("utf-8"),
    lines: z.number().int().positive().max(1_000_000),
  })
  .strict();
const JsonMetadataSchema = z
  .object({
    kind: z.literal("json"),
    encoding: z.literal("utf-8"),
    root: z.enum(["array", "object", "scalar"]),
  })
  .strict();
const RasterMetadataSchema = z
  .object({
    kind: z.literal("raster"),
    format: z.enum(["png", "jpeg", "webp", "gif", "tiff"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frames: z.number().int().positive().max(MAX_OBJECTIVE_ASSET_FRAMES),
    channels: z.number().int().positive().max(16),
    hasAlpha: z.boolean(),
    decodedBytes: z.number().int().positive().max(MAX_OBJECTIVE_ASSET_DECODED_BYTES),
  })
  .strict();
const OpaqueMetadataSchema = z
  .object({ kind: z.literal("opaque"), reason: boundedText(500) })
  .strict();
export const AssetValidationMetadataSchema = z.discriminatedUnion("kind", [
  TextMetadataSchema,
  JsonMetadataSchema,
  RasterMetadataSchema,
  OpaqueMetadataSchema,
]);
export const AssetInspectionSchema = z
  .object({
    status: z.enum(["semantic-valid", "opaque"]),
    handlerId: safeId,
    handlerContract: z.number().int().positive().max(1_000),
    mediaType: boundedText(160),
    metadata: AssetValidationMetadataSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "opaque") !== (value.metadata.kind === "opaque"))
      context.addIssue({ code: "custom", message: "opaque status and metadata must agree" });
  });
export const AssetContentSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/asset-content"),
    digest: sha256Digest,
    bytes: z.number().int().positive().max(MAX_OBJECTIVE_ASSET_BYTES),
    inspection: AssetInspectionSchema,
  })
  .strict();

const ProvenanceCommonSchema = z.object({ importId: safeId, originalName: boundedText(255) });
export const AssetProvenanceSchema = z.discriminatedUnion("kind", [
  ProvenanceCommonSchema.extend({ kind: z.literal("local-file") }).strict(),
  ProvenanceCommonSchema.extend({
    kind: z.literal("github-attachment"),
    host: z.enum(["github.com", "user-images.githubusercontent.com"]),
    attachmentId: boundedText(255).regex(/^[A-Za-z0-9_.-]+$/),
  }).strict(),
  z
    .object({
      kind: z.literal("produced"),
      invocationId: safeId,
      outputIndex: z.number().int().nonnegative().max(31),
      provider: safeId.nullable(),
      providerRequestId: boundedText(500).nullable(),
    })
    .strict(),
]);
export const AssetVisibilitySchema = z.enum(["public", "private"]);
export const AssetRightsSchema = z
  .object({
    basis: z.enum(["user-owned", "licensed", "permission-granted", "unknown"]),
    license: boundedText(500).optional(),
    attribution: boundedText(1_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.basis === "licensed" && !value.license)
      context.addIssue({ code: "custom", message: "licensed assets require a license identifier" });
  });

const DescriptorCore = z
  .object({
    protocol: z.literal("clockgrove.factory/asset-descriptor"),
    content: AssetContentSchema,
    displayName: boundedText(255),
    provenance: AssetProvenanceSchema,
    visibility: AssetVisibilitySchema,
    rights: AssetRightsSchema,
    materializationPath: z
      .string()
      .regex(/^assets\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  })
  .strict();
export const AssetDescriptorSchema = DescriptorCore.extend({ digest: sha256Digest })
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "asset descriptor digest mismatch" });
  });
const ReceiptCore = z
  .object({
    protocol: z.literal("clockgrove.factory/asset-storage-receipt"),
    authority: ObjectiveAssetAuthoritySchema,
    descriptorDigest: sha256Digest,
    transferDomain: z.enum(["objective-asset", "produced-asset"]),
    payload: ArtifactPayloadSchema,
    transferRef: boundedText(500),
    transferRequestId: safeId,
    intentCommit: gitSha,
    readyCommit: gitSha,
  })
  .strict();
export const AssetStorageReceiptSchema = ReceiptCore.extend({ digest: sha256Digest })
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "asset receipt digest mismatch" });
  });
export const AssetManifestEntrySchema = z
  .object({ descriptor: AssetDescriptorSchema, storage: AssetStorageReceiptSchema })
  .strict();
const ManifestCore = z
  .object({
    protocol: z.literal("clockgrove.factory/objective-asset-manifest"),
    authority: ObjectiveAssetAuthoritySchema,
    revision: z.number().int().positive(),
    requestId: safeId,
    assets: z.array(AssetManifestEntrySchema).min(1).max(MAX_OBJECTIVE_ASSETS),
    totalBytes: z.number().int().positive().max(MAX_OBJECTIVE_ASSET_TOTAL_BYTES),
  })
  .strict();
export const ObjectiveAssetManifestSchema = ManifestCore.extend({ digest: sha256Digest })
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "asset manifest digest mismatch" });
    if (
      value.totalBytes !==
      value.assets.reduce((sum, entry) => sum + entry.descriptor.content.bytes, 0)
    )
      context.addIssue({ code: "custom", message: "asset manifest byte total mismatch" });
    const ordered = [...value.assets].sort((a, b) =>
      a.descriptor.digest.localeCompare(b.descriptor.digest),
    );
    if (canonicalAssetJson(ordered) !== canonicalAssetJson(value.assets))
      context.addIssue({ code: "custom", message: "asset manifest is not canonically ordered" });
    for (const entry of value.assets) {
      if (canonicalAssetJson(entry.storage.authority) !== canonicalAssetJson(value.authority))
        context.addIssue({ code: "custom", message: "asset receipt authority mismatch" });
      if (entry.storage.descriptorDigest !== entry.descriptor.digest)
        context.addIssue({ code: "custom", message: "asset receipt descriptor mismatch" });
      if (
        entry.storage.payload.digest !== entry.descriptor.content.digest ||
        entry.storage.payload.bytes !== entry.descriptor.content.bytes
      )
        context.addIssue({ code: "custom", message: "asset receipt payload mismatch" });
    }
  });
export const WorkerAssetInputSchema = z
  .object({
    manifestDigest: sha256Digest,
    descriptorDigest: sha256Digest,
    contentDigest: sha256Digest,
    storageReceiptDigest: sha256Digest,
    path: z.string().regex(/^assets\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    purpose: boundedText(500).optional(),
  })
  .strict();

export type AssetContent = z.infer<typeof AssetContentSchema>;
export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>;
export type AssetManifestEntry = z.infer<typeof AssetManifestEntrySchema>;
export type AssetVisibility = z.infer<typeof AssetVisibilitySchema>;
export type AssetRights = z.infer<typeof AssetRightsSchema>;
export type AssetStorageReceipt = z.infer<typeof AssetStorageReceiptSchema>;
export type ObjectiveAssetManifest = z.infer<typeof ObjectiveAssetManifestSchema>;
export type ObjectiveAssetAuthority = z.infer<typeof ObjectiveAssetAuthoritySchema>;
export type WorkerAssetInput = z.infer<typeof WorkerAssetInputSchema>;
export const withAssetDigest = <T extends Record<string, unknown>>(core: T) => ({
  ...core,
  digest: assetDigest(core),
});
