import { createHash } from "node:crypto";
import { cachePayloadBytes } from "../execution/artifact-content.js";
import { withArtifactContentScope } from "../execution/artifact-content-scope.js";
import {
  contentTransferRef,
  persistContentTransfer,
  recoverContentTransfer,
  type ContentTransferStore,
} from "../control/content-transfers.js";
import {
  AssetDescriptorSchema,
  AssetStorageReceiptSchema,
  MAX_OBJECTIVE_ASSETS,
  MAX_OBJECTIVE_ASSET_TOTAL_BYTES,
  ObjectiveAssetAuthoritySchema,
  ObjectiveAssetManifestSchema,
  assetDigest,
  canonicalAssetJson,
  withAssetDigest,
  type AssetDescriptor,
  type ObjectiveAssetAuthority,
  type ObjectiveAssetManifest,
} from "./contracts.js";

export type ObjectiveAssetStore = ContentTransferStore;
const gitOid = (value: Buffer) =>
  createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const authorityKey = (authority: ObjectiveAssetAuthority) =>
  assetDigest(ObjectiveAssetAuthoritySchema.parse(authority));
export const objectiveAssetManifestRef = (authority: ObjectiveAssetAuthority, digest: string) =>
  `refs/clockgrove-factory/objective-assets/${authorityKey(authority)}/manifests/${digest}`;
export const objectiveAssetRequestRef = (authority: ObjectiveAssetAuthority, requestId: string) =>
  `refs/clockgrove-factory/objective-assets/${authorityKey(authority)}/requests/${assetDigest(requestId)}`;

async function publishManifest(args: {
  store: ObjectiveAssetStore;
  manifest: ObjectiveAssetManifest;
  assertCurrent(): Promise<void>;
}) {
  const bytes = Buffer.from(canonicalAssetJson(args.manifest));
  if (bytes.length > 256 * 1024) throw new Error("Objective asset manifest exceeds 256 KiB");
  await args.assertCurrent();
  const blob = await args.store.createBlob(bytes);
  if (blob !== gitOid(bytes)) throw new Error("Objective asset manifest blob identity mismatch");
  await args.assertCurrent();
  const tree = await args.store.createTree({
    entries: [{ path: "objective-assets.json", mode: "100644", type: "blob", sha: blob }],
  });
  const ref = objectiveAssetManifestRef(args.manifest.authority, args.manifest.digest);
  const parents = args.manifest.assets.map(({ storage }) => storage.readyCommit).sort();
  const message = `Factory Objective asset manifest\n\nFactory-Manifest: ${args.manifest.digest}`;
  const validateWinner = async (oid: string) => {
    const winner = await args.store.readCommit(oid);
    if (
      winner.treeOid !== tree ||
      canonicalAssetJson(winner.parentOids) !== canonicalAssetJson(parents) ||
      winner.message !== message
    )
      throw new Error("Objective asset manifest publication conflicted");
    return oid;
  };
  const existing = await args.store.readRef(ref);
  let commit = existing ? await validateWinner(existing) : null;
  if (!commit) {
    await args.assertCurrent();
    commit = await args.store.createCommit({
      treeOid: tree,
      parentOids: parents,
      message,
    });
    await args.assertCurrent();
    let created = false;
    try {
      created = await args.store.createRef(ref, commit);
    } catch {
      /* reconcile */
    }
    if (!created) {
      const winner = await args.store.readRef(ref);
      if (!winner) throw new Error("Objective asset manifest publication is unresolved");
      commit = await validateWinner(winner);
    } else await validateWinner(commit);
  }
  const requestRef = objectiveAssetRequestRef(args.manifest.authority, args.manifest.requestId);
  const acceptedRequest = await args.store.readRef(requestRef);
  if (acceptedRequest && acceptedRequest !== commit)
    throw new Error("Objective asset request identity is already bound to another manifest");
  if (!acceptedRequest) {
    await args.assertCurrent();
    let createdRequest = false;
    try {
      createdRequest = await args.store.createRef(requestRef, commit);
    } catch {
      /* reconcile below */
    }
    if (!createdRequest && (await args.store.readRef(requestRef)) !== commit)
      throw new Error("Objective asset request publication is unresolved");
  }
  return { ref, commit };
}

async function persistObjectiveAssetManifestScoped(args: {
  store: ObjectiveAssetStore;
  authority: ObjectiveAssetAuthority;
  requestId: string;
  revision: number;
  assets: Array<{ descriptor: AssetDescriptor; bytes: Buffer }>;
  assertCurrent(): Promise<void>;
}) {
  const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
  const descriptors = args.assets.map(({ descriptor }) => AssetDescriptorSchema.parse(descriptor));
  if (
    !descriptors.length ||
    new Set(descriptors.map(({ digest }) => digest)).size !== descriptors.length
  )
    throw new Error("Objective asset batch is empty or duplicates descriptors");
  if (descriptors.length > MAX_OBJECTIVE_ASSETS)
    throw new Error(`Objective asset batch exceeds ${MAX_OBJECTIVE_ASSETS} entries`);
  const totalBytes = descriptors.reduce((sum, descriptor) => sum + descriptor.content.bytes, 0);
  if (totalBytes > MAX_OBJECTIVE_ASSET_TOTAL_BYTES)
    throw new Error("Objective asset batch exceeds the aggregate byte limit");
  const entries: ObjectiveAssetManifest["assets"] = [];
  for (const [index, asset] of args.assets.entries()) {
    if (
      asset.bytes.length !== asset.descriptor.content.bytes ||
      createHash("sha256").update(asset.bytes).digest("hex") !== asset.descriptor.content.digest
    )
      throw new Error("Objective asset bytes differ from descriptor");
    const payload = await cachePayloadBytes(asset.bytes);
    const identity = {
      domain: "objective-asset" as const,
      repository: authority.repository,
      objective: authority.objective,
      baseSha: authority.baseSha,
      requestId: `asset-${assetDigest([args.requestId, index, asset.descriptor.digest]).slice(0, 40)}`,
      subjectDigest: asset.descriptor.content.digest,
    };
    const transfer = await persistContentTransfer({
      store: args.store,
      identity,
      payload,
      assertCurrent: args.assertCurrent,
    });
    const storage = AssetStorageReceiptSchema.parse(
      withAssetDigest({
        protocol: "clockgrove.factory/asset-storage-receipt" as const,
        authority,
        descriptorDigest: asset.descriptor.digest,
        transferRequestId: identity.requestId,
        ...transfer,
      }),
    );
    entries.push({ descriptor: asset.descriptor, storage });
  }
  entries.sort((a, b) => a.descriptor.digest.localeCompare(b.descriptor.digest));
  const core = {
    protocol: "clockgrove.factory/objective-asset-manifest" as const,
    authority,
    revision: args.revision,
    requestId: args.requestId,
    assets: entries,
    totalBytes,
  };
  const manifest = ObjectiveAssetManifestSchema.parse(withAssetDigest(core));
  return {
    manifest,
    ...(await publishManifest({ store: args.store, manifest, assertCurrent: args.assertCurrent })),
  };
}

