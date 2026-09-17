import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ArtifactPayloadSchema,
  readContentChunk,
  restoreContentChunk,
  verifyPayload,
} from "../execution/artifact-content.js";
import { gitSha, safeId, sha256Digest } from "../protocol/limits.js";
import type { GitCommitObject } from "./lease.js";

export const ContentTransferIdentitySchema = z
  .object({
    domain: z.enum(["worker-artifact", "objective-asset", "produced-asset"]),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    objective: z.number().int().positive(),
    baseSha: gitSha,
    requestId: safeId,
    subjectDigest: sha256Digest,
  })
  .strict()
  .transform((value) => ({ ...value, repository: value.repository.toLowerCase() }));
const DescriptorSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/content-transfer"),
    identity: ContentTransferIdentitySchema,
    payload: ArtifactPayloadSchema,
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
export type ContentTransferIdentity = z.input<typeof ContentTransferIdentitySchema>;
export interface ContentTransferStore {
  readRef(ref: string): Promise<string | null>;
  readCommit(oid: string): Promise<GitCommitObject>;
  readTreeEntry(treeOid: string, path: string): Promise<string | null>;
  readBlob(oid: string): Promise<Buffer>;
  createBlob(content: Buffer): Promise<string>;
  createTree(args: {
    entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }>;
  }): Promise<string>;
  createCommit(args: { treeOid: string; parentOids: string[]; message: string }): Promise<string>;
  createRef(ref: string, oid: string): Promise<boolean>;
}
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const gitOid = (value: Buffer) =>
  createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
export const contentTransferRef = (identity: ContentTransferIdentity) =>
  `refs/clockgrove-factory/content-transfers/${sha256(JSON.stringify(ContentTransferIdentitySchema.parse(identity)))}`;

