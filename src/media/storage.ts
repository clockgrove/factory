import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ObjectiveAssetAuthoritySchema,
  assetDigest,
  canonicalAssetJson,
} from "../assets/contracts.js";
import { persistProducedAssetManifest } from "../assets/storage.js";
import type { ContentTransferStore } from "../control/content-transfers.js";
import { boundedText, safeId, sha256Digest } from "../protocol/limits.js";
import {
  AssetActivationSchema,
  AssetDecisionSchema,
  AssetSetSchema,
  MediaDispatchReceiptSchema,
  MediaInvocationSchema,
  withMediaDigest,
  type AssetActivation,
  type AssetDecision,
  type AssetSet,
  type MediaDispatchReceipt,
  type MediaInvocation,
} from "./contracts.js";
import type { MediaAdapterCollection } from "./adapter.js";

export type MediaStore = ContentTransferStore;

const gitOid = (value: Buffer) =>
  createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const scopeKey = (authority: unknown, runId: string) => assetDigest({ authority, runId });
const recordRef = (
  authority: unknown,
  runId: string,
  collection: "dispatches" | "asset-sets" | "decision-requests" | "decisions" | "activations",
  digest: string,
) => `refs/clockgrove-factory/media/${scopeKey(authority, runId)}/${collection}/${digest}`;
export const mediaAssetSetDecisionRef = (
  authority: unknown,
  runId: string,
  assetSetDigest: string,
) =>
  `refs/clockgrove-factory/media/${scopeKey(authority, runId)}/asset-set-decisions/${assetSetDigest}`;
export const mediaDecisionRequestRef = (repository: string, objective: number, requestId: string) =>
  `refs/clockgrove-factory/media/${assetDigest({
    repository: repository.toLowerCase(),
    objective,
  })}/decision-requests/${assetDigest(requestId)}`;
export const mediaInvocationDispatchRef = (
  authority: unknown,
  runId: string,
  invocationDigest: string,
) =>
  `refs/clockgrove-factory/media/${scopeKey(authority, runId)}/invocation-dispatches/${invocationDigest}`;

const MediaRevisionRetrySchema = z
  .object({
    requestId: safeId,
    workItem: z.number().int().positive(),
    priorAssetSetDigest: sha256Digest,
    priorDecisionDigest: sha256Digest,
    feedback: boundedText(8_000),
    feedbackDigest: sha256Digest,
  })
  .strict();

const MediaDecisionRequestCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/media-decision-request"),
    authority: ObjectiveAssetAuthoritySchema,
    decision: AssetDecisionSchema,
    reason: boundedText(8_000).nullable(),
    retry: MediaRevisionRetrySchema.nullable(),
  })
  .strict();

export const MediaDecisionRequestSchema = MediaDecisionRequestCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== assetDigest(core))
      context.addIssue({ code: "custom", message: "media decision request digest mismatch" });
    const reasonDigest = value.reason
      ? createHash("sha256").update(value.reason).digest("hex")
      : null;
    if (
      (value.decision.kind === "approved" && (value.reason !== null || value.retry !== null)) ||
      (value.decision.kind === "rejected" &&
        (reasonDigest !== value.decision.reasonDigest || value.retry !== null)) ||
      (value.decision.kind === "revision-requested" &&
        (reasonDigest !== value.decision.feedbackDigest || value.retry === null))
    )
      context.addIssue({
        code: "custom",
        message: "media decision request differs from its decision semantics",
      });
    if (
      value.retry &&
      (value.retry.workItem !== value.decision.producerWorkItem ||
        value.retry.priorAssetSetDigest !== value.decision.assetSetDigest ||
        value.retry.priorDecisionDigest !== value.decision.digest ||
        value.retry.feedback !== value.reason ||
        value.retry.feedbackDigest !== value.decision.feedbackDigest ||
        value.retry.requestId !== mediaRevisionRetryRequestId(value.authority, value.decision))
    )
      context.addIssue({
        code: "custom",
        message: "media revision retry differs from its immutable decision request",
      });
  });

export type MediaDecisionRequest = z.infer<typeof MediaDecisionRequestSchema>;

export function mediaRevisionRetryRequestId(
  authorityInput: unknown,
  decisionInput: AssetDecision,
): string {
  const authority = ObjectiveAssetAuthoritySchema.parse(authorityInput);
  const decision = AssetDecisionSchema.parse(decisionInput);
  return `media-revision:${assetDigest([
    authority.repository,
    authority.objective,
    decision.runId,
    decision.requestId,
    decision.digest,
  ]).slice(0, 48)}`;
}

