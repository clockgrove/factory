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
  readContentChunk,
  releaseAllArtifactContent,
  sha256,
} from "../src/execution/artifact-content.js";
import { normalizeArtifact, payloadPatchMarker } from "../src/execution/artifacts.js";
import type { GitCommitObject } from "../src/control/lease.js";
import { enterTemporaryNamespace } from "./helpers/temporary-namespace.js";

// Copy the real module into a configurable test namespace: native ESM exports
// cannot be spied on. All un-intercepted filesystem operations remain real.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

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
      trees.set(
        id,
        new Map(
          entries.map((entry) => {
            if (entry.content !== undefined) {
              const bytes = Buffer.from(entry.content);
              const blobOid = oid(bytes);
              blobs.set(blobOid, bytes);
              return [entry.path, blobOid];
            }
            return [entry.path, entry.sha!];
          }),
        ),
      );
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
async function artifact(baseSha: string, bytes = "safe retained transfer bytes") {
  const root = await mkdtemp(join(tmpdir(), "factory-transfer-test-"));
  roots.push(root);
  const path = join(root, "patch");
  await writeFile(path, bytes);
  const payload = await cachePayload(path);
  return normalizeArtifact({
    baseSha,
    patch: payloadPatchMarker(payload),
    payload,
    changedPaths: ["asset.dat"],
    outcome: "succeeded",
    fileManifest: {
      baseTreeSha: "c".repeat(40),
      resultTreeSha: "d".repeat(40),
      files: [
        {
          path: "asset.dat",
          action: "write",
          mode: "100644",
          bytes: 1,
          digest: sha256("x"),
          mediaType: "application/octet-stream",
          generated: false,
        },
      ],
    },
  });
}

