import {
  AssetManifestEntrySchema,
  AssetRightsSchema,
  AssetVisibilitySchema,
  assetDigest,
  canonicalAssetJson,
} from "../assets/contracts.js";
import { MediaIntentSchema, RasterMediaConstraintsSchema } from "../assets/media-intent.js";
import { attemptRef } from "../control/attempts.js";
import {
  AssetProductionWorkerPacketSchema,
  WorkerPacketSchema,
  workerPacketDigest,
  type AssetProductionWorkerPacket,
  type RepositoryChangeWorkerPacket,
  type WorkerPacket,
} from "../protocol/worker-packet.js";
import {
  AssetActivationBundleSchema,
  AssetActivationSchema,
  AssetDecisionSchema,
  AssetSetSchema,
  MediaInvocationSchema,
  MediaProducerCapabilitySchema,
  withMediaDigest,
  type AssetActivation,
  type AssetActivationBundle,
  type AssetDecision,
  type AssetSet,
  type MediaInvocation,
  type MediaProducerCapability,
} from "./contracts.js";

function exactRasterProfile(rasterInput: unknown, capabilityInput: MediaProducerCapability) {
  const capability = MediaProducerCapabilitySchema.parse(capabilityInput);
  const supported = capability.profiles.find((profile) => profile.kind === "raster");
  if (!supported) return null;
  const raster = rasterInput ? RasterMediaConstraintsSchema.parse(rasterInput) : null;
  const width = Math.min(raster?.maximumWidth ?? 1_024, supported.maximumWidth);
  const height = Math.min(raster?.maximumHeight ?? 1_024, supported.maximumHeight);
  if ((raster?.minimumWidth ?? 1) > width || (raster?.minimumHeight ?? 1) > height)
    throw new Error("media raster dimensions exceed producer capability");
  if (raster?.alpha === "required" && !supported.supportsAlpha)
    throw new Error("media intent requires unsupported alpha output");
  if (raster?.animation === "required" && !supported.supportsAnimation)
    throw new Error("media intent requires unsupported animation");
  return {
    kind: "raster" as const,
    width,
    height,
    alpha: raster?.alpha === "required",
    animation: raster?.animation === "required",
  };
}