export function createMediaDecisionRequest(args: {
  authority: unknown;
  decision: AssetDecision;
  reason?: string;
}): MediaDecisionRequest {
  const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
  const decision = AssetDecisionSchema.parse(args.decision);
  const reason = args.reason ?? null;
  const retry =
    decision.kind === "revision-requested" && reason
      ? {
          requestId: mediaRevisionRetryRequestId(authority, decision),
          workItem: decision.producerWorkItem,
          priorAssetSetDigest: decision.assetSetDigest,
          priorDecisionDigest: decision.digest,
          feedback: reason,
          feedbackDigest: decision.feedbackDigest!,
        }
      : null;
  return MediaDecisionRequestSchema.parse(
    withMediaDigest({
      protocol: "clockgrove.factory/media-decision-request" as const,
      authority,
      decision,
      reason,
      retry,
    }),
  );
}

async function publishRecord(args: {
  store: MediaStore;
  authority: unknown;
  runId: string;
  collection: "dispatches" | "asset-sets" | "decision-requests" | "decisions" | "activations";
  digest: string;
  filename: string;
  record: unknown;
  parentOids: string[];
  primaryRef?: string;
  aliasRefs?: string[];
  publishDigestRef?: boolean;
  assertCurrent(): Promise<void>;
}) {
  const bytes = Buffer.from(canonicalAssetJson(args.record));
  if (bytes.length > 512 * 1024) throw new Error("media record exceeds 512 KiB");
  const ref = recordRef(args.authority, args.runId, args.collection, args.digest);
  const primaryRef = args.primaryRef ?? ref;
  await args.assertCurrent();
  const blob = await args.store.createBlob(bytes);
  if (blob !== gitOid(bytes)) throw new Error("media record blob identity mismatch");
  await args.assertCurrent();
  const tree = await args.store.createTree({
    entries: [{ path: args.filename, mode: "100644", type: "blob", sha: blob }],
  });
  const parents = [...new Set(args.parentOids)].sort();
  const message = `Factory immutable media ${args.collection}\n\nFactory-Media-Digest: ${args.digest}`;
  const verify = async (oid: string) => {
    const commit = await args.store.readCommit(oid);
    if (
      commit.treeOid !== tree ||
      canonicalAssetJson(commit.parentOids) !== canonicalAssetJson(parents) ||
      commit.message.trim() !== message
    )
      throw new Error("immutable media record publication conflicted");
    return oid;
  };
  const ensureAliases = async (commit: string) => {
    for (const alias of new Set([
      ...(args.publishDigestRef === false ? [] : [ref]),
      ...(args.aliasRefs ?? []),
    ])) {
      const existing = await args.store.readRef(alias);
      if (existing && existing !== commit)
        throw new Error("immutable media record alias conflicted");
      if (!existing) {
        await args.assertCurrent();
        let created = false;
        try {
          created = await args.store.createRef(alias, commit);
        } catch {
          /* reconcile below */
        }
        if (!created && (await args.store.readRef(alias)) !== commit)
          throw new Error("immutable media record alias publication is unresolved");
      }
    }
    return { ref: args.publishDigestRef === false ? primaryRef : ref, commit };
  };
  const existing = await args.store.readRef(primaryRef);
  if (existing) return ensureAliases(await verify(existing));
  await args.assertCurrent();
  const commit = await args.store.createCommit({ treeOid: tree, parentOids: parents, message });
  await args.assertCurrent();
  let created = false;
  try {
    created = await args.store.createRef(primaryRef, commit);
  } catch {
    /* reconcile below */
  }
  if (created) return ensureAliases(await verify(commit));
  const winner = await args.store.readRef(primaryRef);
  if (!winner) throw new Error("immutable media record publication is unresolved");
  return ensureAliases(await verify(winner));
}

