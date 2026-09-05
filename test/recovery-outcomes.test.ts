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
import { resolveRecoveryEvidence } from "../src/recovery/evidence.js";

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
  objective.workItems.push({
    ...structuredClone(objective.workItems[0]!),
    id: "fresh",
    title: "Fresh item",
    scope: ["src/fresh.ts"],
  });
  const graphManager = new CompiledGraphManager(storage, leases);
  const graph = await graphManager.persist({ lease, base, objective });
  const projection = await graphManager.persistProjection({
    lease,
    graph,
    bindings: [
      { compilerId: "work", issueNodeId: "I_8", issueNumber: 8 },
      { compilerId: "fresh", issueNodeId: "I_9", issueNumber: 9 },
    ],
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
      graphSize: 2,
      baseSha: base.oid,
      graphRef: graph.ref,
      graphBlobSha: graph.blobOid,
    }),
    event({
      kind: "graph",
      event: "GraphProjected",
      sequence: 3,
      graphDigest: graph.graphDigest,
      graphSize: 2,
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
          graphSize: 2,
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
  snapshot.workItems.push({
    id: "I_9",
    number: 9,
    title: "Fresh item",
    body: renderWorkPacket(objective.workItems[1]!, {
      protocol: "clockgrove.factory/graph-v1",
      id: "fresh",
      graphDigest: graph.graphDigest,
      graphSize: 2,
      index: 1,
      dependsOn: [],
    }),
    closed: false,
    blockedBy: [],
    linkedPullRequests: [],
    copilotAssignments: [],
    factoryEvents: [],
  });
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
    mergeCommitSha: null as string | null,
    createdAt: now,
  };
  const store = {
    readRef: vi.fn(storage.readRef),
    readCommit: vi.fn(storage.readCommit),
    readBlob: vi.fn(storage.readBlob),
    readTreeEntry: vi.fn(storage.readTreeEntry),
    listRefs: vi.fn(async (): Promise<Array<{ ref: string; oid: string }>> => []),
    readPullRequest: vi.fn(async (_number: number) => pull),
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
  items.push({
    workItem: 9,
    issueNodeId: "I_9",
    compilerId: "fresh",
    action: "execute",
    source: null,
    observedPullRequest: null,
    resources: { state: "not-required", receiptDigest: null, identities: [] },
  });
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

import { recoveryAdoptionEvents } from "../src/recovery/transaction.js";
import {
  createRecoverySourceIntegratedEvent,
  verifyRecoverySourceIntegration,
} from "../src/recovery/outcomes.js";
import { loadRecoveryRuntime } from "../src/recovery/runtime.js";
import {
  MergeCandidateCheckpointStore,
  mergeCandidateIdentityDigest,
} from "../src/control/merge-candidates.js";
import { createValidationEvidence } from "../src/validation/evidence.js";

async function adopted(
  changedBase = false,
  secondSource = false,
  integrated = false,
  included = true,
) {
  const f = await fixture();
  const target = sha("6");
  f.commits.set(target, { ...f.base, oid: target, parentOids: [f.base.oid] });
  const secondPull = {
    ...f.pull,
    number: 10,
    nodeId: "PR_10",
    headSha: sha("4"),
    headRef: publicationBranch(7, 9, 1),
  };
  if (secondSource) {
    const source = structuredClone(f.plan.items[0]!.source!);
    const binding = bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: source.validation!.evidenceDigest,
        baseSha: f.base.oid,
        outputTreeSha: sha("5"),
      },
      publishedHeadSha: secondPull.headSha,
      publishedTreeSha: sha("5"),
      publishedBaseSha: f.base.oid,
    });
    const review = await new ReviewCheckpointManager(f.storage, f.leases).persist({
      lease: f.lease,
      identity: {
        kind: "artifact",
        runId: "source",
        objective: 7,
        workItem: 9,
        attempt: 1,
        artifactDigest: source.artifactDigest!,
        baseSha: f.base.oid,
        outputTreeSha: sha("5"),
        evidenceDigest: source.validation!.evidenceDigest,
      },
      result: {
        review: { accepted: true, summary: "Accepted second source", unmetCriteria: [], risks: [] },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });
    const copied = f.input.events
      .filter((value) => "workItem" in value && value.workItem === 8)
      .map((value) =>
        event({
          ...value,
          workItem: 9,
          sequence: value.sequence + 10,
          ...(value.kind === "validation" ? { outputTreeSha: sha("5") } : {}),
          ...(value.kind === "budget" ? { usageId: `review-${review.identityDigest}` } : {}),
          ...(value.kind === "publication"
            ? {
                itemId: "fresh",
                pullRequest: 10,
                headSha: secondPull.headSha,
                branch: secondPull.headRef,
                exactHeadValidationDigest: binding.digest,
              }
            : {}),
        }),
      );
    const reserved = copied.find((value) => value.event === "AttemptReserved")!;
    const validated = copied.find((value) => value.kind === "validation")!;
    const published = copied.find((value) => value.kind === "publication")!;
    source.reservationRef = attemptRef(7, 9, 1);
    source.reservationCommitOid = sha("3");
    source.reservationReceiptDigest = recoveryEventDigest(reserved);
    source.validation = {
      ...source.validation!,
      receiptDigest: recoveryEventDigest(validated),
      outputTreeSha: sha("5"),
    };
    source.review = {
      ref: review.ref,
      commitOid: review.commitOid,
      blobOid: review.blobOid,
      identityDigest: review.identityDigest,
    };
    source.publication = {
      ...source.publication!,
      receiptDigest: recoveryEventDigest(published),
      pullRequest: 10,
      pullRequestNodeId: "PR_10",
      headSha: secondPull.headSha,
      branch: secondPull.headRef,
    };
    f.refs.set(source.reservationRef, source.reservationCommitOid);
    f.commits.set(source.reservationCommitOid, {
      ...f.base,
      oid: source.reservationCommitOid,
      parentOids: [f.base.oid],
      message: encodeEventTrailer(reserved),
    });
    f.commits.set(secondPull.headSha, {
      ...f.base,
      oid: secondPull.headSha,
      treeOid: sha("5"),
      parentOids: [f.base.oid],
    });
    f.plan.items[1] = {
      ...f.plan.items[1]!,
      action: "reuse-publication",
      source,
      observedPullRequest: {
        ...f.plan.items[0]!.observedPullRequest!,
        number: 10,
        nodeId: "PR_10",
        headSha: secondPull.headSha,
        treeSha: sha("5"),
        headRef: secondPull.headRef,
      },
      resources: { state: "unknown", receiptDigest: null, identities: [] },
    };
    f.input.events.push(...copied);
    f.plan.sourceEventsDigest = recoverySourceEventsDigest({
      objective: 7,
      runIds: ["source"],
      events: f.input.events,
      maxSequence: 30,
    });
    f.input.store.readPullRequest.mockImplementation(async (number: number) =>
      number === 10 ? secondPull : f.pull,
    );
  }
  if (changedBase) {
    f.plan.expectedBaseSha = target;
    f.plan.items[0]!.action = "revalidate";
  }
  if (integrated) {
    f.plan.expectedBaseSha = included ? sha("8") : target;
    f.plan.items[0]!.action = "integrated";
    f.plan.items[0]!.observedPullRequest!.state = "merged";
    f.commits.set(sha("8"), {
      ...f.base,
      oid: sha("8"),
      treeOid: f.plan.items[0]!.source!.validation!.outputTreeSha,
      parentOids: [f.base.oid],
    });
  }
  if (changedBase || secondSource || integrated) {
    f.input.planRecord = await new RecoveryPlanManager(f.storage, f.leases).persist({
      lease: { ...f.lease, runId: "successor" },
      plan: f.plan,
    });
  }
  const request = event({
    kind: "recovery",
    event: "RecoveryRequested",
    sequence: 40,
    requestedBy: "operator",
    requestId: "request",
    repository: "o/r",
    planDigest: f.input.planRecord.digest,
    predecessorRunId: "source",
    predecessorTerminalDigest: f.plan.predecessor.terminalDigest,
    successorRunId: "successor",
    policyDigest: pd,
    baseSha: f.plan.expectedBaseSha,
  });
  if (request.event !== "RecoveryRequested") throw new Error("request fixture");
  f.input.events.push(request);
  const claim = await new RecoveryClaimManager(f.storage, f.leases).claim({
    lease: { ...f.lease, runId: "successor" },
    planRecord: f.input.planRecord,
    authenticatedRequest: request,
    transaction: {
      at: now.toISOString(),
      startSequence: 41,
      evidenceDigest: hex("1"),
      accountingDigest: hex("2"),
      resourceEvidenceDigest: hex("3"),
    },
  });
  const predecessor = f.input.events.find((value) => value.event === "FactoryRunStarted")!;
  if (predecessor.event !== "FactoryRunStarted") throw new Error("start fixture");
  f.input.events.push(
    ...recoveryAdoptionEvents({
      planRecord: f.input.planRecord,
      claim,
      authenticatedRequest: request,
      predecessorStart: predecessor,
    }),
  );
  const source = f.plan.items[0]!.source!;
  const sourceProof = bindValidationToPublishedHead({
    validation: {
      passed: true,
      digest: source.validation!.evidenceDigest,
      baseSha: source.validation!.baseSha,
      outputTreeSha: source.validation!.outputTreeSha,
    },
    publishedHeadSha: source.publication!.headSha,
    publishedTreeSha: source.validation!.outputTreeSha,
    publishedBaseSha: source.publication!.baseSha,
  });
  let candidateDigest: string | undefined;
  const addCandidate = async (targetBaseSha: string) => {
    const validation = createValidationEvidence({
      protocol: "clockgrove.factory/validation-v1",
      artifactDigest: hex("5"),
      baseSha: targetBaseSha,
      outputTreeSha: sha("7"),
      commands: [{ command: "npm test", exitCode: 0, durationMs: 1000 }],
      passed: true,
      startedAt: now.toISOString(),
      completedAt: "2026-09-04T00:00:01.000Z",
    });
    const identity = {
      runId: "successor",
      objective: 7,
      workItem: 8,
      attempt: 1,
      pullRequest: 9,
      sourceHeadSha: source.publication!.headSha,
      sourceExactHeadValidationDigest: sourceProof.digest,
      targetBaseSha,
    };
    const candidate = await new MergeCandidateCheckpointStore(f.storage, f.leases).persist({
      lease: { ...f.lease, runId: "successor" },
      identity,
      source: sourceProof,
      validation,
    });
    candidateDigest = mergeCandidateIdentityDigest(identity);
    const review = await new ReviewCheckpointManager(f.storage, f.leases).persist({
      lease: { ...f.lease, runId: "successor" },
      identity: {
        kind: "integration-candidate",
        runId: "successor",
        objective: 7,
        workItem: 8,
        attempt: 1,
        headSha: source.publication!.headSha,
        artifactDigest: validation.artifactDigest,
        baseSha: targetBaseSha,
        outputTreeSha: validation.outputTreeSha,
        evidenceDigest: validation.digest,
      },
      result: {
        review: { accepted: true, summary: "Accepted candidate", unmetCriteria: [], risks: [] },
        usage: { inputTokens: 4, outputTokens: 1 },
      },
    });
    f.input.events.push(
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence: 90,
        workItem: 8,
        phase: "management",
        unit: "model_tokens",
        amount: 5,
        usageId: `integration-review-${review.identityDigest}`,
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        runId: "successor",
        sequence: 91,
        workItem: 8,
        phase: "validation",
        unit: "validation_milliseconds",
        amount: 1000,
        usageId: `integration-validation-${candidateDigest}`,
      }),
    );
    return { candidate, review };
  };
  const candidate = changedBase ? await addCandidate(target) : null;
  const merged = sha("8");
  f.commits.set(merged, {
    ...f.base,
    oid: merged,
    parentOids: [changedBase ? target : f.base.oid],
    treeOid: changedBase ? sha("7") : source.validation!.outputTreeSha,
  });
  Object.assign(f.pull, { state: "closed", merged: true, mergeCommitSha: merged });
  const outcome = () =>
    createRecoverySourceIntegratedEvent({
      planRecord: f.input.planRecord,
      claim,
      workItem: 8,
      mergeCommitSha: merged,
      ...(candidateDigest ? { mergeCandidateIdentityDigest: candidateDigest } : {}),
      sequence: 100,
      at: now.toISOString(),
    });
  const verify = (value = outcome()) =>
    verifyRecoverySourceIntegration({ ...f.input, claim, outcome: value });
  return {
    ...f,
    claim,
    sourceProof,
    target,
    merged,
    outcome,
    verify,
    addCandidate,
    candidate,
    secondPull,
  };
}