export function createMediaInvocation(args: {
  repository: string;
  objective: number;
  runId: string;
  workItem: number;
  attempt: number;
  packet: AssetProductionWorkerPacket;
  capability: MediaProducerCapability;
  inputEntries: unknown[];
  authorityBaseSha: string;
  deadline: string;
  policyDigest: string;
  model?: string;
  quality?: string;
  revisionContext?: {
    priorAssetSetDigest: string;
    priorDecisionDigest: string;
    feedback: string;
    feedbackDigest: string;
  } | null;
}): MediaInvocation {
  const packet = AssetProductionWorkerPacketSchema.parse(args.packet);
  const capability = MediaProducerCapabilitySchema.parse(args.capability);
  const intent = MediaIntentSchema.parse(packet.deliverable.intent);
  if (
    packet.deliverable.producerCapabilityId !== capability.id ||
    packet.deliverable.producerCapabilityDigest !== assetDigest(capability)
  )
    throw new Error("Worker Packet producer capability changed before invocation");
  if (
    !capability.intentRoles.includes(intent.role) ||
    !capability.purposes.includes(intent.purpose)
  )
    throw new Error("producer capability does not apply to the media intent");
  const outputMediaType = [...intent.output.mediaTypes]
    .sort()
    .find((mediaType) => capability.outputMediaTypes.includes(mediaType));
  if (!outputMediaType) throw new Error("producer capability has no exact output MIME match");
  const raster = intent.output.raster ? exactRasterProfile(intent.output.raster, capability) : null;
  if (intent.output.raster && !raster)
    throw new Error("raster output requires a matching typed producer profile");
  if (!intent.output.raster && !capability.profiles.some(({ kind }) => kind === "binary"))
    throw new Error("non-raster output requires the media-agnostic binary profile");
  const inputEntries = args.inputEntries.map((value) => AssetManifestEntrySchema.parse(value));
  const associations = new Map<string, { roleId: string; descriptorDigest: string }>();
  for (const use of packet.mediaUses) {
    if (!use.inputRoleId) continue;
    if (!capability.inputRoles.some(({ id }) => id === use.inputRoleId))
      throw new Error("media input names an unadvertised capability role");
    for (const descriptorDigest of use.descriptorDigests)
      associations.set(`${use.inputRoleId}:${descriptorDigest}`, {
        roleId: use.inputRoleId,
        descriptorDigest,
      });
  }
  const roleCounts = new Map<string, number>();
  for (const { roleId } of associations.values())
    roleCounts.set(roleId, (roleCounts.get(roleId) ?? 0) + 1);
  if (
    capability.inputRoles.some((role) => {
      const count = roleCounts.get(role.id) ?? 0;
      return count < role.minimumCount || count > role.maximumCount;
    })
  )
    throw new Error("media input role count is outside the producer capability");
  const byDescriptor = new Map(inputEntries.map((entry) => [entry.descriptor.digest, entry]));
  const packetInputs = new Map(packet.assetInputs.map((input) => [input.descriptorDigest, input]));
  if (packetInputs.size > 0 && associations.size === 0)
    throw new Error("media inputs lack exact semantic role bindings");
  const inputAssets = [...associations.values()].map(({ roleId, descriptorDigest }) => {
    const input = packetInputs.get(descriptorDigest);
    if (!input) throw new Error("media role binding refers to a missing immutable asset input");
    const entry = byDescriptor.get(input.descriptorDigest);
    if (
      !entry ||
      entry.descriptor.content.digest !== input.contentDigest ||
      entry.storage.digest !== input.storageReceiptDigest ||
      entry.descriptor.materializationPath !== input.path
    )
      throw new Error("media input differs from its immutable descriptor and storage receipt");
    const mediaType = entry.descriptor.content.inspection.mediaType;
    const role = capability.inputRoles.find(({ id }) => id === roleId)!;
    if (!role.mediaTypes.includes(mediaType))
      throw new Error(
        `producer capability role ${role.id} does not accept input MIME ${mediaType}`,
      );
    return {
      manifestDigest: input.manifestDigest,
      descriptorDigest: entry.descriptor.digest,
      contentDigest: entry.descriptor.content.digest,
      storageReceiptDigest: entry.storage.digest,
      mediaType,
      roleId,
      path: input.path,
    };
  });
  const model = args.model ?? capability.models[0] ?? null;
  const quality = args.quality ?? capability.qualities[0] ?? null;
  if (model && !capability.models.includes(model)) throw new Error("unsupported media model");
  if (quality && !capability.qualities.includes(quality))
    throw new Error("unsupported media quality");
  const activationSelection = packet.deliverable.activationSelection;
  if (activationSelection.maximumCount > intent.output.maximumCount)
    throw new Error("activation selection exceeds produced media maximum");
  const requestedVariants = Math.max(intent.output.minimumCount, activationSelection.minimumCount);
  if (requestedVariants > capability.limits.variants)
    throw new Error("requested variants exceed producer capability");
  const outputRights = AssetRightsSchema.parse(capability.outputAuthority.rights);
  if (intent.purpose === "product-asset" && outputRights.basis === "unknown")
    throw new Error("product media production requires authenticated lawful output rights");
  const core = {
    protocol: "clockgrove.factory/media-invocation-v1" as const,
    repository: args.repository.toLowerCase(),
    objective: args.objective,
    runId: args.runId,
    workItem: args.workItem,
    attempt: args.attempt,
    authorityBaseSha: args.authorityBaseSha,
    reservationRef: attemptRef(args.objective, args.workItem, args.attempt),
    intentId: intent.id,
    intentRole: intent.role,
    intentPurpose: intent.purpose,
    intentDigest: assetDigest(intent),
    workerPacketDigest: workerPacketDigest(packet),
    adapterId: capability.id,
    adapterVersion: capability.adapterVersion,
    capabilityDigest: assetDigest(capability),
    invocationId: `media-${args.workItem}-${args.attempt}-${assetDigest([args.runId, intent.id]).slice(0, 24)}`,
    model,
    quality,
    profile: raster ?? { kind: "binary" as const },
    inputAssets,
    outputMediaType,
    outputVisibility: AssetVisibilitySchema.parse(capability.outputAuthority.visibility),
    outputRights,
    deadline: args.deadline,
    policyDigest: args.policyDigest,
    requestedVariants,
    activationSelection,
    usageReservation: withMediaDigest({
      protocol: "clockgrove.factory/media-usage-reservation-v1" as const,
      providerRequests: capability.limits.providerRequests,
      variants: Math.min(intent.output.maximumCount, capability.limits.variants),
      generatedBytes: capability.limits.generatedBytes,
      storageBytes: capability.limits.storageBytes,
      nativeUnits: [...capability.nativeUsageKeys].sort(),
    }),
    revisionContext: args.revisionContext ?? null,
    networkDestinations: capability.network.destinations,
    thirdPartyEgress: capability.network.thirdPartyEgress,
  };
  return MediaInvocationSchema.parse(withMediaDigest(core));
}

