import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import Ajv from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fixedAddressLookup,
  importObjectiveAsset,
  recognizedGitHubAttachment,
} from "../src/assets/import.js";
import { inspectAssetBytes } from "../src/assets/handlers.js";
import { materializeObjectiveAssets } from "../src/assets/materialize.js";
import {
  persistObjectiveAssetManifest,
  readObjectiveAssetManifest,
  readObjectiveAssetManifestByRequest,
  type ObjectiveAssetStore,
} from "../src/assets/storage.js";
import { cachePayloadBytes, releaseAllArtifactContent } from "../src/execution/artifact-content.js";
import type { GitCommitObject } from "../src/control/lease.js";
import {
  contentTransferRef,
  persistContentTransfer,
  resumeContentTransfer,
} from "../src/control/content-transfers.js";
import { ObjectiveAssetManifestSchema } from "../src/assets/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  await releaseAllArtifactContent();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const oid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function memoryStore() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, GitCommitObject>();
  const refs = new Map<string, string>();
  const store: ObjectiveAssetStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (id) => commits.get(id)!,
    readTreeEntry: async (tree, path) => trees.get(tree)?.get(path) ?? null,
    readBlob: async (id) => {
      const bytes = blobs.get(id);
      if (!bytes) throw Object.assign(new Error("missing"), { status: 404 });
      return Buffer.from(bytes);
    },
    createBlob: async (bytes) => {
      const id = oid(bytes);
      blobs.set(id, Buffer.from(bytes));
      return id;
    },
    createTree: async ({ entries }) => {
      const id = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
      trees.set(id, new Map(entries.map((entry) => [entry.path, entry.sha])));
      return id;
    },
    createCommit: async ({ treeOid, parentOids, message }) => {
      const id = createHash("sha1")
        .update(JSON.stringify({ treeOid, parentOids, message }))
        .digest("hex");
      commits.set(id, { oid: id, treeOid, parentOids, message, serverTime: new Date() });
      return id;
    },
    createRef: async (ref, id) => {
      if (refs.has(ref)) return false;
      refs.set(ref, id);
      return true;
    },
  };
  return { store, blobs, trees, commits, refs };
}
async function local(bytes: Buffer, name: string, importId: string) {
  const root = await mkdtemp(join(tmpdir(), "factory-assets-test-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, bytes);
  return importObjectiveAsset(
    { kind: "local-file", path },
    { importId, visibility: "private", rights: { basis: "user-owned" } },
    { repositoryPrivate: true },
  );
}

describe("Objective asset contracts and handlers", () => {
  it("returns pinned DNS results in the callback shape requested by Node", () => {
    const lookup = fixedAddressLookup("203.0.113.7", 4);
    const single = vi.fn();
    const all = vi.fn();
    lookup("github.com", { all: false }, single);
    lookup("github.com", { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, "203.0.113.7", 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: "203.0.113.7", family: 4 }]);
  });

  it("recognizes only explicit GitHub attachment origins", () => {
    expect(
      recognizedGitHubAttachment("https://github.com/user-attachments/assets/abc-123"),
    ).toMatchObject({ attachmentId: "abc-123", host: "github.com" });
    expect(() => recognizedGitHubAttachment("https://example.com/file.png")).toThrow(
      /arbitrary URLs/,
    );
    expect(() =>
      recognizedGitHubAttachment("https://github.com/user-attachments/assets/abc?token=mutable"),
    ).toThrow(/plain HTTPS/);
  });
  it("shares byte identity while retaining distinct provenance and paths", async () => {
    const bytes = Buffer.from("# inert markdown\n\n[link](https://example.com)\n");
    const first = await local(bytes, "one.md", "first");
    const second = await local(bytes, "two.md", "second");
    expect(first.descriptor.content.digest).toBe(second.descriptor.content.digest);
    expect(first.descriptor.digest).not.toBe(second.descriptor.digest);
    expect(first.descriptor.materializationPath).not.toBe(second.descriptor.materializationPath);
    expect(first.descriptor.content.inspection.metadata.kind).toBe("markdown");
  });

  it("uses sharp for bounded full raster decode and rejects malformed claimed images", async () => {
    const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } })
      .png()
      .toBuffer();
    await expect(
      inspectAssetBytes(png, { displayName: "pixel.png", allowOpaque: false }),
    ).resolves.toMatchObject({
      status: "semantic-valid",
      handlerId: "sharp-raster",
      metadata: { kind: "raster", width: 3, height: 2 },
    });
    await expect(
      inspectAssetBytes(png.subarray(0, 20), { displayName: "broken.png", allowOpaque: false }),
    ).rejects.toThrow();
    for (const format of ["jpeg", "webp", "gif", "tiff"] as const) {
      const encoded = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "blue" },
      })
        [format]()
        .toBuffer();
      await expect(
        inspectAssetBytes(encoded, { displayName: `pixel.${format}`, allowOpaque: false }),
      ).resolves.toMatchObject({
        status: "semantic-valid",
        handlerId: "sharp-raster",
        metadata: { kind: "raster", width: 2, height: 2 },
      });
    }
  });

  it("requires explicit opaque transport and refuses executable content", async () => {
    const passive = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    await expect(
      inspectAssetBytes(passive, { displayName: "blob.dat", allowOpaque: false }),
    ).rejects.toThrow(/explicitly allow opaque/);
    await expect(
      inspectAssetBytes(passive, { displayName: "blob.dat", allowOpaque: true }),
    ).resolves.toMatchObject({ status: "opaque", metadata: { kind: "opaque" } });
    await expect(
      inspectAssetBytes(Buffer.from("#!/bin/sh\nexit 0\n"), {
        displayName: "run.sh",
        allowOpaque: true,
      }),
    ).rejects.toThrow(/executable/);
    await expect(
      inspectAssetBytes(Buffer.from("<script>alert(1)</script>"), {
        displayName: "page.html",
        allowOpaque: true,
      }),
    ).rejects.toThrow(/executable/);
    await expect(
      inspectAssetBytes(Buffer.from("print('do not run me')\n"), {
        displayName: "payload.py",
        allowOpaque: true,
      }),
    ).rejects.toThrow(/executable/);
  });

  it("refuses a local import through a symlinked path component", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-assets-test-"));
    roots.push(root);
    const realParent = join(root, "real");
    const linkedParent = join(root, "linked");
    await mkdir(realParent);
    await writeFile(join(realParent, "note.txt"), "safe\n");
    await symlink(realParent, linkedParent, "dir");
    await expect(
      importObjectiveAsset(
        { kind: "local-file", path: join(linkedParent, "note.txt") },
        { importId: "linked", visibility: "private", rights: { basis: "user-owned" } },
        { repositoryPrivate: true },
      ),
    ).rejects.toThrow(/symlinked parent/);
  });

  it("refuses private or unknown-rights material before public-repository storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-assets-test-"));
    roots.push(root);
    const path = join(root, "readme.md");
    await writeFile(path, "safe");
    await expect(
      importObjectiveAsset(
        { kind: "local-file", path },
        { importId: "public", visibility: "private", rights: { basis: "unknown" } },
        { repositoryPrivate: false },
      ),
    ).rejects.toThrow(/public repositories/);
  });

  it("publishes intent/ready receipts before the canonical manifest and materializes offline", async () => {
    const memory = memoryStore();
    const first = await local(Buffer.from("plain text\n"), "note.txt", "note");
    const second = await local(Buffer.from("# markdown\n"), "guide.md", "guide");
    const authority = { repository: "Fixture/Project", objective: 7, baseSha: "a".repeat(40) };
    const persisted = await persistObjectiveAssetManifest({
      store: memory.store,
      authority,
      requestId: "asset-request",
      revision: 1,
      assets: [first, second],
      assertCurrent: async () => {},
    });
    const ajv = new Ajv({ strict: false });
    ajv.addSchema(
      JSON.parse(
        await readFile(new URL("../schemas/artifact.schema.json", import.meta.url), "utf8"),
      ),
    );
    const validateManifest = ajv.compile(
      JSON.parse(
        await readFile(new URL("../schemas/objective-assets.schema.json", import.meta.url), "utf8"),
      ),
    );
    expect(validateManifest(persisted.manifest), JSON.stringify(validateManifest.errors)).toBe(
      true,
    );
    expect(
      persisted.manifest.assets.every(
        ({ storage }) =>
          memory.refs.has(`${storage.transferRef}/intent`) &&
          memory.refs.has(`${storage.transferRef}/ready`),
      ),
    ).toBe(true);
    await expect(
      readObjectiveAssetManifest({
        store: memory.store,
        authority,
        digest: persisted.manifest.digest,
      }),
    ).resolves.toEqual(persisted.manifest);
    await expect(
      readObjectiveAssetManifestByRequest({
        store: memory.store,
        authority,
        requestId: "asset-request",
      }),
    ).resolves.toMatchObject({ manifest: { digest: persisted.manifest.digest } });
    const output = await mkdtemp(join(tmpdir(), "factory-assets-output-"));
    roots.push(output);
    const materialized = await materializeObjectiveAssets({
      store: memory.store,
      manifest: persisted.manifest,
      supervisorRoot: output,
      descriptorDigests: [persisted.manifest.assets[0]!.descriptor.digest],
    });
    const selected = persisted.manifest.assets[0]!.descriptor;
    expect(await readFile(join(materialized.root, selected.materializationPath))).toHaveLength(
      selected.content.bytes,
    );
    await expect(
      readFile(
        join(materialized.root, persisted.manifest.assets[1]!.descriptor.materializationPath),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const realWorkspace = join(output, "real-workspace");
    const linkedWorkspace = join(output, "linked-workspace");
    await mkdir(realWorkspace);
    await symlink(realWorkspace, linkedWorkspace, "dir");
    await expect(
      materializeObjectiveAssets({
        store: memory.store,
        manifest: persisted.manifest,
        supervisorRoot: join(linkedWorkspace, ".factory-objective-assets"),
        descriptorDigests: [selected.digest],
      }),
    ).rejects.toThrow();

    const tampered = structuredClone(persisted.manifest);
    tampered.assets[0]!.storage.descriptorDigest = "f".repeat(64);
    expect(() => ObjectiveAssetManifestSchema.parse(tampered)).toThrow(/receipt descriptor/);
  });

  it("resumes an intent from immutable uploaded blobs without the source cache", async () => {
    const memory = memoryStore();
    const bytes = Buffer.from("restart-safe immutable bytes\n");
    const payload = await cachePayloadBytes(bytes);
    const identity = {
      domain: "objective-asset" as const,
      repository: "fixture/project",
      objective: 9,
      baseSha: "b".repeat(40),
      requestId: "restart",
      subjectDigest: payload.digest,
    };
    await expect(
      persistContentTransfer({
        store: memory.store,
        identity,
        payload,
        assertCurrent: async () => {},
        afterIntent: async () => {
          throw new Error("simulated process exit");
        },
      }),
    ).rejects.toThrow(/simulated process exit/);
    expect(memory.refs.has(`${contentTransferRef(identity)}/intent`)).toBe(true);
    expect(memory.refs.has(`${contentTransferRef(identity)}/ready`)).toBe(false);
    await releaseAllArtifactContent();
    await expect(
      resumeContentTransfer({ store: memory.store, identity, assertCurrent: async () => {} }),
    ).resolves.toMatchObject({ payload: { digest: payload.digest } });
    expect(memory.refs.has(`${contentTransferRef(identity)}/ready`)).toBe(true);
  });

  it("rejects a conflicting immutable transfer ref winner", async () => {
    const memory = memoryStore();
    const bytes = Buffer.from("conflict-safe bytes\n");
    const payload = await cachePayloadBytes(bytes);
    const identity = {
      domain: "objective-asset" as const,
      repository: "fixture/project",
      objective: 10,
      baseSha: "c".repeat(40),
      requestId: "conflict",
      subjectDigest: payload.digest,
    };
    const wrongTree = await memory.store.createTree({ entries: [] });
    const wrong = await memory.store.createCommit({
      treeOid: wrongTree,
      parentOids: [],
      message: "attacker-controlled winner",
    });
    memory.refs.set(`${contentTransferRef(identity)}/intent`, wrong);
    await expect(
      persistContentTransfer({
        store: memory.store,
        identity,
        payload,
        assertCurrent: async () => {},
      }),
    ).rejects.toThrow(/publication conflicted/);
  });

  it("refuses malformed intent lifecycle and descriptor chunk evidence before ready", async () => {
    const bytes = Buffer.from("authenticated restart bytes\n");
    const payload = await cachePayloadBytes(bytes);
    const identity = {
      domain: "objective-asset" as const,
      repository: "fixture/project",
      objective: 11,
      baseSha: "d".repeat(40),
      requestId: "tampered-intent",
      subjectDigest: payload.digest,
    };
    const memory = memoryStore();
    const chunk = payload.chunks[0]!;
    const descriptor = {
      protocol: "clockgrove.factory/content-transfer",
      identity,
      payload,
      chunks: [{ ...chunk, bytes: chunk.bytes + 1, oid: oid(bytes) }],
    };
    const descriptorOid = await memory.store.createBlob(Buffer.from(JSON.stringify(descriptor)));
    const tree = await memory.store.createTree({
      entries: [
        { path: "content-transfer.json", mode: "100644", type: "blob", sha: descriptorOid },
      ],
    });
    const intent = await memory.store.createCommit({
      treeOid: tree,
      parentOids: [],
      message: `Factory content transfer intent\n\nFactory-Content: ${payload.digest}`,
    });
    memory.refs.set(`${contentTransferRef(identity)}/intent`, intent);
    await expect(
      resumeContentTransfer({ store: memory.store, identity, assertCurrent: async () => {} }),
    ).rejects.toThrow(/descriptor chunks/);

    const commit = memory.commits.get(intent)!;
    memory.commits.set(intent, { ...commit, message: "non-canonical intent" });
    await expect(
      resumeContentTransfer({ store: memory.store, identity, assertCurrent: async () => {} }),
    ).rejects.toThrow(/lifecycle proof/);
  });
});
