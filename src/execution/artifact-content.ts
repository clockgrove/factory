import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { assertNoSecretMaterial, gitSha, sha256Digest } from "../protocol/limits.js";

export const CONTENT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CONTENT_BYTES = 256 * 1024 * 1024;
export const MAX_CONTENT_FILE_BYTES = 100 * 1000 * 1000;
export const MAX_CONTENT_FILES = 5000;
export const ArtifactPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(path) &&
      path
        .split("/")
        .every(
          (part) => part !== "." && part !== ".." && part !== "" && part.toLowerCase() !== ".git",
        ),
    "unsafe artifact path",
  );
export const ContentChunkSchema = z
  .object({ digest: sha256Digest, bytes: z.number().int().positive().max(CONTENT_CHUNK_BYTES) })
  .strict();
export const ArtifactPayloadSchema = z
  .object({
    kind: z.literal("git-patch-chunks-v1"),
    digest: sha256Digest,
    bytes: z.number().int().positive().max(MAX_CONTENT_BYTES),
    chunks: z
      .array(ContentChunkSchema)
      .min(1)
      .max(MAX_CONTENT_BYTES / CONTENT_CHUNK_BYTES),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== value.bytes ||
      value.chunks.slice(0, -1).some((chunk) => chunk.bytes !== CONTENT_CHUNK_BYTES)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "payload chunk sizes do not match total",
      });
  });
export type ArtifactPayload = z.infer<typeof ArtifactPayloadSchema>;
const MediaSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/wasm",
  "application/zip",
  "audio/wav",
  "video/mp4",
  "unknown",
]);
export const ArtifactFileSchema = z
  .object({
    path: ArtifactPathSchema,
    action: z.enum(["write", "delete"]),
    mode: z.enum(["100644", "100755"]),
    bytes: z.number().int().nonnegative().max(MAX_CONTENT_FILE_BYTES),
    digest: sha256Digest,
    mediaType: MediaSchema,
    generated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.action === "delete" &&
      (value.bytes !== 0 ||
        value.digest !== sha256(Buffer.alloc(0)) ||
        value.mediaType !== "unknown")
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deleted file must have canonical empty content identity",
      });
  });
export const ArtifactFileManifestSchema = z
  .object({
    version: z.literal(1),
    baseTreeSha: gitSha,
    resultTreeSha: gitSha,
    files: z.array(ArtifactFileSchema).max(MAX_CONTENT_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.files.map((file) => file.path)).size !== value.files.length ||
      value.files.reduce((sum, file) => sum + file.bytes, 0) > MAX_CONTENT_BYTES
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate paths or excessive total file bytes",
      });
  });
