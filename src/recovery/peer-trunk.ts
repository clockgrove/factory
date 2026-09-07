import type { FactoryReadSnapshot } from "../application/status.js";
import { attemptRef } from "../control/attempts.js";
import { activationCancellation } from "../control/activations.js";
import { loadCompiledGraph, loadCompiledGraphProjection } from "../control/graphs.js";
import { assertAuthenticatedGraphProjection, assertSnapshotMatchesCompiledGraph } from "../control/graph-evidence.js";
import { decodeEventTrailer, deduplicateFactoryEvents } from "../control/receipts.js";
import { loadReviewCheckpoint } from "../control/reviews.js";
import { loadMergeCandidateCheckpoint, mergeCandidateIdentityDigest } from "../control/merge-candidates.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { parseRunPolicy, policyDigest, isManagedAgentBackendId, assertRequirementsWithinPolicy } from "../protocol/policy.js";
import { selectEquivalentPublicationRecord } from "../publication/recorded-publication.js";
import { publicationBranch } from "../publication/publisher.js";
import { bindValidationToPublishedHead } from "../validation/plan.js";
import type { RecoveryReadStore } from "./assessment.js";
import { recoveryEventDigest } from "./identity.js";
import { loadRecoveryRuntime } from "./runtime.js";
import { observeRecoverySiblingRefresh } from "./sibling-refresh.js";
import { assertIsolatedCandidateProof } from "./isolated-candidate.js";
import { loadRecoveryPlan } from "./plan.js";
import { loadRecoveryClaim } from "./claims.js";
import { recoveryAdoptionEvents } from "./transaction.js";

type Start = Extract<FactoryEvent, { event: "FactoryRunStarted" }>;
const terminal = new Set(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);
const localBackends = new Set(["codex-sdk/local-worktree", "codex-cli/local-worktree", "codex-app-server/local-worktree"]);
function requirePeer(value: unknown): asserts value {
  if (!value) throw new Error("authenticated peer integration proof unavailable");
}
function one<T>(values: T[]): T {
  requirePeer(values.length === 1);
  return values[0]!;
}
const time = (event: FactoryEvent) => {
  const at = Date.parse(event.at);
  requirePeer(Number.isFinite(at));
  return at;
};
function snapshotEvents(snapshot: FactoryReadSnapshot): FactoryEvent[] {
  requirePeer(snapshot.id && snapshot.repositoryId && snapshot.authorLogin &&
    Array.isArray(snapshot.factoryEvents) && snapshot.workItems.length <= 100 &&
    snapshot.workItems.every((item) => Array.isArray(item.factoryEvents)));
  const raw = [...snapshot.factoryEvents, ...snapshot.workItems.flatMap((item) => item.factoryEvents!)];
  requirePeer(raw.length <= 10000 && Buffer.byteLength(JSON.stringify(raw)) <= 16 * 1024 * 1024);
  const events = deduplicateFactoryEvents(raw.map(parseFactoryEvent));
  requirePeer(events.every((event) => event.objective === snapshot.number));
  requirePeer(new Set(events.map((event) => `${event.runId}:${event.sequence}`)).size === events.length);
  return events;
}
function generation(event: Extract<FactoryEvent, { kind: "controller" }>): string {
  return `${event.controllerId}:${event.epoch}:${event.controllerPolicyDigest}`;
}
function assertActivation(start: Start, events: readonly FactoryEvent[], repository: string): void {
  requirePeer(start.activationRequestId && !start.recoveryRequestId && !start.recoveryPlanDigest);
  const activation = one(events.filter((event) => event.event === "ActivationRequested" &&
    event.requestId === start.activationRequestId));
  requirePeer(activation.event === "ActivationRequested" &&
    activation.objective === start.objective &&
    activation.requestedBy.toLowerCase() === start.actor.toLowerCase() &&
    activation.repository.toLowerCase() === repository.toLowerCase() &&
    activation.baseSha === start.baseSha && activation.policyDigest === start.policyDigest &&
    policyDigest(activation.policy) === start.policyDigest &&
    time(activation) <= time(start));
  const withdrawn = activationCancellation(events, { objective: start.objective,
    requestId: start.activationRequestId, requestedBy: start.actor, repository,
    baseSha: start.baseSha!, policyDigest: start.policyDigest });
  requirePeer(!withdrawn || time(withdrawn) >= time(start));
}

