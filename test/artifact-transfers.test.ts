import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactTransferRef,
  persistArtifactTransfer,
  recoverArtifactTransfer,
  resumeArtifactTransfer,
  type ArtifactTransferIdentity,
  type ArtifactTransferStore,
} from "../src/control/artifact-transfers.js";
import {
  cachePayload,
  releaseAllArtifactContent,
  sha256,
} from "../src/execution/artifact-content.js";
import { normalizeArtifact, payloadPatchMarker } from "../src/execution/artifacts.js";
import type { GitCommitObject } from "../src/control/lease.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await releaseAllArtifactContent();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const oid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function store() {
  const blobs = new Map<string, Buffer>(),
    trees = new Map<string, Map<string, string>>(),
    commits = new Map<string, GitCommitObject>(),
    refs = new Map<string, string>();
  let count = 0,
    failAt = 0;
  const writes: string[] = [];
  const write = (kind: string) => {
    writes.push(kind);
    if (++count === failAt) throw new Error("interrupted write");
  };
  const api: ArtifactTransferStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (id) => commits.get(id)!,
    readTreeEntry: async (tree, path) => trees.get(tree)?.get(path) ?? null,
    readBlob: async (id) => {
      const bytes = blobs.get(id);
      if (!bytes) throw Object.assign(new Error("missing"), { status: 404 });
      return bytes;
    },
    createBlob: async (bytes) => {
      write("blob");
      const id = oid(bytes);
      blobs.set(id, bytes);
      return id;
    },
    createTree: async ({ entries }) => {
      write("tree");
      const id = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
      trees.set(id, new Map(entries.map((entry) => [entry.path, entry.sha])));
      return id;
    },
    createCommit: async ({ treeOid, parentOids, message }) => {
      write("commit");
      const id = createHash("sha1")
        .update(JSON.stringify({ treeOid, parentOids, message }))
        .digest("hex");
      commits.set(id, { oid: id, treeOid, parentOids, message, serverTime: new Date() });
      return id;
    },
    createRef: async (ref, id) => {
      write("ref");
      if (refs.has(ref)) return false;
      refs.set(ref, id);
      return true;
    },
  };
  return {
    api,
    refs,
    blobs,
    commits,
    writes,
    fail: (at: number) => {
      failAt = at;
      count = 0;
    },
  };
}
function identity(): ArtifactTransferIdentity {
  const value = {
    repository: "fixture/project",
    objective: 1,
    workItem: 2,
    attempt: 1,
    runId: randomUUID(),
    directorEpoch: 1,
    policyDigest: "a".repeat(64),
    baseSha: "b".repeat(40),
  };
  const digest = sha256(JSON.stringify(value));
  roots.push(join(tmpdir(), `factory-collected-${process.getuid?.() ?? "unknown"}-${digest}`));
  return value;
}
async function artifact(baseSha: string) {
  const root = await mkdtemp(join(tmpdir(), "factory-transfer-test-"));
  roots.push(root);
  const path = join(root, "patch");
  await writeFile(path, "safe retained transfer bytes");
  const payload = await cachePayload(path);
  return normalizeArtifact({
    baseSha,
    patch: payloadPatchMarker(payload),
    payload,
    changedPaths: ["asset.dat"],
    outcome: "succeeded",
    fileManifest: {
      version: 1,
      baseTreeSha: "c".repeat(40),
      resultTreeSha: "d".repeat(40),
      files: [
        {
          path: "asset.dat",
          action: "write",
          mode: "100644",
          bytes: 1,
          digest: sha256("x"),
          mediaType: "unknown",
          generated: false,
        },
      ],
    },
  });
}

