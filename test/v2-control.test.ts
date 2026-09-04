import { describe, expect, it } from "vitest";

import { cancellationRequestFromComments, objectiveSubIssueQuerySize } from "../src/github.js";

import { AttemptManager, type AttemptStore } from "../src/control/attempts.js";
import { factoryCommentIssueNumber, GitHubControlStore } from "../src/control/github-store.js";
import {
  LeaseLostError,
  LeaseManager,
  type GitCommitObject,
  type LeaseStore,
} from "../src/control/lease.js";
import { LifecycleRecorder } from "../src/control/events.js";
import { decodeEventComments, encodeEventComment } from "../src/control/receipts.js";
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
  it("emits a fenced durable controller observation", async () => {
    const store = new MemoryStore();
    const manager = new LeaseManager({ store, durationMs: 60_000 });
    const acquired = await manager.acquire(identity, await store.readCommit(BASE_SHA));
    const event = await new LifecycleRecorder(store, manager).controller({
      lease: acquired,
      objectiveNodeId: "objective-node",
      sequence: 2,
      controllerId: "controller-1",
      epoch: 5,
      expiresAt: "2026-09-03T00:05:00.000Z",
      controllerPolicyDigest: "d".repeat(64),
      protocolMin: "clockgrove.factory/v2",
      protocolMax: "clockgrove.factory/v2",
    });

    expect(event).toMatchObject({
      event: "ControllerObserved",
      runId: "run-1",
      controllerId: "controller-1",
      epoch: 5,
    });
    expect(store.comments).toHaveLength(1);
    expect(decodeEventComments(store.comments[0]!.body)).toEqual([event]);
  });

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
    const takeover = await manager.acquire({ ...identity, runId: "run-2", holder: "host-2" }, base);
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
    const takeover = await manager.acquire({ ...identity, runId: "run-2", holder: "host-2" }, base);
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
      admission: {
        admissionClass: "local",
        admissionReason: "local-capacity",
        requestedCpu: 2,
        requestedMemoryMb: 4_096,
        priorityRank: 10,
        subIssuePosition: 0,
        criticalPathLength: 2,
        unfinishedDownstream: 3,
        capacityMeasuredAt: "2026-09-03T00:00:00.000Z",
        effectiveCpu: 8,
        availableMemoryMb: 8_192,
        loadRatio: 0.25,
        memoryUsageRatio: 0.5,
      },
    });
    expect(first.attempt).toBe(1);
    expect(first.baseSha).toBe(BASE_SHA);
    expect(store.refs.get(first.ref)).toBe(first.oid);
    expect(store.comments[0]?.body).toContain("AttemptReserved");
    expect(first.admission).toMatchObject({
      admissionClass: "local",
      requestedCpu: 2,
      priorityRank: 10,
    });
    expect((await attempts.list(42, 43))[0]?.admission).toEqual(first.admission);

    const started = await attempts.record({
      lease,
      workItemNodeId: "I_43",
      reservation: first,
      event: "AttemptStarted",
      sequence: 19,
      providerResourceId: "sandbox-1",
      environmentIdentity: `registry.example.invalid/factory@sha256:${"a".repeat(64)}`,
    });
    expect(started).toMatchObject({
      providerResourceId: "sandbox-1",
      environmentIdentity: `registry.example.invalid/factory@sha256:${"a".repeat(64)}`,
    });

    const terminal = await attempts.record({
      lease,
      workItemNodeId: "I_43",
      reservation: first,
      event: "AttemptSucceeded",
      sequence: 20,
      modelProfile: "frontier",
      reportedModelTokens: 321,
    });
    expect(terminal).toMatchObject({
      modelProfile: "frontier",
      reportedModelTokens: 321,
    });

    const queued = await attempts.recordQueued({
      lease,
      workItem: 44,
      workItemNodeId: "I_44",
      sequence: 3,
      reason: "local-capacity: CPU is reserved",
      observedPriorityRank: 20,
      observedSubIssuePosition: 1,
    });
    expect(queued).toMatchObject({ kind: "scheduling", event: "WorkItemQueued" });
    expect(await attempts.list(42, 44)).toEqual([]);
    const capacity = await attempts.recordCapacity({
      lease,
      workItemNodeId: "I_43",
      reservation: first,
      sequence: 4,
      event: "CapacityReserved",
      phase: "validation",
      backend: "codex-cli/daytona",
      requestedCpu: 1,
      requestedMemoryMb: 2_048,
    });
    expect(capacity).toMatchObject({ kind: "capacity", event: "CapacityReserved" });

    const second = await attempts.reserve({
      lease,
      workItem: 43,
      workItemNodeId: "I_43",
      backend: "codex-cli/local-worktree",
      base,
      sequence: 5,
    });
    expect(second.attempt).toBe(2);
    expect((await attempts.list(42, 43)).map((attempt) => attempt.attempt)).toEqual([1, 2]);
  });

  it("refuses reservation after the lease is fenced", async () => {
    const store = new MemoryStore();
    const leases = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const lease = await leases.acquire(identity, base);
    store.now = new Date(lease.expiresAt.getTime() + 1);
    await leases.acquire({ ...identity, runId: "run-2", holder: "host-2" }, base);
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

  it("allows only an older attempt epoch to reconcile capacity", async () => {
    const store = new MemoryStore();
    const leases = new LeaseManager({ store, durationMs: 60_000 });
    const base = await store.readCommit(BASE_SHA);
    const firstLease = await leases.acquire(identity, base);
    const attempts = new AttemptManager({ store, leases });
    const reservation = await attempts.reserve({
      lease: firstLease,
      workItem: 43,
      workItemNodeId: "I_43",
      backend: "codex-cli/local-worktree",
      base,
      sequence: 2,
    });
    store.now = new Date(firstLease.expiresAt.getTime() + 1);
    const recoveryLease = await leases.acquire({ ...identity, holder: "host-2" }, base);
    const recovered = await attempts.recordCapacity({
      lease: recoveryLease,
      workItemNodeId: "I_43",
      reservation,
      sequence: 4,
      event: "CapacityReconciled",
      phase: "validation",
      backend: "factory/local-validation",
      requestedCpu: 1,
      requestedMemoryMb: 2_048,
      allowRecovery: true,
    });
    expect(recovered).toMatchObject({ directorEpoch: 1, recoveryEpoch: 2 });
    await expect(
      attempts.recordCapacity({
        lease: recoveryLease,
        workItemNodeId: "I_43",
        reservation: { ...reservation, directorEpoch: 3 },
        sequence: 5,
        event: "CapacityReconciled",
        phase: "validation",
        backend: "factory/local-validation",
        requestedCpu: 1,
        requestedMemoryMb: 2_048,
        allowRecovery: true,
      }),
    ).rejects.toThrow(/future lease epoch/);
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
    expect(
      manager.resume([
        {
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
        },
        event,
      ])?.runId,
    ).toBe("run-1");

    const body = store.comments[0]!.body;
    expect(
      cancellationRequestFromComments(
        [
          {
            body,
            authorLogin: "operator",
            authorAssociation: "OWNER",
          },
        ],
        run.runId,
        run.actor,
      ),
    ).toEqual(event);
    expect(
      cancellationRequestFromComments(
        [
          {
            body,
            authorLogin: "intruder",
            authorAssociation: "OWNER",
          },
        ],
        run.runId,
        run.actor,
      ),
    ).toBeNull();
    expect(
      cancellationRequestFromComments(
        [
          {
            body,
            authorLogin: "operator",
            authorAssociation: "CONTRIBUTOR",
          },
        ],
        run.runId,
        run.actor,
      ),
    ).toBeNull();
  });

  it("rejects cancellation by a different GitHub identity", async () => {
    const store = new MemoryStore();
    await expect(
      new RunManager(store).requestCancellation({
        run,
        objectiveNodeId: "I_42",
        actor: "intruder",
        sequence: 2,
      }),
    ).rejects.toThrow(/only activating actor/i);
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

describe("authenticated durable activation discovery", () => {
  const activation = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "ActivationRequested",
    objective: 14,
    runId: "activation-14",
    sequence: 1,
    at: "2026-09-03T00:00:00.000Z",
    requestedBy: "operator",
    requestId: "activation-14",
    repository: "clockgrove/factory",
    baseSha: BASE_SHA,
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    controllerProtocolMin: "clockgrove.factory/v2",
    controllerProtocolMax: "clockgrove.factory/v2",
  });
  const started = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunStarted",
    objective: 14,
    runId: "run-14",
    sequence: 2,
    at: "2026-09-03T00:00:01.000Z",
    actor: "operator",
    repository: "clockgrove/factory",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    activationRequestId: "activation-14",
    baseSha: BASE_SHA,
  });
  const rejected = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "ActivationRejected",
    objective: 14,
    runId: "activation-14",
    sequence: 2,
    at: "2026-09-03T00:00:01.000Z",
    activationRequestId: "activation-14",
    requestedBy: "operator",
    baseSha: BASE_SHA,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    reason: "activation base is stale",
  });
  const terminal = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunCompleted",
    objective: 14,
    runId: "run-14",
    sequence: 3,
    at: "2026-09-03T00:00:02.000Z",
  });
  const pause = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "RunPauseRequested",
    objective: 14,
    runId: "run-14",
    sequence: 3,
    at: "2026-09-03T00:00:02.000Z",
    requestedBy: "operator",
    requestId: "pause-14",
  });
  const pauseAcknowledged = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "RunPauseAcknowledged",
    objective: 14,
    runId: "run-14",
    sequence: 4,
    at: "2026-09-03T00:00:03.000Z",
    commandRequestId: "pause-14",
  });
  const drain = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "RunDrainRequested",
    objective: 14,
    runId: "run-14",
    sequence: 3,
    at: "2026-09-03T00:00:02.000Z",
    requestedBy: "operator",
    requestId: "drain-14",
  });
  const drainCompleted = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "RunDrainCompleted",
    objective: 14,
    runId: "run-14",
    sequence: 4,
    at: "2026-09-03T00:00:03.000Z",
    commandRequestId: "drain-14",
  });
  const resume = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "RunResumeRequested",
    objective: 14,
    runId: "run-14",
    sequence: 5,
    at: "2026-09-03T00:00:04.000Z",
    requestedBy: "operator",
    requestId: "resume-14",
  });

  function discoveryStore(
    comments: Array<{
      body: string;
      login: string;
      association: string;
    }>,
    state: "open" | "closed" = "open",
  ): GitHubControlStore {
    return new GitHubControlStore({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/user")) {
          return Response.json({ login: "operator" });
        }
        const isComments = request.url.includes("/issues/14/comments");
        if (!isComments) {
          expect(new URL(request.url).searchParams.get("state")).toBe("all");
        }
        const data = isComments
          ? comments.map((comment, index) => ({
              id: index + 1,
              body: comment.body,
              user: { login: comment.login },
              author_association: comment.association,
            }))
          : [{ number: 14, state }];
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "content-type": "application/json",
            date: "Thu, 03 Sep 2026 00:00:03 GMT",
          },
        });
      },
    });
  }

  it("keeps the newest unique activation when an older request is replayed late", async () => {
    const nextActivation = parseFactoryEvent({
      ...activation,
      runId: "activation-15",
      requestId: "activation-15",
      sequence: 2,
      at: "2026-09-03T00:00:01.000Z",
    });
    const delayedReplay = parseFactoryEvent({
      ...activation,
      sequence: 3,
      at: "2026-09-03T00:00:02.000Z",
    });
    const store = discoveryStore(
      [activation, nextActivation, delayedReplay].map((event) => ({
        body: encodeEventComment(event.event, event),
        login: "operator",
        association: "OWNER",
      })),
    );

    await expect(store.discoverObjectiveActivations()).resolves.toMatchObject([
      { objective: 14, requestId: "activation-15", requestedBy: "operator" },
    ]);
  });

  it("rejects reuse of one request ID across application event types", async () => {
    const conflictingPause = parseFactoryEvent({
      ...pause,
      requestId: activation.requestId,
    });
    const store = discoveryStore(
      [activation, started, conflictingPause].map((event) => ({
        body: encodeEventComment(event.event, event),
        login: "operator",
        association: "OWNER",
      })),
    );

    await expect(store.discoverObjectiveActivations()).rejects.toThrow(
      /conflicting Factory application requests/i,
    );
  });

  it("ignores outsider activations and collaborator comments with mismatched actors", async () => {
    const forged = { ...activation, runId: "forged", requestId: "forged" };
    const teammateActivation = {
      ...activation,
      runId: "teammate-activation",
      requestId: "teammate-activation",
      requestedBy: "teammate",
    };
    const store = discoveryStore([
      {
        body: encodeEventComment("valid", activation),
        login: "operator",
        association: "OWNER",
      },
      {
        body: encodeEventComment("outsider", forged),
        login: "outsider",
        association: "CONTRIBUTOR",
      },
      {
        body: encodeEventComment("actor mismatch", forged),
        login: "collaborator",
        association: "COLLABORATOR",
      },
      {
        body: encodeEventComment("different controller identity", teammateActivation),
        login: "teammate",
        association: "MEMBER",
      },
    ]);

    await expect(store.discoverObjectiveActivations()).resolves.toEqual([
      expect.objectContaining({
        objective: 14,
        requestId: "activation-14",
        requestedBy: "operator",
        baseSha: BASE_SHA,
      }),
    ]);
  });

  it("does not let another collaborator forge a terminal receipt", async () => {
    const forgedStart = parseFactoryEvent({
      ...started,
      actor: "collaborator",
    });
    const store = discoveryStore([
      {
        body: encodeEventComment("activate", activation),
        login: "operator",
        association: "OWNER",
      },
      {
        body: encodeEventComment("start", started),
        login: "operator",
        association: "OWNER",
      },
      {
        body: encodeEventComment("forged start", forgedStart),
        login: "collaborator",
        association: "COLLABORATOR",
      },
      {
        body: encodeEventComment("forged terminal", terminal),
        login: "collaborator",
        association: "COLLABORATOR",
      },
    ]);
    await expect(store.discoverObjectiveActivations()).rejects.toThrow(
      /conflicting authenticated actors/i,
    );
  });

  it("suppresses a completed activation only with its actor-bound run receipt", async () => {
    const store = discoveryStore(
      [
        {
          body: encodeEventComment("activate", activation),
          login: "operator",
          association: "OWNER",
        },
        {
          body: encodeEventComment("start", started),
          login: "operator",
          association: "OWNER",
        },
        {
          body: encodeEventComment("terminal", terminal),
          login: "operator",
          association: "OWNER",
        },
      ],
      "closed",
    );
    await expect(store.discoverObjectiveActivations()).resolves.toEqual([]);
  });

  it("suppresses an open paused run until its actor durably resumes it", async () => {
    const comments = [activation, started, pause, pauseAcknowledged].map((event) => ({
      body: encodeEventComment(event.event, event),
      login: "operator",
      association: "OWNER",
    }));
    await expect(discoveryStore(comments).discoverObjectiveActivations()).resolves.toEqual([]);

    comments.push({
      body: encodeEventComment("resume", resume),
      login: "operator",
      association: "OWNER",
    });
    await expect(discoveryStore(comments).discoverObjectiveActivations()).resolves.toHaveLength(1);
  });

  it.each([
    ["local", "codex-sdk/local-worktree", pause],
    ["cloud", "codex-cli/daytona", drain],
  ] as const)(
    "rediscovers a crash after %s admission is stopped while its attempt may still be live",
    async (_class, backend, gate) => {
      const attempt = parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "attempt",
        event: "AttemptStarted",
        objective: 14,
        runId: "run-14",
        sequence: 4,
        at: "2026-09-03T00:00:03.000Z",
        workItem: 22,
        attempt: 1,
        backend,
        baseSha: BASE_SHA,
        directorEpoch: 1,
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
        providerResourceId: `${_class}-resource`,
      });
      const comments = [activation, started, attempt, gate].map((event) => ({
        body: encodeEventComment(event.event, event),
        login: "operator",
        association: "OWNER",
      }));
      await expect(discoveryStore(comments).discoverObjectiveActivations()).resolves.toHaveLength(
        1,
      );
    },
  );

  it("suppresses a drained run only after its exact durable completion acknowledgement", async () => {
    const comments = [activation, started, drain].map((event) => ({
      body: encodeEventComment(event.event, event),
      login: "operator",
      association: "OWNER",
    }));
    await expect(discoveryStore(comments).discoverObjectiveActivations()).resolves.toHaveLength(1);
    comments.push({
      body: encodeEventComment("drained", drainCompleted),
      login: "operator",
      association: "OWNER",
    });
    await expect(discoveryStore(comments).discoverObjectiveActivations()).resolves.toEqual([]);
  });

  it("rediscovers a closed active run for close-before-terminal repair", async () => {
    const comments = [activation, started, pause].map((event) => ({
      body: encodeEventComment(event.event, event),
      login: "operator",
      association: "OWNER",
    }));
    await expect(
      discoveryStore(comments, "closed").discoverObjectiveActivations(),
    ).resolves.toHaveLength(1);
  });

  it("durably suppresses a rejected pre-start activation across discovery passes", async () => {
    const comments = [
      {
        body: encodeEventComment("activate", activation),
        login: "operator",
        association: "OWNER",
      },
    ];
    const store = discoveryStore(comments);
    await expect(store.discoverObjectiveActivations()).resolves.toHaveLength(1);

    comments.push({
      body: encodeEventComment("rejected", rejected),
      login: "operator",
      association: "OWNER",
    });
    await expect(store.discoverObjectiveActivations()).resolves.toEqual([]);
    await expect(store.discoverObjectiveActivations()).resolves.toEqual([]);
  });

  it("does not let another collaborator reject an activation", async () => {
    const store = discoveryStore([
      {
        body: encodeEventComment("activate", activation),
        login: "operator",
        association: "OWNER",
      },
      {
        body: encodeEventComment("forged rejection", rejected),
        login: "collaborator",
        association: "COLLABORATOR",
      },
    ]);
    await expect(store.discoverObjectiveActivations()).resolves.toHaveLength(1);
  });
});