export type ArtifactFileManifest = z.infer<typeof ArtifactFileManifestSchema>;
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export function knownMediaType(prefix: Buffer): z.infer<typeof MediaSchema> {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(prefix.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (prefix.subarray(0, 4).toString("ascii") === "RIFF") {
    if (prefix.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (prefix.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  }
  if (prefix.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (prefix.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    return "application/wasm";
  if (prefix.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) return "application/zip";
  if (prefix.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return "unknown";
}

/** No follow of any path component; caller roots must be trusted owned materializations. */
export async function regularContentPath(root: string, relative: string): Promise<string> {
  ArtifactPathSchema.parse(relative);
  let current = resolve(root);
  const rootInfo = await lstat(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("content root is not a real directory");
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
      throw new Error(`unsupported content file kind: ${relative}`);
  }
  return current;
}

export async function inspectContentFile(path: string, maxBytes = MAX_CONTENT_FILE_BYTES) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes)
      throw new Error("content file exceeds byte limit or is not regular");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    let tail = "";
    for (;;) {
      const result = await file.read(chunk, 0, chunk.length, bytes);
      if (!result.bytesRead) break;
      const data = chunk.subarray(0, result.bytesRead);
      bytes += data.length;
      if (bytes > maxBytes) throw new Error("content grew beyond byte limit");
      hash.update(data);
      if (!prefix.length) prefix = Buffer.from(data.subarray(0, 32));
      // Scan the actual bytes before transfer, including secrets crossing chunk boundaries.
      const text = tail + data.toString("latin1");
      assertNoSecretMaterial(text, "artifact content");
      tail = text.slice(-4096);
    }
    const after = await file.stat();
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("content changed while hashing");
    return {
      bytes,
      digest: hash.digest("hex"),
      mediaType: knownMediaType(prefix),
      mode: (before.mode & 0o111 ? "100755" : "100644") as "100644" | "100755",
    };
  } finally {
    await file.close();
  }
}

// Optimization only. Exact manifests + immutable GitHub transfer records remain authority.
const cachedChunks = new Map<string, string>();
const ownedRoots = new Set<string>();
const contentReferences = new Map<string, number>();
let allocationQueue: Promise<void> = Promise.resolve();
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
async function contentRoot(bytes: number): Promise<string> {
  const previous = allocationQueue;
  let unlock!: () => void;
  allocationQueue = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    return await allocateContentRoot(bytes);
  } finally {
    unlock();
  }
}
async function allocateContentRoot(bytes: number): Promise<string> {
  let existingBytes = 0;
  const roots = (await readdir(tmpdir())).filter((name) =>
    /^factory-content-[1-9][0-9]*-[A-Za-z0-9]+$/.test(name),
  );
  if (roots.length > 512)
    throw new Error("content cache directory bound exceeded; reconcile abandoned owned caches");
  for (const name of roots) {
    const root = join(tmpdir(), name);
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) continue;
    const marker = join(root, ".factory-content");
    let metadata: { pid: number; bytes: number };
    try {
      const markerInfo = await lstat(marker);
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 1024) continue;
      metadata = JSON.parse(await readFile(marker, "utf8"));
      if (
        !Number.isSafeInteger(metadata.pid) ||
        metadata.pid < 1 ||
        !name.startsWith(`factory-content-${metadata.pid}-`) ||
        !Number.isSafeInteger(metadata.bytes) ||
        metadata.bytes < 0 ||
        metadata.bytes > MAX_CONTENT_BYTES
      )
        continue;
    } catch {
      continue;
    }
    let absent = false;
    try {
      process.kill(metadata.pid, 0);
    } catch (error) {
      absent = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (absent) {
      // Cache is not authority. Dead-owner bytes are recoverable from the immutable ready ref.
      await rm(root, { recursive: true, force: true });
    } else existingBytes += metadata.bytes;
  }
  if (existingBytes + bytes > MAX_CACHE_BYTES)
    throw new Error(
      "bounded content cache is full; retain/recover current transfers before admitting more",
    );
  const root = await mkdtemp(join(tmpdir(), `factory-content-${process.pid}-`));
  await writeFile(join(root, ".factory-content"), JSON.stringify({ pid: process.pid, bytes }), {
    mode: 0o600,
    flag: "wx",
  });
  ownedRoots.add(root);
  return root;
}
export async function cachePayload(path: string): Promise<ArtifactPayload> {
  const identity = await inspectContentFile(path, MAX_CONTENT_BYTES);
  if (identity.bytes === 0) throw new Error("cannot externalize an empty patch");
  const root = await contentRoot(identity.bytes);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: ArtifactPayload["chunks"] = [];
  try {
    let offset = 0;
    while (offset < identity.bytes) {
      const bytes = Buffer.alloc(Math.min(CONTENT_CHUNK_BYTES, identity.bytes - offset));
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, offset + read);
        if (!result.bytesRead) throw new Error("payload truncated during capture");
        read += result.bytesRead;
      }
      const digest = sha256(bytes);
      const destination = join(root, digest);
      if (!cachedChunks.has(digest)) {
        await writeFile(destination, bytes, { mode: 0o600 });
        cachedChunks.set(digest, destination);
      }
      chunks.push({ digest, bytes: bytes.length });
      offset += bytes.length;
    }
    const payload = ArtifactPayloadSchema.parse({
      kind: "git-patch-chunks-v1",
      digest: identity.digest,
      bytes: identity.bytes,
      chunks,
    });
    await verifyPayload(payload);
    return payload;
  } catch (error) {
    await cleanupContentRoot(root);
    throw error;
  } finally {
    await file.close();
  }
}

export async function readContentChunk(chunk: z.infer<typeof ContentChunkSchema>): Promise<Buffer> {
  ContentChunkSchema.parse(chunk);
  const path = cachedChunks.get(chunk.digest);
  if (!path)
    throw new Error(
      `artifact content unavailable locally; recover immutable transfer ${chunk.digest}`,
    );
  const info = await inspectContentFile(path, CONTENT_CHUNK_BYTES);
  if (info.digest !== chunk.digest || info.bytes !== chunk.bytes)
    throw new Error("cached artifact chunk identity mismatch");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== chunk.bytes)
      throw new Error("cached artifact chunk changed");
    const bytes = Buffer.alloc(chunk.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("cached artifact chunk truncated");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      sha256(bytes) !== chunk.digest
    )
      throw new Error("cached artifact chunk changed");
    return bytes;
  } finally {
    await file.close();
  }
}

export async function restoreContentChunk(
  chunk: z.infer<typeof ContentChunkSchema>,
  bytes: Buffer,
): Promise<void> {
  ContentChunkSchema.parse(chunk);
  if (bytes.length !== chunk.bytes || sha256(bytes) !== chunk.digest)
    throw new Error("downloaded chunk size/digest mismatch");
  if (cachedChunks.has(chunk.digest)) {
    try {
      await readContentChunk(chunk);
      return;
    } catch {
      cachedChunks.delete(chunk.digest);
    }
  }
  const root = await contentRoot(chunk.bytes);
  const path = join(root, chunk.digest);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  cachedChunks.set(chunk.digest, path);
}

