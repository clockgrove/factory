import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  AssetDescriptorSchema,
  assetDigest,
  canonicalAssetJson,
  withAssetDigest,
} from "../assets/contracts.js";
import { inspectAssetBytes } from "../assets/handlers.js";
import type { CompilerMediaProducerCapability } from "../assets/media-intent.js";
import {
  AssetProductionWorkerPacketSchema,
  workerPacketDigest,
  type AssetProductionWorkerPacket,
} from "../protocol/worker-packet.js";
import {
  MediaInvocationSchema,
  MediaProducerCapabilitySchema,
  type MediaInvocation,
  type MediaProducerCapability,
  type ProducedVariant,
} from "./contracts.js";

export interface MediaAdapterProbe {
  available: boolean;
  authenticated: boolean;
  reason?: string;
}

export interface MediaAdapterHandle {
  invocationId: string;
  providerRequestId: string | null;
  dispatchedAt: string;
}

export interface MediaAdapterObservation {
  state: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  observedAt: string;
  providerResponseId: string | null;
  reason?: string;
  usage: Array<{ unit: string; amount: number | null }>;
}

export interface MediaAdapterCollection {
  providerResponseId: string | null;
  productionReceiptDigest: string;
  variants: ProducedVariant[];
  usage: Array<{ unit: string; amount: number | null }>;
}

/** Ephemeral runtime view of one immutable invocation. Paths always name
 * verified read-only materializations; packet semantics remain available to
 * the adapter instead of being reduced to an opaque intent hash. */
export interface MediaAdapterRuntimeRequest {
  invocation: MediaInvocation;
  packet: AssetProductionWorkerPacket;
  inputRoot: string | null;
  /** Private durable controller-owned state; excluded from invocation identity. */
  checkpointRoot: string;
  inputs: Array<{
    descriptorDigest: string;
    contentDigest: string;
    mediaType: string;
    roleId: string;
    path: string;
  }>;
}

function exactRuntimeRequest(request: MediaAdapterRuntimeRequest): MediaAdapterRuntimeRequest {
  const invocation = MediaInvocationSchema.parse(request.invocation);
  const packet = AssetProductionWorkerPacketSchema.parse(request.packet);
  if (
    workerPacketDigest(packet) !== invocation.workerPacketDigest ||
    assetDigest(packet.deliverable.intent) !== invocation.intentDigest
  )
    throw new Error("media runtime request differs from its reserved semantic packet");
  const expected = invocation.inputAssets.map((input) => ({
    descriptorDigest: input.descriptorDigest,
    contentDigest: input.contentDigest,
    mediaType: input.mediaType,
    roleId: input.roleId,
    path: request.inputRoot ? `${request.inputRoot}/${input.path}` : input.path,
  }));
  if (canonicalAssetJson(request.inputs) !== canonicalAssetJson(expected))
    throw new Error("media runtime request differs from its materialized inputs");
  if (expected.length > 0 !== Boolean(request.inputRoot))
    throw new Error("media runtime input root does not match its immutable bindings");
  const checkpointRoot = resolve(request.checkpointRoot);
  if (!checkpointRoot.startsWith("/")) throw new Error("media checkpoint root must be absolute");
  return { invocation, packet, inputRoot: request.inputRoot, checkpointRoot, inputs: expected };
}

async function runtimeSeed(requestInput: MediaAdapterRuntimeRequest): Promise<Buffer> {
  const request = exactRuntimeRequest(requestInput);
  const hash = createHash("sha256")
    .update(request.packet.deliverable.intent.brief)
    .update(request.packet.deliverable.intent.rationale)
    .update(request.invocation.revisionContext?.feedback ?? "");
  for (const input of request.inputs) {
    const bytes = await readFile(input.path);
    if (createHash("sha256").update(bytes).digest("hex") !== input.contentDigest)
      throw new Error("materialized media input differs from its reserved content digest");
    hash.update(input.roleId).update(input.descriptorDigest).update(bytes);
  }
  return hash.digest();
}

