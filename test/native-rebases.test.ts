import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import {
  NativeRebaseCheckpointStore,
  loadNativeRebaseCheckpoint,
  nativeRebaseCheckpointRef,
  nativeRebaseIdentityDigest,
  nativeRebaseResourceOwnership,
  nativeRebaseValidationInvocation,
  type NativeRebaseIdentity,
} from "../src/control/native-rebases.js";
import { validationInvocationOwnership } from "../src/backends/validation-invocation.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (character: string) => character.repeat(40);
const digest = (character: string) => character.repeat(64);
const now = new Date("2026-09-05T00:00:00Z");
class MemoryStore implements CompiledGraphStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>();
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  writes: string[] = [];
  lostResponse: string | null = null;
  loseLeaseAfter: string | null = null;
  leaseValid = true;
  private fenced = false;
  private counter = 0;
  async assertCurrent() {
    if (!this.leaseValid) throw new Error("lease lost");
    this.fenced = true;
  }
  private before(kind: string) {
    expect(this.fenced, `fence before ${kind}`).toBe(true);
    this.fenced = false;
    this.writes.push(kind);
    return createHash("sha1")
      .update(`${kind}:${++this.counter}`)
      .digest("hex");
  }
  private after(kind: string) {
    if (this.loseLeaseAfter === kind) this.leaseValid = false;
    if (this.lostResponse === kind) {
      this.lostResponse = null;
      throw new Error("response lost");
    }
  }
  async readRef(ref: string) {
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string) {
    const commit = this.commits.get(oid);
    if (!commit) throw new Error("commit unavailable");
    return structuredClone(commit);
  }
  async readBlob(oid: string) {
    const bytes = this.blobs.get(oid);
    if (!bytes) throw new Error("blob unavailable");
    return Buffer.from(bytes);
  }
  async readTreeEntry(tree: string, path: string) {
    return this.trees.get(tree)?.get(path) ?? null;
  }
  async createBlob(bytes: Buffer) {
    const oid = this.before("blob");
    this.blobs.set(oid, Buffer.from(bytes));
    this.after("blob");
    return oid;
  }
  async createTree(args: Parameters<CompiledGraphStore["createTree"]>[0]) {
    const oid = this.before("tree");
    this.trees.set(oid, new Map(args.entries.filter((e) => e.sha).map((e) => [e.path, e.sha!])));
    this.after("tree");
    return oid;
  }
  async createCommit(args: Parameters<CompiledGraphStore["createCommit"]>[0]) {
    const oid = this.before("commit");
    this.commits.set(oid, { ...args, oid, serverTime: now });
    this.after("commit");
    return oid;
  }
  async createRef(ref: string, oid: string) {
    this.before("ref");
    const created = !this.refs.has(ref);
    if (created) this.refs.set(ref, oid);
    this.after("ref");
    return created;
  }
}
function fixture() {
  const store = new MemoryStore();
  const source = bindValidationToPublishedHead({
    validation: { passed: true, digest: digest("1"), baseSha: sha("a"), outputTreeSha: sha("b") },
    publishedHeadSha: sha("c"),
    publishedBaseSha: sha("a"),
    publishedTreeSha: sha("b"),
  });
  const validation = createValidationEvidence({
    protocol: "clockgrove.factory/validation-v1",
    artifactDigest: digest("2"),
    baseSha: sha("d"),
    outputTreeSha: sha("e"),
    commands: [{ command: "npm test", exitCode: 0, durationMs: 500 }],
    passed: true,
    startedAt: new Date(now.getTime() + 500).toISOString(),
    completedAt: new Date(now.getTime() + 2500).toISOString(),
    environmentIdentity: `docker.io/library/node@sha256:${digest("3")}`,
  });
  const identity: NativeRebaseIdentity = {
    repository: "owner/repository",
    runId: "run",
    objective: 7,
    workItem: 8,
    attempt: 1,
    directorEpoch: 2,
    policyDigest: digest("4"),
    pullRequest: 9,
    sourceHeadSha: sha("c"),
    sourceExactHeadValidationDigest: source.digest,
    headSha: sha("f"),
    baseSha: sha("d"),
  };
  for (const [head, base, tree] of [
    [sha("c"), sha("a"), sha("b")],
    [sha("f"), sha("d"), sha("e")],
  ]) {
    store.commits.set(head!, {
      oid: head!,
      treeOid: tree!,
      parentOids: [base!],
      message: "fixture",
      serverTime: now,
    });
  }
  const lease: LeaseState = {
    objective: 7,
    runId: "run",
    holder: "controller",
    policyDigest: digest("4"),
    ref: "refs/clockgrove-factory/leases/objective-7",
    oid: sha("1"),
    treeOid: sha("2"),
    epoch: 3,
    sequence: 1,
    expiresAt: new Date(now.getTime() + 600000),
  };
  const isolatedResource = {
    backend: "codex-cli/daytona" as const,
    invocationOwnershipDigest: nativeRebaseResourceOwnership(identity, validation.artifactDigest),
    startedAt: now.toISOString(),
    completedAt: new Date(now.getTime() + 3000).toISOString(),
    sandboxMilliseconds: 3000,
  };
  return {
    store,
    manager: new NativeRebaseCheckpointStore(store, store as unknown as LeaseManager),
    args: { lease, identity, source, validation, isolatedResource },
  };
}

