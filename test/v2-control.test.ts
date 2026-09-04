import { describe, expect, it } from "vitest";

import {
  cancellationRequestFromComments,
  objectiveSubIssueQuerySize,
} from "../src/github.js";

import {
  AttemptManager,
  type AttemptStore,
} from "../src/control/attempts.js";
import {
  factoryCommentIssueNumber,
  GitHubControlStore,
} from "../src/control/github-store.js";
import {
  LeaseLostError,
  LeaseManager,
  type GitCommitObject,
  type LeaseStore,
} from "../src/control/lease.js";
import { encodeEventComment } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { policyDigest, DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import { RunManager, type RunState } from "../src/control/runs.js";
import { LeaseController } from "../src/supervisor.js";

const BASE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);

class MemoryStore implements LeaseStore, AttemptStore {
  now = new Date("2026-09-03T00:00:00.000Z");
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>();
  comments: Array<{ issue: string; body: string }> = [];
  readRefCalls = 0;
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
    this.readRefCalls += 1;
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
  it("accepts an in-flight operation from the same renewed lease generation", async () => {
    const store = new MemoryStore();
    const manager = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const acquired = await manager.acquire(identity, base);
    expect(acquired.epoch).toBe(1);
    expect(acquired.sequence).toBe(1);

    const renewed = await manager.renew(acquired);
    expect(renewed.epoch).toBe(1);
    expect(renewed.sequence).toBe(2);
    await expect(manager.assertCurrent(acquired)).resolves.toBeUndefined();
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

  it("renews while a same-generation operation is still in flight", async () => {
    const store = new MemoryStore();
    const manager = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const acquired = await manager.acquire(identity, base);
    let sequence = acquired.sequence + 1;
    const controller = new LeaseController(manager, acquired, {
      take: () => sequence++,
    });
    let finishOperation!: () => void;
    const operationCanFinish = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const operation = controller.use(async (lease) => {
      operationStarted();
      await operationCanFinish;
      await manager.assertCurrent(lease);
    });
    await started;

    await controller.renewIfNeeded(true);
    finishOperation();
    await operation;
  });

  it("rechecks the lease before every admitted mutation", async () => {
    const store = new MemoryStore();
    const manager = new LeaseManager({ store, durationMs: 7 * 86_400_000 });
    const base = await store.readCommit(BASE_SHA);
    const acquired = await manager.acquire(identity, base);
    const controller = new LeaseController(manager, acquired, { take: () => 2 });
    store.readRefCalls = 0;

    await controller.guardMutation(0);
    expect(store.readRefCalls).toBe(1);

    await controller.guardMutation(30_000);
    expect(store.readRefCalls).toBe(2);

    const leaseFailure = new Error("heartbeat failed");
    controller.fail(leaseFailure);
    await expect(controller.guardMutation(0)).rejects.toBe(leaseFailure);
    expect(store.readRefCalls).toBe(2);
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
    store.now = new Date(lease.expiresAt.getTime() + 1);
    await leases.acquire(
      { ...identity, runId: "run-2", holder: "host-2" },
      base,
    );
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

describe("Objective snapshot query sizing", () => {
  it("prices nested connections for observed Work Items, not the protocol maximum", () => {
    expect(objectiveSubIssueQuerySize(0)).toBe(1);
    expect(objectiveSubIssueQuerySize(8)).toBe(8);
    expect(objectiveSubIssueQuerySize(100)).toBe(100);
    expect(() => objectiveSubIssueQuerySize(101)).toThrow(/more than 100/);
    expect(() => objectiveSubIssueQuerySize(1.5)).toThrow(/invalid/);
  });
});

describe("Factory event comment routing", () => {
  const terminal = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunCancelled",
    objective: 14,
    runId: "run-1",
    sequence: 1,
    at: "2026-09-03T00:00:00.000Z",
  });
  const attempt = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event: "AttemptStarted",
    objective: 14,
    workItem: 22,
    attempt: 1,
    runId: "run-1",
    sequence: 2,
    at: "2026-09-03T00:00:01.000Z",
    backend: "codex-cli/local-worktree",
    baseSha: BASE_SHA,
    directorEpoch: 1,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
  });

  it("routes Objective and Work Item events from their validated envelopes", () => {
    expect(factoryCommentIssueNumber(encodeEventComment("terminal", terminal))).toBe(14);
    expect(factoryCommentIssueNumber(encodeEventComment("started", attempt))).toBe(22);
  });

  it("rejects comments without exactly one Factory event", () => {
    const body = encodeEventComment("terminal", terminal);
    expect(() => factoryCommentIssueNumber("ordinary comment")).toThrow(/exactly one/);
    expect(() => factoryCommentIssueNumber(`${body}\n${body}`)).toThrow(/exactly one/);
  });

  it("writes durable events through the issue comments REST endpoint", async () => {
    const requests: Request[] = [];
    const mutationClasses: string[] = [];
    const requestFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          date: "Thu, 03 Sep 2026 00:00:00 GMT",
        },
      });
    };
    const store = new GitHubControlStore({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch,
      mutationScheduler: {
        async acquire(kind = "normal") {
          mutationClasses.push(kind);
          return { waitedMs: 0, release() {} };
        },
      },
    });
    const body = encodeEventComment("started", attempt);

    await store.addIssueComment("unused-node-id", body);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/clockgrove/factory/issues/22/comments",
    );
    expect(await requests[0]!.text()).toBe(JSON.stringify({ body }));
    expect(mutationClasses).toEqual(["normal"]);
  });

  it("observes a ref and authoritative server time in one GitHub request", async () => {
    let requests = 0;
    const store = new GitHubControlStore({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch: async () => {
        requests += 1;
        return new Response(JSON.stringify({ object: { sha: BASE_SHA } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            date: "Thu, 03 Sep 2026 00:00:00 GMT",
          },
        });
      },
    });

    await expect(store.readRefWithServerTime("refs/heads/main")).resolves.toEqual({
      oid: BASE_SHA,
      serverTime: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(requests).toBe(1);
  });

  it("admits lease commits through the reserved mutation class", async () => {
    const mutationClasses: string[] = [];
    const requestFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ sha: BASE_SHA }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          date: "Thu, 03 Sep 2026 00:00:00 GMT",
        },
      });
    const store = new GitHubControlStore({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch,
      mutationScheduler: {
        async acquire(kind = "normal") {
          mutationClasses.push(kind);
          return { waitedMs: 0, release() {} };
        },
      },
    });

    await store.createCommit({
      treeOid: TREE_SHA,
      parentOids: [BASE_SHA],
      message: "Factory lease LeaseRenewed for Objective #14",
    });

    expect(mutationClasses).toEqual(["lease"]);
  });
});