export interface MediaProducerAdapter {
  readonly capability: MediaProducerCapability;
  probe(): Promise<MediaAdapterProbe>;
  dispatch(request: MediaAdapterRuntimeRequest): Promise<MediaAdapterHandle>;
  recoverHandle?(request: MediaAdapterRuntimeRequest): Promise<MediaAdapterHandle | null>;
  observe(
    request: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterObservation>;
  collect(
    request: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterCollection>;
  cancel(request: MediaAdapterRuntimeRequest, handle: MediaAdapterHandle): Promise<void>;
  cleanup(request: MediaAdapterRuntimeRequest, handle: MediaAdapterHandle): Promise<void>;
}

export function compilerProducerCapability(
  capabilityInput: MediaProducerCapability,
): CompilerMediaProducerCapability {
  const capability = MediaProducerCapabilitySchema.parse(capabilityInput);
  const raster = capability.profiles.find((profile) => profile.kind === "raster");
  return {
    id: capability.id,
    capabilityDigest: assetDigest(capability),
    roles: capability.intentRoles,
    purposes: capability.purposes,
    mediaTypes: capability.outputMediaTypes,
    outputVisibility: capability.outputAuthority.visibility,
    outputRightsBasis: capability.outputAuthority.rights.basis,
    inputRoles: capability.inputRoles,
    maximumCount: capability.limits.variants,
    raster: raster
      ? {
          maximumWidth: raster.maximumWidth,
          maximumHeight: raster.maximumHeight,
          supportsAlpha: raster.supportsAlpha,
          supportsAnimation: raster.supportsAnimation,
        }
      : null,
  };
}

export class MediaAdapterRegistry {
  readonly #adapters = new Map<string, MediaProducerAdapter>();

  register(adapter: MediaProducerAdapter): void {
    const capability = MediaProducerCapabilitySchema.parse(adapter.capability);
    if (this.#adapters.has(capability.id))
      throw new Error(`duplicate media adapter ${capability.id}`);
    this.#adapters.set(capability.id, adapter);
  }

  get(id: string): MediaProducerAdapter | null {
    return this.#adapters.get(id) ?? null;
  }

  list(): MediaProducerAdapter[] {
    return [...this.#adapters.values()];
  }

  compilerCapabilities(): CompilerMediaProducerCapability[] {
    return this.list()
      .map(({ capability }) => compilerProducerCapability(capability))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function policyMediaCompilerCapabilities(
  policy: { allowedNetworkDestinations: readonly string[] },
  registry: MediaAdapterRegistry = defaultMediaAdapterRegistry(),
): CompilerMediaProducerCapability[] {
  const allowed = new Set(policy.allowedNetworkDestinations);
  return registry
    .list()
    .filter(({ capability }) =>
      capability.network.destinations.every((destination) => allowed.has(destination)),
    )
    .map(({ capability }) => compilerProducerCapability(capability))
    .sort((left, right) => left.id.localeCompare(right.id));
}

const DIRECTIONAL_RASTER_INPUTS = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
] as const;

export const SHARP_RASTER_MEDIA_CAPABILITY = MediaProducerCapabilitySchema.parse({
  protocol: "clockgrove.factory/media-producer-capability-v1",
  id: "sharp/local-raster-derivative-v1",
  adapterVersion: "1",
  inputRoles: [
    {
      id: "source",
      mediaTypes: DIRECTIONAL_RASTER_INPUTS,
      minimumCount: 1,
      maximumCount: 8,
      semantics: "directional-reference",
    },
  ],
  outputMediaTypes: ["image/png"],
  outputAuthority: { visibility: "private", rights: { basis: "unknown" } },
  intentRoles: ["raster-derivative"],
  purposes: ["decision-input", "implementation-reference"],
  profiles: [
    {
      kind: "raster",
      maximumWidth: 4_096,
      maximumHeight: 4_096,
      supportsAlpha: true,
      supportsAnimation: false,
    },
  ],
  models: ["sharp-bounded-reference-transform-v1"],
  qualities: ["deterministic"],
  limits: {
    providerRequests: 0,
    variants: 16,
    generatedBytes: 100 * 1024 * 1024,
    storageBytes: 100 * 1024 * 1024,
  },
  network: { destinations: [], thirdPartyEgress: "denied" },
  recovery: {
    observation: true,
    idempotency: true,
    cancellation: true,
    resultCollection: "same-invocation",
  },
  nativeUsageKeys: ["generated_bytes", "output_count"],
});

function assertAdapterRequest(
  requestInput: MediaAdapterRuntimeRequest,
  capability: MediaProducerCapability,
) {
  const request = exactRuntimeRequest(requestInput);
  const invocation = request.invocation;
  if (
    invocation.adapterId !== capability.id ||
    capability.inputRoles.some((role) => {
      const inputs = request.inputs.filter((input) => input.roleId === role.id);
      return (
        inputs.length < role.minimumCount ||
        inputs.length > role.maximumCount ||
        inputs.some((input) => !role.mediaTypes.includes(input.mediaType))
      );
    }) ||
    request.inputs.some((input) => !capability.inputRoles.some((role) => role.id === input.roleId))
  )
    throw new Error("media runtime request is outside the selected adapter capability");
  return request;
}

function localHandle(invocation: MediaInvocation): MediaAdapterHandle {
  return {
    invocationId: invocation.invocationId,
    providerRequestId: null,
    dispatchedAt: new Date().toISOString(),
  };
}

function localObservation(invocation: MediaInvocation): MediaAdapterObservation {
  return {
    state: "succeeded",
    observedAt: new Date().toISOString(),
    providerResponseId: `local:${invocation.digest}`,
    usage: [
      { unit: "generated_bytes", amount: null },
      { unit: "output_count", amount: invocation.requestedVariants },
    ],
  };
}

type LocalCheckpoint = {
  protocol: "clockgrove.factory/local-media-checkpoint-v1";
  invocationDigest: string;
  handle: MediaAdapterHandle;
  providerResponseId: string;
  productionReceiptDigest: string;
  variants: Array<{ file: string; descriptor: ProducedVariant["descriptor"] }>;
  usage: Array<{ unit: string; amount: number | null }>;
};

type LocalPreparedCheckpoint = {
  protocol: "clockgrove.factory/local-media-prepared-v1";
  invocationDigest: string;
  handle: MediaAdapterHandle;
};

const localCheckpointRoot = (request: MediaAdapterRuntimeRequest) =>
  join(resolve(request.checkpointRoot), request.invocation.digest);

async function ensurePrivateCheckpointRoot(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw new Error("local media checkpoint root is not private owned storage");
}

async function syncPath(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLocalCheckpoint(request: MediaAdapterRuntimeRequest): Promise<{
  checkpoint: LocalCheckpoint;
  collection: MediaAdapterCollection;
} | null> {
  const { invocation } = request;
  const root = localCheckpointRoot(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, "ready.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!parsed || typeof parsed !== "object") throw new Error("local media checkpoint is invalid");
  const checkpoint = parsed as LocalCheckpoint;
  if (
    checkpoint.protocol !== "clockgrove.factory/local-media-checkpoint-v1" ||
    checkpoint.invocationDigest !== invocation.digest ||
    checkpoint.handle.invocationId !== invocation.invocationId ||
    !Array.isArray(checkpoint.variants) ||
    !Array.isArray(checkpoint.usage)
  )
    throw new Error("local media checkpoint differs from its invocation");
  const variants: ProducedVariant[] = [];
  for (const value of checkpoint.variants) {
    const descriptor = AssetDescriptorSchema.parse(value.descriptor);
    const bytes = await readFile(join(root, value.file));
    if (
      createHash("sha256").update(bytes).digest("hex") !== descriptor.content.digest ||
      bytes.length !== descriptor.content.bytes
    )
      throw new Error("local media checkpoint bytes differ from their descriptor");
    variants.push({ descriptor, bytes });
  }
  return {
    checkpoint,
    collection: {
      providerResponseId: checkpoint.providerResponseId,
      productionReceiptDigest: checkpoint.productionReceiptDigest,
      variants,
      usage: checkpoint.usage,
    },
  };
}

async function readLocalPrepared(
  request: MediaAdapterRuntimeRequest,
): Promise<LocalPreparedCheckpoint | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(localCheckpointRoot(request), "prepared.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!value || typeof value !== "object")
    throw new Error("local media prepared checkpoint is invalid");
  const prepared = value as LocalPreparedCheckpoint;
  if (
    prepared.protocol !== "clockgrove.factory/local-media-prepared-v1" ||
    prepared.invocationDigest !== request.invocation.digest ||
    prepared.handle.invocationId !== request.invocation.invocationId ||
    prepared.handle.providerRequestId !== null
  )
    throw new Error("local media prepared checkpoint differs from its invocation");
  return prepared;
}

async function persistLocalCheckpoint(
  request: MediaAdapterRuntimeRequest,
  handle: MediaAdapterHandle,
  collection: MediaAdapterCollection,
) {
  const { invocation } = request;
  const root = localCheckpointRoot(request);
  await ensurePrivateCheckpointRoot(resolve(request.checkpointRoot));
  await ensurePrivateCheckpointRoot(root);
  const variants: LocalCheckpoint["variants"] = [];
  for (const [index, variant] of collection.variants.entries()) {
    const file = `variant-${index + 1}.bin`;
    const target = join(root, file);
    try {
      const existing = await readFile(target);
      if (!existing.equals(variant.bytes))
        throw new Error("local media checkpoint variant changed during exact recovery");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = join(root, `${file}.${process.pid}.tmp`);
      await writeFile(temporary, variant.bytes, { mode: 0o600 });
      await syncPath(temporary);
      await rename(temporary, target);
    }
    variants.push({ file, descriptor: variant.descriptor });
  }
  const checkpoint: LocalCheckpoint = {
    protocol: "clockgrove.factory/local-media-checkpoint-v1",
    invocationDigest: invocation.digest,
    handle,
    providerResponseId: collection.providerResponseId ?? `local:${invocation.digest}`,
    productionReceiptDigest: collection.productionReceiptDigest,
    variants,
    usage: collection.usage,
  };
  const temporary = join(root, `ready.${process.pid}.tmp`);
  await writeFile(temporary, `${canonicalAssetJson(checkpoint)}\n`, { mode: 0o600 });
  await syncPath(temporary);
  await rename(temporary, join(root, "ready.json"));
  await syncPath(root);
  return checkpoint;
}

function producedDescriptor(args: {
  invocation: MediaInvocation;
  index: number;
  extension: string;
  bytes: Buffer;
  inspection: Awaited<ReturnType<typeof inspectAssetBytes>>;
}) {
  const contentDigest = createHash("sha256").update(args.bytes).digest("hex");
  return AssetDescriptorSchema.parse(
    withAssetDigest({
      protocol: "clockgrove.factory/asset-descriptor" as const,
      content: {
        protocol: "clockgrove.factory/asset-content" as const,
        digest: contentDigest,
        bytes: args.bytes.length,
        inspection: args.inspection,
      },
      displayName: `variant-${args.index + 1}.${args.extension}`,
      provenance: {
        kind: "produced" as const,
        invocationId: args.invocation.invocationId,
        outputIndex: args.index,
        provider: null,
        providerRequestId: null,
      },
      visibility: args.invocation.outputVisibility,
      rights: args.invocation.outputRights,
      materializationPath: `assets/${contentDigest}/variant-${args.index + 1}.${args.extension}`,
    }),
  );
}

abstract class LocalMediaAdapter implements MediaProducerAdapter {
  abstract readonly capability: MediaProducerCapability;
  protected abstract generate(request: MediaAdapterRuntimeRequest): Promise<MediaAdapterCollection>;

  async probe(): Promise<MediaAdapterProbe> {
    return { available: true, authenticated: true };
  }

  async dispatch(requestInput: MediaAdapterRuntimeRequest): Promise<MediaAdapterHandle> {
    const request = assertAdapterRequest(requestInput, this.capability);
    const { invocation } = request;
    if (Date.parse(invocation.deadline) <= Date.now())
      throw new Error("media invocation deadline expired before dispatch");
    const existing = await readLocalCheckpoint(request);
    if (existing) return existing.checkpoint.handle;
    if (await readLocalPrepared(request))
      throw new Error("local media invocation is already prepared; recover the same handle");
    const root = localCheckpointRoot(request);
    await ensurePrivateCheckpointRoot(resolve(request.checkpointRoot));
    await ensurePrivateCheckpointRoot(root);
    const handle = localHandle(invocation);
    const prepared: LocalPreparedCheckpoint = {
      protocol: "clockgrove.factory/local-media-prepared-v1",
      invocationDigest: invocation.digest,
      handle,
    };
    const preparedPath = join(root, "prepared.json");
    await writeFile(preparedPath, `${canonicalAssetJson(prepared)}\n`, { mode: 0o600 });
    await syncPath(preparedPath);
    await syncPath(root);
    const collection = await this.generate(request);
    await persistLocalCheckpoint(request, handle, collection);
    return handle;
  }

  async recoverHandle(
    requestInput: MediaAdapterRuntimeRequest,
  ): Promise<MediaAdapterHandle | null> {
    const request = assertAdapterRequest(requestInput, this.capability);
    const ready = await readLocalCheckpoint(request);
    if (ready) return ready.checkpoint.handle;
    const prepared = await readLocalPrepared(request);
    if (!prepared) return null;
    const collection = await this.generate(request);
    await persistLocalCheckpoint(request, prepared.handle, collection);
    return prepared.handle;
  }

  async observe(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterObservation> {
    const { invocation } = assertAdapterRequest(requestInput, this.capability);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    const retained = await readLocalCheckpoint(requestInput);
    if (!retained) return { ...localObservation(invocation), state: "unknown", usage: [] };
    return {
      ...localObservation(invocation),
      providerResponseId: retained.collection.providerResponseId,
      usage: retained.collection.usage,
    };
  }

  async cancel(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<void> {
    const { invocation } = assertAdapterRequest(requestInput, this.capability);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
  }

  async cleanup(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<void> {
    await this.cancel(requestInput, handle);
    await rm(localCheckpointRoot(requestInput), { recursive: true, force: true });
  }

  async collect(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterCollection> {
    const { invocation } = assertAdapterRequest(requestInput, this.capability);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    const retained = await readLocalCheckpoint(requestInput);
    if (!retained || retained.checkpoint.handle.invocationId !== handle.invocationId)
      throw new Error("local media checkpoint is unavailable for exact collection");
    return retained.collection;
  }
}

/** Deterministic derivative fixture. It requires real directional raster bytes,
 * decodes them with Sharp, and emits bounded resized/color-shifted renditions.
 * It makes no claim to invent semantically correct art from a text brief. */
export class SharpRasterMediaAdapter extends LocalMediaAdapter {
  readonly capability = SHARP_RASTER_MEDIA_CAPABILITY;

  override async probe(): Promise<MediaAdapterProbe> {
    try {
      await import("sharp");
      return { available: true, authenticated: true };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  protected async generate(
    requestInput: MediaAdapterRuntimeRequest,
  ): Promise<MediaAdapterCollection> {
    const request = assertAdapterRequest(requestInput, this.capability);
    const { invocation } = request;
    if (invocation.profile?.kind !== "raster" || !request.inputs[0])
      throw new Error("local raster derivative requires an exact raster profile and input");
    const sharp = (await import("sharp")).default;
    const seed = await runtimeSeed(request);
    const variants: ProducedVariant[] = [];
    for (let index = 0; index < invocation.requestedVariants; index++) {
      const pipeline = sharp(await readFile(request.inputs[index % request.inputs.length]!.path))
        .resize(invocation.profile.width, invocation.profile.height, { fit: "cover" })
        .modulate({
          brightness: 0.9 + (seed[index % seed.length]! % 21) / 100,
          hue: seed[(index + 1) % seed.length]! % 24,
        });
      const bytes = await (invocation.profile.alpha
        ? pipeline.ensureAlpha(0.85)
        : pipeline.removeAlpha()
      )
        .png()
        .toBuffer();
      const inspection = await inspectAssetBytes(bytes, {
        allowOpaque: false,
        displayName: `variant-${index + 1}.png`,
      });
      variants.push({
        bytes,
        descriptor: producedDescriptor({ invocation, index, extension: "png", bytes, inspection }),
      });
    }
    const generatedBytes = variants.reduce((total, variant) => total + variant.bytes.length, 0);
    if (generatedBytes > invocation.usageReservation.generatedBytes)
      throw new Error("generated variants exceed the invocation byte limit");
    return {
      providerResponseId: `local:${invocation.digest}`,
      productionReceiptDigest: assetDigest({
        invocationDigest: invocation.digest,
        variants: variants.map(({ descriptor }) => descriptor.digest),
      }),
      variants,
      usage: [
        { unit: "generated_bytes", amount: generatedBytes },
        { unit: "output_count", amount: variants.length },
      ],
    };
  }
}

export function defaultMediaAdapterRegistry(): MediaAdapterRegistry {
  const registry = new MediaAdapterRegistry();
  registry.register(new SharpRasterMediaAdapter());
  return registry;
}
