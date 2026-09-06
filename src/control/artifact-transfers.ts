import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { z } from "zod";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NormalizedArtifactSchema,
  assertArtifactScope,
  verifyArtifact,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import {
  readContentChunk,
  restoreContentChunk,
  sha256,
  verifyPayload,
  retainCurrentArtifactPayload,
} from "../execution/artifact-content.js";
import { assertNoSecretMaterial, gitSha, sha256Digest } from "../protocol/limits.js";
import type { GitCommitObject } from "./lease.js";

const IdentitySchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    objective: z.number().int().positive(),
    workItem: z.number().int().positive(),
    attempt: z.number().int().positive(),
    runId: z.string().min(1).max(160),
    directorEpoch: z.number().int().nonnegative(),
    policyDigest: sha256Digest,
    baseSha: gitSha,
  })
  .strict();
export type ArtifactTransferIdentity = z.infer<typeof IdentitySchema>;
/** Internal qualification seam. No checkpoint can authorize execution or replace bytes. */
export interface ArtifactTransferIntentCheckpoint {
  identity: ArtifactTransferIdentity;
  artifactDigest: string;
  payloadDigest: string;
  payloadBytes: number;
  payloadChunks: number;
  intentRef: string;
  intentCommitSha: string;
  descriptorDigest: string;
  proveRetained(): Promise<void>;
}
const DescriptorSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/artifact-transfer-v1"),
    identity: IdentitySchema,
    artifact: NormalizedArtifactSchema,
    retention: z.literal("repository-audit"),
    chunks: z
      .array(
        z
          .object({
            digest: sha256Digest,
            bytes: z
              .number()
              .int()
              .positive()
              .max(4 * 1024 * 1024),
            oid: gitSha,
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
type Descriptor = z.infer<typeof DescriptorSchema>;
export interface ArtifactTransferStore {
  readRef(ref: string): Promise<string | null>;
  readCommit(oid: string): Promise<GitCommitObject>;
  readTreeEntry(treeOid: string, path: string): Promise<string | null>;
  readBlob(oid: string): Promise<Buffer>;
  createBlob(content: Buffer): Promise<string>;
  createTree(args: {
    baseTreeOid?: string;
    entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }>;
  }): Promise<string>;
  createCommit(args: { treeOid: string; parentOids: string[]; message: string }): Promise<string>;
  createRef(ref: string, oid: string): Promise<boolean>;
}
const gitBlobOid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
// Transfer descriptors additionally bind Git's OID. Pass only the exact content
// contract across the strict local-CAS boundary; do not relax that schema.
const contentChunk = ({ digest, bytes }: { digest: string; bytes: number }) => ({ digest, bytes });
const canonicalIdentity = (input: ArtifactTransferIdentity) =>
  IdentitySchema.parse({ ...input, repository: input.repository.toLowerCase() });
export const artifactTransferRef = (input: ArtifactTransferIdentity) =>
  `refs/clockgrove-factory/artifact-transfers/${sha256(JSON.stringify(canonicalIdentity(input)))}`;
const descriptorBytes = (descriptor: Descriptor) => {
  const bytes = Buffer.from(JSON.stringify(DescriptorSchema.parse(descriptor)));
  if (bytes.length > 8 * 1024 * 1024) throw new Error("artifact transfer descriptor exceeds 8 MiB");
  assertNoSecretMaterial(descriptor, "artifact transfer descriptor");
  return bytes;
};
const localDescriptorRoot = (identity: ArtifactTransferIdentity) =>
  join(
    tmpdir(),
    `factory-collected-${process.getuid?.() ?? "unknown"}-${sha256(JSON.stringify(canonicalIdentity(identity)))}`,
  );
async function assertLocalDescriptorRoot(root: string): Promise<void> {
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("collected-content cache is not private owned storage");
}
async function boundedPrivateRead(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > limit
    )
      throw new Error("invalid retained private content file");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("retained content was truncated");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error("retained content changed while reading");
    return bytes;
  } finally {
    await file.close();
  }
}
async function syncDirectory(root: string): Promise<void> {
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
let retentionQueue: Promise<void> = Promise.resolve();
async function retainLocalDescriptor(descriptor: Descriptor): Promise<void> {
  const previous = retentionQueue;
  let unlock!: () => void;
  retentionQueue = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    await retainLocalDescriptorLocked(descriptor);
  } finally {
    unlock();
  }
}
async function retainLocalDescriptorLocked(descriptor: Descriptor): Promise<void> {
  const root = localDescriptorRoot(descriptor.identity);
  const roots = (await readdir(tmpdir())).filter((name) =>
    name.startsWith(`factory-collected-${process.getuid?.() ?? "unknown"}-`),
  );
  if (roots.length >= 16 && !roots.includes(root.split("/").at(-1)!))
    throw new Error("pending artifact cache count bound reached; recover retained transfers first");
  // Persist collection identity before bulk admission. This is an artifact-data
  // availability marker, not authoritative runtime success or retry permission.
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertLocalDescriptorRoot(root);
  const marker = Buffer.from(
    JSON.stringify({
      protocol: "clockgrove.factory/incomplete-artifact-v1",
      identity: descriptor.identity,
      artifactDigest: descriptor.artifact.digest,
    }),
  );
  if (marker.length > 2048) throw new Error("collection identity marker exceeds 2 KiB");
  assertNoSecretMaterial(marker.toString("utf8"), "collection identity marker");
  const markerPath = join(root, "collection.json");
  try {
    const file = await open(markerPath, "wx", 0o600);
    try {
      await file.writeFile(marker);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await boundedPrivateRead(markerPath, 2048)).equals(marker))
      throw new Error("collection identity already binds different content");
  }
  await syncDirectory(root);
  await syncDirectory(tmpdir());
  let retainedBytes = 0;
  let currentRootBytes = 0;
  for (const name of roots) {
    const directory = join(tmpdir(), name);
    let children: string[];
    try {
      await assertLocalDescriptorRoot(directory);
      children = await readdir(directory);
    } catch (error) {
      // A different process may finish ready publication and remove its pending
      // cache after enumeration. Its absence is not this attempt's copy failure.
      if (directory !== root && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (children.length > 67) throw new Error("pending artifact cache entry bound exceeded");
    for (const child of children) {
      let bytes: number;
      try {
        bytes = (await lstat(join(directory, child))).size;
      } catch (error) {
        if (directory !== root && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      retainedBytes += bytes;
      if (directory === root) currentRootBytes += bytes;
    }
  }
  const additionalBytes =
    descriptor.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) +
    descriptorBytes(descriptor).length +
    marker.length;
  if (
    retainedBytes - currentRootBytes + Math.max(currentRootBytes, additionalBytes) >
    512 * 1024 * 1024
  )
    throw new Error("pending artifact cache byte bound reached; recover retained transfers first");
  const bytes = descriptorBytes(descriptor);
  const destination = join(root, "descriptor.json");
  try {
    const prior = await boundedPrivateRead(destination, 8 * 1024 * 1024);
    if (!prior.equals(bytes))
      throw new Error("collected-content identity already binds different artifact bytes");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const chunk of [
    ...new Map(descriptor.chunks.map((chunk) => [chunk.digest, chunk])).values(),
  ]) {
    const data = await readContentChunk(contentChunk(chunk));
    const path = join(root, chunk.digest);
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== chunk.bytes ||
        sha256(await boundedPrivateRead(path, chunk.bytes)) !== chunk.digest
      )
        throw new Error("retained local artifact chunk identity mismatch");
    }
  }
  const staging = join(root, `descriptor-${randomUUID()}.pending`);
  const file = await open(staging, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(staging, destination);
  await syncDirectory(root);
}
async function readLocalDescriptor(identity: ArtifactTransferIdentity): Promise<Descriptor | null> {
  const root = localDescriptorRoot(identity);
  try {
    await assertLocalDescriptorRoot(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let bytes: Buffer;
  try {
    const path = join(root, "descriptor.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
      throw new Error("invalid collected-content descriptor");
    bytes = await boundedPrivateRead(path, 8 * 1024 * 1024);
  } catch (error) {
    throw new ArtifactTransferIncompleteError(artifactTransferRef(identity), error);
  }
  const descriptor = DescriptorSchema.parse(JSON.parse(bytes.toString("utf8")));
  descriptorBytes(descriptor);
  verifyArtifact(descriptor.artifact);
  if (JSON.stringify(descriptor.identity) !== JSON.stringify(canonicalIdentity(identity)))
    throw new Error("collected-content cache provenance mismatch");
  if (descriptor.artifact.payload) retainCurrentArtifactPayload(descriptor.artifact.payload);
  for (const chunk of descriptor.chunks) {
    const path = join(root, chunk.digest);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== chunk.bytes)
      throw new ArtifactTransferIncompleteError(artifactTransferRef(identity));
    await restoreContentChunk(contentChunk(chunk), await boundedPrivateRead(path, chunk.bytes));
  }
  return descriptor;
}
export class ArtifactTransferIncompleteError extends Error {
  constructor(
    readonly ref: string,
    cause?: unknown,
  ) {
    super(
      `artifact transfer ${ref} is durable but incomplete; recover retained content before replacement execution`,
      { cause },
    );
    this.name = "ArtifactTransferIncompleteError";
  }
}

/** Read-only proof used while the original owned workspace is still available.
 * False means keep that source; a failed copy or unavailable transport never licenses deletion. */
export async function artifactRecoveryCopyAvailable(args: {
  store: ArtifactTransferStore;
  identity: ArtifactTransferIdentity;
  artifactDigest: string;
}): Promise<boolean> {
  try {
    const local = await readLocalDescriptor(args.identity);
    if (local) {
      if (local.artifact.digest !== args.artifactDigest) return false;
      if (local.artifact.payload) await verifyPayload(local.artifact.payload);
      return true;
    }
    const recovered = await recoverArtifactTransfer(args);
    return recovered?.digest === args.artifactDigest;
  } catch {
    return false;
  }
}

async function readDescriptor(
  store: ArtifactTransferStore,
  identity: ArtifactTransferIdentity,
  phase: "intent" | "ready",
) {
  const ref = `${artifactTransferRef(identity)}/${phase}`;
  const oid = await store.readRef(ref);
  if (!oid) return null;
  const commit = await store.readCommit(oid);
  if (commit.oid !== oid || (phase === "intent" && commit.parentOids.length !== 0))
    throw new Error("artifact transfer commit identity mismatch");
  const descriptorOid = await store.readTreeEntry(commit.treeOid, "artifact-transfer.json");
  if (!descriptorOid) throw new Error("artifact transfer ref lacks its descriptor");
  const bytes = await store.readBlob(descriptorOid);
  if (bytes.length > 8 * 1024 * 1024 || gitBlobOid(bytes) !== descriptorOid)
    throw new Error("artifact transfer descriptor blob identity mismatch");
  const descriptor = DescriptorSchema.parse(JSON.parse(bytes.toString("utf8")));
  descriptorBytes(descriptor);
  verifyArtifact(descriptor.artifact);
  if (
    JSON.stringify(descriptor.identity) !== JSON.stringify(canonicalIdentity(identity)) ||
    descriptor.artifact.baseSha !== identity.baseSha
  )
    throw new Error("artifact transfer provenance mismatch");
  const payload = descriptor.artifact.payload;
  if (
    JSON.stringify(descriptor.chunks.map(({ digest, bytes }) => ({ digest, bytes }))) !==
    JSON.stringify(payload?.chunks ?? [])
  )
    throw new Error("artifact transfer chunk manifest differs from payload");
  if (payload && !descriptor.artifact.fileManifest)
    throw new Error("externalized artifact lacks trusted file manifest");
  const message = `Factory artifact transfer ${phase}\n\nFactory-Artifact: ${descriptor.artifact.digest}\nFactory-Descriptor: ${sha256(bytes)}\nFactory-Retention: repository-audit`;
  if (commit.message.trim() !== message)
    throw new Error("artifact transfer lifecycle message mismatch");
  return { ref, oid, commit, descriptor };
}

/** No replacement work is authorized by an incomplete transfer or an unavailable chunk. */
export async function recoverArtifactTransfer(args: {
  store: ArtifactTransferStore;
  identity: ArtifactTransferIdentity;
}): Promise<NormalizedArtifact | null> {
  const ready = await readDescriptor(args.store, args.identity, "ready");
  if (ready?.descriptor.artifact.payload)
    retainCurrentArtifactPayload(ready.descriptor.artifact.payload);
  const intent = await readDescriptor(args.store, args.identity, "intent");
  if (!ready) {
    if (intent) throw new ArtifactTransferIncompleteError(intent.ref);
    return null;
  }
  if (
    !intent ||
    ready.commit.parentOids.length !== 1 ||
    ready.commit.parentOids[0] !== intent.oid ||
    JSON.stringify(ready.descriptor) !== JSON.stringify(intent.descriptor)
  )
    throw new Error("ready transfer does not bind its immutable upload intent");
  for (const chunk of ready.descriptor.chunks) {
    const oid = await args.store.readTreeEntry(ready.commit.treeOid, `chunks/${chunk.digest}`);
    if (oid !== chunk.oid) throw new Error("retained chunk tree identity mismatch");
    const bytes = await args.store.readBlob(oid);
    if (gitBlobOid(bytes) !== oid) throw new Error("retained Git blob identity mismatch");
    await restoreContentChunk(contentChunk(chunk), bytes);
  }
  if (ready.descriptor.artifact.payload) await verifyPayload(ready.descriptor.artifact.payload);
  return ready.descriptor.artifact;
}

/** Retry only the exact durable upload intent; never regenerate an artifact or launch execution. */
export async function resumeArtifactTransfer(args: {
  store: ArtifactTransferStore;
  identity: ArtifactTransferIdentity;
  allowedPaths: string[];
  assertCurrent: () => Promise<void>;
}): Promise<NormalizedArtifact | null> {
  const ready = await readDescriptor(args.store, args.identity, "ready");
  if (ready) return recoverArtifactTransfer(args);
  const intent = await readDescriptor(args.store, args.identity, "intent");
  if (!intent) {
    // Cache supplies producer bytes, never attempt/host authority: caller must freshly authorize this exact packet and reservation.
    await args.assertCurrent();
    const retained = await readLocalDescriptor(args.identity);
    if (!retained) return null;
    await persistArtifactTransfer({ store: args.store, identity: args.identity,
      allowedPaths: args.allowedPaths, assertCurrent: args.assertCurrent, artifact: retained.artifact });
    return recoverArtifactTransfer(args);
  }
  assertArtifactScope(intent.descriptor.artifact, args.allowedPaths);
  if (intent.descriptor.artifact.payload)
    retainCurrentArtifactPayload(intent.descriptor.artifact.payload);
  await args.assertCurrent();
  const retained = await readLocalDescriptor(args.identity);
  if (retained && JSON.stringify(retained) !== JSON.stringify(intent.descriptor))
    throw new Error("local retained artifact differs from durable intent");
  for (const chunk of intent.descriptor.chunks) {
    try {
      await readContentChunk(contentChunk(chunk));
      continue;
    } catch {
      /* An exact remote chunk may survive response loss. */
    }
    let bytes: Buffer;
    try {
      bytes = await args.store.readBlob(chunk.oid);
    } catch (error) {
      if ((error as { status?: number }).status === 404)
        throw new ArtifactTransferIncompleteError(intent.ref, error);
      throw error;
    }
    if (gitBlobOid(bytes) !== chunk.oid)
      throw new Error("resumed artifact chunk Git identity mismatch");
    await restoreContentChunk(contentChunk(chunk), bytes);
  }
  await persistArtifactTransfer({ store: args.store, identity: args.identity,
    allowedPaths: args.allowedPaths, assertCurrent: args.assertCurrent, artifact: intent.descriptor.artifact });
  return recoverArtifactTransfer(args);
}

/** All writes use the caller's existing paced store and fresh per-write lease/controller fence. */
export async function persistArtifactTransfer(args: {
  store: ArtifactTransferStore;
  identity: ArtifactTransferIdentity;
  artifact: NormalizedArtifact;
  allowedPaths: string[];
  assertCurrent: () => Promise<void>;
  /** Fresh collection only; resumeArtifactTransfer deliberately never supplies this callback. */
  afterIntent?: (checkpoint: ArtifactTransferIntentCheckpoint) => Promise<void>;
}): Promise<{ ref: string; commitSha: string; artifactDigest: string; lifecycle: "retained" }> {
  const artifact = verifyArtifact(args.artifact);
  assertArtifactScope(artifact, args.allowedPaths);
  const identity = canonicalIdentity(args.identity);
  if (artifact.baseSha !== identity.baseSha) throw new Error("artifact transfer base mismatch");
  if (artifact.payload && !artifact.fileManifest)
    throw new Error("externalized artifact requires trusted file manifest before upload");
  assertNoSecretMaterial(artifact, "artifact transfer");
  const chunks: Descriptor["chunks"] = [];
  // Validate every byte BEFORE even the intent write; model/remote claims never authorize upload.
  if (artifact.payload) {
    await verifyPayload(artifact.payload);
    for (const chunk of artifact.payload.chunks)
      chunks.push({ ...chunk, oid: gitBlobOid(await readContentChunk(chunk)) });
  }
  const descriptor: Descriptor = {
    protocol: "clockgrove.factory/artifact-transfer-v1",
    identity,
    artifact,
    retention: "repository-audit",
    chunks,
  };
  const bytes = descriptorBytes(descriptor);
  await retainLocalDescriptor(descriptor);
  const mutation = async <T>(operation: () => Promise<T>) => {
    await args.assertCurrent();
    return operation();
  };
  const save = async (phase: "intent" | "ready", parentOids: string[]) => {
    const existing = await readDescriptor(args.store, identity, phase);
    if (existing) {
      if (
        JSON.stringify(existing.descriptor) !== JSON.stringify(descriptor) ||
        JSON.stringify(existing.commit.parentOids) !== JSON.stringify(parentOids)
      )
        throw new Error("artifact transfer identity already binds different content");
      return existing;
    }
    const descriptorOid = await mutation(() => args.store.createBlob(bytes));
    if (descriptorOid !== gitBlobOid(bytes)) throw new Error("uploaded descriptor OID mismatch");
    const entries = [
      {
        path: "artifact-transfer.json",
        mode: "100644" as const,
        type: "blob" as const,
        sha: descriptorOid,
      },
      ...(phase === "ready"
        ? [...new Map(chunks.map((chunk) => [chunk.digest, chunk])).values()].map((chunk) => ({
            path: `chunks/${chunk.digest}`,
            mode: "100644" as const,
            type: "blob" as const,
            sha: chunk.oid,
          }))
        : []),
    ];
    const treeOid = await mutation(() => args.store.createTree({ entries }));
    const message = `Factory artifact transfer ${phase}\n\nFactory-Artifact: ${artifact.digest}\nFactory-Descriptor: ${sha256(bytes)}\nFactory-Retention: repository-audit`;
    const oid = await mutation(() => args.store.createCommit({ treeOid, parentOids, message }));
    const ref = `${artifactTransferRef(identity)}/${phase}`;
    try {
      await mutation(() => args.store.createRef(ref, oid));
    } catch (error) {
      if ((await args.store.readRef(ref)) !== oid) throw error;
    }
    const observed = await readDescriptor(args.store, identity, phase);
    if (
      !observed ||
      JSON.stringify(observed.descriptor) !== JSON.stringify(descriptor) ||
      JSON.stringify(observed.commit.parentOids) !== JSON.stringify(parentOids)
    )
      throw new Error("artifact transfer ref publication conflicted");
    return observed;
  };
  const intent = await save("intent", []);
  if (artifact.payload && args.afterIntent)
    await args.afterIntent({
      identity,
      artifactDigest: artifact.digest,
      payloadDigest: artifact.payload.digest,
      payloadBytes: artifact.payload.bytes,
      payloadChunks: artifact.payload.chunks.length,
      intentRef: intent.ref,
      intentCommitSha: intent.oid,
      descriptorDigest: sha256(bytes),
      proveRetained: async () => {
        await args.assertCurrent();
        const local = await readLocalDescriptor(identity);
        const observed = await readDescriptor(args.store, identity, "intent");
        if (!local || JSON.stringify(local) !== JSON.stringify(descriptor) ||
          !observed || observed.oid !== intent.oid ||
          JSON.stringify(observed.descriptor) !== JSON.stringify(descriptor) ||
          await args.store.readRef(`${artifactTransferRef(identity)}/ready`))
          throw new Error("qualification requires exact pending intent and complete private content");
        await verifyPayload(artifact.payload!);
      },
    });
  for (const chunk of [...new Map(chunks.map((chunk) => [chunk.digest, chunk])).values()]) {
    const data = await readContentChunk(contentChunk(chunk));
    const oid = await mutation(() => args.store.createBlob(data));
    if (oid !== chunk.oid) throw new Error("uploaded content chunk OID mismatch");
  }
  const ready = await save("ready", [intent.oid]);
  await assertLocalDescriptorRoot(localDescriptorRoot(identity));
  await rm(localDescriptorRoot(identity), { recursive: true, force: true });
  return {
    ref: ready.ref,
    commitSha: ready.oid,
    artifactDigest: artifact.digest,
    lifecycle: "retained",
  };
}
