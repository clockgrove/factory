import { assetDigest } from "../assets/contracts.js";
import {
  AssetSetSchema,
  MediaInvocationSchema,
  MediaReviewCapabilitySchema,
  type AssetSet,
  type MediaInvocation,
  type MediaReviewCapability,
} from "./contracts.js";

export interface DeterministicMediaReviewResult {
  kind: "approved" | "rejected" | "revision-requested";
  selectedDescriptorDigests: string[];
  reason: string | null;
}

export interface DeterministicMediaReviewer {
  readonly capability: MediaReviewCapability;
  review(invocation: MediaInvocation, assetSet: AssetSet): DeterministicMediaReviewResult;
}

export const LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY = MediaReviewCapabilitySchema.parse({
  protocol: "clockgrove.factory/media-review-capability-v1",
  id: "factory/local-private-reference-v1",
  applicableMediaTypes: ["image/png"],
  profiles: [{ kind: "raster" }],
  decisionKinds: ["deterministic-preauthorized"],
  maximumVariants: 16,
  network: { destinations: [], thirdPartyEgress: "denied" },
});

/** A deliberately narrow preauthorization rule. It approves every verified
 * private PNG produced by the local raster route for internal consumption. It
 * does not grant public visibility or a rights basis. */
export class LocalPrivateMediaReviewer implements DeterministicMediaReviewer {
  readonly capability = LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY;

  review(
    invocationInput: MediaInvocation,
    assetSetInput: AssetSet,
  ): DeterministicMediaReviewResult {
    const invocation = MediaInvocationSchema.parse(invocationInput);
    const assetSet = AssetSetSchema.parse(assetSetInput);
    if (
      assetSet.invocationDigest !== invocation.digest ||
      !["decision-input", "implementation-reference"].includes(invocation.intentPurpose) ||
      assetSet.variants.length > this.capability.maximumVariants ||
      invocation.profile?.kind !== "raster" ||
      assetSet.variants.some(
        ({ descriptor }) =>
          descriptor.visibility !== "private" ||
          descriptor.content.inspection.mediaType !== "image/png" ||
          descriptor.content.inspection.metadata.kind !== "raster",
      )
    )
      return {
        kind: "revision-requested",
        selectedDescriptorDigests: [],
        reason: "asset set is outside the deterministic private raster review rule",
      };
    return {
      kind: "approved",
      selectedDescriptorDigests: assetSet.variants
        .map(({ descriptor }) => descriptor.digest)
        .sort(),
      reason: null,
    };
  }
}

export class MediaReviewRegistry {
  readonly #reviewers = new Map<string, DeterministicMediaReviewer>();

  register(reviewer: DeterministicMediaReviewer): void {
    const capability = MediaReviewCapabilitySchema.parse(reviewer.capability);
    if (this.#reviewers.has(capability.id))
      throw new Error(`duplicate deterministic media reviewer ${capability.id}`);
    this.#reviewers.set(capability.id, reviewer);
  }

  get(id: string): DeterministicMediaReviewer | null {
    return this.#reviewers.get(id) ?? null;
  }

  compilerRules(allowedRuleIds: readonly string[]) {
    const allowed = new Set(allowedRuleIds);
    return [...this.#reviewers.values()]
      .filter(({ capability }) => allowed.has(capability.id))
      .map(({ capability }) => ({
        id: capability.id,
        kind: "deterministic-preauthorized" as const,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function defaultMediaReviewRegistry(): MediaReviewRegistry {
  const registry = new MediaReviewRegistry();
  registry.register(new LocalPrivateMediaReviewer());
  return registry;
}

export function policyMediaReviewRules(
  policy: { compilerMediaEgress: { deterministicReviewRuleIds: readonly string[] } },
  registry = defaultMediaReviewRegistry(),
) {
  return registry.compilerRules(policy.compilerMediaEgress.deterministicReviewRuleIds);
}

export function mediaReviewRuleDigest(reviewer: DeterministicMediaReviewer): string {
  return assetDigest(MediaReviewCapabilitySchema.parse(reviewer.capability));
}