describe("explicit adopted-source integration outcomes", () => {
  it("verifies exact source outcomes with a frozen read capability object", async () => {
    const f = await adopted();
    Object.freeze(f.input.store);
    expect(await f.verify()).toMatchObject({ status: "verified", executionAuthorized: false });
    f.refs.delete(f.input.planRecord.ref);
    expect(await f.verify()).toMatchObject({ status: "blocked" });
  });
  it("requires an already-integrated source merge to remain in the adopted base ancestry", async () => {
    expect(await (await adopted(false, false, true)).verify()).toMatchObject({
      status: "verified",
    });
    expect(await (await adopted(false, false, true, false)).verify()).toMatchObject({
      status: "blocked",
    });
  });
  it("records successor delivery without inventing a successor attempt", async () => {
    const f = await adopted();
    const original = JSON.stringify(f.input.events);
    expect(await f.verify()).toMatchObject({
      status: "verified",
      executionAuthorized: false,
      outcome: { runId: "successor", sourceRunId: "source", sourceAttempt: 1, workItem: 8 },
    });
    expect(JSON.stringify(f.input.events)).toBe(original);
    expect(f.outcome()).not.toHaveProperty("attempt");
    expect(f.outcome()).not.toHaveProperty("event", "AttemptIntegrated");
  });

  it("requires a distinct successor and rejects transplanted source/claim identities", async () => {
    const f = await adopted();
    for (const patch of [
      { sourceRunId: "other" },
      { sourceAttempt: 2 },
      { sourceHeadSha: sha("f") },
      { claimOid: sha("f") },
      { planDigest: hex("f") },
      { sourceReservationCommitOid: sha("f") },
      { sourcePublicationReceiptDigest: hex("f") },
    ]) {
      expect(await f.verify({ ...f.outcome(), ...patch })).toMatchObject({ status: "blocked" });
    }
    expect(() => parseFactoryEvent({ ...f.outcome(), runId: "source" })).toThrow();
  });

  it("requires accepted immutable candidate validation and review on a changed base", async () => {
    const f = await adopted(true);
    expect(await f.verify()).toMatchObject({
      status: "verified",
      targetBaseSha: f.target,
      outputTreeSha: sha("7"),
    });
    expect(
      await f.verify({ ...f.outcome(), mergeCandidateIdentityDigest: hex("f") }),
    ).toMatchObject({ status: "blocked" });
    f.refs.delete(f.candidate!.review.ref);
    expect(await f.verify()).toMatchObject({ status: "blocked" });
  });

  it("rejects an unreconciled candidate review or incorrect actual merge tree", async () => {
    const f = await adopted(true);
    const receipt = f.input.events.findIndex(
      (value) =>
        value.kind === "budget" && value.runId === "successor" && value.unit === "model_tokens",
    );
    const saved = f.input.events.splice(receipt, 1)[0]!;
    expect(await f.verify()).toMatchObject({ status: "blocked" });
    f.input.events.push(saved);
    f.commits.get(f.merged)!.treeOid = f.base.treeOid;
    expect(await f.verify()).toMatchObject({ status: "blocked" });
  });

  it("accepts an exact duplicate receipt but rejects competing outcomes", async () => {
    const f = await adopted();
    f.input.events.push(f.outcome(), f.outcome());
    expect(await f.verify()).toMatchObject({ status: "verified" });
    f.input.events.push({ ...f.outcome(), sequence: 101 });
    expect(await f.verify()).toMatchObject({ status: "blocked" });
  });

  it("rejects late source changes and a PR whose head no longer matches the adopted source", async () => {
    const f = await adopted();
    f.pull.headSha = sha("f");
    expect(await f.verify()).toMatchObject({ status: "blocked" });
    f.pull.headSha = f.sourceProof.publishedHeadSha;
    f.input.events.push(
      event({
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 200,
        phase: "management",
        unit: "model_tokens",
        amount: 1,
        usageId: "late",
      }),
    );
    expect(await f.verify()).toMatchObject({ status: "blocked" });
  });

  it("allows runtime to retain verified source outcomes and count successor review usage", async () => {
    const f = await adopted(true);
    f.input.events.push(f.outcome());
    f.input.snapshot.factoryEvents = f.input.events.filter((value) => !("workItem" in value));
    f.input.snapshot.workItems[0]!.factoryEvents = f.input.events.filter(
      (value) => "workItem" in value && value.workItem === 8,
    );
    f.input.store.listRefs.mockImplementation(async () =>
      [...f.refs]
        .filter(([ref]) => ref.includes("/recovery-claims/"))
        .map(([ref, oid]) => ({ ref, oid })),
    );
    const result = await loadRecoveryRuntime({
      objective: 7,
      runId: "successor",
      store: f.input.store,
      readSnapshot: async () => ({ snapshot: f.input.snapshot, historyComplete: true }),
    });
    expect(result).toMatchObject({
      status: "verified",
      usage: { modelTokens: 20 },
      sourceIntegrations: [{ outcome: { sourceRunId: "source", runId: "successor" } }],
    });
    expect(
      f.input.events.filter((value) => value.kind === "attempt" && value.runId === "successor"),
    ).toHaveLength(0);
  });

  it("requires actual own successor integration ancestry for a later candidate target", async () => {
    const f = await adopted();
    await f.addCandidate(f.target);
    f.commits.get(f.merged)!.parentOids = [f.target];
    f.commits.get(f.merged)!.treeOid = sha("7");
    expect(await f.verify()).toMatchObject({ status: "blocked" });
    const reserved = event({
      kind: "attempt",
      event: "AttemptReserved",
      runId: "successor",
      sequence: 50,
      workItem: 9,
      attempt: 1,
      backend: "codex-sdk/local-worktree",
      baseSha: f.base.oid,
      directorEpoch: 2,
      policyDigest: pd,
    });
    const ref = attemptRef(7, 9, 1);
    f.refs.set(ref, sha("3"));
    f.commits.set(sha("3"), {
      ...f.base,
      oid: sha("3"),
      parentOids: [f.base.oid],
      message: encodeEventTrailer(reserved),
    });
    const head = sha("4");
    f.commits.set(head, { ...f.base, oid: head, parentOids: [f.base.oid], treeOid: sha("5") });
    f.commits.get(f.target)!.treeOid = sha("5");
    const binding = bindValidationToPublishedHead({
      validation: { passed: true, digest: hex("9"), baseSha: f.base.oid, outputTreeSha: sha("5") },
      publishedHeadSha: head,
      publishedTreeSha: sha("5"),
      publishedBaseSha: f.base.oid,
    });
    f.input.events.push(
      reserved,
      event({
        kind: "validation",
        event: "ValidationRecorded",
        runId: "successor",
        sequence: 52,
        workItem: 9,
        attempt: 1,
        passed: true,
        evidenceDigest: hex("9"),
        baseSha: f.base.oid,
        outputTreeSha: sha("5"),
      }),
      event({
        kind: "publication",
        event: "PublicationRecorded",
        runId: "successor",
        sequence: 54,
        workItem: 9,
        attempt: 1,
        unitId: "fresh-unit",
        itemId: "fresh",
        mode: "regular-prs",
        position: 0,
        branch: publicationBranch(7, 9, 1),
        baseBranch: "main",
        baseSha: f.base.oid,
        headSha: head,
        pullRequest: 10,
        capabilityVersion: "2026-03-10",
        validationDigest: hex("9"),
        exactHeadValidationDigest: binding.digest,
      }),
      event({ ...reserved, event: "AttemptPublished", sequence: 55, headSha: head }),
      event({ ...reserved, event: "AttemptIntegrated", sequence: 56, headSha: f.target }),
    );
    f.input.store.readPullRequest.mockImplementation(async (number) =>
      number === 10 ? { ...f.pull, number: 10, headSha: head, mergeCommitSha: f.target } : f.pull,
    );
    expect(await f.verify()).toMatchObject({ status: "verified", targetBaseSha: f.target });
    f.commits.get(f.target)!.treeOid = sha("f");
    expect(await f.verify()).toMatchObject({ status: "blocked" });
  });

  it("verifies a second adopted PR through an earlier exact source-bound outcome", async () => {
    const f = await adopted(false, true);
    await f.addCandidate(f.target);
    f.commits.get(f.target)!.treeOid = sha("5");
    f.commits.get(f.merged)!.parentOids = [f.target];
    f.commits.get(f.merged)!.treeOid = sha("7");
    Object.assign(f.secondPull, { state: "closed", merged: true, mergeCommitSha: f.target });
    const prior = createRecoverySourceIntegratedEvent({
      planRecord: f.input.planRecord,
      claim: f.claim,
      workItem: 9,
      mergeCommitSha: f.target,
      sequence: 80,
      at: now.toISOString(),
    });
    expect(await f.verify()).toMatchObject({ status: "blocked" });
    f.input.events.push(prior);
    expect(await f.verify()).toMatchObject({ status: "verified", targetBaseSha: f.target });
    f.input.events[f.input.events.length - 1] = { ...prior, claimOid: sha("f") };
    expect(await f.verify()).toMatchObject({ status: "blocked" });
  });
});