async function readPhase(
  store: ContentTransferStore,
  identity: ContentTransferIdentity,
  phase: "intent" | "ready",
) {
  const ref = `${contentTransferRef(identity)}/${phase}`;
  const oid = await store.readRef(ref);
  if (!oid) return null;
  const commit = await store.readCommit(oid);
  if (commit.oid !== oid) throw new Error("content transfer commit identity mismatch");
  const descriptorOid = await store.readTreeEntry(commit.treeOid, "content-transfer.json");
  if (!descriptorOid) throw new Error("content transfer descriptor is missing");
  const bytes = await store.readBlob(descriptorOid);
  if (gitOid(bytes) !== descriptorOid)
    throw new Error("content transfer descriptor Git identity mismatch");
  const descriptor = DescriptorSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    JSON.stringify(descriptor.identity) !==
    JSON.stringify(ContentTransferIdentitySchema.parse(identity))
  )
    throw new Error("content transfer authority mismatch");
  const expectedMessage = `Factory content transfer ${phase}\n\nFactory-Content: ${descriptor.payload.digest}`;
  if (
    commit.message !== expectedMessage ||
    (phase === "intent" ? commit.parentOids.length !== 0 : commit.parentOids.length !== 1)
  )
    throw new Error(`content transfer ${phase} lifecycle proof mismatch`);
  if (
    descriptor.chunks.length !== descriptor.payload.chunks.length ||
    descriptor.chunks.some((chunk, index) => {
      const payloadChunk = descriptor.payload.chunks[index];
      return chunk.digest !== payloadChunk?.digest || chunk.bytes !== payloadChunk.bytes;
    })
  )
    throw new Error("content transfer descriptor chunks differ from its payload");
  return { ref, oid, commit, descriptor };
}
async function publish(args: {
  store: ContentTransferStore;
  ref: string;
  treeOid: string;
  parents: string[];
  message: string;
  assertCurrent(): Promise<void>;
}) {
  const validateWinner = async (oid: string) => {
    const commit = await args.store.readCommit(oid);
    if (
      commit.treeOid !== args.treeOid ||
      JSON.stringify(commit.parentOids) !== JSON.stringify(args.parents) ||
      commit.message !== args.message
    )
      throw new Error("content transfer ref publication conflicted");
    return oid;
  };
  const existing = await args.store.readRef(args.ref);
  if (existing) return validateWinner(existing);
  await args.assertCurrent();
  const oid = await args.store.createCommit({
    treeOid: args.treeOid,
    parentOids: args.parents,
    message: args.message,
  });
  await args.assertCurrent();
  let created = false;
  try {
    created = await args.store.createRef(args.ref, oid);
  } catch {
    /* reconcile below */
  }
  if (created) return validateWinner(oid);
  const winner = await args.store.readRef(args.ref);
  if (!winner) throw new Error("content transfer publication is unresolved");
  return validateWinner(winner);
}
export async function persistContentTransfer(args: {
  store: ContentTransferStore;
  identity: ContentTransferIdentity;
  payload: z.infer<typeof ArtifactPayloadSchema>;
  assertCurrent(): Promise<void>;
  afterIntent?: () => Promise<void>;
}) {
  const identity = ContentTransferIdentitySchema.parse(args.identity);
  const payload = ArtifactPayloadSchema.parse(args.payload);
  if (payload.digest !== identity.subjectDigest)
    throw new Error("content transfer subject digest mismatch");
  await verifyPayload(payload);
  const chunks = [];
  for (const chunk of payload.chunks)
    chunks.push({
      ...chunk,
      oid: gitOid(await readContentChunk({ digest: chunk.digest, bytes: chunk.bytes })),
    });
  const descriptor = DescriptorSchema.parse({
    protocol: "clockgrove.factory/content-transfer",
    identity,
    payload,
    chunks,
  });
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  await args.assertCurrent();
  const descriptorOid = await args.store.createBlob(descriptorBytes);
  if (descriptorOid !== gitOid(descriptorBytes))
    throw new Error("content transfer descriptor upload mismatch");
  // Upload exact immutable blobs before publishing intent. A process restart can then
  // finish from the intent's authenticated OIDs without the original source or cache.
  for (const chunk of chunks) {
    await args.assertCurrent();
    const observed = await args.store.createBlob(
      await readContentChunk({ digest: chunk.digest, bytes: chunk.bytes }),
    );
    if (observed !== chunk.oid) throw new Error("content transfer chunk upload mismatch");
  }
  await args.assertCurrent();
  const intentTree = await args.store.createTree({
    entries: [{ path: "content-transfer.json", mode: "100644", type: "blob", sha: descriptorOid }],
  });
  const base = contentTransferRef(identity);
  const intentCommit = await publish({
    store: args.store,
    ref: `${base}/intent`,
    treeOid: intentTree,
    parents: [],
    message: `Factory content transfer intent\n\nFactory-Content: ${payload.digest}`,
    assertCurrent: args.assertCurrent,
  });
  await args.afterIntent?.();
  const entries = [
    {
      path: "content-transfer.json",
      mode: "100644" as const,
      type: "blob" as const,
      sha: descriptorOid,
    },
  ];
  for (const chunk of chunks) {
    entries.push({ path: `chunks/${chunk.digest}`, mode: "100644", type: "blob", sha: chunk.oid });
  }
  await args.assertCurrent();
  const readyTree = await args.store.createTree({ entries });
  const readyCommit = await publish({
    store: args.store,
    ref: `${base}/ready`,
    treeOid: readyTree,
    parents: [intentCommit],
    message: `Factory content transfer ready\n\nFactory-Content: ${payload.digest}`,
    assertCurrent: args.assertCurrent,
  });
  return { transferRef: base, intentCommit, readyCommit, payload };
}
export async function resumeContentTransfer(args: {
  store: ContentTransferStore;
  identity: ContentTransferIdentity;
  assertCurrent(): Promise<void>;
}) {
  const identity = ContentTransferIdentitySchema.parse(args.identity);
  const ready = await readPhase(args.store, identity, "ready");
  if (ready) return recoverContentTransfer({ store: args.store, identity });
  const intent = await readPhase(args.store, identity, "intent");
  if (!intent) return null;
  const descriptorBytes = Buffer.from(JSON.stringify(intent.descriptor));
  const descriptorOid = gitOid(descriptorBytes);
  const entries = [
    {
      path: "content-transfer.json",
      mode: "100644" as const,
      type: "blob" as const,
      sha: descriptorOid,
    },
  ];
  for (const chunk of intent.descriptor.chunks) {
    const bytes = await args.store.readBlob(chunk.oid);
    if (
      gitOid(bytes) !== chunk.oid ||
      sha256(bytes) !== chunk.digest ||
      bytes.length !== chunk.bytes
    )
      throw new Error("content transfer restart chunk identity mismatch");
    entries.push({ path: `chunks/${chunk.digest}`, mode: "100644", type: "blob", sha: chunk.oid });
  }
  await args.assertCurrent();
  const readyTree = await args.store.createTree({ entries });
  const base = contentTransferRef(identity);
  const readyCommit = await publish({
    store: args.store,
    ref: `${base}/ready`,
    treeOid: readyTree,
    parents: [intent.oid],
    message: `Factory content transfer ready\n\nFactory-Content: ${intent.descriptor.payload.digest}`,
    assertCurrent: args.assertCurrent,
  });
  for (const chunk of intent.descriptor.chunks)
    await restoreContentChunk(
      { digest: chunk.digest, bytes: chunk.bytes },
      await args.store.readBlob(chunk.oid),
    );
  await verifyPayload(intent.descriptor.payload);
  return {
    transferRef: base,
    intentCommit: intent.oid,
    readyCommit,
    payload: intent.descriptor.payload,
  };
}
export async function recoverContentTransfer(args: {
  store: ContentTransferStore;
  identity: ContentTransferIdentity;
}) {
  const ready = await readPhase(args.store, args.identity, "ready");
  const intent = await readPhase(args.store, args.identity, "intent");
  if (!ready) {
    if (intent) throw new Error(`content transfer is incomplete: ${intent.ref}`);
    return null;
  }
  if (
    !intent ||
    ready.commit.parentOids.length !== 1 ||
    ready.commit.parentOids[0] !== intent.oid ||
    JSON.stringify(ready.descriptor) !== JSON.stringify(intent.descriptor)
  )
    throw new Error("content transfer ready does not bind its intent");
  for (const chunk of ready.descriptor.chunks) {
    const oid = await args.store.readTreeEntry(ready.commit.treeOid, `chunks/${chunk.digest}`);
    if (oid !== chunk.oid) throw new Error("content transfer chunk tree mismatch");
    const bytes = await args.store.readBlob(oid);
    if (gitOid(bytes) !== oid) throw new Error("content transfer chunk Git identity mismatch");
    await restoreContentChunk({ digest: chunk.digest, bytes: chunk.bytes }, bytes);
  }
  await verifyPayload(ready.descriptor.payload);
  return {
    transferRef: contentTransferRef(args.identity),
    intentCommit: intent.oid,
    readyCommit: ready.oid,
    payload: ready.descriptor.payload,
  };
}
