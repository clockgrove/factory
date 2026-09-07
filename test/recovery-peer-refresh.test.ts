import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FactoryReadSnapshot } from "../src/application/status.js";
import { attemptRef } from "../src/control/attempts.js";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { MergeCandidateCheckpointStore, mergeCandidateIdentityDigest } from "../src/control/merge-candidates.js";
import { encodeEventTrailer } from "../src/control/receipts.js";
import { ReviewCheckpointManager } from "../src/control/reviews.js";
import { SiblingRefreshStore } from "../src/control/sibling-refreshes.js";
import { renderWorkPacket, type CompiledObjective } from "../src/graph.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../src/protocol/policy.js";
import { publicationBranch } from "../src/publication/publisher.js";
import type { RecoveryReadStore } from "../src/recovery/assessment.js";
import { recoveryEventDigest } from "../src/recovery/identity.js";
import { verifyRecoveryPeerTrunkIntegration } from "../src/recovery/peer-trunk.js";
import { observeRecoverySiblingRefresh } from "../src/recovery/sibling-refresh.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const at = "2026-09-07T00:00:00.000Z";
const accepted = { review: { accepted: true, summary: "Exact criterion accepted", unmetCriteria: [], risks: [] }, usage: { inputTokens: 10, outputTokens: 5 } };

/** Captured regular-PR peer shape; all immutable records use production writers.
 * The map transport simulates GitHub storage, not actor authentication or live qualification. */
