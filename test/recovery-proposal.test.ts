import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FactoryReadSnapshot } from "../src/application/status.js";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { ReviewCheckpointManager } from "../src/control/reviews.js";
import { attemptRef } from "../src/control/attempts.js";
import { decodeEventComments, encodeEventTrailer } from "../src/control/receipts.js";
import { RecoveryRequestService } from "../src/recovery/requests.js";
import { discoverRecoveryActivation } from "../src/recovery/discovery.js";
import { renderWorkPacket, type CompiledObjective } from "../src/graph.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { publicationBranch } from "../src/publication/publisher.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import { buildRecoveryProposal } from "../src/recovery/proposal.js";
import { parseRecoveryPlan, RecoveryPlanManager } from "../src/recovery/plan.js";
import type { RecoveryReadStore } from "../src/recovery/assessment.js";
import { RecoveryClaimManager } from "../src/recovery/claims.js";
import { recoveryAdoptionEvents } from "../src/recovery/transaction.js";
import { recoveryEventDigest } from "../src/recovery/identity.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const now = new Date("2026-09-05T00:00:00Z");
const policy = {
  ...DEFAULT_RUN_POLICY,
  economics: {
    maxModelTokens: 1000,
    maxSandboxMinutes: 0,
    maxManagedSessions: 0,
    minCloudTimeSavedMinutes: 0,
  },
};

