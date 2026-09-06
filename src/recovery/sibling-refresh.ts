import { loadCompiledGraph } from "../control/graphs.js";
import {
  loadMergeCandidateCheckpoint,
  mergeCandidateIdentityDigest,
} from "../control/merge-candidates.js";
import { loadReviewCheckpoint } from "../control/reviews.js";
import {
  loadSiblingRefresh,
  loadSiblingRefreshLineage,
  type SiblingRefreshRecord,
} from "../control/sibling-refreshes.js";
import type { FactoryEvent } from "../protocol/events.js";
import { isManagedAgentBackendId } from "../protocol/policy.js";
import { planDelivery } from "../publication/delivery.js";
import { publicationBranch } from "../publication/publisher.js";
import { selectEquivalentPublicationRecord } from "../publication/recorded-publication.js";
import { bindValidationToPublishedHead } from "../validation/plan.js";
import type { RecoveryReadStore } from "./assessment.js";
import { loadRecoveryClaim } from "./claims.js";
import { createRecoveryEventDigest } from "./identity.js";
import { loadRecoveryPlan, type RecoveryPlanItem } from "./plan.js";
import { recoveryAdoptionEvents } from "./transaction.js";
import { verifyRecoverySourceIntegration } from "./outcomes.js";
import { assertIsolatedCandidateProof } from "./isolated-candidate.js";

type Source = NonNullable<RecoveryPlanItem["source"]>;
function requireRefresh(value: unknown): asserts value {
  if (!value) throw new Error("sibling refresh recovery binding unavailable");
}