async function readRecord<T>(args: {
  store: MediaStore;
  authority: unknown;
  runId: string;
  collection: "dispatches" | "asset-sets" | "decision-requests" | "decisions" | "activations";
  digest: string;
  filename: string;
  parse(value: unknown): T;
}) {
  const ref = recordRef(args.authority, args.runId, args.collection, args.digest);
  const oid = await args.store.readRef(ref);
  if (!oid) return null;
  const commit = await args.store.readCommit(oid);
  const blob = await args.store.readTreeEntry(commit.treeOid, args.filename);
  if (!blob) throw new Error("immutable media record blob is missing");
  const bytes = await args.store.readBlob(blob);
  if (gitOid(bytes) !== blob) throw new Error("immutable media record Git identity mismatch");
  const record = args.parse(JSON.parse(bytes.toString("utf8")));
  if ((record as { digest?: unknown }).digest !== args.digest)
    throw new Error("immutable media record digest differs from its ref");
  return { record, ref, commit: oid };
}

export function createMediaDispatchReceipt(
  invocationInput: MediaInvocation,
  handle: { invocationId: string; providerRequestId: string | null; dispatchedAt: string },
): MediaDispatchReceipt {
  const invocation = MediaInvocationSchema.parse(invocationInput);
  if (handle.invocationId !== invocation.invocationId)
    throw new Error("media dispatch handle belongs to another invocation");
  return MediaDispatchReceiptSchema.parse(
    withMediaDigest({
      protocol: "clockgrove.factory/media-dispatch-receipt-v1" as const,
      invocationDigest: invocation.digest,
      invocationId: invocation.invocationId,
      providerRequestId: handle.providerRequestId,
      dispatchedAt: handle.dispatchedAt,
    }),
  );
}

export async function persistMediaDispatchReceipt(args: {
  store: MediaStore;
  authority: unknown;
  runId: string;
  receipt: MediaDispatchReceipt;
  parentOids?: string[];
  assertCurrent(): Promise<void>;
}) {
  const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
  const receipt = MediaDispatchReceiptSchema.parse(args.receipt);
  return {
    receipt,
    ...(await publishRecord({
      store: args.store,
      authority,
      runId: args.runId,
      collection: "dispatches",
      digest: receipt.digest,
      filename: "media-dispatch.json",
      record: receipt,
      parentOids: args.parentOids ?? [],
      primaryRef: mediaInvocationDispatchRef(authority, args.runId, receipt.invocationDigest),
      publishDigestRef: false,
      assertCurrent: args.assertCurrent,
    })),
  };
}

async function readAssetSetDecision(args: {
  store: MediaStore;
  authority: unknown;
  runId: string;
  ref: string;
}) {
  const oid = await args.store.readRef(args.ref);
  if (!oid) return null;
  const commit = await args.store.readCommit(oid);
  const blob = await args.store.readTreeEntry(commit.treeOid, "asset-decision.json");
  if (!blob) throw new Error("immutable asset decision blob is missing");
  const bytes = await args.store.readBlob(blob);
  if (gitOid(bytes) !== blob) throw new Error("immutable asset decision Git identity mismatch");
  const decision = AssetDecisionSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (decision.assetSetDigest !== args.ref.split("/").at(-1))
    throw new Error("asset decision differs from its Asset Set authority");
  return { decision, ref: args.ref, commit: oid };
}

export function readAssetDecisionByAssetSet(args: {
  store: MediaStore;
  authority: unknown;
  runId: string;
  assetSetDigest: string;
}) {
  return readAssetSetDecision({
    ...args,
    ref: mediaAssetSetDecisionRef(args.authority, args.runId, args.assetSetDigest),
  });
}

export async function persistMediaDecisionRequest(args: {
  store: MediaStore;
  request: MediaDecisionRequest;
  parentOids: string[];
  assertCurrent(): Promise<void>;
}) {
  const request = MediaDecisionRequestSchema.parse(args.request);
  const primaryRef = mediaDecisionRequestRef(
    request.authority.repository,
    request.authority.objective,
    request.decision.requestId,
  );
  return {
    request,
    ...(await publishRecord({
      store: args.store,
      authority: request.authority,
      runId: request.decision.runId,
      collection: "decision-requests",
      digest: request.digest,
      filename: "media-decision-request.json",
      record: request,
      parentOids: args.parentOids,
      primaryRef,
      publishDigestRef: false,
      assertCurrent: args.assertCurrent,
    })),
  };
}