export function createAssetDecision(args: {
  kind: "approved" | "rejected" | "revision-requested";
  requestId: string;
  requestedBy: string;
  assetSet: AssetSet;
  producerReservationOid: string;
  selectedDescriptorDigests?: string[];
  rule?: { id: string; digest: string };
  reasonDigest?: string;
  feedbackDigest?: string;
}): AssetDecision {
  const set = AssetSetSchema.parse(args.assetSet);
  const selected = [...new Set(args.selectedDescriptorDigests ?? [])].sort();
  if (
    selected.some((digest) => !set.variants.some(({ descriptor }) => descriptor.digest === digest))
  )
    throw new Error("asset decision selected a descriptor outside the asset set");
  if (
    args.kind === "approved" &&
    (selected.length < set.activationSelection.minimumCount ||
      selected.length > set.activationSelection.maximumCount)
  )
    throw new Error("asset approval selection is outside the compiled activation interval");
  return AssetDecisionSchema.parse(
    withMediaDigest({
      protocol: "clockgrove.factory/asset-decision-v1" as const,
      kind: args.kind,
      requestId: args.requestId,
      requestedBy: args.requestedBy,
      runId: set.runId,
      intentId: set.intentId,
      intentDigest: set.intentDigest,
      producerWorkItem: set.workItem,
      producerAttempt: set.attempt,
      producerReservationOid: args.producerReservationOid,
      assetSetDigest: set.digest,
      invocationDigest: set.invocationDigest,
      storageManifestDigest: set.storageManifestDigest,
      selectedDescriptorDigests: selected,
      ruleId: args.rule?.id ?? null,
      ruleDigest: args.rule?.digest ?? null,
      reasonDigest: args.reasonDigest ?? null,
      feedbackDigest: args.feedbackDigest ?? null,
    }),
  );
}

type ActivationArgs<T extends WorkerPacket> = {
  sourcePacket: T;
  consumerWorkItemId: string;
  activations: readonly AssetActivation[];
  producerIssueNumbers?: Readonly<Record<string, number>>;
};

export function activateWorkerPacket(args: ActivationArgs<RepositoryChangeWorkerPacket>): {
  packet: RepositoryChangeWorkerPacket;
  bundle: AssetActivationBundle | null;
};
export function activateWorkerPacket(args: ActivationArgs<AssetProductionWorkerPacket>): {
  packet: AssetProductionWorkerPacket;
  bundle: AssetActivationBundle | null;
};
export function activateWorkerPacket(args: ActivationArgs<WorkerPacket>): {
  packet: WorkerPacket;
  bundle: AssetActivationBundle | null;
};
export function activateWorkerPacket(args: ActivationArgs<WorkerPacket>): {
  packet: WorkerPacket;
  bundle: AssetActivationBundle | null;
} {
  const source = WorkerPacketSchema.parse(args.sourcePacket);
  if (!source.generatedAssetRequirements.length) return { packet: source, bundle: null };
  const activationByIntent = new Map(
    args.activations.map((value) => {
      const activation = AssetActivationSchema.parse(value);
      return [activation.intentId, activation] as const;
    }),
  );
  const assetInputs = new Map(source.assetInputs.map((input) => [input.descriptorDigest, input]));
  const mediaUses = [...source.mediaUses];
  const selectedActivations = new Map<string, AssetActivation>();
  for (const requirement of source.generatedAssetRequirements) {
    const activation = activationByIntent.get(requirement.intentId);
    if (!activation || activation.intentId !== requirement.intentId)
      throw new Error(`generated media intent ${requirement.intentId} has no exact activation`);
    const expectedProducer = args.producerIssueNumbers?.[requirement.producerWorkItemId];
    if (expectedProducer !== undefined && activation.producerWorkItem !== expectedProducer)
      throw new Error("generated media activation belongs to another projected producer");
    selectedActivations.set(activation.intentId, activation);
    const descriptorDigests: string[] = [];
    for (const entry of activation.selected) {
      const input = {
        manifestDigest: activation.storageManifestDigest,
        descriptorDigest: entry.descriptor.digest,
        contentDigest: entry.descriptor.content.digest,
        storageReceiptDigest: entry.storage.digest,
        path: entry.descriptor.materializationPath,
      };
      const prior = assetInputs.get(input.descriptorDigest);
      if (prior && canonicalAssetJson(prior) !== canonicalAssetJson(input))
        throw new Error("activated descriptor collides with another immutable asset input");
      assetInputs.set(input.descriptorDigest, input);
      descriptorDigests.push(input.descriptorDigest);
    }
    mediaUses.push({
      source: "activated",
      intentId: requirement.intentId,
      role: requirement.role,
      inputRoleId: requirement.inputRoleId,
      brief: requirement.brief,
      purpose: requirement.purpose,
      necessity: requirement.necessity,
      obligationIds: [...requirement.obligationIds],
      rationale: requirement.rationale,
      direction: requirement.direction,
      criterionIds: [...requirement.criterionIds],
      producerWorkItemId: requirement.producerWorkItemId,
      activationDigest: activation.digest,
      descriptorDigests,
    });
  }
  const packet = WorkerPacketSchema.parse({
    ...source,
    assetInputs: [...assetInputs.values()].sort((left, right) =>
      left.descriptorDigest.localeCompare(right.descriptorDigest),
    ),
    generatedAssetRequirements: [],
    mediaUses,
  });
  const core = {
    protocol: "clockgrove.factory/asset-activation-bundle-v1" as const,
    consumerWorkItemId: args.consumerWorkItemId,
    sourcePacketDigest: workerPacketDigest(source),
    activatedPacketDigest: workerPacketDigest(packet),
    activations: [...selectedActivations.values()].sort((left, right) =>
      left.intentId.localeCompare(right.intentId),
    ),
  };
  return {
    packet,
    bundle: AssetActivationBundleSchema.parse(withMediaDigest(core)),
  };
}
