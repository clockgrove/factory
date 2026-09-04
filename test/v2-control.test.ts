import { describe, expect, it } from "vitest";

import { cancellationRequestFromComments } from "../src/github.js";

import {
  AttemptManager,
  type AttemptStore,
} from "../src/control/attempts.js";
import {
  LeaseLostError,
  LeaseManager,
  type GitCommitObject,
  type LeaseStore,
} from "../src/control/lease.js";
import { policyDigest, DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import { RunManager, type RunState } from "../src/control/runs.js";

const BASE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);

class MemoryStore implements LeaseStore, AttemptStore {
  now = new Date("2026-09-03T00:00:00.000Z");
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>();
  comments: Array<{ issue: string; body: string }> = [];
  next = 1;

  constructor() {
    this.commits.set(BASE_SHA, {
      oid: BASE_SHA,
      treeOid: TREE_SHA,
      parentOids: [],
      message: "base",
      serverTime: this.now,
    });
  }

  async readRef(ref: string): Promise<string | null> {
    return this.refs.get(ref) ?? null;
  }

  async listRefs(prefix: string): Promise<Array<{ ref: string; oid: string }>> {
    return [...this.refs.entries()]
      .filter(([ref]) => ref.startsWith(prefix))
      .map(([ref, oid]) => ({ ref, oid }));
  }

  async readCommit(oid: string): Promise<GitCommitObject> {
    const commit = this.commits.get(oid);
    if (!commit) throw new Error(`missing commit ${oid}`);
    return commit;
  }

  async createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string> {
    const oid = this.next.toString(16).padStart(40, "0");
    this.next += 1;
    this.commits.set(oid, {
      oid,
      treeOid: args.treeOid,
      parentOids: args.parentOids,
      message: args.message,
      serverTime: this.now,
    });
    return oid;
  }

  async createRef(ref: string, oid: string): Promise<boolean> {
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    return true;
  }

  async compareAndSwapRef(args: {
    ref: string;
    beforeOid: string;
    afterOid: string;
  }): Promise<boolean> {
    if (this.refs.get(args.ref) !== args.beforeOid) return false;
    this.refs.set(args.ref, args.afterOid);
    return true;
  }

  async serverTime(): Promise<Date> {
    return this.now;
  }

  async addIssueComment(issue: string, body: string): Promise<void> {
    this.comments.push({ issue, body });
  }
}

const identity = {
  objective: 42,
  runId: "run-1",
  holder: "host-1",
  policyDigest: policyDigest(DEFAULT_RUN_POLICY),
};

