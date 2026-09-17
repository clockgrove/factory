import { fileTypeFromBuffer } from "file-type";
import {
  AssetInspectionSchema,
  MAX_OBJECTIVE_ASSET_DECODED_BYTES,
  MAX_OBJECTIVE_ASSET_FRAMES,
  MAX_OBJECTIVE_ASSET_PIXELS,
} from "./contracts.js";

export interface AssetValidationPolicy {
  allowOpaque: boolean;
  displayName: string;
}
interface AssetHandler {
  readonly id: string;
  readonly contract: number;
  supports(mediaType: string): boolean;
  validate(bytes: Buffer, mediaType: string, policy: AssetValidationPolicy): Promise<unknown>;
}
const RASTER_TYPES = new Map<string, "png" | "jpeg" | "webp" | "gif" | "tiff">([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/tiff", "tiff"],
]);
const rasterHandler: AssetHandler = {
  id: "sharp-raster",
  contract: 1,
  supports: (mediaType) => RASTER_TYPES.has(mediaType),
  async validate(bytes, mediaType) {
    // Keep the native decoder behind the registered raster handler so a host with
    // a broken optional binary gets an asset-specific refusal, not a dead MCP server.
    const sharp = (await import("sharp")).default;
    const decoder = sharp(bytes, {
      animated: true,
      failOn: "warning",
      limitInputPixels: MAX_OBJECTIVE_ASSET_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    const format = RASTER_TYPES.get(mediaType);
    const width = metadata.width;
    const height = metadata.pageHeight ?? metadata.height;
    const frames = metadata.pages ?? 1;
    const metadataChannels = metadata.channels ?? 4;
    if (
      !format ||
      !width ||
      !height ||
      frames < 1 ||
      frames > MAX_OBJECTIVE_ASSET_FRAMES ||
      width * height > MAX_OBJECTIVE_ASSET_PIXELS ||
      width * height * frames * metadataChannels > MAX_OBJECTIVE_ASSET_DECODED_BYTES
    )
      throw new Error("raster dimensions or frame count exceed policy");
    const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
    if (decoded.data.length > MAX_OBJECTIVE_ASSET_DECODED_BYTES)
      throw new Error("raster decoded bytes exceed policy");
    return {
      kind: "raster",
      format,
      width,
      height,
      frames,
      channels: decoded.info.channels,
      hasAlpha: metadata.hasAlpha ?? false,
      decodedBytes: decoded.data.length,
    };
  },
};
const utf8 = new TextDecoder("utf-8", { fatal: true });
const textHandler: AssetHandler = {
  id: "utf8-text",
  contract: 1,
  supports: (mediaType) => mediaType.startsWith("text/"),
  async validate(bytes, mediaType, policy) {
    const text = utf8.decode(bytes);
    if (text.includes("\0")) throw new Error("text asset contains NUL bytes");
    const controls = [...text].filter(
      (character) => character < " " && !"\n\r\t".includes(character),
    ).length;
    if (controls > Math.max(8, text.length / 100))
      throw new Error("text asset contains excessive control bytes");
    return {
      kind:
        mediaType === "text/markdown" || /\.md(?:own)?$/i.test(policy.displayName)
          ? "markdown"
          : "text",
      encoding: "utf-8",
      lines: text.split(/\r\n|\r|\n/).length,
    };
  },
};
const jsonHandler: AssetHandler = {
  id: "json",
  contract: 1,
  supports: (mediaType) => mediaType === "application/json",
  async validate(bytes) {
    const parsed: unknown = JSON.parse(utf8.decode(bytes));
    return {
      kind: "json",
      encoding: "utf-8",
      root: Array.isArray(parsed)
        ? "array"
        : parsed !== null && typeof parsed === "object"
          ? "object"
          : "scalar",
    };
  },
};
const handlers = [rasterHandler, textHandler, jsonHandler] as const;
export const assetHandlerContracts = handlers.map(({ id, contract }) => ({ id, contract }));
export function declaredAssetHandlerContract(mediaType: string) {
  assertPassiveAssetMediaType(mediaType);
  const selected = handlers.filter((handler) => handler.supports(mediaType));
  if (selected.length > 1) throw new Error(`ambiguous Objective asset handlers for ${mediaType}`);
  const handler = selected[0];
  return handler
    ? { descriptorClass: "semantic" as const, id: handler.id, contract: handler.contract }
    : { descriptorClass: "opaque" as const, id: "opaque-passive", contract: 1 };
}
export async function probeAssetHandlers() {
  const sharp = (await import("sharp")).default;
  return {
    handlers: assetHandlerContracts,
    rasterDecoder: {
      package: "sharp",
      version: sharp.versions.sharp,
      libvips: sharp.versions.vips,
    },
  };
}
const activeTypes = new Set([
  "application/x-executable",
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-elf",
  "application/wasm",
  "text/html",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
]);
const activeExtensions = new Set([
  "exe",
  "dll",
  "com",
  "msi",
  "appx",
  "elf",
  "wasm",
  "html",
  "htm",
  "svg",
  "js",
  "mjs",
  "cjs",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "command",
  "desktop",
  "hta",
  "jar",
  "lua",
  "php",
  "phar",
  "pl",
  "pm",
  "py",
  "pyw",
  "rb",
  "scr",
  "tcl",
  "vbe",
  "vbs",
  "wsf",
  "wsh",
]);

export function assertPassiveAssetMediaType(mediaType: string): void {
  if (activeTypes.has(mediaType))
    throw new Error(`active or executable Objective asset is refused (${mediaType})`);
}

/** Inspect bytes under an exact declared content type. Installed semantic
 * handlers validate that declaration directly; unsupported passive types stay
 * opaque and cannot acquire semantic meaning from sniffing. */
export async function inspectDeclaredAssetBytes(
  bytes: Buffer,
  declaredMediaType: string,
  policy: AssetValidationPolicy,
) {
  assertPassiveAssetMediaType(declaredMediaType);
  const selected = handlers.filter((handler) => handler.supports(declaredMediaType));
  if (selected.length > 1)
    throw new Error(`ambiguous Objective asset handlers for ${declaredMediaType}`);
  if (!selected.length) {
    const observed = await inspectAssetBytes(bytes, { ...policy, allowOpaque: true });
    if (observed.status === "semantic-valid" && observed.mediaType !== declaredMediaType)
      throw new Error(
        `declared ${declaredMediaType} bytes are recognized as ${observed.mediaType}`,
      );
    return AssetInspectionSchema.parse({
      status: "opaque",
      handlerId: "opaque-passive",
      handlerContract: 1,
      mediaType: declaredMediaType,
      metadata: { kind: "opaque", reason: "no registered declared-type semantic validator" },
    });
  }
  const handler = selected[0]!;
  return AssetInspectionSchema.parse({
    status: "semantic-valid",
    handlerId: handler.id,
    handlerContract: handler.contract,
    mediaType: declaredMediaType,
    metadata: await handler.validate(bytes, declaredMediaType, policy),
  });
}

export async function inspectAssetBytes(bytes: Buffer, policy: AssetValidationPolicy) {
  const claimedExtension = policy.displayName.includes(".")
    ? policy.displayName.split(".").at(-1)!.toLowerCase()
    : "";
  if (activeExtensions.has(claimedExtension))
    throw new Error(`active or executable Objective asset is refused (.${claimedExtension})`);
  const detected = await fileTypeFromBuffer(bytes);
  let mediaType = detected?.mime;
  if (!mediaType) {
    try {
      const text = utf8.decode(bytes);
      const controls = [...text].filter(
        (character) => character < " " && !"\n\r\t".includes(character),
      ).length;
      mediaType =
        !text.includes("\0") && controls <= Math.max(8, text.length / 100)
          ? /\.md(?:own)?$/i.test(policy.displayName)
            ? "text/markdown"
            : "text/plain"
          : "application/octet-stream";
    } catch {
      mediaType = "application/octet-stream";
    }
  }
  if (activeTypes.has(mediaType) || bytes.subarray(0, 2).toString("ascii") === "#!")
    throw new Error(`active or executable Objective asset is refused (${mediaType})`);
  const selected = handlers.filter((handler) => handler.supports(mediaType!));
  if (selected.length > 1) throw new Error(`ambiguous Objective asset handlers for ${mediaType}`);
  if (!selected.length) {
    if (!policy.allowOpaque)
      throw new Error(
        `no semantic asset handler is registered for ${mediaType}; explicitly allow opaque passive transport`,
      );
    return AssetInspectionSchema.parse({
      status: "opaque",
      handlerId: "opaque-passive",
      handlerContract: 1,
      mediaType,
      metadata: { kind: "opaque", reason: "no registered semantic validator" },
    });
  }
  const handler = selected[0]!;
  return AssetInspectionSchema.parse({
    status: "semantic-valid",
    handlerId: handler.id,
    handlerContract: handler.contract,
    mediaType,
    metadata: await handler.validate(bytes, mediaType, policy),
  });
}
