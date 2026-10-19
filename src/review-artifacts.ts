import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ContentRef,
  ContentStore,
  ValidationCommandReceipt,
} from "./contracts.js";
import { canonical } from "./canonical-json.js";
import { StepFault } from "./fault.js";
import { pinnedGitRaw } from "./process.js";
import { refuseUnknownFields } from "./unknown-fields.js";

const MAX_REVIEW_RECEIPT_BYTES = 1024 * 1024;
export const MAX_REVIEW_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_REVIEW_IMAGES = 8;
export const MAX_REVIEW_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_REVIEW_MATCHED_FILES = 256;
interface ReviewImageArtifactSelector {
  command: string;
  receipt: {
    stdoutPathField: string;
    stdoutSha256Field: string;
    maxBytes: number;
  };
  image: { file: string; sha256Field: string; maxBytes: number };
  candidate: { file: string; sha256Field: string };
}
interface ReviewTextFileSelector {
  file: string;
  mediaType: "text/plain" | "application/json";
  maxBytes: number;
}
/** Every regular file directly in the located directory whose name matches. */
interface ReviewTextMatchSelector {
  /** File name with exactly one `*` wildcard, such as `*.json`. */
  pattern: string;
  mediaType: ReviewTextFileSelector["mediaType"];
  /** Bound for each matched file. */
  maxBytes: number;
  /** Bound for all matched files together. */
  maxTotalBytes: number;
  maxFiles: number;
}
interface ReviewTextArtifactSelector {
  command: string;
  text: {
    /** Tracked exact-candidate source declaring this proof responsibility. */
    source: string;
    stdout?: { maxBytes: number };
    stderr?: { maxBytes: number };
    files?: ReviewTextFileSelector[];
    locator?: {
      /** Literal marker preceding a directory path within one stdout line. */
      stdoutPathPrefix: string;
      /** Exactly one of `files` or `match`. */
      files?: ReviewTextFileSelector[];
      match?: ReviewTextMatchSelector;
    };
  };
}
export type ReviewArtifactSelector =
  | ReviewImageArtifactSelector
  | ReviewTextArtifactSelector;
export interface ReviewImageArtifactEvidence {
  selectorIndex: number;
  commandIndex: number;
  command: string;
  treeSha: string;
  candidate: { path: string; sha256: string };
  receipt: { path: string; ref: ContentRef };
  image: { path: string; ref: ContentRef };
  complete: true;
}
interface ReviewTextArtifactEvidence {
  selectorIndex: number;
  commandIndex: number;
  command: string;
  treeSha: string;
  text: {
    source: { path: string; sha256: string };
    /** Controller-observed locator facts; absent when the selector has no locator. */
    locator?: {
      temporaryRoot: string;
      resolvedTemporaryRoot: string;
      stdoutPathPrefix: string;
      directory: string;
      resolvedDirectory: string;
    };
    bodies: {
      origin: "stdout" | "stderr" | "checkout-file" | "temporary-file";
      path: string;
      resolvedPath?: string;
      ref: ContentRef;
    }[];
  };
  complete: true;
}
export type ReviewArtifactEvidence =
  | ReviewImageArtifactEvidence
  | ReviewTextArtifactEvidence;
export function isReviewImageArtifact(
  value: ReviewArtifactEvidence,
): value is ReviewImageArtifactEvidence {
  return "image" in value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Review artifact declaration or evidence must be an object",
    );
  return value as Record<string, unknown>;
}
function path(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error("Review artifact path must be contained and relative");
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Review artifact SHA-256 is invalid");
}
function absolutePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Text artifact locator requires an absolute path");
}
function locatorPrefix(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      "Text artifact locator requires an explicit literal stdout prefix",
    );
}
function field(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error(
      "Review artifact selector requires a direct JSON field identifier",
    );
}
function bound(value: unknown, maximum: number): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  )
    throw new Error("Review artifact byte bound is invalid");
}
function matchPattern(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    value.split("*").length !== 2 ||
    /[/\\]/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      "Text artifact locator match pattern must be one file name with exactly one *",
    );
}
const matchesPattern = (pattern: string, name: string) => {
  const [head, tail] = pattern.split("*") as [string, string];
  return (
    name.length >= head.length + tail.length &&
    name.startsWith(head) &&
    name.endsWith(tail)
  );
};
/** A text locator whose marker the command did not print exactly once before an absolute path. */
export class LocatorMarkerFault extends StepFault {
  constructor(detail: string, fix: string) {
    super({ kind: "config", detail, fix });
    this.name = "LocatorMarkerFault";
  }
}

