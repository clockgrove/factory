import { createHash } from "node:crypto";

import { inspectAssetBytes } from "../assets/handlers.js";
import { AssetDescriptorSchema, assetDigest, withAssetDigest } from "../assets/contracts.js";
import type { CompilerMediaProducerCapability } from "../assets/media-intent.js";
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

export interface MediaProducerAdapter {
  readonly capability: MediaProducerCapability;
  probe(): Promise<MediaAdapterProbe>;
  dispatch(invocation: MediaInvocation): Promise<MediaAdapterHandle>;
  /** Recover the exact provider handle from the invocation identity after the
   * durable dispatch marker but before a receipt was retained. Returning null
   * means the outcome cannot be observed and must remain unknown. */
  recoverHandle?(invocation: MediaInvocation): Promise<MediaAdapterHandle | null>;
  observe(
    invocation: MediaInvocation,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterObservation>;
  collect(invocation: MediaInvocation, handle: MediaAdapterHandle): Promise<MediaAdapterCollection>;
  cancel(invocation: MediaInvocation, handle: MediaAdapterHandle): Promise<void>;
  cleanup(invocation: MediaInvocation, handle: MediaAdapterHandle): Promise<void>;
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

/** The compiler only sees adapters whose complete network request is already
 * authorized by the immutable run policy. */
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

export const SHARP_RASTER_MEDIA_CAPABILITY = MediaProducerCapabilitySchema.parse({
  protocol: "clockgrove.factory/media-producer-capability-v1",
  id: "sharp/local-raster-v1",
  adapterVersion: "1",
  inputMediaTypes: ["image/gif", "image/jpeg", "image/png", "image/tiff", "image/webp"],
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
  models: ["sharp-deterministic-fill-v1"],
  qualities: ["deterministic"],
  limits: {
    providerRequests: 1,
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
  nativeUsageKeys: ["output_count", "generated_bytes"],
});

/** A supported local production route used for deterministic plans and captured
 * qualification. It performs no network or provider call and can reconstruct
 * the exact same invocation after restart. */
export class SharpRasterMediaAdapter implements MediaProducerAdapter {
  readonly capability = SHARP_RASTER_MEDIA_CAPABILITY;

  async probe(): Promise<MediaAdapterProbe> {
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

  async dispatch(invocationInput: MediaInvocation): Promise<MediaAdapterHandle> {
    const invocation = MediaInvocationSchema.parse(invocationInput);
    if (invocation.adapterId !== this.capability.id)
      throw new Error("media invocation selects another adapter");
    if (Date.parse(invocation.deadline) <= Date.now())
      throw new Error("media invocation deadline expired before dispatch");
    return {
      invocationId: invocation.invocationId,
      providerRequestId: null,
      dispatchedAt: new Date().toISOString(),
    };
  }

  async recoverHandle(invocationInput: MediaInvocation): Promise<MediaAdapterHandle> {
    const invocation = MediaInvocationSchema.parse(invocationInput);
    if (invocation.adapterId !== this.capability.id)
      throw new Error("media invocation selects another adapter");
    // This route has no external request. Its handle is the immutable
    // invocation identity, so observation and collection remain exact after a
    // crash even if the first process did not retain a dispatch receipt.
    return {
      invocationId: invocation.invocationId,
      providerRequestId: null,
      dispatchedAt: new Date(Date.parse(invocation.deadline) - 1).toISOString(),
    };
  }

  async observe(
    invocationInput: MediaInvocation,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterObservation> {
    const invocation = MediaInvocationSchema.parse(invocationInput);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    return {
      state: "succeeded",
      observedAt: new Date().toISOString(),
      providerResponseId: `local:${invocation.digest}`,
      usage: [
        { unit: "output_count", amount: invocation.requestedVariants },
        { unit: "generated_bytes", amount: null },
      ],
    };
  }

  async collect(
    invocationInput: MediaInvocation,
    handle: MediaAdapterHandle,
  ): Promise<MediaAdapterCollection> {
    const invocation = MediaInvocationSchema.parse(invocationInput);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
    if (invocation.profile?.kind !== "raster")
      throw new Error("local raster adapter requires an exact raster profile");
    const sharp = (await import("sharp")).default;
    const seed = createHash("sha256").update(invocation.intentDigest).digest();
    const count = invocation.requestedVariants;
    const variants: ProducedVariant[] = [];
    for (let index = 0; index < count; index++) {
      const alpha = invocation.profile.alpha ? 192 : 255;
      const bytes = await sharp({
        create: {
          width: invocation.profile.width,
          height: invocation.profile.height,
          channels: invocation.profile.alpha ? 4 : 3,
          background: {
            r: seed[(index * 3) % seed.length]!,
            g: seed[(index * 3 + 1) % seed.length]!,
            b: seed[(index * 3 + 2) % seed.length]!,
            alpha: alpha / 255,
          },
        },
      })
        .png()
        .toBuffer();
      const contentDigest = createHash("sha256").update(bytes).digest("hex");
      const inspection = await inspectAssetBytes(bytes, {
        allowOpaque: false,
        displayName: `variant-${index + 1}.png`,
      });
      const descriptor = AssetDescriptorSchema.parse(
        withAssetDigest({
          protocol: "clockgrove.factory/asset-descriptor" as const,
          content: {
            protocol: "clockgrove.factory/asset-content" as const,
            digest: contentDigest,
            bytes: bytes.length,
            inspection,
          },
          displayName: `variant-${index + 1}.png`,
          provenance: {
            kind: "produced" as const,
            invocationId: invocation.invocationId,
            outputIndex: index,
            provider: null,
            providerRequestId: null,
          },
          visibility: invocation.outputVisibility,
          rights: invocation.outputRights,
          materializationPath: `assets/${contentDigest}/variant-${index + 1}.png`,
        }),
      );
      variants.push({ descriptor, bytes });
    }
    const generatedBytes = variants.reduce((total, variant) => total + variant.bytes.length, 0);
    if (generatedBytes > invocation.maximumGeneratedBytes)
      throw new Error("generated variants exceed the invocation byte limit");
    const receipt = createHash("sha256")
      .update(
        JSON.stringify({
          invocationDigest: invocation.digest,
          variants: variants.map(({ descriptor }) => descriptor.digest),
        }),
      )
      .digest("hex");
    return {
      providerResponseId: `local:${invocation.digest}`,
      productionReceiptDigest: receipt,
      variants,
      usage: [
        { unit: "output_count", amount: variants.length },
        { unit: "generated_bytes", amount: generatedBytes },
      ],
    };
  }

  async cancel(invocation: MediaInvocation, handle: MediaAdapterHandle): Promise<void> {
    MediaInvocationSchema.parse(invocation);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
  }

  async cleanup(invocation: MediaInvocation, handle: MediaAdapterHandle): Promise<void> {
    MediaInvocationSchema.parse(invocation);
    if (handle.invocationId !== invocation.invocationId)
      throw new Error("media handle belongs to another invocation");
  }
}

export function defaultMediaAdapterRegistry(): MediaAdapterRegistry {
  const registry = new MediaAdapterRegistry();
  registry.register(new SharpRasterMediaAdapter());
  return registry;
}
