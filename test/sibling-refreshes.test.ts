import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import {
  MAX_SIBLING_REFRESH_CHECKPOINT_BYTES,
  MAX_SIBLING_REFRESH_LINEAGE,
  SiblingRefreshStore,
  loadSiblingRefresh,
  loadSiblingRefreshLineage,
  siblingRefreshIdentityDigest,
  siblingRefreshRef,
  verifyPlannedSiblingRefreshCommit,
  type SiblingRefreshIdentity,
  type SiblingRefreshRecord,
} from "../src/control/sibling-refreshes.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const now = new Date("2026-09-05T00:00:00Z");
class Store implements CompiledGraphStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>();
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  writes: string[] = [];
  fenced = false;
  validLease = true;
  loseAfter: string | undefined;
  loseLeaseAfter: string | undefined;
  competingOid: string | undefined;
  counter = 0;
  async assertCurrent() {
    if (!this.validLease) throw new Error("lease lost");
    this.fenced = true;
  }
  private before(kind: string) {
    expect(this.fenced, `fence before ${kind}`).toBe(true);
    this.fenced = false;
    this.writes.push(kind);
    return sha(`${kind}-${this.counter++}`);
  }
  private after(kind: string) {
    if (this.loseLeaseAfter === kind) this.validLease = false;
    if (this.loseAfter === kind) {
      this.loseAfter = undefined;
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
    const blob = this.blobs.get(oid);
    if (!blob) throw new Error("blob unavailable");
    return Buffer.from(blob);
  }
  async readTreeEntry(tree: string, path: string) {
    return this.trees.get(tree)?.get(path) ?? null;
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
    const kind = args.parentOids.length === 2 ? "planned-head" : "checkpoint";
    const oid = this.before(kind);
    this.commits.set(oid, { ...args, oid, serverTime: now });
    this.after(kind);
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
  const base = sha("base"),
    head = sha("published"),
    target = sha("target");
  store.commits.set(base, {
    oid: base,
    treeOid: sha("base-tree"),
    parentOids: [],
    message: "base",
    serverTime: now,
  });
  store.commits.set(head, {
    oid: head,
    treeOid: sha("source-tree"),
    parentOids: [base],
    message: "publication",
    serverTime: now,
  });
  store.commits.set(target, {
    oid: target,
    treeOid: sha("target-tree"),
    parentOids: [base],
    message: "target",
    serverTime: now,
  });
  const source = bindValidationToPublishedHead({
    validation: {
      passed: true,
      digest: digest("validation"),
      baseSha: base,
      outputTreeSha: sha("source-tree"),
    },
    publishedBaseSha: base,
    publishedTreeSha: sha("source-tree"),
    publishedHeadSha: head,
  });
  const identity: SiblingRefreshIdentity = {
    repository: "example/disposable",
    runId: "original",
    sourceRunId: "original",
    controllingPolicyDigest: digest("policy"),
    objective: 7,
    workItem: 8,
    attempt: 1,
    pullRequest: 9,
    pullRequestNodeId: "PR_node_9",
    branch: "factory/objective-7/work-item-8/attempt-1",
    reservationRef: "refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-1",
    reservationOid: sha("reservation"),
    leaseEpoch: 2,
    policyDigest: digest("policy"),
    sourcePublicationDigest: digest("publication"),
    sourceHeadSha: head,
    sourceExactHeadValidationDigest: source.digest,
    targetBaseSha: target,
  };
  const event = {
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event: "AttemptReserved",
    objective: 7,
    workItem: 8,
    attempt: 1,
    runId: "original",
    sequence: 4,
    at: now.toISOString(),
    directorEpoch: 2,
    policyDigest: identity.policyDigest,
    baseSha: base,
    backend: "codex-sdk/local-worktree",
  };
  store.refs.set(identity.reservationRef, identity.reservationOid);
  store.commits.set(identity.reservationOid, {
    oid: identity.reservationOid,
    treeOid: sha("base-tree"),
    parentOids: [base],
    message: `reservation\n\nFactory-Event: ${Buffer.from(JSON.stringify(event)).toString("base64url")}`,
    serverTime: now,
  });
  const lease: LeaseState = {
    objective: 7,
    runId: "original",
    holder: "operator",
    policyDigest: identity.policyDigest,
    epoch: 2,
    sequence: 1,
    ref: "refs/clockgrove-factory/leases/objective-7",
    oid: sha("lease"),
    treeOid: sha("lease-tree"),
    expiresAt: new Date(now.getTime() + 600000),
  };
  return {
    store,
    event,
    manager: new SiblingRefreshStore(store, store as unknown as LeaseManager),
    args: {
      lease,
      identity,
      source,
      expectedOldHeadSha: head,
      outputTreeSha: sha("combined-tree"),
    },
  };
}
async function next(f: ReturnType<typeof fixture>, previous: SiblingRefreshRecord, index: number) {
  const target = sha(`target-${index}`);
  f.store.commits.set(target, {
    oid: target,
    treeOid: sha(`target-tree-${index}`),
    parentOids: [previous.identity.targetBaseSha],
    message: "next target",
    serverTime: now,
  });
  return f.manager.persist({
    ...f.args,
    identity: { ...f.args.identity, targetBaseSha: target },
    expectedOldHeadSha: previous.plannedHeadSha,
    previous: {
      ref: previous.ref,
      commitOid: previous.commitOid,
      identityDigest: previous.identityDigest,
    },
  });
}
function mutateDocument(
  f: ReturnType<typeof fixture>,
  record: SiblingRefreshRecord,
  change: (value: { identity: SiblingRefreshIdentity }) => void,
) {
  const value = JSON.parse(f.store.blobs.get(record.blobOid)!.toString("utf8"));
  change(value);
  f.store.blobs.set(record.blobOid, Buffer.from(JSON.stringify(value)));
}

describe("immutable native sibling refresh intent", () => {
  it("writes a planned exact two-parent head before the immutable intent, without branch mutation", async () => {
    const f = fixture();
    const original = structuredClone(f.args);
    const record = await f.manager.persist(f.args);
    expect(f.args).toEqual(original);
    expect(f.store.writes).toEqual(["planned-head", "blob", "tree", "checkpoint", "ref"]);
    expect(await f.store.readCommit(record.plannedHeadSha)).toMatchObject({
      treeOid: f.args.outputTreeSha,
      parentOids: [f.args.expectedOldHeadSha, f.args.identity.targetBaseSha],
    });
    expect([...f.store.refs.keys()]).toEqual([
      f.args.identity.reservationRef,
      siblingRefreshRef(f.args.identity),
    ]);
    await verifyPlannedSiblingRefreshCommit(f.store, record);
  });
  it("loads an existing intent before creating any new Git objects, including takeover", async () => {
    const f = fixture();
    const first = await f.manager.persist(f.args);
    f.store.writes = [];
    expect(await f.manager.persist({ ...f.args, lease: { ...f.args.lease, epoch: 3 } })).toEqual(
      first,
    );
    expect(await loadSiblingRefresh(f.store, f.args.identity)).toEqual(first);
    expect(f.store.writes).toEqual([]);
  });
  it("recovers a lost immutable ref creation response without another planned head", async () => {
    const f = fixture();
    f.store.loseAfter = "ref";
    const first = await f.manager.persist(f.args);
    expect(await f.manager.persist(f.args)).toEqual(first);
    expect(f.store.writes.filter((entry) => entry === "planned-head")).toHaveLength(1);
  });
  it.each(["planned-head", "blob", "tree", "checkpoint"])(
    "does not grant branch authority after unknown %s response",
    async (kind) => {
      const f = fixture();
      f.store.loseAfter = kind;
      await expect(f.manager.persist(f.args)).rejects.toThrow(/response lost/);
      expect(await f.manager.load(f.args.identity)).toBeNull();
      expect([...f.store.refs.keys()]).toEqual([f.args.identity.reservationRef]);
    },
  );
  it.each(["planned-head", "blob", "tree", "checkpoint"])(
    "fences every subsequent write after lease loss at %s",
    async (kind) => {
      const f = fixture();
      f.store.loseLeaseAfter = kind;
      await expect(f.manager.persist(f.args)).rejects.toThrow(/lease lost/);
      expect(f.store.writes.at(-1)).toBe(kind);
      expect(await f.store.readRef(siblingRefreshRef(f.args.identity))).toBeNull();
    },
  );
  it("does not accept a competing checkpoint merely because ref creation returned false", async () => {
    const f = fixture();
    f.store.competingOid = sha("foreign");
    await expect(f.manager.persist(f.args)).rejects.toThrow(/unavailable/);
  });
  it.each(["expectedOldHeadSha", "outputTreeSha"] as const)(
    "rejects conflicting immutable %s without new objects",
    async (key) => {
      const f = fixture();
      await f.manager.persist(f.args);
      f.store.writes = [];
      await expect(f.manager.persist({ ...f.args, [key]: sha("changed") })).rejects.toThrow(
        /conflicting/,
      );
      expect(f.store.writes).toEqual([]);
    },
  );
  it.each(["runId", "policyDigest", "objective"] as const)(
    "rejects a foreign controlling lease %s",
    async (key) => {
      const f = fixture();
      const lease = {
        ...f.args.lease,
        [key]: key === "objective" ? 99 : key === "policyDigest" ? digest("foreign") : "foreign",
      };
      await expect(f.manager.persist({ ...f.args, lease })).rejects.toThrow(/lease scope/);
      expect(f.store.writes).toEqual([]);
    },
  );
  it.each(["branch", "reservationRef"] as const)("rejects non-Factory %s", async (key) => {
    const f = fixture();
    await expect(
      f.manager.persist({ ...f.args, identity: { ...f.args.identity, [key]: "refs/heads/main" } }),
    ).rejects.toThrow();
    expect(f.store.writes).toEqual([]);
  });
  it.each(["sourceRunId", "leaseEpoch", "policyDigest"] as const)(
    "checks original reservation %s independently",
    async (key) => {
      const f = fixture();
      const identity = {
        ...f.args.identity,
        runId: "successor",
        controllingPolicyDigest: digest("successor"),
        [key]: key === "leaseEpoch" ? 5 : key === "policyDigest" ? digest("wrong") : "wrong",
      };
      await expect(
        f.manager.persist({
          ...f.args,
          identity,
          lease: {
            ...f.args.lease,
            runId: "successor",
            policyDigest: identity.controllingPolicyDigest,
          },
        }),
      ).rejects.toThrow(/source reservation/);
      expect(f.store.writes).toEqual([]);
    },
  );
  it("rejects source ref rewrites and changed original published trees", async () => {
    const f = fixture();
    f.store.refs.set(f.args.identity.reservationRef, sha("changed"));
    await expect(f.manager.persist(f.args)).rejects.toThrow(/reservation ref/);
    f.store.refs.set(f.args.identity.reservationRef, f.args.identity.reservationOid);
    f.store.commits.get(f.args.identity.sourceHeadSha)!.treeOid = sha("changed");
    await expect(f.manager.persist(f.args)).rejects.toThrow(/original publication/);
    expect(f.store.writes).toEqual([]);
  });
  it("rejects invented exact-head validation and unknown schema fields", async () => {
    const f = fixture();
    await expect(
      f.manager.persist({ ...f.args, source: { ...f.args.source, digest: digest("fake") } }),
    ).rejects.toThrow(/digest/);
    expect(() =>
      siblingRefreshIdentityDigest({
        ...f.args.identity,
        unproved: true,
      } as SiblingRefreshIdentity),
    ).toThrow();
  });
});

describe("read-only refresh proof and bounded lineage", () => {
  it("rejects unchanged source base before writing a planned head", async () => {
    const f = fixture();
    await expect(
      f.manager.persist({
        ...f.args,
        identity: { ...f.args.identity, targetBaseSha: f.args.source.baseSha },
      }),
    ).rejects.toThrow(/advanced base/);
    expect(f.store.writes).toEqual([]);
  });
  it("rejects a foreign previous pointer and unbound expected head before writes", async () => {
    const f = fixture();
    const first = await f.manager.persist(f.args);
    f.store.writes = [];
    const identity = { ...f.args.identity, targetBaseSha: sha("target-other") };
    for (const previous of [
      { ref: first.ref, commitOid: sha("foreign"), identityDigest: first.identityDigest },
      { ref: first.ref, commitOid: first.commitOid, identityDigest: digest("foreign") },
    ])
      await expect(
        f.manager.persist({
          ...f.args,
          identity,
          previous,
          expectedOldHeadSha: first.plannedHeadSha,
        }),
      ).rejects.toThrow(/ownership/);
    await expect(
      f.manager.persist({ ...f.args, identity, expectedOldHeadSha: first.plannedHeadSha }),
    ).rejects.toThrow(/unbound/);
    expect(f.store.writes).toEqual([]);
  });
  it("rechecks reservation proof even when an existing intent can be reused", async () => {
    const f = fixture();
    await f.manager.persist(f.args);
    f.store.writes = [];
    const event = { ...f.event, policyDigest: digest("foreign") };
    f.store.commits.get(f.args.identity.reservationOid)!.message =
      `Factory-Event: ${Buffer.from(JSON.stringify(event)).toString("base64url")}`;
    await expect(f.manager.persist(f.args)).rejects.toThrow(/reservation identity/);
    expect(f.store.writes).toEqual([]);
  });
  it("rejects a checkpoint with a different target parent or missing document", async () => {
    const f = fixture();
    const record = await f.manager.persist(f.args);
    const commit = f.store.commits.get(record.commitOid)!;
    commit.parentOids = [sha("wrong")];
    await expect(f.manager.load(record.identity)).rejects.toThrow(/target parent/);
    commit.parentOids = [record.identity.targetBaseSha];
    f.store.trees.get(commit.treeOid)!.clear();
    await expect(f.manager.load(record.identity)).rejects.toThrow(/missing checkpoint/);
  });
  it("verifies the exact immutable parent chain oldest to newest", async () => {
    const f = fixture();
    const first = await f.manager.persist(f.args);
    const second = await next(f, first, 2);
    expect(
      (await loadSiblingRefreshLineage(f.store, second)).map((record) => record.commitOid),
    ).toEqual([first.commitOid, second.commitOid]);
    expect(second.source).toEqual(first.source);
    expect(second.expectedOldHeadSha).toBe(first.plannedHeadSha);
  });
  it("permits structurally bound successor lineage without pretending to prove recovery admission", async () => {
    const f = fixture();
    const first = await f.manager.persist(f.args);
    const identity = {
      ...f.args.identity,
      runId: "successor",
      controllingPolicyDigest: digest("successor"),
      targetBaseSha: sha("new-target"),
    };
    f.store.commits.set(identity.targetBaseSha, {
      oid: identity.targetBaseSha,
      treeOid: sha("tree"),
      parentOids: [first.identity.targetBaseSha],
      message: "target",
      serverTime: now,
    });
    const record = await f.manager.persist({
      ...f.args,
      identity,
      lease: {
        ...f.args.lease,
        runId: "successor",
        epoch: 1,
        policyDigest: identity.controllingPolicyDigest,
      },
      expectedOldHeadSha: first.plannedHeadSha,
      previous: {
        ref: first.ref,
        commitOid: first.commitOid,
        identityDigest: first.identityDigest,
      },
    });
    expect((await loadSiblingRefreshLineage(f.store, record)).length).toBe(2);
    expect(record.identity.leaseEpoch).toBe(2);
    expect(record.identity.sourceRunId).toBe("original");
  });
  it.each([
    "pullRequest",
    "pullRequestNodeId",
    "repository",
    "sourcePublicationDigest",
    "sourceRunId",
    "policyDigest",
  ] as const)("rejects foreign %s lineage", async (key) => {
    const f = fixture();
    const first = await f.manager.persist(f.args);
    const target = sha("target-2");
    const identity = {
      ...f.args.identity,
      targetBaseSha: target,
      [key]:
        key === "pullRequest"
          ? 99
          : key.includes("Digest")
            ? digest("other")
            : key === "repository"
              ? "other/repo"
              : "other",
    };
    await expect(
      f.manager.persist({
        ...f.args,
        identity,
        expectedOldHeadSha: first.plannedHeadSha,
        previous: {
          ref: first.ref,
          commitOid: first.commitOid,
          identityDigest: first.identityDigest,
        },
      }),
    ).rejects.toThrow();
  });
  it.each(["tree", "parent-count", "old-parent", "target-parent", "oid"])(
    "rejects changed planned commit %s",
    async (kind) => {
      const f = fixture();
      const record = await f.manager.persist(f.args);
      const commit = f.store.commits.get(record.plannedHeadSha)!;
      if (kind === "tree") commit.treeOid = sha("other");
      else if (kind === "oid") commit.oid = sha("other");
      else if (kind === "parent-count") commit.parentOids.push(sha("other"));
      else commit.parentOids[kind === "old-parent" ? 0 : 1] = sha("other");
      await expect(verifyPlannedSiblingRefreshCommit(f.store, record)).rejects.toThrow(
        /planned commit/,
      );
    },
  );
  it("rejects a changed checkpoint ref, prior pointer or passed record", async () => {
    const f = fixture();
    const first = await f.manager.persist(f.args);
    const second = await next(f, first, 2);
    await expect(
      verifyPlannedSiblingRefreshCommit(f.store, { ...second, outputTreeSha: sha("other") }),
    ).rejects.toThrow(/ownership/);
    f.store.refs.set(first.ref, second.commitOid);
    await expect(f.manager.load(second.identity)).rejects.toThrow(/reference identity/);
  });
  it("rejects unbounded or noncanonical documents before accepting ownership", async () => {
    const f = fixture();
    const record = await f.manager.persist(f.args);
    const original = f.store.blobs.get(record.blobOid)!;
    f.store.blobs.set(record.blobOid, Buffer.alloc(MAX_SIBLING_REFRESH_CHECKPOINT_BYTES + 1, 32));
    await expect(f.manager.load(record.identity)).rejects.toThrow(/byte bound/);
    f.store.blobs.set(record.blobOid, Buffer.concat([original, Buffer.from("\n")]));
    await expect(f.manager.load(record.identity)).rejects.toThrow(/noncanonical/);
  });
  it("rejects checkpoint identity corruption even under the originally correct ref", async () => {
    const f = fixture();
    const record = await f.manager.persist(f.args);
    mutateDocument(f, record, (value) => {
      value.identity.pullRequest = 10;
    });
    await expect(f.manager.load(record.identity)).rejects.toThrow(/identity digest/);
  });
  it("bounds retained lineage and rejects an extra refresh before new object creation", async () => {
    const f = fixture();
    let record = await f.manager.persist(f.args);
    for (let i = 1; i < MAX_SIBLING_REFRESH_LINEAGE; i++) record = await next(f, record, i);
    expect((await loadSiblingRefreshLineage(f.store, record)).length).toBe(
      MAX_SIBLING_REFRESH_LINEAGE,
    );
    f.store.writes = [];
    await expect(next(f, record, MAX_SIBLING_REFRESH_LINEAGE)).rejects.toThrow(/bound/);
    expect(f.store.writes).toEqual([]);
  });
});