const describeSelector = (selector: ReviewArtifactSelector) =>
  "text" in selector
    ? `${JSON.stringify(selector.command)} (text ${JSON.stringify(selector.text.source)})`
    : `${JSON.stringify(selector.command)} (image ${JSON.stringify(selector.image.file)})`;

/**
 * Join the installation's selectors with a QA item's own. Identical selectors
 * collapse, so promoting a QA selection into the installation configuration
 * never duplicates it. What remains in conflict, or more than eight, is a
 * configuration fault naming every selector in force.
 */
export function joinReviewArtifactSelectors(
  installation: readonly ReviewArtifactSelector[] = [],
  selection: readonly ReviewArtifactSelector[] = [],
): ReviewArtifactSelector[] {
  const seen = new Set<string>();
  const joined = [...installation, ...selection].filter((selector) => {
    const identity = canonical(selector);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  try {
    assertReviewArtifactSelectors(joined);
  } catch (error) {
    throw new StepFault(
      {
        kind: "config",
        detail: `The installation reviewArtifacts and this item's reviewArtifactSelection cannot be used together (${error instanceof Error ? error.message : String(error)}); selectors in force: ${joined.map(describeSelector).join(", ")}`,
        fix: "Remove the conflicting selector from the installation reviewArtifacts or from the item's reviewArtifactSelection (at most eight distinct selectors in all), then resume",
      },
      { cause: error },
    );
  }
  return joined;
}

export function assertReviewArtifactSelectors(
  value: unknown,
): asserts value is ReviewArtifactSelector[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 8)
    throw new Error(
      "reviewArtifacts must contain at most eight explicit selectors",
    );
  const identities = new Set<string>();
  for (const raw of value) {
    const selector = object(raw);
    if (selector.text !== undefined) {
      assertTextSelector(selector);
      const identity = JSON.stringify(selector);
      if (identities.has(identity))
        throw new Error("Review artifact selectors duplicate an output");
      identities.add(identity);
      continue;
    }
    refuseUnknownFields(
      selector,
      ["command", "receipt", "image", "candidate"],
      "review artifact selector",
    );
    if (
      typeof selector.command !== "string" ||
      !selector.command.trim() ||
      selector.command.includes("\n") ||
      selector.command.includes("\r")
    )
      throw new Error("Review artifact command is invalid");
    const receipt = object(selector.receipt),
      image = object(selector.image),
      candidate = object(selector.candidate);
    refuseUnknownFields(
      receipt,
      ["stdoutPathField", "stdoutSha256Field", "maxBytes"],
      "review artifact receipt",
    );
    refuseUnknownFields(
      image,
      ["file", "sha256Field", "maxBytes"],
      "review artifact image",
    );
    refuseUnknownFields(
      candidate,
      ["file", "sha256Field"],
      "review artifact candidate",
    );
    field(receipt.stdoutPathField);
    field(receipt.stdoutSha256Field);
    field(image.sha256Field);
    field(candidate.sha256Field);
    path(image.file);
    path(candidate.file);
    bound(receipt.maxBytes, MAX_REVIEW_RECEIPT_BYTES);
    bound(image.maxBytes, MAX_REVIEW_IMAGE_BYTES);
    const identity = JSON.stringify([
      selector.command,
      receipt.stdoutPathField,
      image.file,
    ]);
    if (identities.has(identity))
      throw new Error("Review artifact selectors duplicate an output");
    identities.add(identity);
  }
}
function ref(value: unknown, mediaType: string, maximum: number): void {
  const reference = object(value);
  refuseUnknownFields(
    reference,
    ["digest", "bytes", "mediaType"],
    "review artifact content reference",
  );
  digest(reference.digest);
  bound(reference.bytes, maximum);
  if (reference.mediaType !== mediaType)
    throw new Error("Review artifact content MIME is invalid");
}
function assertTextSelector(selector: Record<string, unknown>): void {
  refuseUnknownFields(selector, ["command", "text"], "text artifact selector");
  if (
    typeof selector.command !== "string" ||
    !selector.command.trim() ||
    /[\r\n]/.test(selector.command)
  )
    throw new Error("Review artifact command is invalid");
  const text = object(selector.text);
  refuseUnknownFields(
    text,
    ["source", "stdout", "stderr", "files", "locator"],
    "text artifact selection",
  );
  path(text.source);
  let selected = false;
  for (const stream of ["stdout", "stderr"]) {
    if (text[stream] === undefined) continue;
    const selectedStream = object(text[stream]);
    refuseUnknownFields(selectedStream, ["maxBytes"], "text stream selection");
    bound(selectedStream.maxBytes, MAX_REVIEW_IMAGE_BYTES);
    selected = true;
  }
  const files = (value: unknown) => {
    if (!Array.isArray(value) || !value.length)
      throw new Error(
        "Text artifact files must be explicit nonempty selections",
      );
    const seen = new Set<string>();
    for (const raw of value) {
      const file = object(raw);
      refuseUnknownFields(
        file,
        ["file", "mediaType", "maxBytes"],
        "text artifact file selection",
      );
      path(file.file);
      if (
        !["text/plain", "application/json"].includes(file.mediaType as string)
      )
        throw new Error("Text artifact MIME is unsupported");
      bound(file.maxBytes, MAX_REVIEW_IMAGE_BYTES);
      if (seen.has(file.file as string))
        throw new Error("Text artifact file is duplicated");
      seen.add(file.file as string);
    }
  };
  if (text.files !== undefined) {
    files(text.files);
    selected = true;
  }
  if (text.locator !== undefined) {
    const locator = object(text.locator);
    refuseUnknownFields(
      locator,
      ["stdoutPathPrefix", "files", "match"],
      "text artifact locator",
    );
    locatorPrefix(locator.stdoutPathPrefix);
    if ((locator.files === undefined) === (locator.match === undefined))
      throw new Error(
        "Text artifact locator requires exactly one of files or match",
      );
    if (locator.files !== undefined) files(locator.files);
    else {
      const match = object(locator.match);
      refuseUnknownFields(
        match,
        ["pattern", "mediaType", "maxBytes", "maxTotalBytes", "maxFiles"],
        "text artifact locator match",
      );
      matchPattern(match.pattern);
      if (
        !["text/plain", "application/json"].includes(match.mediaType as string)
      )
        throw new Error("Text artifact MIME is unsupported");
      bound(match.maxBytes, MAX_REVIEW_IMAGE_BYTES);
      bound(match.maxTotalBytes, MAX_REVIEW_TOTAL_IMAGE_BYTES);
      if (
        !Number.isSafeInteger(match.maxFiles) ||
        (match.maxFiles as number) <= 0 ||
        (match.maxFiles as number) > MAX_REVIEW_MATCHED_FILES
      )
        throw new Error("Text artifact locator match file bound is invalid");
    }
    selected = true;
  }
  if (!selected) throw new Error("Text artifact selection contains no bodies");
}
export function assertReviewArtifacts(
  value: unknown,
  treeSha: string,
  commands: readonly ValidationCommandReceipt[],
): asserts value is ReviewArtifactEvidence[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_REVIEW_IMAGES)
    throw new Error("Retained review artifacts are invalid");
  const identities = new Set<string>();
  let totalImageBytes = 0;
  for (const raw of value) {
    const artifact = object(raw);
    refuseUnknownFields(
      artifact,
      [
        "selectorIndex",
        "commandIndex",
        "command",
        "treeSha",
        "candidate",
        "receipt",
        "image",
        "complete",
        "text",
      ],
      "retained review artifact",
    );
    if (
      !Number.isSafeInteger(artifact.selectorIndex) ||
      (artifact.selectorIndex as number) < 0 ||
      (artifact.selectorIndex as number) >= 8 ||
      !Number.isSafeInteger(artifact.commandIndex) ||
      (artifact.commandIndex as number) < 0 ||
      artifact.complete !== true ||
      artifact.treeSha !== treeSha
    )
      throw new Error("Retained review artifact identity is invalid");
    const command = commands[artifact.commandIndex as number];
    if (
      !command ||
      command.index !== artifact.commandIndex ||
      command.command !== artifact.command ||
      command.treeSha !== treeSha ||
      !command.passed ||
      command.exitCode !== 0
    )
      throw new Error(
        "Retained review artifact lacks its passing exact command",
      );
    if (artifact.text !== undefined) {
      refuseUnknownFields(
        artifact,
        [
          "selectorIndex",
          "commandIndex",
          "command",
          "treeSha",
          "text",
          "complete",
        ],
        "retained text artifact",
      );
      const text = object(artifact.text);
      refuseUnknownFields(
        text,
        ["source", "bodies", "locator"],
        "retained text artifact selection",
      );
      const source = object(text.source);
      refuseUnknownFields(
        source,
        ["path", "sha256"],
        "retained text artifact source",
      );
      path(source.path);
      digest(source.sha256);
      let directoryPath: string | undefined;
      if (text.locator !== undefined) {
        const locator = object(text.locator);
        refuseUnknownFields(
          locator,
          [
            "temporaryRoot",
            "resolvedTemporaryRoot",
            "stdoutPathPrefix",
            "directory",
            "resolvedDirectory",
          ],
          "retained text artifact locator",
        );
        for (const key of [
          "temporaryRoot",
          "resolvedTemporaryRoot",
          "directory",
          "resolvedDirectory",
        ])
          absolutePath(locator[key]);
        locatorPrefix(locator.stdoutPathPrefix);
        const root = locator.resolvedTemporaryRoot as string;
        const directory = locator.resolvedDirectory as string;
        if (resolve(root) !== root || resolve(directory) !== directory)
          throw new Error("Retained text locator resolved paths are invalid");
        directoryPath = relative(root, directory);
        path(directoryPath);
      }
      if (!Array.isArray(text.bodies) || !text.bodies.length)
        throw new Error("Retained text artifact has no complete bodies");
      const seen = new Set<string>();
      for (const raw of text.bodies) {
        const body = object(raw);
        refuseUnknownFields(
          body,
          ["origin", "path", "resolvedPath", "ref"],
          "retained text artifact body",
        );
        if (
          !["stdout", "stderr", "checkout-file", "temporary-file"].includes(
            body.origin as string,
          )
        )
          throw new Error("Retained text artifact origin is invalid");
        path(body.path);
        if (body.resolvedPath !== undefined) path(body.resolvedPath);
        if (directoryPath !== undefined && body.origin === "temporary-file") {
          if (
            !(body.path as string).startsWith(`${directoryPath}/`) ||
            body.resolvedPath === undefined ||
            !(body.resolvedPath as string).startsWith(`${directoryPath}/`)
          )
            throw new Error(
              "Retained text body differs from its locator directory",
            );
        }
        const reference = object(body.ref);
        refuseUnknownFields(
          reference,
          ["digest", "bytes", "mediaType"],
          "retained text artifact reference",
        );
        digest(reference.digest);
        if (
          !Number.isSafeInteger(reference.bytes) ||
          (reference.bytes as number) < 0 ||
          (reference.bytes as number) > MAX_REVIEW_IMAGE_BYTES ||
          !["text/plain", "application/json"].includes(
            reference.mediaType as string,
          )
        )
          throw new Error("Retained text artifact reference is invalid");
        totalImageBytes += reference.bytes as number;
        const key = JSON.stringify([body.origin, body.path]);
        if (seen.has(key))
          throw new Error("Retained text artifact body is duplicated");
        seen.add(key);
      }
      if (
        directoryPath !== undefined &&
        !text.bodies.some((body) => object(body).origin === "temporary-file")
      )
        throw new Error("Retained text artifact locator has no located bodies");
      if (totalImageBytes > MAX_REVIEW_TOTAL_IMAGE_BYTES)
        throw new Error(
          "Retained review artifacts exceed their aggregate byte bound",
        );
      const identity = `${artifact.selectorIndex}:${artifact.commandIndex}`;
      if (identities.has(identity))
        throw new Error("Retained review artifact identity is duplicated");
      identities.add(identity);
      continue;
    }
    const candidate = object(artifact.candidate),
      receipt = object(artifact.receipt),
      image = object(artifact.image);
    refuseUnknownFields(
      candidate,
      ["path", "sha256"],
      "retained review artifact candidate",
    );
    for (const entry of [receipt, image])
      refuseUnknownFields(
        entry,
        ["path", "ref"],
        "retained review artifact object",
      );
    path(candidate.path);
    digest(candidate.sha256);
    path(receipt.path);
    path(image.path);
    ref(receipt.ref, "application/json", MAX_REVIEW_RECEIPT_BYTES);
    ref(image.ref, "image/png", MAX_REVIEW_IMAGE_BYTES);
    totalImageBytes += (image.ref as ContentRef).bytes;
    if (totalImageBytes > MAX_REVIEW_TOTAL_IMAGE_BYTES)
      throw new Error(
        "Retained review images exceed their aggregate byte bound",
      );
    const identity = `${artifact.selectorIndex}:${artifact.commandIndex}`;
    if (identities.has(identity))
      throw new Error("Retained review artifact identity is duplicated");
    identities.add(identity);
  }
}
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

