import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GitCommitObject } from "../src/control/lease.js";
import type { RecoveryReadStore } from "../src/recovery/assessment.js";
import { withImmutableRecoveryReads } from "../src/recovery/immutable-read-cache.js";

const oid = (n: string) => createHash("sha1").update(n).digest("hex");
const blob = Buffer.from("exact immutable proof");
const blobOid = createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex");
function fixture() {
  const readCommit = vi.fn(
    async (sha: string): Promise<GitCommitObject> => ({
      oid: sha,
      treeOid: oid("tree"),
      parentOids: [oid("parent")],
      message: "immutable",
      committedAt: new Date("2026-09-04T23:59:00Z"),
      serverTime: new Date("2026-09-05T00:00:00Z"),
    }),
  );
  const readBlob = vi.fn(async () => Buffer.from(blob));
  const readTreeEntry = vi.fn(
    async (_tree: string, _path: string): Promise<string | null> => blobOid,
  );
  const store = {
    readCommit,
    readBlob,
    readTreeEntry,
    readRef: vi.fn(async () => oid("head")),
    listRefs: vi.fn(async () => []),
    readPullRequest: vi.fn(async () => ({ headSha: oid("head"), merged: false })),
    getRepositoryFacts: vi.fn(async () => ({ canPush: true })),
    getBranchHead: vi.fn(async () => ({ oid: oid("head") })),
    readBranchRules: vi.fn(async () => []),
    readChecks: vi.fn(async () => ({ pending: [] })),
    readStack: vi.fn(async () => ({ open: true })),
  } as unknown as RecoveryReadStore;
  return { store, readCommit, readBlob, readTreeEntry, port: withImmutableRecoveryReads(store) };
}
describe("store-owned immutable recovery content cache", () => {
  it("deduplicates concurrent exact-object reads and defends retained bytes from consumer mutation", async () => {
    const f = fixture(),
      other = withImmutableRecoveryReads(f.store);
    expect(other).toBe(f.port);
    expect(withImmutableRecoveryReads(other)).toBe(other);
    const [a, b] = await Promise.all([f.port.readCommit(oid("a")), other.readCommit(oid("a"))]);
    expect(f.readCommit).toHaveBeenCalledTimes(1);
    a.message = "forged";
    a.parentOids.length = 0;
    a.committedAt!.setTime(0);
    a.serverTime.setTime(0);
    expect(b.message).toBe("immutable");
    expect((await other.readCommit(oid("a"))).parentOids).toHaveLength(1);
    expect((await other.readCommit(oid("a"))).serverTime.toISOString()).toBe(
      "2026-09-05T00:00:00.000Z",
    );
    expect((await other.readCommit(oid("a"))).committedAt?.toISOString()).toBe(
      "2026-09-04T23:59:00.000Z",
    );
    const bytes = await f.port.readBlob(blobOid);
    bytes.fill(0);
    expect(await other.readBlob(blobOid)).toEqual(blob);
    expect(f.readBlob).toHaveBeenCalledTimes(1);
    await f.port.readTreeEntry(oid("tree"), "proof.json");
    await other.readTreeEntry(oid("tree"), "proof.json");
    expect(f.readTreeEntry).toHaveBeenCalledTimes(1);
    await other.readTreeEntry(oid("tree"), "other.json");
    expect(f.readTreeEntry).toHaveBeenCalledTimes(2);
  });
  it("never shares immutable entries between repository store identities", async () => {
    const first = fixture(),
      second = fixture();
    await first.port.readBlob(blobOid);
    await second.port.readBlob(blobOid);
    expect(first.readBlob).toHaveBeenCalledTimes(1);
    expect(second.readBlob).toHaveBeenCalledTimes(1);
  });
  it("does not retain failed, missing, malformed or non-content-addressed results", async () => {
    const f = fixture();
    f.readBlob.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.port.readBlob(blobOid)).rejects.toThrow("unavailable");
    await expect(f.port.readBlob(blobOid)).resolves.toEqual(blob);
    expect(f.readBlob).toHaveBeenCalledTimes(2);
    f.readCommit.mockImplementationOnce(async (sha) => ({
      oid: oid("wrong"),
      treeOid: sha,
      parentOids: [],
      message: "wrong",
      serverTime: new Date(),
    }));
    await expect(f.port.readCommit(oid("a"))).rejects.toThrow("identity mismatch");
    await expect(f.port.readCommit(oid("a"))).resolves.toMatchObject({ oid: oid("a") });
    expect(f.readCommit).toHaveBeenCalledTimes(2);
    f.readTreeEntry.mockResolvedValueOnce(null);
    expect(await f.port.readTreeEntry(oid("tree"), "new.json")).toBeNull();
    expect(await f.port.readTreeEntry(oid("tree"), "new.json")).toBe(blobOid);
    expect(f.readTreeEntry).toHaveBeenCalledTimes(2);
    await f.port.readBlob(oid("not-the-blob"));
    await f.port.readBlob(oid("not-the-blob"));
    expect(f.readBlob).toHaveBeenCalledTimes(4);
  });
  it("leaves refs, inventory, PR/base/policy/check/stack observations fresh", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      await f.port.readRef("refs/heads/main");
      await f.port.listRefs("refs/");
      await f.port.readPullRequest(1);
      await f.port.getBranchHead("main");
      await f.port.getRepositoryFacts();
      await f.port.readBranchRules("main");
      await f.port.readChecks(oid("a"));
      await f.port.readStack!(1);
    }
    for (const name of [
      "readRef",
      "listRefs",
      "readPullRequest",
      "getBranchHead",
      "getRepositoryFacts",
      "readBranchRules",
      "readChecks",
      "readStack",
    ] as const)
      expect(f.store[name]).toHaveBeenCalledTimes(2);
    vi.mocked(f.store.readRef).mockResolvedValue(null);
    expect(await f.port.readRef("refs/heads/main")).toBeNull();
    vi.mocked(f.store.readPullRequest).mockResolvedValue({
      headSha: oid("changed"),
      merged: true,
    } as Awaited<ReturnType<RecoveryReadStore["readPullRequest"]>>);
    expect(await f.port.readPullRequest(1)).toMatchObject({
      headSha: oid("changed"),
      merged: true,
    });
  });
  it("evicts least-recent content at the entry bound instead of growing across runs", async () => {
    const f = fixture();
    for (let i = 0; i < 2049; i++) await f.port.readCommit(oid(String(i)));
    expect(f.readCommit).toHaveBeenCalledTimes(2049);
    await f.port.readCommit(oid("2048"));
    expect(f.readCommit).toHaveBeenCalledTimes(2049);
    await f.port.readCommit(oid("0"));
    expect(f.readCommit).toHaveBeenCalledTimes(2050);
  });
  it("bounds retained bytes independently of object count", async () => {
    const f = fixture();
    const large = Buffer.alloc(9 * 1024 * 1024, 1);
    const first = createHash("sha1").update(`blob ${large.length}\0`).update(large).digest("hex");
    f.readBlob.mockImplementation(async () => Buffer.from(large));
    await f.port.readBlob(first);
    for (let i = 2; i <= 4; i++) {
      large.fill(i);
      const id = createHash("sha1").update(`blob ${large.length}\0`).update(large).digest("hex");
      await f.port.readBlob(id);
    }
    large.fill(1);
    await f.port.readBlob(first);
    expect(f.readBlob).toHaveBeenCalledTimes(5);
  });
});
