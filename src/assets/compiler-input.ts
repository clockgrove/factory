import { join } from "node:path";

import type { WorkerAssetInput } from "./contracts.js";
import { ObjectiveAssetManifestSchema, type ObjectiveAssetManifest } from "./contracts.js";
import type { CompilerAssetManifestView } from "./media-intent.js";

function opaqueAssetIds(manifest: ObjectiveAssetManifest): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const { descriptor } of manifest.assets) {
    let id = "";
    for (let length = 12; length <= 56; length += 4) {
      id = `asset-${descriptor.digest.slice(0, length)}`;
      if (!used.has(id)) break;
    }
    if (!id || used.has(id)) throw new Error("Objective asset IDs cannot be made collision-free");
    used.add(id);
    ids.set(descriptor.digest, id);
  }
  return ids;
}

export function compilerAssetManifestView(manifestInput: ObjectiveAssetManifest): {
  view: CompilerAssetManifestView;
  bindings: Array<{ assetId: string; input: WorkerAssetInput }>;
} {
  const manifest = ObjectiveAssetManifestSchema.parse(manifestInput);
  const ids = opaqueAssetIds(manifest);
  return {
    view: {
      digest: manifest.digest,
      assets: manifest.assets.map(({ descriptor }) => {
        const raster =
          descriptor.content.inspection.metadata.kind === "raster"
            ? descriptor.content.inspection.metadata
            : null;
        return {
          id: ids.get(descriptor.digest)!,
          mediaType: descriptor.content.inspection.mediaType,
          bytes: descriptor.content.bytes,
          inspection: raster
            ? {
                kind: "raster" as const,
                width: raster.width,
                height: raster.height,
                frames: raster.frames,
                alpha: raster.channels === 2 || raster.channels === 4,
              }
            : { kind: "opaque" as const },
          visibility: descriptor.visibility,
        };
      }),
    },
    bindings: manifest.assets.map(({ descriptor, storage }) => ({
      assetId: ids.get(descriptor.digest)!,
      input: {
        manifestDigest: manifest.digest,
        descriptorDigest: descriptor.digest,
        contentDigest: descriptor.content.digest,
        storageReceiptDigest: storage.digest,
        path: descriptor.materializationPath,
      },
    })),
  };
}

export function compilerMediaInputs(
  manifestInput: ObjectiveAssetManifest,
  materializedRoot: string,
  supportedMediaTypes: readonly string[],
): Array<{ assetId: string; mediaType: string; path: string }> {
  const manifest = ObjectiveAssetManifestSchema.parse(manifestInput);
  const ids = opaqueAssetIds(manifest);
  const supported = new Set(supportedMediaTypes);
  return manifest.assets.flatMap(({ descriptor }) =>
    supported.has(descriptor.content.inspection.mediaType)
      ? [
          {
            assetId: ids.get(descriptor.digest)!,
            mediaType: descriptor.content.inspection.mediaType,
            path: join(materializedRoot, descriptor.materializationPath),
          },
        ]
      : [],
  );
}

export function compilerMediaDescriptorDigests(
  manifestInput: ObjectiveAssetManifest,
  supportedMediaTypes: readonly string[],
): string[] {
  const manifest = ObjectiveAssetManifestSchema.parse(manifestInput);
  const supported = new Set(supportedMediaTypes);
  return manifest.assets
    .filter(({ descriptor }) => supported.has(descriptor.content.inspection.mediaType))
    .map(({ descriptor }) => descriptor.digest);
}
