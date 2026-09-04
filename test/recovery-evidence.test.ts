import { describe, expect, it, vi } from "vitest";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { encodeEventTrailer } from "../src/control/receipts.js";
import { attemptRef } from "../src/control/attempts.js";
import { ReviewCheckpointManager } from "../src/control/reviews.js";
import { renderWorkPacket, type CompiledObjective } from "../src/graph.js";
import type { FactoryReadSnapshot } from "../src/application/status.js";
import { type FactoryEvent, parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { publicationBranch } from "../src/publication/publisher.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import type { RecoveryReadStore } from "../src/recovery/assessment.js";
import { RecoveryClaimManager } from "../src/recovery/claims.js";
import { recoveryEventDigest, recoverySourceEventsDigest } from "../src/recovery/identity.js";
import {
  RecoveryPlanManager,
  RECOVERY_PLAN_PROTOCOL,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  type RecoveryPlan,
} from "../src/recovery/plan.js";
import { recoveryEvidenceDigest, resolveRecoveryEvidence } from "../src/recovery/evidence.js";

const sha = (letter: string) => letter.repeat(40);
const hex = (letter: string) => letter.repeat(64);
const now = new Date("2026-09-04T00:00:00Z");
const policy = DEFAULT_RUN_POLICY;
const pd = policyDigest(policy);
const event = (fields: Record<string, unknown>) =>
  parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "source",
    sequence: 1,
    at: now.toISOString(),
    ...fields,
  });