async function assertAdoption(start: Start, events: FactoryEvent[], store: RecoveryReadStore): Promise<void> {
  requirePeer(start.recoveryPlanDigest);
  const planRecord = await loadRecoveryPlan(store, start.objective, start.recoveryPlanDigest);
  requirePeer(planRecord && planRecord.plan.successorRunId === start.runId);
  const claim = await loadRecoveryClaim(store, start.objective, planRecord.plan.predecessor.runId);
  const request = one(events.filter((event) => event.event === "RecoveryRequested" && event.requestId === planRecord.plan.requestId));
  const predecessor = one(events.filter((event) => event.event === "FactoryRunStarted" && event.runId === planRecord.plan.predecessor.runId));
  requirePeer(claim && request.event === "RecoveryRequested" && predecessor.event === "FactoryRunStarted");
  const expected = recoveryAdoptionEvents({ planRecord, claim, authenticatedRequest: request, predecessorStart: predecessor });
  requirePeer(expected.every((expected) => events.some((event) => recoveryEventDigest(event) === recoveryEventDigest(expected))));
}

/** Exact commit hints discover proof candidates only. This read-only result neither adopts
 * another Objective nor authorizes host execution, provider spend or a new validation. */
export async function verifyRecoveryPeerTrunkIntegration(input: {
  repository: string;
  receiverObjective: number;
  receiverStart: Start;
  receiverEvents: readonly FactoryEvent[];
  targetBaseSha: string;
  /** Authenticated receiver receipt horizon; never a Git author timestamp or current clock. */
  beforeAt: string;
  store: RecoveryReadStore;
  proofTraversal?: ReadonlySet<string>;
}): Promise<{ parent: string; requiresIsolation: boolean; executionRequiresIsolation: boolean }> {
  const key = `peer:${input.receiverObjective}:${input.receiverStart.runId}:${input.targetBaseSha}`;
  requirePeer(!input.proofTraversal?.has(key) && (input.proofTraversal?.size ?? 0) < 100);
  const visiting = new Set(input.proofTraversal).add(key);
  let reads = 0;
  const store = new Proxy({} as RecoveryReadStore, {
    get(_target, property) {
      const operation = Reflect.get(input.store, property, input.store);
      if (typeof operation !== "function") return operation;
      return (...args: unknown[]) => {
        requirePeer(++reads <= 1024);
        return Reflect.apply(operation, input.store, args);
      };
    },
  });
  requirePeer(store.readCommitObjectiveCandidates && store.readObjectiveSnapshot);
  const receiver = await store.readObjectiveSnapshot(input.receiverObjective);
  const receiverEvents = snapshotEvents(receiver);
  const receiverDigests = new Set(receiverEvents.map(recoveryEventDigest));
  const receiverStart = one(receiverEvents.filter((event) => event.event === "FactoryRunStarted" &&
    event.runId === input.receiverStart.runId));
  requirePeer(receiverStart.event === "FactoryRunStarted" &&
    recoveryEventDigest(receiverStart) === recoveryEventDigest(input.receiverStart) &&
    input.receiverEvents.length <= 10000 && input.receiverEvents.every((event) =>
      event.objective === input.receiverObjective && receiverDigests.has(recoveryEventDigest(event))) &&
    receiverStart.repository.toLowerCase() === input.repository.toLowerCase() &&
    receiverStart.baseBranch === receiver.defaultBranch && receiverStart.baseSha &&
    receiverStart.objectiveAuthor.toLowerCase() === receiver.authorLogin!.toLowerCase() &&
    policyDigest(receiverStart.policy) === receiverStart.policyDigest);
  const beforeAt = Date.parse(input.beforeAt);
  requirePeer(Number.isFinite(beforeAt) && input.receiverEvents.some((event) =>
    event.runId === receiverStart.runId && event.at === input.beforeAt) && beforeAt >= time(receiverStart));
  if (receiverStart.recoveryPlanDigest) {
    // Do not recursively load this run's delivery proofs while proving one of them.
    await assertAdoption(receiverStart, receiverEvents, store);
  } else assertActivation(receiverStart, receiverEvents, input.repository);
  if (!receiverStart.recoveryPlanDigest) {
    const graph = await loadCompiledGraph(store, receiver.number, receiverStart.runId);
    requirePeer(graph);
    const compiled = one(receiverEvents.filter((event) => event.event === "GraphCompiled" && event.runId === receiverStart.runId));
    requirePeer(compiled.event === "GraphCompiled" && compiled.sequence > receiverStart.sequence &&
      compiled.baseSha === receiverStart.baseSha && compiled.graphRef === graph.ref &&
      compiled.graphBlobSha === graph.blobOid && compiled.graphDigest === graph.graphDigest &&
      compiled.graphSize === graph.graphSize && graph.objective.workItems.every((item) => item.baseSha === receiverStart.baseSha));
    const graphCommit = await store.readCommit(graph.commitOid);
    requirePeer(graphCommit.parentOids.length === 1 && graphCommit.parentOids[0] === receiverStart.baseSha);
    const projection = await loadCompiledGraphProjection(store, receiver.number, receiverStart.runId, graph);
    requirePeer(projection);
    assertAuthenticatedGraphProjection(receiverEvents, receiver.number, receiverStart.runId, projection);
    assertSnapshotMatchesCompiledGraph(graph.objective, { workItems: receiver.workItems.map((item) => {
      requirePeer(item.id && item.title && item.blockedBy);
      return { id: item.id, number: item.number, title: item.title,
        ...(item.body === undefined ? {} : { body: item.body }), blockedBy: item.blockedBy };
    }) }, projection.bindings);
  }
  const receiverReservations = input.receiverEvents.filter((event) => (event.event === "AttemptReserved" ||
    (receiverStart.recoveryPlanDigest && event.event === "CapacityReserved" && event.phase === "validation")) &&
    event.runId === receiverStart.runId);
  const receiverGenerations = new Set(input.receiverEvents.flatMap((event) =>
    event.kind === "controller" && event.runId === receiverStart.runId &&
    event.sequence > receiverStart.sequence && time(event) <= beforeAt &&
    receiverReservations.some((reservation) => event.sequence < reservation.sequence && time(event) <= time(reservation))
      ? [generation(event)] : []));
  requirePeer(receiverGenerations.size > 0);
  const numbers = await store.readCommitObjectiveCandidates(input.targetBaseSha);
  requirePeer(numbers.length <= 100 && new Set(numbers).size === numbers.length &&
    numbers.every((number) => Number.isSafeInteger(number) && number > 0));
  let result: { parent: string; requiresIsolation: boolean; executionRequiresIsolation: boolean } | undefined;
  for (const number of numbers.filter((number) => number !== receiver.number)) {
    const peer = await store.readObjectiveSnapshot(number);
    requirePeer(peer.number === number && peer.repositoryId === receiver.repositoryId &&
      peer.defaultBranch === receiver.defaultBranch);
    const events = snapshotEvents(peer);
    const integrations = events.filter((event) =>
      (event.event === "AttemptIntegrated" && event.headSha === input.targetBaseSha) ||
      (event.event === "RecoverySourceIntegrated" && event.mergeCommitSha === input.targetBaseSha));
    if (!integrations.length) continue;
    const integrated = one(integrations);
    const start = one(events.filter((event) => event.event === "FactoryRunStarted" && event.runId === integrated.runId));
    requirePeer(start.event === "FactoryRunStarted" && start.baseSha &&
      start.repository.toLowerCase() === input.repository.toLowerCase() &&
      start.actor.toLowerCase() === receiverStart.actor.toLowerCase() &&
      start.objectiveAuthor.toLowerCase() === peer.authorLogin!.toLowerCase() &&
      start.baseBranch === receiverStart.baseBranch && start.fork === receiverStart.fork &&
      integrated.sequence > start.sequence && time(integrated) >= time(start) && time(integrated) <= beforeAt);
    const policy = parseRunPolicy(start.policy);
    requirePeer(policyDigest(policy) === start.policyDigest);
    const end = events.filter((event) => event.runId === start.runId && terminal.has(event.event));
    requirePeer(end.length <= 1 && (!end.length || integrated.sequence < end[0]!.sequence));
    const runtime = start.recoveryPlanDigest ? await loadRecoveryRuntime({ objective: number,
      runId: start.runId, store, readSnapshot: async () => ({ snapshot: peer, historyComplete: true }) }) : undefined;
    if (runtime) requirePeer(runtime.status === "verified");
    else assertActivation(start, events, input.repository);
    const graph = runtime?.status === "verified" ? runtime.graph : await loadCompiledGraph(store, number, start.runId);
    requirePeer(graph);
    const projection = runtime?.status === "verified" ? runtime.projection :
      await loadCompiledGraphProjection(store, number, start.runId, graph);
    requirePeer(projection);
    if (!runtime) {
      const compiled = one(events.filter((event) => event.event === "GraphCompiled" && event.runId === start.runId));
      requirePeer(compiled.event === "GraphCompiled" && compiled.sequence > start.sequence &&
        compiled.sequence < integrated.sequence && compiled.baseSha === start.baseSha &&
        compiled.graphRef === graph.ref && compiled.graphBlobSha === graph.blobOid &&
        compiled.graphDigest === graph.graphDigest && compiled.graphSize === graph.graphSize &&
        graph.objective.workItems.every((item) => item.baseSha === start.baseSha));
      const graphCommit = await store.readCommit(graph.commitOid);
      requirePeer(graphCommit.parentOids.length === 1 && graphCommit.parentOids[0] === start.baseSha);
      assertAuthenticatedGraphProjection(events, number, start.runId, projection);
    }
    for (const item of graph.objective.workItems) {
      requirePeer(item.requirements);
      assertRequirementsWithinPolicy(item.requirements, policy, "peer Work Item");
    }
    const packets = assertSnapshotMatchesCompiledGraph(graph.objective, {
      workItems: peer.workItems.map((item) => {
        requirePeer(item.id && item.title && item.blockedBy);
        return { id: item.id, number: item.number, title: item.title,
          ...(item.body === undefined ? {} : { body: item.body }), blockedBy: item.blockedBy };
      }),
    }, projection.bindings);
    const packet = packets.get(integrated.workItem);
    const work = one(peer.workItems.filter((item) => item.number === integrated.workItem));
    requirePeer(packet && work.closed && work.linkedPullRequests);
    let executionRequiresIsolation = policy.trust === "sandbox_untrusted" || packet.requirements.trust !== "trusted_local";
    let requiresIsolation = executionRequiresIsolation;
    const merge = await store.readCommit(input.targetBaseSha);
    requirePeer(merge.oid === input.targetBaseSha && merge.parentOids.length === 1);
    if (integrated.event === "RecoverySourceIntegrated") {
      requirePeer(runtime?.status === "verified");
      requirePeer(events.some((event) => event.kind === "controller" && event.runId === start.runId &&
        event.sequence > start.sequence && event.sequence < integrated.sequence && time(event) <= time(integrated) &&
        receiverGenerations.has(generation(event))));
      const proof = one(runtime.sourceIntegrations.filter((proof) => recoveryEventDigest(proof.outcome) === recoveryEventDigest(integrated)));
      requirePeer(proof.targetBaseSha === merge.parentOids[0] && proof.outputTreeSha === merge.treeOid);
      const original = one(events.filter((event) => event.event === "FactoryRunStarted" && event.runId === integrated.sourceRunId));
      requirePeer(original.event === "FactoryRunStarted");
      executionRequiresIsolation ||= original.policy.trust === "sandbox_untrusted";
      requiresIsolation ||= executionRequiresIsolation || Boolean(proof.candidate?.isolatedResource);
    } else {
      requirePeer(integrated.event === "AttemptIntegrated" && integrated.policyDigest === start.policyDigest);
      const group = events.filter((event) => event.runId === start.runId && "workItem" in event &&
        event.workItem === integrated.workItem && "attempt" in event && event.attempt === integrated.attempt &&
        event.sequence < integrated.sequence);
      const reserved = one(group.filter((event) => event.event === "AttemptReserved"));
      requirePeer(reserved.event === "AttemptReserved" && reserved.policyDigest === start.policyDigest);
      requirePeer(events.filter((event) => event.runId === start.runId &&
        (event.event === "GraphCompiled" || event.event === "GraphProjected")).every((event) =>
        event.sequence < reserved.sequence && time(event) <= time(reserved)));
      requirePeer(group.every((event) => time(event) <= time(integrated) &&
        (!("policyDigest" in event) || event.policyDigest === reserved.policyDigest) &&
        (event.kind !== "attempt" || (event.backend === reserved.backend && event.baseSha === reserved.baseSha &&
          event.directorEpoch === reserved.directorEpoch))));
      const observations = events.filter((event) => event.kind === "controller" && event.runId === start.runId &&
        event.sequence > start.sequence && event.sequence < reserved.sequence && time(event) <= time(reserved));
      requirePeer(observations.some((event) => event.kind === "controller" && receiverGenerations.has(generation(event))));
      const ref = attemptRef(number, integrated.workItem, integrated.attempt);
      const oid = await store.readRef(ref);
      requirePeer(oid);
      const reservation = await store.readCommit(oid);
      const trailer = decodeEventTrailer(reservation.message);
      requirePeer(reservation.oid === oid && trailer && recoveryEventDigest(trailer) === recoveryEventDigest(reserved) &&
        reservation.parentOids.length === 1 && reservation.parentOids[0] === reserved.baseSha &&
        (await store.readCommit(reserved.baseSha)).treeOid === reservation.treeOid);
      const publication = selectEquivalentPublicationRecord(group.filter((event) => event.event === "PublicationRecorded"));
      requirePeer(publication);
      if (publication.mode === "regular-prs") requirePeer(!isManagedAgentBackendId(reserved.backend) &&
        publication.branch === publicationBranch(number, integrated.workItem, integrated.attempt));
      const selections = events.filter((event) => event.event === "DeliverySelected" && event.runId === start.runId);
      requirePeer(selections.length === 1 && selections[0]?.event === "DeliverySelected" &&
        selections[0].sequence > start.sequence && selections[0].sequence < reserved.sequence &&
        selections[0].requested === (policy.delivery?.mode ?? "regular-prs") &&
        selections[0].selected === publication.mode);
      const validation = one(group.filter((event) => event.event === "ValidationRecorded" && event.passed &&
        event.evidenceDigest === publication.validationDigest));
      const published = one(group.filter((event) => event.event === "AttemptPublished" && event.headSha === publication.headSha));
      requirePeer(validation.event === "ValidationRecorded" && published.event === "AttemptPublished" && published.artifactDigest);
      const accepted = one(group.filter((event) => event.event === "AttemptValidated" && event.artifactDigest === published.artifactDigest));
      requirePeer(accepted.sequence > validation.sequence && accepted.sequence < published.sequence &&
        published.sequence < publication.sequence && publication.itemId ===
          one(projection.bindings.filter((binding) => binding.issueNumber === integrated.workItem)).compilerId &&
        publication.baseSha === validation.baseSha && publication.baseBranch === receiver.defaultBranch);
      const reviewKind = validation.baseSha === reserved.baseSha ? "artifact" : "rebase";
      const review = await loadReviewCheckpoint(store, { kind: reviewKind, runId: start.runId,
        objective: number, workItem: integrated.workItem, attempt: integrated.attempt,
        artifactDigest: published.artifactDigest, baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha, evidenceDigest: validation.evidenceDigest,
        ...(reviewKind === "rebase" ? { headSha: publication.headSha } : {}) });
      requirePeer(review?.review.accepted && !review.review.unmetCriteria.length);
      const usage = group.filter((event) => event.kind === "budget" && event.event === "BudgetReconciled" &&
        event.phase === "management" && event.unit === "model_tokens" &&
        event.usageId === `${reviewKind === "artifact" ? "review" : "rebase-review"}-${review.identityDigest}`);
      requirePeer(usage.length > 0 && usage.every((event) => event.kind === "budget" &&
        event.amount === review.usage.inputTokens + review.usage.outputTokens && event.sequence < accepted.sequence));
      const head = await store.readCommit(publication.headSha);
      requirePeer(head.oid === publication.headSha && head.parentOids.length === 1 &&
        head.parentOids[0] === validation.baseSha && head.treeOid === validation.outputTreeSha);
      if (!isManagedAgentBackendId(reserved.backend)) requirePeer(
        head.message.split(/\r?\n/).includes(`Factory-Artifact: ${published.artifactDigest}`) &&
        head.message.split(/\r?\n/).includes(`Factory-Validation: ${validation.evidenceDigest}`));
      const exact = bindValidationToPublishedHead({ validation: { passed: true, digest: validation.evidenceDigest,
        baseSha: validation.baseSha, outputTreeSha: validation.outputTreeSha }, publishedBaseSha: publication.baseSha,
        publishedHeadSha: publication.headSha, publishedTreeSha: head.treeOid });
      requirePeer(exact.digest === publication.exactHeadValidationDigest);
      const pull = await store.readPullRequest(publication.pullRequest);
      const linked = one(work.linkedPullRequests.filter((pull) => pull.number === publication.pullRequest));
      requirePeer(pull.merged && pull.mergeCommitSha === input.targetBaseSha && pull.nodeId === linked.id &&
        pull.number === publication.pullRequest && linked.state === "MERGED" && linked.headSha === pull.headSha &&
        pull.headRef === publication.branch && pull.baseRef === publication.baseBranch &&
        pull.headRepository?.toLowerCase() === input.repository.toLowerCase() &&
        pull.baseRepository?.toLowerCase() === input.repository.toLowerCase());
      executionRequiresIsolation ||= isManagedAgentBackendId(reserved.backend);
      requiresIsolation ||= !localBackends.has(reserved.backend);
      if (pull.headSha !== publication.headSha) {
        const prior = await observeRecoverySiblingRefresh({ repository: input.repository, objective: number,
          workItem: integrated.workItem, events, controllingRunIds: runtime?.status === "verified" ? runtime.accountingRunIds : [start.runId],
          store, deliveryHeadSha: pull.headSha, requireCompletion: true, beforeSequence: integrated.sequence,
          source: { runId: start.runId, attempt: integrated.attempt, reservationRef: ref, reservationCommitOid: oid,
            reservationReceiptDigest: recoveryEventDigest(reserved), artifactDigest: published.artifactDigest, review: null,
            validation: { receiptDigest: recoveryEventDigest(validation), evidenceDigest: validation.evidenceDigest,
              baseSha: validation.baseSha, outputTreeSha: validation.outputTreeSha },
            publication: { receiptDigest: recoveryEventDigest(publication), mode: publication.mode, pullRequest: publication.pullRequest,
              pullRequestNodeId: pull.nodeId!, branch: publication.branch, baseBranch: publication.baseBranch,
              baseSha: publication.baseSha, headSha: publication.headSha, baseRepository: input.repository,
              headRepository: input.repository, stackNumber: publication.stackNumber ?? null } } }, visiting);
        requirePeer(prior.record.identity.targetBaseSha === merge.parentOids[0] && prior.record.outputTreeSha === merge.treeOid);
        requiresIsolation ||= prior.requiresIsolation;
        executionRequiresIsolation ||= prior.executionRequiresIsolation;
      } else if (merge.parentOids[0] === validation.baseSha) requirePeer(merge.treeOid === validation.outputTreeSha);
      else {
        const identity = { runId: start.runId, objective: number, workItem: integrated.workItem,
          attempt: integrated.attempt, pullRequest: publication.pullRequest, sourceHeadSha: publication.headSha,
          sourceExactHeadValidationDigest: exact.digest, targetBaseSha: merge.parentOids[0]! };
        const candidate = await loadMergeCandidateCheckpoint(store, identity);
        requirePeer(candidate && candidate.validation.outputTreeSha === merge.treeOid &&
          JSON.stringify(candidate.source) === JSON.stringify(exact));
        assertIsolatedCandidateProof({ repository: input.repository, sourceRunId: start.runId,
          candidate, events, beforeSequence: integrated.sequence });
        requirePeer(!requiresIsolation || candidate.isolatedResource);
        const acceptedCandidate = await loadReviewCheckpoint(store, { kind: "integration-candidate", runId: start.runId,
          objective: number, workItem: integrated.workItem, attempt: integrated.attempt, headSha: publication.headSha,
          artifactDigest: candidate.validation.artifactDigest, baseSha: candidate.validation.baseSha,
          outputTreeSha: candidate.validation.outputTreeSha, evidenceDigest: candidate.validation.digest });
        requirePeer(acceptedCandidate?.review.accepted && !acceptedCandidate.review.unmetCriteria.length);
        for (const [phase, unit, usageId, amount] of [
          ["validation", "validation_milliseconds", `integration-validation-${mergeCandidateIdentityDigest(identity)}`,
            Date.parse(candidate.validation.completedAt) - Date.parse(candidate.validation.startedAt)],
          ["management", "model_tokens", `integration-review-${acceptedCandidate.identityDigest}`,
            acceptedCandidate.usage.inputTokens + acceptedCandidate.usage.outputTokens],
        ] as const) {
          const amounts = group.filter((event) => event.kind === "budget" && event.event === "BudgetReconciled" &&
            event.phase === phase && event.unit === unit && event.usageId === usageId);
          requirePeer(amounts.length > 0 && amounts.every((event) => event.kind === "budget" && event.amount === amount));
        }
      }
    }
    // More than one exact owner is conflicting proof, not an opportunity to select a convenient peer.
    requirePeer(!result);
    result = { parent: merge.parentOids[0]!, requiresIsolation, executionRequiresIsolation };
  }
  requirePeer(result);
  return result;
}