describe("immutable GitHub artifact transfer lifecycle", () => {
  it("uses acknowledged publication even when the new ref is not immediately readable", async () => {
    const memory = store(),
      id = identity();
    const readRef = vi.spyOn(memory.api, "readRef").mockResolvedValue(null);
    const readCommit = vi.spyOn(memory.api, "readCommit");
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "inline",
      changedPaths: ["asset.dat"],
      outcome: "succeeded",
    });
    await expect(
      persistArtifactTransfer({
        store: memory.api,
        identity: id,
        artifact: value,
        allowedPaths: ["asset.dat"],
        assertCurrent: async () => {},
      }),
    ).resolves.toMatchObject({ lifecycle: "retained" });
    expect(readCommit).not.toHaveBeenCalled();
    expect(readRef).toHaveBeenCalledTimes(1);
    const prefix = artifactTransferRef(id);
    expect(memory.commits.get(memory.refs.get(`${prefix}/ready`)!)!.parentOids).toEqual([]);
    expect(memory.refs.has(`${prefix}/intent`)).toBe(false);
  });

  it("validates an ambiguous publication and rejects unavailable evidence without replaying it", async () => {
    const memory = store(),
      id = identity();
    const createRef = vi
      .spyOn(memory.api, "createRef")
      .mockRejectedValue(new Error("response lost"));
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "inline",
      changedPaths: ["asset.dat"],
      outcome: "succeeded",
    });
    await expect(
      persistArtifactTransfer({
        store: memory.api,
        identity: id,
        artifact: value,
        allowedPaths: ["asset.dat"],
        assertCurrent: async () => {},
      }),
    ).rejects.toMatchObject({
      message: "artifact transfer ready publication is not yet observable",
      cause: expect.objectContaining({ message: "response lost" }),
    });
    expect(createRef).toHaveBeenCalledTimes(1);
    expect(memory.refs.size).toBe(0);
  });

  it("rebuilds the ready tree when an equivalent race winner uses different descriptor bytes", async () => {
    const memory = store(),
      id = identity();
    const value = await artifact(id.baseSha);
    const args = {
      store: memory.api,
      identity: id,
      artifact: value,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {},
    };
    await persistArtifactTransfer(args);
    const prefix = artifactTransferRef(id);
    const original = memory.commits.get(memory.refs.get(`${prefix}/intent`)!)!;
    const descriptorOid = await memory.api.readTreeEntry(
      original.treeOid,
      "artifact-transfer.json",
    );
    const bytes = await memory.api.readBlob(descriptorOid!);
    const historicalBytes = Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 2));
    const historicalOid = await memory.api.createBlob(historicalBytes);
    const treeOid = await memory.api.createTree({
      entries: [
        { path: "artifact-transfer.json", mode: "100644", type: "blob", sha: historicalOid },
      ],
    });
    const intentOid = await memory.api.createCommit({
      treeOid,
      parentOids: [],
      message: original.message.replace(sha256(bytes), sha256(historicalBytes)),
    });
    memory.refs.set(`${prefix}/intent`, intentOid);
    memory.refs.delete(`${prefix}/ready`);
    const readRef = memory.api.readRef;
    vi.spyOn(memory.api, "readRef").mockResolvedValueOnce(null).mockImplementation(readRef);
    await expect(persistArtifactTransfer(args)).resolves.toMatchObject({ lifecycle: "retained" });
    await expect(
      recoverArtifactTransfer({ store: memory.api, identity: id }),
    ).resolves.toMatchObject({ digest: value.digest });
  });

  it("rejects a different valid winner when ref creation loses the race", async () => {
    const memory = store(),
      id = identity();
    const originalRead = memory.api.readRef;
    const value = (patch: string) =>
      normalizeArtifact({
        baseSha: id.baseSha,
        patch,
        changedPaths: ["asset.dat"],
        outcome: "succeeded",
      });
    const args = {
      store: memory.api,
      identity: id,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {},
    };
    await persistArtifactTransfer({ ...args, artifact: value("winner") });
    vi.spyOn(memory.api, "readRef")
      .mockResolvedValueOnce(null) // Concurrent ready publication is initially absent.
      .mockImplementation(originalRead);
    const publish = vi.spyOn(memory.api, "createRef");
    await expect(persistArtifactTransfer({ ...args, artifact: value("loser") })).rejects.toThrow(
      "artifact transfer ref publication conflicted",
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("recovers an acknowledged but response-lost publication through full object validation", async () => {
    const memory = store(),
      id = identity();
    const publish = memory.api.createRef;
    vi.spyOn(memory.api, "createRef").mockImplementation(async (ref, oid) => {
      await publish(ref, oid);
      throw new Error("response lost");
    });
    const readCommit = vi.spyOn(memory.api, "readCommit");
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "inline",
      changedPaths: ["asset.dat"],
      outcome: "succeeded",
    });
    await expect(
      persistArtifactTransfer({
        store: memory.api,
        identity: id,
        artifact: value,
        allowedPaths: ["asset.dat"],
        assertCurrent: async () => {},
      }),
    ).resolves.toMatchObject({ lifecycle: "retained" });
    expect(readCommit).toHaveBeenCalledTimes(1);
    expect(memory.refs.size).toBe(1);
  });

  it("isolates transfers from an occupied external pending-artifact namespace", async () => {
    const external = enterTemporaryNamespace();
    roots.push(external.root);
    try {
      for (let index = 0; index < 16; index++) {
        await fs.mkdir(
          join(external.root, `factory-collected-${process.getuid?.() ?? "unknown"}-${index}`),
          { mode: 0o700 },
        );
      }
      const id = identity();
      const args = {
        store: store().api,
        identity: id,
        artifact: normalizeArtifact({
          baseSha: id.baseSha,
          patch: "inline",
          changedPaths: ["asset.dat"],
          outcome: "succeeded",
        }),
        allowedPaths: ["asset.dat"],
        assertCurrent: async () => {},
      };
      await expect(persistArtifactTransfer(args)).rejects.toThrow(
        "pending artifact cache count bound reached",
      );
      const isolated = enterTemporaryNamespace();
      try {
        await expect(persistArtifactTransfer(args)).resolves.toMatchObject({
          lifecycle: "retained",
        });
      } finally {
        isolated.restore();
      }
      expect(
        (await fs.readdir(external.root)).filter((name) => name.startsWith("factory-collected-")),
      ).toHaveLength(16);
    } finally {
      external.restore();
    }
  });

  it("interrupts above-inline bytes only after durable intent and resumes the original private copy without rearming", async () => {
    const memory = store(),
      id = identity(),
      bytes = "x".repeat(5 * 1024 * 1024 + 1);
    const value = await artifact(id.baseSha, bytes),
      prefix = artifactTransferRef(id);
    const afterCheckpoint = vi.fn(
      async (
        checkpoint: import("../src/control/artifact-transfers.js").ArtifactTransferQualificationCheckpoint,
      ) => {
        expect(checkpoint.identity).toEqual(id);
        expect(checkpoint.artifactDigest).toBe(value.digest);
        expect(checkpoint.phase).toBe("intent");
        expect(checkpoint.content).toEqual([
          { digest: sha256(bytes), bytes: Buffer.byteLength(bytes), chunks: 2 },
        ]);
        expect(memory.refs.get(`${prefix}/intent`)).toBe(checkpoint.commitSha);
        expect(memory.refs.has(`${prefix}/ready`)).toBe(false);
        // Only the descriptor exists remotely; all chunk bytes are still private.
        expect(memory.blobs.size).toBe(1);
        await checkpoint.proveRetained();
        throw new Error("explicit one-shot transfer interruption");
      },
    );
    let admissions = 0;
    const args = {
      store: memory.api,
      identity: id,
      artifact: value,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {
        admissions++;
      },
      afterCheckpoint,
    };
    await expect(persistArtifactTransfer(args)).rejects.toThrow("one-shot transfer interruption");
    const originalIntent = memory.refs.get(`${prefix}/intent`);
    expect(memory.refs.has(`${prefix}/ready`)).toBe(false);
    expect(admissions).toBeGreaterThan(4);
    // A restart loses every process-local chunk. Only exact retained disk bytes survive.
    await releaseAllArtifactContent();
    const recovered = await resumeArtifactTransfer(args);
    expect(recovered).toEqual(value);
    expect(afterCheckpoint).toHaveBeenCalledTimes(1); // Even an extra callback on args cannot rearm resume.
    expect(memory.refs.get(`${prefix}/intent`)).toBe(originalIntent);
    const ready = memory.commits.get(memory.refs.get(`${prefix}/ready`)!);
    expect(ready!.parentOids).toEqual([originalIntent]);
    const restored = Buffer.concat(
      await Promise.all(recovered!.payload!.chunks.map(readContentChunk)),
    );
    expect(restored.equals(Buffer.from(bytes))).toBe(true);
    expect(sha256(restored)).toBe(value.payload!.digest);
  });

  it("never arms inline artifact publication", async () => {
    const memory = store(),
      id = identity(),
      afterCheckpoint = vi.fn();
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "inline",
      changedPaths: ["asset.dat"],
      outcome: "succeeded",
    });
    await persistArtifactTransfer({
      store: memory.api,
      identity: id,
      artifact: value,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {},
      afterCheckpoint,
    });
    expect(afterCheckpoint).not.toHaveBeenCalled();
    expect(await recoverArtifactTransfer({ store: memory.api, identity: id })).toEqual(value);
  });

  for (const phase of ["directory", "child"] as const) {
    it(`does not fail this transfer when a peer removes its ${phase} after cache enumeration`, async () => {
      const memory = store(),
        id = identity(),
        peer = identity(),
        value = await artifact(id.baseSha);
      const peerRoot = join(
        tmpdir(),
        `factory-collected-${process.getuid?.() ?? "unknown"}-${sha256(JSON.stringify(peer))}`,
      );
      await fs.mkdir(peerRoot, { mode: 0o700 });
      const peerFile = join(peerRoot, "collection.json");
      await fs.writeFile(peerFile, "peer pending metadata", { mode: 0o600 });
      const target = phase === "directory" ? peerRoot : peerFile;
      const original = fs.lstat;
      let removed = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (String(args[0]) === target && !removed) {
          removed = true;
          await fs.rm(target, { recursive: phase === "directory", force: true });
        }
        return original(...args);
      });
      await expect(
        persistArtifactTransfer({
          store: memory.api,
          identity: id,
          artifact: value,
          allowedPaths: ["asset.dat"],
          assertCurrent: async () => {},
        }),
      ).resolves.toMatchObject({ artifactDigest: value.digest });
      expect(removed).toBe(true);
      expect((await recoverArtifactTransfer({ store: memory.api, identity: id }))?.digest).toBe(
        value.digest,
      );
    });
  }

  for (const own of [false, true]) {
    it(`still refuses ${own ? "its own disappeared cache" : "a peer cache permission failure"}`, async () => {
      const memory = store(),
        id = identity(),
        peer = identity(),
        value = await artifact(id.baseSha);
      const root = join(
        tmpdir(),
        `factory-collected-${process.getuid?.() ?? "unknown"}-${sha256(JSON.stringify(own ? id : peer))}`,
      );
      await fs.mkdir(root, { mode: 0o700 });
      const original = fs.lstat;
      let calls = 0;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (String(args[0]) === root && ++calls >= (own ? 2 : 1))
          throw Object.assign(new Error("fixture: cache observation refused"), {
            code: own ? "ENOENT" : "EACCES",
          });
        return original(...args);
      });
      await expect(
        persistArtifactTransfer({
          store: memory.api,
          identity: id,
          artifact: value,
          allowedPaths: ["asset.dat"],
          assertCurrent: async () => {},
        }),
      ).rejects.toThrow("cache observation refused");
      expect(memory.writes).toEqual([]);
    });
  }

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
      protocol: "clockgrove.factory/incomplete-artifact",
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

  it("publishes an inline transfer with one fenced direct retained checkpoint", async () => {
    const memory = store(),
      id = identity();
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "",
      changedPaths: [],
      outcome: "succeeded",
    });
    let fences = 0;
    const result = await persistArtifactTransfer({
      store: memory.api,
      identity: id,
      artifact: value,
      allowedPaths: [],
      assertCurrent: async () => {
        fences++;
      },
    });
    expect(memory.writes).toEqual(["tree", "commit", "ref"]);
    expect(fences).toBe(3);
    expect(memory.refs.has(`${artifactTransferRef(id)}/intent`)).toBe(false);
    const ready = memory.commits.get(result.commitSha)!;
    expect(ready.parentOids).toEqual([]);
    expect((await recoverArtifactTransfer({ store: memory.api, identity: id }))?.digest).toBe(
      value.digest,
    );
  });

  it.each([1, 2, 3])("resumes direct retention after interruption at write %s", async (failure) => {
    const memory = store(),
      id = identity();
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "inline",
      changedPaths: ["asset.dat"],
      outcome: "succeeded",
    });
    const args = {
      store: memory.api,
      identity: id,
      artifact: value,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {},
    };
    memory.fail(failure);
    await expect(persistArtifactTransfer(args)).rejects.toThrow(
      failure === 3 ? "not yet observable" : "interrupted",
    );
    expect(memory.refs.size).toBe(0);
    await expect(recoverArtifactTransfer(args)).resolves.toBeNull();
    memory.fail(0);
    const recovered = await resumeArtifactTransfer(args);
    expect(recovered).toEqual(value);
    expect(memory.refs.size).toBe(1);
    // Successful retention removes the only private descriptor: recovery is GitHub-only.
    await expect(fs.stat(roots[roots.length - 1]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recoverArtifactTransfer(args)).resolves.toEqual(value);
  });

  it.each([1, 2, 3])("rejects a stale owner at direct retention mutation %s", async (failure) => {
    const memory = store(),
      id = identity();
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "inline",
      changedPaths: ["asset.dat"],
      outcome: "succeeded",
    });
    let fences = 0;
    await expect(
      persistArtifactTransfer({
        store: memory.api,
        identity: id,
        artifact: value,
        allowedPaths: ["asset.dat"],
        assertCurrent: async () => {
          if (++fences === failure) throw new Error("writer replaced");
        },
      }),
    ).rejects.toThrow(failure === 3 ? "not yet observable" : "writer replaced");
    expect(memory.writes).toHaveLength(failure - 1);
    expect(memory.refs.size).toBe(0);
  });

  it("rejects obsolete inline intent state instead of projecting it into v2", async () => {
    const memory = store(),
      id = identity();
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "inline",
      changedPaths: ["asset.dat"],
      outcome: "succeeded",
    });
    const bytes = Buffer.from(
      JSON.stringify({
        protocol: "clockgrove.factory/artifact-transfer",
        identity: id,
        artifact: value,
        retention: "repository-audit",
        chunks: [],
      }),
    );
    const blob = await memory.api.createBlob(bytes);
    const treeOid = await memory.api.createTree({
      entries: [{ path: "artifact-transfer.json", mode: "100644", type: "blob", sha: blob }],
    });
    const intentOid = await memory.api.createCommit({
      treeOid,
      parentOids: [],
      message: `Factory artifact transfer intent\n\nFactory-Artifact: ${value.digest}\nFactory-Descriptor: ${sha256(bytes)}\nFactory-Retention: repository-audit`,
    });
    const prefix = artifactTransferRef(id);
    await memory.api.createRef(`${prefix}/intent`, intentOid);
    await expect(recoverArtifactTransfer({ store: memory.api, identity: id })).rejects.toThrow(
      "direct retained transfer must have no payload, intent, or parents",
    );
  });

  it("rejects parents and a transplanted intent on a direct v2 receipt", async () => {
    const memory = store(),
      id = identity();
    const value = normalizeArtifact({
      baseSha: id.baseSha,
      patch: "inline",
      changedPaths: ["asset.dat"],
      outcome: "succeeded",
    });
    const args = {
      store: memory.api,
      identity: id,
      artifact: value,
      allowedPaths: ["asset.dat"],
      assertCurrent: async () => {},
    };
    const result = await persistArtifactTransfer(args);
    const ready = memory.commits.get(result.commitSha)!;
    ready.parentOids = [id.baseSha];
    await expect(recoverArtifactTransfer(args)).rejects.toThrow("no payload, intent, or parents");
    ready.parentOids = [];
    memory.refs.set(`${artifactTransferRef(id)}/intent`, result.commitSha);
    await expect(recoverArtifactTransfer(args)).rejects.toThrow("no payload, intent, or parents");
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
    expect(memory.writes.filter((kind) => kind === "blob")).toHaveLength(2);
    expect(memory.writes.filter((kind) => kind === "tree")).toHaveLength(2);
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