describe("native stack sandbox rebase checkpoints", () => {
  it("reconstructs exact validation, ownership and measured sandbox cost in a fresh store wrapper", async () => {
    const f = fixture();
    const first = await f.manager.persist(f.args);
    const writes = f.store.writes.length;
    const reloaded = await loadNativeRebaseCheckpoint(f.store, f.args.identity);
    expect(reloaded).toEqual(first);
    expect(reloaded?.exactHeadValidation.publishedHeadSha).toBe(f.args.identity.headSha);
    expect(reloaded?.source.publishedHeadSha).toBe(f.args.identity.sourceHeadSha);
    expect(reloaded?.isolatedResource.sandboxMilliseconds).toBe(3000);
    expect(
      await new NativeRebaseCheckpointStore(f.store, f.store as unknown as LeaseManager).persist(
        f.args,
      ),
    ).toEqual(first);
    expect(f.store.writes).toHaveLength(writes);
  });

  it.each(["blob", "tree", "commit", "ref"])(
    "recovers a lost %s response without replacing the visible checkpoint",
    async (kind) => {
      const f = fixture();
      f.store.lostResponse = kind;
      if (kind === "ref") await expect(f.manager.persist(f.args)).resolves.toBeTruthy();
      else await expect(f.manager.persist(f.args)).rejects.toThrow("response lost");
      const record = await f.manager.persist(f.args);
      expect(f.store.refs.size).toBe(1);
      expect(await loadNativeRebaseCheckpoint(f.store, f.args.identity)).toEqual(record);
      expect(f.store.writes.filter((write) => write === "ref")).toHaveLength(1);
    },
  );

  it.each(["blob", "tree", "commit"])(
    "stops all following writes after losing the lease at %s",
    async (kind) => {
      const f = fixture();
      f.store.loseLeaseAfter = kind;
      await expect(f.manager.persist(f.args)).rejects.toThrow("lease lost");
      expect(f.store.writes.at(-1)).toBe(kind);
      expect(f.store.refs.size).toBe(0);
    },
  );

  it("requires the same policy and run and rejects a future reservation epoch before writes", async () => {
    for (const change of [
      { policyDigest: digest("5") },
      { runId: "foreign" },
      { directorEpoch: 4 },
    ]) {
      const f = fixture();
      await expect(
        f.manager.persist({ ...f.args, identity: { ...f.args.identity, ...change } }),
      ).rejects.toThrow("lease scope");
      expect(f.store.writes).toEqual([]);
    }
  });

  it("keeps native rebase resources distinct from sibling validators and other exact heads", () => {
    const f = fixture();
    const identity = f.args.identity;
    const own = nativeRebaseResourceOwnership(identity, f.args.validation.artifactDigest);
    const sibling = validationInvocationOwnership({
      ...identity,
      phase: "validation",
      validationInvocation: {
        ...nativeRebaseValidationInvocation(identity, f.args.validation.artifactDigest),
        kind: "integration-candidate",
      },
    });
    expect(own).not.toBe(sibling);
    expect(nativeRebaseCheckpointRef(identity)).not.toBe(
      nativeRebaseCheckpointRef({ ...identity, headSha: sha("1") }),
    );
    expect(own).not.toBe(
      nativeRebaseResourceOwnership(
        { ...identity, headSha: sha("1") },
        f.args.validation.artifactDigest,
      ),
    );
    expect(nativeRebaseIdentityDigest(identity)).toBe(
      nativeRebaseIdentityDigest({ ...identity, repository: "Owner/Repository" }),
    );
  });

  it("rejects forged observed source and rebased commit parents or trees before writing", async () => {
    for (const which of ["sourceHeadSha", "headSha"] as const) {
      for (const change of [
        { treeOid: sha("0") },
        { parentOids: [sha("0")] },
        { parentOids: [sha("d"), sha("a")] },
      ]) {
        const f = fixture();
        const key = f.args.identity[which];
        f.store.commits.set(key, { ...f.store.commits.get(key)!, ...change });
        await expect(f.manager.persist(f.args)).rejects.toThrow("observed Git head");
        expect(f.store.writes).toEqual([]);
      }
    }
  });

  it("requires exact resource ownership, interval and pinned environment", async () => {
    const changes = [
      { invocationOwnershipDigest: digest("9") },
      { sandboxMilliseconds: 1000 },
      { completedAt: new Date(now.getTime() - 500).toISOString(), sandboxMilliseconds: 0 },
    ];
    for (const change of changes) {
      const f = fixture();
      await expect(
        f.manager.persist({
          ...f.args,
          isolatedResource: { ...f.args.isolatedResource, ...change },
        }),
      ).rejects.toThrow();
      expect(f.store.writes).toEqual([]);
    }
    const f = fixture();
    const { digest: _old, ...fields } = f.args.validation;
    await expect(
      f.manager.persist({
        ...f.args,
        validation: createValidationEvidence({ ...fields, environmentIdentity: "node:latest" }),
      }),
    ).rejects.toThrow();
    expect(f.store.writes).toEqual([]);
  });

  it("rejects a self-consistent failed validation or contradictory command outcome", async () => {
    for (const changes of [
      { passed: false },
      { commands: [{ command: "npm test", exitCode: 1, durationMs: 1 }] },
      { failureReason: "failed" },
    ]) {
      const f = fixture();
      const { digest: _old, ...fields } = f.args.validation;
      await expect(
        f.manager.persist({
          ...f.args,
          validation: createValidationEvidence({ ...fields, ...changes }),
        }),
      ).rejects.toThrow();
      expect(f.store.writes).toEqual([]);
    }
  });

  it("rejects byte tampering, divergent cost and checkpoint parent substitution on replay", async () => {
    const f = fixture();
    const record = await f.manager.persist(f.args);
    await expect(
      f.manager.persist({
        ...f.args,
        isolatedResource: {
          ...f.args.isolatedResource,
          completedAt: new Date(now.getTime() + 3100).toISOString(),
          sandboxMilliseconds: 3100,
        },
      }),
    ).rejects.toThrow("conflicting immutable checkpoint");
    const original = f.store.blobs.get(record.blobOid)!;
    f.store.blobs.set(record.blobOid, Buffer.from(`${original.toString()} `));
    await expect(f.manager.load(f.args.identity)).rejects.toThrow("noncanonical");
    f.store.blobs.set(record.blobOid, original);
    const commit = f.store.commits.get(record.commitOid)!;
    f.store.commits.set(record.commitOid, { ...commit, parentOids: [sha("a")] });
    await expect(f.manager.load(f.args.identity)).rejects.toThrow("checkpoint parent");
  });

  it("retains distinct controller and sandbox clocks without inventing time normalization", async () => {
    const f = fixture();
    const { digest: _old, ...fields } = f.args.validation;
    const validation = createValidationEvidence({
      ...fields,
      startedAt: new Date(now.getTime() + 3600000).toISOString(),
      completedAt: new Date(now.getTime() + 3602000).toISOString(),
    });
    const record = await f.manager.persist({ ...f.args, validation });
    expect(record.validation.startedAt).toBe(validation.startedAt);
    expect(record.isolatedResource).toEqual(f.args.isolatedResource);
  });

  it("rejects backwards sandbox command timestamps despite a valid controller lifetime", async () => {
    const f = fixture();
    const { digest: _old, ...fields } = f.args.validation;
    const validation = createValidationEvidence({
      ...fields,
      completedAt: new Date(now.getTime() - 1000).toISOString(),
    });
    await expect(f.manager.persist({ ...f.args, validation })).rejects.toThrow("interval");
    expect(f.store.writes).toEqual([]);
  });

  it("rejects oversized or unknown checkpoint fields and a substituted identity ref", async () => {
    const f = fixture();
    const record = await f.manager.persist(f.args);
    const original = f.store.blobs.get(record.blobOid)!;
    f.store.blobs.set(record.blobOid, Buffer.alloc(512 * 1024 + 1, " "));
    await expect(f.manager.load(f.args.identity)).rejects.toThrow("512 KiB");
    f.store.blobs.set(
      record.blobOid,
      Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), trusted: true })),
    );
    await expect(f.manager.load(f.args.identity)).rejects.toThrow();
    f.store.blobs.set(record.blobOid, original);
    const other = { ...f.args.identity, workItem: 10 };
    f.store.refs.set(nativeRebaseCheckpointRef(other), record.commitOid);
    await expect(f.manager.load(other)).rejects.toThrow("reference identity");
  });
});
