import { createHash } from "node:crypto";
import { z } from "zod";
import { NormalizedArtifactSchema, assertArtifactScope, verifyArtifact, type NormalizedArtifact } from "../execution/artifacts.js";
import { readContentChunk, restoreContentChunk, sha256, verifyPayload } from "../execution/artifact-content.js";
import { assertNoSecretMaterial, gitSha, sha256Digest } from "../protocol/limits.js";
import type { GitCommitObject } from "./lease.js";

const IdentitySchema = z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  objective: z.number().int().positive(), workItem: z.number().int().positive(), attempt: z.number().int().positive(),
  runId: z.string().min(1).max(160), directorEpoch: z.number().int().nonnegative(), policyDigest: sha256Digest, baseSha: gitSha,
}).strict();
export type ArtifactTransferIdentity = z.infer<typeof IdentitySchema>;
const DescriptorSchema = z.object({ protocol: z.literal("clockgrove.factory/artifact-transfer-v1"),
  identity: IdentitySchema, artifact: NormalizedArtifactSchema,
  retention: z.literal("repository-audit"),
  chunks: z.array(z.object({ digest: sha256Digest, bytes: z.number().int().positive().max(4 * 1024 * 1024), oid: gitSha }).strict()).max(64),
}).strict();
type Descriptor = z.infer<typeof DescriptorSchema>;
export interface ArtifactTransferStore {
  readRef(ref: string): Promise<string | null>;
  readCommit(oid: string): Promise<GitCommitObject>;
  readTreeEntry(treeOid: string, path: string): Promise<string | null>;
  readBlob(oid: string): Promise<Buffer>;
  createBlob(content: Buffer): Promise<string>;
  createTree(args: { baseTreeOid?: string; entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> }): Promise<string>;
  createCommit(args: { treeOid: string; parentOids: string[]; message: string }): Promise<string>;
  createRef(ref: string, oid: string): Promise<boolean>;
}
const gitBlobOid = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const canonicalIdentity = (input: ArtifactTransferIdentity) => IdentitySchema.parse({ ...input, repository: input.repository.toLowerCase() });
export const artifactTransferRef = (input: ArtifactTransferIdentity) =>
  `refs/clockgrove-factory/artifact-transfers/${sha256(JSON.stringify(canonicalIdentity(input)))}`;
const descriptorBytes = (descriptor: Descriptor) => {
  const bytes = Buffer.from(JSON.stringify(DescriptorSchema.parse(descriptor)));
  if (bytes.length > 8 * 1024 * 1024) throw new Error("artifact transfer descriptor exceeds 8 MiB");
  assertNoSecretMaterial(descriptor, "artifact transfer descriptor");
  return bytes;
};
export class ArtifactTransferIncompleteError extends Error {
  constructor(readonly ref: string, cause?: unknown) {
    super(`artifact transfer ${ref} is durable but incomplete; recover retained content before replacement execution`, { cause });
    this.name = "ArtifactTransferIncompleteError";
  }
}

async function readDescriptor(store: ArtifactTransferStore, identity: ArtifactTransferIdentity, phase: "intent" | "ready") {
  const ref = `${artifactTransferRef(identity)}/${phase}`;
  const oid = await store.readRef(ref);
  if (!oid) return null;
  const commit = await store.readCommit(oid);
  const descriptorOid = await store.readTreeEntry(commit.treeOid, "artifact-transfer.json");
  if (!descriptorOid) throw new Error("artifact transfer ref lacks its descriptor");
  const bytes = await store.readBlob(descriptorOid);
  if (bytes.length > 8 * 1024 * 1024 || gitBlobOid(bytes) !== descriptorOid) throw new Error("artifact transfer descriptor blob identity mismatch");
  const descriptor = DescriptorSchema.parse(JSON.parse(bytes.toString("utf8")));
  descriptorBytes(descriptor);
  verifyArtifact(descriptor.artifact);
  if (JSON.stringify(descriptor.identity) !== JSON.stringify(canonicalIdentity(identity)) || descriptor.artifact.baseSha !== identity.baseSha)
    throw new Error("artifact transfer provenance mismatch");
  const payload = descriptor.artifact.payload;
  if (JSON.stringify(descriptor.chunks.map(({ digest, bytes }) => ({ digest, bytes }))) !== JSON.stringify(payload?.chunks ?? []))
    throw new Error("artifact transfer chunk manifest differs from payload");
  if (payload && !descriptor.artifact.fileManifest) throw new Error("externalized artifact lacks trusted file manifest");
  const message = `Factory artifact transfer ${phase}\n\nFactory-Artifact: ${descriptor.artifact.digest}\nFactory-Descriptor: ${sha256(bytes)}\nFactory-Retention: repository-audit`;
  if (commit.message.trim() !== message) throw new Error("artifact transfer lifecycle message mismatch");
  return { ref, oid, commit, descriptor };
}

