import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { AssetDescriptorSchema, canonicalAssetJson } from "../assets/contracts.js";
import { inspectAssetBytes } from "../assets/handlers.js";
import { boundedText, sha256Digest } from "../protocol/limits.js";
import type { MediaAdapterCollection } from "./adapter.js";
import { MediaInvocationSchema, MediaUsageSchema, type MediaInvocation } from "./contracts.js";

const RetainedCollectionSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/retained-media-collection-v1"),
    invocationDigest: sha256Digest,
    providerResponseId: boundedText(500).nullable(),
    productionReceiptDigest: sha256Digest,
    variants: z
      .array(z.object({ descriptor: AssetDescriptorSchema, filename: boundedText(200) }).strict())
      .min(1)
      .max(32),
    usage: z.array(MediaUsageSchema).max(32),
    totalBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
  })
  .strict();

export type RetainedMediaCollection = z.infer<typeof RetainedCollectionSchema>;

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw new Error("media retention root is not private owned storage");
}

async function durableWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function mediaRetentionDirectory(root: string, invocationDigest: string): string {
  sha256Digest.parse(invocationDigest);
  return join(resolve(root), invocationDigest);
}

async function validateVariant(
  invocation: MediaInvocation,
  descriptorInput: unknown,
  bytes: Buffer,
): Promise<z.infer<typeof AssetDescriptorSchema>> {
  const descriptor = AssetDescriptorSchema.parse(descriptorInput);
  if (
    bytes.length !== descriptor.content.bytes ||
    sha256(bytes) !== descriptor.content.digest ||
    descriptor.visibility !== invocation.outputVisibility ||
    canonicalAssetJson(descriptor.rights) !== canonicalAssetJson(invocation.outputRights)
  )
    throw new Error("produced media bytes, visibility, or rights differ from the invocation");
  const inspection = await inspectAssetBytes(bytes, {
    allowOpaque: invocation.profile?.kind === "binary",
    displayName: descriptor.displayName,
  });
  if (
    inspection.mediaType !== invocation.outputMediaType ||
    canonicalAssetJson(inspection) !== canonicalAssetJson(descriptor.content.inspection)
  )
    throw new Error("produced media MIME or inspection differs from its descriptor");
  if (
    invocation.profile?.kind === "raster" &&
    (inspection.metadata.kind !== "raster" ||
      inspection.metadata.width !== invocation.profile.width ||
      inspection.metadata.height !== invocation.profile.height ||
      inspection.metadata.hasAlpha !== invocation.profile.alpha ||
      inspection.metadata.frames > 1 !== invocation.profile.animation)
  )
    throw new Error("produced media differs from the exact raster profile");
  return descriptor;
}

export async function retainMediaCollection(args: {
  root: string;
  invocation: MediaInvocation;
  collection: MediaAdapterCollection;
  afterVariant?: (index: number) => Promise<void>;
}): Promise<RetainedMediaCollection> {
  const invocation = MediaInvocationSchema.parse(args.invocation);
  if (
    args.collection.variants.length !== invocation.requestedVariants ||
    args.collection.variants.length > invocation.maximumVariants
  )
    throw new Error("produced media variant count differs from the invocation");
  if (new Set(args.collection.usage.map(({ unit }) => unit)).size !== args.collection.usage.length)
    throw new Error("produced media usage units are duplicated");
  const supportedUsage = new Set(args.collection.usage.map(({ unit }) => unit));
  if (supportedUsage.size !== args.collection.usage.length)
    throw new Error("produced media usage is ambiguous");
  const directory = mediaRetentionDirectory(args.root, invocation.digest);
  await ensurePrivateDirectory(args.root);
  await ensurePrivateDirectory(directory);
  const variants: RetainedMediaCollection["variants"] = [];
  let totalBytes = 0;
  for (const [index, variant] of args.collection.variants.entries()) {
    const descriptor = await validateVariant(invocation, variant.descriptor, variant.bytes);
    totalBytes += variant.bytes.length;
    if (
      totalBytes > invocation.maximumGeneratedBytes ||
      totalBytes > invocation.maximumStorageBytes
    )
      throw new Error("produced media exceeds the invocation byte limits");
    const filename = `${index}-${descriptor.content.digest}.bin`;
    const path = join(directory, filename);
    try {
      const existing = await readFile(path);
      if (!existing.equals(variant.bytes)) throw new Error("retained media variant changed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await durableWrite(path, variant.bytes);
    }
    variants.push({ descriptor, filename });
    await args.afterVariant?.(index);
  }
  const record = RetainedCollectionSchema.parse({
    protocol: "clockgrove.factory/retained-media-collection-v1",
    invocationDigest: invocation.digest,
    providerResponseId: args.collection.providerResponseId,
    productionReceiptDigest: args.collection.productionReceiptDigest,
    variants,
    usage: args.collection.usage,
    totalBytes,
  });
  const manifestPath = join(directory, "collection.json");
  const recordBytes = Buffer.from(canonicalAssetJson(record));
  try {
    const existing = await readFile(manifestPath);
    if (!existing.equals(recordBytes)) throw new Error("retained media collection changed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await durableWrite(manifestPath, recordBytes);
  }
  return record;
}

export async function recoverRetainedMediaCollection(args: {
  root: string;
  invocation: MediaInvocation;
}): Promise<MediaAdapterCollection | null> {
  const invocation = MediaInvocationSchema.parse(args.invocation);
  const directory = mediaRetentionDirectory(args.root, invocation.digest);
  let record: RetainedMediaCollection;
  try {
    record = RetainedCollectionSchema.parse(
      JSON.parse(await readFile(join(directory, "collection.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (record.invocationDigest !== invocation.digest)
    throw new Error("retained media belongs to another invocation");
  const variants = [];
  let totalBytes = 0;
  for (const entry of record.variants) {
    const path = join(directory, entry.filename);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("retained media variant is not a regular file");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    await validateVariant(invocation, entry.descriptor, bytes);
    totalBytes += bytes.length;
    variants.push({ descriptor: entry.descriptor, bytes });
  }
  if (totalBytes !== record.totalBytes) throw new Error("retained media byte total changed");
  return {
    providerResponseId: record.providerResponseId,
    productionReceiptDigest: record.productionReceiptDigest,
    variants,
    usage: record.usage,
  };
}

export async function removeRetainedMediaCollection(root: string, invocationDigest: string) {
  await rm(mediaRetentionDirectory(root, invocationDigest), { recursive: true, force: true });
}
