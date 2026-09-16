import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  inspectContentFile,
  materializePayload,
  regularContentPath,
} from "../execution/artifact-content.js";
import type { ObjectiveAssetStore } from "./storage.js";
import { recoverObjectiveAsset } from "./storage.js";
import { ObjectiveAssetManifestSchema, type ObjectiveAssetManifest } from "./contracts.js";
import { withArtifactContentScope } from "../execution/artifact-content-scope.js";

async function privateRoot(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Objective asset root is not private owned storage");
}
async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function verifyExisting(root: string, entries: ObjectiveAssetManifest["assets"]) {
  for (const { descriptor } of entries) {
    const path = await regularContentPath(root, descriptor.materializationPath);
    const observed = await inspectContentFile(path, descriptor.content.bytes);
    if (
      observed.bytes !== descriptor.content.bytes ||
      observed.digest !== descriptor.content.digest
    )
      throw new Error("materialized Objective asset identity mismatch");
  }
}

/** Materialize verified immutable content without source URLs, credentials, or network dependency. */
async function materializeObjectiveAssetsScoped(args: {
  store: ObjectiveAssetStore;
  manifest: ObjectiveAssetManifest;
  supervisorRoot: string;
  descriptorDigests: string[];
}) {
  const manifest = ObjectiveAssetManifestSchema.parse(args.manifest);
  const selected = new Set(args.descriptorDigests);
  if (!selected.size || selected.size !== args.descriptorDigests.length)
    throw new Error("Objective asset materialization requires unique selected descriptors");
  const entries = manifest.assets.filter(({ descriptor }) => selected.has(descriptor.digest));
  if (entries.length !== selected.size)
    throw new Error("Objective asset materialization selection is not in the manifest");
  const requestedBase = resolve(args.supervisorRoot);
  const requestedWorkspace = dirname(requestedBase);
  const workspace = await open(
    requestedWorkspace,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const workspaceIdentity = await workspace.stat();
    if (!workspaceIdentity.isDirectory() || workspaceIdentity.uid !== process.getuid?.())
      throw new Error("Objective asset attempt workspace is not an owned real directory");
    // Linux /proc fd paths keep every cleanup and write anchored to the already-opened,
    // no-follow workspace even if a prior worker races a pathname replacement.
    const anchoredWorkspace = `/proc/self/fd/${workspace.fd}`;
    const base = join(anchoredWorkspace, basename(requestedBase));
    await privateRoot(base);
    const baseIdentity = await lstat(base);
    for (const name of await readdir(base)) {
      if (!name.startsWith("attempt-")) continue;
      const stale = join(base, name);
      const info = await lstat(stale);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Objective asset attempt root is not a real directory");
      await rm(stale, { recursive: true, force: true });
    }
    const temporary = await mkdtemp(join(base, `attempt-${manifest.digest.slice(0, 12)}-`));
    try {
      for (const { descriptor } of entries) {
        const recovered = await recoverObjectiveAsset({
          store: args.store,
          manifest,
          descriptorDigest: descriptor.digest,
        });
        const destination = join(temporary, descriptor.materializationPath);
        if (!resolve(destination).startsWith(`${resolve(temporary)}${sep}`))
          throw new Error("Objective asset materialization escaped its root");
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await materializePayload(recovered.payload, destination);
        const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const observed = await inspectContentFile(destination, descriptor.content.bytes);
        if (
          observed.bytes !== descriptor.content.bytes ||
          observed.digest !== descriptor.content.digest
        )
          throw new Error("materialized Objective asset digest mismatch");
        await chmod(destination, 0o444);
      }
      await verifyExisting(temporary, entries);
      await syncDirectory(temporary);
      await syncDirectory(base);
      const observedWorkspace = await lstat(requestedWorkspace);
      const observedBase = await lstat(requestedBase);
      if (
        observedWorkspace.isSymbolicLink() ||
        observedWorkspace.dev !== workspaceIdentity.dev ||
        observedWorkspace.ino !== workspaceIdentity.ino ||
        observedBase.isSymbolicLink() ||
        observedBase.dev !== baseIdentity.dev ||
        observedBase.ino !== baseIdentity.ino
      )
        throw new Error("Objective asset workspace changed during materialization");
      return {
        root: join(requestedBase, basename(temporary)),
        manifestDigest: manifest.digest,
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await workspace.close();
  }
}

export function materializeObjectiveAssets(
  args: Parameters<typeof materializeObjectiveAssetsScoped>[0],
) {
  return withArtifactContentScope(() => materializeObjectiveAssetsScoped(args));
}
