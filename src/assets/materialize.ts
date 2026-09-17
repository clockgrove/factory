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
import {
  ObjectiveAssetManifestSchema,
  WorkerAssetInputSchema,
  assetDigest,
  type ObjectiveAssetManifest,
  type WorkerAssetInput,
} from "./contracts.js";
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

type MaterializationSelection = {
  manifest: ObjectiveAssetManifest;
  binding: WorkerAssetInput;
};

function resolveSelections(args: {
  manifests: ObjectiveAssetManifest[];
  bindings: WorkerAssetInput[];
}): MaterializationSelection[] {
  const manifests = args.manifests.map((manifest) => ObjectiveAssetManifestSchema.parse(manifest));
  const bindings = args.bindings.map((binding) => WorkerAssetInputSchema.parse(binding));
  if (!bindings.length) throw new Error("Objective asset materialization selection is empty");
  if (new Set(bindings.map(({ descriptorDigest }) => descriptorDigest)).size !== bindings.length)
    throw new Error("Objective asset materialization duplicates a descriptor");
  if (new Set(bindings.map(({ path }) => path)).size !== bindings.length)
    throw new Error("Objective asset materialization has a path collision");
  const byDigest = new Map<string, ObjectiveAssetManifest>();
  for (const manifest of manifests) {
    const existing = byDigest.get(manifest.digest);
    if (existing && existing !== manifest)
      throw new Error("Objective asset materialization has conflicting manifest identities");
    byDigest.set(manifest.digest, manifest);
  }
  return bindings.map((binding) => {
    const manifest = byDigest.get(binding.manifestDigest);
    const entry = manifest?.assets.find(
      ({ descriptor }) => descriptor.digest === binding.descriptorDigest,
    );
    if (
      !manifest ||
      !entry ||
      entry.descriptor.content.digest !== binding.contentDigest ||
      entry.storage.digest !== binding.storageReceiptDigest ||
      entry.descriptor.materializationPath !== binding.path
    )
      throw new Error("Worker Packet Objective asset binding differs from its immutable manifest");
    return { manifest, binding };
  });
}

async function materializeObjectiveAssetSelectionsScoped(args: {
  store: ObjectiveAssetStore;
  selections: MaterializationSelection[];
  supervisorRoot: string;
}) {
  if (!args.selections.length)
    throw new Error("Objective asset materialization selection is empty");
  const entries = args.selections.map(({ manifest, binding }) => {
    const entry = manifest.assets.find(
      ({ descriptor }) => descriptor.digest === binding.descriptorDigest,
    );
    if (!entry) throw new Error("Objective asset descriptor is not in the manifest");
    return entry;
  });
  const selectionDigest = assetDigest(
    args.selections
      .map(({ manifest, binding }) => [manifest.digest, binding.descriptorDigest])
      .sort(([leftManifest, leftDescriptor], [rightManifest, rightDescriptor]) =>
        leftManifest === rightManifest
          ? leftDescriptor!.localeCompare(rightDescriptor!)
          : leftManifest!.localeCompare(rightManifest!),
      ),
  );
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
    const temporary = await mkdtemp(join(base, `attempt-${selectionDigest.slice(0, 12)}-`));
    try {
      for (const { manifest, binding } of args.selections) {
        const recovered = await recoverObjectiveAsset({
          store: args.store,
          manifest,
          descriptorDigest: binding.descriptorDigest,
        });
        const destination = join(temporary, recovered.entry.descriptor.materializationPath);
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
        const observed = await inspectContentFile(
          destination,
          recovered.entry.descriptor.content.bytes,
        );
        if (
          observed.bytes !== recovered.entry.descriptor.content.bytes ||
          observed.digest !== recovered.entry.descriptor.content.digest
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
      return { root: join(requestedBase, basename(temporary)), selectionDigest };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await workspace.close();
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
  const materialized = await materializeObjectiveAssetSelectionsScoped({
    store: args.store,
    supervisorRoot: args.supervisorRoot,
    selections: entries.map((entry) => ({
      manifest,
      binding: {
        manifestDigest: manifest.digest,
        descriptorDigest: entry.descriptor.digest,
        contentDigest: entry.descriptor.content.digest,
        storageReceiptDigest: entry.storage.digest,
        path: entry.descriptor.materializationPath,
      },
    })),
  });
  return { root: materialized.root, manifestDigest: manifest.digest };
}

export function materializeObjectiveAssets(
  args: Parameters<typeof materializeObjectiveAssetsScoped>[0],
) {
  return withArtifactContentScope(() => materializeObjectiveAssetsScoped(args));
}

/** Materialize one exact deduplicated Worker Packet binding set across immutable manifests. */
export function materializeWorkerAssetInputs(args: {
  store: ObjectiveAssetStore;
  manifests: ObjectiveAssetManifest[];
  bindings: WorkerAssetInput[];
  supervisorRoot: string;
}) {
  return withArtifactContentScope(() =>
    materializeObjectiveAssetSelectionsScoped({
      store: args.store,
      supervisorRoot: args.supervisorRoot,
      selections: resolveSelections(args),
    }),
  );
}