async function fixture(withPublications = true, native: "siblings" | "stack" | false = false) {
  const acceptedPolicy = native
    ? {
        ...policy,
        delivery: {
          mode: "stacked-prs" as const,
          onUnavailable: "escalate" as const,
          merge: "bottom-up" as const,
        },
      }
    : policy;
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  let counter = 0;
  const oid = () => createHash("sha1").update(`fixture-${counter++}`).digest("hex");
  const base: GitCommitObject = {
    oid: sha("a"),
    treeOid: sha("b"),
    parentOids: [],
    message: "base",
    serverTime: now,
  };
  commits.set(base.oid, base);
  const storage: CompiledGraphStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (id) => {
      const value = commits.get(id);
      if (!value) throw new Error("private credential-shaped provider error");
      return value;
    },
    readBlob: async (id) => {
      const value = blobs.get(id);
      if (!value) throw new Error("missing blob");
      return value;
    },
    readTreeEntry: async (id, path) => trees.get(id)?.get(path) ?? null,
    createBlob: async (bytes) => {
      const id = createHash("sha1").update(bytes).digest("hex");
      blobs.set(id, bytes);
      return id;
    },
    createTree: async ({ entries }) => {
      const id = oid();
      trees.set(
        id,
        new Map(entries.filter((entry) => entry.sha).map((entry) => [entry.path, entry.sha!])),
      );
      return id;
    },
    createCommit: async (args) => {
      const id = oid();
      commits.set(id, { ...args, oid: id, serverTime: now });
      return id;
    },
    createRef: async (ref, id) => {
      if (refs.has(ref)) return false;
      refs.set(ref, id);
      return true;
    },
  };
  const lease: LeaseState = {
    objective: 7,
    runId: "source",
    holder: "operator",
    policyDigest: policyDigest(acceptedPolicy),
    ref: "lease",
    oid: sha("f"),
    treeOid: base.treeOid,
    epoch: 1,
    sequence: 1,
    expiresAt: now,
  };
  const leases = { assertCurrent: async () => {} } as unknown as LeaseManager;
  const objective: CompiledObjective = {
    title: "Private graph",
    workItems: ["a", "b", "c"].map((id) => ({
      id,
      title: id,
      goal: `Private goal ${id}`,
      acceptance: ["pass"],
      scope: [`src/${id}.ts`],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      dependsOn: id === "c" ? ["a", "b"] : id === "b" && native === "stack" ? ["a"] : [],
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
      ...(native
        ? {
            delivery: {
              group: id === "b" && native === "stack" ? "a" : id,
              relationship:
                id === "c"
                  ? ("join-after-merge" as const)
                  : id === "b" && native === "stack"
                    ? ("continue-stack" as const)
                    : ("root" as const),
              ...(id === "b" && native === "stack" ? { parentWorkItem: "a" } : {}),
            },
          }
        : {}),
    })),
  };
  const manager = new CompiledGraphManager(storage, leases);
  const graph = await manager.persist({ lease, base, objective });
  const projection = await manager.persistProjection({
    lease,
    graph,
    bindings: objective.workItems.map((item, index) => ({
      compilerId: item.id,
      issueNodeId: `I_${8 + index}`,
      issueNumber: 8 + index,
    })),
  });
  let sequence = 1;
  const event = (fields: Record<string, unknown>) =>
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      objective: 7,
      runId: "source",
      at: now.toISOString(),
      sequence: sequence++,
      ...fields,
    });
  const start = event({
    kind: "run",
    event: "FactoryRunStarted",
    actor: "operator",
    repository: "o/r",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    baseSha: base.oid,
    policy: acceptedPolicy,
    policyDigest: policyDigest(acceptedPolicy),
  });
  const snapshot: FactoryReadSnapshot = {
    id: "I_7",
    number: 7,
    title: objective.title,
    repositoryId: "R_1",
    authorLogin: "operator",
    defaultBranch: "main",
    closed: false,
    factoryEvents: [
      start,
      event({
        kind: "graph",
        event: "GraphCompiled",
        graphDigest: graph.graphDigest,
        graphSize: 3,
        baseSha: base.oid,
        graphRef: graph.ref,
        graphBlobSha: graph.blobOid,
      }),
      event({
        kind: "graph",
        event: "GraphProjected",
        graphDigest: graph.graphDigest,
        graphSize: 3,
        projectionRef: projection.ref,
        projectionBlobSha: projection.blobOid,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        phase: "management",
        unit: "model_tokens",
        amount: 10,
        usageId: `compile-${graph.graphDigest}`,
      }),
    ],
    workItems: objective.workItems.map((item, index) => ({
      id: `I_${8 + index}`,
      number: 8 + index,
      title: item.title,
      body: renderWorkPacket(item, {
        protocol: "clockgrove.factory/graph-v1",
        id: item.id,
        graphDigest: graph.graphDigest,
        graphSize: 3,
        index,
        dependsOn: item.dependsOn,
      }),
      closed: false,
      blockedBy: item.dependsOn.map((id) => ({ number: id === "a" ? 8 : 9, closed: false })),
      linkedPullRequests: [],
      copilotAssignments: [],
      factoryEvents: [],
    })),
  };
  if (native)
    snapshot.factoryEvents!.push(
      event({
        kind: "delivery",
        event: "DeliverySelected",
        requested: "stacked-prs",
        selected: "native-stacks",
        capabilityVersion: "2026-03-10",
        reason: "native capability observed",
      }),
    );
  type Pull = Awaited<ReturnType<RecoveryReadStore["readPullRequest"]>>;
  const pulls = new Map<number, Pull>();
  let currentBase = base;
  if (withPublications) {
    for (const index of [0, 1]) {
      const item = snapshot.workItems[index]!;
      const artifactDigest = digest(index === 0 ? "c" : "d");
      const evidenceDigest = digest(index === 0 ? "e" : "f");
      const headSha = sha(index === 0 ? "c" : "e");
      const tree = sha(index === 0 ? "d" : "f");
      const branch = publicationBranch(7, item.number, 1);
      commits.set(headSha, {
        oid: headSha,
        treeOid: tree,
        parentOids: [base.oid],
        message: `head\nFactory-Artifact: ${artifactDigest}\nFactory-Validation: ${evidenceDigest}`,
        serverTime: now,
      });
      refs.set(`refs/heads/${branch}`, headSha);
      const attempt = (fields: Record<string, unknown>) =>
        event({
          kind: "attempt",
          workItem: item.number,
          attempt: 1,
          backend: "codex-sdk/local-worktree",
          baseSha: base.oid,
          directorEpoch: 1,
          policyDigest: lease.policyDigest,
          ...fields,
        });
      const reserved = attempt({ event: "AttemptReserved" });
      const reservationOid = oid();
      refs.set(attemptRef(7, item.number, 1), reservationOid);
      commits.set(reservationOid, {
        oid: reservationOid,
        treeOid: base.treeOid,
        parentOids: [base.oid],
        message: encodeEventTrailer(reserved),
        serverTime: now,
      });
      const review = await new ReviewCheckpointManager(storage, leases).persist({
        lease,
        identity: {
          kind: "artifact",
          runId: "source",
          objective: 7,
          workItem: item.number,
          attempt: 1,
          artifactDigest,
          baseSha: base.oid,
          outputTreeSha: tree,
          evidenceDigest,
        },
        result: {
          review: { accepted: true, summary: "Private review text", unmetCriteria: [], risks: [] },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      });
      const exact = bindValidationToPublishedHead({
        validation: {
          passed: true,
          digest: evidenceDigest,
          baseSha: base.oid,
          outputTreeSha: tree,
        },
        publishedHeadSha: headSha,
        publishedTreeSha: tree,
        publishedBaseSha: base.oid,
      });
      item.factoryEvents!.push(
        reserved,
        attempt({ event: "AttemptCollected", artifactDigest }),
        event({
          kind: "validation",
          event: "ValidationRecorded",
          workItem: item.number,
          attempt: 1,
          baseSha: base.oid,
          outputTreeSha: tree,
          evidenceDigest,
          passed: true,
        }),
        event({
          kind: "budget",
          event: "BudgetReconciled",
          workItem: item.number,
          attempt: 1,
          phase: "management",
          unit: "model_tokens",
          amount: 15,
          usageId: `review-${review.identityDigest}`,
        }),
        attempt({ event: "AttemptValidated", artifactDigest }),
        attempt({ event: "AttemptPublished", artifactDigest, headSha }),
        event({
          kind: "publication",
          event: "PublicationRecorded",
          workItem: item.number,
          attempt: 1,
          unitId: `delivery/${index === 0 || native === "stack" ? "a" : "b"}`,
          itemId: index === 0 ? "a" : "b",
          mode: native ? "native-stacks" : "regular-prs",
          position: native === "stack" ? index : 0,
          ...(native === "stack" && index === 1 ? { parentItemId: "a" } : {}),
          branch,
          baseBranch: "main",
          baseSha: base.oid,
          headSha,
          pullRequest: 18 + index,
          capabilityVersion: "2026-03-10",
          validationDigest: evidenceDigest,
          exactHeadValidationDigest: exact.digest,
        }),
      );
      const merged = index === 0;
      const mergeSha = sha("1");
      if (merged) {
        currentBase = {
          oid: mergeSha,
          treeOid: tree,
          parentOids: [base.oid],
          message: "merge A",
          serverTime: now,
        };
        commits.set(mergeSha, currentBase);
        item.closed = true;
      }
      const pull: Pull = {
        number: 18 + index,
        nodeId: `PR_${18 + index}`,
        baseRepository: "o/r",
        headRepository: "o/r",
        headRef: branch,
        state: merged ? "closed" : "open",
        merged,
        mergeable: true,
        mergeableState: "clean",
        draft: false,
        headSha,
        baseSha: merged ? base.oid : currentBase.oid,
        baseRef: "main",
        mergeCommitSha: merged ? mergeSha : null,
        createdAt: now,
      };
      pulls.set(pull.number!, pull);
      item.linkedPullRequests = [
        {
          id: pull.nodeId!,
          number: pull.number!,
          headSha,
          state: merged ? "MERGED" : "OPEN",
          checks: null,
          isDraft: false,
          title: "publication",
          body: "",
          changedLines: 1,
          changedFiles: 1,
          changedFilePaths: [],
          commitSubjects: ["publication"],
          mergeable: "MERGEABLE",
          createdAt: now,
          headCommittedAt: now,
          mergedAt: merged ? now : null,
          closedAt: merged ? now : null,
          agentWorkEvents: [],
        },
      ];
    }
  }
  snapshot.factoryEvents!.push(event({ kind: "run", event: "FactoryRunEscalated", sequence: 100 }));
  const mutations = {
    createRef: vi.fn(() => {
      throw new Error("proposal must not mutate");
    }),
    createCommit: vi.fn(() => {
      throw new Error("proposal must not mutate");
    }),
  };
  const store: RecoveryReadStore = {
    ...storage,
    ...mutations,
    listRefs: vi.fn(async (prefix: string) =>
      [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, id]) => ({ ref, oid: id })),
    ),
    readPullRequest: vi.fn(async (number: number) => {
      const pull = pulls.get(number);
      if (!pull) throw new Error("missing pull");
      return pull;
    }),
    getRepositoryFacts: async () => ({
      fullName: "o/r",
      fork: false,
      private: true,
      defaultBranch: "main",
      canPush: true,
    }),
    getBranchHead: async () => currentBase,
    readBranchRules: async () => [],
    readChecks: async () => ({ failed: [], pending: [], observed: [], observedChecks: [] }),
  };
  const build = (overrides: Partial<Parameters<typeof buildRecoveryProposal>[0]> = {}) =>
    buildRecoveryProposal({
      repository: "o/r",
      snapshot,
      historyComplete: true,
      store,
      requestId: "request",
      successorRunId: "successor",
      ...overrides,
    });
  return {
    build,
    snapshot,
    store,
    storage,
    mutations,
    lease,
    leases,
    refs,
    commits,
    blobs,
    trees,
    pulls,
    graph,
    start,
    event,
    base,
  };
}