async function fixture(sameObjective = false, peerNonhost = false) {
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  let counter = 0;
  const base: GitCommitObject = { oid: sha("base"), treeOid: sha("base-tree"), parentOids: [], message: "base", serverTime: new Date(at) };
  commits.set(base.oid, base);
  const storage: CompiledGraphStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (oid) => { const value = commits.get(oid); if (!value) throw new Error("missing exact commit"); return value; },
    readBlob: async (oid) => { const value = blobs.get(oid); if (!value) throw new Error("missing exact blob"); return value; },
    readTreeEntry: async (oid, path) => trees.get(oid)?.get(path) ?? null,
    createBlob: async (bytes) => { const oid = sha(bytes.toString()); blobs.set(oid, bytes); return oid; },
    createTree: async ({ entries }) => { const oid = sha(`tree-${counter++}`); trees.set(oid, new Map(entries.filter((entry) => entry.sha !== null).map((entry) => [entry.path, entry.sha!]))); return oid; },
    createCommit: async (input) => { const oid = sha(`commit-${counter++}`); commits.set(oid, { ...input, oid, serverTime: new Date(at) }); return oid; },
    createRef: async (ref, oid) => { if (refs.has(ref)) return false; refs.set(ref, oid); return true; },
  };
  const leases = { assertCurrent: async () => {} } as unknown as LeaseManager;
  type Pull = Awaited<ReturnType<RecoveryReadStore["readPullRequest"]>>;
  const pulls = new Map<number, Pull>();
  const snapshots = new Map<number, FactoryReadSnapshot>();

  async function member(objective: number, runId: string, numbers: number[]) {
    const policy = peerNonhost && objective === 17
      ? parseRunPolicy({ ...DEFAULT_RUN_POLICY, backendOrder: ["codex-cli/daytona"], allowedPaidBackends: ["codex-cli/daytona"], cloudFallback: "explicit", maxSandboxMinutes: 30 })
      : DEFAULT_RUN_POLICY;
    let sequence = 1;
    const event = (fields: Record<string, unknown>) => parseFactoryEvent({ protocol: "clockgrove.factory/v2", objective, runId, sequence: sequence++, at, ...fields });
    const lease: LeaseState = { objective, runId, holder: "operator", policyDigest: policyDigest(policy), ref: `lease-${objective}`, oid: sha(`lease-${objective}`), treeOid: base.treeOid, epoch: 1, sequence: 1, expiresAt: new Date("2026-09-07T00:10:00Z") };
    const compiled: CompiledObjective = {
      title: `Objective ${objective}`,
      workItems: numbers.map((number) => ({ id: `item-${number}`, title: `Item ${number}`, goal: "Implement bounded independent change", acceptance: ["Declared check passes"], scope: [`src/${number}.ts`], preconditions: [], outOfScope: [], conventions: [], dependsOn: [], baseSha: base.oid, validationCommands: ["npm test"], requirements: { os: [], architecture: [], tools: [], services: [], networkDestinations: [], permittedSecretNames: [], trust: "trusted_local" }, artifactContract: "clockgrove.factory/artifact-v1" })),
    };
    const manager = new CompiledGraphManager(storage, leases);
    const graph = await manager.persist({ lease, base, objective: compiled, compilation: { invocationId: `compile-${runId}`, inputTokens: 10, outputTokens: 5 } });
    const projection = await manager.persistProjection({ lease, graph, bindings: numbers.map((number) => ({ compilerId: `item-${number}`, issueNumber: number, issueNodeId: `I_${number}` })) });
    const activation = event({ kind: "run", event: "ActivationRequested", runId: `request-${objective}`, requestedBy: "operator", requestId: `activate-${objective}`, repository: "o/r", baseSha: base.oid, policy, policyDigest: lease.policyDigest, controllerProtocolMin: "clockgrove.factory/v2", controllerProtocolMax: "clockgrove.factory/v2" });
    // Application requests have their own run envelope and sequence space.
    const start = event({ kind: "run", event: "FactoryRunStarted", sequence: 1, actor: "operator", objectiveAuthor: "operator", repository: "o/r", fork: false, baseBranch: "main", baseSha: base.oid, policy, policyDigest: lease.policyDigest, activationRequestId: `activate-${objective}` });
    const controller = event({ kind: "controller", event: "ControllerObserved", controllerId: "shared-controller", epoch: 3, controllerPolicyDigest: digest("controller-policy"), expiresAt: "2026-09-07T00:10:00Z", protocolMin: "clockgrove.factory/v2", protocolMax: "clockgrove.factory/v2" });
    const snapshot: FactoryReadSnapshot = {
      id: `I_${objective}`, number: objective, title: compiled.title, repositoryId: "R_1", authorLogin: "operator", defaultBranch: "main", closed: false,
      factoryEvents: [activation, start, controller,
        event({ kind: "delivery", event: "DeliverySelected", requested: "regular-prs", selected: "regular-prs", capabilityVersion: "2026-03-10", reason: "ordinary delivery" }),
        event({ kind: "graph", event: "GraphCompiled", graphDigest: graph.graphDigest, graphSize: numbers.length, baseSha: base.oid, graphRef: graph.ref, graphBlobSha: graph.blobOid }),
        event({ kind: "graph", event: "GraphProjected", graphDigest: graph.graphDigest, graphSize: numbers.length, projectionRef: projection.ref, projectionBlobSha: projection.blobOid }),
        event({ kind: "budget", event: "BudgetReconciled", phase: "management", unit: "model_tokens", amount: 15, usageId: `compile-${graph.graphDigest}` }),
      ],
      workItems: compiled.workItems.map((item, index) => ({ id: `I_${numbers[index]}`, number: numbers[index]!, title: item.title, body: renderWorkPacket(item, { protocol: "clockgrove.factory/graph-v1", id: item.id, graphDigest: graph.graphDigest, graphSize: numbers.length, index, dependsOn: [] }), closed: false, blockedBy: [], linkedPullRequests: [], copilotAssignments: [], factoryEvents: [] })),
    };
    snapshots.set(objective, snapshot);
    return { snapshot, lease, event, start, controller, activation, graph, projection };
  }

  const receiver = await member(7, "receiver-run", sameObjective ? [8, 9] : [9]);
  const peer = sameObjective ? receiver : await member(17, "peer-run", [18]);
  async function publish(owner: typeof receiver, workItem: number, pullNumber: number, integrated: boolean) {
    const { lease, event } = owner;
    const item = owner.snapshot.workItems.find((item) => item.number === workItem)!;
    const tree = sha(`output-${workItem}`);
    const head = sha(`head-${workItem}`);
    const artifactDigest = digest(`artifact-${workItem}`);
    const validation = createValidationEvidence({ protocol: "clockgrove.factory/validation-v1", artifactDigest, baseSha: base.oid, outputTreeSha: tree, commands: [{ command: "npm test", exitCode: 0, durationMs: 10 }], passed: true, startedAt: at, completedAt: "2026-09-07T00:00:00.010Z" });
    const remote = peerNonhost && owner === peer;
    const attempt = (fields: Record<string, unknown>) => event({ kind: "attempt", workItem, attempt: 1, backend: remote ? "codex-cli/daytona" : "codex-sdk/local-worktree", baseSha: base.oid, directorEpoch: lease.epoch, policyDigest: lease.policyDigest, ...fields });
    const reserved = attempt({ event: "AttemptReserved" });
    const reservationRef = attemptRef(lease.objective, workItem, 1);
    const reservationOid = await storage.createCommit({ treeOid: base.treeOid, parentOids: [base.oid], message: encodeEventTrailer(reserved) });
    await storage.createRef(reservationRef, reservationOid);
    const review = await new ReviewCheckpointManager(storage, leases).persist({ lease, identity: { kind: "artifact", runId: lease.runId, objective: lease.objective, workItem, attempt: 1, artifactDigest, baseSha: base.oid, outputTreeSha: tree, evidenceDigest: validation.digest }, result: accepted });
    commits.set(head, { oid: head, treeOid: tree, parentOids: [base.oid], message: `head\nFactory-Artifact: ${artifactDigest}\nFactory-Validation: ${validation.digest}`, serverTime: new Date(at) });
    const exact = bindValidationToPublishedHead({ validation, publishedBaseSha: base.oid, publishedHeadSha: head, publishedTreeSha: tree });
    const started = attempt({ event: "AttemptStarted" });
    const succeeded = attempt({ event: "AttemptSucceeded", artifactDigest, ...(remote ? {} : { reportedModelTokens: 6 }) });
    const validationEvent = event({ kind: "validation", event: "ValidationRecorded", workItem, attempt: 1, baseSha: base.oid, outputTreeSha: tree, evidenceDigest: validation.digest, passed: true });
    const branch = publicationBranch(lease.objective, workItem, 1);
    item.factoryEvents!.push(reserved, started, succeeded, validationEvent,
      ...(remote ? [] : [event({ kind: "budget", event: "BudgetReconciled", workItem, attempt: 1, phase: "execution", unit: "model_tokens", amount: 6 })]),
      event({ kind: "budget", event: "BudgetReconciled", workItem, attempt: 1, phase: "execution", unit: remote ? "sandbox_milliseconds" : "local_milliseconds", amount: 20 }),
      event({ kind: "budget", event: "BudgetReconciled", workItem, attempt: 1, phase: "validation", unit: "validation_milliseconds", amount: 10 }),
      event({ kind: "budget", event: "BudgetReconciled", workItem, attempt: 1, phase: "management", unit: "model_tokens", amount: 15, usageId: `review-${review.identityDigest}` }),
      attempt({ event: "AttemptValidated", artifactDigest }), attempt({ event: "AttemptPublished", artifactDigest, headSha: head }));
    const publication = event({ kind: "publication", event: "PublicationRecorded", workItem, attempt: 1, unitId: `delivery/item-${workItem}`, itemId: `item-${workItem}`, mode: "regular-prs", position: 0, branch, baseBranch: "main", baseSha: base.oid, headSha: head, pullRequest: pullNumber, capabilityVersion: "2026-03-10", validationDigest: validation.digest, exactHeadValidationDigest: exact.digest });
    item.factoryEvents!.push(publication);
    const merge = sha(`merge-${workItem}`);
    if (integrated) {
      commits.set(merge, { oid: merge, treeOid: tree, parentOids: [base.oid], message: "squash", serverTime: new Date(at) });
      item.factoryEvents!.push(attempt({ event: "AttemptIntegrated", headSha: merge }));
      item.closed = true;
    }
    refs.set(`refs/heads/${branch}`, head);
    const pull: Pull = { number: pullNumber, nodeId: `PR_${pullNumber}`, baseRepository: "o/r", headRepository: "o/r", headRef: branch, state: integrated ? "closed" : "open", merged: integrated, mergeable: true, mergeableState: "clean", draft: false, headSha: head, baseSha: base.oid, baseRef: "main", mergeCommitSha: integrated ? merge : null, createdAt: new Date(at) };
    pulls.set(pullNumber, pull);
    item.linkedPullRequests = [{ id: pull.nodeId!, number: pullNumber, headSha: head, state: integrated ? "MERGED" : "OPEN", checks: null, isDraft: false, title: "publication", body: "", changedLines: 1, changedFiles: 1, changedFilePaths: [], commitSubjects: ["publication"], mergeable: "MERGEABLE", createdAt: new Date(at), headCommittedAt: new Date(at), mergedAt: integrated ? new Date(at) : null, closedAt: integrated ? new Date(at) : null, agentWorkEvents: [] }];
    return { item, head, tree, merge, pull, branch, validation, validationEvent, publication, reserved, reservationRef, reservationOid, exact, review };
  }
  const peerPublication = await publish(peer, sameObjective ? 8 : 18, 28, true);
  const original = await publish(receiver, 9, 29, false);
  const source: Parameters<typeof observeRecoverySiblingRefresh>[0]["source"] = {
    runId: receiver.lease.runId, attempt: 1, reservationRef: original.reservationRef, reservationCommitOid: original.reservationOid, reservationReceiptDigest: recoveryEventDigest(original.reserved), artifactDigest: original.validation.artifactDigest, review: null,
    validation: { receiptDigest: recoveryEventDigest(original.validationEvent), evidenceDigest: original.validation.digest, baseSha: base.oid, outputTreeSha: original.tree },
    publication: { receiptDigest: recoveryEventDigest(original.publication), mode: "regular-prs", pullRequest: 29, pullRequestNodeId: "PR_29", branch: original.branch, baseBranch: "main", baseSha: base.oid, headSha: original.head, baseRepository: "o/r", headRepository: "o/r", stackNumber: null },
  };
  const record = await new SiblingRefreshStore(storage, leases).persist({ lease: receiver.lease, identity: { repository: "o/r", runId: receiver.lease.runId, sourceRunId: receiver.lease.runId, controllingPolicyDigest: receiver.lease.policyDigest, objective: 7, workItem: 9, attempt: 1, pullRequest: 29, pullRequestNodeId: "PR_29", branch: original.branch, reservationRef: original.reservationRef, reservationOid: original.reservationOid, leaseEpoch: 1, policyDigest: receiver.lease.policyDigest, sourcePublicationDigest: source.publication!.receiptDigest, sourceHeadSha: original.head, sourceExactHeadValidationDigest: original.exact.digest, targetBaseSha: peerPublication.merge }, source: original.exact, expectedOldHeadSha: original.head, outputTreeSha: sha("combined-tree") });
  const validation = createValidationEvidence({ protocol: "clockgrove.factory/validation-v1", artifactDigest: digest("candidate"), baseSha: peerPublication.merge, outputTreeSha: record.outputTreeSha, commands: [{ command: "npm test", exitCode: 0, durationMs: 10 }], passed: true, startedAt: at, completedAt: "2026-09-07T00:00:00.010Z" });
  const identity = { runId: receiver.lease.runId, objective: 7, workItem: 9, attempt: 1, pullRequest: 29, sourceHeadSha: original.head, sourceExactHeadValidationDigest: original.exact.digest, targetBaseSha: peerPublication.merge, deliveryHeadSha: record.plannedHeadSha };
  const candidate = await new MergeCandidateCheckpointStore(storage, leases).persist({ lease: receiver.lease, identity, source: original.exact, validation });
  const review = await new ReviewCheckpointManager(storage, leases).persist({ lease: receiver.lease, identity: { kind: "integration-candidate", runId: receiver.lease.runId, objective: 7, workItem: 9, attempt: 1, headSha: record.plannedHeadSha, artifactDigest: validation.artifactDigest, baseSha: validation.baseSha, outputTreeSha: validation.outputTreeSha, evidenceDigest: validation.digest }, result: accepted });
  original.item.factoryEvents!.push(
    receiver.event({ kind: "budget", event: "BudgetReconciled", workItem: 9, attempt: 1, phase: "validation", unit: "validation_milliseconds", amount: 10, usageId: `integration-validation-${mergeCandidateIdentityDigest(identity)}` }),
    receiver.event({ kind: "budget", event: "BudgetReconciled", workItem: 9, attempt: 1, phase: "management", unit: "model_tokens", amount: 15, usageId: `integration-review-${review.identityDigest}` }),
  );
  original.pull.headSha = record.plannedHeadSha;
  original.pull.baseSha = peerPublication.merge;
  original.item.linkedPullRequests[0]!.headSha = record.plannedHeadSha;
  refs.set(`refs/heads/${original.branch}`, record.plannedHeadSha);
  const events = () => [...receiver.snapshot.factoryEvents!, ...receiver.snapshot.workItems.flatMap((item) => item.factoryEvents!)];
  const store: RecoveryReadStore = {
    readRef: storage.readRef, readCommit: storage.readCommit, readBlob: storage.readBlob, readTreeEntry: storage.readTreeEntry,
    listRefs: async (prefix) => [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, oid]) => ({ ref, oid })),
    readPullRequest: async (number) => { const pull = pulls.get(number); if (!pull) throw new Error("missing exact pull"); return pull; },
    getRepositoryFacts: async () => ({ fullName: "o/r", fork: false, private: true, defaultBranch: "main", canPush: true }),
    getBranchHead: async () => commits.get(peerPublication.merge)!, readBranchRules: async () => [], readChecks: async () => ({ failed: [], pending: [], observed: [], observedChecks: [] }),
    readCommitObjectiveCandidates: vi.fn(async () => [peer.snapshot.number]),
    readObjectiveSnapshot: vi.fn(async (number) => { const snapshot = snapshots.get(number); if (!snapshot) throw new Error("missing authenticated snapshot"); return snapshot; }),
  };
  const observe = () => observeRecoverySiblingRefresh({ repository: "o/r", objective: 7, workItem: 9, source, events: events(), controllingRunIds: [receiver.lease.runId], store, deliveryHeadSha: record.plannedHeadSha, requireCompletion: true });
  const peerProof = (overrides: Partial<Parameters<typeof verifyRecoveryPeerTrunkIntegration>[0]> = {}) => {
    if (receiver.start.event !== "FactoryRunStarted") throw new Error("fixture start");
    return verifyRecoveryPeerTrunkIntegration({ repository: "o/r", receiverObjective: 7, receiverStart: receiver.start, receiverEvents: events(), targetBaseSha: peerPublication.merge, beforeAt: at, store, ...overrides });
  };
  return { refs, commits, blobs, snapshots, store, receiver, peer, original, peerPublication, source, record, candidate, review, observe, peerProof };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function peerEvent(f: Fixture, name: FactoryEvent["event"]) {
  const event = [...f.peer.snapshot.factoryEvents!, ...f.peer.snapshot.workItems.flatMap((item) => item.factoryEvents!)].find((event) => event.event === name);
  if (!event) throw new Error(`missing fixture ${name}`);
  return event;
}

