import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FactoryReadSnapshot } from "../src/application/status.js";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { decodeEventComments, encodeEventTrailer } from "../src/control/receipts.js";
import { attemptRef } from "../src/control/attempts.js";
import {
  REPOSITORY_LEASE_REF,
  type RepositoryLeaseState,
} from "../src/controller/repository-lease.js";
import { renderWorkPacket, type CompiledObjective } from "../src/graph.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { RecoveryCoordinator } from "../src/recovery/coordinator.js";
import type { RecoveryReadStore } from "../src/recovery/assessment.js";
import { loadRecoveryClaim } from "../src/recovery/claims.js";
import {
  observeLocalRecoveryResource,
  readLocalResourceHostIdentity,
  type LocalResourceReader,
} from "../src/recovery/local-resources.js";
import {
  recoveryClaimRef,
  recoveryEventDigest,
  recoverySourceEventsDigest,
} from "../src/recovery/identity.js";
import {
  RECOVERY_PLAN_PROTOCOL,
  RecoveryPlanManager,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  type RecoveryPlan,
} from "../src/recovery/plan.js";

const sha = (value: string) => value.repeat(40);
const at = new Date("2026-09-04T00:00:00.000Z");
const base: GitCommitObject = {
  oid: sha("a"),
  treeOid: sha("b"),
  parentOids: [],
  message: "base",
  serverTime: at,
};
const event = (fields: Record<string, unknown>): FactoryEvent =>
  parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "source",
    at: at.toISOString(),
    ...fields,
  });