export async function readMediaDecisionRequest(args: {
  store: MediaStore;
  repository: string;
  objective: number;
  requestId: string;
}) {
  const ref = mediaDecisionRequestRef(args.repository, args.objective, args.requestId);
  const oid = await args.store.readRef(ref);
  if (!oid) return null;
  const commit = await args.store.readCommit(oid);
  const blob = await args.store.readTreeEntry(commit.treeOid, "media-decision-request.json");
  if (!blob) throw new Error("immutable media decision request blob is missing");
  const bytes = await args.store.readBlob(blob);
  if (gitOid(bytes) !== blob)
    throw new Error("immutable media decision request Git identity mismatch");
  const request = MediaDecisionRequestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    commit.message.trim() !==
    `Factory immutable media decision-requests\n\nFactory-Media-Digest: ${request.digest}`
  )
    throw new Error("immutable media decision request commit identity mismatch");
  if (
    request.authority.repository !== args.repository.toLowerCase() ||
    request.authority.objective !== args.objective ||
    request.decision.requestId !== args.requestId
  )
    throw new Error("media decision request differs from its request authority");
  return { request, ref, commit: oid };
}

export async function readMediaDispatchReceiptByInvocation(args: {
  store: MediaStore;
  authority: unknown;
  runId: string;
  invocationDigest: string;
}) {
  const ref = mediaInvocationDispatchRef(args.authority, args.runId, args.invocationDigest);
  const oid = await args.store.readRef(ref);
  if (!oid) return null;
  const commit = await args.store.readCommit(oid);
  const blob = await args.store.readTreeEntry(commit.treeOid, "media-dispatch.json");
  if (!blob) throw new Error("immutable media dispatch blob is missing");
  const bytes = await args.store.readBlob(blob);
  if (gitOid(bytes) !== blob) throw new Error("immutable media dispatch Git identity mismatch");
  const receipt = MediaDispatchReceiptSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (receipt.invocationDigest !== args.invocationDigest)
    throw new Error("media dispatch index differs from its invocation");
  return { receipt, ref, commit: oid };
}

export async function persistAssetSet(args: {
  store: MediaStore;
  authority: unknown;
  invocation: MediaInvocation;
  dispatchReceipt: MediaDispatchReceipt;
  collection: MediaAdapterCollection;
  assertCurrent(): Promise<void>;
}) {
  const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
  const invocation = MediaInvocationSchema.parse(args.invocation);
  const dispatchReceipt = MediaDispatchReceiptSchema.parse(args.dispatchReceipt);
  if (
    dispatchReceipt.invocationDigest !== invocation.digest ||
    dispatchReceipt.invocationId !== invocation.invocationId
  )
    throw new Error("media dispatch receipt differs from invocation");
  if (
    args.collection.variants.length < 1 ||
    args.collection.variants.length !== invocation.requestedVariants ||
    args.collection.variants.length > invocation.usageReservation.variants
  )
    throw new Error("collected media variant count differs from invocation");
  const totalBytes = args.collection.variants.reduce(
    (total, variant) => total + variant.bytes.length,
    0,
  );
  if (
    totalBytes > invocation.usageReservation.generatedBytes ||
    totalBytes > invocation.usageReservation.storageBytes
  )
    throw new Error("collected media bytes exceed invocation limits");
  const usage = new Map(args.collection.usage.map((entry) => [entry.unit, entry.amount]));
  const capabilityUsage = new Set(args.collection.usage.map((entry) => entry.unit));
  if (capabilityUsage.size !== args.collection.usage.length)
    throw new Error("media usage units are duplicated");
  const manifest = await persistProducedAssetManifest({
    store: args.store,
    authority,
    requestId: `media-${invocation.invocationId}`,
    revision: invocation.attempt,
    assets: args.collection.variants,
    assertCurrent: args.assertCurrent,
  });
  const core = {
    protocol: "clockgrove.factory/asset-set-v1" as const,
    authority,
    runId: invocation.runId,
    workItem: invocation.workItem,
    attempt: invocation.attempt,
    intentId: invocation.intentId,
    intentDigest: invocation.intentDigest,
    invocationDigest: invocation.digest,
    dispatchReceiptDigest: dispatchReceipt.digest,
    providerResponseId: args.collection.providerResponseId,
    productionReceiptDigest: args.collection.productionReceiptDigest,
    storageManifestDigest: manifest.manifest.digest,
    activationSelection: invocation.activationSelection,
    variants: manifest.manifest.assets,
    usage: [...usage]
      .map(([unit, amount]) => ({ unit, amount }))
      .sort((left, right) => left.unit.localeCompare(right.unit)),
    totalGeneratedBytes: totalBytes,
    totalStorageBytes: totalBytes,
  };
  const assetSet = AssetSetSchema.parse(withMediaDigest(core));
  return {
    assetSet,
    storageManifest: manifest.manifest,
    ...(await publishRecord({
      store: args.store,
      authority,
      runId: invocation.runId,
      collection: "asset-sets",
      digest: assetSet.digest,
      filename: "asset-set.json",
      record: assetSet,
      parentOids: assetSet.variants.map(({ storage }) => storage.readyCommit),
      assertCurrent: args.assertCurrent,
    })),
  };
}