/** Cache leases are operation-scoped; immutable Git evidence is the restart source. */
export function persistObjectiveAssetManifest(
  args: Parameters<typeof persistObjectiveAssetManifestScoped>[0],
) {
  return withArtifactContentScope(() => persistObjectiveAssetManifestScoped(args));
}

export async function readObjectiveAssetManifest(args: {
  store: ObjectiveAssetStore;
  authority: ObjectiveAssetAuthority;
  digest: string;
}) {
  const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
  const ref = objectiveAssetManifestRef(authority, args.digest);
  const commitOid = await args.store.readRef(ref);
  if (!commitOid) return null;
  const commit = await args.store.readCommit(commitOid);
  const blob = await args.store.readTreeEntry(commit.treeOid, "objective-assets.json");
  if (!blob) throw new Error("Objective asset manifest blob is missing");
  const bytes = await args.store.readBlob(blob);
  if (gitOid(bytes) !== blob) throw new Error("Objective asset manifest Git identity mismatch");
  const manifest = ObjectiveAssetManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const parents = manifest.assets.map(({ storage }) => storage.readyCommit).sort();
  if (
    manifest.digest !== args.digest ||
    canonicalAssetJson(manifest.authority) !== canonicalAssetJson(authority) ||
    commit.message.trim() !==
      `Factory Objective asset manifest\n\nFactory-Manifest: ${manifest.digest}` ||
    canonicalAssetJson(commit.parentOids) !== canonicalAssetJson(parents)
  )
    throw new Error("Objective asset manifest authority mismatch");
  return manifest;
}

export async function readObjectiveAssetManifestByRequest(args: {
  store: ObjectiveAssetStore;
  authority: ObjectiveAssetAuthority;
  requestId: string;
}) {
  const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
  const commitOid = await args.store.readRef(objectiveAssetRequestRef(authority, args.requestId));
  if (!commitOid) return null;
  const commit = await args.store.readCommit(commitOid);
  const blob = await args.store.readTreeEntry(commit.treeOid, "objective-assets.json");
  if (!blob) throw new Error("Objective asset request manifest blob is missing");
  const bytes = await args.store.readBlob(blob);
  if (gitOid(bytes) !== blob)
    throw new Error("Objective asset request manifest Git identity mismatch");
  const manifest = ObjectiveAssetManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const canonicalRef = objectiveAssetManifestRef(authority, manifest.digest);
  const canonicalCommit = await args.store.readRef(canonicalRef);
  if (
    manifest.requestId !== args.requestId ||
    canonicalAssetJson(manifest.authority) !== canonicalAssetJson(authority) ||
    canonicalCommit !== commitOid ||
    commit.message.trim() !==
      `Factory Objective asset manifest\n\nFactory-Manifest: ${manifest.digest}` ||
    canonicalAssetJson(commit.parentOids) !==
      canonicalAssetJson(manifest.assets.map(({ storage }) => storage.readyCommit).sort())
  )
    throw new Error("Objective asset request binding differs from its manifest");
  return {
    manifest,
    ref: canonicalRef,
    commit: commitOid,
  };
}

export async function recoverObjectiveAsset(args: {
  store: ObjectiveAssetStore;
  manifest: ObjectiveAssetManifest;
  descriptorDigest: string;
}) {
  const entry = args.manifest.assets.find(
    ({ descriptor }) => descriptor.digest === args.descriptorDigest,
  );
  if (!entry) throw new Error("Objective asset descriptor is not in the manifest");
  const identity = {
    domain: "objective-asset" as const,
    repository: args.manifest.authority.repository,
    objective: args.manifest.authority.objective,
    baseSha: args.manifest.authority.baseSha,
    requestId: entry.storage.transferRequestId,
    subjectDigest: entry.descriptor.content.digest,
  };
  if (contentTransferRef(identity) !== entry.storage.transferRef)
    throw new Error("Objective asset receipt transfer identity mismatch");
  const recovered = await recoverContentTransfer({ store: args.store, identity });
  if (
    !recovered ||
    recovered.intentCommit !== entry.storage.intentCommit ||
    recovered.readyCommit !== entry.storage.readyCommit ||
    recovered.payload.digest !== entry.descriptor.content.digest
  )
    throw new Error("Objective asset transfer differs from storage receipt");
  return { entry, payload: recovered.payload };
}