describe("explicit recovery request application", () => {
  async function requests() {
    const f = await fixture();
    let actor = "operator";
    let loseCommentResponse = false;
    let beforeRead: (() => void) | undefined;
    const comments: FactoryEvent[] = [];
    const store = {
      ...f.storage,
      serverTime: async () => now,
      getAuthenticatedLogin: async () => actor,
      compareAndSwapRef: vi.fn(
        async ({
          ref,
          beforeOid,
          afterOid,
        }: {
          ref: string;
          beforeOid: string;
          afterOid: string;
        }) => {
          if (f.refs.get(ref) !== beforeOid) return false;
          f.refs.set(ref, afterOid);
          return true;
        },
      ),
      addIssueComment: vi.fn(async (_id: string, body: string) => {
        const events = decodeEventComments(body);
        comments.push(...events);
        f.snapshot.factoryEvents!.push(...events);
        if (loseCommentResponse) throw new Error("private transport error");
      }),
    };
    const reader = vi.fn(async () => {
      beforeRead?.();
      return { snapshot: structuredClone(f.snapshot), historyComplete: true };
    });
    const service = new RecoveryRequestService({
      repository: "o/r",
      readSnapshot: reader,
      readStore: f.store,
      store,
    });
    return {
      ...f,
      service,
      writer: store,
      reader,
      comments,
      setActor: (value: string) => {
        actor = value;
      },
      loseResponse: () => {
        loseCommentResponse = true;
      },
      onRead: (fn: () => void) => {
        beforeRead = fn;
      },
    };
  }

  it("proposes without writes, then persists acknowledged immutable authority without reviving the predecessor", async () => {
    const f = await requests();
    const count = f.refs.size;
    const proposal = await f.service.propose({ objective: 7, requestId: "request" });
    expect(proposal.status).toBe("proposed");
    expect(f.refs.size).toBe(count);
    expect(f.comments).toEqual([]);
    const request = await f.service.request({
      objective: 7,
      requestId: "request",
      planDigest: proposal.planDigest!,
    });
    expect(request.event).toBe("RecoveryRequested");
    expect(request.runId).toBe("source");
    expect(request.successorRunId).toBe(proposal.plan!.successorRunId);
    expect(f.comments.map((event) => event.event)).toEqual(["RecoveryRequested"]);
    expect(
      f.snapshot.factoryEvents!.filter((event) => event.event === "FactoryRunStarted"),
    ).toHaveLength(1);
    const record = await new RecoveryPlanManager(f.storage, f.leases).load(7, request.planDigest);
    expect(record!.plan.allowance.increment.modelTokens).toBe(0);
    expect(record!.plan.allowance.after).toEqual(record!.plan.allowance.before);
  });

  it("observes the same accepted request after response loss without recompilation or a second write", async () => {
    const f = await requests();
    const proposal = await f.service.propose({ objective: 7, requestId: "request" });
    const input = { objective: 7, requestId: "request", planDigest: proposal.planDigest! };
    f.loseResponse();
    const first = await f.service.request(input);
    const retry = await f.service.request(input);
    expect(retry).toEqual(first);
    expect(f.writer.addIssueComment).toHaveBeenCalledTimes(1);
  });

  it("discovers only the exact acknowledged successor and suppresses terminal successors", async () => {
    const f = await requests();
    const proposal = await f.service.propose({ objective: 7, requestId: "request" });
    const request = await f.service.request({
      objective: 7,
      requestId: "request",
      planDigest: proposal.planDigest!,
    });
    const discover = () =>
      discoverRecoveryActivation({
        repository: "o/r",
        objective: 7,
        actor: "operator",
        events: f.snapshot.factoryEvents!,
        store: f.store,
      });
    expect((await discover())!.recovery).toEqual({
      requestId: request.requestId,
      planDigest: request.planDigest,
      successorRunId: request.successorRunId,
    });
    f.snapshot.factoryEvents!.push(
      parseFactoryEvent({
        ...f.start,
        runId: request.successorRunId,
        sequence: request.sequence + 1,
        recoveryRequestId: request.requestId,
        recoveryPlanDigest: request.planDigest,
        predecessorRunId: request.predecessorRunId,
        baseSha: request.baseSha,
      }),
    );
    expect(await discover()).not.toBeNull();
    f.snapshot.factoryEvents!.push(
      f.event({
        kind: "run",
        event: "FactoryRunCompleted",
        runId: request.successorRunId,
        sequence: request.sequence + 2,
      }),
    );
    expect(await discover()).toBeNull();
  });

  it("rejects foreign discovery identity and competing predecessor requests", async () => {
    const f = await requests();
    const proposal = await f.service.propose({ objective: 7, requestId: "request" });
    const request = await f.service.request({
      objective: 7,
      requestId: "request",
      planDigest: proposal.planDigest!,
    });
    const input = {
      repository: "o/r",
      objective: 7,
      actor: "operator",
      events: f.snapshot.factoryEvents!,
      store: f.store,
    };
    await expect(discoverRecoveryActivation({ ...input, actor: "other" })).rejects.toThrow(
      "binding",
    );
    await expect(
      discoverRecoveryActivation({
        ...input,
        events: [
          ...input.events,
          parseFactoryEvent({
            ...request,
            requestId: "competitor",
            sequence: request.sequence + 1,
          }),
        ],
      }),
    ).rejects.toThrow("Competing");
  });

  it("recovers a committed plan ref after response loss without replacing it", async () => {
    const f = await requests();
    const original = f.writer.createRef;
    let observedPlanOid: string | undefined;
    f.writer.createRef = async (ref, oid) => {
      const created = await original(ref, oid);
      if (ref.includes("recovery-plans")) {
        observedPlanOid = oid;
        throw new Error("response lost");
      }
      return created;
    };
    const proposal = await f.service.propose({ objective: 7, requestId: "request" });
    await f.service.request({
      objective: 7,
      requestId: "request",
      planDigest: proposal.planDigest!,
    });
    const stored = [...f.refs].filter(([ref]) => ref.includes("recovery-plans"));
    expect(stored).toHaveLength(1);
    expect(stored[0]![1]).toBe(observedPlanOid);
    expect(f.comments).toHaveLength(1);
  });

  it("rejects a stale digest or changed actor before writing a lease or request", async () => {
    const f = await requests();
    const proposal = await f.service.propose({ objective: 7, requestId: "request" });
    const count = f.refs.size;
    await expect(
      f.service.request({ objective: 7, requestId: "request", planDigest: digest("0") }),
    ).rejects.toThrow("proposal changed");
    f.setActor("someone-else");
    await expect(
      f.service.request({ objective: 7, requestId: "request", planDigest: proposal.planDigest! }),
    ).rejects.toThrow("actor");
    expect(f.refs.size).toBe(count);
    expect(f.comments).toEqual([]);
  });

  it("does not infer increments, accept new policy, or reuse the request ID for different authority", async () => {
    const f = await requests();
    const allowanceIncrement = {
      modelTokens: 100,
      sandboxMinutes: 0,
      managedSessions: 0,
      implementationAttemptsPerItem: 0,
    };
    const proposal = await f.service.propose({
      objective: 7,
      requestId: "request",
      allowanceIncrement,
    });
    await expect(
      f.service.request({ objective: 7, requestId: "request", planDigest: proposal.planDigest! }),
    ).rejects.toThrow("proposal changed");
    const input = {
      objective: 7,
      requestId: "request",
      planDigest: proposal.planDigest!,
      allowanceIncrement,
    };
    await f.service.request(input);
    await expect(
      f.service.request({
        ...input,
        allowanceIncrement: { ...allowanceIncrement, modelTokens: 200 },
      }),
    ).rejects.toThrow("allowance");
    await expect(f.service.request({ ...input, policy: {} } as typeof input)).rejects.toThrow();
    expect(f.comments).toHaveLength(1);
  });

  it("rechecks source history under the lease and leaves no authority when it changes", async () => {
    const f = await requests();
    const proposal = await f.service.propose({ objective: 7, requestId: "request" });
    let reads = 0;
    f.onRead(() => {
      if (++reads === 2) f.snapshot.closed = true;
    });
    await expect(
      f.service.request({ objective: 7, requestId: "request", planDigest: proposal.planDigest! }),
    ).rejects.toThrow("changed while acquiring");
    expect(f.comments).toEqual([]);
    expect([...f.refs.keys()].some((ref) => ref.includes("recovery-plans"))).toBe(false);
  });
});

