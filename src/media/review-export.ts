import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { recoverObjectiveAsset, type ObjectiveAssetStore } from "../assets/storage.js";
import {
  assetDigest,
  ObjectiveAssetManifestSchema,
  type ObjectiveAssetManifest,
} from "../assets/contracts.js";
import {
  inspectContentFile,
  materializePayload,
  retainCurrentArtifactPayload,
} from "../execution/artifact-content.js";
import { withArtifactContentScope } from "../execution/artifact-content-scope.js";
import { sha256Digest } from "../protocol/limits.js";

export function defaultMediaReviewRoot(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("media review export requires a Linux user identity");
  const configuredState = process.env["XDG_STATE_HOME"]?.trim();
  const stateRoot =
    configuredState && isAbsolute(configuredState)
      ? resolve(configuredState)
      : join(homedir(), ".local", "state");
  return join(stateRoot, "clockgrove-factory", "media-review");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("media review directory is not private owned storage");
}

async function verifyMaterialization(path: string, digest: string, bytes: number): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o222) !== 0
  )
    throw new Error("media review materialization is not an owned read-only file");
  const observed = await inspectContentFile(path, bytes);
  if (observed.digest !== digest || observed.bytes !== bytes)
    throw new Error("media review materialization identity mismatch");
}

async function materializeProducedAssetForReviewScoped(args: {
  store: ObjectiveAssetStore;
  manifest: ObjectiveAssetManifest;
  assetSetDigest: string;
  descriptorDigest: string;
  reviewRoot?: string;
}) {
  const manifest = ObjectiveAssetManifestSchema.parse(args.manifest);
  const assetSetDigest = sha256Digest.parse(args.assetSetDigest);
  const descriptorDigest = sha256Digest.parse(args.descriptorDigest);
  const recovered = await recoverObjectiveAsset({
    store: args.store,
    manifest,
    descriptorDigest,
  });
  retainCurrentArtifactPayload(recovered.payload);
  if (
    recovered.entry.storage.transferDomain !== "produced-asset" ||
    recovered.payload.digest !== recovered.entry.descriptor.content.digest ||
    recovered.payload.bytes !== recovered.entry.descriptor.content.bytes
  )
    throw new Error("produced asset transfer differs from its immutable descriptor");
  const filename = basename(recovered.entry.descriptor.materializationPath);

  const requestedRoot = resolve(args.reviewRoot ?? defaultMediaReviewRoot());
  await ensurePrivateDirectory(requestedRoot);
  const root = await open(
    requestedRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let staging: string | undefined;
  try {
    const rootIdentity = await root.stat();
    if (!rootIdentity.isDirectory() || rootIdentity.uid !== process.getuid?.())
      throw new Error("media review root identity changed");
    const anchoredRoot = `/proc/self/fd/${root.fd}`;
    const segments = [
      `repository-${assetDigest(manifest.authority.repository)}`,
      `objective-${manifest.authority.objective}`,
      assetSetDigest,
      descriptorDigest,
    ];
    let anchoredDirectory = anchoredRoot;
    for (const segment of segments) {
      anchoredDirectory = join(anchoredDirectory, segment);
      await ensurePrivateDirectory(anchoredDirectory);
    }
    const anchoredDestination = join(anchoredDirectory, filename);
    const localPath = join(requestedRoot, ...segments, filename);
    try {
      await verifyMaterialization(
        anchoredDestination,
        recovered.entry.descriptor.content.digest,
        recovered.entry.descriptor.content.bytes,
      );
      return { path: localPath, entry: recovered.entry };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    staging = await mkdtemp(join(anchoredDirectory, ".stage-"));
    const staged = join(staging, filename);
    await materializePayload(recovered.payload, staged);
    await chmod(staged, 0o400);
    const stagedHandle = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await stagedHandle.sync();
    } finally {
      await stagedHandle.close();
    }
    await verifyMaterialization(
      staged,
      recovered.entry.descriptor.content.digest,
      recovered.entry.descriptor.content.bytes,
    );
    try {
      await link(staged, anchoredDestination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await verifyMaterialization(
      anchoredDestination,
      recovered.entry.descriptor.content.digest,
      recovered.entry.descriptor.content.bytes,
    );
    const directory = await open(
      anchoredDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const observedRoot = await lstat(requestedRoot);
    if (
      observedRoot.isSymbolicLink() ||
      observedRoot.dev !== rootIdentity.dev ||
      observedRoot.ino !== rootIdentity.ino
    )
      throw new Error("media review root changed during materialization");
    return { path: localPath, entry: recovered.entry };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await root.close();
  }
}

/** Recover and materialize one exact produced asset without trusting a provider URL or logical path. */
export function materializeProducedAssetForReview(
  args: Parameters<typeof materializeProducedAssetForReviewScoped>[0],
) {
  return withArtifactContentScope(() => materializeProducedAssetForReviewScoped(args));
}
