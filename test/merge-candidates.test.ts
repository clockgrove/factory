import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import {
  MAX_MERGE_CANDIDATE_CHECKPOINT_BYTES,
  MergeCandidateCheckpointStore,
  loadMergeCandidateCheckpoint,
  mergeCandidateCheckpointRef,
  mergeCandidateIdentityDigest,
  type MergeCandidateIdentity,
} from "../src/control/merge-candidates.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const now = new Date("2026-09-05T00:00:00Z");
class Store implements CompiledGraphStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>([
    [
      sha("d"),
      { oid: sha("d"), treeOid: sha("f"), parentOids: [], message: "base", serverTime: now },
    ],
  ]);
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  writes: string[] = [];
  fenced = false;
  validLease = true;
  loseAfter: string | null = null;
  loseLeaseAfter: string | null = null;
  competingOid: string | null = null;
  private counter = 0;
  async assertCurrent() {
    if (!this.validLease) throw new Error("lease lost");
    this.fenced = true;
  }
  private before(kind: string) {
    expect(this.fenced, `lease fence before ${kind}`).toBe(true);
    this.fenced = false;
    this.writes.push(kind);
    return createHash("sha1")
      .update(`${kind}:${this.counter++}`)
      .digest("hex");
  }
  private after(kind: string) {
    if (this.loseLeaseAfter === kind) this.validLease = false;
    if (this.loseAfter === kind) {
      this.loseAfter = null;
      throw new Error("response lost");
    }
  }
  async readRef(ref: string) {
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string) {
    const value = this.commits.get(oid);
    if (!value) throw new Error("commit unavailable");
    return structuredClone(value);
  }
  async readBlob(oid: string) {
    const value = this.blobs.get(oid);
    if (!value) throw new Error("blob unavailable");
    return Buffer.from(value);
  }
  async readTreeEntry(oid: string, path: string) {
    return this.trees.get(oid)?.get(path) ?? null;
  }
  async createBlob(content: Buffer) {
    const oid = this.before("blob");
    this.blobs.set(oid, Buffer.from(content));
    this.after("blob");
    return oid;
  }
  async createTree(args: Parameters<CompiledGraphStore["createTree"]>[0]) {
    const oid = this.before("tree");
    this.trees.set(
      oid,
      new Map(args.entries.filter((entry) => entry.sha).map((entry) => [entry.path, entry.sha!])),
    );
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
    if (this.competingOid) this.refs.set(ref, this.competingOid);
    const created = !this.refs.has(ref);
    if (created) this.refs.set(ref, oid);
    this.after("ref");
    return created;
  }
}
function fixture() {
  const store = new Store();
  const source = bindValidationToPublishedHead({
    validation: { passed: true, digest: digest("a"), baseSha: sha("a"), outputTreeSha: sha("b") },
    publishedBaseSha: sha("a"),
    publishedTreeSha: sha("b"),
    publishedHeadSha: sha("c"),
  });
  const validation = createValidationEvidence({
    protocol: "clockgrove.factory/validation-v1",
    artifactDigest: digest("d"),
    baseSha: sha("d"),
    outputTreeSha: sha("e"),
    commands: [{ command: "npm test", exitCode: 0, durationMs: 5 }],
    passed: true,
    startedAt: now.toISOString(),
    completedAt: new Date(now.getTime() + 1000).toISOString(),
  });
  const identity: MergeCandidateIdentity = {
    runId: "source",
    objective: 7,
    workItem: 8,
    attempt: 1,
    pullRequest: 9,
    sourceHeadSha: source.publishedHeadSha,
    sourceExactHeadValidationDigest: source.digest,
    targetBaseSha: validation.baseSha,
  };
  const lease: LeaseState = {
    objective: 7,
    runId: "source",
    holder: "operator",
    policyDigest: digest("e"),
    ref: "refs/clockgrove-factory/leases/objective-7",
    oid: sha("1"),
    treeOid: sha("2"),
    epoch: 1,
    sequence: 1,
    expiresAt: new Date(now.getTime() + 600000),
  };
  return {
    store,
    manager: new MergeCandidateCheckpointStore(store, store as unknown as LeaseManager),
    args: { lease, identity, source, validation },
  };
}
function rerun(
  input: ReturnType<typeof fixture>["args"]["validation"],
  extra: Record<string, unknown> = {},
) {
  const { digest: _digest, ...fields } = input;
  return createValidationEvidence({ ...fields, ...extra });
}