describe("immutable GitHub artifact transfer lifecycle", () => {
  it("retains an exact incomplete marker before chunk admission and resumes only the original content", async () => {
    const memory = store(),
      id = identity(),
      value = await artifact(id.baseSha);
    const root = join(
      tmpdir(),
      `factory-collected-${process.getuid?.() ?? "unknown"}-${sha256(JSON.stringify(id))}`,
    );
    const originalOpen = fs.open;
    const admission = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === join(root, value.payload!.chunks[0]!.digest))
        throw Object.assign(new Error("fixture: chunk admission full"), { code: "ENOSPC" });
      return originalOpen(...args);
    });
    const options = {
      store: memory.api,
      identity: id,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {},
    };
    await expect(persistArtifactTransfer({ ...options, artifact: value })).rejects.toThrow(
      /chunk admission full/,
    );
    expect(memory.writes).toEqual([]);
    expect(JSON.parse(await fs.readFile(join(root, "collection.json"), "utf8"))).toEqual({
      protocol: "clockgrove.factory/incomplete-artifact-v1",
      identity: id,
      artifactDigest: value.digest,
    });
    await expect(resumeArtifactTransfer(options)).rejects.toThrow(/incomplete/i);
    admission.mockRestore();
    await persistArtifactTransfer({ ...options, artifact: value });
    expect((await recoverArtifactTransfer(options))?.digest).toBe(value.digest);
  });

  it("leaves first marker-write failure incomplete without any external publication", async () => {
    const memory = store(),
      id = identity(),
      value = await artifact(id.baseSha);
    const root = join(
      tmpdir(),
      `factory-collected-${process.getuid?.() ?? "unknown"}-${sha256(JSON.stringify(id))}`,
    );
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === join(root, "collection.json"))
        throw Object.assign(new Error("fixture: first durable write full"), { code: "ENOSPC" });
      return originalOpen(...args);
    });
    const options = {
      store: memory.api,
      identity: id,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {},
    };
    await expect(persistArtifactTransfer({ ...options, artifact: value })).rejects.toThrow(
      /first durable write full/,
    );
    expect(memory.writes).toEqual([]);
    await expect(resumeArtifactTransfer(options)).rejects.toThrow(/incomplete/i);
  });

  it("fences every mutation and recovers exact bytes only through intent-bound ready refs", async () => {
    const memory = store(),
      id = identity(),
      value = await artifact(id.baseSha);
    let fences = 0;
    const result = await persistArtifactTransfer({
      store: memory.api,
      identity: id,
      artifact: value,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {
        fences++;
      },
    });
    expect(fences).toBe(memory.writes.length);
    expect(result.lifecycle).toBe("retained");
    expect(memory.refs.has(`${artifactTransferRef(id)}/intent`)).toBe(true);
    await releaseAllArtifactContent();
    expect((await recoverArtifactTransfer({ store: memory.api, identity: id }))!.digest).toBe(
      value.digest,
    );
    const ready = memory.commits.get(result.commitSha)!;
    ready.parentOids = [];
    await expect(recoverArtifactTransfer({ store: memory.api, identity: id })).rejects.toThrow(
      "immutable upload intent",
    );
  });

  it.each([1, 5])(
    "resumes exact retained bytes after process-cache loss at write %s without executing replacement work",
    async (failure) => {
      const memory = store(),
        id = identity(),
        value = await artifact(id.baseSha);
      memory.fail(failure);
      await expect(
        persistArtifactTransfer({
          store: memory.api,
          identity: id,
          artifact: value,
          allowedPaths: ["asset.dat"],
          assertCurrent: async () => {},
        }),
      ).rejects.toThrow("interrupted");
      await releaseAllArtifactContent();
      if (failure === 5)
        await expect(recoverArtifactTransfer({ store: memory.api, identity: id })).rejects.toThrow(
          "incomplete",
        );
      memory.fail(0);
      const resumed = await resumeArtifactTransfer({
        store: memory.api,
        identity: id,
        allowedPaths: ["asset.dat"],
        assertCurrent: async () => {},
      });
      expect(resumed!.digest).toBe(value.digest);
      expect(resumed!.createdAt).toBe(value.createdAt);
    },
  );

  it("rejects scope and corrupted remote bytes without authorizing a new artifact", async () => {
    const memory = store(),
      id = identity(),
      value = await artifact(id.baseSha);
    await expect(
      persistArtifactTransfer({
        store: memory.api,
        identity: id,
        artifact: value,
        allowedPaths: ["other.dat"],
        assertCurrent: async () => {},
      }),
    ).rejects.toThrow();
    expect(memory.writes).toEqual([]);
    await persistArtifactTransfer({
      store: memory.api,
      identity: id,
      artifact: value,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {},
    });
    const chunk = [...memory.blobs.entries()].find(
      ([, bytes]) => bytes.toString() === "safe retained transfer bytes",
    )!;
    memory.blobs.set(chunk[0], Buffer.from("corrupted"));
    await expect(recoverArtifactTransfer({ store: memory.api, identity: id })).rejects.toThrow(
      "identity mismatch",
    );
  });

  it("returns null only when neither remote transfer nor retained collection exists", async () => {
    expect(
      await resumeArtifactTransfer({
        store: store().api,
        identity: identity(),
        allowedPaths: ["asset.dat"],
        assertCurrent: async () => {},
      }),
    ).toBeNull();
  });
});