describe("bounded read-only immutable recovery proposals", () => {
  it("retains integrated A, revalidates stale B, and executes untouched join C without invented attempts", async () => {
    const f = await fixture();
    const result = await f.build();
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe("proposed");
    expect(result.executionAuthorized).toBe(false);
    expect(parseRecoveryPlan(result.plan)).toEqual(result.plan);
    expect(result.plan!.items.map((item) => item.action)).toEqual([
      "integrated",
      "revalidate",
      "execute",
    ]);
    expect(result.plan!.items[2]!.source).toBeNull();
    expect(result.plan!.items.map((item) => item.resources.state)).toEqual([
      "unknown",
      "unknown",
      "not-required",
    ]);
    expect(result.plan!.acceptedPolicy).toEqual(policy);
    expect(result.plan!.allowance.increment).toEqual({
      modelTokens: 0,
      sandboxMinutes: 0,
      managedSessions: 0,
      implementationAttemptsPerItem: 0,
    });
    expect(JSON.stringify(result)).not.toContain("Private review text");
    expect(JSON.stringify(result)).not.toContain("Private goal");
    expect(f.mutations.createRef).not.toHaveBeenCalled();
    expect(f.mutations.createCommit).not.toHaveBeenCalled();
  });

  it("retains earlier executed history even when the latest terminal run is an empty failure", async () => {
    const f = await fixture();
    f.snapshot.factoryEvents!.push(
      f.event({ ...f.start, runId: "empty", sequence: 101 }),
      f.event({ kind: "run", event: "FactoryRunEscalated", runId: "empty", sequence: 102 }),
    );
    const result = await f.build();
    expect(result.blockers).toEqual([]);
    expect(result.plan!.history.map((entry) => entry.runId)).toEqual(["source", "empty"]);
    expect(result.plan!.predecessor.runId).toBe("empty");
    expect(result.plan!.graph.sourceRunId).toBe("source");
    expect(result.plan!.items[1]!.source!.runId).toBe("source");
  });

  it("changes only explicitly incremented ceilings and preserves backend/model policy", async () => {
    const f = await fixture(false);
    const result = await f.build({
      allowanceIncrement: {
        modelTokens: 50,
        sandboxMinutes: 0,
        managedSessions: 0,
        implementationAttemptsPerItem: 1,
      },
    });
    expect(result.blockers).toEqual([]);
    expect(result.plan!.allowance.after.modelTokens).toBe(1050);
    expect(result.plan!.allowance.after.implementationAttemptsPerItem).toBe(
      policy.maxAttemptsPerItem + 1,
    );
    expect(result.plan!.acceptedPolicy.backendOrder).toEqual(policy.backendOrder);
    expect(result.plan!.acceptedPolicy.allowedPaidBackends).toEqual([]);
  });

  it("reports unknown model usage for exact acknowledgement without assuming cleanup", async () => {
    const f = await fixture(false);
    f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter((entry) => entry.kind !== "budget");
    const first = await f.build();
    expect(first.status).toBe("proposed");
    expect(first.unknownUsageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.plan!.unknownUsageAcknowledgementDigest).toBeNull();
    const acknowledged = await f.build({
      unknownUsageAcknowledgementDigest: first.unknownUsageDigest,
    });
    expect(acknowledged.status).toBe("proposed");
    expect(acknowledged.plan!.unknownUsageAcknowledgementDigest).toBe(first.unknownUsageDigest);
    const invalid = await f.build({ unknownUsageAcknowledgementDigest: digest("a") });
    expect(invalid.status).toBe("blocked");
    expect(invalid.blockers[0]!.code).toBe("unknown-usage-acknowledgement-mismatch");
  });

  it.each([
    "incomplete",
    "missing-child-events",
    "removed-child",
    "changed-packet",
    "missing-start",
    "active",
    "conflicting-terminal",
    "foreign-objective",
    "foreign-repository",
    "orphan-ref",
    "missing-reservation",
    "future-allowance",
  ])("fails closed for %s", async (fault) => {
    const f = await fixture();
    let overrides: Partial<Parameters<typeof buildRecoveryProposal>[0]> = {};
    if (fault === "incomplete") overrides = { historyComplete: false };
    if (fault === "missing-child-events") delete f.snapshot.workItems[2]!.factoryEvents;
    if (fault === "removed-child") f.snapshot.workItems.pop();
    if (fault === "changed-packet") f.snapshot.workItems[0]!.body += "\nChanged authority";
    if (fault === "missing-start")
      f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter(
        (entry) => entry.event !== "FactoryRunStarted",
      );
    if (fault === "active")
      f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter(
        (entry) => entry.event !== "FactoryRunEscalated",
      );
    if (fault === "conflicting-terminal")
      f.snapshot.factoryEvents!.push(
        f.event({ kind: "run", event: "FactoryRunCancelled", sequence: 101 }),
      );
    if (fault === "foreign-objective") f.snapshot.workItems[0]!.factoryEvents![0]!.objective = 44;
    if (fault === "foreign-repository") overrides = { repository: "o/foreign" };
    if (fault === "orphan-ref") f.refs.set(attemptRef(7, 99, 1), sha("9"));
    if (fault === "missing-reservation") f.refs.delete(attemptRef(7, 8, 1));
    if (fault === "future-allowance")
      overrides = {
        allowanceIncrement: {
          modelTokens: Number.MAX_SAFE_INTEGER,
          sandboxMinutes: 0,
          managedSessions: 0,
          implementationAttemptsPerItem: 0,
        },
      };
    const result = await f.build(overrides);
    expect(result.status).toBe("blocked");
    expect(result.plan).toBeNull();
    expect(result.executionAuthorized).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("credential-shaped");
  });

  it("does not misrepresent merge-candidate squash output as original publication validation", async () => {
    const f = await fixture();
    f.commits.get(sha("1"))!.treeOid = sha("9");
    const result = await f.build();
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]!.code).toBe("merge-candidate-source-unsupported");
  });

  it("keeps changed PR heads explicit as revalidation rather than reusable publication", async () => {
    const f = await fixture();
    f.pulls.get(19)!.headSha = sha("9");
    f.commits.set(sha("9"), {
      ...f.base,
      oid: sha("9"),
      treeOid: sha("8"),
      parentOids: [f.base.oid],
    });
    f.snapshot.workItems[1]!.linkedPullRequests![0]!.headSha = sha("9");
    const result = await f.build();
    expect(result.blockers).toEqual([]);
    expect(result.plan!.items[1]!.action).toBe("revalidate");
    expect(result.plan!.items[1]!.source!.publication!.headSha).toBe(sha("e"));
    expect(result.plan!.items[1]!.observedPullRequest!.headSha).toBe(sha("9"));
  });

  it("rejects historical effects that borrow another run's global attempt reservation", async () => {
    const f = await fixture();
    f.snapshot.factoryEvents!.push(
      f.event({ ...f.start, runId: "other", sequence: 101 }),
      f.event({ kind: "run", event: "FactoryRunEscalated", runId: "other", sequence: 103 }),
    );
    const reserved = f.snapshot.workItems[0]!.factoryEvents!.find(
      (event) => event.event === "AttemptReserved",
    )!;
    f.snapshot.workItems[0]!.factoryEvents!.push(
      f.event({ ...reserved, event: "AttemptStarted", runId: "other", sequence: 102 }),
    );
    const result = await f.build();
    expect(result.status).toBe("blocked");
    expect(result.plan).toBeNull();
  });

  it("does not treat a failed runless check rollup as reusable", async () => {
    const f = await fixture();
    const pull = f.pulls.get(19)!;
    f.store.getBranchHead = async () => f.base;
    pull.baseSha = f.base.oid;
    f.snapshot.workItems[1]!.linkedPullRequests![0]!.checks = "FAILURE";
    const result = await f.build();
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]!.code).toBe("checks");
  });

  it("accepts independently published native-mode siblings without stack IDs", async () => {
    const f = await fixture(true, "siblings");
    const result = await f.build();
    expect(result.blockers).toEqual([]);
    expect(result.plan!.items.map((item) => item.action)).toEqual([
      "integrated",
      "revalidate",
      "execute",
    ]);
    expect(result.plan!.items[0]!.source!.publication!.stackNumber).toBeNull();
  });

  it("requires observed stack identity for an actual linear stack", async () => {
    const f = await fixture(true, "stack");
    const result = await f.build();
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]!.code).toBe("delivery");
  });

  it("does not invent native delivery authority from publication fields alone", async () => {
    const f = await fixture(true, "siblings");
    f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter(
      (event) => event.kind !== "delivery",
    );
    expect((await f.build()).blockers[0]!.code).toBe("delivery");
  });

  it("caches immutable reads and never exposes provider error bodies", async () => {
    const f = await fixture();
    const read = vi.spyOn(f.store, "readCommit");
    const result = await f.build();
    expect(result.status).toBe("proposed");
    expect(read.mock.calls.filter(([oid]) => oid === f.base.oid)).toHaveLength(1);
    expect(result.reads.performed).toBeLessThanOrEqual(result.reads.limit);
    f.store.readBlob = async () => {
      throw new Error("private credential-shaped provider error");
    };
    const blocked = await f.build();
    expect(blocked.status).toBe("blocked");
    expect(JSON.stringify(blocked)).not.toContain("credential-shaped");
  });

  it("rejects oversized reservation enumeration without treating it as observed empty", async () => {
    const f = await fixture(false);
    f.store.listRefs = async (prefix) =>
      prefix.includes("/attempts/")
        ? Array.from({ length: 1001 }, (_, index) => ({
            ref: attemptRef(7, 8, index + 1),
            oid: sha("a"),
          }))
        : [];
    const result = await f.build();
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]!.code).toBe("reservation");
    expect(result.reads.performed).toBeLessThanOrEqual(result.reads.limit);
  });

  it("bounds total unique reads during authenticated historical reservation verification", async () => {
    const f = await fixture(false);
    for (let attempt = 1; attempt <= 300; attempt++) {
      const reserved = f.event({
        kind: "attempt",
        event: "AttemptReserved",
        workItem: 8,
        attempt,
        backend: "codex-sdk/local-worktree",
        baseSha: f.base.oid,
        directorEpoch: 1,
        policyDigest: f.lease.policyDigest,
        sequence: 100 + attempt,
      });
      const oid = createHash("sha1").update(`reservation-${attempt}`).digest("hex");
      f.snapshot.workItems[0]!.factoryEvents!.push(reserved);
      f.refs.set(attemptRef(7, 8, attempt), oid);
      f.commits.set(oid, {
        ...f.base,
        oid,
        parentOids: [f.base.oid],
        message: encodeEventTrailer(reserved),
      });
    }
    const result = await f.build();
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]!.code).toBe("read-bound");
    expect(result.reads.performed).toBe(result.reads.limit);
  });

  it("reconstructs a consumed prior-plan edge and carries its allowance without reset", async () => {
    const f = await fixture(false);
    const proposed = await f.build({ successorRunId: "first-successor" });
    expect(proposed.blockers).toEqual([]);
    const record = await new RecoveryPlanManager(f.storage, f.leases).persist({
      lease: { ...f.lease, runId: "first-successor" },
      plan: proposed.plan!,
    });
    const request = f.event({
      kind: "recovery",
      event: "RecoveryRequested",
      sequence: 101,
      requestId: record.plan.requestId,
      repository: "o/r",
      requestedBy: "operator",
      predecessorRunId: "source",
      predecessorTerminalDigest: record.plan.predecessor.terminalDigest,
      successorRunId: "first-successor",
      planDigest: record.digest,
      policyDigest: record.plan.policyDigest,
      baseSha: record.plan.expectedBaseSha,
    });
    if (request.event !== "RecoveryRequested") throw new Error("fixture request");
    f.snapshot.factoryEvents!.push(request);
    const claim = await new RecoveryClaimManager(f.storage, f.leases).claim({
      lease: { ...f.lease, runId: "first-successor" },
      planRecord: record,
      authenticatedRequest: request,
      transaction: {
        at: now.toISOString(),
        startSequence: 102,
        evidenceDigest: digest("a"),
        accountingDigest: digest("b"),
        resourceEvidenceDigest: digest("c"),
      },
    });
    const transaction = recoveryAdoptionEvents({
      planRecord: record,
      claim,
      authenticatedRequest: request,
      predecessorStart: f.start as Extract<FactoryEvent, { event: "FactoryRunStarted" }>,
    });
    const pending = await f.build({ successorRunId: "first-successor" });
    expect(pending.status).toBe("blocked");
    expect(pending.blockers[0]!.code).toBe("candidate-predecessor-claimed");
    f.snapshot.factoryEvents!.push(
      ...transaction,
      f.event({
        kind: "run",
        event: "FactoryRunEscalated",
        runId: "first-successor",
        sequence: 105,
      }),
    );
    const result = await f.build({
      requestId: "second-request",
      successorRunId: "second-successor",
    });
    expect(result.blockers).toEqual([]);
    expect(result.plan!.priorPlanDigest).toBe(record.digest);
    expect(result.plan!.allowance.before).toEqual(record.plan.allowance.after);
    expect(result.plan!.history).toHaveLength(2);
    expect(result.plan!.predecessor.startDigest).toBe(recoveryEventDigest(transaction[0]));
  });
});