describe("retained regular publication refreshed onto authenticated peer integration", () => {
  it("replays exact captured cross-Objective refresh without relabelling either original acceptance", async () => {
    const f = await fixture();
    const before = JSON.stringify({ receiver: f.receiver.snapshot, peer: f.peer.snapshot, source: f.source, refs: [...f.refs] });
    await expect(f.peerProof()).resolves.toEqual({ parent: f.original.validation.baseSha, requiresIsolation: false, executionRequiresIsolation: false });
    const proof = await f.observe();
    expect(proof.record).toEqual(f.record);
    expect(proof.source).toEqual(f.original.exact);
    expect(proof.candidate).toEqual(f.candidate);
    expect(proof.review).toEqual(f.review);
    expect(proof.record.identity.sourceRunId).toBe("receiver-run");
    expect(f.peerPublication.reserved.runId).toBe("peer-run");
    expect(f.store.readCommitObjectiveCandidates).toHaveBeenCalledWith(f.peerPublication.merge);
    expect(f.store.readObjectiveSnapshot).toHaveBeenCalledWith(17);
    expect(JSON.stringify({ receiver: f.receiver.snapshot, peer: f.peer.snapshot, source: f.source, refs: [...f.refs] })).toBe(before);
  });

  it("preserves same-Objective sibling refresh compatibility", async () => {
    const f = await fixture(true);
    const proof = await f.observe();
    expect(proof.record).toEqual(f.record);
    expect(proof.candidate).toEqual(f.candidate);
    expect(proof.review).toEqual(f.review);
    expect(f.store.readCommitObjectiveCandidates).not.toHaveBeenCalled();
    expect(f.store.readObjectiveSnapshot).not.toHaveBeenCalled();
  });

  it("preserves a permitted non-host peer's isolation requirement instead of accepting local refreshed validation", async () => {
    const f = await fixture(false, true);
    await expect(f.peerProof()).resolves.toEqual({ parent: f.original.validation.baseSha, requiresIsolation: true, executionRequiresIsolation: false });
    await expect(f.observe()).rejects.toThrow();
    expect(f.peerPublication.item.factoryEvents!.some((event) => event.kind === "budget" && event.phase === "execution" && event.unit === "model_tokens")).toBe(false);
  });

  const invalid: Array<[string, (f: Fixture) => void]> = [
    ["peer actor", (f) => { Object.assign(f.peer.start, { actor: "foreign" }); }],
    ["peer Objective author", (f) => { f.peer.snapshot.authorLogin = "foreign"; }],
    ["repository identity", (f) => { f.peer.snapshot.repositoryId = "R_foreign"; }],
    ["default branch", (f) => { f.peer.snapshot.defaultBranch = "foreign"; }],
    ["controller id", (f) => { Object.assign(f.peer.controller, { controllerId: "other-controller" }); }],
    ["controller epoch", (f) => { Object.assign(f.peer.controller, { epoch: 4 }); }],
    ["controller policy", (f) => { Object.assign(f.peer.controller, { controllerPolicyDigest: digest("other-controller-policy") }); }],
    ["run policy digest", (f) => { Object.assign(f.peer.start, { policyDigest: digest("other-policy") }); }],
    ["activation actor", (f) => { Object.assign(f.peer.activation, { requestedBy: "foreign" }); }],
    ["activation identity", (f) => { Object.assign(f.peer.start, { activationRequestId: "missing-activation" }); }],
    ["activation base", (f) => { Object.assign(f.peer.activation, { baseSha: sha("other-base") }); }],
    ["activation policy", (f) => { Object.assign(f.peer.activation, { policyDigest: digest("other-policy") }); }],
    ["compiled graph receipt", (f) => { Object.assign(peerEvent(f, "GraphCompiled"), { graphDigest: digest("other-graph") }); }],
    ["projection receipt", (f) => { Object.assign(peerEvent(f, "GraphProjected"), { projectionBlobSha: sha("other-projection") }); }],
    ["immutable projection reference", (f) => { f.refs.delete(f.peer.projection.ref); }],
    ["projected issue identity", (f) => { f.peerPublication.item.id = "I_foreign"; }],
    ["projected packet", (f) => { f.peerPublication.item.body += "\nAdditional edit authority"; }],
    ["controller observed after reservation", (f) => { Object.assign(f.peer.controller, { sequence: f.peerPublication.reserved.sequence + 1 }); }],
    ["receiver observed after reservation", (f) => { Object.assign(f.receiver.controller, { sequence: f.original.reserved.sequence + 1 }); }],
    ["peer integration before reservation", (f) => { Object.assign(peerEvent(f, "AttemptIntegrated"), { sequence: f.peerPublication.reserved.sequence }); }],
    ["peer integration after receiver horizon", (f) => { Object.assign(peerEvent(f, "AttemptIntegrated"), { at: "2026-09-07T00:00:01.000Z" }); }],
    ["original head parent", (f) => { f.commits.get(f.peerPublication.head)!.parentOids = [sha("foreign-base")]; }],
    ["original head tree", (f) => { f.commits.get(f.peerPublication.head)!.treeOid = sha("foreign-tree"); }],
    ["actual PR head", (f) => { f.peerPublication.pull.headSha = sha("unknown-head"); }],
    ["actual PR repository", (f) => { f.peerPublication.pull.headRepository = "foreign/repository"; }],
    ["actual PR branch", (f) => { f.peerPublication.pull.headRef = "provider-owned"; }],
    ["actual PR merge target", (f) => { f.peerPublication.pull.mergeCommitSha = sha("other-merge"); }],
    ["unmerged PR", (f) => { f.peerPublication.pull.merged = false; }],
    ["squash parent", (f) => { f.commits.get(f.peerPublication.merge)!.parentOids = [sha("foreign-base")]; }],
    ["two-parent merge instead of squash", (f) => { f.commits.get(f.peerPublication.merge)!.parentOids.push(sha("second-parent")); }],
    ["squash tree", (f) => { f.commits.get(f.peerPublication.merge)!.treeOid = sha("foreign-tree"); }],
    ["failed independent validation", (f) => { Object.assign(f.peerPublication.validationEvent, { passed: false }); }],
    ["validation evidence identity", (f) => { Object.assign(f.peerPublication.validationEvent, { evidenceDigest: digest("other-validation") }); }],
    ["missing original semantic acceptance", (f) => { f.refs.delete(f.peerPublication.review.ref); }],
    ["conflicting known review usage", (f) => { const usage = f.peerPublication.item.factoryEvents!.find((event) => event.kind === "budget" && event.phase === "management")!; Object.assign(usage, { amount: 14 }); }],
    ["missing original reservation", (f) => { f.refs.delete(f.peerPublication.reservationRef); }],
    ["reservation immutable parent", (f) => { f.commits.get(f.peerPublication.reservationOid)!.parentOids = [sha("foreign-base")]; }],
  ];
  it.each(invalid)("refuses %s provenance rather than trusting an exact-commit discovery hint", async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    await expect(f.peerProof()).rejects.toThrow();
    await expect(f.observe()).rejects.toThrow();
  });

  it("refuses absent peer ports while retaining same-Objective-only compatibility", async () => {
    const f = await fixture();
    delete f.store.readCommitObjectiveCandidates;
    delete f.store.readObjectiveSnapshot;
    await expect(f.observe()).rejects.toThrow();
    const same = await fixture(true);
    delete same.store.readCommitObjectiveCandidates;
    delete same.store.readObjectiveSnapshot;
    await expect(same.observe()).resolves.toMatchObject({ record: same.record });
  });

  it("refuses an undiscovered target and does not scan arbitrary Objectives", async () => {
    const f = await fixture();
    vi.mocked(f.store.readCommitObjectiveCandidates!).mockResolvedValue([]);
    await expect(f.peerProof()).rejects.toThrow();
    expect(f.store.readObjectiveSnapshot).not.toHaveBeenCalledWith(17);
  });

  it("refuses more than 100 discovery candidates before reading their histories", async () => {
    const f = await fixture();
    vi.mocked(f.store.readCommitObjectiveCandidates!).mockResolvedValue(Array.from({ length: 101 }, (_, index) => 1000 + index));
    await expect(f.peerProof()).rejects.toThrow();
    expect(vi.mocked(f.store.readObjectiveSnapshot!).mock.calls.every(([number]) => number === 7)).toBe(true);
  });

  it("refuses a receiver horizon without an authenticated original event", async () => {
    const f = await fixture();
    await expect(f.peerProof({ beforeAt: "2026-09-07T01:00:00Z" })).rejects.toThrow();
  });

  it("refuses cyclic or exhausted recursive proof traversal", async () => {
    const f = await fixture();
    await expect(f.peerProof({ proofTraversal: new Set([`peer:7:receiver-run:${f.peerPublication.merge}`]) })).rejects.toThrow();
    await expect(f.peerProof({ proofTraversal: new Set(Array.from({ length: 100 }, (_, index) => `visited-${index}`)) })).rejects.toThrow();
  });

  it.each(["prior-head", "target-base", "combined-tree"] as const)("refuses altered refreshed %s despite authentic peer ancestry", async (field) => {
    const f = await fixture();
    const head = f.commits.get(f.record.plannedHeadSha)!;
    if (field === "combined-tree") head.treeOid = sha("foreign-refreshed-tree");
    else head.parentOids[field === "prior-head" ? 0 : 1] = sha("foreign-refreshed-parent");
    await expect(f.peerProof()).resolves.toMatchObject({ parent: f.original.validation.baseSha });
    await expect(f.observe()).rejects.toThrow();
  });

  it("requires the distinct refreshed-head review, not the accepted original worker review", async () => {
    const f = await fixture();
    f.refs.delete(f.review.ref);
    expect(f.refs.has(f.original.review.ref)).toBe(true);
    await expect(f.peerProof()).resolves.toMatchObject({ parent: f.original.validation.baseSha });
    await expect(f.observe()).rejects.toThrow();
  });

  it.each([false, true])("uses the exact candidate capacity admission horizon, not a later terminal receipt (late peer: %s)", async (latePeer) => {
    const f = await fixture();
    const sequence = f.original.publication.sequence + 1;
    for (const event of f.original.item.factoryEvents!) {
      if (event.sequence >= sequence) event.sequence++;
    }
    f.original.item.factoryEvents!.push(parseFactoryEvent({
      protocol: "clockgrove.factory/v2", kind: "capacity", event: "CapacityReserved",
      objective: 7, runId: "receiver-run", sequence, at,
      workItem: 9, attempt: 1, phase: "validation",
      backend: `factory/integration-validation-${mergeCandidateIdentityDigest(f.candidate.identity)}`,
      requestedCpu: 1, requestedMemoryMb: 2048, directorEpoch: 1,
      policyDigest: f.receiver.lease.policyDigest,
    }));
    f.receiver.snapshot.factoryEvents!.push(parseFactoryEvent({
      protocol: "clockgrove.factory/v2", kind: "run", event: "FactoryRunEscalated",
      objective: 7, runId: "receiver-run", sequence: 1000,
      at: "2026-09-07T00:00:02.000Z", reason: "retained work requires explicit recovery",
    }));
    if (latePeer) {
      Object.assign(peerEvent(f, "AttemptIntegrated"), { at: "2026-09-07T00:00:01.000Z" });
      await expect(f.observe()).rejects.toThrow();
    } else await expect(f.observe()).resolves.toMatchObject({ record: f.record });
  });
});
