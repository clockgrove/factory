import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { assertNoSecretMaterial } from "../protocol/limits.js";
import {
  AssetDescriptorSchema,
  AssetProvenanceSchema,
  AssetRightsSchema,
  AssetVisibilitySchema,
  MAX_OBJECTIVE_ASSET_BYTES,
  assetDigest,
  withAssetDigest,
  type AssetDescriptor,
} from "./contracts.js";
import { inspectAssetBytes } from "./handlers.js";

const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "user-images.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
]);
export type ObjectiveAssetImport =
  | { kind: "local-file"; path: string; name?: string }
  | { kind: "github-attachment"; url: string; name?: string };
export interface ObjectiveAssetImportMetadata {
  importId: string;
  visibility: "public" | "private";
  allowOpaque?: boolean;
  rights: {
    basis: "user-owned" | "licensed" | "permission-granted" | "unknown";
    license?: string;
    attribution?: string;
  };
}
const safeFilename = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 128) || "asset.bin";
function publicAddress(address: string): boolean {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  return parsed.range() === "unicast";
}
async function pinnedAddress(host: string) {
  if (!DOWNLOAD_HOSTS.has(host))
    throw new Error(`GitHub attachment redirected to denied host ${host}`);
  const addresses = await lookup(host, { all: true, verbatim: true });
  const selected = addresses.find(({ address }) => publicAddress(address));
  if (!selected || addresses.some(({ address }) => !publicAddress(address)))
    throw new Error("attachment host has a private, reserved, or ambiguous address set");
  return selected;
}
export function recognizedGitHubAttachment(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search
  )
    throw new Error("GitHub attachment must be a plain HTTPS URL");
  if (url.hostname === "github.com") {
    const match = /^\/user-attachments\/assets\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
    if (!match) throw new Error("URL is not a recognized GitHub attachment");
    return { url, attachmentId: match[1]!, host: "github.com" as const };
  }
  if (url.hostname === "user-images.githubusercontent.com") {
    if (url.pathname.split("/").filter(Boolean).length < 2)
      throw new Error("URL is not a recognized legacy GitHub attachment");
    return {
      url,
      attachmentId: createHash("sha256").update(url.pathname).digest("hex"),
      host: "user-images.githubusercontent.com" as const,
    };
  }
  throw new Error("arbitrary URLs are not Objective asset inputs");
}
async function pinnedGet(url: URL): Promise<{ status: number; location?: string; bytes?: Buffer }> {
  const pinned = await pinnedAddress(url.hostname);
  return new Promise((resolvePromise, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { Accept: "*/*", "User-Agent": "clockgrove-factory-objective-assets" },
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          resolvePromise({
            status,
            ...(response.headers.location ? { location: response.headers.location } : {}),
          });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`GitHub attachment download failed (${status})`));
          return;
        }
        const contentEncoding = response.headers["content-encoding"];
        if (contentEncoding && contentEncoding !== "identity") {
          response.destroy();
          reject(new Error("attachment response used unsupported content encoding"));
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && (declared <= 0 || declared > MAX_OBJECTIVE_ASSET_BYTES)) {
          response.destroy();
          reject(new Error("attachment Content-Length exceeds policy"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_OBJECTIVE_ASSET_BYTES)
            response.destroy(new Error("attachment exceeded byte policy"));
          else chunks.push(Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () =>
          total
            ? resolvePromise({ status, bytes: Buffer.concat(chunks, total) })
            : reject(new Error("attachment was empty")),
        );
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error("attachment download timed out")));
    req.once("error", reject);
    req.end();
  });
}
async function download(source: Extract<ObjectiveAssetImport, { kind: "github-attachment" }>) {
  const recognized = recognizedGitHubAttachment(source.url);
  let current = recognized.url;
  for (let count = 0; count <= 3; count++) {
    const response = await pinnedGet(current);
    if (response.bytes)
      return {
        bytes: response.bytes,
        name: safeFilename(source.name ?? basename(recognized.url.pathname)),
        attachmentId: recognized.attachmentId,
        host: recognized.host,
      };
    if (!response.location || count === 3) throw new Error("attachment redirect limit exceeded");
    const next = new URL(response.location, current);
    if (next.protocol !== "https:" || next.username || next.password || next.port || next.hash)
      throw new Error("unsafe attachment redirect");
    current = next;
  }
  throw new Error("attachment redirect limit exceeded");
}
async function readLocal(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error("local asset path must be absolute");
  const target = resolve(path);
  const parent = dirname(target);
  if ((await realpath(parent)) !== parent)
    throw new Error("local asset path contains a symlinked parent");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_OBJECTIVE_ASSET_BYTES)
      throw new Error("local asset must be a bounded regular file");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("asset truncated during capture");
      offset += read.bytesRead;
    }
    const after = await file.stat();
    const pathAfter = await lstat(target);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino
    )
      throw new Error("asset mutated or was replaced during capture");
    return bytes;
  } finally {
    await file.close();
  }
}
const knownExtensions = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["txt", "text/plain"],
]);

export async function importObjectiveAsset(
  source: ObjectiveAssetImport,
  metadata: ObjectiveAssetImportMetadata,
  options: { repositoryPrivate: boolean },
): Promise<{ descriptor: AssetDescriptor; bytes: Buffer }> {
  const visibility = AssetVisibilitySchema.parse(metadata.visibility);
  const rights = AssetRightsSchema.parse(metadata.rights);
  if (!options.repositoryPrivate && (visibility !== "public" || rights.basis === "unknown"))
    throw new Error("public repositories require public material with asserted rights");
  let bytes: Buffer;
  let displayName: string;
  let provenance: unknown;
  if (source.kind === "local-file") {
    bytes = await readLocal(source.path);
    displayName = safeFilename(source.name ?? basename(source.path));
    provenance = { kind: "local-file", importId: metadata.importId, originalName: displayName };
  } else {
    const result = await download(source);
    bytes = result.bytes;
    displayName = result.name;
    provenance = {
      kind: "github-attachment",
      importId: metadata.importId,
      originalName: displayName,
      host: result.host,
      attachmentId: result.attachmentId,
    };
  }
  assertNoSecretMaterial(bytes.toString("latin1"), "Objective asset bytes");
  const inspection = await inspectAssetBytes(bytes, {
    allowOpaque: metadata.allowOpaque ?? false,
    displayName,
  });
  const extension = displayName.includes(".") ? displayName.split(".").at(-1)!.toLowerCase() : "";
  const expected = knownExtensions.get(extension);
  if (expected && expected !== inspection.mediaType)
    throw new Error(
      `asset extension .${extension} conflicts with detected ${inspection.mediaType}`,
    );
  const content = {
    protocol: "clockgrove.factory/asset-content" as const,
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    inspection,
  };
  const parsedProvenance = AssetProvenanceSchema.parse(provenance);
  const assetId = assetDigest({
    contentDigest: content.digest,
    provenance: parsedProvenance,
    visibility,
    rights,
    displayName,
  });
  const core = {
    protocol: "clockgrove.factory/asset-descriptor" as const,
    content,
    displayName,
    provenance: parsedProvenance,
    visibility,
    rights,
    materializationPath: `assets/${assetId}/${inspection.status === "opaque" ? "asset.bin" : displayName}`,
  };
  return { descriptor: AssetDescriptorSchema.parse(withAssetDigest(core)), bytes };
}
