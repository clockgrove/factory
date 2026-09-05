import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FactoryReadSnapshot } from "../src/application/status.js";
import type { GitHubControlStore } from "../src/control/github-store.js";
import { recoveryReadPort } from "../src/recovery/github-read-port.js";
import { loadRecoverySourceReconciliation } from "../src/recovery/reconciliation.js";
import { loadHistoricalRecoveryRuntimes } from "../src/recovery/historical-runtime.js";
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
import { recoveryEventDigest, recoverySourceEventsDigest } from "../src/recovery/identity.js";
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
    stacked?: boolean;
  } = {},
) {
  const store = new MemoryStore();
  const policy = structuredClone(DEFAULT_RUN_POLICY);
  if (options.stacked)
    policy.delivery = { mode: "stacked-prs", onUnavailable: "escalate", merge: "bottom-up" };
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
  if (options.stacked)
    graphInput.workItems[0]!.delivery = { group: "feature", relationship: "root" };
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

// Real immutable graph/plan/claim fixtures above intentionally exercise the actual loaders.
import { loadRecoveryRuntime } from "../src/recovery/runtime.js";

async function adopted(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  expect(await f.make().adopt(f.args)).toMatchObject({ status: "adopted" });
  f.store.enforce = false;
  const read = (store: RecoveryReadStore = f.store) =>
    loadRecoveryRuntime({
      objective: 7,
      runId: "successor",
      store,
      readSnapshot: async () => ({
        snapshot: structuredClone(f.snapshot),
        historyComplete: f.state.historyComplete,
      }),
    });
  return { ...f, read };
}

async function addAttempt(f: Awaited<ReturnType<typeof adopted>>, attempt = 1) {
  const reserved = event({
    kind: "attempt",
    event: "AttemptReserved",
    runId: "successor",
    sequence: 100,
    workItem: 8,
    attempt,
    backend: "codex-sdk/local-worktree",
    baseSha: base.oid,
    directorEpoch: 2,
    policyDigest: f.planRecord.plan.policyDigest,
  });
  const oid = sha("9");
  f.store.refs.set(attemptRef(7, 8, attempt), oid);
  f.store.commits.set(oid, {
    ...base,
    oid,
    parentOids: [base.oid],
    message: encodeEventTrailer(reserved),
  });
  f.snapshot.workItems[0]!.factoryEvents!.push(
    reserved,
    event({ ...reserved, event: "AttemptStarted", sequence: 101 }),
  );
  return reserved;
}

describe("verified successor runtime loader", () => {
  it("loads and memoizes complete adoption through the actual frozen capability port", async () => {
    const f = await adopted();
    const port = recoveryReadPort(f.store as unknown as GitHubControlStore, "o", "r");
    const writes = f.store.writes.length;
    expect(Object.isFrozen(port)).toBe(true);
    expect(await f.read(port)).toMatchObject({ status: "verified", executionAuthorized: false });
    expect(f.store.writes).toHaveLength(writes);
    f.store.refs.delete(f.planRecord.ref);
    expect(await f.read(port)).toMatchObject({ status: "blocked" });
  });

  it("reconciles a fully bound native adoption through the frozen capability port", async () => {
    const f = await adopted({ stacked: true });
    const port = recoveryReadPort(f.store as unknown as GitHubControlStore, "o", "r");
    const input = {
      objective: 7,
      runId: "successor",
      planDigest: f.planRecord.digest,
      requestId: f.planRecord.plan.requestId,
      store: port,
      readSnapshot: async () => ({ snapshot: structuredClone(f.snapshot), historyComplete: true }),
    };
    await expect(loadRecoverySourceReconciliation(input)).resolves.toMatchObject({
      controllingRun: { runId: "successor" },
      mergedSources: [],
    });
    f.store.refs.delete(f.planRecord.ref);
    await expect(loadRecoverySourceReconciliation(input)).rejects.toThrow(
      /authority or merge evidence/,
    );
  });

  it("preserves exact historical claim filtering across two adoptions from a frozen port", async () => {
    const f = await adopted();
    const events = f.snapshot.factoryEvents!;
    const start = events.find(
      (value) => value.event === "FactoryRunStarted" && value.runId === "successor",
    )!;
    const sequence = Math.max(...events.map((value) => value.sequence)) + 1;
    const terminal = event({
      ...events.find((value) => value.event === "FactoryRunEscalated")!,
      runId: "successor",
      sequence,
    });
    events.push(terminal);
    const predecessor = {
      runId: "successor",
      startDigest: recoveryEventDigest(start),
      terminalDigest: recoveryEventDigest(terminal),
      terminalEvent: "FactoryRunEscalated" as const,
      terminalSequence: sequence,
    };
    const history = [
      ...f.planRecord.plan.history,
      { ...predecessor, policyDigest: f.planRecord.plan.policyDigest },
    ];
    const plan: RecoveryPlan = {
      ...structuredClone(f.planRecord.plan),
      requestId: "recover-again",
      successorRunId: "third",
      predecessor,
      history,
      historyDigest: recoveryHistoryDigest(history),
      priorPlanDigest: f.planRecord.digest,
      sourceEventMaxSequence: sequence,
      sourceEventsDigest: recoverySourceEventsDigest({
        objective: 7,
        runIds: ["source", "successor"],
        events,
        maxSequence: sequence,
      }),
    };
    const record = await new RecoveryPlanManager(f.store, {
      assertCurrent: async () => {},
    } as unknown as LeaseManager).persist({
      lease: { ...f.args.objectiveLease, runId: "third" },
      plan,
    });
    events.push(
      event({
        kind: "recovery",
        event: "RecoveryRequested",
        runId: "successor",
        sequence: sequence + 1,
        requestedBy: "operator",
        requestId: plan.requestId,
        repository: plan.repository,
        planDigest: record.digest,
        predecessorRunId: predecessor.runId,
        predecessorTerminalDigest: predecessor.terminalDigest,
        successorRunId: plan.successorRunId,
        policyDigest: plan.policyDigest,
        baseSha: base.oid,
      }),
    );
    const adoption = await f.make().adopt({
      ...f.args,
      planDigest: record.digest,
      objectiveLease: { ...f.args.objectiveLease, runId: "third" },
    });
    expect(adoption, JSON.stringify(adoption)).toMatchObject({ status: "adopted" });
    const port = recoveryReadPort(f.store as unknown as GitHubControlStore, "o", "r");
    const result = await loadHistoricalRecoveryRuntimes({
      snapshot: f.snapshot,
      historyComplete: true,
      store: port,
      latestRunId: "third",
    });
    expect([...result.keys()]).toEqual(["third", "successor"]);
    expect(result.get("successor")!.controllingRun.runId).toBe("successor");
    expect(result.get("third")!.accountingRunIds).toEqual(["source", "successor", "third"]);
    expect(
      await port.listRefs("refs/clockgrove-factory/recovery-claims/objective-7/"),
    ).toHaveLength(2);
  });
  it("loads actual completed adoption without new writes or resetting allowance", async () => {
    const f = await adopted({ tokenLimit: 1000 });
    const writes = f.store.writes.length;
    const result = await f.read();
    expect(result).toMatchObject({
      status: "verified",
      adoptionVerified: true,
      executionAuthorized: false,
      controllingRun: { runId: "successor" },
      sourceRunIds: ["source"],
      accountingRunIds: ["source", "successor"],
      usage: { modelTokens: 10 },
      remaining: { modelTokens: 990 },
    });
    expect(f.store.writes).toHaveLength(writes);
    expect(await loadRecoveryClaim(f.store, 7, "source")).not.toBeNull();
  });

  it("retains a real active successor attempt and cumulative source identities", async () => {
    const f = await adopted({ resource: "local", tokenLimit: 1000 });
    await addAttempt(f, 2);
    f.snapshot.workItems[0]!.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        runId: "successor",
        sequence: 102,
        workItem: 8,
        attempt: 2,
        phase: "execution",
        unit: "model_tokens",
        amount: 25,
      }),
    );
    const sourceBefore = JSON.stringify(
      f.snapshot.factoryEvents!.filter((value) => value.runId === "source"),
    );
    const result = await f.read();
    expect(result).toMatchObject({
      status: "verified",
      usage: { modelTokens: 35 },
      remaining: { modelTokens: 965 },
      attemptCounts: [{ workItem: 8, count: 2 }],
    });
    if (result.status !== "verified") return;
    expect(result.sourceEvidence.items[0]!.sourceAttempt).toMatchObject({
      runId: "source",
      attempt: 1,
    });
    expect(
      result.currentEvents.some(
        (value) => value.event === "AttemptStarted" && value.runId === "successor",
      ),
    ).toBe(true);
    expect(
      JSON.stringify(f.snapshot.factoryEvents!.filter((value) => value.runId === "source")),
    ).toBe(sourceBefore);
  });

  it("allows exact lost-response duplicates but rejects conflicting transaction copies", async () => {
    const f = await adopted();
    const completed = f.snapshot.factoryEvents!.find(
      (value) => value.event === "RecoveryAdoptionCompleted",
    )!;
    f.snapshot.factoryEvents!.push(structuredClone(completed));
    expect(await f.read()).toMatchObject({ status: "verified" });
    f.snapshot.factoryEvents!.push(event({ ...completed, sequence: 90 }));
    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["adoption-envelope-conflict"],
    });
  });

  it.each(["FactoryRunStarted", "RecoveryConsumed", "RecoveryAdoptionCompleted"])(
    "requires exact %s envelope",
    async (name) => {
      const f = await adopted();
      const index = f.snapshot.factoryEvents!.findIndex(
        (value) => value.runId === "successor" && value.event === name,
      );
      f.snapshot.factoryEvents![index] = event({
        ...f.snapshot.factoryEvents![index]!,
        at: "2026-09-04T00:00:01.000Z",
      });
      expect(await f.read()).toMatchObject({ status: "blocked" });
    },
  );

  it("rejects late predecessor charges instead of dropping them", async () => {
    const f = await adopted();
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 90,
        phase: "management",
        unit: "model_tokens",
        amount: 1,
        usageId: "late",
      }),
    );
    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["historical-chain-or-accounting-invalid"],
    });
  });

  it("rejects altered terminal predecessor identity", async () => {
    const f = await adopted();
    const terminal = f.snapshot.factoryEvents!.findIndex(
      (value) => value.event === "FactoryRunEscalated",
    );
    f.snapshot.factoryEvents![terminal] = event({
      ...f.snapshot.factoryEvents![terminal]!,
      reason: "changed",
    });
    expect(await f.read()).toMatchObject({ status: "blocked" });
  });

  it("does not accept an orphan effect or a policy-swapped successor reservation", async () => {
    const f = await adopted();
    const reserved = await addAttempt(f);
    f.snapshot.workItems[0]!.factoryEvents![1] = event({
      ...reserved,
      event: "AttemptStarted",
      sequence: 101,
      policyDigest: "f".repeat(64),
    });
    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["successor-effect-binding-invalid"],
    });
    f.snapshot.workItems[0]!.factoryEvents!.splice(0, 1);
    f.snapshot.workItems[0]!.factoryEvents![0] = event({
      ...reserved,
      event: "AttemptStarted",
      sequence: 101,
    });
    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["successor-reservation-unavailable"],
    });
  });

  it("preserves missing worker usage as unknown rather than zero", async () => {
    const f = await adopted();
    const reserved = await addAttempt(f);
    f.snapshot.workItems[0]!.factoryEvents!.push(
      event({ ...reserved, event: "AttemptFailed", sequence: 102 }),
    );
    expect(await f.read()).toMatchObject({
      status: "verified",
      currentUnknownModelUsageCount: 1,
      currentUnknownModelUsage: [{ workItem: 8, attempt: 1 }],
      usage: { modelTokens: 10 },
    });
  });

  it("does not collapse the same usageId across source and successor", async () => {
    const f = await adopted({ tokenLimit: 1000 });
    const source = f.snapshot.factoryEvents!.find((value) => value.kind === "budget")!;
    f.snapshot.factoryEvents!.push(
      event({ ...source, runId: "successor", sequence: 100, amount: 7 }),
    );
    expect(await f.read()).toMatchObject({
      status: "verified",
      usage: { modelTokens: 17 },
      remaining: { modelTokens: 983 },
    });
    f.snapshot.factoryEvents!.push(
      event({ ...source, runId: "successor", sequence: 101, amount: 8 }),
    );
    expect(await f.read()).toMatchObject({ status: "blocked" });
  });

  it("keeps mutable base observations distinct from verified adoption", async () => {
    const f = await adopted();
    f.store.head = { ...base, oid: sha("8") };
    const result = await f.read();
    expect(result).toMatchObject({
      status: "verified",
      executionAuthorized: false,
      sourceEvidence: {
        currentBase: "changed",
        blockers: expect.arrayContaining([{ code: "current-base-changed" }]),
      },
    });
  });

  it("fails closed on incomplete history and opaque reader errors", async () => {
    const f = await adopted();
    f.state.historyComplete = false;
    expect(await f.read()).toMatchObject({ status: "blocked", blockers: ["snapshot-incomplete"] });
    const result = await loadRecoveryRuntime({
      objective: 7,
      runId: "successor",
      store: f.store,
      readSnapshot: async () => {
        throw new Error("private credential diagnostic");
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects a missing claim or independently changed graph ref", async () => {
    const f = await adopted();
    const ref = [...f.store.refs.keys()].find((value) => value.includes("/recovery-claims/"))!;
    const original = f.store.refs.get(ref)!;
    f.store.refs.delete(ref);
    expect(await f.read()).toMatchObject({ status: "blocked", blockers: ["claim-unavailable"] });
    f.store.refs.set(ref, original);
    f.store.refs.set(f.planRecord.plan.graph.ref, base.oid);
    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["source-bindings-unavailable"],
    });
  });

  it("rejects effects before adoption completion and after terminal closure", async () => {
    const f = await adopted();
    const reserved = await addAttempt(f);
    const start = f.snapshot.factoryEvents!.find(
      (value) => value.runId === "successor" && value.event === "FactoryRunStarted",
    )!;
    f.snapshot.workItems[0]!.factoryEvents![0] = event({
      ...reserved,
      sequence: start.sequence - 1,
    });
    expect(await f.read()).toMatchObject({ status: "blocked" });
    f.snapshot.workItems[0]!.factoryEvents![0] = reserved;
    f.snapshot.factoryEvents!.push(
      event({ kind: "run", event: "FactoryRunCompleted", runId: "successor", sequence: 99 }),
    );
    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["successor-terminal-conflict"],
    });
  });

  it("blocks unsafe cumulative amounts and a forged successor reservation trailer", async () => {
    const f = await adopted();
    const reserved = await addAttempt(f);
    const oid = f.store.refs.get(attemptRef(7, 8, 1))!;
    f.store.commits.get(oid)!.message = encodeEventTrailer(
      event({ ...reserved, backend: "different" }),
    );
    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["successor-reservation-binding-invalid"],
    });
    f.store.commits.get(oid)!.message = encodeEventTrailer(reserved);
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence: 110,
        phase: "management",
        unit: "model_tokens",
        amount: Number.MAX_SAFE_INTEGER,
        usageId: "huge",
      }),
    );
    expect(await f.read()).toMatchObject({ status: "blocked", blockers: ["unsafe-accounting"] });
  });
});