async function fixture(rebase = false) {
  let next = 1;
  const oid = () => (next++).toString(16).padStart(40, "0");
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
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
      if (!value) throw new Error("private missing commit");
      return value;
    },
    readBlob: async (id) => {
      const value = blobs.get(id);
      if (!value) throw new Error("private missing blob");
      return value;
    },
    readTreeEntry: async (tree, path) => trees.get(tree)?.get(path) ?? null,
    createBlob: async (bytes) => {
      const id = oid();
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
    policyDigest: pd,
    ref: "lease",
    oid: sha("f"),
    treeOid: base.treeOid,
    epoch: 1,
    sequence: 1,
    expiresAt: now,
  };
  const leases = { assertCurrent: async () => {} } as unknown as LeaseManager;
  const objective: CompiledObjective = {
    title: "Private objective",
    workItems: [
      {
        id: "work",
        title: "Private item",
        goal: "Private goal",
        acceptance: ["Pass"],
        scope: ["src/item.ts"],
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
  const graphManager = new CompiledGraphManager(storage, leases);
  const graph = await graphManager.persist({ lease, base, objective });
  const projection = await graphManager.persistProjection({
    lease,
    graph,
    bindings: [{ compilerId: "work", issueNodeId: "I_8", issueNumber: 8 }],
  });
  const artifactDigest = hex("e");
  const validationDigest = hex("f");
  const headSha = sha("c");
  commits.set(headSha, {
    oid: headSha,
    treeOid: sha("e"),
    parentOids: [base.oid],
    message: `Factory-Artifact: ${artifactDigest}\nFactory-Validation: ${validationDigest}`,
    serverTime: now,
  });
  const review = await new ReviewCheckpointManager(storage, leases).persist({
    lease,
    identity: {
      kind: rebase ? "rebase" : "artifact",
      runId: "source",
      objective: 7,
      workItem: 8,
      attempt: 1,
      artifactDigest,
      baseSha: base.oid,
      outputTreeSha: sha("e"),
      evidenceDigest: validationDigest,
      ...(rebase ? { headSha } : {}),
    },
    result: {
      review: { accepted: true, summary: "Private review", unmetCriteria: [], risks: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  });
  const attempt = (fields: Record<string, unknown>) =>
    event({
      kind: "attempt",
      workItem: 8,
      attempt: 1,
      backend: "codex-sdk/local-worktree",
      baseSha: base.oid,
      directorEpoch: 1,
      policyDigest: pd,
      ...fields,
    });
  const reserved = attempt({ event: "AttemptReserved", sequence: 4 });
  const reservationRef = attemptRef(7, 8, 1);
  const reservationOid = sha("d");
  refs.set(reservationRef, reservationOid);
  commits.set(reservationOid, {
    oid: reservationOid,
    treeOid: base.treeOid,
    parentOids: [base.oid],
    message: encodeEventTrailer(reserved),
    serverTime: now,
  });
  const validated = event({
    kind: "validation",
    event: "ValidationRecorded",
    sequence: 7,
    workItem: 8,
    attempt: 1,
    baseSha: base.oid,
    outputTreeSha: sha("e"),
    evidenceDigest: validationDigest,
    passed: true,
  });
  const binding = bindValidationToPublishedHead({
    validation: {
      passed: true,
      digest: validationDigest,
      baseSha: base.oid,
      outputTreeSha: sha("e"),
    },
    publishedHeadSha: headSha,
    publishedTreeSha: sha("e"),
    publishedBaseSha: base.oid,
  });
  const branch = publicationBranch(7, 8, 1);
  const published = event({
    kind: "publication",
    event: "PublicationRecorded",
    sequence: 10,
    workItem: 8,
    attempt: 1,
    unitId: "unit",
    itemId: "work",
    mode: "regular-prs",
    position: 0,
    branch,
    baseBranch: "main",
    baseSha: base.oid,
    headSha,
    pullRequest: 9,
    capabilityVersion: "2026-03-10",
    validationDigest,
    exactHeadValidationDigest: binding.digest,
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
    policy,
    policyDigest: pd,
  });
  const terminal = event({ kind: "run", event: "FactoryRunEscalated", sequence: 30 });
  const events: FactoryEvent[] = [
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
    reserved,
    attempt({ event: "AttemptCollected", sequence: 6, artifactDigest }),
    validated,
    event({
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 8,
      workItem: 8,
      attempt: 1,
      phase: "management",
      unit: "model_tokens",
      amount: 15,
      usageId: `${rebase ? "rebase-review" : "review"}-${review.identityDigest}`,
    }),
    ...(!rebase ? [attempt({ event: "AttemptValidated", sequence: 9, artifactDigest })] : []),
    published,
    terminal,
  ];
  const snapshot: FactoryReadSnapshot = {
    id: "I_7",
    number: 7,
    title: objective.title,
    repositoryId: "R_1",
    authorLogin: "operator",
    defaultBranch: "main",
    closed: false,
    factoryEvents: events.filter((item) => !("workItem" in item)),
    workItems: [
      {
        id: "I_8",
        number: 8,
        title: objective.workItems[0]!.title,
        body: renderWorkPacket(objective.workItems[0]!, {
          protocol: "clockgrove.factory/graph-v1",
          id: "work",
          graphDigest: graph.graphDigest,
          graphSize: 1,
          index: 0,
          dependsOn: [],
        }),
        closed: false,
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: events.filter((item) => "workItem" in item),
      },
    ],
  };
  const pull = {
    number: 9,
    nodeId: "PR_9",
    baseRepository: "o/r",
    headRepository: "o/r",
    headRef: branch,
    state: "open",
    merged: false,
    mergeable: true,
    mergeableState: "clean",
    draft: false,
    headSha,
    baseSha: base.oid,
    baseRef: "main",
    mergeCommitSha: null,
    createdAt: now,
  };
  const store = {
    readRef: vi.fn(storage.readRef),
    readCommit: vi.fn(storage.readCommit),
    readBlob: vi.fn(storage.readBlob),
    readTreeEntry: vi.fn(storage.readTreeEntry),
    listRefs: vi.fn(async () => []),
    readPullRequest: vi.fn(async () => pull),
    getRepositoryFacts: vi.fn(async () => ({
      fullName: "o/r",
      fork: false,
      private: true,
      defaultBranch: "main",
      canPush: true,
    })),
    getBranchHead: vi.fn(async () => base),
    readBranchRules: vi.fn(async () => []),
    readChecks: vi.fn(async () => ({ pending: [], failed: [], observed: [], observedChecks: [] })),
  } satisfies RecoveryReadStore;
  const history = [
    {
      runId: "source",
      startDigest: recoveryEventDigest(start),
      terminalDigest: recoveryEventDigest(terminal),
      terminalEvent: "FactoryRunEscalated" as const,
      terminalSequence: 30,
      policyDigest: pd,
    },
  ];
  const items: RecoveryPlan["items"] = [
    {
      workItem: 8,
      issueNodeId: "I_8",
      compilerId: "work",
      action: "reuse-publication",
      source: {
        runId: "source",
        attempt: 1,
        reservationRef,
        reservationCommitOid: reservationOid,
        reservationReceiptDigest: recoveryEventDigest(reserved),
        artifactDigest,
        validation: {
          receiptDigest: recoveryEventDigest(validated),
          evidenceDigest: validationDigest,
          baseSha: base.oid,
          outputTreeSha: sha("e"),
        },
        review: {
          ref: review.ref,
          commitOid: review.commitOid,
          blobOid: review.blobOid,
          identityDigest: review.identityDigest,
        },
        publication: {
          receiptDigest: recoveryEventDigest(published),
          mode: "regular-prs",
          pullRequest: 9,
          pullRequestNodeId: "PR_9",
          branch,
          baseBranch: "main",
          baseSha: base.oid,
          headSha,
          baseRepository: "o/r",
          headRepository: "o/r",
          stackNumber: null,
        },
      },
      observedPullRequest: {
        number: 9,
        nodeId: "PR_9",
        headSha,
        baseSha: base.oid,
        treeSha: sha("e"),
        headRef: branch,
        baseRef: "main",
        headRepository: "o/r",
        baseRepository: "o/r",
        state: "open",
      },
      resources: { state: "unknown", receiptDigest: null, identities: [] },
    },
  ];
  const allowance = {
    modelTokens: null,
    sandboxMinutes: 0,
    managedSessions: 0,
    implementationAttemptsPerItem: 3,
  };
  const plan: RecoveryPlan = {
    protocol: RECOVERY_PLAN_PROTOCOL,
    repository: "o/r",
    repositoryId: "R_1",
    objective: 7,
    objectiveNodeId: "I_7",
    requestId: "request",
    successorRunId: "successor",
    predecessor: {
      runId: "source",
      startDigest: history[0]!.startDigest,
      terminalDigest: history[0]!.terminalDigest,
      terminalEvent: "FactoryRunEscalated",
      terminalSequence: 30,
    },
    history,
    historyDigest: recoveryHistoryDigest(history),
    sourceEventsDigest: recoverySourceEventsDigest({
      objective: 7,
      runIds: ["source"],
      events,
      maxSequence: 30,
    }),
    sourceEventMaxSequence: 30,
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
    policyDigest: pd,
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
  const planRecord = await new RecoveryPlanManager(storage, leases).persist({
    lease: { ...lease, runId: "successor" },
    plan,
  });
  const input = { planRecord, events, claim: null, store, snapshot };
  return {
    input,
    storage,
    leases,
    lease,
    refs,
    commits,
    blobs,
    base,
    graph,
    projection,
    review,
    plan,
    pull,
    resolve: () => resolveRecoveryEvidence(input),
  };
}

describe("shared immutable recovery source evidence", () => {
  it("keeps controlling and original source identities separate without admission", async () => {
    const f = await fixture();
    const before = structuredClone(f.input.events);
    const result = await f.resolve();
    expect(result.sourceBindings).toBe("verified");
    expect(result.controllingRunId).toBe("successor");
    expect(result.items[0]?.sourceAttempt?.runId).toBe("source");
    expect(result.items[0]?.reservation?.receipt.runId).toBe("source");
    expect(result.items[0]?.publication?.receipt.runId).toBe("source");
    expect(result.items[0]?.current.head).toBe("unchanged");
    expect(result.items[0]?.current.resources).toBe("unavailable");
    expect(result.adoptionVerified).toBe(false);
    expect(result.executionAuthorized).toBe(false);
    expect(f.input.events).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("Private");
    expect(f.input.store.readCommit.mock.calls.map(([oid]) => oid).length).toBe(
      new Set(f.input.store.readCommit.mock.calls.map(([oid]) => oid)).size,
    );
  });
  it.each([
    "plan-ref",
    "projection",
    "issue-node",
    "missing-issue",
    "scope",
    "source-receipt",
    "reservation",
    "review",
  ])("fails closed for changed %s binding", async (kind) => {
    const f = await fixture();
    if (kind === "plan-ref") f.refs.delete(f.input.planRecord.ref);
    if (kind === "projection") f.refs.delete(f.projection.ref);
    if (kind === "issue-node") f.input.snapshot.workItems[0]!.id = "replacement";
    if (kind === "missing-issue") f.input.snapshot.workItems = [];
    if (kind === "scope") f.input.snapshot.workItems[0]!.body += "\nChanged scope";
    if (kind === "source-receipt")
      f.input.events = f.input.events.filter((item) => item.event !== "ValidationRecorded");
    if (kind === "reservation") f.refs.delete(f.plan.items[0]!.source!.reservationRef);
    if (kind === "review") f.refs.delete(f.review.ref);
    expect((await f.resolve()).sourceBindings).toBe("incomplete");
  });
  it("binds exact rebase review without requiring a duplicate artifact-acceptance event", async () => {
    const f = await fixture(true);
    expect((await f.resolve()).sourceBindings).toBe("verified");
    f.refs.delete(f.review.ref);
    expect((await f.resolve()).sourceBindings).toBe("incomplete");
  });
  it("binds late source charges into the evidence digest and blocks stale history", async () => {
    const f = await fixture();
    const before = await f.resolve();
    f.input.events.push(
      event({
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 31,
        workItem: 8,
        attempt: 1,
        phase: "execution",
        unit: "local_milliseconds",
        amount: 1,
        usageId: "late-source-charge",
      }),
    );
    const after = await f.resolve();
    expect(after.sourceBindings).toBe("verified");
    expect(after.blockers).toContainEqual({ code: "source-history-changed" });
    expect(after.currentSourceEventsDigest).not.toBe(before.currentSourceEventsDigest);
    expect(recoveryEvidenceDigest(after)).not.toBe(recoveryEvidenceDigest(before));
    expect(after.executionAuthorized).toBe(false);
  });
  it("reports changed and unavailable current evidence separately from historical identity", async () => {
    const f = await fixture();
    f.input.store.getBranchHead.mockResolvedValue({ ...f.base, oid: sha("f") });
    f.commits.set(sha("f"), { ...f.base, oid: sha("f") });
    f.pull.headSha = sha("f");
    const changed = await f.resolve();
    expect(changed.sourceBindings).toBe("verified");
    expect(changed.currentBase).toBe("changed");
    expect(changed.items[0]?.current.head).toBe("changed");
    expect(changed.items[0]?.current.publication?.headSha).toBe(sha("f"));
    f.input.store.readPullRequest.mockRejectedValue(new Error("SECRET_PRIVATE_PROVIDER"));
    const absent = await f.resolve();
    expect(absent.items[0]?.current.head).toBe("unavailable");
    expect(JSON.stringify(absent)).not.toContain("SECRET_PRIVATE_PROVIDER");
  });
  it("detects a changed current commit tree even when the head string matches", async () => {
    const f = await fixture();
    f.plan.items[0]!.action = "revalidate";
    f.plan.items[0]!.observedPullRequest!.treeSha = sha("f");
    f.input.planRecord = await new RecoveryPlanManager(f.storage, f.leases).persist({
      lease: { ...f.lease, runId: "successor" },
      plan: f.plan,
    });
    expect((await f.resolve()).items[0]?.current.head).toBe("changed");
  });
  it("separates bounded successor effects instead of copying source attempts", async () => {
    const f = await fixture();
    const originalStart = f.input.events.find((item) => item.event === "FactoryRunStarted")!;
    f.input.events.push(
      event({
        ...originalStart,
        runId: "successor",
        sequence: 40,
        recoveryRequestId: "request",
        recoveryPlanDigest: f.input.planRecord.digest,
        predecessorRunId: "source",
      }),
    );
    for (let index = 0; index < 110; index++)
      f.input.events.push(
        event({
          kind: "budget",
          event: "BudgetReconciled",
          runId: "successor",
          sequence: 41 + index,
          workItem: 8,
          attempt: 2,
          phase: "execution",
          unit: "local_milliseconds",
          amount: 1,
          usageId: `successor-${index}`,
        }),
      );
    const result = await f.resolve();
    expect(result.items[0]?.sourceAttempt?.attempt).toBe(1);
    expect(result.items[0]?.successorEffectCount).toBe(110);
    expect(result.items[0]?.successorEffects).toHaveLength(100);
    expect(result.items[0]?.successorEffectsTruncated).toBe(true);
    expect(result.items[0]?.successorEffects.every((item) => item.runId === "successor")).toBe(
      true,
    );
  });
  it("keeps pre/post-claim evidence digest stable but never treats claim as adoption", async () => {
    const f = await fixture();
    const initial = await f.resolve();
    const request = event({
      kind: "recovery",
      event: "RecoveryRequested",
      runId: "source",
      sequence: 31,
      requestedBy: "operator",
      requestId: "request",
      repository: "o/r",
      planDigest: f.input.planRecord.digest,
      predecessorRunId: "source",
      predecessorTerminalDigest: f.plan.predecessor.terminalDigest,
      successorRunId: "successor",
      policyDigest: pd,
      baseSha: f.base.oid,
    });
    if (request.event !== "RecoveryRequested") throw new Error("fixture request");
    const claim = await new RecoveryClaimManager(f.storage, f.leases).claim({
      lease: { ...f.lease, runId: "successor" },
      planRecord: f.input.planRecord,
      authenticatedRequest: request,
      transaction: {
        at: now.toISOString(),
        startSequence: 33,
        evidenceDigest: recoveryEvidenceDigest(initial),
        accountingDigest: hex("a"),
        resourceEvidenceDigest: hex("b"),
      },
    });
    f.input.events.push(request);
    const claimed = await resolveRecoveryEvidence({ ...f.input, claim });
    expect(claimed.claimBinding).toBe("verified");
    expect(recoveryEvidenceDigest(claimed)).toBe(recoveryEvidenceDigest(initial));
    expect(claimed.adoptionVerified).toBe(false);
    expect(recoveryEvidenceDigest({ ...claimed, currentBaseSha: sha("f") })).not.toBe(
      recoveryEvidenceDigest(initial),
    );
  });
});