/** Verify a complete PNG container, including chunk lengths and CRCs; no visual acceptance is inferred. */
export function assertReviewImageBytes(bytes: Buffer): void {
  if (
    bytes.length > MAX_REVIEW_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Review artifact is not a bounded PNG");
  let offset = 8,
    header = false,
    data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) break;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++) {
      crc = (crc >>> 8) ^ pngCrcTable[(crc ^ bytes[i]!) & 255]!;
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(end - 4))
      throw new Error("Review artifact PNG chunk checksum is invalid");
    if (!header) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        bytes.readUInt32BE(offset + 8) === 0 ||
        bytes.readUInt32BE(offset + 12) === 0
      )
        throw new Error("Review artifact PNG header is invalid");
      header = true;
    } else if (type === "IHDR")
      throw new Error("Review artifact PNG header is duplicated");
    if (type === "IDAT") data = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !data)
        throw new Error("Review artifact PNG is incomplete");
      return;
    }
    offset = end;
  }
  throw new Error("Review artifact PNG is incomplete");
}
function readContained(
  root: string,
  relativePath: string,
  maximum: number,
  allowEmpty = false,
): Buffer {
  path(relativePath);
  const base = resolve(root);
  if (realpathSync(base) !== base || !lstatSync(base).isDirectory())
    throw new Error("Review artifact root is not a regular directory");
  let current = base;
  for (const [index, part] of relativePath.split("/").entries()) {
    current = join(current, part);
    const entry = lstatSync(current);
    if (
      entry.isSymbolicLink() ||
      (index < relativePath.split("/").length - 1
        ? !entry.isDirectory()
        : !entry.isFile())
    )
      throw new Error("Review artifact path is not a regular contained file");
  }
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size < 0 ||
      (stat.size === 0 && !allowEmpty) ||
      stat.size > maximum ||
      realpathSync(current) !== current
    )
      throw new Error(
        "Review artifact file exceeds its bound or path identity",
      );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (
      offset !== stat.size ||
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      fstatSync(fd).size !== stat.size
    )
      throw new Error("Review artifact file changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function textBytes(bytes: Buffer, mediaType: string): void {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes))
    throw new Error("Selected text artifact is not complete UTF-8");
  if (mediaType === "application/json") JSON.parse(value);
}
function sourceBinding(worktree: string, treeSha: string, file: string) {
  path(file);
  const entry = pinnedGitRaw(
    worktree,
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    treeSha,
    "--",
    file,
  ).toString("utf8");
  if (
    !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry) ||
    entry.slice(0, -1).split("\t")[1] !== file ||
    !entry.endsWith("\0")
  )
    throw new Error(
      "Text artifact source is not a tracked regular file in the exact tree",
    );
  return {
    path: file,
    sha256: hash(pinnedGitRaw(worktree, "show", `${treeSha}:${file}`)),
  };
}
/** Prospective selection narrows proof collection, never command authority. */
export function assertReviewArtifactSelection(
  value: unknown,
  commands: readonly string[],
): asserts value is ReviewArtifactSelector[] | undefined {
  assertReviewArtifactSelectors(value);
  for (const selector of value ?? [])
    if (!commands.includes(selector.command))
      throw new Error(
        "Review artifact selection is not an exact declared validation command",
      );
}
export function assertReviewArtifactSelectionSources(
  checkout: string,
  treeSha: string,
  selectors: readonly ReviewArtifactSelector[],
): void {
  for (const selector of selectors)
    sourceBinding(
      checkout,
      treeSha,
      "text" in selector ? selector.text.source : selector.candidate.file,
    );
}

