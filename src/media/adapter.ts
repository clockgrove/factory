import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { AssetDescriptorSchema, assetDigest, withAssetDigest } from "../assets/contracts.js";
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
  inputs: Array<{
    descriptorDigest: string;
    contentDigest: string;
    mediaType: string;
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
    path: request.inputRoot ? `${request.inputRoot}/${input.path}` : input.path,
  }));
  if (JSON.stringify(request.inputs) !== JSON.stringify(expected))
    throw new Error("media runtime request differs from its materialized inputs");
  if (expected.length > 0 !== Boolean(request.inputRoot))
    throw new Error("media runtime input root does not match its immutable bindings");
  return { invocation, packet, inputRoot: request.inputRoot, inputs: expected };
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
    hash.update(input.descriptorDigest).update(bytes);
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
    kinds: capability.intentKinds,
    purposes: capability.purposes,
    mediaTypes: capability.outputMediaTypes,
    inputRequirement: capability.inputRequirement,
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
  inputMediaTypes: DIRECTIONAL_RASTER_INPUTS,
  inputRequirement: {
    minimumCount: 1,
    maximumCount: 8,
    semantics: "directional-reference",
  },
  outputMediaTypes: ["image/png"],
  intentKinds: [
    "concept-reference",
    "layout-reference",
    "state-diagram",
    "spatial-map",
    "style-reference",
    "sprite-sheet",
    "reference-board",
    "acceptance-capture",
  ],
  purposes: ["decision-input", "implementation-reference", "product-asset", "acceptance-evidence"],
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
    request.inputs.length < capability.inputRequirement.minimumCount ||
    request.inputs.length > capability.inputRequirement.maximumCount ||
    request.inputs.some((input) => !capability.inputMediaTypes.includes(input.mediaType))
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
  abstract collect(
    request: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterCollection>;

  async probe(): Promise<MediaAdapterProbe> {
    return { available: true, authenticated: true };
  }

  async dispatch(requestInput: MediaAdapterRuntimeRequest): Promise<MediaAdapterHandle> {
    const { invocation } = assertAdapterRequest(requestInput, this.capability);
    if (Date.parse(invocation.deadline) <= Date.now())
      throw new Error("media invocation deadline expired before dispatch");
    return localHandle(invocation);
  }

  async recoverHandle(requestInput: MediaAdapterRuntimeRequest): Promise<MediaAdapterHandle> {
    const { invocation } = assertAdapterRequest(requestInput, this.capability);
    return {
      ...localHandle(invocation),
      dispatchedAt: new Date(Date.parse(invocation.deadline) - 1).toISOString(),
    };
  }

  async observe(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterObservation> {
    const { invocation } = assertAdapterRequest(requestInput, this.capability);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    return localObservation(invocation);
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
    return this.cancel(requestInput, handle);
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

  async collect(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterCollection> {
    const request = assertAdapterRequest(requestInput, this.capability);
    const { invocation } = request;
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    if (invocation.profile?.kind !== "raster" || !request.inputs[0])
      throw new Error("local raster derivative requires an exact raster profile and input");
    const sharp = (await import("sharp")).default;
    const seed = await runtimeSeed(request);
    const variants: ProducedVariant[] = [];
    for (let index = 0; index < invocation.requestedVariants; index++) {
      const bytes = await sharp(await readFile(request.inputs[index % request.inputs.length]!.path))
        .resize(invocation.profile.width, invocation.profile.height, { fit: "cover" })
        .modulate({
          brightness: 0.9 + (seed[index % seed.length]! % 21) / 100,
          hue: seed[(index + 1) % seed.length]! % 24,
        })
        .ensureAlpha(invocation.profile.alpha ? 0.85 : 1)
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

export const LOCAL_AUDIO_MEDIA_CAPABILITY = MediaProducerCapabilitySchema.parse({
  protocol: "clockgrove.factory/media-producer-capability-v1",
  id: "factory/local-audio-derivative-v1",
  adapterVersion: "1",
  inputMediaTypes: DIRECTIONAL_RASTER_INPUTS,
  inputRequirement: {
    minimumCount: 1,
    maximumCount: 8,
    semantics: "directional-reference",
  },
  outputMediaTypes: ["audio/wav"],
  intentKinds: ["sound-reference"],
  purposes: ["decision-input", "implementation-reference", "product-asset", "acceptance-evidence"],
  profiles: [{ kind: "binary" }],
  models: ["factory-deterministic-tone-v1"],
  qualities: ["deterministic"],
  limits: {
    providerRequests: 0,
    variants: 16,
    generatedBytes: 32 * 1024 * 1024,
    storageBytes: 32 * 1024 * 1024,
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

function wavTone(seed: Buffer, index: number): Buffer {
  const sampleRate = 8_000;
  const samples = 2_000;
  const dataBytes = samples * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVEfmt ", 8, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataBytes, 40);
  const frequency = 180 + (seed[index % seed.length]! % 80) * 4;
  for (let sample = 0; sample < samples; sample++) {
    const value = Math.round(Math.sin((sample * Math.PI * 2 * frequency) / sampleRate) * 8_000);
    output.writeInt16LE(value, 44 + sample * 2);
  }
  return output;
}

export class LocalAudioMediaAdapter extends LocalMediaAdapter {
  readonly capability = LOCAL_AUDIO_MEDIA_CAPABILITY;

  async collect(
    requestInput: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterCollection> {
    const request = assertAdapterRequest(requestInput, this.capability);
    const { invocation } = request;
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    const seed = await runtimeSeed(request);
    const variants: ProducedVariant[] = [];
    for (let index = 0; index < invocation.requestedVariants; index++) {
      const bytes = wavTone(seed, index);
      const inspection = await inspectAssetBytes(bytes, {
        allowOpaque: true,
        displayName: `variant-${index + 1}.wav`,
      });
      variants.push({
        bytes,
        descriptor: producedDescriptor({ invocation, index, extension: "wav", bytes, inspection }),
      });
    }
    const generatedBytes = variants.reduce((total, variant) => total + variant.bytes.length, 0);
    return {
      providerResponseId: `local:${invocation.digest}`,
      productionReceiptDigest: assetDigest({ invocation: invocation.digest, generatedBytes }),
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
  registry.register(new LocalAudioMediaAdapter());
  return registry;
}