/** No replacement work is authorized by an incomplete transfer or an unavailable chunk. */
export async function recoverArtifactTransfer(args: { store: ArtifactTransferStore; identity: ArtifactTransferIdentity }): Promise<NormalizedArtifact | null> {
  const ready = await readDescriptor(args.store, args.identity, "ready");
  const intent = await readDescriptor(args.store, args.identity, "intent");
  if (!ready) {
    if (intent) throw new ArtifactTransferIncompleteError(intent.ref);
    return null;
  }
  if (!intent || ready.commit.parentOids.length !== 1 || ready.commit.parentOids[0] !== intent.oid ||
      JSON.stringify(ready.descriptor) !== JSON.stringify(intent.descriptor)) throw new Error("ready transfer does not bind its immutable upload intent");
  for (const chunk of ready.descriptor.chunks) {
    const oid = await args.store.readTreeEntry(ready.commit.treeOid, `chunks/${chunk.digest}`);
    if (oid !== chunk.oid) throw new Error("retained chunk tree identity mismatch");
    const bytes = await args.store.readBlob(oid);
    if (gitBlobOid(bytes) !== oid) throw new Error("retained Git blob identity mismatch");
    await restoreContentChunk(chunk, bytes);
  }
  if (ready.descriptor.artifact.payload) await verifyPayload(ready.descriptor.artifact.payload);
  return ready.descriptor.artifact;
}

/** All writes use the caller's existing paced store and fresh per-write lease/controller fence. */
export async function persistArtifactTransfer(args: { store: ArtifactTransferStore; identity: ArtifactTransferIdentity;
  artifact: NormalizedArtifact; allowedPaths: string[]; assertCurrent: () => Promise<void> }): Promise<{ ref: string; commitSha: string; artifactDigest: string; lifecycle: "retained" }> {
  const artifact = verifyArtifact(args.artifact);
  assertArtifactScope(artifact, args.allowedPaths);
  const identity = canonicalIdentity(args.identity);
  if (artifact.baseSha !== identity.baseSha) throw new Error("artifact transfer base mismatch");
  if (artifact.payload && !artifact.fileManifest) throw new Error("externalized artifact requires trusted file manifest before upload");
  assertNoSecretMaterial(artifact, "artifact transfer");
  const chunks: Descriptor["chunks"] = [];
  // Validate every byte BEFORE even the intent write; model/remote claims never authorize upload.
  if (artifact.payload) {
    await verifyPayload(artifact.payload);
    for (const chunk of artifact.payload.chunks) chunks.push({ ...chunk, oid: gitBlobOid(await readContentChunk(chunk)) });
  }
  const descriptor: Descriptor = { protocol: "clockgrove.factory/artifact-transfer-v1", identity, artifact, retention: "repository-audit", chunks };
  const bytes = descriptorBytes(descriptor);
  const mutation = async <T>(operation: () => Promise<T>) => { await args.assertCurrent(); return operation(); };
  const save = async (phase: "intent" | "ready", parentOids: string[]) => {
    const existing = await readDescriptor(args.store, identity, phase);
    if (existing) {
      if (JSON.stringify(existing.descriptor) !== JSON.stringify(descriptor) || JSON.stringify(existing.commit.parentOids) !== JSON.stringify(parentOids))
        throw new Error("artifact transfer identity already binds different content");
      return existing;
    }
    const descriptorOid = await mutation(() => args.store.createBlob(bytes));
    if (descriptorOid !== gitBlobOid(bytes)) throw new Error("uploaded descriptor OID mismatch");
    const entries = [{ path: "artifact-transfer.json", mode: "100644" as const, type: "blob" as const, sha: descriptorOid },
      ...(phase === "ready" ? [...new Map(chunks.map((chunk) => [chunk.digest, chunk])).values()].map((chunk) => ({ path: `chunks/${chunk.digest}`, mode: "100644" as const, type: "blob" as const, sha: chunk.oid })) : [])];
    const treeOid = await mutation(() => args.store.createTree({ entries }));
    const message = `Factory artifact transfer ${phase}\n\nFactory-Artifact: ${artifact.digest}\nFactory-Descriptor: ${sha256(bytes)}\nFactory-Retention: repository-audit`;
    const oid = await mutation(() => args.store.createCommit({ treeOid, parentOids, message }));
    const ref = `${artifactTransferRef(identity)}/${phase}`;
    try { await mutation(() => args.store.createRef(ref, oid)); } catch (error) {
      if (await args.store.readRef(ref) !== oid) throw error;
    }
    const observed = await readDescriptor(args.store, identity, phase);
    if (!observed || JSON.stringify(observed.descriptor) !== JSON.stringify(descriptor) || JSON.stringify(observed.commit.parentOids) !== JSON.stringify(parentOids))
      throw new Error("artifact transfer ref publication conflicted");
    return observed;
  };
  const intent = await save("intent", []);
  for (const chunk of [...new Map(chunks.map((chunk) => [chunk.digest, chunk])).values()]) {
    const data = await readContentChunk(chunk);
    const oid = await mutation(() => args.store.createBlob(data));
    if (oid !== chunk.oid) throw new Error("uploaded content chunk OID mismatch");
  }
  const ready = await save("ready", [intent.oid]);
  return { ref: ready.ref, commitSha: ready.oid, artifactDigest: artifact.digest, lifecycle: "retained" };
}