/** Follow an explicitly selected dependency alias only within this owned checkout. */
function readSelectedText(root: string, file: string, maximum: number) {
  path(file);
  const base = realpathSync(root);
  const selected = join(base, file);
  const canonical = realpathSync(selected);
  const resolvedPath = relative(base, canonical);
  path(resolvedPath);
  const bytes = readContained(base, resolvedPath, maximum, true);
  if (realpathSync(selected) !== canonical)
    throw new Error("Selected text artifact alias changed while reading");
  return { bytes, resolvedPath };
}

async function captureTextArtifact(
  args: Parameters<typeof captureReviewArtifacts>[0],
  selector: ReviewTextArtifactSelector,
  selectorIndex: number,
): Promise<ReviewTextArtifactEvidence> {
  const source = sourceBinding(
    args.worktree,
    args.treeSha,
    selector.text.source,
  );
  const bodies: ReviewTextArtifactEvidence["text"]["bodies"] = [];
  let locator: ReviewTextArtifactEvidence["text"]["locator"];
  const append = async (
    body: Omit<(typeof bodies)[number], "ref">,
    bytes: Buffer,
    mediaType: string,
    maximum: number,
  ) => {
    if (bytes.length > maximum)
      throw new Error("Selected text artifact exceeds its admitted byte bound");
    textBytes(bytes, mediaType);
    bodies.push({
      ...body,
      ref: await retain(args.contentStore, bytes, mediaType),
    });
  };
  for (const stream of ["stdout", "stderr"] as const) {
    const selected = selector.text[stream];
    if (selected) {
      const original = args[`${stream}Bytes`];
      if (!original)
        throw new Error("Selected text stream lacks original subprocess bytes");
      await append(
        { origin: stream, path: stream },
        original,
        "text/plain",
        selected.maxBytes,
      );
    }
  }
  for (const selected of selector.text.files ?? []) {
    const { bytes, resolvedPath } = readSelectedText(
      args.worktree,
      selected.file,
      selected.maxBytes,
    );
    await append(
      { origin: "checkout-file", path: selected.file, resolvedPath },
      bytes,
      selected.mediaType,
      selected.maxBytes,
    );
  }
  if (selector.text.locator) {
    if (!args.temporaryRoot)
      throw new Error(
        "Text artifact locator lacks an owned validation temporary root",
      );
    const prefix = selector.text.locator.stdoutPathPrefix;
    if (!args.stdoutBytes || args.stdoutBytes.length > MAX_REVIEW_IMAGE_BYTES)
      throw new Error(
        "Text artifact locator lacks complete bounded original stdout",
      );
    textBytes(args.stdoutBytes, "text/plain");
    const markers = args.stdoutBytes
      .toString("utf8")
      .split(/\r?\n/)
      .flatMap((line) => line.split(prefix).slice(1));
    // The command and the selector disagree. Coding validation turns this
    // into the owning candidate's repairable fault; everywhere else it stays
    // a configuration fault that resumes once the operator fixes either.
    if (markers.length !== 1 || !isAbsolute(markers[0]!))
      throw new LocatorMarkerFault(
        `Text artifact locator requires one complete absolute path: the reviewArtifacts selector with command ${JSON.stringify(args.command)} and source ${JSON.stringify(selector.text.source)} expects exactly one stdout path after ${JSON.stringify(prefix)}, but ${markers.length === 1 ? "the path the command printed after it is not absolute" : `the command printed it ${markers.length === 0 ? "nowhere" : `${markers.length} times`}`}`,
        `Update or remove this reviewArtifacts selector in the installation configuration (or make its command print exactly one absolute path after ${JSON.stringify(prefix)}), then resume`,
      );
    const temporaryRoot = realpathSync(args.temporaryRoot);
    const directory = realpathSync(markers[0]!);
    const directoryPath = relative(temporaryRoot, directory);
    path(directoryPath);
    if (!lstatSync(directory).isDirectory())
      throw new Error("Text artifact locator is not a directory");
    absolutePath(args.temporaryRoot);
    absolutePath(markers[0]);
    locator = {
      temporaryRoot: args.temporaryRoot,
      resolvedTemporaryRoot: temporaryRoot,
      stdoutPathPrefix: prefix,
      directory: markers[0]!,
      resolvedDirectory: directory,
    };
    for (const selected of selector.text.locator.files ?? []) {
      const { bytes, resolvedPath } = readSelectedText(
        temporaryRoot,
        join(directoryPath, selected.file),
        selected.maxBytes,
      );
      // A located file, or what its alias resolves to, stays inside the
      // located directory, not merely inside the temporary root.
      if (!resolvedPath.startsWith(`${directoryPath}/`))
        throw new Error(
          "Text artifact locator file resolves outside its located directory",
        );
      await append(
        {
          origin: "temporary-file",
          path: join(directoryPath, selected.file),
          resolvedPath,
        },
        bytes,
        selected.mediaType,
        selected.maxBytes,
      );
    }
    const match = selector.text.locator.match;
    if (match) {
      // Sorted names keep bodies, review packets and digests deterministic.
      const entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => matchesPattern(match.pattern, entry.name))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (!entries.length)
        throw new Error("Text artifact locator match selected no files");
      if (entries.length > match.maxFiles)
        throw new Error("Text artifact locator match exceeds its file bound");
      let total = 0;
      for (const entry of entries) {
        // Matched symlinks, directories and other non-regular entries refuse.
        if (!entry.isFile())
          throw new Error(
            "Text artifact locator match is not a regular contained file",
          );
        const file = join(directoryPath, entry.name);
        const bytes = readContained(temporaryRoot, file, match.maxBytes, true);
        total += bytes.length;
        if (total > match.maxTotalBytes)
          throw new Error(
            "Text artifact locator match exceeds its total byte bound",
          );
        await append(
          { origin: "temporary-file", path: file, resolvedPath: file },
          bytes,
          match.mediaType,
          match.maxBytes,
        );
      }
    }
  }
  return {
    selectorIndex,
    commandIndex: args.commandIndex,
    command: args.command,
    treeSha: args.treeSha,
    text: { source, bodies, ...(locator && { locator }) },
    complete: true,
  };
}
async function retain(
  store: ContentStore,
  bytes: Buffer,
  mediaType: string,
): Promise<ContentRef> {
  const reference = await store.put(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { mediaType },
  );
  if (
    reference.digest !== hash(bytes) ||
    reference.bytes !== bytes.length ||
    reference.mediaType !== mediaType
  )
    throw new Error("Review artifact content retention changed its identity");
  await store.verify(reference);
  return reference;
}
export async function captureReviewArtifacts(args: {
  worktree: string;
  treeSha: string;
  commandIndex: number;
  command: string;
  stdout: string;
  stderr?: string;
  /** Actual subprocess bytes for explicitly selected text/control evidence. */
  stdoutBytes?: Buffer;
  stderrBytes?: Buffer;
  temporaryRoot?: string;
  selectors: readonly ReviewArtifactSelector[];
  contentStore: ContentStore;
}): Promise<ReviewArtifactEvidence[]> {
  const artifacts: ReviewArtifactEvidence[] = [];
  for (const [selectorIndex, selector] of args.selectors.entries()) {
    if (selector.command !== args.command) continue;
    if ("text" in selector) {
      artifacts.push(await captureTextArtifact(args, selector, selectorIndex));
      continue;
    }
    const line = args.stdout.trimEnd().split(/\r?\n/).at(-1);
    if (!line || Buffer.byteLength(line) > MAX_REVIEW_RECEIPT_BYTES)
      throw new Error(
        "Review artifact command lacks a bounded terminal JSON receipt locator",
      );
    const locator = object(JSON.parse(line));
    const receiptPath = locator[selector.receipt.stdoutPathField];
    path(receiptPath);
    const receiptDigest = locator[selector.receipt.stdoutSha256Field];
    digest(receiptDigest);
    const receiptBytes = readContained(
      args.worktree,
      receiptPath,
      selector.receipt.maxBytes,
    );
    if (hash(receiptBytes) !== receiptDigest)
      throw new Error(
        "Review artifact receipt digest differs from command stdout",
      );
    if (!Buffer.from(receiptBytes.toString("utf8")).equals(receiptBytes))
      throw new Error("Review artifact receipt is not complete UTF-8 JSON");
    const receipt = object(JSON.parse(receiptBytes.toString("utf8")));
    const candidateDigest = receipt[selector.candidate.sha256Field];
    digest(candidateDigest);
    const entry = pinnedGitRaw(
      args.worktree,
      "--literal-pathspecs",
      "ls-tree",
      "-z",
      args.treeSha,
      "--",
      selector.candidate.file,
    ).toString("utf8");
    if (
      !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry) ||
      entry.slice(0, -1).split("\t")[1] !== selector.candidate.file ||
      !entry.endsWith("\0")
    )
      throw new Error(
        "Review artifact candidate is not a tracked regular file in the exact tree",
      );
    const candidate = pinnedGitRaw(
      args.worktree,
      "show",
      `${args.treeSha}:${selector.candidate.file}`,
    );
    const checkoutCandidate = readContained(
      args.worktree,
      selector.candidate.file,
      Math.max(candidate.length, 1),
    );
    if (
      !candidate.equals(checkoutCandidate) ||
      hash(candidate) !== candidateDigest
    )
      throw new Error(
        "Review artifact receipt does not bind the unchanged exact candidate bytes",
      );
    const imagePath =
      dirname(receiptPath) === "."
        ? selector.image.file
        : `${dirname(receiptPath)}/${selector.image.file}`;
    const imageDigest = receipt[selector.image.sha256Field];
    digest(imageDigest);
    const imageBytes = readContained(
      args.worktree,
      imagePath,
      selector.image.maxBytes,
    );
    if (hash(imageBytes) !== imageDigest)
      throw new Error(
        "Review artifact image digest differs from its execution receipt",
      );
    assertReviewImageBytes(imageBytes);
    artifacts.push({
      selectorIndex,
      commandIndex: args.commandIndex,
      command: args.command,
      treeSha: args.treeSha,
      candidate: { path: selector.candidate.file, sha256: candidateDigest },
      receipt: {
        path: receiptPath,
        ref: await retain(args.contentStore, receiptBytes, "application/json"),
      },
      image: {
        path: imagePath,
        ref: await retain(args.contentStore, imageBytes, "image/png"),
      },
      complete: true,
    });
  }
  return artifacts;
}