/** Read-only proof. An immutable refresh intent never grants source-use or spending authority. */
export async function observeRecoverySiblingRefresh(
  input: {
    repository: string;
    objective: number;
    workItem: number;
    source: Source;
    events: readonly FactoryEvent[];
    /** Only the already authenticated accepted recovery chain, including its current run. */
    controllingRunIds: readonly string[];
    store: RecoveryReadStore;
    deliveryHeadSha: string;
    targetBaseSha?: string;
    candidateRunId?: string;
    candidateIdentityDigest?: string;
    requireCompletion?: boolean;
    beforeSequence?: number;
  },
  visiting = new Set<string>(),
) {
  const recoveryEventDigest = createRecoveryEventDigest();
  const { source, events } = input;
  let reads = 0;
  const store = new Proxy({} as RecoveryReadStore, {
    get(_target, property) {
      const operation = Reflect.get(input.store, property, input.store);
      if (typeof operation !== "function") return operation;
      return (...args: unknown[]) => {
        requireRefresh(++reads <= 1024);
        return Reflect.apply(operation, input.store, args);
      };
    },
  });
  const publication = source.publication;
  requireRefresh(publication && source.validation && input.controllingRunIds.length <= 100);
  requireRefresh(!visiting.has(input.deliveryHeadSha) && visiting.size < 100);
  visiting = new Set(visiting).add(input.deliveryHeadSha);
  requireRefresh(publication.stackNumber === null);
  const reserved = events.find(
    (event) => recoveryEventDigest(event) === source.reservationReceiptDigest,
  );
  requireRefresh(
    reserved?.event === "AttemptReserved" &&
      reserved.runId === source.runId &&
      reserved.objective === input.objective &&
      reserved.workItem === input.workItem &&
      reserved.attempt === source.attempt &&
      !isManagedAgentBackendId(reserved.backend),
  );
  if (publication.mode === "regular-prs")
    requireRefresh(
      publication.branch === publicationBranch(input.objective, input.workItem, source.attempt),
    );
  const publicationEvent = events.find(
    (event) => recoveryEventDigest(event) === publication.receiptDigest,
  );
  requireRefresh(
    publicationEvent &&
      ((publicationEvent.event === "PublicationRecorded" &&
        publicationEvent.runId === source.runId &&
        publicationEvent.workItem === input.workItem &&
        publicationEvent.attempt === source.attempt &&
        publicationEvent.headSha === publication.headSha &&
        publicationEvent.pullRequest === publication.pullRequest) ||
        (publicationEvent.event === "RecoverySourcePublished" &&
          publicationEvent.sourceRunId === source.runId &&
          publicationEvent.workItem === input.workItem &&
          publicationEvent.sourceAttempt === source.attempt &&
          publicationEvent.sourceHeadSha === publication.headSha &&
          publicationEvent.pullRequest === publication.pullRequest)),
  );
  const equivalentPublications =
    publicationEvent.event === "PublicationRecorded"
      ? events.filter(
          (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
            event.kind === "publication" &&
            event.event === "PublicationRecorded" &&
            event.runId === source.runId &&
            event.objective === input.objective &&
            event.workItem === input.workItem &&
            event.attempt === source.attempt,
        )
      : [];
  if (publicationEvent.event === "PublicationRecorded")
    selectEquivalentPublicationRecord(equivalentPublications, publicationEvent);
  requireRefresh(
    publicationEvent.mode === publication.mode &&
      publicationEvent.branch === publication.branch &&
      publicationEvent.baseBranch === publication.baseBranch,
  );
  if (publication.mode === "regular-prs")
    requireRefresh(
      publicationEvent.position === 0 &&
        !publicationEvent.parentItemId &&
        !publicationEvent.stackNumber &&
        !events.some(
          (event) =>
            event.event === "StackLinked" &&
            event.runId === source.runId &&
            event.workItem === input.workItem &&
            event.attempt === source.attempt,
        ),
    );
  const publicationDigests = new Set(
    equivalentPublications.length
      ? equivalentPublications.map(recoveryEventDigest)
      : [publication.receiptDigest],
  );
  const original = await store.readCommit(publication.headSha);
  const exact = bindValidationToPublishedHead({
    validation: {
      passed: true,
      digest: source.validation.evidenceDigest,
      baseSha: source.validation.baseSha,
      outputTreeSha: source.validation.outputTreeSha,
    },
    publishedBaseSha: publication.baseSha,
    publishedHeadSha: publication.headSha,
    publishedTreeSha: original.treeOid,
  });
  const starts = events.filter(
    (event): event is Extract<FactoryEvent, { event: "FactoryRunStarted" }> =>
      event.event === "FactoryRunStarted" && input.controllingRunIds.includes(event.runId),
  );
  requireRefresh(
    starts.length <= 100 && new Set(starts.map((event) => event.runId)).size === starts.length,
  );
  const sourceStart = starts.find((event) => event.runId === source.runId);
  requireRefresh(sourceStart);
  let graphRun = source.runId;
  if (sourceStart.recoveryPlanDigest) {
    const adopted = await loadRecoveryPlan(store, input.objective, sourceStart.recoveryPlanDigest);
    requireRefresh(adopted && adopted.plan.successorRunId === source.runId);
    graphRun = adopted.plan.graph.sourceRunId;
  }
  const graph = await loadCompiledGraph(store, input.objective, graphRun);
  requireRefresh(
    graph &&
      events.some(
        (event) =>
          event.event === "GraphCompiled" &&
          event.runId === graphRun &&
          event.graphDigest === graph.graphDigest &&
          event.graphRef === graph.ref &&
          event.graphBlobSha === graph.blobOid,
      ),
  );
  const topology =
    publication.mode === "native-stacks"
      ? planDelivery(
          graph.objective.workItems.map((item) => {
            requireRefresh(item.delivery);
            return {
              id: item.id,
              dependsOn: item.dependsOn,
              delivery: {
                group: item.delivery.group,
                relationship: item.delivery.relationship,
                ...(item.delivery.parentWorkItem
                  ? { parentWorkItem: item.delivery.parentWorkItem }
                  : {}),
              },
            };
          }),
        )
      : null;
  const itemId =
    publicationEvent.event === "PublicationRecorded" ||
    publicationEvent.event === "RecoverySourcePublished"
      ? publicationEvent.itemId
      : undefined;
  requireRefresh(
    graph.objective.workItems.some((item) => item.id === itemId) &&
      (publication.mode === "regular-prs" ||
        (topology?.result === "supported" &&
          topology.units.some(
            (unit) =>
              unit.kind === "sibling" && unit.items.length === 1 && unit.items[0] === itemId,
          ))),
  );
  const delivery = await store.readCommit(input.deliveryHeadSha);
  requireRefresh(delivery.oid === input.deliveryHeadSha && delivery.parentOids.length === 2);
  let targetBaseSha = delivery.parentOids[1]!;
  const matches: SiblingRefreshRecord[] = [];
  for (const start of starts) {
    for (const sourcePublicationDigest of publicationDigests) {
      const record = await loadSiblingRefresh(store, {
        repository: input.repository,
        runId: start.runId,
        sourceRunId: source.runId,
        controllingPolicyDigest: start.policyDigest,
        objective: input.objective,
        workItem: input.workItem,
        attempt: source.attempt,
        pullRequest: publication.pullRequest,
        pullRequestNodeId: publication.pullRequestNodeId,
        branch: publication.branch,
        reservationRef: source.reservationRef,
        reservationOid: source.reservationCommitOid,
        leaseEpoch: reserved.directorEpoch!,
        policyDigest: reserved.policyDigest,
        sourcePublicationDigest,
        sourceHeadSha: publication.headSha,
        sourceExactHeadValidationDigest: exact.digest,
        targetBaseSha,
      });
      if (record && record.plannedHeadSha === input.deliveryHeadSha) matches.push(record);
    }
  }
  requireRefresh(matches.length === 1);
  let record = matches[0]!;
  const lineage = await loadSiblingRefreshLineage(store, record);
  const authenticateController = async (runId: string, controllingPolicyDigest: string) => {
    const start = starts.find((event) => event.runId === runId);
    requireRefresh(
      start &&
        start.repository.toLowerCase() === input.repository.toLowerCase() &&
        start.objective === input.objective &&
        (publication.mode === "native-stacks"
          ? start.policy.delivery?.mode === "stacked-prs"
          : !start.policy.delivery ||
            start.policy.delivery.mode === "regular-prs" ||
            start.policy.delivery.onUnavailable === "regular-prs") &&
        start.policyDigest === controllingPolicyDigest,
    );
    if (publication.mode === "regular-prs") {
      const selections = events.filter(
        (event) =>
          event.event === "DeliverySelected" &&
          event.runId === start.runId &&
          event.objective === input.objective,
      );
      requireRefresh(
        selections.length > 0 &&
          selections.every(
            (event) =>
              event.event === "DeliverySelected" &&
              event.selected === "regular-prs" &&
              event.requested === (start.policy.delivery?.mode ?? "regular-prs") &&
              // DeliverySelected has no policyDigest field. Its authenticated
              // run and post-start position bind it to the unique accepted
              // start whose policy digest was checked against the intent above.
              event.sequence > start.sequence,
          ),
      );
    }
    if (start.runId !== source.runId) {
      requireRefresh(start.recoveryPlanDigest);
      const adopted = await loadRecoveryPlan(store, input.objective, start.recoveryPlanDigest);
      requireRefresh(
        adopted &&
          adopted.plan.successorRunId === start.runId &&
          adopted.plan.policyDigest === start.policyDigest,
      );
      const item = adopted.plan.items.find((item) => item.workItem === input.workItem);
      requireRefresh(
        item?.source &&
          item.action !== "execute" &&
          item.action !== "integrated" &&
          item.source.runId === source.runId &&
          item.source.attempt === source.attempt &&
          item.source.reservationCommitOid === source.reservationCommitOid &&
          item.source.reservationReceiptDigest === source.reservationReceiptDigest,
      );
      requireRefresh(
        item.source.publication
          ? item.source.publication.receiptDigest === publication.receiptDigest
          : publicationEvent.event === "RecoverySourcePublished" &&
              publicationEvent.runId === start.runId &&
              publicationEvent.planDigest === adopted.digest,
      );
      const claim = await loadRecoveryClaim(store, input.objective, adopted.plan.predecessor.runId);
      const request = events.find(
        (event) =>
          event.event === "RecoveryRequested" && event.requestId === adopted.plan.requestId,
      );
      const predecessor = starts.find((event) => event.runId === adopted.plan.predecessor.runId);
      requireRefresh(claim && request?.event === "RecoveryRequested" && predecessor);
      const expected = recoveryAdoptionEvents({
        planRecord: adopted,
        claim,
        authenticatedRequest: request,
        predecessorStart: predecessor,
      });
      requireRefresh(
        expected.every((expected) => {
          const expectedDigest = recoveryEventDigest(expected);
          return events.some((event) => recoveryEventDigest(event) === expectedDigest);
        }),
      );
    }
    return start;
  };
  for (const refresh of lineage) {
    const identity = refresh.identity;
    const start = await authenticateController(identity.runId, identity.controllingPolicyDigest);
    requireRefresh(
      identity.sourceRunId === source.runId &&
        publicationDigests.has(identity.sourcePublicationDigest) &&
        identity.reservationRef === source.reservationRef &&
        identity.reservationOid === source.reservationCommitOid &&
        identity.sourceExactHeadValidationDigest === exact.digest,
    );
    // Every target advance must already be this controller's authenticated integration.
    // An intent, clean applicability, or an arbitrary parent commit cannot authorize trunk.
    let cursor = identity.targetBaseSha;
    let controllerBase = start.baseSha;
    if (!controllerBase) {
      // Foreground runs have no activation base. Recover only the base committed
      // by their authenticated original compilation, never today's mutable trunk.
      requireRefresh(
        !start.activationRequestId && !start.recoveryRequestId && !start.recoveryPlanDigest,
      );
      const compiled = events.filter(
        (event) =>
          event.event === "GraphCompiled" &&
          event.runId === start.runId &&
          event.objective === input.objective,
      );
      const receipt = compiled[0];
      const originalGraph =
        start.runId === graphRun
          ? graph
          : await loadCompiledGraph(store, input.objective, start.runId);
      requireRefresh(
        compiled.length === 1 &&
          receipt?.event === "GraphCompiled" &&
          receipt.sequence > start.sequence &&
          originalGraph &&
          receipt.graphRef === originalGraph.ref &&
          receipt.graphBlobSha === originalGraph.blobOid &&
          receipt.graphDigest === originalGraph.graphDigest &&
          receipt.graphSize === originalGraph.graphSize &&
          originalGraph.objective.workItems.every((item) => item.baseSha === receipt.baseSha),
      );
      const graphCommit = await store.readCommit(originalGraph.commitOid);
      requireRefresh(
        graphCommit.oid === originalGraph.commitOid &&
          graphCommit.parentOids.length === 1 &&
          graphCommit.parentOids[0] === receipt.baseSha,
      );
      controllerBase = receipt.baseSha;
    }
    const seen = new Set<string>();
    while (cursor !== controllerBase) {
      requireRefresh(!seen.has(cursor) && seen.size < 100);
      seen.add(cursor);
      const integrations = events.filter(
        (event) =>
          event.runId === start.runId &&
          ((event.event === "AttemptIntegrated" && event.headSha === cursor) ||
            (event.event === "RecoverySourceIntegrated" && event.mergeCommitSha === cursor)),
      );
      requireRefresh(integrations.length === 1);
      const integrated = integrations[0]!;
      const terminal = events.find(
        (event) =>
          event.runId === start.runId &&
          ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
            event.event,
          ),
      );
      requireRefresh(
        integrated.sequence > start.sequence &&
          (!terminal || integrated.sequence < terminal.sequence),
      );
      const merge = await store.readCommit(cursor);
      requireRefresh(merge.oid === cursor && merge.parentOids.length === 1);
      if (integrated.event === "RecoverySourceIntegrated") {
        const planRecord = await loadRecoveryPlan(store, input.objective, integrated.planDigest);
        requireRefresh(planRecord && planRecord.plan.successorRunId === start.runId);
        const claim = await loadRecoveryClaim(
          store,
          input.objective,
          planRecord.plan.predecessor.runId,
        );
        requireRefresh(claim);
        const proof = await verifyRecoverySourceIntegration({
          planRecord,
          claim,
          events,
          store,
          outcome: integrated,
          proofTraversal: visiting,
        });
        requireRefresh(proof.status === "verified" && proof.outputTreeSha === merge.treeOid);
      } else {
        requireRefresh(
          integrated.event === "AttemptIntegrated" &&
            integrated.policyDigest === start.policyDigest,
        );
        const group = events.filter(
          (event) =>
            event.runId === start.runId &&
            "workItem" in event &&
            event.workItem === integrated.workItem &&
            "attempt" in event &&
            event.attempt === integrated.attempt &&
            event.sequence < integrated.sequence,
        );
        const publication = group.filter((event) => event.event === "PublicationRecorded").at(-1);
        const validation = group
          .filter((event) => event.event === "ValidationRecorded" && event.passed)
          .at(-1);
        const reservation = group.filter((event) => event.event === "AttemptReserved");
        requireRefresh(
          publication?.event === "PublicationRecorded" &&
            validation?.event === "ValidationRecorded" &&
            reservation.length === 1 &&
            reservation[0]?.event === "AttemptReserved",
        );
        const pull = await store.readPullRequest(publication.pullRequest);
        selectEquivalentPublicationRecord(
          group.filter(
            (event): event is Extract<FactoryEvent, { kind: "publication" }> =>
              event.kind === "publication" &&
              event.event === "PublicationRecorded" &&
              event.headSha === publication.headSha,
          ),
          publication,
        );
        requireRefresh(
          pull.merged &&
            pull.mergeCommitSha === cursor &&
            pull.number === publication.pullRequest &&
            pull.headRef === publication.branch &&
            pull.baseRef === publication.baseBranch &&
            pull.baseRepository?.toLowerCase() === input.repository.toLowerCase() &&
            pull.headRepository?.toLowerCase() === input.repository.toLowerCase(),
        );
        if (pull.headSha === publication.headSha) {
          const head = await store.readCommit(publication.headSha);
          const original = bindValidationToPublishedHead({
            validation: {
              passed: true,
              digest: validation.evidenceDigest,
              baseSha: validation.baseSha,
              outputTreeSha: validation.outputTreeSha,
            },
            publishedBaseSha: publication.baseSha,
            publishedHeadSha: publication.headSha,
            publishedTreeSha: head.treeOid,
          });
          requireRefresh(
            head.parentOids.length === 1 &&
              head.parentOids[0] === validation.baseSha &&
              original.digest === publication.exactHeadValidationDigest,
          );
          if (merge.parentOids[0] === validation.baseSha)
            requireRefresh(merge.treeOid === validation.outputTreeSha);
          else {
            // Older immutable-head candidates remain valid evidence; do not reinterpret
            // them as refresh intents or require a retrospective branch mutation.
            const identity = {
              runId: start.runId,
              objective: input.objective,
              workItem: integrated.workItem,
              attempt: integrated.attempt,
              pullRequest: publication.pullRequest,
              sourceHeadSha: publication.headSha,
              sourceExactHeadValidationDigest: original.digest,
              targetBaseSha: merge.parentOids[0]!,
            };
            const candidate = await loadMergeCandidateCheckpoint(store, identity);
            requireRefresh(
              candidate &&
                candidate.validation.outputTreeSha === merge.treeOid &&
                JSON.stringify(candidate.source) === JSON.stringify(original),
            );
            assertIsolatedCandidateProof({
              repository: input.repository,
              sourceRunId: start.runId,
              candidate,
              events,
              beforeSequence: integrated.sequence,
            });
            const review = await loadReviewCheckpoint(store, {
              kind: "integration-candidate",
              runId: start.runId,
              objective: input.objective,
              workItem: integrated.workItem,
              attempt: integrated.attempt,
              headSha: publication.headSha,
              artifactDigest: candidate.validation.artifactDigest,
              baseSha: candidate.validation.baseSha,
              outputTreeSha: candidate.validation.outputTreeSha,
              evidenceDigest: candidate.validation.digest,
            });
            requireRefresh(review?.review.accepted && review.review.unmetCriteria.length === 0);
            const usage = group.filter((event) => event.event === "BudgetReconciled");
            const validationUsage = usage.filter(
              (event) =>
                event.kind === "budget" &&
                event.phase === "validation" &&
                event.unit === "validation_milliseconds" &&
                event.usageId ===
                  `integration-validation-${mergeCandidateIdentityDigest(identity)}`,
            );
            const reviewUsage = usage.filter(
              (event) =>
                event.kind === "budget" &&
                event.phase === "management" &&
                event.unit === "model_tokens" &&
                event.usageId === `integration-review-${review.identityDigest}`,
            );
            requireRefresh(
              validationUsage.length > 0 &&
                validationUsage.every(
                  (event) =>
                    event.kind === "budget" &&
                    event.amount ===
                      Date.parse(candidate.validation.completedAt) -
                        Date.parse(candidate.validation.startedAt),
                ),
            );
            requireRefresh(
              reviewUsage.length > 0 &&
                reviewUsage.every(
                  (event) =>
                    event.kind === "budget" &&
                    event.amount === review.usage.inputTokens + review.usage.outputTokens,
                ),
            );
          }
        } else {
          const ref = `refs/clockgrove-factory/attempts/objective-${input.objective}/work-item-${integrated.workItem}/attempt-${integrated.attempt}`;
          const oid = await store.readRef(ref);
          requireRefresh(oid && pull.nodeId);
          const prior = await observeRecoverySiblingRefresh(
            {
              repository: input.repository,
              objective: input.objective,
              events,
              controllingRunIds: input.controllingRunIds,
              store,
              workItem: integrated.workItem,
              deliveryHeadSha: pull.headSha,
              requireCompletion: true,
              beforeSequence: integrated.sequence,
              source: {
                runId: start.runId,
                attempt: integrated.attempt,
                reservationRef: ref,
                reservationCommitOid: oid,
                reservationReceiptDigest: recoveryEventDigest(reservation[0]!),
                artifactDigest: null,
                review: null,
                validation: {
                  receiptDigest: recoveryEventDigest(validation),
                  evidenceDigest: validation.evidenceDigest,
                  baseSha: validation.baseSha,
                  outputTreeSha: validation.outputTreeSha,
                },
                publication: {
                  receiptDigest: recoveryEventDigest(publication),
                  mode: publication.mode,
                  pullRequest: publication.pullRequest,
                  pullRequestNodeId: pull.nodeId,
                  branch: publication.branch,
                  baseBranch: publication.baseBranch,
                  baseSha: publication.baseSha,
                  headSha: publication.headSha,
                  baseRepository: input.repository,
                  headRepository: input.repository,
                  stackNumber: publication.stackNumber ?? null,
                },
              },
            },
            visiting,
          );
          requireRefresh(
            prior.record.outputTreeSha === merge.treeOid &&
              prior.record.identity.targetBaseSha === merge.parentOids[0],
          );
        }
      }
      cursor = merge.parentOids[0]!;
    }
  }
  const identityFor = (entry: SiblingRefreshRecord, runId: string) => ({
    runId,
    objective: input.objective,
    workItem: input.workItem,
    attempt: source.attempt,
    pullRequest: publication.pullRequest,
    sourceHeadSha: publication.headSha,
    sourceExactHeadValidationDigest: exact.digest,
    targetBaseSha: entry.identity.targetBaseSha,
    deliveryHeadSha: entry.plannedHeadSha,
  });
  if (input.targetBaseSha || input.candidateIdentityDigest) {
    const selected = lineage.filter(
      (entry) =>
        (!input.targetBaseSha || entry.identity.targetBaseSha === input.targetBaseSha) &&
        (!input.candidateIdentityDigest ||
          mergeCandidateIdentityDigest(
            identityFor(entry, input.candidateRunId ?? entry.identity.runId),
          ) === input.candidateIdentityDigest),
    );
    requireRefresh(selected.length === 1);
    record = selected[0]!;
    targetBaseSha = record.identity.targetBaseSha;
  }
  let candidateRunId = input.candidateRunId ?? record.identity.runId;
  if (candidateRunId !== record.identity.runId) {
    const controller = starts.find((event) => event.runId === candidateRunId);
    requireRefresh(controller);
    await authenticateController(candidateRunId, controller.policyDigest);
  }
  let candidateIdentity = identityFor(record, candidateRunId);
  let candidate = await loadMergeCandidateCheckpoint(store, candidateIdentity);
  if (!input.candidateRunId) {
    for (const start of starts) {
      if (start.runId === candidateIdentity.runId || start.runId === record.identity.runId)
        continue;
      const otherIdentity = identityFor(record, start.runId);
      const other = await loadMergeCandidateCheckpoint(store, otherIdentity);
      if (!other) continue;
      await authenticateController(start.runId, start.policyDigest);
      requireRefresh(!candidate);
      candidate = other;
      candidateIdentity = otherIdentity;
      candidateRunId = start.runId;
    }
  }
  if (candidate)
    requireRefresh(
      candidate.validation.outputTreeSha === record.outputTreeSha &&
        JSON.stringify(candidate.source) === JSON.stringify(exact),
    );
  if (candidate)
    assertIsolatedCandidateProof({
      repository: input.repository,
      sourceRunId: source.runId,
      candidate,
      events,
      requireAccounting: input.requireCompletion === true,
      ...(input.beforeSequence === undefined ? {} : { beforeSequence: input.beforeSequence }),
    });
  const review = candidate
    ? await loadReviewCheckpoint(store, {
        kind: "integration-candidate",
        runId: candidateRunId,
        objective: input.objective,
        workItem: input.workItem,
        attempt: source.attempt,
        headSha: record.plannedHeadSha,
        artifactDigest: candidate.validation.artifactDigest,
        baseSha: targetBaseSha,
        outputTreeSha: candidate.validation.outputTreeSha,
        evidenceDigest: candidate.validation.digest,
      })
    : null;
  if (input.requireCompletion) {
    requireRefresh(
      candidate && review?.review.accepted && review.review.unmetCriteria.length === 0,
    );
    const terminal = events.find(
      (event) =>
        event.runId === candidateRunId &&
        ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event),
    );
    const usage = events
      .filter(
        (event) =>
          event.event === "BudgetReconciled" &&
          event.runId === candidateRunId &&
          event.workItem === input.workItem &&
          (event.attempt === undefined || event.attempt === source.attempt) &&
          (!terminal || event.sequence < terminal.sequence),
      )
      .filter(
        (event) => input.beforeSequence === undefined || event.sequence < input.beforeSequence,
      );
    const validationUsage = usage.filter(
      (event) =>
        event.kind === "budget" &&
        event.unit === "validation_milliseconds" &&
        event.phase === "validation" &&
        event.usageId ===
          `integration-validation-${mergeCandidateIdentityDigest(candidateIdentity)}`,
    );
    requireRefresh(
      validationUsage.length > 0 &&
        validationUsage.every(
          (event) =>
            event.kind === "budget" &&
            event.amount ===
              Date.parse(candidate.validation.completedAt) -
                Date.parse(candidate.validation.startedAt),
        ),
    );
    const reviewUsage = usage.filter(
      (event) =>
        event.kind === "budget" &&
        event.unit === "model_tokens" &&
        event.phase === "management" &&
        event.usageId === `integration-review-${review.identityDigest}`,
    );
    requireRefresh(
      reviewUsage.length > 0 &&
        reviewUsage.every(
          (event) =>
            event.kind === "budget" &&
            event.amount === review.usage.inputTokens + review.usage.outputTokens,
        ),
    );
  }
  return { record, lineage, source: exact, candidateIdentity, candidate, review };
}

export function recoverySiblingRefreshBinding(
  record: SiblingRefreshRecord,
  candidateRunId = record.identity.runId,
) {
  return {
    ref: record.ref,
    commitOid: record.commitOid,
    identityDigest: record.identityDigest,
    deliveryHeadSha: record.plannedHeadSha,
    targetBaseSha: record.identity.targetBaseSha,
    outputTreeSha: record.outputTreeSha,
    candidateRunId,
  };
}