class MemoryStore implements CompiledGraphStore, RecoveryReadStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>([[base.oid, base]]);
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>([[base.treeOid, new Map()]]);
  trace: string[] = [];
  writes: string[] = [];
  comments: FactoryEvent[] = [];
  enforce = false;
  objectiveValid = true;
  repositoryValid = true;
  objectiveFenced = false;
  repositoryFenced = false;
  loseAfter: string | null = null;
  failBefore: string | null = null;
  afterWrite?: (kind: string) => void;
  onComment?: (event: FactoryEvent) => void;
  head = base;
  private counter = 0;

  async objectiveFence() {
    this.trace.push("objective-fence");
    if (!this.objectiveValid) throw new Error("lost Objective lease");
    this.objectiveFenced = true;
  }
  async repositoryFence() {
    this.trace.push("repository-fence");
    if (!this.repositoryValid) throw new Error("lost repository lease");
    this.repositoryFenced = true;
  }
  private before(kind: string) {
    if (this.enforce) {
      expect(this.objectiveFenced, `Objective fence before ${kind}`).toBe(true);
      expect(this.repositoryFenced, `repository fence before ${kind}`).toBe(true);
    }
    this.objectiveFenced = false;
    this.repositoryFenced = false;
    this.trace.push(`write:${kind}`);
    if (this.failBefore === kind) {
      this.failBefore = null;
      throw new Error("request not persisted");
    }
    this.writes.push(kind);
  }
  private after(kind: string) {
    this.afterWrite?.(kind);
    if (this.loseAfter === kind) {
      this.loseAfter = null;
      throw new Error("response lost after persistence");
    }
  }
  private oid(value: string) {
    return createHash("sha1")
      .update(`${this.counter++}:${value}`)
      .digest("hex");
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
  async readTreeEntry(oid: string, path: string) {
    return this.trees.get(oid)?.get(path) ?? null;
  }
  async listRefs(prefix: string) {
    return [...this.refs]
      .filter(([ref]) => ref.startsWith(prefix))
      .map(([ref, oid]) => ({ ref, oid }));
  }
  async createBlob(content: Buffer) {
    this.before("blob");
    const oid = this.oid(content.toString("utf8"));
    this.blobs.set(oid, Buffer.from(content));
    this.after("blob");
    return oid;
  }
  async createTree(args: Parameters<CompiledGraphStore["createTree"]>[0]) {
    this.before("tree");
    const oid = this.oid("tree");
    const entries = new Map(args.baseTreeOid ? this.trees.get(args.baseTreeOid) : []);
    for (const item of args.entries) {
      if (item.sha) entries.set(item.path, item.sha);
      else entries.delete(item.path);
    }
    this.trees.set(oid, entries);
    this.after("tree");
    return oid;
  }
  async createCommit(args: Parameters<CompiledGraphStore["createCommit"]>[0]) {
    this.before("commit");
    const oid = this.oid(args.message);
    this.commits.set(oid, { ...args, oid, serverTime: at });
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
  async addIssueComment(nodeId: string, body: string) {
    expect(nodeId).toBe("objective-7");
    const events = decodeEventComments(body);
    expect(events).toHaveLength(1);
    const receipt = events[0]!;
    this.before(receipt.event);
    this.comments.push(receipt);
    this.onComment?.(receipt);
    this.after(receipt.event);
  }
  async serverTime() {
    return new Date(at);
  }
  async getRepositoryFacts() {
    return { fullName: "o/r", fork: false, private: true, defaultBranch: "main", canPush: true };
  }
  async getBranchHead() {
    return structuredClone(this.head);
  }
  async readPullRequest(): Promise<Awaited<ReturnType<RecoveryReadStore["readPullRequest"]>>> {
    throw new Error("unexpected PR read for unexecuted fixture");
  }
  async readBranchRules() {
    return [];
  }
  async readChecks() {
    return { pending: [], failed: [], observed: [], observedChecks: [] };
  }
}

async function fixture(
  options: {
    missingCompileUsage?: boolean;
    tokenLimit?: number;
    resource?: "legacy" | "local" | "managed";
  } = {},
) {
  const store = new MemoryStore();
  const policy = structuredClone(DEFAULT_RUN_POLICY);
  if (options.tokenLimit !== undefined)
    policy.economics = {
      maxModelTokens: options.tokenLimit,
      maxSandboxMinutes: 0,
      maxManagedSessions: 0,
      minCloudTimeSavedMinutes: 0,
    };
  let resourceReads = 0;
  const resourceState = { unavailable: false };
  const resourceReader: LocalResourceReader = {
    platform: "linux",
    uid: 1000,
    read: async (path) => {
      if (path === "/etc/machine-id") return Buffer.from("a".repeat(32));
      if (path === "/proc/sys/kernel/random/boot_id")
        return Buffer.from("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      if (path === "/proc/self/mountinfo")
        return Buffer.from("1 0 0:1 / /proc rw - proc proc rw\n");
      throw new Error("unexpected local fixture read");
    },
    link: async (path) => `${path.split("/").at(-1)}:[100]`,
    pids: async () => {
      resourceReads++;
      if (resourceState.unavailable) throw new Error("process scan unavailable");
      return [];
    },
    now: () => new Date(),
  };
  const objectiveLease: LeaseState = {
    objective: 7,
    runId: "source",
    holder: "operator",
    policyDigest: policyDigest(policy),
    ref: "refs/clockgrove-factory/leases/objective-7",
    oid: sha("c"),
    treeOid: base.treeOid,
    epoch: 1,
    sequence: 1,
    expiresAt: new Date(at.getTime() + 600_000),
  };
  const repositoryLease: RepositoryLeaseState = {
    ref: REPOSITORY_LEASE_REF,
    oid: sha("d"),
    treeOid: base.treeOid,
    controllerId: "controller",
    policyDigest: policyDigest(policy),
    epoch: 1,
    sequence: 1,
    expiresAt: new Date(at.getTime() + 600_000),
  };
  const graphInput: CompiledObjective = {
    title: "Objective",
    workItems: [
      {
        id: "feature",
        title: "Feature",
        goal: "Implement feature",
        acceptance: ["Tests pass"],
        scope: ["src/feature.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: base.oid,
        validationCommands: ["npm test"],
        requirements: {
          os: [],
          architecture: [],
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
  };
  const graphManager = new CompiledGraphManager(store, {
    assertCurrent: async () => {},
  } as unknown as LeaseManager);
  const graph = await graphManager.persist({ lease: objectiveLease, base, objective: graphInput });
  const projection = await graphManager.persistProjection({
    lease: objectiveLease,
    graph,
    bindings: [{ compilerId: "feature", issueNodeId: "issue-8", issueNumber: 8 }],
  });
  const start = event({
    kind: "run",
    event: "FactoryRunStarted",
    sequence: 1,
    actor: "operator",
    repository: "o/r",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    baseSha: base.oid,
    policy,
    policyDigest: policyDigest(policy),
  });
  const terminal = event({
    kind: "run",
    event: "FactoryRunEscalated",
    sequence: 10,
    reason: "paused",
  });
  const events = [
    start,
    event({
      kind: "graph",
      event: "GraphCompiled",
      sequence: 2,
      graphDigest: graph.graphDigest,
      graphSize: 1,
      baseSha: base.oid,
      graphRef: graph.ref,
      graphBlobSha: graph.blobOid,
    }),
    event({
      kind: "graph",
      event: "GraphProjected",
      sequence: 3,
      graphDigest: graph.graphDigest,
      graphSize: 1,
      projectionRef: projection.ref,
      projectionBlobSha: projection.blobOid,
    }),
    event({
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 4,
      phase: "management",
      unit: "model_tokens",
      amount: 10,
      usageId: `compile-${graph.graphDigest}`,
    }),
    terminal,
  ];
  if (options.missingCompileUsage) events.splice(3, 1);
  let source: RecoveryPlan["items"][number]["source"] = null;
  if (options.resource) {
    const reservation = event({
      kind: "attempt",
      event: "AttemptReserved",
      sequence: 5,
      workItem: 8,
      attempt: 1,
      backend: options.resource === "managed" ? "github-copilot" : "codex-sdk/local-worktree",
      baseSha: base.oid,
      directorEpoch: 1,
      policyDigest: policyDigest(policy),
    });
    const ref = attemptRef(7, 8, 1);
    const oid = sha("e");
    store.refs.set(ref, oid);
    store.commits.set(oid, {
      ...base,
      oid,
      parentOids: [base.oid],
      message: encodeEventTrailer(reservation),
    });
    const host =
      options.resource === "legacy"
        ? {}
        : { resourceHostIdentity: await readLocalResourceHostIdentity(resourceReader) };
    events.push(
      reservation,
      event({ ...reservation, event: "AttemptStarted", sequence: 6, ...host }),
      event({
        ...reservation,
        event: "AttemptFailed",
        sequence: 7,
        reportedModelTokens: 0,
        ...host,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 8,
        workItem: 8,
        attempt: 1,
        phase: "execution",
        unit: "model_tokens",
        amount: 0,
      }),
    );
    source = {
      runId: "source",
      attempt: 1,
      reservationRef: ref,
      reservationCommitOid: oid,
      reservationReceiptDigest: recoveryEventDigest(reservation),
      artifactDigest: null,
      validation: null,
      review: null,
      publication: null,
    };
  }
  const snapshot: FactoryReadSnapshot = {
    id: "objective-7",
    number: 7,
    title: graphInput.title,
    repositoryId: "repo-1",
    authorLogin: "operator",
    authorAssociation: "OWNER",
    defaultBranch: "main",
    closed: false,
    factoryEvents: events,
    workItems: [
      {
        id: "issue-8",
        number: 8,
        title: "Feature",
        body: renderWorkPacket(graphInput.workItems[0]!, {
          protocol: "clockgrove.factory/graph-v1",
          id: "feature",
          graphDigest: graph.graphDigest,
          graphSize: 1,
          index: 0,
          dependsOn: [],
        }),
        closed: false,
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [],
      },
    ],
  };
  const predecessor = {
    runId: "source",
    startDigest: recoveryEventDigest(start),
    terminalDigest: recoveryEventDigest(terminal),
    terminalEvent: "FactoryRunEscalated" as const,
    terminalSequence: 10,
  };
  const history = [{ ...predecessor, policyDigest: policyDigest(policy) }];
  const items: RecoveryPlan["items"] = [
    {
      workItem: 8,
      issueNodeId: "issue-8",
      compilerId: "feature",
      action: "execute",
      source,
      observedPullRequest: null,
      resources: {
        state: source ? "unknown" : "not-required",
        receiptDigest: null,
        identities: [],
      },
    },
  ];
  const allowance = {
    modelTokens: policy.economics?.maxModelTokens ?? null,
    sandboxMinutes: policy.maxSandboxMinutes,
    managedSessions: policy.maxManagedAgentSessions,
    implementationAttemptsPerItem: policy.maxAttemptsPerItem,
  };
  const plan: RecoveryPlan = {
    protocol: RECOVERY_PLAN_PROTOCOL,
    repository: "o/r",
    repositoryId: "repo-1",
    objective: 7,
    objectiveNodeId: "objective-7",
    requestId: "recover-7",
    successorRunId: "successor",
    predecessor,
    history,
    historyDigest: recoveryHistoryDigest(history),
    sourceEventsDigest: recoverySourceEventsDigest({
      objective: 7,
      runIds: ["source"],
      events,
      maxSequence: 10,
    }),
    sourceEventMaxSequence: 10,
    priorPlanDigest: null,
    expectedBaseSha: base.oid,
    baseBranch: "main",
    graph: {
      sourceRunId: "source",
      ref: graph.ref,
      commitOid: graph.commitOid,
      blobOid: graph.blobOid,
      digest: graph.graphDigest,
      projection: {
        ref: projection.ref,
        commitOid: projection.commitOid,
        blobOid: projection.blobOid,
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy: policy,
    policyDigest: policyDigest(policy),
    allowance: {
      before: { ...allowance },
      increment: {
        modelTokens: 0,
        sandboxMinutes: 0,
        managedSessions: 0,
        implementationAttemptsPerItem: 0,
      },
      after: { ...allowance },
    },
    unknownUsageAcknowledgementDigest: null,
    items,
  };
  objectiveLease.runId = "successor";
  const planRecord = await new RecoveryPlanManager(store, {
    assertCurrent: async () => {},
  }).persist({ lease: objectiveLease, plan });
  events.push(
    event({
      kind: "recovery",
      event: "RecoveryRequested",
      sequence: 11,
      requestedBy: "operator",
      requestId: plan.requestId,
      repository: plan.repository,
      planDigest: planRecord.digest,
      predecessorRunId: "source",
      predecessorTerminalDigest: predecessor.terminalDigest,
      successorRunId: "successor",
      policyDigest: plan.policyDigest,
      baseSha: base.oid,
    }),
  );
  store.onComment = (receipt) => snapshot.factoryEvents!.push(receipt);
  store.enforce = true;
  store.trace = [];
  store.writes = [];
  let reads = 0;
  const state = {
    historyComplete: true,
    beforeRead: undefined as ((read: number) => void) | undefined,
  };
  const make = () =>
    new RecoveryCoordinator({
      store,
      readSnapshot: async () => {
        state.beforeRead?.(++reads);
        return { snapshot: structuredClone(snapshot), historyComplete: state.historyComplete };
      },
      objectiveLeases: { assertCurrent: () => store.objectiveFence() },
      repositoryLeases: { assertCurrent: () => store.repositoryFence() },
      observeLocalResource: (input) => observeLocalRecoveryResource(input, resourceReader),
    });
  const args = { objective: 7, planDigest: planRecord.digest, objectiveLease, repositoryLease };
  return {
    store,
    snapshot,
    planRecord,
    state,
    make,
    args,
    resourceState,
    get resourceReads() {
      return resourceReads;
    },
    get reads() {
      return reads;
    },
  };
}

describe("fenced recovery adoption coordinator", () => {
  it("blocks unknown compiler usage rather than adopting an assumed zero subtotal", async () => {
    const f = await fixture({ missingCompileUsage: true });
    expect(await f.make().adopt(f.args)).toMatchObject({
      status: "blocked",
      executionAuthorized: false,
      blockers: ["accounting-or-chain-blocked"],
    });
    expect(f.store.writes).toEqual([]);
  });

  it("allows zero-cost adoption at an exhausted token ceiling without increasing allowance", async () => {
    const f = await fixture({ tokenLimit: 10 });
    expect(await f.make().adopt(f.args)).toMatchObject({
      status: "adopted",
      executionAuthorized: false,
    });
    const start = f.store.comments[0]!;
    expect(start).toMatchObject({ policy: { economics: { maxModelTokens: 10 } } });
    expect(
      f.store.comments.some((receipt) => receipt.kind === "budget" || receipt.kind === "attempt"),
    ).toBe(false);
  });

  it("uses the concrete local observer to reverify a clean historical execution without relaunching it", async () => {
    const f = await fixture({ resource: "local" });
    const result = await f.make().adopt(f.args);
    expect(result.status, JSON.stringify(result)).toBe("adopted");
    expect(result.executionAuthorized).toBe(false);
    expect(f.resourceReads).toBeGreaterThanOrEqual(4);
    expect(f.store.comments).toHaveLength(3);
    expect(f.store.comments.every((receipt) => receipt.runId === "successor")).toBe(true);
  });

  it.each(["legacy", "managed", "unavailable"] as const)(
    "rejects %s source resource proof without cleanup side effects",
    async (kind) => {
      const f = await fixture({ resource: kind === "unavailable" ? "local" : kind });
      if (kind === "unavailable") f.resourceState.unavailable = true;
      expect((await f.make().adopt(f.args)).status).toBe("blocked");
      expect(f.store.writes).toEqual([]);
    },
  );

  it.each(["source", "head", "cancel"])(
    "leaves persisted claim intact when %s changes before the first start",
    async (change) => {
      const f = await fixture();
      f.store.afterWrite = (kind) => {
        if (kind !== "ref") return;
        if (change === "head") f.store.head = { ...base, oid: sha("e") };
        else
          f.snapshot.factoryEvents!.push(
            change === "source"
              ? event({
                  kind: "budget",
                  event: "BudgetReconciled",
                  sequence: 30,
                  phase: "management",
                  unit: "model_tokens",
                  amount: 1,
                  usageId: "late",
                })
              : event({
                  kind: "run",
                  event: "FactoryRunCancellationRequested",
                  sequence: 30,
                  requestedBy: "operator",
                  requestId: "cancel-late",
                }),
          );
      };
      const result = await f.make().adopt(f.args);
      expect(["pending", "blocked"]).toContain(result.status);
      expect(result.executionAuthorized).toBe(false);
      expect(result.claimOid).toMatch(/^[0-9a-f]{40}$/);
      expect(await loadRecoveryClaim(f.store, 7, "source")).not.toBeNull();
      expect(f.store.comments).toEqual([]);
    },
  );

  it.each(["objective", "repository"])(
    "fences loss of %s lease immediately after a persisted claim",
    async (scope) => {
      const f = await fixture();
      f.store.afterWrite = (kind) => {
        if (kind !== "ref") return;
        if (scope === "objective") f.store.objectiveValid = false;
        else f.store.repositoryValid = false;
      };
      expect((await f.make().adopt(f.args)).executionAuthorized).toBe(false);
      expect(await loadRecoveryClaim(f.store, 7, "source")).not.toBeNull();
      expect(f.store.comments).toEqual([]);
    },
  );

  it("does not overwrite a pending claim when a competing request appears", async () => {
    const f = await fixture();
    f.store.failBefore = "FactoryRunStarted";
    expect((await f.make().adopt(f.args)).status).toBe("pending");
    const original = await loadRecoveryClaim(f.store, 7, "source");
    const request = f.snapshot.factoryEvents!.find(
      (receipt) => receipt.event === "RecoveryRequested",
    )!;
    f.snapshot.factoryEvents!.push(
      event({ ...request, sequence: 20, requestId: "competing", successorRunId: "other" }),
    );
    const count = f.store.writes.length;
    expect((await f.make().adopt(f.args)).status).toBe("blocked");
    expect(await loadRecoveryClaim(f.store, 7, "source")).toEqual(original);
    expect(f.store.writes).toHaveLength(count);
  });

  it("cannot erase an unexpected successor effect to pass the chain checker", async () => {
    const f = await fixture();
    f.store.failBefore = "RecoveryConsumed";
    expect((await f.make().adopt(f.args)).status).toBe("pending");
    f.snapshot.factoryEvents!.push(
      event({ kind: "run", event: "FactoryRunCancelled", runId: "successor", sequence: 20 }),
    );
    const count = f.store.writes.length;
    expect((await f.make().adopt(f.args)).status).toBe("blocked");
    expect(f.store.writes).toHaveLength(count);
  });

  it("adopts once with real immutable loaders, three exact comments and no execution authority", async () => {
    const f = await fixture();
    const result = await f.make().adopt(f.args);
    expect(result).toMatchObject({
      status: "adopted",
      executionAuthorized: false,
      successorRunId: "successor",
      blockers: [],
    });
    expect(f.store.comments.map((receipt) => receipt.event)).toEqual([
      "FactoryRunStarted",
      "RecoveryConsumed",
      "RecoveryAdoptionCompleted",
    ]);
    const claim = await loadRecoveryClaim(f.store, 7, "source");
    expect(result.claimOid).toBe(claim?.oid);
    expect(f.store.writes).toEqual([
      "blob",
      "tree",
      "commit",
      "ref",
      "FactoryRunStarted",
      "RecoveryConsumed",
      "RecoveryAdoptionCompleted",
    ]);
    const count = f.store.writes.length;
    expect(await f.make().adopt(f.args)).toMatchObject({
      status: "adopted",
      claimOid: result.claimOid,
      executionAuthorized: false,
    });
    expect(f.store.writes).toHaveLength(count);
  });

  it.each([
    "blob",
    "tree",
    "commit",
    "ref",
    "FactoryRunStarted",
    "RecoveryConsumed",
    "RecoveryAdoptionCompleted",
  ])("recovers lost response after persisted %s", async (kind) => {
    const f = await fixture();
    f.store.loseAfter = kind;
    const first = await f.make().adopt(f.args);
    expect(["pending", "adopted"]).toContain(first.status);
    expect(first.executionAuthorized).toBe(false);
    const result = await f.make().adopt(f.args);
    expect(result.status).toBe("adopted");
    expect(f.store.comments.map((receipt) => receipt.event)).toEqual([
      "FactoryRunStarted",
      "RecoveryConsumed",
      "RecoveryAdoptionCompleted",
    ]);
    expect(
      [...f.store.refs.keys()].filter((ref) =>
        ref.startsWith("refs/clockgrove-factory/recovery-claims/"),
      ),
    ).toEqual([recoveryClaimRef(7, "source")]);
  });

  it.each(["FactoryRunStarted", "RecoveryConsumed", "RecoveryAdoptionCompleted"])(
    "leaves absent failed %s pending and resumes exact identity with new lease epoch",
    async (kind) => {
      const f = await fixture();
      f.store.failBefore = kind;
      expect((await f.make().adopt(f.args)).status).toBe("pending");
      const claim = await loadRecoveryClaim(f.store, 7, "source");
      expect(claim).not.toBeNull();
      f.args.objectiveLease.epoch++;
      f.args.objectiveLease.oid = sha("e");
      f.args.repositoryLease.epoch++;
      f.args.repositoryLease.oid = sha("f");
      expect(await f.make().adopt(f.args)).toMatchObject({
        status: "adopted",
        claimOid: claim!.oid,
      });
      expect(f.store.comments).toHaveLength(3);
      expect(
        f.store.comments.every(
          (receipt) => receipt.runId === "successor" && receipt.at === claim!.transaction.at,
        ),
      ).toBe(true);
      expect(
        f.store.comments.some((receipt) =>
          ["FactoryRunCancelled", "FactoryRunEscalated"].includes(receipt.event),
        ),
      ).toBe(false);
    },
  );

  it.each(["objective", "repository"])(
    "rejects an invalid %s lease before any write",
    async (scope) => {
      const f = await fixture();
      if (scope === "objective") f.store.objectiveValid = false;
      else f.store.repositoryValid = false;
      expect((await f.make().adopt(f.args)).status).toBe("blocked");
      expect(f.store.writes).toEqual([]);
    },
  );

  it.each(["head", "source", "cancel", "closed", "incomplete", "projection", "orphan"])(
    "rejects changed %s before claim",
    async (change) => {
      const f = await fixture();
      if (change === "head") f.store.head = { ...base, oid: sha("e") };
      if (change === "source")
        f.snapshot.factoryEvents!.push(
          event({
            kind: "budget",
            event: "BudgetReconciled",
            sequence: 12,
            phase: "management",
            unit: "model_tokens",
            amount: 1,
            usageId: "late",
          }),
        );
      if (change === "cancel")
        f.snapshot.factoryEvents!.push(
          event({
            kind: "run",
            event: "FactoryRunCancellationRequested",
            sequence: 12,
            requestId: "cancel",
            requestedBy: "operator",
          }),
        );
      if (change === "closed") f.snapshot.closed = true;
      if (change === "incomplete") f.state.historyComplete = false;
      if (change === "projection") f.snapshot.workItems[0]!.id = "replacement";
      if (change === "orphan")
        f.store.refs.set(
          "refs/clockgrove-factory/attempts/objective-7/work-item-99/attempt-1",
          sha("e"),
        );
      expect((await f.make().adopt(f.args)).status).toBe("blocked");
      expect(f.store.writes).toEqual([]);
    },
  );

  it.each(["FactoryRunStarted", "RecoveryConsumed"])(
    "rechecks changed base after %s without finishing or fabricating terminal history",
    async (after) => {
      const f = await fixture();
      f.store.afterWrite = (kind) => {
        if (kind === after) f.store.head = { ...base, oid: sha("e") };
      };
      const result = await f.make().adopt(f.args);
      expect(result.status).toBe("blocked");
      expect(result.executionAuthorized).toBe(false);
      expect(f.store.comments.at(-1)?.event).toBe(after);
      expect(await loadRecoveryClaim(f.store, 7, "source")).not.toBeNull();
      expect(
        f.store.comments.some(
          (receipt) =>
            receipt.event === "RecoveryAdoptionCompleted" ||
            receipt.event === "FactoryRunEscalated",
        ),
      ).toBe(false);
    },
  );
});