describe("immutable merge-candidate validation checkpoints", () => {
  it("persists exact isolated resource completion across restart and refuses changed ownership", async () => {
    const f = fixture();
    const isolatedResource = {
      backend: "codex-cli/daytona" as const,
      invocationOwnershipDigest: digest("c"),
      startedAt: now.toISOString(),
      completedAt: new Date(now.getTime() + 3000).toISOString(),
      sandboxMilliseconds: 3000,
    };
    const first = await f.manager.persist({ ...f.args, isolatedResource });
    expect((await f.manager.load(f.args.identity))?.isolatedResource).toEqual(isolatedResource);
    expect((await f.manager.persist({ ...f.args, isolatedResource })).commitOid).toBe(
      first.commitOid,
    );
    await expect(
      f.manager.persist({
        ...f.args,
        isolatedResource: { ...isolatedResource, invocationOwnershipDigest: digest("f") },
      }),
    ).rejects.toThrow(/conflicting/);
    await expect(f.manager.persist(f.args)).rejects.toThrow(/conflicting/);
  });
  it("rejects invented or negative resource lifetime before checkpoint writes", async () => {
    const f = fixture();
    await expect(
      f.manager.persist({
        ...f.args,
        isolatedResource: {
          backend: "codex-cli/daytona",
          invocationOwnershipDigest: digest("c"),
          startedAt: now.toISOString(),
          completedAt: new Date(now.getTime() + 3000).toISOString(),
          sandboxMilliseconds: 100,
        },
      }),
    ).rejects.toThrow(/duration/);
    expect(f.store.writes).toEqual([]);
  });
  it("persists complete bound evidence with the target base as its sole parent and no artifact patch", async () => {
    const f = fixture();
    const record = await f.manager.persist(f.args);
    expect(record).toMatchObject({
      identity: f.args.identity,
      source: f.args.source,
      validation: f.args.validation,
      evidence: {
        sourceHeadSha: sha("c"),
        targetBaseSha: sha("d"),
        candidateOutputTreeSha: sha("e"),
      },
    });
    expect(f.store.commits.get(record.commitOid)?.parentOids).toEqual([sha("d")]);
    expect(f.store.writes).toEqual(["blob", "tree", "commit", "ref"]);
    expect(f.store.blobs.get(record.blobOid)!.toString()).not.toContain('"patch"');
    expect(
      await loadMergeCandidateCheckpoint(
        {
          readRef: f.store.readRef.bind(f.store),
          readCommit: f.store.readCommit.bind(f.store),
          readBlob: f.store.readBlob.bind(f.store),
          readTreeEntry: f.store.readTreeEntry.bind(f.store),
        },
        f.args.identity,
      ),
    ).toEqual(record);
  });

  it("loads before revalidation and retains original timestamps/digest on an identical candidate rerun", async () => {
    const f = fixture();
    const record = await f.manager.persist(f.args);
    expect(await f.manager.load(f.args.identity)).toEqual(record);
    const next = rerun(f.args.validation, {
      startedAt: new Date(now.getTime() + 2000).toISOString(),
      completedAt: new Date(now.getTime() + 3000).toISOString(),
    });
    expect(next.digest).not.toBe(record.validation.digest);
    expect(await f.manager.persist({ ...f.args, validation: next })).toEqual(record);
    expect(f.store.writes).toHaveLength(4);
  });

  it.each([
    "runId",
    "objective",
    "workItem",
    "attempt",
    "pullRequest",
    "sourceHeadSha",
    "sourceExactHeadValidationDigest",
    "targetBaseSha",
  ] as const)("separates identity changes to %s", (field) => {
    const f = fixture();
    const changed = {
      ...f.args.identity,
      [field]:
        typeof f.args.identity[field] === "number"
          ? 99
          : field === "runId"
            ? "other"
            : field.includes("Digest")
              ? digest("f")
              : sha("f"),
    };
    expect(mergeCandidateCheckpointRef(changed)).not.toBe(
      mergeCandidateCheckpointRef(f.args.identity),
    );
    expect(mergeCandidateIdentityDigest(changed)).not.toBe(
      mergeCandidateIdentityDigest(f.args.identity),
    );
  });

  it.each(["blob", "tree", "commit", "ref"])(
    "recovers response loss after %s without replacing an immutable winner",
    async (kind) => {
      const f = fixture();
      f.store.loseAfter = kind;
      if (kind === "ref") await f.manager.persist(f.args);
      else await expect(f.manager.persist(f.args)).rejects.toThrow("response lost");
      const record = await f.manager.persist(f.args);
      expect(await f.manager.load(f.args.identity)).toEqual(record);
      expect(f.store.refs.size).toBe(1);
    },
  );

  it.each(["blob", "tree", "commit"])(
    "stops subsequent writes on lease loss after %s",
    async (kind) => {
      const f = fixture();
      f.store.loseLeaseAfter = kind;
      await expect(f.manager.persist(f.args)).rejects.toThrow("lease lost");
      expect(f.store.writes.at(-1)).toBe(kind);
      expect(f.store.refs.size).toBe(0);
    },
  );

  it.each(["objective", "runId"] as const)(
    "rejects a foreign lease %s before writing",
    async (field) => {
      const f = fixture();
      const lease = { ...f.args.lease, [field]: field === "objective" ? 99 : "other" };
      await expect(f.manager.persist({ ...f.args, lease })).rejects.toThrow("lease scope");
      expect(f.store.writes).toEqual([]);
    },
  );

  it.each([
    "failed",
    "source-head",
    "source-digest",
    "target",
    "validation-digest",
    "extension",
    "oversize",
  ])("rejects %s payload before metadata writes", async (change) => {
    const f = fixture();
    if (change === "failed") f.args.validation = rerun(f.args.validation, { passed: false });
    if (change === "source-head") f.args.identity.sourceHeadSha = sha("f");
    if (change === "source-digest") f.args.identity.sourceExactHeadValidationDigest = digest("f");
    if (change === "target") f.args.identity.targetBaseSha = sha("f");
    if (change === "validation-digest") f.args.validation.digest = digest("f");
    if (change === "extension")
      f.args.validation = rerun(f.args.validation, { patch: "not permitted" });
    if (change === "oversize")
      f.args.validation = rerun(f.args.validation, {
        patch: "x".repeat(MAX_MERGE_CANDIDATE_CHECKPOINT_BYTES),
      });
    await expect(f.manager.persist(f.args)).rejects.toThrow();
    expect(f.store.writes).toEqual([]);
  });

  it.each([
    "source",
    "validation",
    "evidence",
    "identity",
    "identity-digest",
    "extra-field",
    "noncanonical",
    "oversize",
    "missing-blob",
  ])("rejects persisted %s tampering", async (change) => {
    const f = fixture();
    const record = await f.manager.persist(f.args);
    const stored = JSON.parse(f.store.blobs.get(record.blobOid)!.toString());
    if (change === "source") stored.source.outputTreeSha = sha("f");
    if (change === "validation") stored.validation.commands[0].exitCode = 1;
    if (change === "evidence") stored.evidence.candidateOutputTreeSha = sha("f");
    if (change === "identity") stored.identity.pullRequest = 99;
    if (change === "identity-digest") stored.identityDigest = digest("f");
    if (change === "extra-field") stored.patch = "not permitted";
    f.store.blobs.set(
      record.blobOid,
      change === "oversize"
        ? Buffer.alloc(MAX_MERGE_CANDIDATE_CHECKPOINT_BYTES + 1)
        : Buffer.from(JSON.stringify(stored) + (change === "noncanonical" ? "\n" : "")),
    );
    if (change === "missing-blob")
      f.store.trees.get(f.store.commits.get(record.commitOid)!.treeOid)!.clear();
    await expect(f.manager.load(f.args.identity)).rejects.toThrow();
  });

  it.each(["wrong-oid", "wrong-parent", "extra-parent", "foreign-ref"])(
    "rejects %s commit binding",
    async (change) => {
      const f = fixture();
      const record = await f.manager.persist(f.args);
      const commit = f.store.commits.get(record.commitOid)!;
      if (change === "wrong-oid") commit.oid = sha("f");
      if (change === "wrong-parent") commit.parentOids = [sha("f")];
      if (change === "extra-parent") commit.parentOids.push(sha("f"));
      if (change === "foreign-ref") {
        f.args.identity.pullRequest = 99;
        f.store.refs.set(mergeCandidateCheckpointRef(f.args.identity), record.commitOid);
      }
      await expect(f.manager.load(f.args.identity)).rejects.toThrow();
    },
  );

  it.each([false, true])(
    "verifies an immutable ref race winner, conflicting=%s",
    async (conflicting) => {
      const f = fixture();
      const record = await f.manager.persist(f.args);
      f.store.refs.clear();
      f.store.competingOid = record.commitOid;
      if (conflicting) f.args.validation = rerun(f.args.validation, { outputTreeSha: sha("f") });
      if (conflicting)
        await expect(f.manager.persist(f.args)).rejects.toThrow("conflicting immutable candidate");
      else expect(await f.manager.persist(f.args)).toEqual(record);
      expect(f.store.refs.get(record.ref)).toBe(record.commitOid);
    },
  );

  it("does not reinterpret an unreadable ref as an absent checkpoint", async () => {
    const f = fixture();
    f.store.readRef = async () => {
      throw new Error("unavailable");
    };
    await expect(f.manager.persist(f.args)).rejects.toThrow("unavailable");
    expect(f.store.writes).toEqual([]);
  });
});
