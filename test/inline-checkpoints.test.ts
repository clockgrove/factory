import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { ReviewCheckpointManager } from "../src/control/reviews.js";
import { ValidationCheckpointManager } from "../src/control/validation-checkpoints.js";
import { createValidationEvidence } from "../src/validation/evidence.js";

const lease = {
  objective: 1,
  runId: "inline-checkpoint",
  policyDigest: "a".repeat(64),
  epoch: 1,
} as LeaseState;
const baseSha = "b".repeat(40);
const artifactDigest = "c".repeat(64);

function fixture() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  let counter = 1;
  const oid = () => (counter++).toString(16).padStart(40, "0");
  const writes: string[] = [];
  const store: CompiledGraphStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (id) => commits.get(id)!,
    readBlob: async (id) => blobs.get(id)!,
    readTreeEntry: async (id, path) => trees.get(id)?.get(path) ?? null,
    createBlob: vi.fn(async () => {
      throw new Error("unexpected separate blob write");
    }),
    createTree: async ({ entries }) => {
      writes.push("tree");
      const tree = new Map<string, string>();
      for (const entry of entries) {
        expect(entry).not.toHaveProperty("sha");
        const bytes = Buffer.from(entry.content!, "utf8");
        // Independent Git implementation checks byte length and non-ASCII encoding.
        const sha = execFileSync("git", ["hash-object", "--stdin"], {
          input: bytes,
          encoding: "utf8",
        }).trim();
        blobs.set(sha, bytes);
        tree.set(entry.path, sha);
      }
      const id = oid();
      trees.set(id, tree);
      return id;
    },
    createCommit: async (input) => {
      writes.push("commit");
      expect(input.parentOids).toEqual([baseSha]);
      const id = oid();
      commits.set(id, { ...input, oid: id, serverTime: new Date() });
      return id;
    },
    createRef: async (ref, id) => {
      writes.push("ref");
      refs.set(ref, id);
      return true;
    },
  };
  const assertMutationAuthorized = vi.fn(async () => {});
  const leases = { assertMutationAuthorized } as unknown as LeaseManager;
  return { store, leases, blobs, writes, assertMutationAuthorized };
}

describe("inline immutable checkpoint blobs", () => {
  it("persists and reloads exact UTF-8 review content with one fewer write", async () => {
    const f = fixture();
    const manager = new ReviewCheckpointManager(f.store, f.leases);
    const identity = {
      kind: "artifact" as const,
      runId: lease.runId,
      objective: 1,
      workItem: 2,
      attempt: 1,
      baseSha,
      artifactDigest,
      outputTreeSha: "d".repeat(40),
      evidenceDigest: "e".repeat(64),
    };
    const result = {
      review: {
        accepted: true,
        summary: "Verified café 🚀\nline two",
        unmetCriteria: [],
        risks: [],
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    };
    const record = await manager.persist({ lease, identity, result });
    expect(f.blobs.get(record.blobOid)?.toString("utf8")).toContain("café 🚀");
    expect(await manager.load(identity)).toEqual(record);
    expect(await manager.persist({ lease, identity, result })).toEqual(record);
    expect(f.writes).toEqual(["tree", "commit", "ref"]);
    expect(f.store.createBlob).not.toHaveBeenCalled();
    expect(f.assertMutationAuthorized).toHaveBeenCalledTimes(3);
    await expect(
      manager.persist({
        lease,
        identity,
        result: { ...result, review: { ...result.review, summary: "divergent" } },
      }),
    ).rejects.toThrow("different immutable");
  });

  it("persists and reloads exact UTF-8 validation evidence with one fewer write", async () => {
    const f = fixture();
    const manager = new ValidationCheckpointManager(f.store, f.leases);
    const identity = {
      runId: lease.runId,
      objective: 1,
      workItem: 2,
      attempt: 1,
      baseSha,
      artifactDigest,
      directorEpoch: 1,
      policyDigest: lease.policyDigest,
    };
    const evidence = createValidationEvidence({
      protocol: "clockgrove.factory/validation-v1",
      artifactDigest,
      baseSha,
      outputTreeSha: "d".repeat(40),
      commands: [],
      passed: true,
      startedAt: "2026-09-12T00:00:00.000Z",
      completedAt: "2026-09-12T00:00:01.000Z",
      environmentIdentity: "validation café 🚀",
    });
    const record = await manager.persist({ lease, identity, evidence });
    expect(f.blobs.get(record.blobOid)?.toString("utf8")).toContain("café 🚀");
    expect(await manager.load(identity)).toEqual(record);
    expect(await manager.persist({ lease, identity, evidence })).toEqual(record);
    expect(f.writes).toEqual(["tree", "commit", "ref"]);
    expect(f.store.createBlob).not.toHaveBeenCalled();
    expect(f.assertMutationAuthorized).toHaveBeenCalledTimes(3);
  });
});
