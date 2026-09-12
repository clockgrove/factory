import { createHash } from "node:crypto";
import { PlatformUnavailableError } from "../src/platform.js";
import { describe, expect, it, vi } from "vitest";
import * as protocol from "../src/protocol/events.js";
import type { FactoryReadSnapshot } from "../src/application/status.js";
import type { GitHubControlStore } from "../src/control/github-store.js";
import { recoveryReadPort } from "../src/recovery/github-read-port.js";
import { loadRecoverySourceReconciliation } from "../src/recovery/reconciliation.js";
import { loadHistoricalRecoveryRuntimes } from "../src/recovery/historical-runtime.js";
import {
  compiledGraphProjectionRef,
  compiledGraphRef,
  CompiledGraphManager,
  type CompiledGraphStore,
} from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { decodeEventComments, encodeEventTrailer } from "../src/control/receipts.js";
import { attemptRef } from "../src/control/attempts.js";
import {
  REPOSITORY_LEASE_REF,
  type RepositoryLeaseState,
} from "../src/controller/repository-lease.js";
import {
  legacyGraphConstraintsDigest,
  parseLegacyGraphConstraints,
  renderLegacyWorkItemCore,
  renderWorkPacket,
  type CompiledObjective,
} from "../src/graph.js";
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
import { assessRecoveryAccounting } from "../src/recovery/accounting.js";
import { recoveryUnknownUsageDigest } from "../src/recovery/chain.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
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
    const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    this.blobs.set(oid, Buffer.from(content));
    this.after("blob");
    return oid;
  }
  async createTree(args: Parameters<CompiledGraphStore["createTree"]>[0]) {
    const materialized = args.entries.map((entry) => {
      if (entry.content === undefined) return entry;
      const bytes = Buffer.from(entry.content, "utf8");
      const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      this.blobs.set(sha, bytes);
      return { ...entry, sha };
    });
    this.before("tree");
    const oid = this.oid("tree");
    const entries = new Map(args.baseTreeOid ? this.trees.get(args.baseTreeOid) : []);
    for (const item of materialized) {
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
    activated?: boolean;
    controllerObservation?: boolean;
    graphless?: boolean;
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
    deferredCapabilityAdapters: [],
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
    async assertMutationAuthorized(this: { assertCurrent(): Promise<void> }) {
      await this.assertCurrent();
    },
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
    ...(options.activated ? { activationRequestId: "original-activation" } : {}),
  });
  const terminal = event({
    kind: "run",
    event: "FactoryRunEscalated",
    sequence: 10,
    reason: options.graphless
      ? "Objective has Work Items but no authenticated v2 graph receipt"
      : "paused",
  });
  const events = options.graphless
    ? [start, terminal]
    : [
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
  if (options.missingCompileUsage && !options.graphless) events.splice(3, 1);
  if (options.controllerObservation)
    events.push(
      event({
        kind: "controller",
        event: "ControllerObserved",
        sequence: 9,
        controllerId: "predecessor-controller",
        epoch: 3,
        expiresAt: "2026-09-07T00:10:00.000Z",
        controllerPolicyDigest: "d".repeat(64),
        protocolMin: "clockgrove.factory/v2",
        protocolMax: "clockgrove.factory/v2",
      }),
    );
  if (options.activated)
    events.push(
      event({
        kind: "run",
        event: "ActivationRequested",
        runId: "original-activation",
        requestId: "original-activation",
        sequence: 1,
        requestedBy: "operator",
        repository: "o/r",
        baseSha: base.oid,
        policy,
        policyDigest: policyDigest(policy),
        controllerProtocolMin: "clockgrove.factory/v2",
        controllerProtocolMax: "clockgrove.factory/v2",
      }),
    );
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
        body: options.graphless
          ? renderLegacyWorkItemCore(graphInput.workItems[0]!)
          : renderWorkPacket(graphInput.workItems[0]!, {
              protocol: "clockgrove.factory/graph-v1",
              id: "feature",
              graphDigest: graph.graphDigest,
              graphSize: 1,
              index: 0,
              dependsOn: [],
              deferredCapabilityAdapters: graphInput.deferredCapabilityAdapters,
            }),
        closed: false,
        assignees: [],
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
      compilerId: options.graphless ? "adopted-8" : "feature",
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
  const legacyConstraints = options.graphless
    ? parseLegacyGraphConstraints({
        objectiveTitle: graphInput.title,
        workItems: [
          {
            id: "issue-8",
            number: 8,
            title: "Feature",
            body: renderLegacyWorkItemCore(graphInput.workItems[0]!),
            blockedByNumbers: [],
          },
        ],
      })
    : null;
  const sourceEventsDigest = recoverySourceEventsDigest({
    objective: 7,
    runIds: ["source"],
    events,
    maxSequence: 10,
  });
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
    sourceEventsDigest,
    sourceEventMaxSequence: 10,
    priorPlanDigest: null,
    expectedBaseSha: base.oid,
    baseBranch: "main",
    graph: legacyConstraints
      ? {
          mode: "adopt-existing",
          sourceRunId: "successor",
          ref: compiledGraphRef(7, "successor"),
          objectiveInputDigest: compilerEvalDigest({
            number: 7,
            title: graphInput.title,
            body: undefined,
          }),
          constraintDigest: legacyGraphConstraintsDigest(legacyConstraints),
          constraints: legacyConstraints,
          projection: {
            ref: compiledGraphProjectionRef(7, "successor"),
            bindingDigest: recoveryPlanBindingDigest(items),
          },
        }
      : {
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
  if (options.graphless) {
    const accounting = assessRecoveryAccounting({
      objective: 7,
      repository: "o/r",
      events,
      runIds: ["source"],
      policy,
    });
    plan.unknownUsageAcknowledgementDigest = recoveryUnknownUsageDigest(
      sourceEventsDigest,
      accounting,
    );
    store.refs.delete(graph.ref);
    store.refs.delete(projection.ref);
  }
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
    graphInput,
    graphManager,
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
  it("shares one authenticated event observation across successor verification stages beyond 512 inputs", async () => {
    const f = await adopted();
    const duplicate = f.snapshot.factoryEvents![0]!;
    f.snapshot.factoryEvents!.push(
      ...Array.from({ length: 600 }, () => structuredClone(duplicate)),
    );
    const inputEvents =
      f.snapshot.factoryEvents!.length +
      f.snapshot.workItems.reduce((total, item) => total + (item.factoryEvents?.length ?? 0), 0);
    const parse = vi.spyOn(protocol, "parseFactoryEvent");

    const result = await f.read();
    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified runtime");
    expect(result.events).toBe(result.eventObservation.events);
    expect(result.eventObservation.stats).toMatchObject({
      inputEvents,
      parsedEvents: inputEvents,
      canonicalizedEvents: inputEvents,
      digestedEvents: inputEvents,
      retainedEvents: inputEvents - 600,
    });
    const indexedEvents = new Set(result.events);
    expect(
      parse.mock.calls
        .filter(([value]) => indexedEvents.has(value as FactoryEvent))
        .map(([value]) => ({
          event: (value as FactoryEvent).event,
          runId: (value as FactoryEvent).runId,
          sequence: (value as FactoryEvent).sequence,
        })),
    ).toEqual([]);
    // Three newly constructed adoption envelopes and their independent digest
    // validation account for the fixed six non-observation parses.
    expect(parse).toHaveBeenCalledTimes(inputEvents + 6);
    parse.mockRestore();
  });

  it("holds a graphless successor in bootstrap until its constrained graph projection is authenticated", async () => {
    const f = await adopted({ graphless: true });
    const bootstrap = await f.read();
    expect(bootstrap).toMatchObject({ status: "graph-bootstrap", graph: null, projection: null });

    const objective = structuredClone(f.graphInput);
    objective.workItems[0]!.id = "adopted-8";
    const invocationId = `compile-${base.oid}`;
    const successorGraph = await f.graphManager.persist({
      lease: f.args.objectiveLease,
      base,
      objective,
      compilation: { invocationId, inputTokens: 11, outputTokens: 19 },
    });
    let sequence = Math.max(...f.snapshot.factoryEvents!.map((entry) => entry.sequence)) + 1;
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        usageId: `invocation-${invocationId}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: `compile-${successorGraph.graphDigest}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
        reportedModelUsage: { inputTokens: 11, outputTokens: 19 },
      }),
      event({
        kind: "graph",
        event: "GraphCompiled",
        runId: "successor",
        sequence: sequence++,
        graphDigest: successorGraph.graphDigest,
        graphSize: 1,
        baseSha: base.oid,
        graphRef: successorGraph.ref,
        graphBlobSha: successorGraph.blobOid,
      }),
    );
    f.snapshot.workItems[0]!.body = renderWorkPacket(objective.workItems[0]!, {
      protocol: "clockgrove.factory/graph-v1",
      id: "adopted-8",
      graphDigest: successorGraph.graphDigest,
      graphSize: 1,
      index: 0,
      dependsOn: [],
      deferredCapabilityAdapters: objective.deferredCapabilityAdapters,
    });
    const successorProjection = await f.graphManager.persistProjection({
      lease: f.args.objectiveLease,
      graph: successorGraph,
      bindings: [{ compilerId: "adopted-8", issueNodeId: "issue-8", issueNumber: 8 }],
    });
    f.snapshot.factoryEvents!.push(
      event({
        kind: "graph",
        event: "GraphProjected",
        runId: "successor",
        sequence,
        graphDigest: successorGraph.graphDigest,
        graphSize: 1,
        projectionRef: successorProjection.ref,
        projectionBlobSha: successorProjection.blobOid,
      }),
    );

    const verified = await f.read();
    expect(verified).toMatchObject({ status: "verified" });
    if (verified.status !== "verified") throw new Error("expected verified adopted graph");
    expect(verified.graph.graphDigest).toBe(successorGraph.graphDigest);
    expect(verified.projection.bindings).toEqual([
      { compilerId: "adopted-8", issueNodeId: "issue-8", issueNumber: 8 },
    ]);
  });

  it("authenticates only a terminal, effect-free graph bootstrap as historical", async () => {
    const f = await adopted({ graphless: true });
    f.snapshot.factoryEvents!.push(
      event({
        kind: "run",
        event: "FactoryRunEscalated",
        runId: "successor",
        sequence: Math.max(...f.snapshot.factoryEvents!.map((entry) => entry.sequence)) + 1,
        reason: "compiler preflight rejected before graph persistence",
      }),
    );

    const result = await loadHistoricalRecoveryRuntimes({
      snapshot: f.snapshot,
      historyComplete: true,
      store: f.store,
      latestRunId: "successor",
    });
    expect([...result.keys()]).toEqual(["successor"]);
    expect(result.get("successor")).toMatchObject({
      status: "graph-bootstrap",
      currentUnknownModelUsageCount: 0,
    });
  });

  it("distinguishes an unauthenticated graph checkpoint from missing historical evidence", async () => {
    const f = await adopted({ graphless: true });
    const objective = structuredClone(f.graphInput);
    objective.workItems[0]!.id = "adopted-8";
    const invocationId = `compile-${base.oid}`;
    const checkpoint = await f.graphManager.persist({
      lease: f.args.objectiveLease,
      base,
      objective,
      compilation: { invocationId, inputTokens: 11, outputTokens: 19 },
    });
    let sequence = Math.max(...f.snapshot.factoryEvents!.map((entry) => entry.sequence)) + 1;
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        usageId: `invocation-${invocationId}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: `compile-${checkpoint.graphDigest}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
        reportedModelUsage: { inputTokens: 11, outputTokens: 19 },
      }),
      event({
        kind: "run",
        event: "FactoryRunEscalated",
        runId: "successor",
        sequence,
        reason: "graph receipt was not published",
      }),
    );

    const runtime = await f.read();
    expect(runtime, JSON.stringify(runtime)).toMatchObject({ status: "graph-bootstrap" });

    await expect(
      loadHistoricalRecoveryRuntimes({
        snapshot: f.snapshot,
        historyComplete: true,
        store: f.store,
        latestRunId: "successor",
      }),
    ).rejects.toMatchObject({
      blockerCode: "historical-graph-bootstrap-unsupported",
      message: expect.stringContaining("absent graph and projection refs"),
    });
  });

  it("preserves an interrupted bootstrap compiler dispatch as unknown instead of permitting replay", async () => {
    const f = await adopted({ graphless: true });
    const invocationId = `compile-${base.oid}`;
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        runId: "successor",
        sequence: Math.max(...f.snapshot.factoryEvents!.map((entry) => entry.sequence)) + 1,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        usageId: `invocation-${invocationId}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
      }),
    );

    expect(await f.read()).toMatchObject({
      status: "graph-bootstrap",
      graph: null,
      projection: null,
      currentUnknownManagementInvocations: [invocationId],
      currentUnknownModelUsageCount: 1,
      usage: { modelTokens: 0 },
    });
  });

  it("refuses execution effects before the adopted graph projection is authenticated", async () => {
    const f = await adopted({ graphless: true });
    await addAttempt(f);

    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["graph-bootstrap-has-execution-effects"],
    });
  });

  it("refuses a newly assigned Work Item during graph bootstrap", async () => {
    const f = await adopted({ graphless: true });
    f.snapshot.workItems[0]!.assignees = ["human-owner"];

    expect(await f.read()).toMatchObject({ status: "blocked" });
  });

  it("refuses Objective prose changed after graph-bootstrap acknowledgement", async () => {
    const f = await adopted({ graphless: true });
    f.snapshot.body = "New compilation instructions after acknowledgement.";

    expect(await f.read()).toMatchObject({ status: "blocked" });
  });

  it("retains a compiled checkpoint that crashed before its Objective receipt", async () => {
    const f = await adopted({ graphless: true });
    const objective = structuredClone(f.graphInput);
    objective.workItems[0]!.id = "adopted-8";
    const invocationId = `compile-${base.oid}`;
    const checkpoint = await f.graphManager.persist({
      lease: f.args.objectiveLease,
      base,
      objective,
      compilation: { invocationId, inputTokens: 11, outputTokens: 19 },
    });
    let sequence = Math.max(...f.snapshot.factoryEvents!.map((entry) => entry.sequence)) + 1;
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        usageId: `invocation-${invocationId}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence,
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: `compile-${checkpoint.graphDigest}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
        reportedModelUsage: { inputTokens: 11, outputTokens: 19 },
      }),
    );

    expect(await f.read()).toMatchObject({
      status: "graph-bootstrap",
      graph: null,
      projection: null,
      currentUnknownManagementInvocations: [],
      currentUnknownModelUsageCount: 0,
      usage: { modelTokens: 30 },
    });
    expect(checkpoint.ref).toBe(f.planRecord.plan.graph.ref);
  });

  it("rejects a pre-created graph ref even when forged events close the expected invocation", async () => {
    const f = await adopted({ graphless: true });
    const objective = structuredClone(f.graphInput);
    objective.workItems[0]!.id = "adopted-8";
    const precreated = await f.graphManager.persist({
      lease: f.args.objectiveLease,
      base,
      objective,
    });
    const invocationId = `compile-${base.oid}`;
    let sequence = Math.max(...f.snapshot.factoryEvents!.map((entry) => entry.sequence)) + 1;
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        usageId: `invocation-${invocationId}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence,
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: `compile-${precreated.graphDigest}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
        reportedModelUsage: { inputTokens: 11, outputTokens: 19 },
      }),
    );

    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["source-bindings-unavailable"],
    });
  });

  it("rejects a bootstrap projection receipt when its immutable projection is absent", async () => {
    const f = await adopted({ graphless: true });
    const objective = structuredClone(f.graphInput);
    objective.workItems[0]!.id = "adopted-8";
    const invocationId = `compile-${base.oid}`;
    const successorGraph = await f.graphManager.persist({
      lease: f.args.objectiveLease,
      base,
      objective,
      compilation: { invocationId, inputTokens: 11, outputTokens: 19 },
    });
    let sequence = Math.max(...f.snapshot.factoryEvents!.map((entry) => entry.sequence)) + 1;
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        usageId: `invocation-${invocationId}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: `compile-${successorGraph.graphDigest}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
        reportedModelUsage: { inputTokens: 11, outputTokens: 19 },
      }),
      event({
        kind: "graph",
        event: "GraphCompiled",
        runId: "successor",
        sequence: sequence++,
        graphDigest: successorGraph.graphDigest,
        graphSize: 1,
        baseSha: base.oid,
        graphRef: successorGraph.ref,
        graphBlobSha: successorGraph.blobOid,
      }),
      event({
        kind: "graph",
        event: "GraphProjected",
        runId: "successor",
        sequence,
        graphDigest: successorGraph.graphDigest,
        graphSize: 1,
        projectionRef: f.planRecord.plan.graph.projection.ref,
        projectionBlobSha: sha("8"),
      }),
    );

    expect(await f.read()).toMatchObject({ status: "blocked" });
  });

  it("retains an authenticated staged projection until its immutable ref is repaired", async () => {
    const f = await adopted({ graphless: true });
    const objective = structuredClone(f.graphInput);
    objective.workItems[0]!.id = "adopted-8";
    const invocationId = `compile-${base.oid}`;
    const graph = await f.graphManager.persist({
      lease: f.args.objectiveLease,
      base,
      objective,
      compilation: { invocationId, inputTokens: 11, outputTokens: 19 },
    });
    const bindings = [{ compilerId: "adopted-8", issueNodeId: "issue-8", issueNumber: 8 }];
    const staged = await f.graphManager.stageProjection({
      lease: f.args.objectiveLease,
      graph,
      bindings,
    });
    f.snapshot.workItems[0]!.body = renderWorkPacket(objective.workItems[0]!, {
      protocol: "clockgrove.factory/graph-v1",
      id: "adopted-8",
      graphDigest: graph.graphDigest,
      graphSize: 1,
      index: 0,
      dependsOn: [],
      deferredCapabilityAdapters: objective.deferredCapabilityAdapters,
    });
    let sequence = Math.max(...f.snapshot.factoryEvents!.map((entry) => entry.sequence)) + 1;
    f.snapshot.factoryEvents!.push(
      event({
        kind: "budget",
        event: "BudgetReserved",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        usageId: `invocation-${invocationId}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence: sequence++,
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: `compile-${graph.graphDigest}`,
        modelInvocationId: invocationId,
        directorEpoch: 2,
        policyDigest: f.planRecord.plan.policyDigest,
        reportedModelUsage: { inputTokens: 11, outputTokens: 19 },
      }),
      event({
        kind: "graph",
        event: "GraphCompiled",
        runId: "successor",
        sequence: sequence++,
        graphDigest: graph.graphDigest,
        graphSize: 1,
        baseSha: base.oid,
        graphRef: graph.ref,
        graphBlobSha: graph.blobOid,
      }),
      event({
        kind: "graph",
        event: "GraphProjected",
        runId: "successor",
        sequence,
        graphDigest: graph.graphDigest,
        graphSize: 1,
        projectionRef: staged.ref,
        projectionBlobSha: staged.blobOid,
      }),
    );

    expect(await f.read()).toMatchObject({ status: "graph-bootstrap" });
    await f.graphManager.persistProjection({
      lease: f.args.objectiveLease,
      graph,
      bindings,
      expectedBlobOid: staged.blobOid,
    });
    expect(await f.read()).toMatchObject({ status: "verified" });
  });

  it("exposes only digest-verified predecessor controller generations to successor consumers", async () => {
    const f = await adopted({ controllerObservation: true });
    const result = await f.read();
    expect(result).toMatchObject({ status: "verified" });
    if (result.status !== "verified") throw new Error("expected verified recovery runtime");
    expect(result.verifiedSourceControllerObservations).toMatchObject([
      {
        event: "ControllerObserved",
        runId: "source",
        controllerId: "predecessor-controller",
        epoch: 3,
      },
    ]);

    const controller = f.snapshot.factoryEvents!.find(
      (event) => event.event === "ControllerObserved",
    )!;
    Object.assign(controller, { controllerId: "unverified-controller" });
    expect(await f.read()).toMatchObject({
      status: "blocked",
      blockers: ["historical-chain-or-accounting-invalid"],
    });
  });

  it("does not synthesize predecessor controller authority when none was observed", async () => {
    const f = await adopted();
    const result = await f.read();
    expect(result).toMatchObject({ status: "verified" });
    if (result.status !== "verified") throw new Error("expected verified recovery runtime");
    expect(result.verifiedSourceControllerObservations).toEqual([]);
  });

  it("loads completed adoption with its exact original activation in a separate sequence namespace", async () => {
    const f = await adopted({ activated: true });
    const writes = [...f.store.writes];
    const result = await f.read();
    expect(result).toMatchObject({ status: "verified", adoptionVerified: true });
    if (result.status !== "verified") throw new Error("expected verified activation runtime");
    expect(result.events.filter((event) => event.event === "ActivationRequested")).toHaveLength(1);
    expect(result.currentEvents.some((event) => event.event === "ActivationRequested")).toBe(false);
    expect(result.accountingRunIds).not.toContain("original-activation");
    expect(f.store.writes).toEqual(writes);
  });

  it.each([
    "missing",
    "duplicate-envelope",
    "actor",
    "repository",
    "base",
    "policy",
    "request-id",
    "request-run",
    "protocol",
    "unrelated",
  ] as const)(
    "refuses %s original activation evidence after otherwise completed adoption",
    async (fault) => {
      const f = await adopted({ activated: true });
      const events = f.snapshot.factoryEvents!;
      const activation = events.find((event) => event.event === "ActivationRequested")!;
      const index = events.indexOf(activation);
      if (fault === "missing") events.splice(index, 1);
      else if (fault === "duplicate-envelope")
        events.push(parseFactoryEvent({ ...activation, sequence: 0 }));
      else if (fault === "unrelated")
        events.push(
          event({
            kind: "run",
            event: "FactoryRunEscalated",
            runId: "unrelated-run",
            sequence: 200,
          }),
        );
      else {
        const change = {
          actor: { requestedBy: "other-operator" },
          repository: { repository: "other/repo" },
          base: { baseSha: sha("f") },
          policy: { policyDigest: "f".repeat(64) },
          "request-id": { requestId: "other-activation" },
          "request-run": { runId: "source" },
          protocol: { controllerProtocolMax: "clockgrove.factory/v3" },
        }[fault];
        events[index] = { ...activation, ...change } as FactoryEvent;
      }
      const writes = [...f.store.writes];
      expect(await f.read()).toMatchObject({
        status: "blocked",
        adoptionVerified: false,
        executionAuthorized: false,
      });
      expect(f.store.writes).toEqual(writes);
    },
  );

  it("retains exact lost-response activation duplicates without treating them as new authority", async () => {
    const f = await adopted({ activated: true });
    const activation = f.snapshot.factoryEvents!.find(
      (event) => event.event === "ActivationRequested",
    )!;
    f.snapshot.factoryEvents!.push(structuredClone(activation));
    expect(await f.read()).toMatchObject({ status: "verified" });
  });

  it.each(["readRef", "readCommit", "readBlob", "getRepositoryFacts", "getBranchHead"] as const)(
    "preserves typed refusal through %s and retries only on a new full observation",
    async (method) => {
      const f = await adopted();
      const refusal = new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: 123456 },
        new Error("primary exhausted"),
      );
      const read = vi.spyOn(f.store, method).mockRejectedValueOnce(refusal);
      const port = recoveryReadPort(f.store as unknown as GitHubControlStore, "o", "r");
      await expect(f.read(port)).rejects.toBe(refusal);
      expect(refusal.retryAfterMs).toBe(123456);
      expect(read).toHaveBeenCalledTimes(1);
      expect(await f.read(port)).toMatchObject({ status: "verified" });
    },
  );
  it("defers adoption on observation refusal without writes or lost request identity", async () => {
    const f = await fixture();
    const refusal = new PlatformUnavailableError(
      { kind: "rate_limit", retryAfterMs: 321000 },
      new Error("primary exhausted"),
    );
    const writes = f.store.writes.length;
    vi.spyOn(f.store, "readBlob").mockRejectedValueOnce(refusal);
    await expect(f.make().adopt(f.args)).rejects.toBe(refusal);
    expect(f.store.writes).toHaveLength(writes);
    expect(await f.make().adopt(f.args)).toMatchObject({ status: "adopted" });
  });
  it("preserves a persisted claim after a typed refusal without immediate repair reads or duplicate claim writes", async () => {
    const f = await fixture();
    const refusal = new PlatformUnavailableError(
      { kind: "rate_limit", retryAfterMs: 321000 },
      new Error("primary exhausted"),
    );
    const original = f.store.createRef.bind(f.store);
    const refs = vi.spyOn(f.store, "readRef");
    let readsAtRefusal = 0;
    const creates = vi.spyOn(f.store, "createRef").mockImplementationOnce(async (ref, oid) => {
      const result = await original(ref, oid);
      expect(result).toBe(true);
      readsAtRefusal = refs.mock.calls.length;
      throw refusal;
    });
    await expect(f.make().adopt(f.args)).rejects.toBe(refusal);
    expect(refs).toHaveBeenCalledTimes(readsAtRefusal);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(await f.make().adopt(f.args)).toMatchObject({ status: "adopted" });
    expect(creates).toHaveBeenCalledTimes(1);
  });
  it("reuses immutable objects across full reconstructions without caching snapshots, authority refs or mutable base", async () => {
    const f = await adopted();
    const methods = ["readCommit", "readBlob", "readTreeEntry"] as const;
    const reads = methods.map((method) => vi.spyOn(f.store, method));
    const refs = vi.spyOn(f.store, "readRef"),
      facts = vi.spyOn(f.store, "getRepositoryFacts"),
      baseRead = vi.spyOn(f.store, "getBranchHead");
    const port = recoveryReadPort(f.store as unknown as GitHubControlStore, "o", "r");
    const readSnapshot = vi.fn(async () => ({
      snapshot: structuredClone(f.snapshot),
      historyComplete: f.state.historyComplete,
    }));
    const prove = () =>
      loadRecoveryRuntime({ objective: 7, runId: "successor", store: port, readSnapshot });
    expect(await prove()).toMatchObject({ status: "verified" });
    const counts = reads.map((read) => read.mock.calls.length);
    const presentTrees = (
      await Promise.all(reads[2]!.mock.results.map((result) => result.value))
    ).filter((value) => value !== null).length;
    expect(counts.every((count) => count > 0)).toBe(true);
    const refCount = refs.mock.calls.length,
      factsCount = facts.mock.calls.length,
      baseCount = baseRead.mock.calls.length;
    for (let i = 0; i < 5; i++) expect(await prove()).toMatchObject({ status: "verified" });
    expect(reads.slice(0, 2).map((read) => read.mock.calls.length)).toEqual(counts.slice(0, 2));
    expect(
      (await Promise.all(reads[2]!.mock.results.map((result) => result.value))).filter(
        (value) => value !== null,
      ),
    ).toHaveLength(presentTrees);
    expect(refs.mock.calls.length).toBe(refCount * 6);
    expect(facts.mock.calls.length).toBe(factsCount * 6);
    expect(baseRead.mock.calls.length).toBe(baseCount * 6);
    expect(readSnapshot).toHaveBeenCalledTimes(6);
    f.store.head = { ...base, oid: sha("8") };
    expect(await prove()).toMatchObject({ sourceEvidence: { currentBase: "changed" } });
    f.state.historyComplete = false;
    expect(await prove()).toMatchObject({ status: "blocked", blockers: ["snapshot-incomplete"] });
    f.state.historyComplete = true;
    f.store.refs.delete(f.planRecord.ref);
    expect(await prove()).toMatchObject({ status: "blocked" });
  });
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
    const f = await adopted({ controllerObservation: true });
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
      async assertMutationAuthorized(this: { assertCurrent(): Promise<void> }) {
        await this.assertCurrent();
      },
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
    expect(result.get("third")!.verifiedSourceControllerObservations).toMatchObject([
      {
        event: "ControllerObserved",
        runId: "source",
        controllerId: "predecessor-controller",
        epoch: 3,
      },
    ]);
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
