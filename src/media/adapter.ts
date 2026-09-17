import { createHash, randomUUID } from "node:crypto";
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
import { MAX_PRODUCT_FILE_BYTES } from "../protocol/limits.js";
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
  output?: {
    variants: number | null;
    generatedBytes: number | null;
    storageBytes: number | null;
  };
}

export interface MediaAdapterExecutionControl {
  signal?: AbortSignal;
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
  dispatch(
    request: MediaAdapterRuntimeRequest,
    control?: MediaAdapterExecutionControl,
  ): Promise<MediaAdapterHandle>;
  recoverHandle?(
    request: MediaAdapterRuntimeRequest,
    control?: MediaAdapterExecutionControl,
  ): Promise<MediaAdapterHandle | null>;
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
    generatedBytes: MAX_PRODUCT_FILE_BYTES,
    storageBytes: MAX_PRODUCT_FILE_BYTES,
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

type LocalVariantCheckpoint = {
  protocol: "clockgrove.factory/local-media-variant-v1";
  invocationDigest: string;
  index: number;
  file: string;
  descriptor: ProducedVariant["descriptor"];
};

type LocalCancelledCheckpoint = {
  protocol: "clockgrove.factory/local-media-cancelled-v1";
  invocationDigest: string;
  handle: MediaAdapterHandle;
  reason: string;
  variants: number;
  generatedBytes: number;
  usage: Array<{ unit: string; amount: number | null }>;
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

async function atomicWrite(root: string, name: string, bytes: Buffer | string) {
  const temporary = join(root, `${name}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600 });
  await syncPath(temporary);
  await rename(temporary, join(root, name));
  await syncPath(root);
}

async function atomicWriteJson(root: string, name: string, value: unknown) {
  await atomicWrite(root, name, `${canonicalAssetJson(value)}\n`);
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
): Promise<{ checkpoint: LocalPreparedCheckpoint | null; torn: boolean }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(localCheckpointRoot(request), "prepared.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { checkpoint: null, torn: false };
    if (error instanceof SyntaxError) return { checkpoint: null, torn: true };
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
  return { checkpoint: prepared, torn: false };
}

async function persistLocalPrepared(
  request: MediaAdapterRuntimeRequest,
  handle: MediaAdapterHandle,
) {
  const { invocation } = request;
  const root = localCheckpointRoot(request);
  await ensurePrivateCheckpointRoot(resolve(request.checkpointRoot));
  await ensurePrivateCheckpointRoot(root);
  const prepared: LocalPreparedCheckpoint = {
    protocol: "clockgrove.factory/local-media-prepared-v1",
    invocationDigest: invocation.digest,
    handle,
  };
  await atomicWriteJson(root, "prepared.json", prepared);
}

async function readLocalVariant(
  request: MediaAdapterRuntimeRequest,
  index: number,
): Promise<ProducedVariant | null> {
  const root = localCheckpointRoot(request);
  const checkpointName = `variant-${index + 1}.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, checkpointName), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
      return null;
    throw error;
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("local media variant checkpoint is invalid");
  const checkpoint = parsed as LocalVariantCheckpoint;
  if (
    checkpoint.protocol !== "clockgrove.factory/local-media-variant-v1" ||
    checkpoint.invocationDigest !== request.invocation.digest ||
    checkpoint.index !== index ||
    checkpoint.file !== `variant-${index + 1}.bin`
  )
    throw new Error("local media variant checkpoint differs from its invocation");
  const descriptor = AssetDescriptorSchema.parse(checkpoint.descriptor);
  if (
    descriptor.provenance.kind !== "produced" ||
    descriptor.provenance.invocationId !== request.invocation.invocationId ||
    descriptor.provenance.outputIndex !== index
  )
    throw new Error("local media variant descriptor differs from its work unit");
  const bytes = await readFile(join(root, checkpoint.file));
  if (
    createHash("sha256").update(bytes).digest("hex") !== descriptor.content.digest ||
    bytes.length !== descriptor.content.bytes
  )
    throw new Error("local media variant bytes differ from their descriptor");
  return { descriptor, bytes };
}

async function persistLocalVariant(
  request: MediaAdapterRuntimeRequest,
  index: number,
  variant: ProducedVariant,
) {
  const root = localCheckpointRoot(request);
  const file = `variant-${index + 1}.bin`;
  const target = join(root, file);
  try {
    const existing = await readFile(target);
    if (!existing.equals(variant.bytes))
      throw new Error("local media checkpoint variant changed during exact recovery");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(root, file, variant.bytes);
  }
  const checkpoint: LocalVariantCheckpoint = {
    protocol: "clockgrove.factory/local-media-variant-v1",
    invocationDigest: request.invocation.digest,
    index,
    file,
    descriptor: variant.descriptor,
  };
  await atomicWriteJson(root, `variant-${index + 1}.json`, checkpoint);
}

async function durableLocalVariants(request: MediaAdapterRuntimeRequest) {
  const variants: ProducedVariant[] = [];
  for (let index = 0; index < request.invocation.requestedVariants; index++) {
    const variant = await readLocalVariant(request, index);
    if (!variant) break;
    variants.push(variant);
  }
  return variants;
}

function localCollection(request: MediaAdapterRuntimeRequest, variants: ProducedVariant[]) {
  const generatedBytes = variants.reduce((total, variant) => total + variant.bytes.length, 0);
  return {
    providerResponseId: `local:${request.invocation.digest}`,
    productionReceiptDigest: assetDigest({
      invocationDigest: request.invocation.digest,
      variants: variants.map(({ descriptor }) => descriptor.digest),
    }),
    variants,
    usage: [
      { unit: "generated_bytes", amount: generatedBytes },
      { unit: "output_count", amount: variants.length },
    ],
  } satisfies MediaAdapterCollection;
}

async function readLocalCancelled(
  request: MediaAdapterRuntimeRequest,
): Promise<LocalCancelledCheckpoint | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(localCheckpointRoot(request), "cancelled.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("local media cancellation checkpoint is invalid");
  const checkpoint = parsed as LocalCancelledCheckpoint;
  if (
    checkpoint.protocol !== "clockgrove.factory/local-media-cancelled-v1" ||
    checkpoint.invocationDigest !== request.invocation.digest ||
    checkpoint.handle.invocationId !== request.invocation.invocationId ||
    checkpoint.handle.providerRequestId !== null ||
    !Number.isInteger(checkpoint.variants) ||
    !Number.isInteger(checkpoint.generatedBytes) ||
    !Array.isArray(checkpoint.usage)
  )
    throw new Error("local media cancellation checkpoint differs from its invocation");
  return checkpoint;
}

async function persistLocalCancelled(
  request: MediaAdapterRuntimeRequest,
  handle: MediaAdapterHandle,
  reason: string,
) {
  await ensurePrivateCheckpointRoot(resolve(request.checkpointRoot));
  await ensurePrivateCheckpointRoot(localCheckpointRoot(request));
  const existing = await readLocalCancelled(request);
  if (existing) return existing;
  if (await readLocalCheckpoint(request)) return null;
  const variants = await durableLocalVariants(request);
  const generatedBytes = variants.reduce((total, variant) => total + variant.bytes.length, 0);
  const checkpoint: LocalCancelledCheckpoint = {
    protocol: "clockgrove.factory/local-media-cancelled-v1",
    invocationDigest: request.invocation.digest,
    handle,
    reason,
    variants: variants.length,
    generatedBytes,
    usage: [
      { unit: "generated_bytes", amount: generatedBytes },
      { unit: "output_count", amount: variants.length },
    ],
  };
  await atomicWriteJson(localCheckpointRoot(request), "cancelled.json", checkpoint);
  return checkpoint;
}

async function persistLocalCheckpoint(
  request: MediaAdapterRuntimeRequest,
  handle: MediaAdapterHandle,
  collection: MediaAdapterCollection,
) {
  const { invocation } = request;
  const root = localCheckpointRoot(request);
  const variants = collection.variants.map((variant, index) => ({
    file: `variant-${index + 1}.bin`,
    descriptor: variant.descriptor,
  }));
  const checkpoint: LocalCheckpoint = {
    protocol: "clockgrove.factory/local-media-checkpoint-v1",
    invocationDigest: invocation.digest,
    handle,
    providerResponseId: collection.providerResponseId ?? `local:${invocation.digest}`,
    productionReceiptDigest: collection.productionReceiptDigest,
    variants,
    usage: collection.usage,
  };
  await atomicWriteJson(root, "ready.json", checkpoint);
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
  protected abstract generateVariant(
    request: MediaAdapterRuntimeRequest,
    index: number,
  ): Promise<ProducedVariant>;

  async probe(): Promise<MediaAdapterProbe> {
    return { available: true, authenticated: true };
  }

  async dispatch(
    requestInput: MediaAdapterRuntimeRequest,
    control: MediaAdapterExecutionControl = {},
  ): Promise<MediaAdapterHandle> {
    const request = assertAdapterRequest(requestInput, this.capability);
    const { invocation } = request;
    const existing = await readLocalCheckpoint(request);
    if (existing) return existing.checkpoint.handle;
    const cancelled = await readLocalCancelled(request);
    if (cancelled) return cancelled.handle;
    const prepared = await readLocalPrepared(request);
    if (prepared.checkpoint)
      throw new Error("local media invocation is already prepared; recover the same handle");
    const root = localCheckpointRoot(request);
    await ensurePrivateCheckpointRoot(resolve(request.checkpointRoot));
    await ensurePrivateCheckpointRoot(root);
    const handle = localHandle(invocation);
    await persistLocalPrepared(request, handle);
    await this.completePrepared(request, handle, control);
    return handle;
  }

  async recoverHandle(
    requestInput: MediaAdapterRuntimeRequest,
    control: MediaAdapterExecutionControl = {},
  ): Promise<MediaAdapterHandle | null> {
    const request = assertAdapterRequest(requestInput, this.capability);
    const ready = await readLocalCheckpoint(request);
    if (ready) return ready.checkpoint.handle;
    const cancelled = await readLocalCancelled(request);
    if (cancelled) return cancelled.handle;
    const prepared = await readLocalPrepared(request);
    if (!prepared.checkpoint && !prepared.torn) return null;
    const handle = prepared.checkpoint?.handle ?? localHandle(request.invocation);
    if (prepared.torn) await persistLocalPrepared(request, handle);
    await this.completePrepared(request, handle, control);
    return handle;
  }

  private async completePrepared(
    request: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
    control: MediaAdapterExecutionControl,
  ) {
    const { invocation } = request;
    const variants: ProducedVariant[] = [];
    for (let index = 0; index < invocation.requestedVariants; index++) {
      const retained = await readLocalVariant(request, index);
      if (retained) {
        variants.push(retained);
        continue;
      }
      const existingCancellation = await readLocalCancelled(request);
      const stopReason = existingCancellation
        ? existingCancellation.reason
        : control.signal?.aborted
          ? "media invocation aborted between local work units"
          : Date.parse(invocation.deadline) <= Date.now()
            ? "media invocation deadline expired between local work units"
            : null;
      if (stopReason) {
        if (!existingCancellation) await persistLocalCancelled(request, handle, stopReason);
        return;
      }
      const variant = await this.generateVariant(request, index);
      if (control.signal?.aborted || Date.parse(invocation.deadline) <= Date.now()) {
        await persistLocalCancelled(
          request,
          handle,
          control.signal?.aborted
            ? "media invocation aborted during a local work unit"
            : "media invocation deadline expired during a local work unit",
        );
        return;
      }
      const generatedBytes =
        variants.reduce((total, value) => total + value.bytes.length, 0) + variant.bytes.length;
      if (generatedBytes > invocation.usageReservation.generatedBytes)
        throw new Error("generated variants exceed the invocation byte limit");
      await persistLocalVariant(request, index, variant);
      variants.push(variant);
    }
    if (await readLocalCancelled(request)) return;
    await persistLocalCheckpoint(request, handle, localCollection(request, variants));
  }

  async observe(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterObservation> {
    const { invocation } = assertAdapterRequest(requestInput, this.capability);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    const retained = await readLocalCheckpoint(requestInput);
    if (!retained) {
      const cancelled = await readLocalCancelled(requestInput);
      if (cancelled)
        return {
          state: "cancelled",
          observedAt: new Date().toISOString(),
          providerResponseId: null,
          reason: cancelled.reason,
          usage: cancelled.usage,
          output: {
            variants: cancelled.variants,
            generatedBytes: cancelled.generatedBytes,
            storageBytes: 0,
          },
        };
      const prepared = await readLocalPrepared(requestInput);
      return {
        state: prepared.checkpoint || prepared.torn ? "running" : "unknown",
        observedAt: new Date().toISOString(),
        providerResponseId: null,
        usage: invocation.usageReservation.nativeUnits.map((unit) => ({ unit, amount: null })),
        output: { variants: null, generatedBytes: null, storageBytes: null },
      };
    }
    return {
      state: "succeeded",
      observedAt: new Date().toISOString(),
      providerResponseId: retained.collection.providerResponseId,
      usage: retained.collection.usage,
      output: {
        variants: retained.collection.variants.length,
        generatedBytes: retained.collection.variants.reduce(
          (total, variant) => total + variant.bytes.length,
          0,
        ),
        storageBytes: null,
      },
    };
  }

  async cancel(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<void> {
    const { invocation } = assertAdapterRequest(requestInput, this.capability);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    await persistLocalCancelled(requestInput, handle, "local media invocation cancelled");
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

  protected async generateVariant(
    requestInput: MediaAdapterRuntimeRequest,
    index: number,
  ): Promise<ProducedVariant> {
    const request = assertAdapterRequest(requestInput, this.capability);
    const { invocation } = request;
    if (invocation.profile?.kind !== "raster" || !request.inputs[0])
      throw new Error("local raster derivative requires an exact raster profile and input");
    const sharp = (await import("sharp")).default;
    const seed = await runtimeSeed(request);
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
    return {
      bytes,
      descriptor: producedDescriptor({ invocation, index, extension: "png", bytes, inspection }),
    };
  }
}

export function defaultMediaAdapterRegistry(): MediaAdapterRegistry {
  const registry = new MediaAdapterRegistry();
  registry.register(new SharpRasterMediaAdapter());
  return registry;
}