export function readAssetSet(args: {
  store: MediaStore;
  authority: unknown;
  runId: string;
  digest: string;
}) {
  return readRecord({
    ...args,
    collection: "asset-sets",
    filename: "asset-set.json",
    parse: (value) => AssetSetSchema.parse(value),
  });
}

export async function persistAssetDecision(args: {
  store: MediaStore;
  authority: unknown;
  decision: AssetDecision;
  parentOids?: string[];
  assertCurrent(): Promise<void>;
}) {
  const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
  const decision = AssetDecisionSchema.parse(args.decision);
  return {
    decision,
    ...(await publishRecord({
      store: args.store,
      authority,
      runId: decision.runId,
      collection: "decisions",
      digest: decision.digest,
      filename: "asset-decision.json",
      record: decision,
      parentOids: args.parentOids ?? [],
      primaryRef: mediaAssetSetDecisionRef(authority, decision.runId, decision.assetSetDigest),
      publishDigestRef: false,
      assertCurrent: args.assertCurrent,
    })),
  };
}

export function createAssetActivation(args: {
  assetSet: AssetSet;
  decision: AssetDecision;
  producerReservationOid: string;
}): AssetActivation {
  const assetSet = AssetSetSchema.parse(args.assetSet);
  const decision = AssetDecisionSchema.parse(args.decision);
  if (
    decision.kind !== "approved" ||
    decision.runId !== assetSet.runId ||
    decision.intentId !== assetSet.intentId ||
    decision.intentDigest !== assetSet.intentDigest ||
    decision.producerWorkItem !== assetSet.workItem ||
    decision.producerAttempt !== assetSet.attempt ||
    decision.producerReservationOid !== args.producerReservationOid ||
    decision.invocationDigest !== assetSet.invocationDigest ||
    decision.assetSetDigest !== assetSet.digest ||
    decision.storageManifestDigest !== assetSet.storageManifestDigest
  )
    throw new Error("asset approval does not bind the selected asset set");
  const selected = decision.selectedDescriptorDigests.map((digest) => {
    const entry = assetSet.variants.find(({ descriptor }) => descriptor.digest === digest);
    if (!entry) throw new Error("approved descriptor is not in the asset set");
    return entry;
  });
  return AssetActivationSchema.parse(
    withMediaDigest({
      protocol: "clockgrove.factory/asset-activation-v1" as const,
      runId: assetSet.runId,
      intentId: assetSet.intentId,
      intentDigest: assetSet.intentDigest,
      producerWorkItem: assetSet.workItem,
      producerAttempt: assetSet.attempt,
      producerReservationOid: args.producerReservationOid,
      assetSetDigest: assetSet.digest,
      storageManifestDigest: assetSet.storageManifestDigest,
      decisionDigest: decision.digest,
      selected,
    }),
  );
}

export async function persistAssetActivation(args: {
  store: MediaStore;
  authority: unknown;
  activation: AssetActivation;
  parentOids: string[];
  assertCurrent(): Promise<void>;
}) {
  const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
  const activation = AssetActivationSchema.parse(args.activation);
  return {
    activation,
    ...(await publishRecord({
      store: args.store,
      authority,
      runId: activation.runId,
      collection: "activations",
      digest: activation.digest,
      filename: "asset-activation.json",
      record: activation,
      parentOids: args.parentOids,
      assertCurrent: args.assertCurrent,
    })),
  };
}

export function readAssetActivation(args: {
  store: MediaStore;
  authority: unknown;
  runId: string;
  digest: string;
}) {
  return readRecord({
    ...args,
    collection: "activations",
    filename: "asset-activation.json",
    parse: (value) => AssetActivationSchema.parse(value),
  });
}