export async function materializePayload(
  payload: ArtifactPayload,
  destination: string,
): Promise<void> {
  ArtifactPayloadSchema.parse(payload);
  const file = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (const chunk of payload.chunks) {
      const data = await readContentChunk(chunk);
      hash.update(data);
      let offset = 0;
      while (offset < data.length) offset += (await file.write(data, offset)).bytesWritten;
      bytes += data.length;
    }
    if (bytes !== payload.bytes || hash.digest("hex") !== payload.digest)
      throw new Error("reassembled artifact digest mismatch");
  } catch (error) {
    await file.close();
    await rm(destination, { force: true });
    throw error;
  }
  await file.close();
}

export async function verifyPayload(payload: ArtifactPayload): Promise<void> {
  ArtifactPayloadSchema.parse(payload);
  const hash = createHash("sha256");
  let bytes = 0;
  let tail = "";
  for (const chunk of payload.chunks) {
    const data = await readContentChunk(chunk);
    const text = tail + data.toString("latin1");
    assertNoSecretMaterial(text, "artifact payload");
    tail = text.slice(-4096);
    hash.update(data);
    bytes += data.length;
  }
  if (bytes !== payload.bytes || hash.digest("hex") !== payload.digest)
    throw new Error("payload content identity mismatch");
}

export async function cleanupContentRoot(root: string): Promise<void> {
  if (
    !ownedRoots.has(root) ||
    !resolve(root).startsWith(`${resolve(tmpdir())}${sep}factory-content-`)
  )
    throw new Error("refusing unowned content cleanup");
  for (const [digest, path] of cachedChunks)
    if (dirname(path) === root) cachedChunks.delete(digest);
  await rm(root, { recursive: true, force: true });
  ownedRoots.delete(root);
}

/** Call only after all active consumers are finished; immutable GitHub records remain retained. */
export async function releaseAllArtifactContent(): Promise<void> {
  if ([...contentReferences.values()].some((count) => count > 0))
    throw new Error("active artifact content leases prevent global cleanup");
  for (const root of [...ownedRoots]) await cleanupContentRoot(root);
}

export async function releasePayload(payload: ArtifactPayload): Promise<void> {
  const roots = new Set(
    payload.chunks
      .map((chunk) => cachedChunks.get(chunk.digest))
      .filter((path): path is string => Boolean(path))
      .map(dirname),
  );
  for (const root of roots) {
    const digests = [...cachedChunks]
      .filter(([, path]) => dirname(path) === root)
      .map(([digest]) => digest);
    if (digests.every((digest) => !contentReferences.get(digest))) await cleanupContentRoot(root);
  }
}

/** Acquire immediately when an attempt/pipeline owns a payload; release only after all of its consumers drain. */
export function retainArtifactContent(payload: ArtifactPayload): () => Promise<void> {
  ArtifactPayloadSchema.parse(payload);
  const digests = [...new Set(payload.chunks.map((chunk) => chunk.digest))];
  for (const digest of digests)
    contentReferences.set(digest, (contentReferences.get(digest) ?? 0) + 1);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    for (const digest of digests) {
      const next = (contentReferences.get(digest) ?? 1) - 1;
      if (next) contentReferences.set(digest, next);
      else contentReferences.delete(digest);
    }
    await releasePayload(payload);
    // Duplicate captures can leave an empty, owned allocation after chunk de-duplication.
    for (const root of [...ownedRoots])
      if (![...cachedChunks.values()].some((path) => dirname(path) === root))
        await cleanupContentRoot(root);
  };
}

/** Revalidate full bytes after application, not only a worker/provider-supplied manifest. */
export async function verifyMaterializedFiles(
  root: string,
  manifest: ArtifactFileManifest,
): Promise<void> {
  ArtifactFileManifestSchema.parse(manifest);
  for (const file of manifest.files) {
    if (file.action === "delete") {
      try {
        await lstat(join(root, file.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`deleted artifact file still exists: ${file.path}`);
    }
    const observed = await inspectContentFile(await regularContentPath(root, file.path));
    if (
      observed.bytes !== file.bytes ||
      observed.digest !== file.digest ||
      observed.mode !== file.mode ||
      observed.mediaType !== file.mediaType
    )
      throw new Error(`materialized artifact identity mismatch: ${file.path}`);
  }
}

/** Bounded streaming copy for local/backend source and artifact channels. */
export async function copyBoundedContent(
  source: string,
  destination: string,
  maximum = MAX_CONTENT_BYTES,
): Promise<void> {
  const info = await inspectContentFile(source, maximum);
  await mkdir(dirname(destination), { recursive: true });
  let bytes = 0;
  await pipeline(
    createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }),
    new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maximum ? new Error("stream exceeded byte ceiling") : null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  await chmod(destination, 0o600);
  const copied = await inspectContentFile(destination, maximum);
  if (copied.digest !== info.digest || copied.bytes !== info.bytes)
    throw new Error("stream copy identity mismatch");
}