describe("Director lease", () => {
  it("acquires, renews, and fences a stale lease", async () => {
    const store = new MemoryStore();
    const manager = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const acquired = await manager.acquire(identity, base);
    expect(acquired.epoch).toBe(1);
    expect(acquired.sequence).toBe(1);

    const renewed = await manager.renew(acquired);
    expect(renewed.epoch).toBe(1);
    expect(renewed.sequence).toBe(2);
    await expect(manager.assertCurrent(acquired)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(manager.assertCurrent(renewed)).resolves.toBeUndefined();
  });

  it("permits takeover only after server-time expiry and advances the epoch", async () => {
    const store = new MemoryStore();
    const manager = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const first = await manager.acquire(identity, base);
    await expect(
      manager.acquire({ ...identity, runId: "run-2", holder: "host-2" }, base),
    ).rejects.toThrow(/leased by host-1/);

    store.now = new Date(first.expiresAt.getTime() + 1);
    const takeover = await manager.acquire(
      { ...identity, runId: "run-2", holder: "host-2" },
      base,
    );
    expect(takeover.epoch).toBe(2);
    expect(takeover.oid).not.toBe(first.oid);
  });

  it("allows exactly one contender to advance an observed lease OID", async () => {
    const store = new MemoryStore();
    const manager = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const first = await manager.acquire(identity, base);
    store.now = new Date(first.expiresAt.getTime() + 1);

    const results = await Promise.allSettled([
      manager.acquire({ ...identity, runId: "run-a", holder: "host-a" }, base),
      manager.acquire({ ...identity, runId: "run-b", holder: "host-b" }, base),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("records a fenced release that permits immediate takeover", async () => {
    const store = new MemoryStore();
    const manager = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const first = await manager.acquire(identity, base);
    const released = await manager.release(first);
    expect(released.expiresAt).toEqual(store.now);
    await expect(manager.assertCurrent(released)).rejects.toBeInstanceOf(LeaseLostError);
    const takeover = await manager.acquire(
      { ...identity, runId: "run-2", holder: "host-2" },
      base,
    );
    expect(takeover.epoch).toBe(2);
  });
});

describe("attempt reservation", () => {
  it("creates an immutable pre-PR receipt and audit comment", async () => {
    const store = new MemoryStore();
    const leases = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(identity, base);
    const attempts = new AttemptManager({ store, leases });

    const first = await attempts.reserve({
      lease,
      workItem: 43,
      workItemNodeId: "I_43",
      backend: "codex-cli/local-worktree",
      base,
      sequence: 2,
    });
    expect(first.attempt).toBe(1);
    expect(first.baseSha).toBe(BASE_SHA);
    expect(store.refs.get(first.ref)).toBe(first.oid);
    expect(store.comments[0]?.body).toContain("AttemptReserved");

    const second = await attempts.reserve({
      lease,
      workItem: 43,
      workItemNodeId: "I_43",
      backend: "codex-cli/local-worktree",
      base,
      sequence: 3,
    });
    expect(second.attempt).toBe(2);
    expect((await attempts.list(42, 43)).map((attempt) => attempt.attempt)).toEqual([
      1,
      2,
    ]);
  });

  it("refuses reservation after the lease is fenced", async () => {
    const store = new MemoryStore();
    const leases = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(identity, base);
    store.refs.set(lease.ref, "f".repeat(40));
    const attempts = new AttemptManager({ store, leases });
    await expect(
      attempts.reserve({
        lease,
        workItem: 43,
        workItemNodeId: "I_43",
        backend: "codex-cli/local-worktree",
        base,
        sequence: 2,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe("run cancellation", () => {
  const run: RunState = {
    objective: 42,
    runId: "run-1",
    sequence: 1,
    actor: "operator",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    startedAt: new Date("2026-09-03T00:00:00.000Z"),
  };

  it("records an authenticated cancellation request without making the run terminal", async () => {
    const store = new MemoryStore();
    const manager = new RunManager(store);
    const event = await manager.requestCancellation({
      run,
      objectiveNodeId: "I_42",
      actor: "operator",
      sequence: 2,
      reason: "maintenance window",
    });
    expect(event).toMatchObject({
      event: "FactoryRunCancellationRequested",
      requestedBy: "operator",
      reason: "maintenance window",
    });
    expect(manager.resume([{
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "FactoryRunStarted",
      objective: 42,
      runId: "run-1",
      sequence: 1,
      at: run.startedAt.toISOString(),
      actor: run.actor,
      repository: "clockgrove/factory",
      objectiveAuthor: run.actor,
      fork: false,
      baseBranch: "main",
      policy: run.policy,
      policyDigest: run.policyDigest,
    }, event])?.runId).toBe("run-1");

    const body = store.comments[0]!.body;
    expect(cancellationRequestFromComments([{
      body,
      authorLogin: "operator",
      authorAssociation: "OWNER",
    }], run.runId, run.actor)).toEqual(event);
    expect(cancellationRequestFromComments([{
      body,
      authorLogin: "intruder",
      authorAssociation: "OWNER",
    }], run.runId, run.actor)).toBeNull();
    expect(cancellationRequestFromComments([{
      body,
      authorLogin: "operator",
      authorAssociation: "CONTRIBUTOR",
    }], run.runId, run.actor)).toBeNull();
  });

  it("rejects cancellation by a different GitHub identity", async () => {
    const store = new MemoryStore();
    await expect(new RunManager(store).requestCancellation({
      run,
      objectiveNodeId: "I_42",
      actor: "intruder",
      sequence: 2,
    })).rejects.toThrow(/only activating actor/i);
    expect(store.comments).toEqual([]);
  });
});
